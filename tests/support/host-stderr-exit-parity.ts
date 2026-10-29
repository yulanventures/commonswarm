import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { AcpChildExitError } from "../../src/host/index.js";

type AcpHandle = { close: () => Promise<void> };

export type StderrExitParityProvider = {
  provider: string;
  executableName: string;
  versionOutput?: string;
  open: (options: {
    cwd: string;
    executable: string;
    onStderrTail: (tail: string) => void;
  }) => Promise<AcpHandle>;
};

type FailureScenario = "flushed" | "held" | "late";

async function writeFailingExecutable(options: {
  root: string;
  executableName: string;
  scenario: FailureScenario;
  line: string;
  versionOutput?: string;
}): Promise<{ executable: string; grandchildPidFile: string }> {
  const executable = join(options.root, options.executableName);
  const grandchildPidFile = join(
    options.root,
    `${basename(options.executableName)}.grandchild.pid`,
  );
  const delayMs = options.scenario === "late" ? 350 : 25;
  const grandchildBody = options.scenario === "held"
    ? `process.send?.("ready"); setTimeout(() => {}, 2500)`
    : `process.send?.("ready"); setTimeout(() => process.stderr.write(${JSON.stringify(`${options.line}\n`)}), ${delayMs})`;
  const grandchildLaunch =
    `spawn(process.execPath, ["-e", ${JSON.stringify(grandchildBody)}], { stdio: ["ignore", "inherit", "inherit", "ipc"] })`;
  const parentWrite = options.scenario === "held"
    ? `process.stderr.write(${JSON.stringify(`${options.line}\n`)});\n`
    : "";

  await writeFile(
    executable,
    `#!${process.execPath}\n` +
      `const { spawn } = require("node:child_process");\n` +
      `const { writeFileSync } = require("node:fs");\n` +
      (options.versionOutput
        ? `if (process.argv[2] === "--version") { process.stdout.write(${JSON.stringify(options.versionOutput)}); process.exit(0); }\n`
        : "") +
      parentWrite +
      `const grandchild = ${grandchildLaunch};\n` +
      `writeFileSync(${JSON.stringify(grandchildPidFile)}, String(grandchild.pid));\n` +
      `grandchild.once("message", () => process.exit(7));\n`,
    { mode: 0o700 },
  );
  await chmod(executable, 0o700);
  return { executable, grandchildPidFile };
}

async function stopGrandchild(pidFile: string): Promise<void> {
  try {
    const pid = Number(await readFile(pidFile, "utf8"));
    if (Number.isSafeInteger(pid) && pid > 0) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function expectChildExit(
  open: () => Promise<AcpHandle>,
  onFailure?: () => void,
): Promise<void> {
  let handle: AcpHandle | null = null;
  try {
    try {
      handle = await open();
    } catch (error) {
      assert.ok(error instanceof AcpChildExitError);
      onFailure?.();
      return;
    }
    assert.fail("expected the failing ACP child to reject the open");
  } finally {
    await handle?.close();
  }
}

/** Register the same process-boundary stderr exit controls for one provider. */
export function registerStderrExitParityTests(
  config: StderrExitParityProvider,
): void {


  test(`${config.provider}: worker A's late close cannot publish into worker B`, async () => {
    const root = await mkdtemp(join(tmpdir(), "cswarm-stderr-late-close-"));
    const cwd = join(root, "cwd");
    const pidFiles: string[] = [];
    try {
      await mkdir(cwd);
      const workerA = await writeFailingExecutable({
        root,
        executableName: `a-${config.executableName}`,
        scenario: "late",
        line: `fatal: ${config.provider} worker A late tail`,
        versionOutput: config.versionOutput,
      });
      const workerB = await writeFailingExecutable({
        root,
        executableName: `b-${config.executableName}`,
        scenario: "flushed",
        line: `fatal: ${config.provider} worker B`,
        versionOutput: config.versionOutput,
      });
      pidFiles.push(workerA.grandchildPidFile, workerB.grandchildPidFile);
      let currentWorker = "A";
      const deliveries: Array<{ worker: string; tail: string }> = [];
      const deliver = (tail: string) => deliveries.push({
        worker: currentWorker,
        tail,
      });

      await expectChildExit(() =>
        config.open({
          cwd,
          executable: workerA.executable,
          onStderrTail: deliver,
        })
      );
      currentWorker = "B";
      await expectChildExit(() =>
        config.open({
          cwd,
          executable: workerB.executable,
          onStderrTail: deliver,
        })
      );
      await new Promise((resolve) => setTimeout(resolve, 450));

      assert.deepEqual(deliveries, [
        { worker: "A", tail: "" },
        { worker: "B", tail: `fatal: ${config.provider} worker B` },
      ]);
    } finally {
      for (const pidFile of pidFiles) await stopGrandchild(pidFile);
      await rm(root, { recursive: true, force: true });
    }
  });

}
