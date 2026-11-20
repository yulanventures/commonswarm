import assert from "node:assert/strict";
import test from "node:test";
import {
  THREAD_ROOT_LIVE_MARGIN_MS,
  canStartThread,
  threadReplyBroadcastLabel,
  threadReplyCountLabel,
  threadReplyMayBroadcast,
  threadReplyPlace,
  threadReplyPlaceLabel,
  threadReplyTargetText,
  threadRootBlock,
} from "./thread-reply.ts";
import {
  THREAD_ROOT_UNAVAILABLE_TEXT,
  ThreadRootUnavailableError,
  browserSignalCommand,
} from "./commonswarm.ts";

const NOW = Date.parse("2026-11-19T18:00:00.000Z");
const LIVE_UNTIL = new Date(NOW + 60_000).toISOString();
const EXPIRING_UNTIL = new Date(NOW + THREAD_ROOT_LIVE_MARGIN_MS).toISOString();
const DM_CONV = "aaaa1111-1111-4111-8111-111111111111";
const GROUP_CONV = "bbbb2222-2222-4222-8222-222222222222";
const ROOT_ID = "cccc3333-3333-4333-8333-333333333333";

test("threadRootBlock allows top-level 1:1 DM and group DM rows even with canonical recipients", () => {
  const dmRoot = {
    to: "user-alex",
    toAgent: null,
    threadRootId: null,
    until: LIVE_UNTIL,
    conversationId: DM_CONV,
    conversationKind: "dm",
  };
  assert.equal(threadRootBlock(dmRoot, NOW, false), null);
  assert.equal(canStartThread(dmRoot, NOW, false), true);

  const groupRoot = {
    to: null,
    toAgent: "agent-lead",
    threadRootId: null,
    until: null,
    conversationId: GROUP_CONV,
    conversationKind: "group_dm",
  };
  assert.equal(threadRootBlock(groupRoot, NOW, false), null);
  assert.equal(canStartThread(groupRoot, NOW, false), true);

  // Explicit directConversation option covers rows whose metadata comes from the active conversation.
  const rawDmRow = { to: "user-alex", toAgent: null, threadRootId: null, until: null };
  assert.equal(threadRootBlock(rawDmRow, NOW, false), "directed");
  assert.equal(threadRootBlock(rawDmRow, NOW, false, { directConversation: true }), null);
});

test("DM and group DM threads remain strictly 1-level deep and respect expiry margin", () => {
  const dmReply = {
    to: "user-alex",
    toAgent: null,
    threadRootId: ROOT_ID,
    until: LIVE_UNTIL,
    conversationId: DM_CONV,
    conversationKind: "dm",
  };
  assert.equal(threadRootBlock(dmReply, NOW, false), "already-a-reply");
  assert.equal(canStartThread(dmReply, NOW, false), false);

  const expiringDmRoot = {
    to: "user-alex",
    toAgent: null,
    threadRootId: null,
    until: EXPIRING_UNTIL,
    conversationId: GROUP_CONV,
    conversationKind: "group_dm",
  };
  assert.equal(threadRootBlock(expiringDmRoot, NOW, false), "expiring");
  assert.equal(canStartThread(expiringDmRoot, NOW, false), false);
});

test("channel and unfiled directed rows keep existing directed/archived/reply rules", () => {
  assert.equal(
    threadRootBlock({ to: "user-alex", toAgent: null, threadRootId: null, until: null }, NOW, false),
    "directed",
  );
  assert.equal(
    threadRootBlock({ to: null, toAgent: null, threadRootId: null, until: null }, NOW, true),
    "channel-archived",
  );
  assert.equal(
    threadRootBlock({ to: null, toAgent: null, threadRootId: ROOT_ID, until: null }, NOW, false),
    "already-a-reply",
  );
});

test("direct thread place names the conversation and hides broadcast_to_channel", () => {
  const directPlace = threadReplyPlace(null, null, "Alex and Lead");
  assert.deepEqual(directPlace, { kind: "direct", title: "Alex and Lead" });
  assert.equal(threadReplyPlaceLabel(directPlace), "Alex and Lead");
  assert.equal(threadReplyTargetText("Alex", directPlace), "Replying to Alex in Alex and Lead.");
  assert.equal(threadReplyMayBroadcast(directPlace, null), false);

  const channelPlace = threadReplyPlace("chan-ops", "ops");
  assert.deepEqual(channelPlace, { kind: "channel", slug: "ops" });
  assert.equal(threadReplyMayBroadcast(channelPlace, null), true);
  assert.equal(threadReplyBroadcastLabel("ops"), "Also post this reply in #ops");
  assert.equal(threadReplyCountLabel(1), "1 reply");
  assert.equal(threadReplyCountLabel(3), "3 replies");
});

test("browserSignalCommand for DM thread reply emits conversation_id + thread_root_id without channel or broadcast", () => {
  const cmd = browserSignalCommand("Follow-up in DM thread", [], "note", [], {
    conversationId: GROUP_CONV,
    threadRootId: ROOT_ID,
    channel: "general",
    broadcastToChannel: true,
  });
  assert.equal(cmd.kind, "post_signal");
  assert.equal(cmd.conversation_id, GROUP_CONV);
  assert.equal(cmd.thread_root_id, ROOT_ID);
  assert.equal("channel" in cmd, false);
  assert.equal("broadcast_to_channel" in cmd, false);
  assert.equal("to" in cmd, false);
  assert.equal("mentions" in cmd, false);
});

test("ThreadRootUnavailableError carries uniform non-oracle copy", () => {
  const err = new ThreadRootUnavailableError();
  assert.equal(err.name, "ThreadRootUnavailableError");
  assert.equal(err.message, THREAD_ROOT_UNAVAILABLE_TEXT);
});
