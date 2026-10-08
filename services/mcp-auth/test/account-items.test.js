import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";

import { parseGoTrueProviders } from "../src/config.js";
import { createGoTrueClient } from "../src/gotrue.js";
import { hashOpaque, SESSION_COOKIE } from "../src/browser-security.js";
import { InteractionStore } from "../src/interaction-store.js";
import { createInteractionHandler } from "../src/interactions.js";
import { startServer } from "../src/server.js";
import { createMcpProvider, RESOURCE } from "../src/provider.js";

const USER = "10000000-0000-4000-8000-000000000001";
const OTHER = "10000000-0000-4000-8000-000000000002";
const COOKIE = "browser-session-long-enough";
const TOKEN = "consent-token-long-enough";
const ORIGIN = "https://mcp.commonswarm.com";
const UID = "same-interaction";
const WORKSPACE = "20000000-0000-4000-8000-000000000001";

function response() {
  return { headers: {}, status: 0, body: "",
    setHeader(name, value) { this.headers[name] = value; },
    writeHead(status, headers = {}) { this.status = status; Object.assign(this.headers, headers); },
    end(body = "") { this.body += body; } };
}

function harness({ providers = ["google", "github"], authenticated = false } = {}) {
  const session = { user_id: authenticated ? USER : null, authenticated_at: authenticated ? new Date().toISOString() : null,
    user_email: "current@example.test", user_display_name: "Human" };
  const binding = { user_id: session.user_id, selected_workspace_ids: [], selection_version: 0 };
  const oidcSession = { accountId: authenticated ? USER : null, amr: ["google"] };
  const calls = [];
  let pending;
  const store = {
    requireSession: async () => ({ ...session }), bindInteraction: async () => ({ ...binding }),
    issueConsentToken: async () => ({ token: TOKEN, selectionVersion: 0 }),
    beginSignIn: async (uid, id, signIn) => { pending = signIn; calls.push({ kind: "begin", uid, id }); },
    consumeSignIn: async (uid, id, state, selected) => {
      calls.push({ kind: "consume", uid, id, state, selected });
      return { signin_pkce_verifier: pending.verifier };
    },
    attachUser: async (uid, id, user) => {
      calls.push({ kind: "attach", uid, id, user });
      Object.assign(session, { user_id: user.id, authenticated_at: new Date().toISOString(),
        user_email: user.email, user_display_name: user.displayName });
      binding.user_id = user.id;
    },
    rotateSession: async () => "rotated-session-long-enough",
  };
  const gotrue = createGoTrueClient({ baseUrl: "https://api.commonswarm.com/auth/v1", anonKey: "test-public-key", providers,
    fetch: async (url) => String(url).includes("/token")
      ? Response.json({ access_token: "fixture-access", expires_in: 3600 })
      : Response.json({ id: USER, email: "current@example.test", email_confirmed_at: "2026-10-01T00:00:00Z",
        app_metadata: { provider: "unknown-value" }, user_metadata: { display_name: "Human" } }),
  });
  const provider = { interactionDetails: async () => ({ uid: UID, session: oidcSession, prompt: { name: "consent", details: {} },
      params: { client_id: "https://client.example/oauth.json", redirect_uri: "https://client.example/callback",
        resource: "https://mcp.commonswarm.com/mcp", scope: "openid mcp", code_challenge: "a".repeat(43) } }) };
  const handler = createInteractionHandler({
    provider,
    store, gotrue, consentOrchestrator: { status: async () => [] },
    workspaceReader: async () => [{ id: WORKSPACE, name: "Workspace" }],
    callbackUrl: `${ORIGIN}/oauth/callback/gotrue`, allowedOrigins: new Set([ORIGIN]),
  });
  async function run(path = `/interaction/${UID}`, { method = "GET", body = "", origin = ORIGIN } = {}) {
    const request = Readable.from(body ? [Buffer.from(body)] : []);
    request.method = method;
    request.headers = { cookie: `${SESSION_COOKIE}=${COOKIE}`, origin, "content-type": "application/x-www-form-urlencoded" };
    const result = response();
    await handler(request, result, new URL(path, ORIGIN));
    return result;
  }
  return { run, store, gotrue, provider, session, oidcSession, binding, calls };
}

