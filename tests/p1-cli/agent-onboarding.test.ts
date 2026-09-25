import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { AGENT_CREDENTIAL_MESSAGE_D088 } from "../../src/cloud/agent-credential-input.js";
import { AGENT_CONNECTION_VERSION } from "../../src/cloud/agent-onboarding-contract.js";
import { AgentSetupError, parseAgentConnection, readAgentProfile } from "../../src/cloud/agent-profile.js";
import { setupAgent } from "../../src/cloud/agent-setup.js";
import { AGENT_CHECK_CACHE_LIMIT, AGENT_CHECK_PAGE_SIZE, cachedAgentMessage, checkAgentMessages, renderAgentCheck, withAgentDeadline } from "../../src/cloud/agent-check.js";
import { configureAgentReceive, mergeReceiveHooks, readReceiveBinding, receiveHookEvent, receiveStatus } from "../../src/cloud/agent-receive.js";
import { ChannelReceiptGate } from "../../src/cloud/agent-channel.js";
import type { SignalRecord } from "../../src/cloud/command-client.js";
import type { DeliveryRow } from "../../src/cloud/delivery.js";
import { createLaneTempHome, removeLaneTempHome } from "../support/lane-temp-home.js";

const WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWNER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const TOKEN = `swm_agt_${"A".repeat(43)}`;
let root: string;
let previousState: string | undefined;
before(async () => {
  root = await mkdtemp(join(tmpdir(), "cswarm-onboarding-"));
  previousState = process.env.SWARM_AGENT_STATE_DIR;
  process.env.SWARM_AGENT_STATE_DIR = join(root, "renewal");
});
after(async () => {
  if (previousState === undefined) delete process.env.SWARM_AGENT_STATE_DIR;
  else process.env.SWARM_AGENT_STATE_DIR = previousState;
  await rm(root, { recursive: true, force: true });
});

