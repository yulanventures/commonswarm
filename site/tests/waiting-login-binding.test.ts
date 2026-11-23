/**
 * Unit tests for single-account login binding (`session_id` claim pinning) on guarded
 * `postCommand` calls (PR #724 C3) and silent retirement in `waiting-dismissal`.
 *
 * Exercises the real bundled `commonswarm.ts` (including `client()`, `cached.auth.getSession()`,
 * `cached.auth.refreshSession()`, and `postCommand()`) with synthetic HTTP + localStorage,
 * plus pure claim-reader and controller tests — no browser required.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { afterEach, test } from "node:test";
import { createContext, runInContext } from "node:vm";
import { build } from "esbuild";
import ts from "typescript";
import { decodeJwtClaims, sessionIdFromAccessToken } from "../src/lib/jwt-claims.ts";
import { createWaitingDismissalController } from "../src/lib/waiting-dismissal.ts";

const OWNER = "33333333-3333-4333-8333-333333333333";
const WORKSPACE = "aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STORAGE_KEY = "sb-api-auth-token";

function makeJwt(claims: Record<string, unknown>, sig = "sig"): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.${sig}`;
}

function makeUser(id = OWNER) {
  return {
    id,
    aud: "authenticated",
    role: "authenticated",
    email: "owner@example.test",
    app_metadata: {},
    user_metadata: {},
    created_at: "2026-11-01T00:00:00.000Z",
  };
}

function makeSession(accessToken: string, options: { refreshToken?: string; expiresOffsetSec?: number; userId?: string } = {}) {
  const user = makeUser(options.userId ?? OWNER);
  return {
    access_token: accessToken,
    refresh_token: options.refreshToken ?? "refresh-1",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + (options.expiresOffsetSec ?? 3600),
    user,
  };
}

function makeMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    clear() { map.clear(); },
    key(index: number) { return [...map.keys()][index] ?? null; },
    getItem(key: string) { return map.get(key) ?? null; },
    setItem(key: string, value: string) { map.set(key, String(value)); },
    removeItem(key: string) { map.delete(key); },
  };
}

let cachedBundleText: string | null = null;
async function loadCommonswarmBundle(): Promise<string> {
  if (cachedBundleText) return cachedBundleText;
  const bundle = await build({
    entryPoints: [new URL("../src/lib/commonswarm.ts", import.meta.url).pathname],
    bundle: true,
    write: false,
    platform: "browser",
    format: "cjs",
    define: {
      "import.meta.env": JSON.stringify({
        PUBLIC_SUPABASE_URL: "https://api.test.invalid",
        PUBLIC_SUPABASE_ANON_KEY: "synthetic-public-key",
      }),
    },
  });
  cachedBundleText = bundle.outputFiles[0]!.text;
  return cachedBundleText;
}

interface CommandCall {
  command_id: string;
  kind: string;
  bearer: string;
}

const activeEnvs: Array<{ dispose: () => Promise<void> }> = [];

async function createIsolatedClientEnv(handlers: {
  initialStorageSession?: ReturnType<typeof makeSession> | null;
  onRefresh?: (body: Record<string, unknown> | null) => Promise<Response> | Response;
  onCommand?: (call: CommandCall, attemptIndex: number) => Promise<Response> | Response;
}) {
  const code = await loadCommonswarmBundle();
  const storage = makeMemoryStorage();
  if (handlers.initialStorageSession) {
    storage.setItem(STORAGE_KEY, JSON.stringify(handlers.initialStorageSession));
  }
  const commandCalls: CommandCall[] = [];
  let refreshCalls = 0;

  const fetcher: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.pathname === "/auth/v1/user") {
      return Response.json(makeUser());
    }
    if (url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "refresh_token") {
      refreshCalls += 1;
      const body = await req.json().catch(() => null) as Record<string, unknown> | null;
      if (handlers.onRefresh) return await handlers.onRefresh(body);
      return Response.json({ error: "refresh_token_not_found", error_code: "refresh_token_not_found" }, { status: 400 });
    }
    if (url.pathname === "/functions/v1/command") {
      const body = await req.json().catch(() => ({})) as { command_id?: unknown; command?: { kind?: unknown } };
      const call: CommandCall = {
        command_id: String(body.command_id ?? ""),
        kind: String(body.command?.kind ?? ""),
        bearer: req.headers.get("authorization") ?? "",
      };
      commandCalls.push(call);
      if (handlers.onCommand) return await handlers.onCommand(call, commandCalls.length - 1);
      return Response.json({ status: "accepted", ok: true, event_ids: [] });
    }
    return Response.json({ error: "unexpected_path", path: url.pathname }, { status: 404 });
  };

  const activeTimers = new Set<ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>>();
  const trackedSetTimeout: typeof setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const id = setTimeout(() => { activeTimers.delete(id); fn(...args); }, ms);
    activeTimers.add(id);
    return id;
  }) as typeof setTimeout;
  const trackedClearTimeout: typeof clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
    activeTimers.delete(id);
    clearTimeout(id);
  }) as typeof clearTimeout;
  const trackedSetInterval: typeof setInterval = ((fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const id = setInterval(fn, ms, ...args);
    id.unref?.();
    activeTimers.add(id);
    return id;
  }) as typeof setInterval;
  const trackedClearInterval: typeof clearInterval = ((id: ReturnType<typeof setInterval>) => {
    activeTimers.delete(id);
    clearInterval(id);
  }) as typeof clearInterval;

  class StubWebSocket {
    readyState = 3;
    close() {}
    send() {}
  }

  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const context = createContext({
    module: { exports: {} },
    fetch: fetcher,
    AbortSignal,
    AbortController,
    setTimeout: trackedSetTimeout,
    clearTimeout: trackedClearTimeout,
    setInterval: trackedSetInterval,
    clearInterval: trackedClearInterval,
    WebSocket: StubWebSocket,
    console,
    Error,
    URL,
    URLSearchParams,
    Headers,
    Request,
    Response,
    TextEncoder,
    TextDecoder,
    atob,
    btoa,
    crypto,
    localStorage: storage,
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      let set = listeners.get(type);
      if (!set) { set = new Set(); listeners.set(type, set); }
      set.add(fn);
    },
    removeEventListener: (type: string, fn: (event: unknown) => void) => {
      listeners.get(type)?.delete(fn);
    },
    window: undefined,
    document: { querySelector: () => null },
  });
  runInContext(code, context);
  const lib = context.module.exports as typeof import("../src/lib/commonswarm.js");
  // Initialize the cached single-account Supabase client, as LiveDashboard does at boot.
  const supa = lib.client();
  assert.ok(supa, "client() initialized");
  // Ensure SDK initial load completes before test actions begin.
  await supa.auth.getSession();

  const dispose = async () => {
    try { await supa.auth.stopAutoRefresh(); } catch { /* ignore */ }
    for (const id of activeTimers) {
      clearTimeout(id as ReturnType<typeof setTimeout>);
      clearInterval(id as ReturnType<typeof setInterval>);
    }
    activeTimers.clear();
  };

  const notifyStorageChanged = (key: string | null = STORAGE_KEY) => {
    for (const fn of listeners.get("storage") ?? []) {
      fn({ key, storageArea: storage });
    }
  };

  const env = { lib, supa, storage, commandCalls, getRefreshCalls: () => refreshCalls, notifyStorageChanged, dispose };
  activeEnvs.push(env);
  return env;
}

