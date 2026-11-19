import assert from "node:assert/strict";
import { test } from "node:test";
import { GENERAL_CHANNEL_ID } from "./channels.ts";
import { CONVERSATION_UNAVAILABLE_TEXT, DM_ATTACHMENTS_REFUSAL_TEXT } from "./conversations.ts";
import {
  applyConversationHistoryInitial,
  applyConversationHistoryOlder,
  applyConversationHistoryRefresh,
  clearConversationDraftStorage,
  compareSignalsDesc,
  conversationDraftStorageKey,
  createConversationHistoryState,
  directConversationSendRefusal,
  excludeDirectConversationRows,
  isDirectConversationRow,
  resolveActiveConversationHistoryTarget,
} from "./conversation-history.ts";
import { browserSignalCommand } from "./commonswarm.ts";

const ws = "11111111-1111-4111-8111-111111111111";
const viewer = "33333333-3333-4333-8333-333333333333";
const peerAlex = "dddd4444-4444-4444-8444-444444444444";
const peerLead = "eeee5555-5555-4555-8555-555555555555";
const generalConvId = "99990000-0000-4000-8000-000000000001";
const opsChannelId = "66666666-6666-4666-8666-666666666666";
const opsConvId = "99990000-0000-4000-8000-000000000002";
const dmConvId = "aaaa1111-1111-4111-8111-111111111111";
const groupConvId = "bbbb2222-2222-4222-8222-222222222222";
const notesConvId = "cccc4444-4444-4444-8444-444444444444";

const makeConv = (overrides) => ({
  conversationId: groupConvId,
  kind: "group_dm",
  channelId: null,
  slug: null,
  description: null,
  archivedAt: null,
  joined: true,
  generation: 1,
  members: [
    { kind: "user", id: viewer, name: "Owner", leftAt: null },
    { kind: "user", id: peerAlex, name: "Alex", leftAt: null },
    { kind: "agent", id: peerLead, name: "Lead", leftAt: null },
  ],
  notifyLevel: "everything",
  starred: false,
  starRank: null,
  unreadCount: 0,
  mentionCount: 0,
  lastMessageAt: "2026-11-19T16:00:00Z",
  lastMessageId: null,
  ...overrides,
});

const makeRow = (id, createdAt, overrides = {}) => ({
  id,
  createdAt,
  body: `Body ${id}`,
  channelId: null,
  to: null,
  toAgent: null,
  ...overrides,
});

const workspaceConvs = [
  makeConv({ conversationId: generalConvId, kind: "general", slug: "general", members: [] }),
  makeConv({ conversationId: opsConvId, kind: "public_channel", channelId: opsChannelId, slug: "ops" }),
  makeConv({
    conversationId: dmConvId,
    kind: "dm",
    members: [
      { kind: "user", id: viewer, name: "Owner", leftAt: null },
      { kind: "user", id: peerAlex, name: "Alex", leftAt: null },
    ],
  }),
  makeConv({ conversationId: groupConvId, kind: "group_dm" }),
  makeConv({
    conversationId: notesConvId,
    kind: "dm",
    members: [{ kind: "user", id: viewer, name: "Owner", leftAt: null }],
  }),
];