function artifact(principal = AGENT) {
  return { message: AGENT_CREDENTIAL_MESSAGE_D088, status: "accepted", principal_id: principal,
    token_id: "11111111-1111-4111-8111-111111111111", run_id: "22222222-2222-4222-8222-222222222222",
    agent_token: TOKEN, expires_at: "2099-01-01T00:00:00.000Z" };
}
function connection(url = "https://fixture.example", principal = AGENT) {
  return { version: AGENT_CONNECTION_VERSION, url, anon_key: "public-fixture", workspace_id: WS, principal_id: principal, credential: artifact(principal) };
}
function row(i: number, body = `message ${i}`): SignalRecord {
  return { id: `${String(i).padStart(8, "0")}-1111-4111-8111-111111111111`, workspace_id: WS,
    from: OWNER, from_kind: "user", to: null, to_agent: AGENT, in_reply_to: null, about: null, kind: i % 2 ? "ask" : "note",
    body, until: "2099-01-01T00:00:00.000Z", created_at: "2026-09-08T00:00:00.000Z", sender_owner_relation: "same_owner" };
}
function fixture(rows: SignalRecord[] = [], principal = AGENT, failAck: boolean | number = false) {
  const requests: Array<Record<string, unknown>> = [];
  const fetcher = (async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${TOKEN}`);
    assert.equal(init?.redirect, "error", "credentials must not follow a redirect");
    let result;
    if (body.resource === "members") result = {
      members: [{ user_id: OWNER, display_name: "Owner" }],
      agents: [{ principal_id: principal, name: "Test agent", owner_user_id: OWNER }],
      identity: { credential_valid: true, principal_id: principal, workspace_id: WS, owner_user_id: OWNER },
    };
    else if (body.resource === "signals") result = {
      signals: rows.filter(r => !body.after_id || r.id > body.after_id).slice(0, body.limit),
      capabilities: { sender_owner_relation: 1, cursor_after: 1 },
    };
    else if ((body.command as { kind?: string } | undefined)?.kind === "ack_agent_delivery") {
      const command = body.command as Record<string, unknown>;
      assert.equal(command.unclaimed, true);
      assert.equal(command.lease_id, null);
      assert.equal(command.outcome, "observed");
      return new Response(JSON.stringify(failAck ? { error: failAck === 409 ? "delivery_ack_conflict" : "temporarily_unavailable" } :
        { ok: true, status: "accepted", event_ids: [], signal_id: command.signal_id, outcome: "observed" }),
        { status: failAck ? typeof failAck === "number" ? failAck : 503 : 200 });
    } else throw new Error("unexpected request");
    return new Response(JSON.stringify(result), { status: 200 });
  }) as typeof fetch;
  return { fetcher, requests };
}
async function saveInput(envelope = connection()) {
  const dir = await mkdtemp(join(root, "input-"));
  const path = join(dir, "connection.json");
  await writeFile(path, JSON.stringify(envelope), { mode: 0o600 });
  return path;
}
async function setup(rows: SignalRecord[] = []) {
  const input = await saveInput();
  const profilePath = join(dirname(input), "agent", "profile.json");
  const fake = fixture(rows);
  const result = await setupAgent({ hostSessionId: "manual", connectionFile: input, profilePath, fetcher: fake.fetcher });
  return { input, profilePath, fake, result };
}

test("setup reports success after a profile save when the optional inventory is unavailable", { timeout: 10_000 }, async () => {
  const oldHome = process.env.HOME;
  try {
    for (const cause of ["mode", "damaged"] as const) {
      const home = createLaneTempHome(`setup-inventory-${cause}-`);
      try {
        process.env.HOME = home;
        const inventoryRoot = join(home, ".cswarm");
        await mkdir(inventoryRoot, { mode: 0o700 });
        if (cause === "mode") await chmod(inventoryRoot, 0o755);
        else await writeFile(join(inventoryRoot, "profile-paths.json"), "{", { mode: 0o600 });
        const input = await saveInput();
        const profilePath = join(inventoryRoot, "agents", "test", "profile.json");
        const warnings: string[] = [];
        const write = process.stderr.write;
        process.stderr.write = ((chunk: string) => { warnings.push(String(chunk)); return true; }) as typeof write;
        let result;
        try { result = await setupAgent({ hostSessionId: "manual", connectionFile: input, profilePath, fetcher: fixture().fetcher }); }
        finally { process.stderr.write = write; }
        assert.equal(result.connected, true);
        assert.equal((await lstat(profilePath)).mode & 0o777, 0o600);
        assert.equal(warnings.length, 1);
        assert.match(warnings[0]!, cause === "mode" ? /chmod 700 ~\/\.cswarm/ : /inventory unavailable/);
      } finally { removeLaneTempHome(home); }
    }
  } finally {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
  }
});

async function cli(args: string[], input?: string) {
  const child = spawn(process.execPath, [(process.env.CSWARM_TEST_CLI ?? resolve("dist/cli.js")), ...args], {
    env: { ...process.env, SWARM_AGENT_STATE_DIR: join(root, "renewal"), XDG_CONFIG_HOME: join(root, "config") },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => stdout += chunk);
  child.stderr.on("data", chunk => stderr += chunk);
  child.stdin.end(input);
  const code = await new Promise<number>((done, reject) => {
    child.once("error", reject); child.once("close", code => done(code ?? 1));
  });
  return { code, stdout, stderr };
}

test("connection envelope validates version, exact fields, origin, and full agent identity", () => {
  assert.equal(parseAgentConnection(JSON.stringify(connection())).principal_id, AGENT);
  for (const bad of [
    { ...connection(), version: 2 }, { ...connection(), extra: true },
    { ...connection(), principal_id: OTHER }, { ...connection(), url: "https://fixture.example/?secret=1" },
    { ...connection(), url: "http://fixture.example" }, { ...connection(), credential: { agent_token: TOKEN } },
  ]) assert.throws(() => parseAgentConnection(JSON.stringify(bad)));
});

test("setup checks identity before saving and starts no receiver", async () => {
  const input = await saveInput();
  const path = join(dirname(input), "agent", "profile.json");
  const wrong = fixture([], OTHER);
  await assert.rejects(setupAgent({ hostSessionId: "manual", connectionFile: input, profilePath: path, fetcher: wrong.fetcher }), { code: "authenticated_identity_mismatch" });
  await assert.rejects(lstat(path), { code: "ENOENT" });
  const fake = fixture();
  const result = await setupAgent({ hostSessionId: "manual", connectionFile: input, profilePath: path, fetcher: fake.fetcher });
  assert.equal(result.connected, true);
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
  assert.deepEqual(result.receive_capabilities.wake, { provider: "claude", preview: true, requires_idle_test: true });
  assert.deepEqual(result.receive_capabilities.wake_providers, [
    { provider: "claude", preview: true, requires_idle_test: true },
    { provider: "grok-bot", preview: false, requires_idle_test: true },
  ]);
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
  assert.equal((await lstat(dirname(path))).mode & 0o777, 0o700);
  assert.deepEqual(fake.requests.map(r => r.resource).sort(), ["members", "signals"]);
  assert.equal(await readReceiveBinding(path), null);
});

test("setup refuses unsafe input and never writes credentials under a repo", async () => {
  const input = await saveInput();
  await chmod(input, 0o644);
  await assert.rejects(setupAgent({ hostSessionId: "manual", connectionFile: input, fetcher: fixture().fetcher }));
  await chmod(input, 0o600);
  const repo = join(dirname(input), "repo");
  await mkdir(join(repo, ".git"), { recursive: true });
  await assert.rejects(setupAgent({ hostSessionId: "manual", connectionFile: input, profilePath: join(repo, "private", "profile.json"), fetcher: fixture().fetcher }), { code: "profile_inside_repository" });
  const link = join(dirname(input), "link.json");
  await symlink(input, link);
  await assert.rejects(setupAgent({ hostSessionId: "manual", connectionFile: link, fetcher: fixture().fetcher }));
});

test("repeat setup preserves receive choice; a profile cannot be replaced by another identity", async () => {
  const { input, profilePath, fake } = await setup();
  await configureAgentReceive({ profilePath, mode: "turn", execution: { command: process.execPath, args: [(process.env.CSWARM_TEST_CLI ?? resolve("dist/cli.js"))] } });
  const before = await readReceiveBinding(profilePath);
  await setupAgent({ hostSessionId: "manual", connectionFile: input, profilePath, fetcher: fake.fetcher });
  assert.deepEqual(await readReceiveBinding(profilePath), before);
  const other = await saveInput(connection("https://fixture.example", OTHER));
  await assert.rejects(setupAgent({ hostSessionId: "manual", connectionFile: other, profilePath, fetcher: fixture([], OTHER).fetcher }), { code: "profile_conflict" });
  assert.equal((await readAgentProfile(profilePath)).principal_id, AGENT);
});

test("standalone checks drain tied timestamps and overflow and ACK what was shown", async () => {
  const rows = Array.from({ length: 45 }, (_, i) => row(i + 1, "x".repeat(1200)));
  const { profilePath, fake } = await setup(rows);
  const seen: string[] = [];
  let more = true;
  while (more) {
    const result = await checkAgentMessages({ profilePath, fetcher: fake.fetcher, present: async result => { seen.push(...result.messages.map(m => m.id)); } });
    more = result.has_more;
  }
  assert.deepEqual(seen, rows.map(r => r.id));
  assert.equal(fake.requests.filter(r => (r.command as { kind?: string } | undefined)?.kind === "ack_agent_delivery").length, rows.length);
  const quiet = await checkAgentMessages({ profilePath, hostSessionId: "resumed-session", fetcher: fake.fetcher, present: async () => {} });
  assert.equal(quiet.messages.length, 0, "resume shares the profile cursor");
  assert.equal(renderAgentCheck(quiet), "");
  assert.equal(quiet.cached, false);
  assert.equal((await cachedAgentMessage(profilePath, rows[0]!.id)).body.length, 1200);
});

test("output failure does not advance the cursor; a fresh check is not a cooldown", async () => {
  const { profilePath, fake } = await setup([row(1)]);
  await assert.rejects(checkAgentMessages({ profilePath, fetcher: fake.fetcher, present: async () => { throw new Error("closed output"); } }));
  let shown = 0;
  await checkAgentMessages({ profilePath, fetcher: fake.fetcher, present: async r => { shown += r.messages.length; } });
  assert.equal(shown, 1);
  const next = fixture([row(1), row(2)]);
  await checkAgentMessages({ profilePath, fetcher: next.fetcher, present: async r => { shown += r.messages.length; } });
  assert.equal(shown, 2);
});

test("failed observation leaves check successful and retries after a later empty check", async () => {
  const { profilePath } = await setup();
  const failed = fixture([row(1)], AGENT, true);
  const first = await checkAgentMessages({ profilePath, fetcher: failed.fetcher, present: async () => {} });
  assert.equal(first.messages.length, 1);
  assert.equal(failed.requests.filter(r => (r.command as { kind?: string } | undefined)?.kind === "ack_agent_delivery").length, 1);
  await new Promise(resolve => setTimeout(resolve, 270));
  const recovered = fixture([row(1)]);
  const second = await checkAgentMessages({ profilePath, fetcher: recovered.fetcher, present: async () => {} });
  assert.equal(second.messages.length, 0);
  assert.equal(recovered.requests.filter(r => (r.command as { kind?: string } | undefined)?.kind === "ack_agent_delivery").length, 1);
  // Mutation control: once the ACK succeeds, a third check must not repeat it.
  const quiet = fixture([row(1)]);
  await checkAgentMessages({ profilePath, fetcher: quiet.fetcher, present: async () => {} });
  assert.equal(quiet.requests.filter(r => (r.command as { kind?: string } | undefined)?.kind === "ack_agent_delivery").length, 0);
});

test("in-flight observation ends within the remaining check deadline", { timeout: 5_000 }, async () => {
  const { profilePath } = await setup();
  const base = fixture([row(1), row(2)]);
  let ackStarted = 0;
  const fetcher = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (body.command?.kind === "ack_agent_delivery") {
      ackStarted++;
      if (ackStarted === 1) {
        await new Promise(resolve => setTimeout(resolve, 160));
        return new Response(JSON.stringify({ error: "temporarily_unavailable" }), { status: 503 });
      }
      return await new Promise<Response>(() => {}); // transport ignores abort
    }
    return base.fetcher(input, init);
  }) as typeof fetch;
  const deadline = Date.now() + 350;
  const output: string[] = [];
  let forcedExitText = "";
  const hardExit = setTimeout(() => { forcedExitText = "check_timeout"; }, Math.max(0, deadline - Date.now() + 150));
  let result: Awaited<ReturnType<typeof checkAgentMessages>>;
  try {
    result = await checkAgentMessages({ profilePath, fetcher, deadlineAtMs: deadline,
      present: async value => { output.push(renderAgentCheck(value)); } });
  } finally { clearTimeout(hardExit); }
  assert.equal(result.messages.length, 2);
  assert.equal(ackStarted, 2);
  assert.ok(output[0]?.includes(row(1).id));
  assert.ok(Date.now() < deadline + 100, "an ack in flight must finish before hook forced-exit grace");
  assert.equal(forcedExitText, "", "the forced-exit failure text cannot fire after an ACK deadline");
  assert.doesNotMatch(output.join(""), /check_timeout/);
});

test("terminal observation refusals leave the queue after one request each", { timeout: 15_000 }, async () => {
  const { profilePath } = await setup();
  const rows = Array.from({ length: AGENT_CHECK_PAGE_SIZE + 1 }, (_, index) => row(index + 1));
  const failed = fixture(rows, AGENT, 409);
  await checkAgentMessages({ profilePath, fetcher: failed.fetcher, present: async () => {} });
  for (let check = 0; check < 5; check++)
    await checkAgentMessages({ profilePath, fetcher: failed.fetcher, present: async () => {} });
  const acks = failed.requests.filter(r => (r.command as { kind?: string } | undefined)?.kind === "ack_agent_delivery");
  assert.equal(acks.length, rows.length, "N terminal refusals cause N requests across five later checks");
  assert.deepEqual(acks.map(r => (r.command as { signal_id: string }).signal_id), rows.map(row => row.id));
});

test("transient observation retries use backoff until the age cap", { timeout: 10_000 }, async () => {
  const { profilePath } = await setup();
  const failed = fixture([row(1)], AGENT, 503);
  const path = join(dirname(profilePath), "check.json");
  for (let check = 0; check < 5; check++) {
    await checkAgentMessages({ profilePath, fetcher: failed.fetcher, present: async () => {} });
    const state = JSON.parse(await readFile(path, "utf8"));
    assert.ok(state.pending_observed_retries[row(1).id].next_at > Date.now());
    if (check < 4) {
      const before = failed.requests.filter(r => (r.command as { kind?: string } | undefined)?.kind === "ack_agent_delivery").length;
      await checkAgentMessages({ profilePath, fetcher: failed.fetcher, present: async () => {} });
      assert.equal(failed.requests.filter(r => (r.command as { kind?: string } | undefined)?.kind === "ack_agent_delivery").length,
        before, "backoff defers an immediate retry");
      state.pending_observed_retries[row(1).id].next_at = 0;
      await writeFile(path, JSON.stringify(state), { mode: 0o600 });
    }
  }
  const acks = () => failed.requests.filter(r => (r.command as { kind?: string } | undefined)?.kind === "ack_agent_delivery");
  assert.equal(acks().length, 5, "an outage cannot exhaust an attempt cap");
  const state = JSON.parse(await readFile(path, "utf8"));
  state.pending_observed_ids = [row(2).id];
  state.pending_observed_retries = { [row(2).id]: { attempts: 1, first_at: Date.now() - 2 * 24 * 60 * 60 * 1_000 } };
  await writeFile(path, JSON.stringify(state), { mode: 0o600 });
  await checkAgentMessages({ profilePath, fetcher: failed.fetcher, present: async () => {} });
  assert.equal(acks().length, 5, "an aged retry is dropped without a request");
  const aged = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(aged.pending_observed_ids, []);
  assert.deepEqual(aged.pending_observed_retries, {});
});

test("observation retry metadata stays within the capped queue", { timeout: 20_000 }, async () => {
  const rows = Array.from({ length: AGENT_CHECK_CACHE_LIMIT + 5 }, (_, i) => row(i + 1));
  const { profilePath } = await setup();
  const failed = fixture(rows, AGENT, 503);
  let more = true;
  while (more) {
    const result = await checkAgentMessages({ profilePath, fetcher: failed.fetcher, present: async () => {} });
    more = result.has_more;
  }
  const state = JSON.parse(await readFile(join(dirname(profilePath), "check.json"), "utf8"));
  const queued = new Set<string>(state.pending_observed_ids);
  const retries = Object.keys(state.pending_observed_retries);
  assert.equal(queued.size, AGENT_CHECK_CACHE_LIMIT);
  assert.deepEqual(state.pending_observed_ids, rows.slice(-AGENT_CHECK_CACHE_LIMIT).map(value => value.id));
  assert.ok(retries.length > 0, "failed observations entered the retry map");
  assert.ok(retries.length <= AGENT_CHECK_CACHE_LIMIT);
  assert.ok(retries.every(id => queued.has(id)), "retry metadata belongs only to queued ids");
  assert.ok(!retries.includes(rows[0]!.id), "a row dropped by the cap loses its retry metadata");
});

test("deadline timeout counts the attempt and preserves an earlier 409 removal", { timeout: 5_000 }, async () => {
  const { profilePath } = await setup();
  const base = fixture([row(1), row(2)]);
  const fetcher = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (body.command?.kind === "ack_agent_delivery") {
      if (body.command.signal_id === row(1).id)
        return new Response(JSON.stringify({ error: "delivery_ack_conflict" }), { status: 409 });
      return await new Promise<Response>(() => {});
    }
    return base.fetcher(input, init);
  }) as typeof fetch;
  await checkAgentMessages({ profilePath, fetcher, deadlineAtMs: Date.now() + 450, present: async () => {} });
  const state = JSON.parse(await readFile(join(dirname(profilePath), "check.json"), "utf8"));
  assert.deepEqual(state.pending_observed_ids, [row(2).id]);
  assert.equal(state.pending_observed_retries[row(2).id].attempts, 1);
  assert.ok(Number.isFinite(state.pending_observed_retries[row(2).id].first_at));
  assert.ok(state.pending_observed_retries[row(2).id].next_at > Date.now(),
    "a timed-out request retains backoff after the deadline");
});

test("401 and 429 observation refusals stay queued for retry", { timeout: 5_000 }, async () => {
  for (const status of [401, 429]) {
    const { profilePath } = await setup();
    const failed = fixture([row(1)], AGENT, status);
    await checkAgentMessages({ profilePath, fetcher: failed.fetcher, present: async () => {} });
    const state = JSON.parse(await readFile(join(dirname(profilePath), "check.json"), "utf8"));
    assert.deepEqual(state.pending_observed_ids, [row(1).id]);
    assert.equal(state.pending_observed_retries[row(1).id].attempts, 1);
  }
});

test("typed 403, 404, session conflict, and invalid request leave the queue", { timeout: 5_000 }, async () => {
  for (const [status, code] of [[403, "delivery_unavailable"], [404, "delivery_unavailable"],
    [409, "session_conflict"], [400, "invalid_request"]] as const) {
    const { profilePath } = await setup();
    const base = fixture([row(1)]);
    const fetcher = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.command?.kind === "ack_agent_delivery")
        return new Response(JSON.stringify({ error: code }), { status });
      return base.fetcher(input, init);
    }) as typeof fetch;
    await checkAgentMessages({ profilePath, fetcher, present: async () => {} });
    const state = JSON.parse(await readFile(join(dirname(profilePath), "check.json"), "utf8"));
    assert.deepEqual(state.pending_observed_ids, [], `${status} ${code}`);
    assert.deepEqual(state.pending_observed_retries, {}, `${status} ${code}`);
  }
});

test("check stops at wrong-recipient and out-of-order pages without consuming them", async () => {
  for (const rows of [[row(2), row(1)], [{ ...row(1), to_agent: OTHER }]]) {
    const { profilePath } = await setup();
    await assert.rejects(checkAgentMessages({ profilePath, fetcher: fixture(rows).fetcher, present: async () => assert.fail("must not show a bad page") }));
    const result = await checkAgentMessages({ profilePath, fetcher: fixture([row(1)]).fetcher, present: async () => {} });
    assert.equal(result.messages.length, 1);
  }
});

test("deadline completes even if the transport ignores cancellation", async () => {
  const started = performance.now();
  await assert.rejects(withAgentDeadline(25, async fetcher => fetcher("https://fixture.example"), (() => new Promise(() => {})) as typeof fetch), { code: "check_timeout" });
  assert.ok(performance.now() - started < 500);
});

test("hook merge keeps unrelated handlers and repeated install does not duplicate ours", () => {
  const base = { other: true, hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "other-agent" }] }] } };
  const first = mergeReceiveHooks(base, "my-check", null, false);
  assert.deepEqual(mergeReceiveHooks(first, "my-check", "my-check", false), first);
  assert.equal(JSON.stringify(first).includes("other-agent"), true);
  assert.equal(JSON.stringify(first).includes("Stop"), false);
});

test("Claude hook verifies only the configured session; Stop records idle without reading messages", async () => {
  const { profilePath } = await setup();
  const cwd = await mkdtemp(join(root, "project-"));
  const result = await configureAgentReceive({ profilePath, mode: "turn", provider: "claude", hostSessionId: "session-one", cwd, execution: { command: process.execPath, args: [(process.env.CSWARM_TEST_CLI ?? resolve("dist/cli.js"))] } });
  assert.equal(result.turn_check, "pending_host");
  assert.deepEqual(await receiveHookEvent(profilePath, "session-one", { session_id: "session-two", cwd, hook_event_name: "UserPromptSubmit" }), { check: false, provider: null });
  assert.equal((await readReceiveBinding(profilePath, "session-one"))!.turn_verified_at, null);
  assert.equal((await receiveHookEvent(profilePath, "session-one", { session_id: "session-one", cwd, hook_event_name: "UserPromptSubmit" })).check, true);
  assert.equal(receiveStatus(await readReceiveBinding(profilePath, "session-one")).turn_check, "verified");
  assert.equal((await receiveHookEvent(profilePath, "session-one", { session_id: "session-one", cwd, hook_event_name: "Stop" })).check, false);
  assert.equal((await readReceiveBinding(profilePath, "session-one"))!.idle, true);
});

test("wake requires explicit preview choice and cannot claim support on Codex", async () => {
  const { profilePath } = await setup();
  const common = { profilePath, mode: "wake", hostSessionId: "session-one", execution: { command: process.execPath, args: [(process.env.CSWARM_TEST_CLI ?? resolve("dist/cli.js"))] } };
  await assert.rejects(configureAgentReceive({ ...common, provider: "codex" }), { code: "wake_host_unsupported" });
  await assert.rejects(configureAgentReceive({ ...common, provider: "claude" }), { code: "wake_preview_consent_required" });
  await assert.rejects(configureAgentReceive({ ...common, provider: "codex", mode: "turn", grokBotAgentId: AGENT }), { code: "grok_bot_agent_id_unsupported" });
  assert.equal(receiveStatus(null).wake_verified, false);
});

test("channel receipt requires the pending challenge and the same session", () => {
  const delivery: DeliveryRow = { signal: row(1), leaseId: "11111111-2222-4222-8222-222222222222", leasedUntil: "2099-01-01T00:00:00.000Z", senderOwnerRelation: "same_owner", recipientPosition: 0, recipientCount: 1 };
  const gate = new ChannelReceiptGate("session-one", { row: delivery, receipt: "challenge", ack_command_id: "cmd_12345678", confirmed: false });
  assert.throws(() => gate.confirm(row(1).id, "challenge", "session-two"), { code: "channel_receipt_mismatch" });
  assert.throws(() => gate.confirm(row(1).id, "wrong", "session-one"), { code: "channel_receipt_mismatch" });
  assert.equal(gate.pending!.confirmed, false);
  assert.equal(gate.confirm(row(1).id, "challenge", "session-one").confirmed, true);
});

test("CLI setup and profile feed work against an HTTP fixture without exposing secrets", async () => {
  const fake = fixture([row(1)]);
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", data => raw += data);
    req.on("end", () => { void (async () => {
      const response = await fake.fetcher("http://fixture", { body: raw, headers: req.headers as Record<string, string>, redirect: "error" });
      res.writeHead(response.status, { "content-type": "application/json" }); res.end(await response.text());
    })().catch(() => res.writeHead(500).end()); });
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const browserPromptModule = "../../site/src/components/connect/agent-prompt.js";
    const { dashboardAgentPrompt } = await import(browserPromptModule);
    const prompt = dashboardAgentPrompt({
      credential: { principalId: AGENT, principalName: "Test agent", tokenId: artifact().token_id,
        runId: artifact().run_id, token: TOKEN, expiresAt: Date.parse(artifact().expires_at),
        renews: true, horizonExpiresAt: null, grantKind: "standing" },
      workspaceId: WS, workspaceName: "Fixture", deploymentUrl: url, anonKey: "public_fixture",
    });
    const raw = prompt.match(/\bCSWARMA\.[A-Z2-7]+\.[A-Z2-7]+\b/)?.[0] ?? prompt.match(/```json\n([^]*?)\n```/)?.[1];
    assert.ok(raw);
    const input = await saveInput();
    await writeFile(input, raw);
    const profile = join(dirname(input), "saved", "profile.json");
    const run = await cli(["setup", "--connection-file", input, "--host-session-id", "manual", "--profile", profile, "--json"]);
    assert.equal(run.code, 0, run.stderr || run.stdout);
    assert.equal(JSON.parse(run.stdout).connected, true);
    const feed = await cli(["feed", "--profile", profile, "--json"]);
    assert.equal(feed.code, 0, feed.stderr);
    assert.match(feed.stdout, /message 1/);
    assert.equal((run.stdout + run.stderr + feed.stdout + feed.stderr).includes(TOKEN), false);
    const conflict = await cli(["feed", "--profile", profile, "--workspace-id", WS]);
    assert.equal(conflict.code, 1);
    assert.match(conflict.stderr, /Do not combine/);
    const malformed = await cli(["setup", "--connection-file", "/does-not-exist/private/file", "--host-session-id", "manual", "--json"]);
    assert.equal(malformed.code, 1);
    assert.equal(JSON.parse(malformed.stdout).ok, false);
  } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
});

test("host detection uses the closest process and stops at another host", async () => {
  const { detectAgentHost } = await import("../../src/cloud/agent-host.js");
  const tree = new Map([[10, { parent: 11, executable: "/bin/zsh" }], [11, { parent: 12, executable: "/usr/local/bin/codex" }], [12, { parent: 1, executable: "/usr/local/bin/claude" }]]);
  assert.equal(await detectAgentHost(async pid => tree.get(pid) ?? null, 10), "codex");
  tree.set(11, { parent: 12, executable: "/usr/local/bin/grok" });
  assert.equal(await detectAgentHost(async pid => tree.get(pid) ?? null, 10), "unknown");
  assert.equal(await detectAgentHost(async () => null, 10), "unknown");
});

test("managed profile checks use only the named host's proof", async () => {
  const { newSessionBinding, defaultSessionContextPath, writeSessionContext } = await import("../../src/cloud/session-context.js");
  const { profileSessionContext, profileTarget } = await import("../../src/cloud/agent-profile.js");
  const { AGENT_SESSION_ID_HEADER } = await import("../../src/cloud/session-contract.js");
  const { profilePath, fake } = await setup([row(1)]);
  const profile = await readAgentProfile(profilePath);
  const old = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = join(root, "managed-config");
  try {
    const context = { ...newSessionBinding({ target: profileTarget(profile), workspaceId: WS, principalId: AGENT, provider: "codex", mode: "interactive", hostSessionId: "this-session", tokenFile: profile.credential_file }), generation: 1 };
    const path = defaultSessionContextPath(WS, AGENT, context.session_id);
    await writeSessionContext(path, context);
    assert.equal((await profileSessionContext(profile, "this-session"))!.path, path);
    await assert.rejects(profileSessionContext(profile, "another-session"), { code: "profile_session_conflict" });
    let count = 0;
    const boundFetch = (async (url, init) => {
      assert.equal(new Headers(init?.headers).get(AGENT_SESSION_ID_HEADER), context.session_id);
      count++;
      return fake.fetcher(url, init);
    }) as typeof fetch;
    await checkAgentMessages({ profilePath, hostSessionId: "this-session", fetcher: boundFetch, present: async () => {} });
    assert.equal(count, 3, "directory, inbox, and observation all carry the current session proof");
    assert.equal(fake.requests.filter(r => (r.command as { kind?: string } | undefined)?.kind === "ack_agent_delivery").length, 1);
  } finally { if (old === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = old; }
});

test("Codex hooks preserve host settings and configure waits for the receive-state lock", async () => {
  const { withFileLock, writeSecureJsonFile } = await import("../../src/cloud/storage.js");
  const { profileScopeKey } = await import("../../src/cloud/agent-profile.js");
  const { receiveBindingPath } = await import("../../src/cloud/agent-receive.js");
  const { setTimeout: delay } = await import("node:timers/promises");
  const { profilePath } = await setup();
  const cwd = await mkdtemp(join(root, "codex-project-"));
  await mkdir(join(cwd, ".codex"));
  await writeFile(join(cwd, ".codex", "hooks.json"), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "existing-hook" }] }] } }));
  const options = { profilePath, mode: "turn", provider: "codex", hostSessionId: "codex-one", cwd, execution: { command: process.execPath, args: [(process.env.CSWARM_TEST_CLI ?? resolve("dist/cli.js"))] } };
  const configured = await configureAgentReceive(options);
  assert.equal(configured.turn_check, "pending_host");
  assert.match(await readFile(join(cwd, ".codex", "hooks.json"), "utf8"), /existing-hook/);
  let acquired!: () => void, release!: () => void;
  const ready = new Promise<void>(r => { acquired = r; });
  const hold = new Promise<void>(r => { release = r; });
  const timestamp = new Date().toISOString();
  const writer = withFileLock(dirname(profilePath), `receive-${profileScopeKey("codex-one")}`, async () => {
    acquired();
    await hold;
    const binding = await readReceiveBinding(profilePath, "codex-one");
    await writeSecureJsonFile(receiveBindingPath(profilePath, "codex-one"), JSON.stringify({ ...binding, turn_verified_at: timestamp }));
  });
  await ready;
  let completed = false;
  const config = configureAgentReceive(options).then(result => { completed = true; return result; });
  try { await delay(40); assert.equal(completed, false, "configure must not bypass an active state writer"); }
  finally { release(); await writer; }
  await config;
  assert.equal((await readReceiveBinding(profilePath, "codex-one"))!.turn_verified_at, timestamp);
});


test("damaged handoffs fail before authentication and keep CLI errors secret-free", async () => {
  const marker = "SYNTHETIC_PRIVATE_MARKER";
  const original = { ...connection(), anon_key: marker };
  const cases = [
    { raw: JSON.stringify(original).replaceAll("_", "\\_"), code: "connection_invalid", markdown: true },
    { raw: JSON.stringify({ ...original, url: "[https://fixture.example](https://fixture.example)" }), code: "connection_target_invalid", markdown: true },
    { raw: `{\"${marker}\":`, code: "connection_invalid", markdown: false },
    { raw: JSON.stringify({ ...original, workspace_id: undefined }), code: "connection_invalid", markdown: false },
    { raw: JSON.stringify({ ...original, credential: { ...artifact(), agent_token: marker } }), code: "agent_credential_invalid_agent_token", markdown: false },
  ];
  for (const item of cases) {
    const input = await saveInput(original);
    await writeFile(input, item.raw);
    let calls = 0;
    await assert.rejects(setupAgent({ hostSessionId: "manual", connectionFile: input, fetcher: (async () => { calls++; throw new Error("network reached"); }) as typeof fetch }), { code: item.code });
    assert.equal(calls, 0);
    for (const flags of [[], ["--json"]]) {
      const result = await cli(["setup", "--connection-file", input, "--host-session-id", "manual", ...flags]);
      assert.equal(result.code, 1);
      const output = result.stdout + result.stderr;
      assert.equal(output.includes(marker), false);
      assert.equal(output.includes(TOKEN), false);
      if (item.markdown) assert.match(output, /Markdown/);
      if (flags.length) {
        const error = JSON.parse(result.stdout);
        assert.equal(error.ok, false);
        assert.equal(result.stderr, "");
      }
    }
    assert.equal(await readFile(input, "utf8"), item.raw, "rejected input is never repaired");
  }
  const version = await cli(["setup", "--check-version"]);
  assert.equal(version.code, 0);
  assert.deepEqual(JSON.parse(version.stdout), { setup_version: 1 });
});

