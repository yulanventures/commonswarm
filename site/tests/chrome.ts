import { execFile } from "node:child_process";
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestFn, type TestOptions } from "node:test";

export const browserSkipMessage = "browser test skipped: set RUN_BROWSER_TESTS=1 (CI only; never on the Mac mini)";

/** Register browser cases without running their setup or callbacks on local gates. */
export function browserTest(name: string, fn: TestFn): Promise<void>;
export function browserTest(name: string, options: TestOptions, fn: TestFn): Promise<void>;
export function browserTest(name: string, optionsOrFn: TestOptions | TestFn, fn?: TestFn): Promise<void> {
  const options = typeof optionsOrFn === "function" ? {} : optionsOrFn;
  return test(name, {
    ...options,
    skip: process.env.RUN_BROWSER_TESTS === "1" ? options.skip : browserSkipMessage,
  }, typeof optionsOrFn === "function" ? optionsOrFn : fn!);
}

export function requireBrowserTests(): void {
  if (process.env.RUN_BROWSER_TESTS !== "1") throw new Error(browserSkipMessage);
}

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
      join(cache, install, "chrome-linux", "headless_shell"),
    ]);
  } catch {
    return [];
  }
};

/** Check both the supplied path and its realpath, so symlinks cannot bypass Browser work. */
export function allowedChromePath(
  candidate: string,
  resolved: string = candidate,
  caches: readonly string[] = playwrightCachePaths(process.env, userInfo().homedir, homedir()),
): string {
  for (const path of [candidate, resolved]) {
    if (/^\/Applications(?:\/|$)/iu.test(resolve(path))) {
      throw new Error("AGENTS.md Browser work: tests must never start the installed Chrome app or any browser under /Applications (including CHROME_BIN)");
    }
  }
  if (!caches.some((cache) => resolve(resolved).startsWith(`${resolve(cache)}/`))) {
    throw new Error("AGENTS.md Browser work: only Playwright's bundled Chromium inside a ms-playwright cache is allowed (including CHROME_BIN); installed and other non-Playwright browsers are forbidden");
  }
  return resolved;
}

async function resolvedPlaywrightCaches(): Promise<string[]> {
  return Promise.all(playwrightCachePaths(process.env, userInfo().homedir, homedir()).map(async (cache) => {
    try { return await realpath(cache); } catch { return resolve(cache); }
  }));
}

/** Validate the executable again at launch, even when the caller bypasses findChrome. */
export async function resolveChromePath(chrome: string): Promise<string> {
  const caches = await resolvedPlaywrightCaches();
  // Reject Applications without inspecting any installed app.
  if (/^\/Applications(?:\/|$)/iu.test(resolve(chrome))) allowedChromePath(chrome, chrome, caches);
  return allowedChromePath(chrome, await realpath(chrome), caches);
}

export async function findChromeFromCandidates(
  candidates: readonly string[],
  resolvePath: (path: string) => Promise<string> = realpath,
  caches: readonly string[] = playwrightCachePaths(process.env, userInfo().homedir, homedir()),
): Promise<string> {
  for (const candidate of candidates) {
    if (/^\/Applications(?:\/|$)/iu.test(resolve(candidate))) allowedChromePath(candidate, candidate, caches);
    let resolved: string;
    try {
      resolved = await resolvePath(candidate);
    } catch {
      // A real browser DOM is required because source-shaped doubles hide rendering defects.
      continue;
    }
    return allowedChromePath(candidate, resolved, caches);
  }
  throw new Error("install Playwright's bundled Chromium: npx playwright install chromium-headless-shell; the installed Chrome app is never used");
}

export const findChrome = async (): Promise<string> => {
  requireBrowserTests();
  const override = process.env.CHROME_BIN;
  // Overrides must resolve inside the cache; an invalid override never silently falls back.
  if (override) return resolveChromePath(override);
  return findChromeFromCandidates(await defaultChromeCandidates(), realpath, await resolvedPlaywrightCaches());
};

async function defaultChromeCandidates(): Promise<string[]> {
  const caches = playwrightCachePaths(process.env, userInfo().homedir, homedir());
  return (await Promise.all(caches.map(playwrightChromeCandidates))).flat();
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
  readonly timedOut: boolean;
}

const describeFailure = (attempt: number, failure: AttemptFailure): string =>
  `attempt ${attempt}: code=${String(failure.code)} signal=${String(failure.signal)}`;

const runAttempt = (
  chrome: string,
  args: readonly string[],
  options: ChromeLaunchOptions,
): Promise<ChromeLaunchResult> => new Promise((resolve, reject) => {
  // Own the process group and deadline: inherited output pipes must not delay timeout rejection.
  const child = execFile(chrome, [...args], {
    maxBuffer: options.maxBuffer, encoding: "utf8", detached: process.platform !== "win32",
  }, (error, stdout, stderr) => {
    clearTimeout(timer);
    if (error) {
      reject({
        code: error.code ?? null,
        killed: error.killed === true,
        signal: error.signal ?? null,
        stderr,
        stdout,
        timedOut: false,
      } satisfies AttemptFailure);
      return;
    }
    resolve({ stderr, stdout });
  });
  const timer = setTimeout(() => {
    if (child.pid && process.platform !== "win32") {
      try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    } else {
      child.kill("SIGKILL");
    }
    reject({
      code: null, killed: true, signal: "SIGKILL", stderr: "", stdout: "", timedOut: true,
    } satisfies AttemptFailure);
    child.stdin?.destroy();
    child.stdout?.destroy();
    child.stderr?.destroy();
  }, options.timeout);
});

/**
 * Run one headless Chrome load. Callers provide only the flags specific to their measurement.
 * GitHub Actions uses Chrome's normal process model; constrained local runs keep the historical
 * single-process flags. An unexpected signal death gets one fresh process before the launcher
 * reports both attempts. A hard SIGKILL deadline covers both attempts, capped at 60 seconds.
 */
export async function launchChrome(
  chrome: string,
  flagsAndUrl: readonly string[],
  options: ChromeLaunchOptions = {},
): Promise<ChromeLaunchResult> {
  requireBrowserTests();
  chrome = await resolveChromePath(chrome);
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
  const timeout = options.timeout !== undefined && Number.isFinite(options.timeout) && options.timeout > 0
    ? Math.min(options.timeout, 60_000) : 60_000;
  const deadline = Date.now() + timeout;
  const failures: AttemptFailure[] = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await runAttempt(chrome, args, { ...options, timeout: Math.max(1, deadline - Date.now()) });
    } catch (error) {
      const failure = error as AttemptFailure;
      failures.push(failure);
      const callerStoppedProcess = failure.killed || failure.signal === (options.killSignal ?? "SIGTERM");
      if (failure.signal === null || callerStoppedProcess || attempt === 2) break;
    }
  }
  const last = failures.at(-1)!;
  const details = failures.map((failure, index) => describeFailure(index + 1, failure)).join("; ");
  const output = `${last.stderr}\n${last.stdout}`.trim();
  const reason = last.timedOut ? `Chrome timed out after ${timeout} ms (SIGKILL)` : "Chrome failed";
  throw new Error(`${reason} (${details}); URL/flags: ${JSON.stringify(args)}${output ? `\n${output}` : ""}`);
}
