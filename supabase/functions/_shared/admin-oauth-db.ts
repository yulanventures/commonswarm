import type postgres from 'npm:postgres@3.4.9';
import { ADMIN_RESOURCE, canonicalAdminJson } from './protocol.js';
import { AdminJwtVerifier, AdminRequestVerifier, isAdminAdmission, adminAdmissionDigest, type AdminAdmission, type ProofOutcome } from './admin-oauth-auth.ts';

type Sql = postgres.TransactionSql<Record<string, unknown>>;
import type { AdminAuditKind, AdminSecurityReason } from './admin-oauth-auth.ts';
export type { AdminAuditKind, AdminSecurityReason } from './admin-oauth-auth.ts';
export async function adminDbRole(tx: Sql, role: 'swarm_command' | 'commonswarm_oauth_runtime'): Promise<void> {
  await tx`SELECT set_config('role', ${role}, true), set_config('search_path', 'pg_catalog', true),
    set_config('lock_timeout', '5s', true)`;
}
export function createAdminRequestVerifier(db: postgres.Sql, jwt = new AdminJwtVerifier()): AdminRequestVerifier {
  return new AdminRequestVerifier(jwt, {
    admit: async (jti, jkt, domain, iat, nonce) => await db.begin(async tx => {
      await adminDbRole(tx, 'commonswarm_oauth_runtime');
      await tx`SELECT set_config('statement_timeout', '10s', true)`;
      const [row] = await tx<{ status: ProofOutcome }[]>`SELECT commonswarm_oauth.admit_dpop_proof(
        ${jti}, ${jkt}, ${domain}, ${iat}::bigint, ${nonce}) AS status`;
      if (!row) throw new Error('proof_store_unavailable');
      return row.status;
    }) as unknown as ProofOutcome,
    registerNonce: async (digest, jkt) => await db.begin(async tx => {
      await adminDbRole(tx, 'commonswarm_oauth_runtime');
      await tx`SELECT set_config('statement_timeout', '10s', true)`;
      const [row] = await tx<{ registered: boolean }[]>`SELECT commonswarm_oauth.register_dpop_nonce(${digest}, ${jkt}, 'admin_resource') AS registered`;
      return row?.registered === true;
    }) as unknown as boolean,
  });
}
export interface AdminAccessState {
  known: boolean; active: boolean; capabilities: string[];
}
/** Run under the same authority transaction before snapshot, replay or execution.
 * Prior live generations are valid. The exact ledger row supplies generation;
 * it is never guessed from the family's newest generation. */
