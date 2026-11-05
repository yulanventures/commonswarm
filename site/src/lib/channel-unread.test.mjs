/** Reached by `npm --prefix site test` through the src/lib/*.test.mjs glob. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseChannelUnread } from "./commonswarm.ts";

test("channel unread keeps true, false and unknown apart, and refuses malformed data", () => {
  assert.deepEqual(parseChannelUnread({ channels: [
    { channel_id: null, slug: "general", unread: null },
    { channel_id: "c1", slug: "design", unread: true },
    { channel_id: "c2", slug: "ops", unread: false },
  ] }), [
    { channelId: null, slug: "general", unread: null },
    { channelId: "c1", slug: "design", unread: true },
    { channelId: "c2", slug: "ops", unread: false },
  ]);
  for (const bad of [null, {}, { channels: "x" }, { channels: [{ channel_id: 1, slug: "x", unread: true }] },
    { channels: [{ channel_id: null, slug: "general", unread: "yes" }] }]) {
    assert.equal(parseChannelUnread(bad), null);
  }
});
