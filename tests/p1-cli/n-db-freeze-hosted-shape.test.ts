/**
 * The N-db write freeze against the HOSTED permission shape (a permanent gate, Strategist ruling 9084e3e1).
 *
 * WHY THIS EXISTS. The local Supabase stack connects as a superuser, so a freeze rehearsed there passed while three
 * production blockers stayed invisible (all measured on production, read-only, 2026-09-17): hosted `postgres` is NOT a
 * superuser and cannot set custom database parameters; it cannot add triggers to a few service-owned tables
 * (auth.schema_migrations, storage.migrations, storage.buckets_vectors, storage.vector_indexes); and it cannot SET ROLE
 * to supabase_admin, supabase_auth_admin or supabase_storage_admin. Production also does not set
 * app.settings.jwt_secret, so the source is identified by its cluster system_identifier (readable through pg_monitor).
 *
 * This test builds that shape in a throwaway PostgreSQL 17 and runs the real scripts in a tool container:
 * a wrong identifier and a missing acknowledgement change nothing; a failure inside enable leaves nothing behind (one
 * transaction); the freeze refuses writes under both session bypasses with SQLSTATE 25006; the probe refuses to prove a
 * role it cannot assume unless acknowledged, and fails (not "frozen") on an error that is not the freeze; disable
 * restores writes.
 *
 * Reached by `npm run test:p1-cli` (glob). Skips, with the reason, when Docker is absent.
 */
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const stackDir = join(repoRoot, "deploy", "supabase-stack");
const IMAGE = "postgres:17.11";
const OWNER = "hosted_owner";
const OWNER_PASSWORD = `owner-${randomUUID()}`;
const SERVICE_ROLES = [
  "postgres", "supabase_admin", "supabase_auth_admin", "supabase_storage_admin", "authenticator", "anon",
  "authenticated", "service_role", "commonswarm_edge", "swarm_command", "swarm_read", "swarm_capability",
];
const ASSUMABLE = ["authenticator", "anon", "authenticated", "service_role", "commonswarm_edge", "swarm_command", "swarm_read", "swarm_capability"];

function run(command: string, args: string[], input?: string): SpawnSyncReturns<string> {
  return spawnSync(command, args, { encoding: "utf8", input: input ?? "", stdio: ["pipe", "pipe", "pipe"], timeout: 120_000 });
}

