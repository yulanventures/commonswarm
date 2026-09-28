// GENERATED from src/protocol/index.ts; do not hand-edit.

// src/protocol/events.ts
var SCHEMA_VERSION = 1;
function canonicalPrincipal(actor) {
  const p = actor.agent_principal ?? actor.user;
  if (!p) throw new Error("actor has neither agent_principal nor user");
  return p;
}
var EVENT_TYPES = [
  "TaskCreated",
  "LeaseAcquired",
  "LeaseRenewed",
  "LeaseHandedOff",
  "LeaseTakenOver",
  "TaskSubmitted",
  "TaskClosed",
  "TaskReopened",
  "CommandRejected"
];
function leaseLive(state, now) {
  return state.owner !== null && state.lease_expiry !== null && state.lease_expiry > now;
}

// src/protocol/reducer.ts
function req(payload, keys, type, seq) {
  if (!payload || typeof payload !== "object") throw new StreamIntegrityError(`event "${type}" at seq ${seq} has a non-object payload`);
  for (const k of keys) {
    if (payload[k] === void 0) {
      throw new StreamIntegrityError(`event "${type}" at seq ${seq} is missing payload field "${String(k)}"`);
    }
  }
  return payload;
}
var UnknownEventTypeError = class extends Error {
  constructor(type, seq) {
    super(`unknown authoritative event type "${type}" at seq ${seq}; halting`);
    this.type = type;
    this.seq = seq;
    this.name = "UnknownEventTypeError";
  }
  type;
  seq;
};
var StreamIntegrityError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "StreamIntegrityError";
  }
};
function reduceTask(prev, env3) {
  if (!EVENT_TYPES.includes(env3.type)) {
    throw new UnknownEventTypeError(env3.type, env3.seq);
  }
  if (env3.schema_version !== SCHEMA_VERSION) {
    throw new StreamIntegrityError(`event "${env3.type}" at seq ${env3.seq} is schema v${env3.schema_version}, expected v${SCHEMA_VERSION} (upcast before reduce)`);
  }
  if (env3.type === "CommandRejected") {
    if (!prev) throw new StreamIntegrityError(`CommandRejected before task exists (seq ${env3.seq})`);
    req(env3.payload, ["task_id", "command", "reason", "detail"], env3.type, env3.seq);
    return prev;
  }
  if (env3.type === "TaskCreated") {
    if (prev) throw new StreamIntegrityError(`TaskCreated for an already-existing task (seq ${env3.seq})`);
    const p = req(env3.payload, ["task_id", "slug"], env3.type, env3.seq);
    return {
      task_id: p.task_id,
      slug: p.slug,
      lifecycle: "open",
      version: 1,
      epoch: 0,
      owner: null,
      lease_expiry: null,
      submission: null,
      closed_disposition: null
    };
  }
  if (!prev) throw new StreamIntegrityError(`event "${env3.type}" before TaskCreated (seq ${env3.seq})`);
  const s = prev;
  function assertEpochIncrease(ep) {
    if (typeof ep !== "number" || ep <= s.epoch) {
      throw new StreamIntegrityError(`${env3.type} at seq ${env3.seq} has non-increasing epoch ${ep} (current ${s.epoch})`);
    }
  }
  const leaseLifecycle = s.submission ? "awaiting_review" : "active";
  switch (env3.type) {
    case "LeaseAcquired": {
      const p = req(env3.payload, ["task_id", "epoch", "owner", "lease_expiry"], env3.type, env3.seq);
      assertEpochIncrease(p.epoch);
      return { ...s, lifecycle: leaseLifecycle, epoch: p.epoch, owner: p.owner, lease_expiry: p.lease_expiry };
    }
    case "LeaseRenewed": {
      const p = req(env3.payload, ["task_id", "epoch", "lease_expiry"], env3.type, env3.seq);
      if (p.epoch !== s.epoch) throw new StreamIntegrityError(`LeaseRenewed at seq ${env3.seq} epoch ${p.epoch} != current ${s.epoch}`);
      return { ...s, lease_expiry: p.lease_expiry };
    }
    case "LeaseHandedOff": {
      const p = req(env3.payload, ["task_id", "epoch", "from_owner", "to_owner", "lease_expiry"], env3.type, env3.seq);
      assertEpochIncrease(p.epoch);
      return { ...s, lifecycle: leaseLifecycle, epoch: p.epoch, owner: p.to_owner, lease_expiry: p.lease_expiry };
    }
    case "LeaseTakenOver": {
      const p = req(env3.payload, ["task_id", "epoch", "owner", "lease_expiry", "grant_id"], env3.type, env3.seq);
      assertEpochIncrease(p.epoch);
      return { ...s, lifecycle: leaseLifecycle, epoch: p.epoch, owner: p.owner, lease_expiry: p.lease_expiry };
    }
    case "TaskSubmitted": {
      const p = req(env3.payload, ["task_id", "epoch", "branch", "head_sha", "evidence_set"], env3.type, env3.seq);
      return {
        ...s,
        lifecycle: "awaiting_review",
        submission: { epoch: p.epoch, branch: p.branch, head_sha: p.head_sha, evidence_set: [...p.evidence_set] }
      };
    }
    case "TaskClosed": {
      const p = req(env3.payload, ["task_id", "epoch", "disposition", "grant_id"], env3.type, env3.seq);
      return { ...s, lifecycle: "done", closed_disposition: p.disposition };
    }
    case "TaskReopened": {
      const p = req(env3.payload, ["task_id", "version"], env3.type, env3.seq);
      if (p.version <= s.version) throw new StreamIntegrityError(`TaskReopened at seq ${env3.seq} version ${p.version} not > current ${s.version}`);
      return { ...s, lifecycle: "reopened", version: p.version, submission: null, owner: null, lease_expiry: null };
    }
    default: {
      throw new UnknownEventTypeError(env3.type, env3.seq);
    }
  }
}
function reduceStream(events) {
  let state = null;
  let lastSeq = -Infinity;
  for (const env3 of events) {
    if (env3.seq <= lastSeq) {
      throw new StreamIntegrityError(`events out of order or duplicated: seq ${env3.seq} after ${lastSeq}`);
    }
    lastSeq = env3.seq;
    state = reduceTask(state, env3);
  }
  return state;
}

// src/protocol/commands.ts
var DISPOSITIONS = ["merged", "pr", "archive", "discard"];
function env(ctx, type, payload) {
  return {
    workspace_id: ctx.workspace_id,
    stream_id: ctx.stream_id,
    seq: ctx.nextSeq(),
    event_id: ctx.nextEventId(),
    command_id: ctx.command_id,
    type,
    schema_version: SCHEMA_VERSION,
    actor_user: ctx.actor.user,
    actor_agent_principal: ctx.actor.agent_principal,
    actor_run: ctx.actor.run,
    occurred_at_server: ctx.now,
    payload
  };
}
function authz(reason, detail) {
  return { ok: false, class: "authz", reason, detail, events: [] };
}
function domain(ctx, task_id, command, reason, detail) {
  const rej = env(ctx, "CommandRejected", { task_id, command, reason, detail });
  return { ok: false, class: "domain", reason, detail, events: [rej] };
}
function accept(events) {
  return { ok: true, events };
}
function decide(state, cmd, ctx) {
  const me = canonicalPrincipal(ctx.actor);
  if (!ctx.isMember(me)) return authz("bad_state", "caller is not a current member");
  if (cmd.kind === "create") {
    if (state) return domain(ctx, cmd.task_id, "create", "slug_not_unique", "task already exists");
    if (ctx.slugTaken(cmd.slug)) return domain(ctx, cmd.task_id, "create", "slug_not_unique", "slug already in use in this stream");
    return accept([env(ctx, "TaskCreated", { task_id: cmd.task_id, slug: cmd.slug })]);
  }
  if (!state) return domain(ctx, cmd.task_id, cmd.kind, "unknown_task", "no such task in this stream");
  const s = state;
  const live = leaseLive(s, ctx.now);
  if ("ttl_ms" in cmd && (!Number.isFinite(cmd.ttl_ms) || cmd.ttl_ms <= 0)) {
    return domain(ctx, cmd.task_id, cmd.kind, "bad_state", "ttl_ms must be a finite positive number");
  }
  switch (cmd.kind) {
    case "acquire": {
      const acquirable = s.lifecycle === "open" || s.lifecycle === "reopened" || (s.lifecycle === "active" || s.lifecycle === "awaiting_review") && !live;
      if (!acquirable) {
        const why = s.lifecycle === "done" ? "task is done; reopen first" : "lease is live; use takeover";
        return domain(ctx, cmd.task_id, "acquire", "not_acquirable", why);
      }
      const epoch = s.epoch + 1;
      return accept([env(ctx, "LeaseAcquired", { task_id: cmd.task_id, epoch, owner: me, lease_expiry: ctx.now + cmd.ttl_ms })]);
    }
    case "renew": {
      if (s.lifecycle === "done") return domain(ctx, cmd.task_id, "renew", "already_done", "task is done; nothing to renew");
      if (s.owner !== me) return domain(ctx, cmd.task_id, "renew", "not_owner", "only the lease owner may renew");
      if (cmd.epoch !== s.epoch) return domain(ctx, cmd.task_id, "renew", "stale_epoch", `presented epoch ${cmd.epoch} != current ${s.epoch}`);
      if (!live) return domain(ctx, cmd.task_id, "renew", "lease_expired", "lease already expired; re-acquire");
      return accept([env(ctx, "LeaseRenewed", { task_id: cmd.task_id, epoch: s.epoch, lease_expiry: ctx.now + cmd.ttl_ms })]);
    }
    case "handoff": {
      if (s.owner !== me) return domain(ctx, cmd.task_id, "handoff", "not_owner", "only the lease owner may hand off");
      if (cmd.epoch !== s.epoch) return domain(ctx, cmd.task_id, "handoff", "stale_epoch", `presented epoch ${cmd.epoch} != current ${s.epoch}`);
      if (!live) return domain(ctx, cmd.task_id, "handoff", "lease_expired", "lease expired; cannot hand off");
      if (s.lifecycle === "awaiting_review") return domain(ctx, cmd.task_id, "handoff", "bad_state", "cannot hand off during awaiting_review; close or reopen first");
      if (!ctx.isEligibleRecipient(cmd.to_owner)) return domain(ctx, cmd.task_id, "handoff", "recipient_not_member", "recipient is not a current member/principal");
      const epoch = s.epoch + 1;
      return accept([env(ctx, "LeaseHandedOff", { task_id: cmd.task_id, epoch, from_owner: me, to_owner: cmd.to_owner, lease_expiry: ctx.now + cmd.ttl_ms })]);
    }
    case "takeover": {
      if (s.lifecycle === "done") return domain(ctx, cmd.task_id, "takeover", "not_acquirable", "task is done; reopen first");
      if (live) {
        if (s.lifecycle === "awaiting_review") return domain(ctx, cmd.task_id, "takeover", "bad_state", "cannot take over during awaiting_review; close or reopen first");
        if (!ctx.validTakeoverGrant(cmd.task_id, cmd.grant_id, s.epoch, me)) {
          return domain(ctx, cmd.task_id, "takeover", "live_lease_needs_grant", "live lease; a takeover grant bound to the current epoch and issued to you is required");
        }
      }
      const epoch = s.epoch + 1;
      return accept([env(ctx, "LeaseTakenOver", { task_id: cmd.task_id, epoch, owner: me, lease_expiry: ctx.now + cmd.ttl_ms, grant_id: live ? cmd.grant_id : null })]);
    }
    case "submit": {
      if (s.owner !== me) return domain(ctx, cmd.task_id, "submit", "not_owner", "only the lease owner may submit");
      if (cmd.epoch !== s.epoch) return domain(ctx, cmd.task_id, "submit", "stale_epoch", `presented epoch ${cmd.epoch} != current ${s.epoch}`);
      if (!live) return domain(ctx, cmd.task_id, "submit", "lease_expired", "lease expired; re-acquire before submitting");
      if (s.lifecycle === "done") return domain(ctx, cmd.task_id, "submit", "already_done", "task is done");
      if (!ctx.evidenceComplete(cmd.task_id, cmd.evidence_set)) return domain(ctx, cmd.task_id, "submit", "evidence_incomplete", "evidence bundle missing/invalid for this claim");
      return accept([env(ctx, "TaskSubmitted", { task_id: cmd.task_id, epoch: s.epoch, branch: cmd.branch, head_sha: cmd.head_sha, evidence_set: [...cmd.evidence_set] })]);
    }
    case "close": {
      if (s.lifecycle === "done") return domain(ctx, cmd.task_id, "close", "already_done", "task is already done");
      if (!s.submission) return domain(ctx, cmd.task_id, "close", "not_submitted", "no frozen submission to close");
      if (cmd.epoch !== s.submission.epoch) return domain(ctx, cmd.task_id, "close", "stale_epoch", `presented epoch ${cmd.epoch} != submission epoch ${s.submission.epoch} (superseded?)`);
      const roleOf = ctx.role(me);
      const isAdmin = roleOf === "owner" || roleOf === "admin";
      const isOwnerOfTask = s.owner === me;
      if (!isAdmin && !isOwnerOfTask) return domain(ctx, cmd.task_id, "close", "not_owner", "only the task owner or a workspace Owner/Admin may close");
      if (ctx.claimRequiresGrant(cmd.task_id) && !isAdmin) {
        if (!ctx.validCloseGrant(cmd.task_id, cmd.grant_id, { version: s.version, epoch: s.submission.epoch, head_sha: s.submission.head_sha })) {
          return domain(ctx, cmd.task_id, "close", "close_needs_grant", "this claim requires a close grant bound to the current frozen submission (version+epoch+head SHA)");
        }
      }
      return accept([env(ctx, "TaskClosed", { task_id: cmd.task_id, epoch: s.submission.epoch, disposition: cmd.disposition, grant_id: cmd.grant_id })]);
    }
    case "reopen": {
      if (s.lifecycle === "open" || s.lifecycle === "reopened") return domain(ctx, cmd.task_id, "reopen", "bad_state", "task is already open/reopened");
      const roleOf = ctx.role(me);
      const isAdmin = roleOf === "owner" || roleOf === "admin";
      const isOwnerOfTask = s.owner === me;
      if (!isAdmin && !isOwnerOfTask) return domain(ctx, cmd.task_id, "reopen", "not_owner", "reopen requires a workspace Owner/Admin or the task owner");
      if (!isAdmin && cmd.epoch !== s.epoch) return domain(ctx, cmd.task_id, "reopen", "stale_epoch", `presented epoch ${cmd.epoch} != current ${s.epoch}`);
      return accept([env(ctx, "TaskReopened", { task_id: cmd.task_id, version: s.version + 1 })]);
    }
  }
}

