import {
  ADMIN_ACCESS_TTL_SECONDS, ADMIN_RESOURCE, adminManifestValid, adminScopes,
  ADMIN_READ_RATE_PER_HOUR, ADMIN_MUTATION_RATE_PER_HOUR, ADMIN_REFRESH_RATE_PER_HOUR,
  canonicalAdminJson, type AdminManifest, type AdminScope,
} from './admin-policy.js';

export type AdminActor =
  | { kind: 'human'; user_id: string; session_binding: string }
  | { kind: 'delegated_admin'; admin_identity_id: string; grant_id: string; connection_id: string; scope_names: AdminScope[]; access_expires_at: number; resource: string }
  | { kind: 'credential_runtime'; connection_id: string; client_id: string; resource: string }
  | { kind: 'system' }
  | { kind: 'worker' | 'hosted_seat' };
export interface AdminConsent {
  consent_receipt_id: string; owner_user_id: string; session_binding: string;
  manifest_digest: string; manifest: AdminManifest; full_account_selected: boolean;
  expires_at: number; consumed_at: number | null;
}
export interface AdminGrant extends AdminManifest {
  grant_id: string; owner_user_id: string; consent_receipt_id: string; manifest_digest: string;
  created_at: number; state: 'active' | 'suspended' | 'revoked' | 'expired';
  suspended_at: number | null; revoked_at: number | null; reason_code: string | null;
  withdrawn_workspace_ids: string[];
}
export interface AdminCredentialLineage {
  credential_lineage_id: string; grant_id: string; generation: number;
  scope_names: AdminScope[]; access_expires_at: number; refresh_deadline: number;
  state: 'active' | 'revoked'; delivery_state: 'awaiting_delivery';
}
export interface AdminAccountState {
  grants: Record<string, AdminGrant>; consents: Record<string, AdminConsent>;
  lineages: Record<string, AdminCredentialLineage>;
  rate_buckets: Record<string, { hour_start: number; attempts: number }>;
}
export const ADMIN_EVENT_TYPES = [
  'AdminConsentPrepared', 'AdminDelegationGranted', 'AdminDelegationNarrowed',
  'AdminDelegationRevoked', 'AdminDelegationSuspended', 'AdminDelegationExpired',
  'AdminWorkspaceAccessWithdrawn', 'AdminCredentialIssued', 'AdminCredentialRotated',
  'AdminCredentialReplayDetected', 'AdminMetadataRead', 'AdminActionRecorded',
] as const;
export type AdminEventType = typeof ADMIN_EVENT_TYPES[number];
export interface AdminAccountEvent {
  stream_kind: 'account'; owner_user_id: string; stream_id: string; seq: number;
  event_id: string; command_id: string; type: AdminEventType; schema_version: 1;
  actor_user: string | null; actor_agent_principal: null; actor_run: null;
  admin_identity_id: string | null; grant_id: string | null; grant_manifest_digest: string | null;
  occurred_at_server: number; payload: Record<string, unknown>;
}
export type AdminCommand =
  | { kind: 'prepare_admin_consent'; consent: AdminConsent }
  | { kind: 'grant_admin_delegation'; grant_id: string; consent_receipt_id: string; replaces_grant_id: string | null }
  | { kind: 'narrow_admin_delegation'; grant_id: string; manifest: AdminManifest; manifest_digest: string; consent_receipt_id: string }
  | { kind: 'revoke_admin_delegation' | 'suspend_admin_delegation' | 'surrender_admin_delegation'; grant_id: string; reason_code: string }
  | { kind: 'expire_admin_delegation'; grant_id: string }
  | { kind: 'withdraw_admin_workspace_access'; grant_id: string; workspace_id: string; reason_code: string }
  | { kind: 'issue_admin_credential'; grant_id: string; credential_lineage_id: string }
  | { kind: 'rotate_admin_credential' | 'record_admin_credential_replay'; grant_id: string; credential_lineage_id: string; generation: number; scope_names: AdminScope[] }
  | { kind: 'admin_read_metadata'; grant_id: string; resource_kind: 'grant'; workspace_id: string | null };
