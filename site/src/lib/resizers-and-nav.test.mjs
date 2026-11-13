import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { projectHomeLayout } from "./kylon-shell/projection.ts";
import { RESIZER_SPECS, clampResizerWidth } from "./kylon-shell/resizers.ts";

const sampleWorkspaces = [{ id: "ws-1", name: "Engineering", todosAvailable: true }];

const projectRoute = (route) =>
  projectHomeLayout("channel", route, sampleWorkspaces, false);

test("every route in the app maps to its logical place in the Slack-like navigation hierarchy", () => {
  const currentFor = (route) =>
    projectRoute(route).navigation.filter((product) => product.current).map((product) => product.id);

  // Cross-workspace inbox
  assert.deepEqual(currentFor({ view: "catchup" }), ["catchup"]);
  assert.deepEqual(currentFor({ view: "new" }), []);

  // Workspace primary Chat & channels
  assert.deepEqual(currentFor({ view: "chat", workspaceId: "ws-1" }), ["chat"]);
  assert.deepEqual(currentFor({ view: "channels", workspaceId: "ws-1" }), ["chat"]);

  // People & agents is a dialog, with no workspace tab. Related detail/setup routes do not select one.
  assert.equal(projectRoute({ view: "chat", workspaceId: "ws-1" }).navigation.some(product => product.id === "people"), false);
  assert.deepEqual(currentFor({ view: "people", workspaceId: "ws-1" }), []);
  assert.deepEqual(currentFor({ view: "agent", workspaceId: "ws-1", agentId: "ag-1" }), []);
  assert.deepEqual(currentFor({ view: "add-agent", workspaceId: "ws-1" }), []);
  assert.deepEqual(currentFor({ view: "invite", workspaceId: "ws-1" }), []);

  // Workspace To-dos (index and item detail)
  assert.deepEqual(currentFor({ view: "todos", workspaceId: "ws-1" }), ["todos"]);
  assert.deepEqual(currentFor({ view: "todo", workspaceId: "ws-1", todoId: "td-1" }), ["todos"]);

  // Workspace Lists & Skills, Files, Wiki
  assert.deepEqual(currentFor({ view: "lists", workspaceId: "ws-1" }), ["lists"]);
  assert.deepEqual(currentFor({ view: "files", workspaceId: "ws-1" }), ["files"]);
  assert.deepEqual(currentFor({ view: "wiki", workspaceId: "ws-1" }), ["wiki"]);

  // Workspace administration and account-level settings never falsely highlight a workspace section tab
  assert.deepEqual(currentFor({ view: "settings", workspaceId: "ws-1" }), []);
  assert.deepEqual(currentFor({ view: "admin-access", workspaceId: "ws-1" }), []);
  assert.deepEqual(currentFor({ view: "account-agents" }), []);
  assert.deepEqual(currentFor({ view: "connected-apps" }), []);
  assert.deepEqual(currentFor({ view: "organizations" }), []);
});

test("all five vertical pane dividers have bounded specs and clamp widths cleanly", () => {
  assert.deepEqual(
    RESIZER_SPECS.map((spec) => [spec.id, spec.prop, spec.direction]),
    [
      ["rail", "--cs-rail-width", "start"],
      ["side", "--cs-side-width", "end"],
      ["wiki", "--cs-wiki-index-width", "start"],
      ["people", "--cs-people-list-width", "start"],
      ["lists", "--cs-lists-nav-width", "start"],
    ],
  );
  for (const spec of RESIZER_SPECS) {
    assert.ok(spec.minPx > 0 && spec.minPx < spec.defaultPx && spec.defaultPx < spec.maxPx, `${spec.id} bounds`);
    assert.equal(clampResizerWidth(spec.minPx - 50, spec.minPx, spec.maxPx), spec.minPx);
    assert.equal(clampResizerWidth(spec.maxPx + 50, spec.minPx, spec.maxPx), spec.maxPx);
    assert.equal(clampResizerWidth(spec.defaultPx + 0.4, spec.minPx, spec.maxPx), spec.defaultPx);
  }
});

test("Slack-like sidebar density, flat DM list, compact header tabs, and bordered composer box keep 44px touch targets", async () => {
  const railCss = await readFile(new URL("../styles/kylon-rail.css", import.meta.url), "utf8");
  const integrationCss = await readFile(new URL("../styles/kylon-layout/integration.css", import.meta.url), "utf8");
  const composerCss = await readFile(new URL("../styles/kylon-composer.css", import.meta.url), "utf8");
  const carbonCss = await readFile(new URL("../styles/carbon-theme.css", import.meta.url), "utf8");

  // Step 6: Presence dot only visually (keep "Idle"/"Working" status and "you" SR-accessible so state isn't color-only), flat DM list, bold unread, 30px desktop rows.
  assert.match(railCss, /\.cs-org-shell\s+\.hm-rail\s+:is\(\.hm-rail__status,\s*\.hm-rail__you\)\s*\{[\s\S]*?clip-path:\s*inset\(50%\);/u);
  assert.doesNotMatch(railCss, /:is\(\.hm-rail__status[^)]*\)\s*\{\s*display:\s*none;/u);
  assert.match(railCss, /\.cs-org-shell\s+\.hm-rail\s+\.hm-rail__agent\s*\{\s*margin-block:\s*0;\s*padding-inline:\s*10px;/u);
  assert.match(railCss, /@media\s*\(width\s*>\s*64rem\)[\s\S]*?min-block-size:\s*30px;\s*block-size:\s*30px;/u);
  assert.match(integrationCss, /\.cs-org-shell\s+\.hm-rail__agent\s*\{\s*margin-block:\s*0;\s*padding-inline:\s*10px;\s*\}/u);

  // Step 7: Compact header line, underline tabs on --carbon-line, and bordered 10px composer with compact To: footer.
  assert.match(integrationCss, /\.hm-ws-header__copy\s*\{\s*display:\s*flex;\s*flex-wrap:\s*wrap;\s*align-items:\s*center;/u);
  assert.match(integrationCss, /border-block-end:\s*1px\s+solid\s+var\(--carbon-line,\s*var\(--cs-line\)\);/u);
  assert.match(carbonCss, /\.dashboard__composer-input\s*\{\s*min-block-size:\s*48px;\s*padding:\s*4px;\s*border-radius:\s*10px;\s*\}/u);
  assert.match(carbonCss, /box-shadow:\s*inset\s+0\s+0\s+0\s+1px\s+var\(--carbon-line\);/u);
  assert.match(composerCss, /\.dashboard__composer-to-note\s*\{[\s\S]*?clip-path:\s*inset\(50%\);/u);
});
