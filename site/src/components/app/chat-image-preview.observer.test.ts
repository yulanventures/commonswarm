/** CI only; registered by the component-observer glob, never launches locally. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { build } from "esbuild";
import { browserTest as test, findChrome, launchChrome } from "../../../tests/chrome.js";

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

test("chat images use cross-origin image requests without CORS, retry once, and keep Download navigation", async () => {
  const requests: { path: string; resourceType: string; mode: string; referer?: string }[] = [];
  // A complete 1x1 PNG. The storage server deliberately sends no CORS headers.
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=", "base64");
  const storage = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://fixture.invalid").pathname;
    // Sec-Fetch-Dest is the browser's request resource type: image, iframe,
    // or empty for fetch/XHR. Record it at the actual network boundary.
    const resourceType = String(request.headers["sec-fetch-dest"] ?? "");
    requests.push({ path, resourceType, mode: String(request.headers["sec-fetch-mode"] ?? ""), referer: request.headers.referer });
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
    // Exercise the real renderer and signing client, without exporting private
    // component functions or starting Astro. Only HTTP responses are mocked.
    const source = readFileSync(new URL("./LiveDashboard.astro", import.meta.url), "utf8");
    const start = source.indexOf("const freshAttachmentDownload =");
    const rendererStart = source.indexOf("const renderMessageAttachments =", start);
    const end = source.indexOf("\n    };", rendererStart);
    assert.ok(start >= 0 && rendererStart > start && end > rendererStart);
    const renderer = source.slice(start, end + "\n    };".length);
    const result = await build({
      stdin: {
        contents: `
          import { canPreviewChatImage, ChatImagePreviewCache, chatImagePreviewFailure } from "../../lib/chat-image-preview";
          import { fileDownloadUrl, SessionExpired } from "../../lib/commonswarm";
          const session = { access_token: "synthetic-test-session" };
          const activeWorkspaceId = "11111111-1111-4111-8111-111111111111";
          const uuid = () => crypto.randomUUID();
          const attachmentPreviewUrls = new ChatImagePreviewCache();
          const feedScroller = () => document.querySelector("#feed");
          const formatAttachmentSize = bytes => String(bytes);
          const readableError = error => String(error);
          const setComposerStatus = message => { throw new Error(message); };
          ${renderer}
          for (const id of ["normal", "recover", "broken"]) {
            const row = document.createElement("article");
            row.id = id;
            document.querySelector("#feed").append(row);
            renderMessageAttachments(row, { attachments: [{ file_id: id, version_n: 1,
              name: id + ".png", content_type: "image/png", size_bytes: 68 }] });
          }
          const waitFor = async predicate => {
            for (let n = 0; n < 200; n++) {
              if (predicate()) return;
              await new Promise(resolve => setTimeout(resolve, 20));
            }
            throw new Error("Image observation timed out");
          };
          (async () => {
            await waitFor(() => document.querySelector("#normal img").naturalWidth > 0 &&
              document.querySelector("#recover img").naturalWidth > 0 &&
              document.querySelector("#broken [data-preview-state]")?.dataset.previewState === "unavailable");
            // Positive control: the same no-CORS server must reject a native fetch.
            let corsFetchRejected = false;
            try { await nativeFetch(${JSON.stringify(`${storageOrigin}/control`)}); }
            catch { corsFetchRejected = true; }
            const images = Object.fromEntries(["normal", "recover", "broken"].map(id => {
              const image = document.querySelector("#" + id + " img");
              return [id, { width: image.naturalWidth, src: image.src, alt: image.alt,
                referrerPolicy: image.referrerPolicy, loading: image.loading,
                crossOrigin: image.crossOrigin, state: image.closest("article").dataset.previewState ?? null }];
            }));
            const imageTimingTypes = performance.getEntriesByType("resource")
              .filter(entry => entry.name.startsWith(${JSON.stringify(storageOrigin + "/storage/")}))
              .map(entry => entry.initiatorType);
            parent.postMessage({ preview: { images, counts, corsFetchRejected, imageTimingTypes,
              currentCachedUrl: attachmentPreviewUrls.get("normal", 1, Date.now()),
              returnedExpiryUsed: attachmentPreviewUrls.get("normal", 1, Date.now() + 31_000) === undefined } }, "*");
            document.querySelector("#normal .dashboard__attachment-download").click();
          })().catch(error => parent.postMessage({ error: String(error) }, "*"));
        `,
        resolveDir: import.meta.dirname,
        loader: "ts",
      },
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      define: { "import.meta.env": JSON.stringify({ PUBLIC_SUPABASE_URL: storageOrigin, PUBLIC_SUPABASE_ANON_KEY: "synthetic-public-key" }) },
    });
    const bundle = result.outputFiles[0]!.text;
    const mockApi = `<script>
      const counts = {};
      const nativeFetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const request = new Request(input, init);
        if (request.url !== ${JSON.stringify(`${storageOrigin}/functions/v1/command`)}) return nativeFetch(input, init);
        const body = await request.json();
        if (body.command.kind !== "file_download_url" || body.command.version_n !== 1) throw new Error("Unexpected signing request");
        const id = body.command.file_id;
        counts[id] = (counts[id] ?? 0) + 1;
        return Response.json({ status: "accepted", download_path: "/storage/v1/object/sign/" + id + "/" + counts[id],
          download_url_expires_in_seconds: 60 });
      };
    </script>`;
    page = createServer((request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      if (request.url === "/fixture") {
        response.end(`<!doctype html><div id="feed" style="height:400px;overflow:auto"></div>${mockApi}<script>${bundle}</script>`);
      } else {
        response.end(`<!doctype html><html><body><script>
          const report = {};
          window.addEventListener("message", event => {
            if (event.source !== document.querySelector("iframe").contentWindow) return;
            Object.assign(report, event.data);
            document.documentElement.dataset.imageObservation = btoa(JSON.stringify(report));
          });
        </script><iframe width="800" height="600" src="/fixture"></iframe></body></html>`);
      }
    });
    const origin = await listen(page);
    assert.notEqual(origin, storageOrigin, "the signed image must be cross-origin");
    const { stdout } = await launchChrome(await findChrome(), [
      "--virtual-time-budget=12000", "--dump-dom", origin,
    ], { timeout: 30_000, maxBuffer: 5 * 1024 * 1024 });
    const encoded = stdout.match(/data-image-observation="([A-Za-z0-9+/=]+)"/)?.[1];
    assert.ok(encoded, "the real attachment renderer must report its observations");
    const observation = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    assert.equal(observation.error, undefined);
    const preview = observation.preview;
    assert.ok(preview, "image loading must finish before Download navigation");
    assert.equal(preview.corsFetchRejected, true, "the fetch control must reproduce missing CORS");
    assert.equal(preview.currentCachedUrl, `${storageOrigin}/storage/v1/object/sign/normal/1`,
      "the fresh signed URL must be stored before checking its expiry");
    assert.equal(preview.returnedExpiryUsed, true, "the signing client's 60s expiry must reach the cache");
    assert.deepEqual(preview.counts, { normal: 1, recover: 2, broken: 2 });
    for (const id of ["normal", "recover"]) {
      assert.ok(preview.images[id].width > 0, `${id} PNG must decode`);
      assert.equal(preview.images[id].state, null);
      assert.equal(preview.images[id].alt, `${id}.png`);
      assert.equal(preview.images[id].referrerPolicy, "no-referrer");
      assert.equal(preview.images[id].loading, "lazy");
      assert.equal(preview.images[id].crossOrigin, null);
    }
    assert.equal(preview.images.broken.width, 0);
    assert.equal(preview.images.broken.state, "unavailable");
    assert.equal(preview.images.broken.alt, "broken.png preview unavailable");
    assert.ok(preview.imageTimingTypes.length >= 5);
    assert.ok(preview.imageTimingTypes.every(type => type === "img"), "storage previews must not use fetch/XHR");
    const imageRequests = requests.filter(request => request.path.startsWith("/storage/") && request.resourceType === "image");
    assert.equal(imageRequests.length, 5);
    assert.ok(imageRequests.every(request => request.mode === "no-cors" && request.referer === undefined));
    assert.ok(requests.some(request => request.path === "/control" && request.mode === "cors"));
    assert.equal(observation.download, `${storageOrigin}/storage/v1/object/sign/normal/2`);
    assert.ok(requests.some(request => request.path.endsWith("/normal/2") && request.resourceType === "iframe" && request.mode === "navigate"));
  } finally {
    if (page) await close(page);
    await close(storage);
  }
});
