/** Reached by `npm --prefix site test` through the src/lib/*.test.mjs glob. */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  firstUnreadOlderThanLoaded, newestChannelMessage, newestMarkableChannelMessage, oldestChannelMessage, readChannelIdOf,
  timestampMicros, unreadJumpLabel, withChannelRead,
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

test("a mark goes through the newest markable loaded message: not the person's own addressed one, not a refused one", () => {
  const own = (name, extra) => message(name, { from: "viewer", fromKind: "user", ...extra });
  const signals = [ // newest first, as loaded
    own("toDana", { to: "dana" }),
    own("toOrbit", { toAgent: "orbit" }),
    own("toMany", { recipients: [{ kind: "user", id: "dana" }, { kind: "agent", id: "orbit" }] }),
    message("refuse"),
    own("ownOpen"),
    message("older"),
  ];
  assert.equal(newestMarkableChannelMessage(signals, "c1", "viewer")?.id, U("refuse"));
  assert.equal(newestMarkableChannelMessage(signals, "c1", "viewer", new Set([U("refuse")]))?.id, U("ownOpen"),
    "the person's own message to everyone is one they can name");
  assert.equal(newestMarkableChannelMessage(signals, "c1", "viewer", new Set([U("refuse"), U("ownOpen"), U("older")])), null,
    "nothing left: null, so a mark on view sends nothing");
  assert.equal(newestMarkableChannelMessage([message("m", { from: "someone", fromKind: "user", to: "viewer" })], "c1", "viewer")?.id,
    U("m"), "a message addressed to the person is theirs to mark through");
  assert.equal(newestMarkableChannelMessage(signals, "c2", "viewer"), null);
});

test("general is null on the wire", () => {
  assert.equal(readChannelIdOf("general"), null);
  assert.equal(readChannelIdOf("c1"), "c1");
});

test("timestamps keep PostgreSQL's microseconds and their offset", () => {
  const base = BigInt(Date.UTC(2026, 10, 16, 10, 0, 0)) * 1000n;
  assert.equal(timestampMicros("2026-11-16T10:00:00Z"), base);
  assert.equal(timestampMicros("2026-11-16T10:00:00.123456Z"), base + 123456n);
  assert.equal(timestampMicros("2026-11-16T10:00:00.1234567Z"), base + 123456n, "past six digits is below a microsecond");
  assert.equal(timestampMicros("2026-11-16T10:00:00.5Z"), base + 500000n);
  assert.equal(timestampMicros("2026-11-16 12:30:00.000001+02:30"), base + 1n, "PostgreSQL's text form, offset applied");
  assert.equal(timestampMicros("2026-11-16T04:00:00-06"), base);
  assert.equal(timestampMicros("2026-11-16T05:00:00-0500"), base);
  assert.equal(timestampMicros("2026-11-16T10:00:00"), base, "no offset reads as UTC");
  assert.equal(timestampMicros("yesterday"), null);
});

test("a first unread message is older than the page by the feed's own order: time to the microsecond, then id", () => {
  const floor = (createdAt, id = "00000000-0000-4000-8000-000000000002") => ({ createdAt, id });
  // Inside one JavaScript millisecond: Date.parse would call these equal.
  assert.equal(firstUnreadOlderThanLoaded("2026-11-16T10:00:00.123100Z", "00000000-0000-4000-8000-000000000009",
    floor("2026-11-16T10:00:00.123456Z")), true);
  assert.equal(firstUnreadOlderThanLoaded("2026-11-16T10:00:00.123456Z", "00000000-0000-4000-8000-000000000001",
    floor("2026-11-16T10:00:00.123100Z")), false);
  // The same time across a page boundary: the id decides, as the feed's ORDER BY created_at, id does.
  assert.equal(firstUnreadOlderThanLoaded("2026-11-16T10:00:00.123456Z", "00000000-0000-4000-8000-000000000001",
    floor("2026-11-16T10:00:00.123456Z")), true);
  assert.equal(firstUnreadOlderThanLoaded("2026-11-16T10:00:00.123456Z", "00000000-0000-4000-8000-00000000000A",
    floor("2026-11-16T10:00:00.123456Z", "00000000-0000-4000-8000-00000000000b")), true, "ids compare in lower case");
  assert.equal(firstUnreadOlderThanLoaded("2026-11-16T10:00:00.123456Z", "00000000-0000-4000-8000-000000000002",
    floor("2026-11-16T10:00:00.123456Z")), false, "the page's own oldest message is loaded, not older");
  assert.equal(firstUnreadOlderThanLoaded("2026-11-16T09:59:59.5+00:00", null, floor("2026-11-16T10:00:00Z")), true);
  assert.equal(firstUnreadOlderThanLoaded(null, null, floor("2026-11-16T10:00:00Z")), false);
  assert.equal(firstUnreadOlderThanLoaded("2026-11-16T10:00:00Z", "x", null), false);
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
