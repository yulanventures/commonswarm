/** The slow-command log line: phases from fixed marks, written only at 1.5 s or more, with no caller data
 * beyond a command kind of a known shape and a CF-Ray of Cloudflare's shape. */
import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error TS5097: this service-free test imports the Deno source directly.
import { CommandTimer, SLOW_COMMAND_LOG_MS, cfRayOf, slowCommandLine } from "../supabase/functions/command/slow-command-log.ts";

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
  const line = JSON.parse(slowCommandLine({ commandKind: "post_signal", timer: slow, status: 200, cfRay: "8e3f0a1b2c3d4e5f-FRA" })!);
  assert.deepEqual(line, {
    event: "command_slow", command_kind: "post_signal", total_ms: 2500,
    phase_ms: { auth: 100, plan_lock: 2000, grant: 50, body: 250, commit: 100 },
    status: 200, stream_locked: true, attempts: 1, cf_ray: "8e3f0a1b2c3d4e5f-FRA",
  });

  const fast = scripted([0, 10, 20, 30, 40, 50, SLOW_COMMAND_LOG_MS - 1]);
  fast.attempt();
  for (const mark of ["plan_start", "plan_end", "grant_start", "grant_end", "body_end", "end"] as const) fast.mark(mark);
  assert.equal(slowCommandLine({ commandKind: "post_signal", timer: fast, status: 200, cfRay: null }), null);
});

test("a phase the request never reached is null; a retry restarts the inner marks", () => {
  const refused = scripted([0, 1900]);
  refused.attempt();
  refused.mark("end");
  const line = JSON.parse(slowCommandLine({ commandKind: "add_reaction", timer: refused, status: 403, cfRay: null })!);
  assert.deepEqual(line.phase_ms, { auth: null, plan_lock: null, grant: null, body: null, commit: null });

  const retried = scripted([0, 100, 200, 300, 400, 2000, 2100, 2200]);
  retried.attempt();
  retried.mark("plan_start"); retried.mark("plan_end");
  retried.attempt();
  retried.mark("plan_start"); retried.mark("plan_end"); retried.mark("body_end"); retried.mark("end");
  const again = JSON.parse(slowCommandLine({ commandKind: "post_signal", timer: retried, status: 200, cfRay: null })!);
  assert.equal(again.attempts, 2);
  assert.deepEqual(again.phase_ms, { auth: 300, plan_lock: 100, grant: null, body: 1600, commit: 100 });
});

test("nothing sensitive reaches the line: odd kinds and CF-Rays are dropped, and only fixed keys appear", () => {
  assert.equal(cfRayOf("8e3f0a1b2c3d4e5f-FRA"), "8e3f0a1b2c3d4e5f-FRA");
  for (const bad of [null, "", "Bearer swm_agt_secret", "8e3f0a1b2c3d4e5f-FRA\nx", "not-a-ray"]) assert.equal(cfRayOf(bad), null);
  const timer = scripted([0, 5000]);
  timer.mark("end");
  const line = JSON.parse(slowCommandLine({ commandKind: "post_signal\"; token=swm_agt_x", timer, status: 500, cfRay: null })!);
  assert.equal(line.command_kind, "unknown");
  assert.deepEqual(Object.keys(line).sort(),
    ["attempts", "cf_ray", "command_kind", "event", "phase_ms", "status", "stream_locked", "total_ms"]);
});
