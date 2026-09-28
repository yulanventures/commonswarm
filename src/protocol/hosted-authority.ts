// Pure hosted-MCP authority core. The database adapter supplies only durable,
// transaction-locked facts; this module decides transitions and emits the
// reducer-complete events that the adapter appends with their workspace stream.

import { Actor, EventEnvelope, SCHEMA_VERSION } from './events.js';

export const HOSTED_MCP_RESOURCE = 'https://mcp.commonswarm.com/mcp';
export const HOSTED_MCP_SEAT_LIMIT = 10;
export const HOSTED_SEAT_NAME_TAKEN = {
  code: 'hosted_seat_name_taken',
  message: 'That name is taken in this workspace; choose another.',
} as const;

const PUBLIC_HOSTED_ONLY_COMMANDS = new Set([
  'begin_hosted_mcp_grant',
  'consent_hosted_mcp_workspace',
  'activate_hosted_mcp_grant',
  'claim_hosted_seat',
  'open_hosted_mcp_check_batch',
  'ack_hosted_mcp_check_batch',
]);

/** Public HTTP must stop these before credential classification or GoTrue. */
export function publicHostedCommandForbidden(kind: string): boolean {
  return PUBLIC_HOSTED_ONLY_COMMANDS.has(kind);
}

export type HostedCredentialKind = 'human' | 'hosted_grant' | 'hosted_seat';

export type HostedAuthorityCommand =
  | {
      kind: 'begin_hosted_mcp_grant';
      grant_id: string;
      provider_grant_id: string;
      owner_user_id: string;
      home_workspace_id: string;
      client_id: string;
      resource: string;
      selected_workspace_ids: readonly string[];
      manifest_digest: string;
      interaction_ref: string;
    }
  | {
      kind: 'consent_hosted_mcp_workspace';
      grant_id: string;
      workspace_id: string;
      owner_user_id: string;
      manifest_digest: string;
      consent_receipt_id: string;
    }
  | { kind: 'activate_hosted_mcp_grant'; grant_id: string }
  | { kind: 'revoke_hosted_mcp_grant'; grant_id: string }
  | { kind: 'revoke_hosted_mcp_seat'; grant_id: string; seat_id: string }
  | {
      kind: 'claim_hosted_seat';
      grant_id: string;
      seat_id: string;
      handle: string;
      principal_id: string;
      workspace_id: string;
      owner_user_id: string;
      name: string;
    };

export type HostedAuthorityEventType =
  | 'HostedMcpGrantBegun'
  | 'HostedMcpWorkspaceConsented'
  | 'HostedMcpGrantActivated'
  | 'HostedMcpGrantRevoked'
  | 'HostedMcpSeatClaimed'
  | 'HostedMcpSeatRevoked';

export type HostedAuthorityEvent = EventEnvelope<
  Record<string, unknown>,
  HostedAuthorityEventType
>;

export interface HostedGrantFacts {
  grant_id: string;
  provider_grant_id: string;
  owner_user_id: string;
  home_workspace_id: string;
  client_id: string;
  resource: string;
  state: 'pending' | 'active' | 'revoked';
  manifest_digest: string;
  interaction_ref: string;
  selected_workspace_ids: readonly string[];
  consented_workspace_ids: readonly string[];
}

export interface HostedSeatFacts {
  seat_id: string;
  grant_id: string;
  workspace_id: string;
  owner_user_id: string;
  principal_id: string;
  name: string;
  handle: string;
  transport: 'hosted_mcp';
  turn_only: true;
  created_at: number;
  revoked_at: number | null;
  handle_revoked_at: number | null;
  principal_revoked_at: number | null;
}

export interface HostedAuthorityFacts {
  grant: HostedGrantFacts | null;
  seat: HostedSeatFacts | null;
  owner_is_live_member: boolean;
  workspace_archived: boolean;
  workspace_consented: boolean;
  all_required_consents: boolean;
  all_required_memberships: boolean;
  exact_name_principal_ids: readonly string[];
  live_seat_count: number;
}

