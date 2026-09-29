import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test } from "node:test";

const RUNBOOK = "deploy/RELEASE-TO-BOX.md";
const PLAN = "docs/evidence/2026-09-28-box-hm37/BOX-WINDOW.md";
const PLAN_B = "docs/evidence/2026-09-29-box-hm37b/BOX-WINDOW.md";
const BASE_REVISION = "b912b349";
const SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function extractStep(markdown: string, step: string): string {
  const opening = `\`\`\`sh\n# step: ${step}\n`;
  const start = markdown.indexOf(opening);
  assert.ok(start >= 0, `${step} shell block is missing`);
  assert.equal(markdown.indexOf(opening, start + opening.length), -1, `${step} is duplicated`);
  const bodyStart = start + "```sh\n".length;
  const end = markdown.indexOf("\n```", bodyStart);
  assert.ok(end > bodyStart, `${step} shell block is unterminated`);
  return markdown.slice(bodyStart, end) + "\n";
}

function extractVerifier(step: string): string {
  const start = step.indexOf("  prepare_release_directory() {");
  const end = step.indexOf("\n  for KIND in $KIND_LIST; do", start);
  assert.ok(start >= 0 && end > start, "release-directory verifier is missing");
  return step.slice(start, end) + "\n";
}

function extractRange(source: string, first: string, last: string): string {
  const start = source.indexOf(first);
  assert.ok(start >= 0, `missing command range start: ${first}`);
  const endStart = source.indexOf(last, start);
  assert.ok(endStart >= start, `missing command range end: ${last}`);
  const end = source.indexOf("\n", endStart);
  return source.slice(start, end < 0 ? source.length : end + 1);
}

function runShell(script: string) {
  return spawnSync("/bin/bash", ["-c", script], { encoding: "utf8" });
}

function bindReleaseSha(source: string): string {
  return source
    .replace(
      /\. \/home\/commonswarm\/stack\/release-proofs\/[^/\n]+\/window\.env/,
      '. "/home/commonswarm/stack/release-proofs/${RELEASE_SHA}/window.env"',
    )
    .replace(
      /PROOF_DIR='\/home\/commonswarm\/stack\/release-proofs\/[^'\n]+'/,
      'PROOF_DIR="/home/commonswarm/stack/release-proofs/${RELEASE_SHA}"',
    );
}

function commandStubs(callLog: string, user: string, group: string): string {
  return [
    `CALL_LOG=${shellQuote(callLog)}`,
    'record_call() { printf "%s\\n" "$*" >>"$CALL_LOG"; }',
    'docker() { record_call "docker $*"; if [ "${1:-}" = inspect ]; then printf "%s\\n" healthy; fi; }',
    'psql() { record_call "psql $*"; }',
    'systemctl() { record_call "systemctl $*"; }',
    'ssh() { record_call "ssh $*"; }',
    'sudo() { record_call "sudo $*"; }',
    'curl() { record_call "curl $*"; }',
    `stat() { record_call "stat $*"; printf "%s\\n" ${shellQuote(`${user}:${group}:600`)}; }`,
  ].join("\n");
}

function userAndGroup(): [string, string] {
  const user = spawnSync("id", ["-un"], { encoding: "utf8" });
  const group = spawnSync("id", ["-gn"], { encoding: "utf8" });
  assert.equal(user.status, 0, user.stderr);
  assert.equal(group.status, 0, group.stderr);
  return [user.stdout.trim(), group.stdout.trim()];
}

function verifierScript(
  verifier: string,
  archive: string,
  release: string,
  previous: string,
  proof: string,
  user: string,
  group: string,
): string {
  return [
    "set -euo pipefail",
    "chown() { :; }",
    `ARCHIVE=${shellQuote(archive)}`,
    `SHA=${shellQuote(SHA)}`,
    `PREVIOUS_EDGE=${shellQuote(previous)}`,
    `PROOF_DIR=${shellQuote(proof)}`,
    `RELEASE_OWNER=${shellQuote(user)}`,
    `RELEASE_GROUP=${shellQuote(group)}`,
    `PROOF_OWNER=${shellQuote(user)}`,
    `PROOF_GROUP=${shellQuote(group)}`,
    verifier,
    `prepare_release_directory edge ${shellQuote(release)} 0750`,
  ].join("\n");
}

