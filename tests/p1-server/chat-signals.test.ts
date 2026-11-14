/**
 * Channels and threads against the SERVED command function and real Postgres.
 *
 * These are the claims no pure test and no schema test can reach, because they
 * live in the edge's validator and its SQL: a thread roots only on an
 * undirected message, a reply's horizon is clamped when it was defaulted and
 * REFUSED when it was named, in_reply_to keeps its addressing, and the
 * channel/thread fields do not disturb a body that omits them.
 *
 * Two of these were found by review arms rather than by a test, twice on the
 * same clamp. That is why they are here.
 *
 * Reached by `npm run test:p1-server` (globs tests/p1-server/**; serial via
 * --test-concurrency=1 because each file owns the one local runtime).
 */
import assert from "node:assert/strict";
import { privateCommandFailureCapture } from "../support/admin-principal-lock-order-harness.mjs";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import postgres from "postgres";
import { awaitFunctionRunning, observeFunctionCli } from "../support/edge-readiness.js";
import {
  CHANNEL_READ_COLUMNS,
  CHANNEL_UPDATE_EMPTY_TEXT,
  MODEL_RULE_TEXT,
  SIGNAL_MENTION_MAX,
  SIGNAL_RECIPIENT_MAX,
  uuidFieldRuleText,
} from "../../supabase/functions/_shared/channels.js";
import { cloudTarget } from "../../src/cloud/config.js";
import { DeliveryCommandClient } from "../../src/cloud/delivery.js";

interface LocalEnvironment {
  API_URL: string;
  ANON_KEY: string;
  DB_URL: string;
  SERVICE_ROLE_KEY: string;
}

let local: LocalEnvironment;
let sql: postgres.Sql;
let admin: SupabaseClient;
const commandDiagnostics = privateCommandFailureCapture("chat-signals-command");
let functionProcess: ReturnType<typeof spawn>;
let functionLogs = "";
let envDir: string | undefined;

interface ChatFixture {
  workspace: string;
  ownerId: string;
  ownerJwt: string;
  otherId: string;
  otherJwt: string;
  principal: string;
  agentToken: string;
  /* A SECOND agent, owned by the same person, so a signal can name one agent
   * in its scalar column and the other only in its recipient set. That pair is
   * the only way to see the read edge's new arm on its own. */
  principalTwo: string;
  agentTokenTwo: string;
}

let f: ChatFixture;

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

async function chatFixture(): Promise<ChatFixture> {
  const owner = await createUser("chat-owner");
  const other = await createUser("chat-other");
  const workspace = randomUUID();
  const device = randomUUID();
  const principal = randomUUID();
  const agentToken = `swm_agt_${randomBytes(32).toString("base64url")}`;
  const principalTwo = randomUUID();
  const agentTokenTwo = `swm_agt_${randomBytes(32).toString("base64url")}`;
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO swarm.users (user_id, display_name)
      VALUES
        (${owner.id}::uuid, 'ChatOwner'),
        (${other.id}::uuid, 'ChatOther')
    `;
    await tx`
      INSERT INTO swarm.devices (device_id, user_id, label)
      VALUES (${device}::uuid, ${owner.id}::uuid, 'chat-tests')
    `;
    await tx`
      INSERT INTO swarm.workspaces (workspace_id, name, created_by)
      VALUES (${workspace}::uuid, 'ChatWS', ${owner.id}::uuid)
    `;
    await tx`
      INSERT INTO swarm.memberships (workspace_id, user_id, role)
      VALUES
        (${workspace}::uuid, ${owner.id}::uuid, 'owner'),
        (${workspace}::uuid, ${other.id}::uuid, 'member')
    `;
    await tx`
      INSERT INTO swarm.streams (stream_id, workspace_id, kind)
      VALUES (${randomUUID()}::uuid, ${workspace}::uuid, 'workspace')
    `;
    await tx`
      INSERT INTO swarm.agent_principals (
        principal_id, workspace_id, owner_user_id, name
      ) VALUES
        (${principal}::uuid, ${workspace}::uuid, ${owner.id}::uuid, 'chat-agent'),
        (${principalTwo}::uuid, ${workspace}::uuid, ${owner.id}::uuid, 'chat-agent-two')
    `;
    for (
      const seat of [
        { principalId: principal, token: agentToken },
        { principalId: principalTwo, token: agentTokenTwo },
      ]
    ) {
      const run = randomUUID();
      await tx`
        INSERT INTO swarm.agent_runs (run_id, principal_id, device_id)
        VALUES (${run}::uuid, ${seat.principalId}::uuid, ${device}::uuid)
      `;
      await tx`
        INSERT INTO swarm.agent_tokens (
          token_id, principal_id, run_id, scopes, token_hash,
          expires_at, lineage_id
        ) VALUES (
          ${randomUUID()}::uuid, ${seat.principalId}::uuid, ${run}::uuid,
          ${tx.json(["post_signal"])}::jsonb,
          ${createHash("sha256").update(seat.token).digest()},
          statement_timestamp() + interval '1 hour', ${randomUUID()}::uuid
        )
      `;
    }
  });
  return {
    workspace,
    ownerId: owner.id,
    ownerJwt: owner.jwt,
    otherId: other.id,
    otherJwt: other.jwt,
    principal,
    agentToken,
    principalTwo,
    agentTokenTwo,
  };
}

/**
 * One row of swarm_read.signals AS a signed-in member. The view is gated on
 * auth.uid(), so a plain superuser connection reads NOTHING through it and a
 * query that forgets this returns undefined rather than an error -- which is
 * how a first draft of these tests failed.
 */
async function viewRowAs<T>(
  userId: string,
  read: (tx: postgres.TransactionSql<Record<string, unknown>>) => Promise<T>,
): Promise<T> {
  return await sql.begin(async (tx) => {
    await tx`
      SELECT set_config(
        'request.jwt.claims',
        ${JSON.stringify({ sub: userId, role: "authenticated" })},
        true
      )
    `;
    await tx.unsafe("SET LOCAL ROLE authenticated");
    const value = await read(tx);
    await tx.unsafe("RESET ROLE");
    return value;
  }) as T;
}

/** The agent read path, which is the SECOND enforcement point for recipients. */
async function readSignals(
  bearer: string,
  inbox = false,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${local.API_URL}/functions/v1/read`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      resource: "signals",
      workspace_id: f.workspace,
      inbox,
      about: null,
      kind: null,
      since: null,
      in_reply_to: null,
      limit: 100,
      include_stale: false,
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
  envDir = mkdtempSync(join(tmpdir(), "cswarm-chat-env-"));
  const envFile = join(envDir, "test.env");
  // Mentions are on for this file. No workspace here has a lead, so nothing else changes.
  writeFileSync(envFile, "SWARM_ENV=test\nSWARM_CHAT_MENTIONS=1\n");
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
  functionProcess.stderr?.on("data", commandDiagnostics.capture);
  /* Wait for OUR boot banner before the HTTP probe: at a file seam the previous
   * file's still-answering runtime satisfies the probe and every request 502s. */
  {
    const bootDeadline = Date.now() + 60_000;
    while (!functionLogs.includes("Serving functions on")) {
      if (Date.now() > bootDeadline) {
        throw new Error(
          "functions serve never booted; private command diagnostics retained",
        );
      }
      await delay(250);
    }
  }
  await awaitFunctionRunning({
    url: `${local.API_URL}/functions/v1/command`,
    fetcher: fetch,
    timeoutMs: 30_000,
    sleep: (ms) => delay(ms),
    now: () => Date.now(),
    diagnostics: () => "command readiness failed; private command diagnostics retained",
    cliState,
  });
  f = await chatFixture();
});

after(async () => {
  try {
    commandDiagnostics.retain();
  } finally {
    if (functionProcess && functionProcess.exitCode === null) {
      const exited = new Promise<boolean>((resolve) => {
        functionProcess.once("close", () => resolve(true));
      });
      functionProcess.kill();
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
  }
});

async function send(
  bearer: string,
  command: Record<string, unknown>,
  commandId: string = randomUUID(),
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
      workspace_id: f.workspace,
      stream: { kind: "workspace" },
      command,
    }),
  });
  return {
    status: response.status,
    body: await response.json() as Record<string, unknown>,
  };
}

/** The EXACT body every installed client sends: the modern pair, always both. */
function installedPost(
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    kind: "post_signal",
    signal_kind: "note",
    body: `p1-server chat ${randomUUID()}`,
    to_user_id: null,
    about: null,
    to_agent_principal_id: null,
    in_reply_to: null,
    ...extra,
  };
}

function signalOf(body: Record<string, unknown>): Record<string, unknown> {
  const signal = body.signal as Record<string, unknown> | undefined;
  assert.ok(signal, `no signal in response: ${JSON.stringify(body)}`);
  return signal;
}

