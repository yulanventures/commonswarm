/** seat_list for the hosted MCP: the live seats held by this exact connection.
 *
 * The grant is found by the verified token's provider grant and owner, then authorized
 * through the grant capability (active grant, live provider family, unexpired connection),
 * so a retired or expired connection lists nothing and fails closed. */
import type postgres from "npm:postgres@3.4.9";
// @ts-ignore TS5097: Deno requires the source extension; Node tests use tsx.
import { authenticateHostedGrantCapability, type ProviderGrantStatus } from "../_shared/hosted-seat-auth.ts";
// @ts-ignore TS5097: Deno requires the source extension; Node tests use tsx.
import { HostedToolFailure } from "./tool-errors.ts";

type Sql = postgres.TransactionSql<Record<string, unknown>>;

export const SEAT_LIST_LIMIT = 50;
export const SEAT_RELEASED_NOTE =
  "This seat and its handle no longer work. The agent stays listed in members until the workspace owner retires it, and it can get a seat again only through an explicit claim_seat.";

export async function executeSeatList(
  token: { providerGrantId: string; subject: string },
  deps: {
    withAuthTransaction: <T>(run: (tx: Sql) => Promise<T>) => Promise<T>;
    providerStatus: ProviderGrantStatus;
  },
): Promise<Record<string, unknown>> {
  const listed = await deps.withAuthTransaction(async (tx) => {
    const grants = await tx<{ grant_id: string; owner_user_id: string; home_workspace_id: string }[]>`
      SELECT grant_id, owner_user_id, home_workspace_id
      FROM swarm.hosted_mcp_grants
      WHERE provider_grant_id = ${token.providerGrantId}
        AND owner_user_id = ${token.subject}::uuid
      LIMIT 2
    `;
    if (grants.length !== 1) return null;
    const grant = grants[0]!;
    const capability = await authenticateHostedGrantCapability(tx, {
      grantId: grant.grant_id,
      ownerUserId: grant.owner_user_id,
      providerGrantId: token.providerGrantId,
      workspaceId: grant.home_workspace_id,
      tool: "seat_list",
      providerStatus: deps.providerStatus,
    });
    if (capability === null) return null;
    return await tx<Record<string, unknown>[]>`
      SELECT h.handle, s.name, s.workspace_id, s.principal_id, s.created_at
      FROM swarm.hosted_mcp_seats AS s
      JOIN swarm.hosted_mcp_seat_handles AS h ON h.seat_id = s.seat_id
      WHERE s.grant_id = ${grant.grant_id}::uuid
        AND s.owner_user_id = ${grant.owner_user_id}::uuid
        AND s.revoked_at IS NULL
        AND h.revoked_at IS NULL
        AND h.grant_id = s.grant_id
      ORDER BY s.created_at, s.seat_id
      LIMIT ${SEAT_LIST_LIMIT}
    `;
  });
  if (listed === null) throw new HostedToolFailure("hosted_grant_forbidden");
  return { seats: listed };
}
