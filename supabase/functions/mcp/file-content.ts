/** file_get content for the hosted MCP: bounded text pages from a server-resolved object.
 *
 * The command function resolves the version (workspace, household, tombstone and live
 * checks) and signs a storage path. This module fetches at most one page of bytes from
 * that path and returns text. The signed path never leaves this module: it is not in the
 * result, the error, or a log line.
 *
 * Declared text types are returned as text. Declared PNG, JPEG, GIF and WebP pictures within
 * the image cap are returned as an image only when their bytes start with that type's own
 * signature; nothing here decodes them. Everything else (PDF text is extracted elsewhere)
 * is metadata only. */

/** Raw bytes read per page before the encoded-size budget trims it. */
export const FILE_PAGE_MAX_BYTES = 32 * 1024;
/** Encoded result budget, below the protocol's response cap. */
const RESPONSE_MARGIN_BYTES = 4 * 1024;
const FETCH_TIMEOUT_MS = 15_000;

const TEXT_TYPES = new Set(["application/json", "application/yaml", "application/x-yaml"]);

export function isTextContentType(contentType: unknown): boolean {
  return typeof contentType === "string" &&
    (/^text\/[a-z0-9.+-]+$/u.test(contentType) || TEXT_TYPES.has(contentType));
}

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export function isImageContentType(contentType: unknown): boolean {
  return typeof contentType === "string" && IMAGE_TYPES.has(contentType);
}

/** The bytes must start with the declared type's own signature: the declared type alone is untrusted. */
export function imageBytesMatch(contentType: string, bytes: Uint8Array): boolean {
  const at = (index: number, ...expected: number[]) =>
    bytes.length >= index + expected.length && expected.every((byte, k) => bytes[index + k] === byte);
  const ascii = (text: string) => Array.from(text, (char) => char.charCodeAt(0));
  switch (contentType) {
    case "image/png": return at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    case "image/jpeg": return at(0, 0xff, 0xd8, 0xff);
    case "image/gif": return at(0, ...ascii("GIF87a")) || at(0, ...ascii("GIF89a"));
    case "image/webp": return at(0, ...ascii("RIFF")) && at(8, ...ascii("WEBP"));
    default: return false;
  }
}

/** Standard base64, in chunks so a large picture never builds one huge argument list. */
export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

export type ImageRead =
  | { kind: "image"; data: string; mimeType: string; bytes: number }
  | { kind: "too_large" | "not_image" };

/**
 * Read a whole stored picture from a server-resolved, signed path, within `maxBytes`.
 * The declared size was measured at commit: exactly that many bytes are kept (the reader
 * stops there, so anything a server sends past it is never consumed), a short read is
 * unavailable, and bytes that do not carry the declared type's signature are not returned.
 */
export async function readImage(
  baseUrl: string,
  signedPath: string,
  contentType: string,
  sizeBytes: number,
  maxBytes: number,
  fetchImpl: typeof fetch = fetch,
): Promise<ImageRead> {
  if (!isImageContentType(contentType)) return { kind: "not_image" };
  if (!Number.isInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > maxBytes) return { kind: "too_large" };
  if (sizeBytes === 0) return { kind: "not_image" };
  const bytes = await readObjectPage(baseUrl, signedPath, 0, sizeBytes, fetchImpl);
  if (bytes.length !== sizeBytes) throw new FileContentUnavailable();
  if (!imageBytesMatch(contentType, bytes)) return { kind: "not_image" };
  return { kind: "image", data: encodeBase64(bytes), mimeType: contentType, bytes: bytes.length };
}

export interface FileMetadata {
  file_id: string;
  version_n: number;
  name: string;
  content_type: string;
  size_bytes: number;
}

export class FileContentUnavailable extends Error {
  constructor() {
    super("file content unavailable");
    this.name = "FileContentUnavailable";
  }
}

/** Skip UTF-8 continuation bytes at the start, so a page never begins mid-character. */
function leadingContinuations(bytes: Uint8Array): number {
  let skip = 0;
  while (skip < bytes.length && skip < 3 && (bytes[skip]! & 0xc0) === 0x80) skip++;
  return skip;
}

/**
 * Length of the longest prefix (up to `limit`) that ends on a complete UTF-8 character.
 * A page can be cut by our own limit or by the fetch itself, so the last character is
 * always checked against its lead byte rather than trusted when the buffer ends.
 */
export function utf8BoundaryLength(bytes: Uint8Array, limit: number): number {
  const end = Math.min(limit, bytes.length);
  let lead = end - 1;
  while (lead >= 0 && end - lead <= 3 && (bytes[lead]! & 0xc0) === 0x80) lead--;
  if (lead < 0) return end; // Only continuation bytes: let the strict decoder reject them.
  const first = bytes[lead]!;
  const need = first < 0x80 ? 1 : (first & 0xe0) === 0xc0 ? 2 : (first & 0xf0) === 0xe0 ? 3 :
    (first & 0xf8) === 0xf0 ? 4 : 1;
  return end - lead >= need ? end : lead;
}