test("provider config keeps legacy order, accepts equal settings and refuses mismatches or unknown ids", () => {
  assert.deepEqual(parseGoTrueProviders({ MCP_OAUTH_GOTRUE_PROVIDER: "github" }), ["github"]);
  assert.deepEqual(parseGoTrueProviders({ MCP_OAUTH_GOTRUE_PROVIDERS: " github, google " }), ["github", "google"]);
  assert.deepEqual(parseGoTrueProviders({ MCP_OAUTH_GOTRUE_PROVIDER: "google", MCP_OAUTH_GOTRUE_PROVIDERS: "google" }), ["google"]);
  assert.deepEqual(parseGoTrueProviders({ MCP_OAUTH_GOTRUE_PROVIDER: "", MCP_OAUTH_GOTRUE_PROVIDERS: "github,google" }), ["github", "google"]);
  for (const env of [ {}, { MCP_OAUTH_GOTRUE_PROVIDERS: "" }, { MCP_OAUTH_GOTRUE_PROVIDERS: "google,google" },
    { MCP_OAUTH_GOTRUE_PROVIDERS: "google," }, { MCP_OAUTH_GOTRUE_PROVIDERS: "Google" },
    { MCP_OAUTH_GOTRUE_PROVIDERS: "facebook" }, { MCP_OAUTH_GOTRUE_PROVIDERS: "a".repeat(65) },
    { MCP_OAUTH_GOTRUE_PROVIDER: "google", MCP_OAUTH_GOTRUE_PROVIDERS: "github" },
    { MCP_OAUTH_GOTRUE_PROVIDER: "google", MCP_OAUTH_GOTRUE_PROVIDERS: "google,github" } ]) {
    assert.throws(() => parseGoTrueProviders(env));
  }
});

test("startup refuses missing, disabled or malformed GoTrue providers without logging response secrets", async (t) => {
  const logs = [];
  t.mock.method(globalThis, "fetch", async () => Response.json({ external: { google: true } }));
  await assert.rejects(startServer({ config: { publicAuthorizationEnabled: true, gotrueUrl: "https://api.commonswarm.com/auth/v1",
    gotrueProviders: ["google", "github"], supabaseAnonKey: "must-not-log-key" },
    managementCommand: async () => {}, managementWorkspaceReader: async () => [], writeLog: (line) => logs.push(line) }),
  { code: "gotrue_providers_unavailable" });
  assert.match(logs.join(""), /startup_refused.*gotrue_providers_unavailable/);
  assert.doesNotMatch(logs.join(""), /must-not-log-key/);
  for (const external of [{ google: false }, { google: "true" }, {}]) {
    await assert.rejects(createGoTrueClient({ baseUrl: "https://api.commonswarm.com/auth/v1", provider: "google",
      fetch: async () => Response.json({ external }) }).verifyProviders(), { code: "gotrue_providers_unavailable" });
  }
  await createGoTrueClient({ baseUrl: "https://api.commonswarm.com/auth/v1", providers: ["google", "github"],
    fetch: async (url) => {
      assert.equal(String(url), "https://api.commonswarm.com/auth/v1/settings");
      return Response.json({ external: { google: true, github: true } });
    } }).verifyProviders();
});

test("chooser offers only configured provider links without scripts; initial single-provider sign-in redirects directly", async () => {
  const h = harness();
  const page = await h.run();
  assert.equal(page.status, 200);
  assert.match(page.body, /<a href="\/interaction\/same-interaction\/sign-in\?provider=google">Continue with Google<\/a>/);
  assert.match(page.body, /<a href="\/interaction\/same-interaction\/sign-in\?provider=github">Continue with GitHub<\/a>/);
  assert.doesNotMatch(page.body, /<form\b/u);
  assert.doesNotMatch(page.body, /<script|<img|<link|javascript:|fixture-access/);
  assert.match(page.headers["content-security-policy"], /^default-src 'none';/);
  assert.equal(h.calls.length, 0);
  const selected = await h.run(`/interaction/${UID}/sign-in?provider=github`);
  assert.equal(selected.status, 303);
  assert.equal(new URL(selected.headers.location).searchParams.get("provider"), "github");
  assert.equal(h.calls[0].uid, UID);
  assert.equal((await h.run(`/interaction/${UID}/sign-in?provider=facebook`)).status, 400);
  const wrongMethod = await h.run(`/interaction/${UID}/sign-in`, { method: "POST" });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.allow, "GET");
  const only = await harness({ providers: ["github"] }).run();
  assert.equal(only.status, 303);
  assert.equal(new URL(only.headers.location).searchParams.get("provider"), "github");
});

