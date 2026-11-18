/**
 * The accessibility floor for public pages, checked on the built site (design status goal 6).
 *
 * Every page the sitemap lists except /app, plus the not-found page, is loaded at a phone and a desktop width in light and dark,
 * and axe-core must report nothing serious or critical. Lesser findings are printed, not failed, so the floor can be
 * raised on purpose rather than by accident.
 *
 * CI only: browserTest skips unless RUN_BROWSER_TESTS=1, and CI builds the site before this suite.
 * Signed-in screens are not covered here; they need the workspace fixture.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { browserTest as test } from "./chrome.js";
import { launchPlaywrightChromium } from "./chrome.js";
import { chromium } from "playwright-core";

const VIEWPORTS = [{ width: 390, height: 844 }, { width: 1024, height: 768 }] as const;
const THEMES = ["light", "dark"] as const;
const FAILING = new Set(["serious", "critical"]);
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".ico": "image/x-icon", ".woff2": "font/woff2",
  ".json": "application/json", ".webmanifest": "application/manifest+json", ".xml": "application/xml", ".txt": "text/plain; charset=utf-8",
};

type Finding = { id: string; impact: string | null; help: string; nodes: string[] };

test("public pages have no serious or critical accessibility findings at phone and desktop widths, light and dark", { timeout: 10 * 60_000 }, async () => {
  const dist = fileURLToPath(new URL("../dist/", import.meta.url));
  const axeSource = await readFile(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
  const sitemap = await readFile(join(dist, "sitemap.xml"), "utf8");
  // /app is the app, not a public page. A build with no backend configured, as here, shows its sample workspace,
  // which production never serves; the app's controls belong to the signed-in check the workspace fixture will carry.
  const pages = [...sitemap.matchAll(/<loc>https:\/\/commonswarm\.com(\/[^<]*)<\/loc>/gu)].map(([, path]) => path!)
    .filter(path => path !== "/app/");
  assert.ok(pages.length >= 10, `the sitemap should list the public pages, got ${pages.length}`);
  pages.push("/404.html");

  // The built site as the web server serves it: /x and /x/ are x/index.html; anything else is the file or a 404.
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url!, "http://127.0.0.1").pathname);
    const relative = normalize(path).replace(/^([/\\])+/u, "");
    const candidates = extname(relative) ? [relative] : [join(relative, "index.html")];
    void (async () => {
      for (const candidate of candidates) {
        const file = join(dist, candidate);
        if (!file.startsWith(dist)) break;
        try {
          const body = await readFile(file);
          response.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
          response.end(body);
          return;
        } catch { /* try the next candidate */ }
      }
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("not found");
    })();
  });

  const browser = await launchPlaywrightChromium(chromium);
  const failures: string[] = [];
  const lesser = new Map<string, number>();
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    for (const theme of THEMES) for (const viewport of VIEWPORTS) {
      const context = await browser.newContext({ viewport, colorScheme: theme, isMobile: viewport.width < 768, hasTouch: viewport.width < 768 });
      try {
        for (const path of pages) {
          const page = await context.newPage();
          const where = `${path} ${viewport.width} ${theme}`;
          try {
            await page.goto(`http://127.0.0.1:${address.port}${path}`, { waitUntil: "load" });
            await page.evaluate(() => document.fonts.ready.then(() => undefined));
            await page.addScriptTag({ content: axeSource });
            const findings: Finding[] = await page.evaluate(async () => {
              const result = await (window as any).axe.run(document, { resultTypes: ["violations"] });
              return result.violations.map((violation: any) => ({
                id: violation.id, impact: violation.impact, help: violation.help,
                nodes: violation.nodes.slice(0, 3).map((node: any) => node.target.join(" ")),
              }));
            });
            for (const finding of findings) {
              if (FAILING.has(finding.impact ?? "")) failures.push(`${where}: ${finding.impact} ${finding.id} (${finding.help}) at ${finding.nodes.join(" | ")}`);
              else lesser.set(`${finding.impact} ${finding.id}`, (lesser.get(`${finding.impact} ${finding.id}`) ?? 0) + 1);
            }
          } catch (error) {
            failures.push(`${where}: could not be checked: ${String(error).slice(0, 200)}`);
          } finally { await page.close(); }
        }
      } finally { await context.close(); }
    }
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  console.log(JSON.stringify({ accessibility: { pages: pages.length, loads: pages.length * VIEWPORTS.length * THEMES.length, failing: failures.length, lesser: Object.fromEntries(lesser) } }));
  assert.deepEqual(failures, []);
});
