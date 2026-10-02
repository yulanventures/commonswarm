import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { test } from "node:test";

import { hashOpaque, SESSION_COOKIE } from "../src/browser-security.js";
import { createConsentOrchestrator } from "../src/consent.js";
import { InteractionStore } from "../src/interaction-store.js";
import { createInteractionHandler } from "../src/interactions.js";
import { createLogger } from "../src/logger.js";
import { createMcpProvider, ISSUER, RESOURCE } from "../src/provider.js";
import { createHandler, createProductionFindAccount } from "../src/server.js";

const CLIENT = "https://claude.ai/oauth/mcp-oauth-client-metadata";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const USER = "10000000-0000-4000-8000-000000000001";
const BROWSER = "authenticated-browser-session-fixture";
const STATE = "synthetic-authorization-state";

function authorize(prompt) {
  const params = new URLSearchParams({
    client_id: CLIENT, redirect_uri: REDIRECT, resource: RESOURCE,
    response_type: "code", scope: "openid mcp", state: STATE,
    code_challenge: createHash("sha256").update("synthetic-pkce-verifier-long-enough").digest("base64url"),
    code_challenge_method: "S256",
  });
  if (prompt !== undefined) params.set("prompt", prompt);
  return `/authorize?${params}`;
}

function exchange(url, cookies = new Map()) {
  const request = Readable.from([]);
  Object.assign(request, {
    method: "GET", url, httpVersionMajor: 1, httpVersionMinor: 1,
    headers: { host: new URL(ISSUER).host, "x-forwarded-proto": "https",
      cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join("; "), accept: "text/html" },
    socket: { encrypted: true },
  });
  // Real Node headers/status semantics, but no socket and no listen(). Koa and
  // the production wrapper both run; only the final response bytes are captured.
  const response = new ServerResponse(request);
  response.body = "";
  response.end = (body = "") => { response.body += String(body); };
  return { request, response };
}

