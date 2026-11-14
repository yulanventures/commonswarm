/** Reached by `npm --prefix site test` through the src/lib/*.test.mjs glob. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  GENERAL_CHANNEL_ID,
  RESERVED_CHANNEL_SLUGS,
  channelListStaleAgainstUnread,
  channelRowName,
  channelSignalFilter,
  channelUnreadFor,
  channelViewLabel,
  channelViewOf,
  composerChannelFor,
  liveChannels,
  archivedChannels,
  mayManageChannel,
  railChannelSlice,
  resolveChannelParam,
  signalInChannelView,
  ALL_MESSAGES_LABEL,
  CHANNEL_INVOLVEMENT_LABELS,
  CHANNEL_INVOLVEMENT_LEVELS,
  channelPreferenceFor,
  starChannelLabel,
  starredViewIds,
  withChannelPreference,
  movedBefore,
  movedByStep,
  orderAnnouncement,
  withChannelOrder,
  withStarOrder,
} from "./channels.ts";
import { parseRoute, routeHref } from "./home-route.ts";

const channel = (channelId, slug, extra = {}) => ({
  channelId, workspaceId: "w", slug, purpose: null, createdByPrincipal: "creator",
  createdByKind: "user", createdAt: "2026-11-01T00:00:00Z", archivedAt: null, ...extra,
});
const UUID = "6f1c2b8e-0000-4000-8000-000000000001";

test("general is reserved on the server, so the virtual view cannot shadow a real channel", () => {
  assert.ok(RESERVED_CHANNEL_SLUGS.includes("general"));
});

test("All messages, #general and a named channel are three views with three queries", () => {
  assert.deepEqual(channelViewOf(null), { kind: "all" });
  assert.deepEqual(channelViewOf(GENERAL_CHANNEL_ID), { kind: "general" });
  assert.deepEqual(channelViewOf(UUID), { kind: "channel", channelId: UUID });
  assert.deepEqual(channelSignalFilter(null), { kind: "none" });
  assert.deepEqual(channelSignalFilter(GENERAL_CHANNEL_ID), { kind: "unfiled" });
  assert.deepEqual(channelSignalFilter(UUID), { kind: "channel", channelId: UUID });

  // A filed message: in All messages and in its channel, never in #general.
  assert.equal(signalInChannelView(UUID, null), true);
  assert.equal(signalInChannelView(UUID, UUID), true);
  assert.equal(signalInChannelView(UUID, GENERAL_CHANNEL_ID), false);
  // An unfiled message: in All messages and #general, never in a named channel.
  assert.equal(signalInChannelView(null, null), true);
  assert.equal(signalInChannelView(null, GENERAL_CHANNEL_ID), true);
  assert.equal(signalInChannelView(null, UUID), false);
});

test("links: ?c=general is #general, no ?c is All messages, a channel keeps its id across a rename", () => {
  const list = [channel(UUID, "design")];
  assert.deepEqual(parseRoute("?w=ws&c=general"), { view: "chat", workspaceId: "ws", channelId: "general" });
  assert.equal(routeHref({ view: "chat", workspaceId: "ws", channelId: GENERAL_CHANNEL_ID }), "/app?w=ws&c=general");
  assert.equal(routeHref({ view: "chat", workspaceId: "ws" }), "/app?w=ws");
  assert.deepEqual(resolveChannelParam("general", list), { activeChannelId: GENERAL_CHANNEL_ID, unknownChannelId: null });
  assert.deepEqual(resolveChannelParam(null, list), { activeChannelId: null, unknownChannelId: null });
  assert.deepEqual(resolveChannelParam("", list), { activeChannelId: null, unknownChannelId: null });
  assert.deepEqual(resolveChannelParam(UUID, [channel(UUID, "renamed")]), { activeChannelId: UUID, unknownChannelId: null });
  // An id this workspace does not have stays unresolved, never #general or All messages.
  assert.deepEqual(resolveChannelParam("not-here", list), { activeChannelId: null, unknownChannelId: "not-here" });
  // An archived channel still resolves (its messages stay readable).
  assert.deepEqual(resolveChannelParam(UUID, [channel(UUID, "old", { archivedAt: "2026-11-02T00:00:00Z" })]),
    { activeChannelId: UUID, unknownChannelId: null });
});

test("composer placement: #general and All messages post unfiled; archived or unknown posts nowhere", () => {
  const list = [channel(UUID, "design"), channel("archived", "old", { archivedAt: "2026-11-02T00:00:00Z" })];
  assert.equal(composerChannelFor(GENERAL_CHANNEL_ID, list), null);
  assert.equal(composerChannelFor(null, list), null);
  assert.equal(composerChannelFor(UUID, list), UUID);
  assert.equal(composerChannelFor("archived", list), undefined);
  assert.equal(composerChannelFor("missing", list), undefined);
  assert.equal(channelViewLabel(null, list), "All messages");
  assert.equal(channelViewLabel(GENERAL_CHANNEL_ID, list), "#general");
  assert.equal(channelViewLabel(UUID, list), "#design");
  assert.equal(channelViewLabel("missing", list), null);
});

test("only the creator or a workspace owner or admin manages active and archived channels", () => {
  const byPerson = channel(UUID, "design", { createdByKind: "user", createdByPrincipal: "u-1" });
  const byAgent = channel(UUID, "design", { createdByKind: "agent", createdByPrincipal: "agent-1" });
  assert.equal(mayManageChannel(byPerson, { userId: "u-1", role: "member" }), true);
  assert.equal(mayManageChannel(byPerson, { userId: "u-2", role: "member" }), false);
  assert.equal(mayManageChannel(byPerson, { userId: "u-2", role: "admin" }), true);
  assert.equal(mayManageChannel(byPerson, { userId: "u-2", role: "owner" }), true);
  assert.equal(mayManageChannel(byPerson, { userId: "u-2", role: null }), false);
  // Owning the agent that created it does not count, even when an id happens to match.
  assert.equal(mayManageChannel(byAgent, { userId: "agent-1", role: "member" }), false);
  assert.equal(mayManageChannel(byAgent, { userId: "u-1", role: "admin" }), true);
  assert.equal(mayManageChannel(channel(UUID, "x", { createdByPrincipal: "" }), { userId: "", role: "member" }), false);
  // Archiving preserves those rights, including editing and unarchiving.
  const archived = { ...byPerson, archivedAt: "2026-11-02T00:00:00Z" };
  assert.equal(mayManageChannel(archived, { userId: "u-1", role: "member" }), true);
  assert.equal(mayManageChannel(archived, { userId: "u-2", role: "admin" }), true);
  assert.equal(mayManageChannel(archived, { userId: "u-2", role: "member" }), false);
});

test("unread keeps true, false and unknown apart and never invents a value", () => {
  const rows = [
    { channelId: null, unread: true },
    { channelId: UUID, unread: false },
    { channelId: "unknown", unread: null },
  ];
  assert.equal(channelUnreadFor(rows, GENERAL_CHANNEL_ID), true);
  assert.equal(channelUnreadFor(rows, UUID), false);
  assert.equal(channelUnreadFor(rows, "unknown"), null);
  assert.equal(channelUnreadFor(rows, "not-reported"), null);
  assert.equal(channelUnreadFor(null, GENERAL_CHANNEL_ID), null);
  assert.equal(channelUnreadFor([], UUID), null);
  assert.equal(channelRowName("design", true), "#design, unread");
  assert.equal(channelRowName("design", false), "#design");
  assert.equal(channelRowName("design", null), "#design");
});

test("ordering is by slug with the id breaking a tie; archived rows are listed apart", () => {
  const list = [
    channel("b", "ops"), channel("a", "ops"), channel("c", "design"),
    channel("z", "archive-me", { archivedAt: "2026-11-02T00:00:00Z" }),
  ];
  assert.deepEqual(liveChannels(list).map((row) => row.channelId), ["c", "a", "b"]);
  assert.deepEqual(archivedChannels(list).map((row) => row.channelId), ["z"]);
});

test("the compact rail shows five named rows and keeps a selected overflow channel in order", () => {
  const live = liveChannels(Array.from({ length: 9 }, (_, index) => channel(`id-${index}`, `c${index}`)));
  const shown = (slice) => slice.rows.filter((row) => !row.hidden).map((row) => row.channel.channelId);

  const compact = railChannelSlice(live, null, false);
  assert.deepEqual(shown(compact), ["id-0", "id-1", "id-2", "id-3", "id-4"]);
  assert.equal(compact.hiddenCount, 4);

  const selectedLate = railChannelSlice(live, "id-7", false);
  assert.deepEqual(shown(selectedLate), ["id-0", "id-1", "id-2", "id-3", "id-7"]);
  assert.equal(selectedLate.hiddenCount, 4);

  const selectedEarly = railChannelSlice(live, "id-2", false);
  assert.deepEqual(shown(selectedEarly), ["id-0", "id-1", "id-2", "id-3", "id-4"]);

  // #general (or no selection in the list) changes nothing.
  assert.deepEqual(shown(railChannelSlice(live, GENERAL_CHANNEL_ID, false)), shown(compact));

  const expanded = railChannelSlice(live, "id-7", true);
  assert.equal(shown(expanded).length, 9);
  assert.equal(expanded.hiddenCount, 4);

  const few = railChannelSlice(live.slice(0, 3), null, false);
  assert.equal(few.hiddenCount, 0);
  assert.equal(shown(few).length, 3);
  assert.equal(railChannelSlice([], null, false).hiddenCount, 0);
});

test("channelListStaleAgainstUnread detects channels created, renamed or archived by others", () => {
  const list = [
    channel(UUID, "design"),
    channel("archived-id", "old", { archivedAt: "2026-11-02T00:00:00Z" }),
  ];
  assert.equal(channelListStaleAgainstUnread(list, null), false);
  assert.equal(
    channelListStaleAgainstUnread(list, [
      { channelId: null, slug: "general" },
      { channelId: UUID, slug: "design" },
    ]),
    false,
  );
  // Another member created a channel:
  assert.equal(
    channelListStaleAgainstUnread(list, [
      { channelId: null, slug: "general" },
      { channelId: UUID, slug: "design" },
      { channelId: "new-id", slug: "ops" },
    ]),
    true,
  );
  // Another member renamed a channel:
  assert.equal(
    channelListStaleAgainstUnread(list, [
      { channelId: null, slug: "general" },
      { channelId: UUID, slug: "design-v2" },
    ]),
    true,
  );
  // Another member archived a channel:
  assert.equal(
    channelListStaleAgainstUnread(list, [{ channelId: null, slug: "general" }]),
    true,
  );
});

test("rail DM rows (.hm-rail__person, .hm-rail__agent) keep 44px targets alongside channel rows at every width", async () => {
  const css = await readFile(new URL("../styles/kylon-layout/integration.css", import.meta.url), "utf8");
  assert.match(
    css,
    /\.cs-org-shell\s+:is\(\.hm-rail__link,\s*\.hm-rail__more,\s*\.hm-rail__person,\s*\.hm-rail__agent\)\s*\{\s*min-block-size:\s*44px;/,
  );
  assert.doesNotMatch(
    css,
    /\.cs-org-shell\s+:is\([^)]*\.hm-rail__(?:person|agent)[^)]*\)\s*\{\s*min-block-size:\s*3[06]px;/,
  );
});

const PREFERENCE_ROWS = [
  { channelId: null, slug: "general", unread: true, starred: true, starRank: 2, involvement: "everything" },
  { channelId: "c-ops", slug: "ops", unread: true, starred: true, starRank: 0, involvement: "mentions" },
  { channelId: "c-design", slug: "design", unread: true, starred: false, starRank: null, involvement: "everything" },
  { channelId: "c-arch", slug: "arch", unread: null, starred: true, starRank: 2, involvement: "muted" },
];

test("a channel's star and notification level are read from its own row, and unknown stays unknown", () => {
  assert.deepEqual(channelPreferenceFor(PREFERENCE_ROWS, "general"), { starred: true, involvement: "everything" });
  assert.deepEqual(channelPreferenceFor(PREFERENCE_ROWS, "c-ops"), { starred: true, involvement: "mentions" });
  assert.deepEqual(channelPreferenceFor(PREFERENCE_ROWS, "c-design"), { starred: false, involvement: "everything" });
  assert.equal(channelPreferenceFor(PREFERENCE_ROWS, "c-gone"), null);
  assert.equal(channelPreferenceFor(null, "general"), null);
  // A row from a read that carried no settings is the defaults, not an error.
  assert.deepEqual(channelPreferenceFor([{ channelId: "c1", unread: false }], "c1"), { starred: false, involvement: "everything" });
});

test("starred places come in the viewer's order: rank, then name, #general among them", () => {
  assert.deepEqual(starredViewIds(PREFERENCE_ROWS), ["c-ops", "c-arch", "general"]);
  assert.deepEqual(starredViewIds(null), []);
  assert.deepEqual(starredViewIds(PREFERENCE_ROWS.map((row) => ({ ...row, starred: false }))), []);
});

test("a change the viewer just made shows at once: a new star goes last, and a muted channel is never unread", () => {
  const starred = withChannelPreference(PREFERENCE_ROWS, "c-design", { starred: true });
  assert.deepEqual(starredViewIds(starred), ["c-ops", "c-arch", "general", "c-design"]);
  assert.equal(starred.find((row) => row.channelId === "c-design").unread, true, "starring changes nothing else");
  assert.deepEqual(starredViewIds(withChannelPreference(PREFERENCE_ROWS, "general", { starred: false })), ["c-ops", "c-arch"]);
  assert.deepEqual(starredViewIds(withChannelPreference(PREFERENCE_ROWS, "c-ops", { starred: true })), ["c-ops", "c-arch", "general"],
    "starring what is already starred keeps its place");

  const muted = withChannelPreference(PREFERENCE_ROWS, "c-design", { involvement: "muted" });
  assert.deepEqual(channelPreferenceFor(muted, "c-design"), { starred: false, involvement: "muted" });
  assert.equal(muted.find((row) => row.channelId === "c-design").unread, false);
  assert.equal(muted.find((row) => row.channelId === "c-ops").unread, true, "other channels are untouched");
  const unmuted = withChannelPreference(muted, "c-design", { involvement: "everything" });
  assert.equal(unmuted.find((row) => row.channelId === "c-design").unread, false,
    "unmuting does not invent an unread mark; the next read says");
  assert.deepEqual(withChannelPreference(PREFERENCE_ROWS, "c-gone", { starred: true }), PREFERENCE_ROWS);
});

test("a muted row says so, and each notification level has one plain name", () => {
  assert.equal(channelRowName("design", false, true), "#design, muted");
  assert.equal(channelRowName("design", true, false), "#design, unread");
  assert.deepEqual(Object.keys(CHANNEL_INVOLVEMENT_LABELS), [...CHANNEL_INVOLVEMENT_LEVELS],
    "every level the server accepts has a name, in the server's order");
  assert.equal(new Set(Object.values(CHANNEL_INVOLVEMENT_LABELS)).size, CHANNEL_INVOLVEMENT_LEVELS.length);
  assert.ok(!Object.values(CHANNEL_INVOLVEMENT_LABELS).includes(ALL_MESSAGES_LABEL),
    "no level shares the unfiltered view's name");
  assert.equal(starChannelLabel("design"), "Star #design");
});

const ordered = (slug, sortRank, extra = {}) => ({ channelId: `c-${slug}`, workspaceId: "w", slug, purpose: null,
  createdByPrincipal: "u", createdByKind: "user", createdAt: "", archivedAt: null, sortRank, ...extra });

test("placed channels come first in the shared order; the rest follow by name, a new one at the end", () => {
  const list = [ordered("zeta", 1), ordered("alpha", 0), ordered("mid", 3), ordered("beta", undefined), ordered("early", 2)];
  assert.deepEqual(liveChannels(list).map((channel) => channel.slug), ["zeta", "early", "mid", "alpha", "beta"]);
  assert.deepEqual(liveChannels([ordered("b", 0), ordered("a", 0)]).map((channel) => channel.slug), ["a", "b"],
    "a workspace nobody has ordered stays alphabetical");
  assert.deepEqual(liveChannels([ordered("b", 2), ordered("a", 2)]).map((channel) => channel.slug), ["a", "b"], "a tie falls to the name");
});

test("a step moves one entry and nothing else, and refuses at either end", () => {
  assert.deepEqual(movedByStep(["a", "b", "c"], "b", -1), ["b", "a", "c"]);
  assert.deepEqual(movedByStep(["a", "b", "c"], "b", 1), ["a", "c", "b"]);
  assert.equal(movedByStep(["a", "b", "c"], "a", -1), null);
  assert.equal(movedByStep(["a", "b", "c"], "c", 1), null);
  assert.equal(movedByStep(["a", "b"], "x", 1), null);
});

test("a drop places an entry just before another, or last, and says when nothing changed", () => {
  assert.deepEqual(movedBefore(["a", "b", "c", "d"], "d", "b"), ["a", "d", "b", "c"]);
  assert.deepEqual(movedBefore(["a", "b", "c", "d"], "a", null), ["b", "c", "d", "a"]);
  assert.deepEqual(movedBefore(["a", "b", "c"], "a", "c"), ["b", "a", "c"]);
  assert.equal(movedBefore(["a", "b", "c"], "a", "b"), null, "already just before it");
  assert.equal(movedBefore(["a", "b", "c"], "c", null), null, "already last");
  assert.equal(movedBefore(["a", "b"], "a", "a"), null);
  assert.equal(movedBefore(["a", "b"], "x", "a"), null);
  assert.equal(movedBefore(["a", "b"], "a", "x"), null);
});

test("a new star order and a new shared order show at once", () => {
  const starred = withStarOrder(PREFERENCE_ROWS, ["general", "c-arch", "c-ops"]);
  assert.deepEqual(starredViewIds(starred), ["general", "c-arch", "c-ops"]);
  assert.equal(starred.find((row) => row.channelId === "c-design").starRank, null, "an unstarred row gains no rank");

  const list = [ordered("alpha", 0), ordered("beta", 0), ordered("gamma", 0), ordered("old", 0, { archivedAt: "2026-01-01" })];
  const next = withChannelOrder(list, ["c-gamma", "c-alpha"]);
  assert.deepEqual(liveChannels(next).map((channel) => channel.slug), ["gamma", "alpha", "beta"],
    "the named channels lead, and the ones left out follow in their old order");
  assert.equal(next.find((channel) => channel.slug === "old").sortRank, 0, "an archived channel is not placed");
  assert.equal(orderAnnouncement("design", 2, 5), "#design, 2 of 5");
});
