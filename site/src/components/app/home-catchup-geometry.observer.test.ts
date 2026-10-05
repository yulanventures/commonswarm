import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { join } from "node:path";
import { browserTest as test } from "../../../tests/chrome.js";
import { findChrome, launchChrome } from "../../../tests/chrome.js";

type Geometry = {
  width: number;
  overflow: boolean;
  touchTargets: boolean;
  hostileElements: number;
  hostileText: boolean;
  subline: string;
  loadingBusy: boolean;
  loadingLabel: string;
  failedCopy: boolean;
  latestHeading: string;
  sampleActions: number;
  sampleLinks: number;
};

const primitiveStub = `
export function capsule(doc, c) {
  const el = doc.createElement("span");
  el.className = "hm-stub-capsule";
  el.setAttribute("role", "img");
  el.setAttribute("aria-label", c.person.firstName);
  return el;
}
export function needsYouCard(doc, n, onAction) {
  const article = doc.createElement("article");
  article.className = "hm-stub-needs";
  const button = doc.createElement("button");
  button.type = "button";
  button.className = "hm-stub-needs-action";
  button.textContent = n.primary.label;
  button.addEventListener("click", () => onAction("primary", n));
  const text = doc.createElement("p");
  text.textContent = n.what;
  article.append(text, button);
  return article;
}
`;