async function harness({ findAccount } = {}) {
  const logs = [];
  const queries = [];
  const sessions = new Map([[hashOpaque(BROWSER).toString("hex"), {
    session_hash: hashOpaque(BROWSER), user_id: USER, authenticated_at: new Date().toISOString(),
    user_email: "human@example.test", user_display_name: "Human", status: "valid",
  }]]);
  const interactions = new Map();
  const rows = (row) => ({ rowCount: row ? 1 : 0, rows: row ? [row] : [] });
  const pool = {
    async query(sql, values) {
      queries.push(sql);
      if (sql.includes("SELECT 1 FROM commonswarm_oauth.browser_sessions")) {
        assert.equal(values[0], USER);
        return rows([...sessions.values()].find((row) => row.user_id === USER &&
          row.authenticated_at !== null && row.status === "valid"));
      }
      if (sql.includes("SELECT session_hash")) {
        const row = sessions.get(values[0].toString("hex"));
        return rows(row?.status === "valid" ? row : null);
      }
      if (sql.includes("INSERT INTO commonswarm_oauth.browser_sessions")) {
        const row = { session_hash: values[0], user_id: null, authenticated_at: null, status: "valid" };
        sessions.set(values[0].toString("hex"), row);
        return rows(row);
      }
      if (sql.includes("INSERT INTO commonswarm_oauth.interactions")) {
        const row = interactions.get(values[0]) ?? {
          interaction_uid: values[0], user_id: values[9], selection_version: 0, selected_workspace_ids: [],
        };
        interactions.set(values[0], row);
        return rows(row);
      }
      if (sql.includes("SET consent_token_hash") || sql.includes("SET signin_state_hash")) {
        return rows(interactions.get(sql.includes("SET consent_token_hash") ? values[1] : values[2]));
      }
      throw new Error("unexpected fixture database operation");
    },
  };
  const provider = await createMcpProvider({
    findAccount: findAccount ?? createProductionFindAccount(pool),
    fetch: async (url) => {
      assert.equal(String(url), CLIENT);
      return Response.json({
        client_id: CLIENT, client_name: "Claude", client_uri: "https://claude.ai",
        grant_types: ["authorization_code", "refresh_token"], redirect_uris: [REDIRECT],
        response_types: ["code"], token_endpoint_auth_method: "none",
      });
    },
  });
  const handler = createHandler({
    provider, pool, publicAuthorizationEnabled: true, maxBodyBytes: 64 * 1024,
    logger: createLogger((line) => logs.push(JSON.parse(line))),
    interactionHandler: createInteractionHandler({
      provider, store: new InteractionStore(pool),
      gotrue: { begin: () => ({ url: new URL("https://api.commonswarm.com/auth/v1/authorize"),
        state: "synthetic-sign-in-state", verifier: "synthetic-sign-in-verifier" }) },
      consentOrchestrator: createConsentOrchestrator({ command: async () => assert.fail("no consent was submitted") }),
      workspaceReader: async () => [], allowedOrigins: new Set([ISSUER]),
      callbackUrl: `${ISSUER}/oauth/callback/gotrue`,
    }),
  });
  const cookies = new Map([[SESSION_COOKIE, BROWSER]]);
  async function run(url, method = "GET") {
    const { request, response } = exchange(url, cookies);
    request.method = method;
    if (method === "POST") request.headers["content-type"] = "application/x-www-form-urlencoded";
    await handler(request, response);
    for (const cookie of response.getHeader("set-cookie") ?? []) {
      const [pair] = cookie.split(";", 1);
      const index = pair.indexOf("=");
      cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
    return response;
  }
  async function completedLogin() {
    const start = await run(authorize("login"));
    assert.equal(start.statusCode, 303);
    const login = await run(start.getHeader("location"));
    assert.equal(login.statusCode, 303);
    const resumed = await run(new URL(login.getHeader("location")).pathname);
    assert.equal(resumed.statusCode, 303);
    assert.match(resumed.getHeader("location"), /^\/interaction\//u);
    const { request, response } = exchange("/authorize", cookies);
    const session = await provider.Session.get(provider.createContext(request, response));
    assert.equal(session.accountId, USER);
    return session;
  }
  return { provider, pool, logs, queries, sessions, cookies, run, completedLogin };
}

// The owner boundary is GET /authorize with real provider policies and signed
// cookies. Earlier returning-browser tests start at /interaction and cannot
// catch a failure in loadAccount/loadGrant before an interaction is created.
test("Claude authorize reauthenticates unavailable accounts before consent, including old grants and cookies", async (t) => {
  for (const providerState of ["fresh", "logged-in", "grant"]) {
    for (const browserState of ["valid", "expired", "invalidated", "missing", "unauthenticated"]) {
      for (const prompt of ["consent", undefined, "login"]) {
        for (const staleCookies of [false, true]) {
          await t.test(`${providerState}, browser ${browserState}, prompt ${prompt ?? "absent"}, stale ${staleCookies}`, async () => {
            const h = await harness();
            if (providerState !== "fresh") {
              const session = await h.completedLogin();
              if (providerState === "grant") {
                const grant = new h.provider.Grant({ accountId: USER, clientId: CLIENT });
                grant.addOIDCScope("openid mcp");
                grant.addResourceScope(RESOURCE, "mcp");
                session.grantIdFor(CLIENT, await grant.save());
                await session.persist();
              }
            }
            const browser = h.sessions.get(hashOpaque(BROWSER).toString("hex"));
            if (browserState === "missing") h.sessions.clear();
            else if (browserState === "unauthenticated") { browser.authenticated_at = null; browser.user_id = null; }
            else browser.status = browserState;
            if (staleCookies) {
              // Signed, but no longer persisted: reproduces unfinished attempts
              // without assuming that unsigned cookies pass provider validation.
              const { request, response } = exchange("/authorize");
              const ctx = h.provider.createContext(request, response);
              for (const type of ["interaction", "resume"]) {
                ctx.cookies.set(h.provider.cookieName(type), "stale-interaction", { signed: true, secure: true });
              }
              for (const cookie of response.getHeader("set-cookie")) {
                const [pair] = cookie.split(";", 1);
                const index = pair.indexOf("=");
                h.cookies.set(pair.slice(0, index), pair.slice(index + 1));
              }
            }
            const response = await h.run(authorize(prompt));
            assert.equal(response.statusCode, 303);
            const location = response.getHeader("location");
            const unavailable = browserState !== "valid";
            const directCode = providerState === "grant" && !unavailable && prompt === undefined;
            if (directCode) {
              const callback = new URL(location);
              assert.equal(callback.origin + callback.pathname, REDIRECT);
              assert.ok(callback.searchParams.get("code"));
              assert.equal(callback.searchParams.get("error"), null);
            } else {
              assert.match(location, /^\/interaction\//u);
              const interaction = await h.provider.Interaction.find(location.split("/").at(-1));
              const expected = providerState === "fresh" || unavailable || prompt === "login" ? "login" : "consent";
              assert.equal(interaction.prompt.name, expected);
              if (providerState !== "fresh" && unavailable) {
                assert.ok(h.queries.some((sql) => sql.includes("SELECT 1 FROM commonswarm_oauth.browser_sessions")));
              }
              // Verify the recovery step with the production interaction wiring:
              // missing/expired browser sessions start GoTrue, not auto-consent.
              if (unavailable) {
                const next = await h.run(location);
                assert.equal(next.statusCode, 303);
                assert.equal(next.getHeader("location"), "https://api.commonswarm.com/auth/v1/authorize");
              }
            }
            assert.equal(h.logs.some((entry) => entry.event === "server_error"), false);
          });
        }
      }
    }
  }
});

test("provider error events log a thrown hook with request id and source locations, without sensitive values", async () => {
  const h = await harness({ findAccount: async () => {
    const error = new Error("synthetic-secret-message");
    error.code = "42P01";
    throw error;
  } });
  const session = new h.provider.Session({ accountId: USER, loginTs: Math.floor(Date.now() / 1000) });
  await session.save(600);
  const { request, response: signed } = exchange("/authorize");
  h.provider.createContext(request, signed).cookies.set(h.provider.cookieName("session"), session.jti,
    { signed: true, secure: true });
  for (const cookie of signed.getHeader("set-cookie")) {
    const [pair] = cookie.split(";", 1);
    const index = pair.indexOf("=");
    h.cookies.set(pair.slice(0, index), pair.slice(index + 1));
  }
  const response = await h.run(authorize("consent"));
  assert.equal(response.statusCode, 500);
  const diagnostic = h.logs.find((entry) => entry.event === "server_error");
  assert.ok(diagnostic);
  assert.equal(diagnostic.request_id, response.getHeader("x-request-id"));
  assert.equal(diagnostic.error_name, "Error");
  assert.equal(diagnostic.error_code, "42P01");
  assert.ok(diagnostic.stack_frames.some((frame) => /^authorize-state\.test\.js:\d+$/u.test(frame)));
  assert.ok(diagnostic.stack_frames.every((frame) => /^[A-Za-z0-9_.-]+\.js:\d+$/u.test(frame)));
  assert.doesNotMatch(JSON.stringify(h.logs), /synthetic-secret-message|synthetic-authorization-state|authenticated-browser-session-fixture|client_id|code_challenge/u);

  h.cookies.delete(h.provider.cookieName("session"));
  h.cookies.delete(`${h.provider.cookieName("session")}.sig`);
  assert.equal((await h.run(authorize("consent"))).statusCode, 303);
  assert.equal((await h.run("/authorize")).statusCode, 400);
  assert.ok(h.logs.some((entry) => entry.event === "authorization.error" && entry.error_name));
  const tokenResponse = await h.run("/token", "POST");
  assert.equal(tokenResponse.statusCode, 400);
  assert.ok(h.logs.some((entry) => entry.event === "grant.error"));
  const expiredInteraction = await h.run("/interaction/unavailable");
  assert.equal(expiredInteraction.statusCode, 409);
  assert.ok(h.logs.some((entry) => entry.event === "interaction.error" &&
    entry.error_name === "InteractionStateError" && entry.error_code === "interaction_mismatch" &&
    entry.request_id === expiredInteraction.getHeader("x-request-id")));
});
