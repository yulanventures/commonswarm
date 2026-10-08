import { spawnSync, type SpawnSyncReturns } from "node:child_process";

// Three attempts, with 1 s and 2 s waits: at most 3 s of backoff.
export const IMAGE_PULL_ATTEMPTS = 3;
export type DockerResult = Pick<SpawnSyncReturns<string>, "status" | "stdout" | "stderr">
  & Partial<Pick<SpawnSyncReturns<string>, "error" | "signal">>;
export interface ImagePullDependencies {
  run?: (args: string[]) => DockerResult;
  wait?: (milliseconds: number) => Promise<void>;
}

function runDocker(args: string[]): DockerResult {
  return spawnSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: args[0] === "pull" ? 180_000 : 10_000,
  });
}

// Shared with the box pg_cron test. Mixed diagnostics must fail immediately.
function isOnlyEcrRateLimit(result: DockerResult): boolean {
  const lines = (result.stderr ?? "").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  return result.status !== 0 && !result.error && !result.signal && lines.length > 0 && lines.every(line =>
    /^(?:docker:\s*)?(?:Error response from daemon:\s*)?toomanyrequests:\s*(?:Data limit exceeded|Rate exceeded)$/i.test(line));
}

function diagnostic(result: DockerResult): string {
  return [result.stderr, result.stdout, result.error?.message, result.signal]
    .filter(Boolean).join("\n") || `Docker exited with status ${result.status}`;
}

export async function pullDockerImage(
  image: string,
  dependencies: ImagePullDependencies = {},
): Promise<{ ready: true } | { ready: false; reason: string }> {
  const run = dependencies.run ?? runDocker;
  const wait = dependencies.wait ?? (milliseconds =>
    new Promise(resolveWait => setTimeout(resolveWait, milliseconds)));
  for (let attempt = 1; attempt <= IMAGE_PULL_ATTEMPTS; attempt += 1) {
    const pulled = run(["pull", image]);
    if (pulled.status === 0) return { ready: true };
    if (!isOnlyEcrRateLimit(pulled)) {
      throw new Error(`docker pull ${image} failed with a non-rate-limit error:\n${diagnostic(pulled)}`);
    }
    if (attempt === IMAGE_PULL_ATTEMPTS) {
      return {
        ready: false,
        reason: `public ECR rate limit persisted after ${IMAGE_PULL_ATTEMPTS} bounded image-pull attempts for ${image}:\n${diagnostic(pulled)}`,
      };
    }
    await wait(attempt * 1_000);
  }
  throw new Error("Image pull attempt budget must be positive");
}

/** Inspect the exact Compose-pinned reference, so cached images need no network pull. */
export async function ensureDockerImage(image: string, dependencies: ImagePullDependencies = {}): Promise<void> {
  const run = dependencies.run ?? runDocker;
  if (run(["image", "inspect", image]).status === 0) return;
  const result = await pullDockerImage(image, { ...dependencies, run });
  if (!result.ready) throw new Error(result.reason);
}