// src/protocol/idempotency.ts
import { createHash } from "node:crypto";
function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}
function sortValue(v) {
  if (Array.isArray(v)) return v.map(sortValue);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) {
      out[k] = sortValue(v[k]);
    }
    return out;
  }
  return v;
}
function idempotencyPrincipal(actor) {
  if (actor.agent_principal !== null) return `agent:${actor.agent_principal}`;
  if (actor.user !== null) return `user:${actor.user}`;
  throw new Error("actor has neither agent_principal nor user");
}
function requestHash(actor, cmd) {
  const principal = idempotencyPrincipal(actor);
  return createHash("sha256").update(canonicalJson({ principal, cmd })).digest("hex");
}
function idemKey(actor, command_id) {
  return `${idempotencyPrincipal(actor)}\0${command_id}`;
}
function toStored(decision) {
  if (decision.ok) {
    return { ok: true, event_ids: decision.events.map((e) => e.event_id) };
  }
  return {
    ok: false,
    reason: decision.reason,
    detail: decision.detail,
    class: decision.class,
    event_ids: decision.events.map((e) => e.event_id)
  };
}
function applyCommand(ledger, state, cmd, ctx) {
  const key2 = idemKey(ctx.actor, ctx.command_id);
  const hash = requestHash(ctx.actor, cmd);
  const existing = ledger.get(key2);
  if (existing) {
    if (existing.hash === hash) return { status: "replayed", response: existing.response };
    return { status: "conflict", detail: "command_id reused with a different request (409)" };
  }
  const decision = decide(state, cmd, ctx);
  const response = toStored(decision);
  if (decision.ok || decision.class === "domain") {
    ledger.set(key2, { hash, response });
  }
  return { status: "fresh", decision, response, events: decision.events };
}

// src/protocol/upcasters.ts
var registry = /* @__PURE__ */ new Map();
function key(type, fromVersion) {
  return `${type}:${fromVersion}`;
}
function registerUpcaster(type, fromVersion, fn) {
  registry.set(key(type, fromVersion), fn);
}
var UpcastError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "UpcastError";
  }
};
function upcastPayload(type, fromVersion, payload) {
  let v = fromVersion;
  let p = payload;
  if (v > SCHEMA_VERSION) {
    throw new UpcastError(`event "${type}" is schema v${v}, newer than supported v${SCHEMA_VERSION}; halting`);
  }
  while (v < SCHEMA_VERSION) {
    const fn = registry.get(key(type, v));
    if (!fn) throw new UpcastError(`no upcaster for "${type}" v${v}\u2192v${v + 1}`);
    p = fn(p);
    v += 1;
  }
  return { payload: p, schema_version: SCHEMA_VERSION };
}
function upcastEnvelope(raw) {
  const { payload, schema_version } = upcastPayload(raw.type, raw.schema_version, raw.payload);
  return { ...raw, payload, schema_version };
}
registerUpcaster("TaskCreated", 0, (p) => ({ task_id: p.id, slug: p.name }));

// src/protocol/workspace-events.ts
var WORKSPACE_ROLES = ["owner", "admin", "member"];
var AGENT_TRANSPORTS = ["local", "hosted_mcp"];
var WORKSPACE_EVENT_TYPES = [
  "WorkspaceCreated",
  "WorkspaceArchived",
  "MemberInvited",
  "InvitationRevoked",
  "InvitationAccepted",
  "MemberJoined",
  "MemberRemoved",
  "MemberRoleChanged",
  "AgentPrincipalCreated",
  "AgentPrincipalRevoked",
  "AgentModelDeclared",
  "FeedbackSubmitted",
  "AgentTokenMinted",
  "AgentTokenRevoked",
  "HostedMcpGrantBegun",
  "HostedMcpWorkspaceConsented",
  "HostedMcpGrantActivated",
  "HostedMcpGrantRevoked",
  "HostedMcpSeatClaimed",
  "HostedMcpSeatRevoked",
  "CommandRejected"
];

