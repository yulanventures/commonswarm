import { SessionExpired } from '../../../shared/browser-session/index.js';
import {
  parseAgentPresenceRows,
  type AgentPresenceRow,
} from './contracts/agent-presence';
import {
  parseChannelCreationPolicy,
  type ChannelCreationPolicy,
} from './contracts/channels';
import {
  buildConversationHistoryRequest,
  buildListConversationsRequest,
  parseConversationHistoryResponse,
  parseConversationsListOutcome,
  type ConversationCursor,
  type ConversationHistoryOptions,
  type ConversationSummary,
} from './contracts/conversations';
import {
  parseConversationHistoryMessageRow,
  type Signal,
} from './contracts/signals';
import type {
  DecisionQueue,
  HomeOverview,
  WaitingTodosQueue,
} from './contracts/home-contract';
import {
  homeOverviewUnavailable,
  parseDecisionQueue,
  parseHomeOverview,
  parseWaitingTodosQueue,
} from './contracts/home-decoders';
import { StaleFenceError, type Fence } from './fence';
import type { AcquiredAccessToken, SessionGate } from './session';

export class ApiDecodeError extends Error {
  override name = 'ApiDecodeError';
  constructor(message: string) {
    super(message);
  }
}

export class ApiReadError extends Error {
  override name = 'ApiReadError';
  readonly status?: number;
  readonly code?: string;
  constructor(message: string, status?: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class ConversationNotFoundError extends Error {
  override name = 'ConversationNotFoundError';
  constructor(message = "This conversation isn't available in this workspace.") {
    super(message);
  }
}

export interface ConversationHistoryPage {
  readonly conversation: ConversationSummary;
  readonly messages: Signal[];
  readonly hasMore: boolean;
  readonly nextBefore: ConversationCursor | null;
  readonly nextAfter: ConversationCursor | null;
}

export interface MyWorkspace {
  readonly id: string;
  readonly name: string;
  readonly orgId: string;
  readonly orgName: string;
  readonly leadAgentPrincipalId: string | null;
  readonly channelCreationPolicy: ChannelCreationPolicy | null;
}

export interface AgentPrincipalRow {
  readonly principalId: string;
  readonly name: string;
  readonly model: string | null;
  readonly transport: 'local' | 'hosted_mcp';
  readonly turnOnly: boolean;
  readonly ownerUserId: string | null;
  readonly workspaceId: string;
  readonly createdAt: string | null;
}

export interface AgentWakePathRow {
  readonly principalId: string;
  readonly oldestUnobservedAt: string | null;
  readonly unseenCount: number | null;
}

export interface MemberProfileRow {
  readonly userId: string;
  readonly name: string;
  readonly role: 'owner' | 'admin' | 'member';
}

export interface ReadOptions {
  readonly fence: Fence;
  readonly signal?: AbortSignal;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw abortError();
  }
}

/**
 * Acquire a fresh access token, then verify the fence IMMEDIATELY BEFORE dispatch.
 * If the fence is stale before or after token acquisition, throws `StaleFenceError`
 * and sends zero network requests.
 */
async function acquireForDispatch(
  sessionGate: SessionGate,
  fence: Fence,
  signal?: AbortSignal,
): Promise<AcquiredAccessToken> {
  checkAborted(signal);
  if (!sessionGate.fenceTracker.isCurrent(fence)) {
    throw new StaleFenceError();
  }

  const auth = await sessionGate.acquireAccessToken();
  checkAborted(signal);
  if (!auth) {
    throw new StaleFenceError('Session unavailable');
  }
  if (
    !sessionGate.fenceTracker.isCurrent(fence, { loginIdentity: auth.identity })
  ) {
    throw new StaleFenceError();
  }
  return auth;
}

function assertStillCurrent(
  sessionGate: SessionGate,
  fence: Fence,
  auth: AcquiredAccessToken,
  signal?: AbortSignal,
): void {
  checkAborted(signal);
  if (sessionGate.state.status !== 'authenticated') {
    throw new StaleFenceError('Session is not authenticated.');
  }
  if (
    !sessionGate.fenceTracker.isCurrent(fence, { loginIdentity: auth.identity })
  ) {
    throw new StaleFenceError();
  }
}

function assertValidUserBearer(auth: AcquiredAccessToken): void {
  if (
    !auth.accessToken ||
    !auth.accessToken.trim() ||
    auth.accessToken === auth.anonKey
  ) {
    throw new StaleFenceError('Missing user bearer token.');
  }
}

/**
 * Single final network transport boundary for all authenticated reads (PostgREST and Edge).
 * Binds THIS request's acquired bearer directly, refuses any API-key bearer fallback, and
 * checks the captured lifetime fence synchronously immediately before invoking `fetchImpl`.
 */
async function fencedFetch(
  sessionGate: SessionGate,
  fence: Fence,
  auth: AcquiredAccessToken,
  endpoint: string,
  init: {
    readonly method: 'GET' | 'POST';
    readonly headers: Record<string, string>;
    readonly body?: string;
  },
  signal?: AbortSignal,
): Promise<Response> {
  assertValidUserBearer(auth);
  assertStillCurrent(sessionGate, fence, auth, signal);

  const response = await sessionGate.fetchImpl(endpoint, {
    method: init.method,
    headers: {
      ...init.headers,
      authorization: `Bearer ${auth.accessToken}`,
      apikey: auth.anonKey,
    },
    ...(init.body !== undefined ? { body: init.body } : {}),
    signal,
  });

  assertStillCurrent(sessionGate, fence, auth, signal);
  return response;
}

interface PostgrestWireResult {
  readonly data: unknown;
  readonly error: { message?: string; code?: string } | null;
  readonly status: number;
}

function parsePostgrestErrorBody(
  text: string,
  status: number,
): { message?: string; code?: string } {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (isRecord(parsed)) {
      return {
        message:
          typeof parsed.message === 'string'
            ? parsed.message
            : `HTTP ${status}`,
        code: typeof parsed.code === 'string' ? parsed.code : undefined,
      };
    }
  } catch {
    // Fall back to plain-text message below.
  }
  return { message: text || `HTTP ${status}` };
}

