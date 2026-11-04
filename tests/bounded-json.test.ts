/** The read function's body cap: oversized bodies are refused before any parse. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { READ_BODY_MAX_BYTES, readBoundedJson } from "../supabase/functions/_shared/bounded-json.ts";

function streamed(chunks: Uint8Array[], onPull?: () => void): Request {
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      onPull?.();
      if (index < chunks.length) controller.enqueue(chunks[index++]!);
      else controller.close();
    },
  });
  return new Request("http://127.0.0.1/read", { method: "POST", body, duplex: "half" } as RequestInit);
}

test("a body within the cap parses; malformed JSON and no body read as null", async () => {
  const ok = await readBoundedJson(new Request("http://127.0.0.1/read", { method: "POST", body: JSON.stringify({ resource: "roster" }) }));
  assert.deepEqual(ok, { ok: true, value: { resource: "roster" } });
  assert.deepEqual(await readBoundedJson(new Request("http://127.0.0.1/read", { method: "POST", body: "{not json" })), { ok: true, value: null });
  assert.deepEqual(await readBoundedJson(new Request("http://127.0.0.1/read", { method: "POST" })), { ok: true, value: null });
  const exact = JSON.stringify({ pad: "x".repeat(READ_BODY_MAX_BYTES - 10) });
  assert.equal(exact.length, READ_BODY_MAX_BYTES);
  assert.equal((await readBoundedJson(new Request("http://127.0.0.1/read", { method: "POST", body: exact }))).ok, true, "exactly at the cap is accepted");
});

test("a declared length over the cap is refused without reading the body", async () => {
  const request = new Request("http://127.0.0.1/read", {
    method: "POST", headers: { "content-length": String(READ_BODY_MAX_BYTES + 1) }, body: "{}",
  });
  assert.deepEqual(await readBoundedJson(request), { ok: false, reason: "too_large" });
  assert.equal(request.bodyUsed, false, "the body was never read");
});

test("a streamed body that passes the cap is cancelled at the cap, not buffered", async () => {
  const chunk = new Uint8Array(32 * 1024).fill(0x20);
  let pulls = 0;
  const result = await readBoundedJson(streamed(Array.from({ length: 64 }, () => chunk), () => { pulls += 1; }));
  assert.deepEqual(result, { ok: false, reason: "too_large" });
  assert.ok(pulls <= READ_BODY_MAX_BYTES / chunk.byteLength + 2, `stopped after ${pulls} chunks of 64`);
});
