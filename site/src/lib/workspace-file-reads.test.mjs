import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFileListRetry, readWikiContent } from './workspace-file-reads.ts';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test('a failed Files retry remains retryable, then returns the new list', async () => {
  const session = {}; let attempts = 0;
  const retry = createFileListRetry(() => ({ workspaceId: 'one', session, generation: 1 }), async () => {
    if (++attempts === 1) throw new Error('unavailable');
    return ['fresh'];
  });
  const first = await retry.run();
  assert.equal(first.kind, 'failure'); assert.equal(first.error.message, 'unavailable');
  assert.equal(retry.isPending(), false);
  assert.deepEqual(await retry.run(), { kind: 'success', value: ['fresh'] });
});

test('duplicate retries are suppressed and old workspace or session results cannot land', async () => {
  const first = deferred(), second = deferred(); const session = {}; let current = { workspaceId: 'one', session, generation: 1 };
  const calls = [];
  const retry = createFileListRetry(() => current, (id) => { calls.push(id); return calls.length === 1 ? first.promise : second.promise; });
  const old = retry.run(); assert.equal(retry.isPending(), true);
  assert.deepEqual(await retry.run(), { kind: 'busy' }); assert.deepEqual(calls, ['one']);
  current = { workspaceId: 'two', session, generation: 2 };
  const newer = retry.run(); first.resolve(['old']); assert.deepEqual(await old, { kind: 'stale' });
  assert.equal(retry.isPending(), true);
  current = { ...current, session: {} }; second.resolve(['private']);
  assert.deepEqual(await newer, { kind: 'stale' }); assert.equal(retry.isPending(), false);
});

test('a deadline during the grant ignores its late result and never fetches', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const grant = deferred(); let fetches = 0; const original = globalThis.fetch;
  globalThis.fetch = async () => { fetches++; throw new Error('unexpected'); }; t.after(() => { globalThis.fetch = original; });
  const result = readWikiContent(() => grant.promise, () => true);
  const rejection = assert.rejects(result, /took too long/);
  t.mock.timers.tick(15_000); await rejection;
  grant.resolve({ url: 'https://example.invalid/private' }); await Promise.resolve(); await Promise.resolve();
  assert.equal(fetches, 0);
});

test('a body deadline aborts the fetch and ignores late body completion', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const body = deferred(); let signal; const original = globalThis.fetch;
  globalThis.fetch = async (_url, options) => { signal = options.signal; return { ok: true, text: () => body.promise }; };
  t.after(() => { globalThis.fetch = original; });
  const result = readWikiContent(async () => ({ url: 'https://example.invalid/private' }), () => true);
  await Promise.resolve(); await Promise.resolve();
  const rejection = assert.rejects(result, /took too long/);
  t.mock.timers.tick(15_000); await rejection; assert.equal(signal.aborted, true);
  body.resolve('late'); await Promise.resolve();
});

test('a stale grant never starts a fetch and a successful read clears its timer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0; const original = globalThis.fetch;
  globalThis.fetch = async () => { calls++; return { ok: true, text: async () => 'current version' }; };
  t.after(() => { globalThis.fetch = original; });
  await assert.rejects(readWikiContent(async () => ({ url: 'https://example.invalid/private' }), () => false), /no longer selected/);
  assert.equal(calls, 0);
  assert.equal(await readWikiContent(async () => ({ url: 'https://example.invalid/private' }), () => true), 'current version');
  t.mock.timers.tick(15_000); assert.equal(calls, 1);
});


test('a body returned after an account or workspace change is discarded', async (t) => {
  const body = deferred(); let current = true; const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, text: () => body.promise });
  t.after(() => { globalThis.fetch = original; });
  const result = readWikiContent(async () => ({ url: 'https://example.invalid/private' }), () => current);
  await Promise.resolve(); await Promise.resolve(); current = false; body.resolve('old workspace content');
  await assert.rejects(result, /no longer selected/);
});
