import { execFile } from "node:child_process";
import { opendir, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

export type StdoutConsumerState = "live_reader" | "orphaned" | "not_pipe" | "cannot_determine";

export interface StdoutConsumerAdapter {
  inspect(pid: number, signal?: AbortSignal): Promise<StdoutConsumerState>;
}

export interface ProcStdoutConsumerOptions {
  procRoot?: string;
  timeoutMs?: number;
  maxEntries?: number;
  now?: () => number;
}

export interface SystemStdoutConsumerOptions {
  platform?: NodeJS.Platform;
  procRoot?: string;
}

const DEFAULT_PROC_TIMEOUT_MS = 5_000;
const DEFAULT_PROC_MAX_ENTRIES = 20_000;

function pipeTarget(value: string): string | null {
  const match = /^pipe:\[(\d+)\]$/.exec(value);
  return match?.[1] ?? null;
}

function fdFlags(value: string): number | null {
  const match = /^flags:\s+([0-7]+)\s*$/m.exec(value);
  if (!match) return null;
  const flags = Number.parseInt(match[1]!, 8);
  return Number.isSafeInteger(flags) ? flags : null;
}

function isGone(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ESRCH";
}

function isPermissionDenied(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EACCES" || code === "EPERM";
}

/**
 * Inspect Linux's descriptor tables directly. A reader is proven only when a
 * matching pipe descriptor has a readable access mode. Any incomplete view of
 * procfs remains unknown, so permissions and scan limits cannot create a false
 * orphan result.
 */
export function procStdoutConsumer(
  options: ProcStdoutConsumerOptions = {},
): StdoutConsumerAdapter {
  const procRoot = options.procRoot ?? "/proc";
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROC_TIMEOUT_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_PROC_MAX_ENTRIES;
  const now = options.now ?? (() => performance.now());
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("proc stdout inspection timeout must be positive");
  }
  if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
    throw new RangeError("proc stdout inspection entry budget must be a positive integer");
  }

  return {
    async inspect(pid, signal) {
      if (!Number.isSafeInteger(pid) || pid <= 0 || signal?.aborted) return "cannot_determine";
      const startedAt = now();
      let entries = 0;
      let incomplete = false;
      const withinBudget = (): boolean => {
        if (signal?.aborted || now() - startedAt >= timeoutMs || entries >= maxEntries) {
          incomplete = true;
          return false;
        }
        entries += 1;
        return true;
      };
      const timedOut = (): boolean => {
        if (signal?.aborted || now() - startedAt >= timeoutMs) {
          incomplete = true;
          return true;
        }
        return false;
      };

      const stdoutPath = join(procRoot, String(pid), "fd", "1");
      let stdoutLink: string;
      try {
        stdoutLink = await readlink(stdoutPath);
      } catch {
        return "cannot_determine";
      }
      if (timedOut()) return "cannot_determine";
      const inode = pipeTarget(stdoutLink);
      if (inode === null) return "not_pipe";
      const expectedTarget = `pipe:[${inode}]`;

      let processes;
      try {
        processes = await opendir(procRoot);
      } catch {
        return "cannot_determine";
      }
      try {
        for await (const processEntry of processes) {
          if (!withinBudget()) break;
          if (!/^\d+$/.test(processEntry.name) || processEntry.name === String(pid)) continue;
          const fdDirectory = join(procRoot, processEntry.name, "fd");
          let descriptors;
          try {
            descriptors = await opendir(fdDirectory);
          } catch (error) {
            // Linux commonly denies fd-table access for unrelated users. Such
            // processes cannot be searched, but treating every one as an
            // incomplete scan would make an unprivileged scan permanently
            // unknown. Permission trouble becomes material only after a link
            // has proved that a descriptor names the pipe under inspection.
            if (!isGone(error) && !isPermissionDenied(error)) incomplete = true;
            continue;
          }
          try {
            for await (const descriptor of descriptors) {
              if (!withinBudget()) break;
              const fdPath = join(fdDirectory, descriptor.name);
              let link: string;
              try {
                link = await readlink(fdPath);
              } catch (error) {
                if (!isGone(error) && !isPermissionDenied(error)) incomplete = true;
                continue;
              }
              if (timedOut()) break;
              if (link !== expectedTarget) continue;

              let info: string;
              try {
                info = await readFile(join(procRoot, processEntry.name, "fdinfo", descriptor.name), {
                  encoding: "utf8",
                  signal,
                });
              } catch {
                incomplete = true;
                continue;
              }
              if (timedOut()) break;
              const flags = fdFlags(info);
              if (flags === null) {
                incomplete = true;
                continue;
              }
              // O_RDONLY (0) and O_RDWR (2) can consume the pipe. O_WRONLY (1)
              // and Linux's metadata-only O_PATH cannot.
              if ((flags & 0o10000000) === 0 && (flags & 0o3) !== 0o1) return "live_reader";
            }
          } catch (error) {
            if (!isGone(error) && !isPermissionDenied(error)) incomplete = true;
          }
        }
      } catch {
        incomplete = true;
      }

      if (incomplete) return "cannot_determine";
      // The writer may have exited or replaced fd 1 while the process table was scanned.
      try {
        if (await readlink(stdoutPath) !== expectedTarget) return "cannot_determine";
      } catch {
        return "cannot_determine";
      }
      return timedOut() ? "cannot_determine" : "orphaned";
    },
  };
}

/** Interpret the recorded fd 1 entry; only a unix peer marked none proves closure. */
export function parseLsofStdout(output: string): StdoutConsumerState {
  const lines = output.split("\n");
  const type = lines.find((line) => line.startsWith("t"))?.slice(1) ?? "";
  const names = lines.filter((line) => line.startsWith("n")).map((line) => line.slice(1));
  if (type === "unix") {
    if (names.some((name) => name.startsWith("->") && name !== "->(none)")) return "live_reader";
    if (names.some((name) => name === "->(none)")) return "orphaned";
    return "cannot_determine";
  }
  if (type === "PIPE" || type === "FIFO") return "cannot_determine";
  return type.length === 0 ? "cannot_determine" : "not_pipe";
}

/** One bounded child per inspection. Abort kills it when the watcher stops. */
export function lsofStdoutConsumer(
  timeoutMs = 5_000,
  executable = process.platform === "darwin" ? "/usr/sbin/lsof" : "lsof",
): StdoutConsumerAdapter {
  return {
    async inspect(pid, signal) {
      let output: string;
      try {
        output = await new Promise<string>((resolve, reject) => {
          execFile(executable,
            ["-nP", "-a", "-p", String(pid), "-d", "1", "-F", "pftan"],
            { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: timeoutMs, signal },
            (error, stdout) => error ? reject(error) : resolve(stdout));
        });
      } catch {
        return "cannot_determine";
      }
      return parseLsofStdout(output);
    },
  };
}

/** Use procfs on Linux, where lsof cannot identify a pipe's read end. */
export function systemStdoutConsumer(
  timeoutMs = 5_000,
  options: SystemStdoutConsumerOptions = {},
): StdoutConsumerAdapter {
  return (options.platform ?? process.platform) === "linux"
    ? procStdoutConsumer({ timeoutMs, ...(options.procRoot ? { procRoot: options.procRoot } : {}) })
    : lsofStdoutConsumer(timeoutMs);
}
