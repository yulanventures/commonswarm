/** Unwired lane 4B preparation. The host supplies authenticated, locked facts
 * and a transaction that resolves ONLY after COMMIT. No HTTP/auth changes here.
 * Legacy upload creation requires a protected staged attachment: declarations
 * alone cannot reserve verified household content. Integration must supply it.
 */
import type { HouseholdAccessFacts, HouseholdContentOperation } from '../_shared/household-object-policy.d.ts';
import type { HouseholdContent, HouseholdOutcome, HouseholdRevision, HouseholdRevisionRef } from '../_shared/household-object-events.d.ts';
import type { HouseholdObjectCommand, HouseholdObjectDecision, HouseholdReadQuery, HouseholdReadResult } from '../_shared/household-objects.d.ts';
import type { HouseholdIdentity, HouseholdProposal } from './household-objects.ts';
import type { FileCommand } from './file-artifacts.ts';

export type LegacyHouseholdCommand = FileCommand
  | { kind: 'brain_put'; topic: string; markdown: string; if_version: number | null }
  | { kind: 'brain_get'; topic: string; version_n: number | null }
  | { kind: 'brain_history'; topic: string; offset: number; limit: number };
export interface LegacyHouseholdRequest {
  workspace_id: string;
  request_id: string;
  command: LegacyHouseholdCommand;
  /** A modern caller may carry the opaque base obtained from an authorized read. */
  base_revision?: HouseholdRevisionRef;
}
export interface LegacyHouseholdBinding {
  workspace_id: string;
  file_id: string;
  object_id: string;
  name: string;
  /** Exact immutable content loaded and verified under current authorization. */
  versions: readonly { version_n: number; metadata: HouseholdRevision; content: HouseholdContent }[];
  pending: readonly { version_id: string; operation: 'create' | 'update'; source_sha256: string }[];
}
export type LegacyHouseholdResult =
  | (HouseholdOutcome & { request_id: string; replayed: boolean })
  | { status: 'unknown'; request_id: string; reason: 'transaction_outcome_unknown' }
  | { status: 'ok'; request_id: string; kind: 'read'; revision: HouseholdRevisionRef;
      author: HouseholdRevision['author']; occurred_at_server: number; content: HouseholdContent;
      /** Host must carry these bytes as a protected attachment, outside model text. */
      attachment: Uint8Array }
  | { status: 'ok'; request_id: string; kind: 'history'; revisions: readonly {
      revision: HouseholdRevisionRef; author: HouseholdRevision['author']; occurred_at_server: number;
      command_id: string; live: boolean }[]; next_offset: number | null };
type RecordedResult = Exclude<LegacyHouseholdResult, { status: 'unknown' | 'ok' }>;

export interface LegacyHouseholdOperations<Tx> {
  /** Reuse the existing canonical namespace and transfer helpers. Injecting
   * them keeps this module independent of generated edge bundle wiring. */
  brain: { brainFileName(value: string): string; brainTopicFromFileName(value: string): string | null };
  transfers: Pick<typeof import('./household-transfers.ts'), 'householdCanonical' | 'householdSha256'>;
  /** Serialize workspace/identity/request ledger, bindings and core writes.
   * Events, projection, legacy ledger and audit commit or roll back together.
   * No result may resolve before the database commit has been acknowledged. */
  transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T>;
  authenticate(tx: Tx, workspaceId: string, identity: HouseholdIdentity): Promise<{ access: HouseholdAccessFacts; now: number } | null>;
  accessRefusal(access: HouseholdAccessFacts, workspaceId: string, operation: HouseholdContentOperation, now: number): string | null;
  /** Locked durable ledger, scoped by workspace + authenticated principal + ID. */
  receipt(tx: Tx, workspaceId: string, identity: HouseholdIdentity, requestId: string): Promise<{ digest: string; operation: HouseholdContentOperation; result: RecordedResult } | null>;
  record(tx: Tx, workspaceId: string, identity: HouseholdIdentity, requestId: string, digest: string, operation: HouseholdContentOperation, result: RecordedResult): Promise<void>;
  /** Audit every refusal/replay/read too; never store raw content or credentials. */
  audit(tx: Tx, workspaceId: string, identity: HouseholdIdentity, requestId: string, digest: string, status: string): Promise<void>;
  resolve(tx: Tx, workspaceId: string, identity: HouseholdIdentity, selector: { file_id: string } | { name: string }): Promise<LegacyHouseholdBinding | null>;
  /** Persist legacy file/version aliases and the raw attachment digest alongside
   * the reservation. Brain blobs use canonical doc encoding, so their storage
   * digest differs from the legacy client's raw Markdown digest. */
  registerUpload(tx: Tx, workspaceId: string, identity: HouseholdIdentity, fileId: string, versionId: string, objectId: string, sourceSha256: string): Promise<void>;
  /** Wire to createHouseholdObjectStore(...).write/read during integration. */
  write(tx: Tx, workspaceId: string, identity: HouseholdIdentity, requestId: string, command: HouseholdObjectCommand, proposal: HouseholdProposal | null): Promise<HouseholdObjectDecision>;
  read(tx: Tx, workspaceId: string, identity: HouseholdIdentity, query: HouseholdReadQuery): Promise<HouseholdReadResult>;
  readBytes(tx: Tx, workspaceId: string, identity: HouseholdIdentity, query: Extract<HouseholdReadQuery, { kind: 'object_read' }>): Promise<
    { status: 'refused'; reason: string } | { status: 'ok'; metadata: Extract<HouseholdReadResult, { kind: 'object_read' }>; bytes: Uint8Array }>;
  uploadLifetimeMs: number;
}

