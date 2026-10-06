/** Lane H2: transaction-scoped persistence, not an HTTP dispatcher.
 * Lane 4 supplies the reviewed core from the generated bundle and its verified
 * credential recheck. Type-only source imports keep this lane out of that bundle.
 * The caller MUST use db.begin: throwing rolls events/projections/audit back.
 * Lock order is workspace, membership/content rights, stream, artifact rows.
 */
import type postgres from 'postgres';
import type {
  HouseholdAttribution, HouseholdBlob, HouseholdContent, HouseholdObjectState,
  HouseholdRevision, HouseholdRevisionRef,
} from '../_shared/household-object-events.d.ts';
import type { HouseholdAccessFacts, HouseholdContentOperation } from '../_shared/household-object-policy.d.ts';
import type { HouseholdObjectCommand, HouseholdVerifiedContent, HouseholdReadQuery } from '../_shared/household-objects.d.ts';
import type { HouseholdStorage } from './household-transfers.ts';

type Sql = postgres.TransactionSql<Record<string, unknown>>;
type Core = Pick<typeof import('../_shared/household-objects.d.ts'),
  'decideHouseholdObject' | 'reduceHouseholdObjectStream' | 'readHouseholdObjects' | 'emptyHouseholdObjectState' | 'householdObjectUsage'>
  & Pick<typeof import('../_shared/household-object-policy.d.ts'),
    'householdAccessRefusal' | 'HOUSEHOLD_LIVE_REVISION_LIMIT' | 'HOUSEHOLD_VERSION_BYTE_LIMIT'
    | 'HOUSEHOLD_IDENTITY_WRITE_HOURLY_LIMIT' | 'HOUSEHOLD_WORKSPACE_WRITE_HOURLY_LIMIT'>;
type Transfers = typeof import('./household-transfers.ts');

/** Already-authenticated identity, never copied from model parameters. The
 * recheck verifies the actual human session or agent credential/handle, including
 * expiry, token/device/run tombstones and parent OAuth grant on every operation.
 * SQL below independently checks the durable member/content ceiling.
 */
export interface HouseholdIdentity {
  user_id: string;
  principal_id: string | null;
  run_id: string | null;
  connection: { connection_id: string; grant_id: string } | null;
}
export type HouseholdCredentialRecheck = (tx: Sql, identity: HouseholdIdentity) => Promise<boolean>;
export interface HouseholdProposal {
  content: HouseholdContent;
  /** Only file attachments supply bytes. List/docs are canonically encoded. */
  file_bytes?: Uint8Array;
}

const own = <T>(map: Readonly<Record<string, T>>, key: string): T | undefined => Object.hasOwn(map, key) ? map[key] : undefined;
const json = (tx: Sql, value: unknown) => tx.json(value as postgres.JSONValue);
const stamp = (value: unknown): number | null => value === null || value === undefined ? null : new Date(value as string).getTime();
const actor = (identity: HouseholdIdentity) => ({ user_id: identity.user_id, principal_id: identity.principal_id, run_id: identity.run_id });
const operation = (command: HouseholdObjectCommand): 'create' | 'update' =>
  command.kind === 'commit_household_upload' || command.kind === 'release_household_upload' ? command.operation
    : command.kind === 'create_household_object' || (command.kind === 'reserve_household_upload' && command.change.kind === 'create') ? 'create' : 'update';
const baseOf = (command: HouseholdObjectCommand): HouseholdRevisionRef | null =>
  command.kind === 'update_household_object' ? command.base
    : command.kind === 'reserve_household_upload' && command.change.kind === 'update' ? command.change.base : null;

