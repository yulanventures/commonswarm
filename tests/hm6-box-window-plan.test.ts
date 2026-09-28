import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test } from "node:test";

const PLAN = "docs/evidence/2026-09-28-box-hm6/BOX-WINDOW.md";
const RELEASE_SHA = "826db6a34f235064a3a03c57377d8e32a35d2f05";
const STEP = "hm6-build-retry-image";
const BUILT_IMAGE = `sha256:${"1".repeat(64)}`;
const PREVIOUS_IMAGE = "sha256:208fe56df796e9ac52906d619af50468441146b7e2d2bfc0decb8880164a28b7";

const FAKE_DOCKER = `#!/bin/bash
set -euo pipefail
: "\${FAKE_DOCKER_STATE:?}"
printf '%s\\n' "$*" >>"$FAKE_DOCKER_STATE/commands.log"
IFS= read -r base_reference <"$FAKE_DOCKER_STATE/base-reference"
base_digest="\${base_reference#*@}"
case "\${1:-}" in
  pull)
    test "$#" -eq 2
    test "$2" = "$base_reference"
    printf '%s\\n' "$2" >"$FAKE_DOCKER_STATE/pulled"
    ;;
  image)
    test "\${2:-}" = inspect
    reference="\${3:-}"
    if test "$reference" = "$base_reference"; then
      test -f "$FAKE_DOCKER_STATE/pulled"
      printf '[{"Id":"sha256:%064d","RepoDigests":["node@%s"],"RootFS":{"Type":"layers","Layers":["sha256:base-one","sha256:base-two"]},"Os":"linux","Architecture":"amd64"}]\\n' 2 "$base_digest"
    elif test "$reference" = "${PREVIOUS_IMAGE}"; then
      printf '[{"Id":"%s"}]\n' "$reference"
    elif test "$reference" = "${BUILT_IMAGE}"; then
      test -f "$FAKE_DOCKER_STATE/built"
      if test "\${FAKE_DOCKER_BAD_LAYERS:-0}" = 1; then
        layers='["sha256:wrong-base","sha256:app"]'
      else
        layers='["sha256:base-one","sha256:base-two","sha256:app"]'
      fi
      printf '[{"Id":"%s","RepoDigests":[],"RootFS":{"Type":"layers","Layers":%s},"Os":"linux","Architecture":"amd64"}]\\n' "$reference" "$layers"
    else
      exit 41
    fi
    ;;
  build)
    shift
    iidfile=
    while test "$#" -gt 0; do
      case "$1" in
        --iidfile)
          iidfile="$2"
          shift 2
          ;;
        --file)
          shift 2
          ;;
        *)
          shift
          ;;
      esac
    done
    test -n "$iidfile"
    printf '%s\\n' "${BUILT_IMAGE}" >"$iidfile"
    printf '%s\\n' "${BUILT_IMAGE}" >"$FAKE_DOCKER_STATE/built"
    ;;
  push)
    exit 42
    ;;
  *)
    exit 43
    ;;
esac
`;

function extractStep(plan: string): string {
  const opening = `\`\`\`sh\n# step: ${STEP}\n`;
  const start = plan.indexOf(opening);
  assert.ok(start >= 0, `${STEP} shell block is missing`);
  assert.equal(plan.indexOf(opening, start + opening.length), -1, `${STEP} is duplicated`);
  const bodyStart = start + "```sh\n".length;
  const end = plan.indexOf("\n```", bodyStart);
  assert.ok(end > bodyStart, `${STEP} shell block is unterminated`);
  const source = plan.slice(bodyStart, end) + "\n";
  assert.equal(source.split("\n")[0], `# step: ${STEP}`);
  return source;
}

