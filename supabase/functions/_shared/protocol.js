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

// src/protocol/admin-routine-events.ts
var ADMIN_ROUTINE_EVENT_TYPES = [
  "AdminWorkspaceCreated",
  "AdminSeatCreated",
  "AdminSeatProvisioned",
  "AdminSeatRenewed",
  "AdminSeatCredentialReplaced",
  "AdminSeatRevoked",
  "AdminSeatCredentialRevoked",
  "AdminMemberInvited",
  "AdminAgentInvitationIssued",
  "AdminInvitationRevoked"
];

// src/protocol/workspace-events.ts
var WORKSPACE_ROLES = ["owner", "admin", "member"];
var AGENT_TRANSPORTS = ["local", "hosted_mcp"];
var WORKSPACE_EVENT_TYPES = [
  ...ADMIN_ROUTINE_EVENT_TYPES,
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

// src/protocol/admin-policy.ts
var ADMIN_RESOURCE = "https://api.commonswarm.com/admin";
var ADMIN_REGISTRY_VERSION = 1;
var ADMIN_ACCESS_TTL_SECONDS = 300;
var ADMIN_REFRESH_MAX_LIFETIME_SECONDS = 2592e3;
var ADMIN_GRANT_TTL_SECONDS = 2592e3;
var ADMIN_READ_RATE_PER_HOUR = { lineage: 120, connection: 120, account: 1e3, workspace: 1e3 };
var ADMIN_MUTATION_RATE_PER_HOUR = { lineage: 20, connection: 20, account: 60, workspace: 60 };
var ADMIN_REFRESH_RATE_PER_HOUR = 20;
var ADMIN_WORKSPACE_CREATE_PER_DAY = 20;
var ADMIN_INVITATION_ISSUE_PER_DAY = 10;
var ADMIN_WORKSPACES_CREATED_PER_GRANT = 10;
var ADMIN_SEATS_PER_GRANT = { live: 10, total: 50 };
var ADMIN_INVITATIONS_PER_GRANT = { total: 10, live_agent: 5 };
var ADMIN_WORKER_CREDENTIAL_ISSUES_PER_GRANT = 50;
var ADMIN_WORKER_RENEWAL_LIMITS = { bearer_seconds: 3600, horizon_seconds: 2592e3, successors_per_worker: 800, successors_per_grant: 8e3 };
var ADMIN_CONNECTION_ATTEMPTS_PER_GRANT = 50;
var ADMIN_INVITATION_AND_ATTEMPT_TTL = { member_seconds: 604800, agent_min_seconds: 3600, agent_max_seconds: 86400, agent_seats: 10, attempt_seconds: 86400 };
var ADMIN_EXISTING_RESOURCE_CEILINGS = { owned_workspaces: 10, members_and_invitations: 25, principals: 50, joins_per_person: 5, joins_per_workspace: 20, hosted_seats: 10 };
var ADMIN_SCOPE_REGISTRY = {
  "admin:read": ["admin_read_metadata"],
  "workspaces:create": ["admin_create_workspace"],
  "workspaces:archive": ["admin_archive_workspace"],
  "seats:create": ["admin_create_seat", "admin_provision_seat", "admin_replace_undelivered_seat_credential"],
  "seats:renew": ["admin_renew_seat"],
  "seats:manage": ["admin_set_seat_model", "admin_enable_seat_management", "admin_recover_seat_session"],
  "seats:revoke": ["admin_revoke_seat", "admin_revoke_seat_credential"],
  "invites:create": ["admin_invite_member", "admin_issue_agent_invitation"],
  "invites:revoke": ["admin_revoke_invitation", "admin_revoke_agent_invitation"],
  "members:manage": ["admin_remove_member", "admin_change_member_role"],
  "onboarding:connect": ["admin_prepare_connection", "redeem_agent_connection", "record_agent_connection_progress", "admin_cancel_connection"]
};
var ADMIN_SCOPE_NAMES = Object.keys(ADMIN_SCOPE_REGISTRY);
var ADMIN_ISSUANCE_CEILINGS = {
  workspaces: ADMIN_WORKSPACES_CREATED_PER_GRANT,
  live_seats: ADMIN_SEATS_PER_GRANT.live,
  total_seats: ADMIN_SEATS_PER_GRANT.total,
  invitations: ADMIN_INVITATIONS_PER_GRANT.total,
  live_agent_invitations: ADMIN_INVITATIONS_PER_GRANT.live_agent,
  worker_credentials: ADMIN_WORKER_CREDENTIAL_ISSUES_PER_GRANT,
  connection_attempts: ADMIN_CONNECTION_ATTEMPTS_PER_GRANT
};
var ADMIN_RENEWAL_CEILINGS = ADMIN_WORKER_RENEWAL_LIMITS;
function adminRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function adminExactKeys(value, keys) {
  return Object.keys(value).length === keys.length && keys.every((key2) => Object.hasOwn(value, key2));
}
var ADMIN_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
function adminIds(value) {
  return Array.isArray(value) && value.length <= 100 && value.every((id) => typeof id === "string" && ADMIN_UUID_RE.test(id)) && new Set(value).size === value.length;
}
function adminScopes(value) {
  return Array.isArray(value) && value.every((scope) => typeof scope === "string" && Object.hasOwn(ADMIN_SCOPE_REGISTRY, scope)) && new Set(value).size === value.length;
}
var MANIFEST_KEYS = [
  "admin_identity_id",
  "connection_id",
  "client_id",
  "resource",
  "mode",
  "registry_version",
  "scope_names",
  "workspace_selector",
  "workspace_ids",
  "created_workspace_policy",
  "target_rules",
  "worker_scope_ceiling",
  "role_ceiling",
  "renewal_limits",
  "issuance_limits",
  "expires_at",
  "refresh_deadline"
];
function adminManifestValid(value, now, initial = true) {
  const m = adminRecord(value);
  if (!m || !adminExactKeys(m, MANIFEST_KEYS)) return false;
  const target = adminRecord(m.target_rules), created = adminRecord(m.created_workspace_policy);
  const renewal = adminRecord(m.renewal_limits), issuance = adminRecord(m.issuance_limits);
  if (!ADMIN_UUID_RE.test(String(m.admin_identity_id)) || !ADMIN_UUID_RE.test(String(m.connection_id)) || typeof m.client_id !== "string" || m.client_id.length < 1 || m.client_id.length > 2048 || m.resource !== ADMIN_RESOURCE || m.registry_version !== ADMIN_REGISTRY_VERSION || !adminScopes(m.scope_names) || !m.scope_names.includes("admin:read") || !adminIds(m.workspace_ids) || m.role_ceiling !== "member" || !["granular", "full_account"].includes(String(m.mode)) || m.workspace_selector !== (m.mode === "granular" ? "selected" : "owned_and_selected")) return false;
  if (m.mode === "full_account" && !ADMIN_SCOPE_NAMES.every((scope) => m.scope_names.includes(scope))) return false;
  if (!created || !adminExactKeys(created, ["scope_names"]) || !adminScopes(created.scope_names) || !created.scope_names.every((scope) => m.scope_names.includes(scope)) || created.scope_names.length > 0 && !m.scope_names.includes("workspaces:create")) return false;
  if (!target || !adminExactKeys(target, ["seat_ids", "own_seats", "grant_created_seats", "recipient_user_ids", "recipient_connection_ids", "transports"]) || !adminIds(target.seat_ids) || !adminIds(target.recipient_user_ids) || !adminIds(target.recipient_connection_ids) || typeof target.own_seats !== "boolean" || typeof target.grant_created_seats !== "boolean" || !Array.isArray(target.transports) || !target.transports.every((t) => t === "local" || t === "hosted_mcp") || new Set(target.transports).size !== target.transports.length) return false;
  if (!Array.isArray(m.worker_scope_ceiling) || m.worker_scope_ceiling.length > 100 || !m.worker_scope_ceiling.every((scope) => typeof scope === "string" && /^[a-z][a-z0-9_:.-]{0,79}$/u.test(scope)) || m.worker_scope_ceiling.some((scope) => isAgentScopeDenylisted(String(scope))) || new Set(m.worker_scope_ceiling).size !== m.worker_scope_ceiling.length) return false;
  if (!renewal || !adminExactKeys(renewal, [...Object.keys(ADMIN_RENEWAL_CEILINGS), "grant_kinds", "principal_ids"]) || !adminIds(renewal.principal_ids) || !Array.isArray(renewal.grant_kinds) || !renewal.grant_kinds.every((kind) => kind === "timeboxed" || kind === "standing") || new Set(renewal.grant_kinds).size !== renewal.grant_kinds.length || !issuance || !adminExactKeys(issuance, Object.keys(ADMIN_ISSUANCE_CEILINGS))) return false;
  for (const [limits, ceilings] of [[renewal, ADMIN_RENEWAL_CEILINGS], [issuance, ADMIN_ISSUANCE_CEILINGS]]) {
    for (const [key2, ceiling] of Object.entries(ceilings)) {
      const n = limits[key2];
      if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0 || n > ceiling) return false;
    }
  }
  return typeof m.expires_at === "number" && Number.isSafeInteger(m.expires_at) && typeof m.refresh_deadline === "number" && Number.isSafeInteger(m.refresh_deadline) && m.expires_at > now && m.expires_at <= m.refresh_deadline && (!initial || m.expires_at >= now + 1e3 && m.refresh_deadline <= now + ADMIN_REFRESH_MAX_LIFETIME_SECONDS * 1e3 && m.expires_at <= now + ADMIN_GRANT_TTL_SECONDS * 1e3);
}
function canonicalAdminJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalAdminJson).join(",")}]`;
  const r = adminRecord(value);
  if (r) return `{${Object.keys(r).sort().map((key2) => `${JSON.stringify(key2)}:${canonicalAdminJson(r[key2])}`).join(",")}}`;
  return JSON.stringify(value);
}
function adminGrantManifest(value) {
  return Object.fromEntries(MANIFEST_KEYS.map((key2) => [key2, value[key2]]));
}

// src/protocol/admin-authority.ts
var ADMIN_EVENT_TYPES = [
  "AdminConsentPrepared",
  "AdminDelegationGranted",
  "AdminDelegationNarrowed",
  "AdminDelegationRevoked",
  "AdminDelegationSuspended",
  "AdminDelegationExpired",
  "AdminWorkspaceAccessWithdrawn",
  "AdminCredentialIssued",
  "AdminCredentialRotated",
  "AdminCredentialReplayDetected",
  "AdminMetadataRead",
  "AdminActionRecorded",
  "AdminConnectionPrepared",
  "AdminConnectionCancelled"
];
function emptyAdminAccount() {
  return { grants: {}, consents: {}, lineages: {}, rate_buckets: {} };
}
function adminRatePolicy(actor, grant, action, workspaceId, lineageId, requestedGrantId) {
  if (actor.kind === "human" || actor.kind === "system" || action === "surrender_admin_delegation" && actor.kind === "delegated_admin" && actor.grant_id === grant.grant_id && requestedGrantId === actor.grant_id) return [];
  if (actor.kind === "credential_runtime" && lineageId !== null) return [
    { key: `refresh:lineage:${lineageId}`, limit: ADMIN_REFRESH_RATE_PER_HOUR },
    { key: `refresh:connection:${grant.connection_id}`, limit: ADMIN_REFRESH_RATE_PER_HOUR }
  ];
  const kind = action === "admin_read_metadata" ? "read" : "mutation";
  const limits = kind === "read" ? ADMIN_READ_RATE_PER_HOUR : ADMIN_MUTATION_RATE_PER_HOUR;
  return [
    { key: `${kind}:grant:${grant.grant_id}`, limit: limits.lineage },
    { key: `${kind}:connection:${grant.connection_id}`, limit: limits.connection },
    { key: `${kind}:account:${grant.owner_user_id}`, limit: limits.account },
    ...workspaceId === null || !grant.workspace_ids.includes(workspaceId) ? [] : [{ key: `${kind}:workspace:${workspaceId}`, limit: limits.workspace }]
  ];
}
function subset(a, b) {
  return a.every((x) => b.includes(x));
}
function narrowing(next, prior, now) {
  if (!adminManifestValid(next, now, false) || next.admin_identity_id !== prior.admin_identity_id || next.connection_id !== prior.connection_id || next.client_id !== prior.client_id || next.resource !== prior.resource || next.registry_version !== prior.registry_version || prior.mode === "granular" && next.mode !== "granular" || next.expires_at > prior.expires_at || next.refresh_deadline !== prior.refresh_deadline || !subset(next.scope_names, prior.scope_names) || !subset(next.workspace_ids, prior.workspace_ids) || !subset(next.created_workspace_policy.scope_names, prior.created_workspace_policy.scope_names) || !subset(next.worker_scope_ceiling, prior.worker_scope_ceiling)) return false;
  const a = next.target_rules, b = prior.target_rules;
  if (!subset(a.seat_ids, b.seat_ids) || !subset(a.recipient_user_ids, b.recipient_user_ids) || !subset(a.recipient_connection_ids, b.recipient_connection_ids) || !subset(a.transports, b.transports) || a.own_seats && !b.own_seats || a.grant_created_seats && !b.grant_created_seats || !subset(next.renewal_limits.grant_kinds, prior.renewal_limits.grant_kinds) || !subset(next.renewal_limits.principal_ids, prior.renewal_limits.principal_ids)) return false;
  for (const key2 of ["bearer_seconds", "horizon_seconds", "successors_per_worker", "successors_per_grant"]) {
    if (next.renewal_limits[key2] > prior.renewal_limits[key2]) return false;
  }
  return Object.keys(next.issuance_limits).every((key2) => next.issuance_limits[key2] <= prior.issuance_limits[key2]);
}
function decideAdminAuthority(command, state, ctx) {
  const events = [];
  const grant = "grant_id" in command ? state.grants[command.grant_id] : void 0;
  let auditGrant = ctx.actor.kind === "delegated_admin" ? state.grants[ctx.actor.grant_id] : grant;
  const auditId = ctx.nextEventId();
  const actor = ctx.actor;
  const buckets = auditGrant ? adminRatePolicy(
    actor,
    auditGrant,
    command.kind,
    "workspace_id" in command ? command.workspace_id : null,
    actor.kind === "credential_runtime" && "generation" in command ? command.credential_lineage_id : null,
    "grant_id" in command ? command.grant_id : null
  ).map(({ key: key2, limit }) => {
    const prior = state.rate_buckets[key2], hour_start = Math.floor(ctx.now / 36e5);
    return { key: key2, limit, hour_start, attempts: prior?.hour_start === hour_start ? prior.attempts + 1 : 1 };
  }) : [];
  const emit = (type, payload) => {
    const eventGrant = typeof payload.grant_id === "string" ? state.grants[payload.grant_id] ?? auditGrant : auditGrant;
    const e = {
      stream_kind: "account",
      owner_user_id: ctx.owner_user_id,
      stream_id: ctx.stream_id,
      seq: ctx.nextSeq(),
      event_id: ctx.nextEventId(),
      command_id: ctx.command_id,
      type,
      schema_version: 1,
      actor_user: actor.kind === "human" ? actor.user_id : null,
      actor_agent_principal: null,
      actor_run: null,
      admin_identity_id: typeof payload.admin_identity_id === "string" ? payload.admin_identity_id : eventGrant?.admin_identity_id ?? (actor.kind === "delegated_admin" ? actor.admin_identity_id : null),
      grant_id: typeof payload.grant_id === "string" ? payload.grant_id : "grant_id" in command ? command.grant_id : null,
      grant_manifest_digest: typeof payload.manifest_digest === "string" ? payload.manifest_digest : eventGrant?.manifest_digest ?? null,
      occurred_at_server: ctx.now,
      payload
    };
    events.push(e);
    return e;
  };
  const finish = (reason) => {
    const related = events.map((e) => e.event_id);
    emit("AdminActionRecorded", {
      audit_record_id: auditId,
      grant_id: auditGrant?.grant_id ?? ("grant_id" in command ? command.grant_id : null),
      admin_identity_id: auditGrant?.admin_identity_id ?? null,
      connection_id: auditGrant?.connection_id ?? null,
      action: command.kind,
      target_kind: "admin_grant",
      target_id: auditGrant?.grant_id ?? null,
      workspace_id: "workspace_id" in command ? command.workspace_id : null,
      manifest_digest: auditGrant?.manifest_digest ?? null,
      request_digest: ctx.request_digest,
      outcome: reason === null ? "accepted" : "refused",
      reason_code: reason,
      policy_check: { result: reason ?? "passed", buckets: buckets.map(({ key: key2, hour_start, attempts }) => ({ key: key2, hour_start, attempts })) },
      related_event_ids: related,
      next_action: reason === null ? "none" : "Ask the granting person to review this connection.",
      recovery_kind: reason === null ? "none" : "human"
    });
    return { ok: reason === null, reason, events };
  };
  const humanOwner = actor.kind === "human" && actor.user_id === ctx.owner_user_id;
  if (actor.kind === "worker" || actor.kind === "hosted_seat") return finish("credential_kind_forbidden");
  const replayLineage = "credential_lineage_id" in command ? state.lineages[command.credential_lineage_id] : void 0;
  const verifiedReplay = actor.kind === "credential_runtime" && grant && replayLineage?.grant_id === grant.grant_id && (command.kind === "rotate_admin_credential" || command.kind === "record_admin_credential_replay") && ctx.presenting_refresh_lineage_id === command.credential_lineage_id && ctx.presenting_refresh_generation === command.generation && command.generation < replayLineage.generation && actor.connection_id === grant.connection_id && actor.client_id === grant.client_id && actor.resource === ADMIN_RESOURCE;
  if (!verifiedReplay && buckets.some((bucket) => !Number.isSafeInteger(bucket.attempts) || bucket.attempts < 1 || bucket.attempts > bucket.limit)) return finish("rate_limited");
  if (command.kind === "prepare_admin_consent") {
    const c = command.consent;
    if (!humanOwner || actor.kind !== "human" || c.owner_user_id !== ctx.owner_user_id || c.session_binding !== actor.session_binding) return finish("human_confirmation_required");
    if (!adminManifestValid(c.manifest, ctx.now) || c.consumed_at !== null || c.expires_at <= ctx.now || c.expires_at > ctx.now + ADMIN_ACCESS_TTL_SECONDS * 1e3 || c.manifest.mode === "full_account" && !c.full_account_selected || !ctx.current_workspace_rights || state.consents[c.consent_receipt_id]) return finish("consent_invalid");
    emit("AdminConsentPrepared", {
      consent_receipt_id: c.consent_receipt_id,
      owner_user_id: c.owner_user_id,
      manifest: c.manifest,
      manifest_digest: c.manifest_digest,
      full_account_selected: c.full_account_selected,
      expires_at: c.expires_at
    });
    return finish(null);
  }
  if (command.kind === "grant_admin_delegation") {
    const c = state.consents[command.consent_receipt_id];
    if (!humanOwner || actor.kind !== "human") return finish("human_confirmation_required");
    if (!c || c.owner_user_id !== ctx.owner_user_id || c.session_binding !== actor.session_binding || c.consumed_at !== null || c.expires_at <= ctx.now || !adminManifestValid(c.manifest, ctx.now) || c.manifest.mode === "full_account" && !c.full_account_selected || !ctx.current_workspace_rights || state.grants[command.grant_id]) return finish("consent_invalid");
    const previous = command.replaces_grant_id === null ? null : state.grants[command.replaces_grant_id];
    if (Object.values(state.grants).some((g) => g.connection_id === c.manifest.connection_id && g.state === "active" && g.grant_id !== command.replaces_grant_id)) return finish("replacement_required");
    if (command.replaces_grant_id !== null && (!previous || previous.owner_user_id !== ctx.owner_user_id || previous.connection_id !== c.manifest.connection_id)) return finish("replacement_invalid");
    if (previous && (previous.state === "active" || previous.state === "suspended")) emit("AdminDelegationRevoked", terminalPayload(previous, state, ctx.now, "replaced"));
    emit("AdminDelegationGranted", {
      ...c.manifest,
      grant_id: command.grant_id,
      owner_user_id: ctx.owner_user_id,
      consent_receipt_id: c.consent_receipt_id,
      manifest_digest: c.manifest_digest,
      replaces_grant_id: command.replaces_grant_id,
      created_at: ctx.now
    });
    auditGrant = {
      ...c.manifest,
      grant_id: command.grant_id,
      owner_user_id: ctx.owner_user_id,
      consent_receipt_id: c.consent_receipt_id,
      manifest_digest: c.manifest_digest,
      created_at: ctx.now,
      state: "active",
      suspended_at: null,
      revoked_at: null,
      reason_code: null,
      withdrawn_workspace_ids: []
    };
    return finish(null);
  }
  if (!grant || grant.owner_user_id !== ctx.owner_user_id) return finish("grant_unavailable");
  if (actor.kind === "delegated_admin" && (actor.grant_id !== grant.grant_id || actor.admin_identity_id !== grant.admin_identity_id || actor.connection_id !== grant.connection_id || actor.resource !== ADMIN_RESOURCE)) return finish("grant_binding_mismatch");
  if (actor.kind === "delegated_admin" && (!adminScopes(actor.scope_names) || !subset(actor.scope_names, grant.scope_names))) return finish("scope_expansion_forbidden");
  if (command.kind === "revoke_admin_delegation" || command.kind === "suspend_admin_delegation" || command.kind === "surrender_admin_delegation") {
    if (command.kind === "surrender_admin_delegation" ? actor.kind !== "delegated_admin" : !humanOwner && actor.kind !== "system") return finish("human_confirmation_required");
    if (actor.kind === "delegated_admin" && actor.access_expires_at <= ctx.now) return finish("credential_expired");
    if (grant.state === "revoked" || grant.state === "expired" || grant.state === "suspended" && command.kind === "suspend_admin_delegation") return finish(null);
    emit(command.kind === "suspend_admin_delegation" ? "AdminDelegationSuspended" : "AdminDelegationRevoked", terminalPayload(grant, state, ctx.now, command.reason_code));
    return finish(null);
  }
  if (command.kind === "expire_admin_delegation") {
    if (actor.kind !== "system") return finish("credential_kind_forbidden");
    if (grant.expires_at > ctx.now && grant.refresh_deadline > ctx.now) return finish("deadline_not_reached");
    if (grant.state === "active") emit("AdminDelegationExpired", { ...terminalPayload(grant, state, ctx.now, "expired"), expires_at: grant.expires_at, detected_at: ctx.now });
    return finish(null);
  }
  if (command.kind === "withdraw_admin_workspace_access") {
    if (actor.kind !== "human" || !ctx.withdrawing_workspace_owner) return finish("workspace_owner_required");
    if (!grant.workspace_ids.includes(command.workspace_id) && !(grant.workspace_selector === "owned_and_selected" && ctx.target_workspace_owned_by_grantor)) return finish("workspace_forbidden");
    if (!grant.withdrawn_workspace_ids.includes(command.workspace_id)) emit("AdminWorkspaceAccessWithdrawn", {
      grant_id: grant.grant_id,
      workspace_id: command.workspace_id,
      withdrawing_user_id: actor.user_id,
      effective_at: ctx.now,
      reason_code: command.reason_code
    });
    return finish(null);
  }
  if (command.kind === "admin_read_metadata" && humanOwner) {
    emit("AdminMetadataRead", {
      resource_kind: "grant",
      workspace_id: null,
      target_filter_digest: ctx.request_digest,
      projection_version: 1,
      result_count: 1,
      audit_record_id: auditId
    });
    return finish(null);
  }
  if (grant.state !== "active" || grant.expires_at <= ctx.now || grant.refresh_deadline <= ctx.now) return finish("grant_inactive");
  if (command.kind === "narrow_admin_delegation") {
    const c = state.consents[command.consent_receipt_id];
    if (!humanOwner || actor.kind !== "human") return finish("human_confirmation_required");
    if (!c || c.session_binding !== actor.session_binding || c.consumed_at !== null || c.expires_at <= ctx.now || c.manifest_digest !== command.manifest_digest || canonicalAdminJson(c.manifest) !== canonicalAdminJson(command.manifest) || !narrowing(command.manifest, grant, ctx.now)) return finish("scope_expansion_forbidden");
    emit("AdminDelegationNarrowed", {
      grant_id: grant.grant_id,
      prior_manifest_digest: grant.manifest_digest,
      new_manifest_digest: command.manifest_digest,
      removed_scopes: grant.scope_names.filter((s) => !command.manifest.scope_names.includes(s)),
      removed_workspace_ids: grant.workspace_ids.filter((id) => !command.manifest.workspace_ids.includes(id)),
      new_target_rules: command.manifest.target_rules,
      new_limits: { issuance_limits: command.manifest.issuance_limits, renewal_limits: command.manifest.renewal_limits },
      new_expires_at: command.manifest.expires_at,
      consent_receipt_id: command.consent_receipt_id,
      manifest: command.manifest
    });
    return finish(null);
  }
  if (command.kind === "admin_read_metadata") {
    if (!humanOwner && (actor.kind !== "delegated_admin" || actor.access_expires_at <= ctx.now || !actor.scope_names.includes("admin:read") || !grant.scope_names.includes("admin:read") || command.resource_kind !== "grant")) return finish("credential_kind_forbidden");
    if (command.workspace_id !== null && (!grant.workspace_ids.includes(command.workspace_id) || grant.withdrawn_workspace_ids.includes(command.workspace_id) || !ctx.current_workspace_rights)) return finish("workspace_forbidden");
    emit("AdminMetadataRead", {
      resource_kind: "grant",
      workspace_id: command.workspace_id,
      target_filter_digest: ctx.request_digest,
      projection_version: 1,
      result_count: 1,
      audit_record_id: auditId
    });
    return finish(null);
  }
  if (command.kind !== "issue_admin_credential" && command.kind !== "rotate_admin_credential" && command.kind !== "record_admin_credential_replay") return finish("human_confirmation_required");
  if (actor.kind !== "credential_runtime" || actor.connection_id !== grant.connection_id || actor.client_id !== grant.client_id || actor.resource !== ADMIN_RESOURCE) return finish("credential_runtime_required");
  const lineage = state.lineages[command.credential_lineage_id];
  if (command.kind === "issue_admin_credential") {
    if (!ctx.current_workspace_rights) return finish("current_rights_required");
    if (Object.values(state.lineages).some((l) => l.grant_id === grant.grant_id) || lineage) return finish("credential_already_issued");
    emit("AdminCredentialIssued", {
      grant_id: grant.grant_id,
      credential_lineage_id: command.credential_lineage_id,
      connection_id: grant.connection_id,
      resource: ADMIN_RESOURCE,
      generation: 0,
      scope_names: grant.scope_names,
      access_expires_at: Math.min(ctx.now + ADMIN_ACCESS_TTL_SECONDS * 1e3, grant.expires_at, grant.refresh_deadline),
      refresh_deadline: grant.refresh_deadline,
      delivery_state: "awaiting_delivery"
    });
    return finish(null);
  }
  if (!lineage || lineage.grant_id !== grant.grant_id || lineage.state !== "active" || ctx.presenting_refresh_lineage_id !== command.credential_lineage_id || ctx.presenting_refresh_generation === null || ctx.presenting_refresh_generation !== command.generation) return finish("refresh_invalid");
  if (command.kind === "record_admin_credential_replay" || command.generation !== lineage.generation) {
    if (command.generation >= lineage.generation) return finish("refresh_invalid");
    emit("AdminCredentialReplayDetected", {
      grant_id: grant.grant_id,
      credential_lineage_id: lineage.credential_lineage_id,
      replayed_generation: command.generation,
      detected_at: ctx.now,
      reason_code: "refresh_replay"
    });
    emit("AdminDelegationRevoked", terminalPayload(grant, state, ctx.now, "refresh_replay"));
    return finish("refresh_replay");
  }
  if (!adminScopes(command.scope_names) || !command.scope_names.includes("admin:read") || !subset(command.scope_names, lineage.scope_names) || !subset(command.scope_names, grant.scope_names)) return finish("scope_expansion_forbidden");
  if (!ctx.current_workspace_rights) return finish("current_rights_required");
  emit("AdminCredentialRotated", {
    grant_id: grant.grant_id,
    credential_lineage_id: lineage.credential_lineage_id,
    generation: lineage.generation + 1,
    scope_names: command.scope_names,
    access_expires_at: Math.min(ctx.now + ADMIN_ACCESS_TTL_SECONDS * 1e3, grant.expires_at, lineage.refresh_deadline),
    refresh_deadline: lineage.refresh_deadline
  });
  return finish(null);
}
function terminalPayload(grant, state, now, reason) {
  return {
    grant_id: grant.grant_id,
    reason_code: reason,
    effective_at: now,
    credential_lineage_id: Object.values(state.lineages).find((l) => l.grant_id === grant.grant_id)?.credential_lineage_id ?? null,
    cancelled_attempt_ids: Object.values(state.connections ?? {}).filter((a) => a.parent_admin_grant_id === grant.grant_id && a.state === "awaiting_authorization").map((a) => a.attempt_id),
    dependent_child_ids: [
      ...Object.entries(state.routine?.seats ?? {}).filter(([, s]) => s.grant_id === grant.grant_id).map(([id]) => id),
      ...Object.values(state.routine?.credentials ?? {}).filter((c) => c.parent_admin_grant_id === grant.grant_id).map((c) => c.credential_id),
      ...Object.values(state.routine?.invitations ?? {}).filter((i) => i.parent_admin_grant_id === grant.grant_id).map((i) => i.invitation_id)
    ]
  };
}
function reduceAdminAuthority(previous, event2) {
  if (event2.schema_version !== 1 || event2.stream_kind !== "account" || !ADMIN_EVENT_TYPES.includes(event2.type) && !ADMIN_ROUTINE_EVENT_TYPES.includes(event2.type)) throw new Error("unsupported admin event");
  const state = previous ?? emptyAdminAccount(), p = event2.payload;
  if (event2.type === "AdminConnectionPrepared") {
    const attempt = p;
    if (!event2.grant_id || attempt.parent_admin_grant_id !== event2.grant_id || !state.grants[event2.grant_id] || state.connections?.[attempt.attempt_id] || attempt.state !== "awaiting_authorization" || attempt.cancelled_at !== null || !Number.isSafeInteger(attempt.expires_at) || attempt.expires_at <= event2.occurred_at_server) {
      throw new Error("invalid connection preparation event");
    }
    const {
      attempt_id,
      parent_admin_grant_id,
      workspace_id,
      intended_owner_user_id,
      intended_agent_id,
      recipient_connection_id,
      requested_name,
      transport,
      ttl_seconds,
      capability_set,
      state: status2,
      created_at,
      expires_at,
      cancelled_at,
      reason_code
    } = attempt;
    return { ...state, connections: { ...state.connections, [attempt_id]: {
      attempt_id,
      parent_admin_grant_id,
      workspace_id,
      intended_owner_user_id,
      intended_agent_id,
      recipient_connection_id,
      requested_name,
      transport,
      ttl_seconds,
      capability_set,
      state: status2,
      created_at,
      expires_at,
      cancelled_at,
      reason_code
    } } };
  }
  if (event2.type === "AdminConnectionCancelled") {
    const attempt = state.connections?.[String(p.attempt_id)];
    if (!attempt || attempt.parent_admin_grant_id !== event2.grant_id) throw new Error("unknown connection attempt");
    return { ...state, connections: { ...state.connections, [attempt.attempt_id]: {
      ...attempt,
      state: "cancelled",
      cancelled_at: attempt.cancelled_at ?? event2.occurred_at_server,
      reason_code: attempt.reason_code ?? String(p.reason_code)
    } } };
  }
  if (ADMIN_ROUTINE_EVENT_TYPES.includes(event2.type)) return { ...state, routine: reduceAdminRoutine(state.routine, event2) };
  if (event2.type === "AdminConsentPrepared") {
    const c = { ...p, session_binding: "", consumed_at: null };
    return { ...state, consents: { ...state.consents, [c.consent_receipt_id]: c } };
  }
  if (event2.type === "AdminDelegationGranted") {
    const grant2 = { ...p, state: "active", suspended_at: null, revoked_at: null, reason_code: null, withdrawn_workspace_ids: [] };
    if (state.grants[grant2.grant_id]) throw new Error("duplicate admin grant");
    const consent = state.consents[grant2.consent_receipt_id];
    if (!consent) throw new Error("missing admin consent");
    return { ...state, routine: { ...state.routine ?? emptyAdminRoutine(), spend: { ...state.routine?.spend, [grant2.grant_id]: { workspaces: 0, total_seats: 0, invitations: 0, worker_credentials: 0, successors: 0 } } }, grants: { ...state.grants, [grant2.grant_id]: grant2 }, consents: { ...state.consents, [consent.consent_receipt_id]: { ...consent, consumed_at: event2.occurred_at_server } } };
  }
  if (event2.type === "AdminCredentialIssued" || event2.type === "AdminCredentialRotated") {
    const id2 = String(p.credential_lineage_id), old = state.lineages[id2];
    if (event2.type === "AdminCredentialRotated" && (!old || p.generation !== old.generation + 1)) throw new Error("invalid admin credential generation");
    return { ...state, lineages: { ...state.lineages, [id2]: { ...old, ...p, state: "active", delivery_state: "awaiting_delivery" } } };
  }
  if (event2.type === "AdminActionRecorded") {
    const policy = p.policy_check;
    const rates = { ...state.rate_buckets };
    for (const bucket of policy?.buckets ?? []) rates[bucket.key] = { hour_start: bucket.hour_start, attempts: bucket.attempts };
    return { ...state, rate_buckets: rates };
  }
  if (event2.type === "AdminMetadataRead" || event2.type === "AdminCredentialReplayDetected") return state;
  const id = String(p.grant_id), grant = state.grants[id];
  if (!grant) throw new Error("unknown admin grant");
  if (event2.type === "AdminWorkspaceAccessWithdrawn") return {
    ...state,
    ...cancelPendingConnections(state, id, event2.occurred_at_server, "workspace_withdrawn", String(p.workspace_id)),
    grants: { ...state.grants, [id]: { ...grant, withdrawn_workspace_ids: [.../* @__PURE__ */ new Set([...grant.withdrawn_workspace_ids, String(p.workspace_id)])] } }
  };
  if (event2.type === "AdminDelegationNarrowed") {
    const receipt = String(p.consent_receipt_id), consent = state.consents[receipt];
    if (!consent) throw new Error("missing narrowing consent");
    return { ...state, grants: { ...state.grants, [id]: { ...grant, ...p.manifest, manifest_digest: String(p.new_manifest_digest), consent_receipt_id: receipt } }, consents: { ...state.consents, [receipt]: { ...consent, consumed_at: event2.occurred_at_server } } };
  }
  const status = event2.type === "AdminDelegationRevoked" ? "revoked" : event2.type === "AdminDelegationSuspended" ? "suspended" : "expired";
  const cancelledAt = status === "expired" ? grant.expires_at : event2.occurred_at_server;
  const routine = state.routine ? { ...state.routine, invitations: Object.fromEntries(Object.entries(state.routine.invitations).map(([key2, invitation]) => [key2, invitation.parent_admin_grant_id === id && invitation.accepted_at === null ? { ...invitation, revoked_at: invitation.revoked_at ?? cancelledAt } : invitation])) } : void 0;
  return {
    ...state,
    ...routine ? { routine } : {},
    ...cancelPendingConnections(state, id, cancelledAt, String(p.reason_code)),
    grants: { ...state.grants, [id]: {
      ...grant,
      state: status,
      reason_code: String(p.reason_code),
      revoked_at: status === "revoked" ? event2.occurred_at_server : grant.revoked_at,
      suspended_at: status === "suspended" ? event2.occurred_at_server : grant.suspended_at
    } },
    lineages: Object.fromEntries(Object.entries(state.lineages).map(([key2, l]) => [key2, l.grant_id === id ? { ...l, state: "revoked" } : l]))
  };
}
function cancelPendingConnections(state, grantId, at, reason, workspaceId) {
  if (!state.connections) return {};
  return { connections: Object.fromEntries(Object.entries(state.connections).map(([key2, attempt]) => [
    key2,
    attempt.parent_admin_grant_id === grantId && attempt.state === "awaiting_authorization" && (workspaceId === void 0 || attempt.workspace_id === workspaceId) ? { ...attempt, state: "cancelled", cancelled_at: at, reason_code: reason } : attempt
  ])) };
}

// src/protocol/admin-routine.ts
var emptyAdminRoutine = () => ({
  spend: {},
  created_workspaces: {},
  seats: {},
  credentials: {},
  invitations: {}
});
var uuid = (x) => typeof x === "string" && ADMIN_UUID_RE.test(x);
var text = (x, max) => typeof x === "string" && x.length > 0 && x.length <= max && x.trim() === x && !/[\u0000-\u001f\u007f]/u.test(x);
var positive = (x) => Number.isSafeInteger(x) && Number(x) > 0;
var scopes = (x) => Array.isArray(x) && x.length > 0 && x.length <= 100 && x.every(
  (s) => text(s, 80) && /^[a-z][a-z0-9_:.-]*$/u.test(s) && !isAgentScopeDenylisted(s)
) && new Set(x).size === x.length;
var code = (x) => typeof x === "string" && /^[a-z][a-z0-9_]{0,79}$/u.test(x);
function parseAdminRoutineCommand(value) {
  const c = adminRecord(value);
  if (!c || !uuid(c.grant_id) || !uuid(c.workspace_id)) return null;
  const exact = (keys) => adminExactKeys(c, ["kind", "grant_id", "workspace_id", ...keys]);
  let valid = false;
  switch (c.kind) {
    case "admin_prepare_connection":
      valid = exact(["intended_owner_user_id", "intended_agent_id", "recipient_connection_id", "requested_name", "transport", "ttl_seconds"]) && uuid(c.intended_owner_user_id) && uuid(c.intended_agent_id) && uuid(c.recipient_connection_id) && text(c.requested_name, 80) && ["local", "hosted_mcp"].includes(String(c.transport)) && positive(c.ttl_seconds);
      break;
    case "admin_cancel_connection":
      valid = exact(["attempt_id", "reason_code"]) && uuid(c.attempt_id) && code(c.reason_code);
      break;
    case "admin_create_workspace":
      valid = exact(["name"]) && text(c.name, 80);
      break;
    case "admin_create_seat":
      valid = exact(["name", "model", "transport"]) && text(c.name, 80) && (c.model === null || text(c.model, 120)) && ["local", "hosted_mcp"].includes(String(c.transport));
      break;
    case "admin_provision_seat":
      valid = exact([
        "principal_id",
        "recipient_connection_id",
        "worker_scope_names",
        "bearer_seconds",
        "horizon_seconds",
        "max_successors"
      ]) && uuid(c.principal_id) && uuid(c.recipient_connection_id) && scopes(c.worker_scope_names) && positive(c.bearer_seconds) && positive(c.horizon_seconds) && positive(c.max_successors);
      break;
    case "admin_renew_seat":
      valid = exact([
        "principal_id",
        "predecessor_credential_id",
        "recipient_connection_id",
        "worker_scope_names",
        "bearer_seconds"
      ]) && uuid(c.principal_id) && uuid(c.predecessor_credential_id) && uuid(c.recipient_connection_id) && scopes(c.worker_scope_names) && positive(c.bearer_seconds);
      break;
    case "admin_replace_undelivered_seat_credential":
      valid = exact(["principal_id", "credential_id", "recipient_connection_id"]) && uuid(c.principal_id) && uuid(c.credential_id) && uuid(c.recipient_connection_id);
      break;
    case "admin_revoke_seat":
      valid = exact(["principal_id", "reason_code"]) && uuid(c.principal_id) && code(c.reason_code);
      break;
    case "admin_revoke_seat_credential":
      valid = exact(["principal_id", "credential_id", "reason_code"]) && uuid(c.principal_id) && uuid(c.credential_id) && code(c.reason_code);
      break;
    case "admin_invite_member":
      valid = exact(["recipient_user_id", "role", "ttl_seconds"]) && uuid(c.recipient_user_id) && c.role === "member" && positive(c.ttl_seconds);
      break;
    case "admin_issue_agent_invitation":
      valid = exact([
        "intended_owner_user_id",
        "recipient_connection_id",
        "transport",
        "seat_limit",
        "worker_scope_names",
        "ttl_seconds"
      ]) && uuid(c.intended_owner_user_id) && uuid(c.recipient_connection_id) && ["local", "hosted_mcp"].includes(String(c.transport)) && positive(c.seat_limit) && scopes(c.worker_scope_names) && positive(c.ttl_seconds);
      break;
    case "admin_revoke_invitation":
    case "admin_revoke_agent_invitation":
      valid = exact(["invitation_id", "reason_code"]) && uuid(c.invitation_id) && code(c.reason_code);
      break;
  }
  return valid ? c : null;
}
function decideAdminRoutine(command, account, ctx) {
  const events = [], workspace_events = [];
  const actor = ctx.actor, grant = account.grants[command.grant_id];
  let pendingConnection;
  const routine = account.routine ?? emptyAdminRoutine();
  const auditedGrant = actor.kind === "delegated_admin" ? account.grants[actor.grant_id] : grant;
  const rateGrant = auditedGrant && (account.routine?.created_workspaces[command.workspace_id]?.grant_id === auditedGrant.grant_id || auditedGrant.workspace_selector === "owned_and_selected" && ctx.workspace?.members[ctx.owner_user_id]?.role === "owner" && ctx.workspace.members[ctx.owner_user_id].revoked_at === null) ? {
    ...auditedGrant,
    workspace_ids: [
      .../* @__PURE__ */ new Set([...auditedGrant.workspace_ids, command.workspace_id])
    ]
  } : auditedGrant;
  const rates = rateGrant ? adminRatePolicy(
    actor,
    rateGrant,
    command.kind,
    command.workspace_id,
    null,
    command.grant_id
  ).map(({ key: key2, limit }) => {
    const start = Math.floor(ctx.now / 36e5), old = account.rate_buckets[key2];
    return {
      key: key2,
      limit,
      hour_start: start,
      attempts: old?.hour_start === start ? old.attempts + 1 : 1
    };
  }) : [];
  const emit = (type, payload) => {
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
      payload
    });
    if (type !== "AdminActionRecorded" && type !== "AdminConnectionPrepared" && type !== "AdminConnectionCancelled") workspaceEmit(type, payload);
  };
  const workspaceEmit = (type, payload) => workspace_events.push({
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
    payload
  });
  const finish = (reason) => {
    const related = [...events, ...workspace_events].map((e) => e.event_id);
    emit("AdminActionRecorded", {
      audit_record_id: ctx.nextEventId(),
      grant_id: auditedGrant?.grant_id ?? null,
      admin_identity_id: auditedGrant?.admin_identity_id ?? null,
      connection_id: auditedGrant?.connection_id ?? null,
      action: command.kind,
      target_kind: pendingConnection || "attempt_id" in command ? "connection" : "principal_id" in command ? "seat" : "invitation_id" in command ? "invitation" : "workspace",
      target_id: pendingConnection?.attempt_id ?? ("attempt_id" in command ? command.attempt_id : "principal_id" in command ? command.principal_id : "invitation_id" in command ? command.invitation_id : command.workspace_id),
      workspace_id: command.workspace_id,
      manifest_digest: auditedGrant?.manifest_digest ?? null,
      request_digest: ctx.request_digest,
      outcome: reason ? "refused" : pendingConnection || events.some(
        (e) => [
          "AdminSeatProvisioned",
          "AdminSeatRenewed",
          "AdminSeatCredentialReplaced",
          "AdminMemberInvited",
          "AdminAgentInvitationIssued"
        ].includes(e.type)
      ) ? "pending" : "accepted",
      reason_code: reason,
      ...!reason && pendingConnection ? { attempt_id: pendingConnection.attempt_id, delivery_state: pendingConnection.state } : {},
      policy_check: {
        result: reason ?? "passed",
        buckets: rates.map(({ key: key2, hour_start, attempts }) => ({
          key: key2,
          hour_start,
          attempts
        }))
      },
      related_event_ids: related,
      next_action: reason ? "Ask the granting person to review access." : pendingConnection || events.some((e) => e.payload.delivery_state) ? "The recipient must authorize setup and verify its connection." : "none",
      recovery_kind: reason ? "human" : "none"
    });
    return { ok: reason === null, reason, events, workspace_events };
  };
  if (!parseAdminRoutineCommand(command)) return finish("invalid_request");
  if (actor.kind !== "delegated_admin") {
    return finish("credential_kind_forbidden");
  }
  if (!grant || grant.owner_user_id !== ctx.owner_user_id || actor.grant_id !== grant.grant_id || actor.admin_identity_id !== grant.admin_identity_id || actor.connection_id !== grant.connection_id || actor.resource !== ADMIN_RESOURCE) return finish("grant_binding_mismatch");
  if (grant.state !== "active" || !adminManifestValid(adminGrantManifest(grant), ctx.now, false)) return finish("grant_inactive");
  if (actor.access_expires_at <= ctx.now) return finish("credential_expired");
  if (rates.some((b) => !positive(b.attempts) || b.attempts > b.limit)) {
    return finish("rate_limited");
  }
  if (!actor.scope_names.every((s) => grant.scope_names.includes(s))) {
    return finish("scope_expansion_forbidden");
  }
  const scope = Object.entries(ADMIN_SCOPE_REGISTRY).find(
    ([, commands]) => commands.includes(command.kind)
  )?.[0];
  if (!scope || !grant.scope_names.includes(scope) || !actor.scope_names.includes(scope)) return finish("scope_forbidden");
  const created = routine.created_workspaces[command.workspace_id];
  if (command.kind !== "admin_create_workspace") {
    const selected = grant.workspace_ids.includes(command.workspace_id);
    const owned = grant.workspace_selector === "owned_and_selected" && ctx.workspace?.members[ctx.owner_user_id]?.role === "owner";
    if (grant.withdrawn_workspace_ids.includes(command.workspace_id) || !(selected || owned || created?.grant_id === grant.grant_id) || created?.grant_id === grant.grant_id && (!created.scope_names.includes(scope) || !grant.created_workspace_policy.scope_names.includes(scope))) return finish("workspace_forbidden");
    const member = ctx.workspace?.members[ctx.owner_user_id];
    if (!ctx.workspace || ctx.workspace.workspace.archived_at !== null || !member || member.revoked_at !== null || !["owner", "admin"].includes(member.role)) return finish("current_rights_required");
  }
  const spend = routine.spend[grant.grant_id];
  if (!spend) return finish("counter_invalid");
  if (!Object.values(spend).every((n) => Number.isSafeInteger(n) && n >= 0) || ![
    ctx.owned_workspaces,
    ctx.workspace_creations_last_day,
    ctx.invitations_last_day,
    ctx.live_principals,
    ctx.live_members_and_invitations,
    ctx.live_agent_invitations_person,
    ctx.live_agent_invitations_workspace
  ].every((n) => Number.isSafeInteger(n) && n >= 0)) return finish("counter_invalid");
  const budget = (key2, used) => used < grant.issuance_limits[key2];
  if (command.kind === "admin_prepare_connection") {
    if (command.intended_owner_user_id !== ctx.owner_user_id) return finish("human_confirmation_required");
    if (!ctx.recipient_exists || !grant.target_rules.recipient_user_ids.includes(command.intended_owner_user_id) || !grant.target_rules.recipient_connection_ids.includes(command.recipient_connection_id) || !grant.target_rules.transports.includes(command.transport)) return finish("recipient_forbidden");
    if (command.ttl_seconds > ADMIN_INVITATION_AND_ATTEMPT_TTL.attempt_seconds) return finish("connection_ttl_invalid");
    const attempts = Object.values(account.connections ?? {}).filter((a) => a.parent_admin_grant_id === grant.grant_id);
    const prior2 = attempts.find((a) => a.workspace_id === command.workspace_id && a.intended_owner_user_id === command.intended_owner_user_id && a.intended_agent_id === command.intended_agent_id);
    if (prior2) {
      if (prior2.recipient_connection_id !== command.recipient_connection_id || prior2.requested_name !== command.requested_name || prior2.transport !== command.transport || prior2.ttl_seconds !== command.ttl_seconds) return finish("connection_target_conflict");
      if (prior2.state === "cancelled") return finish("connection_attempt_cancelled");
      if (prior2.expires_at <= ctx.now) return finish("connection_attempt_expired");
      pendingConnection = prior2;
      return finish(null);
    }
    if (!budget("connection_attempts", attempts.length)) return finish("connection_attempt_limit_reached");
    pendingConnection = {
      attempt_id: ctx.nextResourceId(),
      parent_admin_grant_id: grant.grant_id,
      workspace_id: command.workspace_id,
      intended_owner_user_id: command.intended_owner_user_id,
      intended_agent_id: command.intended_agent_id,
      recipient_connection_id: command.recipient_connection_id,
      requested_name: command.requested_name,
      transport: command.transport,
      ttl_seconds: command.ttl_seconds,
      capability_set: [],
      state: "awaiting_authorization",
      created_at: ctx.now,
      expires_at: Math.min(ctx.now + command.ttl_seconds * 1e3, grant.expires_at, grant.refresh_deadline),
      cancelled_at: null,
      reason_code: null
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
    emit("AdminConnectionCancelled", {
      attempt_id: attempt.attempt_id,
      cancelled_at: ctx.now,
      reason_code: command.reason_code,
      revoked_attempt_credential_ids: [],
      attempt_owned_seat_ids: []
    });
    return finish(null);
  }
  if (command.kind === "admin_create_workspace") {
    if (ctx.workspace) return finish("workspace_exists");
    if (!budget("workspaces", spend.workspaces) || ctx.owned_workspaces >= ADMIN_EXISTING_RESOURCE_CEILINGS.owned_workspaces || ctx.workspace_creations_last_day >= ADMIN_WORKSPACE_CREATE_PER_DAY) return finish("workspace_limit_reached");
    workspaceEmit("WorkspaceCreated", {
      workspace_id: command.workspace_id,
      name: command.name,
      created_by: ctx.owner_user_id,
      created_at: ctx.now
    });
    emit("AdminWorkspaceCreated", {
      workspace_id: command.workspace_id,
      name: command.name,
      owner_user_id: ctx.owner_user_id,
      created_workspace_policy: grant.created_workspace_policy,
      applied_scope_names: grant.created_workspace_policy.scope_names,
      created_at: ctx.now
    });
    return finish(null);
  }
  const principal = "principal_id" in command ? ctx.workspace.principals[command.principal_id] : void 0;
  if ("principal_id" in command) {
    if (!principal || principal.owner_user_id !== ctx.owner_user_id || !(grant.target_rules.seat_ids.includes(principal.principal_id) || grant.target_rules.own_seats || grant.target_rules.grant_created_seats && routine.seats[principal.principal_id]?.grant_id === grant.grant_id)) return finish("target_forbidden");
    if (!grant.target_rules.transports.includes(principal.transport)) {
      return finish("transport_forbidden");
    }
    if (principal.revoked_at !== null && command.kind !== "admin_revoke_seat") {
      return finish("principal_revoked");
    }
  }
  if (command.kind === "admin_create_seat") {
    const live = Object.values(routine.seats).filter(
      (s) => s.grant_id === grant.grant_id && s.revoked_at === null
    ).length;
    if (!grant.target_rules.grant_created_seats || !grant.target_rules.transports.includes(command.transport)) {
      return finish("target_forbidden");
    }
    if (!budget("total_seats", spend.total_seats) || !budget("live_seats", live) || ctx.live_principals >= ADMIN_EXISTING_RESOURCE_CEILINGS.principals) {
      return finish("seat_limit_reached");
    }
    if (Object.values(ctx.workspace.principals).some(
      (p) => p.name === command.name
    )) {
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
      connection_attempt_id: null
    };
    workspaceEmit("AgentPrincipalCreated", payload);
    emit("AdminSeatCreated", payload);
    return finish(null);
  }
  if (command.kind === "admin_invite_member" || command.kind === "admin_issue_agent_invitation") {
    const agent = command.kind === "admin_issue_agent_invitation";
    const recipient = agent ? command.intended_owner_user_id : command.recipient_user_id;
    if (!ctx.recipient_exists || !grant.target_rules.recipient_user_ids.includes(recipient)) return finish("recipient_forbidden");
    if (!budget("invitations", spend.invitations) || ctx.invitations_last_day >= ADMIN_INVITATION_ISSUE_PER_DAY) return finish("invitation_limit_reached");
    if (!agent && (ctx.recipient_is_member || ctx.live_members_and_invitations >= ADMIN_EXISTING_RESOURCE_CEILINGS.members_and_invitations)) return finish("member_limit_reached");
    if (agent) {
      if (!actor.scope_names.includes("seats:create") || !grant.scope_names.includes("seats:create")) return finish("scope_forbidden");
      if (recipient !== ctx.owner_user_id) {
        return finish("human_confirmation_required");
      }
      if (!grant.target_rules.recipient_connection_ids.includes(
        command.recipient_connection_id
      ) || !grant.target_rules.transports.includes(command.transport) || !command.worker_scope_names.every(
        (s) => grant.worker_scope_ceiling.includes(s) && ctx.human_worker_scopes.includes(s)
      )) return finish("recipient_forbidden");
      const live = Object.values(routine.invitations).filter(
        (i) => i.parent_admin_grant_id === grant.grant_id && i.invitation_kind === "agent" && i.revoked_at === null && i.accepted_at === null && i.expires_at > ctx.now
      ).length;
      if (!budget("live_agent_invitations", live) || ctx.live_agent_invitations_person >= ADMIN_EXISTING_RESOURCE_CEILINGS.joins_per_person || ctx.live_agent_invitations_workspace >= ADMIN_EXISTING_RESOURCE_CEILINGS.joins_per_workspace || command.seat_limit > ADMIN_INVITATION_AND_ATTEMPT_TTL.agent_seats || command.ttl_seconds < ADMIN_INVITATION_AND_ATTEMPT_TTL.agent_min_seconds || command.ttl_seconds > ADMIN_INVITATION_AND_ATTEMPT_TTL.agent_max_seconds) {
        return finish("invitation_limit_reached");
      }
    } else if (command.ttl_seconds > ADMIN_INVITATION_AND_ATTEMPT_TTL.member_seconds) return finish("invitation_ttl_invalid");
    const invitation_id = ctx.nextResourceId(), expires_at2 = Math.min(
      ctx.now + command.ttl_seconds * 1e3,
      grant.expires_at,
      grant.refresh_deadline
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
      expires_at: expires_at2,
      parent_admin_grant_id: grant.grant_id,
      delivery_state: "awaiting_authorization"
    });
    return finish(null);
  }
  if (command.kind === "admin_revoke_invitation" || command.kind === "admin_revoke_agent_invitation") {
    const invitation = routine.invitations[command.invitation_id];
    if (!invitation || invitation.workspace_id !== command.workspace_id || invitation.parent_admin_grant_id !== grant.grant_id || invitation.invitation_kind !== (command.kind === "admin_revoke_agent_invitation" ? "agent" : "member") || !grant.target_rules.recipient_user_ids.includes(
      invitation.recipient_user_id
    )) return finish("target_forbidden");
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
      reason_code: command.reason_code
    });
    return finish(null);
  }
  if (command.kind === "admin_revoke_seat" || command.kind === "admin_revoke_seat_credential") {
    const credentials = Object.values(routine.credentials).filter(
      (c) => c.principal_id === principal.principal_id && c.revoked_at === null
    );
    const target = ctx.target_credential;
    if (command.kind === "admin_revoke_seat_credential" && (!target || target.principal_id !== principal.principal_id || target.workspace_id !== command.workspace_id)) return finish("target_forbidden");
    if (command.kind === "admin_revoke_seat" && principal.revoked_at !== null || command.kind === "admin_revoke_seat_credential" && target.revoked_at !== null) return finish(null);
    const affected = command.kind === "admin_revoke_seat" ? [
      ...ctx.principal_lineage_ids,
      ...credentials.map((c) => c.worker_lineage_id)
    ] : [target.worker_lineage_id];
    workspaceEmit(
      command.kind === "admin_revoke_seat" ? "AgentPrincipalRevoked" : "AgentTokenRevoked",
      command.kind === "admin_revoke_seat" ? { principal_id: principal.principal_id, revoked_at: ctx.now } : { token_id: command.credential_id, revoked_at: ctx.now }
    );
    emit(
      command.kind === "admin_revoke_seat" ? "AdminSeatRevoked" : "AdminSeatCredentialRevoked",
      {
        principal_id: principal.principal_id,
        credential_id: command.kind === "admin_revoke_seat" ? null : command.credential_id,
        transport: principal.transport,
        affected_lineage_ids: [...new Set(affected)],
        revoked_at: ctx.now,
        reason_code: command.reason_code
      }
    );
    return finish(null);
  }
  if (command.kind !== "admin_provision_seat" && command.kind !== "admin_renew_seat" && command.kind !== "admin_replace_undelivered_seat_credential") return finish("human_confirmation_required");
  if (principal.transport !== "local") {
    return finish("hosted_runtime_authorization_required");
  }
  if (!grant.target_rules.recipient_connection_ids.includes(
    command.recipient_connection_id
  ) || ctx.delivery_connection_id !== command.recipient_connection_id) return finish("recipient_runtime_required");
  if (!budget("worker_credentials", spend.worker_credentials)) {
    return finish("credential_limit_reached");
  }
  const prior = ctx.target_credential;
  if (command.kind !== "admin_provision_seat") {
    const predecessorId = command.kind === "admin_renew_seat" ? command.predecessor_credential_id : command.credential_id;
    if (!prior || prior.credential_id !== predecessorId || prior.workspace_id !== command.workspace_id || prior.principal_id !== principal.principal_id || prior.recipient_connection_id !== command.recipient_connection_id || prior.revoked_at !== null || prior.superseded || prior.suspended || !prior.device_valid || prior.expires_at <= ctx.now || prior.parent_admin_grant_id !== null && prior.parent_admin_grant_id !== grant.grant_id) return finish("predecessor_unavailable");
    if (!Number.isSafeInteger(prior.successors_used) || prior.successors_used < 0 || !positive(prior.bearer_seconds) || !uuid(prior.run_id) || !uuid(prior.task_id) || !Number.isSafeInteger(prior.epoch) || prior.epoch < 0 || (prior.kind === "timeboxed" ? !positive(prior.max_successors) : prior.max_successors !== null || prior.horizon_expires_at !== null)) return finish("renewal_policy_invalid");
    if (!grant.renewal_limits.grant_kinds.includes(prior.kind) || !grant.renewal_limits.principal_ids.includes(prior.principal_id) && routine.seats[prior.principal_id]?.grant_id !== grant.grant_id) return finish("renewal_policy_forbidden");
    if (prior.kind === "timeboxed" && (prior.horizon_expires_at === null || prior.horizon_expires_at <= ctx.now || prior.horizon_expires_at - ctx.now > grant.renewal_limits.horizon_seconds * 1e3)) return finish("renewal_horizon_reached");
    if (command.kind === "admin_renew_seat" ? prior.first_used_at === null : prior.first_used_at !== null) return finish("credential_delivery_state_forbidden");
    if (spend.successors >= grant.renewal_limits.successors_per_grant || prior.successors_used >= Math.min(
      prior.max_successors ?? Infinity,
      grant.renewal_limits.successors_per_worker
    )) return finish("renewal_successors_exhausted");
  } else if (Object.values(routine.credentials).some(
    (c) => c.principal_id === principal.principal_id
  ) || Object.values(ctx.workspace.tokens).some(
    (t) => t.principal_id === principal.principal_id
  )) return finish("credential_already_issued");
  const requestedScopes = command.kind === "admin_replace_undelivered_seat_credential" ? prior.worker_scope_names : command.worker_scope_names;
  if (!requestedScopes.every(
    (s) => grant.worker_scope_ceiling.includes(s) && ctx.human_worker_scopes.includes(s) && (prior === null || prior.worker_scope_names.includes(s))
  )) return finish("worker_scope_forbidden");
  const seconds = command.kind === "admin_replace_undelivered_seat_credential" ? prior.bearer_seconds : command.bearer_seconds;
  if (!positive(seconds) || seconds > grant.renewal_limits.bearer_seconds || prior !== null && seconds > prior.bearer_seconds) return finish("renewal_policy_forbidden");
  if (command.kind === "admin_provision_seat" && (!grant.renewal_limits.grant_kinds.includes("timeboxed") || command.horizon_seconds > grant.renewal_limits.horizon_seconds || command.max_successors > grant.renewal_limits.successors_per_worker)) return finish("renewal_policy_forbidden");
  const credential_id = ctx.nextResourceId();
  const horizon = prior?.horizon_expires_at ?? Math.min(
    ctx.now + (command.kind === "admin_provision_seat" ? command.horizon_seconds : 0) * 1e3,
    grant.expires_at,
    grant.refresh_deadline
  );
  const expires_at = Math.min(
    ctx.now + seconds * 1e3,
    grant.expires_at,
    grant.refresh_deadline,
    prior?.kind === "standing" ? Infinity : horizon,
    command.kind === "admin_replace_undelivered_seat_credential" ? prior.expires_at : Infinity
  );
  const credential = {
    credential_id,
    workspace_id: command.workspace_id,
    principal_id: principal.principal_id,
    worker_lineage_id: prior?.worker_lineage_id ?? ctx.nextResourceId(),
    parent_admin_grant_id: prior ? prior.parent_admin_grant_id : grant.grant_id,
    recipient_connection_id: command.recipient_connection_id,
    worker_scope_names: [...requestedScopes],
    expires_at,
    horizon_expires_at: prior?.kind === "standing" ? null : horizon,
    bearer_seconds: seconds,
    max_successors: prior ? prior.max_successors : command.kind === "admin_provision_seat" ? command.max_successors : 0,
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
    device_id: prior?.device_id ?? ctx.nextResourceId()
  };
  if (command.kind === "admin_replace_undelivered_seat_credential") {
    workspaceEmit("AgentTokenRevoked", {
      token_id: prior.credential_id,
      revoked_at: ctx.now
    });
  }
  workspaceEmit("AgentTokenMinted", {
    token_id: credential_id,
    principal_id: principal.principal_id,
    run_id: credential.run_id,
    task_id: credential.task_id,
    epoch: credential.epoch,
    scopes: requestedScopes,
    issued_at: ctx.now,
    expires_at
  });
  emit(
    command.kind === "admin_provision_seat" ? "AdminSeatProvisioned" : command.kind === "admin_renew_seat" ? "AdminSeatRenewed" : "AdminSeatCredentialReplaced",
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
        bearer_seconds: seconds
      },
      dependent_on_admin_grant: credential.parent_admin_grant_id !== null,
      credential_expires_at: expires_at,
      remaining_budget: Math.min(
        grant.renewal_limits.successors_per_worker - credential.successors_used,
        grant.renewal_limits.successors_per_grant - spend.successors - (prior ? 1 : 0)
      ),
      delivery_state: "awaiting_delivery",
      policy_digest: ctx.request_digest,
      worker_policy_digest: ctx.request_digest
    }
  );
  return finish(null);
}
function reduceAdminRoutine(previous, event2) {
  const state = previous ?? emptyAdminRoutine(), p = event2.payload, id = event2.grant_id;
  const required = {
    AdminWorkspaceCreated: [
      "workspace_id",
      "name",
      "owner_user_id",
      "created_workspace_policy",
      "applied_scope_names",
      "created_at"
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
      "connection_attempt_id"
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
      "credential"
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
      "credential"
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
      "credential"
    ],
    AdminSeatRevoked: [
      "principal_id",
      "credential_id",
      "transport",
      "affected_lineage_ids",
      "revoked_at",
      "reason_code"
    ],
    AdminSeatCredentialRevoked: [
      "principal_id",
      "credential_id",
      "transport",
      "affected_lineage_ids",
      "revoked_at",
      "reason_code"
    ],
    AdminMemberInvited: [
      "invitation_id",
      "workspace_id",
      "recipient_ref",
      "role",
      "expires_at",
      "delivery_state",
      "recipient_user_id"
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
      "recipient_user_id"
    ],
    AdminInvitationRevoked: [
      "invitation_id",
      "invitation_kind",
      "workspace_id",
      "revoked_at",
      "reason_code"
    ]
  };
  if (!required[event2.type]?.every(
    (key2) => Object.hasOwn(p, key2)
  )) throw new Error("incomplete routine event");
  if (!id) throw new Error("routine event without grant");
  const spend = {
    ...state.spend[id] ?? {
      workspaces: 0,
      total_seats: 0,
      invitations: 0,
      worker_credentials: 0,
      successors: 0
    }
  };
  const next = {
    ...state,
    spend: { ...state.spend, [id]: spend },
    created_workspaces: { ...state.created_workspaces },
    seats: { ...state.seats },
    credentials: { ...state.credentials },
    invitations: { ...state.invitations }
  };
  switch (event2.type) {
    case "AdminWorkspaceCreated":
      spend.workspaces++;
      next.created_workspaces[String(p.workspace_id)] = {
        grant_id: id,
        scope_names: p.applied_scope_names
      };
      break;
    case "AdminSeatCreated":
      spend.total_seats++;
      next.seats[String(p.principal_id)] = {
        grant_id: id,
        workspace_id: String(p.workspace_id),
        revoked_at: null
      };
      break;
    case "AdminSeatProvisioned":
    case "AdminSeatRenewed":
    case "AdminSeatCredentialReplaced": {
      const c = p.credential;
      spend.worker_credentials++;
      if (event2.type !== "AdminSeatProvisioned") spend.successors++;
      next.credentials[c.credential_id] = c;
      const prior = next.credentials[String(p.predecessor_credential_id)];
      if (prior) {
        next.credentials[prior.credential_id] = {
          ...prior,
          superseded: true,
          revoked_at: event2.type === "AdminSeatCredentialReplaced" ? event2.occurred_at_server : prior.revoked_at
        };
      }
      break;
    }
    case "AdminSeatRevoked":
    case "AdminSeatCredentialRevoked":
      if (event2.type === "AdminSeatRevoked" && next.seats[String(p.principal_id)]) {
        next.seats[String(p.principal_id)] = {
          ...next.seats[String(p.principal_id)],
          revoked_at: event2.occurred_at_server
        };
      }
      for (const [key2, c] of Object.entries(next.credentials)) {
        if (c.principal_id === p.principal_id && (event2.type === "AdminSeatRevoked" || p.affected_lineage_ids.includes(c.worker_lineage_id))) {
          next.credentials[key2] = {
            ...c,
            revoked_at: event2.occurred_at_server
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
        invitation_kind: event2.type === "AdminMemberInvited" ? "member" : "agent",
        recipient_user_id: String(p.recipient_user_id),
        recipient_connection_id: p.recipient_connection_id,
        expires_at: Number(p.expires_at),
        accepted_at: null,
        revoked_at: null
      };
      break;
    case "AdminInvitationRevoked": {
      const i = next.invitations[String(p.invitation_id)];
      if (!i) throw new Error("unknown routine invitation");
      next.invitations[i.invitation_id] = {
        ...i,
        revoked_at: event2.occurred_at_server
      };
      break;
    }
  }
  return next;
}

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
  if (ADMIN_ROUTINE_EVENT_TYPES.includes(env3.type)) {
    if (!env3.grant_id || !env3.admin_identity_id || !env3.grant_manifest_digest || env3.actor_user !== null || env3.actor_agent_principal !== null) throw new StreamIntegrityError("invalid delegated workspace actor");
    return { ...prev, admin_routine: reduceAdminRoutine(prev.admin_routine, env3) };
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
  ADMIN_ACCESS_TTL_SECONDS,
  ADMIN_CONNECTION_ATTEMPTS_PER_GRANT,
  ADMIN_EVENT_TYPES,
  ADMIN_EXISTING_RESOURCE_CEILINGS,
  ADMIN_GRANT_TTL_SECONDS,
  ADMIN_INVITATIONS_PER_GRANT,
  ADMIN_INVITATION_AND_ATTEMPT_TTL,
  ADMIN_INVITATION_ISSUE_PER_DAY,
  ADMIN_ISSUANCE_CEILINGS,
  ADMIN_MUTATION_RATE_PER_HOUR,
  ADMIN_READ_RATE_PER_HOUR,
  ADMIN_REFRESH_MAX_LIFETIME_SECONDS,
  ADMIN_REFRESH_RATE_PER_HOUR,
  ADMIN_REGISTRY_VERSION,
  ADMIN_RENEWAL_CEILINGS,
  ADMIN_RESOURCE,
  ADMIN_ROUTINE_EVENT_TYPES,
  ADMIN_SCOPE_NAMES,
  ADMIN_SCOPE_REGISTRY,
  ADMIN_SEATS_PER_GRANT,
  ADMIN_UUID_RE,
  ADMIN_WORKER_CREDENTIAL_ISSUES_PER_GRANT,
  ADMIN_WORKER_RENEWAL_LIMITS,
  ADMIN_WORKSPACES_CREATED_PER_GRANT,
  ADMIN_WORKSPACE_CREATE_PER_DAY,
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
  adminExactKeys,
  adminGrantManifest,
  adminIds,
  adminManifestValid,
  adminRatePolicy,
  adminRecord,
  adminScopes,
  applyCommand,
  canonicalAdminJson,
  canonicalJson,
  canonicalPrincipal,
  compareHostedCheckCursor,
  decide,
  decideAdminAuthority,
  decideAdminRoutine,
  decideHostedAuthority,
  decideHostedCheck,
  decideWorkspace,
  emptyAdminAccount,
  emptyAdminRoutine,
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
  parseAdminRoutineCommand,
  planFileVersionWindow,
  publicHostedCommandForbidden,
  reduceAdminAuthority,
  reduceAdminRoutine,
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
