import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { join } from "node:path";
import { browserTest as test } from "../../../tests/chrome.js";
import { findChrome, launchChrome } from "../../../tests/chrome.js";

const dashboard = await readFile(new URL("./LiveDashboard.astro", import.meta.url), "utf8");
const style = dashboard.match(/<style\b[^>]*>([\s\S]*?)<\/style>/)?.[1];
assert.ok(style, "LiveDashboard must expose its component stylesheet to the geometry fixture");

type Geometry = { width: number; listWidth: number; detailWidth: number; rowOverflow: boolean; touchTargets: boolean;
  hostileElements: number; hostileText: boolean; accessMark: string | null; modelValues: (string | null)[];
  confirmRole: string | null; safeConfirmFocus: boolean; detailTouchTargets: boolean; closeIconSize: number; backIconSize: number; cancelRestoresOpener: boolean; outerStillOpen: boolean; technicalClosed: boolean };

// CI only: build the production DOM builder rather than recreating obsolete row markup.
test("A2 rows, details and confirms have usable geometry and preserve plain text", { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "commonswarm-agent-geometry-"));
  const fixture = join(directory, "index.html");
  const bundle = await build({ absWorkingDir: fileURLToPath(new URL("../../../", import.meta.url)), bundle: true,
    entryPoints: ["src/lib/people-dialog-view.ts"], format: "iife", globalName: "PeopleView", platform: "browser", write: false });
  const script = bundle.outputFiles[0]?.text; assert.ok(script);
  const tokens = await readFile(new URL("../../styles/tokens.css", import.meta.url), "utf8");
  try {
    await writeFile(fixture, `<!doctype html><html><head><style>
      * { box-sizing: border-box; } body { margin: 0; font-family: sans-serif; }
      .dashboard [hidden] { display: none !important; }
      ${tokens} ${style}
    </style></head><body><main class="dashboard"><dialog class="dashboard__roster-dialog" data-roster-dialog aria-labelledby="dashboard-roster-title">
      <header class="dashboard__roster-dialog-head"><h2 id="dashboard-roster-title">People &amp; agents</h2><button class="dashboard__icon-button" data-roster-close aria-label="Close People &amp; agents">×</button></header>
      <div class="dashboard__roster-dialog-body"><div class="dashboard__roster-dialog-list" id="roster"></div><section class="pd-detail" id="detail" hidden></section></div>
      <dialog class="pd-confirm" id="confirm"></dialog></dialog></main>
      <script>${script}</script><script>
      (async () => {
        const hostile = '<img src=x onerror="document.title=1">';
        const agent = { id: 'agent', name: 'Alexandria Montgomery-Sutherland '+hostile, ownerId: 'person', ownerName: 'Mei Langridge', model: hostile,
          app: 'Claude', hosted: true, own: true, mayManage: true, liveKey: true, key: 'Uses a key to connect.',
          status: { kind: 'paused', label: 'Paused: unused for 14 days', sentence: 'Resume it so it can connect again.', attention: true, fix: { action: 'resume', allowed: true } },
          receive: 'Checks messages when you chat with it.', lastActive: '15 days ago', technical: ['Agent ID: agent'], updateAvailable: false, access: { until: null }, accessReadState: 'succeeded', receipt: '' };
        const model = { people: [{ id: 'person', name: 'Mei Langridge', role: 'member', own: true, mayRemove: false }], agents: [agent], invites: [], sample: false, pendingFailed: false };
        const state = { selected: null, collapsed: new Set(), showAllAttention: false, query: '' };
        const outer = document.querySelector('[data-roster-dialog]'), roster = document.querySelector('#roster'), detail = document.querySelector('#detail'), confirm = document.querySelector('#confirm');
        const modelValues = [];
        const callbacks = { render: () => PeopleView.renderPeopleDialog(roster, detail, model, state, callbacks), action: () => {}, saveModel: async (_id, value) => { modelValues.push(value); },
          confirm: (action, _id, opener) => PeopleView.showPeopleConfirmation(confirm, action, agent, opener, async () => {}, () => "The result is unknown. Reload to check.") };
        callbacks.render(); outer.showModal();
        const rows = [...roster.querySelectorAll('.pd-agent')];
        const rowOverflow = rows.some(row => row.scrollWidth > row.clientWidth);
        const visibleButtons = element => [...element.querySelectorAll('button')].filter(button => button.getClientRects().length && getComputedStyle(button).visibility !== 'hidden');
        const touchTargets = visibleButtons(outer).length > 0 && visibleButtons(outer).every(button => button.getBoundingClientRect().height >= 44);
        const closeIconSize = parseFloat(getComputedStyle(outer.querySelector('[data-roster-close]')).fontSize);
        const listWidth = outer.getBoundingClientRect().width;
        roster.querySelector('#pd-agent-agent').click();
        const detailWidth = outer.getBoundingClientRect().width;
        const detailTouchTargets = visibleButtons(detail).length > 0 && visibleButtons(detail).every(button => button.getBoundingClientRect().height >= 44);
        const backIconSize = parseFloat(getComputedStyle(detail.querySelector('.pd-back-icon')).fontSize);
        const accessMark = roster.querySelector('[data-agent-content-access]').getAttribute('aria-label');
        detail.querySelector('[data-edit-model]').click();
        const form = detail.querySelector('[data-model-editor]'), input = form.querySelector('input');
        input.value = '   '; form.requestSubmit(); await Promise.resolve(); await Promise.resolve();
        const opener = detail.querySelector('[data-remove-agent]'); opener.focus(); opener.click();
        const confirmRole = confirm.getAttribute('role'); const safeConfirmFocus = document.activeElement.textContent === 'Go back';
        confirm.dispatchEvent(new Event('cancel', { cancelable: true, bubbles: true }));
        const metrics = { width: innerWidth, listWidth, detailWidth, rowOverflow, touchTargets, detailTouchTargets, closeIconSize, backIconSize, hostileElements: document.querySelectorAll('img').length,
          hostileText: detail.querySelector('h2').textContent.includes(hostile), accessMark, modelValues, confirmRole, safeConfirmFocus,
          cancelRestoresOpener: document.activeElement === opener, outerStillOpen: outer.open, technicalClosed: !detail.querySelector('details').open };
        document.documentElement.dataset.metrics = btoa(unescape(encodeURIComponent(JSON.stringify(metrics))));
      })();
      </script></body></html>`, "utf8");
    const chrome = await findChrome();
    for (const width of [390, 1440]) {
      const { stdout } = await launchChrome(chrome, ["--allow-file-access-from-files", `--window-size=${width},900`, "--dump-dom", `file://${fixture}`],
        { maxBuffer: 10 * 1024 * 1024, timeout: 15_000, killSignal: "SIGKILL" });
      const encoded = stdout.match(/^\s*(?:<!doctype html>\s*)?<html\b[^>]*\bdata-metrics="([A-Za-z0-9+/]+={0,2})"/iu)?.[1];
      assert.ok(encoded, "the production builder must finish its DOM interactions");
      const geometry = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as Geometry;
      assert.equal(geometry.width, width); assert.equal(geometry.rowOverflow, false); assert.equal(geometry.touchTargets, true, `${width}px visible roster controls meet the 44px minimum`);
      assert.equal(geometry.detailTouchTargets, true, `${width}px visible detail controls meet the 44px minimum`);
      for (const size of [geometry.closeIconSize, geometry.backIconSize]) assert.ok(size >= 18 && size <= 20, `${width}px close and back glyphs are readable`);
      assert.ok(Math.abs(geometry.listWidth - (width === 390 ? 390 : 640)) <= 2);
      assert.ok(Math.abs(geometry.detailWidth - (width === 390 ? 390 : 960)) <= 2);
      assert.equal(geometry.hostileElements, 0); assert.equal(geometry.hostileText, true);
      assert.equal(geometry.accessMark, "Can use Lists & docs"); assert.deepEqual(geometry.modelValues, [null]);
      assert.equal(geometry.confirmRole, "alertdialog"); assert.equal(geometry.safeConfirmFocus, true);
      assert.equal(geometry.cancelRestoresOpener, true); assert.equal(geometry.outerStillOpen, true); assert.equal(geometry.technicalClosed, true);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Invited is rendered in the dialog at narrow and desktop widths", { timeout: 40_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "commonswarm-pending-geometry-"));
  const fixture = join(directory, "index.html");
  try {
    await writeFile(fixture, `<!doctype html><html><head><style>
      :root { --s-2: .5rem; --s-3: .75rem; --border: #ccc; }
      .dashboard [hidden] { display: none !important; }
      ${style}
    </style></head><body><div class="dashboard">
      <section class="dashboard__roster-dialog-pending" data-visible>Invited</section>
      <section class="dashboard__roster-dialog-pending" data-hidden hidden>Hidden pending</section>
    </div><script>
      const shown = document.querySelector('[data-visible]');
      const hidden = document.querySelector('[data-hidden]');
      document.documentElement.dataset.pending = btoa(JSON.stringify({
        width: innerWidth,
        display: getComputedStyle(shown).display,
        bounds: shown.getBoundingClientRect().width,
        hiddenDisplay: getComputedStyle(hidden).display,
      }));
    </script></body></html>`, "utf8");
    const chrome = await findChrome();
    for (const width of [600, 1200]) {
      const { stdout } = await launchChrome(chrome, [
        "--allow-file-access-from-files",
        `--window-size=${width},700`, "--dump-dom", `file://${fixture}`,
      ], { maxBuffer: 10 * 1024 * 1024, timeout: 15_000, killSignal: "SIGKILL" });
      const encoded = stdout.match(/data-pending="([^"]+)"/)?.[1];
      assert.ok(encoded, `Chrome returned pending geometry at ${width}px`);
      const measured = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as {
        width: number; display: string; bounds: number; hiddenDisplay: string;
      };
      assert.equal(measured.width, width);
      assert.equal(measured.display, "grid", `${width}px pending section must be visible`);
      assert.ok(measured.bounds > 0, `${width}px pending section has rendered bounds`);
      assert.equal(measured.hiddenDisplay, "none", `${width}px empty section stays hidden`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