export interface AdminDecisionContext {
  actor: AdminActor; owner_user_id: string; now: number; command_id: string;
  stream_id: string; request_digest: string; nextSeq(): number; nextEventId(): string;
  // Transaction-time facts, never supplied by the external command body.
  current_workspace_rights: boolean; withdrawing_workspace_owner: boolean;
  target_workspace_owned_by_grantor: boolean;
  presenting_refresh_generation: number | null; presenting_refresh_lineage_id: string | null;
}
export interface AdminDecision { ok: boolean; reason: string | null; events: AdminAccountEvent[] }
export function emptyAdminAccount(): AdminAccountState { return { grants: {}, consents: {}, lineages: {}, rate_buckets: {} }; }

/** Shared counter keys and ceilings, including identifiable refused attempts. */
export function adminRatePolicy(actor: AdminActor, grant: AdminGrant, action: string, workspaceId: string | null, lineageId: string | null, requestedGrantId: string | null): { key: string; limit: number }[] {
  if (actor.kind === 'human' || actor.kind === 'system' ||
      (action === 'surrender_admin_delegation' && actor.kind === 'delegated_admin' && actor.grant_id === grant.grant_id && requestedGrantId === actor.grant_id)) return [];
  if (actor.kind === 'credential_runtime' && lineageId !== null) return [
    { key: `refresh:lineage:${lineageId}`, limit: ADMIN_REFRESH_RATE_PER_HOUR },
    { key: `refresh:connection:${grant.connection_id}`, limit: ADMIN_REFRESH_RATE_PER_HOUR },
  ];
  const kind = action === 'admin_read_metadata' ? 'read' : 'mutation';
  const limits = kind === 'read' ? ADMIN_READ_RATE_PER_HOUR : ADMIN_MUTATION_RATE_PER_HOUR;
  return [
    { key: `${kind}:grant:${grant.grant_id}`, limit: limits.lineage },
    { key: `${kind}:connection:${grant.connection_id}`, limit: limits.connection },
    { key: `${kind}:account:${grant.owner_user_id}`, limit: limits.account },
    ...(workspaceId === null || !grant.workspace_ids.includes(workspaceId) ? [] : [{ key: `${kind}:workspace:${workspaceId}`, limit: limits.workspace }]),
  ];
}

function subset<T>(a: readonly T[], b: readonly T[]): boolean { return a.every(x => b.includes(x)); }
function narrowing(next: AdminManifest, prior: AdminGrant, now: number): boolean {
  // A full-account grant can narrow to granular. No new future-space coverage.
  if (!adminManifestValid(next, now, false) || next.admin_identity_id !== prior.admin_identity_id ||
      next.connection_id !== prior.connection_id || next.client_id !== prior.client_id ||
      next.resource !== prior.resource || next.registry_version !== prior.registry_version ||
      (prior.mode === 'granular' && next.mode !== 'granular') ||
      next.expires_at > prior.expires_at || next.refresh_deadline !== prior.refresh_deadline ||
      !subset(next.scope_names, prior.scope_names) || !subset(next.workspace_ids, prior.workspace_ids) ||
      !subset(next.created_workspace_policy.scope_names, prior.created_workspace_policy.scope_names) ||
      !subset(next.worker_scope_ceiling, prior.worker_scope_ceiling)) return false;
  const a = next.target_rules, b = prior.target_rules;
  if (!subset(a.seat_ids, b.seat_ids) || !subset(a.recipient_user_ids, b.recipient_user_ids) ||
      !subset(a.recipient_connection_ids, b.recipient_connection_ids) || !subset(a.transports, b.transports) ||
      (a.own_seats && !b.own_seats) || (a.grant_created_seats && !b.grant_created_seats) ||
      !subset(next.renewal_limits.grant_kinds, prior.renewal_limits.grant_kinds) ||
      !subset(next.renewal_limits.principal_ids, prior.renewal_limits.principal_ids)) return false;
  for (const key of ['bearer_seconds', 'horizon_seconds', 'successors_per_worker', 'successors_per_grant'] as const) {
    if (next.renewal_limits[key] > prior.renewal_limits[key]) return false;
  }
  return Object.keys(next.issuance_limits).every(key => next.issuance_limits[key as keyof typeof next.issuance_limits] <= prior.issuance_limits[key as keyof typeof prior.issuance_limits]);
}

