import type {
  AdminAccountEvent,
  AdminAccountState,
  AdminDecision,
  AdminDecisionContext,
  AdminGrant,
  AdminConnectionAttempt,
} from "./admin-authority.js";
import { adminRatePolicy } from "./admin-authority.js";
import {
  ADMIN_EXISTING_RESOURCE_CEILINGS,
  ADMIN_INVITATION_AND_ATTEMPT_TTL,
  ADMIN_INVITATION_ISSUE_PER_DAY,
  ADMIN_ISSUANCE_CEILINGS,
  ADMIN_RESOURCE,
  ADMIN_AVAILABILITY,
  ADMIN_REGISTRY_VERSION,
  adminCapabilityAvailable,
  adminEffectiveCapabilities,
  ADMIN_UUID_RE,
  ADMIN_WORKSPACE_CREATE_PER_DAY,
  adminExactKeys,
  adminGrantManifest,
  adminManifestValid,
  adminRecord,
  type AdminScope,
} from "./admin-policy.js";
import { isAgentScopeDenylisted } from "./workspace-commands.js";
import type {
  WorkspaceEventEnvelope,
  WorkspaceState,
} from "./workspace-events.js";

import {
  ADMIN_ROUTINE_EVENT_TYPES,
  type AdminRoutineEventType,
} from "./admin-routine-events.js";
export {
  ADMIN_ROUTINE_EVENT_TYPES,
  type AdminRoutineEventType,
} from "./admin-routine-events.js";
interface Base {
  grant_id: string;
  workspace_id: string;
}
export type AdminRoutineCommand =
  & Base
  & (
    | {
      kind: "admin_prepare_connection";
      intended_owner_user_id: string;
      intended_agent_id: string;
      recipient_connection_id: string;
      requested_name: string;
      transport: "local" | "hosted_mcp";
      ttl_seconds: number;
    }
    | { kind: "admin_cancel_connection"; attempt_id: string; reason_code: string }
    | { kind: "admin_create_workspace"; name: string }
    | {
      kind: "admin_create_seat";
      name: string;
      model: string | null;
      transport: "local" | "hosted_mcp";
    }
    | {
      kind: "admin_provision_seat";
      principal_id: string;
      recipient_connection_id: string;
      worker_scope_names: string[];
      bearer_seconds: number;
      horizon_seconds: number;
      max_successors: number;
    }
    | {
      kind: "admin_renew_seat";
      principal_id: string;
      predecessor_credential_id: string;
      recipient_connection_id: string;
      worker_scope_names: string[];
      bearer_seconds: number;
    }
    | {
      kind: "admin_replace_undelivered_seat_credential";
      principal_id: string;
      credential_id: string;
      recipient_connection_id: string;
    }
    | { kind: "admin_revoke_seat"; principal_id: string; reason_code: string }
    | {
      kind: "admin_revoke_seat_credential";
      principal_id: string;
      credential_id: string;
      reason_code: string;
    }
    | {
      kind: "admin_invite_member";
      recipient_user_id: string;
      role: "member";
      ttl_seconds: number;
    }
    | {
      kind: "admin_issue_agent_invitation";
      intended_owner_user_id: string;
      recipient_connection_id: string;
      transport: "local" | "hosted_mcp";
      seat_limit: number;
      worker_scope_names: string[];
      ttl_seconds: number;
    }
    | {
      kind: "admin_revoke_invitation" | "admin_revoke_agent_invitation";
      invitation_id: string;
      reason_code: string;
    }
  );
export interface RoutineCredential {
  credential_id: string;
  workspace_id: string;
  principal_id: string;
  worker_lineage_id: string;
  parent_admin_grant_id: string | null;
  recipient_connection_id: string;
  worker_scope_names: string[];
  expires_at: number;
  horizon_expires_at: number | null;
  bearer_seconds: number;
  max_successors: number | null;
  successors_used: number;
  kind: "timeboxed" | "standing";
  revoked_at: number | null;
  first_used_at: number | null;
  superseded: boolean;
  suspended: boolean;
  device_valid: boolean;
  run_id: string;
  task_id: string;
  epoch: number;
  renewal_grant_id: string;
  device_id: string;
}
export interface RoutineInvitation {
  invitation_id: string;
  workspace_id: string;
  parent_admin_grant_id: string;
  invitation_kind: "member" | "agent";
  recipient_user_id: string;
  recipient_connection_id: string | null;
  expires_at: number;
  revoked_at: number | null;
  accepted_at: number | null;
}
export interface AdminRoutineState {
  spend: Record<
    string,
    {
      workspaces: number;
      total_seats: number;
      invitations: number;
      worker_credentials: number;
      successors: number;
    }
  >;
  created_workspaces: Record<
    string,
    { grant_id: string; scope_names: AdminScope[] }
  >;
  seats: Record<
    string,
    { grant_id: string; workspace_id: string; revoked_at: number | null }
  >;
  credentials: Record<string, RoutineCredential>;
  invitations: Record<string, RoutineInvitation>;
}
export const emptyAdminRoutine = (): AdminRoutineState => ({
  spend: {},
  created_workspaces: {},
  seats: {},
  credentials: {},
  invitations: {},
});
export interface AdminRoutineContext extends AdminDecisionContext {
  workspace: WorkspaceState | null;
  workspace_stream_id: string;
  workspace_seq: number;
  owned_workspaces: number;
  workspace_creations_last_day: number;
  invitations_last_day: number;
  live_principals: number;
  live_members_and_invitations: number;
  live_agent_invitations_person: number;
  live_agent_invitations_workspace: number;
  human_worker_scopes: string[];
  recipient_exists: boolean;
  recipient_is_member: boolean;
  delivery_connection_id: string | null;
  target_credential: RoutineCredential | null;
  principal_lineage_ids: string[];
  nextResourceId(): string;
}
export interface AdminRoutineDecision extends AdminDecision {
  workspace_events: WorkspaceEventEnvelope[];
}
const uuid = (x: unknown): x is string =>
  typeof x === "string" && ADMIN_UUID_RE.test(x);
