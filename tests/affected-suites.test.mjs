import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { affectedSuites } from "../scripts/affected-suites.mjs";

test("maps paths to suites in a stable order", () => {
  assert.deepEqual(affectedSuites(["site/src/a.astro"]), ["site"]);
  assert.deepEqual(affectedSuites(["services/mcp-auth/src/x.js"]), ["p1-cli", "unit", "mcp-auth"]);
  assert.deepEqual(affectedSuites(["tests/p1-server/command.test.ts"]), ["server"]);
  assert.deepEqual(affectedSuites(["deploy/mcp-auth/compose.yaml"]), ["unit", "box-dry-run", "mcp-auth"]);
  assert.deepEqual(affectedSuites([]), []);
});

test("an unmapped path fails safe to all suites", () => {
  const all = ["server", "p1-cli", "site", "unit", "box-dry-run", "mcp-auth"];
  assert.deepEqual(affectedSuites(["README.md"]), all);
  assert.deepEqual(affectedSuites(["site/x", "README.md"]), all);
});

test("a workflow change affects every suite", () => {
  assert.equal(affectedSuites([".github/workflows/server-suite.yml"]).length, 6);
});

test("--paths prints one suite per line", () => {
  const r = spawnSync(process.execPath, ["scripts/affected-suites.mjs", "--paths", "site/x", "tests/foo.test.ts"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "site\nunit\n");
});
