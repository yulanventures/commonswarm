import { execFile } from "node:child_process";

export type StdoutConsumerState = "live_reader" | "orphaned" | "not_pipe" | "cannot_determine";

export interface StdoutConsumerAdapter {
  inspect(pid: number, signal?: AbortSignal): Promise<StdoutConsumerState>;
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
