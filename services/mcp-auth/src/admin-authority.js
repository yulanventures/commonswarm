import { adminProofAdmitted } from "./admin-dpop.js";
import { randomUUID, createHash } from "node:crypto";
import { decideAdminAuthority, reduceAdminAuthority, emptyAdminAccount, adminRatePolicy, adminAccountWithDurableGrants } from "./admin-authority.generated.js";
import { adminManifestValid, canonicalAdminJson } from "./admin-policy.generated.js";
import { adminTransactionContext, adminQuery, withAdminRole, AdminTransactionError } from "./admin-transaction.js";

export function consentManifest(grant) {
  const { grant_id, owner_user_id, consent_receipt_id, manifest_digest, created_at, state,
    suspended_at, revoked_at, reason_code, withdrawn_workspace_ids, replaces_grant_id, ...manifest } = grant;
  return manifest;
}
const hash = value => createHash("sha256").update(canonicalAdminJson(value)).digest("hex");
const grantColumns = ["grant_id", "owner_user_id", "admin_identity_id", "connection_id", "client_id", "resource", "mode",
  "registry_version", "scope_names", "workspace_selector", "workspace_ids", "created_workspace_policy", "target_rules",
  "worker_scope_ceiling", "role_ceiling", "renewal_limits", "issuance_limits", "expires_at", "refresh_deadline", "state",
  "consent_receipt_id", "manifest_digest", "created_at", "suspended_at", "revoked_at", "reason_code", "withdrawn_workspace_ids"];
const dates = new Set(["expires_at", "refresh_deadline", "created_at", "suspended_at", "revoked_at"]);
const json = new Set(["created_workspace_policy", "target_rules", "renewal_limits", "issuance_limits"]);

