import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FeedPushController,
  WORKSPACE_SIGNALS_EVENT,
  WORKSPACE_SIGNALS_TOPIC_PREFIX,
  attachWorkspaceSignalsChannel,
  workspaceSignalsTopic,
} from "./feed-push.ts";

const WS_A = "11111111-1111-4111-8111-111111111111";
const WS_B = "22222222-2222-4222-8222-222222222222";

function createFakeTimers() {
  let now = 0;
  let nextId = 1;
  const intervals = new Map();
  const timeouts = new Map();
  return {
    now: () => now,
    setInterval(fn, ms) {
      const id = nextId++;
      intervals.set(id, { fn, ms, next: now + ms });
      return id;
    },
    clearInterval(id) {
      if (id !== undefined) intervals.delete(id);
    },
    setTimeout(fn, ms) {
      const id = nextId++;
      timeouts.set(id, { fn, due: now + ms });
      return id;
    },
    clearTimeout(id) {
      if (id !== undefined) timeouts.delete(id);
    },
    async tick(ms) {
      const end = now + ms;
      while (true) {
        let soonest = null;
        for (const [id, item] of timeouts) {
          if (item.due <= end && (soonest === null || item.due < soonest.at)) {
            soonest = {
              at: item.due,
              run: () => {
                timeouts.delete(id);
                item.fn();
              },
            };
          }
        }
        for (const [, item] of intervals) {
          if (item.next <= end && (soonest === null || item.next < soonest.at)) {
            soonest = {
              at: item.next,
              run: () => {
                item.fn();
                item.next += item.ms;
              },
            };
          }
        }
        if (soonest === null) {
          now = end;
          return;
        }
        now = soonest.at;
        soonest.run();
        await Promise.resolve();
      }
    },
  };
}

function createFakeClient() {
  const log = [];
  const channels = [];
  const client = {
    channel(topic, opts) {
      log.push({ op: "channel", topic, opts });
      const ch = {
        topic,
        opts,
        eventHandler: null,
        statusHandler: null,
        on(_type, filter, cb) {
          log.push({ op: "on", event: filter.event, topic });
          ch.eventHandler = cb;
          return ch;
        },
        subscribe(cb) {
          log.push({ op: "subscribe", topic });
          ch.statusHandler = cb;
          return ch;
        },
      };
      channels.push(ch);
      return ch;
    },
    async removeChannel(ch) {
      log.push({ op: "removeChannel", topic: ch.topic });
      const index = channels.indexOf(ch);
      if (index >= 0) channels.splice(index, 1);
    },
  };
  return { client, log, channels };
}

function createHarness(refresh) {
  const timers = createFakeTimers();
  const fake = createFakeClient();
  const refreshes = { count: 0 };
  const controller = new FeedPushController({
    subscribe: async (workspaceId, onEvent, onStatus) =>
      attachWorkspaceSignalsChannel(fake.client, workspaceId, onEvent, onStatus),
    refresh: refresh ?? (async () => {
      refreshes.count += 1;
    }),
    timers,
  });
  return { controller, timers, fake, refreshes };
}

test("topic is the workspace prefix plus a lowercased uuid", () => {
  assert.equal(workspaceSignalsTopic(WS_A), `${WORKSPACE_SIGNALS_TOPIC_PREFIX}${WS_A}`);
  assert.equal(
    workspaceSignalsTopic("AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"),
    `${WORKSPACE_SIGNALS_TOPIC_PREFIX}aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
  );
  assert.throws(() => workspaceSignalsTopic("sample-design-studio"));
});

test("fake client joins the private signal topic", async () => {
  const { controller, fake } = createHarness();
  controller.start(WS_A);
  await controller.whenIdle();
  assert.equal(fake.channels.length, 1);
  assert.equal(fake.channels[0].topic, workspaceSignalsTopic(WS_A));
  assert.equal(fake.channels[0].opts.config.private, true);
  assert.deepEqual(fake.log.filter((row) => row.op === "on").map((row) => row.event), [
    WORKSPACE_SIGNALS_EVENT,
  ]);
});

test("workspace switch removes the old channel before the new subscribe", async () => {
  const harness = createHarness();
  harness.controller.start(WS_A);
  await harness.controller.whenIdle();
  assert.equal(harness.fake.channels[0].topic, workspaceSignalsTopic(WS_A));
  harness.controller.start(WS_B);
  await harness.controller.whenIdle();
  const ops = harness.fake.log
    .filter((row) => row.op === "channel" || row.op === "removeChannel")
    .map((row) => `${row.op}:${row.topic}`);
  const removeA = ops.indexOf(`removeChannel:${workspaceSignalsTopic(WS_A)}`);
  const channelB = ops.indexOf(`channel:${workspaceSignalsTopic(WS_B)}`);
  assert.ok(removeA >= 0, `old channel was removed: ${ops.join(" ")}`);
  assert.ok(channelB >= 0, `new channel was created: ${ops.join(" ")}`);
  assert.ok(
    removeA < channelB,
    `old channel must go before the new subscribe: ${ops.join(" ")}`,
  );
});
