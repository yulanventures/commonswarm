import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { Pool } from "pg";

import { createPostgresAdapter } from "../src/postgres-adapter.js";
import { fixture as adminFixture, localClusterAdminUrl } from "../../../tests/support/admin-schema-db.ts";

const databaseUrl = process.env.MCP_OAUTH_TEST_DATABASE_URL ??
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const admin = new Pool({ connectionString: databaseUrl, max: 4 });
const runtimePassword = randomUUID();
const runtimeDatabaseUrl = new URL(databaseUrl);
runtimeDatabaseUrl.username = "commonswarm_oauth_runtime";
runtimeDatabaseUrl.password = runtimePassword;
const runtime = new Pool({ connectionString: runtimeDatabaseUrl.toString(), max: 2 });
let runtimePasswordConfigured = false;

before(async () => {
  const result = await admin.query("SELECT to_regclass('commonswarm_oauth.provider_artifacts') AS table_name");
  assert.ok(result.rows[0]?.table_name, "run the OAuth migration before the PostgreSQL adapter suite");
  await admin.query(`ALTER ROLE commonswarm_oauth_runtime PASSWORD '${runtimePassword}'`);
  runtimePasswordConfigured = true;
});

after(async () => {
  await runtime.end();
  if (runtimePasswordConfigured) {
    await admin.query("ALTER ROLE commonswarm_oauth_runtime PASSWORD NULL");
  }
  await admin.end();
});

async function cleanup(grantId) {
  await admin.query("DELETE FROM commonswarm_oauth.provider_artifacts WHERE grant_id = $1", [grantId]);
  // Unique test families retain their immutable tombstones until the disposable
  // CI database is destroyed. Cleanup must never undo a durable replay fence.
}

test("two independent connections permit exactly one refresh consume and the winner rotates", async () => {
  const grantId = `race-${randomUUID()}`;
  const tokenId = `refresh-${randomUUID()}`;
  const replacementId = `refresh-${randomUUID()}`;
  const firstPool = new Pool({ connectionString: databaseUrl, max: 1 });
  const secondPool = new Pool({ connectionString: databaseUrl, max: 1 });
  const first = createPostgresAdapter(firstPool)("RefreshToken");
  const second = createPostgresAdapter(secondPool)("RefreshToken");
  try {
    await first.upsert(tokenId, { grantId, kind: "RefreshToken", jti: tokenId }, 3600);
    const persisted = await admin.query(
      `SELECT artifact_id_hash, payload::text AS payload
         FROM commonswarm_oauth.provider_artifacts WHERE grant_id = $1`,
      [grantId],
    );
    assert.equal(persisted.rows[0].artifact_id_hash.length, 43);
    assert.notEqual(persisted.rows[0].artifact_id_hash, tokenId);
    assert.equal(persisted.rows[0].payload.includes(tokenId), false);
    const outcomes = await Promise.allSettled([first.consume(tokenId), second.consume(tokenId)]);
    assert.equal(outcomes.filter(({ status }) => status === "fulfilled").length, 1);
    const rejected = outcomes.find(({ status }) => status === "rejected");
    assert.equal(rejected.reason.error, "invalid_grant");

    await first.upsert(replacementId, { grantId, kind: "RefreshToken", jti: replacementId }, 3600);
    assert.equal((await second.find(replacementId)).grantId, grantId);
    await second.consume(replacementId);
    assert.equal(typeof (await first.find(replacementId)).consumed, "number");
  } finally {
    await firstPool.end();
    await secondPool.end();
    await cleanup(grantId);
  }
});

test("sequential replay creates a durable family tombstone and prevents resurrection", async () => {
  const grantId = `replay-${randomUUID()}`;
  const oldId = `refresh-${randomUUID()}`;
  const newId = `refresh-${randomUUID()}`;
  const adapter = createPostgresAdapter(admin)("RefreshToken");
  try {
    await adapter.upsert(oldId, { grantId, kind: "RefreshToken" }, 3600);
    await adapter.consume(oldId);
    await adapter.upsert(newId, { grantId, kind: "RefreshToken" }, 3600);
    assert.equal(typeof (await adapter.find(oldId)).consumed, "number",
      "the provider must observe consumed state and enter its replay path");
    await adapter.revokeByGrantId(grantId);
    assert.equal(await adapter.find(newId), undefined);
    await assert.rejects(
      adapter.upsert(`refresh-${randomUUID()}`, { grantId, kind: "RefreshToken" }, 3600),
      (error) => error.error === "invalid_grant",
    );
    const tombstone = await admin.query(
      "SELECT 1 FROM commonswarm_oauth.refresh_family_tombstones WHERE grant_id = $1",
      [grantId],
    );
    assert.equal(tombstone.rowCount, 1);
  } finally {
    await cleanup(grantId);
  }
});

test("upsert conflict preserves consumption while a new artifact remains usable", async () => {
  const grantId = `conflict-${randomUUID()}`;
  const consumedId = `refresh-${randomUUID()}`;
  const freshId = `refresh-${randomUUID()}`;
  const adapter = createPostgresAdapter(admin)("RefreshToken");
  try {
    await adapter.upsert(consumedId, { grantId, kind: "RefreshToken" }, 3600);
    await adapter.consume(consumedId);
    await adapter.upsert(consumedId, { grantId, kind: "RefreshToken", rotations: 1 }, 3600);
    assert.equal(typeof (await adapter.find(consumedId)).consumed, "number");
    await adapter.upsert(freshId, { grantId, kind: "RefreshToken" }, 3600);
    assert.equal((await adapter.find(freshId)).consumed, undefined);
  } finally {
    await cleanup(grantId);
  }
});

test("a crash after consume remains durable and replay revocation survives restart", async () => {
  const grantId = `crash-${randomUUID()}`;
  const tokenId = `refresh-${randomUUID()}`;
  const writerPool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const writer = createPostgresAdapter(writerPool)("RefreshToken");
    await writer.upsert(tokenId, { grantId, kind: "RefreshToken" }, 3600);
    await writer.consume(tokenId);
    await writerPool.end();

    const restartedPool = new Pool({ connectionString: databaseUrl, max: 1 });
    try {
      const restarted = createPostgresAdapter(restartedPool)("RefreshToken");
      assert.equal(typeof (await restarted.find(tokenId)).consumed, "number");
      await restarted.revokeByGrantId(grantId);
      assert.equal(await restarted.find(tokenId), undefined);
    } finally {
      await restartedPool.end();
    }
  } finally {
    if (!writerPool.ended) await writerPool.end();
    await cleanup(grantId);
  }
});

