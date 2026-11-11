/** Channels C3 in the CLI: cswarm channel read and the local MCP channel_read. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { CHANNEL_PAGE_MAX_BYTES, ChannelListError, listChannelsWithUnreadAsAgent, readChannelMessagesAsAgent, renderChannelList,
  type ChannelMessagePage } from "../../src/cloud/channels.js";
import { MCP_CHANNEL_PAGE_MAX_BYTES, MCP_RESULT_MAX_BYTES, mapChannelList, mapChannelPage } from "../../src/mcp/tools.js";

const target = { url: "http://127.0.0.1:9", anonKey: "anon" } as Parameters<typeof readChannelMessagesAsAgent>[0];
const page = (count: number, body = "hello"): ChannelMessagePage => ({ workspace_id: "W", channel: "design", archived: false,
  messages: Array.from({ length: count }, (_, i) => ({ signal_id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    from: { kind: "agent", id: "a", name: "A" }, kind: "note", body, created_at: "2026-11-05T00:00:00Z",
    until: "2026-11-06T00:00:00Z", thread_root_id: null, attachments: [] })), next: null });

test("channel read sends exactly the read function's channel_messages shape", async () => {
  let sent: unknown;
  const fetcher = (async (_url: unknown, init?: RequestInit) => { sent = JSON.parse(String(init?.body)); return Response.json(page(1)); }) as typeof fetch;
  const result = await readChannelMessagesAsAgent(target, "token", "W", { channel: "design", after_id: "x", limit: 5 }, fetcher);
  assert.deepEqual(sent, { resource: "channel_messages", workspace_id: "W", channel: "design", after_id: "x", limit: 5 });
  assert.equal(result.messages.length, 1);
  const plain = (async (_url: unknown, init?: RequestInit) => { sent = JSON.parse(String(init?.body)); return Response.json(page(0)); }) as typeof fetch;
  await readChannelMessagesAsAgent(target, "token", "W", { channel: "general" }, plain);
  assert.deepEqual(sent, { resource: "channel_messages", workspace_id: "W", channel: "general" });
});

test("a missing channel is a clear refusal", async () => {
  const fetcher = (async () => Response.json({ error: "channel_not_found" }, { status: 404 })) as typeof fetch;
  await assert.rejects(() => readChannelMessagesAsAgent(target, "token", "W", { channel: "nope" }, fetcher),
    (error) => error instanceof ChannelListError && error.status === 404 && /cswarm channel ls/.test(error.message));
});

test("the local MCP keeps whole messages under its result cap and continues from the last one kept", () => {
  const heavy = page(50, "\\".repeat(4000));
  const mapped = mapChannelPage(heavy) as ChannelMessagePage;
  assert.ok(Buffer.byteLength(JSON.stringify(mapped)) <= MCP_RESULT_MAX_BYTES);
  assert.ok(mapped.messages.length >= 1 && mapped.messages.length < 50);
  assert.deepEqual(mapped.next, { after_id: mapped.messages.at(-1)!.signal_id });
  assert.deepEqual((mapChannelPage(page(2)) as ChannelMessagePage).messages.length, 2);
});

/* Channels C1b for agents: unread on the list, and read budgets that let reads count as read. */

test("channel read passes max_bytes only when the caller declares it", async () => {
  let sent: unknown;
  const fetcher = (async (_url: unknown, init?: RequestInit) => { sent = JSON.parse(String(init?.body)); return Response.json(page(0)); }) as typeof fetch;
  await readChannelMessagesAsAgent(target, "token", "W", { channel: "design", max_bytes: CHANNEL_PAGE_MAX_BYTES }, fetcher);
  assert.deepEqual(sent, { resource: "channel_messages", workspace_id: "W", channel: "design", max_bytes: 64 * 1024 });
});

/** The read edge's page bound (supabase/functions/read/index.ts boundChannelPage): whole messages by
 * their JSON bytes, always at least one. */
function edgeBound(messages: ChannelMessagePage["messages"], maxBytes: number): ChannelMessagePage["messages"] {
  let bytes = 0, kept = 0;
  for (const message of messages) {
    const size = Buffer.byteLength(JSON.stringify(message));
    if (kept > 0 && bytes + size > maxBytes) break;
    bytes += size; kept += 1;
  }
  return messages.slice(0, kept);
}

test("the local MCP's read budget is one its own result cap never trims", () => {
  // The largest envelope: a 32-character channel, archived, with a next cursor, and 50 messages
  // that fill the budget, escaped characters included.
  for (const body of ["x".repeat(600), "\\\"".repeat(300), "\u0001".repeat(100)]) {
    const all = { ...page(50, body), channel: "c".repeat(32), archived: true,
      next: { after_id: "00000000-0000-4000-8000-000000000049" } };
    const kept = edgeBound(all.messages, MCP_CHANNEL_PAGE_MAX_BYTES);
    const mapped = mapChannelPage({ ...all, messages: kept }) as ChannelMessagePage;
    assert.equal(mapped.messages.length, kept.length, `every message the edge kept is delivered (${body.slice(0, 2)})`);
    assert.ok(Buffer.byteLength(JSON.stringify(mapped)) <= MCP_RESULT_MAX_BYTES);
  }
});

test("channel_ls carries each channel's unread and general's, and an answer without it is unknown", async () => {
  const row = (slug: string, unread?: boolean | null, archived_at: string | null = null) => ({ channel_id: slug, workspace_id: "W", slug,
    purpose: null, created_by_principal: "u", created_by_kind: "user" as const, created_at: "2026-11-05T00:00:00Z", archived_at,
    ...(unread === undefined ? {} : { unread }) });
  const answer = (body: object) => (async () => Response.json(body)) as typeof fetch;
  const listed = await listChannelsWithUnreadAsAgent(target, "token", "W",
    answer({ channels: [row("design", true), row("ops", false), row("old", true, "2026-11-01T00:00:00Z")], general_unread: false }));
  assert.equal(listed.general_unread, false);
  assert.deepEqual(mapChannelList(listed), { channels: [
    { slug: "general", purpose: null, unread: false },
    { slug: "design", purpose: null, unread: true },
    { slug: "ops", purpose: null, unread: false },
  ] });
  // Another workspace's empty answer, and an older deployment, carry no unread at all.
  const bare = await listChannelsWithUnreadAsAgent(target, "token", "W", answer({ channels: [row("design")] }));
  assert.equal(bare.general_unread, null);
  assert.deepEqual(mapChannelList(bare), { channels: [
    { slug: "general", purpose: null, unread: null }, { slug: "design", purpose: null, unread: null },
  ] });

  const text = renderChannelList(listed.channels, { includeArchived: false, generalUnread: true });
  assert.match(text, /^- design {2}\[unread\]$/m);
  assert.match(text, /^- ops$/m);
  assert.match(text, /^Unread in general \(unfiled messages\): cswarm channel read general$/m);
  assert.doesNotMatch(renderChannelList(listed.channels, { includeArchived: false }), /general/);
});
