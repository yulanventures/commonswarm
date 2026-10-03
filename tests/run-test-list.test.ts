import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const runner = resolve(process.cwd(), "scripts/run-test-list.mjs");

function withDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "run-test-list-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function run(dir: string, ...args: string[]) {
  // an inherited NODE_TEST_CONTEXT would make the inner node --test behave as a child reporter
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [runner, ...args], { cwd: dir, encoding: "utf8", env });
}

test("run-test-list refuses a missing file and names it", () => {
  withDir((dir) => {
    writeFileSync(join(dir, "a.test.mjs"), "");
    writeFileSync(join(dir, "list.txt"), "a.test.mjs\nnope.test.mjs\n");
    const result = run(dir, "list.txt", "--list-only");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /missing file: nope\.test\.mjs/);
    assert.doesNotMatch(result.stderr, /missing file: a\.test\.mjs/);
  });
});

test("run-test-list refuses a duplicate entry", () => {
  withDir((dir) => {
    writeFileSync(join(dir, "a.test.mjs"), "");
    writeFileSync(join(dir, "list.txt"), "a.test.mjs\na.test.mjs\n");
    const result = run(dir, "list.txt", "--list-only");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /duplicate entry: a\.test\.mjs/);
  });
});

test("run-test-list keeps list order, expands a glob in place and drops repeats", () => {
  withDir((dir) => {
    mkdirSync(join(dir, "sub"));
    for (const f of ["z.test.mjs", "a.test.mjs", "sub/b.test.mjs", "sub/c.test.mjs"]) writeFileSync(join(dir, f), "");
    writeFileSync(join(dir, "list.txt"), "z.test.mjs\nsub/c.test.mjs\nsub/*.test.mjs\na.test.mjs\n");
    const result = run(dir, "list.txt", "--list-only");
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "z.test.mjs\nsub/c.test.mjs\nsub/b.test.mjs\na.test.mjs\n");
  });
});

test("run-test-list skips comments and expands globs in --list-only", () => {
  withDir((dir) => {
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "a.test.mjs"), "");
    writeFileSync(join(dir, "sub", "b.test.mjs"), "");
    writeFileSync(join(dir, "list.txt"), "# note\n\na.test.mjs\nsub/*.test.mjs\n");
    const result = run(dir, "list.txt", "--list-only");
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "a.test.mjs\nsub/b.test.mjs\n");
  });
});

test("run-test-list passes flags through to node --test and propagates failure", () => {
  withDir((dir) => {
    writeFileSync(
      join(dir, "a.test.mjs"),
      'import { test } from "node:test";\ntest("good", () => {});\ntest("bad", () => { throw new Error("boom"); });\n',
    );
    writeFileSync(join(dir, "list.txt"), "a.test.mjs\n");
    // without a flag the failing test fails the run; --test-name-pattern reaches node --test and skips it
    assert.notEqual(run(dir, "list.txt").status, 0);
    assert.equal(run(dir, "list.txt", "--test-name-pattern=good").status, 0);
  });
});