afterEach(async () => {
  while (activeEnvs.length > 0) {
    await activeEnvs.pop()!.dispose();
  }
});

test("JWT claim reader: decodes valid session_id and rejects malformed or missing claims as unknown (null)", () => {
  const valid = makeJwt({ sub: OWNER, session_id: "sess-alpha-1", user_metadata: { name: "Renée 日本" } });
  assert.equal(decodeJwtClaims(valid)?.session_id, "sess-alpha-1");
  assert.equal(sessionIdFromAccessToken(valid), "sess-alpha-1");

  // Missing or invalid session_id claim values.
  assert.equal(sessionIdFromAccessToken(makeJwt({ sub: OWNER })), null);
  assert.equal(sessionIdFromAccessToken(makeJwt({ sub: OWNER, session_id: "" })), null);
  assert.equal(sessionIdFromAccessToken(makeJwt({ sub: OWNER, session_id: "   " })), null);
  assert.equal(sessionIdFromAccessToken(makeJwt({ sub: OWNER, session_id: 42 })), null);
  assert.equal(sessionIdFromAccessToken(makeJwt({ sub: OWNER, session_id: null })), null);
  assert.equal(sessionIdFromAccessToken(makeJwt({ sub: OWNER, session_id: { id: "x" } })), null);

  // Malformed tokens.
  for (const bad of [
    "",
    "synthetic-human",
    "only.two",
    "a.b.c.d",
    "hdr..sig",
    "hdr.!!!notbase64!!!.sig",
    "hdr.abcde.sig", // length % 4 === 1
    `hdr.${Buffer.from("not-json").toString("base64url")}.sig`,
    `hdr.${Buffer.from("[1,2,3]").toString("base64url")}.sig`,
    `hdr.${Buffer.from('"just-a-string"').toString("base64url")}.sig`,
    `hdr.${Buffer.from("null").toString("base64url")}.sig`,
  ]) {
    assert.equal(decodeJwtClaims(bad), null, `decodeJwtClaims(${JSON.stringify(bad)})`);
    assert.equal(sessionIdFromAccessToken(bad), null, `sessionIdFromAccessToken(${JSON.stringify(bad)})`);
  }
  assert.equal(sessionIdFromAccessToken(null), null);
  assert.equal(sessionIdFromAccessToken(undefined), null);
});