/**
 * Execute one PostgREST GET (table/view) or POST (RPC) directly over `fencedFetch`,
 * bypassing the Supabase client's `fetchWithAuth` transport (which awaits a second
 * `auth.getSession()` and can fall back to the API key as Bearer).
 */
async function postgrestRead(
  sessionGate: SessionGate,
  fence: Fence,
  signal: AbortSignal | undefined,
  request:
    | {
        readonly kind: 'from';
        readonly schema: string;
        readonly relation: string;
        readonly params: ReadonlyArray<readonly [string, string]>;
      }
    | {
        readonly kind: 'rpc';
        readonly schema: string;
        readonly fn: string;
        readonly args?: Record<string, unknown>;
      },
): Promise<PostgrestWireResult> {
  const auth = await acquireForDispatch(sessionGate, fence, signal);
  const baseUrl = auth.url.replace(/\/+$/, '');

  let endpoint: string;
  let method: 'GET' | 'POST';
  let headers: Record<string, string>;
  let body: string | undefined;

  if (request.kind === 'from') {
    const url = new URL(`${baseUrl}/rest/v1/${request.relation}`);
    for (const [key, value] of request.params) {
      url.searchParams.set(key, value);
    }
    endpoint = url.toString();
    method = 'GET';
    headers = {
      accept: 'application/json',
      'accept-profile': request.schema,
    };
  } else {
    endpoint = `${baseUrl}/rest/v1/rpc/${request.fn}`;
    method = 'POST';
    headers = {
      accept: 'application/json',
      'content-profile': request.schema,
      'content-type': 'application/json',
    };
    body = JSON.stringify(request.args ?? {});
  }

  const response = await fencedFetch(
    sessionGate,
    fence,
    auth,
    endpoint,
    { method, headers, body },
    signal,
  );

  const text = await response.text();
  assertStillCurrent(sessionGate, fence, auth, signal);

  if (!response.ok) {
    const parsedError = parsePostgrestErrorBody(text, response.status);
    if (response.status === 401 && parsedError.code === 'session_not_found') {
      if (sessionGate.handleUnauthorized(fence, auth.identity)) {
        throw new SessionExpired();
      }
      throw new StaleFenceError();
    }
    return {
      data: null,
      error: parsedError,
      status: response.status,
    };
  }

  if (text === '') {
    return { data: null, error: null, status: response.status };
  }

  try {
    return { data: JSON.parse(text), error: null, status: response.status };
  } catch {
    return {
      data: null,
      error: { message: text },
      status: response.status,
    };
  }
}

