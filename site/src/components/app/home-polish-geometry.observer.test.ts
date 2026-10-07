/** CI only: layout from the screenshot review. Skipped unless RUN_BROWSER_TESTS=1. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { browserTest as test } from "../../../tests/chrome.js";
import { findChrome, launchChrome } from "../../../tests/chrome.js";

type Geometry = {
  error?: string;
  width: number;
  shellBeforePane: boolean;
  catchupColumns: number;
  sideHidden: boolean;
  headingRing: string;
  buttonRing: string;
  adminDisplay: string;
  adminPosition: string;
  adminRects: number;
  rows: { height: number; oneLine: boolean; nameTruncated: boolean; statusWhole: boolean; title: string; accessible: string }[];
  themes: { theme: string; disconnectedBg: string; disconnectedInk: string; idleBg: string; idleInk: string }[];
};

const siteRoot = fileURLToPath(new URL("../../../", import.meta.url));

test("home polish keeps the header above the view, one rail line, and no heading ring", { timeout: 90_000 }, async () => {
  const bundle = await build({
    absWorkingDir: siteRoot, bundle: true, format: "iife", globalName: "HomePolish", platform: "browser", write: false,
    stdin: { contents: 'export { buildHomeRail } from "./src/lib/home-rail.ts";', resolveDir: siteRoot, loader: "ts" },
  });
  const script = bundle.outputFiles[0]?.text;
  assert.ok(script);
  const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");
  const [tokens, primitives, rail, integration, dashboard, admin] = await Promise.all([
    read("../../styles/tokens.css"), read("../../styles/home/primitives.css"), read("../../styles/home/rail.css"),
    read("../../styles/home/integration.css"), read("./LiveDashboard.astro"), read("./AdminDelegations.astro"),
  ]);
  const main = dashboard.slice(dashboard.indexOf('<div class="hm-frame__main">'), dashboard.indexOf('<section class="dashboard__channel'));
  assert.ok(main.includes("data-home-workspace-shell") && main.indexOf("data-home-workspace-shell") < main.indexOf("data-home-route-pane"));
  const adminStyle = admin.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
  const focusRule = `h1:focus-visible, button:focus-visible { outline: 3px solid var(--focus); outline-offset: 3px; box-shadow: 0 0 0 2px var(--focus-halo); }`;
  const directory = await mkdtemp(join(tmpdir(), "commonswarm-home-polish-"));
  const fixture = join(directory, "index.html");
  try {
    await writeFile(fixture, `<!doctype html><html><head><meta charset="utf-8"><style>
      * { box-sizing: border-box; } body { margin: 0; }
      ${tokens} ${primitives} ${rail} ${integration} ${adminStyle} ${focusRule}
    </style></head><body>
      <div class="hm-frame hm-frame--catchup" id="frame">
        <aside class="hm-frame__rail" id="rail"></aside>
        <main class="hm-frame__main">
          <div data-home-workspace-shell id="shell"><h1 tabindex="-1" id="heading">To-dos</h1></div>
          <section class="hm-route-pane" data-home-route-pane id="pane">To-do</section>
        </main>
        <aside class="hm-frame__side" id="side">Cards</aside>
      </div>
      <button type="button" id="action">Reply</button>
      <button type="button" class="admin-indicator" id="admin">Admin clients and history</button>
      <script>${script}</script><script>
      (() => {
        const metrics = { width: innerWidth };
        try {
          const state = (kind, word) => ({ kind, word, detail: "Measured just now", attention: kind !== "idle", fix: { action: null, allowed: false, askWho: null, sentence: "" } });
          const person = { id: "zoe", name: "Zoe", firstName: "Zoe", initials: "Z", you: true, role: "owner" };
          const longName = "Claude with a very long name that has to truncate before the status word";
          const agent = (id, nested, kind, word) => ({ id, name: nested, label: "Your " + nested, nestedLabel: nested, ownerId: "zoe",
            ownerFirstName: null, ownerInitial: "Z", yours: true, tint: 0, hosted: true, state: state(kind, word) });
          const vm = { sample: false, catchUp: { href: "?v=catchup", current: false, needsYou: null },
            workspaces: [{ id: "W", name: "Home", href: "?w=W", current: true, needsYou: null }],
            people: { title: "People & agents", groups: [{ person, agents: [
              agent("a", longName, "disconnected", "Disconnected"),
              agent("b", "Muse", "working", "Working"),
              agent("c", "dot", "idle", "Idle"),
            ] }], other: [] } };
          document.getElementById("rail").append(HomePolish.buildHomeRail(document, vm, { openPerson() {}, openAgent() {} }));
          const shell = document.getElementById("shell");
          const pane = document.getElementById("pane");
          metrics.shellBeforePane = shell.getBoundingClientRect().top <= pane.getBoundingClientRect().top;
          const frame = document.getElementById("frame");
          metrics.catchupColumns = getComputedStyle(frame).gridTemplateColumns.split(" ").filter(Boolean).length;
          metrics.sideHidden = getComputedStyle(document.getElementById("side")).display === "none";
          const heading = document.getElementById("heading");
          heading.focus();
          const headingStyle = getComputedStyle(heading);
          metrics.headingRing = headingStyle.outlineStyle + "|" + headingStyle.boxShadow;
          const action = document.getElementById("action");
          action.focus();
          const actionStyle = getComputedStyle(action);
          metrics.buttonRing = actionStyle.outlineStyle + "|" + actionStyle.boxShadow;
          const adminButton = document.getElementById("admin");
          const adminStyle = getComputedStyle(adminButton);
          metrics.adminDisplay = adminStyle.display;
          metrics.adminPosition = adminStyle.position;
          metrics.adminRects = adminButton.getClientRects().length;
          const rowMetrics = button => {
            const name = button.querySelector(".hm-rail__name");
            const status = button.querySelector(".hm-rail__status");
            const shape = button.querySelector(".hm-status-shape");
            const word = button.querySelector(".hm-status-word");
            const mid = box => box.top + box.height / 2;
            const nameBox = name.getBoundingClientRect();
            const statusBox = status.getBoundingClientRect();
            const shapeBox = shape.getBoundingClientRect();
            const wordBox = word.getBoundingClientRect();
            return { height: button.getBoundingClientRect().height,
              oneLine: Math.abs(mid(nameBox) - mid(statusBox)) < 6 && Math.abs(mid(shapeBox) - mid(wordBox)) < 6 && wordBox.bottom <= statusBox.bottom + 1,
              nameTruncated: name.scrollWidth > name.clientWidth + 1,
              statusWhole: word.scrollWidth <= word.clientWidth + 1,
              title: name.getAttribute("title"),
              accessible: button.getAttribute("aria-label") };
          };
          metrics.rows = [...document.querySelectorAll("[data-rail-agent]")].map(rowMetrics);
          document.documentElement.dataset.theme = "light";
          const chip = () => {
            const status = document.querySelector('[data-agent-state="disconnected"] .hm-status');
            const idle = document.querySelector('[data-agent-state="idle"] .hm-status');
            const style = getComputedStyle(status);
            return { disconnectedBg: style.backgroundColor, disconnectedInk: style.color, idleBg: getComputedStyle(idle).backgroundColor, idleInk: getComputedStyle(idle).color };
          };
          metrics.themes = [{ theme: document.documentElement.dataset.theme || "light", ...chip() }];
          document.documentElement.dataset.theme = "dark";
          metrics.themes.push({ theme: "dark", ...chip() });
        } catch (error) { metrics.error = String(error); }
        document.documentElement.dataset.metrics = btoa(unescape(encodeURIComponent(JSON.stringify(metrics))));
      })();
      </script></body></html>`, "utf8");
    const chrome = await findChrome();
    for (const width of [1440, 390]) {
      const { stdout } = await launchChrome(chrome, ["--allow-file-access-from-files", `--window-size=${width},900`, "--dump-dom", `file://${fixture}`],
        { maxBuffer: 10 * 1024 * 1024, timeout: 20_000, killSignal: "SIGKILL" });
      const encoded = stdout.match(/^\s*(?:<!doctype html>\s*)?<html\b[^>]*\bdata-metrics="([A-Za-z0-9+/]+={0,2})"/iu)?.[1];
      assert.ok(encoded, "the polish fixture must report measurements");
      const geometry = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as Geometry;
      assert.equal(geometry.error, undefined);
      assert.equal(geometry.width, width);
      assert.equal(geometry.shellBeforePane, true);
      assert.equal(geometry.sideHidden, true);
      assert.equal(geometry.catchupColumns, width === 1440 ? 2 : 1);
      assert.equal(geometry.headingRing.startsWith("none|"), true, geometry.headingRing);
      assert.equal(geometry.headingRing.includes("rgb"), false, geometry.headingRing);
      assert.equal(geometry.buttonRing.startsWith("none|"), false);
      assert.equal(geometry.adminDisplay, "none");
      assert.notEqual(geometry.adminPosition, "fixed");
      assert.equal(geometry.adminRects, 0);
      assert.equal(geometry.rows.length, 3);
      for (const row of geometry.rows) {
        assert.ok(row.height >= 44, `row height ${row.height}`);
        assert.equal(row.oneLine, true);
        assert.equal(row.statusWhole, true);
        assert.ok(row.title && row.accessible?.includes(row.title));
      }
      assert.equal(geometry.rows[0]?.nameTruncated, true);
      assert.equal(geometry.rows[1]?.nameTruncated, false);
      const [light, dark] = geometry.themes;
      /* Canvas design (home-visual 2026-10-07): the rail is ink in both modes and its status words carry
         no chip. Disconnected is the amber word and diamond (--home-offline, #f0b25a in both modes,
         8.67:1 / 10.20:1 on the rail), so it never reads as idle. */
      assert.equal(light?.disconnectedBg, "rgba(0, 0, 0, 0)");
      assert.equal(dark?.disconnectedBg, "rgba(0, 0, 0, 0)");
      assert.equal(light?.disconnectedInk, "rgb(240, 178, 90)");
      assert.equal(dark?.disconnectedInk, "rgb(240, 178, 90)");
      assert.notEqual(light?.disconnectedInk, light?.idleInk);
      assert.notEqual(dark?.disconnectedInk, dark?.idleInk);
      assert.equal(light?.idleBg, "rgba(0, 0, 0, 0)");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
