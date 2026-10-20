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
  openLockOrderTarget(options: { connector: unknown }): Promise<Target>;
  lockOrderConnector(issuance: { record: string; measure: string; enable: string }): unknown;
}
const harness = await import(new URL("../support/admin-principal-lock-order-harness.mjs", import.meta.url).href) as TargetHarness;
const repo = fileURLToPath(new URL("../../", import.meta.url));

for(const mode of ['real_read','permanence'] as const) test(`renewal ${mode}: rollback, retry and credential continuity`, { timeout: 300_000 }, async () => {
  const target = await harness.openLockOrderTarget({ connector: harness.lockOrderConnector({
    record: recordChecksumEvidenceForTest, measure: measureIssuanceForTest, enable: enableIssuanceForTest,
  }) });
  const root = realpathSync(process.platform === "darwin" ? "/private/tmp" : tmpdir());
  let directory: string | undefined;
  try {
    assert.equal(target.mode, "ci", "renewal regression requires the isolated CI database");
    directory = mkdtempSync(join(root, "anvil-secret."));
    chmodSync(directory, 0o700);
    const config = join(directory, "target.json");
    writeFileSync(config, JSON.stringify({ db_url: target.url }), { mode: 0o600 });
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, NO_COLOR: "1", SWARM_CMD_TEST_SLEEP_AFTER_STEP: "9:2500" };
    for (const key of ["HOME", "DENO_DIR", "XDG_CACHE_HOME"]) if (process.env[key]) env[key] = process.env[key];
    const child = spawn("deno", ["run", "--no-lock", "--config", join(repo, "supabase/functions/command/deno.json"),
      "--allow-read", "--allow-env", "--allow-net", join(repo, "tests/support/renewal-savepoint-rollback-harness.mjs"),
      repo, mode, "", config], { cwd: repo, env, stdio: ["ignore", "pipe", "ignore"] });
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
      stage: string; error?: string; verdict?: string; tables_counted: number;
      checks?: { name: string; ok: boolean }[];
    };
    assert.equal(result.stage, "complete", `probe stopped at ${result.stage}: ${result.error ?? "unknown"}`);
    assert.ok(result.tables_counted > 0, "enumerated full database table set");
    assert.deepEqual(result.checks?.filter((check) => !check.ok), [], "owner-boundary contracts failed");
    if(mode==='permanence') {
      for(const name of ['unused-root real renewal commits genuine use and one child',
        'unused-root ordinary expired read denies without use','unused-root ordinary expired read still denies after recovery',
        'unused-root NULL binding and future date renew','converted unused permanent NULL-bound root renews',
        'unused-root concurrent recovery never forks','unused-root date crossing adoption wait rolls back stamp',
        'unused-root issuance failure retains truthful use without child','unused-root same ID resumes after committed use',
        'unused-root lost-reply replay exposes no second secret'])
        assert.ok(result.checks?.some(check=>check.name===name && check.ok), `${name}: actual DB proof required`);

      for(const variant of ['live-bootstrap','expired-unused','expired-used','pending','retired-history','predecessor-tombstone','elapsed','revoked','mismatched-device'])
        assert.ok(result.checks?.some(check=>check.name===`current-proof-${variant}-home-and-queue` && check.ok),
          `${variant}: both public read boundaries must return the expected connection truth`);
    }
    assert.equal(result.verdict, "PASS");
    assert.equal(exit.code, 0);
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
