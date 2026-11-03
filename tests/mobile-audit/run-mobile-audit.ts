/**
 * Mobile audit runner (CS-MOBILE-AUDIT-20261103). CI ONLY: the `mobile-audit` suite in
 * .github/workflows/server-suite.yml starts the local stack, builds the site against it and runs
 * this file. It refuses to run without RUN_BROWSER_TESTS=1 and refuses non-loopback targets.
 *
 * For each screen x viewport x theme it records horizontal overflow, small tap targets and
 * horizontally clipped controls, and takes a viewport screenshot. It is report-only: findings go
 * into mobile-audit-report.json and the process exits 0 unless the harness itself cannot run.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { awaitFunctionRunning } from "../support/edge-readiness.js";
import { seedHeavyWorkspace } from "./seed-heavy-workspace.js";
import { browserTest as test, launchPlaywrightChromium } from "../../site/tests/chrome.js";

assert.equal(process.env.RUN_BROWSER_TESTS, "1", "the mobile audit runs in CI only (RUN_BROWSER_TESTS=1)");
const ROOT = resolve(import.meta.dirname, "../..");
const DIST = join(ROOT, "site/dist");
const OUT = resolve(process.env.MOBILE_AUDIT_OUT ?? join(ROOT, "site/mobile-audit/out"));
const SITE_PORT = 4329;

export const VIEWPORTS = [
  { width: 360, height: 740 }, { width: 390, height: 844 }, { width: 430, height: 932 },
  { width: 844, height: 390 }, { width: 768, height: 1024 }, { width: 1024, height: 1366 },
] as const;
export const THEMES = ["light", "dark"] as const;

type Step = { click?: string; type?: string; text?: string; press?: string; wait?: number; scroll?: string };
export interface Screen { id: string; kind: "view" | "dialog" | "route"; path: string; setup?: Step[]; ready?: string; signedOut?: boolean; status?: "pending"; reason?: string; states?: string[];
  /** Seed steps (seed.json "steps") that must have been accepted; otherwise the capture is an error. */
  requiresSeed?: string[] }

/** Starter list, replaced by site/mobile-audit/screens.json (the Designer's manifest) when present. */
const STARTER: Screen[] = [
  { id: "app.signin", kind: "view", path: "/app", ready: "[data-panel=signed-out]:not([hidden])", signedOut: true },
  { id: "app.catchup", kind: "view", path: "/app?v=catchup" },
  { id: "app.chat.general", kind: "view", path: "/app?w={workspace}&c={channel.general}" },
  { id: "app.chat.group", kind: "view", path: "/app?w={workspace}&c={channel.group}" },
  { id: "app.chat.long", kind: "view", path: "/app?w={workspace}&c={channel.long}" },
  { id: "app.chat.dm", kind: "view", path: "/app?w={workspace}", setup: [{ click: "[data-rail-agent=\"{agent}\"]" }, { wait: 600 }] },
  { id: "app.todos", kind: "view", path: "/app?w={workspace}&v=todos" },
  { id: "app.lists", kind: "view", path: "/app?w={workspace}&v=lists" },
  { id: "app.definitions", kind: "view", path: "/app?w={workspace}&v=lists", setup: [{ scroll: ".household-definitions" }, { wait: 400 }] },
  { id: "app.files", kind: "view", path: "/app?w={workspace}&v=files" },
  { id: "app.wiki", kind: "view", path: "/app?w={workspace}&v=wiki" },
  { id: "app.people", kind: "view", path: "/app?w={workspace}&v=people" },
  { id: "app.agent", kind: "view", path: "/app?w={workspace}&agent={agent}" },
  { id: "app.empty", kind: "view", path: "/app?w={emptyWorkspace}" },
  { id: "dialog.workspace-settings", kind: "dialog", path: "/app?w={workspace}", setup: [{ click: "[data-workspace-details-trigger]" }, { wait: 500 }] },
  { id: "dialog.command-palette", kind: "dialog", path: "/app?w={workspace}", setup: [{ press: "ControlOrMeta+k" }, { wait: 500 }] },
  { id: "menu.account", kind: "dialog", path: "/app?w={workspace}", setup: [{ click: "[data-user-menu-trigger]" }, { wait: 400 }] },
];

