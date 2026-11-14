/**
 * Channels, browser side.
 *
 * Every bound and every list a reader can see here is imported from
 * `supabase/functions/_shared/channels.ts` — the module the command edge
 * validates with. Nothing in this file retypes a rule the server enforces:
 * that is the failure AGENTS.md measured four times in one release cycle, and
 * a sentence built from the enforcing constant cannot drift from it.
 *
 * The dashboard already imports `_shared/signal-text` the same way
 * (`LiveDashboard.astro:21`), so this crosses no new boundary.
 */
import {
  CHANNEL_CREATION_POLICIES,
  CHANNEL_INVOLVEMENT_LEVELS,
  CHANNEL_PURPOSE_MAX,
  CHANNEL_SLUG_MAX,
  CHANNEL_SLUG_RULE_TEXT,
  RESERVED_CHANNEL_SLUG_TEXT,
  RESERVED_CHANNEL_SLUGS,
  channelSlugProblem,
  isReservedChannelSlug,
  normalizeChannelSlug,
  type ChannelCreationPolicy,
  type ChannelInvolvement,
} from "../../../supabase/functions/_shared/channels.js";

export type { ChannelCreationPolicy, ChannelInvolvement };
export {
  CHANNEL_INVOLVEMENT_LEVELS,
  CHANNEL_PURPOSE_MAX,
  CHANNEL_SLUG_MAX,
  CHANNEL_SLUG_RULE_TEXT,
  RESERVED_CHANNEL_SLUG_TEXT,
  RESERVED_CHANNEL_SLUGS,
  channelSlugProblem,
  isReservedChannelSlug,
  normalizeChannelSlug,
};

/**
 * The name of the unfiltered view. It is NOT a row in `swarm.channels`: it is
 * the whole feed, filed and unfiled together. The edge reserves this slug so a
 * member cannot create a channel that shadows it, and
 * `channels.test.mjs` asserts that reservation rather than assuming it.
 */
export const ALL_SIGNALS_SLUG = "all-signals";

/** One channel row as the browser reads it from `swarm_read.channels`. */
export interface WorkspaceChannel {
  channelId: string;
  workspaceId: string;
  slug: string;
  purpose: string | null;
  createdByPrincipal: string;
  createdByKind: string;
  createdAt: string;
  archivedAt: string | null;
  /** The workspace's shared order, set by an owner or admin. 0 or absent: never placed. */
  sortRank?: number;
  /** `"private"`: read only by its members. `null` or absent: not known (see private-channels.ts). */
  visibility?: "open" | "private" | null;
}

/** What the feed is filtered to. `null` is the unfiltered view. */
export type ActiveChannel = WorkspaceChannel | null;

/**
 * The rail and the head write a channel the same way. Channels read as "#slug"; the
 * unfiltered view reads "All messages" (plain-words rule, 2026-09-11: a person sees
 * messages, not signals).
 * The wire name stays ALL_SIGNALS_SLUG, which the edge reserves; only the label changed.
 */
export const ALL_MESSAGES_LABEL = "All messages";
export const channelLabel = (slug: string): string =>
  slug === ALL_SIGNALS_SLUG ? ALL_MESSAGES_LABEL : `#${slug}`;

/* ── Three views of one feed (Channels C1) ──────────────────────────────────────────
 * The dashboard keeps ONE string for what the feed shows, and it means one of three things:
 *   null              All messages: filed and unfiled together (links with no `?c=`).
 *   GENERAL_CHANNEL_ID #general: the unfiled messages only (`channel_id IS NULL`), `?c=general`.
 *   a channel id      that channel's messages, `?c=<uuid>`; the id survives a rename.
 * `general` is a reserved slug on the server, so no real channel carries it, and a real
 * channel id is a UUID, so the virtual id cannot collide with one. */

/** The slug and the view id of the virtual channel that holds unfiled messages. */
export const GENERAL_CHANNEL_SLUG = "general";
export const GENERAL_CHANNEL_ID = "general";

export type ChannelView =
  | { kind: "all" }
  | { kind: "general" }
  | { kind: "channel"; channelId: string };

export const channelViewOf = (viewId: string | null): ChannelView =>
  viewId === null || viewId === ""
    ? { kind: "all" }
    : viewId === GENERAL_CHANNEL_ID
    ? { kind: "general" }
    : { kind: "channel", channelId: viewId };

/** What the feed query adds to its WHERE for a view. The narrowing is the query's, never the page's. */
export type ChannelSignalFilter =
  | { kind: "none" }
  | { kind: "unfiled" }
  | { kind: "channel"; channelId: string };

