import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { calculateJwkThumbprint, decodeJwt, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createAtomicMemoryAdapter } from "../src/memory-adapter.js";
import { createSpikeProvider, holdResponse, requestDatabase,
  SPIKE_ISSUER as ISSUER, SPIKE_ADMIN_RESOURCE as ADMIN } from "./fixtures/atomic-provider-harness.js";

async function serverFixture(operation) {
  const server = createServer(operation);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => server.close(resolve)) };
}

test("atomic spike buffer holds headers, direct interaction redirects and Koa-style bodies until release", async () => {
  for (const directRedirect of [false, true]) {
    let arrived, release;
    const staged = new Promise(resolve => { arrived = resolve; });
    const blocked = new Promise(resolve => { release = resolve; });
    const fixture = await serverFixture(async (_req, res) => {
      const held = holdResponse(res);
      if (directRedirect) {
        res.statusCode = 303; res.setHeader("location", "/authorize/continuation");
        res.setHeader("content-length", "0"); res.end();
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"result":"committed"}');
      }
      assert.equal(res.headersSent, false); assert.equal(held.staged, true);
      arrived(); await blocked; held.release();
    });
    let delivered = false;
    const response = fetch(fixture.url, { redirect: "manual" }).then(result => { delivered = true; return result; });
    try {
      await staged; assert.equal(delivered, false); release();
      const result = await response;
      assert.equal(result.status, directRedirect ? 303 : 200);
      if (directRedirect) assert.equal(result.headers.get("location"), "/authorize/continuation");
      else assert.equal(await result.text(), '{"result":"committed"}');
    } finally { release(); await fixture.close(); }
  }
});

test("atomic spike buffer discards headers/body on failure and refuses oversized or flushed output", async () => {
  const fixture = await serverFixture((_req, res) => {
    const held = holdResponse(res, 20);
    res.writeHead(200, { location: "/staged-code", "set-cookie": "staged=fixture" });
    res.write("staged body");
    assert.throws(() => res.write("over the bounded limit"), /limit exceeded/u);
    assert.throws(() => res.flushHeaders(), /early flush/u);
    assert.equal(res.headersSent, false);
    held.discard(); res.statusCode = 503; res.end("rolled back");
  });
  try {
    const result = await fetch(fixture.url, { redirect: "manual" });
    assert.equal(result.status, 503); assert.equal(await result.text(), "rolled back");
    assert.equal(result.headers.get("location"), null); assert.equal(result.headers.get("set-cookie"), null);
  } finally { await fixture.close(); }
});

test("atomic spike cached database facade refuses missing/closed context and separates concurrent requests", async () => {
  const db = requestDatabase();
  await assert.rejects(db.pool.query("SELECT 1"), /live request transaction/u);
  const calls = [];
  function scope(xid) {
    return { client: { async query(sql) {
      calls.push({ xid, sql });
      await Promise.resolve();
      return { rows: [{ xid, pid: Number(xid) }], rowCount: 1 };
    } }, calls: [], writes: [], joined: [], pending: new Set() };
  }
  const first = scope("11"), second = scope("22");
  await Promise.all([first, second].map(state => db.context.run(state, async () => {
    const client = await db.pool.connect();
    await client.query("BEGIN"); await client.query("INSERT fixture"); await client.query("COMMIT"); client.release();
    await db.drain(state);
  })));
  assert.deepEqual(first.calls.map(call => call.xid), ["11"]);
  assert.deepEqual(second.calls.map(call => call.xid), ["22"]);
  assert.ok(calls.every(call => !["BEGIN", "COMMIT", "ROLLBACK"].includes(call.sql)), "only coordinator sends transaction control");
  first.closed = true;
  await db.context.run(first, () => assert.rejects(db.pool.query("SELECT 1"), /live request transaction/u));
});

test("atomic spike remembers a caught adapter fault so provider error conversion cannot commit partial writes", async () => {
  const db = requestDatabase();
  const scope = { client: { async query() { return { rows: [{ xid: "33", pid: 33 }], rowCount: 1 }; } },
    calls: [], writes: [], joined: [], pending: new Set(), failAfterWrite: 1 };
  await db.context.run(scope, async () => {
    await assert.rejects(db.pool.query("UPDATE fixture"), /injected after write/u);
    await assert.rejects(db.pool.query("INSERT later"), /injected after write/u);
    await assert.rejects(db.drain(scope), /injected after write/u);
  });
  assert.equal(scope.writes.length, 1); assert.equal(scope.pending.size, 0);
});