/** Account-only decisions. No routine admin operation is enabled by lane B. */
export function decideAdminAuthority(command: AdminCommand, state: AdminAccountState, ctx: AdminDecisionContext): AdminDecision {
  const events: AdminAccountEvent[] = [];
  const grant = 'grant_id' in command ? state.grants[command.grant_id] : undefined;
  let auditGrant = ctx.actor.kind === 'delegated_admin' ? state.grants[ctx.actor.grant_id] : grant;
  const auditId = ctx.nextEventId();
  const actor = ctx.actor;
  const buckets = auditGrant ? adminRatePolicy(actor, auditGrant, command.kind,
    'workspace_id' in command ? command.workspace_id : null,
    actor.kind === 'credential_runtime' && 'generation' in command ? command.credential_lineage_id : null,
    'grant_id' in command ? command.grant_id : null)
    .map(({ key, limit }) => {
      const prior = state.rate_buckets[key], hour_start = Math.floor(ctx.now / 3_600_000);
      return { key, limit, hour_start, attempts: prior?.hour_start === hour_start ? prior.attempts + 1 : 1 };
    }) : [];
  const emit = (type: AdminEventType, payload: Record<string, unknown>) => {
    const eventGrant = typeof payload.grant_id === 'string' ? state.grants[payload.grant_id] ?? auditGrant : auditGrant;
    const e: AdminAccountEvent = {
      stream_kind: 'account', owner_user_id: ctx.owner_user_id, stream_id: ctx.stream_id,
      seq: ctx.nextSeq(), event_id: ctx.nextEventId(), command_id: ctx.command_id,
      type, schema_version: 1, actor_user: actor.kind === 'human' ? actor.user_id : null,
      actor_agent_principal: null, actor_run: null,
      admin_identity_id: typeof payload.admin_identity_id === 'string' ? payload.admin_identity_id : eventGrant?.admin_identity_id ?? (actor.kind === 'delegated_admin' ? actor.admin_identity_id : null),
      grant_id: typeof payload.grant_id === 'string' ? payload.grant_id : 'grant_id' in command ? command.grant_id : null,
      grant_manifest_digest: typeof payload.manifest_digest === 'string' ? payload.manifest_digest : eventGrant?.manifest_digest ?? null,
      occurred_at_server: ctx.now, payload,
    };
    events.push(e); return e;
  };
  const finish = (reason: string | null): AdminDecision => {
    const related = events.map(e => e.event_id);
    emit('AdminActionRecorded', {
      audit_record_id: auditId, grant_id: auditGrant?.grant_id ?? ('grant_id' in command ? command.grant_id : null),
      admin_identity_id: auditGrant?.admin_identity_id ?? null, connection_id: auditGrant?.connection_id ?? null,
      action: command.kind, target_kind: 'admin_grant', target_id: auditGrant?.grant_id ?? null,
      workspace_id: 'workspace_id' in command ? command.workspace_id : null,
      manifest_digest: auditGrant?.manifest_digest ?? null, request_digest: ctx.request_digest,
      outcome: reason === null ? 'accepted' : 'refused', reason_code: reason,
      policy_check: { result: reason ?? 'passed', buckets: buckets.map(({ key, hour_start, attempts }) => ({ key, hour_start, attempts })) }, related_event_ids: related,
      next_action: reason === null ? 'none' : 'Ask the granting person to review this connection.',
      recovery_kind: reason === null ? 'none' : 'human',
    });
    return { ok: reason === null, reason, events };
  };
  const humanOwner = actor.kind === 'human' && actor.user_id === ctx.owner_user_id;
  if (actor.kind === 'worker' || actor.kind === 'hosted_seat') return finish('credential_kind_forbidden');
  const replayLineage = 'credential_lineage_id' in command ? state.lineages[command.credential_lineage_id] : undefined;
  const verifiedReplay = actor.kind === 'credential_runtime' && grant && replayLineage?.grant_id === grant.grant_id &&
    (command.kind === 'rotate_admin_credential' || command.kind === 'record_admin_credential_replay') &&
    ctx.presenting_refresh_lineage_id === command.credential_lineage_id && ctx.presenting_refresh_generation === command.generation && command.generation < replayLineage.generation &&
    actor.connection_id === grant.connection_id && actor.client_id === grant.client_id && actor.resource === ADMIN_RESOURCE;
  if (!verifiedReplay && buckets.some(bucket => !Number.isSafeInteger(bucket.attempts) || bucket.attempts < 1 || bucket.attempts > bucket.limit)) return finish('rate_limited');
  if (command.kind === 'prepare_admin_consent') {
    const c = command.consent;
    if (!humanOwner || actor.kind !== 'human' || c.owner_user_id !== ctx.owner_user_id || c.session_binding !== actor.session_binding) return finish('human_confirmation_required');
    if (!adminManifestValid(c.manifest, ctx.now) || c.consumed_at !== null ||
        c.expires_at <= ctx.now || c.expires_at > ctx.now + ADMIN_ACCESS_TTL_SECONDS * 1000 ||
        (c.manifest.mode === 'full_account' && !c.full_account_selected) || !ctx.current_workspace_rights || state.consents[c.consent_receipt_id]) return finish('consent_invalid');
    // Private session binding is a consent projection only, never an event payload.
    emit('AdminConsentPrepared', { consent_receipt_id: c.consent_receipt_id, owner_user_id: c.owner_user_id,
      manifest: c.manifest, manifest_digest: c.manifest_digest, full_account_selected: c.full_account_selected, expires_at: c.expires_at });
    return finish(null);
  }
  if (command.kind === 'grant_admin_delegation') {
    const c = state.consents[command.consent_receipt_id];
    if (!humanOwner || actor.kind !== 'human') return finish('human_confirmation_required');
    if (!c || c.owner_user_id !== ctx.owner_user_id || c.session_binding !== actor.session_binding ||
        c.consumed_at !== null || c.expires_at <= ctx.now || !adminManifestValid(c.manifest, ctx.now) ||
        (c.manifest.mode === 'full_account' && !c.full_account_selected) || !ctx.current_workspace_rights || state.grants[command.grant_id]) return finish('consent_invalid');
    const previous = command.replaces_grant_id === null ? null : state.grants[command.replaces_grant_id];
    if (Object.values(state.grants).some(g => g.connection_id === c.manifest.connection_id && g.state === 'active' && g.grant_id !== command.replaces_grant_id)) return finish('replacement_required');
    if (command.replaces_grant_id !== null && (!previous || previous.owner_user_id !== ctx.owner_user_id || previous.connection_id !== c.manifest.connection_id)) return finish('replacement_invalid');
    if (previous && (previous.state === 'active' || previous.state === 'suspended')) emit('AdminDelegationRevoked', terminalPayload(previous, state, ctx.now, 'replaced'));
    emit('AdminDelegationGranted', { ...c.manifest, grant_id: command.grant_id, owner_user_id: ctx.owner_user_id,
      consent_receipt_id: c.consent_receipt_id, manifest_digest: c.manifest_digest,
      replaces_grant_id: command.replaces_grant_id, created_at: ctx.now });
    auditGrant = { ...c.manifest, grant_id: command.grant_id, owner_user_id: ctx.owner_user_id,
      consent_receipt_id: c.consent_receipt_id, manifest_digest: c.manifest_digest, created_at: ctx.now,
      state: 'active', suspended_at: null, revoked_at: null, reason_code: null, withdrawn_workspace_ids: [] };
    return finish(null);
  }
  if (!grant || grant.owner_user_id !== ctx.owner_user_id) return finish('grant_unavailable');
  if (actor.kind === 'delegated_admin' && (actor.grant_id !== grant.grant_id || actor.admin_identity_id !== grant.admin_identity_id ||
      actor.connection_id !== grant.connection_id || actor.resource !== ADMIN_RESOURCE)) return finish('grant_binding_mismatch');
  if (actor.kind === 'delegated_admin' && (!adminScopes(actor.scope_names) || !subset(actor.scope_names, grant.scope_names))) return finish('scope_expansion_forbidden');
  if (command.kind === 'revoke_admin_delegation' || command.kind === 'suspend_admin_delegation' || command.kind === 'surrender_admin_delegation') {
    if (command.kind === 'surrender_admin_delegation' ? actor.kind !== 'delegated_admin' : !humanOwner && actor.kind !== 'system') return finish('human_confirmation_required');
    if (actor.kind === 'delegated_admin' && actor.access_expires_at <= ctx.now) return finish('credential_expired');
    if (grant.state === 'revoked' || grant.state === 'expired' || (grant.state === 'suspended' && command.kind === 'suspend_admin_delegation')) return finish(null);
    emit(command.kind === 'suspend_admin_delegation' ? 'AdminDelegationSuspended' : 'AdminDelegationRevoked', terminalPayload(grant, state, ctx.now, command.reason_code));
    return finish(null);
  }
  if (command.kind === 'expire_admin_delegation') {
    if (actor.kind !== 'system') return finish('credential_kind_forbidden');
    if (grant.expires_at > ctx.now && grant.refresh_deadline > ctx.now) return finish('deadline_not_reached');
    if (grant.state === 'active') emit('AdminDelegationExpired', { ...terminalPayload(grant, state, ctx.now, 'expired'), expires_at: grant.expires_at, detected_at: ctx.now });
    return finish(null);
  }
  if (command.kind === 'withdraw_admin_workspace_access') {
    if (actor.kind !== 'human' || !ctx.withdrawing_workspace_owner) return finish('workspace_owner_required');
    if (!grant.workspace_ids.includes(command.workspace_id) && !(grant.workspace_selector === 'owned_and_selected' && ctx.target_workspace_owned_by_grantor)) return finish('workspace_forbidden');
    if (!grant.withdrawn_workspace_ids.includes(command.workspace_id)) emit('AdminWorkspaceAccessWithdrawn', {
      grant_id: grant.grant_id, workspace_id: command.workspace_id, withdrawing_user_id: actor.user_id, effective_at: ctx.now, reason_code: command.reason_code });
    return finish(null);
  }
  if (command.kind === 'admin_read_metadata' && humanOwner) {
    emit('AdminMetadataRead', { resource_kind: 'grant', workspace_id: null,
      target_filter_digest: ctx.request_digest, projection_version: 1, result_count: 1, audit_record_id: auditId });
    return finish(null);
  }
  if (grant.state !== 'active' || grant.expires_at <= ctx.now || grant.refresh_deadline <= ctx.now) return finish('grant_inactive');
  if (command.kind === 'narrow_admin_delegation') {
    const c = state.consents[command.consent_receipt_id];
    if (!humanOwner || actor.kind !== 'human') return finish('human_confirmation_required');
    if (!c || c.session_binding !== actor.session_binding || c.consumed_at !== null || c.expires_at <= ctx.now ||
        c.manifest_digest !== command.manifest_digest || canonicalAdminJson(c.manifest) !== canonicalAdminJson(command.manifest) ||
        !narrowing(command.manifest, grant, ctx.now)) return finish('scope_expansion_forbidden');
    emit('AdminDelegationNarrowed', { grant_id: grant.grant_id, prior_manifest_digest: grant.manifest_digest,
      new_manifest_digest: command.manifest_digest, removed_scopes: grant.scope_names.filter(s => !command.manifest.scope_names.includes(s)),
      removed_workspace_ids: grant.workspace_ids.filter(id => !command.manifest.workspace_ids.includes(id)),
      new_target_rules: command.manifest.target_rules, new_limits: { issuance_limits: command.manifest.issuance_limits, renewal_limits: command.manifest.renewal_limits },
      new_expires_at: command.manifest.expires_at, consent_receipt_id: command.consent_receipt_id, manifest: command.manifest });
    return finish(null);
  }
  if (command.kind === 'admin_read_metadata') {
    if (!humanOwner && (actor.kind !== 'delegated_admin' || actor.access_expires_at <= ctx.now ||
        !actor.scope_names.includes('admin:read') || !grant.scope_names.includes('admin:read') ||
        command.resource_kind !== 'grant')) return finish('credential_kind_forbidden');
    if (command.workspace_id !== null && (!grant.workspace_ids.includes(command.workspace_id) ||
        grant.withdrawn_workspace_ids.includes(command.workspace_id) || !ctx.current_workspace_rights)) return finish('workspace_forbidden');
    emit('AdminMetadataRead', { resource_kind: 'grant', workspace_id: command.workspace_id,
      target_filter_digest: ctx.request_digest, projection_version: 1, result_count: 1, audit_record_id: auditId });
    return finish(null);
  }
  if (command.kind !== 'issue_admin_credential' && command.kind !== 'rotate_admin_credential' && command.kind !== 'record_admin_credential_replay') return finish('human_confirmation_required');
  if (actor.kind !== 'credential_runtime' || actor.connection_id !== grant.connection_id ||
      actor.client_id !== grant.client_id || actor.resource !== ADMIN_RESOURCE) return finish('credential_runtime_required');
  const lineage = state.lineages[command.credential_lineage_id];
  if (command.kind === 'issue_admin_credential') {
    if (!ctx.current_workspace_rights) return finish('current_rights_required');
    if (Object.values(state.lineages).some(l => l.grant_id === grant.grant_id) || lineage) return finish('credential_already_issued');
    emit('AdminCredentialIssued', { grant_id: grant.grant_id, credential_lineage_id: command.credential_lineage_id,
      connection_id: grant.connection_id, resource: ADMIN_RESOURCE, generation: 0, scope_names: grant.scope_names,
      access_expires_at: Math.min(ctx.now + ADMIN_ACCESS_TTL_SECONDS * 1000, grant.expires_at, grant.refresh_deadline),
      refresh_deadline: grant.refresh_deadline, delivery_state: 'awaiting_delivery' });
    return finish(null);
  }
  if (!lineage || lineage.grant_id !== grant.grant_id || lineage.state !== 'active' ||
      ctx.presenting_refresh_lineage_id !== command.credential_lineage_id || ctx.presenting_refresh_generation === null || ctx.presenting_refresh_generation !== command.generation) return finish('refresh_invalid');
  if (command.kind === 'record_admin_credential_replay' || command.generation !== lineage.generation) {
    if (command.generation >= lineage.generation) return finish('refresh_invalid');
    emit('AdminCredentialReplayDetected', { grant_id: grant.grant_id, credential_lineage_id: lineage.credential_lineage_id,
      replayed_generation: command.generation, detected_at: ctx.now, reason_code: 'refresh_replay' });
    emit('AdminDelegationRevoked', terminalPayload(grant, state, ctx.now, 'refresh_replay'));
    return finish('refresh_replay');
  }
  if (!adminScopes(command.scope_names) || !command.scope_names.includes('admin:read') ||
      !subset(command.scope_names, lineage.scope_names) || !subset(command.scope_names, grant.scope_names)) return finish('scope_expansion_forbidden');
  if (!ctx.current_workspace_rights) return finish('current_rights_required');
  emit('AdminCredentialRotated', { grant_id: grant.grant_id, credential_lineage_id: lineage.credential_lineage_id,
    generation: lineage.generation + 1, scope_names: command.scope_names,
    access_expires_at: Math.min(ctx.now + ADMIN_ACCESS_TTL_SECONDS * 1000, grant.expires_at, lineage.refresh_deadline),
    refresh_deadline: lineage.refresh_deadline });
  return finish(null);
}
function terminalPayload(grant: AdminGrant, state: AdminAccountState, now: number, reason: string): Record<string, unknown> {
  return { grant_id: grant.grant_id, reason_code: reason, effective_at: now,
    credential_lineage_id: Object.values(state.lineages).find(l => l.grant_id === grant.grant_id)?.credential_lineage_id ?? null,
    cancelled_attempt_ids: [], dependent_child_ids: [] }; // Lane B cannot provision children.
}