export const channelSignalFilter = (viewId: string | null): ChannelSignalFilter => {
  const view = channelViewOf(viewId);
  return view.kind === "all"
    ? { kind: "none" }
    : view.kind === "general"
    ? { kind: "unfiled" }
    : { kind: "channel", channelId: view.channelId };
};

/** Would a row the server filed in `signalChannelId` show in this view? Same question the query asks. */
export const signalInChannelView = (signalChannelId: string | null, viewId: string | null): boolean => {
  const filter = channelSignalFilter(viewId);
  return filter.kind === "none" ||
    (filter.kind === "unfiled" ? signalChannelId === null : signalChannelId === filter.channelId);
};

/**
 * Where a `?c=` lands. A link names a view by id, so `general` is the virtual channel even if
 * a stale real row was once called that, and an id this workspace does not have stays
 * UNRESOLVED: it is never coerced into #general or All messages.
 */
export const resolveChannelParam = (
  requested: string | null,
  channels: readonly WorkspaceChannel[],
): { activeChannelId: string | null; unknownChannelId: string | null } => {
  if (requested === null || requested === "") return { activeChannelId: null, unknownChannelId: null };
  if (requested === GENERAL_CHANNEL_ID) return { activeChannelId: GENERAL_CHANNEL_ID, unknownChannelId: null };
  const found = channelById(channels, requested);
  return found === null
    ? { activeChannelId: null, unknownChannelId: requested }
    : { activeChannelId: found.channelId, unknownChannelId: null };
};

/**
 * Where a top-level message written in this view is filed: `null` is unfiled (the command
 * carries no `channel` key), a string is that channel. `undefined` means nowhere: the view is
 * an archived or unknown channel, and posting there must be refused rather than redirected.
 */
export const composerChannelFor = (
  viewId: string | null,
  channels: readonly WorkspaceChannel[],
): string | null | undefined => {
  const view = channelViewOf(viewId);
  if (view.kind !== "channel") return null;
  const channel = channelById(channels, view.channelId);
  return channel === null || channel.archivedAt !== null ? undefined : channel.channelId;
};

/** The name of a view: "All messages", "#general" or "#slug"; null for an id this list lacks. */
export const channelViewLabel = (
  viewId: string | null,
  channels: readonly WorkspaceChannel[],
): string | null => {
  const view = channelViewOf(viewId);
  if (view.kind === "all") return ALL_MESSAGES_LABEL;
  if (view.kind === "general") return channelLabel(GENERAL_CHANNEL_SLUG);
  const channel = channelById(channels, view.channelId);
  return channel === null ? null : channelLabel(channel.slug);
};

const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
/**
 * Channels an owner or admin has placed come first, in that order; the rest follow by name. A channel
 * created after the last reorder therefore joins at the end instead of jumping above the chosen order,
 * which is also how the server fills in the channels a reorder does not name.
 */
const placed = (channel: WorkspaceChannel): number => ((channel.sortRank ?? 0) > 0 ? channel.sortRank! : Number.MAX_SAFE_INTEGER);
const compareChannels = (left: WorkspaceChannel, right: WorkspaceChannel): number =>
  placed(left) - placed(right) || compareText(left.slug, right.slug) || compareText(left.channelId, right.channelId);

/** Live channels only, in the order a reader scans them: the workspace's shared order, then by name. */
export const liveChannels = (
  channels: readonly WorkspaceChannel[],
): WorkspaceChannel[] =>
  channels.filter((channel) => channel.archivedAt === null).sort(compareChannels);

/** Archived channels, in the same order. */
export const archivedChannels = (
  channels: readonly WorkspaceChannel[],
): WorkspaceChannel[] =>
  channels.filter((channel) => channel.archivedAt !== null).sort(compareChannels);

export const channelById = (
  channels: readonly WorkspaceChannel[],
  channelId: string | null,
): WorkspaceChannel | null =>
  channelId === null
    ? null
    : channels.find((channel) => channel.channelId === channelId) ?? null;

/** Rows the compact rail shows: #general plus up to five named channels. */
export const CHANNEL_RAIL_ROWS = 6;

/**
 * The compact rail. #general is always the first row, so named channels get the other five
 * slots. A selected channel past them takes the fifth slot in its own position, so the rows
 * shown keep their relative order; the count is every live channel left out.
 */
