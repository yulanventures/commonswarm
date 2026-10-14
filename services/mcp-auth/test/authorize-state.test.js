import { verifiedSignIn } from "./fixtures/verified-sign-in.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { connect } from "node:net";
import { PassThrough, Readable } from "node:stream";
import { test } from "node:test";
import { createLocalJWKSet, jwtVerify } from "jose";
import pg from "pg";

import { adminDigest, createAdminConsentService, PostgresAdminConsentStore } from "../src/admin-consent.js";
import { createResourceInteractionHandler } from "../src/admin-interactions.js";
import { hashOpaque, SESSION_COOKIE } from "../src/browser-security.js";
import { createConsentOrchestrator } from "../src/consent.js";
import { createFinishFlow } from "../src/finish-flow.js";
import { FinishStore } from "../src/finish-store.js";
import { InteractionStore } from "../src/interaction-store.js";
import { createInteractionHandler } from "../src/interactions.js";
import { createLogger } from "../src/logger.js";
import { createMcpProvider, ISSUER, RESOURCE, REFRESH_TOKEN_TTL_SECONDS } from "../src/provider.js";
import { createRegistrationLimiter } from "../src/registration.js";
import { createHandler, createProductionFindAccount, startServer } from "../src/server.js";
import { MCP_CONNECTION_SCOPES } from "../../../supabase/functions/_shared/mcp-connection-scopes.js";

const CLIENT = "https://claude.ai/oauth/mcp-oauth-client-metadata";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const USER = "10000000-0000-4000-8000-000000000001";
const BROWSER = "authenticated-browser-session-fixture";
const STATE = "synthetic-authorization-state";
const VERIFIER = "synthetic-pkce-verifier-with-at-least-43-characters";
const W1 = "20000000-0000-4000-8000-000000000001";
const W2 = "20000000-0000-4000-8000-000000000002";

function authorize(prompt, scope = "openid mcp", redirectUri = REDIRECT, clientId = CLIENT) {
  const params = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, resource: RESOURCE,
    response_type: "code", scope, state: STATE,
    code_challenge: createHash("sha256").update(VERIFIER).digest("base64url"),
    code_challenge_method: "S256",
  });
  if (prompt !== undefined) params.set("prompt", prompt);
  return `/authorize?${params}`;
}

function exchange(url, cookies = new Map(), body = "", { bufferedBody = false } = {}) {
  const socket = new PassThrough();
  socket.encrypted = true;
  const request = bufferedBody ? new IncomingMessage(socket)
    : Readable.from(body ? [Buffer.from(body)] : []);
  if (bufferedBody) {
    // HTTP headers can arrive with the first body bytes already buffered.
    // The rest arrives in a later I/O turn, without opening a socket.
    const bytes = Buffer.from(body);
    request.push(bytes.subarray(0, Math.ceil(bytes.length / 2)));
    setImmediate(() => {
      request.push(bytes.subarray(Math.ceil(bytes.length / 2)));
      request.complete = true;
      request.push(null);
    });
  }
  Object.assign(request, {
    method: "GET", url, httpVersionMajor: 1, httpVersionMinor: 1,
    headers: { host: new URL(ISSUER).host, "x-forwarded-proto": "https",
      cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join("; "), accept: "text/html" },
    socket,
  });
  // Real Node headers/status semantics, but no socket and no listen(). Koa and
  // the production wrapper both run; only the final response bytes are captured.
  const response = new ServerResponse(request);
  response.body = "";
  response.end = (body = "") => {
    response.body += String(body);
    response.finished = true;
    response.emit("finish");
  };
  return { request, response };
}

