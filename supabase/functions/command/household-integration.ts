/** Household HTTP/MCP boundary: authenticated transaction inputs produce scoped
 * results. Rechecks never use tool arguments; only byte access needs storage. */
import type postgres from 'postgres';
import * as core from '../_shared/protocol.js';
import { createHouseholdObjectStore, type HouseholdIdentity, type HouseholdCredentialRecheck } from './household-objects.ts';
import { loadHouseholdContentAccess } from './household-content-access.ts';
import { approveHouseholdConnection, withdrawHouseholdConnection } from './household-permissions.ts';
import { createHouseholdTodoStore, type HouseholdTodoNoticePort } from './household-todos.ts';
import { readHouseholdActivity } from './household-activity.ts';
import * as transfers from './household-transfers.ts';
import { FILE_BUCKET, fileContentAllowed } from './file-artifacts.ts';
import type { HouseholdContent, HouseholdRevision } from '../_shared/household-object-events.d.ts';

type Sql = postgres.TransactionSql<Record<string, unknown>>;
export const HOUSEHOLD_SURFACE_KINDS = ['household_tool', 'household_draft', 'household_permissions', 'household_access', 'household_connections', 'household_approve_connection', 'household_withdraw_connection', 'household_todo_answer', 'household_todo_steer', 'household_agent_work_policy', 'household_activity'] as const;
const localSeat = core.HOUSEHOLD_LOCAL_SEAT;
const refused = (reason: string) => ({ status: 'refused', reason });
export const householdRevisionMetadata = (revision: HouseholdRevision) => ({
  revision: revision.revision, parent: revision.parent, title: revision.title,
  kind: revision.kind, file_metadata: revision.file_metadata,
  blob: { size_bytes: revision.blob.size_bytes, sha256: revision.blob.sha256 },
  author: revision.author, occurred_at_server: revision.occurred_at_server, command_id: revision.command_id,
});

/** Build a transaction store with lazy byte I/O. Missing configuration fails
 * closed at read/put; metadata and authorization retain their existing paths. */
export function householdStore(recheckCredential: HouseholdCredentialRecheck, newFileIdentity?: (objectId: string) => { file_id: string; name: string }) {
  let storage: transfers.HouseholdStorage | undefined;
  const resolveStorage = () => {
    if (storage) return storage;
    const base = Deno.env.get('SUPABASE_URL');
    const credential = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!base || !credential) throw new transfers.HouseholdTransferError('storage_unavailable');
    return storage = transfers.createHouseholdTransferStorage({ storageBaseUrl: `${base.replace(/\/$/, '')}/storage/v1`,
      bucket: FILE_BUCKET, serviceCredential: credential });
  };
  return createHouseholdObjectStore({ core: core as unknown as Parameters<typeof createHouseholdObjectStore>[0]['core'], transfers, fileContentAllowed, recheckCredential, newFileIdentity,
    storage: { read: (path, maximumBytes) => resolveStorage().read(path, maximumBytes),
      putImmutable: (path, bytes) => resolveStorage().putImmutable(path, bytes) } });
}

/** Reserved IDs/expiry are server facts recovered from the durable projection.
 * The workspace lock covers preparation, quota, decision and receipt together. */
