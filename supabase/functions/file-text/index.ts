/** Isolated PDF text worker. Created fresh by the edge main service for each extraction,
 * with no environment and its own memory and CPU limits (deploy/edge-runtime/main/file-text.ts).
 * Network, env and write are denied by its permission set. Reads of the container's
 * secret-bearing paths are unreachable from its view, measured by the sandbox probe in CI and
 * by the release gate (deploy/edge-runtime/file-text-probe.sh); deny_read/deny_sys are not
 * relied on, since the pinned runtime does not enforce them for these calls. It never sees a URL, credential, token
 * or caller header: only the PDF bytes main already bounded. Errors are fixed and silent. */
import { getDocumentProxy } from "npm:unpdf@1.9.1";
import { extractSequential, type PdfDocument, type PdfTextItem } from "./extract.ts";

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

Deno.serve(async (request) => {
  if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
  try {
    const bytes = new Uint8Array(await request.arrayBuffer());
    // No URLs and no fetching of any kind: no CMaps, standard fonts or WASM, no worker
    // fetch, no streaming or range loading. This pdf.js build contains no eval or
    // new Function, so there is no eval switch to turn off. Caller options override
    // unpdf's defaults (dist/index.mjs getDocumentProxy).
    const doc = await getDocumentProxy(bytes, {
      cMapUrl: undefined,
      standardFontDataUrl: undefined,
      wasmUrl: undefined,
      useWorkerFetch: false,
      disableAutoFetch: true,
      disableStream: true,
      disableRange: true,
      disableFontFace: true,
      useSystemFonts: false,
      enableXfa: false,
      stopAtErrors: true,
      verbosity: 0,
    });
    try {
      const document: PdfDocument = {
        numPages: doc.numPages,
        getPage: async (pageNumber) => {
          const page = await doc.getPage(pageNumber);
          return {
            getTextContent: async () => ({ items: (await page.getTextContent()).items as PdfTextItem[] }),
            cleanup: () => page.cleanup(),
          };
        },
      };
      return json(200, { ...(await extractSequential(document)) });
    } finally {
      try { await doc.loadingTask.destroy(); } catch { /* nothing to report */ }
    }
  } catch {
    // Never echo parser messages: they can quote document content.
    return json(422, { error: "pdf_unreadable" });
  }
});