test("initial + older + refresh cursor merges dedupe by id, sort DESC, and preserve older pages", () => {
  const initial0 = createConversationHistoryState(ws, viewer, groupConvId);
  const groupConv = makeConv();
  const s1 = applyConversationHistoryInitial(
    initial0,
    {
      ok: true,
      conversation: groupConv,
      messages: [
        makeRow("sig-2", "2026-11-19T15:02:00Z", { body: "Server sig-2" }),
        makeRow("sig-3", "2026-11-19T15:03:00Z"),
      ],
      hasMore: true,
      nextBefore: { createdAt: "2026-11-19T15:02:00Z", id: "sig-2" },
      nextAfter: { createdAt: "2026-11-19T15:03:00Z", id: "sig-3" },
    },
    [
      makeRow("sig-2", "2026-11-19T15:02:00Z", { body: "Optimistic sig-2", conversationId: groupConvId }),
      makeRow("sig-4", "2026-11-19T15:04:00Z", { body: "Optimistic sig-4", conversationId: groupConvId }),
      makeRow("other-conv", "2026-11-19T15:05:00Z", { conversationId: opsConvId }),
    ],
  );
  assert.equal(s1.status, "ready");
  assert.deepEqual(s1.rows.map((r) => r.id), ["sig-4", "sig-3", "sig-2"]);
  assert.equal(s1.rows.find((r) => r.id === "sig-2")?.body, "Server sig-2", "server row wins on duplicate id");
  assert.equal(s1.rows[0]?.conversationId, groupConvId);
  assert.equal(s1.hasMore, true);

  // Older page fails transiently -> loaded rows and nextBefore stay intact for Retry.
  const sErr = applyConversationHistoryOlder(s1, {
    ok: false,
    code: "other",
    message: "Network hiccup",
  });
  assert.equal(sErr.olderError, "Network hiccup");
  assert.deepEqual(sErr.rows.map((r) => r.id), ["sig-4", "sig-3", "sig-2"]);
  assert.deepEqual(sErr.nextBefore, { createdAt: "2026-11-19T15:02:00Z", id: "sig-2" });

  // Retry succeeds -> older rows append, nextBefore clears when hasMore is false.
  const s2 = applyConversationHistoryOlder(sErr, {
    ok: true,
    conversation: groupConv,
    messages: [
      makeRow("sig-1", "2026-11-19T15:01:00Z"),
      makeRow("sig-2", "2026-11-19T15:02:00Z", { body: "Server sig-2" }),
    ],
    hasMore: false,
    nextBefore: null,
    nextAfter: null,
  });
  assert.equal(s2.olderError, "");
  assert.equal(s2.hasMore, false);
  assert.equal(s2.nextBefore, null);
  assert.deepEqual(s2.rows.map((r) => r.id), ["sig-4", "sig-3", "sig-2", "sig-1"]);

  // Live refresh adds sig-5 while preserving older paged row sig-1.
  const refreshed = applyConversationHistoryRefresh(s2, {
    ok: true,
    conversation: groupConv,
    messages: [makeRow("sig-5", "2026-11-19T15:05:00Z")],
    hasMore: false,
    nextBefore: null,
    nextAfter: { createdAt: "2026-11-19T15:05:00Z", id: "sig-5" },
  });
  assert.equal(refreshed.changed, true);
  assert.equal(refreshed.lostAccess, false);
  assert.deepEqual(refreshed.state.rows.map((r) => r.id), ["sig-5", "sig-4", "sig-3", "sig-2", "sig-1"]);
  assert.deepEqual(refreshed.state.nextAfter, { createdAt: "2026-11-19T15:05:00Z", id: "sig-5" });
});

test("404 conversation_not_found yields uniform unavailable state and wipes rows & cursors across initial, older, and refresh", () => {
  const notFound = { ok: false, code: "conversation_not_found", message: CONVERSATION_UNAVAILABLE_TEXT };
  const sInit = applyConversationHistoryInitial(createConversationHistoryState(ws, viewer, groupConvId), notFound);
  assert.equal(sInit.status, "unavailable");
  assert.equal(sInit.errorMessage, CONVERSATION_UNAVAILABLE_TEXT);
  assert.deepEqual(sInit.rows, []);
  assert.equal(sInit.nextBefore, null);

  const loaded = applyConversationHistoryInitial(createConversationHistoryState(ws, viewer, groupConvId), {
    ok: true,
    conversation: makeConv(),
    messages: [makeRow("sig-1", "2026-11-19T15:01:00Z")],
    hasMore: true,
    nextBefore: { createdAt: "2026-11-19T15:01:00Z", id: "sig-1" },
    nextAfter: { createdAt: "2026-11-19T15:01:00Z", id: "sig-1" },
  });
  const sOlder404 = applyConversationHistoryOlder(loaded, notFound);
  assert.equal(sOlder404.status, "unavailable");
  assert.deepEqual(sOlder404.rows, []);
  assert.equal(sOlder404.nextBefore, null);
  assert.equal(sOlder404.conversation, null);

  const sRefresh404 = applyConversationHistoryRefresh(loaded, notFound);
  assert.equal(sRefresh404.lostAccess, true);
  assert.equal(sRefresh404.changed, true);
  assert.equal(sRefresh404.state.status, "unavailable");
  assert.deepEqual(sRefresh404.state.rows, []);
  assert.equal(sRefresh404.state.nextAfter, null);
});

