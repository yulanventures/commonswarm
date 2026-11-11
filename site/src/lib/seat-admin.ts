/**
 * Seat-admin browser controller helpers, transport client, strict wire parsers,
 * fresh-auth AMR verification, pure view-state resolution, and history renderer.
 *
 * Keeps SWARM_SEAT_ADMIN dark-by-default: when seat_admin_status is pending,
 * fails, or returns {enabled: false}, the Admin panel stays hidden and never
 * calls my_seat_admin_grants as a feature probe.
 */
import type { Session } from "@supabase/supabase-js";
import { deployment, postCommand } from "./commonswarm";
import type {
  SeatAdminAccess,
  SeatAdminDuration,
  SeatAdminGrantDraft,
  SeatAdminPanelModel,
  SeatAdminRoleLevel,
  SeatAdminScope,
  SeatAdminSwitch,
} from "./seat-admin-view";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEAT_ADMIN_RESOURCE = "https://api.commonswarm.com/admin";
const REAUTH_STORAGE_PREFIX = "commonswarm:seat-admin-reauth:v1:";

/**
 * Exact mirror of supabase/functions/command/fresh-auth.ts: interactive sign-in
 * methods stamped by GoTrue in the JWT amr claim (case-normalized to lowercase).
 * Token refresh updates iat without adding an interactive amr entry, so iat is
 * never accepted as proof of fresh sign-in.
 */
const INTERACTIVE_AMR_METHODS = new Set([
  "oauth",
  "password",
  "otp",
  "totp",
  "sso/saml",
  "magiclink",
  "email/signup",
]);

export const FRESH_AUTH_MAX_AGE_SECONDS = 300;
export const FRESH_AUTH_FUTURE_SKEW_SECONDS = 5;

export interface SeatAdminStatusAgent {
  principalId: string;
  name: string;
  eligible: {
    workspace: string[];
    organization: string[];
    scoped: string[];
  };
  activeGrantIds: string[];
}

export type SeatAdminStatusResponse =
  | { enabled: false }
  | {
      enabled: true;
      registryVersion: number;
      agents: SeatAdminStatusAgent[];
    };

export type SeatAdminGrantState = "active" | "downgraded" | "expired" | "ended";

export interface SeatAdminGrantRow {
  grantId: string;
  principalId: string;
  level: "workspace" | "organization" | "scoped";
  organizationId: string | null;
  scopeNames: string[];
  workspaceIds: string[];
  registryVersion: number;
  expiresAt: string | null;
  state: SeatAdminGrantState;
  createdAt: string;
  endedAt: string | null;
  endReason: string | null;
}

export type SeatAdminMutationOutcome =
  | {
      kind: "accepted";
      commandId: string;
      grant: SeatAdminGrantRow;
    }
  | {
      kind: "reauth_required";
      commandId: string;
      message: string;
    }
  | {
      kind: "already_exists";
      commandId: string;
      code: string;
      message: string;
    }
  | {
      kind: "refused";
      commandId: string;
      code: string;
      message: string;
    }
  | {
      kind: "unknown";
      commandId: string;
      message: string;
    };

export type SeatAdminEndOutcome =
  | {
      kind: "accepted";
      commandId: string;
      grant: SeatAdminGrantRow;
    }
  | {
      kind: "refused";
      commandId: string;
      code: string;
      message: string;
    }
  | {
      kind: "unknown";
      commandId: string;
      message: string;
    };

export interface SeatAdminReauthIntent {
  userId: string;
  workspaceId: string;
  routeView: "agent" | "people";
  principalId: string;
  level: SeatAdminRoleLevel;
  scopeId?: string;
  days: SeatAdminDuration;
}

export interface SeatAdminUnresolvedAttempt {
  attemptId: number;
  userId: string;
  workspaceId: string;
  principalId: string;
  level: SeatAdminRoleLevel;
  commandId: string;
  draft: SeatAdminGrantDraft;
  phase: "pending" | "unknown" | "reconciled";
  notice?: string;
}