test("account forms and their redirect chains stay same-origin and stop at a link chooser under the unchanged CSP", async () => {
  const chooserCsp = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
  for (const providers of [["google"], ["github"], ["google", "github"]]) {
    const h = harness({ providers, authenticated: true });
    h.store.switchAccount = async () => {
      h.session.user_id = null;
      h.session.authenticated_at = null;
      h.binding.user_id = null;
      return "replacement-session-long-enough";
    };
    const consent = await h.run();
    assert.equal(consent.status, 200);
    assert.equal(consent.headers["content-security-policy"], chooserCsp.replace("form-action 'self'", "form-action 'self' https://client.example"));
    const forms = [...consent.body.matchAll(/<form\b[^>]*action="([^"]+)"[^>]*>/gu)];
    assert.equal(forms.length, 2, "consent and switch remain separate forms");
    for (const [, action] of forms) assert.equal(new URL(action, ORIGIN).origin, ORIGIN);
    // Submit each rendered form. Consent validation renders locally; switching
    // must end at HTML, including when only one provider is configured.
    for (const [, action] of forms.sort((a, b) => a[1].includes("switch-account") - b[1].includes("switch-account"))) {
      let result = await h.run(action, { method: "POST", body: `csrf_token=${TOKEN}&selection_version=0` });
      let hops = 0;
      while (result.status >= 300 && result.status < 400) {
        assert.ok(++hops <= 4, "redirect chain terminates");
        const target = new URL(result.headers.location, ORIGIN);
        assert.equal(target.origin, ORIGIN, "a form submission must never redirect to GoTrue");
        result = await h.run(target.pathname + target.search);
      }
      assert.match(result.headers["content-type"], /text\/html/u);
      if (!action.includes("switch-account")) {
        assert.equal(result.status, 400);
        continue;
      }
      assert.equal(result.status, 200);
      assert.equal(result.headers["content-security-policy"], chooserCsp);
      assert.doesNotMatch(result.body, /<form\b/u, "provider navigation uses links, never forms");
      const links = [...result.body.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>Continue with /gu)];
      assert.equal(links.length, providers.length);
      for (const [, href] of links) {
        const target = new URL(href.replaceAll("&amp;", "&"), ORIGIN);
        assert.equal(target.origin, ORIGIN);
        const signIn = await h.run(target.pathname + target.search);
        assert.equal(signIn.status, 303);
        const authorize = new URL(signIn.headers.location);
        const selected = target.searchParams.get("provider");
        assert.equal(authorize.searchParams.get("provider"), selected);
        assert.equal(authorize.searchParams.get("prompt"), selected === "google" ? "select_account" : null);
      }
    }
  }
});