const sameRef = (a: HouseholdRevisionRef, b: HouseholdRevisionRef) =>
  a.workspace_id === b.workspace_id && a.object_id === b.object_id && a.token === b.token;

export function createLegacyHouseholdAdapter<Tx>(ops: LegacyHouseholdOperations<Tx>) {
  if (!Number.isSafeInteger(ops.uploadLifetimeMs) || ops.uploadLifetimeMs <= 0) throw new TypeError('invalid upload lifetime');
  return async (request: LegacyHouseholdRequest, identity: HouseholdIdentity,
    /** Supplied by trusted host attachment handling, never a path/URL in a command. */
    stagedAttachment?: Uint8Array): Promise<LegacyHouseholdResult> => {
    // Snapshot before any await: a caller cannot change a request while hashing.
    const input = structuredClone(request), actor = structuredClone(identity);
    const attachment = stagedAttachment === undefined ? undefined : new Uint8Array(stagedAttachment);
    const refused = (reason: string): RecordedResult => ({ status: 'refused', reason, request_id: input.request_id, replayed: false });
    if (!input.request_id || !input.workspace_id) return refused('invalid_request');
    try {
      const digest = await ops.transfers.householdSha256(new TextEncoder().encode(ops.transfers.householdCanonical({
        request: input, attachment_sha256: attachment === undefined ? null : await ops.transfers.householdSha256(attachment),
      })));
      return await ops.transaction(async (tx) => {
        const facts = await ops.authenticate(tx, input.workspace_id, actor);
        const cmd = input.command;
        const reading = cmd.kind === 'file_download_url' || cmd.kind === 'brain_get' || cmd.kind === 'brain_history';
        let requiredOperation: HouseholdContentOperation = reading ? 'read'
          : input.base_revision || ('if_version' in cmd && cmd.if_version !== null && cmd.if_version > 0) ? 'update' : 'create';
        const authorize = (operation: HouseholdContentOperation, verified = facts): string | null => {
          const facts = verified;
          // The supplied facts must belong to the independently authenticated identity.
          if (!facts || facts.access.actor.user_id !== actor.user_id
            || facts.access.actor.principal_id !== actor.principal_id || facts.access.actor.run_id !== actor.run_id
            || (facts.access.credential.kind === 'agent'
              ? facts.access.credential.connection.connection_id !== actor.connection?.connection_id
                || facts.access.credential.connection.grant_id !== actor.connection?.grant_id
              : actor.connection !== null)) return 'workspace_access_refused';
          return ops.accessRefusal(facts.access, input.workspace_id, operation, facts.now);
        };
        const finish = async (result: LegacyHouseholdResult, recordResult = true): Promise<LegacyHouseholdResult> => {
          // Storage I/O may have awaited: revoke/expiry must still win before return.
          const latest = await ops.authenticate(tx, input.workspace_id, actor);
          const denied = authorize(requiredOperation, latest);
          if (denied) throw new Error('authorization changed'); // forces rollback, unknown is truthful
          await ops.audit(tx, input.workspace_id, actor, input.request_id, digest, 'replayed' in result && result.replayed ? 'replay' : result.status);
          if (recordResult && !reading && result.status !== 'unknown' && result.status !== 'ok') {
            await ops.record(tx, input.workspace_id, actor, input.request_id, digest, requiredOperation, result);
          }
          return result;
        };
        // A write-only connection may finish its upload without read consent.
        // Resolve the exact operation from the locked reservation below, and
        // enforce it again before dispatch or replaying a recorded outcome.
        if (cmd.kind === 'file_version_commit') requiredOperation = authorize('create') === null ? 'create' : 'update';
        const initialDenied = authorize(requiredOperation);
        if (initialDenied) {
          await ops.audit(tx, input.workspace_id, actor, input.request_id, digest, 'refused');
          return refused(initialDenied);
        }
        if (!reading) {
          const previous = await ops.receipt(tx, input.workspace_id, actor, input.request_id);
          if (previous) {
            const replayDenied = authorize(previous.operation);
            if (replayDenied) {
              await ops.audit(tx, input.workspace_id, actor, input.request_id, digest, 'refused');
              return refused(replayDenied);
            }
            requiredOperation = previous.operation;
            return finish(previous.digest === digest ? { ...structuredClone(previous.result), replayed: true } : refused('request_id_reused'), false);
          }
        }
        if (cmd.kind === 'file_tombstone' || cmd.kind === 'file_restore') return finish(refused('legacy_operation_unsupported'));
        let name: string | null = null;
        if (cmd.kind === 'brain_put' || cmd.kind === 'brain_get' || cmd.kind === 'brain_history') {
          try { name = ops.brain.brainFileName(cmd.topic); } catch { return finish(refused('invalid_brain_topic')); }
        }
        const binding = await ops.resolve(tx, input.workspace_id, actor, name !== null ? { name } : { file_id: (cmd as FileCommand).file_id });
        if (binding && (binding.workspace_id !== input.workspace_id
          || (name !== null ? binding.name !== name : binding.file_id !== (cmd as FileCommand).file_id))) {
          return finish(refused('workspace_access_refused'));
        }
        if (reading) {
          if (!binding) return finish(refused('object_not_found'));
          if (cmd.kind === 'brain_history') {
            const read = await ops.read(tx, input.workspace_id, actor, { kind: 'object_history', object_id: binding.object_id, offset: cmd.offset, limit: cmd.limit });
            if (read.status === 'refused') return finish(refused(read.reason));
            if (read.kind !== 'object_history') throw new Error('unexpected read result');
            return finish({ status: 'ok', kind: 'history', request_id: input.request_id,
              revisions: read.revisions.map(({ revision, author, occurred_at_server, command_id, live }) =>
                ({ revision, author, occurred_at_server, command_id, live })), next_offset: read.next_offset });
          }
          if (cmd.kind !== 'file_download_url' && cmd.kind !== 'brain_get') throw new Error('unexpected command');
          const version = cmd.version_n === null ? binding.versions.at(-1) : binding.versions.find((v) => v.version_n === cmd.version_n);
          if (!version) return finish(refused('revision_not_found'));
          const read = await ops.readBytes(tx, input.workspace_id, actor, { kind: 'object_read', object_id: binding.object_id, revision: version.metadata.revision });
          if (read.status === 'refused') return finish(refused(read.reason));
          const revision = read.metadata.revision;
          if (!sameRef(revision.revision, version.metadata.revision)) throw new Error('unexpected revision');
          return finish({ status: 'ok', kind: 'read', request_id: input.request_id, revision: revision.revision,
            author: revision.author, occurred_at_server: revision.occurred_at_server, content: version.content, attachment: version.content.kind === 'doc' ? new TextEncoder().encode(version.content.markdown) : read.bytes });
        }
        let command: HouseholdObjectCommand, proposal: HouseholdProposal | null = null;
        let operation: 'create' | 'update';
        if (cmd.kind === 'file_version_commit') {
          const pending = binding?.pending.find((v) => v.version_id === cmd.version_id);
          if (!pending) return finish(refused('reservation_access_refused'));
          if (cmd.sha256 !== null && cmd.sha256 !== pending.source_sha256) return finish(refused('bytes_mismatch'));
          operation = pending.operation;
          command = { kind: 'commit_household_upload', reservation_id: cmd.version_id, operation };
        } else {
          if (cmd.kind !== 'brain_put' && cmd.kind !== 'file_version_create') return finish(refused('legacy_operation_unsupported'));
          const objectId = binding?.object_id ?? (cmd.kind === 'brain_put' ? name! : cmd.file_id);
          let content: HouseholdContent;
          if (cmd.kind === 'brain_put') content = { kind: 'doc', markdown: cmd.markdown };
          else {
            if (!attachment) return finish(refused('verified_attachment_required'));
            if (attachment.byteLength !== cmd.declared_size_bytes) return finish(refused('bytes_mismatch'));
            if (ops.brain.brainTopicFromFileName(cmd.name) !== null) {
              try { content = { kind: 'doc', markdown: new TextDecoder('utf-8', { fatal: true }).decode(attachment) }; }
              catch { return finish(refused('content_invalid')); }
            } else content = { kind: 'file', name: cmd.name, media_type: cmd.content_type };
          }
          proposal = { content, ...(content.kind === 'file' ? { file_bytes: attachment } : {}) };
          let base = input.base_revision;
          if (!base && cmd.if_version !== null && cmd.if_version !== 0) base = binding?.versions.find((v) => v.version_n === cmd.if_version)?.metadata.revision;
          if (cmd.if_version !== null && (!Number.isSafeInteger(cmd.if_version) || cmd.if_version < 0)) return finish(refused('revision_not_found'));
          const exists = (binding?.versions.length ?? 0) > 0;
          if (!base && (exists || cmd.if_version !== null && cmd.if_version > 0)) return finish(refused('base_revision_required'));
          const historical = base && binding?.versions.find((v) => sameRef(v.metadata.revision, base));
          if (base && (!historical || base.workspace_id !== input.workspace_id || base.object_id !== objectId)) return finish(refused('revision_not_found'));
          if (base && cmd.if_version !== null && historical?.version_n !== cmd.if_version) return finish(refused('revision_not_found'));
          operation = base ? 'update' : 'create';
          let change: Extract<HouseholdObjectCommand, { kind: 'reserve_household_upload' }>['change'];
          if (!base) change = { kind: 'create', title: name ?? (cmd.kind === 'file_version_create' ? cmd.name : ''), content };
          else {
            const before = historical!.content;
            if (before.kind !== content.kind) return finish(refused('object_type_mismatch'));
            const patch = before.kind === 'doc' && content.kind === 'doc'
              ? { kind: 'doc' as const, splices: [{ start: 0, before: before.markdown, after: content.markdown }] }
              : before.kind === 'file' && content.kind === 'file'
                ? { kind: 'file' as const, before_sha256: historical!.metadata.blob.sha256, replacement: content } : null;
            if (!patch) return finish(refused('object_type_mismatch'));
            change = { kind: 'update', base, patch };
          }
          command = cmd.kind === 'file_version_create'
            ? { kind: 'reserve_household_upload', object_id: objectId, reservation_id: cmd.version_id, expires_at: facts!.now + ops.uploadLifetimeMs, change }
            : change.kind === 'create' ? { kind: 'create_household_object', object_id: objectId, title: change.title, content }
              : { kind: 'update_household_object', object_id: objectId, base: change.base, patch: change.patch };
        }
        requiredOperation = operation;
        const denied = authorize(operation);
        if (denied) return finish(refused(denied));
        const decision = await ops.write(tx, input.workspace_id, actor, input.request_id, command, proposal);
        if (cmd.kind === 'file_version_create' && decision.outcome.status === 'pending') {
          await ops.registerUpload(tx, input.workspace_id, actor, cmd.file_id, cmd.version_id, decision.outcome.object_id, await ops.transfers.householdSha256(attachment!));
        }
        return finish({ ...decision.outcome, request_id: input.request_id, replayed: decision.replayed });
      });
    } catch {
      // Includes ambiguous COMMIT acknowledgements. Retry the exact ID/payload;
      // only a subsequent durable receipt can establish what actually happened.
      return { status: 'unknown', request_id: input.request_id, reason: 'transaction_outcome_unknown' };
    }
  };
}
