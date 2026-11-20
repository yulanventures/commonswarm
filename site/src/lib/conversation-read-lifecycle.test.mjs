import assert from "node:assert/strict";
import { test } from "node:test";
import { createConversationReadLifecycle } from "./conversation-read-lifecycle.ts";

class FakeUnsupportedError extends Error {}
class FakeIdentityMismatchError extends Error {}

const WS = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const DM_1 = "aaaa1111-1111-4111-8111-111111111111";
const PRIV_1 = "bbbb1111-1111-4111-8111-111111111111";
const CH_PRIV = "cccc1111-1111-4111-8111-111111111111";

const mkConv = (id, kind, extra = {}) => ({
  conversationId: id,
  kind,
  channelId: kind.endsWith("channel") ? CH_PRIV : null,
  slug: kind.endsWith("channel") ? "secret-ops" : null,
  description: null,
  archivedAt: null,
  joined: true,
  generation: 1,
  leadMode: null,
  leadAgentPrincipalId: null,
  members: [{ kind: "user", id: USER, name: "Owner", leftAt: null }],
  notifyLevel: "everything",
  starred: false,
  starRank: null,
  readThroughAt: null,
  readThroughId: null,
  unreadCount: 0,
  mentionCount: 0,
  lastMessageAt: null,
  lastMessageId: null,
  ...extra,
});

const mkSig = (id, createdAt, conversationId = DM_1) => ({ id, createdAt, conversationId });

function createHarness(overrides = {}) {
  let clock = 100_000;
  let activeUser = USER;
  let activeWorkspace = WS;
  let activeVersion = 1;
  let activeChannel = null;
  let activeDm = DM_1;
  let target = { mode: "conversation", conversationId: DM_1 };
  const clearedOmitted = [];
  const evictedActive = [];
  const appliedPages = [];
  let stateChanges = 0;
  let commits = 0;
  let resetLoadOlderCount = 0;

  const listCalls = [];
  const historyCalls = [];
  let listImpl = async () => [mkConv(DM_1, "dm"), mkConv(PRIV_1, "private_channel")];
  let historyImpl = async () => ({
    ok: true,
    conversation: mkConv(DM_1, "dm"),
    messages: [mkSig("sig-2", "2026-11-20T10:02:00Z"), mkSig("sig-1", "2026-11-20T10:01:00Z")],
    hasMore: true,
    nextBefore: { createdAt: "2026-11-20T10:01:00Z", id: "sig-1" },
    nextAfter: { createdAt: "2026-11-20T10:02:00Z", id: "sig-2" },
  });

  const lifecycle = createConversationReadLifecycle({
    listConversations: (ws, includeArchived, expectedUserId, isAlive) => {
      listCalls.push({ ws, includeArchived, expectedUserId, aliveAtStart: isAlive() });
      return listImpl(ws, includeArchived, expectedUserId, isAlive);
    },
    readConversationHistory: (ws, convId, opts) => {
      historyCalls.push({ ws, convId, opts });
      return historyImpl(ws, convId, opts);
    },
    isConversationsUnsupportedError: (err) => err instanceof FakeUnsupportedError,
    isSessionIdentityMismatch: (err) => err instanceof FakeIdentityMismatchError,
    readableError: (err) => (err instanceof Error ? err.message : String(err)),
    now: () => clock,
    generalChannelId: "__general__",
    isSampleMode: () => false,
    activeSessionUserId: () => activeUser,
    activeWorkspaceId: () => activeWorkspace,
    activeRequestVersion: () => activeVersion,
    activeChannelId: () => activeChannel,
    activeDmConversationId: () => activeDm,
    activeConversationHistoryTarget: () => target,
    optimisticRowsForConversation: () => [],
    onClearOmittedConversationData: (ws, u, convId) => clearedOmitted.push({ ws, u, convId }),
    onEvictActiveConversation: (ws, convId, markUnavailable) => evictedActive.push({ ws, convId, markUnavailable }),
    onResetLoadOlderState: () => { resetLoadOlderCount += 1; },
    onConversationReadStateChanged: () => { stateChanges += 1; },
    onConversationsCommitted: () => { commits += 1; },
    onHistoryApplied: (entry) => appliedPages.push(entry),
    ...overrides,
  });

  return {
    lifecycle,
    listCalls,
    historyCalls,
    clearedOmitted,
    evictedActive,
    appliedPages,
    getStateChanges: () => stateChanges,
    getCommits: () => commits,
    getResetLoadOlderCount: () => resetLoadOlderCount,
    advanceClock: (ms) => { clock += ms; },
    setActiveUser: (u) => { activeUser = u; },
    setActiveWorkspace: (w) => { activeWorkspace = w; },
    setActiveVersion: (v) => { activeVersion = v; },
    setActiveChannel: (c) => { activeChannel = c; },
    setActiveDm: (d) => { activeDm = d; },
    setTarget: (t) => { target = t; },
    setListImpl: (fn) => { listImpl = fn; },
    setHistoryImpl: (fn) => { historyImpl = fn; },
  };
}