export interface HostedAuthorityState {
  grants: Record<string, {
    grant_id: string;
    owner_user_id: string;
    home_workspace_id: string;
    provider_grant_id: string;
    client_id: string;
    resource: string;
    selected_workspace_ids: readonly string[];
    manifest_digest: string;
    interaction_ref: string;
    state: 'pending' | 'active' | 'revoked';
    created_at: number;
    activated_at: number | null;
    revoked_at: number | null;
  }>;
  consents: Record<string, {
    grant_id: string;
    workspace_id: string;
    owner_user_id: string;
    manifest_digest: string;
    consent_receipt_id: string;
    consented_at: number;
    revoked_at: number | null;
  }>;
  seats: Record<string, HostedSeatFacts>;
  principals: Record<string, {
    principal_id: string;
    workspace_id: string;
    owner_user_id: string;
    name: string;
    transport: 'hosted_mcp';
    turn_only: true;
    created_at: number;
    revoked_at: number | null;
  }>;
}

export interface DecideHostedAuthorityCtx {
  now: number;
  actor: Actor;
  credential_kind: HostedCredentialKind;
  command_id: string;
  workspace_id: string;
  stream_id: string;
  nextSeq(): number;
  nextEventId(): string;
}

export type HostedAuthorityDecision =
  | { ok: true; events: HostedAuthorityEvent[]; reuse?: HostedSeatFacts }
  | {
      ok: false;
      class: 'authz' | 'domain';
      reason: string;
      detail: string;
      events: HostedAuthorityEvent[];
    };

const HUMAN_COMMANDS = new Set<HostedAuthorityCommand['kind']>([
  'begin_hosted_mcp_grant',
  'consent_hosted_mcp_workspace',
  'activate_hosted_mcp_grant',
  'revoke_hosted_mcp_grant',
  'revoke_hosted_mcp_seat',
]);

const HOSTED_SEAT_CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/u;

/** The SQL CHECK mirrors this contract: PostgreSQL btrim removes U+0020. */
export function hostedSeatNameValid(value: unknown): value is string {
  return typeof value === 'string'
    && Array.from(value).length >= 1
    && Array.from(value).length <= 80
    && value === value.replace(/^ +| +$/gu, '')
    && !HOSTED_SEAT_CONTROL_RE.test(value);
}

function event(
  ctx: DecideHostedAuthorityCtx,
  type: HostedAuthorityEventType,
  payload: Record<string, unknown>,
): HostedAuthorityEvent {
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
    payload,
  };
}

function refuse(
  className: 'authz' | 'domain',
  reason: string,
  detail: string,
): HostedAuthorityDecision {
  return { ok: false, class: className, reason, detail, events: [] };
}

/**
 * Decide one hosted authority transition. Cross-workspace workflow state is
 * deliberately supplied as facts: one invocation addresses exactly the stream
 * named by ctx and never emits into a second workspace.
 */