// src/protocol/workspace-reducer.ts
function req2(payload, keys, type, seq) {
  if (!payload || typeof payload !== "object") {
    throw new StreamIntegrityError(`event "${type}" at seq ${seq} has a non-object payload`);
  }
  for (const key2 of keys) {
    if (payload[key2] === void 0) {
      throw new StreamIntegrityError(
        `event "${type}" at seq ${seq} is missing payload field "${String(key2)}"`
      );
    }
  }
  return payload;
}
function ownerDelta(from, to) {
  return (to === "owner" ? 1 : 0) - (from === "owner" ? 1 : 0);
}
function assertRole(value, field, type, seq) {
  if (!WORKSPACE_ROLES.includes(value)) {
    throw new StreamIntegrityError(
      `event "${type}" at seq ${seq} has invalid ${field} "${String(value)}"`
    );
  }
}
function assertOwnerCount(state, env3) {
  const actual = Object.values(state.members).filter(
    (member) => member.revoked_at === null && member.role === "owner"
  ).length;
  if (state.owners_count !== actual || actual < 1) {
    throw new StreamIntegrityError(
      `event "${env3.type}" at seq ${env3.seq} violates owner count invariant (projected ${state.owners_count}, actual ${actual})`
    );
  }
}
function reduceWorkspace(prev, env3) {
  if (!WORKSPACE_EVENT_TYPES.includes(env3.type)) {
    throw new UnknownEventTypeError(env3.type, env3.seq);
  }
  if (env3.schema_version !== SCHEMA_VERSION) {
    throw new StreamIntegrityError(
      `event "${env3.type}" at seq ${env3.seq} is schema v${env3.schema_version}, expected v${SCHEMA_VERSION} (upcast before reduce)`
    );
  }
  if (env3.type === "CommandRejected") {
    req2(
      env3.payload,
      ["workspace_id", "command", "reason", "detail"],
      env3.type,
      env3.seq
    );
    if (!prev) {
      throw new StreamIntegrityError(`CommandRejected before WorkspaceCreated (seq ${env3.seq})`);
    }
    return prev;
  }
  if (env3.type === "WorkspaceCreated") {
    if (prev) {
      throw new StreamIntegrityError(`WorkspaceCreated for an existing workspace (seq ${env3.seq})`);
    }
    const p = req2(
      env3.payload,
      ["workspace_id", "name", "created_by", "created_at"],
      env3.type,
      env3.seq
    );
    return {
      workspace: {
        workspace_id: p.workspace_id,
        name: p.name,
        created_by: p.created_by,
        created_at: p.created_at,
        archived_at: null
      },
      members: {
        [p.created_by]: {
          user_id: p.created_by,
          role: "owner",
          invited_by: null,
          joined_at: p.created_at,
          revoked_at: null
        }
      },
      invitations: {},
      principals: {},
      tokens: {},
      owners_count: 1
    };
  }
  if (!prev) {
    throw new StreamIntegrityError(`event "${env3.type}" before WorkspaceCreated (seq ${env3.seq})`);
  }
  const s = prev;
  let next;
  switch (env3.type) {
    case "WorkspaceArchived": {
      const p = req2(env3.payload, ["archived_at"], env3.type, env3.seq);
      if (s.workspace.archived_at !== null) {
        throw new StreamIntegrityError(`workspace archived twice at seq ${env3.seq}`);
      }
      next = {
        ...s,
        workspace: { ...s.workspace, archived_at: p.archived_at }
      };
      break;
    }
    case "MemberInvited": {
      const p = req2(
        env3.payload,
        [
          "invitation_id",
          "email",
          "role",
          "token_hash",
          "expires_at",
          "created_by",
          "created_at"
        ],
        env3.type,
        env3.seq
      );
      if (s.invitations[p.invitation_id]) {
        throw new StreamIntegrityError(`duplicate invitation "${p.invitation_id}" at seq ${env3.seq}`);
      }
      if (Object.values(s.invitations).some(
        (invitation) => invitation.token_hash === p.token_hash
      )) {
        throw new StreamIntegrityError(`duplicate invitation token_hash at seq ${env3.seq}`);
      }
      assertRole(p.role, "role", env3.type, env3.seq);
      next = {
        ...s,
        invitations: {
          ...s.invitations,
          [p.invitation_id]: {
            ...p,
            consumed_at: null,
            consumed_by: null,
            revoked_at: null
          }
        }
      };
      break;
    }
    case "InvitationRevoked": {
      const p = req2(env3.payload, ["invitation_id", "revoked_at"], env3.type, env3.seq);
      const invitation = s.invitations[p.invitation_id];
      if (!invitation) {
        throw new StreamIntegrityError(`unknown invitation "${p.invitation_id}" at seq ${env3.seq}`);
      }
      next = {
        ...s,
        invitations: {
          ...s.invitations,
          [p.invitation_id]: { ...invitation, revoked_at: p.revoked_at }
        }
      };
      break;
    }
    case "InvitationAccepted": {
      const p = req2(
        env3.payload,
        ["invitation_id", "consumed_by", "consumed_at"],
        env3.type,
        env3.seq
      );
      const invitation = s.invitations[p.invitation_id];
      if (!invitation) {
        throw new StreamIntegrityError(`unknown invitation "${p.invitation_id}" at seq ${env3.seq}`);
      }
      next = {
        ...s,
        invitations: {
          ...s.invitations,
          [p.invitation_id]: {
            ...invitation,
            consumed_at: p.consumed_at,
            consumed_by: p.consumed_by
          }
        }
      };
      break;
    }
    case "MemberJoined": {
      const p = req2(
        env3.payload,
        ["user_id", "role", "invited_by", "joined_at"],
        env3.type,
        env3.seq
      );
      const existing = s.members[p.user_id];
      assertRole(p.role, "role", env3.type, env3.seq);
      if (existing?.revoked_at === null) {
        throw new StreamIntegrityError(`live member "${p.user_id}" joined twice at seq ${env3.seq}`);
      }
      next = {
        ...s,
        members: {
          ...s.members,
          [p.user_id]: { ...p, revoked_at: null }
        },
        owners_count: s.owners_count + ownerDelta(null, p.role)
      };
      break;
    }
    case "MemberRemoved": {
      const p = req2(env3.payload, ["user_id", "revoked_at"], env3.type, env3.seq);
      const member = s.members[p.user_id];
      if (!member || member.revoked_at !== null) {
        throw new StreamIntegrityError(`cannot remove non-live member "${p.user_id}" at seq ${env3.seq}`);
      }
      next = {
        ...s,
        members: {
          ...s.members,
          [p.user_id]: { ...member, revoked_at: p.revoked_at }
        },
        owners_count: s.owners_count + ownerDelta(member.role, null)
      };
      break;
    }
    case "MemberRoleChanged": {
      const p = req2(
        env3.payload,
        ["user_id", "from_role", "to_role"],
        env3.type,
        env3.seq
      );
      const member = s.members[p.user_id];
      assertRole(p.from_role, "from_role", env3.type, env3.seq);
      assertRole(p.to_role, "to_role", env3.type, env3.seq);
      if (!member || member.revoked_at !== null || member.role !== p.from_role) {
        throw new StreamIntegrityError(`role change has stale member state at seq ${env3.seq}`);
      }
      next = {
        ...s,
        members: {
          ...s.members,
          [p.user_id]: { ...member, role: p.to_role }
        },
        owners_count: s.owners_count + ownerDelta(p.from_role, p.to_role)
      };
      break;
    }
    case "AgentPrincipalCreated": {
      const p = req2(
        env3.payload,
        ["principal_id", "owner_user_id", "name", "created_at"],
        env3.type,
        env3.seq
      );
      if (s.principals[p.principal_id]) {
        throw new StreamIntegrityError(`duplicate principal "${p.principal_id}" at seq ${env3.seq}`);
      }
      const transport = p.transport ?? "local";
      const turnOnly = p.turn_only ?? false;
      if (!AGENT_TRANSPORTS.includes(transport)) {
        throw new StreamIntegrityError(
          `event "${env3.type}" at seq ${env3.seq} has invalid transport "${String(transport)}"`
        );
      }
      if (typeof turnOnly !== "boolean") {
        throw new StreamIntegrityError(
          `event "${env3.type}" at seq ${env3.seq} has non-boolean turn_only`
        );
      }
      if (transport === "hosted_mcp" && !turnOnly) {
        throw new StreamIntegrityError(
          `event "${env3.type}" at seq ${env3.seq} gives hosted_mcp a non-turn-only transport`
        );
      }
      next = {
        ...s,
        principals: {
          ...s.principals,
          [p.principal_id]: {
            ...p,
            model: p.model ?? null,
            transport,
            turn_only: turnOnly,
            revoked_at: null
          }
        }
      };
      break;
    }
    case "FeedbackSubmitted": {
      req2(
        env3.payload,
        ["feedback_id", "category", "body", "reporter_kind", "reporter_id", "submitted_at"],
        env3.type,
        env3.seq
      );
      next = s;
      break;
    }
    case "AgentModelDeclared": {
      const p = req2(
        env3.payload,
        ["principal_id", "declared_at"],
        env3.type,
        env3.seq
      );
      const declaredFor = s.principals[p.principal_id];
      if (!declaredFor) {
        throw new StreamIntegrityError(`unknown principal "${p.principal_id}" at seq ${env3.seq}`);
      }
      next = {
        ...s,
        principals: {
          ...s.principals,
          [p.principal_id]: { ...declaredFor, model: p.model ?? null }
        }
      };
      break;
    }
    case "AgentPrincipalRevoked": {
      const p = req2(
        env3.payload,
        ["principal_id", "revoked_at"],
        env3.type,
        env3.seq
      );
      const principal = s.principals[p.principal_id];
      if (!principal) {
        throw new StreamIntegrityError(`unknown principal "${p.principal_id}" at seq ${env3.seq}`);
      }
      next = {
        ...s,
        principals: {
          ...s.principals,
          [p.principal_id]: { ...principal, revoked_at: p.revoked_at }
        }
      };
      break;
    }
    case "AgentTokenMinted": {
      const p = req2(
        env3.payload,
        [
          "token_id",
          "principal_id",
          "run_id",
          "task_id",
          "epoch",
          "scopes",
          "issued_at",
          "expires_at"
        ],
        env3.type,
        env3.seq
      );
      if (s.tokens[p.token_id]) {
        throw new StreamIntegrityError(`duplicate token "${p.token_id}" at seq ${env3.seq}`);
      }
      next = {
        ...s,
        tokens: {
          ...s.tokens,
          [p.token_id]: { ...p, scopes: [...p.scopes], revoked_at: null }
        }
      };
      break;
    }
    case "AgentTokenRevoked": {
      const p = req2(env3.payload, ["token_id", "revoked_at"], env3.type, env3.seq);
      const token = s.tokens[p.token_id];
      if (!token) {
        throw new StreamIntegrityError(`unknown token "${p.token_id}" at seq ${env3.seq}`);
      }
      next = {
        ...s,
        tokens: {
          ...s.tokens,
          [p.token_id]: { ...token, revoked_at: p.revoked_at }
        }
      };
      break;
    }
    case "HostedMcpSeatClaimed": {
      const p = req2(
        env3.payload,
        [
          "seat_id",
          "grant_id",
          "workspace_id",
          "owner_user_id",
          "principal_id",
          "name",
          "handle",
          "transport",
          "turn_only",
          "created_at"
        ],
        env3.type,
        env3.seq
      );
      if (p.workspace_id !== s.workspace.workspace_id) {
        throw new StreamIntegrityError(`hosted seat workspace mismatch at seq ${env3.seq}`);
      }
      if (s.principals[p.principal_id]) {
        throw new StreamIntegrityError(`duplicate principal "${p.principal_id}" at seq ${env3.seq}`);
      }
      if (p.transport !== "hosted_mcp" || p.turn_only !== true) {
        throw new StreamIntegrityError(`hosted seat has invalid transport at seq ${env3.seq}`);
      }
      next = {
        ...s,
        principals: {
          ...s.principals,
          [p.principal_id]: {
            principal_id: p.principal_id,
            owner_user_id: p.owner_user_id,
            name: p.name,
            model: null,
            transport: "hosted_mcp",
            turn_only: true,
            created_at: p.created_at,
            revoked_at: null
          }
        }
      };
      break;
    }
    case "HostedMcpSeatRevoked": {
      const p = req2(
        env3.payload,
        ["seat_id", "principal_id", "revoked_at"],
        env3.type,
        env3.seq
      );
      const principal = s.principals[p.principal_id];
      if (!principal) {
        throw new StreamIntegrityError(`unknown hosted principal "${p.principal_id}" at seq ${env3.seq}`);
      }
      next = {
        ...s,
        principals: {
          ...s.principals,
          [p.principal_id]: { ...principal, revoked_at: p.revoked_at }
        }
      };
      break;
    }
    case "HostedMcpGrantBegun":
    case "HostedMcpWorkspaceConsented":
    case "HostedMcpGrantActivated":
    case "HostedMcpGrantRevoked":
      next = s;
      break;
    default:
      throw new UnknownEventTypeError(env3.type, env3.seq);
  }
  assertOwnerCount(next, env3);
  return next;
}
function reduceWorkspaceStream(events) {
  let state = null;
  let lastSeq = -Infinity;
  for (const event2 of events) {
    if (event2.seq <= lastSeq) {
      throw new StreamIntegrityError(
        `events out of order or duplicated: seq ${event2.seq} after ${lastSeq}`
      );
    }
    lastSeq = event2.seq;
    state = reduceWorkspace(state, event2);
  }
  return state;
}