const text = (x: unknown, max: number): x is string =>
  typeof x === "string" && x.length > 0 && x.length <= max && x.trim() === x &&
  !/[\u0000-\u001f\u007f]/u.test(x);
const positive = (x: unknown): x is number =>
  Number.isSafeInteger(x) && Number(x) > 0;
const scopes = (x: unknown): x is string[] =>
  Array.isArray(x) && x.length > 0 && x.length <= 100 && x.every((s) =>
    text(s, 80) && /^[a-z][a-z0-9_:.-]*$/u.test(s) && !isAgentScopeDenylisted(s)
  ) && new Set(x).size === x.length;
const code = (x: unknown) =>
  typeof x === "string" && /^[a-z][a-z0-9_]{0,79}$/u.test(x);
export function parseAdminRoutineCommand(
  value: unknown,
): AdminRoutineCommand | null {
  const c = adminRecord(value);
  if (!c || typeof c.kind !== "string" || !adminCapabilityAvailable(c.kind) || !uuid(c.grant_id) || !uuid(c.workspace_id)) return null;
  const exact = (keys: string[]) =>
    adminExactKeys(c, ["kind", "grant_id", "workspace_id", ...keys]);
  let valid = false;
  switch (c.kind) {
    case "admin_prepare_connection":
      valid = exact(["intended_owner_user_id", "intended_agent_id", "recipient_connection_id", "requested_name", "transport", "ttl_seconds"]) &&
        uuid(c.intended_owner_user_id) && uuid(c.intended_agent_id) && uuid(c.recipient_connection_id) &&
        text(c.requested_name, 80) && ["local", "hosted_mcp"].includes(String(c.transport)) && positive(c.ttl_seconds);
      break;
    case "admin_cancel_connection":
      valid = exact(["attempt_id", "reason_code"]) && uuid(c.attempt_id) && code(c.reason_code);
      break;
    case "admin_create_workspace":
      valid = exact(["name"]) && text(c.name, 80);
      break;
    case "admin_create_seat":
      valid = exact(["name", "model", "transport"]) && text(c.name, 80) &&
        (c.model === null || text(c.model, 120)) &&
        ["local", "hosted_mcp"].includes(String(c.transport));
      break;
    case "admin_provision_seat":
      valid = exact([
        "principal_id",
        "recipient_connection_id",
        "worker_scope_names",
        "bearer_seconds",
        "horizon_seconds",
        "max_successors",
      ]) && uuid(c.principal_id) && uuid(c.recipient_connection_id) &&
        scopes(c.worker_scope_names) && positive(c.bearer_seconds) &&
        positive(c.horizon_seconds) && positive(c.max_successors);
      break;
    case "admin_renew_seat":
      valid = exact([
        "principal_id",
        "predecessor_credential_id",
        "recipient_connection_id",
        "worker_scope_names",
        "bearer_seconds",
      ]) && uuid(c.principal_id) && uuid(c.predecessor_credential_id) &&
        uuid(c.recipient_connection_id) && scopes(c.worker_scope_names) &&
        positive(c.bearer_seconds);
      break;
    case "admin_replace_undelivered_seat_credential":
      valid =
        exact(["principal_id", "credential_id", "recipient_connection_id"]) &&
        uuid(c.principal_id) && uuid(c.credential_id) &&
        uuid(c.recipient_connection_id);
      break;
    case "admin_revoke_seat":
      valid = exact(["principal_id", "reason_code"]) && uuid(c.principal_id) &&
        code(c.reason_code);
      break;
    case "admin_revoke_seat_credential":
      valid = exact(["principal_id", "credential_id", "reason_code"]) &&
        uuid(c.principal_id) && uuid(c.credential_id) && code(c.reason_code);
      break;
    case "admin_invite_member":
      valid = exact(["recipient_user_id", "role", "ttl_seconds"]) &&
        uuid(c.recipient_user_id) && c.role === "member" &&
        positive(c.ttl_seconds);
      break;
    case "admin_issue_agent_invitation":
      valid = exact([
        "intended_owner_user_id",
        "recipient_connection_id",
        "transport",
        "seat_limit",
        "worker_scope_names",
        "ttl_seconds",
      ]) && uuid(c.intended_owner_user_id) &&
        uuid(c.recipient_connection_id) &&
        ["local", "hosted_mcp"].includes(String(c.transport)) &&
        positive(c.seat_limit) && scopes(c.worker_scope_names) &&
        positive(c.ttl_seconds);
      break;
    case "admin_revoke_invitation":
    case "admin_revoke_agent_invitation":
      valid = exact(["invitation_id", "reason_code"]) &&
        uuid(c.invitation_id) && code(c.reason_code);
      break;
  }
  return valid ? c as unknown as AdminRoutineCommand : null;
}

