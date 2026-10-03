import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { compare, parseFailures } from "../scripts/ci-compare-failures.mjs";

const SPEC = "  ✔ ok one (1ms)\n  ✖ bad one (2.5ms)\n  ✖ bad two (1ms)\nℹ fail 2\n✖ failing tests:\n  ✖ bad one (2.5ms)\n";
const TAP = "ok 1 - fine\nnot ok 2 - tap bad\nnot ok 3 - skipped one # SKIP\n";

test("parses spec and TAP failures once each", () => {
  assert.deepEqual(parseFailures(SPEC), ["bad one", "bad two"]);
  assert.deepEqual(parseFailures(TAP), ["tap bad"]);
});

test("compare splits new and known, per suite", () => {
  const manifest = { suites: { unit: [{ name: "bad one", lane: "x", reason: "y" }], site: [{ name: "bad two" }] } };
  assert.deepEqual(compare(["bad one", "bad two"], manifest, "unit"), { newFailures: ["bad two"], knownFailures: ["bad one"] });
  assert.deepEqual(compare(["bad one", "bad two"], manifest).newFailures, []);
});

test("--gate exits non-zero only on new failures", () => {
  const dir = mkdtempSync(join(tmpdir(), "ci-compare-"));
  try {
    const log = join(dir, "log.txt");
    const manifest = join(dir, "m.json");
    writeFileSync(log, SPEC);
    const run = (known, gate) => {
      writeFileSync(manifest, JSON.stringify({ suites: { unit: known.map((name) => ({ name })) } }));
      return spawnSync(process.execPath, ["scripts/ci-compare-failures.mjs", "--log", log, "--manifest", manifest, "--suite", "unit", ...(gate ? ["--gate"] : [])], { encoding: "utf8" });
    };
    const partial = run(["bad one"], true);
    assert.equal(partial.status, 1);
    assert.match(partial.stdout, /NEW   bad two/);
    assert.match(partial.stdout, /KNOWN bad one/);
    assert.equal(run(["bad one"], false).status, 0);
    assert.equal(run(["bad one", "bad two"], true).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
