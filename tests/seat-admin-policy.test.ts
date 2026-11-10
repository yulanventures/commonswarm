import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decideSeatAdminEnd, decideSeatAdminGrant, parseSeatAdminCommand, seatAdminGrantPrecheck, seatAdminManifest, seatAdminScopedCommands,
  SEAT_ADMIN_ROLE_BUNDLES, type GrantFacts, type GrantSeatAdminCommand,
} from "../src/protocol/seat-admin.js";
import { HUMAN_ONLY_COMMANDS } from "../src/protocol/workspace-commands.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const AGENT = "33333333-3333-4333-8333-333333333333";
const WS = "44444444-4444-4444-8444-444444444444";
const WS2 = "55555555-5555-4555-8555-555555555555";
const ORG = "66666666-6666-4666-8666-666666666666";
const NOW = 1_800_000_000_000;

const wire = (patch: Record<string, unknown> = {}) => ({ kind: "grant_seat_admin", principal_id: AGENT, level: "workspace",
  scope_names: ["role:workspace_admin"], workspace_ids: [WS], organization_id: null, expires_at: null, ...patch });

function facts(patch: Partial<GrantFacts> = {}): GrantFacts {
  return {
    now: NOW,
    actor: { kind: "human", user_id: OWNER, interactive_at_seconds: NOW / 1000 - 60, csrf_verified: true, session_bound: true },
    principal: { owner_user_id: OWNER, revoked: false },
    workspaces: { [WS]: { grantor_live_owner: true, agent_live_member: true, archived: false },
      [WS2]: { grantor_live_owner: true, agent_live_member: true, archived: false } },
    organization: { grantor_live_owner: true, archived: false },
    existing_active: false,
    ...patch,
  };
}

