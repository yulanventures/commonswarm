/** Reached by `npm --prefix site test` through the src/lib/*.test.mjs glob. */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GENERAL_CHANNEL_ID,
  RESERVED_CHANNEL_SLUGS,
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

test("only the creator or a workspace owner or admin sees rename and archive", () => {
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
  // Archive is one-way: an archived channel has nothing to manage.
  assert.equal(mayManageChannel({ ...byPerson, archivedAt: "2026-11-02T00:00:00Z" }, { userId: "u-1", role: "owner" }), false);
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
