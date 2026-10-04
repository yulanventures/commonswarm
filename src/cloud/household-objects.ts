/** Prepared household client only; no HTTP, credential loading or dispatch.
 * The injected host resolves/authenticates the seat, enforces content permissions
 * and objectTypes, and commits through the transactional store. Transfers belong
 * to that host's protected attachment channel, never a model-visible URL.
 */
import {
  householdToolInvocation, type HouseholdToolHostContext, type HouseholdToolInvocation,
} from '../protocol/household-tool-registry.js';
import type {
  HouseholdContent, HouseholdObjectType, HouseholdRevisionRef,
} from '../protocol/household-object-events.js';

export interface HouseholdTransport {
  /** Return a store decision, read result, or readBytes result. The host must
   * resolve upload reservation facts stably and handle file bytes out of band.
   * Recheck authorization on every call, including retries and byte transfer.
   */
  execute(invocation: HouseholdToolInvocation, options: { signal?: AbortSignal }): Promise<unknown>;
}
export interface HouseholdRevisionView {
  revision: HouseholdRevisionRef;
  parent: HouseholdRevisionRef | null;
  title: string;
  kind: HouseholdObjectType;
  file_metadata: Extract<HouseholdContent, { kind: 'file' }> | null;
  size_bytes: number;
  sha256: string;
  author: { user_id: string; principal_id: string | null; run_id: string | null };
  occurred_at_server: number;
  command_id: string;
}
export type HouseholdClientResult =
  | { status: 'committed'; request_id: string; object_id: string; revision: HouseholdRevisionRef }
  | { status: 'pending'; request_id: string; object_id: string; reservation_id: string }
  | { status: 'conflict'; request_id: string; object_id: string; current: HouseholdRevisionRef; draft_id: string }
  | { status: 'refused'; request_id?: string; reason: string }
  | { status: 'unknown'; request_id?: string; reason: 'transport_interrupted' | 'invalid_response' }
  | { status: 'ok'; kind: 'object_list'; objects: readonly {
      object_id: string; kind: HouseholdObjectType; title: string; revision: HouseholdRevisionRef;
    }[]; next_offset: number | null }
  | { status: 'ok'; kind: 'object_history'; revisions: readonly (HouseholdRevisionView & { live: boolean })[]; next_offset: number | null }
  | { status: 'ok'; kind: 'object_read'; revision: HouseholdRevisionView; live: boolean; content?: HouseholdContent };

export interface HouseholdPreparedRequest {
  readonly workspace_id: string;
  readonly tool: string;
  readonly request_id?: string;
  /** One attempt. Known write outcomes are returned without another write.
   * Reads always return to the host for fresh authorization and content.
   */
  send(options?: { signal?: AbortSignal }): Promise<HouseholdClientResult>;
  /** Only an unknown outcome is resubmitted, with the original input and ID. */
  retry(options?: { signal?: AbortSignal }): Promise<HouseholdClientResult>;
}

/** Retry snapshots are a local convenience, not durable authority or permission.
 * After restart callers recover by preparing identical arguments and request_id.
 * A reviewed changed patch must be prepared with a new request_id; the server's
 * durable digest check remains authoritative across clients and restarts.
 */
export class HouseholdObjectClient {
  constructor(private readonly transport: HouseholdTransport, readonly workspace_id: string) {}

  prepare(tool: string, input: unknown, host: Pick<HouseholdToolHostContext, 'upload'> = {}): HouseholdPreparedRequest {
    const invocation = householdToolInvocation(tool, structuredClone(input), {
      ...host, workspace_id: this.workspace_id,
    });
    // Detach injected host facts as well as caller input.
    const snapshot = structuredClone(invocation);
    let last: HouseholdClientResult | undefined;
    let running: Promise<HouseholdClientResult> | undefined;
    const attempt = (options: { signal?: AbortSignal } = {}): Promise<HouseholdClientResult> => {
      if (running) return running;
      if ('command' in snapshot && last && last.status !== 'unknown') return Promise.resolve(structuredClone(last));
      running = (async () => {
        let result: HouseholdClientResult;
        try {
          // Each attempt has its own copy: a host must not mutate retry input.
          const response = await this.transport.execute(structuredClone(snapshot), options);
          result = decodeResponse(response, snapshot);
        } catch {
          // A thrown error says nothing about whether the transaction committed.
          // Never echo raw errors; they can contain URLs, headers or credentials.
          result = unknown(snapshot, 'transport_interrupted');
        }
        last = result;
        return structuredClone(result);
      })().finally(() => { running = undefined; });
      return running;
    };
    return Object.freeze({ workspace_id: snapshot.workspace_id, tool,
      ...(snapshot.request_id ? { request_id: snapshot.request_id } : {}), send: attempt, retry: attempt });
  }
}

