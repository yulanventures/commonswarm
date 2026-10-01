import { randomUUID } from 'node:crypto';
import {
  ADMIN_RESOURCE, ADMIN_REGISTRY_VERSION, ADMIN_ISSUANCE_CEILINGS, ADMIN_RENEWAL_CEILINGS,
  type AdminManifest, type AdminDecisionContext, type AdminAccountState, type AdminCommand,
  decideAdminAuthority, reduceAdminAuthority, emptyAdminAccount,
} from '../../src/protocol/index.js';

export function adminManifest(now: number, workspaceIds: string[] = []): AdminManifest {
  return {
    admin_identity_id: randomUUID(), connection_id: randomUUID(), client_id: 'lane-b-runtime',
    resource: ADMIN_RESOURCE, mode: 'granular', registry_version: ADMIN_REGISTRY_VERSION,
    scope_names: ['admin:read'], workspace_selector: 'selected', workspace_ids: workspaceIds,
    created_workspace_policy: { scope_names: [] },
    target_rules: { seat_ids: [], own_seats: false, grant_created_seats: false, recipient_user_ids: [], recipient_connection_ids: [], transports: [] },
    worker_scope_ceiling: [], role_ceiling: 'member',
    renewal_limits: { ...ADMIN_RENEWAL_CEILINGS, grant_kinds: [], principal_ids: [] },
    issuance_limits: { ...ADMIN_ISSUANCE_CEILINGS },
    expires_at: now + 86400000, refresh_deadline: now + 86400000,
  };
}
export function adminCoreFixture(workspaceIds: string[] = []) {
  const now = 1_800_000_000_000, owner = randomUUID(), grantId = randomUUID(), receipt = randomUUID();
  const manifest = adminManifest(now, workspaceIds), session = 'a'.repeat(64);
  let seq = 0;
  const ctx: AdminDecisionContext = {
    now, owner_user_id: owner, actor: { kind: 'human', user_id: owner, session_binding: session },
    command_id: randomUUID(), stream_id: randomUUID(), request_digest: 'b'.repeat(64),
    nextSeq: () => ++seq, nextEventId: randomUUID,
    current_workspace_rights: true, withdrawing_workspace_owner: false, target_workspace_owned_by_grantor: false, presenting_refresh_generation: null, presenting_refresh_lineage_id: null,
  };
  let state: AdminAccountState = emptyAdminAccount();
  const run = (command: AdminCommand) => {
    ctx.command_id = randomUUID();
    const decision = decideAdminAuthority(command, state, ctx);
    for (const event of decision.events) state = reduceAdminAuthority(state, event);
    // Session binding is private authentication evidence in the receipt table.
    for (const c of Object.values(state.consents)) c.session_binding = session;
    return decision;
  };
  const prepare = run({ kind: 'prepare_admin_consent', consent: {
    consent_receipt_id: receipt, owner_user_id: owner, session_binding: session,
    manifest, manifest_digest: 'c'.repeat(64), full_account_selected: false,
    expires_at: now + 300000, consumed_at: null,
  } });
  return { now, owner, grantId, receipt, manifest, session, ctx, run, prepare, state: () => state };
}
