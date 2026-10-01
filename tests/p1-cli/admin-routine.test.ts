import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { adminCoreFixture } from "../support/admin-fixture.js";
import {
  ADMIN_RESOURCE,
  ADMIN_SCOPE_NAMES,
  type AdminAccountState,
  type AdminRoutineCommand,
  type AdminRoutineContext,
  decideAdminRoutine,
  reduceAdminAuthority,
  reduceWorkspace,
  type WorkspaceState,
} from "../../src/protocol/index.js";

function fixture() {
  const workspaceId = randomUUID(), f = adminCoreFixture([workspaceId]);
  f.manifest.scope_names = [...ADMIN_SCOPE_NAMES];
  f.manifest.created_workspace_policy.scope_names = ["seats:create"];
  f.manifest.target_rules = {
    seat_ids: [],
    own_seats: true,
    grant_created_seats: true,
    recipient_user_ids: [f.owner],
    recipient_connection_ids: [f.manifest.connection_id],
    transports: ["local", "hosted_mcp"],
  };
  f.manifest.worker_scope_ceiling = ["post_signal", "create"];
  f.manifest.renewal_limits.grant_kinds = ["timeboxed", "standing"];
  assert.equal(
    f.run({
      kind: "grant_admin_delegation",
      grant_id: f.grantId,
      consent_receipt_id: f.receipt,
      replaces_grant_id: null,
    }).ok,
    true,
  );
  let state = f.state();
  let workspace = reduceWorkspace(null, {
    workspace_id: workspaceId,
    stream_id: randomUUID(),
    seq: 1,
    event_id: randomUUID(),
    command_id: randomUUID(),
    type: "WorkspaceCreated",
    schema_version: 1,
    actor_user: f.owner,
    actor_agent_principal: null,
    actor_run: null,
    occurred_at_server: f.now,
    payload: {
      workspace_id: workspaceId,
      name: "Routine",
      created_by: f.owner,
      created_at: f.now,
    },
  });
  const ctx: AdminRoutineContext = {
    ...f.ctx,
    actor: {
      kind: "delegated_admin",
      grant_id: f.grantId,
      admin_identity_id: f.manifest.admin_identity_id,
      connection_id: f.manifest.connection_id,
      scope_names: [...f.manifest.scope_names],
      resource: ADMIN_RESOURCE,
      access_expires_at: f.now + 300000,
    },
    workspace,
    workspace_stream_id: randomUUID(),
    workspace_seq: 1,
    owned_workspaces: 1,
    workspace_creations_last_day: 1,
    invitations_last_day: 0,
    live_principals: 0,
    live_members_and_invitations: 1,
    live_agent_invitations_person: 0,
    live_agent_invitations_workspace: 0,
    human_worker_scopes: ["post_signal", "create"],
    recipient_exists: true,
    recipient_is_member: false,
    delivery_connection_id: f.manifest.connection_id,
    target_credential: null,
    principal_lineage_ids: [],
    nextResourceId: randomUUID,
  };
  const base = { grant_id: f.grantId, workspace_id: workspaceId };
  const decide = (
    command: AdminRoutineCommand,
    overrides: Partial<AdminRoutineContext> = {},
    snapshot: AdminAccountState = state,
  ) => decideAdminRoutine(command, snapshot, { ...ctx, ...overrides });
  const run = (command: AdminRoutineCommand) => {
    ctx.command_id = randomUUID();
    const d = decide(command);
    assert.equal(d.ok, true, d.reason ?? undefined);
    state = d.events.reduce(reduceAdminAuthority, state);
    for (const event of d.workspace_events) {
      workspace = reduceWorkspace(workspace, event);
    }
    ctx.workspace = workspace;
    ctx.workspace_seq += d.workspace_events.length;
    ctx.live_principals =
      Object.values(workspace.principals).filter((p) => p.revoked_at === null)
        .length;
    return d;
  };
  const create = () => {
    run({
      ...base,
      kind: "admin_create_seat",
      name: "Own agent",
      model: null,
      transport: "local",
    });
    return Object.keys(workspace.principals)[0]!;
  };
  return {
    f,
    base,
    ctx,
    decide,
    run,
    create,
    state: () => state,
    workspace: () => workspace,
  };
}

