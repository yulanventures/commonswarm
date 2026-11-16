/** Reached by `npm --prefix site test` through the src/lib/*.test.mjs glob. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { markChannelRead, parseChannelUnread } from "./commonswarm.ts";

const NONE = { unreadCount: 0, firstUnreadId: null, firstUnreadAt: null };

test("channel unread keeps true, false and unknown apart, and refuses malformed data", () => {
  assert.deepEqual(parseChannelUnread({ channels: [
    { channel_id: null, slug: "general", unread: null },
    { channel_id: "c1", slug: "design", unread: true },
    { channel_id: "c2", slug: "ops", unread: false },
  ] }), [
    { channelId: null, slug: "general", unread: null, starred: false, starRank: null, involvement: "everything", ...NONE },
    { channelId: "c1", slug: "design", unread: true, starred: false, starRank: null, involvement: "everything", ...NONE },
    { channelId: "c2", slug: "ops", unread: false, starred: false, starRank: null, involvement: "everything", ...NONE },
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
    { channelId: null, slug: "general", unread: false, starred: true, starRank: 1, involvement: "mentions", ...NONE },
    { channelId: "c1", slug: "design", unread: false, starred: false, starRank: null, involvement: "muted", ...NONE },
  ]);
  const row = { channel_id: "c1", slug: "design", unread: false };
  for (const bad of [{ starred: "yes" }, { star_rank: "1" }, { star_rank: 1.5 }, { involvement: "loud" }, { involvement: null }]) {
    assert.equal(parseChannelUnread({ channels: [{ ...row, ...bad }] }), null, JSON.stringify(bad));
  }
});

test("the count and the first unread message are read when sent, and default when absent or malformed", () => {
  const [row] = parseChannelUnread({ channels: [{ channel_id: "c1", slug: "design", unread: true,
    unread_count: 7, first_unread_id: "m1", first_unread_at: "2026-11-16T10:00:00.123456+00:00" }] });
  assert.equal(row.unreadCount, 7);
  assert.equal(row.firstUnreadId, "m1");
  assert.equal(row.firstUnreadAt, "2026-11-16T10:00:00.123456+00:00");
  for (const odd of [{ unread_count: "7" }, { unread_count: -1 }, { unread_count: 1.5 }, { first_unread_id: 4 },
    { first_unread_id: null, first_unread_at: "2026-11-16T10:00:00Z" }]) {
    const [parsed] = parseChannelUnread({ channels: [{ channel_id: "c1", slug: "design", unread: true, ...odd }] });
    assert.ok(parsed, JSON.stringify(odd));
    assert.equal(parsed.unread, true, "an odd extra never changes unread");
    if ("unread_count" in odd) assert.equal(parsed.unreadCount, 0, JSON.stringify(odd));
    if ("first_unread_id" in odd) assert.deepEqual([parsed.firstUnreadId, parsed.firstUnreadAt], [null, null], JSON.stringify(odd));
  }
});

/** The command edge as the browser meets it: the deployment from the page's meta tags, the answer from `reply`. */
function commandEdge(t, reply) {
  const sent = [];
  const originalFetch = globalThis.fetch, originalDocument = globalThis.document;
  globalThis.document = { querySelector: (selector) => ({
    'meta[name="commonswarm:url"]': { content: "https://api.example.test" },
    'meta[name="commonswarm:anon-key"]': { content: "anon" },
  })[selector] ?? null };
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push({ url, authorization: init.headers.authorization, body });
    const [status, answer] = reply(body);
    return { status, text: async () => JSON.stringify(answer) };
  };
  t.after(() => { globalThis.fetch = originalFetch; globalThis.document = originalDocument; });
  return sent;
}
const SESSION = { access_token: "token", user: { id: "viewer" } };

test("mark_channel_read sends one channel (null is general), through a message or not, or every channel", async (t) => {
  const sent = commandEdge(t, () => [200, { status: "accepted", ok: true, event_ids: [], channels: [] }]);
  assert.equal(await markChannelRead(SESSION, "id-1", "W", { channelId: "c1", throughSignalId: "m1" }), "ok");
  assert.equal(await markChannelRead(SESSION, "id-2", "W", { channelId: null }), "ok");
  assert.equal(await markChannelRead(SESSION, "id-3", "W", { channelId: "c1", throughSignalId: null }), "ok");
  assert.equal(await markChannelRead(SESSION, "id-4", "W", { all: true }), "ok");
  assert.equal(sent[0].url, "https://api.example.test/functions/v1/command");
  assert.equal(sent[0].authorization, "Bearer token");
  assert.deepEqual(sent.map(({ body }) => [body.command_id, body.workspace_id, body.stream, body.command]), [
    ["id-1", "W", { kind: "workspace" }, { kind: "mark_channel_read", channel_id: "c1", through_signal_id: "m1" }],
    ["id-2", "W", { kind: "workspace" }, { kind: "mark_channel_read", channel_id: null }],
    ["id-3", "W", { kind: "workspace" }, { kind: "mark_channel_read", channel_id: "c1" }],
    ["id-4", "W", { kind: "workspace" }, { kind: "mark_channel_read", all: true }],
  ]);
});

test("mark_channel_read names each refusal it can act on, reads an old server's 400 as unsupported, and throws the rest", async (t) => {
  const answers = [
    [404, { error: "signal_not_found" }], [404, { error: "channel_not_found" }], [400, { error: "unknown_kind" }],
    [403, { error: "forbidden" }], [500, { error: "internal" }],
  ];
  commandEdge(t, () => answers.shift());
  assert.equal(await markChannelRead(SESSION, "a", "W", { channelId: "c1", throughSignalId: "m1" }), "signal_not_found");
  assert.equal(await markChannelRead(SESSION, "b", "W", { channelId: "gone" }), "channel_not_found");
  assert.equal(await markChannelRead(SESSION, "c", "W", { all: true }), "unsupported");
  await assert.rejects(markChannelRead(SESSION, "d", "W", { all: true }), /HTTP 403/);
  await assert.rejects(markChannelRead(SESSION, "e", "W", { all: true }), /HTTP 500/);
});
