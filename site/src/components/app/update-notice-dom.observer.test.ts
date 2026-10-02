/** Execute the shipped notice code with parsed HTML and DOM mutations, without a browser.
 * The existing browser observer requires Chrome and does not cover pre-init injected links.
 * BANNER_SOURCE_ROOT selects an untouched baseline for the same regression invocation.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { parse, serializeOuter } from "parse5";

const siteRoot = resolve(import.meta.dirname, "../../..");
const sourceRoot = process.env.BANNER_SOURCE_ROOT ?? siteRoot;
const dashboardSource = readFileSync(resolve(sourceRoot, "src/components/app/LiveDashboard.astro"), "utf8");
const appSource = readFileSync(resolve(sourceRoot, "src/pages/app.astro"), "utf8");
const start = dashboardSource.indexOf("const buildAssetsFrom =");
const finish = dashboardSource.indexOf("\n    startUpdatePoll();", start) + "\n    startUpdatePoll();".length;
assert.ok(start >= 0 && finish > start, "notice executable boundary exists");
const noticeCode = ts.transpileModule(dashboardSource.slice(start, finish), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const snapshotCode = appSource.match(/<script\b[^>]*data-app-build-snapshot[^>]*>([\s\S]*?)<\/script>/)?.[1];

const html = (build = "A", copy = "Original copy") => `<!doctype html><html><head>
<link rel="stylesheet" href="/_astro/app.${build}.css">
</head><body><live-dashboard><p>${copy}</p></live-dashboard>
<script type="module" src="/_astro/app.${build}.js"></script></body></html>`;

// Real HTML parsing/serialization; only DOM access and event/timer delivery are simulated.
function documentFrom(body: string) {
  const tree = parse(body);
  const nodes: any[] = [];
  const walk = (node: any) => {
    nodes.push(node);
    for (const child of node.childNodes ?? []) walk(child);
  };
  walk(tree);
  const attr = (node: any, name: string) => node.attrs?.find((item: any) => item.name === name)?.value ?? null;
  const assetNodes = nodes.filter(node =>
    (node.tagName === "script" && attr(node, "src")) || (node.tagName === "link" && attr(node, "href")));
  const assets = assetNodes.map(node => ({ getAttribute: (name: string) => attr(node, name) }));
  const attributes = new Map<string, string>();
  return {
    assets,
    querySelectorAll: () => assets,
    querySelector: (selector: string) => selector === "live-dashboard"
      ? (() => {
          const node = nodes.find(node => node.tagName === "live-dashboard");
          return node ? { outerHTML: serializeOuter(node) } : null;
        })()
      : null,
    documentElement: {
      getAttribute: (name: string) => attributes.get(name) ?? null,
      setAttribute: (name: string, value: string) => attributes.set(name, value),
    },
    visibilityState: "visible",
    addEventListener: () => {},
  };
}

function boot({ loaded = html(), served = loaded, storage = new Map<string, string>(), storageBlocked = false, runtimeAssets = true } = {}) {
  const document = documentFrom(loaded);
  const callbacks = new Map<string, () => void>();
  const intervals = new Map<number, { fn: () => void; ms: number }>();
  const notice = { hidden: true };
  let reloads = 0;
  let requests = 0;
  let response: () => Promise<{ ok: boolean; text: () => Promise<string> }> = async () => ({
    ok: true, text: async () => served,
  });
  const context = vm.createContext({
    document,
    DOMParser: class { parseFromString(body: string) { return documentFrom(body); } },
    fetch: async (path: string, options: any) => {
      assert.equal(path, "/app", "auth callback query is not replayed");
      assert.equal(options.cache, "no-store");
      requests++;
      return response();
    },
    one: (selector: string) => selector === "[data-update-notice]" ? notice : {
      addEventListener: (_event: string, fn: () => void) => callbacks.set(selector, fn),
    },
    window: {
      location: { pathname: "/app", search: "?code=one-time", reload: () => { reloads++; } },
      sessionStorage: {
        getItem: (key: string) => { if (storageBlocked) throw new Error("blocked"); return storage.get(key) ?? null; },
        setItem: (key: string, value: string) => { if (storageBlocked) throw new Error("blocked"); storage.set(key, value); },
      },
      setInterval: (fn: () => void, ms: number) => { const id = intervals.size + 1; intervals.set(id, { fn, ms }); return id; },
      clearInterval: (id: number) => intervals.delete(id),
    },
  });
  // The parser's inline snapshot executes before deferred module code. Runtime preload links
  // then appear, including lazy CSS with rel=stylesheet, exactly as Vite's helper adds them.
  if (snapshotCode) vm.runInContext(snapshotCode, context);
  const injected = documentFrom(`<link rel="modulepreload" href="/_astro/runtime.LAZY.js">
    <link rel="stylesheet" href="/_astro/runtime.LAZY.css">`);
  if (runtimeAssets) document.assets.push(...injected.assets);
  vm.runInContext(noticeCode, context);
  return {
    notice, storage, document,
    reloads: () => reloads,
    requests: () => requests,
    served: (body: string) => { served = body; },
    response: (fn: typeof response) => { response = fn; },
    flush: () => new Promise<void>(resolve => setImmediate(resolve)),
    poll: async () => {
      assert.equal(intervals.size, 1);
      const timer = [...intervals.values()][0];
      assert.equal(timer.ms, 5 * 60_000, "five-minute polling stays intact");
      timer.fn();
      await new Promise(resolve => setImmediate(resolve));
    },
    dismiss: () => callbacks.get("[data-update-dismiss]")!(),
    update: () => callbacks.get("[data-update-reload]")!(),
  };
}

async function stable(options?: Parameters<typeof boot>[0]) {
  const app = boot(options);
  await app.flush();
  assert.equal(app.notice.hidden, true, "unchanged served HTML must ignore runtime-added assets");
  return app;
}

test("stable served page ignores modulepreload and lazy stylesheet links", async () => {
  const loaded = process.env.BANNER_HTML ? readFileSync(process.env.BANNER_HTML, "utf8") : html();
  const app = await stable({ loaded });
  await app.poll();
  assert.equal(app.notice.hidden, true);
});

test("a new served asset set shows the notice, even on the first poll", async () => {
  await stable();
  const app = boot({ loaded: html(), served: html("B") });
  await app.flush();
  assert.equal(app.notice.hidden, false);
});

test("a markup-only change shows the notice with the same asset set", async () => {
  const app = await stable();
  app.served(html("A", "Updated copy"));
  await app.poll();
  assert.equal(app.notice.hidden, false);
});

test("Dismiss survives polls, rollback and reload for that build; a newer build shows", async () => {
  // No stable() precondition: this independently detects lost session dismissal on main.
  const loaded = html();
  const buildB = html("B");
  const app = boot({ loaded, served: buildB, runtimeAssets: false });
  await app.flush();
  assert.equal(app.notice.hidden, false);
  app.dismiss();
  assert.equal(app.notice.hidden, true);
  await app.poll();
  assert.equal(app.notice.hidden, true);
  app.served(loaded);
  await app.poll();
  app.served(buildB);
  await app.poll();
  assert.equal(app.notice.hidden, true, "an unchanged poll must not erase dismissal");
  const reloaded = boot({ loaded, served: buildB, storage: app.storage, runtimeAssets: false });
  await reloaded.flush();
  assert.equal(reloaded.notice.hidden, true, "dismissed signature survives reloading an older cached document");
  reloaded.served(html("B", "Newer markup"));
  await reloaded.poll();
  assert.equal(reloaded.notice.hidden, false);
  reloaded.dismiss();
  reloaded.served(buildB);
  await reloaded.poll();
  assert.equal(reloaded.notice.hidden, true, "dismissing another build preserves earlier build dismissals");
  const again = boot({ loaded, served: buildB, storage: app.storage, runtimeAssets: false });
  await again.flush();
  assert.equal(again.notice.hidden, true);
});

test("Update reloads the unchanged served build without bringing the notice back", async () => {
  const app = await stable();
  app.served(html("B"));
  await app.poll();
  assert.equal(app.notice.hidden, false);
  app.update();
  assert.equal(app.reloads(), 1);
  const reloaded = await stable({ loaded: html("B") });
  await reloaded.poll();
  assert.equal(reloaded.notice.hidden, true);
});

test("storage failure, non-app responses, queued polls and actions preserve notice state", async () => {
  const app = await stable({ storageBlocked: true });
  for (const body of ["<p>Sign in</p>", '<script src="/_astro/other.B.js"></script>']) {
    app.served(body);
    await app.poll();
    assert.equal(app.notice.hidden, true);
  }
  app.response(async () => ({ ok: false, text: async () => html("B") }));
  await app.poll();
  assert.equal(app.notice.hidden, true);
  app.response(async () => ({ ok: true, text: async () => html("B") }));
  await app.poll();
  assert.equal(app.notice.hidden, false);
  let settle!: (value: { ok: boolean; text: () => Promise<string> }) => void;
  app.response(() => new Promise(resolve => { settle = resolve; }));
  await app.poll();
  const beforeQueue = app.requests();
  await app.poll();
  assert.equal(app.requests(), beforeQueue, "only one poll is in flight");
  app.dismiss();
  let queuedSettle!: typeof settle;
  app.response(() => new Promise(resolve => { queuedSettle = resolve; }));
  settle({ ok: true, text: async () => html("C") });
  await app.flush();
  assert.equal(app.requests(), beforeQueue + 1, "queued poll runs after the open one");
  assert.equal(app.notice.hidden, true, "stale response cannot undo dismissal, including when storage throws");
  queuedSettle({ ok: true, text: async () => html("B") });
  await app.flush();
  app.response(async () => ({ ok: true, text: async () => html("B") }));
  await app.poll();
  assert.equal(app.notice.hidden, true);
});
