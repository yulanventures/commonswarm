import { randomUUID } from "node:crypto";
import { commandEndpoint, readEndpoint, CLIENT_PROTOCOL_VERSION, type CloudTarget } from "./config.js";
import { ADMIN_PAGE_DEFAULT, ADMIN_RECOVERY_RESOURCE, adminReadRequest, parseAdminRecoveryPage, type AdminReadRequest, type AdminRecoveryPage } from "./admin-delegations-contract.js";

export class AdminRecoveryError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "AdminRecoveryError"; }
}
export class AdminRevokeUncertain extends AdminRecoveryError {
  constructor(readonly requestId: string) {
    super("outcome_unknown", `The revocation result did not return. Check cswarm admin grants before retrying. Retry this request with --request-id ${requestId}.`);
  }
}
export async function readAdminDelegations(
  target: CloudTarget, accessToken: string,
  input: Partial<Pick<AdminReadRequest, "workspace_id" | "limit" | "before">> & Pick<AdminReadRequest, "resource">,
  fetcher: typeof fetch = fetch,
): Promise<AdminRecoveryPage> {
  const request = adminReadRequest({ resource: input.resource, workspace_id: input.workspace_id ?? null,
    limit: input.limit ?? ADMIN_PAGE_DEFAULT, before: input.before ?? null });
  if (!request) throw new AdminRecoveryError("invalid_request", "Choose a valid workspace ID, page size, and cursor.");
  const response = await fetcher(readEndpoint(target), {
    method: "POST", headers: { authorization: `Bearer ${accessToken}`, apikey: target.anonKey, "content-type": "application/json" },
    body: JSON.stringify(request), signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new AdminRecoveryError("read_failed", `Admin access could not be read (HTTP ${response.status}). Sign in as the granting person, or view workspace history as its owner.`);
  return parseAdminRecoveryPage(await response.json());
}
/** Account revocation needs neither a workspace nor the delegated agent. */
export async function revokeAdminDelegation(
  target: CloudTarget, accessToken: string, grantId: string, requestId: string = randomUUID(), fetcher: typeof fetch = fetch,
): Promise<{ grant_id: string; request_id: string; state: "revoked" }> {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
  if (!uuid.test(grantId) || !uuid.test(requestId)) throw new AdminRecoveryError("invalid_request", "Use the full grant ID and a UUID request ID.");
  let response: Response, body: Record<string, unknown>;
  try {
    response = await fetcher(commandEndpoint(target), {
      method: "POST", headers: { authorization: `Bearer ${accessToken}`, apikey: target.anonKey, "content-type": "application/json" },
      body: JSON.stringify({ command_id: requestId, client_version: CLIENT_PROTOCOL_VERSION, stream: { kind: "account" }, resource: ADMIN_RECOVERY_RESOURCE,
        command: { kind: "revoke_admin_delegation", grant_id: grantId, reason_code: "human_revoked" } }), signal: AbortSignal.timeout(15_000),
    });
    body = await response.json() as Record<string, unknown>;
  } catch { throw new AdminRevokeUncertain(requestId); }
  if (response.status >= 500 || !body || typeof body !== "object") throw new AdminRevokeUncertain(requestId);
  if (!response.ok || body.status !== "accepted") throw new AdminRecoveryError("revoke_refused", `The grant was not revoked (HTTP ${response.status}). Sign in as the granting person and retry.`);
  return { grant_id: grantId, request_id: requestId, state: "revoked" };
}
