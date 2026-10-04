/** Household HTTP/MCP boundary. Identities and credential rechecks come from
 * the existing command transaction, never from tool arguments. */
import type postgres from 'postgres';
import * as core from '../_shared/protocol.js';
import { createHouseholdObjectStore, type HouseholdIdentity, type HouseholdCredentialRecheck } from './household-objects.ts';
import * as transfers from './household-transfers.ts';
import { FILE_BUCKET, fileContentAllowed } from './file-artifacts.ts';
import type { HouseholdContent, HouseholdRevision } from '../_shared/household-object-events.d.ts';

type Sql = postgres.TransactionSql<Record<string, unknown>>;
export const HOUSEHOLD_SURFACE_KINDS = ['household_tool', 'household_draft', 'household_permissions', 'household_access', 'household_connections'] as const;
const localSeat = core.HOUSEHOLD_LOCAL_SEAT;
const refused = (reason: string) => ({ status: 'refused', reason });
export const householdRevisionMetadata = (revision: HouseholdRevision) => ({
  revision: revision.revision, parent: revision.parent, title: revision.title,
  kind: revision.kind, file_metadata: revision.file_metadata,
  blob: { size_bytes: revision.blob.size_bytes, sha256: revision.blob.sha256 },
  author: revision.author, occurred_at_server: revision.occurred_at_server, command_id: revision.command_id,
});

export function householdStore(recheckCredential: HouseholdCredentialRecheck, newFileIdentity?: (objectId: string) => { file_id: string; name: string }) {
  const base = Deno.env.get('SUPABASE_URL');
  const credential = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!base || !credential) throw new transfers.HouseholdTransferError('storage_unavailable');
  return createHouseholdObjectStore({ core: core as unknown as Parameters<typeof createHouseholdObjectStore>[0]['core'], transfers, fileContentAllowed, recheckCredential, newFileIdentity,
    storage: transfers.createHouseholdTransferStorage({ storageBaseUrl: `${base.replace(/\/$/, '')}/storage/v1`,
      bucket: FILE_BUCKET, serviceCredential: credential }) });
}

/** Reserved IDs/expiry are server facts recovered from the durable projection.
 * The workspace lock covers preparation, quota, decision and receipt together. */
