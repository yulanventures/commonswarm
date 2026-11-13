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
  assert.equal(reply.body, "Chose: Ship it", "the reply text comes from the stored label");
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
      assert.deepEqual(retry.body.choice_answer, { signal_id: answeredId, option_id: "ship", reply_signal_id: replyId }, name);
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
  assert.equal((await postCommand(f.ownerJwt, f.workspaceA, base)).status, 200);
});
