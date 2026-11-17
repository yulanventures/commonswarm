/** HM lane-3 PostgreSQL coverage. Runs only in the manual `server` suite. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import postgres from "postgres";
import { DenoLineHarness, type DenoLineReply } from "../support/deno-line-harness.js";

const migrationUrl = new URL(
  "../../supabase/migrations/20260928000004_hm_hosted_check.sql", import.meta.url,
);
const catalogUrl = new URL(
  "../../deploy/release-proofs/item-hm/20260928000004-catalog.sql", import.meta.url,
);
const rollbackUrl = new URL(
  "../../deploy/release-proofs/item-hm/20260928000004-rollback.sql", import.meta.url,
);
const commandUrl = new URL("../../supabase/functions/command/index.ts", import.meta.url);
const authUrl = new URL(
  "../../supabase/functions/_shared/hosted-seat-auth.ts", import.meta.url,
);
const readUrl = new URL("../../supabase/functions/read/index.ts", import.meta.url);
const channelSeenUrl = new URL("../../supabase/functions/mcp/channel-seen.ts", import.meta.url);

interface LocalEnvironment {
  API_URL: string;
  ANON_KEY: string;
  DB_URL: string;
  SERVICE_ROLE_KEY: string;
}

interface Fixture {
  owner: string;
  ownerJwt: string;
  workspace: string;
  stream: string;
  grant: string;
  seatA: string;
  seatB: string;
  principalA: string;
  principalB: string;
  handleA: string;
  handleB: string;
}

interface HarnessResult {
  status: number;
  body: Record<string, unknown>;
}

interface PostedSignal {
  id: string;
  createdAt: string;
}

let local: LocalEnvironment;
let sql: postgres.Sql;
let admin: SupabaseClient;
let harnessDir: string;
let harnessPath: string;

let sharedHarness: DenoLineHarness;

const HARNESS_RESULT = "HM_CHECK_RESULT:";
const HARNESS_DONE = "HM_CHECK_DONE:";

/* One process serves the file: it loads the command module once, then answers line-delimited
 * requests (tests/support/deno-line-harness.ts). Every helper below closes over its own
 * request's input, so nothing carries from one request to the next. */
const harnessSource = `
const commandModule = await import(${JSON.stringify(commandUrl.href)});
const authModule = await import(${JSON.stringify(authUrl.href)});
const { db, handleHostedCommand, handleRequest } = commandModule;
const { authenticateHostedSeatCapability } = authModule;

// deno-lint-ignore no-explicit-any
async function handle(input: any) {

async function capability(handle, tool = "check", use = "command") {
  return await db.begin(async (tx) => await authenticateHostedSeatCapability(tx, {
    grantId: input.grant,
    providerGrantId: "provider-" + input.grant,
    handle,
    tool,
    providerStatus: async () => ({ active: true }),
  }, use));
}

function body(handle, ack) {
  return {
    command_id: crypto.randomUUID(),
    client_version: "0.1.0",
    workspace_id: input.workspace,
    stream: { kind: "workspace" },
    command: ack === null
      ? { kind: "open_hosted_mcp_check_batch", seat: handle }
      : { kind: "ack_hosted_mcp_check_batch", seat: handle, ack },
  };
}

async function call(capabilityHandle, requestHandle, ack = null) {
  const cap = await capability(capabilityHandle);
  if (cap === null) return { status: 403, body: { error: "forbidden" } };
  try {
    return await handleHostedCommand(body(requestHandle, ack), cap);
  } catch (error) {
    console.error("hosted check handler threw", error);
    return { status: 599, body: { error: error instanceof Error ? error.message : "threw" } };
  }
}

async function publicCommand(command) {
  const response = await handleRequest(new Request("http://local/functions/v1/command", {
    method: "POST",
    headers: {
      authorization: "Bearer " + input.ownerJwt,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      command_id: crypto.randomUUID(),
      client_version: "0.1.0",
      workspace_id: input.workspace,
      stream: { kind: "workspace" },
      command,
    }),
  }));
  return { status: response.status, body: await response.json() };
}

let result;
if (input.operation === "single") {
  result = await call(input.capabilityHandle, input.requestHandle, input.ack ?? null);
} else if (input.operation === "open-race") {
  result = await Promise.all([
    call(input.capabilityHandle, input.requestHandle),
    call(input.capabilityHandle, input.requestHandle),
  ]);
} else if (input.operation === "ack-open-race") {
  result = await Promise.all([
    call(input.capabilityHandle, input.requestHandle, input.ack),
    call(input.capabilityHandle, input.requestHandle),
  ]);
} else if (input.operation === "expiry-replay") {
  const first = await call(input.capabilityHandle, input.requestHandle);
  await new Promise((resolve) => setTimeout(resolve, input.waitMs));
  const replay = await call(input.capabilityHandle, input.requestHandle);
  result = { first, replay };
} else if (input.operation === "cross-ack-race") {
  result = await Promise.all([
    call(input.handleA, input.handleA, input.ackB),
    call(input.handleB, input.handleB, input.ackA),
  ]);
} else if (input.operation === "post-signals") {
  result = [];
  for (let index = 0; index < input.count; index += 1) {
    result.push(await publicCommand({
      kind: "post_signal",
      signal_kind: "note",
      body: "HM hosted check " + crypto.randomUUID(),
      to_user_id: null,
      to_agent_principal_id: input.mention ? null : input.recipientPrincipal,
      in_reply_to: null,
      about: null,
      until_ms: input.untilMs,
      ...(input.mention ? { mentions: [{ kind: "agent", id: input.recipientPrincipal }] } : {}),
    }));
  }
} else if (input.operation === "public") {
  result = await publicCommand(input.command);
} else if (input.operation === "seat-post") {
  const cap = await capability(input.capabilityHandle, input.tool);
  result = cap === null ? { status: 403, body: { error: "forbidden" } } : await handleHostedCommand({
    command_id: crypto.randomUUID(),
    client_version: "0.1.80",
    workspace_id: input.workspace,
    stream: { kind: "workspace" },
    command: input.command,
  }, cap);
} else if (input.operation === "channel-read") {
  // What mcp/index.ts does for channel_read: the read edge's page, then (unless readOnly) the seen
  // command for the messages that page returned, under a check capability.
  const read = await import(${JSON.stringify(readUrl.href)});
  const seen = await import(${JSON.stringify(channelSeenUrl.href)});
  const reader = await capability(input.capabilityHandle, "channel_read", "read");
  const page = reader === null ? { status: 403, body: { error: "forbidden" } } : await read.handleHostedRead({
    resource: "channel_messages", workspace_id: input.workspace, channel: input.channel ?? "general",
    after_id: null, limit: 50, fit_bytes: 64 * 1024,
  }, reader);
  const messages = Array.isArray(page.body.messages) ? page.body.messages : [];
  const marked = input.readOnly === true ? null : await seen.markChannelReadSeen(messages, input.workspace,
    input.capabilityHandle, () => capability(input.capabilityHandle, "check"), handleHostedCommand);
  result = { status: page.status, body: { ids: messages.map((message) => message.signal_id), marked } };
} else {
  throw new Error("unknown hosted check operation");
}
return result;
}

const encoder = new TextEncoder();
function writeLine(file: { writeSync(bytes: Uint8Array): number }, text: string) {
  let bytes = encoder.encode(text + "\\n");
  while (bytes.length > 0) bytes = bytes.subarray(file.writeSync(bytes));
}

async function serve(line: string) {
  const { id, input } = JSON.parse(line);
  let reply;
  try {
    reply = { ok: true, result: await handle(input) };
  } catch (error) {
    console.error("hosted check request threw", error);
    reply = { ok: false, error: error instanceof Error ? error.stack ?? error.message : String(error) };
  }
  writeLine(Deno.stdout, ${JSON.stringify(HARNESS_RESULT)} + id + ":" + JSON.stringify(reply));
  writeLine(Deno.stderr, ${JSON.stringify(HARNESS_DONE)} + id);
}

const inflight = new Set();
let buffered = "";
for await (const chunk of Deno.stdin.readable.pipeThrough(new TextDecoderStream())) {
  buffered += chunk;
  let newline = buffered.indexOf("\\n");
  while (newline >= 0) {
    const line = buffered.slice(0, newline);
    buffered = buffered.slice(newline + 1);
    newline = buffered.indexOf("\\n");
    if (line.trim() === "") continue;
    const task = serve(line);
    inflight.add(task);
    task.finally(() => inflight.delete(task));
  }
}
await Promise.allSettled([...inflight]);
await db.end({ timeout: 2 });
// The read module keeps a pool of its own; exit rather than wait for it to idle out.
Deno.exit(0);
`;