export async function executeHouseholdSurface(tx: Sql, workspaceId: string, identity: HouseholdIdentity,
  requestId: string, value: Record<string, unknown>, recheckCredential: HouseholdCredentialRecheck,
  attachment?: Uint8Array): Promise<Record<string, unknown>> {
  const store = householdStore(recheckCredential);
  if (value.kind === 'household_connections') {
    if (identity.principal_id !== null || !await recheckCredential(tx, identity)) return refused('human_confirmation_required');
    const access = await store.access(tx, workspaceId, identity);
    if (!access || core.householdAccessRefusal(access.facts, workspaceId, 'read', access.now)) return refused('workspace_access_refused');
    const hosted = await tx`SELECT 'hosted' AS kind,s.seat_id AS connection_id,s.grant_id,s.principal_id,p.name
      FROM swarm.hosted_mcp_seats s JOIN swarm.agent_principals p USING(principal_id)
      JOIN swarm.hosted_mcp_grants g USING(grant_id)
      JOIN swarm.hosted_mcp_grant_workspaces b ON b.grant_id=s.grant_id AND b.workspace_id=s.workspace_id
      WHERE s.workspace_id=${workspaceId}::uuid AND s.owner_user_id=${identity.user_id}::uuid
        AND g.state='active' AND g.revoked_at IS NULL AND s.revoked_at IS NULL AND p.revoked_at IS NULL AND b.revoked_at IS NULL
      ORDER BY s.created_at LIMIT 50`;
    const local = await tx`SELECT 'local' AS kind,t.token_id AS connection_id,t.run_id AS grant_id,t.principal_id,p.name
      FROM swarm.agent_tokens t JOIN swarm.agent_principals p USING(principal_id) JOIN swarm.agent_runs r ON r.run_id=t.run_id AND r.principal_id=t.principal_id
      JOIN swarm.devices d ON d.device_id=r.device_id
      WHERE p.workspace_id=${workspaceId}::uuid AND p.owner_user_id=${identity.user_id}::uuid AND p.transport='local'
        AND t.revoked_at IS NULL AND NOT t.surrender_only AND t.expires_at>clock_timestamp() AND p.revoked_at IS NULL AND r.ended_at IS NULL AND d.revoked_at IS NULL
      ORDER BY t.issued_at DESC LIMIT 50`;
    return { status: 'ok', connections: [...hosted,...local].map(row => ({ kind: row.kind, connection_id: row.connection_id,
      grant_id: row.grant_id, principal_id: row.principal_id, name: row.name })) };
  }
  if (value.kind === 'household_access') {
    const access = await store.access(tx, workspaceId, identity);
    if (!access || core.householdAccessRefusal(access.facts, workspaceId, 'read', access.now)) return refused('workspace_access_refused');
    return { status: 'ok', content_role: access.facts.member!.content_role,
      operations: core.HOUSEHOLD_CONTENT_OPERATIONS.filter(op => !core.householdAccessRefusal(access.facts, workspaceId, op, access.now)) };
  }
  if (value.kind === 'household_draft') {
    if (typeof value.draft_id !== 'string' || value.draft_id.length > 255) return refused('invalid_request');
    const result = await store.readBytes(tx, workspaceId, identity, { kind: 'draft_read', draft_id: value.draft_id });
    if (!('bytes' in result) || result.metadata.kind !== 'draft_read') return result;
    const draft = result.metadata.draft;
    const current = await store.readBytes(tx, workspaceId, identity, { kind: 'object_read', object_id: draft.object_id, revision: draft.current });
    const base = await store.readBytes(tx, workspaceId, identity, { kind: 'object_read', object_id: draft.object_id, revision: draft.base });
    if (!('bytes' in current) || !('bytes' in base) || current.metadata.kind !== 'object_read' || base.metadata.kind !== 'object_read') return refused('revision_not_found');
    if (draft.kind === 'file') return refused('protected_attachment_required');
    return { status: 'ok', workspace_id: workspaceId, object_id: draft.object_id, draft_id: draft.draft_id,
      owner_user_id: draft.owner.user_id, proposed: transfers.decodeHouseholdContent(result.bytes, draft.kind),
      base: { ...householdRevisionMetadata(base.metadata.revision), live: base.metadata.live,
        content: transfers.decodeHouseholdContent(base.bytes, draft.kind) },
      current: { ...householdRevisionMetadata(current.metadata.revision), live: current.metadata.live,
        content: transfers.decodeHouseholdContent(current.bytes, draft.kind) } };
  }
  if (value.kind !== 'household_tool' || typeof value.tool !== 'string') return refused('invalid_request');
  const args = core.validateHouseholdToolArguments(value.tool, value.arguments);
  if (args.request_id !== undefined && args.request_id !== requestId) return refused('request_id_mismatch');
  // Local seat text supplies schema parity only. Existing token/session auth
  // determines identity; it never selects a different local principal.
  if (identity.connection === null && args.seat !== localSeat) return refused('seat_binding_mismatch');
  const access = await store.access(tx, workspaceId, identity);
  const operation = core.householdToolOperation(value.tool, args);
  if (!access) return refused('workspace_access_refused');
  const denied = core.householdAccessRefusal(access.facts, workspaceId, operation, access.now);
  if (denied) return refused(denied);
  const reservationId = 'upload_' + await transfers.householdSha256(new TextEncoder().encode(JSON.stringify([workspaceId, identity.principal_id ?? identity.user_id, requestId])));
  const state = await store.state(tx, workspaceId, false);
  const previous = state.reservations[reservationId];
  const invocation = core.householdToolInvocation(value.tool, args, { workspace_id: workspaceId,
    upload: { reservation_id: reservationId, expires_at: previous?.expires_at ?? access.now + 15 * 60_000 } });
  if ('query' in invocation) {
    if ('limit' in invocation.query && invocation.query.limit > 100) return refused('page_limit_exceeded');
    if (invocation.query.kind === 'object_read') {
      const result = await store.readBytes(tx, workspaceId, identity, invocation.query);
      if (!('bytes' in result) || result.metadata.kind !== 'object_read') return result;
      const meta = result.metadata;
      if (!invocation.objectTypes.includes(meta.revision.kind)) return refused('object_type_mismatch');
      return { ...meta, revision: householdRevisionMetadata(meta.revision),
        ...(meta.revision.kind === 'file' ? {} : { content: transfers.decodeHouseholdContent(result.bytes, meta.revision.kind) }) };
    }
    const result = await store.read(tx, workspaceId, identity, invocation.query);
    if (result.status === 'ok' && result.kind === 'object_history') return { ...result,
      revisions: result.revisions.map((revision) => ({ ...householdRevisionMetadata(revision), live: revision.live })) };
    return result;
  }
  const command = invocation.command;
  let proposal = null;
  if (command.kind === 'create_household_object') proposal = { content: command.content };
  if (command.kind === 'update_household_object') {
    const result = await store.readBytes(tx, workspaceId, identity, { kind: 'object_read', object_id: command.object_id, revision: command.base });
    if (!('bytes' in result) || result.metadata.kind !== 'object_read') return refused('revision_not_found');
    const revision = result.metadata.revision;
    if (revision.kind === 'file') return refused('object_type_mismatch');
    const content = core.applyHouseholdPatch(transfers.decodeHouseholdContent(result.bytes, revision.kind), command.patch, revision.blob);
    if (!content) return refused('patch_base_mismatch');
    proposal = { content };
  }
  if (command.kind === 'reserve_household_upload') {
    if (!attachment) return refused('protected_attachment_required');
    const content = command.change.kind === 'create' ? command.change.content
      : command.change.patch.kind === 'file' ? command.change.patch.replacement : null;
    if (!content || content.kind !== 'file') return refused('object_type_mismatch');
    proposal = { content, file_bytes: attachment };
  }
  const decision = await store.write(tx, workspaceId, identity, requestId, command, proposal);
  return { ...decision.outcome, request_id: requestId, replayed: decision.replayed };
}
