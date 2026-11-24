import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";
import {
  AuthRetryableFetchError,
  createClient,
  isAuthRefreshDiscardedError,
  navigatorLock,
} from "@supabase/supabase-js";

const TEST_API_URL = "https://api.commonswarm.com";
const TEST_STORAGE_KEY = "sb-api-auth-token";
const TEST_LOCK_NAME = `lock:${TEST_STORAGE_KEY}`;

function memoryStorage(initial = {}) {
  const entries = new Map(Object.entries(initial));
  const ops = [];
  return {
    entries,
    ops,
    get length() {
      return entries.size;
    },
    key(index) {
      return [...entries.keys()][index] ?? null;
    },
    getItem(key) {
      ops.push(`get:${key}`);
      return entries.get(key) ?? null;
    },
    setItem(key, value) {
      ops.push(`set:${key}`);
      entries.set(key, value);
    },
    removeItem(key) {
      ops.push(`remove:${key}`);
      entries.delete(key);
    },
    clear() {
      ops.push("clear");
      entries.clear();
    },
  };
}

function makeStoredSession({
  accessToken,
  refreshToken,
  expired = false,
  expiresInSec = undefined,
  userId = "user-1",
}) {
  const nowSec = Math.floor(Date.now() / 1000);
  const delta = expiresInSec !== undefined ? expiresInSec : (expired ? -60 : 3600);
  return JSON.stringify({
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: 3600,
    expires_at: nowSec + delta,
    token_type: "bearer",
    user: { id: userId, aud: "authenticated", email: "owner@example.test" },
  });
}

function createFifoLocks() {
  const active = new Map();
  const queues = new Map();
  const holds = [];
  let acquireCount = 0;
  let releaseCount = 0;

  function drain(name) {
    if (active.has(name)) return;
    const queue = queues.get(name);
    if (!queue || queue.length === 0) return;
    const next = queue.shift();
    if (queue.length === 0) queues.delete(name);
    if (next.aborted) {
      drain(name);
      return;
    }
    const acquiredAt = Date.now();
    acquireCount += 1;
    active.set(name, { acquiredAt });
    Promise.resolve()
      .then(() => next.cb({ name, mode: "exclusive" }))
      .then(
        (result) => {
          const releasedAt = Date.now();
          active.delete(name);
          releaseCount += 1;
          holds.push({ name, acquiredAt, releasedAt, durationMs: releasedAt - acquiredAt });
          next.resolve(result);
          drain(name);
        },
        (error) => {
          const releasedAt = Date.now();
          active.delete(name);
          releaseCount += 1;
          holds.push({ name, acquiredAt, releasedAt, durationMs: releasedAt - acquiredAt });
          next.reject(error);
          drain(name);
        },
      );
  }

  return {
    holds,
    get acquireCount() {
      return acquireCount;
    },
    get releaseCount() {
      return releaseCount;
    },
    isHeld(name = TEST_LOCK_NAME) {
      return active.has(name);
    },
    request(name, optionsOrCb, maybeCb) {
      const hasOptions = typeof optionsOrCb === "object" && optionsOrCb !== null;
      const options = hasOptions ? optionsOrCb : {};
      const cb = hasOptions ? maybeCb : optionsOrCb;
      if (options.ifAvailable && active.has(name)) {
        return Promise.resolve().then(() => cb(null));
      }
      if (options.signal?.aborted) {
        return Promise.reject(options.signal.reason ?? new DOMException("Aborted", "AbortError"));
      }
      return new Promise((resolve, reject) => {
        const entry = { cb, resolve, reject, aborted: false };
        if (options.signal) {
          options.signal.addEventListener(
            "abort",
            () => {
              entry.aborted = true;
              const q = queues.get(name);
              if (q) {
                const idx = q.indexOf(entry);
                if (idx >= 0) q.splice(idx, 1);
              }
              reject(options.signal.reason ?? new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          );
        }
        let queue = queues.get(name);
        if (!queue) {
          queue = [];
          queues.set(name, queue);
        }
        queue.push(entry);
        drain(name);
      });
    },
  };
}

async function withNavigatorLocks(locks, fn) {
  const hadNavigator = Object.prototype.hasOwnProperty.call(globalThis, "navigator");
  const prevNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { locks },
  });
  try {
    return await fn();
  } finally {
    if (hadNavigator && prevNavigator) {
      Object.defineProperty(globalThis, "navigator", prevNavigator);
    } else {
      delete globalThis.navigator;
    }
  }
}

async function settleLockIdle(locks, maxMs = 200) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setImmediate(r));
    if (!locks.isHeld(TEST_LOCK_NAME)) {
      await new Promise((r) => setImmediate(r));
      if (!locks.isHeld(TEST_LOCK_NAME)) return;
    }
  }
}

/**
 * TEST-LOCAL PROTOTYPE of Candidate (b) (one-shot commit-guard discard + independent setItem write fence)
 * and Question 2 Option (ii) (instance-level `_emitInitialSession` neutralization + fan-out subscription).
 *
 * Product code (`shared/browser-session/index.ts`) is NOT modified in this task; this prototype
 * exercises the REAL pinned `@supabase/supabase-js` / `@supabase/auth-js` 2.111.0 `GoTrueClient`.
 */
