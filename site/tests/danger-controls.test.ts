import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// DANGER_SRC_DIR points at a directory holding copies of the two .astro files; it exists so the
// test can be run against the base revision to prove it fails there.
const dir = process.env.DANGER_SRC_DIR ?? new URL("../src/components/app/", import.meta.url).pathname;
const dashboard = readFileSync(`${dir}/LiveDashboard.astro`, "utf8");
const delegations = readFileSync(`${dir}/AdminDelegations.astro`, "utf8");

const classNameOf = (source: string, label: string): string => {
  const at = source.indexOf(`.textContent = "${label}"`);
  assert.notEqual(at, -1, `${label} button is rendered`);
  const before = source.slice(Math.max(0, at - 300), at);
  const matches = [...before.matchAll(/\.className = "([^"]*)"/gu)];
  assert.ok(matches.length > 0, `${label} button has a className`);
  return matches[matches.length - 1]![1]!;
};

test("Revoke seat uses the danger text-button modifier", () => {
  const classes = classNameOf(dashboard, "Revoke seat").split(/\s+/u);
  assert.ok(classes.includes("dashboard__text-button"));
  assert.ok(classes.includes("dashboard__text-button--danger"));
});

test("Revoke connection uses the danger button and not secondary", () => {
  const classes = classNameOf(dashboard, "Revoke connection").split(/\s+/u);
  assert.ok(classes.includes("dashboard__button"));
  assert.ok(classes.includes("dashboard__button--danger"));
  assert.ok(!classes.includes("dashboard__button--secondary"));
});

test("dashboard danger rules use the danger tokens", () => {
  const rule = (selector: string): string => {
    const match = new RegExp(`(?:^|[}/])\\s*${selector.replace(/[.()]/gu, "\\$&")}\\s*\\{([^}]*)\\}`, "u").exec(dashboard);
    assert.ok(match, `${selector} rule exists`);
    return match[1]!;
  };
  assert.match(rule(".dashboard__button--danger"), /color:\s*var\(--danger\)/u);
  assert.match(rule(".dashboard__button--danger:hover:not(:disabled)"), /background:\s*var\(--danger\)/u);
  assert.match(rule(".dashboard__text-button--danger:hover:not(:disabled)"), /text-decoration-thickness:\s*2px/u);
  assert.match(dashboard, /\.dashboard__text-button--danger,\s*\.dashboard__text-button--danger:hover:not\(:disabled\)\s*\{\s*color:\s*var\(--danger\)/u);
});

test("AdminDelegations tones Revoke grant and only the withdraw action as danger", () => {
  assert.match(delegations, /textContent = "Revoke grant";\s*button\.dataset\.tone = "danger"/u);
  assert.match(delegations, /if \(action !== "approve"\) button\.dataset\.tone = "danger";/u);
  assert.equal((delegations.match(/dataset\.tone = "danger"/gu) ?? []).length, 2);
  assert.match(delegations, /admin-delegations :global\(button\[data-tone=danger\]\) \{[^}]*color: var\(--danger\)/u);
  assert.match(delegations, /button\[data-tone=danger\]:hover:not\(:disabled\)\) \{[^}]*background: var\(--danger\)/u);
});

test("renderHomeObjectPane shows a message instead of a blank pane when the workspace is missing", () => {
  assert.match(
    dashboard,
    /const workspace = workspaces\.find\(row => row\.id === activeWorkspaceId\);\s*if \(!workspace\) \{ homePaneMessage\("Could not open this workspace\.", "Reload to try again\."\); return; \}/u,
  );
});