test("routine workspace creation requires its separate scope and new spaces inherit only confirmed operations", () => {
  const x = fixture(),
    cmd = {
      ...x.base,
      workspace_id: randomUUID(),
      kind: "admin_create_workspace" as const,
      name: "New space",
    };
  const { workspace, ...rest } = x.ctx;
  const d = x.decide(cmd, { ...rest, workspace: null, workspace_seq: 0 });
  assert.equal(d.ok, true);
  assert.equal(d.workspace_events[0]!.actor_user, null);
  assert.equal(d.events[0]!.type, "AdminWorkspaceCreated");
  const next = d.events.reduce(reduceAdminAuthority, x.state());
  const w = d.workspace_events.reduce(
    reduceWorkspace,
    null as WorkspaceState | null,
  )!;
  const createSeat = {
    ...x.base,
    workspace_id: cmd.workspace_id,
    kind: "admin_create_seat" as const,
    name: "Child",
    model: null,
    transport: "local" as const,
  };
  assert.equal(
    x.decide(createSeat, { workspace: w, live_principals: 0 }, next).ok,
    true,
  );
  const invite = {
    ...x.base,
    workspace_id: cmd.workspace_id,
    kind: "admin_invite_member" as const,
    recipient_user_id: x.f.owner,
    role: "member" as const,
    ttl_seconds: 3600,
  };
  assert.equal(
    x.decide(invite, { workspace: w }, next).reason,
    "workspace_forbidden",
  );
  const actor = x.ctx.actor;
  assert.equal(actor.kind, "delegated_admin");
  if (actor.kind === "delegated_admin") {
    assert.equal(
      x.decide(cmd, {
        workspace: null,
        actor: {
          ...actor,
          scope_names: actor.scope_names.filter((s) =>
            s !== "workspaces:create"
          ),
        },
      }).reason,
      "scope_forbidden",
    );
  }
  assert.equal(
    x.decide(cmd, { workspace: null, workspace_creations_last_day: 20 }).reason,
    "workspace_limit_reached",
  );
  assert.equal(next.routine!.spend[x.f.grantId]!.workspaces, 1);
});

test("routine seat provisioning preserves delegated attribution, own targets, worker ceilings and runtime delivery", () => {
  const x = fixture(), id = x.create();
  const command = {
    ...x.base,
    kind: "admin_provision_seat" as const,
    principal_id: id,
    recipient_connection_id: x.f.manifest.connection_id,
    worker_scope_names: ["post_signal"],
    bearer_seconds: 3600,
    horizon_seconds: 86400,
    max_successors: 800,
  };
  for (
    const [override, reason] of [
      [{ delivery_connection_id: null }, "recipient_runtime_required"],
      [{ actor: { kind: "worker" } }, "credential_kind_forbidden"],
      [{ now: x.f.manifest.expires_at }, "grant_inactive"],
      [{ human_worker_scopes: [] }, "worker_scope_forbidden"],
    ] as [Partial<AdminRoutineContext>, string][]
  ) assert.equal(x.decide(command, override).reason, reason);
  assert.equal(
    x.decide({ ...command, worker_scope_names: ["mint_agent_token"] }).reason,
    "invalid_request",
  );
  assert.equal(
    x.decide({ ...command, bearer_seconds: 3601 }).reason,
    "renewal_policy_forbidden",
  );
  const foreign = structuredClone(x.ctx.workspace!);
  foreign.principals[id]!.owner_user_id = randomUUID();
  assert.equal(
    x.decide(command, { workspace: foreign }).reason,
    "target_forbidden",
  );
  const d = x.run(command),
    token = Object.values(x.state().routine!.credentials)[0]!;
  assert.equal(token.parent_admin_grant_id, x.f.grantId);
  assert.ok(token.expires_at <= x.f.manifest.expires_at);
  assert.equal(d.events[0]!.payload.delivery_state, "awaiting_delivery");
  for (const event of [...d.events, ...d.workspace_events]) {
    assert.equal(event.actor_user, null);
    assert.equal(event.actor_agent_principal, null);
    assert.ok(!JSON.stringify(event).includes("swm_agt_"));
  }
  assert.equal(x.workspace().tokens[token.credential_id]!.principal_id, id);
  assert.equal(x.decide(command).reason, "credential_already_issued");
});

