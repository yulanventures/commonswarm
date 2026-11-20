/** Real-Chromium WCAG 2.2 AA, clipboard copy, 44 px target, and light/dark parity witness for V2 start-agent.md onboarding. */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { browserTest as test, launchPlaywrightChromium } from "../../../tests/chrome.js";
import { chromium } from "playwright-core";
import { compileFixtureFunction, renderAstroFixture } from "../../../tests/astro-fixture";
import { AGENT_START_PROMPT } from "../../lib/install";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".md": "text/markdown; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function installPlaybookConnectFixture() {
  const f = (window as any).existingFixture;
  const previous = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== "https://api.test.invalid") return previous(input, init);
    if (url.pathname === "/functions/v1/read") {
      const body = await request.clone().json().catch(() => ({}));
      if (body.resource === "conversations") {
        return Response.json({
          conversations: [
            {
              conversation_id: "aaaa1111-1111-4111-8111-111111111111",
              workspace_id: f.ids.ws,
              kind: "general",
              channel_id: null,
              slug: "general",
              title: null,
              visibility: "public",
              joined: true,
              archived_at: null,
              member_count: 2,
              members: [],
              unread_count: 0,
              mention_count: 0,
              starred: false,
              notify_level: "everything",
              last_activity_at: "2026-11-20T08:00:00Z",
              last_signal_id: null,
              created_at: "2026-11-01T00:00:00Z",
            },
          ],
        });
      }
      if (body.resource === "conversation_history") {
        return Response.json({ signals: [], has_more: false, next_before: null });
      }
    }
    return previous(input, init);
  };
}