function shellLiteral(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function removeTemporaryRoot(root: string): Promise<void> {
  const resolvedRoot = resolve(root);
  const resolvedTmp = resolve(tmpdir());
  assert.equal(dirname(resolvedRoot), resolvedTmp);
  assert.ok(basename(resolvedRoot).startsWith("cswarm-hm6-image-plan-"));
  await rm(resolvedRoot, { recursive: true });
}

interface ScenarioResult {
  status: number | null;
  stderr: string;
  commands: string;
  proof: string;
}

test("HM6 image step pulls and verifies the pinned base before a structural image check", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cswarm-hm6-image-plan-"));
  try {
    const plan = await readFile(PLAN, "utf8");
    const originalStep = extractStep(plan);
    const releasedDockerfile = execFileSync(
      "git",
      ["show", `${RELEASE_SHA}:services/mcp-auth/Dockerfile`],
      { encoding: "utf8" },
    );
    const baseReference = releasedDockerfile.split("\n")[0]?.replace(/^FROM /, "");
    assert.match(baseReference ?? "", /^[^@\s]+@sha256:[0-9a-f]{64}$/);

    const fakeBin = join(temporaryRoot, "bin");
    await mkdir(fakeBin);
    await writeFile(join(fakeBin, "docker"), FAKE_DOCKER, { mode: 0o755 });

    let scenarioNumber = 0;
    async function runScenario(
      source: string,
      badLayers = false,
    ): Promise<ScenarioResult> {
      scenarioNumber += 1;
      const scenario = join(temporaryRoot, `scenario-${scenarioNumber}`);
      const stack = join(scenario, "stack");
      const oauth = join(scenario, "oauth");
      const proof = join(scenario, "proof");
      const state = join(scenario, "docker-state");
      for (const directory of [
        join(stack, "services/mcp-auth"),
        join(oauth, "services/mcp-auth"),
        proof,
        state,
      ]) {
        await mkdir(directory, { recursive: true });
      }
      for (const release of [stack, oauth]) {
        const service = join(release, "services/mcp-auth");
        await writeFile(join(service, "Dockerfile"), releasedDockerfile);
        await writeFile(join(service, "package-lock.json"), "{}\n");
        await writeFile(
          join(service, "package.json"),
          JSON.stringify({ dependencies: { "oidc-provider": "9.12.2" } }) + "\n",
        );
      }
      await writeFile(join(state, "base-reference"), `${baseReference}\n`);
      await writeFile(join(state, "commands.log"), "");
      await writeFile(
        join(proof, "window.env"),
        [
          `NEW_STACK=${shellLiteral(stack)}`,
          `NEW_OAUTH=${shellLiteral(oauth)}`,
          `SHA=${RELEASE_SHA}`,
          "",
        ].join("\n"),
      );
      const executable = source.replace(
        /^  PROOF_DIR=\/home\/commonswarm\/stack\/release-proofs\/[0-9a-f]{40}$/m,
        `  PROOF_DIR=${shellLiteral(proof)}`,
      );
      assert.notEqual(executable, source, "test must redirect the box proof directory");
      const result = spawnSync("/bin/bash", ["-c", executable], {
        cwd: scenario,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
          FAKE_DOCKER_STATE: state,
          FAKE_DOCKER_BAD_LAYERS: badLayers ? "1" : "0",
        },
      });
      return {
        status: result.status,
        stderr: result.stderr,
        commands: await readFile(join(state, "commands.log"), "utf8"),
        proof,
      };
    }

    const clean = await runScenario(originalStep);
    assert.equal(clean.status, 0, clean.stderr);
    const evidence = JSON.parse(
      await readFile(join(clean.proof, "oauth-image.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(evidence.base_digest, baseReference?.split("@")[1]);
    assert.equal(evidence.base_layer_count, 2);
    assert.equal(evidence.built_image_id, BUILT_IMAGE);
    assert.equal(evidence.base_layer_prefix_verified, true);
    assert.ok(clean.commands.indexOf(`pull ${baseReference}`) >= 0);
    assert.ok(
      clean.commands.indexOf(`pull ${baseReference}`) < clean.commands.indexOf("build "),
      clean.commands,
    );

    const pullLine = '  docker pull "$BASE_REFERENCE"\n';
    const withoutPull = originalStep.replace(pullLine, "");
    assert.notEqual(withoutPull, originalStep, "pull mutation did not apply");
    const missingPull = await runScenario(withoutPull);
    assert.notEqual(missingPull.status, 0, "a clean store must reject a missing pull");

    const buildEnd = '    "$NEW_OAUTH/services/mcp-auth"\n';
    const pullAfterBuild = withoutPull.replace(buildEnd, buildEnd + pullLine);
    assert.notEqual(pullAfterBuild, withoutPull, "late-pull mutation did not apply");
    const latePull = await runScenario(pullAfterBuild);
    assert.notEqual(latePull.status, 0, "base verification must happen before build");
    assert.doesNotMatch(latePull.commands, /^build /m);

    const wrongLayers = await runScenario(originalStep, true);
    assert.notEqual(wrongLayers.status, 0, "a non-prefix built RootFS must be rejected");
    assert.match(wrongLayers.commands, /^build /m);

    for (const scenario of [clean, missingPull, latePull, wrongLayers]) {
      assert.doesNotMatch(scenario.commands, /^push(?: |$)/m);
    }
  } finally {
    await removeTemporaryRoot(temporaryRoot);
  }
});
