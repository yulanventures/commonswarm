import type { Session } from "@supabase/supabase-js";
import { CommandOutcomeUnknown, deployment, postCommand } from "./commonswarm";
import {
  ADMIN_PAGE_DEFAULT, ADMIN_RECOVERY_RESOURCE, adminReadRequest, parseAdminRecoveryPage,
  type AdminReadRequest, type AdminRecoveryPage,
} from "../../../src/cloud/admin-delegations-contract";
export type { AdminGrantView, AdminActionView, AdminRecoveryPage } from "../../../src/cloud/admin-delegations-contract";
export class AdminGrantRevokeRefused extends Error {}
export class AdminRecoveryReadError extends Error {
  constructor(readonly status: number) { super(`Admin access could not be read (HTTP ${status}). Sign in as the granting person, or view workspace history as its owner.`); }
}

export async function loadAdminRecovery(
  session: Session, resource: AdminReadRequest["resource"], workspaceId: string | null = null, before: string | null = null,
): Promise<AdminRecoveryPage> {
  const d = deployment();
  if (!d) throw new Error("This build is not connected to CommonSwarm.");
  const request = adminReadRequest({ resource, workspace_id: workspaceId, before, limit: ADMIN_PAGE_DEFAULT });
  if (!request) throw new Error("Choose a valid admin history view.");
  const response = await fetch(`${d.url}/functions/v1/read`, {
    method: "POST", headers: { authorization: `Bearer ${session.access_token}`, apikey: d.anonKey, "content-type": "application/json" },
    body: JSON.stringify(request), signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new AdminRecoveryReadError(response.status);
  return parseAdminRecoveryPage(await response.json());
}
export async function revokeAdminGrant(session: Session, grantId: string, commandId: string): Promise<void> {
  const result = await postCommand(session, commandId,
    { kind: "revoke_admin_delegation", grant_id: grantId, reason_code: "human_revoked" },
    { stream: { kind: "account" }, resource: ADMIN_RECOVERY_RESOURCE },
    "The revocation result is unavailable. Refresh admin access before retrying. The Revoke button retries the same request.",
  );
  if (result.status >= 500 || (result.status === 200 && (!result.body || result.body.status !== "accepted"))) throw new CommandOutcomeUnknown("The revocation result is unavailable. Refresh admin access before retrying. The Revoke button retries the same request.");
  if (result.status !== 200) throw new AdminGrantRevokeRefused("The grant was not revoked. Sign in as the granting person and retry.");
}
