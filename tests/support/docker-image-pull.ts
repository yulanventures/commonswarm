import { spawnSync, type SpawnSyncReturns } from "node:child_process";

// Any failed pull is retried, whatever the error, as the CI image caches do (#486, #487). Each round tries
// the image's registry and then each mirror that publishes it; rounds are 5, 15 and 45 s apart, which keeps
// a cold pull inside the callers' test timeouts.
export const IMAGE_PULL_ATTEMPTS = 4;
const IMAGE_PULL_WAITS = [5_000, 15_000, 45_000];
export type DockerResult = Pick<SpawnSyncReturns<string>, "status" | "stdout" | "stderr">
  & Partial<Pick<SpawnSyncReturns<string>, "error" | "signal">>;
export interface ImagePullDependencies {
  run?: (args: string[]) => DockerResult;
  wait?: (milliseconds: number) => Promise<void>;
  log?: (line: string) => void;
}

function runDocker(args: string[]): DockerResult {
  return spawnSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: args[0] === "pull" ? 180_000 : 10_000,
  });
}

// The same tag at each registry that publishes it, requested name first. Supabase images follow the CLI's
// order (ECR, GHCR, Docker Hub); Docker Hub official images fall back to ECR's and Google's mirrors. A
// digest reference cannot be tagged under its own name, so it is retried at its own registry only.
function registryCandidates(image: string): string[] {
  if (image.includes("@")) return [image];
  const tagStart = image.lastIndexOf(":");
  const tag = tagStart > image.lastIndexOf("/") ? image.slice(tagStart) : "";
  const path = image.slice(0, image.length - tag.length).replace(/^(?:docker\.io|index\.docker\.io|registry-1\.docker\.io)\//, "");
  const supabase = /^(?:public\.ecr\.aws\/|ghcr\.io\/)?supabase\/([^/]+)$/.exec(path)?.[1];
  const official = /^(?:library\/)?([^/]+)$/.exec(path)?.[1];
  const mirrors = supabase
    ? [`public.ecr.aws/supabase/${supabase}`, `ghcr.io/supabase/${supabase}`, `supabase/${supabase}`]
    : official
      ? [`public.ecr.aws/docker/library/${official}`, `mirror.gcr.io/library/${official}`]
      : [];
  return [image, ...mirrors.filter(mirror => mirror !== path).map(mirror => `${mirror}${tag}`)];
}

// A registry limit (ECR's "Data limit exceeded" or "Rate exceeded", Docker Hub's toomanyrequests) on every
// line. Only this outcome lets a caller skip; mixed diagnostics are a failure.
function isOnlyRegistryLimit(result: DockerResult): boolean {
  const lines = (result.stderr ?? "").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  return result.status !== 0 && !result.error && !result.signal && lines.length > 0 && lines.every(line =>
    /^(?:docker:\s*)?(?:Error response from daemon:\s*)?(?:toomanyrequests:.*|(?:error from registry:\s*)?(?:Data limit exceeded|Rate exceeded))$/i.test(line));
}

function diagnostic(result: DockerResult): string {
  return [result.stderr, result.stdout, result.error?.message, result.signal]
    .filter(Boolean).join("\n").trim() || `Docker exited with status ${result.status}`;
}

/** Use the local image when present; otherwise pull it, retrying every failure across its registries. */
export async function pullDockerImage(
  image: string,
  dependencies: ImagePullDependencies = {},
): Promise<{ ready: true } | { ready: false; reason: string }> {
  const run = dependencies.run ?? runDocker;
  const wait = dependencies.wait ?? (milliseconds =>
    new Promise(resolveWait => setTimeout(resolveWait, milliseconds)));
  const log = dependencies.log ?? (line => console.error(line));
  // A cached or pre-loaded tag (the CI image caches) needs no registry at all.
  if (run(["image", "inspect", image]).status === 0) return { ready: true };
  const candidates = registryCandidates(image);
  const failures: { reference: string; round: number; result: DockerResult }[] = [];
  for (let round = 1; round <= IMAGE_PULL_ATTEMPTS; round += 1) {
    for (const reference of candidates) {
      const pulled = run(["pull", reference]);
      if (pulled.status === 0) {
        if (reference !== image) {
          const tagged = run(["tag", reference, image]);
          if (tagged.status !== 0) throw new Error(`docker tag ${reference} ${image} failed:\n${diagnostic(tagged)}`);
        }
        if (failures.length) log(`docker pull ${image}: ready from ${reference} in round ${round}`);
        return { ready: true };
      }
      failures.push({ reference, round, result: pulled });
      log(`docker pull ${reference} failed in round ${round}: ${diagnostic(pulled).split("\n").pop()}`);
    }
    if (round < IMAGE_PULL_ATTEMPTS) await wait(IMAGE_PULL_WAITS[round - 1]);
  }
  const report = failures.map(({ reference, round, result }) => `${reference} round ${round}:\n${diagnostic(result)}`).join("\n");
  if (failures.every(({ result }) => isOnlyRegistryLimit(result))) {
    return {
      ready: false,
      reason: `registry rate limits persisted after ${IMAGE_PULL_ATTEMPTS} rounds of image pulls for ${image}:\n${report}`,
    };
  }
  throw new Error(`docker pull ${image} failed after ${IMAGE_PULL_ATTEMPTS} rounds:\n${report}`);
}

/** Inspect the exact Compose-pinned reference, so cached images need no network pull. */
export async function ensureDockerImage(image: string, dependencies: ImagePullDependencies = {}): Promise<void> {
  const result = await pullDockerImage(image, dependencies);
  if (!result.ready) throw new Error(result.reason);
}
