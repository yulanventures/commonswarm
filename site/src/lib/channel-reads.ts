/**
 * A person's read position per channel (mark_channel_read), browser side: which message a view marks
 * through, how the rail reads once a mark is sent, and the words of the unread bar.
 */
import { GENERAL_CHANNEL_ID, signalInChannelView, type ChannelUnreadState } from "./channels";

export const MARK_AS_READ_LABEL = "Mark as read";
export const MARK_ALL_AS_READ_LABEL = "Mark all as read";
export const UNREAD_DIVIDER_LABEL = "Unread";
export const JUMP_TO_FIRST_UNREAD_LABEL = "Jump to first unread";
/** The feed's way back to the newest message, for a reader more than a screen up in history. */
export const JUMP_TO_PRESENT_LABEL = "Jump to present";
/** The bar's action while the first unread message is still older than every page loaded so far. */
export const CONTINUE_LOADING_LABEL = "Continue loading";
/** Older pages one Jump (or Continue loading) loads, at most, toward a first unread message above the loaded ones. */
export const UNREAD_JUMP_PAGES = 3;
/** After a mark that did not land, how long before the same view is marked on view again. */
export const CHANNEL_READ_RETRY_MS = 15_000;

/** The bar's action: the count only while it is still the server's count for this visit (before the visit's mark
 *  landed) and a real one. A server without counts never shows "0 unread". */
export const unreadJumpLabel = (count: number, marked = false): string =>
  !marked && count > 0 ? `${count} unread · ${JUMP_TO_FIRST_UNREAD_LABEL}` : JUMP_TO_FIRST_UNREAD_LABEL;

/** The command's channel_id for a view: null for #general. */
export const readChannelIdOf = (viewId: string): string | null => (viewId === GENERAL_CHANNEL_ID ? null : viewId);

/** The fields of a loaded message these rules read. */
export interface ReadableMessage {
  id: string;
  from: string;
  fromKind: string;
  to: string | null;
  toAgent: string | null;
  createdAt: string;
  channelId: string | null;
  threadRootId: string | null;
  broadcastToChannel?: boolean;
  /** A message addressed to several people or agents names them here. */
  recipients?: readonly unknown[] | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A stored message the channel's unread counts: a top-level one, or a thread reply also sent to the channel. A row
 *  without a server id (the sample's) is never one: the server refuses it as malformed. */
export const countsInChannel = (signal: ReadableMessage): boolean =>
  UUID_RE.test(signal.id) && (signal.threadRootId === null || signal.broadcastToChannel === true);

/** The newest loaded message of a view that a read position can name. `signals` is newest first, as loaded. */
export const newestChannelMessage = <S extends ReadableMessage>(signals: readonly S[], viewId: string): S | null =>
  signals.find((signal) => signalInChannelView(signal.channelId, viewId) && countsInChannel(signal)) ?? null;

/** The oldest loaded message of a view that a read position can name. */
export const oldestChannelMessage = <S extends ReadableMessage>(signals: readonly S[], viewId: string): S | null =>
  [...signals].reverse().find((signal) => signalInChannelView(signal.channelId, viewId) && countsInChannel(signal)) ?? null;

/** The person's own message addressed to someone: never unread for them (channel_unread leaves out their own
 *  messages), and not one they can name in a mark (the server answers signal_not_found). */
const ownAddressed = (signal: ReadableMessage, viewerId: string): boolean =>
  signal.fromKind === "user" && signal.from === viewerId &&
  (signal.to !== null || signal.toAgent !== null || (signal.recipients?.length ?? 0) > 0);

/**
 * The newest loaded message of a view that a mark can go through: one the unread counts, not the person's own
 * addressed message, and not one the server already refused. A mark through it never reaches past what was
 * loaded; null means there is nothing to mark through, and an automatic mark then sends nothing.
 */
export const newestMarkableChannelMessage = <S extends ReadableMessage>(
  signals: readonly S[],
  viewId: string,
  viewerId: string,
  refusedIds: ReadonlySet<string> = new Set(),
): S | null =>
  signals.find((signal) => signalInChannelView(signal.channelId, viewId) && countsInChannel(signal) &&
    !ownAddressed(signal, viewerId) && !refusedIds.has(signal.id)) ?? null;

/**
 * A timestamp as whole microseconds since the epoch, exactly: PostgreSQL keeps six fractional digits and a
 * JavaScript Date only three, so two messages inside one millisecond are told apart here. Takes ISO 8601 and
 * PostgreSQL's own text form (a space for the T, an offset of +HH, +HHMM or +HH:MM, or Z); null when unreadable.
 */
export const timestampMicros = (value: string): bigint | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}(?::?\d{2})?)?$/i.exec(value.trim());
  if (!match) return null;
  const [, year, month, day, hour, minute, second, fraction = "", zone = "Z"] = match;
  const wholeMs = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  if (!Number.isFinite(wholeMs)) return null;
  let offsetMinutes = 0;
  if (zone.toUpperCase() !== "Z") {
    const digits = zone.slice(1).replace(":", "");
    offsetMinutes = (zone.startsWith("-") ? -1 : 1) * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4) || "0"));
  }
  const micros = BigInt((fraction + "000000").slice(0, 6));
  return BigInt(wholeMs) * 1000n + micros - BigInt(offsetMinutes) * 60_000_000n;
};

/**
 * Whether the first unread message comes before every loaded message of the view (so it is not on the page), by
 * the order the feed pages in: created_at, then id. Equal times are broken by id, so a message that shares its
 * time with the page's oldest one is still found on the next page.
 */
export const firstUnreadOlderThanLoaded = (
  firstUnreadAt: string | null,
  firstUnreadId: string | null,
  oldestLoaded: { createdAt: string; id: string } | null,
): boolean => {
  if (firstUnreadAt === null || oldestLoaded === null) return false;
  const first = timestampMicros(firstUnreadAt), oldest = timestampMicros(oldestLoaded.createdAt);
  if (first === null || oldest === null) return false;
  if (first !== oldest) return first < oldest;
  return firstUnreadId !== null && firstUnreadId.toLowerCase() < oldestLoaded.id.toLowerCase();
};

type ReadRow = ChannelUnreadState & { unreadCount?: number; firstUnreadId?: string | null; firstUnreadAt?: string | null };

/**
 * The rows as they read once a mark is sent: the marked view (or every view, for "all") is read. A view
 * whose unread is unknown stays unknown; the next read replaces all of it with what the server stored.
 */
export const withChannelRead = <Row extends ReadRow>(rows: readonly Row[], viewId: string | "all"): Row[] =>
  rows.map((row) => {
    if (viewId !== "all" && row.channelId !== readChannelIdOf(viewId)) return row;
    if (row.unread !== true && !row.unreadCount && !row.firstUnreadId) return row;
    return { ...row, unread: row.unread === null ? null : false, unreadCount: 0, firstUnreadId: null, firstUnreadAt: null };
  });

/** The unread row for one view, or null when the read has none. */
export const channelReadRowFor = <Row extends ReadRow>(rows: readonly Row[] | null, viewId: string): Row | null =>
  rows?.find((row) => row.channelId === readChannelIdOf(viewId)) ?? null;
