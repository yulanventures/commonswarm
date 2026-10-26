/**
 * D-034 — signal status could wait forever because its fetches had no deadline.
 *
 * Pure: no Supabase, no network, no database. The fake fetch never settles on its own,
 * which distinguishes an application deadline from a fast provider failure.
 *
 * ★ THIS FILE IS NAMED IN `npm test`, AND THAT IS LOAD-BEARING.
 *
 * `test:p1-cli` also covers signal behavior, but that suite owns a shared database stack.
 * This deadline observer must stay runnable by every contributor without coordination.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { CloudTarget } from "../../src/cloud/config.js";
import {
  CommandHttpError,
  CommandTransportError,
  ThinCommandClient,
  type PostSignalRequest,
} from "../../src/cloud/command-client.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const TARGET: CloudTarget = {
  url: "https://example.supabase.co",
  anonKey: "test-anon-key",
  profileId: "test-profile",
};

/**
 * Real-time bound for promises that must settle without the mocked 30-second
 * deadline. If a settlement arm is deleted, the pending promise never settles
 * and the test fails after one real second instead of hanging the whole suite.
 * Captured before mock timers replace globalThis.setTimeout/clearTimeout.
 */
const REAL_SET_TIMEOUT = globalThis.setTimeout;
const REAL_CLEAR_TIMEOUT = globalThis.clearTimeout;

async function boundedRealWait<T>(
  pending: Promise<T>,
  label: string,
): Promise<T | string> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<string>((resolve) => {
    handle = REAL_SET_TIMEOUT(() => resolve(`still pending after ${label}`), 1_000);
  });
  return Promise.race([pending, bound]).finally(() => {
    if (handle !== undefined) REAL_CLEAR_TIMEOUT(handle);
  });
}

function signalPostRequest(signal?: AbortSignal): PostSignalRequest {
  return {
    workspaceId: WORKSPACE_ID,
    credential: "test-agent-credential",
    command: {
      kind: "post_signal",
      signal_kind: "note",
      body: "runtime reply",
      to_user_id: null,
      to_agent_principal_id: null,
      in_reply_to: "33333333-3333-4333-8333-333333333333",
      about: null,
    },
    ...(signal === undefined ? {} : { signal }),
  };
}

/** Headers arrive immediately; the body never settles and ignores abort. */

/** Fetch never settles, but rejects with AbortError when its signal aborts. */

/** Headers arrive immediately; the body hangs but honours abort like a real read. */

function signalResponseWithBody(
  status: number,
  text: () => Promise<string>,
): typeof fetch {
  return (async (_input, init) => {
    assert.ok(init?.signal instanceof AbortSignal);
    return {
      ok: status >= 200 && status < 300,
      status,
      text,
    } as unknown as Response;
  }) as typeof fetch;
}

/** Wraps a caller signal so add/removeEventListener calls can be counted. */
function countingSignal(): {
  signal: AbortSignal;
  adds: () => number;
  removes: () => number;
  abort: () => void;
} {
  const controller = new AbortController();
  const signal = controller.signal;
  let adds = 0;
  let removes = 0;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  Object.defineProperty(signal, "addEventListener", {
    configurable: true,
    value: (
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: AddEventListenerOptions,
    ) => {
      adds += 1;
      add(type, listener, options);
    },
  });
  Object.defineProperty(signal, "removeEventListener", {
    configurable: true,
    value: (
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: EventListenerOptions,
    ) => {
      removes += 1;
      remove(type, listener, options);
    },
  });
  return {
    signal,
    adds: () => adds,
    removes: () => removes,
    abort: () => controller.abort(),
  };
}

test("sendSignal caller abort wins once a transport failure enters retry backoff", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const observed: AbortSignal[] = [];
  const fetcher = (async (_input: unknown, init?: RequestInit) => {
    const signal = init?.signal;
    assert.ok(signal instanceof AbortSignal);
    observed.push(signal);
    return await Promise.reject(new Error("network down first"));
  }) as typeof fetch;
  const client = new ThinCommandClient(TARGET, fetcher);
  const caller = new AbortController();
  const pending = client.sendSignal(signalPostRequest(caller.signal));

  // One microtask lets the transport failure enter retry backoff. Cancellation
  // then owns the unfinished call and no later attempt may start.
  await Promise.resolve();
  caller.abort();
  const caught = await boundedRealWait(
    pending.then(() => null, (error: unknown) => error),
    "caller abort during transport retry backoff",
  );
  assert.ok(caught instanceof Error, "got: " + String(caught));
  assert.equal(caught.name, "AbortError");
  assert.equal(caught instanceof CommandTransportError, false);
});

