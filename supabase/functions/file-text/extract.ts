/** Sequential, bounded PDF text extraction. Pure: the caller supplies the parsed document.
 *
 * Pages are read one at a time and output bytes are counted as text is collected, so a
 * large document never fans out work across all pages (unpdf's extractText uses
 * Promise.all over every page) and never builds more text than the cap. The worker's own
 * memory and CPU limits remain the boundary for a single pathological page. */

export const FILE_TEXT_MAX_PAGES = 300;
export const FILE_TEXT_MAX_OUTPUT_BYTES = 512 * 1024;

export interface PdfTextItem { str?: unknown; hasEOL?: unknown }
export interface PdfPage {
  getTextContent(): Promise<{ items: readonly PdfTextItem[] }>;
  cleanup?(): unknown;
}
export interface PdfDocument {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPage>;
}

export interface ExtractedText {
  text: string;
  pages_read: number;
  page_count: number;
  truncated: boolean;
}

/** Longest prefix of `bytes` (up to `limit`) that ends on a complete UTF-8 character. */
function utf8Cut(bytes: Uint8Array, limit: number): number {
  const end = Math.min(limit, bytes.length);
  let lead = end - 1;
  while (lead >= 0 && end - lead <= 3 && (bytes[lead]! & 0xc0) === 0x80) lead--;
  if (lead < 0) return end;
  const first = bytes[lead]!;
  const need = first < 0x80 ? 1 : (first & 0xe0) === 0xc0 ? 2 : (first & 0xf0) === 0xe0 ? 3 : (first & 0xf8) === 0xf0 ? 4 : 1;
  return end - lead >= need ? end : lead;
}

export async function extractSequential(
  doc: PdfDocument,
  limits: { maxPages?: number; maxBytes?: number } = {},
): Promise<ExtractedText> {
  const maxPages = limits.maxPages ?? FILE_TEXT_MAX_PAGES;
  const maxBytes = limits.maxBytes ?? FILE_TEXT_MAX_OUTPUT_BYTES;
  const pageCount = Number.isSafeInteger(doc.numPages) && doc.numPages > 0 ? doc.numPages : 0;
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let used = 0;
  let pagesRead = 0;
  let truncated = pageCount > maxPages;
  for (let pageNumber = 1; pageNumber <= Math.min(pageCount, maxPages); pageNumber++) {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    let pageText = "";
    for (const item of content.items) {
      if (typeof item.str === "string") pageText += item.str;
      if (item.hasEOL === true) pageText += "\n";
    }
    try { page.cleanup?.(); } catch { /* cleanup failures change nothing we return */ }
    pagesRead = pageNumber;
    const bytes = encoder.encode((used === 0 ? "" : "\n\n") + pageText);
    if (used + bytes.length > maxBytes) {
      const room = utf8Cut(bytes, maxBytes - used);
      chunks.push(bytes.subarray(0, room));
      used += room;
      truncated = true;
      break;
    }
    chunks.push(bytes);
    used += bytes.length;
  }
  const out = new Uint8Array(used);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return { text: new TextDecoder().decode(out), pages_read: pagesRead, page_count: pageCount, truncated };
}
