import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { WAKE_STALE_LABEL, WAKE_STALE_MS } from "../../../../src/cloud/idle-poll.js";
import { wakePathMark } from "../../lib/wake-path.js";

test("roster wake mark uses the shared boundary and clears with no pending row", () => {
  const now = Date.parse("2026-09-25T12:00:00.000Z");
  const at = (ageMs: number) => new Date(now - ageMs).toISOString();
  assert.equal(wakePathMark(at(WAKE_STALE_MS - 1), now), null);
  assert.equal(wakePathMark(at(WAKE_STALE_MS), now),
    `Wake path stale · no session check in ${WAKE_STALE_LABEL}`);
  assert.equal(wakePathMark(null, now), null);
  // Mutation control: a one-millisecond older row crosses the boundary.
  assert.notEqual(wakePathMark(at(WAKE_STALE_MS + 1), now), null);
});

test("the live roster reads the aggregate and renders its stale mark", () => {
  const dashboard = readFileSync(new URL("./LiveDashboard.astro", import.meta.url), "utf8");
  const reachesView = (source: string) => source.includes('.from("agent_wake_path")') &&
    source.includes('oldestUnobservedAt: oldest.get(agent.principalId) ?? null') &&
    source.includes('const wakeMark = wakePathMark(agent.oldestUnobservedAt)') &&
    source.includes('if (wakeMarkKey() !== renderedWakeMarkKey) renderRoster();');
  assert.equal(reachesView(dashboard), true);
  assert.equal(reachesView(dashboard.replace('.from("agent_wake_path")', '.from("agent_principals")')), false,
    "mutation control: a roster read that skips the aggregate must fail");
  assert.ok(dashboard.includes('if (!wakeRead.error) {'),
    "a missing wake view must leave the roster visible");
});
