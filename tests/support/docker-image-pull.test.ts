import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { composeEdgeRuntimeImage, composePath, repoRoot } from "./edge-runtime-function-boot.js";
import { ensureDockerImage, IMAGE_PULL_ATTEMPTS, pullDockerImage, type DockerResult } from "./docker-image-pull.js";

const image = composeEdgeRuntimeImage();
const ghcrImage = image.replace("public.ecr.aws/", "ghcr.io/");
const hubImage = image.replace("public.ecr.aws/", "");
const absent: DockerResult = { status: 1, stdout: "", stderr: "No such image" };
const present: DockerResult = { status: 0, stdout: "[]", stderr: "" };
const success: DockerResult = { status: 0, stdout: "Image is up to date", stderr: "" };
const quiet = { log() {} };

// A fake Docker for the helper: every pull answers from `answer`, and every call is recorded.
function stubDocker(answer: (reference: string, round: number) => DockerResult, local: DockerResult = absent) {
  const calls: string[][] = [];
  const waits: number[] = [];
  const attempts = new Map<string, number>();
  return {
    calls,
    waits,
    pulls: () => calls.filter(args => args[0] === "pull").map(args => args[1]),
    dependencies: {
      ...quiet,
      run(args: string[]) {
        calls.push(args);
        if (args[0] === "image") return local;
        if (args[0] === "tag") return present;
        assert.equal(args[0], "pull");
        const round = (attempts.get(args[1]) ?? 0) + 1;
        attempts.set(args[1], round);
        return answer(args[1], round);
      },
      async wait(milliseconds: number) { waits.push(milliseconds); },
    },
  };
}

// Any failure is retried in the next round, at every registry, as the CI image caches do (#486, #487).
for (const failure of [
  { status: 1, stdout: "", stderr: "Error response from daemon: toomanyrequests: Data limit exceeded" },
  { status: 1, stdout: "", stderr: "Error response from daemon: error from registry: Data limit exceeded" },
  { status: 1, stdout: "", stderr: "Error response from daemon: Get \"https://public.ecr.aws/v2/\": net/http: TLS handshake timeout" },
  { status: 1, stdout: "manifest unknown", stderr: "" },
  { status: null, stdout: "", stderr: "", error: new Error("spawn docker ETIMEDOUT"), signal: "SIGTERM" as const },
]) {
  for (const failedRounds of [1, 2]) {
    test(`a pinned image recovers after ${failedRounds} failed round(s): ${failure.error?.message || failure.stderr || failure.stdout}`, async () => {
      const docker = stubDocker((_, round) => round <= failedRounds ? failure : success);
      await ensureDockerImage(image, docker.dependencies);
      const round = [image, ghcrImage, hubImage];
      assert.deepEqual(docker.pulls(), [...Array.from({ length: failedRounds }, () => round).flat(), image]);
      assert.deepEqual(docker.waits, failedRounds === 1 ? [5_000] : [5_000, 15_000]);
      assert.equal(docker.calls.filter(args => args[0] === "tag").length, 0);
    });
  }
}

test("an ECR data limit falls through to GHCR in the same round, tagged as the requested image", async () => {
  const docker = stubDocker(reference => reference === image
    ? { status: 1, stdout: "", stderr: "Error response from daemon: error from registry: Data limit exceeded" }
    : success);
  await ensureDockerImage(image, docker.dependencies);
  assert.deepEqual(docker.pulls(), [image, ghcrImage]);
  assert.deepEqual(docker.calls.at(-1), ["tag", ghcrImage, image]);
  assert.deepEqual(docker.waits, []);
});

test("a Docker Hub official image falls back to ECR's and Google's mirrors of the same tag", async () => {
  const docker = stubDocker(reference => reference.startsWith("mirror.gcr.io/")
    ? success
    : { status: 1, stdout: "", stderr: "toomanyrequests: You have reached your unauthenticated pull rate limit." });
  await ensureDockerImage("postgres:17.11", docker.dependencies);
  assert.deepEqual(docker.pulls(), ["postgres:17.11", "public.ecr.aws/docker/library/postgres:17.11", "mirror.gcr.io/library/postgres:17.11"]);
  assert.deepEqual(docker.calls.at(-1), ["tag", "mirror.gcr.io/library/postgres:17.11", "postgres:17.11"]);
});

