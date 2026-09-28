import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SCHEMA_VERSION,
  StreamIntegrityError,
  type DecideWorkspaceCtx,
  type WorkspaceEventEnvelope,
  decideWorkspace,
  reduceWorkspace,
} from "../src/protocol/index.js";

const baseEnvelope = {
  workspace_id: "workspace",
  stream_id: "workspace-stream",
  command_id: "command",
  schema_version: SCHEMA_VERSION,
  occurred_at_server: 1,
  actor_user: "owner",
  actor_agent_principal: null,
  actor_run: null,
} as const;

function createdWorkspace() {
  return reduceWorkspace(null, {
    ...baseEnvelope,
    event_id: "workspace-created",
    seq: 1,
    type: "WorkspaceCreated",
    payload: {
      workspace_id: "workspace",
      name: "Workspace",
      created_by: "owner",
      created_at: 1,
    },
  });
}

function principalEvent(payload: Record<string, unknown>): WorkspaceEventEnvelope {
  return {
    ...baseEnvelope,
    event_id: "principal-created",
    seq: 2,
    type: "AgentPrincipalCreated",
    payload: {
      principal_id: "principal",
      owner_user_id: "owner",
      name: "Agent",
      created_at: 2,
      ...payload,
    },
  };
}

test("older principal events fold to local non-turn-only transport", () => {
  const state = reduceWorkspace(createdWorkspace(), principalEvent({}));
  assert.equal(state.principals.principal?.transport, "local");
  assert.equal(state.principals.principal?.turn_only, false);
});

test("ordinary principal creation emits explicit local transport values", () => {
  let seq = 1;
  const ctx: DecideWorkspaceCtx = {
    now: 2,
    actor: { user: "owner", agent_principal: null, run: null },
    credential_kind: "human",
    presenting_token_id: null,
    command_id: "command",
    workspace_id: "workspace",
    stream_id: "workspace-stream",
    operatorAllowed: () => true,
    role: () => "owner",
    inviteeAlreadyMember: () => false,
    identityVerified: () => true,
    humanRights: () => [],
    landingAuthorityChangeResolved: () => true,
    nextSeq: () => ++seq,
    nextEventId: () => "principal-created",
  };
  const decision = decideWorkspace(createdWorkspace(), {
    kind: "create_agent_principal",
    principal_id: "principal",
    name: "Agent",
  }, ctx);
  assert.equal(decision.ok, true);
  assert.deepEqual(decision.events[0]?.payload, {
    principal_id: "principal",
    owner_user_id: "owner",
    name: "Agent",
    model: null,
    transport: "local",
    turn_only: false,
    created_at: 2,
  });
});

test("hosted MCP principals fold only when explicitly turn-only", () => {
  const state = reduceWorkspace(createdWorkspace(), principalEvent({
    transport: "hosted_mcp",
    turn_only: true,
  }));
  assert.equal(state.principals.principal?.transport, "hosted_mcp");
  assert.equal(state.principals.principal?.turn_only, true);

  assert.throws(
    () => reduceWorkspace(createdWorkspace(), principalEvent({
      transport: "hosted_mcp",
      turn_only: false,
    })),
    StreamIntegrityError,
  );
});

test("principal transport folding rejects unknown transports and non-boolean turn_only", () => {
  assert.throws(
    () => reduceWorkspace(createdWorkspace(), principalEvent({
      transport: "remote",
      turn_only: true,
    })),
    StreamIntegrityError,
  );
  assert.throws(
    () => reduceWorkspace(createdWorkspace(), principalEvent({
      transport: "local",
      turn_only: "false",
    })),
    StreamIntegrityError,
  );
});

test("hosted principals cannot mint an independently usable token", () => {
  let seq = 2;
  const ctx: DecideWorkspaceCtx = {
    now: 3,
    actor: { user: "owner", agent_principal: null, run: null },
    credential_kind: "human",
    presenting_token_id: null,
    command_id: "mint",
    workspace_id: "workspace",
    stream_id: "workspace-stream",
    operatorAllowed: () => false,
    role: () => "owner",
    inviteeAlreadyMember: () => false,
    identityVerified: () => true,
    humanRights: () => ["post_signal"],
    landingAuthorityChangeResolved: () => true,
    nextSeq: () => ++seq,
    nextEventId: () => `event-${seq}`,
  };
  const command = {
    kind: "mint_agent_token" as const,
    token_id: "token",
    principal_id: "principal",
    run_id: "run",
    task_id: "task",
    epoch: 0,
    scopes: ["post_signal"],
    renewal_kind: "timeboxed" as const,
    renewal_horizon_ms: 1_000,
  };
  const local = reduceWorkspace(createdWorkspace(), principalEvent({
    transport: "local",
    turn_only: false,
  }));
  assert.equal(decideWorkspace(local, command, ctx).ok, true,
    "positive control: local principal can mint");
  const hosted = reduceWorkspace(createdWorkspace(), principalEvent({
    transport: "hosted_mcp",
    turn_only: true,
  }));
  const refused = decideWorkspace(hosted, command, ctx);
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.reason, "transport_unavailable");
});
