// Local no-CORS network fixture; records browser request facts without implementing image behavior.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { imagePreviewPage } from "./chat-image-preview.page.fixture.js";

export interface ImageRequestFact {
  path: string; resourceType: string; mode: string; referer?: string; atMs: number; status?: number;
}
const listen = async (server: Server): Promise<string> => {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
};
const close = (server: Server): Promise<void> => new Promise((resolve, reject) => {
  server.close(error => error ? reject(error) : resolve());
});

export async function imagePreviewFixture() {
  const started = Date.now();
  const requests: ImageRequestFact[] = [];
  // A complete 1x1 PNG. The storage server deliberately sends no CORS headers.
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=", "base64");
  const storage = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://fixture.invalid").pathname;
    // Sec-Fetch-Dest is the browser's request resource type: image, iframe,
    // or empty for fetch/XHR. Record it at the actual network boundary.
    const resourceType = String(request.headers["sec-fetch-dest"] ?? "");
    const fact = { path, resourceType, mode: String(request.headers["sec-fetch-mode"] ?? ""), referer: request.headers.referer, atMs: Date.now() - started, status: undefined as number | undefined };
    requests.push(fact);
    response.once("finish", () => { fact.status = response.statusCode; });
    if (resourceType === "iframe") {
      response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      response.end(`<script>parent.postMessage({ download: location.href }, "*")</script>`);
    } else if (path.includes("/broken/") || path.endsWith("/recover/1")) {
      response.writeHead(404, { "content-type": "text/plain", "cache-control": "no-store" });
      response.end("Missing image");
    } else {
      response.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
      response.end(png);
    }
  });
  const storageOrigin = await listen(storage);
  let page: Server | undefined;
  try {
    const html = await imagePreviewPage(storageOrigin);
    page = createServer((request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(request.url === "/fixture" ? html.fixture : html.parent);
    });
    const origin = await listen(page);
    assert.notEqual(origin, storageOrigin, "the signed image must be cross-origin");
    return { started, requests, storageOrigin, origin,
      close: async () => { try { if (page) await close(page); } finally { await close(storage); } },
    };
  } catch (error) {
    try { if (page) await close(page); } finally { await close(storage); }
    throw error;
  }
}
