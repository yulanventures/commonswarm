import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { AGENT_CREDENTIAL_MESSAGE_D088 } from "../../src/cloud/agent-credential-input.js";
import { AGENT_CONNECTION_VERSION } from "../../src/cloud/agent-onboarding-contract.js";
import { AgentSetupError, parseAgentConnection, readAgentProfile, saveAgentProfile } from "../../src/cloud/agent-profile.js";
import { setupAgent } from "../../src/cloud/agent-setup.js";
import { AGENT_CHECK_ACK_RETRY_BASE_MS, AGENT_CHECK_CACHE_LIMIT, AGENT_CHECK_DIRECT_TIMEOUT_MS, AGENT_CHECK_PAGE_SIZE, cachedAgentMessage, checkAgentMessages, renderAgentCheck, withAgentDeadline } from "../../src/cloud/agent-check.js";
import { configureAgentReceive, formatTurnHookOutput, mergeReceiveHooks, readReceiveBinding, receiveHookEvent, receiveStatus, recordStopDrainContinuation } from "../../src/cloud/agent-receive.js";
import { ChannelReceiptGate } from "../../src/cloud/agent-channel.js";
import type { SignalRecord } from "../../src/cloud/command-client.js";
import type { DeliveryRow } from "../../src/cloud/delivery.js";
import { createLaneTempHome, removeLaneTempHome } from "../support/lane-temp-home.js";
import { appendHandledAsk, handledAskIds } from "../../src/cloud/ask-chain-context.js";

const WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWNER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const TOKEN = `swm_agt_${"A".repeat(43)}`;
let root: string;
let previousState: string | undefined;
let previousHome: string | undefined;
before(async () => {
  root = await mkdtemp(join(tmpdir(), "cswarm-onboarding-"));
  previousHome = process.env.HOME;
  process.env.HOME = root;
  previousState = process.env.SWARM_AGENT_STATE_DIR;
  process.env.SWARM_AGENT_STATE_DIR = join(root, "renewal");
});
after(async () => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
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
/** Every signal id the observation requests named, single or batched, in request order. */
function ackedIds(requests: Array<Record<string, unknown>>): string[] {
  return requests.map(r => r.command as { kind?: string; signal_id?: string; signal_ids?: string[] } | undefined)
    .filter(command => command?.kind === "ack_agent_delivery")
    .flatMap(command => command!.signal_ids ?? [command!.signal_id!]);
}
function fixture(rows: SignalRecord[] = [], principal = AGENT, failAck: boolean | number = false,
  options: { oldEdge?: boolean; ackDelayMs?: number } = {}) {
  let inFlight = 0;
  const stats = { maxInFlight: 0 };
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
      const batch = Array.isArray(command.signal_ids) ? command.signal_ids as string[] : null;
      // An edge older than the batch shape refuses it as a malformed command.
      if (batch && options.oldEdge) return new Response(JSON.stringify({ error: "invalid_request" }), { status: 400 });
      inFlight++;
      stats.maxInFlight = Math.max(stats.maxInFlight, inFlight);
      try {
        if (options.ackDelayMs) await new Promise(resolveDelay => setTimeout(resolveDelay, options.ackDelayMs));
      } finally { inFlight--; }
      return new Response(JSON.stringify(failAck ? { error: failAck === 409 ? "delivery_ack_conflict" : "temporarily_unavailable" } :
        batch ? { ok: true, status: "accepted", event_ids: [], outcome: "observed", signal_ids: batch, observed_signal_ids: batch, refused: [] }
        : { ok: true, status: "accepted", event_ids: [], signal_id: command.signal_id, outcome: "observed" }),
        { status: failAck ? typeof failAck === "number" ? failAck : 503 : 200 });
    } else throw new Error("unexpected request");
    return new Response(JSON.stringify(result), { status: 200 });
  }) as typeof fetch;
  return { fetcher, requests, stats };
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
        assert.match(warnings[0]!, cause === "mode" ? /chmod 700 ~\/\.cswarm/ : /damaged inventory moved to ~\/\.cswarm\/profile-paths\.json\.damaged-/);
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
    { provider: "codex", preview: false, requires_idle_test: true },
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
  assert.deepEqual(ackedIds(fake.requests).sort(), rows.map(r => r.id).sort(), "each shown message is observed once");
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