function createPrototypeClient({
  storage,
  fetchImpl,
  sharedCooldown = { token: null, retryAfter: 0 },
  enableCooldown = true,
  patchSubscription = true,
  skipAutoInitialize = false,
  autoRefreshToken = false,
  discardOnPreWireMismatch = false,
}) {
  const discardPrefix = `__cs_discard_${crypto.randomUUID()}_`;
  const activeDiscardSentinels = new Set();
  let discardSeq = 0;
  let pendingDiscardRead = false;
  let storageSetCalls = 0;
  let storageRemoveCalls = 0;
  let fencedSetRejections = 0;
  const terminalCodes = new Set([
    "refresh_token_not_found",
    "session_not_found",
    "session_expired",
    "user_not_found",
    "user_banned",
  ]);

  function isFabricatedPayload(raw) {
    if (typeof raw !== "string") return false;
    if (raw.includes(discardPrefix)) return true;
    try {
      const parsed = JSON.parse(raw);
      return (
        activeDiscardSentinels.has(parsed?.access_token) ||
        activeDiscardSentinels.has(parsed?.refresh_token)
      );
    } catch {
      return false;
    }
  }

  function makeDiscardResponse() {
    const sentinel = `${discardPrefix}${++discardSeq}`;
    activeDiscardSentinels.add(sentinel);
    // Arm one-shot storage read so GoTrueClient._callRefreshToken:5012 (`storedAfter`)
    // sees `null` and triggers `storageChangedUnderUs` (lines 5013-5034) -> AuthRefreshDiscardedError.
    pendingDiscardRead = true;
    return new Response(
      JSON.stringify({
        access_token: sentinel,
        refresh_token: sentinel,
        expires_in: 1,
        token_type: "bearer",
        user: { id: sentinel },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  function recordCooldown(requestRefresh, retryAfterHeader) {
    if (!enableCooldown) return;
    let until = Date.now() + 30_000;
    if (retryAfterHeader) {
      const secs = Number(retryAfterHeader);
      const parsed = Number.isFinite(secs) ? Date.now() + secs * 1000 : Date.parse(retryAfterHeader);
      if (Number.isFinite(parsed)) until = Math.max(until, parsed);
    }
    sharedCooldown.token = requestRefresh ?? null;
    sharedCooldown.retryAfter = until;
  }

  const guardedStorage = {
    getItem(key) {
      if (key === TEST_STORAGE_KEY && pendingDiscardRead) {
        pendingDiscardRead = false;
        return null;
      }
      return storage.getItem(key);
    },
    setItem(key, value) {
      if (isFabricatedPayload(value)) {
        // Independent write fence: even when `storedAtStart === null` (so SDK's
        // `storageChangedUnderUs` does not fire), refusing inside `setItem` aborts
        // `_saveSession` before any write AND before `_notifyAllSubscribers('TOKEN_REFRESHED')`.
        pendingDiscardRead = false;
        fencedSetRejections += 1;
        throw new AuthRetryableFetchError("Write fence refused fabricated discard payload", 0);
      }
      storageSetCalls += 1;
      storage.setItem(key, value);
    },
    removeItem(key) {
      storageRemoveCalls += 1;
      storage.removeItem(key);
    },
  };

  const wrappedFetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const isRefresh =
      method === "POST" &&
      url.pathname.endsWith("/auth/v1/token") &&
      url.searchParams.get("grant_type") === "refresh_token";

    if (!isRefresh) {
      return fetchImpl(input, init);
    }

    let requestRefresh = null;
    if (typeof init?.body === "string") {
      try {
        requestRefresh = JSON.parse(init.body)?.refresh_token ?? null;
      } catch {
        requestRefresh = null;
      }
    }

    const storedRaw = storage.getItem(TEST_STORAGE_KEY);
    let storedRefresh = null;
    try {
      storedRefresh = storedRaw ? JSON.parse(storedRaw)?.refresh_token ?? null : null;
    } catch {
      storedRefresh = null;
    }

    // Cooldown lives OUTSIDE the lock: if this token is in cooldown, exit immediately via discard
    // with zero wire request and zero sleep.
    if (
      enableCooldown &&
      requestRefresh &&
      sharedCooldown.token === requestRefresh &&
      Date.now() < sharedCooldown.retryAfter &&
      storedRefresh === requestRefresh
    ) {
      return makeDiscardResponse();
    }

    if (discardOnPreWireMismatch && storedRefresh && requestRefresh && storedRefresh !== requestRefresh) {
      return makeDiscardResponse();
    }

    let response;
    try {
      response = await fetchImpl(input, init);
    } catch {
      recordCooldown(requestRefresh, null);
      return makeDiscardResponse();
    }

    if (response.ok) {
      if (sharedCooldown.token === requestRefresh) {
        sharedCooldown.token = null;
        sharedCooldown.retryAfter = 0;
      }
      return response;
    }

    const body = await response.clone().json().catch(() => null);
    const version = response.headers.get("x-supabase-api-version");
    const code = version && version >= "2024-01-01" && typeof body?.code === "string"
      ? body.code
      : body?.error_code;
    const isTerminal = [400, 401, 403, 404].includes(response.status) && terminalCodes.has(code);

    if (!isTerminal) {
      recordCooldown(requestRefresh, response.headers.get("retry-after"));
      return makeDiscardResponse();
    }

    return response;
  };

  const client = createClient(TEST_API_URL, "anon-key", {
    global: { fetch: wrappedFetch },
    auth: {
      persistSession: true,
      autoRefreshToken,
      detectSessionInUrl: false,
      skipAutoInitialize,
      storage: guardedStorage,
      lockAcquireTimeout: -1,
      lock: navigatorLock,
    },
  });

  // Question 2 Option (ii) prototype:
  // Synchronously (before any microtask lets SupabaseClient._listenForAuthEvents's IIFE reach
  // GoTrueClient.ts:4325), neutralize `_emitInitialSession` on this client instance, register ONE
  // SDK listener for fan-out, and replace `onAuthStateChange` on this instance so application
  // subscriptions never run the SDK's unawaited `_emitInitialSession` IIFE or acquire the lock.
  if (patchSubscription) {
    const auth = client.auth;
    const fanOutListeners = new Map();
    let nextListenerId = 0;
    const origOnAuthStateChange = auth.onAuthStateChange.bind(auth);

    auth._emitInitialSession = async () => {};

    origOnAuthStateChange((event, session) => {
      for (const cb of [...fanOutListeners.values()]) {
        cb(event, session);
      }
    });

    auth.onAuthStateChange = (callback) => {
      const id = `fanout-${++nextListenerId}`;
      fanOutListeners.set(id, callback);
      return {
        data: {
          subscription: {
            id,
            callback,
            unsubscribe: () => {
              fanOutListeners.delete(id);
            },
          },
        },
      };
    };
  }

  return {
    client,
    get storageSetCalls() {
      return storageSetCalls;
    },
    get storageRemoveCalls() {
      return storageRemoveCalls;
    },
    get fencedSetRejections() {
      return fencedSetRejections;
    },
  };
}

// ============================================================================
// QUESTION 1 PROOFS: Candidate (b) one-shot commit-guard discard + write fence
// ============================================================================

test("Q1 proof: transport failure, 429+Retry-After, 5xx, and 400 refresh_token_already_used with unchanged storage release lock <=250ms, preserve storage byte-identically, emit zero events, and let peer run getSession/getUser immediately", async (t) => {
  const failureCases = [
    {
      name: "transport failure (TypeError)",
      respond: () => {
        throw new TypeError("Failed to fetch");
      },
    },
    {
      name: "HTTP 429 with Retry-After",
      respond: () =>
        new Response(
          JSON.stringify({ code: "over_request_rate_limit", msg: "Too Many Requests" }),
          {
            status: 429,
            headers: {
              "content-type": "application/json",
              "x-supabase-api-version": "2024-01-01",
              "retry-after": "15",
            },
          },
        ),
    },
    {
      name: "HTTP 503 server error",
      respond: () =>
        new Response(JSON.stringify({ msg: "Service Unavailable" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
    },
    {
      name: "HTTP 400 refresh_token_already_used",
      respond: () =>
        new Response(
          JSON.stringify({
            code: "refresh_token_already_used",
            error_code: "refresh_token_already_used",
            msg: "Invalid Refresh Token: Already Used",
          }),
          {
            status: 400,
            headers: {
              "content-type": "application/json",
              "x-supabase-api-version": "2024-01-01",
            },
          },
        ),
    },
  ];

  for (const fc of failureCases) {
    await t.test(fc.name, async () => {
      const initialStored = makeStoredSession({
        accessToken: "at-1",
        refreshToken: "rt-1",
        expired: true,
      });
      const storage = memoryStorage({ [TEST_STORAGE_KEY]: initialStored });
      const locks = createFifoLocks();
      const sharedCooldown = { token: null, retryAfter: 0 };

      let refreshWireCalls = 0;
      let userWireCalls = 0;
      let failRespondedAt = 0;
      let recoverMode = false;

      const fetchImpl = async (input) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("/auth/v1/token")) {
          refreshWireCalls += 1;
          if (!recoverMode) {
            failRespondedAt = Date.now();
            return fc.respond();
          }
          return new Response(
            JSON.stringify({
              access_token: "at-recovered",
              refresh_token: "rt-recovered",
              expires_in: 3600,
              token_type: "bearer",
              user: { id: "user-1", aud: "authenticated", email: "owner@example.test" },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url.includes("/auth/v1/user")) {
          userWireCalls += 1;
          return new Response(
            JSON.stringify({ id: "user-1", aud: "authenticated", email: "owner@example.test" }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        throw new Error(`Unexpected URL: ${url}`);
      };

      await withNavigatorLocks(locks, async () => {
        const proto1 = createPrototypeClient({ storage, fetchImpl, sharedCooldown });
        const proto2 = createPrototypeClient({ storage, fetchImpl, sharedCooldown });
        const events1 = [];
        const events2 = [];
        proto1.client.auth.onAuthStateChange((event, session) => events1.push({ event, session }));
        proto2.client.auth.onAuthStateChange((event, session) => events2.push({ event, session }));

        try {
          // Let both clients finish initial startup (autoRefreshToken: false -> no wire refresh)
          // and drain any init-time no-op lock callbacks before driving the refresh attempt.
          await Promise.all([proto1.client.auth.initialize(), proto2.client.auth.initialize()]);
          await settleLockIdle(locks);
          assert.equal(locks.isHeld(TEST_LOCK_NAME), false, "lock is idle before refresh test");

          // Client 1 runs getSession() on the expired session -> hits wire failure once.
          const res1 = await proto1.client.auth.getSession();
          const releasedAt = Date.now();
          const releaseLatencyMs = releasedAt - failRespondedAt;

          assert.equal(refreshWireCalls, 1, "exactly 1 wire refresh attempt (zero SDK backoff retries)");
          assert.equal(locks.isHeld(TEST_LOCK_NAME), false, "Web Lock is released immediately");
          assert.ok(releaseLatencyMs < 250, `lock released within 250 ms (actual: ${releaseLatencyMs} ms)`);
          assert.equal(isAuthRefreshDiscardedError(res1.error), true, "SDK exited via AuthRefreshDiscardedError");
          assert.equal(storage.entries.get(TEST_STORAGE_KEY), initialStored, "storage is byte-identical to before");
          assert.equal(proto1.storageSetCalls, 0, "zero storage setItem calls");
          assert.equal(proto1.storageRemoveCalls, 0, "zero storage removeItem calls");
          assert.equal(
            storage.ops.some((op) => op.startsWith("set:") || op.startsWith("remove:")),
            false,
            "zero localStorage mutations",
          );
          assert.deepEqual(events1, [], "zero auth events emitted on client 1");
          assert.deepEqual(events2, [], "zero auth events emitted on client 2");

          // Client 2 runs getSession() and getUser() immediately while cooldown is active (no stall, no extra wire refresh).
          const peerStart = Date.now();
          const [peerSession, peerUser] = await Promise.all([
            proto2.client.auth.getSession(),
            proto2.client.auth.getUser(),
          ]);
          const peerElapsedMs = Date.now() - peerStart;

          assert.ok(peerElapsedMs < 250, `client 2 getSession()/getUser() settled within 250 ms (actual: ${peerElapsedMs} ms)`);
          assert.equal(locks.isHeld(TEST_LOCK_NAME), false, "lock released after client 2");
          assert.equal(refreshWireCalls, 1, "client 2 sent zero extra wire refreshes during shared cooldown");
          assert.equal(isAuthRefreshDiscardedError(peerSession.error), true);
          assert.equal(isAuthRefreshDiscardedError(peerUser.error), true);
          assert.equal(storage.entries.get(TEST_STORAGE_KEY), initialStored, "storage remains byte-identical");
          assert.deepEqual(events1, [], "still zero auth events on client 1");
          assert.deepEqual(events2, [], "still zero auth events on client 2");

          // Prove GoTrue's 60s lastRefreshFailure was NOT poisoned: once external cooldown expires,
          // Client 1 can immediately recover the SAME rt-1 on the wire, and Client 2 verifies with getUser().
          sharedCooldown.retryAfter = 0;
          recoverMode = true;
          const recovered = await proto1.client.auth.getSession();
          assert.equal(recovered.error, null, "Client 1 recovered immediately without 60s SDK failure cache");
          assert.equal(recovered.data.session?.refresh_token, "rt-recovered");
          const verifiedPeer = await proto2.client.auth.getUser();
          assert.equal(verifiedPeer.error, null, "Client 2 verified recovered session via getUser()");
          assert.equal(verifiedPeer.data.user?.id, "user-1");
          assert.equal(userWireCalls, 1);
        } finally {
          await proto1.client.auth.dispose();
          await proto2.client.auth.dispose();
        }
      });
    });
  }
});

test("Q1 caller safety: _recoverAndRefresh (initialize) and _autoRefreshTokenTick (expired & proactive window) handle discard with zero removal, zero SIGNED_OUT, and <=1 wire call", async () => {
  const proactiveStored = makeStoredSession({
    accessToken: "at-proactive",
    refreshToken: "rt-proactive",
    expiresInSec: 30, // inside 90s EXPIRY_MARGIN_MS, access token still valid
  });
  const storage = memoryStorage({ [TEST_STORAGE_KEY]: proactiveStored });
  const locks = createFifoLocks();
  const sharedCooldown = { token: null, retryAfter: 0 };
  const events = [];
  let wireCalls = 0;

  const fetchImpl = async () => {
    wireCalls += 1;
    return new Response(JSON.stringify({ code: "over_request_rate_limit" }), {
      status: 429,
      headers: { "content-type": "application/json", "x-supabase-api-version": "2024-01-01" },
    });
  };

  await withNavigatorLocks(locks, async () => {
    // autoRefreshToken: true drives BOTH `_recoverAndRefresh()` inside `initialize()` AND `_autoRefreshTokenTick()` (0ms tick).
    const proto = createPrototypeClient({
      storage,
      fetchImpl,
      sharedCooldown,
      autoRefreshToken: true,
    });
    proto.client.auth.onAuthStateChange((event) => events.push(event));

    try {
      await proto.client.auth.initialize();
      // Let the 0ms `_autoRefreshTokenTick` run as well (it hits `__loadSession` -> proactive-preserve -> second `_callRefreshToken` at line 5497).
      await new Promise((r) => setTimeout(r, 40));
      await settleLockIdle(locks);

      assert.equal(wireCalls, 1, "only 1 wire attempt across initialize() + 0ms _autoRefreshTokenTick (cooldown discards re-entry)");
      assert.equal(locks.isHeld(TEST_LOCK_NAME), false, "lock released");
      assert.equal(storage.entries.get(TEST_STORAGE_KEY), proactiveStored, "proactive session preserved byte-identically");
      assert.equal(proto.storageRemoveCalls, 0, "zero storage removals");
      assert.equal(proto.storageSetCalls, 0, "zero storage overwrites");
      assert.deepEqual(events, [], "zero SIGNED_OUT or false events");

      // Proactive getSession() still returns the valid access token without error:
      const gs = await proto.client.auth.getSession();
      assert.equal(gs.error, null);
      assert.equal(gs.data.session?.access_token, "at-proactive");
      assert.equal(wireCalls, 1, "still only 1 wire call");
    } finally {
      await proto.client.auth.dispose();
    }
  });
});

test("Q1 reviewer edge cases: already-visible successor AND slot cleared (during fetch and before storedAtStart) never store fabricated data or emit false events", async (t) => {
  await t.test("Case A: successor session S2 is ALREADY visible in storage when wrapper starts (storedAtStart === S2)", async () => {
    const successorStored = makeStoredSession({
      accessToken: "at-2",
      refreshToken: "rt-2",
      expired: false,
      userId: "user-2",
    });
    const storage = memoryStorage({ [TEST_STORAGE_KEY]: successorStored });
    const locks = createFifoLocks();
    const events = [];

    const fetchImpl = async () =>
      new Response(
        JSON.stringify({ code: "refresh_token_already_used", error_code: "refresh_token_already_used" }),
        {
          status: 400,
          headers: { "content-type": "application/json", "x-supabase-api-version": "2024-01-01" },
        },
      );

    await withNavigatorLocks(locks, async () => {
      const proto = createPrototypeClient({ storage, fetchImpl, discardOnPreWireMismatch: true });
      proto.client.auth.onAuthStateChange((event, session) => events.push({ event, session }));
      try {
        await proto.client.auth.initialize();
        await settleLockIdle(locks);
        // Clear the legitimate startup SIGNED_IN event for stored S2 before testing the stale predecessor refresh.
        events.length = 0;

        // Explicit refreshSession({ refresh_token: "rt-1" }) while S2 (rt-2) is ALREADY in storage:
        // `_callRefreshToken` reads `storedAtStart = S2` (line 5006), then enters authFetch with rt-1.
        // Without the one-shot storage discard, `storedAfter === S2 === storedAtStart` would FAIL
        // `storageChangedUnderUs` and overwrite S2 with the synthetic payload!
        const startedAt = Date.now();
        const res = await proto.client.auth.refreshSession({ refresh_token: "rt-1" });
        const elapsedMs = Date.now() - startedAt;

        assert.ok(elapsedMs < 250, `settled within 250 ms (actual: ${elapsedMs} ms)`);
        assert.equal(locks.isHeld(TEST_LOCK_NAME), false, "lock released");
        assert.equal(isAuthRefreshDiscardedError(res.error), true, "commit guard discarded via one-shot read");
        assert.equal(res.data.session, null);
        assert.equal(proto.storageSetCalls, 0, "SDK never called setItem with fabricated payload");
        assert.equal(proto.storageRemoveCalls, 0, "SDK never removed successor");
        assert.equal(storage.entries.get(TEST_STORAGE_KEY), successorStored, "successor S2 in storage is untouched");
        assert.deepEqual(events, [], "no auth event announced a fabricated or non-stored session");
      } finally {
        await proto.client.auth.dispose();
      }
    });
  });

  await t.test("Case B1: slot CLEARED during the in-flight refresh attempt (storedAtStart === S1, cleared before response)", async () => {
    const initialStored = makeStoredSession({
      accessToken: "at-1",
      refreshToken: "rt-1",
      expired: true,
    });
    const storage = memoryStorage({ [TEST_STORAGE_KEY]: initialStored });
    const locks = createFifoLocks();
    const events = [];

    const fetchImpl = async () => {
      // Peer tab signs out and clears storage while this refresh attempt is in flight.
      storage.entries.delete(TEST_STORAGE_KEY);
      return new Response(
        JSON.stringify({ code: "over_request_rate_limit" }),
        {
          status: 429,
          headers: { "content-type": "application/json", "x-supabase-api-version": "2024-01-01" },
        },
      );
    };

    await withNavigatorLocks(locks, async () => {
      const proto = createPrototypeClient({ storage, fetchImpl });
      proto.client.auth.onAuthStateChange((event, session) => events.push({ event, session }));
      try {
        await proto.client.auth.initialize();
        await settleLockIdle(locks);

        const startedAt = Date.now();
        const res = await proto.client.auth.getSession();
        const elapsedMs = Date.now() - startedAt;

        assert.ok(elapsedMs < 250, `settled within 250 ms (actual: ${elapsedMs} ms)`);
        assert.equal(locks.isHeld(TEST_LOCK_NAME), false, "lock released");
        assert.equal(isAuthRefreshDiscardedError(res.error), true, "commit guard discarded");
        assert.equal(storage.entries.get(TEST_STORAGE_KEY), undefined, "cleared slot remains empty (nothing fabricated stored)");
        assert.equal(proto.storageSetCalls, 0, "zero setItem writes");
        assert.deepEqual(events, [], "no event announced a fabricated session");
      } finally {
        await proto.client.auth.dispose();
      }
    });
  });

  await t.test("Case B2: slot ALREADY cleared before storedAtStart (storedAtStart === null) — independent setItem write fence blocks storage AND TOKEN_REFRESHED", async () => {
    const storage = memoryStorage({});
    const locks = createFifoLocks();
    const events = [];

    const fetchImpl = async () => {
      throw new TypeError("Failed to fetch");
    };

    await withNavigatorLocks(locks, async () => {
      const proto = createPrototypeClient({ storage, fetchImpl });
      proto.client.auth.onAuthStateChange((event, session) => events.push({ event, session }));
      try {
        await proto.client.auth.initialize();
        await settleLockIdle(locks);

        // Explicit refreshSession with empty storage -> storedAtStart === null -> storageChangedUnderUs is FALSE ->
        // GoTrue reaches `_saveSession` (line 5046) -> independent `setItem` fence throws AuthRetryableFetchError!
        const startedAt = Date.now();
        const res = await proto.client.auth.refreshSession({ refresh_token: "rt-orphan" });
        const elapsedMs = Date.now() - startedAt;

        assert.ok(elapsedMs < 250, `settled within 250 ms (actual: ${elapsedMs} ms)`);
        assert.equal(locks.isHeld(TEST_LOCK_NAME), false, "lock released");
        assert.equal(res.data.session, null);
        assert.equal(res.error?.name, "AuthRetryableFetchError", "write fence aborted _saveSession via AuthRetryableFetchError");
        assert.equal(proto.fencedSetRejections, 1, "independent setItem write fence intercepted fabricated payload");
        assert.equal(proto.storageSetCalls, 0, "nothing written to backing storage");
        assert.equal(proto.storageRemoveCalls, 0, "nothing removed from backing storage");
        assert.equal(storage.entries.get(TEST_STORAGE_KEY), undefined, "empty slot stays empty");
        assert.deepEqual(events, [], "zero events emitted (neither TOKEN_REFRESHED nor SIGNED_OUT)");
      } finally {
        await proto.client.auth.dispose();
      }
    });
  });
});

test("Q1 why Candidate (a) fails: non-retryable error with silent removeItem emits SIGNED_OUT and caches 60s failure; throwing removeItem rejects getSession and still caches 60s in proactive window", async (t) => {
  await t.test("(a1) silent guarded removeItem still emits SIGNED_OUT and sets 60s lastRefreshFailure", async () => {
    const initialStored = makeStoredSession({ accessToken: "at-1", refreshToken: "rt-1", expired: true });
    const storage = memoryStorage({ [TEST_STORAGE_KEY]: initialStored });
    const locks = createFifoLocks();
    const events = [];
    let wireCalls = 0;

    await withNavigatorLocks(locks, async () => {
      const client = createClient(TEST_API_URL, "anon-key", {
        global: {
          fetch: async () => {
            wireCalls += 1;
            return new Response(JSON.stringify({ code: "over_request_rate_limit" }), {
              status: 429,
              headers: { "content-type": "application/json", "x-supabase-api-version": "2024-01-01" },
            });
          },
        },
        auth: {
          persistSession: true,
          autoRefreshToken: false,
          detectSessionInUrl: false,
          storage: {
            getItem: (k) => storage.getItem(k),
            setItem: (k, v) => storage.setItem(k, v),
            removeItem: () => {
              // Silent no-op guard: storage is preserved, BUT _removeSession still runs line 5247!
            },
          },
          lockAcquireTimeout: -1,
          lock: navigatorLock,
        },
      });
      client.auth._emitInitialSession = async () => {};
      client.auth.onAuthStateChange((event) => events.push(event));

      try {
        await client.auth.getSession();
        assert.ok(events.includes("SIGNED_OUT"), "SDK STILL emitted SIGNED_OUT at GoTrueClient.ts:5247");
        // Second getSession() hits 60s lastRefreshFailure cache without calling fetch:
        await client.auth.getSession();
        assert.equal(wireCalls, 1, "SDK cached failure for 60s (REFRESH_FAILURE_COOLDOWN_MS)");
      } finally {
        await client.auth.dispose();
      }
    });
  });

  await t.test("(a2) throwing removeItem rejects getSession() on expired token AND misses proactive window (caches 60s)", async () => {
    const expiredStored = makeStoredSession({ accessToken: "at-1", refreshToken: "rt-1", expired: true });
    const storage1 = memoryStorage({ [TEST_STORAGE_KEY]: expiredStored });
    const locks1 = createFifoLocks();
    const events1 = [];

    await withNavigatorLocks(locks1, async () => {
      const client1 = createClient(TEST_API_URL, "anon-key", {
        global: {
          fetch: async () =>
            new Response(JSON.stringify({ code: "over_request_rate_limit" }), {
              status: 429,
              headers: { "content-type": "application/json", "x-supabase-api-version": "2024-01-01" },
            }),
        },
        auth: {
          persistSession: true,
          autoRefreshToken: false,
          detectSessionInUrl: false,
          skipAutoInitialize: true,
          storage: {
            getItem: (k) => storage1.getItem(k),
            setItem: (k, v) => storage1.setItem(k, v),
            removeItem: () => {
              throw new AuthRetryableFetchError("Guarded removal", 0);
            },
          },
          lockAcquireTimeout: -1,
          lock: navigatorLock,
        },
      });
      client1.auth._emitInitialSession = async () => {};
      client1.auth.onAuthStateChange((e) => events1.push(e));
      try {
        await assert.rejects(
          () => client1.auth.getSession(),
          AuthRetryableFetchError,
          "throwing from removeItem causes getSession() to reject (and skips refreshingDeferred.resolve)",
        );
        assert.deepEqual(events1, []);
      } finally {
        await client1.auth.dispose();
      }
    });

    const proactiveStored = makeStoredSession({ accessToken: "at-1", refreshToken: "rt-1", expiresInSec: 30 });
    const storage2 = memoryStorage({ [TEST_STORAGE_KEY]: proactiveStored });
    const locks2 = createFifoLocks();
    let wireCalls2 = 0;
    let removeCalls2 = 0;

    await withNavigatorLocks(locks2, async () => {
      const client2 = createClient(TEST_API_URL, "anon-key", {
        global: {
          fetch: async () => {
            wireCalls2 += 1;
            return new Response(JSON.stringify({ code: "over_request_rate_limit" }), {
              status: 429,
              headers: { "content-type": "application/json", "x-supabase-api-version": "2024-01-01" },
            });
          },
        },
        auth: {
          persistSession: true,
          autoRefreshToken: false,
          detectSessionInUrl: false,
          skipAutoInitialize: true,
          storage: {
            getItem: (k) => storage2.getItem(k),
            setItem: (k, v) => storage2.setItem(k, v),
            removeItem: () => {
              removeCalls2 += 1;
              throw new AuthRetryableFetchError("Guarded removal", 0);
            },
          },
          lockAcquireTimeout: -1,
          lock: navigatorLock,
        },
      });
      client2.auth._emitInitialSession = async () => {};
      try {
        await client2.auth.getSession();
        await client2.auth.refreshSession();
        assert.equal(removeCalls2, 0, "removeItem was never called during proactive window");
        assert.equal(wireCalls2, 1, "SDK cached failure for 60s in proactive window");
      } finally {
        await client2.auth.dispose();
      }
    });
  });
});

// ============================================================================
// QUESTION 2 PROOFS: Defect confirmation + Option (i) failure + Option (ii) proof
// ============================================================================

test("Q2 defect confirmation (unpatched pinned SDK): late onAuthStateChange with expired session fires wire refresh while Web Lock is NOT held", async () => {
  // Start with a valid session so initialize() AND SupabaseClient's internal _listenForAuthEvents()
  // (SupabaseClient.ts:411 -> 660) complete cleanly with zero refreshes.
  const validStored = makeStoredSession({
    accessToken: "at-1",
    refreshToken: "rt-1",
    expired: false,
  });
  const expiredStored = makeStoredSession({
    accessToken: "at-1",
    refreshToken: "rt-1",
    expired: true,
  });
  const storage = memoryStorage({ [TEST_STORAGE_KEY]: validStored });
  const locks = createFifoLocks();

  let refreshStartedResolve;
  const refreshStarted = new Promise((r) => { refreshStartedResolve = r; });
  let releaseRefresh;
  const refreshHeld = new Promise((r) => { releaseRefresh = r; });
  const refreshObservations = [];
  const storageSetLockStates = [];

  const observedStorage = {
    getItem: (k) => storage.getItem(k),
    setItem: (k, v) => {
      storageSetLockStates.push({ key: k, lockHeldDuringSetItem: locks.isHeld(TEST_LOCK_NAME) });
      storage.setItem(k, v);
    },
    removeItem: (k) => storage.removeItem(k),
  };

  const fetchImpl = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/auth/v1/token")) {
      refreshStartedResolve();
      // Simulate real network I/O latency: `_acquireLock`'s unawaited callback finishes
      // draining microtasks and RELEASES the Web Lock while this HTTP request is still in flight!
      await refreshHeld;
      refreshObservations.push({
        url,
        lockHeldWhileInFlight: locks.isHeld(TEST_LOCK_NAME),
      });
      return new Response(
        JSON.stringify({
          access_token: "at-2",
          refresh_token: "rt-2",
          expires_in: 3600,
          token_type: "bearer",
          user: { id: "user-1", aud: "authenticated", email: "owner@example.test" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  await withNavigatorLocks(locks, async () => {
    const client = createClient(TEST_API_URL, "anon-key", {
      global: { fetch: fetchImpl },
      auth: {
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
        storage: observedStorage,
        lockAcquireTimeout: -1,
        lock: navigatorLock,
      },
    });

    try {
      await client.auth.initialize();
      await settleLockIdle(locks);
      assert.equal(refreshObservations.length, 0, "initialization finished with zero refreshes");
      assert.equal(locks.isHeld(TEST_LOCK_NAME), false, "lock is completely free before late subscription");

      // Session is now expired in storage when a late application subscriber registers:
      storage.entries.set(TEST_STORAGE_KEY, expiredStored);
      const { data } = client.auth.onAuthStateChange(() => {});
      await refreshStarted;
      // Flush microtasks so `_acquireLock`'s callback (which didn't await `_emitInitialSession`) returns:
      await new Promise((r) => setImmediate(r));

      // DEFECT CONFIRMED: the refresh request is STILL on the wire, yet the Web Lock is ALREADY released!
      assert.equal(
        locks.isHeld(TEST_LOCK_NAME),
        false,
        "DEFECT CONFIRMED: Web Lock was released while late onAuthStateChange's wire refresh is still in flight (GoTrueClient.ts:4325 missing await)",
      );

      // A peer can even acquire the exclusive Web Lock CONCURRENTLY while the refresh is in flight!
      let peerAcquiredConcurrently = false;
      await locks.request(TEST_LOCK_NAME, { ifAvailable: true }, async (lock) => {
        peerAcquiredConcurrently = lock !== null;
      });
      assert.equal(peerAcquiredConcurrently, true, "peer acquired exclusive lock concurrently with in-flight refresh");

      // Let the refresh response complete and commit to storage:
      releaseRefresh();
      await new Promise((r) => setTimeout(r, 20));
      data.subscription.unsubscribe();

      assert.equal(refreshObservations.length, 1, "late onAuthStateChange fired a wire refresh");
      assert.equal(refreshObservations[0].lockHeldWhileInFlight, false, "refresh completed outside the Web Lock");
      assert.equal(storageSetLockStates.length, 1, "rotated session was written to storage");
      assert.equal(storageSetLockStates[0].lockHeldDuringSetItem, false, "storage.setItem ALSO ran outside the Web Lock");
    } finally {
      await client.auth.dispose();
    }
  });
});

test("Q2 Option (i) insufficiency: even with ZERO late listeners (only createClient's own early listener / one early listener), failed init refresh causes an unlocked wire refresh via _emitInitialSession", async () => {
  const expiredStored = makeStoredSession({
    accessToken: "at-1",
    refreshToken: "rt-1",
    expired: true,
  });
  const storage = memoryStorage({ [TEST_STORAGE_KEY]: expiredStored });
  const locks = createFifoLocks();

  let secondRefreshResolve;
  const secondRefreshSeen = new Promise((r) => { secondRefreshResolve = r; });
  const refreshObservations = [];
  let wireCount = 0;

  const fetchImpl = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/auth/v1/token")) {
      wireCount += 1;
      const callNum = wireCount;
      // Real network I/O yield so any unawaited `_acquireLock` wrapper releases the lock while in flight.
      await new Promise((r) => setImmediate(r));
      refreshObservations.push({ call: callNum, lockHeldWhileInFlight: locks.isHeld(TEST_LOCK_NAME) });
      if (callNum === 1) {
        // Initialization's refresh fails (429); prototype discards it so storage stays expired
        // and GoTrue's lastRefreshFailure is NOT set.
        return new Response(JSON.stringify({ code: "over_request_rate_limit" }), {
          status: 429,
          headers: { "content-type": "application/json", "x-supabase-api-version": "2024-01-01" },
        });
      }
      secondRefreshResolve();
      return new Response(
        JSON.stringify({
          access_token: "at-2",
          refresh_token: "rt-2",
          expires_in: 3600,
          token_type: "bearer",
          user: { id: "user-1", aud: "authenticated", email: "owner@example.test" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  await withNavigatorLocks(locks, async () => {
    // patchSubscription: false (Option i only — NO _emitInitialSession neutralization).
    // Even without ANY application listener, SupabaseClient.ts:411 -> 660 registers an early
    // onAuthStateChange listener in createClient(), and its _emitInitialSession runs after
    // initializePromise settles!
    const proto = createPrototypeClient({
      storage,
      fetchImpl,
      enableCooldown: false,
      patchSubscription: false,
      autoRefreshToken: true,
    });

    try {
      await secondRefreshSeen;

      assert.equal(refreshObservations[0].lockHeldWhileInFlight, true, "init refresh #1 held the lock while in flight");
      assert.equal(
        refreshObservations[1].lockHeldWhileInFlight,
        false,
        "Option (i) FAILS: early _emitInitialSession (registered inside createClient at SupabaseClient.ts:411->660) fired refresh #2 OUTSIDE the lock",
      );
    } finally {
      await proto.client.auth.dispose();
    }
  });
});

test("Q2 proof (Option ii): instance-level _emitInitialSession neutralization + fan-out produces ZERO unlocked refresh on early or late subscription and settles storage under the lock", async () => {
  const expiredStored = makeStoredSession({
    accessToken: "at-1",
    refreshToken: "rt-1",
    expired: true,
  });
  const storage = memoryStorage({ [TEST_STORAGE_KEY]: expiredStored });
  const locks = createFifoLocks();
  const sharedCooldown = { token: null, retryAfter: 0 };

  const refreshObservations = [];
  const storageSetLockStates = [];
  let allowSuccess = false;

  const observedStorage = {
    getItem: (k) => storage.getItem(k),
    setItem: (k, v) => {
      storageSetLockStates.push({ key: k, lockHeldDuringSetItem: locks.isHeld(TEST_LOCK_NAME) });
      storage.setItem(k, v);
    },
    removeItem: (k) => storage.removeItem(k),
  };

  const fetchImpl = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/auth/v1/token")) {
      await new Promise((r) => setImmediate(r));
      refreshObservations.push({
        lockHeldWhileInFlight: locks.isHeld(TEST_LOCK_NAME),
      });
      if (!allowSuccess) {
        return new Response(JSON.stringify({ code: "over_request_rate_limit" }), {
          status: 429,
          headers: { "content-type": "application/json", "x-supabase-api-version": "2024-01-01" },
        });
      }
      return new Response(
        JSON.stringify({
          access_token: "at-2",
          refresh_token: "rt-2",
          expires_in: 3600,
          token_type: "bearer",
          user: { id: "user-1", aud: "authenticated", email: "owner@example.test" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  await withNavigatorLocks(locks, async () => {
    const proto = createPrototypeClient({
      storage: observedStorage,
      fetchImpl,
      sharedCooldown,
      enableCooldown: false,
      patchSubscription: true,
      autoRefreshToken: true,
    });

    const earlyEvents = [];
    const lateEvents = [];

    try {
      const earlySub = proto.client.auth.onAuthStateChange((event, session) => {
        earlyEvents.push({ event, rt: session?.refresh_token ?? null });
      });

      // initialize() runs refresh #1 (429 -> discarded, session stays expired).
      await proto.client.auth.initialize();
      await settleLockIdle(locks);
      // Stop the background 0ms auto-refresh ticker so we isolate the late subscription check cleanly.
      await proto.client.auth.stopAutoRefresh();
      await settleLockIdle(locks);
      const wireCallsBeforeLateSub = refreshObservations.length;
      const acquiresBeforeLateSub = locks.acquireCount;

      assert.ok(wireCallsBeforeLateSub >= 1, "init refresh ran");
      assert.equal(
        refreshObservations.every((o) => o.lockHeldWhileInFlight === true),
        true,
        "every init/early refresh held the Web Lock throughout the in-flight request (ZERO unlocked _emitInitialSession refreshes)",
      );

      // Late subscription while storage STILL holds expired rt-1:
      const lateSub = proto.client.auth.onAuthStateChange((event, session) => {
        lateEvents.push({ event, rt: session?.refresh_token ?? null });
      });

      await new Promise((r) => setTimeout(r, 50));

      assert.equal(refreshObservations.length, wireCallsBeforeLateSub, "late subscription triggered ZERO wire refresh requests");
      assert.equal(locks.acquireCount, acquiresBeforeLateSub, "late subscription acquired ZERO locks");
      assert.equal(locks.isHeld(TEST_LOCK_NAME), false, "lock is not held");
      assert.equal(storage.entries.get(TEST_STORAGE_KEY), expiredStored, "storage untouched by late subscribe");

      // Now perform a real locked refresh via getSession() and verify storage settles cleanly under the lock
      // AND real auth events (TOKEN_REFRESHED) fan out to BOTH early and late subscribers.
      allowSuccess = true;
      const sessionRes = await proto.client.auth.getSession();

      assert.equal(sessionRes.error, null, "locked getSession() succeeded");
      assert.equal(sessionRes.data.session?.refresh_token, "rt-2");
      assert.equal(refreshObservations.length, wireCallsBeforeLateSub + 1, "exactly one locked wire refresh occurred");
      assert.equal(
        refreshObservations.at(-1).lockHeldWhileInFlight,
        true,
        "wire refresh held the Web Lock throughout the in-flight request",
      );
      assert.equal(storageSetLockStates.length, 1, "rotated session written to storage");
      assert.equal(storageSetLockStates[0].lockHeldDuringSetItem, true, "storage.setItem ran UNDER the Web Lock");
      assert.equal(locks.isHeld(TEST_LOCK_NAME), false, "Web Lock released after storage settled");

      const settled = JSON.parse(storage.entries.get(TEST_STORAGE_KEY));
      assert.equal(settled.refresh_token, "rt-2", "storage settled with rotated refresh_token");
      assert.equal(settled.access_token, "at-2", "storage settled with rotated access_token");
      assert.deepEqual(earlyEvents, [{ event: "TOKEN_REFRESHED", rt: "rt-2" }], "early listener received TOKEN_REFRESHED");
      assert.deepEqual(lateEvents, [{ event: "TOKEN_REFRESHED", rt: "rt-2" }], "late listener received TOKEN_REFRESHED");

      // Verify unsubscribe stops further delivery.
      earlySub.data.subscription.unsubscribe();
      lateSub.data.subscription.unsubscribe();
    } finally {
      await proto.client.auth.dispose();
    }
  });
});
