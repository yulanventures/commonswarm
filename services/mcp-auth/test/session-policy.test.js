// Acceptance: dummy live-status inputs exercise freshness; CI uses migrated
// PostgreSQL and runtime privileges to prove attachment, rotation and revocation.
// Outputs are assertions only; missing CI prerequisites fail, never skip.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
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
  assert.equal((await decide({ ...session, expires_at: new Date((at + 999999) * 1000) })).allowed, true);
  options.nowSeconds = now;
  assert.equal((await decide()).allowed, true);
  assert.match(sessionCookie("DUMMYCOOKIE"), /; Max-Age=34560000$/u);
  assert.doesNotMatch(sessionCookie("DUMMYCOOKIE"), /Domain=/iu);
  assert.match(sessionCookie("DUMMYCOOKIE", { clear: true }), /^__Host-cswarm-oauth=; .*; Max-Age=0$/u);
});

// Owner boundary: aged stored evidence must still match a live GoTrue session.
// These are policy inputs, not a claim of real GoTrue rotation or elapsed age.
test("31-day live bindings have no implicit deadline; only positive PG infinity is permanent", async () => {
  const originalAt = now - 31 * 86400;
  const aged = { ...session, authenticated_at: new Date(originalAt * 1000) };
  let live = [{ session_id: authId, user_id: userId, authenticated_at: aged.authenticated_at }];
  const options = { nowSeconds: now, pool: { query: async () => ({ rows: live }) } };
  for (const expires_at of [Infinity, "infinity", new Date((now + 60) * 1000)]) {
    const bound = { ...aged, expires_at };
    assert.equal((await sessionReuseDecision(bound, { prompt: "none" }, options)).allowed, true);
    for (const params of [{ prompt: "login" }, { max_age: 0 }, { max_age: 30 * 86400 }]) {
      assert.equal((await sessionReuseDecision(bound, params, options)).reason, "fresh_login_required");
    }
    assert.equal((await sessionReuseDecision(bound, { max_age: 31 * 86400 }, options)).allowed, true);
    live = [];
    assert.equal((await sessionReuseDecision(bound, {}, options)).allowed, false);
    live = [{ session_id: authId, user_id: userId, authenticated_at: aged.authenticated_at }];
  }
  for (const expires_at of [-Infinity, "-infinity", "Infinity", NaN, null, "invalid", new Date(NaN), new Date(now * 1000)]) {
    assert.equal((await sessionReuseDecision({ ...aged, expires_at }, {}, options)).allowed, false);
  }
  assert.equal((await sessionReuseDecision({ ...aged, expires_at: Infinity, invalidated_at: new Date() }, {}, options)).allowed, false);
});

