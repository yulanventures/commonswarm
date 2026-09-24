import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import ts from "typescript";
import { AGENT_COMMANDS, type AgentCommandEntry, type AgentCommandGroup } from "../../src/cli.js";
import { AGENT_QUICK_GUIDE, AGENT_SETUP_HOST_GUIDANCE, boundProfileCommands, turnCheckInstruction } from "../../src/cloud/agent-onboarding-contract.js";
import { turnHookFailureText } from "../../src/onboarding-cli.js";
import { configureAgentReceive, requestReceiveCanary } from "../../src/cloud/agent-receive.js";
import { markGrokBotIdle } from "../../src/cloud/agent-channel-grok-bot.js";
import { AGENT_CREDENTIAL_MESSAGE_D088 } from "../../src/cloud/agent-credential-input.js";
import { cachedAgentMessage, checkAgentMessages } from "../../src/cloud/agent-check.js";
import { profileScopeKey, readAgentProfile, saveAgentProfile } from "../../src/cloud/agent-profile.js";
import { setupAgent } from "../../src/cloud/agent-setup.js";
import { MCP_ERROR_SENTENCES } from "../../src/mcp/errors.js";
import { withFileLock } from "../../src/cloud/storage.js";

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
  const raw = cliRaw(dir, args, input);
  const output = raw.stdout || raw.stderr;
  try { return JSON.parse(output) as { ok: boolean; error?: { code: string; message: string }; instruction?: string; next_action?: string }; }
  catch { return { ok: false, error: { code: "plain", message: output } }; }
}

function cliRaw(dir: string, args: string[], input?: string) {
  const result = spawnSync(process.execPath, [resolve("dist/cli.js"), ...args], {
    encoding: "utf8", timeout: 3000, input, env: { ...process.env, HOME: dir, XDG_CONFIG_HOME: join(dir, "config"), SWARM_AGENT_STATE_DIR: join(dir, "state") },
  });
  assert.equal(result.error, undefined, `CLI timed out: ${args.join(" ")}`);
  return result;
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

test("setup reports the resulting binding and MCP gives distinct remedies", { timeout: 10000 }, async () => {
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
    const setup = await setupAgent({ connectionFile: f.input, profilePath: f.profile, hostSessionId: "session-A", fetcher });
    assert.ok(calls > 0);
    assert.equal(setup.host_session_bound, true);
    assert.match(setup.next_action, /cswarm check --profile .* --host-session-id 'session-A'/);
    assert.equal(JSON.parse(await readFile(f.profile, "utf8")).host_session_id, "session-A");
    assert.equal(MCP_ERROR_SENTENCES.profile_other_session!.next_step, "stop and tell the operator");
    assert.equal(MCP_ERROR_SENTENCES.host_session_required!.next_step, "restart this MCP server with the current host session");
    const manual = await setupAgent({ connectionFile: f.input, profilePath: join(f.dir, "manual.json"), hostSessionId: "manual", fetcher });
    assert.equal(manual.host_session_bound, false);
    assert.doesNotMatch(manual.next_action, /cswarm check --profile/);
    const legacy = await setupAgent({ connectionFile: f.input, profilePath: join(f.dir, "manual.json"), hostSessionId: "session-A", fetcher });
    assert.equal(legacy.host_session_bound, true);
    assert.equal((await readAgentProfile(join(f.dir, "manual.json"), "session-A")).host_session_id, "session-A");
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
  const oldHome = process.env.HOME;
  process.env.HOME = f.dir;
  try {
    await saveAgentProfile(f.profile, connection, undefined, "session-A");
    await configureAgentReceive({ profilePath: f.profile, mode: "turn", provider: "claude", hostSessionId: "session-A", cwd: f.dir,
      execution: { command: process.execPath, args: [resolve("dist/cli.js")] } });
    const command = ["check", "--profile", f.profile, "--host-session-id", "session-A", "--hook"];
    const before = await readdir(f.dir);
    for (const event of [{ session_id: "session-B" }, {}]) {
      const other = cliRaw(f.dir, command, JSON.stringify(event));
      assert.equal(other.stdout, "");
      assert.equal(other.stderr, "");
      assert.deepEqual(await readdir(f.dir), before);
    }
    const a = cliRaw(f.dir, command, JSON.stringify({ session_id: "session-A", hook_event_name: "UserPromptSubmit", cwd: f.dir }));
    assert.doesNotMatch(a.stdout, /profile_other_session/);
    assert.ok((await readdir(f.dir)).some(name => name.startsWith("check-error-")), "A did not write a check diagnostic");
    const afterA = await Promise.all((await readdir(f.dir)).filter(name => name.startsWith("check-error-")).map(async name => [name, await readFile(join(f.dir, name), "utf8")]));
    const bAgain = cliRaw(f.dir, command, JSON.stringify({ session_id: "session-B" }));
    assert.equal(bAgain.stdout, "");
    assert.deepEqual(await Promise.all((await readdir(f.dir)).filter(name => name.startsWith("check-error-")).map(async name => [name, await readFile(join(f.dir, name), "utf8")])), afterA);
  } finally {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    await f.cleanup();
  }
});

test("every table row that accepts --profile refuses B and parses A's id", { timeout: 120000 }, async () => {
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
    assert.equal(accepting.length, 42, "reconcile the generated profile rows when the command table changes");
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
      const ownExtra = [
        ...(command[0] === "setup" ? ["--connection-file", f.input] : []),
        ...(command.join(" ") === "receive configure" ? ["--mode", "turn"] : []),
      ];
      const own = cli(f.dir, [...command, "--profile", f.profile, "--host-session-id", "session-A", ...ownExtra]);
      assert.doesNotMatch(own.error?.message ?? "", /unknown option|host_session_required|profile_other_session/, `${command.join(" ")}: ${JSON.stringify(own)}`);
    }
  } finally { await f.cleanup(); }
});