export function createHouseholdObjectStore(dependencies: {
  core: Core;
  transfers: Transfers;
  storage: HouseholdStorage;
  /** Reuse fileContentAllowed from file-artifacts.ts. */
  fileContentAllowed: (name: string, contentType: string) => boolean;
  recheckCredential: HouseholdCredentialRecheck;
  newFileIdentity?: (objectId: string) => { file_id: string; name: string };
}) {
  const { core, transfers, storage, recheckCredential } = dependencies;

  async function access(tx: Sql, workspaceId: string, identity: HouseholdIdentity): Promise<{ facts: HouseholdAccessFacts; now: number } | null> {
    if (!await recheckCredential(tx, identity)) return null;
    const [workspace] = await tx`SELECT archived_at FROM swarm.workspaces WHERE workspace_id=${workspaceId}::uuid FOR UPDATE`;
    if (!workspace) return null;
    const [boundary] = await tx`SELECT purpose, owner_user_id FROM swarm.household_workspace_boundaries WHERE workspace_id=${workspaceId}::uuid FOR SHARE`;
    const [member] = await tx`SELECT revoked_at FROM swarm.memberships WHERE workspace_id=${workspaceId}::uuid AND user_id=${identity.user_id}::uuid FOR SHARE`;
    const [rights] = await tx`SELECT * FROM swarm.household_member_content_roles WHERE workspace_id=${workspaceId}::uuid AND user_id=${identity.user_id}::uuid FOR SHARE`;
    if (!boundary) return null;
    let credential: HouseholdAccessFacts['credential'] = { kind: 'human' };
    if (identity.principal_id !== null) {
      if (!identity.connection) return null;
      const [principal] = await tx`SELECT revoked_at FROM swarm.agent_principals WHERE workspace_id=${workspaceId}::uuid AND principal_id=${identity.principal_id}::uuid AND owner_user_id=${identity.user_id}::uuid FOR SHARE`;
      if (!principal || principal.revoked_at !== null) return null;
      const [connection] = await tx`SELECT * FROM swarm.household_content_connections WHERE workspace_id=${workspaceId}::uuid
        AND connection_id=${identity.connection.connection_id}::uuid AND grant_id=${identity.connection.grant_id}::uuid
        AND principal_id=${identity.principal_id}::uuid AND owner_user_id=${identity.user_id}::uuid FOR SHARE`;
      if (!connection) return null;
      if (connection.hosted_grant_id !== null) {
        const [grant] = await tx`SELECT state, revoked_at FROM swarm.hosted_mcp_grants WHERE grant_id=${connection.hosted_grant_id}::uuid AND owner_user_id=${identity.user_id}::uuid FOR SHARE`;
        const [binding] = await tx`SELECT revoked_at FROM swarm.hosted_mcp_grant_workspaces WHERE grant_id=${connection.hosted_grant_id}::uuid AND workspace_id=${workspaceId}::uuid AND owner_user_id=${identity.user_id}::uuid FOR SHARE`;
        const [seat] = await tx`SELECT revoked_at FROM swarm.hosted_mcp_seats WHERE grant_id=${connection.hosted_grant_id}::uuid AND workspace_id=${workspaceId}::uuid AND principal_id=${identity.principal_id}::uuid FOR SHARE`;
        if (!grant || grant.state !== 'active' || grant.revoked_at !== null || !binding || binding.revoked_at !== null || !seat || seat.revoked_at !== null) return null;
      }
      credential = { kind: 'agent', connection: {
        connection_id: String(connection.connection_id), grant_id: String(connection.grant_id), workspace_id: workspaceId,
        principal_id: identity.principal_id, owner_user_id: identity.user_id,
        operations: connection.operations as HouseholdContentOperation[], purpose: connection.purpose as 'personal' | 'shared',
        revoked_at: stamp(connection.revoked_at), expires_at: stamp(connection.expires_at),
      } };
    } else if (identity.connection !== null || identity.run_id !== null) return null;
    const [clock] = await tx`SELECT clock_timestamp() AS now`;
    return { now: stamp(clock!.now)!, facts: {
      workspace_id: workspaceId, archived_at: stamp(workspace.archived_at), actor: actor(identity), credential,
      boundary: boundary.purpose === 'personal' ? { kind: 'personal', owner_user_id: String(boundary.owner_user_id) } : { kind: 'shared' },
      member: member ? { user_id: identity.user_id, workspace_id: workspaceId,
        revoked_at: stamp(member.revoked_at) ?? stamp(rights?.revoked_at),
        content_role: rights?.content_role as 'reader' | 'editor' | null ?? null,
        content_consent_id: rights?.content_consent_id as string | null ?? null } : null,
    } };
  }

  async function state(tx: Sql, workspaceId: string, create: boolean): Promise<HouseholdObjectState> {
    let [row] = await tx`SELECT projection FROM swarm.household_object_streams WHERE workspace_id=${workspaceId}::uuid FOR UPDATE`;
    if (!row) {
      const empty = core.emptyHouseholdObjectState(workspaceId, crypto.randomUUID());
      if (!create) return empty;
      [row] = await tx`INSERT INTO swarm.household_object_streams(workspace_id,stream_id,last_seq,projection)
        VALUES (${workspaceId}::uuid,${empty.stream_id}::uuid,-1,${json(tx, empty)}) RETURNING projection`;
    }
    return row!.projection as HouseholdObjectState;
  }

  async function content(tx: Sql, workspaceId: string, revision: HouseholdRevision): Promise<HouseholdVerifiedContent> {
    const [registered] = await tx`SELECT storage_path FROM swarm.household_object_artifacts WHERE workspace_id=${workspaceId}::uuid
      AND object_id=${revision.revision.object_id} AND revision_token=${revision.revision.token} AND state='committed'`;
    if (!registered || registered.storage_path !== revision.blob.storage_key) throw new transfers.HouseholdTransferError('bytes_mismatch');
    const bytes = await transfers.verifiedHouseholdBytes(storage, revision.blob);
    return { workspace_id: workspaceId, object_id: revision.revision.object_id, revision: revision.revision,
      blob: revision.blob, content: revision.kind === 'file' ? revision.file_metadata! : transfers.decodeHouseholdContent(bytes, revision.kind) };
  }

  async function audit(tx: Sql, workspaceId: string, identity: HouseholdIdentity, commandId: string, kind: string,
    digest: string, outcome: string, reason: string | null = null) {
    await tx`INSERT INTO swarm.household_object_audit(audit_id,workspace_id,command_id,actor_user,actor_principal,occurred_at,command_kind,request_digest,outcome,reason_code)
      SELECT ${crypto.randomUUID()}::uuid,${workspaceId}::uuid,${commandId},${identity.user_id}::uuid,${identity.principal_id}::uuid,
        clock_timestamp(),${kind},${digest},${outcome},${reason} FROM swarm.workspaces WHERE workspace_id=${workspaceId}::uuid`;
  }

  async function rate(tx: Sql, key: string, limit: number): Promise<number> {
    const [row] = await tx`INSERT INTO swarm.rate_buckets(bucket_key,window_start,count)
      VALUES (${key},date_trunc('hour',statement_timestamp()),1)
      ON CONFLICT(bucket_key,window_start) DO UPDATE SET count=LEAST(swarm.rate_buckets.count+1,${limit + 1}) RETURNING count`;
    return Number(row!.count) - 1;
  }

  async function write(tx: Sql, workspaceId: string, identity: HouseholdIdentity, requestId: string,
    command: HouseholdObjectCommand, proposal: HouseholdProposal | null) {
    const initialAccess = await access(tx, workspaceId, identity);
    const denied = initialAccess ? core.householdAccessRefusal(initialAccess.facts, workspaceId, operation(command), initialAccess.now) : 'workspace_access_refused';
    if (denied) {
      const digest = await transfers.householdSha256(new TextEncoder().encode(transfers.householdCanonical(command)));
      await audit(tx, workspaceId, identity, requestId, command.kind, digest, 'refused', denied);
      return { outcome: { status: 'refused' as const, reason: denied }, events: [], replayed: false };
    }
    const bytes = !proposal ? null : proposal.content.kind === 'file'
      ? (proposal.file_bytes ? new Uint8Array(proposal.file_bytes) : null) : transfers.householdContentBytes(proposal.content);
    if (proposal && (!bytes || bytes.byteLength > core.HOUSEHOLD_VERSION_BYTE_LIMIT)) throw new transfers.HouseholdTransferError('transfer_too_large');
    if (proposal?.content.kind === 'file' && !dependencies.fileContentAllowed(proposal.content.name, proposal.content.media_type.toLowerCase())) {
      throw new transfers.HouseholdTransferError('content_invalid');
    }
    const proposalDigest = bytes ? await transfers.householdSha256(bytes) : null;
    const digest = await transfers.householdSha256(new TextEncoder().encode(transfers.householdCanonical({ command: command.kind === 'reserve_household_upload' ? { ...command, expires_at: 0 } : command,
      proposal: proposal ? { content: proposal.content, sha256: proposalDigest } : null })));
    const current = await state(tx, workspaceId, true);
    const previous = current.receipts[JSON.stringify([identity.principal_id ?? identity.user_id, requestId])];
    if (previous) {
      const replayed = previous.request_digest === digest;
      const outcome = replayed ? previous.outcome : { status: 'refused' as const, reason: 'request_id_reused' };
      await audit(tx, workspaceId, identity, requestId, command.kind, digest, replayed ? 'replay' : 'refused', replayed ? null : 'request_id_reused');
      return { outcome, events: [], replayed };
    }
    let identityAttempts = 0, workspaceAttempts = 0;
    if (command.kind !== 'commit_household_upload' && command.kind !== 'release_household_upload') {
      identityAttempts = await rate(tx, `file:create:${identity.principal_id ? 'agent' : 'user'}:${(identity.principal_id ?? identity.user_id).toLowerCase()}`, core.HOUSEHOLD_IDENTITY_WRITE_HOURLY_LIMIT);
      workspaceAttempts = await rate(tx, `file:create:ws:${workspaceId.toLowerCase()}`, core.HOUSEHOLD_WORKSPACE_WRITE_HOURLY_LIMIT);
    }
    const contents: HouseholdVerifiedContent[] = [];
    const base = baseOf(command);
    if (base?.workspace_id === workspaceId) {
      const revision = own(current.objects, base.object_id)?.history.find((r) => r.revision.token === base.token);
      if (revision) contents.push(await content(tx, workspaceId, revision));
    }
    let prepared: HouseholdVerifiedContent | null = null;
    let slot: { fileId: string; versionId: string; versionN: number; path: string; newFile: boolean; name?: string } | null = null;
    if (command.kind === 'commit_household_upload') {
      const reservation = own(current.reservations, command.reservation_id);
      // No byte access until the same owner/connection and operation are checked.
      const owner: HouseholdAttribution = { ...actor(identity), connection_id: identity.connection?.connection_id ?? null, grant_id: identity.connection?.grant_id ?? null };
      if (reservation && reservation.owner.user_id === owner.user_id && reservation.owner.principal_id === owner.principal_id
        && reservation.owner.connection_id === owner.connection_id && reservation.owner.grant_id === owner.grant_id
        && command.operation === (reservation.base ? 'update' : 'create') && reservation.expires_at > initialAccess!.now) {
        const [registered] = await tx`SELECT storage_path FROM swarm.household_object_artifacts WHERE workspace_id=${workspaceId}::uuid
          AND object_id=${reservation.object_id} AND reservation_id=${reservation.reservation_id} AND state='reserved'`;
        if (!registered || registered.storage_path !== reservation.proposed.storage_key) throw new transfers.HouseholdTransferError('bytes_mismatch');
        const reservedBytes = await transfers.verifiedHouseholdBytes(storage, reservation.proposed);
        prepared = { workspace_id: workspaceId, object_id: reservation.object_id, revision: reservation.base, blob: reservation.proposed,
          content: reservation.kind === 'file' ? reservation.file_metadata! : transfers.decodeHouseholdContent(reservedBytes, reservation.kind) };
      }
    } else if (command.kind !== 'release_household_upload' && proposal && bytes) {
      if (command.object_id.length > 255) throw new transfers.HouseholdTransferError('content_invalid');
      const [binding] = await tx`SELECT file_id FROM swarm.household_object_bindings WHERE workspace_id=${workspaceId}::uuid AND object_id=${command.object_id}`;
      const legacyFile = !binding ? dependencies.newFileIdentity?.(command.object_id) : undefined;
      const fileId = binding ? String(binding.file_id) : legacyFile?.file_id ?? crypto.randomUUID();
      const [max] = await tx`SELECT coalesce(max(version_n),0) AS n FROM swarm.file_versions WHERE workspace_id=${workspaceId}::uuid AND file_id=${fileId}::uuid`;
      const versionId = crypto.randomUUID();
      // Preserve the workspace/file/version hierarchy, using an immutable
      // version ID for new keys. A DB rollback after PUT must never cause the
      // next attempt to reuse an orphan's key and get stuck behind upsert-off.
      slot = { fileId, versionId, versionN: Number(max!.n) + 1, path: `${workspaceId}/${fileId}/${versionId}`, newFile: !binding, name: legacyFile?.name };
      prepared = { workspace_id: workspaceId, object_id: command.object_id, revision: base,
        blob: { storage_key: slot.path, size_bytes: bytes.byteLength, sha256: proposalDigest! }, content: proposal.content };
    }
    const [legacy] = await tx`SELECT
      (SELECT coalesce(sum(v.size_bytes),0)::text FROM swarm.file_versions v JOIN swarm.files f USING(file_id,workspace_id)
        WHERE v.workspace_id=${workspaceId}::uuid AND NOT f.household_managed AND v.state IN ('pending','live','retired')) AS bytes,
      (SELECT count(*)::text FROM swarm.files WHERE workspace_id=${workspaceId}::uuid AND purged_at IS NULL) AS names`;
    const usage = core.householdObjectUsage(current);
    const ctx = { access: initialAccess!.facts, now: initialAccess!.now, command_id: requestId, request_digest: digest,
      seq: current.last_seq + 1, event_id: crypto.randomUUID(), revision_token: crypto.randomUUID().replaceAll('-', ''), draft_id: crypto.randomUUID(),
      other_storage_bytes: Number(legacy!.bytes), other_object_count: Math.max(0, Number(legacy!.names) - usage.object_count),
      identity_write_attempts: identityAttempts, workspace_write_attempts: workspaceAttempts, contents, prepared };
    let decision = core.decideHouseholdObject(command, current, ctx);
    let staged = false;
    if (decision.outcome.status !== 'refused' && slot && prepared && bytes) {
      // Stage rows under the same quota lock. Failed I/O throws: no success event
      // or projection survives. A rolled-back object is collected by orphan GC.
      if (slot.newFile) {
        await tx`INSERT INTO swarm.files(file_id,workspace_id,name,created_by_kind,created_by,household_managed)
          VALUES (${slot.fileId}::uuid,${workspaceId}::uuid,${slot.name ?? `household--${slot.fileId}.json`},${identity.principal_id ? 'agent' : 'user'},${identity.principal_id ?? identity.user_id}::uuid,true)`;
        await tx`INSERT INTO swarm.household_object_bindings(workspace_id,object_id,file_id) VALUES (${workspaceId}::uuid,${prepared.object_id},${slot.fileId}::uuid)`;
      }
      await tx`INSERT INTO swarm.file_versions(version_id,file_id,workspace_id,version_n,state,size_bytes,sha256,content_type,storage_path,uploaded_by_kind,uploaded_by)
        VALUES (${slot.versionId}::uuid,${slot.fileId}::uuid,${workspaceId}::uuid,${slot.versionN},'pending',${prepared.blob.size_bytes},${prepared.blob.sha256},
          ${prepared.content.kind === 'file' ? prepared.content.media_type : 'application/json'},${slot.path},${identity.principal_id ? 'agent' : 'user'},${identity.principal_id ?? identity.user_id}::uuid)`;
      staged = true;
      await storage.putImmutable(slot.path, bytes);
      await transfers.verifiedHouseholdBytes(storage, prepared.blob);
    }
    // Recheck time/credential after all storage awaits, including base reads.
    const latest = await access(tx, workspaceId, identity);
    const finalDenied = latest ? core.householdAccessRefusal(latest.facts, workspaceId, operation(command), latest.now) : 'workspace_access_refused';
    if (finalDenied) throw new transfers.HouseholdTransferError('access_refused');
    ctx.access = latest!.facts; ctx.now = latest!.now;
    decision = core.decideHouseholdObject(command, current, ctx);
    const next = core.reduceHouseholdObjectStream(decision.events, current);
    if (staged && decision.outcome.status === 'refused') throw new transfers.HouseholdTransferError('storage_unavailable');
    if (decision.outcome.status !== 'refused') {
      const outcome = decision.outcome;
      const path = prepared?.blob.storage_key ?? own(current.reservations, command.kind === 'release_household_upload' ? command.reservation_id : '')?.proposed.storage_key;
      if (slot && prepared) {
        await tx`INSERT INTO swarm.household_object_artifacts(workspace_id,object_id,version_id,file_id,storage_path,size_bytes,sha256,state,revision_token,reservation_id,draft_id)
          VALUES (${workspaceId}::uuid,${prepared.object_id},${slot.versionId}::uuid,${slot.fileId}::uuid,${slot.path},${prepared.blob.size_bytes},${prepared.blob.sha256},
            ${outcome.status === 'committed' ? 'committed' : outcome.status === 'pending' ? 'reserved' : 'draft'},
            ${outcome.status === 'committed' ? outcome.revision.token : null},${outcome.status === 'pending' ? outcome.reservation_id : null},${outcome.status === 'conflict' ? outcome.draft_id : null})`;
      } else if (path) {
        await tx`UPDATE swarm.household_object_artifacts SET state=${outcome.status === 'committed' ? 'committed' : outcome.status === 'conflict' ? 'draft' : 'released'},
          revision_token=${outcome.status === 'committed' ? outcome.revision.token : null},draft_id=${outcome.status === 'conflict' ? outcome.draft_id : null}
          WHERE workspace_id=${workspaceId}::uuid AND storage_path=${path} AND state='reserved'`;
      }
      if (path && outcome.status !== 'pending') {
        await tx`UPDATE swarm.file_versions SET state=${outcome.status === 'committed' ? 'live' : outcome.status === 'conflict' ? 'retired' : 'purged'},
          committed_at=${outcome.status === 'committed' ? new Date(ctx.now) : null},retired_at=${outcome.status === 'conflict' ? new Date(ctx.now) : null}
          WHERE workspace_id=${workspaceId}::uuid AND storage_path=${path} AND state='pending'`;
        if (outcome.status === 'released') {
          await tx`INSERT INTO swarm.file_purge_queue(storage_path) VALUES (${path}) ON CONFLICT(storage_path) DO NOTHING`;
        } else if (outcome.status === 'committed') {
          const object = next.objects[outcome.object_id]!;
          const retiredPaths = object.history.slice(0, Math.max(0, object.history.length - core.HOUSEHOLD_LIVE_REVISION_LIMIT)).map((r) => r.blob.storage_key);
          if (retiredPaths.length) await tx`UPDATE swarm.file_versions SET state='retired',retired_at=${new Date(ctx.now)}
            WHERE workspace_id=${workspaceId}::uuid AND storage_path IN ${tx(retiredPaths)} AND state='live'`;
          await tx`UPDATE swarm.files f SET current_version=v.version_n FROM swarm.file_versions v
            WHERE f.file_id=v.file_id AND f.workspace_id=v.workspace_id AND f.workspace_id=${workspaceId}::uuid AND v.storage_path=${path}`;
        }
      }
    }
    for (const event of decision.events) await tx`INSERT INTO swarm.household_object_events(workspace_id,seq,event_id,event)
      VALUES (${workspaceId}::uuid,${event.seq},${event.event_id}::uuid,${json(tx,event)})`;
    if (decision.events.length) await tx`UPDATE swarm.household_object_streams SET last_seq=${next.last_seq},projection=${json(tx,next)} WHERE workspace_id=${workspaceId}::uuid`;
    await audit(tx, workspaceId, identity, requestId, command.kind, digest, decision.outcome.status,
      decision.outcome.status === 'refused' ? decision.outcome.reason : null);
    return decision;
  }

  async function read(tx: Sql, workspaceId: string, identity: HouseholdIdentity, query: HouseholdReadQuery) {
    const authorized = await access(tx, workspaceId, identity);
    const denied = authorized ? core.householdAccessRefusal(authorized.facts, workspaceId, 'read', authorized.now) : 'workspace_access_refused';
    if (denied) return { status: 'refused' as const, reason: denied };
    const current = await state(tx, workspaceId, false);
    const latest = await access(tx, workspaceId, identity);
    const finalDenied = latest ? core.householdAccessRefusal(latest.facts, workspaceId, 'read', latest.now) : 'workspace_access_refused';
    if (finalDenied) return { status: 'refused' as const, reason: finalDenied };
    return core.readHouseholdObjects(query, current, latest!.facts, latest!.now);
  }

  async function readBytes(tx: Sql, workspaceId: string, identity: HouseholdIdentity, query: Extract<HouseholdReadQuery, { kind: 'object_read' | 'draft_read' }>) {
    const result = await read(tx, workspaceId, identity, query);
    if (result.status !== 'ok' || (result.kind !== 'object_read' && result.kind !== 'draft_read')) return result;
    const blob: HouseholdBlob = result.kind === 'object_read' ? result.revision.blob : result.draft.proposed;
    const bytes = await transfers.verifiedHouseholdBytes(storage, blob);
    const latest = await access(tx, workspaceId, identity);
    const denied = latest ? core.householdAccessRefusal(latest.facts, workspaceId, 'read', latest.now) : 'workspace_access_refused';
    if (denied) return { status: 'refused' as const, reason: denied };
    // Buffer crosses the host boundary only after the final permission check;
    // hosts carry it as a protected attachment, not a signed URL/model string.
    return { status: 'ok' as const, metadata: result, bytes };
  }
  return { write, read, readBytes, access, state };
}
