import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { AGENT_COMMANDS, type AgentCommandEntry, type AgentCommandGroup } from "../../src/cli.js";
import { AGENT_CREDENTIAL_MESSAGE_D088 } from "../../src/cloud/agent-credential-input.js";
import { cachedAgentMessage, checkAgentMessages } from "../../src/cloud/agent-check.js";
import { readAgentProfile, saveAgentProfile } from "../../src/cloud/agent-profile.js";
import { setupAgent } from "../../src/cloud/agent-setup.js";
import { MCP_ERROR_SENTENCES } from "../../src/mcp/errors.js";

const WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TOKEN = `swm_agt_${"A".repeat(43)}`;
const stop = "This profile belongs to another session. Stop and tell the operator.";
const connection = {
  version: 1 as const, url: "http://127.0.0.1:9", anon_key: "public-test", workspace_id: WS,
  principal_id: AGENT, credential: { message: AGENT_CREDENTIAL_MESSAGE_D088, status: "accepted", principal_id: AGENT,
    token_id: "11111111-1111-4111-8111-111111111111", run_id: "22222222-2222-4222-8222-222222222222",
    agent_token: TOKEN, expires_at: "2099-01-01T00:00:00.000Z" },
};

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "item-i-binding-"));
  const profile = join(dir, "profile.json");
  const input = join(dir, "connection.json");
  await writeFile(input, JSON.stringify(connection), { mode: 0o600 });
  return { dir, profile, input, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function cli(dir: string, args: string[], input?: string) {
  const result = spawnSync(process.execPath, [resolve("dist/cli.js"), ...args], {
    encoding: "utf8", timeout: 3000, input, env: { ...process.env, HOME: dir, XDG_CONFIG_HOME: join(dir, "config"), SWARM_AGENT_STATE_DIR: join(dir, "state") },
  });
  assert.equal(result.error, undefined, `CLI timed out: ${args.join(" ")}`);
  const raw = result.stdout || result.stderr;
  try { return JSON.parse(raw) as { ok: boolean; error?: { code: string; message: string } }; }
  catch { return { ok: false, error: { code: "plain", message: raw } }; }
}

test("bound A opens before fetch; B and absent id refuse before credential and cache", { timeout: 10000 }, async () => {
  const f = await fixture();
  const oldHome = process.env.HOME;
  const oldState = process.env.SWARM_AGENT_STATE_DIR;
  process.env.HOME = f.dir;
  process.env.SWARM_AGENT_STATE_DIR = join(f.dir, "state");
  try {
    await saveAgentProfile(f.profile, connection, undefined, "session-A");
    const profile = await readAgentProfile(f.profile, "session-A");
    assert.equal(profile.host_session_id, "session-A");
    await writeFile(profile.credential_file, "damaged", { mode: 0o600 });
    await writeFile(join(f.dir, "check.json"), "damaged", { mode: 0o600 });
    let calls = 0;
    const fetcher = (async () => { calls++; throw new Error("fetch reached"); }) as typeof fetch;
    await assert.rejects(checkAgentMessages({ profilePath: f.profile, hostSessionId: "session-B", fetcher, present: async () => {} }),
      { code: "profile_other_session", message: stop });
    await assert.rejects(cachedAgentMessage(f.profile, "cccccccc-cccc-4ccc-8ccc-cccccccccccc", "session-B"), { code: "profile_other_session" });
    await assert.rejects(checkAgentMessages({ profilePath: f.profile, fetcher, present: async () => {} }), { code: "host_session_required" });
    assert.equal(calls, 0);
    await assert.rejects(checkAgentMessages({ profilePath: f.profile, hostSessionId: "session-A", fetcher, present: async () => {} }),
      { code: "check_state_invalid" });
    await rm(join(f.dir, "check.json"));
    await assert.rejects(checkAgentMessages({ profilePath: f.profile, hostSessionId: "session-A", fetcher, present: async () => {} }),
      { code: "agent_credential_invalid_json" });
    await writeFile(profile.credential_file, JSON.stringify(connection.credential), { mode: 0o600 });
    let finalError: unknown;
    try { await checkAgentMessages({ profilePath: f.profile, hostSessionId: "session-A", fetcher, present: async () => {} }); }
    catch (error) { finalError = error; }
    assert.ok(calls > 0, `A did not reach fetch: ${String(finalError)}`);
  } finally {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldState === undefined) delete process.env.SWARM_AGENT_STATE_DIR; else process.env.SWARM_AGENT_STATE_DIR = oldState;
    await f.cleanup();
  }
});

