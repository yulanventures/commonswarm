import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

const repeatFile = "tests/p1-server/hm37-open-ack-control.test.ts";

function executedSubtests(tap: string, repeatFilePath = repeatFile): number {
  const result = spawnSync("bash", ["tests/server-repeat-count.sh"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, REPEAT_FILE: repeatFilePath },
    input: tap,
  });
  assert.equal(result.status, 0, result.stderr);
  return Number(result.stdout.trim());
}

function repeatPass(runnerStatus: number, subtests: number): boolean {
  return runnerStatus === 0 && subtests > 0;
}

function noTestsRan(subtests: number): boolean {
  return subtests === 0;
}

test("server repeat counts column-0 TAP results from a normal Node run", () => {
  const workflow = readFileSync(".github/workflows/server-suite.yml", "utf8");
  assert.match(
    workflow,
    /executed_subtests="\$\(bash tests\/server-repeat-count\.sh <"\$iteration_log"\)"/,
  );
  assert.doesNotMatch(workflow, /server-repeat-count\.sh <.*server-repeat\.log/);

  const normalRun = `TAP version 13
# Subtest: §2.3 self-healing renewal keeps exactly one live successor per predecessor under concurrency
ok 1 - §2.3 self-healing renewal keeps exactly one live successor per predecessor under concurrency
  ---
  duration_ms: 3210.307905
  type: 'test'
  ...
1..1
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 6304.447327
`;
  assert.equal(executedSubtests(normalRun), 1);
  assert.equal(repeatPass(0, executedSubtests(normalRun)), true);
});

test("server repeat preserves real failures instead of classifying them as no-tests", () => {
  const failedRun = `TAP version 13
# Subtest: HM37 harness proves all eleven observations and complete revocation
not ok 1 - HM37 harness proves all eleven observations and complete revocation
  ---
  duration_ms: 1491.667476
  type: 'test'
  location: '/home/runner/work/commonswarm/commonswarm/tests/p1-server/hm37-open-ack-control.test.ts:18:131'
  failureType: 'testCodeFailure'
  error: |-
    oidc-provider WARNING: Unsupported runtime. Use Node.js v22.x LTS, or a later LTS release.
    1 !== 0
  code: 'ERR_ASSERTION'
  ...
# Subtest: missing protected input fails before creating authority or OAuth rows
ok 2 - missing protected input fails before creating authority or OAuth rows
  ---
  duration_ms: 312.878279
  type: 'test'
  ...
# Subtest: forced failure after seat creation still runs the full finally cleanup
not ok 3 - forced failure after seat creation still runs the full finally cleanup
  ---
  duration_ms: 639.356026
  type: 'test'
  failureType: 'testCodeFailure'
  ...
1..3
# tests 3
# suites 0
# pass 1
# fail 2
# cancelled 0
# skipped 0
# todo 0
# duration_ms 3819.518958
`;
  assert.equal(executedSubtests(failedRun), 3);
  assert.equal(repeatPass(1, executedSubtests(failedRun)), false);
  assert.equal(noTestsRan(executedSubtests(failedRun)), false);
});

test("server repeat rejects a pattern-filtered Node run with a file wrapper", () => {
  const patternFilteredRun = `TAP version 13
1..0
# Subtest: /home/runner/work/commonswarm/commonswarm/tests/p1-server/hm37-open-ack-control.test.ts
ok 1 - /home/runner/work/commonswarm/commonswarm/tests/p1-server/hm37-open-ack-control.test.ts
  ---
  duration_ms: 1330.030129
  type: 'test'
  ...
1..1
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 1339.713192
`;
  assert.equal(executedSubtests(patternFilteredRun), 0);
  assert.equal(
    executedSubtests(
      patternFilteredRun,
      "/home/runner/work/commonswarm/commonswarm/tests/p1-server/hm37-open-ack-control.test.ts",
    ),
    0,
  );
  assert.equal(repeatPass(0, executedSubtests(patternFilteredRun)), false);
  assert.equal(noTestsRan(executedSubtests(patternFilteredRun)), true);
});

test("server repeat ignores indented nested TAP results", () => {
  const nestedRun = `TAP version 13
ok 1 - parent test
  # Subtest: child test
  ok 1 - child test
  1..1
1..1
`;
  assert.equal(executedSubtests(nestedRun), 1);
});

