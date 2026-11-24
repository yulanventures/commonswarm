/** Reached by `npm --prefix site test` through the src/lib/*.test.mjs glob. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { awaitSignal, createSignal } from "./await-signal.ts";

test("awaitSignal returns true for an already-resolved signal (even with 0ms deadline)", async () => {
  const signal = createSignal();
  assert.equal(signal.resolved, false);
  signal.resolve();
  assert.equal(signal.resolved, true);

  assert.equal(await awaitSignal(signal.promise, 0), true);
  assert.equal(await awaitSignal(signal.promise, 50), true);
});

test("awaitSignal returns true when a signal resolves before the deadline", async () => {
  const signal = createSignal();
  const timer = setTimeout(() => signal.resolve(), 15);
  try {
    assert.equal(await awaitSignal(signal.promise, 250), true);
    assert.equal(signal.resolved, true);
  } finally {
    clearTimeout(timer);
  }
});

test("awaitSignal returns false at the deadline when a signal remains unresolved", async () => {
  const signal = createSignal();
  const start = Date.now();
  const settled = await awaitSignal(signal.promise, 35);
  const elapsed = Date.now() - start;

  assert.equal(settled, false);
  assert.equal(signal.resolved, false);
  assert.ok(elapsed >= 25, `expected awaitSignal to wait near deadline, waited ${elapsed}ms`);
});

test("awaitSignal supports waiting on multiple signals together", async () => {
  const first = createSignal();
  const second = createSignal();
  first.resolve();

  // One resolved + one pending must return false at the deadline.
  assert.equal(await awaitSignal([first.promise, second.promise], 25), false);

  // Resolving the second makes the combined signal return true.
  const timer = setTimeout(() => second.resolve(), 10);
  try {
    assert.equal(await awaitSignal([first.promise, second.promise], 250), true);
  } finally {
    clearTimeout(timer);
  }
});
