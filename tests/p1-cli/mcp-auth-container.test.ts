/** Docker acceptance for HM lane 6. Reached only by the test:p1-cli Actions suite. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

async function run(command: string, args: string[]): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => code === 0
      ? resolve(Buffer.concat(stdout).toString("utf8"))
      : reject(new Error(`${command} exited ${code}: ${Buffer.concat(stderr).toString("utf8")}`)));
  });
}

test("OAuth image builds pinned dependencies and runs as the unprivileged service user", async () => {
  const tag = `commonswarm-mcp-auth-test:${randomUUID()}`;
  await run("docker", ["build", "--pull=false", "--tag", tag, "services/mcp-auth"]);
  try {
    const result = await run("docker", [
      "run", "--rm", "--read-only", "--entrypoint", "node", tag, "-e",
      "const p=require('./package.json'); console.log(JSON.stringify({uid:process.getuid(),gid:process.getgid(),node:process.versions.node,provider:p.dependencies['oidc-provider']}))",
    ]);
    const measured = JSON.parse(result.trim()) as {
      uid: number; gid: number; node: string; provider: string;
    };
    assert.equal(measured.uid, 10001);
    assert.equal(measured.gid, 10001);
    assert.match(measured.node, /^22\./u);
    assert.equal(measured.provider, "9.12.2");
  } finally {
    await run("docker", ["image", "rm", tag]);
  }
});
