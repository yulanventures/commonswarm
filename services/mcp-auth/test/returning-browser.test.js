import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";

import { hashOpaque, SESSION_COOKIE } from "../src/browser-security.js";
import { InteractionStore } from "../src/interaction-store.js";
import { createInteractionHandler } from "../src/interactions.js";
import { createLogger } from "../src/logger.js";
import { createAtomicMemoryAdapter } from "../src/memory-adapter.js";
import { createMcpProvider, ISSUER, RESOURCE } from "../src/provider.js";
import { createHandler } from "../src/server.js";

const USER = "10000000-0000-4000-8000-000000000001";
const WORKSPACE = "20000000-0000-4000-8000-000000000001";
const SESSION_A = "browser-session-A-long-enough";
const SESSION_B = "browser-session-B-long-enough";
const RESTART = "This connection attempt expired or was opened in another window. Start the connection again from your app.";

function responseCapture() {
  return {
    headers: {}, statusCode: 200, headersSent: false, body: "",
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    getHeader(name) { return this.headers[name.toLowerCase()]; },
    removeHeader(name) { delete this.headers[name.toLowerCase()]; },
    writeHead(status, headers = {}) {
      this.statusCode = status;
      this.headersSent = true;
      for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
    },
    end(body = "") { this.body += body; },
  };
}

function requestFor(uid, cookie, accept = "text/html") {
  const request = Readable.from([]);
  request.method = "GET";
  request.url = `/interaction/${uid}`;
  request.headers = { host: new URL(ISSUER).host, "x-forwarded-proto": "https", cookie, accept };
  request.socket = { encrypted: true };
  return request;
}

// The existing tests inject pool/store fixtures. This pool fixture keeps rows
// across requests and runs the production store methods, including token issuance.
// It models the database contract; PostgreSQL SQL execution remains a separate gate.
function poolFixture() {
  const sessions = new Map();
  const interactions = new Map();
  const key = (hash) => hash.toString("hex");
  const result = (row) => ({ rowCount: row ? 1 : 0, rows: row ? [row] : [] });
  function addSession(id, { authenticated = true, expired = false, invalidated = false } = {}) {
    sessions.set(key(hashOpaque(id)), {
      session_hash: hashOpaque(id), user_id: authenticated ? USER : null,
      user_email: "human@example.test", user_display_name: "Human",
      authenticated_at: authenticated ? new Date().toISOString() : null,
      expired, invalidated,
    });
  }
  return {
    sessions, interactions, addSession,
    async query(sql, parameters) {
      if (sql.includes("INSERT INTO commonswarm_oauth.browser_sessions")) {
        sessions.set(key(parameters[0]), {
          session_hash: parameters[0], user_id: null, authenticated_at: null,
        });
        return result({});
      }
      if (sql.includes("SELECT session_hash")) {
        const row = sessions.get(key(parameters[0]));
        return result(row && !row.expired && !row.invalidated ? row : null);
      }
      if (sql.includes("INSERT INTO commonswarm_oauth.interactions")) {
        const [uid, sessionHash, clientId, redirectUri, resource, scopes, challenge, state] = parameters;
        const previous = interactions.get(uid);
        if (previous) {
          const sameBinding = previous.session_hash.equals(sessionHash) &&
            previous.client_id === clientId && previous.redirect_uri === redirectUri &&
            previous.resource === resource && JSON.stringify(previous.requested_scopes) === JSON.stringify(scopes) &&
            previous.pkce_challenge === challenge && previous.oauth_state === state;
          return result(sameBinding && !previous.completed && !previous.expired ? previous : null);
        }
        // Decode the INSERT's actual columns/parameter positions, so the
        // regression exercises identity persistence, rather than inventing it.
        const [, columns, values] = /interactions\s*\(([^)]+)\)\s*VALUES\s*\(([\s\S]+?)statement_timestamp/u.exec(sql);
        const names = columns.split(",").map((name) => name.trim());
        const expressions = values.split(",");
        const userIndex = names.indexOf("user_id");
        const userParameter = userIndex < 0 ? null : /\$(\d+)/u.exec(expressions[userIndex]);
        const row = {
          interaction_uid: uid, session_hash: sessionHash, client_id: clientId,
          redirect_uri: redirectUri, resource, requested_scopes: scopes,
          pkce_challenge: challenge, oauth_state: state,
          user_id: userParameter ? parameters[Number(userParameter[1]) - 1] : null,
          selection_version: 0, selected_workspace_ids: [],
        };
        interactions.set(uid, row);
        return result(row);
      }
      if (sql.includes("SET consent_token_hash")) {
        const [tokenHash, uid, sessionHash, userId] = parameters;
        const row = interactions.get(uid);
        if (!row || !row.session_hash.equals(sessionHash) || row.user_id !== userId ||
            row.completed || row.expired) return result(null);
        row.consent_token_hash = tokenHash;
        return result(row);
      }
      if (sql.includes("SET signin_state_hash")) {
        const [stateHash, verifier, uid, sessionHash] = parameters;
        const row = interactions.get(uid);
        if (!row || !row.session_hash.equals(sessionHash) || row.completed || row.expired) return result(null);
        Object.assign(row, { signin_state_hash: stateHash, signin_pkce_verifier: verifier });
        return result(row);
      }
      throw new Error("unexpected database fixture query");
    },
  };
}