test("runtime role has only OAuth DML and client roles have no artifact access", async () => {
  const client = await runtime.connect();
  const artifactHash = createHash("sha256").update(randomUUID()).digest("base64url");
  const tombstoneGrant = `privilege-${randomUUID()}`;
  try {
    assert.equal((await client.query("SELECT current_user AS role")).rows[0].role,
      "commonswarm_oauth_runtime");
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO commonswarm_oauth.provider_artifacts
        (model, artifact_id_hash, payload, created_at, updated_at)
       VALUES ('Session', $1, '{}'::jsonb, statement_timestamp(), statement_timestamp())`,
      [artifactHash],
    );
    assert.equal((await client.query(
      "SELECT count(*)::int AS count FROM commonswarm_oauth.provider_artifacts WHERE model = 'Session' AND artifact_id_hash = $1",
      [artifactHash],
    )).rows[0].count, 1);
    await client.query(
      `INSERT INTO commonswarm_oauth.refresh_family_tombstones (grant_id, revoked_at)
       VALUES ($1, statement_timestamp())`,
      [tombstoneGrant],
    );
    assert.equal((await client.query(
      "SELECT count(*)::int AS count FROM commonswarm_oauth.refresh_family_tombstones WHERE grant_id = $1",
      [tombstoneGrant],
    )).rows[0].count, 1);
    await client.query("SAVEPOINT denied_tombstone_update");
    await assert.rejects(
      client.query(
        "UPDATE commonswarm_oauth.refresh_family_tombstones SET revoked_at = statement_timestamp() WHERE grant_id = $1",
        [tombstoneGrant],
      ),
      (error) => error.code === "42501",
    );
    await client.query("ROLLBACK TO SAVEPOINT denied_tombstone_update");
    assert.equal((await client.query(
      "SELECT count(*)::int AS count FROM commonswarm_oauth.refresh_family_tombstones WHERE grant_id = $1",
      [tombstoneGrant],
    )).rows[0].count, 1);
    await client.query("SAVEPOINT denied_tombstone_delete");
    await assert.rejects(
      client.query(
        "DELETE FROM commonswarm_oauth.refresh_family_tombstones WHERE grant_id = $1",
        [tombstoneGrant],
      ),
      (error) => error.code === "42501",
    );
    await client.query("ROLLBACK TO SAVEPOINT denied_tombstone_delete");
    assert.equal((await client.query(
      "SELECT count(*)::int AS count FROM commonswarm_oauth.refresh_family_tombstones WHERE grant_id = $1",
      [tombstoneGrant],
    )).rows[0].count, 1);
    await assert.rejects(
      client.query("SELECT 1 FROM swarm.workspaces LIMIT 1"),
      (error) => error.code === "42501",
    );
    await client.query("ROLLBACK");

    await client.query("BEGIN");
    assert.equal((await client.query(
      "SELECT count(*)::int AS count FROM commonswarm_oauth.provider_artifacts",
    )).rows[0].count >= 0, true);
    await client.query("ROLLBACK");

    const clientRole = await admin.connect();
    try {
      await clientRole.query("BEGIN");
      await clientRole.query("SET LOCAL ROLE authenticated");
      await assert.rejects(
        clientRole.query("SELECT 1 FROM commonswarm_oauth.provider_artifacts LIMIT 1"),
        (error) => error.code === "42501",
      );
      await clientRole.query("ROLLBACK");
    } finally {
      await clientRole.query("ROLLBACK").catch(() => {});
      clientRole.release();
    }
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
    await admin.query(
      "DELETE FROM commonswarm_oauth.provider_artifacts WHERE model = 'Session' AND artifact_id_hash = $1",
      [artifactHash],
    );
    // The privilege probe's tombstone INSERT was rolled back above.
  }
});

// S2 owner boundary: application migrations create all tables/functions. These
// disposable rows use real immutable tuple guards and the real OAuth login role.
async function hostedClients({ clients = 1, families = 2, unboundLast = false } = {}) {
  const owner = randomUUID(), workspaces = [randomUUID(),randomUUID()].sort();
  await admin.query("INSERT INTO auth.users(id,aud,role,email) VALUES($1,'authenticated','authenticated',$2)", [owner,`${owner}@example.test`]);
  await admin.query("INSERT INTO swarm.users(user_id,display_name) VALUES($1,'S2 disposable owner')", [owner]);
  const streams = [];
  for (const workspace of workspaces) {
    const stream = randomUUID(); streams.push(stream);
    await admin.query("INSERT INTO swarm.workspaces(workspace_id,name,created_by) VALUES($1,'S2 disposable workspace',$2)", [workspace,owner]);
    await admin.query("INSERT INTO swarm.memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')", [workspace,owner]);
    await admin.query("INSERT INTO swarm.streams(stream_id,workspace_id,kind) VALUES($1,$2,'workspace')", [stream,workspace]);
  }
  const registrations = [], grants = [];
  for (let c = 0; c < clients; c += 1) {
    const clientId = `s2-${randomUUID()}`; registrations.push(clientId);
    await admin.query(`INSERT INTO commonswarm_oauth.registered_clients(client_id,metadata,registered_at,expires_at)
      VALUES($1,$2::jsonb,clock_timestamp()-interval '90 days',clock_timestamp()-interval '1 day')`, [clientId,JSON.stringify({ client_id: clientId })]);
    for (let i = 0; i < families; i += 1) {
      // A: W2,W1; B: W1,W2. Family-ID iteration alone cannot order streams.
      const workspace = workspaces[(i+c+1)%2], id = randomUUID(), family = `s2-${c}-${i}-${randomUUID()}`;
      const manifest = createHash('sha256').update(JSON.stringify([workspace])).digest();
      await admin.query(`INSERT INTO swarm.hosted_mcp_grants
        (grant_id,provider_grant_id,owner_user_id,home_workspace_id,client_id,resource,
         selected_workspace_ids,manifest_digest,interaction_ref,state,created_at,activated_at)
        VALUES($1,$2,$3,$4,$5,'https://mcp.commonswarm.com/mcp',ARRAY[$4]::uuid[],$6,$7,'active',clock_timestamp(),clock_timestamp())`,
      [id,family,owner,workspace,clientId,manifest,randomUUID()]);
      await admin.query(`INSERT INTO swarm.hosted_mcp_grant_workspaces
        (grant_id,workspace_id,owner_user_id,manifest_digest,consent_receipt_id,consented_at)
        VALUES($1,$2,$3,$4,$5,clock_timestamp())`, [id,workspace,owner,manifest,randomUUID()]);
      if (!(unboundLast && i === families-1)) await admin.query(`INSERT INTO commonswarm_oauth.provider_grant_resources
        (provider_grant_id,resource,grant_class,owner_user_id,client_id,connection_id,hosted_grant_id)
        VALUES($1,'https://mcp.commonswarm.com/mcp','hosted_mcp',$2,$3,$4,$4)`, [family,owner,clientId,id]);
      grants.push({ id,family,clientId,owner,workspace });
    }
  }
  // Immutable binding rows and replay evidence remain in the disposable DB.
  return { owner,workspaces,streams,registrations,grants };
}
const mcp = 'https://mcp.commonswarm.com/mcp';
const hash = id => createHash('sha256').update(id).digest('base64url');
const grantPayload = g => ({ accountId: g.owner,clientId: g.clientId,resources: { [mcp]: 'mcp' },exp: Math.floor(Date.now()/1000)+60 });
const refreshPayload = g => ({ accountId: g.owner,clientId: g.clientId,grantId: g.family,resource: mcp,
  scope: 'mcp',expiresWithSession: true,exp: Math.floor(Date.now()/1000)+60 });
async function artifact(model,id) {
  return (await admin.query('SELECT * FROM commonswarm_oauth.provider_artifacts WHERE model=$1 AND artifact_id_hash=$2',[model,hash(id)])).rows[0];
}
// Read durable storage independently of the adapter, including Grant's exact
// model/id identity (its grant_id is NULL).
async function familyStorage(g) {
  return (await admin.query(`SELECT
    (SELECT count(*)::int FROM commonswarm_oauth.refresh_family_tombstones WHERE grant_id=$1) AS tombstones,
    (SELECT count(*)::int FROM commonswarm_oauth.provider_artifacts WHERE grant_id=$1) AS artifacts,
    (SELECT count(*)::int FROM commonswarm_oauth.provider_artifacts WHERE model='Grant' AND artifact_id_hash=$2) AS exact_grant`,
  [g.family,hash(g.family)])).rows[0];
}
async function waitOnBackend(pid) {
  const until = Date.now()+5000;
  while (Date.now()<until) {
    if ((await admin.query("SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1",[pid])).rows[0]?.waiting) return;
    await new Promise(resolve => setTimeout(resolve,20));
  }
  assert.fail('real runtime backend did not reach the expected lock wait');
}

test('hosted persistence uses the owner deadline, rescues old leases, and keeps finite controls', async () => {
  const f = await hostedClients(), [g,pending] = f.grants;
  const adapters = createPostgresAdapter(runtime), grant = adapters('Grant'), rt = adapters('RefreshToken');
  const token = randomUUID();
  const input = refreshPayload(g);
  await grant.upsert(g.family,grantPayload(g),60);
  await rt.upsert(token,input,60);
  assert.ok(input.exp, 'normalization does not mutate caller payload');
  assert.equal((await artifact('Grant',g.family)).grant_id,null,'Grant identity is its id/jti, not grant_id');
  for (const [model,id] of [['Grant',g.family],['RefreshToken',token]]) {
    const row = await artifact(model,id);
    assert.equal(row.expires_at,null); assert.equal(Object.hasOwn(row.payload,'exp'),false);
  }
  assert.equal((await rt.find(token)).expiresWithSession,false);
  const future = (await admin.query("SELECT clock_timestamp()+interval '180 days' AS deadline")).rows[0].deadline;
  await admin.query('UPDATE swarm.hosted_mcp_grants SET connection_expires_at=$2 WHERE grant_id=$1',[g.id,future]);
  // Retained legacy objects simulate a visit after the obsolete 30-day lease.
  await admin.query(`UPDATE commonswarm_oauth.provider_artifacts SET expires_at=clock_timestamp()-interval '1 day',
    payload=jsonb_set(payload,'{exp}',to_jsonb(extract(epoch FROM clock_timestamp()-interval '1 day')::bigint))
    WHERE (model='Grant' AND artifact_id_hash=$1) OR (model='RefreshToken' AND artifact_id_hash=$2)`,[hash(g.family),hash(token)]);
  assert.ok(await grant.find(g.family)); assert.ok(await rt.find(token));
  assert.equal((await artifact('RefreshToken',token)).expires_at.getTime(),future.getTime());
  // A successful pre-expiry owner extension and then clear must be honored
  // even when the next visit sees an older, already elapsed stored expiry.
  for (const deadline of [new Date(future.getTime()+86400000),null]) {
    await admin.query('UPDATE swarm.hosted_mcp_grants SET connection_expires_at=$2 WHERE grant_id=$1',[g.id,deadline]);
    await admin.query(`UPDATE commonswarm_oauth.provider_artifacts SET expires_at=clock_timestamp()-interval '1 second',
      payload=jsonb_set(payload,'{exp}',to_jsonb(extract(epoch FROM clock_timestamp()-interval '1 second')::bigint))
      WHERE model='RefreshToken' AND artifact_id_hash=$1`,[hash(token)]);
    assert.ok(await rt.find(token));
    const row = await artifact('RefreshToken',token);
    assert.equal(row.expires_at?.getTime() ?? null,deadline?.getTime() ?? null);
    assert.equal(Object.hasOwn(row.payload,'exp'),deadline !== null);
  }
  await admin.query("UPDATE swarm.hosted_mcp_grants SET state='pending',activated_at=NULL WHERE grant_id=$1",[pending.id]);
  await grant.upsert(pending.family,grantPayload(pending),60);
  const unbound = randomUUID(); await grant.upsert(unbound,{ clientId: g.clientId,accountId: g.owner },60);
  for (const id of [pending.family,unbound]) assert.ok((await artifact('Grant',id)).expires_at > new Date());
  for (const model of ['Session','Interaction','AccessToken','AuthorizationCode']) {
    const id = randomUUID();
    await adapters(model).upsert(id,model === 'AccessToken' || model === 'AuthorizationCode' ? refreshPayload(g) : { uid: randomUUID() },60);
    assert.ok((await artifact(model,id)).expires_at > new Date(),`${model} stays finite`);
  }
  await rt.consume(token);
  const consumed = await artifact('RefreshToken',token);
  await rt.upsert(token,refreshPayload(g),60);
  assert.deepEqual(await artifact('RefreshToken',token),consumed,'a conflicting save preserves the complete consumed snapshot');
  await assert.rejects(rt.consume(token),e => e.error === 'invalid_grant');
  await rt.revokeByGrantId(g.family);
  assert.equal(await grant.find(g.family),undefined,'Grant jti is covered by the family tombstone');
  await assert.rejects(rt.upsert(randomUUID(),refreshPayload(g),60),e => e.error === 'invalid_grant');
});

test('two clients with reversed multi-family streams complete in both start orders under runtime roles', { timeout: 30000 }, async () => {
  const { createPostgresRegistrationStore } = await import('../src/registration.js');
  const f = await hostedClients({ clients: 2 }), store = createPostgresRegistrationStore(runtime);
  const connectionA = await runtime.connect(), connectionB = await runtime.connect();
  try {
    for (const order of [[0,1],[1,0]]) {
      const connections = [connectionA,connectionB];
      await Promise.all(connections.map(c => c.query('BEGIN')));
      await Promise.all(connections.map((c,i) => c.query('SELECT client_id FROM commonswarm_oauth.registered_clients WHERE client_id=$1 FOR UPDATE',[f.registrations[i]])));
      const blocker = await admin.connect();
      let tasks = [];
      try {
        await blocker.query('BEGIN'); await blocker.query('SELECT stream_id FROM swarm.streams WHERE stream_id=$1 FOR UPDATE',[f.streams[0]]);
        const run = async index => {
          const c = connections[index];
          await c.query("SET LOCAL statement_timeout='8s'");
          const bindings = (await c.query('SELECT * FROM commonswarm_oauth.lock_hosted_client_streams($1)',[f.registrations[index]])).rows;
          assert.equal(bindings.length,2);
          for (const b of bindings) assert.equal((await c.query('SELECT * FROM commonswarm_oauth.lock_hosted_family($1,$2::uuid,$3,$4)',
            [b.provider_grant_id,b.owner_user_id,b.client_id,b.resource])).rows[0].active,true);
          await c.query('COMMIT');
        };
        tasks.push(run(order[0])); await waitOnBackend(connections[order[0]].processID);
        tasks.push(run(order[1])); await waitOnBackend(connections[order[1]].processID);
        await blocker.query('COMMIT'); await Promise.all(tasks);
      } finally {
        await blocker.query('ROLLBACK').catch(() => {}); blocker.release();
        await Promise.allSettled(tasks);
        await Promise.all(connections.map(c => c.query('ROLLBACK')));
      }
    }
  } finally { connectionA.release(); connectionB.release(); }
  const metadata = await Promise.all(f.registrations.map(id => store.find(id)));
  assert.ok(metadata.every(Boolean));
  await store.cleanup();
  const restarted = createPostgresRegistrationStore(runtime);
  for (const id of f.registrations) {
    assert.ok(await restarted.find(id));
    assert.equal((await admin.query('SELECT expires_at FROM commonswarm_oauth.registered_clients WHERE client_id=$1',[id])).rows[0].expires_at,null);
  }
});

test('DCR retains shared NULL/future families, honors changed policy, and deletes expired unused registrations', async () => {
  const { createPostgresRegistrationStore } = await import('../src/registration.js');
  const f = await hostedClients(), [g,other] = f.grants, id = g.clientId;
  const store = createPostgresRegistrationStore(runtime);
  const future = new Date(Date.now()+180*86400000), later = new Date(Date.now()+210*86400000);
  await admin.query('UPDATE swarm.hosted_mcp_grants SET connection_expires_at=$2 WHERE grant_id=$1',[g.id,future]);
  assert.ok(await store.find(id));
  assert.equal((await admin.query('SELECT expires_at FROM commonswarm_oauth.registered_clients WHERE client_id=$1',[id])).rows[0].expires_at,null,'one unbounded sibling retains the shared client');
  await admin.query('UPDATE swarm.hosted_mcp_grants SET connection_expires_at=$2 WHERE grant_id=$1',[other.id,later]);
  await store.markUsed(id);
  assert.equal((await admin.query('SELECT expires_at FROM commonswarm_oauth.registered_clients WHERE client_id=$1',[id])).rows[0].expires_at.getTime(),later.getTime());
  assert.ok((await store.list(1000)).some(row => row.client_id === id));
  // Find must reconcile retained raw candidates before rejecting an old idle
  // deadline, for both future and cleared canonical owner policies.
  for (const policy of [future,null]) {
    await admin.query('UPDATE swarm.hosted_mcp_grants SET connection_expires_at=$2 WHERE grant_id=$1',[g.id,policy]);
    await admin.query("UPDATE commonswarm_oauth.registered_clients SET expires_at=clock_timestamp()-interval '1 day' WHERE client_id=$1",[id]);
    assert.ok(await store.find(id));
    const expiry = (await admin.query('SELECT expires_at FROM commonswarm_oauth.registered_clients WHERE client_id=$1',[id])).rows[0].expires_at;
    assert.equal(expiry?.getTime() ?? null,policy === null ? null : later.getTime());
  }
  await admin.query('UPDATE swarm.hosted_mcp_grants SET connection_expires_at=$2 WHERE grant_id=$1',[g.id,future]);
  // Preserve an unrelated later legitimate registration bound.
  const unrelated = new Date(later.getTime()+86400000);
  await admin.query('UPDATE commonswarm_oauth.registered_clients SET expires_at=$2 WHERE client_id=$1',[id,unrelated]);
  await store.markUsed(id);
  assert.equal((await admin.query('SELECT expires_at FROM commonswarm_oauth.registered_clients WHERE client_id=$1',[id])).rows[0].expires_at.getTime(),unrelated.getTime());
  const unused = `unused-${randomUUID()}`;
  await admin.query(`INSERT INTO commonswarm_oauth.registered_clients(client_id,metadata,registered_at,expires_at)
    VALUES($1,'{}',clock_timestamp()-interval '40 days',clock_timestamp()-interval '1 day')`,[unused]);
  await store.markUsed(unused);
  assert.equal(await store.find(unused),undefined,'use bookkeeping cannot revive an expired unused client');
  assert.ok(await store.cleanup() >= 1);
  assert.equal((await admin.query('SELECT 1 FROM commonswarm_oauth.registered_clients WHERE client_id=$1',[unused])).rowCount,0);
  assert.ok(await createPostgresRegistrationStore(runtime).find(id),'live shared client survives cleanup and restart');
});

test('post-wait owner extension, clear, removal and elapsed policy control retained refresh artifacts', { timeout: 30000 }, async () => {
  const f = await hostedClients({ families: 4 });
  const rt = createPostgresAdapter(runtime)('RefreshToken');
  for (const [index,change] of ['extend','clear','remove','elapsed'].entries()) {
    const g = f.grants[index], token = randomUUID();
    await rt.upsert(token,refreshPayload(g),60);
    const blocker = await admin.connect(), c = await runtime.connect();
    const single = { query: (...a) => c.query(...a),connect: async () => ({ query: (...a) => c.query(...a),release() {} }) };
    let pending;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT stream_id FROM swarm.streams WHERE workspace_id=$1 AND kind=\'workspace\' FOR UPDATE',[g.workspace]);
      pending = createPostgresAdapter(single)('RefreshToken').find(token);
      await waitOnBackend(c.processID);
      if (change === 'remove') await blocker.query('UPDATE swarm.hosted_mcp_grant_workspaces SET revoked_at=clock_timestamp() WHERE grant_id=$1',[g.id]);
      else await blocker.query(`UPDATE swarm.hosted_mcp_grants SET connection_expires_at=
        CASE $2 WHEN 'extend' THEN clock_timestamp()+interval '180 days' WHEN 'elapsed' THEN clock_timestamp()-interval '1 second' ELSE NULL END
        WHERE grant_id=$1`,[g.id,change]);
      await blocker.query('COMMIT');
      const result = await pending;
      assert.equal(Boolean(result),change === 'extend' || change === 'clear',change);
      if (change === 'clear') assert.equal(Object.hasOwn(result,'exp'),false);
      if (change === 'extend') assert.ok(result.exp > Date.now()/1000+100*86400);
    } finally {
      await blocker.query('ROLLBACK').catch(() => {}); blocker.release();
      if (pending) await Promise.allSettled([pending]); c.release();
    }
  }
});

test('the final artifact wait uses a fresh database clock and cannot promote an elapsed family', { timeout: 15000 }, async () => {
  const f = await hostedClients(), g = f.grants[0], token = randomUUID();
  const adapters = createPostgresAdapter(runtime), rt = adapters('RefreshToken');
  await adapters('Grant').upsert(g.family,grantPayload(g),60);
  await rt.upsert(token,refreshPayload(g),60);
  assert.deepEqual(await familyStorage(g),{ tombstones: 0,artifacts: 1,exact_grant: 1 });
  const blocker = await admin.connect(), c = await runtime.connect();
  let pending;
  try {
    await blocker.query('BEGIN');
    await blocker.query("SELECT 1 FROM commonswarm_oauth.provider_artifacts WHERE model='RefreshToken' AND artifact_id_hash=$1 FOR UPDATE",[hash(token)]);
    await admin.query("UPDATE swarm.hosted_mcp_grants SET connection_expires_at=clock_timestamp()+interval '2 seconds' WHERE grant_id=$1",[g.id]);
    const single = { query: (...a) => c.query(...a),connect: async () => ({ query: (...a) => c.query(...a),release() {} }) };
    pending = createPostgresAdapter(single)('RefreshToken').find(token); await waitOnBackend(c.processID);
    await blocker.query('SELECT pg_sleep(2.1)'); await blocker.query('COMMIT');
    assert.equal(await pending,undefined);
    assert.equal((await admin.query('SELECT connection_expires_at <= clock_timestamp() AS elapsed FROM swarm.hosted_mcp_grants WHERE grant_id=$1',[g.id])).rows[0].elapsed,true);
    assert.deepEqual(await familyStorage(g),{ tombstones: 1,artifacts: 0,exact_grant: 0 },
      'an elapsed owner date commits terminal retirement before lookup returns');
    assert.equal(await artifact('RefreshToken',token),undefined);
    assert.equal(await artifact('Grant',g.family),undefined);
  } finally {
    await blocker.query('ROLLBACK').catch(() => {}); blocker.release();
    if (pending) await Promise.allSettled([pending]); c.release();
  }
});

test('client stream helper grants only the existing runtime read/lock boundary', async () => {
  const f = await hostedClients();
  assert.equal((await runtime.query('SELECT * FROM commonswarm_oauth.lock_hosted_client_streams($1)',[f.registrations[0]])).rowCount,2);
  const client = await admin.connect();
  try {
    assert.equal((await admin.query("SELECT has_function_privilege('commonswarm_oauth_runtime','commonswarm_oauth.lock_hosted_client_streams(text)','EXECUTE') AS allowed")).rows[0].allowed,true);
    for (const role of ['anon','authenticated','swarm_read','swarm_command']) {
      assert.equal((await admin.query("SELECT has_function_privilege($1::name,'commonswarm_oauth.lock_hosted_client_streams(text)','EXECUTE') AS allowed",[role])).rows[0].allowed,false,'execute ACL is checked independently of schema usage');
      await client.query('BEGIN'); await client.query(`SET LOCAL ROLE ${role}`);
      await assert.rejects(client.query('SELECT * FROM commonswarm_oauth.lock_hosted_client_streams($1)',[f.registrations[0]]),e => e.code === '42501');
      await client.query('ROLLBACK');
    }
    await assert.rejects(runtime.query('UPDATE swarm.hosted_mcp_grants SET connection_expires_at=NULL WHERE grant_id=$1',[f.grants[0].id]),e => e.code === '42501');
  } finally { await client.query('ROLLBACK').catch(() => {}); client.release(); }
});

test('activation and promotion retry independently, and a pending/removed Grant cannot be promoted', async () => {
  const f = await hostedClients(), [g,removed] = f.grants;
  const grant = createPostgresAdapter(runtime)('Grant');
  for (const row of [g,removed]) {
    await admin.query("UPDATE swarm.hosted_mcp_grants SET state='pending',activated_at=NULL WHERE grant_id=$1",[row.id]);
    await grant.upsert(row.family,grantPayload(row),60);
  }
  const promote = row => grant.promoteHostedGrant(row.family,{ hostedGrantId: row.id,accountId: row.owner,clientId: row.clientId });
  await assert.rejects(promote(g),e => e.error === 'invalid_grant');
  assert.ok((await artifact('Grant',g.family)).expires_at > new Date(),'pending failure remains finite');
  assert.deepEqual(await familyStorage(g),{ tombstones: 0,artifacts: 0,exact_grant: 1 });
  await admin.query("UPDATE swarm.hosted_mcp_grants SET state='active',activated_at=clock_timestamp() WHERE grant_id=$1",[g.id]);
  await promote(g); await promote(g);
  assert.equal((await artifact('Grant',g.family)).expires_at,null,'idempotent retry promotes the existing exact Grant');
  await admin.query("UPDATE swarm.hosted_mcp_grants SET state='revoked',revoked_at=clock_timestamp() WHERE grant_id=$1",[removed.id]);
  await assert.rejects(promote(removed),e => e.error === 'invalid_grant');
  assert.deepEqual(await familyStorage(removed),{ tombstones: 1,artifacts: 0,exact_grant: 0 },
    'revoked promotion commits retirement despite returning invalid_grant');
  assert.equal(await artifact('Grant',removed.family),undefined);
});

test('concurrent new binding serializes behind DCR retention before joining its candidate set', { timeout: 20000 }, async () => {
  const { createPostgresRegistrationStore } = await import('../src/registration.js');
  const f = await hostedClients({ families: 3,unboundLast: true }), g = f.grants[2];
  await createPostgresAdapter(runtime)('Grant').upsert(g.family,grantPayload(g),60);
  const a = await runtime.connect(), b = await runtime.connect(), blocker = await admin.connect();
  const single = c => ({ query: (...args) => c.query(...args),connect: async () => ({ query: (...args) => c.query(...args),release() {} }) });
  let retention, promotion;
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT stream_id FROM swarm.streams WHERE stream_id=$1 FOR UPDATE',[f.streams[0]]);
    retention = createPostgresRegistrationStore(single(a)).find(g.clientId); await waitOnBackend(a.processID);
    promotion = createPostgresAdapter(single(b))('Grant').promoteHostedGrant(g.family,{ hostedGrantId: g.id,accountId: g.owner,clientId: g.clientId });
    await waitOnBackend(b.processID);
    assert.equal((await admin.query('SELECT 1 FROM commonswarm_oauth.provider_grant_resources WHERE provider_grant_id=$1',[g.family])).rowCount,0,'new immutable binding waits behind the existing client row');
    await blocker.query('COMMIT');
    assert.ok(await retention); await promotion;
    assert.equal((await artifact('Grant',g.family)).expires_at,null);
    assert.ok(await createPostgresRegistrationStore(single(a)).find(g.clientId));
    assert.equal((await a.query('SELECT * FROM commonswarm_oauth.lock_hosted_client_streams($1)',[g.clientId])).rowCount,3);
  } finally {
    await blocker.query('ROLLBACK').catch(() => {}); blocker.release();
    await Promise.allSettled([retention,promotion].filter(Boolean)); a.release(); b.release();
  }
});

test('DCR reconciliation rechecks removal after a stream wait before retaining or deleting a client', { timeout: 20000 }, async () => {
  const { createPostgresRegistrationStore } = await import('../src/registration.js');
  const f = await hostedClients(), [g,pending] = f.grants;
  await admin.query("UPDATE swarm.hosted_mcp_grants SET state='pending',activated_at=NULL WHERE grant_id=$1",[pending.id]);
  const store = createPostgresRegistrationStore(runtime);
  assert.ok(await store.find(g.clientId),'same-invocation active-family positive control');
  const blocker = await admin.connect(), c = await runtime.connect();
  const single = { query: (...a) => c.query(...a),connect: async () => ({ query: (...a) => c.query(...a),release() {} }) };
  let waiting;
  try {
    await blocker.query('BEGIN');
    await blocker.query("SELECT stream_id FROM swarm.streams WHERE workspace_id=$1 AND kind='workspace' FOR UPDATE",[g.workspace]);
    waiting = createPostgresRegistrationStore(single).find(g.clientId); await waitOnBackend(c.processID);
    await blocker.query('UPDATE swarm.hosted_mcp_grant_workspaces SET revoked_at=clock_timestamp() WHERE grant_id=$1',[g.id]);
    await blocker.query('COMMIT');
    assert.equal(await waiting,undefined,'a pending sibling does not retain the removed live family');
  } finally {
    await blocker.query('ROLLBACK').catch(() => {}); blocker.release();
    if (waiting) await Promise.allSettled([waiting]); c.release();
  }
  await store.cleanup();
  assert.equal((await admin.query('SELECT 1 FROM commonswarm_oauth.registered_clients WHERE client_id=$1',[g.clientId])).rowCount,0);
});

test('refresh normalization can finish before a waiting removal, which fences the following use', { timeout: 20000 }, async () => {
  const f = await hostedClients(), g = f.grants[0], token = randomUUID();
  const rt = createPostgresAdapter(runtime)('RefreshToken'); await rt.upsert(token,refreshPayload(g),60);
  const blocker = await admin.connect(), remover = await admin.connect(), c = await runtime.connect();
  const single = { query: (...a) => c.query(...a),connect: async () => ({ query: (...a) => c.query(...a),release() {} }) };
  let refresh, removal;
  try {
    await blocker.query('BEGIN');
    await blocker.query("SELECT 1 FROM commonswarm_oauth.provider_artifacts WHERE model='RefreshToken' AND artifact_id_hash=$1 FOR UPDATE",[hash(token)]);
    refresh = createPostgresAdapter(single)('RefreshToken').find(token); await waitOnBackend(c.processID);
    removal = (async () => {
      await remover.query('BEGIN');
      await remover.query("SELECT stream_id FROM swarm.streams WHERE workspace_id=$1 AND kind='workspace' FOR UPDATE",[g.workspace]);
      await remover.query('UPDATE swarm.hosted_mcp_grant_workspaces SET revoked_at=clock_timestamp() WHERE grant_id=$1',[g.id]);
      await remover.query('COMMIT');
    })();
    await waitOnBackend(remover.processID);
    await blocker.query('COMMIT');
    assert.ok(await refresh,'the operation holding authority locks linearizes before removal');
    await removal;
  } finally {
    await blocker.query('ROLLBACK').catch(() => {}); blocker.release();
    await Promise.allSettled([refresh,removal].filter(Boolean));
    await remover.query('ROLLBACK').catch(() => {}); remover.release(); c.release();
  }
  assert.equal(await rt.find(token),undefined,'the following use sees the committed removal');
});

test('changed or missing stored stream sets refuse before family locking and permit a whole-transaction retry', { timeout: 20000 }, async () => {
  const f = await hostedClients(), id = f.registrations[0];
  assert.equal((await runtime.query('SELECT * FROM commonswarm_oauth.lock_hosted_client_streams($1)',[id])).rowCount,2);
  const blocker = await admin.connect(), c = await runtime.connect();
  const oldStream = [...f.streams].sort()[0];
  let waiting;
  try {
    await blocker.query('BEGIN');
    const workspace = (await blocker.query('SELECT workspace_id FROM swarm.streams WHERE stream_id=$1 FOR UPDATE',[oldStream])).rows[0].workspace_id;
    waiting = c.query('SELECT * FROM commonswarm_oauth.lock_hosted_client_streams($1)',[id]);
    // Attach a rejection observer immediately while the real query waits.
    const refusal = assert.rejects(waiting,e => e.code === '40001');
    await waitOnBackend(c.processID);
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM pg_locks WHERE pid=$1 AND locktype='advisory'",[c.processID])).rows[0].n,0);
    await blocker.query('DELETE FROM swarm.streams WHERE stream_id=$1',[oldStream]);
    await blocker.query("INSERT INTO swarm.streams(stream_id,workspace_id,kind) VALUES($1,$2,'workspace')",[randomUUID(),workspace]);
    await blocker.query('COMMIT'); await refusal;
    assert.equal((await c.query('SELECT * FROM commonswarm_oauth.lock_hosted_client_streams($1)',[id])).rowCount,2,'retry derives the complete current union');
    await admin.query("DELETE FROM swarm.streams WHERE workspace_id=$1 AND kind='workspace'",[workspace]);
    await assert.rejects(c.query('SELECT * FROM commonswarm_oauth.lock_hosted_client_streams($1)',[id]),e => e.code === '40001','missing selected stream cannot fall through to a late per-family lock');
    // Restore this disposable fixture's stream for later global DCR sweeps.
    await admin.query("INSERT INTO swarm.streams(stream_id,workspace_id,kind) VALUES($1,$2,'workspace')",[randomUUID(),workspace]);
  } finally {
    await blocker.query('ROLLBACK').catch(() => {}); blocker.release();
    if (waiting) await Promise.allSettled([waiting]); c.release();
  }
});

test('stored owner, client and resource mismatches never acquire permanent family persistence', async () => {
  const f = await hostedClients(), g = f.grants[0];
  const rt = createPostgresAdapter(runtime)('RefreshToken');
  const control = randomUUID(); await rt.upsert(control,refreshPayload(g),60);
  await createPostgresAdapter(runtime)('Grant').upsert(g.family,grantPayload(g),60);
  let artifacts = 1;
  for (const [key,value] of [['accountId',randomUUID()],['clientId',`foreign-${randomUUID()}`],['resource','https://foreign.example/mcp']]) {
    artifacts += 1;
    const id = randomUUID(); await rt.upsert(id,refreshPayload(g),60);
    // The actual historical hosted-artifact guard permits native payload
    // bookkeeping. The runtime must independently bind each retained payload.
    await admin.query("UPDATE commonswarm_oauth.provider_artifacts SET payload=jsonb_set(payload,ARRAY[$2]::text[],$3::jsonb) WHERE model='RefreshToken' AND artifact_id_hash=$1",
      [hash(id),key,JSON.stringify(value)]);
    const before = await artifact('RefreshToken',id), beforeGrant = await artifact('Grant',g.family);
    assert.equal(await rt.find(id),undefined,key);
    assert.deepEqual(await familyStorage(g),{ tombstones: 0,artifacts,exact_grant: 1 },key);
    assert.deepEqual(await artifact('RefreshToken',id),before,key);
    assert.deepEqual(await artifact('Grant',g.family),beforeGrant,key);
    await assert.rejects(rt.upsert(id,refreshPayload(g),60),e => e.error === 'invalid_grant','save cannot turn an invalid retained tuple into a permanent artifact');
    assert.ok(await rt.find(control),'same-family exact stored tuple remains usable');
  }
});

// The account-validation caller reaches this public method only if policy
// changes after the provider's earlier successful artifact lookup.
test('public retirement commits refresh-race removal and preserves authority restored during a real wait', { timeout: 30000 }, async () => {
  for (const restore of [false,true]) {
    const f = await hostedClients(), [g,other] = f.grants;
    const adapters = createPostgresAdapter(runtime), rt = adapters('RefreshToken');
    const token = randomUUID(), otherToken = randomUUID();
    for (const [row,id] of [[g,token],[other,otherToken]]) {
      await adapters('Grant').upsert(row.family,grantPayload(row),60);
      await rt.upsert(id,refreshPayload(row),60);
    }
    const predecessor = await rt.find(token);
    assert.equal(predecessor.grantId,g.family,'provider already loaded the refresh predecessor');
    const otherBefore = await artifact('RefreshToken',otherToken);
    assert.equal(await rt.retireInactiveHostedFamily(g.family,g.owner),true);
    assert.deepEqual(await familyStorage(g),{ tombstones: 0,artifacts: 1,exact_grant: 1 });
    if (restore) await admin.query('DELETE FROM swarm.memberships WHERE workspace_id=$1 AND user_id=$2',[g.workspace,g.owner]);
    const status = async () => (await admin.query('SELECT active FROM commonswarm_oauth.resolve_hosted_grant_status($1)',[g.family])).rows[0].active;
    assert.equal(await status(),!restore,'pre-wait authority is the opposite of the final decision');
    const blocker = await admin.connect(), c = await runtime.connect();
    const single = { query: (...a) => c.query(...a),connect: async () => ({ query: (...a) => c.query(...a),release() {} }) };
    let waiting;
    try {
      await blocker.query('BEGIN');
      await blocker.query("SELECT stream_id FROM swarm.streams WHERE workspace_id=$1 AND kind='workspace' FOR UPDATE",[g.workspace]);
      waiting = createPostgresAdapter(single)('RefreshToken').retireInactiveHostedFamily(predecessor.grantId,g.owner);
      await waitOnBackend(c.processID);
      if (restore) await blocker.query("INSERT INTO swarm.memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')",[g.workspace,g.owner]);
      else await blocker.query('DELETE FROM swarm.memberships WHERE workspace_id=$1 AND user_id=$2',[g.workspace,g.owner]);
      await blocker.query('COMMIT');
      assert.equal(await waiting,restore,'the public method uses post-wait canonical authority');
      assert.deepEqual(await familyStorage(g),restore
        ? { tombstones: 0,artifacts: 1,exact_grant: 1 }
        : { tombstones: 1,artifacts: 0,exact_grant: 0 });
      assert.deepEqual(await artifact('RefreshToken',otherToken),otherBefore,'independent family storage is unchanged');
      assert.deepEqual(await familyStorage(other),{ tombstones: 0,artifacts: 1,exact_grant: 1 });
      assert.equal((await rt.find(otherToken)).grantId,other.family);
      if (restore) assert.equal((await rt.find(token)).grantId,g.family);
      else {
        // Re-adding membership cannot revive a committed fence.
        await admin.query("INSERT INTO swarm.memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')",[g.workspace,g.owner]);
        assert.equal(await rt.find(token),undefined);
        await assert.rejects(rt.upsert(randomUUID(),refreshPayload(g),60),e => e.error === 'invalid_grant');
        assert.deepEqual(await familyStorage(g),{ tombstones: 1,artifacts: 0,exact_grant: 0 });
      }
    } finally {
      await blocker.query('ROLLBACK').catch(() => {}); blocker.release();
      if (waiting) await Promise.allSettled([waiting]); c.release();
      await admin.query("INSERT INTO swarm.memberships(workspace_id,user_id,role) VALUES($1,$2,'owner') ON CONFLICT(workspace_id,user_id) DO NOTHING",[g.workspace,g.owner]);
    }
  }
});

test('pending and missing canonical policy never retire on read', async () => {
  for (const mode of ['pending','missing-policy']) {
    const f = await hostedClients(), [g,other] = f.grants;
    const adapters = createPostgresAdapter(runtime), rt = adapters('RefreshToken'), token = randomUUID(), control = randomUUID();
    await adapters('Grant').upsert(g.family,grantPayload(g),60);
    await rt.upsert(token,refreshPayload(g),60);
    await rt.upsert(control,refreshPayload(other),60);
    try {
      if (mode === 'pending') await admin.query("UPDATE swarm.hosted_mcp_grants SET state='pending',activated_at=NULL WHERE grant_id=$1",[g.id]);
      else if (mode === 'missing-policy') {
        // Real authority tuple validation returns no policy, rather than an
        // injected empty row or a denial from an unrelated privilege guard.
        await admin.query(`INSERT INTO swarm.hosted_mcp_grant_workspaces
          (grant_id,workspace_id,owner_user_id,manifest_digest,consent_receipt_id,consented_at)
          SELECT grant_id,$2,owner_user_id,manifest_digest,$3,clock_timestamp()
          FROM swarm.hosted_mcp_grants WHERE grant_id=$1`,[g.id,other.workspace,randomUUID()]);
        assert.equal((await runtime.query('SELECT * FROM commonswarm_oauth.lock_hosted_family($1,$2,$3,$4)',[g.family,g.owner,g.clientId,mcp])).rowCount,0);
      }
      const beforeToken = await artifact('RefreshToken',token), beforeGrant = await artifact('Grant',g.family);
      assert.equal(await rt.find(token),undefined,mode);
      assert.deepEqual(await familyStorage(g),{ tombstones: 0,artifacts: 1,exact_grant: 1 },mode);
      assert.deepEqual(await artifact('RefreshToken',token),beforeToken,mode);
      assert.deepEqual(await artifact('Grant',g.family),beforeGrant,mode);
      assert.equal((await rt.find(control)).grantId,other.family,'same-invocation valid runtime lookup');
    } finally {
      if (mode === 'missing-policy') await admin.query('DELETE FROM swarm.hosted_mcp_grant_workspaces WHERE grant_id=$1 AND workspace_id=$2',[g.id,other.workspace]);
    }
  }
});

test('missing resource binding retains finite legacy artifacts without authorizing retirement', async () => {
  const f = await hostedClients({ families: 1,unboundLast: true }), g = f.grants[0];
  const adapters = createPostgresAdapter(runtime), rt = adapters('RefreshToken'), token = randomUUID();
  await adapters('Grant').upsert(g.family,grantPayload(g),60);
  await rt.upsert(token,refreshPayload(g),60);
  const before = await artifact('RefreshToken',token);
  assert.ok(before.expires_at > new Date());
  assert.equal((await runtime.query('SELECT * FROM commonswarm_oauth.provider_grant_resources WHERE provider_grant_id=$1',[g.family])).rowCount,0);
  assert.equal((await rt.find(token)).grantId,g.family);
  assert.equal(await rt.retireInactiveHostedFamily(g.family,g.owner),false);
  assert.deepEqual(await artifact('RefreshToken',token),before);
  assert.deepEqual(await familyStorage(g),{ tombstones: 0,artifacts: 1,exact_grant: 1 });
});

test('unknown and permission resolve failures roll back without tombstones or artifact loss', async () => {
  for (const code of ['XX000','42501']) {
    const f = await hostedClients(), [g,other] = f.grants;
    const adapters = createPostgresAdapter(runtime), rt = adapters('RefreshToken'), token = randomUUID(), control = randomUUID();
    await adapters('Grant').upsert(g.family,grantPayload(g),60);
    await rt.upsert(token,refreshPayload(g),60); await rt.upsert(control,refreshPayload(other),60);
    await admin.query("UPDATE swarm.hosted_mcp_grants SET state='revoked',revoked_at=clock_timestamp() WHERE grant_id=$1",[g.id]);
    const beforeToken = await artifact('RefreshToken',token), beforeGrant = await artifact('Grant',g.family);
    for (const entry of ['find','retireInactiveHostedFamily']) {
      let resolves = 0;
      const failure = Object.assign(new Error('injected canonical resolve failure'),{ code });
      const faultPool = { query: (...a) => runtime.query(...a),connect: async () => {
        const c = await runtime.connect();
        return { release: () => c.release(),query: async (sql,...args) => {
          if (sql.includes('commonswarm_oauth.lock_hosted_family(')) {
            resolves += 1;
            if (resolves === 2) throw failure;
            const result = await c.query(sql,...args);
            assert.equal(result.rows[0].active,false,'first real policy confirms inactive authority');
            return result;
          }
          return c.query(sql,...args);
        } };
      } };
      const faulty = createPostgresAdapter(faultPool)('RefreshToken');
      await assert.rejects(entry === 'find' ? faulty.find(token) : faulty.retireInactiveHostedFamily(g.family,g.owner),e => e === failure);
      assert.equal(resolves,2,'failure occurs at the final policy read, after the real lock path');
      assert.deepEqual(await familyStorage(g),{ tombstones: 0,artifacts: 1,exact_grant: 1 });
      assert.deepEqual(await artifact('RefreshToken',token),beforeToken);
      assert.deepEqual(await artifact('Grant',g.family),beforeGrant);
    }
    assert.equal((await rt.find(control)).grantId,other.family,'the runtime connection remains usable after rollback');
  }
});

test('real delegated-admin artifacts refuse hosted reads and retirement outside their transaction', async () => {
  const f = adminFixture();
  // The shared schema fixture uses SET LOCAL ROLE for each guarded insert.
  // Its established loopback cluster-admin context can SET those roles; the
  // ordinary postgres login intentionally has no runtime-role membership.
  const preparation = new Pool({ connectionString: localClusterAdminUrl(databaseUrl), max: 1 });
  const c = await preparation.connect();
  let preparationStep = 'fixture-prepare:begin';
  try {
    await c.query('BEGIN');
    // Reuse the established schema fixture and its actual resource/binding
    // guards; no authority or admin transaction context is mocked.
    for (const part of f.preparation) {
      preparationStep = part.step;
      await c.query(part.sql);
    }
    await c.query('COMMIT');
  } catch (error) {
    // Fixed fixture phase/role/object only: never driver messages or SQL.
    const diagnostic = Object.assign(new Error('delegated-admin fixture preparation failed'), {
      preparation_step: preparationStep,
      preparation_role: 'supabase_admin',
      ...(preparationStep === 'fixture-prepare:resource' ? { requested_role: 'commonswarm_oauth_runtime' } : {}),
      ...(/^[0-9A-Z]{5}$/u.test(error.code ?? '') ? { code: error.code } : {}),
      ...(['swarm','commonswarm_oauth','auth'].includes(error.schema) ? { schema: error.schema } : {}),
      ...(['admin_grant_bindings','provider_grant_resources','admin_verified_clients','admin_client_owner_approvals'].includes(error.table) ? { table: error.table } : {}),
      ...(['aclcheck_error','check_role','check_role_membership'].includes(error.routine) ? { routine: error.routine } : {}),
    });
    throw diagnostic;
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
    await preparation.end();
  }
  const resource = 'https://api.commonswarm.com/admin', token = randomUUID();
  for (const [model,id,payload] of [
    ['Grant',f.provider,{ accountId: f.owner,clientId: f.client,jti: f.provider,resources: { [resource]: 'admin:read' } }],
    ['RefreshToken',token,{ accountId: f.owner,clientId: f.client,grantId: f.provider,resource }],
  ]) await runtime.query(`INSERT INTO commonswarm_oauth.provider_artifacts(model,artifact_id_hash,payload,grant_id,expires_at,created_at,updated_at)
    VALUES($1,$2,$3::jsonb,$4,clock_timestamp()+interval '1 hour',clock_timestamp(),clock_timestamp())`,[model,hash(id),JSON.stringify(payload),model === 'Grant' ? null : f.provider]);
  const g = { family: f.provider }, beforeToken = await artifact('RefreshToken',token), beforeGrant = await artifact('Grant',f.provider);
  const rt = createPostgresAdapter(runtime)('RefreshToken');
  await assert.rejects(rt.find(token),e => e.code === 'admin_transaction_required');
  await assert.rejects(rt.retireInactiveHostedFamily(f.provider,f.owner),e => e.code === 'admin_transaction_required');
  assert.deepEqual(await familyStorage(g),{ tombstones: 0,artifacts: 1,exact_grant: 1 });
  assert.deepEqual(await artifact('RefreshToken',token),beforeToken);
  assert.deepEqual(await artifact('Grant',f.provider),beforeGrant);
  const hosted = (await hostedClients({ families: 1 })).grants[0], control = randomUUID();
  await rt.upsert(control,refreshPayload(hosted),60);
  assert.equal((await rt.find(control)).grantId,hosted.family,'the same runtime role can still read a hosted family');
});