export function railChannelSlice(
  live: readonly WorkspaceChannel[],
  selectedId: string | null,
  expanded: boolean,
): { rows: { channel: WorkspaceChannel; overflow: boolean; hidden: boolean }[]; hiddenCount: number } {
  const selectedIndex = selectedId === null ? -1 : live.findIndex((channel) => channel.channelId === selectedId);
  const { rows, hiddenCount } = railSlice(live, selectedIndex, expanded);
  return { rows: rows.map(({ row, overflow, hidden }) => ({ channel: row, overflow, hidden })), hiddenCount };
}

/** The same rule over any row type: the rail builder applies it to its own row models. */
export function railSlice<T>(
  live: readonly T[],
  selectedIndex: number,
  expanded: boolean,
): { rows: { row: T; overflow: boolean; hidden: boolean }[]; hiddenCount: number } {
  const slots = CHANNEL_RAIL_ROWS - 1;
  const leading = selectedIndex >= slots ? slots - 1 : slots;
  const rows = live.map((row, index) => ({ row, overflow: index >= leading && index !== selectedIndex }));
  const hiddenCount = rows.filter((entry) => entry.overflow).length;
  return { rows: rows.map((entry) => ({ ...entry, hidden: entry.overflow && !expanded })), hiddenCount };
}

export type WorkspaceRole = "owner" | "admin" | "member";

/**
 * May this viewer change, archive or unarchive this channel? The server's rule, mirrored to decide which
 * actions to SHOW (`applyChannelCommand` answers 403 channel_forbidden otherwise): the person
 * who created it, or a workspace owner or admin. Owning the agent that created it does not
 * count. Archived channels keep the same management rights.
 */
export const mayManageChannel = (
  channel: Pick<WorkspaceChannel, "createdByKind" | "createdByPrincipal" | "archivedAt">,
  viewer: { userId: string | null; role: WorkspaceRole | null },
): boolean => {
  if (viewer.role === "owner" || viewer.role === "admin") return true;
  return channel.createdByKind === "user" && viewer.userId !== null && viewer.userId !== "" &&
    channel.createdByPrincipal === viewer.userId;
};

/**
 * One row of the per-channel read (`channelUnread` in commonswarm.ts): unread, and the viewer's own
 * star and notification level for that channel. The same read carries all three, so the rail and the
 * header are drawn from one answer.
 */
export interface ChannelUnreadState {
  channelId: string | null;
  slug?: string;
  unread: boolean | null;
  starred?: boolean;
  /** The viewer's order among their starred channels; null when not starred. */
  starRank?: number | null;
  involvement?: ChannelInvolvement;
}

/**
 * Unread for one view, exactly as the read reported it. `null` is unknown: no read, a failed
 * read, no row for this channel, or the server's own null. Never derived from anything else.
 */
export const channelUnreadFor = (
  rows: readonly ChannelUnreadState[] | null,
  viewId: string,
): boolean | null => {
  if (rows === null) return null;
  const key = viewId === GENERAL_CHANNEL_ID ? null : viewId;
  const row = rows.find((entry) => entry.channelId === key);
  return row === undefined ? null : row.unread;
};

/**
 * Whether `channel_unread` (which lists every live channel's id and slug on its 15-second
 * cadence) shows a channel created, renamed or archived since `channels` was last read.
 */
export const channelListStaleAgainstUnread = (
  channels: readonly Pick<WorkspaceChannel, "channelId" | "slug" | "archivedAt">[],
  unreadRows: readonly { channelId: string | null; slug: string }[] | null,
): boolean => {
  if (unreadRows === null) return false;
  const live = channels.filter((channel) => channel.archivedAt === null);
  const reported = unreadRows.filter((row): row is { channelId: string; slug: string } => row.channelId !== null);
  if (live.length !== reported.length) return true;
  const byId = new Map(live.map((channel) => [channel.channelId, channel.slug]));
  return reported.some((row) => byId.get(row.channelId) !== row.slug);
};

/** The row's accessible name: the full "#slug", plus "unread" only when the read said so, plus "muted". */
export const channelRowName = (slug: string, unread: boolean | null, muted = false): string =>
  `${channelLabel(slug)}${unread === true ? ", unread" : ""}${muted ? ", muted" : ""}`;

/** The viewer's own settings for one place. */
export interface ChannelPreference { starred: boolean; involvement: ChannelInvolvement }

const unreadKey = (viewId: string): string | null => (viewId === GENERAL_CHANNEL_ID ? null : viewId);
const viewIdOf = (row: Pick<ChannelUnreadState, "channelId">): string => row.channelId ?? GENERAL_CHANNEL_ID;