async function harness({ findAccount, redirectUri = REDIRECT, nativeLoopbackEnabled = false,
  registrationEnabled = true, registrationLimiter, clientId = CLIENT, clientMetadata,
  providerGrantActive, finishEnabled = false } = {}) {
  const logs = [];
  const queries = [];
  const commands = [];
  const evidence = verifiedSignIn({ userId: USER });
  const sessions = new Map([[hashOpaque(BROWSER).toString("hex"), {
    ...evidence.browserSession, session_hash: hashOpaque(BROWSER), status: "valid",
  }]]);
  const interactions = new Map();
  const finishes = new Map();
  const rows = (row) => ({ rowCount: row ? 1 : 0, rows: row ? [row] : [] });
  const pool = {
    async connect() { return { query: pool.query.bind(pool), release() {} }; },
    async query(sql, values) {
      queries.push(sql);
      // FinishStore owns capture and resume validation; this fixture supplies
      // SQL rows only. The real provider still creates and consumes every code.
      if (sql.includes("INSERT INTO commonswarm_oauth.finish_records")) {
        finishes.set(values[0], { interaction_uid: values[0], session_hash: values[1], user_id: values[2],
          display_model: JSON.parse(values[3]), provider_result: JSON.parse(values[4]),
          validated_request: JSON.parse(values[5]), state: "prepared", expires_at: new Date(Date.now() + 120000) });
        return rows({});
      }
      if (sql.includes("SELECT f.*")) {
        const row = finishes.get(values[0]);
        return rows(row && row.session_hash.equals(values[1]) && row.user_id === values[2] &&
          JSON.stringify(row.validated_request) === values[3]
          ? { ...row, browser: sessions.get(row.session_hash.toString("hex")) } : null);
      }
      if (sql.includes("pg_advisory_")) return rows({});
      if (sql.includes("UPDATE commonswarm_oauth.finish_records")) {
        const row = finishes.get(values[0]);
        if (sql.includes("SET state='resume_ready'")) {
          Object.assign(row, { state: "resume_ready", resume_response: JSON.parse(values[1]) });
        } else row.state = "preparing_resume";
        return rows({});
      }
      if (sql.includes("commonswarm_oauth.live_gotrue_session")) return evidence.pool.query(sql, values);
      if (sql.includes("FROM commonswarm_oauth.resolve_hosted_grant_status")) {
        assert.equal(values[1], USER);
        const active = [...interactions.values()].some((row) =>
          row.provider_grant_id === values[0] && row.completed);
        return rows(active ? {} : null);
      }
      if (sql.trimStart().startsWith("SELECT 1 FROM commonswarm_oauth.browser_sessions")) {
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
      if (sql.includes("JOIN commonswarm_oauth.browser_sessions")) {
        const [uid, sessionHash] = values;
        const row = interactions.get(uid);
        const session = sessions.get(sessionHash.toString("hex"));
        return rows(row && row.session_hash.equals(sessionHash) && session?.status === "valid" &&
          session.authenticated_at && row.user_id === session.user_id
          ? { ...row, unexpired: true } : null);
      }
      if (sql.includes("INSERT INTO commonswarm_oauth.interactions")) {
        const previous = interactions.get(values[0]);
        const row = {
          interaction_uid: values[0], session_hash: values[1], client_id: values[2],
          redirect_uri: values[3], resource: values[4], requested_scopes: values[5],
          pkce_challenge: values[6], oauth_state: values[7], user_id: values[9],
          selection_version: 0, selected_workspace_ids: [],
        };
        if (previous) {
          const matches = previous.session_hash.equals(row.session_hash) &&
            ["client_id", "redirect_uri", "resource", "pkce_challenge", "oauth_state"].every(
              (key) => previous[key] === row[key]) &&
            JSON.stringify(previous.requested_scopes) === JSON.stringify(row.requested_scopes);
          return rows(matches && !previous.completed ? previous : null);
        }
        interactions.set(values[0], row);
        return rows(row);
      }
      if (sql.includes("SET consent_token_hash")) {
        const [tokenHash, uid, sessionHash, userId] = values;
        const row = interactions.get(uid);
        if (!row || row.completed || !row.session_hash.equals(sessionHash) || row.user_id !== userId) return rows(null);
        row.consent_token_hash = tokenHash;
        row.consent_token_consumed_at = null;
        return rows({ ...row });
      }
      if (sql.includes("SET signin_state_hash")) return rows(interactions.get(values[2]));
      if (sql.includes("SET selected_workspace_ids")) {
        const [selected, digest, uid, sessionHash, userId, version, tokenHash] = values;
        const row = interactions.get(uid);
        if (!row || row.completed || !row.session_hash.equals(sessionHash) || row.user_id !== userId ||
            row.selection_version !== version || !row.consent_token_hash.equals(tokenHash) ||
            row.consent_token_consumed_at !== null || (row.commonswarm_grant_id &&
              (JSON.stringify(row.selected_workspace_ids) !== JSON.stringify(selected) ||
                !row.manifest_digest.equals(digest)))) return rows(null);
        Object.assign(row, { selected_workspace_ids: selected, manifest_digest: digest,
          selection_version: version + 1, consent_token_consumed_at: new Date() });
        return rows({ ...row });
      }
      if (sql.includes("SET provider_grant_id")) {
        const [providerId, commonswarmId, uid] = values;
        const row = interactions.get(uid);
        if (!row || row.completed || (row.provider_grant_id && row.provider_grant_id !== providerId) ||
            (row.commonswarm_grant_id && row.commonswarm_grant_id !== commonswarmId)) return rows(null);
        Object.assign(row, { provider_grant_id: providerId, commonswarm_grant_id: commonswarmId });
        return rows({ ...row });
      }
      if (sql.includes("SET completed_at")) {
        Object.assign(interactions.get(values[0]), { completed: true, completed_at: new Date() });
        return rows({});
      }
      throw new Error("unexpected fixture database operation");
    },
  };
  const provider = await createMcpProvider({
    nativeLoopbackEnabled, registrationEnabled, registrationLimiter, providerGrantActive,
    findAccount: findAccount ?? createProductionFindAccount(pool),
    fetch: async (url) => {
      assert.equal(String(url), clientId);
      return Response.json(clientMetadata ?? {
        client_id: CLIENT, client_name: "Claude", client_uri: "https://claude.ai",
        grant_types: ["authorization_code", "refresh_token"], redirect_uris: [redirectUri],
        application_type: nativeLoopbackEnabled ? "native" : "web",
        response_types: ["code"], token_endpoint_auth_method: "none",
      });
    },
  });
  const store = new InteractionStore(pool);
  const finishFlow = finishEnabled ? createFinishFlow({ provider, store,
    finishStore: new FinishStore(pool, { issuer: ISSUER, verifySession: async () => true }) }) : undefined;
  const handler = createHandler({
    provider, pool, publicAuthorizationEnabled: true, maxBodyBytes: 64 * 1024,
    finishEnabled, finishFlow,
    logger: createLogger((line) => logs.push(JSON.parse(line))),
    interactionHandler: createResourceInteractionHandler({
      adminHandler: () => { throw new Error("ordinary MCP must not reach admin consent"); },
      mcpHandler: createInteractionHandler({
        provider, store, finishFlow,
        gotrue: { begin: () => ({ url: new URL("https://api.commonswarm.com/auth/v1/authorize"),
          provider: "github", state: "synthetic-sign-in-state", verifier: "synthetic-sign-in-verifier" }) },
        consentOrchestrator: createConsentOrchestrator({ command: async (body, identity) => {
          commands.push({ body, identity });
          return { status: 200, body: { ok: true } };
        } }),
        workspaceReader: async () => [{ id: W1, name: "One" }, { id: W2, name: "Two" }], allowedOrigins: new Set([ISSUER]),
        callbackUrl: `${ISSUER}/oauth/callback/gotrue`,
      }),
    }),
  });
  const cookies = new Map([[SESSION_COOKIE, BROWSER]]);
  async function run(url, method = "GET", body = "", contentType = "application/x-www-form-urlencoded",
    options = {}) {
    const { request, response } = exchange(url, cookies, body, options);
    request.method = method;
    request.socket.remoteAddress = options.ip ?? "203.0.113.10";
    Object.assign(request.headers, options.headers ?? {});
    if (method === "POST") {
      request.headers["content-type"] = contentType;
      if (url === "/token" || url === "/reg") request.headers.accept = "application/json";
      if (url.startsWith("/interaction/")) request.headers.origin = ISSUER;
      if (options.chunked) request.headers["transfer-encoding"] = "chunked";
      else request.headers["content-length"] = String(Buffer.byteLength(body));
    }
    if (options.bufferedBody) {
      // A server request callback starts in an I/O turn, before nextTick stream
      // events; invoking it from a promise continuation masks premature drains.
      await new Promise((resolve, reject) => process.nextTick(() => {
        handler(request, response).then(resolve, reject);
      }));
    } else {
      await handler(request, response);
    }
    for (const cookie of response.getHeader("set-cookie") ?? []) {
      const [pair] = cookie.split(";", 1);
      const index = pair.indexOf("=");
      cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
    return response;
  }
  async function completedLogin() {
    const start = await run(authorize(undefined, "openid mcp", redirectUri, clientId));
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
  return { provider, pool, logs, queries, sessions, cookies, run, completedLogin, interactions, commands,
    setClient: (id) => { clientId = id; } };
}

// Public Codex CIMD: https://chatgpt.com/oauth/codex/client.json
// HTTP 200 fetched at 2026-10-12T17:20:16Z.
// Codex rust-v0.162.0-alpha.17.2 uses AS discovery scopes when none are explicit
// or configured (resolve_oauth_scopes, codex-rs/codex-mcp/src/mcp/auth.rs:158-190).
// AuthorizationRequest sets scopes, client name and optional CIMD, but no prompt
// (codex-rs/rmcp-client/src/oauth_client_registration.rs:112-126).
test("Codex CIMD request issues and rotates refresh only for a refresh-capable client after consent", async (t) => {
  const codexMetadata = JSON.parse(readFileSync(new URL("fixtures/codex-client.json", import.meta.url)));
  const clientId = codexMetadata.client_id;
  const redirectUri = "http://127.0.0.1:1455/callback";
  for (const { name, refreshAllowed, mcpAllowed, revoked = false } of [
    { name: "refresh issued and rotated", refreshAllowed: true, mcpAllowed: true },
    { name: "no refresh_token grant, no refresh", refreshAllowed: false, mcpAllowed: true },
    { name: "no mcp scope, no refresh", refreshAllowed: true, mcpAllowed: false },
    { name: "revoked hosted grant, no tokens", refreshAllowed: true, mcpAllowed: true, revoked: true },
  ]) {
    await t.test(name, async (t) => {
      t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
      let grantActive = true;
      const clientMetadata = refreshAllowed ? codexMetadata : {
        ...codexMetadata, grant_types: ["authorization_code"],
      };
      const h = await harness({ clientId, redirectUri, clientMetadata, nativeLoopbackEnabled: true,
        providerGrantActive: async () => grantActive });
      const discovery = JSON.parse((await h.run("/.well-known/oauth-authorization-server")).body);
      for (const scope of MCP_CONNECTION_SCOPES) assert.ok(discovery.scopes_supported.includes(scope));
      // The scope control is equivalent to an explicit --scopes override;
      // the Codex default and the metadata-grant control use discovery verbatim.
      const scopes = discovery.scopes_supported.filter(scope => mcpAllowed || scope !== "mcp");
      const request = authorize(undefined, scopes.join(" "), redirectUri, clientId);
      assert.equal(new URL(request, ISSUER).searchParams.has("prompt"), false);
      const start = await h.run(request);
      assert.equal(start.statusCode, 303);
      const login = await h.run(start.getHeader("location"));
      assert.equal(login.statusCode, 303);
      const resumed = await h.run(new URL(login.getHeader("location")).pathname);
      assert.equal(resumed.statusCode, 303);
      const path = resumed.getHeader("location");
      const page = await h.run(path);
      assert.equal(page.statusCode, 200);
      const form = new URLSearchParams({
        csrf_token: /name="csrf_token" value="([^"]+)"/u.exec(page.body)[1],
        selection_version: /name="selection_version" value="([^"]+)"/u.exec(page.body)[1],
        workspace_ids: W1,
      });
      const consent = await h.run(`${path}/consent`, "POST", form.toString());
      assert.equal(consent.statusCode, 303);
      const finished = await h.run(new URL(consent.getHeader("location")).pathname);
      const callback = new URL(finished.getHeader("location"));
      assert.equal(callback.origin + callback.pathname, redirectUri);
      assert.equal(callback.searchParams.get("error"), null);
      assert.ok(callback.searchParams.get("code"));
      const code = await h.provider.AuthorizationCode.find(callback.searchParams.get("code"));
      const session = await h.provider.Session.findByUid(code.sessionUid);
      assert.ok(session);
      grantActive = !revoked;
      const response = await h.run("/token", "POST", new URLSearchParams({
        grant_type: "authorization_code", client_id: clientId, redirect_uri: redirectUri,
        resource: RESOURCE, code: callback.searchParams.get("code"), code_verifier: VERIFIER,
      }).toString());
      if (revoked) {
        assert.equal(response.statusCode, 400);
        const refused = JSON.parse(response.body);
        assert.equal(refused.error, "invalid_grant");
        assert.equal(refused.refresh_token, undefined);
        assert.equal(refused.access_token, undefined);
        return;
      }
      assert.equal(response.statusCode, 200);
      const tokens = JSON.parse(response.body);
      assert.ok(tokens.access_token);
      assert.equal(tokens.scope ?? "", mcpAllowed ? "mcp" : "");
      assert.ok(tokens.id_token, "Codex requests the AS-advertised openid scope too");
      if (!refreshAllowed || !mcpAllowed) {
        assert.equal(tokens.refresh_token, undefined);
        return;
      }
      assert.ok(tokens.refresh_token, "advertised scopes must enable refresh after consent");
      const refresh = await h.run("/token", "POST", new URLSearchParams({
        grant_type: "refresh_token", client_id: clientId,
        refresh_token: tokens.refresh_token, resource: RESOURCE,
      }).toString());
      assert.equal(refresh.statusCode, 200);
      const rotated = JSON.parse(refresh.body);
      assert.ok(rotated.access_token);
      assert.ok(rotated.refresh_token);
      assert.notEqual(rotated.refresh_token, tokens.refresh_token);
      assert.equal(rotated.scope, "mcp");
      // Model a returning provider session whose remaining life is one hour
      // shorter than a fresh grant/token. Use the real Session TTL/storage,
      // not the separate one-hour InteractionStore browser cookie.
      await session.save(REFRESH_TOKEN_TTL_SECONDS - 3600);
      t.mock.timers.setTime(session.exp * 1000 + 1000);
      assert.equal(await h.provider.Session.findByUid(session.uid), undefined);
      h.sessions.clear(); // The separate authenticated browser session ended too.
      const renew = (refreshToken) => h.run("/token", "POST", new URLSearchParams({
        grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken, resource: RESOURCE,
      }).toString());
      const afterSession = await renew(rotated.refresh_token);
      assert.equal(afterSession.statusCode, 200, "refresh must survive provider session expiry");
      const renewed = JSON.parse(afterSession.body);
      assert.ok(renewed.access_token);
      assert.ok(renewed.refresh_token);
      assert.notEqual(renewed.refresh_token, rotated.refresh_token);
      grantActive = false;
      const afterRevocation = await renew(renewed.refresh_token);
      assert.equal(afterRevocation.statusCode, 400);
      const refused = JSON.parse(afterRevocation.body);
      assert.equal(refused.error, "invalid_grant");
      assert.equal(refused.refresh_token, undefined);
      assert.equal(refused.access_token, undefined);
    });
  }
});

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
                if (prompt === "login") {
                  assert.equal(next.statusCode, 400);
                  assert.equal(JSON.parse(next.body).error, "unsupported_fresh_login");
                } else {
                  assert.equal(next.statusCode, 303);
                  assert.equal(next.getHeader("location"), "https://api.commonswarm.com/auth/v1/authorize");
                }
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

