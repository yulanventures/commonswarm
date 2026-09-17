/**
 * The N-db pg_cron schedules reach the box (review round 2, 2026-09-17).
 *
 * WHY THIS EXISTS. The selected-schema dump carries the swarm purge functions but not the cron schema, so a restored box
 * ran none of the five CommonSwarm purge jobs and verify-counts.sh could not see it. Production has exactly five jobs,
 * all owned by `postgres` in database `postgres` (measured read-only 2026-09-17).
 *
 * This test uses the box image itself. It schedules jobs as `postgres` (one inactive, one whose command holds a quote,
 * a backslash, a tab and a newline), exports them with the SQL dump-source.sh uses while connected as `postgres`,
 * drops pg_cron, and runs the real restore-cron-jobs.sh in a tool container against the marked database: the jobs come
 * back byte-identical and owned by `postgres`; a second run changes nothing; an entry for another database fails the
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
    // The same query and flags dump-source.sh uses, connected as `postgres` (row security limits it to that role's jobs).
    const listing = (service: "source" | "target") => tool(["-c",
      `source /work/migrate/lib.sh; cron_jobs_json_sql > /tmp/cron.sql; database_psql ${service} --quiet --tuples-only --no-align --file /tmp/cron.sql`]);

    const exported = listing("source");
    assert.equal(exported.status, 0, exported.stderr);
    const lines = exported.stdout.split("\n").filter(Boolean);
    assert.equal(lines.length, 3, exported.stdout);
    const jobs = lines.map(line => JSON.parse(line) as { jobname: string; command: string; username: string; database: string; active: boolean });
    assert.deepEqual(jobs.map(job => job.jobname), ["escaped-command", "inactive-job", "swarm-purge-rate-buckets"]);
    assert.ok(jobs.every(job => job.username === "postgres" && job.database === "postgres"));
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
    assert.match(result.stdout, /3 cron jobs match cron-jobs\.ndjson/);
    assert.equal(listing("target").stdout, exported.stdout);

    // 2. A second run changes nothing.
    result = tool(["/work/migrate/restore-cron-jobs.sh", "target"]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(listing("target").stdout, exported.stdout);

    // 3. One transaction: an entry for another database fails the run and leaves the jobs as they were.
    const foreign = JSON.stringify({ jobname: "aaa-foreign", schedule: "0 2 * * *", command: "SELECT 5", database: "other", username: "postgres", active: true });
    await writeFile(join(otherArtifacts, "cron-jobs.ndjson"), `${foreign}\n${exported.stdout}`, { mode: 0o600 });
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
