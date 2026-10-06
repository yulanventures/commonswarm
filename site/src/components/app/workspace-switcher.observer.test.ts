import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/*
 * Observer for the one workspace control at the top of the authenticated rail. The site
 * test script reaches this file through its recursive component-observer glob. Static
 * assertions protect the state machine; built HTML and assets prove Astro ships the door.
 */
const componentDir = dirname(fileURLToPath(import.meta.url));
const siteRoot = join(componentDir, "..", "..", "..");
const dashboard = readFileSync(join(componentDir, "LiveDashboard.astro"), "utf8");
const appHtml = readFileSync(join(siteRoot, "dist", "app", "index.html"), "utf8");
const assetPaths = Array.from(
  appHtml.matchAll(/(?:src|href)="\/(_astro\/[^"?#]+\.(?:js|css))/g),
  (match) => match[1]!,
);
const builtAssets = assetPaths
  .map((assetPath) => readFileSync(join(siteRoot, "dist", assetPath), "utf8"))
  .join("\n");

const between = (source: string, start: string, end: string): string => {
  const startAt = source.indexOf(start);
  const endAt = source.indexOf(end, startAt + start.length);
  assert.notEqual(startAt, -1, `missing observer start anchor: ${start}`);
  assert.notEqual(endAt, -1, `missing observer end anchor: ${end}`);
  return source.slice(startAt, endAt);
};

const rail = readFileSync(join(siteRoot, "src/lib/home-rail.ts"), "utf8");
const shell = readFileSync(join(siteRoot, "src/lib/home-shell.ts"), "utf8");
const css = readFileSync(join(siteRoot, "src/styles/home/integration.css"), "utf8");

test("the built rail has one permanent workspace-list mount and keeps the account footer", () => {
  assert.equal((appHtml.match(/data-home-rail-slot/g) ?? []).length, 1);
  assert.doesNotMatch(appHtml, /data-workspace-menu-trigger/);
  assert.equal((rail.match(/list.dataset.homeWorkspaceList/g) ?? []).length, 1);
  assert.match(appHtml, /data-user-menu-root/);
  assert.match(rail, /wordmark.append\(options.wordmark\)/);
});
test("the list renders membership workspaces, marks the current one, and creates at the bottom", () => {
  assert.match(dashboard, /await myWorkspaces\(\)/);
  assert.match(dashboard, /mapHomeRail\(workspaces, homeRoute/);
  assert.match(rail, /for \(const \{ workspace, overflow, hidden \} of rows\)/);
  assert.match(rail, /row.setAttribute\("aria-current", "page"\)/);
  assert.match(rail, /workspace.name/);
  assert.ok(rail.indexOf("workspaces.append(workspacesTitle, list)") < rail.indexOf("create.dataset.homeNewWorkspace"));
  assert.match(dashboard, /route.view === "new".*openNewWorkspace\(\)/);
  assert.match(dashboard, /const made = await createWorkspace\(/);
  assert.match(dashboard, /workspaces = \[\s*madeWorkspace,\s*\.\.\.workspaces.filter/);
});
test("workspace links use native keyboard navigation; Show more exposes its state and keeps the current row visible", () => {
  assert.match(rail, /node\(doc, "a", className\)/);
  assert.match(rail, /element.href = href/);
  assert.match(rail, /event.metaKey \|\| event.ctrlKey \|\| event.shiftKey \|\| event.altKey/);
  assert.match(rail, /more.setAttribute\("aria-expanded", String\(expanded\)\)/);
  assert.match(rail, /more.setAttribute\("aria-controls", list.id\)/);
  assert.match(rail, /more.addEventListener\("click"/);
  assert.match(rail, /RAIL_WORKSPACE_CAP = 6/);
  assert.match(rail, /index !== currentIndex/);
});
test("creation reuse, Back and session reset preserve the surrounding dashboard state", () => {
  const create = between(dashboard, "const createFromIntent =", "/* THE SAMPLE ROSTER");
  for (const rule of [/input.disabled = false/, /button.disabled = false/, /button.removeAttribute\("aria-busy"\)/, /button.textContent = "Create workspace"/]) assert.match(create, rule);
  const reset = between(dashboard, "const resetWorkspaceSessionState =", "armLiveFeed =");
  assert.match(reset, /data-home-rail-slot/);
  assert.match(reset, /slot.replaceChildren\(\)/);
  assert.match(reset, /catchUpData = \[\]/);
  assert.match(reset, /workspaceName.value = ""/);
  assert.match(dashboard, /parentRoute\(homeRoute\)/);
  assert.match(dashboard, /window.history.back\(\)/);
});
test("emitted browser assets carry the list, its current marker and bounded people styling", () => {
  for (const token of ["homeWorkspaceList", "railWorkspace", "homeNewWorkspace", "aria-current", "Workspaces"]) assert.ok(builtAssets.includes(token), token);
  assert.match(builtAssets, /\.hm-rail__workspace-list/);
  assert.match(builtAssets, /\.hm-rail__people-list/);
  assert.match(builtAssets, /\.hm-rail__link\[aria-current=page\]/);
});
test("the account home link and signed-in name remain reachable on a phone", () => {
  assert.match(dashboard, /data-user-menu-root[\s\S]*?data-user-menu[\s\S]*?href="\/"/);
  assert.match(css, /\[data-user-menu-root\].*position: absolute/);
  assert.match(dashboard, /class="dashboard__user-menu-account" data-rail-account/);
});
test("workspace management moved to the more menu, whose keyboard list contains only allowed items", () => {
  assert.match(shell, /workspaceMenuItems\(vm\)/);
  assert.match(shell, /vm.menu.settings/);
  assert.match(shell, /vm.menu.adminAccess/);
  assert.match(shell, /if \(vm.sample\) return \[\]/);
  for (const key of ["ArrowDown", "ArrowUp", "Home", "End", "Escape", "Tab"]) assert.ok(shell.includes('"' + key + '"'), key);
  assert.match(shell, /close\(true\)/);
  assert.match(shell, /trigger.focus\(\{ preventScroll: true \}\)/);
  assert.match(shell, /wrap.addEventListener\("focusout"/);
});
