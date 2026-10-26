/** Main-only listener route, generated enumerations, and no-model runtime. Named in `npm test`. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cloudTarget } from "../src/cloud/config.js";
import {
  listenerRouteConfiguration,
} from "../src/cli.js";
import type { SignalRecord } from "../src/cloud/command-client.js";
import {
  FilePendingMainQueue,
  runListenerRuntime,
  type ListenerEffectRecord,
  type ListenerPromptMode,
  type ListenerPromptResult,
  type ListenerRuntimeEvent,
  type ListenerRuntimeModel,
} from "../src/listener/index.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const PRINCIPAL_ID = "22222222-2222-4222-8222-222222222222";

test("route parser accepts main and refuses worker, split, and defer-over from the constant", () => {
  assert.deepEqual(listenerRouteConfiguration(undefined, undefined), {
    routeMode: "main",
    deferOverChars: null,
  });
  assert.deepEqual(listenerRouteConfiguration("main", undefined), {
    routeMode: "main",
    deferOverChars: null,
  });
  assert.throws(() => listenerRouteConfiguration("worker", undefined));
  assert.throws(() => listenerRouteConfiguration("split", "200"));
  assert.throws(() => listenerRouteConfiguration("main", "200"));
  assert.throws(() => listenerRouteConfiguration("split", undefined));
});

class ThrowingStartModel implements ListenerRuntimeModel {
  starts = 0;
  prompts = 0;
  async start(): Promise<void> {
    this.starts += 1;
    throw new Error("fake model start must not be called");
  }
  async prompt(
    _signal: SignalRecord,
    _mode: ListenerPromptMode,
    _prompt: string,
    _attempt: number,
  ): Promise<ListenerPromptResult> {
    this.prompts += 1;
    throw new Error("fake model prompt must not be called");
  }
  cancel(): void {}
  async close(): Promise<void> {}
}

test("runtime reaches ready without calling model.start even when start throws", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-main-only-ready-"));
  const controller = new AbortController();
  const model = new ThrowingStartModel();
  const events: ListenerRuntimeEvent[] = [];
  const effects = new Map<string, ListenerEffectRecord>();
  const queue = new FilePendingMainQueue(root);
  const note: SignalRecord = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    workspace_id: WORKSPACE_ID,
    from: PRINCIPAL_ID,
    from_kind: "agent",
    to: null,
    to_agent: PRINCIPAL_ID,
    in_reply_to: null,
    about: null,
    kind: "note",
    body: "queue me",
    until: "2036-01-01T00:00:00.000Z",
    created_at: "2026-09-06T00:00:00.000Z",
  };
  let reads = 0;
  try {
    const stop = await runListenerRuntime({
      target: cloudTarget("https://cloud.example.test", "anon"),
      workspaceId: WORKSPACE_ID,
      principalId: PRINCIPAL_ID,
      credentialSession: { async bearer() { return "token"; } },
      store: {
        async read(id) { return effects.get(id) ?? null; },
        async write(record) { effects.set(record.signalId, record); },
      },
      model,
      pendingMainQueue: queue,
      signal: controller.signal,
      now: () => Date.parse("2026-09-06T00:00:00.000Z"),
      sleep: async () => {
        controller.abort();
      },
      onEvent: (event) => events.push(event),
      readPage: async () => {
        reads += 1;
        if (reads > 1) controller.abort();
        return {
          signals: reads === 1 ? [note] : [],
          capabilities: {
            senderOwnerRelation: true,
            cursorAfter: true,
            deliveryClaim: false,
            deliveryAck: false,
          },
          legacyCursorFallback: false,
          rawCount: reads === 1 ? 1 : 0,
          nextCursor: null,
          malformedRows: 0,
          pendingDeliveryCount: null,
        };
      },
    });
    assert.equal(stop.reason, "cancelled");
    assert.ok(events.some((event) => event.type === "ready"));
    assert.equal(model.starts, 0);
    assert.equal(model.prompts, 0);
    const queued = await queue.read();
    assert.equal(queued.length, 1);
    assert.equal(queued[0]?.signalId, note.id);
    assert.equal(queued[0]?.body, "queue me");
    const raw = await readFile(join(root, "pending-for-main.json"), "utf8");
    assert.match(raw, /queue me/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