function checkPostgrestError(
  error: { message?: string; code?: string } | null,
  status: number | undefined,
  sessionGate: SessionGate,
  fence: Fence,
): void {
  if (!error) return;
  if (status === 401 && error.code === 'session_not_found') {
    if (sessionGate.handleUnauthorized(fence)) {
      throw new SessionExpired();
    }
    throw new StaleFenceError();
  }
  throw new ApiReadError(
    error.message ?? 'CommonSwarm read failed.',
    status,
    error.code,
  );
}

const VALID_MEMBER_ROLES = new Set(['owner', 'admin', 'member']);

/**
 * `swarm_read.workspaces` (paginated by 50): active workspaces for the signed-in person.
 */
export async function readWorkspaces(
  sessionGate: SessionGate,
  options: ReadOptions,
): Promise<MyWorkspace[]> {
  const { fence, signal } = options;
  const workspaces: MyWorkspace[] = [];
  const pageSize = 50;

  for (let offset = 0; ; offset += pageSize) {
    const { data, error, status } = await postgrestRead(
      sessionGate,
      fence,
      signal,
      {
        kind: 'from',
        schema: 'swarm_read',
        relation: 'workspaces',
        params: [
          ['select', '*'],
          ['archived_at', 'is.null'],
          ['order', 'name.asc,workspace_id.asc'],
          ['offset', String(offset)],
          ['limit', String(pageSize)],
        ],
      },
    );
    checkPostgrestError(error, status, sessionGate, fence);

    if (!Array.isArray(data)) {
      throw new ApiDecodeError('workspaces_malformed');
    }

    for (const raw of data) {
      if (
        !isRecord(raw) ||
        typeof raw.workspace_id !== 'string' ||
        !raw.workspace_id.trim() ||
        typeof raw.name !== 'string'
      ) {
        throw new ApiDecodeError('workspaces_malformed');
      }
      const id = raw.workspace_id.trim().toLowerCase();
      workspaces.push({
        id,
        name: raw.name,
        orgId:
          typeof raw.org_id === 'string' && raw.org_id.trim()
            ? raw.org_id.trim().toLowerCase()
            : id,
        orgName:
          typeof raw.org_display_name === 'string'
            ? raw.org_display_name
            : raw.name,
        leadAgentPrincipalId:
          typeof raw.lead_agent_principal_id === 'string' &&
          raw.lead_agent_principal_id.trim()
            ? raw.lead_agent_principal_id.trim().toLowerCase()
            : null,
        channelCreationPolicy: parseChannelCreationPolicy(
          raw.channel_creation_policy,
        ),
      });
    }

    if (data.length < pageSize) {
      return workspaces;
    }
  }
}

/**
 * `swarm_read.rpc("home_overview")`. Returns `null` only when the rollout RPC is absent (404 / PGRST202 / 42883).
 */
export async function readHomeOverview(
  sessionGate: SessionGate,
  options: ReadOptions,
): Promise<HomeOverview | null> {
  const { fence, signal } = options;
  const { data, error, status } = await postgrestRead(
    sessionGate,
    fence,
    signal,
    {
      kind: 'rpc',
      schema: 'swarm_read',
      fn: 'home_overview',
    },
  );

  if (error) {
    if (homeOverviewUnavailable(status, error.code)) {
      return null;
    }
    checkPostgrestError(error, status, sessionGate, fence);
  }

  let parsed: HomeOverview;
  try {
    parsed = parseHomeOverview(data);
  } catch {
    throw new ApiDecodeError('home_overview_malformed');
  }

  const expectedUserId = fence.userId;
  if (
    !expectedUserId ||
    parsed.viewer_user_id.toLowerCase() !== expectedUserId.toLowerCase()
  ) {
    throw new StaleFenceError('Overview viewer identity mismatch.');
  }

  return parsed;
}