test("a body that predates channels still posts, and one that names a channel lands in it", async () => {
  const legacy = await send(f.ownerJwt, installedPost());
  assert.equal(legacy.status, 200, JSON.stringify(legacy.body));
  assert.equal(signalOf(legacy.body).channel_id, null, "unfiled");
  assert.equal(signalOf(legacy.body).broadcast_to_channel, false);

  const created = await send(f.ownerJwt, {
    kind: "channel_create",
    slug: `mobile-${randomBytes(4).toString("hex")}`,
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const channel = created.body.channel as Record<string, unknown>;
  assert.ok(channel?.channel_id);

  const filed = await send(
    f.ownerJwt,
    installedPost({ channel: channel.slug }),
  );
  assert.equal(filed.status, 200, JSON.stringify(filed.body));
  assert.equal(signalOf(filed.body).channel_id, channel.channel_id);
});

test("an agent may create a channel with a token that carries only post_signal", async () => {
  /* The scope gate exempts channel commands by class. A token minted before
   * these commands existed cannot carry a channel_create scope, so refusing
   * without the exemption would refuse every agent already running. */
  const slug = `agent-made-${randomBytes(4).toString("hex")}`;
  const created = await send(f.agentToken, { kind: "channel_create", slug });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(
    (created.body.channel as Record<string, unknown>).created_by_kind,
    "agent",
  );
  /* Control: the same token is still refused a command that is NOT exempt and
   * not in its scopes, so the acceptance above is the exemption and not an
   * unscoped edge. */
  const refused = await send(f.agentToken, {
    kind: "create_agent_principal",
    name: "should-not-work",
  });
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
});

test("a channel that does not exist is refused with the channels that do", async () => {
  const slug = `known-${randomBytes(4).toString("hex")}`;
  const created = await send(f.ownerJwt, { kind: "channel_create", slug });
  assert.equal(created.status, 200);
  const missing = await send(
    f.ownerJwt,
    installedPost({ channel: `absent-${randomBytes(4).toString("hex")}` }),
  );
  assert.equal(missing.status, 404, JSON.stringify(missing.body));
  assert.match(String(missing.body.message), /no channel named/);
  /* The list is generated from the same query the validator ran, so the slug
   * created a moment ago must be in it. A typed list would not have it. */
  assert.ok(
    String(missing.body.message).includes(slug),
    `message must name the live channels: ${missing.body.message}`,
  );
});

test("an archived channel keeps its history and takes no new messages", async () => {
  const slug = `archived-${randomBytes(4).toString("hex")}`;
  const created = await send(f.ownerJwt, { kind: "channel_create", slug });
  const channel = created.body.channel as Record<string, unknown>;
  const before = await send(f.ownerJwt, installedPost({ channel: slug }));
  assert.equal(before.status, 200);
  const archived = await send(f.ownerJwt, {
    kind: "channel_archive",
    channel_id: channel.channel_id,
  });
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  const after = await send(f.ownerJwt, installedPost({ channel: slug }));
  assert.equal(after.status, 409, JSON.stringify(after.body));
  assert.equal(after.body.error, "channel_archived");
  /* Control: the signal posted before the archive is still there. */
  const [row] = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM swarm.signals
    WHERE id = ${String(signalOf(before.body).id)}::uuid
  `;
  assert.equal(row?.n, "1");
});

test("a thread roots only on an undirected message", async () => {
  const root = await send(f.ownerJwt, installedPost());
  assert.equal(root.status, 200);
  const rootId = String(signalOf(root.body).id);

  const reply = await send(
    f.ownerJwt,
    installedPost({ thread_root_id: rootId }),
  );
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.equal(signalOf(reply.body).thread_root_id, rootId);
  assert.equal(signalOf(reply.body).to, null, "a thread reply is undirected");

  /* The disclosure arm. A DIRECTED signal between two other parties must not
   * become the root of a thread everyone can read: the reply itself is
   * undirected, so the thread would advertise that the private message exists.
   * resolveThreadRoot reads swarm.signals as swarm_command, bypassing the view
   * that is the read policy, so this is enforcement and not a side effect. */
  const directed = await send(
    f.otherJwt,
    installedPost({ to_user_id: f.ownerId }),
  );
  assert.equal(directed.status, 200, JSON.stringify(directed.body));
  const directedId = String(signalOf(directed.body).id);
  const hijack = await send(
    f.ownerJwt,
    installedPost({ thread_root_id: directedId }),
  );
  assert.equal(hijack.status, 404, JSON.stringify(hijack.body));
  assert.equal(hijack.body.error, "thread_root_not_found");
  /* The refusal must not distinguish "directed" from "absent", or it becomes
   * an oracle for which ids exist. */
  const absent = await send(
    f.ownerJwt,
    installedPost({ thread_root_id: randomUUID() }),
  );
  assert.equal(absent.status, 404);
  assert.equal(absent.body.message, hijack.body.message);
});

test("a thread reply is never working-on, never addressed, and never also in_reply_to", async () => {
  const root = await send(f.ownerJwt, installedPost());
  const rootId = String(signalOf(root.body).id);

  const workingOn = await send(
    f.ownerJwt,
    installedPost({ signal_kind: "working-on", thread_root_id: rootId }),
  );
  assert.equal(workingOn.status, 400, JSON.stringify(workingOn.body));

  const addressed = await send(
    f.ownerJwt,
    installedPost({ thread_root_id: rootId, to_user_id: f.otherId }),
  );
  assert.equal(addressed.status, 400, JSON.stringify(addressed.body));

  const both = await send(
    f.ownerJwt,
    installedPost({ thread_root_id: rootId, in_reply_to: rootId }),
  );
  assert.equal(both.status, 400, JSON.stringify(both.body));

  /* Control: an ask IS allowed as a thread reply (R11), so the three refusals
   * above are the stated rules and not a blanket refusal of thread replies. */
  const ask = await send(
    f.ownerJwt,
    installedPost({ signal_kind: "ask", thread_root_id: rootId }),
  );
  assert.equal(ask.status, 200, JSON.stringify(ask.body));
});

test("in_reply_to keeps its addressing, and a thread reply does not borrow it", async () => {
  /* The claim R2 rests on: in_reply_to means "reply privately to the author"
   * and the server re-addresses the row. Threads must not change that. */
  const ask = await send(
    f.otherJwt,
    installedPost({ signal_kind: "note", to_user_id: f.ownerId }),
  );
  assert.equal(ask.status, 200, JSON.stringify(ask.body));
  const askId = String(signalOf(ask.body).id);

  const privateReply = await send(
    f.ownerJwt,
    installedPost({ in_reply_to: askId }),
  );
  assert.equal(privateReply.status, 200, JSON.stringify(privateReply.body));
  assert.equal(
    signalOf(privateReply.body).to,
    f.otherId,
    "the server still re-addresses an in_reply_to row to the referenced author",
  );
  assert.equal(signalOf(privateReply.body).thread_root_id, null);
});

test("a defaulted reply horizon is clamped to the thread; a named one is refused, never shortened", async () => {
  /* Twice a review arm found this wrong and no test caught it. Both branches
   * are asserted here against the served function and real Postgres. */
  const root = await send(f.ownerJwt, installedPost({ until_ms: 90_000 }));
  assert.equal(root.status, 200, JSON.stringify(root.body));
  const rootId = String(signalOf(root.body).id);
  const rootUntil = Date.parse(String(signalOf(root.body).until));

  /* DEFAULT: a note defaults to 30 days, far past a 90-second root, so the
   * clamp must bite and the stored horizon must not exceed the root's. */
  const defaulted = await send(
    f.ownerJwt,
    installedPost({ thread_root_id: rootId }),
  );
  assert.equal(defaulted.status, 200, JSON.stringify(defaulted.body));
  const defaultedUntil = Date.parse(String(signalOf(defaulted.body).until));
  assert.equal(
    defaultedUntil,
    rootUntil,
    "a defaulted reply is clamped TO the root, not merely under it: an arm noted that <= would also accept an over-clamp to one millisecond",
  );
  /* PRECISION, stated because a review arm claimed the wrong thing and I
   * repeated it. This equality is at MILLISECOND resolution, not microsecond.
   * placement.untilCeiling is rootUntil.toISOString() -- a JS Date, already
   * truncated to ms -- so the SQL LEAST compares against a millisecond value
   * and both sides of this assertion are Date.parse of an ISO string. The
   * assertion is exact and not flaky at that resolution, but it cannot see a
   * sub-millisecond under-clamp, and the truncation goes UNDER the root, so a
   * reply still cannot outlive it. */
  /* Control: without the clamp this would be ~30 days out, so a horizon inside
   * the root's window is the clamp working and not a coincidence. Measured
   * against the row's OWN created_at rather than this process's clock, which
   * Postgres does not share. */
  const defaultedCreated = Date.parse(String(signalOf(defaulted.body).created_at));
  assert.ok(
    defaultedUntil > defaultedCreated,
    "and it must still be live",
  );
  assert.ok(
    defaultedUntil - defaultedCreated < 30 * 24 * 60 * 60_000,
    "a 30-day default reaching the row unclamped is the failure this catches",
  );

  /* NAMED and too long: REFUSED. This is the arm that catches a silent
   * shorten, and it is the only one that can: an implementation that clamped
   * instead of refusing would answer 200 here with a trimmed horizon. An arm
   * pointed out that the in-window case below cannot make that distinction,
   * because LEAST is a no-op on a value already inside the ceiling. */
  const tooLong = await send(
    f.ownerJwt,
    installedPost({ thread_root_id: rootId, until_ms: 10 * 60_000 }),
  );
  assert.equal(tooLong.status, 409, JSON.stringify(tooLong.body));
  assert.equal(tooLong.body.error, "thread_reply_until_exceeds_root");
  assert.equal(tooLong.body.signal, undefined, "and nothing was stored");

  /* Just barely over: the band a clamp would silently absorb and a refusal
   * cannot. 90s root, so 95s is over by 5s and still nowhere near the 30-day
   * ceiling that would trip an unrelated bound. */
  const barelyOver = await send(
    f.ownerJwt,
    installedPost({ thread_root_id: rootId, until_ms: 95_000 }),
  );
  assert.equal(barelyOver.status, 409, JSON.stringify(barelyOver.body));

  /* NAMED and comfortably inside: stored EXACTLY as asked. This does NOT by
   * itself discriminate "store exact" from "clamp to ceiling" -- both store
   * 30s -- so it is here to catch an implementation that mangles an accepted
   * horizon, and the refusals above carry the no-silent-shorten claim. */
  const fits = await send(
    f.ownerJwt,
    installedPost({ thread_root_id: rootId, until_ms: 30_000 }),
  );
  assert.equal(fits.status, 200, JSON.stringify(fits.body));
  const fitsUntil = Date.parse(String(signalOf(fits.body).until));
  const created = Date.parse(String(signalOf(fits.body).created_at));
  assert.equal(fitsUntil - created, 30_000, "stored exactly as named");
});

test("a channel post wakes nobody, and a directed note to an agent still does", async () => {
  const slug = `wake-${randomBytes(4).toString("hex")}`;
  await send(f.ownerJwt, { kind: "channel_create", slug });
  const posted = await send(f.ownerJwt, installedPost({ channel: slug }));
  assert.equal(posted.status, 200);
  const [none] = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM swarm.signal_deliveries
    WHERE signal_id = ${String(signalOf(posted.body).id)}::uuid
  `;
  assert.equal(none?.n, "0", "a channel post creates no delivery row");

  const directed = await send(
    f.ownerJwt,
    installedPost({ channel: slug, to_agent_principal_id: f.principal }),
  );
  assert.equal(directed.status, 200, JSON.stringify(directed.body));
  const [one] = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM swarm.signal_deliveries
    WHERE signal_id = ${String(signalOf(directed.body).id)}::uuid
  `;
  assert.equal(one?.n, "1", "a directed note to an agent still delivers");
});

test("a bad channel name is refused with the rule, and the field list names the fields", async () => {
  const bad = await send(f.ownerJwt, { kind: "channel_create", slug: "Not A Slug" });
  assert.equal(bad.status, 400, JSON.stringify(bad.body));
  assert.match(String(bad.body.message ?? bad.body.error), /lowercase|channel name/i);

  const missing = await send(f.ownerJwt, { kind: "channel_archive" });
  assert.equal(missing.status, 400, JSON.stringify(missing.body));
  assert.match(
    String(missing.body.message ?? bad.body.error),
    /channel_archive takes channel_id/,
  );
});


test("an archived channel takes no thread replies either", async () => {
  /* A review arm found this reachable. resolveSignalChannel only checks
   * archived_at when a SLUG is sent, and a thread reply sends none: it inherits
   * its root's channel. Placement stamped that channel unchecked, so a reply
   * landed in a channel whose own copy says it takes no new messages. */
  const slug = `thread-archive-${randomBytes(4).toString("hex")}`;
  const created = await send(f.ownerJwt, { kind: "channel_create", slug });
  const channel = created.body.channel as Record<string, unknown>;

  const root = await send(f.ownerJwt, installedPost({ channel: slug }));
  assert.equal(root.status, 200, JSON.stringify(root.body));
  const rootId = String(signalOf(root.body).id);

  /* Control: a thread reply is accepted while the channel is live, so the
   * refusal after archiving is the archive and not a broken thread path. */
  const beforeArchive = await send(
    f.ownerJwt,
    installedPost({ thread_root_id: rootId }),
  );
  assert.equal(beforeArchive.status, 200, JSON.stringify(beforeArchive.body));
  assert.equal(signalOf(beforeArchive.body).channel_id, channel.channel_id);

  const archived = await send(f.ownerJwt, {
    kind: "channel_archive",
    channel_id: channel.channel_id,
  });
  assert.equal(archived.status, 200, JSON.stringify(archived.body));

  const afterArchive = await send(
    f.ownerJwt,
    installedPost({ thread_root_id: rootId }),
  );
  assert.equal(afterArchive.status, 409, JSON.stringify(afterArchive.body));
  assert.equal(afterArchive.body.error, "channel_archived");

  /* And a top-level post to an UNFILED root's thread is unaffected, so the
   * check keys on the channel and not on threads in general. */
  const unfiledRoot = await send(f.ownerJwt, installedPost());
  const unfiledReply = await send(
    f.ownerJwt,
    installedPost({ thread_root_id: String(signalOf(unfiledRoot.body).id) }),
  );
  assert.equal(unfiledReply.status, 200, JSON.stringify(unfiledReply.body));
});

test("a refusal names the rule that was broken, with the right article", async () => {
  const root = await send(f.ownerJwt, installedPost());
  const rootId = String(signalOf(root.body).id);
  const workingOn = await send(
    f.ownerJwt,
    installedPost({ signal_kind: "working-on", thread_root_id: rootId }),
  );
  assert.equal(workingOn.status, 400, JSON.stringify(workingOn.body));
  const message = String(workingOn.body.message);
  assert.match(message, /working-on/);
  assert.match(message, /a note or an ask/, "the article is generated, not typed");
  assert.doesNotMatch(message, /a ask/, "the defect a review arm found");

  /* A malformed thread_root_id must get the CHAT sentence, not the generic
   * one: the edge used to keep its own uuid check that fired first. */
  const badUuid = await send(
    f.ownerJwt,
    installedPost({ thread_root_id: "00000000-0000-0000-0000-000000000000" }),
  );
  assert.equal(badUuid.status, 400, JSON.stringify(badUuid.body));
  assert.match(String(badUuid.body.message), /thread_root_id/);
});


test("a refusal names the FIRST rule broken, not the chat rule that also fired", async () => {
  /* A review arm found the chat sentence winning over checks that fail earlier.
   * A body with an invalid signal_kind AND a thread_root_id was told the
   * thread-kind rule, when the first broken rule is that the kind is not a
   * signal kind at all. A refusal that names the wrong rule sends the caller to
   * fix the wrong thing. */
  const root = await send(f.ownerJwt, installedPost());
  const rootId = String(signalOf(root.body).id);

  const badKind = await send(
    f.ownerJwt,
    installedPost({ signal_kind: "nope", thread_root_id: rootId }),
  );
  assert.equal(badKind.status, 400, JSON.stringify(badKind.body));
  assert.equal(
    badKind.body.message,
    "signal fields are malformed or over their limits",
    "an invalid kind is not a thread-reply problem",
  );

  /* The shape rule outranks the thread rules it is not yet subject to. An arm
   * showed this test would have stayed green while a malformed thread_root_id
   * was answered with a rule about channels. */
  const badId = await send(
    f.ownerJwt,
    installedPost({ thread_root_id: "not-a-uuid", channel: "mobile" }),
  );
  assert.equal(badId.status, 400, JSON.stringify(badId.body));
  assert.match(String(badId.body.message), /thread_root_id is the id/);

  /* The NIL uuid is well-formed hex but fails the version/variant test the
   * edges use, so it is the same "not an id" case by a different route. */
  const nilId = await send(
    f.ownerJwt,
    installedPost({
      thread_root_id: "00000000-0000-0000-0000-000000000000",
      channel: "mobile",
    }),
  );
  assert.equal(nilId.status, 400, JSON.stringify(nilId.body));
  assert.match(String(nilId.body.message), /thread_root_id is the id/);

  /* And the purpose rules are split the same way: a non-string purpose is a
   * TYPE problem, not a length problem. */
  const badPurposeType = await send(f.ownerJwt, {
    kind: "channel_create",
    slug: `purpose-type-${randomBytes(4).toString("hex")}`,
    purpose: 123,
  });
  assert.equal(badPurposeType.status, 400, JSON.stringify(badPurposeType.body));
  assert.equal(String(badPurposeType.body.message), "A channel purpose is text.");

  const badPurposeLength = await send(f.ownerJwt, {
    kind: "channel_create",
    slug: `purpose-len-${randomBytes(4).toString("hex")}`,
    purpose: "x".repeat(501),
  });
  assert.equal(badPurposeLength.status, 400, JSON.stringify(badPurposeLength.body));
  assert.match(String(badPurposeLength.body.message), /at most 500 characters/);

  /* The bound must measure the string that is STORED. An arm found the check
   * running on the sanitized value while the insert stored the sanitized AND
   * trimmed one, so this body was refused for length even though the row it
   * would write is exactly 500 characters. The old 501-x case above stays
   * over-length after trimming, so it could not see this. */
  const trailingSpace = await send(f.ownerJwt, {
    kind: "channel_create",
    slug: `purpose-trim-${randomBytes(4).toString("hex")}`,
    purpose: `${"x".repeat(500)} `,
  });
  assert.equal(
    trailingSpace.status,
    200,
    `a purpose that is 500 characters once stored must be accepted: ${JSON.stringify(trailingSpace.body)}`,
  );
  assert.equal(
    (trailingSpace.body.channel as Record<string, unknown>).purpose,
    "x".repeat(500),
    "and it is stored trimmed",
  );

  /* The other half of the same defect: an all-whitespace purpose stores NULL,
   * so refusing it for length names a rule its stored form cannot break. */
  const blankPurpose = await send(f.ownerJwt, {
    kind: "channel_create",
    slug: `purpose-blank-${randomBytes(4).toString("hex")}`,
    purpose: " ".repeat(501),
  });
  assert.equal(
    blankPurpose.status,
    200,
    `an all-whitespace purpose stores null and must not be refused for length: ${JSON.stringify(blankPurpose.body)}`,
  );
  assert.equal(
    (blankPurpose.body.channel as Record<string, unknown>).purpose,
    null,
  );

  /* Right keys, WRONG TYPE. Bundled with exactKeys, `{model: 123}` was told
   * the field list, which ends "and nothing else" and so reports an extra key
   * the caller did not send. The first rule broken is the type. */
  const wrongModelType = await send(f.agentToken, {
    kind: "declare_agent_model",
    model: 123,
  });
  assert.equal(wrongModelType.status, 400, JSON.stringify(wrongModelType.body));
  assert.equal(
    String(wrongModelType.body.message),
    MODEL_RULE_TEXT,
    "a wrong type is the type rule, not the field list",
  );
  assert.doesNotMatch(String(wrongModelType.body.message), /nothing else/);

  /* Control: an ACTUAL extra key still gets the field list, so the split did
   * not simply swap one sentence for the other. */
  const extraModelKey = await send(f.agentToken, {
    kind: "declare_agent_model",
    model: null,
    nope: 1,
  });
  assert.equal(extraModelKey.status, 400, JSON.stringify(extraModelKey.body));
  assert.match(String(extraModelKey.body.message), /nothing else/);

  /* set_agent_model bundled THREE rules. A malformed principal_id is the id
   * rule, and a wrong model type is the type rule; neither is the field list. */
  const badPrincipal = await send(f.ownerJwt, {
    kind: "set_agent_model",
    principal_id: "not-a-uuid",
    model: null,
  });
  assert.equal(badPrincipal.status, 400, JSON.stringify(badPrincipal.body));
  assert.equal(
    String(badPrincipal.body.message),
    uuidFieldRuleText("principal_id"),
  );

  const setWrongType = await send(f.ownerJwt, {
    kind: "set_agent_model",
    principal_id: f.principal,
    model: 123,
  });
  assert.equal(setWrongType.status, 400, JSON.stringify(setWrongType.body));
  assert.equal(String(setWrongType.body.message), MODEL_RULE_TEXT);

  /* Control for BOTH set_agent_model cases: the same body with a legal
   * principal_id and a legal model is accepted, so the two refusals above are
   * the rules named and not a command that cannot succeed. */
  const setOk = await send(f.ownerJwt, {
    kind: "set_agent_model",
    principal_id: f.principal,
    model: "gpt-5.6-sol",
  });
  assert.equal(setOk.status, 200, JSON.stringify(setOk.body));

  /* A short model carrying a control character is a CONTROL rule, not a length
   * rule: boundedText refuses both and the length sentence was answering both. */
  const controlModel = await send(f.agentToken, {
    kind: "declare_agent_model",
    model: "gpt\u0007x",
  });
  assert.equal(controlModel.status, 400, JSON.stringify(controlModel.body));
  assert.match(String(controlModel.body.message), /control characters/);

  /* Control: with a VALID kind, the same thread_root_id plus a recipient does
   * get the chat sentence, so the generic answer above is the ordering and not
   * the chat sentence being unreachable. */
  const chatRule = await send(
    f.ownerJwt,
    installedPost({ thread_root_id: rootId, to_user_id: f.otherId }),
  );
  assert.equal(chatRule.status, 400, JSON.stringify(chatRule.body));
  assert.match(String(chatRule.body.message), /thread reply/i);
});

test("the EARLY horizon refusal does not claim the thread ended when it has not", async () => {
  /* Which arm this exercises, stated rather than assumed: `until_ms` equal to
   * the root's own horizon is always caught by the EARLY check, because time
   * has passed since the root was written and remaining_ms is already smaller.
   * The ATOMIC arm's band is (remaining_at_insert, remaining_at_select], one
   * SQL round trip wide, so it is not reachable deterministically from here --
   * a mutation that restored the old lying sentence left this test green,
   * which is how I learned it. That arm's sentence is guarded at source in
   * tests/chat-signal-wire-compat.test.ts instead, and that guard IS mutation
   * checked. */
  const root = await send(f.ownerJwt, installedPost({ until_ms: 90_000 }));
  const rootId = String(signalOf(root.body).id);
  const refused = await send(
    f.ownerJwt,
    installedPost({ thread_root_id: rootId, until_ms: 90_000 }),
  );
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  const message = String(refused.body.message);
  assert.doesNotMatch(
    message,
    /thread ended|that thread ended/i,
    `the thread has ~90s left, so this sentence must not say it ended: ${message}`,
  );
  assert.match(message, /cannot outlive|no longer fits|ends at/i);
});

test("the feedback categories in the refusal come from the constant the check reads", async () => {
  /* Routing every validator reason to the caller made three pre-existing typed
   * lists user-facing. This one listed bug|idea|friction in prose beside a
   * check that tested the same three literals. */
  const refused = await send(f.ownerJwt, {
    kind: "submit_feedback",
    feedback_id: randomUUID(),
    category: "not-a-category",
    body: "x",
  });
  assert.equal(refused.status, 400, JSON.stringify(refused.body));
  const message = String(refused.body.message);
  for (const category of ["bug", "idea", "friction"]) {
    assert.ok(message.includes(category), `must name ${category}: ${message}`);
  }
  /* Control: a valid category is accepted, so the refusal above is the category
   * and not a broken command. */
  const ok = await send(f.ownerJwt, {
    kind: "submit_feedback",
    feedback_id: randomUUID(),
    category: "idea",
    body: `generated categories ${randomUUID()}`,
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
});

/* ---------------------------------------------------------------------------
 * L2: one signal, N recipients. Everything below runs against the SERVED
 * command and read functions and real Postgres, because the claims are about
 * what the two enforcement points do together.
 * ------------------------------------------------------------------------- */

test("a post with `to` stores the first recipient in the scalar column and the whole set beside it", async () => {
  const posted = await send(
    f.agentToken,
    installedPost({
      to: [
        { kind: "user", id: f.otherId },
        { kind: "agent", id: f.principalTwo },
      ],
    }),
  );
  assert.equal(posted.status, 200, JSON.stringify(posted.body));
  const signal = signalOf(posted.body);
  assert.equal(
    signal.to,
    f.otherId,
    "recipient 0 is the scalar to_user_id, so a reader that knows only that column sees a real recipient",
  );
  assert.equal(signal.to_agent, null);
  assert.deepEqual(signal.recipients, [
    { kind: "user", id: f.otherId },
    { kind: "agent", id: f.principalTwo },
  ]);

  const rows = await sql<{ position: number; u: string | null; a: string | null }[]>`
    SELECT position, recipient_user_id AS u, recipient_agent_principal_id AS a
    FROM swarm.signal_recipients
    WHERE signal_id = ${String(signal.id)}::uuid
    ORDER BY position
  `;
  assert.deepEqual(
    rows.map((row) => [row.position, row.u, row.a]),
    [[0, f.otherId, null], [1, null, f.principalTwo]],
  );

  /* The view derives the same set. Two expressions of one rule, compared on
   * the same row rather than trusted to agree. */
  const view = await viewRowAs(f.ownerId, (tx) =>
    tx<{ recipients: unknown }[]>`
      SELECT recipients FROM swarm_read.signals
      WHERE id = ${String(signal.id)}::uuid
    `);
  assert.equal(view.length, 1, "the owner of the addressed agent reads the row");
  assert.deepEqual(
    view[0]!.recipients,
    [
      { kind: "user", id: f.otherId, position: 0 },
      { kind: "agent", id: f.principalTwo, position: 1 },
    ],
    "the view carries the position; the command record carries the order",
  );
});

test("a one-entry `to` and the scalar shape store the same signal row and the same delivery ledger", async () => {
  const viaScalar = await send(
    f.ownerJwt,
    installedPost({ to_agent_principal_id: f.principal, signal_kind: "ask" }),
  );
  assert.equal(viaScalar.status, 200, JSON.stringify(viaScalar.body));
  const viaList = await send(
    f.ownerJwt,
    installedPost({
      signal_kind: "ask",
      to: [{ kind: "agent", id: f.principal }],
    }),
  );
  assert.equal(viaList.status, 200, JSON.stringify(viaList.body));

  const scalarId = String(signalOf(viaScalar.body).id);
  const listId = String(signalOf(viaList.body).id);
  const columns = await sql<Record<string, unknown>[]>`
    SELECT id, from_principal, from_kind, to_user_id, to_agent_principal_id,
           in_reply_to, about, kind, body, channel_id, thread_root_id,
           broadcast_to_channel, workspace_id
    FROM swarm.signals
    WHERE id IN (${scalarId}::uuid, ${listId}::uuid)
    ORDER BY CASE WHEN id = ${scalarId}::uuid THEN 0 ELSE 1 END
  `;
  assert.equal(columns.length, 2);
  const scalarRow = columns[0]!;
  const listRow = columns[1]!;
  for (const column of Object.keys(scalarRow)) {
    /* id and body differ by construction (a fresh uuid and a fresh body per
     * post); every OTHER stored column must be identical. until and created_at
     * are excluded from the SELECT for the same reason. */
    if (column === "id" || column === "body") continue;
    assert.deepEqual(
      listRow[column],
      scalarRow[column],
      `${column} must be identical between the scalar shape and a one-entry list`,
    );
  }

  const ledger = await sql<{ signal_id: string; n: number }[]>`
    SELECT signal_id, count(*)::int AS n
    FROM swarm.signal_deliveries
    WHERE signal_id IN (${scalarId}::uuid, ${listId}::uuid)
    GROUP BY signal_id
  `;
  assert.equal(ledger.length, 2, "both posts wake the agent");
  for (const row of ledger) {
    assert.equal(row.n, 1, `${row.signal_id} must have exactly one delivery row`);
  }

  /* THE ONE THING THAT DIFFERS, named rather than left for a reader to find.
   * The stored signal row, the delivery ledger and the rendered set match; the
   * side table does NOT. A scalar post writes zero recipient rows and a
   * one-entry `to` writes one, and the view's fallback is what makes the two
   * read alike anyway. A review arm called the compat claim inaccurate for
   * leaving this unsaid, so it is asserted here. */
  const sideRows = await sql<{ signal_id: string; n: number }[]>`
    SELECT signal_id, count(*)::int AS n
    FROM swarm.signal_recipients
    WHERE signal_id IN (${scalarId}::uuid, ${listId}::uuid)
    GROUP BY signal_id
  `;
  assert.deepEqual(
    sideRows.map((row) => [row.signal_id, row.n]),
    [[listId, 1]],
    "only the `to` form writes a recipient row; the scalar form writes none",
  );

  /* And the READ is identical too, which is the part an old client sees. */
  const views = await viewRowAs(f.ownerId, (tx) =>
    tx<{ id: string; recipients: unknown }[]>`
      SELECT id, recipients FROM swarm_read.signals
      WHERE id IN (${scalarId}::uuid, ${listId}::uuid)
    `);
  assert.equal(views.length, 2, "the owner of the addressed agent reads both rows");
  const byId = new Map(views.map((row) => [row.id, row.recipients]));
  assert.deepEqual(
    byId.get(listId),
    byId.get(scalarId),
    "the derived set and the stored set render the same recipients",
  );
  assert.deepEqual(byId.get(scalarId), [
    { kind: "agent", id: f.principal, position: 0 },
  ]);
});

test("an agent that is only the SECOND recipient reads the signal, and one that is not addressed does not", async () => {
  /* The two enforcement points, together. The view admits the row to the
   * agents' OWNER; the read edge narrows it to the presenting principal. Both
   * had to move, and an agent addressed anywhere but position 0 is the case
   * that fails if only one of them did. */
  const posted = await send(
    f.ownerJwt,
    installedPost({
      signal_kind: "ask",
      body: `second recipient ${randomUUID()}`,
      to: [
        { kind: "agent", id: f.principal },
        { kind: "agent", id: f.principalTwo },
      ],
    }),
  );
  assert.equal(posted.status, 200, JSON.stringify(posted.body));
  const signalId = String(signalOf(posted.body).id);

  const bySecond = await readSignals(f.agentTokenTwo);
  assert.equal(bySecond.status, 200, JSON.stringify(bySecond.body));
  const secondIds = (bySecond.body.signals as Record<string, unknown>[])
    .map((row) => String(row.id));
  assert.ok(
    secondIds.includes(signalId),
    "the agent at position 1 must read a signal whose scalar column names the agent at position 0",
  );

  const byFirst = await readSignals(f.agentToken);
  const firstIds = (byFirst.body.signals as Record<string, unknown>[])
    .map((row) => String(row.id));
  assert.ok(firstIds.includes(signalId), "and so must the agent at position 0");

  /* inbox: true is a SECOND arm in the same query and had no served case. It
   * narrows to what is addressed to this agent, so the later recipient must
   * still be there -- an inbox that hid it would be the same defect one clause
   * over. */
  const inboxOnly = await readSignals(f.agentTokenTwo, true);
  assert.equal(inboxOnly.status, 200, JSON.stringify(inboxOnly.body));
  assert.ok(
    (inboxOnly.body.signals as Record<string, unknown>[])
      .some((row) => String(row.id) === signalId),
    "the inbox filter reads the recipient set too",
  );

  /* CONTROL: the same shape addressed to ONE agent stays invisible to the
   * other. Without this, "the second agent read it" could mean the arm admits
   * every directed signal to every agent the owner owns. */
  const narrow = await send(
    f.ownerJwt,
    installedPost({
      signal_kind: "ask",
      body: `first only ${randomUUID()}`,
      to: [{ kind: "agent", id: f.principal }],
    }),
  );
  assert.equal(narrow.status, 200, JSON.stringify(narrow.body));
  const narrowId = String(signalOf(narrow.body).id);
  const secondAgain = await readSignals(f.agentTokenTwo);
  assert.equal(
    (secondAgain.body.signals as Record<string, unknown>[])
      .some((row) => String(row.id) === narrowId),
    false,
    "an agent that is not in the recipient set reads nothing new",
  );
});

test("`to` beside a scalar recipient is refused, and the refusal names the field it found", async () => {
  const refused = await send(
    f.ownerJwt,
    installedPost({
      to_user_id: f.otherId,
      to: [{ kind: "user", id: f.otherId }],
    }),
  );
  assert.equal(refused.status, 400, JSON.stringify(refused.body));
  assert.match(
    String(refused.body.message),
    /^to_user_id names a recipient and so does to\./,
  );
  /* Control: the same body with the scalar cleared is accepted, so the refusal
   * is the conflict and not `to` itself. */
  const ok = await send(
    f.ownerJwt,
    installedPost({ to: [{ kind: "user", id: f.otherId }] }),
  );
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
});

test("the recipient cap refuses from the same constant the sentence is built from", async () => {
  const overCap = Array.from(
    { length: SIGNAL_RECIPIENT_MAX + 1 },
    () => ({ kind: "user" as const, id: randomUUID() }),
  );
  const refused = await send(f.ownerJwt, installedPost({ to: overCap }));
  assert.equal(refused.status, 400, JSON.stringify(refused.body));
  assert.match(
    String(refused.body.message),
    new RegExp(`at most ${SIGNAL_RECIPIENT_MAX} recipients`),
  );
  assert.match(
    String(refused.body.message),
    new RegExp(`names ${SIGNAL_RECIPIENT_MAX + 1}\\.`),
    "the count in the sentence is the list's own length, not a typed number",
  );

  /* Control: an EMPTY list is refused for being empty, not for the cap, so the
   * two ends of the bound are told apart. */
  const empty = await send(f.ownerJwt, installedPost({ to: [] }));
  assert.equal(empty.status, 400, JSON.stringify(empty.body));
  assert.match(String(empty.body.message), /at least one recipient/);
});

test("a recipient who is not reachable in this workspace refuses the whole post", async () => {
  /* The same answer the scalar path already gives for a target that is not
   * live: a bare 403, which does not disclose WHICH recipient is unreachable.
   * The post is refused whole -- nothing is stored for the reachable ones. */
  const stranger = randomUUID();
  const refused = await send(
    f.ownerJwt,
    installedPost({
      to: [{ kind: "user", id: f.otherId }, { kind: "user", id: stranger }],
    }),
  );
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  const stored = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM swarm.signal_recipients
    WHERE recipient_user_id = ${stranger}::uuid
  `;
  assert.equal(stored[0]!.n, 0);

  /* Control: the reachable half alone is accepted, so the 403 is the stranger
   * and not the shape of a two-entry list. */
  const ok = await send(
    f.ownerJwt,
    installedPost({ to: [{ kind: "user", id: f.otherId }] }),
  );
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
});

test("working-on and a private reply refuse a `to` list the same way they refuse the scalar fields", async () => {
  const status = await send(
    f.ownerJwt,
    installedPost({
      signal_kind: "working-on",
      to: [{ kind: "user", id: f.otherId }],
    }),
  );
  assert.equal(status.status, 400, JSON.stringify(status.body));
  const statusScalar = await send(
    f.ownerJwt,
    installedPost({ signal_kind: "working-on", to_user_id: f.otherId }),
  );
  assert.equal(statusScalar.status, 400, JSON.stringify(statusScalar.body));
  assert.equal(
    String(status.body.message),
    String(statusScalar.body.message),
    "one rule, one sentence, whichever spelling the caller used",
  );

  /* Control: a working-on with no recipient at all is accepted. */
  const ok = await send(f.ownerJwt, installedPost({ signal_kind: "working-on" }));
  assert.equal(ok.status, 200, JSON.stringify(ok.body));

  /* A STATED BOUND, pinned so nobody reads it as a bug later. A working-on
   * whose `to` ALSO breaks the cap is answered with the generic reason, not the
   * cap sentence: the edge only prefers the chat sentence when nothing else is
   * wrong, and "working-on takes no recipients" is the other thing that is
   * wrong. The cap sentence is reachable whenever the rest of the body is
   * legal, which the cap test above measures. A review arm named this; the
   * accept/refuse boundary does not move, only which sentence is shown. */
  const overCapWorkingOn = await send(
    f.ownerJwt,
    installedPost({
      signal_kind: "working-on",
      to: Array.from(
        { length: SIGNAL_RECIPIENT_MAX + 1 },
        () => ({ kind: "user" as const, id: randomUUID() }),
      ),
    }),
  );
  assert.equal(overCapWorkingOn.status, 400, JSON.stringify(overCapWorkingOn.body));
  assert.equal(
    String(overCapWorkingOn.body.message),
    "signal fields are malformed or over their limits",
  );
});

test("an installed client's post is unchanged by the existence of `to`", async () => {
  /* The wire-compat case, served. This body is byte for byte what 0.1.54
   * sends: no `to` key at all. */
  const posted = await send(f.ownerJwt, installedPost());
  assert.equal(posted.status, 200, JSON.stringify(posted.body));
  const signal = signalOf(posted.body);
  assert.equal(signal.to, null);
  assert.equal(signal.to_agent, null);
  assert.deepEqual(
    signal.recipients,
    [],
    "a signal addressed to nobody carries an empty set, not a null",
  );
  const rows = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM swarm.signal_recipients
    WHERE signal_id = ${String(signal.id)}::uuid
  `;
  assert.equal(rows[0]!.n, 0, "and writes nothing to the new table");
});

test("the SECOND recipient can reply privately, the way the first always could", async () => {
  /* Found by a review arm rather than by a test. in_reply_to's authorization
   * read the scalar columns, which carry recipient 0 only, so a signal a later
   * recipient could READ was one they could not answer. A message you can read
   * and cannot reply to is a trap the addressing itself creates. */
  const posted = await send(
    f.ownerJwt,
    installedPost({
      signal_kind: "ask",
      body: `reply from the second recipient ${randomUUID()}`,
      to: [{ kind: "user", id: f.ownerId }, { kind: "user", id: f.otherId }],
    }),
  );
  assert.equal(posted.status, 200, JSON.stringify(posted.body));
  const rootId = String(signalOf(posted.body).id);

  const reply = await send(
    f.otherJwt,
    installedPost({ signal_kind: "note", in_reply_to: rootId }),
  );
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.equal(
    signalOf(reply.body).to,
    f.ownerId,
    "the reply is re-addressed to the author, exactly as a scalar recipient's is",
  );

  /* CONTROL: someone who is NOT in the recipient set still cannot reply. The
   * second arm reads the recipient set, not "any member". `other` is the only
   * other member in this fixture, so the negative case uses a signal that names
   * only the owner. */
  const narrow = await send(
    f.ownerJwt,
    installedPost({
      signal_kind: "ask",
      body: `owner only ${randomUUID()}`,
      to: [{ kind: "user", id: f.ownerId }],
    }),
  );
  assert.equal(narrow.status, 200, JSON.stringify(narrow.body));
  const refused = await send(
    f.otherJwt,
    installedPost({
      signal_kind: "note",
      in_reply_to: String(signalOf(narrow.body).id),
    }),
  );
  assert.equal(
    refused.status,
    403,
    `a non-recipient must not be able to reply: ${JSON.stringify(refused.body)}`,
  );
});

test("addressing a second agent wakes it too, and wakes the first exactly once", async () => {
  /* THE RETIRED BOUND OF L2, kept because a reader may still meet it in section
   * 4 of 20260905000010 and in this file's history:
   *
   *   "recipients 1..N are readable and repliable and are NOT woken. Two things
   *    would have to move together for that to change ... hydrateDeliveryRefs
   *    filters on swarm.signals.to_agent_principal_id (the scalar column, which
   *    holds recipient 0), and src/cloud/delivery.ts:423 makes an installed
   *    listener refuse a delivery whose signal.to_agent is not its own
   *    principal."
   *
   * Both moved, in 20260905000020. Every agent recipient gets a delivery row. */
  const posted = await send(
    f.ownerJwt,
    installedPost({
      signal_kind: "ask",
      body: `two agents ${randomUUID()}`,
      to: [{ kind: "agent", id: f.principal }, { kind: "agent", id: f.principalTwo }],
    }),
  );
  assert.equal(posted.status, 200, JSON.stringify(posted.body));
  const signalId = String(signalOf(posted.body).id);

  const ledger = await sql<{ recipient_agent_principal_id: string }[]>`
    SELECT recipient_agent_principal_id
    FROM swarm.signal_deliveries
    WHERE signal_id = ${signalId}::uuid
    ORDER BY recipient_agent_principal_id
  `;
  assert.deepEqual(
    ledger.map((row) => row.recipient_agent_principal_id),
    [f.principal, f.principalTwo].sort(),
    "both agents are woken, and neither twice",
  );

  const stored = await sql<{ recipient_agent_principal_id: string | null }[]>`
    SELECT recipient_agent_principal_id
    FROM swarm.signal_recipients
    WHERE signal_id = ${signalId}::uuid
    ORDER BY position
  `;
  assert.deepEqual(
    stored.map((row) => row.recipient_agent_principal_id),
    [f.principal, f.principalTwo],
  );

  /* CONTROL: a post naming only the first agent still writes one row, so the
   * two rows above come from the second recipient and not from the fan-out
   * doubling every signal. */
  const narrow = await send(
    f.ownerJwt,
    installedPost({
      signal_kind: "ask",
      body: `one agent ${randomUUID()}`,
      to: [{ kind: "agent", id: f.principal }],
    }),
  );
  assert.equal(narrow.status, 200, JSON.stringify(narrow.body));
  const narrowLedger = await sql<{ recipient_agent_principal_id: string }[]>`
    SELECT recipient_agent_principal_id
    FROM swarm.signal_deliveries
    WHERE signal_id = ${String(signalOf(narrow.body).id)}::uuid
  `;
  assert.deepEqual(
    narrowLedger.map((row) => row.recipient_agent_principal_id),
    [f.principal],
  );
});

test("a person first and an agent second wakes the agent, which L2 did not", async () => {
  /* The exact shape the retired clause was about. The scalar column holds a
   * PERSON, so the trigger on swarm.signals writes nothing; the trigger on
   * swarm.signal_recipients writes the agent's row. */
  const posted = await send(
    f.ownerJwt,
    installedPost({
      signal_kind: "ask",
      body: `person then agent ${randomUUID()}`,
      to: [{ kind: "user", id: f.otherId }, { kind: "agent", id: f.principal }],
    }),
  );
  assert.equal(posted.status, 200, JSON.stringify(posted.body));
  const signalId = String(signalOf(posted.body).id);
  const signal = signalOf(posted.body);
  assert.equal(signal.to, f.otherId, "the scalar recipient is the person");
  assert.equal(signal.to_agent, null, "and no agent is in the scalar column");

  const ledger = await sql<{ recipient_agent_principal_id: string }[]>`
    SELECT recipient_agent_principal_id
    FROM swarm.signal_deliveries
    WHERE signal_id = ${signalId}::uuid
  `;
  assert.deepEqual(
    ledger.map((row) => row.recipient_agent_principal_id),
    [f.principal],
    "the agent named after the person is woken",
  );
});

/**
 * Everything a 0.1.55 listener checks on one claimed delivery row, reproduced
 * from src/cloud/delivery.ts as that release shipped it. Nothing here reads the
 * fields this lane added, which is the point: a client that has never heard of
 * recipient_position must still accept a row it holds at position 1.
 */
function accepted0155(
  row: Record<string, unknown>,
  expected: { workspaceId: string; principalId: string },
): void {
  const signal = row.signal as Record<string, unknown>;
  assert.ok(signal, "a delivery row carries a signal");
  assert.equal(signal.workspace_id, expected.workspaceId);
  assert.equal(
    signal.to_agent,
    expected.principalId,
    "0.1.55 refuses a delivery whose signal.to_agent is not its own principal",
  );
  assert.ok(
    ["ask", "note"].includes(String(signal.kind)),
    "0.1.55 refuses a non-direct kind",
  );
  assert.equal(typeof row.lease_id, "string");
  assert.equal(typeof row.leased_until, "string");
  assert.ok(
    ["same_owner", "cross_owner", "unknown"].includes(
      String(row.sender_owner_relation),
    ),
  );
  assert.ok(Date.parse(String(row.leased_until)) > Date.now(), "the lease is live");
}

test("a 0.1.55 listener claims, hydrates and replies to a delivery it holds at position 1", async () => {
  /* THE WIRE-COMPAT CLAIM, and the reason the edge answers each delivery row
   * with THAT ROW'S recipient in `to_agent`. The checks in accepted0155 are the
   * ones the shipped client runs; none of them knows about recipient sets. */
  const posted = await send(
    f.ownerJwt,
    installedPost({
      signal_kind: "ask",
      body: `second seat claims ${randomUUID()}`,
      to: [{ kind: "agent", id: f.principal }, { kind: "agent", id: f.principalTwo }],
    }),
  );
  assert.equal(posted.status, 200, JSON.stringify(posted.body));
  const signalId = String(signalOf(posted.body).id);
  const listener = randomUUID();

  const claim = await send(f.agentTokenTwo, {
    kind: "claim_agent_inbox",
    listener_instance_id: listener,
    limit: 10,
  });
  assert.equal(claim.status, 200, JSON.stringify(claim.body));
  const deliveries = claim.body.deliveries as Array<Record<string, unknown>>;
  const mine = deliveries.find((row) =>
    (row.signal as Record<string, unknown>).id === signalId
  );
  assert.ok(mine, `the second agent's claim must return its own row: ${JSON.stringify(claim.body)}`);
  accepted0155(mine, { workspaceId: f.workspace, principalId: f.principalTwo });

  /* The fields this lane added, checked separately so the block above stays a
   * faithful 0.1.55 reproduction. */
  assert.equal(mine.recipient_position, 1);
  assert.equal(mine.recipient_count, 2);
  assert.equal(
    (claim.body.capabilities as Record<string, unknown>).recipient_fanout,
    1,
  );

  const ack = await send(f.agentTokenTwo, {
    kind: "ack_agent_delivery",
    signal_id: signalId,
    lease_id: mine.lease_id,
    listener_instance_id: listener,
    outcome: "replied",
    last_error_code: null,
  });
  assert.equal(ack.status, 200, JSON.stringify(ack.body));
  const acked = await sql<{ ack_outcome: string }[]>`
    SELECT ack_outcome
    FROM swarm.signal_deliveries
    WHERE signal_id = ${signalId}::uuid
      AND recipient_agent_principal_id = ${f.principalTwo}::uuid
  `;
  assert.equal(acked[0]?.ack_outcome, "replied");

  /* CONTROL: the FIRST agent's own row is untouched by the second agent's
   * acknowledgement, so the claim and ack paths treat each row independently. */
  const first = await sql<{ ack_outcome: string | null; lease_id: string | null }[]>`
    SELECT ack_outcome, lease_id::text
    FROM swarm.signal_deliveries
    WHERE signal_id = ${signalId}::uuid
      AND recipient_agent_principal_id = ${f.principal}::uuid
  `;
  assert.equal(first[0]?.ack_outcome, null);
  assert.equal(first[0]?.lease_id, null);

  /* CONTROL: the first agent can still claim and hydrate its own row after the
   * second answered, and it sees ITSELF at position 0. */
  const firstClaim = await send(f.agentToken, {
    kind: "claim_agent_inbox",
    listener_instance_id: randomUUID(),
    limit: 10,
  });
  assert.equal(firstClaim.status, 200, JSON.stringify(firstClaim.body));
  const firstRows = firstClaim.body.deliveries as Array<Record<string, unknown>>;
  const firstMine = firstRows.find((row) =>
    (row.signal as Record<string, unknown>).id === signalId
  );
  assert.ok(firstMine, "the first agent still holds its own row");
  accepted0155(firstMine, { workspaceId: f.workspace, principalId: f.principal });
  assert.equal(firstMine.recipient_position, 0);
  assert.equal(firstMine.recipient_count, 2);
});

test("the sender's receipt names every agent that was woken", async () => {
  /* The receipt aggregates swarm.signal_deliveries for the signal, so the
   * fan-out reaches it with no receipt-side change. The bound this does NOT
   * close: the human half of that aggregate names only the scalar to_user_id,
   * so a PERSON at position 1 still has no receipt row. People are not woken,
   * so it is not this lane's claim to make. */
  const posted = await send(
    f.ownerJwt,
    installedPost({
      signal_kind: "ask",
      body: `receipt for two ${randomUUID()}`,
      to: [{ kind: "agent", id: f.principal }, { kind: "agent", id: f.principalTwo }],
    }),
  );
  assert.equal(posted.status, 200, JSON.stringify(posted.body));
  const signalId = String(signalOf(posted.body).id);

  /* The read edge answers delivery_receipts only for an AGENT credential; a
   * person reads the same function over PostgREST. So this calls the function
   * with the author's own claims installed, which is the human path. */
  const body = await viewRowAs(f.ownerId, async (tx) => {
    const rows = await tx<{ receipts: Record<string, unknown> }[]>`
      SELECT swarm_read.signal_delivery_receipts(
        ${f.workspace}::uuid,
        ${signalId}::uuid,
        NULL
      ) AS receipts
    `;
    return rows[0]?.receipts as Record<string, unknown>;
  });
  assert.ok(body, "the author can read the receipt");
  assert.equal(body.addressed, true);
  const receipts = body.receipts as Array<Record<string, unknown>>;
  const agents = receipts
    .map((row) => row.recipient_agent_principal_id)
    .filter((value): value is string => typeof value === "string")
    .sort();
  assert.deepEqual(
    agents,
    [f.principal, f.principalTwo].sort(),
    "the sender sees a row per woken agent",
  );
});

test("a second AGENT recipient can reply, not only a second person", async () => {
  /* The reply arm reads the recipient set for an agent caller through its
   * presenting principal, which is a different branch from the human one. */
  const posted = await send(
    f.ownerJwt,
    installedPost({
      signal_kind: "ask",
      body: `agent reply ${randomUUID()}`,
      to: [{ kind: "agent", id: f.principal }, { kind: "agent", id: f.principalTwo }],
    }),
  );
  assert.equal(posted.status, 200, JSON.stringify(posted.body));
  const rootId = String(signalOf(posted.body).id);

  const reply = await send(
    f.agentTokenTwo,
    installedPost({ signal_kind: "note", in_reply_to: rootId }),
  );
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.equal(
    signalOf(reply.body).to,
    f.ownerId,
    "the reply is re-addressed to the human author",
  );

  /* CONTROL: an agent that is NOT in the set still cannot reply. The narrow
   * post names only the first agent. */
  const narrow = await send(
    f.ownerJwt,
    installedPost({
      signal_kind: "ask",
      body: `first agent only ${randomUUID()}`,
      to: [{ kind: "agent", id: f.principal }],
    }),
  );
  assert.equal(narrow.status, 200, JSON.stringify(narrow.body));
  const refused = await send(
    f.agentTokenTwo,
    installedPost({
      signal_kind: "note",
      in_reply_to: String(signalOf(narrow.body).id),
    }),
  );
  assert.equal(
    refused.status,
    403,
    `an agent outside the set must not reply: ${JSON.stringify(refused.body)}`,
  );
});

/** One read-edge request, so a new resource can be probed the way signals are. */
async function readResource(
  bearer: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${local.API_URL}/functions/v1/read`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: await response.json() as Record<string, unknown>,
  };
}

test("an agent credential can list channels, with the same tenancy every resource here takes", async () => {
  /* The gap this closes: an agent could create a channel, post into one by
   * name and read one by name, and could not enumerate them, because the read
   * edge had no channels arm. `swarm_read.channels` was already granted to the
   * swarm_read role and already gated on swarm.is_member(workspace_id,
   * auth.uid()), and the function already installs the agent owner's claims
   * before this query runs, so the widening is the arm and not the view. */
  const slug = `agent-ls-${randomUUID().slice(0, 8)}`;
  const created = await send(f.agentToken, { kind: "channel_create", slug });
  assert.equal(created.status, 200, JSON.stringify(created.body));

  const listed = await readResource(f.agentToken, {
    resource: "channels",
    workspace_id: f.workspace,
  });
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  const channels = listed.body.channels as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(channels), "the envelope carries a channels array");
  const found = channels.find((row) => row.slug === slug);
  assert.ok(found, `the channel this test created must be listed: ${JSON.stringify(listed.body)}`);
  /* Generated from the constant the edge builds its SELECT from, so this cannot
   * become a fourth typed copy of the column list. It measures the KEYS that
   * actually came back, which is the half tests/chat-channel-constants.test.ts
   * cannot reach: that one compares the two exported arrays and never runs a
   * query. */
  assert.deepEqual(
    Object.keys(found).sort(),
    [...CHANNEL_READ_COLUMNS, "unread"].sort(),
    "the agent path returns exactly the columns CHANNEL_READ_COLUMNS names, plus the agent's own unread",
  );
  assert.ok("general_unread" in listed.body, "general's unread rides beside the rows");

  /* TENANCY: another workspace is an empty envelope, not a 403 and not another
   * tenant's rows. That is the shape every resource in this function uses. */
  const elsewhere = await readResource(f.agentToken, {
    resource: "channels",
    workspace_id: randomUUID(),
  });
  assert.equal(elsewhere.status, 200, JSON.stringify(elsewhere.body));
  assert.deepEqual(elsewhere.body, { channels: [] });

  /* An unknown key is refused by the same exact-key parse the other resources
   * take, so the arm cannot be widened by a caller. */
  const extra = await readResource(f.agentToken, {
    resource: "channels",
    workspace_id: f.workspace,
    include_archived: true,
  });
  assert.equal(extra.status, 400, JSON.stringify(extra.body));
  assert.equal(extra.body.error, "invalid_request");

  /* A human JWT still reaches only renewal_grants on this function; people read
   * channels over REST. This is the pre-existing rule, restated as a control so
   * the new arm is not read as opening the function to browser sessions. */
  const human = await readResource(f.ownerJwt, {
    resource: "channels",
    workspace_id: f.workspace,
  });
  assert.equal(human.status, 401, JSON.stringify(human.body));
});

test("an archived channel is listed to an agent, with the date that says so", async () => {
  /* The list carries archived_at rather than hiding archived rows, which is
   * what the human REST read does, so both callers can render the same thing.
   * A filter here would make the two paths disagree. */
  const slug = `agent-arch-${randomUUID().slice(0, 8)}`;
  const created = await send(f.agentToken, { kind: "channel_create", slug });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const channelId = String(
    (created.body.channel as Record<string, unknown>).channel_id,
  );

  const before = await readResource(f.agentToken, {
    resource: "channels",
    workspace_id: f.workspace,
  });
  const liveRow = (before.body.channels as Array<Record<string, unknown>>)
    .find((row) => row.channel_id === channelId);
  assert.ok(liveRow, "control: the channel is listed while it is live");
  assert.equal(liveRow.archived_at, null);

  const archived = await send(f.agentToken, {
    kind: "channel_archive",
    channel_id: channelId,
  });
  assert.equal(archived.status, 200, JSON.stringify(archived.body));

  const after = await readResource(f.agentToken, {
    resource: "channels",
    workspace_id: f.workspace,
  });
  const archivedRow = (after.body.channels as Array<Record<string, unknown>>)
    .find((row) => row.channel_id === channelId);
  assert.ok(archivedRow, "an archived channel stays in the list");
  assert.notEqual(
    archivedRow.archived_at,
    null,
    "and it carries the date that says it is archived",
  );
});

/* -------------------------------------------------------------------------
 * Roster R1b: reraise_ask. Only the ask's exact sender, while the ask is open
 * and unexpired, once per 24 hours per ask; one note to the ask's own
 * audience, in reply to the ask, never outliving it. Exact retries replay.
 * ------------------------------------------------------------------------- */

async function sendWithId(
  bearer: string,
  commandId: string,
  command: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${local.API_URL}/functions/v1/command`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify({
      command_id: commandId, client_version: "0.1.0", workspace_id: f.workspace,
      stream: { kind: "workspace" }, command,
    }),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function askToPeople(): Promise<{ id: string; until: string; body: string }> {
  const body = `R1b ask ${randomUUID()}`;
  const posted = await send(f.agentToken, installedPost({
    signal_kind: "ask", body,
    to: [{ kind: "user", id: f.ownerId }, { kind: "user", id: f.otherId }],
  }));
  assert.equal(posted.status, 200, JSON.stringify(posted.body));
  const signal = signalOf(posted.body);
  return { id: signal.id as string, until: signal.until as string, body };
}

async function notesInReplyTo(askId: string): Promise<Array<{ id: string; from_principal: string; body: string; until: Date; to_user_id: string | null }>> {
  return await sql`SELECT id, from_principal, body, until, to_user_id FROM swarm.signals
    WHERE workspace_id = ${f.workspace}::uuid AND in_reply_to = ${askId}::uuid ORDER BY created_at`;
}

test("reraise_ask sends one note to the ask's own audience, no later than the ask, and an exact retry replays it", async () => {
  const ask = await askToPeople();
  const commandId = randomUUID();
  const raised = await sendWithId(f.agentToken, commandId, { kind: "reraise_ask", signal_id: ask.id });
  assert.equal(raised.status, 200, JSON.stringify(raised.body));
  const note = signalOf(raised.body);
  assert.equal(note.kind, "note");
  assert.equal(note.in_reply_to, ask.id);
  assert.equal(note.body, `Still waiting: ${ask.body}`);
  assert.ok(Date.parse(note.until as string) <= Date.parse(ask.until), "the note never outlives the ask");
  const reraise = raised.body.reraise as Record<string, unknown>;
  assert.equal(reraise.count, 1);
  const recipients = await sql`SELECT recipient_user_id FROM swarm.signal_recipients
    WHERE workspace_id = ${f.workspace}::uuid AND signal_id = ${note.id as string}::uuid ORDER BY position`;
  assert.deepEqual(recipients.map((row) => row.recipient_user_id), [f.ownerId, f.otherId],
    "the audience is the ask's recipient rows, copied in order");

  const replay = await sendWithId(f.agentToken, commandId, { kind: "reraise_ask", signal_id: ask.id });
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal(signalOf(replay.body).id, note.id, "the same command id answers with the stored note");
  assert.equal((await notesInReplyTo(ask.id)).length, 1, "a replay writes no second note");
  const [ledger] = await sql`SELECT raise_count FROM swarm.ask_reraises
    WHERE workspace_id = ${f.workspace}::uuid AND signal_id = ${ask.id}::uuid`;
  assert.equal(ledger?.raise_count, 1, "a replay charges no second re-raise");

  const changed = await sendWithId(f.agentToken, commandId, { kind: "reraise_ask", signal_id: (await askToPeople()).id });
  assert.equal(changed.status, 409);
  assert.equal(changed.body.error, "command_id_conflict");

  const tooSoon = await send(f.agentToken, { kind: "reraise_ask", signal_id: ask.id });
  assert.equal(tooSoon.status, 429, JSON.stringify(tooSoon.body));
  assert.equal(tooSoon.body.error, "reraise_too_soon");
  assert.equal(typeof tooSoon.body.retry_after, "string");
  const [unchanged] = await sql`SELECT raise_count, last_raised_at FROM swarm.ask_reraises
    WHERE workspace_id = ${f.workspace}::uuid AND signal_id = ${ask.id}::uuid`;
  assert.equal(unchanged?.raise_count, 1, "a refused attempt doesn't advance the cap");
  assert.equal((await notesInReplyTo(ask.id)).length, 1);

  // A day later the slot opens again.
  await sql`UPDATE swarm.ask_reraises SET last_raised_at = last_raised_at - interval '25 hours'
    WHERE workspace_id = ${f.workspace}::uuid AND signal_id = ${ask.id}::uuid`;
  const again = await send(f.agentToken, { kind: "reraise_ask", signal_id: ask.id });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal((again.body.reraise as Record<string, unknown>).count, 2);
});

test("reraise_ask: only the exact sender, only an open addressed ask", async () => {
  const ask = await askToPeople();
  // Another agent of the same person is not the sender; a person is not the sender either.
  for (const bearer of [f.agentTokenTwo, f.ownerJwt]) {
    const refused = await send(bearer, { kind: "reraise_ask", signal_id: ask.id });
    assert.equal(refused.status, 404, JSON.stringify(refused.body));
  }
  // The sender's own follow-up keeps the ask open (it never answers its own ask).
  await sql`INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, in_reply_to, kind, body, until, created_at)
    VALUES (${randomUUID()}::uuid, ${f.workspace}::uuid, ${f.principal}::uuid, 'agent', ${ask.id}::uuid, 'note', 'more context',
      statement_timestamp() + interval '1 hour', statement_timestamp())`;
  const [open] = await sql`SELECT swarm.ask_answered(${f.workspace}::uuid, ${ask.id}::uuid) AS answered`;
  assert.equal(open?.answered, false);
  // An addressed person's answer closes it.
  const answered = await send(f.otherJwt, installedPost({ in_reply_to: ask.id, body: "Tuesday" }));
  assert.equal(answered.status, 200, JSON.stringify(answered.body));
  const late = await send(f.agentToken, { kind: "reraise_ask", signal_id: ask.id });
  assert.equal(late.status, 409);
  assert.equal(late.body.error, "ask_answered");
  // A broadcast ask has no audience to copy, so it is refused rather than widened.
  const broadcast = await send(f.agentToken, installedPost({ signal_kind: "ask", body: `R1b broadcast ${randomUUID()}` }));
  assert.equal(broadcast.status, 200, JSON.stringify(broadcast.body));
  const wide = await send(f.agentToken, { kind: "reraise_ask", signal_id: signalOf(broadcast.body).id });
  assert.equal(wide.status, 409);
  assert.equal(wide.body.error, "reraise_unsupported");
  // Unknown fields are refused: no caller-supplied audience or body.
  const extra = await send(f.agentToken, { kind: "reraise_ask", signal_id: ask.id, to: [{ kind: "user", id: f.ownerId }] });
  assert.equal(extra.status, 400);
});

test("reraise_ask is refused in an archived channel, like any new message there", async () => {
  const slug = `reraise-${randomBytes(4).toString("hex")}`;
  const created = await send(f.ownerJwt, { kind: "channel_create", slug });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const channel = created.body.channel as Record<string, unknown>;
  const asked = await send(f.agentToken, installedPost({
    signal_kind: "ask", body: `R1b channel ask ${randomUUID()}`, channel: slug,
    to: [{ kind: "user", id: f.ownerId }],
  }));
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  const askId = signalOf(asked.body).id as string;
  const archived = await send(f.ownerJwt, { kind: "channel_archive", channel_id: channel.channel_id });
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  const refused = await send(f.agentToken, { kind: "reraise_ask", signal_id: askId });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.error, "channel_archived");
  assert.equal((await notesInReplyTo(askId)).length, 0, "no note is written");
  const [ledger] = await sql`SELECT count(*)::int AS n FROM swarm.ask_reraises
    WHERE workspace_id = ${f.workspace}::uuid AND signal_id = ${askId}::uuid`;
  assert.equal(ledger?.n, 0, "and the cap isn't charged");
});

/* -------------------------------------------------------------------------
 * Channels C2 (owner decision, 2026-11-04): "general" is reserved for unfiled
 * messages; rename and archive belong to the channel's creator and workspace
 * owners and admins. Creation stays open to members and seated agents.
 * ------------------------------------------------------------------------- */

test("general is a reserved channel name", async () => {
  const refused = await send(f.ownerJwt, { kind: "channel_create", slug: "general" });
  assert.equal(refused.status, 400, JSON.stringify(refused.body));
  const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM swarm.channels
    WHERE workspace_id = ${f.workspace}::uuid AND lower(slug) = 'general'`;
  assert.equal(row?.n, 0);
});

test("only the creator or a workspace owner or admin renames or archives a channel", async () => {
  const slug = `c2-${randomBytes(4).toString("hex")}`;
  const created = await send(f.agentToken, { kind: "channel_create", slug });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const channelId = String((created.body.channel as Record<string, unknown>).channel_id);

  // A plain member, and another agent of the same owner, are neither the creator nor an admin.
  for (const bearer of [f.otherJwt, f.agentTokenTwo]) {
    const rename = await send(bearer, { kind: "channel_rename", channel_id: channelId, slug: `${slug}-x` });
    assert.equal(rename.status, 403, JSON.stringify(rename.body));
    assert.equal(rename.body.error, "channel_forbidden");
    const archive = await send(bearer, { kind: "channel_archive", channel_id: channelId });
    assert.equal(archive.status, 403, JSON.stringify(archive.body));
  }
  const [unchanged] = await sql<{ slug: string; archived_at: Date | null }[]>`
    SELECT slug, archived_at FROM swarm.channels WHERE channel_id = ${channelId}::uuid`;
  assert.deepEqual([unchanged?.slug, unchanged?.archived_at], [slug, null], "refusals change nothing");

  // The workspace owner may rename it; the creating agent may archive it.
  const renamed = await send(f.ownerJwt, { kind: "channel_rename", channel_id: channelId, slug: `${slug}-y` });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  const archived = await send(f.agentToken, { kind: "channel_archive", channel_id: channelId });
  assert.equal(archived.status, 200, JSON.stringify(archived.body));

  // A member still creates channels.
  const memberMade = await send(f.otherJwt, { kind: "channel_create", slug: `${slug}-m` });
  assert.equal(memberMade.status, 200, JSON.stringify(memberMade.body));
});

test("channel names: concurrent creates and renames get one winner and channel_exists, never a server error", async () => {
  const outcome = (response: { status: number; body: Record<string, unknown> }) =>
    response.status === 200 ? "ok" : `${response.status} ${String(response.body.error)}`;
  const slug = `race-${randomBytes(4).toString("hex")}`;
  const creates = await Promise.all(Array.from({ length: 6 }, () => send(f.ownerJwt, { kind: "channel_create", slug })));
  assert.deepEqual(creates.map(outcome).sort(), ["409 channel_exists", "409 channel_exists", "409 channel_exists",
    "409 channel_exists", "409 channel_exists", "ok"], JSON.stringify(creates.map((r) => r.body)));

  const ids: string[] = [];
  for (const n of [1, 2, 3, 4]) {
    const made = await send(f.ownerJwt, { kind: "channel_create", slug: `${slug}-${n}` });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    ids.push(String((made.body.channel as Record<string, unknown>).channel_id));
  }
  const target = `${slug}-renamed`;
  const renames = await Promise.all(ids.map((channel_id) => send(f.ownerJwt, { kind: "channel_rename", channel_id, slug: target })));
  assert.deepEqual(renames.map(outcome).sort(), ["409 channel_exists", "409 channel_exists", "409 channel_exists", "ok"],
    JSON.stringify(renames.map((r) => r.body)));
  const [named] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM swarm.channels
    WHERE workspace_id = ${f.workspace}::uuid AND lower(slug) = ${target}`;
  assert.equal(named?.n, 1);
});

test("channel names: an archived name says how to free it, and renaming the archived channel frees it", async () => {
  const slug = `arch-${randomBytes(4).toString("hex")}`;
  const made = await send(f.ownerJwt, { kind: "channel_create", slug });
  const channelId = String((made.body.channel as Record<string, unknown>).channel_id);
  const live = await send(f.ownerJwt, { kind: "channel_create", slug });
  assert.equal(live.status, 409);
  assert.equal(live.body.message, `This workspace already has a channel named ${slug}. Post to it instead.`);

  assert.equal((await send(f.ownerJwt, { kind: "channel_archive", channel_id: channelId })).status, 200);
  const archived = await send(f.ownerJwt, { kind: "channel_create", slug });
  assert.equal(archived.status, 409);
  assert.equal(archived.body.error, "channel_exists");
  assert.equal(archived.body.message, `An archived channel is named ${slug}. Pick another name, or have its creator or a workspace owner or admin rename the archived channel to free this one.`);

  const freed = await send(f.ownerJwt, { kind: "channel_rename", channel_id: channelId, slug: `${slug}-old` });
  assert.equal(freed.status, 200, JSON.stringify(freed.body));
  const again = await send(f.ownerJwt, { kind: "channel_create", slug });
  assert.equal(again.status, 200, JSON.stringify(again.body));
});

/* -------------------------------------------------------------------------
 * Channels C3: channel_messages through the read function, as an agent.
 * Only whole-workspace messages; general alone is unfiled; refusals are exact.
 * ------------------------------------------------------------------------- */

test("an agent reads a channel's whole-workspace messages, never addressed ones", async () => {
  const slug = `c3-${randomBytes(4).toString("hex")}`;
  const created = await send(f.ownerJwt, { kind: "channel_create", slug });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const open = await send(f.ownerJwt, installedPost({ channel: slug, body: `C3 open ${randomUUID()}` }));
  assert.equal(open.status, 200, JSON.stringify(open.body));
  const openId = String(signalOf(open.body).id);
  const addressed = await send(f.ownerJwt, installedPost({ channel: slug, body: `C3 addressed ${randomUUID()}`,
    to: [{ kind: "user", id: f.otherId }] }));
  assert.equal(addressed.status, 200, JSON.stringify(addressed.body));
  const addressedId = String(signalOf(addressed.body).id);

  const read = (extra: Record<string, unknown>) => readResource(f.agentToken, { resource: "channel_messages", workspace_id: f.workspace, ...extra });
  const page = await read({ channel: slug });
  assert.equal(page.status, 200, JSON.stringify(page.body));
  const ids = (page.body.messages as Array<Record<string, unknown>>).map((m) => m.signal_id);
  assert.ok(ids.includes(openId), "the whole-workspace message is listed");
  assert.equal(ids.includes(addressedId), false, "the addressed message never is");
  const general = await read({ channel: "general" });
  assert.equal(general.status, 200, JSON.stringify(general.body));
  assert.equal((general.body.messages as Array<Record<string, unknown>>).some((m) => m.signal_id === openId), false,
    "general is unfiled messages only");

  assert.equal((await read({ channel: `missing-${randomBytes(3).toString("hex")}` })).status, 404);
  assert.equal((await read({ channel: "all-signals" })).status, 400, "a reserved non-channel name is refused");
  assert.equal((await read({ channel: slug, after_id: randomUUID() })).status, 400, "an unknown cursor is refused");
  assert.equal((await read({ channel: slug, extra: true })).status, 400);
});

/* -------------------------------------------------------------------------
 * Channels C1b for agents: channel_read moves the agent's read position to the
 * last message it returned, and channel_ls reports unread from it.
 * ------------------------------------------------------------------------- */

test("an agent's channel_ls unread clears only once channel_read has returned every newer message", async () => {
  // Only a read that declares max_bytes (the caller delivers the page whole) moves the position.
  const read = (extra: Record<string, unknown>) => readResource(f.agentToken, { resource: "channel_messages", workspace_id: f.workspace, max_bytes: 64 * 1024, ...extra });
  const legacyRead = (extra: Record<string, unknown>) => readResource(f.agentToken, { resource: "channel_messages", workspace_id: f.workspace, ...extra });
  const unreadOf = async (slug: string) => {
    const listed = await readResource(f.agentToken, { resource: "channels", workspace_id: f.workspace });
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    return (listed.body.channels as Array<Record<string, unknown>>).find((row) => row.slug === slug)?.unread;
  };
  // Any read gives the agent a read position in this workspace; the channel below is newer than it.
  assert.equal((await read({ channel: "general" })).status, 200);
  const slug = `unread-${randomBytes(4).toString("hex")}`;
  assert.equal((await send(f.ownerJwt, { kind: "channel_create", slug })).status, 200);
  const posted: string[] = [];
  for (let i = 0; i < 2; i += 1) {
    const post = await send(f.ownerJwt, installedPost({ channel: slug, body: `unread ${i} ${"x".repeat(800)}` }));
    assert.equal(post.status, 200, JSON.stringify(post.body));
    posted.push(String(signalOf(post.body).id));
  }
  assert.equal(await unreadOf(slug), true);

  // A page the caller bounds to one message moves the position to that message only.
  const first = await read({ channel: slug, max_bytes: 1024 });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual((first.body.messages as Array<Record<string, unknown>>).map((m) => m.signal_id), [posted[0]]);
  assert.deepEqual(first.body.next, { after_id: posted[0] });
  assert.equal(await unreadOf(slug), true, "the message the page left out is still unread");
  const rest = await read({ channel: slug, after_id: posted[0] });
  assert.deepEqual((rest.body.messages as Array<Record<string, unknown>>).map((m) => m.signal_id), [posted[1]]);
  assert.equal(await unreadOf(slug), false);
  // Reading from the start again never moves it back.
  assert.equal((await read({ channel: slug, max_bytes: 1024 })).status, 200);
  assert.equal(await unreadOf(slug), false);

  const newer = await send(f.ownerJwt, installedPost({ channel: slug }));
  assert.equal(newer.status, 200, JSON.stringify(newer.body));
  assert.equal(await unreadOf(slug), true, "a newer message is unread again");

  // A read without max_bytes (every installed client today, including a local MCP server that trims
  // a 64 KiB page to its own 32 KiB) still reads, but never moves the position. Five notes near the
  // 8,000-character body limit make a page the local MCP server would trim.
  const notes: string[] = [];
  for (let i = 0; i < 5; i += 1) {
    const note = await send(f.ownerJwt, installedPost({ channel: slug, body: `legacy ${i} ${"y".repeat(7900)}` }));
    assert.equal(note.status, 200, JSON.stringify(note.body));
    notes.push(String(signalOf(note.body).id));
  }
  const legacy = await legacyRead({ channel: slug, after_id: posted[1] });
  assert.equal(legacy.status, 200, JSON.stringify(legacy.body));
  const legacyIds = (legacy.body.messages as Array<Record<string, unknown>>).map((m) => m.signal_id);
  assert.deepEqual(legacyIds, [String(signalOf(newer.body).id), ...notes], "the legacy read returns the whole page");
  assert.equal(await unreadOf(slug), true, "and leaves every one of them unread");
  // An empty page past the end records the read without moving the position to its cursor.
  const empty = await read({ channel: slug, after_id: notes[4] });
  assert.deepEqual(empty.body.messages, []);
  assert.equal(await unreadOf(slug), true);

  // One message over the caller's budget comes back alone (the bound keeps one), but a caller that
  // can't deliver it would refuse the result, so the read never moves the position.
  await read({ channel: slug, after_id: posted[1] }); // caught up through the notes
  assert.equal(await unreadOf(slug), false);
  const big = await send(f.ownerJwt, installedPost({ channel: slug, body: `big ${"z".repeat(1500)}` }));
  assert.equal(big.status, 200, JSON.stringify(big.body));
  assert.equal(await unreadOf(slug), true);
  const over = await read({ channel: slug, after_id: notes[4], max_bytes: 1024 });
  assert.deepEqual((over.body.messages as Array<Record<string, unknown>>).map((m) => m.signal_id), [String(signalOf(big.body).id)]);
  assert.equal(await unreadOf(slug), true, "a page over the declared budget leaves the position");
  await read({ channel: slug, after_id: notes[4] });
  assert.equal(await unreadOf(slug), false, "the same message within budget moves it");

  for (const max_bytes of [1023, 64 * 1024 + 1, 2048.5, "2048"]) {
    assert.equal((await read({ channel: slug, max_bytes })).status, 400, `max_bytes ${max_bytes}`);
  }
});

test("Brain M3: with workspace memory off, an admitted agent's memory reads are refused", async () => {
  for (const body of [
    { resource: "memory_search", workspace_id: f.workspace },
    { resource: "memory_get", workspace_id: f.workspace, memory_id: randomUUID() },
  ]) {
    const response = await fetch(`${local.API_URL}/functions/v1/read`, {
      method: "POST",
      headers: { authorization: `Bearer ${f.agentToken}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 404, body.resource);
    assert.equal(((await response.json()) as { error?: string }).error, "memory_unavailable");
  }
});


// ---- Public mentions (20261113000001, SWARM_CHAT_MENTIONS on) ----

/** A fresh agent in the fixture workspace with its own token, so a claim sees only this test's deliveries. */
async function mentionAgent(ownerId: string, name: string): Promise<{ principal: string; token: string }> {
  const principal = randomUUID();
  const token = `swm_agt_${randomBytes(32).toString("base64url")}`;
  await sql.begin(async (tx) => {
    const device = randomUUID();
    const run = randomUUID();
    await tx`INSERT INTO swarm.devices (device_id, user_id, label) VALUES (${device}::uuid, ${ownerId}::uuid, 'mention-tests')`;
    await tx`INSERT INTO swarm.agent_principals (principal_id, workspace_id, owner_user_id, name)
      VALUES (${principal}::uuid, ${f.workspace}::uuid, ${ownerId}::uuid, ${`${name}-${principal.slice(0, 6)}`})`;
    await tx`INSERT INTO swarm.agent_runs (run_id, principal_id, device_id) VALUES (${run}::uuid, ${principal}::uuid, ${device}::uuid)`;
    await tx`INSERT INTO swarm.agent_tokens (token_id, principal_id, run_id, scopes, token_hash, expires_at, lineage_id)
      VALUES (${randomUUID()}::uuid, ${principal}::uuid, ${run}::uuid, ${tx.json(["post_signal"])}::jsonb,
        ${createHash("sha256").update(token).digest()}, statement_timestamp() + interval '1 hour', ${randomUUID()}::uuid)`;
  });
  return { principal, token };
}

async function deliveriesOf(signalId: string): Promise<string[]> {
  const rows = await sql<{ p: string }[]>`
    SELECT recipient_agent_principal_id::text AS p FROM swarm.signal_deliveries
    WHERE signal_id = ${signalId}::uuid ORDER BY 1`;
  return rows.map((row) => row.p);
}

async function mentionsOf(signalId: string): Promise<Array<{ position: number; kind: string; id: string; source: string }>> {
  return await viewRowAs(f.otherId, async (tx) => {
    const rows = await tx<{ position: number; kind: string; id: string; source: string }[]>`
      SELECT position, kind, id::text AS id, source FROM swarm_read.signal_mentions
      WHERE signal_id = ${signalId}::uuid ORDER BY position`;
    return rows.map((row) => ({ ...row }));
  });
}

test("a mention wakes the agent and leaves the message public; the shipped listener client accepts the delivery", async () => {
  const agent = await mentionAgent(f.ownerId, "mentioned");
  const slug = `mention-${randomBytes(4).toString("hex")}`;
  assert.equal((await send(f.ownerJwt, { kind: "channel_create", slug })).status, 200);
  const posted = await send(f.ownerJwt, installedPost({
    channel: slug,
    mentions: [{ kind: "agent", id: agent.principal }, { kind: "user", id: f.otherId }],
  }));
  assert.equal(posted.status, 200, JSON.stringify(posted.body));
  const signal = signalOf(posted.body);
  const signalId = String(signal.id);
  // The stored and accepted row is unaddressed: nothing private about it.
  assert.equal(signal.to, null);
  assert.equal(signal.to_agent, null);
  const stored = await sql<{ to_user_id: string | null; to_agent_principal_id: string | null; recipients: string }[]>`
    SELECT s.to_user_id, s.to_agent_principal_id,
      (SELECT count(*)::text FROM swarm.signal_recipients r WHERE r.signal_id = s.id) AS recipients
    FROM swarm.signals s WHERE s.id = ${signalId}::uuid`;
  assert.deepEqual({ ...stored[0] }, { to_user_id: null, to_agent_principal_id: null, recipients: "0" });
  // A member who is neither the author nor the agent's owner reads it, as a whole-workspace message in its channel.
  const seen = await viewRowAs(f.otherId, async (tx) => {
    const rows = await tx<{ recipients: unknown; channel_id: string | null }[]>`
      SELECT recipients, channel_id FROM swarm_read.signals WHERE id = ${signalId}::uuid`;
    return rows.map((row) => ({ ...row }));
  });
  assert.deepEqual(seen, [{ recipients: [], channel_id: signal.channel_id }], "the mentioned message is public");
  // Readback is typed ids in order.
  assert.deepEqual(await mentionsOf(signalId), [
    { position: 0, kind: "agent", id: agent.principal, source: "author" },
    { position: 1, kind: "user", id: f.otherId, source: "author" },
  ]);
  assert.deepEqual(await deliveriesOf(signalId), [agent.principal], "only the mentioned agent is woken");

  // The real client the listener ships with: it refuses any delivery whose to_agent is not its own principal.
  const client = new DeliveryCommandClient(cloudTarget(local.API_URL, local.ANON_KEY));
  const listener = randomUUID();
  const claim = await client.claimAgentInbox({
    workspaceId: f.workspace, credential: agent.token, commandId: randomUUID(),
    listenerInstanceId: listener, expectedPrincipalId: agent.principal,
  });
  assert.equal(claim.deliveries.length, 1);
  const row = claim.deliveries[0]!;
  assert.equal(row.signal.id, signalId);
  assert.equal(row.signal.to_agent, agent.principal, "the delivery names its own recipient");
  assert.equal(row.signal.channel_id, signal.channel_id, "the delivery says where the message is");
  assert.equal(row.signal.thread_root_id, null);
  // A 0.1.x reply: private, to the author. The mentioned agent may send it.
  const reply = await send(agent.token, installedPost({ in_reply_to: signalId, body: "on it" }));
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.equal(signalOf(reply.body).to, f.ownerId);
  const ack = await client.ackAgentDelivery({
    workspaceId: f.workspace, credential: agent.token, commandId: randomUUID(), signalId,
    leaseId: row.leaseId, listenerInstanceId: listener, outcome: "replied", lastErrorCode: null,
  });
  assert.equal(ack.outcome, "replied");
  // An agent that was not mentioned may not reply privately to a message that is not addressed to it.
  const stranger = await send(f.agentTokenTwo, installedPost({ in_reply_to: signalId, body: "me too" }));
  assert.equal(stranger.status, 403);
});

test("a person's reply in a thread reaches the agents already in it, and a mention there reaches one more", async () => {
  const first = await mentionAgent(f.ownerId, "thread-first");
  const second = await mentionAgent(f.ownerId, "thread-second");
  const root = await send(f.ownerJwt, installedPost({ mentions: [{ kind: "agent", id: first.principal }] }));
  assert.equal(root.status, 200, JSON.stringify(root.body));
  const rootId = String(signalOf(root.body).id);
  const followUp = await send(f.otherJwt, installedPost({ thread_root_id: rootId, body: "any news?" }));
  assert.equal(followUp.status, 200, JSON.stringify(followUp.body));
  const followUpId = String(signalOf(followUp.body).id);
  assert.deepEqual(await deliveriesOf(followUpId), [first.principal]);
  assert.deepEqual(await mentionsOf(followUpId), [{ position: 0, kind: "agent", id: first.principal, source: "thread" }]);
  const named = await send(f.otherJwt, installedPost({
    thread_root_id: rootId, body: "and you?", mentions: [{ kind: "agent", id: second.principal }],
  }));
  assert.equal(named.status, 200, JSON.stringify(named.body));
  const namedId = String(signalOf(named.body).id);
  assert.deepEqual(await deliveriesOf(namedId), [first.principal, second.principal].sort());
  assert.deepEqual((await mentionsOf(namedId)).map((m) => [m.id, m.source]), [[second.principal, "author"], [first.principal, "thread"]]);
  // An agent's own reply in the thread wakes nobody unless it mentions someone, and never itself.
  const agentReply = await send(first.token, installedPost({ thread_root_id: rootId, body: "done" }));
  assert.equal(agentReply.status, 200, JSON.stringify(agentReply.body));
  assert.deepEqual(await deliveriesOf(String(signalOf(agentReply.body).id)), []);
  const selfMention = await send(first.token, installedPost({
    thread_root_id: rootId, body: "note to self", mentions: [{ kind: "agent", id: first.principal }, { kind: "agent", id: second.principal }],
  }));
  assert.equal(selfMention.status, 200, JSON.stringify(selfMention.body) + functionLogs.slice(-3000));
  assert.deepEqual(await deliveriesOf(String(signalOf(selfMention.body).id)), [second.principal], "an agent is not woken by its own mention");
});

test("agents cannot keep waking each other in a thread: after six agent messages in a row a mention is refused", async () => {
  const one = await mentionAgent(f.ownerId, "hop-one");
  const two = await mentionAgent(f.ownerId, "hop-two");
  const root = await send(one.token, installedPost({ body: "agent root" }));
  assert.equal(root.status, 200, JSON.stringify(root.body));
  const rootId = String(signalOf(root.body).id);
  for (let i = 0; i < 5; i += 1) {
    const from = i % 2 === 0 ? two : one;
    const to = i % 2 === 0 ? one : two;
    const reply = await send(from.token, installedPost({ thread_root_id: rootId, body: `hop ${i}`, mentions: [{ kind: "agent", id: to.principal }] }));
    assert.equal(reply.status, 200, `hop ${i}: ${JSON.stringify(reply.body)}${functionLogs.slice(-3000)}`);
  }
  const capped = await send(one.token, installedPost({ thread_root_id: rootId, body: "hop 6", mentions: [{ kind: "agent", id: two.principal }] }));
  assert.equal(capped.status, 409, JSON.stringify(capped.body));
  assert.equal(capped.body.error, "mention_hop_limit");
  // Without a mention the agent can still post, and a person's post lifts the limit.
  assert.equal((await send(one.token, installedPost({ thread_root_id: rootId, body: "plain" }))).status, 200);
  assert.equal((await send(f.ownerJwt, installedPost({ thread_root_id: rootId, body: "carry on" }))).status, 200);
  const resumed = await send(one.token, installedPost({ thread_root_id: rootId, body: "resumed", mentions: [{ kind: "agent", id: two.principal }] }));
  assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
});

test("a mention never rides on a private message, in the validator or in the database", async () => {
  const agent = await mentionAgent(f.ownerId, "private");
  const mention = [{ kind: "agent", id: agent.principal }];
  for (const extra of [
    { to: [{ kind: "user", id: f.otherId }] },
    { to_user_id: f.otherId },
    { to_agent_principal_id: f.principal },
  ]) {
    const refused = await send(f.ownerJwt, installedPost({ ...extra, mentions: mention }));
    assert.equal(refused.status, 400, JSON.stringify(extra));
    assert.match(String(refused.body.message), /cannot be combined with a recipient or a private reply/);
  }
  const workingOn = await send(f.ownerJwt, installedPost({ signal_kind: "working-on", mentions: mention }));
  assert.equal(workingOn.status, 400);
  const tooMany = await send(f.ownerJwt, installedPost({
    mentions: Array.from({ length: SIGNAL_MENTION_MAX + 1 }, () => ({ kind: "user", id: randomUUID() })),
  }));
  assert.equal(tooMany.status, 400);
  assert.match(String(tooMany.body.message), new RegExp(`at most ${SIGNAL_MENTION_MAX}`));
  // Someone who is not in the workspace: the same bare refusal a dead recipient gets, and nothing is written.
  const gone = await send(f.ownerJwt, installedPost({ mentions: [{ kind: "agent", id: randomUUID() }] }));
  assert.equal(gone.status, 403);

  // The database refuses the shapes the validator refuses, whoever writes them.
  const directed = randomUUID();
  await assert.rejects(sql.begin(async (tx) => {
    await tx`INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, kind, body, to_agent_principal_id, until)
      VALUES (${directed}::uuid, ${f.workspace}::uuid, ${f.ownerId}::uuid, 'user', 'note', 'private', ${f.principal}::uuid, statement_timestamp() + interval '1 hour')`;
    await tx`INSERT INTO swarm.signal_mentions (signal_id, workspace_id, mentioned_agent_principal_id, position)
      VALUES (${directed}::uuid, ${f.workspace}::uuid, ${agent.principal}::uuid, 0)`;
  }), /only a public note or ask can carry a mention/);
  const later = randomUUID();
  await assert.rejects(sql.begin(async (tx) => {
    await tx`INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, kind, body, to_user_id, until)
      VALUES (${later}::uuid, ${f.workspace}::uuid, ${f.ownerId}::uuid, 'user', 'note', 'recipient after mention', NULL, statement_timestamp() + interval '1 hour')`;
    await tx`INSERT INTO swarm.signal_mentions (signal_id, workspace_id, mentioned_agent_principal_id, position)
      VALUES (${later}::uuid, ${f.workspace}::uuid, ${agent.principal}::uuid, 0)`;
    await tx`INSERT INTO swarm.signal_recipients (signal_id, workspace_id, recipient_user_id, position)
      VALUES (${later}::uuid, ${f.workspace}::uuid, ${f.otherId}::uuid, 0)`;
  }), "a recipient written after the mention is refused by commit");
  const existing = await send(f.ownerJwt, installedPost());
  await assert.rejects(sql`INSERT INTO swarm.signal_mentions (signal_id, workspace_id, mentioned_agent_principal_id, position)
    VALUES (${String(signalOf(existing.body).id)}::uuid, ${f.workspace}::uuid, ${agent.principal}::uuid, 0)`,
    /only with a new signal/);
});

test("with a lead set, an untagged post from a person stays public and mentions the lead", async () => {
  const lead = await mentionAgent(f.ownerId, "lead");
  await sql`UPDATE swarm.workspaces SET lead_agent_principal_id = ${lead.principal}::uuid WHERE workspace_id = ${f.workspace}::uuid`;
  try {
    const posted = await send(f.otherJwt, installedPost({ body: "who can look at the build?" }));
    assert.equal(posted.status, 200, JSON.stringify(posted.body));
    const signal = signalOf(posted.body);
    assert.equal(signal.to_agent, null, "not re-addressed to the lead");
    assert.deepEqual(await mentionsOf(String(signal.id)), [{ position: 0, kind: "agent", id: lead.principal, source: "lead" }]);
    assert.deepEqual(await deliveriesOf(String(signal.id)), [lead.principal]);
    // Anyone can thread on it, which a lead-addressed post refused.
    const reply = await send(f.ownerJwt, installedPost({ thread_root_id: String(signal.id), body: "I can" }));
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    // A body that carries the key with nobody in it is still an untagged post: public, and the lead is mentioned.
    const empty = await send(f.otherJwt, installedPost({ body: "anyone?", mentions: [] }));
    assert.equal(empty.status, 200, JSON.stringify(empty.body));
    assert.equal(signalOf(empty.body).to_agent, null, "an empty list is not re-addressed either");
    assert.deepEqual(await mentionsOf(String(signalOf(empty.body).id)), [{ position: 0, kind: "agent", id: lead.principal, source: "lead" }]);
    assert.deepEqual(await deliveriesOf(String(signalOf(empty.body).id)), [lead.principal]);
    // Naming someone yourself leaves the lead out.
    const named = await send(f.otherJwt, installedPost({ mentions: [{ kind: "user", id: f.ownerId }] }));
    assert.equal(named.status, 200, JSON.stringify(named.body));
    assert.deepEqual(await deliveriesOf(String(signalOf(named.body).id)), []);
  } finally {
    await sql`UPDATE swarm.workspaces SET lead_agent_principal_id = NULL WHERE workspace_id = ${f.workspace}::uuid`;
  }
});

test("a hosted seat's check admits a message that mentions its agent, and still no other public message", async () => {
  const agent = await mentionAgent(f.ownerId, "hosted");
  const mentioned = await send(f.otherJwt, installedPost({ mentions: [{ kind: "agent", id: agent.principal }] }));
  const plain = await send(f.otherJwt, installedPost());
  assert.equal(mentioned.status, 200, JSON.stringify(mentioned.body));
  const ids = [String(signalOf(mentioned.body).id), String(signalOf(plain.body).id)];
  const visible = await sql.begin(async (tx) => {
    await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: f.ownerId, role: "authenticated", agent_principal_id: agent.principal })}, true)`;
    await tx.unsafe("SET LOCAL ROLE swarm_read");
    const rows = await tx<{ id: string }[]>`
      SELECT id::text AS id FROM swarm.hosted_mcp_check_visible_signals(${f.workspace}::uuid, ${agent.principal}::uuid, ${ids}::uuid[])`;
    const direct = await tx<{ id: string }[]>`
      SELECT s.id::text AS id FROM swarm_read.signals s WHERE s.id = ANY(${ids}::uuid[]) AND EXISTS (
        SELECT 1 FROM swarm_read.signal_mentions m WHERE m.signal_id = s.id AND m.workspace_id = s.workspace_id
          AND m.kind = 'agent' AND m.id = ${agent.principal}::uuid)`;
    await tx.unsafe("RESET ROLE");
    return [rows.map((row) => row.id), direct.map((row) => row.id)];
  });
  assert.deepEqual(visible, [[ids[0]], [ids[0]]]);
});

test("an agent added from another workspace is woken here, mentioned or addressed", async () => {
  // Its principal row names the workspace it started in; only its membership names this one.
  const home = randomUUID();
  const visitor = randomUUID();
  await sql.begin(async (tx) => {
    await tx`INSERT INTO swarm.workspaces (workspace_id, name, created_by) VALUES (${home}::uuid, 'VisitorHome', ${f.ownerId}::uuid)`;
    await tx`INSERT INTO swarm.memberships (workspace_id, user_id, role) VALUES (${home}::uuid, ${f.ownerId}::uuid, 'owner')`;
    await tx`INSERT INTO swarm.agent_principals (principal_id, workspace_id, owner_user_id, name)
      VALUES (${visitor}::uuid, ${home}::uuid, ${f.ownerId}::uuid, ${`visitor-${visitor.slice(0, 6)}`})`;
    await tx`INSERT INTO swarm.agent_workspace_memberships (principal_id, workspace_id, owner_user_id, added_by)
      VALUES (${visitor}::uuid, ${f.workspace}::uuid, ${f.ownerId}::uuid, ${f.ownerId}::uuid)`;
  });
  const mentioned = await send(f.otherJwt, installedPost({ mentions: [{ kind: "agent", id: visitor }] }));
  assert.equal(mentioned.status, 200, JSON.stringify(mentioned.body) + functionLogs.slice(-3000));
  assert.deepEqual(await deliveriesOf(String(signalOf(mentioned.body).id)), [visitor]);
  const addressed = await send(f.otherJwt, installedPost({ to_agent_principal_id: visitor }));
  assert.equal(addressed.status, 200, JSON.stringify(addressed.body));
  assert.deepEqual(await deliveriesOf(String(signalOf(addressed.body).id)), [visitor]);
  // Removed from this workspace again: a new mention is refused, as a dead recipient is.
  await sql`UPDATE swarm.agent_workspace_memberships SET revoked_at = statement_timestamp()
    WHERE principal_id = ${visitor}::uuid AND workspace_id = ${f.workspace}::uuid`;
  assert.equal((await send(f.otherJwt, installedPost({ mentions: [{ kind: "agent", id: visitor }] }))).status, 403);
});

test("a delivery says who can read its message, and an agent added from another workspace claims its deliveries here", async () => {
  // A token-holding agent whose principal row names another workspace; only its membership names this one.
  const home = randomUUID();
  const visitor = randomUUID();
  const token = `swm_agt_${randomBytes(32).toString("base64url")}`;
  await sql.begin(async (tx) => {
    const device = randomUUID();
    const run = randomUUID();
    await tx`INSERT INTO swarm.workspaces (workspace_id, name, created_by) VALUES (${home}::uuid, 'ClaimHome', ${f.ownerId}::uuid)`;
    await tx`INSERT INTO swarm.memberships (workspace_id, user_id, role) VALUES (${home}::uuid, ${f.ownerId}::uuid, 'owner')`;
    await tx`INSERT INTO swarm.devices (device_id, user_id, label) VALUES (${device}::uuid, ${f.ownerId}::uuid, 'claim-tests')`;
    await tx`INSERT INTO swarm.agent_principals (principal_id, workspace_id, owner_user_id, name)
      VALUES (${visitor}::uuid, ${home}::uuid, ${f.ownerId}::uuid, ${`claimer-${visitor.slice(0, 6)}`})`;
    await tx`INSERT INTO swarm.agent_workspace_memberships (principal_id, workspace_id, owner_user_id, added_by)
      VALUES (${visitor}::uuid, ${f.workspace}::uuid, ${f.ownerId}::uuid, ${f.ownerId}::uuid)`;
    await tx`INSERT INTO swarm.agent_runs (run_id, principal_id, device_id) VALUES (${run}::uuid, ${visitor}::uuid, ${device}::uuid)`;
    await tx`INSERT INTO swarm.agent_tokens (token_id, principal_id, run_id, scopes, token_hash, expires_at, lineage_id)
      VALUES (${randomUUID()}::uuid, ${visitor}::uuid, ${run}::uuid, ${tx.json(["post_signal"])}::jsonb,
        ${createHash("sha256").update(token).digest()}, statement_timestamp() + interval '1 hour', ${randomUUID()}::uuid)`;
  });
  const mentioned = await send(f.otherJwt, installedPost({ body: "public, for the visitor", mentions: [{ kind: "agent", id: visitor }] }));
  const addressed = await send(f.otherJwt, installedPost({ body: "private, for the visitor", to_agent_principal_id: visitor }));
  assert.equal(mentioned.status, 200, JSON.stringify(mentioned.body));
  assert.equal(addressed.status, 200, JSON.stringify(addressed.body));
  // The claim is made in THIS workspace, with the visitor's own token.
  const claim = await send(token, { kind: "claim_agent_inbox", listener_instance_id: randomUUID(), limit: 10 });
  assert.equal(claim.status, 200, JSON.stringify(claim.body) + functionLogs.slice(-3000));
  const rows = claim.body.deliveries as Array<{ signal: { id: string; to_agent: string; audience: string } }>;
  assert.deepEqual(
    rows.map((row) => [row.signal.id, row.signal.audience, row.signal.to_agent]),
    [
      [String(signalOf(mentioned.body).id), "workspace", visitor],
      [String(signalOf(addressed.body).id), "private", visitor],
    ],
  );
  // Removed from this workspace: the claim is refused again.
  await sql`UPDATE swarm.agent_workspace_memberships SET revoked_at = statement_timestamp()
    WHERE principal_id = ${visitor}::uuid AND workspace_id = ${f.workspace}::uuid`;
  const after = await send(token, { kind: "claim_agent_inbox", listener_instance_id: randomUUID(), limit: 10 });
  assert.notEqual(after.status, 200, JSON.stringify(after.body));
});

test("channel_update edits or clears purpose, renames under the workspace lock, and preserves untouched fields", async () => {
  const base = `upd-${randomBytes(4).toString("hex")}`;
  const created = await send(f.agentToken, { kind: "channel_create", slug: base, purpose: "Initial topic" });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const channelId = String((created.body.channel as Record<string, unknown>).channel_id);

  // Shape refusals: extra keys, bad UUID, neither slug nor purpose, bad slug, non-text or overlong purpose.
  assert.equal((await send(f.agentToken, { kind: "channel_update", channel_id: channelId, extra: true })).status, 400);
  assert.equal((await send(f.agentToken, { kind: "channel_update", channel_id: "not-a-uuid", purpose: "ok" })).status, 400);
  const empty = await send(f.agentToken, { kind: "channel_update", channel_id: channelId });
  assert.equal(empty.status, 400);
  assert.equal(empty.body.message, CHANNEL_UPDATE_EMPTY_TEXT);
  assert.equal((await send(f.agentToken, { kind: "channel_update", channel_id: channelId, slug: "Bad Slug" })).status, 400);
  assert.equal((await send(f.agentToken, { kind: "channel_update", channel_id: channelId, purpose: 42 })).status, 400);
  assert.equal((await send(f.agentToken, { kind: "channel_update", channel_id: channelId, purpose: "x".repeat(501) })).status, 400);

  // Purpose-only update keeps slug; slug-only update keeps purpose; null or blank clears purpose.
  const purposeOnly = await send(f.agentToken, { kind: "channel_update", channel_id: channelId, purpose: "  Ship velocity  " });
  assert.equal(purposeOnly.status, 200, JSON.stringify(purposeOnly.body));
  assert.deepEqual(
    [(purposeOnly.body.channel as Record<string, unknown>).slug, (purposeOnly.body.channel as Record<string, unknown>).purpose],
    [base, "Ship velocity"],
  );

  const slugOnly = await send(f.ownerJwt, { kind: "channel_update", channel_id: channelId, slug: `${base}-next` });
  assert.equal(slugOnly.status, 200, JSON.stringify(slugOnly.body));
  assert.deepEqual(
    [(slugOnly.body.channel as Record<string, unknown>).slug, (slugOnly.body.channel as Record<string, unknown>).purpose],
    [`${base}-next`, "Ship velocity"],
  );

  const cleared = await send(f.agentToken, { kind: "channel_update", channel_id: channelId, purpose: null });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  assert.equal((cleared.body.channel as Record<string, unknown>).purpose, null);

  // Concurrent slug-only and purpose-only updates on the same channel preserve both writes.
  const [rSlug, rPurpose] = await Promise.all([
    send(f.ownerJwt, { kind: "channel_update", channel_id: channelId, slug: `${base}-pair` }),
    send(f.agentToken, { kind: "channel_update", channel_id: channelId, purpose: "Merged topic" }),
  ]);
  assert.equal(rSlug.status, 200, JSON.stringify(rSlug.body));
  assert.equal(rPurpose.status, 200, JSON.stringify(rPurpose.body));
  const [finalRow] = await sql<{ slug: string; purpose: string | null }[]>`
    SELECT slug, purpose FROM swarm.channels WHERE channel_id = ${channelId}::uuid`;
  assert.deepEqual([finalRow?.slug, finalRow?.purpose], [`${base}-pair`, "Merged topic"]);

  // Concurrent channel_update slug contention gets one winner and 409 channel_exists, never 500.
  const otherMade = await send(f.ownerJwt, { kind: "channel_create", slug: `${base}-other` });
  const otherId = String((otherMade.body.channel as Record<string, unknown>).channel_id);
  const sharedTarget = `${base}-won`;
  const race = await Promise.all([
    send(f.ownerJwt, { kind: "channel_update", channel_id: channelId, slug: sharedTarget }),
    send(f.ownerJwt, { kind: "channel_update", channel_id: otherId, slug: sharedTarget }),
  ]);
  assert.deepEqual(
    race.map((r) => (r.status === 200 ? "ok" : `${r.status} ${String(r.body.error)}`)).sort(),
    ["409 channel_exists", "ok"],
  );
});

test("channel_unarchive restores posting, is idempotent when live, and enforces creator or owner/admin", async () => {
  const slug = `unarch-${randomBytes(4).toString("hex")}`;
  const created = await send(f.agentToken, { kind: "channel_create", slug, purpose: "Ops room" });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const channelId = String((created.body.channel as Record<string, unknown>).channel_id);

  assert.equal((await send(f.agentToken, { kind: "channel_unarchive" })).status, 400);
  assert.equal((await send(f.agentToken, { kind: "channel_unarchive", channel_id: "nope" })).status, 400);

  // Plain member and another agent of the same owner cannot update or unarchive.
  assert.equal((await send(f.agentToken, { kind: "channel_archive", channel_id: channelId })).status, 200);
  for (const bearer of [f.otherJwt, f.agentTokenTwo]) {
    const upd = await send(bearer, { kind: "channel_update", channel_id: channelId, purpose: "Hijack" });
    assert.equal(upd.status, 403, JSON.stringify(upd.body));
    assert.equal(upd.body.error, "channel_forbidden");
    const unarch = await send(bearer, { kind: "channel_unarchive", channel_id: channelId });
    assert.equal(unarch.status, 403, JSON.stringify(unarch.body));
    assert.equal(unarch.body.error, "channel_forbidden");
  }

  // While archived, updating description/name works for the owner, and posting is still refused.
  const archivedEdit = await send(f.ownerJwt, { kind: "channel_update", channel_id: channelId, purpose: "Restored ops room" });
  assert.equal(archivedEdit.status, 200, JSON.stringify(archivedEdit.body));
  assert.notEqual((archivedEdit.body.channel as Record<string, unknown>).archived_at, null);
  assert.equal((await send(f.otherJwt, installedPost({ channel: slug, body: "blocked while archived" }))).status, 409);

  // Unarchive restores the channel; posting succeeds; a second unarchive is a clean 200 no-op.
  const unarchived = await send(f.agentToken, { kind: "channel_unarchive", channel_id: channelId });
  assert.equal(unarchived.status, 200, JSON.stringify(unarchived.body));
  assert.equal((unarchived.body.channel as Record<string, unknown>).archived_at, null);
  assert.equal((unarchived.body.channel as Record<string, unknown>).purpose, "Restored ops room");

  const posted = await send(f.otherJwt, installedPost({ channel: slug, body: "live again" }));
  assert.equal(posted.status, 200, JSON.stringify(posted.body));

  const idempotent = await send(f.ownerJwt, { kind: "channel_unarchive", channel_id: channelId });
  assert.equal(idempotent.status, 200, JSON.stringify(idempotent.body));
  assert.equal((idempotent.body.channel as Record<string, unknown>).archived_at, null);
});

test("CM-2a channel preferences: per-person stars, star reorder, isolation, replay, and channel_unread involvement", async () => {
  const tag = randomBytes(4).toString("hex");
  const make = async (slug: string): Promise<string> => {
    const res = await send(f.ownerJwt, { kind: "channel_create", slug });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return String((res.body.channel as Record<string, unknown>).channel_id);
  };
  const alphaId = await make(`pref-a-${tag}`);
  const betaId = await make(`pref-b-${tag}`);
  const gammaId = await make(`pref-c-${tag}`);

  // Agents cannot mutate personal stars or notification involvement.
  for (const cmd of [
    { kind: "channel_preference_set", channel_id: alphaId, starred: true },
    { kind: "channel_star_reorder", channel_ids: [alphaId] },
  ]) {
    const denied = await send(f.agentToken, cmd);
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal(denied.body.error, "channel_forbidden");
  }

  // Shape and not-found refusals.
  assert.equal((await send(f.otherJwt, { kind: "channel_preference_set", channel_id: alphaId })).status, 400);
  assert.equal((await send(f.otherJwt, { kind: "channel_preference_set", channel_id: "bad", starred: true })).status, 400);
  assert.equal((await send(f.otherJwt, { kind: "channel_preference_set", channel_id: alphaId, involvement: "loud" })).status, 400);
  assert.equal((await send(f.otherJwt, { kind: "channel_preference_set", channel_id: randomUUID(), starred: true })).status, 404);

  // Star general (null), alpha, and beta; replay preserves preference response.
  const starCmdId = randomUUID();
  const sGeneral = await send(f.otherJwt, { kind: "channel_preference_set", channel_id: null, starred: true }, starCmdId);
  assert.equal(sGeneral.status, 200, JSON.stringify(sGeneral.body));
  assert.equal((sGeneral.body.preference as Record<string, unknown>).star_rank, 0);
  const sGeneralReplay = await send(f.otherJwt, { kind: "channel_preference_set", channel_id: null, starred: true }, starCmdId);
  assert.equal(sGeneralReplay.status, 200);
  assert.deepEqual(sGeneralReplay.body.preference, sGeneral.body.preference);

  const sAlpha = await send(f.otherJwt, { kind: "channel_preference_set", channel_id: alphaId, starred: true, involvement: "muted" });
  const sBeta = await send(f.otherJwt, { kind: "channel_preference_set", channel_id: betaId, starred: true, involvement: "mentions" });
  assert.equal((sAlpha.body.preference as Record<string, unknown>).star_rank, 1);
  assert.equal((sBeta.body.preference as Record<string, unknown>).star_rank, 2);

  // Unstarred channel in channel_star_reorder returns 409 channel_star_mismatch.
  const mismatch = await send(f.otherJwt, { kind: "channel_star_reorder", channel_ids: [betaId, gammaId] });
  assert.equal(mismatch.status, 409, JSON.stringify(mismatch.body));
  assert.equal(mismatch.body.error, "channel_star_mismatch");

  // Reorder stars: beta (0), general (1), alpha (2).
  const reordered = await send(f.otherJwt, { kind: "channel_star_reorder", channel_ids: [betaId, null, alphaId] });
  assert.equal(reordered.status, 200, JSON.stringify(reordered.body));
  assert.deepEqual(
    (reordered.body.preferences as Array<Record<string, unknown>>).map((p) => [p.channel_id, p.star_rank]),
    [[betaId, 0], [null, 1], [alphaId, 2]],
  );

  // swarm_read.channel_preferences isolates rows to the signed-in person.
  const otherPrefs = await viewRowAs(f.otherId, async (tx) => {
    const rows = await tx<{ target_key: string; star_rank: number | null; involvement: string }[]>`
      SELECT target_key, star_rank, involvement
      FROM swarm_read.channel_preferences
      WHERE workspace_id = ${f.workspace}::uuid
      ORDER BY star_rank NULLS LAST, target_key`;
    return rows.map((row) => ({ ...row }));
  });
  assert.deepEqual(otherPrefs, [
    { target_key: betaId, star_rank: 0, involvement: "mentions" },
    { target_key: "general", star_rank: 1, involvement: "everything" },
    { target_key: alphaId, star_rank: 2, involvement: "muted" },
  ]);
  const ownerPrefs = await viewRowAs(f.ownerId, async (tx) =>
    await tx`SELECT target_key FROM swarm_read.channel_preferences WHERE workspace_id = ${f.workspace}::uuid`
  );
  assert.equal(ownerPrefs.length, 0, "owner never sees another member's personal preferences");

  // Baseline receipt for f.otherId so channel_unread evaluates live unread rules.
  const seedPost = await send(f.ownerJwt, installedPost({ body: "baseline seed" }));
  assert.equal(seedPost.status, 200, JSON.stringify(seedPost.body));
  const seedId = String(signalOf(seedPost.body).id);
  const seenBaseline = await send(f.otherJwt, { kind: "signals_seen", signal_ids: [seedId] });
  assert.equal(seenBaseline.status, 200, JSON.stringify(seenBaseline.body));

  // Plain unmentioned posts in muted (alpha), mentions-only (beta), and everything (gamma).
  assert.equal((await send(f.ownerJwt, installedPost({ channel: `pref-a-${tag}`, body: "muted noise" }))).status, 200);
  assert.equal((await send(f.ownerJwt, installedPost({ channel: `pref-b-${tag}`, body: "unmentioned chatter" }))).status, 200);
  assert.equal((await send(f.ownerJwt, installedPost({ channel: `pref-c-${tag}`, body: "normal update" }))).status, 200);

  type UnreadRow = {
    channel_id: string | null;
    slug: string;
    starred: boolean;
    star_rank: number | null;
    involvement: string;
    unread: boolean | null;
  };
  const readUnread = async (): Promise<Map<string, UnreadRow>> => {
    const data = await viewRowAs(f.otherId, async (tx) => {
      const [row] = await tx<{ u: { channels: UnreadRow[] } }[]>`
        SELECT swarm_read.channel_unread(${f.workspace}::uuid) AS u`;
      return row!.u.channels;
    });
    return new Map(data.map((r) => [r.slug, r]));
  };

  const beforeMention = await readUnread();
  assert.equal(beforeMention.get(`pref-a-${tag}`)?.unread, false, "muted channel suppresses unread");
  assert.equal(beforeMention.get(`pref-b-${tag}`)?.unread, false, "mentions-only channel ignores plain post");
  assert.equal(beforeMention.get(`pref-c-${tag}`)?.unread, true, "everything channel marks plain post unread");
  assert.equal(beforeMention.get(`pref-b-${tag}`)?.star_rank, 0);

  // Mentioning f.otherId in the mentions-only channel lights unread.
  const mentioned = await send(
    f.ownerJwt,
    installedPost({
      channel: `pref-b-${tag}`,
      body: "hey @ChatOther",
      mentions: [{ kind: "user", id: f.otherId }],
    }),
  );
  assert.equal(mentioned.status, 200, JSON.stringify(mentioned.body));
  const afterMention = await readUnread();
  assert.equal(afterMention.get(`pref-b-${tag}`)?.unread, true, "mentions-only channel lights on @mention");
});

test("CM-2a channel_reorder and workspace_channel_policy_set enforce owner/admin and order new channels", async () => {
  const tag = randomBytes(4).toString("hex");
  const make = async (bearer: string, slug: string) =>
    await send(bearer, { kind: "channel_create", slug });

  const c1 = String(((await make(f.ownerJwt, `ord-a-${tag}`)).body.channel as Record<string, unknown>).channel_id);
  const c2 = String(((await make(f.ownerJwt, `ord-b-${tag}`)).body.channel as Record<string, unknown>).channel_id);

  // Non-admin member and agent cannot reorder channels or change creation policy.
  for (const bearer of [f.otherJwt, f.agentToken]) {
    assert.equal((await send(bearer, { kind: "channel_reorder", channel_ids: [c2, c1] })).status, 403);
    assert.equal(
      (await send(bearer, { kind: "workspace_channel_policy_set", channel_creation_policy: "admins" })).status,
      403,
    );
  }

  // Owner reorders c2 ahead of c1; replay returns identical ordered_channel_ids.
  const reorderId = randomUUID();
  const reordered = await send(f.ownerJwt, { kind: "channel_reorder", channel_ids: [c2, c1] }, reorderId);
  assert.equal(reordered.status, 200, JSON.stringify(reordered.body));
  const orderedIds = reordered.body.ordered_channel_ids as string[];
  assert.ok(orderedIds.indexOf(c2) < orderedIds.indexOf(c1));
  const reorderReplay = await send(f.ownerJwt, { kind: "channel_reorder", channel_ids: [c2, c1] }, reorderId);
  assert.deepEqual(reorderReplay.body.ordered_channel_ids, orderedIds);

  // A channel created after reorder receives sort_rank > existing max, landing after c2 and c1.
  const c3 = String(((await make(f.ownerJwt, `ord-0-${tag}`)).body.channel as Record<string, unknown>).channel_id);
  const ranks = await viewRowAs(f.ownerId, async (tx) =>
    await tx<{ channel_id: string; sort_rank: number }[]>`
      SELECT channel_id, sort_rank FROM swarm_read.channels
      WHERE workspace_id = ${f.workspace}::uuid
        AND channel_id IN (${c1}::uuid, ${c2}::uuid, ${c3}::uuid)
      ORDER BY sort_rank ASC, slug ASC`
  );
  assert.deepEqual(ranks.map((r) => r.channel_id), [c2, c1, c3]);

  // Restricting channel creation to admins blocks plain members and agents while allowing owner.
  try {
    const policyId = randomUUID();
    const locked = await send(
      f.ownerJwt,
      { kind: "workspace_channel_policy_set", channel_creation_policy: "admins" },
      policyId,
    );
    assert.equal(locked.status, 200, JSON.stringify(locked.body));
    assert.equal(locked.body.channel_creation_policy, "admins");
    const lockedReplay = await send(
      f.ownerJwt,
      { kind: "workspace_channel_policy_set", channel_creation_policy: "admins" },
      policyId,
    );
    assert.equal(lockedReplay.body.channel_creation_policy, "admins");

    const [wsView] = await viewRowAs(f.otherId, async (tx) =>
      await tx<{ channel_creation_policy: string }[]>`
        SELECT channel_creation_policy FROM swarm_read.workspaces
        WHERE workspace_id = ${f.workspace}::uuid`
    );
    assert.equal(wsView?.channel_creation_policy, "admins");

    assert.equal((await make(f.otherJwt, `locked-m-${tag}`)).status, 403);
    assert.equal((await make(f.agentToken, `locked-a-${tag}`)).status, 403);
    assert.equal((await make(f.ownerJwt, `locked-o-${tag}`)).status, 200);
  } finally {
    const restored = await send(f.ownerJwt, {
      kind: "workspace_channel_policy_set",
      channel_creation_policy: "members",
    });
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
  }
});

test("CM-3a private channel isolation: human, non-member admin, and sibling-agent zero-oracle boundaries across reads, commands, reorder, and slug hints", async () => {
  const tag = randomBytes(4).toString("hex");
  const adminB = await createUser(`chat-admin-b-${tag}`);
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO swarm.users (user_id, display_name)
      VALUES (${adminB.id}::uuid, 'ChatAdminB')
    `;
    await tx`
      INSERT INTO swarm.memberships (workspace_id, user_id, role)
      VALUES (${f.workspace}::uuid, ${adminB.id}::uuid, 'admin')
    `;
  });

  // members on an open channel is rejected with 400.
  const openWithMembers = await send(f.ownerJwt, {
    kind: "channel_create",
    slug: `open-bad-${tag}`,
    visibility: "open",
    members: [{ kind: "user", id: f.otherId }],
  });
  assert.equal(openWithMembers.status, 400, JSON.stringify(openWithMembers.body));

  // Open channel control + private channel enrolling owner + agent 1 (leaving f.otherId, adminB, and sibling agent 2 out).
  const openSlug = `pub-${tag}`;
  const openCreated = await send(f.ownerJwt, { kind: "channel_create", slug: openSlug });
  assert.equal(openCreated.status, 200, JSON.stringify(openCreated.body));
  const openId = String((openCreated.body.channel as Record<string, unknown>).channel_id);
  assert.equal((openCreated.body.channel as Record<string, unknown>).visibility, "open");

  const lockSlug = `lock-${tag}`;
  const createId = randomUUID();
  const lockCreated = await send(
    f.ownerJwt,
    {
      kind: "channel_create",
      slug: lockSlug,
      purpose: "Board confidential",
      visibility: "private",
      members: [{ kind: "agent", id: f.principal }],
    },
    createId,
  );
  assert.equal(lockCreated.status, 200, JSON.stringify(lockCreated.body));
  const lockChannel = lockCreated.body.channel as Record<string, unknown>;
  const lockId = String(lockChannel.channel_id);
  assert.equal(lockChannel.visibility, "private");
  const initialMembers = (lockCreated.body.members as Array<Record<string, unknown>>)
    .map((m) => `${m.kind}:${m.id}`)
    .sort();
  assert.deepEqual(initialMembers, [`agent:${f.principal}`, `user:${f.ownerId}`]);

  // Idempotent replay returns both channel and members.
  const lockReplayed = await send(
    f.ownerJwt,
    {
      kind: "channel_create",
      slug: lockSlug,
      purpose: "Board confidential",
      visibility: "private",
      members: [{ kind: "agent", id: f.principal }],
    },
    createId,
  );
  assert.equal(lockReplayed.status, 200);
  assert.equal((lockReplayed.body.members as unknown[])?.length, 2);

  // An agent creating a private channel auto-enrolls both itself AND its human owner, never sibling agents.
  const agentLockSlug = `agent-lock-${tag}`;
  const agentLock = await send(f.agentToken, {
    kind: "channel_create",
    slug: agentLockSlug,
    visibility: "private",
  });
  assert.equal(agentLock.status, 200, JSON.stringify(agentLock.body));
  const agentLockId = String((agentLock.body.channel as Record<string, unknown>).channel_id);
  assert.deepEqual(
    (agentLock.body.members as Array<Record<string, unknown>>).map((m) => `${m.kind}:${m.id}`).sort(),
    [`agent:${f.principal}`, `user:${f.ownerId}`],
  );

  // Post a message + mention in #lock as owner.
  const rootPost = await send(
    f.ownerJwt,
    installedPost({
      channel: lockSlug,
      body: "Private Q4 numbers",
      mentions: [{ kind: "agent", id: f.principal }],
    }),
  );
  assert.equal(rootPost.status, 200, JSON.stringify(rootPost.body));
  const lockSignalId = String(signalOf(rootPost.body).id);

  // Human read isolation: f.otherId (member) AND adminB (workspace admin NOT in #lock) see zero metadata or messages.
  for (const outsiderId of [f.otherId, adminB.id]) {
    const chRows = await viewRowAs(outsiderId, async (tx) =>
      await tx`SELECT channel_id FROM swarm_read.channels WHERE channel_id IN (${lockId}::uuid, ${agentLockId}::uuid)`
    );
    assert.equal(chRows.length, 0, `${outsiderId} must not see private channels in swarm_read.channels`);

    const memRows = await viewRowAs(outsiderId, async (tx) =>
      await tx`SELECT id FROM swarm_read.channel_members WHERE channel_id = ${lockId}::uuid`
    );
    assert.equal(memRows.length, 0, `${outsiderId} must not see private channel members`);

    const sigRows = await viewRowAs(outsiderId, async (tx) =>
      await tx`SELECT id FROM swarm_read.signals WHERE id = ${lockSignalId}::uuid`
    );
    assert.equal(sigRows.length, 0, `${outsiderId} must not read private channel signals`);

    const menRows = await viewRowAs(outsiderId, async (tx) =>
      await tx`SELECT signal_id FROM swarm_read.signal_mentions WHERE signal_id = ${lockSignalId}::uuid`
    );
    assert.equal(menRows.length, 0, `${outsiderId} must not read private channel mentions`);

    const unreadSlugs = await viewRowAs(outsiderId, async (tx) => {
      const [row] = await tx<{ u: { channels: Array<{ slug: string }> } }[]>`
        SELECT swarm_read.channel_unread(${f.workspace}::uuid) AS u`;
      return row!.u.channels.map((c) => c.slug);
    });
    assert.ok(!unreadSlugs.includes(lockSlug), `${outsiderId} channel_unread must omit #lock`);

    const receipt = await viewRowAs(outsiderId, async (tx) => {
      const [row] = await tx<{ r: unknown }[]>`
        SELECT swarm_read.signal_delivery_receipts(${f.workspace}::uuid, ${lockSignalId}::uuid) AS r`;
      return row!.r;
    });
    assert.equal(receipt, null, `${outsiderId} must receive null on signal_delivery_receipts for #lock`);
  }

  // Admitted human (f.ownerId) sees #lock with visibility: "private" in channel_unread and sees members in swarm_read.channel_members.
  const ownerUnread = await viewRowAs(f.ownerId, async (tx) => {
    const [row] = await tx<{ u: { channels: Array<{ slug: string; visibility: string }> } }[]>`
      SELECT swarm_read.channel_unread(${f.workspace}::uuid) AS u`;
    return row!.u.channels.find((c) => c.slug === lockSlug);
  });
  assert.equal(ownerUnread?.visibility, "private");

  // Sibling agent isolation: f.principalTwo is owned by f.ownerId (who IS in #lock), yet f.principalTwo is NOT in #lock!
  const agent1List = await readResource(f.agentToken, { resource: "channels", workspace_id: f.workspace });
  const agent2List = await readResource(f.agentTokenTwo, { resource: "channels", workspace_id: f.workspace });
  assert.equal(
    (agent1List.body.channels as Array<Record<string, unknown>>).find((c) => c.channel_id === lockId)?.visibility,
    "private",
  );
  assert.equal(
    (agent2List.body.channels as Array<Record<string, unknown>>).find((c) => c.channel_id === lockId),
    undefined,
    "sibling agent must NOT inherit human owner's private channel visibility",
  );

  const agent1Members = await readResource(f.agentToken, {
    resource: "channel_members",
    workspace_id: f.workspace,
    channel_id: lockId,
  });
  assert.equal(agent1Members.status, 200, JSON.stringify(agent1Members.body));
  assert.equal((agent1Members.body.members as unknown[]).length, 2);

  const agent2Members = await readResource(f.agentTokenTwo, {
    resource: "channel_members",
    workspace_id: f.workspace,
    channel_id: lockId,
  });
  assert.equal(agent2Members.status, 404, JSON.stringify(agent2Members.body));
  assert.equal(agent2Members.body.error, "channel_not_found");

  const agent1Read = await readResource(f.agentToken, {
    resource: "channel_messages",
    workspace_id: f.workspace,
    channel: lockSlug,
  });
  assert.equal(agent1Read.status, 200, JSON.stringify(agent1Read.body));
  assert.equal((agent1Read.body.messages as unknown[]).length, 1);

  const agent2Read = await readResource(f.agentTokenTwo, {
    resource: "channel_messages",
    workspace_id: f.workspace,
    channel: lockSlug,
  });
  assert.equal(agent2Read.status, 404, JSON.stringify(agent2Read.body));
  assert.equal(agent2Read.body.error, "channel_not_found");

  const agent2Feed = await readSignals(f.agentTokenTwo, false);
  assert.equal(
    (agent2Feed.body.signals as Array<Record<string, unknown>>).some((s) => s.id === lockSignalId),
    false,
    "non-member sibling agent feed must never return #lock signals",
  );

  // Zero-oracle archive check: archive #lock, verify outsiders still get 404 (NEVER 409 channel_archived!), then unarchive.
  assert.equal((await send(f.ownerJwt, { kind: "channel_archive", channel_id: lockId })).status, 200);
  for (const outsiderBearer of [f.otherJwt, adminB.jwt, f.agentTokenTwo]) {
    const postRes = await send(outsiderBearer, installedPost({ channel: lockSlug, body: "probe archived" }));
    assert.equal(postRes.status, 404, JSON.stringify(postRes.body));
    assert.equal(postRes.body.error, "channel_not_found");

    const threadRes = await send(outsiderBearer, installedPost({ thread_root_id: lockSignalId, body: "probe thread" }));
    assert.equal(threadRes.status, 404, JSON.stringify(threadRes.body));
    assert.equal(threadRes.body.error, "thread_root_not_found");
  }
  assert.equal((await send(f.ownerJwt, { kind: "channel_unarchive", channel_id: lockId })).status, 200);

  // Unknown-channel hint message omits #lock for outsiders while listing it for members.
  const outsiderHint = await send(adminB.jwt, installedPost({ channel: `missing-${tag}`, body: "probe" }));
  assert.equal(outsiderHint.status, 404);
  assert.ok(!String(outsiderHint.body.message).includes(lockSlug), "404 hint must not leak private channel slug");
  const ownerHint = await send(f.ownerJwt, installedPost({ channel: `missing-${tag}`, body: "probe" }));
  assert.equal(ownerHint.status, 404);
  assert.ok(String(ownerHint.body.message).includes(lockSlug), "member 404 hint includes accessible private slug");

  // Non-member workspace admin gets 404 channel_not_found on every channel command targeting #lock,
  // and channel_reorder omits #lock's UUID from ordered_channel_ids!
  for (const cmd of [
    { kind: "channel_update", channel_id: lockId, purpose: "hijack" },
    { kind: "channel_archive", channel_id: lockId },
    { kind: "channel_member_add", channel_id: lockId, members: [{ kind: "user", id: adminB.id }] },
    { kind: "channel_member_remove", channel_id: lockId, member: { kind: "user", id: f.ownerId } },
    { kind: "channel_leave", channel_id: lockId },
    { kind: "channel_preference_set", channel_id: lockId, starred: true },
    { kind: "channel_reorder", channel_ids: [lockId] },
  ]) {
    const res = await send(adminB.jwt, cmd);
    assert.equal(res.status, 404, `${cmd.kind} must 404 for non-member admin: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, "channel_not_found");
  }

  const adminReorder = await send(adminB.jwt, { kind: "channel_reorder", channel_ids: [openId] });
  assert.equal(adminReorder.status, 200, JSON.stringify(adminReorder.body));
  assert.ok(
    !(adminReorder.body.ordered_channel_ids as string[]).includes(lockId),
    "ordered_channel_ids returned to non-member admin must omit private channel UUIDs",
  );

  // E3: signals_seen on an inaccessible #lock message (both broadcast and directed) returns 200 { ok: true, event_ids: [] },
  // indistinguishable from an unknown UUID (no 403 leak on directed #lock signals), and writes zero receipt rows; admitted member writes 1.
  const unknownSigId = randomUUID();
  const humanSeenHidden = await send(f.otherJwt, { kind: "signals_seen", signal_ids: [lockSignalId] });
  const humanSeenUnknown = await send(f.otherJwt, { kind: "signals_seen", signal_ids: [unknownSigId] });
  assert.equal(humanSeenHidden.status, 200, JSON.stringify(humanSeenHidden.body));
  assert.equal(humanSeenUnknown.status, 200, JSON.stringify(humanSeenUnknown.body));
  assert.deepEqual(humanSeenHidden.body, humanSeenUnknown.body);

  const agentSeenHidden = await send(f.agentTokenTwo, { kind: "signals_seen", signal_ids: [lockSignalId] });
  const agentSeenUnknown = await send(f.agentTokenTwo, { kind: "signals_seen", signal_ids: [unknownSigId] });
  assert.equal(agentSeenHidden.status, 200, JSON.stringify(agentSeenHidden.body));
  assert.deepEqual(agentSeenHidden.body, agentSeenUnknown.body);

  const hiddenReceiptRows = await sql`
    SELECT signal_id FROM swarm.signal_human_receipts
    WHERE signal_id = ${lockSignalId}::uuid AND user_id = ${f.otherId}::uuid
  `;
  assert.equal(hiddenReceiptRows.length, 0, "outsider human signals_seen must write zero receipt rows");
  const hiddenAgentReceiptRows = await sql`
    SELECT signal_id FROM swarm.signal_agent_receipts
    WHERE signal_id = ${lockSignalId}::uuid AND principal_id = ${f.principalTwo}::uuid
  `;
  assert.equal(hiddenAgentReceiptRows.length, 0, "outsider agent signals_seen must write zero receipt rows");

  const ownerSeenMember = await send(f.ownerJwt, { kind: "signals_seen", signal_ids: [lockSignalId] });
  assert.equal(ownerSeenMember.status, 200, JSON.stringify(ownerSeenMember.body));
  const memberReceiptRows = await sql`
    SELECT signal_id FROM swarm.signal_human_receipts
    WHERE signal_id = ${lockSignalId}::uuid AND user_id = ${f.ownerId}::uuid
  `;
  assert.equal(memberReceiptRows.length, 1, "admitted member signals_seen records receipt row");

  // channel_star_reorder refuses hidden #lock UUID identically to an unstarred UUID (409 channel_star_mismatch).
  const outsiderStarReorder = await send(f.otherJwt, { kind: "channel_star_reorder", channel_ids: [lockId] });
  assert.equal(outsiderStarReorder.status, 409, JSON.stringify(outsiderStarReorder.body));
  assert.equal(outsiderStarReorder.body.error, "channel_star_mismatch");

  // Direct SQL proof of swarm.agent_delivery_is_wakeable, swarm_read.agent_channel_unread, and swarm.agent_channel_read_advance.
  const directedInLock = await send(
    f.ownerJwt,
    installedPost({
      channel: lockSlug,
      signal_kind: "ask",
      to: [{ kind: "agent", id: f.principal }],
      body: "Private SQL wake gate probe",
    }),
  );
  assert.equal(directedInLock.status, 200, JSON.stringify(directedInLock.body));
  const directedInLockId = String(signalOf(directedInLock.body).id);
  // E3 directed probe: on an accessible directed signal signals_seen returns 403, whereas an outsider on a directed #lock
  // signal still gets 200 { ok: true, event_ids: [] } (zero existence/directedness oracle).
  const outsiderDirectedSeen = await send(f.otherJwt, { kind: "signals_seen", signal_ids: [directedInLockId] });
  const siblingDirectedSeen = await send(f.agentTokenTwo, { kind: "signals_seen", signal_ids: [directedInLockId] });
  assert.equal(outsiderDirectedSeen.status, 200, JSON.stringify(outsiderDirectedSeen.body));
  assert.deepEqual(outsiderDirectedSeen.body, humanSeenUnknown.body);
  assert.equal(siblingDirectedSeen.status, 200, JSON.stringify(siblingDirectedSeen.body));
  assert.deepEqual(siblingDirectedSeen.body, agentSeenUnknown.body);

  const [wakeAdmitted] = await sql<{ ok: boolean }[]>`
    SELECT swarm.agent_delivery_is_wakeable(${directedInLockId}::uuid, ${f.workspace}::uuid, ${f.principal}::uuid) AS ok
  `;
  const [wakeOutsider] = await sql<{ ok: boolean }[]>`
    SELECT swarm.agent_delivery_is_wakeable(${directedInLockId}::uuid, ${f.workspace}::uuid, ${f.principalTwo}::uuid) AS ok
  `;
  assert.equal(wakeAdmitted?.ok, true, "admitted agent is wakeable on #lock ask");
  assert.equal(wakeOutsider?.ok, false, "SQL agent_delivery_is_wakeable must reject non-member sibling agent");

  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE swarm_read");
    await tx`
      SELECT set_config(
        'request.jwt.claims',
        ${JSON.stringify({ role: "authenticated", sub: f.ownerId, agent_principal_id: f.principal })},
        true
      )
    `;
    const [u1] = await tx<{ u: Array<{ channel_id: string | null; slug: string }> | null }[]>`
      SELECT swarm_read.agent_channel_unread(${f.workspace}::uuid) AS u
    `;
    assert.ok(Array.isArray(u1?.u), "admitted agent receives channel unread list");
    assert.equal(
      u1!.u!.some((c) => c.channel_id === lockId),
      true,
      "agent_channel_unread includes #lock for admitted agent",
    );

    await tx`
      SELECT set_config(
        'request.jwt.claims',
        ${JSON.stringify({ role: "authenticated", sub: f.ownerId, agent_principal_id: f.principalTwo })},
        true
      )
    `;
    const [u2] = await tx<{ u: Array<{ channel_id: string | null; slug: string }> | null }[]>`
      SELECT swarm_read.agent_channel_unread(${f.workspace}::uuid) AS u
    `;
    assert.ok(Array.isArray(u2?.u), "non-member sibling agent receives channel unread list");
    assert.equal(
      u2!.u!.some((c) => c.channel_id === lockId),
      false,
      "agent_channel_unread must omit #lock for non-member agent",
    );
    await tx`
      SELECT swarm.agent_channel_read_advance(
        ${f.workspace}::uuid,
        ${lockSlug},
        ${lockSignalId}::uuid
      )
    `;
    await tx.unsafe("RESET ROLE");
  });
  const advanceRows = await sql`
    SELECT channel_id FROM swarm.agent_channel_reads
    WHERE workspace_id = ${f.workspace}::uuid
      AND principal_id = ${f.principalTwo}::uuid
      AND channel_id = ${lockId}::uuid
  `;
  assert.equal(advanceRows.length, 0, "agent_channel_read_advance must write nothing for non-member agent");

  // E5: slug collision on an inaccessible #lock channel returns uniform neutral wording whether live or archived,
  // and global sort_rank skips hidden channels cleanly.
  const openAfterSlug = `pub-after-${tag}`;
  const openAfter = await send(f.ownerJwt, { kind: "channel_create", slug: openAfterSlug });
  assert.equal(openAfter.status, 200, JSON.stringify(openAfter.body));
  const openAfterId = String((openAfter.body.channel as Record<string, unknown>).channel_id);

  const outsiderRanks = await viewRowAs(f.otherId, async (tx) =>
    await tx<{ channel_id: string; sort_rank: number }[]>`
      SELECT channel_id, sort_rank
      FROM swarm_read.channels
      WHERE channel_id IN (${openId}::uuid, ${lockId}::uuid, ${openAfterId}::uuid)
      ORDER BY sort_rank ASC
    `
  );
  assert.deepEqual(outsiderRanks.map((r) => r.channel_id), [openId, openAfterId]);
  assert.ok(
    outsiderRanks[1]!.sort_rank - outsiderRanks[0]!.sort_rank >= 2,
    "global sort_rank preserves monotonic ordering across hidden private channels",
  );

  const expectedCollisionText = `This workspace already has a channel named ${lockSlug}.`;
  const collideLive = await send(f.otherJwt, { kind: "channel_create", slug: lockSlug });
  assert.equal(collideLive.status, 409, JSON.stringify(collideLive.body));
  assert.equal(collideLive.body.error, "channel_exists");
  assert.equal(collideLive.body.message, expectedCollisionText);

  assert.equal((await send(f.ownerJwt, { kind: "channel_archive", channel_id: lockId })).status, 200);
  const collideArchived = await send(f.otherJwt, { kind: "channel_create", slug: lockSlug });
  assert.equal(collideArchived.status, 409, JSON.stringify(collideArchived.body));
  assert.equal(collideArchived.body.error, "channel_exists");
  assert.equal(
    collideArchived.body.message,
    expectedCollisionText,
    "collision with archived private channel must NOT disclose archived status to outsider",
  );
  assert.equal((await send(f.ownerJwt, { kind: "channel_unarchive", channel_id: lockId })).status, 200);
});

test("CM-3a workspace lead, explicit targets/mentions, member lifecycle, last-manager guard, delivery cancellation, and open <-> private conversion", async () => {
  const tag = randomBytes(4).toString("hex");
  const adminB = await createUser(`chat-admin-mgr-${tag}`);
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO swarm.users (user_id, display_name)
      VALUES (${adminB.id}::uuid, 'ChatAdminMgr')
    `;
    await tx`
      INSERT INTO swarm.memberships (workspace_id, user_id, role)
      VALUES (${f.workspace}::uuid, ${adminB.id}::uuid, 'admin')
    `;
  });

  const leadAgent = await mentionAgent(f.ownerId, `lead-${tag}`);
  const lockSlug = `vault-${tag}`;
  const created = await send(f.ownerJwt, {
    kind: "channel_create",
    slug: lockSlug,
    visibility: "private",
    members: [{ kind: "agent", id: f.principal }],
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const lockId = String((created.body.channel as Record<string, unknown>).channel_id);

  try {
    // Configure leadAgent (NOT in #lock) as Workspace Lead.
    const setLead = await send(f.ownerJwt, {
      kind: "set_workspace_lead",
      principal_id: leadAgent.principal,
    });
    assert.equal(setLead.status, 200, JSON.stringify(setLead.body));

    // Untagged post in #lock does NOT mention or wake the non-member Workspace Lead!
    const untaggedInLock = await send(f.ownerJwt, installedPost({
      channel: lockSlug,
      body: "Secret launch date",
    }));
    assert.equal(untaggedInLock.status, 200, JSON.stringify(untaggedInLock.body));
    const untaggedId = String(signalOf(untaggedInLock.body).id);
    assert.deepEqual(await deliveriesOf(untaggedId), [], "non-member workspace lead must NOT be woken in #lock");

    // Explicit `to` or `mentions` naming a non-member in #lock is refused with 403 forbidden.
    for (const bad of [
      { to: [{ kind: "user", id: f.otherId }] },
      { to: [{ kind: "agent", id: leadAgent.principal }] },
      { mentions: [{ kind: "user", id: f.otherId }] },
      { mentions: [{ kind: "agent", id: leadAgent.principal }] },
    ]) {
      const refused = await send(f.ownerJwt, installedPost({ channel: lockSlug, body: "leak attempt", ...bad }));
      assert.equal(refused.status, 403, `expected 403 for ${JSON.stringify(bad)}: ${JSON.stringify(refused.body)}`);
    }

    // Add f.otherId and leadAgent to #lock (with idempotency replay check).
    const addCmdId = randomUUID();
    const added = await send(
      f.ownerJwt,
      {
        kind: "channel_member_add",
        channel_id: lockId,
        members: [
          { kind: "user", id: f.otherId },
          { kind: "agent", id: leadAgent.principal },
        ],
      },
      addCmdId,
    );
    assert.equal(added.status, 200, JSON.stringify(added.body));
    assert.equal((added.body.members as unknown[]).length, 4);
    const addedReplay = await send(
      f.ownerJwt,
      {
        kind: "channel_member_add",
        channel_id: lockId,
        members: [
          { kind: "user", id: f.otherId },
          { kind: "agent", id: leadAgent.principal },
        ],
      },
      addCmdId,
    );
    assert.equal(addedReplay.status, 200);
    assert.equal((addedReplay.body.members as unknown[]).length, 4);

    // Once leadAgent IS in #lock, an untagged human post in #lock wakes leadAgent!
    const wokeLead = await send(f.otherJwt, installedPost({
      channel: lockSlug,
      body: "Now lead is in the room",
    }));
    assert.equal(wokeLead.status, 200, JSON.stringify(wokeLead.body));
    const wokeLeadId = String(signalOf(wokeLead.body).id);
    assert.deepEqual(await deliveriesOf(wokeLeadId), [leadAgent.principal]);

    // Plain member INSIDE #lock cannot add/remove members -> 403 channel_forbidden (not 404).
    const memberAddAttempt = await send(f.otherJwt, {
      kind: "channel_member_add",
      channel_id: lockId,
      members: [{ kind: "user", id: adminB.id }],
    });
    assert.equal(memberAddAttempt.status, 403, JSON.stringify(memberAddAttempt.body));
    assert.equal(memberAddAttempt.body.error, "channel_forbidden");

    // f.otherJwt stars #lock, and owner sends a directed ask in #lock to f.otherId.
    assert.equal(
      (await send(f.otherJwt, { kind: "channel_preference_set", channel_id: lockId, starred: true })).status,
      200,
    );
    const askToOther = await send(f.ownerJwt, installedPost({
      channel: lockSlug,
      signal_kind: "ask",
      to: [{ kind: "user", id: f.otherId }],
      body: "Approve budget?",
    }));
    assert.equal(askToOther.status, 200, JSON.stringify(askToOther.body));
    const askToOtherId = String(signalOf(askToOther.body).id);

    // Remove f.otherId and leadAgent from #lock:
    // - f.otherId's star preference is cleaned up, and in_reply_to / reraise_ask are refused!
    // - leadAgent's unacked delivery from wokeLeadId terminalizes as sender_not_live on claim!
    const remOther = await send(f.ownerJwt, {
      kind: "channel_member_remove",
      channel_id: lockId,
      member: { kind: "user", id: f.otherId },
    });
    assert.equal(remOther.status, 200, JSON.stringify(remOther.body));

    const otherPrefsLeft = await viewRowAs(f.otherId, async (tx) =>
      await tx`SELECT channel_id FROM swarm_read.channel_preferences WHERE workspace_id = ${f.workspace}::uuid AND channel_id = ${lockId}::uuid`
    );
    assert.equal(otherPrefsLeft.length, 0, "removing member must clean up their private-channel star preference");
    assert.equal(
      (await send(f.otherJwt, installedPost({ in_reply_to: askToOtherId, body: "late reply" }))).status,
      403,
      "removed member cannot in_reply_to a private channel signal",
    );
    assert.equal(
      (await send(f.ownerJwt, { kind: "reraise_ask", signal_id: askToOtherId })).status,
      403,
      "reraise_ask refuses when ask recipient is no longer in #lock",
    );

    const remLead = await send(f.ownerJwt, {
      kind: "channel_member_remove",
      channel_id: lockId,
      member: { kind: "agent", id: leadAgent.principal },
    });
    assert.equal(remLead.status, 200, JSON.stringify(remLead.body));

    const deliveryClient = new DeliveryCommandClient(cloudTarget(local.API_URL, local.ANON_KEY));
    const claimedAfterRemoval = await deliveryClient.claimAgentInbox({
      workspaceId: f.workspace,
      credential: leadAgent.token,
      commandId: randomUUID(),
      listenerInstanceId: randomUUID(),
      expectedPrincipalId: leadAgent.principal,
    });
    assert.equal(claimedAfterRemoval.deliveries.length, 0, "removed agent must not receive queued #lock delivery");
    const [deliveryRow] = await sql<{ ack_outcome: string; last_error_code: string | null }[]>`
      SELECT ack_outcome, last_error_code
      FROM swarm.signal_deliveries
      WHERE signal_id = ${wokeLeadId}::uuid
        AND recipient_agent_principal_id = ${leadAgent.principal}::uuid
    `;
    assert.deepEqual(
      { ...deliveryRow },
      { ack_outcome: "failed_terminal", last_error_code: "sender_not_live" },
      "queued private-channel delivery terminalizes cleanly on post-enqueue removal",
    );

    // Last-manager guard: f.ownerId is now the sole live human manager in #lock (f.principal is an agent).
    const leaveLastMgr = await send(f.ownerJwt, { kind: "channel_leave", channel_id: lockId });
    assert.equal(leaveLastMgr.status, 409, JSON.stringify(leaveLastMgr.body));
    assert.equal(leaveLastMgr.body.error, "channel_last_manager");

    const selfRemLastMgr = await send(f.ownerJwt, {
      kind: "channel_member_remove",
      channel_id: lockId,
      member: { kind: "user", id: f.ownerId },
    });
    assert.equal(selfRemLastMgr.status, 409, JSON.stringify(selfRemLastMgr.body));
    assert.equal(selfRemLastMgr.body.error, "channel_last_manager");

    // Once adminB is added to #lock, f.ownerId can leave cleanly (returning left: true), and adminB manages #lock.
    assert.equal(
      (await send(f.ownerJwt, {
        kind: "channel_member_add",
        channel_id: lockId,
        members: [{ kind: "user", id: adminB.id }],
      })).status,
      200,
    );
    const leaveCmdId = randomUUID();
    const leftRes = await send(f.ownerJwt, { kind: "channel_leave", channel_id: lockId }, leaveCmdId);
    assert.equal(leftRes.status, 200, JSON.stringify(leftRes.body));
    assert.equal(leftRes.body.channel_id, lockId);
    assert.equal(leftRes.body.left, true);
    const leftReplay = await send(f.ownerJwt, { kind: "channel_leave", channel_id: lockId }, leaveCmdId);
    assert.equal(leftReplay.body.left, true);
    assert.equal(
      (await send(f.ownerJwt, { kind: "channel_update", channel_id: lockId, purpose: "no longer member" })).status,
      404,
    );
    assert.equal(
      (await send(adminB.jwt, { kind: "channel_update", channel_id: lockId, purpose: "AdminB runs it" })).status,
      200,
    );

    // open <-> private conversion via channel_update + 409 channel_is_open on open channels.
    const convSlug = `conv-${tag}`;
    const convOpen = await send(f.ownerJwt, { kind: "channel_create", slug: convSlug });
    assert.equal(convOpen.status, 200);
    const convId = String((convOpen.body.channel as Record<string, unknown>).channel_id);

    assert.equal((await send(f.ownerJwt, { kind: "channel_leave", channel_id: convId })).status, 409);
    assert.equal(
      (await send(f.ownerJwt, {
        kind: "channel_member_add",
        channel_id: convId,
        members: [{ kind: "user", id: f.otherId }],
      })).body.error,
      "channel_is_open",
    );
    assert.equal(
      (await send(f.otherJwt, { kind: "channel_preference_set", channel_id: convId, starred: true })).status,
      200,
    );

    const lockedConv = await send(f.ownerJwt, {
      kind: "channel_update",
      channel_id: convId,
      visibility: "private",
    });
    assert.equal(lockedConv.status, 200, JSON.stringify(lockedConv.body));
    assert.equal((lockedConv.body.channel as Record<string, unknown>).visibility, "private");
    assert.equal((lockedConv.body.members as unknown[]).length, 1);

    const lockedSecret = await send(f.ownerJwt, installedPost({
      channel: convSlug,
      body: "Confidential post after locking channel",
    }));
    assert.equal(lockedSecret.status, 200, JSON.stringify(lockedSecret.body));
    const lockedSecretId = String(signalOf(lockedSecret.body).id);

    const otherConvVisible = await viewRowAs(f.otherId, async (tx) =>
      await tx`SELECT channel_id FROM swarm_read.channels WHERE channel_id = ${convId}::uuid`
    );
    assert.equal(otherConvVisible.length, 0);
    const otherConvPref = await viewRowAs(f.otherId, async (tx) =>
      await tx`SELECT channel_id FROM swarm_read.channel_preferences WHERE workspace_id = ${f.workspace}::uuid AND channel_id = ${convId}::uuid`
    );
    assert.equal(otherConvPref.length, 0, "locking an open channel drops preferences of non-admitted members");

    // C3: converting private -> open is refused both at the command edge (409 channel_cannot_reopen_private)
    // and in Postgres (SWARM_CHANNEL_CANNOT_REOPEN_PRIVATE), keeping retained confidential messages private.
    const reopenedConv = await send(f.ownerJwt, {
      kind: "channel_update",
      channel_id: convId,
      visibility: "open",
    });
    assert.equal(reopenedConv.status, 409, JSON.stringify(reopenedConv.body));
    assert.equal(reopenedConv.body.error, "channel_cannot_reopen_private");

    await assert.rejects(
      sql.begin(async (tx) => {
        await tx`UPDATE swarm.channels SET visibility = 'open' WHERE channel_id = ${convId}::uuid`;
      }),
      /SWARM_PRIVATE_CHANNEL_CANNOT_REOPEN/,
    );

    const stillMembers = await sql`SELECT channel_id FROM swarm.channel_members WHERE channel_id = ${convId}::uuid`;
    assert.equal(stillMembers.length, 1, "refused reopen leaves swarm.channel_members intact");
    const otherStillBlind = await viewRowAs(f.otherId, async (tx) =>
      await tx`SELECT id FROM swarm_read.signals WHERE id = ${lockedSecretId}::uuid`
    );
    assert.equal(otherStillBlind.length, 0, "confidential history in locked channel stays unreadable to outsiders");
  } finally {
    await send(f.ownerJwt, { kind: "set_workspace_lead", principal_id: null });
  }
});

async function sendWs(
  workspaceId: string,
  bearer: string,
  command: Record<string, unknown>,
  commandId: string = randomUUID(),
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

async function readWs(
  bearer: string,
  payload: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${local.API_URL}/functions/v1/read`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  return {
    status: response.status,
    body: await response.json() as Record<string, unknown>,
  };
}

async function createWsAgent(
  workspaceId: string,
  ownerId: string,
  name: string,
): Promise<{ principal: string; token: string }> {
  const principal = randomUUID();
  const token = `swm_agt_${randomBytes(32).toString("base64url")}`;
  await sql.begin(async (tx) => {
    const device = randomUUID();
    const run = randomUUID();
    await tx`INSERT INTO swarm.devices (device_id, user_id, label) VALUES (${device}::uuid, ${ownerId}::uuid, 'ws-agent')`;
    await tx`
      INSERT INTO swarm.agent_principals (principal_id, workspace_id, owner_user_id, name)
      VALUES (${principal}::uuid, ${workspaceId}::uuid, ${ownerId}::uuid, ${`${name}-${principal.slice(0, 6)}`})
    `;
    await tx`INSERT INTO swarm.agent_runs (run_id, principal_id, device_id) VALUES (${run}::uuid, ${principal}::uuid, ${device}::uuid)`;
    await tx`
      INSERT INTO swarm.agent_tokens (token_id, principal_id, run_id, scopes, token_hash, expires_at, lineage_id)
      VALUES (
        ${randomUUID()}::uuid, ${principal}::uuid, ${run}::uuid, ${tx.json(["post_signal"])}::jsonb,
        ${createHash("sha256").update(token).digest()}, statement_timestamp() + interval '1 hour', ${randomUUID()}::uuid
      )
    `;
  });
  return { principal, token };
}

test("CM-3a R2 C1 + C2 + E4: private attachment refusal and traffic/queue metadata isolation across Realtime, pending_for_main_count, agent_wake_path, workspace_roster, home_overview, and todo_queue", async () => {
  const tag = randomBytes(4).toString("hex");
  const ws = randomUUID();
  const personA = await createUser(`r2-person-a-${tag}`);
  const ownerB = await createUser(`r2-owner-b-${tag}`);
  const outsiderC = await createUser(`r2-outsider-c-${tag}`);

  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO swarm.users (user_id, display_name)
      VALUES
        (${personA.id}::uuid, 'PersonA'),
        (${ownerB.id}::uuid, 'OwnerB'),
        (${outsiderC.id}::uuid, 'OutsiderC')
    `;
    await tx`
      INSERT INTO swarm.workspaces (workspace_id, name, created_by)
      VALUES (${ws}::uuid, ${`R2Meta-${tag}`}, ${ownerB.id}::uuid)
    `;
    await tx`
      INSERT INTO swarm.memberships (workspace_id, user_id, role)
      VALUES
        (${ws}::uuid, ${ownerB.id}::uuid, 'owner'),
        (${ws}::uuid, ${personA.id}::uuid, 'member'),
        (${ws}::uuid, ${outsiderC.id}::uuid, 'member')
    `;
    await tx`INSERT INTO swarm.streams (stream_id, workspace_id, kind) VALUES (${randomUUID()}::uuid, ${ws}::uuid, 'workspace')`;
    await tx`INSERT INTO swarm.household_workspace_boundaries (workspace_id, purpose) VALUES (${ws}::uuid, 'shared')`;
    await tx`
      INSERT INTO swarm.household_member_content_roles (workspace_id, user_id, content_role, content_consent_id, confirmed_at)
      VALUES
        (${ws}::uuid, ${ownerB.id}::uuid, 'editor', ${randomUUID()}::uuid, clock_timestamp()),
        (${ws}::uuid, ${personA.id}::uuid, 'editor', ${randomUUID()}::uuid, clock_timestamp()),
        (${ws}::uuid, ${outsiderC.id}::uuid, 'reader', ${randomUUID()}::uuid, clock_timestamp())
    `;
  });

  // agentX is owned by ownerB, yet personA creates #lock admitting ONLY personA + agentX (NOT ownerB or outsiderC!).
  const agentX = await createWsAgent(ws, ownerB.id, `agent-x-${tag}`);
  const outsiderAgent = await createWsAgent(ws, outsiderC.id, `agent-c-${tag}`);

  const openSlug = `open-${tag}`;
  const openRes = await sendWs(ws, personA.jwt, { kind: "channel_create", slug: openSlug });
  assert.equal(openRes.status, 200, JSON.stringify(openRes.body));

  const lockSlug = `confidential-${tag}`;
  const lockRes = await sendWs(ws, personA.jwt, {
    kind: "channel_create",
    slug: lockSlug,
    visibility: "private",
    members: [{ kind: "agent", id: agentX.principal }],
  });
  assert.equal(lockRes.status, 200, JSON.stringify(lockRes.body));
  const lockId = String((lockRes.body.channel as Record<string, unknown>).channel_id);

  // --- C1: Private-channel attachment refusal across channel post, thread reply, and in_reply_to ---
  const fileId = randomUUID();
  const versionId = randomUUID();
  const fileBytes = Buffer.from("# Confidential Draft\n");
  const createdFile = await sendWs(ws, personA.jwt, {
    kind: "file_version_create",
    file_id: fileId,
    version_id: versionId,
    name: `draft-${tag}.md`,
    declared_size_bytes: fileBytes.length,
    content_type: "text/markdown",
  });
  assert.equal(createdFile.status, 200, JSON.stringify(createdFile.body));
  const putRes = await fetch(`${local.API_URL}${String(createdFile.body.upload_path)}`, {
    method: "PUT",
    headers: { "content-type": "text/markdown" },
    body: fileBytes,
  });
  assert.ok(putRes.ok, `upload PUT failed: ${putRes.status}`);
  const committedFile = await sendWs(ws, personA.jwt, {
    kind: "file_version_commit",
    file_id: fileId,
    version_id: versionId,
    sha256: createHash("sha256").update(fileBytes).digest("hex"),
  });
  assert.equal(committedFile.status, 200, JSON.stringify(committedFile.body));
  const attachment = [{ file_id: fileId, version_n: 1 }];

  // Positive control: open channel accepts attachments and mints ~300s signed download URLs.
  const openWithFile = await sendWs(ws, personA.jwt, installedPost({
    channel: openSlug,
    body: "Open attachment control",
    attachments: attachment,
  }));
  assert.equal(openWithFile.status, 200, JSON.stringify(openWithFile.body));
  const dlRes = await sendWs(ws, outsiderC.jwt, { kind: "file_download_url", file_id: fileId, version_n: 1 });
  assert.equal(dlRes.status, 200, JSON.stringify(dlRes.body));

  // Outsider posting to #lock with attachments STILL gets 404 channel_not_found (channel gate precedes attachment refusal).
  const outsiderAttach = await sendWs(ws, outsiderC.jwt, installedPost({
    channel: lockSlug,
    body: "Outsider probe with attachment",
    attachments: attachment,
  }));
  assert.equal(outsiderAttach.status, 404, JSON.stringify(outsiderAttach.body));
  assert.equal(outsiderAttach.body.error, "channel_not_found");

  // Seed a clean root message and ask in #lock for thread_root_id and in_reply_to attachment checks.
  const lockRoot = await sendWs(ws, personA.jwt, installedPost({ channel: lockSlug, body: "Root in #lock" }));
  assert.equal(lockRoot.status, 200, JSON.stringify(lockRoot.body));
  const lockRootId = String(signalOf(lockRoot.body).id);

  const lockAskForAttach = await sendWs(ws, personA.jwt, installedPost({
    channel: lockSlug,
    signal_kind: "ask",
    to: [{ kind: "agent", id: agentX.principal }],
    body: "Ask in #lock",
  }));
  assert.equal(lockAskForAttach.status, 200, JSON.stringify(lockAskForAttach.body));
  const lockAskForAttachId = String(signalOf(lockAskForAttach.body).id);

  for (const [label, extra] of [
    ["top-level #lock post", { channel: lockSlug, attachments: attachment }],
    ["#lock thread reply", { thread_root_id: lockRootId, attachments: attachment }],
    ["#lock in_reply_to reply", { in_reply_to: lockAskForAttachId, attachments: attachment }],
  ] as const) {
    const refused = await sendWs(
      ws,
      label.includes("in_reply_to") ? agentX.token : personA.jwt,
      installedPost({ body: `Attach attempt (${label})`, ...extra }),
    );
    assert.equal(refused.status, 409, `${label}: ${JSON.stringify(refused.body)}`);
    assert.equal(refused.body.error, "private_channel_attachments_unsupported");
    assert.equal(refused.body.reason, "workspace_files_are_workspace_wide");
  }

  // Establish unclaimed observed eligibility on agentX via the existing delivery on lockAskForAttachId,
  // then record baseline Realtime & activity timestamps before generating fresh #lock traffic!
  const ackSeed = await sendWs(ws, agentX.token, {
    kind: "ack_agent_delivery",
    signal_id: lockAskForAttachId,
    lease_id: null,
    listener_instance_id: null,
    outcome: "observed",
    last_error_code: null,
    surfaced: true,
    unclaimed: true,
  });
  assert.equal(ackSeed.status, 200, JSON.stringify(ackSeed.body));

  // Verify #lock ack_agent_delivery suppressed agent_presence, then seed an open-channel presence timestamp
  // past the 60s throttle window so any presence leak on #lock commands is caught!
  const presenceAfterLockAck = await sql`
    SELECT last_command_at FROM swarm.agent_presence
    WHERE workspace_id = ${ws}::uuid AND principal_id = ${agentX.principal}::uuid
  `;
  assert.equal(presenceAfterLockAck.length, 0, "private-channel ack_agent_delivery must NOT write swarm.agent_presence");
  await sql`
    INSERT INTO swarm.agent_presence (workspace_id, principal_id, last_command_at)
    VALUES (${ws}::uuid, ${agentX.principal}::uuid, statement_timestamp() - interval '2 minutes')
    ON CONFLICT (workspace_id, principal_id)
    DO UPDATE SET last_command_at = EXCLUDED.last_command_at
  `;
  const [{ ts: baselinePresenceTs }] = await sql<{ ts: string }[]>`
    SELECT to_jsonb(last_command_at)#>>'{}' AS ts
    FROM swarm.agent_presence
    WHERE workspace_id = ${ws}::uuid AND principal_id = ${agentX.principal}::uuid
  `;

  await delay(25);
  const topic = `cswarm-signals:${ws}`;
  const [{ n: baselineRealtime }] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM realtime.messages WHERE topic = ${topic}
  `;

  // --- C2 + E4: Generate #lock traffic (inbound ask to agentX, working-on by agentX, outbound ask from agentX to personA) ---
  const privInboundAsk = await sendWs(ws, personA.jwt, installedPost({
    channel: lockSlug,
    signal_kind: "ask",
    to_agent_principal_id: agentX.principal,
    body: "Confidential inbound ask to agentX",
  }));
  assert.equal(privInboundAsk.status, 200, JSON.stringify(privInboundAsk.body));
  const privInboundAskId = String(signalOf(privInboundAsk.body).id);

  const privWorkingOn = await sendWs(ws, agentX.token, installedPost({
    channel: lockSlug,
    signal_kind: "working-on",
    body: "Auditing private M&A numbers",
  }));
  assert.equal(privWorkingOn.status, 200, JSON.stringify(privWorkingOn.body));
  const privWorkingOnId = String(signalOf(privWorkingOn.body).id);

  const privOutboundAsk = await sendWs(ws, agentX.token, installedPost({
    channel: lockSlug,
    signal_kind: "ask",
    to: [{ kind: "user", id: personA.id }],
    body: "Sign off on confidential M&A numbers?",
  }));
  assert.equal(privOutboundAsk.status, 200, JSON.stringify(privOutboundAsk.body));
  const privOutboundAskId = String(signalOf(privOutboundAsk.body).id);

  // 1. Shared workspace Realtime topic received ZERO frames for all three #lock signals, while an open post emits 1 frame!
  const [{ n: afterPrivRealtime }] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM realtime.messages WHERE topic = ${topic}
  `;
  assert.equal(afterPrivRealtime, baselineRealtime, "private-channel signals must NOT emit shared Realtime broadcasts");

  const openPing = await sendWs(ws, outsiderC.jwt, installedPost({
    channel: openSlug,
    body: "Public ping after #lock",
  }));
  assert.equal(openPing.status, 200, JSON.stringify(openPing.body));
  const openPingId = String(signalOf(openPing.body).id);
  const [{ n: afterOpenRealtime }] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM realtime.messages WHERE topic = ${topic}
  `;
  assert.equal(afterOpenRealtime, baselineRealtime + 1, "open-channel post still broadcasts on workspace Realtime topic");
  const realtimePayloads = await sql<{ event: string; extension: string; payload: Record<string, unknown> }[]>`
    SELECT event, extension, payload FROM realtime.messages WHERE topic = ${topic} ORDER BY inserted_at DESC LIMIT 1
  `;
  assert.equal(realtimePayloads[0]?.event, "signal");
  assert.equal(realtimePayloads[0]?.extension, "broadcast");
  const broadcastSignalId = (realtimePayloads[0]?.payload?.signal_id as string | undefined) ??
    ((realtimePayloads[0]?.payload?.payload as Record<string, unknown> | undefined)?.signal_id as string | undefined);
  assert.equal(broadcastSignalId, openPingId, "open-channel Realtime frame carries openPing signal_id");

  // 2. swarm_read.agent_wake_path (while privInboundAsk is unacked & unleased):
  // personA sees agentX's unobserved #lock delivery; ownerB & outsiderC see 0 rows!
  const wakePathAs = async (userId: string) =>
    (await viewRowAs(userId, async (tx) =>
      await tx<{ principal_id: string }[]>`
        SELECT principal_id::text FROM swarm_read.agent_wake_path WHERE workspace_id = ${ws}::uuid
      `
    )).map((r) => r.principal_id);
  assert.deepEqual(await wakePathAs(personA.id), [agentX.principal]);
  assert.deepEqual(await wakePathAs(ownerB.id), [], "non-member agent owner must NOT see #lock row in agent_wake_path");
  assert.deepEqual(await wakePathAs(outsiderC.id), [], "outsider must NOT see #lock row in agent_wake_path");

  // 3. swarm_read.workspace_roster (human SQL + agent read edge):
  // personA & agentX see open_work, waiting_on_people.count = 1, and #lock last_activity_at;
  // ownerB (agentX's owner!), outsiderC, and outsiderAgent see open_work = null, waiting_on_people.count = 0, and NO #lock last_activity_at!
  type RosterShape = {
    agents: Array<{
      principal_id: string;
      last_activity_at: string | null;
      open_work: { since: string; text: string | null } | null;
      waiting_on_people: { count: number; since: string | null };
    }>;
  };
  const humanRosterAgentX = async (userId: string) => {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE swarm_read");
      await tx`
        SELECT set_config(
          'request.jwt.claims',
          ${JSON.stringify({ sub: userId, role: "authenticated" })},
          true
        )
      `;
      const [row] = await tx<{ r: RosterShape }[]>`SELECT swarm_read.workspace_roster(${ws}::uuid) AS r`;
      await tx.unsafe("RESET ROLE");
      return row!.r.agents.find((a) => a.principal_id === agentX.principal)!;
    });
  };
  const aRoster = await humanRosterAgentX(personA.id);
  assert.ok(aRoster.open_work !== null && aRoster.open_work.since.length > 0, "admitted #lock member sees open_work in workspace_roster");
  assert.equal(aRoster.open_work?.text, null, "channel-filed working-on keeps open_work.text null per whole_workspace rule");
  assert.equal(aRoster.waiting_on_people.count, 1);
  assert.ok(aRoster.waiting_on_people.since !== null);
  assert.ok(aRoster.last_activity_at !== null && Date.parse(aRoster.last_activity_at) > Date.parse(baselinePresenceTs));

  for (const [label, userId] of [["ownerB (non-member owner)", ownerB.id], ["outsiderC", outsiderC.id]] as const) {
    const r = await humanRosterAgentX(userId);
    assert.equal(r.open_work, null, `${label} roster must hide #lock working-on`);
    assert.deepEqual(r.waiting_on_people, { count: 0, since: null }, `${label} roster must hide #lock waiting_on_people`);
    assert.equal(Date.parse(r.last_activity_at!), Date.parse(baselinePresenceTs), `${label} roster must NOT advance last_activity_at on #lock traffic`);
  }

  const xEdgeRoster = await readWs(agentX.token, { resource: "roster", workspace_id: ws });
  assert.equal(xEdgeRoster.status, 200);
  const xSelf = (xEdgeRoster.body as unknown as RosterShape).agents.find((a) => a.principal_id === agentX.principal)!;
  assert.ok(xSelf.open_work !== null);
  assert.equal(xSelf.waiting_on_people.count, 1);

  const cEdgeRoster = await readWs(outsiderAgent.token, { resource: "roster", workspace_id: ws });
  assert.equal(cEdgeRoster.status, 200);
  const cSeesX = (cEdgeRoster.body as unknown as RosterShape).agents.find((a) => a.principal_id === agentX.principal)!;
  assert.equal(cSeesX.open_work, null);
  assert.deepEqual(cSeesX.waiting_on_people, { count: 0, since: null });
  assert.equal(Date.parse(cSeesX.last_activity_at!), Date.parse(baselinePresenceTs));

  // 4. swarm_read.home_overview(): personA sees needs_you.asks + agentX facts from #lock; ownerB & outsiderC see nulls/empty!
  type HomeAgentFacts = {
    last_activity_at: string | null;
    messages_waiting_since: string | null;
    working_on: { signal_id: string } | null;
  };
  type HomeWorkspaceCard = {
    workspace_id: string;
    new_messages: number;
    needs_you: { asks: Array<{ signal_id: string }> };
    people: Array<{ user_id: string; agents: Array<{ principal_id: string; status: { facts: HomeAgentFacts } }> }>;
  };
  const homeCardAs = async (userId: string) => {
    const [row] = await viewRowAs(userId, async (tx) =>
      await tx<{ h: { workspaces: HomeWorkspaceCard[] } }[]>`
        SELECT swarm_read.home_overview() AS h
      `
    );
    const card = row!.h.workspaces.find((w) => w.workspace_id === ws)!;
    const agentFacts = card.people.flatMap((p) => p.agents).find((a) => a.principal_id === agentX.principal)!.status.facts;
    return { card, agentFacts };
  };
  const aHome = await homeCardAs(personA.id);
  const bHome = await homeCardAs(ownerB.id);
  const cHome = await homeCardAs(outsiderC.id);
  assert.deepEqual(aHome.card.needs_you.asks.map((a) => a.signal_id), [privOutboundAskId]);
  assert.deepEqual(bHome.card.needs_you.asks, []);
  assert.deepEqual(cHome.card.needs_you.asks, []);
  assert.ok(aHome.agentFacts.messages_waiting_since !== null, "admitted #lock member sees agentX messages_waiting_since in home_overview");
  assert.equal(aHome.agentFacts.working_on?.signal_id, privWorkingOnId, "admitted #lock member sees agentX working_on in home_overview");
  assert.ok(Date.parse(aHome.agentFacts.last_activity_at!) > Date.parse(baselinePresenceTs));
  for (const [label, h] of [["ownerB", bHome], ["outsiderC", cHome]] as const) {
    assert.equal(h.agentFacts.messages_waiting_since, null, `${label} home_overview must hide #lock messages_waiting_since`);
    assert.equal(h.agentFacts.working_on, null, `${label} home_overview must hide #lock working_on`);
    assert.equal(Date.parse(h.agentFacts.last_activity_at!), Date.parse(baselinePresenceTs), `${label} home_overview must NOT advance agentX last_activity_at on #lock traffic`);
  }

  // 5. household_tool todo_queue (queueFacts parity): personA sees agentX working_on, messages_waiting_since & last_activity_at; ownerB sees nulls & baseline!
  const todoQueueFactsAs = async (jwt: string) => {
    const res = await sendWs(ws, jwt, {
      kind: "household_tool",
      tool: "todo_queue",
      arguments: {
        seat: "seat_0000000000000000000000",
        principal_id: agentX.principal,
      },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const queue = res.body.queue as {
      principal_id: string;
      status: {
        facts: {
          last_activity_at: string | null;
          messages_waiting_since: string | null;
          working_on: { signal_id: string } | null;
        };
      };
    };
    return queue.status.facts;
  };
  const aTodoAgentX = await todoQueueFactsAs(personA.jwt);
  const bTodoAgentX = await todoQueueFactsAs(ownerB.jwt);
  assert.equal(aTodoAgentX.working_on?.signal_id, privWorkingOnId);
  assert.ok(aTodoAgentX.messages_waiting_since !== null);
  assert.equal(bTodoAgentX.working_on, null, "ownerB todo_queue must hide #lock working_on");
  assert.equal(bTodoAgentX.messages_waiting_since, null, "ownerB todo_queue must hide #lock messages_waiting_since");
  assert.equal(
    Date.parse(bTodoAgentX.last_activity_at!),
    Date.parse(baselinePresenceTs),
    "ownerB todo_queue must NOT advance last_activity_at on #lock traffic",
  );
  assert.ok(
    Date.parse(aTodoAgentX.last_activity_at!) > Date.parse(baselinePresenceTs),
    "personA todo_queue reflects #lock last_activity_at",
  );

  // 6. R2-A1: A private-only claim_agent_inbox (with route omitted) must NOT bump globally visible
  // swarm.agent_presence.last_command_at or advance outsider-visible last_activity_at across roster, home_overview, or todo_queue!
  const listenerInstanceId = randomUUID();
  const privOnlyClaim = await sendWs(ws, agentX.token, {
    kind: "claim_agent_inbox",
    listener_instance_id: listenerInstanceId,
    limit: 10,
  });
  assert.equal(privOnlyClaim.status, 200, JSON.stringify(privOnlyClaim.body));
  const privOnlyDeliveries = privOnlyClaim.body.deliveries as Array<{
    lease_id: string;
    signal: { id: string; channel_visibility?: string };
  }>;
  assert.equal(privOnlyDeliveries.length, 1, "private-only inbox claim returns only privInboundAsk");
  assert.equal(privOnlyDeliveries[0]!.signal.id, privInboundAskId);
  assert.equal(privOnlyDeliveries[0]!.signal.channel_visibility, "private");

  const [{ ts: afterPrivClaimPresenceTs }] = await sql<{ ts: string }[]>`
    SELECT to_jsonb(last_command_at)#>>'{}' AS ts
    FROM swarm.agent_presence
    WHERE workspace_id = ${ws}::uuid AND principal_id = ${agentX.principal}::uuid
  `;
  assert.equal(
    Date.parse(afterPrivClaimPresenceTs),
    Date.parse(baselinePresenceTs),
    "R2-A1: private-only claim_agent_inbox (route omitted) must NOT advance swarm.agent_presence.last_command_at",
  );
  for (const [label, userId] of [["ownerB (non-member owner)", ownerB.id], ["outsiderC", outsiderC.id]] as const) {
    const r = await humanRosterAgentX(userId);
    assert.equal(
      Date.parse(r.last_activity_at!),
      Date.parse(baselinePresenceTs),
      `R2-A1: ${label} workspace_roster must retain baseline last_activity_at after private-only claim_agent_inbox`,
    );
    const h = await homeCardAs(userId);
    assert.equal(
      Date.parse(h.agentFacts.last_activity_at!),
      Date.parse(baselinePresenceTs),
      `R2-A1: ${label} home_overview must retain baseline last_activity_at after private-only claim_agent_inbox`,
    );
  }
  const cEdgeRosterAfterPrivClaim = await readWs(outsiderAgent.token, { resource: "roster", workspace_id: ws });
  assert.equal(cEdgeRosterAfterPrivClaim.status, 200);
  const cSeesXAfterPrivClaim = (cEdgeRosterAfterPrivClaim.body as unknown as RosterShape).agents.find(
    (a) => a.principal_id === agentX.principal,
  )!;
  assert.equal(
    Date.parse(cSeesXAfterPrivClaim.last_activity_at!),
    Date.parse(baselinePresenceTs),
    "R2-A1: outsiderAgent roster must retain baseline last_activity_at after private-only claim_agent_inbox",
  );
  const bTodoAfterPrivClaim = await todoQueueFactsAs(ownerB.jwt);
  assert.equal(
    Date.parse(bTodoAfterPrivClaim.last_activity_at!),
    Date.parse(baselinePresenceTs),
    "R2-A1: ownerB todo_queue must retain baseline last_activity_at after private-only claim_agent_inbox",
  );

  // Move privInboundAsk into 'queued', then post and claim/queue the two open control asks for pending_for_main_count.
  const privQueuedAck = await sendWs(ws, agentX.token, {
    kind: "ack_agent_delivery",
    signal_id: privInboundAskId,
    lease_id: privOnlyDeliveries[0]!.lease_id,
    listener_instance_id: listenerInstanceId,
    outcome: "queued",
    last_error_code: null,
  });
  assert.equal(privQueuedAck.status, 200, JSON.stringify(privQueuedAck.body));

  // 7. pending_for_main_count on swarm_read.signal_delivery_receipts (listener-queued deliveries):
  // Post open control asks from personA and outsiderC, claim both into 'queued' alongside privInboundAsk,
  // and verify personA sees pending_for_main_count = 3 while ownerB & outsiderC see 2 (hiding privInboundAsk)!
  const openControlAskA = await sendWs(ws, personA.jwt, installedPost({
    channel: openSlug,
    signal_kind: "ask",
    to_agent_principal_id: agentX.principal,
    body: "Open ask A to agentX",
  }));
  assert.equal(openControlAskA.status, 200, JSON.stringify(openControlAskA.body));
  const openControlAskAId = String(signalOf(openControlAskA.body).id);

  const openControlAskC = await sendWs(ws, outsiderC.jwt, installedPost({
    channel: openSlug,
    signal_kind: "ask",
    to_agent_principal_id: agentX.principal,
    body: "Open ask C to agentX",
  }));
  assert.equal(openControlAskC.status, 200, JSON.stringify(openControlAskC.body));
  const openControlAskCId = String(signalOf(openControlAskC.body).id);

  const claimed = await sendWs(ws, agentX.token, {
    kind: "claim_agent_inbox",
    listener_instance_id: listenerInstanceId,
    limit: 10,
  });
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  const claimedDeliveries = claimed.body.deliveries as Array<{ lease_id: string; signal: { id: string } }>;
  for (const targetSignalId of [openControlAskAId, openControlAskCId]) {
    const del = claimedDeliveries.find((d) => d.signal.id === targetSignalId);
    assert.ok(del !== undefined, `expected ${targetSignalId} in claimed deliveries`);
    const queuedAck = await sendWs(ws, agentX.token, {
      kind: "ack_agent_delivery",
      signal_id: targetSignalId,
      lease_id: del.lease_id,
      listener_instance_id: listenerInstanceId,
      outcome: "queued",
      last_error_code: null,
    });
    assert.equal(queuedAck.status, 200, JSON.stringify(queuedAck.body));
  }

  const receiptCountAs = async (userId: string, signalId: string) => {
    const [row] = await viewRowAs(userId, async (tx) =>
      await tx<{ r: { receipts: Array<{ pending_for_main_count: number }> } }[]>`
        SELECT swarm_read.signal_delivery_receipts(${ws}::uuid, ${signalId}::uuid) AS r
      `
    );
    return row!.r.receipts[0]!.pending_for_main_count;
  };
  assert.equal(await receiptCountAs(personA.id, openControlAskAId), 3, "admitted #lock member sees all 3 queued deliveries (including #lock)");
  assert.equal(await receiptCountAs(ownerB.id, openControlAskAId), 2, "non-member agent owner must NOT see #lock queued delivery in pending_for_main_count");
  assert.equal(await receiptCountAs(outsiderC.id, openControlAskCId), 2, "outsider must NOT see #lock queued delivery in pending_for_main_count");

  // 8. R2-A2: Hidden observed #lock deliveries must NEVER add (reverse seed-dependency) or remove (later-observed supersession)
  // outsider-visible public rows in swarm_read.agent_wake_path or signal_delivery_receipts.wake_path_observing!
  const wakeProbeAgent = await createWsAgent(ws, ownerB.id, `wake-probe-${tag}`);
  assert.equal(
    (await sendWs(ws, personA.jwt, {
      kind: "channel_member_add",
      channel_id: lockId,
      members: [{ kind: "agent", id: wakeProbeAgent.principal }],
    })).status,
    200,
  );
  const wakeRowForProbeAs = async (userId: string) => {
    const rows = await viewRowAs(userId, async (tx) =>
      await tx<{ oldest_unobserved_at: Date }[]>`
        SELECT oldest_unobserved_at
        FROM swarm_read.agent_wake_path
        WHERE workspace_id = ${ws}::uuid AND principal_id = ${wakeProbeAgent.principal}::uuid
      `
    );
    return rows[0]?.oldest_unobserved_at?.toISOString() ?? null;
  };
  const receiptObservingAs = async (userId: string, signalId: string) => {
    const [row] = await viewRowAs(userId, async (tx) =>
      await tx<{ r: { receipts: Array<{ recipient_agent_principal_id?: string; wake_path_observing?: boolean }> } }[]>`
        SELECT swarm_read.signal_delivery_receipts(${ws}::uuid, ${signalId}::uuid) AS r
      `
    );
    return row!.r.receipts.find((rc) => rc.recipient_agent_principal_id === wakeProbeAgent.principal)?.wake_path_observing ?? null;
  };
  const ackObservedUnclaimed = async (token: string, signalId: string) => {
    const res = await sendWs(ws, token, {
      kind: "ack_agent_delivery",
      signal_id: signalId,
      lease_id: null,
      listener_instance_id: null,
      outcome: "observed",
      last_error_code: null,
      surfaced: true,
      unclaimed: true,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  };

  // Direction 1 (Reverse seed-dependency): ONLY a #lock delivery is observed, followed by a public unobserved ask.
  const privOnlySeed = await sendWs(ws, personA.jwt, installedPost({
    channel: lockSlug,
    signal_kind: "ask",
    to_agent_principal_id: wakeProbeAgent.principal,
    body: "Hidden observed seed in #lock",
  }));
  assert.equal(privOnlySeed.status, 200);
  await ackObservedUnclaimed(wakeProbeAgent.token, String(signalOf(privOnlySeed.body).id));

  const pubAfterPrivSeed = await sendWs(ws, ownerB.jwt, installedPost({
    channel: openSlug,
    signal_kind: "ask",
    to_agent_principal_id: wakeProbeAgent.principal,
    body: "Public ask after hidden #lock seed",
  }));
  assert.equal(pubAfterPrivSeed.status, 200);
  const pubAfterPrivSeedId = String(signalOf(pubAfterPrivSeed.body).id);

  assert.ok((await wakeRowForProbeAs(personA.id)) !== null, "R2-A2: #lock member sees public wake-path row seeded by #lock observation");
  assert.equal(await receiptObservingAs(personA.id, pubAfterPrivSeedId), true);
  assert.equal(await wakeRowForProbeAs(ownerB.id), null, "R2-A2: hidden #lock seed must NOT activate public agent_wake_path for non-member owner");
  assert.equal(await wakeRowForProbeAs(outsiderC.id), null, "R2-A2: hidden #lock seed must NOT activate public agent_wake_path for outsider");
  assert.equal(await receiptObservingAs(ownerB.id, pubAfterPrivSeedId), false, "R2-A2: hidden #lock seed must NOT flip public wake_path_observing for non-member owner");

  // Direction 2 (Hidden later-observed supersession): establish a public observed seed, leave a public ask unobserved,
  // then post a newer #lock ask and mark it observed — outsiders' public wake-path row and wake_path_observing must stay UNCHANGED!
  const pubSeed = await sendWs(ws, ownerB.jwt, installedPost({
    channel: openSlug,
    signal_kind: "ask",
    to_agent_principal_id: wakeProbeAgent.principal,
    body: "Public observed seed",
  }));
  assert.equal(pubSeed.status, 200);
  await ackObservedUnclaimed(wakeProbeAgent.token, String(signalOf(pubSeed.body).id));

  const pubVisiblePending = await sendWs(ws, ownerB.jwt, installedPost({
    channel: openSlug,
    signal_kind: "ask",
    to_agent_principal_id: wakeProbeAgent.principal,
    body: "Public pending ask before #lock observation",
  }));
  assert.equal(pubVisiblePending.status, 200);
  const pubVisiblePendingId = String(signalOf(pubVisiblePending.body).id);

  const beforePrivSupersedeA = await wakeRowForProbeAs(personA.id);
  const beforePrivSupersedeB = await wakeRowForProbeAs(ownerB.id);
  const beforePrivSupersedeC = await wakeRowForProbeAs(outsiderC.id);
  assert.ok(beforePrivSupersedeB !== null, "public pending ask is visible in agent_wake_path before #lock supersession");
  assert.equal(beforePrivSupersedeA, beforePrivSupersedeB);
  assert.equal(beforePrivSupersedeC, beforePrivSupersedeB);
  assert.equal(await receiptObservingAs(personA.id, pubVisiblePendingId), true);
  assert.equal(await receiptObservingAs(ownerB.id, pubVisiblePendingId), true);

  const privLaterObserved = await sendWs(ws, personA.jwt, installedPost({
    channel: lockSlug,
    signal_kind: "ask",
    to_agent_principal_id: wakeProbeAgent.principal,
    body: "Newer #lock ask observed without lease",
  }));
  assert.equal(privLaterObserved.status, 200);
  await ackObservedUnclaimed(wakeProbeAgent.token, String(signalOf(privLaterObserved.body).id));

  assert.equal(await wakeRowForProbeAs(personA.id), null, "R2-A2: #lock member sees public wake-path row superseded by newer #lock observation");
  assert.equal(await receiptObservingAs(personA.id, pubVisiblePendingId), false);
  assert.equal(
    await wakeRowForProbeAs(ownerB.id),
    beforePrivSupersedeB,
    "R2-A2: hidden newer #lock observation must NOT remove or alter non-member owner's public agent_wake_path row",
  );
  assert.equal(
    await wakeRowForProbeAs(outsiderC.id),
    beforePrivSupersedeC,
    "R2-A2: hidden newer #lock observation must NOT remove or alter outsider's public agent_wake_path row",
  );
  assert.equal(
    await receiptObservingAs(ownerB.id, pubVisiblePendingId),
    true,
    "R2-A2: hidden newer #lock observation must NOT flip non-member owner's public wake_path_observing",
  );
});

test("CM-3a R2 E2 + cross-cutting: private reply channel inheritance (ordinary, H0, hosted MCP), directed recipient privacy inside #lock, implicit thread mentions, and hosted check batch isolation", async () => {
  const tag = randomBytes(4).toString("hex");
  const ws = randomUUID();
  const streamId = randomUUID();
  const personA = await createUser(`r2-e2-a-${tag}`);
  const ownerB = await createUser(`r2-e2-owner-b-${tag}`);
  const memberC = await createUser(`r2-e2-member-c-${tag}`);

  const grantId = randomUUID();
  const hostedSeatXId = randomUUID();
  const hostedSeatOutId = randomUUID();
  const hostedPrincipalX = randomUUID();
  const hostedPrincipalOut = randomUUID();
  const handleX = `seat_${randomBytes(16).toString("hex").slice(0, 22)}`;
  const handleOut = `seat_${randomBytes(16).toString("hex").slice(0, 22)}`;

  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO swarm.users (user_id, display_name)
      VALUES
        (${personA.id}::uuid, 'ReplyPersonA'),
        (${ownerB.id}::uuid, 'ReplyOwnerB'),
        (${memberC.id}::uuid, 'ReplyMemberC')
    `;
    await tx`
      INSERT INTO swarm.workspaces (workspace_id, name, created_by)
      VALUES (${ws}::uuid, ${`R2Reply-${tag}`}, ${ownerB.id}::uuid)
    `;
    await tx`
      INSERT INTO swarm.memberships (workspace_id, user_id, role)
      VALUES
        (${ws}::uuid, ${ownerB.id}::uuid, 'owner'),
        (${ws}::uuid, ${personA.id}::uuid, 'member'),
        (${ws}::uuid, ${memberC.id}::uuid, 'member')
    `;
    await tx`INSERT INTO swarm.streams (stream_id, workspace_id, kind) VALUES (${streamId}::uuid, ${ws}::uuid, 'workspace')`;
    await tx`
      INSERT INTO swarm.agent_principals (principal_id, workspace_id, owner_user_id, name, transport, turn_only)
      VALUES
        (${hostedPrincipalX}::uuid, ${ws}::uuid, ${ownerB.id}::uuid, ${`hosted-x-${tag}`}, 'hosted_mcp', true),
        (${hostedPrincipalOut}::uuid, ${ws}::uuid, ${ownerB.id}::uuid, ${`hosted-out-${tag}`}, 'hosted_mcp', true)
    `;
    await tx`
      INSERT INTO swarm.hosted_mcp_grants (
        grant_id, provider_grant_id, owner_user_id, home_workspace_id, client_id, resource,
        selected_workspace_ids, manifest_digest, interaction_ref, state, created_at, activated_at
      ) VALUES (
        ${grantId}::uuid, ${`provider-${grantId}`}, ${ownerB.id}::uuid, ${ws}::uuid, 'r2-client',
        'https://mcp.commonswarm.com/mcp', ARRAY[${ws}::uuid]::uuid[], decode(repeat('a', 64), 'hex'),
        'r2-consent', 'active', clock_timestamp(), clock_timestamp()
      )
    `;
    await tx`
      INSERT INTO swarm.hosted_mcp_grant_workspaces (grant_id, workspace_id, owner_user_id, manifest_digest, consent_receipt_id, consented_at)
      VALUES (${grantId}::uuid, ${ws}::uuid, ${ownerB.id}::uuid, decode(repeat('a', 64), 'hex'), ${randomUUID()}::uuid, clock_timestamp())
    `;
    await tx`
      INSERT INTO swarm.hosted_mcp_seats (seat_id, grant_id, workspace_id, owner_user_id, principal_id, name, created_at)
      VALUES
        (${hostedSeatXId}::uuid, ${grantId}::uuid, ${ws}::uuid, ${ownerB.id}::uuid, ${hostedPrincipalX}::uuid, ${`hosted-x-${tag}`}, clock_timestamp()),
        (${hostedSeatOutId}::uuid, ${grantId}::uuid, ${ws}::uuid, ${ownerB.id}::uuid, ${hostedPrincipalOut}::uuid, ${`hosted-out-${tag}`}, clock_timestamp())
    `;
    await tx`
      INSERT INTO swarm.hosted_mcp_seat_handles (handle, seat_id, grant_id, workspace_id, principal_id, created_at)
      VALUES
        (${handleX}, ${hostedSeatXId}::uuid, ${grantId}::uuid, ${ws}::uuid, ${hostedPrincipalX}::uuid, clock_timestamp()),
        (${handleOut}, ${hostedSeatOutId}::uuid, ${grantId}::uuid, ${ws}::uuid, ${hostedPrincipalOut}::uuid, clock_timestamp())
    `;
  });

  const localAgentX = await createWsAgent(ws, ownerB.id, `local-x-${tag}`);
  const threadAgent = await createWsAgent(ws, ownerB.id, `thread-ag-${tag}`);

  const openSlug = `open-e2-${tag}`;
  assert.equal((await sendWs(ws, personA.jwt, { kind: "channel_create", slug: openSlug })).status, 200);

  // personA creates #lock admitting personA, memberC, localAgentX, hostedPrincipalX, and threadAgent (ownerB & hostedPrincipalOut stay OUTSIDE!).
  const lockSlug = `lock-e2-${tag}`;
  const lockCreated = await sendWs(ws, personA.jwt, {
    kind: "channel_create",
    slug: lockSlug,
    visibility: "private",
    members: [
      { kind: "user", id: memberC.id },
      { kind: "agent", id: localAgentX.principal },
      { kind: "agent", id: hostedPrincipalX },
      { kind: "agent", id: threadAgent.principal },
    ],
  });
  assert.equal(lockCreated.status, 200, JSON.stringify(lockCreated.body));
  const lockId = String((lockCreated.body.channel as Record<string, unknown>).channel_id);

  // --- R2-B: Implicit thread auto-mentions regression (both agent-authored root and root mentioning agent) ---
  const rawThreadMentionsOf = async (signalId: string) => {
    const rows = await sql<{ agent_id: string; source: string }[]>`
      SELECT mentioned_agent_principal_id::text AS agent_id, source
      FROM swarm.signal_mentions
      WHERE workspace_id = ${ws}::uuid AND signal_id = ${signalId}::uuid
      ORDER BY position
    `;
    return rows.map((r) => ({ agent_id: r.agent_id, source: r.source }));
  };

  // Root shape 1: threadAgent is the root's author inside #lock.
  const rootByAgent = await sendWs(ws, threadAgent.token, installedPost({
    channel: lockSlug,
    body: "Private thread root authored by threadAgent",
  }));
  assert.equal(rootByAgent.status, 200, JSON.stringify(rootByAgent.body));
  const rootByAgentId = String(signalOf(rootByAgent.body).id);

  // Root shape 2: personA authors a root inside #lock that explicitly mentions threadAgent.
  const rootMentioningAgent = await sendWs(ws, personA.jwt, installedPost({
    channel: lockSlug,
    body: "Private thread root mentioning threadAgent",
    mentions: [{ kind: "agent", id: threadAgent.principal }],
  }));
  assert.equal(rootMentioningAgent.status, 200, JSON.stringify(rootMentioningAgent.body));
  const rootMentioningAgentId = String(signalOf(rootMentioningAgent.body).id);

  // Positive controls BEFORE removing threadAgent from #lock: untagged replies from personA store source='thread' and deliver!
  for (const [label, rootId] of [
    ["agent-authored root", rootByAgentId],
    ["agent-mentioned root", rootMentioningAgentId],
  ] as const) {
    const beforeRem = await sendWs(ws, personA.jwt, installedPost({
      thread_root_id: rootId,
      body: `Reply before removal (${label})`,
    }));
    assert.equal(beforeRem.status, 200, JSON.stringify(beforeRem.body));
    const beforeRemId = String(signalOf(beforeRem.body).id);
    assert.deepEqual(
      await rawThreadMentionsOf(beforeRemId),
      [{ agent_id: threadAgent.principal, source: "thread" }],
      `positive control (${label}): admitted threadAgent receives implicit source='thread' mention`,
    );
    assert.deepEqual(await deliveriesOf(beforeRemId), [threadAgent.principal]);
  }

  // Remove threadAgent from #lock while keeping threadAgent's workspace seat live!
  assert.equal(
    (await sendWs(ws, personA.jwt, {
      kind: "channel_member_remove",
      channel_id: lockId,
      member: { kind: "agent", id: threadAgent.principal },
    })).status,
    200,
  );
  const stillLiveInWorkspace = await sendWs(ws, threadAgent.token, installedPost({
    body: "threadAgent workspace seat remains live in #general",
  }));
  assert.equal(stillLiveInWorkspace.status, 200, JSON.stringify(stillLiveInWorkspace.body));

  // After removal from #lock, untagged replies from personA on BOTH roots must store NO source='thread' mention AND NO delivery!
  for (const [label, rootId] of [
    ["agent-authored root", rootByAgentId],
    ["agent-mentioned root", rootMentioningAgentId],
  ] as const) {
    const followUp = await sendWs(ws, personA.jwt, installedPost({
      thread_root_id: rootId,
      body: `Follow-up after threadAgent removed (${label})`,
    }));
    assert.equal(followUp.status, 200, JSON.stringify(followUp.body));
    const followUpId = String(signalOf(followUp.body).id);
    assert.deepEqual(
      await rawThreadMentionsOf(followUpId),
      [],
      `R2-B (${label}): edge gate must omit stored implicit source='thread' row in swarm.signal_mentions after #lock removal`,
    );
    assert.deepEqual(
      await deliveriesOf(followUpId),
      [],
      `R2-B (${label}): removed agent must NOT receive delivery on #lock thread reply`,
    );
  }

  // --- E2: Ordinary post_signal + H0 reply + Hosted MCP reply inheritance & recipient isolation ---
  const askFromLocalX = await sendWs(ws, localAgentX.token, installedPost({
    channel: lockSlug,
    signal_kind: "ask",
    to: [{ kind: "user", id: personA.id }],
    body: "Private question from localAgentX to personA",
  }));
  assert.equal(askFromLocalX.status, 200, JSON.stringify(askFromLocalX.body));
  const askLocalId = String(signalOf(askFromLocalX.body).id);

  // Caller-supplied alternate channel escape is refused with 409 private_reply_channel_mismatch!
  const escapeAttempt = await sendWs(ws, personA.jwt, installedPost({
    in_reply_to: askLocalId,
    channel: openSlug,
    body: "Attempt to leak reply into open channel",
  }));
  assert.equal(escapeAttempt.status, 409, JSON.stringify(escapeAttempt.body));
  assert.equal(escapeAttempt.body.error, "private_reply_channel_mismatch");

  // 1. Ordinary in_reply_to (omitting channel) inherits lockId!
  const ordinaryReply = await sendWs(ws, personA.jwt, installedPost({
    in_reply_to: askLocalId,
    body: "Ordinary answer from personA to localAgentX",
  }));
  assert.equal(ordinaryReply.status, 200, JSON.stringify(ordinaryReply.body));
  const ordinaryReplyId = String(signalOf(ordinaryReply.body).id);
  assert.equal(signalOf(ordinaryReply.body).channel_id, lockId, "ordinary in_reply_to must inherit private channel_id");

  // 2. H0 /functions/v1/h0/reply inherits lockId!
  {
    const h0Deadline = Date.now() + 20_000;
    let h0Ready = false;
    while (Date.now() < h0Deadline) {
      try {
        const probe = await fetch(`${local.API_URL}/functions/v1/h0/agent-doc/test`, { signal: AbortSignal.timeout(4_000) });
        if (probe.status === 200) {
          h0Ready = true;
          break;
        }
      } catch { /* wait for worker */ }
      await delay(150);
    }
    assert.ok(h0Ready, "h0 worker ready");
  }
  const h0Res = await fetch(`${local.API_URL}/functions/v1/h0/reply`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${localAgentX.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      signal_id: ordinaryReplyId,
      body: "H0 follow-up answer in #lock",
      requestId: randomUUID(),
    }),
  });
  const h0Body = await h0Res.json() as Record<string, unknown>;
  assert.equal(h0Res.status, 200, JSON.stringify(h0Body));
  const h0ReplyId = String(signalOf(h0Body).id);
  assert.equal(signalOf(h0Body).channel_id, lockId, "H0 reply must inherit private channel_id");

  // 3. Hosted MCP seat isolation + hosted reply + hosted check batch removal guard (via real Deno command/read handlers)
  const commandHref = new URL("../../supabase/functions/command/index.ts", import.meta.url).href;
  const readHref = new URL("../../supabase/functions/read/index.ts", import.meta.url).href;
  const authHref = new URL("../../supabase/functions/_shared/hosted-seat-auth.ts", import.meta.url).href;
  const denoHarnessDir = mkdtempSync(join(tmpdir(), "cswarm-r2-hosted-"));
  const denoScript = join(denoHarnessDir, "run.ts");
  writeFileSync(
    denoScript,
    `
const input = JSON.parse(await new Response(Deno.stdin.readable).text());
const cmdMod = await import(${JSON.stringify(commandHref)});
const readMod = await import(${JSON.stringify(readHref)});
const authMod = await import(${JSON.stringify(authHref)});

async function cap(handle: string, tool: string, use: "command" | "read") {
  const c = await cmdMod.db.begin(async (tx: any) => {
    await tx.unsafe(use === "read" ? "SET LOCAL ROLE swarm_read" : "SET LOCAL ROLE swarm_command");
    return await authMod.authenticateHostedSeatCapability(tx, {
      grantId: input.grantId,
      providerGrantId: "provider-" + input.grantId,
      handle,
      tool: tool as any,
      providerStatus: async () => ({ active: true }),
    }, use);
  });
  if (!c) throw new Error("Failed to mint hosted capability for " + tool);
  return c;
}

const out: Record<string, unknown> = {};
if (input.op === "checks") {
  // Outsider hosted seat: channel_ls omits #lock, channel_read 404s, check omits #lock signals.
  const outLsCap = await cap(input.handleOut, "channel_ls", "read");
  out.outChannels = await readMod.handleHostedRead({ resource: "channels", workspace_id: input.ws }, outLsCap);
  const outReadCap = await cap(input.handleOut, "channel_read", "read");
  out.outReadLock = await readMod.handleHostedRead({
    resource: "channel_messages", workspace_id: input.ws, channel: input.lockSlug, after_id: null, limit: 20, fit_bytes: 32768,
  }, outReadCap);
  const outCheckCap = await cap(input.handleOut, "check", "command");
  out.outCheck = await cmdMod.handleHostedCommand({
    command_id: crypto.randomUUID(), client_version: "0.1.80", workspace_id: input.ws, stream: { kind: "workspace" },
    command: { kind: "open_hosted_mcp_check_batch", seat: input.handleOut },
  }, outCheckCap);

  // Admitted hosted seat X: channel_ls includes #lock, channel_read succeeds, ask & reply inherit #lock!
  const xLsCap = await cap(input.handleX, "channel_ls", "read");
  out.xChannels = await readMod.handleHostedRead({ resource: "channels", workspace_id: input.ws }, xLsCap);
  const xReadCap = await cap(input.handleX, "channel_read", "read");
  out.xReadLock = await readMod.handleHostedRead({
    resource: "channel_messages", workspace_id: input.ws, channel: input.lockSlug, after_id: null, limit: 20, fit_bytes: 32768,
  }, xReadCap);
  const xAskCap = await cap(input.handleX, "ask", "command");
  out.xAsk = await cmdMod.handleHostedCommand({
    command_id: crypto.randomUUID(), client_version: "0.1.80", workspace_id: input.ws, stream: { kind: "workspace" },
    command: {
      kind: "post_signal", signal_kind: "ask", body: "Hosted ask in #lock",
      to_user_id: null, to_agent_principal_id: null, in_reply_to: null, about: null,
      channel: input.lockSlug, to: [{ kind: "user", id: input.personAId }],
    },
  }, xAskCap);
} else if (input.op === "reply_and_batch") {
  const xReplyCap = await cap(input.handleX, "reply", "command");
  out.xReply = await cmdMod.handleHostedCommand({
    command_id: crypto.randomUUID(), client_version: "0.1.80", workspace_id: input.ws, stream: { kind: "workspace" },
    command: {
      kind: "post_signal", signal_kind: "note", body: "Hosted reply in #lock",
      to_user_id: null, to_agent_principal_id: null, in_reply_to: input.personAReplyId, about: null,
    },
  }, xReplyCap);
  const xCheckCap = await cap(input.handleX, "check", "command");
  out.xBatch = await cmdMod.handleHostedCommand({
    command_id: input.batchCmdId, client_version: "0.1.80", workspace_id: input.ws, stream: { kind: "workspace" },
    command: { kind: "open_hosted_mcp_check_batch", seat: input.handleX },
  }, xCheckCap);
} else if (input.op === "after_removal") {
  const xCheckCap = await cap(input.handleX, "check", "command");
  out.xBatchAfterRemoval = await cmdMod.handleHostedCommand({
    command_id: crypto.randomUUID(), client_version: "0.1.80", workspace_id: input.ws, stream: { kind: "workspace" },
    command: { kind: "open_hosted_mcp_check_batch", seat: input.handleX },
  }, xCheckCap);
}
console.log("R2_HOSTED_OUT:" + JSON.stringify(out));
Deno.exit(0);
`,
  );

  const runHosted = (payload: Record<string, unknown>) => {
    const proc = spawnSync("deno", [
      "run",
      "--no-lock",
      "--config",
      "supabase/functions/command/deno.json",
      "-A",
      denoScript,
    ], {
      cwd: process.cwd(),
      input: JSON.stringify(payload),
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        ...(process.env.DENO_DIR ? { DENO_DIR: process.env.DENO_DIR } : {}),
        SWARM_ENV: "test",
        SWARM_DATABASE_URL: local.DB_URL,
        SUPABASE_DB_URL: local.DB_URL,
        SUPABASE_URL: local.API_URL,
        SUPABASE_ANON_KEY: local.ANON_KEY,
        SUPABASE_SERVICE_ROLE_KEY: local.SERVICE_ROLE_KEY,
        SWARM_CHAT_MENTIONS: "1",
      },
      timeout: 60_000,
    });
    assert.equal(proc.status, 0, `deno hosted helper failed: ${proc.stderr}\n${proc.stdout}`);
    const markerLine = proc.stdout.trim().split("\n").reverse().find((l) => l.startsWith("R2_HOSTED_OUT:"));
    assert.equal(typeof markerLine, "string", `missing R2_HOSTED_OUT in:\n${proc.stdout}`);
    return JSON.parse(markerLine!.slice("R2_HOSTED_OUT:".length)) as Record<string, any>;
  };

  let hostedAskId = "";
  let personAReplyToHostedId = "";
  let hostedReplyId = "";
  try {
    // Post a #lock mention for hostedPrincipalX before running checks.
    const mentionHostedX = await sendWs(ws, personA.jwt, installedPost({
      channel: lockSlug,
      body: "Board deck ready for hostedX",
      mentions: [{ kind: "agent", id: hostedPrincipalX }],
    }));
    assert.equal(mentionHostedX.status, 200);
    const mentionHostedXId = String(signalOf(mentionHostedX.body).id);

    const step1 = runHosted({
      op: "checks",
      ws,
      grantId,
      handleX,
      handleOut,
      lockSlug,
      personAId: personA.id,
    });
    assert.equal(step1.outChannels.status, 200, JSON.stringify(step1.outChannels));
    assert.equal(
      (step1.outChannels.body.channels as Array<{ slug: string }>).some((c) => c.slug === lockSlug),
      false,
      "non-member hosted seat channel_ls must omit #lock",
    );
    assert.equal(step1.outReadLock.status, 404, "non-member hosted seat channel_read must 404 on #lock");
    assert.equal((step1.outCheck.body.signals as unknown[]).length, 0, "non-member hosted seat check must omit #lock");

    assert.equal(step1.xChannels.status, 200, JSON.stringify(step1.xChannels));
    assert.equal(
      (step1.xChannels.body.channels as Array<{ slug: string }>).some((c) => c.slug === lockSlug),
      true,
      "admitted hosted seat channel_ls includes #lock",
    );
    assert.equal(step1.xReadLock.status, 200, JSON.stringify(step1.xReadLock));
    assert.equal(step1.xAsk.status, 200, JSON.stringify(step1.xAsk));
    hostedAskId = String(step1.xAsk.body.signal.id);

    // personA answers hostedPrincipalX via ordinary in_reply_to (inherits lockId!), then hostedPrincipalX replies via hosted MCP reply!
    const personAToHosted = await sendWs(ws, personA.jwt, installedPost({
      in_reply_to: hostedAskId,
      body: "PersonA answer to hosted seat X",
    }));
    assert.equal(personAToHosted.status, 200, JSON.stringify(personAToHosted.body));
    personAReplyToHostedId = String(signalOf(personAToHosted.body).id);
    assert.equal(signalOf(personAToHosted.body).channel_id, lockId);

    const batchCmdId = randomUUID();
    const step2 = runHosted({
      op: "reply_and_batch",
      ws,
      grantId,
      handleX,
      personAReplyId: personAReplyToHostedId,
      batchCmdId,
    });
    assert.equal(step2.xReply.status, 200, JSON.stringify(step2.xReply));
    hostedReplyId = String(step2.xReply.body.signal.id);
    assert.equal(step2.xReply.body.signal.channel_id, lockId, "hosted MCP reply must inherit private channel_id");
    assert.ok(
      (step2.xBatch.body.signals as Array<{ id: string }>).some((s) => s.id === mentionHostedXId || s.id === personAReplyToHostedId),
      "admitted hosted seat receives #lock items in check batch",
    );

    // Verify ownerB (human owner of BOTH localAgentX and hostedPrincipalX, NOT in #lock!) reads ZERO rows across every read surface!
    const allProtectedSignalIds = [askLocalId, ordinaryReplyId, h0ReplyId, hostedAskId, personAReplyToHostedId, hostedReplyId];
    const statusTargetIds = [...allProtectedSignalIds, mentionHostedXId];
    const ownerBSignals = await viewRowAs(ownerB.id, async (tx) =>
      await tx`SELECT id FROM swarm_read.signals WHERE id = ANY(${statusTargetIds}::uuid[])`
    );
    assert.equal(ownerBSignals.length, 0, "non-member agent owner must read ZERO #lock asks, replies, or mentions in swarm_read.signals");

    const [ownerBDecisions] = await viewRowAs(ownerB.id, async (tx) =>
      await tx<{ q: { total: number; asks: unknown[] } }[]>`
        SELECT swarm_read.decision_queue(${ws}::uuid) AS q
      `
    );
    assert.equal(ownerBDecisions!.q.total, 0, "non-member agent owner must read ZERO rows in decision_queue");
    assert.deepEqual(ownerBDecisions!.q.asks, []);

    const [ownerBStatuses] = await viewRowAs(ownerB.id, async (tx) =>
      await tx<{ ms: { statuses: unknown[] } }[]>`
        SELECT swarm_read.message_status(${ws}::uuid, ${statusTargetIds}::uuid[]) AS ms
      `
    );
    assert.deepEqual(ownerBStatuses!.ms.statuses, [], "non-member agent owner must read ZERO rows in message_status");

    // Verify memberC (admitted to #lock, but NOT a directed recipient!) CANNOT read the 1:1 directed asks or replies!
    const memberCDirected = await viewRowAs(memberC.id, async (tx) =>
      await tx`SELECT id FROM swarm_read.signals WHERE id = ANY(${allProtectedSignalIds}::uuid[])`
    );
    assert.equal(
      memberCDirected.length,
      0,
      "inheriting private channel_id on in_reply_to must NEVER widen directed 1:1 replies to other #lock members",
    );

    // Positive control: personA (authorized recipient/sender in #lock) reads all 4 agent->personA asks/replies in swarm_read.signals,
    // reads delivery receipts on personA's 2 replies to ownerB's agents (while ownerB & memberC receive null), and reads message_status on #lock mention!
    const personADirected = await viewRowAs(personA.id, async (tx) =>
      await tx<{ id: string }[]>`SELECT id::text AS id FROM swarm_read.signals WHERE id = ANY(${allProtectedSignalIds}::uuid[])`
    );
    assert.deepEqual(
      personADirected.map((r) => r.id).sort(),
      [askLocalId, h0ReplyId, hostedAskId, hostedReplyId].sort(),
      "authorized #lock recipient reads all 4 incoming directed asks/replies in swarm_read.signals",
    );
    for (const sentReplyId of [ordinaryReplyId, personAReplyToHostedId]) {
      const [personAReceipt] = await viewRowAs(personA.id, async (tx) =>
        await tx<{ r: { addressed: boolean } | null }[]>`SELECT swarm_read.signal_delivery_receipts(${ws}::uuid, ${sentReplyId}::uuid) AS r`
      );
      assert.equal(personAReceipt!.r?.addressed, true, "authorized #lock sender reads delivery receipts for own reply to agent");
      for (const deniedViewerId of [ownerB.id, memberC.id]) {
        const [deniedReceipt] = await viewRowAs(deniedViewerId, async (tx) =>
          await tx<{ r: unknown }[]>`SELECT swarm_read.signal_delivery_receipts(${ws}::uuid, ${sentReplyId}::uuid) AS r`
        );
        assert.equal(deniedReceipt!.r, null, `viewer ${deniedViewerId} must NOT read delivery receipts on directed #lock reply`);
      }
    }
    const [personAStatuses] = await viewRowAs(personA.id, async (tx) =>
      await tx<{ ms: { statuses: Array<{ signal_id: string }> } }[]>`
        SELECT swarm_read.message_status(${ws}::uuid, ${statusTargetIds}::uuid[]) AS ms
      `
    );
    assert.deepEqual(
      personAStatuses!.ms.statuses.map((s) => s.signal_id),
      [mentionHostedXId],
      "authorized #lock sender reads message_status on #lock agent mention",
    );

    // Remove hostedPrincipalX from #lock while step2.xBatch (holding ONLY #lock signals) is still open,
    // post an open-channel ask, and verify open_hosted_mcp_check_batch automatically advances past the
    // now-revoked #lock batch without wedging or leaking #lock items, returning ONLY the open ask!
    assert.equal(
      (await sendWs(ws, personA.jwt, {
        kind: "channel_member_remove",
        channel_id: lockId,
        member: { kind: "agent", id: hostedPrincipalX },
      })).status,
      200,
    );
    const openMixed = await sendWs(ws, ownerB.jwt, installedPost({
      channel: openSlug,
      signal_kind: "ask",
      to: [{ kind: "agent", id: hostedPrincipalX }],
      body: "Open ask after #lock removal",
    }));
    assert.equal(openMixed.status, 200);
    const openMixedId = String(signalOf(openMixed.body).id);

    const step3 = runHosted({ op: "after_removal", ws, grantId, handleX });
    assert.equal(step3.xBatchAfterRemoval.status, 200, JSON.stringify(step3.xBatchAfterRemoval));
    const afterIds = (step3.xBatchAfterRemoval.body.signals as Array<{ id: string }>).map((s) => s.id);
    assert.ok(afterIds.includes(openMixedId), "removed hosted seat still receives open-channel ask");
    for (const secretId of [mentionHostedXId, ...allProtectedSignalIds]) {
      assert.ok(!afterIds.includes(secretId), `removed hosted seat check batch must omit #lock signal ${secretId}`);
    }
  } finally {
    rmSync(denoHarnessDir, { recursive: true, force: true });
  }
});

