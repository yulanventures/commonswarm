import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createClient, NavigatorLockAcquireTimeoutError } from "@supabase/supabase-js";
import {
  AccountManager,
  MAX_SIGNED_IN_ACCOUNTS,
  MULTI_ACCOUNT_ENABLED,
  SIGN_IN_ATTEMPT_TTL_MS,
  accountsStorageKey,
  activeAccountStorageKey,
  attachPinnedRealtime,
  attemptStorageKey,
  deploymentOriginHash,
  legacyLockName,
  legacyStorageKey,
  loginLockName,
  postPinnedCommand,
  registryLockName,
  slotStorageKey,
  type BroadcastChannelLike,
  type HistoryLike,
  type LocationLike,
  type LockLike,
} from "../src/lib/multi-account.ts";

const DEPLOYMENT = { url: "https://example.supabase.co", anonKey: "public-anon-key" };
const ORIGIN_HASH = deploymentOriginHash(DEPLOYMENT.url);

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  failSetKeys = new Set<string>();
  failRemoveKeys = new Set<string>();
  failGetKeys = new Set<string>();
  failAllReads = false;

  get length(): number { return this.map.size; }
  clear(): void { this.map.clear(); }
  key(index: number): string | null { return [...this.map.keys()][index] ?? null; }
  getItem(key: string): string | null {
    if (this.failAllReads || this.failGetKeys.has(key)) throw new Error(`read failed: ${key}`);
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.failSetKeys.has(key)) throw new Error(`write failed: ${key}`);
    this.map.set(key, String(value));
  }
  removeItem(key: string): void {
    if (this.failRemoveKeys.has(key)) throw new Error(`remove failed: ${key}`);
    this.map.delete(key);
  }
  keys(): string[] { return [...this.map.keys()]; }
  rawGet(key: string): string | null { return this.map.get(key) ?? null; }
  rawSet(key: string, value: string): void { this.map.set(key, value); }
}

/** Deterministic cross-tab Web Locks simulator that records every lock name and order. */
class TestWebLocks {
  private chains = new Map<string, Promise<void>>();
  readonly acquired: string[] = [];
  readonly active = new Set<string>();

  readonly lock: LockLike = async <R>(name: string, acquireTimeout: number, fn: () => Promise<R>): Promise<R> => {
    if (acquireTimeout === 0 && (this.active.has(name) || this.chains.has(name))) {
      throw new NavigatorLockAcquireTimeoutError(`Lock busy: ${name}`);
    }
    const prev = this.chains.get(name) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => { release = resolve; });
    const tail = prev.then(() => mine);
    this.chains.set(name, tail);
    await prev;
    this.acquired.push(name);
    this.active.add(name);
    try {
      return await fn();
    } finally {
      this.active.delete(name);
      release();
      if (this.chains.get(name) === tail) this.chains.delete(name);
    }
  };
}

class TestBroadcastHub {
  readonly channels = new Map<string, Set<TestBroadcastChannel>>();
  readonly posted: Array<{ channel: string; message: unknown }> = [];

  create = (name: string): BroadcastChannelLike => {
    const ch = new TestBroadcastChannel(this, name);
    let set = this.channels.get(name);
    if (!set) { set = new Set(); this.channels.set(name, set); }
    set.add(ch);
    return ch;
  };
}

class TestBroadcastChannel implements BroadcastChannelLike {
  private listeners = new Set<(event: MessageEvent) => void>();
  closed = false;
  constructor(private readonly hub: TestBroadcastHub, readonly name: string) {}
  postMessage(message: unknown): void {
    if (this.closed) return;
    this.hub.posted.push({ channel: this.name, message });
    for (const peer of this.hub.channels.get(this.name) ?? []) {
      if (peer !== this && !peer.closed) {
        for (const fn of peer.listeners) fn({ data: message } as MessageEvent);
      }
    }
  }
  addEventListener(_type: "message", listener: (event: MessageEvent) => void): void {
    this.listeners.add(listener);
  }
  removeEventListener(_type: "message", listener: (event: MessageEvent) => void): void {
    this.listeners.delete(listener);
  }
  close(): void {
    this.closed = true;
    this.hub.channels.get(this.name)?.delete(this);
  }
}

function makeJwt(userId: string, email: string, sid: string): string {
  const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return [
    b64({ alg: "ES256", typ: "JWT" }),
    b64({
      aud: "authenticated",
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
      iss: `${DEPLOYMENT.url}/auth/v1`,
      role: "authenticated",
      session_id: sid,
      sub: userId,
      email,
    }),
    b64({ sig: sid }),
  ].join(".");
}

function makeUser(userId: string, email: string, name: string) {
  return {
    id: userId,
    aud: "authenticated",
    role: "authenticated",
    email,
    email_confirmed_at: "2026-10-01T00:00:00.000Z",
    app_metadata: { provider: "email", providers: ["email"] },
    user_metadata: { full_name: name },
    identities: [],
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
    is_anonymous: false,
  };
}

interface MockGoTrueState {
  sessionsByAccess: Map<string, { user: ReturnType<typeof makeUser>; refreshToken: string }>;
  sessionsByRefresh: Map<string, { user: ReturnType<typeof makeUser>; accessToken: string }>;
  pkceCodes: Map<string, { challenge: string; user: ReturnType<typeof makeUser>; providerToken?: string }>;
  otpRequests: Array<{ email: string }>;
  otpVerifies: Array<{ email: string; token: string; type: string }>;
  pkceExchanges: number;
  logouts: Array<{ scope: string | null; token: string }>;
  logoutMode: "ok" | "offline" | "500" | "session_not_found";
  refreshCount: number;
  refreshGate: Promise<void> | null;
  otpVerifyGate: Promise<void> | null;
  passwordGate: Promise<void> | null;
  pkceGate: Promise<void> | null;
  userGetGate: Promise<void> | null;
  commandResponses: Array<() => Response>;
  commandRequests: Array<{ auth: string; body: Record<string, unknown> }>;
}

function createMockGoTrue() {
  let seq = 0;
  const state: MockGoTrueState = {
    sessionsByAccess: new Map(),
    sessionsByRefresh: new Map(),
    pkceCodes: new Map(),
    otpRequests: [],
    otpVerifies: [],
    pkceExchanges: 0,
    logouts: [],
    logoutMode: "ok",
    refreshCount: 0,
    refreshGate: null,
    otpVerifyGate: null,
    passwordGate: null,
    pkceGate: null,
    userGetGate: null,
    commandResponses: [],
    commandRequests: [],
  };

  const mintSession = (user: ReturnType<typeof makeUser>, extra: Record<string, unknown> = {}) => {
    seq += 1;
    const accessToken = makeJwt(user.id, user.email, `sid-${seq}`);
    const refreshToken = `rt-${user.id.slice(0, 8)}-${seq}`;
    state.sessionsByAccess.set(accessToken, { user, refreshToken });
    state.sessionsByRefresh.set(refreshToken, { user, accessToken });
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      token_type: "bearer",
      user,
      ...extra,
    };
  };

  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const bearer = headers.get("authorization")?.replace(/^Bearer /i, "") ?? "";

    if (method === "GET" && url.pathname.endsWith("/auth/v1/user")) {
      if (state.userGetGate) await state.userGetGate;
      const found = state.sessionsByAccess.get(bearer);
      if (!found) {
        return Response.json({ code: "session_not_found", error_code: "session_not_found" }, { status: 403 });
      }
      return Response.json(found.user, { status: 200 });
    }

    if (method === "POST" && url.pathname.endsWith("/auth/v1/token") && url.searchParams.get("grant_type") === "pkce") {
      state.pkceExchanges += 1;
      if (state.pkceGate) await state.pkceGate;
      const body = JSON.parse(String(init?.body ?? "{}")) as { auth_code?: string; code_verifier?: string };
      const pending = body.auth_code ? state.pkceCodes.get(body.auth_code) : undefined;
      if (!pending || !body.code_verifier) {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body.code_verifier));
      const computed = Buffer.from(digest).toString("base64url");
      if (computed !== pending.challenge) {
        return Response.json({ error: "invalid_grant", msg: "code verifier mismatch" }, { status: 400 });
      }
      state.pkceCodes.delete(body.auth_code!);
      const extra = pending.providerToken
        ? { provider_token: pending.providerToken, provider_refresh_token: "upstream-provider-rt" }
        : {};
      return Response.json(mintSession(pending.user, extra), { status: 200 });
    }

    if (method === "POST" && url.pathname.endsWith("/auth/v1/token") && url.searchParams.get("grant_type") === "password") {
      if (state.passwordGate) await state.passwordGate;
      const body = JSON.parse(String(init?.body ?? "{}")) as { email?: string; password?: string };
      if (!body.email || body.password !== "correct-horse-battery") {
        return Response.json({ error_code: "invalid_credentials" }, { status: 400 });
      }
      const uid = body.email.startsWith("second")
        ? "22222222-2222-4222-8222-222222222222"
        : body.email.startsWith("third")
          ? "33333333-3333-4333-8333-333333333333"
          : body.email.startsWith("fourth")
            ? "44444444-4444-4444-8444-444444444444"
            : body.email.startsWith("fifth")
              ? "55555555-5555-4555-8555-555555555555"
              : body.email.startsWith("sixth")
                ? "66666666-6666-4666-8666-666666666666"
                : "11111111-1111-4111-8111-111111111111";
      const user = makeUser(uid, body.email, `User ${uid.slice(0, 4)}`);
      return Response.json(mintSession(user, { provider_token: "leak-must-strip" }), { status: 200 });
    }

    if (method === "POST" && url.pathname.endsWith("/auth/v1/token") && url.searchParams.get("grant_type") === "refresh_token") {
      state.refreshCount += 1;
      if (state.refreshGate) await state.refreshGate;
      const body = JSON.parse(String(init?.body ?? "{}")) as { refresh_token?: string };
      const found = body.refresh_token ? state.sessionsByRefresh.get(body.refresh_token) : undefined;
      if (!found) {
        return Response.json({ code: "refresh_token_not_found", error_code: "refresh_token_not_found" }, { status: 400 });
      }
      // Rotate token: invalidate old refresh_token.
      state.sessionsByRefresh.delete(body.refresh_token!);
      return Response.json(mintSession(found.user), { status: 200 });
    }

    if (method === "POST" && url.pathname.endsWith("/auth/v1/otp")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { email?: string };
      state.otpRequests.push({ email: body.email ?? "" });
      return Response.json({}, { status: 200 });
    }

    if (method === "POST" && url.pathname.endsWith("/auth/v1/verify")) {
      if (state.otpVerifyGate) await state.otpVerifyGate;
      const body = JSON.parse(String(init?.body ?? "{}")) as { email?: string; token?: string; type?: string };
      state.otpVerifies.push({ email: body.email ?? "", token: body.token ?? "", type: body.type ?? "" });
      if (body.token !== "123456") return Response.json({ error_code: "otp_expired" }, { status: 400 });
      const user = makeUser("22222222-2222-4222-8222-222222222222", body.email ?? "second@example.test", "Second Account");
      return Response.json(mintSession(user), { status: 200 });
    }

    if (method === "POST" && url.pathname.endsWith("/auth/v1/logout")) {
      state.logouts.push({ scope: url.searchParams.get("scope"), token: bearer });
      if (state.logoutMode === "offline") throw new TypeError("offline");
      if (state.logoutMode === "500") return Response.json({ msg: "server error" }, { status: 500 });
      if (state.logoutMode === "session_not_found") {
        return Response.json({ code: "session_not_found" }, { status: 403 });
      }
      const existing = state.sessionsByAccess.get(bearer);
      if (existing) {
        state.sessionsByAccess.delete(bearer);
        state.sessionsByRefresh.delete(existing.refreshToken);
      }
      return new Response(null, { status: 204 });
    }

    if (method === "POST" && url.pathname.endsWith("/functions/v1/command")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      state.commandRequests.push({ auth: bearer, body });
      const next = state.commandResponses.shift();
      return next ? next() : Response.json({ status: "accepted" }, { status: 200 });
    }

    throw new Error(`Unexpected mock fetch: ${method} ${url.href}`);
  };

  return { state, fetcher, mintSession };
}

