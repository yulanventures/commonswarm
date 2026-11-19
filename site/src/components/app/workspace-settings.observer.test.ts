/** Reached by `npm --prefix site test` through the component observer glob. */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { browserTest as test } from "../../../tests/chrome.js";
import { build } from "esbuild";
import { findChrome, launchChrome } from "../../../tests/chrome.js";

const componentDir = dirname(fileURLToPath(import.meta.url));
const siteRoot = join(componentDir, "..", "..", "..");

interface SettingsSnapshot {
  initialDisabled: boolean;
  partialDisabled: boolean;
  exactDisabled: boolean;
  closeCalls: number;
  moreStartedOpen: boolean;
  moreAfterSameWorkspaceRedraw: boolean;
  moreAfterReset: boolean;
  moreAfterSwitch: boolean;
  partialValueAfterOrgArrival: string;
  partialDisabledAfterOrgArrival: boolean;
  closeFocusedAfterOrgArrival: boolean;
  closeSelectionAfterOrgArrival: [number | null, number | null];
  valueAfterNameChange: string;
  valueAfterPermissionLoss: string;
  renameValueAfterOrgArrival: string;
  renameFocusedAfterOrgArrival: boolean;
  renameSelectionAfterOrgArrival: [number | null, number | null];
}

async function renderSettingsFixture(): Promise<SettingsSnapshot> {
  const directory = await mkdtemp(join(tmpdir(), "commonswarm-workspace-settings-"));
  const fixture = join(directory, "index.html");
  const bundle = await build({
    absWorkingDir: siteRoot,
    bundle: true,
    entryPoints: ["src/lib/workspace-settings.ts"],
    format: "iife",
    globalName: "WorkspaceSettings",
    platform: "browser",
    write: false,
  });
  const script = bundle.outputFiles[0]?.text;
  assert.ok(script, "the live workspace-settings renderer must bundle");
  const html = `<!doctype html><html><body><div id="host"></div>
    <script>${script}</script>
    <script>
      let closeCalls = 0;
      const root = document.querySelector("#host");
      const base = {
        name: "Science Swarm",
        workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        memberCount: 3,
        agentCount: 2,
        canClose: true,
        canRename: true,
        onRename: async () => {},
        onCopy: async () => {},
        onClose: async () => { closeCalls += 1; },
      };
      const controls = WorkspaceSettings.renderWorkspaceSettings(root, base);
      const more = () => root.querySelector("[data-workspace-more]");
      const moreStartedOpen = more().open;
      const initialDisabled = controls.closeButton.disabled;
      controls.confirmInput.value = "Science";
      controls.confirmInput.dispatchEvent(new Event("input"));
      const partialDisabled = controls.closeButton.disabled;
      controls.confirmInput.value = "Science Swarm";
      controls.confirmInput.dispatchEvent(new Event("input"));
      const exactDisabled = controls.closeButton.disabled;
      root.querySelector("form").requestSubmit();
      setTimeout(() => {
        WorkspaceSettings.renderWorkspaceSettings(root, { ...base, moreOpen: false });
        more().querySelector("summary").click();
        const closeInput = root.querySelector("[data-workspace-close-confirm]");
        closeInput.focus();
        closeInput.value = "Science";
        closeInput.setSelectionRange(3, 7);
        closeInput.dispatchEvent(new Event("input"));
        const afterOrg = WorkspaceSettings.renderWorkspaceSettings(root, {
          ...base,
          moveDestinations: [{ id: "org-2", name: "Yulan" }],
          onMove: async () => {},
        });
        const moreAfterSameWorkspaceRedraw = more().open;
        const partialValueAfterOrgArrival = afterOrg.confirmInput.value;
        const partialDisabledAfterOrgArrival = afterOrg.closeButton.disabled;
        const closeFocusedAfterOrgArrival = document.activeElement === afterOrg.confirmInput;
        const closeSelectionAfterOrgArrival = [afterOrg.confirmInput.selectionStart, afterOrg.confirmInput.selectionEnd];

        const afterNameChange = WorkspaceSettings.renderWorkspaceSettings(root, { ...base, name: "Science Lab" });
        const valueAfterNameChange = afterNameChange.confirmInput.value;

        afterNameChange.confirmInput.focus();
        afterNameChange.confirmInput.value = "Science Lab";
        const afterPermLoss = WorkspaceSettings.renderWorkspaceSettings(root, { ...base, name: "Science Lab", canClose: false });
        const valueAfterPermissionLoss = afterPermLoss.confirmInput.value;

        WorkspaceSettings.renderWorkspaceSettings(root, { ...base, moreOpen: false });
        const moreAfterReset = more().open;
        root.querySelector("[data-workspace-rename]").click();
        const renameInput = root.querySelector("[data-workspace-rename-input]");
        renameInput.value = "Science L";
        renameInput.setSelectionRange(9, 9);
        renameInput.dispatchEvent(new Event("input"));
        WorkspaceSettings.renderWorkspaceSettings(root, {
          ...base,
          moveDestinations: [{ id: "org-2", name: "Yulan" }],
          onMove: async () => {},
        });
        const renameAfterOrg = root.querySelector("[data-workspace-rename-input]");
        const renameValueAfterOrgArrival = renameAfterOrg ? renameAfterOrg.value : "";
        const renameFocusedAfterOrgArrival = document.activeElement === renameAfterOrg;
        const renameSelectionAfterOrgArrival = renameAfterOrg
          ? [renameAfterOrg.selectionStart, renameAfterOrg.selectionEnd]
          : [null, null];

        more().querySelector("summary").click();
        WorkspaceSettings.renderWorkspaceSettings(root, {
          ...base,
          workspaceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          name: "Ops Swarm",
        });
        const moreAfterSwitch = more().open;
        const snapshot = {
          initialDisabled,
          partialDisabled,
          exactDisabled,
          closeCalls,
          moreStartedOpen,
          moreAfterSameWorkspaceRedraw,
          moreAfterReset,
          moreAfterSwitch,
          partialValueAfterOrgArrival,
          partialDisabledAfterOrgArrival,
          closeFocusedAfterOrgArrival,
          closeSelectionAfterOrgArrival,
          valueAfterNameChange,
          valueAfterPermissionLoss,
          renameValueAfterOrgArrival,
          renameFocusedAfterOrgArrival,
          renameSelectionAfterOrgArrival,
        };
        document.documentElement.dataset.fixture = encodeURIComponent(JSON.stringify(snapshot));
      }, 0);
    </script></body></html>`;
  try {
    await writeFile(fixture, html, "utf8");
    const chrome = await findChrome();
    const { stdout } = await launchChrome(chrome, [
      "--single-process",
      "--no-zygote",
      "--allow-file-access-from-files",
      "--dump-dom",
      `file://${fixture}`,
    ], { timeout: 15_000, maxBuffer: 10 * 1024 * 1024, killSignal: "SIGKILL" });
    const encoded = stdout.match(/data-fixture="([^"]+)"/)?.[1];
    assert.ok(encoded, "headless Chrome must return the settings snapshot");
    return JSON.parse(decodeURIComponent(encoded)) as SettingsSnapshot;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("the real settings renderer gates close on the exact workspace name and preserves More, partial entry, and focus across same-workspace redraws", async () => {
  const snapshot = await renderSettingsFixture();
  assert.equal(snapshot.initialDisabled, true);
  assert.equal(snapshot.partialDisabled, true);
  assert.equal(snapshot.exactDisabled, false);
  assert.equal(snapshot.closeCalls, 1);
  assert.equal(snapshot.moreStartedOpen, false);
  assert.equal(snapshot.moreAfterSameWorkspaceRedraw, true);
  assert.equal(snapshot.moreAfterReset, false);
  assert.equal(snapshot.moreAfterSwitch, false);
  assert.equal(snapshot.partialValueAfterOrgArrival, "Science");
  assert.equal(snapshot.partialDisabledAfterOrgArrival, true);
  assert.equal(snapshot.closeFocusedAfterOrgArrival, true);
  assert.deepEqual(snapshot.closeSelectionAfterOrgArrival, [3, 7]);
  assert.equal(snapshot.valueAfterNameChange, "");
  assert.equal(snapshot.valueAfterPermissionLoss, "");
  assert.equal(snapshot.renameValueAfterOrgArrival, "Science L");
  assert.equal(snapshot.renameFocusedAfterOrgArrival, true);
  assert.deepEqual(snapshot.renameSelectionAfterOrgArrival, [9, 9]);
});
