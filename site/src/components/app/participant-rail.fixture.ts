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
  viewerId: string | null = null,
): Promise<ParticipantRailSnapshot> => {
  const directory = await mkdtemp(join(tmpdir(), "commonswarm-participant-rail-"));
  const fixture = join(directory, "index.html");
  const bundle = await build({
    absWorkingDir: siteRoot,
    bundle: true,
    stdin: { contents: 'export { mapHomePeople } from "./src/lib/home-map.ts"; export { buildHomeRail } from "./src/lib/home-rail.ts"; export { rosterAgentsFromRows } from "./src/lib/participant-rail.ts";', resolveDir: siteRoot },
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
    <!-- The production builder owns the complete rail. -->
    <script>${script}</script>
    <script>
      const members = ${JSON.stringify(members)};
      const rows = ${JSON.stringify(rows)};
      const people = ParticipantRail.mapHomePeople({ members, agents: ParticipantRail.rosterAgentsFromRows(rows),
        viewerId: ${JSON.stringify(viewerId)}, access: [], signals: [], now: 1791201600000, sample: false });
      const rail = ParticipantRail.buildHomeRail(document, { sample: false, people, workspaces: [],
        catchUp: { href: '/app?v=catchup', current: false, needsYou: null } }, { openPerson: () => {}, openAgent: () => {} });
      document.body.prepend(rail);
      const list = rail.querySelector('[data-sidebar-participant-list]');
      const snapshot = {
        directAgentCount: list.querySelectorAll(":scope > .hm-rail__agent-item").length,
        groups: Array.from(list.children).map((group) => ({
          agents: Array.from(group.querySelectorAll(".hm-rail__agent .hm-rail__name"))
            .map((row) => row.textContent),
          hasNestedList: Boolean(group.querySelector(":scope > .hm-rail__agents")),
          heading: group.querySelector(":scope > .hm-rail__person .hm-rail__name, :scope > .hm-rail__other-head")?.textContent ?? "",
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