test("Grok Bot env detection applies unless a foreign CLI host bounds the walk", async () => {
  const { detectAgentHost } = await import("../../src/cloud/agent-host.js");
  const pass = async () => ({ parent: 1, executable: "bash" });
  for (const env of [{ CURSOR_AGENT: "1" }, { SAND_HOST_PORT: "1340" }, { CURSOR_AGENT_SOCKET: "/tmp/fixture.sock" }]) {
    assert.equal(await detectAgentHost(pass, 10, env, () => false), "grok-bot");
    for (const executable of ["grok", "opencode", "gemini"]) {
      assert.equal(await detectAgentHost(async () => ({ parent: 1, executable }), 10, env, () => true), "unknown");
    }
    assert.equal(await detectAgentHost(async () => null, 10, env, () => true), "unknown");
    assert.equal(await detectAgentHost(async () => ({ parent: 1, executable: "codex" }), 10, env, () => true), "codex");
    // Bot supervisors are not competing CLIs; env markers still apply.
    assert.equal(await detectAgentHost(async () => ({ parent: 1, executable: "sand-exit-watch" }), 10, env, () => false), "grok-bot");
  }
  assert.equal(await detectAgentHost(pass, 10, {}, () => false), "unknown");
  assert.equal(await detectAgentHost(async () => ({ parent: 1, executable: "sand-exit-watch" }), 10, {}, () => false), "unknown");
  assert.equal(await detectAgentHost(pass, 10, {}, p => p === "/home/box/sand-data/gateway.json"), "grok-bot");
  assert.equal(await detectAgentHost(async pid => ({ parent: pid + 1, executable: "node" }), 10, { CURSOR_AGENT: "1" }, () => false), "grok-bot");
});
