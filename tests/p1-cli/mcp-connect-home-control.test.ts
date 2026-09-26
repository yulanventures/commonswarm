import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

test("Fold 18 whole MCP lane leaves an empty isolated HOME and builds default paths only from fixtures", { timeout: 240000 }, async () => {
  const home = await mkdtemp("/tmp/lane-home.");
  const logs = await mkdtemp("/tmp/lane-home-spy.");
  const log = join(logs, "homedir.log");
  try {
    const run = spawnSync(process.execPath, ["--require", resolve("tests/p1-cli/mcp-connect-home-spy.cjs"), "--import", "tsx",
      "--test-isolation=none", "--test", "tests/p1-cli/mcp-connect.test.ts"], {
      cwd: process.cwd(), env: { ...process.env, HOME: home, CSWARM_HOME_SPY_LOG: log },
      encoding: "utf8", timeout: 180000, maxBuffer: 8 * 1024 * 1024,
    });
    assert.equal(run.status, 0, `whole MCP lane failed: ${run.error ?? run.stderr.slice(-2000)}\n${run.stdout.slice(-2000)}`);
    const entries = await readdir(home);
    assert.deepEqual(entries, [], `isolated HOME entries after lane run: ${JSON.stringify(entries)}`);
    const calls = (await readFile(log, "utf8")).trim().split("\n").filter(Boolean)
      .map(line => JSON.parse(line) as { path: string; stack: string });
    const builtHomes = calls.filter(call => call.stack.includes("mcp-connect")).map(call => call.path);
    assert.ok(builtHomes.length > 0, "the homedir spy observed default-path construction");
    assert.ok(builtHomes.every(path => path !== home), `default paths used the lane HOME: ${JSON.stringify(builtHomes)}`);
    assert.ok(builtHomes.every(path => path.startsWith(join(tmpdir(), "cswarm-mcp-"))),
      `a homedir-derived path escaped temporary fixtures: ${JSON.stringify(builtHomes)}`);
  } finally { await rm(home, { recursive: true, force: true }); await rm(logs, { recursive: true, force: true }); }
});
