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
  const history = dashboard.match(/<details\b[^>]*\bdata-brain-history(?=[\s>])[^>]*>([\s\S]*?)<\/details>/);
  assert.ok(history, "version history remains a native disclosure");
  assert.match(
    history[1]!,
    /^\s*<summary\b[^>]*\baria-label="Version history"[^>]*>[\s\S]*?<\/summary>\s*<ul\b[^>]*\bdata-brain-history-list(?=[\s>])[^>]*>/,
    "the accessible Version history summary opens the existing version list regardless of icon or text wrapping",
  );
});
