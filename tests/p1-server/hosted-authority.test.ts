/** HM lane-2 server coverage. Runs only in the manual `server` suite. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import postgres from "postgres";
import { HOSTED_MCP_SEAT_LIMIT } from "../../src/protocol/hosted-authority.js";
import { emptyApplicationSchema, localClusterAdminUrl, migrationNames as adminMigrationNames, repoSql, versions as adminVersions } from "../support/admin-schema-db.js";
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
let releaseSql: postgres.Sql;
let oauthSql: postgres.Sql;
let oauthDatabaseUrl: string;
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
  if (cap === null) return { status: 403, body: { error: "hosted_grant_forbidden" } };
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
  if (input.order === "concurrent") {
    return await Promise.all([claim(hostedSpec, firstCapability), runCompetitor()]);
  }
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

async function seatCommand(spec) {
  const cap = await db.begin(tx => authenticateHostedSeatCapability(tx, {
    grantId: spec.grantId,
    providerGrantId: "provider-" + spec.grantId,
    handle: spec.handle,
    tool: spec.tool ?? "note",
    providerStatus: async () => ({ active: true }),
  }, "command"));
  if (cap === null) return { status: 403, body: { error: "hosted_seat_forbidden" } };
  return await handleHostedCommand({
    command_id: crypto.randomUUID(), client_version: "0.1.80",
    workspace_id: spec.workspaceId, stream: { kind: "workspace" },
    command: spec.tool === "check" ? { kind: "open_hosted_mcp_check_batch", seat: spec.handle } : {
      kind: "post_signal", signal_kind: "note",
      body: "D3 historical identity", to_user_id: null, to_agent_principal_id: null,
      in_reply_to: null, about: null },
  }, cap);
}

async function seatRead(spec) {
  const cap = await db.begin(async tx => {
    await tx.unsafe("SET LOCAL ROLE swarm_read");
    return await authenticateHostedSeatCapability(tx, {
      grantId: spec.grantId, providerGrantId: "provider-" + spec.grantId,
      handle: spec.handle, tool: "whoami", providerStatus: async () => ({ active: true }),
    }, "read");
  });
  if (cap === null) return { status: 403, body: { error: "hosted_seat_forbidden" } };
  const readModule = await import(${JSON.stringify(readUrl.href)});
  return await readModule.handleHostedRead({ resource: "whoami", workspace_id: spec.workspaceId }, cap);
}

async function removalClaim() {
  const cap = await capability(input.claim.grantId, input.claim.ownerUserId, input.claim.workspaceId);
  const remove = () => publicCommand(input.ownerJwt, input.claim.workspaceId, {
    kind: "revoke_agent_principal", principal_id: input.principalId,
  });
  if (input.concurrent) {
    const [removed, claimed] = await Promise.all([remove(), claim(input.claim, cap)]);
    return { removed, claimed, refused: await claim({ ...input.claim, commandId: crypto.randomUUID() }, cap) };
  }
  const removed = await remove();
  return { removed, refused: await claim(input.claim, cap) };
}

async function revokedGrantClaim() {
  const cap = await capability(input.claim.grantId, input.claim.ownerUserId, input.claim.workspaceId);
  const revoked = await managementCommand(input.claim.ownerUserId, input.claim.workspaceId, {
    kind: "revoke_hosted_mcp_grant", grant_id: input.claim.grantId,
  });
  return { revoked, refused: await claim(input.claim, cap) };
}

// Exercise the actual MCP HTTP owner, including its final allowlist projections.
// Only the external JWKS is a fixture; JWT verification, binding, capabilities,
// database roles, canonical resolvers, command receipts and reads are real.
async function contextHttp() {
  authPhase = "hosted";
  const { MCP_ISSUER, MCP_RESOURCE, MCP_JWKS_URL } = await import(
    ${JSON.stringify(new URL("../../supabase/functions/mcp/auth.ts", import.meta.url).href)}
  );
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const key = { ...await crypto.subtle.exportKey("jwk", pair.publicKey), kid: "context-fixture", alg: "ES256", use: "sig" };
  const fetchBeforeMcp = globalThis.fetch;
  globalThis.fetch = async (request, init) => {
    const url = typeof request === "string" || request instanceof URL ? String(request) : request.url;
    return url === MCP_JWKS_URL ? new Response(JSON.stringify({ keys: [key] })) : await fetchBeforeMcp(request, init);
  };
  const mcp = await import(${JSON.stringify(new URL("../../supabase/functions/mcp/index.ts", import.meta.url).href)});
  const b64 = (value) => btoa(String.fromCharCode(...value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  const encode = (value) => b64(new TextEncoder().encode(JSON.stringify(value)));
  const now = Math.floor(Date.now() / 1000);
  const unsigned = encode({ alg: "ES256", kid: key.kid }) + "." + encode({
    iss: MCP_ISSUER, aud: MCP_RESOURCE, sub: input.ownerUserId,
    grant_id: "provider-" + input.grantId, scope: "mcp", iat: now, exp: now + 300,
  });
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(unsigned));
  const token = unsigned + "." + b64(new Uint8Array(signature));
  let storageWithdrawal = null;
  let storageBlocked = false;
  let storageArmed = false;
  let observer = null;
  if (input.storageRace) {
    const { default: postgres } = await import("postgres");
    observer = postgres(input.raceDatabaseUrl, { prepare: false, max: 1 });
    const fetchForStorage = globalThis.fetch;
    globalThis.fetch = async (request, init) => {
      const response = await fetchForStorage(request, init);
      const url = typeof request === "string" || request instanceof URL ? String(request) : request.url;
      if (storageArmed && !storageWithdrawal && url.includes('/storage/v1/object/')) {
        storageWithdrawal = managementCommand(input.ownerUserId, input.workspaceId,
          { kind:'household_withdraw_connection', principal_id:input.principalId });
        // The content operation holds its workspace lock during Storage I/O.
        // Observe the withdrawal on a DIFFERENT backend waiting for that lock;
        // returning the Storage response lets the content operation linearize.
        for (let attempt=0;attempt<400;attempt++) {
          const [wait] = await observer\x60SELECT EXISTS(SELECT 1 FROM pg_stat_activity
            WHERE usename='commonswarm_edge' AND wait_event_type='Lock'
              AND cardinality(pg_blocking_pids(pid))>0) AS blocked\x60;
          if(wait.blocked) { storageBlocked=true; break; }
          await new Promise(resolve=>setTimeout(resolve,25));
        }
        if(!storageBlocked) throw new Error('withdrawal did not reach a real Storage lock wait');
      }
      return response;
    };
  }
  if (input.dropCompatibilityGate) {
    const { default: postgres } = await import("postgres");
    observer = postgres(input.raceDatabaseUrl, { prepare: false, max: 1 });
  }
  let handle = input.handle;
  const results = [];
  for (const call of input.calls) {
    if (call.drop_compatibility_gate) await observer.unsafe('DROP POLICY hosted_owner_content_rollback_gate ON swarm.household_content_connections');
    if (call.transport === 'http') {
      authPhase = 'human';
      const read = call.name === 'todo_list' || call.name === 'todo_queue';
      const args = { seat: 'seat_0000000000000000000000', ...(call.arguments ?? {}) };
      const command = call.command ?? { kind: 'household_tool', tool: call.name, arguments: args };
      const module = read ? await import(${JSON.stringify(readUrl.href)}) : commandModule;
      const response = await module.handleRequest(new Request('http://local/functions/v1/' + (read ? 'read' : 'command'), {
        method: 'POST', headers: { authorization: 'Bearer ' + input.ownerJwt, 'content-type': 'application/json' },
        body: JSON.stringify(read ? { resource: 'household', workspace_id: input.workspaceId, tool: call.name, arguments: args }
          : { command_id: call.request_id ?? args.request_id ?? crypto.randomUUID(), client_version: '0.1.80', workspace_id: input.workspaceId,
            stream: { kind: 'workspace' }, command }),
      }));
      results.push({ name: call.name, status: response.status, body: await response.json(),
        isError: response.status !== 200, authChallenge: response.headers.has('www-authenticate'), retryAfter: response.headers.get('retry-after') });
      authPhase = 'hosted';
      continue;
    }
    if (call.storage_race) storageArmed = true;
    const args = call.name === "claim_seat"
      ? { name: input.name ?? "context-fixture-seat", request_id: call.request_id ?? crypto.randomUUID(), ...(call.workspace_id ? { workspace_id: call.workspace_id } : {}) }
      : { seat: call.seat ?? handle, ...(call.ack ? { ack: call.ack } : {}), ...(call.arguments ?? {}) };
    const response = await mcp.handleRequest(new Request(MCP_RESOURCE, {
      method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method: "tools/call", params: { name: call.name, arguments: args } }),
    }));
    const envelope = await response.json();
    const output = envelope.result?.content?.[0]?.text;
    const body = typeof output === "string" ? JSON.parse(output) : envelope;
    if (call.name === "claim_seat" && typeof body.handle === "string") handle = body.handle;
    results.push({ name: call.name, status: response.status, isError: envelope.result?.isError === true || envelope.error !== undefined || response.status !== 200, body,
      authChallenge: response.headers.has("www-authenticate") || envelope.result?._meta?.["mcp/www_authenticate"] !== undefined });
    if (call.storage_race) {
      if (!storageBlocked || !storageWithdrawal) throw new Error('Storage was not reached');
      const withdrawn = await storageWithdrawal;
      if(withdrawn.body.status!=='committed') throw new Error('concurrent withdrawal failed');
    }
  }
  await observer?.end({timeout:2});
  globalThis.fetch = fetchBeforeMcp;
  authPhase = "neutral";
  return results;
}

let result;
if (input.operation === "context-http") result = await contextHttp();
else if (input.operation === "seat-read") result = await seatRead(input.seat);
else if (input.operation === "removal-claim") result = await removalClaim();
else if (input.operation === "seat-command") result = await seatCommand(input.seat);
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
  releaseSql = postgres(localClusterAdminUrl(local.DB_URL), { prepare: false, max: 1 });
  // Use the existing OAuth service login, as in oauth-mcp-contract.test.js.
  // The edge/admin login intentionally has no runtime SET ROLE authority.
  const runtimeTarget = new URL(local.DB_URL);
  runtimeTarget.username = "commonswarm_oauth_runtime";
  runtimeTarget.password = randomBytes(32).toString("hex");
  await releaseSql.unsafe(`ALTER ROLE commonswarm_oauth_runtime PASSWORD '${runtimeTarget.password}'`);
  oauthDatabaseUrl = runtimeTarget.href;
  oauthSql = postgres(oauthDatabaseUrl, { prepare: false, max: 1 });
  const [runtimeIdentity] = await oauthSql<{ role: string; safe: boolean }[]>`
    SELECT current_user AS role, NOT rolsuper AND NOT rolbypassrls AS safe
    FROM pg_roles WHERE rolname = current_user`;
  assert.equal(runtimeIdentity?.role, "commonswarm_oauth_runtime");
  assert.equal(runtimeIdentity?.safe, true);
  admin = createClient(local.API_URL, local.SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  harnessDir = mkdtempSync(join(tmpdir(), "hm-hosted-authority-"));
  harnessPath = join(harnessDir, "command-harness.ts");
  writeFileSync(harnessPath, harnessSource);
});

after(async () => {
  await sql.end();
  await oauthSql?.end();
  await releaseSql.unsafe("ALTER ROLE commonswarm_oauth_runtime PASSWORD NULL");
  await releaseSql.end();
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

function hostedHarnessLaunch(options: {databaseUrl?: string; rollbackBeforeStep?: number}) {
  return { args: [
    "run",
    "--no-lock",
    "--config",
    "supabase/functions/command/deno.json",
    "--allow-env",
    "--allow-net",
    "--allow-read",
    harnessPath,
  ], options: {
    cwd: process.cwd(),
    encoding: "utf8" as const,
    env: {
      PATH: process.env.PATH ?? "",
      ...(process.env.DENO_DIR ? { DENO_DIR: process.env.DENO_DIR } : {}),
      SWARM_ENV: "test",
      SWARM_MCP_PUBLIC_ENABLED: "1",
      SWARM_DATABASE_URL: options.databaseUrl ?? local.DB_URL,
      SUPABASE_DB_URL: options.databaseUrl ?? local.DB_URL,
      ...(options.rollbackBeforeStep ? { SWARM_CMD_TEST_ROLLBACK_BEFORE_STEP: String(options.rollbackBeforeStep) } : {}),
      SUPABASE_URL: local.API_URL,
      SUPABASE_ANON_KEY: local.ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY: local.SERVICE_ROLE_KEY,
    },
    timeout: 90_000,
  } };
}

function runHostedHarness<T>(input: Record<string, unknown>, options: {
  databaseUrl?: string; rollbackBeforeStep?: number;
} = {}): T {
  const config = hostedHarnessLaunch(options);
  const result = spawnSync("deno", config.args, {...config.options, input:JSON.stringify(input)});
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


function runHostedHarnessAsync<T>(input: Record<string, unknown>, databaseUrl: string): Promise<T> {
  const options = { databaseUrl };
  const config = hostedHarnessLaunch(options);
  return new Promise((resolve, reject) => {
    const child = spawn("deno", config.args, { ...config.options, stdio: ['pipe','pipe','pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      try {
        assert.equal(code, 0, stderr);
        const line = stdout.trim().split('\n').reverse().find(row => row.startsWith('HM_RESULT:'));
        assert.ok(line, 'real HTTP harness returned its result');
        resolve(JSON.parse(line.slice('HM_RESULT:'.length)) as T);
      } catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify(input));
  });
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
  // The box replays release SQL as supabase_admin; receipt probes retain postgres.
  await releaseSql.begin(async (tx) => {
    // M1 adds a real FK to hosted grants. Reverse newer, data-free schema first
    // in an empty DDL snapshot; retain every original grant/artifact/receipt.
    await tx.unsafe(emptySchema);
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
    await tx.unsafe("SET LOCAL ROLE postgres");
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
    await tx.unsafe("RESET ROLE");
    for (const { rollback } of [...migrations].reverse()) {
      await tx.unsafe(rollback);
    }
    const [rolledBack] = await tx.unsafe<{ rollback_ok: boolean }[]>(rollbackCatalogQuery);
    assert.equal(rolledBack?.rollback_ok, true, "rollback catalog accepts exactly the retained kinds");
    await tx.unsafe("SET LOCAL ROLE postgres");
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
    await tx.unsafe("RESET ROLE");
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
  await releaseSql.begin(async tx => {
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
  for (const field of ["seat_id", "principal_id", "handle"]) assert.equal(reused.body[field], sameGrant.body[field]);
  assert.deepEqual(reused.body.event_ids, [], "live replacement reuses despite revoked same-name history");
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

test("historical orphan is reclaimable at the hosted seat limit while new names are refused", { timeout: 180_000 }, async () => {
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
  // Historical pre-fix state remains recoverable after fresh owner consent.
  // New accepted removals are covered below and must never leave this orphan.
  await sql`UPDATE swarm.agent_principals SET revoked_at = statement_timestamp()
    WHERE principal_id = ${String(old.body.principal_id)}::uuid`;
  const orphan = await hostedRows(old.body.seat_id);
  assert.equal(orphan.length, 1);
  assert.ok(orphan[0]!.principal.revoked_at, "historical fixture has a removed principal");
  assert.equal(orphan[0]!.seat.revoked_at, null, "historical fixture retains a live hosted seat");
  assert.equal(orphan[0]!.handle.revoked_at, null, "historical fixture retains a live handle");
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

// The production provider's refresh findAccount uses this status function;
// the service login proves the same persistent fence without issuing a bearer.
async function providerActive(grantId: string): Promise<boolean> {
  return await oauthSql.begin(async tx => {
    const [row] = await tx<{ active: boolean }[]>`
      SELECT active FROM commonswarm_oauth.resolve_hosted_grant_status(${`provider-${grantId}`})`;
    return row?.active === true;
  });
}

// Drive the production refresh admission and persisted provider adapter,
// using the service dependencies installed by the server suite.
async function providerRefresh(fixture: HostedFixture, options: {
  afterAdmission?: () => Promise<void>; pending?: boolean;
} = {}): Promise<boolean> {
  const requireService = createRequire(new URL("../../services/mcp-auth/package.json", import.meta.url));
  const { Pool } = requireService("pg");
  const pool = new Pool({ connectionString: oauthDatabaseUrl, max: 1 });
  try {
    const { createProductionFindAccount } = await import(new URL(
      "../../services/mcp-auth/src/server.js", import.meta.url).href);
    const { createPostgresAdapter } = await import(new URL(
      "../../services/mcp-auth/src/postgres-adapter.js", import.meta.url).href);
    const grantId = `provider-${fixture.grantA}`;
    const account = await createProductionFindAccount(pool)(
      { oidc: { params: { grant_type: "refresh_token" } } }, fixture.owner, { grantId });
    const refresh = createPostgresAdapter(pool)("RefreshToken");
    const tokenId = randomUUID();
    const write = () => refresh.upsert(tokenId, {
      grantId, accountId: fixture.owner, clientId: "test-client",
      resource: ["https://mcp.commonswarm.com/mcp"],
    }, 3600);
    if (!account) {
      if (options.pending) await write();
      else await assert.rejects(write, { error: "invalid_grant" }, "retired family cannot mint a successor");
      return false;
    }
    await options.afterAdmission?.();
    await write();
    assert.ok(await refresh.find(tokenId), "live provider family persists a refresh successor");
    return true;
  } finally { await pool.end(); }
}

function seatSpec(fixture: HostedFixture, seat: HarnessResult, workspaceId = fixture.workspaceA, grantId = fixture.grantA) {
  return { grantId, workspaceId, handle: seat.body.handle };
}

async function assertSeatAccess(fixture: HostedFixture, seat: HarnessResult, workspaceId: string, status: number, grantId = fixture.grantA) {
  for (const tool of ["whoami", "note", "check"]) {
    const operation = tool === "whoami" ? "seat-read" : "seat-command";
    const result = runHostedHarness<HarnessResult>({ operation,
      seat: { ...seatSpec(fixture, seat, workspaceId, grantId), tool } });
    assert.equal(result.status, status, `${tool}: ${JSON.stringify(result.body)}`);
  }
}

for (const otherConsent of ["live", "revoked", "archived", "membership-removed"] as const) {
  test(`accepted hosted principal removal closes workspace access with ${otherConsent} other consent`, { timeout: 180_000 }, async () => {
    const fixture = await seedHostedFixture();
    const name = `removed-${randomUUID()}`;
    const old = claimSeat(fixture, fixture.grantA, name);
    const unrelated = runHostedHarness<HarnessResult>({ operation: "claim",
      claim: claimSpec(fixture, fixture.grantA, fixture.workspaceB, `other-${randomUUID()}`) });
    assert.equal(unrelated.status, 200);
    await assertSeatAccess(fixture, old, fixture.workspaceA, 200);
    await assertSeatAccess(fixture, unrelated, fixture.workspaceB, 200);
    assert.equal(await providerActive(fixture.grantA), true, "positive status control");
    assert.equal(await providerRefresh(fixture), true, "positive production refresh control");
    if (otherConsent === "revoked") {
      await sql`UPDATE swarm.hosted_mcp_grant_workspaces SET revoked_at = statement_timestamp()
        WHERE grant_id = ${fixture.grantA}::uuid AND workspace_id = ${fixture.workspaceB}::uuid`;
    } else if (otherConsent === "archived") {
      await sql`UPDATE swarm.workspaces SET archived_at = statement_timestamp()
        WHERE workspace_id = ${fixture.workspaceB}::uuid`;
    } else if (otherConsent === "membership-removed") {
      await sql`UPDATE swarm.memberships SET revoked_at = statement_timestamp()
        WHERE user_id = ${fixture.owner}::uuid AND workspace_id = ${fixture.workspaceB}::uuid`;
    }
    const otherRows = await hostedRows(unrelated.body.seat_id);
    const outcome = runHostedHarness<{ removed: HarnessResult; refused: HarnessResult }>({
      operation: "removal-claim", ownerJwt: fixture.ownerJwt, principalId: old.body.principal_id,
      claim: claimSpec(fixture, fixture.grantA, fixture.workspaceA, name),
    });
    assert.equal(outcome.removed.status, 200, JSON.stringify(outcome.removed.body));
    assert.equal(outcome.removed.body.status, "accepted");
    assert.equal(outcome.refused.status, 403, "pre-removal capability cannot reclaim");
    const rows = await hostedRows(old.body.seat_id);
    for (const field of ["seat", "principal", "handle"]) assert.ok(rows[0]![field].revoked_at);
    await assertSeatAccess(fixture, old, fixture.workspaceA, 403);
    for (const claimName of [name, `new-${randomUUID()}`]) {
      const result = runHostedHarness<HarnessResult>({ operation: "claim",
        claim: claimSpec(fixture, fixture.grantA, fixture.workspaceA, claimName) });
      assert.equal(result.status, 403, "fresh provider authorization cannot restore this workspace");
    }
    const [consent] = await sql<{ revoked: boolean }[]>`
      SELECT revoked_at IS NOT NULL AS revoked FROM swarm.hosted_mcp_grant_workspaces
      WHERE grant_id = ${fixture.grantA}::uuid AND workspace_id = ${fixture.workspaceA}::uuid`;
    assert.equal(consent?.revoked, true);
    const tombstones = await sql<{ kind: string }[]>`SELECT kind FROM swarm.revocation_tombstones
      WHERE (kind = 'hosted_seat' AND target_id = ${String(old.body.seat_id)}::uuid)
        OR (kind = 'principal' AND target_id = ${String(old.body.principal_id)}::uuid) ORDER BY kind`;
    assert.deepEqual(tombstones.map(row => row.kind), ["hosted_seat", "principal"]);
    assert.deepEqual(await hostedRows(unrelated.body.seat_id), otherRows, "other identity history is unchanged");
    // Edge has committed; OAuth retirement has deliberately not run yet.
    const beforeRetirement = await sql`SELECT 1 FROM commonswarm_oauth.refresh_family_tombstones
      WHERE grant_id = ${`provider-${fixture.grantA}`}`;
    assert.equal(beforeRetirement.length, 0, "edge never retires provider families");
    const artifactsBeforeRefresh = await sql`SELECT 1 FROM commonswarm_oauth.provider_artifacts
      WHERE grant_id = ${`provider-${fixture.grantA}`}`;
    assert.ok(artifactsBeforeRefresh.length > 0, "pre-removal refresh artifacts remain until OAuth retirement");
    assert.equal(await providerActive(fixture.grantB), true, "independent family survives intermediate state");
    const control = claimSeat(fixture, fixture.grantB, `control-${randomUUID()}`);
    await assertSeatAccess(fixture, control, fixture.workspaceA, 200, fixture.grantB);
    assert.equal(await providerActive(fixture.grantA), otherConsent === "live");
    assert.equal(await providerRefresh(fixture), otherConsent === "live");
    // Even successful refresh in a surviving workspace cannot regain A.
    const afterRefresh = runHostedHarness<HarnessResult>({ operation: "claim",
      claim: claimSpec(fixture, fixture.grantA, fixture.workspaceA, `refresh-${randomUUID()}`) });
    assert.equal(afterRefresh.status, 403);
    const [grant] = await sql<{ state: string }[]>`SELECT state FROM swarm.hosted_mcp_grants
      WHERE grant_id = ${fixture.grantA}::uuid`;
    assert.equal(grant?.state, "active", "OAuth retirement does not rewrite authority grants");
    const families = await sql`SELECT 1 FROM commonswarm_oauth.refresh_family_tombstones
      WHERE grant_id = ${`provider-${fixture.grantA}`}`;
    assert.equal(families.length, otherConsent === "live" ? 0 : 1);
    if (otherConsent !== "live") {
      const artifacts = await sql`SELECT 1 FROM commonswarm_oauth.provider_artifacts
        WHERE grant_id = ${`provider-${fixture.grantA}`}`;
      assert.equal(artifacts.length, 0, "OAuth refresh physically retires this family");
    }
    assert.equal(await providerActive(fixture.grantB), true, "independent grant/family survives");
    if (otherConsent === "live") {
      await assertSeatAccess(fixture, unrelated, fixture.workspaceB, 200);
      const claimed = runHostedHarness<HarnessResult>({ operation: "claim",
        claim: claimSpec(fixture, fixture.grantA, fixture.workspaceB, `still-live-${randomUUID()}`) });
      assert.equal(claimed.status, 200);
    }
    // A fresh owner-approved grant can reuse the name; removal history stays.
    const replacement = claimSeat(fixture, fixture.grantB, name);
    assert.notEqual(replacement.body.principal_id, old.body.principal_id);
    assert.deepEqual(await hostedRows(old.body.seat_id), rows);
  });
}

test("accepted removal fences concurrent same-name and new-name claims", { timeout: 180_000 }, async () => {
  for (const sameName of [true, false]) {
    const fixture = await seedHostedFixture();
    const name = `remove-race-${randomUUID()}`;
    const old = claimSeat(fixture, fixture.grantA, name);
    const result = runHostedHarness<{ removed: HarnessResult; claimed: HarnessResult; refused: HarnessResult }>({
      operation: "removal-claim", concurrent: true, ownerJwt: fixture.ownerJwt,
      principalId: old.body.principal_id,
      claim: claimSpec(fixture, fixture.grantA, fixture.workspaceA, sameName ? name : `race-new-${randomUUID()}`),
    });
    assert.equal(result.removed.status, 200, JSON.stringify(result.removed.body));
    assert.ok([200, 403].includes(result.claimed.status), JSON.stringify(result.claimed));
    assert.equal(result.refused.status, 403, "no cached capability survives committed removal");
    if (result.claimed.status === 200) await assertSeatAccess(fixture, result.claimed, fixture.workspaceA, 403);
  }
});

test("refresh admitted before removal cannot restore access when its successor is written afterward", { timeout: 120_000 }, async () => {
  const fixture = await seedHostedFixture();
  const name = `refresh-race-${randomUUID()}`;
  const old = claimSeat(fixture, fixture.grantA, name);
  await sql`UPDATE swarm.hosted_mcp_grant_workspaces SET revoked_at = statement_timestamp()
    WHERE grant_id = ${fixture.grantA}::uuid AND workspace_id = ${fixture.workspaceB}::uuid`;
  assert.equal(await providerRefresh(fixture, { afterAdmission: async () => {
    const removed = runHostedHarness<HarnessResult>({ operation: "public", ownerJwt: fixture.ownerJwt,
      workspaceId: fixture.workspaceA,
      command: { kind: "revoke_agent_principal", principal_id: old.body.principal_id } });
    assert.equal(removed.body.status, "accepted");
  } }), true, "in-flight adapter write can complete before OAuth retirement");
  await assertSeatAccess(fixture, old, fixture.workspaceA, 403);
  const refused = runHostedHarness<HarnessResult>({ operation: "claim",
    claim: claimSpec(fixture, fixture.grantA, fixture.workspaceA, name) });
  assert.equal(refused.status, 403, "current consent gate denies the raced successor");
  assert.equal(await providerRefresh(fixture), false, "next refresh retires the family");
  assert.equal(await providerActive(fixture.grantB), true);
});

test("pending partial consent cannot retire a provider family before activation", { timeout: 120_000 }, async () => {
  const fixture = await seedHostedFixture();
  await sql`UPDATE swarm.hosted_mcp_grants SET state = 'pending', activated_at = NULL
    WHERE grant_id = ${fixture.grantA}::uuid`;
  assert.equal(await providerRefresh(fixture, { pending: true }), false);
  const families = await sql`SELECT 1 FROM commonswarm_oauth.refresh_family_tombstones
    WHERE grant_id = ${`provider-${fixture.grantA}`}`;
  assert.equal(families.length, 0, "partial consent never installs a permanent family fence");
  await sql`UPDATE swarm.hosted_mcp_grants SET state = 'active', activated_at = statement_timestamp()
    WHERE grant_id = ${fixture.grantA}::uuid`;
  assert.equal(await providerRefresh(fixture), true, "activation retains a usable provider family");
});

test("failed authority projection rolls back principal, hosted identity and consent", { timeout: 120_000 }, async () => {
  const fixture = await seedHostedFixture();
  const old = claimSeat(fixture, fixture.grantA, `rollback-${randomUUID()}`);
  const before = await hostedRows(old.body.seat_id);
  const beforeEvents = await sql`SELECT event_id FROM swarm.events
    WHERE workspace_id = ${fixture.workspaceA}::uuid ORDER BY seq`;
  const input = { operation: "public", ownerJwt: fixture.ownerJwt, workspaceId: fixture.workspaceA,
    command: { kind: "revoke_agent_principal", principal_id: old.body.principal_id } };
  // Existing hook fires after the real authority projection, before commit.
  const result = runHostedHarness<HarnessResult>(input, { rollbackBeforeStep: 13 });
  assert.equal(result.status, 500, JSON.stringify(result.body));
  assert.deepEqual(await hostedRows(old.body.seat_id), before);
  const [consent] = await sql<{ revoked_at: Date | null }[]>`SELECT revoked_at
    FROM swarm.hosted_mcp_grant_workspaces WHERE grant_id = ${fixture.grantA}::uuid
      AND workspace_id = ${fixture.workspaceA}::uuid`;
  assert.equal(consent?.revoked_at, null);
  assert.deepEqual(await sql`SELECT event_id FROM swarm.events
    WHERE workspace_id = ${fixture.workspaceA}::uuid ORDER BY seq`, beforeEvents);
  const tombstones = await sql`SELECT kind FROM swarm.revocation_tombstones
    WHERE target_id IN (${String(old.body.principal_id)}::uuid, ${String(old.body.seat_id)}::uuid)`;
  assert.equal(tombstones.length, 0);
  await assertSeatAccess(fixture, old, fixture.workspaceA, 200);
  const retry = runHostedHarness<HarnessResult>(input);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.status, "accepted");
  await assertSeatAccess(fixture, old, fixture.workspaceA, 403);
});

test("production edge login removes hosted principal with command role only", { timeout: 120_000 }, async () => {
  const fixture = await seedHostedFixture();
  const old = claimSeat(fixture, fixture.grantA, `edge-role-${randomUUID()}`);
  await sql`UPDATE swarm.hosted_mcp_grant_workspaces SET revoked_at = statement_timestamp()
    WHERE grant_id = ${fixture.grantA}::uuid AND workspace_id = ${fixture.workspaceB}::uuid`;
  const role = `hm_edge_${randomBytes(8).toString("hex")}`;
  const password = randomBytes(32).toString("hex");
  const edgeUrl = new URL(local.DB_URL);
  edgeUrl.username = role;
  edgeUrl.password = password;
  await releaseSql.unsafe(`CREATE ROLE ${role} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '${password}'`);
  try {
    await releaseSql.unsafe(`GRANT swarm_command TO ${role}`);
    const edge = postgres(edgeUrl.href, { prepare: false, max: 1 });
    try {
      const [identity] = await edge<{ safe: boolean }[]>`SELECT NOT rolsuper AND NOT rolbypassrls AS safe
        FROM pg_roles WHERE rolname = current_user`;
      assert.equal(identity?.safe, true);
      await edge.begin(async tx => { await tx.unsafe("SET LOCAL ROLE swarm_command"); });
      await assert.rejects(edge.begin(async tx => { await tx.unsafe("SET LOCAL ROLE commonswarm_oauth_runtime"); }),
        { code: "42501" }, "edge has no OAuth SET authority");
    } finally { await edge.end(); }
    const removed = runHostedHarness<HarnessResult>({ operation: "public", ownerJwt: fixture.ownerJwt,
      workspaceId: fixture.workspaceA,
      command: { kind: "revoke_agent_principal", principal_id: old.body.principal_id } },
      { databaseUrl: edgeUrl.href });
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.equal(removed.body.status, "accepted");
    await assertSeatAccess(fixture, old, fixture.workspaceA, 403);
    const families = await sql`SELECT 1 FROM commonswarm_oauth.refresh_family_tombstones
      WHERE grant_id = ${`provider-${fixture.grantA}`}`;
    assert.equal(families.length, 0);
  } finally { await releaseSql.unsafe(`DROP ROLE ${role}`); }
});

test("foreign-owner revoked name is refused with a same-owner positive control", { timeout: 120_000 }, async () => {
  const fixture = await seedHostedFixture(true);
  const name = `foreign-${randomUUID()}`;
  const old = claimSeat(fixture, fixture.grantA, name);
  await removeHostedSeat(fixture, fixture.grantA, old.body.seat_id);
  const refused = runHostedHarness<HarnessResult>({ operation: "claim", claim: {
    ...claimSpec(fixture, fixture.grantB, fixture.workspaceA, name), ownerUserId: fixture.other,
  } });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, "hosted_seat_name_taken");
  assert.equal(refused.body.message, "That name is taken in this workspace; choose another.");
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
  assert.equal(result.refused.body.error, "forbidden");
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

test("concurrent claims of a revoked name yield exactly one new live identity", { timeout: 180_000 }, async () => {
  const fixture = await seedHostedFixture();
  for (const competingGrantId of [fixture.grantA, fixture.grantB]) {
    const name = `concurrent-reclaim-${randomUUID()}`;
    const old = claimSeat(fixture, fixture.grantA, name);
    await removeHostedSeat(fixture, fixture.grantA, old.body.seat_id);
    const results = runHostedHarness<HarnessResult[]>({ operation: "race", order: "concurrent",
      competitor: "hosted", competingGrantId,
      hosted: claimSpec(fixture, fixture.grantA, fixture.workspaceA, name),
    });
    if (competingGrantId === fixture.grantA) {
      assert.deepEqual(results.map(row => row.status), [200, 200]);
      assert.equal(results[0]!.body.seat_id, results[1]!.body.seat_id);
    } else {
      assert.deepEqual(results.map(row => row.status).sort(), [200, 409]);
      assert.equal(results.find(row => row.status === 409)?.body.error, "hosted_seat_name_taken");
    }
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


interface ContextHttpResult extends HarnessResult {
  name: string;
  isError: boolean;
  authChallenge?: boolean;
  retryAfter?: string | null;
}
interface ConnectionContext {
  account: { user_id: string; display_name: string; email: string | null };
  workspace: { workspace_id: string; name: string };
  connection: { grant_id: string; home_workspace_id: string | null;
    reachable_workspaces: Array<{ workspace_id: string; name: string }> };
  summary: string;
}
function contextHttp(fixture: HostedFixture, options: {
  grantId?: string; ownerUserId?: string; handle?: string; calls?: Array<Record<string, unknown>>;
  name?: string;
} = {}): ContextHttpResult[] {
  return runHostedHarness<ContextHttpResult[]>({ operation: "context-http",
    grantId: options.grantId ?? fixture.grantA, ownerUserId: options.ownerUserId ?? fixture.owner,
    handle: options.handle, name: options.name,
    calls: options.calls ?? ["claim_seat", "whoami", "members", "check"].map(name => ({ name })),
  });
}
async function contextFixture(): Promise<HostedFixture> {
  const fixture = await seedHostedFixture(true);
  await sql`UPDATE swarm.users SET email = CASE WHEN user_id = ${fixture.owner}::uuid
    THEN 'context-owner@example.test' ELSE 'context-other@example.test' END
    WHERE user_id IN (${fixture.owner}::uuid, ${fixture.other}::uuid)`;
  return fixture;
}
function assertContext(result: ContextHttpResult, fixture: HostedFixture, reachable = [fixture.workspaceA, fixture.workspaceB], other = false, current = fixture.workspaceA, home: string | null = fixture.workspaceA,
  expected: { displayName?: string; email?: string | null; workspaceAName?: string } = {}): ConnectionContext {
  assert.equal(result.status, 200, result.name);
  assert.equal(result.isError, false, JSON.stringify(result.body));
  const context = result.body.context as ConnectionContext;
  assert.ok(context, result.name + " retains context through the actual MCP projection");
  assert.deepEqual(context.account, { user_id: other ? fixture.other : fixture.owner,
    display_name: expected.displayName ?? (other ? "HM other" : "HM owner"),
    email: expected.email === undefined ? (other ? "context-other@example.test" : "context-owner@example.test") : expected.email });
  assert.deepEqual(context.workspace, { workspace_id: current, name: current === fixture.workspaceA ? expected.workspaceAName ?? "HM A" : "HM B" });
  assert.equal(context.connection.grant_id, other ? fixture.grantB : fixture.grantA);
  assert.equal(context.connection.home_workspace_id, home);
  assert.deepEqual(context.connection.reachable_workspaces,
    [...reachable].sort().map(workspace_id => ({ workspace_id, name: workspace_id === fixture.workspaceA ? expected.workspaceAName ?? "HM A" : "HM B" })));
  if (expected.displayName === undefined) assert.ok(context.summary.includes(context.account.display_name));
  if (context.account.email !== null) assert.ok(context.summary.includes(context.account.email));
  else assert.ok(!/null|undefined/u.test(context.summary), "missing email is not invented in summary");
  if (expected.workspaceAName === undefined) assert.ok(context.summary.includes(context.workspace.name));
  assert.ok(!/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(context.summary), "summary stays on one line");
  return context;
}

// Authoring gate: protects the public four-tool output through the real HTTP
// owner. It catches backend-only enrichment dropped by MCP projections. Existing
// protocol tests replace executeTool and cannot cover that regression.
test("hosted context explains all four HTTP tools, default claim, replay and two accounts without listing unconsented memberships", { timeout: 180_000 }, async () => {
  const fixture = await contextFixture();
  const unconsented = randomUUID();
  await sql`INSERT INTO swarm.workspaces(workspace_id, name, created_by)
    VALUES (${unconsented}::uuid, 'Private unconsented workspace', ${fixture.owner}::uuid)`;
  await sql`INSERT INTO swarm.memberships(workspace_id, user_id, role)
    VALUES (${unconsented}::uuid, ${fixture.owner}::uuid, 'owner')`;
  const requestId = randomUUID();
  const calls = [{ name: "claim_seat", request_id: requestId }, { name: "whoami" },
    { name: "members" }, { name: "check" }, { name: "claim_seat", request_id: requestId }];
  // A claim starts without human claims. Its real seat INSERT must retain that
  // ambient authorization context after the response-context resolver returns.
  const probe = "context_claim_" + randomUUID().replaceAll("-", "");
  await sql.unsafe(`CREATE FUNCTION swarm.${probe}() RETURNS trigger LANGUAGE plpgsql AS $probe$
    BEGIN
      IF NEW.grant_id = '${fixture.grantA}'::uuid
        AND nullif(current_setting('request.jwt.claims', true), '') IS NOT NULL THEN
        RAISE EXCEPTION 'claim write inherited response context claims' USING ERRCODE='ZX001';
      END IF;
      RETURN NEW;
    END $probe$;
    CREATE TRIGGER ${probe} BEFORE INSERT ON swarm.hosted_mcp_seats
      FOR EACH ROW EXECUTE FUNCTION swarm.${probe}();`);
  let ownerResults: ContextHttpResult[];
  try {
    ownerResults = contextHttp(fixture, { calls });
  } finally {
    await sql.unsafe(`DROP TRIGGER ${probe} ON swarm.hosted_mcp_seats; DROP FUNCTION swarm.${probe}();`);
  }
  const contexts = ownerResults.map(row => assertContext(row, fixture));
  for (const context of contexts) assert.deepEqual(context, contexts[0]);
  assert.equal(ownerResults[0]!.body.handle, ownerResults[4]!.body.handle, "same request receipt replays");
  const roster = ownerResults.find(row => row.name === "members")!.body;
  for (const member of roster.members as Array<Record<string, unknown>>) assert.equal(Object.hasOwn(member, "email"), false);
  const workspaceB = contextHttp(fixture, { calls: [{ name: "claim_seat", workspace_id: fixture.workspaceB },
    { name: "whoami" }, { name: "members" }, { name: "check" }] });
  workspaceB.forEach(row => assertContext(row, fixture, undefined, false, fixture.workspaceB));
  const otherResults = contextHttp(fixture, { grantId: fixture.grantB, ownerUserId: fixture.other, name: "other-context-seat" });
  otherResults.forEach(row => assertContext(row, fixture, undefined, true));
  const foreignOwner = contextHttp(fixture, { ownerUserId: fixture.other,
    handle: String(ownerResults[0]!.body.handle), calls: ["claim_seat", "whoami", "members", "check"].map(name => ({ name })) });
  for (const row of foreignOwner) {
    assert.equal(row.isError, true, row.name + " verified subject must own the stored grant");
    assert.equal(row.body.context, undefined);
    assert.equal(JSON.stringify(row.body).includes("context-owner@example.test"), false);
  }
  const crossed = contextHttp(fixture, { handle: String(otherResults[0]!.body.handle),
    calls: ["whoami", "members", "check"].map(name => ({ name })) });
  for (const row of crossed) {
    assert.equal(row.isError, true, row.name);
    assert.equal(row.body.context, undefined);
    assert.equal(JSON.stringify(row.body).includes("context-other@example.test"), false);
  }
  await sql`UPDATE swarm.hosted_mcp_grant_workspaces SET revoked_at = statement_timestamp()
    WHERE grant_id = ${fixture.grantA}::uuid AND workspace_id = ${fixture.workspaceA}::uuid`;
  const survivingWorkspace = contextHttp(fixture, { handle: String(workspaceB[0]!.body.handle),
    calls: ["whoami", "members", "check"].map(name => ({ name })) });
  survivingWorkspace.forEach(row => assertContext(row, fixture, [fixture.workspaceB], false, fixture.workspaceB, null));
});

// Real stored null email and hostile durable names exercise the SQL formatter
// and every MCP projection together; clean fixtures cannot detect this defect.
test("hosted context HTTP preserves null email and keeps hostile names on one summary line", { timeout: 180_000 }, async () => {
  const fixture = await contextFixture();
  const displayName = "HM\r\nowner\u2028display\u2029name";
  const workspaceName = "HM\r\nworkspace\u2028A\u2029name\t";
  await sql`UPDATE swarm.users SET email = NULL, display_name = ${displayName}
    WHERE user_id = ${fixture.owner}::uuid`;
  await sql`UPDATE swarm.workspaces SET name = ${workspaceName}
    WHERE workspace_id = ${fixture.workspaceA}::uuid`;
  const results = contextHttp(fixture);
  for (const row of results) {
    const context = assertContext(row, fixture, undefined, false, undefined, undefined,
      { displayName, email: null, workspaceAName: workspaceName });
    assert.equal(context.summary,
      "Connected as HM  owner display name in HM  workspace A name ; 2 approved workspace(s) available.");
  }
});

// Command-level ACK tests cannot detect a field dropped by MCP's final output.
// Post a real addressed signal, open its durable batch, then ACK via HTTP and
// verify both the returned context and the persisted acknowledgement.
test("hosted context survives actual MCP check ACK and advances the stored batch", { timeout: 180_000 }, async () => {
  const fixture = await contextFixture();
  const [claimed] = contextHttp(fixture, { calls: [{ name: "claim_seat" }] });
  const initialContext = assertContext(claimed!, fixture);
  const posted = runHostedHarness<HarnessResult>({ operation: "public", ownerJwt: fixture.ownerJwt,
    workspaceId: fixture.workspaceA, command: { kind: "post_signal", signal_kind: "note",
      body: "Context ACK fixture", to_user_id: null, to_agent_principal_id: claimed!.body.principal_id,
      in_reply_to: null, about: null, until_ms: 600_000 } });
  assert.equal(posted.status, 200);
  assert.equal(posted.body.status, "accepted");
  // The public JWT path syncs GoTrue's synthetic profile into the durable account.
  const [authProfile] = await sql<{ email: string }[]>`
    SELECT email FROM auth.users WHERE id = ${fixture.owner}::uuid`;
  assert.match(authProfile!.email, /^hm-owner-[0-9a-f-]{36}@example\.test$/u);
  const [account] = await sql<ConnectionContext["account"][]>`
    SELECT user_id, display_name, email FROM swarm.users WHERE user_id = ${fixture.owner}::uuid`;
  assert.deepEqual(account, { user_id: fixture.owner,
    display_name: authProfile!.email.split("@")[0], email: authProfile!.email });
  assert.notEqual(account!.display_name, initialContext.account.display_name);
  assert.notEqual(account!.email, initialContext.account.email);
  const expected = { displayName: account!.display_name, email: account!.email };
  const handle = String(claimed!.body.handle);
  const [opened] = contextHttp(fixture, { handle, calls: [{ name: "check" }] });
  const context = assertContext(opened!, fixture, undefined, false, undefined, undefined, expected);
  assert.deepEqual(context.account, account);
  assert.ok(context.summary.includes(account!.display_name));
  assert.deepEqual(context.workspace, initialContext.workspace);
  assert.deepEqual(context.connection, initialContext.connection);
  assert.equal(typeof opened!.body.batch_id, "string");
  const signal = posted.body.signal as { id: string };
  assert.ok((opened!.body.signals as Array<{ id: string }>).some(row => row.id === signal.id));
  const batchId = String(opened!.body.batch_id);
  const [before] = await sql`SELECT acknowledged_at FROM swarm.hosted_mcp_check_batches WHERE batch_id = ${batchId}::uuid`;
  assert.equal(before!.acknowledged_at, null);
  const [acked] = contextHttp(fixture, { handle, calls: [{ name: "check", ack: batchId }] });
  assert.deepEqual(assertContext(acked!, fixture, undefined, false, undefined, undefined, expected), context);
  assert.equal(acked!.body.acknowledged_batch_id, batchId);
  const [after] = await sql`SELECT acknowledged_at FROM swarm.hosted_mcp_check_batches WHERE batch_id = ${batchId}::uuid`;
  assert.ok(after!.acknowledged_at instanceof Date);
});

// Each row changes live durable authority after a positive HTTP invocation.
// Omission of another consent and refusal of the current workspace are distinct
// contracts; neither is established by protocol stubs or source inspection.
for (const change of ["consent", "archive", "membership"] as const) {
  test("hosted context HTTP filters withdrawn " + change + " then refuses the current workspace without effects", { timeout: 180_000 }, async () => {
    const fixture = await contextFixture();
    const initial = contextHttp(fixture);
    initial.forEach(row => assertContext(row, fixture));
    const handle = String(initial[0]!.body.handle);
    const withdraw = async (workspaceId: string) => {
      if (change === "consent") await sql`UPDATE swarm.hosted_mcp_grant_workspaces SET revoked_at = statement_timestamp()
        WHERE grant_id = ${fixture.grantA}::uuid AND workspace_id = ${workspaceId}::uuid`;
      else if (change === "archive") await sql`UPDATE swarm.workspaces SET archived_at = statement_timestamp() WHERE workspace_id = ${workspaceId}::uuid`;
      else await sql`UPDATE swarm.memberships SET revoked_at = statement_timestamp()
        WHERE user_id = ${fixture.owner}::uuid AND workspace_id = ${workspaceId}::uuid`;
    };
    await withdraw(fixture.workspaceB);
    const live = contextHttp(fixture, { handle, calls: ["whoami", "members", "check", "claim_seat"].map(name => ({ name })) });
    live.forEach(row => assertContext(row, fixture, [fixture.workspaceA]));
    await withdraw(fixture.workspaceA);
    const [before] = await sql`SELECT
      (SELECT count(*)::text FROM swarm.hosted_mcp_seats WHERE grant_id = ${fixture.grantA}::uuid) AS seats,
      (SELECT count(*)::text FROM swarm.hosted_mcp_check_cursors WHERE grant_id = ${fixture.grantA}::uuid) AS cursors,
      (SELECT count(*)::text FROM swarm.hosted_mcp_check_batches WHERE grant_id = ${fixture.grantA}::uuid) AS batches`;
    const refused = contextHttp(fixture, { handle, calls: ["whoami", "members", "check", "claim_seat"].map(name => ({ name })) });
    for (const row of refused) {
      assert.equal(row.isError, true, row.name);
      assert.equal(row.body.context, undefined);
      assert.equal(JSON.stringify(row.body).includes("context-owner@example.test"), false);
    }
    const [after] = await sql`SELECT
      (SELECT count(*)::text FROM swarm.hosted_mcp_seats WHERE grant_id = ${fixture.grantA}::uuid) AS seats,
      (SELECT count(*)::text FROM swarm.hosted_mcp_check_cursors WHERE grant_id = ${fixture.grantA}::uuid) AS cursors,
      (SELECT count(*)::text FROM swarm.hosted_mcp_check_batches WHERE grant_id = ${fixture.grantA}::uuid) AS batches`;
    assert.deepEqual(after, before, "context refusal leaves claim/check state unchanged");
  });
}

for (const change of ["seat", "grant"] as const) {
  test("hosted context HTTP refuses revoked " + change + " without leaking owner metadata", { timeout: 180_000 }, async () => {
    const fixture = await contextFixture();
    const initial = contextHttp(fixture);
    initial.forEach(row => assertContext(row, fixture));
    if (change === "seat") await sql`UPDATE swarm.hosted_mcp_seats SET revoked_at = statement_timestamp()
      WHERE seat_id = ${String(initial[0]!.body.seat_id)}::uuid`;
    else await sql`UPDATE swarm.hosted_mcp_grants SET state = 'revoked', revoked_at = statement_timestamp()
      WHERE grant_id = ${fixture.grantA}::uuid`;
    const refused = contextHttp(fixture, { handle: String(initial[0]!.body.handle),
      calls: (change === "grant" ? ["whoami", "members", "check", "claim_seat"] : ["whoami", "members", "check"]).map(name => ({ name })) });
    for (const row of refused) {
      assert.equal(row.isError, true, row.name);
      assert.equal(row.body.context, undefined);
      assert.equal(JSON.stringify(row.body).includes("context-owner@example.test"), false);
    }
  });
}

test("context resolver runs under migrated read/command roles and denies forged owner, principal, provider, handle and tool bindings", { timeout: 180_000 }, async () => {
  const fixture = await contextFixture();
  const initial = contextHttp(fixture);
  initial.forEach(row => assertContext(row, fixture));
  const seat = initial[0]!.body;
  const [acl] = await sql`SELECT p.prosecdef AS definer, p.proconfig AS config,
    pg_get_userbyid(p.proowner) AS owner,
    has_function_privilege('swarm_read', p.oid, 'EXECUTE') AS read,
    has_function_privilege('swarm_command', p.oid, 'EXECUTE') AS command,
    has_function_privilege('authenticated', p.oid, 'EXECUTE') AS human,
    has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
    has_function_privilege('commonswarm_oauth_runtime', p.oid, 'EXECUTE') AS oauth,
    has_column_privilege('swarm_read', 'swarm.users', 'email', 'SELECT') AS direct_email
    FROM pg_proc p WHERE p.oid = 'swarm.resolve_hosted_mcp_connection_context(uuid,text,text,uuid,text)'::regprocedure`;
  assert.deepEqual(acl, { definer: true, config: ["search_path=pg_catalog"], owner: "swarm_admin",
    read: true, command: true, human: false, anon: false, oauth: false, direct_email: false });
  for (const role of ["swarm_read", "swarm_command"]) {
    await sql.begin(async tx => {
      await tx`SELECT set_config('role', ${role}, true)`;
      const resolve = async (options: { owner?: string; principal?: string; provider?: string; handle?: string; tool?: string; grant?: string; workspace?: string } = {}) => {
        await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: options.owner ?? fixture.owner,
          role: "authenticated", agent_principal_id: options.principal ?? seat.principal_id })}, true)`;
        const [row] = await tx<{ context: ConnectionContext | null }[]>`SELECT swarm.resolve_hosted_mcp_connection_context(
          ${options.grant ?? fixture.grantA}::uuid, ${options.provider ?? `provider-${fixture.grantA}`}, ${options.tool ?? "whoami"},
          ${options.workspace ?? fixture.workspaceA}::uuid, ${options.handle ?? String(seat.handle)}) AS context`;
        return row!.context;
      };
      assert.deepEqual(await resolve(), initial[0]!.body.context, role + " positive control");
      for (const options of [{ owner: fixture.other }, { principal: randomUUID() }, { provider: `provider-${fixture.grantB}` },
        { handle: "seat_" + "Z".repeat(22) }, { tool: "note" }, { grant: fixture.grantB }, { workspace: fixture.workspaceB }]) {
        assert.equal(await resolve(options), null, role + " mismatched binding refuses metadata");
      }
    });
  }

  // HTTP capability guards can hide an overly broad SQL resolver. Probe its
  // independent role boundary, mutating real durable fences and rolling each
  // transaction back so the next row has the same live positive control.
  class ProbeRollback extends Error {}
  for (const change of ["principal", "handle", "family", "grant-tombstone", "seat-tombstone", "principal-tombstone", "membership-tombstone"] as const) {
    await assert.rejects(sql.begin(async tx => {
      const resolve = async () => {
        await tx`SELECT set_config('role', 'swarm_read', true),
          set_config('request.jwt.claims', ${JSON.stringify({ sub: fixture.owner,
            role: "authenticated", agent_principal_id: seat.principal_id })}, true)`;
        const [row] = await tx<{ context: ConnectionContext | null }[]>`SELECT swarm.resolve_hosted_mcp_connection_context(
          ${fixture.grantA}::uuid, ${`provider-${fixture.grantA}`}, 'whoami',
          ${fixture.workspaceA}::uuid, ${String(seat.handle)}) AS context`;
        await tx`SET LOCAL ROLE NONE`;
        return row!.context;
      };
      assert.deepEqual(await resolve(), initial[0]!.body.context, change + " live positive control");
      if (change === "principal") await tx`UPDATE swarm.agent_principals SET revoked_at = statement_timestamp()
        WHERE principal_id = ${String(seat.principal_id)}::uuid`;
      else if (change === "handle") await tx`UPDATE swarm.hosted_mcp_seat_handles SET revoked_at = statement_timestamp()
        WHERE handle = ${String(seat.handle)}`;
      else if (change === "family") await tx`INSERT INTO commonswarm_oauth.refresh_family_tombstones(grant_id, revoked_at)
        VALUES (${`provider-${fixture.grantA}`}, statement_timestamp())`;
      else {
        const kind = change === "grant-tombstone" ? "hosted_grant" : change === "seat-tombstone" ? "hosted_seat"
          : change === "principal-tombstone" ? "principal" : "membership";
        const target = change === "grant-tombstone" ? fixture.grantA : change === "seat-tombstone" ? seat.seat_id
          : change === "principal-tombstone" ? seat.principal_id : fixture.owner;
        await tx`INSERT INTO swarm.revocation_tombstones(kind, target_id) VALUES (${kind}, ${String(target)}::uuid)`;
      }
      assert.equal(await resolve(), null, change + " denies all account metadata at the SQL boundary");
      throw new ProbeRollback();
    }), ProbeRollback);
  }
});

// Authoring gate: the existing direct-handler fixture cannot catch HTTP tool
// projection loss or READ COMMITTED behavior after a different session commits.
// Use the existing MCP/JWKS fixture and the migrated schema, with no db.begin shim.
async function ownerContentHttpFixture() {
  const fixture = await seedHostedFixture(true);
  await sql`INSERT INTO swarm.household_workspace_boundaries(workspace_id,purpose)
    VALUES (${fixture.workspaceA}::uuid,'shared')`;
  await sql`INSERT INTO swarm.household_member_content_roles(workspace_id,user_id,content_role,content_consent_id,confirmed_at)
    VALUES (${fixture.workspaceA}::uuid,${fixture.owner}::uuid,'editor',${randomUUID()}::uuid,clock_timestamp()),
      (${fixture.workspaceA}::uuid,${fixture.other}::uuid,'editor',${randomUUID()}::uuid,clock_timestamp())`;
  const seat = claimSeat(fixture, fixture.grantA, `owner-content-${randomUUID()}`);
  assert.equal(seat.status,200);
  const edgeUrl = new URL(local.DB_URL);
  edgeUrl.username = 'commonswarm_edge'; edgeUrl.password = randomBytes(32).toString('hex');
  await releaseSql.unsafe(`DO $edge$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='commonswarm_edge') THEN
    CREATE ROLE commonswarm_edge LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    END IF; END $edge$; GRANT swarm_command,swarm_read,swarm_capability TO commonswarm_edge;`);
  await releaseSql.unsafe(`ALTER ROLE commonswarm_edge PASSWORD '${edgeUrl.password}'`);
  const edge = postgres(edgeUrl.href,{prepare:false,max:1});
  try {
    const [identity] = await edge`SELECT session_user='commonswarm_edge' AND NOT rolsuper AND NOT rolbypassrls AS safe
      FROM pg_roles WHERE rolname=current_user`;
    assert.equal(identity!.safe,true);
    await assert.rejects(edge.begin(async tx => { await tx.unsafe('SET LOCAL ROLE commonswarm_oauth_runtime'); }), {code:'42501'});
  } finally { await edge.end(); }
  const handle = String(seat.body.handle);
  const call = (calls: Array<Record<string,unknown>>, extra: Record<string,unknown> = {}) => ({
    operation:'context-http',grantId:fixture.grantA,ownerUserId:fixture.owner,handle,calls,...extra });
  return { fixture, seat, edgeUrl:edgeUrl.href, call };
}
function assertContentDenied(result: ContextHttpResult) {
  assert.ok(result.isError || result.body.status==='refused',JSON.stringify(result.body));
  assert.equal(result.body.content,undefined);
  assert.equal(result.body.queue,undefined,'denied queue releases no stale content access');
}

test('owner content traverses MCP HTTP read/command routes with no approval, and nonowner/foreign/revoked controls', {timeout:180_000}, async()=>{
  const f=await ownerContentHttpFixture();
  try {
    await sql`UPDATE swarm.household_member_content_roles SET content_role='reader'
      WHERE workspace_id=${f.fixture.workspaceA}::uuid AND user_id=${f.fixture.owner}::uuid`;
    const reader=runHostedHarness<ContextHttpResult[]>(f.call([{name:'todo_list'},{name:'todo_queue'},
      {name:'todo_create',arguments:{request_id:randomUUID(),title:'Reader refuses write'}}]),{databaseUrl:f.edgeUrl});
    assert.equal(reader[0]!.body.status,'ok'); assert.equal((reader[1]!.body.queue as {content_access:string}).content_access,'read');
    assertContentDenied(reader[2]!);
    await sql`UPDATE swarm.household_member_content_roles SET content_role='editor'
      WHERE workspace_id=${f.fixture.workspaceA}::uuid AND user_id=${f.fixture.owner}::uuid`;
    const editor=runHostedHarness<ContextHttpResult[]>(f.call([{name:'todo_create',arguments:{request_id:randomUUID(),title:'HTTP inherited editor'}},
      {name:'todo_queue'}]),{databaseUrl:f.edgeUrl});
    assert.equal(editor[0]!.body.status,'committed'); assert.equal((editor[1]!.body.queue as {content_access:string}).content_access,'read_write');
    const [approvals]=await sql`SELECT count(*)::int AS n FROM swarm.household_content_connections WHERE workspace_id=${f.fixture.workspaceA}::uuid`;
    assert.equal(approvals!.n,0,'HTTP access never manufactures human approval');
    for (const role of ['admin','member']) {
      await sql`UPDATE swarm.memberships SET role=${role} WHERE workspace_id=${f.fixture.workspaceA}::uuid AND user_id=${f.fixture.owner}::uuid`;
      const denied=runHostedHarness<ContextHttpResult[]>(f.call([{name:'todo_list'},{name:'todo_queue'}]),{databaseUrl:f.edgeUrl});
      denied.forEach(assertContentDenied);
    }
    await sql`UPDATE swarm.memberships SET role='owner' WHERE workspace_id=${f.fixture.workspaceA}::uuid AND user_id=${f.fixture.owner}::uuid`;
    const control=runHostedHarness<ContextHttpResult[]>(f.call([{name:'todo_list'}]),{databaseUrl:f.edgeUrl});
    assert.equal(control[0]!.body.status,'ok');
    runHostedHarness<ContextHttpResult[]>(f.call([{name:'todo_list'}],{grantId:f.fixture.grantB,ownerUserId:f.fixture.other}),{databaseUrl:f.edgeUrl}).forEach(assertContentDenied);
    await sql`UPDATE swarm.hosted_mcp_seats SET revoked_at=clock_timestamp() WHERE seat_id=${f.seat.body.seat_id as string}::uuid`;
    runHostedHarness<ContextHttpResult[]>(f.call([{name:'todo_list'},{name:'todo_queue'}]),{databaseUrl:f.edgeUrl}).forEach(assertContentDenied);
  } finally { await releaseSql.unsafe('ALTER ROLE commonswarm_edge PASSWORD NULL'); }
});

// A non-nested legacy/restriction pair used to hide the legacy create ceiling
// under the actual rollback policy. Only real committed transactions can prove
// the 503 rollback and same-process catalog transition at both HTTP boundaries.
test('compatibility gate returns retryable content errors without effects, then exact intersection after DROP', {timeout:180_000}, async()=>{
  const f=await ownerContentHttpFixture();
  const workspace=f.fixture.workspaceA, principal=String(f.seat.body.principal_id), seat=String(f.seat.body.seat_id);
  const allow={kind:'household_approve_connection',connection:{kind:'hosted',connection_id:seat,
    grant_id:f.fixture.grantA,principal_id:principal,operations:['read','update']}};
  const management=(command:Record<string,unknown>)=>runHostedHarness<HarnessResult>({operation:'management',
    ownerUserId:f.fixture.owner,workspaceId:workspace,command},{databaseUrl:f.edgeUrl});
  const retryBody={error:'household_content_service_updating',
    message:'Household content service is updating. Retry after one second with the same request_id.',retryable:true,retry_after_seconds:1};
  const writeId=randomUUID();
  const calls=[{name:'todo_list'},{name:'todo_queue'},
    {name:'todo_create',arguments:{request_id:writeId,title:'Gate must never create this'}}];
  const httpCalls=calls.map(call=>({...call,transport:'http',...(call.name==='todo_queue'?{arguments:{principal_id:principal}}:{})}));
  const authorityCalls=[{name:'allow',transport:'http',command:allow},
    {name:'withdraw',transport:'http',command:{kind:'household_withdraw_connection',principal_id:principal}}];
  const httpInput={ownerJwt:f.fixture.ownerJwt,workspaceId:workspace};
  // Digests cover complete synthetic row versions, including retained receipts,
  // authority/audits, content projections/events, notifications and presence.
  const snapshot=async()=>{
    const state=[];
    for(const table of ['workspaces','memberships','household_workspace_boundaries','household_member_content_roles',
      'agent_principals','hosted_mcp_grant_workspaces','hosted_mcp_seats','hosted_mcp_seat_handles',
      'household_content_connections','household_hosted_content_restrictions','household_object_streams',
      'household_object_events','household_object_artifacts','household_object_audit','household_todo_streams',
      'household_todo_events','household_todos','household_comments','household_todo_receipts',
      'household_agent_work_policies','idempotency_keys','streams','events','signals','signal_deliveries','agent_presence','audit_log']) {
      state.push([table,...await sql.unsafe(`SELECT count(*)::int AS n, md5(coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text)::text,'[]')) AS digest
        FROM swarm.${table} r WHERE workspace_id=$1::uuid`,[workspace])]);
    }
    return state;
  };
  try {
    assert.equal(management(allow).body.status,'committed');
    // Privileged fixture edit models historical independently chosen ceilings;
    // the human restriction remains read/update, legacy approval read/create.
    await sql`UPDATE swarm.household_content_connections SET operations=ARRAY['read','create']
      WHERE connection_id=${seat}::uuid AND workspace_id=${workspace}::uuid`;
    const beforeControl=runHostedHarness<ContextHttpResult[]>(f.call(calls),{databaseUrl:f.edgeUrl});
    assert.equal(beforeControl[0]!.body.status,'ok');
    assert.equal((beforeControl[1]!.body.queue as {content_access:string}).content_access,'read');
    assertContentDenied(beforeControl[2]!);
    await releaseSql.unsafe(repoSql('deploy/release-proofs/hosted-owner-content/20261019000006-rollback.sql'));
    const [hidden]=await sql.begin(async tx=>{
      await tx.unsafe('SET LOCAL ROLE swarm_command');
      return await tx`SELECT count(*)::int AS n FROM swarm.household_content_connections WHERE connection_id=${seat}::uuid`;
    });
    assert.equal(hidden!.n,0,'actual restrictive policy hides the non-nested legacy ceiling');
    const before=await snapshot();
    const gated=runHostedHarness<ContextHttpResult[]>(f.call([...calls,...httpCalls,...authorityCalls],httpInput),{databaseUrl:f.edgeUrl});
    assert.equal(gated.length,8);
    gated.forEach((result,index)=>{
      assert.equal(result.status,index<3?200:503);
      assert.equal(result.isError,true);
      assert.equal(result.authChallenge,false,'transient content refusal never asks to reconnect');
      assert.deepEqual(result.body,retryBody,'MCP preserves the exact ordinary HTTP body');
      if(index>=3) assert.equal(result.retryAfter,'1');
    });
    assert.deepEqual(await snapshot(),before,'gate leaves zero content or authority effects');
    assert.deepEqual(management(allow),{status:503,body:retryBody,headers:{'retry-after':'1'}});
    assert.deepEqual(await snapshot(),before,'shared human-management boundary also rolls back');
    // A single live MCP process observes the gate and its DROP: no restart,
    // cached authority refresh, Allow, login, or token invalidation is involved.
    const forward=runHostedHarness<ContextHttpResult[]>(f.call([calls[0]!,{...calls[0],drop_compatibility_gate:true},
      calls[1]!,calls[2]!],{dropCompatibilityGate:true,raceDatabaseUrl:localClusterAdminUrl(local.DB_URL)}),{databaseUrl:f.edgeUrl});
    assert.deepEqual(forward[0]!.body,retryBody); assert.equal(forward[0]!.isError,true);
    assert.equal(forward[1]!.body.status,'ok'); assert.equal(forward[1]!.isError,false);
    assert.equal((forward[2]!.body.queue as {content_access:string}).content_access,'read');
    assertContentDenied(forward[3]!);
    const listing=management({kind:'household_connections'});
    const connections=listing.body.connections as Array<{connection_id:string;effective_access:{operations:string[]}}>;
    assert.deepEqual(connections.find(row=>row.connection_id===seat)!.effective_access.operations,['read']);
    assert.equal(management({...allow,connection:{...allow.connection,operations:['read','create','update']}}).body.status,'committed');
    const restored=runHostedHarness<ContextHttpResult[]>(f.call([calls[2]!,calls[1]!,...httpCalls],httpInput),{databaseUrl:f.edgeUrl});
    assert.equal(restored[0]!.body.status,'committed','same refused request_id can succeed after truthful human Allow');
    assert.equal((restored[1]!.body.queue as {content_access:string}).content_access,'read_write');
    assert.equal(restored[2]!.status,200); assert.equal(restored[2]!.body.status,'ok');
    assert.equal(restored[3]!.status,200); assert.equal(restored[3]!.body.status,'ok');
    assert.equal((restored[3]!.body.queue as {content_access:string}).content_access,'read_write');
    assert.equal(restored[4]!.status,200); assert.equal(restored[4]!.body.status,'committed','ordinary HTTP writes resume after DROP');
  } finally {
    await releaseSql.unsafe('DROP POLICY IF EXISTS hosted_owner_content_rollback_gate ON swarm.household_content_connections');
    await releaseSql.unsafe('ALTER ROLE commonswarm_edge PASSWORD NULL');
  }
});

for (const change of ['role','removal','withdrawal'] as const) {
  test(`owner HTTP queue waits on another PostgreSQL session and rechecks committed ${change}`, {timeout:180_000}, async()=>{
    const f=await ownerContentHttpFixture();
    let pending: Promise<ContextHttpResult[]> | undefined;
    try {
      assert.equal(runHostedHarness<ContextHttpResult[]>(f.call([{name:'todo_list'}]),{databaseUrl:f.edgeUrl})[0]!.body.status,'ok');
      await sql.begin(async locker=>{
        const [session]=await locker`SELECT pg_backend_pid() AS pid`;
        await locker`SELECT workspace_id FROM swarm.workspaces WHERE workspace_id=${f.fixture.workspaceA}::uuid FOR NO KEY UPDATE`;
        pending=runHostedHarnessAsync<ContextHttpResult[]>(f.call([{name:'todo_queue'}]),f.edgeUrl);
        void pending.catch(()=>{}); // the original promise is asserted after releasing the lock
        let blocked=false;
        for(let attempt=0;attempt<400;attempt++) {
          const [wait]=await sql`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
            WHERE usename='commonswarm_edge' AND ${session!.pid}::int=ANY(pg_blocking_pids(pid))) AS blocked`;
          if(wait!.blocked) { blocked=true; break; }
          await new Promise(resolve=>setTimeout(resolve,25));
        }
        assert.equal(blocked,true,'observed a real second-session lock wait before changing authority');
        if(change==='role') await locker`UPDATE swarm.memberships SET role='member' WHERE workspace_id=${f.fixture.workspaceA}::uuid AND user_id=${f.fixture.owner}::uuid`;
        else if(change==='removal') {
          // The normal MemberRemoved content hook runs before the membership
          // stamp, while a second real owner is still live for its audit checks.
          await locker`UPDATE swarm.memberships SET role='owner' WHERE workspace_id=${f.fixture.workspaceA}::uuid AND user_id=${f.fixture.other}::uuid`;
          await locker.unsafe('SET LOCAL ROLE swarm_command');
          const {revokeRemovedMemberHousehold}=await import('../../supabase/functions/command/household-member-removal.ts');
          await revokeRemovedMemberHousehold(locker,f.fixture.workspaceA,f.fixture.owner,new Date(),f.fixture.other,randomUUID(),'ab'.repeat(32));
          await locker.unsafe('RESET ROLE');
          await locker`UPDATE swarm.memberships SET revoked_at=clock_timestamp() WHERE workspace_id=${f.fixture.workspaceA}::uuid AND user_id=${f.fixture.owner}::uuid`;
        }
        else {
          await locker.unsafe('SET LOCAL ROLE swarm_command');
          const {withdrawHouseholdConnection}=await import('../../supabase/functions/command/household-permissions.ts');
          const result=await withdrawHouseholdConnection(locker,f.fixture.workspaceA,
            {user_id:f.fixture.owner,principal_id:null,run_id:null,connection:null},randomUUID(),
            {kind:'household_withdraw_connection',principal_id:f.seat.body.principal_id},async()=>true);
          assert.equal(result.status,'committed');
        }
      });
      (await pending!).forEach(assertContentDenied);
      runHostedHarness<ContextHttpResult[]>(f.call([{name:'todo_list'},{name:'todo_queue'},
        {name:'todo_create',arguments:{request_id:randomUUID(),title:'After committed barrier'}}]),{databaseUrl:f.edgeUrl}).forEach(assertContentDenied);
    } finally {
      if(pending) await pending.catch(()=>{});
      await releaseSql.unsafe('ALTER ROLE commonswarm_edge PASSWORD NULL');
    }
  });
}

for(const operation of ['read','write'] as const) {
  test(`Storage ${operation} linearizes before waiting withdrawal, and subsequent HTTP content is denied`, {timeout:180_000}, async()=>{
    const f=await ownerContentHttpFixture();
    try {
      const object=randomUUID();
      const setup=runHostedHarness<ContextHttpResult[]>(f.call([{name:'object_create',arguments:{request_id:randomUUID(),object_id:object,
        title:'Synthetic Storage race',content:{kind:'doc',markdown:'Synthetic bytes'}}},
        {name:'object_read',arguments:{object_id:object}}]),{databaseUrl:f.edgeUrl});
      assert.equal(setup[0]!.body.status,'committed'); assert.equal(setup[1]!.body.status,'ok');
      const raceCall=operation==='read'
        ? {name:'object_read',arguments:{object_id:object},storage_race:true}
        : {name:'object_create',arguments:{request_id:randomUUID(),object_id:randomUUID(),title:'Concurrent upload',
          content:{kind:'doc',markdown:'Synthetic upload'}},storage_race:true};
      const results=runHostedHarness<ContextHttpResult[]>(f.call([raceCall,{name:'todo_list'},{name:'todo_queue'},
        {name:'object_read',arguments:{object_id:object}}],{storageRace:true,raceDatabaseUrl:local.DB_URL,
        workspaceId:f.fixture.workspaceA,principalId:f.seat.body.principal_id}),{databaseUrl:f.edgeUrl});
      assert.equal(results[0]!.body.status,operation==='read'?'ok':'committed','operation admitted before withdrawal commit may complete');
      results.slice(1).forEach(assertContentDenied);
    } finally { await releaseSql.unsafe('ALTER ROLE commonswarm_edge PASSWORD NULL'); }
  });
}