/**
 * Edge `POST /functions/v1/read` with `{ resource: "conversations", workspace_id, include_archived }`.
 */
export async function readConversations(
  sessionGate: SessionGate,
  workspaceId: string,
  options: ReadOptions & { readonly includeArchived?: boolean },
): Promise<ConversationSummary[]> {
  const { fence, signal, includeArchived = false } = options;
  const auth = await acquireForDispatch(sessionGate, fence, signal);
  const payload = buildListConversationsRequest(workspaceId, includeArchived);
  const endpoint = `${auth.url.replace(/\/+$/, '')}/functions/v1/read`;

  const response = await fencedFetch(
    sessionGate,
    fence,
    auth,
    endpoint,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    },
    signal,
  );

  assertStillCurrent(sessionGate, fence, auth, signal);

  if (response.status === 401) {
    if (sessionGate.handleUnauthorized(fence, auth.identity)) {
      throw new SessionExpired();
    }
    throw new StaleFenceError();
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    assertStillCurrent(sessionGate, fence, auth, signal);
    throw new ApiDecodeError('conversations_malformed');
  }

  assertStillCurrent(sessionGate, fence, auth, signal);

  const body = isRecord(raw) ? raw : {};
  const outcome = parseConversationsListOutcome(response.status, body);
  if (outcome.status === 'ready') {
    return outcome.conversations;
  }
  if (outcome.status === 'unsupported') {
    throw new ApiReadError(outcome.message, response.status, 'unsupported');
  }
  throw new ApiDecodeError(outcome.message);
}

function isValidOptionalCursor(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (!isRecord(value)) return false;
  return (
    typeof value.created_at === 'string' &&
    Number.isFinite(Date.parse(value.created_at)) &&
    typeof value.id === 'string' &&
    value.id.trim().length > 0
  );
}

/**
 * Edge `POST /functions/v1/read` with `{ resource: "conversation_history", ... }`.
 * Strict fail-closed decoding: any malformed row, cursor, or mismatched conversation
 * throws `ApiDecodeError` (never a partial render). 404 / `conversation_not_found`
 * throws `ConversationNotFoundError`.
 */