function assertConsentPolicy(response) {
  assert.equal(response.getHeader("content-security-policy"),
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://claude.ai; frame-ancestors 'none'; base-uri 'none'; script-src 'self'; script-src-attr 'none'");
  assert.equal(response.getHeader("referrer-policy"), "same-origin");
}

// Full OAuth boundary: the provider makes interactions and issues/exchanges the
// code; production handlers and InteractionStore own consent. Only DB and the
// lane-2 command transport use in-memory fixtures. No sockets or provider mocks.
test("one workspace consent completes Claude authorization and token exchange", async (t) => {
  for (const contentType of ["application/x-www-form-urlencoded", "application/x-www-form-urlencoded;charset=UTF-8"]) {
    for (const prompt of ["consent", undefined]) {
      for (const home of ["explicit", "omitted"]) {
        for (const priorGrant of ["none", "oidc-only", "resource-only", ...(prompt === "consent" ? ["complete"] : [])]) {
          await t.test(`${contentType}, prompt ${prompt ?? "absent"}, home ${home}, prior grant ${priorGrant}`, async () => {
            const h = await harness();
            const session = await h.completedLogin();
            if (priorGrant !== "none") {
              const grant = new h.provider.Grant({ accountId: USER, clientId: CLIENT });
              if (priorGrant !== "resource-only") grant.addOIDCScope("openid offline_access mcp");
              if (priorGrant !== "oidc-only") grant.addResourceScope(RESOURCE, "mcp");
              session.grantIdFor(CLIENT, await grant.save());
              await session.persist();
            }
            const start = await h.run(authorize(prompt, "openid offline_access mcp"));
            assert.equal(start.statusCode, 303);
            const path = start.getHeader("location");
            const page = await h.run(`${path}?redirect_uri=https://attacker.example/callback`);
            assert.equal(page.statusCode, 200);
            assertConsentPolicy(page);
            const token = /name="csrf_token" value="([^"]+)"/u.exec(page.body)[1];
            const version = /name="selection_version" value="([^"]+)"/u.exec(page.body)[1];
            const form = new URLSearchParams({ csrf_token: token, selection_version: version, workspace_ids: W1 });
            if (home === "explicit") form.set("home_workspace_id", W1);
            const consent = await h.run(`${path}/consent`, "POST", form.toString());
            assert.equal(consent.statusCode, 303, "one valid workspace selection must be accepted");
            const resume = new URL(consent.getHeader("location"));
            assert.match(resume.pathname, /^\/authorize\/[^/]+$/u);
            const finished = await h.run(resume.pathname);
            assert.equal(finished.statusCode, 303);
            const callback = new URL(finished.getHeader("location"), ISSUER);
            assert.equal(callback.origin + callback.pathname, REDIRECT, "resume must issue a code, not another consent prompt");
            assert.equal(callback.searchParams.get("error"), null);
            assert.equal(callback.searchParams.get("state"), STATE);
            assert.equal(callback.searchParams.get("iss"), ISSUER);
            const code = callback.searchParams.get("code");
            assert.ok(code);
            const tokenParameters = {
              grant_type: "authorization_code", client_id: CLIENT, redirect_uri: REDIRECT,
              resource: RESOURCE, code, code_verifier: VERIFIER,
            };
            // Probe rejection with a real, redeemable code, then redeem it below:
            // these errors must precede client auth/grant redemption and never be 500.
            if (contentType === "application/x-www-form-urlencoded" && prompt === "consent" &&
                home === "explicit" && priorGrant === "none") {
              const rejectedJson = await h.run("/token", "POST", JSON.stringify(tokenParameters),
                "application/json", { bufferedBody: true });
              assert.equal(rejectedJson.statusCode, 400);
              assert.equal(JSON.parse(rejectedJson.body).error, "invalid_request");
              assert.match(JSON.parse(rejectedJson.body).error_description,
                /only application\/x-www-form-urlencoded content-type bodies are supported/u);
              for (const route of ["/token", "/health", "/authorize", `${path}/consent`]) {
                // Routes without a body parser reject declared oversized bodies;
                // both readers also enforce the bound for chunked requests.
                for (const chunked of route === "/token" || route.endsWith("/consent") ? [false, true] : [false]) {
                  const oversized = await h.run(route, "POST", "x".repeat(64 * 1024 + 1),
                    contentType, { bufferedBody: true, chunked });
                  assert.equal(oversized.statusCode, 413, `${route}, chunked ${chunked}`);
                  assert.deepEqual(JSON.parse(oversized.body), { error: "request_too_large" });
                }
              }
            }
            const tokenResponse = await h.run("/token", "POST", new URLSearchParams(tokenParameters).toString(),
              contentType, { bufferedBody: true });
            assert.equal(tokenResponse.statusCode, 200, tokenResponse.body);
            const tokens = JSON.parse(tokenResponse.body);
            if (prompt === "consent") assert.ok(tokens.refresh_token);
            assert.ok(tokens.id_token);
            const jwks = JSON.parse((await h.run("/jwks")).body);
            const verified = await jwtVerify(tokens.access_token, createLocalJWKSet(jwks), {
              algorithms: ["ES256"], issuer: ISSUER, audience: RESOURCE,
            });
            assert.equal(verified.payload.sub, USER);
            assert.equal(verified.payload.scope, "mcp");
            const bound = h.interactions.get(path.split("/").at(-1));
            assert.equal(verified.payload.grant_id, bound.provider_grant_id);
            assert.equal(bound.completed, true);
            assert.equal(bound.selection_version, Number(version) + 1);
            assert.ok(bound.consent_token_consumed_at);
            assert.deepEqual(h.commands.map(({ body }) => body.command.kind), [
              "begin_hosted_mcp_grant", "consent_hosted_mcp_workspace", "activate_hosted_mcp_grant",
            ]);
            const begin = h.commands[0];
            assert.equal(begin.identity.userId, USER);
            assert.equal(begin.body.command.home_workspace_id, W1);
            assert.equal(begin.body.command.provider_grant_id, bound.provider_grant_id);
            assert.equal(begin.body.command.grant_id, bound.commonswarm_grant_id);
            assert.equal(begin.body.command.manifest_digest, bound.manifest_digest.toString("hex"));
            const replay = await h.run(`${path}/consent`, "POST", form.toString());
            assert.equal(replay.statusCode, 409);
            assert.match(replay.getHeader("content-type"), /text\/html/u);
            assert.match(replay.body, /Already approved/u);
            assert.equal(await h.provider.Interaction.find(path.split("/").at(-1)), undefined);
            assert.equal(h.commands.length, 3, "the repeat runs no second grant commands");
          });
        }
      }
    }
  }
});