// Only an established coordinator context can reach command privileges.
export class AdminAuthorityBridge {
  async account(owner) {
    return withAdminRole("swarm_command", async () => {
      await adminQuery(`INSERT INTO swarm.admin_accounts(owner_user_id,stream_id)
        VALUES($1,$2) ON CONFLICT(owner_user_id) DO NOTHING`, [owner, randomUUID()]);
      const row = (await adminQuery(`SELECT * FROM swarm.admin_accounts
        WHERE owner_user_id=$1 FOR UPDATE`, [owner])).rows[0];
      let state = structuredClone(row.projection ?? emptyAdminAccount());
      const grants = (await adminQuery(`SELECT grant_id,state,manifest_digest,expires_at,refresh_deadline,revoked_at,suspended_at,reason_code
        FROM swarm.admin_grants WHERE owner_user_id=$1 ORDER BY grant_id FOR UPDATE`, [owner])).rows;
      const reconciled = adminAccountWithDurableGrants(state, grants.map(g => ({ ...g,
        expires_at: new Date(g.expires_at).getTime(), refresh_deadline: new Date(g.refresh_deadline).getTime(),
        revoked_at: g.revoked_at == null ? null : new Date(g.revoked_at).getTime(),
        suspended_at: g.suspended_at == null ? null : new Date(g.suspended_at).getTime() })));
      if (!reconciled) throw new AdminTransactionError("admin_projection_inconsistent");
      state = reconciled;
      for (const consent of (await adminQuery(`SELECT * FROM swarm.admin_consents WHERE owner_user_id=$1`, [owner])).rows) {
        state.consents[consent.consent_receipt_id] = { ...consent,
          expires_at: new Date(consent.expires_at).getTime(),
          consumed_at: consent.consumed_at == null ? null : new Date(consent.consumed_at).getTime() };
      }
      return { ...row, projection: state };
    });
  }
  async rights(owner, grant) {
    const now = Number((await adminQuery("SELECT floor(extract(epoch FROM clock_timestamp()))::bigint*1000 AS now")).rows[0].now);
    if (!grant || !adminManifestValid(grant.grant_id ? consentManifest(grant) : grant, now, false)) return false;
    if (grant.withdrawn_workspace_ids?.length) return false;
    const ids = [...grant.workspace_ids].sort();
    if (!ids.length) return true;
    return withAdminRole("swarm_command", async () => {
      const rows = (await adminQuery(`SELECT m.workspace_id,m.role,m.revoked_at,w.archived_at
        FROM swarm.memberships m JOIN swarm.workspaces w USING(workspace_id)
        WHERE m.user_id=$1 AND m.workspace_id=ANY($2::uuid[])
        ORDER BY m.workspace_id FOR SHARE OF m,w`, [owner, ids])).rows;
      const management = grant.scope_names.some(s => s !== "admin:read" && s !== "workspaces:create");
      return rows.length === ids.length && rows.every(r => r.revoked_at == null && r.archived_at == null &&
        (!management || ["owner", "admin"].includes(r.role)));
    });
  }
  async decide(account, command, actor, facts = {}) {
    const scope = adminTransactionContext();
    if (!scope.capability || scope.capability.owner !== account.owner_user_id) {
      throw new AdminTransactionError("admin_lifecycle_capability_required");
    }
    if (actor.kind === "credential_runtime" && (scope.capability.kind !== "token" || !adminProofAdmitted(scope.capability.proof))) {
      throw new AdminTransactionError("admin_verified_proof_required");
    }
    if (actor.kind === "human") {
      if (scope.capability.kind !== "human" || !Buffer.isBuffer(scope.capability.sessionHash) ||
          scope.capability.sessionHash.toString("hex") !== actor.session_binding ||
          !(await adminQuery(`SELECT 1 FROM commonswarm_oauth.browser_sessions WHERE session_hash=$1 AND user_id=$2
            AND invalidated_at IS NULL AND expires_at>clock_timestamp()
            AND authenticated_at BETWEEN clock_timestamp()-interval '5 minutes' AND clock_timestamp() FOR SHARE`,
          [scope.capability.sessionHash, account.owner_user_id])).rowCount) {
        throw new AdminTransactionError("admin_fresh_human_required");
      }
    }
    const now = (await adminQuery("SELECT floor(extract(epoch FROM clock_timestamp()))::bigint*1000 AS now")).rows[0].now;
    let seq = Number(account.seq);
    const grant = account.projection.grants[command.grant_id];
    // A new grant does not exist yet. Recheck the selected workspaces on its
    // pending receipt, rather than treating the absent grant as absent rights.
    const manifest = command.kind === "grant_admin_delegation"
      ? account.projection.consents[command.consent_receipt_id]?.manifest
      : command.consent?.manifest ?? grant;
    if (grant) await withAdminRole("swarm_command", async () => {
      const policies = adminRatePolicy(actor, grant, command.kind, null,
        command.credential_lineage_id ?? null, command.grant_id).sort((a, b) => a.key.localeCompare(b.key));
      const hour = Math.floor(Number(now) / 3600000);
      for (const policy of policies) {
        const row = (await adminQuery(`INSERT INTO swarm.admin_rate_buckets(bucket_key,hour_start,attempts)
          VALUES($1,$2,1) ON CONFLICT(bucket_key,hour_start) DO UPDATE SET attempts=swarm.admin_rate_buckets.attempts+1
          RETURNING attempts`, [policy.key, hour])).rows[0];
        account.projection.rate_buckets[policy.key] = { hour_start: hour, attempts: row.attempts - 1 };
      }
    });
    const decision = decideAdminAuthority(command, account.projection, {
      actor, owner_user_id: account.owner_user_id, now: Number(now), command_id: scope.requestId,
      stream_id: account.stream_id, request_digest: hash(command), nextSeq: () => ++seq, nextEventId: randomUUID,
      current_workspace_rights: await this.rights(account.owner_user_id, manifest),
      withdrawing_workspace_owner: false, target_workspace_owned_by_grantor: false,
      presenting_refresh_generation: facts.generation ?? null, presenting_refresh_lineage_id: facts.lineageId ?? null,
    });
    if (facts.oauthStep) for (const event of decision.events) {
      if (["AdminMetadataRead", "AdminActionRecorded"].includes(event.type)) event.payload = { ...event.payload, oauth_step: facts.oauthStep };
    }
    if (facts.family) for (const event of decision.events) {
      if (["AdminCredentialIssued", "AdminCredentialRotated", "AdminCredentialReplayDetected"].includes(event.type)) {
        event.payload = { ...event.payload, provider_grant_id: facts.family, version: 2 };
      }
    }
    await this.persist(account, decision.events);
    if (command.kind === "prepare_admin_consent" && decision.ok) {
      account.projection.consents[command.consent.consent_receipt_id].session_binding = command.consent.session_binding;
    }
    return decision;
  }
  async persist(account, events) {
    return withAdminRole("swarm_command", async () => {
      let next = account.projection;
      for (const event of events) {
        next = reduceAdminAuthority(next, event);
        await adminQuery(`INSERT INTO swarm.admin_events(owner_user_id,seq,event_id,command_id,event)
          VALUES($1,$2,$3,$4,$5::jsonb)`,
          [account.owner_user_id, event.seq, event.event_id, event.command_id, JSON.stringify(event)]);
      }
      for (const g of Object.values(next.grants)) {
        const values = grantColumns.map(key => dates.has(key) ? (g[key] == null ? null : new Date(g[key]))
          : json.has(key) ? JSON.stringify(g[key]) : g[key]);
        await adminQuery(`INSERT INTO swarm.admin_grants(${grantColumns.join(",")})
          VALUES(${grantColumns.map((_key, i) => `$${i + 1}`).join(",")})
          ON CONFLICT(grant_id) DO UPDATE SET state=EXCLUDED.state,revoked_at=EXCLUDED.revoked_at,
            suspended_at=EXCLUDED.suspended_at,reason_code=EXCLUDED.reason_code`, values);
      }
      for (const c of Object.values(next.consents)) {
        if (c.consumed_at != null) await adminQuery(`UPDATE swarm.admin_consents SET consumed_at=$2
          WHERE consent_receipt_id=$1 AND owner_user_id=$3`, [c.consent_receipt_id, new Date(c.consumed_at), account.owner_user_id]);
      }
      const projection = { ...next, consents: Object.fromEntries(Object.entries(next.consents)
        .map(([key, c]) => [key, { ...c, session_binding: "" }])) };
      await adminQuery(`UPDATE swarm.admin_accounts SET projection=$2::jsonb,seq=$3 WHERE owner_user_id=$1`,
        [account.owner_user_id, JSON.stringify(projection), events.at(-1)?.seq ?? account.seq]);
      account.projection = next; account.seq = events.at(-1)?.seq ?? account.seq;
      return next;
    });
  }
}
