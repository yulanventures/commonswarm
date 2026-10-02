import { execFile } from "node:child_process";
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";

const systemChromeCandidates = [
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

export function playwrightCachePaths(
  env: NodeJS.ProcessEnv,
  realHome: string,
  home: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const userCache = (directory: string): string => platform === "darwin"
    ? join(directory, "Library", "Caches", "ms-playwright")
    : join(directory, ".cache", "ms-playwright");
  return [...new Set([
    ...(env.PLAYWRIGHT_BROWSERS_PATH ? [env.PLAYWRIGHT_BROWSERS_PATH] : []),
    userCache(realHome),
    userCache(home),
  ])];
}

const playwrightChromeCandidates = async (cache: string): Promise<string[]> => {
  try {
    const installs = (await readdir(cache, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("chromium_headless_shell-"))
      .map((entry) => entry.name)
      .sort()
      .reverse();
    return installs.flatMap((install) => [
      join(cache, install, "chrome-headless-shell-mac-arm64", "chrome-headless-shell"),
      join(cache, install, "chrome-headless-shell-mac-x64", "chrome-headless-shell"),
      join(cache, install, "chrome-mac", "headless_shell"),
      join(cache, install, "chrome-headless-shell-linux64", "chrome-headless-shell"),
    ]);
  } catch {
    return [];
  }
};

/** Check both the supplied path and its realpath, so symlinks cannot bypass Browser work. */
export function allowedChromePath(candidate: string, resolved: string = candidate): string {
  for (const path of [candidate, resolved]) {
    if (/^\/Applications(?:\/|$)/iu.test(resolve(path))) {
      throw new Error("AGENTS.md Browser work: tests must never start the installed Chrome app or any browser under /Applications (including CHROME_BIN)");
    }
  }
  return resolved;
}

export async function findChromeFromCandidates(
  candidates: readonly string[],
  resolvePath: (path: string) => Promise<string> = realpath,
): Promise<string> {
  for (const candidate of candidates) {
    allowedChromePath(candidate);
    let resolved: string;
    try {
      resolved = await resolvePath(candidate);
    } catch {
      // A real browser DOM is required because source-shaped doubles hide rendering defects.
      continue;
    }
    return allowedChromePath(candidate, resolved);
  }
  throw new Error("install Playwright's bundled Chromium: npx playwright install chromium-headless-shell; the installed Chrome app is never used");
}

export const findChrome = async (): Promise<string> => {
  const override = process.env.CHROME_BIN;
  // Reject a forbidden override even when the path does not exist.
  if (override) allowedChromePath(override);
  return findChromeFromCandidates([
    ...(override ? [override] : []),
    ...await defaultChromeCandidates(),
  ]);
};

async function defaultChromeCandidates(): Promise<string[]> {
  const caches = playwrightCachePaths(process.env, userInfo().homedir, homedir());
  return [
    ...(await Promise.all(caches.map(playwrightChromeCandidates))).flat(),
    ...systemChromeCandidates,
  ];
}

const hasFlag = (flags: readonly string[], name: string): boolean =>
  flags.some((flag) => flag === name || flag.startsWith(`${name}=`));

export function buildChromeArgs(
  flagsAndUrl: readonly string[],
  profile: string | undefined,
  githubActions: boolean,
): string[] {
  const args = flagsAndUrl.filter(
    (flag) => !githubActions || (flag !== "--single-process" && flag !== "--no-zygote"),
  );
  const defaults = [
    "--headless=new", "--disable-gpu", "--no-sandbox",
    "--password-store=basic", "--use-mock-keychain",
  ];
  if (!hasFlag(args, "--user-data-dir")) {
    if (!profile) throw new Error("A fresh temporary Chrome profile is required");
    defaults.push(`--user-data-dir=${profile}`);
  }
  return [
    ...defaults.filter((flag) => !hasFlag(args, flag.split("=")[0]!)),
    ...args,
  ];
}

export interface ChromeLaunchOptions {
  readonly killSignal?: NodeJS.Signals | number;
  readonly maxBuffer?: number;
  readonly timeout?: number;
}

export interface ChromeLaunchResult {
  readonly stderr: string;
  readonly stdout: string;
}

interface AttemptFailure {
  readonly code: number | string | null;
  readonly killed: boolean;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stdout: string;
}

const describeFailure = (attempt: number, failure: AttemptFailure): string =>
  `attempt ${attempt}: code=${String(failure.code)} signal=${String(failure.signal)}`;

const runAttempt = (
  chrome: string,
  args: readonly string[],
  options: ChromeLaunchOptions,
): Promise<ChromeLaunchResult> => new Promise((resolve, reject) => {
  execFile(chrome, [...args], { ...options, encoding: "utf8" }, (error, stdout, stderr) => {
    if (error) {
      reject({
        code: error.code ?? null,
        killed: error.killed === true,
        signal: error.signal ?? null,
        stderr,
        stdout,
      } satisfies AttemptFailure);
      return;
    }
    resolve({ stderr, stdout });
  });
});

/**
 * Run one headless Chrome load. Callers provide only the flags specific to their measurement.
 * GitHub Actions uses Chrome's normal process model; constrained local runs keep the historical
 * single-process flags. An unexpected signal death gets one fresh process before the launcher
 * reports both attempts; a timeout or caller-requested kill is returned immediately.
 */
export async function launchChrome(
  chrome: string,
  flagsAndUrl: readonly string[],
  options: ChromeLaunchOptions = {},
): Promise<ChromeLaunchResult> {
  const profile = hasFlag(flagsAndUrl, "--user-data-dir")
    ? undefined
    : await mkdtemp(join(tmpdir(), "site-chrome-"));
  try {
    return await launchAttempts(chrome, buildChromeArgs(
      flagsAndUrl, profile, process.env.GITHUB_ACTIONS === "true",
    ), options);
  } finally {
    // Only remove the exact mkdtemp path owned by this launch, never a caller's profile.
    if (profile) await rm(profile, { recursive: true, force: true });
  }
}

async function launchAttempts(
  chrome: string,
  args: readonly string[],
  options: ChromeLaunchOptions,
): Promise<ChromeLaunchResult> {
  const failures: AttemptFailure[] = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await runAttempt(chrome, args, options);
    } catch (error) {
      const failure = error as AttemptFailure;
      failures.push(failure);
      const callerRequestedSignal = options.killSignal ?? "SIGTERM";
      const callerStoppedProcess = failure.killed || failure.signal === callerRequestedSignal;
      if (failure.signal === null || callerStoppedProcess || attempt === 2) break;
    }
  }
  const last = failures.at(-1)!;
  const details = failures.map((failure, index) => describeFailure(index + 1, failure)).join("; ");
  const output = `${last.stderr}\n${last.stdout}`.trim();
  throw new Error(`Chrome failed (${details})${output ? `\n${output}` : ""}`);
}
