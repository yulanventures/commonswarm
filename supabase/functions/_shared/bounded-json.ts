/**
 * A request body read with a byte cap, before any parse. Oversized bodies (declared or
 * streamed) are refused without buffering past the cap; malformed JSON reads as null.
 */
export const READ_BODY_MAX_BYTES = 128 * 1024;

export type BoundedJson = { ok: true; value: unknown } | { ok: false; reason: "too_large" };

export async function readBoundedJson(request: Request, maxBytes = READ_BODY_MAX_BYTES): Promise<BoundedJson> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, reason: "too_large" };
  const reader = request.body?.getReader();
  if (!reader) return { ok: true, value: null };
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { ok: false, reason: "too_large" };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
  } catch {
    return { ok: true, value: null };
  }
}
