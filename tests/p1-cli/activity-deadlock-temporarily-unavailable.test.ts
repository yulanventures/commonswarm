import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import postgres from "postgres";
import * as failures from "../../supabase/functions/command/failures.js";

// HezLead ruling 30 (1), option (i): the activity edge (POST /functions/v1/activity) answers a
// transaction that lost a deadlock (SQLSTATE 40P01) with the EXISTING 503
// {"error":"temporarily_unavailable"} bytes of the command function. Only 40P01 moves. A lock
// timeout (55P03), a serialization failure (40001) and every other failure keep the activity
// edge's 500 {"error":"internal_error"}. Classified by code, never by message.
//
// The thrown value is the driver's own error class with the fields postgres.js 3.4.9 parses from a
// PostgreSQL 17 ErrorResponse (connection.js errorFields; field set measured on a real 40P01).
const DriverError = postgres.PostgresError as unknown as new (fields: Record<string, string>) => Error;
const serverError = (code: string, message: string) => new DriverError({
  severity_local: "ERROR",
  severity: "ERROR",
  code,
  message,
  detail: "Process 101 waits for ShareLock on transaction 202; blocked by process 303.",
  hint: "See server log for query details.",
  where: "while locking tuple (0,1) in relation \"agent_tokens\"",
  file: "deadlock.c",
  line: "1135",
  routine: "DeadLockReport",
});

/** The activity catch: activityFailureResult(error), then json(status, body). */
function activityFailure(error: unknown) {
  assert.equal(typeof failures.activityFailureResult, "function", "failures.ts exports the activity mapping");
  const result = failures.activityFailureResult(error);
  return { status: result.status, body: JSON.stringify(result.body) };
}

test("activity: SQLSTATE 40P01 returns the command function's 503 bytes; 55P03, 40001 and a generic error keep the 500", async () => {
  const deadlock = serverError("40P01", "deadlock detected");
  assert.ok(deadlock instanceof postgres.PostgresError);
  assert.equal(failures.dbCode(deadlock), "40P01");

  // The existing bytes: what the command function answers for a rolled-back lock failure.
  const lockTimeout = serverError("55P03", "canceling statement due to lock timeout");
  const command = await failures.finishCommandFailure(failures.durableCommandFailure({
    commandKind: "post_signal",
    reason: failures.classifyCommandFailure(false, failures.dbCode(lockTimeout)),
    code: failures.dbCode(lockTimeout),
    error: lockTimeout,
    requestId: "11111111-2222-4333-8444-555555555555",
  }), async () => {});
  const unavailable = { status: 503, body: '{"error":"temporarily_unavailable"}' };
  const internal = { status: 500, body: '{"error":"internal_error"}' };
  assert.deepEqual({ status: command.status, body: JSON.stringify(command.body) }, unavailable);

  assert.deepEqual(activityFailure(deadlock), unavailable);
  // By code, never by message: the same code under another message is still a deadlock.
  assert.deepEqual(activityFailure(serverError("40P01", "lock timeout")), unavailable);
  // Unlike the command function, a 55P03 on the activity edge keeps its 500 (ruling 30: only 40P01 moves).
  assert.deepEqual(activityFailure(lockTimeout), internal);
  assert.deepEqual(activityFailure(serverError("40001", "could not serialize access due to concurrent update")), internal);
  assert.deepEqual(activityFailure(new Error("deadlock detected")), internal);
  assert.deepEqual(activityFailure("40P01"), internal);
  assert.deepEqual(activityFailure(null), internal);
});

test("activity: the edge catch passes the thrown error to the mapping and keeps its log line and headers", () => {
  const source = readFileSync(join(process.cwd(), "supabase/functions/activity/index.ts"), "utf8");
  const serve = source.slice(source.lastIndexOf("Deno.serve("));
  const pins: [RegExp, string, boolean][] = [
    [/^import \{ activityFailureResult \} from "\.\.\/command\/failures\.ts";$/mu, "imports the mapping", true],
    [/handle\(request\)\.catch\(\(error\) => \{/u, "the catch takes the thrown error", true],
    [/console\.error\("activity publish failed"\);/u, "the log line is unchanged", true],
    [/const failure = activityFailureResult\(error\);\s+return json\(failure\.status, failure\.body\);/u, "the catch answers with the mapping", true],
    [/json\(500/u, "no fixed 500 is left in the catch", false],
  ];
  for (const [pattern, name, present] of pins) {
    assert.equal(pattern.test(pattern.flags.includes("m") ? source : serve), present, name);
  }
  // json() is unchanged: the 503 carries the activity edge's own two headers, no new one.
  assert.ok(/"content-type": "application\/json; charset=utf-8",\s+"cache-control": "no-store",\s+\},/u.test(source), "json() headers");
});
