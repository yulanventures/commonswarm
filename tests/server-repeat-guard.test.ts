import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

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
