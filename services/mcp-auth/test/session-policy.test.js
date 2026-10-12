// Acceptance: dummy live-status inputs exercise freshness; CI uses migrated
// PostgreSQL and runtime privileges to prove attachment, rotation and revocation.
// Outputs are assertions only; missing CI prerequisites fail, never skip.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { InteractionStore } from "../src/interaction-store.js";
import { hashOpaque, sessionCookie } from "../src/browser-security.js";
import { sessionReuseDecision } from "../src/session-policy.js";

const now = Math.floor(Date.now() / 1000), at = now - 60;
const userId = randomUUID(), authId = randomUUID();
const session = { user_id: userId, gotrue_session_id: authId,
  authenticated_at: new Date(at * 1000), expires_at: new Date((at + 604800) * 1000) };

test("fresh live reuse succeeds; forced, stale, revoked and unproved reuse fail closed", async () => {
  let rows = [{ session_id: authId, user_id: userId, authenticated_at: session.authenticated_at }];
  const options = { nowSeconds: now, pool: { query: async () => ({ rows }) } };
  const decide = (row = session, params = {}) => sessionReuseDecision(row, params, options);
  assert.equal((await decide()).allowed, true);
  assert.equal((await decide(session, { max_age: "60", prompt: "none" })).allowed, true);
  for (const params of [{ prompt: "login" }, { prompt: "consent login" }, { max_age: "59" }, { max_age: 0 }]) {
    assert.equal((await decide(session, params)).reason, "fresh_login_required");
  }
  for (const max_age of [-1, "junk", null, Infinity, true]) assert.equal((await decide(session, { max_age })).allowed, false);
  for (const patch of [{ gotrue_session_id: null }, { authenticated_at: null }, { authenticated_at: new Date((now + 1) * 1000) },
    { expires_at: new Date(now * 1000) }, { invalidated_at: new Date() }, { user_id: null }]) {
    assert.equal((await decide({ ...session, ...patch })).allowed, false);
  }
  for (const live of [[], [{ ...rows[0], user_id: randomUUID() }], [{ ...rows[0], authenticated_at: new Date((at + 1) * 1000) }]]) {
    rows = live;
    assert.equal((await decide()).reason, "revoked_or_unproved");
  }
  rows = [{ session_id: authId, user_id: userId, authenticated_at: session.authenticated_at }];
  options.nowSeconds = at + 604800;
  assert.equal((await decide({ ...session, expires_at: new Date((at + 999999) * 1000) })).allowed, false);
  options.nowSeconds = now;
  assert.equal((await decide()).allowed, true);
  assert.doesNotMatch(sessionCookie("DUMMYCOOKIE"), /Max-Age|Expires|Domain/iu);
});