test("refreshConversations throttles non-forced polls, handles unsupported vs confirmed-modern errors, and discards stale responses", async () => {
  const h = createHarness();
  await h.lifecycle.refreshConversations(WS, false);
  assert.equal(h.listCalls.length, 1);
  assert.equal(h.lifecycle.getReadState(), "ready");
  assert.equal(h.getCommits(), 1);

  // Within 15s throttle, non-forced poll skips; forced poll runs.
  h.advanceClock(5_000);
  await h.lifecycle.refreshConversations(WS, false);
  assert.equal(h.listCalls.length, 1);
  await h.lifecycle.refreshConversations(WS, true);
  assert.equal(h.listCalls.length, 2);

  // Confirmed-modern workspace never downgrades to "unsupported" on transient unsupported-shaped error.
  h.setListImpl(async () => { throw new FakeUnsupportedError("gateway mismatch"); });
  await h.lifecycle.refreshConversations(WS, true);
  assert.equal(h.lifecycle.getReadState(), "ready");
  assert.equal(h.lifecycle.getReadError(), "gateway mismatch");

  // Fresh workspace without prior confirmation DOES enter "unsupported".
  const fresh = createHarness();
  fresh.setListImpl(async () => { throw new FakeUnsupportedError("pre-step-2b"); });
  await fresh.lifecycle.refreshConversations(WS, true);
  assert.equal(fresh.lifecycle.getReadState(), "unsupported");
  await fresh.lifecycle.refreshConversations(WS, true);
  assert.equal(fresh.listCalls.length, 1, "unsupported state skips subsequent polls");

  // SessionIdentityMismatch is silently discarded without corrupting state.
  const mismatch = createHarness();
  mismatch.setListImpl(async () => { throw new FakeIdentityMismatchError(); });
  await mismatch.lifecycle.refreshConversations(WS, true);
  assert.equal(mismatch.lifecycle.getReadState(), "pending");
  assert.equal(mismatch.lifecycle.getReadError(), "");
});

test("commitWorkspaceConversations evicts omitted DMs and private channels and clears eviction on rejoin", async () => {
  const h = createHarness();
  await h.lifecycle.refreshConversations(WS, true);
  assert.equal(h.evictedActive.length, 0);

  // Omitting active DM_1 and PRIV_1 clears omitted data and evicts active DM_1.
  const evicted = h.lifecycle.commitWorkspaceConversations(WS, USER, [], true);
  assert.equal(evicted, true);
  assert.equal(h.lifecycle.isEvicted(WS, DM_1), true);
  assert.equal(h.lifecycle.isEvicted(WS, PRIV_1), true);
  assert.deepEqual(h.clearedOmitted.map((e) => e.convId).sort(), [DM_1, PRIV_1].sort());
  assert.deepEqual(h.evictedActive, [{ ws: WS, convId: DM_1, markUnavailable: true }]);

  // Rejoining clears evicted marker.
  h.lifecycle.commitWorkspaceConversations(WS, USER, [mkConv(DM_1, "dm")], true);
  assert.equal(h.lifecycle.isEvicted(WS, DM_1), false);
});

