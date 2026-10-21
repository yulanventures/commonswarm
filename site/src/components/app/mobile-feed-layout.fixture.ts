/** Actual built app markup/CSS; only invented data and callbacks replace boot/auth in this geometry fixture. */
import { build } from "esbuild";
import assert from "node:assert/strict";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

const siteRoot = join(import.meta.dirname, "..", "..", "..");
const distRoot = join(siteRoot, "dist");
const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2",
};

export const revertedStyles = `<style>
  .hm-frame.hm-frame .hm-frame__main .hm-frame__channel > header { min-block-size: 140px; }
  .hm-frame .hm-frame__main .hm-frame__channel .dashboard__feed-toolbar { min-block-size: 96px; margin-block-end: 0; }
  .dashboard__channel-head {
    min-block-size: 6.25rem;
    gap: var(--s-3) var(--s-6);
    padding: var(--s-4) clamp(var(--s-5), 4vw, var(--s-8));
  }
  .dashboard__feed-toolbar { min-block-size: 3.25rem; }
  .dashboard__composer-status:empty { display: block; }
  @media (max-width: 52rem) {
    .dashboard__channel-head {
      min-block-size: 5.5rem;
      padding: var(--s-4);
    }
    .dashboard__channel-titleblock { order: 1; }
    .dashboard__channel-actions {
      order: 2;
      margin-inline-start: auto;
    }
    .dashboard__channel-roster {
      order: 3;
      flex: 1 1 100%;
      margin-inline-start: 0;
    }
    .dashboard__channel--roster .dashboard__channel-body {
      min-block-size: calc(100svh - 5.5rem - 4.5rem - 3.5rem);
    }
    .dashboard__channel-body {
      min-block-size: calc(100svh - 5.5rem - 4.5rem);
    }
  }
  @media (max-width: 52rem) {
    /* The 2026-09-04 change put the channel head OUT of the flow and took the filter row's
       height back with a negative margin. This is the state before it: both are rows again,
       and the transcript starts below all three bars. */
    .dashboard__channel {
      position: static;
      grid-template-rows: auto minmax(0, 1fr);
    }
    .dashboard__channel-head {
      position: static;
      min-block-size: 4.75rem;
      justify-content: space-between;
      flex-wrap: wrap;
      padding: var(--s-3) var(--s-4);
      border-block-end: 1px solid var(--border);
      pointer-events: auto;
    }
    .dashboard__channel-titleblock {
      position: static;
      inline-size: auto;
      block-size: auto;
      margin: 0;
      overflow: visible;
      clip-path: none;
    }
    .dashboard__feed-toolbar {
      margin-block-end: 0;
      border-block-end: 1px solid var(--border);
    }
    .dashboard__feed { padding-block-start: 0; }
  }
  @media (max-width: 34rem) {
    .dashboard__channel-head {
      display: flex;
      align-items: flex-start;
      flex-direction: column;
      flex-wrap: nowrap;
      gap: var(--s-3);
    }
    .dashboard__channel-description { line-height: var(--lh-xs); }
    .dashboard__channel-actions {
      order: 2;
      margin-inline-start: auto;
    }
    .dashboard__channel-roster {
      order: 3;
    }
  }
</style>`;

export const startDistServer = async (frameScript: (reverted: boolean, empty: boolean, pending: boolean, more: boolean, todos: boolean, shellScript: string) => string): Promise<{ close(): Promise<void>; origin: string }> => {
  const bundle = await build({ absWorkingDir: siteRoot, bundle: true, format: "iife", globalName: "MobileShell", platform: "browser", write: false,
    stdin: { resolveDir: siteRoot, loader: "ts", contents: `
      export { createKylonHost } from './src/lib/kylon-shell/host.ts';
      export { projectHomeLayout } from './src/lib/kylon-shell/projection.ts';
      export { buildPhoneTopBar, buildWorkspaceHeader, buildWorkspaceNav } from './src/lib/home-shell.ts';
      export { replaceHomeRegion } from './src/lib/home-focus.ts';` } });
  const shellScript = bundle.outputFiles[0]?.text; assert.ok(shellScript);
  // Keep the release markup and linked CSS. Omit runtime scripts so no Sample/auth lifecycle
  // races the explicitly bounded signed-in geometry setup; this does not exercise authentication.
  const appHtml = readFileSync(join(distRoot, "app/index.html"), "utf8").replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, "");
  assert.ok(appHtml.includes('data-kylon-shell') && appHtml.includes('data-feed-list'), "built app fixture is missing its actual host/feed");
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/__fixture") {
      response.writeHead(200, { "content-type": contentTypes[".html"] });
      response.end(appHtml);
      return;
    }
    if (url.pathname === "/__measure") {
      const width = Number.parseInt(url.searchParams.get("width") ?? "", 10);
      const height = Number.parseInt(url.searchParams.get("height") ?? "", 10);
      const reverted = url.searchParams.get("reverted") === "1";
      const empty = url.searchParams.get("empty") === "1";
      const pending = url.searchParams.get("pending") === "1";
      const more = url.searchParams.get("more") === "1";
      const todos = url.searchParams.get("todos") === "1";
      if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) {
        response.writeHead(400).end("Invalid measurement");
        return;
      }
      response.writeHead(200, { "content-type": contentTypes[".html"] });
      response.end(
        `<!doctype html><html><body style="margin:0"><iframe title="Layout measurement viewport" src="/__fixture" style="border:0;width:${width}px;height:${height}px"></iframe>${frameScript(reverted, empty, pending, more, todos, shellScript)}</body></html>`,
      );
      return;
    }

    const relative = url.pathname === "/app" || url.pathname === "/app/"
      ? "app/index.html"
      : url.pathname.replace(/^\/+/, "");
    const filePath = normalize(join(distRoot, relative));
    if (!filePath.startsWith(`${distRoot}/`)) {
      response.writeHead(403).end("Forbidden");
      return;
    }
    try {
      const stat = statSync(filePath);
      if (!stat.isFile()) throw new Error("not a file");
      response.writeHead(200, {
        "content-length": stat.size,
        "content-type": contentTypes[extname(filePath)] ?? "application/octet-stream",
      });
      createReadStream(filePath).pipe(response);
    } catch {
      response.writeHead(404).end("Not found");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string", "layout observer server must bind a port");
  return {
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
    origin: `http://127.0.0.1:${address.port}`,
  };
};

