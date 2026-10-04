/*
 * C1 W2 rehearsal harness (scripts/c1-w2-rehearsal.sh). Release 835b7ae8 STOPPED in ai-w2-preflight: its reverse
 * catalogs raised "does not exist" on the live pre-W2 database. The static tests always run. The database tests
 * run only with RUN_PG_REHEARSAL=1 and local PostgreSQL binaries (PG_BIN, initdb on PATH, or Homebrew
 * postgresql@17): they build the repository's own 68-version pre-W2 fixture, prove the 835b7ae8 catalogs FAIL
 * on it (negative control), and prove the current plan runs the W2 SQL end to end (positive control).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';

const script = resolve('scripts/c1-w2-rehearsal.sh');
const source = readFileSync(script, 'utf8');
const scratch = mkdtempSync(join(realpathSync(tmpdir()), 'c1-w2-rehearsal-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const run = (args: string[], env: NodeJS.ProcessEnv = {}) =>
  spawnSync('/bin/bash', [script, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 600_000 });

function pgBin(): string | null {
  const candidates = [process.env.PG_BIN, ...((process.env.PATH ?? '').split(':')), '/opt/homebrew/opt/postgresql@17/bin'];
  for (const dir of candidates) {
    if (!dir || !['initdb', 'pg_ctl', 'psql', 'pg_dump', 'pg_dumpall'].every(tool => existsSync(join(dir, tool)))) continue;
    // The plan's W2 SQL sets transaction_timeout: PostgreSQL 17 or newer only.
    const major = Number(/\(PostgreSQL\) (\d+)/.exec(spawnSync(join(dir, 'psql'), ['--version'], { encoding: 'utf8' }).stdout ?? '')?.[1]);
    if (major >= 17) return dir;
  }
  return null;
}
// Skip only when the rehearsal is not requested; with RUN_PG_REHEARSAL=1 missing PostgreSQL 17+ FAILS the tests.
const REQUESTED = process.env.RUN_PG_REHEARSAL === '1';
const PG_FOUND = REQUESTED ? pgBin() : null;
const skipDb = REQUESTED ? false : 'RUN_PG_REHEARSAL is unset: the database rehearsal is not requested';
const PG = (): string => {
  assert.ok(PG_FOUND, 'RUN_PG_REHEARSAL=1 but no PostgreSQL 17+ binaries (PG_BIN, PATH or Homebrew postgresql@17)');
  return PG_FOUND!;
};

test('c1 W2 rehearsal: the script is Bash 3.2 syntax and never puts a heredoc inside a command substitution', () => {
  const syntax = spawnSync('/bin/bash', ['-n', script], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
  assert.doesNotMatch(source, /\$\([^)]*<</, 'no heredoc inside $(...)');
  assert.doesNotMatch(source, /\bHOME=/, 'HOME is never assigned');
  assert.match(source, /listen_addresses=''/, 'the cluster listens on a unix socket only');
  // Plan steps come from the RELEASE.md bytes, not retyped SQL.
  for (const step of ['ai-w2-measure', 'ai-w2-apply', 'ai-w2-reconcile', 'ai-w2-probes']) assert.match(source, new RegExp(step));
  assert.match(source, /extract "\$T\/catalog-plan\.md" ai-w2-preflight slice '# Before proofs:' 'ai_run ai-w2-measure'/);
});

test('c1 W2 rehearsal: --live-dump models exactly four extensions, and every modelled function raises', () => {
  const models = readFileSync(resolve('scripts/c1-w2-extension-models.sql'), 'utf8');
  const sections = models.split(/^(?=-- model: )/m).slice(1);
  assert.deepEqual(sections.map(part => part.split('\n', 1)[0]), ['-- model: pg_cron', '-- model: pg_net', '-- model: pg_graphql', '-- model: supabase_vault']);
  for (const part of sections) {
    const functions = part.match(/^CREATE FUNCTION /gm)?.length ?? 0;
    assert.ok(functions > 0);
    assert.equal(part.match(/RAISE EXCEPTION 'rehearsal model: [a-z_]+ is not installed'/g)?.length, functions, part.split('\n', 1)[0]);
    assert.doesNotMatch(part, /\b(?:swarm|swarm_read|commonswarm_oauth|commonswarm_ops|supabase_migrations)\./, 'models touch no CommonSwarm schema');
  }
  for (const statement of ['CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;', 'CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;',
    'CREATE EXTENSION IF NOT EXISTS pg_graphql WITH SCHEMA graphql;', 'CREATE EXTENSION IF NOT EXISTS supabase_vault WITH SCHEMA vault;']) {
    assert.ok(source.includes(`'${statement}'`), statement);
  }
  assert.match(source, /PASS isolation: no cron\., net\., graphql\., vault\. or pgsodium\. reference/);
});

test('c1 W2 rehearsal: cleanup deletes only the script\'s own mktemp directory (refusal controls)', () => {
  for (const path of ['/', '/tmp', '/tmp/', dirname(scratch), scratch, '/tmp/c1w2.abc', '/tmp/c1w2.abcdefg', '/tmp/c1w2.ab/cdef', '/tmp/other.abcdef']) {
    const r = run(['--cleanup-selftest', path]);
    assert.equal(r.status, 3, `${path}: ${r.stdout}${r.stderr}`); assert.match(r.stdout, /^REFUSE cleanup-selftest/);
  }
  // Positive control: a real directory of the script's own shape is accepted.
  const own = mkdtempSync('/tmp/c1w2.');
  try {
    const r = run(['--cleanup-selftest', own]);
    assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /^ACCEPT cleanup-selftest/);
  } finally { rmSync(own, { recursive: true, force: true }); }
});

test('c1 W2 rehearsal: a failed or incomplete postmaster stop keeps the cluster directory and exits nonzero', () => {
  // Stub pg_ctl in a test-owned directory; the recorded postmaster pid is this live test process.
  const bin = join(scratch, 'stub-bin'); mkdirSync(bin, { recursive: true });
  const stub = (status: number) => { writeFileSync(join(bin, 'pg_ctl'), `#!/bin/sh\nexit ${status}\n`); chmodSync(join(bin, 'pg_ctl'), 0o755); };
  const cluster = (pid: number) => {
    const dir = mkdtempSync('/tmp/c1w2.'); mkdirSync(join(dir, 'data'));
    writeFileSync(join(dir, 'data', 'postmaster.pid'), `${pid}\n${join(dir, 'data')}\n`); return dir;
  };
  const dirs: string[] = [];
  try {
    stub(1);
    const failed = cluster(process.pid); dirs.push(failed);
    let r = run(['--cleanup-run', failed], { PG_BIN: bin });
    assert.equal(r.status, 4, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`^RETAIN cleanup: pg_ctl stop failed; postmaster ${process.pid} may still run; cluster directory ${failed} kept$`, 'm'));
    assert.ok(existsSync(join(failed, 'data', 'postmaster.pid')), 'a failed stop never reaches rm');
    stub(0);
    const alive = cluster(process.pid); dirs.push(alive);
    r = run(['--cleanup-run', alive], { PG_BIN: bin });
    assert.equal(r.status, 4, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`^RETAIN cleanup: postmaster ${process.pid} still running after stop; cluster directory ${alive} kept$`, 'm'));
    assert.ok(existsSync(join(alive, 'data')), 'a still-running postmaster keeps its directory');
    const garbled = cluster(0); dirs.push(garbled); writeFileSync(join(garbled, 'data', 'postmaster.pid'), 'not-a-pid\n');
    r = run(['--cleanup-run', garbled], { PG_BIN: bin });
    assert.equal(r.status, 4); assert.match(r.stdout, /^RETAIN cleanup: postmaster\.pid unreadable/m); assert.ok(existsSync(garbled));
    // Positive control: a stopped postmaster (an exited pid) lets cleanup remove the directory.
    const exited = spawnSync('/bin/sh', ['-c', 'echo $$'], { encoding: 'utf8' });
    const stopped = cluster(Number(exited.stdout.trim()));
    r = run(['--cleanup-run', stopped], { PG_BIN: bin });
    assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /^REMOVED cleanup-run: /m); assert.ok(!existsSync(stopped));
    // Refusal still applies before any stop is attempted.
    r = run(['--cleanup-run', scratch], { PG_BIN: bin });
    assert.notEqual(r.status, 0); assert.match(r.stdout, /^REFUSE cleanup: /m); assert.ok(existsSync(scratch));
  } finally { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); }
});

let fixtureDir: string | null = null;
function fixture(): string {
  if (fixtureDir) return fixtureDir;
  const dir = join(scratch, 'fixture');
  const built = run(['--build-fixture', dir], { PG_BIN: PG() });
  assert.equal(built.status, 0, built.stdout + built.stderr);
  assert.match(built.stdout, /^PASS fixture:migrations: 68 pre-W2 migrations applied with their ledger rows$/m);
  return (fixtureDir = dir);
}

test('c1 W2 rehearsal: the current plan PASSES end to end on the repository pre-W2 fixture', { skip: skipDb }, () => {
  const env = { PG_BIN: PG() };
  const fixtureDir = fixture();

  const current = run([fixtureDir], env);
  assert.equal(current.status, 0, current.stdout + current.stderr);
  assert.match(current.stdout, /^PASS isolation: /m);
  for (const label of ['restore-schema', 'ai-db-session:ledger-before', 'ai-w2-preflight:ledger-and-reserves', 'ai-w2-preflight:before-catalogs',
    'ai-w2-measure', 'ai-w2-reconcile', 'ai-w2-apply', 'ai-w2-probes']) {
    assert.match(current.stdout, new RegExp(`^PASS ${label}$`, 'm'), label);
  }
  for (let i = 1; i <= 5; i++) assert.match(current.stdout, new RegExp(`^PASS ai-w2-apply:2026100300000${i}: `, 'm'));
  assert.doesNotMatch(current.stdout, /^FAIL /m);

  const reserve = run(['--reserve-control', fixtureDir], env);
  assert.equal(reserve.status, 0, reserve.stdout + reserve.stderr);
  assert.match(reserve.stdout, /^PASS control: every reserve applied and every reverse catalog true$/m);

  // --live-dump replaces only the exact live statements: a dump without them is refused, not guessed.
  const live = run(['--live-dump', fixtureDir], env);
  assert.notEqual(live.status, 0);
  assert.match(live.stdout, /^FAIL restore-schema: "CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;" expected once got 0$/m);

});

test('c1 W2 rehearsal: a failing inventory query fails ai-w2-preflight:before-catalogs (errexit is enforced)', { skip: skipDb }, () => {
  const r = run([fixture()], { PG_BIN: PG(), C1_W2_REHEARSAL_FAULT: 'preflight-inventory' });
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stdout, /^FAULT injected: the functions-before inventory query/m);
  assert.match(r.stdout, /^FAIL ai-w2-preflight:before-catalogs: .*relation "rehearsal_fault_missing_relation" does not exist$/m);
  assert.doesNotMatch(r.stdout, /^PASS ai-w2-preflight:before-catalogs$/m);
  assert.doesNotMatch(r.stdout, /^PASS ai-w2-measure$/m);
});

// Not skipped when the rehearsal is requested: a clone without the baseline commit FAILS this test.
// CI that sets RUN_PG_REHEARSAL=1 needs the commit (actions/checkout fetch-depth: 0, or git fetch origin 835b7ae8).
test('c1 W2 rehearsal: the released 835b7ae8 catalogs FAIL at before-catalogs for 20261003000004 (negative control)', { skip: skipDb }, () => {
  const present = spawnSync('git', ['cat-file', '-e', '835b7ae8^{commit}']);
  assert.equal(present.status, 0, 'baseline commit 835b7ae8 is absent from this clone: fetch it (fetch-depth: 0 or git fetch origin 835b7ae8)');
  const old = run(['--catalogs-from', '835b7ae8', fixture()], { PG_BIN: PG() });
  assert.notEqual(old.status, 0);
  // Errexit stops at the failing psql call, as on the box; the failing file names the version.
  assert.match(old.stdout, /^FAIL ai-w2-preflight:before-catalogs: .*ERROR: +schema "commonswarm_ops" does not exist \(last SQL file: \/proof\/catalog\.sql -> \/release\/deploy\/release-proofs\/item-ai\/20261003000004-rollback-catalog\.sql\)$/m);
  assert.doesNotMatch(old.stdout, /^PASS ai-w2-measure$/m, 'nothing after the failed step runs');
});
