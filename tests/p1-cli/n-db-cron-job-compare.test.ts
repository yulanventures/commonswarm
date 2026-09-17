/**
 * Cron restore verification is independent of database collation (N-db box rehearsal).
 *
 * WHY THIS EXISTS. Hosted Postgres sorted '_' before '-' and the box image sorted the other way,
 * so restore-cron-jobs.sh committed five jobs and then `diff -u` of the two listings exited 1.
 * One row (`swarm_purge_file_artifacts`) moved; every field on that row was the same bytes.
 * The original artifact is not rewritten. Reached by `npm test` (named) and `npm run test:p1-cli`
 * (glob). Pure: bash, sort, and diff only.
 */
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const libPath = join(repoRoot, "deploy", "supabase-stack", "migrate", "lib.sh");
const restorePath = join(repoRoot, "deploy", "supabase-stack", "migrate", "restore-cron-jobs.sh");
const verifyPath = join(repoRoot, "deploy", "supabase-stack", "migrate", "verify-counts.sh");

type CronJob = {
  jobname: string;
  schedule: string;
  command: string;
  database: string;
  username: string;
  active: boolean;
};

function line(job: CronJob): string {
  return JSON.stringify({
    jobname: job.jobname,
    schedule: job.schedule,
    command: job.command,
    database: job.database,
    username: job.username,
    active: job.active,
  });
}

function ndjson(lines: string[]): string {
  return `${lines.join("\n")}\n`;
}

function jobName(record: string): string {
  return (JSON.parse(record) as CronJob).jobname;
}

