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
}

export interface FakeSessionHarness {
  browserSession: BrowserSession;
  fetchImpl: typeof fetch;
  postgrestCalls: RecordedPostgrestCall[];
  fetchCalls: Array<{ url: string; body: unknown; authHeader: string | null }>;
  setSession(next: Session | null): void;
  setGetSessionHandler(
    handler: (() => Promise<{ data: { session: Session | null }; error: Error | null }>) | null,
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
  const authListeners = new Set<
    (event: AuthChangeEvent, session: Session | null) => void
  >();
  const postgrestCalls: RecordedPostgrestCall[] = [];
  const fetchCalls: Array<{
    url: string;
    body: unknown;
    authHeader: string | null;
  }> = [];

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
    },
  } as unknown as SupabaseClient;

  const browserSession: BrowserSession = {
    ok: true,
    client: fakeClient,
    storageKey: 'sb-api-auth-token',
    async currentSession() {
      return current;
    },
    async verifiedSession() {
      return current;
    },
    async boundedAuth<T>(op: Promise<T>): Promise<T> {
      return op;
    },
    async signOut() {
      current = null;
    },
  };

  const fetchImpl: typeof fetch = async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    let body: unknown = undefined;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const headers = new Headers(init?.headers);
    fetchCalls.push({
      url,
      body,
      authHeader: headers.get('authorization'),
    });
    if (init?.signal?.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }
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
    setSession(next) {
      current = next;
    },
    setGetSessionHandler(handler) {
      customGetSession = handler;
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