export interface ResolveSeatAdminPanelInput {
  signedIn: boolean;
  sampleMode: boolean;
  viewerUserId: string | null;
  agent: {
    principalId: string;
    name: string;
    ownerUserId: string | null;
    transport?: string | null;
    turnOnly?: boolean;
    revokedAt?: string | null;
  } | null;
  currentWorkspace: {
    id: string;
    name: string;
    orgId?: string | null;
  } | null;
  knownOrganizations?: ReadonlyArray<{ id: string; name: string }>;
  statusState:
    | { phase: "idle" | "loading" }
    | { phase: "error"; message: string }
    | { phase: "loaded"; status: SeatAdminStatusResponse };
  grantsState:
    | { phase: "idle" | "loading" }
    | { phase: "error"; message: string }
    | { phase: "loaded"; grants: ReadonlyArray<SeatAdminGrantRow> };
  removingLevels?: ReadonlySet<SeatAdminRoleLevel>;
  unresolvedLevels?: ReadonlySet<SeatAdminRoleLevel>;
  receipt?: string | null;
  error?: string | null;
  historyHref?: string;
}

export interface ResolvedSeatAdminPanel {
  panel: SeatAdminPanelModel;
  agentStatus: SeatAdminStatusAgent | null;
  activeGrants: {
    workspace: SeatAdminGrantRow | null;
    organization: SeatAdminGrantRow | null;
    organizations: SeatAdminGrantRow[];
  };
  eligibleOrganizations: SeatAdminScope[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseUuidArray(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || !UUID_RE.test(item)) return null;
    out.push(item.toLowerCase());
  }
  return out;
}

function parseStringArray(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || !item.trim()) return null;
    out.push(item);
  }
  return out;
}

export function parseSeatAdminStatus(raw: unknown): SeatAdminStatusResponse | null {
  if (!isRecord(raw) || typeof raw.enabled !== "boolean") return null;
  if (!raw.enabled) return { enabled: false };
  if (typeof raw.registry_version !== "number" || !Number.isInteger(raw.registry_version)) return null;
  if (!Array.isArray(raw.agents)) return null;
  const agents: SeatAdminStatusAgent[] = [];
  for (const entry of raw.agents) {
    if (!isRecord(entry)) return null;
    if (typeof entry.principal_id !== "string" || !UUID_RE.test(entry.principal_id)) return null;
    if (typeof entry.name !== "string") return null;
    if (!isRecord(entry.eligible)) return null;
    const workspace = parseUuidArray(entry.eligible.workspace);
    const organization = parseUuidArray(entry.eligible.organization);
    const scoped = entry.eligible.scoped === undefined ? [] : parseUuidArray(entry.eligible.scoped);
    const activeGrantIds = parseUuidArray(entry.active_grant_ids);
    if (!workspace || !organization || !scoped || !activeGrantIds) return null;
    agents.push({
      principalId: entry.principal_id.toLowerCase(),
      name: entry.name,
      eligible: { workspace, organization, scoped },
      activeGrantIds,
    });
  }
  return {
    enabled: true,
    registryVersion: raw.registry_version,
    agents,
  };
}

export function parseSeatAdminGrantRecord(entry: unknown, nowMs = Date.now()): SeatAdminGrantRow | null {
  if (!isRecord(entry)) return null;
  if (typeof entry.grant_id !== "string" || !UUID_RE.test(entry.grant_id)) return null;
  if (typeof entry.principal_id !== "string" || !UUID_RE.test(entry.principal_id)) return null;
  if (entry.level !== "workspace" && entry.level !== "organization" && entry.level !== "scoped") return null;
  const orgId =
    entry.organization_id === null || entry.organization_id === undefined
      ? null
      : typeof entry.organization_id === "string" && UUID_RE.test(entry.organization_id)
      ? entry.organization_id.toLowerCase()
      : undefined;
  if (orgId === undefined) return null;
  const scopeNames = parseStringArray(entry.scope_names);
  const workspaceIds = parseUuidArray(entry.workspace_ids);
  if (!scopeNames || !workspaceIds) return null;
  const registryVersion =
    entry.registry_version === undefined
      ? 3
      : typeof entry.registry_version === "number" && Number.isInteger(entry.registry_version)
      ? entry.registry_version
      : null;
  if (registryVersion === null) return null;
  const expiresAt =
    entry.expires_at === null || entry.expires_at === undefined
      ? null
      : typeof entry.expires_at === "string" && Number.isFinite(Date.parse(entry.expires_at))
      ? entry.expires_at
      : undefined;
  if (expiresAt === undefined) return null;
  if (
    entry.state !== "active" &&
    entry.state !== "downgraded" &&
    entry.state !== "expired" &&
    entry.state !== "ended"
  ) {
    return null;
  }
  if (typeof entry.created_at !== "string" || !Number.isFinite(Date.parse(entry.created_at))) return null;
  const endedAt =
    entry.ended_at === null || entry.ended_at === undefined
      ? null
      : typeof entry.ended_at === "string" && Number.isFinite(Date.parse(entry.ended_at))
      ? entry.ended_at
      : undefined;
  if (endedAt === undefined) return null;
  const endReason =
    entry.end_reason === null || entry.end_reason === undefined
      ? null
      : typeof entry.end_reason === "string"
      ? entry.end_reason
      : undefined;
  if (endReason === undefined) return null;

  let effectiveState: SeatAdminGrantState = entry.state;
  if (effectiveState === "active" && expiresAt !== null && Date.parse(expiresAt) <= nowMs) {
    effectiveState = "expired";
  }
  return {
    grantId: entry.grant_id.toLowerCase(),
    principalId: entry.principal_id.toLowerCase(),
    level: entry.level,
    organizationId: orgId,
    scopeNames,
    workspaceIds,
    registryVersion,
    expiresAt,
    state: effectiveState,
    createdAt: entry.created_at,
    endedAt,
    endReason,
  };
}

