import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CLEANUP_CONCURRENCY,
  CLEANUP_MAX_ITEMS,
  classifyReply,
  cleanupCommand,
  cleanupConsequence,
  freezePass,
  retryable,
  runPass,
  summarize,
} from "./cleanup.ts";

const ctx = { userId: "u1", workspaceId: "w1" };
let counter = 0;
const newId = () => `cmd-${++counter}`;
const targets = (n) => Array.from({ length: n }, (_, i) => ({ id: `t${i}`, label: `Item ${i}` }));

test("a pass is frozen: exact targets, one stable command id each, bounded size", () => {
  const pass = freezePass(ctx, "remove_agent", [...targets(3), { id: "t1", label: "dup" }], newId);
  assert.deepEqual(pass.items.map((i) => i.id), ["t0", "t1", "t2"], "duplicates collapse");
  assert.equal(new Set(pass.items.map((i) => i.commandId)).size, 3);
  assert.ok(Object.isFrozen(pass) && Object.isFrozen(pass.items) && Object.isFrozen(pass.items[0]) && Object.isFrozen(pass.context));
  assert.throws(() => freezePass(ctx, "tombstone_file", [], newId), /at least one/);
  assert.throws(() => freezePass(ctx, "tombstone_file", targets(CLEANUP_MAX_ITEMS + 1), newId), /at most 200/);
  assert.equal(freezePass(ctx, "tombstone_file", targets(CLEANUP_MAX_ITEMS), newId).items.length, 200);
});

test("only the two existing commands are ever sent, and the stated consequence matches", () => {
  assert.deepEqual(cleanupCommand("remove_agent", "p1"), { kind: "remove_agent_from_workspace", principal_id: "p1" });
  assert.deepEqual(cleanupCommand("tombstone_file", "f1"), { kind: "file_tombstone", file_id: "f1" });
  assert.match(cleanupConsequence("remove_agent"), /from this workspace.*connection.*add it back/s);
  assert.doesNotMatch(cleanupConsequence("remove_agent"), /permanent|irreversibl|everywhere\./i);
  assert.match(cleanupConsequence("tombstone_file"), /restored until they are purged/);
});

test("replies map to accepted, already done, refused, rate limited and unknown; lost is never failure", () => {
  assert.equal(classifyReply({ status: 200, body: { status: "accepted" } }), "accepted");
  assert.equal(classifyReply({ status: 200, body: { status: "replayed" } }), "already_done");
  assert.equal(classifyReply({ status: 409, body: { error: "file_tombstoned" } }), "already_done");
  assert.equal(classifyReply({ status: 403, body: { error: "forbidden" } }), "refused");
  assert.equal(classifyReply({ status: 429, body: { error: "rate_limited" } }), "rate_limited");
  assert.equal(classifyReply({ status: 502, body: {} }), "unknown");
  assert.equal(classifyReply("lost"), "unknown");
});

test("at most four in flight, every item sent once with its frozen id and payload", async () => {
  const pass = freezePass(ctx, "tombstone_file", targets(10), newId);
  let inFlight = 0, peak = 0;
  const sent = [];
  const results = await runPass(pass, async (item, command, context) => {
    inFlight++; peak = Math.max(peak, inFlight);
    sent.push({ id: item.id, commandId: item.commandId, command, context });
    await new Promise((r) => setTimeout(r, 2));
    inFlight--;
    return { status: 200, body: { status: "accepted" } };
  }, () => ({ ...ctx }));
  assert.equal(peak, CLEANUP_CONCURRENCY);
  assert.equal(sent.length, 10);
  for (const row of sent) {
    const item = pass.items.find((i) => i.id === row.id);
    assert.equal(row.commandId, item.commandId);
    assert.deepEqual(row.command, { kind: "file_tombstone", file_id: row.id });
    assert.deepEqual(row.context, ctx);
  }
  assert.equal(summarize(results).accepted, 10);
});

test("scheduling stops when the account, workspace or role changes; the rest is not attempted", async () => {
  for (const change of [null, { userId: "u2", workspaceId: "w1" }, { userId: "u1", workspaceId: "w2" }]) {
    const pass = freezePass(ctx, "remove_agent", targets(12), newId);
    let calls = 0;
    let now = { ...ctx };
    const results = await runPass(pass, async () => {
      calls++;
      if (calls === 2) now = change;
      await new Promise((r) => setTimeout(r, 1));
      return { status: 200, body: { status: "accepted" } };
    }, () => now, { concurrency: 1 });
    assert.equal(calls, 2, JSON.stringify(change));
    const counts = summarize(results);
    assert.equal(counts.accepted, 2);
    assert.equal(counts.not_attempted, 10);
  }
});

test("a lost reply stays unknown, and a retry resends only those with the same id and payload", async () => {
  const pass = freezePass(ctx, "tombstone_file", targets(4), newId);
  const first = await runPass(pass, async (item) => (item.id === "t2" ? "lost" : { status: 200, body: { status: "accepted" } }), () => ctx);
  assert.equal(first.get("t2"), "unknown");
  const again = retryable(first);
  assert.deepEqual([...again], ["t2"]);
  const resent = [];
  const second = await runPass(pass, async (item, command) => {
    resent.push([item.id, item.commandId, command]);
    return { status: 200, body: { status: "replayed" } };
  }, () => ctx, { only: again });
  assert.deepEqual(resent, [["t2", pass.items[2].commandId, { kind: "file_tombstone", file_id: "t2" }]]);
  assert.equal(second.get("t2"), "already_done");
});

test("a rate limit stops the pass instead of looping; a thrown send is unknown", async () => {
  const pass = freezePass(ctx, "tombstone_file", targets(8), newId);
  let calls = 0;
  const results = await runPass(pass, async () => {
    calls++;
    if (calls === 1) throw new Error("network");
    if (calls === 2) return { status: 429, body: { error: "rate_limited" } };
    return { status: 200, body: { status: "accepted" } };
  }, () => ctx, { concurrency: 1 });
  assert.equal(calls, 2);
  assert.deepEqual(summarize(results), { accepted: 0, already_done: 0, refused: 0, rate_limited: 1, unknown: 1, not_attempted: 6 });
});
