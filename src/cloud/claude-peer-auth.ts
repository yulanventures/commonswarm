/**
 * Host availability check for the system Python 3 peer-credential helper used by
 * Claude inbox-socket wake (`LOCAL_PEERPID` + `getpeereid` on macOS, `SO_PEERCRED` on Linux).
 *
 * Security & host-safety invariants:
 *   - Always resolves an absolute system path (`/usr/bin/python3` on macOS;
 *     `/usr/bin/python3` or `/bin/python3` on Linux) — NEVER looks up `python3` via `PATH`.
 *   - On macOS without Command Line Tools, `/usr/bin/python3` is an xcrun stub that pops a
 *     GUI install dialog when executed. We probe `/usr/bin/xcode-select -p` first and fail
 *     closed (`available: false, reason: "python3 missing"`) without ever launching the stub.
 */
import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";

const MACOS_XCODE_SELECT_PATH = "/usr/bin/xcode-select";
const MACOS_PYTHON3_PATH = "/usr/bin/python3";
const LINUX_PYTHON3_PATHS = ["/usr/bin/python3", "/bin/python3"] as const;
const XCODE_SELECT_TIMEOUT_MS = 2_000;

export type ClaudePeerAuthAvailability =
  | { available: true; pythonPath: string }
  | { available: false; reason: string };

export interface ClaudePeerAuthProbeOptions {
  platform?: NodeJS.Platform;
  xcodeSelectPath?: string;
  pythonPaths?: readonly string[];
  execSync?: (file: string, args: readonly string[]) => { ok: boolean };
  isExecutable?: (path: string) => boolean;
}

function defaultIsExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function defaultExecXcodeSelect(file: string, args: readonly string[]): { ok: boolean } {
  try {
    const result = spawnSync(file, [...args], {
      stdio: "ignore",
      timeout: XCODE_SELECT_TIMEOUT_MS,
      env: {},
    });
    return { ok: !result.error && result.status === 0 };
  } catch {
    return { ok: false };
  }
}

export function checkClaudePeerAuthHelper(
  options?: ClaudePeerAuthProbeOptions,
): ClaudePeerAuthAvailability {
  const platform = options?.platform ?? process.platform;
  const isExecutable = options?.isExecutable ?? defaultIsExecutable;

  if (platform === "darwin") {
    const xcodeSelectPath = options?.xcodeSelectPath ?? MACOS_XCODE_SELECT_PATH;
    const execSync = options?.execSync ?? defaultExecXcodeSelect;
    // Detect missing macOS Command Line Tools BEFORE touching /usr/bin/python3 so the
    // xcrun stub is never launched (avoiding a GUI install prompt).
    if (!execSync(xcodeSelectPath, ["-p"]).ok) {
      return { available: false, reason: "python3 missing" };
    }
    const candidates = options?.pythonPaths ?? [MACOS_PYTHON3_PATH];
    for (const candidate of candidates) {
      if (candidate.startsWith("/") && isExecutable(candidate)) {
        return { available: true, pythonPath: candidate };
      }
    }
    return { available: false, reason: "python3 missing" };
  }

  if (platform === "linux") {
    const candidates = options?.pythonPaths ?? LINUX_PYTHON3_PATHS;
    for (const candidate of candidates) {
      if (candidate.startsWith("/") && isExecutable(candidate)) {
        return { available: true, pythonPath: candidate };
      }
    }
    return { available: false, reason: "python3 missing" };
  }

  return { available: false, reason: "python3 missing" };
}
