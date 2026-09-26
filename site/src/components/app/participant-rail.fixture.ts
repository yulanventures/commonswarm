import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { findChrome, launchChrome } from "../../../tests/chrome.js";
import type { RailMember, RosterAgentRow } from "../../lib/participant-rail.js";

const componentDir = dirname(fileURLToPath(import.meta.url));
const siteRoot = join(componentDir, "..", "..", "..");

export interface ParticipantRailSnapshot {
  directAgentCount: number;
  groups: Array<{
    agents: string[];
    hasNestedList: boolean;
    heading: string;
  }>;
  innerHtml: string;
}

/** Bundles and runs the live rail renderer in a browser document. */
export const renderParticipantRailFixture = async (
  members: RailMember[],
  rows: RosterAgentRow[],
): Promise<ParticipantRailSnapshot> => {
  const directory = await mkdtemp(join(tmpdir(), "commonswarm-participant-rail-"));
  const fixture = join(directory, "index.html");
  const bundle = await build({
    absWorkingDir: siteRoot,
    bundle: true,
    entryPoints: ["src/lib/participant-rail.ts"],
    format: "iife",
    globalName: "ParticipantRail",
    platform: "browser",
    write: false,
  });
  const script = bundle.outputFiles[0]?.text;
  assert.ok(script, "the live participant renderer must bundle for its browser fixture");
  const html = `<!doctype html>
<html>
  <body>
    <ul class="dashboard__sidebar-agent-list" data-sidebar-participant-list></ul>
    <script>${script}</script>
    <script>
      const members = ${JSON.stringify(members)};
      const rows = ${JSON.stringify(rows)};
      const list = document.querySelector("[data-sidebar-participant-list]");
      const initials = (name) => name.trim().split(/\\s+/).filter(Boolean).slice(0, 2)
        .map((part) => part[0]).join("").toUpperCase();
      ParticipantRail.renderSidebarParticipants(
        list,
        members,
        ParticipantRail.rosterAgentsFromRows(rows),
        initials,
      );
      const snapshot = {
        directAgentCount: list.querySelectorAll(":scope > .dashboard__sidebar-agent").length,
        groups: Array.from(list.children).map((group) => ({
          agents: Array.from(group.querySelectorAll(".dashboard__sidebar-agent strong"))
            .map((row) => row.textContent),
          hasNestedList: Boolean(group.querySelector(":scope > .dashboard__sidebar-owner-agents")),
          heading: group.querySelector(":scope > .dashboard__sidebar-person strong")?.textContent ?? "",
        })),
        innerHtml: list.innerHTML,
      };
      document.documentElement.dataset.fixture = btoa(JSON.stringify(snapshot));
    </script>
  </body>
</html>`;

  try {
    await writeFile(fixture, html, "utf8");
    const chrome = await findChrome();
    const { stdout } = await launchChrome(chrome, [
      "--single-process",
      "--no-zygote",
      "--allow-file-access-from-files",
      "--dump-dom",
      `file://${fixture}`,
    ], {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 15_000,
      killSignal: "SIGKILL",
    });
    const encoded = stdout.match(/data-fixture="([^"]+)"/)?.[1];
    assert.ok(encoded, "headless Chrome must return the live participant rail snapshot");
    return JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as ParticipantRailSnapshot;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};
