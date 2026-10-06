/** HTTP host attachment channel. Model tool schemas contain neither bytes nor
 * transfer credentials. This parser bounds input before allocating FormData. */
export const HOUSEHOLD_ATTACHMENT_LIMIT = 25 * 1024 * 1024;
export class HouseholdAttachmentError extends Error {
  constructor(readonly status: 400 | 413) { super('household_attachment_refused'); }
}
export async function parseHouseholdAttachment(request: Request): Promise<{ body: Record<string, unknown>; attachment: Uint8Array }> {
  const reader = request.body?.getReader();
  if (!reader) throw new HouseholdAttachmentError(400);
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.length;
      if (length > HOUSEHOLD_ATTACHMENT_LIMIT + 128 * 1024) throw new HouseholdAttachmentError(413);
      chunks.push(part.value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try {
    const form = await new Request(request.url, { method: 'POST', headers: request.headers, body: bytes }).formData();
    if ([...form.keys()].length !== 2 || !form.has('command') || !form.has('attachment')) throw new HouseholdAttachmentError(400);
    const metadata = form.get('command');
    const attachment = form.get('attachment');
    if (typeof metadata !== 'string' || new TextEncoder().encode(metadata).length > 128 * 1024
      || !(attachment instanceof Blob)) throw new HouseholdAttachmentError(400);
    if (attachment.size > HOUSEHOLD_ATTACHMENT_LIMIT) throw new HouseholdAttachmentError(413);
    const body = JSON.parse(metadata);
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || !['household_tool','household_legacy'].includes(body.command?.kind)) throw new HouseholdAttachmentError(400);
    return { body, attachment: new Uint8Array(await attachment.arrayBuffer()) };
  } catch (error) {
    if (error instanceof HouseholdAttachmentError) throw error;
    throw new HouseholdAttachmentError(400);
  }
}