// src/protocol/workspace-commands.ts
var INVITATION_MAX_TTL_MS = 7 * 24 * 60 * 60 * 1e3;
var AGENT_TOKEN_DEFAULT_TTL_MS = 60 * 60 * 1e3;
var PRINCIPAL_NAME_TAKEN = {
  code: "principal_name_taken",
  message: "principal id or name already exists"
};
var AGENT_TOKEN_MAX_TTL_MS = 30 * 24 * 60 * 60 * 1e3;
var H0_SEAT_TOKEN_TTL_MS = AGENT_TOKEN_MAX_TTL_MS;
var RENEWAL_HORIZON_DEFAULT_MS = 30 * 24 * 60 * 60 * 1e3;
var RENEWAL_HORIZON_MAX_MS = 90 * 24 * 60 * 60 * 1e3;
var RENEWAL_MAX_SUCCESSORS_DEFAULT = 800;
var RENEWAL_IDLE_PAUSE_DAYS = 14;
var HUMAN_ONLY_COMMANDS = /* @__PURE__ */ new Set([
  "create_workspace",
  "archive_workspace",
  "invite_member",
  "revoke_invitation",
  "accept_invitation",
  "remove_member",
  "change_role",
  "create_agent_principal",
  "revoke_agent_principal",
  "set_agent_model",
  "mint_agent_token",
  "mint_agent_join_credential",
  "revoke_agent_join_credential",
  "enable_agent_management",
  "disable_agent_management",
  "recover_agent_session"
]);
function isAgentScopeDenylisted(scope) {
  const words = scopeWords(scope);
  const has = (...values) => values.some((value) => words.has(value));
  const mutates = has(
    "accept",
    "add",
    "archive",
    "assign",
    "author",
    "change",
    "create",
    "delete",
    "demote",
    "invalidate",
    "issue",
    "map",
    "mint",
    "promote",
    "remove",
    "remap",
    "revoke",
    "set",
    "transfer",
    "update",
    "write"
  );
  if (words.has("grant") && has("create", "issuance", "issue", "mint", "revoke")) return true;
  if (has("credential", "token", "worker") && has("create", "issuance", "issue", "mint", "renew")) return true;
  if (has("invite", "invitation")) return true;
  if (has("membership", "member", "role", "owner", "ownership") && mutates) return true;
  if (has("repo", "repository") && has("archive", "map", "remap")) return true;
  if (words.has("workspace") && has("archive", "create", "delete")) return true;
  if (words.has("capability") && words.has("url") && has("create", "issue", "mint")) return true;
  if (words.has("discard")) return true;
  if (has("invalidate", "revoke") && has(
    "credential",
    "device",
    "family",
    "lineage",
    "membership",
    "principal",
    "refresh",
    "run",
    "token"
  )) return true;
  if (mutates && has("knowledge", "playbook")) return true;
  if (mutates && words.has("instruction") && has("foundational", "trusted")) return true;
  if (mutates && words.has("schema") && has("acceptance", "trusted")) return true;
  return false;
}
function scopeWords(scope) {
  return new Set(
    scope.trim().toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map((word) => {
      if (word.length > 3 && word.endsWith("ies")) {
        return `${word.slice(0, -3)}y`;
      }
      if (word.length > 1 && word.endsWith("s") && !word.endsWith("ss")) {
        return word.slice(0, -1);
      }
      return word;
    })
  );
}
function env2(ctx, type, payload) {
  return {
    workspace_id: ctx.workspace_id,
    stream_id: ctx.stream_id,
    seq: ctx.nextSeq(),
    event_id: ctx.nextEventId(),
    command_id: ctx.command_id,
    type,
    schema_version: SCHEMA_VERSION,
    actor_user: ctx.actor.user,
    actor_agent_principal: ctx.actor.agent_principal,
    actor_run: ctx.actor.run,
    occurred_at_server: ctx.now,
    payload
  };
}
function accept2(events) {
  return { ok: true, events };
}
function authz2(reason, detail) {
  return { ok: false, class: "authz", reason, detail, events: [] };
}
function domain2(ctx, command, reason, detail) {
  return {
    ok: false,
    class: "domain",
    reason,
    detail,
    events: [
      env2(ctx, "CommandRejected", {
        workspace_id: ctx.workspace_id,
        command,
        reason,
        detail
      })
    ]
  };
}
function liveMember(state, user_id) {
  const member = state.members[user_id];
  return member?.revoked_at === null ? member : null;
}
function callerUser(ctx) {
  return ctx.actor.user;
}
function normalizedModel(value) {
  if (value === null) return { ok: true, model: null };
  if (typeof value !== "string") {
    return { ok: false, message: "model must be a string or null" };
  }
  const trimmed = value.trim();
  if (trimmed.length > 120) {
    return { ok: false, message: "model must be at most 120 characters" };
  }
  if (/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(trimmed)) {
    return { ok: false, message: "model must not contain control characters" };
  }
  return { ok: true, model: trimmed.length === 0 ? null : trimmed };
}
var FEEDBACK_CATEGORIES = ["bug", "idea", "friction"];
var FEEDBACK_BODY_MAX = 4e3;
var FEEDBACK_CONTEXT_MAX_BYTES = 2048;
function normalizedFeedbackBody(value) {
  if (typeof value !== "string") {
    return { ok: false, message: "feedback body must be a string" };
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { ok: false, message: "feedback body must not be empty" };
  }
  if (trimmed.length > FEEDBACK_BODY_MAX) {
    return { ok: false, message: `feedback body must be at most ${FEEDBACK_BODY_MAX} characters` };
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(trimmed)) {
    return { ok: false, message: "feedback body must not contain control characters (newlines and tabs are fine)" };
  }
  return { ok: true, body: trimmed };
}
function normalizedFeedbackContext(value) {
  if (value === null || value === void 0) return { ok: true, context: null };
  if (typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, message: "feedback context must be a flat object of strings" };
  }
  const entries = Object.entries(value);
  for (const [key2, entry] of entries) {
    if (typeof entry !== "string" || key2.length === 0 || key2.length > 64 || entry.length > 512) {
      return { ok: false, message: "feedback context must be a flat object of bounded strings" };
    }
    if (/[\u0000-\u001f\u007f-\u009f]/.test(key2 + entry)) {
      return { ok: false, message: "feedback context must not contain control characters" };
    }
  }
  if (entries.length === 0) return { ok: true, context: null };
  const serialized = JSON.stringify(Object.fromEntries(entries));
  if (new TextEncoder().encode(serialized).length > FEEDBACK_CONTEXT_MAX_BYTES) {
    return { ok: false, message: `feedback context must serialize to at most ${FEEDBACK_CONTEXT_MAX_BYTES} bytes` };
  }
  return { ok: true, context: Object.fromEntries(entries) };
}
function ownerOrAdmin(role) {
  return role === "owner" || role === "admin";
}
function decideWorkspace(state, cmd, ctx) {
  const user_id = callerUser(ctx);
  if (!user_id) {
    return authz2("bad_state", "credential has no server-derived human owner");
  }
  if (ctx.credential_kind === "join" && cmd.kind !== "register_agent_seat" || cmd.kind === "register_agent_seat" && ctx.credential_kind !== "join") {
    return authz2(
      "credential_kind_forbidden",
      "register_agent_seat requires the resolved join credential and that credential authorizes no other command"
    );
  }
  if (ctx.credential_kind === "hosted_grant") {
    return authz2("credential_kind_forbidden", "hosted grant credentials authorize only claim_hosted_seat");
  }
  if (ctx.credential_kind === "hosted_seat" && cmd.kind !== "submit_feedback") {
    return authz2("credential_kind_forbidden", "hosted seat credential cannot execute workspace management commands");
  }
  if (HUMAN_ONLY_COMMANDS.has(cmd.kind) && ctx.credential_kind !== "human") {
    return authz2("credential_kind_forbidden", "command requires an interactive human credential");
  }
  if (cmd.kind === "create_workspace") {
    if (state) {
      if (ctx.role(user_id) === null) {
        return authz2("bad_state", "caller is not a current workspace member");
      }
      return domain2(ctx, cmd.kind, "workspace_exists", "workspace already exists");
    }
    if (!ctx.operatorAllowed(ctx.actor)) {
      return authz2("operator_not_allowed", "caller is not allowed to create a workspace");
    }
    if (cmd.workspace_id !== ctx.workspace_id) {
      return authz2("bad_state", "command does not match the resolved workspace");
    }
    return accept2([
      env2(ctx, "WorkspaceCreated", {
        workspace_id: cmd.workspace_id,
        name: cmd.name,
        created_by: user_id,
        created_at: ctx.now
      })
    ]);
  }
  if (!state) {
    return authz2("workspace_not_found", "workspace is unavailable");
  }
  if (cmd.kind === "register_agent_seat") {
    if (ctx.role(user_id) === null) {
      return authz2("bad_state", "credential owner is not a current workspace member");
    }
    if (state.principals[cmd.principal_id] || state.tokens[cmd.token_id]) {
      return domain2(
        ctx,
        cmd.kind,
        "bad_state",
        "server-generated registration identity already exists"
      );
    }
    if (!cmd.run_id || !cmd.attempt_id || !Number.isFinite(cmd.ttl_ms) || cmd.ttl_ms <= 0 || cmd.ttl_ms > AGENT_TOKEN_MAX_TTL_MS) {
      return domain2(
        ctx,
        cmd.kind,
        "binding_required",
        "registration requires server-derived attempt, run, and bounded token lifetime"
      );
    }
    if (cmd.scopes.length === 0 || cmd.scopes.some((scope) => scopeWords(scope).size === 0) || cmd.scopes.some(isAgentScopeDenylisted)) {
      return domain2(
        ctx,
        cmd.kind,
        "scope_not_allowed",
        "registration scopes must be concrete agent scopes"
      );
    }
    const humanRights = new Set(ctx.humanRights(ctx.actor));
    if (cmd.scopes.some((scope) => !humanRights.has(scope))) {
      return domain2(
        ctx,
        cmd.kind,
        "scope_not_allowed",
        "registration scopes exceed the credential owner rights"
      );
    }
    return accept2([
      env2(ctx, "AgentPrincipalCreated", {
        principal_id: cmd.principal_id,
        owner_user_id: user_id,
        name: cmd.name,
        model: null,
        transport: "local",
        turn_only: false,
        created_at: ctx.now
      }),
      env2(ctx, "AgentTokenMinted", {
        token_id: cmd.token_id,
        principal_id: cmd.principal_id,
        run_id: cmd.run_id,
        task_id: cmd.attempt_id,
        epoch: 0,
        scopes: [...cmd.scopes],
        issued_at: ctx.now,
        expires_at: ctx.now + cmd.ttl_ms
      })
    ]);
  }
  if (cmd.kind === "accept_invitation") {
    if (!ctx.identityVerified(user_id)) {
      return authz2("identity_not_verified", "verified identity is required");
    }
    const matches = Object.values(state.invitations).filter(
      (invitation2) => invitation2.token_hash === cmd.token_hash
    );
    if (matches.length !== 1) {
      return authz2("invitation_token_mismatch", "invitation capability is invalid");
    }
    const invitation = matches[0];
    if (invitation.consumed_at !== null || invitation.revoked_at !== null || invitation.expires_at <= ctx.now) {
      return domain2(ctx, cmd.kind, "invitation_not_live", "invitation is consumed, revoked, or expired");
    }
    if (liveMember(state, user_id)) {
      return domain2(ctx, cmd.kind, "member_exists", "invitee is already a current member");
    }
    return accept2([
      env2(ctx, "InvitationAccepted", {
        invitation_id: invitation.invitation_id,
        consumed_by: user_id,
        consumed_at: ctx.now
      }),
      env2(ctx, "MemberJoined", {
        user_id,
        role: invitation.role,
        invited_by: invitation.created_by,
        joined_at: ctx.now
      })
    ]);
  }
  const actorRole = ctx.role(user_id);
  if (actorRole === null) {
    return authz2("bad_state", "caller is not a current workspace member");
  }
  switch (cmd.kind) {
    case "archive_workspace": {
      if (actorRole !== "owner") {
        return domain2(
          ctx,
          cmd.kind,
          "not_workspace_owner",
          "closing a workspace requires the Owner role"
        );
      }
      if (state.workspace.archived_at !== null) {
        return domain2(
          ctx,
          cmd.kind,
          "workspace_already_archived",
          "workspace is already closed"
        );
      }
      return accept2([
        env2(ctx, "WorkspaceArchived", { archived_at: ctx.now })
      ]);
    }
    case "invite_member": {
      if (!ownerOrAdmin(actorRole)) {
        return domain2(ctx, cmd.kind, "role_forbidden", "inviting members requires Owner/Admin");
      }
      if (cmd.role === "owner" && actorRole !== "owner") {
        return domain2(ctx, cmd.kind, "role_forbidden", "only an Owner may invite another Owner");
      }
      if (!Number.isFinite(cmd.expires_at) || cmd.expires_at <= ctx.now || cmd.expires_at - ctx.now > INVITATION_MAX_TTL_MS) {
        return domain2(ctx, cmd.kind, "invitation_ttl_invalid", "invitation TTL must be positive and at most 7 days");
      }
      if (ctx.inviteeAlreadyMember(cmd.email)) {
        return domain2(ctx, cmd.kind, "member_exists", "invitee is already a current member");
      }
      if (state.invitations[cmd.invitation_id] || Object.values(state.invitations).some(
        (invitation) => invitation.token_hash === cmd.token_hash
      )) {
        return domain2(ctx, cmd.kind, "bad_state", "invitation id or token hash already exists");
      }
      return accept2([
        env2(ctx, "MemberInvited", {
          invitation_id: cmd.invitation_id,
          email: cmd.email,
          role: cmd.role,
          token_hash: cmd.token_hash,
          expires_at: cmd.expires_at,
          created_by: user_id,
          created_at: ctx.now
        })
      ]);
    }
    case "revoke_invitation": {
      if (!ownerOrAdmin(actorRole)) {
        return domain2(ctx, cmd.kind, "role_forbidden", "revoking invitations requires Owner/Admin");
      }
      const invitation = state.invitations[cmd.invitation_id];
      if (!invitation) {
        return domain2(ctx, cmd.kind, "invitation_not_found", "invitation does not exist");
      }
      if (invitation.consumed_at !== null || invitation.revoked_at !== null || invitation.expires_at <= ctx.now) {
        return domain2(ctx, cmd.kind, "invitation_not_live", "invitation is not live");
      }
      return accept2([
        env2(ctx, "InvitationRevoked", {
          invitation_id: cmd.invitation_id,
          revoked_at: ctx.now
        })
      ]);
    }
    case "remove_member": {
      if (!ownerOrAdmin(actorRole)) {
        return domain2(ctx, cmd.kind, "role_forbidden", "removing members requires Owner/Admin");
      }
      const target = liveMember(state, cmd.user_id);
      if (!target) {
        return domain2(ctx, cmd.kind, "member_not_found", "target is not a current member");
      }
      if (actorRole === "admin" && target.role === "owner") {
        return domain2(ctx, cmd.kind, "role_forbidden", "Admin cannot remove an Owner");
      }
      if (target.role === "owner" && state.owners_count <= 1) {
        return domain2(ctx, cmd.kind, "last_owner", "last Owner cannot be removed");
      }
      if (!ctx.landingAuthorityChangeResolved(
        cmd.user_id,
        cmd.landing_authority_successor_user_id ?? null
      )) {
        return domain2(
          ctx,
          cmd.kind,
          "landing_authority_unresolved",
          "landing authority must be transferred to a live successor first"
        );
      }
      return accept2([
        env2(ctx, "MemberRemoved", { user_id: cmd.user_id, revoked_at: ctx.now })
      ]);
    }
    case "change_role": {
      if (!ownerOrAdmin(actorRole)) {
        return domain2(ctx, cmd.kind, "role_forbidden", "changing roles requires Owner/Admin");
      }
      const target = liveMember(state, cmd.user_id);
      if (!target) {
        return domain2(ctx, cmd.kind, "member_not_found", "target is not a current member");
      }
      if (target.role === cmd.role) {
        return domain2(ctx, cmd.kind, "bad_state", "member already has that role");
      }
      if (actorRole === "admin" && (target.role === "owner" || cmd.role === "owner")) {
        return domain2(ctx, cmd.kind, "role_forbidden", "Admin cannot add, remove, or change an Owner");
      }
      if (target.role === "owner" && cmd.role !== "owner" && state.owners_count <= 1) {
        return domain2(ctx, cmd.kind, "last_owner", "last Owner cannot be demoted");
      }
      if (!ctx.landingAuthorityChangeResolved(
        cmd.user_id,
        cmd.landing_authority_successor_user_id ?? null
      )) {
        return domain2(
          ctx,
          cmd.kind,
          "landing_authority_unresolved",
          "landing authority must be transferred to a live successor first"
        );
      }
      return accept2([
        env2(ctx, "MemberRoleChanged", {
          user_id: cmd.user_id,
          from_role: target.role,
          to_role: cmd.role
        })
      ]);
    }
    case "create_agent_principal": {
      if (state.principals[cmd.principal_id] || !cmd.allow_duplicate_name && Object.values(state.principals).some((principal) => principal.name === cmd.name)) {
        return domain2(ctx, cmd.kind, PRINCIPAL_NAME_TAKEN.code, PRINCIPAL_NAME_TAKEN.message);
      }
      return accept2([
        env2(ctx, "AgentPrincipalCreated", {
          principal_id: cmd.principal_id,
          owner_user_id: user_id,
          name: cmd.name,
          model: cmd.model ?? null,
          transport: "local",
          turn_only: false,
          created_at: ctx.now
        })
      ]);
    }
    case "revoke_agent_principal": {
      const principal = state.principals[cmd.principal_id];
      if (!principal) {
        return domain2(ctx, cmd.kind, "principal_not_found", "agent principal does not exist");
      }
      if (principal.revoked_at !== null) {
        return domain2(ctx, cmd.kind, "principal_revoked", "agent principal is already revoked");
      }
      if (!ownerOrAdmin(actorRole) && principal.owner_user_id !== user_id) {
        return domain2(ctx, cmd.kind, "principal_not_owned", "Member may revoke only their own principal");
      }
      return accept2([
        env2(ctx, "AgentPrincipalRevoked", {
          principal_id: cmd.principal_id,
          revoked_at: ctx.now
        })
      ]);
    }
    case "submit_feedback": {
      if (!FEEDBACK_CATEGORIES.includes(cmd.category)) {
        return domain2(ctx, cmd.kind, "feedback_invalid", "category must be bug, idea, or friction");
      }
      const body = normalizedFeedbackBody(cmd.body);
      if (!body.ok) {
        return domain2(ctx, cmd.kind, "feedback_invalid", body.message);
      }
      const context = normalizedFeedbackContext(cmd.context);
      if (!context.ok) {
        return domain2(ctx, cmd.kind, "feedback_invalid", context.message);
      }
      let reporter_kind;
      let reporter_id;
      if (ctx.credential_kind === "agent") {
        if (ctx.actor.agent_principal === null) {
          return authz2("principal_not_presented", "agent feedback requires the presenting principal to be resolved");
        }
        const reporting = state.principals[ctx.actor.agent_principal];
        if (!reporting || reporting.revoked_at !== null) {
          return domain2(ctx, cmd.kind, "principal_revoked", "the presenting principal is missing or revoked");
        }
        reporter_kind = "agent";
        reporter_id = reporting.principal_id;
      } else {
        if (ctx.role(user_id) === null) {
          return authz2("bad_state", "caller is not a current workspace member");
        }
        reporter_kind = "user";
        reporter_id = user_id;
      }
      return accept2([
        env2(ctx, "FeedbackSubmitted", {
          feedback_id: cmd.feedback_id,
          category: cmd.category,
          body: body.body,
          context: context.context,
          reporter_kind,
          reporter_id,
          submitted_at: ctx.now
        })
      ]);
    }
    case "mint_agent_token": {
      const principal = state.principals[cmd.principal_id];
      if (!principal) {
        return domain2(ctx, cmd.kind, "principal_not_found", "agent principal does not exist");
      }
      if (principal.revoked_at !== null) {
        return domain2(ctx, cmd.kind, "principal_revoked", "agent principal is revoked");
      }
      if (principal.transport === "hosted_mcp" || principal.turn_only) {
        return domain2(
          ctx,
          cmd.kind,
          "transport_unavailable",
          "hosted MCP principals cannot receive independently usable credentials"
        );
      }
      if (principal.owner_user_id !== user_id) {
        return domain2(ctx, cmd.kind, "principal_not_owned", "tokens may be minted only for an owned principal");
      }
      if (!cmd.run_id || !cmd.task_id || !Number.isInteger(cmd.epoch) || cmd.epoch < 0) {
        return domain2(ctx, cmd.kind, "binding_required", "run_id, task_id, and a non-negative integer epoch are required");
      }
      const ttl = cmd.ttl_ms ?? AGENT_TOKEN_DEFAULT_TTL_MS;
      if (!Number.isFinite(ttl) || ttl <= 0 || ttl > AGENT_TOKEN_MAX_TTL_MS) {
        return domain2(ctx, cmd.kind, "token_ttl_invalid", "token TTL must be positive and at most 30 days");
      }
      if (state.tokens[cmd.token_id]) {
        return domain2(ctx, cmd.kind, "bad_state", "token id already exists");
      }
      if (cmd.scopes.length === 0 || cmd.scopes.some((scope) => scopeWords(scope).size === 0)) {
        return domain2(ctx, cmd.kind, "scope_not_allowed", "at least one concrete scope is required");
      }
      if (cmd.scopes.some(isAgentScopeDenylisted)) {
        return domain2(ctx, cmd.kind, "scope_denylisted", "one or more scopes are human-credential-only");
      }
      const humanRights = new Set(ctx.humanRights(ctx.actor));
      if (cmd.scopes.some((scope) => !humanRights.has(scope))) {
        return domain2(ctx, cmd.kind, "scope_not_allowed", "requested scopes exceed the human credential rights");
      }
      return accept2([
        env2(ctx, "AgentTokenMinted", {
          token_id: cmd.token_id,
          principal_id: cmd.principal_id,
          run_id: cmd.run_id,
          task_id: cmd.task_id,
          epoch: cmd.epoch,
          scopes: [...cmd.scopes],
          issued_at: ctx.now,
          expires_at: ctx.now + ttl
        })
      ]);
    }
    case "declare_agent_model": {
      if (ctx.credential_kind !== "agent") {
        return authz2(
          "credential_kind_forbidden",
          "model declaration is presented by the agent describing itself; a human sets model at principal creation"
        );
      }
      if (ctx.actor.agent_principal === null) {
        return authz2(
          "principal_not_presented",
          "model declaration requires the presenting agent principal to be resolved"
        );
      }
      const declaring = state.principals[ctx.actor.agent_principal];
      if (!declaring || declaring.revoked_at !== null) {
        return domain2(ctx, cmd.kind, "principal_revoked", "the presenting principal is missing or revoked");
      }
      const normalized = normalizedModel(cmd.model);
      if (!normalized.ok) {
        return domain2(ctx, cmd.kind, "model_invalid", normalized.message);
      }
      return accept2([
        env2(ctx, "AgentModelDeclared", {
          principal_id: declaring.principal_id,
          model: normalized.model,
          declared_at: ctx.now
        })
      ]);
    }
    case "set_agent_model": {
      const principal = state.principals[cmd.principal_id];
      if (!principal) {
        return domain2(ctx, cmd.kind, "principal_not_found", "agent principal does not exist");
      }
      if (principal.revoked_at !== null) {
        return domain2(ctx, cmd.kind, "principal_revoked", "agent principal is revoked");
      }
      if (!ownerOrAdmin(actorRole) && principal.owner_user_id !== user_id) {
        return domain2(ctx, cmd.kind, "principal_not_owned", "Member may set only their own principal's model");
      }
      const normalized = normalizedModel(cmd.model);
      if (!normalized.ok) {
        return domain2(ctx, cmd.kind, "model_invalid", normalized.message);
      }
      return accept2([
        env2(ctx, "AgentModelDeclared", {
          principal_id: principal.principal_id,
          model: normalized.model,
          declared_at: ctx.now
        })
      ]);
    }
    // §2.3 worker-token renewal: a fenced SUCCESSOR operation, never a mint.
    // The successor inherits principal, run, task, epoch and scopes from the
    // predecessor row in state; nothing here is read from the command except
    // the adapter-minted successor id and the scopes it claims to have copied,
    // and those scopes are checked back against the predecessor below.
    case "renew_agent_token": {
      if (ctx.credential_kind !== "agent") {
        return authz2(
          "renewal_requires_agent_credential",
          "renewal is presented by the worker credential being renewed; a human re-authorises by minting"
        );
      }
      if (ctx.presenting_token_id === null || ctx.actor.agent_principal === null) {
        return authz2(
          "predecessor_not_presented",
          "renewal requires the presenting agent token to be resolved"
        );
      }
      const predecessor = state.tokens[ctx.presenting_token_id];
      if (!predecessor) {
        return domain2(
          ctx,
          cmd.kind,
          "predecessor_not_found",
          "presenting token is not a token of this workspace"
        );
      }
      if (!ctx.renewalFacts) {
        return authz2(
          "renewal_unsupported",
          "no renewal oracle is wired; renewal fails closed rather than defaulting"
        );
      }
      if (predecessor.principal_id !== ctx.actor.agent_principal) {
        return authz2(
          "predecessor_not_owned",
          "presenting token does not belong to the acting principal"
        );
      }
      const principal = state.principals[predecessor.principal_id];
      if (!principal || principal.revoked_at !== null) {
        return domain2(
          ctx,
          cmd.kind,
          "principal_revoked",
          "the predecessor principal is missing or revoked"
        );
      }
      if (principal.transport === "hosted_mcp" || principal.turn_only) {
        return domain2(
          ctx,
          cmd.kind,
          "transport_unavailable",
          "hosted MCP principals cannot renew independent credentials"
        );
      }
      if (predecessor.revoked_at !== null) {
        return domain2(ctx, cmd.kind, "predecessor_revoked", "predecessor token is revoked");
      }
      const facts = ctx.renewalFacts(predecessor.token_id);
      if (facts.superseded && !facts.successor_pending) {
        return domain2(
          ctx,
          cmd.kind,
          "predecessor_superseded",
          "predecessor has already issued a successor; use it rather than renewing again"
        );
      }
      if (predecessor.expires_at <= ctx.now) {
        return domain2(ctx, cmd.kind, "predecessor_expired", "predecessor token has expired");
      }
      if (predecessor.task_id === null || predecessor.epoch === null) {
        return domain2(
          ctx,
          cmd.kind,
          "renewal_binding_incomplete",
          "predecessor carries no task/epoch binding for the successor to inherit"
        );
      }
      if (facts.lineage_revoked) {
        return domain2(
          ctx,
          cmd.kind,
          "renewal_lineage_revoked",
          "the renewal lineage carries a revocation"
        );
      }
      if (facts.grant_mismatch) {
        return domain2(
          ctx,
          cmd.kind,
          "renewal_grant_mismatch",
          "the named grant is bound to a different principal or run"
        );
      }
      const grant = facts.grant;
      if (!grant) {
        return domain2(
          ctx,
          cmd.kind,
          "renewal_grant_not_found",
          "no renewal grant was created for this run at join/spawn"
        );
      }
      if (grant.revoked_at !== null) {
        return domain2(ctx, cmd.kind, "renewal_grant_revoked", "renewal grant is revoked");
      }
      if (facts.grant_preflight_code === "renewal_idle_suspended") {
        return domain2(
          ctx,
          cmd.kind,
          "renewal_idle_suspended",
          `standing grant went ${RENEWAL_IDLE_PAUSE_DAYS} days without use and is now paused; it is not revoked, and a workspace owner or admin, or the member who owns this agent, can resume it`
        );
      }
      if (facts.grant_preflight_code === "renewal_grant_suspended" || grant.suspension_active) {
        return domain2(
          ctx,
          cmd.kind,
          "renewal_grant_suspended",
          "renewal grant is paused; it is not revoked, and an owner must resume or revoke it"
        );
      }
      if (facts.grant_preflight_code === "renewal_device_unavailable") {
        return domain2(
          ctx,
          cmd.kind,
          "renewal_device_unavailable",
          "the bound grant cannot verify a device for this renewal"
        );
      }
      if (facts.grant_preflight_code === "renewal_device_mismatch") {
        return domain2(
          ctx,
          cmd.kind,
          "renewal_device_mismatch",
          "the renewal device does not match the grant binding"
        );
      }
      if (grant.kind === "timeboxed" && facts.grant_preflight_code === "renewal_horizon_reached") {
        return domain2(
          ctx,
          cmd.kind,
          "renewal_horizon_reached",
          "the continuous-renewal horizon has passed; a human must reauthorise this run"
        );
      }
      const timeboxedHorizonValid = grant.kind === "timeboxed" && Number.isFinite(grant.horizon_expires_at) && grant.horizon_expires_at !== null && grant.max_successors !== null && grant.horizon_expires_at - ctx.now <= RENEWAL_HORIZON_MAX_MS;
      const standingShapeValid = grant.kind === "standing" && grant.horizon_expires_at === null && grant.max_successors === null;
      if (!timeboxedHorizonValid && !standingShapeValid) {
        return domain2(
          ctx,
          cmd.kind,
          "renewal_horizon_invalid",
          "renewal grant kind, horizon, or successor ceiling is invalid"
        );
      }
      if (grant.kind === "timeboxed" && grant.horizon_expires_at !== null && grant.horizon_expires_at <= ctx.now) {
        return domain2(
          ctx,
          cmd.kind,
          "renewal_horizon_reached",
          "the continuous-renewal horizon has passed; a human must reauthorise this run"
        );
      }
      if (facts.predecessor_pending) {
        return domain2(
          ctx,
          cmd.kind,
          "predecessor_pending_first_use",
          "this credential has not been used yet; a successor is issued only from a credential already in use"
        );
      }
      const replacing = facts.superseded && facts.successor_pending;
      const effectiveUsed = grant.successors_used - grant.successors_stranded;
      const successorsUsed = replacing ? effectiveUsed - 1 : effectiveUsed;
      if (!Number.isInteger(grant.successors_used) || !Number.isInteger(grant.successors_stranded) || grant.max_successors !== null && (!Number.isInteger(grant.max_successors) || successorsUsed >= grant.max_successors)) {
        return domain2(
          ctx,
          cmd.kind,
          "renewal_successors_exhausted",
          "renewal grant has no successors left"
        );
      }
      const inherited = new Set(predecessor.scopes);
      if (cmd.scopes.length === 0 || cmd.scopes.some((scope) => !inherited.has(scope))) {
        return domain2(
          ctx,
          cmd.kind,
          "renewal_scope_widened",
          "successor scopes must be equal to or narrower than the predecessor"
        );
      }
      if (cmd.scopes.some(isAgentScopeDenylisted)) {
        return domain2(ctx, cmd.kind, "scope_denylisted", "one or more scopes are human-credential-only");
      }
      if (state.tokens[cmd.successor_token_id]) {
        return domain2(ctx, cmd.kind, "bad_state", "successor token id already exists");
      }
      const expires_at = grant.kind === "standing" ? ctx.now + AGENT_TOKEN_DEFAULT_TTL_MS : Math.min(
        ctx.now + AGENT_TOKEN_DEFAULT_TTL_MS,
        grant.horizon_expires_at
      );
      return accept2([
        env2(ctx, "AgentTokenMinted", {
          token_id: cmd.successor_token_id,
          principal_id: predecessor.principal_id,
          run_id: predecessor.run_id,
          task_id: predecessor.task_id,
          epoch: predecessor.epoch,
          scopes: [...cmd.scopes],
          issued_at: ctx.now,
          expires_at,
          // Lineage marks, carried as extra payload fields. A dedicated
          // AgentTokenRenewed type would have to be added to
          // workspace-events.ts; the reducer folds the required AgentTokenMinted
          // fields and ignores the rest.
          predecessor_token_id: predecessor.token_id,
          renewal_grant_id: grant.renewal_grant_id
        })
      ]);
    }
    case "revoke_agent_token": {
      if (ctx.credential_kind === "agent") {
        if (ctx.presenting_token_id !== cmd.token_id || ctx.actor.agent_principal === null) {
          return authz2(
            "credential_kind_forbidden",
            "agent credential may revoke only its exact presenting token"
          );
        }
      }
      const token = state.tokens[cmd.token_id];
      if (!token) {
        return domain2(ctx, cmd.kind, "token_not_found", "agent token does not exist");
      }
      if (token.revoked_at !== null) {
        return domain2(ctx, cmd.kind, "token_revoked", "agent token is already revoked");
      }
      const principal = state.principals[token.principal_id];
      if (!principal) {
        return domain2(ctx, cmd.kind, "principal_not_found", "token principal does not exist");
      }
      if (ctx.credential_kind === "agent") {
        if (token.principal_id !== ctx.actor.agent_principal) {
          return authz2(
            "credential_kind_forbidden",
            "agent credential may revoke only its exact presenting token"
          );
        }
      } else if (!ownerOrAdmin(actorRole) && principal.owner_user_id !== user_id) {
        return domain2(ctx, cmd.kind, "principal_not_owned", "Member may revoke only a token for their own principal");
      }
      return accept2([
        env2(ctx, "AgentTokenRevoked", { token_id: cmd.token_id, revoked_at: ctx.now })
      ]);
    }
    case "enable_agent_management":
    case "disable_agent_management":
    case "recover_agent_session":
    case "mint_agent_join_credential":
    case "revoke_agent_join_credential":
    case "acquire_agent_session":
    case "renew_agent_session":
    case "release_agent_session":
      throw new Error("Handled outside reducer");
  }
}