/** No human impersonation and no I/O: both projections and budgets come from events. */
export function decideAdminRoutine(
  command: AdminRoutineCommand,
  account: AdminAccountState,
  ctx: AdminRoutineContext,
): AdminRoutineDecision {
  const events: AdminAccountEvent[] = [],
    workspace_events: WorkspaceEventEnvelope[] = [];
  const actor = ctx.actor, grant = account.grants[command.grant_id];
  let pendingConnection: AdminConnectionAttempt | undefined;
  const routine = account.routine ?? emptyAdminRoutine();
  const auditedGrant = actor.kind === "delegated_admin"
    ? account.grants[actor.grant_id]
    : grant;
  const rateGrant = auditedGrant &&
      (account.routine?.created_workspaces[command.workspace_id]?.grant_id ===
          auditedGrant.grant_id ||
        auditedGrant.workspace_selector === "owned_and_selected" &&
          ctx.workspace?.members[ctx.owner_user_id]?.role === "owner" &&
          ctx.workspace.members[ctx.owner_user_id].revoked_at === null)
    ? {
      ...auditedGrant,
      workspace_ids: [
        ...new Set([...auditedGrant.workspace_ids, command.workspace_id]),
      ],
    }
    : auditedGrant;
  const rates = rateGrant
    ? adminRatePolicy(
      actor,
      rateGrant,
      command.kind,
      command.workspace_id,
      null,
      command.grant_id,
    ).map(({ key, limit }) => {
      const start = Math.floor(ctx.now / 3_600_000),
        old = account.rate_buckets[key];
      return {
        key,
        limit,
        hour_start: start,
        attempts: old?.hour_start === start ? old.attempts + 1 : 1,
      };
    })
    : [];
  const emit = (
    type: AdminRoutineEventType | "AdminActionRecorded" | "AdminConnectionPrepared" | "AdminConnectionCancelled",
    payload: Record<string, unknown>,
  ) => {
    events.push({
      stream_kind: "account",
      owner_user_id: ctx.owner_user_id,
      stream_id: ctx.stream_id,
      seq: ctx.nextSeq(),
      event_id: ctx.nextEventId(),
      command_id: ctx.command_id,
      type,
      schema_version: 1,
      actor_user: null,
      actor_agent_principal: null,
      actor_run: null,
      admin_identity_id: auditedGrant?.admin_identity_id ?? null,
      grant_id: auditedGrant?.grant_id ?? null,
      grant_manifest_digest: auditedGrant?.manifest_digest ?? null,
      occurred_at_server: ctx.now,
      payload,
    });
    if (type !== "AdminActionRecorded" && type !== "AdminConnectionPrepared" && type !== "AdminConnectionCancelled") workspaceEmit(type, payload);
  };
  const workspaceEmit = (
    type: WorkspaceEventEnvelope["type"],
    payload: Record<string, unknown>,
  ) =>
    workspace_events.push({
      workspace_id: command.workspace_id,
      stream_id: ctx.workspace_stream_id,
      seq: ctx.workspace_seq + workspace_events.length + 1,
      event_id: ctx.nextEventId(),
      command_id: ctx.command_id,
      type,
      schema_version: 1,
      actor_user: null,
      actor_agent_principal: null,
      actor_run: null,
      occurred_at_server: ctx.now,
      admin_identity_id: grant.admin_identity_id,
      grant_id: grant.grant_id,
      grant_manifest_digest: grant.manifest_digest,
      payload,
    } as WorkspaceEventEnvelope);
  const finish = (reason: string | null) => {
    const related = [...events, ...workspace_events].map((e) => e.event_id);
    emit("AdminActionRecorded", {
      audit_record_id: ctx.nextEventId(),
      grant_id: auditedGrant?.grant_id ?? null,
      admin_identity_id: auditedGrant?.admin_identity_id ?? null,
      connection_id: auditedGrant?.connection_id ?? null,
      action: command.kind,
      target_kind: pendingConnection || "attempt_id" in command ? "connection" : "principal_id" in command
        ? "seat"
        : "invitation_id" in command
        ? "invitation"
        : "workspace",
      target_id: pendingConnection?.attempt_id ?? ("attempt_id" in command ? command.attempt_id : "principal_id" in command
        ? command.principal_id
        : "invitation_id" in command
        ? command.invitation_id
        : command.workspace_id),
      workspace_id: command.workspace_id,
      manifest_digest: auditedGrant?.manifest_digest ?? null,
      request_digest: ctx.request_digest,
      outcome: reason ? "refused" : pendingConnection || events.some((e) =>
          [
            "AdminSeatProvisioned",
            "AdminSeatRenewed",
            "AdminSeatCredentialReplaced",
            "AdminMemberInvited",
            "AdminAgentInvitationIssued",
          ].includes(e.type)
        )
        ? "pending"
        : "accepted",
      reason_code: reason,
      ...(!reason && pendingConnection ? { attempt_id: pendingConnection.attempt_id, delivery_state: pendingConnection.state } : {}),
      policy_check: {
        result: reason ?? "passed",
        buckets: rates.map(({ key, hour_start, attempts }) => ({
          key,
          hour_start,
          attempts,
        })),
      },
      related_event_ids: related,
      next_action: reason
        ? "Ask the granting person to review access."
        : command.kind === "admin_invite_member"
        ? "The recipient must sign in to /app, review the shared audience and history, and choose whether to join. The workspace owner must first confirm shared workspace settings."
        : pendingConnection || events.some((e) => e.payload.delivery_state)
        ? "The recipient must authorize setup and verify its connection."
        : "none",
      recovery_kind: reason ? "human" : "none",
    });
    return { ok: reason === null, reason, events, workspace_events };
  };
  if (!parseAdminRoutineCommand(command)) return finish("invalid_request");
  if (actor.kind !== "delegated_admin") {
    return finish("credential_kind_forbidden");
  }
  if (
    !grant || grant.owner_user_id !== ctx.owner_user_id ||
    actor.grant_id !== grant.grant_id ||
    actor.admin_identity_id !== grant.admin_identity_id ||
    actor.connection_id !== grant.connection_id ||
    actor.resource !== ADMIN_RESOURCE
  ) return finish("grant_binding_mismatch");
  if (
    grant.state !== "active" ||
    !adminManifestValid(adminGrantManifest(grant), ctx.now, false)
  ) return finish("grant_inactive");
  if (actor.access_expires_at <= ctx.now) return finish("credential_expired");
  if (rates.some((b) => !positive(b.attempts) || b.attempts > b.limit)) {
    return finish("rate_limited");
  }
  if (!actor.scope_names.every((s) => grant.scope_names.includes(s))) {
    return finish("scope_expansion_forbidden");
  }
  const scope = ADMIN_AVAILABILITY[ADMIN_REGISTRY_VERSION]?.[command.kind]?.scope;
  if (
    !scope || !grant.scope_names.includes(scope) ||
    !actor.scope_names.includes(scope)
  ) return finish("scope_forbidden");
  if (!adminEffectiveCapabilities(grant, actor.scope_names).includes(command.kind)) return finish("capability_forbidden");
  const created = routine.created_workspaces[command.workspace_id];
  if (command.kind !== "admin_create_workspace") {
    const selected = grant.workspace_ids.includes(command.workspace_id);
    const owned = grant.workspace_selector === "owned_and_selected" &&
      ctx.workspace?.members[ctx.owner_user_id]?.role === "owner";
    if (
      grant.withdrawn_workspace_ids.includes(command.workspace_id) ||
      !(selected || owned || created?.grant_id === grant.grant_id) ||
      (created?.grant_id === grant.grant_id &&
        (!created.scope_names.includes(scope) ||
          !grant.created_workspace_policy.scope_names.includes(scope)))
    ) return finish("workspace_forbidden");
    const member = ctx.workspace?.members[ctx.owner_user_id];
    if (
      !ctx.workspace || ctx.workspace.workspace.archived_at !== null ||
      !member || member.revoked_at !== null ||
      !["owner", "admin"].includes(member.role)
    ) return finish("current_rights_required");
  }
  const spend = routine.spend[grant.grant_id];
  if (!spend) return finish("counter_invalid");
  if (
    !Object.values(spend).every((n) => Number.isSafeInteger(n) && n >= 0) ||
    ![
      ctx.owned_workspaces,
      ctx.workspace_creations_last_day,
      ctx.invitations_last_day,
      ctx.live_principals,
      ctx.live_members_and_invitations,
      ctx.live_agent_invitations_person,
      ctx.live_agent_invitations_workspace,
    ].every((n) => Number.isSafeInteger(n) && n >= 0)
  ) return finish("counter_invalid");
  const budget = (key: keyof typeof ADMIN_ISSUANCE_CEILINGS, used: number) =>
    used < grant.issuance_limits[key];
  if (command.kind === "admin_prepare_connection") {
    if (command.intended_owner_user_id !== ctx.owner_user_id) return finish("human_confirmation_required");
    if (!ctx.recipient_exists || !grant.target_rules.recipient_user_ids.includes(command.intended_owner_user_id) ||
        !grant.target_rules.recipient_connection_ids.includes(command.recipient_connection_id) ||
        !grant.target_rules.transports.includes(command.transport)) return finish("recipient_forbidden");
    if (command.ttl_seconds > ADMIN_INVITATION_AND_ATTEMPT_TTL.attempt_seconds) return finish("connection_ttl_invalid");
    const attempts = Object.values(account.connections ?? {}).filter(a => a.parent_admin_grant_id === grant.grant_id);
    const prior = attempts.find(a => a.workspace_id === command.workspace_id &&
      a.intended_owner_user_id === command.intended_owner_user_id && a.intended_agent_id === command.intended_agent_id);
    if (prior) {
      if (prior.recipient_connection_id !== command.recipient_connection_id || prior.requested_name !== command.requested_name ||
          prior.transport !== command.transport || prior.ttl_seconds !== command.ttl_seconds) return finish("connection_target_conflict");
      if (prior.state === "cancelled") return finish("connection_attempt_cancelled");
      if (prior.expires_at <= ctx.now) return finish("connection_attempt_expired");
      pendingConnection = prior;
      return finish(null);
    }
    if (!budget("connection_attempts", attempts.length)) return finish("connection_attempt_limit_reached");
    pendingConnection = {
      attempt_id: ctx.nextResourceId(), parent_admin_grant_id: grant.grant_id, workspace_id: command.workspace_id,
      intended_owner_user_id: command.intended_owner_user_id, intended_agent_id: command.intended_agent_id,
      recipient_connection_id: command.recipient_connection_id, requested_name: command.requested_name,
      transport: command.transport, ttl_seconds: command.ttl_seconds, capability_set: [], state: "awaiting_authorization",
      created_at: ctx.now, expires_at: Math.min(ctx.now + command.ttl_seconds * 1000, grant.expires_at, grant.refresh_deadline),
      cancelled_at: null, reason_code: null,
    };
    emit("AdminConnectionPrepared", { ...pendingConnection, delivery_state: pendingConnection.state });
    return finish(null);
  }
  if (command.kind === "admin_cancel_connection") {
    const attempt = account.connections?.[command.attempt_id];
    if (!attempt || attempt.parent_admin_grant_id !== grant.grant_id || attempt.workspace_id !== command.workspace_id) {
      return finish("connection_attempt_forbidden");
    }
    if (attempt.state === "cancelled") return finish(null);
    emit("AdminConnectionCancelled", { attempt_id: attempt.attempt_id, cancelled_at: ctx.now,
      reason_code: command.reason_code, revoked_attempt_credential_ids: [], attempt_owned_seat_ids: [] });
    return finish(null);
  }
  if (command.kind === "admin_create_workspace") {
    if (ctx.workspace) return finish("workspace_exists");
    if (
      !budget("workspaces", spend.workspaces) ||
      ctx.owned_workspaces >=
        ADMIN_EXISTING_RESOURCE_CEILINGS.owned_workspaces ||
      ctx.workspace_creations_last_day >= ADMIN_WORKSPACE_CREATE_PER_DAY
    ) return finish("workspace_limit_reached");
    workspaceEmit("WorkspaceCreated", {
      workspace_id: command.workspace_id,
      name: command.name,
      created_by: ctx.owner_user_id,
      created_at: ctx.now,
    });
    emit("AdminWorkspaceCreated", {
      workspace_id: command.workspace_id,
      name: command.name,
      owner_user_id: ctx.owner_user_id,
      created_workspace_policy: grant.created_workspace_policy,
      applied_scope_names: grant.created_workspace_policy.scope_names,
      created_at: ctx.now,
    });
    return finish(null);
  }
  const principal = "principal_id" in command
    ? ctx.workspace!.principals[command.principal_id]
    : undefined;
  if ("principal_id" in command) {
    if (
      !principal || principal.owner_user_id !== ctx.owner_user_id ||
      !(grant.target_rules.seat_ids.includes(principal.principal_id) ||
        grant.target_rules.own_seats ||
        (grant.target_rules.grant_created_seats &&
          routine.seats[principal.principal_id]?.grant_id === grant.grant_id))
    ) return finish("target_forbidden");
    if (!grant.target_rules.transports.includes(principal.transport)) {
      return finish("transport_forbidden");
    }
    if (principal.revoked_at !== null && command.kind !== "admin_revoke_seat") {
      return finish("principal_revoked");
    }
  }
  if (command.kind === "admin_create_seat") {
    const live = Object.values(routine.seats).filter((s) =>
      s.grant_id === grant.grant_id && s.revoked_at === null
    ).length;
    if (
      !grant.target_rules.grant_created_seats ||
      !grant.target_rules.transports.includes(command.transport)
    ) {
      return finish("target_forbidden");
    }
    if (
      !budget("total_seats", spend.total_seats) ||
      !budget("live_seats", live) ||
      ctx.live_principals >= ADMIN_EXISTING_RESOURCE_CEILINGS.principals
    ) {
      return finish("seat_limit_reached");
    }
    if (
      Object.values(ctx.workspace!.principals).some((p) =>
        p.name === command.name
      )
    ) {
      return finish("principal_name_taken");
    }
    const principal_id = ctx.nextResourceId();
    const payload = {
      workspace_id: command.workspace_id,
      principal_id,
      owner_user_id: ctx.owner_user_id,
      name: command.name,
      model: command.model,
      transport: command.transport,
      turn_only: command.transport === "hosted_mcp",
      created_at: ctx.now,
      connection_attempt_id: null,
    };
    workspaceEmit("AgentPrincipalCreated", payload);
    emit("AdminSeatCreated", payload);
    return finish(null);
  }
  if (
    command.kind === "admin_invite_member" ||
    command.kind === "admin_issue_agent_invitation"
  ) {
    const agent = command.kind === "admin_issue_agent_invitation";
    const recipient = agent
      ? command.intended_owner_user_id
      : command.recipient_user_id;
    if (
      !ctx.recipient_exists ||
      !grant.target_rules.recipient_user_ids.includes(recipient)
    ) return finish("recipient_forbidden");
    if (
      !budget("invitations", spend.invitations) ||
      ctx.invitations_last_day >= ADMIN_INVITATION_ISSUE_PER_DAY
    ) return finish("invitation_limit_reached");
    if (
      !agent &&
      (ctx.recipient_is_member ||
        ctx.live_members_and_invitations >=
          ADMIN_EXISTING_RESOURCE_CEILINGS.members_and_invitations)
    ) return finish("member_limit_reached");
    if (agent) {
      if (
        !actor.scope_names.includes("seats:create") ||
        !grant.scope_names.includes("seats:create")
      ) return finish("scope_forbidden");
      if (recipient !== ctx.owner_user_id) {
        return finish("human_confirmation_required");
      }
      if (
        !grant.target_rules.recipient_connection_ids.includes(
          command.recipient_connection_id,
        ) || !grant.target_rules.transports.includes(command.transport) ||
        !command.worker_scope_names.every((s) =>
          grant.worker_scope_ceiling.includes(s) &&
          ctx.human_worker_scopes.includes(s)
        )
      ) return finish("recipient_forbidden");
      const live = Object.values(routine.invitations).filter((i) =>
        i.parent_admin_grant_id === grant.grant_id &&
        i.invitation_kind === "agent" && i.revoked_at === null &&
        i.accepted_at === null && i.expires_at > ctx.now
      ).length;
      if (
        !budget("live_agent_invitations", live) ||
        ctx.live_agent_invitations_person >=
          ADMIN_EXISTING_RESOURCE_CEILINGS.joins_per_person ||
        ctx.live_agent_invitations_workspace >=
          ADMIN_EXISTING_RESOURCE_CEILINGS.joins_per_workspace ||
        command.seat_limit > ADMIN_INVITATION_AND_ATTEMPT_TTL.agent_seats ||
        command.ttl_seconds <
          ADMIN_INVITATION_AND_ATTEMPT_TTL.agent_min_seconds ||
        command.ttl_seconds > ADMIN_INVITATION_AND_ATTEMPT_TTL.agent_max_seconds
      ) {
        return finish("invitation_limit_reached");
      }
    } else if (
      command.ttl_seconds > ADMIN_INVITATION_AND_ATTEMPT_TTL.member_seconds
    ) return finish("invitation_ttl_invalid");
    const invitation_id = ctx.nextResourceId(),
      expires_at = Math.min(
        ctx.now + command.ttl_seconds * 1000,
        grant.expires_at,
        grant.refresh_deadline,
      );
    emit(agent ? "AdminAgentInvitationIssued" : "AdminMemberInvited", {
      invitation_id,
      workspace_id: command.workspace_id,
      recipient_ref: recipient,
      recipient_user_id: recipient,
      intended_owner_user_id: recipient,
      recipient_connection_id: agent ? command.recipient_connection_id : null,
      invitation_kind: agent ? "agent" : "member",
      role: "member",
      transport: agent ? command.transport : null,
      seat_limit: agent ? command.seat_limit : null,
      worker_scope_ceiling: agent ? command.worker_scope_names : [],
      worker_policy: agent ? grant.renewal_limits : null,
      expires_at,
      parent_admin_grant_id: grant.grant_id,
      delivery_state: "awaiting_authorization",
      ...(!agent ? { delivery_channel: "recipient_app_inbox" } : {}),
    });
    return finish(null);
  }
  if (
    command.kind === "admin_revoke_invitation" ||
    command.kind === "admin_revoke_agent_invitation"
  ) {
    const invitation = routine.invitations[command.invitation_id];
    if (
      !invitation || invitation.workspace_id !== command.workspace_id ||
      invitation.parent_admin_grant_id !== grant.grant_id ||
      invitation.invitation_kind !==
        (command.kind === "admin_revoke_agent_invitation"
          ? "agent"
          : "member") ||
      !grant.target_rules.recipient_user_ids.includes(
        invitation.recipient_user_id,
      )
    ) return finish("target_forbidden");
    if (invitation.accepted_at !== null) {
      return finish("invitation_already_accepted");
    }
    if (invitation.revoked_at !== null || invitation.expires_at <= ctx.now) {
      return finish(null);
    }
    emit("AdminInvitationRevoked", {
      invitation_id: invitation.invitation_id,
      invitation_kind: invitation.invitation_kind,
      workspace_id: command.workspace_id,
      revoked_at: ctx.now,
      reason_code: command.reason_code,
    });
    return finish(null);
  }
  if (
    command.kind === "admin_revoke_seat" ||
    command.kind === "admin_revoke_seat_credential"
  ) {
    const credentials = Object.values(routine.credentials).filter((c) =>
      c.principal_id === principal!.principal_id && c.revoked_at === null
    );
    const target = ctx.target_credential;
    if (
      command.kind === "admin_revoke_seat_credential" &&
      (!target || target.principal_id !== principal!.principal_id ||
        target.workspace_id !== command.workspace_id)
    ) return finish("target_forbidden");
    if (
      command.kind === "admin_revoke_seat" && principal!.revoked_at !== null ||
      command.kind === "admin_revoke_seat_credential" &&
        target!.revoked_at !== null
    ) return finish(null);
    const affected = command.kind === "admin_revoke_seat"
      ? [
        ...ctx.principal_lineage_ids,
        ...credentials.map((c) => c.worker_lineage_id),
      ]
      : [target!.worker_lineage_id];
    workspaceEmit(
      command.kind === "admin_revoke_seat"
        ? "AgentPrincipalRevoked"
        : "AgentTokenRevoked",
      command.kind === "admin_revoke_seat"
        ? { principal_id: principal!.principal_id, revoked_at: ctx.now }
        : { token_id: command.credential_id, revoked_at: ctx.now },
    );
    emit(
      command.kind === "admin_revoke_seat"
        ? "AdminSeatRevoked"
        : "AdminSeatCredentialRevoked",
      {
        principal_id: principal!.principal_id,
        credential_id: command.kind === "admin_revoke_seat"
          ? null
          : command.credential_id,
        transport: principal!.transport,
        affected_lineage_ids: [...new Set(affected)],
        revoked_at: ctx.now,
        reason_code: command.reason_code,
      },
    );
    return finish(null);
  }
  if (
    command.kind !== "admin_provision_seat" &&
    command.kind !== "admin_renew_seat" &&
    command.kind !== "admin_replace_undelivered_seat_credential"
  ) return finish("human_confirmation_required");
  if (principal!.transport !== "local") {
    return finish("hosted_runtime_authorization_required");
  }
  if (
    !grant.target_rules.recipient_connection_ids.includes(
      command.recipient_connection_id,
    ) || ctx.delivery_connection_id !== command.recipient_connection_id
  ) return finish("recipient_runtime_required");
  if (!budget("worker_credentials", spend.worker_credentials)) {
    return finish("credential_limit_reached");
  }
  const prior = ctx.target_credential;
  if (command.kind !== "admin_provision_seat") {
    const predecessorId = command.kind === "admin_renew_seat"
      ? command.predecessor_credential_id
      : command.credential_id;
    if (
      !prior || prior.credential_id !== predecessorId ||
      prior.workspace_id !== command.workspace_id ||
      prior.principal_id !== principal!.principal_id ||
      prior.recipient_connection_id !== command.recipient_connection_id ||
      prior.revoked_at !== null || prior.superseded || prior.suspended ||
      !prior.device_valid || prior.expires_at <= ctx.now ||
      (prior.parent_admin_grant_id !== null &&
        prior.parent_admin_grant_id !== grant.grant_id)
    ) return finish("predecessor_unavailable");
    if (
      !Number.isSafeInteger(prior.successors_used) ||
      prior.successors_used < 0 || !positive(prior.bearer_seconds) ||
      !uuid(prior.run_id) || !uuid(prior.task_id) ||
      !Number.isSafeInteger(prior.epoch) || prior.epoch < 0 ||
      (prior.kind === "timeboxed"
        ? !positive(prior.max_successors)
        : prior.max_successors !== null || prior.horizon_expires_at !== null)
    ) return finish("renewal_policy_invalid");
    if (
      !grant.renewal_limits.grant_kinds.includes(prior.kind) ||
      !grant.renewal_limits.principal_ids.includes(prior.principal_id) &&
        routine.seats[prior.principal_id]?.grant_id !== grant.grant_id
    ) return finish("renewal_policy_forbidden");
    if (
      prior.kind === "timeboxed" &&
      (prior.horizon_expires_at === null ||
        prior.horizon_expires_at <= ctx.now ||
        prior.horizon_expires_at - ctx.now >
          grant.renewal_limits.horizon_seconds * 1000)
    ) return finish("renewal_horizon_reached");
    if (
      command.kind === "admin_renew_seat"
        ? prior.first_used_at === null
        : prior.first_used_at !== null
    ) return finish("credential_delivery_state_forbidden");
    if (
      spend.successors >= grant.renewal_limits.successors_per_grant ||
      prior.successors_used >=
        Math.min(
          prior.max_successors ?? Infinity,
          grant.renewal_limits.successors_per_worker,
        )
    ) return finish("renewal_successors_exhausted");
  } else if (
    Object.values(routine.credentials).some((c) =>
      c.principal_id === principal!.principal_id
    ) || Object.values(ctx.workspace!.tokens).some((t) =>
      t.principal_id === principal!.principal_id
    )
  ) return finish("credential_already_issued");
  const requestedScopes =
    command.kind === "admin_replace_undelivered_seat_credential"
      ? prior!.worker_scope_names
      : command.worker_scope_names;
  if (
    !requestedScopes.every((s) =>
      grant.worker_scope_ceiling.includes(s) &&
      ctx.human_worker_scopes.includes(s) &&
      (prior === null || prior.worker_scope_names.includes(s))
    )
  ) return finish("worker_scope_forbidden");
  const seconds = command.kind === "admin_replace_undelivered_seat_credential"
    ? prior!.bearer_seconds
    : command.bearer_seconds;
  if (
    !positive(seconds) || seconds > grant.renewal_limits.bearer_seconds ||
    prior !== null && seconds > prior.bearer_seconds
  ) return finish("renewal_policy_forbidden");
  if (
    command.kind === "admin_provision_seat" &&
    (!grant.renewal_limits.grant_kinds.includes("timeboxed") ||
      command.horizon_seconds > grant.renewal_limits.horizon_seconds ||
      command.max_successors > grant.renewal_limits.successors_per_worker)
  ) return finish("renewal_policy_forbidden");
  const credential_id = ctx.nextResourceId();
  const horizon = prior?.horizon_expires_at ??
    Math.min(
      ctx.now +
        (command.kind === "admin_provision_seat"
            ? command.horizon_seconds
            : 0) * 1000,
      grant.expires_at,
      grant.refresh_deadline,
    );
  const expires_at = Math.min(
    ctx.now + seconds * 1000,
    grant.expires_at,
    grant.refresh_deadline,
    prior?.kind === "standing" ? Infinity : horizon,
    command.kind === "admin_replace_undelivered_seat_credential"
      ? prior!.expires_at
      : Infinity,
  );
  const credential: RoutineCredential = {
    credential_id,
    workspace_id: command.workspace_id,
    principal_id: principal!.principal_id,
    worker_lineage_id: prior?.worker_lineage_id ?? ctx.nextResourceId(),
    parent_admin_grant_id: prior ? prior.parent_admin_grant_id : grant.grant_id,
    recipient_connection_id: command.recipient_connection_id,
    worker_scope_names: [...requestedScopes],
    expires_at,
    horizon_expires_at: prior?.kind === "standing" ? null : horizon,
    bearer_seconds: seconds,
    max_successors: prior
      ? prior.max_successors
      : command.kind === "admin_provision_seat"
      ? command.max_successors
      : 0,
    successors_used: (prior?.successors_used ?? 0) + (prior ? 1 : 0),
    kind: prior?.kind ?? "timeboxed",
    revoked_at: null,
    first_used_at: null,
    superseded: false,
    suspended: false,
    device_valid: true,
    run_id: prior?.run_id ?? ctx.nextResourceId(),
    task_id: prior?.task_id ?? ctx.nextResourceId(),
    epoch: prior?.epoch ?? 0,
    renewal_grant_id: prior?.renewal_grant_id ?? ctx.nextResourceId(),
    device_id: prior?.device_id ?? ctx.nextResourceId(),
  };
  if (command.kind === "admin_replace_undelivered_seat_credential") {
    workspaceEmit("AgentTokenRevoked", {
      token_id: prior!.credential_id,
      revoked_at: ctx.now,
    });
  }
  workspaceEmit("AgentTokenMinted", {
    token_id: credential_id,
    principal_id: principal!.principal_id,
    run_id: credential.run_id,
    task_id: credential.task_id,
    epoch: credential.epoch,
    scopes: requestedScopes,
    issued_at: ctx.now,
    expires_at,
  });
  emit(
    command.kind === "admin_provision_seat"
      ? "AdminSeatProvisioned"
      : command.kind === "admin_renew_seat"
      ? "AdminSeatRenewed"
      : "AdminSeatCredentialReplaced",
    {
      ...credential,
      credential,
      predecessor_credential_id: prior?.credential_id ?? null,
      successor_credential_id: credential_id,
      revoked_credential_id: prior?.credential_id ?? null,
      replacement_credential_id: credential_id,
      worker_policy: {
        kind: credential.kind,
        horizon_expires_at: credential.horizon_expires_at,
        max_successors: credential.max_successors,
        bearer_seconds: seconds,
      },
      dependent_on_admin_grant: credential.parent_admin_grant_id !== null,
      credential_expires_at: expires_at,
      remaining_budget: Math.min(
        grant.renewal_limits.successors_per_worker - credential.successors_used,
        grant.renewal_limits.successors_per_grant - spend.successors -
          (prior ? 1 : 0),
      ),
      delivery_state: "awaiting_delivery",
      policy_digest: ctx.request_digest,
      worker_policy_digest: ctx.request_digest,
    },
  );
  return finish(null);
}

