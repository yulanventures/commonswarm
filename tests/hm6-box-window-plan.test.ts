import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test } from "node:test";

const PLAN = "docs/evidence/2026-09-28-box-hm6/BOX-WINDOW.md";
const RELEASE_SHA = "826db6a34f235064a3a03c57377d8e32a35d2f05";
const STEP = "hm6-build-retry-image";
const REUSED_IMAGE = `sha256:5511a358${"2".repeat(56)}`;
const BUILT_IMAGE = `sha256:${"1".repeat(64)}`;
const PREVIOUS_IMAGE = "sha256:208fe56df796e9ac52906d619af50468441146b7e2d2bfc0decb8880164a28b7";
const BASE_LAYERS = [1, 2, 3, 4, 5].map(value => `sha256:base-${value}`);

const FAKE_DOCKER = `#!/bin/bash
set -euo pipefail
: "\${FAKE_DOCKER_STATE:?}"
printf '%s\\n' "$*" >>"$FAKE_DOCKER_STATE/commands.log"
IFS= read -r base_reference <"$FAKE_DOCKER_STATE/base-reference"
base_digest="\${base_reference#*@}"
base_layers='["sha256:base-1","sha256:base-2","sha256:base-3","sha256:base-4","sha256:base-5"]'
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
      printf '[{"Id":"sha256:%064d","RepoDigests":["node@%s"],"RootFS":{"Type":"layers","Layers":%s},"Os":"linux","Architecture":"amd64"}]\\n' 2 "$base_digest" "$base_layers"
    elif test "$reference" = "${PREVIOUS_IMAGE}"; then
      printf '[{"Id":"%s"}]\\n' "$reference"
    elif test "$reference" = "${REUSED_IMAGE}"; then
      if test "\${FAKE_DOCKER_BAD_REUSED_LAYERS:-0}" = 1; then
        layers='["sha256:wrong-base","sha256:app"]'
      else
        layers='["sha256:base-1","sha256:base-2","sha256:base-3","sha256:base-4","sha256:base-5","sha256:app"]'
      fi
      printf '[{"Id":"%s","RepoDigests":[],"RootFS":{"Type":"layers","Layers":%s},"Os":"linux","Architecture":"amd64"}]\\n' "$reference" "$layers"
    elif test "$reference" = "${BUILT_IMAGE}"; then
      test -f "$FAKE_DOCKER_STATE/built"
      if test "\${FAKE_DOCKER_BAD_BUILT_LAYERS:-0}" = 1; then
        layers='["sha256:wrong-base","sha256:app"]'
      else
        layers='["sha256:base-1","sha256:base-2","sha256:base-3","sha256:base-4","sha256:base-5","sha256:app"]'
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
        --iidfile) iidfile="$2"; shift 2 ;;
        --file) shift 2 ;;
        *) shift ;;
      esac
    done
    test -n "$iidfile"
    printf '%s\\n' "${BUILT_IMAGE}" >"$iidfile"
    printf '%s\\n' "${BUILT_IMAGE}" >"$FAKE_DOCKER_STATE/built"
    ;;
  push) exit 42 ;;
  *) exit 43 ;;
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
  return plan.slice(bodyStart, end) + "\n";
}

function shellLiteral(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function removeTemporaryRoot(root: string): Promise<void> {
  const resolvedRoot = resolve(root);
  assert.equal(dirname(resolvedRoot), resolve(tmpdir()));
  assert.ok(basename(resolvedRoot).startsWith("cswarm-hm6-image-plan-"));
  await rm(resolvedRoot, { recursive: true });
}

interface ScenarioResult {
  status: number | null;
  stderr: string;
  commands: string;
  proof: string;
}

test("HM6 v5 plan locks the preflight, BIC, secret staging, Caddy, and JWKS contracts", async () => {
  const plan = await readFile(PLAN, "utf8");
  const steps = [...plan.matchAll(/^# step: ([a-z0-9-]+)$/gm)].map(match => match[1]);
  assert.equal(steps[0], "hm6-open-continuation-window");
  assert.equal(new Set(steps).size, steps.length);
  assert.ok(steps.length >= 20 && steps.length <= 30, `unexpected step count: ${steps.length}`);

  const openStart = plan.indexOf("# step: hm6-open-continuation-window");
  const openEnd = plan.indexOf("\n```", openStart);
  const openStep = plan.slice(openStart, openEnd);
  assert.match(openStep, /MCP_CADDY_SITE=/);
  assert.match(openStep, /copy-back\.list/);
  assert.match(openStep, /stat -c '%U:%G:%a'/);

  const bic = plan.indexOf("# step: hm6-verify-bic-decision");
  const caddy = plan.indexOf("# step: hm6-install-reviewed-caddy");
  const ingress = plan.indexOf("# step: hm6-probe-nonbrowser-ingress");
  assert.ok(openStart < bic && bic < caddy && caddy < ingress);
  assert.match(plan, /mktemp -d \/private\/tmp\//);
  assert.doesNotMatch(plan, /CF_DNS_TOKEN_FILE/);

  const strictJwks = "assert media_type in {'application/jwk-set+json', 'application/json'}";
  assert.equal(plan.split(strictJwks).length - 1, 2);
  assert.equal(plan.split("assert media_type == 'application/json'").length - 1, 2);
});