test("sendSignal caller abort wins once a 5xx body failure enters retry backoff", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const observed: AbortSignal[] = [];
  let rejectBody: ((error: unknown) => void) | undefined;
  const fetcher = (async (_input: unknown, init?: RequestInit) => {
    const signal = init?.signal;
    assert.ok(signal instanceof AbortSignal);
    observed.push(signal);
    return {
      ok: false,
      status: 500,
      text: async () =>
        await new Promise<string>((_resolve, reject) => {
          rejectBody = reject;
        }),
    } as unknown as Response;
  }) as typeof fetch;
  const client = new ThinCommandClient(TARGET, fetcher);
  const caller = new AbortController();
  const pending = client.sendSignal(signalPostRequest(caller.signal));

  // Let the headers arrive and the body read begin before forcing its failure.
  for (let index = 0; index < 10 && rejectBody === undefined; index += 1) {
    await Promise.resolve();
  }
  assert.equal(observed.length, 1, "headers arrived");
  assert.ok(rejectBody !== undefined, "the body read started");
  rejectBody(new Error("body stream broke"));
  // Let the typed 5xx reach retry backoff, then cancel the unfinished call.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  caller.abort();
  const caught = await boundedRealWait(
    pending.then(() => null, (error: unknown) => error),
    "caller abort during 5xx retry backoff",
  );
  assert.ok(caught instanceof Error, "got: " + String(caught));
  assert.equal(caught.name, "AbortError");
  assert.equal(caught instanceof CommandHttpError, false);
});

test("sendSignal keeps a 401 body-read failure as a typed HTTP error", async () => {
  const client = new ThinCommandClient(
    TARGET,
    signalResponseWithBody(401, async () => {
      throw new Error("body stream broke");
    }),
  );

  const caught = await client.sendSignal(signalPostRequest()).then(
    () => null,
    (error: unknown) => error,
  );
  assert.ok(caught instanceof CommandHttpError, "got: " + String(caught));
  assert.equal(caught.status, 401);
  assert.equal(caught instanceof CommandTransportError, false);
});

test("sendSignal keeps a non-JSON 403 as a typed HTTP error", async () => {
  const client = new ThinCommandClient(
    TARGET,
    signalResponseWithBody(403, async () => "<html>forbidden</html>"),
  );

  const caught = await client.sendSignal(signalPostRequest()).then(
    () => null,
    (error: unknown) => error,
  );
  assert.ok(caught instanceof CommandHttpError, "got: " + String(caught));
  assert.equal(caught.status, 403);
  assert.equal(caught instanceof CommandTransportError, false);
});

test("sendSignal keeps a 429 interrupted body as a retryable typed HTTP error", async () => {
  const client = new ThinCommandClient(
    TARGET,
    signalResponseWithBody(429, async () => {
      throw new Error("body stream interrupted");
    }),
  );

  const caught = await client.sendSignal(signalPostRequest()).then(
    () => null,
    (error: unknown) => error,
  );
  assert.ok(caught instanceof CommandHttpError, "got: " + String(caught));
  assert.equal(caught.status, 429);
  assert.equal(caught instanceof CommandTransportError, false);
});

test("sendSignal preserves typed HTTP precedence for a 503 body-read failure", async () => {
  const client = new ThinCommandClient(
    TARGET,
    signalResponseWithBody(503, async () => {
      throw new Error("body stream interrupted");
    }),
    { signalRetryBaseMs: 0 },
  );

  const caught = await client.sendSignal(signalPostRequest()).then(
    () => null,
    (error: unknown) => error,
  );
  assert.ok(caught instanceof CommandHttpError, "got: " + String(caught));
  assert.equal(caught.status, 503);
  assert.equal(caught.message, "signal failed (HTTP 503)");
});

test("sendSignal turns a synchronous fetch throw into the generic transport error without deferring invocation", async () => {
  // Real, instrumented timers: this test must prove the internal deadline timer
  // is cleared so it cannot keep the process alive. Mock timers cannot carry
  // that proof — a leaked mock timer holds nothing.
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  let activeTimers = 0;
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    activeTimers += 1;
    return realSetTimeout(...args);
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((...args: Parameters<typeof clearTimeout>) => {
    activeTimers -= 1;
    return realClearTimeout(...args);
  }) as typeof clearTimeout;
  try {
    let calls = 0;
    const throwingFetcher = ((_input: unknown, init?: RequestInit) => {
      calls += 1;
      assert.ok(
        init?.signal instanceof AbortSignal,
        "the synchronous throw must still see the effective AbortSignal",
      );
      throw new Error("sync network down");
    }) as typeof fetch;

    const counted = countingSignal();
    const client = new ThinCommandClient(TARGET, throwingFetcher, {
      signalRetryBaseMs: 0,
    });
    const pending = client.sendSignal(signalPostRequest(counted.signal));
    assert.equal(
      calls,
      1,
      "the throwing fetcher must be invoked immediately inside sendSignal, never deferred",
    );

    const caught = await pending.then(() => null, (error: unknown) => error);
    assert.ok(
      caught instanceof CommandTransportError,
      "a synchronous throw must become the generic transport error, got: " +
        String(caught),
    );
    assert.equal(caught.message, "signal request failed before a response");
    assert.notEqual(caught.name, "AbortError");
    assert.notEqual(caught.message, "signal request timed out");

    assert.equal(counted.adds(), 1, "one caller listener was attached");
    assert.equal(counted.removes(), 1, "the caller listener was removed");
    assert.equal(
      activeTimers,
      0,
      "the internal deadline timer must be cleared so it cannot keep the process alive",
    );
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
});
