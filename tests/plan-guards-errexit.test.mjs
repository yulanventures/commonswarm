import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

const tempRoot = realpathSync(tmpdir());
const planFiles = {
  site: 'docs/evidence/2026-10-02-site-release/SITE-RELEASE.md',
  edge: 'docs/evidence/2026-10-02-edge-mcp-release/RELEASE.md',
  auth: 'docs/evidence/2026-10-02-mcp-auth-release/RELEASE.md',
  dcr: 'docs/evidence/2026-10-02-dcr-release/RELEASE-V2.md',
};

function block(plan, step) {
  const file = planFiles[plan];
  // Read the original plans too, so the same behavioral probes can prove the
  // regression against the pre-fix commit without rewriting the checkout.
  const ref = process.env.PLAN_GUARDS_TEST_REF;
  const result = ref && spawnSync('git', ['show', `${ref}:${file}`], { encoding: 'utf8' });
  if (result) assert.equal(result.status, 0, result.stderr);
  const text = result ? result.stdout : readFileSync(file, 'utf8');
  const source = [...text.matchAll(/^```sh\n([\s\S]*?)^```$/gm)]
    .map(match => match[1]).find(source => source.split('\n')[0].startsWith(`# step: ${step}`));
  assert.ok(source, `${file}: missing ${step}`);
  return source;
}

function andGuard(source, first, last) {
  const lines = source.split('\n');
  const start = lines.findIndex(line => line.includes(first));
  assert.ok(start >= 0, `missing guard ${first}`);
  const end = lines.findIndex((line, index) => index >= start && line.includes(last));
  assert.ok(end >= start, `missing guard ${last}`);
  return lines.slice(start, end + 1).join('\n');
}

function captureGuard(source, command) {
  const lines = source.split('\n');
  const start = lines.findIndex(line => line.includes(command));
  assert.ok(start >= 0, `missing command ${command}`);
  if (lines[start].trimStart().startsWith('test ')) return lines[start];
  let end = start + 1;
  while (end < lines.length && /^\s*\w+=/.test(lines[end])) end++;
  assert.match(lines[end], /^\s*test /, 'captured command must reach its real predicate');
  return lines.slice(start, end + 1).join('\n');
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tempRoot, 'plan-guards-errexit.')));
  const missing = join(root, 'missing');
  const file = join(root, 'file'); writeFileSync(file, 'fixture');
  const directory = join(root, 'directory'); mkdirSync(directory);
  const brokenLink = join(root, 'broken-link'); symlinkSync(missing, brokenLink);
  const directoryLink = join(root, 'directory-link'); symlinkSync(directory, directoryLink);
  return { root, missing, file, directory, brokenLink, directoryLink };
}

function cleanup(root) {
  assert.equal(dirname(root), tempRoot);
  assert.match(root.slice(tempRoot.length + 1), /^plan-guards-errexit\.[\w]+$/);
  const result = spawnSync('rm', ['-rf', '--', root], { encoding: 'utf8' });
  assert.equal(result.status, 0, `guard refused ${root}: ${result.stderr}`);
  assert.equal(existsSync(root), false);
}

function run(source, guard, env, setup = '') {
  // Use the plan's errexit setup and failure message, then a success marker
  // standing in for the next release operation. No release mutation is run.
  const trap = source.split('\n').find(line => /^\s*trap .* ERR$/.test(line));
  assert.ok(trap, 'plan block must provide its failure handler');
  return spawnSync('/bin/bash', ['-s'], {
    encoding: 'utf8', env: { ...process.env, ...env },
    input: `set -euo pipefail\nset -E\n${trap}\n${setup}\n${guard}\nprintf 'REACHED_NEXT_OPERATION\\n'\n`,
  });
}

function passed(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'REACHED_NEXT_OPERATION\n');
}

function stopped(result) {
  assert.ok(Number.isInteger(result.status) && result.status !== 0, result.stdout + result.stderr);
  assert.equal(result.stdout.includes('REACHED_NEXT_OPERATION'), false, 'guard must STOP before the next operation');
  // Explicit `|| exit 1` guards stop silently; the exit status and absent
  // next-operation marker are the STOP contract for those blocks too.
}

