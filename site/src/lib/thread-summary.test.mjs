/** Reached by `npm --prefix site test` through the src/lib/*.test.mjs glob. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { THREAD_FACES_MAX, threadLastReplyAt, threadLastReplyTime, threadRepliers } from "./thread-summary.ts";

const reply = (from, createdAt) => ({ from, createdAt });

test("the thread line shows each replier once, in the order they first replied, three at most", () => {
  const replies = [reply("b", "1"), reply("a", "2"), reply("b", "3"), reply("c", "4"), reply("d", "5")];
  assert.deepEqual(threadRepliers(replies).map((row) => `${row.from}${row.createdAt}`), ["b1", "a2", "c4"]);
  assert.equal(THREAD_FACES_MAX, 3);
  assert.deepEqual(threadRepliers([reply("a", "1"), reply("a", "2")]).map((row) => row.from), ["a"]);
  assert.deepEqual(threadRepliers([]), []);
});

test("the last reply is the newest by time, not by position, and an unreadable time is skipped", () => {
  assert.equal(threadLastReplyAt([reply("a", "2026-11-14T10:00:00Z"), reply("b", "2026-11-14T09:00:00Z")]), "2026-11-14T10:00:00Z");
  assert.equal(threadLastReplyAt([reply("a", "not a time"), reply("b", "2026-11-14T09:00:00Z")]), "2026-11-14T09:00:00Z");
  assert.equal(threadLastReplyAt([reply("a", "not a time")]), null);
  assert.equal(threadLastReplyAt([]), null);
});

test("the last reply time is a clock today, a date on another day, and carries the year when it differs", () => {
  const now = new Date(2026, 10, 14, 15, 0);
  assert.equal(threadLastReplyTime(new Date(2026, 10, 14, 6, 52).toISOString(), now, "en-US"), "6:52 AM");
  assert.equal(threadLastReplyTime(new Date(2026, 10, 12, 23, 5).toISOString(), now, "en-US"), "Nov 12");
  assert.equal(threadLastReplyTime(new Date(2025, 10, 14, 6, 52).toISOString(), now, "en-US"), "Nov 14, 2025");
  assert.equal(threadLastReplyTime("not a time", now, "en-US"), "");
});
