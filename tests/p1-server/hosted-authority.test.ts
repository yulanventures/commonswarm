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
import { HOSTED_MCP_SEAT_LIMIT } from "../../src/protocol/hosted-authority.js";
import { emptyApplicationSchema, migrationNames as adminMigrationNames, repoSql, versions as adminVersions } from "../support/admin-schema-db.js";
import { releaseCatalogQuery } from "../support/release-catalog-query.js";

const commandUrl = new URL("../../supabase/functions/command/index.ts", import.meta.url);
const readUrl = new URL("../../supabase/functions/read/index.ts", import.meta.url);
const hmMigrationSequence = [
  {
    migrationUrl: new URL(
      "../../supabase/migrations/20260928000002_hm_hosted_authority.sql",
      import.meta.url,
    ),
    rollbackUrl: new URL(
      "../../deploy/release-proofs/item-hm/20260928000002-rollback.sql",
      import.meta.url,
    ),
  },
  {
    migrationUrl: new URL(
      "../../supabase/migrations/20260928000004_hm_hosted_check.sql",
      import.meta.url,
    ),
    rollbackUrl: new URL(
      "../../deploy/release-proofs/item-hm/20260928000004-rollback.sql",
      import.meta.url,
    ),
  },
] as const;
const reclaimMigration = () => repoSql("supabase/migrations/20261004000010_hosted_seat_name_reclaim.sql");
const reclaimRollback = () => repoSql("supabase/hosted-name-reclaim-reserve/20261004000010-rollback.sql");
const reclaimCatalog = () => releaseCatalogQuery(repoSql("deploy/release-proofs/hosted-name-reclaim/20261004000010-catalog.sql"), "catalog_ok");
const reclaimRollbackCatalog = () => releaseCatalogQuery(repoSql("deploy/release-proofs/hosted-name-reclaim/20261004000010-rollback-catalog.sql"), "rollback_ok");
const migrationUrl = hmMigrationSequence[0].migrationUrl;
const catalogUrl = new URL(
  "../../deploy/release-proofs/item-hm/20260928000002-catalog.sql",
  import.meta.url,
);
const rollbackCatalogUrl = new URL(
  "../../deploy/release-proofs/item-hm/20260928000002-rollback-catalog.sql",
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
const { authenticateHostedGrantCapability, authenticateHostedSeatCapability } = authModule;

const commandInput = (workspaceId, name, commandId) => ({
  command_id: commandId,
  client_version: "0.1.0",
  workspace_id: workspaceId,
  stream: { kind: "workspace" },
  command: { kind: "claim_hosted_seat", name, intent: "new", lifetime: "durable" },
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
  const cap = existingCapability ?? await capability(spec.grantId, spec.ownerUserId, spec.workspaceId);
  const result = reportNon2xx("hosted", await handleHostedCommand(commandInput(spec.workspaceId, spec.name, spec.commandId), cap));
  // Legacy authority tests below retain their pre-cutover handle/check fixtures.
  // New allocation/replay/quotas are exercised without this bridge in
  // hosted-context-allocation.test.ts. Phase 3 replaces these legacy resolvers.
  if (result.status === 200 && result.body.outcome === "created") {
    const r = result.body;
    await db.begin(async tx => {
      await tx\`SELECT set_config('role','swarm_command',true)\`;
      await tx\`INSERT INTO swarm.hosted_mcp_seat_handles(handle,seat_id,grant_id,workspace_id,principal_id,created_at)
        VALUES(\${r.handle},\${r.seat_id}::uuid,\${r.grant_id}::uuid,\${r.workspace_id}::uuid,\${r.principal_id}::uuid,\${new Date(r.created_at)})\`;
    });
  }
  return result;
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
    if (input.competitor === "mint") {
      const minted=await publicCommand(input.ownerJwt,hostedSpec.workspaceId,{
        kind:"mint_agent_join_credential",seat_cap:1,ttl_hours:4,
      });
      delete minted.body.join_credential;
      return minted;
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
  if (input.ceilingRace) {
    const [existing] = await db\`SELECT count(*)::int AS n FROM swarm.agent_principals WHERE workspace_id=\${hostedSpec.workspaceId}::uuid AND revoked_at IS NULL AND identity_lifetime='durable'\`;
    for (let i=existing.n;i<49;i++) await db\`INSERT INTO swarm.agent_principals(principal_id,workspace_id,owner_user_id,name)
      VALUES(\${crypto.randomUUID()}::uuid,\${hostedSpec.workspaceId}::uuid,\${hostedSpec.ownerUserId}::uuid,\${'capacity-'+i})\`;
  }
  const postgres = (await import("npm:postgres@3.4.9")).default;
  const observer = postgres(Deno.env.get("SWARM_DATABASE_URL"), {max:2,prepare:false});
  const started=performance.now();
  let left, right, blocked=0;
  try {
    await observer.begin(async barrier => {
      const [holder]=await barrier\`SELECT pg_backend_pid() AS pid\`;
      await barrier\`SELECT pg_advisory_xact_lock(hashtext(\${hostedSpec.workspaceId}::text),hashtext('principal-ceiling'))\`;
      const waitForBlocked = async count => {
        const deadline=performance.now()+10_000;
        while(performance.now()<deadline){
          const [row]=await observer\`
            WITH RECURSIVE waiting(pid) AS (
              SELECT pid FROM pg_stat_activity WHERE \${holder.pid}::int=ANY(pg_blocking_pids(pid))
              UNION
              SELECT a.pid FROM pg_stat_activity a JOIN waiting w ON w.pid=ANY(pg_blocking_pids(a.pid))
            ) SELECT count(DISTINCT pid)::int AS n FROM waiting\`;
          if(row.n>=count){blocked=row.n;return;}
          await new Promise(resolve=>setTimeout(resolve,20));
        }
        throw new Error('creation transactions did not overlap at ceiling barrier');
      };
      // Force both queue orders; neither transaction may commit before release.
      if(input.order==='competitor-first'){
        right=runCompetitor();right.catch(()=>{});await waitForBlocked(1);
        left=claim(hostedSpec,firstCapability);left.catch(()=>{});
      }else{
        left=claim(hostedSpec,firstCapability);left.catch(()=>{});await waitForBlocked(1);
        right=runCompetitor();right.catch(()=>{});
      }
      await waitForBlocked(2);
    });
    const results=await Promise.all([left,right]);
    return {results,blocked,elapsed:performance.now()-started};
  }finally{await observer.end({timeout:2});}

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

async function seatCommand(spec) {
  const cap = await db.begin(tx => authenticateHostedSeatCapability(tx, {
    grantId: spec.grantId,
    providerGrantId: "provider-" + spec.grantId,
    handle: spec.handle,
    tool: "note",
    providerStatus: async () => ({ active: true }),
  }, "command"));
  if (cap === null) return { status: 403, body: { error: "hosted_seat_forbidden" } };
  return await handleHostedCommand({
    command_id: crypto.randomUUID(), client_version: "0.1.80",
    workspace_id: spec.workspaceId, stream: { kind: "workspace" },
    command: { kind: "post_signal", signal_kind: "note",
      body: "D3 historical identity", to_user_id: null, to_agent_principal_id: null,
      in_reply_to: null, about: null },
  }, cap);
}

async function revokedGrantClaim() {
  const cap = await capability(input.claim.grantId, input.claim.ownerUserId, input.claim.workspaceId);
  const revoked = await managementCommand(input.claim.ownerUserId, input.claim.workspaceId, {
    kind: "revoke_hosted_mcp_grant", grant_id: input.claim.grantId,
  });
  return { revoked, refused: await claim(input.claim, cap) };
}

let result;
if (input.operation === "seat-command") result = await seatCommand(input.seat);
else if (input.operation === "revoked-grant-claim") result = await revokedGrantClaim();
else if (input.operation === "claim") result = await claim(input.claim);
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
  otherJwt: string;
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

async function seedHostedFixture(grantBOwnerIsOther = false): Promise<HostedFixture> {
  const owner = await createAuthUser("hm-owner");
  const other = await createAuthUser("hm-other");
  const fixture: HostedFixture = {
    owner: owner.id, other: other.id,
    workspaceA: randomUUID(), workspaceB: randomUUID(),
    streamA: randomUUID(), streamB: randomUUID(),
    grantA: randomUUID(), grantB: randomUUID(),
    ownerJwt: owner.jwt,
    otherJwt: other.jwt,
  };
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(1936142700, hashtext('hosted-context-allocation'))`;
    await tx`UPDATE swarm.config SET value='true'::jsonb WHERE key='hosted_context_allocation_enabled'`;
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
    if (grantBOwnerIsOther) {
      await tx`INSERT INTO swarm.memberships (workspace_id, user_id, role)
        VALUES (${fixture.workspaceA}::uuid, ${fixture.other}::uuid, 'member'),
               (${fixture.workspaceB}::uuid, ${fixture.other}::uuid, 'member')`;
    }
    for (const grant of [fixture.grantA, fixture.grantB]) {
      const grantOwner = grantBOwnerIsOther && grant === fixture.grantB ? fixture.other : fixture.owner;
      await tx`
        INSERT INTO swarm.hosted_mcp_grants (
          grant_id, provider_grant_id, owner_user_id, home_workspace_id,
          client_id, resource, selected_workspace_ids, manifest_digest,
          interaction_ref, state, created_at, activated_at
        ) VALUES (
          ${grant}::uuid, ${`provider-${grant}`}, ${grantOwner}::uuid,
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
            ${grant}::uuid, ${workspace}::uuid, ${grantOwner}::uuid,
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
      ...(input.operation === "race" ? { SWARM_CMD_TEST_SLEEP_AFTER_STEP: "2:50" } : {}),
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

test("catalog rollback preserves every receipt kind and reapply is search-path independent", async () => {
  const [catalog, rollbackCatalog, migrations] = await Promise.all([
    readFile(catalogUrl, "utf8"),
    readFile(rollbackCatalogUrl, "utf8"),
    Promise.all(hmMigrationSequence.map(async (entry) => ({
      migration: await readFile(entry.migrationUrl, "utf8"),
      rollback: await readFile(entry.rollbackUrl, "utf8"),
    }))),
  ]);
  const catalogQuery = releaseCatalogQuery(catalog, 'catalog_ok');
  const rollbackCatalogQuery = releaseCatalogQuery(rollbackCatalog, 'rollback_ok');
  const emptySchema = emptyApplicationSchema();
  const rollbackDrill = new Error("ROLLBACK_HM_PROOF_DRILL");
  await sql.begin(async (tx) => {
    // M1 adds a real FK to hosted grants. Reverse newer, data-free schema first
    // in an empty DDL snapshot; retain every original grant/artifact/receipt.
    await tx.unsafe(emptySchema);
    await tx.unsafe(repoSql("deploy/release-proofs/session-identity/20261006000003-rollback.sql"));
    for (const version of [...adminVersions].reverse()) {
      await tx.unsafe(repoSql(`supabase/admin-delegation-reserve/${version}-rollback.sql`));
    }
    const [reclaimBefore] = await tx.unsafe<{ catalog_ok: boolean }[]>(reclaimCatalog());
    assert.equal(reclaimBefore?.catalog_ok, true, "010 forward schema positive control");
    await tx.unsafe(reclaimRollback());
    const [reclaimInverse] = await tx.unsafe<{ rollback_ok: boolean }[]>(reclaimRollbackCatalog());
    assert.equal(reclaimInverse?.rollback_ok, true, "010 inverse before HM rollback");
    const [positive] = await tx.unsafe<{ catalog_ok: boolean }[]>(catalogQuery);
    assert.equal(positive?.catalog_ok, true, "positive control: applied catalog");
    // Real durable receipts must survive the inverse, including both HM kinds.
    // Random identifiers keep the drill independent of earlier server tests.
    const commandId = randomUUID();
    for (const kind of ["user", "agent", "join", "hosted_grant", "hosted_seat"]) {
      await tx`
        INSERT INTO swarm.idempotency_keys (
          principal_kind, principal_id, command_id, workspace_id, stream_id,
          request_hash, response
        ) VALUES (
          ${kind}, ${randomUUID()}, ${commandId}, ${randomUUID()}, ${randomUUID()},
          'rollback-receipt-proof', ${tx.json({ status: "accepted", kind })}
        )
      `;
    }
    const receiptsBefore = await tx`
      SELECT * FROM swarm.idempotency_keys
      WHERE command_id = ${commandId} ORDER BY principal_kind
    `;
    assert.equal(receiptsBefore.length, 5);
    for (const { rollback } of [...migrations].reverse()) {
      await tx.unsafe(rollback);
    }
    const [rolledBack] = await tx.unsafe<{ rollback_ok: boolean }[]>(rollbackCatalogQuery);
    assert.equal(rolledBack?.rollback_ok, true, "rollback catalog accepts exactly the retained kinds");
    const receiptsAfter = await tx`
      SELECT * FROM swarm.idempotency_keys
      WHERE command_id = ${commandId} ORDER BY principal_kind
    `;
    assert.deepEqual(receiptsAfter, receiptsBefore, "rollback preserves complete receipt contents");
    await assert.rejects(tx.savepoint(async (savepoint) => {
      await savepoint`
        INSERT INTO swarm.idempotency_keys (
          principal_kind, principal_id, command_id, workspace_id, stream_id,
          request_hash, response
        ) VALUES (
          'unknown_rollback_kind', ${randomUUID()}, ${commandId},
          ${randomUUID()}, ${randomUUID()}, 'rollback-receipt-proof', '{}'::jsonb
        )
      `;
    }), (error: unknown) => error instanceof postgres.PostgresError &&
      error.code === "23514" &&
      error.constraint_name === "idempotency_keys_principal_kind_check",
    "rollback still rejects an unknown kind through the real check constraint");
    const [before] = await tx.unsafe<{ catalog_ok: boolean }[]>(catalogQuery);
    assert.equal(before?.catalog_ok, false, "missing objects return false without throwing");
    for (const { migration } of migrations) {
      await tx.unsafe(migration);
    }
    const [after] = await tx.unsafe<{ catalog_ok: boolean }[]>(catalogQuery);
    assert.equal(after?.catalog_ok, true, "reapplied migration restores catalog");
    await tx.unsafe('SET LOCAL search_path = "$user", public, auth, extensions');
    const [productionPath] = await tx.unsafe<{ catalog_ok: boolean }[]>(catalogQuery);
    assert.equal(
      productionPath?.catalog_ok,
      true,
      "production-like search_path does not change the catalog proof",
    );
    for (const name of adminMigrationNames) {
      await tx.unsafe(repoSql(`supabase/migrations/${name}`));
    }
    for (const version of adminVersions) {
      const query = releaseCatalogQuery(repoSql(`deploy/release-proofs/item-ai/${version}-catalog.sql`), 'catalog_ok');
      const [restored] = await tx.unsafe<{ catalog_ok: boolean; catalog_ok_failed_checks: string }[]>(query);
      assert.equal(restored?.catalog_ok, true, `reapplied admin catalog ${version}: ${restored?.catalog_ok_failed_checks}`);
    }
    await tx.unsafe(reclaimMigration());
    const [reclaimAfter] = await tx.unsafe<{ catalog_ok: boolean }[]>(reclaimCatalog());
    assert.equal(reclaimAfter?.catalog_ok, true, "010 reapply after HM restores live-name schema");
    throw rollbackDrill;
  }).catch((error) => {
    if (error !== rollbackDrill) throw error;
  });
});

interface RaceReceipt { results: HarnessResult[]; blocked: number; elapsed: number }

test("overlapping hosted/local name transactions commit unique addresses in both queue orders", { timeout: 240_000 }, async () => {
  for (const competitor of ["hosted", "ordinary", "duplicate", "h0"] as const) {
    for (const order of ["hosted-first", "competitor-first"] as const) {
      const fixture = await seedHostedFixture();
      const name = `race-${randomUUID().slice(0,8)}`;
      const receipt = runHostedHarness<RaceReceipt>({ operation: "race", order, competitor,
        competingGrantId: fixture.grantB, ownerJwt: fixture.ownerJwt,
        hosted: claimSpec(fixture, fixture.grantA, fixture.workspaceA, name) });
      const results = receipt.results;
      assert.equal(receipt.blocked, 2, "both real command transactions wait before barrier release");
      assert.ok(receipt.elapsed < 30_000, "bounded completion without deadlock or hang");
      assert.equal(results[0]?.status, 200, "hosted new chooses an available address");
      if (competitor === "hosted") {
        assert.equal(results[1]?.status, 200);
        assert.notEqual(results[0]?.body.principal_id, results[1]?.body.principal_id);
        assert.notEqual(results[0]?.body.name, results[1]?.body.name);
      } else if (order === "competitor-first") {
        assert.equal(results[1]?.status, 200, "local same-route creation succeeds when first");
        assert.equal(results[0]?.body.adjustment_reason, "collision");
        assert.notEqual(results[0]?.body.name, name);
      } else if (competitor === "h0") {
        assert.equal(results[1]?.status, 409);
        assert.equal(results[1]?.body.reason, "hosted_seat_name_taken");
      } else {
        assert.equal(results[1]?.body.reason, "principal_name_taken");
      }
      const [row] = await sql`SELECT count(*)::int AS n FROM swarm.agent_principals WHERE workspace_id=${fixture.workspaceA}::uuid AND name=${name}`;
      assert.equal(row!.n, 1, "one exact address committed");
      const [duplicates] = await sql`SELECT count(*)::int AS n FROM (
        SELECT name FROM swarm.agent_principals WHERE workspace_id=${fixture.workspaceA}::uuid AND revoked_at IS NULL
        GROUP BY name HAVING count(*)>1) duplicates`;
      assert.equal(duplicates!.n, 0, "every committed live address is unique");
      const [counts] = await sql`SELECT count(*)::int AS durable FROM swarm.agent_principals
        WHERE workspace_id=${fixture.workspaceA}::uuid AND revoked_at IS NULL AND identity_lifetime='durable'`;
      assert.equal(counts!.durable, competitor === "hosted" ? 2 : competitor === "h0" ? (order === "competitor-first" ? 3 : 2) : order === "competitor-first" ? 2 : 1,
        "only successful identities and the live H0 registrar consume capacity");
    }
  }
});

test("overlapping hosted, H0, local and join-mint creation serialize the last durable slot", { timeout: 300_000 }, async () => {
  for (const competitor of ["hosted", "ordinary", "duplicate", "h0", "mint"] as const) {
    for (const order of ["hosted-first", "competitor-first"] as const) {
      const fixture = await seedHostedFixture();
      const receipt = runHostedHarness<RaceReceipt>({operation:"race",ceilingRace:true,order,competitor,
        competingGrantId:fixture.grantB,ownerJwt:fixture.ownerJwt,
        hosted:claimSpec(fixture,fixture.grantA,fixture.workspaceA,`last-${randomUUID().slice(0,8)}`)});
      assert.equal(receipt.blocked, 2, `${competitor}/${order}: transactions really overlap`);
      assert.ok(receipt.elapsed < 30_000, `${competitor}/${order}: bounded completion`);
      assert.equal(receipt.results.filter(r=>r.status===200).length,1,"exactly one last-slot winner");
      assert.equal(receipt.results[order === "hosted-first" ? 0 : 1]?.status,200,"same-route positive control in each queue order");
      assert.equal(receipt.results.find(r=>r.status!==200)?.body.error,"principal_limit_reached","loser reaches the durable ceiling");
      const [count]=await sql`SELECT count(*)::int AS n FROM swarm.agent_principals
        WHERE workspace_id=${fixture.workspaceA}::uuid AND revoked_at IS NULL AND identity_lifetime='durable'`;
      assert.equal(count!.n,50,"committed durable count never exceeds 50");
      const [duplicates]=await sql`SELECT count(*)::int AS n FROM (
        SELECT name FROM swarm.agent_principals WHERE workspace_id=${fixture.workspaceA}::uuid AND revoked_at IS NULL
        GROUP BY name HAVING count(*)>1) duplicates`;
      assert.equal(duplicates!.n,0,"capacity race preserves unique committed names");
    }
  }
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
  assert.equal(refused.body.error, "identity_resume_unavailable");
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

async function removeHostedSeat(fixture: HostedFixture, grantId: string, seatId: unknown): Promise<void> {
  const removed = runHostedHarness<HarnessResult>({
    operation: "management", ownerUserId: fixture.owner, workspaceId: fixture.workspaceA,
    command: { kind: "revoke_hosted_mcp_seat", grant_id: grantId, seat_id: seatId },
  });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(removed.body.status, "accepted");
}

function claimSeat(fixture: HostedFixture, grantId: string, name: string): HarnessResult {
  const result = runHostedHarness<HarnessResult>({ operation: "claim",
    claim: claimSpec(fixture, grantId, fixture.workspaceA, name) });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.status, "accepted");
  for (const field of ["seat_id", "principal_id", "handle"]) assert.equal(typeof result.body[field], "string");
  return result;
}

function assertAcceptedSeatNote(result: HarnessResult, principalId: unknown): void {
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.status, "accepted");
  assert.equal(result.body.ok, true);
  assert.deepEqual(result.body.event_ids, []);
  const signal = result.body.signal as Record<string, unknown>;
  assert.ok(signal && typeof signal === "object" && !Array.isArray(signal));
  assert.equal(typeof signal.id, "string");
  assert.equal(signal.kind, "note");
  assert.equal(signal.from, principalId);
}

async function hostedRows(seatId: unknown) {
  return await sql`
    SELECT row_to_json(hs) AS seat, row_to_json(h) AS handle, row_to_json(p) AS principal
    FROM swarm.hosted_mcp_seats AS hs
    JOIN swarm.hosted_mcp_seat_handles AS h ON h.seat_id = hs.seat_id
    JOIN swarm.agent_principals AS p ON p.principal_id = hs.principal_id
    WHERE hs.seat_id = ${String(seatId)}::uuid
  `;
}

test("010 catalog and empty inverse prove the exact live-name schema", async () => {
  const [forward] = await sql.unsafe<{ catalog_ok: boolean }[]>(reclaimCatalog());
  assert.equal(forward?.catalog_ok, true);
  const emptySchema = emptyApplicationSchema();
  const drill = new Error("D3_EMPTY_ROLLBACK");
  await sql.begin(async tx => {
    await tx.unsafe(emptySchema);
    await tx.unsafe(reclaimRollback());
    const [inverse] = await tx.unsafe<{ rollback_ok: boolean }[]>(reclaimRollbackCatalog());
    assert.equal(inverse?.rollback_ok, true);
    const [negative] = await tx.unsafe<{ catalog_ok: boolean }[]>(reclaimCatalog());
    assert.equal(negative?.catalog_ok, false);
    await tx.unsafe(reclaimMigration());
    const [restored] = await tx.unsafe<{ catalog_ok: boolean }[]>(reclaimCatalog());
    assert.equal(restored?.catalog_ok, true);
    throw drill;
  }).catch(error => { if (error !== drill) throw error; });
});

test("same-owner hosted reclaim makes fresh identities and preserves removed rows and history across grants", { timeout: 180_000 }, async () => {
  const fixture = await seedHostedFixture();
  const name = `reclaim-${randomUUID()}`;
  const old = claimSeat(fixture, fixture.grantA, name);
  const posted = runHostedHarness<HarnessResult>({ operation: "seat-command", seat: {
    grantId: fixture.grantA, workspaceId: fixture.workspaceA, handle: old.body.handle,
  } });
  assertAcceptedSeatNote(posted, old.body.principal_id);
  const oldSignals = await sql`
    SELECT * FROM swarm.signals WHERE from_principal = ${String(old.body.principal_id)}::uuid ORDER BY id
  `;
  assert.equal(oldSignals.length, 1, "real old-handle command authored a historical signal");
  const oldEvents = await sql`
    SELECT * FROM swarm.events
    WHERE workspace_id = ${fixture.workspaceA}::uuid
      AND payload->>'principal_id' = ${String(old.body.principal_id)} ORDER BY seq
  `;
  assert.equal(oldEvents.length, 1, "original claim event carries the old principal");
  await removeHostedSeat(fixture, fixture.grantA, old.body.seat_id);
  const oldRevoked = await hostedRows(old.body.seat_id);
  assert.equal(oldRevoked.length, 1);
  for (const field of ["seat", "principal", "handle"]) assert.ok(oldRevoked[0]![field].revoked_at);
  const sameGrant = claimSeat(fixture, fixture.grantA, name);
  const reused = claimSeat(fixture, fixture.grantA, name);
  for (const field of ["seat_id", "principal_id", "handle"]) assert.notEqual(reused.body[field], sameGrant.body[field]);
  assert.equal(reused.body.adjustment_reason, "collision", "fresh intent creates a separate suffixed identity");
  assert.equal((reused.body.event_ids as unknown[]).length, 1);
  for (const field of ["seat_id", "principal_id", "handle"]) assert.notEqual(sameGrant.body[field], old.body[field]);
  assert.deepEqual(await hostedRows(old.body.seat_id), oldRevoked, "reclaim never edits removed identity rows");
  const signalsAfter = await sql`
    SELECT * FROM swarm.signals WHERE from_principal = ${String(old.body.principal_id)}::uuid ORDER BY id
  `;
  assert.deepEqual(signalsAfter, oldSignals);
  const eventsAfter = await sql`
    SELECT * FROM swarm.events WHERE event_id = ${String(oldEvents[0]!.event_id)}::uuid
  `;
  assert.deepEqual(eventsAfter, oldEvents);
  const audits = await sql<{ outcome: string; reason: string; detail: string }[]>`
    SELECT outcome, reason, detail FROM swarm.audit_log
    WHERE workspace_id = ${fixture.workspaceA}::uuid AND command_kind = 'claim_hosted_seat'
      AND reason = 'hosted_seat_name_reclaimed' ORDER BY audit_id
  `;
  assert.deepEqual([...audits], [{ outcome: "accepted", reason: "hosted_seat_name_reclaimed",
    detail: `reclaimed=1; closed_seats=0; principal_ids=${old.body.principal_id}; closed_seat_ids=` }]);
  await removeHostedSeat(fixture, fixture.grantA, sameGrant.body.seat_id);
  const freshGrant = claimSeat(fixture, fixture.grantB, name);
  for (const field of ["seat_id", "principal_id", "handle"]) {
    assert.notEqual(freshGrant.body[field], old.body[field]);
    assert.notEqual(freshGrant.body[field], sameGrant.body[field]);
  }
  assert.deepEqual(await hostedRows(old.body.seat_id), oldRevoked);
  const sameRevoked = await hostedRows(sameGrant.body.seat_id);
  for (const field of ["seat", "principal", "handle"]) assert.ok(sameRevoked[0]![field].revoked_at);
  const [audit] = await sql<{ detail: string }[]>`
    SELECT detail FROM swarm.audit_log WHERE workspace_id = ${fixture.workspaceA}::uuid
      AND reason = 'hosted_seat_name_reclaimed' ORDER BY audit_id DESC LIMIT 1
  `;
  assert.equal(audit?.detail, `reclaimed=2; closed_seats=0; principal_ids=${[old.body.principal_id, sameGrant.body.principal_id].sort().join(",")}; closed_seat_ids=`);
  await assert.rejects(sql.begin(tx => tx.unsafe(reclaimRollback())),
    (error: unknown) => error instanceof postgres.PostgresError && error.code === "23505" &&
      error.constraint_name === "hosted_mcp_seats_grant_id_workspace_id_name_key",
    "historical same-grant duplicates prevent rollback without losing forward schema");
  const [catalog] = await sql.unsafe<{ catalog_ok: boolean }[]>(reclaimCatalog());
  assert.equal(catalog?.catalog_ok, true);
  assert.deepEqual(await hostedRows(old.body.seat_id), oldRevoked);
});

test("app-removed orphan is reclaimable at the hosted seat limit while new names are refused", { timeout: 180_000 }, async () => {
  const fixture = await seedHostedFixture();
  const name = `app-reclaim-${randomUUID()}`;
  const old = claimSeat(fixture, fixture.grantA, name);
  const unrelated = claimSeat(fixture, fixture.grantA, `unrelated-${randomUUID()}`);
  const unrelatedBefore = await hostedRows(unrelated.body.seat_id);
  const seats = [old, unrelated];
  while (seats.length < HOSTED_MCP_SEAT_LIMIT) {
    seats.push(claimSeat(fixture, fixture.grantA, `cap-fill-${randomUUID()}`));
  }
  const liveSeatIds = async () => {
    const rows = await sql<{ seat_id: string }[]>`
      SELECT seat_id FROM swarm.hosted_mcp_seats
      WHERE grant_id = ${fixture.grantA}::uuid AND revoked_at IS NULL
      ORDER BY seat_id
    `;
    return rows.map(row => row.seat_id);
  };
  const removed = runHostedHarness<HarnessResult>({ operation: "public", ownerJwt: fixture.ownerJwt,
    workspaceId: fixture.workspaceA,
    command: { kind: "revoke_agent_principal", principal_id: old.body.principal_id } });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(removed.body.status, "accepted");
  const orphan = await hostedRows(old.body.seat_id);
  assert.equal(orphan.length, 1);
  assert.ok(orphan[0]!.principal.revoked_at, "public removal revoked the principal");
  assert.equal(orphan[0]!.seat.revoked_at, null, "positive control: app removal left a live hosted seat");
  assert.equal(orphan[0]!.handle.revoked_at, null, "positive control: app removal left a live handle");
  const beforeSeatIds = await liveSeatIds();
  assert.equal(beforeSeatIds.length, HOSTED_MCP_SEAT_LIMIT, "the orphan still counts toward the grant's cap");
  assert.deepEqual(beforeSeatIds, seats.map(seat => String(seat.body.seat_id)).sort());

  const next = claimSeat(fixture, fixture.grantA, name);
  for (const field of ["seat_id", "principal_id", "handle"]) assert.notEqual(next.body[field], old.body[field]);
  const closed = await hostedRows(old.body.seat_id);
  assert.equal(closed.length, 1);
  assert.ok(closed[0]!.seat.revoked_at);
  assert.ok(closed[0]!.handle.revoked_at);
  assert.deepEqual(closed[0]!.principal, orphan[0]!.principal, "reclaim never edits the removed principal");
  const replacement = await hostedRows(next.body.seat_id);
  assert.equal(replacement.length, 1);
  for (const field of ["seat", "principal", "handle"]) assert.equal(replacement[0]![field].revoked_at, null);
  assert.equal(closed[0]!.seat.revoked_at, replacement[0]!.seat.created_at, "closure uses the claim's server time");
  assert.equal(closed[0]!.handle.revoked_at, replacement[0]!.seat.created_at);
  assert.deepEqual(await hostedRows(unrelated.body.seat_id), unrelatedBefore, "other principals' seats stay unchanged");
  const afterSeatIds = await liveSeatIds();
  assert.equal(afterSeatIds.length, HOSTED_MCP_SEAT_LIMIT, "reclaim replaces one live seat at the cap");
  assert.deepEqual(afterSeatIds, [...beforeSeatIds.filter(id => id !== old.body.seat_id), String(next.body.seat_id)].sort());
  const refused = runHostedHarness<HarnessResult>({ operation: "claim",
    claim: claimSpec(fixture, fixture.grantA, fixture.workspaceA, `new-at-cap-${randomUUID()}`) });
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.equal(refused.body.error, "hosted_seat_limit_reached", "a new name gets no reclaim discount");
  assert.deepEqual(await liveSeatIds(), afterSeatIds, "refused creation leaves the grant at the cap");
  const audits = await sql<{ outcome: string; detail: string }[]>`
    SELECT outcome, detail FROM swarm.audit_log
    WHERE workspace_id = ${fixture.workspaceA}::uuid AND command_kind = 'claim_hosted_seat'
      AND reason = 'hosted_seat_name_reclaimed' ORDER BY audit_id
  `;
  assert.deepEqual([...audits], [{ outcome: "accepted",
    detail: `reclaimed=1; closed_seats=1; principal_ids=${old.body.principal_id}; closed_seat_ids=${old.body.seat_id}` }]);
  const [catalog] = await sql.unsafe<{ catalog_ok: boolean }[]>(reclaimCatalog());
  assert.equal(catalog?.catalog_ok, true, "010 catalog still proves the live-name schema after app reclaim");
});

test("foreign-owner revoked name stays reserved while new chooses a separate suffix", { timeout: 120_000 }, async () => {
  const fixture = await seedHostedFixture(true);
  const name = `foreign-${randomUUID()}`;
  const old = claimSeat(fixture, fixture.grantA, name);
  await removeHostedSeat(fixture, fixture.grantA, old.body.seat_id);
  const refused = runHostedHarness<HarnessResult>({ operation: "claim", claim: {
    ...claimSpec(fixture, fixture.grantB, fixture.workspaceA, name), ownerUserId: fixture.other,
  } });
  assert.equal(refused.status, 200);
  assert.equal(refused.body.adjustment_reason, "collision");
  assert.notEqual(refused.body.name, name);
  claimSeat(fixture, fixture.grantA, name);
});

test("revoked grant cannot reclaim using a previously authenticated capability", { timeout: 120_000 }, async () => {
  const fixture = await seedHostedFixture();
  const name = `revoked-grant-${randomUUID()}`;
  const old = claimSeat(fixture, fixture.grantA, name);
  await removeHostedSeat(fixture, fixture.grantA, old.body.seat_id);
  const result = runHostedHarness<{ revoked: HarnessResult; refused: HarnessResult }>({
    operation: "revoked-grant-claim", claim: claimSpec(fixture, fixture.grantA, fixture.workspaceA, name),
  });
  assert.equal(result.revoked.status, 200);
  assert.equal(result.refused.status, 403);
  assert.equal(result.refused.body.error, "identity_resume_unavailable");
  claimSeat(fixture, fixture.grantB, name);
});

test("old hosted handle is refused and replacement handle authenticates", { timeout: 120_000 }, async () => {
  const fixture = await seedHostedFixture();
  const name = `handle-${randomUUID()}`;
  const old = claimSeat(fixture, fixture.grantA, name);
  await removeHostedSeat(fixture, fixture.grantA, old.body.seat_id);
  const next = claimSeat(fixture, fixture.grantA, name);
  const call = (handle: unknown) => runHostedHarness<HarnessResult>({ operation: "seat-command", seat: {
    grantId: fixture.grantA, workspaceId: fixture.workspaceA, handle,
  } });
  assert.equal(call(old.body.handle).status, 403);
  const accepted = call(next.body.handle);
  assertAcceptedSeatNote(accepted, next.body.principal_id);
});

test("concurrent fresh claims of a revoked name create distinct identities with one exact base address", { timeout: 180_000 }, async () => {
  const fixture = await seedHostedFixture();
  for (const competingGrantId of [fixture.grantA, fixture.grantB]) {
    const name = `concurrent-reclaim-${randomUUID()}`;
    const old = claimSeat(fixture, fixture.grantA, name);
    await removeHostedSeat(fixture, fixture.grantA, old.body.seat_id);
    const receipt = runHostedHarness<RaceReceipt>({ operation: "race", order: "concurrent",
      competitor: "hosted", competingGrantId,
      hosted: claimSpec(fixture, fixture.grantA, fixture.workspaceA, name),
    });
    assert.equal(receipt.blocked, 2, "transactions really overlap");
    assert.ok(receipt.elapsed < 30_000, "bounded completion");
    const results = receipt.results;
    assert.deepEqual(results.map(row => row.status), [200, 200]);
    assert.notEqual(results[0]!.body.seat_id, results[1]!.body.seat_id);
    assert.notEqual(results[0]!.body.name, results[1]!.body.name);
    const principals = await sql<{ principal_id: string; revoked_at: Date | null }[]>`
      SELECT principal_id, revoked_at FROM swarm.agent_principals
      WHERE workspace_id = ${fixture.workspaceA}::uuid AND name = ${name}
    `;
    assert.equal(principals.length, 2);
    const live = principals.filter(row => row.revoked_at === null);
    assert.equal(live.length, 1);
    assert.notEqual(live[0]!.principal_id, old.body.principal_id);
    const seats = await sql`SELECT seat_id FROM swarm.hosted_mcp_seats
      WHERE workspace_id = ${fixture.workspaceA}::uuid AND name = ${name} AND revoked_at IS NULL`;
    assert.equal(seats.length, 1);
    const audits = await sql`SELECT audit_id FROM swarm.audit_log
      WHERE workspace_id = ${fixture.workspaceA}::uuid AND reason = 'hosted_seat_name_reclaimed'
        AND detail = ${`reclaimed=1; closed_seats=0; principal_ids=${old.body.principal_id}; closed_seat_ids=`}`;
    assert.equal(audits.length, 1, "one reclaim audit per accepted creation");
  }
});

test("same-owner revoked local principal is reclaimable through the hosted command path", { timeout: 120_000 }, async () => {
  const fixture = await seedHostedFixture(true);
  const name = `local-reclaim-${randomUUID()}`;
  const created = runHostedHarness<HarnessResult>({ operation: "public", ownerJwt: fixture.ownerJwt,
    workspaceId: fixture.workspaceA, command: { kind: "create_agent_principal", name } });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.status, "accepted");
  const [localPrincipal] = await sql<{ principal_id: string; transport: string }[]>`
    SELECT principal_id, transport FROM swarm.agent_principals
    WHERE workspace_id = ${fixture.workspaceA}::uuid AND name = ${name}
  `;
  assert.equal(localPrincipal?.transport, "local");
  const revoked = runHostedHarness<HarnessResult>({ operation: "public", ownerJwt: fixture.ownerJwt,
    workspaceId: fixture.workspaceA,
    command: { kind: "revoke_agent_principal", principal_id: localPrincipal!.principal_id } });
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
  assert.equal(revoked.body.status, "accepted");
  const [before] = await sql`SELECT * FROM swarm.agent_principals WHERE principal_id = ${localPrincipal!.principal_id}::uuid`;
  assert.ok(before?.revoked_at);
  const next = claimSeat(fixture, fixture.grantA, name);
  assert.notEqual(next.body.principal_id, localPrincipal!.principal_id);
  const [after] = await sql`SELECT * FROM swarm.agent_principals WHERE principal_id = ${localPrincipal!.principal_id}::uuid`;
  assert.deepEqual(after, before);

  const foreignName = `foreign-local-${randomUUID()}`;
  const foreignCreated = runHostedHarness<HarnessResult>({ operation: "public", ownerJwt: fixture.otherJwt,
    workspaceId: fixture.workspaceA, command: { kind: "create_agent_principal", name: foreignName } });
  assert.equal(foreignCreated.status, 200, JSON.stringify(foreignCreated.body));
  assert.equal(foreignCreated.body.status, "accepted");
  const [foreignPrincipal] = await sql<{ principal_id: string; owner_user_id: string; transport: string }[]>`
    SELECT principal_id, owner_user_id, transport FROM swarm.agent_principals
    WHERE workspace_id = ${fixture.workspaceA}::uuid AND name = ${foreignName}
  `;
  assert.equal(foreignPrincipal?.owner_user_id, fixture.other);
  assert.equal(foreignPrincipal?.transport, "local");
  const foreignRevoked = runHostedHarness<HarnessResult>({ operation: "public", ownerJwt: fixture.otherJwt,
    workspaceId: fixture.workspaceA,
    command: { kind: "revoke_agent_principal", principal_id: foreignPrincipal!.principal_id } });
  assert.equal(foreignRevoked.status, 200, JSON.stringify(foreignRevoked.body));
  assert.equal(foreignRevoked.body.status, "accepted");
  const [foreignBefore] = await sql`SELECT * FROM swarm.agent_principals WHERE principal_id = ${foreignPrincipal!.principal_id}::uuid`;
  assert.ok(foreignBefore?.revoked_at);
  const refused = runHostedHarness<HarnessResult>({ operation: "claim",
    claim: claimSpec(fixture, fixture.grantA, fixture.workspaceA, foreignName) });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, "hosted_seat_name_taken");
  const [foreignAfter] = await sql`SELECT * FROM swarm.agent_principals WHERE principal_id = ${foreignPrincipal!.principal_id}::uuid`;
  assert.deepEqual(foreignAfter, foreignBefore);
  const audits = await sql<{ outcome: string; detail: string }[]>`
    SELECT outcome, detail FROM swarm.audit_log
    WHERE workspace_id = ${fixture.workspaceA}::uuid AND command_kind = 'claim_hosted_seat'
      AND reason = 'hosted_seat_name_reclaimed' ORDER BY audit_id
  `;
  assert.deepEqual([...audits], [{ outcome: "accepted",
    detail: `reclaimed=1; closed_seats=0; principal_ids=${localPrincipal!.principal_id}; closed_seat_ids=` }]);
});