test("guarded postCommand retires silently with 0 dispatches on same-person different-login session after acquisition", async () => {
  const login1Jwt = makeJwt({ sub: OWNER, session_id: "sess-login-1", rev: 1 });
  const login2Jwt = makeJwt({ sub: OWNER, session_id: "sess-login-2", rev: 1 });
  const login1Session = makeSession(login1Jwt);
  const login2Session = makeSession(login2Jwt, { refreshToken: "refresh-login-2" });

  const env = await createIsolatedClientEnv({ initialStorageSession: login1Session });
  // Replace storage with a NEW login for the SAME user id (different session_id).
  env.storage.setItem(STORAGE_KEY, JSON.stringify(login2Session));
  env.notifyStorageChanged();

  const res = await env.lib.postCommand(
    login1Session as never,
    "cmd-swap-1",
    { kind: "dismiss_waiting_item", item_kind: "ask", item_id: "ask-1" },
    { workspace_id: WORKSPACE, stream: { kind: "workspace" } },
    undefined,
    { isAlive: () => true },
  );
  assert.equal(res.status, 0);
  assert.equal(res.body.error, "operation_retired");
  assert.equal(env.commandCalls.length, 0, "must dispatch zero commands under replacement login");
});

test("guarded postCommand retires silently with 0 dispatches when getSession returns empty session (never falls back)", async () => {
  const login1Jwt = makeJwt({ sub: OWNER, session_id: "sess-login-1", rev: 1 });
  const login1Session = makeSession(login1Jwt);

  const env = await createIsolatedClientEnv({ initialStorageSession: login1Session });
  // Empty storage without firing SIGNED_OUT.
  env.storage.removeItem(STORAGE_KEY);
  env.notifyStorageChanged();

  const res = await env.lib.postCommand(
    login1Session as never,
    "cmd-empty-1",
    { kind: "dismiss_waiting_item", item_kind: "ask", item_id: "ask-1" },
    { workspace_id: WORKSPACE, stream: { kind: "workspace" } },
    undefined,
    { isAlive: () => true },
  );
  assert.equal(res.status, 0);
  assert.equal(res.body.error, "operation_retired");
  assert.equal(env.commandCalls.length, 0, "must never fall back to older supplied bearer");
});

