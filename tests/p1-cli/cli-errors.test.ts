import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";

async function cli(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [
    "--import",
    "tsx",
    "src/cli.ts",
    ...args,
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SWARM_CLOUD_URL: "",
      SWARM_CLOUD_ANON_KEY: "",
      SWARM_CLOUD_WORKSPACE_ID: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
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

test("missing cloud URL names invite acceptance as the real front door", async () => {
  const result = await cli(["login"]);

  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /service base URL/);
  assert.match(result.stderr, /The service we run is https:\/\/api\.commonswarm\.com/);
  assert.doesNotMatch(result.stderr, /supabase\.co/);
  assert.doesNotMatch(result.stderr, /Supabase project/);
  assert.doesNotMatch(result.stderr, /if you created it/);
  assert.doesNotMatch(
    result.stderr,
    /who invited you/,
    "the no-target message assumes an inviter again; self-serve users have none",
  );
  assert.match(result.stderr, /invite/);
  assert.match(result.stderr, /cswarm accept --link-stdin/);
  assert.match(result.stderr, /invite links carry the Cloud target/);
  assert.match(result.stderr, /SWARM_CLOUD_URL/);
  assert.match(result.stderr, /SWARM_CLOUD_ANON_KEY/);
  assert.doesNotMatch(result.stderr, /Project Settings/);
  assert.match(result.stderr, /meta tags at https:\/\/commonswarm\.com\/start/);
  assert.match(result.stderr, /discover/);
  assert.deepEqual(
    result.stderr.match(/https?:\/\/[^\s),]+/g),
    [
      "https://commonswarm.com",
      "https://api.commonswarm.com",
      "https://api.commonswarm.com",
      "https://commonswarm.com/start",
    ],
  );
});

test("a URL with a path must be the service base URL, with no path", async () => {
  const result = await cli([
    "login",
    "--url",
    "https://api.commonswarm.com/functions/v1/command",
    "--anon-key",
    "anon",
  ]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /--url must be the service base URL, with no path/);
  assert.doesNotMatch(result.stderr, /Supabase project/);
});

test("shared positional-count errors distinguish too few, too many, and exact", async () => {
  const target = ["--url", "http://127.0.0.1:9", "--anon-key", "anon"];
  const tooFew = await cli(["working-on", ...target]);
  assert.equal(tooFew.code, 1);
  assert.match(
    tooFew.stderr,
    /too few positional arguments: expected 2, received 1/,
  );

  const tooMany = await cli(["workspaces", "extra", ...target]);
  assert.equal(tooMany.code, 1);
  assert.match(
    tooMany.stderr,
    /too many positional arguments: expected 1, received 2/,
  );

  const exact = await cli(["help"]);
  assert.equal(exact.code, 0);
  assert.match(exact.stdout, /^cswarm /);
  assert.equal(exact.stderr, "");
});