export function parseSeatAdminGrants(raw: unknown, nowMs = Date.now()): SeatAdminGrantRow[] | null {
  if (!isRecord(raw) || !Array.isArray(raw.grants)) return null;
  const rows: SeatAdminGrantRow[] = [];
  for (const entry of raw.grants) {
    const parsed = parseSeatAdminGrantRecord(entry, nowMs);
    if (!parsed) return null;
    rows.push(parsed);
  }
  return rows;
}

export function newestInteractiveAmrSeconds(claims: unknown): number | null {
  if (!isRecord(claims) || !Array.isArray(claims.amr)) return null;
  let newest: number | null = null;
  for (const entry of claims.amr) {
    if (!isRecord(entry) || typeof entry.method !== "string") continue;
    const method = entry.method.toLowerCase();
    const ts = entry.timestamp;
    if (!INTERACTIVE_AMR_METHODS.has(method) || typeof ts !== "number" || !Number.isFinite(ts) || ts < 0) {
      continue;
    }
    newest = newest === null ? ts : Math.max(newest, ts);
  }
  return newest;
}

export function decodeJwtClaims(accessToken: string): Record<string, unknown> | null {
  const parts = accessToken.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(parts[1].length / 4) * 4, "=");
    const json =
      typeof globalThis.atob === "function"
        ? globalThis.atob(padded)
        : Buffer.from(padded, "base64").toString("utf8");
    const parsed: unknown = JSON.parse(json);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function hasFreshInteractiveSession(accessToken: string, nowMs = Date.now()): boolean {
  const claims = decodeJwtClaims(accessToken);
  if (!claims) return false;
  const amrTs = newestInteractiveAmrSeconds(claims);
  if (amrTs === null || !Number.isFinite(amrTs) || !Number.isFinite(nowMs)) return false;
  const ageSeconds = nowMs / 1000 - amrTs;
  return ageSeconds >= -FRESH_AUTH_FUTURE_SKEW_SECONDS && ageSeconds <= FRESH_AUTH_MAX_AGE_SECONDS;
}

/**
 * Builds the closed command payload for grant_seat_admin.
 * Command expires_at is numeric epoch milliseconds (or null), matching
 * src/protocol/seat-admin.ts and SeatAdminGrantDraft.
 */
export function buildGrantSeatAdminCommand(draft: SeatAdminGrantDraft): Record<string, unknown> {
  return {
    kind: "grant_seat_admin",
    principal_id: draft.principalId,
    level: draft.level,
    scope_names: [draft.level === "workspace" ? "role:workspace_admin" : "role:organization_admin"],
    workspace_ids: draft.level === "workspace" ? [draft.scopeId] : [],
    organization_id: draft.level === "organization" ? draft.scopeId : null,
    expires_at: draft.expiresAt === null ? null : Math.trunc(draft.expiresAt),
  };
}

