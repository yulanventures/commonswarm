/**
 * A person's read position per channel (mark_channel_read), browser side: which message a view marks
 * through, how the rail reads once a mark is sent, and the words of the unread bar.
 */
import { GENERAL_CHANNEL_ID, signalInChannelView, type ChannelUnreadState } from "./channels";

export const MARK_AS_READ_LABEL = "Mark as read";
export const UNREAD_DIVIDER_LABEL = "Unread";
/** Older pages Jump to first unread loads, at most, to reach a first unread message above the loaded ones. */
export const UNREAD_JUMP_PAGES = 3;

export const unreadJumpLabel = (count: number): string => `${count} unread · Jump to first unread`;

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

/**
 * The message to mark through, or null to mark up to now. The person's own message addressed to
 * someone is not one they can name (the server answers signal_not_found); it is the newest one on
 * screen, so up to now is the nearest mark.
 */
export const throughSignalFor = (signal: ReadableMessage, viewerId: string): string | null =>
  signal.fromKind === "user" && signal.from === viewerId && (signal.to !== null || signal.toAgent !== null)
    ? null
    : signal.id;

/** Whether the first unread message is older than every loaded message of the view (so not on the page). */
export const firstUnreadOlderThanLoaded = (firstUnreadAt: string | null, oldestLoadedAt: string | null): boolean => {
  if (firstUnreadAt === null || oldestLoadedAt === null) return false;
  const first = Date.parse(firstUnreadAt), oldest = Date.parse(oldestLoadedAt);
  return Number.isFinite(first) && Number.isFinite(oldest) && first < oldest;
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
