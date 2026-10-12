// P8 transport acceptance: synthetic requests/config in, HTTP responses out.
// Protect route precedence, default-off rollout and navigation/form policies;
// no sockets, real credentials, browser or database. P4/P9c own durability.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { exportJWK, generateKeyPair } from "jose";
import { loadConfig } from "../src/config.js";
import { createHandler } from "../src/server.js";
import { createFinishFlow } from "../src/finish-flow.js";
import { FINISH_TIMER_PATH } from "../src/finish-page.js";
import { createInteractionHandler } from "../src/interactions.js";
import { InteractionStateError } from "../src/client-error.js";
import { consentSecurityHeaders, SESSION_COOKIE } from "../src/browser-security.js";

const issuer = "https://mcp.commonswarm.com", uid = "DUMMYINTERACTION";
const sessionId = "DUMMYSESSION-long-enough", csrf = "DUMMYCSRF-long-enough-for-form";
const session = { user_id: "DUMMYUSER", authenticated_at: new Date() };
const params = { client_id: "https://client.example/metadata", redirect_uri: "https://client.example/callback",
  resource: `${issuer}/mcp`, scope: "mcp", code_challenge: "a".repeat(43), state: "DUMMYSTATE" };
const unexpected = () => assert.fail("finish route reached normal binding/provider dispatch");
function response() {
  return { headers: {}, statusCode: 200, body: "",
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    writeHead(status, headers) { this.statusCode = status; Object.entries(headers).forEach(([k, v]) => this.setHeader(k, v)); },
    end(body = "") { this.body += body; } };
}
async function run(handler, path, method = "GET", headers = {}, body = "") {
  const request = Object.assign(Readable.from(body ? [Buffer.from(body)] : []), {
    url: path, method, headers: { cookie: `${SESSION_COOKIE}=${sessionId}`, ...headers } });
  const res = response(); await handler(request, res); return res;
}
function handler(options = {}) {
  return createHandler({ provider: { callback: () => unexpected }, pool: { query: unexpected },
    publicAuthorizationEnabled: true, maxBodyBytes: 1024, logger: { info() {} },
    interactionHandler: unexpected, ...options });
}
function secured(res) {
  assert.equal(res.headers["cache-control"], "no-store");
  assert.equal(res.headers["referrer-policy"], "no-referrer");
  for (const rule of ["default-src 'none'", "script-src 'self'", "base-uri 'none'", "frame-ancestors 'none'"])
    assert.ok(res.headers["content-security-policy"].includes(rule), rule);
}

test("finish flag requires explicit 1; unset and other values keep rollout off", async t => {
  const prefix = join(tmpdir(), "oauth-finish-config-");
  const directory = await mkdtemp(prefix);
  t.after(() => {
    assert.ok(directory.startsWith(prefix) && !directory.slice(prefix.length).includes("/"));
    assert.ok(directory !== process.env.HOME && directory !== "/");
    execFileSync("rm", ["-r", directory]);
  });
  const path = name => join(directory, name);
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  for (const [name, value] of Object.entries({ signing: JSON.stringify({ keys: [
    { ...await exportJWK(privateKey), kid: "DUMMYKEY", alg: "ES256", use: "sig" }] }),
    cookies: `${"a".repeat(32)}\n${"b".repeat(32)}`, database: JSON.stringify({ user: "DUMMYUSER", password: "DUMMYPASSWORD" }) }))
    await writeFile(path(name), value, { mode: 0o600 });
  const env = { MCP_OAUTH_SIGNING_KEYS_FILE: path("signing"), MCP_OAUTH_COOKIE_KEYS_FILE: path("cookies"),
    MCP_OAUTH_DATABASE_CREDENTIALS_FILE: path("database"), MCP_OAUTH_DATABASE_TLS_CA_FILE: "/etc/hosts",
    MCP_OAUTH_ACTIVE_SIGNING_KID: "DUMMYKEY", MCP_OAUTH_PUBLIC_ORIGIN: issuer, MCP_OAUTH_ALLOWED_ORIGINS: issuer,
    MCP_OAUTH_GOTRUE_URL: "https://auth.example/auth/v1", MCP_OAUTH_GOTRUE_PROVIDER: "github",
    SUPABASE_ANON_KEY: "DUMMYANONKEY", MCP_OAUTH_DATABASE_HOST: "db.example", MCP_OAUTH_DATABASE_NAME: "postgres" };
  for (const value of [undefined, "", "0", "true", "1"]) {
    const configured = await loadConfig({ ...env, MCP_OAUTH_FINISH_ENABLED: value });
    assert.equal(configured.finishEnabled, value === "1");
  }
});