async function harness() {
  const provider = await createMcpProvider({ adapter: createAtomicMemoryAdapter() });
  const pool = poolFixture();
  pool.addSession(SESSION_A);
  pool.addSession(SESSION_B);
  const store = new InteractionStore(pool);
  const logs = [];
  const interactionHandler = createInteractionHandler({
    provider, store,
    gotrue: { begin: () => ({
      url: new URL("https://api.commonswarm.com/auth/v1/authorize"),
      state: "sign-in-state-long-enough", verifier: "sign-in-verifier-long-enough",
    }) },
    consentOrchestrator: { status: async () => [] },
    workspaceReader: async () => [{ id: WORKSPACE, name: "Workspace One" }],
    allowedOrigins: new Set([ISSUER]), callbackUrl: `${ISSUER}/oauth/callback/gotrue`,
  });
  const handler = createHandler({
    provider, pool, interactionHandler, publicAuthorizationEnabled: true,
    maxBodyBytes: 64 * 1024, logger: createLogger((line) => logs.push(JSON.parse(line))),
  });
  async function attempt(uid, { session = SESSION_A, prompt = "consent", providerSession, ttl = 600 } = {}) {
    const params = {
      client_id: "https://client.example/oauth.json", redirect_uri: "https://client.example/callback",
      resource: RESOURCE, scope: "openid mcp", code_challenge: "a".repeat(43), state: "opaque-client-state",
    };
    const interaction = new provider.Interaction(uid, {
      params, prompt: { name: prompt, details: {} }, session: providerSession,
      returnTo: `${ISSUER}/authorize/resume`,
    });
    await interaction.save(ttl);
    const request = requestFor(uid, `${SESSION_COOKIE}=${session}`);
    const cookies = responseCapture();
    provider.createContext(request, cookies).cookies.set(provider.cookieName("interaction"), uid, {
      signed: true, secure: true,
    });
    request.headers.cookie += "; " + cookies.headers["set-cookie"].map((cookie) => cookie.split(";", 1)[0]).join("; ");
    return request;
  }
  async function run(request) {
    const response = responseCapture();
    await handler(request, response);
    return response;
  }
  return { provider, pool, store, logs, attempt, run };
}

function expectPage(response, status) {
  assert.equal(response.statusCode, status, response.body);
  assert.match(response.headers["content-type"], /text\/html/u);
  assert.ok(response.body.includes(RESTART));
  assert.equal(response.headers["cache-control"], "no-store");
  assert.match(response.headers["content-security-policy"], /frame-ancestors 'none'/u);
  assert.doesNotMatch(response.body, /interaction_binding_mismatch|opaque-client-state|browser-session|AAAA|<script/u);
}

test("returning authenticated browser persists identity on a fresh interaction and reaches consent", async () => {
  const h = await harness();
  for (const oldState of ["completed", "incomplete"]) {
    const oldUid = `old-${oldState}`;
    const old = await h.attempt(oldUid);
    const prior = await h.run(old);
    assert.equal(prior.statusCode, 200, JSON.stringify(h.logs.filter((entry) => entry.event === "request_failed")));
    h.pool.interactions.get(oldUid).completed = oldState === "completed";
    const uid = `new-${oldState}`;
    const response = await h.run(await h.attempt(uid));
    assert.equal(response.statusCode, 200, response.body);
    assert.match(response.body, /Workspace One/u);
    const row = h.pool.interactions.get(uid);
    assert.equal(row.user_id, USER);
    assert.ok(row.consent_token_hash);
    assert.equal(response.headers["set-cookie"], undefined);
  }
});

test("login prompt uses the current CommonSwarm identity and resumes with 303", async () => {
  const h = await harness();
  let submitted;
  // Capture the login result; provider interaction/session validation remains real.
  h.provider.interactionFinished = async (_request, response, result) => {
    submitted = result;
    response.writeHead(303, { location: "/authorize/resume" });
    response.end();
  };
  const response = await h.run(await h.attempt("fresh-login", { prompt: "login" }));
  assert.equal(response.statusCode, 303);
  assert.equal(response.headers.location, "/authorize/resume");
  assert.deepEqual(submitted, { login: { accountId: USER } });
});

