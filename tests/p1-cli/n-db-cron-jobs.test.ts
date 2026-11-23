/**
 * The N-db pg_cron schedules reach the box (review round 2, 2026-09-17).
 *
 * WHY THIS EXISTS. The selected-schema dump carries the swarm purge functions but not the cron schema, so a restored box
 * ran none of the five CommonSwarm purge jobs and verify-counts.sh could not see it. `postgres` has BYPASSRLS on hosted
 * and on the box image, so the export must include jobs owned by other roles too.
 *
 * This test uses the box image itself. It schedules jobs as `postgres` (one inactive, one whose command holds a quote,
 * a backslash, a tab and a newline), plus one job as `supabase_admin`; exports them with the SQL dump-source.sh uses
 * while connected as `postgres`,
 * drops pg_cron, and runs the real restore-cron-jobs.sh in a tool container against the marked database: the jobs come
 * back byte-identical and under their source owners; a second run changes nothing; an entry for another database fails the
 * whole transaction; a job the artifact does not name fails verification; the source is refused.
 *
 * Reached by `npm run test:p1-cli` (glob). Skips, with the reason, when Docker is absent.
 */
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { pullDockerImage } from "../support/docker-image-pull.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const stackDir = join(repoRoot, "deploy", "supabase-stack");
const IMAGE = "public.ecr.aws/supabase/postgres:17.6.1.147";
const PASSWORD = `admin-${randomUUID()}`;

function run(command: string, args: string[], input?: string): SpawnSyncReturns<string> {
  return spawnSync(command, args, { encoding: "utf8", input: input ?? "", stdio: ["pipe", "pipe", "pipe"], timeout: 120_000 });
}

