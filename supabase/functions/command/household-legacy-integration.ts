/** Legacy names/versions are aliases for the same reducer objects. */
import type postgres from 'postgres';
import { createLegacyHouseholdAdapter, type LegacyHouseholdRequest, type LegacyHouseholdOperations } from './household-legacy-adapter.ts';
import { householdStore } from './household-integration.ts';
import type { HouseholdIdentity, HouseholdCredentialRecheck } from './household-objects.ts';
import * as core from '../_shared/protocol.js';
import * as transfers from './household-transfers.ts';
const { brainFileName, brainTopicFromFileName } = core;
type Sql = postgres.TransactionSql<Record<string, unknown>>;

export async function executeHouseholdLegacy(tx: Sql, request: LegacyHouseholdRequest, identity: HouseholdIdentity,
  recheck: HouseholdCredentialRecheck, attachment?: Uint8Array) {
  const cmd = request.command;
  const store = householdStore(recheck, cmd.kind === "file_version_create" ? () => ({ file_id: cmd.file_id, name: cmd.name })
    : cmd.kind === "brain_put" ? () => ({ file_id: crypto.randomUUID(), name: brainFileName(cmd.topic) }) : undefined);
  const principalKind = identity.principal_id ? 'agent' : 'user';
  const principalId = identity.principal_id ?? identity.user_id;
  const ledgerKey = (id: string) => `household-legacy/${id}`; // '/' cannot be a public command ID.
  const ops: LegacyHouseholdOperations<Sql> = {
    brain: { brainFileName, brainTopicFromFileName }, transfers, uploadLifetimeMs: 15 * 60_000,
    transaction: async work => await tx.savepoint(async nested => await work(nested)) as Awaited<ReturnType<typeof work>>,
    authenticate: async (sql, workspace, actor) => {
      const result = await store.access(sql, workspace, actor);
      return result ? { access: result.facts, now: result.now } : null;
    }, accessRefusal: core.householdAccessRefusal,
    receipt: async (sql, workspace, _actor, id) => {
      const [row] = await sql`SELECT request_hash,response FROM swarm.idempotency_keys
        WHERE principal_kind=${principalKind} AND principal_id=${principalId} AND command_id=${ledgerKey(id)} AND workspace_id=${workspace}::uuid`;
      return row ? { digest: String(row.request_hash), ...(row.response as { operation: 'create' | 'update'; result: never }) } : null;
    },
    record: async (sql, workspace, _actor, id, digest, operation, result) => {
      const [stream] = await sql`SELECT stream_id FROM swarm.streams WHERE workspace_id=${workspace}::uuid AND kind='workspace'`;
      await sql`INSERT INTO swarm.idempotency_keys(principal_kind,principal_id,command_id,workspace_id,stream_id,request_hash,response)
        VALUES (${principalKind},${principalId},${ledgerKey(id)},${workspace}::uuid,${String(stream!.stream_id)}::uuid,${digest},${sql.json({operation,result} as unknown as postgres.JSONValue)})`;
    },
    audit: async (sql, workspace, actor, id, digest, status) => {
      await sql`INSERT INTO swarm.household_object_audit(audit_id,workspace_id,command_id,actor_user,actor_principal,occurred_at,command_kind,request_digest,outcome)
        VALUES (${crypto.randomUUID()}::uuid,${workspace}::uuid,${id},${actor.user_id}::uuid,${actor.principal_id}::uuid,clock_timestamp(),'household_legacy',${digest},${status})`;
    },
    resolve: async (sql, workspace, actor, selector) => {
      const rows = 'file_id' in selector
        ? await sql`SELECT f.file_id,f.name,b.object_id FROM swarm.files f JOIN swarm.household_object_bindings b USING(file_id,workspace_id) WHERE f.workspace_id=${workspace}::uuid AND f.file_id=${selector.file_id}::uuid`
        : await sql`SELECT f.file_id,f.name,b.object_id FROM swarm.files f JOIN swarm.household_object_bindings b USING(file_id,workspace_id) WHERE f.workspace_id=${workspace}::uuid AND f.name=${selector.name}`;
      const row = rows[0];
      if (!row) return null;
      const state = await store.state(sql, workspace, false);
      const object = state.objects[String(row.object_id)];
      const versions = [];
      for (const revision of object?.history ?? []) {
        const result = await store.readBytes(sql, workspace, actor, { kind: 'object_read', object_id: String(row.object_id), revision: revision.revision });
        if (!('bytes' in result) || result.metadata.kind !== 'object_read') return null;
        const [version] = await sql`SELECT v.version_n FROM swarm.file_versions v JOIN swarm.household_object_artifacts a USING(version_id,file_id,workspace_id)
          WHERE a.workspace_id=${workspace}::uuid AND a.object_id=${String(row.object_id)} AND a.revision_token=${revision.revision.token}`;
        versions.push({ version_n: Number(version!.version_n), metadata: revision,
          content: revision.kind === 'file' ? revision.file_metadata! : transfers.decodeHouseholdContent(result.bytes, revision.kind) });
      }
      const pending = [];
      for (const reservation of Object.values(state.reservations).filter(r => r.object_id === String(row.object_id))) {
        const [alias] = await sql`SELECT response FROM swarm.idempotency_keys WHERE principal_kind=${principalKind} AND principal_id=${principalId}
          AND workspace_id=${workspace}::uuid AND command_id=${`household-upload/${reservation.reservation_id}`}`;
        if (alias) pending.push({ version_id: reservation.reservation_id, operation: reservation.base ? 'update' as const : 'create' as const,
          source_sha256: String((alias.response as Record<string, unknown>).source_sha256) });
      }
      return { workspace_id: workspace, file_id: String(row.file_id), object_id: String(row.object_id), name: String(row.name), versions, pending };
    },
    registerUpload: async (sql, workspace, _actor, fileId, versionId, objectId, sourceDigest) => {
      const [binding] = await sql`SELECT file_id FROM swarm.household_object_bindings WHERE workspace_id=${workspace}::uuid AND object_id=${objectId}`;
      if (!binding) throw new Error('legacy binding missing');
      // A file's requested legacy ID must be the stable actual file ID. New
      // brain aliases are keyed by name; ordinary files cannot impersonate IDs.
      if (String(binding.file_id) !== fileId) throw new Error('legacy file alias required');
      const [stream] = await sql`SELECT stream_id FROM swarm.streams WHERE workspace_id=${workspace}::uuid AND kind='workspace'`;
      await sql`INSERT INTO swarm.idempotency_keys(principal_kind,principal_id,command_id,workspace_id,stream_id,request_hash,response)
        VALUES (${principalKind},${principalId},${`household-upload/${versionId}`},${workspace}::uuid,${String(stream!.stream_id)}::uuid,${sourceDigest},${sql.json({source_sha256:sourceDigest})})`;
    },
    write: store.write, read: store.read,
    readBytes: async (sql, workspace, actor, query) => {
      const result = await store.readBytes(sql, workspace, actor, query);
      if ('bytes' in result && result.metadata.kind === 'object_read') return { status: 'ok', metadata: result.metadata, bytes: result.bytes };
      return { status: 'refused', reason: 'revision_not_found' };
    },
  };
  const result = await createLegacyHouseholdAdapter(ops)(request, identity, attachment);
  if (result.status === 'ok' && result.kind === 'read') return { ...result, attachment: undefined,
    ...(result.content.kind === 'file' ? { status: 'refused', reason: 'protected_attachment_required' } : {}) };
  return result;
}
