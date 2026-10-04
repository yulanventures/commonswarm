import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { test } from "node:test";
import { hashOpaque, SESSION_COOKIE } from "../src/browser-security.js";
import { createGoTrueClient } from "../src/gotrue.js";
import { InteractionStore } from "../src/interaction-store.js";
import { createInteractionHandler } from "../src/interactions.js";
import { createAdminInteractionHandler, createResourceInteractionHandler } from "../src/admin-interactions.js";
import { createHandler } from "../src/server.js";
import { createLogger } from "../src/logger.js";

const ISSUER = "https://mcp.commonswarm.com";
const SESSION = "synthetic-browser-session-long-enough";
const UID = "pending-approval";
const USER = "10000000-0000-4000-8000-000000000001";
const ADMIN = "https://api.commonswarm.com/admin";

// Stateful SQL fixture for the real InteractionStore, including its one-use state
// check. SQL execution/locking remains covered by the PostgreSQL gate in CI.
async function harness(t, { providers, legacy, resource, sendStatus = 200 } = {}) {
  const sessions = new Map([[hashOpaque(SESSION).toString("hex"), { user_id: null, authenticated_at: null }]]);
  let row, finished, adminViews = 0;
  const result = value => ({ rowCount: value ? 1 : 0, rows: value ? [value] : [] });
  const key = value => value.toString("hex");
  const pool = {
    async connect() { return { query: this.query.bind(this), release() {} }; },
    async query(sql, p = []) {
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return result({});
      if (sql.includes("SELECT session_hash")) return result(sessions.get(key(p[0])));
      if (sql.includes("INSERT INTO commonswarm_oauth.interactions")) {
        if (row) return result(row.session_hash.equals(p[1]) && row.client_id === p[2] &&
          row.redirect_uri === p[3] && row.resource === p[4] && row.pkce_challenge === p[6] &&
          row.oauth_state === p[7] ? row : null);
        row = { interaction_uid: p[0], session_hash: p[1], client_id: p[2], redirect_uri: p[3],
          resource: p[4], pkce_challenge: p[6], oauth_state: p[7], selection_version: 0 };
        return result(row);
      }
      if (sql.includes("SET signin_state_hash")) {
        if (!row || row.interaction_uid !== p[2] || !row.session_hash.equals(p[3])) return result(null);
        Object.assign(row, { signin_state_hash: p[0], signin_pkce_verifier: p[1], signin_state_consumed_at: null });
        return result(row);
      }
      if (sql.includes("SELECT * FROM commonswarm_oauth.interactions")) {
        return result(row && row.interaction_uid === p[0] && row.session_hash.equals(p[1]) &&
          row.signin_state_consumed_at === null ? row : null);
      }
      if (sql.includes("SET signin_state_consumed_at")) { row.signin_state_consumed_at = new Date(); return result(row); }
      if (sql.includes("SET user_id") && sql.includes("browser_sessions")) {
        const session = sessions.get(key(p[3]));
        if (!session) return result(null);
        Object.assign(session, { user_id: p[0], user_email: p[1], user_display_name: p[2], authenticated_at: new Date() });
        return result(session);
      }
      if (sql.includes("SET user_id") && sql.includes("interactions")) {
        if (row.interaction_uid !== p[1] || !row.session_hash.equals(p[2]) || !row.signin_state_consumed_at) return result(null);
        row.user_id = p[0]; return result(row);
      }
      if (sql.includes("SET invalidated_at")) {
        const session = sessions.get(key(p[0])); sessions.delete(key(p[0])); return result(session);
      }
      if (sql.includes("INSERT INTO commonswarm_oauth.browser_sessions")) {
        sessions.set(key(p[0]), { user_id: p[1], user_email: p[2], user_display_name: p[3], authenticated_at: p[4] });
        return result({});
      }
      if (sql.includes("SET session_hash")) { row.session_hash = p[0]; row.selection_version++; return result(row); }
      throw new Error("unexpected fixture SQL");
    },
  };
  const details = { uid: UID, params: { client_id: "https://client.example/oauth.json",
    redirect_uri: "https://client.example/callback", resource: resource ?? `${ISSUER}/mcp`,
    scope: "openid mcp", code_challenge: "a".repeat(43), state: "original-client-oauth-state" },
    prompt: { name: "login", details: {} } };
  const provider = { on() {}, callback: () => () => { throw new Error("unexpected provider route"); },
    interactionDetails: async () => details,
    interactionFinished: async (_request, response, value) => {
      finished = value; response.writeHead(303, { location: "/authorize/resume" }); response.end();
    } };
  const calls = [];
  const gotrue = createGoTrueClient({ baseUrl: "https://auth.example/auth/v1", anonKey: "synthetic-anon",
    providers, provider: legacy ?? (providers ? "github" : undefined),
    fetch: async (url, options) => {
      calls.push({ url: new URL(url), options });
      if (url.pathname.endsWith("/otp")) return Response.json({}, { status: sendStatus });
      if (url.pathname.endsWith("/token")) return Response.json({ access_token: "synthetic-server-held-token", expires_in: 3600 });
      return Response.json({ id: USER, email: "human@example.test" });
    } });
  const store = new InteractionStore(pool);
  const shared = { provider, store, gotrue, allowedOrigins: new Set([ISSUER]), callbackUrl: `${ISSUER}/oauth/callback/gotrue` };
  const mcp = createInteractionHandler({ ...shared, workspaceReader: async () => [], consentOrchestrator: {} });
  const admin = createAdminInteractionHandler({ ...shared, workspaceReader: async () => [], service: {
    view: async () => { adminViews++; return {}; },
  } });
  const handler = createHandler({ provider, pool, interactionHandler: createResourceInteractionHandler({ mcpHandler: mcp, adminHandler: admin }),
    publicAuthorizationEnabled: true, maxBodyBytes: 1024, logger: createLogger(() => {}) });
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let cookie = `${SESSION_COOKIE}=${SESSION}`;
  async function run(path = `/interaction/${UID}`, { form, headers = {} } = {}) {
    const response = await fetch(`${origin}${path}`, { redirect: "manual", method: form ? "POST" : "GET",
      headers: { cookie, origin: ISSUER, ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}), ...headers },
      body: form ? new URLSearchParams(form) : undefined });
    if (!headers.cookie && response.headers.has("set-cookie")) cookie = response.headers.get("set-cookie").split(";", 1)[0];
    return { status: response.status, headers: response.headers, body: await response.text() };
  }
  async function chooser() {
    const response = await run();
    return { ...response, token: response.body.match(/name="csrf_token" value="([^"]+)"/)?.[1] };
  }
  return { run, chooser, calls, details, gotrue, row: () => row, finished: () => finished, adminViews: () => adminViews };
}

