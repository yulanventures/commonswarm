/** HM lane-3 PostgreSQL coverage. Runs only in the manual `server` suite. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import postgres from "postgres";

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

const harnessSource = `
const input = JSON.parse(await new Response(Deno.stdin.readable).text());
const commandModule = await import(${JSON.stringify(commandUrl.href)});
const authModule = await import(${JSON.stringify(authUrl.href)});
const { db, handleHostedCommand, handleRequest } = commandModule;
const { authenticateHostedSeatCapability } = authModule;

async function capability(handle) {
  return await db.begin(async (tx) => await authenticateHostedSeatCapability(tx, {
    grantId: input.grant,
    providerGrantId: "provider-" + input.grant,
    handle,
    tool: "check",
    providerStatus: async () => ({ active: true }),
  }, "command"));
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
      to_agent_principal_id: input.recipientPrincipal,
      in_reply_to: null,
      about: null,
      until_ms: input.untilMs,
    }));
  }
} else {
  throw new Error("unknown hosted check operation");
}
console.log("HM_CHECK_RESULT:" + JSON.stringify(result));
await db.end({ timeout: 2 });
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
});

after(async () => {
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
  const posted = runHarness<HarnessResult[]>(fixture, {
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

function runHarness<T>(fixture: Fixture, input: Record<string, unknown>, rollback = false): T {
  const result = spawnSync("deno", [
    "run", "--no-lock", "--config", "supabase/functions/command/deno.json",
    "--allow-env", "--allow-net", "--allow-read", harnessPath,
  ], {
    cwd: process.cwd(), encoding: "utf8", input: JSON.stringify({
      grant: fixture.grant, workspace: fixture.workspace,
      capabilityHandle: fixture.handleA, requestHandle: fixture.handleA,
      ...input,
    }),
    env: {
      PATH: process.env.PATH ?? "",
      ...(process.env.DENO_DIR ? { DENO_DIR: process.env.DENO_DIR } : {}),
      SWARM_ENV: "test", SWARM_DATABASE_URL: local.DB_URL,
      SUPABASE_DB_URL: local.DB_URL, SUPABASE_URL: local.API_URL,
      SUPABASE_ANON_KEY: local.ANON_KEY,
      ...(rollback ? { SWARM_CMD_TEST_ROLLBACK_BEFORE_STEP: "15" } : {}),
    },
    timeout: 90_000,
  });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const line = result.stdout.trim().split("\n").reverse().find((entry) =>
    entry.startsWith("HM_CHECK_RESULT:"));
  assert.equal(typeof line, "string", result.stdout);
  const parsed = JSON.parse((line ?? "").slice("HM_CHECK_RESULT:".length)) as T;
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
        result.stderr || "(empty)\n"
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
  const raced = runHarness<HarnessResult[]>(fixture, { operation: "open-race" });
  assert.deepEqual(raced.map((entry) => entry.status), [200, 200]);
  assert.equal(raced[0]?.body.batch_id, raced[1]?.body.batch_id,
    "positive control: both opens return one active batch");
  assert.equal((raced[0]?.body.signals as unknown[])?.length, 1);
  const restarted = runHarness<HarnessResult>(fixture, { operation: "single" });
  assert.equal(restarted.body.batch_id, raced[0]?.body.batch_id);
  assert.equal((restarted.body.signals as Array<{ id: string }>)[0]?.id, signal.id);
  const [count] = await sql<{ n: string }[]>`SELECT count(*)::text AS n
    FROM swarm.hosted_mcp_check_batches WHERE seat_id = ${fixture.seatA}::uuid`;
  assert.equal(Number(count?.n), 1);
});

test("expiry between calls does not change active-batch replay", { timeout: 120_000 }, async () => {
  const fixture = await seedFixture();
  await postSignal(fixture, fixture.principalA, 3_000);
  const result = runHarness<{ first: HarnessResult; replay: HarnessResult }>(fixture, {
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
  const first = runHarness<HarnessResult>(fixture, { operation: "single" });
  assert.equal(first.status, 200, "positive control: first batch opened");
  await postSignal(fixture);
  const raced = runHarness<HarnessResult[]>(fixture, {
    operation: "ack-open-race", ack: first.body.batch_id,
  });
  assert.ok(raced.every((entry) => entry.status === 200));
  const [active] = await sql<{ batch_id: string }[]>`SELECT batch_id
    FROM swarm.hosted_mcp_check_batches
    WHERE seat_id = ${fixture.seatA}::uuid AND acknowledged_at IS NULL`;
  assert.ok(active);
  const repeated = runHarness<HarnessResult>(fixture, {
    operation: "single", ack: first.body.batch_id,
  });
  assert.equal(repeated.status, 200);
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
  const openedA = runHarness<HarnessResult>(fixture, { operation: "single" });
  const openedB = runHarness<HarnessResult>(fixture, {
    operation: "single", capabilityHandle: fixture.handleB, requestHandle: fixture.handleB,
  });
  assert.equal(openedA.status, 200, "positive control: seat A has an active batch");
  assert.equal(openedB.status, 200, "positive control: seat B has an active batch");

  const crossed = runHarness<HarnessResult[]>(fixture, {
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
  const refused = runHarness<HarnessResult>(fixture, {
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
  const opened = runHarness<HarnessResult>(fixture, { operation: "single" });
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
  const opened = runHarness<HarnessResult>(fixture, { operation: "single" });
  assert.equal(opened.status, 200, "positive control: first batch opened");
  const acknowledged = runHarness<HarnessResult>(fixture, {
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
  const first = runHarness<HarnessResult>(fixture, { operation: "single" });
  const firstIds = (first.body.signals as Array<{ id: string }>).map((row) => row.id);
  assert.deepEqual(firstIds, [...ids].sort().slice(0, 50),
    "positive control: first page follows truncated-time/UUID order");
  const second = runHarness<HarnessResult>(fixture, {
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
  const own = runHarness<HarnessResult>(fixture, { operation: "single" });
  assert.equal(own.status, 200, "positive control: matching seat can check");
  const crossed = runHarness<HarnessResult>(fixture, {
    operation: "single", capabilityHandle: fixture.handleB, requestHandle: fixture.handleA,
  });
  assert.equal(crossed.status, 403);
  await sql`UPDATE swarm.memberships SET revoked_at = statement_timestamp()
    WHERE workspace_id = ${fixture.workspace}::uuid AND user_id = ${fixture.owner}::uuid`;
  const revoked = runHarness<HarnessResult>(fixture, {
    operation: "single", capabilityHandle: fixture.handleA, requestHandle: fixture.handleA,
  });
  assert.equal(revoked.status, 403);
});

test("rollback injection leaves neither cursor nor batch", async () => {
  const fixture = await seedFixture();
  await postSignal(fixture);
  const rolledBack = runHarness<HarnessResult>(fixture, { operation: "single" }, true);
  assert.equal(rolledBack.status, 599);
  const [counts] = await sql<{ cursors: string; batches: string }[]>`
    SELECT
      (SELECT count(*)::text FROM swarm.hosted_mcp_check_cursors
       WHERE seat_id = ${fixture.seatA}::uuid) AS cursors,
      (SELECT count(*)::text FROM swarm.hosted_mcp_check_batches
       WHERE seat_id = ${fixture.seatA}::uuid) AS batches
  `;
  assert.deepEqual(counts, { cursors: "0", batches: "0" });
  const positive = runHarness<HarnessResult>(fixture, { operation: "single" });
  assert.equal(positive.status, 200, "positive control: normal transaction persists");
});
