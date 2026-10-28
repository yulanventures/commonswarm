import assert from "node:assert/strict";
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

  // Workspace People & agents (including agent details, add-agent, invite)
  assert.deepEqual(currentFor({ view: "people", workspaceId: "ws-1" }), ["people"]);
  assert.deepEqual(currentFor({ view: "agent", workspaceId: "ws-1", agentId: "ag-1" }), ["people"]);
  assert.deepEqual(currentFor({ view: "add-agent", workspaceId: "ws-1" }), ["people"]);
  assert.deepEqual(currentFor({ view: "invite", workspaceId: "ws-1" }), ["people"]);

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
