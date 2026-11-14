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
    { channelId: null, slug: "general", unread: null, starred: false, starRank: null, involvement: "everything" },
    { channelId: "c1", slug: "design", unread: true, starred: false, starRank: null, involvement: "everything" },
    { channelId: "c2", slug: "ops", unread: false, starred: false, starRank: null, involvement: "everything" },
  ]);
  for (const bad of [null, {}, { channels: "x" }, { channels: [{ channel_id: 1, slug: "x", unread: true }] },
    { channels: [{ channel_id: null, slug: "general", unread: "yes" }] }]) {
    assert.equal(parseChannelUnread(bad), null);
  }
});

test("the same read carries the viewer's star, its place and their notification level", () => {
  assert.deepEqual(parseChannelUnread({ channels: [
    { channel_id: null, slug: "general", visibility: "open", unread: false, starred: true, star_rank: 1, involvement: "mentions" },
    { channel_id: "c1", slug: "design", visibility: "open", unread: false, starred: false, star_rank: null, involvement: "muted" },
  ] }), [
    { channelId: null, slug: "general", unread: false, starred: true, starRank: 1, involvement: "mentions" },
    { channelId: "c1", slug: "design", unread: false, starred: false, starRank: null, involvement: "muted" },
  ]);
  const row = { channel_id: "c1", slug: "design", unread: false };
  for (const bad of [{ starred: "yes" }, { star_rank: "1" }, { star_rank: 1.5 }, { involvement: "loud" }, { involvement: null }]) {
    assert.equal(parseChannelUnread({ channels: [{ ...row, ...bad }] }), null, JSON.stringify(bad));
  }
});