function makeLocation(href: string): { location: LocationLike; history: HistoryLike; scrubbedUrls: string[] } {
  const u = new URL(href);
  const scrubbedUrls: string[] = [];
  const location: LocationLike = {
    get origin() { return u.origin; },
    get pathname() { return u.pathname; },
    get search() { return u.search; },
    get hash() { return u.hash; },
    get href() { return u.href; },
  };
  const history: HistoryLike = {
    replaceState(_data, _unused, nextUrl) {
      if (typeof nextUrl === "string") {
        scrubbedUrls.push(nextUrl);
        const updated = new URL(nextUrl, u.origin);
        u.pathname = updated.pathname;
        u.search = updated.search;
        u.hash = updated.hash;
      }
    },
  };
  return { location, history, scrubbedUrls };
}

// ── Tests ──────────────────────────────────────────────────────────────────────────────────────

test("PR 1 ships dormant behind MULTI_ACCOUNT_ENABLED = false and ingress Caddyfile logs no query strings", () => {
  assert.equal(MULTI_ACCOUNT_ENABLED, false);
  const caddy = readFileSync(new URL("../../deploy/site/commonswarm-site.caddy", import.meta.url), "utf8");
  assert.doesNotMatch(caddy, /^\s*log\b/m, "static site Caddyfile must not enable raw query-string access logging");
});

test("C1: direct S256 PKCE redirect reload promotes account, scrubs URL, strips provider tokens, and leaves staging clean", async () => {
  const ls = new MemoryStorage();
  const ss = new MemoryStorage();
  const locks = new TestWebLocks();
  const hub = new TestBroadcastHub();
  const mock = createMockGoTrue();
  let clock = 1_763_560_000_000;

  // Tab starts OAuth Add account flow -> writes ONLY attempt + S256 verifier to sessionStorage.
  const tabBeforeRedirect = new AccountManager(DEPLOYMENT, {
    localStorage: ls, sessionStorage: ss, fetcher: mock.fetcher, now: () => clock,
    webLocks: locks.lock, createBroadcastChannel: hub.create,
  });
  await tabBeforeRedirect.initialize();

  const { attemptId, authorizeUrl } = await tabBeforeRedirect.startOAuthAttempt({
    provider: "google", purpose: "add-account", returnRoute: "/app", origin: "https://commonswarm.com",
  });
  const authUrl = new URL(authorizeUrl);
  assert.equal(authUrl.pathname, "/auth/v1/authorize");
  assert.equal(authUrl.searchParams.get("code_challenge_method"), "s256");
  assert.equal(authUrl.searchParams.get("prompt"), "select_account");
  assert.ok(authUrl.searchParams.get("code_challenge"));
  const redirectBack = new URL(authUrl.searchParams.get("redirect_to")!);
  assert.equal(redirectBack.pathname, "/app");
  assert.equal(redirectBack.searchParams.get("cs_attempt"), attemptId);
  // Zero sessions persisted to localStorage or sessionStorage during staging.
  assert.equal(ls.keys().some((k) => k.includes(":login:")), false);
  assert.ok(ss.rawGet(attemptStorageKey(ORIGIN_HASH, attemptId)));
  tabBeforeRedirect.destroy();

  // GoTrue issues authorization code bound to the exact S256 challenge.
  const userA = makeUser("11111111-1111-4111-8111-111111111111", "first@example.test", "First Owner");
  mock.state.pkceCodes.set("oauth-code-1", {
    challenge: authUrl.searchParams.get("code_challenge")!,
    user: userA,
    providerToken: "google-upstream-secret-token",
  });

  // Simulated full-page reload on /app?code=oauth-code-1&cs_attempt=<attemptId>&keep=1
  const nav = makeLocation(`https://commonswarm.com/app?code=oauth-code-1&cs_attempt=${attemptId}&w=ws-1`);
  const tabAfterRedirect = new AccountManager(DEPLOYMENT, {
    localStorage: ls, sessionStorage: ss, fetcher: mock.fetcher, now: () => clock,
    webLocks: locks.lock, createBroadcastChannel: hub.create,
  });
  await tabAfterRedirect.initialize();
  const result = await tabAfterRedirect.consumeAuthCallbackBootstrap(nav.location, nav.history);

  assert.equal(result.kind, "promoted");
  assert.equal(result.account.userId, userA.id);
  assert.equal(result.purpose, "add-account");
  // URL scrubbed immediately (preserving non-auth query params like ?w=ws-1).
  assert.equal(nav.scrubbedUrls[0], "/app?w=ws-1");
  assert.equal(nav.location.search, "?w=ws-1");
  // Staging attempt & verifier completely erased after success.
  assert.equal(ss.rawGet(attemptStorageKey(ORIGIN_HASH, attemptId)), null);
  // Upstream provider_token / provider_refresh_token stripped before persisting!
  const storedRaw = ls.rawGet(slotStorageKey(ORIGIN_HASH, result.account.loginId)) ?? "";
  assert.ok(storedRaw.includes("access_token"));
  assert.equal(storedRaw.includes("google-upstream-secret-token"), false);
  assert.equal(storedRaw.includes("provider_token"), false);
  assert.equal(storedRaw.includes("provider_refresh_token"), false);

  // Replaying the same callback code/attempt fails (one-use attempt already cleared).
  const replayNav = makeLocation(`https://commonswarm.com/app?code=oauth-code-1&cs_attempt=${attemptId}`);
  const replay = await tabAfterRedirect.consumeAuthCallbackBootstrap(replayNav.location, replayNav.history);
  assert.equal(replay.kind, "refused");
  tabAfterRedirect.destroy();
});

test("C1: refuses bearer fragments, token_hash, recovery/email_change, wrong route, expired/concurrent attempts, and separate-context email; pins email OTP", async () => {
  const ls = new MemoryStorage();
  const ss = new MemoryStorage();
  const locks = new TestWebLocks();
  const hub = new TestBroadcastHub();
  const mock = createMockGoTrue();
  let clock = 1_763_560_000_000;

  const mgr = new AccountManager(DEPLOYMENT, {
    localStorage: ls, sessionStorage: ss, fetcher: mock.fetcher, now: () => clock,
    webLocks: locks.lock, createBroadcastChannel: hub.create,
  });
  await mgr.initialize();
  const first = await mgr.signInWithPasswordStaging({ email: "first@example.test", password: "correct-horse-battery" });
  assert.equal(first.kind, "promoted");

  // 1. Refuse bearer fragment, token_hash, recovery, email_change, and separate-context link without disturbing first account.
  for (const [href, expectedReason] of [
    ["https://commonswarm.com/app#access_token=evil&refresh_token=evil2", "bearer_fragment"],
    ["https://commonswarm.com/app?token_hash=abc&type=magiclink", "separate_context_email"],
    ["https://commonswarm.com/app?code=xyz&type=recovery", "unsupported_callback_type"],
    ["https://commonswarm.com/app?code=xyz&type=email_change", "unsupported_callback_type"],
    ["https://commonswarm.com/app?code=orphan-code", "separate_context_email"],
  ] as const) {
    const nav = makeLocation(href);
    const res = await mgr.consumeAuthCallbackBootstrap(nav.location, nav.history);
    assert.equal(res.kind, "refused", `${href} must be refused`);
    assert.equal(res.reason, expectedReason);
    assert.equal(nav.location.hash, "", "hash scrubbed");
    assert.equal(nav.location.search, "", "query scrubbed");
  }
  assert.equal(mgr.listAccounts().length, 1, "existing account untouched");

  // 2. Concurrent attempts + wrong route + expired attempt.
  const a1 = await mgr.startOAuthAttempt({ provider: "github", purpose: "add-account", returnRoute: "/app", origin: "https://commonswarm.com" });
  const a2 = await mgr.startOAuthAttempt({ provider: "github", purpose: "add-account", returnRoute: "/app", origin: "https://commonswarm.com" });
  // Wrong route (/invite instead of /app) refuses and wipes a1.
  const wrongRoute = makeLocation(`https://commonswarm.com/invite?code=c1&cs_attempt=${a1.attemptId}`);
  const rWrong = await mgr.consumeAuthCallbackBootstrap(wrongRoute.location, wrongRoute.history);
  assert.equal(rWrong.kind, "refused");
  assert.equal(rWrong.reason, "invalid_attempt");
  assert.equal(ss.rawGet(attemptStorageKey(ORIGIN_HASH, a1.attemptId)), null);
  // a2 still alive until expiry; advance clock past TTL -> expired_attempt & cleaned up.
  assert.ok(ss.rawGet(attemptStorageKey(ORIGIN_HASH, a2.attemptId)));
  clock += SIGN_IN_ATTEMPT_TTL_MS + 1;
  const expired = makeLocation(`https://commonswarm.com/app?code=c2&cs_attempt=${a2.attemptId}`);
  const rExp = await mgr.consumeAuthCallbackBootstrap(expired.location, expired.history);
  assert.equal(rExp.kind, "refused");
  assert.equal(rExp.reason, "expired_attempt");
  assert.equal(ss.rawGet(attemptStorageKey(ORIGIN_HASH, a2.attemptId)), null);

  // 3. Pinned-email OTP: requests and verifies using the exact normalized pinned email.
  const otp = await mgr.startEmailOtpAttempt({ email: "  Second@Example.Test  ", purpose: "add-account", returnRoute: "/app" });
  assert.equal(mock.state.otpRequests.at(-1)?.email, "second@example.test");
  const verified = await mgr.verifyEmailOtpAttempt({ attemptId: otp.attemptId, token: "123456" });
  assert.equal(verified.kind, "promoted");
  assert.equal(mock.state.otpVerifies.at(-1)?.email, "second@example.test");
  assert.equal(mock.state.otpVerifies.at(-1)?.type, "email");
  assert.equal(ss.rawGet(attemptStorageKey(ORIGIN_HASH, otp.attemptId)), null);
  assert.equal(mgr.listAccounts().length, 2);
  mgr.destroy();
});