test("strict #general and All messages DM exclusion blocks dm and group_dm rows by conversationId, kind, or unfiled recipient", () => {
  const rows = [
    makeRow("gen-1", "2026-11-19T15:05:00Z", { channelId: null, conversationId: generalConvId, conversationKind: "general" }),
    makeRow("ops-1", "2026-11-19T15:04:00Z", { channelId: opsChannelId, conversationId: opsConvId, conversationKind: "public_channel" }),
    makeRow("dm-1", "2026-11-19T15:03:00Z", { channelId: null, conversationId: dmConvId, to: peerAlex }),
    makeRow("grp-1", "2026-11-19T15:02:00Z", { channelId: null, conversationId: groupConvId }),
    makeRow("legacy-dm", "2026-11-19T15:01:00Z", { channelId: null, to: peerAlex }),
    makeRow("kind-dm", "2026-11-19T15:00:00Z", { channelId: null, conversationKind: "group_dm" }),
  ];
  assert.equal(isDirectConversationRow(rows[0], workspaceConvs), false);
  assert.equal(isDirectConversationRow(rows[1], workspaceConvs), false);
  assert.equal(isDirectConversationRow(rows[2], workspaceConvs), true);
  assert.equal(isDirectConversationRow(rows[3], workspaceConvs), true);
  assert.equal(isDirectConversationRow(rows[4], workspaceConvs), true);
  assert.equal(isDirectConversationRow(rows[5], workspaceConvs), true);

  const inGeneral = excludeDirectConversationRows(rows, workspaceConvs, GENERAL_CHANNEL_ID);
  assert.deepEqual(inGeneral.map((r) => r.id), ["gen-1"]);

  const inAll = excludeDirectConversationRows(rows, workspaceConvs, null);
  assert.deepEqual(inAll.map((r) => r.id), ["gen-1", "ops-1"]);
});

test("resolveActiveConversationHistoryTarget routes ?dm=, #general, channels, All messages, and legacy fallback", () => {
  assert.deepEqual(
    resolveActiveConversationHistoryTarget({
      workspaceConversations: workspaceConvs,
      activeDmConversationId: "unknown-dm-uuid",
      activeDm: null,
      activeChannelId: null,
      unknownChannelId: null,
      viewerUserId: viewer,
    }),
    { mode: "conversation", conversationId: "unknown-dm-uuid", isDm: true, kind: null },
  );
  assert.deepEqual(
    resolveActiveConversationHistoryTarget({
      workspaceConversations: workspaceConvs,
      activeDmConversationId: null,
      activeDm: null,
      activeChannelId: GENERAL_CHANNEL_ID,
      unknownChannelId: null,
      viewerUserId: viewer,
    }),
    { mode: "conversation", conversationId: generalConvId, isDm: false, kind: "general" },
  );
  assert.deepEqual(
    resolveActiveConversationHistoryTarget({
      workspaceConversations: workspaceConvs,
      activeDmConversationId: null,
      activeDm: null,
      activeChannelId: opsChannelId,
      unknownChannelId: null,
      viewerUserId: viewer,
    }),
    { mode: "conversation", conversationId: opsConvId, isDm: false, kind: "public_channel" },
  );
  assert.deepEqual(
    resolveActiveConversationHistoryTarget({
      workspaceConversations: workspaceConvs,
      activeDmConversationId: null,
      activeDm: null,
      activeChannelId: null,
      unknownChannelId: null,
      viewerUserId: viewer,
    }),
    { mode: "all-signals" },
  );
  assert.deepEqual(
    resolveActiveConversationHistoryTarget({
      workspaceConversations: null,
      activeDmConversationId: null,
      activeDm: null,
      activeChannelId: GENERAL_CHANNEL_ID,
      unknownChannelId: null,
      viewerUserId: viewer,
    }),
    { mode: "legacy" },
  );
});