before(() => {
  const status = JSON.parse(execFileSync("supabase", ["status", "-o", "json"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  })) as Partial<LocalEnvironment>;
  assert.ok(status.API_URL && status.ANON_KEY && status.DB_URL && status.SERVICE_ROLE_KEY);
  local = status as LocalEnvironment;
  const target = new URL(local.DB_URL);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(target.hostname));
  sql = postgres(local.DB_URL, { prepare: false, max: 5 });
  admin = createClient(local.API_URL, local.SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  harnessDir = mkdtempSync(join(tmpdir(), "hm-hosted-check-"));
  harnessPath = join(harnessDir, "hosted-check-harness.ts");
  writeFileSync(harnessPath, harnessSource);
  sharedHarness = newHarness();
});

after(async () => {
  await sharedHarness?.close();
  await sql.end();
  rmSync(harnessDir, { recursive: true, force: true });
});

async function createAuthUser(label: string): Promise<{ id: string; jwt: string }> {
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

async function seedFixture(): Promise<Fixture> {
  const owner = await createAuthUser("hm-check-owner");
  const fixture: Fixture = {
    owner: owner.id, ownerJwt: owner.jwt,
    workspace: randomUUID(), stream: randomUUID(), grant: randomUUID(),
    seatA: randomUUID(), seatB: randomUUID(), principalA: randomUUID(), principalB: randomUUID(),
    handleA: `seat_${randomUUID().replaceAll("-", "").slice(0, 22)}`,
    handleB: `seat_${randomUUID().replaceAll("-", "").slice(0, 22)}`,
  };
  await sql.begin(async (tx) => {
    await tx`INSERT INTO swarm.users (user_id, display_name)
      VALUES (${fixture.owner}::uuid, 'HM check owner')`;
    await tx`INSERT INTO swarm.workspaces (workspace_id, name, created_by)
      VALUES (${fixture.workspace}::uuid, 'HM check', ${fixture.owner}::uuid)`;
    await tx`INSERT INTO swarm.memberships (workspace_id, user_id, role)
      VALUES (${fixture.workspace}::uuid, ${fixture.owner}::uuid, 'owner')`;
    await tx`INSERT INTO swarm.streams (stream_id, workspace_id, kind)
      VALUES (${fixture.stream}::uuid, ${fixture.workspace}::uuid, 'workspace')`;
    for (const [principal, name] of [[fixture.principalA, "HM check A"], [fixture.principalB, "HM check B"]]) {
      await tx`INSERT INTO swarm.agent_principals (
        principal_id, workspace_id, owner_user_id, name, transport, turn_only
      ) VALUES (
        ${principal}::uuid, ${fixture.workspace}::uuid, ${fixture.owner}::uuid,
        ${name}, 'hosted_mcp', true
      )`;
    }
    await tx`INSERT INTO swarm.hosted_mcp_grants (
      grant_id, provider_grant_id, owner_user_id, home_workspace_id, client_id,
      resource, selected_workspace_ids, manifest_digest, interaction_ref,
      state, created_at, activated_at
    ) VALUES (
      ${fixture.grant}::uuid, ${`provider-${fixture.grant}`}, ${fixture.owner}::uuid,
      ${fixture.workspace}::uuid, 'hm-check-client', 'https://mcp.commonswarm.com/mcp',
      ${[fixture.workspace]}::uuid[], ${new Uint8Array(32).fill(9)}, 'hm-check',
      'active', statement_timestamp(), statement_timestamp()
    )`;
    await tx`INSERT INTO swarm.hosted_mcp_grant_workspaces (
      grant_id, workspace_id, owner_user_id, manifest_digest,
      consent_receipt_id, consented_at
    ) VALUES (
      ${fixture.grant}::uuid, ${fixture.workspace}::uuid, ${fixture.owner}::uuid,
      ${new Uint8Array(32).fill(9)}, ${randomUUID()}::uuid, statement_timestamp()
    )`;
    for (const [seat, principal, name, handle] of [
      [fixture.seatA, fixture.principalA, "HM check A", fixture.handleA],
      [fixture.seatB, fixture.principalB, "HM check B", fixture.handleB],
    ]) {
      await tx`INSERT INTO swarm.hosted_mcp_seats (
        seat_id, grant_id, workspace_id, owner_user_id, principal_id, name, created_at
      ) VALUES (
        ${seat}::uuid, ${fixture.grant}::uuid, ${fixture.workspace}::uuid,
        ${fixture.owner}::uuid, ${principal}::uuid, ${name}, statement_timestamp()
      )`;
      await tx`INSERT INTO swarm.hosted_mcp_seat_handles (
        handle, seat_id, grant_id, workspace_id, principal_id, created_at
      ) VALUES (
        ${handle}, ${seat}::uuid, ${fixture.grant}::uuid,
        ${fixture.workspace}::uuid, ${principal}::uuid, statement_timestamp()
      )`;
    }
  });
  return fixture;
}

async function postSignals(
  fixture: Fixture,
  count: number,
  recipientPrincipal = fixture.principalA,
  untilMs = 10 * 60 * 1000,
): Promise<PostedSignal[]> {
  // Keep fixture creation on the production post_signal path. In particular,
  // this lets the command handler establish every signals table invariant.
  const posted = await runHarness<HarnessResult[]>(fixture, {
    operation: "post-signals",
    ownerJwt: fixture.ownerJwt,
    count,
    recipientPrincipal,
    untilMs,
  });
  return posted.map(({ status, body }) => {
    assert.equal(status, 200, JSON.stringify(body));
    const signal = body.signal as { id?: unknown; created_at?: unknown } | undefined;
    assert.ok(signal, JSON.stringify(body));
    assert.equal(typeof signal.id, "string", JSON.stringify(body));
    assert.equal(typeof signal.created_at, "string", JSON.stringify(body));
    return { id: signal.id as string, createdAt: signal.created_at as string };
  });
}

async function postSignal(
  fixture: Fixture,
  recipientPrincipal = fixture.principalA,
  untilMs = 10 * 60 * 1000,
): Promise<PostedSignal> {
  const [posted] = await postSignals(fixture, 1, recipientPrincipal, untilMs);
  assert.ok(posted);
  return posted;
}

function newHarness(extraEnv: Record<string, string> = {}): DenoLineHarness {
  return new DenoLineHarness([
    "run", "--no-lock", "--config", "supabase/functions/command/deno.json",
    "--allow-env", "--allow-net", "--allow-read", harnessPath,
  ], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? "",
      ...(process.env.DENO_DIR ? { DENO_DIR: process.env.DENO_DIR } : {}),
      SWARM_ENV: "test", SWARM_DATABASE_URL: local.DB_URL,
      SUPABASE_DB_URL: local.DB_URL, SUPABASE_URL: local.API_URL,
      SUPABASE_ANON_KEY: local.ANON_KEY,
      // Mentions on: no fixture here has a workspace lead, so only posts that send mentions change.
      SWARM_CHAT_MENTIONS: "1",
      ...extraEnv,
    },
    timeoutMs: 90_000,
    resultPrefix: HARNESS_RESULT,
    donePrefix: HARNESS_DONE,
  });
}