test("chosen provider is returned in the callback and safe account chip; Google switching requests account selection", async () => {
  const h = harness({ providers: ["google"] });
  // The callback must persist the provider through the pinned OIDC model,
  // rather than relying on a pre-seeded amr value in the page fixture.
  const oidc = await createMcpProvider();
  const initial = await h.provider.interactionDetails();
  initial.session = undefined;
  initial.prompt = { name: "login", details: {} };
  await new oidc.Interaction(UID, initial).save(600);
  h.provider.Interaction = oidc.Interaction;
  h.provider.interactionDetails = async () => oidc.Interaction.find(UID);
  const consume = h.store.consumeSignIn;
  h.store.consumeSignIn = async (...args) => ({ ...await consume(...args), resource: RESOURCE });
  let submitted;
  h.provider.interactionFinished = async (_request, result, login) => {
    submitted = login;
    result.writeHead(303, { location: "/authorize/resume" });
    result.end();
  };
  const start = await h.run(`/interaction/${UID}/sign-in?provider=google&select_account=1`);
  const authorize = new URL(start.headers.location);
  assert.equal(authorize.searchParams.get("prompt"), "select_account");
  const callback = new URL(authorize.searchParams.get("redirect_to"));
  assert.equal(callback.searchParams.get("provider"), "google");
  callback.searchParams.set("code", "fixture-code");
  const finish = await h.run(callback.pathname + callback.search);
  assert.equal(finish.status, 303);
  assert.equal(h.calls.find((entry) => entry.kind === "attach").user.email, "current@example.test");
  assert.equal((await h.run()).status, 303);
  assert.deepEqual(submitted, { login: { accountId: USER, amr: ["google"] } });
  const persisted = await oidc.Interaction.find(UID);
  persisted.prompt = { name: "consent", details: {} };
  await persisted.persist();
  const callbackPage = await h.run();
  assert.match(callbackPage.body, /Signed in with Google as/);
  assert.match(callbackPage.body, /current@example.test/);
  const signedIn = harness({ authenticated: true });
  const page = await signedIn.run();
  assert.match(page.body, /Signed in with Google as/);
  assert.match(page.body, /current@example.test/);
  assert.match(page.body, /action="\/interaction\/same-interaction\/switch-account"/);
  signedIn.oidcSession.amr = ["unknown-provider"];
  assert.doesNotMatch((await signedIn.run()).body, /unknown-provider|Signed in with/);
  signedIn.oidcSession.amr = ["github"];
  signedIn.oidcSession.accountId = OTHER;
  assert.doesNotMatch((await signedIn.run()).body, /Signed in with/);
  assert.equal(h.gotrue.begin({ callbackUrl: callback.href, interactionUid: UID, provider: "google" }).url.searchParams.has("prompt"), false);
});

test("stored sign-in state rejects provider and state swaps", async () => {
  const state = "state-long-enough";
  const row = { selection_version: 0 };
  let consumed = 0;
  const query = async (sql, params) => {
    if (sql.includes("SET signin_state_hash")) {
      row.signin_state_hash = params[0];
      row.signin_pkce_verifier = params[1];
    }
    if (sql.startsWith("SELECT")) return { rows: [row], rowCount: 1 };
    if (sql.includes("SET signin_state_consumed_at")) consumed++;
    return { rows: [], rowCount: 1 };
  };
  const pool = { query, connect: async () => ({ release() {}, query }) };
  const store = new InteractionStore(pool);
  await store.beginSignIn(UID, COOKIE, { state, verifier: "pkce-verifier", provider: "google" });
  await assert.rejects(store.consumeSignIn(UID, COOKIE, state, "github"), { code: "interaction_binding_mismatch" });
  await assert.rejects(store.consumeSignIn(UID, COOKIE, "wrong-state", "google"), { code: "interaction_binding_mismatch" });
  assert.equal(consumed, 0);
  assert.equal((await store.consumeSignIn(UID, COOKIE, state, "google")).signin_pkce_verifier, "pkce-verifier");
  assert.equal(consumed, 1);
});

test("callback refuses a provider/state mismatch before exchange and accepts the matching callback", async () => {
  const h = harness();
  const start = await h.run(`/interaction/${UID}/sign-in?provider=google`);
  const callback = new URL(new URL(start.headers.location).searchParams.get("redirect_to"));
  callback.searchParams.set("code", "fixture-code");
  const row = { signin_state_hash: hashOpaque(`google:${callback.searchParams.get("state")}`),
    signin_pkce_verifier: "a".repeat(43), selection_version: 0 };
  const store = new InteractionStore({ connect: async () => ({ release() {}, query: async (sql) =>
    sql.startsWith("SELECT") ? { rowCount: 1, rows: [row] } : { rowCount: 1, rows: [] } }) });
  h.store.consumeSignIn = store.consumeSignIn.bind(store);
  let exchanges = 0;
  const exchange = h.gotrue.exchange;
  h.gotrue.exchange = async (input) => { exchanges++; return exchange(input); };
  callback.searchParams.set("provider", "github");
  await assert.rejects(h.run(callback.pathname + callback.search), { code: "interaction_binding_mismatch" });
  assert.equal(exchanges, 0);
  callback.searchParams.set("provider", "google");
  assert.equal((await h.run(callback.pathname + callback.search)).status, 303);
  assert.equal(exchanges, 1);
});