export async function readConversationHistory(
  sessionGate: SessionGate,
  workspaceId: string,
  conversationId: string,
  options: ReadOptions & ConversationHistoryOptions,
): Promise<ConversationHistoryPage> {
  const {
    fence,
    signal,
    before,
    after,
    limit = 50,
    includeMentions = true,
    includeReactions = false,
  } = options;
  const auth = await acquireForDispatch(sessionGate, fence, signal);
  const payload = buildConversationHistoryRequest(workspaceId, conversationId, {
    ...(before ? { before } : {}),
    ...(after ? { after } : {}),
    limit,
    includeMentions,
    includeReactions,
  });
  const endpoint = `${auth.url.replace(/\/+$/, '')}/functions/v1/read`;

  const response = await fencedFetch(
    sessionGate,
    fence,
    auth,
    endpoint,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    },
    signal,
  );

  assertStillCurrent(sessionGate, fence, auth, signal);

  if (response.status === 401) {
    if (sessionGate.handleUnauthorized(fence, auth.identity)) {
      throw new SessionExpired();
    }
    throw new StaleFenceError();
  }

  // Classify a current 404 from its HTTP status alone before awaiting or decoding the body
  // so a stalled or malformed 404 body immediately retires the conversation with the
  // existing uniform unavailable outcome.
  if (response.status === 404) {
    try {
      void response.body?.cancel().catch(() => undefined);
    } catch {
      // Ignore stream cancellation failures; status alone retires the conversation.
    }
    throw new ConversationNotFoundError();
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    assertStillCurrent(sessionGate, fence, auth, signal);
    throw new ApiDecodeError('conversation_history_malformed');
  }

  assertStillCurrent(sessionGate, fence, auth, signal);

  if (!isRecord(raw)) {
    throw new ApiDecodeError('conversation_history_malformed');
  }

  if (raw.error === 'conversation_not_found') {
    throw new ConversationNotFoundError();
  }

  if (response.status !== 200) {
    throw new ApiReadError(
      typeof raw.message === 'string' && raw.message.trim()
        ? raw.message.trim()
        : `CommonSwarm could not load this conversation (HTTP ${response.status}).`,
      response.status,
      typeof raw.error === 'string' ? raw.error : undefined,
    );
  }

  // Reject non-object items in `messages` before calling the shared decoder so malformed
  // items can never be silently filtered out into a partial render.
  if (
    !Array.isArray(raw.messages) ||
    !raw.messages.every((entry) => isRecord(entry)) ||
    (raw.has_more !== undefined && typeof raw.has_more !== 'boolean') ||
    !isValidOptionalCursor(raw.next_before) ||
    !isValidOptionalCursor(raw.next_after)
  ) {
    throw new ApiDecodeError('conversation_history_malformed');
  }

  let parsed;
  try {
    parsed = parseConversationHistoryResponse(
      response.status,
      raw,
      parseConversationHistoryMessageRow,
    );
  } catch {
    throw new ApiDecodeError('conversation_history_malformed');
  }

  if (!parsed.ok) {
    if (parsed.code === 'conversation_not_found') {
      throw new ConversationNotFoundError(parsed.message);
    }
    throw new ApiDecodeError(parsed.message);
  }

  if (
    parsed.conversation.conversationId.toLowerCase() !==
    conversationId.toLowerCase()
  ) {
    throw new ApiDecodeError('conversation_history_id_mismatch');
  }

  return {
    conversation: parsed.conversation,
    messages: parsed.messages,
    hasMore: parsed.hasMore,
    nextBefore: parsed.nextBefore,
    nextAfter: parsed.nextAfter,
  };
}

/**
 * `swarm_read.agent_principals` (paginated by 200) for one workspace.
 */
export async function readAgentPrincipals(
  sessionGate: SessionGate,
  workspaceId: string,
  options: ReadOptions,
): Promise<AgentPrincipalRow[]> {
  const { fence, signal } = options;
  const normalizedWorkspace = workspaceId.toLowerCase();
  const pageSize = 200;
  const out: AgentPrincipalRow[] = [];

  for (let offset = 0; ; offset += pageSize) {
    const { data, error, status } = await postgrestRead(
      sessionGate,
      fence,
      signal,
      {
        kind: 'from',
        schema: 'swarm_read',
        relation: 'agent_principals',
        params: [
          [
            'select',
            'principal_id,name,model,transport,turn_only,owner_user_id,revoked_at,workspace_id,created_at',
          ],
          ['workspace_id', `eq.${normalizedWorkspace}`],
          ['revoked_at', 'is.null'],
          ['order', 'name.asc,principal_id.asc'],
          ['offset', String(offset)],
          ['limit', String(pageSize)],
        ],
      },
    );
    checkPostgrestError(error, status, sessionGate, fence);

    if (!Array.isArray(data)) {
      throw new ApiDecodeError('agent_principals_malformed');
    }

    for (const raw of data) {
      if (
        !isRecord(raw) ||
        typeof raw.principal_id !== 'string' ||
        !raw.principal_id.trim() ||
        typeof raw.name !== 'string' ||
        (raw.model !== null &&
          raw.model !== undefined &&
          typeof raw.model !== 'string') ||
        (raw.owner_user_id !== null &&
          raw.owner_user_id !== undefined &&
          typeof raw.owner_user_id !== 'string') ||
        (raw.created_at !== null &&
          raw.created_at !== undefined &&
          typeof raw.created_at !== 'string') ||
        (raw.turn_only !== null &&
          raw.turn_only !== undefined &&
          typeof raw.turn_only !== 'boolean') ||
        (raw.transport !== null &&
          raw.transport !== undefined &&
          raw.transport !== 'local' &&
          raw.transport !== 'hosted_mcp')
      ) {
        throw new ApiDecodeError('agent_principals_malformed');
      }

      out.push({
        principalId: raw.principal_id.trim().toLowerCase(),
        name: raw.name,
        model: typeof raw.model === 'string' ? raw.model : null,
        transport: raw.transport === 'hosted_mcp' ? 'hosted_mcp' : 'local',
        turnOnly: raw.turn_only === true,
        ownerUserId:
          typeof raw.owner_user_id === 'string' && raw.owner_user_id.trim()
            ? raw.owner_user_id.trim().toLowerCase()
            : null,
        workspaceId:
          typeof raw.workspace_id === 'string' && raw.workspace_id.trim()
            ? raw.workspace_id.trim().toLowerCase()
            : normalizedWorkspace,
        createdAt: typeof raw.created_at === 'string' ? raw.created_at : null,
      });
    }

    if (data.length < pageSize) {
      return out;
    }
  }
}