test("guarded postCommand retires silently with 0 dispatches on acquisition error or unreadable session_id", async () => {
  // 1a. Expired session whose refresh returns a terminal error (acquisition returns { error }).
  const expiredJwt = makeJwt({ sub: OWNER, session_id: "sess-login-1", rev: "expired" });
  const expiredSession = makeSession(expiredJwt, { expiresOffsetSec: -60 });
  const envErr = await createIsolatedClientEnv({
    initialStorageSession: expiredSession,
    onRefresh: () => Response.json(
      { code: "refresh_token_not_found", error_code: "refresh_token_not_found", msg: "Invalid Refresh Token" },
      { status: 400, headers: { "x-supabase-api-version": "2024-01-01" } },
    ),
  });
  const resErr = await envErr.lib.postCommand(
    expiredSession as never,
    "cmd-acq-err",
    { kind: "dismiss_waiting_item", item_kind: "ask", item_id: "ask-1" },
    { workspace_id: WORKSPACE, stream: { kind: "workspace" } },
    undefined,
    { isAlive: () => true },
  );
  assert.equal(resErr.status, 0);
  assert.equal(resErr.body.error, "operation_retired");
  assert.equal(envErr.commandCalls.length, 0, "acquisition error must retire without dispatching");

  // 1b. getSession rejects / throws (inconclusive acquisition) -> retires without dispatching.
  const validForThrow = makeSession(makeJwt({ sub: OWNER, session_id: "sess-login-1", rev: "throw" }));
  const envThrow = await createIsolatedClientEnv({ initialStorageSession: validForThrow });
  envThrow.supa.auth.getSession = () => Promise.reject(new Error("lock interrupted"));
  const resThrow = await envThrow.lib.postCommand(
    validForThrow as never,
    "cmd-acq-throw",
    { kind: "dismiss_waiting_item", item_kind: "ask", item_id: "ask-1" },
    { workspace_id: WORKSPACE, stream: { kind: "workspace" } },
    undefined,
    { isAlive: () => true },
  );
  assert.equal(resThrow.status, 0);
  assert.equal(resThrow.body.error, "operation_retired");
  assert.equal(envThrow.commandCalls.length, 0, "thrown acquisition error must retire without dispatching");

  // 2. Initiating token without a readable session_id.
  const noSidSession = makeSession(makeJwt({ sub: OWNER }));
  const envNoSid = await createIsolatedClientEnv({ initialStorageSession: noSidSession });
  const resNoSid = await envNoSid.lib.postCommand(
    noSidSession as never,
    "cmd-no-sid",
    { kind: "dismiss_waiting_item", item_kind: "ask", item_id: "ask-1" },
    { workspace_id: WORKSPACE, stream: { kind: "workspace" } },
    undefined,
    { isAlive: () => true },
  );
  assert.equal(resNoSid.status, 0);
  assert.equal(resNoSid.body.error, "operation_retired");
  assert.equal(envNoSid.commandCalls.length, 0);

  // 3. Acquired token without a readable session_id.
  const validJwt = makeJwt({ sub: OWNER, session_id: "sess-login-1", rev: 1 });
  const validSession = makeSession(validJwt);
  const envBadAcq = await createIsolatedClientEnv({ initialStorageSession: validSession });
  envBadAcq.storage.setItem(STORAGE_KEY, JSON.stringify(makeSession("malformed-token", { refreshToken: "refresh-2" })));
  envBadAcq.notifyStorageChanged();
  const resBadAcq = await envBadAcq.lib.postCommand(
    validSession as never,
    "cmd-bad-acq",
    { kind: "dismiss_waiting_item", item_kind: "ask", item_id: "ask-1" },
    { workspace_id: WORKSPACE, stream: { kind: "workspace" } },
    undefined,
    { isAlive: () => true },
  );
  assert.equal(resBadAcq.status, 0);
  assert.equal(resBadAcq.body.error, "operation_retired");
  assert.equal(envBadAcq.commandCalls.length, 0);
});

