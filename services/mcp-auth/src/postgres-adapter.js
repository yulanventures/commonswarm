import { createHash } from "node:crypto";

import { errors } from "oidc-provider";
import { adminTransactionContext, adminQuery, joinAdminTransaction, AdminTransactionError } from "./admin-transaction.js";

const GRANTABLE_MODELS = new Set([
  "AccessToken",
  "AuthorizationCode",
  "BackchannelAuthenticationRequest",
  "DeviceCode",
  "PreAuthorizedCode",
  "RefreshToken",
]);
const DIRECT_BEARER_MODELS = new Set(["AccessToken", "AuthorizationCode", "RefreshToken"]);

function lookupHash(value) {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

function assertIdentifier(value) {
  if (!/^[a-z_][a-z0-9_]*$/u.test(value)) {
    throw new TypeError("invalid PostgreSQL schema identifier");
  }
  return value;
}

function storedPayload(row, recoveredJti) {
  const payload = structuredClone(row.payload);
  if (recoveredJti !== undefined && payload.jti === undefined) payload.jti = recoveredJti;
  if (row.consumed_at !== null) {
    payload.consumed = Math.floor(new Date(row.consumed_at).getTime() / 1000);
  }
  return payload;
}

async function transaction(pool, callback) {
  if (adminTransactionContext(false)) return joinAdminTransaction(callback);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Production oidc-provider adapter.
 *
 * Refresh safety deliberately does not depend on process memory. A consume is
 * one conditional UPDATE. Family revocation and every grant-bound upsert take
 * the same transaction advisory lock, and a durable tombstone wins before an
 * artifact can be (re)inserted.
 */
export function createPostgresAdapter(pool, { schema = "commonswarm_oauth", beforeConsume } = {}) {
  if (!pool || typeof pool.query !== "function" || typeof pool.connect !== "function") {
    throw new TypeError("a pg-compatible pool is required");
  }
  const qualifiedSchema = assertIdentifier(schema);
  const artifacts = `${qualifiedSchema}.provider_artifacts`;
  const tombstones = `${qualifiedSchema}.refresh_family_tombstones`;
  const database = pool;
  pool = { query: (...args) => adminTransactionContext(false) ? adminQuery(...args) : database.query(...args),
    connect: () => adminTransactionContext(false)
      ? Promise.resolve({ query: adminQuery, release() {} }) : database.connect() };
  function adminPayload(payload) {
    const admin="https://api.commonswarm.com/admin";
    return payload?.resource === admin || (Array.isArray(payload?.resource) && payload.resource.includes(admin)) ||
      payload?.params?.resource === admin || payload?.aud === admin || payload?.grant_class === "delegated_admin" ||
      Object.hasOwn(payload?.resources ?? {},admin);
  }
  async function requireBoundContext(modelName, id, payload) {
    if (adminTransactionContext(false)) return;
    if (adminPayload(payload)) throw new AdminTransactionError("admin_transaction_required");
    // Family identity comes from the pre-M1 artifact payload, never an admin
    // table. An unlabelled successor still checks its existing Grant/family.
    const family = payload?.grantId ?? (modelName === "Grant" ? id : null);
    const rows = (await database.query(`WITH target AS (
        SELECT grant_id FROM ${artifacts} WHERE model=$1 AND artifact_id_hash=$2
      ) SELECT payload FROM ${artifacts}
      WHERE (model=$1 AND artifact_id_hash=$2)
        OR grant_id=coalesce($3,(SELECT grant_id FROM target))
        OR (model='Grant' AND (artifact_id_hash=$4
          OR payload->>'jti'=coalesce($3,(SELECT grant_id FROM target))))`,
      [modelName, lookupHash(id), family, family ? lookupHash(family) : null])).rows;
    if (rows.some(row => adminPayload(row.payload))) throw new AdminTransactionError("admin_transaction_required");
  }

  return (model) => ({
    async consume(id) {
      await requireBoundContext(model, id);
      const client = beforeConsume && model === "RefreshToken" ? await pool.connect() : null;
      try {
        await beforeConsume?.({ model, id, processId: client?.processID ?? null });
        const result = await (client ?? pool).query(
          `UPDATE ${artifacts} AS artifact
            SET consumed_at = statement_timestamp(), updated_at = statement_timestamp()
          WHERE artifact.model = $1
            AND artifact.artifact_id_hash = $2
            AND artifact.consumed_at IS NULL
            AND (artifact.expires_at IS NULL OR artifact.expires_at > statement_timestamp())
            AND (artifact.grant_id IS NULL OR NOT EXISTS (
              SELECT 1 FROM ${tombstones} AS tombstone
              WHERE tombstone.grant_id = artifact.grant_id
            ))
            RETURNING artifact.grant_id`,
          [model, lookupHash(id)],
        );
        if (result.rowCount !== 1) {
          // A racing caller that loses this CAS must not revoke the family. A
          // later request observes consumed_at in find(), allowing the provider's
          // sequential-replay path to call revokeByGrantId.
          throw new errors.InvalidGrant(`${model} is unavailable or already used`);
        }
      } finally {
        client?.release();
      }
    },

    async destroy(id) {
      await requireBoundContext(model, id);
      await pool.query(
        `DELETE FROM ${artifacts} WHERE model = $1 AND artifact_id_hash = $2`,
        [model, lookupHash(id)],
      );
    },

    async find(id) {
      await requireBoundContext(model, id);
      const result = await pool.query(
        `SELECT payload, consumed_at
           FROM ${artifacts} AS artifact
          WHERE artifact.model = $1
            AND artifact.artifact_id_hash = $2
            AND (artifact.expires_at IS NULL OR artifact.expires_at > statement_timestamp())
            AND (artifact.grant_id IS NULL OR NOT EXISTS (
              SELECT 1 FROM ${tombstones} AS tombstone
              WHERE tombstone.grant_id = artifact.grant_id
            ))
          LIMIT 1`,
        [model, lookupHash(id)],
      );
      if (result.rows[0] && adminPayload(result.rows[0].payload)) await requireBoundContext(model,id,result.rows[0].payload);
      return result.rows[0] ? storedPayload(result.rows[0], id) : undefined;
    },

    async findByUid(uid) {
      const result = await pool.query(
        `SELECT payload, consumed_at
           FROM ${artifacts} AS artifact
          WHERE artifact.model = $1
            AND artifact.uid = $2
            AND (artifact.expires_at IS NULL OR artifact.expires_at > statement_timestamp())
            AND (artifact.grant_id IS NULL OR NOT EXISTS (
              SELECT 1 FROM ${tombstones} AS tombstone
              WHERE tombstone.grant_id = artifact.grant_id
            ))
          ORDER BY artifact.created_at DESC
          LIMIT 1`,
        [model, uid],
      );
      if (result.rows[0]) await requireBoundContext(model, result.rows[0].payload.jti ?? "", result.rows[0].payload);
      return result.rows[0] ? storedPayload(result.rows[0]) : undefined;
    },

    async findByUserCode(userCode) {
      const result = await pool.query(
        `SELECT payload, consumed_at
           FROM ${artifacts} AS artifact
          WHERE artifact.model = $1
            AND artifact.user_code_hash = $2
            AND (artifact.expires_at IS NULL OR artifact.expires_at > statement_timestamp())
            AND (artifact.grant_id IS NULL OR NOT EXISTS (
              SELECT 1 FROM ${tombstones} AS tombstone
              WHERE tombstone.grant_id = artifact.grant_id
            ))
          ORDER BY artifact.created_at DESC
          LIMIT 1`,
        [model, lookupHash(userCode)],
      );
      if (result.rows[0]) await requireBoundContext(model, result.rows[0].payload.jti ?? "", result.rows[0].payload);
      return result.rows[0] ? storedPayload(result.rows[0]) : undefined;
    },

    async revokeByGrantId(grantId) {
      await requireBoundContext("Grant", grantId, { grantId });
      await transaction(pool, async (client) => {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 484650))",
          [grantId],
        );
        await client.query(
          `INSERT INTO ${tombstones} (grant_id, revoked_at)
           VALUES ($1, statement_timestamp())
           ON CONFLICT (grant_id) DO NOTHING`,
          [grantId],
        );
        await client.query(`DELETE FROM ${artifacts} WHERE grant_id = $1`, [grantId]);
      });
    },

    async upsert(id, payload, expiresIn) {
      const nativeMcpResource = Array.isArray(payload.resource) && payload.resource.length === 1 &&
        payload.resource[0] === "https://mcp.commonswarm.com/mcp";
      if ((Array.isArray(payload.resource) && !nativeMcpResource) ||
          (payload.resources && Object.keys(payload.resources).length !== 1)) {
        throw new errors.InvalidTarget("exactly one bound resource is required");
      }
      await requireBoundContext(model, id, payload);
      const grantId = GRANTABLE_MODELS.has(model) && typeof payload.grantId === "string"
        ? payload.grantId
        : null;
      const expiresAt = typeof expiresIn === "number"
        ? new Date(Date.now() + expiresIn * 1000)
        : null;
      const stored = {
        ...structuredClone(payload),
        jti: payload.jti ?? id,
        kind: payload.kind ?? model,
      };
      if (DIRECT_BEARER_MODELS.has(model)) delete stored.jti;

      await transaction(pool, async (client) => {
        if (grantId !== null) {
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1, 484650))",
            [grantId],
          );
          const revoked = await client.query(
            `SELECT 1 FROM ${tombstones} WHERE grant_id = $1 LIMIT 1`,
            [grantId],
          );
          if (revoked.rowCount !== 0) {
            throw new errors.InvalidGrant("grant family revoked");
          }
        }

        await client.query(
          `INSERT INTO ${artifacts} AS existing (
             model, artifact_id_hash, payload, grant_id, uid, user_code_hash,
             expires_at, consumed_at, created_at, updated_at
           ) VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, NULL,
                     statement_timestamp(), statement_timestamp())
           ON CONFLICT (model, artifact_id_hash) DO UPDATE SET
             payload = EXCLUDED.payload,
             grant_id = EXCLUDED.grant_id,
             uid = EXCLUDED.uid,
             user_code_hash = EXCLUDED.user_code_hash,
             expires_at = EXCLUDED.expires_at,
             consumed_at = existing.consumed_at,
             updated_at = statement_timestamp()`,
          [model, lookupHash(id), JSON.stringify(stored), grantId, stored.uid ?? null,
            stored.userCode ? lookupHash(stored.userCode) : null, expiresAt],
        );
      });
    },
  });
}
