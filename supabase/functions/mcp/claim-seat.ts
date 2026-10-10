import type postgres from "npm:postgres@3.4.9";
// @ts-ignore TS5097: Deno requires the source extension; Node tests use tsx.
import { authenticateHostedGrantCapability, type HostedGrantCapability, type ProviderGrantStatus } from "../_shared/hosted-seat-auth.ts";
import type { CommandResult, HostedCommandInput } from "../command/contract.d.ts";
// @ts-ignore TS5097: Deno requires the source extension; Node tests use tsx.
import { HostedToolFailure } from "./tool-errors.ts";
import type { HostedToolCall } from "./tools.ts";

type Sql = postgres.TransactionSql<Record<string, unknown>>;

interface ClaimSeatDependencies {
  withAuthTransaction: <T>(run: (tx: Sql) => Promise<T>) => Promise<T>;
  providerStatus: ProviderGrantStatus;
  handleCommand: (input: HostedCommandInput, capability: HostedGrantCapability) => Promise<CommandResult>;
}

/** Resolve a handle's context workspace or the currently authorized home. */
export async function executeClaimSeat(
  call: HostedToolCall,
  dependencies: ClaimSeatDependencies,
): Promise<CommandResult> {
  const authorized = await dependencies.withAuthTransaction(async (tx) => {
    const rows = await tx<{
      grant_id: string;
      owner_user_id: string;
      home_workspace_id: string | null;
    }[]>`
      SELECT grant_id, owner_user_id, home_workspace_id
      FROM swarm.hosted_mcp_grants
      WHERE provider_grant_id = ${call.token.providerGrantId}
        AND owner_user_id = ${call.token.subject}::uuid
      LIMIT 2
    `;
    if (rows.length !== 1) return null;
    const grant = rows[0]!;
    // Validate this connection before disclosing a handle's workspace or
    // distinguishing an unavailable home from revoked authorization.
    const discovery = await authenticateHostedGrantCapability(tx, {
      grantId: grant.grant_id, ownerUserId: grant.owner_user_id,
      providerGrantId: call.token.providerGrantId, tool: "whoami",
      providerStatus: dependencies.providerStatus,
    });
    if (discovery === null) return null;
    let workspaceId = call.arguments.workspace_id === undefined
      ? grant.home_workspace_id
      : String(call.arguments.workspace_id);
    const handleContinue = call.arguments.intent === "continue" && call.arguments.seat !== undefined;
    if (handleContinue) {
      const contexts = await tx<{ workspace_id: string }[]>`
        SELECT s.workspace_id FROM swarm.hosted_agent_contexts AS c
        JOIN swarm.hosted_mcp_seats AS s ON s.seat_id = c.seat_id
        WHERE c.handle = ${String(call.arguments.seat)} AND s.grant_id = ${grant.grant_id}::uuid
          AND s.owner_user_id = ${grant.owner_user_id}::uuid
        LIMIT 2
      `;
      if (contexts.length !== 1) throw new HostedToolFailure("identity_resume_unavailable", undefined, { canStartNew: true });
      workspaceId = contexts[0]!.workspace_id;
      if (call.arguments.workspace_id !== undefined && call.arguments.workspace_id !== workspaceId) {
        // Authorize the handle's actual workspace before reporting mismatch.
        const current = await authenticateHostedGrantCapability(tx, {
          grantId: grant.grant_id, ownerUserId: grant.owner_user_id,
          providerGrantId: call.token.providerGrantId, workspaceId,
          tool: "claim_hosted_seat", providerStatus: dependencies.providerStatus,
        });
        if (current === null) return null;
        throw new HostedToolFailure("workspace_mismatch");
      }
    }
    if (workspaceId === null) throw new HostedToolFailure("workspace_unavailable");
    const capability = await authenticateHostedGrantCapability(tx, {
      grantId: grant.grant_id,
      ownerUserId: grant.owner_user_id,
      providerGrantId: call.token.providerGrantId,
      workspaceId,
      tool: "claim_hosted_seat",
      providerStatus: dependencies.providerStatus,
    });
    if (capability === null && !handleContinue && call.arguments.workspace_id === undefined) {
      // A provider or grant may have been revoked since the first check.
      const stillCurrent = await authenticateHostedGrantCapability(tx, {
        grantId: grant.grant_id, ownerUserId: grant.owner_user_id,
        providerGrantId: call.token.providerGrantId, tool: "whoami",
        providerStatus: dependencies.providerStatus,
      });
      if (stillCurrent === null) return null;
      throw new HostedToolFailure("workspace_unavailable");
    }
    return capability === null ? null : { capability, workspaceId };
  });
  if (authorized === null) throw new HostedToolFailure("hosted_grant_forbidden");
  return await dependencies.handleCommand({
    command_id: call.arguments.request_id,
    client_version: "0.1.80",
    workspace_id: authorized.workspaceId,
    stream: { kind: "workspace" },
    command: {
      kind: "claim_hosted_seat",
      intent: call.arguments.intent ?? "new",
      ...Object.fromEntries(["name", "seat", "lifetime", "parent_context"]
        .filter(key => call.arguments[key] !== undefined)
        .map(key => [key, call.arguments[key]])),
      ...(call.arguments.kind === undefined ? {} : { context_kind: call.arguments.kind }),
    },
  }, authorized.capability);
}