test("approval chooser renders Google, email link, GitHub in order with /app copy and only enabled methods", async t => {
  const h = await harness(t, { providers: ["github", "email", "google"] });
  const page = await h.chooser();
  assert.equal(page.status, 200);
  assert.deepEqual([...page.body.matchAll(/<button type="submit">([^<]+)<\/button>/g)].map(m => m[1]),
    ["Sign in with Google", "Email me a sign-in link", "Sign in with GitHub"]);
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.match(page.headers.get("content-security-policy"), /form-action 'self'; frame-ancestors 'none'/);
  assert.doesNotMatch(page.body, /<script|synthetic-server-held-token/);
  const subset = await harness(t, { providers: ["github"] });
  assert.deepEqual([...(await subset.chooser()).body.matchAll(/name="provider" value="([^"]+)"/g)].map(m => m[1]), ["github"]);
});

test("each method uses PKCE and the bound callback, rotates the session and resumes the same approval", async t => {
  for (const method of ["google", "email", "github"]) await t.test(method, async t => {
    const h = await harness(t);
    const page = await h.chooser();
    const started = await h.run(`/interaction/${UID}/signin?redirect_to=https://attacker.example`, {
      form: { provider: method, csrf_token: page.token, email: "human@example.test", redirect_uri: "https://attacker.example" },
    });
    assert.equal(started.status, method === "email" ? 200 : 303);
    const outbound = method === "email" ? h.calls[0].url : new URL(started.headers.get("location"));
    assert.equal(outbound.origin, "https://auth.example");
    assert.equal(outbound.pathname, `/auth/v1/${method === "email" ? "otp" : "authorize"}`);
    if (method !== "email") assert.equal(outbound.searchParams.get("provider"), method);
    const callback = new URL(outbound.searchParams.get("redirect_to"));
    assert.equal(callback.origin + callback.pathname, `${ISSUER}/oauth/callback/gotrue`);
    assert.equal(callback.searchParams.get("interaction"), UID);
    assert.deepEqual(hashOpaque(callback.searchParams.get("state")), h.row().signin_state_hash);
    assert.notEqual(callback.searchParams.get("state"), page.token);
    const verifier = h.row().signin_pkce_verifier;
    const expected = createHash("sha256").update(verifier).digest("base64url");
    const otp = method === "email" ? JSON.parse(h.calls[0].options.body) : null;
    assert.equal(otp?.code_challenge ?? outbound.searchParams.get("code_challenge"), expected);
    assert.equal(otp?.code_challenge_method ?? outbound.searchParams.get("code_challenge_method"), "s256");
    if (otp) { assert.equal(otp.email, "human@example.test"); assert.equal(otp.create_user, true); }
    assert.equal(h.row().oauth_state, "original-client-oauth-state");
    assert.equal(h.row().redirect_uri, "https://client.example/callback");
    callback.searchParams.set("code", "synthetic-auth-code");
    const returned = await h.run(callback.pathname + callback.search);
    assert.equal(returned.status, 303);
    assert.equal(returned.headers.get("location"), `/interaction/${UID}`);
    assert.match(returned.headers.get("set-cookie"), /Secure; HttpOnly; Path=\/; SameSite=Lax/);
    assert.deepEqual(JSON.parse(h.calls.find(c => c.url.pathname.endsWith("/token")).options.body),
      { auth_code: "synthetic-auth-code", code_verifier: verifier });
    assert.equal((await h.run()).status, 303);
    assert.deepEqual(h.finished(), { login: { accountId: USER } });
    assert.equal((await h.run(callback.pathname + callback.search)).status, 409);
  });
});

test("chooser refuses wrong state, browser, Origin, disabled providers and redirect-shaped providers before outbound requests", async t => {
  const h = await harness(t, { providers: ["google", "github"] });
  const page = await h.chooser();
  const valid = { provider: "google", csrf_token: page.token };
  for (const [form, headers, status] of [
    [{ ...valid, csrf_token: "incorrect-state-long-enough" }, {}, 409],
    [valid, { cookie: `${SESSION_COOKIE}=another-browser-session-long-enough` }, 409],
    [valid, { origin: "https://attacker.example" }, 403],
    [valid, { origin: "null" }, 403],
    [{ ...valid, provider: "email" }, {}, 400],
    [{ ...valid, provider: "https://attacker.example" }, {}, 400],
  ]) assert.equal((await h.run(`/interaction/${UID}/signin`, { form, headers })).status, status);
  assert.equal(h.calls.length, 0);
  const started = await h.run(`/interaction/${UID}/signin`, { form: valid });
  assert.equal(started.status, 303);
  const callback = new URL(new URL(started.headers.get("location")).searchParams.get("redirect_to"));
  callback.searchParams.set("code", "synthetic-code");
  const state = callback.searchParams.get("state");
  callback.searchParams.set("state", "wrong-callback-state-long-enough");
  assert.equal((await h.run(callback.pathname + callback.search)).status, 409);
  callback.searchParams.set("state", state);
  assert.equal((await h.run(callback.pathname + callback.search, { headers: {
    cookie: `${SESSION_COOKIE}=another-browser-session-long-enough` } })).status, 409);
  assert.equal(h.calls.length, 0);
  assert.equal((await h.run(callback.pathname + callback.search)).status, 303);
});

test("legacy single provider still redirects directly and refuses other methods", async t => {
  const h = await harness(t, { legacy: "github" });
  const page = await h.run();
  assert.equal(page.status, 303);
  assert.equal(new URL(page.headers.get("location")).searchParams.get("provider"), "github");
  assert.throws(() => h.gotrue.begin({ callbackUrl: `${ISSUER}/oauth/callback/gotrue`, interactionUid: UID, provider: "google" }), TypeError);
});

test("email rate refusal offers a retry without identity or token disclosure; malformed email sends nothing", async t => {
  const h = await harness(t, { sendStatus: 429 });
  const page = await h.chooser();
  assert.equal((await h.run(`/interaction/${UID}/signin`, { form: {
    provider: "email", csrf_token: page.token, email: "invalid" } })).status, 400);
  assert.equal(h.calls.length, 0);
  const refused = await h.run(`/interaction/${UID}/signin`, { form: {
    provider: "email", csrf_token: page.token, email: "human@example.test" } });
  assert.equal(refused.status, 429);
  assert.match(refused.body, /Please wait/);
  assert.doesNotMatch(refused.body, /human@example.test|synthetic-server-held-token/);
  assert.equal(h.finished(), undefined);
});

test("C1 fresh sign-in uses the chooser and same callback without entering admin consent or issuing authority", async t => {
  const h = await harness(t, { resource: ADMIN });
  const page = await h.chooser();
  assert.equal(page.status, 200);
  assert.equal(h.adminViews(), 0);
  const started = await h.run(`/interaction/${UID}/signin`, { form: { provider: "google", csrf_token: page.token } });
  assert.equal(started.status, 303);
  const callback = new URL(new URL(started.headers.get("location")).searchParams.get("redirect_to"));
  callback.searchParams.set("code", "synthetic-code");
  assert.equal((await h.run(callback.pathname + callback.search)).status, 303);
  assert.equal(h.row().resource, ADMIN);
  assert.equal(h.adminViews(), 0);
  assert.equal(h.finished(), undefined);
  assert.equal((await h.run()).status, 503); // Existing admin login issuance boundary.
  assert.equal(h.adminViews(), 1);
  assert.equal(h.finished(), undefined);
});
