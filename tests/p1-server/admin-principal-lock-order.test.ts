/** X2 (FOLLOW-UPS-C1 #33, #35; HezLead ruling 4): one coordinated lock order across admin,
 * hosted and local principal creation and the #35 sibling paths. Server suite and the
 * staging fixture only: it needs Docker and a stack reached through the verified binding
 * (C1B_LOCK_ORDER_BINDING, or the CLI project binding under GitHub Actions). A fixture is a
 * restored, non-empty database: every scenario creates its own run-unique rows and asserts
 * only on them; the admin races also need admin issuance open (LANE-2-DELTA D4).
 *
 * Each race parks a creation path after its workspace-stream lock on the principal-ceiling
 * advisory lock (supabase/functions/command/index.ts:5914) with a blocker session, waits with
 * pg_blocking_pids until the lock-holding path waits for that stream, then releases the
 * blocker. The base order deadlocks (SQLSTATE 40P01); the coordinated order does not.
 * The admin-vs-admin race parks both admins on a workspace row that a blocker holds FOR SHARE.
 * The three crossed admin races (round 6) park two admins whose workspace locks cross; the
 * withdraw race (round 6) holds two owners' own users rows at a barrier.
 * Deadlock is detected by SQLSTATE only. */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { enableIssuanceForTest, measureIssuanceForTest, recordChecksumEvidenceForTest } from "../support/admin-schema-db.js";

interface Target { url: string; mode: string; close(): Promise<void> }
interface SideOutcome { side: string; ok: boolean; status?: number; body_status?: string | null; error?: string | null; thrown?: string }
interface RaceResult {
  scenario: string;
  stage: string;
  error?: string;
  sqlstate_capture_control?: string;
  deadlock_timeout_ms?: number;
  lock_timeout_ms?: number;
  parking?: Record<string, boolean>;
  parked?: SideOutcome;
  waiting?: SideOutcome;
  sqlstates?: string[];
  writes?: Record<string, boolean>;
  admin_audit?: string[];
  admin_issuance?: string;
  second_admin_blocked_by?: string;
  http_refused?: number;
}
interface ControlResult {
  stage: string;
  error?: string;
  deadlock_timeout_ms?: number;
  lock_timeout_ms?: number;
  holder_waits_on_stream?: boolean;
  sqlstates?: string[];
}
interface Harness {
  openLockOrderTarget(options: { connector: unknown }): Promise<Target>;
  lockOrderConnector(issuance: { record: string; measure: string; enable: string }): unknown;
  runScenario(target: Target, scenario: string): Promise<RaceResult>;
  rawSqlPositiveControl(target: Target): Promise<ControlResult>;
  migrationTreeLine(): string;
}
const harness = await import(new URL("../support/admin-principal-lock-order-harness.mjs", import.meta.url).href) as Harness;

// LANE-2-DELTA D3: one line per run, before the first test, read into the receipt's migration_sha.
process.stdout.write(`${harness.migrationTreeLine()}\n`);

let target: Target | undefined;
before(async () => {
  target = await harness.openLockOrderTarget({ connector: harness.lockOrderConnector({
    record: recordChecksumEvidenceForTest, measure: measureIssuanceForTest, enable: enableIssuanceForTest,
  }) });
}, { timeout: 180_000 });
after(async () => {
  await target?.close();
});

function bound(): Target {
  assert.ok(target, "the verified target was not opened");
  return target;
}

test("positive-control-raw-sql-base-order-deadlocks", { timeout: 120_000 }, async () => {
  const result = await harness.rawSqlPositiveControl(bound());
  assert.equal(result.stage, "complete", `control stopped at ${result.stage} (${result.error ?? "no SQLSTATE"})`);
  assert.equal(result.holder_waits_on_stream, true, "the row holder must wait for the stream before the insert");
  assert.ok(result.deadlock_timeout_ms! < result.lock_timeout_ms!, "deadlock detection must precede the lock timeout");
  assert.deepEqual(result.sqlstates, ["40P01"], "the base lock order must fail with SQLSTATE 40P01 in exactly one session");
});

const EXPECTED_WRITES: Record<string, Record<string, boolean>> = {
  admin: { creation_principal_live: true, admin_principal_live: true },
  accept: { creation_principal_live: true, invitee_membership_live: true },
  remove: { creation_principal_live: true, removed_membership_revoked: true },
  household: { creation_principal_live: true },
};