test("V2 start-agent.md playbook, /download prompt, and Connect prompt pass copy, Tab-order, 44 px, and WCAG 2.2 AA", { timeout: 180_000 }, async () => {
  const distDir = fileURLToPath(new URL("../../../dist", import.meta.url));
  const fontsDir = fileURLToPath(new URL("../../../public/fonts/", import.meta.url));
  const axeSource = await readFile(fileURLToPath(new URL("../../../node_modules/axe-core/axe.min.js", import.meta.url)), "utf8");
  const { markup, styles, bundled } = await renderAstroFixture(new URL("../app/LiveDashboard.astro", import.meta.url));
  const install = await compileFixtureFunction(new URL("../../../tests/workspace-fixture.ts", import.meta.url), "installWorkspaceFixture");
  const fixture = await compileFixtureFunction(new URL(import.meta.url), "installPlaybookConnectFixture");
  const appHtml =
    "<!doctype html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width, initial-scale=1'>" +
    "<meta name='commonswarm:url' content='https://api.test.invalid'><meta name='commonswarm:anon-key' content='synthetic-public'>" +
    "<style>" + styles.join("\n") + "</style><script>" + install + fixture + "</script></head><body>" +
    markup + "<script type='module' src='/app.js'></script></body></html>";

  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://127.0.0.1");
    if (url.pathname === "/app") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(appHtml);
      return;
    }
    if (url.pathname === "/app.js") {
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      response.end(bundled.join("\n"));
      return;
    }
    if (url.pathname.startsWith("/fonts/") && url.pathname.endsWith(".woff2")) {
      try {
        const data = await readFile(join(fontsDir, basename(url.pathname)));
        response.writeHead(200, { "Content-Type": "font/woff2" });
        response.end(data);
        return;
      } catch {
        response.writeHead(404);
        response.end();
        return;
      }
    }
    const rel = url.pathname === "/" ? "index.html" : url.pathname.endsWith("/") ? `${url.pathname.slice(1)}index.html` : url.pathname.slice(1);
    const candidate = resolve(distDir, rel);
    if (!candidate.startsWith(distDir)) {
      response.writeHead(403);
      response.end();
      return;
    }
    for (const filePath of [candidate, join(candidate, "index.html")]) {
      try {
        const data = await readFile(filePath);
        response.writeHead(200, { "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream" });
        response.end(data);
        return;
      } catch {
        // try next candidate
      }
    }
    response.writeHead(404);
    response.end("not found");
  });

  const browser = await launchPlaywrightChromium(chromium);
  try {
    await new Promise<void>(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    const evidence = process.env.V2_PLAYBOOK_DIR || join(process.cwd(), "../site-observer-evidence/v2-start-agent-playbook");
    await mkdir(evidence, { recursive: true });

    // 1. Live HTTP check of /start-agent.md from built dist/.
    const playbookRes = await fetch(`${base}/start-agent.md`);
    assert.equal(playbookRes.status, 200);
    const playbookText = await playbookRes.text();
    assert.match(playbookText, /^# CommonSwarm Agent Onboarding Playbook/m);

    const report: Record<string, any> = {};

    // 2. /download prompt checks across light/dark and phone/desktop.
    for (const theme of ["light", "dark"] as const) {
      for (const [width, height] of [[360, 740], [1440, 900]] as const) {
        const name = `download-${width}x${height}-${theme}`;
        const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme, hasTouch: width < 1024 });
        const page = await context.newPage();
        try {
          await page.addInitScript(`
            window.__copied = [];
            Object.defineProperty(Clipboard.prototype, "writeText", {
              configurable: true,
              writable: true,
              value: async function(text) { window.__copied.push(text); },
            });
          `);
          await page.goto(`${base}/download/`, { waitUntil: "networkidle" });
          await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
          await page.waitForSelector('[data-dl-agent-prompt] [data-ui-copy][data-copy-bound="1"]');
          await page.evaluate(() => document.fonts.ready);

          const section = page.locator("[data-dl-agent-prompt]");
          await section.scrollIntoViewIfNeeded();
          const promptText = (await section.locator("pre code").innerText()).trim();
          assert.equal(promptText, AGENT_START_PROMPT, `${name}: displayed prompt mismatch`);

          await section.locator("[data-ui-copy]").click();
          await page.waitForFunction(() => ((window as any).__copied?.length ?? 0) > 0);
          const copied = await page.evaluate(() => (window as any).__copied as string[]);
          assert.equal(copied[0], AGENT_START_PROMPT, `${name}: clipboard payload mismatch`);
          const copyStatus = await page.evaluate(() => ({
            buttonText: document.querySelector("[data-dl-agent-prompt] [data-ui-copy] .ui-code__txt")?.textContent?.trim(),
            liveText: document.getElementById("ui-copy-status")?.textContent?.trim(),
          }));
          assert.equal(copyStatus.buttonText, "Copied", `${name}: button text should flip to Copied`);
          assert.equal(copyStatus.liveText, "Copied to clipboard", `${name}: live region should announce copy`);

          await page.addScriptTag({ content: axeSource });
          const metrics = await page.evaluate(async () => {
            const root = document.querySelector<HTMLElement>("[data-dl-agent-prompt]")!;
            const axeRes = await (window as any).axe.run(root, {
              runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
            });
            const smallTargets = Array.from(root.querySelectorAll<HTMLElement>("button, a[href]")).flatMap((el) => {
              const r = el.getBoundingClientRect();
              return r.width < 44 || r.height < 44
                ? [{ text: el.textContent?.trim(), w: Math.round(r.width), h: Math.round(r.height) }]
                : [];
            });
            return {
              overflow: document.documentElement.scrollWidth > innerWidth,
              smallTargets,
              axeViolations: axeRes.violations.map((v: any) => ({ id: v.id, impact: v.impact, help: v.help })),
            };
          });
          await page.screenshot({ path: join(evidence, `${name}.png`), fullPage: false });
          report[name] = { ok: true, copied: copied[0], ...metrics };
        } finally {
          await context.close();
        }
      }
    }

    // 3. Connect (<agent-host-picker>) checks across light/dark and phone/desktop + Tab-order contract.
    const ws = "11111111-1111-4111-8111-111111111111";
    for (const theme of ["light", "dark"] as const) {
      for (const [width, height] of [[360, 740], [390, 844], [1024, 768], [1440, 900]] as const) {
        const name = `connect-${width}x${height}-${theme}`;
        const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme, hasTouch: width < 1024 });
        const page = await context.newPage();
        try {
          await page.addInitScript(`
            window.__copied = [];
            Object.defineProperty(Clipboard.prototype, "writeText", {
              configurable: true,
              writable: true,
              value: async function(text) { window.__copied.push(text); },
            });
          `);
          await page.goto(`${base}/app?w=${ws}&v=add-agent&theme=${theme}`);
          await page.waitForSelector('[data-channel-view="agent-choice"]:not([hidden]) agent-host-picker[data-wired="true"] [data-ahp-copy-playbook]');
          await page.evaluate(() => document.fonts.ready);

          // Verify app.add-agent.panel Tab-order contract is preserved (Name -> Copy sentence).
          await page.locator('[data-channel-view="agent-choice"]:not([hidden]) [data-ahp-host="claude"]').click();
          await page.waitForSelector('[data-channel-view="agent-choice"]:not([hidden]) [data-ahp-copy-sentence]');
          await page.locator('[data-channel-view="agent-choice"]:not([hidden]) [data-ahp-name]').focus();
          await page.keyboard.press("Tab");
          const tabLandedOnSentenceCopy = await page.evaluate(() =>
            document.activeElement?.hasAttribute("data-ahp-copy-sentence") === true,
          );
          assert.equal(tabLandedOnSentenceCopy, true, `${name}: Tab from Name must still land directly on [data-ahp-copy-sentence]`);

          // Verify Connect 1-line playbook prompt display + clipboard copy.
          const playbook = page.locator('[data-channel-view="agent-choice"]:not([hidden]) [data-ahp-playbook]');
          await playbook.scrollIntoViewIfNeeded();
          const displayed = (await playbook.locator("[data-ahp-playbook-prompt]").innerText()).trim();
          assert.equal(displayed, AGENT_START_PROMPT, `${name}: displayed playbook prompt mismatch`);
          await playbook.locator("[data-ahp-copy-playbook]").click();
          await page.waitForFunction(() => ((window as any).__copied?.length ?? 0) > 0);
          const copied = await page.evaluate(() => (window as any).__copied as string[]);
          assert.equal(copied[0], AGENT_START_PROMPT, `${name}: Connect clipboard payload mismatch`);

          await page.addScriptTag({ content: axeSource });
          const metrics = await page.evaluate(async () => {
            const root = document.querySelector<HTMLElement>('[data-channel-view="agent-choice"]:not([hidden]) [data-ahp-playbook]')!;
            const axeRes = await (window as any).axe.run(root, {
              runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
            });
            const smallTargets = Array.from(root.querySelectorAll<HTMLElement>("button, a[href]")).flatMap((el) => {
              const r = el.getBoundingClientRect();
              return r.width < 44 || r.height < 44
                ? [{ text: el.textContent?.trim(), w: Math.round(r.width), h: Math.round(r.height) }]
                : [];
            });
            return {
              overflow: document.documentElement.scrollWidth > innerWidth,
              smallTargets,
              axeViolations: axeRes.violations.map((v: any) => ({ id: v.id, impact: v.impact, help: v.help })),
            };
          });
          await page.screenshot({ path: join(evidence, `${name}.png`), fullPage: false });
          report[name] = { ok: true, copied: copied[0], tabLandedOnSentenceCopy, ...metrics };
        } finally {
          await context.close();
        }
      }
    }

    await writeFile(join(evidence, "report.json"), JSON.stringify(report, null, 2));
    const failures = Object.entries(report).filter(
      ([, r]) => !r.ok || r.overflow || (r.axeViolations?.length ?? 0) > 0 || (r.smallTargets?.length ?? 0) > 0,
    );
    assert.deepEqual(failures, [], JSON.stringify(failures, null, 2));
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  }
});
