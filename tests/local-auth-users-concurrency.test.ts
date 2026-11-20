import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { build } from "esbuild";

const bundle = await build({
  entryPoints: ["supabase/functions/_shared/agent-auth.ts"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
});
const { planLocalOperation, lockLocalAuthPlan } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles![0]!.text).toString("base64")}`
);

function makeFixtureSql() {
  const owner = randomUUID();
  const workspace = randomUUID();
  const principal = randomUUID();
  const tokenId = randomUUID();
  const renewalGrantId = randomUUID();
  const runId = randomUUID();
  const deviceId = randomUUID();
  const lineageId = randomUUID();
  const adminGrantId = randomUUID();
  const queries: string[] = [];

  const binding = {
    token_id: tokenId,
    predecessor_token_id: null,
    renewal_grant_id: renewalGrantId,
    principal_id: principal,
    run_id: runId,
    device_id: deviceId,
    owner_user_id: owner,
    workspace_id: workspace,
    lineage_id: lineageId,
    token_parent_admin_grant_id: null,
    principal_parent_admin_grant_id: null,
  };

  const run = (strings: TemplateStringsArray, ..._values: unknown[]) => {
    const query = strings.join("?").replace(/\s+/gu, " ").trim();
    queries.push(query);
    let rows: Record<string, unknown>[] = [];
    if (query.includes("FROM swarm.discover_local_credential")) {
      rows = [{
        token_id: tokenId,
        principal_id: principal,
        owner_user_id: owner,
        workspace_id: workspace,
        renewal_grant_id: renewalGrantId,
      }];
    } else if (query.includes("SELECT swarm.local_agent_workspace_live(")) {
      rows = [{ ok: true }];
    } else if (query.includes("SELECT EXISTS( SELECT 1 FROM swarm.memberships")) {
      rows = [{ ok: true }];
    } else if (query.includes("FROM swarm.discover_local_target_ids")) {
      rows = [binding];
    } else if (query.includes("FROM swarm.admin_grants") && query.includes("WHERE owner_user_id=")) {
      rows = [{ grant_id: adminGrantId, workspace_ids: [workspace], withdrawn_workspace_ids: [] }];
    } else if (query.includes("FROM swarm.admin_grants") && query.includes("WHERE grant_id=ANY")) {
      rows = [{ owner_user_id: owner }];
    } else if (query.includes("FROM swarm.admin_accounts")) {
      rows = [{ owner_user_id: owner }];
    } else if (query.includes("FROM swarm.workspaces w JOIN swarm.memberships m")) {
      rows = [{ workspace_id: workspace }];
    } else if (query.includes("FROM swarm.workspaces")) {
      rows = [{ workspace_id: workspace }];
    } else if (query.includes("FROM swarm.memberships")) {
      rows = [{ workspace, user: owner }];
    } else if (query.includes("FROM swarm.household_member_content_roles")) {
      rows = [];
    } else if (query.includes("FROM swarm.household_workspace_boundaries")) {
      rows = [];
    } else if (query.includes("FROM swarm.agent_execution_sessions")) {
      rows = [];
    } else if (query.includes("FROM swarm.household_content_connections")) {
      rows = [];
    } else if (query.includes("FROM swarm.streams")) {
      rows = [];
    } else if (query.startsWith("SELECT user_id FROM swarm.users")) {
      rows = [{ user_id: owner }];
    } else if (query.startsWith("SELECT clock_timestamp()")) {
      rows = [{ clock_timestamp: new Date().toISOString() }];
    }

    const promise = Promise.resolve(rows) as Promise<Record<string, unknown>[]> & {
      cursor: () => AsyncGenerator<Record<string, unknown>[], void, void>;
    };
    promise.cursor = async function* () {
      if (rows.length) yield rows;
    };
    return promise;
  };

  return { tx: run, queries, owner, workspace, principal, tokenId, adminGrantId };
}

test("local agent planLocalOperation locks swarm.users FOR KEY SHARE so sibling agents do not serialize", async () => {
  const f = makeFixtureSql();
  const plan = await planLocalOperation(f.tx, {
    hash: new Uint8Array(randomBytes(32)),
    workspace: f.workspace,
    streamIds: [],
    workspaceMode: "share",
  });
  assert.ok(plan);
  assert.deepEqual(plan.userKeyShareIds, [f.owner]);
  assert.equal(plan.userUpdateIds, undefined);

  f.queries.length = 0;
  await lockLocalAuthPlan(f.tx, plan);
  const userLocks = f.queries.filter((q) => q.startsWith("SELECT user_id FROM swarm.users"));
  assert.equal(userLocks.length, 1);
  assert.match(userLocks[0]!, /FOR KEY SHARE$/u);
  assert.doesNotMatch(userLocks[0]!, /FOR NO KEY UPDATE/u);
});

test("human default keeps FOR NO KEY UPDATE, signals_seen keyShare uses FOR KEY SHARE, invite_member update uses FOR UPDATE", async () => {
  // Default human caller (upsert path): FOR NO KEY UPDATE
  {
    const f = makeFixtureSql();
    const plan = await planLocalOperation(f.tx, {
      workspace: f.workspace,
      actor: f.owner,
      streamIds: [],
      workspaceMode: "update",
    });
    assert.ok(plan);
    f.queries.length = 0;
    await lockLocalAuthPlan(f.tx, plan);
    const userLocks = f.queries.filter((q) => q.startsWith("SELECT user_id FROM swarm.users") && q.includes("FOR "));
    assert.equal(userLocks.length, 1);
    assert.match(userLocks[0]!, /FOR NO KEY UPDATE$/u);
  }

  // Unchanged-profile human signals_seen: FOR KEY SHARE
  {
    const f = makeFixtureSql();
    const plan = await planLocalOperation(f.tx, {
      workspace: f.workspace,
      actor: f.owner,
      actorUserMode: "keyShare",
      streamIds: [],
      workspaceMode: "share",
    });
    assert.ok(plan);
    f.queries.length = 0;
    await lockLocalAuthPlan(f.tx, plan);
    const userLocks = f.queries.filter((q) => q.startsWith("SELECT user_id FROM swarm.users"));
    assert.equal(userLocks.length, 1);
    assert.match(userLocks[0]!, /FOR KEY SHARE$/u);
  }

  // invite_member / create_workspace: upfront FOR UPDATE before workspace locks
  {
    const f = makeFixtureSql();
    const plan = await planLocalOperation(f.tx, {
      workspace: f.workspace,
      actor: f.owner,
      actorUserMode: "update",
      streamIds: [],
      workspaceMode: "update",
    });
    assert.ok(plan);
    f.queries.length = 0;
    await lockLocalAuthPlan(f.tx, plan);
    const userLocks = f.queries.filter((q) => q.startsWith("SELECT user_id FROM swarm.users"));
    assert.equal(userLocks.length, 1);
    assert.match(userLocks[0]!, /FOR UPDATE$/u);
    const userIdx = f.queries.findIndex((q) => q.startsWith("SELECT user_id FROM swarm.users"));
    const wsIdx = f.queries.findIndex((q) => q.startsWith("SELECT workspace_id FROM swarm.workspaces"));
    assert.ok(userIdx >= 0 && wsIdx > userIdx, "swarm.users FOR UPDATE precedes swarm.workspaces");
  }

  // Delegated admin caller: retains FOR NO KEY UPDATE on owner row
  {
    const f = makeFixtureSql();
    const plan = await planLocalOperation(f.tx, {
      workspace: f.workspace,
      actor: f.owner,
      admin: { owner: f.owner, grant: f.adminGrantId, recipients: [] },
    });
    assert.ok(plan);
    f.queries.length = 0;
    await lockLocalAuthPlan(f.tx, plan);
    const userLocks = f.queries.filter((q) => q.startsWith("SELECT user_id FROM swarm.users") && q.includes("FOR "));
    assert.equal(userLocks.length, 1);
    assert.match(userLocks[0]!, /FOR NO KEY UPDATE$/u);
  }
});
