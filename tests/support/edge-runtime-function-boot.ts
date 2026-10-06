/**
 * Boot every edge function in the self-hosted edge-runtime Compose layout.
 *
 * Image, mounts, entrypoint, and flags come from deploy/edge-runtime/compose.yaml.
 * Do not retype the image tag. FUNCTIONS_ROOT inside the container is the
 * bootstrap copy of the functions-source mount, not the mount itself.
 */
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FUNCTION_DISABLED_BODY,
  FUNCTION_DISABLED_STATUS,
  KONG_FUNCTION_NOT_FOUND_BODY,
  MCP_PUBLIC_ENABLED_ENV,
  REQUIRED_MAIN_ENV,
} from "../../deploy/edge-runtime/main/router.js";

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, "../..");
export const edgeRuntimeDir = resolve(repoRoot, "deploy/edge-runtime");
export const composePath = resolve(edgeRuntimeDir, "compose.yaml");
export const functionsRoot = resolve(repoRoot, "supabase/functions");
export const SKIP_FUNCTION_DIRS = new Set(["_shared"]);
export const DOCKER_UNAVAILABLE = "Docker unavailable";
export const WORKER_BOOT_ERROR = "worker boot error";

export function docker(args: string[], options: { timeout?: number; env?: NodeJS.ProcessEnv } = {}): SpawnSyncReturns<string> {
  return spawnSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: options.timeout ?? 120_000,
    env: options.env,
  });
}

export function dockerAvailable(): boolean {
  return docker(["version", "--format", "{{.Server.Version}}"]).status === 0;
}

export function composeServiceBlock(source: string, name: string): string {
  const marker = `  ${name}:\n`;
  const start = source.indexOf(marker, source.indexOf("services:\n"));
  if (start < 0) return "";
  const rest = source.slice(start + marker.length);
  const next = rest.search(/^  [a-z][a-z0-9-]*:\n/m);
  return next < 0 ? rest : rest.slice(0, next);
}

/** Image pin as written in compose.yaml. Never retype the tag. */
export function composeEdgeRuntimeImage(source = readFileSync(composePath, "utf8")): string {
  const image = composeServiceBlock(source, "edge-runtime").match(/^\s*image:\s+(\S+)\s*$/m)?.[1];
  assert.ok(image, "deploy/edge-runtime/compose.yaml must pin services.edge-runtime.image");
  return image;
}

export function listFunctionDirectories(root = functionsRoot): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !SKIP_FUNCTION_DIRS.has(entry.name))
    .map((entry) => entry.name)
    .sort();
}

export function dummyEdgeEnv(): string {
  const lines = REQUIRED_MAIN_ENV.map((name) => (
    name === "SWARM_SELF_SERVE" ? `${name}=1` : `${name}=dummy-${name.toLowerCase()}`
  ));
  lines.push("SWARM_DATABASE_URL=postgres://dummy:dummy@127.0.0.1:9/dummy");
  lines.push(`${MCP_PUBLIC_ENABLED_ENV}=1`);
  return `${lines.join("\n")}\n`;
}

export type BootClassification =
  | { ok: true }
  | { ok: false; reason: string };

export function classifyWorkerBoot(status: number, body: string, logSlice: string): BootClassification {
  const runtimeCaught = logSlice.includes("edge-runtime request failed");
  if (logSlice.includes(WORKER_BOOT_ERROR) || runtimeCaught) {
    return { ok: false, reason: "container log has worker boot error" };
  }
  if (status === 404 && body === KONG_FUNCTION_NOT_FOUND_BODY) {
    return { ok: false, reason: "gateway 404 did not create a user worker" };
  }
  if (status === FUNCTION_DISABLED_STATUS) {
    try {
      const parsed = JSON.parse(body) as { error?: unknown };
      if (parsed.error === FUNCTION_DISABLED_BODY.error) {
        return { ok: false, reason: "function is dark; worker did not boot" };
      }
    } catch {
      // Function JSON that happens to be 503 is still a worker answer.
    }
  }
  if (status >= 500) {
    try {
      const parsed = JSON.parse(body) as { error?: unknown; code?: unknown };
      if (parsed.code === "WORKER_LIMIT") {
        return { ok: false, reason: "runtime 5xx boot failure" };
      }
    } catch {
      // Non-JSON 5xx from the function itself still means the worker started.
    }
  }
  return { ok: true };
}