type Row = Record<string, unknown>;
const row = (value: unknown): Row | null => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) ? value as Row : null;
const text = (value: unknown): value is string => typeof value === 'string';
const id = (value: unknown): value is string => text(value) && value.length > 0;
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const page = (value: unknown): value is number | null => value === null || count(value);
const kind = (value: unknown): value is HouseholdObjectType => value === 'list' || value === 'doc' || value === 'file';
function revision(value: unknown, workspace: string, object?: string): HouseholdRevisionRef | null {
  const ref = row(value);
  return ref && ref.workspace_id === workspace && id(ref.object_id) && (object === undefined || ref.object_id === object)
    && text(ref.token) && /^[A-Za-z0-9_-]{22,128}$/.test(ref.token)
    ? { workspace_id: workspace, object_id: ref.object_id, token: ref.token } : null;
}
function content(value: unknown, expected: HouseholdObjectType): HouseholdContent | null {
  const data = row(value);
  if (!data || data.kind !== expected) return null;
  if (data.kind === 'doc' && text(data.markdown)) return { kind: 'doc', markdown: data.markdown };
  if (data.kind === 'file' && id(data.name) && id(data.media_type)) return { kind: 'file', name: data.name, media_type: data.media_type };
  if (data.kind !== 'list' || !Array.isArray(data.items)) return null;
  const items: Extract<HouseholdContent, { kind: 'list' }>['items'][number][] = [];
  const ids = new Set<string>();
  for (const [index, value] of data.items.entries()) {
    const item = row(value);
    if (!item || !id(item.item_id) || ids.has(item.item_id) || !text(item.text)
      || typeof item.checked !== 'boolean' || item.order !== index) return null;
    ids.add(item.item_id);
    items.push({ item_id: item.item_id, text: item.text, checked: item.checked, order: index });
  }
  return { kind: 'list', items };
}
function revisionView(value: unknown, workspace: string, object?: string): HouseholdRevisionView | null {
  const data = row(value);
  if (!data) return null;
  const ref = revision(data.revision, workspace, object);
  if (!ref || !kind(data.kind) || !id(data.title) || !id(data.command_id)
    || typeof data.occurred_at_server !== 'number' || !Number.isFinite(data.occurred_at_server)) return null;
  const parent = data.parent === null ? null : revision(data.parent, workspace, ref.object_id);
  if (data.parent !== null && !parent) return null;
  const blob = row(data.blob);
  const author = row(data.author);
  if (!blob || !count(blob.size_bytes) || !text(blob.sha256) || !/^[a-f0-9]{64}$/.test(blob.sha256)
    || !author || !id(author.user_id) || !(author.principal_id === null || id(author.principal_id))
    || !(author.run_id === null || id(author.run_id))) return null;
  const file = data.kind === 'file' ? content(data.file_metadata, 'file') : null;
  if (data.kind === 'file' && !file) return null;
  return { revision: ref, parent, title: data.title, kind: data.kind,
    file_metadata: file as HouseholdRevisionView['file_metadata'], size_bytes: blob.size_bytes, sha256: blob.sha256,
    author: { user_id: author.user_id, principal_id: author.principal_id, run_id: author.run_id },
    occurred_at_server: data.occurred_at_server, command_id: data.command_id };
}
function unknown(invocation: HouseholdToolInvocation, reason: Extract<HouseholdClientResult, { status: 'unknown' }>['reason']): HouseholdClientResult {
  return { status: 'unknown', ...(invocation.request_id ? { request_id: invocation.request_id } : {}), reason };
}