test("CI only: fixed seven-day deadline and GoTrue binding survive attachment and rotation", {
  skip: process.env.CI !== "true" ? "CI only: migrated PostgreSQL required" : false,
  timeout: 30000,
}, async () => {
  const { Pool } = await import("pg");
  const target = new URL(process.env.MCP_OAUTH_TEST_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres");
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(target.hostname), "isolated local CI database required");
  // The migration principal's runtime membership is ADMIN-only, without SET.
  // The local cluster administrator can start a connection as the actual runtime.
  target.username = "supabase_admin";
  const connectionString = target.href;
  const admin = new Pool({ connectionString, connectionTimeoutMillis: 2000 });
  const runtime = new Pool({ connectionString, options: "-c role=commonswarm_oauth_runtime", connectionTimeoutMillis: 2000 });
  const store = new InteractionStore(runtime), uid = randomUUID(), controlId = randomUUID(), controlAuth = randomUUID();
  const hashes = [], identity = { id: userId, gotrueSessionId: authId, interactiveAuthAtSeconds: at,
    identityVerified: true, email: "TEST@example.test", displayName: "TEST user" };
  try {
    assert.equal((await runtime.query("SELECT current_user AS role")).rows[0].role, "commonswarm_oauth_runtime");
    for (const [id, sid] of [[userId, authId], [controlId, controlAuth]]) {
      await admin.query("INSERT INTO auth.users(id,aud,role,email) VALUES($1,'authenticated','authenticated',$2)", [id, `${id}@example.test`]);
      await admin.query("INSERT INTO auth.sessions(id,user_id) VALUES($1,$2)", [sid, id]);
      await admin.query(`INSERT INTO auth.mfa_amr_claims(id,session_id,created_at,updated_at,authentication_method)
        VALUES($1,$2,to_timestamp($3),to_timestamp($3),'oauth')`, [randomUUID(), sid, at]);
    }
    const browser = await store.createSession(); hashes.push(hashOpaque(browser));
    assert.equal((await store.requireSession(browser)).user_id, null);
    const request = { interactionUid: uid, sessionId: browser, clientId: "https://client.example/oauth.json",
      redirectUri: "https://client.example/callback", resource: "https://mcp.commonswarm.com/mcp",
      scopes: ["openid", "mcp"], pkceChallenge: "a".repeat(43), oauthState: "DUMMYSTATE" };
    await store.bindInteraction(request);
    await store.beginSignIn(uid, browser, { provider: "github", state: "DUMMYSTATE", verifier: "a".repeat(43) });
    await store.consumeSignIn(uid, browser, "DUMMYSTATE", "github");
    await assert.rejects(store.attachUser(uid, browser, { ...identity, gotrueSessionId: randomUUID() }), { code: "interaction_binding_mismatch" });
    await assert.rejects(store.attachUser(uid, browser, { ...identity, interactiveAuthAtSeconds: now }), { code: "interaction_binding_mismatch" });
    await assert.rejects(store.attachUser(uid, browser, { ...identity, identityVerified: false }), { code: "interaction_binding_mismatch" });
    await store.attachUser(uid, browser, identity);
    await store.attachUser(uid, browser, identity);
    const original = await store.requireSession(browser);
    assert.equal(original.gotrue_session_id, authId);
    assert.equal(original.authenticated_at.getTime(), at * 1000);
    assert.equal(original.expires_at.getTime(), (at + 604800) * 1000);
    // An earlier fixed deadline must survive another callback and rotation.
    await admin.query("UPDATE commonswarm_oauth.browser_sessions SET expires_at=expires_at-interval '1 hour' WHERE session_hash=$1", [hashes[0]]);
    await store.attachUser(uid, browser, identity);
    let current = browser;
    for (let i = 0; i < 2; i++) {
      const next = await store.rotateSession(current); hashes.push(hashOpaque(next));
      assert.equal(await store.requireSession(current), null);
      const reused = await store.requireSession(next);
      assert.equal(reused.expires_at.getTime(), original.expires_at.getTime() - 3600000);
      assert.equal(reused.gotrue_session_id, authId);
      assert.equal(reused.authenticated_at.getTime(), original.authenticated_at.getTime());
      assert.equal((await store.bindInteraction({ ...request, sessionId: next, userId })).user_id, userId);
      current = next;
    }
    await assert.rejects(store.bindInteraction(request), { code: "interaction_binding_mismatch" });
    const control = await store.createSession(); hashes.push(hashOpaque(control));
    await admin.query(`UPDATE commonswarm_oauth.browser_sessions SET user_id=$1,gotrue_session_id=$2,
      authenticated_at=to_timestamp($3) WHERE session_hash=$4`, [controlId, controlAuth, at, hashOpaque(control)]);
    assert.equal((await store.requireSession(control)).user_id, controlId);
    // Only a newly proved authentication starts another seven-day deadline.
    const freshAuth = randomUUID();
    await admin.query("INSERT INTO auth.sessions(id,user_id) VALUES($1,$2)", [freshAuth, userId]);
    await admin.query(`INSERT INTO auth.mfa_amr_claims(id,session_id,created_at,updated_at,authentication_method)
      VALUES($1,$2,to_timestamp($3),to_timestamp($3),'oauth')`, [randomUUID(), freshAuth, now]);
    await store.attachUser(uid, current, { ...identity, gotrueSessionId: freshAuth, interactiveAuthAtSeconds: now });
    const fresh = await store.requireSession(current);
    assert.equal(fresh.expires_at.getTime(), (now + 604800) * 1000);
    assert.equal(fresh.gotrue_session_id, freshAuth);
    // P1's separate matching-version GoTrue gate owns the real global logout event.
    await admin.query("DELETE FROM auth.sessions WHERE user_id=$1", [userId]);
    assert.equal(await store.requireSession(current), null);
    await assert.rejects(store.rotateSession(current), { code: "interaction_binding_mismatch" });
    assert.equal((await store.requireSession(control)).user_id, controlId);
    await admin.query("UPDATE commonswarm_oauth.browser_sessions SET gotrue_session_id=NULL WHERE session_hash=$1", [hashOpaque(control)]);
    assert.equal(await store.requireSession(control), null);
    await admin.query(`UPDATE commonswarm_oauth.browser_sessions SET gotrue_session_id=$1,
      expires_at=statement_timestamp()-interval '1 second' WHERE session_hash=$2`, [controlAuth, hashOpaque(control)]);
    assert.equal(await store.requireSession(control), null);
    await assert.rejects(store.rotateSession(control), { code: "interaction_binding_mismatch" });
  } finally {
    try {
      await admin.query("DELETE FROM commonswarm_oauth.interactions WHERE interaction_uid=$1", [uid]);
      await admin.query("DELETE FROM commonswarm_oauth.browser_sessions WHERE session_hash=ANY($1::bytea[])", [hashes]);
      await admin.query("DELETE FROM auth.users WHERE id=ANY($1::uuid[])", [[userId, controlId]]);
    } finally { await runtime.end(); await admin.end(); }
  }
});