const loopback = (value: string) => ["127.0.0.1", "localhost", "[::1]"].includes(new URL(value).hostname);
const fill = (value: string, ids: Record<string, string>) => value.replace(/\{([a-zA-Z.]+)\}/g, (_, key: string) => ids[key] ?? `missing-${key}`);

function screens(): Screen[] {
  const manifest = join(ROOT, "site/mobile-audit/screens.json");
  if (!existsSync(manifest)) return STARTER;
  const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { screens?: Screen[] } | Screen[];
  return Array.isArray(parsed) ? parsed : parsed.screens ?? STARTER;
}

/** Static server for the built site: /app -> dist/app/index.html, assets by path. Loopback only. */
function serveDist(): Promise<() => Promise<void>> {
  const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
    ".png": "image/png", ".json": "application/json", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json", ".txt": "text/plain", ".md": "text/markdown" };
  const server = createServer((request, response) => {
    const path = normalize(decodeURIComponent(new URL(request.url ?? "/", "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
    let file = join(DIST, path);
    if (!file.startsWith(DIST)) { response.writeHead(403).end(); return; }
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!existsSync(file) && existsSync(`${file}.html`)) file = `${file}.html`;
    if (!existsSync(file)) { response.writeHead(404).end("not found"); return; }
    response.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
  });
  return new Promise(done => server.listen(SITE_PORT, "127.0.0.1", () => done(() => new Promise(close => server.close(() => close())))));
}

/** Runs in the page: overflow, small tap targets and horizontally clipped controls. */
const CHECKS = () => {
  const describe = (el: Element) => {
    const h = el as HTMLElement;
    const data = [...h.attributes].find(a => a.name.startsWith("data-"))?.name;
    return `${el.tagName.toLowerCase()}${h.id ? `#${h.id}` : ""}${data ? `[${data}]` : ""}${typeof h.className === "string" && h.className ? `.${h.className.trim().split(/\s+/).slice(0, 2).join(".")}` : ""}`;
  };
  const visible = (el: Element) => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0.05 && !el.closest("[hidden],[inert]");
  };
  const inScroller = (el: Element) => {
    for (let node = el.parentElement; node; node = node.parentElement) {
      const overflowX = getComputedStyle(node).overflowX;
      if (overflowX === "auto" || overflowX === "scroll") return true;
    }
    return false;
  };
  const width = window.innerWidth;
  const doc = document.scrollingElement ?? document.documentElement;
  const offenders = doc.scrollWidth > doc.clientWidth + 1
    ? [...document.querySelectorAll("body *")].filter(el => visible(el) && el.getBoundingClientRect().right > width + 1 && !inScroller(el)).slice(0, 15).map(describe) : [];
  const interactive = [...document.querySelectorAll("a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=menuitem],[role=tab],[role=option]")].filter(visible);
  // The ONLY effective-hitbox rule: a checkbox or radio inside (or named by) a label is tapped
  // through that label, so it is measured by the label's box. Every such use is listed in
  // `effective` with both sizes; nothing else is measured by anything but its own box.
  const labelFor = (el: Element) => el.tagName === "INPUT" && ["checkbox", "radio"].includes((el as HTMLInputElement).type)
    ? (el.closest("label") ?? (el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null)) : null;
  const measured = interactive.map(el => {
    const own = el.getBoundingClientRect();
    const label = labelFor(el)?.getBoundingClientRect();
    const viaLabel = !!label && label.width * label.height > own.width * own.height;
    return { el, own, rect: viaLabel ? label! : own, viaLabel };
  });
  const effective = measured.filter(m => m.viaLabel).slice(0, 40).map(m => ({ selector: describe(m.el), via: "label",
    own: { w: Math.round(m.own.width), h: Math.round(m.own.height) }, hit: { w: Math.round(m.rect.width), h: Math.round(m.rect.height) } }));
  const tapTargets = measured
    .filter(({ el, rect }) => (rect.width < 44 || rect.height < 44) && !(el.tagName === "A" && getComputedStyle(el).display === "inline"))
    .slice(0, 60).map(({ el, rect, viaLabel }) => ({ selector: describe(el), w: Math.round(rect.width), h: Math.round(rect.height), ...(viaLabel ? { via: "label" } : {}) }));
  // Hit testing: the centre of each measured box must reach the control (or its label).
  const reaches = (el: Element, x: number, y: number) => {
    const hit = document.elementFromPoint(x, y);
    const label = labelFor(el);
    return !!hit && (el === hit || el.contains(hit) || (!!label && (label === hit || label.contains(hit))));
  };
  const inView = (r: DOMRect) => r.right > 0 && r.bottom > 0 && r.left < width && r.top < window.innerHeight;
  const obscured = measured.filter(m => inView(m.rect) && !reaches(m.el, m.rect.left + m.rect.width / 2, m.rect.top + m.rect.height / 2))
    .slice(0, 20).map(m => ({ selector: describe(m.el), by: describe(document.elementFromPoint(m.rect.left + m.rect.width / 2, m.rect.top + m.rect.height / 2) ?? document.body) }));
  // Non-overlap: two different controls whose measured boxes intersect by more than 4px² share taps.
  const overlaps: { a: string; b: string; area: number }[] = [];
  for (let i = 0; i < measured.length && overlaps.length < 20; i += 1) {
    for (let j = i + 1; j < measured.length && overlaps.length < 20; j += 1) {
      const a = measured[i]!, b = measured[j]!;
      if (a.el.contains(b.el) || b.el.contains(a.el) || labelFor(a.el)?.contains(b.el) || labelFor(b.el)?.contains(a.el)) continue;
      const w = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left);
      const h = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
      if (w > 0 && h > 0 && w * h > 4) overlaps.push({ a: describe(a.el), b: describe(b.el), area: Math.round(w * h) });
    }
  }
  const offscreen = interactive.filter(el => { const r = el.getBoundingClientRect(); return (r.left < -1 || r.right > width + 1) && !inScroller(el); }).slice(0, 20).map(describe);
  // Collapsed text: a visible element holding a sentence but squeezed into a sliver, so it
  // wraps a character or two per line (overflow cannot see it). Leaf text containers only.
  const collapsed = [...document.querySelectorAll("body *")].filter(el => {
    if (!visible(el) || el.children.length > 2) return false;
    const text = (el.textContent ?? "").trim();
    if (text.length < 12 || !/\s/u.test(text)) return false;
    const r = el.getBoundingClientRect();
    const line = parseFloat(getComputedStyle(el).lineHeight) || 16;
    return r.width < 48 && r.height > line * 4;
  }).slice(0, 10).map(el => ({ selector: describe(el), w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height) }));
  const root = document.documentElement.getAttribute("data-theme");
  const effectiveTheme = root === "light" || root === "dark" ? root : (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  return { overflow: { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth, offenders }, tapTargets, offscreen, effective, obscured, overlaps, collapsed, effectiveTheme };
};

