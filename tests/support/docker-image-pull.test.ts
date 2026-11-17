import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
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
  { status: 1, stdout: "", stderr: "toomanyrequests: Rate exceeded\\npermission denied" },
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