test("consent validation preserves a usable form and rejects non-member workspaces", async (t) => {
  const cases = [
    { name: "multiple workspaces without home", selected: [W1, W2], message: "Choose a home workspace" },
    { name: "no workspace", selected: [], message: "Select at least one workspace" },
    { name: "home outside selection", selected: [W1], home: W2, message: "Choose a home workspace" },
    { name: "non-member workspace", selected: [USER], home: USER, status: 403 },
    { name: "malformed selection version", selected: [W1], home: W1, version: "invalid", message: "Reload the workspace selection" },
  ];
  for (const row of cases) {
    await t.test(row.name, async () => {
      const h = await harness();
      await h.completedLogin();
      const start = await h.run(authorize("consent"));
      const path = start.getHeader("location");
      const page = await h.run(path);
      const token = /name="csrf_token" value="([^"]+)"/u.exec(page.body)[1];
      const version = /name="selection_version" value="([^"]+)"/u.exec(page.body)[1];
      const form = new URLSearchParams({ csrf_token: token, selection_version: row.version ?? version,
        redirect_uri: "https://attacker.example/callback" });
      for (const workspace of row.selected) form.append("workspace_ids", workspace);
      if (row.home) form.set("home_workspace_id", row.home);
      const response = await h.run(`${path}/consent`, "POST", form.toString());
      assert.equal(response.statusCode, row.status ?? 400);
      if (row.message) {
        assert.match(response.getHeader("content-type"), /^text\/html/u);
        assertConsentPolicy(response);
        assert.ok(response.body.includes(row.message));
        assert.match(response.body, /role="alert"/u);
        if (!row.version) assert.ok(response.body.includes(`name="csrf_token" value="${token}"`));
      }
      const bound = h.interactions.get(path.split("/").at(-1));
      assert.equal(bound.selection_version, Number(version));
      assert.equal(bound.consent_token_consumed_at, null);
      assert.equal(h.commands.length, 0);
      // Home validation preserves the original token/version. Malformed
      // versions get a fresh form; both remain usable without granting access.
      const correction = new URLSearchParams({
        csrf_token: row.version ? /name="csrf_token" value="([^"]+)"/u.exec(response.body)[1] : token,
        selection_version: version, workspace_ids: W1, home_workspace_id: W1,
      });
      assert.equal((await h.run(`${path}/consent`, "POST", correction.toString())).statusCode, 303);
      assert.equal((await h.run(`${path}/consent`, "POST", correction.toString())).statusCode, 409);
      assert.equal(h.commands.length, 3);
    });
  }
});

test("consent CSP allows provider-approved native loopback origins", async (t) => {
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
    await t.test(host, async () => {
      const redirectUri = `http://${host}:49152/callback`;
      const h = await harness({ redirectUri, nativeLoopbackEnabled: true });
      await h.completedLogin();
      const start = await h.run(authorize("consent", "openid mcp", redirectUri));
      assert.equal(start.statusCode, 303);
      const page = await h.run(start.getHeader("location"));
      assert.equal(page.statusCode, 200);
      assert.equal(page.getHeader("content-security-policy"),
        `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' http://${host}:49152; frame-ancestors 'none'; base-uri 'none'; script-src 'self'; script-src-attr 'none'`);
    });
  }
  await t.test("web loopback is refused before interaction or consent", async () => {
    const redirectUri = "http://127.0.0.1:49152/callback";
    const h = await harness({ redirectUri });
    const start = await h.run(authorize("consent", "openid mcp", redirectUri));
    assert.equal(start.statusCode, 400);
    assert.equal(h.commands.length, 0);
    assert.equal(h.interactions.size, 0);
  });
});

async function register(h, overrides = {}, options = {}) {
  const response = await h.run("/reg", "POST", JSON.stringify({
    client_name: "Registered <app>", redirect_uris: [REDIRECT],
    grant_types: ["authorization_code", "refresh_token"], ...overrides,
  }), "application/json", options);
  return { response, metadata: String(response.getHeader("content-type")).includes("application/json")
    ? JSON.parse(response.body) : {} };
}

async function registeredHarness(options) {
  const h = await harness(options);
  const result = await register(h);
  assert.equal(result.response.statusCode, 201, result.response.body);
  h.setClient(result.metadata.client_id);
  return { h, clientId: result.metadata.client_id, metadata: result.metadata };
}

