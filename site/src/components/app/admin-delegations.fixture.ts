import { ADMIN_AVAILABILITY, ADMIN_REGISTRY_VERSION, adminAvailabilityDigest } from "../../../../src/protocol/admin-policy.js";
import { parseAdminRecoveryPage } from "../../../../src/cloud/admin-delegations-contract.js";
export const owner = "11111111-1111-4111-8111-111111111111";
export const foreign = "22222222-2222-4222-8222-222222222222";
export const at = "2026-10-03T00:00:00.000Z";
export const policy = { version: ADMIN_REGISTRY_VERSION, digest: adminAvailabilityDigest(ADMIN_REGISTRY_VERSION), definitions: ADMIN_AVAILABILITY[ADMIN_REGISTRY_VERSION]! };
export const fixture = parseAdminRecoveryPage({
  clients: [{ client_id: '<img src=x onerror="window.injected=true">', publisher_identity: "Reviewed publisher", verification_version: 2,
    active: true, reviewed_at: at, withdrawn_at: null, metadata_digest: "a".repeat(64), reapproval_required: false,
    approval: { owner_user_id: owner, verification_version: 2, approved_at: at, approval_event_id: owner,
      approval_command_id: "human-approval", withdrawn_at: null, withdrawal_event_id: null, withdrawal_reason: null } }],
  grants: [{ owner_user_id: owner, grant_id: owner, admin_identity_id: owner, connection_id: owner,
    client_id: '<img src=x onerror="window.injected=true">', mode: "full_account", scope_names: ["admin:read", "workspaces:create"],
    workspace_selector: "owned_and_selected", workspace_ids: [], withdrawn_workspace_ids: [], created_at: at,
    expires_at: "2099-10-03T00:00:00.000Z", refresh_deadline: "2099-10-03T00:00:00.000Z", state: "active", reason_code: null,
    registry_version: 1, capability_names: ["admin_read_metadata"], availability_digest: "b".repeat(64), manifest_digest: "c".repeat(64),
    issuance_status: "committed", family: { provider_grant_id: "public-family", state: "active" }, last_use_at: at,
    worker_count: 1, coverage_count: 1, worker_scope_ceiling: ["read"], role_ceiling: "member",
    target_rules: { seat_ids: [], own_seats: true, grant_created_seats: false, recipient_user_ids: [owner],
      recipient_connection_ids: [], transports: ["hosted_mcp"] },
    renewal_limits: { bearer_seconds: 300 }, issuance_limits: { workspaces: 1 }, created_workspace_policy: { scope_names: ["admin:read"] } }],
  workers: [{ principal_id: owner, grant_id: owner, workspace_id: owner, created_at: at, revoked_at: null, state: "active" }],
  coverage: [{ workspace_id: owner, grant_id: owner }],
  actions: [{ seq: "1", event_id: owner, occurred_at_server: at, grant_id: owner, admin_identity_id: owner,
    actor_user: null, owner_user_id: owner, provider_grant_id: "public-family", action: "admin_prepare_connection",
    target_kind: "connection", target_id: owner, workspace_id: null, outcome: "refused", reason_code: "human_confirmation_required",
    next_action: "Ask the granting person to review this connection.", recovery_kind: "human", related_event_ids: [owner] }],
  next_before: null, renewal: "client-initiated",
  active: { grant_count: 1, full_account_count: 1, expires_at: "2099-10-03T00:00:00.000Z", full_account_expires_at: "2099-10-03T00:00:00.000Z" },
});
fixture.grants[0]!.client = fixture.clients[0]!;
