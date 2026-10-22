// Invented responses and observation only; renderer/signing client remain actual source.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build } from "esbuild";

export async function imagePreviewPage(storageOrigin: string): Promise<{ fixture: string; parent: string }> {
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
          const rect = node => {
            const r = node?.getBoundingClientRect();
            return r ? { left:r.left, top:r.top, width:r.width, height:r.height } : null;
          };
          window.imageObserver = {
            ready: () => document.querySelector("#normal img").naturalWidth > 0 &&
              document.querySelector("#recover img").naturalWidth > 0 &&
              document.querySelector("#broken [data-preview-state]")?.dataset.previewState === "unavailable",
            diagnostics: () => ({ width:innerWidth, height:innerHeight,
              narrow:matchMedia("(max-width:832px)").matches,
              reducedMotion:matchMedia("(prefers-reduced-motion:reduce)").matches,
              documentState:document.readyState, visibility:document.visibilityState,
              feed:rect(document.querySelector("#feed")), counts:{...counts}, signingFacts, events,
              images:Object.fromEntries(["normal","recover","broken"].map(id => {
                const image=document.querySelector("#"+id+" img"), card=image?.closest("article");
                return [id, image ? {src:image.src,currentSrc:image.currentSrc,complete:image.complete,
                  naturalWidth:image.naturalWidth,naturalHeight:image.naturalHeight,loading:image.loading,
                  crossOrigin:image.crossOrigin,state:card?.dataset.previewState??null,
                  imageRect:rect(image),cardRect:rect(card)} : null];
              })), resources:performance.getEntriesByType("resource").map(e=>({name:e.name,
                initiatorType:e.initiatorType,startTime:e.startTime,duration:e.duration})) }),
            finish: async () => {
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
            },
          };
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
      const signingFacts = [], events = [];
      window.addEventListener("error", event => {
        const image = event.target;
        events.push({kind:image?.tagName === "IMG" ? "image-error" : "runtime-error",
          at:performance.now(),src:image?.currentSrc || image?.src,message:event.message});
      }, true);
      window.addEventListener("load", event => {
        if(event.target?.tagName === "IMG")events.push({kind:"image-load",at:performance.now(),src:event.target.currentSrc});
      }, true);
      window.addEventListener("unhandledrejection", event => {
        events.push({kind:"unhandledrejection",at:performance.now(),message:String(event.reason)});
      });
      const nativeFetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const request = new Request(input, init);
        if (request.url !== ${JSON.stringify(`${storageOrigin}/functions/v1/command`)}) return nativeFetch(input, init);
        const body = await request.json();
        if (body.command.kind !== "file_download_url" || body.command.version_n !== 1) throw new Error("Unexpected signing request");
        const id = body.command.file_id;
        counts[id] = (counts[id] ?? 0) + 1;
        signingFacts.push({id,version:body.command.version_n,count:counts[id],at:performance.now()});
        return Response.json({ status: "accepted", download_path: "/storage/v1/object/sign/" + id + "/" + counts[id],
          download_url_expires_in_seconds: 60 });
      };
    </script>`;
    return {
      fixture: `<!doctype html><div id="feed" style="height:400px;overflow:auto"></div>${mockApi}<script>${bundle}</script>`,
      parent: `<!doctype html><html><body><script>
          const report = window.imageObservation = {};
          window.addEventListener("message", event => {
            if (event.source !== document.querySelector("iframe").contentWindow) return;
            Object.assign(report, event.data);
          });
        </script><iframe width="800" height="600" src="/fixture"></iframe></body></html>`,
    };
}
