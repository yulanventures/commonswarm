import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { composeEdgeRuntimeImage, composePath, repoRoot } from "./edge-runtime-function-boot.js";
import { ensureDockerImage, pullDockerImage, type DockerResult } from "./docker-image-pull.js";

const image = composeEdgeRuntimeImage();
const absent: DockerResult = { status: 1, stdout: "", stderr: "No such image" };
const present: DockerResult = { status: 0, stdout: "[]", stderr: "" };
const success: DockerResult = { status: 0, stdout: "Image is up to date", stderr: "" };

// The Docker boundary owns retry coverage for both callers. No service is started.
for (const diagnostic of [
  "Error response from daemon: toomanyrequests: Data limit exceeded",
  "toomanyrequests: Rate exceeded",
  "docker: Error response from daemon: TOOMANYREQUESTS: Rate exceeded",
]) {
  for (const limits of [1, 2]) {
    test(`pinned image recovers after ${limits} ECR limits: ${diagnostic}`, async () => {
      let pulls = 0;
      const waits: number[] = [];
      await ensureDockerImage(image, {
        run(args) {
          if (args[0] === "image") {
            assert.deepEqual(args, ["image", "inspect", image]);
            return absent;
          }
          assert.deepEqual(args, ["pull", image]);
          pulls += 1;
          return pulls <= limits ? { status: 1, stdout: "Pulling layers", stderr: `${diagnostic}\n` } : success;
        },
        async wait(milliseconds) { waits.push(milliseconds); },
      });
      assert.equal(pulls, limits + 1);
      assert.deepEqual(waits, limits === 1 ? [1_000] : [1_000, 2_000]);
    });
  }
}

for (const failure of [
  { status: 1, stdout: "", stderr: "permission denied" },
  { status: 1, stdout: "", stderr: "toomanyrequests: Rate exceeded\npermission denied" },
  { status: 1, stdout: "manifest unknown", stderr: "" },
  { status: null, stdout: "", stderr: "", error: new Error("spawn docker ENOENT") },
  { status: null, stdout: "", stderr: "toomanyrequests: Rate exceeded", error: new Error("spawn docker ETIMEDOUT"), signal: "SIGTERM" as const },
]) {
  test(`non-rate-limit failure stops immediately: ${failure.error?.message || failure.stderr || failure.stdout}`, async () => {
    let pulls = 0;
    const waits: number[] = [];
    await assert.rejects(ensureDockerImage(image, {
      run(args) {
        if (args[0] === "image") return absent;
        pulls += 1;
        return failure;
      },
      async wait(milliseconds) { waits.push(milliseconds); },
    }), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /non-rate-limit error/);
      assert.ok(error.message.includes(failure.error?.message || failure.stderr || failure.stdout));
      return true;
    });
    assert.equal(pulls, 1);
    assert.deepEqual(waits, []);
  });
}

test("exhausted retry budget fails with the final diagnostic", async () => {
  let pulls = 0;
  const waits: number[] = [];
  await assert.rejects(ensureDockerImage(image, {
    run(args) {
      if (args[0] === "image") return absent;
      pulls += 1;
      return {
        status: 1,
        stdout: "",
        stderr: pulls < 3 ? "toomanyrequests: Rate exceeded" : "toomanyrequests: Data limit exceeded",
      };
    },
    async wait(milliseconds) { waits.push(milliseconds); },
  }), /after 3 bounded image-pull attempts.*\n.*Data limit exceeded/s);
  assert.equal(pulls, 3);
  assert.deepEqual(waits, [1_000, 2_000]);
});

test("box caller can retain its explicit skip on exhausted ECR limits", async () => {
  let pulls = 0;
  const result = await pullDockerImage(image, {
    run() {
      pulls += 1;
      return { status: 1, stdout: "", stderr: "toomanyrequests: Rate exceeded" };
    },
    async wait() {},
  });
  assert.equal(result.ready, false);
  assert.equal(pulls, 3);
  if (!result.ready) assert.match(result.reason, /after 3 bounded image-pull attempts.*\n.*Rate exceeded/s);
});

test("the exact pinned image already present needs no pull or wait", async () => {
  const inspected: string[][] = [];
  await ensureDockerImage(image, {
    run(args) {
      inspected.push(args);
      assert.deepEqual(args, ["image", "inspect", image]);
      return present;
    },
    async wait() { assert.fail("a cached image must not wait"); },
  });
  assert.deepEqual(inspected, [["image", "inspect", image]]);
});

test("an image at another tag does not satisfy the Compose pin", async () => {
  const source = readFileSync(composePath, "utf8");
  const changedImage = composeEdgeRuntimeImage(source.replace(image, "public.ecr.aws/supabase/edge-runtime:changed-pin"));
  let pulls = 0;
  await ensureDockerImage(changedImage, {
    run(args) {
      if (args[0] === "image") return args[2] === image ? present : absent;
      assert.deepEqual(args, ["pull", changedImage]);
      pulls += 1;
      return success;
    },
    async wait() { assert.fail("a successful pull must not wait"); },
  });
  assert.equal(pulls, 1);
});