test("a Docker Hub supabase image tries ECR and GHCR after Docker Hub", async () => {
  const docker = stubDocker(() => ({ status: 1, stdout: "", stderr: "Rate exceeded" }));
  const result = await pullDockerImage("supabase/postgres:17.6.1.147", docker.dependencies);
  assert.equal(result.ready, false);
  assert.deepEqual(docker.pulls().slice(0, 3), ["supabase/postgres:17.6.1.147", "public.ecr.aws/supabase/postgres:17.6.1.147", "ghcr.io/supabase/postgres:17.6.1.147"]);
});

test("a digest reference is retried at its own registry only", async () => {
  const pinned = `public.ecr.aws/supabase/edge-runtime@sha256:${"e".repeat(64)}`;
  const docker = stubDocker((_, round) => round < 3 ? { status: 1, stdout: "", stderr: "Rate exceeded" } : success);
  await ensureDockerImage(pinned, docker.dependencies);
  assert.deepEqual(docker.pulls(), [pinned, pinned, pinned]);
});

test("a failure that persists fails after every round with each registry's diagnostic", async () => {
  const docker = stubDocker(reference => ({ status: 1, stdout: "", stderr: `manifest unknown at ${reference}` }));
  await assert.rejects(ensureDockerImage(image, docker.dependencies), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, new RegExp(`failed after ${IMAGE_PULL_ATTEMPTS} rounds`));
    for (const reference of [image, ghcrImage, hubImage]) assert.ok(error.message.includes(`manifest unknown at ${reference}`));
    return true;
  });
  assert.equal(IMAGE_PULL_ATTEMPTS, 4);
  assert.equal(docker.pulls().length, 3 * IMAGE_PULL_ATTEMPTS);
  assert.deepEqual(docker.waits, [5_000, 15_000, 45_000]);
});

test("a failure mixed with registry limits fails instead of skipping", async () => {
  const docker = stubDocker(reference => reference === hubImage
    ? { status: 1, stdout: "", stderr: "toomanyrequests: Rate exceeded\npermission denied" }
    : { status: 1, stdout: "", stderr: "toomanyrequests: Rate exceeded" });
  await assert.rejects(pullDockerImage(image, docker.dependencies), /failed after 4 rounds.*permission denied/s);
});

test("the box caller keeps its explicit skip when every registry stays rate limited", async () => {
  const docker = stubDocker(reference => ({
    status: 1, stdout: "", stderr: reference === ghcrImage ? "toomanyrequests: Rate exceeded" : "error from registry: Data limit exceeded",
  }));
  const result = await pullDockerImage(image, docker.dependencies);
  assert.equal(result.ready, false);
  assert.equal(docker.pulls().length, 3 * IMAGE_PULL_ATTEMPTS);
  if (!result.ready) assert.match(result.reason, /rate limits persisted after 4 rounds.*\n.*Data limit exceeded/s);
  await assert.rejects(ensureDockerImage(image, stubDocker(() => ({ status: 1, stdout: "", stderr: "Rate exceeded" })).dependencies),
    /rate limits persisted/);
});

for (const helper of [ensureDockerImage, pullDockerImage]) {
  test(`the exact pinned image already present needs no pull or wait (${helper.name})`, async () => {
    const docker = stubDocker(() => assert.fail("a cached image must not be pulled"), present);
    await helper(image, docker.dependencies);
    assert.deepEqual(docker.calls, [["image", "inspect", image]]);
    assert.deepEqual(docker.waits, []);
  });
}

