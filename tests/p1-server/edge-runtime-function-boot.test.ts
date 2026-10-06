/**
 * Boot every supabase/functions worker in the self-hosted edge-runtime image.
 *
 * Staging could run a function under the Supabase CLI while production's
 * edge-runtime image failed to create the worker (bare specifier, no
 * per-function import map). This gate starts deploy/edge-runtime's pinned
 * image with production mounts and requires each listed function to boot.
 *
 * Reached by `npm run test:p1-server` via the p1-server glob in
 * tests/lists/test:p1-server.txt. Skips with "Docker unavailable" when Docker
 * is absent. GitHub Actions workflow server-suite.yml runs that script.
 */
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { KONG_FUNCTION_NOT_FOUND_BODY } from "../../deploy/edge-runtime/main/router.js";
import { createClient } from "@supabase/supabase-js";
import {
  DOCKER_UNAVAILABLE,
  DUMMY_DATABASE_URL,
  DUMMY_HTTP_URL,
  awaitHealth,
  bootFunction,
  classifyWorkerBoot,
  composeEdgeRuntimeImage,
  composePath,
  dockerAvailable,
  dummyEdgeEnv,
  functionsRoot,
  listFunctionDirectories,
  rewriteFunctionsBind,
  rewritePublishedPort,
  startComposeEdgeRuntime,
  type EdgeRuntimeHandle,
} from "../support/edge-runtime-function-boot.js";

function guardedRemove(directory: string): void {
  const cleanup = spawnSync("rm", ["-rf", "--", directory], { encoding: "utf8" });
  assert.equal(cleanup.status, 0, `guarded cleanup refused ${directory}: ${cleanup.stderr}`);
}

test("runtime 5xx boot failure is distinct from a function 401 or 404", () => {
  assert.deepEqual(classifyWorkerBoot(401, '{"error":"unauthenticated"}', ""), { ok: true });
  assert.deepEqual(classifyWorkerBoot(400, '{"error":"invalid_request"}', ""), { ok: true });
  assert.deepEqual(classifyWorkerBoot(404, '{"error":"not_found"}', ""), { ok: true });
  assert.deepEqual(classifyWorkerBoot(500, '{"error":"internal_error"}', ""), { ok: true });
  assert.deepEqual(
    classifyWorkerBoot(404, KONG_FUNCTION_NOT_FOUND_BODY, ""),
    { ok: false, reason: "gateway 404 did not create a user worker" },
  );
  assert.deepEqual(
    classifyWorkerBoot(504, '{"code":"WORKER_LIMIT"}', ""),
    { ok: false, reason: "runtime 5xx boot failure" },
  );
  assert.deepEqual(
    classifyWorkerBoot(500, '{"error":"internal_error"}', "edge-runtime request failed"),
    { ok: false, reason: "container log has worker boot error" },
  );
  assert.deepEqual(
    classifyWorkerBoot(200, "ok", "something worker boot error in isolate"),
    { ok: false, reason: "container log has worker boot error" },
  );
});

function parseDummyEnv(source: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of source.split("\n")) {
    if (!line) continue;
    const eq = line.indexOf("=");
    assert.ok(eq > 0, `dummy env line must be NAME=value: ${line}`);
    values.set(line.slice(0, eq), line.slice(eq + 1));
  }
  return values;
}