test("C2: A->B->A switch, sign-out, and same-user re-sign-in invalidate pinned commands (401 retry) and Realtime joins", async () => {
  const ls = new MemoryStorage();
  const ss = new MemoryStorage();
  const locks = new TestWebLocks();
  const hub = new TestBroadcastHub();
  const mock = createMockGoTrue();

  const mgr = new AccountManager(DEPLOYMENT, {
    localStorage: ls, sessionStorage: ss, fetcher: mock.fetcher,
    webLocks: locks.lock, createBroadcastChannel: hub.create,
  });
  await mgr.initialize();
  const a = await mgr.signInWithPasswordStaging({ email: "first@example.test", password: "correct-horse-battery" });
  const b = await mgr.signInWithPasswordStaging({ email: "second@example.test", password: "correct-horse-battery" });
  assert.equal(a.kind, "promoted");
  assert.equal(b.kind, "promoted");

  // Switch back to A and pin context before awaiting.
  mgr.switchActiveAccount(a.account.userId);
  const pinnedA = mgr.pinContext();
  assert.ok(pinnedA && pinnedA.isCurrent());

  // A -> B -> A must invalidate pinnedA (bumped viewGeneration).
  mgr.switchActiveAccount(b.account.userId);
  assert.equal(pinnedA.isCurrent(), false);
  mgr.switchActiveAccount(a.account.userId);
  assert.equal(pinnedA.isCurrent(), false, "A -> B -> A must never revive an old confirmation or invite");

  // Held 401 command retry: switch to B while refresh is held -> 0 retry sends!
  mgr.setActiveWorkspace("ws-alpha");
  const pinnedFor401 = mgr.pinContext({ workspaceId: "ws-alpha" });
  assert.ok(pinnedFor401);

  // Wrong-destination refusal (C2): mismatched URL or anonKey refuses BEFORE any fetch!
  const requestsBeforeMismatch = mock.state.commandRequests.length;
  await assert.rejects(
    postPinnedCommand(pinnedFor401, "cmd-wrong-url", { kind: "test" }, {
      scope: { workspaceId: "ws-alpha" },
      expectedDeployment: { url: "https://evil.example.test", anonKey: DEPLOYMENT.anonKey },
      fetcher: mock.fetcher,
    }),
    { name: "DeploymentMismatch" },
  );
  await assert.rejects(
    postPinnedCommand(pinnedFor401, "cmd-wrong-key", { kind: "test" }, {
      scope: { workspaceId: "ws-alpha" },
      expectedDeployment: { url: DEPLOYMENT.url, anonKey: "wrong-anon-key" },
      fetcher: mock.fetcher,
    }),
    { name: "DeploymentMismatch" },
  );
  assert.equal(mock.state.commandRequests.length, requestsBeforeMismatch, "wrong deployment sends 0 requests");

  // Workspace A -> B -> A invalidates pinned workspace context for sends and Realtime!
  const pinnedWs = mgr.pinContext({ workspaceId: "ws-alpha" });
  assert.ok(pinnedWs && pinnedWs.isCurrent("ws-alpha"));
  mgr.setActiveWorkspace("ws-beta");
  assert.equal(pinnedWs.isCurrent("ws-alpha"), false);
  mgr.setActiveWorkspace("ws-alpha");
  assert.equal(pinnedWs.isCurrent("ws-alpha"), false, "workspace A -> B -> A must invalidate old pin");
  await assert.rejects(
    postPinnedCommand(pinnedWs, "cmd-stale-ws", { kind: "test" }, {
      scope: { workspaceId: "ws-alpha" },
      fetcher: mock.fetcher,
    }),
    { name: "AuthRecoveryRequired" },
  );
  let wsJoinCalled = false;
  assert.equal(await attachPinnedRealtime(pinnedWs, { workspaceId: "ws-alpha" }, () => { wsJoinCalled = true; return {}; }), null);
  assert.equal(wsJoinCalled, false, "stale workspace pin cannot join Realtime");
  assert.equal(mock.state.commandRequests.length, requestsBeforeMismatch, "stale workspace sends 0 commands");

  // Re-pin fresh context on ws-alpha and test held 401 retry invalidated by account switch!
  const pinnedFresh401 = mgr.pinContext({ workspaceId: "ws-alpha" });
  assert.ok(pinnedFresh401);
  let releaseRefresh!: () => void;
  mock.state.refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
  mock.state.commandResponses.push(() => Response.json({ error: "unauthenticated" }, { status: 401 }));
  const cmdPromise = postPinnedCommand(pinnedFresh401, "cmd-1", { kind: "test" }, {
    scope: { workspaceId: "ws-alpha" },
    expectedDeployment: DEPLOYMENT,
    fetcher: mock.fetcher,
  });
  // Wait for first 401 to trigger refresh on A's runtime, then switch tab to B before refresh resolves!
  await new Promise((r) => setTimeout(r, 30));
  mgr.switchActiveAccount(b.account.userId);
  releaseRefresh();
  await assert.rejects(cmdPromise, { name: "AuthRecoveryRequired" });
  assert.equal(mock.state.commandRequests.length, 1, "must not resend command after switching to B during 401 refresh");

  // Held 401 retry ALSO aborted by workspace A -> B -> A while refresh is in flight!
  mgr.switchActiveAccount(a.account.userId);
  mgr.setActiveWorkspace("ws-alpha");
  const pinnedWs401 = mgr.pinContext({ workspaceId: "ws-alpha" });
  assert.ok(pinnedWs401);
  let releaseWsRefresh!: () => void;
  mock.state.refreshGate = new Promise<void>((resolve) => { releaseWsRefresh = resolve; });
  mock.state.commandResponses.push(() => Response.json({ error: "unauthenticated" }, { status: 401 }));
  const wsCmdPromise = postPinnedCommand(pinnedWs401, "cmd-ws-401", { kind: "test" }, {
    scope: { workspaceId: "ws-alpha" },
    fetcher: mock.fetcher,
  });
  await new Promise((r) => setTimeout(r, 30));
  mgr.setActiveWorkspace("ws-beta");
  mgr.setActiveWorkspace("ws-alpha");
  releaseWsRefresh();
  await assert.rejects(wsCmdPromise, { name: "AuthRecoveryRequired" });
  assert.equal(mock.state.commandRequests.length, 2, "must not resend command after workspace A->B->A during 401 refresh");

  // Realtime join aborted if account signs out and same user re-signs-in (new loginId) mid-verify!
  mock.state.refreshGate = null;
  mgr.switchActiveAccount(a.account.userId);
  const pinnedRt = mgr.pinContext();
  assert.ok(pinnedRt);
  let joinCalled = false;
  await mgr.signOutAccount(a.account.userId, a.account.loginId);
  const a2 = await mgr.signInWithPasswordStaging({ email: "first@example.test", password: "correct-horse-battery" });
  assert.equal(a2.kind, "promoted");
  assert.notEqual(a2.account.loginId, a.account.loginId, "re-sign-in mints a fresh loginId");
  const sub = await attachPinnedRealtime(pinnedRt, "account", () => { joinCalled = true; return {}; });
  assert.equal(sub, null);
  assert.equal(joinCalled, false, "old loginId cannot join Realtime after same-user re-sign-in");
  mgr.destroy();

  // Terminal expiry: sets deadSession, disposes runtime, clears tabActive, bumps viewGeneration BEFORE onForcedTeardown.
  const lsExp = new MemoryStorage();
  const ssExp = new MemoryStorage();
  const expTeardowns: Array<{
    reason: string;
    userId?: string;
    loginId?: string;
    disposedAtCallback: boolean;
    activeAtCallback: unknown;
    pinnedCurrentAtCallback: boolean;
  }> = [];
  let rtExpRef: ReturnType<AccountManager["runtimeFor"]> = null;
  let pinnedExpRef: ReturnType<AccountManager["pinContext"]> = null;
  const expMgr = new AccountManager(DEPLOYMENT, {
    localStorage: lsExp,
    sessionStorage: ssExp,
    fetcher: mock.fetcher,
    webLocks: locks.lock,
    createBroadcastChannel: hub.create,
    onForcedTeardown: (d) => {
      expTeardowns.push({
        ...d,
        disposedAtCallback: rtExpRef?.isDisposed() ?? false,
        activeAtCallback: expMgr.activeAccount(),
        pinnedCurrentAtCallback: pinnedExpRef?.isCurrent() ?? true,
      });
    },
  });
  await expMgr.initialize();
  const expA = await expMgr.signInWithPasswordStaging({ email: "first@example.test", password: "correct-horse-battery" });
  assert.equal(expA.kind, "promoted");
  rtExpRef = expMgr.runtimeFor(expA.account.userId)!;
  await rtExpRef.ready();
  pinnedExpRef = expMgr.pinContext();
  assert.ok(pinnedExpRef && pinnedExpRef.isCurrent());
  // Revoke session server-side so GET /auth/v1/user returns terminal 403 session_not_found.
  mock.state.sessionsByAccess.delete(rtExpRef.peekAccessToken()!);
  await assert.rejects(rtExpRef.verifySession(), { name: "SessionExpired" });
  assert.equal(rtExpRef.isLiveOwned(), false, "terminal expiry must mark runtime dead");
  assert.equal(rtExpRef.isDisposed(), true, "terminal expiry must dispose runtime");
  assert.equal(pinnedExpRef.isCurrent(), false, "terminal expiry must invalidate pinned context");
  assert.equal(expMgr.activeAccount(), null, "terminal expiry must clear activeAccount without resurrecting from disk");
  assert.equal(expMgr.runtimeFor(expA.account.userId), null);
  assert.equal(expMgr.pinContext(), null);
  assert.equal(expTeardowns.length, 1);
  assert.equal(expTeardowns[0]!.reason, "expired");
  assert.equal(expTeardowns[0]!.userId, expA.account.userId);
  assert.equal(expTeardowns[0]!.loginId, expA.account.loginId);
  assert.equal(expTeardowns[0]!.disposedAtCallback, true, "runtime disposed BEFORE onForcedTeardown");
  assert.equal(expTeardowns[0]!.activeAtCallback, null, "tabActive cleared BEFORE onForcedTeardown");
  assert.equal(expTeardowns[0]!.pinnedCurrentAtCallback, false, "viewGeneration bumped BEFORE onForcedTeardown");

  // Fresh sign-in after terminal expiry succeeds and replaces expired login (even if an expired row sat in durable registry!).
  const freshAfterExp = await expMgr.signInWithPasswordStaging({ email: "first@example.test", password: "correct-horse-battery" });
  assert.equal(freshAfterExp.kind, "promoted", "fresh sign-in after expiry must promote instead of keeping expired row");
  assert.notEqual(freshAfterExp.account.loginId, expA.account.loginId);
  // Also test stale expired row still in durable registry from another tab/restart (never locally verified yet):
  const staleRt = expMgr.runtimeFor(freshAfterExp.account.userId)!;
  await staleRt.ready();
  mock.state.sessionsByAccess.delete(staleRt.peekAccessToken()!);
  const freshMgr2 = new AccountManager(DEPLOYMENT, {
    localStorage: lsExp, sessionStorage: new MemoryStorage(), fetcher: mock.fetcher,
    webLocks: locks.lock, createBroadcastChannel: hub.create,
  });
  await freshMgr2.initialize();
  const replacedStale = await freshMgr2.signInWithPasswordStaging({ email: "first@example.test", password: "correct-horse-battery" });
  assert.equal(replacedStale.kind, "promoted", "expired durable registry row must NOT block a fresh sign-in");
  assert.equal(replacedStale.replacedLoginId, freshAfterExp.account.loginId);
  assert.notEqual(replacedStale.account.loginId, freshAfterExp.account.loginId);
  freshMgr2.destroy();
  expMgr.destroy();

  // Terminal expiry preserves an independently verified successor rotated to disk while getUser() was in flight!
  const lsSucc = new MemoryStorage();
  const succTeardowns: unknown[] = [];
  const succMgr = new AccountManager(DEPLOYMENT, {
    localStorage: lsSucc, sessionStorage: new MemoryStorage(), fetcher: mock.fetcher,
    webLocks: locks.lock, createBroadcastChannel: hub.create,
    onForcedTeardown: (d) => succTeardowns.push(d),
  });
  await succMgr.initialize();
  const succA = await succMgr.signInWithPasswordStaging({ email: "first@example.test", password: "correct-horse-battery" });
  assert.equal(succA.kind, "promoted");
  const succRt = succMgr.runtimeFor(succA.account.userId)!;
  await succRt.ready();
  const oldTok = succRt.peekAccessToken()!;
  let releaseUserGet!: () => void;
  mock.state.userGetGate = new Promise<void>((resolve) => { releaseUserGet = resolve; });
  const verifyInFlight = succRt.verifySession();
  await new Promise((r) => setTimeout(r, 20));
  // Simulate peer tab rotating session on disk & invalidating old access token while getUser() is in flight!
  mock.state.sessionsByAccess.delete(oldTok);
  const newerSession = mock.mintSession(makeUser(succA.account.userId, "first@example.test", "First Owner"));
  lsSucc.rawSet(slotStorageKey(ORIGIN_HASH, succA.account.loginId), JSON.stringify(newerSession));
  releaseUserGet();
  mock.state.userGetGate = null;
  await assert.rejects(verifyInFlight, { name: "AuthRecoveryRequired" }, "must preserve rotated successor instead of retiring");
  assert.equal(succRt.isDisposed(), false, "successor runtime must NOT be disposed");
  assert.equal(succTeardowns.length, 0, "must NOT fire forced expiry teardown when successor exists");
  succMgr.destroy();

  // initialize() fails closed cleanly on DurableOwnershipWriteError during first-load cutover.
  const lsFailInit = new MemoryStorage();
  lsFailInit.failSetKeys.add(accountsStorageKey(ORIGIN_HASH));
  const failInitMgr = new AccountManager(DEPLOYMENT, {
    localStorage: lsFailInit,
    sessionStorage: new MemoryStorage(),
    fetcher: mock.fetcher,
    webLocks: locks.lock,
    createBroadcastChannel: hub.create,
  });
  const failInitRes = await failInitMgr.initialize();
  assert.deepEqual(failInitRes, { accounts: [], active: null, cutoverClearedLegacy: false });
  failInitMgr.destroy();
});

