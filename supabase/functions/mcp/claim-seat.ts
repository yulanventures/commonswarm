import type postgres from "npm:postgres@3.4.9";
// @ts-ignore TS5097: Deno requires the source extension; Node tests use tsx.
import { authenticateHostedGrantCapability, type HostedGrantCapability, type ProviderGrantStatus } from "../_shared/hosted-seat-auth.ts";
import type { CommandResult, HostedCommandInput } from "../command/contract.d.ts";
import type { HostedToolCall } from "./tools.ts";

type Sql = postgres.TransactionSql<Record<string, unknown>>;

interface ClaimSeatDependencies {
  withAuthTransaction: <T>(run: (tx: Sql) => Promise<T>) => Promise<T>;
  providerStatus: ProviderGrantStatus;
  handleCommand: (input: HostedCommandInput, capability: HostedGrantCapability) => Promise<CommandResult>;
}

/** Resolve the consent-time default before issuing the ordinary hosted claim. */
export async function executeClaimSeat(
  call: HostedToolCall,
  dependencies: ClaimSeatDependencies,
): Promise<CommandResult> {
  const authorized = await dependencies.withAuthTransaction(async (tx) => {
    const rows = await tx<{
      grant_id: string;
      owner_user_id: string;
      home_workspace_id: string;
    }[]>`
      SELECT grant_id, owner_user_id, home_workspace_id
      FROM swarm.hosted_mcp_grants
      WHERE provider_grant_id = ${call.token.providerGrantId}
        AND owner_user_id = ${call.token.subject}::uuid
      LIMIT 2
    `;
    if (rows.length !== 1) return null;
    const grant = rows[0]!;
    const workspaceId = call.arguments.workspace_id === undefined
      ? grant.home_workspace_id
      : String(call.arguments.workspace_id);
    const capability = await authenticateHostedGrantCapability(tx, {
      grantId: grant.grant_id,
      ownerUserId: grant.owner_user_id,
      providerGrantId: call.token.providerGrantId,
      workspaceId,
      tool: "claim_hosted_seat",
      providerStatus: dependencies.providerStatus,
    });
    return capability === null ? null : { capability, workspaceId };
  });
  if (authorized === null) throw new Error("hosted_grant_forbidden");
  return await dependencies.handleCommand({
    command_id: call.arguments.request_id,
    client_version: "0.1.80",
    workspace_id: authorized.workspaceId,
    stream: { kind: "workspace" },
    command: { kind: "claim_hosted_seat", name: call.arguments.name },
  }, authorized.capability);
}
