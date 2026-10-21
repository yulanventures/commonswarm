/** Shared recovery assembly: read only, original identity binding enforced by store. */
import type postgres from 'postgres';
import type { HouseholdRevision } from '../_shared/household-object-events.d.ts';
import type { HouseholdIdentity, createHouseholdObjectStore } from './household-objects.ts';
import * as transfers from './household-transfers.ts';
type Sql = postgres.TransactionSql<Record<string, unknown>>;
export const householdRevisionMetadata = (revision: HouseholdRevision) => ({
  revision: revision.revision, parent: revision.parent, title: revision.title,
  kind: revision.kind, file_metadata: revision.file_metadata,
  blob: { size_bytes: revision.blob.size_bytes, sha256: revision.blob.sha256 },
  author: revision.author, occurred_at_server: revision.occurred_at_server, command_id: revision.command_id,
});
export async function readHouseholdDraft(tx: Sql, workspaceId: string, identity: HouseholdIdentity,
  draftId: unknown, store: ReturnType<typeof createHouseholdObjectStore>, allowedKinds: readonly string[] = ['list', 'doc', 'file'], toolTransport = true) {
  const refused = (reason: string) => ({ status: 'refused', reason });
  if (typeof draftId !== 'string' || (!draftId.length || draftId.length > 255)) return refused('invalid_request');
  const result = await store.readBytes(tx, workspaceId, identity, { kind: 'draft_read', draft_id: draftId }, allowedKinds);
  if (!('bytes' in result) || result.metadata.kind !== 'draft_read') return result;
  const draft = result.metadata.draft;
  const current = await store.readBytes(tx, workspaceId, identity, { kind: 'object_read', object_id: draft.object_id, revision: draft.current }, allowedKinds);
  const base = await store.readBytes(tx, workspaceId, identity, { kind: 'object_read', object_id: draft.object_id, revision: draft.base }, allowedKinds);
  if (!('bytes' in current) || !('bytes' in base) || current.metadata.kind !== 'object_read' || base.metadata.kind !== 'object_read') return refused('revision_not_found');
  if (draft.kind === 'file') return refused('protected_attachment_required');
  const output = { status: 'ok', kind: 'draft_read', workspace_id: workspaceId, object_id: draft.object_id, draft_id: draft.draft_id,
    owner_user_id: draft.owner.user_id, proposed: transfers.decodeHouseholdContent(result.bytes, draft.kind),
    base: { ...householdRevisionMetadata(base.metadata.revision), live: base.metadata.live,
      content: transfers.decodeHouseholdContent(base.bytes, draft.kind) },
    current: { ...householdRevisionMetadata(current.metadata.revision), live: current.metadata.live,
      content: transfers.decodeHouseholdContent(current.bytes, draft.kind) } };
  return toolTransport && new TextEncoder().encode(JSON.stringify(JSON.stringify(output))).length > 28 * 1024
    ? { status: 'refused', reason: 'draft_response_too_large' } : output;
}