test("C3: SDK BroadcastChannel disabled pre-init (0 credential broadcasts), durable ownership beats failed slot deletion, and failed ownership update reports unconfirmed without deleting slot", async () => {
  const ls = new MemoryStorage();
  const ss1 = new MemoryStorage();
  const ss2 = new MemoryStorage();
  const locks = new TestWebLocks();
  const hub = new TestBroadcastHub();
  const mock = createMockGoTrue();

  // Install global window, document, and BroadcastChannel spies BEFORE creating AccountManager / SupabaseClient
  // so GoTrueClient.isBrowser() is TRUE in Node (non-vacuous witness that SDK constructs & we close BroadcastChannel).
  const g = globalThis as unknown as {
    BroadcastChannel?: unknown;
    window?: unknown;
    document?: unknown;
  };
  const hasOrigBC = Object.prototype.hasOwnProperty.call(g, "BroadcastChannel");
  const hasOrigWindow = Object.prototype.hasOwnProperty.call(g, "window");
  const hasOrigDocument = Object.prototype.hasOwnProperty.call(g, "document");
  const origBC = g.BroadcastChannel;
  const origWindow = g.window;
  const origDocument = g.document;

  const globalPosts: Array<{ name: string; data: unknown }> = [];
  const constructedChannels: Array<{ name: string; closed: boolean; posts: unknown[] }> = [];
  class SpyBroadcastChannel {
    private inner: BroadcastChannelLike;
    private record: { name: string; closed: boolean; posts: unknown[] };
    constructor(readonly name: string) {
      this.inner = hub.create(name);
      this.record = { name, closed: false, posts: [] };
      constructedChannels.push(this.record);
    }
    postMessage(data: unknown) {
      this.record.posts.push(data);
      globalPosts.push({ name: this.name, data });
      this.inner.postMessage(data);
    }
    addEventListener(type: "message", fn: (e: MessageEvent) => void) { this.inner.addEventListener(type, fn); }
    removeEventListener(type: "message", fn: (e: MessageEvent) => void) { this.inner.removeEventListener(type, fn); }
    close() {
      this.record.closed = true;
      this.inner.close();
    }
  }
  g.BroadcastChannel = SpyBroadcastChannel;
  g.window = {
    addEventListener() {},
    removeEventListener() {},
    BroadcastChannel: SpyBroadcastChannel,
  };
  g.document = {
    visibilityState: "visible",
    addEventListener() {},
    removeEventListener() {},
  };

  try {
    const tab1 = new AccountManager(DEPLOYMENT, {
      localStorage: ls, sessionStorage: ss1, fetcher: mock.fetcher,
      webLocks: locks.lock, createBroadcastChannel: hub.create,
    });
    const tab2 = new AccountManager(DEPLOYMENT, {
      localStorage: ls, sessionStorage: ss2, fetcher: mock.fetcher,
      webLocks: locks.lock, createBroadcastChannel: hub.create,
    });
    await tab1.initialize();
    await tab2.initialize();

    const p1 = await tab1.signInWithPasswordStaging({ email: "first@example.test", password: "correct-horse-battery" });
    assert.equal(p1.kind, "promoted");
    const rt1 = tab1.runtimeFor(p1.account.userId)!;
    const slotKey1 = slotStorageKey(ORIGIN_HASH, p1.account.loginId);
    // Synchronously right after runtime creation (before initialize completes), SDK constructed BroadcastChannel(slotKey1)
    // and AccountSessionRuntime immediately closed it!
    const sdkChannelsForSlot1 = constructedChannels.filter((c) => c.name === slotKey1);
    assert.equal(sdkChannelsForSlot1.length, 1, "GoTrueClient must actually construct BroadcastChannel(slotKey) in browser env");
    assert.equal(sdkChannelsForSlot1[0]!.closed, true, "SDK BroadcastChannel must be closed synchronously pre-init");
    assert.equal(sdkChannelsForSlot1[0]!.posts.length, 0, "0 posts on SDK BroadcastChannel before initialize()");

    await rt1.ready();
    // Trigger an actual SDK refresh to prove INITIAL_SESSION + TOKEN_REFRESHED never post on SDK BroadcastChannel.
    const refreshed = await rt1.client.auth.refreshSession();
    assert.equal(refreshed.error, null);
    assert.equal(sdkChannelsForSlot1[0]!.posts.length, 0, "0 posts on SDK BroadcastChannel across INITIAL_SESSION + TOKEN_REFRESHED");

    // Browser-path POSITIVE CONTROL (HezSec C3/C4): without pre-init BroadcastChannel suppression,
    // a plain GoTrueClient in this exact same stubbed browser env DOES post credentials over SpyBroadcastChannel!
    const controlKey = "commonswarm:control:unsuppressed-bc";
    const controlStorage = new MemoryStorage();
    const controlSeed = mock.mintSession(makeUser("77777777-7777-4777-8777-777777777777", "control@example.test", "Control"));
    controlStorage.rawSet(controlKey, JSON.stringify(controlSeed));
    const controlClient = createClient(DEPLOYMENT.url, DEPLOYMENT.anonKey, {
      global: { fetch: mock.fetcher },
      auth: {
        storageKey: controlKey,
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
        storage: controlStorage,
        lock: locks.lock,
        skipAutoInitialize: true,
      },
    });
    await controlClient.auth.initialize();
    const controlRefresh = await controlClient.auth.refreshSession();
    assert.equal(controlRefresh.error, null);
    const controlChannels = constructedChannels.filter((c) => c.name === controlKey);
    assert.equal(controlChannels.length, 1, "control SDK constructed BroadcastChannel(controlKey)");
    assert.ok(
      controlChannels[0]!.posts.some((m) => JSON.stringify(m).includes("access_token")),
      "positive control proves SpyBroadcastChannel observes real SDK credential broadcasts when suppression is absent",
    );
    await controlClient.auth.dispose();

    // Assert ZERO access_token or refresh_token strings ever crossed ANY non-control BroadcastChannel (SDK or app)!
    for (const msg of [...globalPosts, ...hub.posted.map((p) => ({ name: p.channel, data: p.message }))]) {
      if (msg.name === controlKey) continue;
      const text = JSON.stringify(msg.data);
      assert.equal(text.includes("access_token"), false, "no access_token on BroadcastChannel");
      assert.equal(text.includes("refresh_token"), false, "no refresh_token on BroadcastChannel");
      assert.equal(text.includes("rt-"), false, "no raw refresh token value on BroadcastChannel");
    }

    // Exact lock name alignment witness (C4): SDK and AccountManager use identical lock:<slotKey>.
    const expectedLoginLock = loginLockName(ORIGIN_HASH, p1.account.loginId);
    assert.equal(expectedLoginLock, `lock:${rt1.slotKey}`);
    assert.ok(locks.acquired.includes(expectedLoginLock), "SDK refresh acquired exact lock:<slotKey>");

    // Case A (C3): FAILED Step 1 durable ownership write during logout ->
    // (1) DO NOT delete slot, DO NOT claim browserSignedOut, and DO NOT resurrect the torn-down account in this tab!
    // (2) An in-flight refresh hitting fencedResponse(400 session_not_found) after failed Step 1 MUST NOT delete slotKey from disk!
    let releaseQueuedLock!: () => void;
    const queuedLockHold = locks.lock(expectedLoginLock, -1, async () => {
      await new Promise<void>((resolve) => { releaseQueuedLock = resolve; });
    });
    await new Promise((r) => setTimeout(r, 15));
    const queuedRefreshPromise = rt1.client.auth.refreshSession();
    await new Promise((r) => setTimeout(r, 15));

    ls.failSetKeys.add(accountsStorageKey(ORIGIN_HASH));
    const failedLogout = await tab1.signOutAccount(p1.account.userId, p1.account.loginId);
    assert.equal(failedLogout.browserSignedOut, false, "must NOT report browser-wide sign-out when ownership write failed");
    assert.equal(failedLogout.localTabTornDown, true, "current tab still tears down immediately");
    assert.equal(failedLogout.slotDeleted, false, "slot must NOT be deleted when Step 1 ownership fence failed");
    assert.equal(failedLogout.nextActive, null, "torn-down account must NOT be resurrected as nextActive");
    assert.equal(tab1.activeAccount(), null, "activeAccount() must stay null in this tab after failed Step 1");
    assert.equal(tab1.runtimeFor(p1.account.userId), null, "runtimeFor() must stay null in this tab after failed Step 1");
    assert.equal(tab1.pinContext(), null, "pinContext() must stay null in this tab after failed Step 1");
    assert.equal(tab1.listAccounts().length, 0, "tab-fenced login must not appear in listAccounts()");
    assert.ok(ls.rawGet(slotKey1), "slot remains on disk because Step 1 failed");
    assert.match(failedLogout.notice ?? "", /could not be confirmed/i);

    // Release the queued lock so the in-flight refresh enters buildAuthFetch -> receives fencedResponse(400 session_not_found)
    // -> SDK calls storageAdapter.removeItem(slotKey1), which MUST clear memory only and leave localStorage intact!
    releaseQueuedLock();
    await queuedLockHold;
    const queuedRefreshRes = await queuedRefreshPromise;
    assert.ok(queuedRefreshRes.error, "fenced refresh must fail with error");
    assert.ok(ls.rawGet(slotKey1), "SDK removeItem after fenced 400 MUST NOT delete slotKey from localStorage when Step 1 failed");
    ls.failSetKeys.clear();

    // Case B (C3): SUCCEEDED Step 1 durable ownership write + FAILED Step 2 slot deletion ->
    // peer tab's held refresh CANNOT restore the slot, and a fresh restart does NOT restore the login!
    tab2.reconcile();
    const rt2 = tab2.runtimeFor(p1.account.userId)!;
    assert.ok(rt2);
    await rt2.ready();

    let releasePeerRefresh!: () => void;
    mock.state.refreshGate = new Promise<void>((resolve) => { releasePeerRefresh = resolve; });
    const peerRefreshPromise = rt2.client.auth.refreshSession();
    await new Promise((r) => setTimeout(r, 25));

    // Fail slot deletion in Step 2 while Step 1 ownership removal succeeds!
    ls.failRemoveKeys.add(slotKey1);
    const partialDeleteLogout = await tab1.signOutAccount(p1.account.userId, p1.account.loginId);
    assert.equal(partialDeleteLogout.browserSignedOut, true, "durable ownership removal succeeded");
    assert.equal(partialDeleteLogout.slotDeleted, false, "slot deletion failed as injected");
    ls.failRemoveKeys.clear();

    // Release peer tab's in-flight refresh -> its write MUST be rejected by positive durable ownership!
    releasePeerRefresh();
    const peerResult = await peerRefreshPromise;
    assert.ok(peerResult.error, "held peer refresh must fail after durable ownership removal");

    // Restart a fresh tab on the same localStorage (with orphan slot still sitting on disk): must NOT restore!
    const tab3 = new AccountManager(DEPLOYMENT, {
      localStorage: ls, sessionStorage: new MemoryStorage(), fetcher: mock.fetcher,
      webLocks: locks.lock, createBroadcastChannel: hub.create,
    });
    await tab3.initialize();
    assert.equal(tab3.listAccounts().length, 0, "restart must never restore an unowned orphan slot");

    // Case C (C3): Unreadable durable ownership fails closed for shared credentials.
    const p2 = await tab3.signInWithPasswordStaging({ email: "first@example.test", password: "correct-horse-battery" });
    assert.equal(p2.kind, "promoted");
    const rt3 = tab3.runtimeFor(p2.account.userId)!;
    ls.failGetKeys.add(accountsStorageKey(ORIGIN_HASH));
    assert.equal(tab3.listAccounts().length, 0);
    await assert.rejects(rt3.verifySession(), { name: "SessionExpired" });
    ls.failGetKeys.clear();

    // Case D (C3): Delayed BroadcastChannel message for old loginId1 after same-user re-sign-in (loginId2)
    // cannot touch loginId2's storage or call realtime.setAuth on loginId2's client.
    const rt2New = tab3.runtimeFor(p2.account.userId)!;
    await rt2New.ready();
    let setAuthCallsForNew: unknown[] = [];
    const origSetAuth = rt2New.client.realtime.setAuth.bind(rt2New.client.realtime);
    rt2New.client.realtime.setAuth = async (token?: string | null) => {
      setAuthCallsForNew.push(token);
      return origSetAuth(token);
    };
    const staleChannel = hub.create(slotKey1);
    staleChannel.postMessage({ event: "TOKEN_REFRESHED", session: { access_token: "stale-old-token", refresh_token: "stale-rt" } });
    staleChannel.close();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(setAuthCallsForNew.includes("stale-old-token"), false, "old loginId event must never reach new loginId socket");
    assert.notEqual(rt2New.peekAccessToken(), "stale-old-token");

    // Case E (C4): Concurrent 2-tab promotion of the same userId serializes cleanly under registry lock
    // -> exactly 1 owned loginId and the losing staging session is revoked with scope=local.
    const tabA = new AccountManager(DEPLOYMENT, {
      localStorage: ls, sessionStorage: new MemoryStorage(), fetcher: mock.fetcher,
      webLocks: locks.lock, createBroadcastChannel: hub.create,
    });
    const tabB = new AccountManager(DEPLOYMENT, {
      localStorage: ls, sessionStorage: new MemoryStorage(), fetcher: mock.fetcher,
      webLocks: locks.lock, createBroadcastChannel: hub.create,
    });
    await Promise.all([tabA.initialize(), tabB.initialize()]);
    const [race1, race2] = await Promise.all([
      tabA.signInWithPasswordStaging({ email: "second@example.test", password: "correct-horse-battery" }),
      tabB.signInWithPasswordStaging({ email: "second@example.test", password: "correct-horse-battery" }),
    ]);
    const kinds = [race1.kind, race2.kind].sort();
    assert.deepEqual(kinds, ["kept-existing", "promoted"], "concurrent same-user promotion promotes once and keeps existing once");
    assert.equal(tabA.listAccounts().filter((a) => a.userId === "22222222-2222-4222-8222-222222222222").length, 1);
    tabA.destroy();
    tabB.destroy();

    tab1.destroy();
    tab2.destroy();
    tab3.destroy();
  } finally {
    if (hasOrigBC) g.BroadcastChannel = origBC;
    else delete g.BroadcastChannel;
    if (hasOrigWindow) g.window = origWindow;
    else delete g.window;
    if (hasOrigDocument) g.document = origDocument;
    else delete g.document;
  }
});

