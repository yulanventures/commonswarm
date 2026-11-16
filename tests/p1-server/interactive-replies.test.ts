/**
 * Interactive replies G1: ask_choice and answer_choice on the command edge, with SWARM_INTERACTIVE_REPLIES on.
 *
 * Reached by `npm run test:p1-server` (globs tests/p1-server/**). Needs the
 * local stack and an exclusive database slot.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import postgres from "postgres";
import { awaitFunctionRunning, observeFunctionCli } from "../support/edge-readiness.js";

interface LocalEnvironment {
  API_URL: string;
  ANON_KEY: string;
  DB_URL: string;
  SERVICE_ROLE_KEY: string;
}

interface Fixture {
  workspaceA: string;
  workspaceB: string;
  ownerId: string;
  ownerJwt: string;
  otherJwt: string;
  principal: string;
  run: string;
  device: string;
  tokenId: string;
  agentToken: string;
}

let local: LocalEnvironment;
let sql: postgres.Sql;
let admin: SupabaseClient;
let functionProcess: ReturnType<typeof spawn>;
let functionLogs = "";
let envDir: string | undefined;
let f: Fixture;

function localEnvironment(): LocalEnvironment {
  const output = execFileSync("supabase", ["status", "-o", "json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const parsed = JSON.parse(output) as Partial<LocalEnvironment>;
  assert.ok(
    parsed.API_URL && parsed.ANON_KEY && parsed.DB_URL &&
      parsed.SERVICE_ROLE_KEY,
  );
  return parsed as LocalEnvironment;
}

async function createUser(
  label: string,
): Promise<{ id: string; jwt: string }> {
  const email = `${label}-${randomUUID()}@example.test`;
  const password = `T-${randomBytes(24).toString("base64url")}!`;
  const created = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
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

async function fixture(): Promise<Fixture> {
  const owner = await createUser("choice-owner");
  const other = await createUser("choice-other");
  const workspaceA = randomUUID();
  const workspaceB = randomUUID();
  const device = randomUUID();
  const principal = randomUUID();
  const run = randomUUID();
  const tokenId = randomUUID();
  const agentToken = `swm_agt_${randomBytes(32).toString("base64url")}`;
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO swarm.users (user_id, display_name)
      VALUES
        (${owner.id}::uuid, 'ChoiceOwner'),
        (${other.id}::uuid, 'ChoiceOther')
    `;
    await tx`
      INSERT INTO swarm.devices (device_id, user_id, label)
      VALUES (${device}::uuid, ${owner.id}::uuid, 'choice-tests')
    `;
    await tx`
      INSERT INTO swarm.workspaces (workspace_id, name, created_by)
      VALUES
        (${workspaceA}::uuid, 'ChoiceA', ${owner.id}::uuid),
        (${workspaceB}::uuid, 'ChoiceB', ${other.id}::uuid)
    `;
    await tx`
      INSERT INTO swarm.memberships (workspace_id, user_id, role)
      VALUES
        (${workspaceA}::uuid, ${owner.id}::uuid, 'owner'),
        (${workspaceB}::uuid, ${other.id}::uuid, 'owner')
    `;
    await tx`
      INSERT INTO swarm.streams (stream_id, workspace_id, kind)
      VALUES
        (${randomUUID()}::uuid, ${workspaceA}::uuid, 'workspace'),
        (${randomUUID()}::uuid, ${workspaceB}::uuid, 'workspace')
    `;
    await tx`
      INSERT INTO swarm.agent_principals (
        principal_id, workspace_id, owner_user_id, name
      ) VALUES (
        ${principal}::uuid, ${workspaceA}::uuid, ${owner.id}::uuid, 'choice-agent'
      )
    `;
    await tx`
      INSERT INTO swarm.agent_runs (run_id, principal_id, device_id)
      VALUES (${run}::uuid, ${principal}::uuid, ${device}::uuid)
    `;
    await tx`
      INSERT INTO swarm.agent_tokens (
        token_id, principal_id, run_id, scopes, token_hash,
        expires_at, lineage_id
      ) VALUES (
        ${tokenId}::uuid, ${principal}::uuid, ${run}::uuid,
        ${tx.json(["create", "acquire", "submit", "post_signal"])}::jsonb,
        ${createHash("sha256").update(agentToken).digest()},
        statement_timestamp() + interval '1 hour', ${randomUUID()}::uuid
      )
    `;
  });
  return {
    workspaceA,
    workspaceB,
    ownerId: owner.id,
    ownerJwt: owner.jwt,
    otherJwt: other.jwt,
    principal,
    run,
    device,
    tokenId,
    agentToken,
  };
}

async function postRead(
  bearer: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${local.API_URL}/functions/v1/read`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      apikey: local.ANON_KEY,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: await response.json() as Record<string, unknown>,
  };
}

async function postCommand(
  bearer: string,
  workspaceId: string,
  command: Record<string, unknown>,
  commandId = randomUUID(),
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${local.API_URL}/functions/v1/command`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      command_id: commandId,
      client_version: "0.1.0",
      workspace_id: workspaceId,
      stream: { kind: "workspace" },
      command,
    }),
  });
  return {
    status: response.status,
    body: await response.json() as Record<string, unknown>,
  };
}

before(async () => {
  local = localEnvironment();
  sql = postgres(local.DB_URL, { prepare: false, max: 5 });
  admin = createClient(local.API_URL, local.SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  envDir = mkdtempSync(join(tmpdir(), "cswarm-choice-env-"));
  const envFile = join(envDir, "test.env");
  writeFileSync(envFile, "SWARM_ENV=test\nSWARM_SELF_SERVE=1\nSWARM_INTERACTIVE_REPLIES=1\n");
  functionProcess = spawn(
    "supabase",
    ["functions", "serve", "--no-verify-jwt", "--env-file", envFile],
    {
      cwd: process.cwd(),
      env: { ...process.env, SWARM_ENV: "test" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const cliState = observeFunctionCli(functionProcess);
  const capture = (chunk: Buffer) => {
    functionLogs = (functionLogs + chunk.toString("utf8")).slice(-20_000);
  };
  functionProcess.stdout?.on("data", capture);
  functionProcess.stderr?.on("data", capture);
  {
    const bootDeadline = Date.now() + 60_000;
    while (!functionLogs.includes("Serving functions on")) {
      if (Date.now() > bootDeadline) {
        throw new Error(
          `functions serve never booted:\n${functionLogs.slice(-3000)}`,
        );
      }
      await delay(250);
    }
  }
  for (const fn of ["command", "read"]) {
    await awaitFunctionRunning({
      url: `${local.API_URL}/functions/v1/${fn}`,
      fetcher: fetch,
      timeoutMs: 30_000,
      sleep: (ms) => delay(ms),
      now: () => Date.now(),
      diagnostics: () => `${fn} function logs:\n${functionLogs.slice(-4000)}`,
      cliState,
    });
  }
  f = await fixture();
});

after(async () => {
  if (functionProcess && functionProcess.exitCode === null) {
    const exited = new Promise<boolean>((resolve) => {
      functionProcess.once("close", () => resolve(true));
    });
    functionProcess.kill("SIGTERM");
    const stopped = await Promise.race([
      exited,
      delay(2_000).then(() => false),
    ]);
    if (!stopped && functionProcess.exitCode === null) {
      functionProcess.kill("SIGKILL");
    }
  }
  await sql?.end({ timeout: 5 });
  if (envDir) rmSync(envDir, { recursive: true, force: true });
});



const OPTIONS = [{ id: "ship", label: "Ship it" }, { id: "wait", label: "Wait for tomorrow" }];

async function askOwner(options: unknown = OPTIONS): Promise<{ status: number; body: Record<string, unknown> }> {
  return await postCommand(f.agentToken, f.workspaceA, {
    kind: "ask_choice", body: "Ship 0.1.93 tonight?", to_user_id: f.ownerId, about: null, options,
  });
}

const answer = (bearer: string, signalId: string, optionId: string, commandId?: ReturnType<typeof randomUUID>) =>
  postCommand(bearer, f.workspaceA, { kind: "answer_choice", signal_id: signalId, option_id: optionId }, commandId);

async function actions(signalId: string): Promise<Array<{ state: string; error_code: string | null; option_id: string }>> {
  const rows = await sql<Array<{ state: string; error_code: string | null; option_id: string }>>`
    SELECT state, error_code, option_id FROM swarm.ui_actions WHERE signal_id = ${signalId}::uuid ORDER BY created_at`;
  return rows.map((row) => ({ ...row }));
}

test("an agent's choice ask stores its options once; the addressed person's click is an ordinary reply", async () => {
  const asked = await askOwner();
  assert.equal(asked.status, 200, JSON.stringify(asked.body) + functionLogs.slice(-2000));
  const askId = (asked.body.signal as { id: string }).id;
  const [stored] = await sql<{ options: unknown }[]>`SELECT options FROM swarm.ask_choices WHERE signal_id = ${askId}::uuid`;
  assert.deepEqual(stored!.options, OPTIONS);
  await assert.rejects(() => sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE swarm_command");
    await tx`UPDATE swarm.ask_choices SET options = '[]'::jsonb WHERE signal_id = ${askId}::uuid`;
  }), /permission denied/, "stored choices never change");

  assert.equal((await answer(f.agentToken, askId, "ship")).status, 403, "an agent credential can't click");
  const outsider = await answer(f.otherJwt, askId, "ship");
  assert.ok(outsider.status === 403 || outsider.status === 404, `a non-member is refused (${outsider.status})`);
  assert.deepEqual(await actions(askId), [], "a refused caller records no attempt");
  const unknown = await answer(f.ownerJwt, askId, "nope");
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.error, "unknown_option");

  const chose = await answer(f.ownerJwt, askId, "ship");
  assert.equal(chose.status, 200, JSON.stringify(chose.body));
  const reply = chose.body.signal as { id: string; body: string; in_reply_to: string | null };
  assert.equal(reply.body, "Selected: Ship it", "the reply text comes from the stored label");
  assert.equal(reply.in_reply_to, askId);
  assert.deepEqual((await actions(askId)).map((a) => [a.state, a.error_code]), [["failed", "unknown_option"], ["completed", null]]);

  const changed = await answer(f.ownerJwt, askId, "wait");
  assert.equal(changed.status, 409, "a different option after answering conflicts");
  assert.equal(changed.body.error, "choice_conflict");
  const again = await answer(f.ownerJwt, askId, "ship");
  assert.equal(again.status, 200, "the same person's retry of the same choice returns their answer");
  assert.equal((again.body.choice_answer as { option_id: string }).option_id, "ship");
  const [replies] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM swarm.signals WHERE in_reply_to = ${askId}::uuid`;
  assert.equal(replies!.n, 1, "one reply, whatever the retries");

  const read = await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE authenticated");
    await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: f.ownerId, role: "authenticated" })}, true)`;
    return (await tx<{ r: { asks: Array<{ answer: { option_id: string; by_viewer: boolean } }> } }[]>`
      SELECT swarm_read.ask_choices(${f.workspaceA}::uuid, ${[askId]}::uuid[]) AS r`)[0]!.r;
  });
  assert.deepEqual({ option: read.asks[0]!.answer.option_id, mine: read.asks[0]!.answer.by_viewer }, { option: "ship", mine: true });
});

test("only the addressed person may answer; attempts are capped; bad asks are refused", async () => {
  const asked = await askOwner();
  const askId = (asked.body.signal as { id: string }).id;
  for (let i = 0; i < 5; i += 1) assert.equal((await answer(f.ownerJwt, askId, "nope")).status, 400);
  const capped = await answer(f.ownerJwt, askId, "ship");
  assert.equal(capped.status, 429);
  assert.equal(capped.body.error, "answer_attempts_exhausted");

  for (const options of [
    [OPTIONS[0]], Array.from({ length: 7 }, (_, i) => ({ id: `o${i}`, label: `Option ${i}` })),
    [OPTIONS[0], OPTIONS[0]], [{ id: "Bad Id", label: "x" }, OPTIONS[1]], [{ id: "a", label: "x".repeat(81) }, OPTIONS[1]],
    [{ id: "a", label: "x", url: "https://example.test" }, OPTIONS[1]],
  ]) {
    assert.equal((await askOwner(options)).status, 400, JSON.stringify(options).slice(0, 80));
  }
});

test("a typed reply first means a later click is too late; after expiry an answer replays and an unanswered ask is closed", async () => {
  const typed = await askOwner();
  const typedId = (typed.body.signal as { id: string }).id;
  const words = await postCommand(f.ownerJwt, f.workspaceA, {
    kind: "post_signal", signal_kind: "note", body: "Let's wait.", to_user_id: null,
    to_agent_principal_id: null, in_reply_to: typedId, about: null,
  });
  assert.equal(words.status, 200, JSON.stringify(words.body));
  const late = await answer(f.ownerJwt, typedId, "ship");
  assert.equal(late.status, 409);
  assert.equal(late.body.error, "ask_answered", "the canonical answered rule counts a typed reply");

  // Signals are append-only, so these asks are written with a short life rather than expired later.
  const expiringAsk = async () => {
    const id = randomUUID();
    await sql.begin(async (tx) => {
      await tx`INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_user_id, kind, body, until)
        VALUES (${id}::uuid, ${f.workspaceA}::uuid, ${f.principal}::uuid, 'agent', ${f.ownerId}::uuid,
          'ask', 'Quick: ship?', statement_timestamp() + interval '4 seconds')`;
      await tx`INSERT INTO swarm.ask_choices (signal_id, workspace_id, options)
        VALUES (${id}::uuid, ${f.workspaceA}::uuid, ${tx.json(OPTIONS)}::jsonb)`;
    });
    return id;
  };
  const answeredId = await expiringAsk();
  const unansweredId = await expiringAsk();
  const original = randomUUID();
  const first = await answer(f.ownerJwt, answeredId, "ship", original);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const replyId = (first.body.choice_answer as { reply_signal_id: string }).reply_signal_id;
  await delay(4_500);
  for (const { name, askId, option, commandId, status, error } of [
    { name: "the same command id", askId: answeredId, option: "ship", commandId: original, status: 200, error: null },
    { name: "a new click on the same choice", askId: answeredId, option: "ship", commandId: randomUUID(), status: 200, error: null },
    { name: "a different choice", askId: answeredId, option: "wait", commandId: randomUUID(), status: 409, error: "choice_conflict" },
    { name: "an ask nobody answered", askId: unansweredId, option: "ship", commandId: randomUUID(), status: 409, error: "ask_expired" },
  ]) {
    const retry = await answer(f.ownerJwt, askId, option, commandId);
    assert.equal(retry.status, status, `${name}: ${JSON.stringify(retry.body)}`);
    if (error === null) {
      assert.deepEqual(retry.body.choice_answer, { signal_id: answeredId, option_id: "ship", option_ids: ["ship"],
        other_text: null, reply_signal_id: replyId }, name);
    } else {
      assert.equal(retry.body.error, error, name);
    }
  }
  const [replies] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM swarm.signals WHERE in_reply_to = ${answeredId}::uuid`;
  assert.equal(replies!.n, 1, "a replay posts nothing");
  assert.deepEqual(await actions(unansweredId), [], "a closed ask records no attempt");
});

test("a click whose asker is gone says so: reply_refused names why", async () => {
  for (const { name, fromKind } of [
    { name: "an agent no longer in the workspace", fromKind: "agent" },
    { name: "a person no longer in the workspace", fromKind: "user" },
  ]) {
    const askId = randomUUID();
    await sql.begin(async (tx) => {
      await tx`INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_user_id, kind, body, until)
        VALUES (${askId}::uuid, ${f.workspaceA}::uuid, ${randomUUID()}::uuid, ${fromKind}, ${f.ownerId}::uuid,
          'ask', 'Still shipping?', statement_timestamp() + interval '1 hour')`;
      await tx`INSERT INTO swarm.ask_choices (signal_id, workspace_id, options)
        VALUES (${askId}::uuid, ${f.workspaceA}::uuid, ${tx.json(OPTIONS)}::jsonb)`;
    });
    const refused = await answer(f.ownerJwt, askId, "ship");
    assert.equal(refused.status, 403, `${name}: ${JSON.stringify(refused.body)}`);
    assert.deepEqual(refused.body, { error: "reply_refused",
      message: "Whoever asked is no longer in this workspace, so your answer wasn't sent." }, name);
    assert.deepEqual((await actions(askId)).map((a) => [a.state, a.error_code]), [["failed", "reply_refused"]], name);
  }
});

test("with mentions off, a post that sends mentions is refused and nothing else about posting changes", async () => {
  const base = { kind: "post_signal", signal_kind: "note", body: "mentions are off here", to_user_id: null, about: null, to_agent_principal_id: null, in_reply_to: null };
  const refused = await postCommand(f.ownerJwt, f.workspaceA, { ...base, mentions: [{ kind: "agent", id: f.principal }] });
  assert.equal(refused.status, 400, JSON.stringify(refused.body));
  assert.match(String(refused.body.message), /mentions are not enabled/);
  // The key alone is refused, with nobody in it: a client that always sends it on a public post fails closed here
  // instead of having the post quietly re-addressed to the workspace lead.
  const emptyRefused = await postCommand(f.ownerJwt, f.workspaceA, { ...base, mentions: [] });
  assert.equal(emptyRefused.status, 400, JSON.stringify(emptyRefused.body));
  assert.match(String(emptyRefused.body.message), /mentions are not enabled/);
  assert.equal((await postCommand(f.ownerJwt, f.workspaceA, base)).status, 200);
});

/* Choice questions v2: descriptions and one recommended option, multi-select, "Other" text, and
 * asks addressed to nobody that any person who can read them may answer. */

