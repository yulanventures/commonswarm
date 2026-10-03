/** Human recovery views. No credential records or arbitrary event payloads. */
export const ADMIN_RECOVERY_RESOURCE = "https://api.commonswarm.com/admin";
export const ADMIN_PAGE_MAX = 100;
export const ADMIN_PAGE_DEFAULT = 50;
export const ADMIN_READ_RESOURCES = ["admin_grants", "admin_history", "admin_clients", "admin_workers", "admin_coverage"] as const;
export function isAdminReadResource(value: unknown): value is typeof ADMIN_READ_RESOURCES[number] {
  return typeof value === "string" && (ADMIN_READ_RESOURCES as readonly string[]).includes(value);
}
export function isAdminRecoveryRequest(value: unknown): value is AdminReadRequest { return adminReadRequest(value) !== null; }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
/** Renewal is a new authorization started in the assistant, with fresh consent.
 * The site offers guidance and ADMIN_RENEWAL_DOCS_URL; no site handoff.
 * GET/HEAD https://mcp.commonswarm.com/admin/gate is public, no-store, and returns
 * only {state:"closed"|"open"|"unavailable"}. It is not a swarm_read resource.
 * last_use_at is the last retained successful operation audit, not a usage counter.
 * Workers and effective coverage use their own pages, filtered by grant_id in
 * the caller. next_before is opaque; client cursors use a stable public-row ID.
 */