test("CI only: permanent human binding, explicit deadlines and revocation survive attachment and rotation", {
  skip: process.env.CI !== "true" ? "CI only: migrated PostgreSQL required" : false,
  timeout: 30000,
}, async t => {
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
  const agedAt = now - 31 * 86400; // synthetic storage/ACL proof, not real GoTrue aged-state qualification
  const hashes = [], identity = { id: userId, gotrueSessionId: authId, interactiveAuthAtSeconds: agedAt,
    identityVerified: true, email: "TEST@example.test", displayName: "TEST user" };
  try {
    assert.equal((await runtime.query("SELECT current_user AS role")).rows[0].role, "commonswarm_oauth_runtime");
    // Catalog metadata only: CI records the actual image/GoTrue object owners.
    const owners = await admin.query(`
      SELECT 'auth' AS object, pg_get_userbyid(nspowner) AS owner
      FROM pg_namespace WHERE nspname='auth'
      UNION ALL
      SELECT 'auth.'||c.relname, pg_get_userbyid(c.relowner)
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='auth' AND c.relname IN ('sessions','users','mfa_amr_claims')
      ORDER BY object`);
    assert.equal(owners.rows.length, 4, "auth schema and all three GoTrue table owners enumerated");
    t.diagnostic(JSON.stringify({ authPrivilegeOwners: owners.rows }));
    // Execute the migration's actual postcondition, then remove each reviewed
    // privilege in a rollback-only transaction. A warning-only/no-op grant must
    // fail at this gate, before an application query discovers the missing ACL.
    const migration = readFileSync(new URL("../../../supabase/migrations/20261014000001_oauth_session_binding.sql", import.meta.url), "utf8");
    const gate = migration.match(/DO \$session_privileges\$[\s\S]*?\$session_privileges\$;/u)?.[0];
    assert.ok(gate, "migration must have an executable effective-privilege postcondition");
    const allowlist = JSON.parse(readFileSync(new URL("../../../tests/support/admin-issuer-privileges.json", import.meta.url), "utf8"));
    const sessionPrivileges = allowlist.filter(([role, kind, object]) => role === "commonswarm_oauth_session_guard"
      || (role === "commonswarm_oauth_runtime" && kind === "FUNCTION" && object === "commonswarm_oauth.live_gotrue_session(uuid,uuid)"));
    assert.equal(sessionPrivileges.length, 19, "all reviewed session-guard entries remain present");
    const mutations = sessionPrivileges.filter(([, kind]) => ["SCHEMA", "COLUMN", "FUNCTION"].includes(kind));
    mutations.push(["commonswarm_oauth_runtime", "SCHEMA", "commonswarm_oauth", "USAGE"]);
    const connection = await admin.connect();
    try {
      await connection.query("BEGIN");
      // 20261014000001_oauth_session_binding.sql explicitly reassigns both
      // function owners to the guard; ownership cannot identify the applier.
      // Its $session_privileges$ gate checks has_schema_privilege,
      // has_column_privilege and has_function_privilege after migration apply.
      await assert.doesNotReject(connection.query(gate), "session guard and runtime must hold the migration's required effective privileges");
      assert.equal(mutations.length, 17, "two guard schemas, thirteen columns, runtime schema and runtime function");
      for (const [role, kind, object, privilege] of mutations) {
        const parts = object.split("."), column = kind === "COLUMN" ? parts.pop() : null;
        const target = column ? parts.join(".") : object;
        const check = kind === "COLUMN" ? "SELECT has_column_privilege($1,$2,$3,$4) AS allowed"
          : kind === "SCHEMA" ? "SELECT has_schema_privilege($1,$2,$3) AS allowed"
            : "SELECT has_function_privilege($1,$2,$3) AS allowed";
        const values = column ? [role, target, column, privilege] : [role, target, privilege];
        assert.equal((await connection.query(check, values)).rows[0].allowed, true);
        await connection.query("SAVEPOINT missing_session_privilege");
        await connection.query(`REVOKE ${privilege}${column ? ` (${column})` : ""} ON ${kind === "COLUMN" ? "TABLE" : kind} ${target} FROM ${role}`);
        assert.equal((await connection.query(check, values)).rows[0].allowed, false);
        await assert.rejects(connection.query(gate), { code: "42501", message: /^OAuth session privilege missing:/u });
        await connection.query("ROLLBACK TO SAVEPOINT missing_session_privilege");
        await connection.query(gate);
      }
      for (const fn of ["commonswarm_oauth.live_gotrue_session(uuid,uuid)", "commonswarm_oauth.invalidate_gotrue_session()"]) {
        const publicExecute = () => connection.query("SELECT has_function_privilege('public',$1,'EXECUTE') AS allowed", [fn]);
        assert.equal((await publicExecute()).rows[0].allowed, false);
        await connection.query("SAVEPOINT public_session_function");
        await connection.query(`GRANT EXECUTE ON FUNCTION ${fn} TO PUBLIC`);
        assert.equal((await publicExecute()).rows[0].allowed, true);
        await assert.rejects(connection.query(gate), { code: "42501", message: /^OAuth session guard function exposed to PUBLIC:/u });
        await connection.query("ROLLBACK TO SAVEPOINT public_session_function");
        await connection.query(gate);
      }
    } finally { await connection.query("ROLLBACK"); connection.release(); }
    for (const [id, sid] of [[userId, authId], [controlId, controlAuth]]) {
      await admin.query("INSERT INTO auth.users(id,aud,role,email) VALUES($1,'authenticated','authenticated',$2)", [id, `${id}@example.test`]);
      await admin.query("INSERT INTO auth.sessions(id,user_id) VALUES($1,$2)", [sid, id]);
      await admin.query(`INSERT INTO auth.mfa_amr_claims(id,session_id,created_at,updated_at,authentication_method)
        VALUES($1,$2,to_timestamp($3),to_timestamp($3),'oauth')`, [randomUUID(), sid, sid === authId ? agedAt : at]);
    }
    let browser = await store.createSession(); hashes.push(hashOpaque(browser));
    const anonymous = await store.requireSession(browser);
    assert.equal(anonymous.user_id, null);
    assert.ok(anonymous.expires_at.getTime() > Date.now() + 604790000);
    assert.ok(anonymous.expires_at.getTime() <= Date.now() + 604800000);
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
    assert.equal(original.authenticated_at.getTime(), agedAt * 1000);
    assert.equal(original.expires_at, "infinity");
    const scalar = (await runtime.query(`SELECT expires_at, to_jsonb(browser)->>'expires_at' AS json_expiry,
      expires_at > statement_timestamp() AS unexpired
      FROM commonswarm_oauth.browser_sessions AS browser WHERE session_hash=$1`, [hashOpaque(browser)])).rows[0];
    assert.equal(scalar.expires_at, Infinity);
    assert.equal(scalar.json_expiry, "infinity");
    assert.equal(scalar.unexpired, true);
    const shape = (await runtime.query(`SELECT attnotnull,
      EXISTS (SELECT 1 FROM pg_index WHERE indrelid=attrelid AND indisvalid
        AND attnum=ANY(indkey)) AS indexed
      FROM pg_attribute WHERE attrelid='commonswarm_oauth.browser_sessions'::regclass
        AND attname='expires_at' AND NOT attisdropped`)).rows[0];
    assert.equal(shape.attnotnull, true);
    assert.equal(shape.indexed, true);
    assert.equal((await runtime.query(`SELECT count(*)::int AS n FROM commonswarm_oauth.browser_sessions
      WHERE session_hash=$1 AND expires_at > statement_timestamp()`, [hashOpaque(browser)])).rows[0].n, 1);

    assert.equal((await runtime.query("SELECT $1::timestamptz AS expiry", [scalar.expires_at])).rows[0].expiry, Infinity);
    assert.equal((await runtime.query("SELECT $1::timestamptz AS expiry", [original.expires_at])).rows[0].expiry, Infinity);
    const permanentNext = await store.rotateSession(browser); hashes.push(hashOpaque(permanentNext));
    assert.equal(await store.requireSession(browser), null);
    browser = permanentNext; request.sessionId = browser;
    assert.equal((await store.requireSession(browser)).expires_at, "infinity");
    // A genuine finite deadline must survive another callback and rotation.
    const deadline = new Date((now + 3600) * 1000);
    await admin.query("UPDATE commonswarm_oauth.browser_sessions SET expires_at=$2 WHERE session_hash=$1", [hashOpaque(browser), deadline]);
    await store.attachUser(uid, browser, identity);
    let current = browser;
    for (let i = 0; i < 2; i++) {
      const next = await store.rotateSession(current); hashes.push(hashOpaque(next));
      assert.equal(await store.requireSession(current), null);
      const reused = await store.requireSession(next);
      assert.equal(reused.expires_at.getTime(), deadline.getTime());
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
    // Newly proved interactive authentication has no implicit sign-in deadline.
    const freshAuth = randomUUID();
    await admin.query("INSERT INTO auth.sessions(id,user_id) VALUES($1,$2)", [freshAuth, userId]);
    await admin.query(`INSERT INTO auth.mfa_amr_claims(id,session_id,created_at,updated_at,authentication_method)
      VALUES($1,$2,to_timestamp($3),to_timestamp($3),'oauth')`, [randomUUID(), freshAuth, now]);
    await store.attachUser(uid, current, { ...identity, gotrueSessionId: freshAuth, interactiveAuthAtSeconds: now });
    const fresh = await store.requireSession(current);
    assert.equal(fresh.expires_at, "infinity");
    assert.equal(fresh.gotrue_session_id, freshAuth);
    // P1's separate matching-version GoTrue gate owns the real global logout event.
    await admin.query("DELETE FROM auth.sessions WHERE user_id=$1", [userId]);
    assert.equal(await store.requireSession(current), null);
    await assert.rejects(store.rotateSession(current), { code: "interaction_binding_mismatch" });
    assert.equal((await store.requireSession(control)).user_id, controlId);
    const oldAt = now - 31 * 86400;
    await admin.query("UPDATE auth.mfa_amr_claims SET created_at=to_timestamp($1) WHERE session_id=$2", [oldAt, controlAuth]);
    const legacy = new Date((oldAt + 604800) * 1000);
    for (const [name, expiry, invalidated, authTime, expected] of [
      ["exact generated legacy", legacy, null, oldAt, true],
      ["unknown expired finite", new Date(legacy.getTime() - 1000), null, oldAt, false],
      ["invalidated legacy", legacy, new Date(), oldAt, false],
      ["wrong original time", new Date(legacy.getTime() + 1000), null, oldAt + 1, false],
    ]) {
      const probe = await store.createSession(); hashes.push(hashOpaque(probe));
      await admin.query(`UPDATE commonswarm_oauth.browser_sessions SET user_id=$1,gotrue_session_id=$2,
        authenticated_at=to_timestamp($3),expires_at=$4,invalidated_at=$5 WHERE session_hash=$6`,
      [controlId, controlAuth, authTime, expiry, invalidated, hashOpaque(probe)]);
      const result = await store.requireSession(probe);
      assert.equal(result !== null, expected, name);
      const saved = (await admin.query("SELECT expires_at,invalidated_at FROM commonswarm_oauth.browser_sessions WHERE session_hash=$1", [hashOpaque(probe)])).rows[0];
      if (expected) {
        assert.equal(result.expires_at, "infinity");
        assert.equal(result.authenticated_at.getTime(), oldAt * 1000);
        assert.equal(saved.expires_at, Infinity);
        const next = await store.rotateSession(probe); hashes.push(hashOpaque(next));
        assert.equal((await store.requireSession(next)).expires_at, "infinity");
      } else {
        assert.equal(saved.expires_at.getTime(), expiry.getTime(), name);
        assert.equal(saved.invalidated_at?.getTime() ?? null, invalidated?.getTime() ?? null, name);
      }
    }
    // Concurrent readers can adopt only this same live binding, never a new handle.
    const concurrent = await store.createSession(); hashes.push(hashOpaque(concurrent));
    await admin.query(`UPDATE commonswarm_oauth.browser_sessions SET user_id=$1,gotrue_session_id=$2,
      authenticated_at=to_timestamp($3),expires_at=$4 WHERE session_hash=$5`, [controlId, controlAuth, oldAt, legacy, hashOpaque(concurrent)]);
    const winners = await Promise.all([store.requireSession(concurrent), store.requireSession(concurrent)]);
    assert.equal(winners.every(row => row?.expires_at === "infinity" && row.gotrue_session_id === controlAuth), true);
    // Real SQL mutation after the initial live read exercises the CAS/live
    // recheck, rather than mocking the UPDATE result or adding a product hook.
    for (const mutation of ["invalidation", "finite deadline", "original time", "not_after"]) {
      const probe = await store.createSession(); hashes.push(hashOpaque(probe));
      await admin.query(`UPDATE commonswarm_oauth.browser_sessions SET user_id=$1,gotrue_session_id=$2,
        authenticated_at=to_timestamp($3),expires_at=$4 WHERE session_hash=$5`, [controlId, controlAuth, oldAt, legacy, hashOpaque(probe)]);
      let changed = false;
      const racing = new InteractionStore({
        connect: () => runtime.connect(),
        query: async (...args) => {
          const result = await runtime.query(...args);
          if (!changed && result.rows[0]?.session_id === controlAuth) {
            changed = true;
            if (mutation === "not_after") await admin.query("UPDATE auth.sessions SET not_after=statement_timestamp()-interval '1 second' WHERE id=$1", [controlAuth]);
            else await admin.query(`UPDATE commonswarm_oauth.browser_sessions SET ${
              mutation === "invalidation" ? "invalidated_at=statement_timestamp()" :
                mutation === "finite deadline" ? "expires_at=expires_at-interval '1 second'" :
                  "authenticated_at=authenticated_at+interval '1 second'"} WHERE session_hash=$1`, [hashOpaque(probe)]);
          }
          return result;
        },
      });
      assert.equal(await racing.requireSession(probe), null, mutation);
      assert.equal(changed, true, "mutation reached the initial live proof");
      assert.notEqual((await admin.query("SELECT expires_at FROM commonswarm_oauth.browser_sessions WHERE session_hash=$1", [hashOpaque(probe)])).rows[0].expires_at, Infinity, mutation);
      await admin.query("UPDATE auth.sessions SET not_after=NULL WHERE id=$1", [controlAuth]);
      assert.equal((await store.requireSession(concurrent)).expires_at, "infinity", "live control remains reusable");
    }
    // Legacy adoption still enforces GoTrue not_after, ban and soft deletion.
    for (const [denySql, undoSql] of [
      ["UPDATE auth.sessions SET not_after=statement_timestamp()-interval '1 second' WHERE id=$1", "UPDATE auth.sessions SET not_after=NULL WHERE id=$1"],
      ["UPDATE auth.users SET banned_until=statement_timestamp()+interval '1 hour' WHERE id=$1", "UPDATE auth.users SET banned_until=NULL WHERE id=$1"],
      ["UPDATE auth.users SET deleted_at=statement_timestamp() WHERE id=$1", "UPDATE auth.users SET deleted_at=NULL WHERE id=$1"],
    ]) {
      const probe = await store.createSession(); hashes.push(hashOpaque(probe));
      await admin.query(`UPDATE commonswarm_oauth.browser_sessions SET user_id=$1,gotrue_session_id=$2,
        authenticated_at=to_timestamp($3),expires_at=$4 WHERE session_hash=$5`, [controlId, controlAuth, oldAt, legacy, hashOpaque(probe)]);
      const target = denySql.includes("auth.sessions") ? controlAuth : controlId;
      await admin.query(denySql, [target]);
      assert.equal(await store.requireSession(probe), null);
      assert.equal((await admin.query("SELECT expires_at FROM commonswarm_oauth.browser_sessions WHERE session_hash=$1", [hashOpaque(probe)])).rows[0].expires_at.getTime(), legacy.getTime());
      await admin.query(undoSql, [target]);
      assert.equal((await store.requireSession(probe)).expires_at, "infinity", "same-lane live positive control");
    }
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
