/** HM lane-2 server coverage. Runs only in the manual `server` suite. */
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

const commandUrl = new URL("../../supabase/functions/command/index.ts", import.meta.url);
const readUrl = new URL("../../supabase/functions/read/index.ts", import.meta.url);
const migrationUrl = new URL(
  "../../supabase/migrations/20260928000002_hm_hosted_authority.sql",
  import.meta.url,
);
const catalogUrl = new URL(
  "../../deploy/release-proofs/item-hm/20260928000002-catalog.sql",
  import.meta.url,
);
const rollbackUrl = new URL(
  "../../deploy/release-proofs/item-hm/20260928000002-rollback.sql",
  import.meta.url,
);

let sql: postgres.Sql;
let local: LocalEnvironment;
let admin: SupabaseClient;
let harnessDir: string;
let harnessPath: string;

interface LocalEnvironment {
  API_URL: string;
  ANON_KEY: string;
  DB_URL: string;
  SERVICE_ROLE_KEY: string;
}

interface HarnessResult {
  status: number;
  body: Record<string, unknown>;
}

const harnessSource = `
const input = JSON.parse(await new Response(Deno.stdin.readable).text());
const upstreamFetch = globalThis.fetch.bind(globalThis);
let authPhase = "neutral";
let gotrueUserCalls = 0;
globalThis.fetch = async (request, init) => {
  const url = typeof request === "string" || request instanceof URL
    ? String(request)
    : request.url;
  if (url.includes("/auth/v1/user")) {
    if (authPhase === "hosted") throw new Error("GoTrue reached during hosted call");
    gotrueUserCalls += 1;
  }
  return await upstreamFetch(request, init);
};

const commandModule = await import(${JSON.stringify(commandUrl.href)});
const authModule = await import(${JSON.stringify(
  new URL("../../supabase/functions/_shared/hosted-seat-auth.ts", import.meta.url).href,
)});
const {
  db,
  handleHostedCommand,
  handleHostedManagementCommand,
  handleRequest,
} = commandModule;
const { authenticateHostedGrantCapability } = authModule;

const commandInput = (workspaceId, name, commandId) => ({
  command_id: commandId,
  client_version: "0.1.0",
  workspace_id: workspaceId,
  stream: { kind: "workspace" },
  command: { kind: "claim_hosted_seat", name },
});

async function capability(grantId, ownerUserId, workspaceId) {
  return await db.begin(async (tx) => {
    const value = await authenticateHostedGrantCapability(tx, {
      grantId,
      ownerUserId,
      providerGrantId: "provider-" + grantId,
      workspaceId,
      tool: "claim_hosted_seat",
      providerStatus: async () => ({ active: true }),
    });
    if (value === null) throw new Error("hosted grant capability was refused");
    return value;
  });
}

function reportNon2xx(label, result) {
  if (result.status < 200 || result.status >= 300) {
    console.error("HM_NON_2XX:" + label + ":" + JSON.stringify(result));
  }
  return result;
}

async function claim(spec, existingCapability) {
  const cap = existingCapability ?? await capability(
    spec.grantId,
    spec.ownerUserId,
    spec.workspaceId,
  );
  return reportNon2xx("hosted", await handleHostedCommand(
    commandInput(spec.workspaceId, spec.name, spec.commandId),
    cap,
  ));
}

async function publicCommand(bearer, workspaceId, body, commandId = crypto.randomUUID()) {
  const response = await handleRequest(new Request("http://local/functions/v1/command", {
    method: "POST",
    headers: {
      authorization: "Bearer " + bearer,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      command_id: commandId,
      client_version: "0.1.0",
      workspace_id: workspaceId,
      stream: { kind: "workspace" },
      command: body,
    }),
  }));
  return reportNon2xx("public", {
    status: response.status,
    body: await response.json(),
  });
}

async function managementCommand(
  ownerUserId,
  workspaceId,
  body,
  commandId = crypto.randomUUID(),
) {
  return reportNon2xx("management", await handleHostedManagementCommand({
    command_id: commandId,
    client_version: "0.1.0",
    workspace_id: workspaceId,
    stream: { kind: "workspace" },
    command: body,
  }, {
    userId: ownerUserId,
    email: null,
    displayName: "HM owner",
    identityVerified: true,
    interactiveAuthAtSeconds: null,
  }));
}

async function race() {
  const hostedSpec = input.hosted;
  const firstCapability = await capability(
    hostedSpec.grantId,
    hostedSpec.ownerUserId,
    hostedSpec.workspaceId,
  );
  let secondCapability = null;
  let joinCredential = null;
  if (input.competitor === "hosted") {
    secondCapability = await capability(
      input.competingGrantId,
      hostedSpec.ownerUserId,
      hostedSpec.workspaceId,
    );
  } else if (input.competitor === "h0") {
    const minted = await publicCommand(input.ownerJwt, hostedSpec.workspaceId, {
      kind: "mint_agent_join_credential",
      seat_cap: 1,
      ttl_hours: 4,
    });
    if (minted.status !== 200 || typeof minted.body.join_credential !== "string") {
      throw new Error("join credential mint failed: " + JSON.stringify(minted));
    }
    joinCredential = minted.body.join_credential;
  }

  const runCompetitor = async () => {
    if (input.competitor === "hosted") {
      return await claim({
        ...hostedSpec,
        grantId: input.competingGrantId,
        commandId: crypto.randomUUID(),
      }, secondCapability);
    }
    if (input.competitor === "h0") {
      return await publicCommand(joinCredential, crypto.randomUUID(), {
        kind: "register_agent_seat",
        attempt_id: crypto.randomUUID(),
        name: hostedSpec.name,
      });
    }
    return await publicCommand(input.ownerJwt, hostedSpec.workspaceId, {
      kind: "create_agent_principal",
      name: hostedSpec.name,
      ...(input.competitor === "duplicate" ? { allow_duplicate_name: true } : {}),
    });
  };
  if (input.order === "competitor-first") {
    const competitor = await runCompetitor();
    const hosted = await claim(hostedSpec, firstCapability);
    return [hosted, competitor];
  }
  const hosted = await claim(hostedSpec, firstCapability);
  const competitor = await runCompetitor();
  return [hosted, competitor];
}

async function capRace() {
  for (let index = 0; index < 9; index += 1) {
    const seeded = await claim({
      ...input.base,
      commandId: crypto.randomUUID(),
      name: "cap-seed-" + index + "-" + crypto.randomUUID(),
    });
    if (seeded.status !== 200) {
      throw new Error("cap seed failed: " + JSON.stringify(seeded));
    }
  }
  const left = {
    ...input.base,
    commandId: crypto.randomUUID(),
    name: "cap-left-" + crypto.randomUUID(),
  };
  const right = {
    ...input.base,
    workspaceId: input.otherWorkspaceId,
    commandId: crypto.randomUUID(),
    name: "cap-right-" + crypto.randomUUID(),
  };
  const [leftCapability, rightCapability] = await Promise.all([
    capability(left.grantId, left.ownerUserId, left.workspaceId),
    capability(right.grantId, right.ownerUserId, right.workspaceId),
  ]);
  return await Promise.all([
    claim(left, leftCapability),
    claim(right, rightCapability),
  ]);
}

async function boundary() {
  const cap = await capability(
    input.claim.grantId,
    input.claim.ownerUserId,
    input.claim.workspaceId,
  );
  authPhase = "hosted";
  const hosted = await claim(input.claim, cap);
  const hostedGoTrueCalls = gotrueUserCalls;
  authPhase = "human";
  const human = await publicCommand(input.ownerJwt, input.claim.workspaceId, {
    kind: "revoke_hosted_mcp_grant",
    grant_id: input.claim.grantId,
  });
  return { hosted, human, hostedGoTrueCalls, humanGoTrueCalls: gotrueUserCalls };
}

let result;
if (input.operation === "claim") result = await claim(input.claim);
else if (input.operation === "race") result = await race();
else if (input.operation === "cap-race") result = await capRace();
else if (input.operation === "public") {
  result = await publicCommand(
    input.ownerJwt,
    input.workspaceId,
    input.command,
    input.commandId,
  );
} else if (input.operation === "management") {
  result = await managementCommand(
    input.ownerUserId,
    input.workspaceId,
    input.command,
    input.commandId,
  );
} else if (input.operation === "boundary") result = await boundary();
else throw new Error("unknown hosted harness operation");

console.log("HM_RESULT:" + JSON.stringify(result));
await db.end({ timeout: 2 });
`;