const V2_OPTIONS = [
  { id: "ship", label: "Ship it", description: "Tonight, after CI" },
  { id: "wait", label: "Wait for tomorrow" },
  { id: "cancel", label: "Cancel the release", recommended: true },
];

let secondMember: { id: string; jwt: string } | undefined;
/** A second person in workspace A who is in no private channel. */
async function member(): Promise<{ id: string; jwt: string }> {
  if (secondMember) return secondMember;
  const created = await createUser("choice-member");
  await sql`INSERT INTO swarm.users (user_id, display_name) VALUES (${created.id}::uuid, 'ChoiceMember')`;
  await sql`INSERT INTO swarm.memberships (workspace_id, user_id, role) VALUES (${f.workspaceA}::uuid, ${created.id}::uuid, 'member')`;
  secondMember = created;
  return created;
}

async function askV2(fields: Record<string, unknown>): Promise<string> {
  const asked = await postCommand(f.agentToken, f.workspaceA, {
    kind: "ask_choice", body: "Which release plan?", to_user_id: null, about: null, options: V2_OPTIONS, ...fields,
  });
  assert.equal(asked.status, 200, JSON.stringify(asked.body) + functionLogs.slice(-2000));
  return (asked.body.signal as { id: string }).id;
}

const answerWith = (bearer: string, signalId: string, fields: Record<string, unknown>, commandId?: ReturnType<typeof randomUUID>) =>
  postCommand(bearer, f.workspaceA, { kind: "answer_choice", signal_id: signalId, ...fields }, commandId);

