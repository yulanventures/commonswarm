/*
 * C1 W2 rehearsal harness (scripts/c1-w2-rehearsal.sh). Release 835b7ae8 STOPPED in ai-w2-preflight: its reverse
 * catalogs raised "does not exist" on the live pre-W2 database. The static tests always run. The database tests
 * run only with RUN_PG_REHEARSAL=1 and local PostgreSQL binaries (PG_BIN, initdb on PATH, or Homebrew
 * postgresql@17): they build the repository's own 68-version pre-W2 fixture, prove the 835b7ae8 catalogs FAIL
 * on it (negative control), and prove the current plan runs the W2 SQL end to end (positive control).
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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

test('c1 W2 rehearsal: a failed or incomplete postmaster stop keeps the cluster directory and exits nonzero', { timeout: 120_000 }, () => {
  // Stub pg_ctl in a test-owned directory; each fixture records a postmaster pid (and, like a real start, its identity).
  const bin = join(scratch, 'stub-bin'); mkdirSync(bin, { recursive: true });
  const stub = (status: number) => { writeFileSync(join(bin, 'pg_ctl'), `#!/bin/sh\nexit ${status}\n`); chmodSync(join(bin, 'pg_ctl'), 0o755); };
  const cluster = (pid: number, identity = true) => {
    const dir = mkdtempSync('/tmp/c1w2.'); mkdirSync(join(dir, 'data'));
    writeFileSync(join(dir, 'data', 'postmaster.pid'), `${pid}\n${join(dir, 'data')}\n`);
    if (identity) {
      const r = run(['--record-identity', dir]); assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.ok(existsSync(join(dir, 'postmaster.identity')), `identity recorded for live pid ${pid}`);
    }
    return dir;
  };
  const timed = (args: string[], env: Record<string, string>) => { const t0 = Date.now(); const r = run(args, env); return { r, seconds: (Date.now() - t0) / 1000 }; };
  const dirs: string[] = [], pids: number[] = [];
  try {
    stub(1);
    const failed = cluster(process.pid); dirs.push(failed);
    let r = run(['--cleanup-run', failed], { PG_BIN: bin });
    assert.equal(r.status, 4, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`^RETAIN cleanup: pg_ctl stop failed; postmaster ${process.pid} may still run; cluster directory ${failed} kept$`, 'm'));
    assert.ok(existsSync(join(failed, 'data', 'postmaster.pid')), 'a failed stop never reaches rm');
    stub(0);
    // A postmaster that never exits: RETAIN after waiting the whole (shortened) bound, not at once; directory kept.
    const alive = cluster(process.pid); dirs.push(alive);
    let w = timed(['--cleanup-run', alive], { PG_BIN: bin, C1_W2_CLEANUP_WAIT_TENTHS: '20' });
    assert.equal(w.r.status, 4, w.r.stdout + w.r.stderr); assert.ok(w.seconds >= 1.8 && w.seconds < 10, `waited ${w.seconds} s for a 2.0 s bound`);
    assert.match(w.r.stdout, new RegExp(`^RETAIN cleanup: postmaster ${process.pid} still running or unverified 2\\.0 s after stop; cluster directory ${alive} kept$`, 'm'));
    assert.ok(existsSync(join(alive, 'data')));
    // Malformed and oversized wait values fall back to the 10 s bound (never longer, never zero).
    for (const value of ['abc', '999']) {
      const again = cluster(process.pid); dirs.push(again);
      w = timed(['--cleanup-run', again], { PG_BIN: bin, C1_W2_CLEANUP_WAIT_TENTHS: value });
      assert.equal(w.r.status, 4); assert.match(w.r.stdout, / still running or unverified 10\.0 s after stop;/); assert.ok(w.seconds >= 9.5 && w.seconds < 30, `${value}: ${w.seconds} s`);
    }
    // A process of another user (pid 1; kill -0 would answer EPERM) with a valid identity: never "gone", so kept after
    // the wait.
    // (macOS denies its state: unknown, waits; Linux reads it, start time differs, then pgrep -g 1 finds init.)
    const foreign = cluster(1, false); dirs.push(foreign); writeFileSync(join(foreign, 'postmaster.identity'), '1 1.000000\n');
    w = timed(['--cleanup-run', foreign], { PG_BIN: bin, C1_W2_CLEANUP_WAIT_TENTHS: '5' });
    assert.equal(w.r.status, 4, w.r.stdout);
    assert.match(w.r.stdout, /^RETAIN cleanup: (?:postmaster 1 still running or unverified 0\.5 s after stop|processes of this cluster remain or cannot be checked after the postmaster exit);/m);
    assert.ok(existsSync(foreign));
    // A postmaster still exiting when pg_ctl -w returns (an orphan that exits after 1.5 s, reaped by init/launchd):
    // cleanup waits for it, then removes the directory.
    const exitingPid = Number(spawnSync('/bin/sh', ['-c', 'sleep 1.5 >/dev/null 2>&1 & echo $!'], { encoding: 'utf8' }).stdout.trim());
    assert.ok(exitingPid > 0);
    const slow = cluster(exitingPid);
    w = timed(['--cleanup-run', slow], { PG_BIN: bin });
    assert.equal(w.r.status, 0, w.r.stdout + w.r.stderr); assert.match(w.r.stdout, /^REMOVED cleanup-run: /m); assert.ok(!existsSync(slow));
    assert.ok(w.seconds >= 1, 'cleanup waited for the exiting postmaster');
    // An exited postmaster whose child still runs in its process group: the parent is gone, the cluster is not.
    const tree = spawn('python3', ['-c', 'import os,sys,time\nos.setsid()\nif os.fork()==0:\n    time.sleep(30); os._exit(0)\nprint(os.getpid(),flush=True); time.sleep(1.5)'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const parentPid = Number(spawnSync('/bin/sh', ['-c', `until test -n "$(pgrep -g ${tree.pid} 2>/dev/null)"; do sleep 0.1; done; echo ${tree.pid}`], { encoding: 'utf8', timeout: 10_000 }).stdout.trim());
    assert.equal(parentPid, tree.pid); pids.push(...spawnSync('pgrep', ['-g', String(tree.pid)], { encoding: 'utf8' }).stdout.trim().split('\n').map(Number).filter(n => n && n !== tree.pid));
    const orphaned = cluster(parentPid); dirs.push(orphaned);
    spawnSync('/bin/sleep', ['2']);
    w = timed(['--cleanup-run', orphaned], { PG_BIN: bin });
    assert.equal(w.r.status, 4, w.r.stdout + w.r.stderr);
    assert.match(w.r.stdout, new RegExp(`^RETAIN cleanup: processes of this cluster remain or cannot be checked after the postmaster exit; cluster directory ${orphaned} kept$`, 'm'));
    assert.ok(existsSync(orphaned));
    // A reused pid: the recorded identity is gone (another start time), but a process naming this cluster's data
    // directory survives: kept.
    const reused = mkdtempSync('/tmp/c1w2.'); mkdirSync(join(reused, 'data')); dirs.push(reused);
    const survivor = spawn('python3', ['-c', 'import time; time.sleep(30)', join(reused, 'data')], { stdio: 'ignore' }); pids.push(survivor.pid!);
    writeFileSync(join(reused, 'data', 'postmaster.pid'), `${survivor.pid}\n${join(reused, 'data')}\n`);
    writeFileSync(join(reused, 'postmaster.identity'), `${survivor.pid} 1.000000\n`);
    spawnSync('/bin/sleep', ['0.5']);
    r = run(['--cleanup-run', reused], { PG_BIN: bin, C1_W2_CLEANUP_WAIT_TENTHS: '5' });
    assert.equal(r.status, 4, r.stdout + r.stderr); assert.match(r.stdout, /^RETAIN cleanup: processes of this cluster remain or cannot be checked/m); assert.ok(existsSync(reused));
    // An exited but unreaped postmaster with its recorded start time (a zombie still answers kill -0) counts as gone.
    const zombie = spawn('/bin/sh', ['-c', 'sleep 0.3'], { stdio: 'ignore' });
    const reaped = cluster(zombie.pid!);
    spawnSync('/bin/sleep', ['1']);
    r = run(['--cleanup-run', reaped], { PG_BIN: bin, C1_W2_CLEANUP_WAIT_TENTHS: '5' });
    assert.equal(r.status, 0, r.stdout + r.stderr); assert.ok(!existsSync(reaped));
    // postmaster.pid removed while the recorded postmaster is alive: the identity still governs, so the directory is kept.
    const noPidFile = cluster(process.pid); dirs.push(noPidFile); rmSync(join(noPidFile, 'data', 'postmaster.pid'));
    w = timed(['--cleanup-run', noPidFile], { PG_BIN: bin, C1_W2_CLEANUP_WAIT_TENTHS: '5' });
    assert.equal(w.r.status, 4, w.r.stdout + w.r.stderr); assert.ok(w.seconds >= 0.4, 'it waited on the recorded postmaster');
    assert.match(w.r.stdout, new RegExp(`^RETAIN cleanup: postmaster ${process.pid} still running or unverified 0\\.5 s after stop; cluster directory ${noPidFile} kept$`, 'm'));
    // postmaster.pid removed, the recorded postmaster exited, a child of its process group still runs: kept.
    const tree2 = spawn('python3', ['-c', 'import os,time\nos.setsid()\nif os.fork()==0:\n    time.sleep(30); os._exit(0)\ntime.sleep(1.5)'], { stdio: 'ignore' });
    spawnSync('/bin/sh', ['-c', `until test -n "$(pgrep -g ${tree2.pid} 2>/dev/null)"; do sleep 0.1; done`], { timeout: 10_000 });
    pids.push(...spawnSync('pgrep', ['-g', String(tree2.pid)], { encoding: 'utf8' }).stdout.trim().split('\n').map(Number).filter(n => n && n !== tree2.pid));
    const childOnly = cluster(tree2.pid!); dirs.push(childOnly); rmSync(join(childOnly, 'data', 'postmaster.pid'));
    spawnSync('/bin/sleep', ['2']);
    r = run(['--cleanup-run', childOnly], { PG_BIN: bin });
    assert.equal(r.status, 4, r.stdout + r.stderr); assert.match(r.stdout, /^RETAIN cleanup: processes of this cluster remain or cannot be checked/m); assert.ok(existsSync(childOnly));
    // No identity and no pid file, but a data directory (and a process naming it): kept by the one rule.
    const unknownDir = mkdtempSync('/tmp/c1w2.'); mkdirSync(join(unknownDir, 'data')); dirs.push(unknownDir);
    const named = spawn('python3', ['-c', 'import time; time.sleep(30)', join(unknownDir, 'data')], { stdio: 'ignore' }); pids.push(named.pid!);
    spawnSync('/bin/sleep', ['0.5']);
    r = run(['--cleanup-run', unknownDir], { PG_BIN: bin });
    assert.equal(r.status, 4, r.stdout + r.stderr); assert.match(r.stdout, /^RETAIN cleanup: postmaster\.identity absent while a data directory exists \(identity never recorded\); cluster directory \S+ kept$/m); assert.ok(existsSync(unknownDir));
    // Recording failed at start (no identity file), the postmaster exited and removed its pid file, and a child of its
    // process group that does NOT name the data directory still runs: kept.
    const tree3 = spawn('python3', ['-c', 'import os,time\nos.setsid()\nif os.fork()==0:\n    time.sleep(30); os._exit(0)\ntime.sleep(0.5)'], { stdio: 'ignore' });
    spawnSync('/bin/sh', ['-c', `until test -n "$(pgrep -g ${tree3.pid} 2>/dev/null)"; do sleep 0.1; done`], { timeout: 10_000 });
    pids.push(...spawnSync('pgrep', ['-g', String(tree3.pid)], { encoding: 'utf8' }).stdout.trim().split('\n').map(Number).filter(n => n && n !== tree3.pid));
    const unrecorded = cluster(tree3.pid!, false); dirs.push(unrecorded); rmSync(join(unrecorded, 'data', 'postmaster.pid'));
    spawnSync('/bin/sleep', ['1']);
    r = run(['--cleanup-run', unrecorded], { PG_BIN: bin });
    assert.equal(r.status, 4, r.stdout + r.stderr); assert.match(r.stdout, /^RETAIN cleanup: postmaster\.identity absent while a data directory exists \(identity never recorded\); cluster directory \S+ kept$/m); assert.ok(existsSync(unrecorded));
    // Recording failed and nothing of the cluster is alive: still kept, by the rule (absence is not evidence).
    const quiet = mkdtempSync('/tmp/c1w2.'); mkdirSync(join(quiet, 'data')); dirs.push(quiet);
    r = run(['--cleanup-run', quiet], { PG_BIN: bin });
    assert.equal(r.status, 4, r.stdout + r.stderr); assert.match(r.stdout, /^RETAIN cleanup: postmaster\.identity absent while a data directory exists \(identity never recorded\); cluster directory \S+ kept$/m); assert.ok(existsSync(quiet));
    // postmaster.pid absent and postmaster.identity present but empty, malformed or unreadable: never deleted.
    for (const [name, body, mode] of [['empty', '', 0o600], ['malformed', 'not an identity\n', 0o600], ['unreadable', `${process.pid} 1.000000\n`, 0o000]] as const) {
      if (name === 'unreadable' && process.getuid?.() === 0) continue; // root reads a 000 file
      const bad = mkdtempSync('/tmp/c1w2.'); mkdirSync(join(bad, 'data')); dirs.push(bad);
      writeFileSync(join(bad, 'postmaster.identity'), body); chmodSync(join(bad, 'postmaster.identity'), mode);
      r = run(['--cleanup-run', bad], { PG_BIN: bin });
      assert.equal(r.status, 4, `${name}: ${r.stdout}${r.stderr}`); assert.ok(existsSync(join(bad, 'postmaster.identity')), name);
      assert.match(r.stdout, name === 'unreadable' ? /^RETAIN cleanup: postmaster\.identity present but unreadable;/m : /^RETAIN cleanup: postmaster\.identity present but empty or malformed;/m, name);
      chmodSync(join(bad, 'postmaster.identity'), 0o600);
    }
    // Positive control: a directory where no cluster ever started (no identity, no data directory) is deleted.
    const never = mkdtempSync('/tmp/c1w2.');
    r = run(['--cleanup-run', never], { PG_BIN: bin });
    assert.equal(r.status, 0, r.stdout + r.stderr); assert.ok(!existsSync(never));
    const garbled = cluster(0, false); dirs.push(garbled); writeFileSync(join(garbled, 'data', 'postmaster.pid'), 'not-a-pid\n');
    writeFileSync(join(garbled, 'postmaster.identity'), `${process.pid} 1.000000\n`);
    r = run(['--cleanup-run', garbled], { PG_BIN: bin });
    assert.equal(r.status, 4); assert.match(r.stdout, /^RETAIN cleanup: postmaster\.pid unreadable/m); assert.ok(existsSync(garbled));
    // Positive control: a stopped postmaster (an exited, reaped pid) with its valid identity: the directory is removed.
    const exited = spawnSync('/bin/sh', ['-c', 'echo $$'], { encoding: 'utf8' });
    const stopped = cluster(Number(exited.stdout.trim()), false);
    writeFileSync(join(stopped, 'postmaster.identity'), `${exited.stdout.trim()} 1.000000\n`);
    r = run(['--cleanup-run', stopped], { PG_BIN: bin });
    assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /^REMOVED cleanup-run: /m); assert.ok(!existsSync(stopped));
    // Refusal still applies before any stop is attempted.
    r = run(['--cleanup-run', scratch], { PG_BIN: bin });
    assert.notEqual(r.status, 0); assert.match(r.stdout, /^REFUSE cleanup: /m); assert.ok(existsSync(scratch));
  } finally {
    for (const pid of pids) { try { process.kill(pid); } catch { /* exited */ } }
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  }
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

