/**
 * Pure controls for H0 join credentials. Reached by test:p1-cli's glob.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { redactCredentialText } from "../../src/host/credential-redaction.js";
import {
  decideWorkspace,
  HUMAN_ONLY_COMMANDS,
  type DecideWorkspaceCtx,
  type WorkspaceCommand,
} from "../../src/protocol/workspace-commands.js";

function agentContext(): DecideWorkspaceCtx {
  return {
    now: Date.now(),
    actor: {
      user: "00000000-0000-4000-8000-000000000001",
      agent_principal: "00000000-0000-4000-8000-000000000002",
      run: "00000000-0000-4000-8000-000000000003",
    },
    credential_kind: "agent",
    presenting_token_id: "00000000-0000-4000-8000-000000000004",
    command_id: "join-control-1",
    workspace_id: "00000000-0000-4000-8000-000000000005",
    stream_id: "00000000-0000-4000-8000-000000000006",
    operatorAllowed: () => false,
    role: () => "owner",
    inviteeAlreadyMember: () => false,
    identityVerified: () => true,
    humanRights: () => [],
    landingAuthorityChangeResolved: () => true,
    nextSeq: () => 1,
    nextEventId: () => "00000000-0000-4000-8000-000000000007",
  };
}

test("join mint and revoke are human-only in the pure authority core", () => {
  const commands: WorkspaceCommand[] = [
    { kind: "mint_agent_join_credential", seat_cap: 3, ttl_hours: 4 },
    {
      kind: "revoke_agent_join_credential",
      join_credential_id: "00000000-0000-4000-8000-000000000008",
    },
  ];
  for (const command of commands) {
    assert.equal(HUMAN_ONLY_COMMANDS.has(command.kind), true);
    const decision = decideWorkspace(null, command, agentContext());
    assert.equal(decision.ok, false);
    if (!decision.ok) {
      assert.equal(decision.class, "authz");
      assert.equal(decision.reason, "credential_kind_forbidden");
    }
  }
});

test("swm_join_ secrets are removed by the shared host redactor", () => {
  const secret = `swm_join_${"J".repeat(43)}`;
  const redacted = redactCredentialText(`register with ${secret} now`);
  assert.equal(redacted, "register with [redacted-credential] now");
  assert.doesNotMatch(redacted, /swm_join_/i);
});