/** Consent session bindings are separate private adapter facts, excluded from canonical events. */
export function reduceAdminAuthority(previous: AdminAccountState | null, event: AdminAccountEvent): AdminAccountState {
  if (event.schema_version !== 1 || event.stream_kind !== 'account' || !ADMIN_EVENT_TYPES.includes(event.type)) throw new Error('unsupported admin event');
  const state = previous ?? emptyAdminAccount(), p = event.payload;
  if (event.type === 'AdminConsentPrepared') {
    const c = { ...p, session_binding: '', consumed_at: null } as unknown as AdminConsent;
    return { ...state, consents: { ...state.consents, [c.consent_receipt_id]: c } };
  }
  if (event.type === 'AdminDelegationGranted') {
    const grant = { ...p, state: 'active', suspended_at: null, revoked_at: null, reason_code: null, withdrawn_workspace_ids: [] } as unknown as AdminGrant;
    if (state.grants[grant.grant_id]) throw new Error('duplicate admin grant');
    const consent = state.consents[grant.consent_receipt_id];
    if (!consent) throw new Error('missing admin consent');
    return { ...state, grants: { ...state.grants, [grant.grant_id]: grant }, consents: { ...state.consents, [consent.consent_receipt_id]: { ...consent, consumed_at: event.occurred_at_server } } };
  }
  if (event.type === 'AdminCredentialIssued' || event.type === 'AdminCredentialRotated') {
    const id = String(p.credential_lineage_id), old = state.lineages[id];
    if (event.type === 'AdminCredentialRotated' && (!old || p.generation !== old.generation + 1)) throw new Error('invalid admin credential generation');
    return { ...state, lineages: { ...state.lineages, [id]: { ...old, ...p, state: 'active', delivery_state: 'awaiting_delivery' } as unknown as AdminCredentialLineage } };
  }
  if (event.type === 'AdminActionRecorded') {
    const policy = p.policy_check as { buckets?: { key: string; hour_start: number; attempts: number }[] } | undefined;
    const rates = { ...state.rate_buckets };
    for (const bucket of policy?.buckets ?? []) rates[bucket.key] = { hour_start: bucket.hour_start, attempts: bucket.attempts };
    return { ...state, rate_buckets: rates };
  }
  if (event.type === 'AdminMetadataRead' || event.type === 'AdminCredentialReplayDetected') return state;
  const id = String(p.grant_id), grant = state.grants[id];
  if (!grant) throw new Error('unknown admin grant');
  if (event.type === 'AdminWorkspaceAccessWithdrawn') return { ...state, grants: { ...state.grants, [id]: { ...grant, withdrawn_workspace_ids: [...new Set([...grant.withdrawn_workspace_ids, String(p.workspace_id)])] } } };
  if (event.type === 'AdminDelegationNarrowed') {
    const receipt = String(p.consent_receipt_id), consent = state.consents[receipt];
    if (!consent) throw new Error('missing narrowing consent');
    return { ...state, grants: { ...state.grants, [id]: { ...grant, ...p.manifest as AdminManifest, manifest_digest: String(p.new_manifest_digest), consent_receipt_id: receipt } }, consents: { ...state.consents, [receipt]: { ...consent, consumed_at: event.occurred_at_server } } };
  }
  const status = event.type === 'AdminDelegationRevoked' ? 'revoked' : event.type === 'AdminDelegationSuspended' ? 'suspended' : 'expired';
  return { ...state, grants: { ...state.grants, [id]: { ...grant, state: status, reason_code: String(p.reason_code),
    revoked_at: status === 'revoked' ? event.occurred_at_server : grant.revoked_at,
    suspended_at: status === 'suspended' ? event.occurred_at_server : grant.suspended_at } },
    lineages: Object.fromEntries(Object.entries(state.lineages).map(([key, l]) => [key, l.grant_id === id ? { ...l, state: 'revoked' as const } : l])) };
}