/**
 * Build one page from the bytes read at `offset`. Text is decoded strictly; a page that is
 * not valid UTF-8 returns null so the caller answers with metadata only.
 */
export function textPage(
  bytes: Uint8Array,
  offset: number,
  sizeBytes: number,
  maxBytes: number,
): { text: string; offset: number; next_offset: number | null } | null {
  const skip = offset === 0 ? 0 : leadingContinuations(bytes);
  const body = bytes.subarray(skip);
  const length = utf8BoundaryLength(body, maxBytes);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body.subarray(0, length));
  } catch {
    return null;
  }
  const start = offset + skip;
  const end = start + length;
  // An empty page ends paging even if the declared size says more: never loop in place.
  return { text, offset: start, next_offset: end < sizeBytes && length > 0 ? end : null };
}

/** The bytes a result costs on the wire: it is stringified into a text content block. */
export function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(JSON.stringify(value))).byteLength;
}

/**
 * Shrink the page until the whole tool result fits the response budget. Escaping can
 * multiply a byte several times, so the budget is measured on the encoded result.
 */
export function fitTextPage(
  bytes: Uint8Array,
  offset: number,
  sizeBytes: number,
  maxResponseBytes: number,
  build: (page: { text: string; offset: number; next_offset: number | null }) => Record<string, unknown>,
): Record<string, unknown> | null {
  const budget = Math.max(1024, maxResponseBytes - RESPONSE_MARGIN_BYTES);
  let maxBytes = Math.min(FILE_PAGE_MAX_BYTES, bytes.length);
  for (let attempt = 0; attempt < 12; attempt++) {
    const page = textPage(bytes, offset, sizeBytes, maxBytes);
    if (page === null) return null;
    const result = build(page);
    const cost = encodedBytes(result);
    if (cost <= budget) return result;
    maxBytes = Math.max(64, Math.floor(maxBytes * (budget / cost) * 0.9));
  }
  throw new FileContentUnavailable();
}

/**
 * Read at most `maxBytes` from `offset` of a server-resolved, signed storage path.
 * Uses a Range request and also handles a server that ignores Range. Never reads more
 * than offset + maxBytes and never echoes the path or a storage error.
 */
export async function readObjectPage(
  baseUrl: string,
  signedPath: string,
  offset: number,
  maxBytes: number,
  fetchImpl: typeof fetch = fetch,
): Promise<Uint8Array> {
  if (!signedPath.startsWith("/storage/v1/object/sign/")) throw new FileContentUnavailable();
  const url = new URL(signedPath, baseUrl);
  if (url.origin !== new URL(baseUrl).origin) throw new FileContentUnavailable();
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { range: `bytes=${offset}-${offset + maxBytes - 1}` },
      redirect: "error",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    throw new FileContentUnavailable();
  }
  if (response.status !== 206 && response.status !== 200) {
    await response.body?.cancel().catch(() => {});
    throw new FileContentUnavailable();
  }
  const skip = response.status === 206 ? 0 : offset;
  const out = new Uint8Array(maxBytes);
  let kept = 0;
  let seen = 0;
  const reader = response.body?.getReader();
  if (reader === undefined) return out.subarray(0, 0);
  try {
    while (kept < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      let chunk = value;
      if (seen < skip) {
        const drop = Math.min(skip - seen, chunk.length);
        seen += drop;
        chunk = chunk.subarray(drop);
      }
      const take = Math.min(chunk.length, maxBytes - kept);
      out.set(chunk.subarray(0, take), kept);
      kept += take;
    }
  } catch {
    throw new FileContentUnavailable();
  } finally {
    await reader.cancel().catch(() => {});
  }
  return out.subarray(0, kept);
}

/** Upload `bytes` to a server-resolved, signed upload path. Returns false on any refusal, a
 * duplicate included: commit measures the stored object, so the caller always tries commit
 * and lets that decide. Never echoes the path, the token or a storage error. */
