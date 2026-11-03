/** Provenance for agent-facing reads: which items an answer came from, the query
 * that selected them, how many rows came back, and whether more exist. It is
 * derived only from the result the agent already receives, so it never widens
 * access. Shared by the local stdio MCP server and the hosted MCP function. */

export const PROVENANCE_TITLE_MAX = 120;

export interface ReadProvenanceSource {
  kind: string;
  id: string;
  title?: string;
  revision?: string;
  from?: string;
  created_at?: string;
}
export interface ReadProvenance {
  sources?: ReadProvenanceSource[];
  query: Record<string, unknown>;
  row_count: number;
  truncated: boolean;
  sources_omitted?: true;
}

type Row = Record<string, unknown>;
const row = (value: unknown): Row | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Row : null;
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.map(row).filter((r): r is Row => r !== null) : [];
const str = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined;
const title = (value: unknown): string | undefined => {
  const text = str(value);
  if (text === undefined) return undefined;
  const points = Array.from(text);
  return points.length <= PROVENANCE_TITLE_MAX ? text : points.slice(0, PROVENANCE_TITLE_MAX - 1).join('') + '…';
};
const more = (value: unknown) => value !== null && value !== undefined;
const source = (fields: { kind: string; id: unknown } & Omit<Partial<ReadProvenanceSource>, 'kind' | 'id'>): ReadProvenanceSource | null => {
  const id = str(fields.id);
  if (id === undefined) return null;
  const out: ReadProvenanceSource = { kind: fields.kind, id };
  for (const key of ['title', 'revision', 'from', 'created_at'] as const) if (fields[key] !== undefined) out[key] = fields[key];
  return out;
};
const present = (list: (ReadProvenanceSource | null)[]) => list.filter((s): s is ReadProvenanceSource => s !== null);

/** Echo only the selecting arguments, never the seat, request id or content. */
const QUERY_ARGUMENTS = ['query', 'question', 'object_id', 'todo_id', 'principal_id', 'scope', 'section', 'assignee', 'target', 'offset', 'limit', 'comment_offset'] as const;
function query(tool: string, args: Row): Record<string, unknown> {
  const out: Record<string, unknown> = { tool };
  for (const key of QUERY_ARGUMENTS) if (Object.hasOwn(args, key)) out[key] = args[key];
  const revision = row(args.revision);
  if (revision && str(revision.token)) out.revision = revision.token;
  // Server-owned filter on the hosted list variants.
  if (tool.startsWith('list_')) out.kind_filter = 'list';
  return out;
}

function revisionSource(value: unknown, fallbackId: unknown): ReadProvenanceSource | null {
  const view = row(value);
  if (!view) return null;
  const ref = row(view.revision);
  return source({ kind: str(view.kind) ?? 'object', id: str(ref?.object_id) ?? fallbackId,
    title: title(view.title), revision: str(ref?.token) });
}

/** Provenance for a successful household read (Lists & docs, to-dos, comments).
 * Returns null for refusals, writes and unknown tools. */