export async function readSeatAdminStatus(
  session: Session,
): Promise<{ ok: true; status: SeatAdminStatusResponse } | { ok: false; code: string; message: string }> {
  const d = deployment();
  if (!d) return { ok: false, code: "no_deployment", message: "No CommonSwarm deployment is configured." };
  try {
    const response = await fetch(`${d.url}/functions/v1/read`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        apikey: d.anonKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ resource: "seat_admin_status" }),
    });
    const raw = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) {
      const code = isRecord(raw) && typeof raw.error === "string" ? raw.error : `http_${response.status}`;
      const message =
        isRecord(raw) && typeof raw.message === "string"
          ? raw.message
          : "Could not check agent admin availability.";
      return { ok: false, code, message };
    }
    const status = parseSeatAdminStatus(raw);
    if (!status) {
      return { ok: false, code: "invalid_status_shape", message: "Could not check agent admin availability." };
    }
    return { ok: true, status };
  } catch {
    return { ok: false, code: "network_error", message: "Could not check agent admin availability." };
  }
}

export async function readMySeatAdminGrants(
  session: Session,
): Promise<{ ok: true; grants: SeatAdminGrantRow[] } | { ok: false; code: string; message: string }> {
  const d = deployment();
  if (!d) return { ok: false, code: "no_deployment", message: "No CommonSwarm deployment is configured." };
  try {
    const response = await fetch(`${d.url}/rest/v1/rpc/my_seat_admin_grants`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        apikey: d.anonKey,
        Accept: "application/json",
        "Content-Type": "application/json",
        "accept-profile": "swarm_read",
        "content-profile": "swarm_read",
      },
      body: "{}",
    });
    const raw = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) {
      const code = isRecord(raw) && typeof raw.error === "string" ? raw.error : `http_${response.status}`;
      const message =
        isRecord(raw) && typeof raw.message === "string"
          ? raw.message
          : "Could not load agent admin access.";
      return { ok: false, code, message };
    }
    const grants = parseSeatAdminGrants(raw);
    if (!grants) {
      return { ok: false, code: "invalid_grants_shape", message: "Could not load agent admin access." };
    }
    return { ok: true, grants };
  } catch {
    return { ok: false, code: "network_error", message: "Could not load agent admin access." };
  }
}

const UNKNOWN_OUTCOME_MESSAGE =
  "The result couldn't be checked. Refresh admin access before trying again.";

function refusalMessageFor(code: string, serverMessage: unknown, op: "grant" | "end"): string {
  if (typeof serverMessage === "string" && serverMessage.trim()) return serverMessage.trim();
  switch (code) {
    case "seat_admin_exists":
      return "This admin access is already active.";
    case "invalid_expiry":
      return "Choose a future end date within 90 days.";
    case "scope_forbidden":
    case "target_not_owned":
    case "principal_not_owned":
    case "agent_not_in_workspace":
    case "forbidden":
      return op === "grant"
        ? "Access was refused. Refresh admin access and try again."
        : "You don't have permission to remove this admin access.";
    case "not_found":
      return "This admin grant was not found.";
    case "command_id_conflict":
      return "This request conflicted with a previous attempt. Close and try again.";
    default:
      return op === "grant"
        ? "Could not enable agent admin access."
        : "Could not remove agent admin access.";
  }
}

export async function grantSeatAdmin(
  session: Session,
  commandId: string,
  draft: SeatAdminGrantDraft,
): Promise<SeatAdminMutationOutcome> {
  try {
    const res = await postCommand(session, commandId, buildGrantSeatAdminCommand(draft), {
      stream: { kind: "account" },
      resource: SEAT_ADMIN_RESOURCE,
    });
    const body = res.body;
    if (res.status === 401 && body.error === "human_confirmation_required") {
      return {
        kind: "reauth_required",
        commandId,
        message:
          typeof body.message === "string" && body.message.trim()
            ? body.message
            : "Sign in again to confirm this admin access.",
      };
    }
    if (res.status === 200 && body.status === "accepted" && isRecord(body.seat_admin_grant)) {
      const grant = parseSeatAdminGrantRecord(body.seat_admin_grant);
      if (!grant) return { kind: "unknown", commandId, message: UNKNOWN_OUTCOME_MESSAGE };
      return {
        kind: "accepted",
        commandId,
        grant,
      };
    }
    if (res.status === 409 && body.error === "seat_admin_exists") {
      return {
        kind: "already_exists",
        commandId,
        code: "seat_admin_exists",
        message: refusalMessageFor("seat_admin_exists", body.message, "grant"),
      };
    }
    if (
      res.status >= 400 &&
      res.status < 500 &&
      typeof body.error === "string" &&
      body.error !== "unreadable_response"
    ) {
      const code = body.error;
      return {
        kind: "refused",
        commandId,
        code,
        message: refusalMessageFor(code, body.message, "grant"),
      };
    }
    return { kind: "unknown", commandId, message: UNKNOWN_OUTCOME_MESSAGE };
  } catch {
    return { kind: "unknown", commandId, message: UNKNOWN_OUTCOME_MESSAGE };
  }
}