// These names are copied into GATES.json (Lane 1); keep them byte-identical to the brief.
const RACE_TESTS = [
  "admin-oauth-vs-hosted-claim-seat",
  "admin-oauth-vs-local-join-registration",
  "admin-oauth-vs-local-command-creation",
  "accept-invitation-vs-hosted-claim-seat",
  "accept-invitation-vs-local-join-registration",
  "remove-member-vs-hosted-claim-seat",
  "remove-member-vs-local-join-registration",
  "household-invitation-vs-hosted-claim-seat",
  "household-invitation-vs-local-join-registration",
] as const;

for (const name of RACE_TESTS) {
  test(name, { timeout: 240_000 }, async () => {
    const result = await harness.runScenario(bound(), name);
    // Preconditions: the harness reached the interleaving it claims, on both variants.
    assert.equal(result.stage, "complete", `${name}: stopped at ${result.stage} (${result.error ?? "no code"})`);
    assert.equal(result.sqlstate_capture_control, "22012", `${name}: SQLSTATE capture positive control`);
    assert.ok(result.deadlock_timeout_ms! < result.lock_timeout_ms!, `${name}: deadlock_timeout must be below lock_timeout`);
    assert.deepEqual(result.parking, {
      creation_waits_on_ceiling_after_stream: true,
      holder_waits_on_stream_held_by_creation: true,
    }, `${name}: parking points`);
    // The base lock order fails here.
    const sqlstates = result.sqlstates ?? [];
    const deadlocks = sqlstates.filter((code) => code === "40P01").length;
    assert.equal(deadlocks, 0, `${name}: SQLSTATE 40P01 (deadlock_detected) in ${deadlocks} transaction(s)`);
    assert.deepEqual(sqlstates, [], `${name}: no transaction may fail`);
    assert.equal(result.parked?.ok, true, `${name}: ${result.parked?.side} result ${JSON.stringify(result.parked)}`);
    assert.equal(result.waiting?.ok, true, `${name}: ${result.waiting?.side} result ${JSON.stringify(result.waiting)}`);
    assert.deepEqual(result.writes, EXPECTED_WRITES[result.waiting!.side], `${name}: no lost write`);
    if (result.waiting!.side === "admin") {
      // adminAccessState ran (admin-delegation.ts:140) and the delegated request committed.
      assert.deepEqual(result.admin_audit, ["committed"], `${name}: OAuth admin request audit`);
    }
    assert.equal(result.http_refused, 0, `${name}: no HTTP call`);
  });
}

// Review A F1(i) (round 4): two OAuth admins with different owners and issuer kids create a seat
// in one shared workspace. The base order holds SHARE on it and then waits to raise it.
const ADMIN_PAIR = "admin-oauth-vs-admin-oauth-shared-workspace";
test(ADMIN_PAIR, { timeout: 240_000 }, async () => {
  const result = await harness.runScenario(bound(), ADMIN_PAIR);
  assert.equal(result.stage, "complete", `${ADMIN_PAIR}: stopped at ${result.stage} (${result.error ?? "no code"})`);
  assert.equal(result.sqlstate_capture_control, "22012", `${ADMIN_PAIR}: SQLSTATE capture positive control`);
  assert.ok(result.deadlock_timeout_ms! < result.lock_timeout_ms!, `${ADMIN_PAIR}: deadlock_timeout must be below lock_timeout`);
  assert.deepEqual(result.parking, {
    first_admin_waits_on_shared_workspace: true,
    second_admin_waits_on_shared_workspace: true,
  }, `${ADMIN_PAIR}: parking points`);
  // The base lock order fails here.
  const sqlstates = result.sqlstates ?? [];
  const deadlocks = sqlstates.filter((code) => code === "40P01").length;
  assert.equal(deadlocks, 0, `${ADMIN_PAIR}: SQLSTATE 40P01 (deadlock_detected) in ${deadlocks} transaction(s)`);
  assert.deepEqual(sqlstates, [], `${ADMIN_PAIR}: no transaction may fail`);
  assert.equal(result.parked?.ok, true, `${ADMIN_PAIR}: first admin result ${JSON.stringify(result.parked)}`);
  assert.equal(result.waiting?.ok, true, `${ADMIN_PAIR}: second admin result ${JSON.stringify(result.waiting)}`);
  assert.deepEqual(result.writes, { first_admin_principal_live: true, second_admin_principal_live: true }, `${ADMIN_PAIR}: no lost write`);
  // adminAccessState ran for both admins and both delegated requests committed.
  assert.deepEqual(result.admin_audit, ["committed", "committed"], `${ADMIN_PAIR}: OAuth admin request audits`);
  assert.equal(result.http_refused, 0, `${ADMIN_PAIR}: no HTTP call`);
});

