/**
 * Local MCP file_get: a stored picture as an MCP image block, the same rule as the hosted
 * tool (supabase/functions/mcp/file-content.ts). Declared PNG, JPEG, GIF and WebP files up
 * to MCP_IMAGE_MAX_BYTES are returned only when their bytes start with that type's own
 * signature; nothing here decodes them. Every other file is metadata plus the CLI command
 * that downloads it. The signed download path never leaves this module.
 */
import { FileTransportError, absoluteStorageUrl, fileDownloadUrl } from "../cloud/files.js";
import type { CloudTarget } from "../cloud/config.js";

/** Matches FILE_GET_IMAGE_MAX_BYTES in supabase/functions/mcp/tools.ts. */
export const MCP_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
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

const READ_TIMEOUT_MS = 30_000;

/** Read at most `maxBytes` of a signed object, stopping the stream there; excess bytes are never consumed. */
export async function readBounded(url: string, maxBytes: number, fetcher: typeof fetch = fetch): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetcher(url, { redirect: "error", signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
  } catch {
    throw new FileTransportError("the download did not complete", true);
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new FileTransportError(`the download was refused (HTTP ${response.status})`);
  }
  const reader = response.body.getReader();
  const out = new Uint8Array(maxBytes);
  let kept = 0;
  try {
    while (kept < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const take = Math.min(value.length, maxBytes - kept);
      out.set(value.subarray(0, take), kept);
      kept += take;
    }
  } catch {
    throw new FileTransportError("the download did not complete", true);
  } finally {
    await reader.cancel().catch(() => {});
  }
  return out.subarray(0, kept);
}

export interface McpFileGetInput {
  target: CloudTarget;
  workspaceId: string;
  credential: string;
  fetcher?: typeof fetch;
  fileId: string;
  versionN: number | null;
}

export interface McpFileGetResult {
  output: Record<string, unknown>;
  image: { data: string; mimeType: string } | null;
}

export async function mcpFileGet(input: McpFileGetInput): Promise<McpFileGetResult> {
  const grant = await fileDownloadUrl(
    { target: input.target, workspaceId: input.workspaceId, credential: input.credential, ...(input.fetcher ? { fetcher: input.fetcher } : {}) },
    { fileId: input.fileId, versionN: input.versionN },
  );
  const meta = {
    file_id: grant.file_id,
    version_n: grant.version_n,
    name: grant.name,
    content_type: grant.content_type,
    size_bytes: grant.size_bytes,
    content_warning: grant.content_warning,
  };
  const download = `Run cswarm file get ${grant.file_id} --version ${grant.version_n} to download it to this host.`;
  if (!isImageContentType(grant.content_type)) {
    return { output: { ...meta, image: null, next_step: `This tool returns pictures (PNG, JPEG, GIF, WebP). ${download}` }, image: null };
  }
  if (!Number.isSafeInteger(grant.size_bytes) || grant.size_bytes <= 0 || grant.size_bytes > MCP_IMAGE_MAX_BYTES) {
    return { output: { ...meta, image: null, next_step: `This picture is larger than ${MCP_IMAGE_MAX_BYTES / (1024 * 1024)} MiB. ${download}` }, image: null };
  }
  // At most the declared size (already within the cap): a short read does not match; anything past it is never read.
  const bytes = await readBounded(absoluteStorageUrl(input.target, grant.download_path), grant.size_bytes, input.fetcher);
  if (bytes.length !== grant.size_bytes || !imageBytesMatch(grant.content_type, bytes)) {
    return { output: { ...meta, image: null, next_step: `This file's bytes do not match its declared picture type. ${download}` }, image: null };
  }
  return {
    output: { ...meta, encoding: "image" },
    image: { data: Buffer.from(bytes).toString("base64"), mimeType: grant.content_type },
  };
}