// src/protocol/hosted-authority.ts
var HOSTED_MCP_RESOURCE = "https://mcp.commonswarm.com/mcp";
var HOSTED_MCP_SEAT_LIMIT = 10;
var HOSTED_SEAT_NAME_TAKEN = {
  code: "hosted_seat_name_taken",
  message: "That name is taken in this workspace; choose another."
};
var PUBLIC_HOSTED_ONLY_COMMANDS = /* @__PURE__ */ new Set([
  "begin_hosted_mcp_grant",
  "consent_hosted_mcp_workspace",
  "activate_hosted_mcp_grant",
  "claim_hosted_seat",
  "open_hosted_mcp_check_batch",
  "ack_hosted_mcp_check_batch"
]);
function publicHostedCommandForbidden(kind) {
  return PUBLIC_HOSTED_ONLY_COMMANDS.has(kind);
}
var HUMAN_COMMANDS = /* @__PURE__ */ new Set([
  "begin_hosted_mcp_grant",
  "consent_hosted_mcp_workspace",
  "activate_hosted_mcp_grant",
  "revoke_hosted_mcp_grant",
  "revoke_hosted_mcp_seat"
]);
var HOSTED_SEAT_CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/u;
function hostedSeatNameValid(value) {
  return typeof value === "string" && Array.from(value).length >= 1 && Array.from(value).length <= 80 && value === value.replace(/^ +| +$/gu, "") && !HOSTED_SEAT_CONTROL_RE.test(value);
}
function event(ctx, type, payload) {
  return {
    workspace_id: ctx.workspace_id,
    stream_id: ctx.stream_id,
    seq: ctx.nextSeq(),
    event_id: ctx.nextEventId(),
    command_id: ctx.command_id,
    type,
    schema_version: SCHEMA_VERSION,
    actor_user: ctx.actor.user,
    actor_agent_principal: ctx.actor.agent_principal,
    actor_run: ctx.actor.run,
    occurred_at_server: ctx.now,
    payload
  };
}
function refuse(className, reason, detail) {
  return { ok: false, class: className, reason, detail, events: [] };
}
function decideHostedAuthority(command, facts, ctx) {
  if (command.kind === "claim_hosted_seat") {
    if (ctx.credential_kind !== "hosted_grant") {
      return refuse("authz", "credential_kind_forbidden", "claim_hosted_seat requires a hosted grant credential");
    }
  } else if (HUMAN_COMMANDS.has(command.kind) && ctx.credential_kind !== "human") {
    return refuse("authz", "credential_kind_forbidden", "hosted connection management requires a human credential");
  }
  if (command.kind === "begin_hosted_mcp_grant") {
    if (ctx.actor.user !== command.owner_user_id) {
      return refuse("authz", "hosted_grant_not_owned", "a person may begin only their own hosted grant");
    }
    if (facts.grant !== null) return refuse("domain", "hosted_grant_exists", "hosted grant already exists");
    if (command.home_workspace_id !== ctx.workspace_id) {
      return refuse("authz", "workspace_mismatch", "grant creation must address its home workspace");
    }
    if (!facts.owner_is_live_member || facts.workspace_archived) {
      return refuse("authz", "membership_required", "grant owner is not a live member of the home workspace");
    }
    const selected = [...new Set(command.selected_workspace_ids)];
    if (selected.length !== command.selected_workspace_ids.length || selected.length < 1 || selected.length > 100 || !selected.includes(command.home_workspace_id)) {
      return refuse("domain", "hosted_manifest_invalid", "hosted grant workspace manifest is invalid");
    }
    if (command.resource !== HOSTED_MCP_RESOURCE) {
      return refuse("domain", "resource_mismatch", "hosted grant resource is not supported");
    }
    return { ok: true, events: [event(ctx, "HostedMcpGrantBegun", { ...command, created_at: ctx.now })] };
  }
  const grant = facts.grant;
  if (grant === null || grant.grant_id !== command.grant_id) {
    return refuse("authz", "hosted_grant_unavailable", "hosted grant is unavailable");
  }
  if (command.kind === "consent_hosted_mcp_workspace") {
    if (grant.state !== "pending" || command.workspace_id !== ctx.workspace_id) {
      return refuse("domain", "hosted_grant_not_pending", "workspace consent requires a pending grant");
    }
    if (ctx.actor.user !== grant.owner_user_id || command.owner_user_id !== grant.owner_user_id || command.manifest_digest !== grant.manifest_digest || !grant.selected_workspace_ids.includes(ctx.workspace_id)) {
      return refuse("authz", "manifest_mismatch", "workspace is not bound to this grant manifest");
    }
    if (!facts.owner_is_live_member || facts.workspace_archived) {
      return refuse("authz", "membership_required", "grant owner is not a live member of this workspace");
    }
    if (facts.workspace_consented) return { ok: true, events: [] };
    return { ok: true, events: [event(ctx, "HostedMcpWorkspaceConsented", { ...command, consented_at: ctx.now })] };
  }
  if (command.kind === "activate_hosted_mcp_grant") {
    if (ctx.workspace_id !== grant.home_workspace_id) {
      return refuse("authz", "workspace_mismatch", "grant activation must address its home workspace");
    }
    if (ctx.actor.user !== grant.owner_user_id) {
      return refuse("authz", "hosted_grant_not_owned", "a person may activate only their own hosted grant");
    }
    if (!facts.all_required_consents || !facts.all_required_memberships || !facts.owner_is_live_member || facts.workspace_archived) {
      return refuse("domain", "hosted_consent_incomplete", "Every selected workspace must consent before activation.");
    }
    if (grant.state === "active") return { ok: true, events: [] };
    if (grant.state !== "pending") {
      return refuse("domain", "hosted_consent_incomplete", "Every selected workspace must consent before activation.");
    }
    return { ok: true, events: [event(ctx, "HostedMcpGrantActivated", { grant_id: grant.grant_id, activated_at: ctx.now })] };
  }
  if (command.kind === "revoke_hosted_mcp_grant") {
    if (ctx.actor.user !== grant.owner_user_id || ctx.workspace_id !== grant.home_workspace_id) {
      return refuse("authz", "hosted_grant_not_owned", "a person may revoke only their own hosted grant");
    }
    if (grant.state === "revoked") return { ok: true, events: [] };
    return { ok: true, events: [event(ctx, "HostedMcpGrantRevoked", { grant_id: grant.grant_id, revoked_at: ctx.now })] };
  }
  if (command.kind === "revoke_hosted_mcp_seat") {
    const seat = facts.seat;
    if (seat === null || seat.grant_id !== grant.grant_id || seat.workspace_id !== ctx.workspace_id) {
      return refuse("authz", "hosted_seat_unavailable", "hosted seat is unavailable");
    }
    if (ctx.actor.user !== grant.owner_user_id) {
      return refuse("authz", "hosted_seat_not_owned", "a person may revoke only their own hosted seat");
    }
    if (seat.revoked_at !== null) return { ok: true, events: [] };
    return { ok: true, events: [event(ctx, "HostedMcpSeatRevoked", {
      grant_id: grant.grant_id,
      seat_id: seat.seat_id,
      principal_id: seat.principal_id,
      revoked_at: ctx.now
    })] };
  }
  if (grant.state !== "active" || !facts.workspace_consented || !facts.owner_is_live_member || facts.workspace_archived) {
    return refuse("authz", "hosted_grant_unavailable", "hosted grant is not active for this workspace");
  }
  if (command.owner_user_id !== grant.owner_user_id || command.workspace_id !== ctx.workspace_id) {
    return refuse("authz", "hosted_grant_binding_mismatch", "seat claim does not match the grant binding");
  }
  if (!hostedSeatNameValid(command.name)) {
    return refuse("domain", "hosted_seat_name_invalid", "Seat names must be 1 to 80 characters, have no leading or trailing spaces, and contain no control characters.");
  }
  if (facts.seat !== null) {
    const seat = facts.seat;
    if (seat.revoked_at !== null || seat.handle_revoked_at !== null || seat.principal_revoked_at !== null || seat.transport !== "hosted_mcp" || seat.turn_only !== true) {
      return refuse("domain", "hosted_seat_revoked", "A revoked hosted seat cannot be restored; choose another name.");
    }
    if (facts.exact_name_principal_ids.length !== 1 || facts.exact_name_principal_ids[0] !== seat.principal_id) {
      return refuse("domain", HOSTED_SEAT_NAME_TAKEN.code, HOSTED_SEAT_NAME_TAKEN.message);
    }
    return { ok: true, events: [], reuse: seat };
  }
  if (facts.exact_name_principal_ids.length !== 0) {
    return refuse("domain", HOSTED_SEAT_NAME_TAKEN.code, HOSTED_SEAT_NAME_TAKEN.message);
  }
  if (facts.live_seat_count >= HOSTED_MCP_SEAT_LIMIT) {
    return refuse("domain", "hosted_seat_limit_reached", `This connection already has ${HOSTED_MCP_SEAT_LIMIT} live seats.`);
  }
  return { ok: true, events: [event(ctx, "HostedMcpSeatClaimed", {
    ...command,
    transport: "hosted_mcp",
    turn_only: true,
    created_at: ctx.now
  })] };
}
function requiredPayload(event2, keys) {
  const payload = event2.payload;
  for (const key2 of keys) {
    if (payload[key2] === void 0) {
      throw new Error(`event "${event2.type}" at seq ${event2.seq} is missing payload field "${key2}"`);
    }
  }
  return payload;
}
function reduceHostedAuthority(previous, event2) {
  if (event2.schema_version !== SCHEMA_VERSION) {
    throw new Error(`event "${event2.type}" has unsupported schema version`);
  }
  const state = previous ?? {
    grants: {},
    consents: {},
    seats: {},
    principals: {}
  };
  if (event2.type === "HostedMcpGrantBegun") {
    const p2 = requiredPayload(event2, [
      "grant_id",
      "provider_grant_id",
      "owner_user_id",
      "home_workspace_id",
      "client_id",
      "resource",
      "selected_workspace_ids",
      "manifest_digest",
      "interaction_ref",
      "created_at"
    ]);
    const id2 = String(p2.grant_id);
    if (state.grants[id2]) throw new Error(`duplicate hosted grant "${id2}"`);
    return { ...state, grants: { ...state.grants, [id2]: {
      grant_id: id2,
      provider_grant_id: String(p2.provider_grant_id),
      owner_user_id: String(p2.owner_user_id),
      home_workspace_id: String(p2.home_workspace_id),
      client_id: String(p2.client_id),
      resource: String(p2.resource),
      selected_workspace_ids: [...p2.selected_workspace_ids],
      manifest_digest: String(p2.manifest_digest),
      interaction_ref: String(p2.interaction_ref),
      state: "pending",
      created_at: Number(p2.created_at),
      activated_at: null,
      revoked_at: null
    } } };
  }
  if (event2.type === "HostedMcpWorkspaceConsented") {
    const p2 = requiredPayload(event2, [
      "grant_id",
      "workspace_id",
      "owner_user_id",
      "consent_receipt_id",
      "consented_at",
      "manifest_digest"
    ]);
    const key2 = `${String(p2.grant_id)}:${String(p2.workspace_id)}`;
    if (state.consents[key2]) throw new Error(`duplicate hosted workspace consent "${key2}"`);
    return { ...state, consents: { ...state.consents, [key2]: {
      grant_id: String(p2.grant_id),
      workspace_id: String(p2.workspace_id),
      owner_user_id: String(p2.owner_user_id),
      manifest_digest: String(p2.manifest_digest),
      consent_receipt_id: String(p2.consent_receipt_id),
      consented_at: Number(p2.consented_at),
      revoked_at: null
    } } };
  }
  if (event2.type === "HostedMcpGrantActivated" || event2.type === "HostedMcpGrantRevoked") {
    const p2 = requiredPayload(event2, [
      "grant_id",
      event2.type === "HostedMcpGrantActivated" ? "activated_at" : "revoked_at"
    ]);
    const id2 = String(p2.grant_id);
    const grant = state.grants[id2];
    if (!grant) throw new Error(`unknown hosted grant "${id2}"`);
    return { ...state, grants: {
      ...state.grants,
      [id2]: event2.type === "HostedMcpGrantActivated" ? { ...grant, state: "active", activated_at: Number(p2.activated_at), revoked_at: null } : { ...grant, state: "revoked", revoked_at: Number(p2.revoked_at) }
    } };
  }
  if (event2.type === "HostedMcpSeatClaimed") {
    const p2 = requiredPayload(event2, [
      "seat_id",
      "grant_id",
      "workspace_id",
      "owner_user_id",
      "principal_id",
      "name",
      "handle",
      "created_at",
      "transport",
      "turn_only"
    ]);
    const id2 = String(p2.seat_id);
    if (state.seats[id2]) throw new Error(`duplicate hosted seat "${id2}"`);
    if (p2.transport !== "hosted_mcp" || p2.turn_only !== true) {
      throw new Error("hosted seat event must be hosted_mcp and turn_only");
    }
    const principalId = String(p2.principal_id);
    const seat2 = {
      seat_id: id2,
      grant_id: String(p2.grant_id),
      workspace_id: String(p2.workspace_id),
      owner_user_id: String(p2.owner_user_id),
      principal_id: principalId,
      name: String(p2.name),
      handle: String(p2.handle),
      transport: "hosted_mcp",
      turn_only: true,
      created_at: Number(p2.created_at),
      revoked_at: null,
      handle_revoked_at: null,
      principal_revoked_at: null
    };
    return {
      ...state,
      seats: { ...state.seats, [id2]: seat2 },
      principals: { ...state.principals, [principalId]: {
        principal_id: principalId,
        workspace_id: seat2.workspace_id,
        owner_user_id: seat2.owner_user_id,
        name: seat2.name,
        transport: "hosted_mcp",
        turn_only: true,
        created_at: seat2.created_at,
        revoked_at: null
      } }
    };
  }
  const p = requiredPayload(event2, ["seat_id", "revoked_at"]);
  const id = String(p.seat_id);
  const seat = state.seats[id];
  if (!seat) throw new Error(`unknown hosted seat "${id}"`);
  const revokedAt = Number(p.revoked_at);
  const principal = state.principals[seat.principal_id];
  if (!principal) throw new Error(`unknown hosted principal "${seat.principal_id}"`);
  return {
    ...state,
    seats: {
      ...state.seats,
      [id]: {
        ...seat,
        revoked_at: revokedAt,
        handle_revoked_at: revokedAt,
        principal_revoked_at: revokedAt
      }
    },
    principals: {
      ...state.principals,
      [seat.principal_id]: { ...principal, revoked_at: revokedAt }
    }
  };
}
function reduceHostedAuthorityStream(events) {
  let state = null;
  let lastSeq = -Infinity;
  for (const event2 of events) {
    if (event2.seq <= lastSeq) throw new Error("hosted authority events are out of order");
    state = reduceHostedAuthority(state, event2);
    lastSeq = event2.seq;
  }
  return state ?? { grants: {}, consents: {}, seats: {}, principals: {} };
}

