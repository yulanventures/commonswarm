/**
 * Mobile audit runner (CS-MOBILE-AUDIT-20261103). CI ONLY: the `mobile-audit` suite in
 * .github/workflows/server-suite.yml starts the local stack, builds the site against it and runs
 * this file. It refuses to run without RUN_BROWSER_TESTS=1 and refuses non-loopback targets.
 *
 * For each screen x viewport x theme it records horizontal overflow, small tap targets and
 * horizontally clipped controls, and takes a viewport screenshot. It is report-only: findings go
 * into mobile-audit-report.json and the process exits 0 unless the harness itself cannot run.
 *
 * Witnesses (audit-checks.ts) are recorded beside the raw lists and never filter them: read-only
 * geometry after the primary screenshot (front overlay and what it covers, small-target facts, link
 * label fragments, disclosure summaries, overlap points), then native-key keyboard witnesses last.
 * Witness findings are report-only; the job fails on capture errors and on the fixture matrix.
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
import { CHECKS, GEOMETRY_WITNESS, runKeyboardWitness, witnessSummary, type KeyboardSpec } from "./audit-checks.js";
// The fixture regression matrix registers first, so a broken witness contract fails before the long run.
import "./witness-matrix.js";

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

/** Overlay roots the generic rules cannot recognise, counted only while shown. */
const DECLARED_OVERLAYS: Record<string, string[]> = {
  "app.entity-detail": ["[data-entity-panel]:not([hidden])"],
  "nav.workspace-picker": ["[data-workspace-picker][open] .cs-workspace-picker__list"],
  "menu.account": ["[data-user-menu]:not([hidden])"],
};
/** Keyboard witnesses, by screen. They start from the focus the app itself set, or the document entry. */
const KEYBOARD_WITNESSES: Record<string, KeyboardSpec[]> = {
  "menu.provider": [{
    name: "provider-back",
    start: { active: '[data-channel-view="agent-choice"]:not([hidden]) [data-ahp-detail="claude"] .hm-ahp__title-anchor' },
    keys: [{ key: "Shift+Tab", expect: '[data-channel-view="agent-choice"]:not([hidden]) [data-ahp-detail="claude"] > [data-ahp-back]' }],
    activate: { key: "Enter", expect: { active: '[data-channel-view="agent-choice"]:not([hidden]) [data-ahp-host="claude"]' } },
  }],
  "route.terms": [{
    name: "skip-link",
    start: "document",
    keys: [{ key: "Tab", expect: "a.skip-link" }],
    activate: { key: "Enter", expect: { hash: "#main", inView: "#main" } },
  }],
};

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
        const context = await browser.newContext({ viewport, colorScheme: theme, hasTouch: true, isMobile: phone, deviceScaleFactor: 1 });
        const signedIn = await browser.newContext({ viewport, colorScheme: theme, hasTouch: true, isMobile: phone, deviceScaleFactor: 1, storageState: storage });
        // tsx (esbuild keepNames) wraps nested functions in __name(); CHECKS runs in the page, so give it a no-op.
        // Also track in-flight fetches so background post-hydration loads (loadHomeWorkspace, householdDashboard,
        // skills, definitions) settle before setup steps interact with the DOM.
        for (const c of [context, signedIn]) await c.addInitScript({ content: "globalThis.__name = globalThis.__name || ((f) => f); window.addEventListener('storage', (e) => { if (e.key && e.key.includes('auth-token')) e.stopImmediatePropagation(); }, true); if (typeof globalThis.BroadcastChannel === 'function') { const OrigBC = globalThis.BroadcastChannel; globalThis.BroadcastChannel = class extends OrigBC { addEventListener(type, listener, opts) { if (type === 'message') return; return super.addEventListener(type, listener, opts); } set onmessage(_fn) {} }; } if (!globalThis.__auditFetchWrapped && typeof globalThis.fetch === 'function') { globalThis.__auditFetchWrapped = true; globalThis.__auditPendingFetches = 0; globalThis.__auditLastFetchDoneAt = 0; const orig = globalThis.fetch.bind(globalThis); globalThis.fetch = (...args) => { globalThis.__auditPendingFetches += 1; return orig(...args).finally(() => { globalThis.__auditPendingFetches = Math.max(0, globalThis.__auditPendingFetches - 1); globalThis.__auditLastFetchDoneAt = performance.now(); }); }; }" });
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
              return !(channelVisible && app.getAttribute("data-channel-view") === "feed-pending");
            }, undefined, { timeout: 30_000 });
            await page.waitForFunction(({ id, hasWorkspace }: { id: string; hasWorkspace: boolean }) => {
              if (hasWorkspace && !document.querySelector('[data-home-workspace-shell] [data-home-pane="todos"]')) return false;
              if (id.startsWith("app.definitions") && !document.querySelector('.household-definitions [data-def-action="select"]')) return false;
              if (id.startsWith("app.skills") && !document.querySelector(".household-skills [data-skill-action]")) return false;
              if (id === "app.lists" && !document.querySelector('[data-household-objects] [data-hh-action="select"]')) return false;
              const w = globalThis as unknown as { __auditPendingFetches?: number; __auditLastFetchDoneAt?: number };
              return (w.__auditPendingFetches ?? 0) === 0 && performance.now() - (w.__auditLastFetchDoneAt ?? 0) >= 400;
            }, { id: screen.id, hasWorkspace: screen.path.includes("?w=") }, { timeout: screen.path.includes("v=lists") ? 45_000 : 30_000 }).catch(() => {});
            await page.waitForTimeout(screen.path.startsWith("/app") ? 250 : 50);
            for (const step of screen.setup ?? []) {
              if (step.media && !(await page.evaluate((query: string) => window.matchMedia(query).matches, step.media))) continue;
              if (step.waitFor) await page.waitForSelector(fill(step.waitFor, seed.ids), { state: "visible", timeout: 30_000 });
              if (step.click) {
                const target = fill(step.click, seed.ids);
                if ((target.startsWith(".cs-kylon-workspace-menu") || target === "[data-user-menu-trigger]" || target === "[data-account-agents-open]" || target.startsWith("[data-rail-channel-menu="))
                  && await page.evaluate(() => window.matchMedia("(width <= 52rem)").matches && !document.querySelector("dialog.cs-org-drawer[open]"))) {
                  await page.click('button[aria-label="Open navigation"]', { timeout: 5_000 }).catch(() => {});
                  await page.waitForSelector("dialog.cs-org-drawer[open]", { state: "visible", timeout: 5_000 }).catch(() => {});
                }
                if (target === '[data-brain-topic="overview"]') {
                  const waitBrainTopicLoaded = async () => {
                    for (let attempt = 0; attempt < 3; attempt++) {
                      await page.waitForSelector("[data-brain-detail]:not([hidden]) :is([data-brain-body-mode]:not([hidden]), [data-brain-retry]:not([hidden]):not([disabled]))", { state: "visible", timeout: 15_000 }).catch(() => {});
                      const loaded = await page.evaluate(() => {
                        const md = document.querySelector<HTMLElement>("[data-brain-detail]:not([hidden]) [data-brain-markdown]:not([hidden])");
                        return Boolean(md && md.childElementCount > 0 && document.querySelector("[data-brain-body-mode]:not([hidden])"));
                      });
                      if (loaded) break;
                      if (await page.evaluate(() => Boolean(document.querySelector("[data-brain-retry]:not([hidden]):not([disabled])")))) {
                        await page.click("[data-brain-retry]", { timeout: 5_000 }).catch(() => {});
                      } else {
                        await page.click(target, { timeout: 8_000 }).catch(() => {});
                      }
                    }
                  };
                  await page.click(target, { timeout: 8_000 });
                  await waitBrainTopicLoaded();
                  if (screen.id === "app.wiki.topic" && await page.evaluate(() => window.matchMedia("(width <= 52rem)").matches)) {
                    await page.click("[data-brain-back]", { timeout: 8_000 });
                    await page.waitForSelector('[data-channel-view="brain"][data-brain-selection="index"] [data-brain-topic="overview"]', { state: "visible", timeout: 8_000 });
                    await page.click(target, { timeout: 8_000 });
                    await waitBrainTopicLoaded();
                  }
                } else if (target.startsWith("[data-rail-channel-menu=")) {
                  for (let attempt = 0; attempt < 3; attempt++) {
                    if (await page.evaluate(() => window.matchMedia("(width <= 52rem)").matches && !document.querySelector("dialog.cs-org-drawer[open]"))) {
                      await page.click('button[aria-label="Open navigation"]', { timeout: 5_000 }).catch(() => {});
                      await page.waitForSelector("dialog.cs-org-drawer[open]", { state: "visible", timeout: 5_000 }).catch(() => {});
                    }
                    await page.locator(target).first().scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
                    await page.waitForTimeout(150);
                    await page.click(target, { timeout: 8_000 });
                    const menuVisible = await page.waitForSelector('.cs-context-menu[role="menu"] [role="menuitem"]', { state: "visible", timeout: 1_500 }).then(() => true, () => false);
                    if (menuVisible) break;
                  }
                } else {
                  await page.click(target, { timeout: 8_000 });
                  if (target === 'button[aria-label="Open navigation"]') {
                    const drawerOpen = await page.waitForSelector("dialog.cs-org-drawer[open]", { state: "visible", timeout: 1_500 }).then(() => true, () => false);
                    if (!drawerOpen) await page.click(target, { timeout: 5_000 }).catch(() => {});
                  } else if (target.endsWith(".hm-menu__trigger")) {
                    const menuOpen = await page.waitForSelector(":is(.cs-kylon-workspace-menu, .hm-ws-header) .hm-menu__list:not([hidden])", { state: "visible", timeout: 1_500 }).then(() => true, () => false);
                    if (!menuOpen) await page.click(target, { timeout: 5_000 }).catch(() => {});
                  } else if (target === "[data-user-menu-trigger]") {
                    const userMenuOpen = await page.waitForSelector("[data-user-menu]:not([hidden])", { state: "visible", timeout: 1_500 }).then(() => true, () => false);
                    if (!userMenuOpen) await page.click(target, { timeout: 5_000 }).catch(() => {});
                  } else if (target.startsWith('[data-def-action="select"]')) {
                    const selected = await page.waitForSelector(`${target}[aria-current="true"]`, { state: "visible", timeout: 10_000 }).then(() => true, () => false);
                    if (!selected) {
                      await page.click(target, { timeout: 5_000 }).catch(() => {});
                      await page.waitForSelector(`${target}[aria-current="true"]`, { state: "visible", timeout: 15_000 }).catch(() => {});
                    }
                  }
                }
              }
              if (step.type) await page.fill(fill(step.type, seed.ids), step.text ?? "");
              if (step.press) await page.keyboard.press(step.press);
              if (step.scroll) {
                const scrollTarget = fill(step.scroll, seed.ids);
                try { await page.locator(scrollTarget).first().scrollIntoViewIfNeeded({ timeout: 8_000 }); }
                catch { await page.waitForTimeout(300); await page.locator(scrollTarget).first().scrollIntoViewIfNeeded({ timeout: 8_000 }); }
              }
              if (step.wait) await page.waitForTimeout(step.wait);
            }
            // Ready is checked AFTER setup, so a dialog's ready selector can name the opened dialog.
            if (screen.ready) await page.waitForSelector(fill(screen.ready, seed.ids), { state: "visible", timeout: 30_000 });
            Object.assign(entry, await page.evaluate(CHECKS));
            const shot = `shots/${screen.id}--${state}--${size}--${theme}.png`;
            await page.screenshot({ path: join(OUT, shot) });
            entry.screenshot = shot;
            // Witnesses: read-only geometry first, then native-key keyboard witnesses, which change state.
            try { entry.witness = await page.evaluate(GEOMETRY_WITNESS, DECLARED_OVERLAYS[screen.id] ?? []); }
            catch (error) { entry.witness = { error: String(error instanceof Error ? error.message : error).split("\n")[0]!.slice(0, 300) }; }
            const keyboardSpecs = KEYBOARD_WITNESSES[screen.id] ?? [];
            if (keyboardSpecs.length) {
              // Pointer to a corner first, so :hover cannot stand in for focus.
              await page.mouse.move(1, 1);
              entry.keyboard = [];
              for (const spec of keyboardSpecs) (entry.keyboard as unknown[]).push(await runKeyboardWitness(page, spec));
            }
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
      errors: report.filter(r => r.error && r.error !== "pending").length,
      // Witness counters, appended; every key above keeps its meaning.
      witnesses: witnessSummary(report) };
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
