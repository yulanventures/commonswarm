import type { Session } from "@supabase/supabase-js";
import { CommandOutcomeUnknown, deployment, postCommand } from "./commonswarm";
import { adminClientAction, assertAdminPageOwner } from "./admin-delegations-view";
import {
  ADMIN_PAGE_DEFAULT, ADMIN_RECOVERY_RESOURCE, adminReadRequest, parseAdminRecoveryPage,
  type AdminReadRequest, type AdminRecoveryPage, type AdminClientView,
} from "../../../src/cloud/admin-delegations-contract";
export type { AdminGrantView, AdminActionView, AdminRecoveryPage, AdminClientView, AdminWorkerView, AdminCoverageView } from "../../../src/cloud/admin-delegations-contract";
export { readAdminIssuanceGate } from "../../../src/cloud/admin-delegations-gate";
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
  const page = parseAdminRecoveryPage(await response.json());
  assertAdminPageOwner(page, session.user.id, workspaceId);
  return page;
}
async function accountCommand(session: Session, commandId: string, command: Record<string, unknown>): Promise<void> {
  const unknown = `The result is unavailable. Refresh admin access or retry this request. Retry ID: ${commandId}.`;
  const result = await postCommand(session, commandId, command,
    { stream: { kind: "account" }, resource: ADMIN_RECOVERY_RESOURCE }, unknown);
  if (result.status >= 500 || (result.status === 200 && (!result.body || result.body.status !== "accepted"))) throw new CommandOutcomeUnknown(unknown);
  if (result.status !== 200) throw new AdminGrantRevokeRefused("The request was refused. Sign in as the account owner and refresh before trying again.");
}
/** Called only after the person's explicit click; loading a client never approves it. */
export async function changeAdminClientApproval(session: Session, client: AdminClientView, action: "approve" | "withdraw", commandId: string): Promise<void> {
  if (adminClientAction(client, session.user.id) !== action) throw new AdminGrantRevokeRefused("This client approval action is unavailable. Refresh its verification and approval status.");
  await accountCommand(session, commandId, action === "approve" ?
    { kind: "approve_admin_client", client_id: client.client_id, verification_version: client.verification_version } :
    { kind: "withdraw_admin_client_approval", client_id: client.client_id, verification_version: client.verification_version, reason_code: "human_withdrawn" });
}
export async function revokeAdminGrant(session: Session, grantId: string, commandId: string): Promise<void> {
  await accountCommand(session, commandId, { kind: "revoke_admin_delegation", grant_id: grantId, reason_code: "human_revoked" });
}
