/** Hosted MCP file_ls / file_get: argument checks and the bounded text-page reader. */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FILE_PAGE_MAX_BYTES,
  FileContentUnavailable,
  encodedBytes,
  fitTextPage,
  imageBytesMatch,
  isImageContentType,
  isTextContentType,
  readImage,
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
  // The fetch itself can end mid-character: trim it instead of rejecting valid text.
  assert.equal(utf8BoundaryLength(bytes.subarray(0, 4), 99), 2);
  assert.deepEqual(textPage(bytes.subarray(0, 4), 0, bytes.length, 99), { text: "ab", offset: 0, next_offset: 2 });
  const emoji = encoder.encode("a😀"); // four-byte character
  assert.equal(utf8BoundaryLength(emoji.subarray(0, 4), 99), 1);
  assert.equal(utf8BoundaryLength(emoji, 99), 5);
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

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const signatures: Array<[string, Uint8Array]> = [
  ["image/png", PNG],
  ["image/jpeg", Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16])],
  ["image/gif", encoder.encode("GIF89a\x01\x00")],
  ["image/gif", encoder.encode("GIF87a\x01\x00")],
  ["image/webp", encoder.encode("RIFF\x00\x00\x00\x00WEBPVP8 ")],
];

test("a picture is returned only for PNG, JPEG, GIF and WebP whose bytes carry that type's signature", () => {
  for (const type of ["image/png", "image/jpeg", "image/gif", "image/webp"]) assert.equal(isImageContentType(type), true, type);
  for (const type of ["image/svg+xml", "image/heic", "image/jpg", "text/html", "", null]) assert.equal(isImageContentType(type), false, String(type));
  for (const [type, bytes] of signatures) assert.equal(imageBytesMatch(type, bytes), true, type);
  // Each signature under every other declared type, a cut signature, and HTML that calls itself a PNG.
  for (const [type] of signatures) {
    for (const [other, bytes] of signatures) if (other !== type) assert.equal(imageBytesMatch(type, bytes), false, `${other} bytes as ${type}`);
  }
  assert.equal(imageBytesMatch("image/png", PNG.subarray(0, 7)), false);
  assert.equal(imageBytesMatch("image/webp", encoder.encode("RIFF\x00\x00\x00\x00WAVE")), false);
  assert.equal(imageBytesMatch("image/png", encoder.encode("<html><script>alert(1)</script>")), false);
  assert.equal(imageBytesMatch("image/svg+xml", encoder.encode("<svg/>")), false);
});

test("the picture reader stays within the cap, reads the whole declared size, and returns base64 of exactly those bytes", async () => {
  const never = fakeFetch(() => { throw new Error("must not fetch"); });
  assert.deepEqual(await readImage(base, signed, "image/png", 2049, 2048, never.impl), { kind: "too_large" });
  assert.deepEqual(await readImage(base, signed, "image/svg+xml", 10, 2048, never.impl), { kind: "not_image" });
  assert.deepEqual(await readImage(base, signed, "image/png", 0, 2048, never.impl), { kind: "not_image" });
  assert.equal(never.seen.length, 0, "no byte is read past the cap or for a non-picture type");

  const exact = fakeFetch(() => new Response(PNG, { status: 200 }));
  const image = await readImage(base, signed, "image/png", PNG.length, 2048, exact.impl);
  assert.deepEqual(image, { kind: "image", data: Buffer.from(PNG).toString("base64"), mimeType: "image/png", bytes: PNG.length });
  assert.equal(exact.seen[0]!.range, `bytes=0-${PNG.length - 1}`);

  const disguised = fakeFetch(() => new Response(encoder.encode("<html>hello</html>"), { status: 200 }));
  assert.deepEqual(await readImage(base, signed, "image/png", 18, 2048, disguised.impl), { kind: "not_image" });
  const short = fakeFetch(() => new Response(PNG.subarray(0, 10), { status: 200 }));
  await assert.rejects(readImage(base, signed, "image/png", PNG.length, 2048, short.impl), FileContentUnavailable);
  // A server that sends more than the declared size: only the declared bytes are kept.
  const longer = fakeFetch(() => new Response(Uint8Array.from([...PNG, 1, 2, 3, 4]), { status: 200 }));
  assert.deepEqual(await readImage(base, signed, "image/png", PNG.length, 2048, longer.impl),
    { kind: "image", data: Buffer.from(PNG).toString("base64"), mimeType: "image/png", bytes: PNG.length });
});