test("loadConversationPage handles initial, load-older, stale epoch discard, and unavailable eviction", async () => {
  const h = createHarness();
  await h.lifecycle.refreshConversations(WS, true);

  const okInit = await h.lifecycle.loadConversationPage({
    workspaceId: WS,
    conversationId: DM_1,
    pinnedUserId: USER,
    version: 1,
    reset: true,
    fallbackBeforeCursor: null,
  });
  assert.equal(okInit, true);
  assert.equal(h.getResetLoadOlderCount(), 1);
  assert.equal(h.appliedPages.length, 1);
  assert.deepEqual(h.appliedPages[0].state.rows.map((r) => r.id), ["sig-2", "sig-1"]);

  // Load older uses nextBefore cursor and appends older row.
  h.setHistoryImpl(async () => ({
    ok: true,
    conversation: mkConv(DM_1, "dm"),
    messages: [mkSig("sig-0", "2026-11-20T10:00:00Z")],
    hasMore: false,
    nextBefore: null,
    nextAfter: null,
  }));
  const okOlder = await h.lifecycle.loadConversationPage({
    workspaceId: WS,
    conversationId: DM_1,
    pinnedUserId: USER,
    version: 1,
    reset: false,
    fallbackBeforeCursor: null,
  });
  assert.equal(okOlder, true);
  assert.deepEqual(h.historyCalls[1].opts.before, { createdAt: "2026-11-20T10:01:00Z", id: "sig-1" });
  assert.deepEqual(h.appliedPages[1].state.rows.map((r) => r.id), ["sig-2", "sig-1", "sig-0"]);

  // Stale load interrupted by reset() is dropped cleanly.
  let releaseStale;
  h.setHistoryImpl(() => new Promise((resolve) => { releaseStale = resolve; }));
  const pending = h.lifecycle.loadConversationPage({
    workspaceId: WS,
    conversationId: DM_1,
    pinnedUserId: USER,
    version: 1,
    reset: true,
    fallbackBeforeCursor: null,
  });
  h.lifecycle.reset();
  releaseStale({
    ok: true,
    conversation: mkConv(DM_1, "dm"),
    messages: [mkSig("sig-stale", "2026-11-20T10:05:00Z")],
    hasMore: false,
    nextBefore: null,
    nextAfter: null,
  });
  assert.equal(await pending, false);
  assert.equal(h.appliedPages.length, 2, "stale response after reset must not apply");

  // 404 / unavailable triggers eviction callback.
  h.setHistoryImpl(async () => ({
    ok: false,
    code: "conversation_not_found",
    status: 404,
    message: "This conversation isn't available anymore.",
  }));
  const okUnavail = await h.lifecycle.loadConversationPage({
    workspaceId: WS,
    conversationId: DM_1,
    pinnedUserId: USER,
    version: 1,
    reset: true,
    fallbackBeforeCursor: null,
  });
  assert.equal(okUnavail, false);
  assert.deepEqual(h.evictedActive, [{ ws: WS, convId: DM_1, markUnavailable: true }]);
});

test("refreshConversationLatest advances incrementally via after cursor and evicts on lostAccess", async () => {
  const h = createHarness();
  await h.lifecycle.loadConversationPage({
    workspaceId: WS,
    conversationId: DM_1,
    pinnedUserId: USER,
    version: 1,
    reset: true,
    fallbackBeforeCursor: null,
  });

  h.setHistoryImpl(async () => ({
    ok: true,
    conversation: mkConv(DM_1, "dm"),
    messages: [mkSig("sig-3", "2026-11-20T10:03:00Z")],
    hasMore: false,
    nextBefore: null,
    nextAfter: { createdAt: "2026-11-20T10:03:00Z", id: "sig-3" },
  }));
  const latest = await h.lifecycle.refreshConversationLatest({
    workspaceId: WS,
    conversationId: DM_1,
    pinnedUserId: USER,
    version: 1,
  });
  assert.equal(latest.status, "ready");
  assert.equal(latest.changed, true);
  assert.deepEqual(h.historyCalls[1].opts.after, { createdAt: "2026-11-20T10:02:00Z", id: "sig-2" });
  assert.deepEqual(latest.state.rows.map((r) => r.id), ["sig-3", "sig-2", "sig-1"]);

  // Lost access on live refresh triggers eviction.
  h.setHistoryImpl(async () => ({
    ok: false,
    code: "conversation_not_found",
    status: 404,
    message: "This conversation isn't available anymore.",
  }));
  const lost = await h.lifecycle.refreshConversationLatest({
    workspaceId: WS,
    conversationId: DM_1,
    pinnedUserId: USER,
    version: 1,
  });
  assert.equal(lost.status, "lost_access");
  assert.deepEqual(h.evictedActive, [{ ws: WS, convId: DM_1, markUnavailable: true }]);
});