test("guarded postCommand accepts same-login token rotation and sends once with the new bearer", async () => {
  const login1Initial = makeJwt({ sub: OWNER, session_id: "sess-login-1", rev: 1 });
  const login1Rotated = makeJwt({ sub: OWNER, session_id: "sess-login-1", rev: 2 });
  const initialSession = makeSession(login1Initial);
  const rotatedSession = makeSession(login1Rotated, { refreshToken: "refresh-2" });

  const env = await createIsolatedClientEnv({ initialStorageSession: initialSession });
  env.storage.setItem(STORAGE_KEY, JSON.stringify(rotatedSession));
  env.notifyStorageChanged();

  const res = await env.lib.postCommand(
    initialSession as never,
    "cmd-rotate-1",
    { kind: "dismiss_waiting_item", item_kind: "ask", item_id: "ask-1" },
    { workspace_id: WORKSPACE, stream: { kind: "workspace" } },
    undefined,
    { isAlive: () => true },
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "accepted");
  assert.equal(env.commandCalls.length, 1);
  assert.equal(env.commandCalls[0]!.command_id, "cmd-rotate-1");
  assert.equal(env.commandCalls[0]!.bearer, `Bearer ${login1Rotated}`);
});

test("guarded postCommand 401 recovery: different login sends no retry; same-login refresh retries once with same command_id", async () => {
  const login1Initial = makeJwt({ sub: OWNER, session_id: "sess-login-1", rev: 1 });
  const login1Refreshed = makeJwt({ sub: OWNER, session_id: "sess-login-1", rev: 2 });
  const login2Jwt = makeJwt({ sub: OWNER, session_id: "sess-login-2", rev: 1 });

  // A. 401 -> storage swapped to same-person different-login during attempt 0 -> getSession yields login-2 -> NO retry.
  {
    const initialSession = makeSession(login1Initial);
    const login2Session = makeSession(login2Jwt, { refreshToken: "refresh-login-2" });
    let envRef: Awaited<ReturnType<typeof createIsolatedClientEnv>>;
    const env = await createIsolatedClientEnv({
      initialStorageSession: initialSession,
      onCommand: () => {
        envRef.storage.setItem(STORAGE_KEY, JSON.stringify(login2Session));
        envRef.notifyStorageChanged();
        return Response.json({ error: "unauthenticated", message: "expired" }, { status: 401 });
      },
    });
    envRef = env;

    const res = await env.lib.postCommand(
      initialSession as never,
      "cmd-401-swap-get",
      { kind: "restore_waiting_item", item_kind: "ask", item_id: "ask-1" },
      { workspace_id: WORKSPACE, stream: { kind: "workspace" } },
      undefined,
      { isAlive: () => true },
    );
    assert.equal(res.status, 0);
    assert.equal(res.body.error, "operation_retired");
    assert.equal(env.commandCalls.length, 1, "must NOT retry when 401 getSession yields different login");
  }

  // B. 401 -> refreshSession returns same-person different-login -> NO retry.
  {
    const initialSession = makeSession(login1Initial);
    const login2Session = makeSession(login2Jwt, { refreshToken: "refresh-login-2" });
    const env = await createIsolatedClientEnv({
      initialStorageSession: initialSession,
      onRefresh: () => Response.json(login2Session),
      onCommand: () => Response.json({ error: "unauthenticated", message: "expired" }, { status: 401 }),
    });

    const res = await env.lib.postCommand(
      initialSession as never,
      "cmd-401-swap-refresh",
      { kind: "restore_waiting_item", item_kind: "ask", item_id: "ask-1" },
      { workspace_id: WORKSPACE, stream: { kind: "workspace" } },
      undefined,
      { isAlive: () => true },
    );
    assert.equal(res.status, 0);
    assert.equal(res.body.error, "operation_retired");
    assert.equal(env.commandCalls.length, 1, "must NOT retry when 401 refreshSession yields different login");
  }

  // C. 401 -> same-login refresh returns new bearer with same session_id -> retries ONCE with exact same command_id.
  {
    const initialSession = makeSession(login1Initial);
    const refreshedSession = makeSession(login1Refreshed, { refreshToken: "refresh-2" });
    const env = await createIsolatedClientEnv({
      initialStorageSession: initialSession,
      onRefresh: () => Response.json(refreshedSession),
      onCommand: (_call, attemptIndex) =>
        attemptIndex === 0
          ? Response.json({ error: "unauthenticated", message: "expired" }, { status: 401 })
          : Response.json({ status: "accepted", ok: true, restored: true }),
    });

    const res = await env.lib.postCommand(
      initialSession as never,
      "cmd-401-same-login",
      { kind: "restore_waiting_item", item_kind: "ask", item_id: "ask-1" },
      { workspace_id: WORKSPACE, stream: { kind: "workspace" } },
      undefined,
      { isAlive: () => true },
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "accepted");
    assert.equal(env.commandCalls.length, 2);
    assert.equal(env.commandCalls[0]!.command_id, "cmd-401-same-login");
    assert.equal(env.commandCalls[1]!.command_id, "cmd-401-same-login");
    assert.equal(env.commandCalls[0]!.bearer, `Bearer ${login1Initial}`);
    assert.equal(env.commandCalls[1]!.bearer, `Bearer ${login1Refreshed}`);
  }
});