/**
 * "shared" answers from the file's one long-lived harness. "fresh" starts a new process for this
 * call alone, for a test about a worker restart. "rollback" is a fresh process with the rollback
 * hook, which the command module reads from its environment once, at load.
 */
type HarnessProcess = "shared" | "fresh" | "rollback";

async function runHarness<T>(
  fixture: Fixture,
  input: Record<string, unknown>,
  mode: HarnessProcess = "shared",
): Promise<T> {
  const request = {
    grant: fixture.grant, workspace: fixture.workspace,
    capabilityHandle: fixture.handleA, requestHandle: fixture.handleA,
    ...input,
  };
  let reply: DenoLineReply<T>;
  if (mode === "shared") {
    reply = await sharedHarness.request<T>(request);
  } else {
    const oneShot = newHarness(mode === "rollback" ? { SWARM_CMD_TEST_ROLLBACK_BEFORE_STEP: "15" } : {});
    try {
      reply = await oneShot.request<T>(request);
    } finally {
      await oneShot.close();
    }
  }
  const parsed = reply.result;
  const containsNon2xx = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(containsNon2xx);
    if (value === null || typeof value !== "object") return false;
    const record = value as Record<string, unknown>;
    return (typeof record.status === "number" &&
      (record.status < 200 || record.status >= 300)) ||
      Object.values(record).some(containsNon2xx);
  };
  if (containsNon2xx(parsed)) {
    process.stderr.write(
      `hosted check harness returned a non-2xx response; subprocess stderr follows:\n${
        reply.stderr || "(empty)\n"
      }`,
    );
  }
  return parsed;
}

test("lane-3 catalog is false before migration, true after, and denies clients/read role", async () => {
  const [catalog, rollback, migration] = await Promise.all([
    readFile(catalogUrl, "utf8"), readFile(rollbackUrl, "utf8"), readFile(migrationUrl, "utf8"),
  ]);
  const query = catalog.replace(/\\gset\s*$/u, "");
  await sql.begin(async (tx) => {
    assert.equal((await tx.unsafe<{ catalog_ok: boolean }[]>(query))[0]?.catalog_ok, true,
      "positive control: applied catalog");
    await tx.unsafe(rollback);
    assert.equal((await tx.unsafe<{ catalog_ok: boolean }[]>(query))[0]?.catalog_ok, false,
      "pre-migration catalog must return false without error");
    await tx.unsafe(migration);
    assert.equal((await tx.unsafe<{ catalog_ok: boolean }[]>(query))[0]?.catalog_ok, true);
    throw new Error("ROLLBACK_HM_CHECK_CATALOG_DRILL");
  }).catch((error) => {
    if (!(error instanceof Error) || error.message !== "ROLLBACK_HM_CHECK_CATALOG_DRILL") throw error;
  });
});

