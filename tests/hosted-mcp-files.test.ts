/** Hosted MCP file_ls / file_get: argument checks and the bounded text-page reader. */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FILE_PAGE_MAX_BYTES,
  FileContentUnavailable,
  encodedBytes,
  fitTextPage,
  isTextContentType,
  readObjectPage,
  textPage,
  utf8BoundaryLength,
} from "../supabase/functions/mcp/file-content.ts";
import { HostedToolInputError, validateHostedToolArguments } from "../supabase/functions/mcp/tools.ts";

const seat = "seat_ABCDEFGHIJKLMNOPQRSTUV";
const fileId = "11111111-1111-4111-8111-111111111111";
const encoder = new TextEncoder();

test("file_ls and file_get accept only their documented arguments", () => {
  assert.deepEqual(validateHostedToolArguments("file_ls", { seat }), { seat });
  assert.deepEqual(validateHostedToolArguments("file_ls", { seat, signal_id: fileId }), { seat, signal_id: fileId });
  assert.deepEqual(validateHostedToolArguments("file_ls", { seat, offset: 50, limit: 50 }), { seat, offset: 50, limit: 50 });
  assert.deepEqual(validateHostedToolArguments("file_get", { seat, file_id: fileId, version_n: 2, offset: 10 }),
    { seat, file_id: fileId, version_n: 2, offset: 10 });
  const refused: Array<[string, Record<string, unknown>, RegExp]> = [
    ["file_ls", { seat, limit: 51 }, /Invalid limit/u],
    ["file_ls", { seat, limit: 0 }, /Invalid limit/u],
    ["file_ls", { seat, offset: -1 }, /Invalid offset/u],
    ["file_ls", { seat, offset: 1.5 }, /Invalid offset/u],
    ["file_ls", { seat, signal_id: "nope" }, /Invalid signal_id: provide the signal UUID from check whose attachments/u],
    ["file_ls", { seat, url: "https://example.com" }, /Unknown tool argument/u],
    ["file_get", { seat }, /Missing file_id/u],
    ["file_get", { seat, file_id: "x" }, /Invalid file_id/u],
    ["file_get", { seat, file_id: fileId, version_n: 0 }, /Invalid version_n/u],
    ["file_get", { seat, file_id: fileId, offset: 25 * 1024 * 1024 + 1 }, /Invalid offset/u],
    ["file_get", { seat, file_id: fileId, path: "/storage/v1/object/sign/x" }, /Unknown tool argument/u],
    ["file_get", { seat: "bad", file_id: fileId }, /Invalid seat/u],
  ];
  for (const [name, args, pattern] of refused) {
    assert.throws(() => validateHostedToolArguments(name as "file_ls" | "file_get", args),
      (error: unknown) => error instanceof HostedToolInputError && pattern.test(error.message), JSON.stringify(args));
  }
});

test("only declared text types are returned as content; PDF and binaries are metadata only", () => {
  for (const type of ["text/plain", "text/markdown", "text/csv", "text/html", "application/json", "application/yaml", "application/x-yaml"]) {
    assert.equal(isTextContentType(type), true, type);
  }
  for (const type of ["application/pdf", "image/svg+xml", "image/png", "application/zip", "text/plain; charset=utf-8", "", null]) {
    assert.equal(isTextContentType(type), false, String(type));
  }
});

test("pages never split a UTF-8 character and never loop in place", () => {
  const bytes = encoder.encode("ab€cd"); // € is three bytes at offsets 2..4
  assert.equal(utf8BoundaryLength(bytes, 3), 2);
  assert.equal(utf8BoundaryLength(bytes, 4), 2);
  assert.equal(utf8BoundaryLength(bytes, 5), 5);
  assert.equal(utf8BoundaryLength(bytes, 99), bytes.length);
  const first = textPage(bytes, 0, bytes.length, 3);
  assert.deepEqual(first, { text: "ab", offset: 0, next_offset: 2 });
  const second = textPage(bytes.subarray(2), 2, bytes.length, 99);
  assert.deepEqual(second, { text: "€cd", offset: 2, next_offset: null });
  // A page asked to start inside a character starts at the next character.
  assert.deepEqual(textPage(bytes.subarray(3), 3, bytes.length, 99), { text: "cd", offset: 5, next_offset: null });
  // A short object (fewer bytes than declared) ends paging instead of repeating the offset.
  assert.deepEqual(textPage(new Uint8Array(), 4, 10, 99), { text: "", offset: 4, next_offset: null });
  // Invalid UTF-8 is not returned as text.
  assert.equal(textPage(new Uint8Array([0x61, 0xff, 0x62]), 0, 3, 99), null);
});

