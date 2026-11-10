/** Local stdio MCP file_get: a stored picture as an MCP image block, under the same rule as the hosted tool. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { MCP_IMAGE_MAX_BYTES, imageBytesMatch as localMatch, isImageContentType as localImage, mcpFileGet } from "../src/mcp/file-image.js";
import { imageBytesMatch as hostedMatch, isImageContentType as hostedImage } from "../supabase/functions/mcp/file-content.js";
import { FILE_GET_IMAGE_MAX_BYTES } from "../supabase/functions/mcp/tools.js";

const target = { url: "http://api.test", anonKey: "anon", profileId: "p" };
const fileId = "11111111-1111-4111-8111-111111111111";
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const encoder = new TextEncoder();

function fake(grant: Record<string, unknown>, bytes: Uint8Array) {
  const seen: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    seen.push(url);
    if (url.endsWith("/functions/v1/command")) return new Response(JSON.stringify(grant), { status: 200 });
    return new Response(bytes as Uint8Array<ArrayBuffer>, { status: 200 });
  }) as typeof fetch;
  return { fetcher, seen };
}
const grant = (overrides: Record<string, unknown> = {}) => ({
  file_id: fileId, version_n: 2, name: "shot.png", size_bytes: PNG.length, content_type: "image/png",
  download_path: "/storage/v1/object/sign/swarm-files/w/f/2?token=secret", download_url_expires_in_seconds: 300,
  content_warning: "untrusted", ...overrides,
});
const call = (f: ReturnType<typeof fake>) => mcpFileGet({ target, workspaceId: "w", credential: "agent-token", fetcher: f.fetcher, fileId, versionN: 2 });

test("local and hosted file_get share the picture rule: types, signatures and the 2 MiB cap", () => {
  assert.equal(MCP_IMAGE_MAX_BYTES, FILE_GET_IMAGE_MAX_BYTES);
  const types = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml", "image/heic", "text/plain", ""];
  for (const type of types) assert.equal(localImage(type), hostedImage(type), type);
  const samples = [PNG, Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]), encoder.encode("GIF89a.."), encoder.encode("GIF87a.."),
    encoder.encode("RIFF\x00\x00\x00\x00WEBPVP8 "), encoder.encode("RIFF\x00\x00\x00\x00WAVE"), encoder.encode("<svg/>"), PNG.subarray(0, 7)];
  for (const type of types) for (const bytes of samples) assert.equal(localMatch(type, bytes), hostedMatch(type, bytes), `${type} ${Array.from(bytes.subarray(0, 4))}`);
});

test("a stored PNG comes back as an image block with its details, and the signed path never leaves", async () => {
  const f = fake(grant(), PNG);
  const read = await call(f);
  assert.deepEqual(read.image, { data: Buffer.from(PNG).toString("base64"), mimeType: "image/png" });
  assert.deepEqual(read.output, { file_id: fileId, version_n: 2, name: "shot.png", content_type: "image/png", size_bytes: PNG.length,
    content_warning: "untrusted", encoding: "image" });
  assert.equal(f.seen.length, 2);
  assert.equal(f.seen[1], "http://api.test/storage/v1/object/sign/swarm-files/w/f/2?token=secret");
  assert.equal(JSON.stringify(read.output).includes("token"), false);
});

test("the local reader stops at the declared size, however much the server streams", async () => {
  let pulled = 0;
  const chunk = new Uint8Array(64 * 1024);
  const endless = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(PNG); },
    pull(controller) { pulled += chunk.length; controller.enqueue(chunk); },
  });
  const seen: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    seen.push(url);
    if (url.endsWith("/functions/v1/command")) return new Response(JSON.stringify(grant()), { status: 200 });
    return new Response(endless, { status: 200 });
  }) as typeof fetch;
  const read = await mcpFileGet({ target, workspaceId: "w", credential: "agent-token", fetcher, fileId, versionN: 2 });
  assert.deepEqual(read.image, { data: Buffer.from(PNG).toString("base64"), mimeType: "image/png" });
  assert.ok(pulled <= 2 * chunk.length, `consumed ${pulled} bytes past the declared size`);
});

test("other types, oversize pictures and bytes that are not the declared picture return details and the CLI step only", async () => {
  const cases: Array<[Record<string, unknown>, Uint8Array, RegExp, number]> = [
    [{ name: "notes.txt", content_type: "text/plain", size_bytes: 5 }, encoder.encode("hello"), /returns pictures/u, 1],
    [{ name: "logo.svg", content_type: "image/svg+xml", size_bytes: 6 }, encoder.encode("<svg/>"), /returns pictures/u, 1],
    [{ size_bytes: MCP_IMAGE_MAX_BYTES + 1 }, PNG, /larger than 2 MiB/u, 1],
    [{ size_bytes: 18 }, encoder.encode("<html>hello</html>"), /do not match/u, 2],
    [{ size_bytes: PNG.length + 4 }, PNG, /do not match/u, 2],
  ];
  for (const [overrides, bytes, pattern, fetches] of cases) {
    const f = fake(grant(overrides), bytes);
    const read = await call(f);
    assert.equal(read.image, null, JSON.stringify(overrides));
    assert.match(String(read.output.next_step), pattern);
    assert.match(String(read.output.next_step), new RegExp(`cswarm file get ${fileId} --version 2`, "u"));
    assert.equal(read.output.content_warning, "untrusted");
    assert.equal(f.seen.length, fetches, "no bytes are read for a non-picture or an oversize one");
  }
});
