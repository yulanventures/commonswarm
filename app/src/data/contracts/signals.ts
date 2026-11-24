// Copied pure decoders from site/src/lib/commonswarm.ts (lines 2638-2694, 3682-3725, 4618-4648),
// site/src/lib/signal-feed.ts (lines 102-147), and site/src/lib/home-stream.ts (lines 36, 45-83)
// at commit 56d9de36b524c759d95e4e518ea109e3c2039964, plus strict fail-closed validation for
// `conversation_history` message rows.

import type { ConversationKind } from './conversations';

export const BROWSER_ATTACHMENT_MAX = 10;

export interface BrowserSignalAttachment {
  file_id: string;
  version_n: number;
  name: string;
  content_type: string;
  size_bytes: number;
}

export interface SignalMention {
  signalId: string;
  position: number;
  kind: 'agent' | 'person';
  id: string;
  source: 'author' | 'lead' | 'thread';
}

export interface Signal {
  id: string;
  from: string;
  fromKind: string;
  to: string | null;
  toAgent: string | null;
  kind: string;
  body: string;
  attachments?: BrowserSignalAttachment[];
  about: string | null;
  until: string | null;
  createdAt: string;
  channelId: string | null;
  threadRootId: string | null;
  inReplyTo?: string | null;
  broadcastToChannel: boolean;
  conversationId?: string | null;
  conversationKind?: ConversationKind | null;
  recipients?: Array<{ kind: 'user' | 'agent'; id: string }>;
  mentions?: SignalMention[];
}

export function parseBrowserSignalAttachments(
  value: unknown,
): BrowserSignalAttachment[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > BROWSER_ATTACHMENT_MAX) {
    throw new Error('CommonSwarm returned malformed message attachments.');
  }
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('CommonSwarm returned a malformed message attachment.');
    }
    const row = item as Record<string, unknown>;
    if (
      typeof row.file_id !== 'string' ||
      typeof row.version_n !== 'number' ||
      !Number.isSafeInteger(row.version_n) ||
      row.version_n < 1 ||
      typeof row.name !== 'string' ||
      row.name.length < 1 ||
      typeof row.content_type !== 'string' ||
      typeof row.size_bytes !== 'number' ||
      !Number.isSafeInteger(row.size_bytes) ||
      row.size_bytes < 0
    ) {
      throw new Error(
        'CommonSwarm returned malformed message attachment metadata.',
      );
    }
    return {
      file_id: row.file_id,
      version_n: row.version_n,
      name: row.name,
      content_type: row.content_type,
      size_bytes: row.size_bytes,
    };
  });
}

function parseSignalRecipients(
  value: unknown,
): Array<{ kind: 'user' | 'agent'; id: string }> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new Error('CommonSwarm returned malformed message recipients.');
  }
  const out: Array<{ kind: 'user' | 'agent'; id: string }> = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('CommonSwarm returned malformed message recipients.');
    }
    const row = item as Record<string, unknown>;
    if (
      (row.kind !== 'user' && row.kind !== 'agent') ||
      typeof row.id !== 'string' ||
      !row.id.trim()
    ) {
      throw new Error('CommonSwarm returned malformed message recipients.');
    }
    out.push({ kind: row.kind, id: row.id.toLowerCase() });
  }
  return out;
}

/** Parse inline mentions attached to a `conversation_history` message row (fail-closed). */
function parseInlineSignalMentions(
  signalId: string,
  value: unknown,
): SignalMention[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new Error('CommonSwarm returned malformed message mentions.');
  }
  const out: SignalMention[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('CommonSwarm returned malformed message mentions.');
    }
    const row = raw as Record<string, unknown>;
    if (
      typeof row.id !== 'string' ||
      !row.id.trim() ||
      (row.kind !== 'user' && row.kind !== 'agent') ||
      (row.source !== 'author' &&
        row.source !== 'lead' &&
        row.source !== 'thread') ||
      typeof row.position !== 'number' ||
      !Number.isInteger(row.position)
    ) {
      throw new Error('CommonSwarm returned malformed message mentions.');
    }
    out.push({
      signalId: signalId.toLowerCase(),
      position: row.position,
      kind: row.kind === 'user' ? 'person' : 'agent',
      id: row.id.toLowerCase(),
      source: row.source,
    });
  }
  return out.sort((left, right) => left.position - right.position);
}

/**
 * Strict fail-closed decoder for one message row returned by
 * `POST /functions/v1/read` (`resource: "conversation_history"`).
 * Throws on any missing or malformed required field so the UI never partially renders.
 */