test("routine renewal and undelivered replacement preserve horizons, ancestry, scopes and lifetime spend", () => {
  const x = fixture(), principal = x.create();
  x.run({
    ...x.base,
    kind: "admin_provision_seat",
    principal_id: principal,
    recipient_connection_id: x.f.manifest.connection_id,
    worker_scope_names: ["post_signal"],
    bearer_seconds: 3600,
    horizon_seconds: 86400,
    max_successors: 2,
  });
  const prior = Object.values(x.state().routine!.credentials)[0]!;
  x.ctx.target_credential = { ...prior, first_used_at: x.f.now };
  const renew = {
    ...x.base,
    kind: "admin_renew_seat" as const,
    principal_id: principal,
    predecessor_credential_id: prior.credential_id,
    recipient_connection_id: prior.recipient_connection_id,
    worker_scope_names: ["post_signal"],
    bearer_seconds: 3600,
  };
  assert.equal(
    x.decide(renew, { target_credential: { ...prior, first_used_at: null } })
      .reason,
    "credential_delivery_state_forbidden",
  );
  assert.equal(
    x.decide(renew, {
      target_credential: { ...prior, first_used_at: x.f.now, suspended: true },
    }).reason,
    "predecessor_unavailable",
  );
  assert.equal(
    x.decide({ ...renew, worker_scope_names: ["post_signal", "create"] })
      .reason,
    "worker_scope_forbidden",
  );
  const d = x.run(renew),
    successor = d.events[0]!.payload.credential as typeof prior;
  assert.equal(successor.horizon_expires_at, prior.horizon_expires_at);
  assert.equal(successor.worker_lineage_id, prior.worker_lineage_id);
  assert.equal(successor.parent_admin_grant_id, prior.parent_admin_grant_id);
  x.ctx.target_credential = successor;
  const replace = {
    ...x.base,
    kind: "admin_replace_undelivered_seat_credential" as const,
    principal_id: principal,
    credential_id: successor.credential_id,
    recipient_connection_id: successor.recipient_connection_id,
  };
  const replaced = x.run(replace).events[0]!.payload.credential as typeof prior;
  assert.equal(replaced.horizon_expires_at, prior.horizon_expires_at);
  assert.equal(replaced.expires_at, successor.expires_at);
  assert.equal(x.state().routine!.spend[x.f.grantId]!.successors, 2);
  x.ctx.target_credential = replaced;
  assert.equal(
    x.decide({ ...replace, credential_id: replaced.credential_id }).reason,
    "renewal_successors_exhausted",
  );
  assert.equal(
    x.state().routine!.credentials[successor.credential_id]!.revoked_at,
    x.f.now,
  );
});

test("routine invitations bind recipients and member role, clip expiry, consume budgets, and revoke without refunds", () => {
  const x = fixture(),
    invite = {
      ...x.base,
      kind: "admin_invite_member" as const,
      recipient_user_id: x.f.owner,
      role: "member" as const,
      ttl_seconds: 604800,
    };
  assert.equal(
    x.decide({ ...invite, recipient_user_id: randomUUID() }).reason,
    "recipient_forbidden",
  );
  assert.equal(
    x.decide({ ...invite, role: "admin" } as unknown as AdminRoutineCommand)
      .reason,
    "invalid_request",
  );
  assert.equal(
    x.decide(invite, { invitations_last_day: 10 }).reason,
    "invitation_limit_reached",
  );
  const d = x.run(invite), id = String(d.events[0]!.payload.invitation_id);
  assert.equal(d.events[0]!.payload.expires_at, x.f.manifest.expires_at);
  assert.equal(d.events[0]!.payload.delivery_state, "awaiting_authorization");
  const revoke = {
    ...x.base,
    kind: "admin_revoke_invitation" as const,
    invitation_id: id,
    reason_code: "cancelled",
  };
  x.run(revoke);
  assert.equal(x.run(revoke).events.length, 1);
  assert.equal(x.state().routine!.spend[x.f.grantId]!.invitations, 1);
  const join = {
    ...x.base,
    kind: "admin_issue_agent_invitation" as const,
    intended_owner_user_id: x.f.owner,
    recipient_connection_id: x.f.manifest.connection_id,
    transport: "local" as const,
    seat_limit: 1,
    worker_scope_names: ["post_signal"],
    ttl_seconds: 3600,
  };
  assert.equal(x.decide(join).ok, true);
  assert.equal(
    x.decide({ ...join, recipient_connection_id: randomUUID() }).reason,
    "recipient_forbidden",
  );
  assert.equal(
    x.decide(join, { live_agent_invitations_person: 5 }).reason,
    "invitation_limit_reached",
  );
});

test("routine revoke preserves history, is a no-op twice, and refuses expired grants and lost rights", () => {
  const x = fixture(),
    principal = x.create(),
    command = {
      ...x.base,
      kind: "admin_revoke_seat" as const,
      principal_id: principal,
      reason_code: "cancelled",
    };
  const rights = structuredClone(x.ctx.workspace!);
  rights.members[x.f.owner]!.role = "member";
  assert.equal(
    x.decide(command, { workspace: rights }).reason,
    "current_rights_required",
  );
  assert.equal(
    x.decide(command, { now: x.f.manifest.expires_at }).reason,
    "grant_inactive",
  );
  x.run(command);
  assert.equal(x.run(command).events.length, 1);
  assert.equal(x.state().routine!.spend[x.f.grantId]!.total_seats, 1);
  assert.equal(x.workspace().principals[principal]!.revoked_at, x.f.now);
  const state = x.state(), g = state.grants[x.f.grantId]!;
  const terminal = decideAdminRoutine(command, {
    ...state,
    grants: { ...state.grants, [g.grant_id]: { ...g, state: "revoked" } },
  }, x.ctx);
  assert.equal(terminal.reason, "grant_inactive");
});