test("unguarded postCommand preserves exact existing behavior across all cases", async () => {
  const login1Initial = makeJwt({ sub: OWNER, session_id: "sess-login-1", rev: 1 });
  const login1Refreshed = makeJwt({ sub: OWNER, session_id: "sess-login-1", rev: 2 });
  const login2Jwt = makeJwt({ sub: OWNER, session_id: "sess-login-2", rev: 1 });

  // 1. Unguarded call with non-JWT token and empty storage still dispatches with supplied bearer.
  {
    const plainSession = makeSession("synthetic-human");
    const env = await createIsolatedClientEnv({ initialStorageSession: null });
    const res = await env.lib.postCommand(
      plainSession as never,
      "cmd-unguarded-1",
      { kind: "rename_workspace", name: "Home" },
      { workspace_id: WORKSPACE, stream: { kind: "workspace" } },
    );
    assert.equal(res.status, 200);
    assert.equal(env.commandCalls.length, 1);
    assert.equal(env.commandCalls[0]!.bearer, "Bearer synthetic-human");
  }

  // 2. Unguarded call on 401 with empty session still throws SessionExpired (not operation_retired).
  {
    const initialSession = makeSession(login1Initial);
    const env = await createIsolatedClientEnv({
      initialStorageSession: null,
      onCommand: () => Response.json({ error: "unauthenticated" }, { status: 401 }),
    });
    await assert.rejects(
      () => env.lib.postCommand(
        initialSession as never,
        "cmd-unguarded-empty-401",
        { kind: "rename_workspace", name: "Home" },
        { workspace_id: WORKSPACE, stream: { kind: "workspace" } },
      ),
      (err: unknown) => (err as Error)?.name === "SessionExpired",
    );
    assert.equal(env.commandCalls.length, 1);
  }

  // 3. Unguarded call on 401 with refresh error still throws AuthRecoveryRequired.
  {
    const initialSession = makeSession(login1Initial);
    const env = await createIsolatedClientEnv({
      initialStorageSession: initialSession,
      onRefresh: () => Response.json(
        { code: "refresh_token_not_found", error_code: "refresh_token_not_found", msg: "Invalid Refresh Token" },
        { status: 400, headers: { "x-supabase-api-version": "2024-01-01" } },
      ),
      onCommand: () => Response.json({ error: "unauthenticated" }, { status: 401 }),
    });
    await assert.rejects(
      () => env.lib.postCommand(
        initialSession as never,
        "cmd-unguarded-err-401",
        { kind: "rename_workspace", name: "Home" },
        { workspace_id: WORKSPACE, stream: { kind: "workspace" } },
      ),
      (err: unknown) => (err as Error)?.name === "AuthRecoveryRequired",
    );
    assert.equal(env.commandCalls.length, 1);
  }

  // 4. Unguarded call on 401 with same-user replacement login still retries as before.
  {
    const initialSession = makeSession(login1Initial);
    const login2Session = makeSession(login2Jwt, { refreshToken: "refresh-login-2" });
    const env = await createIsolatedClientEnv({
      initialStorageSession: login2Session,
      onCommand: (_call, attemptIndex) =>
        attemptIndex === 0
          ? Response.json({ error: "unauthenticated" }, { status: 401 })
          : Response.json({ status: "accepted", ok: true }),
    });
    const res = await env.lib.postCommand(
      initialSession as never,
      "cmd-unguarded-swap-401",
      { kind: "rename_workspace", name: "Home" },
      { workspace_id: WORKSPACE, stream: { kind: "workspace" } },
    );
    assert.equal(res.status, 200);
    assert.equal(env.commandCalls.length, 2);
    assert.equal(env.commandCalls[1]!.command_id, "cmd-unguarded-swap-401");
    assert.equal(env.commandCalls[1]!.bearer, `Bearer ${login2Jwt}`);
  }

  // 5. Unguarded call on 401 with same-login refresh retries once with same command_id.
  {
    const initialSession = makeSession(login1Initial);
    const refreshedSession = makeSession(login1Refreshed, { refreshToken: "refresh-2" });
    const env = await createIsolatedClientEnv({
      initialStorageSession: initialSession,
      onRefresh: () => Response.json(refreshedSession),
      onCommand: (_call, attemptIndex) =>
        attemptIndex === 0
          ? Response.json({ error: "unauthenticated" }, { status: 401 })
          : Response.json({ status: "accepted", ok: true }),
    });
    const res = await env.lib.postCommand(
      initialSession as never,
      "cmd-unguarded-refresh-401",
      { kind: "rename_workspace", name: "Home" },
      { workspace_id: WORKSPACE, stream: { kind: "workspace" } },
    );
    assert.equal(res.status, 200);
    assert.equal(env.commandCalls.length, 2);
    assert.equal(env.commandCalls[1]!.command_id, "cmd-unguarded-refresh-401");
    assert.equal(env.commandCalls[1]!.bearer, `Bearer ${login1Refreshed}`);
  }
});