test("the N-db freeze works under the hosted permission shape and fails closed", { timeout: 300_000 }, async (context) => {
  if (run("docker", ["version", "--format", "{{.Server.Version}}"]).status !== 0) {
    context.skip("Docker is absent; this gate needs a throwaway PostgreSQL 17 container");
    return;
  }
  const id = randomUUID().slice(0, 8);
  const network = `ndb-freeze-${id}`;
  const db = `ndb-freeze-db-${id}`;
  const work = await mkdtemp(join(tmpdir(), "ndb-freeze-"));
  const artifacts = join(work, "artifacts");
  // Created here, owned by the test user: a rootful Linux daemon would otherwise create the mount point as root.
  await mkdir(artifacts, { mode: 0o700 });
  const serviceFile = join(work, "pg_service.conf");
  const passFile = join(work, "pgpass");
  try {
    assert.equal(run("docker", ["network", "create", network]).status, 0);
    const started = run("docker", ["run", "-d", "--name", db, "--network", network, "--network-alias", "srcdb",
      "-e", `POSTGRES_PASSWORD=${randomUUID()}`, IMAGE]);
    assert.equal(started.status, 0, started.stderr);
    let ready = false;
    for (let attempt = 0; attempt < 60 && !ready; attempt += 1) {
      ready = run("docker", ["exec", db, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"]).status === 0;
      if (!ready) await new Promise(r => setTimeout(r, 500));
    }
    assert.ok(ready, "throwaway PostgreSQL did not become ready over TCP");

    const superSql = (sql: string, database = "appdb") =>
      run("docker", ["exec", "-i", db, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", database, "-q", "-t", "-A"], sql);
    const setup = superSql(`
      CREATE ROLE ${OWNER} LOGIN NOSUPERUSER BYPASSRLS PASSWORD '${OWNER_PASSWORD}';
      GRANT pg_monitor, pg_signal_backend TO ${OWNER};
      ${SERVICE_ROLES.filter(r => r !== "postgres").map(r => `CREATE ROLE ${r} NOLOGIN;`).join("\n")}
      GRANT ${ASSUMABLE.join(", ")} TO ${OWNER};
      CREATE DATABASE appdb OWNER ${OWNER};
    `, "postgres");
    assert.equal(setup.status, 0, setup.stderr);
    const shape = superSql(`
      CREATE SCHEMA swarm AUTHORIZATION ${OWNER};
      CREATE TABLE swarm.signals (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, body text);
      ALTER TABLE swarm.signals OWNER TO ${OWNER};
      GRANT USAGE ON SCHEMA swarm TO swarm_command;
      GRANT INSERT ON swarm.signals TO swarm_command;
      CREATE SCHEMA auth AUTHORIZATION supabase_auth_admin;
      GRANT USAGE ON SCHEMA auth TO ${OWNER};
      CREATE TABLE auth.users (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, email text);
      ALTER TABLE auth.users OWNER TO supabase_auth_admin;
      GRANT TRIGGER, INSERT ON auth.users TO ${OWNER};
      CREATE TABLE auth.schema_migrations (version text);
      ALTER TABLE auth.schema_migrations OWNER TO supabase_auth_admin;
    `);
    assert.equal(shape.status, 0, shape.stderr);
    const systemIdentifier = superSql("SELECT system_identifier FROM pg_control_system()").stdout.trim();
    assert.match(systemIdentifier, /^\d+$/);

    await writeFile(serviceFile, `[source]\nhost=srcdb\nport=5432\ndbname=appdb\nuser=${OWNER}\nsslmode=disable\n`, { mode: 0o600 });
    await writeFile(passFile, `srcdb:5432:appdb:${OWNER}:${OWNER_PASSWORD}\n`, { mode: 0o600 });
    await chmod(passFile, 0o600);

    const tool = (script: string, args: string[], env: Record<string, string>) => run("docker", [
      "run", "--rm", "--network", network,
      "--user", `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
      "-e", "MIGRATION_ARTIFACT_DIR=/artifacts", "-e", "PGSERVICEFILE=/run/pg_service.conf", "-e", "PGPASSFILE=/run/pgpass",
      "-e", "SOURCE_DATABASE_URL=set-in-service-file", "-e", "CUTOVER_CONFIRM=COMMONSWARM_N_DB_WINDOW",
      ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
      "-v", `${stackDir}:/work:ro`, "-v", `${artifacts}:/artifacts`,
      "-v", `${serviceFile}:/run/pg_service.conf:ro`, "-v", `${passFile}:/run/pgpass:ro`,
      "--entrypoint", "/bin/bash", IMAGE, `/work/migrate/${script}`, ...args,
    ]);
    const ownerSql = (sql: string) => run("docker", ["exec", "-i", "-e", `PGPASSWORD=${OWNER_PASSWORD}`, db, "psql", "-X",
      "-h", "127.0.0.1", "-U", OWNER, "-d", "appdb", "-q", "-t", "-A", "-v", "VERBOSITY=sqlstate"], sql);
    const nothingChanged = () => {
      const state = ownerSql(`SELECT to_regnamespace('commonswarm_cutover_probe') IS NULL, to_regclass('public.commonswarm_cutover_state') IS NULL,
        to_regprocedure('public.commonswarm_cutover_write_guard()') IS NULL,
        (SELECT count(*) FROM pg_trigger WHERE tgname = 'commonswarm_cutover_write_freeze'), current_setting('default_transaction_read_only')`);
      assert.equal(state.status, 0, state.stderr);
      assert.equal(state.stdout.trim(), "t|t|t|0|off", `the database was changed: ${state.stdout}`);
    };
    const identity = { SOURCE_SYSTEM_IDENTIFIER: systemIdentifier };

    // 1. A different system identifier refuses before any change.
    let result = tool("source-read-only.sh", ["enable", "source"], { SOURCE_SYSTEM_IDENTIFIER: "1", FREEZE_UNGUARDED_TABLES: "auth.schema_migrations" });
    assert.notEqual(result.status, 0, "enable accepted a database with a different system identifier");
    nothingChanged();

    // 2. The preflight names the unguardable table and refuses without the exact acknowledgement.
    result = tool("source-read-only.sh", ["enable", "source"], identity);
    assert.equal(result.status, 65, result.stdout + result.stderr);
    assert.match(result.stdout, /tables this role cannot guard with a trigger: auth\.schema_migrations/);
    nothingChanged();

    // 3. A failure inside enable leaves nothing behind: a guard function owned by another role cannot be replaced.
    assert.equal(superSql(`CREATE FUNCTION public.commonswarm_cutover_write_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NULL; END$$;
      ALTER FUNCTION public.commonswarm_cutover_write_guard() OWNER TO supabase_admin;`).status, 0);
    result = tool("source-read-only.sh", ["enable", "source"], { ...identity, FREEZE_UNGUARDED_TABLES: "auth.schema_migrations" });
    assert.notEqual(result.status, 0, "enable succeeded although the guard function could not be replaced");
    // Without CASCADE: this DROP fails if the failed enable left any trigger that depends on the planted function.
    assert.equal(superSql("DROP FUNCTION public.commonswarm_cutover_write_guard();").status, 0);
    nothingChanged();

    // 4. Enable with the acknowledgement: both session bypasses are refused with 25006, for an owned and a granted table.
    result = tool("source-read-only.sh", ["enable", "source"], { ...identity, FREEZE_UNGUARDED_TABLES: "auth.schema_migrations" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    for (const attempt of [
      "SET default_transaction_read_only = off; BEGIN; SET LOCAL ROLE swarm_command; INSERT INTO swarm.signals (body) VALUES ('x'); COMMIT;",
      "BEGIN READ WRITE; INSERT INTO auth.users (email) VALUES ('x'); COMMIT;",
    ]) {
      const refused = ownerSql(attempt);
      assert.match(refused.stderr, /ERROR:\s+25006/, `a frozen write was not refused with 25006: ${attempt}\n${refused.stderr}`);
    }

    // 4b. Enable again while frozen: it succeeds, adds no second trigger, and the freeze still holds.
    const frozenShape = () => ownerSql(`SELECT (SELECT count(*) FROM pg_trigger WHERE tgname = 'commonswarm_cutover_write_freeze'),
      (SELECT frozen FROM public.commonswarm_cutover_state WHERE singleton)`).stdout.trim();
    const shapeBefore = frozenShape();
    result = tool("source-read-only.sh", ["enable", "source"], { ...identity, FREEZE_UNGUARDED_TABLES: "auth.schema_migrations" });
    assert.equal(result.status, 0, `a second enable while frozen failed: ${result.stdout}${result.stderr}`);
    assert.equal(frozenShape(), shapeBefore, "a second enable changed the freeze objects");
    assert.match(ownerSql("SET default_transaction_read_only = off; BEGIN; SET LOCAL ROLE swarm_command; INSERT INTO swarm.signals (body) VALUES ('x'); COMMIT;").stderr,
      /ERROR:\s+25006/, "the freeze did not hold after a second enable");

    // 5. The probe refuses to prove roles it cannot assume unless acknowledged, then proves the rest frozen.
    result = tool("probe-database-freeze.sh", ["frozen", "source"], identity);
    assert.equal(result.status, 65, result.stdout + result.stderr);
    assert.match(result.stdout, /NOT probed: postgres,supabase_admin,supabase_auth_admin,supabase_storage_admin/);
    const unprobed = { ...identity, FREEZE_UNPROBED_ROLES: "postgres,supabase_admin,supabase_auth_admin,supabase_storage_admin" };
    result = tool("probe-database-freeze.sh", ["frozen", "source"], unprobed);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /8 service roles were frozen/);

    // 6. An error that is not the freeze fails the probe instead of counting as frozen.
    assert.equal(superSql("SET default_transaction_read_only = off; REVOKE INSERT ON commonswarm_cutover_probe.entries FROM anon;").status, 0);
    result = tool("probe-database-freeze.sh", ["frozen", "source"], unprobed);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /anon .* failed for a reason other than the freeze/);
    assert.equal(superSql("SET default_transaction_read_only = off; GRANT INSERT ON commonswarm_cutover_probe.entries TO anon;").status, 0);

    // 7. Disable restores writes and removes every freeze object; the writable probe agrees.
    result = tool("source-read-only.sh", ["disable", "source"], identity);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    nothingChanged();
    const write = ownerSql("SET ROLE swarm_command; INSERT INTO swarm.signals (body) VALUES ('after');");
    assert.equal(write.status, 0, write.stderr);
    result = tool("probe-database-freeze.sh", ["writable", "source"], unprobed);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    nothingChanged();
  } finally {
    run("docker", ["rm", "-f", db]);
    run("docker", ["network", "rm", network]);
    await rm(work, { recursive: true, force: true });
  }
});