test("lane-3 visibility function permits signals-view drop and recreation", async () => {
  await sql.begin(async (tx) => {
    const [before] = await tx<{ definition: string; function_exists: boolean }[]>`
      SELECT pg_get_viewdef('swarm_read.signals'::regclass, true) AS definition,
        to_regprocedure(
          'swarm.hosted_mcp_check_visible_signals(uuid,uuid,uuid[])'
        ) IS NOT NULL AS function_exists
    `;
    assert.ok(before?.definition);
    assert.equal(before.function_exists, true,
      "positive control: lane-3 visibility function is applied");

    await tx.unsafe("DROP VIEW swarm_read.signals");
    const [dropped] = await tx<{ view_oid: string | null }[]>`
      SELECT to_regclass('swarm_read.signals')::text AS view_oid
    `;
    assert.equal(dropped?.view_oid, null, "positive control: the view was dropped");

    const definition = before.definition.replace(/;\s*$/u, "");
    await tx.unsafe(
      `CREATE VIEW swarm_read.signals WITH (security_barrier = true) AS ${definition}`,
    );
    await tx.unsafe("ALTER VIEW swarm_read.signals OWNER TO swarm_admin");
    await tx.unsafe("GRANT SELECT ON swarm_read.signals TO authenticated, swarm_read");
    await tx.unsafe("REVOKE ALL ON swarm_read.signals FROM anon");

    const [smoke] = await tx<{ view_oid: string | null; visible_rows: string }[]>`
      SELECT to_regclass('swarm_read.signals')::text AS view_oid,
        (SELECT count(*)::text
         FROM swarm.hosted_mcp_check_visible_signals(
           '00000000-0000-0000-0000-000000000000'::uuid,
           '00000000-0000-0000-0000-000000000000'::uuid,
           ARRAY[]::uuid[]
         )) AS visible_rows
    `;
    assert.deepEqual(smoke, { view_oid: "swarm_read.signals", visible_rows: "0" },
      "recreated view remains usable through the lane-3 visibility function");
    throw new Error("ROLLBACK_HM_SIGNALS_VIEW_RECREATION");
  }).catch((error) => {
    if (!(error instanceof Error) || error.message !== "ROLLBACK_HM_SIGNALS_VIEW_RECREATION") {
      throw error;
    }
  });

  const [restored] = await sql<{ view_oid: string | null }[]>`
    SELECT to_regclass('swarm_read.signals')::text AS view_oid
  `;
  assert.equal(restored?.view_oid, "swarm_read.signals",
    "positive control: recreation drill rolled back to the applied view");
});

test("concurrent opens converge and a worker restart replays the stored ids", async () => {
  const fixture = await seedFixture();
  const signal = await postSignal(fixture);
  const raced = await runHarness<HarnessResult[]>(fixture, { operation: "open-race" });
  assert.deepEqual(raced.map((entry) => entry.status), [200, 200]);
  assert.equal(raced[0]?.body.batch_id, raced[1]?.body.batch_id,
    "positive control: both opens return one active batch");
  assert.equal((raced[0]?.body.signals as unknown[])?.length, 1);
  // A new process stands in for the restarted worker: nothing carries over but the database.
  const restarted = await runHarness<HarnessResult>(fixture, { operation: "single" }, "fresh");
  assert.equal(restarted.body.batch_id, raced[0]?.body.batch_id);
  assert.equal((restarted.body.signals as Array<{ id: string }>)[0]?.id, signal.id);
  const [count] = await sql<{ n: string }[]>`SELECT count(*)::text AS n
    FROM swarm.hosted_mcp_check_batches WHERE seat_id = ${fixture.seatA}::uuid`;
  assert.equal(Number(count?.n), 1);
});

test("expiry between calls does not change active-batch replay", { timeout: 120_000 }, async () => {
  const fixture = await seedFixture();
  await postSignal(fixture, fixture.principalA, 3_000);
  const result = await runHarness<{ first: HarnessResult; replay: HarnessResult }>(fixture, {
    operation: "expiry-replay", waitMs: 3_500,
  });
  assert.equal(result.first.status, 200, "positive control: unexpired signal opened");
  assert.equal((result.first.body.signals as unknown[]).length, 1);
  assert.equal(result.replay.body.batch_id, result.first.body.batch_id);
  assert.deepEqual(result.replay.body.signals, result.first.body.signals);
});

test("ACK vs open and repeated ACK never close a newer batch", async () => {
  const fixture = await seedFixture();
  await postSignal(fixture);
  const first = await runHarness<HarnessResult>(fixture, { operation: "single" });
  assert.equal(first.status, 200, "positive control: first batch opened");
  const context = first.body.context as { account: { user_id: string }; workspace: { workspace_id: string } };
  assert.equal(context.account.user_id, fixture.owner);
  assert.equal(context.workspace.workspace_id, fixture.workspace);
  await postSignal(fixture);
  const raced = await runHarness<HarnessResult[]>(fixture, {
    operation: "ack-open-race", ack: first.body.batch_id,
  });
  assert.ok(raced.every((entry) => entry.status === 200));
  for (const entry of raced) assert.deepEqual(entry.body.context, context, "ACK/open both retain context");
  const [active] = await sql<{ batch_id: string }[]>`SELECT batch_id
    FROM swarm.hosted_mcp_check_batches
    WHERE seat_id = ${fixture.seatA}::uuid AND acknowledged_at IS NULL`;
  assert.ok(active);
  const repeated = await runHarness<HarnessResult>(fixture, {
    operation: "single", ack: first.body.batch_id,
  });
  assert.equal(repeated.status, 200);
  assert.deepEqual(repeated.body.context, context, "repeated ACK retains context without changing batch semantics");
  assert.equal(repeated.body.batch_id, active.batch_id);
  const [stillActive] = await sql<{ acknowledged_at: Date | null }[]>`
    SELECT acknowledged_at FROM swarm.hosted_mcp_check_batches
    WHERE batch_id = ${active.batch_id}::uuid`;
  assert.equal(stillActive?.acknowledged_at, null);
});