before(async () => {
  const status = JSON.parse(execFileSync("supabase", ["status", "-o", "json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  })) as Partial<LocalEnvironment>;
  assert.ok(status.API_URL && status.ANON_KEY && status.DB_URL && status.SERVICE_ROLE_KEY);
  local = status as LocalEnvironment;
  const target = new URL(local.DB_URL);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(target.hostname));
  sql = postgres(local.DB_URL, { prepare: false, max: 4 });
  admin = createClient(local.API_URL, local.SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  harnessDir = mkdtempSync(join(tmpdir(), "hm-hosted-authority-"));
  harnessPath = join(harnessDir, "command-harness.ts");
  writeFileSync(harnessPath, harnessSource);
});

after(async () => {
  await sql.end();
  rmSync(harnessDir, { recursive: true, force: true });
});

interface HostedFixture {
  owner: string;
  other: string;
  workspaceA: string;
  workspaceB: string;
  streamA: string;
  streamB: string;
  grantA: string;
  grantB: string;
  ownerJwt: string;
}

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

async function seedHostedFixture(): Promise<HostedFixture> {
  const owner = await createAuthUser("hm-owner");
  const other = await createAuthUser("hm-other");
  const fixture: HostedFixture = {
    owner: owner.id, other: other.id,
    workspaceA: randomUUID(), workspaceB: randomUUID(),
    streamA: randomUUID(), streamB: randomUUID(),
    grantA: randomUUID(), grantB: randomUUID(),
    ownerJwt: owner.jwt,
  };
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO swarm.users (user_id, display_name)
      VALUES (${fixture.owner}::uuid, 'HM owner'), (${fixture.other}::uuid, 'HM other')
    `;
    await tx`
      INSERT INTO swarm.workspaces (workspace_id, name, created_by)
      VALUES
        (${fixture.workspaceA}::uuid, 'HM A', ${fixture.owner}::uuid),
        (${fixture.workspaceB}::uuid, 'HM B', ${fixture.owner}::uuid)
    `;
    await tx`
      INSERT INTO swarm.memberships (workspace_id, user_id, role)
      VALUES
        (${fixture.workspaceA}::uuid, ${fixture.owner}::uuid, 'owner'),
        (${fixture.workspaceB}::uuid, ${fixture.owner}::uuid, 'owner')
    `;
    await tx`
      INSERT INTO swarm.streams (stream_id, workspace_id, kind)
      VALUES
        (${fixture.streamA}::uuid, ${fixture.workspaceA}::uuid, 'workspace'),
        (${fixture.streamB}::uuid, ${fixture.workspaceB}::uuid, 'workspace')
    `;
    for (const grant of [fixture.grantA, fixture.grantB]) {
      await tx`
        INSERT INTO swarm.hosted_mcp_grants (
          grant_id, provider_grant_id, owner_user_id, home_workspace_id,
          client_id, resource, selected_workspace_ids, manifest_digest,
          interaction_ref, state, created_at, activated_at
        ) VALUES (
          ${grant}::uuid, ${`provider-${grant}`}, ${fixture.owner}::uuid,
          ${fixture.workspaceA}::uuid, 'test-client',
          'https://mcp.commonswarm.com/mcp',
          ${[fixture.workspaceA, fixture.workspaceB]}::uuid[],
          ${new Uint8Array(32).fill(7)}, ${`interaction-${grant}`},
          'active', statement_timestamp(), statement_timestamp()
        )
      `;
      for (const workspace of [fixture.workspaceA, fixture.workspaceB]) {
        await tx`
          INSERT INTO swarm.hosted_mcp_grant_workspaces (
            grant_id, workspace_id, owner_user_id, manifest_digest,
            consent_receipt_id, consented_at
          ) VALUES (
            ${grant}::uuid, ${workspace}::uuid, ${fixture.owner}::uuid,
            ${new Uint8Array(32).fill(7)}, ${randomUUID()}::uuid,
            statement_timestamp()
          )
        `;
      }
    }
  });
  return fixture;
}

function runHostedHarness<T>(input: Record<string, unknown>): T {
  const result = spawnSync("deno", [
    "run",
    "--no-lock",
    "--config",
    "supabase/functions/command/deno.json",
    "--allow-env",
    "--allow-net",
    "--allow-read",
    harnessPath,
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    input: JSON.stringify(input),
    env: {
      PATH: process.env.PATH ?? "",
      ...(process.env.DENO_DIR ? { DENO_DIR: process.env.DENO_DIR } : {}),
      SWARM_ENV: "test",
      SWARM_DATABASE_URL: local.DB_URL,
      SUPABASE_DB_URL: local.DB_URL,
      SUPABASE_URL: local.API_URL,
      SUPABASE_ANON_KEY: local.ANON_KEY,
    },
    timeout: 90_000,
  });
  if (result.error) {
    assert.fail(`hosted harness failed to start deno: ${result.error.message}`);
  }
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const line = result.stdout.trim().split("\n").reverse().find((entry) =>
    entry.startsWith("HM_RESULT:"));
  assert.equal(typeof line, "string", result.stdout);
  const parsed = JSON.parse((line ?? "").slice("HM_RESULT:".length)) as T;
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
      `hosted harness returned a non-2xx response; subprocess stderr follows:\n${result.stderr || "(empty)\n"}`,
    );
  }
  return parsed;
}

function claimSpec(
  fixture: HostedFixture,
  grantId: string,
  workspaceId: string,
  name: string,
  commandId = randomUUID(),
): Record<string, string> {
  return {
    grantId,
    ownerUserId: fixture.owner,
    workspaceId,
    name,
    commandId,
  };
}

test("HM hosted catalogs enforce RLS, least privilege, composite ownership, and live idempotency kinds", async () => {
  const [row] = await sql<{
    tables_ok: boolean;
    functions_ok: boolean;
    composites_ok: boolean;
    idempotency_ok: boolean;
  }[]>`
    SELECT
      (
        SELECT count(*) = 4 AND bool_and(c.relrowsecurity)
          AND bool_and(pg_get_userbyid(c.relowner) = 'swarm_admin')
          AND bool_and(has_table_privilege('swarm_command', c.oid, 'SELECT'))
          AND bool_and(NOT has_table_privilege('swarm_read', c.oid, 'SELECT'))
          AND bool_and(NOT has_table_privilege('authenticated', c.oid, 'SELECT'))
        FROM pg_class AS c
        WHERE c.oid = ANY(ARRAY[
          'swarm.hosted_mcp_grants'::regclass,
          'swarm.hosted_mcp_grant_workspaces'::regclass,
          'swarm.hosted_mcp_seats'::regclass,
          'swarm.hosted_mcp_seat_handles'::regclass
        ])
      ) AS tables_ok,
      has_function_privilege('swarm_command',
        'swarm.resolve_hosted_seat_command_authorization(uuid,text,text)', 'EXECUTE')
      AND NOT has_function_privilege('swarm_read',
        'swarm.resolve_hosted_seat_command_authorization(uuid,text,text)', 'EXECUTE')
      AND has_function_privilege('swarm_read',
        'swarm.resolve_hosted_seat_read_authorization(uuid,text,text)', 'EXECUTE')
      AND NOT has_function_privilege('swarm_command',
        'swarm.resolve_hosted_seat_read_authorization(uuid,text,text)', 'EXECUTE')
      AS functions_ok,
      (
        SELECT count(*) >= 2
        FROM pg_constraint
        WHERE contype = 'f'
          AND conrelid = ANY(ARRAY[
            'swarm.hosted_mcp_seats'::regclass,
            'swarm.hosted_mcp_seat_handles'::regclass
          ])
          AND pg_get_constraintdef(oid) LIKE '%grant_id%workspace_id%'
      ) AS composites_ok,
      (
        SELECT pg_get_constraintdef(oid) LIKE '%join%hosted_grant%hosted_seat%'
        FROM pg_constraint
        WHERE conrelid = 'swarm.idempotency_keys'::regclass
          AND conname = 'idempotency_keys_principal_kind_check'
      ) AS idempotency_ok
  `;
  assert.deepEqual(row, {
    tables_ok: true,
    functions_ok: true,
    composites_ok: true,
    idempotency_ok: true,
  });
});

test("catalog proof is search-path independent and false without error before migration", async () => {
  const [catalog, rollback, migration] = await Promise.all([
    readFile(catalogUrl, "utf8"),
    readFile(rollbackUrl, "utf8"),
    readFile(migrationUrl, "utf8"),
  ]);
  const catalogQuery = catalog.replace(/\\gset\s*$/u, "");
  await sql.begin(async (tx) => {
    const [positive] = await tx.unsafe<{ catalog_ok: boolean }[]>(catalogQuery);
    assert.equal(positive?.catalog_ok, true, "positive control: applied catalog");
    await tx.unsafe(rollback);
    const [before] = await tx.unsafe<{ catalog_ok: boolean }[]>(catalogQuery);
    assert.equal(before?.catalog_ok, false, "missing objects return false without throwing");
    await tx.unsafe(migration);
    const [after] = await tx.unsafe<{ catalog_ok: boolean }[]>(catalogQuery);
    assert.equal(after?.catalog_ok, true, "reapplied migration restores catalog");
    await tx.unsafe('SET LOCAL search_path = "$user", public, auth, extensions');
    const [productionPath] = await tx.unsafe<{ catalog_ok: boolean }[]>(catalogQuery);
    assert.equal(
      productionPath?.catalog_ok,
      true,
      "production-like search_path does not change the catalog proof",
    );
    throw new Error("ROLLBACK_HM_PROOF_DRILL");
  }).catch((error) => {
    if (!(error instanceof Error) || error.message !== "ROLLBACK_HM_PROOF_DRILL") throw error;
  });
});

test("all five hosted-name races enter the real command paths", { timeout: 180_000 }, async () => {
  const fixture = await seedHostedFixture();
  const cases: Array<{
    label: string;
    competitor: "hosted" | "ordinary" | "duplicate" | "h0";
    grantId: string;
  }> = [
    { label: "same-grant", competitor: "hosted", grantId: fixture.grantA },
    { label: "different-grant", competitor: "hosted", grantId: fixture.grantB },
    { label: "ordinary", competitor: "ordinary", grantId: fixture.grantA },
    { label: "duplicate-enabled", competitor: "duplicate", grantId: fixture.grantA },
    { label: "h0-registration", competitor: "h0", grantId: fixture.grantA },
  ];
  for (const { label, competitor, grantId } of cases) {
    for (const order of ["hosted-first", "competitor-first"] as const) {
      const caseLabel = `${label}/${order}`;
      const name = `race-${label}-${randomUUID().slice(0, 8)}`;
      const results = runHostedHarness<HarnessResult[]>({
        operation: "race",
        order,
        competitor,
        competingGrantId: grantId,
        ownerJwt: fixture.ownerJwt,
        hosted: claimSpec(fixture, fixture.grantA, fixture.workspaceA, name),
      });
      assert.equal(results.length, 2, caseLabel);
      if (label === "same-grant") {
        assert.deepEqual(results.map((result) => result.status), [200, 200], caseLabel);
        assert.equal(results[0]?.body.seat_id, results[1]?.body.seat_id,
          "the same grant/workspace/name reuses one seat");
      } else {
        const winner = order === "hosted-first" ? results[0] : results[1];
        const loser = order === "hosted-first" ? results[1] : results[0];
        assert.equal(winner?.status, 200, `${caseLabel}: winner status`);
        assert.equal(winner?.body.status, "accepted", `${caseLabel}: winner body`);
        if (competitor === "hosted" || competitor === "h0" ||
            order === "competitor-first") {
          assert.equal(loser?.status, 409, `${caseLabel}: hosted loser status`);
          assert.equal(
            loser?.body.error,
            "hosted_seat_name_taken",
            `${caseLabel}: hosted loser code`,
          );
          assert.equal(
            loser?.body.message,
            "That name is taken in this workspace; choose another.",
            `${caseLabel}: hosted loser message`,
          );
          if (competitor === "h0" && order === "hosted-first") {
            assert.equal(
              loser?.body.reason,
              "hosted_seat_name_taken",
              `${caseLabel}: H0 loser reason`,
            );
          }
        } else {
          assert.equal(loser?.status, 200, `${caseLabel}: ordinary loser status`);
          assert.equal(
            loser?.body.reason,
            "principal_name_taken",
            `${caseLabel}: ordinary loser code`,
          );
        }
      }
      const rows = await sql<{ n: string }[]>`
        SELECT count(*)::text AS n FROM swarm.agent_principals
        WHERE workspace_id = ${fixture.workspaceA}::uuid AND name = ${name}
      `;
      assert.equal(Number(rows[0]?.n), 1, caseLabel);
    }
  }
});

test("claim path keeps every creation path on the shared locks", async () => {
  const source = await readFile(commandUrl, "utf8");
  const claimStart = source.indexOf("async function claimHostedSeat(");
  const claimEnd = source.indexOf("\nasync function handleTransaction(", claimStart);
  assert.ok(claimStart >= 0 && claimEnd > claimStart);
  const claim = source.slice(claimStart, claimEnd);
  assert.match(claim, /await lockPrincipalName\(tx, route, input\.command\)/);
  const grantLockStart = claim.indexOf("const lockedGrantRows =");
  const grantLockEnd = claim.indexOf("const grant = lockedGrantRows[0]", grantLockStart);
  assert.ok(grantLockStart >= 0 && grantLockEnd > grantLockStart);
  assert.match(
    claim.slice(grantLockStart, grantLockEnd),
    /FROM swarm\.hosted_mcp_grants[\s\S]*WHERE grant_id = \$\{resolved\.grant_id\}::uuid\s+FOR UPDATE\s+`/,
    "the real claim transaction locks the grant before counting seats",
  );
  assert.equal(
    [...source.matchAll(/await lockPrincipalName\(/gu)].length,
    4,
    "registration, join mint, ordinary creation, and hosted claim all take the shared name lock",
  );
  assert.equal(
    [...source.matchAll(/await hostedNameReserved\(/gu)].length,
    3,
    "every non-hosted principal creation path refuses a live hosted reservation",
  );
});

test("real claim path serializes the ten-seat cap across workspaces", { timeout: 120_000 }, async () => {
  const fixture = await seedHostedFixture();
  const results = runHostedHarness<HarnessResult[]>({
    operation: "cap-race",
    base: claimSpec(
      fixture,
      fixture.grantA,
      fixture.workspaceA,
      `cap-base-${randomUUID().slice(0, 8)}`,
    ),
    otherWorkspaceId: fixture.workspaceB,
  });
  assert.deepEqual(
    results.map((result) => [result.status, result.body.error ?? "accepted"]).sort(),
    [[200, "accepted"], [403, "hosted_seat_limit_reached"]],
  );
  const rows = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM swarm.hosted_mcp_seats
    WHERE grant_id = ${fixture.grantA}::uuid AND revoked_at IS NULL
  `;
  assert.equal(Number(rows[0]?.n), 10);
});

test("revocation is rechecked by the real claim idempotency replay", { timeout: 120_000 }, async () => {
  const fixture = await seedHostedFixture();
  const name = `replay-${randomUUID()}`;
  const commandId = randomUUID();
  const claim = claimSpec(fixture, fixture.grantA, fixture.workspaceA, name, commandId);
  const first = runHostedHarness<HarnessResult>({ operation: "claim", claim });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.status, "accepted");
  const replay = runHostedHarness<HarnessResult>({ operation: "claim", claim });
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body.replayed, true, "positive control: live seat replays");
  const [seat] = await sql<{
    seat_id: string; principal_id: string; handle: string;
  }[]>`
    SELECT hs.seat_id, hs.principal_id, h.handle
    FROM swarm.hosted_mcp_seats AS hs
    JOIN swarm.hosted_mcp_seat_handles AS h ON h.seat_id = hs.seat_id
    WHERE hs.grant_id = ${fixture.grantA}::uuid
      AND hs.workspace_id = ${fixture.workspaceA}::uuid
      AND hs.name = ${name}
  `;
  assert.ok(seat);
  await sql`
    UPDATE swarm.agent_principals SET revoked_at = statement_timestamp()
    WHERE principal_id = ${seat.principal_id}::uuid
  `;
  const refused = runHostedHarness<HarnessResult>({ operation: "claim", claim });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error, "hosted_seat_revoked");
});

test("real hosted entry avoids GoTrue while the real human handler calls it", { timeout: 120_000 }, async () => {
  const fixture = await seedHostedFixture();
  const result = runHostedHarness<{
    hosted: HarnessResult;
    human: HarnessResult;
    hostedGoTrueCalls: number;
    humanGoTrueCalls: number;
  }>({
    operation: "boundary",
    ownerJwt: fixture.ownerJwt,
    claim: claimSpec(
      fixture,
      fixture.grantA,
      fixture.workspaceA,
      `gotrue-boundary-${randomUUID().slice(0, 8)}`,
    ),
  });
  assert.equal(result.hosted.status, 200, JSON.stringify(result.hosted.body));
  assert.equal(result.hostedGoTrueCalls, 0, "hosted claim called GoTrue");
  assert.equal(result.human.status, 200, JSON.stringify(result.human.body));
  assert.ok(result.humanGoTrueCalls > 0, "positive control: human management called GoTrue");
});

test("hosted signal attribution and read containment remain principal-scoped", async () => {
  const [command, read] = await Promise.all([
    readFile(commandUrl, "utf8"),
    readFile(readUrl, "utf8"),
  ]);
  assert.match(command, /agent_principal: seat\.principal_id/);
  assert.match(command, /ledgerCredentialKind: "hosted_seat"/);
  assert.match(command, /from_kind[\s\S]*\$\{auth\.credentialKind\}/);
  assert.match(read, /s\.to_agent = \$\{seat\.principal_id\}::uuid/);
  assert.match(read, /s\.recipients @> jsonb_build_array/);
  assert.match(read, /ORDER BY date_trunc\('milliseconds', s\.created_at\), s\.id/);
});

test("management views are owner-scoped and reveal no handle or provider credential", async () => {
  const rows = await sql<{ view_name: string; definition: string }[]>`
    SELECT viewname AS view_name, definition
    FROM pg_views
    WHERE schemaname = 'swarm_read'
      AND viewname IN ('hosted_mcp_connections', 'hosted_mcp_seats')
    ORDER BY viewname
  `;
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.match(row.definition, /auth\.uid\(\)/);
    assert.doesNotMatch(row.definition, /provider_grant_id|handle|manifest_digest|interaction_ref/);
  }
  const migration = await readFile(migrationUrl, "utf8");
  assert.match(migration, /REVOKE ALL ON TABLE[\s\S]*FROM PUBLIC, anon, authenticated, swarm_read, swarm_command/);

  const fixture = await seedHostedFixture();
  const visibleTo = async (userId: string) => await sql.begin(async (tx) => {
    await tx`SELECT set_config('request.jwt.claim.sub', ${userId}, true)`;
    await tx.unsafe("SET LOCAL ROLE authenticated");
    return await tx<{ grant_id: string }[]>`
      SELECT grant_id FROM swarm_read.hosted_mcp_connections
      WHERE grant_id IN (${fixture.grantA}::uuid, ${fixture.grantB}::uuid)
      ORDER BY grant_id
    `;
  });
  assert.equal((await visibleTo(fixture.owner)).length, 2,
    "positive control: owner sees their connections");
  assert.equal((await visibleTo(fixture.other)).length, 0,
    "another owner cannot view them");
});

test("owner self-revocation uses the command path after activation, membership loss, or archive", {
  timeout: 120_000,
}, async () => {
  for (const condition of ["activation", "membership", "archive"] as const) {
    const fixture = await seedHostedFixture();
    const authorization = async () => await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE swarm_command");
      const [role] = await tx<{ role: string }[]>`SELECT current_user AS role`;
      assert.equal(role?.role, "swarm_command", "test transaction did not switch role");
      return await tx`
        SELECT * FROM swarm.resolve_hosted_grant_authorization(
          ${fixture.grantA}::uuid, ${fixture.owner}::uuid,
          ${fixture.workspaceA}::uuid, 'claim_hosted_seat'
        )
      `;
    });
    assert.equal((await authorization()).length, 1,
      `${condition}: positive control authorizes the live owner`);

    if (condition === "activation") {
      await sql`
        UPDATE swarm.hosted_mcp_grants
        SET state = 'pending', activated_at = NULL
        WHERE grant_id = ${fixture.grantA}::uuid
      `;
      const activated = runHostedHarness<HarnessResult>({
        operation: "management",
        ownerUserId: fixture.owner,
        workspaceId: fixture.workspaceA,
        commandId: randomUUID(),
        command: { kind: "activate_hosted_mcp_grant", grant_id: fixture.grantA },
      });
      assert.equal(activated.status, 200, `${condition}: ${JSON.stringify(activated.body)}`);
      assert.equal(activated.body.status, "accepted");
      const [grant] = await sql<{ state: string }[]>`
        SELECT state FROM swarm.hosted_mcp_grants
        WHERE grant_id = ${fixture.grantA}::uuid
      `;
      assert.equal(grant?.state, "active", "activation command did not persist activation");
    } else if (condition === "membership") {
      await sql`
        UPDATE swarm.memberships SET revoked_at = statement_timestamp()
        WHERE workspace_id = ${fixture.workspaceA}::uuid
          AND user_id = ${fixture.owner}::uuid
      `;
    } else {
      await sql`
        UPDATE swarm.workspaces SET archived_at = statement_timestamp()
        WHERE workspace_id = ${fixture.workspaceA}::uuid
      `;
    }
    assert.equal(
      (await authorization()).length,
      condition === "activation" ? 1 : 0,
      `${condition}: hosted grant authorization state was wrong before revocation`,
    );

    const revoked = runHostedHarness<HarnessResult>({
      operation: "public",
      ownerJwt: fixture.ownerJwt,
      workspaceId: fixture.workspaceA,
      commandId: randomUUID(),
      command: { kind: "revoke_hosted_mcp_grant", grant_id: fixture.grantA },
    });
    assert.equal(revoked.status, 200, `${condition}: ${JSON.stringify(revoked.body)}`);
    assert.equal(revoked.body.status, "accepted");
    const [grant] = await sql<{ state: string; revoked_at: Date | null }[]>`
      SELECT state, revoked_at FROM swarm.hosted_mcp_grants
      WHERE grant_id = ${fixture.grantA}::uuid
    `;
    assert.equal(grant?.state, "revoked");
    assert.ok(grant?.revoked_at instanceof Date,
      `${condition}: command path did not persist revocation`);
  }
});