/**
 * `swarm_read.agent_presence` (paginated by 200) for one workspace.
 */
export async function readAgentPresence(
  sessionGate: SessionGate,
  workspaceId: string,
  options: ReadOptions,
): Promise<Map<string, AgentPresenceRow>> {
  const { fence, signal } = options;
  const normalizedWorkspace = workspaceId.toLowerCase();
  const pageSize = 200;
  const rows: unknown[] = [];

  for (let offset = 0; ; offset += pageSize) {
    const { data, error, status } = await postgrestRead(
      sessionGate,
      fence,
      signal,
      {
        kind: 'from',
        schema: 'swarm_read',
        relation: 'agent_presence',
        params: [
          [
            'select',
            'principal_id,last_command_at,client_build,watcher_at,channel_at,listener_at,turn_at,last_ack_via,last_ack_at,current_client_build',
          ],
          ['workspace_id', `eq.${normalizedWorkspace}`],
          ['order', 'principal_id.asc'],
          ['offset', String(offset)],
          ['limit', String(pageSize)],
        ],
      },
    );
    checkPostgrestError(error, status, sessionGate, fence);

    if (!Array.isArray(data)) {
      throw new ApiDecodeError('agent_presence_malformed');
    }
    rows.push(...data);
    if (data.length < pageSize) {
      try {
        return parseAgentPresenceRows(rows);
      } catch {
        throw new ApiDecodeError('agent_presence_malformed');
      }
    }
  }
}

/**
 * `swarm_read.agent_wake_path` for one workspace.
 */
export async function readAgentWakePath(
  sessionGate: SessionGate,
  workspaceId: string,
  options: ReadOptions,
): Promise<Map<string, AgentWakePathRow>> {
  const { fence, signal } = options;
  const normalizedWorkspace = workspaceId.toLowerCase();

  const runSelect = (columns: string) =>
    postgrestRead(sessionGate, fence, signal, {
      kind: 'from',
      schema: 'swarm_read',
      relation: 'agent_wake_path',
      params: [
        ['select', columns],
        ['workspace_id', `eq.${normalizedWorkspace}`],
      ],
    });

  let res = await runSelect('principal_id,oldest_unobserved_at,unseen_count');
  if (
    res.error &&
    (res.error.code === '42703' || res.error.code === 'PGRST204')
  ) {
    res = await runSelect('principal_id,oldest_unobserved_at');
  }
  checkPostgrestError(res.error, res.status, sessionGate, fence);

  if (!Array.isArray(res.data)) {
    throw new ApiDecodeError('agent_wake_path_malformed');
  }

  const map = new Map<string, AgentWakePathRow>();
  for (const raw of res.data) {
    if (
      !isRecord(raw) ||
      typeof raw.principal_id !== 'string' ||
      !raw.principal_id.trim() ||
      (raw.oldest_unobserved_at !== null &&
        typeof raw.oldest_unobserved_at !== 'string') ||
      (raw.unseen_count !== undefined &&
        raw.unseen_count !== null &&
        (typeof raw.unseen_count !== 'number' ||
          !Number.isInteger(raw.unseen_count) ||
          raw.unseen_count < 0))
    ) {
      throw new ApiDecodeError('agent_wake_path_malformed');
    }
    const principalId = raw.principal_id.trim().toLowerCase();
    map.set(principalId, {
      principalId,
      oldestUnobservedAt: raw.oldest_unobserved_at,
      unseenCount:
        typeof raw.unseen_count === 'number' ? raw.unseen_count : null,
    });
  }
  return map;
}

