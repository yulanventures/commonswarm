/** T3 ask-chain and ask-rate behavior against the served edge and real Postgres. */
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import postgres from "postgres";
import {
  ASK_PAIR_PER_10_MINUTES,
  ASK_SENDER_PER_MINUTE,
  CHAIN_MAX_CHILDREN,
  CHAIN_MAX_HOPS,
} from "../../src/cloud/ask-chain-constants.js";
import { awaitFunctionRunning } from "../support/edge-readiness.js";

interface LocalEnvironment {
  API_URL: string;
  ANON_KEY: string;
  DB_URL: string;
  SERVICE_ROLE_KEY: string;
}

interface Seat {
  principal: string;
  token: string;
  secondToken?: string;
}

interface Fixture {
  workspace: string;
  otherWorkspace: string;
  ownerId: string;
  ownerJwt: string;
  otherOwnerId: string;
  userRecipientId: string;
  seats: Seat[];
}

let local: LocalEnvironment;
let sql: postgres.Sql;
let admin: SupabaseClient;
let fixture: Fixture;
let functionProcess: ReturnType<typeof spawn>;
let functionLogs = "";
let envDir: string | undefined;
let proofChain: { root: string; hop1: string; hop2: string } | undefined;

const PARENT_MESSAGE =
  "That parent ask is not available for this follow-up, so this ask was not sent. You can still reply to the ask you received.";
const LOOP_MESSAGE =
  "This ask would go back to an agent that is already part of this request chain, so it was not sent. You can still reply to the ask you received.";

