import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { Pool } from "pg";

import { createPostgresAdapter } from "../src/postgres-adapter.js";

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