test("cross-seat wrong-batch ACKs are refused without locking each other", async () => {
  const fixture = await seedFixture();
  await postSignal(fixture, fixture.principalA);
  await postSignal(fixture, fixture.principalB);
  const openedA = await runHarness<HarnessResult>(fixture, { operation: "single" });
  const openedB = await runHarness<HarnessResult>(fixture, {
    operation: "single", capabilityHandle: fixture.handleB, requestHandle: fixture.handleB,
  });
  assert.equal(openedA.status, 200, "positive control: seat A has an active batch");
  assert.equal(openedB.status, 200, "positive control: seat B has an active batch");

  const crossed = await runHarness<HarnessResult[]>(fixture, {
    operation: "cross-ack-race",
    handleA: fixture.handleA,
    handleB: fixture.handleB,
    ackA: openedA.body.batch_id,
    ackB: openedB.body.batch_id,
  });
  assert.deepEqual(crossed.map((entry) => entry.status), [403, 403]);
  assert.deepEqual(crossed.map((entry) => entry.body.error), [
    "hosted_check_batch_forbidden", "hosted_check_batch_forbidden",
  ]);
  const [active] = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n
    FROM swarm.hosted_mcp_check_batches
    WHERE seat_id = ANY(${[fixture.seatA, fixture.seatB]}::uuid[])
      AND acknowledged_at IS NULL
  `;
  assert.equal(active?.n, "2");
});

test("unrelated ACK does not create durable cursor state", async () => {
  const fixture = await seedFixture();
  const refused = await runHarness<HarnessResult>(fixture, {
    operation: "single", ack: randomUUID(),
  });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error, "hosted_check_batch_forbidden");
  const [before] = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM swarm.hosted_mcp_check_cursors
    WHERE seat_id = ${fixture.seatA}::uuid
  `;
  assert.equal(before?.n, "0");

  await postSignal(fixture);
  const opened = await runHarness<HarnessResult>(fixture, { operation: "single" });
  assert.equal(opened.status, 200, "positive control: a valid open persists normally");
  const [after] = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM swarm.hosted_mcp_check_cursors
    WHERE seat_id = ${fixture.seatA}::uuid
  `;
  assert.equal(after?.n, "1");
});

test("ACK accepts upper-case UUID spelling and advances the batch", async () => {
  const fixture = await seedFixture();
  await postSignal(fixture);
  const opened = await runHarness<HarnessResult>(fixture, { operation: "single" });
  assert.equal(opened.status, 200, "positive control: first batch opened");
  const acknowledged = await runHarness<HarnessResult>(fixture, {
    operation: "single", ack: String(opened.body.batch_id).toUpperCase(),
  });
  assert.equal(acknowledged.status, 200);
  assert.equal(acknowledged.body.acknowledged_batch_id, opened.body.batch_id);
  const [stored] = await sql<{ acknowledged_at: Date | null }[]>`
    SELECT acknowledged_at FROM swarm.hosted_mcp_check_batches
    WHERE batch_id = ${opened.body.batch_id as string}::uuid
  `;
  assert.ok(stored?.acknowledged_at instanceof Date);
});

test("a public message that mentions the seat's agent arrives in its check, and one that mentions another agent does not", async () => {
  const fixture = await seedFixture();
  const post = async (recipientPrincipal: string) => (await runHarness<HarnessResult[]>(fixture, {
    operation: "post-signals", ownerJwt: fixture.ownerJwt, count: 1, recipientPrincipal,
    untilMs: 10 * 60 * 1000, mention: true,
  }))[0]!;
  const mine = await post(fixture.principalA);
  const theirs = await post(fixture.principalB);
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  assert.equal(theirs.status, 200, JSON.stringify(theirs.body));
  const mineId = (mine.body.signal as { id: string; to_agent: string | null }).id;
  assert.equal((mine.body.signal as { to_agent: string | null }).to_agent, null, "the mention is not an address");
  // The check opens a batch, which the batch guard has to accept for a mention-only signal.
  const opened = await runHarness<HarnessResult>(fixture, { operation: "single" });
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  assert.deepEqual((opened.body.signals as Array<{ id: string }>).map((signal) => signal.id), [mineId]);
});

test("a check marks each ask and note it returns with one 👀 by the seat's agent, once, and its result is unchanged", async () => {
  const fixture = await seedFixture();
  const unaddressed = { to_user_id: null, to_agent_principal_id: null, in_reply_to: null, about: null };
  const asOwner = async (command: Record<string, unknown>) =>
    await runHarness<HarnessResult>(fixture, { operation: "public", ownerJwt: fixture.ownerJwt, command });
  const asSeat = async (tool: string, command: Record<string, unknown>) =>
    await runHarness<HarnessResult>(fixture, { operation: "seat-post", tool, command });
  const idOf = (result: HarnessResult): string => {
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return String((result.body.signal as { id: string }).id);
  };
  const ask = idOf(await asOwner({ kind: "post_signal", signal_kind: "ask", body: `seen ask ${randomUUID()}`,
    ...unaddressed, to_agent_principal_id: fixture.principalA }));
  const mentioned = idOf(await asOwner({ kind: "post_signal", signal_kind: "note", body: `seen mention ${randomUUID()}`,
    ...unaddressed, mentions: [{ kind: "agent", id: fixture.principalA }] }));
  /* The seat's own public note, with a person's reaction on it. The read edge shows that reaction to
   * a local agent as a reaction note; a hosted check never returns one, so nothing is marked. */
  const own = idOf(await asSeat("note", { kind: "post_signal", signal_kind: "note", body: `own ${randomUUID()}`, ...unaddressed }));
  const ownerReaction = await asOwner({ kind: "add_reaction", signal_id: own, emoji: "\u{1F44D}" });
  assert.equal(ownerReaction.status, 200, JSON.stringify(ownerReaction.body));
  // Where the server takes these at all, they stay unmarked.
  const working = await asOwner({ kind: "post_signal", signal_kind: "working-on", body: `working ${randomUUID()}`,
    ...unaddressed, mentions: [{ kind: "agent", id: fixture.principalA }] });
  const selfAsk = await asSeat("ask", { kind: "post_signal", signal_kind: "ask", body: `self ${randomUUID()}`,
    ...unaddressed, to: [{ kind: "agent", id: fixture.principalA }] });
  const selfMention = await asSeat("note", { kind: "post_signal", signal_kind: "note", body: `self mention ${randomUUID()}`,
    ...unaddressed, mentions: [{ kind: "agent", id: fixture.principalA }] });
  const optional = [working, selfAsk, selfMention].filter((result) => result.status === 200).map(idOf);

  // Plain rows: the driver's Result array is its own class, which deepEqual tells apart from [].
  const marks = async () => (await sql<{ signal_id: string; emoji: string; source: string }[]>`
    SELECT signal_id::text AS signal_id, emoji, source FROM swarm.signal_reactions
    WHERE workspace_id = ${fixture.workspace}::uuid
      AND actor_agent_principal_id = ${fixture.principalA}::uuid
    ORDER BY signal_id`).map((row) => ({ ...row }));
  assert.deepEqual(await marks(), [], "nothing is marked before a check");

  const first = await runHarness<HarnessResult>(fixture, { operation: "single" });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual(Object.keys(first.body).sort(), ["acknowledged_batch_id", "batch_id", "context", "cursor", "signals"],
    "the check's result has no new field");
  const returned = (first.body.signals as Array<{ id: string }>).map((signal) => signal.id);
  assert.ok(returned.includes(ask) && returned.includes(mentioned), JSON.stringify(returned));
  assert.ok(!returned.includes(own), "the seat's own public note is not in its check");
  // A working-on and the seat's own messages get no mark whether or not the check returned them
  // (the marks below are exactly the ask and the mentioning note).
  console.log(`optional rows posted ${optional.length}, returned ${optional.filter((id) => returned.includes(id)).length}`);
  const expected = [ask, mentioned].sort().map((signal_id) => ({ signal_id, emoji: "\u{1F440}", source: "ack" }));
  assert.deepEqual(await marks(), expected, "one 👀 by the seat's agent on the addressed ask and the mentioning note only");
  const [onOwn] = await sql<{ count: string }[]>`
    SELECT count(*)::text AS count FROM swarm.signal_reactions WHERE signal_id = ${own}::uuid`;
  assert.equal(onOwn!.count, "1", "only the person's reaction is on the seat's own note");

  // Opening again replays the same batch; acknowledging it opens an empty one. Neither adds a mark.
  const replay = await runHarness<HarnessResult>(fixture, { operation: "single" });
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body.batch_id, first.body.batch_id);
  assert.deepEqual(replay.body.signals, first.body.signals, "a replay returns the same rows");
  assert.deepEqual(await marks(), expected, "a second check does not duplicate a mark");
  const acked = await runHarness<HarnessResult>(fixture, { operation: "single", ack: first.body.batch_id });
  assert.equal(acked.status, 200, JSON.stringify(acked.body));
  assert.equal(acked.body.acknowledged_batch_id, first.body.batch_id, "the acknowledgement still lands");
  assert.deepEqual(acked.body.signals, []);
  assert.deepEqual(await marks(), expected);
});

/* Hosted seats are turn-only, with no listener lease: what a seat's turn shows it, or acts on,
 * moves its own untouched delivery to observed, which the sender's "Seen" reads. */

async function deliveryOf(signalId: string, principal: string) {
  const [row] = await sql<{ ack_outcome: string | null; ack_via: string | null; acked_at: Date | null; lease_id: string | null }[]>`
    SELECT ack_outcome, ack_via, acked_at, lease_id FROM swarm.signal_deliveries
    WHERE signal_id = ${signalId}::uuid AND recipient_agent_principal_id = ${principal}::uuid`;
  assert.ok(row, `a delivery row exists for ${signalId}`);
  return { ...row };
}

/** swarm_read.message_status as the sending person reads it in the web app. */
async function seenFor(fixture: Fixture, signalId: string, principal: string): Promise<unknown> {
  return await sql.begin(async (tx) => {
    await tx`SELECT set_config('role', 'authenticated', true),
      set_config('request.jwt.claims', ${JSON.stringify({ sub: fixture.owner, role: "authenticated" })}, true)`;
    const [row] = await tx<{ status: { statuses: Array<Record<string, unknown>> } | null }[]>`
      SELECT swarm_read.message_status(${fixture.workspace}::uuid, ${[signalId]}::uuid[]) AS status`;
    return row?.status?.statuses.find((entry) => entry.agent_principal_id === principal)?.seen;
  });
}

async function seenMarksBy(fixture: Fixture, principal: string): Promise<Array<{ signal_id: string; source: string }>> {
  return (await sql<{ signal_id: string; source: string }[]>`
    SELECT signal_id::text AS signal_id, source FROM swarm.signal_reactions
    WHERE workspace_id = ${fixture.workspace}::uuid AND actor_agent_principal_id = ${principal}::uuid
      AND emoji = ${"\u{1F440}"}
    ORDER BY signal_id`).map((row) => ({ ...row }));
}

async function receiptsBy(fixture: Fixture, principal: string): Promise<Array<{ signal_id: string; first_seen_at: string }>> {
  return (await sql<{ signal_id: string; first_seen_at: string }[]>`
    SELECT signal_id::text AS signal_id, first_seen_at::text AS first_seen_at FROM swarm.signal_agent_receipts
    WHERE workspace_id = ${fixture.workspace}::uuid AND principal_id = ${principal}::uuid
    ORDER BY signal_id`).map((row) => ({ ...row }));
}

const unaddressedPost = { kind: "post_signal", to_user_id: null, to_agent_principal_id: null, in_reply_to: null, about: null };
function signalIdOf(result: HarnessResult): string {
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return String((result.body.signal as { id: string }).id);
}

test("a hosted check leaves the seat's own delivery observed, so the sender reads Seen, and a replay changes nothing", async () => {
  const fixture = await seedFixture();
  const ask = signalIdOf(await runHarness<HarnessResult>(fixture, { operation: "public", ownerJwt: fixture.ownerJwt, command: {
    ...unaddressedPost, signal_kind: "ask", body: `seen ask ${randomUUID()}`, to_agent_principal_id: fixture.principalA } }));
  const mention = signalIdOf(await runHarness<HarnessResult>(fixture, { operation: "public", ownerJwt: fixture.ownerJwt, command: {
    ...unaddressedPost, signal_kind: "note", body: `seen mention ${randomUUID()}`, mentions: [{ kind: "agent", id: fixture.principalA }] } }));
  // Positive control: before any turn the rows are untouched and the sender reads not seen.
  assert.deepEqual(await deliveryOf(ask, fixture.principalA), { ack_outcome: null, ack_via: null, acked_at: null, lease_id: null });
  assert.equal(await seenFor(fixture, ask, fixture.principalA), false);

  const first = await runHarness<HarnessResult>(fixture, { operation: "single" });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual(Object.keys(first.body).sort(), ["acknowledged_batch_id", "batch_id", "context", "cursor", "signals"]);
  for (const id of [ask, mention]) {
    const row = await deliveryOf(id, fixture.principalA);
    assert.equal(row.ack_outcome, "observed", id);
    assert.equal(row.ack_via, "unclaimed", id);
    assert.equal(row.lease_id, null, "no lease is taken");
  }
  assert.equal(await seenFor(fixture, ask, fixture.principalA), true, "message_status reads seen");
  assert.equal(await seenFor(fixture, mention, fixture.principalA), true);
  const ackedAt = (await deliveryOf(ask, fixture.principalA)).acked_at?.toISOString();

  // Replaying the open batch, then acknowledging it, neither fails nor writes the rows again.
  const replay = await runHarness<HarnessResult>(fixture, { operation: "single" });
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body.batch_id, first.body.batch_id);
  const acked = await runHarness<HarnessResult>(fixture, { operation: "single", ack: first.body.batch_id });
  assert.equal(acked.status, 200, JSON.stringify(acked.body));
  assert.equal((await deliveryOf(ask, fixture.principalA)).acked_at?.toISOString(), ackedAt, "observed once");
});

test("a hosted private reply and a hosted react observe the seat's own delivery of that message", async () => {
  const fixture = await seedFixture();
  const asOwner = async (body: string) => signalIdOf(await runHarness<HarnessResult>(fixture, { operation: "public", ownerJwt: fixture.ownerJwt,
    command: { ...unaddressedPost, signal_kind: "ask", body, to_agent_principal_id: fixture.principalA } }));
  const answered = await asOwner(`reply to me ${randomUUID()}`);
  const reacted = await asOwner(`react to me ${randomUUID()}`);
  const untouched = await asOwner(`leave me ${randomUUID()}`);

  const reply = await runHarness<HarnessResult>(fixture, { operation: "seat-post", tool: "reply", command: {
    ...unaddressedPost, signal_kind: "note", body: `on it ${randomUUID()}`, in_reply_to: answered } });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  const react = await runHarness<HarnessResult>(fixture, { operation: "seat-post", tool: "react", command: {
    kind: "add_reaction", signal_id: reacted, emoji: "\u{1F44D}" } });
  assert.equal(react.status, 200, JSON.stringify(react.body));

  assert.equal((await deliveryOf(answered, fixture.principalA)).ack_outcome, "observed", "the reply observes");
  assert.equal((await deliveryOf(reacted, fixture.principalA)).ack_outcome, "observed", "the reaction observes");
  assert.equal(await seenFor(fixture, answered, fixture.principalA), true);
  assert.equal(await seenFor(fixture, reacted, fixture.principalA), true);
  assert.equal((await deliveryOf(untouched, fixture.principalA)).ack_outcome, null, "a message the seat did not act on stays");
});

test("a hosted channel_read marks the mention it returns seen and counts the seat on channel-wide posts", async () => {
  const fixture = await seedFixture();
  const asOwner = async (command: Record<string, unknown>) => signalIdOf(await runHarness<HarnessResult>(fixture,
    { operation: "public", ownerJwt: fixture.ownerJwt, command: { ...unaddressedPost, signal_kind: "note", ...command } }));
  const mention = await asOwner({ body: `for A ${randomUUID()}`, mentions: [{ kind: "agent", id: fixture.principalA }] });
  const forB = await asOwner({ body: `for B ${randomUUID()}`, mentions: [{ kind: "agent", id: fixture.principalB }] });
  const plain = await asOwner({ body: `everyone ${randomUUID()}` });
  const own = signalIdOf(await runHarness<HarnessResult>(fixture, { operation: "seat-post", tool: "note",
    command: { ...unaddressedPost, signal_kind: "note", body: `A's own ${randomUUID()}` } }));

  // Control: the read edge alone, which is all a local agent's channel_read uses, records nothing.
  const readOnly = await runHarness<HarnessResult>(fixture, { operation: "channel-read", readOnly: true });
  assert.equal(readOnly.status, 200, JSON.stringify(readOnly.body));
  for (const id of [mention, forB, plain, own]) assert.ok((readOnly.body.ids as string[]).includes(id), id);
  assert.equal((await deliveryOf(mention, fixture.principalA)).ack_outcome, null);
  assert.deepEqual(await seenMarksBy(fixture, fixture.principalA), []);
  assert.deepEqual(await receiptsBy(fixture, fixture.principalA), []);

  const read = await runHarness<HarnessResult>(fixture, { operation: "channel-read" });
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.equal(read.body.marked, true, JSON.stringify(read.body));
  assert.equal((await deliveryOf(mention, fixture.principalA)).ack_outcome, "observed", "the mention reads as seen");
  assert.equal(await seenFor(fixture, mention, fixture.principalA), true);
  assert.deepEqual(await seenMarksBy(fixture, fixture.principalA), [{ signal_id: mention, source: "ack" }],
    "one 👀, on the mention only");
  assert.equal((await deliveryOf(forB, fixture.principalB)).ack_outcome, null, "another seat's delivery is untouched");
  const receipts = await receiptsBy(fixture, fixture.principalA);
  assert.deepEqual(receipts.map((row) => row.signal_id).sort(), [mention, forB, plain, own].sort(),
    "every channel-wide post the page returned counts the seat (its own too: M counts the author)");

  // Reading the same page again writes nothing new.
  const again = await runHarness<HarnessResult>(fixture, { operation: "channel-read" });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.deepEqual(await seenMarksBy(fixture, fixture.principalA), [{ signal_id: mention, source: "ack" }]);
  assert.deepEqual(await receiptsBy(fixture, fixture.principalA), receipts);
});