// JS string order matches C for ASCII: '-' (0x2D) before '_' (0x5F).
function hyphenFirst(lines: string[]): string[] {
  return [...lines].sort((left, right) => {
    const a = jobName(left);
    const b = jobName(right);
    if (a < b) return -1;
    if (a > b) return 1;
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

// Source-like: '_' sorts before '-'. Only `swarm_purge_file_artifacts` moves.
function underscoreFirst(lines: string[]): string[] {
  const key = (name: string) => name.replaceAll("_", "\x2c");
  return [...lines].sort((left, right) => {
    const a = key(jobName(left));
    const b = key(jobName(right));
    if (a < b) return -1;
    if (a > b) return 1;
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

const JOBS: CronJob[] = [
  {
    jobname: "swarm-purge-command-failures",
    schedule: "53 3 * * *",
    command: "SELECT swarm.purge_command_failures()",
    database: "postgres",
    username: "postgres",
    active: true,
  },
  {
    jobname: "swarm-purge-idempotency-keys",
    schedule: "17 3 * * *",
    command: "SELECT swarm.purge_expired_idempotency_keys()",
    database: "postgres",
    username: "postgres",
    active: true,
  },
  {
    jobname: "swarm-purge-rate-buckets",
    schedule: "42 * * * *",
    command: "SELECT swarm.purge_expired_rate_buckets()",
    database: "postgres",
    username: "postgres",
    active: true,
  },
  {
    jobname: "swarm-purge-terminal-signal-deliveries",
    schedule: "23 4 * * *",
    command: "SELECT swarm.purge_terminal_signal_deliveries()",
    database: "postgres",
    username: "postgres",
    active: true,
  },
  {
    jobname: "swarm_purge_file_artifacts",
    schedule: "17 * * * *",
    command: "SELECT swarm.purge_file_artifacts()",
    database: "postgres",
    username: "postgres",
    active: true,
  },
];

const RECORDS = JOBS.map(line);

function compare(expectedPath: string, actualPath: string): SpawnSyncReturns<string> {
  return spawnSync("bash", ["-c", 'source "$LIB" && compare_cron_job_listings "$EXPECTED" "$ACTUAL"'], {
    encoding: "utf8",
    env: { ...process.env, LIB: libPath, EXPECTED: expectedPath, ACTUAL: actualPath },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

test("cron job listings match as a multiset across collations and reject field and count drift", async () => {
  const syntax = [libPath, restorePath, verifyPath].map((script) => spawnSync("bash", ["-n", script], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }));
  for (const result of syntax) {
    assert.equal(result.status, 0, result.stderr);
  }

  const hyphen = hyphenFirst(RECORDS);
  const underscore = underscoreFirst(RECORDS);
  assert.equal(hyphen.length, 5);
  assert.equal(underscore.length, 5);
  assert.notDeepEqual(hyphen, underscore);
  assert.equal(underscore[0], RECORDS.find((record) => jobName(record) === "swarm_purge_file_artifacts"));
  assert.equal(hyphen[hyphen.length - 1], underscore[0]);

  const work = await mkdtemp(join(tmpdir(), "ndb-cron-compare-"));
  try {
    const hyphenFile = join(work, "hyphen-first.ndjson");
    const underscoreFile = join(work, "underscore-first.ndjson");
    const hyphenText = ndjson(hyphen);
    const underscoreText = ndjson(underscore);
    await writeFile(hyphenFile, hyphenText, { mode: 0o600 });
    await writeFile(underscoreFile, underscoreText, { mode: 0o600 });

    const oldDiff = spawnSync("diff", ["-u", hyphenFile, underscoreFile], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(oldDiff.status, 1, "bytewise diff of the two collation orders must fail (old red)");

    const restored = compare(hyphenFile, underscoreFile);
    assert.equal(restored.status, 0, restored.stdout + restored.stderr);
    assert.equal(await readFile(hyphenFile, "utf8"), hyphenText, "comparator rewrote the expected artifact");
    assert.equal(await readFile(underscoreFile, "utf8"), underscoreText, "comparator rewrote the actual listing");

    const swapped = compare(underscoreFile, hyphenFile);
    assert.equal(swapped.status, 0, swapped.stdout + swapped.stderr);

    async function reject(actualLines: string[], reason: string): Promise<void> {
      const actualFile = join(work, "actual.ndjson");
      await writeFile(actualFile, ndjson(actualLines), { mode: 0o600 });
      const result = compare(hyphenFile, actualFile);
      assert.notEqual(result.status, 0, reason);
    }

    const fileArtifacts = hyphen.find((record) => jobName(record) === "swarm_purge_file_artifacts")!;
    const altered = hyphen.map((record) => {
      if (record !== fileArtifacts) return record;
      const job = JSON.parse(record) as CronJob;
      job.schedule = "0 0 * * *";
      return line(job);
    });
    await reject(altered, "an altered schedule was accepted");

    await reject(hyphen.filter((record) => record !== fileArtifacts), "a missing job was accepted");

    const extra: CronJob = {
      jobname: "unexpected-job",
      schedule: "0 1 * * *",
      command: "SELECT 4",
      database: "postgres",
      username: "postgres",
      active: true,
    };
    await reject([...hyphen, line(extra)], "an extra job was accepted");

    const first = hyphen[0]!;
    const second = hyphen[1]!;
    // Extra copy of one record: counts 6 vs 5.
    await reject([first, first, ...hyphen.slice(1)], "a duplicate count was accepted");
    // Same line count, different multiplicity. `sort -u` of unique names would miss this.
    const expectedDuplicate = [first, first, ...hyphen.slice(1)];
    const actualDuplicate = [first, second, second, ...hyphen.slice(2)];
    assert.equal(expectedDuplicate.length, 6);
    assert.equal(actualDuplicate.length, 6);
    const expectedDuplicateFile = join(work, "expected-duplicate.ndjson");
    const actualDuplicateFile = join(work, "actual-duplicate.ndjson");
    await writeFile(expectedDuplicateFile, ndjson(expectedDuplicate), { mode: 0o600 });
    await writeFile(actualDuplicateFile, ndjson(actualDuplicate), { mode: 0o600 });
    const duplicateSwap = compare(expectedDuplicateFile, actualDuplicateFile);
    assert.notEqual(duplicateSwap.status, 0, "swapped duplicate multiplicity was accepted");
    assert.match(`${duplicateSwap.stdout}${duplicateSwap.stderr}`, /[-+]\{"jobname"/);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