export function rewritePublishedPort(source: string): string {
  const next = source.replace(
    /^(\s+- )"127\.0\.0\.1:\d+:9000"$/m,
    `$1"127.0.0.1:0:9000"`,
  );
  assert.notEqual(next, source, "compose.yaml must publish 127.0.0.1:<host>:9000");
  return next;
}

export function rewriteFunctionsBind(source: string, hostPath: string): string {
  const next = source.replace(
    /^(\s+- )[^:\n]+:(\/[^:\n]*functions-source)(:ro|:rw)?$/m,
    `$1${hostPath}:$2$3`,
  );
  assert.notEqual(next, source, "compose.yaml must bind a functions-source volume");
  return next;
}

export interface EdgeRuntimeHandle {
  project: string;
  image: string;
  baseUrl: string;
  container: string;
  logs(): string;
  close(): void;
}

export function startComposeEdgeRuntime(options: {
  workDir: string;
  functionsRoot?: string;
}): EdgeRuntimeHandle {
  const composeSource = readFileSync(composePath, "utf8");
  const image = composeEdgeRuntimeImage(composeSource);
  let rendered = rewritePublishedPort(composeSource);
  if (options.functionsRoot !== undefined) {
    rendered = rewriteFunctionsBind(rendered, options.functionsRoot);
  }
  mkdirSync(options.workDir, { recursive: true });
  const envFile = join(options.workDir, "edge.env");
  const tempCompose = join(options.workDir, "compose.yaml");
  writeFileSync(envFile, dummyEdgeEnv(), { encoding: "utf8" });
  chmodSync(envFile, 0o600);
  writeFileSync(tempCompose, rendered);
  const pull = docker(["pull", image], { timeout: 180_000 });
  assert.equal(pull.status, 0, pull.stderr || pull.stdout);

  const project = `c1edge${randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const composeArgs = [
    "compose",
    "--project-name",
    project,
    "-f",
    tempCompose,
    "--project-directory",
    edgeRuntimeDir,
  ];
  const env = { ...process.env, COMMONSWARM_EDGE_ENV_FILE: envFile };
  const close = (): void => {
    docker([...composeArgs, "down", "-v", "--remove-orphans"], { timeout: 120_000, env });
  };
  const up = docker([...composeArgs, "up", "-d", "--no-build"], { timeout: 180_000, env });
  if (up.status !== 0) {
    close();
    assert.equal(up.status, 0, up.stderr || up.stdout);
  }
  try {
    const id = docker([...composeArgs, "ps", "-q", "edge-runtime"], { env });
    assert.equal(id.status, 0, id.stderr);
    const container = id.stdout.trim();
    assert.ok(container, "compose up did not start edge-runtime");
    const published = docker([...composeArgs, "port", "edge-runtime", "9000"], { env });
    assert.equal(published.status, 0, published.stderr);
    const port = published.stdout.trim().split(":").at(-1);
    assert.ok(port, published.stdout);
    const runningImage = docker(["inspect", "--format", "{{.Config.Image}}", container]);
    assert.equal(runningImage.stdout.trim(), image, runningImage.stderr);
    return {
      project,
      image,
      baseUrl: `http://127.0.0.1:${port}`,
      container,
      logs: () => {
        const result = docker(["logs", container], { timeout: 30_000 });
        return `${result.stdout}${result.stderr}`;
      },
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}

export async function awaitHealth(baseUrl: string, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(3_000) });
      last = `HTTP ${response.status}`;
      if (response.status === 200) return;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error(`edge-runtime /health never became ready (last: ${last})`);
}

export interface FunctionBootResult {
  functionName: string;
  status: number;
  body: string;
  classification: BootClassification;
}

export async function bootFunction(
  runtime: EdgeRuntimeHandle,
  functionName: string,
): Promise<FunctionBootResult> {
  const before = runtime.logs().length;
  const response = await fetch(`${runtime.baseUrl}/functions/v1/${functionName}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(180_000),
  });
  const body = await response.text();
  const logSlice = runtime.logs().slice(before);
  return {
    functionName,
    status: response.status,
    body,
    classification: classifyWorkerBoot(response.status, body, logSlice),
  };
}
