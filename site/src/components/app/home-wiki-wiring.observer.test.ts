import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("Wiki is reachable from the workspace menu and right column using the existing file read and put paths", () => {
  const dashboard = readFileSync(new URL("./LiveDashboard.astro", import.meta.url), "utf8");
  const shell = readFileSync(new URL("../../lib/home-shell.ts", import.meta.url), "utf8");
  const sideCards = readFileSync(new URL("../../lib/home-side-cards.ts", import.meta.url), "utf8");
  assert.match(shell, /item: "wiki" as const, label: "Wiki"/);
  assert.match(shell, /if \(item === "wiki"\) button\.dataset\.workspaceView = "brain"/);
  assert.match(dashboard, /if \(item === "wiki"\) navigateHomeHref\(vm\.hrefs\.wiki\)/);
  assert.match(sideCards, /link\(doc, "Wiki", vm\.hrefs\.wiki, "wiki", vm\.sample\)/);
  assert.equal([...dashboard.matchAll(/wiki: routeHref\(\{ view: "wiki", workspaceId: workspace\.id \}\)/g)].length, 2,
    "the workspace menu and right column both link to this workspace's Wiki");
  assert.match(dashboard, /homeRoute\.view === "wiki"\) activateWorkspaceView\("brain"\)/);
  assert.match(dashboard, /data-channel-view="brain"/);
  assert.match(dashboard, /brainTopics\(files, workspaceFileUploaderName\)/);
  assert.match(dashboard, /data-brain-raw-toggle/);
  assert.match(
    dashboard,
    /new File\(\[markdown\], topic\.name[\s\S]*uploadBrowserAttachment/,
    "browser edits must use the current file create → PUT → commit flow",
  );
  assert.match(dashboard, /<summary>Version history<\/summary>/);
});