const pathGuards = [
  { plan: 'site', step: 'site2-00-source-checkout', variable: 'SITE_RELEASE_REPO', kind: 'directory',
    first: 'test -d "$SITE_RELEASE_REPO"', last: 'test ! -L "$SITE_RELEASE_REPO"' },
  { plan: 'site', step: 'site2-00-build-env', variable: 'SITE_BUILD_ENV_SOURCE', kind: 'absent',
    first: 'test ! -e "$SITE_BUILD_ENV_SOURCE"', last: 'test ! -L "$SITE_BUILD_ENV_SOURCE"' },
  { plan: 'edge', step: 'edge-mcp-open', variable: 'PROOF_DIR', kind: 'absent',
    first: 'test ! -e "$PROOF_DIR"', last: 'test ! -L "$PROOF_DIR"' },
  { plan: 'edge', step: 'edge-mcp-close', variable: 'SECRET_STAGE', kind: 'absent',
    first: 'test ! -e "$SECRET_STAGE"', last: 'test ! -L "$SECRET_STAGE"' },
  { plan: 'dcr', step: 'dcr-stage', variable: 'PROOF_DIR', kind: 'absent',
    first: 'test ! -e "$PROOF_DIR"', last: 'test ! -L "$PROOF_DIR"' },
  { plan: 'dcr', step: 'dcr-session', variable: 'PROOF_DIR', kind: 'receipts',
    first: 'test ! -e "$PROOF_DIR/closed.txt"', last: 'test ! -e "$PROOF_DIR/session-ready.txt"' },
];

for (const spec of pathGuards) {
  test(`${spec.plan}: ${spec.step} ${spec.variable} guard stops on either rejected operand`, () => {
    const source = block(spec.plan, spec.step);
    const guard = andGuard(source, spec.first, spec.last);
    const f = fixture();
    try {
      const env = value => ({ [spec.variable]: value });
      if (spec.kind === 'directory') {
        passed(run(source, guard, env(f.directory)));
        for (const value of [f.missing, f.file, f.directoryLink]) stopped(run(source, guard, env(value)));
      } else if (spec.kind === 'absent') {
        passed(run(source, guard, env(f.missing)));
        for (const value of [f.file, f.directory, f.brokenLink]) stopped(run(source, guard, env(value)));
      } else {
        passed(run(source, guard, env(f.directory)));
        for (const receipt of ['closed.txt', 'session-ready.txt']) {
          const directory = join(f.root, receipt); mkdirSync(directory);
          writeFileSync(join(directory, receipt), 'fixture');
          stopped(run(source, guard, env(directory)));
        }
      }
    } finally { cleanup(f.root); }
  });
}

const emptyGuards = [
  { plan: 'site', step: 'site2-00-source-checkout', command: 'find "$SITE_RELEASE_REPO" -mindepth', tool: 'find',
    env: { SITE_RELEASE_REPO: '/unused-fixture-path' } },
  { plan: 'edge', step: 'edge-mcp-archive', command: 'git status --porcelain', tool: 'git' },
  { plan: 'auth', step: 'hm37-oauth-archive', command: 'git status --porcelain', tool: 'git' },
  { plan: 'dcr', step: 'dcr-archive', command: 'git status --porcelain', tool: 'git' },
];

for (const spec of emptyGuards) {
  test(`${spec.plan}: ${spec.tool} failure with empty stdout stops before the emptiness test`, () => {
    const source = block(spec.plan, spec.step);
    const guard = captureGuard(source, spec.command);
    // These commands perform reads only. Control both their exit status and
    // bytes independently; the predicate and failure handler are real plan code.
    const setup = `${spec.tool}() { printf '%s' "$READ_OUTPUT"; return "$READ_STATUS"; }`;
    passed(run(source, guard, { ...spec.env, READ_OUTPUT: '', READ_STATUS: '0' }, setup));
    stopped(run(source, guard, { ...spec.env, READ_OUTPUT: 'occupied', READ_STATUS: '0' }, setup));
    stopped(run(source, guard, { ...spec.env, READ_OUTPUT: '', READ_STATUS: '23' }, setup));
  });
}

test('auth: image identity stops if either read fails, even when the two outputs agree', () => {
  const source = block('auth', 'hm37-oauth-release-off');
  const guard = captureGuard(source, "docker inspect --format '{{.Image}}'");
  const setup = `docker() { printf '%s' "$IMAGE_OUTPUT"; return "$IMAGE_STATUS"; }
cat() { printf '%s' "$FILE_OUTPUT"; return "$FILE_STATUS"; }`;
  const env = { PROOF_DIR: '/unused-fixture-path', IMAGE_OUTPUT: 'sha256:fixture', IMAGE_STATUS: '0',
    FILE_OUTPUT: 'sha256:fixture', FILE_STATUS: '0' };
  passed(run(source, guard, env, setup));
  stopped(run(source, guard, { ...env, FILE_OUTPUT: 'sha256:other' }, setup));
  stopped(run(source, guard, { ...env, IMAGE_STATUS: '23' }, setup));
  stopped(run(source, guard, { ...env, FILE_STATUS: '24' }, setup));
  stopped(run(source, guard, { ...env, IMAGE_OUTPUT: '', FILE_OUTPUT: '', IMAGE_STATUS: '23', FILE_STATUS: '24' }, setup));
});