test("only a check capability carries the channel_read seen command, and only for its own seat", async () => {
  const fixture = await seedFixture();
  const mention = signalIdOf(await runHarness<HarnessResult>(fixture, { operation: "public", ownerJwt: fixture.ownerJwt, command: {
    ...unaddressedPost, signal_kind: "note", body: `for A ${randomUUID()}`, mentions: [{ kind: "agent", id: fixture.principalA }] } }));
  const command = { kind: "mark_hosted_channel_read_seen", seat: fixture.handleA, signal_ids: [mention] };
  const asNote = await runHarness<HarnessResult>(fixture, { operation: "seat-post", tool: "note", command });
  assert.equal(asNote.status, 403, JSON.stringify(asNote.body));
  const otherSeat = await runHarness<HarnessResult>(fixture, { operation: "seat-post", tool: "check", capabilityHandle: fixture.handleB, command });
  assert.equal(otherSeat.status, 403, JSON.stringify(otherSeat.body));
  const person = await runHarness<HarnessResult>(fixture, { operation: "public", ownerJwt: fixture.ownerJwt, command });
  assert.deepEqual({ status: person.status, body: person.body }, { status: 403, body: { error: "forbidden" } },
    "public HTTP refuses the hosted-only kind before authentication");
  assert.equal((await deliveryOf(mention, fixture.principalA)).ack_outcome, null);
  assert.deepEqual(await seenMarksBy(fixture, fixture.principalA), []);
  // Positive control: the seat's own check capability is accepted.
  const own = await runHarness<HarnessResult>(fixture, { operation: "seat-post", tool: "check", command });
  assert.equal(own.status, 200, JSON.stringify(own.body));
  assert.equal((await deliveryOf(mention, fixture.principalA)).ack_outcome, "observed");
});

