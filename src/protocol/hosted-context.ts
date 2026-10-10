// Portable hosted context allocation. The adapter supplies locked database facts
// and bounded random candidates; the core never reads a clock or generates IDs.
import { hostedSeatNameValid, HOSTED_MCP_SEAT_LIMIT } from './hosted-authority.js';

export const HOSTED_ACTIVE_CONTEXTS_PER_GRANT = 25;
export const HOSTED_ACTIVE_CONTEXTS_PER_WORKSPACE = 100;
export const HOSTED_CONTEXT_CREATIONS_PER_OWNER_DAY = 100;
export const HOSTED_CONTEXT_CREATIONS_PER_WORKSPACE_DAY = 500;
export const HOSTED_CONTEXT_KINDS = ['chat', 'task', 'scheduled', 'subagent'] as const;
export type HostedContextKind = typeof HOSTED_CONTEXT_KINDS[number];
export type HostedIdentityLifetime = 'durable' | 'ephemeral';
export interface HostedContextClaim {
  intent?: 'new' | 'continue'; name?: string; seat?: string;
  lifetime?: HostedIdentityLifetime; kind?: HostedContextKind; parent_context?: string;
}
export function hostedContextClaimValid(c: HostedContextClaim): boolean {
  if (c.intent !== undefined && c.intent !== 'new' && c.intent !== 'continue') return false;
  if (c.name !== undefined && (typeof c.name !== 'string' || !hostedSeatNameValid(c.name))) return false;
  if (c.seat !== undefined && (typeof c.seat !== 'string' || !/^seat_[A-Za-z0-9_-]{22,64}$/u.test(c.seat))) return false;
  if (c.kind !== undefined && !HOSTED_CONTEXT_KINDS.includes(c.kind)) return false;
  if (c.parent_context !== undefined && (typeof c.parent_context !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(c.parent_context))) return false;
  if (c.lifetime !== undefined && c.lifetime !== 'durable' && c.lifetime !== 'ephemeral') return false;
  if ((c.intent ?? 'new') === 'new') return c.seat === undefined && (c.lifetime !== 'durable' || c.name !== undefined);
  return c.lifetime === undefined && (c.seat !== undefined || c.name !== undefined)
    && (c.seat === undefined || (c.kind === undefined && c.parent_context === undefined));
}
export function hostedContextClocks(kind: HostedContextKind, now: number) {
  const hour = 3600000;
  const limits = { chat: [24 * hour, 30 * 24 * hour], task: [12 * hour, 7 * 24 * hour], scheduled: [hour / 2, 24 * hour], subagent: [hour / 4, 4 * hour] };
  const [idle, absolute] = limits[kind];
  return { created_at: now, last_business_at: now, idle_expires_at: now + idle, absolute_expires_at: now + absolute };
}
export function hostedContextLive(c: { closed_at: number | null; idle_expires_at: number | null; absolute_expires_at: number | null }, now: number): boolean {
  return c.closed_at === null && (c.idle_expires_at === null || now < c.idle_expires_at)
    && (c.absolute_expires_at === null || now < c.absolute_expires_at);
}
export function hostedSuffixName(base: string, suffix: string): string {
  if (typeof suffix !== 'string' || !/^[A-Z2-7]{4}$/u.test(suffix)) throw new Error('invalid hosted suffix candidate');
  return `${Array.from(base).slice(0, 75).join('')}-${suffix}`;
}
export interface HostedAllocationSeat {
  seat_id: string; principal_id: string; grant_id: string; owner_user_id: string;
  client_id: string; name: string; display_name: string; disambiguator: string | null;
  lifetime: HostedIdentityLifetime; live: boolean; hosted: boolean;
  predecessor_unavailable: boolean;
}
export interface HostedContextAllocationFacts {
  now: number; grant_id: string; owner_user_id: string; client_id: string;
  authorized: boolean; allocation_enabled: boolean; parent_valid: boolean;
  default_name: string; exact_seats: readonly HostedAllocationSeat[];
  // Each candidate's reservation has been measured under the workspace locks.
  names: readonly { name: string; reserved: boolean }[];
  active_grant: number; active_workspace: number; owner_day: number; workspace_day: number;
  succession_contexts: readonly { seat_id: string; active: number; workspace_excluded: number }[];
  durable_seats: number; durable_principals: number; retry_after_seconds: number;
}
export function hostedContextErrorMessage(error: string, canStartNew = true): string {
  if (error === 'identity_resume_unavailable' && !canStartNew) return 'This connection is unavailable. Reconnect before starting a new identity.';
  const messages: Record<string, string> = {
    identity_resume_unavailable: 'This connection cannot resume that identity. Start a separate identity for shared work.',
    identity_allocation_disabled: 'New chat identities are unavailable on this connection.',
    session_capacity_reached: 'Chat identity capacity is full. Close a context or wait, then try again.',
    name_allocation_busy: 'A separate name could not be allocated. Try again.',
    hosted_seat_limit_reached: 'This connection has reached its durable agent limit. Remove a durable agent, then try again.',
    principal_limit_reached: 'This workspace has reached its durable agent limit. Remove a durable agent, then try again.',
    context_expired: 'This chat identity expired. Start a new identity to continue; shared work is still here.',
    workspace_mismatch: 'This handle belongs to a different workspace. Use its workspace to continue.',
    context_closed: 'This chat identity was closed. Start a new identity to continue.',
    workspace_unavailable: 'This workspace is unavailable. Choose an authorized workspace to continue.',
    invalid_request: 'The identity request is invalid. Correct the arguments and try again.',
  };
  return messages[error] ?? 'This chat identity is unavailable.';
}
export type HostedContextAllocationDecision =
  | { ok: false; error: string; message: string; can_start_new: boolean; retry_after_seconds?: number }
  | { ok: true; outcome: 'created' | 'continued'; lifetime: HostedIdentityLifetime;
      name: string; display_name: string; disambiguator: string | null;
      name_adjusted: boolean; adjustment_reason: 'collision' | 'ephemeral_address' | null;
      kind: HostedContextKind; assurance: 'portable'; origin: 'new' | 'continue';
      clocks: ReturnType<typeof hostedContextClocks>; seat?: HostedAllocationSeat;
      grant_succession: boolean; predecessor_grant_id?: string; successor_grant_id?: string };

