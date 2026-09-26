import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("item K registry and credential checks use fixture homes and leave their enclosing HOME empty", { timeout: 60_000 }, async () => {
  const home = await mkdtemp("/tmp/lane-home.");
  const logs = await mkdtemp("/tmp/lane-home-spy.");
  const log = join(logs, "homedir.log");
  try {
    for (const [file, pattern] of [
      ["agent-onboarding.test.ts", "standalone checks drain tied timestamps"],
      ["mcp-connect.test.ts", "connect saves an unbound private profile"],
    ]) {
      const run = spawnSync(process.execPath, ["--require", resolve("tests/p1-cli/item-k-home-spy.cjs"),
        "--import", "tsx", "--test-isolation=none", "--test", `--test-name-pattern=${pattern}`,
        `tests/p1-cli/${file}`], {
        cwd: process.cwd(), env: { ...process.env, HOME: home, CSWARM_HOME_SPY_LOG: log },
        encoding: "utf8", timeout: 25_000, maxBuffer: 1024 * 1024,
      });
      assert.equal(run.status, 0, `${file}: ${run.error ?? run.stderr.slice(-1000)}\n${run.stdout.slice(-1000)}`);
      assert.match(run.stdout, /pass 1/, file);
      assert.deepEqual(await readdir(home), [], `${file} reached the enclosing HOME`);
    }
    const calls = (await readFile(log, "utf8")).trim().split("\n").filter(Boolean)
      .map(line => JSON.parse(line) as { path: string; stack: string });
    const builders = calls.filter(call => /agent-profile|agent-credential/.test(call.stack));
    assert.ok(builders.some(call => call.stack.includes("agent-profile")), "registry path builder was observed");
    // The check fixture sets SWARM_AGENT_STATE_DIR, so its credential builder does not call homedir().
    assert.ok(builders.every(call => call.path !== home && call.path !== userInfo().homedir),
      "a builder reached the enclosing or real home");
    assert.ok(builders.every(call => call.path.startsWith(join(tmpdir(), "cswarm-") ) || call.path.startsWith(join(tmpdir(), "lane-home-"))),
      "a builder escaped fixture homes");
  } finally { await rm(home, { recursive: true, force: true }); await rm(logs, { recursive: true, force: true }); }
});