test('c1 W2 rehearsal: --issuer listens on 127.0.0.1 only, with hostssl for the issuer and every other TCP connection rejected', () => {
  assert.equal(source.match(/listen_addresses='[^']*'/g)?.sort().join(' '), "listen_addresses='' listen_addresses='127.0.0.1'");
  assert.match(source, /'hostssl postgres commonswarm_admin_issuer 127\.0\.0\.1\/32 scram-sha-256'/);
  assert.match(source, /'host all all 0\.0\.0\.0\/0 reject' 'host all all ::\/0 reject'/);
  assert.doesNotMatch(source, /^\s*host(?:ssl)? [^\n]*(?:trust|password|md5)\b/m, 'no TCP trust or cleartext line');
  // The plan's issuer block is executed from RELEASE.md bytes, not retyped.
  assert.match(source, /extract "\$ISSUER_PLAN" ai-w2-issuer-credential lines 'openssl rand -hex 32/);
  assert.match(source, /extract "\$ISSUER_PLAN" ai-w2-issuer-credential command-sql/);
  assert.doesNotMatch(source, /-CAcreateserial/, 'no CA serial file outside the mktemp directory');
});

// The real libpq rehearsal: the fixed issuer block logs in over verify-full TLS; the released 5f64fab4 block fails as
// production W2 RGLqZX did. Needs openssl, lsof and node besides PostgreSQL 17, and commit 5f64fab4 in the clone.
test('c1 W2 rehearsal: --issuer real libpq verify-full login PASSES; the 5f64fab4 issuer block FAILS with a service-file syntax error', { skip: skipDb }, () => {
  for (const tool of ['openssl', 'lsof', 'node']) assert.equal(spawnSync('/bin/sh', ['-c', `command -v ${tool}`]).status, 0, `${tool} is required for --issuer`);
  const env = { PG_BIN: PG() };
  const good = run(['--issuer', fixture()], env);
  assert.equal(good.status, 0, good.stdout + good.stderr);
  for (const line of [/^PASS ai-w2-issuer-rollback:role$/m, /^PASS ai-w2b-preflight:preconditions$/m, /^PASS tls: cluster restarted with ssl=on on 127\.0\.0\.1:\d+;/m,
    /^PASS listener: postmaster \d+ listens on TCP 127\.0\.0\.1:\d+ only/m, /^PASS service-conf: /m, /^PASS ai-w2-issuer-credential:prepare$/m,
    /^PASS ai-w2-issuer-credential:alter-role$/m, /^PASS ai-w2-issuer-credential:login: real libpq sslmode=verify-full TLS login as commonswarm_admin_issuer/m,
    /^PASS issuer-plaintext: /m, /^PASS ai-w2-issuer-credential:proof$/m, /^PASS ai-w2b-forward-catalogs$/m,
    /^PASS cleanup: cluster stopped; data, CA and secrets deleted; \S+ absent$/m]) assert.match(good.stdout, line);
  assert.doesNotMatch(good.stdout + good.stderr, /\b[0-9a-f]{48,64}\b/, 'no generated password is printed');
  const present = spawnSync('git', ['cat-file', '-e', '5f64fab4^{commit}']);
  assert.equal(present.status, 0, 'commit 5f64fab4 is absent from this clone: fetch it (fetch-depth: 0 or git fetch origin 5f64fab4)');
  const old = run(['--issuer', '--plan-from', '5f64fab4', fixture()], env);
  assert.notEqual(old.status, 0);
  assert.match(old.stdout, /^FAIL ai-w2-issuer-credential:login: libpq login exit status expected 0 got nonzero: syntax error in service file "[^"]+issuer-service\.conf", line 2$/m);
  assert.match(old.stdout, /^PASS cleanup: /m);
});

test('c1 W2 rehearsal: the W2b database preconditions FAIL on the pre-W2 fixture at the ledger precondition', { skip: skipDb }, () => {
  const pre = run(['--w2b-preconditions', fixture()], { PG_BIN: PG() });
  assert.notEqual(pre.status, 0);
  assert.match(pre.stdout, /^FAIL ai-w2b-preflight:preconditions: FAIL ai-w2b-preflight: ledger five-20261003-nothing-later and NOLOGIN issuer without password expected t got other; STOP; w2b-preconditions failed checks: [a-z0-9,-]*w2b-ledger-five-20261003/m);
  assert.match(pre.stdout, /^PASS cleanup: /m);
});

// A POST-W2 dump (HezLead's live rehearsal-post-w2 shape) made by the plan's own W2 apply, then its issuer rollback.
let postFixtureDir: string | null = null;
const headSha = (): string => spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
function postFixture(): string {
  if (postFixtureDir) return postFixtureDir;
  const dir = join(scratch, 'fixture-post-w2');
  const built = run(['--dump-post-w2', dir, fixture()], { PG_BIN: PG() });
  assert.equal(built.status, 0, built.stdout + built.stderr);
  assert.match(built.stdout, /^PASS ai-w2-probes$/m);
  assert.match(built.stdout, /^PASS dump-post-w2: roles\.sql, schema\.sql, ledger\.sql and ledger-extra\.sql \(checksums, cutover state\) of the post-W2 database, issuer rolled back$/m);
  return (postFixtureDir = dir);
}

test('c1 W2 rehearsal: --from-post-w2 runs --issuer and --w2b-preconditions on a post-W2 dump without the W2 apply', { skip: skipDb }, () => {
  const env = { PG_BIN: PG() };
  const issuer = run(['--from-post-w2', '--w2-release-sha', headSha(), '--issuer', postFixture()], env);
  assert.equal(issuer.status, 0, issuer.stdout + issuer.stderr);
  assert.match(issuer.stdout, /^PASS post-w2-ledger: all five 20261003 versions present \(5 versions from 20261003 on\); W2 apply skipped$/m);
  assert.match(issuer.stdout, /^PASS restore-ledger-extra$/m);
  for (const line of [/^PASS ai-w2b-preflight:preconditions$/m, /^PASS ai-w2-issuer-credential:login: real libpq sslmode=verify-full TLS login/m, /^PASS issuer-plaintext: /m, /^PASS cleanup: /m]) {
    assert.match(issuer.stdout, line);
  }
  // Nothing of the W2 apply or the rollback statement runs on a post-W2 dump.
  assert.doesNotMatch(issuer.stdout, /^(?:PASS|FAIL) (?:ai-db-session|ai-w2-preflight|ai-w2-measure|ai-w2-apply|ai-w2-probes|ai-w2-issuer-rollback)/m);
  const pre = run(['--from-post-w2', '--w2-release-sha', headSha(), '--w2b-preconditions', postFixture()], env);
  assert.equal(pre.status, 0, pre.stdout + pre.stderr);
  assert.match(pre.stdout, /^PASS ai-w2b-preflight:preconditions$/m);
  const old = run(['--from-post-w2', '--w2-release-sha', headSha(), '--issuer', '--plan-from', '5f64fab4', postFixture()], env);
  assert.notEqual(old.status, 0);
  assert.match(old.stdout, /^FAIL ai-w2-issuer-credential:login: libpq login exit status expected 0 got nonzero: syntax error in service file "[^"]+issuer-service\.conf", line 2$/m);
});

test('c1 W2 rehearsal: the dump ledger must agree with --from-post-w2', { skip: skipDb }, () => {
  const env = { PG_BIN: PG() };
  const flagOnPre = run(['--from-post-w2', '--w2-release-sha', headSha(), '--w2b-preconditions', fixture()], env);
  assert.notEqual(flagOnPre.status, 0); assert.match(flagOnPre.stdout, /^FAIL post-w2-ledger: five 20261003 ledger versions expected got 0; not a post-W2 dump$/m);
  const postWithoutFlag = run(['--issuer', postFixture()], env);
  assert.notEqual(postWithoutFlag.status, 0); assert.match(postWithoutFlag.stdout, /^FAIL pre-w2-ledger: no 20261003-or-later ledger version expected got 5; a post-W2 dump needs --from-post-w2$/m);
  assert.doesNotMatch(postWithoutFlag.stdout, /^PASS ai-w2-apply/m);
  // A checksum recorded at another release is refused (the W2b checksum precondition binds w2_release_sha).
  const otherRelease = run(['--from-post-w2', '--w2-release-sha', 'f'.repeat(40), '--w2b-preconditions', postFixture()], env);
  assert.notEqual(otherRelease.status, 0);
  assert.match(otherRelease.stdout, /^FAIL ai-w2b-preflight:preconditions: FAIL ai-w2b-preflight: 20261003000001 checksum row expected release-file-sha256-backfill-at-w2_release_sha got other; STOP/m);
  for (const args of [['--from-post-w2', '--w2-release-sha', headSha(), fixture()], ['--from-post-w2', '--issuer', fixture()],
    ['--from-post-w2', '--w2-release-sha', headSha(), '--reserve-control', '--issuer', fixture()], ['--from-post-w2', '--w2-release-sha', headSha(), '--catalogs-from', '835b7ae8', '--issuer', fixture()],
    ['--w2-release-sha', headSha(), '--issuer', fixture()], ['--dump-post-w2', join(scratch, 'never'), '--issuer', fixture()]]) {
    const r = run(args, env); assert.notEqual(r.status, 0, args.join(' ')); assert.match(r.stdout, /^FAIL usage: /m);
  }
});

// HezLead's live split: ledger.sql (ledger) plus a data-only ledger-extra.sql (checksums, cutover state).
test('c1 W2 rehearsal: ledger-extra.sql is restored when present, SKIPped when absent; the W2b preconditions need its checksum and cutover rows', { skip: skipDb }, () => {
  const env = { PG_BIN: PG() };
  const variant = (name: string, extra: string | null) => {
    const dir = join(scratch, name); mkdirSync(dir);
    for (const file of ['roles.sql', 'schema.sql', 'ledger.sql']) copyFileSync(join(postFixture(), file), join(dir, file));
    if (extra !== null) writeFileSync(join(dir, 'ledger-extra.sql'), extra);
    return dir;
  };
  const extra = readFileSync(join(postFixture(), 'ledger-extra.sql'), 'utf8');
  assert.match(extra, /^COPY commonswarm_ops\.migration_checksums /m); assert.match(extra, /^COPY commonswarm_oauth\.admin_cutover_state /m);
  // Without the extra file: SKIP line, and the checksum precondition refuses (no checksum rows).
  const none = run(['--from-post-w2', '--w2-release-sha', headSha(), '--w2b-preconditions', variant('post-no-extra', null)], env);
  assert.notEqual(none.status, 0);
  assert.match(none.stdout, /^SKIP restore-ledger-extra: \S+ledger-extra\.sql absent$/m);
  assert.match(none.stdout, /^FAIL ai-w2b-preflight:preconditions: FAIL ai-w2b-preflight: checksum rows expected one-per-ledger-version got other; STOP$/m);
  // Checksums but no cutover state: the plan's own forward catalog 0003 row 064 (the cutover singleton) refuses.
  const noCutover = extra.replace(/^COPY commonswarm_oauth\.admin_cutover_state [^\n]*\n[\s\S]*?^\\\.\n/m, '');
  assert.notEqual(noCutover, extra);
  const cut = run(['--from-post-w2', '--w2-release-sha', headSha(), '--w2b-preconditions', variant('post-no-cutover', noCutover)], env);
  assert.notEqual(cut.status, 0); assert.match(cut.stdout, /^PASS restore-ledger-extra$/m);
  assert.match(cut.stdout, /^FAIL ai-w2b-preflight:preconditions: FAIL ai-w2b-preflight: forward catalog 20261003000003 expected all-rows-true \(0002: only the issuer LOGIN row\) got failed checks 20261003000003-064-commonswarm_oauth-admin_cutover_state; STOP/m);
  // A broken extra file stops the restore (ON_ERROR_STOP).
  const broken = run(['--from-post-w2', '--w2-release-sha', headSha(), '--w2b-preconditions', variant('post-broken-extra', 'INSERT INTO no_such_table VALUES (1);\n')], env);
  assert.notEqual(broken.status, 0); assert.match(broken.stdout, /^FAIL restore-ledger-extra: .*no_such_table/m);
  // A pre-W2 dump without the extra file still runs: SKIP, then the usual W2 rehearsal.
  const pre = run(['--w2b-preconditions', fixture()], env);
  assert.match(pre.stdout, /^SKIP restore-ledger-extra: /m);
});

// The plan's post-credential forward catalogs block on a real database: a false catalog after provisioning STOPs and
// runs the plan's issuer rollback (control for the production step, not a harness loop).
test('c1 W2 rehearsal: a forward catalog made false after the credential STOPs ai-w2b-forward-catalogs and rolls the issuer back', { skip: skipDb }, () => {
  const r = run(['--issuer', fixture()], { PG_BIN: PG(), C1_W2_REHEARSAL_FAULT: 'post-credential-catalog' });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /^PASS ai-w2-issuer-credential:login: /m);
  assert.match(r.stdout, /^FAULT injected: the issuer role made INHERIT after the credential/m);
  assert.match(r.stdout, /^FAIL ai-w2b-forward-catalogs: FAIL ai-w2b-forward-catalogs: forward catalog 20261003000002 expected t got other; running ai-w2-issuer-rollback; STOP$/m);
  assert.match(r.stdout, /^PASS rollback-after-catalog-failure: ai-w2-issuer-rollback ran \(issuer NOLOGIN without a password, issuer-rollback\.txt\); no w2b-forward-catalogs\.txt$/m);
  assert.doesNotMatch(r.stdout, /^PASS ai-w2b-forward-catalogs$/m);
  assert.match(r.stdout, /^PASS cleanup: /m);
});

// ---------------- --w6: W4, recycle hook, W6 activation/C1/G3/finish, W7, recycles (lane/w6-ready) ----------------
const w6Steps = readFileSync(resolve('scripts/c1-w6-rehearsal-steps.sh'), 'utf8');

test('c1 W6 rehearsal: the sourced steps are Bash 3.2 syntax, run plan slices from the remapped copy, and --w6 needs --from-post-w2 --issuer', () => {
  const syntax = spawnSync('/bin/bash', ['-n', resolve('scripts/c1-w6-rehearsal-steps.sh')], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
  assert.doesNotMatch(w6Steps, /\$\([^)]*<</, 'no heredoc inside $(...)');
  assert.doesNotMatch(w6Steps, /\bHOME=/, 'HOME is never assigned');
  assert.doesNotMatch(w6Steps, /\brm\b/, 'the steps delete nothing; the main script removes only its own mktemp directory');
  assert.match(source, /\. "\$REPO\/scripts\/c1-w6-rehearsal-steps\.sh"/);
  // The copy differs from the plan only by the listed prefixes, and the reverse map must restore it byte for byte.
  assert.match(w6Steps, /assert back==raw/);
  for (const step of ['ai-w4-apply', 'ai-w4-readback', 'ai-recycle-hook', 'ai-edge-receipt', 'ai-edge-refresh', 'ai-edge-remeasure', 'ai-w6-activation-checks',
    'ai-w6-client-verification', 'ai-w6-activation-apply', 'ai-w6-activation-readback', 'ai-w6-activation-rollback', 'ai-w6-client-check', 'ai-w6-audit',
    'ai-w6-fence-readback', 'ai-w6-finish', 'ai-w7-preflight', 'ai-w7-proof', 'ai-w4-timer-recovery']) {
    assert.match(w6Steps, new RegExp(`(?:\\bx|extract "\\$PLANC") ${step} (?:block|line|lines|from)\\b`), `${step} comes from the plan copy`);
  }
  for (const args of [['--w6', join(scratch, 'none')], ['--issuer', '--w6', join(scratch, 'none')], ['--from-post-w2', '--w2-release-sha', 'a'.repeat(40), '--w2b-preconditions', '--w6', join(scratch, 'none')],
    ['--from-post-w2', '--w2-release-sha', 'a'.repeat(40), '--issuer', '--plan-from', '5f64fab4', '--w6', join(scratch, 'none')]]) {
    const r = run(args); assert.notEqual(r.status, 0, args.join(' ')); assert.match(r.stdout, /^FAIL usage: /m, args.join(' '));
  }
});

test('c1 W6 rehearsal: --w6 PASSES on the post-W2 database: W4 fence, recycle hook, F2 trigger negatives, activation, G3 both orders, both keep_open finishes, W7, ruling-1 recycles, timer re-arm', { skip: skipDb }, () => {
  for (const tool of ['openssl', 'lsof', 'node']) assert.equal(spawnSync('/bin/sh', ['-c', `command -v ${tool}`]).status, 0, `${tool} is required for --w6`);
  const r = run(['--from-post-w2', '--w2-release-sha', headSha(), '--issuer', '--w6', postFixture()], { PG_BIN: PG() });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const line of [
    /^REMAP plan copy: .*; the reverse map restores the plan bytes exactly$/m,
    /^PASS ai-w4-apply:legacy-fence-and-measure$/m, /^PASS ai-w4-readback$/m, /^PASS w4-legacy-fence: legacy_closed false -> true by apply_legacy_admin_fence/m,
    /^PASS ai-edge-receipt:W4-measurement$/m, /^PASS ai-edge-refresh:before-W6-open$/m,
    /^PASS ai-edge-receipt:stale-generation: refused \(generation\/release_generation\/measured_generation\)$/m,
    /^PASS ai-w6-activation-checks:db-measurement-g4$/m, /^PASS ai-w6-activation-checks:g4-archive-missing: refused /m,
    /^PASS ai-w6-client-verification:digest-not-the-document: refused /m, /^PASS ai-w6-client-verification$/m, /^PASS c1-verification:idempotent: /m,
    /^PASS ai-w6-client-verification:second-active-version: refused \(another active C1 verification version\)$/m,
    /^PASS guard_verified_client:http-redirect: refused \(admin redirect must be public HTTPS\)$/m,
    /^PASS ai-w6-client-verification:existing-row-differs: refused \(existing C1 verification differs\)$/m,
    /^PASS guard_verified_client:update-reviewed-field: refused \(changed verification requires a new reviewed version\)$/m,
    /^PASS guard_verified_client:delete: refused \(verification history is immutable\)$/m,
    /^PASS w6-apply-failure-rearms: /m, /^PASS ai-w6-activation-apply:remeasure-and-activate$/m, /^PASS w6-timer-held: /m, /^PASS ai-w6-activation-readback$/m,
    /^PASS ai-w6-client-verification:issuance-open: refused \(C1 verification requires issuance closed\)$/m,
    /^PASS ai-w6-client-check$/m, /^PASS ai-w6-audit$/m, /^PASS ai-w6-audit:counts: \{"action": 1, "init": 1, "list": 1, "read": 1\}$/m,
    /^PASS g3-wrong-order \(rolled back\): withdrawal first fences the family itself/m, /^PASS ai-w6-fence-readback$/m, /^PASS g3-right-order: /m,
    /^EMUL ai-w6-human-revoke: /m, /^EMUL ai-w6-owner-client-command withdraw: /m,
    /^PASS ai-w6-finish:default-closed$/m, /^PASS w6-finish-default: closed and measured/m, /^PASS ai-edge-receipt:W6-default-final$/m,
    /^PASS ai-w6-finish:keep-open$/m, /^PASS w6-finish-keep-open: reopened only through the measured hook path/m, /^PASS ai-edge-receipt:W6-keep-open-final-for-W7$/m,
    /^PASS ai-w7-proof:binding-and-sql$/m, /^PASS ai-w7-preflight:other-w6: refused /m,
    /^PASS w6-apply-failure-marker: one journal line and one 0644 log line, unit ai-edge-remeasure, reason edge-measurement-failed, measured null$/m,
    /^PASS recycle-good-reopens: no marker; before \[true gen=\d+ measured=\d+ invalidated=false\] after \[true gen=\d+ measured=\d+ invalidated=false\]$/m,
    /^PASS recycle-bad-stays-closed: hook after refused the wrong image; one marker \(journal \+ 0644 log, unit rehearsal-edge-recycle\.service, reason edge-measurement-failed\); before \[true [^\]]*\] after \[false gen=\d+ measured=\d+ invalidated=true\]$/m,
    /^PASS recycle-after-bad-stays-closed: no new marker; .* after \[false gen=\d+ measured=\d+ invalidated=false\]$/m,
    /^PASS recycle-marker-failure-close-stands: journal and log refused; the failure is reported and the readback-confirmed CLOSED state stands; /m,
    /^PASS remeasure-postfail-closes: the hook pair reopened, the row read then failed, and the hook close mode closed and invalidated issuance with one marker/m,
    /^PASS recycle-lost-reopen-response: the reopen committed, its response was lost; the hook closed again and confirmed CLOSED by readback before one CLOSED marker; /m,
    /^PASS ai-w6-finish:keep-open-close-refused: refused \(FAIL ai-w6-finish: issuance state UNKNOWN after the remeasure failure \(may be OPEN\)\)$/m,
    /^PASS w6-finish-unknown-propagates: /m, /^PASS ai-emergency-close:recover-unknown$/m,
    /^PASS emergency-close-rearms: /m, /^PASS rehearsal: W4, recycle hook, W6 activation/m, /^PASS cleanup: /m]) assert.match(r.stdout, line);
  // ai-close's timer line runs after ai-w6-finish in the same shell, for both finish paths.
  assert.equal(r.stdout.match(/^PASS ai-close:timer-line after ai-w6-finish in the same shell$/gm)?.length, 2);
  assert.doesNotMatch(r.stdout, /^FAIL /m);
});