test("manual and old profiles stay unbound; setup cannot rebind", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    await saveAgentProfile(f.profile, connection, undefined, "manual");
    assert.equal((await readAgentProfile(f.profile)).host_session_id, undefined);
    assert.equal(Object.keys(JSON.parse(await readFile(f.profile, "utf8"))).length, 6);
    const legacyRead = cli(f.dir, ["check", "--profile", f.profile, "--host-session-id", "session-B",
      "--message-id", "cccccccc-cccc-4ccc-8ccc-cccccccccccc", "--json"]);
    assert.equal(legacyRead.error?.code, "message_not_cached");
    await saveAgentProfile(f.profile, connection, undefined, "session-A");
    const boundRead = cli(f.dir, ["check", "--profile", f.profile, "--host-session-id", "session-B",
      "--message-id", "cccccccc-cccc-4ccc-8ccc-cccccccccccc", "--json"]);
    assert.equal(boundRead.error?.code, "profile_other_session");
    await assert.rejects(saveAgentProfile(f.profile, connection, undefined, "session-B"), { code: "profile_other_session" });
    await assert.rejects(saveAgentProfile(f.profile, connection, undefined, "manual"), { code: "profile_other_session" });
    assert.equal((await readAgentProfile(f.profile, "session-A")).host_session_id, "session-A");
    let calls = 0;
    const fetcher = (async () => { calls++; throw new Error("network reached"); }) as typeof fetch;
    await assert.rejects(setupAgent({ connectionFile: f.input, profilePath: f.profile, hostSessionId: "session-B", fetcher }), { code: "profile_other_session" });
    await assert.rejects(setupAgent({ connectionFile: f.input, profilePath: f.profile, fetcher }), { code: "setup_host_session_required" });
    assert.equal(calls, 0);
  } finally { await f.cleanup(); }
});

test("setup with A writes the binding and MCP maps both refusals to a person", { timeout: 10000 }, async () => {
  const f = await fixture();
  const oldHome = process.env.HOME;
  const oldState = process.env.SWARM_AGENT_STATE_DIR;
  process.env.HOME = f.dir;
  process.env.SWARM_AGENT_STATE_DIR = join(f.dir, "state");
  try {
    let calls = 0;
    const fetcher = (async (_input: unknown, init?: RequestInit) => {
      calls++;
      const body = JSON.parse(String(init?.body));
      const result = body.resource === "members"
        ? { members: [], agents: [{ principal_id: AGENT, name: "Agent", owner_user_id: WS }],
          identity: { credential_valid: true, principal_id: AGENT, workspace_id: WS, owner_user_id: WS } }
        : { signals: [], capabilities: { sender_owner_relation: 1, cursor_after: 1 } };
      return new Response(JSON.stringify(result), { status: 200 });
    }) as typeof fetch;
    await setupAgent({ connectionFile: f.input, profilePath: f.profile, hostSessionId: "session-A", fetcher });
    assert.ok(calls > 0);
    assert.equal(JSON.parse(await readFile(f.profile, "utf8")).host_session_id, "session-A");
    for (const code of ["profile_other_session", "host_session_required"]) {
      assert.match(MCP_ERROR_SENTENCES[code]!.next_step, /person/);
    }
  } finally {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldState === undefined) delete process.env.SWARM_AGENT_STATE_DIR; else process.env.SWARM_AGENT_STATE_DIR = oldState;
    await f.cleanup();
  }
});

