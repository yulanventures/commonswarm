import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";

async function runCli(values: string[]): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  const child = spawn(process.execPath, [
    "--import",
    "tsx",
    "src/cli.ts",
    ...values,
  ], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => stdout += chunk);
  child.stderr.on("data", (chunk: string) => stderr += chunk);
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status) => resolve(status ?? 1));
  });
  return { code, stdout, stderr };
}

test("workspace close refuses a confirm mismatch before credentials or network", async () => {
  const result = await runCli([
    "workspace",
    "close",
    "Science Swarm",
    "--confirm",
    "science swarm",
    "--url",
    "http://127.0.0.1:1",
    "--anon-key",
    "unused",
  ]);
  assert.equal(result.code, 1);
  assert.match(
    result.stderr,
    /--confirm must exactly repeat the workspace selector; no request was sent/,
  );
  assert.doesNotMatch(result.stderr, /login|network|HTTP/i);
});