export async function executeHouseholdSurface(tx: Sql, workspaceId: string, identity: HouseholdIdentity,
  requestId: string, value: Record<string, unknown>, recheckCredential: HouseholdCredentialRecheck,
  attachment?: Uint8Array, notice?: HouseholdTodoNoticePort): Promise<Record<string, unknown>> {
  if (value.kind === 'household_approve_connection') return approveHouseholdConnection(tx, workspaceId, identity, requestId, value, recheckCredential);
  if (value.kind === 'household_withdraw_connection') return withdrawHouseholdConnection(tx, workspaceId, identity, requestId, value, recheckCredential);
  // Refuse agent credentials before touching any human-only content or input.
  const humanOnly = ['household_todo_answer', 'household_todo_steer', 'household_agent_work_policy', 'household_activity'].includes(String(value.kind));
  if (humanOnly && identity.principal_id !== null) return refused('human_confirmation_required');
  const store = householdStore(recheckCredential);
  const missingAccess = async () => {
    // A verified owner connection cannot bootstrap a boundary or human content
    // consent. Give the existing precise condition without manufacturing either.
    if (identity.principal_id !== null && identity.connection && await recheckCredential(tx, identity)) {
      const [owner] = await tx`SELECT NOT EXISTS(SELECT 1 FROM swarm.household_workspace_boundaries b
        WHERE b.workspace_id=m.workspace_id) AS missing_boundary FROM swarm.memberships m
        JOIN swarm.hosted_mcp_seats s ON s.workspace_id=m.workspace_id AND s.owner_user_id=m.user_id
        WHERE m.workspace_id=${workspaceId}::uuid AND m.user_id=${identity.user_id}::uuid
          AND m.role='owner' AND m.revoked_at IS NULL AND s.seat_id=${identity.connection.connection_id}::uuid
          AND s.grant_id=${identity.connection.grant_id}::uuid AND s.principal_id=${identity.principal_id}::uuid`;
      if (owner?.missing_boundary) return refused('owner_confirmation_required');
    }
    return refused('workspace_access_refused');
  };
  const todos = createHouseholdTodoStore({ core: core as unknown as Parameters<typeof createHouseholdTodoStore>[0]['core'], access: store.access,
    notice: notice ?? (async () => { throw new Error('Household notice port is required for writes.'); }) });
  if (humanOnly) {
    const command = core.validateHouseholdHumanCommand(value);
    if (command.kind === 'household_activity') return readHouseholdActivity(tx, workspaceId, identity, command, store.access);
    const result = await todos.write(tx, workspaceId, identity, requestId, command);
    return { ...result.outcome, notices: result.notices, request_id: requestId, replayed: result.replayed };
  }
  if (value.kind === 'household_connections') {
    if (identity.principal_id !== null || !await recheckCredential(tx, identity)) return refused('human_confirmation_required');
    const access = await store.access(tx, workspaceId, identity);
    if (!access || core.householdAccessRefusal(access.facts, workspaceId, 'read', access.now)) return refused('workspace_access_refused');
    const hosted = await tx`SELECT 'hosted' AS kind,s.seat_id AS connection_id,s.grant_id,s.principal_id,p.name,g.provider_grant_id,
        g.grant_id AS renewal_grant_id,g.connection_expires_at,g.connection_expired_at,
        (SELECT h.handle FROM swarm.hosted_mcp_seat_handles h WHERE h.seat_id=s.seat_id
          AND h.revoked_at IS NULL ORDER BY h.created_at DESC LIMIT 1) AS handle
      FROM swarm.hosted_mcp_seats s JOIN swarm.agent_principals p USING(principal_id)
      JOIN swarm.hosted_mcp_grants g USING(grant_id)
      JOIN swarm.hosted_mcp_grant_workspaces b ON b.grant_id=s.grant_id AND b.workspace_id=s.workspace_id
      WHERE s.workspace_id=${workspaceId}::uuid AND s.owner_user_id=${identity.user_id}::uuid
        AND g.state='active' AND g.revoked_at IS NULL AND s.revoked_at IS NULL AND p.revoked_at IS NULL AND b.revoked_at IS NULL
      ORDER BY s.created_at LIMIT 50`;
    // Enumerate durable families, including an elapsed technical bearer. The
    // content resolver below alone decides whether a bearer can act now.
    const local = await tx`SELECT DISTINCT ON (g.renewal_grant_id) 'local' AS kind,
        t.token_id AS connection_id,t.run_id AS grant_id,t.principal_id,p.name,t.lineage_id,
        g.renewal_grant_id,(SELECT ap.token_id FROM swarm.local_content_approval_workspaces ap WHERE ap.renewal_grant_id=g.renewal_grant_id AND ap.workspace_id=${workspaceId}::uuid) AS local_content_approval_token_id,g.connection_expires_at,g.connection_expired_at
      FROM swarm.renewal_grants g JOIN swarm.agent_principals p ON p.principal_id=g.principal_id
      JOIN swarm.agent_runs r ON r.run_id=g.run_id AND r.principal_id=g.principal_id
      JOIN swarm.devices d ON d.device_id=r.device_id
      JOIN swarm.agent_tokens t ON t.renewal_grant_id=g.renewal_grant_id AND t.run_id=g.run_id AND t.principal_id=g.principal_id
      WHERE swarm.local_agent_workspace_live(g.principal_id,${workspaceId}::uuid) AND g.created_by=${identity.user_id}::uuid
        AND p.workspace_id=g.workspace_id AND p.owner_user_id=g.created_by AND p.transport='local'
        AND g.revoked_at IS NULL AND NOT g.suspension_active AND g.connection_expired_at IS NULL
        AND (g.connection_expires_at IS NULL OR g.connection_expires_at>clock_timestamp())
        AND t.revoked_at IS NULL AND NOT t.surrender_only AND p.revoked_at IS NULL AND r.ended_at IS NULL
        AND d.revoked_at IS NULL AND d.user_id=g.created_by AND (g.bound_device_id IS NULL OR g.bound_device_id=d.device_id)
        AND swarm.admin_child_live(t.parent_admin_grant_id,${workspaceId}::uuid)
        AND swarm.admin_child_scopes_live(t.parent_admin_grant_id,t.scopes)
        AND NOT EXISTS(SELECT 1 FROM swarm.revocation_tombstones z WHERE (z.kind,z.target_id) IN
          (('token',t.token_id),('principal',t.principal_id),('run',t.run_id),('device',d.device_id),
           ('renewal_grant',g.renewal_grant_id),('lineage',t.lineage_id),('family',t.lineage_id),('membership',g.created_by)))
      ORDER BY g.renewal_grant_id,t.issued_at DESC,t.token_id LIMIT 50`;
    const approvals = await tx`SELECT c.connection_id,c.grant_id,c.principal_id,c.operations,c.expires_at,c.renewal_grant_id,
        (SELECT original.lineage_id FROM swarm.agent_tokens original WHERE original.token_id=c.connection_id
          AND original.renewal_grant_id=c.renewal_grant_id AND original.run_id=c.grant_id AND original.principal_id=c.principal_id) AS lineage_id
      FROM swarm.household_content_connections c
      JOIN swarm.household_member_content_roles rights ON rights.workspace_id=c.workspace_id AND rights.user_id=c.owner_user_id
        AND rights.content_consent_id=c.consent_receipt_id AND rights.revoked_at IS NULL
      JOIN swarm.household_workspace_boundaries boundary ON boundary.workspace_id=c.workspace_id AND boundary.purpose=c.purpose
      WHERE c.workspace_id=${workspaceId}::uuid AND c.owner_user_id=${identity.user_id}::uuid
        AND c.revoked_at IS NULL AND (c.expires_at IS NULL OR c.expires_at>clock_timestamp())
        AND (c.renewal_grant_id IS NULL OR (c.hosted_grant_id IS NULL AND EXISTS(
          SELECT 1 FROM swarm.agent_tokens original JOIN swarm.renewal_grants g ON g.renewal_grant_id=original.renewal_grant_id
          WHERE original.token_id=c.connection_id AND original.run_id=c.grant_id AND original.principal_id=c.principal_id
            AND g.renewal_grant_id=c.renewal_grant_id AND g.created_by=c.owner_user_id
            AND g.run_id=c.grant_id AND g.principal_id=c.principal_id
            AND ((SELECT ap.token_id FROM swarm.local_content_approval_workspaces ap WHERE ap.renewal_grant_id=g.renewal_grant_id AND ap.workspace_id=${workspaceId}::uuid) IS NULL OR (SELECT ap.token_id FROM swarm.local_content_approval_workspaces ap WHERE ap.renewal_grant_id=g.renewal_grant_id AND ap.workspace_id=${workspaceId}::uuid)=c.connection_id))))`;
    const approvalFor = (row: Record<string, unknown>) => {
      const approval = approvals.find(c => c.grant_id === row.grant_id && c.principal_id === row.principal_id
        && (row.kind === 'local' ? ((c.renewal_grant_id === row.renewal_grant_id && c.lineage_id === row.lineage_id)
          || (c.renewal_grant_id == null && c.connection_id === row.connection_id))
          && (row.local_content_approval_token_id == null || c.connection_id === row.local_content_approval_token_id)
          : c.connection_id === row.connection_id && c.renewal_grant_id == null));
      return approval ? { operations: approval.operations,
        expires_at: approval.expires_at == null ? null : new Date(approval.expires_at as string).toISOString() } : null;
    };
    const stamp = (value: unknown) => value == null ? null : new Date(value as string).toISOString();
    const connections = [];
    for (const row of [...hosted,...local]) {
      // Hosted tuples are checked by the existing canonical resolver below.
      let credentialLive = true;
      if (row.kind === 'hosted') {
        const [role] = await tx`SELECT current_setting('role') AS value`;
        await tx`SELECT set_config('role','swarm_read',true)`;
        try {
          const [live] = await tx`SELECT EXISTS(SELECT 1 FROM swarm.resolve_hosted_seat_read_authorization(
            ${String(row.grant_id)}::uuid,${row.handle as string | null}::text,'whoami') a
            WHERE a.workspace_id=${workspaceId}::uuid AND a.principal_id=${String(row.principal_id)}::uuid
              AND a.owner_user_id=${identity.user_id}::uuid)
            AND commonswarm_oauth.provider_family_active(${String(row.provider_grant_id)}::text) AS live`;
          credentialLive = live?.live === true;
        } finally { await tx`SELECT set_config('role',${String(role!.value)},true)`; }
      }
      const effective = credentialLive ? await loadHouseholdContentAccess(tx, workspaceId, {
        user_id: identity.user_id, principal_id: String(row.principal_id),
        run_id: row.kind === 'local' ? String(row.grant_id) : null,
        connection: { connection_id: String(row.connection_id), grant_id: String(row.grant_id) },
      }) : null;
      const operations = effective ? core.HOUSEHOLD_CONTENT_OPERATIONS.filter(op =>
        !core.householdAccessRefusal(effective.facts, workspaceId, op, effective.now)) : [];
      connections.push({ kind: row.kind, connection_id: row.connection_id, grant_id: row.grant_id,
        principal_id: row.principal_id, name: row.name, renewal_grant_id: row.renewal_grant_id,
        connection_expires_at: stamp(row.connection_expires_at), connection_expired_at: stamp(row.connection_expired_at),
        approval: approvalFor(row),
        effective_access: { source: effective?.source ?? 'none', operations,
          restricted: operations.length === 0 || (effective?.facts.member?.content_role === 'editor'
            && operations.length < core.HOUSEHOLD_CONTENT_OPERATIONS.length),
          restrictions: effective?.restriction ?? [] } });
    }
    return { status: 'ok', connections };
  }
  if (value.kind === 'household_access') {
    const access = await store.access(tx, workspaceId, identity);
    if (!access) return missingAccess();
    const denied = core.householdAccessRefusal(access.facts, workspaceId, 'read', access.now);
    if (denied) return refused(denied);
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
  if (!access) return missingAccess();
  const denied = core.householdAccessRefusal(access.facts, workspaceId, operation, access.now);
  if (denied) return refused(denied);
  if (core.HOUSEHOLD_TOOL_REGISTRY.find(row => row.name === value.tool)!.objectTypes.includes('todo')) {
    const todoInvocation = core.householdToolInvocation(value.tool, args, { workspace_id: workspaceId });
    if ('query' in todoInvocation) {
      const query = todoInvocation.query;
      if (query.kind !== 'todo_list' && query.kind !== 'todo_read' && query.kind !== 'todo_queue' && query.kind !== 'comment_list') return refused('invalid_request');
      const read = await todos.read(tx, workspaceId, identity, query) as Record<string, unknown>;
      if (read.status === 'refused') return read;
      // Keep transport status distinct from the agent's measured work status.
      return query.kind === 'todo_queue' ? { status: 'ok', queue: read } : { status: 'ok', ...read };
    }
    const command = todoInvocation.command;
    if (command.kind !== 'todo_create' && command.kind !== 'todo_comment' && command.kind !== 'todo_update'
      && command.kind !== 'todo_assign' && command.kind !== 'todo_start' && command.kind !== 'todo_set_state') return refused('invalid_request');
    const result = await todos.write(tx, workspaceId, identity, requestId, command);
    return { ...result.outcome, notices: result.notices, request_id: requestId, replayed: result.replayed };
  }
  const reservationId = 'upload_' + await transfers.householdSha256(new TextEncoder().encode(JSON.stringify([workspaceId, identity.principal_id ?? identity.user_id, requestId])));
  const state = await store.state(tx, workspaceId, false);
  const previous = state.reservations[reservationId];
  const invocation = core.householdToolInvocation(value.tool, args, { workspace_id: workspaceId,
    upload: { reservation_id: reservationId, expires_at: previous?.expires_at ?? access.now + 15 * 60_000 } });
  if ('query' in invocation) {
    if ('limit' in invocation.query && invocation.query.limit !== undefined && invocation.query.limit > 100) return refused('page_limit_exceeded');
    if (invocation.query.kind === 'object_read') {
      const result = await store.readBytes(tx, workspaceId, identity, invocation.query);
      if (!('bytes' in result) || result.metadata.kind !== 'object_read') return result;
      const meta = result.metadata;
      if (!invocation.objectTypes.includes(meta.revision.kind)) return refused('object_type_mismatch');
      return { ...meta, revision: householdRevisionMetadata(meta.revision),
        ...(meta.revision.kind === 'file' ? {} : { content: transfers.decodeHouseholdContent(result.bytes, meta.revision.kind) }) };
    }
    if (invocation.query.kind !== 'object_list' && invocation.query.kind !== 'object_history' && invocation.query.kind !== 'draft_read') return refused('invalid_request');
    const result = await store.read(tx, workspaceId, identity, invocation.query);
    if (result.status === 'ok' && result.kind === 'object_history') return { ...result,
      revisions: result.revisions.map((revision) => ({ ...householdRevisionMetadata(revision), live: revision.live })) };
    return result;
  }
  const command = invocation.command;
  if (command.kind !== 'create_household_object' && command.kind !== 'update_household_object'
    && command.kind !== 'reserve_household_upload' && command.kind !== 'commit_household_upload') return refused('invalid_request');
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