test("an image at another tag does not satisfy the Compose pin", async () => {
  const source = readFileSync(composePath, "utf8");
  const changedImage = composeEdgeRuntimeImage(source.replace(image, "public.ecr.aws/supabase/edge-runtime:changed-pin"));
  let pulls = 0;
  await ensureDockerImage(changedImage, {
    ...quiet,
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

// Execute the workflow's actual shell for the pinned image cache (#480). Only Docker, zstd and the
// Supabase CLI are stubbed; scripts/ci/server-suite.mjs runs for real.
const workflow = readFileSync(join(repoRoot, ".github/workflows/server-suite.yml"), "utf8");
function stepScript(name: string, marker = "        run: |\n"): string {
  const step = workflow.split(`      - name: ${name}\n`)[1]?.split("      - name:")[0];
  assert.ok(step, `the workflow must have the step ${name}`);
  const script = step.split(marker)[1]?.replace(/^          /gm, "");
  assert.ok(script, `${name} must have an executable shell block`);
  return script;
}
const prepareScript = stepScript("Prepare the pinned images");

const cliDockerfile = [
  "FROM supabase/postgres:17.6.1.171 AS pg",
  "FROM library/kong:2.8.1 AS kong",
  "FROM axllent/mailpit:v1.30.2 AS mailpit",
  "FROM postgrest/postgrest:v16.3 AS postgrest",
  "FROM supabase/postgres-meta:v0.99.0 AS pgmeta",
  "FROM supabase/studio:2026.09.14-sha-4dd8a95 AS studio",
  "FROM darthsim/imgproxy:v3.8.0 AS imgproxy",
  "FROM supabase/edge-runtime:v1.76.2 AS edgeruntime",
  "FROM timberio/vector:0.53.0-alpine AS vector",
  "FROM supabase/supavisor:2.9.13 AS supavisor",
  "FROM supabase/gotrue:v2.197.0 AS gotrue",
  "FROM supabase/realtime:v2.135.3 AS realtime",
  "FROM supabase/storage-api:v1.77.0 AS storage",
  "FROM supabase/logflare:1.50.12 AS logflare",
  "FROM supabase/pg_prove:3.36 AS pgprove",
].join("\n");
const stackImages = [...cliDockerfile.matchAll(/^FROM \S+\/(\S+) AS (\w+)$/gm)]
  .filter(match => !["imgproxy", "supavisor", "pgprove"].includes(match[2]))
  .map(match => `public.ecr.aws/supabase/${match[1]}`);
const digest = "sha256:e8ddc7b0f4888818159d4b665e922de667948e2864c895ed62acdfd29e7c6c80";
const edgePrimary = `public.ecr.aws/supabase/edge-runtime@${digest}`;
const edgeMirror = `ghcr.io/supabase/edge-runtime@${digest}`;
const allImages = [image, ...stackImages];

// Each image is its own file, so the four concurrent pulls never race on shared state.
const fakeDocker = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const dir = process.env.DOCKER_STATE;
const file = name => path.join(dir, "images", encodeURIComponent(name));
const read = name => fs.existsSync(file(name)) ? JSON.parse(fs.readFileSync(file(name), "utf8")) : undefined;
const write = (name, value) => fs.writeFileSync(file(name), JSON.stringify(value));
fs.appendFileSync(path.join(dir, "calls.log"), JSON.stringify(args) + "\\n");
const fail = message => { console.error(message); process.exit(1); };
const repository = ref => ref.split("@")[0].replace(/:[^/:]+$/, "").replace(/^library\\//, "");
if (args[0] === "pull" && args[1] === "--quiet") {
  const ref = args[2];
  const mode = process.env.DOCKER_PULL;
  const attempt = fs.readFileSync(path.join(dir, "calls.log"), "utf8").split("\\n").filter(line => line === JSON.stringify(args)).length;
  if (mode === "denied") fail("Error response from daemon: pull access denied");
  if (mode === "flaky" && attempt === 1) fail("Error response from daemon: Get \\"https://registry\\": net/http: TLS handshake timeout");
  if (["data-limit", "bad-mirror"].includes(mode) && ref.startsWith("public.ecr.aws/")) fail("error from registry: Data limit exceeded");
  const pinned = ref.includes("@");
  const repoDigest = pinned ? (mode === "bad-mirror" ? ref + "wrong" : ref) : repository(ref) + "@sha256:" + "c".repeat(64);
  write(ref, { Id: "sha256:" + "a".repeat(64), Os: "linux", Architecture: "amd64", RootFS: { Layers: ["sha256:" + Buffer.from(repository(ref).split("/").pop() + ref.split(/[:@]/).pop()).toString("hex")] }, RepoDigests: [repoDigest] });
} else if (args[0] === "image" && args[1] === "inspect") {
  const found = read(args[2]);
  if (!found) fail("Error: No such image: " + args[2]);
  console.log(JSON.stringify([found]));
} else if (args[0] === "tag") {
  const found = read(args[1]);
  if (!found) fail("No such image");
  write(args[2], { ...found, RepoDigests: found.RepoDigests });
} else if (args[0] === "save") {
  const saved = Object.fromEntries(args.slice(1).map(name => { const found = read(name); if (!found) fail("absent " + name); return [name, found]; }));
  process.stdout.write(JSON.stringify(saved));
} else if (args[0] === "load" && args[1] === "--quiet") {
  if (process.env.DOCKER_LOAD === "error") fail("unexpected EOF");
  const saved = JSON.parse(fs.readFileSync(0, "utf8"));
  for (const [name, value] of Object.entries(saved)) {
    write(name, process.env.DOCKER_LOAD === "wrong-image" ? { ...value, RootFS: { Layers: ["sha256:other"] } } : value);
  }
} else if (args[0] === "image" && args[1] === "ls") {
  const names = fs.readdirSync(path.join(dir, "images")).map(decodeURIComponent);
  if (process.env.DOCKER_EXTRA_IMAGE) names.push(process.env.DOCKER_EXTRA_IMAGE);
  for (const name of names) console.log("sha256:" + "a".repeat(64) + " " + name);
} else if (args[0] === "ps") {
  process.stdout.write(process.env.DOCKER_PS || "");
} else {
  fail("unexpected Docker call: " + JSON.stringify(args));
}
`;
// zstd stands in as a byte-for-byte copy.
const fakeZstd = `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") process.exit(0);
if (args[0] === "-dc") { process.stdout.write(fs.readFileSync(args[2])); process.exit(0); }
const out = args[args.indexOf("-o") + 1];
fs.writeFileSync(out, fs.readFileSync(0));
`;

interface Runner { work: string; cache: string; run: (script: string, env?: Record<string, string>) => SpawnSyncReturns<string>; calls: () => string[][]; reset: () => void }
function runner(context: { after: (fn: () => void) => void }): Runner {
  const tempRoot = realpathSync(tmpdir());
  const work = mkdtempSync(join(tempRoot, "ci-image-cache-"));
  context.after(() => {
    const resolved = realpathSync(work);
    assert.ok(resolved.startsWith(join(tempRoot, "ci-image-cache-")));
    assert.notEqual(resolved, process.env.HOME);
    const removed = spawnSync("rm", ["-r", resolved], { encoding: "utf8" });
    assert.equal(removed.status, 0, removed.stderr);
  });
  const bin = join(work, "bin");
  const state = join(work, "docker");
  const cache = join(work, "cache", "pinned-images");
  mkdirSync(bin);
  mkdirSync(join(work, "cache"));
  writeFileSync(join(bin, "docker"), fakeDocker, { mode: 0o755 });
  writeFileSync(join(bin, "zstd"), fakeZstd, { mode: 0o755 });
  writeFileSync(join(bin, "supabase"), `#!/bin/sh\necho 2.118.0\nexit 0\n${cliDockerfile}\n`, { mode: 0o755 });
  const reset = () => {
    spawnSync("rm", ["-rf", state]);
    mkdirSync(join(state, "images"), { recursive: true });
    writeFileSync(join(state, "calls.log"), "");
  };
  reset();
  return {
    work,
    cache,
    reset,
    calls: () => readFileSync(join(state, "calls.log"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as string[]),
    run: (script, env = {}) => {
      const { SUPABASE_INTERNAL_IMAGE_REGISTRY: _registry, ...inherited } = process.env;
      return spawnSync("bash", ["-c", script], {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 50_000,
        env: {
          ...inherited,
          PATH: `${bin}:${process.env.PATH}`,
          RUNNER_TEMP: join(work, "cache"),
          PINNED_IMAGE_CACHE: cache,
          PINNED_IMAGE_PULL_WAITS: "0,0,0",
          DOCKER_STATE: state,
          GITHUB_OUTPUT: join(work, "output"),
          ...env,
        },
      });
    },
  };
}
function pulls(calls: string[][]) {
  return calls.filter(args => args[0] === "pull").map(args => args[2]);
}
function coldCache(context: { after: (fn: () => void) => void }) {
  const cache = runner(context);
  const cold = cache.run(prepareScript, { PINNED_IMAGE_CACHE_HIT: "", DOCKER_PULL: "success" });
  assert.equal(cold.status, 0, `${cold.stdout}${cold.stderr}`);
  return cache;
}

test("a cold image cache pulls every image once, saves the archive and asks to save it", { timeout: 120_000 }, context => {
  const cache = coldCache(context);
  assert.deepEqual(pulls(cache.calls()).sort(), [edgePrimary, ...stackImages].sort());
  assert.equal(cache.calls().filter(args => args[0] === "save").length, 1);
  assert.ok(existsSync(join(cache.cache, "images.tar.zst")));
  const lock = JSON.parse(readFileSync(join(cache.cache, "images.json"), "utf8"));
  assert.deepEqual(lock.images.map((entry: { image: string }) => entry.image), allImages);
  assert.equal(readFileSync(join(cache.work, "output"), "utf8"), "save=true\n");
});

test("a warm image cache loads, verifies and pulls nothing", { timeout: 120_000 }, context => {
  const cache = coldCache(context);
  cache.reset();
  const warm = cache.run(prepareScript, { PINNED_IMAGE_CACHE_HIT: "true" });
  assert.equal(warm.status, 0, `${warm.stdout}${warm.stderr}`);
  assert.match(warm.stdout, /Restored and verified 13 pinned images from the cache; no registry pulls\./);
  assert.deepEqual(pulls(cache.calls()), []);
  assert.equal(cache.calls().filter(args => args[0] === "load").length, 1);
  assert.ok(!existsSync(join(cache.cache, "images.tar.zst")), "the loaded archive is removed to free disk");
  assert.equal(readFileSync(join(cache.work, "output"), "utf8"), "save=true\n", "a hit must not ask to save again");
});

for (const load of ["error", "wrong-image"]) {
  test(`a warm image cache that fails verification (${load}) warns and pulls`, { timeout: 120_000 }, context => {
    const cache = coldCache(context);
    cache.reset();
    const result = cache.run(prepareScript, { PINNED_IMAGE_CACHE_HIT: "true", DOCKER_LOAD: load, DOCKER_PULL: "success" });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /::warning title=Image cache::Cached images could not be verified/);
    assert.equal(pulls(cache.calls()).length, allImages.length);
  });
}

test("an ECR data limit falls through to GHCR in the same round", { timeout: 120_000 }, context => {
  const cache = runner(context);
  const result = cache.run(prepareScript, { PINNED_IMAGE_CACHE_HIT: "", DOCKER_PULL: "data-limit" });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const pulled = pulls(cache.calls());
  assert.equal(pulled.length, allImages.length * 2);
  assert.ok(pulled.includes(edgeMirror));
  assert.match(result.stdout, /error from registry: Data limit exceeded/);
});

test("a transient pull error is retried in the next round", { timeout: 120_000 }, context => {
  const cache = runner(context);
  const result = cache.run(prepareScript, { PINNED_IMAGE_CACHE_HIT: "", DOCKER_PULL: "flaky" });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /\(round 2\)/);
});

for (const [mode, message] of [["bad-mirror", /registry digest/], ["denied", /could not pull .* after 4 rounds/]] as const) {
  test(`the image cache fails without saving when pulls cannot succeed: ${mode}`, { timeout: 120_000 }, context => {
    const cache = runner(context);
    const result = cache.run(prepareScript, { PINNED_IMAGE_CACHE_HIT: "", DOCKER_PULL: mode });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, message);
    assert.equal(cache.calls().filter(args => args[0] === "save").length, 0);
    assert.ok(!existsSync(join(cache.work, "output")));
  });
}

const checkScript = "node scripts/ci/server-suite.mjs check-stack-images \"$RUNNER_TEMP/pinned-images\"\n";
test("the workflow checks the started stack against the image cache", () => {
  assert.ok(stepScript("Start the local stack").includes(checkScript));
});
for (const [name, env, ok] of [
  ["every container on a cached image", {}, true],
  ["a container on an uncached image", { DOCKER_PS: "supabase_imgproxy_cloud-swarm public.ecr.aws/supabase/imgproxy:v3.8.0\n" }, false],
  ["an image pulled during start", { DOCKER_EXTRA_IMAGE: "public.ecr.aws/supabase/imgproxy:v3.8.0" }, false],
  ["no stack containers", { DOCKER_PS: "" }, false],
] as const) {
  test(`the stack image check: ${name}`, { timeout: 120_000 }, context => {
    const cache = coldCache(context);
    const containers = stackImages.map((stackImage, index) => `supabase_${index}_cloud-swarm ${stackImage}`).join("\n") + "\n";
    const result = cache.run(checkScript, { DOCKER_PS: containers, ...env });
    assert.equal(result.status === 0, ok, `${result.stdout}${result.stderr}`);
    if (ok) assert.match(result.stdout, /Local stack started 12 containers from cached images; supabase start pulled 0 images\./);
  });
}

// The pinned test images (#487) go through the same prepare path into their own cache, and a check runs
// after their consumers: the C1 docker stdin check (server shard 1) and the p1-cli suite.
function testImageMetadata() {
  const result = spawnSync(process.execPath, ["scripts/ci/server-suite.mjs", "image-metadata", "test"], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const digests = Object.fromEntries([...result.stderr.matchAll(/^ {2}\S+: (\S+) (sha256:[0-9a-f]{64})$/gm)].map(match => [match[1], match[2]]));
  return { stdout: result.stdout, digests };
}
const prepareTestScript = stepScript("Prepare the pinned test images");
const checkTestScript = "node scripts/ci/server-suite.mjs check-test-images \"$RUNNER_TEMP/pinned-test-images\"";
function testCache(cache: Runner, env: Record<string, string>) {
  return cache.run(prepareTestScript, { PINNED_IMAGE_CACHE: join(cache.work, "cache", "pinned-test-images"), ...env });
}
function coldTestCache(context: { after: (fn: () => void) => void }) {
  const cache = runner(context);
  const cold = testCache(cache, { PINNED_IMAGE_CACHE_HIT: "", DOCKER_PULL: "success" });
  assert.equal(cold.status, 0, `${cold.stdout}${cold.stderr}`);
  return { cache, cold };
}

test("the pinned test images are the tags their consumers run, each with a digest", () => {
  const { stdout, digests } = testImageMetadata();
  assert.match(stdout, /^key=[0-9a-f]{64}$/m);
  assert.match(stdout, /^c1_psql_image=postgres:17\.12$/m);
  assert.deepEqual(Object.keys(digests), [
    "postgres:17.12",
    "postgres:17.11",
    "public.ecr.aws/supabase/postgres:17.6.1.147",
    "public.ecr.aws/supabase/edge-runtime:v1.73.13",
  ]);
});

test("a cold test image cache pulls each image only by digest, tags it and asks to save it", { timeout: 120_000 }, context => {
  const { digests } = testImageMetadata();
  const { cache, cold } = coldTestCache(context);
  assert.match(cold.stdout, /Pulled 4 pinned test images; cache archive/);
  assert.deepEqual(pulls(cache.calls()).sort(), [
    `postgres@${digests["postgres:17.12"]}`,
    `postgres@${digests["postgres:17.11"]}`,
    `public.ecr.aws/supabase/postgres@${digests["public.ecr.aws/supabase/postgres:17.6.1.147"]}`,
    `public.ecr.aws/supabase/edge-runtime@${digests["public.ecr.aws/supabase/edge-runtime:v1.73.13"]}`,
  ].sort());
  assert.deepEqual(cache.calls().filter(args => args[0] === "tag").map(args => args[2]).sort(), Object.keys(digests).sort());
  assert.equal(readFileSync(join(cache.work, "output"), "utf8"), "save=true\n");
});

test("a warm test image cache loads, verifies and pulls nothing", { timeout: 120_000 }, context => {
  const { cache } = coldTestCache(context);
  cache.reset();
  const warm = testCache(cache, { PINNED_IMAGE_CACHE_HIT: "true" });
  assert.equal(warm.status, 0, `${warm.stdout}${warm.stderr}`);
  assert.match(warm.stdout, /Restored and verified 4 pinned test images from the cache; no registry pulls\./);
  assert.deepEqual(pulls(cache.calls()), []);
});

test("an ECR data limit sends the box image to GHCR, still by digest", { timeout: 120_000 }, context => {
  const { digests } = testImageMetadata();
  const cache = runner(context);
  const result = testCache(cache, { PINNED_IMAGE_CACHE_HIT: "", DOCKER_PULL: "data-limit" });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.ok(pulls(cache.calls()).includes(`ghcr.io/supabase/postgres@${digests["public.ecr.aws/supabase/postgres:17.6.1.147"]}`));
  assert.ok(pulls(cache.calls()).includes(`ghcr.io/supabase/edge-runtime@${digests["public.ecr.aws/supabase/edge-runtime:v1.73.13"]}`));
});

for (const [name, script, env, ok, message] of [
  ["nothing pulled", "", {}, true, /Checked 4 pinned test images: unchanged, none pulled from a registry\./],
  ["a pinned tag pulled again", "docker pull --quiet postgres:17.11\n", {}, false, /changed or went missing.*postgres:17\.11/s],
  ["a pinned repository pulled under another name", "", { DOCKER_EXTRA_IMAGE: "postgres:<none>" }, false, /pulled into the pinned test image repositories/],
  ["a mirror of a pinned repository pulled", "", { DOCKER_EXTRA_IMAGE: "mirror.gcr.io/library/postgres:17.11" }, false, /pulled into the pinned test image repositories/],
  ["an unrelated image pulled", "", { DOCKER_EXTRA_IMAGE: "node:<none>" }, true, /::warning title=Image cache::New images outside the image caches.*node:<none>/],
] as const) {
  test(`the test image check: ${name}`, { timeout: 120_000 }, context => {
    const { cache } = coldTestCache(context);
    const result = cache.run(`set -e\n${script}${checkTestScript}\n`, env);
    assert.equal(result.status === 0, ok, `${result.stdout}${result.stderr}`);
    assert.match(`${result.stdout}${result.stderr}`, message);
  });
}

test("the workflow prepares the test images after the stack check and checks them after their consumers", () => {
  const at = (text: string) => {
    const index = workflow.indexOf(text);
    assert.ok(index > 0, `the workflow must have ${text.trim()}`);
    return index;
  };
  const order = [
    "      - name: Start the local stack\n",
    "      - name: Save the pinned images\n",
    "      - name: Read the pinned test images\n",
    "      - name: Restore the pinned test images\n",
    "      - name: Prepare the pinned test images\n",
    "      - name: Save the pinned test images\n",
    "      - name: C1 docker stdin check",
    "      - name: p1-cli suite\n",
    "      - name: Check that nothing pulled the pinned test images\n",
  ].map(at);
  assert.deepEqual(order, [...order].sort((left, right) => left - right));
  const keys = [...workflow.matchAll(/^ {10}key: (.*pinned-test-images-v1-.*)$/gm)].map(match => match[1]);
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
  assert.ok(workflow.includes(`run: ${checkTestScript}\n`));
  const c1 = workflow.split("      - name: C1 docker stdin check")[1]?.split("      - name:")[0] ?? "";
  assert.match(c1, /^ {10}C1_DOCKER_PSQL_IMAGE: \$\{\{ steps\.test-images\.outputs\.c1_psql_image \|\| 'postgres:17' \}\}$/m);
  assert.doesNotMatch(c1, /C1_DOCKER_PSQL_IMAGE=postgres/);
});
