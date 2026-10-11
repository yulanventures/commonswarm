import assert from "node:assert/strict";
import { test } from "node:test";
import postgres from "postgres";
import {
  classifyCommandFailure,
  dbCode,
  durableCommandFailure,
  finishCommandFailure,
  type DurableCommandFailure,
} from "../../supabase/functions/command/failures.js";

// HezLead ruling 27 (1)(a), FOLLOW-UPS-C1 #42-TS: a command transaction that loses a deadlock
// (SQLSTATE 40P01) rolled back in full, so the command function returns the EXISTING 503
// temporarily_unavailable bytes, the same as a lock timeout (55P03). The durable row keeps
// db_code '40P01' so the deadlocks stay countable by command. Classified by code, never by message.
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
const REQUEST_ID = "11111111-2222-4333-8444-555555555555";

/** The handlePostRequest catch, in order: code, classification, durable row, response. */
async function commandFailure(error: unknown, rows: DurableCommandFailure[]) {
  const code = dbCode(error);
  const failure = durableCommandFailure({
    commandKind: "post_signal",
    reason: classifyCommandFailure(false, code), // none of these is the test hook's TestRollback
    code,
    error,
    requestId: REQUEST_ID,
  });
  const result = await finishCommandFailure(failure, async (row) => {
    rows.push(row);
  });
  // index.ts json(result.status, result.body): the status and the exact body bytes.
  return { status: result.status, body: JSON.stringify(result.body) };
}

test("SQLSTATE 40P01 returns the existing 503 temporarily_unavailable bytes; 55P03, 40001 and a generic error keep theirs", async () => {
  const deadlock = serverError("40P01", "deadlock detected");
  assert.ok(deadlock instanceof postgres.PostgresError);
  assert.equal(dbCode(deadlock), "40P01");

  const rows: DurableCommandFailure[] = [];
  const unavailable = { status: 503, body: '{"error":"temporarily_unavailable"}' };
  const internal = { status: 500, body: '{"error":"internal_error"}' };

  assert.deepEqual(await commandFailure(deadlock, rows), unavailable);
  // By code, never by message: the same code under another message is still a deadlock.
  assert.deepEqual(await commandFailure(serverError("40P01", "lock timeout"), rows), unavailable);
  assert.deepEqual(await commandFailure(serverError("55P03", "canceling statement due to lock timeout"), rows), unavailable);
  assert.deepEqual(await commandFailure(serverError("40001", "could not serialize access due to concurrent update"), rows), internal);
  assert.deepEqual(await commandFailure(new Error("deadlock detected"), rows), internal);

  // One durable row per failure, under the existing CHECK (internal_error, lock_timeout, test_rollback).
  assert.deepEqual(rows.map(({ command_kind, reason, db_code }) => ({ command_kind, reason, db_code })), [
    { command_kind: "post_signal", reason: "lock_timeout", db_code: "40P01" },
    { command_kind: "post_signal", reason: "lock_timeout", db_code: "40P01" },
    { command_kind: "post_signal", reason: "lock_timeout", db_code: "55P03" },
    { command_kind: "post_signal", reason: "internal_error", db_code: "40001" },
    { command_kind: "post_signal", reason: "internal_error", db_code: null },
  ]);
  for (const row of rows) {
    assert.ok(["internal_error", "lock_timeout", "test_rollback"].includes(row.reason));
    assert.equal(row.request_id, REQUEST_ID);
  }
  // The weekly count (ruling 27 (1)(c)) reads db_code, so a deadlock never hides among lock timeouts.
  assert.equal(rows.filter((row) => row.db_code === "40P01").length, 2);
});