export const ADMIN_RENEWAL = "client-initiated";
export const ADMIN_RENEWAL_GUIDANCE = "Reconnect from your assistant to renew.";
export const ADMIN_RENEWAL_DOCS_URL = "https://github.com/yulanventures/commonswarm/blob/main/docs/design/2026-10-02-ADMIN-ISSUANCE-SPEC.md#app-changes";
export const ADMIN_GATE_URL = "https://mcp.commonswarm.com/admin/gate";
export interface AdminApprovalView {
  owner_user_id: string; verification_version: number; approved_at: string;
  approval_event_id: string; approval_command_id: string; withdrawn_at: string | null;
  withdrawal_event_id: string | null; withdrawal_reason: string | null;
}
export interface AdminClientView {
  client_id: string; publisher_identity: string; verification_version: number;
  active: boolean; reviewed_at: string; withdrawn_at: string | null;
  metadata_digest: string; reapproval_required: boolean; approval: AdminApprovalView | null;
}
export interface AdminWorkerView {
  principal_id: string; grant_id: string; workspace_id: string;
  created_at: string; revoked_at: string | null; state: "active" | "stopped";
}
export interface AdminCoverageView { workspace_id: string; grant_id: string }
type PolicyValue = string[] | number | boolean | null;
export interface AdminGrantView {
  owner_user_id: string | null; refresh_deadline: string | null;
  registry_version: number | null; capability_names: string[];
  availability_digest: string | null; manifest_digest: string | null;
  created_workspace_policy: Record<string, PolicyValue>; target_rules: Record<string, PolicyValue>;
  worker_scope_ceiling: string[]; role_ceiling: "member" | null;
  renewal_limits: Record<string, PolicyValue>; issuance_limits: Record<string, PolicyValue>;
  client: AdminClientView | null;
  family: { provider_grant_id: string; state: "pending" | "active" | "suspended" | "revoked" | "expired" } | null;
  issuance_status: "committed" | "unknown"; last_use_at: string | null;
  replaces_grant_id: string | null; worker_count: number; coverage_count: number;
  grant_id: string;
  admin_identity_id: string;
  connection_id: string;
  client_id: string;
  mode: "granular" | "full_account";
  scope_names: string[];
  workspace_selector: "selected" | "owned_and_selected";
  workspace_ids: string[];
  withdrawn_workspace_ids: string[];
  created_at: string;
  expires_at: string;
  state: "active" | "suspended" | "revoked" | "expired";
  reason_code: string | null;
}
export interface AdminActionView {
  seq: string;
  event_id: string;
  occurred_at_server: string;
  grant_id: string | null;
  admin_identity_id: string | null;
  actor_user: string | null;
  owner_user_id: string | null; provider_grant_id: string | null;
  action: string;
  target_kind: string;
  target_id: string | null;
  workspace_id: string | null;
  outcome: "accepted" | "refused" | "pending" | "failed";
  reason_code: string | null;
  next_action: string;
  recovery_kind: string;
  related_event_ids: string[];
}
export type AdminReadRequest = ({ resource: "admin_grants" | "admin_history" | "admin_clients" | "admin_workers" | "admin_coverage" }) & {
  workspace_id: string | null;
  limit: number;
  before: string | null;
};
export interface AdminRecoveryPage {
  clients: AdminClientView[]; workers: AdminWorkerView[]; coverage: AdminCoverageView[];
  renewal: typeof ADMIN_RENEWAL;
  grants: AdminGrantView[];
  actions: AdminActionView[];
  next_before: string | null;
  active: {
    grant_count: number;
    full_account_count: number;
    expires_at: string | null;
    full_account_expires_at: string | null;
  };
}
/** Remove terminal controls and bidi overrides; browser callers still use textContent. */
export function adminDisplayText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, " ").slice(0, 2048);
}
export function adminReadRequest(value: unknown): AdminReadRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  if (Object.keys(r).length !== 4 || !["resource", "workspace_id", "limit", "before"].every(k => Object.hasOwn(r, k)) ||
      !isAdminReadResource(r.resource) ||
      (r.resource === "admin_clients" && r.workspace_id !== null) ||
      (r.workspace_id !== null && (typeof r.workspace_id !== "string" || !UUID.test(r.workspace_id))) ||
      !Number.isInteger(r.limit) || Number(r.limit) < 1 || Number(r.limit) > ADMIN_PAGE_MAX ||
      (r.before !== null && !validAdminCursor(r.before))) return null;
  return { resource: r.resource as AdminReadRequest["resource"], workspace_id: typeof r.workspace_id === "string" ? r.workspace_id.toLowerCase() : null,
    limit: Number(r.limit), before: r.before as string | null };
}
export function validAdminCursor(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parts = value.split("|");
  return parts.length === 2 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(parts[0]!) &&
    Number.isFinite(Date.parse(parts[0]!)) && new Date(parts[0]!).toISOString() === parts[0] && UUID.test(parts[1]!);
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("CommonSwarm returned an unreadable admin view.");
  return value as Record<string, unknown>;
}
function text(value: unknown, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || value.length > 2048) throw new Error("CommonSwarm returned an invalid admin field.");
  return adminDisplayText(value);
}
function identifier(value: unknown, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !UUID.test(value)) throw new Error("CommonSwarm returned an invalid admin identifier.");
  return value.toLowerCase();
}
function timestamp(value: unknown, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || value.length > 40 || !Number.isFinite(Date.parse(value))) throw new Error("CommonSwarm returned an invalid admin time.");
  return new Date(value).toISOString();
}
function array<T>(value: unknown, parse: (v: unknown) => T, max = ADMIN_PAGE_MAX): T[] {
  if (!Array.isArray(value) || value.length > max) throw new Error("CommonSwarm returned an oversized admin view.");
  return value.map(parse);
}
function count(v: unknown): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw new Error("CommonSwarm returned invalid admin counts.");
  return v;
}
function positive(v: unknown): number { const n = count(v); if (!n) throw new Error("Invalid admin version."); return n; }
function digest(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v !== "string" || !/^[0-9a-f]{64}$/u.test(v)) throw new Error("Invalid admin snapshot digest.");
  return v;
}
function boolean(v: unknown): boolean { if (typeof v !== "boolean") throw new Error("Invalid admin flag."); return v; }
function policy(v: unknown, fields: Record<string, "strings" | "ids" | "number" | "boolean">): Record<string, PolicyValue> {
  const r = v == null ? {} : record(v);
  return Object.fromEntries(Object.entries(fields).map(([key, kind]) => {
    const value = r[key];
    return [key, value == null ? null : kind === "number" ? count(value) : kind === "boolean" ? boolean(value) :
      array(value, item => kind === "ids" ? identifier(item)! : text(item)!)];
  }));
}
function client(v: unknown): AdminClientView {
  const r = record(v), a = r.approval == null ? null : record(r.approval);
  const metadata = digest(r.metadata_digest); if (!metadata) throw new Error("Invalid verified metadata digest.");
  return { client_id: text(r.client_id)!, publisher_identity: text(r.publisher_identity)!,
    verification_version: positive(r.verification_version), active: boolean(r.active), reviewed_at: timestamp(r.reviewed_at)!,
    withdrawn_at: timestamp(r.withdrawn_at, true), metadata_digest: metadata, reapproval_required: boolean(r.reapproval_required),
    approval: a === null ? null : { owner_user_id: identifier(a.owner_user_id)!, verification_version: positive(a.verification_version),
      approved_at: timestamp(a.approved_at)!, approval_event_id: identifier(a.approval_event_id)!, approval_command_id: text(a.approval_command_id)!,
      withdrawn_at: timestamp(a.withdrawn_at, true), withdrawal_event_id: identifier(a.withdrawal_event_id, true), withdrawal_reason: text(a.withdrawal_reason, true) } };
}
function worker(v: unknown): AdminWorkerView {
  const r = record(v); if (r.state !== "active" && r.state !== "stopped") throw new Error("Invalid worker dependency state.");
  return { principal_id: identifier(r.principal_id)!, grant_id: identifier(r.grant_id)!, workspace_id: identifier(r.workspace_id)!,
    created_at: timestamp(r.created_at)!, revoked_at: timestamp(r.revoked_at, true), state: r.state };
}
function coverage(v: unknown): AdminCoverageView {
  const r = record(v);
  return { workspace_id: identifier(r.workspace_id)!, grant_id: identifier(r.grant_id)! };
}
function grant(value: unknown): AdminGrantView {
  const r = record(value);
  if ((r.mode !== "granular" && r.mode !== "full_account") ||
      !["active", "revoked", "suspended", "expired"].includes(String(r.state)) ||
      (r.workspace_selector !== "selected" && r.workspace_selector !== "owned_and_selected")) throw new Error("CommonSwarm returned an invalid admin grant state.");
  const f = r.family == null ? null : record(r.family);
  if (f && !["pending","active","suspended","revoked","expired"].includes(String(f.state))) throw new Error("Invalid admin family state.");
  if (r.issuance_status !== undefined && r.issuance_status !== "committed" && r.issuance_status !== "unknown") throw new Error("Invalid issuance state.");
  if (r.role_ceiling != null && r.role_ceiling !== "member") throw new Error("Invalid admin role ceiling.");
  return {
    owner_user_id: identifier(r.owner_user_id ?? null, true), refresh_deadline: timestamp(r.refresh_deadline ?? null, true),
    registry_version: r.registry_version == null ? null : positive(r.registry_version), capability_names: array(r.capability_names ?? [], v => text(v)!, 128),
    availability_digest: digest(r.availability_digest), manifest_digest: digest(r.manifest_digest),
    created_workspace_policy: policy(r.created_workspace_policy, {scope_names:"strings"}),
    target_rules: policy(r.target_rules, {seat_ids:"ids", own_seats:"boolean", grant_created_seats:"boolean", recipient_user_ids:"ids", recipient_connection_ids:"ids", transports:"strings"}),
    worker_scope_ceiling: array(r.worker_scope_ceiling ?? [], v => text(v)!), role_ceiling: r.role_ceiling === "member" ? "member" : null,
    renewal_limits: policy(r.renewal_limits, {grant_kinds:"strings", principal_ids:"ids", bearer_seconds:"number", horizon_seconds:"number", successors_per_worker:"number", successors_per_grant:"number"}),
    issuance_limits: policy(r.issuance_limits, {workspaces:"number", live_seats:"number", total_seats:"number", invitations:"number", live_agent_invitations:"number", worker_credentials:"number", connection_attempts:"number"}),
    client: r.client == null ? null : client(r.client), family: f === null ? null : {provider_grant_id:text(f.provider_grant_id)!,state:f.state as NonNullable<AdminGrantView["family"]>["state"]},
    issuance_status: r.issuance_status === "committed" ? "committed" : "unknown", last_use_at: timestamp(r.last_use_at ?? null, true),
    replaces_grant_id: identifier(r.replaces_grant_id ?? null, true), worker_count: count(r.worker_count ?? 0), coverage_count: count(r.coverage_count ?? 0),
    grant_id: identifier(r.grant_id)!, admin_identity_id: identifier(r.admin_identity_id)!, connection_id: identifier(r.connection_id)!,
    client_id: text(r.client_id)!, mode: r.mode, scope_names: array(r.scope_names, v => text(v)!), workspace_selector: r.workspace_selector,
    workspace_ids: array(r.workspace_ids, v => identifier(v)!), withdrawn_workspace_ids: array(r.withdrawn_workspace_ids, v => identifier(v)!),
    created_at: timestamp(r.created_at)!, expires_at: timestamp(r.expires_at)!, state: r.state as AdminGrantView["state"], reason_code: text(r.reason_code, true) };
}
function action(value: unknown): AdminActionView {
  const r = record(value);
  if (typeof r.seq !== "string" || !/^[1-9][0-9]{0,18}$/u.test(r.seq) ||
      !["accepted", "refused", "pending", "failed"].includes(String(r.outcome))) throw new Error("CommonSwarm returned an invalid admin action.");
  return { seq: r.seq, event_id: identifier(r.event_id)!, occurred_at_server: timestamp(r.occurred_at_server)!,
    grant_id: identifier(r.grant_id, true), admin_identity_id: identifier(r.admin_identity_id, true), actor_user: identifier(r.actor_user, true),
    owner_user_id: identifier(r.owner_user_id ?? null,true), provider_grant_id: text(r.provider_grant_id ?? null,true),
    action: text(r.action)!, target_kind: text(r.target_kind)!, target_id: text(r.target_id, true), workspace_id: identifier(r.workspace_id, true),
    outcome: r.outcome as AdminActionView["outcome"], reason_code: text(r.reason_code, true), next_action: text(r.next_action)!,
    recovery_kind: text(r.recovery_kind)!, related_event_ids: array(r.related_event_ids, v => identifier(v)!) };
}
/** Select the public fields again at the client boundary; never print a raw server body. */
export function parseAdminRecoveryPage(value: unknown): AdminRecoveryPage {
  const r = record(value), a = record(r.active);
  if (r.next_before !== null && !validAdminCursor(r.next_before)) throw new Error("CommonSwarm returned an invalid admin page cursor.");
  if (r.renewal !== undefined && r.renewal !== ADMIN_RENEWAL) throw new Error("Invalid admin renewal contract.");
  return { clients: array(r.clients ?? [],client), workers: array(r.workers ?? [],worker), coverage: array(r.coverage ?? [],coverage), renewal: ADMIN_RENEWAL,
    grants: array(r.grants, grant), actions: array(r.actions, action), next_before: r.next_before as string | null,
    active: { grant_count: count(a.grant_count), full_account_count: count(a.full_account_count),
      expires_at: timestamp(a.expires_at, true), full_account_expires_at: timestamp(a.full_account_expires_at, true) } };
}

/** A failed/unreadable gate lookup is unavailable; never infer availability. */
export function parseAdminGate(value: unknown): {state:"closed"|"open"|"unavailable"} {
  const r = record(value);
  if (Object.keys(r).length !== 1 || !["closed","open","unavailable"].includes(String(r.state))) throw new Error("Invalid admin gate response.");
  return { state:r.state as "closed"|"open"|"unavailable" };
}