test("production startServer gates ordinary DCR and applies configured IP/host limits", async (t) => {
  // Exercise the real composition root and PostgreSQL registration adapter.
  // Only SQL persistence and listen are replaced; no database or socket opens.
  const registrations = new Map();
  t.mock.method(globalThis, "fetch", async () => Response.json({ external: { github: true } }));
  t.mock.method(pg.Pool.prototype, "query", async (sql, values) => {
    if (sql.includes("DELETE FROM commonswarm_oauth.registered_clients")) return { rowCount: 0, rows: [] };
    if (sql.includes("INSERT INTO commonswarm_oauth.registered_clients")) {
      registrations.set(values[0], JSON.parse(values[1]));
      return { rowCount: 1, rows: [] };
    }
    if (sql.includes("SELECT metadata FROM commonswarm_oauth.registered_clients")) {
      const metadata = registrations.get(values[0]);
      return { rowCount: metadata ? 1 : 0, rows: metadata ? [{ metadata }] : [] };
    }
    throw new Error("unexpected DCR fixture SQL");
  });
  t.mock.method(Server.prototype, "listen", function (_port, _host, callback) {
    queueMicrotask(callback);
    return this;
  });
  for (const enabled of [true, false]) {
    const running = await startServer({ config: {
      database: {}, publicAuthorizationEnabled: enabled, issuer: ISSUER, port: 0,
      registrationLimits: { perIp: 2, perHost: 3 },
      maxBodyBytes: 64 * 1024, requestTimeoutMs: 10_000,
      gotrueUrl: "https://api.commonswarm.com/auth/v1", gotrueProvider: "github",
      allowedOrigins: new Set([ISSUER]),
    }, managementCommand: async () => { throw new Error("registration must not activate a hosted grant"); },
    managementWorkspaceReader: async () => [], writeLog: () => {} });
    try {
      const handler = running.server.listeners("request")[0];
      const discovery = exchange("/.well-known/oauth-authorization-server");
      await handler(discovery.request, discovery.response);
      assert.equal(discovery.response.statusCode, 200);
      assert.equal(JSON.parse(discovery.response.body).registration_endpoint, enabled ? `${ISSUER}/reg` : undefined);
      const body = JSON.stringify({ redirect_uris: [REDIRECT] });
      const registration = exchange("/reg", new Map(), body);
      registration.request.method = "POST";
      registration.request.socket.remoteAddress = "203.0.113.10";
      Object.assign(registration.request.headers, { accept: "application/json",
        "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) });
      await handler(registration.request, registration.response);
      assert.equal(registration.response.statusCode, enabled ? 201 : 503, registration.response.body);
      if (enabled) {
        const metadata = JSON.parse(registration.response.body);
        assert.equal(metadata.scope, "openid offline_access mcp");
        assert.ok(await running.provider.Client.find(metadata.client_id));
        for (const [ip, status, reason] of [
          ["203.0.113.10", 201], ["203.0.113.10", 429, "per-ip"],
          ["203.0.113.11", 201], ["203.0.113.12", 429, "per-redirect-host"],
        ]) {
          const attempt = exchange("/reg", new Map(), body);
          attempt.request.method = "POST";
          attempt.request.socket.remoteAddress = ip;
          Object.assign(attempt.request.headers, { accept: "application/json",
            "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) });
          await handler(attempt.request, attempt.response);
          assert.equal(attempt.response.statusCode, status, attempt.response.body);
          if (reason) {
            assert.equal(JSON.parse(attempt.response.body).error_description,
              `registration rate limit exceeded: ${reason}`);
            assert.ok(Number(attempt.response.getHeader("retry-after")) > 0);
          }
        }
      }
      assert.equal(registrations.size, 3);
    } finally {
      running.server.emit("close");
      await running.pool.end();
    }
  }
});

test("DCR registration completes the same workspace consent and PKCE token flow as CIMD", async (t) => {
  const { h, clientId, metadata } = await registeredHarness();
  assert.equal(metadata.token_endpoint_auth_method, "none");
  assert.equal(metadata.scope, "openid offline_access mcp");
  assert.equal(metadata.client_secret, undefined);
  assert.equal(metadata.registration_access_token, undefined);
  assert.equal(metadata.registration_client_uri, undefined);
  assert.equal(metadata.id_token_signed_response_alg, "ES256");
  await t.test("registered client cannot consent to admin despite forged verification and owner approval", async () => {
    const admin = "https://api.commonswarm.com/admin";
    const registeredMetadata = (await h.provider.Client.find(clientId)).metadata();
    const verification = { client_id: clientId, active: true, withdrawn_at: null, verification_version: 1,
      registration_source: "cimd", application_type: "web", metadata_digest: adminDigest(registeredMetadata),
      redirect_uris: [REDIRECT], scope_ceiling: ["admin:read"], publisher_identity: "Forged publisher",
      publisher_contact: "forged.example", review_evidence_ref: "forged-review", pkce_s256_tested: true,
      dpop_tested: true, redirect_tested: true, origin_control_verified: true,
      delegation_eligible: false, native_loopback_eligible: false };
    const approval = { owner_user_id: USER, client_id: clientId, verification_version: 1,
      withdrawn_at: null, approval_event_id: "forged-event", approval_command_id: "forged-command" };
    const queries = [];
    const tx = { release() {}, async query(sql, values) {
      queries.push(sql);
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [], rowCount: 0 };
      let row;
      if (sql.trimStart().startsWith("SELECT") && sql.includes("FROM commonswarm_oauth.browser_sessions")) {
        row = { user_id: USER, authenticated_at: new Date().toISOString() };
      } else if (sql.includes("FROM commonswarm_oauth.admin_verified_clients")) {
        assert.equal(values[0], clientId); row = verification;
      } else if (sql.includes("FROM commonswarm_oauth.admin_client_owner_approvals")) {
        assert.deepEqual(values, [USER, clientId, 1]); row = approval;
      } else if (sql.includes("FROM commonswarm_oauth.registered_clients")) {
        row = await h.provider.Client.adapter.find(values[0]) ? { exists: 1 } : undefined;
      } else throw new Error("admin DCR refusal must precede receipt or authority writes");
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    } };
    const clientLookup = t.mock.method(h.provider.Client, "find");
    try {
      const service = createAdminConsentService({ provider: h.provider,
        store: new PostgresAdminConsentStore({ connect: async () => tx }) });
      await assert.rejects(service.select({ uid: "dcr-admin", sessionId: BROWSER, ownerUserId: USER,
        csrfToken: "synthetic-admin-csrf-token", version: 0, params: { client_id: clientId,
          redirect_uri: REDIRECT, resource: admin, scope: "openid admin:read",
          code_challenge: "a".repeat(43), code_challenge_method: "S256", dpop_jkt: "b".repeat(43) } },
      { mode: "granular", scope_names: ["admin:read"], workspace_ids: [] }), { code: "unauthorized_client" });
      assert.ok(queries.some(sql => sql.includes("FROM commonswarm_oauth.registered_clients")));
      assert.equal(queries.at(-1), "ROLLBACK");
      assert.equal(clientLookup.mock.callCount(), 0, "registration provenance refuses before metadata lookup");
      assert.equal(h.commands.length, 0);
      assert.equal(h.interactions.size, 0);
    } finally { clientLookup.mock.restore(); }
  });
  const originalExpiry = (await h.provider.Client.adapter.list())[0].expires_at;
  t.mock.timers.enable({ apis: ["Date"], now: originalExpiry - 29 * 24 * 60 * 60 * 1000 });
  await h.completedLogin();
  const start = await h.run(authorize("consent", "openid offline_access mcp", REDIRECT, clientId));
  const path = start.getHeader("location");
  const page = await h.run(path);
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /Unverified app/u);
  assert.match(page.body, /Choose workspaces for claude\.ai/u);
  assert.match(page.body, /calls itself &ldquo;Registered &lt;app&gt;&rdquo;/u);
  assert.doesNotMatch(page.body, /<h1>Choose workspaces for Registered/u);
  assertConsentPolicy(page);
  const form = new URLSearchParams({
    csrf_token: /name="csrf_token" value="([^"]+)"/u.exec(page.body)[1],
    selection_version: /name="selection_version" value="([^"]+)"/u.exec(page.body)[1],
    workspace_ids: W1,
  });
  const consent = await h.run(`${path}/consent`, "POST", form.toString());
  assert.equal(consent.statusCode, 303, consent.body);
  const finished = await h.run(new URL(consent.getHeader("location")).pathname);
  const callback = new URL(finished.getHeader("location"));
  assert.equal(callback.origin + callback.pathname, REDIRECT);
  assert.equal(callback.searchParams.get("state"), STATE);
  const parameters = { grant_type: "authorization_code", client_id: clientId, redirect_uri: REDIRECT,
    resource: RESOURCE, code: callback.searchParams.get("code"), code_verifier: VERIFIER };
  assert.ok(parameters.code);
  const badVerifier = await h.run("/token", "POST", new URLSearchParams({ ...parameters,
    code_verifier: "wrong-verifier-with-more-than-forty-three-characters" }).toString());
  assert.equal(badVerifier.statusCode, 400);
  assert.equal(JSON.parse(badVerifier.body).error, "invalid_grant");
  const response = await h.run("/token", "POST", new URLSearchParams(parameters).toString(),
    "application/x-www-form-urlencoded", { bufferedBody: true });
  assert.equal(response.statusCode, 200, response.body);
  const tokens = JSON.parse(response.body);
  assert.ok(tokens.refresh_token);
  assert.ok(tokens.id_token);
  const escalation = await h.run("/token", "POST", new URLSearchParams({
    grant_type: "refresh_token", client_id: clientId, refresh_token: tokens.refresh_token,
    resource: RESOURCE, scope: "openid mcp admin",
  }).toString());
  assert.equal(escalation.statusCode, 400);
  assert.equal(JSON.parse(escalation.body).error, "invalid_scope");
  const refresh = await h.run("/token", "POST", new URLSearchParams({
    grant_type: "refresh_token", client_id: clientId, refresh_token: tokens.refresh_token,
    resource: RESOURCE,
  }).toString());
  assert.equal(refresh.statusCode, 200, refresh.body);
  const jwks = JSON.parse((await h.run("/jwks")).body);
  const verified = await jwtVerify(tokens.access_token, createLocalJWKSet(jwks), {
    algorithms: ["ES256"], issuer: ISSUER, audience: RESOURCE,
  });
  assert.equal(verified.payload.scope, "mcp");
  const bound = h.interactions.get(path.split("/").at(-1));
  assert.equal(verified.payload.grant_id, bound.provider_grant_id);
  assert.equal(bound.client_id, clientId);
  assert.equal(bound.completed, true);
  assert.deepEqual(h.commands.map(({ body }) => body.command.kind), [
    "begin_hosted_mcp_grant", "consent_hosted_mcp_workspace", "activate_hosted_mcp_grant",
  ]);
  assert.equal(h.commands[0].identity.userId, USER);
  assert.equal(h.commands[0].body.command.client_id, clientId);
  const listing = await h.provider.Client.adapter.list();
  assert.equal(listing.length, 1);
  assert.ok(listing[0].last_used_at);
  assert.equal(listing[0].expires_at, originalExpiry + 24 * 60 * 60 * 1000);
});

test("DCR refuses IP and redirect-host floods, including host reuse across ports", async (t) => {
  for (const kind of ["ip", "host"]) {
    await t.test(kind, async (t) => {
      t.mock.method(Date, "now", () => 1_800_000_000_000);
      const { h } = await registeredHarness();
      const limit = kind === "ip" ? 60 : 300;
      for (let i = 1; i < limit; i += 1) {
        const { response } = await register(h, {
          redirect_uris: [kind === "ip" ? `https://host${i}.example/callback` : `https://claude.ai:${4000+i}/callback`],
        }, { ip: kind === "ip" ? "203.0.113.10" : `203.0.113.${i+10}` });
        assert.equal(response.statusCode, 201, response.body);
      }
      const refused = await register(h, { redirect_uris: [kind === "ip" ? "https://other.example/callback" : REDIRECT] },
        { ip: kind === "ip" ? "203.0.113.10" : "203.0.113.200" });
      assert.equal(refused.response.statusCode, 429);
      assert.equal(refused.response.getHeader("retry-after"), "3600");
      assert.equal(refused.metadata.error, "invalid_request");
      assert.equal(refused.metadata.error_description,
        `registration rate limit exceeded: ${kind === "ip" ? "per-ip" : "per-redirect-host"}`);
      assert.equal((await h.provider.Client.adapter.list()).length, limit);
    });
  }
});

test("DCR rejected bodies release quota before the next registration", async () => {
  const h = await harness();
  for (let i = 0; i < 61; i += 1) {
    const bad = await register(h, { response_types: ["token"] });
    assert.equal(bad.response.statusCode, 400, bad.response.body);
    assert.equal(bad.metadata.error, "invalid_client_metadata");
  }
  const good = await register(h);
  assert.equal(good.response.statusCode, 201, good.response.body);
  assert.equal(good.metadata.token_endpoint_auth_method, "none");
  assert.equal(good.metadata.client_secret, undefined);
  assert.equal((await h.provider.Client.adapter.list()).length, 1);
});

test("DCR public-client refusal precedes reservation even at exhausted quota", async () => {
  const h = await harness();
  for (let i = 0; i < 60; i += 1) assert.equal((await register(h)).response.statusCode, 201);
  const confidential = await register(h, { token_endpoint_auth_method: "client_secret_basic" });
  assert.equal(confidential.response.statusCode, 400);
  assert.equal(confidential.metadata.error_description, "only public clients are supported");
});

