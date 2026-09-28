import { readdir, readFile, readlink, stat } from "node:fs/promises";
import {
  lsofStdoutConsumer,
  STDOUT_INSPECTION_MS,
  type StdoutConsumerAdapter,
  type StdoutConsumerState,
} from "./stdout-consumer.js";

/** Directory entries (processes plus descriptors) one inspection may list. */
export const PROC_SCAN_MAX_ENTRIES = 100_000;

export interface ProcStdoutConsumerOptions {
  /** A directory laid out like /proc. Tests point this at a fixture tree. */
  root?: string;
  /** Wall-clock limit for one inspection. The caller's abort signal also stops it. */
  maxMs?: number;
  maxEntries?: number;
  now?: () => number;
}

type FdRole = "reader" | "other" | "unknown";

/** A process or descriptor that disappeared mid-scan holds nothing. Any other failure is unknown. */
function vanished(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ESRCH";
}

/** O_ACCMODE of the `flags:` line in fdinfo, which the kernel prints in octal. */
function accessMode(fdinfo: string): number | undefined {
  const flags = /^flags:\s*([0-7]+)\s*$/m.exec(fdinfo)?.[1];
  return flags === undefined ? undefined : parseInt(flags, 8) & 3;
}

/**
 * Only the read end of the pipe keeps a writer from getting EPIPE, so any descriptor
 * on this pipe that is not write-only counts. O_RDONLY is 0 and O_RDWR is 2.
 */
async function roleOfFd(root: string, owner: string, fd: string, pipeLink: string): Promise<FdRole> {
  let link: string;
  try {
    link = await readlink(`${root}/${owner}/fd/${fd}`);
  } catch (error) {
    return vanished(error) ? "other" : "unknown";
  }
  if (link !== pipeLink) return "other";
  let mode: number | undefined;
  try {
    mode = accessMode(await readFile(`${root}/${owner}/fdinfo/${fd}`, "utf8"));
  } catch (error) {
    return vanished(error) ? "other" : "unknown";
  }
  if (mode === 0 || mode === 2) return "reader";
  return mode === 1 ? "other" : "unknown";
}

/** Either a verdict that needs no scan, or the `pipe:[inode]` link to look for in other processes. */
type StdoutTarget = { state: StdoutConsumerState } | { pipeLink: string };

async function stdoutTarget(root: string, pid: number): Promise<StdoutTarget> {
  const fd = `${root}/${pid}/fd/1`;
  let link: string;
  try {
    link = await readlink(fd);
  } catch {
    return { state: "cannot_determine" };
  }
  if (/^pipe:\[\d+\]$/.test(link)) return { pipeLink: link };
  // A unix socket has no readable peer here, so it proves nothing either way.
  if (!link.startsWith("/")) return { state: "cannot_determine" };
  // A path is a file or a device, except a named FIFO, whose reader this scan cannot match.
  try {
    return { state: (await stat(fd)).isFIFO() ? "cannot_determine" : "not_pipe" };
  } catch {
    return { state: "cannot_determine" };
  }
}

/**
 * The kernel's own view of who reads the inspected process's stdout pipe: another process holds
 * the same pipe inode open for reading. `orphaned` needs a complete scan with no reader found;
 * an unreadable entry, an exhausted limit, or an abort is `cannot_determine`, never `orphaned`.
 *
 * Limits of a /proc view: a reader in another pid namespace, or hidden by `hidepid`, is not
 * listed, and a descriptor in flight over SCM_RIGHTS is in no process table. A non-root user
 * cannot list the fd directory of a root-owned process, so `orphaned` is only reachable when
 * every process is readable, for example when the scan runs as root.
 */
export function procStdoutConsumer(
  { root = "/proc", maxMs = STDOUT_INSPECTION_MS, maxEntries = PROC_SCAN_MAX_ENTRIES, now = Date.now }:
    ProcStdoutConsumerOptions = {},
): StdoutConsumerAdapter {
  return {
    async inspect(pid, signal) {
      try {
        const target = await stdoutTarget(root, pid);
        if ("state" in target) return target.state;
        const stopAt = now() + maxMs;
        const owners = (await readdir(root)).filter((name) => /^[1-9]\d*$/.test(name) && name !== String(pid));
        let entries = owners.length;
        if (entries > maxEntries) return "cannot_determine";
        let unknown = false;
        for (const owner of owners) {
          if (signal?.aborted || now() >= stopAt) return "cannot_determine";
          let fds: string[];
          try {
            fds = await readdir(`${root}/${owner}/fd`);
          } catch (error) {
            if (!vanished(error)) unknown = true;
            continue;
          }
          entries += fds.length;
          if (entries > maxEntries) return "cannot_determine";
          const roles = await Promise.all(fds.map((fd) => roleOfFd(root, owner, fd, target.pipeLink)));
          if (roles.includes("reader")) return "live_reader";
          if (roles.includes("unknown")) unknown = true;
        }
        return unknown || signal?.aborted ? "cannot_determine" : "orphaned";
      } catch {
        return "cannot_determine";
      }
    },
  };
}

export interface PlatformStdoutConsumerOptions {
  platform?: NodeJS.Platform;
  proc?: ProcStdoutConsumerOptions;
  lsofExecutable?: string;
}

/** Linux reads /proc, where lsof cannot prove pipe readership; every other host keeps lsof. */
export function platformStdoutConsumer(
  timeoutMs?: number,
  { platform = process.platform, proc, lsofExecutable }: PlatformStdoutConsumerOptions = {},
): StdoutConsumerAdapter {
  return platform === "linux"
    ? procStdoutConsumer({ maxMs: timeoutMs, ...proc })
    : lsofStdoutConsumer(timeoutMs, lsofExecutable);
}