test("CM-3a R2 C4 + E1: workspace removal/re-admission durability, role-demotion & creator-left manager promotion, zero-human auto-archive, removed-author reraise, claim replay hydration, and concurrent last-manager serialization", async () => {
  const tag = randomBytes(4).toString("hex");
  const ws = randomUUID();
  const ownerOut = await createUser(`r2-c4-owner-${tag}`);
  const creatorA = await createUser(`r2-c4-creator-a-${tag}`);
  const memberB = await createUser(`r2-c4-member-b-${tag}`);
  const adminX = await createUser(`r2-c4-admin-x-${tag}`);
  const adminY = await createUser(`r2-c4-admin-y-${tag}`);

  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO swarm.users (user_id, display_name)
      VALUES
        (${ownerOut.id}::uuid, 'OwnerOutside'),
        (${creatorA.id}::uuid, 'CreatorA'),
        (${memberB.id}::uuid, 'MemberB'),
        (${adminX.id}::uuid, 'AdminX'),
        (${adminY.id}::uuid, 'AdminY')
    `;
    await tx`
      INSERT INTO swarm.workspaces (workspace_id, name, created_by)
      VALUES (${ws}::uuid, ${`R2Lifecycle-${tag}`}, ${ownerOut.id}::uuid)
    `;
    await tx`
      INSERT INTO swarm.memberships (workspace_id, user_id, role)
      VALUES
        (${ws}::uuid, ${ownerOut.id}::uuid, 'owner'),
        (${ws}::uuid, ${creatorA.id}::uuid, 'member'),
        (${ws}::uuid, ${memberB.id}::uuid, 'member'),
        (${ws}::uuid, ${adminX.id}::uuid, 'admin'),
        (${ws}::uuid, ${adminY.id}::uuid, 'admin')
    `;
    await tx`INSERT INTO swarm.streams (stream_id, workspace_id, kind) VALUES (${randomUUID()}::uuid, ${ws}::uuid, 'workspace')`;
  });

  const agentOwnedByOut = await createWsAgent(ws, ownerOut.id, `ag-out-${tag}`);
  const deliveryClient = new DeliveryCommandClient(cloudTarget(local.API_URL, local.ANON_KEY));

  // --- Scenario A: Ordinary creatorA creates #lock1 with ordinary memberB + agentOwnedByOut;
  // ownerOut removes creatorA from workspace -> memberB promoted to is_manager = true, ownerOut NOT admitted,
  // claim replay after agent workspace removal hides body, and re-admission (E1) does NOT restore #lock1 access! ---
  const lock1Slug = `c4-promote-${tag}`;
  const lock1Res = await sendWs(ws, creatorA.jwt, {
    kind: "channel_create",
    slug: lock1Slug,
    visibility: "private",
    members: [
      { kind: "user", id: memberB.id },
      { kind: "agent", id: agentOwnedByOut.principal },
    ],
  });
  assert.equal(lock1Res.status, 200, JSON.stringify(lock1Res.body));
  const lock1Id = String((lock1Res.body.channel as Record<string, unknown>).channel_id);
  const lock1InitialMembers = lock1Res.body.members as Array<{ id: string; is_manager: boolean }>;
  assert.equal(lock1InitialMembers.find((m) => m.id === creatorA.id)?.is_manager, true);
  assert.equal(lock1InitialMembers.find((m) => m.id === memberB.id)?.is_manager, false);

  // creatorA posts a directed ask to memberB (for removed-author reraise check) and mentions agentOwnedByOut (for claim replay check).
  const creatorAsk = await sendWs(ws, creatorA.jwt, installedPost({
    channel: lock1Slug,
    signal_kind: "ask",
    to: [{ kind: "user", id: memberB.id }],
    body: "CreatorA ask before removal",
  }));
  assert.equal(creatorAsk.status, 200);
  const creatorAskId = String(signalOf(creatorAsk.body).id);

  const wakeAgentMsg = await sendWs(ws, memberB.jwt, installedPost({
    channel: lock1Slug,
    body: "Confidential mention for claim replay",
    mentions: [{ kind: "agent", id: agentOwnedByOut.principal }],
  }));
  assert.equal(wakeAgentMsg.status, 200);
  const wakeAgentMsgId = String(signalOf(wakeAgentMsg.body).id);

  const claimCmdId = randomUUID();
  const listenerId = randomUUID();
  const firstClaim = await deliveryClient.claimAgentInbox({
    workspaceId: ws,
    credential: agentOwnedByOut.token,
    commandId: claimCmdId,
    listenerInstanceId: listenerId,
    expectedPrincipalId: agentOwnedByOut.principal,
  });
  assert.equal(firstClaim.deliveries.length, 1);
  assert.equal(firstClaim.deliveries[0]!.signal.id, wakeAgentMsgId);
  assert.equal(firstClaim.deliveries[0]!.signal.channel_visibility, "private");

  // Workspace owner (ownerOut, NOT in #lock1) removes creatorA from the workspace!
  const remCreator = await sendWs(ws, ownerOut.jwt, { kind: "remove_member", user_id: creatorA.id });
  assert.equal(remCreator.status, 200, JSON.stringify(remCreator.body));

  // Verify memberB was promoted to is_manager = true + audit_log row recorded, and ownerOut was NOT admitted!
  const bReadMembers = await viewRowAs(memberB.id, async (tx) =>
    await tx<{ id: string; is_manager: boolean }[]>`
      SELECT id::text, is_manager FROM swarm_read.channel_members WHERE channel_id = ${lock1Id}::uuid
    `
  );
  assert.equal(bReadMembers.find((m) => m.id === creatorA.id), undefined, "removed workspace member deleted from channel_members");
  assert.equal(bReadMembers.find((m) => m.id === memberB.id)?.is_manager, true, "memberB promoted to is_manager = true");

  const [promoAudit] = await sql<{ command_kind: string; reason: string; detail: string }[]>`
    SELECT command_kind, reason, detail FROM swarm.audit_log
    WHERE workspace_id = ${ws}::uuid
      AND command_kind = 'private_channel_manager_promoted'
      AND stream_id = ${lock1Id}::uuid
  `;
  assert.equal(promoAudit?.reason, "workspace_member_removed");
  assert.equal(promoAudit?.detail, `channel_id=${lock1Id},promoted_user_id=${memberB.id}`);

  // R2-A3: Client audit view (swarm_read.audit_log) must hide private-channel lifecycle rows and identifiers
  // from non-member workspace owners/admins (ownerOut, adminY), while showing them to an admitted #lock admin!
  const clientAuditAs = async (userId: string) =>
    await viewRowAs(userId, async (tx) =>
      await tx<{
        command_kind: string;
        actor_user: string | null;
        stream_id: string | null;
        reason: string | null;
        detail: string | null;
      }[]>`
        SELECT command_kind, actor_user::text, stream_id::text, reason, detail
        FROM swarm_read.audit_log
        WHERE workspace_id = ${ws}::uuid
        ORDER BY audit_id ASC
      `
    );

  const ownerOutAuditAfterPromo = await clientAuditAs(ownerOut.id);
  assert.ok(
    ownerOutAuditAfterPromo.some((r) => r.command_kind === "remove_member"),
    "positive control: workspace owner ownerOut can read workspace-level rows in swarm_read.audit_log",
  );
  assert.deepEqual(
    ownerOutAuditAfterPromo.filter((r) =>
      r.command_kind === "private_channel_manager_promoted" || r.command_kind === "private_channel_auto_archived"
    ),
    [],
    "R2-A3: non-member workspace owner must NOT see private_channel_manager_promoted in swarm_read.audit_log",
  );
  assert.equal(
    JSON.stringify(ownerOutAuditAfterPromo).includes(lock1Id),
    false,
    "R2-A3: non-member workspace owner must NOT see private channel UUID in swarm_read.audit_log",
  );

  // Positive control for admitted admin: memberB adds adminY to #lock1 -> adminY sees #lock1's promotion row in swarm_read.audit_log,
  // then adminY leaves #lock1 so memberB remains sole manager for subsequent scenarios!
  assert.equal(
    (await sendWs(ws, memberB.jwt, {
      kind: "channel_member_add",
      channel_id: lock1Id,
      members: [{ kind: "user", id: adminY.id }],
    })).status,
    200,
  );
  const adminYAuditWhileAdmitted = await clientAuditAs(adminY.id);
  assert.deepEqual(
    adminYAuditWhileAdmitted
      .filter((r) => r.command_kind === "private_channel_manager_promoted")
      .map((r) => ({ stream_id: r.stream_id, actor_user: r.actor_user, reason: r.reason, detail: r.detail })),
    [{
      stream_id: lock1Id,
      actor_user: memberB.id,
      reason: "workspace_member_removed",
      detail: `channel_id=${lock1Id},promoted_user_id=${memberB.id}`,
    }],
    "R2-A3 positive control: admitted #lock1 admin sees #lock1 promotion row in swarm_read.audit_log",
  );
  assert.equal((await sendWs(ws, adminY.jwt, { kind: "channel_leave", channel_id: lock1Id })).status, 200);

  assert.equal(
    (await sendWs(ws, ownerOut.jwt, { kind: "channel_update", channel_id: lock1Id, purpose: "Owner probe" })).status,
    404,
    "workspace owner outside #lock1 must NOT be silently admitted on manager promotion",
  );
  const bManages = await sendWs(ws, memberB.jwt, {
    kind: "channel_update",
    channel_id: lock1Id,
    purpose: "MemberB is now manager",
  });
  assert.equal(bManages.status, 200, JSON.stringify(bManages.body));

  // Soft-revoke agentOwnedByOut's workspace seat (E1 agent path) AND verify claim_agent_inbox replay with claimCmdId does NOT leak the body!
  await sql`
    UPDATE swarm.agent_workspace_memberships
    SET revoked_at = statement_timestamp()
    WHERE workspace_id = ${ws}::uuid AND principal_id = ${agentOwnedByOut.principal}::uuid
  `;
  // Restore token auth by un-revoking seat AFTER checking channel_members was durably deleted by trigger!
  const agentChannelRowAfterRevoke = await sql`
    SELECT channel_id FROM swarm.channel_members
    WHERE channel_id = ${lock1Id}::uuid AND agent_principal_id = ${agentOwnedByOut.principal}::uuid
  `;
  assert.equal(agentChannelRowAfterRevoke.length, 0, "E1: revoking agent_workspace_memberships durably deletes channel_members row");

  // Post a message while BOTH creatorA and agentOwnedByOut are absent!
  const whileAbsentPost = await sendWs(ws, memberB.jwt, installedPost({
    channel: lock1Slug,
    body: "Posted while creatorA and agentOwnedByOut were absent",
  }));
  assert.equal(whileAbsentPost.status, 200);
  const whileAbsentId = String(signalOf(whileAbsentPost.body).id);

  // Re-admit BOTH creatorA and agentOwnedByOut to the workspace (E1)!
  await sql.begin(async (tx) => {
    await tx`
      UPDATE swarm.memberships
      SET revoked_at = NULL, role = 'member'
      WHERE workspace_id = ${ws}::uuid AND user_id = ${creatorA.id}::uuid
    `;
    await tx`
      UPDATE swarm.agent_workspace_memberships
      SET revoked_at = NULL
      WHERE workspace_id = ${ws}::uuid AND principal_id = ${agentOwnedByOut.principal}::uuid
    `;
  });

  // Replay of claimCmdId by re-admitted agentOwnedByOut MUST NOT hydrate the #lock1 message body!
  const replayedClaimAfterExit = await deliveryClient.claimAgentInbox({
    workspaceId: ws,
    credential: agentOwnedByOut.token,
    commandId: claimCmdId,
    listenerInstanceId: listenerId,
    expectedPrincipalId: agentOwnedByOut.principal,
  });
  assert.equal(
    replayedClaimAfterExit.deliveries.length,
    0,
    "replaying claim_agent_inbox after #lock loss must NOT hydrate confidential body",
  );

  // E1 verification: re-admitted creatorA and re-admitted agentOwnedByOut see ZERO #lock1 channels or messages, and reraise_ask 404s!
  const reAdmittedAChannels = await viewRowAs(creatorA.id, async (tx) =>
    await tx`SELECT channel_id FROM swarm_read.channels WHERE channel_id = ${lock1Id}::uuid`
  );
  assert.equal(reAdmittedAChannels.length, 0, "E1: re-admitted person must NOT regain private channel visibility");
  const reAdmittedASignals = await viewRowAs(creatorA.id, async (tx) =>
    await tx`SELECT id FROM swarm_read.signals WHERE id IN (${creatorAskId}::uuid, ${whileAbsentId}::uuid)`
  );
  assert.equal(reAdmittedASignals.length, 0, "E1: re-admitted person must NOT read prior or absent-window #lock messages");

  const reraiseByRemovedAuthor = await sendWs(ws, creatorA.jwt, { kind: "reraise_ask", signal_id: creatorAskId });
  assert.equal(reraiseByRemovedAuthor.status, 404, JSON.stringify(reraiseByRemovedAuthor.body));

  const reAdmittedAgentRead = await readWs(agentOwnedByOut.token, {
    resource: "channel_messages",
    workspace_id: ws,
    channel: lock1Slug,
  });
  assert.equal(reAdmittedAgentRead.status, 404, "E1: re-admitted agent must NOT regain private channel access");

  // --- Scenario B: Creator hands off #lock2 to adminX and leaves; ownerOut demotes adminX (admin -> member) -> adminX promoted! ---
  const lock2Res = await sendWs(ws, ownerOut.jwt, {
    kind: "channel_create",
    slug: `c4-demote-${tag}`,
    visibility: "private",
    members: [{ kind: "user", id: adminX.id }],
  });
  assert.equal(lock2Res.status, 200);
  const lock2Id = String((lock2Res.body.channel as Record<string, unknown>).channel_id);
  assert.equal((await sendWs(ws, ownerOut.jwt, { kind: "channel_leave", channel_id: lock2Id })).status, 200);

  // Demote adminX from admin -> member: trigger stamps is_manager = true on adminX so #lock2 keeps its manager!
  const demoteRes = await sendWs(ws, ownerOut.jwt, { kind: "change_role", user_id: adminX.id, role: "member" });
  assert.equal(demoteRes.status, 200, JSON.stringify(demoteRes.body));

  const [xAfterDemote] = await sql<{ is_manager: boolean }[]>`
    SELECT is_manager FROM swarm.channel_members
    WHERE channel_id = ${lock2Id}::uuid AND user_id = ${adminX.id}::uuid
  `;
  assert.equal(xAfterDemote?.is_manager, true, "C4: demoted sole admin in #lock2 is promoted to explicit is_manager = true");
  const [demoteAudit] = await sql<{ command_kind: string; reason: string; detail: string }[]>`
    SELECT command_kind, reason, detail FROM swarm.audit_log
    WHERE workspace_id = ${ws}::uuid
      AND command_kind = 'private_channel_manager_promoted'
      AND stream_id = ${lock2Id}::uuid
  `;
  assert.equal(demoteAudit?.reason, "workspace_role_demoted");
  assert.equal(demoteAudit?.detail, `channel_id=${lock2Id},promoted_user_id=${adminX.id}`);
  assert.equal(
    (await sendWs(ws, adminX.jwt, { kind: "channel_update", channel_id: lock2Id, purpose: "Still managed after demotion" })).status,
    200,
  );
  assert.equal(
    (await sendWs(ws, adminX.jwt, { kind: "channel_leave", channel_id: lock2Id })).status,
    409,
    "demoted-but-promoted sole manager still protected by channel_last_manager",
  );

  // --- Scenario C: Sole human member removed while an agent remains -> #lock1 auto-archives! ---
  // Re-add agentOwnedByOut to #lock1 as memberB, then ownerOut removes memberB (leaving 0 live humans in #lock1!).
  assert.equal(
    (await sendWs(ws, memberB.jwt, {
      kind: "channel_member_add",
      channel_id: lock1Id,
      members: [{ kind: "agent", id: agentOwnedByOut.principal }],
    })).status,
    200,
  );
  assert.equal((await sendWs(ws, ownerOut.jwt, { kind: "remove_member", user_id: memberB.id })).status, 200);

  const [lock1Archived] = await sql<{ archived_at: Date | null }[]>`
    SELECT archived_at FROM swarm.channels WHERE channel_id = ${lock1Id}::uuid
  `;
  assert.ok(lock1Archived?.archived_at !== null, "C4: private channel with 0 live humans left auto-archives");
  const [archiveAudit] = await sql<{ command_kind: string; reason: string; detail: string }[]>`
    SELECT command_kind, reason, detail FROM swarm.audit_log
    WHERE workspace_id = ${ws}::uuid
      AND command_kind = 'private_channel_auto_archived'
      AND stream_id = ${lock1Id}::uuid
  `;
  assert.equal(archiveAudit?.command_kind, "private_channel_auto_archived");
  assert.equal(archiveAudit?.reason, "no_remaining_human_members");
  assert.equal(archiveAudit?.detail, `channel_id=${lock1Id}`);

  // R2-A3 after both role-demotion promotion (#lock2) and zero-human auto-archive (#lock1):
  // neither non-member ownerOut nor departed adminY sees #lock1 or #lock2 lifecycle rows or UUIDs in swarm_read.audit_log!
  for (const [label, userId] of [["ownerOut", ownerOut.id], ["adminY", adminY.id]] as const) {
    const auditRows = await clientAuditAs(userId);
    assert.deepEqual(
      auditRows.filter((r) =>
        r.command_kind === "private_channel_manager_promoted" || r.command_kind === "private_channel_auto_archived"
      ),
      [],
      `R2-A3: ${label} outside #lock1/#lock2 must NOT see promotion or auto-archive rows in swarm_read.audit_log`,
    );
    const serialized = JSON.stringify(auditRows);
    assert.equal(serialized.includes(lock1Id), false, `R2-A3: ${label} audit view must NOT leak lock1Id`);
    assert.equal(serialized.includes(lock2Id), false, `R2-A3: ${label} audit view must NOT leak lock2Id`);
  }
  const agentPostArchived = await sendWs(ws, agentOwnedByOut.token, installedPost({
    channel: lock1Slug,
    body: "Agent post after zero-human auto-archive",
  }));
  assert.equal(agentPostArchived.status, 409, JSON.stringify(agentPostArchived.body));
  assert.equal(agentPostArchived.body.error, "channel_archived");

  // --- Scenario D: Concurrent last-manager removal/leave serialization under channel-access advisory lock ---
  const lock4Res = await sendWs(ws, ownerOut.jwt, {
    kind: "channel_create",
    slug: `c4-race-${tag}`,
    visibility: "private",
    members: [
      { kind: "user", id: adminY.id },
      { kind: "agent", id: agentOwnedByOut.principal },
    ],
  });
  assert.equal(lock4Res.status, 200, JSON.stringify(lock4Res.body));
  const lock4Id = String((lock4Res.body.channel as Record<string, unknown>).channel_id);

  const [leave1, leave2] = await Promise.all([
    sendWs(ws, ownerOut.jwt, { kind: "channel_leave", channel_id: lock4Id }),
    sendWs(ws, adminY.jwt, { kind: "channel_leave", channel_id: lock4Id }),
  ]);
  const statuses = [leave1.status, leave2.status].sort((a, b) => a - b);
  assert.deepEqual(
    statuses,
    [200, 409],
    `concurrent last-manager leaves must allow one and refuse one: ${JSON.stringify([leave1, leave2])}`,
  );
  const loser = leave1.status === 409 ? leave1 : leave2;
  assert.equal(loser.body.error, "channel_last_manager");
});
