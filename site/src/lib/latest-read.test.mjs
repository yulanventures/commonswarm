import assert from "node:assert/strict";
import { test } from "node:test";

import { createLatestRead } from "./latest-read.ts";

/** Two overlapping reads whose replies land in the order given; returns what was painted. */
async function race(order) {
  const latest = createLatestRead();
  const painted = [];
  const deferred = () => {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
  };
  const replies = { first: deferred(), second: deferred() };
  const read = async (name) => {
    const ticket = latest.next();
    const value = await replies[name].promise;
    if (latest.isLatest(ticket)) painted.push(value);
  };
  const runs = [read("first"), read("second")];
  for (const name of order) {
    replies[name].resolve(name);
    await Promise.resolve();
  }
  await Promise.all(runs);
  return { painted, latest };
}

test("an older reply that lands last is dropped; the newest reply paints", async () => {
  const { painted } = await race(["second", "first"]);
  assert.deepEqual(painted, ["second"]);
});

test("control: replies in order paint only the newest too, never the superseded one", async () => {
  const { painted } = await race(["first", "second"]);
  assert.deepEqual(painted, ["second"]);
});

test("invalidate retires every outstanding ticket (a workspace or account change)", () => {
  const latest = createLatestRead();
  const ticket = latest.next();
  assert.equal(latest.isLatest(ticket), true);
  latest.invalidate();
  assert.equal(latest.isLatest(ticket), false);
  assert.equal(latest.isLatest(latest.next()), true);
});