/**
 * The viewer's star and notification level for one view, as the read reported them. `null` is unknown
 * (no read, a failed read, no row): the header then offers neither control rather than guess a state
 * the next click would overwrite.
 */
export const channelPreferenceFor = (
  rows: readonly ChannelUnreadState[] | null,
  viewId: string,
): ChannelPreference | null => {
  const row = rows?.find((entry) => entry.channelId === unreadKey(viewId));
  if (row === undefined) return null;
  return { starred: row.starred === true, involvement: row.involvement ?? "everything" };
};

/** The view ids the viewer starred, in their own order: by rank, the name breaking a tie. */
export const starredViewIds = (rows: readonly ChannelUnreadState[] | null): string[] =>
  (rows ?? [])
    .filter((row) => row.starred === true)
    .sort((left, right) =>
      (left.starRank ?? Number.MAX_SAFE_INTEGER) - (right.starRank ?? Number.MAX_SAFE_INTEGER) ||
      compareText(left.slug ?? "", right.slug ?? "") || compareText(viewIdOf(left), viewIdOf(right)))
    .map(viewIdOf);

/**
 * The rows as they will read once a change the viewer just made is saved, so the star and the bell
 * answer at once. A newly starred channel goes last, where the server puts it; a muted one is never
 * unread. The next read replaces this with what the server stored.
 */
export const withChannelPreference = <Row extends ChannelUnreadState>(
  rows: readonly Row[],
  viewId: string,
  change: Partial<ChannelPreference>,
): Row[] => {
  const lastRank = Math.max(-1, ...rows.filter((row) => row.starred === true).map((row) => row.starRank ?? -1));
  return rows.map((row) => {
    if (row.channelId !== unreadKey(viewId)) return row;
    const starred = change.starred ?? row.starred === true;
    const involvement = change.involvement ?? row.involvement ?? "everything";
    return {
      ...row,
      starred,
      starRank: !starred ? null : row.starred === true ? row.starRank ?? null : lastRank + 1,
      involvement,
      unread: involvement === "muted" ? false : row.unread,
    };
  });
};

/** `ids` with one entry moved a step earlier or later, or null where it cannot move (an end, or not listed). */
export const movedByStep = <T>(ids: readonly T[], id: T, step: -1 | 1): T[] | null => {
  const from = ids.indexOf(id);
  const to = from + step;
  if (from < 0 || to < 0 || to >= ids.length) return null;
  const next = [...ids];
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
};

/** `ids` with one entry moved to sit just before another (or last, for null); null where nothing would change. */
export const movedBefore = <T>(ids: readonly T[], id: T, before: T | null): T[] | null => {
  if (!ids.includes(id) || id === before || (before !== null && !ids.includes(before))) return null;
  const rest = ids.filter((entry) => entry !== id);
  const at = before === null ? rest.length : rest.indexOf(before);
  const next = [...rest.slice(0, at), id, ...rest.slice(at)];
  return next.every((entry, index) => entry === ids[index]) ? null : next;
};

/**
 * A whole list's order after its visible part was reordered: entries that are not shown (a channel the
 * viewer starred sits under Starred, not in Channels) keep their slots, and the shown ones fill the
 * other slots in their new order.
 */
export const mergedOrder = <T>(full: readonly T[], shown: readonly T[]): T[] => {
  const queue = [...shown];
  return full.map((entry) => (shown.includes(entry) ? queue.shift()! : entry));
};

/** The viewer's stars in a new order, as the rows will read once it is saved. `viewIds` lists them all. */
export const withStarOrder = <Row extends ChannelUnreadState>(rows: readonly Row[], viewIds: readonly string[]): Row[] =>
  rows.map((row) => {
    const at = viewIds.indexOf(viewIdOf(row));
    return at < 0 || row.starred !== true ? row : { ...row, starRank: at };
  });

/** The workspace's channels in a new shared order: the listed ones first, in that order. */
export const withChannelOrder = (channels: readonly WorkspaceChannel[], channelIds: readonly string[]): WorkspaceChannel[] => {
  const rest = liveChannels(channels).map((channel) => channel.channelId).filter((id) => !channelIds.includes(id));
  const order = [...channelIds, ...rest];
  return channels.map((channel) => {
    const at = order.indexOf(channel.channelId);
    return at < 0 ? channel : { ...channel, sortRank: at + 1 };
  });
};

export const MOVE_UP_LABEL = "Move up";
export const MOVE_DOWN_LABEL = "Move down";
/** Read out after a move, so a person who cannot see the rail knows where the channel now sits. */
export const orderAnnouncement = (slug: string, position: number, total: number): string =>
  `${channelLabel(slug)}, ${position} of ${total}`;