test("waiting-dismissal controller settles silently on operation_retired even without a prior SIGNED_OUT", async () => {
  const retired = { ok: false as const, status: 0, error: "operation_retired", message: "Action cancelled." };
  let renders = 0;
  let reloads = 0;
  let errors = 0;
  const ctrl = createWaitingDismissalController({
    sendDismiss: async () => retired,
    sendRestore: async () => retired,
    isAlive: () => true,
    removeCardFromClient: () => {},
    reloadWaiting: () => { reloads += 1; },
    invalidateArchived: () => {},
    setCardError: () => { errors += 1; },
    setStatusError: () => { errors += 1; },
    setArchivedError: () => { errors += 1; },
    clearArchivedError: () => {},
    render: () => { renders += 1; },
  });

  // Dismiss returns operation_retired -> initial optimistic render runs once, settlement does NOT repaint or set error or reload.
  await ctrl.dismiss({
    slotKind: "ask", itemKind: "ask", itemId: "ask-1", cardId: "ask-1",
    workspaceId: WORKSPACE, channelId: null, conversationId: null, placementKind: "general",
    position: 0, placeKey: `${WORKSPACE}:general`, scope: "workspace",
  });
  assert.equal(renders, 1, "only optimistic render before dispatch; zero settlement repaint");
  assert.equal(reloads, 0);
  assert.equal(errors, 0);
  assert.equal(ctrl.has("ask:ask-1"), false);

  // Archived Restore returns operation_retired -> only initial restoring render runs, zero settlement repaint/error/reload.
  renders = 0;
  await ctrl.restoreArchived({
    itemKey: "ask:ask-2", kind: "ask", id: "ask-2", todoId: null, askKind: "choice",
    workspaceId: WORKSPACE, workspaceName: "Home", title: "Question?", from: null,
    outcomeKind: "dismissed", outcomeText: "Dismissed", archivedAt: "2026-11-23T12:00:00Z",
    when: "now", answeredBy: null, placement: "general", channelId: null,
    conversationId: null, conversationKind: "general", channelLabel: "#general", href: null,
  });
  assert.equal(renders, 1, "only initial restoring render; zero settlement repaint");
  assert.equal(reloads, 0);
  assert.equal(errors, 0);
  assert.equal(ctrl.isArchivedRestoring("ask:ask-2"), false);
});