test("HM6 image step reuses verified v4 image and rebuilds only after failed identity checks", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cswarm-hm6-image-plan-"));
  try {
    const originalStep = extractStep(await readFile(PLAN, "utf8"));
    const releasedDockerfile = execFileSync(
      "git", ["show", `${RELEASE_SHA}:services/mcp-auth/Dockerfile`], { encoding: "utf8" },
    );
    const baseReference = releasedDockerfile.split("\n")[0]?.replace(/^FROM /, "");
    assert.match(baseReference ?? "", /^[^@\s]+@sha256:[0-9a-f]{64}$/);
    const fakeBin = join(temporaryRoot, "bin");
    await mkdir(fakeBin);
    await writeFile(join(fakeBin, "docker"), FAKE_DOCKER, { mode: 0o755 });

    let scenarioNumber = 0;
    async function runScenario(options: {
      badEvidence?: boolean;
      badReusedLayers?: boolean;
      badBuiltLayers?: boolean;
      source?: string;
    } = {}): Promise<ScenarioResult> {
      scenarioNumber += 1;
      const scenario = join(temporaryRoot, `scenario-${scenarioNumber}`);
      const stack = join(scenario, "stack");
      const oauth = join(scenario, "oauth");
      const proof = join(scenario, "proof");
      const state = join(scenario, "docker-state");
      for (const directory of [join(stack, "services/mcp-auth"), join(oauth, "services/mcp-auth"), proof, state]) {
        await mkdir(directory, { recursive: true });
      }
      for (const release of [stack, oauth]) {
        const service = join(release, "services/mcp-auth");
        await writeFile(join(service, "Dockerfile"), releasedDockerfile);
        await writeFile(join(service, "package-lock.json"), "{}\n");
        await writeFile(join(service, "package.json"), JSON.stringify({ dependencies: { "oidc-provider": "9.12.2" } }) + "\n");
      }
      await writeFile(join(state, "base-reference"), `${baseReference}\n`);
      await writeFile(join(state, "commands.log"), "");
      await writeFile(join(proof, "window.env"), [
        `NEW_STACK=${shellLiteral(stack)}`,
        `NEW_OAUTH=${shellLiteral(oauth)}`,
        `SHA=${RELEASE_SHA}`,
        "",
      ].join("\n"));
      await writeFile(join(proof, "oauth-image.json"), JSON.stringify({
        release_sha: RELEASE_SHA,
        local_image_id: REUSED_IMAGE,
        base_reference: baseReference,
        base_digest: baseReference?.split("@")[1],
        base_layer_count: options.badEvidence ? 4 : BASE_LAYERS.length,
        base_layer_prefix_verified: true,
      }) + "\n");
      const source = options.source ?? originalStep;
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
          FAKE_DOCKER_BAD_REUSED_LAYERS: options.badReusedLayers ? "1" : "0",
          FAKE_DOCKER_BAD_BUILT_LAYERS: options.badBuiltLayers ? "1" : "0",
        },
      });
      return {
        status: result.status,
        stderr: result.stderr,
        commands: await readFile(join(state, "commands.log"), "utf8"),
        proof,
      };
    }

    const reused = await runScenario();
    assert.equal(reused.status, 0, reused.stderr);
    const reusedEvidence = JSON.parse(await readFile(join(reused.proof, "oauth-image.json"), "utf8"));
    assert.equal(reusedEvidence.local_image_id, REUSED_IMAGE);
    assert.equal(reusedEvidence.base_layer_count, 5);
    assert.equal(reusedEvidence.base_layer_prefix_verified, true);
    assert.equal(reusedEvidence.v4_image_reused, true);
    assert.doesNotMatch(reused.commands, /^build /m);

    for (const fallback of [
      await runScenario({ badEvidence: true }),
      await runScenario({ badReusedLayers: true }),
    ]) {
      assert.equal(fallback.status, 0, fallback.stderr);
      assert.match(fallback.commands, /^build /m);
      const evidence = JSON.parse(await readFile(join(fallback.proof, "oauth-image.json"), "utf8"));
      assert.equal(evidence.local_image_id, BUILT_IMAGE);
      assert.equal(evidence.v4_image_reused, false);
      assert.equal(evidence.fallback_build_completed, true);
    }

    const wrongBuiltLayers = await runScenario({ badEvidence: true, badBuiltLayers: true });
    assert.notEqual(wrongBuiltLayers.status, 0, "fallback image with a non-prefix RootFS must be rejected");

    const pullLine = '  docker pull "$BASE_REFERENCE"\n';
    const withoutPull = originalStep.replace(pullLine, "");
    assert.notEqual(withoutPull, originalStep, "pull mutation did not apply");
    const missingPull = await runScenario({ source: withoutPull });
    assert.notEqual(missingPull.status, 0, "a clean base store must reject a missing pull");

    for (const scenario of [reused, wrongBuiltLayers, missingPull]) {
      assert.doesNotMatch(scenario.commands, /^push(?: |$)/m);
    }
  } finally {
    await removeTemporaryRoot(temporaryRoot);
  }
});
