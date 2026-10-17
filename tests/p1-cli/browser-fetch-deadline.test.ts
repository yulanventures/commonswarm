/**
 * D-034 browser observer.
 *
 * Pure: no network, database, DOM implementation, or Supabase stack. The fake fetches never
 * produce an answer on their own; only the production AbortSignal can settle them.
 *
 * ★ ROOT-REACHABLE: test:p1-cli globs this file.
 * ★ SITE-REACHABLE: site/package.json runs this exact file, not a second copy.
 */
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { Session } from "@supabase/supabase-js";
// Node 22+ executes erasable TypeScript directly; tsx does the same in the root gate.
// @ts-expect-error TS5097: the site gate needs the real .ts path without a build step.
const commonswarm = await import("../../site/src/lib/commonswarm.ts");
const {
  BrowserReadTimedOut,
  WorkspaceOutcomeUnknown,
  createWorkspace,
  feed,
  myWorkspaces,
} = commonswarm;

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const SESSION = {
  access_token: "browser-access-token",
  user: { id: "22222222-2222-4222-8222-222222222222" },
} as unknown as Session;

function installDeployment(t: TestContext): void {
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      querySelector(selector: string) {
        if (selector.includes("commonswarm:url")) {
          return { content: "https://browser-deadline.example" };
        }
        if (selector.includes("commonswarm:anon-key")) {
          return { content: "browser-test-anon-key" };
        }
        return null;
      },
    },
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "document", original);
    else delete (globalThis as { document?: unknown }).document;
  });
}

// Capture real timers before Node mocks the production deadline clock.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
function completionSignal(description: string) {
  let complete!: () => void;
  const reached = new Promise<void>(resolve => { complete = resolve; });
  return {
    complete,
    async wait() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([reached, new Promise<never>((_, reject) => {
          timer = realSetTimeout(() => reject(new Error(`observer never reached ${description}`)), 5000);
        })]);
      } finally { realClearTimeout(timer); }
    },
  };
}

function hangingFetch(observed: AbortSignal[], entered: () => void): typeof fetch {
  return (async (_input, init) => {
    const signal = init?.signal;
    assert.ok(
      signal instanceof AbortSignal,
      "every production browser fetch must carry its application deadline",
    );
    observed.push(signal);
    entered();
    return await new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        const error = new Error("browser request timed out");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    });
  }) as typeof fetch;
}

test("D-034: create fetch settles with an explicit unknown outcome at the deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  installDeployment(t);
  const observed: AbortSignal[] = [];
  const entered = completionSignal("the production fetch call site");
  t.mock.method(globalThis, "fetch", hangingFetch(observed, entered.complete));

  const creation = createWorkspace(
    SESSION,
    "web_deadline_command",
    WORKSPACE_ID,
    "Deadline observer",
  );
  const failure = assert.rejects(creation, (error: unknown) => {
    assert.ok(error instanceof WorkspaceOutcomeUnknown);
    assert.match(error.message, /stopped waiting after 30 seconds/);
    assert.match(error.message, /cannot tell whether the workspace was created/);
    assert.match(error.message, /Reload before trying again/);
    return true;
  });

  await entered.wait();
  assert.equal(observed.length, 1);
  t.mock.timers.tick(29_999);
  assert.equal(observed[0]?.aborted, false, "the create deadline must not fire early");
  t.mock.timers.tick(1);
  await failure;
  assert.equal(observed[0]?.aborted, true, "the hanging create fetch must be aborted");
});

test("D-034: signup membership read settles safely at the browser deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  installDeployment(t);
  const observed: AbortSignal[] = [];
  const entered = completionSignal("the production fetch call site");
  t.mock.method(globalThis, "fetch", hangingFetch(observed, entered.complete));

  const workspaces = myWorkspaces();
  const failure = assert.rejects(workspaces, (error: unknown) => {
    assert.ok(error instanceof BrowserReadTimedOut);
    assert.equal(error.operation, "your workspaces");
    assert.match(error.message, /Nothing changed; try again/);
    return true;
  });

  await entered.wait();
  assert.equal(observed.length, 1);
  t.mock.timers.tick(29_999);
  assert.equal(observed[0]?.aborted, false, "the membership deadline must not fire early");
  t.mock.timers.tick(1);
  await failure;
  assert.equal(observed[0]?.aborted, true, "the hanging membership fetch must be aborted");
});

test("D-034: dashboard feed read settles safely at the browser deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  installDeployment(t);
  const observed: AbortSignal[] = [];
  const entered = completionSignal("the production fetch call site");
  t.mock.method(globalThis, "fetch", hangingFetch(observed, entered.complete));

  const signals = feed(WORKSPACE_ID);
  const failure = assert.rejects(signals, (error: unknown) => {
    assert.ok(error instanceof BrowserReadTimedOut);
    assert.equal(error.operation, "workspace activity");
    assert.match(error.message, /Nothing changed; try again/);
    return true;
  });

  await entered.wait();
  assert.equal(observed.length, 1);
  t.mock.timers.tick(29_999);
  assert.equal(observed[0]?.aborted, false, "the feed deadline must not fire early");
  t.mock.timers.tick(1);
  await failure;
  assert.equal(observed[0]?.aborted, true, "the hanging feed fetch must be aborted");
});

test("D-034: create deadline remains live while the response body is unreadable", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  installDeployment(t);
  let bodySignal: AbortSignal | null = null;
  const bodyRead = completionSignal("the production response body read");
  t.mock.method(globalThis, "fetch", (async (_input, init) => {
    const signal = init?.signal;
    assert.ok(signal instanceof AbortSignal);
    bodySignal = signal;
    return {
      status: 200,
      text: async () => {
        bodyRead.complete();
        return await new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            const error = new Error("response body timed out");
            error.name = "AbortError";
            reject(error);
          }, { once: true });
        });
      },
    } as Response;
  }) as typeof fetch);

  const creation = createWorkspace(
    SESSION,
    "web_body_deadline_command",
    WORKSPACE_ID,
    "Body observer",
  );
  const failure = assert.rejects(creation, (error: unknown) => {
    assert.ok(error instanceof WorkspaceOutcomeUnknown);
    assert.match(error.message, /cannot tell whether the workspace was created/);
    return true;
  });

  await bodyRead.wait();
  const observedBodySignal = bodySignal as unknown as AbortSignal;
  assert.equal(observedBodySignal.aborted, false);
  t.mock.timers.tick(30_000);
  await failure;
  assert.equal(observedBodySignal.aborted, true);
});
