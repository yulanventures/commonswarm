/** Reached by `npm --prefix site test` through the component observer glob. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { browserTest as test } from "../../../tests/chrome.js";
import { findChrome, launchChrome } from "../../../tests/chrome.js";

const componentDir = dirname(fileURLToPath(import.meta.url));
const siteRoot = join(componentDir, "..", "..", "..");

interface Step3BSnapshot {
  joinLabel: string;
  retryLabel: string;
  retryError: string;
  retryKeptFocus: boolean;
  joinedConfirmed: number;
  directoryFocusAfterJoin: string | null;
  previewMinHeight: number;
  joinMinHeight: number;
  newDmMinHeight: number;
  overflowX: number;
}

async function runStep3BFixture(viewportWidth: number): Promise<Step3BSnapshot> {
  const directory = await mkdtemp(join(tmpdir(), "commonswarm-step3b-"));
  const fixture = join(directory, "index.html");
  const entry = join(directory, "entry.ts");
  await writeFile(
    entry,
    `export { renderChannelDirectory } from ${JSON.stringify(join(siteRoot, "src/lib/channel-directory.ts"))};
     export { renderChannelPreviewBar } from ${JSON.stringify(join(siteRoot, "src/lib/channel-preview-bar.ts"))};
     export { buildHomeRail } from ${JSON.stringify(join(siteRoot, "src/lib/home-rail.ts"))};`,
    "utf8",
  );
  const bundle = await build({
    absWorkingDir: siteRoot,
    bundle: true,
    entryPoints: [entry],
    format: "iife",
    globalName: "Step3B",
    platform: "browser",
    write: false,
  });
  const script = bundle.outputFiles[0]?.text;
  assert.ok(script, "Step 3B modules must bundle");

  const tokensCss = await readFile(join(siteRoot, "src/styles/tokens.css"), "utf8");
  const kylonTokensCss = await readFile(join(siteRoot, "src/styles/kylon-tokens.css"), "utf8");
  const railCss = await readFile(join(siteRoot, "src/styles/home/rail.css"), "utf8");
  const cmCss = await readFile(join(siteRoot, "src/styles/kylon-channel-management.css"), "utf8");

  const html = `<!doctype html><html data-theme="light"><head><meta charset="utf-8" />
    <style>*, *::before, *::after { box-sizing: border-box; }\n${tokensCss}\n${kylonTokensCss}\n${railCss}\n${cmCss}
      body { margin: 0; width: ${viewportWidth}px; }
      live-dashboard { display: block; width: ${viewportWidth}px; }
      [data-channel-directory] { position: static; display: flex; flex-direction: column; margin: 0; inline-size: 100%; max-inline-size: 100%; }
    </style></head>
    <body>
      <live-dashboard class="dashboard" data-kylon-shell>
        <div id="rail-host"></div>
        <dialog data-channel-directory open><div id="dir-host" class="cm-directory-results"></div></dialog>
        <div id="preview-host"></div>
      </live-dashboard>
      <script>${script}</script>
      <script>
        (async () => {
          try {
          const railHost = document.querySelector("#rail-host");
          const dirHost = document.querySelector("#dir-host");
          const previewHost = document.querySelector("#preview-host");

          const rail = Step3B.buildHomeRail(document, {
            sample: false,
            catchUp: { href: "/app?v=catchup", current: false, needsYou: null },
            workspaces: [],
            people: null,
            channels: {
              state: "ready",
              general: { id: "general", slug: "general", href: "/app?w=w&c=general", current: false, unread: false, manageable: false },
              channels: [{ id: "c1", slug: "design", href: "/app?w=w&c=c1", current: false, unread: true, mentionCount: 2, manageable: true }],
              archived: [],
              mayCreate: true,
            },
            directMessages: {
              rows: [
                { id: "dm1", kind: "dm", title: "Lead", href: "/app?w=w&dm=dm1", current: true, unreadCount: 0, mentionCount: 0 },
                { id: "dm2", kind: "group_dm", title: "Alex and Lead", href: "/app?w=w&dm=dm2", current: false, unreadCount: 3, mentionCount: 1, memberCount: 3 },
              ],
            },
          }, {
            openPerson() {}, openAgent() {}, selectChannel() {}, channelMenu() {}, newChannel() {},
            selectConversation() {}, conversationMenu() {}, newDirectMessage() {},
          });
          railHost.replaceChildren(rail);

          const rows = [
            { id: "c1", slug: "design", description: "UI work", href: "/app?w=w&c=c1", archived: false, unread: false, manageable: false, joined: false },
            { id: "c2", slug: "ops", description: null, href: "/app?w=w&c=c2", archived: false, unread: true, manageable: false, joined: true },
          ];
          const actions = { open() {}, unarchive() {}, join() {} };
          Step3B.renderChannelDirectory(dirHost, rows, "", new Set(), new Map(), actions);
          const joinBtn = dirHost.querySelector('[data-channel-directory-action="join:c1"]');
          const joinMinHeight = joinBtn.getBoundingClientRect().height;
          joinBtn.focus();
          Step3B.renderChannelDirectory(dirHost, [{ ...rows[0], joined: true }, rows[1]], "", new Set(), new Map(), actions);
          const directoryFocusAfterJoin = document.activeElement?.dataset?.channelDirectoryAction ?? null;

          let attempt = 0;
          let joinedConfirmed = 0;
          const preview = Step3B.renderChannelPreviewBar(previewHost, {
            slug: "design",
            onJoin: async () => {
              attempt += 1;
              return attempt === 1 ? { ok: false, message: "Network timeout." } : { ok: true };
            },
            onJoined: () => { joinedConfirmed += 1; },
          });
          const joinLabel = preview.button.textContent;
          const previewMinHeight = preview.button.getBoundingClientRect().height;
          preview.button.click();
          await new Promise((r) => setTimeout(r, 20));
          const retryLabel = preview.button.textContent;
          const retryError = preview.error.textContent;
          const retryKeptFocus = document.activeElement === preview.button;
          preview.button.click();
          await new Promise((r) => setTimeout(r, 20));

          const newDmMinHeight = railHost.querySelector("[data-home-new-dm]").getBoundingClientRect().height;
          const overflowX = document.documentElement.scrollWidth - document.documentElement.clientWidth;

          document.documentElement.dataset.fixture = encodeURIComponent(JSON.stringify({
            joinLabel,
            retryLabel,
            retryError,
            retryKeptFocus,
            joinedConfirmed,
            directoryFocusAfterJoin,
            previewMinHeight,
            joinMinHeight,
            newDmMinHeight,
            overflowX,
          }));
          } catch (err) {
            document.documentElement.dataset.fixtureError = encodeURIComponent(String(err && err.stack ? err.stack : err));
          }
        })();
      </script>
    </body></html>`;

  try {
    await writeFile(fixture, html, "utf8");
    const chrome = await findChrome();
    const { stdout } = await launchChrome(chrome, [
      "--single-process",
      "--no-zygote",
      "--allow-file-access-from-files",
      `--window-size=${viewportWidth},844`,
      "--virtual-time-budget=5000",
      "--dump-dom",
      `file://${fixture}`,
    ], { timeout: 15_000, maxBuffer: 10 * 1024 * 1024, killSignal: "SIGKILL" });
    const fixtureError = stdout.match(/data-fixture-error="([^"]+)"/)?.[1];
    assert.equal(fixtureError, undefined, fixtureError ? `Step 3B fixture threw: ${decodeURIComponent(fixtureError)}` : "");
    const encoded = stdout.match(/data-fixture="([^"]+)"/)?.[1];
    assert.ok(encoded, "headless Chrome must return the Step 3B snapshot");
    return JSON.parse(decodeURIComponent(encoded)) as Step3BSnapshot;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("Step 3B directory Join, public channel preview bar, and DM rail keep 44 px targets, focus, and zero overflow at 360 and 1024", async () => {
  for (const width of [360, 1024]) {
    const snap = await runStep3BFixture(width);
    assert.equal(snap.joinLabel, "Join #design");
    assert.equal(snap.retryLabel, "Retry");
    assert.equal(snap.retryError, "Network timeout.");
    assert.equal(snap.retryKeptFocus, true);
    assert.equal(snap.joinedConfirmed, 1);
    assert.equal(snap.directoryFocusAfterJoin, "open:c1");
    assert.ok(snap.previewMinHeight >= 44, `preview button >= 44 px at ${width}, got ${snap.previewMinHeight}`);
    assert.ok(snap.joinMinHeight >= 44, `directory Join button >= 44 px at ${width}, got ${snap.joinMinHeight}`);
    assert.ok(snap.newDmMinHeight >= 44, `New message + button >= 44 px at ${width}, got ${snap.newDmMinHeight}`);
    assert.ok(snap.overflowX <= 0, `no horizontal overflow at ${width}, got ${snap.overflowX}`);
  }
});