function safeRemove(root: string): void {
  const resolved = resolve(root);
  assert.equal(dirname(resolved), resolve(tmpdir()));
  assert.ok(basename(resolved).startsWith("commonswarm-window-rerun-"));
  rmSync(resolved, { recursive: true });
}

test("a rollback leaves release and window state acceptable to the next window", () => {
  const runbook = readFileSync(RUNBOOK, "utf8");
  const plan = readFileSync(PLAN, "utf8");
  const planB = readFileSync(PLAN_B, "utf8");
  const apply = extractStep(runbook, "1-apply-release-directories");
  const verifier = extractVerifier(apply);
  const move = extractStep(runbook, "runbook-31");
  const rollback = extractStep(runbook, "runbook-42");
  const close = extractStep(runbook, "runbook-61");
  const [user, group] = userAndGroup();

  const previousText = spawnSync("git", ["show", `${BASE_REVISION}:${RUNBOOK}`], {
    encoding: "utf8",
  });
  assert.equal(previousText.status, 0, previousText.stderr);
  const previousVerifier = extractVerifier(
    extractStep(previousText.stdout, "1-apply-release-directories"),
  );

  const root = mkdtempSync(join(tmpdir(), "commonswarm-window-rerun-"));
  try {
    const homePrefix = join(root, "home", "commonswarm");
    const edgeRoot = join(homePrefix, "edge");
    const stackRoot = join(homePrefix, "stack");
    const previous = join(edgeRoot, "releases", "previous");
    const release = join(edgeRoot, "releases", SHA);
    const proof = join(stackRoot, "release-proofs", SHA);
    const archiveTree = join(root, "archive-tree");
    const archive = join(root, "release.tar");
    const overrideRelative = join("deploy", "edge-runtime", "compose.override.yaml");
    const previousOverride = join(previous, overrideRelative);
    const releaseOverride = join(release, overrideRelative);

    mkdirSync(join(archiveTree, "deploy", "edge-runtime", "main"), { recursive: true });
    writeFileSync(join(archiveTree, "deploy", "edge-runtime", "compose.yaml"), "services: {}\n");
    writeFileSync(join(archiveTree, "deploy", "edge-runtime", "main", "router.ts"), "export {};\n");
    mkdirSync(dirname(previousOverride), { recursive: true });
    writeFileSync(previousOverride, "services:\n  edge-runtime:\n    mem_limit: 2g\n");
    chmodSync(previousOverride, 0o640);
    mkdirSync(join(stackRoot, "releases", "previous"), { recursive: true });
    symlinkSync(previous, join(edgeRoot, "current"));
    symlinkSync(join(stackRoot, "releases", "previous"), join(stackRoot, "current"));
    const tar = spawnSync("tar", ["--no-xattrs", "-cf", archive, "-C", archiveTree, "."], {
      encoding: "utf8",
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    assert.equal(tar.status, 0, tar.stderr);

    mkdirSync(proof, { recursive: true });
    writeFileSync(join(proof, "known-box-only-files.txt"), "");
    const openOne = runShell(verifierScript(
      verifier, archive, release, previous, proof, user, group,
    ));
    assert.equal(openOne.status, 0, openOne.stderr);

    const copyEffect = extractRange(
      move,
      'test -f "$PREVIOUS_EDGE/deploy/edge-runtime/compose.override.yaml"',
      'chown commonswarm:commonswarm "$NEW_EDGE/deploy/edge-runtime/compose.override.yaml"',
    );
    const moved = runShell([
      "set -euo pipefail",
      "chown() { :; }",
      `PREVIOUS_EDGE=${shellQuote(previous)}`,
      `NEW_EDGE=${shellQuote(release)}`,
      copyEffect,
    ].join("\n"));
    assert.equal(moved.status, 0, moved.stderr);
    assert.equal(readFileSync(releaseOverride, "utf8"), readFileSync(previousOverride, "utf8"));

    writeFileSync(
      join(proof, "window.env"),
      `SHA='${SHA}'\nWINDOW_ID='20260929T001030Z'\nPREVIOUS_EDGE='${previous}'\nNEW_EDGE='${release}'\n`,
    );
    writeFileSync(join(proof, "copy-back.list"), "copy-back.list\n");
    chmodSync(join(proof, "copy-back.list"), 0o600);
    const callLog = join(root, "stub-calls.log");
    writeFileSync(callLog, "");
    rmSync(join(edgeRoot, "current"));
    symlinkSync(release, join(edgeRoot, "current"));
    const rolledBack = runShell([
      commandStubs(callLog, user, group),
      `RELEASE_SHA=${shellQuote(SHA)}`,
      bindReleaseSha(rollback)
        .replaceAll("/home/commonswarm", homePrefix)
        .replaceAll("-o root -g root", `-o ${user} -g ${group}`)
        .replaceAll("root:root:600", `${user}:${group}:600`),
    ].join("\n"));
    assert.equal(rolledBack.status, 0, rolledBack.stderr);
    assert.equal(realpathSync(join(edgeRoot, "current")), realpathSync(previous));
    assert.equal(readFileSync(releaseOverride, "utf8"), readFileSync(previousOverride, "utf8"));
    assert.match(readFileSync(callLog, "utf8"), /docker logs/);
    assert.match(readFileSync(callLog, "utf8"), /sudo -u commonswarm/);
    assert.match(readFileSync(callLog, "utf8"), /curl -fsS/);

    const closeOne = runShell(
      [`RELEASE_SHA=${shellQuote(SHA)}`, bindReleaseSha(close)
        .replaceAll("/home/commonswarm", homePrefix),
      ].join("\n"),
    );
    assert.equal(closeOne.status, 0, closeOne.stderr);
    assert.ok(!runbook.includes("release-proofs/*"));
    mkdirSync(`${release}.closed-window-001030`, { recursive: true });

    const oldProof = join(stackRoot, "release-proofs", "old-verifier");
    mkdirSync(oldProof, { recursive: true });
    writeFileSync(join(oldProof, "known-box-only-files.txt"), "");
    const oldOpenTwo = runShell(verifierScript(
      previousVerifier, archive, release, previous, oldProof, user, group,
    ));
    assert.notEqual(oldOpenTwo.status, 0, "pre-change verifier accepted the box-only override");
    assert.match(oldOpenTwo.stderr, /path inventory differs/);

    mkdirSync(proof, { recursive: true });
    writeFileSync(join(proof, "known-box-only-files.txt"), "");
    const openTwo = runShell(verifierScript(
      verifier, archive, release, previous, proof, user, group,
    ));
    assert.equal(openTwo.status, 0, openTwo.stderr);
    assert.match(
      readFileSync(join(proof, "known-box-only-files.txt"), "utf8"),
      /^deploy\/edge-runtime\/compose\.override\.yaml sha256=[0-9a-f]{64} accepted known box-only file\n$/,
    );

    writeFileSync(join(release, "unknown-extra"), "stop\n");
    const unknownExtra = runShell(verifierScript(
      verifier, archive, release, previous, proof, user, group,
    ));
    assert.notEqual(unknownExtra.status, 0, "unknown extra file unexpectedly passed");
    assert.match(unknownExtra.stderr, /unknown-extra/);
    rmSync(join(release, "unknown-extra"));

    writeFileSync(releaseOverride, "changed\n");
    chmodSync(releaseOverride, 0o640);
    const changedOverride = runShell(verifierScript(
      verifier, archive, release, previous, proof, user, group,
    ));
    assert.notEqual(changedOverride.status, 0, "changed override unexpectedly passed");
    assert.match(changedOverride.stderr, /file hash differs: deploy\/edge-runtime\/compose\.override\.yaml/);

    const input = extractStep(planB, "hm37-hosted-human-session-input");
    const stage = extractStep(planB, "hm37-hosted-control-stage");
    assert.match(input, /box-hm37-\$\{WINDOW_ID\}/);
    assert.match(stage, /controls\/\$\{SHA\}-\$\{WINDOW_ID\}/);
    assert.match(stage, /commonswarm-hm37-\$\{WINDOW_ID\}/);
    for (const step of [apply, move, rollback, close, input, stage]) {
      assert.doesNotMatch(step, /(?:find|glob|compgen)[^\n]*closed-window|closed-window[^\n]*[*?]/);
    }
  } finally {
    safeRemove(root);
  }
});
