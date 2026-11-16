/** Reached by `npm --prefix site test` through the src/lib/*.test.mjs glob. */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  firstUnreadOlderThanLoaded, newestChannelMessage, oldestChannelMessage, readChannelIdOf, throughSignalFor,
  unreadJumpLabel, withChannelRead,
} from "./channel-reads.ts";

/** A server id for a test name. */
const U = (name) => `00000000-0000-4000-8000-${Buffer.from(name).toString("hex").padStart(12, "0").slice(-12)}`;
const message = (name, extra = {}) => ({ id: U(name), from: "someone", fromKind: "agent", to: null, toAgent: null,
  createdAt: "2026-11-16T10:00:00Z", channelId: "c1", threadRootId: null, broadcastToChannel: false, ...extra });

test("the newest and oldest message a read position can name skip other channels, thread-only replies and local rows", () => {
  const signals = [ // newest first, as loaded
    message("local", { id: "sample-composer-1" }),
    message("reply", { threadRootId: "root" }),
    message("other", { channelId: "c2" }),
    message("bcast", { threadRootId: "root", broadcastToChannel: true }),
    message("root"),
    message("unfile", { channelId: null }),
  ];
  assert.equal(newestChannelMessage(signals, "c1")?.id, U("bcast"));
  assert.equal(oldestChannelMessage(signals, "c1")?.id, U("root"));
  assert.equal(newestChannelMessage(signals, "general")?.id, U("unfile"));
  assert.equal(newestChannelMessage(signals, "c3"), null);
});

test("the person's own addressed message is marked up to now; anything else through itself", () => {
  assert.equal(throughSignalFor(message("m"), "viewer"), U("m"));
  assert.equal(throughSignalFor(message("m", { from: "viewer", fromKind: "user" }), "viewer"), U("m"));
  assert.equal(throughSignalFor(message("m", { from: "viewer", fromKind: "user", to: "dana" }), "viewer"), null);
  assert.equal(throughSignalFor(message("m", { from: "viewer", fromKind: "user", toAgent: "orbit" }), "viewer"), null);
  assert.equal(throughSignalFor(message("m", { from: "someone", fromKind: "user", to: "viewer" }), "viewer"), U("m"));
});

test("general is null on the wire", () => {
  assert.equal(readChannelIdOf("general"), null);
  assert.equal(readChannelIdOf("c1"), "c1");
});

test("a first unread message is older than the page by time, not by text", () => {
  assert.equal(firstUnreadOlderThanLoaded("2026-11-16T09:59:59.5+00:00", "2026-11-16T10:00:00Z"), true);
  assert.equal(firstUnreadOlderThanLoaded("2026-11-16T10:00:00.5Z", "2026-11-16T10:00:00Z"), false);
  assert.equal(firstUnreadOlderThanLoaded(null, "2026-11-16T10:00:00Z"), false);
  assert.equal(firstUnreadOlderThanLoaded("2026-11-16T10:00:00Z", null), false);
});

test("a mark reads at once: the marked view, or every view, is read; unknown stays unknown", () => {
  const rows = [
    { channelId: null, slug: "general", unread: true, unreadCount: 2, firstUnreadId: "g", firstUnreadAt: "t" },
    { channelId: "c1", slug: "design", unread: true, unreadCount: 5, firstUnreadId: "d", firstUnreadAt: "t" },
    { channelId: "c2", slug: "ops", unread: null, unreadCount: 0, firstUnreadId: null, firstUnreadAt: null },
  ];
  const read = { unreadCount: 0, firstUnreadId: null, firstUnreadAt: null };
  assert.deepEqual(withChannelRead(rows, "c1"), [rows[0], { ...rows[1], unread: false, ...read }, rows[2]]);
  assert.deepEqual(withChannelRead(rows, "general"), [{ ...rows[0], unread: false, ...read }, rows[1], rows[2]]);
  assert.deepEqual(withChannelRead(rows, "all"), [{ ...rows[0], unread: false, ...read }, { ...rows[1], unread: false, ...read }, rows[2]]);
  assert.equal(withChannelRead(rows, "c2")[2], rows[2], "nothing to clear: the same row");
});

test("the bar's words: a count only while it is a real, current one", () => {
  assert.equal(unreadJumpLabel(12), "12 unread · Jump to first unread");
  assert.equal(unreadJumpLabel(12, true), "Jump to first unread", "after the visit's mark the count is stale");
  assert.equal(unreadJumpLabel(0), "Jump to first unread", "a server without counts never shows 0 unread");
});