test("dummy edge env uses syntactically valid non-routable URLs", () => {
  const values = parseDummyEnv(dummyEdgeEnv());
  assert.equal(values.get("SUPABASE_URL"), DUMMY_HTTP_URL);
  assert.equal(values.get("SWARM_DATABASE_URL"), DUMMY_DATABASE_URL);
  assert.equal(values.get("SUPABASE_DB_URL"), DUMMY_DATABASE_URL);
  const urlTyped = [...values.entries()].filter(([name]) => name.endsWith("_URL"));
  assert.ok(urlTyped.length > 0, "dummy env must include URL-typed variables");
  for (const [, value] of urlTyped) {
    assert.match(value, /^(https?|postgres):\/\//);
    assert.ok(new URL(value));
  }
  const client = createClient(DUMMY_HTTP_URL, "dummy-supabase_anon_key", {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  assert.equal(typeof client.auth, "object");
  assert.throws(
    () => createClient("dummy-supabase_url", "dummy-supabase_anon_key"),
    /Invalid supabaseUrl: Must be a valid HTTP or HTTPS URL/,
  );
});

test("compose.yaml is the edge-runtime image pin and functions are listed from disk", () => {
  const source = readFileSync(composePath, "utf8");
  const image = composeEdgeRuntimeImage(source);
  assert.match(image, /^public\.ecr\.aws\/supabase\/edge-runtime:/);
  assert.equal(composePath.endsWith("deploy/edge-runtime/compose.yaml"), true);
  assert.match(rewritePublishedPort(source), /127\.0\.0\.1:0:9000/);
  assert.match(
    rewriteFunctionsBind(source, "/tmp/c1-27-functions"),
    /\/tmp\/c1-27-functions:\/home\/deno\/functions-source:ro/,
  );
  assert.match(source, /^\s+- \.\/main:\/home\/deno\/main:ro$/m);
  assert.match(source, /^\s+- \.\/bootstrap\.sh:\/home\/deno\/deploy\/bootstrap\.sh:ro$/m);
  assert.match(source, /^\s+- \.\/h0-deno\.json:\/home\/deno\/deploy\/h0-deno\.json:ro$/m);
  const names = listFunctionDirectories();
  assert.ok(names.includes("admin"));
  assert.equal(names.includes("_shared"), false);
});

test("every edge function boots in the self-hosted edge-runtime image", { timeout: 600_000 }, async (t) => {
  if (!dockerAvailable()) {
    t.skip(DOCKER_UNAVAILABLE);
    return;
  }
  const names = listFunctionDirectories();
  assert.ok(names.length > 0, "supabase/functions must list function directories");
  assert.equal(names.includes("_shared"), false);
  const workDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "edge-runtime-boot.")));
  let runtime: EdgeRuntimeHandle | undefined;
  t.after(() => {
    runtime?.close();
    guardedRemove(workDir);
  });
  runtime = startComposeEdgeRuntime({ workDir });
  await awaitHealth(runtime.baseUrl);
  const failures: string[] = [];
  for (const name of names) {
    const result = await bootFunction(runtime, name);
    if (!result.classification.ok) {
      failures.push(
        `${name}: HTTP ${result.status} ${result.classification.reason} body=${result.body.slice(0, 200)}`,
      );
    }
  }
  assert.deepEqual(failures, []);
});

test("a function with a bare unmapped specifier fails the boot check", { timeout: 600_000 }, async (t) => {
  if (!dockerAvailable()) {
    t.skip(DOCKER_UNAVAILABLE);
    return;
  }
  const workDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "edge-runtime-boot-neg.")));
  let runtime: EdgeRuntimeHandle | undefined;
  t.after(() => {
    runtime?.close();
    guardedRemove(workDir);
  });
  const copy = join(workDir, "functions");
  mkdirSync(copy, { recursive: true });
  cpSync(functionsRoot, copy, { recursive: true });
  writeFileSync(
    join(copy, "activity", "index.ts"),
    'import "c1-27-unmapped-specifier";\nDeno.serve(() => new Response("should not boot"));\n',
  );
  runtime = startComposeEdgeRuntime({ workDir, functionsRoot: copy });
  await awaitHealth(runtime.baseUrl);
  const result = await bootFunction(runtime, "activity");
  assert.equal(result.classification.ok, false, `negative control booted: HTTP ${result.status} ${result.body.slice(0, 200)}`);
  assert.match(
    `${result.body}\n${result.logSlice}`,
    /c1-27-unmapped-specifier/,
    `negative control failed without naming c1-27-unmapped-specifier: HTTP ${result.status} body=${result.body.slice(0, 200)}`,
  );
});
