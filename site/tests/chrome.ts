import { execFile } from "node:child_process";
import { access, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const systemChromeCandidates = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

const playwrightChromeCandidates = async (): Promise<string[]> => {
  const cache = join(homedir(), "Library", "Caches", "ms-playwright");
  try {
    const installs = (await readdir(cache, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("chromium_headless_shell-"))
      .map((entry) => entry.name)
      .sort()
      .reverse();
    return installs.flatMap((install) => [
      join(cache, install, "chrome-headless-shell-mac-arm64", "chrome-headless-shell"),
      join(cache, install, "chrome-mac", "headless_shell"),
    ]);
  } catch {
    return [];
  }
};

export const findChrome = async (): Promise<string> => {
  const candidates = [
    ...(process.env.CHROME_BIN ? [process.env.CHROME_BIN] : []),
    ...await playwrightChromeCandidates(),
    ...systemChromeCandidates,
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // A real browser DOM is required because source-shaped doubles hide rendering defects.
    }
  }
  throw new Error("Chrome or Chromium is required for rendered site observers");
};

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
  const githubActions = process.env.GITHUB_ACTIONS === "true";
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    ...flagsAndUrl.filter(
      (flag) => !githubActions || (flag !== "--single-process" && flag !== "--no-zygote"),
    ),
  ];
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