function localEnvironment(): LocalEnvironment {
  const parsed = JSON.parse(execFileSync("supabase", ["status", "-o", "json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  })) as Partial<LocalEnvironment>;
  assert.ok(parsed.API_URL && parsed.ANON_KEY && parsed.DB_URL && parsed.SERVICE_ROLE_KEY);
  return parsed as LocalEnvironment;
}

async function createUser(label: string): Promise<{ id: string; jwt: string }> {
  const email = `${label}-${randomUUID()}@example.test`;
  const password = `T-${randomBytes(24).toString("base64url")}!`;
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  assert.ifError(created.error);
  assert.ok(created.data.user);
  const client = createClient(local.API_URL, local.SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const signedIn = await client.auth.signInWithPassword({ email, password });
  assert.ifError(signedIn.error);
  assert.ok(signedIn.data.session?.access_token);
  return { id: created.data.user.id, jwt: signedIn.data.session.access_token };
}

async function command(
  bearer: string,
  commandBody: Record<string, unknown>,
  options: { commandId?: string; workspace?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${local.API_URL}/functions/v1/command`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify({
      command_id: options.commandId ?? randomUUID(),
      client_version: "0.1.0",
      workspace_id: options.workspace ?? fixture.workspace,
      stream: { kind: "workspace" },
      command: commandBody,
    }),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

function ask(
  recipient: string | null,
  options: { parent?: string; to?: Array<{ kind: "user" | "agent"; id: string }>; body?: string } = {},
): Record<string, unknown> {
  return {
    kind: "post_signal",
    signal_kind: "ask",
    body: options.body ?? `ask-chain-${randomUUID()}`,
    to_user_id: null,
    to_agent_principal_id: options.to === undefined ? recipient : null,
    in_reply_to: null,
    about: null,
    ...(options.parent === undefined ? {} : { parent_signal_id: options.parent }),
    ...(options.to === undefined ? {} : { to: options.to }),
  };
}

function note(recipient: string | null = null, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "post_signal",
    signal_kind: "note",
    body: `ask-chain-note-${randomUUID()}`,
    to_user_id: null,
    to_agent_principal_id: recipient,
    in_reply_to: null,
    about: null,
    ...extra,
  };
}

function signal(body: Record<string, unknown>): Record<string, unknown> {
  const value = body.signal as Record<string, unknown> | undefined;
  assert.ok(value, JSON.stringify(body));
  return value;
}

async function sendAsk(
  sender: Seat,
  recipient: string | null,
  options: Parameters<typeof ask>[1] = {},
): Promise<{ result: Awaited<ReturnType<typeof command>>; id?: string }> {
  const result = await command(sender.token, ask(recipient, options));
  const id = result.status === 200 ? String(signal(result.body).id) : undefined;
  return { result, id };
}

async function clearAskRates(): Promise<void> {
  await sql`DELETE FROM swarm.rate_buckets WHERE bucket_key LIKE 'ask:%'`;
}

async function row(id: string) {
  const [value] = await sql<{
    id: string;
    parent_signal_id: string | null;
    chain_root_id: string | null;
    chain_hop: number | null;
    chain_participants: string[] | null;
  }[]>`
    SELECT id, parent_signal_id, chain_root_id, chain_hop, chain_participants
    FROM swarm.signals WHERE id = ${id}::uuid
  `;
  assert.ok(value);
  return value;
}

async function counts(): Promise<{ signals: number; recipients: number; deliveries: number }> {
  const [value] = await sql<{ signals: number; recipients: number; deliveries: number }[]>`
    SELECT
      (SELECT count(*)::int FROM swarm.signals WHERE workspace_id = ${fixture.workspace}::uuid) AS signals,
      (SELECT count(*)::int FROM swarm.signal_recipients WHERE workspace_id = ${fixture.workspace}::uuid) AS recipients,
      (SELECT count(*)::int FROM swarm.signal_deliveries WHERE workspace_id = ${fixture.workspace}::uuid) AS deliveries
  `;
  return value!;
}

async function expectNoSignal(
  run: () => Promise<{ status: number; body: Record<string, unknown> }>,
  code: string,
  message: string,
): Promise<void> {
  const beforeCounts = await counts();
  const result = await run();
  assert.equal(result.status, code === "rate_limited" ? 429 : 409, JSON.stringify(result.body));
  assert.equal(result.body.error, code);
  assert.equal(result.body.message, message);
  assert.deepEqual(await counts(), beforeCounts, `${code} must write no signal, recipient, or delivery row`);
}

async function readSignals(bearer: string) {
  const response = await fetch(`${local.API_URL}/functions/v1/read`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify({
      resource: "signals",
      workspace_id: fixture.workspace,
      inbox: true,
      about: null,
      kind: "ask",
      since: null,
      in_reply_to: null,
      limit: 100,
      include_stale: false,
    }),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

before(async () => {
  local = localEnvironment();
  sql = postgres(local.DB_URL, { prepare: false, max: 5 });
  admin = createClient(local.API_URL, local.SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const owner = await createUser("ask-chain-owner");
  const other = await createUser("ask-chain-other");
  const recipientUser = await createUser("ask-chain-recipient");
  const workspace = randomUUID();
  const otherWorkspace = randomUUID();
  const device = randomUUID();
  const otherDevice = randomUUID();
  const seats: Seat[] = Array.from({ length: 12 }, () => ({
    principal: randomUUID(),
    token: `swm_agt_${randomBytes(32).toString("base64url")}`,
  }));
  seats[0]!.secondToken = `swm_agt_${randomBytes(32).toString("base64url")}`;

  await sql.begin(async (tx) => {
    await tx`INSERT INTO swarm.users (user_id, display_name) VALUES
      (${owner.id}::uuid, 'Ask chain owner'),
      (${other.id}::uuid, 'Ask chain other'),
      (${recipientUser.id}::uuid, 'Ask chain recipient')`;
    await tx`INSERT INTO swarm.devices (device_id, user_id, label) VALUES
      (${device}::uuid, ${owner.id}::uuid, 'ask-chain-device'),
      (${otherDevice}::uuid, ${other.id}::uuid, 'ask-chain-other-device')`;
    await tx`INSERT INTO swarm.workspaces (workspace_id, name, created_by) VALUES
      (${workspace}::uuid, 'Ask chain workspace', ${owner.id}::uuid),
      (${otherWorkspace}::uuid, 'Ask chain other workspace', ${other.id}::uuid)`;
    await tx`INSERT INTO swarm.memberships (workspace_id, user_id, role) VALUES
      (${workspace}::uuid, ${owner.id}::uuid, 'owner'),
      (${workspace}::uuid, ${recipientUser.id}::uuid, 'member'),
      (${otherWorkspace}::uuid, ${other.id}::uuid, 'owner')`;
    await tx`INSERT INTO swarm.streams (stream_id, workspace_id, kind) VALUES
      (${randomUUID()}::uuid, ${workspace}::uuid, 'workspace'),
      (${randomUUID()}::uuid, ${otherWorkspace}::uuid, 'workspace')`;
    for (const [index, seat] of seats.entries()) {
      await tx`INSERT INTO swarm.agent_principals
        (principal_id, workspace_id, owner_user_id, name)
        VALUES (${seat.principal}::uuid, ${workspace}::uuid, ${owner.id}::uuid, ${`chain-seat-${index}`})`;
      for (const token of [seat.token, ...(seat.secondToken ? [seat.secondToken] : [])]) {
        const run = randomUUID();
        await tx`INSERT INTO swarm.agent_runs (run_id, principal_id, device_id)
          VALUES (${run}::uuid, ${seat.principal}::uuid, ${device}::uuid)`;
        await tx`INSERT INTO swarm.agent_tokens
          (token_id, principal_id, run_id, scopes, token_hash, expires_at, lineage_id)
          VALUES (${randomUUID()}::uuid, ${seat.principal}::uuid, ${run}::uuid,
            ${tx.json(["post_signal"])}::jsonb,
            ${createHash("sha256").update(token).digest()},
            statement_timestamp() + interval '1 hour', ${randomUUID()}::uuid)`;
      }
    }
  });
  fixture = {
    workspace,
    otherWorkspace,
    ownerId: owner.id,
    ownerJwt: owner.jwt,
    otherOwnerId: other.id,
    userRecipientId: recipientUser.id,
    seats,
  };

  envDir = mkdtempSync(join(tmpdir(), "cswarm-ask-chain-edge-"));
  const envFile = join(envDir, "test.env");
  writeFileSync(envFile, "SWARM_ENV=test\n", { mode: 0o600 });
  functionProcess = spawn(
    "supabase",
    ["functions", "serve", "--no-verify-jwt", "--env-file", envFile],
    { cwd: process.cwd(), env: { ...process.env, SWARM_ENV: "test" }, stdio: ["ignore", "pipe", "pipe"] },
  );
  const capture = (chunk: Buffer) => {
    functionLogs = (functionLogs + chunk.toString("utf8")).slice(-30_000);
  };
  functionProcess.stdout?.on("data", capture);
  functionProcess.stderr?.on("data", capture);
  const bootDeadline = Date.now() + 60_000;
  while (!functionLogs.includes("Serving functions on")) {
    if (Date.now() > bootDeadline) throw new Error(`functions serve never booted:\n${functionLogs.slice(-4000)}`);
    await delay(250);
  }
  await awaitFunctionRunning({
    url: `${local.API_URL}/functions/v1/command`, fetcher: fetch, timeoutMs: 30_000,
    sleep: (ms) => delay(ms), now: () => Date.now(),
    diagnostics: () => `command function logs:\n${functionLogs.slice(-5000)}`,
  });
});

after(async () => {
  if (functionProcess && functionProcess.exitCode === null) {
    const exited = new Promise<boolean>((resolve) => functionProcess.once("close", () => resolve(true)));
    functionProcess.kill();
    if (!await Promise.race([exited, delay(2_000).then(() => false)]) && functionProcess.exitCode === null) {
      functionProcess.kill("SIGKILL");
    }
  }
  await sql?.end({ timeout: 5 });
  if (envDir) rmSync(envDir, { recursive: true, force: true });
});

test("old clients post root asks and a two-hop chain stores deduplicated participants", async () => {
  await clearAskRates();
  const [a, b, c, d] = fixture.seats;
  const rootPost = await sendAsk(a!, b!.principal);
  assert.equal(rootPost.result.status, 200, JSON.stringify(rootPost.result.body));
  assert.equal(signal(rootPost.result.body).chain_hop, 0);
  const root = await row(rootPost.id!);
  assert.equal(root.parent_signal_id, null);
  assert.equal(root.chain_root_id, root.id);
  assert.equal(root.chain_hop, 0);
  assert.deepEqual(new Set(root.chain_participants), new Set([a!.principal, b!.principal]));

  const first = await sendAsk(b!, c!.principal, { parent: root.id });
  assert.equal(first.result.status, 200, JSON.stringify(first.result.body));
  const second = await sendAsk(c!, d!.principal, { parent: first.id! });
  assert.equal(second.result.status, 200, JSON.stringify(second.result.body));
  const firstRow = await row(first.id!);
  const secondRow = await row(second.id!);
  assert.equal(firstRow.chain_root_id, root.id);
  assert.equal(firstRow.chain_hop, 1);
  assert.equal(secondRow.chain_root_id, root.id);
  assert.equal(secondRow.chain_hop, 2);
  assert.deepEqual(new Set(secondRow.chain_participants),
    new Set([a!.principal, b!.principal, c!.principal, d!.principal]));
  assert.equal(secondRow.chain_participants?.length, 4, "the caller is re-added without duplication");
  proofChain = { root: root.id, hop1: first.id!, hop2: second.id! };
});

test("loop backs to the root sender or caller write no signal, recipient, or delivery rows", async () => {
  await clearAskRates();
  const [a, b] = fixture.seats;
  const root = await sendAsk(a!, b!.principal);
  assert.equal(root.result.status, 200);
  await expectNoSignal(
    async () => (await sendAsk(b!, a!.principal, { parent: root.id! })).result,
    "chain_loop", LOOP_MESSAGE,
  );
  await expectNoSignal(
    async () => (await sendAsk(b!, b!.principal, { parent: root.id! })).result,
    "chain_loop", LOOP_MESSAGE,
  );
});

test("hop five is refused, and a loop wins when both loop and hop rules fail", async () => {
  await clearAskRates();
  const seats = fixture.seats.slice(0, 7);
  let parent = (await sendAsk(seats[0]!, seats[1]!.principal)).id!;
  for (let hop = 1; hop <= CHAIN_MAX_HOPS; hop++) {
    const child = await sendAsk(seats[hop]!, seats[hop + 1]!.principal, { parent });
    assert.equal(child.result.status, 200, `hop ${hop}: ${JSON.stringify(child.result.body)}`);
    assert.equal(signal(child.result.body).chain_hop, hop);
    parent = child.id!;
  }
  await expectNoSignal(
    async () => (await sendAsk(seats[5]!, seats[6]!.principal, { parent })).result,
    "chain_too_long",
    `This request chain already has ${CHAIN_MAX_HOPS} hops, so this ask was not sent. You can still reply to the ask you received.`,
  );
  await expectNoSignal(
    async () => (await sendAsk(seats[5]!, seats[0]!.principal, { parent })).result,
    "chain_loop", LOOP_MESSAGE,
  );
});

test("every invalid-parent reason has one response and writes no signal graph rows", async () => {
  await clearAskRates();
  const [a, b, c, d] = fixture.seats;
  const addressed = await sendAsk(a!, b!.principal);
  assert.equal(addressed.result.status, 200);
  const unaddressed = await sendAsk(a!, a!.principal);
  assert.equal(unaddressed.result.status, 200);
  const noteParent = await command(a!.token, note(b!.principal));
  assert.equal(noteParent.status, 200);
  const noteId = String(signal(noteParent.body).id);

  const expired = randomUUID();
  await sql`
    INSERT INTO swarm.signals (
      id, workspace_id, from_principal, from_kind, to_agent_principal_id,
      about, kind, body, until, created_at
    ) VALUES (
      ${expired}::uuid, ${fixture.workspace}::uuid, ${a!.principal}::uuid, 'agent',
      ${b!.principal}::uuid, NULL, 'ask', 'expired legacy parent',
      statement_timestamp() - interval '1 hour', statement_timestamp() - interval '2 hours'
    )
  `;
  const otherParent = randomUUID();
  await sql`
    INSERT INTO swarm.signals (
      id, workspace_id, from_principal, from_kind, about, kind, body, until, created_at
    ) VALUES (
      ${otherParent}::uuid, ${fixture.otherWorkspace}::uuid, ${fixture.otherOwnerId}::uuid,
      'user', NULL, 'ask', 'other workspace parent',
      statement_timestamp() + interval '1 hour', statement_timestamp()
    )
  `;

  const cases: Array<() => Promise<{ status: number; body: Record<string, unknown> }>> = [
    async () => (await sendAsk(c!, d!.principal, { parent: unaddressed.id! })).result,
    async () => (await sendAsk(b!, c!.principal, { parent: expired })).result,
    async () => (await sendAsk(b!, c!.principal, { parent: otherParent })).result,
    async () => (await sendAsk(b!, c!.principal, { parent: noteId })).result,
    async () => command(fixture.ownerJwt, ask(c!.principal, { parent: addressed.id! })),
    async () => command(b!.token, ask(null, { parent: addressed.id!, to: [
      { kind: "agent", id: c!.principal }, { kind: "agent", id: d!.principal },
    ] })),
    async () => command(b!.token, ask(null, { parent: addressed.id!, to: [
      { kind: "user", id: fixture.userRecipientId },
    ] })),
  ];
  const messages = new Set<string>();
  for (const run of cases) {
    const beforeCounts = await counts();
    const result = await run();
    assert.equal(result.status, 409, JSON.stringify(result.body));
    assert.equal(result.body.error, "chain_parent_invalid");
    messages.add(String(result.body.message));
    assert.deepEqual(await counts(), beforeCounts);
  }
  assert.deepEqual([...messages], [PARENT_MESSAGE]);
});

test("client chain columns are unknown and replies keep every chain column null", async () => {
  const [a, b] = fixture.seats;
  for (const key of ["chain_root_id", "chain_hop", "chain_participants"]) {
    const result = await command(a!.token, { ...ask(b!.principal), [key]: key === "chain_hop" ? 0 : randomUUID() });
    assert.equal(result.status, 400, key);
  }
  const parentOnNote = await command(a!.token, { ...note(b!.principal), parent_signal_id: randomUUID() });
  assert.equal(parentOnNote.status, 400);
  const parentOnWorking = await command(a!.token, {
    kind: "post_signal", signal_kind: "working-on", body: "working without a chain",
    to_user_id: null, to_agent_principal_id: null, in_reply_to: null, about: null,
    parent_signal_id: randomUUID(),
  });
  assert.equal(parentOnWorking.status, 400);
  const working = await command(a!.token, {
    kind: "post_signal", signal_kind: "working-on", body: "working without a chain",
    to_user_id: null, to_agent_principal_id: null, in_reply_to: null, about: null,
  });
  assert.equal(working.status, 200);

  const original = await command(a!.token, note(b!.principal));
  assert.equal(original.status, 200);
  const parentOnPrivateReply = await command(b!.token, note(null, {
    in_reply_to: String(signal(original.body).id), parent_signal_id: String(signal(original.body).id),
  }));
  assert.equal(parentOnPrivateReply.status, 400);
  const privateReply = await command(b!.token, note(null, {
    in_reply_to: String(signal(original.body).id),
  }));
  assert.equal(privateReply.status, 200, JSON.stringify(privateReply.body));

  const threadRoot = await command(fixture.ownerJwt, note());
  assert.equal(threadRoot.status, 200);
  const parentOnThreadReply = await command(a!.token, {
    ...ask(null), thread_root_id: String(signal(threadRoot.body).id),
    parent_signal_id: String(signal(threadRoot.body).id),
  });
  assert.equal(parentOnThreadReply.status, 400);
  const threadReply = await command(a!.token, {
    ...ask(null), thread_root_id: String(signal(threadRoot.body).id),
  });
  assert.equal(threadReply.status, 200, JSON.stringify(threadReply.body));
  for (const id of [
    String(signal(working.body).id),
    String(signal(privateReply.body).id),
    String(signal(threadReply.body).id),
  ]) {
    const [stored] = await sql<{
      parent_signal_id: string | null; chain_root_id: string | null;
      chain_hop: number | null; chain_participants: string[] | null;
    }[]>`SELECT parent_signal_id, chain_root_id, chain_hop, chain_participants
      FROM swarm.signals WHERE id = ${id}::uuid`;
    assert.deepEqual(stored, {
      parent_signal_id: null, chain_root_id: null, chain_hop: null, chain_participants: null,
    });
  }
});

test("a legacy parent is a root and idempotency binds the declared parent", async () => {
  await clearAskRates();
  const [a, b, c, d] = fixture.seats;
  const legacy = randomUUID();
  await sql`
    INSERT INTO swarm.signals (
      id, workspace_id, from_principal, from_kind, to_agent_principal_id,
      about, kind, body, until, created_at
    ) VALUES (
      ${legacy}::uuid, ${fixture.workspace}::uuid, ${a!.principal}::uuid, 'agent',
      ${b!.principal}::uuid, NULL, 'ask', 'legacy live parent',
      statement_timestamp() + interval '1 hour', statement_timestamp()
    )
  `;
  const child = await sendAsk(b!, c!.principal, { parent: legacy });
  assert.equal(child.result.status, 200, JSON.stringify(child.result.body));
  const stored = await row(child.id!);
  assert.equal(stored.chain_root_id, legacy);
  assert.equal(stored.chain_hop, 1);
  assert.deepEqual(new Set(stored.chain_participants),
    new Set([a!.principal, b!.principal, c!.principal]));

  const secondParent = await sendAsk(a!, b!.principal);
  assert.equal(secondParent.result.status, 200);
  const commandId = randomUUID();
  const first = await command(b!.token, ask(d!.principal, { parent: legacy }), { commandId });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const changed = await command(b!.token, ask(d!.principal, {
    parent: secondParent.id!, body: (first.body.signal as Record<string, unknown>).body as string,
  }), { commandId });
  assert.deepEqual(changed, { status: 409, body: { error: "command_id_conflict" } });
});

test("the fourth child is too wide and simultaneous children cannot exceed the cap", async () => {
  await clearAskRates();
  const [a, b, c, d, e, f, g] = fixture.seats;
  const parent = await sendAsk(a!, b!.principal);
  assert.equal(parent.result.status, 200);
  for (const recipient of [c!, d!, e!]) {
    const child = await sendAsk(b!, recipient.principal, { parent: parent.id! });
    assert.equal(child.result.status, 200, JSON.stringify(child.result.body));
  }
  await expectNoSignal(
    async () => (await sendAsk(b!, f!.principal, { parent: parent.id! })).result,
    "chain_too_wide",
    `This ask already has ${CHAIN_MAX_CHILDREN} follow-up asks, so this one was not sent. You can still reply to the ask you received.`,
  );

  const concurrentParent = await sendAsk(a!, b!.principal);
  assert.equal(concurrentParent.result.status, 200);
  assert.ok(concurrentParent.id);
  const concurrentParentId = concurrentParent.id;
  const attempts = await Promise.all([c!, d!, e!, f!, g!].map((recipient) =>
    sendAsk(b!, recipient.principal, { parent: concurrentParentId })));
  assert.equal(attempts.filter((attempt) => attempt.result.status === 200).length, CHAIN_MAX_CHILDREN);
  assert.equal(attempts.filter((attempt) => attempt.result.body.error === "chain_too_wide").length, 2);
  const [count] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM swarm.signals
    WHERE parent_signal_id = ${concurrentParentId}::uuid`;
  assert.equal(count?.count, CHAIN_MAX_CHILDREN);
});

test("sender and pair limits are principal-scoped and fixed windows reset", async () => {
  const [a, b] = fixture.seats;
  assert.ok(a!.secondToken);
  await clearAskRates();
  for (let index = 0; index < ASK_SENDER_PER_MINUTE; index++) {
    const bearer = index % 2 === 0 ? a!.token : a!.secondToken!;
    const posted = await command(bearer, ask(null));
    assert.equal(posted.status, 200, `sender ${index}: ${JSON.stringify(posted.body)}`);
  }
  const beforeSender = await counts();
  const senderLimited = await command(a!.secondToken!, ask(null));
  assert.equal(senderLimited.status, 429);
  assert.equal(senderLimited.body.error, "rate_limited");
  assert.equal(senderLimited.body.limit, ASK_SENDER_PER_MINUTE);
  assert.deepEqual(await counts(), beforeSender);
  await sql`UPDATE swarm.rate_buckets SET window_start = window_start - interval '1 minute'
    WHERE bucket_key = ${`ask:sender:${fixture.workspace}:${a!.principal}`}`;
  assert.equal((await command(a!.token, ask(null))).status, 200, "next fixed minute accepts");

  await clearAskRates();
  for (let index = 0; index < ASK_PAIR_PER_10_MINUTES; index++) {
    const bearer = index % 2 === 0 ? a!.token : a!.secondToken!;
    const posted = await command(bearer, ask(b!.principal));
    assert.equal(posted.status, 200, `pair ${index}: ${JSON.stringify(posted.body)}`);
  }
  const beforePair = await counts();
  // UUID spelling cannot split one recipient principal across pair buckets.
  const pairLimited = await command(a!.secondToken!, ask(b!.principal.toUpperCase()));
  assert.equal(pairLimited.status, 429);
  assert.equal(pairLimited.body.error, "rate_limited");
  assert.equal(pairLimited.body.limit, ASK_PAIR_PER_10_MINUTES);
  assert.deepEqual(await counts(), beforePair);
  await sql`UPDATE swarm.rate_buckets SET window_start = window_start - interval '10 minutes'
    WHERE bucket_key LIKE 'ask:%'`;
  assert.equal((await command(a!.token, ask(b!.principal))).status, 200,
    "next fixed ten-minute window accepts");
});

test("a root ask charges every agent recipient pair at positions 1 through 8", async () => {
  await clearAskRates();
  const sender = fixture.seats[0]!;
  const recipients = fixture.seats.slice(1, 9).map((seat) => ({ kind: "agent" as const, id: seat.principal }));
  const posted = await command(sender.token, ask(null, { to: recipients }));
  assert.equal(posted.status, 200, JSON.stringify(posted.body));
  const id = String(signal(posted.body).id);
  const [buckets] = await sql<{ count: number; total: number }[]>`
    SELECT count(*)::int AS count, sum(count)::int AS total
    FROM swarm.rate_buckets
    WHERE bucket_key LIKE ${`ask:pair:${fixture.workspace}:${sender.principal}:%`}
  `;
  assert.deepEqual(buckets, { count: 8, total: 8 });
  const [deliveryCount] = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM swarm.signal_deliveries WHERE signal_id = ${id}::uuid
  `;
  assert.equal(deliveryCount?.count, 8);
});

test("recipient reads only chain_hop and another workspace reads nothing", async () => {
  assert.ok(proofChain);
  const inbox = await readSignals(fixture.seats[1]!.token);
  assert.equal(inbox.status, 200, JSON.stringify(inbox.body));
  const visible = (inbox.body.signals as Array<Record<string, unknown>>)
    .find((candidate) => candidate.id === proofChain!.root);
  assert.ok(visible);
  assert.equal(visible.chain_hop, 0);
  for (const hidden of ["parent_signal_id", "chain_root_id", "chain_participants"]) {
    assert.equal(Object.hasOwn(visible, hidden), false, hidden);
  }
  const cross = await sql.begin(async (tx) => {
    await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: fixture.otherOwnerId, role: "authenticated" })}, true)`;
    await tx.unsafe("SET LOCAL ROLE authenticated");
    return await tx<{ count: number }[]>`SELECT count(*)::int AS count FROM swarm_read.signals
      WHERE workspace_id = ${fixture.workspace}::uuid
        AND id = ${proofChain!.root}::uuid`;
  });
  assert.equal(cross[0]?.count, 0);
});

test("the functional proof runs with the production psql shape after edge seeding", async () => {
  assert.ok(proofChain);
  const proof = readFileSync(fileURLToPath(new URL(
    "../../deploy/release-proofs/item-t3/20260927000003-functional.sql",
    import.meta.url,
  )), "utf8");
  const containers = execFileSync("docker", ["ps", "--format", "{{.Names}}"], { encoding: "utf8" })
    .trim().split("\n").filter((name) => /^supabase_db_/.test(name));
  assert.equal(containers.length, 1);
  const args = [
    "exec", "-i", containers[0]!, "psql", "-X", "-Atq", "-U", "postgres", "-d", "postgres",
    "-v", "ON_ERROR_STOP=1",
    "-v", `item_t3_workspace_id=${fixture.workspace}`,
    "-v", `item_t3_root_signal_id=${proofChain!.root}`,
    "-v", `item_t3_hop1_signal_id=${proofChain!.hop1}`,
    "-v", `item_t3_hop2_signal_id=${proofChain!.hop2}`,
    "-v", `item_t3_reader_user_id=${fixture.ownerId}`,
    "--file", "-",
  ];
  const run = spawnSync("docker", args, { input: proof, encoding: "utf8", timeout: 10_000 });
  assert.ifError(run.error);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, "t\n");
});