export const STARRED_TITLE = "Starred";
/** The star is a toggle button: its name stays, and aria-pressed carries the state. */
export const starChannelLabel = (slug: string): string => `Star ${channelLabel(slug)}`;
export const CHANNEL_NOTIFY_LABEL = "Notifications";
/**
 * What marks a channel unread for the viewer. "Every message" rather than "All messages", which is
 * already the name of the unfiltered view in the same header.
 */
export const CHANNEL_INVOLVEMENT_LABELS: Record<ChannelInvolvement, string> = {
  everything: "Every message",
  mentions: "Mentions only",
  muted: "Muted",
};

/* Who may create channels in a workspace. The values are the server's; these are their names. */
export const CHANNEL_CREATION_TITLE = "Who can create channels";
export const CHANNEL_CREATION_LABELS: Record<ChannelCreationPolicy, string> = {
  members: "Everyone",
  admins: "Owners & admins",
};
export const CHANNEL_CREATION_SAVED = "Saved";
export { CHANNEL_CREATION_POLICIES };

/**
 * The workspace read's policy. A read without the column is the default, `members`. A value this
 * build does not know is `null`: the server has a rule the browser cannot name.
 */
export const parseChannelCreationPolicy = (value: unknown): ChannelCreationPolicy | null =>
  value === undefined || value === null ? "members"
    : (CHANNEL_CREATION_POLICIES as readonly unknown[]).includes(value) ? value as ChannelCreationPolicy
    : null;

/**
 * Whether to offer "New channel" to this person. The server decides on every create; this only
 * keeps the app from offering what it would refuse. Under an unknown policy only an owner or an
 * admin is offered it, since every policy so far lets them.
 */
export const mayCreateChannel = (
  policy: ChannelCreationPolicy | null | undefined,
  role: string | null | undefined,
): boolean => policy === "members" || policy === undefined || role === "owner" || role === "admin";

/* Visible copy (Channels C1 spec, "Visible copy inventory"). */
export const CHANNELS_TITLE = "Channels";
export const NEW_CHANNEL_LABEL = "New channel";
export const RENAME_CHANNEL_LABEL = "Rename channel";
export const CHANNEL_SETTINGS_LABEL = "Channel settings";
export const UNARCHIVE_CHANNEL_LABEL = "Unarchive channel";
export const ALL_CHANNELS_LABEL = "All channels";
export const ARCHIVE_CHANNEL_LABEL = "Archive channel";
export const ARCHIVED_CHANNELS_LABEL = "Archived channels";
export const CHANNEL_UNAVAILABLE_TITLE = "Channel unavailable";
export const GO_TO_GENERAL_LABEL = `Go to ${channelLabel(GENERAL_CHANNEL_SLUG)}`;
export const CHANNELS_LOAD_FAILED = "Couldn’t load channels";
export const CHANNEL_ARCHIVED_STATE = "Archived";
export const ARCHIVE_CHANNEL_CONSEQUENCE = "Messages stay available. New messages stop.";
export const archiveChannelTitle = (slug: string): string => `Archive ${channelLabel(slug)}?`;

/**
 * The refusal a reader sees. The server's own `message` is used whenever it
 * sent one, and it is NEVER parsed: D-053 says a message is presentation, so
 * this reads `body.message` as text to show and branches only on the numeric
 * status when the server sent no message at all.
 */
export const channelRefusalMessage = (
  status: number,
  body: Record<string, unknown>,
  fallback: string,
): string => {
  const message = body.message;
  if (typeof message === "string" && message.trim() !== "") return message;
  return `${fallback} (HTTP ${status}). Nothing was changed.`;
};

/**
 * The slug a caller may send, or the refusal to show instead. The edge runs the
 * same function on the same normalized value, so a name this accepts is refused
 * by the server only for a reason the browser cannot know (a name already
 * taken), never for its spelling.
 */
export const channelSubmitProblem = (raw: string): string | null =>
  channelSlugProblem(raw);

/** Trim to what the edge stores, so a preview cannot promise a different name. */
export const channelSubmitSlug = (raw: string): string =>
  normalizeChannelSlug(raw);

/**
 * Longest slug the input accepts. The edge measures the NORMALIZED value, so a
 * trailing space is not part of the bound; the attribute is the bound itself
 * and the validator still has the last word.
 */
export const channelSlugInputMax = (): number => CHANNEL_SLUG_MAX;
export const channelPurposeInputMax = (): number => CHANNEL_PURPOSE_MAX;