test("batch guard rejects signals not addressed to the seat principal", async () => {
  const fixture = await seedFixture();
  const ownSignal = await postSignal(fixture);
  const foreignSignal = await postSignal(fixture, fixture.principalB);
  await sql`INSERT INTO swarm.hosted_mcp_check_cursors (
    seat_id, grant_id, workspace_id, principal_id
  ) VALUES (
    ${fixture.seatA}::uuid, ${fixture.grant}::uuid,
    ${fixture.workspace}::uuid, ${fixture.principalA}::uuid
  )`;
  await assert.rejects(sql`INSERT INTO swarm.hosted_mcp_check_batches (
    batch_id, seat_id, grant_id, workspace_id, principal_id,
    signal_ids, terminal_created_at, terminal_signal_id
  ) VALUES (
    ${randomUUID()}::uuid, ${fixture.seatA}::uuid, ${fixture.grant}::uuid,
    ${fixture.workspace}::uuid, ${fixture.principalA}::uuid,
    ${[foreignSignal.id]}::uuid[], ${foreignSignal.createdAt}::timestamptz,
    ${foreignSignal.id}::uuid
  )`, /SWARM_HOSTED_CHECK_BATCH_INVALID/u);

  const batchId = randomUUID();
  await sql`INSERT INTO swarm.hosted_mcp_check_batches (
    batch_id, seat_id, grant_id, workspace_id, principal_id,
    signal_ids, terminal_created_at, terminal_signal_id
  ) VALUES (
    ${batchId}::uuid, ${fixture.seatA}::uuid, ${fixture.grant}::uuid,
    ${fixture.workspace}::uuid, ${fixture.principalA}::uuid,
    ${[ownSignal.id]}::uuid[], ${ownSignal.createdAt}::timestamptz,
    ${ownSignal.id}::uuid
  )`;
  const [positive] = await sql<{ batch_id: string }[]>`
    SELECT batch_id FROM swarm.hosted_mcp_check_batches
    WHERE batch_id = ${batchId}::uuid
  `;
  assert.equal(positive?.batch_id, batchId,
    "positive control: a signal addressed to the seat principal is accepted");
});