// Review B (round 6): two OAuth admins whose workspace locks cross. The base deadlocks on B1 (each
// creates a workspace with the other owner's existing id). B2 (a read outside the grant) and the
// delegated grant_admin_delegation deadlock only after the round-4 pre-lock (b6f5f4b5), not on the base.
const ADMIN_CROSS_RACES: Record<string, { writes: Record<string, boolean>; admin_audit: string[] }> = {
  "admin-oauth-create-existing-workspace-crossed": {
    writes: { first_target_unchanged: true, second_target_unchanged: true }, admin_audit: ["refused", "refused"],
  },
  "admin-oauth-read-outside-grant-vs-admin-oauth-routine": {
    writes: { second_admin_principal_live: true }, admin_audit: ["refused", "committed"],
  },
  "admin-oauth-grant-admin-delegation-vs-admin-oauth-routine": {
    writes: { second_admin_principal_live: true }, admin_audit: ["refused", "committed"],
  },
};
for (const [name, expected] of Object.entries(ADMIN_CROSS_RACES)) {
  test(name, { timeout: 240_000 }, async () => {
    const result = await harness.runScenario(bound(), name);
    assert.equal(result.stage, "complete", `${name}: stopped at ${result.stage} (${result.error ?? "no code"})`);
    assert.equal(result.sqlstate_capture_control, "22012", `${name}: SQLSTATE capture positive control`);
    assert.ok(result.deadlock_timeout_ms! < result.lock_timeout_ms!, `${name}: deadlock_timeout must be below lock_timeout`);
    assert.deepEqual(result.parking, {
      first_admin_waits_on_workspace: true,
      second_admin_waits_on_workspace: true,
    }, `${name}: parking points`);
    const sqlstates = result.sqlstates ?? [];
    const deadlocks = sqlstates.filter((code) => code === "40P01").length;
    assert.equal(deadlocks, 0, `${name}: SQLSTATE 40P01 (deadlock_detected) in ${deadlocks} transaction(s)`);
    assert.deepEqual(sqlstates, [], `${name}: no transaction may fail`);
    // Each side gives its exact result: the unchanged refusal code, or the created seat.
    assert.equal(result.parked?.ok, true, `${name}: first admin result ${JSON.stringify(result.parked)}`);
    assert.equal(result.waiting?.ok, true, `${name}: second admin result ${JSON.stringify(result.waiting)}`);
    assert.deepEqual(result.writes, expected.writes, `${name}: writes`);
    // adminAccessState ran for both admins; each request recorded its outcome.
    assert.deepEqual(result.admin_audit, expected.admin_audit, `${name}: OAuth admin request audits`);
    assert.equal(result.http_refused, 0, `${name}: no HTTP call`);
  });
}

// Round 6 inventory: two owners each withdraw a workspace from the other's grant. The base and
// head''' lock the grantor's users row after the withdrawing owner's own users-row upsert: 40P01.
const ADMIN_WITHDRAW = "admin-human-withdraw-crossed-grants";
test(ADMIN_WITHDRAW, { timeout: 240_000 }, async () => {
  const result = await harness.runScenario(bound(), ADMIN_WITHDRAW);
  assert.equal(result.stage, "complete", `${ADMIN_WITHDRAW}: stopped at ${result.stage} (${result.error ?? "no code"})`);
  assert.equal(result.sqlstate_capture_control, "22012", `${ADMIN_WITHDRAW}: SQLSTATE capture positive control`);
  assert.ok(result.deadlock_timeout_ms! < result.lock_timeout_ms!, `${ADMIN_WITHDRAW}: deadlock_timeout must be below lock_timeout`);
  assert.deepEqual(result.parking, { both_sides_hold_own_users_row: true }, `${ADMIN_WITHDRAW}: parking points`);
  const sqlstates = result.sqlstates ?? [];
  const deadlocks = sqlstates.filter((code) => code === "40P01").length;
  assert.equal(deadlocks, 0, `${ADMIN_WITHDRAW}: SQLSTATE 40P01 (deadlock_detected) in ${deadlocks} transaction(s)`);
  assert.deepEqual(sqlstates, [], `${ADMIN_WITHDRAW}: no transaction may fail`);
  assert.equal(result.parked?.ok, true, `${ADMIN_WITHDRAW}: first owner result ${JSON.stringify(result.parked)}`);
  assert.equal(result.waiting?.ok, true, `${ADMIN_WITHDRAW}: second owner result ${JSON.stringify(result.waiting)}`);
  assert.deepEqual(result.writes, { first_withdrawal_recorded: true, second_withdrawal_recorded: true }, `${ADMIN_WITHDRAW}: writes`);
  assert.equal(result.http_refused, 0, `${ADMIN_WITHDRAW}: no HTTP call`);
});