test("C3 & C5: Sign out all fences held Add account, clears all browser sessions with scope=local, and ordinary sign-out preserves other devices & other accounts", async () => {
  const ls = new MemoryStorage();
  const ss = new MemoryStorage();
  const locks = new TestWebLocks();
  const hub = new TestBroadcastHub();
  const mock = createMockGoTrue();
  const teardowns: Array<{ reason: string; userId?: string }> = [];

  const tab1 = new AccountManager(DEPLOYMENT, {
    localStorage: ls, sessionStorage: ss, fetcher: mock.fetcher,
    webLocks: locks.lock, createBroadcastChannel: hub.create,
  });
  const tab2 = new AccountManager(DEPLOYMENT, {
    localStorage: ls, sessionStorage: new MemoryStorage(), fetcher: mock.fetcher,
    webLocks: locks.lock, createBroadcastChannel: hub.create,
    onForcedTeardown: (d) => teardowns.push(d),
  });
  await tab1.initialize();
  await tab2.initialize();

  const a = await tab1.signInWithPasswordStaging({ email: "first@example.test", password: "correct-horse-battery" });
  const b = await tab1.signInWithPasswordStaging({ email: "second@example.test", password: "correct-horse-battery" });
  assert.equal(a.kind, "promoted");
  assert.equal(b.kind, "promoted");
  tab2.reconcile();
  tab2.switchActiveAccount(a.account.userId);

  // Ordinary sign-out of A on this device -> scope=local ONLY, B stays signed in, tab2 viewing A tears down!
  const outA = await tab1.signOutAccount(a.account.userId, a.account.loginId);
  assert.equal(outA.browserSignedOut, true);
  assert.equal(outA.remoteRevocation.status, "confirmed");
  assert.equal(mock.state.logouts.at(-1)?.scope, "local", "ordinary sign-out uses scope=local (preserves other devices)");
  assert.equal(outA.nextActive?.userId, b.account.userId, "switches cleanly to remaining signed-in account");
  assert.equal(tab1.listAccounts().length, 1);
  assert.equal(teardowns.at(-1)?.reason, "signed-out");
  assert.equal(teardowns.at(-1)?.userId, a.account.userId);

  // Start an OAuth Add account attempt in tab2, then run Sign out all in tab1 -> cross-tab allSignOutGen fence!
  const attempt = await tab2.startOAuthAttempt({
    provider: "github", purpose: "add-account", returnRoute: "/app", origin: "https://commonswarm.com",
  });
  const challenge = new URL(attempt.authorizeUrl).searchParams.get("code_challenge")!;
  mock.state.pkceCodes.set("late-code", {
    challenge,
    user: makeUser("33333333-3333-4333-8333-333333333333", "third@example.test", "Third"),
  });

  // Step 1 failure during Sign out all: tears down current tab & fences all logins in this tab without deleting slots!
  ls.failSetKeys.add(accountsStorageKey(ORIGIN_HASH));
  const failedAll = await tab1.signOutAllAccounts();
  assert.equal(failedAll.browserSignedOut, false, "must NOT claim browser-wide sign-out all on Step 1 failure");
  assert.equal(failedAll.localTabTornDown, true, "current tab tears down immediately");
  assert.equal(failedAll.slotsDeleted, 0, "slots must NOT be deleted when Step 1 fails");
  assert.equal(tab1.activeAccount(), null, "activeAccount() must stay null after failed Sign out all");
  assert.equal(tab1.listAccounts().length, 0, "tab-fenced logins must not resurrect in listAccounts()");
  assert.equal(tab1.runtimeFor(b.account.userId), null);
  assert.equal(tab1.pinContext(), null);
  assert.ok(ls.rawGet(slotStorageKey(ORIGIN_HASH, b.account.loginId)), "slot remains on disk when Step 1 fails");
  ls.failSetKeys.clear();

  // Offline remote logout still completes durable local Sign out all and reports unconfirmed honestly.
  mock.state.logoutMode = "offline";
  const outAll = await tab1.signOutAllAccounts();
  assert.equal(outAll.browserSignedOut, true);
  assert.equal(outAll.localTabTornDown, true);
  assert.equal(outAll.remoteRevocations.length, 1);
  assert.equal(outAll.remoteRevocations[0]!.result.status, "unconfirmed");
  assert.match(outAll.notice ?? "", /could not be confirmed/i);
  assert.equal(tab1.listAccounts().length, 0);
  assert.equal(tab2.listAccounts().length, 0);

  // Late callback in tab2 for attempt started before Sign out all is fenced by allSignOutGen and refused!
  mock.state.logoutMode = "ok";
  const lateNav = makeLocation(`https://commonswarm.com/app?code=late-code&cs_attempt=${attempt.attemptId}`);
  const lateRes = await tab2.consumeAuthCallbackBootstrap(lateNav.location, lateNav.history);
  assert.equal(lateRes.kind, "refused");
  assert.equal(lateRes.reason, "fenced_by_signout_all");
  assert.equal(tab1.listAccounts().length, 0);
  assert.equal(tab2.listAccounts().length, 0);

  tab1.destroy();
  tab2.destroy();
});