test("LiveDashboard waitingActionGuard and queueAuthReload retire Waiting actions on same-user different-login SIGNED_IN without SIGNED_OUT", async () => {
  const astro = await readFile(new URL("../src/components/app/LiveDashboard.astro", import.meta.url), "utf8");
  const script = [...astro.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
    .map(m => m[1]!)
    .sort((a, b) => b.length - a.length)[0]!;
  const sf = ts.createSourceFile("LiveDashboard.ts", script, ts.ScriptTarget.Latest, true);
  const want = new Set(["authLoginIdFor", "waitingActionGuard", "queueAuthReload"]);
  const chunks: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && want.has(decl.name.text)) {
          chunks.push(node.getText(sf));
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  assert.equal(chunks.length, 3, "extracted authLoginIdFor, waitingActionGuard, and queueAuthReload");
  const transpiled = ts.transpileModule(chunks.join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;

  const login1Initial = makeSession(makeJwt({ sub: OWNER, session_id: "sess-1", rev: 1 }));
  const login1Rotated = makeSession(makeJwt({ sub: OWNER, session_id: "sess-1", rev: 2 }));
  const login2SameUser = makeSession(makeJwt({ sub: OWNER, session_id: "sess-2", rev: 1 }));

  let resets = 0;
  let queuedBoots = 0;
  const ctx = createContext({
    sessionIdFromAccessToken,
    isMultiAccountEnabled: () => false,
    window: { setTimeout: (fn: () => void) => { queuedBoots += 1; void fn; return 1; } },
    resetWorkspaceSessionState: () => {
      resets += 1;
      runInContext("waitingAuthGeneration += 1; waitingGeneration += 1;", ctx);
    },
    runBoot: () => {},
  });
  runInContext(`
    let sampleMode = false;
    let waitingAuthGeneration = 0;
    let waitingGeneration = 0;
    let renderedAuthUserId = ${JSON.stringify(OWNER)};
    let renderedAuthLoginId = "sess-1";
    let renderedAuthViewGen = -1;
    let requestVersion = 0;
    let authReloadQueued = false;
    let authRecoveryActive = false;
    let session = ${JSON.stringify(login1Initial)};
  `, ctx);
  runInContext(transpiled, ctx);

  runInContext("const guard = waitingActionGuard(renderedAuthUserId, waitingAuthGeneration);", ctx);
  assert.equal(runInContext("guard()", ctx), true, "guard starts alive for login 1");

  // Same-login token rotation (same user.id, same session_id): guard stays alive and queueAuthReload does not reset.
  runInContext(`session = ${JSON.stringify(login1Rotated)}; queueAuthReload(session, false, false);`, ctx);
  assert.equal(runInContext("guard()", ctx), true, "same-login rotation keeps guard alive");
  assert.equal(resets, 0);
  assert.equal(queuedBoots, 0);

  // Same-user SIGNED_IN with a DIFFERENT session_id and NO SIGNED_OUT (signedOut = false):
  // synchronously retires guard, bumps waitingAuthGeneration & waitingGeneration, and queues reload.
  runInContext(`queueAuthReload(${JSON.stringify(login2SameUser)}, false, false);`, ctx);
  assert.equal(runInContext("guard()", ctx), false, "same-user different-login SIGNED_IN retires guard immediately");
  assert.equal(resets, 1, "resetWorkspaceSessionState ran synchronously");
  assert.equal(runInContext("waitingAuthGeneration", ctx), 1);
  assert.equal(runInContext("waitingGeneration", ctx), 1);
  assert.equal(runInContext("renderedAuthLoginId", ctx), "sess-2");
  assert.equal(queuedBoots, 1);
});
