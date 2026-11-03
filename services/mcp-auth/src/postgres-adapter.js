import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";

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

/** Payload field on a consumed hosted RefreshToken that holds its rotation's sealed response. */
export const ROTATION_REPLAY_FIELD = "cs_rotation_replay";
/** Seconds after a hosted rotation in which an exact repeat of the predecessor gets the SAME
 *  response back (GameMaster, 2026-11-03: a 200 lost in transit, retried 43s later). One lineage:
 *  nothing new is minted. Outside the window, or once the successor is used, the repeat reaches
 *  oidc-provider's reuse path and the family is retired as before. */
export const HOSTED_ROTATION_REPLAY_SECONDS = 300;

/* The sealing key derives from the presented predecessor itself, so the database (which holds only
 * sha256 lookups of tokens) cannot open a sealed response, and no new server secret exists. */
function replayKey(predecessor, salt) {
  return Buffer.from(hkdfSync("sha256", Buffer.from(predecessor, "utf8"), salt, "commonswarm hosted refresh replay v1", 32));
}
function replayAad(predecessor, clientId, fingerprint) {
  return Buffer.from(`${lookupHash(predecessor)}\n${clientId}\n${fingerprint}`, "utf8");
}
export function sealRotation(predecessor, clientId, fingerprint, body) {
  const salt = randomBytes(16), iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", replayKey(predecessor, salt), iv);
  cipher.setAAD(replayAad(predecessor, clientId, fingerprint));
  const ct = Buffer.concat([cipher.update(JSON.stringify(body), "utf8"), cipher.final()]);
  return { v: 1, salt: salt.toString("base64url"), iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"), ct: ct.toString("base64url") };
}
export function openRotation(predecessor, clientId, fingerprint, sealed) {
  if (sealed?.v !== 1) return undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", replayKey(predecessor, Buffer.from(sealed.salt, "base64url")),
      Buffer.from(sealed.iv, "base64url"));
    decipher.setAAD(replayAad(predecessor, clientId, fingerprint));
    decipher.setAuthTag(Buffer.from(sealed.tag, "base64url"));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(sealed.ct, "base64url")), decipher.final()]).toString("utf8"));
  } catch { return undefined; }
}

function storedPayload(row, recoveredJti) {
  const payload = structuredClone(row.payload);
  delete payload[ROTATION_REPLAY_FIELD];
  if (recoveredJti !== undefined && payload.jti === undefined) payload.jti = recoveredJti;
  if (row.consumed_at !== null) {
    payload.consumed = Math.floor(new Date(row.consumed_at).getTime() / 1000);
  }
  return payload;
}

