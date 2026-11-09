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
import { awaitFunctionRunning, observeFunctionCli } from "../support/edge-readiness.js";
import { seedHeavyWorkspace } from "./seed-heavy-workspace.js";
import { browserTest as test, launchPlaywrightChromium } from "../../site/tests/chrome.js";

assert.equal(process.env.RUN_BROWSER_TESTS, "1", "the mobile audit runs in CI only (RUN_BROWSER_TESTS=1)");
const ROOT = resolve(import.meta.dirname, "../..");
const DIST = join(ROOT, "site/dist");
const OUT = resolve(process.env.MOBILE_AUDIT_OUT ?? join(ROOT, "site/mobile-audit/out"));
const SITE_PORT = 4329;

// Verification-only desktop pointer matrix; this branch must never be merged.
export const VIEWPORTS = [
  { width: 1280, height: 900 }, { width: 1440, height: 900 },
] as const;
export const THEMES = ["light", "dark"] as const;

/** One setup step; fields run in this order: media, waitFor, click, type (with text), press, scroll, wait.
 *  media: a CSS media query, evaluated by the page's own matchMedia; the step runs only where it
 *  matches (for example a phone-only drawer open), and where it matches its other fields still fail
 *  when their element is missing.
 *  waitFor: a selector that must become visible first (non-strict, first match, up to 30 s). */