test("the whole tool result fits the response budget even when escaping multiplies bytes", () => {
  const hostile = encoder.encode("\u0001\"\\".repeat(20_000));
  const maxResponse = 64 * 1024;
  const result = fitTextPage(hostile, 0, hostile.length, maxResponse, (page) => ({
    file_id: fileId, text: page.text, offset: page.offset, next_offset: page.next_offset,
  }));
  assert.ok(result !== null);
  assert.ok(encodedBytes(result) <= maxResponse - 4 * 1024, String(encodedBytes(result)));
  assert.equal(typeof result.next_offset, "number", "a shrunk page reports where to continue");
  const plain = encoder.encode("x".repeat(FILE_PAGE_MAX_BYTES * 2));
  const full = fitTextPage(plain, 0, plain.length, maxResponse, (page) => ({ text: page.text, next_offset: page.next_offset }));
  assert.equal((full?.text as string).length, FILE_PAGE_MAX_BYTES);
});

function fakeFetch(respond: (url: URL, init: RequestInit) => Response) {
  const seen: Array<{ url: string; range: string | null }> = [];
  const impl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    seen.push({ url: url.href, range: new Headers(init?.headers).get("range") });
    return respond(url, init ?? {});
  }) as typeof fetch;
  return { impl, seen };
}

const base = "http://kong.internal:8000";
const signed = "/storage/v1/object/sign/swarm-files/ws/file/v1?token=abc&download=a.txt";

test("the reader asks for one range and keeps at most one page", async () => {
  const body = encoder.encode("0123456789");
  const ranged = fakeFetch(() => new Response(body.subarray(4, 8), { status: 206 }));
  assert.deepEqual(Array.from(await readObjectPage(base, signed, 4, 4, ranged.impl)), Array.from(body.subarray(4, 8)));
  assert.equal(ranged.seen[0]!.range, "bytes=4-7");
  assert.equal(new URL(ranged.seen[0]!.url).origin, base);
  // A server that ignores Range: skip to the offset and stop after one page.
  const whole = fakeFetch(() => new Response(body, { status: 200 }));
  assert.deepEqual(Array.from(await readObjectPage(base, signed, 4, 4, whole.impl)), Array.from(body.subarray(4, 8)));
});

test("the reader refuses foreign paths and hides storage failures", async () => {
  const never = fakeFetch(() => { throw new Error("must not fetch"); });
  for (const path of ["https://evil.example/storage/v1/object/sign/x", "/storage/v1/object/public/x", "//evil.example/storage/v1/object/sign/x"]) {
    await assert.rejects(readObjectPage(base, path, 0, 10, never.impl), FileContentUnavailable, path);
  }
  assert.equal(never.seen.length, 0);
  for (const status of [400, 403, 404, 416, 500]) {
    const failing = fakeFetch(() => new Response(`storage said ${signed}`, { status }));
    await assert.rejects(readObjectPage(base, signed, 0, 10, failing.impl), (error: unknown) =>
      error instanceof FileContentUnavailable && !String((error as Error).message).includes("token"));
  }
  const thrown = fakeFetch(() => { throw new Error(`network ${signed}`); });
  await assert.rejects(readObjectPage(base, signed, 0, 10, thrown.impl), (error: unknown) =>
    error instanceof FileContentUnavailable && !(error as Error).message.includes("token"));
});