test("receive configure keeps an omitted id distinct from manual", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    await saveAgentProfile(f.profile, connection, undefined, "session-A");
    const options = { profilePath: f.profile, mode: "turn", execution: { command: process.execPath, args: [] } };
    await assert.rejects(configureAgentReceive(options), {
      code: "host_session_required",
      message: "This profile is bound to a host session. Pass --host-session-id with this session's id.",
    });
    await assert.rejects(configureAgentReceive({ ...options, provider: "claude" }), {
      code: "host_session_required",
      message: "This profile is bound to a host session. Pass --host-session-id with this session's id.",
    });
    await assert.rejects(configureAgentReceive({ ...options, hostSessionId: "manual" }), { code: "profile_other_session" });
  } finally { await f.cleanup(); }
});

test("expand checks B before a damaged credential", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    await saveAgentProfile(f.profile, connection, undefined, "session-A");
    const profile = await readAgentProfile(f.profile, "session-A");
    await writeFile(profile.credential_file, "damaged", { mode: 0o600 });
    const b = cli(f.dir, ["whoami", "--profile", f.profile, "--host-session-id", "session-B", "--json"]);
    assert.match(b.error?.message ?? "", /This profile belongs to another session/);
    const a = cli(f.dir, ["whoami", "--profile", f.profile, "--host-session-id", "session-A", "--json"]);
    assert.match(a.error?.message ?? "", /credential/i);
  } finally { await f.cleanup(); }
});

test("receive test and idle leave B's profile folder byte-identical", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    await saveAgentProfile(f.profile, connection, undefined, "session-A");
    const snapshot = async () => Promise.all((await readdir(f.dir)).sort().map(async name => [name, await readFile(join(f.dir, name), "utf8")]));
    const before = await snapshot();
    await assert.rejects(requestReceiveCanary(f.profile, "session-B"), { code: "profile_other_session" });
    assert.deepEqual(await snapshot(), before);
    await assert.rejects(markGrokBotIdle(f.profile, "session-B"), { code: "profile_other_session" });
    assert.deepEqual(await snapshot(), before);
    // Holding B's receive lock proves refusal happens before lock acquisition.
    await withFileLock(f.dir, `receive-${profileScopeKey("session-B")}`, async () => {
      await assert.rejects(requestReceiveCanary(f.profile, "session-B"), { code: "profile_other_session" });
    }, { timeoutMs: 500 });
    assert.deepEqual(await snapshot(), before);
  } finally { await f.cleanup(); }
});

