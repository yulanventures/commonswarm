/*
 * Release proofs are consumed by the section-5 decision wrapper in deploy/RELEASE-TO-BOX.md, which reads the value
 * through psql `\gset`: a catalog proof must end with a query whose one Boolean column is aliased `catalog_ok`
 * (`rollback_ok` for a rollback catalog, `before_ok` for a before-apply catalog), with no semicolon, followed by its own `\gset` line. On 2026-09-26 the
 * renewal proof ended with `AS catalog_ok;` and no `\gset`; the wrapper printed `f` twice and the window stopped.
 * This test checks every catalog proof in the repository, with controls that prove it rejects that shape.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { releaseCatalogQuery } from "./support/release-catalog-query.js";

const ROOT = new URL("../deploy/release-proofs/", import.meta.url).pathname;

function catalogProofs(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return catalogProofs(path);
    return entry.name.endsWith("catalog.sql") ? [path] : [];
  });
}

function catalogAlias(name: string): "catalog_ok" | "rollback_ok" | "before_ok" {
  if (name.endsWith("rollback-catalog.sql")) return "rollback_ok";
  return name.endsWith("before-catalog.sql") ? "before_ok" : "catalog_ok";
}

function proofFormatProblem(name: string, text: string): string | null {
  const lines = text.split("\n").map(line => line.replace(/\s+$/, "")).filter(line => line.trim() !== "");
  const alias = catalogAlias(name);
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
  assert.match(proofFormatProblem("x/1-before-catalog.sql", good)!, /before_ok/);
  assert.match(proofFormatProblem("x/1-before-catalog.sql", "SELECT true AS rollback_ok\n\\gset\n")!, /before_ok/);
  assert.equal(proofFormatProblem("x/1-before-catalog.sql", "SELECT true AS before_ok\n\\gset\n"), null);
});

test("postgres.js catalog queries preserve predicates and diagnostics without the psql variable round trip", () => {
  for (const alias of ['catalog_ok', 'rollback_ok', 'before_ok'] as const) {
    const predicates = "WITH checks(label,ok) AS (VALUES ('positive',true),('negative',false))\n";
    const aggregate = "SELECT COALESCE(string_agg(label,',' ORDER BY label) FILTER (WHERE NOT ok),'') AS " + alias + "_failed_checks,\n"
      + "  COALESCE(bool_and(ok),false) AS ";
    const source = predicates + aggregate + alias + "_checks_ok FROM checks\n"
      + `\\gset\n\\if :${alias}_checks_ok\n\\else\n\\warn failed checks: :${alias}_failed_checks\n\\endif\n`
      + `SELECT :'${alias}_checks_ok'::boolean AS ${alias}\n\\gset\n`;
    assert.equal(releaseCatalogQuery(source, alias), predicates + aggregate + alias + " FROM checks;\n");
    assert.equal(releaseCatalogQuery(`SELECT false AS ${alias}\n\\gset\n`, alias), `SELECT false AS ${alias};\n`);
    assert.throws(() => releaseCatalogQuery(source.replace('\\warn', '\\echo'), alias), /Unsupported catalog proof wrapper/);
    assert.throws(() => releaseCatalogQuery(source, alias === 'catalog_ok' ? 'rollback_ok' : 'catalog_ok'), /Unsupported catalog proof wrapper/);
  }
  // Real release inputs exercise the wrapper consumed by the HM rollback drill,
  // including part 14's labelled admin proofs. No database or service is needed.
  for (const file of catalogProofs(ROOT).filter(file => /\/item-ai\/|\/item-hm\/20260928000002-/u.test(file))) {
    const alias = catalogAlias(file);
    const query = releaseCatalogQuery(readFileSync(file, 'utf8'), alias);
    assert.doesNotMatch(query, /^\s*\\/m, file);
    assert.doesNotMatch(query, /:'(?:catalog_ok|rollback_ok|before_ok)_checks_ok'/, file);
  }
});

const releaseRunbook = (): string =>
  readFileSync(new URL("../deploy/RELEASE-TO-BOX.md", import.meta.url), "utf8");

function runbookShellBlocks(runbook: string): string[] {
  return [...runbook.matchAll(/```sh\n([\s\S]*?)```/g)].map(match => match[1]);
}

function runbookShellBlock(runbook: string, step: string): string {
  const prefix = `# step: ${step}\n`;
  const matches = runbookShellBlocks(runbook).filter(block => block.startsWith(prefix));
  assert.equal(matches.length, 1, `expected one ${step} shell block`);
  return matches[0];
}

function releaseDirectoryFunction(runbook: string): string {
  const applyBlock = runbookShellBlock(runbook, "1-apply-release-directories");
  const startMarker = "  prepare_release_directory() {";
  const endMarker = '\n\n  for KIND in "${KIND_ARRAY[@]}"; do';
  const start = applyBlock.indexOf(startMarker);
  const end = applyBlock.indexOf(endMarker, start);
  assert.notEqual(start, -1, "missing release-directory function in runbook");
  assert.notEqual(end, -1, "missing release-directory function terminator in runbook");
  let body = applyBlock.slice(start, end).replace(/^  /gm, "");

  // The production block runs as root. The fixture runs the exact logic as the
  // current user, so remove only its three ownership-changing command options.
  const rewrites: Array<[string, string]> = [
    [' -o "$RELEASE_OWNER" -g "$RELEASE_GROUP"', ""],
    ['    chown -R "$RELEASE_OWNER:$RELEASE_GROUP" "$RELEASE_DIR"', "    :"],
    [' -o "$PROOF_OWNER" -g "$PROOF_GROUP"', ""],
  ];
  for (const [from, to] of rewrites) {
    assert.equal(body.split(from).length - 1, 1, `fixture rewrite count for ${from}`);
    body = body.replace(from, to);
  }
  return body;
}

function runReleaseDirectoryFixture(options: {
  archive: string;
  proofDir: string;
  releaseDir: string;
  sha: string;
}) {
  const script = `set -euo pipefail
${releaseDirectoryFunction(releaseRunbook())}
RELEASE_OWNER="$(id -un)"
RELEASE_GROUP="$(id -gn)"
PROOF_OWNER="$RELEASE_OWNER"
PROOF_GROUP="$RELEASE_GROUP"
umask 0000
prepare_release_directory stack "$RELEASE_DIR" 0755
printf '%s\\n' "$RELEASE_DIR_RESULT"
`;
  return spawnSync("/bin/bash", ["-c", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      ARCHIVE: options.archive,
      KIND: "stack",
      PROOF_DIR: options.proofDir,
      RELEASE_DIR: options.releaseDir,
      RELEASE_MODE: "0755",
      SHA: options.sha,
    },
  });
}

function command(commandName: string, args: string[], cwd: string): string {
  const result = spawnSync(commandName, args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `${commandName} failed: ${result.stderr}`);
  return result.stdout.trim();
}

test("release-directory block creates, reuses, and refuses every mismatched fixture", (t) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "commonswarm-release-reuse-"));
  t.after(() => rmSync(fixtureRoot, { force: true, recursive: true }));
  const sourceDir = join(fixtureRoot, "source");
  const archive = join(fixtureRoot, "release.tar");
  mkdirSync(join(sourceDir, "links"), { recursive: true });
  writeFileSync(join(sourceDir, "payload.txt"), "reviewed bytes\n");
  writeFileSync(join(sourceDir, "executable.sh"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(sourceDir, "executable.sh"), 0o755);
  symlinkSync("../payload.txt", join(sourceDir, "links", "inside"));
  command("git", ["init", "-q"], sourceDir);
  command("git", ["add", "."], sourceDir);
  command("git", ["-c", "user.name=Release Test", "-c", "user.email=release-test@example.invalid", "commit", "-qm", "fixture"], sourceDir);
  const sha = command("git", ["rev-parse", "HEAD"], sourceDir);
  command("git", ["archive", "--format=tar", "--output", archive, sha], sourceDir);

  const newCase = (name: string) => {
    const caseDir = join(fixtureRoot, name);
    const proofDir = join(caseDir, "proof");
    const releaseDir = join(caseDir, "release");
    mkdirSync(proofDir, { recursive: true });
    const created = runReleaseDirectoryFixture({ archive, proofDir, releaseDir, sha });
    assert.equal(created.status, 0, created.stderr);
    assert.match(created.stdout, /created\s*$/);
    assert.equal(
      readFileSync(join(proofDir, "stack.release-dir-state.txt"), "utf8"),
      "RELEASE_DIR_STATE=created\n",
    );
    return { proofDir, releaseDir };
  };

  const identical = newCase("identical");
  const reused = runReleaseDirectoryFixture({ archive, ...identical, sha });
  assert.equal(reused.status, 0, reused.stderr);
  assert.match(reused.stdout, /reused\s*$/);
  assert.equal(
    readFileSync(join(identical.proofDir, "stack.release-dir-state.txt"), "utf8"),
    "RELEASE_DIR_STATE=reused\n",
  );

  const refuses = (
    name: string,
    mutate: (releaseDir: string) => void,
    message: RegExp,
  ) => {
    const fixture = newCase(name);
    mutate(fixture.releaseDir);
    const result = runReleaseDirectoryFixture({ archive, ...fixture, sha });
    assert.notEqual(result.status, 0, `${name} unexpectedly reused the directory`);
    assert.match(result.stderr, message);
  };

  refuses("changed-byte", releaseDir => {
    writeFileSync(join(releaseDir, "payload.txt"), "changed bytes\n");
  }, /file hash differs: payload\.txt/);
  refuses("extra-file", releaseDir => {
    writeFileSync(join(releaseDir, "extra.txt"), "extra\n");
  }, /path inventory differs:.*extra=.*extra\.txt/s);
  refuses("missing-file", releaseDir => {
    unlinkSync(join(releaseDir, "payload.txt"));
  }, /path inventory differs:.*missing=.*payload\.txt/s);
  refuses("other-sha", releaseDir => {
    writeFileSync(join(releaseDir, "RELEASE_SHA"), `${"f".repeat(40)}\n`);
  }, /RELEASE_SHA differs from window SHA/);
  refuses("escaping-symlink", releaseDir => {
    unlinkSync(join(releaseDir, "links", "inside"));
    symlinkSync("../../outside", join(releaseDir, "links", "inside"));
  }, /symlink leaves release directory/);
});

test("every release runbook shell block is labelled and parses with macOS Bash 3.2", () => {
  const blocks = runbookShellBlocks(releaseRunbook());
  assert.ok(blocks.length >= 50, `found only ${blocks.length} shell blocks`);
  for (const block of blocks) {
    const firstLine = block.split("\n", 1)[0];
    assert.match(firstLine, /^# step: [a-z0-9][a-z0-9-]*$/, `unlabelled shell block: ${firstLine}`);
    const parsed = spawnSync("/bin/bash", ["-n"], { input: block, encoding: "utf8" });
    assert.equal(parsed.status, 0, `${firstLine}: ${parsed.stderr}`);
  }
  assert.match(releaseRunbook(), /printf '%s=%q\\n' RELEASE_DIR_STATE "\$RELEASE_DIR_STATE"/);
  assert.match(releaseRunbook(), /RELEASE_DIR_STATE=%s\\n.*RELEASE_DIR_RESULT/s);
});

test("every edge and stack recreate saves a bounded outgoing container log for copy-back", () => {
  const runbook = releaseRunbook();
  const cases = [
    ["runbook-32", 'save_outgoing_container_logs commonswarm-edge-edge-runtime-1 "$PREVIOUS_EDGE"'],
    ["runbook-42", 'save_outgoing_container_logs commonswarm-edge-edge-runtime-1 "$OUTGOING_EDGE"'],
    ["runbook-49", 'save_outgoing_container_logs "$STACK_CONTAINER" "$PREVIOUS_STACK"'],
    ["runbook-53", 'save_outgoing_container_logs "$STACK_CONTAINER" "$NEW_STACK"'],
  ] as const;

  for (const [step, expectedCall] of cases) {
    const block = runbookShellBlock(runbook, step);
    const captureAt = block.indexOf("docker logs --timestamps");
    const recreateAt = block.indexOf("docker compose");
    assert.ok(captureAt >= 0, `${step} has no outgoing log capture`);
    assert.ok(recreateAt > captureAt, `${step} captures logs after recreate`);
    assert.match(block, /LOG_MAX_BYTES=10485760/);
    assert.match(block, /\{ docker logs --timestamps "\$CONTAINER_NAME" 2>&1 \|\| true; \}/);
    assert.match(block, /tail -c "\$LOG_MAX_BYTES" >"\$LOG_PATH"/);
    assert.match(block, /install -m 0600 -o root -g root \/dev\/null "\$LOG_PATH"/);
    assert.match(block, /LOG_NAME="\$\{CONTAINER_NAME\}\.\$\{OUTGOING_SHA\}\.docker\.log"/);
    assert.match(block, /printf '%s\\n' "\$LOG_NAME" >>"\$PROOF_DIR\/copy-back\.list"/);
    assert.ok(block.includes(expectedCall), `${step} uses the wrong outgoing release`);
  }

  const copyBack = runbookShellBlock(runbook, "runbook-11");
  assert.match(copyBack, /commonswarm-edge-edge-runtime-1\|commonswarm-postgres/);
  assert.match(copyBack, /case "\$LOG_SHA" in \(\*\[!0-9a-f\]\*\|'\'\) false/);
  assert.match(copyBack, /test "\$\{#LOG_SHA\}" -eq 40/);
  assert.match(copyBack, /wc -c .* -le 10485760/);
  assert.match(copyBack, /\*\.log\) false/);
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