test("DCR Retry-After uses the latest exhausted window, ignoring unexhausted buckets", async (t) => {
  const { createRegistrationLimiter } = await import("../src/registration.js");
  let now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  const h = await harness({ registrationLimiter: createRegistrationLimiter({ perIp: 2, perHost: 2 }) });
  const old = "https://old.example/callback", newer = "https://new.example/callback";
  assert.equal((await register(h, { redirect_uris: [old] }, { ip: "203.0.113.1" })).response.statusCode, 201);
  now += 20_000;
  assert.equal((await register(h, { redirect_uris: [old, newer] }, { ip: "203.0.113.2" })).response.statusCode, 201);
  assert.equal((await register(h, { redirect_uris: [newer] }, { ip: "203.0.113.2" })).response.statusCode, 201);
  const all = await register(h, { redirect_uris: [old, newer] }, { ip: "203.0.113.2" });
  assert.equal(all.response.statusCode, 429);
  assert.equal(all.response.getHeader("retry-after"), "3600");
  assert.equal(all.metadata.error_description, "registration rate limit exceeded: per-ip, per-redirect-host");
  const ipOnly = await register(h, { redirect_uris: ["https://fresh.example/callback"] }, { ip: "203.0.113.2" });
  assert.equal(ipOnly.response.statusCode, 429);
  assert.equal(ipOnly.response.getHeader("retry-after"), "3600");
  assert.equal(ipOnly.metadata.error_description, "registration rate limit exceeded: per-ip");
  const hostsOnly = await register(h, { redirect_uris: [old, newer] }, { ip: "203.0.113.1" });
  assert.equal(hostsOnly.response.statusCode, 429);
  assert.equal(hostsOnly.response.getHeader("retry-after"), "3600");
  assert.equal(hostsOnly.metadata.error_description, "registration rate limit exceeded: per-redirect-host");
});

test("DCR concurrent in-flight writes reserve quota and failed writes release it", async (t) => {
  for (const [kind, limit] of [["per-ip", 10], ["per-redirect-host", 30]]) {
    await t.test(kind, async (t) => {
      const h = await harness({ registrationLimiter: createRegistrationLimiter({ perIp: 10, perHost: 30 }) });
      const store = h.provider.Client.adapter;
      const upsert = store.upsert.bind(store);
      let resume;
      const held = new Promise(resolve => { resume = resolve; });
      let allStarted;
      const started = new Promise(resolve => { allStarted = resolve; });
      let writes = 0;
      t.mock.method(store, "upsert", async (id, metadata) => {
        const ordinal = ++writes;
        if (writes === limit) allStarted();
        await held;
        if (ordinal === 1) throw new Error("synthetic registration storage failure");
        return upsert(id, metadata);
      });
      const options = i => ({ ip: kind === "per-ip" ? "203.0.113.10" : `203.0.113.${i + 10}` });
      const pending = Array.from({ length: limit }, (_, i) => register(h, {}, options(i)));
      try {
        await started;
        const extra = await register(h, {}, options(limit));
        assert.equal(extra.response.statusCode, 429);
        assert.equal(extra.metadata.error_description, `registration rate limit exceeded: ${kind}`);
        assert.equal(writes, limit, "an over-limit concurrent request must not reach storage");
      } finally {
        resume();
      }
      const results = await Promise.all(pending);
      assert.equal(results.filter(result => result.response.statusCode === 201).length, limit - 1);
      assert.equal(results.filter(result => result.response.statusCode === 500).length, 1);
      assert.equal((await register(h, {}, options(limit))).response.statusCode, 201,
        "a failed storage write releases its reservation");
      assert.equal((await register(h, {}, options(limit + 1))).response.statusCode, 429);
      assert.equal((await store.list()).length, limit);
    });
  }
});

test("DCR socket disconnects during storage keep successful IP and host reservations", async (t) => {
  const { createMemoryRegistrationStore, createRegistrationLimiter } = await import("../src/registration.js");
  for (const kind of ["per-ip", "per-redirect-host"]) {
    await t.test(kind, { timeout: 10_000 }, async (t) => {
      const store = createMemoryRegistrationStore();
      const upsert = store.upsert.bind(store);
      let writeStarted, releaseWrite;
      store.upsert = async (id, metadata) => {
        const held = new Promise(resolve => { releaseWrite = resolve; });
        writeStarted();
        await held;
        return upsert(id, metadata);
      };
      const provider = await createMcpProvider({ registrationStore: store,
        registrationLimiter: createRegistrationLimiter(kind === "per-ip"
          ? { perIp: 2, perHost: 100 } : { perIp: 100, perHost: 2 }) });
      const callback = provider.callback();
      let responseClosed;
      const server = createServer((request, response) => {
        response.once("close", () => responseClosed?.());
        callback(request, response);
      });
      t.after(async () => {
        releaseWrite?.();
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      });
      await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
      const port = server.address().port;
      const body = JSON.stringify({ redirect_uris: ["https://flood.example/cb"] });
      const raw = `POST /reg HTTP/1.1\r\nHost: localhost\r\nX-Forwarded-Proto: https\r\n` +
        `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
      for (const mode of ["end", "destroy"]) {
        const started = new Promise(resolve => { writeStarted = resolve; });
        const closed = new Promise(resolve => { responseClosed = resolve; });
        const stored = new Promise(resolve => provider.once("registration_create.success", resolve));
        const socket = connect(port, "127.0.0.1", () => socket.write(raw));
        t.after(() => socket.destroy());
        await started;
        // The INSERT is pending when the server observes the disconnected peer.
        if (mode === "end") socket.end();
        else socket.destroy();
        await closed;
        releaseWrite();
        await stored;
      }
      // If a reservation was refunded, let the extra write finish too: the
      // persistent count, rather than only the response status, proves the cap.
      store.upsert = upsert;
      const response = await fetch(`http://127.0.0.1:${port}/reg`, { method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-proto": "https" }, body });
      const metadata = await response.json();
      assert.equal((await store.list()).length, 2, "disconnected successful writes still consume quota");
      assert.equal(response.status, 429);
      assert.equal(metadata.error_description, `registration rate limit exceeded: ${kind}`);
    });
  }
});

test("DCR refuses branded private-use and HTTPS mixed callbacks with loopback on or off", async (t) => {
  for (const nativeLoopbackEnabled of [false, true]) {
    for (const application_type of [undefined, "web", "native"]) {
      for (const [brand, body] of [
        ["Cursor", { client_name: "Cursor (cursor.com)", client_uri: "https://cursor.com",
          redirect_uris: ["cursor://x/cb", "https://attacker.example/cb"] }],
        ["Google", { client_name: "accounts.google.com", client_uri: "https://google.com",
          redirect_uris: ["com.google.x:/cb", "https://attacker.example/cb"] }],
      ]) {
        await t.test(`${brand}, loopback ${nativeLoopbackEnabled}, type ${application_type ?? "omitted"}`, async () => {
          const h = await harness({ nativeLoopbackEnabled });
          const refused = await register(h, { ...body, application_type });
          assert.equal(refused.response.statusCode, 400, refused.response.body);
          assert.equal(refused.metadata.error, "invalid_client_metadata");
          assert.equal((await h.provider.Client.adapter.list()).length, 0);
          const good = await register(h, { client_name: "Cursor", client_uri: "https://cursor.com",
            redirect_uris: ["cursor://x/cb"] });
          assert.equal(good.response.statusCode, 201, good.response.body);
          assert.equal(good.metadata.application_type, "native");
        });
      }
    }
  }
});

test("DCR accepts Cursor and dotted native redirects while preserving web and branding policy", async (t) => {
  for (const [name, metadata, applicationType] of [
    ["Cursor omitted type", { client_name: "Cursor", redirect_uris: ["cursor://anysphere.cursor-retrieval/oauth/user-server/callback"] }, "native"],
    ["Cursor web type and website", { application_type: "web", client_name: "cursor.com", client_uri: "https://cursor.com",
      redirect_uris: ["cursor://anysphere.cursor-retrieval/oauth/user-server/callback"] }, "native"],
    ["Cursor explicit native", { application_type: "native", client_name: "Cursor", client_uri: "https://cursor.com",
      redirect_uris: ["cursor://anysphere.cursor-retrieval/oauth/user-server/callback"] }, "native"],
    ["dotted scheme", { client_name: "App", redirect_uris: ["com.example.app:/oauth/callback"] }, "native"],
    ["dotted scheme branding", { client_name: "example.com", client_uri: "https://example.com",
      redirect_uris: ["com.example.app:/oauth/callback"] }, "native"],
    ["HTTPS web", { application_type: "web", client_name: "claude.ai", client_uri: "https://claude.ai" }, "web"],
  ]) {
    await t.test(name, async () => {
      const h = await harness();
      const result = await register(h, metadata);
      assert.equal(result.response.statusCode, 201, result.response.body);
      assert.equal(result.metadata.application_type, applicationType);
      assert.equal(result.metadata.token_endpoint_auth_method, "none");
      const stored = await h.provider.Client.find(result.metadata.client_id);
      assert.deepEqual(stored.redirectUris, result.metadata.redirect_uris);
    });
  }
  await t.test("private callbacks cannot claim unrelated DNS brands", async () => {
    const h = await harness();
    for (const overrides of [
      { client_uri: "https://evil.example" }, { client_name: "claude.ai" },
      { client_name: "anysphere.cursor-retrieval" }, { logo_uri: "https://cursor.com/logo.png" },
    ]) {
      const result = await register(h, { redirect_uris: ["cursor://anysphere.cursor-retrieval/callback"], ...overrides });
      assert.equal(result.response.statusCode, 400, result.response.body);
      assert.equal(result.metadata.error, "invalid_client_metadata");
    }
    assert.equal((await register(h, { client_name: "Cursor", client_uri: "https://cursor.com",
      redirect_uris: ["cursor://anysphere.cursor-retrieval/callback"] })).response.statusCode, 201);
  });
});

