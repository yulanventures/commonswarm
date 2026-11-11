import assert from "node:assert/strict";
import test from "node:test";
import { HumanSeenReporter } from "../src/lib/human-seen-reporter.ts";

// A row that scrolls into view while an earlier batch is still being sent must still be reported: its timer fires
// during the send, and once the send ends a new timer must be scheduled for it.
test("a row queued while a send is in flight is sent after that send, not left queued", async () => {
  const sent: string[][] = [];
  const releases: Array<() => void> = [];
  const timers: Array<() => void> = [];
  const reporter = new HumanSeenReporter({
    hasFocus: () => true,
    send: (_scope, ids) => { sent.push([...ids]); return new Promise<void>(done => { releases.push(done); }); },
    schedule: (callback) => { timers.push(callback); return timers.length as unknown as ReturnType<typeof setTimeout>; },
    cancel: () => {},
  });
  reporter.intersections([{ scope: "u:w", signalId: "a", isIntersecting: true }]);
  timers.shift()!();
  assert.deepEqual(sent, [["a"]], "first batch in flight");
  reporter.intersections([{ scope: "u:w", signalId: "b", isIntersecting: true }]);
  const during = timers.shift();
  assert.ok(during, "the row queued during the send gets a timer");
  during!();
  assert.deepEqual(sent, [["a"]], "it waits for the send in flight");
  releases.shift()!();
  await new Promise(done => setImmediate(done));
  const after = timers.shift();
  assert.ok(after, "once the send ends, the waiting row is scheduled again");
  after!();
  assert.deepEqual(sent, [["a"], ["b"]]);
  releases.shift()!();
});