export async function endSeatAdmin(
  session: Session,
  commandId: string,
  grantId: string,
): Promise<SeatAdminEndOutcome> {
  try {
    const res = await postCommand(
      session,
      commandId,
      { kind: "end_seat_admin", grant_id: grantId },
      { stream: { kind: "account" }, resource: SEAT_ADMIN_RESOURCE },
    );
    const body = res.body;
    if (res.status === 200 && body.status === "accepted" && isRecord(body.seat_admin_grant)) {
      const grant = parseSeatAdminGrantRecord(body.seat_admin_grant);
      if (!grant) return { kind: "unknown", commandId, message: UNKNOWN_OUTCOME_MESSAGE };
      return {
        kind: "accepted",
        commandId,
        grant,
      };
    }
    if (
      res.status >= 400 &&
      res.status < 500 &&
      typeof body.error === "string" &&
      body.error !== "unreadable_response"
    ) {
      return {
        kind: "refused",
        commandId,
        code: body.error,
        message: refusalMessageFor(body.error, body.message, "end"),
      };
    }
    return { kind: "unknown", commandId, message: UNKNOWN_OUTCOME_MESSAGE };
  } catch {
    return { kind: "unknown", commandId, message: UNKNOWN_OUTCOME_MESSAGE };
  }
}

const memoryReauthIntents = new Map<string, SeatAdminReauthIntent>();

function defaultSessionStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

function isValidDuration(days: unknown): days is SeatAdminDuration {
  return days === null || days === 1 || days === 7 || days === 30 || days === 90;
}

export function saveSeatAdminReauthIntent(
  intent: SeatAdminReauthIntent,
  storage: Storage | null = defaultSessionStorage(),
): void {
  const userId = intent.userId.toLowerCase();
  const normalized: SeatAdminReauthIntent = {
    userId,
    workspaceId: intent.workspaceId.toLowerCase(),
    routeView: intent.routeView === "people" ? "people" : "agent",
    principalId: intent.principalId.toLowerCase(),
    level: intent.level === "organization" ? "organization" : "workspace",
    ...(intent.scopeId && UUID_RE.test(intent.scopeId) ? { scopeId: intent.scopeId.toLowerCase() } : {}),
    days: isValidDuration(intent.days) ? intent.days : null,
  };
  memoryReauthIntents.set(userId, normalized);
  try {
    storage?.setItem(`${REAUTH_STORAGE_PREFIX}${userId}`, JSON.stringify(normalized));
  } catch {
    // In-memory map still retains the intent for the current tab lifecycle.
  }
}

export function readSeatAdminReauthIntent(
  userId: string,
  storage: Storage | null = defaultSessionStorage(),
): SeatAdminReauthIntent | null {
  const key = userId.toLowerCase();
  if (!UUID_RE.test(key)) return null;
  let candidate: unknown = memoryReauthIntents.get(key) ?? null;
  if (!candidate && storage) {
    try {
      const raw = storage.getItem(`${REAUTH_STORAGE_PREFIX}${key}`);
      if (raw) candidate = JSON.parse(raw);
    } catch {
      candidate = null;
    }
  }
  if (!isRecord(candidate)) return null;
  if (typeof candidate.userId !== "string" || candidate.userId.toLowerCase() !== key) return null;
  if (typeof candidate.workspaceId !== "string" || !UUID_RE.test(candidate.workspaceId)) return null;
  if (candidate.routeView !== "agent" && candidate.routeView !== "people") return null;
  if (typeof candidate.principalId !== "string" || !UUID_RE.test(candidate.principalId)) return null;
  if (candidate.level !== "workspace" && candidate.level !== "organization") return null;
  const scopeId =
    candidate.scopeId === undefined
      ? undefined
      : typeof candidate.scopeId === "string" && UUID_RE.test(candidate.scopeId)
      ? candidate.scopeId.toLowerCase()
      : null;
  if (scopeId === null) return null;
  const days = candidate.days;
  if (!isValidDuration(days)) return null;
  return {
    userId: key,
    workspaceId: candidate.workspaceId.toLowerCase(),
    routeView: candidate.routeView,
    principalId: candidate.principalId.toLowerCase(),
    level: candidate.level,
    ...(scopeId ? { scopeId } : {}),
    days,
  };
}