export function householdReadProvenance(tool: string, args: Record<string, unknown>, result: Record<string, unknown>): ReadProvenance | null {
  if (result.status !== 'ok') return null;
  const op = tool.replace(/^list_/, 'object_');
  const q = query(tool, args);
  if (op === 'object_list') {
    const objects = rows(result.objects);
    return { sources: present(objects.map(o => source({ kind: str(o.kind) ?? 'object', id: o.object_id, title: title(o.title),
      revision: str(row(o.revision)?.token) }))), query: q, row_count: objects.length, truncated: more(result.next_offset) };
  }
  if (op === 'object_read' || op === 'file_read') {
    const content = row(result.content);
    const count = content?.kind === 'list' && Array.isArray(content.items) ? content.items.length : 1;
    return { sources: present([revisionSource(result.revision, args.object_id)]), query: q, row_count: count, truncated: false };
  }
  if (op === 'object_history') {
    const revisions = rows(result.revisions);
    return { sources: present(revisions.map(r => revisionSource(r, args.object_id))), query: q,
      row_count: revisions.length, truncated: more(result.next_offset) };
  }
  if (tool === 'definitions_search') {
    const definitions = rows(result.definitions);
    return { sources: present(definitions.map(d => source({ kind: 'definition', id: d.object_id, title: title(d.term),
      revision: str(row(d.revision)?.token) }))), query: q, row_count: definitions.length, truncated: more(result.next_offset) };
  }
  if (tool === 'check_answerable') {
    // The certified revisions an answer must come from; more matches than shown is truncated.
    const terms = rows(result.terms);
    return { sources: present(terms.map(t => source({ kind: 'definition', id: t.object_id, title: title(t.term),
      revision: str(row(t.revision)?.token) }))), query: q, row_count: terms.length,
      truncated: typeof result.matched_count === 'number' && result.matched_count > terms.length };
  }
  if (tool === 'definition_read') {
    // Cite the certified revision agents answer from; an uncertified definition cites its current one.
    const version = row(result.certified) ?? row(result.current);
    return { sources: present([version ? source({ kind: 'definition', id: result.object_id, title: title(version.term),
      revision: str(row(version.revision)?.token) }) : null]), query: q, row_count: version ? 1 : 0, truncated: false };
  }
  const todo = (t: Row) => source({ kind: 'todo', id: t.todo_id, title: title(t.title) });
  const comment = (c: Row) => source({ kind: 'comment', id: c.comment_id });
  if (op === 'todo_list') {
    const todos = rows(result.todos);
    return { sources: present(todos.map(todo)), query: q, row_count: todos.length, truncated: more(result.next_offset) };
  }
  if (op === 'todo_read') {
    const item = row(result.todo);
    const comments = rows(result.comments);
    return { sources: present([item ? todo(item) : null, ...comments.map(comment)]), query: q,
      row_count: (item ? 1 : 0) + comments.length, truncated: more(result.next_comment_offset) };
  }
  if (op === 'comment_list') {
    const comments = rows(result.comments);
    return { sources: present(comments.map(comment)), query: q, row_count: comments.length, truncated: more(result.next_offset) };
  }
  if (op === 'todo_queue') {
    const queue = row(result.queue) ?? {};
    const sections = ['working', 'up_next', 'not_yet', 'requests'] as const;
    const asked = typeof args.section === 'string' ? [args.section] : sections;
    const next = row(queue.next_offset) ?? {};
    const items = sections.flatMap(name => rows(queue[name]));
    return { sources: present(items.map(todo)), query: q, row_count: items.length,
      truncated: asked.some(name => more(next[name])) };
  }
  return null;
}

/** Provenance for directed messages from check (local or hosted). */
export function messageReadProvenance(messages: readonly unknown[], query: Record<string, unknown>, truncated: boolean): ReadProvenance {
  const list = rows(messages);
  return { sources: present(list.map(m => source({ kind: 'message', id: m.id, from: str(m.from),
    created_at: typeof m.created_at === 'string' ? m.created_at : m.created_at instanceof Date ? m.created_at.toISOString() : undefined }))),
  query, row_count: list.length, truncated };
}

/** Smaller forms of the same provenance, for results near a byte cap: full, then
 * ids only, then counts only. Callers fall back to no provenance after these, so
 * adding provenance never makes a result that fit stop fitting. */
export function provenanceForms(provenance: ReadProvenance): ReadProvenance[] {
  const { sources = [], ...rest } = provenance;
  return [provenance, { ...rest, sources: sources.map(({ kind, id }) => ({ kind, id })) }, { ...rest, sources_omitted: true }];
}

/** Attach the largest provenance form that keeps size(output) within maxBytes. */
export function withReadProvenance<T extends Record<string, unknown>>(output: T, provenance: ReadProvenance | null,
  fits: (candidate: Record<string, unknown>) => boolean): T | (T & { provenance: ReadProvenance }) {
  if (!provenance) return output;
  for (const form of provenanceForms(provenance)) {
    const candidate = { ...output, provenance: form };
    if (fits(candidate)) return candidate;
  }
  return output;
}
