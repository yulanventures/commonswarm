import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FEED_POLL_MS,
  FEED_PUSH_BACKOFF_MS,
  FEED_RECONCILE_MS,
  FeedPushController,
  WORKSPACE_SIGNALS_EVENT,
  WORKSPACE_SIGNALS_TOPIC_PREFIX,
  attachFeedChannels,
  memberSignalsTopic,
  workspaceSignalsTopic,
} from "./feed-push.ts";

const WS_A = "11111111-1111-4111-8111-111111111111";
const WS_B = "22222222-2222-4222-8222-222222222222";
const PERSON = "33333333-3333-4333-8333-333333333333";

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
      attachFeedChannels(fake.client, workspaceId, PERSON, onEvent, onStatus),
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

test("the member topic is the workspace and the person, lowercased, and nothing else", () => {
  // Written out: this is the name the server sends to and the only one its policy admits.
  assert.equal(
    memberSignalsTopic(WS_A, PERSON),
    "cswarm-member:11111111-1111-4111-8111-111111111111:33333333-3333-4333-8333-333333333333",
  );
  assert.equal(
    memberSignalsTopic("AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB"),
    "cswarm-member:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  );
  assert.throws(() => memberSignalsTopic(WS_A, "someone"));
  assert.throws(() => memberSignalsTopic("sample-design-studio", PERSON));
  assert.throws(() => memberSignalsTopic(WS_A, `${PERSON}:${WS_B}`));
});

const TOPICS_A = [workspaceSignalsTopic(WS_A), memberSignalsTopic(WS_A, PERSON)];
const TOPICS_B = [workspaceSignalsTopic(WS_B), memberSignalsTopic(WS_B, PERSON)];

test("the feed joins the workspace topic and the person's own, both private, for the same event", async () => {
  const { controller, fake } = createHarness();
  controller.start(WS_A);
  await controller.whenIdle();
  assert.deepEqual(fake.channels.map((channel) => channel.topic), TOPICS_A);
  assert.deepEqual(fake.channels.map((channel) => channel.opts.config.private), [true, true]);
  assert.deepEqual(fake.log.filter((row) => row.op === "on").map((row) => row.event), [
    WORKSPACE_SIGNALS_EVENT,
    WORKSPACE_SIGNALS_EVENT,
  ]);
});

test("a malformed person id joins nothing", () => {
  const fake = createFakeClient();
  assert.throws(() => attachFeedChannels(fake.client, WS_A, "someone", () => {}, () => {}));
  assert.deepEqual(fake.log, []);
});

test("push counts as joined only while both topics are, and either one dropping restores the poll", async () => {
  const { controller, timers, fake, refreshes } = createHarness();
  controller.start(WS_A);
  controller.arm();
  await controller.whenIdle();
  const [workspace, member] = fake.channels;

  workspace.statusHandler("SUBSCRIBED");
  assert.equal(controller.subscribed, false, "the workspace topic alone would leave private channels on the reconcile");
  await timers.tick(FEED_POLL_MS);
  assert.equal(refreshes.count, 1, "still polling");
  member.statusHandler("SUBSCRIBED");
  assert.equal(controller.subscribed, true);

  // A message in a private channel arrives on the person's own topic and refreshes the feed like any other.
  const beforeEvent = refreshes.count;
  member.eventHandler({});
  await Promise.resolve();
  assert.equal(refreshes.count, beforeEvent + 1);
  workspace.eventHandler({});
  await Promise.resolve();
  assert.equal(refreshes.count, beforeEvent + 2);

  // Joined: only the slow reconcile runs.
  const joinedCount = refreshes.count;
  await timers.tick(FEED_RECONCILE_MS - 1);
  assert.equal(refreshes.count, joinedCount);

  for (const [name, dropped, other] of [["member", member, workspace], ["workspace", workspace, member]]) {
    dropped.statusHandler("SUBSCRIBED");
    other.statusHandler("SUBSCRIBED");
    assert.equal(controller.subscribed, true, `${name}: joined again`);
    dropped.statusHandler("CHANNEL_ERROR");
    assert.equal(controller.subscribed, false, `${name} topic dropped`);
    other.statusHandler("SUBSCRIBED");
    assert.equal(controller.subscribed, false, `${name}: the other topic repeating itself does not count for both`);
  }
});

test("after a drop the feed leaves both topics and joins both again", async () => {
  const { controller, timers, fake } = createHarness();
  controller.start(WS_A);
  await controller.whenIdle();
  const first = [...fake.channels];
  for (const channel of first) channel.statusHandler("SUBSCRIBED");
  first[1].statusHandler("TIMED_OUT");
  await timers.tick(FEED_PUSH_BACKOFF_MS[0]);
  await controller.whenIdle();
  assert.deepEqual(fake.channels.map((channel) => channel.topic), TOPICS_A);
  assert.ok(fake.channels.every((channel) => !first.includes(channel)), "both joins are new");
  assert.deepEqual(
    fake.log.filter((row) => row.op === "removeChannel").map((row) => row.topic),
    TOPICS_A,
  );
});

test("workspace switch removes both old channels before the new subscribe", async () => {
  const harness = createHarness();
  harness.controller.start(WS_A);
  await harness.controller.whenIdle();
  harness.controller.start(WS_B);
  await harness.controller.whenIdle();
  const ops = harness.fake.log
    .filter((row) => row.op === "channel" || row.op === "removeChannel")
    .map((row) => `${row.op}:${row.topic}`);
  assert.deepEqual(ops, [
    ...TOPICS_A.map((topic) => `channel:${topic}`),
    ...TOPICS_A.map((topic) => `removeChannel:${topic}`),
    ...TOPICS_B.map((topic) => `channel:${topic}`),
  ]);
});