export function clearSeatAdminReauthIntent(
  userId?: string,
  storage: Storage | null = defaultSessionStorage(),
): void {
  if (userId) {
    const key = userId.toLowerCase();
    memoryReauthIntents.delete(key);
    try {
      storage?.removeItem(`${REAUTH_STORAGE_PREFIX}${key}`);
    } catch {
      /* ignore */
    }
    return;
  }
  memoryReauthIntents.clear();
  if (!storage) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i += 1) {
      const k = storage.key(i);
      if (k?.startsWith(REAUTH_STORAGE_PREFIX)) keys.push(k);
    }
    for (const k of keys) storage.removeItem(k);
  } catch {
    /* ignore */
  }
}

export function hasActiveGrantForTarget(
  grants: ReadonlyArray<SeatAdminGrantRow>,
  target: { principalId: string; level: SeatAdminRoleLevel; scopeId: string },
): boolean {
  const principalId = target.principalId.toLowerCase();
  const scopeId = target.scopeId.toLowerCase();
  if (!UUID_RE.test(principalId) || !UUID_RE.test(scopeId)) return false;
  return grants.some(
    grant =>
      grant.state === "active" &&
      grant.principalId === principalId &&
      grant.level === target.level &&
      (target.level === "workspace"
        ? grant.workspaceIds.includes(scopeId)
        : grant.organizationId === scopeId),
  );
}

export function nonActiveSeatAdminGrantMessage(state: Exclude<SeatAdminGrantState, "active">): string {
  if (state === "expired") {
    return "This admin grant has already expired. Open confirmation again to create a new grant.";
  }
  if (state === "downgraded") {
    return "This admin grant was already removed. Open confirmation again to enable it.";
  }
  return "This admin grant has already ended. Open confirmation again to enable it.";
}

export function seatAdminRemovalReceipt(
  removedLevel: SeatAdminRoleLevel,
  remainingWorkspaceActive: boolean,
  remainingOrgActive: boolean,
): string {
  if (removedLevel === "workspace") {
    return remainingOrgActive
      ? "Workspace admin removed. Organization admin remains on."
      : "Workspace admin removed.";
  }
  return remainingWorkspaceActive
    ? "Organization admin removed. Workspace admin remains on."
    : "Organization admin removed.";
}

function organizationNameFor(
  orgId: string,
  knownOrganizations: ReadonlyArray<{ id: string; name: string }>,
): string {
  const lower = orgId.toLowerCase();
  const match = knownOrganizations.find(org => org.id.toLowerCase() === lower && org.name.trim());
  return match ? match.name.trim() : `Organization ${lower.slice(0, 8)}`;
}

