import type { Session, SupabaseClient } from "@supabase/supabase-js";

import { client, postCommand, uuid } from "./commonswarm";

export interface ConnectedAppSeat {
  seatId: string;
  workspaceId: string;
  workspaceName: string;
  principalId: string;
  name: string;
  revoked: boolean;
  effectiveRevoked: boolean;
}

export interface ConnectedApp {
  grantId: string;
  clientId: string;
  clientHost: string;
  homeWorkspaceId: string;
  workspaceIds: string[];
  workspaces: Array<{ id: string; name: string }>;
  status: "pending" | "active" | "revoked";
  seats: ConnectedAppSeat[];
}

interface ConnectionRow {
  grant_id?: unknown;
  client_id?: unknown;
  home_workspace_id?: unknown;
  selected_workspace_ids?: unknown;
  state?: unknown;
  revoked_at?: unknown;
}

interface SeatRow {
  seat_id?: unknown;
  grant_id?: unknown;
  workspace_id?: unknown;
  principal_id?: unknown;
  name?: unknown;
  revoked_at?: unknown;
}

function clientHost(clientId: string): string {
  try {
    return new URL(clientId).host;
  } catch {
    return clientId;
  }
}

export function groupConnectedApps(
  connectionRows: readonly ConnectionRow[],
  seatRows: readonly SeatRow[],
  workspaceNames: ReadonlyMap<string, string> = new Map(),
): ConnectedApp[] {
  return connectionRows.map((row) => {
    const grantId = String(row.grant_id ?? "");
    const workspaceIds = Array.isArray(row.selected_workspace_ids)
      ? row.selected_workspace_ids.map(String)
      : [];
    const revoked = row.revoked_at != null || row.state === "revoked";
    const state = row.state === "active" ? "active" : "pending";
    return {
      grantId,
      clientId: String(row.client_id ?? ""),
      clientHost: clientHost(String(row.client_id ?? "")),
      homeWorkspaceId: String(row.home_workspace_id ?? ""),
      workspaceIds,
      workspaces: workspaceIds.map((id) => ({ id, name: workspaceNames.get(id) ?? id })),
      status: revoked ? "revoked" : state,
      seats: seatRows
        .filter((seat) => String(seat.grant_id ?? "") === grantId)
        .map((seat) => ({
          seatId: String(seat.seat_id ?? ""),
          workspaceId: String(seat.workspace_id ?? ""),
          workspaceName: workspaceNames.get(String(seat.workspace_id ?? "")) ??
            String(seat.workspace_id ?? ""),
          principalId: String(seat.principal_id ?? ""),
          name: String(seat.name ?? "Hosted seat"),
          revoked: seat.revoked_at != null,
          effectiveRevoked: revoked || seat.revoked_at != null,
        })),
    };
  });
}

export async function loadConnectedApps(
  workspaceNames: ReadonlyMap<string, string> = new Map(),
  suppliedClient?: SupabaseClient,
): Promise<ConnectedApp[]> {
  const api = suppliedClient ?? client();
  if (!api) throw new Error("This build is not connected to CommonSwarm.");
  const [connections, seats] = await Promise.all([
    api.schema("swarm_read").from("hosted_mcp_connections")
      .select("grant_id,client_id,home_workspace_id,selected_workspace_ids,state,revoked_at")
      .order("created_at", { ascending: false }),
    api.schema("swarm_read").from("hosted_mcp_seats")
      .select("seat_id,grant_id,workspace_id,principal_id,name,revoked_at")
      .order("created_at", { ascending: true }),
  ]);
  if (connections.error) throw new Error(connections.error.message);
  if (seats.error) throw new Error(seats.error.message);
  return groupConnectedApps(connections.data ?? [], seats.data ?? [], workspaceNames);
}

function accepted(status: number, body: Record<string, unknown>, target: string): void {
  if (status !== 200 || body.status !== "accepted" || body.ok !== true) {
    throw new Error(`CommonSwarm did not revoke ${target} (${String(body.reason ?? body.error ?? status)}).`);
  }
}

export async function revokeConnectedAppGrant(
  session: Session,
  connection: Pick<ConnectedApp, "grantId" | "homeWorkspaceId">,
  commandId = uuid(),
): Promise<void> {
  const result = await postCommand(
    session,
    commandId,
    { kind: "revoke_hosted_mcp_grant", grant_id: connection.grantId },
    { workspace_id: connection.homeWorkspaceId, stream: { kind: "workspace" } },
    "CommonSwarm lost the revocation result. Reload Connected apps before trying again.",
  );
  accepted(result.status, result.body, "the connection");
}

export async function revokeConnectedAppSeat(
  session: Session,
  seat: Pick<ConnectedAppSeat, "seatId" | "workspaceId"> & { grantId: string },
  commandId = uuid(),
): Promise<void> {
  const result = await postCommand(
    session,
    commandId,
    {
      kind: "revoke_hosted_mcp_seat",
      grant_id: seat.grantId,
      seat_id: seat.seatId,
    },
    { workspace_id: seat.workspaceId, stream: { kind: "workspace" } },
    "CommonSwarm lost the seat revocation result. Reload Connected apps before trying again.",
  );
  accepted(result.status, result.body, "the hosted seat");
}
