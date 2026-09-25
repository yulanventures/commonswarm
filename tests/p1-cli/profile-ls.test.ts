import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { agentProfileRoot, listAgentProfiles, privatePath } from "../../src/cloud/agent-profile.js";

const LOOPBACK = "http://127.0.0.1:9";
const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const SEAT = "22222222-2222-4222-8222-222222222222";

function profile(path: string, workspaceName?: string): void {
  const dir = resolve(path, "..");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify({ version: 1, url: LOOPBACK, anon_key: "public-test-key",
    workspace_id: WORKSPACE, principal_id: SEAT,
    credential_file: join(dir, "credential.json"),
    ...(workspaceName ? { workspace_name: workspaceName } : {}) }), { mode: 0o600 });
}

test("profile ls finds automatic and connect layouts without opening credentials", { timeout: 10_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "cswarm-profile-ls-"));
  const oldHome = process.env.HOME;
  try {
    process.env.HOME = home;
    const root = agentProfileRoot();
    const automatic = join(root, "agents", "deployment", WORKSPACE, SEAT, "profile.json");
    const connected = join(root, `connect-${SEAT}`, "profile.json");
    const damaged = join(root, "agents", "damaged", "profile.json");
    profile(automatic, "Test workspace");
    profile(connected);
    mkdirSync(resolve(damaged, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(damaged, "{", { mode: 0o600 });
    const listed = await listAgentProfiles();
    assert.deepEqual(listed.searched_roots, [root]);
    assert.equal(listed.profiles.length, 3);
    assert.deepEqual(listed.profiles.map(row => row.path), [connected, damaged, automatic].sort());
    assert.equal(listed.profiles.find(row => row.path === automatic)?.workspace_name, "Test workspace");
    assert.equal(listed.profiles.find(row => row.path === damaged)?.error, "profile_invalid");
    assert.ok(listed.profiles.every(row => !JSON.stringify(row).includes("public-test-key")));
    // The credential files do not exist: a successful inventory proves they were not opened.
    const cli = spawnSync(process.execPath, ["dist/cli.js", "profile", "ls", "--url", LOOPBACK, "--json"], {
      cwd: resolve("."), env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 10_000,
    });
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(JSON.parse(cli.stdout).profiles.length, 2);
    assert.match(cli.stdout, /Test workspace/);
    assert.doesNotMatch(cli.stdout, /public-test-key/);
    assert.throws(() => privatePath(SEAT), (error: unknown) => {
      assert.match(String(error), /cswarm profile ls/);
      assert.match(String(error), /agents.*profile\.json/);
      return true;
    });
  } finally {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});
