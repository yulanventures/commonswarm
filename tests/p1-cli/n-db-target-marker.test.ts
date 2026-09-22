/**
 * The N-db target marker is a database setting, not a session setting.
 *
 * current_setting('commonswarm.stack_identity') also returns a value from a connection
 * option. A URL with options=-ccommonswarm.stack_identity=n-db-target-v1 then passes
 * assert_target_identity on an unmarked database. This test runs the real function
 * in PostgreSQL 17. An unmarked database is refused while that option is set. A
 * database whose pg_db_role_setting row (setrole = 0) is n-db-target-v1 is accepted
 * even when the session option names a different value.
 *
 * Reached by `npm run test:p1-cli` (glob). Skips, with the reason, when Docker is absent.
 */
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const stackDir = join(repoRoot, "deploy", "supabase-stack");
const IMAGE = "postgres:17.11";

function run(command: string, args: string[], input?: string): SpawnSyncReturns<string> {
  return spawnSync(command, args, { encoding: "utf8", input: input ?? "", stdio: ["pipe", "pipe", "pipe"], timeout: 120_000 });
}

test("the target marker is the database setting, not a connection option", { timeout: 180_000 }, async (context) => {
  if (run("docker", ["version", "--format", "{{.Server.Version}}"]).status !== 0) {
    context.skip("Docker is absent; this gate needs a throwaway PostgreSQL 17 container");
    return;
  }
  const id = randomUUID().slice(0, 8);
  const network = `ndb-marker-${id}`;
  const db = `ndb-marker-db-${id}`;
  const password = randomUUID().replaceAll("-", "");
  const work = await mkdtemp(join(tmpdir(), "ndb-marker-"));
  const serviceFile = join(work, "pg_service.conf");
  const passFile = join(work, "pgpass");
  const admin = (sql: string) => run("docker", [
    "exec", "-i", db, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres", "-q", "-t", "-A",
  ], sql);
  const servicePsql = (sql: string) => run("docker", [
    "run", "--rm", "--network", network,
    "-e", "PGSERVICEFILE=/run/pg_service.conf", "-e", "PGPASSFILE=/run/pgpass",
    "-v", `${serviceFile}:/run/pg_service.conf:ro`, "-v", `${passFile}:/run/pgpass:ro`,
    "--entrypoint", "psql", IMAGE,
    "service=target", "-X", "-v", "ON_ERROR_STOP=1", "-At", "-c", sql,
  ]);
  const identity = () => run("docker", [
    "run", "--rm", "--network", network,
    "-e", "PGSERVICEFILE=/run/pg_service.conf", "-e", "PGPASSFILE=/run/pgpass",
    "-v", `${stackDir}:/work:ro`,
    "-v", `${serviceFile}:/run/pg_service.conf:ro`, "-v", `${passFile}:/run/pgpass:ro`,
    "--entrypoint", "bash", IMAGE,
    "-c", "source /work/migrate/lib.sh && assert_target_identity",
  ]);
  const writeService = async (options: string | null) => {
    const lines = [
      "[target]",
      "host=targetdb",
      "port=5432",
      "dbname=postgres",
      "user=supabase_admin",
      "sslmode=disable",
    ];
    if (options) lines.push(`options=${options}`);
    lines.push("");
    await writeFile(serviceFile, lines.join("\n"), { mode: 0o600 });
  };
  try {
    assert.equal(run("docker", ["network", "create", network]).status, 0);
    const started = run("docker", [
      "run", "-d", "--name", db, "--network", network, "--network-alias", "targetdb",
      "-e", `POSTGRES_PASSWORD=${randomUUID()}`, IMAGE,
    ]);
    assert.equal(started.status, 0, started.stderr);
    let ready = false;
    for (let attempt = 0; attempt < 60 && !ready; attempt += 1) {
      ready = run("docker", ["exec", db, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"]).status === 0;
      if (!ready) await new Promise((resolveReady) => setTimeout(resolveReady, 500));
    }
    assert.ok(ready, "throwaway PostgreSQL did not become ready");

    const created = admin(`CREATE ROLE supabase_admin LOGIN SUPERUSER PASSWORD '${password}';`);
    assert.equal(created.status, 0, created.stderr);
    const address = run("docker", ["inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", db]).stdout.trim();
    assert.match(address, /^\d{1,3}(?:\.\d{1,3}){3}$/);
    const marked = admin(`
      ALTER DATABASE postgres SET "commonswarm.local_rehearsal" TO '1';
      ALTER DATABASE postgres SET "commonswarm.local_target_address" TO '${address}';
    `);
    assert.equal(marked.status, 0, marked.stderr);
    await writeFile(passFile, `targetdb:5432:postgres:supabase_admin:${password}\n`, { mode: 0o600 });
    await chmod(passFile, 0o600);

    // The session option is live. current_setting sees the spoof. The catalog does not.
    await writeService("-ccommonswarm.stack_identity=n-db-target-v1");
    const spoofed = servicePsql("SELECT current_setting('commonswarm.stack_identity', true)");
    assert.equal(spoofed.status, 0, spoofed.stderr);
    assert.equal(spoofed.stdout.trim(), "n-db-target-v1", "the session option did not reach current_setting");
    const catalog = servicePsql(`
      SELECT count(*)
      FROM pg_db_role_setting AS setting
      CROSS JOIN LATERAL unnest(setting.setconfig) AS item
      WHERE setting.setrole = 0
        AND item = 'commonswarm.stack_identity=n-db-target-v1'
    `);
    assert.equal(catalog.status, 0, catalog.stderr);
    assert.equal(catalog.stdout.trim(), "0", "an unmarked database already has the database-level marker");

    const unmarked = identity();
    assert.notEqual(unmarked.status, 0, "an unmarked database was accepted when the session option set the marker");
    assert.match(`${unmarked.stdout}\n${unmarked.stderr}`, /not a marked CommonSwarm N-db target/);
    assert.doesNotMatch(`${unmarked.stdout}\n${unmarked.stderr}`, /server address is not/);

    const wrongMarker = admin(`ALTER DATABASE postgres SET "commonswarm.stack_identity" TO 'real-marker';`);
    assert.equal(wrongMarker.status, 0, wrongMarker.stderr);
    const stillSpoofed = identity();
    assert.notEqual(stillSpoofed.status, 0, "a database marked real-marker was accepted via the session option");
    assert.match(`${stillSpoofed.stdout}\n${stillSpoofed.stderr}`, /not a marked CommonSwarm N-db target/);

    const rightMarker = admin(`ALTER DATABASE postgres SET "commonswarm.stack_identity" TO 'n-db-target-v1';`);
    assert.equal(rightMarker.status, 0, rightMarker.stderr);
    await writeService("-ccommonswarm.stack_identity=not-the-marker");
    const lied = servicePsql("SELECT current_setting('commonswarm.stack_identity', true)");
    assert.equal(lied.status, 0, lied.stderr);
    assert.equal(lied.stdout.trim(), "not-the-marker", "the session option did not override current_setting");
    const accepted = identity();
    assert.equal(accepted.status, 0, `${accepted.stdout}\n${accepted.stderr}`);
  } finally {
    run("docker", ["rm", "-fv", db]);
    run("docker", ["network", "rm", network]);
    await rm(work, { recursive: true, force: true });
  }
});