test("C4: fresh-sign-in cutover waits on exact legacy lock, clears sb-<ref>-auth-token without importing, enforces 5-account cap, keeps live session on duplicate user, and falls back to memory-only without Web Locks", async () => {
  const ls = new MemoryStorage();
  const ss = new MemoryStorage();
  const locks = new TestWebLocks();
  const hub = new TestBroadcastHub();
  const mock = createMockGoTrue();

  // Seed legacy single-session key AND hold its exact deployed SDK lock `lock:sb-example-auth-token`.
  const legKey = legacyStorageKey(DEPLOYMENT.url);
  assert.equal(legKey, "sb-example-auth-token");
  ls.rawSet(legKey, JSON.stringify({ access_token: "old-legacy-at", refresh_token: "old-legacy-rt" }));

  let releaseOldTabRefresh!: () => void;
  const oldTabHold = locks.lock(legacyLockName(DEPLOYMENT.url), -1, async () => {
    await new Promise<void>((resolve) => { releaseOldTabRefresh = resolve; });
  });
  await new Promise((r) => setTimeout(r, 15));

  const mgr = new AccountManager(DEPLOYMENT, {
    localStorage: ls, sessionStorage: ss, fetcher: mock.fetcher,
    webLocks: locks.lock, createBroadcastChannel: hub.create,
  });
  let initDone = false;
  const initPromise = mgr.initialize().then((res) => { initDone = true; return res; });
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(initDone, false, "cutover must wait behind exact deployed legacy lock");

  releaseOldTabRefresh();
  await oldTabHold;
  const initRes = await initPromise;
  assert.equal(initRes.cutoverClearedLegacy, true);
  assert.equal(ls.rawGet(legKey), null, "legacy key cleared on cutover");
  assert.equal(mgr.listAccounts().length, 0, "legacy session is NEVER imported (fresh sign-in cutover)");
  // Verify lock acquisition order: registry -> legacy.
  const regIdx = locks.acquired.indexOf(registryLockName(ORIGIN_HASH));
  const legIdx = locks.acquired.indexOf(legacyLockName(DEPLOYMENT.url), regIdx);
  assert.ok(regIdx >= 0 && legIdx > regIdx, "strict lock order registry -> lock:<legacyKey>");

  // Fill to 5-account cap, verify duplicate user keeps existing live session & revokes ONLY staging session,
  // and 6th distinct user is refused with cap_reached & staging session revoked.
  const emails = [
    "first@example.test",
    "second@example.test",
    "third@example.test",
    "fourth@example.test",
    "fifth@example.test",
  ];
  const promoted: string[] = [];
  for (const email of emails) {
    const res = await mgr.signInWithPasswordStaging({ email, password: "correct-horse-battery" });
    assert.equal(res.kind, "promoted");
    promoted.push(res.account.loginId);
  }
  assert.equal(mgr.listAccounts().length, MAX_SIGNED_IN_ACCOUNTS);

  // Duplicate user ("first@example.test") keeps existing loginId and revokes ONLY the unused staging session!
  const logoutsBeforeDup = mock.state.logouts.length;
  const dup = await mgr.signInWithPasswordStaging({ email: "first@example.test", password: "correct-horse-battery" });
  assert.equal(dup.kind, "kept-existing");
  assert.equal(dup.account.loginId, promoted[0], "existing live loginId kept intact");
  assert.equal(dup.stagingRevoked.status, "confirmed");
  assert.equal(mock.state.logouts.length, logoutsBeforeDup + 1);
  assert.equal(mock.state.logouts.at(-1)?.scope, "local");

  // 6th distinct account refused at cap & unused staging session revoked!
  const sixth = await mgr.signInWithPasswordStaging({ email: "sixth@example.test", password: "correct-horse-battery" });
  assert.equal(sixth.kind, "refused");
  assert.equal(sixth.reason, "cap_reached");
  assert.equal(sixth.stagingRevoked.status, "confirmed");
  assert.equal(mgr.listAccounts().length, MAX_SIGNED_IN_ACCOUNTS);
  mgr.destroy();

  // Without Web Locks, manager falls back strictly to single-context memory-only mode (no localStorage writes).
  const lsNoLock = new MemoryStorage();
  const memMgr = new AccountManager(DEPLOYMENT, {
    localStorage: lsNoLock, sessionStorage: new MemoryStorage(), fetcher: mock.fetcher,
    webLocks: null, createBroadcastChannel: null,
  });
  assert.equal(memMgr.sharedPersistenceAvailable, false);
  await memMgr.initialize();
  const memSignIn = await memMgr.signInWithPasswordStaging({ email: "first@example.test", password: "correct-horse-battery" });
  assert.equal(memSignIn.kind, "promoted");
  assert.equal(lsNoLock.length, 0, "no rotating tokens persisted to localStorage without cross-context Web Locks");
  memMgr.destroy();
});

