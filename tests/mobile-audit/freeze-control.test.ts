import assert from "node:assert/strict";
import { test } from "node:test";
import { freezeControlProblem, idleFreezeBatches, type FreezeCount } from "./freeze-control.js";

const measuresFeed = (id: string) => id.startsWith("app.chat.");
const batch = (screens: string[], intercepted: number, replayed: number, extra: Partial<FreezeCount> = {}): FreezeCount =>
  ({ pass: "mobile", viewport: "390x844", theme: "light", intercepted, fetched: Math.min(intercepted, 1), replayed, screens, polled: 0, ...extra });

test("a focused run of one screen with no message feed passes without the control", () => {
  // The false red: route.invite alone, a frozen batch per size, no receipt call to intercept in any of them.
  const counts = ["360x740", "390x844", "1024x1366"].map(viewport => batch(["route.invite"], 0, 0, { viewport }));
  assert.equal(freezeControlProblem(["route.invite"], counts, measuresFeed), null);
  assert.deepEqual(idleFreezeBatches(counts, measuresFeed), []);
});

test("a focused run of one chat screen passes when its frozen batch intercepted and replayed", () => {
  assert.equal(freezeControlProblem(["app.chat.general"], [batch(["app.chat.general"], 9, 7, { polled: 6 })], measuresFeed), null);
});

test("a chat screen whose frozen batch intercepted nothing, or replayed nothing, still fails and is named", () => {
  for (const [intercepted, replayed] of [[0, 0], [3, 0]] as const) {
    // polled 0: the declaration alone is enough, so a renamed receipt call cannot turn the control off unseen.
    const problem = freezeControlProblem(["app.chat.general"], [batch(["app.chat.general"], intercepted, replayed)], measuresFeed);
    assert.match(problem ?? "", /not exercised in mobile 390x844 light/);
  }
});

test("a screen with no declared feed witness still owes the control when normal polling repeated a receipt read", () => {
  const polledButIdle = batch(["dialog.workspace-settings"], 0, 0, { polled: 4 });
  assert.match(freezeControlProblem(["dialog.workspace-settings"], [polledButIdle], measuresFeed) ?? "", /mobile 390x844 light/);
  assert.equal(freezeControlProblem(["dialog.workspace-settings"], [batch(["dialog.workspace-settings"], 5, 4, { polled: 4 })], measuresFeed), null);
});

test("a chat screen selected but never captured frozen fails as 'any pass'", () => {
  assert.match(freezeControlProblem(["app.chat.general"], [], measuresFeed) ?? "", /not exercised in any pass/);
  // A frozen batch of other screens does not stand in for it.
  assert.match(freezeControlProblem(["app.chat.general", "route.invite"], [batch(["route.invite"], 0, 0)], measuresFeed) ?? "", /any pass/);
});

test("in a mixed run only the batches that owe the control are judged", () => {
  const counts = [batch(["route.invite"], 0, 0, { viewport: "360x740" }), batch(["route.invite", "app.chat.dm"], 5, 4, { polled: 3 })];
  assert.equal(freezeControlProblem(["route.invite", "app.chat.dm"], counts, measuresFeed), null);
  const idle = [batch(["route.invite"], 0, 0, { viewport: "360x740" }), batch(["route.invite", "app.chat.dm"], 0, 0)];
  assert.deepEqual(idleFreezeBatches(idle, measuresFeed).map(c => c.viewport), ["390x844"]);
});