// src/protocol/hosted-check.ts
var HOSTED_CHECK_BATCH_LIMIT = 50;
function hostedCheckMillisecondTimestamp(value) {
  const milliseconds = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error("invalid hosted check timestamp");
  return new Date(Math.trunc(milliseconds)).toISOString();
}
function compareHostedCheckCursor(left, right) {
  const time = Date.parse(hostedCheckMillisecondTimestamp(left.created_at)) - Date.parse(hostedCheckMillisecondTimestamp(right.created_at));
  return time === 0 ? left.signal_id.localeCompare(right.signal_id) : Math.sign(time);
}
function sameAuthority(value, facts) {
  return value.seat_id === facts.seat_id && value.grant_id === facts.grant_id && value.workspace_id === facts.workspace_id;
}
function canonicalBatchId(value) {
  return value.toLowerCase();
}
function normalizedCandidates(candidates, cursor) {
  const byId = /* @__PURE__ */ new Map();
  for (const candidate of candidates) {
    const normalized = {
      created_at: hostedCheckMillisecondTimestamp(candidate.created_at),
      signal_id: candidate.signal_id
    };
    if (cursor === null || compareHostedCheckCursor(normalized, cursor) > 0) {
      byId.set(normalized.signal_id, normalized);
    }
  }
  return [...byId.values()].sort(compareHostedCheckCursor).slice(0, HOSTED_CHECK_BATCH_LIMIT);
}
function decideHostedCheck(command, facts) {
  if (facts.credential_kind !== "hosted_seat") {
    return { ok: false, reason: "credential_kind_forbidden" };
  }
  if (command.seat_id !== facts.seat_id || command.grant_id !== facts.grant_id || command.workspace_id !== facts.workspace_id) {
    return { ok: false, reason: "hosted_check_batch_forbidden" };
  }
  if (facts.active_batch !== null && !sameAuthority(facts.active_batch, facts)) {
    return { ok: false, reason: "hosted_check_batch_forbidden" };
  }
  let active = facts.active_batch;
  let acknowledgeBatchId = null;
  let advanceCursor = null;
  if (command.kind === "ack_hosted_mcp_check_batch") {
    const requested = facts.requested_batch;
    const commandBatchId = canonicalBatchId(command.batch_id);
    if (requested === null || canonicalBatchId(requested.batch_id) !== commandBatchId || !sameAuthority(requested, facts)) {
      return { ok: false, reason: "hosted_check_batch_forbidden" };
    }
    if (!requested.acknowledged) {
      if (active === null || canonicalBatchId(active.batch_id) !== commandBatchId) {
        return { ok: false, reason: "hosted_check_batch_forbidden" };
      }
      acknowledgeBatchId = canonicalBatchId(requested.batch_id);
      advanceCursor = {
        created_at: hostedCheckMillisecondTimestamp(requested.terminal_cursor.created_at),
        signal_id: requested.terminal_cursor.signal_id
      };
      active = null;
    }
  }
  if (active !== null) {
    return {
      ok: true,
      acknowledge_batch_id: acknowledgeBatchId,
      advance_cursor: advanceCursor,
      create_batch: null,
      return_batch: active
    };
  }
  const cursor = advanceCursor ?? facts.committed_cursor;
  const candidates = normalizedCandidates(facts.candidates, cursor);
  if (candidates.length === 0) {
    return {
      ok: true,
      acknowledge_batch_id: acknowledgeBatchId,
      advance_cursor: advanceCursor,
      create_batch: null,
      return_batch: null
    };
  }
  const terminal = candidates[candidates.length - 1];
  const batch = {
    batch_id: facts.next_batch_id,
    seat_id: facts.seat_id,
    grant_id: facts.grant_id,
    workspace_id: facts.workspace_id,
    signal_ids: candidates.map((candidate) => candidate.signal_id),
    terminal_cursor: terminal,
    acknowledged: false
  };
  return {
    ok: true,
    acknowledge_batch_id: acknowledgeBatchId,
    advance_cursor: advanceCursor,
    create_batch: batch,
    return_batch: batch
  };
}

