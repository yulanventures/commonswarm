import assert from "node:assert/strict";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import { PendingRefreshGate } from "../../lib/pending-refresh";
import { mapHomePeople } from "../../lib/home-map";
import { focusFixture, assertPollCompleted } from "./home-focus.fixture.js";

test("focus observer fixture ages production status detail and completes both poll renders", async () => {
  const { setup, production } = await focusFixture();
  // Only the DOM paint boundaries are replaced here; the browser uses the real builders.
  const context = createContext({ PendingRefreshGate, mapHomePeople });
  const script = `${setup}
    const renderHomeRail = () => {}, renderHomeShell = () => {};
    ${production(["homeViewerId", "currentHomePeople", "wakeMarkKey", "renderRoster", "hasPendingAccess", "refreshPendingAccess"])}
    renderRoster(); poll;
  `;
  const poll = runInContext(ts.transpileModule(script, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  assert.equal(runInContext("rosterRenders", context), 1, "fixture boot reached the end of renderRoster");
  const detail = () => runInContext("currentHomePeople().groups[0].agents[0].state.detail", context);
  assert.equal(detail(), "Active 13 minutes ago", "fixture starts outside the Active now window");
  for (const [expectedReads, expectedDetail] of [[1, "Active 13 minutes ago"], [2, "Active 14 minutes ago"]] as const) {
    assertPollCompleted(await poll(), expectedReads);
    assert.equal(detail(), expectedDetail, "production mapping crosses a minute boundary during the poll sequence");
  }
  runInContext("syncComposerAddress = () => { throw new Error('fixture render failed'); }", context);
  const interrupted = await poll();
  assert.equal(interrupted.reads, 3, "a failed render still reached the read");
  assert.equal(interrupted.rendered, 3, "a swallowed render failure did not complete another paint");
  assert.throws(() => assertPollCompleted(interrupted, 3), assert.AssertionError, "read success cannot conceal an incomplete render");
});