test("expired or invalidated browser cookie starts fresh sign-in even with a same-user provider session", async () => {
  const h = await harness();
  const providerSession = new h.provider.Session({ accountId: USER });
  await providerSession.save(600);
  const snapshot = { uid: providerSession.uid, accountId: USER };
  for (const condition of ["expired", "invalidated"]) {
    h.pool.addSession(SESSION_A, { [condition]: true });
    const uid = `fresh-${condition}`;
    const response = await h.run(await h.attempt(uid, { providerSession: snapshot }));
    assert.equal(response.statusCode, 303, response.body);
    assert.equal(response.headers.location, "https://api.commonswarm.com/auth/v1/authorize");
    assert.match(response.headers["set-cookie"], /Secure; HttpOnly; Path=\/; SameSite=Lax/u);
    const row = h.pool.interactions.get(uid);
    assert.equal(row.user_id, null);
    assert.ok(row.signin_state_hash);
    assert.equal(row.session_hash.equals(hashOpaque(SESSION_A)), false);
  }
  h.pool.addSession(SESSION_A);
  const response = await h.run(await h.attempt("fresh-provider-session", { providerSession: snapshot }));
  assert.equal(response.statusCode, 200, response.body);
});

test("interaction bound to browser A refuses browser B with 409 and still admits A", async () => {
  const h = await harness();
  const request = await h.attempt("bound-to-A");
  assert.equal((await h.run(request)).statusCode, 200);
  request.headers.cookie = request.headers.cookie.replace(SESSION_A, SESSION_B);
  expectPage(await h.run(request), 409);
  assert.ok(h.logs.some((entry) => entry.event === "request_failed" &&
    entry.status === 409 && entry.error_code === "interaction_binding_mismatch"));
  request.headers.accept = "application/json";
  const json = await h.run(request);
  assert.equal(json.statusCode, 409);
  assert.deepEqual(JSON.parse(json.body), { error: "interaction_binding_mismatch" });
  request.headers.cookie = request.headers.cookie.replace(SESSION_B, SESSION_A);
  assert.equal((await h.run(request)).statusCode, 200);
});

test("unknown, expired, mismatched and malformed interaction UIDs have safe 4xx pages", async () => {
  const h = await harness();
  expectPage(await h.run(requestFor("AAAA", `${SESSION_COOKIE}=${SESSION_A}`)), 410);
  const expired = await h.attempt("expired-provider", { ttl: -1 });
  expectPage(await h.run(expired), 410);
  const missing = await h.attempt("deleted-provider");
  await h.provider.Interaction.find("deleted-provider").then((interaction) => interaction.destroy());
  expectPage(await h.run(missing), 410);
  const valid = await h.attempt("valid-control");
  const mismatch = Object.assign(requestFor("AAAA", valid.headers.cookie), { headers: valid.headers });
  expectPage(await h.run(mismatch), 409);
  expectPage(await h.run(requestFor("%ZZ", valid.headers.cookie)), 410);
  assert.equal((await h.run(valid)).statusCode, 200);
  const json = await h.run(requestFor("AAAA", `${SESSION_COOKIE}=${SESSION_A}`, "application/json"));
  assert.equal(json.statusCode, 410);
  assert.deepEqual(JSON.parse(json.body), { error: "interaction_expired" });
  assert.ok(h.logs.some((entry) => entry.event === "request_failed" &&
    entry.status === 410 && entry.error_code === "interaction_expired"));
});

test("completed or expired stored bindings refuse reuse, while a fresh UID succeeds", async () => {
  const h = await harness();
  for (const condition of ["completed", "expired"]) {
    const uid = `stored-${condition}`;
    const request = await h.attempt(uid);
    assert.equal((await h.run(request)).statusCode, 200);
    h.pool.interactions.get(uid)[condition] = true;
    expectPage(await h.run(request), 409);
    assert.equal((await h.run(await h.attempt(`replacement-${condition}`))).statusCode, 200);
  }
});


test("missing or changed provider sessions and incomplete callbacks have safe restart responses", async () => {
  const h = await harness();
  const providerSession = new h.provider.Session({ accountId: USER });
  await providerSession.save(600);
  const missing = await h.attempt("missing-session", {
    providerSession: { uid: "missing-provider-session", accountId: USER },
  });
  expectPage(await h.run(missing), 410);
  const changed = await h.attempt("changed-principal", {
    providerSession: { uid: providerSession.uid, accountId: "different-user" },
  });
  expectPage(await h.run(changed), 410);
  const callback = requestFor("unused", `${SESSION_COOKIE}=${SESSION_A}`);
  callback.url = "/oauth/callback/gotrue?interaction=AAAA";
  expectPage(await h.run(callback), 400);
  callback.headers.accept = "application/json";
  const json = await h.run(callback);
  assert.equal(json.statusCode, 400);
  assert.deepEqual(JSON.parse(json.body), { error: "invalid_callback" });
  assert.equal((await h.run(await h.attempt("session-control", {
    providerSession: { uid: providerSession.uid, accountId: USER },
  }))).statusCode, 200);
});