export async function adminAccessState(tx: Sql, admission: AdminAdmission): Promise<AdminAccessState> {
  if (!isAdminAdmission(admission)) return { known: false, active: false, capabilities: [] };
  const t = admission.token;
  await adminDbRole(tx, 'commonswarm_oauth_runtime');
  try {
    // Match the resolver/denial order, and acquire the account write lock before
    // its shared status read. Two different kids must not both hold SHARE and
    // then wait to upgrade the same account during command execution.
    await tx`SELECT commonswarm_oauth.issuer_key_allowed(${'https://mcp.commonswarm.com'}, ${t.kid})`;
    const [locator] = await tx<{ verification_version: number; ledger_scopes: string[] }[]>`
      SELECT b.verification_version, i.scope_names AS ledger_scopes
      FROM commonswarm_oauth.admin_access_issuances i JOIN commonswarm_oauth.admin_grant_bindings b USING(provider_grant_id)
      WHERE i.access_jti=${t.jti} AND i.access_token_digest=${adminAdmissionDigest(admission)}
        AND i.provider_grant_id=${t.grant_id} AND i.admin_grant_id=${t.admin_grant_id}::uuid
        AND i.client_id=${t.client_id} AND i.resource=${t.resource} AND i.jkt=${t.jkt}
        AND i.manifest_digest=${t.manifest_digest} AND i.issued_at=${new Date(t.issued_at)}
        AND i.expires_at=${new Date(t.expires_at)} AND i.kid=${t.kid}
        AND b.owner_user_id=${t.owner_user_id}::uuid AND b.admin_identity_id=${t.admin_identity_id}::uuid
        AND b.connection_id=${t.connection_id}::uuid AND b.registry_version=${t.registry_version}
    `;
    if (!locator || canonicalAdminJson([...locator.ledger_scopes].sort()) !== canonicalAdminJson([...t.scope_names].sort())) {
      return { known: false, active: false, capabilities: [] };
    }
    await adminDbRole(tx, 'swarm_command');
    await tx`SELECT active FROM commonswarm_oauth.lock_admin_client_verification(${t.client_id}, ${locator.verification_version})`;
    await tx`SELECT user_id FROM swarm.users WHERE user_id=${t.owner_user_id}::uuid FOR UPDATE`;
    await tx`SELECT owner_user_id FROM swarm.admin_accounts WHERE owner_user_id=${t.owner_user_id}::uuid FOR UPDATE`;
    await adminDbRole(tx, 'commonswarm_oauth_runtime');
    const [row] = await tx<{ active: boolean; capabilities: string[]; scope_names: string[]; registry_version: number;
      manifest_digest: string; jkt: string; admin_grant_id: string; admin_identity_id: string;
      connection_id: string; client_id: string; resource: string; generation: number;
      issued_at: Date; expires_at: Date; kid: string; ledger_scopes: string[] }[]>`
      SELECT s.admin_grant_id, s.admin_identity_id, s.connection_id, s.client_id, s.resource,
        s.jkt, s.manifest_digest, s.registry_version, s.scope_names, s.capabilities, i.scope_names AS ledger_scopes,
        commonswarm_oauth.admin_access_is_active(${t.jti}, ${adminAdmissionDigest(admission)}, ${t.grant_id},
          ${t.admin_grant_id}::uuid, ${t.owner_user_id}::uuid, i.generation, ${t.client_id}, ${t.resource},
          ${t.jkt}, ${t.manifest_digest}, ${new Date(t.issued_at)}, ${new Date(t.expires_at)}, ${t.kid}) AS active
      FROM commonswarm_oauth.resolve_admin_grant_status(${t.grant_id}, ${t.owner_user_id}::uuid, ${t.kid}) s
      JOIN commonswarm_oauth.admin_access_issuances i ON i.provider_grant_id=${t.grant_id}
      WHERE i.access_jti=${t.jti} AND i.access_token_digest=${adminAdmissionDigest(admission)}
        AND i.admin_grant_id=${t.admin_grant_id}::uuid AND i.client_id=${t.client_id} AND i.resource=${ADMIN_RESOURCE}
        AND i.jkt=${t.jkt} AND i.manifest_digest=${t.manifest_digest}
        AND i.issued_at=${new Date(t.issued_at)} AND i.expires_at=${new Date(t.expires_at)} AND i.kid=${t.kid}
    `;
    const known = !!row && row.admin_grant_id === t.admin_grant_id && row.admin_identity_id === t.admin_identity_id &&
      row.connection_id === t.connection_id && row.client_id === t.client_id && row.resource === t.resource &&
      row.registry_version === t.registry_version && row.jkt === t.jkt && row.manifest_digest === t.manifest_digest &&
      canonicalAdminJson([...row.ledger_scopes].sort()) === canonicalAdminJson([...t.scope_names].sort());
    return { known, active: known && row!.active === true && t.scope_names.every(s => row!.scope_names.includes(s)),
      capabilities: known ? row!.capabilities : [] };
  } finally { await adminDbRole(tx, 'swarm_command'); }
}
export async function adminRequestAudit(tx: Sql, admission: AdminAdmission, kind: AdminAuditKind, requestId: string,
  outcome: 'committed' | 'refused', reason: AdminSecurityReason | null = null,
  events: string[] = []): Promise<void> {
  if (!isAdminAdmission(admission)) throw new Error('invalid_admin_admission');
  // NULL is a counted read beyond the cap. The helper always preserves actions.
  await tx`SELECT commonswarm_oauth.record_admin_request_audit(${admission.token.jti}, ${adminAdmissionDigest(admission)}, ${kind},
    ${requestId}, ${outcome}, ${reason}::commonswarm_oauth.admin_security_reason, NULL, NULL, ${events}::uuid[])`;
}
export async function adminSecurityFailure(tx: Sql, reason: AdminSecurityReason): Promise<void> {
  await tx`SELECT commonswarm_oauth.record_admin_security_failure(${reason}::commonswarm_oauth.admin_security_reason)`;
}