async function transaction(pool, callback, connection) {
  if (adminTransactionContext(false)) return joinAdminTransaction(callback);
  const client = connection ?? await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    if (!connection) client.release();
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
export function createPostgresAdapter(pool, { schema = "commonswarm_oauth", beforeConsume,
  rotationReplaySeconds = HOSTED_ROTATION_REPLAY_SECONDS } = {}) {
  if (!Number.isSafeInteger(rotationReplaySeconds) || rotationReplaySeconds < 0 || rotationReplaySeconds > 600) {
    throw new TypeError("rotationReplaySeconds must be an integer from 0 to 600");
  }
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
  async function requireBoundContext(modelName, id, payload, executor = database) {
    if (adminTransactionContext(false)) return;
    if (adminPayload(payload)) throw new AdminTransactionError("admin_transaction_required");
    // Family identity comes from the pre-M1 artifact payload, never an admin
    // table. An unlabelled successor still checks its existing Grant/family.
    const family = payload?.grantId ?? (modelName === "Grant" ? id : null);
    const rows = (await executor.query(`WITH target AS (
        SELECT grant_id FROM ${artifacts} WHERE model=$1 AND artifact_id_hash=$2
      ) SELECT payload FROM ${artifacts}
      WHERE (model=$1 AND artifact_id_hash=$2)
        OR grant_id=coalesce($3,(SELECT grant_id FROM target))
        OR (model='Grant' AND (artifact_id_hash=$4
          OR payload->>'jti'=coalesce($3,(SELECT grant_id FROM target))))`,
      [modelName, lookupHash(id), family, family ? lookupHash(family) : null])).rows;
    if (rows.some(row => adminPayload(row.payload))) throw new AdminTransactionError("admin_transaction_required");
  }

  const resource = "https://mcp.commonswarm.com/mcp";
  function familyId(model, id, payload) {
    return model === "Grant" ? id : GRANTABLE_MODELS.has(model) ? payload?.grantId : null;
  }
  async function bindingFor(client, family) {
    if (!family) return undefined;
    // The existing historical composition fixture also exercises pre-M1 stores.
    if (!(await client.query("SELECT to_regclass('commonswarm_oauth.provider_grant_resources') AS relation")).rows[0]?.relation) return undefined;
    return (await client.query(`SELECT * FROM commonswarm_oauth.provider_grant_resources
      WHERE provider_grant_id=$1`, [family])).rows[0];
  }
  function assertHostedPayload(model, id, payload, binding) {
    const target = Array.isArray(payload.resource) && payload.resource.length === 1 ? payload.resource[0] : payload.resource;
    if (payload.accountId !== binding.owner_user_id || payload.clientId !== binding.client_id ||
        binding.resource !== resource || (payload.jti !== undefined && model === "Grant" && payload.jti !== id) ||
        (target !== undefined && target !== resource) || (payload.aud !== undefined && payload.aud !== resource) ||
        (model === "Grant" && (Object.keys(payload.resources ?? {}).length !== 1 || !Object.hasOwn(payload.resources,resource)))) {
      throw new errors.InvalidGrant("hosted family binding mismatch");
    }
  }
  async function lockFamily(client, model, id, payload, allowInactive = false) {
    const family = familyId(model,id,payload);
    if (!family) return {};
    // Admin issuance already owns its independent transaction envelope. Keep
    // its existing Grant/refresh lock behavior and finite lifecycle intact.
    const binding = adminTransactionContext(false) ? undefined : await bindingFor(client,family);
    if (adminTransactionContext(false) && model === "Grant") return { family };
    if (binding?.grant_class === "hosted_mcp") {
      assertHostedPayload(model,id,payload,binding);
      // DCR -> union of original and human-added workspace streams -> family -> exact
      // hosted grant -> artifact. Never enter this envelope with a family held.
      await client.query("SELECT client_id FROM commonswarm_oauth.registered_clients WHERE client_id=$1 FOR UPDATE", [binding.client_id]);
      const candidates = (await client.query("SELECT * FROM commonswarm_oauth.lock_hosted_client_streams($1)", [binding.client_id])).rows;
      if (!candidates.some(row => row.provider_grant_id === family && row.owner_user_id === binding.owner_user_id &&
          row.client_id === binding.client_id && row.resource === binding.resource)) throw new errors.InvalidGrant("hosted binding unavailable");
      const policy = await currentPolicy(client,family,binding);
      if (!policy || (!allowInactive && !policy.active && !(model === "Grant" && policy.state === "pending"))) {
        throw new errors.InvalidGrant("hosted family inactive");
      }
      return { family, binding, policy };
    }
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,484650))", [family]);
    if ((await client.query(`SELECT 1 FROM ${tombstones} WHERE grant_id=$1`, [family])).rowCount) {
      throw new errors.InvalidGrant("grant family revoked");
    }
    return { family };
  }
  async function currentPolicy(client, family, binding) {
    return (await client.query(`SELECT grant_id,state,active,connection_expires_at::text,connection_expired_at
      FROM commonswarm_oauth.lock_hosted_family($1,$2::uuid,$3,$4)`,
      [family,binding.owner_user_id,binding.client_id,binding.resource])).rows[0];
  }
  function normalize(model, payload, expiresAt, policy) {
    const value = structuredClone(payload);
    if (policy?.active && (model === "Grant" || model === "RefreshToken")) {
      expiresAt = policy.connection_expires_at;
      if (expiresAt === null) delete value.exp;
      else value.exp = Math.ceil(new Date(expiresAt).getTime()/1000);
      if (model === "RefreshToken") value.expiresWithSession = false;
    }
    return { payload: value, expiresAt };
  }
  async function lockProviderGrant(client, envelope, allowConsumed = false) {
    if (!envelope.binding) return undefined;
    // A rotation loads Grant before consume and never saves it. Lock that
    // exact persisted Grant BEFORE the refresh artifact so both snapshots can
    // follow the same freshly checked canonical policy without a lock cycle.
    const row = (await client.query(`SELECT * FROM ${artifacts}
      WHERE model='Grant' AND artifact_id_hash=$1 FOR UPDATE`, [lookupHash(envelope.family)])).rows[0];
    // Never create a missing Grant: adapter callers may persist a refresh
    // artifact independently; the provider validates Grant before redemption.
    if (!row) return undefined;
    if (!allowConsumed && row.consumed_at !== null) {
      throw new errors.InvalidGrant("hosted Grant unavailable");
    }
    assertHostedPayload("Grant",envelope.family,row.payload,envelope.binding);
    return row;
  }
  async function normalizeProviderGrant(client, row, policy) {
    if (!row) return;
    const normalized = normalize("Grant",row.payload,row.expires_at,policy);
    await client.query(`UPDATE ${artifacts} SET payload=$2::jsonb,expires_at=$3,updated_at=clock_timestamp()
      WHERE model='Grant' AND artifact_id_hash=$1 AND consumed_at IS NULL`,
      [row.artifact_id_hash,JSON.stringify(normalized.payload),normalized.expiresAt]);
  }
  async function retireLockedHostedFamily(client, envelope, policy, providerGrant) {
    const { family, binding } = envelope;
    // Only the existing definer's freshly validated, non-pending authority can
    // make a terminal decision. Missing rows and query errors are not evidence.
    // active describes connection liveness, including a dormant family with
    // zero reachable workspaces. Only explicit revocation/expiry retires it;
    // tool resolvers independently require live target authority.
    if (!binding || policy?.active !== false || !["active","revoked"].includes(policy.state) ||
        policy.grant_id !== binding.hosted_grant_id) return false;
    if (providerGrant) {
      assertHostedPayload("Grant",family,providerGrant.payload,binding);
      if ((providerGrant.grant_id !== null && providerGrant.grant_id !== family) ||
          (providerGrant.payload.grantId !== undefined && providerGrant.payload.grantId !== family)) {
        throw new errors.InvalidGrant("stored Grant family mismatch");
      }
    }
    // hosted_mcp_grants.provider_grant_id is UNIQUE; provider_grant_resources
    // has that same PRIMARY KEY plus an immutable, checked hosted tuple.
    // currentPolicy validated that tuple under the family/authority locks.
    // Thus this exact model+id Grant cannot serve an independent family.
    await client.query(`INSERT INTO ${tombstones} (grant_id,revoked_at)
      VALUES ($1,statement_timestamp()) ON CONFLICT (grant_id) DO NOTHING`, [family]);
    await client.query(`DELETE FROM ${artifacts}
      WHERE grant_id=$1 AND model=ANY($5::text[])
        AND payload->>'grantId'=$1 AND payload->>'accountId'=$2 AND payload->>'clientId'=$3
        AND (payload->'resource' IS NULL OR payload->'resource'=to_jsonb($4::text)
          OR payload->'resource'=jsonb_build_array($4::text))
        AND (payload->'aud' IS NULL OR payload->'aud'=to_jsonb($4::text))`,
      [family,binding.owner_user_id,binding.client_id,binding.resource,[...GRANTABLE_MODELS]]);
    if (providerGrant) {
      await client.query(`DELETE FROM ${artifacts}
        WHERE model='Grant' AND artifact_id_hash=$1`, [providerGrant.artifact_id_hash]);
    }
    return true;
  }
  async function readArtifact(model, column, value, recoveredJti, requireActive = false) {
    if (adminTransactionContext(false)) {
      // The admin unit already owns its locks and rollback boundary. Keep
      // dependency Promise.all reads as queries, not nested savepoint units.
      const row = (await pool.query(`SELECT payload,consumed_at FROM ${artifacts} AS artifact
        WHERE model=$1 AND ${column}=$2
          AND (expires_at IS NULL OR expires_at>statement_timestamp())
          AND (grant_id IS NULL OR NOT EXISTS (SELECT 1 FROM ${tombstones} t WHERE t.grant_id=artifact.grant_id))
        ORDER BY created_at DESC LIMIT 1`, [model,value])).rows[0];
      return row ? storedPayload(row,recoveredJti) : undefined;
    }
    return transaction(pool, async client => {
      const initial = (await client.query(`SELECT * FROM ${artifacts} WHERE model=$1 AND ${column}=$2
        ORDER BY created_at DESC LIMIT 1`, [model,value])).rows[0];
      if (!initial) return undefined;
      const id = recoveredJti ?? initial.payload.jti;
      await requireBoundContext(model,id ?? "",initial.payload,client);
      // Reads must reach the durable retirement decision even when authority
      // is already inactive. Keep this inside the SAME ordered transaction.
      const envelope = await lockFamily(client,model,id,initial.payload,true);
      const providerGrant = await lockProviderGrant(client,envelope,true);
      const row = (await client.query(`SELECT * FROM ${artifacts} WHERE model=$1 AND artifact_id_hash=$2 FOR UPDATE`, [model,initial.artifact_id_hash])).rows[0];
      if (!row) return undefined;
      if (familyId(model,id,row.payload) !== familyId(model,id,initial.payload)) throw new errors.InvalidGrant("artifact family changed");
      let policy = envelope.policy;
      if (envelope.binding) {
        assertHostedPayload(model,id,row.payload,envelope.binding);
        if (model !== "Grant" && row.grant_id !== envelope.family) throw new errors.InvalidGrant("stored family mismatch");
        // Artifact waits are last. Re-read canonical authority and DB time in
        // a NEW statement while all previously acquired locks remain held.
        policy = await currentPolicy(client,envelope.family,envelope.binding);
        if (!policy || (!policy.active && !(model === "Grant" && policy.state === "pending"))) {
          await retireLockedHostedFamily(client,envelope,policy,providerGrant);
          // Return normally so the tombstone/deletions commit before find
          // reports unavailable; throwing here would roll retirement back.
          return undefined;
        }
      }
      if (requireActive && !policy?.active) throw new errors.InvalidGrant("active hosted approval required");
      if (row.consumed_at === null && policy?.active && (model === "Grant" || model === "RefreshToken")) {
        const normalized = normalize(model,row.payload,row.expires_at,policy);
        await client.query(`UPDATE ${artifacts} SET payload=$3::jsonb,expires_at=$4,updated_at=clock_timestamp()
          WHERE model=$1 AND artifact_id_hash=$2 AND consumed_at IS NULL`,
        [model,row.artifact_id_hash,JSON.stringify(normalized.payload),normalized.expiresAt]);
        row.payload = normalized.payload;
        return storedPayload(row,recoveredJti);
      }
      const live = (await client.query("SELECT ($1::timestamptz IS NULL OR $1::timestamptz>clock_timestamp()) AS live", [row.expires_at])).rows[0].live;
      return live ? storedPayload(row,recoveredJti) : undefined;
    });
  }

  /* Under the family locks: the consumed hosted predecessor, its live unused successor in the same
   * family, and an active policy. Returns the locked predecessor row or undefined. */
  async function lockedRotation(client, predecessor, clientId) {
    const model = "RefreshToken";
    const initial = (await client.query(`SELECT payload FROM ${artifacts} WHERE model=$1 AND artifact_id_hash=$2`,
      [model,lookupHash(predecessor)])).rows[0];
    if (!initial || initial.payload?.clientId !== clientId) return undefined;
    await requireBoundContext(model,predecessor,initial.payload,client);
    const envelope = await lockFamily(client,model,predecessor,initial.payload);
    if (!envelope.binding || !envelope.policy?.active || envelope.binding.client_id !== clientId) return undefined;
    const row = (await client.query(`SELECT *, consumed_at > clock_timestamp() - make_interval(secs => $3) AS within
      FROM ${artifacts} WHERE model=$1 AND artifact_id_hash=$2 FOR UPDATE`,
      [model,lookupHash(predecessor),rotationReplaySeconds])).rows[0];
    if (!row || row.consumed_at === null || row.within !== true || row.grant_id !== envelope.family) return undefined;
    assertHostedPayload(model,predecessor,row.payload,envelope.binding);
    if ((await client.query(`SELECT 1 FROM ${tombstones} WHERE grant_id=$1`, [envelope.family])).rowCount) return undefined;
    return { row, envelope };
  }
  async function successorLive(client, successorHash, family) {
    return (await client.query(`SELECT 1 FROM ${artifacts} WHERE model='RefreshToken' AND artifact_id_hash=$1
      AND grant_id=$2 AND consumed_at IS NULL AND (expires_at IS NULL OR expires_at>clock_timestamp())`,
      [successorHash, family])).rowCount === 1;
  }

  const factory = (model) => ({
    /** After a hosted rotation answered 200: seal that exact response onto the consumed predecessor. */
    async rememberHostedRotation({ predecessor, successor, clientId, fingerprint, body }) {
      if (model !== "RefreshToken" || adminTransactionContext(false) || rotationReplaySeconds === 0) return false;
      if (typeof predecessor !== "string" || typeof successor !== "string" || predecessor === successor ||
          typeof fingerprint !== "string" || fingerprint.length === 0) return false;
      return transaction(pool, async client => {
        const locked = await lockedRotation(client, predecessor, clientId);
        if (!locked || Object.hasOwn(locked.row.payload, ROTATION_REPLAY_FIELD)) return false;
        if (!await successorLive(client, lookupHash(successor), locked.envelope.family)) return false;
        // The fingerprint is of the request the provider just validated and answered (grant_type,
        // client_id, resource, scope); only an identical request may receive this response again.
        const sealed = { ...sealRotation(predecessor, clientId, fingerprint, body), successor: lookupHash(successor),
          fingerprint, at: Math.floor(Date.now() / 1000) };
        const updated = await client.query(`UPDATE ${artifacts} SET payload=payload || jsonb_build_object($3::text,$4::jsonb),
            updated_at=clock_timestamp()
          WHERE model=$1 AND artifact_id_hash=$2 AND consumed_at IS NOT NULL AND NOT (payload ? $3::text)`,
          [model,lookupHash(predecessor),ROTATION_REPLAY_FIELD,JSON.stringify(sealed)]);
        return updated.rowCount === 1;
      });
    },

    /** An exact repeat inside the window: the same sealed response, while its successor is unused. */
    async replayHostedRotation({ predecessor, clientId, fingerprint }) {
      if (model !== "RefreshToken" || adminTransactionContext(false) || rotationReplaySeconds === 0) return undefined;
      if (typeof predecessor !== "string" || typeof clientId !== "string" || typeof fingerprint !== "string") return undefined;
      return transaction(pool, async client => {
        const locked = await lockedRotation(client, predecessor, clientId);
        const sealed = locked?.row.payload[ROTATION_REPLAY_FIELD];
        if (!sealed || typeof sealed.successor !== "string" || sealed.fingerprint !== fingerprint) return undefined;
        if (!await successorLive(client, sealed.successor, locked.envelope.family)) return undefined;
        const body = openRotation(predecessor, clientId, fingerprint, sealed);
        if (!body || typeof body.refresh_token !== "string" || lookupHash(body.refresh_token) !== sealed.successor) return undefined;
        if (Number.isSafeInteger(body.expires_in) && Number.isSafeInteger(sealed.at)) {
          body.expires_in = Math.max(0, body.expires_in - (Math.floor(Date.now() / 1000) - sealed.at));
        }
        return body;
      });
    },

    async proveHostedRefreshToken(predecessor, clientId) {
      if (model !== "RefreshToken" || adminTransactionContext(false)) return undefined;
      const id = predecessor.jti;
      return transaction(pool, async client => {
        const initial = (await client.query(`SELECT payload FROM ${artifacts}
          WHERE model=$1 AND artifact_id_hash=$2`, [model,lookupHash(id)])).rows[0];
        if (!initial) return undefined;
        await requireBoundContext(model,id,initial.payload,client);
        const envelope = await lockFamily(client,model,id,initial.payload);
        if (!envelope.binding) return undefined;
        const row = (await client.query(`SELECT * FROM ${artifacts}
          WHERE model=$1 AND artifact_id_hash=$2 FOR UPDATE`, [model,lookupHash(id)])).rows[0];
        if (!row || row.consumed_at !== null) return undefined;
        assertHostedPayload(model,id,row.payload,envelope.binding);
        assertHostedPayload(model,id,predecessor,envelope.binding);
        const target = value => Array.isArray(value) && value.length === 1 ? value[0] : value;
        if (row.grant_id !== envelope.family || row.payload.grantId !== envelope.family ||
            predecessor.grantId !== envelope.family || clientId !== envelope.binding.client_id ||
            target(row.payload.resource) !== resource || target(predecessor.resource) !== resource) {
          throw new errors.InvalidGrant("refresh predecessor binding mismatch");
        }
        // This fresh authority read follows the artifact wait; the existing
        // helper validates live consent, manifest, owner and family tombstones.
        if (!(await currentPolicy(client,envelope.family,envelope.binding))?.active) {
          throw new errors.InvalidGrant("hosted family inactive");
        }
        // Never serialize this proof or attach it to a token/client payload.
        return Object.freeze({ predecessor, artifactId: id, family: envelope.family,
          owner: envelope.binding.owner_user_id, clientId, resource });
      });
    },

    async consume(id) {
      await requireBoundContext(model,id);
      if (adminTransactionContext(false)) {
        const result = await pool.query(`UPDATE ${artifacts} AS artifact
          SET consumed_at=statement_timestamp(),updated_at=statement_timestamp()
          WHERE model=$1 AND artifact_id_hash=$2 AND consumed_at IS NULL
            AND (expires_at IS NULL OR expires_at>statement_timestamp())
            AND (grant_id IS NULL OR NOT EXISTS (SELECT 1 FROM ${tombstones} t WHERE t.grant_id=artifact.grant_id))
          RETURNING grant_id`, [model,lookupHash(id)]);
        if (result.rowCount !== 1) throw new errors.InvalidGrant(`${model} is unavailable or already used`);
        return;
      }
      const connection = beforeConsume && model === "RefreshToken" ? await pool.connect() : null;
      try {
        // The existing CAS race barrier precedes all family/row locks.
        await beforeConsume?.({ model, id, processId: connection?.processID ?? null });
        await transaction(pool, async client => {
          const initial = (await client.query(`SELECT payload FROM ${artifacts} WHERE model=$1 AND artifact_id_hash=$2`, [model,lookupHash(id)])).rows[0];
          if (!initial) throw new errors.InvalidGrant(`${model} is unavailable or already used`);
          const envelope = await lockFamily(client,model,id,initial.payload);
          const providerGrant = model === "RefreshToken" ? await lockProviderGrant(client,envelope) : undefined;
          const row = (await client.query(`SELECT * FROM ${artifacts} WHERE model=$1 AND artifact_id_hash=$2 FOR UPDATE`, [model,lookupHash(id)])).rows[0];
          if (!row) throw new errors.InvalidGrant(`${model} is unavailable or already used`);
          if (familyId(model,id,row.payload) !== familyId(model,id,initial.payload)) throw new errors.InvalidGrant("artifact family changed");
          if (envelope.binding) {
            assertHostedPayload(model,id,row.payload,envelope.binding);
            if (row.grant_id !== envelope.family) throw new errors.InvalidGrant("stored family mismatch");
            const policy = await currentPolicy(client,envelope.family,envelope.binding);
            if (!policy?.active) throw new errors.InvalidGrant("hosted family inactive");
            if (row.consumed_at === null && model === "RefreshToken") {
              await normalizeProviderGrant(client,providerGrant,policy);
              const normalized = normalize(model,row.payload,row.expires_at,policy);
              await client.query(`UPDATE ${artifacts} SET payload=$3::jsonb,expires_at=$4 WHERE model=$1 AND artifact_id_hash=$2 AND consumed_at IS NULL`,
                [model,lookupHash(id),JSON.stringify(normalized.payload),normalized.expiresAt]);
            }
          }
          const result = await client.query(`UPDATE ${artifacts} AS artifact
            SET consumed_at=clock_timestamp(),updated_at=clock_timestamp()
            WHERE model=$1 AND artifact_id_hash=$2 AND consumed_at IS NULL
              AND (expires_at IS NULL OR expires_at>clock_timestamp())
              AND (grant_id IS NULL OR NOT EXISTS (SELECT 1 FROM ${tombstones} t WHERE t.grant_id=artifact.grant_id))
            RETURNING grant_id`, [model,lookupHash(id)]);
          // A parallel CAS loser never revokes the winning rotation. A later
          // find still exposes consumed_at to the provider's replay path.
          if (result.rowCount !== 1) throw new errors.InvalidGrant(`${model} is unavailable or already used`);
        }, connection);
      } finally { connection?.release(); }
    },

    async destroy(id) {
      await requireBoundContext(model,id);
      // Teardown is intentionally possible after canonical authority is revoked.
      await pool.query(`DELETE FROM ${artifacts} WHERE model=$1 AND artifact_id_hash=$2`, [model,lookupHash(id)]);
    },

    async find(id) {
      await requireBoundContext(model,id);
      try { return await readArtifact(model,"artifact_id_hash",lookupHash(id),id); }
      catch (error) { if (error instanceof errors.InvalidGrant) return undefined; throw error; }
    },

    async promoteHostedGrant(id, { hostedGrantId, accountId, clientId }) {
      if (model !== "Grant") throw new TypeError("only a Grant can be promoted");
      if (adminTransactionContext(false)) throw new AdminTransactionError("hosted_promotion_transaction_forbidden");
      await requireBoundContext(model,id);
      // This is the EXISTING immutable OAuth resource binding, with its
      // existing insert ACL and canonical tuple guard, not an authority write.
      // Complete this DCR-first transaction before taking any stream/family.
      await transaction(pool, async client => {
        await client.query("SELECT client_id FROM commonswarm_oauth.registered_clients WHERE client_id=$1 FOR UPDATE", [clientId]);
        await client.query(`INSERT INTO commonswarm_oauth.provider_grant_resources
          (provider_grant_id,resource,grant_class,owner_user_id,client_id,connection_id,hosted_grant_id)
          VALUES($1,$2,'hosted_mcp',$3::uuid,$4,$5::uuid,$5::uuid)
          ON CONFLICT(provider_grant_id) DO NOTHING`, [id,resource,accountId,clientId,hostedGrantId]);
      });
      const promoted = await readArtifact(model,"artifact_id_hash",lookupHash(id),id,true);
      if (!promoted) throw new errors.InvalidGrant("hosted Grant unavailable");
    },

    async findByUid(uid) {
      const result = await readArtifact(model,"uid",uid);
      if (result) await requireBoundContext(model,result.jti ?? "",result);
      return result;
    },

    async findByUserCode(userCode) {
      const result = await readArtifact(model,"user_code_hash",lookupHash(userCode));
      if (result) await requireBoundContext(model,result.jti ?? "",result);
      return result;
    },

    async retireInactiveHostedFamily(grantId, accountId) {
      await requireBoundContext("Grant", grantId, { grantId });
      if (adminTransactionContext(false)) return false;
      return transaction(pool, async client => {
        const binding = await bindingFor(client,grantId);
        if (binding?.grant_class !== "hosted_mcp" || binding.owner_user_id !== accountId) return false;
        const payload = { accountId, clientId: binding.client_id, resources: { [resource]: "" } };
        const envelope = await lockFamily(client,"Grant",grantId,payload,true);
        const providerGrant = await lockProviderGrant(client,envelope,true);
        const policy = await currentPolicy(client,grantId,binding);
        await retireLockedHostedFamily(client,envelope,policy,providerGrant);
        return policy?.active === true;
      });
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
        const envelope = await lockFamily(client,model,id,payload);
        const providerGrant = model === "RefreshToken" ? await lockProviderGrant(client,envelope) : undefined;
        const existing = adminTransactionContext(false) ? undefined :
          (await client.query(`SELECT * FROM ${artifacts} WHERE model=$1 AND artifact_id_hash=$2 FOR UPDATE`,
            [model,lookupHash(id)])).rows[0];
        let policy = envelope.policy;
        if (envelope.binding) {
          if (existing) {
            assertHostedPayload(model,id,existing.payload,envelope.binding);
            if (familyId(model,id,existing.payload) !== envelope.family ||
                (model !== "Grant" && existing.grant_id !== envelope.family)) throw new errors.InvalidGrant("stored family mismatch");
          }
          policy = await currentPolicy(client,envelope.family,envelope.binding);
          if (!policy || (!policy.active && !(model === "Grant" && policy.state === "pending"))) {
            throw new errors.InvalidGrant("hosted family inactive");
          }
        }
        // A consumed conflict keeps its complete terminal snapshot. Never
        // normalize it, erase consumption, or let save rewrite replay evidence.
        if (existing?.consumed_at !== null && existing?.consumed_at !== undefined) return;
        await normalizeProviderGrant(client,providerGrant,policy);
        const normalized = normalize(model,stored,expiresAt,policy);

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
          [model, lookupHash(id), JSON.stringify(normalized.payload), grantId, stored.uid ?? null,
            stored.userCode ? lookupHash(stored.userCode) : null, normalized.expiresAt],
        );
      });
    },
  });
  return factory;
}
