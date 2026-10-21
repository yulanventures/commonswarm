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
  checks?: {name:string;ok:boolean}[];
  source?: {commit:string;tree:string};
  read_source?: {commit:string;tree:string};
  historical_completed?: string[];
  fixture_label?: string;
  fixture_digest?: string;
  baseline?: RaceResult;
  current?: RaceResult;
  active_catalog?: {functions:number;migrations:number;view_columns:number;measured_view_sha256:string};
  canonical_witness?: {first_pid:number;second_pid:number;gate_pid:number;token_ids:string[];order:string};
  floor_compatibility?: string;
  required_compatibility?: string;
  race_witness?: {allow_pid:number;issuer_pid:number;workspace_id:string;parent_id:string;sqlstates:string[];deadlock_edges:number[][][]};
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
  HISTORICAL_BASELINE_SOURCE: {commit:string;tree:string};
  ACTIVE_FLOOR_SOURCES: {F:{commit:string;tree:string}};
  openLockOrderTarget(options: { connector: unknown }): Promise<Target>;
  lockOrderConnector(issuance: { record: string; measure: string; enable: string }): unknown;
  runScenario(target: Target, scenario: string, timeoutMs?: number, generations?: {command:string;read:string}): Promise<RaceResult>;
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

const POSITIVE_CONTROL = "positive-control-raw-sql-base-order-deadlocks";
test(POSITIVE_CONTROL, { timeout: 120_000 }, async () => {
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
      holder_waits_on_creation_workspace_or_stream: true,
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
    second_admin_waits_on_complete_plan: true,
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
const ADMIN_CROSS_RACES: Record<string, { writes: Record<string, boolean>; admin_audit: string[]; raceClass?: "regression-guard" }> = {
  "admin-oauth-create-existing-workspace-crossed": {
    writes: { first_target_unchanged: true, second_target_unchanged: true }, admin_audit: ["refused", "refused"],
  },
  "admin-oauth-read-outside-grant-vs-admin-oauth-routine": {
    raceClass: "regression-guard",
    writes: { second_admin_principal_live: true }, admin_audit: ["refused", "committed"],
  },
  "admin-oauth-grant-admin-delegation-vs-admin-oauth-routine": {
    raceClass: "regression-guard",
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
      second_admin_waits_on_complete_plan: true,
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

/** HezLead ruling 40: X2's single class map for both GATES.json arrays. Regression guards
 * PASS at T and head; CI evidence run 38086941694 caught their intermediate-order deadlocks.
 * The raw SQL positive control stays PASS at both variants with exactly one 40P01. */
export const X2_RACE_CLASSES: Readonly<Record<string, "positive-control" | "base-cycle" | "regression-guard">> = Object.freeze({
  [POSITIVE_CONTROL]: "positive-control",
  ...Object.fromEntries([...RACE_TESTS, ADMIN_PAIR].map(name => [name, "base-cycle"])),
  ...Object.fromEntries(Object.entries(ADMIN_CROSS_RACES).map(([name, expected]) => [name, expected.raceClass ?? "base-cycle"])),
  [ADMIN_WITHDRAW]: "base-cycle",
});

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

const ALLOW_ISSUER_CONTRACTS = ["legal-parentless-principal-token-parent", "real-retired-token-active-parent",
        "issuer-real-session-and-set-only-roles", "real-issuer-lifecycle-committed", "real-dpop-replay-refused",
        "same-owner-unrelated-workspace-progress", "rollback-restores-issuer-account-events-audit-ledger",
        "foreign-token-no-foreign-owner-lock", "wrong-workspace-normal-refusal", "all-denials-no-revival"] as const;

// These reach actual delegated HTTP admission and protected worker delivery.
// Existing X2 tests create principals, but never issue/renew a bounded worker
// credential. These cases protect parent ordering, budget, and rollback at that
// distinct production boundary, with a live control in every invocation.
for (const name of ["delegated-local-permanent-suspension","delegated-local-revocation-closure","delegated-local-selector-compatibility","delegated-local-parent-reversal","delegated-local-renewal-budget",
  "delegated-local-parent-deadline","delegated-local-parent-narrowing",
  "delegated-local-wait-removal-rollback","ordinary-local-compat-policy",
  "local-resume-parent-order","local-resume-recovery-controls",
  "local-allow-retired-parent-allow-first","local-allow-retired-parent-issuer-first",
  "hosted-owner-removal-prefix","floor-first-use-vs-head-revocation"]) {
  test(name,{timeout:300_000},async()=>{
    const result=await harness.runScenario(bound(),name,270_000);
    assert.equal(result.stage,"complete",`${name}: ${result.stage} (${result.error ?? "no code"})`);
    assert.ok(result.checks && result.checks.length>0,"named observable contracts");
    assert.deepEqual(result.checks.filter(c=>!c.ok),[],`${name}: failed contracts`);
    assert.ok(result.checks.some(c=>c.name==="same-invocation-positive" && c.ok),"live admission positive");
    assert.equal(result.http_refused,0,"no unbound HTTP target");
    if (name.startsWith("local-allow-retired-parent-")) {
      assert.ok(result.race_witness, "actual issuer/Allow PID and owned-row witness");
      assert.ok(result.race_witness.allow_pid > 0 && result.race_witness.issuer_pid > 0);
      assert.notEqual(result.race_witness.allow_pid, result.race_witness.issuer_pid);
      assert.deepEqual(result.race_witness.sqlstates, []);
      assert.deepEqual(result.race_witness.deadlock_edges, []);
      for(const contract of ALLOW_ISSUER_CONTRACTS) assert.ok(result.checks.some(check=>check.name===contract && check.ok),contract);
    }
    if (name === "floor-first-use-vs-head-revocation") {
      // This name remains the exact legacy-O diagnostic. It cannot certify F.
      assert.equal(result.floor_compatibility,"INCOMPATIBLE", "legacy O must exhibit the identified owned-row cycle");
      assert.equal(result.required_compatibility,"BLOCKED", "an O diagnosis cannot satisfy the separate F admission gate");
    }
  });
}


// Generation rows extend existing owners; none supplies auth, a receipt, or
// an outcome. F is integrated rollback; current loads immutable integrated H3.
const completedFloorCases=new Set<string>();
for(const [command,read] of [['current','current'],['F','current'],['current','F'],['F','F']]) {
  for(const order of ['use-first','revoke-first']) {
    const name=`active-floor-canonical-${order}`;
    test(`${name} exact ${command}/${read}`,{timeout:300_000},async()=>{
      const result=await harness.runScenario(bound(),name,270_000,{command,read});
      assert.equal(result.stage,'complete',`${result.stage}: ${result.error ?? 'inconclusive'}`);
      assert.equal(result.active_catalog?.migrations,4);
      assert.equal(result.active_catalog?.view_columns,11);
      assert.match(result.active_catalog?.measured_view_sha256 ?? '',/^[a-f0-9]{64}$/);
      process.stdout.write(`ACTIVE_FLOOR_CATALOG ${JSON.stringify({command,read,...result.active_catalog})}\n`);
      if(command==='F') assert.deepEqual(result.source,harness.ACTIVE_FLOOR_SOURCES.F);
      if(read==='F') assert.deepEqual(result.read_source,harness.ACTIVE_FLOOR_SOURCES.F);
      assert.ok(result.checks?.some(check=>check.name==='same-invocation-positive' && check.ok));
      assert.ok(result.checks && result.checks.length>=8);
      assert.deepEqual(result.checks.filter(check=>!check.ok),[]);
      assert.deepEqual(result.sqlstates,[]);
      assert.equal(result.http_refused,0);
      assert.ok(result.canonical_witness);
      assert.notEqual(result.canonical_witness.first_pid,result.canonical_witness.second_pid);
      assert.equal(result.canonical_witness.token_ids.length,3);
      assert.equal(result.canonical_witness.order,order);
      for(const contract of ['sequential-denial-every-table-unchanged','terminal-denial-every-table-unchanged',
        ...(order==='revoke-first' ? ['revoke-first-both-adoptions-and-history-unchanged']:[])])
        assert.ok(result.checks.some(check=>check.name===contract && check.ok),contract);
      completedFloorCases.add(`${name}/${command}/${read}`);
    });
  }
  if(command==='current' && read==='current') continue; // current permission owners already run above
  for(const name of ['local-allow-retired-parent-allow-first','local-allow-retired-parent-issuer-first',
    'delegated-local-revocation-closure','delegated-local-renewal-budget','delegated-local-selector-compatibility','delegated-local-parent-deadline','delegated-local-parent-narrowing',
    'delegated-local-wait-removal-rollback','local-resume-parent-order','local-resume-recovery-controls','ordinary-local-compat-policy']) {
    test(`active-floor-${name} exact ${command}/${read}`,{timeout:300_000},async()=>{
      const result=await harness.runScenario(bound(),name,270_000,{command,read});
      assert.equal(result.stage,'complete',`${result.stage}: ${result.error ?? 'inconclusive'}`);
      assert.equal(result.active_catalog?.migrations,4);
      assert.equal(result.active_catalog?.view_columns,11);
      assert.match(result.active_catalog?.measured_view_sha256 ?? '',/^[a-f0-9]{64}$/);
      process.stdout.write(`ACTIVE_FLOOR_CATALOG ${JSON.stringify({command,read,...result.active_catalog})}\n`);
      if(command==='F') assert.deepEqual(result.source,harness.ACTIVE_FLOOR_SOURCES.F);
      if(read==='F') assert.deepEqual(result.read_source,harness.ACTIVE_FLOOR_SOURCES.F);
      assert.ok(result.checks && result.checks.length>0);
      assert.deepEqual(result.checks.filter(check=>!check.ok),[]);
      assert.ok(result.checks.some(check=>check.name==='same-invocation-positive' && check.ok));
      assert.equal(result.http_refused,0);
      if(name.startsWith('local-allow-retired-parent-')) {
        assert.ok(result.race_witness);
        assert.ok(result.race_witness.allow_pid>0 && result.race_witness.issuer_pid>0);
        assert.notEqual(result.race_witness.allow_pid,result.race_witness.issuer_pid);
        assert.deepEqual(result.race_witness.sqlstates,[]);
        assert.deepEqual(result.race_witness.deadlock_edges,[]);
        for(const contract of ALLOW_ISSUER_CONTRACTS) assert.ok(result.checks.some(check=>check.name===contract && check.ok),contract);
      }
      if(name==='ordinary-local-compat-policy') for(const prefix of ['', 'current-wire-'])
        assert.ok(result.checks.some(check=>check.name===`${prefix}renewal-wire-retains-scope-counter-history` && check.ok));
      completedFloorCases.add(`${name}/${command}/${read}`);
    });
  }
}

// Each row receives a fresh INITIAL-history child database; none rewinds shared state.
const completedHistoricalCases=new Set<string>();
for(const [command,read] of [['current','current'],['F','current'],['current','F'],['F','F']]) {
  test(`active-floor-historical-idle exact ${command}/${read}`,{timeout:300_000},async()=>{
    const result=await harness.runScenario(bound(),'active-floor-historical-idle',270_000,{command,read});
    assert.equal(result.stage,'complete',`${result.stage}: ${result.error ?? 'inconclusive'}`);
    assert.equal(result.fixture_label,'synthetic-initial-history');
    assert.equal(result.active_catalog?.migrations,4);
    if(command==='F') assert.deepEqual(result.source,harness.ACTIVE_FLOOR_SOURCES.F);
    if(read==='F') assert.deepEqual(result.read_source,harness.ACTIVE_FLOOR_SOURCES.F);
    assert.equal(result.http_refused,0);
    assert.deepEqual(result.historical_completed,['standing','suspended','horizon-expired','expired-unused']);
    for(const contract of ['same-invocation-positive','coherent-old-credential','expired-read-every-table-unchanged',
      'ordinary-denial-every-table-unchanged','silent-short-successor','successor-read-usable',
      'exact-successor-adoption','grant-history-preserved','guard-probes-rollback-every-table','retained-catalog-after-cases'])
      assert.ok(result.checks?.some(check=>check.name===contract && check.ok),contract);
    assert.deepEqual(result.checks?.filter(check=>!check.ok),[]);
    completedHistoricalCases.add(`${command}/${read}`);
  });
}

let completedHistoricalBaseline=false;
test('historical-baseline-discriminator unsupported O/ACTIVE diagnostic and current/ACTIVE',{timeout:600_000},async()=>{
  const result=await harness.runScenario(bound(),'historical-baseline-discriminator',270_000);
  assert.equal(result.stage,'complete');
  const {baseline,current}=result;
  assert.ok(baseline && current,'both real handler invocations on ACTIVE must return');
  const {commit,tree}=harness.HISTORICAL_BASELINE_SOURCE;
  assert.deepEqual(baseline.source,{commit,tree});
  assert.deepEqual(baseline.read_source,{commit,tree});
  assert.equal(baseline.active_catalog?.migrations,4,'O diagnostic must use real ACTIVE');
  assert.match(baseline.fixture_digest ?? '',/^[a-f0-9]{64}$/);
  assert.equal(current.fixture_digest,baseline.fixture_digest,'identical original credential and history');
  assert.equal(current.active_catalog?.migrations,4);
  for(const row of [baseline,current]) {
    assert.equal(row.stage,'complete');
    assert.equal(row.fixture_label,'synthetic-initial-history');
    assert.equal(row.http_refused,0);
    assert.deepEqual(row.historical_completed,['standing','suspended','horizon-expired','expired-unused']);
    assert.ok(row.checks && row.checks.length>0);
    assert.deepEqual(row.checks.filter(c=>!c.ok),[]);
    for(const name of ['same-invocation-positive','hash-and-live-authority','coherent-old-credential',
      'expired-read-every-table-unchanged','guard-probes-rollback-every-table','retained-catalog-after-cases'])
      assert.ok(row.checks.some(c=>c.name===name && c.ok),name);
  }
  for(const name of ['baseline-live-renewal-positive','baseline-expiry-refusal','baseline-denial-every-table-unchanged'])
    assert.ok(baseline.checks?.some(c=>c.name===name && c.ok),name);
  for(const name of ['silent-short-successor','successor-read-usable','exact-successor-adoption','grant-history-preserved',
    'ordinary-denial-every-table-unchanged']) assert.ok(current.checks?.some(c=>c.name===name && c.ok),name);
  completedHistoricalBaseline=true;
});

// Count only successfully executed cases; source registration cannot make this green.
// Renewal's independent required gate lives with its own real transaction tests;
// the genuine GoTrue/issuer owners and full AS suite remain separate gates.
test('active-floor-required-F-support-complete',()=>{
  for(const [command,read] of [['current','current'],['F','current'],['current','F'],['F','F']])
    for(const order of ['use-first','revoke-first'])
      assert.ok(completedFloorCases.has(`active-floor-canonical-${order}/${command}/${read}`),'required canonical case did not complete');
  assert.equal(completedFloorCases.size,41,'all 8 canonical and 33 existing permission/issuer cases must execute successfully');
  assert.equal(completedHistoricalCases.size,4,'all historical generation rows must execute successfully');
  assert.equal(completedHistoricalBaseline,true,'unsupported O/ACTIVE expiry diagnostic and same-history current renewal must both complete');
  // Exact F includes virgin-root recovery. Source rebinding does not replace
  // different-family review, real Linux execution or full AS.
});
