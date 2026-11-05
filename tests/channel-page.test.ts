/** Channels C3: channel_read pages against the real wire (double-escaped), keeping whole messages. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { channelPageWireBytes, fitChannelPage } from "../supabase/functions/mcp/channel-page.ts";

const message = (id: string, body: string) => ({ signal_id: id, from: { kind: "agent", id: "a", name: "A" }, kind: "note",
  body, created_at: "2026-11-05T00:00:00Z", until: "2026-11-06T00:00:00Z", thread_root_id: null, attachments: [] });
const page = (messages: Array<Record<string, unknown>>) => ({ context: { workspace: "W" }, workspace_id: "W",
  channel: "design", archived: false, messages, next: null });

test("three legal 8000-backslash bodies are paged under the response limit, not by their raw size", () => {
  const limit = 64 * 1024;
  const heavy = page(["1", "2", "3"].map((id) => message(id, "\\".repeat(8000))));
  assert.ok(channelPageWireBytes(heavy) > limit, "the whole page would not fit on the wire");
  const fitted = fitChannelPage(heavy, limit);
  assert.ok(channelPageWireBytes(fitted) <= limit - 1024);
  assert.ok(fitted.messages.length >= 1 && fitted.messages.length < 3);
  assert.deepEqual(fitted.next, { after_id: fitted.messages.at(-1)!.signal_id }, "the rest follows from the last kept message");
  for (const kept of fitted.messages) assert.equal((kept.body as string).length, 8000, "messages are whole");
});

test("a page that fits is unchanged, including the server's next cursor", () => {
  const small = { ...page([message("1", "hello"), message("2", "world")]), next: { after_id: "2" } };
  assert.deepEqual(fitChannelPage(small, 64 * 1024), small);
});

test("the id allowance covers the worst-case protocol id", () => {
  const empty = channelPageWireBytes(page([]));
  const withLongestId = new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: "\u0001".repeat(256),
    result: { content: [{ type: "text", text: JSON.stringify(page([])) }] } })).byteLength;
  assert.ok(empty >= withLongestId);
});