test("bound command producers include the saved id; manual commands stay unchanged", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    await saveAgentProfile(f.profile, connection, undefined, "session-A");
    const producers = [
      () => turnHookFailureText(f.profile, "check_failed", "session-A"),
      () => turnCheckInstruction(f.profile, "session-A"),
      () => boundProfileCommands("Run cswarm check, cswarm receive status, and cswarm receive configure.", f.profile, "session-A")!,
      () => cli(f.dir, ["resume", "--profile", f.profile, "--host-session-id", "session-A", "--json"]).instruction!,
      () => cli(f.dir, ["receive", "status", "--profile", f.profile, "--host-session-id", "session-A", "--json"]).next_action!,
    ];
    for (const produce of producers) {
      const text = produce();
      assert.match(text, /--profile/);
      assert.match(text, /--host-session-id 'session-A'/, text);
    }
    assert.doesNotMatch(turnHookFailureText(f.profile, "check_failed"), /--host-session-id/);
    assert.doesNotMatch(turnCheckInstruction(f.profile), /--host-session-id/);
    assert.equal(boundProfileCommands("Run cswarm check.", f.profile), "Run cswarm check.");
    const skill = await readFile(resolve("site/public/skills/cswarm/SKILL.md"), "utf8");
    for (const command of skill.match(/`cswarm [^`]*--profile [^`]*`/g) ?? []) assert.match(command, /--host-session-id <this-session-id>/);
    assert.match(AGENT_QUICK_GUIDE, /cswarm check --profile <saved-profile> --host-session-id <this-session-id>/);
    const connectPrompt = await readFile(resolve("site/src/components/connect/agent-prompt.ts"), "utf8");
    assert.match(connectPrompt, /cswarm check --profile <saved-profile> --host-session-id <this-session-id>/);
    assert.match(AGENT_SETUP_HOST_GUIDANCE, /cswarm reads no environment variable for the session id/);
    const brief = await readFile(resolve("docs/design/2026-09-24-ITEM-I-PROFILE-SESSION-BINDING-BRIEF.md"), "utf8");
    assert.match(brief, /Decision 4's retired words/);
    assert.match(brief, /cswarm reads no environment variable for the session id/);
  } finally { await f.cleanup(); }
});

test("src never reads an environment variable as the session id", { timeout: 10000 }, async () => {
  const names: string[] = [];
  const visit = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.name.endsWith(".ts")) {
        const source = ts.createSourceFile(path, await readFile(path, "utf8"), ts.ScriptTarget.Latest, true);
        const scan = (node: ts.Node) => {
          if (ts.isVariableDeclaration(node) && node.initializer?.getText(source) === "process.env" &&
              ts.isObjectBindingPattern(node.name)) {
            for (const element of node.name.elements) names.push((element.propertyName ?? element.name).getText(source));
          }
          if (ts.isPropertyAccessExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
              node.expression.expression.getText(source) === "process" && node.expression.name.text === "env") names.push(node.name.text);
          if (ts.isPropertyAccessExpression(node) && node.expression.getText(source) === "env") names.push(node.name.text);
          if (ts.isElementAccessExpression(node) && node.expression.getText(source) === "process.env" &&
              node.argumentExpression && ts.isStringLiteral(node.argumentExpression)) names.push(node.argumentExpression.text);
          if (ts.isElementAccessExpression(node) && node.expression.getText(source) === "env" &&
              node.argumentExpression && ts.isStringLiteral(node.argumentExpression)) names.push(node.argumentExpression.text);
          ts.forEachChild(node, scan);
        };
        scan(source);
      }
    }
  };
  await visit(resolve("src"));
  assert.ok(names.includes("CLAUDE_CONFIG_DIR"), "positive control: known host environment read");
  assert.equal(names.filter(name => /SESSION_ID/i.test(name)).length, 0);
});

test("setup network failures include the operator step", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const result = cli(f.dir, ["setup", "--connection-file", f.input, "--profile", f.profile, "--host-session-id", "session-A", "--json"]);
    assert.ok(result.error?.message.endsWith("Stop and tell the operator. Do not open another agent's profile."), JSON.stringify(result));
    assert.equal(result.error?.code, "onboarding_failed");
  } finally { await f.cleanup(); }
});
