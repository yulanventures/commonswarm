/** Channels C3 in the CLI: cswarm channel read and the local MCP channel_read. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ChannelListError, readChannelMessagesAsAgent, type ChannelMessagePage } from "../../src/cloud/channels.js";
import { MCP_RESULT_MAX_BYTES, mapChannelPage } from "../../src/mcp/tools.js";

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
