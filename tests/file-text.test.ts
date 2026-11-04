/** MCP parity 1b: bounded PDF text. The extractor, main's internal gateway and the mcp
 * cache, with fakes in place of the runtime and the parser. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { extractSequential, type PdfDocument } from "../supabase/functions/file-text/extract.ts";
import {
  FILE_TEXT_MAX_INPUT_BYTES,
  FILE_TEXT_PERMISSIONS,
  FILE_TEXT_TOKEN_HEADER,
  FILE_TEXT_WORKER_LIMITS,
  createFileTextGateway,
} from "../deploy/edge-runtime/main/file-text.ts";
import { pdfTextFor, resetPdfTextCache } from "../supabase/functions/mcp/file-content.ts";

function fakeDoc(pages: string[], numPages = pages.length) {
  let inFlight = 0;
  let maxInFlight = 0;
  const requested: number[] = [];
  const doc: PdfDocument = {
    numPages,
    getPage: async (n) => {
      requested.push(n);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      return {
        getTextContent: async () => ({ items: [{ str: pages[n - 1] ?? "", hasEOL: true }, { notText: true } as never] }),
        cleanup: () => { throw new Error("cleanup failure is ignored"); },
      };
    },
  };
  return { doc, requested, maxInFlight: () => maxInFlight };
}

test("pages are read one at a time and stop at the page cap", async () => {
  const pages = Array.from({ length: 10 }, (_, i) => `page ${i + 1}`);
  const fake = fakeDoc(pages);
  const result = await extractSequential(fake.doc, { maxPages: 4 });
  assert.deepEqual(fake.requested, [1, 2, 3, 4], "never asks for pages past the cap");
  assert.equal(fake.maxInFlight(), 1, "never fans out");
  assert.equal(result.pages_read, 4);
  assert.equal(result.page_count, 10);
  assert.equal(result.truncated, true);
  assert.equal(result.text, "page 1\n\n\npage 2\n\n\npage 3\n\n\npage 4\n");
});

test("output stops at the byte cap on a UTF-8 boundary, without reading further pages", async () => {
  const fake = fakeDoc(["€€€€", "never read"]);
  const result = await extractSequential(fake.doc, { maxBytes: 7 }); // € is 3 bytes
  assert.equal(result.text, "€€");
  assert.equal(result.truncated, true);
  assert.deepEqual(fake.requested, [1]);
  const empty = await extractSequential(fakeDoc([], Number.NaN).doc);
  assert.deepEqual(empty, { text: "", pages_read: 0, page_count: 0, truncated: false });
});

const token = "t".repeat(40);
function gateway(options: { present?: () => Set<string>; workerFetch?: (request: Request) => Promise<Response>; limitError?: boolean } = {}) {
  const created: Array<Record<string, unknown>> = [];
  const forwarded: Request[] = [];
  const tagged: Array<[Request, Request]> = [];
  let next = 0;
  const handle = createFileTextGateway({
    token,
    servicePath: "/var/tmp/commonswarm-functions/file-text",
    workers: {
      create: async (opts) => {
        created.push(opts);
        const key = `parser-${++next}`;
        return {
          key,
          fetch: async (request: Request) => {
            forwarded.push(request);
            if (options.limitError) throw Object.assign(new Error("limit"), { name: "WorkerLimit" });
            return options.workerFetch ? await options.workerFetch(request)
              : new Response(JSON.stringify({ text: "hello", truncated: false, pages_read: 1, page_count: 1 }), { status: 200 });
          },
        };
      },
      memStats: async () => new Map([...(options.present?.() ?? new Set<string>())].map((key) => [key, {}])),
    },
    isWorkerLimitError: (error) => error instanceof Error && error.name === "WorkerLimit",
    applyTag: (original, next) => { tagged.push([original, next]); },
  });
  return { handle, created, forwarded, tagged };
}

const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
function post(headers: Record<string, string> = {}, body: BodyInit | null = pdf as Uint8Array<ArrayBuffer>) {
  return new Request("http://127.0.0.1:9000/__internal/file-text", {
    method: "POST",
    headers: { [FILE_TEXT_TOKEN_HEADER]: token, "content-length": String(pdf.length), "x-caller": "secret", ...headers },
    body,
  });
}

test("loopback and the token are both required, before the body is read or a worker exists", async () => {
  const { handle, created } = gateway();
  for (const [request, peer] of [
    [post(), "10.0.0.5"],
    [post(), null],
    [post({ [FILE_TEXT_TOKEN_HEADER]: "wrong" }), "127.0.0.1"],
    [post({ [FILE_TEXT_TOKEN_HEADER]: "" }), "127.0.0.1"],
    [new Request("http://127.0.0.1:9000/__internal/file-text", { method: "GET", headers: { [FILE_TEXT_TOKEN_HEADER]: token } }), "127.0.0.1"],
  ] as const) {
    const response = await handle(request, peer);
    assert.equal(response.status, 404, String(peer));
  }
  assert.equal(created.length, 0);
  const short = createFileTextGateway({ token: "short", servicePath: "x", workers: { create: async () => { throw new Error("no"); }, memStats: async () => ({}) }, isWorkerLimitError: () => false, applyTag: () => {} });
  assert.equal((await short(post({ [FILE_TEXT_TOKEN_HEADER]: "short" }), "127.0.0.1")).status, 404, "a weak token disables the path");
});

test("the parser gets a fresh, limited, permission-denied worker and none of the caller's headers", async () => {
  const { handle, created, forwarded, tagged } = gateway();
  const original = post();
  const response = await handle(original, "127.0.0.1");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { text: "hello", truncated: false, pages_read: 1, page_count: 1 });
  assert.equal(created.length, 1);
  const options = created[0]!;
  assert.deepEqual(options.envVars, []);
  assert.equal(options.forceCreate, true);
  assert.equal(options.allowRemoteModules, false);
  assert.deepEqual(options.permissions, FILE_TEXT_PERMISSIONS);
  for (const [key, value] of Object.entries(FILE_TEXT_WORKER_LIMITS)) assert.equal(options[key], value, key);
  // v1.73.13 JsPermissionsOptions keys are snake_case (no serde rename).
  assert.deepEqual(Object.keys(FILE_TEXT_PERMISSIONS).sort(), ["allow_all", "deny_env", "deny_ffi", "deny_net",
    "deny_read", "deny_run", "deny_sys", "deny_write"]);
  assert.equal((FILE_TEXT_PERMISSIONS as Record<string, unknown>).allow_all, false);
  for (const kind of ["net", "read", "write", "run", "env", "sys", "ffi"]) {
    assert.deepEqual((FILE_TEXT_PERMISSIONS as Record<string, unknown>)[`deny_${kind}`], [], `deny_${kind} denies all`);
  }
  assert.equal(tagged.length, 1, "the runtime tag is copied onto the forwarded request");
  assert.equal(tagged[0]![0], original);
  assert.equal(tagged[0]![1], forwarded[0]);
  const sent = forwarded[0]!;
  assert.equal(sent.headers.get(FILE_TEXT_TOKEN_HEADER), null, "the token never reaches the parser");
  assert.equal(sent.headers.get("x-caller"), null);
  assert.equal(new URL(sent.url).hostname, "file-text.internal");
});

test("one live parser at a time, counted until the runtime no longer lists it; no queue", async () => {
  let present = new Set<string>();
  let releaseFirst!: () => void;
  const firstDone = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const { handle, created } = gateway({
    present: () => present,
    workerFetch: async () => {
      await firstDone;
      return new Response(JSON.stringify({ text: "x", truncated: false, pages_read: 1, page_count: 1 }), { status: 200 });
    },
  });
  const first = handle(post(), "127.0.0.1");
  await new Promise((resolve) => setTimeout(resolve, 5));
  present = new Set(["parser-1"]);
  assert.deepEqual(await (await handle(post(), "127.0.0.1")).json(), { error: "busy" }, "busy while the first parses");
  releaseFirst();
  assert.equal((await first).status, 200);
  assert.equal((await handle(post(), "127.0.0.1")).status, 503, "still busy while its isolate lingers after answering");
  assert.equal(created.length, 1);
  present = new Set();
  assert.equal((await handle(post(), "127.0.0.1")).status, 200, "free once the isolate is gone");
  assert.equal(created.length, 2);
});

test("bounded input, fixed errors, and the limit kill maps to pdf_too_complex", async () => {
  const { handle, created } = gateway();
  assert.equal((await handle(post({ "content-length": String(FILE_TEXT_MAX_INPUT_BYTES + 1) }), "127.0.0.1")).status, 413);
  assert.equal((await handle(post({ "content-length": "abc" }), "127.0.0.1")).status, 413);
  assert.equal((await handle(post({ "content-length": "2" }), "127.0.0.1")).status, 413, "more bytes than declared");
  assert.equal(created.length, 0);
  const killed = gateway({ limitError: true });
  assert.deepEqual(await (await killed.handle(post(), "127.0.0.1")).json(), { error: "pdf_too_complex" });
  const garbled = gateway({ workerFetch: async () => new Response("{\"text\":1}", { status: 200 }) });
  assert.deepEqual(await (await garbled.handle(post(), "127.0.0.1")).json(), { error: "pdf_unreadable" });
  const refused = gateway({ workerFetch: async () => new Response("parser said: secret text", { status: 422 }) });
  const body = await (await refused.handle(post(), "127.0.0.1")).text();
  assert.equal(body, JSON.stringify({ error: "pdf_unreadable" }), "parser output never passes through on error");
});

test("mcp: one extraction per version, cached; busy is not cached; no token means no call", async () => {
  resetPdfTextCache();
  let calls = 0;
  const seen: Array<{ url: string; token: string | null }> = [];
  let answer: () => Response = () => new Response(JSON.stringify({ text: "Ünïcode text", truncated: false, pages_read: 2, page_count: 2 }), { status: 200 });
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    calls++;
    seen.push({ url: String(input), token: new Headers(init?.headers).get(FILE_TEXT_TOKEN_HEADER) });
    await new Promise((resolve) => setTimeout(resolve, 5));
    return answer();
  }) as typeof fetch;
  let loads = 0;
  const load = async () => { loads++; return pdf; };
  const [a, b] = await Promise.all([pdfTextFor("ws:f:1", load, token, fetchImpl), pdfTextFor("ws:f:1", load, token, fetchImpl)]);
  assert.equal(calls, 1, "single flight");
  assert.equal(loads, 1);
  assert.equal(a, b);
  assert.equal(a.kind, "text");
  assert.equal(new TextDecoder().decode((a as { bytes: Uint8Array }).bytes), "Ünïcode text");
  await pdfTextFor("ws:f:1", load, token, fetchImpl);
  assert.equal(calls, 1, "cached for the same version");
  assert.deepEqual(seen[0], { url: "http://127.0.0.1:9000/__internal/file-text", token });

  answer = () => new Response(JSON.stringify({ error: "busy" }), { status: 503 });
  assert.equal((await pdfTextFor("ws:f:2", load, token, fetchImpl)).kind, "busy");
  await pdfTextFor("ws:f:2", load, token, fetchImpl);
  assert.equal(calls, 3, "busy is retried, not cached");
  answer = () => new Response(JSON.stringify({ error: "pdf_too_complex" }), { status: 422 });
  assert.equal((await pdfTextFor("ws:f:3", load, token, fetchImpl)).kind, "too_complex");
  await pdfTextFor("ws:f:3", load, token, fetchImpl);
  assert.equal(calls, 4, "a known-complex PDF is not parsed again right away");

  const before = calls;
  assert.equal((await pdfTextFor("ws:f:4", load, undefined, fetchImpl)).kind, "unavailable");
  assert.equal(calls, before, "no token, no internal call");
  resetPdfTextCache();
});