test("setup requires an explicit host choice and MCP refuses at startup", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const missingSetup = cli(f.dir, ["setup", "--connection-file", f.input, "--profile", f.profile, "--json"]);
    assert.equal(missingSetup.error?.code, "setup_host_session_required");
    assert.match(missingSetup.error?.message ?? "", /--host-session-id <this-session-id>/);
    assert.match(missingSetup.error?.message ?? "", /--host-session-id manual/);
    await saveAgentProfile(f.profile, connection, undefined, "session-A");
    for (const [args, code] of [
      [["mcp", "--profile", f.profile], "host_session_required"],
      [["mcp", "--profile", f.profile, "--host-session-id", "session-B"], "profile_other_session"],
    ] as const) {
      const result = cli(f.dir, [...args]);
      assert.match(result.error?.message ?? "", new RegExp(code));
    }
  } finally { await f.cleanup(); }
});

test("setup repair errors end with the operator step", { timeout: 10000 }, async () => {
  const f = await fixture();
  const step = "Stop and tell the operator. Do not open another agent's profile.";
  try {
    const missing = cli(f.dir, ["setup", "--connection-file", join(f.dir, "absent.json"),
      "--host-session-id", "session-A", "--json"]);
    assert.ok(missing.error?.message.endsWith(step));
    await writeFile(f.input, JSON.stringify({ ...connection, credential: {} }), { mode: 0o600 });
    const damaged = cli(f.dir, ["setup", "--connection-file", f.input,
      "--host-session-id", "session-A", "--json"]);
    assert.ok(damaged.error?.message.endsWith(step));
  } finally { await f.cleanup(); }
});

test("hook stdin presents its own session id", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    await saveAgentProfile(f.profile, connection, undefined, "session-A");
    const command = ["check", "--profile", f.profile, "--host-session-id", "session-A", "--hook"];
    const a = cli(f.dir, command, JSON.stringify({ session_id: "session-A" }));
    assert.equal(a.error?.message.includes("profile_other_session"), false);
    const b = cli(f.dir, command, JSON.stringify({ session_id: "session-B" }));
    assert.match(b.error?.message ?? "", /profile_other_session/);
    const missing = cli(f.dir, command, JSON.stringify({}));
    assert.match(missing.error?.message ?? "", /host_session_required/);
  } finally { await f.cleanup(); }
});

test("every table row that accepts --profile refuses session B at profile open", { timeout: 120000 }, async () => {
  const f = await fixture();
  try {
    await saveAgentProfile(f.profile, connection, undefined, "session-A");
    const rows: Array<{ command: string[]; entry: AgentCommandEntry }> = [];
    for (const [verb, root] of Object.entries(AGENT_COMMANDS)) {
      if ("subcommands" in root) {
        for (const [action, entry] of Object.entries((root as AgentCommandGroup).subcommands)) rows.push({ command: [verb, action], entry });
      } else rows.push({ command: [verb], entry: root });
    }
    const accepting = rows.filter(({ entry }) => entry.flags.includes("profile") && entry.profile !== "refuse");
    assert.ok(accepting.length > 20);
    for (const { command, entry } of accepting) {
      const extra = [
        ...(entry.flags.includes("connection-file") ? ["--connection-file", f.input] : []),
        ...(entry.flags.includes("mode") ? ["--mode", "turn"] : []),
        ...(entry.flags.includes("signal-id") ? ["--signal-id", "cccccccc-cccc-4ccc-8ccc-cccccccccccc"] : []),
        ...(entry.flags.includes("receipt") ? ["--receipt", "test-receipt"] : []),
      ];
      const result = cli(f.dir, [...command, "--profile", f.profile, "--host-session-id", "session-B", ...extra,
        ...(entry.flags.includes("json") ? ["--json"] : [])]);
      assert.ok(result.error?.code === "profile_other_session" || result.error?.message.includes(stop),
        `${command.join(" ")}: ${JSON.stringify(result)}`);
    }
  } finally { await f.cleanup(); }
});
