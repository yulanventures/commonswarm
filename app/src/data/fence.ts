import type { Session } from '@supabase/supabase-js';

export interface LoginIdentity {
  readonly userId: string;
  readonly sessionId: string;
}

export interface Fence {
  readonly loginGeneration: number;
  readonly userId: string | null;
  readonly sessionId: string | null;
  readonly workspaceId: string | null;
  readonly workspaceGeneration: number;
  readonly conversationId: string | null;
  readonly conversationGeneration: number;
  readonly overviewGeneration?: number;
}

export interface FenceCheckOptions {
  /** Verified login identity from the token acquired for this operation. */
  loginIdentity?: LoginIdentity | null;
  /** Require the fence's workspace to still be the active workspace (default true). */
  requireActiveWorkspace?: boolean;
  /** Require the fence's conversation to still be the active conversation (default true). */
  requireActiveConversation?: boolean;
}

export class StaleFenceError extends Error {
  override name = 'StaleFenceError';
  constructor(message = 'Operation fence is no longer current.') {
    super(message);
  }
}

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

function decodeBase64UrlUtf8(segment: string): string | null {
  if (!segment || !BASE64URL_RE.test(segment)) return null;
  const padded = segment
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(segment.length / 4) * 4, '=');
  try {
    const binary = globalThis.atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Locally decode the GoTrue JWT payload to extract `{ userId, sessionId }`.
 *
 * `session_id` remains stable across token refreshes of one login and changes
 * whenever the same user signs out and signs back in. Any missing session,
 * malformed JWT, unreadable claim, or `sub` mismatch returns `null` (fail closed).
 */
export function extractLoginIdentity(
  session: Pick<Session, 'access_token' | 'user'> | null | undefined,
): LoginIdentity | null {
  if (!session) return null;
  const userId =
    typeof session.user?.id === 'string' ? session.user.id.trim() : '';
  const token =
    typeof session.access_token === 'string' ? session.access_token.trim() : '';
  if (!userId || !token) return null;

  const parts = token.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return null;

  const decoded = decodeBase64UrlUtf8(parts[1]);
  if (!decoded) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(decoded);
  } catch {
    return null;
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }

  const record = payload as Record<string, unknown>;
  const sessionId =
    typeof record.session_id === 'string' ? record.session_id.trim() : '';
  if (!sessionId) return null;

  if (
    typeof record.sub === 'string' &&
    record.sub.trim().length > 0 &&
    record.sub.trim() !== userId
  ) {
    return null;
  }

  return { userId, sessionId };
}

export function sameLoginIdentity(
  a: LoginIdentity | null | undefined,
  b: LoginIdentity | null | undefined,
): boolean {
  return Boolean(a && b && a.userId === b.userId && a.sessionId === b.sessionId);
}