test("C1 hardening: held OTP/password/OAuth cancellation, Sign out all during PKCE, missing registry at promotion, bearer query scrub, and URL scrub failure", async () => {
  const ls = new MemoryStorage();
  const ss = new MemoryStorage();
  const locks = new TestWebLocks();
  const hub = new TestBroadcastHub();
  const mock = createMockGoTrue();

  const mgr = new AccountManager(DEPLOYMENT, {
    localStorage: ls, sessionStorage: ss, fetcher: mock.fetcher,
    webLocks: locks.lock, createBroadcastChannel: hub.create,
  });
  await mgr.initialize();

  // 1. Held OTP cancelled mid-exchange -> refused (attempt_cancelled) + late staging session locally revoked!
  const otp = await mgr.startEmailOtpAttempt({ email: "second@example.test", purpose: "add-account", returnRoute: "/app" });
  let releaseOtp!: () => void;
  mock.state.otpVerifyGate = new Promise<void>((resolve) => { releaseOtp = resolve; });
  const logoutsBeforeOtp = mock.state.logouts.length;
  const otpPromise = mgr.verifyEmailOtpAttempt({ attemptId: otp.attemptId, token: "123456" });
  await new Promise((r) => setTimeout(r, 15));
  mgr.cancelAttempt(otp.attemptId);
  releaseOtp();
  mock.state.otpVerifyGate = null;
  const otpRes = await otpPromise;
  assert.equal(otpRes.kind, "refused");
  assert.equal(otpRes.reason, "attempt_cancelled");
  assert.equal(mgr.listAccounts().length, 0, "cancelled OTP must NOT promote");
  assert.equal(mock.state.logouts.length, logoutsBeforeOtp + 1, "cancelled OTP must locally revoke late staging session");
  assert.equal(mock.state.logouts.at(-1)?.scope, "local");

  // 2. Held password sign-in cancelled mid-exchange -> refused (attempt_cancelled) + late session locally revoked!
  const pwAttempt = mgr.startPasswordAttempt({ purpose: "signed-out", returnRoute: "/app" });
  let releasePw!: () => void;
  mock.state.passwordGate = new Promise<void>((resolve) => { releasePw = resolve; });
  const logoutsBeforePw = mock.state.logouts.length;
  const pwPromise = mgr.signInWithPasswordStaging({
    email: "first@example.test", password: "correct-horse-battery", attemptId: pwAttempt.attemptId,
  });
  await new Promise((r) => setTimeout(r, 15));
  mgr.cancelAttempt(pwAttempt.attemptId);
  releasePw();
  mock.state.passwordGate = null;
  const pwRes = await pwPromise;
  assert.equal(pwRes.kind, "refused");
  assert.equal(pwRes.reason, "attempt_cancelled");
  assert.equal(mgr.listAccounts().length, 0, "cancelled password sign-in must NOT promote");
  assert.equal(mock.state.logouts.length, logoutsBeforePw + 1, "cancelled password must locally revoke late session");
  assert.equal(mock.state.logouts.at(-1)?.scope, "local");

  // 3. Held OAuth PKCE callback cancelled mid-exchange -> refused (attempt_cancelled) + late session locally revoked!
  const oauth = await mgr.startOAuthAttempt({
    provider: "google", purpose: "add-account", returnRoute: "/app", origin: "https://commonswarm.com",
  });
  const challenge = new URL(oauth.authorizeUrl).searchParams.get("code_challenge")!;
  mock.state.pkceCodes.set("held-oauth-code", {
    challenge,
    user: makeUser("11111111-1111-4111-8111-111111111111", "first@example.test", "First Owner"),
  });
  let releasePkce!: () => void;
  mock.state.pkceGate = new Promise<void>((resolve) => { releasePkce = resolve; });
  const logoutsBeforePkce = mock.state.logouts.length;
  const heldNav = makeLocation(`https://commonswarm.com/app?code=held-oauth-code&cs_attempt=${oauth.attemptId}`);
  const pkcePromise = mgr.consumeAuthCallbackBootstrap(heldNav.location, heldNav.history);
  await new Promise((r) => setTimeout(r, 15));
  mgr.cancelAttempt(oauth.attemptId);
  releasePkce();
  mock.state.pkceGate = null;
  const pkceRes = await pkcePromise;
  assert.equal(pkceRes.kind, "refused");
  assert.equal(pkceRes.reason, "attempt_cancelled");
  assert.equal(mgr.listAccounts().length, 0, "cancelled OAuth must NOT promote");
  assert.equal(mock.state.logouts.length, logoutsBeforePkce + 1, "cancelled OAuth must locally revoke late session");
  assert.equal(mock.state.logouts.at(-1)?.scope, "local");

  // 4. Sign out all during PKCE creation (subtle.digest held) -> startOAuthAttempt refuses & writes NO attempt!
  let releaseDigest!: () => void;
  const digestGate = new Promise<void>((resolve) => { releaseDigest = resolve; });
  const holdingSubtle = {
    digest: async (alg: AlgorithmIdentifier, data: BufferSource) => {
      await digestGate;
      return crypto.subtle.digest(alg, data);
    },
  } as unknown as SubtleCrypto;
  const pkceRaceMgr = new AccountManager(DEPLOYMENT, {
    localStorage: ls, sessionStorage: ss, fetcher: mock.fetcher,
    webLocks: locks.lock, createBroadcastChannel: hub.create, subtle: holdingSubtle,
  });
  const startPromise = pkceRaceMgr.startOAuthAttempt({
    provider: "github", purpose: "add-account", returnRoute: "/app", origin: "https://commonswarm.com",
  });
  await new Promise((r) => setTimeout(r, 15));
  await mgr.signOutAllAccounts();
  releaseDigest();
  await assert.rejects(startPromise, /cancelled|signed out/i);
  assert.equal(ss.keys().some((k) => k.includes(":attempt:")), false, "fenced PKCE start must store no attempt");
  pkceRaceMgr.destroy();

  // 5. Missing registry at promotion time -> refused (storage_unavailable), NOT rebuilt, late session revoked!
  const missingPw = mgr.startPasswordAttempt({ purpose: "signed-out", returnRoute: "/app" });
  let releaseMissing!: () => void;
  mock.state.passwordGate = new Promise<void>((resolve) => { releaseMissing = resolve; });
  const logoutsBeforeMissing = mock.state.logouts.length;
  const missingPromise = mgr.signInWithPasswordStaging({
    email: "first@example.test", password: "correct-horse-battery", attemptId: missingPw.attemptId,
  });
  await new Promise((r) => setTimeout(r, 15));
  ls.removeItem(accountsStorageKey(ORIGIN_HASH));
  releaseMissing();
  mock.state.passwordGate = null;
  const missingRes = await missingPromise;
  assert.equal(missingRes.kind, "refused");
  assert.equal(missingRes.reason, "storage_unavailable");
  assert.equal(ls.rawGet(accountsStorageKey(ORIGIN_HASH)), null, "promotion must NEVER rebuild a missing registry");
  assert.equal(mock.state.logouts.length, logoutsBeforeMissing + 1, "refused missing-registry session must be locally revoked");

  // Re-initialize clean registry for callback URL scrub tests.
  await mgr.initialize();

  // 6. Bearer fields in query string are scrubbed completely and refused with 0 PKCE exchanges!
  const exchangesBeforeQuery = mock.state.pkceExchanges;
  const bearerQueryNav = makeLocation(
    "https://commonswarm.com/app?access_token=evil-at&refresh_token=evil-rt&provider_token=evil-pt&code=c1&keep=1",
  );
  const bearerQueryRes = await mgr.consumeAuthCallbackBootstrap(bearerQueryNav.location, bearerQueryNav.history);
  assert.equal(bearerQueryRes.kind, "refused");
  assert.equal(bearerQueryRes.reason, "bearer_query");
  assert.equal(bearerQueryNav.location.search, "?keep=1", "all bearer & auth query params scrubbed");
  assert.equal(mock.state.pkceExchanges, exchangesBeforeQuery, "0 PKCE exchanges on bearer query");

  // 7. If history.replaceState throws during URL scrub, REFUSE the exchange with 0 PKCE calls!
  const oauth2 = await mgr.startOAuthAttempt({
    provider: "google", purpose: "signed-out", returnRoute: "/app", origin: "https://commonswarm.com",
  });
  const scrubFailNav = makeLocation(`https://commonswarm.com/app?code=some-code&cs_attempt=${oauth2.attemptId}`);
  const throwingHistory: HistoryLike = {
    replaceState() { throw new Error("SecurityError: replaceState blocked"); },
  };
  const scrubFailRes = await mgr.consumeAuthCallbackBootstrap(scrubFailNav.location, throwingHistory);
  assert.equal(scrubFailRes.kind, "refused");
  assert.equal(scrubFailRes.reason, "url_scrub_failed");
  assert.equal(mock.state.pkceExchanges, exchangesBeforeQuery, "0 PKCE exchanges when URL scrubbing fails");
  assert.equal(ss.rawGet(attemptStorageKey(ORIGIN_HASH, oauth2.attemptId)), null, "attempt cleared on scrub failure");

  mgr.destroy();
});