export function parseConversationHistoryMessageRow(
  row: Record<string, unknown>,
): Signal {
  if (
    typeof row.id !== 'string' ||
    !row.id.trim() ||
    typeof row.from !== 'string' ||
    typeof row.from_kind !== 'string' ||
    !row.from_kind.trim() ||
    typeof row.kind !== 'string' ||
    !row.kind.trim() ||
    typeof row.body !== 'string' ||
    typeof row.created_at !== 'string' ||
    !Number.isFinite(Date.parse(row.created_at))
  ) {
    throw new Error('conversation_history_message_malformed');
  }

  const nullableString = (value: unknown, field: string): string | null => {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string') {
      throw new Error(`conversation_history_${field}_malformed`);
    }
    return value;
  };

  if (
    row.broadcast_to_channel !== undefined &&
    row.broadcast_to_channel !== null &&
    typeof row.broadcast_to_channel !== 'boolean'
  ) {
    throw new Error('conversation_history_broadcast_malformed');
  }

  const id = row.id.toLowerCase();
  const conversationId = nullableString(row.conversation_id, 'conversation_id');
  const recipients = parseSignalRecipients(row.recipients);
  const mentions = parseInlineSignalMentions(id, row.mentions);

  return {
    id,
    from: row.from.toLowerCase(),
    fromKind: row.from_kind,
    to: nullableString(row.to, 'to')?.toLowerCase() ?? null,
    toAgent: nullableString(row.to_agent, 'to_agent')?.toLowerCase() ?? null,
    kind: row.kind,
    body: row.body,
    attachments: parseBrowserSignalAttachments(row.attachments),
    about: nullableString(row.about, 'about'),
    until: nullableString(row.until, 'until'),
    createdAt: row.created_at,
    channelId: nullableString(row.channel_id, 'channel_id')?.toLowerCase() ?? null,
    threadRootId:
      nullableString(row.thread_root_id, 'thread_root_id')?.toLowerCase() ?? null,
    inReplyTo:
      nullableString(row.in_reply_to, 'in_reply_to')?.toLowerCase() ?? null,
    broadcastToChannel: row.broadcast_to_channel === true,
    ...(conversationId !== null && conversationId !== ''
      ? { conversationId: conversationId.toLowerCase() }
      : {}),
    ...(recipients !== undefined ? { recipients } : {}),
    ...(mentions !== undefined ? { mentions } : {}),
  };
}

export interface ThreadGroup<T> {
  root: T;
  replies: T[];
}

type ThreadSignal = Pick<Signal, 'id' | 'threadRootId'>;

export const groupSignalThreads = <T extends ThreadSignal>(
  signals: readonly T[],
): ThreadGroup<T>[] => {
  const rootIds = new Set(
    signals
      .filter((signal) => signal.threadRootId === null)
      .map((signal) => signal.id),
  );
  const isOwnRow = (signal: T): boolean =>
    signal.threadRootId === null || !rootIds.has(signal.threadRootId);
  const groups: ThreadGroup<T>[] = [];
  const byRootId = new Map<string, ThreadGroup<T>>();
  for (const signal of signals) {
    if (!isOwnRow(signal)) continue;
    const group: ThreadGroup<T> = { root: signal, replies: [] };
    groups.push(group);
    if (signal.threadRootId === null) byRootId.set(signal.id, group);
  }
  for (const signal of signals) {
    if (isOwnRow(signal)) continue;
    byRootId.get(signal.threadRootId!)!.replies.push(signal);
  }
  return groups;
};

export type StreamRow<T> =
  | { type: 'divider'; key: string; label: string }
  | { type: 'item'; item: T };

function dayParts(
  ms: number,
  timeZone?: string,
): { y: number; m: number; d: number } | null {
  if (!Number.isFinite(ms)) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(new Date(ms));
  const pick = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value);
  const y = pick('year');
  const m = pick('month');
  const d = pick('day');
  return Number.isFinite(y) && Number.isFinite(m) && Number.isFinite(d)
    ? { y, m, d }
    : null;
}

const dayNumber = (p: { y: number; m: number; d: number }): number =>
  Date.UTC(p.y, p.m - 1, p.d) / 86_400_000;

export function dayKey(iso: string, timeZone?: string): string | null {
  const p = dayParts(Date.parse(iso), timeZone);
  return p
    ? `${String(p.y).padStart(4, '0')}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`
    : null;
}

export function dayDividerLabel(
  iso: string,
  now: number,
  locale: string,
  timeZone?: string,
): string | null {
  const then = dayParts(Date.parse(iso), timeZone);
  const today = dayParts(now, timeZone);
  if (!then || !today) return null;
  const apart = dayNumber(today) - dayNumber(then);
  if (apart === 0) return 'Today';
  if (apart === 1) return 'Yesterday';
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    month: 'short',
    day: 'numeric',
    ...(then.y === today.y ? {} : { year: 'numeric' }),
  }).format(new Date(Date.parse(iso)));
}

export function groupByDay<T extends { createdAt: string }>(
  items: readonly T[],
  now: number,
  locale: string,
  timeZone?: string,
): StreamRow<T>[] {
  const rows: StreamRow<T>[] = [];
  let previous: string | null = null;
  for (const item of items) {
    const key = dayKey(item.createdAt, timeZone);
    const label = key ? dayDividerLabel(item.createdAt, now, locale, timeZone) : null;
    if (key && label && key !== previous) {
      rows.push({ type: 'divider', key, label });
      previous = key;
    }
    rows.push({ type: 'item', item });
  }
  return rows;
}

const TODO_ABOUT_RE =
  /^todo:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;

export function todoIdFromAbout(about: string | null): string | null {
  return about ? (TODO_ABOUT_RE.exec(about)?.[1]?.toLowerCase() ?? null) : null;
}
