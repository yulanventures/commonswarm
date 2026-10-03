import type { AdminClientView, AdminGrantView, AdminRecoveryPage } from "../../../src/cloud/admin-delegations-contract";

/** Serialized by Astro from the enforcement registry; no Node crypto in the browser. */
export interface AdminSitePolicy {
  version: number;
  digest: string | null;
  definitions: Record<string, { scope: string; label: string; available: boolean }>;
}
export const ADMIN_SITE_RENEWAL_GUIDANCE = "To renew, reconnect from your assistant; you will be asked to approve again.";

export function adminGateNotice(state: "closed" | "open" | "unavailable"): string {
  return state === "open" ? "Admin connections are available. Each grant requires your approval in your assistant." :
    state === "closed" ? "No admin client can connect yet. You can review approvals, grants and history here." :
    "Admin connection availability could not be checked. No admin client can connect yet. Try refreshing this view.";
}
export function adminApprovalLines(client: AdminClientView): string[] {
  const a = client.approval;
  return [
    `Verified publisher: ${client.publisher_identity}. Client verification version ${client.verification_version} · ${client.active ? "active" : "withdrawn"}.`,
    a ? `Account-owner approval: version ${a.verification_version} · ${a.withdrawn_at ? `withdrawn ${a.withdrawn_at}` : `approved ${a.approved_at}`}.` : "Account-owner approval: not given for this verification version.",
    ...(client.reapproval_required ? ["This client needs your explicit approval for its current verification version."] : []),
    ...(a ? [`Approval owner ${a.owner_user_id}. Event ${a.approval_event_id}. Request ${a.approval_command_id}.`,
      ...(a.withdrawal_event_id ? [`Withdrawal event ${a.withdrawal_event_id}. Reason: ${a.withdrawal_reason ?? "unavailable"}.`] : [])] : []),
  ];
}
/** This is a UI affordance only; account commands enforce human ownership again. */
export function adminClientAction(client: AdminClientView, ownerId: string): "approve" | "withdraw" | null {
  if (client.approval && client.approval.owner_user_id !== ownerId) return null;
  if (client.approval?.withdrawn_at) return null;
  if (client.approval && client.approval.verification_version === client.verification_version) return "withdraw";
  return client.active ? "approve" : null;
}
function labels(names: string[], policy: AdminSitePolicy): string[] {
  return [...new Set(names.map(name => policy.definitions[name]?.label ?? `Unrecognized operation (${name})`))];
}
export function adminRenewalDiff(grant: AdminGrantView, policy: AdminSitePolicy) {
  // Current options are a comparison, never authority or an automatically selected proposal.
  const current = Object.keys(policy.definitions).filter(name => policy.definitions[name]!.available &&
    (grant.mode === "full_account" || grant.scope_names.includes(policy.definitions[name]!.scope))).sort();
  const added = current.filter(name => !grant.capability_names.includes(name));
  const removed = grant.capability_names.filter(name => !current.includes(name));
  return {
    changed: grant.registry_version !== policy.version || grant.availability_digest !== policy.digest || added.length > 0 || removed.length > 0,
    priorVersion: grant.registry_version, currentVersion: policy.version, added, removed,
    prior: labels(grant.capability_names, policy), current: labels(current, policy),
  };
}
function policyLines(title: string, values: Record<string, unknown>): string[] {
  return Object.entries(values).filter(([, value]) => value !== null).map(([key, value]) =>
    `${title} · ${key.replaceAll("_", " ")}: ${Array.isArray(value) ? value.join(", ") || "none" : String(value)}.`);
}
export function adminGrantLines(grant: AdminGrantView, policy: AdminSitePolicy, now = Date.now()): string[] {
  const state = grant.state === "active" && Date.parse(grant.expires_at) <= now ? "expired" : grant.state;
  const coverage = state === "active" && grant.issuance_status === "committed" ? grant.coverage_count : 0;
  return [
    `${grant.mode === "full_account" ? "Full account" : "Selected workspaces"} · ${state}.`,
    `Access ends ${new Date(grant.expires_at).toLocaleString()} (UTC ${grant.expires_at}). Refresh deadline: ${grant.refresh_deadline ?? "unavailable"}.`,
    `Approved permissions: ${labels(grant.capability_names, policy).join(", ") || "no capability snapshot available"}.`,
    "Read-only covers this connection's permissions and status; it cannot read workspace messages or files. Workers may read content within their own access limits.",
    `Consent registry version ${grant.registry_version ?? "unavailable"}.`,
    `OAuth family: ${grant.family?.state ?? "unavailable"}${grant.family ? ` · ${grant.family.provider_grant_id}` : ""}.`,
    grant.issuance_status === "committed" ? "Issuance was recorded. Current access also depends on the grant, client approval and family status." : "Issuance result unknown. This grant does not establish a usable admin connection. Refresh to check its recorded outcome.",
    `Last retained successful operation: ${grant.last_use_at ?? "none recorded"}.`,
    `${grant.workspace_selector === "owned_and_selected" ? "Existing and future owned workspaces, plus selected shared workspaces" : "Selected workspaces"}: ${grant.workspace_ids.join(", ") || "none"}.`,
    `Workspace access withdrawn: ${grant.withdrawn_workspace_ids.join(", ") || "none"}. Effective coverage: ${coverage} workspaces.`,
    `Worker dependencies: ${grant.worker_count}. Revoking this grant stops dependent access. Previously read data remains.`,
    `Worker permission ceiling: ${grant.worker_scope_ceiling.join(", ") || "none"}. Member role ceiling: ${grant.role_ceiling ?? "unavailable"}.`,
    ...policyLines("Created workspace permissions", grant.created_workspace_policy),
    ...policyLines("Targets and recipients", grant.target_rules),
    ...policyLines("Seat renewal limits", grant.renewal_limits),
    ...policyLines("Setup limits", grant.issuance_limits),
    "Billing changes and further admin grants are unavailable.",
    `Grant ${grant.grant_id}. Connection ${grant.connection_id}.`,
    ...(grant.replaces_grant_id ? [`Replaces grant ${grant.replaces_grant_id}. Stopped worker access is not revived; new worker access needs separate approval.`] : []),
    ...(grant.reason_code ? [`Reason: ${grant.reason_code}.`] : []),
    ...(grant.client ? adminApprovalLines(grant.client) : ["Client verification and approval details are unavailable."]),
  ];
}
/** Defense at the site boundary: never render a foreign account's private projection. */
export function assertAdminPageOwner(page: AdminRecoveryPage, ownerId: string, workspaceId: string | null): void {
  const clients = [...page.clients, ...page.grants.flatMap(g => g.client ? [g.client] : [])];
  if (page.grants.some(g => g.owner_user_id !== ownerId) ||
      clients.some(c => c.approval && c.approval.owner_user_id !== ownerId) ||
      page.actions.some(a => (workspaceId === null && a.owner_user_id !== ownerId) ||
        (a.owner_user_id !== null && a.owner_user_id !== ownerId) ||
        (workspaceId !== null && a.workspace_id !== workspaceId) ||
        (a.owner_user_id === null && a.provider_grant_id !== null))) {
    throw new Error("This admin view could not be verified for your account. Refresh or sign in again.");
  }
}