test("same-millisecond UUID ties page exactly without skipping or repeating", async () => {
  const fixture = await seedFixture();
  const ids = (await postSignals(fixture, 51)).map((signal) => signal.id);
  const [tie] = await sql.begin(async (tx) => {
    // The only CHECK constraints involving either changed column are
    // signals_check (`until > created_at`) and signals_check1
    // (`until <= created_at + interval '30 days'`). Change both timestamps
    // together; the command path established every other row invariant.
    await tx`ALTER TABLE swarm.signals DISABLE TRIGGER signals_append_only`;
    const rows = await tx<{ cursor_created_at: Date; updated: string }[]>`
      WITH stamp AS (
        SELECT date_trunc('milliseconds', statement_timestamp())
          - interval '1 second' + interval '999 microseconds' AS exact_created_at
      ), updated AS (
        UPDATE swarm.signals AS signal
        SET created_at = stamp.exact_created_at,
            until = stamp.exact_created_at + interval '10 minutes'
        FROM stamp
        WHERE signal.workspace_id = ${fixture.workspace}::uuid
          AND signal.id = ANY(${ids}::uuid[])
        RETURNING signal.created_at
      )
      SELECT date_trunc('milliseconds', min(created_at)) AS cursor_created_at,
        count(*)::text AS updated
      FROM updated
    `;
    await tx`ALTER TABLE swarm.signals ENABLE TRIGGER signals_append_only`;
    return rows;
  });
  assert.equal(tie?.updated, "51",
    "positive control: every posted signal received the tie timestamp");
  assert.ok(tie?.cursor_created_at instanceof Date);
  const first = await runHarness<HarnessResult>(fixture, { operation: "single" });
  const firstIds = (first.body.signals as Array<{ id: string }>).map((row) => row.id);
  assert.deepEqual(firstIds, [...ids].sort().slice(0, 50),
    "positive control: first page follows truncated-time/UUID order");
  const second = await runHarness<HarnessResult>(fixture, {
    operation: "single", ack: first.body.batch_id,
  });
  assert.deepEqual((second.body.signals as Array<{ id: string }>).map((row) => row.id),
    [...ids].sort().slice(50));
  assert.equal((second.body.cursor as { created_at: string }).created_at,
    tie.cursor_created_at.toISOString());
});

test("cross-seat calls and revoked membership are refused with positive controls", async () => {
  const fixture = await seedFixture();
  await postSignal(fixture);
  const own = await runHarness<HarnessResult>(fixture, { operation: "single" });
  assert.equal(own.status, 200, "positive control: matching seat can check");
  const crossed = await runHarness<HarnessResult>(fixture, {
    operation: "single", capabilityHandle: fixture.handleB, requestHandle: fixture.handleA,
  });
  assert.equal(crossed.status, 403);
  await sql`UPDATE swarm.memberships SET revoked_at = statement_timestamp()
    WHERE workspace_id = ${fixture.workspace}::uuid AND user_id = ${fixture.owner}::uuid`;
  const revoked = await runHarness<HarnessResult>(fixture, {
    operation: "single", capabilityHandle: fixture.handleA, requestHandle: fixture.handleA,
  });
  assert.equal(revoked.status, 403);
});

test("rollback injection leaves neither cursor nor batch", async () => {
  const fixture = await seedFixture();
  await postSignal(fixture);
  const rolledBack = await runHarness<HarnessResult>(fixture, { operation: "single" }, "rollback");
  assert.equal(rolledBack.status, 599);
  const [counts] = await sql<{ cursors: string; batches: string }[]>`
    SELECT
      (SELECT count(*)::text FROM swarm.hosted_mcp_check_cursors
       WHERE seat_id = ${fixture.seatA}::uuid) AS cursors,
      (SELECT count(*)::text FROM swarm.hosted_mcp_check_batches
       WHERE seat_id = ${fixture.seatA}::uuid) AS batches
  `;
  assert.deepEqual(counts, { cursors: "0", batches: "0" });
  const positive = await runHarness<HarnessResult>(fixture, { operation: "single" });
  assert.equal(positive.status, 200, "positive control: normal transaction persists");
});