// src/protocol/brain-version-window.ts
var BRAIN_FILE_PREFIX = "brain--";
var BRAIN_FILE_SUFFIX = ".md";
var BRAIN_TOPIC_MAX_LENGTH = 255 - BRAIN_FILE_PREFIX.length - BRAIN_FILE_SUFFIX.length;
var BRAIN_LIVE_VERSION_LIMIT = 20;
var BRAIN_FILE_NAME_RE = /^brain--[a-z0-9][a-z0-9._-]*\.md$/i;
function isBrainFileArtifactName(name) {
  return name.length <= 255 && BRAIN_FILE_NAME_RE.test(name);
}
var FILE_VERSION_PRECONDITION_FAILED = "file_version_precondition_failed";
function isFileVersionPrecondition(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function fileVersionPreconditionSatisfied(requiredVersion, liveVersion) {
  return requiredVersion === liveVersion;
}
function fileVersionPreconditionMessage(requiredVersion, liveVersion) {
  const current = liveVersion === 0 ? "this name has no live version yet" : `this file is at version ${liveVersion}`;
  return `${current}; the request required version ${requiredVersion}, so the new version was not saved`;
}
function planFileVersionWindow(name, liveCount, inFlightCount) {
  if (!Number.isSafeInteger(liveCount) || liveCount < 0) {
    throw new RangeError("liveCount must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(inFlightCount) || inFlightCount < 0) {
    throw new RangeError("inFlightCount must be a non-negative safe integer");
  }
  const brainTopic = isBrainFileArtifactName(name);
  return {
    brainTopic,
    createAllowed: brainTopic ? inFlightCount < BRAIN_LIVE_VERSION_LIMIT : liveCount + inFlightCount < BRAIN_LIVE_VERSION_LIMIT,
    retireOnCommitCount: brainTopic ? Math.max(0, liveCount - BRAIN_LIVE_VERSION_LIMIT + 1) : 0
  };
}
export {
  AGENT_TOKEN_DEFAULT_TTL_MS,
  AGENT_TOKEN_MAX_TTL_MS,
  AGENT_TRANSPORTS,
  BRAIN_FILE_PREFIX,
  BRAIN_FILE_SUFFIX,
  BRAIN_LIVE_VERSION_LIMIT,
  BRAIN_TOPIC_MAX_LENGTH,
  DISPOSITIONS,
  EVENT_TYPES,
  FEEDBACK_BODY_MAX,
  FEEDBACK_CATEGORIES,
  FEEDBACK_CONTEXT_MAX_BYTES,
  FILE_VERSION_PRECONDITION_FAILED,
  H0_SEAT_TOKEN_TTL_MS,
  HOSTED_CHECK_BATCH_LIMIT,
  HOSTED_MCP_RESOURCE,
  HOSTED_MCP_SEAT_LIMIT,
  HOSTED_SEAT_NAME_TAKEN,
  HUMAN_ONLY_COMMANDS,
  INVITATION_MAX_TTL_MS,
  PRINCIPAL_NAME_TAKEN,
  RENEWAL_HORIZON_DEFAULT_MS,
  RENEWAL_HORIZON_MAX_MS,
  RENEWAL_IDLE_PAUSE_DAYS,
  RENEWAL_MAX_SUCCESSORS_DEFAULT,
  SCHEMA_VERSION,
  StreamIntegrityError,
  UnknownEventTypeError,
  UpcastError,
  WORKSPACE_EVENT_TYPES,
  WORKSPACE_ROLES,
  applyCommand,
  canonicalJson,
  canonicalPrincipal,
  compareHostedCheckCursor,
  decide,
  decideHostedAuthority,
  decideHostedCheck,
  decideWorkspace,
  fileVersionPreconditionMessage,
  fileVersionPreconditionSatisfied,
  hostedCheckMillisecondTimestamp,
  hostedSeatNameValid,
  idemKey,
  isAgentScopeDenylisted,
  isBrainFileArtifactName,
  isFileVersionPrecondition,
  leaseLive,
  normalizedFeedbackBody,
  normalizedFeedbackContext,
  planFileVersionWindow,
  publicHostedCommandForbidden,
  reduceHostedAuthority,
  reduceHostedAuthorityStream,
  reduceStream,
  reduceTask,
  reduceWorkspace,
  reduceWorkspaceStream,
  registerUpcaster,
  requestHash,
  upcastEnvelope,
  upcastPayload
};