export function decideHostedContextAllocation(c: HostedContextClaim, f: HostedContextAllocationFacts): HostedContextAllocationDecision {
  const deny = (error: string, can_start_new = true): HostedContextAllocationDecision => ({ ok: false, error, message: hostedContextErrorMessage(error, can_start_new), can_start_new });
  if (!hostedContextClaimValid(c)) return deny('invalid_request', false);
  if (!f.authorized) return deny('identity_resume_unavailable', false);
  // Handles do not allocate. Phase 3 owns their lifetime/renewal transition.
  if (c.seat !== undefined) return deny('identity_resume_unavailable');
  if (!f.allocation_enabled) return deny('identity_allocation_disabled', false);
  if (c.parent_context !== undefined && !f.parent_valid) return deny('identity_resume_unavailable');
  const continuation = c.intent === 'continue';
  let seat: HostedAllocationSeat | undefined;
  let succession = false;
  const lifetime = continuation ? 'durable' : c.lifetime ?? 'ephemeral';
  if (continuation) {
    const candidates = f.exact_seats.filter(s => s.live && s.hosted && s.lifetime === 'durable'
      && s.owner_user_id === f.owner_user_id && s.client_id === f.client_id
      && s.name === c.name && (s.grant_id === f.grant_id || s.predecessor_unavailable));
    // An occupied local/other-owner/live other-grant name never redirects.
    if (candidates.length !== 1 || f.exact_seats.some(s => s.live && s.seat_id !== candidates[0].seat_id)) return deny('identity_resume_unavailable');
    seat = candidates[0]; succession = seat.grant_id !== f.grant_id;
  }
  const inherited = succession ? f.succession_contexts.find(c => c.seat_id === seat!.seat_id) : undefined;
  if (f.active_grant + (inherited?.active ?? 0) >= HOSTED_ACTIVE_CONTEXTS_PER_GRANT
    || f.active_workspace + (inherited?.workspace_excluded ?? 0) >= HOSTED_ACTIVE_CONTEXTS_PER_WORKSPACE
    || f.owner_day >= HOSTED_CONTEXT_CREATIONS_PER_OWNER_DAY || f.workspace_day >= HOSTED_CONTEXT_CREATIONS_PER_WORKSPACE_DAY) {
    return { ok: false, error: 'session_capacity_reached', message: hostedContextErrorMessage('session_capacity_reached'), can_start_new: true, retry_after_seconds: Math.max(1, f.retry_after_seconds) };
  }
  if (lifetime === 'durable' && (!continuation || succession) && f.durable_seats >= HOSTED_MCP_SEAT_LIMIT) return deny('hosted_seat_limit_reached');
  if (lifetime === 'durable' && !continuation && f.durable_principals >= 50) return deny('principal_limit_reached');
  const base = c.name ?? f.default_name;
  if (!hostedSeatNameValid(base)) return deny('invalid_request', false);
  const collision = f.names.find(n => n.name === base)?.reserved !== false;
  let name = seat?.name ?? base;
  let disambiguator = seat?.disambiguator ?? null;
  if (!continuation && (lifetime === 'ephemeral' || collision)) {
    const candidate = f.names.slice(1, 6).find(n => !n.reserved && hostedSeatNameValid(n.name)
      && typeof n.name === 'string' && /^[A-Z2-7]{4}$/u.test(n.name.slice(-4)) && n.name === hostedSuffixName(base, n.name.slice(-4)));
    if (!candidate) return { ok: false, error: 'name_allocation_busy', message: hostedContextErrorMessage('name_allocation_busy'), can_start_new: true, retry_after_seconds: 1 };
    name = candidate.name; disambiguator = name.slice(-4);
  }
  return { ok: true, outcome: continuation ? 'continued' : 'created', lifetime, name,
    display_name: seat?.display_name ?? base,
    disambiguator, name_adjusted: !continuation && name !== base,
    adjustment_reason: continuation || name === base ? null : collision ? 'collision' : 'ephemeral_address',
    kind: c.kind ?? 'chat', assurance: 'portable', origin: continuation ? 'continue' : 'new',
    clocks: hostedContextClocks(c.kind ?? 'chat', f.now), seat,
    grant_succession: succession, ...(succession ? { predecessor_grant_id: seat!.grant_id, successor_grant_id: f.grant_id } : {}) };
}