/**
 * `swarm_read.member_profiles` for one workspace (limit 1000).
 */
export async function readMemberProfiles(
  sessionGate: SessionGate,
  workspaceId: string,
  options: ReadOptions,
): Promise<MemberProfileRow[]> {
  const { fence, signal } = options;
  const normalizedWorkspace = workspaceId.toLowerCase();
  const { data, error, status } = await postgrestRead(
    sessionGate,
    fence,
    signal,
    {
      kind: 'from',
      schema: 'swarm_read',
      relation: 'member_profiles',
      params: [
        ['select', 'user_id,display_name,role'],
        ['workspace_id', `eq.${normalizedWorkspace}`],
        ['limit', '1000'],
      ],
    },
  );
  checkPostgrestError(error, status, sessionGate, fence);

  if (!Array.isArray(data)) {
    throw new ApiDecodeError('member_profiles_malformed');
  }

  const members: MemberProfileRow[] = [];
  for (const raw of data) {
    if (
      !isRecord(raw) ||
      typeof raw.user_id !== 'string' ||
      !raw.user_id.trim() ||
      typeof raw.display_name !== 'string' ||
      !raw.display_name.trim() ||
      typeof raw.role !== 'string' ||
      !VALID_MEMBER_ROLES.has(raw.role)
    ) {
      throw new ApiDecodeError('member_profiles_malformed');
    }
    members.push({
      userId: raw.user_id.trim().toLowerCase(),
      name: raw.display_name,
      role: raw.role as MemberProfileRow['role'],
    });
  }
  return members;
}

/**
 * `swarm_read.rpc("decision_queue", { p_workspace_id })`.
 * Returns `null` when the server returns `null` (non-member).
 */
export async function readDecisionQueue(
  sessionGate: SessionGate,
  workspaceId: string,
  options: ReadOptions,
): Promise<DecisionQueue | null> {
  const { fence, signal } = options;
  const normalizedWorkspace = workspaceId.toLowerCase();
  const { data, error, status } = await postgrestRead(
    sessionGate,
    fence,
    signal,
    {
      kind: 'rpc',
      schema: 'swarm_read',
      fn: 'decision_queue',
      args: { p_workspace_id: normalizedWorkspace },
    },
  );
  checkPostgrestError(error, status, sessionGate, fence);

  try {
    return parseDecisionQueue(data, normalizedWorkspace);
  } catch {
    throw new ApiDecodeError('home_decision_queue_malformed');
  }
}

/**
 * `swarm_read.rpc("waiting_todos_page", { p_workspace_id, p_limit: 50 })`.
 * Returns `null` when the server returns `null` (non-member).
 */
export async function readWaitingTodos(
  sessionGate: SessionGate,
  workspaceId: string,
  options: ReadOptions,
): Promise<WaitingTodosQueue | null> {
  const { fence, signal } = options;
  const normalizedWorkspace = workspaceId.toLowerCase();
  const { data, error, status } = await postgrestRead(
    sessionGate,
    fence,
    signal,
    {
      kind: 'rpc',
      schema: 'swarm_read',
      fn: 'waiting_todos_page',
      args: {
        p_workspace_id: normalizedWorkspace,
        p_limit: 50,
      },
    },
  );
  checkPostgrestError(error, status, sessionGate, fence);

  try {
    return parseWaitingTodosQueue(data, normalizedWorkspace);
  } catch {
    throw new ApiDecodeError('home_waiting_todos_malformed');
  }
}