test("turn checks replace the host-scoped handled asks after presentation", async () => {
  const ask = row(1);
  const note = row(2);
  const { profilePath, fake } = await setup([ask, note]);
  await checkAgentMessages({ profilePath, hostSessionId: "turn-a", fetcher: fake.fetcher, present: async () => {} });
  assert.deepEqual(await handledAskIds(profilePath, "turn-a"), [ask.id]);
  assert.deepEqual(await handledAskIds(profilePath, "turn-b"), []);

  const channelAsk = row(3);
  await appendHandledAsk(profilePath, "turn-a", channelAsk.id);
  assert.deepEqual(await handledAskIds(profilePath, "turn-a"), [ask.id, channelAsk.id],
    "a channel ask remains in the turn context after its separate receipt path");

  await checkAgentMessages({ profilePath, hostSessionId: "turn-a", fetcher: fixture([ask, note]).fetcher, present: async () => {} });
  assert.deepEqual(await handledAskIds(profilePath, "turn-a"), [], "the next successful turn replaces channel context");
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

test("terminal observation refusals leave the queue after one attempt each", { timeout: 15_000 }, async () => {
  const { profilePath } = await setup();
  const rows = Array.from({ length: AGENT_CHECK_PAGE_SIZE + 1 }, (_, index) => row(index + 1));
  const failed = fixture(rows, AGENT, 409);
  await checkAgentMessages({ profilePath, fetcher: failed.fetcher, present: async () => {} });
  for (let check = 0; check < 5; check++)
    await checkAgentMessages({ profilePath, fetcher: failed.fetcher, present: async () => {} });
  const acks = failed.requests.filter(r => (r.command as { kind?: string } | undefined)?.kind === "ack_agent_delivery");
  assert.equal(acks.length, 2, "one batched request per page across five later checks");
  assert.deepEqual(ackedIds(failed.requests), rows.map(row => row.id), "N terminal refusals name each id once");
});

test("a check observes a whole page in one batched request", { timeout: 15_000 }, async () => {
  const rows = Array.from({ length: AGENT_CHECK_PAGE_SIZE }, (_, index) => row(index + 1));
  const { profilePath } = await setup();
  const fake = fixture(rows, AGENT, false, { ackDelayMs: 800 });
  const result = await checkAgentMessages({ profilePath, fetcher: fake.fetcher, timeoutMs: AGENT_CHECK_DIRECT_TIMEOUT_MS,
    present: async () => {} });
  assert.equal(result.messages.length, AGENT_CHECK_PAGE_SIZE);
  const acks = fake.requests.filter(r => (r.command as { kind?: string } | undefined)?.kind === "ack_agent_delivery");
  assert.equal(acks.length, 1, "one request for the page");
  assert.deepEqual((acks[0]!.command as { signal_ids: string[] }).signal_ids, rows.map(r => r.id));
  const state = JSON.parse(await readFile(join(dirname(profilePath), "check.json"), "utf8"));
  assert.deepEqual(state.pending_observed_ids, [], "nothing is left for the next check");
  assert.deepEqual(state.pending_observed_retries, {});
});

test("against an edge without the batch shape a check observes each message singly, four at a time", { timeout: 15_000 }, async () => {
  const rows = Array.from({ length: AGENT_CHECK_PAGE_SIZE }, (_, index) => row(index + 1));
  const { profilePath } = await setup();
  const fake = fixture(rows, AGENT, false, { oldEdge: true, ackDelayMs: 100 });
  await checkAgentMessages({ profilePath, fetcher: fake.fetcher, timeoutMs: AGENT_CHECK_DIRECT_TIMEOUT_MS,
    present: async () => {} });
  const acks = fake.requests.map(r => r.command as { kind?: string; signal_id?: string; signal_ids?: string[] } | undefined)
    .filter(command => command?.kind === "ack_agent_delivery");
  assert.deepEqual(acks[0]!.signal_ids, rows.map(r => r.id), "the batch goes first");
  assert.deepEqual(acks.slice(1).map(command => command!.signal_id).sort(), rows.map(r => r.id).sort(),
    "then every id once in the single shape");
  assert.ok(acks.slice(1).every(command => command!.signal_ids === undefined));
  assert.equal(fake.stats.maxInFlight, 4, "four single requests at a time");
  const state = JSON.parse(await readFile(join(dirname(profilePath), "check.json"), "utf8"));
  assert.deepEqual(state.pending_observed_ids, [], "the 400 dropped nothing: every id was observed singly");
});

test("transient observation retries use backoff until the age cap", { timeout: 10_000 }, async () => {
  const { profilePath } = await setup();
  const failed = fixture([row(1)], AGENT, 503);
  const path = join(dirname(profilePath), "check.json");
  for (let check = 0; check < 5; check++) {
    const started = Date.now();
    await checkAgentMessages({ profilePath, fetcher: failed.fetcher, present: async () => {} });
    const state = JSON.parse(await readFile(path, "utf8"));
    const retry = state.pending_observed_retries[row(1).id];
    /* The backoff is measured from the failure, which comes after `started`, so this bound holds
     * however slow the runner is. Comparing against the clock after the check did not: the first
     * backoff is 250 ms, and a loaded runner can spend that between the failure and the read. */
    assert.equal(retry.attempts, check + 1, "each transient failure counts one attempt");
    assert.ok(retry.next_at >= started + AGENT_CHECK_ACK_RETRY_BASE_MS * 2 ** check,
      `attempt ${check + 1} backs off at least ${AGENT_CHECK_ACK_RETRY_BASE_MS * 2 ** check} ms`);
    if (check < 4) {
      // A backoff still running defers the retry: hold it open whatever the runner's speed, then check again.
      retry.next_at = Math.max(retry.next_at, Date.now() + 60_000);
      await writeFile(path, JSON.stringify(state), { mode: 0o600 });
      const before = failed.requests.filter(r => (r.command as { kind?: string } | undefined)?.kind === "ack_agent_delivery").length;
      await checkAgentMessages({ profilePath, fetcher: failed.fetcher, present: async () => {} });
      assert.equal(failed.requests.filter(r => (r.command as { kind?: string } | undefined)?.kind === "ack_agent_delivery").length,
        before, "backoff defers an immediate retry");
      const deferred = JSON.parse(await readFile(path, "utf8"));
      assert.equal(deferred.pending_observed_retries[row(1).id].attempts, check + 1, "a deferred retry is not an attempt");
      deferred.pending_observed_retries[row(1).id].next_at = 0;
      await writeFile(path, JSON.stringify(deferred), { mode: 0o600 });
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
      // An older edge: the batch is refused, then each id goes singly.
      if (Array.isArray(body.command.signal_ids))
        return new Response(JSON.stringify({ error: "invalid_request" }), { status: 400 });
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
  assert.equal(JSON.stringify(first).includes("Stop"), true);
  const gemini = mergeReceiveHooks(
    { other: true, hooks: { BeforeAgent: [{ matcher: "*", hooks: [{ type: "command", command: "other-gemini" }] }] } },
    "my-check",
    null,
    false,
    "gemini",
  );
  assert.deepEqual(mergeReceiveHooks(gemini, "my-check", "my-check", false, "gemini"), gemini);
  assert.equal(JSON.stringify(gemini).includes("other-gemini"), true);
  assert.equal(JSON.stringify(gemini).includes("AfterAgent"), true);
});

test("Claude wake settings add only the receipt permission and turn removes only it", async () => {
  const created = mergeReceiveHooks({ permissions: { deny: ["Bash"] } }, "check", null, true);
  assert.deepEqual(created.permissions, { deny: ["Bash"], allow: ["mcp__cswarm__cswarm_received"] });
  const { profilePath } = await setup();
  const cwd = await mkdtemp(join(root, "claude-permissions-"));
  const settingsPath = join(cwd, ".claude", "settings.local.json");
  await mkdir(dirname(settingsPath), { recursive: true });
  const unrelatedHook = { hooks: [{ type: "command", command: "other-agent" }] };
  await writeFile(settingsPath, JSON.stringify({
    theme: "kept", permissions: { allow: ["Read", "mcp__other__tool"] },
    hooks: { UserPromptSubmit: [unrelatedHook] },
  }));
  const common = { profilePath, provider: "claude", hostSessionId: "permission-session", cwd,
    execution: { command: process.execPath, args: [(process.env.CSWARM_TEST_CLI ?? resolve("dist/cli.js"))] } };
  await configureAgentReceive({ ...common, mode: "wake", previewChannel: true });
  await configureAgentReceive({ ...common, mode: "wake", previewChannel: true });
  const wake = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.equal(wake.theme, "kept");
  assert.deepEqual(wake.permissions.allow, ["Read", "mcp__other__tool", "mcp__cswarm__cswarm_received"]);
  assert.equal(JSON.stringify(wake.hooks).includes("other-agent"), true);
  await configureAgentReceive({ ...common, mode: "turn" });
  const turn = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.deepEqual(turn.permissions.allow, ["Read", "mcp__other__tool"]);
  assert.equal(turn.theme, "kept");
  assert.equal(JSON.stringify(turn.hooks).includes("other-agent"), true);
});

test("Claude receive refuses malformed permissions without changing settings", async () => {
  const { profilePath } = await setup();
  const cwd = await mkdtemp(join(root, "claude-invalid-permissions-"));
  const settingsPath = join(cwd, ".claude", "settings.local.json");
  await mkdir(dirname(settingsPath), { recursive: true });
  const before = `${JSON.stringify({ permissions: { allow: "Read" }, untouched: true }, null, 2)}\n`;
  await writeFile(settingsPath, before);
  await assert.rejects(configureAgentReceive({
    profilePath, mode: "wake", provider: "claude", hostSessionId: "invalid-permission-session", cwd,
    previewChannel: true, execution: { command: process.execPath, args: [(process.env.CSWARM_TEST_CLI ?? resolve("dist/cli.js"))] },
  }), { code: "receive_settings_invalid" });
  assert.equal(await readFile(settingsPath, "utf8"), before);
});

test("Claude hook verifies only the configured session; turn-mode Stop drains once per turn and wake-mode Stop stays passive", async () => {
  const { profilePath } = await setup();
  const cwd = await mkdtemp(join(root, "project-"));
  const result = await configureAgentReceive({ profilePath, mode: "turn", provider: "claude", hostSessionId: "session-one", cwd, execution: { command: process.execPath, args: [(process.env.CSWARM_TEST_CLI ?? resolve("dist/cli.js"))] } });
  assert.equal(result.turn_check, "pending_host");
  assert.deepEqual(await receiveHookEvent(profilePath, "session-one", { session_id: "session-two", cwd, hook_event_name: "UserPromptSubmit" }), { check: false, provider: null });
  assert.equal((await readReceiveBinding(profilePath, "session-one"))!.turn_verified_at, null);
  assert.equal((await receiveHookEvent(profilePath, "session-one", { session_id: "session-one", cwd, hook_event_name: "UserPromptSubmit" })).check, true);
  assert.equal(receiveStatus(await readReceiveBinding(profilePath, "session-one")).turn_check, "verified");
  const firstStop = await receiveHookEvent(profilePath, "session-one", { session_id: "session-one", cwd, hook_event_name: "Stop" });
  assert.equal(firstStop.check, true);
  assert.equal(firstStop.stop_drain, true);
  assert.equal((await readReceiveBinding(profilePath, "session-one"))!.idle, true);
  // Active stop continuation never loops.
  const activeStop = await receiveHookEvent(profilePath, "session-one", { session_id: "session-one", cwd, hook_event_name: "Stop", stop_hook_active: true });
  assert.equal(activeStop.check, false);
  assert.equal(activeStop.stop_drain, false);
  // Per-turn drain cap prevents loops even if a host omits stop_hook_active.
  await recordStopDrainContinuation(profilePath, "session-one");
  assert.equal((await receiveHookEvent(profilePath, "session-one", { session_id: "session-one", cwd, hook_event_name: "Stop" })).check, false);
  // A fresh turn resets the drain cap.
  assert.equal((await receiveHookEvent(profilePath, "session-one", { session_id: "session-one", cwd, hook_event_name: "UserPromptSubmit" })).check, true);
  assert.equal((await receiveHookEvent(profilePath, "session-one", { session_id: "session-one", cwd, hook_event_name: "Stop" })).check, true);
  // Wake mode leaves Stop passive so idle channel delivery and canaries stay untouched.
  await configureAgentReceive({ profilePath, mode: "wake", provider: "claude", hostSessionId: "session-one", cwd, execution: { command: process.execPath, args: [(process.env.CSWARM_TEST_CLI ?? resolve("dist/cli.js"))] } });
  const wakeStop = await receiveHookEvent(profilePath, "session-one", { session_id: "session-one", cwd, hook_event_name: "Stop" });
  assert.equal(wakeStop.check, false);
  assert.equal((await readReceiveBinding(profilePath, "session-one"))!.idle, true);
});

test("Claude and Codex wake setup; Codex requires a host-bound thread UUID and instructions cannot claim wake", async () => {
  const { profilePath } = await setup();
  const cwd = await mkdtemp(join(root, "claude-default-wake-"));
  const common = { profilePath, mode: "wake", hostSessionId: "session-one", cwd, execution: { command: process.execPath, args: [(process.env.CSWARM_TEST_CLI ?? resolve("dist/cli.js"))] } };
  await assert.rejects(configureAgentReceive({ ...common, provider: "instructions" }), { code: "wake_host_unsupported" });
  await assert.rejects(configureAgentReceive({ ...common, provider: "codex" }), { code: "codex_thread_id_required" });
  const codexThread = "11111111-2222-4333-8444-555555555555";
  // Unbound profile must be refused for Codex wake even with a valid UUID.
  await assert.rejects(configureAgentReceive({ ...common, hostSessionId: codexThread, provider: "codex" }), { code: "profile_not_host_bound" });
  const boundCodexProfile = join(await mkdtemp(join(root, "codex-bound-profile-")), "profile.json");
  await saveAgentProfile(boundCodexProfile, parseAgentConnection(JSON.stringify(connection())), "TestWS", codexThread);
  const codex = await configureAgentReceive({ ...common, profilePath: boundCodexProfile, hostSessionId: codexThread, provider: "codex" });
  assert.equal(codex.wake_route, "codex-queue");
  assert.equal(codex.wake_verified, false);
  assert.match(String(codex.host_step), /cswarm receive serve/);
  const claude = await configureAgentReceive({ ...common, provider: "claude" });
  assert.equal(claude.wake_route, "channel");
  assert.match(String(claude.start_command), /--dangerously-load-development-channels server:cswarm/u);
  assert.match(String(claude.host_step), /approve the channel/u);
  await assert.rejects(configureAgentReceive({ ...common, provider: "codex", mode: "turn", grokBotAgentId: AGENT }), { code: "grok_bot_agent_id_unsupported" });
  assert.equal(receiveStatus(null).wake_verified, false);
  assert.equal(receiveStatus(null).wake_route, "none");
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
    const conflict = await cli(["feed", "--profile", profile, "--url", "https://api.commonswarm.com"]);
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
    assert.equal(count, 5, "presence, directory, inbox, observation and the seen mark all carry the current session proof");
    assert.equal(fake.requests.filter(r => (r.command as { kind?: string } | undefined)?.kind === "touch_presence").length, 1);
    assert.equal(fake.requests.filter(r => (r.command as { kind?: string } | undefined)?.kind === "ack_agent_delivery").length, 1);
    assert.equal(fake.requests.filter(r => (r.command as { kind?: string } | undefined)?.kind === "add_reaction").length, 1);
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

function runHookCli(args: string[], stdinPayload: unknown): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [process.env.CSWARM_TEST_CLI ?? resolve("dist/cli.js"), ...args], {
      env: { ...process.env, HOME: root },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += String(chunk); });
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", code => done({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(JSON.stringify(stdinPayload));
  });
}

test("C1c: turn-mode Stop hook drains undelivered messages for Claude Code, Codex, and Gemini without looping", { timeout: 25_000 }, async () => {
  // Pure output formatter contract check across all three hosts.
  assert.equal(formatTurnHookOutput({ provider: "claude", stopDrain: true, eventName: "Stop", text: "msg\n" }), '{"decision":"block","reason":"msg"}\n');
  assert.equal(formatTurnHookOutput({ provider: "codex", stopDrain: true, eventName: "Stop", text: "msg\n" }), '{"decision":"block","reason":"msg"}\n');
  assert.equal(formatTurnHookOutput({ provider: "gemini", stopDrain: true, eventName: "AfterAgent", text: "msg\n" }), '{"decision":"deny","reason":"msg","continue":true}\n');
  assert.equal(formatTurnHookOutput({ provider: "gemini", stopDrain: false, eventName: "BeforeAgent", text: "msg\n" }), '{"hookSpecificOutput":{"hookEventName":"BeforeAgent","additionalContext":"msg"}}\n');
  assert.equal(formatTurnHookOutput({ provider: "gemini", stopDrain: true, eventName: "AfterAgent", text: "" }), "");

  let liveRows: SignalRecord[] = [];
  let failServer = false;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", data => raw += data);
    req.on("end", () => {
      if (failServer) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "temporarily_unavailable" }));
        return;
      }
      const fake = fixture(liveRows);
      void (async () => {
        const response = await fake.fetcher("http://fixture", { body: raw, headers: req.headers as Record<string, string>, redirect: "error" });
        res.writeHead(response.status, { "content-type": "application/json" });
        res.end(await response.text());
      })().catch(() => res.writeHead(500).end());
    });
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const execution = { command: process.execPath, args: [process.env.CSWARM_TEST_CLI ?? resolve("dist/cli.js")] };

    for (const hostCase of [
      { provider: "claude" as const, startEvent: "UserPromptSubmit", stopEvent: "Stop", hookRel: [".claude", "settings.local.json"] },
      { provider: "codex" as const, startEvent: "UserPromptSubmit", stopEvent: "Stop", hookRel: [".codex", "hooks.json"] },
      { provider: "gemini" as const, startEvent: "BeforeAgent", stopEvent: "AfterAgent", hookRel: [".gemini", "settings.json"] },
    ]) {
      liveRows = [];
      failServer = false;
      const input = await saveInput(connection(url));
      const profilePath = join(dirname(input), `agent-${hostCase.provider}`, "profile.json");
      const sessionId = `c1c-${hostCase.provider}-session`;
      await setupAgent({ hostSessionId: sessionId, connectionFile: input, profilePath, fetcher: fixture([]).fetcher });
      const cwd = await realpath(await mkdtemp(join(root, `c1c-${hostCase.provider}-`)));
      if (hostCase.provider === "gemini") {
        await assert.rejects(
          configureAgentReceive({ profilePath, mode: "wake", provider: "gemini", hostSessionId: sessionId, cwd, execution }),
          { code: "wake_host_unsupported" },
        );
      }
      const configured = await configureAgentReceive({ profilePath, mode: "turn", provider: hostCase.provider, hostSessionId: sessionId, cwd, execution });
      assert.equal(configured.hook_file, join(cwd, ...hostCase.hookRel));
      const hookJson = JSON.parse(await readFile(configured.hook_file!, "utf8")) as { hooks: Record<string, unknown[]> };
      assert.ok(Array.isArray(hookJson.hooks[hostCase.startEvent]), `${hostCase.provider} installs ${hostCase.startEvent}`);
      assert.ok(Array.isArray(hookJson.hooks[hostCase.stopEvent]), `${hostCase.provider} installs ${hostCase.stopEvent}`);

      // 1. Start of turn: no messages yet -> empty stdout.
      const startRun = await runHookCli(["check", "--profile", profilePath, "--hook", "--host-session-id", sessionId], {
        session_id: sessionId, cwd, hook_event_name: hostCase.startEvent,
      });
      assert.equal(startRun.code, 0, startRun.stderr);
      assert.equal(startRun.stdout, "");

      // 2. Message arrives mid-turn; Stop/AfterAgent drains it with host-specific continuation JSON.
      liveRows = [row(1, `arrived during ${hostCase.provider} turn`)];
      const stopDrain = await runHookCli(["check", "--profile", profilePath, "--hook", "--host-session-id", sessionId], {
        session_id: sessionId, cwd, hook_event_name: hostCase.stopEvent, stop_hook_active: false,
      });
      assert.equal(stopDrain.code, 0, stopDrain.stderr);
      const parsed = JSON.parse(stopDrain.stdout) as { decision: string; reason: string; continue?: boolean };
      assert.equal(parsed.decision, hostCase.provider === "gemini" ? "deny" : "block");
      if (hostCase.provider === "gemini") assert.equal(parsed.continue, true);
      assert.match(parsed.reason, new RegExp(`arrived during ${hostCase.provider} turn`));
      assert.equal((await readReceiveBinding(profilePath, sessionId))!.stop_drains_in_turn, 1);

      // 3. Follow-up Stop with stop_hook_active=true does not loop even if another message arrives.
      liveRows = [row(1, `arrived during ${hostCase.provider} turn`), row(2, "second message")];
      const stopActive = await runHookCli(["check", "--profile", profilePath, "--hook", "--host-session-id", sessionId], {
        session_id: sessionId, cwd, hook_event_name: hostCase.stopEvent, stop_hook_active: true,
      });
      assert.equal(stopActive.code, 0);
      assert.equal(stopActive.stdout, "");

      // 4. Next turn start delivers message 2 (not message 1) in host-appropriate format.
      const nextStart = await runHookCli(["check", "--profile", profilePath, "--hook", "--host-session-id", sessionId], {
        session_id: sessionId, cwd, hook_event_name: hostCase.startEvent,
      });
      assert.equal(nextStart.code, 0);
      if (hostCase.provider === "gemini") {
        const geminiStart = JSON.parse(nextStart.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
        assert.equal(geminiStart.hookSpecificOutput.hookEventName, "BeforeAgent");
        assert.match(geminiStart.hookSpecificOutput.additionalContext, /second message/);
        assert.equal(geminiStart.hookSpecificOutput.additionalContext.includes(`arrived during ${hostCase.provider} turn`), false);
      } else {
        assert.match(nextStart.stdout, /second message/);
        assert.equal(nextStart.stdout.includes(`arrived during ${hostCase.provider} turn`), false);
      }

      // 5. Stop with no new messages emits nothing and allows stop cleanly.
      const emptyStop = await runHookCli(["check", "--profile", profilePath, "--hook", "--host-session-id", sessionId], {
        session_id: sessionId, cwd, hook_event_name: hostCase.stopEvent,
      });
      assert.equal(emptyStop.code, 0);
      assert.equal(emptyStop.stdout, "");

      // 6. Coordination outage during Stop exits 0 with empty stdout (never blocks stop or corrupts JSON).
      failServer = true;
      const outageStop = await runHookCli(["check", "--profile", profilePath, "--hook", "--host-session-id", sessionId], {
        session_id: sessionId, cwd, hook_event_name: hostCase.stopEvent,
      });
      assert.equal(outageStop.code, 0);
      assert.equal(outageStop.stdout, "");
    }
  } finally {
    await new Promise<void>(done => server.close(() => done()));
  }
});
