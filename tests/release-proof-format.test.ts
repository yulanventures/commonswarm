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

const repoFile = (relative: string): string =>
  readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

function selectBody(source: string, start: string): string {
  const at = source.indexOf(start);
  assert.notEqual(at, -1, `missing ${start}`);
  const select = source.indexOf("SELECT", at);
  const end = source.indexOf(";", select);
  assert.notEqual(select, -1, `missing SELECT after ${start}`);
  assert.notEqual(end, -1, `missing terminator after ${start}`);
  return source.slice(select, end + 1);
}

test("HM transport migration changes only wake turn-only eligibility", () => {
  const migration = repoFile("supabase/migrations/20260928000001_hm_agent_transport.sql");
  const prior = repoFile("supabase/migrations/20260925000001_unclaimed_observed_ack.sql");
  assert.doesNotMatch(migration, /^\s*(?:BEGIN|COMMIT)\s*;/m);
  const before = selectBody(prior, "CREATE VIEW swarm.wake_path_eligible_deliveries");
  const after = selectBody(migration, "CREATE OR REPLACE VIEW swarm.wake_path_eligible_deliveries");
  assert.equal(after.replace("  AND p.turn_only = false\n", ""), before);
  assert.equal(after.split("p.turn_only = false").length, 2);
  assert.match(migration, /REVOKE ALL ON swarm\.wake_path_eligible_deliveries\s+FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;/);
});

test("HM rollback holds the complete prior roster and wake definitions", () => {
  const rollback = repoFile("deploy/release-proofs/item-hm/20260928000001-rollback.sql");
  const priorRoster = repoFile("supabase/migrations/20260916000001_agent_join_credentials.sql");
  const priorWake = repoFile("supabase/migrations/20260925000001_unclaimed_observed_ack.sql");
  assert.equal(
    selectBody(rollback, "CREATE VIEW swarm_read.agent_principals"),
    selectBody(priorRoster, "CREATE OR REPLACE VIEW swarm_read.agent_principals"),
  );
  assert.equal(
    selectBody(rollback, "CREATE OR REPLACE VIEW swarm.wake_path_eligible_deliveries"),
    selectBody(priorWake, "CREATE VIEW swarm.wake_path_eligible_deliveries"),
  );
  assert.doesNotMatch(rollback, /regexp_replace|pg_get_viewdef|EXECUTE\s+format/i);
  assert.match(rollback, /DROP FUNCTION swarm\.agent_principal_transport\(uuid\);/);
  assert.match(rollback, /GRANT SELECT ON swarm_read\.agent_principals TO authenticated, swarm_read;/);
  assert.match(rollback, /REVOKE ALL ON swarm_read\.agent_principals FROM anon;/);
  assert.match(rollback, /REVOKE ALL ON swarm\.wake_path_eligible_deliveries\s+FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;/);
});

test("HM functional proof selects its own live local principal", () => {
  const proof = repoFile(
    "deploy/release-proofs/item-hm/20260928000001-functional.sql",
  );
  assert.match(proof, /p\.principal_id::text AS item_hm_principal_id/);
  assert.match(proof, /p\.transport = 'local'/);
  assert.match(proof, /p\.turn_only = false/);
  assert.match(proof, /LIMIT 1\s+\\gset/);
  assert.doesNotMatch(proof, /item_hm_principal_id is required/);
});