test("file_put takes exactly one bounded content form and an allowed name; posts take bounded attachments", async () => {
  const { FILE_PUT_MAX_BYTES } = await import("../supabase/functions/mcp/tools.ts");
  const ok = { seat, name: "notes.md", content: "# Notes", request_id: "put_request_1" };
  assert.deepEqual(validateHostedToolArguments("file_put", ok), ok);
  assert.ok(validateHostedToolArguments("file_put", { seat, name: "scan.pdf", content_base64: "JVBERi0=", request_id: "put_request_2" }));
  const refused: Array<[string, Record<string, unknown>, RegExp]> = [
    ["file_put", { seat, name: "notes.md", request_id: "put_request_1" }, /Invalid content/u],
    ["file_put", { seat, name: "notes.md", content: "a", content_base64: "YQ==", request_id: "put_request_1" }, /Invalid content/u],
    ["file_put", { seat, name: "notes.md", content: "é".repeat(FILE_PUT_MAX_BYTES / 2 + 1), request_id: "put_request_1" }, /Invalid content/u],
    ["file_put", { seat, name: "x.pdf", content_base64: "A".repeat(4 * Math.ceil((FILE_PUT_MAX_BYTES + 3) / 3)), request_id: "put_request_1" }, /Invalid content/u],
    ["file_put", { seat, name: "x.pdf", content_base64: "not base64!", request_id: "put_request_1" }, /Invalid content/u],
    ["file_put", { seat, name: "x.pdf", content_base64: "YQ=", request_id: "put_request_1" }, /Invalid content/u],
    ["file_put", { seat, name: "run.exe", content: "x", request_id: "put_request_1" }, /Invalid name/u],
    ["file_put", { seat, name: "../notes.md", content: "x", request_id: "put_request_1" }, /Invalid name/u],
    ["file_put", { seat, name: " notes.md", content: "x", request_id: "put_request_1" }, /Invalid name/u],
    ["file_put", { seat, name: "notes.md", content: "x", request_id: "!" }, /Invalid request_id/u],
    ["file_put", { seat, name: "notes.md", content: "x", request_id: "put_request_1", path: "/etc/passwd" }, /Unknown tool argument/u],
  ];
  for (const [name, args, pattern] of refused) {
    assert.throws(() => validateHostedToolArguments(name as "file_put", args),
      (error: unknown) => error instanceof HostedToolInputError && pattern.test(error.message), JSON.stringify(args).slice(0, 120));
  }
  const note = { seat, body: "see attached", request_id: "note_request_1" };
  const pair = { file_id: fileId, version_n: 1 };
  assert.ok(validateHostedToolArguments("note", { ...note, attachments: [pair] }));
  for (const attachments of [[], [pair, pair], Array.from({ length: 9 }, (_, n) => ({ file_id: fileId, version_n: n + 1 })),
    [{ ...pair, name: "x" }], [{ file_id: "x", version_n: 1 }], [{ file_id: fileId, version_n: 0 }]]) {
    assert.throws(() => validateHostedToolArguments("note", { ...note, attachments }), /Invalid attachments/u, JSON.stringify(attachments).slice(0, 80));
  }
  assert.throws(() => validateHostedToolArguments("working_on", { seat, body: "x", request_id: "work_request_1", attachments: [pair] }),
    /Unknown tool argument/u);
});

test("file_put ids are stable per seat, request and content, and distinct otherwise", async () => {
  const { putIds } = await import("../supabase/functions/mcp/file-content.ts");
  const a = await putIds("ws-1", "seat_a", "req_1", "aa");
  assert.deepEqual(await putIds("ws-1", "seat_a", "req_1", "aa"), a);
  for (const other of [await putIds("ws-1", "seat_a", "req_2", "aa"), await putIds("ws-1", "seat_b", "req_1", "aa"), await putIds("ws-2", "seat_a", "req_1", "aa")]) {
    assert.notEqual(other.file_id, a.file_id);
    assert.notEqual(other.create_command_id, a.create_command_id);
  }
  // Changed content keeps the command ids (so the ledger sees the same id) but changes the
  // reserved ids (so the reserve command differs): command_id_conflict, never a reused slot.
  const changed = await putIds("ws-1", "seat_a", "req_1", "bb");
  assert.equal(changed.create_command_id, a.create_command_id);
  assert.equal(changed.commit_command_id, a.commit_command_id);
  assert.notEqual(changed.version_id, a.version_id);
  assert.notEqual(changed.file_id, a.file_id);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
  for (const value of Object.values(a)) assert.match(value, uuid);
  assert.equal(new Set(Object.values(a)).size, 4);
});