test("C3 bulk sweep: Sign out all Step 2 deletes ONLY fenced logins and preserves next-generation promotion in another tab", async () => {
  const ls = new MemoryStorage();
  const locks = new TestWebLocks();
  const hub = new TestBroadcastHub();
  const mock = createMockGoTrue();

  const tab1 = new AccountManager(DEPLOYMENT, {
    localStorage: ls, sessionStorage: new MemoryStorage(), fetcher: mock.fetcher,
    webLocks: locks.lock, createBroadcastChannel: hub.create,
  });
  const tab2 = new AccountManager(DEPLOYMENT, {
    localStorage: ls, sessionStorage: new MemoryStorage(), fetcher: mock.fetcher,
    webLocks: locks.lock, createBroadcastChannel: hub.create,
  });
  await Promise.all([tab1.initialize(), tab2.initialize()]);

  const oldA = await tab1.signInWithPasswordStaging({ email: "first@example.test", password: "correct-horse-battery" });
  assert.equal(oldA.kind, "promoted");
  const oldSlotKey = slotStorageKey(ORIGIN_HASH, oldA.account.loginId);

  // Intercept the Step 2 login lock for oldA.loginId to pause tab1 AFTER Step 1 released the registry lock
  // and BEFORE Step 2 deletes oldSlotKey — while tab2 promotes a brand-new next-generation account!
  let pausedAtStep2!: () => void;
  const reachedStep2 = new Promise<void>((resolve) => { pausedAtStep2 = resolve; });
  let releaseStep2!: () => void;
  const step2Gate = new Promise<void>((resolve) => { releaseStep2 = resolve; });
  let interceptNextOldLock = true;
  const pausingLock: LockLike = async (name, timeout, fn) => {
    if (interceptNextOldLock && name === loginLockName(ORIGIN_HASH, oldA.account.loginId) && timeout === 0) {
      interceptNextOldLock = false;
      pausedAtStep2();
      await step2Gate;
    }
    return locks.lock(name, timeout, fn);
  };
  const tab1Paused = new AccountManager(DEPLOYMENT, {
    localStorage: ls, sessionStorage: new MemoryStorage(), fetcher: mock.fetcher,
    webLocks: pausingLock, createBroadcastChannel: hub.create,
  });
  await tab1Paused.initialize();

  const bulkPromise = tab1Paused.signOutAllAccounts();
  await reachedStep2;

  // Tab 2 promotes a brand-new account B in the NEXT generation while tab1's Step 2 is still pending!
  const nextGenB = await tab2.signInWithPasswordStaging({ email: "second@example.test", password: "correct-horse-battery" });
  assert.equal(nextGenB.kind, "promoted");
  const nextGenSlotKey = slotStorageKey(ORIGIN_HASH, nextGenB.account.loginId);
  assert.ok(ls.rawGet(nextGenSlotKey));
  assert.equal(ls.rawGet(activeAccountStorageKey(ORIGIN_HASH)), nextGenB.account.userId);

  // Resume tab1's Step 2 cleanup & late broadcast!
  releaseStep2();
  const bulkRes = await bulkPromise;
  assert.equal(bulkRes.browserSignedOut, true);
  assert.equal(bulkRes.slotsDeleted, 1, "Step 2 must delete ONLY the 1 old fenced slot");
  assert.equal(ls.rawGet(oldSlotKey), null, "old fenced slot deleted");
  assert.ok(ls.rawGet(nextGenSlotKey), "next-generation slot MUST survive late bulk sweep");
  assert.equal(ls.rawGet(activeAccountStorageKey(ORIGIN_HASH)), nextGenB.account.userId, "next-gen active pointer preserved");
  assert.equal(tab2.listAccounts().length, 1);
  assert.equal(tab2.listAccounts()[0]!.loginId, nextGenB.account.loginId);
  assert.equal(tab2.runtimeFor(nextGenB.account.userId)?.isLiveOwned(), true, "next-gen runtime stays live through late broadcast");

  tab1.destroy();
  tab1Paused.destroy();
  tab2.destroy();
});

test("C3/C4 reconciliation: preserves rotated successor on slot write failure and adopts independently committed newer token under exact SDK lock", async () => {
  const ls = new MemoryStorage();
  const locks = new TestWebLocks();
  const hub = new TestBroadcastHub();
  const mock = createMockGoTrue();

  const mgr = new AccountManager(DEPLOYMENT, {
    localStorage: ls, sessionStorage: new MemoryStorage(), fetcher: mock.fetcher,
    webLocks: locks.lock, createBroadcastChannel: hub.create,
  });
  await mgr.initialize();
  const p = await mgr.signInWithPasswordStaging({ email: "first@example.test", password: "correct-horse-battery" });
  assert.equal(p.kind, "promoted");
  const rt = mgr.runtimeFor(p.account.userId)!;
  await rt.ready();

  const slotKey = slotStorageKey(ORIGIN_HASH, p.account.loginId);
  const exactLock = loginLockName(ORIGIN_HASH, p.account.loginId);
  const initialDiskRaw = ls.rawGet(slotKey)!;
  const initialToken = rt.peekAccessToken()!;

  // Case 1: Inject slot write failure during SDK refresh -> rotated successor stays in memory while predecessor remains on disk.
  ls.failSetKeys.add(slotKey);
  const refreshed = await rt.client.auth.refreshSession();
  assert.equal(refreshed.error, null);
  const rotatedToken = refreshed.data.session!.access_token;
  assert.notEqual(rotatedToken, initialToken);
  assert.equal(ls.rawGet(slotKey), initialDiskRaw, "disk still holds spent predecessor due to injected write failure");
  assert.equal(rt.peekAccessToken(), rotatedToken, "memory holds rotated successor");

  // Reconciling now MUST acquire exact lock:<slotKey> and MUST NOT clobber rotatedToken with spent predecessor!
  const acquiredBefore = locks.acquired.length;
  const reconciled1 = await rt.reconcileFromDisk();
  assert.ok(locks.acquired.slice(acquiredBefore).includes(exactLock), "reconcileFromDisk must acquire exact SDK lock:<slotKey>");
  assert.equal(reconciled1?.access_token, rotatedToken, "reconciliation must preserve pending rotated successor");
  assert.equal(rt.peekAccessToken(), rotatedToken, "spent predecessor must NOT overwrite rotated successor");

  // Once disk recovers, reconcileFromDisk flushes the rotated successor cleanly to disk!
  ls.failSetKeys.clear();
  await rt.reconcileFromDisk();
  assert.ok((ls.rawGet(slotKey) ?? "").includes(rotatedToken), "rotated successor flushed to disk after recovery");

  // Case 2: Another tab independently commits a newer token to disk -> reconcileFromDisk adopts that newer token!
  const peerNewer = mock.mintSession(makeUser(p.account.userId, "first@example.test", "First Owner"));
  ls.rawSet(slotKey, JSON.stringify(peerNewer));
  const acquiredBefore2 = locks.acquired.length;
  const reconciled2 = await rt.reconcileFromDisk();
  assert.ok(locks.acquired.slice(acquiredBefore2).includes(exactLock), "reconcileFromDisk acquires exact SDK lock:<slotKey>");
  assert.equal(reconciled2?.access_token, peerNewer.access_token, "independently committed newer token adopted");
  assert.equal(rt.peekAccessToken(), peerNewer.access_token);

  mgr.destroy();
});

test("C5 signOutAccount authorization: refuses mismatched {userId, loginId} and stale same-user loginId with 0 side effects; allows exact-pair control", async () => {
  const ls = new MemoryStorage();
  const locks = new TestWebLocks();
  const hub = new TestBroadcastHub();
  const mock = createMockGoTrue();

  const mgr = new AccountManager(DEPLOYMENT, {
    localStorage: ls, sessionStorage: new MemoryStorage(), fetcher: mock.fetcher,
    webLocks: locks.lock, createBroadcastChannel: hub.create,
  });
  await mgr.initialize();
  const a = await mgr.signInWithPasswordStaging({ email: "first@example.test", password: "correct-horse-battery" });
  const b = await mgr.signInWithPasswordStaging({ email: "second@example.test", password: "correct-horse-battery" });
  assert.equal(a.kind, "promoted");
  assert.equal(b.kind, "promoted");
  const rtB = mgr.runtimeFor(b.account.userId)!;
  await rtB.ready();
  const slotB = slotStorageKey(ORIGIN_HASH, b.account.loginId);
  const logoutsBefore = mock.state.logouts.length;

  // 1. Mismatched pair (userA.id + userB.loginId): ZERO side effects!
  const mismatch = await mgr.signOutAccount(a.account.userId, b.account.loginId);
  assert.equal(mismatch.browserSignedOut, false);
  assert.equal(mismatch.localTabTornDown, false);
  assert.equal(mismatch.slotDeleted, false);
  assert.equal(mismatch.remoteRevocation.status, "skipped");
  assert.equal(mock.state.logouts.length, logoutsBefore, "mismatched pair must send 0 GoTrue logouts");
  assert.ok(ls.rawGet(slotB), "mismatched pair must NOT delete userB's slot");
  assert.equal(rtB.isDisposed(), false, "mismatched pair must NOT dispose userB's runtime");
  assert.equal(mgr.listAccounts().length, 2, "both accounts remain intact");

  // 2. Stale same-user loginId after A signs out & re-signs-in: ZERO side effects on new loginId!
  const oldLoginIdA = a.account.loginId;
  await mgr.signOutAccount(a.account.userId, oldLoginIdA);
  const aNew = await mgr.signInWithPasswordStaging({ email: "first@example.test", password: "correct-horse-battery" });
  assert.equal(aNew.kind, "promoted");
  assert.notEqual(aNew.account.loginId, oldLoginIdA);
  const rtANew = mgr.runtimeFor(aNew.account.userId)!;
  await rtANew.ready();
  const slotANew = slotStorageKey(ORIGIN_HASH, aNew.account.loginId);
  const logoutsBeforeStale = mock.state.logouts.length;

  const staleRes = await mgr.signOutAccount(aNew.account.userId, oldLoginIdA);
  assert.equal(staleRes.browserSignedOut, false);
  assert.equal(staleRes.localTabTornDown, false);
  assert.equal(staleRes.slotDeleted, false);
  assert.equal(staleRes.remoteRevocation.status, "skipped");
  assert.equal(mock.state.logouts.length, logoutsBeforeStale, "stale loginId must send 0 GoTrue logouts");
  assert.ok(ls.rawGet(slotANew), "stale loginId must NOT delete new loginId's slot");
  assert.equal(rtANew.isDisposed(), false, "stale loginId must NOT dispose new loginId's runtime");

  // 3. Correct-target control: exact { userB.id, userB.loginId } succeeds cleanly!
  const controlRes = await mgr.signOutAccount(b.account.userId, b.account.loginId);
  assert.equal(controlRes.browserSignedOut, true);
  assert.equal(controlRes.localTabTornDown, true);
  assert.equal(controlRes.slotDeleted, true);
  assert.equal(controlRes.remoteRevocation.status, "confirmed");
  assert.equal(mock.state.logouts.length, logoutsBeforeStale + 1);
  assert.equal(mock.state.logouts.at(-1)?.scope, "local");
  assert.equal(ls.rawGet(slotB), null, "exact-pair control deletes userB's slot");
  assert.equal(mgr.listAccounts().length, 1);
  assert.equal(mgr.listAccounts()[0]!.loginId, aNew.account.loginId);

  mgr.destroy();
});