// Execute the workflow's actual shell and ensure entry point. Only Docker is stubbed.
// This catches set -e aborts that the helper's injected Docker boundary cannot see.
const workflow = readFileSync(join(repoRoot, ".github/workflows/server-suite.yml"), "utf8");
const prepareStep = workflow.split("      - name: Prepare the pinned edge-runtime image\n")[1]?.split("      - name:")[0];
assert.ok(prepareStep, "the workflow must prepare the edge-runtime image");
const prepareScript = prepareStep.split("        run: |\n")[1]?.replace(/^          /gm, "");
assert.ok(prepareScript, "the prepare step must have an executable shell block");

for (const scenario of [
  { name: "cold", hit: false, load: "valid", pullFails: false },
  { name: "warm", hit: true, load: "valid", pullFails: false },
  { name: "corrupt archive", hit: true, load: "error", pullFails: false },
  { name: "archive without the exact pin", hit: true, load: "wrong-image", pullFails: false },
  { name: "corrupt archive and exhausted pull", hit: true, load: "error", pullFails: true },
]) {
  test(`workflow image preparation handles ${scenario.name}`, { timeout: 15_000 }, (context) => {
    const tempRoot = realpathSync(tmpdir());
    const work = mkdtempSync(join(tempRoot, "ci-edge-cache-"));
    context.after(() => {
      const resolved = realpathSync(work);
      assert.ok(resolved.startsWith(join(tempRoot, "ci-edge-cache-")));
      assert.notEqual(resolved, process.env.HOME);
      const removed = spawnSync("rm", ["-r", resolved], { encoding: "utf8" });
      assert.equal(removed.status, 0, removed.stderr);
    });
    const statePath = join(work, "state.json");
    const archivePath = join(work, "edge-runtime-image.tar");
    const sentinelPath = join(work, "unrelated.txt");
    writeFileSync(statePath, JSON.stringify({ images: [], calls: [] }));
    writeFileSync(sentinelPath, "keep this file");
    if (scenario.hit) writeFileSync(archivePath, "restored archive");
    writeFileSync(join(work, "docker"), `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(process.env.DOCKER_STATE, "utf8"));
const image = process.env.EDGE_RUNTIME_IMAGE;
state.calls.push(args);
let status = 0;
if (args[0] === "load" && args[1] === "--input" && args[2] === process.env.EDGE_RUNTIME_CACHE) {
  if (!fs.existsSync(args[2])) throw new Error("missing cache archive");
  if (process.env.DOCKER_LOAD === "error") {
    console.error("unexpected EOF");
    status = 1;
  } else {
    state.images.push(process.env.DOCKER_LOAD === "valid" ? image : image + "-other");
  }
} else if (args[0] === "image" && args[1] === "inspect" && args[2] === image) {
  status = state.images.includes(image) ? 0 : 1;
} else if (args[0] === "pull" && args[1] === image) {
  if (process.env.DOCKER_PULL_FAILS === "true") {
    console.error("toomanyrequests: Rate exceeded");
    status = 1;
  } else {
    state.images.push(image);
  }
} else if (args[0] === "save" && args[1] === "--output" && args[2] === process.env.EDGE_RUNTIME_CACHE && args[3] === image) {
  if (!state.images.includes(image)) throw new Error("saving an absent image");
  fs.writeFileSync(args[2], "fresh archive: " + image);
} else {
  throw new Error("unexpected Docker call: " + JSON.stringify(args));
}
fs.writeFileSync(process.env.DOCKER_STATE, JSON.stringify(state));
process.exit(status);
`, { mode: 0o755 });
    const result = spawnSync("bash", ["-c", prepareScript], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 12_000,
      env: {
        ...process.env,
        PATH: `${work}:${process.env.PATH}`,
        EDGE_RUNTIME_IMAGE: image,
        EDGE_RUNTIME_CACHE: archivePath,
        EDGE_RUNTIME_CACHE_HIT: scenario.hit ? "true" : "",
        DOCKER_STATE: statePath,
        DOCKER_LOAD: scenario.load,
        DOCKER_PULL_FAILS: String(scenario.pullFails),
      },
    });
    assert.equal(result.error, undefined);
    const state = JSON.parse(readFileSync(statePath, "utf8")) as { images: string[]; calls: string[][] };
    assert.equal(readFileSync(sentinelPath, "utf8"), "keep this file");
    const calls = (command: string) => state.calls.filter(args => args[0] === command);
    assert.equal(calls("load").length, scenario.hit ? 1 : 0);
    const needsPull = !scenario.hit || scenario.load !== "valid";
    assert.equal(calls("pull").length, scenario.pullFails ? 3 : needsPull ? 1 : 0);
    assert.equal(`${result.stdout}${result.stderr}`.match(/^Warning:.*$/gm)?.length ?? 0,
      scenario.hit && scenario.load !== "valid" ? 1 : 0);
    if (scenario.pullFails) {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /after 3 bounded image-pull attempts.*\n.*Rate exceeded/s);
      assert.ok(!state.images.includes(image));
      assert.equal(calls("save").length, 0);
    } else {
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.ok(state.images.includes(image), "the exact Compose image must be available");
      assert.equal(calls("save").length, needsPull ? 1 : 0);
      assert.ok(existsSync(archivePath));
      assert.equal(readFileSync(archivePath, "utf8"), needsPull ? `fresh archive: ${image}` : "restored archive");
      if (needsPull) assert.ok(state.calls.findIndex(args => args[0] === "save") > state.calls.findIndex(args => args[0] === "pull"));
    }
  });
}
