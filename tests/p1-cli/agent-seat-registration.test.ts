/** Pure and structural controls for H0 seat registration. */
import assert from "node:assert/strict";
import test from "node:test";
import {
  decideWorkspace,
  H0_SEAT_TOKEN_TTL_MS,
  type DecideWorkspaceCtx,
  type WorkspaceCommand,
} from "../../src/protocol/workspace-commands.js";
import type { WorkspaceState } from "../../src/protocol/workspace-events.js";

const OWNER = "00000000-0000-4000-8000-000000000001";
const REGISTRAR = "00000000-0000-4000-8000-000000000002";
const REGISTRAR_RUN = "00000000-0000-4000-8000-000000000003";
const WORKSPACE = "00000000-0000-4000-8000-000000000004";
const STREAM = "00000000-0000-4000-8000-000000000005";
const SCOPES = [
  "create",
  "acquire",
  "renew",
  "handoff",
  "takeover",
  "submit",
  "close",
  "reopen",
  "post_signal",
];

function state(): WorkspaceState {
  return {
    workspace: {
      workspace_id: WORKSPACE,
      name: "H0",
      created_by: OWNER,
      created_at: 1,
      archived_at: null,
    },
    members: {
      [OWNER]: {
        user_id: OWNER,
        role: "owner",
        invited_by: null,
        joined_at: 1,
        revoked_at: null,
      },
    },
    invitations: {},
    principals: {
      "00000000-0000-4000-8000-000000000099": {
        principal_id: "00000000-0000-4000-8000-000000000099",
        owner_user_id: OWNER,
        name: "duplicate label",
        model: null,
        transport: "local",
        turn_only: false,
        created_at: 1,
        revoked_at: null,
      },
    },
    tokens: {},
    owners_count: 1,
  };
}

function context(
  kind: "human" | "agent" | "join",
  memberRole: "owner" | null = "owner",
): DecideWorkspaceCtx {
  let seq = 0;
  return {
    now: 10_000,
    actor: {
      user: OWNER,
      agent_principal: kind === "join" ? REGISTRAR : null,
      run: kind === "join" ? REGISTRAR_RUN : null,
    },
    credential_kind: kind,
    presenting_token_id: null,
    command_id: "register-command",
    workspace_id: WORKSPACE,
    stream_id: STREAM,
    operatorAllowed: () => false,
    role: () => memberRole,
    inviteeAlreadyMember: () => false,
    identityVerified: () => true,
    humanRights: () => SCOPES,
    landingAuthorityChangeResolved: () => true,
    nextSeq: () => ++seq,
    nextEventId: () => `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
  };
}

function registerCommand(): WorkspaceCommand {
  return {
    kind: "register_agent_seat",
    attempt_id: "00000000-0000-4000-8000-000000000010",
    principal_id: "00000000-0000-4000-8000-000000000011",
    run_id: "00000000-0000-4000-8000-000000000012",
    token_id: "00000000-0000-4000-8000-000000000013",
    name: "duplicate label",
    scopes: [...SCOPES],
    ttl_ms: H0_SEAT_TOKEN_TTL_MS,
  };
}

test("the reducer admits only a join credential for register_agent_seat", () => {
  const accepted = decideWorkspace(state(), registerCommand(), context("join"));
  assert.equal(accepted.ok, true);
  if (accepted.ok) {
    assert.deepEqual(
      accepted.events.map((event) => event.type),
      ["AgentPrincipalCreated", "AgentTokenMinted"],
    );
    for (const event of accepted.events) {
      assert.equal(event.actor_user, OWNER);
      assert.equal(event.actor_agent_principal, REGISTRAR);
      assert.equal(event.actor_run, REGISTRAR_RUN);
    }
    assert.equal(
      (accepted.events[0].payload as { name: string }).name,
      "duplicate label",
      "duplicate display labels are deliberate",
    );
  }

  for (const kind of ["human", "agent"] as const) {
    const refused = decideWorkspace(state(), registerCommand(), context(kind));
    assert.equal(refused.ok, false);
    if (!refused.ok) {
      assert.equal(refused.class, "authz");
      assert.equal(refused.reason, "credential_kind_forbidden");
    }
  }
});

test("the reducer refuses registration when the credential owner is not a live member", () => {
  const refused = decideWorkspace(state(), registerCommand(), context("join", null));
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    assert.equal(refused.class, "authz");
    assert.equal(refused.reason, "bad_state");
    assert.match(refused.detail, /not a current workspace member/);
    assert.deepEqual(refused.events, []);
  }
});

test("a join credential is refused for every non-registration reducer kind", () => {
  const other: WorkspaceCommand = {
    /* submit_feedback is deliberately open to both ordinary credential kinds,
     * so the join exact-kind gate is the only reason this command is refused. */
    kind: "submit_feedback",
    feedback_id: "00000000-0000-4000-8000-000000000014",
    category: "bug",
    body: "other command",
    context: null,
  };
  const refused = decideWorkspace(state(), other, context("join"));
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    assert.equal(refused.class, "authz");
    assert.equal(refused.reason, "credential_kind_forbidden");
    assert.deepEqual(refused.events, []);
  }
});