test("pinned provider HTTP completion/code/refresh can be buffered without an upstream patch (transport only, no DB claim)", async () => {
  const keys = await generateKeyPair("ES256", { extractable: true });
  const dpop = await generateKeyPair("ES256", { extractable: true });
  const publicJwk = await exportJWK(dpop.publicKey), jkt = await calculateJwkThumbprint(publicJwk);
  const client = `https://client.example/${randomUUID()}`, redirect = "https://client.example/callback";
  const verifier = "transport-spike-verifier-0123456789abcdef0123456789";
  const provider = createSpikeProvider({ adapter: createAtomicMemoryAdapter(),
    metadata: { client_id: client, application_type: "web", grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"], redirect_uris: [redirect], token_endpoint_auth_method: "none",
      id_token_signed_response_alg: "ES256", dpop_bound_access_tokens: true, dpop_signing_alg: "ES256" },
    jwk: { ...await exportJWK(keys.privateKey), alg: "ES256", use: "sig", kid: "transport-spike" },
    extraTokenClaims: async (_ctx, token) => ({ grant_id: token.grantId }), jwtCustomizer: async () => {} });
  const callback = provider.callback(), controls = new Map();
  const fixture = await serverFixture(async (req, res) => {
    const held = holdResponse(res);
    try {
      if (req.url.startsWith("/interaction/")) {
        const details = await provider.interactionDetails(req, res);
        if (details.prompt.name === "login") await provider.interactionFinished(req, res, { login: { accountId: "transport-owner" } });
        else {
          const grant = new provider.Grant({ accountId: "transport-owner", clientId: client });
          grant.addOIDCScope("openid offline_access"); grant.addResourceScope(ADMIN, "admin:read");
          await provider.interactionFinished(req, res, { consent: { grantId: await grant.save() } });
        }
      } else await callback(req, res);
      assert.equal(held.staged, true, "callback completion includes the staged response");
      assert.equal(res.headersSent, false);
      await controls.get(req.headers["x-unit"])?.();
      held.release();
    } catch {
      held.discard(); res.statusCode = 500; res.end("transport spike failed");
    }
  });
  const cookies = new Map();
  async function request(url, body, block) {
    const external = new URL(url, ISSUER), unit = randomUUID(); controls.set(unit, block);
    const headers = { host: new URL(ISSUER).host, "x-forwarded-host": new URL(ISSUER).host,
      "x-forwarded-proto": "https", accept: "application/json", "x-unit": unit,
      cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join("; ") };
    if (body) {
      headers["content-type"] = "application/x-www-form-urlencoded";
      headers.dpop = await new SignJWT({ htm: "POST", htu: `${ISSUER}/token` })
        .setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk: publicJwk })
        .setJti(randomUUID()).setIssuedAt().sign(dpop.privateKey);
    }
    const response = await fetch(new URL(external.pathname + external.search, fixture.url),
      { method: body ? "POST" : "GET", headers, body: body ? new URLSearchParams(body) : undefined, redirect: "manual" });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";", 1)[0], at = pair.indexOf("="); cookies.set(pair.slice(0, at), pair.slice(at + 1));
    }
    return response;
  }
  async function heldToken(body) {
    let arrived, release;
    const staged = new Promise(resolve => { arrived = resolve; });
    const blocked = new Promise(resolve => { release = resolve; });
    let delivered = false;
    const pending = request("/token", body, async () => { arrived(); await blocked; })
      .then(result => { delivered = true; return result; });
    try {
      await Promise.race([staged, pending.then(() => { throw new Error("token path did not reach buffer barrier"); })]);
      assert.equal(delivered, false); release();
      const response = await pending; assert.equal(response.status, 200);
      const token = await response.json(); assert.equal(token.token_type, "DPoP");
      const jwt = decodeJwt(token.access_token);
      assert.equal(jwt.aud, ADMIN); assert.equal(jwt.cnf.jkt, jkt);
      assert.equal(jwt.exp - jwt.iat, 300); assert.equal(jwt.scope, "admin:read");
      return token;
    } finally { release(); }
  }
  try {
    const authorize = new URL("/authorize", ISSUER);
    for (const [name, value] of Object.entries({ client_id: client, redirect_uri: redirect, response_type: "code",
      scope: "openid offline_access admin:read", resource: ADMIN, prompt: "consent", dpop_jkt: jkt,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" })) authorize.searchParams.set(name, value);
    let current = authorize, code;
    for (let step = 0; step < 10; step++) {
      const response = await request(current); assert.ok([302, 303].includes(response.status));
      const location = new URL(response.headers.get("location"), ISSUER);
      if (location.origin !== ISSUER) { code = location.searchParams.get("code"); break; }
      current = location;
    }
    assert.ok(code, "real authorization must produce a code");
    const initial = await heldToken({ client_id: client, grant_type: "authorization_code", code,
      code_verifier: verifier, redirect_uri: redirect, resource: ADMIN });
    const rotated = await heldToken({ client_id: client, grant_type: "refresh_token", refresh_token: initial.refresh_token, resource: ADMIN });
    assert.ok(rotated.refresh_token !== initial.refresh_token, "real provider rotation must produce a successor");
  } finally { await fixture.close(); }
});