test("directConversationSendRefusal allows 1:1 DM, Notes to self, and group DM without attachments and fails closed on attachments or unavailable state", () => {
  const dmConv = workspaceConvs[2];
  const groupConv = workspaceConvs[3];
  const notesConv = workspaceConvs[4];

  assert.equal(
    directConversationSendRefusal({
      activeDmConversationId: dmConvId,
      activeDm: { kind: "person", id: peerAlex },
      conversation: dmConv,
      historyStatus: "ready",
      hasAttachments: false,
    }),
    null,
  );
  assert.equal(
    directConversationSendRefusal({
      activeDmConversationId: groupConvId,
      activeDm: null,
      conversation: groupConv,
      historyStatus: "ready",
      hasAttachments: false,
    }),
    null,
  );
  assert.equal(
    directConversationSendRefusal({
      activeDmConversationId: notesConvId,
      activeDm: null,
      conversation: notesConv,
      historyStatus: "ready",
      hasAttachments: false,
    }),
    null,
  );
  assert.equal(
    directConversationSendRefusal({
      activeDmConversationId: groupConvId,
      activeDm: null,
      conversation: groupConv,
      historyStatus: "ready",
      hasAttachments: true,
    }),
    DM_ATTACHMENTS_REFUSAL_TEXT,
  );
  assert.equal(
    directConversationSendRefusal({
      activeDmConversationId: groupConvId,
      activeDm: null,
      conversation: groupConv,
      historyStatus: "unavailable",
      hasAttachments: false,
    }),
    CONVERSATION_UNAVAILABLE_TEXT,
  );
  assert.equal(
    directConversationSendRefusal({
      activeDmConversationId: groupConvId,
      activeDm: null,
      conversation: null,
      historyStatus: "ready",
      hasAttachments: false,
    }),
    CONVERSATION_UNAVAILABLE_TEXT,
  );
  assert.equal(
    directConversationSendRefusal({
      activeDmConversationId: groupConvId,
      activeDm: null,
      conversation: { ...groupConv, joined: false },
      historyStatus: "ready",
      hasAttachments: false,
    }),
    CONVERSATION_UNAVAILABLE_TEXT,
  );
});

test("compareSignalsDesc breaks timestamp ties by id DESC and clearConversationDraftStorage removes only that conversation key", () => {
  const sorted = [
    makeRow("a", "2026-11-19T15:00:00Z"),
    makeRow("b", "2026-11-19T15:00:00Z"),
  ].sort(compareSignalsDesc);
  assert.deepEqual(sorted.map((r) => r.id), ["b", "a"]);

  const removed = [];
  clearConversationDraftStorage({ removeItem: (key) => removed.push(key) }, ws, groupConvId);
  assert.deepEqual(removed, [conversationDraftStorageKey(ws, groupConvId)]);
});

test("browserSignalCommand with conversationId emits conversation_id without channel/thread_root_id/broadcast_to_channel", () => {
  const dmCmd = browserSignalCommand("Private group hello", [], "note", [], { conversationId: groupConvId });
  assert.equal(dmCmd.conversation_id, groupConvId);
  assert.equal("channel" in dmCmd, false);
  assert.equal("mentions" in dmCmd, false);
  assert.equal("to" in dmCmd, false);
  assert.equal("thread_root_id" in dmCmd, false);
  assert.equal("broadcast_to_channel" in dmCmd, false);

  const chanCmd = browserSignalCommand("Channel update", [], "note", [], {
    conversationId: opsConvId,
    mentions: [{ kind: "agent", id: peerLead }],
  });
  assert.equal(chanCmd.conversation_id, opsConvId);
  assert.deepEqual(chanCmd.mentions, [{ kind: "agent", id: peerLead }]);
  assert.equal("channel" in chanCmd, false);
  assert.equal("to" in chanCmd, false);
});