export function decideHostedAuthority(
  command: HostedAuthorityCommand,
  facts: HostedAuthorityFacts,
  ctx: DecideHostedAuthorityCtx,
): HostedAuthorityDecision {
  if (command.kind === 'claim_hosted_seat') {
    if (ctx.credential_kind !== 'hosted_grant') {
      return refuse('authz', 'credential_kind_forbidden', 'claim_hosted_seat requires a hosted grant credential');
    }
  } else if (HUMAN_COMMANDS.has(command.kind) && ctx.credential_kind !== 'human') {
    return refuse('authz', 'credential_kind_forbidden', 'hosted connection management requires a human credential');
  }

  if (command.kind === 'begin_hosted_mcp_grant') {
    if (ctx.actor.user !== command.owner_user_id) {
      return refuse('authz', 'hosted_grant_not_owned', 'a person may begin only their own hosted grant');
    }
    if (facts.grant !== null) return refuse('domain', 'hosted_grant_exists', 'hosted grant already exists');
    if (command.home_workspace_id !== ctx.workspace_id) {
      return refuse('authz', 'workspace_mismatch', 'grant creation must address its home workspace');
    }
    if (!facts.owner_is_live_member || facts.workspace_archived) {
      return refuse('authz', 'membership_required', 'grant owner is not a live member of the home workspace');
    }
    const selected = [...new Set(command.selected_workspace_ids)];
    if (selected.length !== command.selected_workspace_ids.length ||
        selected.length < 1 || selected.length > 100 ||
        !selected.includes(command.home_workspace_id)) {
      return refuse('domain', 'hosted_manifest_invalid', 'hosted grant workspace manifest is invalid');
    }
    if (command.resource !== HOSTED_MCP_RESOURCE) {
      return refuse('domain', 'resource_mismatch', 'hosted grant resource is not supported');
    }
    return { ok: true, events: [event(ctx, 'HostedMcpGrantBegun', { ...command, created_at: ctx.now })] };
  }

  const grant = facts.grant;
  if (grant === null || grant.grant_id !== command.grant_id) {
    return refuse('authz', 'hosted_grant_unavailable', 'hosted grant is unavailable');
  }

  if (command.kind === 'consent_hosted_mcp_workspace') {
    if (grant.state !== 'pending' || command.workspace_id !== ctx.workspace_id) {
      return refuse('domain', 'hosted_grant_not_pending', 'workspace consent requires a pending grant');
    }
    if (ctx.actor.user !== grant.owner_user_id ||
        command.owner_user_id !== grant.owner_user_id ||
        command.manifest_digest !== grant.manifest_digest ||
        !grant.selected_workspace_ids.includes(ctx.workspace_id)) {
      return refuse('authz', 'manifest_mismatch', 'workspace is not bound to this grant manifest');
    }
    if (!facts.owner_is_live_member || facts.workspace_archived) {
      return refuse('authz', 'membership_required', 'grant owner is not a live member of this workspace');
    }
    if (facts.workspace_consented) return { ok: true, events: [] };
    return { ok: true, events: [event(ctx, 'HostedMcpWorkspaceConsented', { ...command, consented_at: ctx.now })] };
  }

  if (command.kind === 'activate_hosted_mcp_grant') {
    if (ctx.workspace_id !== grant.home_workspace_id) {
      return refuse('authz', 'workspace_mismatch', 'grant activation must address its home workspace');
    }
    if (ctx.actor.user !== grant.owner_user_id) {
      return refuse('authz', 'hosted_grant_not_owned', 'a person may activate only their own hosted grant');
    }
    if (!facts.all_required_consents || !facts.all_required_memberships ||
        !facts.owner_is_live_member || facts.workspace_archived) {
      return refuse('domain', 'hosted_consent_incomplete', 'Every selected workspace must consent before activation.');
    }
    if (grant.state === 'active') return { ok: true, events: [] };
    if (grant.state !== 'pending') {
      return refuse('domain', 'hosted_consent_incomplete', 'Every selected workspace must consent before activation.');
    }
    return { ok: true, events: [event(ctx, 'HostedMcpGrantActivated', { grant_id: grant.grant_id, activated_at: ctx.now })] };
  }

  if (command.kind === 'revoke_hosted_mcp_grant') {
    if (ctx.actor.user !== grant.owner_user_id || ctx.workspace_id !== grant.home_workspace_id) {
      return refuse('authz', 'hosted_grant_not_owned', 'a person may revoke only their own hosted grant');
    }
    if (grant.state === 'revoked') return { ok: true, events: [] };
    return { ok: true, events: [event(ctx, 'HostedMcpGrantRevoked', { grant_id: grant.grant_id, revoked_at: ctx.now })] };
  }

  if (command.kind === 'revoke_hosted_mcp_seat') {
    const seat = facts.seat;
    if (seat === null || seat.grant_id !== grant.grant_id || seat.workspace_id !== ctx.workspace_id) {
      return refuse('authz', 'hosted_seat_unavailable', 'hosted seat is unavailable');
    }
    if (ctx.actor.user !== grant.owner_user_id) {
      return refuse('authz', 'hosted_seat_not_owned', 'a person may revoke only their own hosted seat');
    }
    if (seat.revoked_at !== null) return { ok: true, events: [] };
    return { ok: true, events: [event(ctx, 'HostedMcpSeatRevoked', {
      grant_id: grant.grant_id,
      seat_id: seat.seat_id,
      principal_id: seat.principal_id,
      revoked_at: ctx.now,
    })] };
  }

  if (grant.state !== 'active' || !facts.workspace_consented ||
      !facts.owner_is_live_member || facts.workspace_archived) {
    return refuse('authz', 'hosted_grant_unavailable', 'hosted grant is not active for this workspace');
  }
  if (command.owner_user_id !== grant.owner_user_id || command.workspace_id !== ctx.workspace_id) {
    return refuse('authz', 'hosted_grant_binding_mismatch', 'seat claim does not match the grant binding');
  }
  if (!hostedSeatNameValid(command.name)) {
    return refuse('domain', 'hosted_seat_name_invalid', 'Seat names must be 1 to 80 characters, have no leading or trailing spaces, and contain no control characters.');
  }
  if (facts.seat !== null) {
    const seat = facts.seat;
    if (seat.revoked_at !== null || seat.handle_revoked_at !== null ||
        seat.principal_revoked_at !== null || seat.transport !== 'hosted_mcp' ||
        seat.turn_only !== true) {
      return refuse('domain', 'hosted_seat_revoked', 'A revoked hosted seat cannot be restored; choose another name.');
    }
    if (facts.exact_name_principal_ids.length !== 1 ||
        facts.exact_name_principal_ids[0] !== seat.principal_id) {
      return refuse('domain', HOSTED_SEAT_NAME_TAKEN.code, HOSTED_SEAT_NAME_TAKEN.message);
    }
    return { ok: true, events: [], reuse: seat };
  }
  if (facts.exact_name_principal_ids.length !== 0) {
    return refuse('domain', HOSTED_SEAT_NAME_TAKEN.code, HOSTED_SEAT_NAME_TAKEN.message);
  }
  if (facts.live_seat_count >= HOSTED_MCP_SEAT_LIMIT) {
    return refuse('domain', 'hosted_seat_limit_reached', `This connection already has ${HOSTED_MCP_SEAT_LIMIT} live seats.`);
  }
  return { ok: true, events: [event(ctx, 'HostedMcpSeatClaimed', {
    ...command,
    transport: 'hosted_mcp',
    turn_only: true,
    created_at: ctx.now,
  })] };
}

