/** The attended-seat canary proves a watcher by a lease renewal after its note was accepted. A lease read that
 * fails in transit must not end the canary: one slow or dropped read says nothing about the watcher. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { runAttendedAttendanceCanary } from "../src/listener/attendance-canary.js";
import { WakeLeaseReadError, type AgentWakeLease } from "../src/cloud/wake-lease.js";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const PRINCIPAL = "22222222-2222-4222-8222-222222222222";
const WATCHER = "33333333-3333-4333-8333-333333333333";
const SIGNAL = "44444444-4444-4444-8444-444444444444";

/** The post is accepted; receipt reads answer with no receipt (the session has not run check). */
const fetcher = (async (url: string) => {
  if (String(url).endsWith("/functions/v1/command")) {
    return new Response(JSON.stringify({ status: "accepted", ok: true, event_ids: [], signal: {
      id: SIGNAL, workspace_id: WORKSPACE, from: PRINCIPAL, from_kind: "agent", to: null, to_agent: PRINCIPAL,
      in_reply_to: null, about: null, kind: "note", body: "canary", until: "2030-01-01T00:00:00.000Z",
      created_at: new Date(Date.UTC(2026, 10, 18, 12)).toISOString() } }), { status: 200 });
  }
  return new Response(JSON.stringify({ addressed: null, receipts: [], replies: [] }), { status: 200 });
}) as unknown as typeof fetch;

/** Run the canary on a virtual clock; `lease(i, t)` answers the i-th lease read at virtual time t (ms). */
async function canary(lease: (call: number, at: number) => AgentWakeLease | null | Error) {
  let clock = 0;
  let calls = 0;
  return await runAttendedAttendanceCanary({
    target: { url: "http://127.0.0.1:9", anonKey: "anon", profileId: "p" } as never,
    workspaceId: WORKSPACE, principalId: PRINCIPAL, watcherId: WATCHER, generation: 1,
    credential: async () => "token", checkWaitMs: 1_000, fetcher,
    now: () => clock, sleep: async (ms) => { clock += ms; }, pollMs: 1_000, watcherWaitMs: 90_000,
    readWakeLease: async () => {
      const answer = lease(calls++, clock);
      clock += 300; // each read takes a little while
      if (answer instanceof Error) throw answer;
      return answer;
    },
  });
}
/** A live watcher renews every 60 s; its lease age resets at each renewal. */
const renewing = (at: number): AgentWakeLease =>
  ({ watcher_id: WATCHER, host_label: "mini", generation: 1, renewed_age_ms: 20_000 + (at % 60_000) }) as AgentWakeLease;
const transit = () => new WakeLeaseReadError(null, "wake lease read could not reach the cloud service");

test("a live watcher is proved even when an early lease read fails in transit or with a 5xx", async () => {
  for (const failure of [transit(), new WakeLeaseReadError(503, "wake lease read failed (HTTP 503)")]) {
    const result = await canary((call, at) => call === 0 ? failure : renewing(at));
    assert.equal(result.watcherPollState, "proved", JSON.stringify(result));
    assert.ok(result.watcherPolledAt !== null);
    assert.equal(result.wakeLeaseReadError, null, "a read that later succeeded is not reported as a failure");
  }
});

test("a stopped watcher is not proved: its lease reads fine but never renews", async () => {
  const result = await canary((_call, at) =>
    ({ watcher_id: WATCHER, host_label: "mini", generation: 1, renewed_age_ms: 200_000 + at }) as AgentWakeLease);
  assert.equal(result.watcherPollState, "not_observed");
  assert.equal(result.watcherPolledAt, null);
  assert.equal(result.wakeLeaseReadError, null);
  assert.equal(result.stalledAt, "watcher_polled");
});

test("a canary whose lease reads all fail reports the read failure, not a stalled watcher", async () => {
  const result = await canary(() => transit());
  assert.equal(result.watcherPollState, "not_observed");
  assert.deepEqual(result.wakeLeaseReadError, { status: null });
  assert.equal(result.stalledAt, null);
});

test("a refused credential still stops the canary at once", async () => {
  let reads = 0;
  const result = await canary(() => { reads += 1; return new WakeLeaseReadError(401, "wake lease read failed (HTTP 401)"); });
  assert.deepEqual(result.wakeLeaseReadError, { status: 401 });
  assert.equal(reads, 1, "no retry after a refusal");
});