test("the wire shape is closed; arrays come back sorted and unique", () => {
  assert.deepEqual(parseSeatAdminCommand(wire({ level: "scoped", scope_names: ["invites:create", "admin:read"], workspace_ids: [WS2, WS] })),
    { ...wire({ level: "scoped", scope_names: ["admin:read", "invites:create"], workspace_ids: [WS, WS2] }) });
  for (const [name, input] of [
    ["an extra key", { ...wire(), actor: OWNER }],
    ["a missing expiry key", Object.fromEntries(Object.entries(wire()).filter(([k]) => k !== "expires_at"))],
    ["an unknown level", wire({ level: "account" })],
    ["a repeated workspace", wire({ workspace_ids: [WS, WS] })],
    ["a non-uuid agent", wire({ principal_id: "me" })],
    ["a fractional expiry", wire({ expires_at: 1.5 })],
    ["an end with extra keys", { kind: "end_seat_admin", grant_id: AGENT, reason: "x" }],
    ["eleven workspaces", wire({ level: "scoped", scope_names: ["admin:read"],
      workspace_ids: Array.from({ length: 11 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`) })],
    ["nine scopes", wire({ level: "scoped", scope_names: Array.from({ length: 9 }, (_, i) => `scope:${i}`) })],
    ["a very long scope name", wire({ level: "scoped", scope_names: ["admin:read", "x".repeat(65)] })],
  ] as const) {
    assert.equal(parseSeatAdminCommand(input), null, name);
  }
  assert.deepEqual(parseSeatAdminCommand({ kind: "end_seat_admin", grant_id: AGENT }), { kind: "end_seat_admin", grant_id: AGENT });
});

test("a grant needs a fresh, CSRF-checked person who owns the agent and every covered target", () => {
  const cmd = (patch: Record<string, unknown> = {}) => parseSeatAdminCommand(wire(patch)) as GrantSeatAdminCommand;
  const cases: Array<[string, GrantSeatAdminCommand, Partial<GrantFacts>, string | null]> = [
    ["workspace admin, no end date", cmd(), {}, null],
    ["organization admin", cmd({ level: "organization", scope_names: ["role:organization_admin"], workspace_ids: [], organization_id: ORG }), {}, null],
    ["read-only scoped, 90 days", cmd({ level: "scoped", scope_names: ["admin:read"], expires_at: NOW + 90 * 86_400_000 }), {}, null],
    ["an agent", cmd(), { actor: { ...facts().actor, kind: "agent" } }, "credential_kind_forbidden"],
    ["a hosted seat", cmd(), { actor: { ...facts().actor, kind: "hosted_seat" } }, "credential_kind_forbidden"],
    ["a sign-in 301 s old", cmd(), { actor: { ...facts().actor, interactive_at_seconds: NOW / 1000 - 301 } }, "human_confirmation_required"],
    ["no sign-in time", cmd(), { actor: { ...facts().actor, interactive_at_seconds: null } }, "human_confirmation_required"],
    ["no CSRF", cmd(), { actor: { ...facts().actor, csrf_verified: false } }, "human_confirmation_required"],
    ["no session binding", cmd(), { actor: { ...facts().actor, session_bound: false } }, "human_confirmation_required"],
    ["someone else's agent", cmd(), { principal: { owner_user_id: OTHER, revoked: false } }, "agent_not_yours"],
    ["a retired agent", cmd(), { principal: { owner_user_id: OWNER, revoked: true } }, "agent_not_yours"],
    ["an unknown agent", cmd(), { principal: null }, "agent_not_yours"],
    ["a workspace the grantor doesn't own", cmd(), { workspaces: { [WS]: { grantor_live_owner: false, agent_live_member: true, archived: false } } }, "workspace_not_owned"],
    ["an archived workspace", cmd(), { workspaces: { [WS]: { grantor_live_owner: true, agent_live_member: true, archived: true } } }, "workspace_not_owned"],
    ["an unknown workspace", cmd(), { workspaces: {} }, "workspace_not_owned"],
    ["a workspace the agent isn't in", cmd(), { workspaces: { [WS]: { grantor_live_owner: true, agent_live_member: false, archived: false } } }, "agent_not_member"],
    ["an organization the grantor doesn't own", cmd({ level: "organization", scope_names: ["role:organization_admin"], workspace_ids: [], organization_id: ORG }),
      { organization: { grantor_live_owner: false, archived: false } }, "organization_not_owned"],
    ["an unknown organization", cmd({ level: "organization", scope_names: ["role:organization_admin"], workspace_ids: [], organization_id: ORG }),
      { organization: null }, "organization_not_owned"],
    ["an active grant already there", cmd(), { existing_active: true }, "seat_admin_exists"],
    ["an end in the past", cmd({ expires_at: NOW - 1 }), {}, "invalid_expiry"],
    ["an end past 90 days", cmd({ expires_at: NOW + 90 * 86_400_000 + 1 }), {}, "invalid_expiry"],
    ["scoped without admin:read", cmd({ level: "scoped", scope_names: ["invites:create"] }), {}, "scope_forbidden"],
    ["scoped with delegation", cmd({ level: "scoped", scope_names: ["admin:delegate", "admin:read"] }), {}, "scope_forbidden"],
    ["scoped with workspace creation", cmd({ level: "scoped", scope_names: ["admin:read", "workspaces:create"] }), {}, "scope_forbidden"],
    ["scoped with a role bundle", cmd({ level: "scoped", scope_names: ["admin:read", "role:workspace_admin"] }), {}, "scope_forbidden"],
    ["workspace level with the org bundle", cmd({ scope_names: ["role:organization_admin"] }), {}, "scope_forbidden"],
    ["workspace level in two workspaces", cmd({ workspace_ids: [WS, WS2] }), {}, "invalid_request"],
    ["organization level naming a workspace", cmd({ level: "organization", scope_names: ["role:organization_admin"], organization_id: ORG }), {}, "invalid_request"],
  ];
  for (const [name, command, patch, reason] of cases) {
    const decision = decideSeatAdminGrant(command, facts(patch));
    assert.equal(decision.ok ? null : decision.reason, reason, name);
  }
});

test("ending is human, CSRF-checked and needs no fresh sign-in; outsiders learn nothing", () => {
  const grant = { owner_user_id: OWNER, state: "active", level: "workspace" as const };
  const actor = { kind: "human" as const, user_id: OWNER, csrf_verified: true };
  for (const [name, f, expected] of [
    ["the grantor", { actor, grant, actor_owns_covered_target: false }, { ok: true, already_ended: false }],
    ["another owner of the workspace", { actor: { ...actor, user_id: OTHER }, grant, actor_owns_covered_target: true }, { ok: true, already_ended: false }],
    ["already ended", { actor, grant: { ...grant, state: "downgraded" }, actor_owns_covered_target: false }, { ok: true, already_ended: true }],
    ["someone with no say", { actor: { ...actor, user_id: OTHER }, grant, actor_owns_covered_target: false }, { ok: false, reason: "not_found" }],
    ["no CSRF", { actor: { ...actor, csrf_verified: false }, grant, actor_owns_covered_target: false }, { ok: false, reason: "human_confirmation_required" }],
    ["the agent itself", { actor: { ...actor, kind: "agent" as const }, grant, actor_owns_covered_target: false }, { ok: false, reason: "credential_kind_forbidden" }],
  ] as const) {
    assert.deepEqual(decideSeatAdminEnd(f), expected, name);
  }
});

test("registry v3 bundles are HezSec's exact table and pin into the manifest", () => {
  const workspace = [
    "add_agent_to_workspace", "admin_cancel_connection", "admin_create_seat", "admin_invite_member", "admin_issue_agent_invitation",
    "admin_prepare_connection", "admin_provision_seat", "admin_read_metadata", "admin_renew_seat",
    "admin_replace_undelivered_seat_credential", "admin_revoke_agent_invitation", "admin_revoke_invitation", "admin_revoke_seat",
    "admin_revoke_seat_credential", "change_role", "remove_agent_from_workspace", "remove_member", "rename_workspace", "set_workspace_lead",
  ];
  assert.deepEqual([...SEAT_ADMIN_ROLE_BUNDLES["role:workspace_admin"].commands], workspace);
  assert.deepEqual([...SEAT_ADMIN_ROLE_BUNDLES["role:organization_admin"].commands], [...workspace, "rename_organization"].sort());
  assert.ok(Object.isFrozen(SEAT_ADMIN_ROLE_BUNDLES["role:workspace_admin"].commands));
  // Never in either bundle: HezSec's human-only list.
  for (const never of ["create_workspace", "archive_workspace", "move_workspace_to_org", "accept_invitation", "create_agent_principal",
    "revoke_agent_principal", "set_agent_model", "mint_agent_token", "mint_agent_join_credential", "enable_agent_management",
    "disable_agent_management", "recover_agent_session", "grant_seat_admin", "end_seat_admin", "admin_create_workspace"]) {
    assert.ok(!SEAT_ADMIN_ROLE_BUNDLES["role:organization_admin"].commands.includes(never), never);
  }
  // The human-only list itself is unchanged: grants admit exceptions later, never by editing it.
  assert.ok(HUMAN_ONLY_COMMANDS.has("rename_workspace") && HUMAN_ONLY_COMMANDS.has("change_role"));
  assert.deepEqual(seatAdminScopedCommands(["admin:read", "workspaces:rename"]), ["admin_read_metadata", "rename_workspace"]);
  assert.ok(!seatAdminScopedCommands(["admin:read", "invites:create", "seats:create"]).includes("rename_workspace"));
  const manifest = seatAdminManifest(parseSeatAdminCommand(wire()) as GrantSeatAdminCommand);
  assert.deepEqual(manifest.capability_names, workspace);
  assert.equal(manifest.registry_version, 3);
  assert.equal(manifest.expires_at, null, "No end date is explicit null");
  assert.equal(manifest.policy.secret_delivery, "bound_recipient_only");
  assert.equal(manifest.policy.role_ceiling, "member");
});

test("the precheck settles who, confirmation and shape with no database facts at all", () => {
  const actor = facts().actor;
  const cmd = (patch: Record<string, unknown> = {}) => parseSeatAdminCommand(wire(patch)) as GrantSeatAdminCommand;
  for (const [name, command, who, reason] of [
    ["a good request", cmd(), actor, null],
    ["an agent", cmd(), { ...actor, kind: "agent" as const }, "credential_kind_forbidden"],
    ["no CSRF", cmd(), { ...actor, csrf_verified: false }, "human_confirmation_required"],
    ["a stale sign-in", cmd(), { ...actor, interactive_at_seconds: NOW / 1000 - 301 }, "human_confirmation_required"],
    ["workspace level in two workspaces", cmd({ workspace_ids: [WS, WS2] }), actor, "invalid_request"],
    ["a forbidden scope", cmd({ level: "scoped", scope_names: ["admin:read", "workspaces:create"] }), actor, "scope_forbidden"],
    ["an end past 90 days", cmd({ expires_at: NOW + 91 * 86_400_000 }), actor, "invalid_expiry"],
  ] as const) {
    assert.equal(seatAdminGrantPrecheck(command, who, NOW), reason, name);
  }
});

/* ---- 2b: an agent uses its grant ---- */
import {
  SEAT_ADMIN_AGENT_KINDS, SEAT_ADMIN_EXECUTED_KINDS, selectCoveringGrant, seatAdminPrincipalTargetRefusal, type SeatAdminGrantFacts,
} from "../src/protocol/seat-admin.js";
import { decideWorkspace, reduceWorkspace, type DecideWorkspaceCtx } from "../src/protocol/index.js";

const G = (patch: Partial<SeatAdminGrantFacts>): SeatAdminGrantFacts => ({ grant_id: "g-ws", owner_user_id: OWNER, level: "workspace",
  workspace_ids: [WS], organization_id: null, capability_names: [...SEAT_ADMIN_ROLE_BUNDLES["role:workspace_admin"].commands],
  expires_at: null, state: "active", ...patch });
const cover = (kind: string, patch: { org?: string | null; orgLive?: boolean; now?: number } = {}) => ({ kind, workspace_id: WS,
  workspace_org_id: patch.org === undefined ? ORG : patch.org, org_owner_live: () => patch.orgLive ?? true, now: patch.now ?? NOW });

test("one covering grant authorizes, in a fixed order; powers never combine across grants", () => {
  const ws = G({}), org = G({ grant_id: "g-org", level: "organization", workspace_ids: [], organization_id: ORG,
    capability_names: [...SEAT_ADMIN_ROLE_BUNDLES["role:organization_admin"].commands] });
  const scoped = G({ grant_id: "g-sc", level: "scoped", capability_names: seatAdminScopedCommands(["admin:read", "workspaces:rename"]) });
  const cases: Array<[string, SeatAdminGrantFacts[], ReturnType<typeof cover>, string]> = [
    ["workspace grant first", [scoped, org, ws], cover("set_workspace_lead"), "g-ws"],
    ["organization when no workspace grant", [scoped, org], cover("add_agent_to_workspace"), "g-org"],
    ["scoped rename", [scoped], cover("rename_workspace"), "g-sc"],
    ["expired grants do not count", [G({ expires_at: NOW })], cover("rename_workspace"), "seat_admin_inactive"],
    ["ended grants do not count", [G({ state: "downgraded" })], cover("rename_workspace"), "seat_admin_inactive"],
    ["no grant", [], cover("rename_workspace"), "seat_admin_inactive"],
    ["another workspace", [G({ workspace_ids: [WS2] })], cover("rename_workspace"), "seat_admin_workspace_not_covered"],
    ["organization moved away", [org], cover("rename_workspace", { org: WS2 }), "seat_admin_workspace_not_covered"],
    ["organization owner lost", [org], cover("rename_workspace", { orgLive: false }), "seat_admin_workspace_not_covered"],
    // A scoped grant covering the workspace but not the command does not borrow the lead power from elsewhere.
    ["scoped lacks the command", [scoped], cover("set_workspace_lead"), "seat_admin_scope_missing"],
  ];
  for (const [name, grants, facts, expected] of cases) {
    const d = selectCoveringGrant(grants, facts);
    assert.equal(d.ok ? d.grant.grant_id : d.reason, expected, name);
  }
});

test("agent targets: never itself, never another person's agent, never an agent with admin access", () => {
  const t = (patch: Partial<{ principal_id: string; owner_user_id: string; holds_active_seat_admin_grant: boolean }> | null) =>
    seatAdminPrincipalTargetRefusal({ acting_principal_id: AGENT, grantor_user_id: OWNER,
      target: patch === null ? null : { principal_id: "target", owner_user_id: OWNER, holds_active_seat_admin_grant: false, ...patch } });
  assert.equal(t({}), null);
  assert.equal(t({ principal_id: AGENT }), "seat_admin_target_protected");
  assert.equal(t({ owner_user_id: OTHER }), "seat_admin_target_protected");
  assert.equal(t({ holds_active_seat_admin_grant: true }), "seat_admin_target_protected");
  assert.equal(t(null), "forbidden");
  assert.deepEqual([...SEAT_ADMIN_EXECUTED_KINDS].filter((k) => !SEAT_ADMIN_AGENT_KINDS.includes(k)), [], "executed is a subset of admitted");
  assert.ok(SEAT_ADMIN_AGENT_KINDS.every((k) => HUMAN_ONLY_COMMANDS.has(k as never)), "all six stay human-only without a grant");
});

test("the reducer admits only rename and member removal for a seat admin agent, at an Admin's level, with the agent as actor", () => {
  const state = reduceWorkspace(null, { workspace_id: WS, stream_id: "s", command_id: "c", seq: 1, event_id: "e", type: "WorkspaceCreated",
    schema_version: 1, actor_user: OWNER, actor_agent_principal: null, actor_run: null, occurred_at_server: 1,
    payload: { workspace_id: WS, name: "Home", created_by: OWNER, created_at: 1 } } as never);
  let seq = 1;
  const ctx = (seatAdmin: boolean): DecideWorkspaceCtx => ({ now: 2, actor: { user: OWNER, agent_principal: AGENT, run: "run" },
    credential_kind: "agent", presenting_token_id: "token", command_id: "c2", workspace_id: WS, stream_id: "s",
    operatorAllowed: () => false, role: () => "owner", inviteeAlreadyMember: () => false, identityVerified: () => false,
    humanRights: () => [], landingAuthorityChangeResolved: () => true, nextSeq: () => ++seq, nextEventId: () => "e2",
    ...(seatAdmin ? { seat_admin: { grant_id: "g", grantor_user_id: OWNER } } : {}) });
  const rename = { kind: "rename_workspace", name: "Renamed" } as const;
  assert.equal(decideWorkspace(state, rename as never, ctx(false)).ok, false, "without the grant context: human only");
  const done = decideWorkspace(state, rename as never, ctx(true));
  assert.equal(done.ok, true);
  assert.equal(done.events[0]?.actor_agent_principal, AGENT);
  for (const kind of ["archive_workspace", "change_role", "invite_member"]) {
    const d = decideWorkspace(state, { kind, user_id: OTHER, role: "member" } as never, ctx(true));
    assert.equal(d.ok, false, `${kind} is never admitted to the reducer for an agent`);
  }
});