test("DCR infers native for all-loopback Inspector callbacks only when enabled", async (t) => {
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
    for (const application_type of [undefined, "web"]) {
      await t.test(`${host} ${application_type ?? "omitted"}`, async () => {
        const body = { client_name: "MCP Inspector", application_type,
          redirect_uris: [`http://${host}:6274/oauth/callback`] };
        const h = await harness({ nativeLoopbackEnabled: true });
        const accepted = await register(h, body);
        assert.equal(accepted.response.statusCode, 201, accepted.response.body);
        assert.equal(accepted.metadata.application_type, "native");
        assert.equal(accepted.metadata.token_endpoint_auth_method, "none");
        assert.equal((await register(await harness(), body)).response.statusCode, 400);
        const mixed = await register(h, { ...body, redirect_uris: [...body.redirect_uris, REDIRECT] });
        assert.equal(mixed.response.statusCode, 400, "mixed web/loopback callbacks keep the web policy");
        assert.equal(mixed.metadata.error, "invalid_client_metadata");
      });
    }
  }
  const all = await register(await harness({ nativeLoopbackEnabled: true }), {
    redirect_uris: ["http://localhost/oauth/callback", "http://127.0.0.1:1/oauth/callback", "http://[::1]:65535/oauth/callback"],
  });
  assert.equal(all.response.statusCode, 201, all.response.body);
  assert.equal(all.metadata.application_type, "native");
});

test("DCR loopback and private-use callbacks have only per-IP quota", async (t) => {
  for (const uri of ["http://localhost:6274/oauth/callback", "http://127.0.0.1:6274/oauth/callback",
    "http://[::1]:6274/oauth/callback", "cursor://anysphere.cursor-retrieval/oauth/user-commonswarm/callback",
    "com.example.app:/oauth/callback"]) {
    await t.test(uri, async () => {
      const h = await harness({ nativeLoopbackEnabled: true,
        registrationLimiter: createRegistrationLimiter({ perIp: 10, perHost: 30 }) });
      const body = { redirect_uris: [uri] };
      for (let i = 0; i < 31; i++) {
        const result = await register(h, body, { ip: `203.0.113.${10 + i % 4}` });
        assert.equal(result.response.statusCode, 201, `registration ${i + 1}: ${result.response.body}`);
      }
      // The first IP has eight successes above; its tenth succeeds, eleventh fails.
      for (let i = 0; i < 2; i++) assert.equal((await register(h, body)).response.statusCode, 201);
      const denied = await register(h, body);
      assert.equal(denied.response.statusCode, 429);
      assert.match(denied.metadata.error_description, /per-ip/u);
      assert.doesNotMatch(denied.metadata.error_description, /per-redirect-host/u);
      assert.equal((await h.provider.Client.adapter.list()).length, 33);
    });
  }
});

test("registered native callbacks complete consent, Connected, finish and provider redirect", async (t) => {
  for (const redirectUri of ["cursor://anysphere.cursor-retrieval/oauth/user-commonswarm/callback",
    "com.example.app:/oauth/callback", "http://localhost:6274/oauth/callback",
    "http://127.0.0.1:6274/oauth/callback", "http://[::1]:6274/oauth/callback"]) {
    await t.test(redirectUri, async () => {
      const h = await harness({ redirectUri, nativeLoopbackEnabled: true, finishEnabled: true });
      const registration = await register(h, { redirect_uris: [redirectUri] });
      assert.equal(registration.response.statusCode, 201, registration.response.body);
      const clientId = registration.metadata.client_id;
      h.setClient(clientId);
      const noPkce = new URL(authorize("consent", "openid mcp", redirectUri, clientId), ISSUER);
      noPkce.searchParams.delete("code_challenge");
      noPkce.searchParams.delete("code_challenge_method");
      const pkceRequired = await h.run(noPkce.pathname + noPkce.search);
      assert.equal(pkceRequired.statusCode, 303);
      assert.equal(new URL(pkceRequired.getHeader("location")).searchParams.get("error"), "invalid_request");
      await h.completedLogin();
      const unregistered = await h.run(authorize("consent", "openid mcp", "com.attacker.app:/callback", clientId));
      assert.equal(unregistered.statusCode, 400);
      const start = await h.run(authorize("consent", "openid mcp", redirectUri, clientId));
      assert.equal(start.statusCode, 303);
      const path = start.getHeader("location");
      const page = await h.run(path);
      assert.equal(page.statusCode, 200, page.body);
      const target = new URL(redirectUri);
      if (!target.hostname && !["http:", "https:"].includes(target.protocol)) {
        assert.match(page.body, /Choose workspaces for an app on this device \(com\.example\.app:\)/u);
        assert.match(page.body, /After you approve, you return to <strong>an app on this device \(com\.example\.app:\)<\/strong>/u);
      }
      const source = target.protocol === "http:" ? target.origin : target.protocol;
      assert.equal(page.getHeader("content-security-policy"),
        `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${source}; frame-ancestors 'none'; base-uri 'none'; script-src 'self'; script-src-attr 'none'`);
      assert.equal(page.getHeader("cache-control"), "no-store");
      assert.equal(page.getHeader("referrer-policy"), "same-origin");
      assert.equal(page.getHeader("x-content-type-options"), "nosniff");
      const form = new URLSearchParams({
        csrf_token: /name="csrf_token" value="([^"]+)"/u.exec(page.body)[1],
        selection_version: /name="selection_version" value="([^"]+)"/u.exec(page.body)[1],
        workspace_ids: W1, home_workspace_id: W1,
      });
      const consent = await h.run(`${path}/consent`, "POST", form.toString());
      assert.equal(consent.statusCode, 303, consent.body);
      assert.equal(consent.getHeader("location"), `${path}/connected`);
      const connected = await h.run(consent.getHeader("location"));
      assert.equal(connected.statusCode, 200, connected.body);
      assert.match(connected.body, /Connected/u);
      assert.match(connected.getHeader("content-security-policy"), /form-action 'none'/u);
      const finish = await h.run(`${path}/finish`);
      assert.equal(finish.statusCode, 303, finish.body);
      const resume = new URL(finish.getHeader("location"));
      assert.equal(resume.origin, ISSUER);
      assert.equal(resume.search, "");
      const final = await h.run(resume.pathname);
      assert.equal(final.statusCode, 303, final.body);
      const callback = new URL(final.getHeader("location"));
      assert.ok(callback.searchParams.get("code"));
      assert.equal(callback.searchParams.get("state"), STATE);
      assert.equal(callback.searchParams.get("iss"), ISSUER);
      callback.search = "";
      assert.equal(callback.href, redirectUri);
    });
  }
});

test("DCR rejects unknown and dangerous schemes, userinfo, fragments and non-loopback HTTP", async () => {
  const h = await harness({ nativeLoopbackEnabled: true });
  for (const uri of [
    "unknown:/callback", "javascript:alert(1)", "vbscript:msgbox(1)", "data:text/plain,callback",
    "file:///callback", "blob:https://client.example/callback", "about:blank",
    "http://client.example/callback", "http://127.0.0.2/callback",
    "cursor://user:pass@anysphere.cursor-retrieval/callback", "cursor://anysphere.cursor-retrieval/callback#fragment",
    "com.example.app:/callback#fragment", "com.example.app://user:pass@callback/path",
  ]) {
    const result = await register(h, { application_type: "native", redirect_uris: [uri] });
    assert.equal(result.response.statusCode, 400, uri);
    assert.equal(result.metadata.error, "invalid_client_metadata", uri);
  }
  assert.equal((await register(h, { application_type: "native",
    redirect_uris: ["http://127.0.0.1:49152/callback"] })).response.statusCode, 201);
  assert.equal((await h.provider.Client.adapter.list()).length, 1);
});

test("DCR per-host rate limit keys on the registrable domain, not subdomains", async (t) => {
  await t.test("sibling subdomains share one bucket", async () => {
    const { h } = await registeredHarness({
      registrationLimiter: createRegistrationLimiter({ perIp: 10, perHost: 30 }) });
    for (let i = 1; i <= 30; i += 1) {
      const { response } = await register(h, {
        redirect_uris: [`https://a${i}.evil.com/callback`],
      }, { ip: `203.0.113.${i + 10}` });
      assert.equal(response.statusCode, 201, response.body);
    }
    const refused = await register(h, { redirect_uris: ["https://b.evil.com/callback"] }, { ip: "203.0.113.200" });
    assert.equal(refused.response.statusCode, 429);
    assert.equal((await h.provider.Client.adapter.list()).length, 31);
  });
  await t.test("distinct registrable domains stay separate", async () => {
    const { h } = await registeredHarness();
    const first = await register(h, { redirect_uris: ["https://foo.co.uk/callback"] }, { ip: "203.0.113.30" });
    const second = await register(h, { redirect_uris: ["https://bar.co.uk/callback"] }, { ip: "203.0.113.31" });
    assert.equal(first.response.statusCode, 201);
    assert.equal(second.response.statusCode, 201);
    assert.equal((await h.provider.Client.adapter.list()).length, 3);
  });
});