test("server repeat excludes a skipped column-0 TAP result", () => {
  const skippedRun = `TAP version 13
ok 1 - skipped test # SKIP unavailable dependency
1..1
`;
  assert.equal(executedSubtests(skippedRun), 0);
});

// The same workflow owns shard dispatch and its final coverage gate.
function run(...args: string[]) {
  return spawnSync(process.execPath, ['scripts/ci/server-suite.mjs', ...args], { encoding: 'utf8' });
}
function scratch(context: TestContext) {
  const root = realpathSync(tmpdir());
  const directory = mkdtempSync(join(root, 'server-shard-proof-'));
  context.after(() => {
    assert.ok(realpathSync(directory).startsWith(join(root, 'server-shard-proof-')));
    const result = spawnSync('rm', ['-r', directory], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  });
  return directory;
}
function lists() {
  return [1, 2, 3].map(shard => {
    const result = run('list', String(shard));
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim().split('\n');
  });
}
function receipts(directory: string) {
  lists().forEach((files, index) => {
    writeFileSync(join(directory, `server-shard-${index + 1}.json`), JSON.stringify({ shard: index + 1, files }));
  });
}

test('three deterministic shards cover every discovered server test exactly once', context => {
  const directory = scratch(context);
  const shards = lists();
  const discovered = readdirSync('tests/p1-server', { recursive: true, encoding: 'utf8' })
    .filter(name => name.endsWith('.test.ts')).map(name => `tests/p1-server/${name}`).sort();
  assert.deepEqual(shards.flat().sort(), discovered);
  assert.equal(new Set(shards.flat()).size, discovered.length);
  assert.deepEqual(lists(), shards);
  assert.ok(Math.max(...shards.map(files => files.length)) - Math.min(...shards.map(files => files.length)) <= 1);
  receipts(directory);
  const result = run('verify', directory);
  assert.equal(result.status, 0, result.stderr);
});

for (const mutation of ['missing receipt', 'missing file', 'duplicate file', 'duplicate shard']) {
  test(`aggregation rejects ${mutation}`, context => {
    const directory = scratch(context);
    receipts(directory);
    const path = join(directory, 'server-shard-1.json');
    const receipt = JSON.parse(readFileSync(path, 'utf8'));
    if (mutation === 'missing receipt') {
      // A non-receipt filename models an artifact that was never uploaded.
      const result = spawnSync('mv', [path, join(directory, 'missing.json')], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    } else {
      if (mutation === 'missing file') receipt.files.pop();
      if (mutation === 'duplicate file') receipt.files.push(receipt.files[0]);
      if (mutation === 'duplicate shard') receipt.shard = 2;
      writeFileSync(path, JSON.stringify(receipt));
    }
    assert.notEqual(run('verify', directory).status, 0);
  });
}

test('a receipt cannot certify a different execution list', context => {
  const directory = scratch(context);
  const list = join(directory, 'executed.txt');
  const receipt = join(directory, 'server-shard-1.json');
  writeFileSync(list, `${lists()[0].slice(1).join('\n')}\n`);
  assert.notEqual(run('receipt', '1', list, receipt).status, 0);
});

test('the workflow final gate rejects failed or cancelled jobs even with complete receipts', context => {
  const directory = scratch(context);
  const artifactDirectory = join(directory, 'server-shards');
  const made = spawnSync('mkdir', ['-p', artifactDirectory], { encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  receipts(artifactDirectory);
  const workflow = readFileSync('.github/workflows/server-suite.yml', 'utf8');
  const step = workflow.split('      - name: Require successful shards and exact server file coverage\n')[1];
  const script = step?.split('        run: |\n')[1]?.replace(/^          /gm, '');
  assert.ok(script, 'the final gate must have an executable shell block');
  for (const status of ['success', 'failure', 'cancelled', 'skipped']) {
    const result = spawnSync('bash', ['-c', script], {
      encoding: 'utf8',
      env: { ...process.env, RUNNER_TEMP: directory, SUITE_RESULT: status },
    });
    assert.equal(result.status === 0, status === 'success', result.stderr);
  }
});
