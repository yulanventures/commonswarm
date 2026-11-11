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

// The receipt-loaded marker relies on owes(): a row's seen report is owed from the moment it is queued until the server
// acknowledges it, and again after a failed send, so the hover audit never takes rest while a report can still change it.
test("a row's seen report is owed while queued and in flight, not after the acknowledgement; a failure owes it again", async () => {
  let changes = 0;
  let fail = true;
  let release: () => void = () => {};
  const timers: Array<() => void> = [];
  const reporter = new HumanSeenReporter({
    hasFocus: () => true,
    send: () => new Promise<void>((done, reject) => { release = fail ? () => reject(new Error("offline")) : done; }),
    schedule: (callback) => { timers.push(callback); return 0 as unknown as ReturnType<typeof setTimeout>; },
    cancel: () => {},
    changed: () => { changes += 1; },
  });
  assert.equal(reporter.owes("u:w", "s1"), false);
  reporter.intersections([{ scope: "u:w", signalId: "s1", isIntersecting: true }]);
  assert.equal(reporter.owes("u:w", "s1"), true, "queued");
  const first = reporter.flush();
  assert.equal(reporter.owes("u:w", "s1"), true, "in flight");
  release();
  await first;
  assert.equal(reporter.owes("u:w", "s1"), true, "a failed send is owed again");
  fail = false;
  const second = reporter.flush();
  release();
  await second;
  assert.equal(reporter.owes("u:w", "s1"), false, "acknowledged");
  reporter.intersections([{ scope: "u:w", signalId: "s1", isIntersecting: true }]);
  assert.equal(reporter.owes("u:w", "s1"), false, "a reported row is never owed again");
  assert.ok(changes >= 3, `changed() fired on queue and on each settled send (${changes})`);
});