export function reduceAdminRoutine(
  previous: AdminRoutineState | undefined,
  event: Pick<AdminAccountEvent, "type" | "grant_id" | "occurred_at_server" | "payload">,
): AdminRoutineState {
  const state = previous ?? emptyAdminRoutine(),
    p = event.payload,
    id = event.grant_id;
  const required: Record<AdminRoutineEventType, string[]> = {
    AdminMemberInvitationAccepted: ["invitation_id", "recipient_user_id", "accepted_at"],
    AdminWorkspaceCreated: [
      "workspace_id",
      "name",
      "owner_user_id",
      "created_workspace_policy",
      "applied_scope_names",
      "created_at",
    ],
    AdminSeatCreated: [
      "workspace_id",
      "principal_id",
      "owner_user_id",
      "name",
      "model",
      "transport",
      "turn_only",
      "created_at",
      "connection_attempt_id",
    ],
    AdminSeatProvisioned: [
      "principal_id",
      "credential_id",
      "recipient_connection_id",
      "worker_scope_names",
      "worker_policy",
      "parent_admin_grant_id",
      "dependent_on_admin_grant",
      "credential_expires_at",
      "delivery_state",
      "credential",
    ],
    AdminSeatRenewed: [
      "principal_id",
      "worker_lineage_id",
      "predecessor_credential_id",
      "successor_credential_id",
      "parent_admin_grant_id",
      "worker_scope_names",
      "expires_at",
      "remaining_budget",
      "policy_digest",
      "credential",
    ],
    AdminSeatCredentialReplaced: [
      "principal_id",
      "revoked_credential_id",
      "replacement_credential_id",
      "recipient_connection_id",
      "parent_admin_grant_id",
      "worker_scope_names",
      "worker_policy_digest",
      "expires_at",
      "remaining_budget",
      "delivery_state",
      "credential",
    ],
    AdminSeatRevoked: [
      "principal_id",
      "credential_id",
      "transport",
      "affected_lineage_ids",
      "revoked_at",
      "reason_code",
    ],
    AdminSeatCredentialRevoked: [
      "principal_id",
      "credential_id",
      "transport",
      "affected_lineage_ids",
      "revoked_at",
      "reason_code",
    ],
    AdminMemberInvited: [
      "invitation_id",
      "workspace_id",
      "recipient_ref",
      "role",
      "expires_at",
      "delivery_state",
      "recipient_user_id",
    ],
    AdminAgentInvitationIssued: [
      "invitation_id",
      "workspace_id",
      "intended_owner_user_id",
      "recipient_connection_id",
      "transport",
      "seat_limit",
      "worker_scope_ceiling",
      "worker_policy",
      "expires_at",
      "delivery_state",
      "recipient_user_id",
    ],
    AdminInvitationRevoked: [
      "invitation_id",
      "invitation_kind",
      "workspace_id",
      "revoked_at",
      "reason_code",
    ],
  };
  if (
    !required[event.type as AdminRoutineEventType]?.every((key) =>
      Object.hasOwn(p, key)
    )
  ) throw new Error("incomplete routine event");
  if (!id) throw new Error("routine event without grant");
  const spend = {
    ...(state.spend[id] ??
      {
        workspaces: 0,
        total_seats: 0,
        invitations: 0,
        worker_credentials: 0,
        successors: 0,
      }),
  };
  const next: AdminRoutineState = {
    ...state,
    spend: { ...state.spend, [id]: spend },
    created_workspaces: { ...state.created_workspaces },
    seats: { ...state.seats },
    credentials: { ...state.credentials },
    invitations: { ...state.invitations },
  };
  switch (event.type) {
    case "AdminWorkspaceCreated":
      spend.workspaces++;
      next.created_workspaces[String(p.workspace_id)] = {
        grant_id: id,
        scope_names: p.applied_scope_names as AdminScope[],
      };
      break;
    case "AdminSeatCreated":
      spend.total_seats++;
      next.seats[String(p.principal_id)] = {
        grant_id: id,
        workspace_id: String(p.workspace_id),
        revoked_at: null,
      };
      break;
    case "AdminSeatProvisioned":
    case "AdminSeatRenewed":
    case "AdminSeatCredentialReplaced": {
      const c = p.credential as unknown as RoutineCredential;
      spend.worker_credentials++;
      if (event.type !== "AdminSeatProvisioned") spend.successors++;
      next.credentials[c.credential_id] = c;
      const prior = next.credentials[String(p.predecessor_credential_id)];
      if (prior) {
        next.credentials[prior.credential_id] = {
          ...prior,
          superseded: true,
          revoked_at: event.type === "AdminSeatCredentialReplaced"
            ? event.occurred_at_server
            : prior.revoked_at,
        };
      }
      break;
    }
    case "AdminSeatRevoked":
    case "AdminSeatCredentialRevoked":
      if (
        event.type === "AdminSeatRevoked" && next.seats[String(p.principal_id)]
      ) {
        next.seats[String(p.principal_id)] = {
          ...next.seats[String(p.principal_id)],
          revoked_at: event.occurred_at_server,
        };
      }
      for (const [key, c] of Object.entries(next.credentials)) {
        if (
          c.principal_id === p.principal_id &&
          (event.type === "AdminSeatRevoked" ||
            (p.affected_lineage_ids as string[]).includes(c.worker_lineage_id))
        ) {
          next.credentials[key] = {
            ...c,
            revoked_at: event.occurred_at_server,
          };
        }
      }
      break;
    case "AdminMemberInvited":
    case "AdminAgentInvitationIssued":
      spend.invitations++;
      next.invitations[String(p.invitation_id)] = {
        invitation_id: String(p.invitation_id),
        workspace_id: String(p.workspace_id),
        parent_admin_grant_id: id,
        invitation_kind: event.type === "AdminMemberInvited"
          ? "member"
          : "agent",
        recipient_user_id: String(p.recipient_user_id),
        recipient_connection_id: p.recipient_connection_id as string | null,
        expires_at: Number(p.expires_at),
        accepted_at: null,
        revoked_at: null,
      };
      break;
    case "AdminMemberInvitationAccepted": {
      const i = next.invitations[String(p.invitation_id)];
      if (!i || i.invitation_kind !== "member" || i.parent_admin_grant_id !== id || i.recipient_user_id !== p.recipient_user_id || i.accepted_at !== null || i.revoked_at !== null || i.expires_at <= event.occurred_at_server || !Number.isSafeInteger(p.accepted_at) || p.accepted_at !== event.occurred_at_server) throw new Error("invalid human invitation acceptance");
      next.invitations[i.invitation_id] = { ...i, accepted_at: event.occurred_at_server };
      break;
    }
    case "AdminInvitationRevoked": {
      const i = next.invitations[String(p.invitation_id)];
      if (!i) throw new Error("unknown routine invitation");
      next.invitations[i.invitation_id] = {
        ...i,
        revoked_at: event.occurred_at_server,
      };
      break;
    }
  }
  return next;
}