export function resolveSeatAdminPanelModel(input: ResolveSeatAdminPanelInput): ResolvedSeatAdminPanel {
  const hiddenResult: ResolvedSeatAdminPanel = {
    panel: { state: "hidden" },
    agentStatus: null,
    activeGrants: { workspace: null, organization: null, organizations: [] },
    eligibleOrganizations: [],
  };

  if (!input.signedIn || input.sampleMode || !input.viewerUserId || !input.agent || !input.agent.ownerUserId) {
    return hiddenResult;
  }
  const viewerId = input.viewerUserId.toLowerCase();
  const ownerId = input.agent.ownerUserId.toLowerCase();
  const agentId = input.agent.principalId.toLowerCase();
  if (!UUID_RE.test(viewerId) || viewerId !== ownerId || Boolean(input.agent.revokedAt)) {
    return hiddenResult;
  }

  // Keep the Admin panel hidden until seat_admin_status resolves { enabled: true }.
  if (input.statusState.phase !== "loaded" || !input.statusState.status.enabled) {
    return hiddenResult;
  }

  const status = input.statusState.status;
  const agentStatus = status.agents.find(entry => entry.principalId === agentId) ?? null;
  if (!agentStatus) {
    return hiddenResult;
  }

  const isHosted =
    input.agent.transport === "hosted_mcp" ||
    input.agent.transport === "hosted" ||
    input.agent.turnOnly === true;
  if (isHosted && agentStatus.activeGrantIds.length === 0) {
    return hiddenResult;
  }

  const knownOrganizations = input.knownOrganizations ?? [];
  const eligibleOrganizations: SeatAdminScope[] = agentStatus.eligible.organization.map(orgId => ({
    id: orgId,
    name: organizationNameFor(orgId, knownOrganizations),
  }));

  if (input.grantsState.phase === "idle" || input.grantsState.phase === "loading") {
    return {
      panel: { state: "loading", agentName: input.agent.name },
      agentStatus,
      activeGrants: { workspace: null, organization: null, organizations: [] },
      eligibleOrganizations,
    };
  }

  if (input.grantsState.phase === "error") {
    return {
      panel: {
        state: "error",
        agentName: input.agent.name,
        notice: input.grantsState.message || "Could not load agent admin access.",
      },
      agentStatus,
      activeGrants: { workspace: null, organization: null, organizations: [] },
      eligibleOrganizations,
    };
  }

  const grants = input.grantsState.grants;
  const grantsById = new Map<string, SeatAdminGrantRow>();
  for (const grant of grants) {
    grantsById.set(grant.grantId, grant);
  }

  // Every ID in active_grant_ids must resolve to an active grant for this agent.
  let hasUnresolvedActiveId = false;
  for (const activeId of agentStatus.activeGrantIds) {
    const resolved = grantsById.get(activeId);
    if (!resolved || resolved.principalId !== agentId || resolved.state !== "active") {
      hasUnresolvedActiveId = true;
    }
  }

  const currentWorkspaceId = input.currentWorkspace?.id.toLowerCase() ?? null;
  const currentWorkspaceName = input.currentWorkspace?.name ?? "This workspace";
  const currentOrgId = input.currentWorkspace?.orgId?.toLowerCase() ?? null;

  const activeAgentGrants = grants.filter(
    grant => grant.principalId === agentId && grant.state === "active",
  );

  const activeWorkspaceGrant =
    currentWorkspaceId !== null
      ? activeAgentGrants.find(
          grant => grant.level === "workspace" && grant.workspaceIds.includes(currentWorkspaceId),
        ) ?? null
      : null;

  const activeOrganizationGrants = activeAgentGrants.filter(grant => grant.level === "organization");
  const activeOrganizationGrant =
    (currentOrgId
      ? activeOrganizationGrants.find(grant => grant.organizationId === currentOrgId)
      : undefined) ??
    activeOrganizationGrants[0] ??
    null;

  const hasActiveScopedGrant = activeAgentGrants.some(grant => grant.level === "scoped");
  const removingLevels = input.removingLevels ?? new Set<SeatAdminRoleLevel>();
  const unresolvedLevels = input.unresolvedLevels ?? new Set<SeatAdminRoleLevel>();
  const supportedRegistry = status.registryVersion === 3;

  const workspaceAccess: SeatAdminAccess = unresolvedLevels.has("workspace")
    ? { state: "unresolved" }
    : activeWorkspaceGrant
    ? {
        state: "on",
        grantId: activeWorkspaceGrant.grantId,
      }
    : hasUnresolvedActiveId || hasActiveScopedGrant
    ? {
        state: "unresolved",
      }
    : { state: "off" };

  const workspaceEligible =
    supportedRegistry &&
    !isHosted &&
    currentWorkspaceId !== null &&
    agentStatus.eligible.workspace.includes(currentWorkspaceId);

  const workspaceSwitch: SeatAdminSwitch = {
    scope: {
      id: currentWorkspaceId ?? "",
      name: currentWorkspaceName,
    },
    access: workspaceAccess,
    mayGrant: workspaceEligible,
    mayRemove: activeWorkspaceGrant !== null,
    pending: removingLevels.has("workspace"),
  };

  const orgScopeId =
    activeOrganizationGrant?.organizationId ??
    (eligibleOrganizations.length === 1 ? eligibleOrganizations[0]!.id : "");
  const orgScopeName = activeOrganizationGrant?.organizationId
    ? organizationNameFor(activeOrganizationGrant.organizationId, knownOrganizations)
    : eligibleOrganizations.length === 1
    ? eligibleOrganizations[0]!.name
    : eligibleOrganizations.length > 1
    ? `${eligibleOrganizations.length} eligible organizations`
    : "Organization";

  const organizationAccess: SeatAdminAccess = unresolvedLevels.has("organization")
    ? { state: "unresolved" }
    : activeOrganizationGrant
    ? {
        state: "on",
        grantId: activeOrganizationGrant.grantId,
      }
    : hasUnresolvedActiveId || hasActiveScopedGrant
    ? {
        state: "unresolved",
      }
    : { state: "off" };

  const organizationEligible =
    supportedRegistry && !isHosted && eligibleOrganizations.length > 0;

  const organizationSwitch: SeatAdminSwitch = {
    scope: {
      id: orgScopeId,
      name: orgScopeName,
    },
    access: organizationAccess,
    mayGrant: organizationEligible,
    mayRemove: activeOrganizationGrant !== null,
    pending: removingLevels.has("organization"),
  };

  const notice = input.error ?? input.receipt ?? undefined;

  return {
    panel: {
      state: "ready",
      agentName: input.agent.name,
      workspace: workspaceSwitch,
      organization: organizationSwitch,
      ...(notice ? { notice } : {}),
      historyHref: input.historyHref ?? "/app?admin=history",
    },
    agentStatus,
    activeGrants: {
      workspace: activeWorkspaceGrant,
      organization: activeOrganizationGrant,
      organizations: activeOrganizationGrants,
    },
    eligibleOrganizations,
  };
}