async function main(): Promise<void> {
  assert.ok(existsSync(join(DIST, "app/index.html")), "build the site against the local stack first");
  const status = JSON.parse(execFileSync("supabase", ["status", "-o", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })) as Record<string, string>;
  const env = { apiUrl: status.API_URL!, anonKey: status.ANON_KEY!, serviceRoleKey: status.SERVICE_ROLE_KEY!, dbUrl: status.DB_URL! };
  for (const url of [env.apiUrl, env.dbUrl]) assert.ok(loopback(url), "local stack only");
  mkdirSync(join(OUT, "shots"), { recursive: true });

  const envDir = mkdtempSync(join(tmpdir(), "cswarm-mobile-audit-"));
  const envFile = join(envDir, "functions.env");
  writeFileSync(envFile, "SWARM_ENV=test\nSWARM_SELF_SERVE=1\n");
  let functionLogs = "";
  const functions = spawn("supabase", ["functions", "serve", "--no-verify-jwt", "--env-file", envFile],
    { cwd: ROOT, env: { ...process.env, SWARM_ENV: "test", SWARM_SELF_SERVE: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  const capture = (chunk: Buffer) => { functionLogs = (functionLogs + chunk.toString("utf8")).slice(-20_000); };
  functions.stdout?.on("data", capture); functions.stderr?.on("data", capture);
  const closeSite = await serveDist();
  const report: Record<string, unknown>[] = [];
  let seedNotes: string[] = [];
  try {
    for (const fn of ["command", "read"]) {
      await awaitFunctionRunning({ url: `${env.apiUrl}/functions/v1/${fn}`, fetcher: fetch, timeoutMs: 60_000,
        sleep: ms => delay(ms), now: () => Date.now(), diagnostics: () => functionLogs.slice(-4000) });
    }
    const seed = await seedHeavyWorkspace(env);
    seedNotes = seed.notes;
    writeFileSync(join(OUT, "seed.json"), JSON.stringify({ ids: seed.ids, notes: seed.notes, steps: seed.steps }, null, 2));

    // Installed only in the CI job (npm install --no-save), so it stays out of the lockfile and typecheck.
    const playwrightModule = "playwright";
    const { chromium } = await import(playwrightModule) as { chromium: Parameters<typeof launchPlaywrightChromium<any>>[0] };
    const browser = await launchPlaywrightChromium<any>(chromium);
    try {
      // Sign in once through the real form (password sign-in, #271); reuse its storage everywhere.
      const signInContext = await browser.newContext();
      const signInPage = await signInContext.newPage();
      await signInPage.goto(`http://127.0.0.1:${SITE_PORT}/app`);
      await signInPage.waitForSelector("[data-signin-form]", { timeout: 30_000 });
      await signInPage.fill("#dashboard-email", seed.owner.email);
      await signInPage.fill("#dashboard-password", seed.owner.password);
      await signInPage.click("[data-password-signin]");
      await signInPage.waitForFunction(() => document.querySelector("live-dashboard")?.getAttribute("data-state") !== "signed-out"
        && document.querySelector("live-dashboard")?.getAttribute("data-state") !== "loading", undefined, { timeout: 30_000 });
      const storage = await signInContext.storageState();
      await signInContext.close();

      for (const theme of THEMES) for (const viewport of VIEWPORTS) {
        const phone = viewport.width < 768 || viewport.height < 500;
        const context = await browser.newContext({ viewport, colorScheme: theme, hasTouch: true, isMobile: phone, deviceScaleFactor: 1 });
        const signedIn = await browser.newContext({ viewport, colorScheme: theme, hasTouch: true, isMobile: phone, deviceScaleFactor: 1, storageState: storage });
        // tsx (esbuild keepNames) wraps nested functions in __name(); CHECKS runs in the page, so give it a no-op.
        for (const c of [context, signedIn]) await c.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f);" });
        // The app is dark-first: with no stored preference it opens dark whatever the OS says
        // (app.astro). Store this theme explicitly so light captures are really light; each item
        // also records the effective theme, so a mismatch is visible rather than silent.
        for (const c of [context, signedIn]) {
          await c.addInitScript({ content: `try { localStorage.setItem("commonswarm:theme", ${JSON.stringify(theme)}); } catch {}` });
        }
        for (const screen of screens()) {
          const size = `${viewport.width}x${viewport.height}`;
          // The capture's identity follows the manifest entry's declared states (e.g. "empty").
          const state = screen.states?.length ? screen.states.join("+") : "default";
          const entry: Record<string, unknown> = { viewport: size, theme, id: screen.id, state, screenshot: null, error: null };
          if (screen.status === "pending") { report.push({ ...entry, error: "pending", reason: screen.reason ?? null }); continue; }
          const unmet = (screen.requiresSeed ?? []).filter(step => !seed.steps.includes(step));
          if (unmet.length) { report.push({ ...entry, error: `seed precondition unmet: ${unmet.join(", ")}` }); continue; }
          const page = await (screen.signedOut ? context : signedIn).newPage();
          try {
            await page.goto(`http://127.0.0.1:${SITE_PORT}${fill(screen.path, seed.ids)}`, { waitUntil: "domcontentloaded" });
            await page.waitForFunction(() => document.querySelector("live-dashboard")?.getAttribute("data-state") !== "loading", undefined, { timeout: 30_000 });
            await page.waitForTimeout(800);
            for (const step of screen.setup ?? []) {
              if (step.click) await page.click(fill(step.click, seed.ids), { timeout: 8_000 });
              if (step.type) await page.fill(fill(step.type, seed.ids), step.text ?? "");
              if (step.press) await page.keyboard.press(step.press);
              if (step.scroll) await page.locator(fill(step.scroll, seed.ids)).first().scrollIntoViewIfNeeded({ timeout: 8_000 });
              if (step.wait) await page.waitForTimeout(step.wait);
            }
            // Ready is checked AFTER setup, so a dialog's ready selector can name the opened dialog.
            if (screen.ready) await page.waitForSelector(fill(screen.ready, seed.ids), { state: "visible", timeout: 20_000 });
            Object.assign(entry, await page.evaluate(CHECKS));
            const shot = `shots/${screen.id}--${state}--${size}--${theme}.png`;
            await page.screenshot({ path: join(OUT, shot) });
            entry.screenshot = shot;
          } catch (error) {
            entry.error = String(error instanceof Error ? error.message : error).split("\n")[0]!.slice(0, 300);
            try { const shot = `shots/${screen.id}--${state}--${size}--${theme}--error.png`; await page.screenshot({ path: join(OUT, shot) }); entry.screenshot = shot; } catch { /* page gone */ }
          } finally { await page.close(); }
          report.push(entry);
        }
        await context.close(); await signedIn.close();
      }
    } finally { await browser.close(); }
  } finally {
    const summary = { screens: new Set(report.map(r => r.id)).size, items: report.length,
      withOverflow: report.filter(r => ((r.overflow as { offenders?: unknown[] } | undefined)?.offenders?.length ?? 0) > 0).length,
      withSmallTargets: report.filter(r => ((r.tapTargets as unknown[] | undefined)?.length ?? 0) > 0).length,
      withObscured: report.filter(r => ((r.obscured as unknown[] | undefined)?.length ?? 0) > 0).length,
      withOverlaps: report.filter(r => ((r.overlaps as unknown[] | undefined)?.length ?? 0) > 0).length,
      withCollapsedText: report.filter(r => ((r.collapsed as unknown[] | undefined)?.length ?? 0) > 0).length,
      themeMismatches: report.filter(r => r.effectiveTheme !== undefined && r.effectiveTheme !== r.theme).length,
      errors: report.filter(r => r.error && r.error !== "pending").length };
    writeFileSync(join(OUT, "mobile-audit-report.json"), JSON.stringify({ run: process.env.GITHUB_RUN_ID ?? "local", summary, seedNotes, items: report }, null, 2));
    console.log(JSON.stringify(summary));
    await closeSite();
    functions.kill();
    await delay(1_000);
    if (functions.exitCode === null) functions.kill("SIGKILL");
    rmSync(envDir, { recursive: true, force: true });
  }
}

// Registered as one gated browser case: nothing starts unless RUN_BROWSER_TESTS=1 (CI only).
test("mobile audit: seed, capture every manifest screen at six viewports in both themes", { timeout: 50 * 60_000 }, async () => {
  await main();
});