test("Catch up geometry keeps 44px targets and hostile text as plain text", { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "commonswarm-catchup-geometry-"));
  const fixture = join(directory, "index.html");
  const bundle = await build({
    absWorkingDir: fileURLToPath(new URL("../../../", import.meta.url)),
    bundle: true,
    entryPoints: ["src/lib/home-catchup.ts"],
    format: "iife",
    globalName: "CatchUp",
    platform: "browser",
    write: false,
    plugins: [{
      name: "home-primitives-stub",
      setup(build) {
        build.onResolve({ filter: /home-primitives$/ }, () => ({ path: "home-primitives-stub", namespace: "stub" }));
        build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: primitiveStub, loader: "ts" }));
      },
    }],
  });
  const script = bundle.outputFiles[0]?.text;
  assert.ok(script);
  const tokens = await readFile(new URL("../../styles/tokens.css", import.meta.url), "utf8");
  const catchupCss = await readFile(new URL("../../styles/home/catchup.css", import.meta.url), "utf8");
  try {
    await writeFile(fixture, `<!doctype html><html><head><style>
      * { box-sizing: border-box; } body { margin: 0; font-family: sans-serif; }
      .hm-stub-needs-action { min-height: 44px; min-width: 44px; }
      ${tokens} ${catchupCss}
    </style></head><body><main id="mount"></main><main id="sample"></main>
      <script>${script}</script><script>
      (async () => {
        const hostile = '<img src=x onerror="document.title=1">';
        const person = (id, firstName, you = false) => ({ id, name: firstName + hostile, firstName, initials: firstName[0], you, role: "member" });
        const capsule = (personId, firstName, you = false) => ({ person: person(personId, firstName, you), agents: [] });
        const vm = {
          sample: false,
          viewerFirstName: "Tom",
          now: "2026-10-05T09:00:00",
          needsYou: [{
            id: "ask", kind: "ask",
            workspace: { id: "paper", name: "My paperwork", href: "?w=paper" },
            from: person("claude", "Claude"), what: hostile, when: "7:40 am",
            primary: { label: "Reply" },
          }],
          workspaces: [
            { id: "home", name: "Home", href: "?w=home", peopleSummary: "You and Nikki", capsules: [capsule("t", "Tom", true), capsule("n", "Nikki")],
              openTodos: 4, lists: 3, files: 3, agentsNeedingAttention: 0, state: "ready" },
            { id: "trip", name: "Summer trip", href: "?w=trip", peopleSummary: "You and Nikki", capsules: [capsule("t", "Tom", true)],
              openTodos: null, lists: null, files: null, agentsNeedingAttention: 1, state: "ready" },
            { id: "broken", name: "Launch crew", href: "?w=crew", peopleSummary: "Just you", capsules: [],
              openTodos: null, lists: null, files: null, agentsNeedingAttention: 0, state: "failed" },
            { id: "loading", name: "My paperwork", href: "?w=paper", peopleSummary: "Just you", capsules: [],
              openTodos: null, lists: null, files: null, agentsNeedingAttention: 0, state: "loading" },
          ],
          latest: [{
            id: "1", authorLabel: "Your Claude",
            workspace: { name: "Home", href: "?w=home", sinceLastLooked: { newMessages: 3, lastSeenAt: "2026-10-04T22:00:00" } },
            excerpt: hostile, when: "8:12 am",
          }],
        };
        const callbacks = { onNeedsYouAction: () => {}, onShowMoreNeedsYou: () => {} };
        const root = CatchUp.renderCatchUp(document, vm, callbacks);
        document.getElementById("mount").append(root);
        const visibleTargets = [...root.querySelectorAll("button, a")].filter((el) => el.getClientRects().length);
        const touchTargets = visibleTargets.length > 0 && visibleTargets.every((el) => {
          const box = el.getBoundingClientRect();
          return box.height >= 44 && box.width >= 44;
        });
        const loadingCard = root.querySelector('[data-workspace-id="loading"]');
        const metrics = {
          width: innerWidth,
          overflow: root.scrollWidth > root.clientWidth,
          touchTargets,
          hostileElements: document.querySelectorAll("img").length,
          hostileText: root.textContent.includes(hostile),
          subline: root.querySelector(".hm-catchup-subline").textContent,
          loadingBusy: loadingCard.getAttribute("aria-busy") === "true",
          loadingLabel: loadingCard.getAttribute("aria-label"),
          failedCopy: root.querySelector('[data-workspace-id="broken"]').textContent.includes("Couldn't load Launch crew"),
          latestHeading: root.querySelector("#hm-catchup-latest-title-0").textContent,
        };
        const sampleRoot = CatchUp.renderCatchUp(document, { ...vm, sample: true }, callbacks);
        document.getElementById("sample").append(sampleRoot);
        metrics.sampleActions = sampleRoot.querySelectorAll("button").length;
        metrics.sampleLinks = sampleRoot.querySelectorAll("a").length;
        document.documentElement.dataset.metrics = btoa(unescape(encodeURIComponent(JSON.stringify(metrics))));
      })();
      </script></body></html>`, "utf8");
    const chrome = await findChrome();
    for (const width of [320, 390, 1440]) {
      const { stdout } = await launchChrome(chrome, [
        "--allow-file-access-from-files",
        `--window-size=${width},900`,
        "--dump-dom",
        `file://${fixture}`,
      ], { maxBuffer: 10 * 1024 * 1024, timeout: 15_000, killSignal: "SIGKILL" });
      const encoded = stdout.match(/^\s*(?:<!doctype html>\s*)?<html\b[^>]*\bdata-metrics="([A-Za-z0-9+/]+={0,2})"/iu)?.[1];
      assert.ok(encoded, `the catch up builder must finish at ${width}px`);
      const geometry = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as Geometry;
      assert.equal(geometry.width, width);
      assert.equal(geometry.overflow, false, `${width}px must not overflow horizontally`);
      assert.equal(geometry.touchTargets, true, `${width}px interactive targets meet 44px by 44px`);
      assert.equal(geometry.hostileElements, 0);
      assert.equal(geometry.hostileText, true);
      assert.equal(geometry.subline, "Checked 2 of 4 workspaces.");
      assert.equal(geometry.loadingBusy, true);
      assert.equal(geometry.loadingLabel, "My paperwork. Checking My paperwork…");
      assert.equal(geometry.failedCopy, true);
      assert.equal(geometry.latestHeading, "3 new since you last looked");
      assert.equal(geometry.sampleActions, 0, "sample mode must render no buttons");
      assert.equal(geometry.sampleLinks, 0, "sample mode must render no links");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
