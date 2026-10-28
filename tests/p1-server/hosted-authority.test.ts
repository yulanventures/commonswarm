/** HM lane-2 server coverage. Runs only in the manual `server` suite. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, test } from "node:test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import postgres from "postgres";
import { emptyHouseholdObjectState } from "../../src/protocol/household-objects.js";
import { HOSTED_MCP_SEAT_LIMIT } from "../../src/protocol/hosted-authority.js";
import { emptyApplicationSchema, localClusterAdminUrl, migrationNames as adminMigrationNames, repoSql, versions as adminVersions } from "../support/admin-schema-db.js";
import { releaseCatalogQuery } from "../support/release-catalog-query.js";
import { adminEdgeDatabase } from "../support/admin-edge-database.js";

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
let adminIssuerDatabaseUrl: string;
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
    interactiveAuthAtSeconds: input.interactiveAuthAtSeconds ?? null,
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
    command: input.command ?? (spec.tool === "check" ? { kind: "open_hosted_mcp_check_batch", seat: spec.handle } : {
      kind: "post_signal", signal_kind: "note",
      body: "D3 historical identity", to_user_id: null, to_agent_principal_id: null,
      in_reply_to: null, about: null }),
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

async function raceSessions(run) {
  const { default: postgres } = await import("npm:postgres@3.4.9");
  const options = { prepare: false, max: 1 };
  const gateDb = postgres(Deno.env.get("SWARM_DATABASE_URL"), options);
  const observer = postgres(Deno.env.get("SWARM_DATABASE_URL"), options);
  try { return await run(gateDb,observer); }
  finally { await Promise.all([gateDb.end({ timeout: 2 }),observer.end({ timeout: 2 })]); }
}

async function waitForBlocked(observer, gatePid, expected) {
  const stop = performance.now()+3500;
  do {
    // Autocommit gives each poll a new activity snapshot. Follow the real
    // blocker graph, including a second command queued behind the first.
    const [row] = await observer.unsafe("WITH RECURSIVE blocked(pid) AS ("+
      " SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1::int=ANY(pg_blocking_pids(pid))"+
      " UNION SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid=ANY(pg_blocking_pids(a.pid))"+
      " WHERE a.datname=current_database()) SELECT count(*)::int AS n FROM blocked",[gatePid]);
    if (row.n >= expected) return;
    await new Promise(resolve => setTimeout(resolve,20));
  } while (performance.now()<stop);
  throw new Error("request did not reach the exact blocker graph before the production lock timeout");
}

async function chooseDeadline(observer, grantId) {
  const [row] = await observer.unsafe("UPDATE swarm.hosted_mcp_grants SET connection_expires_at="+
    "date_trunc('milliseconds',clock_timestamp())+interval '2 seconds' WHERE grant_id=$1::uuid "+
    "RETURNING connection_expires_at::text AS deadline,connection_expires_at>clock_timestamp() AS future",[grantId]);
  if (!row?.future) throw new Error("chosen deadline positive control is not future");
  return row.deadline;
}

async function waitForDeadline(observer, grantId, deadline) {
  const stop = performance.now()+3500;
  do {
    const [row] = await observer.unsafe("SELECT connection_expires_at::text AS deadline,clock_timestamp()::text AS now,"+
      "connection_expires_at<=clock_timestamp() AS elapsed,connection_expires_at=$2::timestamptz AS unchanged "+
      "FROM swarm.hosted_mcp_grants WHERE grant_id=$1::uuid",[grantId,deadline]);
    if (!row?.unchanged) throw new Error("race changed the actual chosen deadline");
    if (row.elapsed && new Date(row.now).getTime()>=new Date(row.deadline).getTime()) return row;
    await new Promise(resolve => setTimeout(resolve,20));
  } while (performance.now()<stop);
  throw new Error("actual owner deadline did not elapse under the database clock");
}

// Schedule only the real SQL transport: no authorization result or clock is
// mocked. Hold delivery of the initial fresh clock sample until that stored
// deadline elapses, so the following live-policy resolver must return no rows.
async function policyEligibilityBoundary() {
  return await raceSessions(async (_gateDb,observer) => {
    const edit = grantId => publicCommand(input.ownerJwt,input.workspaceA,{
      kind:"set_connection_expiry",connection_kind:"hosted",grant_id:grantId,connection_expires_at:null });
    const positive=await edit(input.grantId);
    if(positive.status!==200) throw new Error('live owner boundary positive refused');
    const chosen=await chooseDeadline(observer,input.grantId);
    await observer.unsafe("UPDATE swarm.hosted_mcp_grants SET connection_expires_at=clock_timestamp()-interval '1 second' WHERE grant_id=$1::uuid",[input.foreignGrantId]);
    const snapshot=async()=>{
      const rows=[];
      for(const [table,key] of [['hosted_mcp_grants','home_workspace_id'],
        ...['hosted_mcp_grant_workspaces','hosted_mcp_seats','hosted_mcp_seat_handles',
          'memberships','workspaces','streams','events','audit_log','idempotency_keys'].map(table=>[table,'workspace_id'])]) {
        rows.push([table,...await observer.unsafe("SELECT count(*)::int AS n,md5(coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text)::text,'[]')) AS digest FROM swarm."+table+" r WHERE "+key+"=ANY($1::uuid[])",[input.workspaces])]);
      }
      return rows;
    };
    const before=await snapshot();
    let sampled=null,elapsed=null,eligibilityRows=null;
    const wrap=tx=>new Proxy(tx,{
      apply(target,thisArg,args) {
        const text=Array.isArray(args[0]) ? args[0].join('?') : '';
        const pending=Reflect.apply(target,thisArg,args);
        if(text.includes('AS now_ms') && text.includes('AS live_member')) return (async()=>{
          const rows=await pending;
          if(sampled!==null || rows.length!==1) throw new Error('owner clock boundary not unique');
          sampled=Number(rows[0].now_ms);
          if(sampled>=Date.parse(chosen)) throw new Error('deadline already elapsed at first sample');
          elapsed=await waitForDeadline(observer,input.grantId,chosen);
          return rows;
        })();
        if(text.includes('FROM swarm.resolve_hosted_grant_authorization(')) return (async()=>{
          const rows=await pending;
          eligibilityRows=rows.length;
          return rows;
        })();
        return pending;
      },
      get(target,key,receiver) {
        if(key==='savepoint') return (...args)=>{
          const callback=args.pop();
          return target.savepoint(...args,sp=>callback(wrap(sp)));
        };
        return Reflect.get(target,key,receiver);
      },
    });
    const begin=db.begin;
    db.begin=function(...args) {
      const callback=args.pop();
      return begin.call(this,...args,tx=>callback(wrap(tx)));
    };
    let owner;
    try { owner=await edit(input.grantId); }
    finally { db.begin=begin; }
    if(sampled===null || elapsed===null || eligibilityRows!==0) throw new Error('expired resolver boundary not reached');
    const ownerAfter=await snapshot();
    const foreign=await edit(input.foreignGrantId);
    const foreignAfter=await snapshot();
    const missing=await edit(input.missingGrantId);
    const missingAfter=await snapshot();
    return {positive,owner,foreign,missing,sampled,elapsed,eligibilityRows,before,ownerAfter,foreignAfter,missingAfter};
  });
}

async function authorityWaitRace() {
  const remove = () => publicCommand(input.otherJwt, input.workspaceB,
    { kind: "remove_member", user_id: input.ownerUserId });
  const activate = () => managementCommand(input.ownerUserId, input.workspaceA,
    { kind: "activate_hosted_mcp_grant", grant_id: input.grantId });
  return await raceSessions(async (gateDb,observer) => {
    let first, second, chosen, elapsed;
    if (input.operation === "policy-wait") {
      const positive = await publicCommand(input.ownerJwt,input.workspaceA,{ kind:"set_connection_expiry",
        connection_kind:"hosted",grant_id:input.grantId,connection_expires_at:null });
      if (positive.status !== 200) throw new Error("live owner edit positive refused: "+positive.body.error);
      chosen = await chooseDeadline(observer,input.grantId);
    } else {
      const positive = await activate();
      if (positive.status !== 200) throw new Error("activation positive refused: "+positive.body.error);
      await observer.unsafe("UPDATE swarm.hosted_mcp_grants SET state='pending',activated_at=NULL WHERE grant_id=$1::uuid",[input.grantId]);
    }
    await gateDb.begin(async gate => {
      const [{ pid }] = await gate.unsafe("SELECT pg_backend_pid() AS pid");
      await gate.unsafe("SELECT grant_id FROM swarm.hosted_mcp_grants WHERE grant_id=$1::uuid FOR UPDATE",[input.grantId]);
      if (input.operation === "policy-wait") {
        first = publicCommand(input.ownerJwt,input.workspaceA,{ kind:"set_connection_expiry",
          connection_kind:"hosted",grant_id:input.grantId,connection_expires_at:null });
        void first.catch(() => {});
        await waitForBlocked(observer,pid,1);
        elapsed = await waitForDeadline(observer,input.grantId,chosen);
      } else {
        first = input.order === "remove-first" ? remove() : activate();
        void first.catch(() => {});
        await waitForBlocked(observer,pid,1);
        second = input.order === "remove-first" ? activate() : remove();
        void second.catch(() => {});
        await waitForBlocked(observer,pid,2);
      }
    });
    const one = await first;
    if (input.operation === "policy-wait") return { ...one,elapsed };
    const two = await second;
    return input.order === "remove-first" ? { removed:one,activated:two } : { activated:one,removed:two };
  });
}

async function householdWait() {
  const { householdStore } = await import(${JSON.stringify(new URL("../../supabase/functions/command/household-integration.ts", import.meta.url).href)});
  const { revalidateHouseholdSeat } = authModule;
  const writing = input.waitRow === "object-write";
  const cap = await db.begin(async tx => {
    await tx.unsafe("SET LOCAL ROLE "+(writing ? "swarm_command" : "swarm_read"));
    const [identity] = await tx.unsafe("SELECT current_user AS role");
    if (identity.role !== (writing ? "swarm_command" : "swarm_read")) throw new Error("household authentication role mismatch");
    return await authenticateHostedSeatCapability(tx, {
      grantId: input.grantId, providerGrantId: "provider-"+input.grantId,
      handle: input.handle, tool: writing ? "object_create" : "list_list", providerStatus: async () => ({ active: true }),
    }, writing ? "command" : "read");
  });
  if (!cap) throw new Error("household positive capability missing");
  const identity = { user_id: input.ownerUserId, principal_id: input.principalId,
    run_id: null, connection: { connection_id: input.seatId, grant_id: input.grantId } };
  const restore = async tx => {
    await tx.unsafe("SET LOCAL ROLE swarm_command");
    await tx.unsafe("SET LOCAL search_path=swarm,pg_catalog");
    await tx.unsafe("SET LOCAL lock_timeout='5s'");
  };
  const recheck = async tx => {
    const current = await revalidateHouseholdSeat(tx, cap, restore);
    return current !== null && current.workspace_id === input.workspaceId && current.principal_id === identity.principal_id;
  };
  const { createHouseholdObjectStore } = await import(${JSON.stringify(new URL("../../supabase/functions/command/household-objects.ts", import.meta.url).href)});
  const core = await import(${JSON.stringify(new URL("../../supabase/functions/_shared/protocol.js", import.meta.url).href)});
  const transfers = await import(${JSON.stringify(new URL("../../supabase/functions/command/household-transfers.ts", import.meta.url).href)});
  const blobs = new Map();
  let puts = 0;
  const store = writing ? createHouseholdObjectStore({core,transfers,recheckCredential:recheck,fileContentAllowed:()=>true,
    storage:{putImmutable:async (path,bytes)=>{puts++;blobs.set(path,new Uint8Array(bytes));},
      read:async path=>blobs.get(path)??null}}) : householdStore(recheck);
  const probe = () => db.begin(async tx => {
    await restore(tx);
    const [identityRole] = await tx.unsafe("SELECT current_user AS role");
    if (identityRole.role !== "swarm_command") throw new Error("household content role mismatch");
    if (writing) {
      const content = {kind:"doc",markdown:"Synthetic household proof"};
      const decision = await store.write(tx,input.workspaceId,identity,crypto.randomUUID(),
        {kind:"create_household_object",object_id:crypto.randomUUID(),title:"Synthetic proof",content},{content});
      return {status:decision.outcome.status};
    }
    if (input.waitRow === "object") return await store.read(tx,input.workspaceId,identity,{kind:"object_list",offset:0,limit:10});
    const access = await store.access(tx,input.workspaceId,identity);
    return { status: access ? "ok" : "refused" };
  });
  const before = await probe();
  if (before.status !== (writing ? "committed" : "ok")) throw new Error("household live positive refused");
  const putsBefore = puts;
  // Terminal and removed-scope controls exercise the same live capability.
  await db\`UPDATE swarm.hosted_mcp_grants SET connection_expired_at=clock_timestamp() WHERE grant_id=\${input.grantId}::uuid\`;
  const fenced = await probe();
  await db\`UPDATE swarm.hosted_mcp_grants SET connection_expired_at=NULL WHERE grant_id=\${input.grantId}::uuid\`;
  await db\`UPDATE swarm.hosted_mcp_grant_workspaces SET revoked_at=clock_timestamp() WHERE grant_id=\${input.grantId}::uuid AND workspace_id=\${input.workspaceId}::uuid\`;
  const removed = await probe();
  await db\`UPDATE swarm.hosted_mcp_grant_workspaces SET revoked_at=NULL WHERE grant_id=\${input.grantId}::uuid AND workspace_id=\${input.workspaceId}::uuid\`;
  return await raceSessions(async (gateDb,observer) => {
    let waiting;
    const chosen = await chooseDeadline(observer,input.grantId);
    let elapsed;
    await gateDb.begin(async gate => {
      const [{ pid }] = await gate.unsafe("SELECT pg_backend_pid() AS pid");
      if (input.waitRow === "workspace") await gate.unsafe("SELECT workspace_id FROM swarm.workspaces WHERE workspace_id=$1::uuid FOR UPDATE",[input.workspaceId]);
      else if (input.waitRow === "grant") await gate.unsafe("SELECT grant_id FROM swarm.hosted_mcp_grants WHERE grant_id=$1::uuid FOR UPDATE",[input.grantId]);
      else await gate.unsafe("SELECT workspace_id FROM swarm.household_object_streams WHERE workspace_id=$1::uuid FOR UPDATE",[input.workspaceId]);
      waiting = probe().catch(error => {
        if (error instanceof transfers.HouseholdTransferError && error.code === "access_refused") return {status:"refused"};
        throw error;
      });
      void waiting.catch(() => {});
      await waitForBlocked(observer,pid,1);
      elapsed = await waitForDeadline(observer,input.grantId,chosen);
    });
    return { before,fenced,removed,waited:await waiting,extraPuts:puts-putsBefore,elapsed };
  });
}

async function issuerFixture() {
  const signing = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = { ...await crypto.subtle.exportKey("jwk", signing.publicKey), kid: "hosted-removal-test", alg: "ES256", use: "sig" };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    if (String(args[0]) === "https://mcp.commonswarm.com/jwks") {
      const response = new Response(JSON.stringify({ keys: [jwk] }));
      Object.defineProperty(response, "url", { value: "https://mcp.commonswarm.com/jwks" });
      return response;
    }
    return previousFetch(...args);
  };
  return { signing, jwk };
}

async function mcpPolicy() {
  const { signing, jwk } = await issuerFixture();
  Deno.env.set("SWARM_MCP_PUBLIC_ENABLED", "1");
  const { handleRequest: serve } = await import(${JSON.stringify(new URL("../../supabase/functions/mcp/index.ts", import.meta.url).href)});
  const b64 = bytes => btoa(String.fromCharCode(...bytes)).replaceAll("+","-").replaceAll("/","_").replaceAll("=","");
  const encode = value => b64(new TextEncoder().encode(JSON.stringify(value)));
  const now = Math.floor(Date.now()/1000);
  const unsigned = encode({ alg: "ES256", kid: jwk.kid }) + "." + encode({
    iss: "https://mcp.commonswarm.com", aud: "https://mcp.commonswarm.com/mcp",
    sub: input.ownerUserId, grant_id: "provider-"+input.grantId, scope: "mcp", iat: now, exp: now+300 });
  const bearer = unsigned + "." + b64(new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, signing.privateKey, new TextEncoder().encode(unsigned))));
  const probe = async (expectedError = null) => {
    const results = [];
    for (const name of (input.household ? ["list_list"] : input.waitKind ? [input.tool] : ["whoami","note","check"])) {
      const args = { seat: input.handle, ...(name === "list_list" ? { offset:0,limit:10 } : {}),
        ...(name === "note" ? { body:"policy probe",request_id:crypto.randomUUID() } : {}) };
      const response = await serve(new Request("https://mcp.commonswarm.com/mcp", {
        method:"POST",headers:{authorization:"Bearer "+bearer,"content-type":"application/json"},
        body:JSON.stringify({jsonrpc:"2.0",id:crypto.randomUUID(),method:"tools/call",params:{name,arguments:args}}),
      }));
      const body = await response.json();
      const content = body.result?.content?.[0]?.text ? JSON.parse(body.result.content[0].text) : null;
      const code = (typeof body.error === "string" ? body.error : body.error?.code) ?? content?.error ?? content?.reason ?? null;
      const allowed = body.result !== undefined && content !== null && typeof content === "object" &&
        body.result.isError !== true && body.error === undefined && content.status !== "refused";
      // Keep only status and stable code in diagnostics. A timeout, transport
      // failure or generic tool_failed can never satisfy a policy negative.
      if (response.status !== 200 || (expectedError === null ? !allowed : allowed || code !== expectedError)) {
        throw new Error("MCP boundary mismatch: "+JSON.stringify({tool:name,status:response.status,code,expectedError}));
      }
      results.push({status:response.status,allowed});
    }
    return results;
  };
  const before = await probe();
  if (input.waitKind) {
    return await raceSessions(async (gateDb,observer) => {
      let waiting,removing,elapsed;
      const chosen = input.waitKind === "expiry" ? await chooseDeadline(observer,input.grantId) : null;
      await gateDb.begin(async gate => {
        const [{ pid }] = await gate.unsafe("SELECT pg_backend_pid() AS pid");
        await gate.unsafe("SELECT stream_id FROM swarm.streams WHERE workspace_id=$1::uuid AND kind='workspace' FOR UPDATE",[input.workspaceId]);
        if (input.waitKind === "removal") {
          removing = publicCommand(input.otherJwt,input.workspaceId,{kind:"remove_member",user_id:input.ownerUserId});
          void removing.catch(() => {});
          await waitForBlocked(observer,pid,1);
        }
        waiting = probe("forbidden");
        void waiting.catch(() => {});
        await waitForBlocked(observer,pid,removing ? 2 : 1);
        if (chosen) elapsed = await waitForDeadline(observer,input.grantId,chosen);
      });
      const removed = removing ? await removing : null;
      if (removed && removed.status !== 200) throw new Error("removal positive refused: "+removed.body.error);
      return {before,waited:await waiting,removedStatus:removed?.status ?? null,
        jwtStillLive:Math.floor(Date.now()/1000)<now+300,elapsed};
    });
  }

  await db\`UPDATE swarm.hosted_mcp_grants SET connection_expires_at=clock_timestamp()+interval '6 months'
    WHERE grant_id=\${input.grantId}::uuid\`;
  const future = await probe();
  await db\`UPDATE swarm.hosted_mcp_grants SET connection_expires_at=clock_timestamp()-interval '1 second'
    WHERE grant_id=\${input.grantId}::uuid\`;
  const elapsed = await probe("hosted_seat_forbidden");
  return { before, future, elapsed, jwtStillLive: Math.floor(Date.now()/1000) < now+300 };
}

async function adminRemoval() {
  const { adminTransaction } = await import(${JSON.stringify(new URL("../../supabase/functions/command/admin-delegation.ts", import.meta.url).href)});
  const policy = await import(${JSON.stringify(new URL("../../supabase/functions/_shared/protocol.js", import.meta.url).href)});
  const { oauthFixture } = await import(${JSON.stringify(new URL("../support/admin-edge-oauth-fixture.mjs", import.meta.url).href)});
  const { signing, jwk } = await issuerFixture();
  const wire = command => ({ command_id: crypto.randomUUID(), stream: { kind: "account" },
    resource: policy.ADMIN_RESOURCE, command });
  const human = { kind: "human", identity: { user_id: input.ownerUserId,
    session_binding: "a".repeat(64), interactive_at_seconds: Date.now()/1000, csrf_verified: true } };
  const transact = command => db.begin(async tx => {
    await tx.unsafe("SET LOCAL ROLE swarm_command");
    await tx.unsafe("SET LOCAL search_path=swarm,pg_catalog");
    return (await adminTransaction(tx, wire(command), human)).result;
  });
  const connection = crypto.randomUUID();
  const scopes = policy.adminConsentOptions().filter(option => option.available).map(option => option.scope);
  const manifest = {
    connection_id: connection, client_id: "hosted-admin-removal-" + connection,
    resource: policy.ADMIN_RESOURCE, mode: "granular", registry_version: policy.ADMIN_REGISTRY_VERSION,
    scope_names: scopes, capability_names: policy.adminAvailableCapabilities(scopes),
    availability_digest: policy.adminAvailabilityDigest(policy.ADMIN_REGISTRY_VERSION),
    workspace_selector: "selected", workspace_ids: [input.workspaceId],
    created_workspace_policy: { scope_names: ["seats:create", "seats:revoke"] },
    target_rules: { seat_ids: [input.principalId], own_seats: true, grant_created_seats: false,
      recipient_user_ids: [input.ownerUserId], recipient_connection_ids: [connection], transports: ["local", "hosted_mcp"] },
    worker_scope_ceiling: ["post_signal"], role_ceiling: "member",
    renewal_limits: { ...policy.ADMIN_RENEWAL_CEILINGS, grant_kinds: ["timeboxed", "standing"],
      principal_ids: [], successors_per_worker: 2, successors_per_grant: 2 },
    issuance_limits: { ...policy.ADMIN_ISSUANCE_CEILINGS, workspaces: 1 },
    expires_at: Date.now()+86400000, refresh_deadline: Date.now()+86400000,
  };
  const prepared = await transact({ kind: "prepare_admin_consent", manifest, full_account_selected: false });
  if (prepared.status !== 200) return { stage: "prepare", status: prepared.status };
  const grantId = crypto.randomUUID();
  const granted = await transact({ kind: "grant_admin_delegation", grant_id: grantId,
    consent_receipt_id: prepared.body.consent_receipt_id, replaces_grant_id: null });
  if (granted.status !== 200) return { stage: "grant", status: granted.status };
  const { default: postgres } = await import("npm:postgres@3.4.9");
  // Privileged synthetic issuance setup is a separate fixture connection;
  // the handler keeps the real issuer login and production role transitions.
  const setupDb = postgres(Deno.env.get("SWARM_FIXTURE_DATABASE_URL"),{prepare:false,max:1});
  const runtimeDb = postgres(Deno.env.get("SWARM_FIXTURE_OAUTH_DATABASE_URL"),{prepare:false,max:1});
  try {
    const [issuer] = await db.unsafe("SELECT session_user AS login,current_user AS role");
    if (issuer.login !== "commonswarm_admin_issuer" || issuer.role !== issuer.login) throw new Error("admin issuer login mismatch");
    const [runtime] = await runtimeDb.unsafe("SELECT session_user AS login,current_user AS role,NOT rolsuper AND NOT rolbypassrls AS safe FROM pg_roles WHERE rolname=current_user");
    if (runtime.login !== "commonswarm_oauth_runtime" || runtime.role !== runtime.login || !runtime.safe) throw new Error("OAuth runtime login mismatch");
    const oauth = await oauthFixture(setupDb,grantId,signing,jwk.kid);
    const [live] = await runtimeDb.unsafe("SELECT active FROM commonswarm_oauth.resolve_admin_grant_status($1,$2::uuid,$3)",[oauth.provider,input.ownerUserId,jwk.kid]);
    if (!live?.active) throw new Error("admin runtime family positive refused");
    const response = await handleRequest(await oauth.request(wire({ kind: "admin_revoke_seat",
      grant_id:grantId,workspace_id:input.workspaceId,principal_id:input.principalId,reason_code:"owner_requested" })));
    return {stage:"remove",status:response.status};
  } finally { await Promise.all([setupDb.end({timeout:2}),runtimeDb.end({timeout:2})]); }
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
  let policyIdentity = null;
  if (input.policyProbe || input.storageExpiry) {
    const { default: postgres } = await import("postgres");
    observer = postgres(input.raceDatabaseUrl, { prepare: false, max: 1 });
  }
  if (input.policyProbe) {
    const resolved = await db.begin(async tx => {
      await tx.unsafe('SET LOCAL ROLE swarm_read');
      const cap = await authenticateHostedSeatCapability(tx, { grantId:input.grantId,
        providerGrantId:'provider-'+input.grantId,handle:input.handle,tool:'todo_list',providerStatus:async()=>({active:true}) },'read');
      if (!cap) throw new Error('policy probe requires a live authenticated seat');
      return await authModule.revalidateHouseholdSeat(tx,cap,async tx=>{await tx.unsafe('SET LOCAL ROLE swarm_command');});
    });
    if (!resolved) throw new Error('policy probe identity missing');
    policyIdentity = {user_id:resolved.owner_user_id,principal_id:resolved.principal_id,run_id:null,
      connection:{connection_id:resolved.seat_id,grant_id:resolved.grant_id}};
  }
  if (input.storageExpiry) {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (request,init) => {
      const response = await realFetch(request,init);
      const url = typeof request==='string'||request instanceof URL ? String(request):request.url;
      if (storageArmed && url.includes('/storage/v1/object/')) {
        // The genuine Storage request has completed. Withhold its response
        // until the unchanged database deadline elapses, before bytes/effects.
        let elapsed=false;
        for(let attempt=0;attempt<800;attempt++) {
          const [clock]=await observer.unsafe('SELECT connection_expires_at<=clock_timestamp() AS elapsed FROM swarm.hosted_mcp_grants WHERE grant_id=$1::uuid',[input.grantId]);
          if(clock.elapsed) {elapsed=true;break;}
          await new Promise(resolve=>setTimeout(resolve,25));
        }
        if(!elapsed) throw new Error('Storage deadline did not elapse');
        storageBlocked=true;
      }
      return response;
    };
  }
  let handle = input.handle;
  const results = [];
  for (const call of input.calls) {
    if (call.policy_loader) {
      await observer.unsafe("UPDATE swarm.hosted_mcp_grants SET connection_expires_at=CASE WHEN $2='future' THEN clock_timestamp()+interval '1 hour' WHEN $2='elapsed' THEN clock_timestamp()-interval '1 second' ELSE NULL END,connection_expired_at=CASE WHEN $2='terminal' THEN clock_timestamp() ELSE NULL END,state=CASE WHEN $2='revoked' THEN 'revoked' ELSE 'active' END,revoked_at=CASE WHEN $2='revoked' THEN clock_timestamp() ELSE NULL END WHERE grant_id=$1::uuid",[input.grantId,call.policy_loader]);
      const { loadHouseholdContentAccess } = await import(${JSON.stringify(new URL('../../supabase/functions/command/household-content-access.ts', import.meta.url).href)});
      const checked = await db.begin(async tx=>{
        await tx.unsafe('SET LOCAL ROLE swarm_command');
        const [role]=await tx.unsafe('SELECT current_user AS role');
        if(role.role!=='swarm_command') throw new Error('loader role mismatch');
        return await loadHouseholdContentAccess(tx,input.workspaceId,policyIdentity);
      });
      results.push({name:'policy_loader',status:200,isError:!checked,body:{status:checked?'ok':'refused',source:checked?.source}});
      continue;
    }
    if (call.choose_storage_deadline) await observer.unsafe("UPDATE swarm.hosted_mcp_grants SET connection_expires_at=clock_timestamp()+interval '2 seconds' WHERE grant_id=$1::uuid",[input.grantId]);
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
      if (input.storageExpiry) { if(!storageBlocked) throw new Error('real Storage expiry wait was not reached'); continue; }
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
if (input.operation === "activation-removal" || input.operation === "policy-wait") result = await authorityWaitRace();
else if (input.operation === "policy-eligibility-boundary") result = await policyEligibilityBoundary();
else if (input.operation === "mcp-policy") result = await mcpPolicy();
else if (input.operation === "household-wait") result = await householdWait();
else if (input.operation === "admin-removal") result = await adminRemoval();
else if (input.operation === "context-http") result = await contextHttp();
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
  // Admin HTTP uses the existing constrained issuer login. Its reviewed SET
  // memberships already exist; the ordinary edge login gains no OAuth rights.
  const issuerTarget = new URL(local.DB_URL);
  issuerTarget.username = "commonswarm_admin_issuer";
  issuerTarget.password = randomBytes(32).toString("hex");
  await releaseSql.unsafe(`ALTER ROLE commonswarm_admin_issuer PASSWORD '${issuerTarget.password}'`);
  adminIssuerDatabaseUrl = issuerTarget.href;
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
  await releaseSql.unsafe("ALTER ROLE commonswarm_admin_issuer PASSWORD NULL");
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

async function seedHostedFixture(grantBOwnerIsOther = false, providerBinding = false, isolatedAuthUsers = false): Promise<HostedFixture> {
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
    // Schema-only isolated fixtures need the real auth FK rows as well.
    if (isolatedAuthUsers) await tx`INSERT INTO auth.users(id, aud, role)
      VALUES (${fixture.owner}::uuid, 'authenticated', 'authenticated'),
             (${fixture.other}::uuid, 'authenticated', 'authenticated')`;
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
      if (providerBinding) await tx`INSERT INTO commonswarm_oauth.provider_grant_resources
        (provider_grant_id,resource,grant_class,owner_user_id,client_id,connection_id,hosted_grant_id)
        VALUES (${`provider-${grant}`},'https://mcp.commonswarm.com/mcp','hosted_mcp',
          ${grantOwner}::uuid,'test-client',${grant}::uuid,${grant}::uuid)`;
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

function hostedHarnessLaunch(input: Record<string, unknown>, options: {databaseUrl?: string; rollbackBeforeStep?: number; harnessPath?: string}) {
  return { args: [
    "run",
    "--no-lock",
    "--config",
    "supabase/functions/command/deno.json",
    "--allow-env",
    "--allow-net",
    "--allow-read",
    options.harnessPath ?? harnessPath,
  ], options: {
    cwd: process.cwd(),
    encoding: "utf8" as const,
    env: {
      PATH: process.env.PATH ?? "",
      ...(process.env.DENO_DIR ? { DENO_DIR: process.env.DENO_DIR } : {}),
      SWARM_ENV: "test",
      SWARM_MCP_PUBLIC_ENABLED: "1",
      SWARM_MCP_TODOS_LISTS_ENABLED: input.household === true ? "1" : "0",
      SWARM_DATABASE_URL: options.databaseUrl ?? (input.operation === "admin-removal" ? adminIssuerDatabaseUrl : local.DB_URL),
      SUPABASE_DB_URL: options.databaseUrl ?? (input.operation === "admin-removal" ? adminIssuerDatabaseUrl : local.DB_URL),
      ...(input.operation === "admin-removal" ? {
        SWARM_FIXTURE_DATABASE_URL: localClusterAdminUrl(local.DB_URL),
        SWARM_FIXTURE_OAUTH_DATABASE_URL: oauthDatabaseUrl,
      } : {}),
      ...(options.rollbackBeforeStep ? { SWARM_CMD_TEST_ROLLBACK_BEFORE_STEP: String(options.rollbackBeforeStep) } : {}),
      SUPABASE_URL: local.API_URL,
      SUPABASE_ANON_KEY: local.ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY: local.SERVICE_ROLE_KEY,
    },
    timeout: 90_000,
  } };
}

function runHostedHarness<T>(input: Record<string, unknown>, options: {
  databaseUrl?: string; rollbackBeforeStep?: number; harnessPath?: string;
} = {}): T {
  const config = hostedHarnessLaunch(input, options);
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
  const config = hostedHarnessLaunch(input, options);
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
          AND (pg_get_constraintdef(oid) LIKE '%grant_id%workspace_id%'
            OR pg_get_constraintdef(oid) LIKE '%grant_id%principal_id%owner_user_id%')
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
    const [emptyRestrictions] = await tx`SELECT count(*)::int AS n FROM swarm.household_hosted_content_restrictions`;
    assert.equal(emptyRestrictions!.n, 0, "historical inverse runs only on an empty restriction fixture");
    // 00006 retains this table on rollback. Its one grant-workspace FK must
    // leave only this empty, transaction-rolled-back historical HM drill.
    const newerFks = await tx<{ name: string; columns: string[]; targets: string[] }[]>`
      SELECT c.conname AS name,
        ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num,ord)
          JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.num ORDER BY k.ord) AS columns,
        ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(num,ord)
          JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.num ORDER BY k.ord) AS targets
      FROM pg_constraint c WHERE c.contype='f'
        AND c.conrelid='swarm.household_hosted_content_restrictions'::regclass
        AND c.confrelid='swarm.hosted_mcp_grant_workspaces'::regclass`;
    assert.equal(newerFks.length, 1);
    const newerFk = newerFks[0]!;
    assert.deepEqual(newerFk.columns, ['grant_id','workspace_id','owner_user_id']);
    assert.deepEqual(newerFk.targets, newerFk.columns);
    await tx`ALTER TABLE swarm.household_hosted_content_restrictions DROP CONSTRAINT ${tx(newerFk.name)}`;
    for (const version of ["20261028000003", "20261028000002", "20261028000001"]) {
      await tx.unsafe(repoSql(`supabase/agents-reserve/${version}-rollback.sql`));
    }
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
    await tx`ALTER TABLE swarm.household_hosted_content_restrictions ADD CONSTRAINT ${tx(newerFk.name)}
      FOREIGN KEY(grant_id,workspace_id,owner_user_id)
      REFERENCES swarm.hosted_mcp_grant_workspaces(grant_id,workspace_id,owner_user_id)`;
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
  for (const field of ["seat", "handle"]) assert.ok(oldRevoked[0]![field].revoked_at);
  assert.equal(oldRevoked[0]!.principal.revoked_at,null,"account identity survives target seat removal");
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
  for (const field of ["seat", "handle"]) assert.ok(sameRevoked[0]![field].revoked_at);
  assert.equal(sameRevoked[0]!.principal.revoked_at,null);
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
    const fixture = await seedHostedFixture(false, true);
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
    for (const field of ["seat", "handle"]) assert.ok(rows[0]![field].revoked_at);
    assert.equal(rows[0]!.principal.revoked_at,null);
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
    assert.deepEqual(tombstones.map(row => row.kind), ["hosted_seat"]);
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
    assert.equal(await providerActive(fixture.grantA), true,"dormant connection remains live");
    assert.equal(await providerRefresh(fixture), true,"refresh does not grant a removed workspace");
    // Even successful refresh in a surviving workspace cannot regain A.
    const afterRefresh = runHostedHarness<HarnessResult>({ operation: "claim",
      claim: claimSpec(fixture, fixture.grantA, fixture.workspaceA, `refresh-${randomUUID()}`) });
    assert.equal(afterRefresh.status, 403);
    const [grant] = await sql<{ state: string }[]>`SELECT state FROM swarm.hosted_mcp_grants
      WHERE grant_id = ${fixture.grantA}::uuid`;
    assert.equal(grant?.state, "active", "OAuth retirement does not rewrite authority grants");
    const families = await sql`SELECT 1 FROM commonswarm_oauth.refresh_family_tombstones
      WHERE grant_id = ${`provider-${fixture.grantA}`}`;
    assert.equal(families.length, 0);
    if (otherConsent !== "live") {
      const artifacts = await sql`SELECT 1 FROM commonswarm_oauth.provider_artifacts
        WHERE grant_id = ${`provider-${fixture.grantA}`}`;
      assert.ok(artifacts.length > 0, "dormant refresh artifacts remain usable for explicit re-add");
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
  const fixture = await seedHostedFixture(false, true);
  const name = `refresh-race-${randomUUID()}`;
  const old = claimSeat(fixture, fixture.grantA, name);
  await sql`UPDATE swarm.hosted_mcp_grant_workspaces SET revoked_at = statement_timestamp()
    WHERE grant_id = ${fixture.grantA}::uuid AND workspace_id = ${fixture.workspaceB}::uuid`;
  let removalCommitted = false;
  assert.equal(await providerRefresh(fixture, { afterAdmission: async () => {
    const removed = runHostedHarness<HarnessResult>({ operation: "public", ownerJwt: fixture.ownerJwt,
      workspaceId: fixture.workspaceA,
      command: { kind: "revoke_agent_principal", principal_id: old.body.principal_id } });
    assert.equal(removed.body.status, "accepted");
    removalCommitted = true;
  } }), true, "successor preserves the dormant connection without workspace authority");
  assert.equal(removalCommitted, true, "refresh was admitted before committed removal");
  await assertSeatAccess(fixture, old, fixture.workspaceA, 403);
  const refused = runHostedHarness<HarnessResult>({ operation: "claim",
    claim: claimSpec(fixture, fixture.grantA, fixture.workspaceA, name) });
  assert.equal(refused.status, 403, "current consent gate denies the raced successor");
  assert.equal(await providerRefresh(fixture), true, "next refresh preserves dormant family continuity");
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

test("production edge login edits policy and removes hosted principal with command role only", { timeout: 120_000 }, async () => {
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
    const policy = runHostedHarness<HarnessResult>({ operation: "public", ownerJwt: fixture.ownerJwt,
      workspaceId: fixture.workspaceA, command: { kind: "set_connection_expiry", connection_kind: "hosted",
        grant_id: fixture.grantA, connection_expires_at: new Date(Date.now()+86400000).toISOString() } },
      { databaseUrl: edgeUrl.href });
    assert.equal(policy.status, 200, "canonical policy needs only the production command role");
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
      SELECT p.principal_id, coalesce(p.revoked_at, am.revoked_at) AS revoked_at
      FROM swarm.agent_principals p
      JOIN swarm.agent_workspace_memberships am USING (principal_id, workspace_id)
      WHERE p.workspace_id = ${fixture.workspaceA}::uuid AND p.name = ${name}
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
  // A familyless legacy token can only be cleared by residual cleanup, so this
  // local control catches accidentally skipping that helper for every target.
  const device = randomUUID(), run = randomUUID(), token = randomUUID(), lineage = randomUUID();
  await sql`INSERT INTO swarm.devices(device_id,user_id,label)
    VALUES(${device}::uuid,${fixture.owner}::uuid,'Local removal residual')`;
  await sql`INSERT INTO swarm.agent_runs(run_id,principal_id,device_id)
    VALUES(${run}::uuid,${localPrincipal!.principal_id}::uuid,${device}::uuid)`;
  await sql`INSERT INTO swarm.agent_tokens(token_id,principal_id,run_id,task_id,epoch,scopes,token_hash,expires_at,lineage_id)
    VALUES(${token}::uuid,${localPrincipal!.principal_id}::uuid,${run}::uuid,${randomUUID()}::uuid,1,
      ${sql.json(['post_signal'])},${randomBytes(32)},clock_timestamp()+interval '1 hour',${lineage}::uuid)`;
  const [residualBefore] = await sql`SELECT revoked_at,renewal_grant_id FROM swarm.agent_tokens WHERE token_id=${token}::uuid`;
  assert.deepEqual(residualBefore, { revoked_at: null, renewal_grant_id: null });
  const revoked = runHostedHarness<HarnessResult>({ operation: "public", ownerJwt: fixture.ownerJwt,
    workspaceId: fixture.workspaceA,
    command: { kind: "revoke_agent_principal", principal_id: localPrincipal!.principal_id } });
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
  assert.equal(revoked.body.status, "accepted");
  const [residualAfter] = await sql`SELECT revoked_at FROM swarm.agent_tokens WHERE token_id=${token}::uuid`;
  assert.ok(residualAfter?.revoked_at);
  const residualFences = await sql`SELECT kind FROM swarm.revocation_tombstones
    WHERE (kind='token' AND target_id=${token}::uuid) OR (kind='lineage' AND target_id=${lineage}::uuid) ORDER BY kind`;
  assert.deepEqual(residualFences.map(row => row.kind), ['lineage','token']);
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

// The normal server harness applies the complete historical chain. These probes
// inspect that migrated database without replaying DDL over the shared schemas.
// Narrow Allow ACL decision: 8b477b1655ac;
// deploy/release-proofs/permanence/20261019000007-catalog.sql:1-10,48-50.
test("connection policy storage preserves nullable shape and exact existing ACLs", async () => {
  const columns = await sql<{ table_name: string; column_name: string; type: string; nullable: boolean; has_default: boolean; column_acl: string | null }[]>`
    SELECT a.attrelid::regclass::text AS table_name, a.attname::text AS column_name,
      format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable,
      a.atthasdef AS has_default, a.attacl::text AS column_acl
    FROM pg_attribute a
    WHERE (a.attrelid IN ('swarm.hosted_mcp_grants'::regclass, 'swarm.renewal_grants'::regclass)
        AND a.attname IN ('connection_expires_at', 'connection_expired_at'))
      OR (a.attrelid = 'swarm.household_content_connections'::regclass AND a.attname = 'renewal_grant_id')
    ORDER BY table_name, column_name`;
  assert.deepEqual([...columns], [
    ...["connection_expired_at", "connection_expires_at"].map(column_name => ({
      table_name: "swarm.hosted_mcp_grants", column_name, type: "timestamp with time zone",
      nullable: true, has_default: false, column_acl: null,
    })),
    { table_name: "swarm.household_content_connections", column_name: "renewal_grant_id",
      type: "uuid", nullable: true, has_default: false, column_acl: "{swarm_command=w/swarm_admin}" },
    ...["connection_expired_at", "connection_expires_at"].map(column_name => ({
      table_name: "swarm.renewal_grants", column_name, type: "timestamp with time zone",
      nullable: true, has_default: false, column_acl: null,
    })),
  ]);
  const relations = await sql<{ name: string; owner: string; rls: boolean; grants: string[] }[]>`
    SELECT c.oid::regclass::text AS name, pg_get_userbyid(c.relowner) AS owner,
      c.relrowsecurity AS rls, ARRAY(
        SELECT pg_get_userbyid(p.grantee) || ':' || p.privilege_type || ':' || p.is_grantable::text
        FROM aclexplode(c.relacl) p WHERE p.grantee <> c.relowner
        ORDER BY 1
      ) AS grants
    FROM pg_class c WHERE c.oid IN ('swarm.hosted_mcp_grants'::regclass,
      'swarm.renewal_grants'::regclass, 'swarm.household_content_connections'::regclass,
      'commonswarm_oauth.registered_clients'::regclass) ORDER BY name`;
  assert.deepEqual([...relations], [
    { name: "commonswarm_oauth.registered_clients", owner: "swarm_admin", rls: true,
      grants: ["DELETE", "INSERT", "SELECT", "UPDATE"].map(p => `commonswarm_oauth_runtime:${p}:false`) },
    { name: "swarm.hosted_mcp_grants", owner: "swarm_admin", rls: true,
      grants: ["INSERT", "SELECT", "UPDATE"].map(p => `swarm_command:${p}:false`) },
    { name: "swarm.household_content_connections", owner: "swarm_admin", rls: true,
      grants: ["INSERT", "SELECT"].map(p => `swarm_command:${p}:false`) },
    { name: "swarm.renewal_grants", owner: "swarm_admin", rls: true,
      grants: ["INSERT", "SELECT", "UPDATE"].map(p => `swarm_command:${p}:false`) },
  ]);
  const contentColumnGrants = await sql<{ column_name: string; role: string; privilege: string; grantable: boolean }[]>`
    SELECT a.attname::text AS column_name, pg_get_userbyid(p.grantee) AS role,
      p.privilege_type AS privilege, p.is_grantable AS grantable
    FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) p
    WHERE a.attrelid = 'swarm.household_content_connections'::regclass ORDER BY column_name, role, privilege`;
  assert.deepEqual([...contentColumnGrants], ["connection_id", "consent_receipt_id", "expires_at", "operations", "renewal_grant_id", "revoked_at"]
    .map(column_name => ({ column_name, role: "swarm_command", privilege: "UPDATE", grantable: false })));
  const functions = await sql<{ signature: string; owner: string; grants: string[] }[]>`
    SELECT p.oid::regprocedure::text AS signature, pg_get_userbyid(p.proowner) AS owner,
      ARRAY(SELECT pg_get_userbyid(a.grantee) || ':' || a.privilege_type || ':' || a.is_grantable::text
        FROM aclexplode(p.proacl) a WHERE a.grantee <> p.proowner ORDER BY 1) AS grants
    FROM pg_proc p WHERE p.oid IN (
      'commonswarm_oauth.resolve_hosted_grant_status(text)'::regprocedure,
      'swarm.prepare_renewal_grant(uuid,uuid)'::regprocedure,
      'swarm.record_renewal_grant_use(uuid,uuid,text)'::regprocedure,
      'swarm.resolve_hosted_grant_authorization(uuid,uuid,uuid,text)'::regprocedure,
      'swarm.resolve_hosted_seat_command_authorization(uuid,text,text)'::regprocedure,
      'swarm.resolve_hosted_seat_read_authorization(uuid,text,text)'::regprocedure
    ) ORDER BY signature`;
  assert.deepEqual([...functions], [
    ["commonswarm_oauth.resolve_hosted_grant_status(text)", "commonswarm_oauth_runtime"],
    ["swarm.prepare_renewal_grant(uuid,uuid)", "swarm_command"],
    ["swarm.record_renewal_grant_use(uuid,uuid,text)", "swarm_command", "swarm_read"],
    ["swarm.resolve_hosted_grant_authorization(uuid,uuid,uuid,text)", "swarm_command"],
    ["swarm.resolve_hosted_seat_command_authorization(uuid,text,text)", "swarm_command"],
    ["swarm.resolve_hosted_seat_read_authorization(uuid,text,text)", "swarm_read"],
  ].map(([signature, ...roles]) => ({ signature, owner: "swarm_admin", grants: roles.map(role => `${role}:EXECUTE:false`) })));
  const [shape] = await sql<{ fk: boolean; dcr: boolean; bearer: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM pg_constraint c
      WHERE c.conrelid = 'swarm.household_content_connections'::regclass AND c.contype = 'f'
        AND c.confrelid = 'swarm.renewal_grants'::regclass AND c.convalidated
        AND NOT c.condeferrable AND c.confupdtype = 'a' AND c.confdeltype = 'a'
        AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = c.conrelid AND attname = 'renewal_grant_id')]
        AND c.confkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = c.confrelid AND attname = 'renewal_grant_id')]) AS fk,
      (SELECT NOT attnotnull AND atthasdef FROM pg_attribute
        WHERE attrelid = 'commonswarm_oauth.registered_clients'::regclass AND attname = 'expires_at') AS dcr,
      (SELECT attnotnull FROM pg_attribute WHERE attrelid = 'swarm.agent_tokens'::regclass AND attname = 'expires_at') AS bearer`;
  assert.deepEqual(shape, { fk: true, dcr: true, bearer: true });
  const indexes = await sql<{ table_name: string; key: string; predicate: string; valid: boolean }[]>`
    SELECT i.indrelid::regclass::text AS table_name, a.attname::text AS key,
      pg_get_expr(i.indpred, i.indrelid) AS predicate,
      i.indisvalid AND i.indisready AND NOT i.indisunique AND i.indnkeyatts = 1 AND i.indnatts = 1 AS valid
    FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
    WHERE i.indrelid IN ('swarm.hosted_mcp_grants'::regclass, 'swarm.renewal_grants'::regclass)
      AND a.attname = 'connection_expires_at' ORDER BY table_name`;
  assert.deepEqual([...indexes], ["swarm.hosted_mcp_grants", "swarm.renewal_grants"].map(table_name => ({
    table_name, key: "connection_expires_at",
    predicate: "((connection_expires_at IS NOT NULL) AND (connection_expired_at IS NULL))", valid: true,
  })));
});

// Revised R02-hosted 3/198, COMMONSWARM-RELEASE-CONFLICT-RULINGS-20261027.md:
// exercise the independent nullable FK behind the binding guard only inside an
// owned disposable clone. Capture and restore the exact installed guard.
test("00002 nullable approval FK holds behind the installed binding guard in an owned clone", async()=>{
  const isolated=await adminEdgeDatabase(local.DB_URL);
  try {
    await isolated.db.begin(async tx=>{
      const [database]=await tx`SELECT current_database() AS name`;
      assert.match(database!.name,/^admin_edge_[a-f0-9]{32}$/);
      const guardQuery=()=>tx`SELECT pg_get_triggerdef(oid) AS ddl,tgfoid,tgenabled
        FROM pg_trigger WHERE tgrelid='swarm.household_content_connections'::regclass
          AND tgname='aa_household_local_family_binding' AND NOT tgisinternal`;
      const [guard]=await guardQuery();
      assert.equal(guard?.tgenabled,'O','installed binding guard is enabled');
      const [catalog]=await tx`SELECT EXISTS (SELECT 1 FROM pg_constraint c
        WHERE c.conrelid='swarm.household_content_connections'::regclass AND c.contype='f'
          AND c.confrelid='swarm.renewal_grants'::regclass AND c.convalidated
          AND NOT c.condeferrable AND c.confupdtype='a' AND c.confdeltype='a'
          AND c.conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=c.conrelid AND attname='renewal_grant_id')]
          AND c.confkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=c.confrelid AND attname='renewal_grant_id')]) AS fk,
        (SELECT NOT attnotnull FROM pg_attribute WHERE attrelid='swarm.household_content_connections'::regclass
          AND attname='renewal_grant_id') AS nullable`;
      assert.deepEqual(catalog,{fk:true,nullable:true});
      const owner=randomUUID(),workspace=randomUUID(),principal=randomUUID(),run=randomUUID(),device=randomUUID(),family=randomUUID(),connection=randomUUID();
      await tx`INSERT INTO auth.users(id,aud,role,email) VALUES(${owner}::uuid,'authenticated','authenticated',${owner+'@example.test'})`;
      await tx`INSERT INTO swarm.users(user_id,display_name) VALUES(${owner}::uuid,'Compatibility owner')`;
      await tx`INSERT INTO swarm.workspaces(workspace_id,name,created_by) VALUES(${workspace}::uuid,'Compatibility',${owner}::uuid)`;
      await tx`INSERT INTO swarm.memberships(workspace_id,user_id,role) VALUES(${workspace}::uuid,${owner}::uuid,'owner')`;
      await tx`INSERT INTO swarm.devices(device_id,user_id,label) VALUES(${device}::uuid,${owner}::uuid,'Compatibility')`;
      await tx`INSERT INTO swarm.agent_principals(principal_id,workspace_id,owner_user_id,name)
        VALUES(${principal}::uuid,${workspace}::uuid,${owner}::uuid,'Compatibility')`;
      await tx`INSERT INTO swarm.agent_runs(run_id,principal_id,device_id) VALUES(${run}::uuid,${principal}::uuid,${device}::uuid)`;
      await tx`INSERT INTO swarm.renewal_grants(renewal_grant_id,workspace_id,principal_id,run_id,created_by,horizon_expires_at,max_successors)
        VALUES(${family}::uuid,${workspace}::uuid,${principal}::uuid,${run}::uuid,${owner}::uuid,clock_timestamp()+interval '30 days',800)`;
      const receipt=randomUUID();
      await tx`INSERT INTO swarm.household_workspace_boundaries(workspace_id,purpose,owner_user_id) VALUES(${workspace}::uuid,'personal',${owner}::uuid)`;
      await tx`INSERT INTO swarm.household_member_content_roles(workspace_id,user_id,content_role,content_consent_id,confirmed_at)
        VALUES(${workspace}::uuid,${owner}::uuid,'editor',${receipt}::uuid,clock_timestamp())`;
      await tx`INSERT INTO swarm.household_content_connections(connection_id,grant_id,workspace_id,principal_id,owner_user_id,purpose,operations,consent_receipt_id,expires_at)
        VALUES(${connection}::uuid,${run}::uuid,${workspace}::uuid,${principal}::uuid,${owner}::uuid,'personal',ARRAY['read'],${receipt}::uuid,NULL)`;
      const assignment=(sp: postgres.TransactionSql)=>sp`UPDATE swarm.household_content_connections SET renewal_grant_id=${family}::uuid
        WHERE connection_id=${connection}::uuid RETURNING connection_id`;
      assert.equal((await tx`SELECT renewal_grant_id FROM swarm.household_content_connections WHERE connection_id=${connection}::uuid`)[0]!.renewal_grant_id,null);
      await assert.rejects(tx.savepoint(assignment),{code:'23514',message:'LOCAL_APPROVAL_BINDING_REFUSED'},
        'installed guard refuses this same binding without a matching token');
      await tx.unsafe('DROP TRIGGER aa_household_local_family_binding ON swarm.household_content_connections');
      await assert.rejects(tx.savepoint(sp=>sp`UPDATE swarm.household_content_connections SET renewal_grant_id=${randomUUID()}::uuid
        WHERE connection_id=${connection}::uuid`),{code:'23503'},'nullable FK still rejects a missing family');
      assert.equal((await assignment(tx)).length,1,'a valid referenced family can be assigned');
      await assert.rejects(tx.savepoint(sp=>sp`DELETE FROM swarm.renewal_grants WHERE renewal_grant_id=${family}::uuid`),
        {code:'55000',message:'SWARM_RENEWAL_GRANT_UNDELETABLE'},
        'Round 3 3/198: immutable families refuse deletion before the catalog-proven NO ACTION FK');
      assert.equal((await tx`SELECT renewal_grant_id FROM swarm.household_content_connections WHERE connection_id=${connection}::uuid`)[0]!.renewal_grant_id,family);
      await tx.unsafe(guard!.ddl);
      const [restored]=await guardQuery();
      assert.deepEqual(restored,guard,'guard definition, function and enabled state restored byte-identically');
    });
  } finally { await isolated.close(); }
});

test("ACTIVE NULL policy and nullable legacy approvals retain exact immutable family binding", async () => {
  const fixture = await seedHostedFixture();
  const rollback = new Error("rollback connection compatibility fixtures");
  await sql.begin(async tx => {
    const principal = randomUUID(), run = randomUUID(), renewal = randomUUID(), receipt = randomUUID(), device = randomUUID();
    await tx`INSERT INTO swarm.devices (device_id, user_id, label)
      VALUES (${device}::uuid, ${fixture.owner}::uuid, 'policy-compat-device')`;
    await tx`INSERT INTO swarm.agent_principals (principal_id, workspace_id, owner_user_id, name)
      VALUES (${principal}::uuid, ${fixture.workspaceA}::uuid, ${fixture.owner}::uuid, 'policy-local')`;
    await tx`INSERT INTO swarm.agent_runs (run_id, principal_id, device_id)
      VALUES (${run}::uuid, ${principal}::uuid, ${device}::uuid)`;
    await tx.unsafe("SET LOCAL ROLE swarm_command");
    await tx`INSERT INTO swarm.renewal_grants (renewal_grant_id, workspace_id, principal_id, run_id,
      created_by, horizon_expires_at, max_successors)
      VALUES (${renewal}::uuid, ${fixture.workspaceA}::uuid, ${principal}::uuid, ${run}::uuid,
        ${fixture.owner}::uuid, statement_timestamp() + interval '30 days', 800)`;
    const [localGrant] = await tx`SELECT kind, max_successors, connection_expires_at, connection_expired_at,
      horizon_expires_at > statement_timestamp() AS finite FROM swarm.renewal_grants WHERE renewal_grant_id = ${renewal}::uuid`;
    assert.deepEqual(localGrant, { kind: "timeboxed", max_successors: 800,
      connection_expires_at: null, connection_expired_at: null, finite: true });
    const [hosted] = await tx`SELECT connection_expires_at, connection_expired_at
      FROM swarm.hosted_mcp_grants WHERE grant_id = ${fixture.grantA}::uuid`;
    assert.deepEqual(hosted, { connection_expires_at: null, connection_expired_at: null });
    await tx.unsafe("RESET ROLE");
    await tx`INSERT INTO swarm.household_workspace_boundaries (workspace_id, purpose, owner_user_id)
      VALUES (${fixture.workspaceA}::uuid, 'personal', ${fixture.owner}::uuid)`;
    await tx`INSERT INTO swarm.household_member_content_roles (workspace_id, user_id, content_role, content_consent_id, confirmed_at)
      VALUES (${fixture.workspaceA}::uuid, ${fixture.owner}::uuid, 'editor', ${receipt}::uuid, statement_timestamp())`;
    const connection = randomUUID();
    await tx`INSERT INTO swarm.agent_tokens(token_id,principal_id,run_id,task_id,epoch,scopes,token_hash,expires_at,lineage_id,renewal_grant_id)
      VALUES(${connection}::uuid,${principal}::uuid,${run}::uuid,${randomUUID()}::uuid,1,'["post_signal"]'::jsonb,
        ${randomBytes(32)},clock_timestamp()+interval '1 hour',${randomUUID()}::uuid,${renewal}::uuid)`;
    await tx`INSERT INTO swarm.household_content_connections (connection_id, grant_id, workspace_id, principal_id,
      owner_user_id, purpose, operations, consent_receipt_id, expires_at)
      VALUES (${connection}::uuid, ${run}::uuid, ${fixture.workspaceA}::uuid, ${principal}::uuid,
        ${fixture.owner}::uuid, 'personal', ARRAY['read'], ${receipt}::uuid, NULL)`;
    const [approval] = await tx`SELECT renewal_grant_id FROM swarm.household_content_connections WHERE connection_id = ${connection}::uuid`;
    assert.equal(approval?.renewal_grant_id, null, "old approval INSERT omits the new FK");
    await tx`UPDATE swarm.household_content_connections SET renewal_grant_id = ${renewal}::uuid WHERE connection_id = ${connection}::uuid`;
    await assert.rejects(tx.savepoint(async sp => {
      await sp`UPDATE swarm.household_content_connections SET renewal_grant_id = ${randomUUID()}::uuid WHERE connection_id = ${connection}::uuid`;
    }), { code: "23514" }, "assigned family is immutable even when the proposed family is missing");
    const otherFamily=randomUUID();
    await tx`INSERT INTO swarm.renewal_grants(renewal_grant_id,workspace_id,principal_id,run_id,created_by,horizon_expires_at,max_successors)
      VALUES(${otherFamily}::uuid,${fixture.workspaceA}::uuid,${principal}::uuid,${run}::uuid,${fixture.owner}::uuid,clock_timestamp()+interval '30 days',800)`;
    await assert.rejects(tx.savepoint(sp=>sp`UPDATE swarm.household_content_connections SET renewal_grant_id=${otherFamily}::uuid WHERE connection_id=${connection}::uuid`),{code:'23514'},'another existing family cannot replace the bound one');
    await assert.rejects(tx.savepoint(sp=>sp`INSERT INTO swarm.household_content_connections
      (connection_id,grant_id,workspace_id,principal_id,owner_user_id,purpose,operations,consent_receipt_id,expires_at,renewal_grant_id)
      VALUES(${randomUUID()}::uuid,${run}::uuid,${fixture.workspaceA}::uuid,${principal}::uuid,${fixture.owner}::uuid,'personal',ARRAY['read'],${receipt}::uuid,NULL,${renewal}::uuid)`),
      {code:'23514'},'first binding requires a real matching token identity');
    const [linked] = await tx`SELECT renewal_grant_id FROM swarm.household_content_connections WHERE connection_id = ${connection}::uuid`;
    assert.equal(linked?.renewal_grant_id, renewal);
    // Store both independent terminal evidence and an optional deadline; this
    // slice adds no new pair/order policy or default to either grant family.
    const [hostedFence] = await tx`UPDATE swarm.hosted_mcp_grants SET connection_expires_at = statement_timestamp() + interval '1 day',
      connection_expired_at = statement_timestamp() WHERE grant_id = ${fixture.grantA}::uuid
      RETURNING connection_expires_at IS NOT NULL AND connection_expired_at IS NOT NULL AS stored`;
    assert.equal(hostedFence?.stored, true);
    const [localFence] = await tx`UPDATE swarm.renewal_grants SET connection_expired_at = statement_timestamp()
      WHERE renewal_grant_id = ${renewal}::uuid
      RETURNING connection_expires_at IS NULL AND connection_expired_at IS NOT NULL AS stored`;
    assert.equal(localFence?.stored, true);
    throw rollback;
  }).catch(error => { if (error !== rollback) throw error; });
  assert.equal(await providerActive(fixture.grantA), true, "NULL policy preserves old hosted authorization");
  await providerRefresh(fixture);
});

test("finite DCR registration lifecycle still uses the production store and runtime role", async () => {
  const requireService = createRequire(new URL("../../services/mcp-auth/package.json", import.meta.url));
  const { Pool } = requireService("pg");
  const pool = new Pool({ connectionString: oauthDatabaseUrl, max: 1 });
  const { createPostgresRegistrationStore } = await import(new URL(
    "../../services/mcp-auth/src/registration.js", import.meta.url).href);
  const store = createPostgresRegistrationStore(pool);
  const live = `compat-live-${randomUUID()}`, expired = `compat-expired-${randomUUID()}`, nullable = `compat-null-${randomUUID()}`;
  const metadata = { redirect_uris: ["https://example.test/callback"] };
  try {
    await store.upsert(live, metadata);
    assert.deepEqual(await store.find(live), metadata);
    await store.markUsed(live);
    const result = await pool.query(`SELECT last_used_at IS NOT NULL AS used,
      expires_at > statement_timestamp() + interval '29 days' AS finite
      FROM commonswarm_oauth.registered_clients WHERE client_id = $1`, [live]);
    assert.deepEqual(result.rows, [{ used: true, finite: true }]);
    await pool.query(`INSERT INTO commonswarm_oauth.registered_clients (client_id, metadata, registered_at, expires_at)
      VALUES ($1, '{}'::jsonb, statement_timestamp() - interval '2 days', statement_timestamp() - interval '1 day')`, [expired]);
    await assert.rejects(pool.query(`INSERT INTO commonswarm_oauth.registered_clients (client_id, metadata, expires_at)
      VALUES ($1, '{}'::jsonb, statement_timestamp() - interval '1 day')`, [`invalid-${randomUUID()}`]),
      { code: "23514" }, "finite expiry must still follow registration");
    await pool.query(`INSERT INTO commonswarm_oauth.registered_clients (client_id, metadata, expires_at)
      VALUES ($1, '{}'::jsonb, NULL)`, [nullable]);
    const [nullRow] = await oauthSql`SELECT expires_at FROM commonswarm_oauth.registered_clients WHERE client_id = ${nullable}`;
    assert.equal(nullRow?.expires_at, null, "new storage permits NULL without making any runtime retention claim");
    assert.equal(await store.find(expired), undefined);
    const listed = await store.list(1000);
    assert.ok(listed.some((row: { client_id: string }) => row.client_id === live));
    assert.ok(!listed.some((row: { client_id: string }) => row.client_id === expired));
    assert.ok((await store.cleanup()) >= 1);
    const removed = await pool.query("SELECT client_id FROM commonswarm_oauth.registered_clients WHERE client_id = $1", [expired]);
    assert.equal(removed.rows.length, 0);
    assert.deepEqual(await store.find(live), metadata, "same-invocation finite positive survives cleanup");
  } finally {
    for (const id of [live, expired, nullable]) await store.destroy(id);
    await pool.end();
  }
});

// S1b-H owner-boundary regressions: real migrated authority, real command HTTP,
// and the production OAuth login. No runtime or authentication bypass is added.
test("hosted policy immediately fences existing seat read/write/check and provider status", { timeout: 180_000 }, async () => {
  const f = await seedHostedFixture();
  const seat = claimSeat(f, f.grantA, `policy-${randomUUID()}`);
  await assertSeatAccess(f, seat, f.workspaceA, 200);
  assert.equal(await providerActive(f.grantA), true);
  await sql`UPDATE swarm.hosted_mcp_grants SET connection_expires_at=clock_timestamp()+interval '6 months'
    WHERE grant_id=${f.grantA}::uuid`;
  await assertSeatAccess(f, seat, f.workspaceA, 200);
  for (const fence of ["deadline", "terminal"] as const) {
    await sql`UPDATE swarm.hosted_mcp_grants
      SET connection_expires_at=${fence === "deadline" ? new Date(0) : null},
          connection_expired_at=${fence === "terminal" ? new Date() : null}
      WHERE grant_id=${f.grantA}::uuid`;
    await assertSeatAccess(f, seat, f.workspaceA, 403);
    assert.equal(await providerActive(f.grantA), false, fence);
    const refusedClaim = runHostedHarness<HarnessResult>({ operation: "claim",
      claim: claimSpec(f,f.grantA,f.workspaceA,`expired-${randomUUID()}`) });
    assert.equal(refusedClaim.status,403);
    assert.equal(refusedClaim.body.error,"hosted_grant_forbidden");
    assert.equal(await providerActive(f.grantB), true, "independent family stays live");
  }
});

test("owner policy HTTP records before/after once, extends and clears only a live hosted connection", { timeout: 180_000 }, async () => {
  const f = await seedHostedFixture(true);
  const set = (expiry: string | null, options: { jwt?: string; grant?: string; commandId?: string } = {}) =>
    runHostedHarness<HarnessResult>({ operation: "public", ownerJwt: options.jwt ?? f.ownerJwt,
      workspaceId: f.workspaceA, commandId: options.commandId,
      command: { kind: "set_connection_expiry", connection_kind: "hosted",
        grant_id: options.grant ?? f.grantA, connection_expires_at: expiry } });
  const future = new Date(Date.now() + 180 * 86400000).toISOString();
  const later = new Date(Date.now() + 360 * 86400000).toISOString();
  const commandId = randomUUID();
  const accepted = set(future, { commandId });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.previous_connection_expires_at, null);
  assert.equal(accepted.body.connection_expires_at, future);
  assert.equal(set(future, { commandId }).status, 200);
  const [receipt] = await sql`SELECT principal_id,response FROM swarm.idempotency_keys
    WHERE principal_kind='user' AND command_id=${commandId}`;
  assert.equal(receipt!.principal_id, f.owner);
  assert.equal(receipt!.response.previous_connection_expires_at, null);
  assert.equal(receipt!.response.connection_expires_at, future);
  const [audit] = await sql`SELECT count(*)::int n FROM swarm.audit_log
    WHERE workspace_id=${f.workspaceA}::uuid AND command_kind='set_connection_expiry' AND outcome='accepted'`;
  assert.equal(audit!.n, 1, "replay does not record a second policy change");
  assert.equal(set(later).status, 200);
  const staleOwner = runHostedHarness<HarnessResult>({ operation: "management", ownerUserId: f.owner,
    workspaceId: f.workspaceA, interactiveAuthAtSeconds: Math.floor(Date.now()/1000)-3600,
    command: { kind: "set_connection_expiry", connection_kind: "hosted", grant_id: f.grantA,
      connection_expires_at: null } });
  assert.equal(staleOwner.status, 200, "verified owner management identity needs no new AMR age");
  assert.equal(set(null).status, 200);
  assert.equal(set(future, { jwt: f.otherJwt }).status, 403, "foreign owner");
  assert.equal(set(future, { grant: f.grantB }).status, 403, "foreign target");
  assert.equal(set(new Date(0).toISOString()).status, 400);
  const agentSeat = claimSeat(f, f.grantA, `policy-agent-${randomUUID()}`);
  const agentEdit = runHostedHarness<HarnessResult>({ operation: "seat-command",
    seat: seatSpec(f, agentSeat), command: { kind: "set_connection_expiry", connection_kind: "hosted",
      grant_id: f.grantA, connection_expires_at: future } });
  assert.equal(agentEdit.status, 403, "a live agent seat cannot edit owner policy");
  await sql`INSERT INTO commonswarm_oauth.refresh_family_tombstones(grant_id,revoked_at)
    VALUES(${`provider-${f.grantB}`},clock_timestamp())`;
  assert.equal(runHostedHarness<HarnessResult>({ operation: "public", ownerJwt: f.otherJwt,
    workspaceId: f.workspaceA, command: { kind: "set_connection_expiry", connection_kind: "hosted",
      grant_id: f.grantB, connection_expires_at: future } }).status, 403, "security-fenced family");
  await sql`UPDATE swarm.hosted_mcp_grants SET state='pending',activated_at=NULL
    WHERE grant_id=${f.grantA}::uuid`;
  assert.equal(set(future).status, 403, "pending is not an editable approval");
  await sql`UPDATE swarm.hosted_mcp_grants SET state='active',activated_at=clock_timestamp(),
    connection_expires_at=clock_timestamp()-interval '1 second' WHERE grant_id=${f.grantA}::uuid`;
  assert.equal(set(null).status, 403, "elapsed cannot be cleared");
  assert.equal(set(later).status, 403, "elapsed cannot be extended");
  const [unchanged] = await sql`SELECT connection_expires_at < clock_timestamp() AS expired
    FROM swarm.hosted_mcp_grants WHERE grant_id=${f.grantA}::uuid`;
  assert.equal(unchanged!.expired, true);
  await sql`UPDATE swarm.hosted_mcp_grants SET connection_expires_at=NULL,connection_expired_at=clock_timestamp()
    WHERE grant_id=${f.grantA}::uuid`;
  assert.equal(set(null).status, 403, "terminal fence survives even with NULL deadline");
});

test("runtime hosted-family helper binds its tuple and exposes no edge authority bridge", async () => {
  const f = await seedHostedFixture();
  const resource = "https://mcp.commonswarm.com/mcp";
  const lock = (owner = f.owner, client = "test-client", target = resource) => oauthSql.begin(tx => tx`
    SELECT * FROM commonswarm_oauth.lock_hosted_family(${`provider-${f.grantA}`},${owner}::uuid,${client},${target})`);
  assert.equal((await lock()).length, 0, "missing immutable provider binding fails closed");
  await assert.rejects(sql`INSERT INTO commonswarm_oauth.provider_grant_resources
    (provider_grant_id,resource,grant_class,owner_user_id,client_id,connection_id,hosted_grant_id)
    VALUES (${`provider-${f.grantA}`},${resource},'hosted_mcp',${f.owner}::uuid,'wrong-client',${f.grantA}::uuid,${f.grantA}::uuid)`,
    (error: unknown) => error instanceof postgres.PostgresError && error.code === "23514",
    "real immutable binding guard refuses a mismatched stored tuple");
  assert.equal((await lock()).length, 0, "failed mismatched binding cannot admit the family");
  await sql`INSERT INTO commonswarm_oauth.provider_grant_resources
    (provider_grant_id,resource,grant_class,owner_user_id,client_id,connection_id,hosted_grant_id)
    VALUES (${`provider-${f.grantA}`},${resource},'hosted_mcp',${f.owner}::uuid,'test-client',${f.grantA}::uuid,${f.grantA}::uuid)`;
  assert.equal((await lock())[0]!.active, true, "same-call exact stored binding positive");
  assert.equal((await lock(f.other)).length, 0);
  assert.equal((await lock(f.owner, "wrong-client")).length, 0);
  assert.equal((await lock(f.owner, "test-client", "https://api.commonswarm.com/admin")).length, 0);
  await assert.rejects(sql.begin(async tx => {
    await tx.unsafe("SET LOCAL ROLE swarm_command");
    await tx`SELECT * FROM commonswarm_oauth.lock_hosted_family(${`provider-${f.grantA}`},${f.owner}::uuid,'test-client',${resource})`;
  }), (e: unknown) => e instanceof postgres.PostgresError && e.code === "42501");
  await assert.rejects(oauthSql.begin(tx => tx`UPDATE swarm.hosted_mcp_grants SET connection_expires_at=NULL
    WHERE grant_id=${f.grantA}::uuid`), (e: unknown) => e instanceof postgres.PostgresError && e.code === "42501");
  const [shape] = await sql`SELECT p.provolatile,p.prosecdef,p.proconfig,pg_get_userbyid(p.proowner) AS owner,
    ARRAY(SELECT pg_get_userbyid(a.grantee)||':'||a.privilege_type FROM aclexplode(p.proacl) a
      WHERE a.grantee<>p.proowner ORDER BY 1) AS grants
    FROM pg_proc p WHERE p.oid='commonswarm_oauth.lock_hosted_family(text,uuid,text,text)'::regprocedure`;
  assert.equal(shape!.provolatile, "v");
  assert.equal(shape!.prosecdef, true);
  assert.equal(shape!.owner, "swarm_admin");
  assert.deepEqual(shape!.proconfig, ["search_path=pg_catalog"]);
  assert.deepEqual(shape!.grants, ["commonswarm_oauth_runtime:EXECUTE"]);
  await sql`UPDATE swarm.hosted_mcp_grants SET state='pending',activated_at=NULL WHERE grant_id=${f.grantA}::uuid`;
  const [pending] = await lock();
  assert.equal(pending!.state, "pending");
  assert.equal(pending!.active, false);
});

async function waitForRuntimeLock(tx: postgres.TransactionSql<Record<string, unknown>>): Promise<void> {
  const [gate] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
  const deadline = performance.now()+3500;
  do {
    // The gate retains its transaction; this pool query uses another session
    // and an autocommit activity snapshot for every observation.
    const [probe] = await sql<{ blocked: boolean }[]>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
      WHERE usename='commonswarm_oauth_runtime' AND ${gate!.pid}::int=ANY(pg_blocking_pids(pid))) AS blocked`;
    if (probe!.blocked) return;
    await new Promise(resolve => setTimeout(resolve,20));
  } while (performance.now()<deadline);
  assert.fail("runtime helper did not reach its exact selected workspace blocker");
}

async function waitForStoredDeadline(grantId: string, expected: Date): Promise<void> {
  const stop = performance.now()+3500;
  do {
    const [row] = await sql<{ deadline: Date; now: Date; elapsed: boolean }[]>`
      SELECT connection_expires_at AS deadline,clock_timestamp() AS now,
        connection_expires_at<=clock_timestamp() AS elapsed FROM swarm.hosted_mcp_grants
      WHERE grant_id=${grantId}::uuid`;
    assert.equal(row!.deadline.getTime(),expected.getTime(),"stored chosen date stays unchanged");
    if (row!.elapsed && row!.now.getTime()>=row!.deadline.getTime()) return;
    await new Promise(resolve => setTimeout(resolve,20));
  } while (performance.now()<stop);
  assert.fail("actual stored owner deadline did not elapse");
}

test("runtime helper uses current policy after waiting on a selected workspace stream", { timeout: 30_000 }, async () => {
  const f = await seedHostedFixture(false, true);
  const lock = () => oauthSql.begin(tx => tx`SELECT * FROM commonswarm_oauth.lock_hosted_family(
    ${`provider-${f.grantA}`},${f.owner}::uuid,'test-client','https://mcp.commonswarm.com/mcp')`);
  assert.equal((await lock())[0]!.active, true, "positive runtime control");
  let waiting: ReturnType<typeof lock> | undefined;
  const [chosen] = await sql<{ deadline: Date; future: boolean }[]>`
    UPDATE swarm.hosted_mcp_grants SET connection_expires_at=date_trunc('milliseconds',clock_timestamp())+interval '2 seconds'
    WHERE grant_id=${f.grantA}::uuid RETURNING connection_expires_at AS deadline,connection_expires_at>clock_timestamp() AS future`;
  assert.equal(chosen!.future,true,"chosen owner date is initially future");
  await sql.begin(async tx => {
    await tx`SELECT stream_id FROM swarm.streams WHERE stream_id=${f.streamB}::uuid FOR UPDATE`;
    waiting = lock();
    // Starting the promise acquires the production runtime connection immediately.
    await waitForRuntimeLock(tx);
    await waitForStoredDeadline(f.grantA,chosen!.deadline);
  });
  const [afterWait] = await waiting!;
  assert.equal(afterWait!.active, false, "a pre-wait clock cannot admit an elapsed policy");
  assert.equal(await providerActive(f.grantB), true);
});

test("member removal fences exact hosted consent and restoration cannot revive old handles", { timeout: 180_000 }, async () => {
  const f = await seedHostedFixture(true);
  await sql`UPDATE swarm.memberships SET role='owner' WHERE user_id=${f.other}::uuid`;
  const old = claimSeat(f, f.grantA, `member-remove-${randomUUID()}`);
  const otherWorkspace = runHostedHarness<HarnessResult>({ operation: "claim",
    claim: claimSpec(f, f.grantA, f.workspaceB, `member-other-${randomUUID()}`) });
  await assertSeatAccess(f, old, f.workspaceA, 200);
  const removed = runHostedHarness<HarnessResult>({ operation: "public", ownerJwt: f.otherJwt,
    workspaceId: f.workspaceA, command: { kind: "remove_member", user_id: f.owner } });
  assert.equal(removed.status, 200);
  const editCommandId = randomUUID();
  const removedEdit = runHostedHarness<HarnessResult>({ operation: "public", ownerJwt: f.ownerJwt,
    commandId: editCommandId, workspaceId: f.workspaceA, command: { kind: "set_connection_expiry", connection_kind: "hosted",
      grant_id: f.grantA, connection_expires_at: null } });
  assert.equal(removedEdit.status, 200, "live other selected workspace permits owner policy edit");
  const [routeReceipt] = await sql`SELECT workspace_id FROM swarm.idempotency_keys
    WHERE principal_kind='user' AND principal_id=${f.owner} AND command_id=${editCommandId}`;
  assert.equal(routeReceipt!.workspace_id, f.workspaceB, "ledger uses the derived live workspace");
  assert.equal(runHostedHarness<HarnessResult>({ operation: "public", ownerJwt: f.otherJwt,
    workspaceId: f.workspaceA, command: { kind: "set_connection_expiry", connection_kind: "hosted",
      grant_id: f.grantA, connection_expires_at: null } }).status, 403, "foreign owner remains refused");
  await sql`UPDATE swarm.memberships SET revoked_at=NULL WHERE workspace_id=${f.workspaceA}::uuid AND user_id=${f.owner}::uuid`;
  await assertSeatAccess(f, old, f.workspaceA, 403);
  const refusedClaim = runHostedHarness<HarnessResult>({ operation: "claim",
    claim: claimSpec(f,f.grantA,f.workspaceA,`restored-${randomUUID()}`) });
  assert.equal(refusedClaim.status,403);
  assert.equal(refusedClaim.body.error,"hosted_grant_forbidden");
  await assertSeatAccess(f, otherWorkspace, f.workspaceB, 200);
  assert.equal(await providerActive(f.grantA), true, "unrelated approved workspace survives");
  const [fences] = await sql`SELECT c.revoked_at IS NOT NULL AS consent,
    hs.revoked_at IS NOT NULL AS seat,h.revoked_at IS NOT NULL AS handle,
    EXISTS(SELECT 1 FROM swarm.revocation_tombstones t WHERE t.kind='hosted_seat' AND t.target_id=hs.seat_id) AS tombstone
    FROM swarm.hosted_mcp_grant_workspaces c JOIN swarm.hosted_mcp_seats hs USING(grant_id,workspace_id)
    JOIN swarm.hosted_mcp_seat_handles h USING(seat_id)
    WHERE hs.seat_id=${String(old.body.seat_id)}::uuid`;
  assert.deepEqual(fences, { consent: true, seat: true, handle: true, tombstone: true });
  assert.equal(runHostedHarness<HarnessResult>({ operation: "public", ownerJwt: f.otherJwt,
    workspaceId: f.workspaceB, command: { kind: "remove_member", user_id: f.owner } }).status, 200);
  assert.equal(runHostedHarness<HarnessResult>({ operation: "public", ownerJwt: f.ownerJwt,
    workspaceId: f.workspaceA, command: { kind: "set_connection_expiry", connection_kind: "hosted",
      grant_id: f.grantA, connection_expires_at: null } }).status, 403, "all selected consents removed");
});


test("authorized admin routine removal scopes hosted presence to the target identity and workspace", { timeout: 180_000 }, async () => {
  // Top-level tests in this file run serially. Redirect only this lifecycle to
  // the existing isolated fixture, whose real cutover cannot open the shared DB.
  const shared = { sql, oauthSql, databaseUrl: local.DB_URL, oauthDatabaseUrl, adminIssuerDatabaseUrl };
  const cutoverBefore = await shared.sql`SELECT * FROM commonswarm_oauth.admin_cutover_state WHERE singleton`;
  const isolated = await adminEdgeDatabase(local.DB_URL);
  const inIsolatedDatabase = (value: string) => {
    const target = new URL(value);
    target.pathname = new URL(isolated.url).pathname;
    return target.href;
  };
  let isolatedRuntime: postgres.Sql | undefined;
  try {
    sql = isolated.db;
    local.DB_URL = inIsolatedDatabase(shared.databaseUrl);
    oauthDatabaseUrl = inIsolatedDatabase(shared.oauthDatabaseUrl);
    adminIssuerDatabaseUrl = inIsolatedDatabase(shared.adminIssuerDatabaseUrl);
    isolatedRuntime = postgres(oauthDatabaseUrl, { prepare: false, max: 1 });
    oauthSql = isolatedRuntime;
    const [configuration] = await shared.sql`SELECT value FROM swarm.config WHERE key='min_client_version'`;
    assert.ok(configuration, "shared fixture has the minimum client version");
    await sql`INSERT INTO swarm.config(key,value) VALUES('min_client_version',${sql.json(configuration.value)})`;
    const f = await seedHostedFixture(false, false, true);
    const old = claimSeat(f, f.grantA, `admin-remove-${randomUUID()}`);
    const sibling = claimSeat(f, f.grantA, `admin-sibling-${randomUUID()}`);
    const unrelatedGrant = claimSeat(f, f.grantB, `admin-independent-${randomUUID()}`);
    await assertSeatAccess(f, sibling, f.workspaceA, 200);
    const other = runHostedHarness<HarnessResult>({ operation: "claim",
      claim: claimSpec(f, f.grantA, f.workspaceB, `admin-other-${randomUUID()}`) });
    await assertSeatAccess(f, old, f.workspaceA, 200);
    const otherBefore = await hostedRows(other.body.seat_id);
    const removed = runHostedHarness<{ status: number; stage: string }>({ operation: "admin-removal",
      ownerUserId: f.owner, workspaceId: f.workspaceA, principalId: old.body.principal_id });
    assert.deepEqual(removed, { stage: "remove", status: 200 });
    const rows = await hostedRows(old.body.seat_id);
    for (const field of ["seat", "handle"]) assert.ok(rows[0]![field].revoked_at);
    assert.equal(rows[0]!.principal.revoked_at,null);
    const principalFence = await sql`SELECT kind FROM swarm.revocation_tombstones
      WHERE kind='principal' AND target_id=${String(old.body.principal_id)}::uuid`;
    assert.deepEqual(principalFence.map(row => row.kind), []);
    await assertSeatAccess(f, old, f.workspaceA, 403);
    const refusedClaim = runHostedHarness<HarnessResult>({ operation: "claim",
      claim: claimSpec(f,f.grantA,f.workspaceA,`admin-new-${randomUUID()}`) });
    assert.equal(refusedClaim.status,200,"another live identity retains original workspace approval");
    await assertSeatAccess(f, sibling, f.workspaceA, 200);
    await assertSeatAccess(f, unrelatedGrant, f.workspaceA, 200, f.grantB);
    const [siblingFence] = await sql`SELECT hs.revoked_at IS NOT NULL AS seat,h.revoked_at IS NOT NULL AS handle,
      EXISTS(SELECT 1 FROM swarm.revocation_tombstones t WHERE t.kind='hosted_seat' AND t.target_id=hs.seat_id) AS tombstone
      FROM swarm.hosted_mcp_seats hs JOIN swarm.hosted_mcp_seat_handles h USING(seat_id)
      WHERE hs.seat_id=${String(sibling.body.seat_id)}::uuid`;
    assert.deepEqual(siblingFence, { seat: false, handle: false, tombstone: false });
    await assertSeatAccess(f, other, f.workspaceB, 200);
    assert.deepEqual(await hostedRows(other.body.seat_id), otherBefore, "other workspace history survives admin removal");
    assert.equal(await providerActive(f.grantA), true);
    const [fence] = await sql`SELECT c.revoked_at IS NOT NULL AS consent,h.revoked_at IS NOT NULL AS handle,
      EXISTS(SELECT 1 FROM swarm.revocation_tombstones t WHERE t.kind='hosted_seat' AND t.target_id=h.seat_id) AS tombstone
      FROM swarm.hosted_mcp_grant_workspaces c JOIN swarm.hosted_mcp_seat_handles h USING(grant_id,workspace_id)
      WHERE h.seat_id=${String(old.body.seat_id)}::uuid`;
    assert.deepEqual(fence, { consent: false, handle: true, tombstone: true });
  } finally {
    sql = shared.sql;
    oauthSql = shared.oauthSql;
    local.DB_URL = shared.databaseUrl;
    oauthDatabaseUrl = shared.oauthDatabaseUrl;
    adminIssuerDatabaseUrl = shared.adminIssuerDatabaseUrl;
    try { await isolatedRuntime?.end(); } finally { await isolated.close(); }
    const cutoverAfter = await shared.sql`SELECT * FROM commonswarm_oauth.admin_cutover_state WHERE singleton`;
    assert.deepEqual(cutoverAfter, cutoverBefore, "isolated issuance never changes the shared cutover gate");
  }
});


for (const order of ["remove-first", "activate-first"] as const) {
  test(`activation versus member removal uses fresh post-grant facts: ${order}`, { timeout: 120_000 }, async () => {
    const f = await seedHostedFixture(true);
    await sql`UPDATE swarm.memberships SET role='owner' WHERE user_id=${f.other}::uuid`;
    await sql`UPDATE swarm.hosted_mcp_grants SET state='pending',activated_at=NULL WHERE grant_id=${f.grantA}::uuid`;
    const result = runHostedHarness<{ activated: HarnessResult; removed: HarnessResult }>({
      operation: "activation-removal", order, ownerUserId: f.owner, otherJwt: f.otherJwt,
      workspaceA: f.workspaceA, workspaceB: f.workspaceB, grantId: f.grantA });
    assert.equal(result.removed.status, 200);
    assert.equal(result.activated.status, order === "remove-first" ? 409 : 200);
    await sql`UPDATE swarm.memberships SET revoked_at=NULL
      WHERE workspace_id=${f.workspaceB}::uuid AND user_id=${f.owner}::uuid`;
    const [consent] = await sql`SELECT revoked_at IS NOT NULL AS revoked FROM swarm.hosted_mcp_grant_workspaces
      WHERE grant_id=${f.grantA}::uuid AND workspace_id=${f.workspaceB}::uuid`;
    assert.equal(consent!.revoked, true, "membership restoration cannot restore consent");
    assert.equal(await providerActive(f.grantA), order === "activate-first");
    assert.equal(await providerActive(f.grantB), true, "other owner and family survive");
  });
}

test("owner cannot clear a deadline that passes while the grant lock is awaited", { timeout: 120_000 }, async () => {
  const f = await seedHostedFixture();
  const positive = runHostedHarness<HarnessResult>({ operation: "public", ownerJwt: f.ownerJwt,
    workspaceId: f.workspaceA, command: { kind: "set_connection_expiry", connection_kind: "hosted",
      grant_id: f.grantA, connection_expires_at: new Date(Date.now()+86400000).toISOString() } });
  assert.equal(positive.status, 200);
  const waited = runHostedHarness<HarnessResult & { elapsed: { deadline: string; now: string; elapsed: boolean } }>({ operation: "policy-wait", ownerJwt: f.ownerJwt,
    workspaceA: f.workspaceA, grantId: f.grantA });
  assert.equal(waited.status, 403);
  assert.equal(waited.body.error,"connection_expired");
  assert.equal(waited.elapsed.elapsed,true);
  assert.ok(Date.parse(waited.elapsed.now)>=Date.parse(waited.elapsed.deadline));
  const [policy] = await sql`SELECT connection_expires_at < clock_timestamp() AS expired
    FROM swarm.hosted_mcp_grants WHERE grant_id=${f.grantA}::uuid`;
  assert.equal(policy!.expired, true);
});


test("owner expiry between clock sample and eligibility keeps its reason; foreign and missing stay generic", {timeout:120_000}, async()=>{
  const f=await seedHostedFixture(true);
  const result=runHostedHarness<{positive:HarnessResult;owner:HarnessResult;foreign:HarnessResult;missing:HarnessResult;
    sampled:number;elapsed:{deadline:string;now:string;elapsed:boolean};eligibilityRows:number;
    before:unknown;ownerAfter:unknown;foreignAfter:unknown;missingAfter:unknown}>({
      operation:"policy-eligibility-boundary",ownerJwt:f.ownerJwt,workspaceA:f.workspaceA,
      workspaces:[f.workspaceA,f.workspaceB],grantId:f.grantA,foreignGrantId:f.grantB,missingGrantId:randomUUID() });
  assert.equal(result.positive.status,200,'live verified owner can edit');
  assert.ok(result.sampled<Date.parse(result.elapsed.deadline),'first database clock is before the stored deadline');
  assert.equal(result.elapsed.elapsed,true);
  assert.ok(Date.parse(result.elapsed.now)>=Date.parse(result.elapsed.deadline));
  assert.equal(result.eligibilityRows,0,'actual live-policy resolver sees the elapsed deadline');
  assert.deepEqual(result.owner,{status:403,body:{error:'connection_expired'}});
  assert.deepEqual(result.foreign,{status:403,body:{error:'forbidden'}});
  assert.deepEqual(result.missing,result.foreign,'foreign and missing targets have identical wire refusals');
  for(const after of [result.ownerAfter,result.foreignAfter,result.missingAfter])
    assert.deepEqual(after,result.before,'denial changes no policy, authority, event, audit or ledger row');
});

test("already-issued MCP JWT cannot read, write or check after canonical owner deadline", { timeout: 120_000 }, async () => {
  const f = await seedHostedFixture();
  const seat = claimSeat(f, f.grantA, `old-jwt-${randomUUID()}`);
  const result = runHostedHarness<{ before: { status: number; allowed: boolean }[];
    future: { status: number; allowed: boolean }[]; elapsed: { status: number; allowed: boolean }[];
    jwtStillLive: boolean }>({ operation: "mcp-policy", ownerUserId: f.owner,
      grantId: f.grantA, handle: seat.body.handle });
  assert.deepEqual(result.before, Array.from({ length: 3 }, () => ({ status: 200, allowed: true })));
  assert.deepEqual(result.future, result.before);
  assert.deepEqual(result.elapsed, Array.from({ length: 3 }, () => ({ status: 200, allowed: false })));
  assert.equal(result.jwtStillLive, true, "refusal comes from connection policy, not access JWT expiry");
});


test("runtime helper takes selected streams before family/grant and rejects a binding changed during its wait", { timeout: 30_000 }, async () => {
  const f = await seedHostedFixture(false, true);
  const family = `provider-${f.grantA}`;
  const lock = () => oauthSql.begin(tx => tx`SELECT * FROM commonswarm_oauth.lock_hosted_family(
    ${family},${f.owner}::uuid,'test-client','https://mcp.commonswarm.com/mcp')`);
  assert.equal((await lock())[0]!.active, true);
  let waiting: ReturnType<typeof lock> | undefined;
  await sql.begin(async tx => {
    await tx`SELECT stream_id FROM swarm.streams WHERE stream_id=${f.streamB}::uuid FOR UPDATE`;
    waiting = lock();
    await waitForRuntimeLock(tx);
    const [familyLock] = await tx`SELECT pg_try_advisory_xact_lock(hashtextextended(${family},484650)) AS acquired`;
    assert.equal(familyLock!.acquired, true, "runtime must not hold family before every selected stream");
    const grants = await tx`SELECT grant_id FROM swarm.hosted_mcp_grants WHERE grant_id=${f.grantA}::uuid FOR UPDATE NOWAIT`;
    assert.equal(grants.length, 1, "runtime must not hold grant before every selected stream");
    await tx`UPDATE swarm.hosted_mcp_grants SET selected_workspace_ids=${[f.workspaceA]}::uuid[]
      WHERE grant_id=${f.grantA}::uuid`;
  });
  assert.equal((await waiting!).length, 0, "pre-wait tuple and workspace set cannot authorize the changed binding");
  const [state] = await sql`SELECT selected_workspace_ids,state FROM swarm.hosted_mcp_grants WHERE grant_id=${f.grantA}::uuid`;
  assert.deepEqual(state!.selected_workspace_ids, [f.workspaceA]);
  assert.equal(state!.state, "active", "read/lock helper never changes authority");
});


for (const tool of ["note", "check"] as const) {
  for (const waitKind of ["expiry", "removal"] as const) {
    test(`old MCP JWT ${tool} freshly refuses after stream wait: ${waitKind}`, { timeout: 120_000 }, async () => {
      const f = await seedHostedFixture(true);
      await sql`UPDATE swarm.memberships SET role='owner' WHERE user_id=${f.other}::uuid`;
      const seat = claimSeat(f, f.grantA, `wait-${randomUUID()}`);
      const result = runHostedHarness<{ before: { status: number; allowed: boolean }[];
        waited: { status: number; allowed: boolean }[]; removedStatus: number | null; jwtStillLive: boolean;
        elapsed?: { deadline: string; now: string; elapsed: boolean } }>({
        operation: "mcp-policy", waitKind, tool, ownerUserId: f.owner, otherJwt: f.otherJwt,
        workspaceId: f.workspaceA, grantId: f.grantA, handle: seat.body.handle,
      });
      assert.deepEqual(result.before, [{ status: 200, allowed: true }], "same-invocation live JWT positive");
      assert.deepEqual(result.waited, [{ status: 200, allowed: false }]);
      assert.equal(result.jwtStillLive, true, "JWT expiration is not the refusal");
      assert.equal(result.removedStatus, waitKind === "removal" ? 200 : null);
      if (waitKind === "expiry") {
        assert.equal(result.elapsed?.elapsed,true);
        assert.ok(Date.parse(result.elapsed!.now)>=Date.parse(result.elapsed!.deadline));
      }
      const [signals] = await sql`SELECT count(*)::int n FROM swarm.signals
        WHERE from_principal=${String(seat.body.principal_id)}::uuid`;
      assert.equal(signals!.n, tool === "note" ? 1 : 0, "waited command has no signal effect");
      assert.equal(await providerActive(f.grantB), true, "independent family survives");
    });
  }
}


for (const waitRow of ["workspace", "grant", "object", "object-write"] as const) {
  test(`hosted household authority expires across ${waitRow} wait`, { timeout: 120_000 }, async () => {
    const f = await seedHostedFixture();
    const seat = claimSeat(f,f.grantA,`household-wait-${randomUUID()}`);
    const seatId = String(seat.body.seat_id), principal = String(seat.body.principal_id);
    await sql.begin(async tx => {
      await tx`INSERT INTO swarm.household_workspace_boundaries(workspace_id,purpose) VALUES (${f.workspaceA}::uuid,'shared')`;
      const consent = randomUUID();
      await tx`INSERT INTO swarm.household_member_content_roles(workspace_id,user_id,content_role,content_consent_id,confirmed_at)
        VALUES (${f.workspaceA}::uuid,${f.owner}::uuid,'editor',${consent}::uuid,clock_timestamp())`;
      await tx`INSERT INTO swarm.household_content_connections(connection_id,grant_id,workspace_id,principal_id,owner_user_id,purpose,
        operations,consent_receipt_id,expires_at,hosted_grant_id)
        VALUES (${seatId}::uuid,${f.grantA}::uuid,${f.workspaceA}::uuid,${principal}::uuid,${f.owner}::uuid,'shared',
          ARRAY['read','create','update'],${consent}::uuid,NULL,${f.grantA}::uuid)`;
      const state = emptyHouseholdObjectState(f.workspaceA,randomUUID());
      await tx`INSERT INTO swarm.household_object_streams(workspace_id,stream_id,last_seq,projection)
        VALUES (${f.workspaceA}::uuid,${state.stream_id}::uuid,-1,${tx.json(state as unknown as postgres.JSONValue)})`;
    });
    const http = runHostedHarness<{ before: { allowed: boolean }[]; future: { allowed: boolean }[]; elapsed: { allowed: boolean }[] }>({
      operation:"mcp-policy",household:true,ownerUserId:f.owner,grantId:f.grantA,handle:seat.body.handle });
    assert.equal(http.before[0]!.allowed,true,"HTTP NULL-policy positive");
    assert.equal(http.future[0]!.allowed,true,"HTTP future-policy positive");
    assert.equal(http.elapsed[0]!.allowed,false,"HTTP elapsed policy refusal");
    await sql`UPDATE swarm.hosted_mcp_grants SET connection_expires_at=NULL WHERE grant_id=${f.grantA}::uuid`;
    const result = runHostedHarness<{before:{status:string};fenced:{status:string};removed:{status:string};waited:{status:string};extraPuts:number;elapsed:{deadline:string;now:string;elapsed:boolean}}>({operation:"household-wait",waitRow,
      workspaceId:f.workspaceA,ownerUserId:f.owner,grantId:f.grantA,seatId,principalId:principal,handle:seat.body.handle});
    assert.equal(result.before.status,waitRow === "object-write" ? "committed" : "ok");
    assert.equal(result.fenced.status,"refused","terminal fence refuses the same credential");
    assert.equal(result.removed.status,"refused","removed consent scope refuses the same credential");
    assert.equal(result.waited.status,"refused","no content metadata or operation authority after deadline");
    assert.equal(result.extraPuts,0,"no bytes staged after the object-state wait");
    assert.equal(result.elapsed.elapsed,true);
    assert.ok(Date.parse(result.elapsed.now)>=Date.parse(result.elapsed.deadline));
    assert.equal(await providerActive(f.grantB),true,"unrelated family survives");
  });
}

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
async function ownerContentHttpFixture(isolatedAuthUsers = false) {
  const fixture = await seedHostedFixture(true, false, isolatedAuthUsers);
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
    operation:'context-http',grantId:fixture.grantA,ownerUserId:fixture.owner,handle,calls,...extra,household:true });
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
    const reader=runHostedHarness<ContextHttpResult[]>(f.call([{name:'todo_list',arguments:{scope:'open'}},{name:'todo_queue'},
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
      const denied=runHostedHarness<ContextHttpResult[]>(f.call([{name:'todo_list',arguments:{scope:'open'}},{name:'todo_queue'}]),{databaseUrl:f.edgeUrl});
      denied.forEach(assertContentDenied);
    }
    await sql`UPDATE swarm.memberships SET role='owner' WHERE workspace_id=${f.fixture.workspaceA}::uuid AND user_id=${f.fixture.owner}::uuid`;
    const control=runHostedHarness<ContextHttpResult[]>(f.call([{name:'todo_list',arguments:{scope:'open'}}]),{databaseUrl:f.edgeUrl});
    assert.equal(control[0]!.body.status,'ok');
    runHostedHarness<ContextHttpResult[]>(f.call([{name:'todo_list',arguments:{scope:'open'}}],{grantId:f.fixture.grantB,ownerUserId:f.fixture.other}),{databaseUrl:f.edgeUrl}).forEach(assertContentDenied);
    await sql`UPDATE swarm.hosted_mcp_seats SET revoked_at=clock_timestamp() WHERE seat_id=${f.seat.body.seat_id as string}::uuid`;
    runHostedHarness<ContextHttpResult[]>(f.call([{name:'todo_list',arguments:{scope:'open'}},{name:'todo_queue'}]),{databaseUrl:f.edgeUrl}).forEach(assertContentDenied);
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
  const management=(command:Record<string,unknown>)=>runHostedHarness<HarnessResult>({operation:'management',household:true,
    ownerUserId:f.fixture.owner,workspaceId:workspace,command},{databaseUrl:f.edgeUrl});
  const retryBody={error:'household_content_service_updating',
    message:'Household content service is updating. Retry after one second with the same request_id.',retryable:true,retry_after_seconds:1};
  const writeId=randomUUID();
  const calls=[{name:'todo_list',arguments:{scope:'open'}},{name:'todo_queue'},
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
      assert.equal(runHostedHarness<ContextHttpResult[]>(f.call([{name:'todo_list',arguments:{scope:'open'}}]),{databaseUrl:f.edgeUrl})[0]!.body.status,'ok');
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
      runHostedHarness<ContextHttpResult[]>(f.call([{name:'todo_list',arguments:{scope:'open'}},{name:'todo_queue'},
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
      const setup=runHostedHarness<ContextHttpResult[]>(f.call([{name:'list_create',arguments:{request_id:randomUUID(),object_id:object,
        title:'Synthetic Storage race',content:{kind:'list',items:[{item_id:'race',text:'Synthetic bytes',order:0,checked:false}]}}},
        {name:'list_read',arguments:{object_id:object}}]),{databaseUrl:f.edgeUrl});
      assert.equal(setup[0]!.body.status,'committed'); assert.equal(setup[1]!.body.status,'ok');
      assert.deepEqual(setup[1]!.body.content,{kind:'list',items:[{item_id:'race',text:'Synthetic bytes',order:0,checked:false}]},'admitted list read returns actual Storage bytes');
      const raceCall=operation==='read'
        ? {name:'list_read',arguments:{object_id:object},storage_race:true}
        : {name:'list_create',arguments:{request_id:randomUUID(),object_id:randomUUID(),title:'Concurrent upload',
          content:{kind:'list',items:[{item_id:'upload',text:'Synthetic upload',order:0,checked:false}]}},storage_race:true};
      const results=runHostedHarness<ContextHttpResult[]>(f.call([raceCall,{name:'todo_list',arguments:{scope:'open'}},{name:'todo_queue'},
        {name:'list_read',arguments:{object_id:object}}],{storageRace:true,raceDatabaseUrl:local.DB_URL,
        workspaceId:f.fixture.workspaceA,principalId:f.seat.body.principal_id}),{databaseUrl:f.edgeUrl});
      assert.equal(results[0]!.body.status,operation==='read'?'ok':'committed','operation admitted before withdrawal commit may complete');
      results.slice(1).forEach(assertContentDenied);
    } finally { await releaseSql.unsafe('ALTER ROLE commonswarm_edge PASSWORD NULL'); }
  });
}

// The loader owns family policy independently of HTTP authentication. A real
// authenticated identity is retained before the fixture changes the family;
// HTTP read/write/queue and genuine Storage then prove the consumer boundaries.
for (const policy of ['null','future','elapsed','terminal','revoked'] as const) {
  test(`inherited owner ${policy} policy protects loader, HTTP content, queue and truthful Allow`, {timeout:180_000}, async()=>{
    const f=await ownerContentHttpFixture();
    const workspace=f.fixture.workspaceA,principal=String(f.seat.body.principal_id);
    const content={kind:'list',items:[{item_id:'policy',text:'Exact inherited policy bytes',order:0,checked:false}]};
    const existing=randomUUID(),attempted=randomUUID();
    try {
      const setup=runHostedHarness<ContextHttpResult[]>(f.call([{name:'list_create',arguments:{request_id:randomUUID(),object_id:existing,title:'Policy control',content}},
        {name:'list_read',arguments:{object_id:existing}}]),{databaseUrl:f.edgeUrl});
      assert.equal(setup[0]!.body.status,'committed');
      assert.deepEqual(setup[1]!.body.content,content);
      const results=runHostedHarness<ContextHttpResult[]>(f.call([
        {name:'policy_loader',policy_loader:policy},{name:'todo_list',arguments:{scope:'open'}},{name:'todo_queue'},
        {name:'todo_create',arguments:{request_id:randomUUID(),title:'Policy todo'}},
        {name:'list_read',arguments:{object_id:existing}},
        {name:'list_create',arguments:{request_id:randomUUID(),object_id:attempted,title:'Policy upload',content}},
        {name:'todo_queue',transport:'http',arguments:{principal_id:principal}},
      ],{policyProbe:true,raceDatabaseUrl:local.DB_URL,workspaceId:workspace,ownerJwt:f.fixture.ownerJwt}),{databaseUrl:f.edgeUrl});
      const live=policy==='null'||policy==='future';
      assert.equal(results[0]!.body.status,live?'ok':'refused','shared loader cannot be masked by HTTP auth');
      if(live) {
        assert.equal(results[0]!.body.source,'inherited');
        assert.equal(results[1]!.body.status,'ok');
        assert.equal((results[2]!.body.queue as {content_access:string}).content_access,'read_write');
        assert.equal(results[3]!.body.status,'committed');
        assert.deepEqual(results[4]!.body.content,content);
        assert.equal(results[5]!.body.status,'committed');
      } else results.slice(1,6).forEach(assertContentDenied);
      const queue=results[6]!.body.queue as {content_access:string;status:{facts:{connection:string}}};
      assert.equal(results[6]!.body.status,'ok','human can inspect an inactive agent');
      assert.equal(queue.status.facts.connection,live?'live':'connection_off');
      assert.equal(queue.content_access,live?'read_write':'none');
      const [approvals]=await sql`SELECT count(*)::int AS n FROM swarm.household_content_connections WHERE workspace_id=${workspace}::uuid`;
      assert.equal(approvals!.n,0,'all inherited probes precede any Allow');
      const [effects]=await sql`SELECT count(*)::int AS n FROM swarm.household_object_bindings WHERE workspace_id=${workspace}::uuid AND object_id=${attempted}`;
      assert.equal(effects!.n,live?1:0);
      const allow=runHostedHarness<ContextHttpResult[]>(f.call([{name:'allow',transport:'http',command:{kind:'household_approve_connection',
        connection:{kind:'hosted',connection_id:f.seat.body.seat_id,grant_id:f.fixture.grantA,principal_id:principal,operations:['read','create','update']}}}],
        {ownerJwt:f.fixture.ownerJwt,workspaceId:workspace}),{databaseUrl:f.edgeUrl})[0]!;
      assert.equal(allow.body.status,live?'committed':'refused');
      if(!live) assert.equal(allow.body.reason,'connection_access_refused');
      else {
        const [stored]=await sql`SELECT c.expires_at,g.connection_expires_at
          FROM swarm.household_content_connections c JOIN swarm.hosted_mcp_grants g ON g.grant_id=c.hosted_grant_id
          WHERE c.connection_id=${f.seat.body.seat_id as string}::uuid`;
        assert.equal(stored!.expires_at,null,'hosted approval does not copy chosen policy');
        assert.equal(allow.body.expires_at,stored!.connection_expires_at == null ? null
          : new Date(stored!.connection_expires_at as string).toISOString(),'Allow response exposes canonical chosen policy');
      }
    } finally {await releaseSql.unsafe('ALTER ROLE commonswarm_edge PASSWORD NULL');}
  });
}

test('inherited queue rechecks unchanged chosen deadline after another PostgreSQL session blocks it', {timeout:180_000}, async()=>{
  const f=await ownerContentHttpFixture();
  let pending:Promise<ContextHttpResult[]>|undefined;
  try {
    await sql`UPDATE swarm.hosted_mcp_grants SET connection_expires_at=clock_timestamp()+interval '1 hour' WHERE grant_id=${f.fixture.grantA}::uuid`;
    const positive=await runHostedHarnessAsync<ContextHttpResult[]>(f.call([{name:'todo_queue'}]),f.edgeUrl);
    assert.equal((positive[0]!.body.queue as {content_access:string}).content_access,'read_write');
    let chosen:unknown;
    await sql.begin(async locker=>{
      const [session]=await locker`SELECT pg_backend_pid() AS pid`;
      await locker`SELECT workspace_id FROM swarm.workspaces WHERE workspace_id=${f.fixture.workspaceA}::uuid FOR NO KEY UPDATE`;
      const [deadline]=await sql`UPDATE swarm.hosted_mcp_grants SET connection_expires_at=clock_timestamp()+interval '3 seconds'
        WHERE grant_id=${f.fixture.grantA}::uuid RETURNING connection_expires_at`;
      chosen=deadline!.connection_expires_at;
      pending=runHostedHarnessAsync<ContextHttpResult[]>(f.call([{name:'todo_queue'}]),f.edgeUrl);void pending.catch(()=>{});
      let blocked=false;
      for(let i=0;i<400;i++) {
        const [wait]=await sql`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE usename='commonswarm_edge'
          AND ${session!.pid}::int=ANY(pg_blocking_pids(pid))) AS blocked`;
        if(wait!.blocked){blocked=true;break;}
        await new Promise(resolve=>setTimeout(resolve,25));
      }
      assert.equal(blocked,true,'exact independent blocker observed');
      let elapsed=false;
      for(let i=0;i<400;i++) {
        const [clock]=await sql`SELECT connection_expires_at<=clock_timestamp() AS elapsed,
          connection_expires_at FROM swarm.hosted_mcp_grants WHERE grant_id=${f.fixture.grantA}::uuid`;
        assert.deepEqual(clock!.connection_expires_at,chosen,'deadline never shortened during wait');
        if(clock!.elapsed){elapsed=true;break;}
        await new Promise(resolve=>setTimeout(resolve,25));
      }
      assert.equal(elapsed,true);
    });
    (await pending!).forEach(assertContentDenied);
    const [approvals]=await sql`SELECT count(*)::int AS n FROM swarm.household_content_connections WHERE workspace_id=${f.fixture.workspaceA}::uuid`;
    assert.equal(approvals!.n,0);
  } finally {if(pending)await pending.catch(()=>{});await releaseSql.unsafe('ALTER ROLE commonswarm_edge PASSWORD NULL');}
});

// Real HTTP is the owning boundary: copied approval deadlines and a stale
// queue clock can disagree with canonical policy even when authentication works.
async function observeHouseholdRowWait(blocker: number, query: string) {
  const stop=performance.now()+3500;
  do {
    const [wait]=await sql`SELECT EXISTS(SELECT 1 FROM pg_stat_activity a
      WHERE a.usename='commonswarm_edge' AND ${blocker}::int=ANY(pg_blocking_pids(a.pid))
        AND a.query LIKE ${'%' + query + '%'}) AS blocked`;
    if(wait!.blocked) return;
    await new Promise(resolve=>setTimeout(resolve,25));
  } while(performance.now()<stop);
  assert.fail('HTTP request did not reach the intended PostgreSQL row wait before the production lock timeout');
}
async function awaitHouseholdDeadline(deadline: string) {
  for(let attempt=0;attempt<800;attempt++) {
    const [clock]=await sql`SELECT clock_timestamp()>=${deadline}::timestamptz AS elapsed`;
    if(clock!.elapsed) return;
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  assert.fail('chosen deadline did not elapse on the database clock');
}

for(const role of ['owner','member'] as const) {
  test(`explicit hosted ${role} approval survives extending and clearing chosen expiry without another Allow`, {timeout:180_000}, async()=>{
    const f=await ownerContentHttpFixture();
    const workspace=f.fixture.workspaceA,principal=String(f.seat.body.principal_id);
    const http={ownerJwt:f.fixture.ownerJwt,workspaceId:workspace};
    const allow={kind:'household_approve_connection',connection:{kind:'hosted',connection_id:f.seat.body.seat_id,
      grant_id:f.fixture.grantA,principal_id:principal,operations:['read','create','update']}};
    const setExpiry=(expiry:string|null)=>({name:'expiry',transport:'http',command:{kind:'set_connection_expiry',
      connection_kind:'hosted',grant_id:f.fixture.grantA,connection_expires_at:expiry}});
    const access=()=>runHostedHarness<ContextHttpResult[]>(f.call([{name:'todo_list',arguments:{scope:'open'}},{name:'todo_queue'},
      {name:'todo_queue',transport:'http',arguments:{principal_id:principal}}],http),{databaseUrl:f.edgeUrl});
    const assertLive=()=>{
      const results=access();
      assert.equal(results[0]!.body.status,'ok');
      for(const result of results.slice(1)) {
        assert.equal(result.body.status,'ok');
        const queue=result.body.queue as {content_access:string;status:{facts:{connection:string}}};
        assert.equal(queue.status.facts.connection,'live');assert.equal(queue.content_access,'read_write');
      }
    };
    try {
      if(role==='member') {
        // Use real role commands so both events and membership projection retain
        // a live owner before demoting the connection owner.
        for(const [userId,nextRole] of [[f.fixture.other,'owner'],[f.fixture.owner,'member']] as const) {
          const changed=runHostedHarness<HarnessResult>({operation:'public',ownerJwt:f.fixture.ownerJwt,
            workspaceId:workspace,command:{kind:'change_role',user_id:userId,role:nextRole}});
          assert.equal(changed.status,200);assert.equal(changed.body.status,'accepted');
          const [event]=await sql`SELECT payload->>'to_role' AS role FROM swarm.events
            WHERE workspace_id=${workspace}::uuid AND type='MemberRoleChanged'
              AND payload->>'user_id'=${userId} ORDER BY seq DESC LIMIT 1`;
          const [member]=await sql`SELECT role FROM swarm.memberships
            WHERE workspace_id=${workspace}::uuid AND user_id=${userId}::uuid AND revoked_at IS NULL`;
          assert.equal(event!.role,nextRole);assert.equal(member!.role,nextRole);
        }
      }
      const [dates]=await sql`SELECT clock_timestamp()+interval '10 seconds' AS old,clock_timestamp()+interval '1 hour' AS extended`;
      const original=new Date(dates!.old as string).toISOString(),extended=new Date(dates!.extended as string).toISOString();
      const initial=runHostedHarness<ContextHttpResult[]>(f.call([setExpiry(original),{name:'allow',transport:'http',command:allow},setExpiry(extended)],http),{databaseUrl:f.edgeUrl});
      assert.equal(initial[0]!.body.ok,true);assert.equal(initial[1]!.body.status,'committed');assert.equal(initial[1]!.body.expires_at,original);
      assert.equal(initial[2]!.body.ok,true);
      const approval=async()=>{
        const [row]=await sql`SELECT to_jsonb(c) AS value FROM swarm.household_content_connections c WHERE connection_id=${f.seat.body.seat_id as string}::uuid`;
        return row!.value as Record<string,unknown>;
      };
      const saved=await approval();assert.equal(saved.expires_at,null);
      await awaitHouseholdDeadline(original);assertLive();
      // Select another real future date, then clear it through the human API.
      const [next]=await sql`SELECT clock_timestamp()+interval '10 seconds' AS deadline`;
      const second=new Date(next!.deadline as string).toISOString();
      const cleared=runHostedHarness<ContextHttpResult[]>(f.call([setExpiry(second),setExpiry(null)],http),{databaseUrl:f.edgeUrl});
      cleared.forEach(result=>assert.equal(result.body.ok,true));
      await awaitHouseholdDeadline(second);assertLive();
      assert.deepEqual(await approval(),saved,'policy changes neither reapprove nor rewrite historical consent');
      const [canonical]=await sql`SELECT connection_expires_at,connection_expired_at FROM swarm.hosted_mcp_grants WHERE grant_id=${f.fixture.grantA}::uuid`;
      assert.equal(canonical!.connection_expires_at,null);assert.equal(canonical!.connection_expired_at,null);
      // Clearing a date does not revive a removed seat.
      const removed=runHostedHarness<ContextHttpResult[]>(f.call([{name:'remove',transport:'http',command:{kind:'revoke_hosted_mcp_seat',
        grant_id:f.fixture.grantA,seat_id:f.seat.body.seat_id}}],http),{databaseUrl:f.edgeUrl})[0]!;
      assert.equal(removed.body.ok,true);
      const denied=access();denied.slice(0,2).forEach(assertContentDenied);
      const queue=denied[2]!.body.queue as {content_access:string;status:{facts:{connection:string}}};
      assert.equal(denied[2]!.body.status,'ok');assert.equal(queue.status.facts.connection,'removed');assert.equal(queue.content_access,'none');
      const refused=runHostedHarness<ContextHttpResult[]>(f.call([{name:'allow',transport:'http',command:allow}],http),{databaseUrl:f.edgeUrl})[0]!;
      assert.equal(refused.body.status,'refused');assert.equal(refused.body.reason,'connection_access_refused');
    } finally {await releaseSql.unsafe('ALTER ROLE commonswarm_edge PASSWORD NULL');}
  });
}

for (const interleaving of ['known-grant','publish-binding'] as const) {
  test(`human owner queue refreshes liveness after ${interleaving} HTTP wait`, {timeout:180_000}, async()=>{
    const f=await ownerContentHttpFixture(),workspace=f.fixture.workspaceA;
    const http={ownerJwt:f.fixture.ownerJwt,workspaceId:workspace};
    let pending:Promise<ContextHttpResult[]>|undefined;
    try {
      const control=runHostedHarness<ContextHttpResult[]>(f.call([
        {name:'todo_create',arguments:{request_id:randomUUID(),title:'Queue clock control'}},
        {name:'todo_queue',transport:'http',arguments:{principal_id:f.seat.body.principal_id}}],http),{databaseUrl:f.edgeUrl});
      assert.equal(control[0]!.body.status,'committed');
      const live=control[1]!.body.queue as {content_access:string;status:{facts:{connection:string}}};
      assert.equal(live.status.facts.connection,'live');assert.equal(live.content_access,'read_write');
      const principal=interleaving==='known-grant' ? String(f.seat.body.principal_id) : randomUUID();
      if(interleaving==='publish-binding') await sql`INSERT INTO swarm.agent_principals
        (principal_id,workspace_id,owner_user_id,name,transport,turn_only)
        VALUES (${principal}::uuid,${workspace}::uuid,${f.fixture.owner}::uuid,${'queue-clock-'+principal},'hosted_mcp',true)`;
      // Cross the unchanged chosen date within the read handler's 5s lock budget.
      const [date]=await sql`UPDATE swarm.hosted_mcp_grants SET connection_expires_at=clock_timestamp()+interval '3 seconds'
        WHERE grant_id=${f.fixture.grantA}::uuid RETURNING connection_expires_at`;
      const chosen=new Date(date!.connection_expires_at as string).toISOString();
      await sql.begin(async blocker=>{
        const [session]=await blocker`SELECT pg_backend_pid() AS pid`;
        if(interleaving==='known-grant')
          await blocker`SELECT grant_id FROM swarm.hosted_mcp_grants WHERE grant_id=${f.fixture.grantA}::uuid FOR UPDATE`;
        else await blocker`SELECT workspace_id FROM swarm.workspaces WHERE workspace_id=${workspace}::uuid FOR UPDATE`;
        pending=runHostedHarnessAsync<ContextHttpResult[]>(f.call([
          {name:'todo_queue',transport:'http',arguments:{principal_id:principal}}],http),f.edgeUrl);
        void pending.catch(()=>{});
        await observeHouseholdRowWait(Number(session!.pid),interleaving==='known-grant'
          ? 'SELECT grant_id FROM swarm.hosted_mcp_grants' : 'SELECT workspace_id FROM swarm.workspaces');
        const [before]=await blocker`SELECT clock_timestamp()<${chosen}::timestamptz AS future`;
        assert.equal(before!.future,true,'the served request reached its canonical prefix wait before expiry');
        if(interleaving==='publish-binding') {
          // The publishing transaction already owns W. Publish before releasing
          // that lock, so no FK insert waits behind the request's workspace UPDATE.
          const seat=randomUUID(),handle='seat_'+randomBytes(18).toString('base64url');
          await blocker`INSERT INTO swarm.hosted_mcp_seats(seat_id,grant_id,workspace_id,owner_user_id,principal_id,name,created_at)
            VALUES (${seat}::uuid,${f.fixture.grantA}::uuid,${workspace}::uuid,${f.fixture.owner}::uuid,${principal}::uuid,${'queue-clock-'+principal},clock_timestamp())`;
          await blocker`INSERT INTO swarm.hosted_mcp_seat_handles(handle,seat_id,grant_id,workspace_id,principal_id,created_at)
            VALUES (${handle},${seat}::uuid,${f.fixture.grantA}::uuid,${workspace}::uuid,${principal}::uuid,clock_timestamp())`;
        }
        await awaitHouseholdDeadline(chosen);
      });
      const result=(await pending!)[0]!;
      const [after]=await sql`SELECT clock_timestamp()>=connection_expires_at AS elapsed,connection_expires_at
        FROM swarm.hosted_mcp_grants WHERE grant_id=${f.fixture.grantA}::uuid`;
      assert.equal(after!.elapsed,true);assert.equal(new Date(after!.connection_expires_at as string).toISOString(),chosen);
      assert.equal(result.status,200);assert.equal(result.body.status,'ok');
      const queue=result.body.queue as {content_access:string;status:{facts:{connection:string}}};
      assert.equal(queue.status.facts.connection,'connection_off','fresh queue truth includes the published binding and elapsed policy');
      assert.equal(queue.content_access,'none');
    } finally {
      if(pending)await pending.catch(()=>{});
      await releaseSql.unsafe('ALTER ROLE commonswarm_edge PASSWORD NULL');
    }
  });
}

async function observeAllowGrantWait(blocker: number) {
  for(let attempt=0;attempt<400;attempt++) {
    const [wait]=await sql`SELECT EXISTS(SELECT 1 FROM pg_stat_activity a
      WHERE a.usename='commonswarm_edge' AND a.wait_event_type='Lock'
        AND ${blocker}::int=ANY(pg_blocking_pids(a.pid))
        AND a.query='SELECT grant_id FROM swarm.hosted_mcp_grants WHERE grant_id=$1::uuid FOR SHARE'
        AND EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=a.pid
          AND l.relation='swarm.hosted_mcp_grants'::regclass
          AND l.mode='RowShareLock' AND l.granted)) AS blocked`;
    if(wait!.blocked) return;
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  assert.fail('Allow did not reach its canonical hosted grant FOR SHARE wait');
}

for(const policy of ['null','future','elapsed'] as const) {
  test(`human Allow checks ${policy} canonical policy after its existing grant row wait`, {timeout:180_000}, async()=>{
    const f=await ownerContentHttpFixture(),workspace=f.fixture.workspaceA;
    const request=randomUUID();let pending:Promise<ContextHttpResult[]>|undefined;
    let chosen:string|null=null;
    try {
      await sql`UPDATE swarm.hosted_mcp_grants SET connection_expires_at=clock_timestamp()+interval '1 hour'
        WHERE grant_id=${f.fixture.grantA}::uuid`;
      await sql.begin(async locker=>{
        const [session]=await locker`SELECT pg_backend_pid() AS pid`;
        await locker`SELECT grant_id FROM swarm.hosted_mcp_grants WHERE grant_id=${f.fixture.grantA}::uuid FOR NO KEY UPDATE`;
        pending=runHostedHarnessAsync<ContextHttpResult[]>(f.call([{name:'allow',transport:'http',request_id:request,
          command:{kind:'household_approve_connection',connection:{kind:'hosted',connection_id:f.seat.body.seat_id,
            grant_id:f.fixture.grantA,principal_id:f.seat.body.principal_id,operations:['read','create','update']}}}],
          {ownerJwt:f.fixture.ownerJwt,workspaceId:workspace}),f.edgeUrl);void pending.catch(()=>{});
        await observeAllowGrantWait(Number(session!.pid));
        // Canonical admission locks this grant before checkedConnection. Keep
        // that exact blocker while changing policy; Allow must use the new row.
        const [date]=await locker`UPDATE swarm.hosted_mcp_grants SET connection_expires_at=CASE WHEN ${policy}='null' THEN NULL
          WHEN ${policy}='future' THEN clock_timestamp()+interval '2 hours' ELSE clock_timestamp()+interval '3 seconds' END
          WHERE grant_id=${f.fixture.grantA}::uuid RETURNING connection_expires_at`;
        chosen=date!.connection_expires_at == null ? null : new Date(date!.connection_expires_at as string).toISOString();
        if(policy==='elapsed') {
          const [before]=await sql`SELECT clock_timestamp()<${chosen}::timestamptz AS future`;
          assert.equal(before!.future,true,'Allow reached its canonical grant wait before the chosen date');
          await awaitHouseholdDeadline(chosen!);
        }
      });
      const result=(await pending!)[0]!;
      const [clock]=await sql`SELECT clock_timestamp() AS now,connection_expires_at FROM swarm.hosted_mcp_grants WHERE grant_id=${f.fixture.grantA}::uuid`;
      assert.equal(clock!.connection_expires_at == null ? null : new Date(clock!.connection_expires_at as string).toISOString(),chosen);
      const rows=await sql`SELECT expires_at FROM swarm.household_content_connections WHERE connection_id=${f.seat.body.seat_id as string}::uuid`;
      if(policy==='elapsed') {
        assert.ok(new Date(clock!.now as string).getTime()>=Date.parse(chosen!));
        assert.equal(result.body.status,'refused');assert.equal(result.body.reason,'connection_access_refused');assert.equal(rows.length,0);
        const [effects]=await sql`SELECT count(*)::int AS n FROM swarm.idempotency_keys WHERE command_id=${request}`;
        assert.equal(effects!.n,0,'refusal writes no successful Allow receipt');
      } else {
        assert.equal(result.body.status,'committed');assert.equal(result.body.expires_at,chosen);
        assert.equal(rows.length,1);assert.equal(rows[0]!.expires_at,null);
      }
    } finally {if(pending)await pending.catch(()=>{});await releaseSql.unsafe('ALTER ROLE commonswarm_edge PASSWORD NULL');}
  });
}

for(const operation of ['read','write'] as const) {
  test(`inherited Storage ${operation} refuses bytes or committed effects when DB deadline crosses actual I/O`, {timeout:180_000}, async()=>{
    const f=await ownerContentHttpFixture(),object=randomUUID(),attempted=randomUUID(),request=randomUUID();
    const content={kind:'list',items:[{item_id:'io',text:'Exact Storage deadline bytes',order:0,checked:false}]};
    try {
      const setup=runHostedHarness<ContextHttpResult[]>(f.call([{name:'list_create',arguments:{request_id:randomUUID(),object_id:object,title:'I/O positive',content}},
        {name:'list_read',arguments:{object_id:object}}]),{databaseUrl:f.edgeUrl});
      assert.equal(setup[0]!.body.status,'committed');assert.deepEqual(setup[1]!.body.content,content);
      const [before]=await sql`SELECT count(*)::int AS n FROM swarm.household_object_events WHERE workspace_id=${f.fixture.workspaceA}::uuid`;
      const call=operation==='read'?{name:'list_read',arguments:{object_id:object}}:
        {name:'list_create',arguments:{request_id:request,object_id:attempted,title:'Must roll back',content}};
      const result=runHostedHarness<ContextHttpResult[]>(f.call([{...call,storage_race:true,choose_storage_deadline:true}],
        {storageExpiry:true,raceDatabaseUrl:local.DB_URL}),{databaseUrl:f.edgeUrl})[0]!;
      assertContentDenied(result);
      const [after]=await sql`SELECT count(*)::int AS n FROM swarm.household_object_events WHERE workspace_id=${f.fixture.workspaceA}::uuid`;
      assert.equal(after!.n,before!.n,'post-I/O refusal commits no event');
      const [effects]=await sql`SELECT count(*)::int AS n FROM swarm.household_object_bindings WHERE workspace_id=${f.fixture.workspaceA}::uuid AND object_id=${attempted}`;
      assert.equal(effects!.n,0);
      const [receipts]=await sql`SELECT count(*)::int AS n FROM swarm.idempotency_keys WHERE command_id=${request}`;
      assert.equal(receipts!.n,0,'failed upload commits no success receipt');
      const [approvals]=await sql`SELECT count(*)::int AS n FROM swarm.household_content_connections WHERE workspace_id=${f.fixture.workspaceA}::uuid`;
      assert.equal(approvals!.n,0);
    } finally {await releaseSql.unsafe('ALTER ROLE commonswarm_edge PASSWORD NULL');}
  });
}


// Own the regression at the real HTTP/SQL boundary: row-shape drift used to
// silently revive retired ceilings. No extra production seam or authority mock.
test('B closed snapshots survive committed M00002 NULL only, without another Allow', {timeout:600_000}, async()=>{
  const shared={sql,releaseSql,local};
  const isolated=await adminEdgeDatabase(local.DB_URL);
  let edge: postgres.Sql | undefined;
  try {
    // All permanent DDL below targets this newly owned disposable database.
    sql=isolated.db; releaseSql=isolated.db; local={...local,DB_URL:isolated.url};
    const [configuration]=await shared.sql`SELECT value FROM swarm.config WHERE key='min_client_version'`;
    assert.ok(configuration,'shared fixture has the minimum client version');
    await sql`INSERT INTO swarm.config(key,value) VALUES('min_client_version',${sql.json(configuration.value)})`;
    // Prepare real identities while the current identity/claim adapter is valid.
    // No approval or closed-target receipt exists before the reverse reserves.
    const f=await ownerContentHttpFixture(true);
    const workspace=f.fixture.workspaceA, owner=f.fixture.owner, grant=f.fixture.grantA;
    const oldSeat=String(f.seat.body.seat_id), oldPrincipal=String(f.seat.body.principal_id);
    const fresh=claimSeat(f.fixture,grant,`snapshot-new-${randomUUID()}`);
    const seat=String(fresh.body.seat_id), principal=String(fresh.body.principal_id);
    // Use the exact deployed B writer and its eight reviewed SQL templates:
    // b2cf0260 household-permissions.ts:88-102 and household-content-access.ts:142-176.
    // Its real request/consent checks, workspace lock and audit context run too.
    // Archive is read-only Git access; CI checks out full history. All B runtime
    // dependencies stay pinned together, and the existing harness drives HTTP.
    const bRoot=mkdtempSync(join(harnessDir,'snapshot-b-'));
    const bArchive=execFileSync('git',['archive','b2cf02604ba598da8d1484d5a9ebfacf6309339b','supabase/functions','src'],
      {maxBuffer:32*1024*1024});
    execFileSync('tar',['-x','-C',bRoot],{input:bArchive});
    const bHarness=join(bRoot,'command-harness.ts');
    writeFileSync(bHarness,harnessSource.replaceAll(new URL('../../supabase/functions/',import.meta.url).href,
      pathToFileURL(join(bRoot,'supabase/functions/')).href));
    const functionIdentity=()=>sql`SELECT p.proowner,p.prosecdef,p.proacl,p.proargtypes::text,p.proconfig
      FROM pg_proc p WHERE p.oid='swarm.audit_household_hosted_restriction()'::regprocedure`;
    const fnBefore=await functionIdentity();
    const functionFingerprint=()=>sql`SELECT md5(pg_get_functiondef(
      'swarm.audit_household_hosted_restriction()'::regprocedure)) AS fingerprint`;
    const [privateState]=await sql`SELECT current_database() AS name,
      (SELECT count(*)::int FROM swarm.household_content_connections) AS approvals`;
    assert.match(privateState!.name as string,/^admin_edge_[a-f0-9]{32}$/);
    assert.equal(privateState!.approvals,0,'no approval or historical snapshot is dropped');
    const permanenceVersions=[
      '20261025000001','20261022000992','20261021000990','20261019000010',
      '20261019000009','20261019000008','20261019000007','20261019000004',
      '20261019000003','20261019000002',
    ];
    const proveCatalog=async(tx:postgres.TransactionSql,source:string,alias:'catalog_ok'|'rollback_ok',label:string)=>{
      const query=releaseCatalogQuery(source,alias);
      const [path]=await tx`SELECT current_setting('search_path') AS value,
        'auth'=ANY(current_schemas(false)) AS auth_visible,
        pg_get_viewdef('swarm_read.hosted_mcp_connections'::regclass) LIKE '%auth.uid()%' AS view_auth_qualified`;
      const [native]=await tx.unsafe(query);
      // As in emptyApplicationSchema(), deparse catalog definitions with an
      // explicit path. An auth-visible session prints uid() rather than
      // auth.uid(), making 00010's unchanged view predicate spuriously false.
      // This changes only the proof session, never a migration or its checks.
      await tx.unsafe('SET LOCAL search_path=pg_catalog');
      try {
        const [proof]=await tx.unsafe(query);
        const diagnostic={label,native_ok:native?.[alias]===true,
          catalog_ok:proof?.[alias]===true,auth_visible:path!.auth_visible,
          native_view_auth_qualified:path!.view_auth_qualified};
        if(!diagnostic.native_ok || !diagnostic.catalog_ok)
          process.stdout.write(`B_SNAPSHOT_CATALOG ${JSON.stringify(diagnostic)}\n`);
        assert.equal(proof?.[alias],true,`${label}: ${JSON.stringify(diagnostic)}`);
      } finally {
        await tx`SELECT set_config('search_path',${path!.value},true)`;
      }
    };
    // Revised 3/252 ruling, COMMONSWARM-RELEASE-CONFLICT-RULINGS-20261027.md:
    // recreate B through the exact release reserves, as in 3/283, with proof
    // after every step. No individual column/guard is removed as a substitute.
    await sql.begin(async tx=>{
      const [emptyPolicy]=await tx`SELECT NOT EXISTS(SELECT 1 FROM swarm.hosted_mcp_grants
        WHERE connection_expires_at IS NOT NULL OR connection_expired_at IS NOT NULL)
        AND NOT EXISTS(SELECT 1 FROM swarm.renewal_grants
        WHERE connection_expires_at IS NOT NULL OR connection_expired_at IS NOT NULL) AS empty`;
      assert.equal(emptyPolicy!.empty,true,'fixture never discards a chosen or terminal policy');
      for(const version of permanenceVersions) {
        const reserve=`deploy/release-proofs/permanence/${version}`;
        await tx.unsafe(repoSql(`${reserve}-rollback.sql`));
        await proveCatalog(tx,repoSql(`${reserve}-rollback-catalog.sql`),'rollback_ok',`${version} rollback catalog`);
      }
    });
    const [beforeColumn]=await sql`SELECT EXISTS(SELECT 1 FROM pg_attribute
      WHERE attrelid='swarm.household_content_connections'::regclass
        AND attname='renewal_grant_id' AND NOT attisdropped) AS present`;
    assert.equal(beforeColumn!.present,false,'bootstrap must be B layout before M00002');
    // The 00009 reserve must have restored the exact B00006 definition.
    const bFunction=repoSql('supabase/migrations/20261019000006_hosted_owner_content_access.sql')
      .match(/^CREATE OR REPLACE FUNCTION swarm\.audit_household_hosted_restriction\(\) RETURNS trigger\n[\s\S]*?^END \$\$;/m);
    assert.ok(bFunction,'extract the existing B00006 trigger function, without its table/ACL DDL');
    const [installedB]=await sql`SELECT prosrc FROM pg_proc
      WHERE oid='swarm.audit_household_hosted_restriction()'::regprocedure`;
    assert.equal(installedB!.prosrc,bFunction[0].split('AS $$')[1]!.split('$$;')[0]);
    const bFingerprint=await functionFingerprint();
    assert.deepEqual(await functionIdentity(),fnBefore,'restoring B preserves original owner/signature/invoker/config/ACL');
    edge=postgres(f.edgeUrl,{prepare:false,max:1});
    const [login]=await edge`SELECT session_user,current_user,rolsuper,rolbypassrls
      FROM pg_roles WHERE rolname=current_user`;
    assert.deepEqual(login,{session_user:'commonswarm_edge',current_user:'commonswarm_edge',rolsuper:false,rolbypassrls:false});
    await edge.begin(async tx=>{await tx.unsafe('SET LOCAL ROLE swarm_command');});
    await assert.rejects(edge.begin(async tx=>{await tx.unsafe('SET LOCAL ROLE commonswarm_oauth_runtime');}),{code:'42501'});
    const allow=(seat:string,principal:string,operations:string[],historical=true)=>runHostedHarness<HarnessResult>({
      operation:'public',household:true,ownerJwt:f.fixture.ownerJwt,workspaceId:workspace,
      command:{kind:'household_approve_connection',connection:{kind:'hosted',connection_id:seat,
        grant_id:grant,principal_id:principal,operations}}},{databaseUrl:f.edgeUrl,...(historical?{harnessPath:bHarness}:{})});
    assert.equal(allow(oldSeat,oldPrincipal,['read']).body.status,'committed');
    // Setup models a retained closed historical version. Actual authorization
    // below uses the normal login through HTTP; only setup uses the admin pool.
    await sql`UPDATE swarm.hosted_mcp_seats SET revoked_at=clock_timestamp() WHERE seat_id=${oldSeat}::uuid`;
    await sql`UPDATE swarm.household_content_connections SET revoked_at=clock_timestamp() WHERE connection_id=${oldSeat}::uuid`;
    assert.equal(allow(seat,principal,['read','create','update']).body.status,'committed');
    const [saved]=await sql`SELECT closed_target_replacements AS markers
      FROM swarm.household_hosted_content_restrictions WHERE grant_id=${grant}::uuid
        AND workspace_id=${workspace}::uuid AND principal_id=${principal}::uuid`;
    const markers=saved!.markers as Array<Record<string,unknown>>;
    assert.equal(markers.length,2,'one retired restriction and one retired legacy row');
    const legacy=markers.findIndex(row=>row.kind==='legacy'); assert.ok(legacy>=0);
    assert.equal(Object.hasOwn(markers[legacy]!.row as object,'renewal_grant_id'),false);
    const durable=async()=>{
      const [state]=await sql`SELECT
        (SELECT count(*)::int FROM swarm.household_content_connections WHERE workspace_id=${workspace}::uuid) AS approvals,
        (SELECT md5(closed_target_replacements::text) FROM swarm.household_hosted_content_restrictions
          WHERE grant_id=${grant}::uuid AND workspace_id=${workspace}::uuid AND principal_id=${principal}::uuid) AS marker_hash`;
      return state;
    };
    const unchanged=await durable();
    let upgraded=false;
    const content=()=>runHostedHarness<ContextHttpResult[]>(f.call([
      {name:'todo_list',arguments:{scope:'open'}},{name:'todo_create',arguments:{request_id:randomUUID(),title:'Snapshot compatibility synthetic'}}],
      {handle:fresh.body.handle}),{databaseUrl:f.edgeUrl,...(!upgraded?{harnessPath:bHarness}:{})});
    const positive=()=>{const result=content();assert.equal(result[0]!.body.status,'ok');assert.equal(result[1]!.body.status,'committed');};
    // Direct real command-role trigger check uses existing authenticated context,
    // not an owner bypass. It retains the marker bytes and makes no new approval.
    const capture=(value:unknown,actor=owner,command='household_permissions',scope=principal)=>edge!.begin(async tx=>{
      await tx.unsafe('SET LOCAL ROLE swarm_command');
      await tx`SELECT set_config('cswarm.household_actor',${actor},true),
        set_config('cswarm.household_command',${command},true),
        set_config('cswarm.household_request',${randomUUID()},true),
        set_config('cswarm.household_digest',${'ab'.repeat(32)},true)`;
      if(scope!==principal) await tx`UPDATE swarm.household_hosted_content_restrictions SET principal_id=${scope}::uuid
        WHERE grant_id=${grant}::uuid AND workspace_id=${workspace}::uuid AND principal_id=${principal}::uuid`;
      else await tx`UPDATE swarm.household_hosted_content_restrictions SET
        closed_target_replacements=${value === undefined ? null : tx.json(value as postgres.JSONValue)}
        WHERE grant_id=${grant}::uuid AND workspace_id=${workspace}::uuid AND principal_id=${principal}::uuid`;
    });
    positive(); await capture(markers); assert.deepEqual(await durable(),unchanged,'B00006 before M0 and M00002');
    // Apply the unmodified M files in filename order with each catalog proof.
    // Commit before HTTP: it must observe the actual upgrade, not a DDL lock.
    await sql.begin(async tx=>{
      const migrations=readdirSync('supabase/migrations').filter(name=>permanenceVersions.includes(name.slice(0,14))).sort();
      assert.equal(migrations.length,permanenceVersions.length,'each reserve has exactly one forward migration');
      for(const name of migrations) {
        const version=name.slice(0,14);
        await tx.unsafe(repoSql(`supabase/migrations/${name}`));
        await proveCatalog(tx,repoSql(`deploy/release-proofs/permanence/${version}-catalog.sql`),'catalog_ok',`${version} forward catalog`);
      }
    });
    upgraded=true;
    assert.notDeepEqual(await functionFingerprint(),bFingerprint,'M0 changes the actual installed B00006 definition');
    assert.deepEqual(await functionIdentity(),fnBefore,'M0 preserves original owner/signature/invoker/config/ACL');
    positive(); await capture(markers); assert.deepEqual(await durable(),unchanged,'M0 after filename-ordered M00002');
    const [newColumn]=await sql`SELECT to_jsonb(c)->'renewal_grant_id' AS value
      FROM swarm.household_content_connections c WHERE connection_id=${oldSeat}::uuid`;
    assert.equal(newColumn!.value,null);
    positive(); await capture(markers); assert.deepEqual(await durable(),unchanged,'no re-Allow, approval or marker rewrite');
    const strict=structuredClone(markers);
    (strict[legacy]!.row as Record<string,unknown>).renewal_grant_id=null;
    await capture(strict); positive(); // Ordinary strict new-shape capture still works.
    await capture(markers); assert.deepEqual(await durable(),unchanged);
    const bad: Array<[string,unknown]>=[
      ['SQL NULL',undefined],['JSON null',null],['malformed entry',[null]],['scalar entry',[1]],
      ['duplicate',[...markers,markers[0]]],['missing legacy entry',markers.filter((_,index)=>index!==legacy)],
      ['order',[...markers].reverse()],['bound',Array.from({length:257},()=>markers[0])],
    ];
    const missingOtherNullKey=structuredClone(markers);
    const missingNullRow=missingOtherNullKey[legacy]!.row as Record<string,unknown>;
    assert.equal(Object.hasOwn(missingNullRow,'expires_at'),true,'negative removes an existing key');
    assert.equal(missingNullRow.expires_at,null,'negative removes a genuinely JSON-null key');
    delete missingNullRow.expires_at;
    bad.push(['missing other null key',missingOtherNullKey]);
    for(const [label,mutate] of [
      ['kind',(row:Record<string,unknown>)=>{row.kind='restriction';}],
      ['root field',(row:Record<string,unknown>)=>{row.unrelated=null;}],
      ['row field',(row:Record<string,unknown>)=>{(row.row as Record<string,unknown>).unrelated=null;}],
      ...['owner_user_id','grant_id','workspace_id','principal_id'].map(key=>[
        key,(row:Record<string,unknown>)=>{(row.row as Record<string,unknown>)[key]=randomUUID();}] as const),
      ['malformed row',(row:Record<string,unknown>)=>{row.row=null;}],
    ] as const) {
      const changed=structuredClone(markers); mutate(changed[legacy]!); bad.push([label,changed]);
    }
    for(const [label,value] of bad) {
      await assert.rejects(capture(value),{code:'42501'},label+' trigger denies');
      assert.deepEqual(await durable(),unchanged,label+' rejection leaves marker unchanged');
    }
    await assert.rejects(capture(markers,f.fixture.other),{code:'42501'},'trigger rejects a different actor');
    await assert.rejects(capture(markers,owner,'household_connection_invalidation'),{code:'42501'},'trigger rejects invalid command context');
    // principal_id is outside swarm_command's column UPDATE grant, so this
    // negative proves the ACL boundary before the trigger can check immutability.
    await assert.rejects(capture(markers,owner,'household_permissions',oldPrincipal),{code:'42501'},'column ACL denies scope UPDATE');
    // 3/252 defense-in-depth ruling, COMMONSWARM-RELEASE-CONFLICT-RULINGS-20261027.md:
    // only this verified admin_edge_* database (force-dropped in finally) may
    // contain impossible committed rows for an independent HTTP reader check.
    // Prove the same write is refused with the installed guard; preserve its
    // exact definition AND enabled state around each transactional bypass.
    const restrictionTrigger=()=>sql`SELECT pg_get_triggerdef(oid) AS definition,tgenabled
      FROM pg_trigger WHERE tgrelid='swarm.household_hosted_content_restrictions'::regclass
        AND tgname='household_hosted_restriction_audit' AND NOT tgisinternal`;
    const restrictionGuard=await restrictionTrigger();
    assert.equal(restrictionGuard.length,1);assert.equal(restrictionGuard[0]!.tgenabled,'O');
    const writeMarker=(tx:postgres.TransactionSql,value:unknown)=>tx`UPDATE swarm.household_hosted_content_restrictions
      SET closed_target_replacements=${tx.json(value as postgres.JSONValue)}
      WHERE grant_id=${grant}::uuid AND workspace_id=${workspace}::uuid AND principal_id=${principal}::uuid`;
    const setMarker=async(value:unknown)=>{
      await assert.rejects(sql.begin(tx=>writeMarker(tx,value)),
        {code:'42501',message:'owned hosted restriction context required'},'installed guard refuses the same setup write');
      assert.deepEqual(await restrictionTrigger(),restrictionGuard);
      await sql.begin(async tx=>{
        await tx.unsafe('ALTER TABLE swarm.household_hosted_content_restrictions DISABLE TRIGGER household_hosted_restriction_audit');
        await writeMarker(tx,value);
        await tx.unsafe('ALTER TABLE swarm.household_hosted_content_restrictions ENABLE TRIGGER household_hosted_restriction_audit');
      });
      assert.deepEqual(await restrictionTrigger(),restrictionGuard,'restriction guard definition and state restored exactly');
    };
    for(const [label,value] of bad.filter(([label])=>!['SQL NULL','JSON null','bound','order','duplicate'].includes(label))) {
      await setMarker(value); content().forEach(assertContentDenied);
      await setMarker(markers); positive(); assert.deepEqual(await durable(),unchanged,label+' restored control');
    }
    // Reordering/duplicates remain exact array validation concerns. Runtime's
    // individual closed-target lookup does not assign meaning to array order.
    // A real non-NULL referenced renewal grant must never match the missing key.
    const device=randomUUID(), run=randomUUID(), renewal=randomUUID();
    await sql`INSERT INTO swarm.devices(device_id,user_id,label) VALUES(${device}::uuid,${owner}::uuid,'Snapshot fixture')`;
    await sql`INSERT INTO swarm.agent_runs(run_id,principal_id,device_id) VALUES(${run}::uuid,${oldPrincipal}::uuid,${device}::uuid)`;
    await sql`INSERT INTO swarm.renewal_grants(renewal_grant_id,workspace_id,principal_id,run_id,kind,max_successors,
      successors_used,horizon_expires_at,bound_device_id,created_by) VALUES(${renewal}::uuid,${workspace}::uuid,
      ${oldPrincipal}::uuid,${run}::uuid,'standing',NULL,0,NULL,${device}::uuid,${owner}::uuid)`;
    // Same 3/252 defense-in-depth ruling: the installed binding guard must
    // refuse this exact non-NULL hosted write, before testing the next layer.
    const bindingTrigger=()=>sql`SELECT pg_get_triggerdef(oid) AS definition,tgenabled
      FROM pg_trigger WHERE tgrelid='swarm.household_content_connections'::regclass
        AND tgname='aa_household_local_family_binding' AND NOT tgisinternal`;
    const bindingGuard=await bindingTrigger();
    assert.equal(bindingGuard.length,1);assert.equal(bindingGuard[0]!.tgenabled,'O');
    const writeFamily=(tx:postgres.TransactionSql,value:string|null)=>tx`UPDATE swarm.household_content_connections
      SET renewal_grant_id=${value}::uuid WHERE connection_id=${oldSeat}::uuid`;
    const setFamily=async(value:string|null)=>{
      await assert.rejects(sql.begin(tx=>writeFamily(tx,value)),{code:'23514',
        message:value===null?'LOCAL_APPROVAL_FAMILY_IMMUTABLE':'LOCAL_APPROVAL_POLICY_BINDING'},
      'installed binding guard refuses the same setup write');
      assert.deepEqual(await bindingTrigger(),bindingGuard);
      await sql.begin(async tx=>{
        await tx.unsafe('DROP TRIGGER aa_household_local_family_binding ON swarm.household_content_connections');
        await writeFamily(tx,value);
        await tx.unsafe(bindingGuard[0]!.definition as string);
      });
      assert.deepEqual(await bindingTrigger(),bindingGuard,'binding guard definition and state restored exactly');
    };
    await setFamily(renewal);
    content().forEach(assertContentDenied); await assert.rejects(capture(markers),{code:'42501'});
    await setFamily(null);
    positive(); await capture(markers); assert.deepEqual(await durable(),unchanged);
    // Unrelated current-row changes remain binding even when the new FK is NULL.
    await sql`UPDATE swarm.household_content_connections SET operations=ARRAY['read','update'] WHERE connection_id=${oldSeat}::uuid`;
    content().forEach(assertContentDenied); await assert.rejects(capture(markers),{code:'42501'});
    await sql`UPDATE swarm.household_content_connections SET operations=ARRAY['read'] WHERE connection_id=${oldSeat}::uuid`;
    positive();
    for(const role of ['admin','member']) {
      await sql`UPDATE swarm.memberships SET role=${role} WHERE workspace_id=${workspace}::uuid AND user_id=${owner}::uuid`;
      await assert.rejects(capture(markers),{code:'42501'},'owner-only replacement survives '+role+' downgrade');
    }
    await sql`UPDATE swarm.memberships SET role='owner' WHERE workspace_id=${workspace}::uuid AND user_id=${owner}::uuid`;
    positive();
    await sql.unsafe(repoSql('deploy/release-proofs/hosted-owner-content/20261019000006-rollback.sql'));
    const gated=content(); gated.forEach(row=>assert.equal(row.body.error,'household_content_service_updating'));
    await sql.unsafe('DROP POLICY hosted_owner_content_rollback_gate ON swarm.household_content_connections');
    positive();
    await sql`UPDATE swarm.memberships SET revoked_at=clock_timestamp() WHERE workspace_id=${workspace}::uuid AND user_id=${owner}::uuid`;
    content().forEach(assertContentDenied);
    await sql`UPDATE swarm.memberships SET revoked_at=NULL WHERE workspace_id=${workspace}::uuid AND user_id=${owner}::uuid`;
    positive();
    await sql`UPDATE swarm.hosted_mcp_seats SET revoked_at=clock_timestamp() WHERE seat_id=${seat}::uuid`;
    content().forEach(assertContentDenied);
    assert.deepEqual(await durable(),unchanged);
    assert.deepEqual(await functionIdentity(),fnBefore);
    // Only after every no-re-Allow reader/capture/rollback check: prove that
    // the current HTTP writer independently captures the ordinary new shape.
    await sql`UPDATE swarm.hosted_mcp_seats SET revoked_at=NULL WHERE seat_id=${seat}::uuid`;
    assert.equal(allow(seat,principal,['read','create','update'],false).body.status,'committed');
    const [currentMarker]=await sql`SELECT closed_target_replacements AS markers
      FROM swarm.household_hosted_content_restrictions WHERE grant_id=${grant}::uuid
        AND workspace_id=${workspace}::uuid AND principal_id=${principal}::uuid`;
    assert.deepEqual(currentMarker!.markers,strict,'current writer captures the strict NULL-key version of the same retired rows');
    positive();
  } finally {
    try { await edge?.end(); } finally {
      sql=shared.sql;releaseSql=shared.releaseSql;local=shared.local;
      try { await shared.releaseSql.unsafe('ALTER ROLE commonswarm_edge PASSWORD NULL'); }
      finally { await isolated.close(); }
    }
  }
});