async function readChoices(userId: string, signalIds: string[]): Promise<{ asks: Array<Record<string, unknown>> }> {
  return await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE authenticated");
    await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: "authenticated" })}, true)`;
    return (await tx<{ r: { asks: Array<Record<string, unknown>> } }[]>`
      SELECT swarm_read.ask_choices(${f.workspaceA}::uuid, ${signalIds}::uuid[]) AS r`)[0]!.r;
  });
}

async function replyRow(replyId: string): Promise<Record<string, unknown>> {
  const rows = (await sql`
    SELECT body, in_reply_to, to_user_id, to_agent_principal_id, channel_id
    FROM swarm.signals WHERE id = ${replyId}::uuid`).map((row) => ({ ...row }));
  assert.equal(rows.length, 1);
  return rows[0]!;
}

test("v2: options keep descriptions and the recommended one first; a multi answer takes several ids and Other text", async () => {
  const askId = await askV2({ to_user_id: f.ownerId, multi: true });
  const stored = (await sql`SELECT options, multi FROM swarm.ask_choices WHERE signal_id = ${askId}::uuid`)
    .map((row) => ({ ...row }));
  assert.deepEqual(stored, [{ multi: true, options: [V2_OPTIONS[2], V2_OPTIONS[0], V2_OPTIONS[1]] }],
    "the recommended option is stored first");

  const chose = await answerWith(f.ownerJwt, askId, { option_ids: ["wait", "ship"], other_text: "  Ping me first  " });
  assert.equal(chose.status, 200, JSON.stringify(chose.body));
  const answer = chose.body.choice_answer as Record<string, unknown>;
  assert.deepEqual(answer, { signal_id: askId, option_id: "ship", option_ids: ["ship", "wait"], other_text: "Ping me first",
    reply_signal_id: answer.reply_signal_id }, "ids in the ask's order; option_id is the first for v1 readers");
  assert.deepEqual(await replyRow(String(answer.reply_signal_id)), { body: "Selected: Ship it, Wait for tomorrow\nOther: Ping me first",
    in_reply_to: askId, to_user_id: null, to_agent_principal_id: f.principal, channel_id: null });

  const again = await answerWith(f.ownerJwt, askId, { option_ids: ["ship", "wait"], other_text: "Ping me first" });
  assert.equal(again.status, 200, "the same answer again, in another order, is the person's answer");
  const different = await answerWith(f.ownerJwt, askId, { option_ids: ["ship"], other_text: "Ping me first" });
  assert.equal(different.status, 409);
  assert.equal(different.body.error, "choice_conflict");

  const read = await readChoices(f.ownerId, [askId]);
  assert.deepEqual(read.asks.map((row) => ({ ...row, answer: { ...(row.answer as Record<string, unknown>), at: "at" } })), [{
    signal_id: askId, options: [V2_OPTIONS[2], V2_OPTIONS[0], V2_OPTIONS[1]], multi: true,
    answer: { option_id: "ship", option_ids: ["ship", "wait"], other_text: "Ping me first", actor_user_id: f.ownerId,
      by_viewer: true, reply_signal_id: answer.reply_signal_id, at: "at" },
  }]);
});

test("v2: a single-choice ask takes one option or Other text alone", async () => {
  const askId = await askV2({ to_user_id: f.ownerId });
  const two = await answerWith(f.ownerJwt, askId, { option_ids: ["ship", "wait"] });
  assert.equal(two.status, 400);
  assert.equal(two.body.error, "one_answer_only");
  const both = await answerWith(f.ownerJwt, askId, { option_ids: ["ship"], other_text: "and more" });
  assert.equal(both.status, 400);
  assert.equal(both.body.error, "one_answer_only");
  const other = await answerWith(f.ownerJwt, askId, { other_text: "Neither; ship on Friday" });
  assert.equal(other.status, 200, JSON.stringify(other.body));
  const answer = other.body.choice_answer as Record<string, unknown>;
  assert.deepEqual({ ...answer, reply_signal_id: null }, { signal_id: askId, option_id: "other", option_ids: [],
    other_text: "Neither; ship on Friday", reply_signal_id: null });
  assert.equal((await replyRow(String(answer.reply_signal_id))).body, "Other: Neither; ship on Friday");
  const rows = (await sql`SELECT state, option_id, option_ids, other_text FROM swarm.ui_actions
    WHERE signal_id = ${askId}::uuid AND state = 'completed'`).map((row) => ({ ...row }));
  assert.deepEqual(rows, [{ state: "completed", option_id: "other", option_ids: [], other_text: "Neither; ship on Friday" }]);
  const read = await readChoices(f.ownerId, [askId]);
  assert.deepEqual((read.asks[0]!.answer as Record<string, unknown>).option_ids, [], "a text-only answer chose no option");
});

test("v2: malformed asks and answers are refused before any attempt is recorded; an unknown id is a recorded attempt", async () => {
  for (const options of [
    [{ ...V2_OPTIONS[0], recommended: true }, V2_OPTIONS[1], V2_OPTIONS[2]],
    [{ ...V2_OPTIONS[0], description: "x".repeat(201) }, V2_OPTIONS[1]],
    [{ ...V2_OPTIONS[0], description: "" }, V2_OPTIONS[1]],
    [{ ...V2_OPTIONS[0], recommended: "yes" }, V2_OPTIONS[1]],
  ]) {
    const refused = await postCommand(f.agentToken, f.workspaceA, {
      kind: "ask_choice", body: "Which?", to_user_id: f.ownerId, about: null, options,
    });
    assert.equal(refused.status, 400, JSON.stringify(options).slice(0, 120));
  }
  assert.equal((await postCommand(f.agentToken, f.workspaceA, {
    kind: "ask_choice", body: "Which?", to_user_id: f.ownerId, about: null, options: V2_OPTIONS, multi: "yes",
  })).status, 400, "multi is a boolean");

  const askId = await askV2({ to_user_id: f.ownerId, multi: true });
  for (const [name, fields] of [
    ["control characters in other text", { other_text: "ship\u0007it" }],
    ["a newline in other text", { other_text: "ship\nit" }],
    ["other text past 500", { other_text: "x".repeat(501) }],
    ["blank other text", { other_text: "   " }],
    ["seven ids", { option_ids: ["a", "b", "c", "d", "e", "f", "g"] }],
    ["a repeated id", { option_ids: ["ship", "ship"] }],
    ["an empty multi answer", { option_ids: [] }],
    ["nothing at all", {}],
    ["option_id beside option_ids", { option_id: "ship", option_ids: ["wait"] }],
  ] as const) {
    const refused = await answerWith(f.ownerJwt, askId, fields);
    assert.equal(refused.status, 400, `${name}: ${JSON.stringify(refused.body)}`);
  }
  assert.deepEqual(await actions(askId), [], "a malformed answer records no attempt");
  const unknown = await answerWith(f.ownerJwt, askId, { option_ids: ["ship", "nope"] });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.error, "unknown_option");
  assert.deepEqual((await actions(askId)).map((a) => [a.state, a.error_code]), [["failed", "unknown_option"]]);
});

test("v2: an ask addressed to nobody in a channel is answered by any person who reads it, first answer wins", async () => {
  const reader = await member();
  const created = await postCommand(f.agentToken, f.workspaceA, { kind: "channel_create", slug: `rel-${randomBytes(4).toString("hex")}` });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const channel = created.body.channel as { channel_id: string; slug: string };
  const askId = await askV2({ channel: channel.slug });
  const [asked] = (await sql`SELECT channel_id, to_user_id, to_agent_principal_id FROM swarm.signals WHERE id = ${askId}::uuid`)
    .map((row) => ({ ...row }));
  assert.deepEqual(asked, { channel_id: channel.channel_id, to_user_id: null, to_agent_principal_id: null });

  assert.equal((await answerWith(f.agentToken, askId, { option_id: "ship" })).status, 403, "an agent never answers");
  const chose = await answerWith(reader.jwt, askId, { option_id: "wait" });
  assert.equal(chose.status, 200, JSON.stringify(chose.body));
  const answer = chose.body.choice_answer as Record<string, unknown>;
  assert.deepEqual(await replyRow(String(answer.reply_signal_id)), { body: "Selected: Wait for tomorrow", in_reply_to: askId,
    to_user_id: null, to_agent_principal_id: f.principal, channel_id: channel.channel_id }, "the answer wakes the asking agent");

  const late = await answerWith(f.ownerJwt, askId, { option_id: "ship" });
  assert.equal(late.status, 409);
  assert.equal(late.body.error, "ask_answered");
  const read = await readChoices(f.ownerId, [askId]);
  const seen = read.asks[0]!.answer as Record<string, unknown>;
  assert.deepEqual({ by: seen.actor_user_id, mine: seen.by_viewer, ids: seen.option_ids }, { by: reader.id, mine: false, ids: ["wait"] });
});

test("v2: a private channel's ask is not answerable from outside it; a directed ask only by its addressee", async () => {
  const outsider = await member();
  const created = await postCommand(f.agentToken, f.workspaceA, {
    kind: "channel_create", slug: `lock-${randomBytes(4).toString("hex")}`, visibility: "private",
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const channel = created.body.channel as { slug: string };
  const privateAsk = await askV2({ channel: channel.slug });
  const unknownAsk = await answerWith(outsider.jwt, randomUUID(), { option_id: "ship" });
  const hidden = await answerWith(outsider.jwt, privateAsk, { option_id: "ship" });
  assert.deepEqual({ status: hidden.status, body: hidden.body }, { status: unknownAsk.status, body: unknownAsk.body },
    "outside the channel, the ask is the same as one that doesn't exist");
  assert.equal(hidden.status, 404);
  assert.deepEqual(await actions(privateAsk), [], "an unreadable ask records no attempt");
  const inside = await answerWith(f.ownerJwt, privateAsk, { option_id: "ship" });
  assert.equal(inside.status, 200, JSON.stringify(inside.body));

  const directed = await askV2({ to_user_id: f.ownerId });
  const notYours = await answerWith(outsider.jwt, directed, { option_id: "ship" });
  assert.deepEqual({ status: notYours.status, body: notYours.body }, { status: unknownAsk.status, body: unknownAsk.body });
  assert.deepEqual(await actions(directed), []);
  assert.equal((await answerWith(f.ownerJwt, directed, { option_id: "ship" })).status, 200);
});

test("v2: a v1-shaped ask and answer still work, and readback adds keys only", async () => {
  const asked = await askOwner();
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  const askId = (asked.body.signal as { id: string }).id;
  const chose = await answer(f.ownerJwt, askId, "wait");
  assert.equal(chose.status, 200, JSON.stringify(chose.body));
  assert.equal((chose.body.choice_answer as { option_id: string }).option_id, "wait");
  const read = await readChoices(f.ownerId, [askId]);
  const row = read.asks[0]!;
  assert.deepEqual(row.options, OPTIONS);
  assert.equal(row.multi, false);
  const readAnswer = row.answer as Record<string, unknown>;
  assert.deepEqual({ option_id: readAnswer.option_id, option_ids: readAnswer.option_ids, other_text: readAnswer.other_text,
    by_viewer: readAnswer.by_viewer }, { option_id: "wait", option_ids: ["wait"], other_text: null, by_viewer: true });
  // A row written before v2 has no option_ids; its one option_id stands in.
  await sql`UPDATE swarm.ui_actions SET option_ids = NULL WHERE signal_id = ${askId}::uuid AND state = 'completed'`;
  assert.deepEqual(((await readChoices(f.ownerId, [askId])).asks[0]!.answer as Record<string, unknown>).option_ids, ["wait"]);
});