test("pg_cron schedules are exported from the source and recreated on the box", { timeout: 300_000 }, async (context) => {
  if (run("docker", ["version", "--format", "{{.Server.Version}}"]).status !== 0) {
    context.skip("Docker is absent; this gate needs a throwaway box database");
    return;
  }
  const image = await pullDockerImage(IMAGE);
  if (!image.ready) {
    context.skip(image.reason);
    return;
  }
  const id = randomUUID().slice(0, 8);
  const network = `ndb-cron-${id}`;
  const db = `ndb-cron-db-${id}`;
  const work = await mkdtemp(join(tmpdir(), "ndb-cron-"));
  const artifacts = join(work, "artifacts");
  const otherArtifacts = join(work, "other-artifacts");
  const serviceFile = join(work, "pg_service.conf");
  const passFile = join(work, "pgpass");
  await mkdir(artifacts, { mode: 0o700 });
  await mkdir(otherArtifacts, { mode: 0o700 });
  try {
    assert.equal(run("docker", ["network", "create", network]).status, 0);
    const started = run("docker", ["run", "-d", "--name", db, "--network", network, "--network-alias", "db.commonswarm.internal",
      "-e", `POSTGRES_PASSWORD=${PASSWORD}`, "-e", `JWT_SECRET=${randomUUID()}${randomUUID()}`, "-e", "JWT_EXP=3600", IMAGE]);
    assert.equal(started.status, 0, started.stderr);
    const adminSql = (sql: string) => run("docker", ["exec", "-i", "-e", `PGPASSWORD=${PASSWORD}`, db, "psql", "-X",
      "-v", "ON_ERROR_STOP=1", "-h", "127.0.0.1", "-U", "supabase_admin", "-d", "postgres", "-q", "-t", "-A"], sql);
    let ready = false;
    for (let attempt = 0; attempt < 120 && !ready; attempt += 1) {
      ready = adminSql("SELECT count(*) FROM pg_roles WHERE rolname = 'postgres'").stdout.trim() === "1";
      if (!ready) await new Promise(r => setTimeout(r, 500));
    }
    assert.ok(ready, "the box image did not become ready over TCP");

    const commandWithEscapes = "SELECT 'a\\b''c';\n\tSELECT 2";
    const scheduled = adminSql(`
      CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
      SET ROLE postgres;
      SELECT cron.schedule('swarm-purge-rate-buckets', '42 * * * *', 'SELECT 1');
      SELECT cron.schedule('escaped-command', '*/5 * * * *', ${"$q$"}${commandWithEscapes}${"$q$"});
      SELECT cron.alter_job(job_id := cron.schedule('inactive-job', '0 0 * * *', 'SELECT 3'), active := false);
      RESET ROLE;
      SELECT cron.schedule('supabase-admin-job', '17 3 * * *', 'SELECT 6');
    `);
    assert.equal(scheduled.status, 0, scheduled.stderr);

    const address = run("docker", ["inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", db]).stdout.trim();
    assert.match(address, /^\d+\.\d+\.\d+\.\d+$/);
    await writeFile(serviceFile, [
      "[source]", "host=db.commonswarm.internal", "port=5432", "dbname=postgres", "user=supabase_admin", "sslmode=disable", "options=-c role=postgres",
      "[target]", "host=db.commonswarm.internal", "port=5432", "dbname=postgres", "user=supabase_admin", "sslmode=disable", "",
    ].join("\n"), { mode: 0o600 });
    await writeFile(passFile, `db.commonswarm.internal:5432:postgres:supabase_admin:${PASSWORD}\n`, { mode: 0o600 });
    await chmod(passFile, 0o600);

    const tool = (args: string[], artifactDir = artifacts) => run("docker", [
      "run", "--rm", "--network", network,
      "--user", `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
      "-e", "MIGRATION_ARTIFACT_DIR=/artifacts", "-e", "PGSERVICEFILE=/run/pg_service.conf", "-e", "PGPASSFILE=/run/pgpass",
      "-e", "TARGET_DATABASE_URL=set-in-service-file",
      "-v", `${stackDir}:/work:ro`, "-v", `${artifactDir}:/artifacts`,
      "-v", `${serviceFile}:/run/pg_service.conf:ro`, "-v", `${passFile}:/run/pgpass:ro`,
      "--entrypoint", "/bin/bash", IMAGE, ...args,
    ]);
    // The same query and flags dump-source.sh uses, connected as `postgres`, whose BYPASSRLS sees every owner's jobs.
    const listing = (service: "source" | "target") => tool(["-c",
      `source /work/migrate/lib.sh; cron_jobs_json_sql > /tmp/cron.sql; database_psql ${service} --quiet --tuples-only --no-align --file /tmp/cron.sql`]);

    const exported = listing("source");
    assert.equal(exported.status, 0, exported.stderr);
    const lines = exported.stdout.split("\n").filter(Boolean);
    assert.equal(lines.length, 4, exported.stdout);
    const jobs = lines.map(line => JSON.parse(line) as { jobname: string; command: string; username: string; database: string; active: boolean });
    assert.deepEqual(jobs.map(job => job.jobname), ["escaped-command", "inactive-job", "supabase-admin-job", "swarm-purge-rate-buckets"]);
    assert.ok(jobs.every(job => job.database === "postgres"));
    assert.equal(jobs.find(job => job.jobname === "supabase-admin-job")!.username, "supabase_admin");
    assert.equal(jobs.find(job => job.jobname === "escaped-command")!.command, commandWithEscapes);
    assert.equal(jobs.find(job => job.jobname === "inactive-job")!.active, false);
    await writeFile(join(artifacts, "cron-jobs.ndjson"), exported.stdout, { mode: 0o600 });

    // A fresh box database: pg_cron is preloaded by the image but not created, and no job exists.
    assert.equal(adminSql("DROP EXTENSION pg_cron;").status, 0);
    assert.equal(adminSql(`
      ALTER DATABASE postgres SET "commonswarm.stack_identity" TO 'n-db-target-v1';
      ALTER DATABASE postgres SET "commonswarm.local_rehearsal" TO '1';
      ALTER DATABASE postgres SET "commonswarm.local_target_address" TO '${address}';
    `).status, 0);

    // 1. Restore recreates every job, owned by its source role, byte-identical to the artifact.
    let result = tool(["/work/migrate/restore-cron-jobs.sh", "target"]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /4 cron jobs match cron-jobs\.ndjson/);
    assert.equal(listing("target").stdout, exported.stdout);
    const restoredAdminJob = listing("target").stdout.split("\n").filter(Boolean)
      .map(line => JSON.parse(line) as { jobname: string; username: string })
      .find(job => job.jobname === "supabase-admin-job");
    assert.equal(restoredAdminJob?.username, "supabase_admin", "the supabase_admin job was restored under another owner");

    // 2. A second run changes nothing.
    result = tool(["/work/migrate/restore-cron-jobs.sh", "target"]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(listing("target").stdout, exported.stdout);

    // 2b. The same records in the opposite line order still match. Hosted and box collations can
    // sort '_' and '-' differently; the artifact is not rewritten.
    const originalArtifact = await readFile(join(artifacts, "cron-jobs.ndjson"), "utf8");
    const reversedArtifact = `${originalArtifact.split("\n").filter(Boolean).reverse().join("\n")}\n`;
    assert.notEqual(reversedArtifact, originalArtifact);
    await writeFile(join(artifacts, "cron-jobs.ndjson"), reversedArtifact, { mode: 0o600 });
    result = tool(["/work/migrate/restore-cron-jobs.sh", "target"]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /4 cron jobs match cron-jobs\.ndjson/);
    const afterReverse = await readFile(join(artifacts, "cron-jobs.ndjson"), "utf8");
    assert.equal(afterReverse, reversedArtifact, "restore rewrote cron-jobs.ndjson");
    await writeFile(join(artifacts, "cron-jobs.ndjson"), originalArtifact, { mode: 0o600 });

    // 3. One transaction: an entry for another database fails the run and leaves the jobs as they were.
    const foreign = JSON.stringify({ jobname: "zzz-foreign", schedule: "0 2 * * *", command: "SELECT 5", database: "other", username: "postgres", active: true });
    await writeFile(join(otherArtifacts, "cron-jobs.ndjson"), `${exported.stdout}${foreign}\n`, { mode: 0o600 });
    result = tool(["/work/migrate/restore-cron-jobs.sh", "target"], otherArtifacts);
    assert.notEqual(result.status, 0, "a job for another database was accepted");
    assert.equal(listing("target").stdout, exported.stdout, "a failed restore changed the jobs");

    // 4. A job on the box that the artifact does not name fails verification.
    assert.equal(adminSql("SET ROLE postgres; SELECT cron.schedule('unexpected-job', '0 1 * * *', 'SELECT 4');").status, 0);
    result = tool(["/work/migrate/restore-cron-jobs.sh", "target"]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /differ from cron-jobs\.ndjson/);

    // 5. The hosted project is never a destination, and a dump without the artifact is refused.
    result = tool(["/work/migrate/restore-cron-jobs.sh", "source"]);
    assert.equal(result.status, 64, result.stdout + result.stderr);
    await rm(join(otherArtifacts, "cron-jobs.ndjson"));
    result = tool(["/work/migrate/restore-cron-jobs.sh", "target"], otherArtifacts);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /cron-jobs\.ndjson is missing/);
  } finally {
    run("docker", ["rm", "-f", db]);
    run("docker", ["network", "rm", network]);
    await rm(work, { recursive: true, force: true });
  }
});

function postgresCommandFromCompose(composeText: string): string[] {
  const lines = composeText.split(/\r?\n/);
  const serviceStart = lines.findIndex((line) => line === "  postgres:");
  assert.ok(serviceStart >= 0, "postgres service missing from deploy/supabase-stack/compose.yaml");
  let commandStart = -1;
  for (let i = serviceStart + 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (/^(?:[a-z0-9_-]+:|  [a-z0-9_-]+:)/.test(line)) break;
    if (line === "    command:") {
      commandStart = i + 1;
      break;
    }
  }
  assert.ok(commandStart >= 0, "postgres command list missing from deploy/supabase-stack/compose.yaml");
  const rawArgs: string[] = [];
  for (let i = commandStart; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (!line.startsWith("      - ")) break;
    rawArgs.push(line.slice("      - ".length).trim());
  }
  assert.ok(rawArgs.length > 0, "postgres command list is empty");
  // Drop only TLS flags because this throwaway container mounts no TLS keypair; keep hba_file and all other flags verbatim.
  const filtered: string[] = [];
  for (let i = 0; i < rawArgs.length; i += 1) {
    if (rawArgs[i] === "-c" && /^ssl(?:_|=)/.test(rawArgs[i + 1] ?? "")) {
      i += 1;
      continue;
    }
    filtered.push(rawArgs[i]!);
  }
  return filtered;
}

test("pg_cron executes a scheduled job via background workers under the production pg_hba.conf", { timeout: 300_000 }, async (context) => {
  if (run("docker", ["version", "--format", "{{.Server.Version}}"]).status !== 0) {
    context.skip("Docker is absent; this gate needs a throwaway box database");
    return;
  }
  const image = await pullDockerImage(IMAGE);
  if (!image.ready) {
    context.skip(image.reason);
    return;
  }
  const composeText = await readFile(join(stackDir, "compose.yaml"), "utf8");
  const postgresCommand = postgresCommandFromCompose(composeText);
  const id = randomUUID().slice(0, 8);
  const db = `ndb-cron-bgw-${id}`;
  let scheduledJobId: string | null = null;
  const adminSql = (sql: string) => run("docker", [
    "exec", "-i", "-e", `PGPASSWORD=${PASSWORD}`, db,
    "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "supabase_admin", "-d", "postgres", "-q", "-t", "-A",
  ], sql);
  try {
    const started = run("docker", [
      "run", "-d", "--name", db, "--shm-size=256m",
      "-e", `POSTGRES_PASSWORD=${PASSWORD}`,
      "-e", `JWT_SECRET=${randomUUID()}${randomUUID()}`,
      "-e", "JWT_EXP=3600",
      "-v", `${join(stackDir, "postgres", "pg_hba.conf")}:/etc/postgresql-custom/pg_hba.conf:ro`,
      IMAGE,
      ...postgresCommand,
    ]);
    assert.equal(started.status, 0, started.stderr);

    // Wait for the post-initdb server (with production pg_hba.conf loaded) via bounded polling without sleeps.
    const readyDeadline = Date.now() + 90_000;
    let ready = false;
    for (let attempt = 0; attempt < 2000 && Date.now() < readyDeadline; attempt += 1) {
      const probe = adminSql(
        "SELECT current_setting('listen_addresses') <> '' AND current_setting('hba_file') = '/etc/postgresql-custom/pg_hba.conf' AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres');",
      );
      if (probe.status === 0 && probe.stdout.trim() === "t") {
        ready = true;
        break;
      }
      const running = run("docker", ["inspect", "--format", "{{.State.Running}}", db]).stdout.trim();
      if (running === "false") {
        const logs = run("docker", ["logs", "--tail", "80", db]);
        assert.fail(`postgres container exited before becoming ready:\n${logs.stdout}\n${logs.stderr}`);
      }
    }
    assert.ok(ready, "box postgres did not become ready with production pg_hba.conf");

    const setup = adminSql(`
      CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
      SELECT cron.schedule('commonswarm-cron-bgworker-witness', '5 seconds', 'SELECT 1');
    `);
    assert.equal(setup.status, 0, setup.stderr);
    scheduledJobId = setup.stdout.trim().split("\n").at(-1) ?? "";
    assert.match(scheduledJobId, /^\d+$/, `unexpected cron job id: ${setup.stdout}`);
    assert.equal(adminSql("SELECT pg_reload_conf();").status, 0);

    // Poll cron.job_run_details with a bounded number of short queries (no sleeps) until one run finishes.
    const pollDeadline = Date.now() + 70_000;
    let outcome = "";
    for (let attempt = 0; attempt < 1500 && Date.now() < pollDeadline; attempt += 1) {
      const check = adminSql(
        `SELECT status || '|' || COALESCE(return_message, '') FROM cron.job_run_details WHERE jobid = ${scheduledJobId} AND status IN ('succeeded', 'failed') ORDER BY runid DESC LIMIT 1;`,
      );
      assert.equal(check.status, 0, check.stderr);
      const line = check.stdout.trim();
      if (line.length > 0) {
        outcome = line;
        break;
      }
    }
    assert.ok(outcome.length > 0, "throwaway pg_cron job did not record a completed run within the poll bound");
    const [status, ...messageParts] = outcome.split("|");
    assert.equal(status, "succeeded", `pg_cron job failed under production pg_hba.conf: ${messageParts.join("|")}`);

    const bgwSetting = adminSql("SHOW cron.use_background_workers;");
    assert.equal(bgwSetting.status, 0, bgwSetting.stderr);
    assert.equal(bgwSetting.stdout.trim(), "on", "cron.use_background_workers must be on");
    const workersSetting = adminSql("SHOW max_worker_processes;");
    assert.equal(workersSetting.status, 0, workersSetting.stderr);
    assert.ok(Number(workersSetting.stdout.trim()) >= 16, `max_worker_processes=${workersSetting.stdout.trim()} is too low`);
  } finally {
    if (scheduledJobId && /^\d+$/.test(scheduledJobId)) {
      adminSql(`SELECT cron.unschedule(${scheduledJobId});`);
    }
    run("docker", ["rm", "-f", db]);
  }
});
