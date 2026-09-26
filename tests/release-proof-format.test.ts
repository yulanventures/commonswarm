/*
 * Release proofs are consumed by the section-5 decision wrapper in deploy/RELEASE-TO-BOX.md, which reads the value
 * through psql `\gset`: a catalog proof must end with a query whose one Boolean column is aliased `catalog_ok`
 * (`rollback_ok` for a rollback catalog), with no semicolon, followed by its own `\gset` line. On 2026-09-26 the
 * renewal proof ended with `AS catalog_ok;` and no `\gset`; the wrapper printed `f` twice and the window stopped.
 * This test checks every catalog proof in the repository, with controls that prove it rejects that shape.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const ROOT = new URL("../deploy/release-proofs/", import.meta.url).pathname;

function catalogProofs(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return catalogProofs(path);
    return entry.name.endsWith("catalog.sql") ? [path] : [];
  });
}

function proofFormatProblem(name: string, text: string): string | null {
  const lines = text.split("\n").map(line => line.replace(/\s+$/, "")).filter(line => line.trim() !== "");
  const alias = name.endsWith("rollback-catalog.sql") ? "rollback_ok" : "catalog_ok";
  const last = lines.at(-1);
  const beforeLast = lines.at(-2);
  if (last !== "\\gset") return `${name}: must end with its own \\gset line`;
  if (beforeLast === undefined || !new RegExp(`\\bAS ${alias}$`).test(beforeLast)) {
    return `${name}: the line before \\gset must end with "AS ${alias}" and no semicolon`;
  }
  return null;
}

test("every catalog proof ends with `AS catalog_ok` (or `AS rollback_ok`) and its own \\gset line", () => {
  const files = catalogProofs(ROOT);
  assert.ok(files.length >= 15, `found only ${files.length} catalog proofs under deploy/release-proofs`);
  assert.ok(files.some(file => file.endsWith("renewal-last-use/20260925000002-catalog.sql")), "the renewal proof is covered");
  const problems = files.map(file => proofFormatProblem(file.slice(ROOT.length), readFileSync(file, "utf8"))).filter(Boolean);
  assert.deepEqual(problems, []);
});

test("controls: the check rejects a trailing semicolon, a missing \\gset and the wrong alias", () => {
  const good = "SELECT true AS catalog_ok\n\\gset\n";
  assert.equal(proofFormatProblem("x/1-catalog.sql", good), null);
  assert.match(proofFormatProblem("x/1-catalog.sql", "SELECT true AS catalog_ok;\n")!, /\\gset/);
  assert.match(proofFormatProblem("x/1-catalog.sql", "SELECT true AS catalog_ok;\n\\gset\n")!, /no semicolon/);
  assert.match(proofFormatProblem("x/1-rollback-catalog.sql", good)!, /rollback_ok/);
  assert.equal(proofFormatProblem("x/1-rollback-catalog.sql", "SELECT true AS rollback_ok\n\\gset\n"), null);
});