function formatHistoryDate(iso: string | null): string {
  if (!iso) return "No end date";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(parsed);
}

function formatGrantLevelLabel(level: SeatAdminGrantRow["level"]): string {
  if (level === "workspace") return "Workspace admin";
  if (level === "organization") return "Organization admin";
  return "Scoped admin (v1)";
}

function formatGrantStateLabel(grant: SeatAdminGrantRow): string {
  if (grant.state === "active") {
    return grant.expiresAt ? `Active · Ends ${formatHistoryDate(grant.expiresAt)}` : "Active · Until removed";
  }
  const endedWhen = grant.endedAt ? ` ${formatHistoryDate(grant.endedAt)}` : "";
  const reasonSuffix = grant.endReason ? ` (${grant.endReason})` : "";
  if (grant.state === "expired") {
    return `Expired ${formatHistoryDate(grant.expiresAt)}`;
  }
  if (grant.state === "downgraded") {
    return `Downgraded${endedWhen}${reasonSuffix}`;
  }
  return `Ended${endedWhen}${reasonSuffix}`;
}

export function renderSeatAdminHistoryList(
  container: HTMLElement,
  grants: ReadonlyArray<SeatAdminGrantRow>,
  options: {
    agentsByPrincipalId?: ReadonlyMap<string, string>;
    workspacesById?: ReadonlyMap<string, string>;
    organizationsById?: ReadonlyMap<string, string>;
    busy?: boolean;
    onRemove: (grant: SeatAdminGrantRow, button: HTMLButtonElement) => void;
  },
): void {
  const doc = container.ownerDocument;
  container.replaceChildren();
  if (grants.length === 0) {
    const empty = doc.createElement("p");
    empty.textContent = "No agent admin grants recorded for your account.";
    container.append(empty);
    return;
  }
  for (const grant of grants) {
    const card = doc.createElement("article");
    card.dataset.adminSeatGrant = grant.grantId;
    card.dataset.adminSeatLevel = grant.level;
    card.dataset.adminSeatState = grant.state;

    const agentName =
      options.agentsByPrincipalId?.get(grant.principalId) ??
      `Agent ${grant.principalId.slice(0, 8)}`;
    const title = doc.createElement("h4");
    title.textContent = `${agentName} · ${formatGrantLevelLabel(grant.level)}`;

    const scopeLine = doc.createElement("p");
    if (grant.level === "organization" && grant.organizationId) {
      const orgName = options.organizationsById?.get(grant.organizationId);
      scopeLine.textContent = orgName ? `Organization: ${orgName}` : `Organization ${grant.organizationId}`;
    } else if (grant.workspaceIds.length > 0) {
      const labels = grant.workspaceIds.map(id => {
        const wsName = options.workspacesById?.get(id);
        return wsName ? wsName : `Workspace ${id}`;
      });
      scopeLine.textContent = `Workspace: ${labels.join(", ")}`;
    } else {
      scopeLine.textContent = `Scopes: ${grant.scopeNames.join(", ")}`;
    }

    const stateLine = doc.createElement("p");
    stateLine.textContent = formatGrantStateLabel(grant);

    card.append(title, scopeLine, stateLine);

    if (grant.state === "active") {
      const button = doc.createElement("button");
      button.type = "button";
      button.textContent = "Remove admin access";
      button.dataset.tone = "danger";
      button.dataset.adminSeatRemove = grant.grantId;
      button.disabled = Boolean(options.busy);
      button.addEventListener("click", () => options.onRemove(grant, button));
      card.append(button);
    }

    container.append(card);
  }
}