test('c1 W6 rehearsal: negative controls: the release-role checksum gate (plan at 13512a34) and a one-statement open close both FAIL', { skip: skipDb }, () => {
  const present = spawnSync('git', ['cat-file', '-e', '13512a34^{commit}']);
  assert.equal(present.status, 0, 'commit 13512a34 is absent from this clone: fetch it (fetch-depth: 0)');
  const args = ['--from-post-w2', '--w2-release-sha', headSha(), '--issuer', '--w6', postFixture()];
  // 13512a34: the recycle hook ran migration_checksum_failures() as commonswarm_admin_release, which M4 does not grant.
  const old = run(args, { PG_BIN: PG(), C1_W6_PLAN_FROM: '13512a34' });
  assert.notEqual(old.status, 0);
  assert.match(old.stdout, /^CONTROL w6-plan-from: W4\/W6\/W7 blocks from the plan at 13512a34$/m);
  assert.match(old.stdout, /^PASS ai-edge-receipt:W4-measurement$/m);
  assert.match(old.stdout, /^FAIL ai-edge-refresh:before-W6-open: FAIL ai-edge-refresh: edge remeasure expected PASS got failure; STOP$/m);
  assert.match(old.stdout, /^PASS cleanup: /m);
  // guard_cutover_state refuses a generation bump in the same update that closes OPEN issuance.
  const fault = run(args, { PG_BIN: PG(), C1_W2_REHEARSAL_FAULT: 'one-statement-close' });
  assert.notEqual(fault.status, 0);
  assert.match(fault.stdout, /^FAULT injected: ai-recycle-hook before\/close and ai-w6-activation-rollback close and bump the generation in one update/m);
  assert.match(fault.stdout, /^PASS ai-w6-activation-readback$/m);
  assert.match(fault.stdout, /^FAIL ai-w6-finish:default-closed: .*ERROR: {2}close issuance before release measurement changes/m);
  assert.match(fault.stdout, /^PASS cleanup: /m);
});