type Step = { media?: string; waitFor?: string; click?: string; type?: string; text?: string; press?: string; wait?: number; scroll?: string };
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
    // Content of a closed <details> (anything but its own summary) is not shown, even when the
    // engine still reports a box for it (::details-content).
    const closed = el.closest("details:not([open])");
    if (closed && !closed.querySelector(":scope > summary")?.contains(el)) return false;
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
  // While a modal dialog is open, only its own controls can be tapped: judge those alone.
  const modal = [...document.querySelectorAll("dialog[open]")].find(d => d.matches(":modal"));
  const tappable = modal ? measured.filter(m => modal.contains(m.el)) : measured;
  const centreInView = (r: DOMRect) => { const x = r.left + r.width / 2, y = r.top + r.height / 2; return x >= 0 && y >= 0 && x < width && y < window.innerHeight; };
  // Scrolling, not a defect: a centre clipped by the target's own scroll container, or content
  // passing under a fixed or sticky bar. Both are skipped; anything else covering a target counts.
  const pinned = (el: Element | null) => { for (let n = el; n; n = n.parentElement) { const p = getComputedStyle(n).position; if (p === "fixed" || p === "sticky") return true; } return false; };
  const clipped = (el: Element, x: number, y: number) => {
    for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
      const st = getComputedStyle(n);
      if (/(auto|scroll|hidden|clip)/u.test(st.overflowX + st.overflowY)) {
        const r = n.getBoundingClientRect();
        if (x < r.left || x > r.right || y < r.top || y > r.bottom) return true;
      }
    }
    return false;
  };
  const scrolledAway = (m: { el: Element; rect: DOMRect }) => {
    const x = m.rect.left + m.rect.width / 2, y = m.rect.top + m.rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    return clipped(m.el, x, y) || (pinned(hit) && !pinned(m.el));
  };
  const obscured = tappable.filter(m => centreInView(m.rect) && !scrolledAway(m) && !reaches(m.el, m.rect.left + m.rect.width / 2, m.rect.top + m.rect.height / 2))
    .slice(0, 20).map(m => ({ selector: describe(m.el), by: describe(document.elementFromPoint(m.rect.left + m.rect.width / 2, m.rect.top + m.rect.height / 2) ?? document.body) }));
  // Non-overlap: two different controls whose measured boxes intersect by more than 4px² share taps.
  const pin = new Map(tappable.map(m => [m.el, pinned(m.el)] as const));
  const overlaps: { a: string; b: string; area: number }[] = [];
  for (let i = 0; i < tappable.length && overlaps.length < 20; i += 1) {
    for (let j = i + 1; j < tappable.length && overlaps.length < 20; j += 1) {
      const a = tappable[i]!, b = tappable[j]!;
      if (a.el.contains(b.el) || b.el.contains(a.el) || labelFor(a.el)?.contains(b.el) || labelFor(b.el)?.contains(a.el)) continue;
      if (pin.get(a.el) !== pin.get(b.el)) continue; // scrolling content under a fixed or sticky bar
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
  const cliState = observeFunctionCli(functions);
  const capture = (chunk: Buffer) => { functionLogs = (functionLogs + chunk.toString("utf8")).slice(-20_000); };
  functions.stdout?.on("data", capture); functions.stderr?.on("data", capture);
  const closeSite = await serveDist();
  const report: Record<string, unknown>[] = [];
  let seedNotes: string[] = [];
  let captureErrors = -1;
  try {
    for (const fn of ["command", "read"]) {
      await awaitFunctionRunning({ url: `${env.apiUrl}/functions/v1/${fn}`, fetcher: fetch, timeoutMs: 60_000,
        sleep: ms => delay(ms), now: () => Date.now(), diagnostics: () => functionLogs.slice(-4000), cliState });
    }
    const seed = await seedHeavyWorkspace(env);
    seedNotes = seed.notes;
    writeFileSync(join(OUT, "seed.json"), JSON.stringify({ ids: seed.ids, notes: seed.notes, steps: seed.steps }, null, 2));
    console.log(JSON.stringify({ phase: "seeded", steps: seed.steps.length, notes: seed.notes.length }));

    const runPool = async <T, R>(items: readonly T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> => {
      const results = new Array<R>(items.length);
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (next < items.length) {
          const index = next++;
          results[index] = await worker(items[index]!);
        }
      }));
      return results;
    };

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
        const size = `${viewport.width}x${viewport.height}`;
        const phone = viewport.width < 768 || viewport.height < 500;
        const context = await browser.newContext({ viewport, colorScheme: theme, hasTouch: false, isMobile: phone, deviceScaleFactor: 1 });
        const signedIn = await browser.newContext({ viewport, colorScheme: theme, hasTouch: false, isMobile: phone, deviceScaleFactor: 1, storageState: storage });
        // tsx (esbuild keepNames) wraps nested functions in __name(); CHECKS runs in the page, so give it a no-op.
        // Also track in-flight fetches so background post-hydration loads (loadHomeWorkspace, householdDashboard,
        // skills, definitions) settle before setup steps interact with the DOM.
        for (const c of [context, signedIn]) await c.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f); if (!globalThis.__auditFetchWrapped && typeof globalThis.fetch === 'function') { globalThis.__auditFetchWrapped = true; globalThis.__auditPendingFetches = 0; globalThis.__auditLastFetchDoneAt = 0; const orig = globalThis.fetch.bind(globalThis); globalThis.fetch = (...args) => { globalThis.__auditPendingFetches += 1; return orig(...args).finally(() => { globalThis.__auditPendingFetches = Math.max(0, globalThis.__auditPendingFetches - 1); globalThis.__auditLastFetchDoneAt = performance.now(); }); }; }" });
        // The app is dark-first: with no stored preference it opens dark whatever the OS says
        // (app.astro). Store this theme explicitly so light captures are really light; each item
        // also records the effective theme, so a mismatch is visible rather than silent.
        for (const c of [context, signedIn]) {
          await c.addInitScript({ content: `try { localStorage.setItem("commonswarm:theme", ${JSON.stringify(theme)}); for (const k of Object.keys(localStorage)) { if (k.startsWith("commonswarm:composer-draft:")) localStorage.removeItem(k); } } catch {}` });
        }
        const batch = await runPool(screens(), 3, async (screen) => {
          // The capture's identity follows the manifest entry's declared states (e.g. "empty").
          const state = screen.states?.length ? screen.states.join("+") : "default";
          const entry: Record<string, unknown> = { viewport: size, theme, id: screen.id, state, screenshot: null, error: null };
          if (screen.status === "pending") return { ...entry, error: "pending", reason: screen.reason ?? null };
          const unmet = (screen.requiresSeed ?? []).filter(step => !seed.steps.includes(step));
          if (unmet.length) return { ...entry, error: `seed precondition unmet: ${unmet.join(", ")}` };
          const page = await (screen.signedOut ? context : signedIn).newPage();
          try {
            await page.goto(`http://127.0.0.1:${SITE_PORT}${fill(screen.path, seed.ids)}`, { waitUntil: "domcontentloaded" });
            await page.waitForFunction(() => {
              const app = document.querySelector("live-dashboard");
              if (!app) return true;
              if (app.getAttribute("data-state") === "loading") return false;
              const channelVisible = !app.querySelector<HTMLElement>(".dashboard__channel")?.hidden;
              if (channelVisible && app.getAttribute("data-channel-view") === "feed-pending") return false;
              const w = globalThis as unknown as { __auditPendingFetches?: number; __auditLastFetchDoneAt?: number };
              return (w.__auditPendingFetches ?? 0) === 0 && performance.now() - (w.__auditLastFetchDoneAt ?? 0) >= 150;
            }, undefined, { timeout: 30_000 });
            await page.waitForTimeout(screen.path.startsWith("/app") ? 250 : 50);
            for (const step of screen.setup ?? []) {
              if (step.media && !(await page.evaluate((query: string) => window.matchMedia(query).matches, step.media))) continue;
              if (step.waitFor) await page.waitForSelector(fill(step.waitFor, seed.ids), { state: "visible", timeout: 20_000 });
              if (step.click) {
                const target = fill(step.click, seed.ids);
                if (target === '[data-brain-topic="overview"]' && await page.evaluate(() => window.matchMedia("(width <= 52rem)").matches && Boolean(document.querySelector("div[data-brain-selection-prompt]:not([hidden])")))) {
                  try { await page.click(target, { timeout: 5_000 }); }
                  catch {
                    entry.bypassedInteractions = [{ selector: target, by: "div[data-brain-selection-prompt].dashboard__brain-selection-prompt" }];
                    await page.locator(target).first().click({ force: true, timeout: 5_000 });
                  }
                } else {
                  await page.click(target, { timeout: 8_000 });
                }
              }
              if (step.type) await page.fill(fill(step.type, seed.ids), step.text ?? "");
              if (step.press) await page.keyboard.press(step.press);
              if (step.scroll) await page.locator(fill(step.scroll, seed.ids)).first().scrollIntoViewIfNeeded({ timeout: 8_000 });
              if (step.wait) await page.waitForTimeout(step.wait);
              if (screen.id === "app.chat.pointer-message" || screen.id === "app.chat.keyboard-secondary") {
              const focus = await page.evaluate((signalId: string) => {
                const active = document.activeElement as HTMLElement | null;
                const row = document.querySelector(`[data-signal-id="${signalId}"]`);
                const describe = (el: Element | null) => el ? `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}.${typeof el.className === "string" ? el.className.split(/\s+/).join(".") : ""}` : null;
                const box = (el: Element) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
                const ancestors = [];
                for (let n = active; n && n !== document.body; n = n.parentElement) {
                  const css = getComputedStyle(n);
                  ancestors.push({ element: describe(n), box: box(n), opacity: css.opacity, visibility: css.visibility, overflow: css.overflow, clip: css.clipPath });
                }
                return { active: describe(active), tabIndex: active?.tabIndex, text: active?.textContent?.slice(0, 100), row: active?.closest("[data-signal-id]")?.getAttribute("data-signal-id"), withinExpected: !!row?.contains(active), documentFocused: document.hasFocus(), ancestors,
                  candidates: [...(row?.querySelectorAll("button,a[href],summary,[tabindex]") ?? [])].map(el => ({ element: describe(el), tabIndex: (el as HTMLElement).tabIndex, box: box(el), text: el.textContent?.slice(0, 70), visibility: getComputedStyle(el).visibility, opacity: getComputedStyle(el).opacity })) };
              }, seed.ids["message.richtext.code"]!);
              entry.focusTrace ??= [];
              (entry.focusTrace as unknown[]).push({ step, focus });
              }
            }
            // Ready is checked AFTER setup, so a dialog's ready selector can name the opened dialog.
            if (screen.ready) await page.waitForSelector(fill(screen.ready, seed.ids), { state: "visible", timeout: 20_000 });
            Object.assign(entry, await page.evaluate(CHECKS));
            const shot = `shots/${screen.id}--${state}--${size}--${theme}.png`;
            await page.screenshot({ path: join(OUT, shot) });
            entry.screenshot = shot;
          } catch (error) {
            entry.error = String(error instanceof Error ? error.message : error).split("\n")[0]!.slice(0, 300);
            console.log(JSON.stringify({ phase: "capture-error", viewport: size, theme, id: screen.id, error: entry.error }));
            try { const shot = `shots/${screen.id}--${state}--${size}--${theme}--error.png`; await page.screenshot({ path: join(OUT, shot) }); entry.screenshot = shot; } catch { /* page gone */ }
          } finally { await page.close(); }
          return entry;
        });
        report.push(...batch);
        console.log(JSON.stringify({ phase: "viewport-done", viewport: size, theme, errors: batch.filter(r => r.error && r.error !== "pending").length }));
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
      withBypassedInteractions: report.filter(r => ((r.bypassedInteractions as unknown[] | undefined)?.length ?? 0) > 0).length,
      themeMismatches: report.filter(r => r.effectiveTheme !== undefined && r.effectiveTheme !== r.theme).length,
      errors: report.filter(r => r.error && r.error !== "pending").length };
    writeFileSync(join(OUT, "mobile-audit-report.json"), JSON.stringify({ run: process.env.GITHUB_RUN_ID ?? "local", summary, seedNotes, items: report }, null, 2));
    console.log(JSON.stringify(summary));
    captureErrors = summary.errors;
    await closeSite();
    functions.kill();
    await delay(1_000);
    if (functions.exitCode === null) functions.kill("SIGKILL");
    rmSync(envDir, { recursive: true, force: true });
  }
  // Fail after the report and screenshots are written (the upload step still runs), so a green
  // workflow can never hide a missing capture. Pending entries are not errors.
  assert.equal(captureErrors, 0, `${captureErrors} capture(s) failed; see mobile-audit-report.json items[].error`);
}

// Registered as one gated browser case: nothing starts unless RUN_BROWSER_TESTS=1 (CI only).
test("mobile audit: seed, capture every manifest screen at six viewports in both themes", { timeout: 50 * 60_000 }, async () => {
  await main();
});
