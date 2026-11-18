/** The slow-command log line: phases from fixed marks, written only at 1.5 s or more. Nothing in it comes from
 * the request: the kind is logged only from the edge's own allowlist, and the request id is the server's. */
import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error TS5097: this service-free test imports the Deno source directly.
import { CommandTimer, SLOW_COMMAND_LOG_MS, slowCommandLine } from "../supabase/functions/command/slow-command-log.ts";

const KNOWN = new Set(["post_signal", "add_reaction"]);
const REQUEST = "5b0c9c1e-8a52-4f0a-9d6e-2f6a1c0b7e31";

/** A timer on a scripted clock: each mark consumes the next timestamp. */
function scripted(times: number[]): CommandTimer {
  let i = 0;
  return new CommandTimer(() => times[Math.min(i++, times.length - 1)]!);
}

test("phases come from the marks; a command under 1.5 s writes nothing", () => {
  // start 0, plan 100..2100 (a 2 s lock wait), grant 2200..2250, body end 2400, end 2500
  const slow = scripted([0, 100, 2100, 2200, 2250, 2400, 2500]);
  slow.attempt();
  for (const mark of ["plan_start", "plan_end", "grant_start", "grant_end", "body_end", "end"] as const) slow.mark(mark);
  slow.streamLocked = true;
  const line = JSON.parse(slowCommandLine({ commandKind: "post_signal", knownKinds: KNOWN, timer: slow, status: 200, requestId: REQUEST })!);
  assert.deepEqual(line, {
    event: "command_slow", command_kind: "post_signal", total_ms: 2500,
    phase_ms: { auth: 100, plan_lock: 2000, grant: 50, body: 250, commit: 100 },
    status: 200, stream_locked: true, attempts: 1, request_id: REQUEST,
  });

  const fast = scripted([0, 10, 20, 30, 40, 50, SLOW_COMMAND_LOG_MS - 1]);
  fast.attempt();
  for (const mark of ["plan_start", "plan_end", "grant_start", "grant_end", "body_end", "end"] as const) fast.mark(mark);
  assert.equal(slowCommandLine({ commandKind: "post_signal", knownKinds: KNOWN, timer: fast, status: 200, requestId: REQUEST }), null);
});

test("a phase the request never reached is null; a retry restarts the inner marks", () => {
  const refused = scripted([0, 1900]);
  refused.attempt();
  refused.mark("end");
  const line = JSON.parse(slowCommandLine({ commandKind: "add_reaction", knownKinds: KNOWN, timer: refused, status: 403, requestId: REQUEST })!);
  assert.deepEqual(line.phase_ms, { auth: null, plan_lock: null, grant: null, body: null, commit: null });

  const retried = scripted([0, 100, 200, 300, 400, 2000, 2100, 2200]);
  retried.attempt();
  retried.mark("plan_start"); retried.mark("plan_end");
  retried.attempt();
  retried.mark("plan_start"); retried.mark("plan_end"); retried.mark("body_end"); retried.mark("end");
  const again = JSON.parse(slowCommandLine({ commandKind: "post_signal", knownKinds: KNOWN, timer: retried, status: 200, requestId: REQUEST })!);
  assert.equal(again.attempts, 2);
  assert.deepEqual(again.phase_ms, { auth: 300, plan_lock: 100, grant: null, body: 1600, commit: 100 });
});

test("nothing from the request reaches the line: unknown kinds are 'other', and only fixed keys appear", () => {
  const timer = scripted([0, 5000]);
  timer.mark("end");
  for (const kind of ["mark_everything_read", "post_signal\"; token=swm_agt_x", "Bearer swm_agt_secret", ""]) {
    const line = JSON.parse(slowCommandLine({ commandKind: kind, knownKinds: KNOWN, timer, status: 500, requestId: REQUEST })!);
    assert.equal(line.command_kind, "other", kind);
  }
  const line = JSON.parse(slowCommandLine({ commandKind: "post_signal", knownKinds: KNOWN, timer, status: 500, requestId: "not-a-uuid" })!);
  assert.equal(line.request_id, null, "a request id that is not the server's UUID is dropped");
  assert.deepEqual(Object.keys(line).sort(),
    ["attempts", "command_kind", "event", "phase_ms", "request_id", "status", "stream_locked", "total_ms"]);
});
