/** HezLead ruling 38 item 4: a fence deadlock aborts the WHOLE renewal, with
 * one post-rollback diagnostic. Same-command_id recovery and real-read handover
 * are separate contracts. CI only: use the existing verified, isolated CLI DB.
 * The pre-fix catch commits refusal/audit/events/ledger writes; this test fails.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { enableIssuanceForTest, measureIssuanceForTest, recordChecksumEvidenceForTest } from "../support/admin-schema-db.js";

interface Target { url: string; mode: string; close(): Promise<void> }
interface TargetHarness {
  ACTIVE_FLOOR_SOURCES: Record<"H" | "F" | "B", {commit: string; tree: string}>;
  openLockOrderTarget(options: { connector: unknown }): Promise<Target>;
  lockOrderConnector(issuance: { record: string; measure: string; enable: string }, options?: { includeRealtime: boolean }): unknown;
  materializeActiveFloorSource(directory: string, generation: "current" | "H" | "F" | "B"): {path: string; commit: string; tree: string};
}
const harness = await import(new URL("../support/admin-principal-lock-order-harness.mjs", import.meta.url).href) as TargetHarness;
const repo = fileURLToPath(new URL("../../", import.meta.url));

// Existing seeded storage/fault contracts retain their narrower claim: these
// cases do not prove human admission, consent or AS issuance.
const completedRenewalCases=new Set<string>();
for(const [generation,readGeneration] of [['current','current'],['H','H'],['F','H'],['H','F'],['F','current'],['current','F'],['F','F']] as const)
for(const mode of ['real_read','permanence'] as const) test(`renewal ${mode}: rollback, retry and credential continuity${generation==='current' && readGeneration==='current' ? '' : ` exact ${generation}/${readGeneration}`}`, { timeout: 300_000 }, async () => {
  const target = await harness.openLockOrderTarget({ connector: harness.lockOrderConnector({
    record: recordChecksumEvidenceForTest, measure: measureIssuanceForTest, enable: enableIssuanceForTest,
  }, { includeRealtime: mode === "permanence" }) });
  const root = realpathSync(process.platform === "darwin" ? "/private/tmp" : tmpdir());
  let directory: string | undefined;
  try {
    assert.equal(target.mode, "ci", "renewal regression requires the isolated CI database");
    directory = mkdtempSync(join(root, "anvil-secret."));
    chmodSync(directory, 0o700);
    const source = harness.materializeActiveFloorSource(directory, generation);
    const readSource = readGeneration === generation ? source : harness.materializeActiveFloorSource(directory, readGeneration);
    const baseline = mode === "permanence" && generation === "current" && readGeneration === "current"
      ? harness.materializeActiveFloorSource(directory, "B") : null;
    const config = join(directory, "target.json");
    writeFileSync(config, JSON.stringify({ db_url: target.url, source, read_source: readSource, unused_root_baseline: baseline, active_floor: baseline!==null || generation==='F' || readGeneration==='F' }), { mode: 0o600 });
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, NO_COLOR: "1" };
    // Deterministic fault control belongs only to its existing rollback contract.
    if (mode === "real_read") env.SWARM_CMD_TEST_SLEEP_AFTER_STEP = "9:2500";
    for (const key of ["HOME", "DENO_DIR", "XDG_CACHE_HOME"]) if (process.env[key]) env[key] = process.env[key];
    const child = spawn("deno", ["run", "--no-lock", "--config", join(repo, "supabase/functions/command/deno.json"),
      "--allow-read", "--allow-env", "--allow-net", join(repo, "tests/support/renewal-savepoint-rollback-harness.mjs"),
      source.path, mode, "", config], { cwd: repo, env, stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 250_000);
      child.on("error", (error) => { clearTimeout(timer); reject(error); });
      child.on("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
    });
    const line = stdout.split("\n").find((entry) => entry.startsWith("R13_PROBE "));
    assert.ok(line, `probe did not report: exit=${exit.code}, signal=${exit.signal}`);
    const result = JSON.parse(line.slice("R13_PROBE ".length)) as {
      stage: string; error?: string; verdict?: string; tables_counted: number; diagnostics?: unknown; failure_diagnostic?: unknown;
      source?: {commit: string; tree: string} | null;
      read_source?: {commit: string; tree: string} | null;
      hook_sleep?: string | null;
      unused_root_baseline?: {commit: string; tree: string} | null;
      active_catalog?: {functions:number;migrations:number;view_columns:number;measured_view_sha256:string};
      checks?: { name: string; ok: boolean }[];
      contract_diagnostics?: unknown;
    };
    process.stdout.write(`ACTIVE_FLOOR_RENEWAL_SOURCE ${JSON.stringify({generation,readGeneration,mode,source:result.source,read_source:result.read_source})}\n`);
    if(mode==='permanence') process.stdout.write(`R8_CONTRACT_DIAGNOSTIC ${JSON.stringify({generation,readGeneration,
      contracts:result.contract_diagnostics ?? null,failure:result.failure_diagnostic ?? null})}\n`);
    if(mode==='real_read' || result.stage!=='complete') process.stdout.write(`R18_DIAGNOSTIC ${JSON.stringify({generation,readGeneration,mode,diagnostics:result.diagnostics ?? null,failure:result.failure_diagnostic ?? null})}\n`);
    if (mode === "permanence") assert.equal(result.hook_sleep, null, "permanence runs without fault hooks");
    assert.equal(exit.signal, null, "a signalled child cannot supply proof");
    assert.equal(result.stage, "complete", `probe stopped at ${result.stage}: ${result.error ?? "unknown"}`);
    assert.ok(result.tables_counted > 0, "enumerated full database table set");
    assert.deepEqual(result.checks?.filter((check) => !check.ok), [], "owner-boundary contracts failed");
    if (baseline) {
      assert.deepEqual(result.unused_root_baseline, harness.ACTIVE_FLOOR_SOURCES.B);
      assert.equal(result.active_catalog?.migrations, 5, 'b9 witness uses the same valid ACTIVE schema');
      for (const name of ['b9 used standing proof renews to readable successor',
        'b9 virgin standing root denies for authentication', 'b9 virgin denial leaves every table unchanged'])
        assert.ok(result.checks?.some(check => check.name === name && check.ok), name);
    }
    if(mode==='permanence') {
      for(const policy of ['permanent','future-date','older-resume'])
        for(const proof of ['live-positive','read-denied','renewal-denied','no-write','owner-resume-audited','owner-resume-read-positive','owner-resume-renewal-positive']) {
          const name=`security-${policy}-${proof}`;
          assert.ok(result.checks?.some(check=>check.name===name && check.ok),name);
        }
      for(const name of ['security-model-live-positive','security-model-projections-deny',
        'security-model-projections-no-write','security-model-read-denied','security-model-no-write'])
        assert.ok(result.checks?.some(check=>check.name===name && check.ok),name);

      for(const contract of ['command denial rolls back both adoptions and every table','activity denial rolls back both adoptions and every table',
        'ordinary-timeboxed-live-positive','ordinary-expired-unused-refused','ordinary-expired-unused-full-denial-rollback'])
        assert.ok(result.checks?.some(check=>check.name===contract && check.ok),contract);
      for(const name of ['unused-root real renewal commits genuine use and one child',
        'unused-root ordinary expired read denies without use','unused-root ordinary expired read still denies after recovery',
        'unused-root NULL binding and future date renew','converted unused permanent NULL-bound root renews',
        'unused-root concurrent recovery never forks','unused-root date crossing adoption wait rolls back stamp',
        'unused-root issuance failure retains truthful use without child','unused-root same ID resumes after committed use',
        'unused-root lost reply replaces pending child without secret replay','unused-root resumed successor authenticates','unused-root used successor prevents root secret replay',
        'unused-root admission starts unused expired and bound',
        'unused-root concurrency owned grant wait','unused-root concurrency distinct PID waits on first recovery',
        'unused-root concurrent live successor authenticates','unused-root concurrent used successor wins',
        'decided rejection fixture has a genuine unused successor','decided rejection waits at its real final ledger write',
        'unused-root-session-missing','unused-root-session-wrong-key','unused-root-session-valid',
        'unused-root discovery change owned workspace wait','unused-root discovery change retries whole transaction',
        'unused-root removal owned membership wait','unused-root removal wins without effects',
        'converted unused permanent home-and-queue live','converted unused future-date home-and-queue live',
        'converted read projections do not authorize or stamp bearer'])
        assert.ok(result.checks?.some(check=>check.name===name && check.ok), `${name}: actual DB proof required`);

      for(const variant of ['wrong-device-owner','wrong-creator','wrong-family'])
        assert.ok(result.checks?.some(check=>check.name===`unused-root-${variant}-denied-without-effects` && check.ok),
          `${variant}: unused-root authority denial required`);
      for(const slot of ['token','principal']) for(const policy of ['live','expired','withdrawn','scope'])
        assert.ok(result.checks?.some(check=>check.name===`unused-root-parent-${slot}-${policy}` && check.ok),
          `${slot}/${policy}: real parent gate required`);
      for(const variant of ['live-bootstrap','expired-unused','expired-used','pending','retired-history','predecessor-tombstone','elapsed','revoked','mismatched-device','unused-unbound','unused-future-bound','unused-future-unbound','unused-terminal','unused-elapsed','unused-timeboxed','unused-no-family','unused-wrong-creator','unused-foreign-device','unused-wrong-family','unused-token-tombstone','unused-family-tombstone']) {
        if(['unused-wrong-creator','unused-foreign-device','unused-wrong-family'].includes(variant))
          for(const proof of ['queue-generic-refusal','queue-no-write','queue-no-diagnostic'])
            assert.ok(result.checks?.some(check=>check.name===`current-proof-${variant}-${proof}` && check.ok),
              `${variant}: binding refusal requires the exact generation outcome, no access/success and no write, including diagnostics`);
        if(variant.startsWith('unused-') || ['expired-unused','mismatched-device'].includes(variant))
          assert.ok(result.checks?.some(check=>check.name===`current-proof-${variant}-virgin` && check.ok),
            `${variant}: expired virgin root must remain unused after read projection`);
        assert.ok(result.checks?.some(check=>check.name===`current-proof-${variant}-binding` && check.ok), `${variant}: retained device binding required`);
        assert.ok(result.checks?.some(check=>check.name===`current-proof-${variant}-home-and-queue` && check.ok),
          `${variant}: both public read boundaries must return the expected connection truth`);
      }
    }
    assert.equal(result.verdict, "PASS");
    assert.equal(exit.code, 0);
    completedRenewalCases.add(`${generation}/${readGeneration}/${mode}`);
  } finally {
    if (directory) {
      const resolved = realpathSync(directory);
      assert.equal(dirname(resolved), root);
      assert.ok(basename(resolved).startsWith("anvil-secret."));
      assert.notEqual(resolved, process.env.HOME);
      execFileSync("rm", ["-r", resolved]);
    }
    await target.close();
  }
});

// A filtered or inconclusive child never counts as required F evidence.
test('active-floor-required-F-renewal-complete',()=>{
  for(const [command,read] of [['current','current'],['H','H'],['F','H'],['H','F'],['F','current'],['current','F'],['F','F']])
    for(const mode of ['real_read','permanence'])
      assert.ok(completedRenewalCases.has(`${command}/${read}/${mode}`),`required renewal ${command}/${read}/${mode} did not complete`);
  assert.equal(completedRenewalCases.size,14);
});