/** Inputs are current, transaction-locked authority and database time. */
export interface HostedContextState {
  kind: HostedContextKind; origin: 'new' | 'continue' | 'legacy';
  lifetime: HostedIdentityLifetime; created_at: number; last_business_at: number;
  idle_expires_at: number | null; absolute_expires_at: number | null;
  closed_at: number | null; close_reason: string | null;
}
export type HostedContextUse = 'inspect' | 'poll' | 'business' | 'ack' | 'close' | 'expire';
export type HostedContextTransition =
  | { ok: false; error: 'identity_resume_unavailable' | 'context_expired' | 'context_closed'; message: string; can_start_new: boolean }
  | { ok: true; state: HostedContextState; changed: boolean; retire_principal: boolean };
export function decideHostedContextLifecycle(
  state: HostedContextState, facts: { now: number; authorized: boolean; use: HostedContextUse; replay?: boolean; fresh_ack?: boolean },
): HostedContextTransition {
  const deny = (error: 'identity_resume_unavailable' | 'context_expired' | 'context_closed', can_start_new = true): HostedContextTransition =>
    ({ ok: false, error, message: hostedContextErrorMessage(error, can_start_new), can_start_new });
  if (!facts.authorized) return deny('identity_resume_unavailable', false);
  const live = hostedContextLive(state, facts.now);
  if (facts.use === 'close' || facts.use === 'expire') {
    if (state.closed_at !== null || (facts.use === 'expire' && live)) return { ok: true, state, changed: false, retire_principal: false };
    const next = { ...state, closed_at: facts.now, close_reason: facts.use === 'expire' ? 'expired' : 'closed' };
    return { ok: true, state: next, changed: true, retire_principal: state.lifetime === 'ephemeral' };
  }
  if (state.closed_at !== null) return deny(state.close_reason === 'expired' ? 'context_expired' : 'context_closed');
  if (!live) return deny('context_expired');
  const renew = !facts.replay && (facts.use === 'business' || (facts.use === 'ack' && facts.fresh_ack === true));
  if (!renew) return { ok: true, state, changed: false, retire_principal: false };
  const idle = state.origin === 'legacy' ? null : hostedContextClocks(state.kind, facts.now).idle_expires_at;
  const next = { ...state, last_business_at: facts.now, idle_expires_at: idle };
  return { ok: true, state: next, changed: facts.now !== state.last_business_at, retire_principal: false };
}

/** Caller request IDs accept only letters, digits, underscore and hyphen.
 * Colon separates internal attribution receipts from every caller ledger key. */
export function hostedContextReceiptId(requestId: string): string {
  return `context:${requestId}`;
}

/** Only the owning handler supplies these statuses and stable codes. Never
 * copy other fields (content, arguments, identity names or handles) to audit. */
export const HOSTED_CONTEXT_AUDIT_MAPPING = {
  accepted: 'accepted', committed: 'accepted', ok: 'accepted', pending: 'accepted', released: 'accepted',
  conflict: 'conflict', refused: 'domain', rejected: 'domain', unknown: 'domain', idempotent: 'replayed',
} as const;
export function hostedContextAuditResult(
  result: { status: number; body: Record<string, unknown> }, replayed = false,
): { outcome: 'accepted' | 'replayed' | 'authz' | 'domain' | 'conflict'; reason: string | null } {
  const status = String(result.body.status);
  const mapped = HOSTED_CONTEXT_AUDIT_MAPPING[status as keyof typeof HOSTED_CONTEXT_AUDIT_MAPPING];
  const outcome = replayed ? 'replayed' : mapped ?? (result.status < 300 && !result.body.error ? 'accepted' : 'authz');
  const candidate = result.body.reason ?? result.body.error;
  const reason = typeof candidate === 'string' && /^[a-z][a-z0-9_]{1,79}$/u.test(candidate)
    && !/^seat_[A-Za-z0-9_-]{22,64}$/u.test(candidate) ? candidate : null;
  return { outcome, reason };
}