test("DCR registration rejects impersonating client_name and logo_uri", async () => {
  const h = await harness();
  const phishing = await register(h, {
    client_name: "claude.ai",
    redirect_uris: ["https://evil.example/callback"],
  });
  assert.equal(phishing.response.statusCode, 400);
  assert.equal(phishing.metadata.error, "invalid_client_metadata");
  const logo = await register(h, {
    client_name: "Honest app",
    logo_uri: "https://evil.example/logo.png",
    redirect_uris: ["https://evil.example/callback"],
  }, { ip: "203.0.113.40" });
  assert.equal(logo.response.statusCode, 400);
  assert.equal(logo.metadata.error, "invalid_client_metadata");
  assert.equal((await h.provider.Client.adapter.list()).length, 0);
});

test("CIMD Claude consent still labels the verified metadata host", async () => {
  const h = await harness();
  await h.completedLogin();
  const start = await h.run(authorize("consent"));
  const page = await h.run(start.getHeader("location"));
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /Choose workspaces for claude\.ai/u);
  assert.doesNotMatch(page.body, /Unverified app/u);
  assert.match(page.body, /Client: <strong>claude\.ai<\/strong>/u);
});

test("DCR rejects scope escalation, confidential auth and unsafe web redirects before storing", async () => {
  const { h, clientId } = await registeredHarness();
  for (const overrides of [
    { scope: "openid mcp admin" }, { token_endpoint_auth_method: "client_secret_basic" },
    { grant_types: ["client_credentials"] }, { response_types: ["token"] },
    { redirect_uris: ["http://public.example/callback"] },
    { redirect_uris: ["http://127.0.0.1:4444/callback"] },
    { redirect_uris: ["https://user:pass@public.example/callback"] },
    { redirect_uris: ["https://public.example/callback#fragment"] },
    { application_type: "native", redirect_uris: ["http://127.0.0.1:4444/callback"] },
  ]) {
    const { response, metadata } = await register(h, overrides, { ip: "203.0.113.20" });
    assert.equal(response.statusCode, 400, JSON.stringify(overrides));
    assert.equal(metadata.error, "invalid_client_metadata");
  }
  const escalation = await h.run(authorize("consent", "openid mcp admin", REDIRECT, clientId));
  assert.equal(escalation.statusCode, 400);
  assert.equal(JSON.parse(escalation.body).error, "invalid_scope");
  const plain = new URL(authorize("consent", "openid mcp", REDIRECT, clientId), ISSUER);
  plain.searchParams.set("code_challenge_method", "plain");
  const pkce = await h.run(plain.pathname + plain.search);
  assert.notEqual(pkce.statusCode, 500);
  assert.equal(new URL(pkce.getHeader("location")).searchParams.get("error"), "invalid_request");
  assert.equal((await h.provider.Client.adapter.list()).length, 1);
  assert.equal(h.commands.length, 0);
});

test("DCR limiter refuses new keys at capacity and admits them after its window expires", async (t) => {
  // First reach real registration; main's missing endpoint must fail here.
  await registeredHarness();
  const { createRegistrationLimiter } = await import("../src/registration.js");
  const h = await harness({ registrationLimiter: createRegistrationLimiter({ maxKeys: 2 }) });
  const first = await register(h);
  assert.equal(first.response.statusCode, 201);
  const refused = await register(h, { redirect_uris: ["https://other.example/callback"] }, { ip: "203.0.113.90" });
  assert.equal(refused.response.statusCode, 429);
  assert.equal((await h.provider.Client.adapter.list()).length, 1);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 60 * 60 * 1000 });
  const admitted = await register(h, { redirect_uris: ["https://other.example/callback"] }, { ip: "203.0.113.90" });
  assert.equal(admitted.response.statusCode, 201, admitted.response.body);
});

test("DCR native loopback obeys the configured exception and exact callback path", async () => {
  const redirectUri = "http://127.0.0.1:49152/callback";
  const h = await harness({ redirectUri, nativeLoopbackEnabled: true });
  const { response, metadata } = await register(h, { application_type: "native", redirect_uris: [redirectUri] });
  assert.equal(response.statusCode, 201, response.body);
  h.setClient(metadata.client_id);
  await h.completedLogin();
  const pageStart = await h.run(authorize("consent", "openid mcp", redirectUri, metadata.client_id));
  const page = await h.run(pageStart.getHeader("location"));
  assert.equal(page.statusCode, 200);
  assert.ok(page.getHeader("content-security-policy").includes("http://127.0.0.1:49152"));
  const invalid = await h.run(authorize("consent", "openid mcp", "http://127.0.0.1:49152/wrong", metadata.client_id));
  assert.equal(invalid.statusCode, 400);
});

test("DCR unused registrations expire and are deleted at 30 days, without expiry renewal on reads", async (t) => {
  const { h, clientId } = await registeredHarness();
  const rows = await h.provider.Client.adapter.list();
  assert.equal(rows[0].client_id, clientId);
  assert.equal(rows[0].last_used_at, null);
  const expiration = rows[0].expires_at;
  t.mock.timers.enable({ apis: ["Date"], now: expiration - 1 });
  assert.ok(await h.provider.Client.find(clientId));
  assert.equal((await h.provider.Client.adapter.list())[0].expires_at, expiration);
  t.mock.timers.tick(1);
  assert.equal(await h.provider.Client.adapter.cleanup(), 1);
  assert.equal(await h.provider.Client.find(clientId), undefined);
  assert.deepEqual(await h.provider.Client.adapter.list(), []);
  const response = await h.run(authorize("consent", "openid mcp", REDIRECT, clientId));
  assert.equal(response.statusCode, 400);
  assert.equal(h.commands.length, 0);
});

test("discovery advertises only routed endpoints, PAR is absent and registration follows its feature", async () => {
  const h = await harness();
  for (const discovery of ["/.well-known/openid-configuration", "/.well-known/oauth-authorization-server"]) {
    const response = await h.run(discovery);
    assert.equal(response.statusCode, 200);
    const metadata = JSON.parse(response.body);
    const endpoints = Object.fromEntries(Object.entries(metadata).filter(([key]) => key.endsWith("_endpoint") || key === "jwks_uri"));
    assert.deepEqual(endpoints, {
      authorization_endpoint: `${ISSUER}/authorize`, end_session_endpoint: `${ISSUER}/session/end`,
      jwks_uri: `${ISSUER}/jwks`, registration_endpoint: `${ISSUER}/reg`,
      token_endpoint: `${ISSUER}/token`, userinfo_endpoint: `${ISSUER}/me`,
    });
    assert.equal(metadata.pushed_authorization_request_endpoint, undefined);
    assert.equal(metadata.client_id_metadata_document_supported, true);
  }
  const disabled = await harness({ registrationEnabled: false });
  const metadata = JSON.parse((await disabled.run("/.well-known/openid-configuration")).body);
  assert.equal(metadata.registration_endpoint, undefined);
  assert.equal((await register(disabled)).response.statusCode, 404);
  assert.equal((await h.run("/request", "POST", "")).statusCode, 404);
});

test("routed userinfo checks bearer scope and end_session completes its confirmation flow", async () => {
  const { h, clientId } = await registeredHarness();
  await h.completedLogin();
  // Userinfo requires an OIDC token, independently of the mcp resource token.
  // Real provider storage/claims/grant validation run, with no userinfo mock.
  const client = await h.provider.Client.find(clientId);
  const grant = new h.provider.Grant({ accountId: USER, clientId });
  grant.addOIDCScope("openid");
  const grantId = await grant.save();
  const access = new h.provider.AccessToken({ accountId: USER, client, scope: "openid", grantId });
  const token = await access.save();
  assert.equal((await h.run("/me")).statusCode, 401);
  const me = await h.run("/me", "GET", "", undefined, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(me.statusCode, 200, me.body);
  assert.deepEqual(JSON.parse(me.body), { sub: USER });
  const post = await h.run("/me", "POST", new URLSearchParams({ access_token: token }).toString());
  assert.equal(post.statusCode, 200, post.body);
  const logout = await h.run(`/session/end?client_id=${clientId}`);
  assert.equal(logout.statusCode, 200);
  assert.ok(logout.body.includes(`${ISSUER}/session/end/confirm`));
  const xsrf = /name="xsrf" value="([^"]+)"/u.exec(logout.body)[1];
  const confirmed = await h.run("/session/end/confirm", "POST", new URLSearchParams({ xsrf, logout: "yes" }).toString());
  assert.equal(confirmed.statusCode, 303, confirmed.body);
  const success = await h.run(new URL(confirmed.getHeader("location")).pathname);
  assert.equal(success.statusCode, 200);
});
