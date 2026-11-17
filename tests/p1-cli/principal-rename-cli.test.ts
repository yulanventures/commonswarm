/** cswarm principal rename: a person renames an agent with the rename_agent command. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const cli = (...argv: string[]) => spawnSync(process.execPath, ["dist/cli.js", ...argv], {
  encoding: "utf8", timeout: 20_000, env: { ...process.env, CSWARM_CONFIG_DIR: "/nonexistent-cswarm-config" },
});

test("principal rename is listed with its two required flags", () => {
  const help = cli("principal", "rename", "--help");
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /cswarm principal rename .*--principal-id <uuid> --name <new name>/u);
  assert.match(help.stdout, /Rename an agent\./u);
});

test("principal rename refuses a missing name or an unknown flag before any network call", () => {
  const missing = cli("principal", "rename", "--principal-id", "11111111-1111-4111-8111-111111111111");
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /--name is required/u);
  const unknown = cli("principal", "rename", "--principal-id", "x", "--name", "Lead", "--allow-duplicate-name");
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /unknown option:? --allow-duplicate-name/u);
  const profile = cli("principal", "rename", "--principal-id", "x", "--name", "Lead", "--profile", "/tmp/none.json");
  assert.equal(profile.status, 1, "a human command never runs from an agent profile");
});

test("principal rename sends exactly rename_agent and explains a taken name", async () => {
  const source = await readFile("src/cli.ts", "utf8");
  const start = source.indexOf("async function runPrincipal");
  const end = source.indexOf("async function runToken", start);
  const principalFn = source.slice(start, end);
  assert.match(principalFn, /action === "rename"/u);
  assert.match(principalFn, /\{ kind: "rename_agent", principal_id: principalId, name \}/u);
  assert.match(principalFn, /principal_name_taken/u);
  assert.match(principalFn, /The agent keeps its name/u);
  const client = await readFile("src/cloud/command-client.ts", "utf8");
  assert.match(client, /kind: "rename_agent"; principal_id: string; name: string/u);
});
