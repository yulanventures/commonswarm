/** file_get content for the hosted MCP: bounded text pages from a server-resolved object.
 *
 * The command function resolves the version (workspace, household, tombstone and live
 * checks) and signs a storage path. This module fetches at most one page of bytes from
 * that path and returns text. The signed path never leaves this module: it is not in the
 * result, the error, or a log line.
 *
 * Only declared text types are returned as content. Everything else, PDF included, is
 * metadata only until a parser can run with enforced work and memory limits. */

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