export async function putObjectBytes(
  baseUrl: string,
  signedPath: string,
  bytes: Uint8Array,
  contentType: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (!signedPath.startsWith("/storage/v1/object/upload/sign/")) throw new FileContentUnavailable();
  const url = new URL(signedPath, baseUrl);
  if (url.origin !== new URL(baseUrl).origin) throw new FileContentUnavailable();
  try {
    const response = await fetchImpl(url, {
      method: "PUT",
      headers: { "content-type": contentType },
      body: bytes as Uint8Array<ArrayBuffer>,
      redirect: "error",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    await response.body?.cancel().catch(() => {});
    return response.ok;
  } catch {
    return false;
  }
}

/** Strict standard base64 to bytes; the tool validator already capped the decoded size. */
export function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) out[index] = binary.charCodeAt(index);
  return out;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Deterministic ids for one file_put. Command ids bind (workspace, seat, request_id); the
 * file and version ids also bind the content digest. So a retry with the same content is a
 * ledger replay, and a retry with any changed content changes the reserve command itself and
 * is refused as command_id_conflict before a reservation can be reused. Version nibble 8
 * (custom), RFC 4122 variant.
 */
export async function putIds(workspaceId: string, seatHandle: string, requestId: string, sha256: string): Promise<{
  file_id: string; version_id: string; create_command_id: string; commit_command_id: string;
}> {
  const id = async (label: string, content: string) => {
    const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256",
      new TextEncoder().encode(["hosted-file-put", workspaceId, seatHandle, requestId, content, label].join("\0"))));
    bytes[6] = (bytes[6]! & 0x0f) | 0x80;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = Array.from(bytes.subarray(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  };
  return {
    file_id: await id("file", sha256),
    version_id: await id("version", sha256),
    create_command_id: await id("create", ""),
    commit_command_id: await id("commit", ""),
  };
}

/* PDF text (1b). The bytes go to the edge main service's internal path, which runs the
 * parser in an isolated, limited worker. This module never parses a PDF itself. */

export const PDF_TEXT_MAX_INPUT_BYTES = 8 * 1024 * 1024;
const PDF_TEXT_URL = "http://127.0.0.1:9000/__internal/file-text";
const PDF_TEXT_TIMEOUT_MS = 20_000;
const PDF_CACHE_TTL_MS = 10 * 60_000;
const PDF_CACHE_MAX_ENTRIES = 8;
const PDF_CACHE_MAX_BYTES = 4 * 1024 * 1024;

export type PdfTextResult =
  | { kind: "text"; bytes: Uint8Array; truncated: boolean; pages_read: number; page_count: number }
  | { kind: "busy" | "too_complex" | "too_large" | "unavailable" };

interface CacheEntry { at: number; result: PdfTextResult }
const pdfCache = new Map<string, CacheEntry>();
const pdfInFlight = new Map<string, Promise<PdfTextResult>>();

function cacheBytes(): number {
  let total = 0;
  for (const entry of pdfCache.values()) if (entry.result.kind === "text") total += entry.result.bytes.byteLength;
  return total;
}

function remember(key: string, result: PdfTextResult, now: number): void {
  // Cache text and known-complex PDFs; never transient answers (busy, unavailable).
  if (result.kind !== "text" && result.kind !== "too_complex") return;
  pdfCache.delete(key);
  pdfCache.set(key, { at: now, result });
  while (pdfCache.size > PDF_CACHE_MAX_ENTRIES || cacheBytes() > PDF_CACHE_MAX_BYTES) {
    const oldest = pdfCache.keys().next().value;
    if (oldest === undefined) break;
    pdfCache.delete(oldest);
  }
}

/**
 * Text for one authorized (workspace, file, version). Callers must have completed that
 * call's own file authorization first: the cache is never an access path. Concurrent calls
 * for the same version share one extraction.
 */
export async function pdfTextFor(
  key: string,
  loadBytes: () => Promise<Uint8Array>,
  token: string | null | undefined,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<PdfTextResult> {
  const cached = pdfCache.get(key);
  if (cached && now() - cached.at < PDF_CACHE_TTL_MS) return cached.result;
  if (cached) pdfCache.delete(key);
  const running = pdfInFlight.get(key);
  if (running) return await running;
  const work = (async (): Promise<PdfTextResult> => {
    if (!token) return { kind: "unavailable" };
    let bytes: Uint8Array;
    try { bytes = await loadBytes(); } catch { return { kind: "unavailable" }; }
    let response: Response;
    try {
      response = await fetchImpl(PDF_TEXT_URL, {
        method: "POST",
        headers: { "x-commonswarm-file-text": token, "content-type": "application/pdf" },
        body: bytes as Uint8Array<ArrayBuffer>,
        redirect: "error",
        signal: AbortSignal.timeout(PDF_TEXT_TIMEOUT_MS),
      });
    } catch {
      return { kind: "unavailable" };
    }
    let body: Record<string, unknown> | null = null;
    try { body = await response.json() as Record<string, unknown>; } catch { body = null; }
    if (response.status === 503) return { kind: "busy" };
    if (response.status === 413) return { kind: "too_large" };
    if (response.status === 422 && body?.error === "pdf_too_complex") return { kind: "too_complex" };
    if (response.status !== 200 || body === null || typeof body.text !== "string") return { kind: "unavailable" };
    return {
      kind: "text",
      bytes: new TextEncoder().encode(body.text),
      truncated: body.truncated === true,
      pages_read: Number(body.pages_read) || 0,
      page_count: Number(body.page_count) || 0,
    };
  })();
  pdfInFlight.set(key, work);
  try {
    const result = await work;
    remember(key, result, now());
    return result;
  } finally {
    pdfInFlight.delete(key);
  }
}

/** For tests only: the cache is process-local and starts empty in every worker. */
export function resetPdfTextCache(): void {
  pdfCache.clear();
  pdfInFlight.clear();
}
