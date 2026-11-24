import type { AuthChangeEvent, Session, SupabaseClient } from '@supabase/supabase-js';
import type { BrowserSession } from '../../../shared/browser-session/index.js';

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

export function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function toBase64Url(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return globalThis
    .btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export function makeFakeJwt(claims: Record<string, unknown>): string {
  const header = toBase64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = toBase64Url(JSON.stringify(claims));
  return `${header}.${payload}.signature`;
}

export function makeFakeSession(options: {
  userId: string;
  sessionId: string;
  accessToken?: string;
  refreshToken?: string;
}): Session {
  const accessToken =
    options.accessToken ??
    makeFakeJwt({
      sub: options.userId,
      session_id: options.sessionId,
      aud: 'authenticated',
      role: 'authenticated',
    });
  return {
    access_token: accessToken,
    refresh_token: options.refreshToken ?? `refresh-${options.sessionId}`,
    expires_in: 3600,
    token_type: 'bearer',
    user: {
      id: options.userId,
      app_metadata: {},
      user_metadata: {},
      aud: 'authenticated',
      created_at: '2026-11-01T00:00:00.000Z',
    },
  };
}

export interface PostgrestResponse {
  data: unknown;
  error: { message: string; code?: string } | null;
  status?: number;
}

export interface RecordedPostgrestCall {
  kind: 'from' | 'rpc';
  target: string;
  params?: Record<string, unknown>;
  filters: Record<string, unknown>;
  select?: string;
  signal?: AbortSignal;
}

export interface FakeBackendHandlers {
  onFrom?: (call: RecordedPostgrestCall) => Promise<PostgrestResponse> | PostgrestResponse;
  onRpc?: (call: RecordedPostgrestCall) => Promise<PostgrestResponse> | PostgrestResponse;
  onFetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> | Response;
  enableRealtime?: boolean;
  realtimeEndpointUrl?: string;
  onRealtimeSetAuth?: (token: string | null | undefined) => Promise<void> | void;
}

export interface FakeRealtimeChannelRecord {
  readonly topic: string;
  readonly opts: unknown;
  removed: boolean;
  emitBroadcast(payload?: unknown): void;
  emitStatus(status: string): void;
}

export interface FakeRealtimeController {
  readonly setAuthCalls: Array<string | null | undefined>;
  readonly channels: FakeRealtimeChannelRecord[];
  readonly activeChannels: () => FakeRealtimeChannelRecord[];
  removeChannelCalls: number;
  removeAllChannelsCalls: number;
  disconnectCalls: number;
  connected: boolean;
  emitHint(payload?: unknown, topicFilter?: string): void;
  emitStatus(status: string, topicFilter?: string): void;
}

export interface RecordedWireFetchCall {
  url: string;
  method: string;
  body: unknown;
  authHeader: string | null;
  apiKeyHeader: string | null;
  profileHeader: string | null;
}

export interface FakeSessionHarness {
  browserSession: BrowserSession;
  fetchImpl: typeof fetch;
  postgrestCalls: RecordedPostgrestCall[];
  fetchCalls: RecordedWireFetchCall[];
  wireCalls: RecordedWireFetchCall[];
  realtime: FakeRealtimeController | null;
  quiesceCalls: number;
  setSession(next: Session | null): void;
  setGetSessionHandler(
    handler: (() => Promise<{ data: { session: Session | null }; error: Error | null }>) | null,
  ): void;
  setCurrentSessionHandler(
    handler: (() => Promise<Session | null>) | null,
  ): void;
  emitAuthChange(event: AuthChangeEvent, session: Session | null): void;
}

export function createFakeSessionHarness(
  initialSession: Session | null,
  handlers: FakeBackendHandlers = {},
): FakeSessionHarness {
  let current: Session | null = initialSession;
  let customGetSession:
    | (() => Promise<{ data: { session: Session | null }; error: Error | null }>)
    | null = null;
  let customCurrentSession: (() => Promise<Session | null>) | null = null;
  let quiesceCalls = 0;
  const authListeners = new Set<
    (event: AuthChangeEvent, session: Session | null) => void
  >();
  const postgrestCalls: RecordedPostgrestCall[] = [];
  const fetchCalls: RecordedWireFetchCall[] = [];
  const wireCalls: RecordedWireFetchCall[] = [];

  const rtSetAuthCalls: Array<string | null | undefined> = [];
  const rtChannels: FakeRealtimeChannelRecord[] = [];
  const rtChannelMap = new Map<object, FakeRealtimeChannelRecord>();
  let rtRemoveChannelCalls = 0;
  let rtRemoveAllChannelsCalls = 0;
  let rtDisconnectCalls = 0;
  let rtConnected = false;

  const realtimeController: FakeRealtimeController | null =
    handlers.enableRealtime
      ? {
          setAuthCalls: rtSetAuthCalls,
          channels: rtChannels,
          activeChannels: () => rtChannels.filter((c) => !c.removed),
          get removeChannelCalls() {
            return rtRemoveChannelCalls;
          },
          set removeChannelCalls(v: number) {
            rtRemoveChannelCalls = v;
          },
          get removeAllChannelsCalls() {
            return rtRemoveAllChannelsCalls;
          },
          set removeAllChannelsCalls(v: number) {
            rtRemoveAllChannelsCalls = v;
          },
          get disconnectCalls() {
            return rtDisconnectCalls;
          },
          set disconnectCalls(v: number) {
            rtDisconnectCalls = v;
          },
          get connected() {
            return rtConnected;
          },
          set connected(v: boolean) {
            rtConnected = v;
          },
          emitHint(payload = { v: 1 }, topicFilter?: string) {
            for (const ch of [...rtChannels]) {
              if (topicFilter && !ch.topic.includes(topicFilter)) continue;
              ch.emitBroadcast(payload);
            }
          },
          emitStatus(status: string, topicFilter?: string) {
            for (const ch of [...rtChannels]) {
              if (topicFilter && !ch.topic.includes(topicFilter)) continue;
              ch.emitStatus(status);
            }
          },
        }
      : null;

  function createQueryBuilder(
    kind: 'from' | 'rpc',
    target: string,
    params?: Record<string, unknown>,
  ) {
    const filters: Record<string, unknown> = {};
    let selectCols: string | undefined;
    let signal: AbortSignal | undefined;

    const execute = async (): Promise<PostgrestResponse> => {
      const call: RecordedPostgrestCall = {
        kind,
        target,
        params,
        filters: { ...filters },
        select: selectCols,
        signal,
      };
      postgrestCalls.push(call);
      if (signal?.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError');
      }
      if (kind === 'from') {
        if (handlers.onFrom) return await handlers.onFrom(call);
        return { data: [], error: null, status: 200 };
      }
      if (handlers.onRpc) return await handlers.onRpc(call);
      return { data: null, error: null, status: 200 };
    };

    const builder: Record<string, unknown> = {
      select(columns: string) {
        selectCols = columns;
        return builder;
      },
      eq(col: string, val: unknown) {
        filters[col] = val;
        return builder;
      },
      is(col: string, val: unknown) {
        filters[`is:${col}`] = val;
        return builder;
      },
      order() {
        return builder;
      },
      range(from: number, to: number) {
        filters.range = [from, to];
        return builder;
      },
      limit(count: number) {
        filters.limit = count;
        return builder;
      },
      abortSignal(sig: AbortSignal) {
        signal = sig;
        return builder;
      },
      then<TResult1 = PostgrestResponse, TResult2 = never>(
        onfulfilled?: ((value: PostgrestResponse) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ) {
        return execute().then(onfulfilled, onrejected);
      },
    };

    return builder;
  }

  const fakeClient = {
    schema(_name: string) {
      return {
        from(table: string) {
          return createQueryBuilder('from', table);
        },
        rpc(fn: string, params?: Record<string, unknown>) {
          return createQueryBuilder('rpc', fn, params);
        },
      };
    },
    auth: {
      async getSession() {
        if (customGetSession) return customGetSession();
        return { data: { session: current }, error: null };
      },
      async getUser() {
        return {
          data: { user: current?.user ?? null },
          error: current ? null : new Error('session missing'),
        };
      },
      onAuthStateChange(
        cb: (event: AuthChangeEvent, session: Session | null) => void,
      ) {
        authListeners.add(cb);
        return {
          data: {
            subscription: {
              unsubscribe() {
                authListeners.delete(cb);
              },
            },
          },
        };
      },
      async signOut() {
        current = null;
        return { error: null };
      },
      async stopAutoRefresh() {
        return;
      },
      async dispose() {
        authListeners.clear();
      },
    },
    ...(handlers.enableRealtime
      ? {
          channel(name: string, opts: unknown) {
            let broadcastCb: ((msg: unknown) => void) | null = null;
            let statusCb: ((status: string) => void) | null = null;
            const record: FakeRealtimeChannelRecord = {
              topic: name,
              opts,
              removed: false,
              emitBroadcast(payload = { v: 1 }) {
                broadcastCb?.(payload);
              },
              emitStatus(status: string) {
                statusCb?.(status);
              },
            };
            rtChannels.push(record);
            rtConnected = true;
            const channelObj = {
              on(
                _type: string,
                _filter: { event: string },
                cb: (msg: unknown) => void,
              ) {
                broadcastCb = cb;
                return channelObj;
              },
              subscribe(cb: (status: string) => void) {
                statusCb = cb;
                return channelObj;
              },
            };
            rtChannelMap.set(channelObj, record);
            return channelObj;
          },
          async removeChannel(ch: object) {
            rtRemoveChannelCalls += 1;
            const rec = rtChannelMap.get(ch);
            if (rec) rec.removed = true;
            if (rtChannels.every((c) => c.removed)) {
              rtConnected = false;
            }
            return 'ok';
          },
          getChannels() {
            return rtChannels.filter((c) => !c.removed);
          },
          async removeAllChannels() {
            rtRemoveAllChannelsCalls += 1;
            for (const c of rtChannels) c.removed = true;
            rtConnected = false;
            return [];
          },
          realtime: {
            async setAuth(token?: string | null) {
              rtSetAuthCalls.push(token);
              await handlers.onRealtimeSetAuth?.(token);
            },
            endpointURL() {
              return (
                handlers.realtimeEndpointUrl ??
                'wss://api.commonswarm.com/realtime/v1/websocket'
              );
            },
            getChannels() {
              return rtChannels.filter((c) => !c.removed);
            },
            isConnected() {
              return rtConnected;
            },
            isConnecting() {
              return false;
            },
            connectionState() {
              return rtConnected ? 'open' : 'closed';
            },
            async removeAllChannels() {
              rtRemoveAllChannelsCalls += 1;
              for (const c of rtChannels) c.removed = true;
              rtConnected = false;
              return [];
            },
            async disconnect() {
              rtDisconnectCalls += 1;
              rtConnected = false;
              return 'ok';
            },
          },
        }
      : {}),
  } as unknown as SupabaseClient;

  const browserSession: BrowserSession = {
    ok: true,
    client: fakeClient,
    storageKey: 'sb-api-auth-token',
    async currentSession() {
      if (customCurrentSession) return customCurrentSession();
      return current;
    },
    async verifiedSession() {
      if (customCurrentSession) return customCurrentSession();
      return current;
    },
    async boundedAuth<T>(op: Promise<T>): Promise<T> {
      return op;
    },
    async signOut() {
      current = null;
    },
    async quiesce() {
      quiesceCalls += 1;
      authListeners.clear();
      if (handlers.enableRealtime) {
        rtRemoveAllChannelsCalls += 1;
        for (const c of rtChannels) c.removed = true;
        rtDisconnectCalls += 1;
        rtConnected = false;
      }
    },
  };

  function postgrestResultToResponse(res: PostgrestResponse): Response {
    if (res.error) {
      return new Response(JSON.stringify(res.error), {
        status: res.status ?? 400,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(res.data), {
      status: res.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  function parsePostgrestUrl(urlStr: string): {
    kind: 'from' | 'rpc';
    target: string;
    filters: Record<string, unknown>;
    select?: string;
  } | null {
    const parsed = new URL(urlStr);
    const rpcPrefix = '/rest/v1/rpc/';
    const restPrefix = '/rest/v1/';
    if (parsed.pathname.startsWith(rpcPrefix)) {
      return {
        kind: 'rpc',
        target: parsed.pathname.slice(rpcPrefix.length),
        filters: {},
      };
    }
    if (parsed.pathname.startsWith(restPrefix)) {
      const target = parsed.pathname.slice(restPrefix.length);
      const filters: Record<string, unknown> = {};
      let selectCols: string | undefined;
      let offsetVal: number | null = null;
      let limitVal: number | null = null;

      for (const [key, value] of parsed.searchParams.entries()) {
        if (key === 'select') {
          selectCols = value;
        } else if (key === 'offset') {
          offsetVal = Number(value);
        } else if (key === 'limit') {
          limitVal = Number(value);
          filters.limit = limitVal;
        } else if (key === 'order') {
          filters.order = value;
        } else if (value.startsWith('eq.')) {
          filters[key] = value.slice(3);
        } else if (value.startsWith('is.')) {
          const raw = value.slice(3);
          filters[`is:${key}`] = raw === 'null' ? null : raw;
        } else {
          filters[key] = value;
        }
      }
      if (offsetVal !== null && limitVal !== null) {
        filters.range = [offsetVal, offsetVal + limitVal - 1];
      }
      return { kind: 'from', target, filters, select: selectCols };
    }
    return null;
  }

  const fetchImpl: typeof fetch = async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: unknown = undefined;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const headers = new Headers(init?.headers);
    const recorded: RecordedWireFetchCall = {
      url,
      method,
      body,
      authHeader: headers.get('authorization'),
      apiKeyHeader: headers.get('apikey'),
      profileHeader:
        headers.get('accept-profile') ?? headers.get('content-profile'),
    };
    wireCalls.push(recorded);

    if (init?.signal?.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }

    const pg = parsePostgrestUrl(url);
    if (pg) {
      const call: RecordedPostgrestCall = {
        kind: pg.kind,
        target: pg.target,
        params:
          pg.kind === 'rpc' && body && typeof body === 'object'
            ? (body as Record<string, unknown>)
            : undefined,
        filters: pg.filters,
        select: pg.select,
        signal: init?.signal ?? undefined,
      };
      postgrestCalls.push(call);
      if (pg.kind === 'from') {
        const res = handlers.onFrom
          ? await handlers.onFrom(call)
          : { data: [], error: null, status: 200 };
        return postgrestResultToResponse(res);
      }
      const res = handlers.onRpc
        ? await handlers.onRpc(call)
        : { data: null, error: null, status: 200 };
      return postgrestResultToResponse(res);
    }

    fetchCalls.push(recorded);
    if (handlers.onFetch) {
      return handlers.onFetch(input, init);
    }
    return new Response(JSON.stringify({ conversations: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  return {
    browserSession,
    fetchImpl,
    postgrestCalls,
    fetchCalls,
    wireCalls,
    realtime: realtimeController,
    get quiesceCalls() {
      return quiesceCalls;
    },
    setSession(next) {
      current = next;
    },
    setGetSessionHandler(handler) {
      customGetSession = handler;
    },
    setCurrentSessionHandler(handler) {
      customCurrentSession = handler;
    },
    emitAuthChange(event, session) {
      current = session;
      for (const listener of [...authListeners]) {
        listener(event, session);
      }
    },
  };
}

export function createFakeStorage(
  initial: Record<string, string> = {},
): Storage {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.get(key) ?? null;
    },
    key(index: number) {
      return [...map.keys()][index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
  };
}