test("switch requires Origin and CSRF; the production store invalidates the old session and preserves the interaction", async () => {
  const h = harness({ authenticated: true });
  const queries = [];
  const pool = { connect: async () => ({ release() {}, query: async (sql, params) => {
    queries.push({ sql, params });
    if (sql.startsWith("SELECT")) return { rowCount: 1, rows: [h.binding] };
    return { rowCount: 1, rows: [] };
  } }) };
  const switchStore = new InteractionStore(pool);
  h.store.switchAccount = switchStore.switchAccount.bind(switchStore);
  assert.equal((await h.run(`/interaction/${UID}/switch-account`, { method: "POST" })).status, 403);
  assert.equal((await h.run(`/interaction/${UID}/switch-account`, { method: "POST", body: `csrf_token=${TOKEN}`, origin: "https://evil.example" })).status, 403);
  assert.equal(queries.length, 0);
  const switched = await h.run(`/interaction/${UID}/switch-account`, { method: "POST", body: `csrf_token=${TOKEN}` });
  assert.equal(switched.status, 303);
  assert.equal(switched.headers.location, `/interaction/${UID}/sign-in?select_account=1`);
  assert.match(switched.headers["set-cookie"][0], /Max-Age=0/);
  assert.match(switched.headers["set-cookie"][1], /Secure; HttpOnly/);
  const guard = queries.find(({ sql }) => sql.startsWith("SELECT"));
  assert.deepEqual(guard.params, [UID, hashOpaque(COOKIE), USER, hashOpaque(TOKEN)]);
  assert.match(guard.sql, /consent_token_hash = \$4 AND consent_token_consumed_at IS NULL/);
  const ended = queries.find(({ sql }) => sql.includes("SET invalidated_at"));
  assert.deepEqual(ended.params, [hashOpaque(COOKIE), USER]);
  const reset = queries.find(({ sql }) => sql.includes("SET session_hash"));
  assert.equal(reset.params[1], UID);
  assert.match(reset.sql, /user_id = NULL/);
  assert.match(reset.sql, /consent_token_hash = NULL/);
  assert.ok(!reset.params[0].equals(hashOpaque(COOKIE)));
  assert.equal(queries.at(-1).sql, "COMMIT");
});

test("switch rejects a stale CSRF digest without ending the browser session", async () => {
  const writes = [];
  const store = new InteractionStore({ connect: async () => ({ release() {}, query: async (sql) => {
    writes.push(sql);
    return { rows: [], rowCount: 0 };
  } }) });
  await assert.rejects(store.switchAccount({ interactionUid: UID, sessionId: COOKIE, userId: USER, token: "wrong-token" }),
    { code: "interaction_binding_mismatch" });
  assert.equal(writes.some((sql) => sql.includes("SET invalidated_at")), false);
  assert.equal(writes.at(-1), "ROLLBACK");
});

test("a different browser user is refused on render and POST before consent can create a grant", async () => {
  const h = harness({ authenticated: true });
  assert.equal((await h.run()).status, 200);
  h.session.user_id = OTHER;
  for (const method of ["GET", "POST"]) {
    const result = await h.run(`/interaction/${UID}${method === "POST" ? "/consent" : ""}`, {
      method, body: method === "POST" ? `csrf_token=${TOKEN}&selection_version=0&workspace_ids=${WORKSPACE}&home_workspace_id=${WORKSPACE}` : "",
    });
    assert.equal(result.status, 409);
    assert.match(result.body, /You signed in as a different account; start again/);
  }
});

test("sign-in cannot replace a user already bound to the interaction", async () => {
  let writes = 0;
  const store = new InteractionStore({ connect: async () => ({ release() {}, query: async (sql) => {
    if (sql.startsWith("SELECT")) return { rowCount: 1, rows: [{ user_id: USER }] };
    if (sql.startsWith("UPDATE")) writes++;
    return { rowCount: 1, rows: [] };
  } }) });
  await assert.rejects(store.attachUser(UID, COOKIE, { id: OTHER, email: "other@example.test" }), { code: "different_account" });
  assert.equal(writes, 0);
});