/** Closed projections, never spread a server result into model output. */
function decodeResponse(value: unknown, invocation: HouseholdToolInvocation): HouseholdClientResult {
  const invalid = () => unknown(invocation, 'invalid_response');
  const envelope = row(value);
  if (!envelope) return invalid();
  const data = row(envelope.outcome ?? envelope.metadata ?? envelope);
  if (!data) return invalid();
  const request_id = invocation.request_id;
  if (data.status === 'refused') return { status: 'refused', ...(request_id ? { request_id } : {}),
    reason: text(data.reason) && /^[a-z][a-z0-9_]{0,63}$/.test(data.reason) ? data.reason : 'request_refused' };
  if ('command' in invocation) {
    const command = invocation.command;
    const object = 'object_id' in command ? command.object_id : undefined;
    if (!request_id || !id(data.object_id) || (object !== undefined && object !== data.object_id)) return invalid();
    if (data.status === 'committed' && command.kind !== 'reserve_household_upload') {
      const ref = revision(data.revision, invocation.workspace_id, data.object_id);
      if (ref) return { status: 'committed', request_id, object_id: data.object_id, revision: ref };
    }
    if (data.status === 'pending' && command.kind === 'reserve_household_upload'
      && data.reservation_id === command.reservation_id) return { status: 'pending', request_id,
        object_id: data.object_id, reservation_id: command.reservation_id };
    if (data.status === 'conflict' && (command.kind === 'update_household_object'
      || command.kind === 'commit_household_upload' && command.operation === 'update'
      || command.kind === 'reserve_household_upload' && command.change.kind === 'update')) {
      const current = revision(data.current, invocation.workspace_id, data.object_id);
      if (current && id(data.draft_id)) return { status: 'conflict', request_id, object_id: data.object_id, current, draft_id: data.draft_id };
    }
    return invalid();
  }
  const query = invocation.query;
  if (data.status !== 'ok' || data.kind !== query.kind) return invalid();
  if (query.kind === 'object_list') {
    if (!Array.isArray(data.objects) || data.objects.length > query.limit || !page(data.next_offset)) return invalid();
    const objects: Extract<HouseholdClientResult, { kind: 'object_list' }>['objects'][number][] = [];
    for (const value of data.objects) {
      const object = row(value);
      if (!object || !id(object.object_id) || !kind(object.kind) || !invocation.objectTypes.includes(object.kind) || !id(object.title)) return invalid();
      const ref = revision(object.revision, invocation.workspace_id, object.object_id);
      if (!ref) return invalid();
      objects.push({ object_id: object.object_id, kind: object.kind, title: object.title, revision: ref });
    }
    return { status: 'ok', kind: query.kind, objects, next_offset: data.next_offset };
  }
  if (query.kind === 'object_history') {
    if (!Array.isArray(data.revisions) || data.revisions.length > query.limit || !page(data.next_offset)) return invalid();
    const revisions: Extract<HouseholdClientResult, { kind: 'object_history' }>['revisions'][number][] = [];
    for (const value of data.revisions) {
      const entry = revisionView(value, invocation.workspace_id, query.object_id);
      const live = row(value)?.live;
      if (!entry || !invocation.objectTypes.includes(entry.kind) || typeof live !== 'boolean') return invalid();
      revisions.push({ ...entry, live });
    }
    return { status: 'ok', kind: query.kind, revisions, next_offset: data.next_offset };
  }
  if (query.kind !== 'object_read') return invalid();
  const entry = revisionView(data.revision, invocation.workspace_id, query.object_id);
  if (!entry || !invocation.objectTypes.includes(entry.kind) || typeof data.live !== 'boolean'
    || query.revision && entry.revision.token !== query.revision.token) return invalid();
  if (entry.kind === 'file') return { status: 'ok', kind: query.kind, revision: entry, live: data.live };
  let rawContent = envelope.content ?? data.content;
  if (rawContent === undefined && envelope.bytes instanceof Uint8Array) {
    try { rawContent = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(envelope.bytes)); }
    catch { return invalid(); }
  }
  const projected = content(rawContent, entry.kind);
  return projected ? { status: 'ok', kind: query.kind, revision: entry, live: data.live, content: projected } : invalid();
}