function normalizeScopeId(id: string | null | undefined): string | null {
  if (typeof id !== 'string') return null;
  const trimmed = id.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

export class FenceTracker {
  private _loginGeneration = 0;
  private _loginIdentity: LoginIdentity | null = null;
  private _activeWorkspaceId: string | null = null;
  private _activeConversationId: string | null = null;
  private _overviewGeneration = 0;
  private readonly workspaceGenerations = new Map<string, number>();
  private readonly conversationGenerations = new Map<string, number>();
  private readonly revokedWorkspaces = new Set<string>();

  get loginGeneration(): number {
    return this._loginGeneration;
  }

  get loginIdentity(): LoginIdentity | null {
    return this._loginIdentity;
  }

  get userId(): string | null {
    return this._loginIdentity?.userId ?? null;
  }

  get activeWorkspaceId(): string | null {
    return this._activeWorkspaceId;
  }

  get activeConversationId(): string | null {
    return this._activeConversationId;
  }

  get overviewGeneration(): number {
    return this._overviewGeneration;
  }

  isWorkspaceRevoked(workspaceId: string | null | undefined): boolean {
    const normalized = normalizeScopeId(workspaceId);
    return normalized !== null && this.revokedWorkspaces.has(normalized);
  }

  getWorkspaceGeneration(workspaceId: string | null | undefined): number {
    const normalized = normalizeScopeId(workspaceId);
    if (!normalized) return 0;
    return this.workspaceGenerations.get(normalized) ?? 0;
  }

  getConversationGeneration(conversationId: string | null | undefined): number {
    const normalized = normalizeScopeId(conversationId);
    if (!normalized) return 0;
    return this.conversationGenerations.get(normalized) ?? 0;
  }

  /**
   * Reconcile against a session object. Same `{ userId, sessionId }` (e.g. token refresh)
   * preserves `loginGeneration`; any new sign-in, user change, same-user re-sign-in
   * (new `session_id`), missing session, or unreadable claim bumps `loginGeneration`.
   */
  reconcileSession(
    session: Pick<Session, 'access_token' | 'user'> | null | undefined,
  ): {
    changed: boolean;
    identity: LoginIdentity | null;
    loginGeneration: number;
  } {
    const nextIdentity = extractLoginIdentity(session);
    if (nextIdentity === null) {
      if (this._loginIdentity !== null) {
        return {
          changed: true,
          identity: null,
          loginGeneration: this.forceLoginLoss(),
        };
      }
      return {
        changed: false,
        identity: null,
        loginGeneration: this._loginGeneration,
      };
    }

    if (sameLoginIdentity(this._loginIdentity, nextIdentity)) {
      return {
        changed: false,
        identity: nextIdentity,
        loginGeneration: this._loginGeneration,
      };
    }

    this._loginGeneration += 1;
    this._overviewGeneration = 0;
    this._loginIdentity = nextIdentity;
    this._activeWorkspaceId = null;
    this._activeConversationId = null;
    this.revokedWorkspaces.clear();
    return {
      changed: true,
      identity: nextIdentity,
      loginGeneration: this._loginGeneration,
    };
  }

  /**
   * Unconditionally bump `loginGeneration` and clear the tracked login identity.
   * Used on sign-out, storage removal, terminal session loss, and bfcache retirement.
   */
  forceLoginLoss(): number {
    this._loginGeneration += 1;
    this._overviewGeneration = 0;
    this._loginIdentity = null;
    this._activeWorkspaceId = null;
    this._activeConversationId = null;
    this.revokedWorkspaces.clear();
    return this._loginGeneration;
  }

  setActiveWorkspace(workspaceId: string | null): void {
    const normalized = normalizeScopeId(workspaceId);
    if (normalized !== null && this.revokedWorkspaces.has(normalized)) {
      return;
    }
    if (this._activeWorkspaceId === normalized) return;
    this._activeWorkspaceId = normalized;
    this._activeConversationId = null;
  }

  setActiveConversation(conversationId: string | null): void {
    this._activeConversationId = normalizeScopeId(conversationId);
  }

  retireWorkspace(workspaceId: string): number {
    const normalized = normalizeScopeId(workspaceId);
    if (!normalized) return 0;
    const next = (this.workspaceGenerations.get(normalized) ?? 0) + 1;
    this.workspaceGenerations.set(normalized, next);
    this.revokedWorkspaces.add(normalized);
    this._overviewGeneration += 1;
    if (this._activeWorkspaceId === normalized) {
      this._activeWorkspaceId = null;
      this._activeConversationId = null;
    }
    return next;
  }

  retireConversation(conversationId: string): number {
    const normalized = normalizeScopeId(conversationId);
    if (!normalized) return 0;
    const next = (this.conversationGenerations.get(normalized) ?? 0) + 1;
    this.conversationGenerations.set(normalized, next);
    this._overviewGeneration += 1;
    if (this._activeConversationId === normalized) {
      this._activeConversationId = null;
    }
    return next;
  }

  capture(scope?: {
    workspaceId?: string | null;
    conversationId?: string | null;
    includeOverview?: boolean;
  }): Fence {
    const workspaceId =
      scope && 'workspaceId' in scope
        ? normalizeScopeId(scope.workspaceId)
        : this._activeWorkspaceId;
    const conversationId =
      scope && 'conversationId' in scope
        ? normalizeScopeId(scope.conversationId)
        : this._activeConversationId;

    return {
      loginGeneration: this._loginGeneration,
      userId: this._loginIdentity?.userId ?? null,
      sessionId: this._loginIdentity?.sessionId ?? null,
      workspaceId,
      workspaceGeneration: this.getWorkspaceGeneration(workspaceId),
      conversationId,
      conversationGeneration: this.getConversationGeneration(conversationId),
      ...(scope?.includeOverview
        ? { overviewGeneration: this._overviewGeneration }
        : {}),
    };
  }

  isCurrent(fence: Fence, options: FenceCheckOptions = {}): boolean {
    if (fence.loginGeneration !== this._loginGeneration) return false;
    if (!fence.userId || !fence.sessionId) return false;
    const expected: LoginIdentity = {
      userId: fence.userId,
      sessionId: fence.sessionId,
    };
    if (!sameLoginIdentity(this._loginIdentity, expected)) return false;

    if (
      options.loginIdentity !== undefined &&
      !sameLoginIdentity(options.loginIdentity, expected)
    ) {
      return false;
    }

    if (
      fence.overviewGeneration !== undefined &&
      fence.overviewGeneration !== this._overviewGeneration
    ) {
      return false;
    }

    if (fence.workspaceId !== null) {
      if (this.revokedWorkspaces.has(fence.workspaceId)) {
        return false;
      }
      if (this.getWorkspaceGeneration(fence.workspaceId) !== fence.workspaceGeneration) {
        return false;
      }
      if (
        options.requireActiveWorkspace !== false &&
        this._activeWorkspaceId !== fence.workspaceId
      ) {
        return false;
      }
    }

    if (fence.conversationId !== null) {
      if (
        this.getConversationGeneration(fence.conversationId) !==
        fence.conversationGeneration
      ) {
        return false;
      }
      if (
        options.requireActiveConversation !== false &&
        this._activeConversationId !== fence.conversationId
      ) {
        return false;
      }
    }

    return true;
  }
}

export function createFenceTracker(): FenceTracker {
  return new FenceTracker();
}
