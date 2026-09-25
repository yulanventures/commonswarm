import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { userInfo } from "node:os";
import test from "node:test";
import { agentProfileRoot, listAgentProfiles, privatePath, saveAgentProfile } from "../../src/cloud/agent-profile.js";
import { mapMcpError } from "../../src/mcp/errors.js";
import { parseProfileListUrl } from "../../src/cli.js";
import { createLaneTempHome, removeLaneTempHome } from "../support/lane-temp-home.js";

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

test("profile ls finds walked and registered paths without opening credentials", { timeout: 10_000 }, async () => {
  const home = createLaneTempHome("profile-ls-");
  const oldHome = process.env.HOME;
  try {
    process.env.HOME = home;
    const root = agentProfileRoot();
    const automatic = join(root, "agents", "deployment", WORKSPACE, SEAT, "profile.json");
    const connected = join(root, `connect-${SEAT}`, "profile.json");
    const damaged = join(root, "agents", "damaged", "profile.json");
    profile(automatic, "Test workspace");
    profile(connected);
    const explicit = join(home, "explicit", "chosen.json");
    await saveAgentProfile(explicit, { version: 1, url: LOOPBACK, anon_key: "public-test-key",
      workspace_id: WORKSPACE, principal_id: SEAT, credential: { test: true } });
    rmSync(join(home, "explicit", "credential.json"));
    const registry = join(root, "profile-paths.json");
    assert.equal(statSync(registry).mode & 0o777, 0o600);
    mkdirSync(resolve(damaged, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(damaged, "{", { mode: 0o600 });
    const listed = await listAgentProfiles();
    assert.deepEqual(listed.searched_roots, [root]);
    assert.equal(listed.profiles.length, 4);
    assert.deepEqual(listed.profiles.map(row => row.path).sort(), [connected, damaged, automatic, explicit].sort());
    assert.equal(listed.profiles.find(row => row.path === automatic)?.workspace_name, "Test workspace");
    assert.equal(listed.profiles.find(row => row.path === damaged)?.error, "profile_invalid");
    assert.ok(listed.profiles.every(row => !JSON.stringify(row).includes("public-test-key")));
    // The credential files do not exist: a successful inventory proves they were not opened.
    const cli = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "profile", "ls", "--url", LOOPBACK, "--json"], {
      cwd: resolve("."), env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 10_000,
    });
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(JSON.parse(cli.stdout).profiles.length, 4);
    assert.match(cli.stdout, /Test workspace/);
    assert.doesNotMatch(cli.stdout, /public-test-key/);
    assert.throws(() => privatePath(SEAT), (error: unknown) => {
      assert.match(String(error), /cswarm profile ls/);
      assert.match(String(error), /agents.*profile\.json/);
      return true;
    });
    let invalid: unknown;
    try { privatePath(SEAT); } catch (error) { invalid = error; }
    assert.match(mapMcpError(invalid).message, /cswarm profile ls/);
    assert.match(mapMcpError(invalid).message, /agents.*profile\.json/);
    rmSync(explicit);
    const missing = await listAgentProfiles();
    assert.equal(missing.profiles.find(row => row.path === explicit)?.error, "profile_missing");
    assert.throws(() => parseProfileListUrl("not-a-url"), (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "profile_url_invalid");
    const unreadable = join(root, "unreadable");
    mkdirSync(unreadable, { mode: 0o700 });
    chmodSync(unreadable, 0o000);
    try {
      const withFailure = await listAgentProfiles();
      assert.equal(withFailure.profiles.find(row => row.path === unreadable)?.error, "directory_unreadable");
      assert.ok(withFailure.profiles.some(row => row.path === automatic));
    } finally { chmodSync(unreadable, 0o700); }
  } finally {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    removeLaneTempHome(home);
  }
});

test("temporary home cleanup refuses outside paths", { timeout: 10_000 }, () => {
  const helper = readFileSync(resolve("tests/support/lane-temp-home.ts"), "utf8");
  assert.match(helper, /actual === "\/" \|\| actual === realHome/);
  assert.match(helper, /inside\.startsWith/);
  const home = createLaneTempHome("cleanup-control-");
  try {
    assert.throws(() => removeLaneTempHome("/"));
    assert.throws(() => removeLaneTempHome(userInfo().homedir));
    assert.throws(() => removeLaneTempHome("/etc"));
    assert.throws(() => removeLaneTempHome(join(resolve(home, ".."), "lane-home-never-created")));
  } finally {
    removeLaneTempHome(home);
  }
});