function requiredPayload(
  event: HostedAuthorityEvent,
  keys: readonly string[],
): Record<string, unknown> {
  const payload = event.payload;
  for (const key of keys) {
    if (payload[key] === undefined) {
      throw new Error(`event "${event.type}" at seq ${event.seq} is missing payload field "${key}"`);
    }
  }
  return payload;
}

/** Fold one workspace stream's hosted authority events deterministically. */
export function reduceHostedAuthority(
  previous: HostedAuthorityState | null,
  event: HostedAuthorityEvent,
): HostedAuthorityState {
  if (event.schema_version !== SCHEMA_VERSION) {
    throw new Error(`event "${event.type}" has unsupported schema version`);
  }
  const state: HostedAuthorityState = previous ?? {
    grants: {}, consents: {}, seats: {}, principals: {},
  };
  if (event.type === 'HostedMcpGrantBegun') {
    const p = requiredPayload(event, [
      'grant_id', 'provider_grant_id', 'owner_user_id', 'home_workspace_id',
      'client_id', 'resource', 'selected_workspace_ids', 'manifest_digest',
      'interaction_ref', 'created_at',
    ]);
    const id = String(p.grant_id);
    if (state.grants[id]) throw new Error(`duplicate hosted grant "${id}"`);
    return { ...state, grants: { ...state.grants, [id]: {
      grant_id: id,
      provider_grant_id: String(p.provider_grant_id),
      owner_user_id: String(p.owner_user_id),
      home_workspace_id: String(p.home_workspace_id),
      client_id: String(p.client_id),
      resource: String(p.resource),
      selected_workspace_ids: [...p.selected_workspace_ids as string[]],
      manifest_digest: String(p.manifest_digest),
      interaction_ref: String(p.interaction_ref),
      state: 'pending',
      created_at: Number(p.created_at),
      activated_at: null,
      revoked_at: null,
    } } };
  }
  if (event.type === 'HostedMcpWorkspaceConsented') {
    const p = requiredPayload(event, [
      'grant_id', 'workspace_id', 'owner_user_id', 'consent_receipt_id', 'consented_at',
      'manifest_digest',
    ]);
    const key = `${String(p.grant_id)}:${String(p.workspace_id)}`;
    if (state.consents[key]) throw new Error(`duplicate hosted workspace consent "${key}"`);
    return { ...state, consents: { ...state.consents, [key]: {
      grant_id: String(p.grant_id),
      workspace_id: String(p.workspace_id),
      owner_user_id: String(p.owner_user_id),
      manifest_digest: String(p.manifest_digest),
      consent_receipt_id: String(p.consent_receipt_id),
      consented_at: Number(p.consented_at),
      revoked_at: null,
    } } };
  }
  if (event.type === 'HostedMcpGrantActivated' || event.type === 'HostedMcpGrantRevoked') {
    const p = requiredPayload(event, [
      'grant_id', event.type === 'HostedMcpGrantActivated' ? 'activated_at' : 'revoked_at',
    ]);
    const id = String(p.grant_id);
    const grant = state.grants[id];
    if (!grant) throw new Error(`unknown hosted grant "${id}"`);
    return { ...state, grants: { ...state.grants, [id]: event.type === 'HostedMcpGrantActivated'
      ? { ...grant, state: 'active', activated_at: Number(p.activated_at), revoked_at: null }
      : { ...grant, state: 'revoked', revoked_at: Number(p.revoked_at) }
    } };
  }
  if (event.type === 'HostedMcpSeatClaimed') {
    const p = requiredPayload(event, [
      'seat_id', 'grant_id', 'workspace_id', 'owner_user_id', 'principal_id',
      'name', 'handle', 'created_at', 'transport', 'turn_only',
    ]);
    const id = String(p.seat_id);
    if (state.seats[id]) throw new Error(`duplicate hosted seat "${id}"`);
    if (p.transport !== 'hosted_mcp' || p.turn_only !== true) {
      throw new Error('hosted seat event must be hosted_mcp and turn_only');
    }
    const principalId = String(p.principal_id);
    const seat: HostedSeatFacts = {
      seat_id: id,
      grant_id: String(p.grant_id),
      workspace_id: String(p.workspace_id),
      owner_user_id: String(p.owner_user_id),
      principal_id: principalId,
      name: String(p.name),
      handle: String(p.handle),
      transport: 'hosted_mcp',
      turn_only: true,
      created_at: Number(p.created_at),
      revoked_at: null,
      handle_revoked_at: null,
      principal_revoked_at: null,
    };
    return {
      ...state,
      seats: { ...state.seats, [id]: seat },
      principals: { ...state.principals, [principalId]: {
        principal_id: principalId,
        workspace_id: seat.workspace_id,
        owner_user_id: seat.owner_user_id,
        name: seat.name,
        transport: 'hosted_mcp',
        turn_only: true,
        created_at: seat.created_at,
        revoked_at: null,
      } },
    };
  }
  const p = requiredPayload(event, ['seat_id', 'revoked_at']);
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
        principal_revoked_at: revokedAt,
      },
    },
    principals: {
      ...state.principals,
      [seat.principal_id]: { ...principal, revoked_at: revokedAt },
    },
  };
}

export function reduceHostedAuthorityStream(
  events: readonly HostedAuthorityEvent[],
): HostedAuthorityState {
  let state: HostedAuthorityState | null = null;
  let lastSeq = -Infinity;
  for (const event of events) {
    if (event.seq <= lastSeq) throw new Error('hosted authority events are out of order');
    state = reduceHostedAuthority(state, event);
    lastSeq = event.seq;
  }
  return state ?? { grants: {}, consents: {}, seats: {}, principals: {} };
}
