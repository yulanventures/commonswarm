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
  CHANNEL_PURPOSE_MAX,
  CHANNEL_SLUG_MAX,
  CHANNEL_SLUG_RULE_TEXT,
  RESERVED_CHANNEL_SLUG_TEXT,
  RESERVED_CHANNEL_SLUGS,
  channelSlugProblem,
  isReservedChannelSlug,
  normalizeChannelSlug,
} from "../../../supabase/functions/_shared/channels.js";

export {
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
const compareChannels = (left: WorkspaceChannel, right: WorkspaceChannel): number =>
  compareText(left.slug, right.slug) || compareText(left.channelId, right.channelId);

/** Live channels only, in the order a reader scans them: by slug, the id breaking a tie. */
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
 * May this viewer rename or archive this channel? The server's rule, mirrored to decide which
 * actions to SHOW (`applyChannelCommand` answers 403 channel_forbidden otherwise): the person
 * who created it, or a workspace owner or admin. Owning the agent that created it does not
 * count. An archived channel has no actions (archive is one-way).
 */
export const mayManageChannel = (
  channel: Pick<WorkspaceChannel, "createdByKind" | "createdByPrincipal" | "archivedAt">,
  viewer: { userId: string | null; role: WorkspaceRole | null },
): boolean => {
  if (channel.archivedAt !== null) return false;
  if (viewer.role === "owner" || viewer.role === "admin") return true;
  return channel.createdByKind === "user" && viewer.userId !== null && viewer.userId !== "" &&
    channel.createdByPrincipal === viewer.userId;
};

/** One row of the per-channel unread read (`channelUnread` in commonswarm.ts). */
export interface ChannelUnreadState { channelId: string | null; unread: boolean | null }

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

/** The row's accessible name: the full "#slug", plus "unread" only when the read said so. */
export const channelRowName = (slug: string, unread: boolean | null): string =>
  `${channelLabel(slug)}${unread === true ? ", unread" : ""}`;

/* Visible copy (Channels C1 spec, "Visible copy inventory"). */
export const CHANNELS_TITLE = "Channels";
export const NEW_CHANNEL_LABEL = "New channel";
export const RENAME_CHANNEL_LABEL = "Rename channel";
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