test("timer GET/HEAD are served before binding; POST is refused and rollout gates the asset", async () => {
  const active = handler({ finishEnabled: true });
  for (const [method, status] of [["GET", 200], ["HEAD", 200], ["POST", 405]]) {
    const res = await run(active, FINISH_TIMER_PATH, method);
    assert.equal(res.statusCode, status); secured(res);
    if (status === 200) {
      assert.equal(res.headers["content-type"], "text/javascript; charset=utf-8");
      assert.equal(res.headers["x-content-type-options"], "nosniff");
      assert.equal(res.body.length > 0, method === "GET");
    } else assert.equal(res.headers.allow, "GET, HEAD");
  }
  const off = handler({ interactionHandler: async (_req, res) => { res.writeHead(404, {}); res.end(); return true; } });
  assert.equal((await run(off, FINISH_TIMER_PATH)).statusCode, 404);
  assert.equal((await run(handler({ finishEnabled: true, publicAuthorizationEnabled: false }), FINISH_TIMER_PATH)).statusCode, 503);
});

test("completed finish pages and saved 303 precede normal binding, with navigation headers", async () => {
  const provider = { issuer, callback: () => unexpected,
    interactionDetails: async () => ({ uid, params }), interactionFinished: unexpected };
  const flow = createFinishFlow({ provider, store: { requireSession: async () => session }, finishStore: {
    getFinish: async () => ({ state: "resume_ready", expires_at: new Date(Date.now() + 120000),
      display_model: { clientDisplay: { verified: false, primary: "TEST client" },
        identity: { displayName: "TEST human" }, workspaceNames: ["TEST workspace"], homeWorkspaceName: "TEST workspace" } }),
    ensureResume: async () => ({ location: `${issuer}/authorize/DUMMYRESUME`, cookies: ["dummy=DUMMYCOOKIE; Secure; HttpOnly"] }) } });
  const active = handler({ provider, finishEnabled: true, finishFlow: flow });
  const page = await run(active, `/interaction/${uid}/connected`);
  assert.equal(page.statusCode, 200); secured(page);
  assert.match(page.body, /<h1 id="finish-title">Connected<\/h1>/u);
  assert.ok(page.body.includes(`src="${FINISH_TIMER_PATH}"`));
  const resume = await run(active, `/interaction/${uid}/finish`);
  assert.equal(resume.statusCode, 303); secured(resume);
  assert.equal(resume.headers.location, `${issuer}/authorize/DUMMYRESUME`);
  assert.deepEqual(resume.headers["set-cookie"], ["dummy=DUMMYCOOKIE; Secure; HttpOnly"]);
  assert.equal(resume.body, "");
  const refused = await run(active, `/interaction/${uid}/finish`, "POST");
  assert.equal(refused.statusCode, 405); secured(refused);
  const off = handler({ finishFlow: flow, interactionHandler: async () => false,
    provider: { callback: () => (_req, res) => { res.writeHead(404, {}); res.end(); } } });
  assert.equal((await run(off, `/interaction/${uid}/connected`)).statusCode, 404);
});

test("form policy retains same-origin POST and exact Origin checks while finish is on", async () => {
  let switches = 0;
  const provider = { callback: () => unexpected, interactionDetails: async () => ({ uid, params }) };
  const interactionHandler = createInteractionHandler({ provider, allowedOrigins: new Set([issuer]),
    store: { requireSession: async () => session, bindInteraction: async () => ({ user_id: session.user_id }),
      switchAccount: async ({ token }) => { assert.equal(token, csrf); switches++; return "DUMMYNEWSESSION"; } } });
  const active = handler({ provider, interactionHandler, finishEnabled: true });
  const policy = consentSecurityHeaders(params.redirect_uri);
  assert.equal(policy["referrer-policy"], "same-origin");
  const post = origin => run(active, `/interaction/${uid}/switch-account`, "POST",
    { origin, "content-type": "application/x-www-form-urlencoded" }, `csrf_token=${csrf}`);
  const success = await post(issuer);
  assert.equal(success.statusCode, 303); assert.equal(success.headers["referrer-policy"], "same-origin");
  assert.equal(success.headers.location, `/interaction/${uid}/sign-in?select_account=1`);
  for (const origin of ["null", "https://attacker.example", undefined]) {
    const denied = await post(origin); assert.equal(denied.statusCode, 403);
    assert.equal(JSON.parse(denied.body).error, "origin_forbidden");
  }
  assert.equal(switches, 1);
});

test("finish failures keep navigation policy and cannot fall through to the provider", async () => {
  const unavailable = await run(handler({ finishEnabled: true }), `/interaction/${uid}/finish`);
  assert.equal(unavailable.statusCode, 503); secured(unavailable);
  for (const [error, status] of [[new InteractionStateError("interaction_expired"), 410], [new Error("DUMMYFAILURE"), 500]]) {
    const active = handler({ provider: { issuer, callback: () => unexpected }, finishEnabled: true,
      finishFlow: { handle: async () => { throw error; } } });
    const failed = await run(active, `/interaction/${uid}/connected`);
    assert.equal(failed.statusCode, status); secured(failed);
  }
});
