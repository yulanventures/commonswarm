import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  AuthRetryableFetchError,
  createClient,
  isAuthRefreshDiscardedError,
  isAuthSessionMissingError,
  navigatorLock,
  processLock,
} from "@supabase/supabase-js";
import {
  AuthRecoveryRequired,
  PINNED_SUPABASE_JS_VERSION,
  SessionExpired,
  createBrowserSession,
  refreshBackoffStorageKeyForDeployment,
} from "../../../shared/browser-session/index.js";
import {
  client as commonswarmClient,
  configureSingleAccountForTesting,
  currentSession as commonswarmCurrentSession,
  resetSingleAccountForTesting,
} from "./commonswarm.ts";

const TEST_API_URL = "https://api.commonswarm.com";
const TEST_STORAGE_KEY = "sb-api-auth-token";
const TEST_BACKOFF_KEY = refreshBackoffStorageKeyForDeployment(TEST_API_URL);
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

async function withBrowserEnv({ storage, locks, fetchImpl }, fn) {
  const prevStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const prevFetch = globalThis.fetch;
  const hadAddListener = Object.prototype.hasOwnProperty.call(globalThis, "addEventListener");
  const prevAddListener = Object.getOwnPropertyDescriptor(globalThis, "addEventListener");
  const hadRemoveListener = Object.prototype.hasOwnProperty.call(globalThis, "removeEventListener");
  const prevRemoveListener = Object.getOwnPropertyDescriptor(globalThis, "removeEventListener");

  const listeners = new Map();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  globalThis.fetch = fetchImpl;
  Object.defineProperty(globalThis, "addEventListener", {
    configurable: true,
    value(type, listener) {
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      set.add(listener);
    },
  });
  Object.defineProperty(globalThis, "removeEventListener", {
    configurable: true,
    value(type, listener) {
      listeners.get(type)?.delete(listener);
    },
  });

  const dispatchStorageEvent = ({ key, oldValue = null, newValue = null }) => {
    const event = { key, oldValue, newValue, storageArea: storage };
    for (const listener of [...(listeners.get("storage") ?? [])]) {
      listener(event);
    }
  };

  try {
    return await withNavigatorLocks(locks, () => fn({ dispatchStorageEvent }));
  } finally {
    globalThis.fetch = prevFetch;
    if (prevStorage) Object.defineProperty(globalThis, "localStorage", prevStorage);
    else delete globalThis.localStorage;
    if (hadAddListener && prevAddListener) Object.defineProperty(globalThis, "addEventListener", prevAddListener);
    else delete globalThis.addEventListener;
    if (hadRemoveListener && prevRemoveListener) {
      Object.defineProperty(globalThis, "removeEventListener", prevRemoveListener);
    } else {
      delete globalThis.removeEventListener;
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

function makeRealSession(sdkOverrides = {}) {
  const created = createBrowserSession({
    url: TEST_API_URL,
    anonKey: "anon-key",
    detectSessionInUrl: false,
    allowProcessLockFallback: false,
    sdk: {
      createClient,
      navigatorLock,
      processLock,
      isAuthSessionMissingError,
      AuthRetryableFetchError,
      ...sdkOverrides,
    },
  });
  assert.equal(created.ok, true);
  return created;
}

// ============================================================================
// REAL-MODULE PINNED-CLIENT WITNESSES (shared/browser-session/index.ts)
// ============================================================================

test("Real module witness: transport failure, 429+Retry-After, 503, and 400 refresh_token_already_used release lock <=250ms, preserve session slot byte-identically, emit zero events, bound peer attempts, and recover without 60s SDK cache", async (t) => {
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

      await withBrowserEnv({ storage, locks, fetchImpl }, async () => {
        const s1 = makeRealSession();
        const s2 = makeRealSession();
        const events1 = [];
        const events2 = [];
        s1.client.auth.onAuthStateChange((event, session) => events1.push({ event, session }));
        s2.client.auth.onAuthStateChange((event, session) => events2.push({ event, session }));

        try {
          await Promise.all([s1.client.auth.initialize(), s2.client.auth.initialize()]);
          await settleLockIdle(locks);
          const releasedAt = Date.now();
          const releaseLatencyMs = releasedAt - failRespondedAt;

          assert.equal(refreshWireCalls, 1, "exactly 1 wire refresh attempt (zero SDK backoff retries)");
          assert.equal(locks.isHeld(TEST_LOCK_NAME), false, "Web Lock is released immediately");
          assert.ok(releaseLatencyMs < 250, `lock released within 250 ms (actual: ${releaseLatencyMs} ms)`);
          assert.equal(storage.entries.get(TEST_STORAGE_KEY), initialStored, "session slot is byte-identical");
          assert.equal(
            storage.ops.some((op) => op === `set:${TEST_STORAGE_KEY}` || op === `remove:${TEST_STORAGE_KEY}`),
            false,
            "zero mutations to session slot",
          );
          assert.deepEqual(events1, [], "zero auth events on session 1");
          assert.deepEqual(events2, [], "zero auth events on session 2");

          // Peer session calls getSession(), getUser(), and verifiedSession() immediately while backoff is active.
          const peerStart = Date.now();
          const [peerSession, peerUser] = await Promise.all([
            s2.client.auth.getSession(),
            s2.client.auth.getUser(),
          ]);
          await assert.rejects(() => s2.verifiedSession(), (err) => {
            assert.ok(err instanceof AuthRecoveryRequired);
            assert.ok(typeof err.retryAfter === "number" && err.retryAfter > peerStart);
            return true;
          });
          const peerElapsedMs = Date.now() - peerStart;

          assert.ok(peerElapsedMs < 250, `peer settled within 250 ms (actual: ${peerElapsedMs} ms)`);
          assert.equal(locks.isHeld(TEST_LOCK_NAME), false, "lock released after peer");
          assert.equal(refreshWireCalls, 1, "peer sent zero extra wire refreshes during shared backoff");
          assert.equal(isAuthRefreshDiscardedError(peerSession.error), true);
          assert.equal(isAuthRefreshDiscardedError(peerUser.error), true);
          assert.equal(storage.entries.get(TEST_STORAGE_KEY), initialStored);
          assert.deepEqual(events1, []);
          assert.deepEqual(events2, []);

          // Prove GoTrue's 60s lastRefreshFailure was NOT poisoned: once external backoff clears,
          // s1 recovers immediately on the wire and s2 verifies via verifiedSession().
          storage.entries.delete(TEST_BACKOFF_KEY);
          recoverMode = true;
          const recovered = await s1.verifiedSession();
          assert.equal(recovered?.refresh_token, "rt-recovered", "s1 recovered immediately without 60s SDK cache");
          const verifiedPeer = await s2.verifiedSession();
          assert.equal(verifiedPeer?.refresh_token, "rt-recovered", "s2 verified recovered session");
          assert.equal(userWireCalls, 2);
        } finally {
          await Promise.all([s1.quiesce(), s2.quiesce()]);
        }
      });
    });
  }
});

test("Real module witness: proactive window (_recoverAndRefresh + 0ms _autoRefreshTokenTick) preserves session, bounds to 1 wire call, and never blocks unexpired verification", async () => {
  const proactiveStored = makeStoredSession({
    accessToken: "at-proactive",
    refreshToken: "rt-proactive",
    expiresInSec: 30, // inside 90s EXPIRY_MARGIN_MS, access token still valid
  });
  const storage = memoryStorage({ [TEST_STORAGE_KEY]: proactiveStored });
  const locks = createFifoLocks();
  const events = [];
  let wireRefreshCalls = 0;
  let userCalls = 0;

  const fetchImpl = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/auth/v1/token")) {
      wireRefreshCalls += 1;
      return new Response(JSON.stringify({ code: "over_request_rate_limit" }), {
        status: 429,
        headers: { "content-type": "application/json", "x-supabase-api-version": "2024-01-01" },
      });
    }
    if (url.includes("/auth/v1/user")) {
      userCalls += 1;
      return new Response(
        JSON.stringify({ id: "user-1", aud: "authenticated", email: "owner@example.test" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  await withBrowserEnv({ storage, locks, fetchImpl }, async () => {
    const session = makeRealSession();
    session.client.auth.onAuthStateChange((event) => events.push(event));

    try {
      await session.client.auth.initialize();
      await new Promise((r) => setTimeout(r, 40));
      await settleLockIdle(locks);

      assert.equal(wireRefreshCalls, 1, "only 1 wire attempt across initialize() + 0ms _autoRefreshTokenTick");
      assert.equal(locks.isHeld(TEST_LOCK_NAME), false, "lock released");
      assert.equal(storage.entries.get(TEST_STORAGE_KEY), proactiveStored, "proactive session preserved byte-identically");
      assert.equal(
        storage.ops.some((op) => op === `set:${TEST_STORAGE_KEY}` || op === `remove:${TEST_STORAGE_KEY}`),
        false,
        "zero session slot mutations",
      );
      assert.deepEqual(events, [], "zero SIGNED_OUT or false events");

      // Verification of the still-unexpired access token succeeds immediately during refresh backoff.
      const verified = await session.verifiedSession();
      assert.equal(verified?.access_token, "at-proactive");
      assert.equal(wireRefreshCalls, 1, "still only 1 wire refresh");
      assert.equal(userCalls, 1, "verified with getUser()");
    } finally {
      await session.quiesce();
    }
  });
});

test("Real module witness: reviewer edge cases (successor already visible, slot cleared mid-flight, slot already empty fence)", async (t) => {
  await t.test("Case A: successor S2 is ALREADY visible when wrapper starts (storedAtStart === S2)", async () => {
    const successorStored = makeStoredSession({
      accessToken: "at-2",
      refreshToken: "rt-2",
      expired: false,
      userId: "user-2",
    });
    const storage = memoryStorage({ [TEST_STORAGE_KEY]: successorStored });
    const locks = createFifoLocks();
    const events = [];
    let wireCalls = 0;

    const fetchImpl = async () => {
      wireCalls += 1;
      return new Response(
        JSON.stringify({ code: "refresh_token_already_used", error_code: "refresh_token_already_used" }),
        {
          status: 400,
          headers: { "content-type": "application/json", "x-supabase-api-version": "2024-01-01" },
        },
      );
    };

    await withBrowserEnv({ storage, locks, fetchImpl }, async () => {
      const session = makeRealSession();
      session.client.auth.onAuthStateChange((event, sess) => events.push({ event, sess }));
      try {
        await session.client.auth.initialize();
        await settleLockIdle(locks);
        events.length = 0;

        const startedAt = Date.now();
        const res = await session.client.auth.refreshSession({ refresh_token: "rt-1" });
        const elapsedMs = Date.now() - startedAt;

        assert.ok(elapsedMs < 250, `settled within 250 ms (actual: ${elapsedMs} ms)`);
        assert.equal(wireCalls, 0, "pre-wire credential mismatch avoided touching the network");
        assert.equal(locks.isHeld(TEST_LOCK_NAME), false, "lock released");
        assert.equal(isAuthRefreshDiscardedError(res.error), true, "commit guard discarded via one-shot read");
        assert.equal(res.data.session, null);
        assert.equal(storage.entries.get(TEST_STORAGE_KEY), successorStored, "successor S2 untouched");
        assert.equal(storage.entries.has(TEST_BACKOFF_KEY), false, "no backoff written for stale token");
        assert.equal(
          storage.ops.some((op) => op === `set:${TEST_STORAGE_KEY}` || op === `remove:${TEST_STORAGE_KEY}`),
          false,
          "zero session slot mutations",
        );
        assert.deepEqual(events, [], "no auth event announced a fabricated or non-stored session");
      } finally {
        await session.quiesce();
      }
    });
  });

  await t.test("Case B1: slot CLEARED mid-flight (storedAtStart === S1, cleared before response)", async () => {
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

    await withBrowserEnv({ storage, locks, fetchImpl }, async () => {
      const session = makeRealSession();
      session.client.auth.onAuthStateChange((event, sess) => events.push({ event, sess }));
      try {
        await session.client.auth.initialize();
        await settleLockIdle(locks);

        assert.equal(locks.isHeld(TEST_LOCK_NAME), false, "lock released");
        assert.equal(storage.entries.get(TEST_STORAGE_KEY), undefined, "cleared slot remains empty");
        assert.equal(storage.entries.has(TEST_BACKOFF_KEY), false, "no backoff written for cleared session");
        assert.equal(
          storage.ops.some((op) => op === `set:${TEST_STORAGE_KEY}`),
          false,
          "zero writes to session slot",
        );
        assert.deepEqual(events, [], "zero false events emitted");

        // verifiedSession() sees the cleared slot and returns null (existing missing-session retirement path).
        const verified = await session.verifiedSession();
        assert.equal(verified, null, "verifiedSession returns null for cleared slot");
      } finally {
        await session.quiesce();
      }
    });
  });

  await t.test("Case B2 (C3): empty slot + would-succeed transport discards orphan refresh BEFORE the network (zero wire calls, empty slot, zero events) and replacement credential proceeds normally", async () => {
    const storage = memoryStorage({});
    const locks = createFifoLocks();
    const events = [];
    const refreshTokensSeen = [];

    const fetchImpl = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/auth/v1/token")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        refreshTokensSeen.push(body.refresh_token);
        // Transport WOULD succeed for any refresh token (including rt-orphan) if a wire call ever went out!
        return new Response(
          JSON.stringify({
            access_token: body.refresh_token === "rt-orphan" ? "at-orphan-hydrated" : "at-replacement-fresh",
            refresh_token: body.refresh_token === "rt-orphan" ? "rt-orphan-hydrated" : "rt-replacement-fresh",
            expires_in: 3600,
            token_type: "bearer",
            user: { id: "user-2", aud: "authenticated", email: "two@example.test" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/auth/v1/user")) {
        return new Response(
          JSON.stringify({ id: "user-2", aud: "authenticated", email: "two@example.test" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    await withBrowserEnv({ storage, locks, fetchImpl }, async ({ dispatchStorageEvent }) => {
      const session = makeRealSession();
      session.client.auth.onAuthStateChange((event, sess) => events.push({ event, sess }));
      try {
        await session.client.auth.initialize();
        await settleLockIdle(locks);
        storage.ops.length = 0;

        const startedAt = Date.now();
        const res = await session.client.auth.refreshSession({ refresh_token: "rt-orphan" });
        const elapsedMs = Date.now() - startedAt;

        assert.ok(elapsedMs < 250, `settled within 250 ms (actual: ${elapsedMs} ms)`);
        assert.equal(locks.isHeld(TEST_LOCK_NAME), false, "lock released");
        assert.deepEqual(refreshTokensSeen, [], "ZERO wire calls for orphan refresh on empty slot");
        assert.equal(res.data.session, null, "no session returned");
        assert.equal(isAuthRefreshDiscardedError(res.error), true, "exited via existing AuthRefreshDiscardedError discard exit");
        assert.equal(storage.entries.get(TEST_STORAGE_KEY), undefined, "empty slot stays empty");
        assert.equal(
          storage.ops.some((op) => op === `set:${TEST_STORAGE_KEY}` || op === `remove:${TEST_STORAGE_KEY}`),
          false,
          "zero localStorage mutations on session slot",
        );
        assert.deepEqual(events, [], "zero events emitted (neither TOKEN_REFRESHED nor SIGNED_IN nor SIGNED_OUT)");

        // Subsequent replacement credential stored in the managed slot still refreshes and verifies normally.
        const replacementExpired = makeStoredSession({
          accessToken: "at-replacement-exp",
          refreshToken: "rt-replacement",
          expired: true,
          userId: "user-2",
        });
        storage.entries.set(TEST_STORAGE_KEY, replacementExpired);
        dispatchStorageEvent({ key: TEST_STORAGE_KEY, oldValue: null, newValue: replacementExpired });
        const verified = await session.verifiedSession();
        assert.equal(verified?.refresh_token, "rt-replacement-fresh", "replacement credential proceeded immediately");
        assert.equal(verified?.user.id, "user-2");
        assert.deepEqual(refreshTokensSeen, ["rt-replacement"]);
      } finally {
        await session.quiesce();
      }
    });
  });

  await t.test("Case B3 (C3): independent sentinel write fence blocks sentinel payloads on its own (direct setItem and _saveSession), and unreadable storage without memory or unparseable body discards before network", async () => {
    const storage = memoryStorage({});
    const locks = createFifoLocks();
    const events = [];
    let wireCalls = 0;
    let capturedStorage = null;
    let capturedAuthFetch = null;

    const fetchImpl = async () => {
      wireCalls += 1;
      return new Response(
        JSON.stringify({
          access_token: "at-should-not-happen",
          refresh_token: "rt-should-not-happen",
          expires_in: 3600,
          token_type: "bearer",
          user: { id: "user-1", aud: "authenticated" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    await withBrowserEnv({ storage, locks, fetchImpl }, async () => {
      const session = makeRealSession({
        createClient(url, key, opts) {
          capturedStorage = opts.auth.storage;
          capturedAuthFetch = opts.global.fetch;
          return createClient(url, key, opts);
        },
      });
      session.client.auth.onAuthStateChange((event, sess) => events.push({ event, sess }));
      try {
        await session.client.auth.initialize();
        await settleLockIdle(locks);
        storage.ops.length = 0;
        events.length = 0;

        // 1) Obtain a genuine sentinel payload from this instance's authFetch (zero wire calls).
        const sentinelResp = await capturedAuthFetch(`${TEST_API_URL}/auth/v1/token?grant_type=refresh_token`, {
          method: "POST",
          body: "not-valid-json",
        });
        assert.equal(wireCalls, 0, "unparseable refresh body discarded before network");
        const sentinelSession = await sentinelResp.json();
        assert.equal(sentinelSession.access_token.startsWith("__cs_discard_v1_"), true);

        // 2) Direct authStorage.setItem refuses the sentinel payload via AuthRetryableFetchError.
        assert.throws(
          () => capturedStorage.setItem(TEST_STORAGE_KEY, JSON.stringify(sentinelSession)),
          (err) => err instanceof AuthRetryableFetchError,
          "independent setItem write fence rejects sentinel payload",
        );

        // 3) Pinned SDK _saveSession also fails at the independent write fence without writing or emitting events.
        await assert.rejects(
          () => session.client.auth._saveSession(sentinelSession),
          (err) => err instanceof AuthRetryableFetchError,
          "independent write fence stops _saveSession on an empty slot",
        );
        assert.equal(storage.entries.get(TEST_STORAGE_KEY), undefined, "empty slot stays empty");
        assert.equal(
          storage.ops.some((op) => op === `set:${TEST_STORAGE_KEY}`),
          false,
          "zero localStorage writes for sentinel payload",
        );
        assert.deepEqual(events, [], "zero events emitted");
      } finally {
        await session.quiesce();
      }
    });

    // 4) Unreadable storage with no current managed credential in memory discards BEFORE the network.
    const unreadableStorage = {
      get length() { throw new DOMException("SecurityError", "SecurityError"); },
      key() { throw new DOMException("SecurityError", "SecurityError"); },
      getItem() { throw new DOMException("SecurityError", "SecurityError"); },
      setItem() { throw new DOMException("SecurityError", "SecurityError"); },
      removeItem() { throw new DOMException("SecurityError", "SecurityError"); },
    };
    const unreadableEvents = [];
    let unreadableWireCalls = 0;
    await withBrowserEnv({
      storage: unreadableStorage,
      locks: createFifoLocks(),
      fetchImpl: async () => {
        unreadableWireCalls += 1;
        return new Response(JSON.stringify({}), { status: 200 });
      },
    }, async () => {
      const session = makeRealSession();
      session.client.auth.onAuthStateChange((e, s) => unreadableEvents.push({ e, s }));
      try {
        await session.client.auth.initialize();
        const res = await session.client.auth.refreshSession({ refresh_token: "rt-unreadable-orphan" });
        assert.equal(unreadableWireCalls, 0, "unreadable storage without memory discards before network");
        assert.equal(res.data.session, null);
        assert.equal(isAuthRefreshDiscardedError(res.error), true, "exited via AuthRefreshDiscardedError");
        assert.deepEqual(unreadableEvents, [], "zero events emitted");
      } finally {
        await session.quiesce();
      }
    });
  });
});

test("Real module witness: confirmed sign-out control (terminal refusal with matching stored credential still removes session and emits SIGNED_OUT)", async () => {
  const initialStored = makeStoredSession({
    accessToken: "at-dead",
    refreshToken: "rt-dead",
    expired: true,
  });
  const storage = memoryStorage({ [TEST_STORAGE_KEY]: initialStored });
  const locks = createFifoLocks();
  const events = [];

  const fetchImpl = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/auth/v1/token")) {
      return new Response(
        JSON.stringify({ code: "refresh_token_not_found", error_code: "refresh_token_not_found" }),
        {
          status: 400,
          headers: {
            "content-type": "application/json",
            "x-supabase-api-version": "2024-01-01",
          },
        },
      );
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  await withBrowserEnv({ storage, locks, fetchImpl }, async ({ dispatchStorageEvent }) => {
    const session = makeRealSession();
    session.client.auth.onAuthStateChange((event, sess) => events.push({ event, sess }));
    try {
      await session.client.auth.initialize();
      await settleLockIdle(locks);

      assert.equal(locks.isHeld(TEST_LOCK_NAME), false, "lock released");
      assert.equal(storage.entries.get(TEST_STORAGE_KEY), undefined, "expired dead session was removed from storage");
      assert.equal(storage.entries.has(TEST_BACKOFF_KEY), false, "no backoff left behind after terminal sign-out");
      assert.ok(events.some((e) => e.event === "SIGNED_OUT" && e.sess === null), "SIGNED_OUT was emitted");

      // verifiedSession() on a matching terminal refusal (freshly stored expired credential)
      // removes the dead session, emits SIGNED_OUT, and throws SessionExpired.
      events.length = 0;
      const dead2 = makeStoredSession({
        accessToken: "at-dead-2",
        refreshToken: "rt-dead-2",
        expired: true,
      });
      storage.entries.set(TEST_STORAGE_KEY, dead2);
      dispatchStorageEvent({ key: TEST_STORAGE_KEY, oldValue: null, newValue: dead2 });
      await assert.rejects(() => session.verifiedSession(), SessionExpired);
      assert.equal(storage.entries.get(TEST_STORAGE_KEY), undefined, "dead session removed again");
      assert.ok(events.some((e) => e.event === "SIGNED_OUT" && e.sess === null), "SIGNED_OUT emitted on verifiedSession terminal refusal");
    } finally {
      await session.quiesce();
    }
  });
});

test("Real module witness: late refusal after a replacement login leaves the replacement alone (no write, no removal, no event) and verifies replacement once", async (t) => {
  const cases = [
    {
      name: "terminal 400 refresh_token_not_found after same-user replacement login",
      replacementUserId: "user-1",
      respond: () =>
        new Response(
          JSON.stringify({ code: "refresh_token_not_found", error_code: "refresh_token_not_found" }),
          {
            status: 400,
            headers: { "content-type": "application/json", "x-supabase-api-version": "2024-01-01" },
          },
        ),
    },
    {
      name: "terminal 400 session_not_found after different-user replacement login",
      replacementUserId: "user-2",
      respond: () =>
        new Response(
          JSON.stringify({ code: "session_not_found", error_code: "session_not_found" }),
          {
            status: 400,
            headers: { "content-type": "application/json", "x-supabase-api-version": "2024-01-01" },
          },
        ),
    },
    {
      name: "non-terminal 400 refresh_token_already_used after replacement login",
      replacementUserId: "user-2",
      respond: () =>
        new Response(
          JSON.stringify({ code: "refresh_token_already_used", error_code: "refresh_token_already_used" }),
          {
            status: 400,
            headers: { "content-type": "application/json", "x-supabase-api-version": "2024-01-01" },
          },
        ),
    },
    {
      name: "transport error after replacement login",
      replacementUserId: "user-2",
      respond: () => {
        throw new TypeError("Failed to fetch");
      },
    },
  ];

  for (const c of cases) {
    await t.test(c.name, async () => {
      const initialStored = makeStoredSession({
        accessToken: "at-old",
        refreshToken: "rt-old",
        expired: true,
        userId: "user-1",
      });
      const replacementStored = makeStoredSession({
        accessToken: "at-replacement",
        refreshToken: "rt-replacement",
        expired: false,
        userId: c.replacementUserId,
      });
      const storage = memoryStorage({ [TEST_STORAGE_KEY]: initialStored });
      const locks = createFifoLocks();
      const events = [];
      const userCheckTokens = [];

      let refreshStartedResolve;
      const refreshStarted = new Promise((r) => { refreshStartedResolve = r; });
      let releaseRefresh;
      const refreshHeld = new Promise((r) => { releaseRefresh = r; });
      let refreshCalls = 0;

      const fetchImpl = async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("/auth/v1/token")) {
          refreshCalls += 1;
          refreshStartedResolve();
          await refreshHeld;
          return c.respond();
        }
        if (url.includes("/auth/v1/user")) {
          userCheckTokens.push(new Headers(init?.headers).get("authorization"));
          return new Response(
            JSON.stringify({ id: c.replacementUserId, aud: "authenticated", email: "owner@example.test" }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        throw new Error(`Unexpected URL: ${url}`);
      };

      await withBrowserEnv({ storage, locks, fetchImpl }, async () => {
        const session = makeRealSession();
        session.client.auth.onAuthStateChange((event, sess) => events.push({ event, sess }));

        try {
          const pendingVerify = session.verifiedSession();
          await refreshStarted;

          // Replacement login lands in storage while old refresh is still in flight.
          storage.entries.set(TEST_STORAGE_KEY, replacementStored);
          const sessionOpsBefore = storage.ops.filter(
            (op) => op === `set:${TEST_STORAGE_KEY}` || op === `remove:${TEST_STORAGE_KEY}`,
          ).length;

          const answeredAt = Date.now();
          releaseRefresh();
          const verified = await pendingVerify;

          assert.ok(Date.now() - answeredAt < 250, "settled within 250 ms");
          assert.equal(refreshCalls, 1, "only the original in-flight refresh hit the wire");
          assert.equal(locks.isHeld(TEST_LOCK_NAME), false, "lock released");
          assert.equal(verified?.refresh_token, "rt-replacement", "verifiedSession returned replacement login");
          assert.equal(verified?.user.id, c.replacementUserId);
          assert.deepEqual(userCheckTokens, ["Bearer at-replacement"], "verified replacement once with getUser()");
          assert.equal(storage.entries.get(TEST_STORAGE_KEY), replacementStored, "replacement login untouched in storage");
          assert.equal(storage.entries.has(TEST_BACKOFF_KEY), false, "no backoff written for superseded token");
          const sessionOpsAfter = storage.ops.filter(
            (op) => op === `set:${TEST_STORAGE_KEY}` || op === `remove:${TEST_STORAGE_KEY}`,
          ).length;
          assert.equal(sessionOpsAfter, sessionOpsBefore, "zero writes or removals on replacement slot");
          assert.deepEqual(events, [], "zero SIGNED_OUT or false TOKEN_REFRESHED events emitted");
        } finally {
          await session.quiesce();
        }
      });
    });
  }
});

test("Real module witness (Condition 4): late subscription with expired session produces zero refreshes outside the lock and fans out real events", async () => {
  const expiredStored = makeStoredSession({
    accessToken: "at-1",
    refreshToken: "rt-1",
    expired: true,
  });
  const storage = memoryStorage({ [TEST_STORAGE_KEY]: expiredStored });
  const locks = createFifoLocks();

  const refreshObservations = [];
  const storageSetLockStates = [];
  let allowSuccess = false;

  const fetchImpl = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/auth/v1/token")) {
      await new Promise((r) => setImmediate(r));
      refreshObservations.push({ lockHeldWhileInFlight: locks.isHeld(TEST_LOCK_NAME) });
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

  await withBrowserEnv({ storage, locks, fetchImpl }, async () => {
    const session = makeRealSession({
      createClient(url, key, opts) {
        const origStorage = opts.auth.storage;
        return createClient(url, key, {
          ...opts,
          auth: {
            ...opts.auth,
            storage: {
              getItem: (k) => origStorage.getItem(k),
              removeItem: (k) => origStorage.removeItem(k),
              setItem: (k, v) => {
                storageSetLockStates.push({ key: k, lockHeldDuringSetItem: locks.isHeld(TEST_LOCK_NAME) });
                return origStorage.setItem(k, v);
              },
            },
          },
        });
      },
    });

    const earlyEvents = [];
    const lateEvents = [];

    try {
      const earlySub = session.client.auth.onAuthStateChange((event, sess) => {
        earlyEvents.push({ event, rt: sess?.refresh_token ?? null });
      });

      await session.client.auth.initialize();
      await settleLockIdle(locks);
      await session.client.auth.stopAutoRefresh();
      await settleLockIdle(locks);

      const wireCallsBeforeLateSub = refreshObservations.length;
      const acquiresBeforeLateSub = locks.acquireCount;

      assert.equal(wireCallsBeforeLateSub, 1, "exactly one locked init refresh ran");
      assert.equal(
        refreshObservations.every((o) => o.lockHeldWhileInFlight === true),
        true,
        "every init/early refresh held the Web Lock throughout the in-flight request (zero unlocked _emitInitialSession refreshes)",
      );

      // Late subscription while storage STILL holds expired rt-1 (even with backoff cleared):
      storage.entries.delete(TEST_BACKOFF_KEY);
      const lateSub = session.client.auth.onAuthStateChange((event, sess) => {
        lateEvents.push({ event, rt: sess?.refresh_token ?? null });
      });

      await new Promise((r) => setTimeout(r, 50));

      assert.equal(refreshObservations.length, wireCallsBeforeLateSub, "late subscription triggered ZERO wire refresh requests");
      assert.equal(locks.acquireCount, acquiresBeforeLateSub, "late subscription acquired ZERO locks");
      assert.equal(locks.isHeld(TEST_LOCK_NAME), false, "lock is not held");
      assert.equal(storage.entries.get(TEST_STORAGE_KEY), expiredStored, "storage untouched by late subscribe");

      // Now perform a real locked refresh via getSession() and verify storage settles under the lock
      // and real auth events fan out to both early and late subscribers.
      allowSuccess = true;
      const sessionRes = await session.client.auth.getSession();

      assert.equal(sessionRes.error, null, "locked getSession() succeeded");
      assert.equal(sessionRes.data.session?.refresh_token, "rt-2");
      assert.equal(refreshObservations.length, wireCallsBeforeLateSub + 1, "exactly one locked wire refresh occurred");
      assert.equal(refreshObservations.at(-1).lockHeldWhileInFlight, true, "wire refresh held the Web Lock");
      assert.equal(storageSetLockStates.length, 1, "rotated session written to storage");
      assert.equal(storageSetLockStates[0].lockHeldDuringSetItem, true, "storage.setItem ran UNDER the Web Lock");
      assert.equal(locks.isHeld(TEST_LOCK_NAME), false, "Web Lock released after storage settled");
      assert.deepEqual(earlyEvents, [{ event: "TOKEN_REFRESHED", rt: "rt-2" }]);
      assert.deepEqual(lateEvents, [{ event: "TOKEN_REFRESHED", rt: "rt-2" }]);

      earlySub.data.subscription.unsubscribe();
      lateSub.data.subscription.unsubscribe();
    } finally {
      await session.quiesce();
    }
  });
});

test("Real module witness (Item 4 & Item 2): interleaved reads on same client and second client while discard marker is armed always see the real slot; discard still happens; finally retires marker even when post-request read is skipped", async (t) => {
  await t.test("Interleaving while marker is armed: same-client verified read, second-client verified read, storage event, and non-session key read all see real slot; discard still succeeds", async () => {
    const validStored = makeStoredSession({
      accessToken: "at-real-valid",
      refreshToken: "rt-real-valid",
      expired: false,
      userId: "user-1",
    });
    const storage = memoryStorage({
      [TEST_STORAGE_KEY]: validStored,
      "unrelated-key": "unrelated-value",
    });
    const locks = createFifoLocks();
    const events1 = [];
    const events2 = [];
    const userTokensChecked = [];
    let s1StorageAdapter;
    let s2StorageAdapter;

    let markerArmedResolve;
    const markerArmed = new Promise((r) => { markerArmedResolve = r; });
    let releaseCommitRead;
    const commitReadHeld = new Promise((r) => { releaseCommitRead = r; });

    const fetchImpl = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/auth/v1/token")) {
        return new Response(JSON.stringify({ code: "over_request_rate_limit" }), {
          status: 429,
          headers: { "content-type": "application/json", "x-supabase-api-version": "2024-01-01" },
        });
      }
      if (url.includes("/auth/v1/user")) {
        userTokensChecked.push(new Headers(init?.headers).get("authorization"));
        return new Response(
          JSON.stringify({ id: "user-1", aud: "authenticated", email: "owner@example.test" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    await withBrowserEnv({ storage, locks, fetchImpl }, async ({ dispatchStorageEvent }) => {
      const s1 = makeRealSession({
        createClient(url, key, opts) {
          s1StorageAdapter = opts.auth.storage;
          return createClient(url, key, opts);
        },
      });
      const s2 = makeRealSession({
        createClient(url, key, opts) {
          s2StorageAdapter = opts.auth.storage;
          return createClient(url, key, opts);
        },
      });
      s1.client.auth.onAuthStateChange((e, sess) => events1.push({ e, sess }));
      s2.client.auth.onAuthStateChange((e, sess) => events2.push({ e, sess }));

      try {
        await Promise.all([s1.client.auth.initialize(), s2.client.auth.initialize()]);
        await settleLockIdle(locks);
        events1.length = 0;
        events2.length = 0;

        // Pause RIGHT AFTER createBrowserSession's _refreshAccessToken wrapper arms
        // commitGuardReadArmed and RIGHT BEFORE GoTrueClient._callRefreshToken's
        // post-request `storedAfter` read (GoTrueClient.ts:5012).
        const wrappedRefreshAccessToken = s1.client.auth._refreshAccessToken.bind(s1.client.auth);
        s1.client.auth._refreshAccessToken = async (rt) => {
          const result = await wrappedRefreshAccessToken(rt);
          markerArmedResolve();
          await commitReadHeld;
          return result;
        };

        const pendingFailedRefresh = s1.client.auth.refreshSession();
        await markerArmed;

        // Marker is now ARMED on s1, and GoTrue's post-request commit read has NOT run yet!
        // 1) Non-session key read on s1 must see real value and NOT consume the marker.
        assert.equal(s1StorageAdapter.getItem("unrelated-key"), "unrelated-value");
        // 2) Storage event reconciliation on s1 and s2 must see the real slot and NOT consume the marker.
        dispatchStorageEvent({ key: TEST_STORAGE_KEY, oldValue: validStored, newValue: validStored });
        // 3) Direct storage adapter read on second client s2 must see real stored session (never false absence).
        assert.equal(s2StorageAdapter.getItem(TEST_STORAGE_KEY), validStored);
        // 4) Force ordinary verified reads on BOTH s1 (same client) and s2 (second client) while armed.
        const interleavedReadS1 = s1.verifiedSession();
        const interleavedReadS2 = s2.verifiedSession();

        // Let s1's commit-guard read run and finish the failed refresh attempt.
        releaseCommitRead();
        const [refreshRes, verified1, verified2] = await Promise.all([
          pendingFailedRefresh,
          interleavedReadS1,
          interleavedReadS2,
        ]);

        // Discard STILL happened cleanly!
        assert.equal(refreshRes.data.session, null);
        assert.equal(isAuthRefreshDiscardedError(refreshRes.error), true, "discard still occurred after interleaving");
        // Both interleaved verified reads saw the REAL stored session (never fabricated, never false absence).
        assert.equal(verified1?.access_token, "at-real-valid");
        assert.equal(verified1?.refresh_token, "rt-real-valid");
        assert.equal(verified2?.access_token, "at-real-valid");
        assert.equal(verified2?.refresh_token, "rt-real-valid");
        assert.deepEqual(userTokensChecked, ["Bearer at-real-valid", "Bearer at-real-valid"]);
        assert.equal(storage.entries.get(TEST_STORAGE_KEY), validStored, "session slot untouched");
        assert.equal(
          storage.ops.some((op) => op === `set:${TEST_STORAGE_KEY}` || op === `remove:${TEST_STORAGE_KEY}`),
          false,
          "zero session slot mutations",
        );
        assert.deepEqual(events1, [], "zero false events on s1");
        assert.deepEqual(events2, [], "zero false events on s2");
        assert.equal(locks.isHeld(TEST_LOCK_NAME), false, "lock released");
      } finally {
        await Promise.all([s1.quiesce(), s2.quiesce()]);
      }
    });
  });

  await t.test("finally guarantees marker retirement when _callRefreshToken exits via exception without making the post-request read", async () => {
    const validStored = makeStoredSession({
      accessToken: "at-still-here",
      refreshToken: "rt-still-here",
      expired: false,
    });
    const storage = memoryStorage({ [TEST_STORAGE_KEY]: validStored });
    const locks = createFifoLocks();
    let capturedStorage;

    const fetchImpl = async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/auth/v1/token")) {
        return new Response(JSON.stringify({ code: "over_request_rate_limit" }), {
          status: 429,
          headers: { "content-type": "application/json", "x-supabase-api-version": "2024-01-01" },
        });
      }
      if (url.includes("/auth/v1/user")) {
        return new Response(
          JSON.stringify({ id: "user-1", aud: "authenticated" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    await withBrowserEnv({ storage, locks, fetchImpl }, async () => {
      const s1 = makeRealSession({
        createClient(url, key, opts) {
          capturedStorage = opts.auth.storage;
          return createClient(url, key, opts);
        },
      });
      try {
        await s1.client.auth.initialize();
        await settleLockIdle(locks);

        // Force _refreshAccessToken to return an AuthError AFTER createBrowserSession arms
        // commitGuardReadArmed so GoTrueClient._callRefreshToken exits at `if (error) throw error`
        // BEFORE line 5012's `storedAfter` getItemAsync read.
        const wrappedRefreshAccessToken = s1.client.auth._refreshAccessToken.bind(s1.client.auth);
        s1.client.auth._refreshAccessToken = async (rt) => {
          await wrappedRefreshAccessToken(rt); // arms commitGuardReadArmed!
          return {
            data: { session: null, user: null },
            error: new AuthRetryableFetchError("Simulated error before storedAfter read", 0),
          };
        };

        const abortedRes = await s1.client.auth.refreshSession();
        assert.equal(abortedRes.data.session, null);
        assert.equal(abortedRes.error?.name, "AuthRetryableFetchError");
        assert.equal(locks.isHeld(TEST_LOCK_NAME), false, "lock released after error exit");
        // Marker MUST have been retired by finally: the very next read sees the real slot!
        assert.equal(capturedStorage.getItem(TEST_STORAGE_KEY), validStored, "marker retired in finally; real slot visible");
        const verified = await s1.verifiedSession();
        assert.equal(verified?.access_token, "at-still-here");
      } finally {
        await s1.quiesce();
      }
    });
  });
});

test("Real module witness (Items 6, 7, 10, 11): synchronous _emitInitialSession neutralization blocks constructor listener; full event path delivers sign-in/rotation/sign-out to shared module, early/late subscribers, and realtime.setAuth; startup & URL callback work without INITIAL_SESSION; quiesced/replaced client delivers nothing", async (t) => {
  await t.test("Item 6: _emitInitialSession is neutralized synchronously before any microtask so SupabaseClient's constructor listener cannot reach the original method", async () => {
    const expiredStored = makeStoredSession({ accessToken: "at-1", refreshToken: "rt-1", expired: true });
    const storage = memoryStorage({ [TEST_STORAGE_KEY]: expiredStored });
    const locks = createFifoLocks();
    let originalEmitCalls = 0;

    const fetchImpl = async () =>
      new Response(JSON.stringify({ code: "over_request_rate_limit" }), {
        status: 429,
        headers: { "content-type": "application/json", "x-supabase-api-version": "2024-01-01" },
      });

    await withBrowserEnv({ storage, locks, fetchImpl }, async () => {
      const session = makeRealSession({
        createClient(url, key, opts) {
          const client = createClient(url, key, opts);
          const orig = client.auth._emitInitialSession.bind(client.auth);
          client.auth._emitInitialSession = async (...args) => {
            originalEmitCalls += 1;
            return orig(...args);
          };
          return client;
        },
      });
      try {
        // Synchronously upon return, _emitInitialSession is overwritten on the instance.
        assert.equal(Object.prototype.hasOwnProperty.call(session.client.auth, "_emitInitialSession"), true);
        await session.client.auth.initialize();
        await new Promise((r) => setTimeout(r, 30));
        await settleLockIdle(locks);
        assert.equal(originalEmitCalls, 0, "constructor's _listenForAuthEvents IIFE never reached original _emitInitialSession");
      } finally {
        await session.quiesce();
      }
    });
  });

  await t.test("Item 7: SIGNED_IN, TOKEN_REFRESHED, and SIGNED_OUT deliver to shared module handling, early subscriber, late subscriber, and SupabaseClient._handleTokenChanged (realtime.setAuth)", async () => {
    const storage = memoryStorage({});
    const locks = createFifoLocks();
    const realtimeAuthCalls = [];
    const earlyEvents = [];
    const lateEvents = [];

    const fetchImpl = async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/auth/v1/token?grant_type=password")) {
        return new Response(
          JSON.stringify({
            access_token: "at-signin",
            refresh_token: "rt-signin",
            expires_in: 3600,
            token_type: "bearer",
            user: { id: "user-1", aud: "authenticated", email: "owner@example.test" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/auth/v1/token?grant_type=refresh_token")) {
        return new Response(
          JSON.stringify({
            access_token: "at-rotated",
            refresh_token: "rt-rotated",
            expires_in: 3600,
            token_type: "bearer",
            user: { id: "user-1", aud: "authenticated", email: "owner@example.test" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/auth/v1/logout")) {
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    await withBrowserEnv({ storage, locks, fetchImpl }, async () => {
      const session = makeRealSession();
      const origSetAuth = session.client.realtime.setAuth.bind(session.client.realtime);
      session.client.realtime.setAuth = (token) => {
        realtimeAuthCalls.push(token);
        return origSetAuth(token);
      };

      try {
        const earlySub = session.client.auth.onAuthStateChange((event, sess) => {
          earlyEvents.push({ event, at: sess?.access_token ?? null });
        });
        await session.client.auth.initialize();
        await settleLockIdle(locks);
        await session.client.auth.stopAutoRefresh();
        await settleLockIdle(locks);

        const acquiresBeforeLate = locks.acquireCount;
        const lateSub = session.client.auth.onAuthStateChange((event, sess) => {
          lateEvents.push({ event, at: sess?.access_token ?? null });
        });
        await new Promise((r) => setTimeout(r, 20));
        assert.equal(locks.acquireCount, acquiresBeforeLate, "late subscriber acquired zero locks");

        // Seed stale backoff entry: events are read-only hints outside the lock (Condition 1),
        // so signInWithPassword (which runs outside _acquireLock in pinned auth-js 2.111.0)
        // leaves the stale key untouched on disk while ignoring it for the new session, and
        // locked operations (refreshSession, signOut) clean it up under the cross-tab lock.
        const seedBackoff = () => storage.entries.set(TEST_BACKOFF_KEY, JSON.stringify({ gen: "v1:uid:user-1:1", nextAttemptAt: Date.now() + 30_000, attempts: 1 }));

        // 1) Sign in -> SIGNED_IN
        seedBackoff();
        const signInRes = await session.client.auth.signInWithPassword({ email: "owner@example.test", password: "pw" });
        assert.equal(signInRes.error, null);
        assert.equal(storage.entries.has(TEST_BACKOFF_KEY), true, "SIGNED_IN event handler did not mutate shared backoff outside the lock");

        // 2) Token rotation -> TOKEN_REFRESHED (runs under lock, clears stale backoff)
        seedBackoff();
        const refreshRes = await session.client.auth.refreshSession();
        assert.equal(refreshRes.error, null);
        assert.equal(storage.entries.has(TEST_BACKOFF_KEY), false, "locked refresh cleared backoff");

        // 3) Sign out -> SIGNED_OUT (runs under lock, clears stale backoff)
        seedBackoff();
        const signOutRes = await session.signOut();
        assert.deepEqual(signOutRes, { signedOutLocally: true, serverRevoked: true, replaced: false, retry: false });
        assert.equal(storage.entries.has(TEST_BACKOFF_KEY), false, "locked signOut cleared backoff");

        const expected = [
          { event: "SIGNED_IN", at: "at-signin" },
          { event: "TOKEN_REFRESHED", at: "at-rotated" },
          { event: "SIGNED_OUT", at: null },
        ];
        assert.deepEqual(earlyEvents, expected, "early subscriber received sign-in, rotation, and sign-out");
        assert.deepEqual(lateEvents, expected, "late subscriber received sign-in, rotation, and sign-out");
        assert.deepEqual(
          realtimeAuthCalls,
          ["at-signin", "at-rotated", undefined],
          "SupabaseClient._handleTokenChanged still received sign-in, rotation, and sign-out",
        );

        earlySub.data.subscription.unsubscribe();
        lateSub.data.subscription.unsubscribe();
      } finally {
        await session.quiesce();
      }
    });
  });

  await t.test("Item 10: URL auth callback (detectSessionInUrl: true) and startup verified loading (detectSessionInUrl: false) work without INITIAL_SESSION", async () => {
    const storage = memoryStorage({});
    const locks = createFifoLocks();
    const callbackEvents = [];
    const realtimeTokens = [];

    const prevWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const prevDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    const callbackUrl = "https://commonswarm.com/app#access_token=at-callback&refresh_token=rt-callback&expires_in=3600&token_type=bearer";
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { href: callbackUrl, hash: "#access_token=at-callback&refresh_token=rt-callback&expires_in=3600&token_type=bearer", search: "" },
        history: { replaceState() {} },
        addEventListener() {},
        removeEventListener() {},
      },
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { visibilityState: "visible", addEventListener() {}, removeEventListener() {} },
    });

    const fetchImpl = async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/auth/v1/user")) {
        return new Response(
          JSON.stringify({ id: "user-cb", aud: "authenticated", email: "cb@example.test" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    try {
      await withBrowserEnv({ storage, locks, fetchImpl }, async () => {
        const cbSession = createBrowserSession({
          url: TEST_API_URL,
          anonKey: "anon-key",
          detectSessionInUrl: true,
          allowProcessLockFallback: false,
          sdk: { createClient, navigatorLock, processLock, isAuthSessionMissingError, AuthRetryableFetchError },
        });
        assert.equal(cbSession.ok, true);
        if (!cbSession.ok) return;
        const origSetAuth = cbSession.client.realtime.setAuth.bind(cbSession.client.realtime);
        cbSession.client.realtime.setAuth = (tok) => {
          realtimeTokens.push(tok);
          return origSetAuth(tok);
        };
        cbSession.client.auth.onAuthStateChange((event, sess) => callbackEvents.push({ event, at: sess?.access_token ?? null }));

        try {
          const verified = await cbSession.currentSession();
          await new Promise((r) => setTimeout(r, 20));
          assert.equal(verified?.access_token, "at-callback", "locked currentSession() loaded and verified URL callback session");
          assert.equal(verified?.user.id, "user-cb");
          assert.equal(callbackEvents.some((e) => e.event === "INITIAL_SESSION"), false, "no INITIAL_SESSION emitted");
          assert.deepEqual(callbackEvents, [{ event: "SIGNED_IN", at: "at-callback" }], "URL callback still emitted SIGNED_IN");
          assert.deepEqual(realtimeTokens, ["at-callback"], "realtime.setAuth updated from URL callback SIGNED_IN");
        } finally {
          await cbSession.quiesce();
        }

        // Now verify startup with detectSessionInUrl: false loads initial state purely via locked currentSession()
        // without relying on INITIAL_SESSION.
        const appEvents = [];
        const appSession = makeRealSession();
        appSession.client.auth.onAuthStateChange((event) => appEvents.push(event));
        try {
          const loaded = await appSession.currentSession();
          assert.equal(loaded?.access_token, "at-callback");
          assert.equal(appEvents.includes("INITIAL_SESSION"), false, "no INITIAL_SESSION emitted on startup verified load");
        } finally {
          await appSession.quiesce();
        }
      });
    } finally {
      if (prevWindow) Object.defineProperty(globalThis, "window", prevWindow);
      else delete globalThis.window;
      if (prevDocument) Object.defineProperty(globalThis, "document", prevDocument);
      else delete globalThis.document;
    }
  });

  await t.test("Item 11: quiesced or replaced client fan-out delivers nothing to early, late, or post-quiesce subscribers", async () => {
    const storage = memoryStorage({});
    const locks = createFifoLocks();
    const s1Events = [];
    const s2Events = [];

    const fetchImpl = async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/auth/v1/token?grant_type=password")) {
        return new Response(
          JSON.stringify({
            access_token: "at-s2",
            refresh_token: "rt-s2",
            expires_in: 3600,
            token_type: "bearer",
            user: { id: "user-2", aud: "authenticated" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    await withBrowserEnv({ storage, locks, fetchImpl }, async () => {
      const s1 = makeRealSession();
      s1.client.auth.onAuthStateChange((event) => s1Events.push(`early:${event}`));
      await s1.client.auth.initialize();
      s1.client.auth.onAuthStateChange((event) => s1Events.push(`late:${event}`));

      // Capture the single SDK bridge callback registered on s1 before quiesce clears emitters.
      const s1BridgeCallbacks = [...s1.client.auth.stateChangeEmitters.values()].map((e) => e.callback);

      await s1.quiesce();
      // Even subscribing after quiesce or invoking the stale bridge directly delivers nothing.
      s1.client.auth.onAuthStateChange((event) => s1Events.push(`post:${event}`));
      for (const cb of s1BridgeCallbacks) {
        await cb("SIGNED_IN", { access_token: "at-stale", refresh_token: "rt-stale", user: { id: "user-1" } });
        await cb("SIGNED_OUT", null);
      }

      // Replacement client s2 signs in cleanly and receives its own events.
      const s2 = makeRealSession();
      s2.client.auth.onAuthStateChange((event, sess) => s2Events.push({ event, at: sess?.access_token ?? null }));
      try {
        await s2.client.auth.initialize();
        await s2.client.auth.signInWithPassword({ email: "two@example.test", password: "pw" });
        assert.deepEqual(s1Events, [], "quiesced client fan-out delivered nothing");
        assert.deepEqual(s2Events, [{ event: "SIGNED_IN", at: "at-s2" }], "replacement client delivered normally");
      } finally {
        await s2.quiesce();
      }
    });
  });
});

test("Real module witness (Item 8): unsupported SDK instance fails closed without handing out a client or starting the unlocked path", async (t) => {
  const cases = [
    {
      name: "missing _emitInitialSession method",
      mutate(client) {
        Object.defineProperty(client.auth, "_emitInitialSession", { value: undefined, configurable: true });
      },
    },
    {
      name: "missing _callRefreshToken method",
      mutate(client) {
        Object.defineProperty(client.auth, "_callRefreshToken", { value: undefined, configurable: true });
      },
    },
    {
      name: "mismatched runtime X-Client-Info version",
      mutate(client) {
        client.headers = { ...client.headers, "X-Client-Info": "supabase-js/2.999.0; runtime=node" };
      },
    },
  ];

  for (const c of cases) {
    await t.test(c.name, async () => {
      const expiredStored = makeStoredSession({ accessToken: "at-1", refreshToken: "rt-1", expired: true });
      const storage = memoryStorage({ [TEST_STORAGE_KEY]: expiredStored });
      const locks = createFifoLocks();
      let wireCalls = 0;

      const fetchImpl = async () => {
        wireCalls += 1;
        return new Response(JSON.stringify({ code: "over_request_rate_limit" }), { status: 429 });
      };

      await withBrowserEnv({ storage, locks, fetchImpl }, async () => {
        const result = createBrowserSession({
          url: TEST_API_URL,
          anonKey: "anon-key",
          detectSessionInUrl: false,
          allowProcessLockFallback: false,
          sdk: {
            createClient(url, key, opts) {
              const client = createClient(url, key, opts);
              c.mutate(client);
              return client;
            },
            navigatorLock,
            processLock,
            isAuthSessionMissingError,
            AuthRetryableFetchError,
          },
        });

        assert.deepEqual(result, { ok: false, reason: "unsupported_sdk" });
        assert.equal("client" in result, false, "no client is handed out on unsupported SDK");

        await new Promise((r) => setTimeout(r, 40));
        await settleLockIdle(locks);

        assert.equal(wireCalls, 0, "unsupported instance never started a refresh request");
        assert.equal(locks.isHeld(TEST_LOCK_NAME), false, "no lock held");
        assert.equal(storage.entries.get(TEST_STORAGE_KEY), expiredStored, "stored session untouched");
        assert.equal(
          storage.ops.some((op) => op === `set:${TEST_STORAGE_KEY}` || op === `remove:${TEST_STORAGE_KEY}`),
          false,
          "zero storage mutations",
        );
      });
    });
  }
});

test("commonswarm single-account failure handling: only unsupported_sdk rejects with AuthRecoveryRequired; locks_unavailable returns null as before", async () => {
  try {
    // 1. locks_unavailable: restores exact pre-branch behaviour (returns null, does not reject, does not cache failure).
    let calls = 0;
    let mode = "locks_unavailable";
    const fakeSessionObj = { access_token: "at-ok", refresh_token: "rt-ok", user: { id: "user-1" } };
    configureSingleAccountForTesting({
      deployment: { url: TEST_API_URL, anonKey: "anon-key" },
      createSession() {
        calls += 1;
        if (mode === "locks_unavailable") {
          return { ok: false, reason: "locks_unavailable" };
        }
        return {
          ok: true,
          client: { fake: true },
          storageKey: TEST_STORAGE_KEY,
          currentSession: async () => fakeSessionObj,
          verifiedSession: async () => fakeSessionObj,
          boundedAuth: (p) => p,
          signOut: async () => ({ signedOutLocally: true, serverRevoked: true, replaced: false, retry: false }),
          quiesce: async () => undefined,
        };
      },
    });

    assert.equal(commonswarmClient(), null, "locks_unavailable returns null client");
    assert.equal(await commonswarmCurrentSession(), null, "locks_unavailable resolves to null, never AuthRecoveryRequired");
    assert.equal(calls, 2, "locks_unavailable is not permanently cached");

    // Once creation succeeds, client() and currentSession() recover normally.
    mode = "ok";
    assert.ok(commonswarmClient() !== null, "subsequent creation succeeds");
    assert.equal(await commonswarmCurrentSession(), fakeSessionObj, "currentSession returns session after recovery");

    // 2. unsupported_sdk: fails closed with AuthRecoveryRequired and stays cached.
    let unsupportedCalls = 0;
    configureSingleAccountForTesting({
      deployment: { url: TEST_API_URL, anonKey: "anon-key" },
      createSession() {
        unsupportedCalls += 1;
        return { ok: false, reason: "unsupported_sdk" };
      },
    });

    assert.equal(commonswarmClient(), null, "unsupported_sdk hands out no client");
    await assert.rejects(
      () => commonswarmCurrentSession(),
      AuthRecoveryRequired,
      "unsupported_sdk rejects with AuthRecoveryRequired",
    );
    await assert.rejects(
      () => commonswarmCurrentSession(),
      AuthRecoveryRequired,
      "unsupported_sdk stays fail-closed on repeat calls",
    );
    assert.equal(unsupportedCalls, 1, "unsupported_sdk caches failure and does not retry client creation");
  } finally {
    resetSingleAccountForTesting();
  }
});

// ============================================================================
// SOURCE-PIN TEST (Item 9): @supabase/supabase-js & @supabase/auth-js 2.111.0
// in BOTH site/ and app/ installs + private paths and commit-guard shape
// ============================================================================

test("Source pin (Item 9): site/ and app/ installs both pin @supabase/supabase-js and @supabase/auth-js 2.111.0 with expected _emitInitialSession, _callRefreshToken commit-guard, and constructor listener shapes", async () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  assert.equal(PINNED_SUPABASE_JS_VERSION, "2.111.0", "PINNED_SUPABASE_JS_VERSION constant matches 2.111.0");

  async function listTsFiles(dir) {
    const out = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...await listTsFiles(full));
      else if (entry.name.endsWith(".ts")) out.push(full);
    }
    return out;
  }

  const installRoots = [
    { label: "site", nodeModules: path.resolve(here, "../../node_modules") },
    { label: "app", nodeModules: path.resolve(here, "../../../app/node_modules") },
  ];

  for (const { label, nodeModules } of installRoots) {
    const authJsDir = path.join(nodeModules, "@supabase/auth-js");
    const supabaseJsDir = path.join(nodeModules, "@supabase/supabase-js");

    // 1) Pin BOTH package versions in BOTH site/ and app/ installs.
    const supabasePkg = JSON.parse(await readFile(path.join(supabaseJsDir, "package.json"), "utf8"));
    assert.equal(
      supabasePkg.version,
      PINNED_SUPABASE_JS_VERSION,
      `[${label}] Installed @supabase/supabase-js version changed from ${PINNED_SUPABASE_JS_VERSION} to ${supabasePkg.version}: re-verify SupabaseClient constructor _listenForAuthEvents(), X-Client-Info version header in src/lib/constants.ts, and GoTrueClient private hooks in shared/browser-session/index.ts before moving this pin.`,
    );
    const authPkg = JSON.parse(await readFile(path.join(authJsDir, "package.json"), "utf8"));
    assert.equal(
      authPkg.version,
      PINNED_SUPABASE_JS_VERSION,
      `[${label}] Installed @supabase/auth-js version changed from ${PINNED_SUPABASE_JS_VERSION} to ${authPkg.version}: re-verify GoTrueClient._callRefreshToken commit guard (storedAtStart -> _refreshAccessToken -> storedAfter -> storageChangedUnderUs -> AuthRefreshDiscardedError), _saveSession write-fence abort behavior, and onAuthStateChange/_emitInitialSession locking in shared/browser-session/index.ts before moving this pin.`,
    );

    // 2) Pin _emitInitialSession call sites across all of @supabase/auth-js/src.
    const tsFiles = await listTsFiles(path.join(authJsDir, "src"));
    const emitOccurrences = [];
    for (const file of tsFiles) {
      const content = await readFile(file, "utf8");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        if (lines[i].includes("_emitInitialSession")) {
          emitOccurrences.push({ file: path.relative(authJsDir, file), line: i + 1, text: lines[i].trim() });
        }
      }
    }
    assert.equal(
      emitOccurrences.length,
      3,
      `[${label}] Expected exactly 3 occurrences of _emitInitialSession in @supabase/auth-js/src (2 call branches in onAuthStateChange + 1 definition), found ${emitOccurrences.length}: ${JSON.stringify(emitOccurrences)}. Re-verify shared/browser-session/index.ts subscription neutralization and lock safety before moving this pin.`,
    );
    assert.equal(
      emitOccurrences.every((o) => o.file === "src/GoTrueClient.ts"),
      true,
      `[${label}] Unexpected file referencing _emitInitialSession: ${JSON.stringify(emitOccurrences)}. Re-verify shared/browser-session/index.ts before moving this pin.`,
    );
    assert.deepEqual(
      emitOccurrences.map((o) => o.text),
      [
        "this._emitInitialSession(id)",
        "await this._emitInitialSession(id)",
        "private async _emitInitialSession(id: string | symbol): Promise<void> {",
      ],
      `[${label}] Unexpected _emitInitialSession call sites in GoTrueClient.ts: ${JSON.stringify(emitOccurrences)}. Re-verify shared/browser-session/index.ts subscription neutralization and lock safety before moving this pin.`,
    );

    // 3) Pin the commit-guard read shape in GoTrueClient._callRefreshToken and single _refreshAccessToken call site.
    const goTrueSrc = await readFile(path.join(authJsDir, "src/GoTrueClient.ts"), "utf8");
    const refreshAccessCallLines = goTrueSrc
      .split("\n")
      .map((text, idx) => ({ line: idx + 1, text: text.trim() }))
      .filter((entry) => entry.text.includes("this._refreshAccessToken("));
    assert.equal(
      refreshAccessCallLines.length,
      1,
      `[${label}] Expected exactly 1 call site to this._refreshAccessToken(...) in GoTrueClient.ts (inside _callRefreshToken), found ${refreshAccessCallLines.length}: ${JSON.stringify(refreshAccessCallLines)}. Re-verify shared/browser-session/index.ts discard-marker arming in _refreshAccessToken before moving this pin.`,
    );

    const commitGuardSnippet = [
      "const storedAtStart = (await getItemAsync(this.storage, this.storageKey)) as Session | null",
      "",
      "      const { data, error } = await this._refreshAccessToken(refreshToken)",
      "      if (error) throw error",
      "      if (!data.session) throw new AuthSessionMissingError()",
      "",
      "      const storedAfter = (await getItemAsync(this.storage, this.storageKey)) as Session | null",
      "      const storageChangedUnderUs =",
      "        storedAtStart !== null &&",
      "        (storedAfter === null || storedAfter.refresh_token !== storedAtStart.refresh_token)",
      "",
      "      if (storageChangedUnderUs) {",
    ].join("\n");
    assert.equal(
      goTrueSrc.includes(commitGuardSnippet),
      true,
      `[${label}] GoTrueClient._callRefreshToken commit-guard read shape changed! Expected storedAtStart -> await this._refreshAccessToken(refreshToken) -> storedAfter -> storageChangedUnderUs with zero intervening storage reads. Re-verify shared/browser-session/index.ts discard exit and interleaving safety before moving this pin.`,
    );
    assert.equal(
      goTrueSrc.includes("error: new AuthRefreshDiscardedError(),"),
      true,
      `[${label}] GoTrueClient._callRefreshToken no longer returns AuthRefreshDiscardedError on storageChangedUnderUs. Re-verify shared/browser-session/index.ts discard exit before moving this pin.`,
    );
    assert.equal(
      goTrueSrc.includes("this.refreshingDeferred = new Deferred<CallRefreshTokenResult>()") &&
      goTrueSrc.includes("this.refreshingDeferred = null"),
      true,
      `[${label}] GoTrueClient._callRefreshToken refreshingDeferred lifecycle changed. Re-verify shared/browser-session/index.ts authStorage.getItem guard before moving this pin.`,
    );

    // 4) Pin SupabaseClient constructor listener registration and runtime X-Client-Info header format.
    const supaSrc = await readFile(path.join(supabaseJsDir, "src/SupabaseClient.ts"), "utf8");
    const supaMatches = supaSrc
      .split("\n")
      .map((text, idx) => ({ line: idx + 1, text: text.trim() }))
      .filter((entry) => entry.text.includes("onAuthStateChange"));
    assert.equal(
      supaMatches.length,
      1,
      `[${label}] Expected exactly 1 onAuthStateChange call in SupabaseClient.ts (_listenForAuthEvents), found ${supaMatches.length}: ${JSON.stringify(supaMatches)}. Re-verify subscription interception order in shared/browser-session/index.ts before moving this pin.`,
    );
    assert.equal(
      supaSrc.includes("if (!settings.accessToken) {\n      this._listenForAuthEvents()\n    }"),
      true,
      `[${label}] SupabaseClient constructor no longer registers _listenForAuthEvents() synchronously in the expected shape. Re-verify shared/browser-session/index.ts synchronous _emitInitialSession neutralization before moving this pin.`,
    );
    assert.equal(
      supaSrc.includes("this._handleTokenChanged(event, 'CLIENT', session?.access_token)"),
      true,
      `[${label}] SupabaseClient._listenForAuthEvents handler changed. Re-verify shared/browser-session/index.ts event-path preservation before moving this pin.`,
    );

    const supaConstantsSrc = await readFile(path.join(supabaseJsDir, "src/lib/constants.ts"), "utf8");
    assert.equal(
      supaConstantsSrc.includes("'X-Client-Info': `supabase-js/${version};"),
      true,
      `[${label}] SupabaseClient X-Client-Info header format changed in src/lib/constants.ts. Re-verify shared/browser-session/index.ts runtime version check before moving this pin.`,
    );

    // 5) Pin BroadcastChannel peer-event forwarding outside the refresh lock (Condition 1).
    const broadcastSnippet = [
      "this.broadcastChannel?.addEventListener('message', async (event) => {",
      "        this._debug('received broadcast notification from other tab or client', event)",
      "",
      "        // Another tab successfully refreshed or signed in — any cached",
      "        // failure in this tab is stale and should not block the next",
      "        // refresh attempt.",
      "        if (event.data.event === 'TOKEN_REFRESHED' || event.data.event === 'SIGNED_IN') {",
      "          this.lastRefreshFailure = null",
      "        }",
      "",
      "        try {",
      "          await this._notifyAllSubscribers(event.data.event, event.data.session, false)",
    ].join("\n");
    assert.equal(
      goTrueSrc.includes(broadcastSnippet),
      true,
      `[${label}] GoTrueClient BroadcastChannel listener shape changed. Re-verify Condition 1 read-only event handling in shared/browser-session/index.ts before moving this pin.`,
    );

    // 6) Pin GoTrueClient signOut/_signOut early return on non-missing sessionError, _removeSession,
    //    and GoTrueAdminApi.signOut logout request shape (Condition 2).
    const signOutEarlyReturnSnippet = [
      "const { data, error: sessionError } = result",
      "      if (sessionError && !isAuthSessionMissingError(sessionError)) {",
      "        return this._returnResult({ error: sessionError })",
      "      }",
    ].join("\n");
    assert.equal(
      goTrueSrc.includes(signOutEarlyReturnSnippet),
      true,
      `[${label}] GoTrueClient._signOut sessionError early-return shape changed. Re-verify Condition 2 signOut wrapper in shared/browser-session/index.ts before moving this pin.`,
    );
    const removeSessionSnippet = [
      "private async _removeSession() {",
      "    // Bump synchronously, BEFORE any `await`, so that `_callRefreshToken`'s",
      "    // post-save check sees the increment whenever this method has started —",
      "    // even if it hasn't finished. Pairs with the epoch check in",
      "    // `_callRefreshToken`. See `_sessionRemovalEpoch` field doc.",
      "    this._sessionRemovalEpoch += 1",
    ].join("\n");
    assert.equal(
      goTrueSrc.includes(removeSessionSnippet) &&
      goTrueSrc.includes("await removeItemAsync(this.storage, this.storageKey)") &&
      goTrueSrc.includes("await this._notifyAllSubscribers('SIGNED_OUT', null)"),
      true,
      `[${label}] GoTrueClient._removeSession shape changed. Re-verify Condition 2 guarded local sign-out in shared/browser-session/index.ts before moving this pin.`,
    );
    const adminApiSrc = await readFile(path.join(authJsDir, "src/GoTrueAdminApi.ts"), "utf8");
    assert.equal(
      adminApiSrc.includes("await _request(this.fetch, 'POST', `${this.url}/logout?scope=${scope}`, {"),
      true,
      `[${label}] GoTrueAdminApi.signOut request shape changed. Re-verify Condition 2 server revocation in shared/browser-session/index.ts before moving this pin.`,
    );
  }
});

// ============================================================================
// PINNED-SDK LIBRARY BEHAVIOUR TABLE TESTS (no wrapper; raw createClient only)
// ============================================================================

test("SDK table: Candidate (a) fails in pinned auth-js 2.111.0 (silent removeItem still emits SIGNED_OUT + 60s cache; throwing removeItem rejects getSession and misses proactive window)", async (t) => {
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
              // Silent no-op guard: storage is preserved, BUT _removeSession still runs line 5247.
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

test("SDK table: unpatched pinned auth-js 2.111.0 late onAuthStateChange with expired session fires wire refresh while Web Lock is NOT held", async () => {
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

      storage.entries.set(TEST_STORAGE_KEY, expiredStored);
      const { data } = client.auth.onAuthStateChange(() => {});
      await refreshStarted;
      await new Promise((r) => setImmediate(r));

      assert.equal(
        locks.isHeld(TEST_LOCK_NAME),
        false,
        "DEFECT CONFIRMED: Web Lock was released while late onAuthStateChange's wire refresh is still in flight (GoTrueClient.ts:4325 missing await)",
      );

      let peerAcquiredConcurrently = false;
      await locks.request(TEST_LOCK_NAME, { ifAvailable: true }, async (lock) => {
        peerAcquiredConcurrently = lock !== null;
      });
      assert.equal(peerAcquiredConcurrently, true, "peer acquired exclusive lock concurrently with in-flight refresh");

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

// ============================================================================
// CONDITIONS 2, 3, AND 4 PINNED-CLIENT WITNESSES
// ============================================================================

function makeSignedJwt({ sub = "user-1", sessionId = "sid-1", sig = "sig-1" } = {}) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub, session_id: sessionId })}.${sig}`;
}

test("Condition 2 (pinned client): deliberate sign-out is truthful during non-terminal backoff, revokes healthy unchanged login, and leaves replacement login untouched", async (t) => {
  await t.test("(a) sign-out during non-terminal 429 backoff clears stored credential and backoff, announces SIGNED_OUT once, skips expired-token logout, and cannot recover later", async () => {
    const expiredJwt = makeSignedJwt({ sub: "user-1", sessionId: "sid-backoff-1", sig: "sig-bo-1" });
    const expiredStored = makeStoredSession({ accessToken: expiredJwt, refreshToken: "rt-bo-1", expired: true });
    const storage = memoryStorage({ [TEST_STORAGE_KEY]: expiredStored });
    const locks = createFifoLocks();
    const events = [];
    let refreshCalls = 0;
    let logoutCalls = 0;
    let serverHealthy = false;

    const fetchImpl = async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/auth/v1/token")) {
        refreshCalls += 1;
        if (!serverHealthy) {
          return new Response(JSON.stringify({ code: "over_request_rate_limit" }), {
            status: 429,
            headers: { "content-type": "application/json", "x-supabase-api-version": "2024-01-01", "retry-after": "30" },
          });
        }
        return new Response(
          JSON.stringify({
            access_token: makeSignedJwt({ sub: "user-1", sessionId: "sid-backoff-1", sig: "sig-bo-recovered" }),
            refresh_token: "rt-bo-recovered",
            expires_in: 3600,
            token_type: "bearer",
            user: { id: "user-1", aud: "authenticated" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/auth/v1/logout")) {
        logoutCalls += 1;
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    await withBrowserEnv({ storage, locks, fetchImpl }, async () => {
      const session = makeRealSession();
      session.client.auth.onAuthStateChange((event, sess) => events.push({ event, sess }));
      try {
        await assert.rejects(() => session.verifiedSession(), AuthRecoveryRequired);
        assert.equal(refreshCalls, 1);
        assert.ok(storage.entries.has(TEST_BACKOFF_KEY), "429 backoff recorded");
        assert.equal(storage.entries.get(TEST_STORAGE_KEY), expiredStored, "expired session still stored before sign-out");
        assert.deepEqual(events, []);

        // Deliberate sign-out during active 429 backoff: must clear local credential and announce SIGNED_OUT once.
        const outcome = await session.signOut({ expected: { userId: "user-1", sessionId: "sid-backoff-1" } });
        assert.deepEqual(outcome, { signedOutLocally: true, serverRevoked: false, replaced: false, retry: false });
        assert.equal(storage.entries.get(TEST_STORAGE_KEY) ?? null, null, "stored credential for that login is gone");
        assert.equal(storage.entries.has(TEST_BACKOFF_KEY), false, "backoff record cleared under lock");
        assert.deepEqual(events, [{ event: "SIGNED_OUT", sess: null }], "SIGNED_OUT announced exactly once");
        assert.equal(refreshCalls, 1, "sign-out triggered zero extra refresh calls");
        assert.equal(logoutCalls, 0, "skipped server logout because expired access token is not usable");

        // Even after server becomes healthy, nothing can recover the signed-out session.
        serverHealthy = true;
        const afterReload = makeRealSession();
        try {
          assert.equal(await afterReload.verifiedSession(), null, "reload stays signed out");
          assert.equal(refreshCalls, 1, "reload sent zero refresh calls");
        } finally {
          await afterReload.quiesce();
        }
      } finally {
        await session.quiesce();
      }
    });
  });

  await t.test("(b) unchanged login control with healthy session sends server logout and clears local state; server 500 still clears local state and reports serverRevoked: false", async () => {
    for (const logoutStatus of [204, 500]) {
      const validJwt = makeSignedJwt({ sub: "user-1", sessionId: "sid-healthy-1", sig: "sig-h-1" });
      const validStored = makeStoredSession({ accessToken: validJwt, refreshToken: "rt-h-1", expired: false });
      const storage = memoryStorage({ [TEST_STORAGE_KEY]: validStored });
      const locks = createFifoLocks();
      const events = [];
      const logoutHeaders = [];

      const fetchImpl = async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("/auth/v1/logout")) {
          logoutHeaders.push({ url, auth: new Headers(init?.headers).get("authorization") });
          return logoutStatus === 204
            ? new Response(null, { status: 204 })
            : new Response(JSON.stringify({ msg: "server error" }), { status: 500, headers: { "content-type": "application/json" } });
        }
        throw new Error(`Unexpected URL: ${url}`);
      };

      await withBrowserEnv({ storage, locks, fetchImpl }, async () => {
        const session = makeRealSession();
        session.client.auth.onAuthStateChange((event, sess) => events.push({ event, sess }));
        try {
          await session.client.auth.initialize();
          await settleLockIdle(locks);
          events.length = 0;

          const outcome = await session.signOut({ expected: { userId: "user-1", sessionId: "sid-healthy-1" } });
          assert.deepEqual(outcome, {
            signedOutLocally: true,
            serverRevoked: logoutStatus === 204,
            replaced: false,
            retry: false,
          });
          assert.equal(logoutHeaders.length, 1, "server logout attempted once");
          assert.equal(new URL(logoutHeaders[0].url).searchParams.get("scope"), "local", "ordinary sign-out uses local scope on the wire");
          assert.equal(logoutHeaders[0].auth, `Bearer ${validJwt}`);
          assert.equal(storage.entries.get(TEST_STORAGE_KEY) ?? null, null, "local credential cleared");
          assert.deepEqual(events, [{ event: "SIGNED_OUT", sess: null }], "SIGNED_OUT announced once");
        } finally {
          await session.quiesce();
        }
      });
    }
  });

  await t.test("(c) replacement login during the wait (different user OR same user with new session_id) is untouched and no SIGNED_OUT is announced", async () => {
    for (const replacementCase of [
      { name: "different user", userId: "user-2", sessionId: "sid-other-2", refreshToken: "rt-other-2" },
      { name: "same user new session_id", userId: "user-1", sessionId: "sid-same-user-2", refreshToken: "rt-same-2" },
    ]) {
      const login1Jwt = makeSignedJwt({ sub: "user-1", sessionId: "sid-orig-1", sig: "sig-orig-1" });
      const login1Stored = makeStoredSession({ accessToken: login1Jwt, refreshToken: "rt-orig-1", expired: true, userId: "user-1" });
      const login2Jwt = makeSignedJwt({ sub: replacementCase.userId, sessionId: replacementCase.sessionId, sig: "sig-rep-2" });
      const login2Stored = makeStoredSession({
        accessToken: login2Jwt,
        refreshToken: replacementCase.refreshToken,
        expired: false,
        userId: replacementCase.userId,
      });

      const storage = memoryStorage({ [TEST_STORAGE_KEY]: login1Stored });
      const locks = createFifoLocks();
      const events = [];
      let logoutCalls = 0;

      const fetchImpl = async (input) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("/auth/v1/logout")) {
          logoutCalls += 1;
          return new Response(null, { status: 204 });
        }
        if (url.includes("/auth/v1/token")) {
          return new Response(JSON.stringify({ code: "over_request_rate_limit" }), {
            status: 429,
            headers: { "content-type": "application/json", "x-supabase-api-version": "2024-01-01", "retry-after": "30" },
          });
        }
        throw new Error(`Unexpected URL: ${url}`);
      };

      await withBrowserEnv({ storage, locks, fetchImpl }, async () => {
        const session = makeRealSession();
        session.client.auth.onAuthStateChange((event, sess) => events.push({ event, sess }));
        try {
          await session.client.auth.initialize();
          await settleLockIdle(locks);
          events.length = 0;

          // Hold the shared lock while signOut() starts, then replace storage with the replacement login.
          let releaseLock;
          const lockHeld = new Promise((r) => { releaseLock = r; });
          let lockAcquiredResolve;
          const lockAcquired = new Promise((r) => { lockAcquiredResolve = r; });

          const peerLock = locks.request(TEST_LOCK_NAME, async () => {
            lockAcquiredResolve();
            await lockHeld;
          });
          await lockAcquired;

          const pendingSignOut = session.signOut({ expected: { userId: "user-1", sessionId: "sid-orig-1" } });
          storage.entries.set(TEST_STORAGE_KEY, login2Stored);
          releaseLock();
          await peerLock;

          const outcome = await pendingSignOut;
          assert.deepEqual(
            outcome,
            { signedOutLocally: false, serverRevoked: false, replaced: true, retry: false },
            `${replacementCase.name}: reported replacement without signing out locally`,
          );
          assert.equal(
            storage.entries.get(TEST_STORAGE_KEY),
            login2Stored,
            `${replacementCase.name}: replacement login untouched in storage`,
          );
          assert.equal(logoutCalls, 0, `${replacementCase.name}: did not revoke replacement on server`);
          assert.deepEqual(events, [], `${replacementCase.name}: announced zero SIGNED_OUT events`);
        } finally {
          await session.quiesce();
        }
      });
    }
  });

  await t.test("(d) refused persistent removal (throwing OR silent no-op) with readable storage and expired access token reports retryable local failure, announces no SIGNED_OUT, preserves backoff for fresh instance, and succeeds on retry", async () => {
    for (const refusalKind of ["throws", "silent-noop"]) {
      const expiredJwt = makeSignedJwt({ sub: "user-1", sessionId: `sid-refused-${refusalKind}`, sig: "sig-ref-1" });
      const expiredStored = makeStoredSession({ accessToken: expiredJwt, refreshToken: "rt-ref-1", expired: true });
      const base = memoryStorage({ [TEST_STORAGE_KEY]: expiredStored });
      let refuseRemove = true;
      const flakyRemoveStorage = {
        ...base,
        get length() { return base.length; },
        key(i) { return base.key(i); },
        getItem(k) { return base.getItem(k); },
        setItem(k, v) { base.setItem(k, v); },
        removeItem(k) {
          if (refuseRemove && k === TEST_STORAGE_KEY) {
            if (refusalKind === "throws") {
              throw new DOMException("SecurityError", "SecurityError");
            }
            return;
          }
          base.removeItem(k);
        },
      };
      const locks = createFifoLocks();
      const events = [];
      let refreshCalls = 0;
      let serverHealthy = false;

      const fetchImpl = async (input) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("/auth/v1/token")) {
          refreshCalls += 1;
          if (!serverHealthy) {
            return new Response(JSON.stringify({ code: "over_request_rate_limit" }), {
              status: 429,
              headers: { "content-type": "application/json", "x-supabase-api-version": "2024-01-01", "retry-after": "60" },
            });
          }
          return new Response(
            JSON.stringify({
              access_token: makeSignedJwt({ sub: "user-1", sessionId: `sid-refused-${refusalKind}`, sig: "sig-ref-recovered" }),
              refresh_token: "rt-ref-recovered",
              expires_in: 3600,
              token_type: "bearer",
              user: { id: "user-1", aud: "authenticated" },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        throw new Error(`Unexpected URL: ${url}`);
      };

      await withBrowserEnv({ storage: flakyRemoveStorage, locks, fetchImpl }, async () => {
        const session = makeRealSession();
        session.client.auth.onAuthStateChange((event, sess) => events.push({ event, sess }));
        try {
          await assert.rejects(() => session.verifiedSession(), AuthRecoveryRequired);
          assert.equal(refreshCalls, 1);
          assert.ok(base.entries.has(TEST_BACKOFF_KEY), `${refusalKind}: backoff recorded`);

          // Attempt sign-out while persistent removal is refused.
          const failedOutcome = await session.signOut({
            expected: { userId: "user-1", sessionId: `sid-refused-${refusalKind}` },
          });
          assert.deepEqual(
            failedOutcome,
            { signedOutLocally: false, serverRevoked: false, replaced: false, retry: true },
            `${refusalKind}: reports retryable local failure`,
          );
          assert.deepEqual(events, [], `${refusalKind}: announces zero SIGNED_OUT events on failed removal`);
          assert.equal(base.entries.get(TEST_STORAGE_KEY), expiredStored, `${refusalKind}: slot still present in readable storage`);
          assert.ok(base.entries.has(TEST_BACKOFF_KEY), `${refusalKind}: backoff preserved when removal failed`);

          // Even if the server recovers during the active backoff window, a FRESH instance sees
          // AuthRecoveryRequired with zero wire calls (never silently handed a signed-in session).
          serverHealthy = true;
          const freshWhileRefused = makeRealSession();
          try {
            await assert.rejects(() => freshWhileRefused.verifiedSession(), AuthRecoveryRequired);
            assert.equal(refreshCalls, 1, `${refusalKind}: fresh instance respected preserved backoff with zero wire calls`);
          } finally {
            await freshWhileRefused.quiesce();
          }

          // Once persistent removal is allowed again, retrying signOut() confirms removal on read-back,
          // announces SIGNED_OUT once, and a fresh instance stays signed out.
          refuseRemove = false;
          const retryOutcome = await session.signOut({
            expected: { userId: "user-1", sessionId: `sid-refused-${refusalKind}` },
          });
          assert.deepEqual(
            retryOutcome,
            { signedOutLocally: true, serverRevoked: false, replaced: false, retry: false },
            `${refusalKind}: retry confirms durable local sign-out`,
          );
          assert.equal(base.entries.get(TEST_STORAGE_KEY) ?? null, null, `${refusalKind}: slot confirmed removed`);
          assert.equal(base.entries.has(TEST_BACKOFF_KEY), false, `${refusalKind}: backoff cleared once removal confirmed`);
          assert.deepEqual(events, [{ event: "SIGNED_OUT", sess: null }], `${refusalKind}: SIGNED_OUT announced once on confirmed retry`);

          const freshAfterRetry = makeRealSession();
          try {
            assert.equal(await freshAfterRetry.verifiedSession(), null, `${refusalKind}: fresh instance is signed out after confirmed retry`);
            assert.equal(refreshCalls, 1, `${refusalKind}: zero extra wire calls after confirmed sign-out`);
          } finally {
            await freshAfterRetry.quiesce();
          }
        } finally {
          await session.quiesce();
        }
      });
    }
  });

  await t.test("(e) same-person replacement during a HELD server logout call preserves replacement locally, sends initiating bearer with local scope, and reports the real server result", async () => {
    for (const logoutStatus of [204, 500]) {
      const login1Jwt = makeSignedJwt({ sub: "user-1", sessionId: "sid-held-1", sig: "sig-held-1" });
      const login1Stored = makeStoredSession({ accessToken: login1Jwt, refreshToken: "rt-held-1", expired: false, userId: "user-1" });
      const login2Jwt = makeSignedJwt({ sub: "user-1", sessionId: "sid-held-2", sig: "sig-held-2" });
      const login2Stored = makeStoredSession({ accessToken: login2Jwt, refreshToken: "rt-held-2", expired: false, userId: "user-1" });

      const storage = memoryStorage({ [TEST_STORAGE_KEY]: login1Stored });
      const locks = createFifoLocks();
      const events = [];
      const logoutRequests = [];
      let logoutStartedResolve;
      const logoutStarted = new Promise((r) => { logoutStartedResolve = r; });
      let releaseLogout;
      const logoutHold = new Promise((r) => { releaseLogout = r; });

      const fetchImpl = async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("/auth/v1/logout")) {
          logoutRequests.push({
            url,
            scope: new URL(url).searchParams.get("scope"),
            auth: new Headers(init?.headers).get("authorization"),
          });
          logoutStartedResolve();
          await logoutHold;
          return logoutStatus === 204
            ? new Response(null, { status: 204 })
            : new Response(JSON.stringify({ msg: "server error" }), { status: 500, headers: { "content-type": "application/json" } });
        }
        if (url.includes("/auth/v1/user")) {
          return new Response(JSON.stringify({ id: "user-1", aud: "authenticated" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error(`Unexpected URL: ${url}`);
      };

      await withBrowserEnv({ storage, locks, fetchImpl }, async () => {
        const session = makeRealSession();
        session.client.auth.onAuthStateChange((event, sess) => events.push({ event, sess }));
        try {
          await session.client.auth.initialize();
          await settleLockIdle(locks);
          events.length = 0;

          const pendingSignOut = session.signOut({ expected: { userId: "user-1", sessionId: "sid-held-1" } });
          await logoutStarted;

          // Same-person replacement arrives in storage while the initiating login's logout call is in flight.
          storage.entries.set(TEST_STORAGE_KEY, login2Stored);
          releaseLogout();

          const outcome = await pendingSignOut;
          assert.deepEqual(
            outcome,
            {
              signedOutLocally: false,
              serverRevoked: logoutStatus === 204,
              replaced: true,
              retry: false,
            },
            `status ${logoutStatus}: reports replacement while preserving real serverRevoked`,
          );
          assert.equal(logoutRequests.length, 1, "exactly one server logout request sent");
          assert.equal(logoutRequests[0].scope, "local", "ordinary sign-out sent local scope (never revokes same-person replacement)");
          assert.equal(logoutRequests[0].auth, `Bearer ${login1Jwt}`, "server logout used the initiating login's bearer token");
          assert.equal(storage.entries.get(TEST_STORAGE_KEY), login2Stored, "same-person replacement login survived locally");
          assert.deepEqual(events, [], "zero SIGNED_OUT events announced over replacement login");

          const verified = await session.verifiedSession();
          assert.equal(verified?.access_token, login2Jwt, "replacement login remains verifiable");
        } finally {
          releaseLogout?.();
          await session.quiesce();
        }
      });
    }
  });

  await t.test("(f) C2a durable slot ownership under lock: stale local view (removedStorageKeys or pending write) and unavailable local view protect durable successor with zero removeItem and zero SIGNED_OUT; unreadable slot retries; empty slot reports local success with zero removeItem and zero duplicate SIGNED_OUT", async (st) => {
    await st.test("stale local view via removedStorageKeys hides durable successor: successor survives, zero removeItem, zero SIGNED_OUT", async () => {
      for (const successorCase of [
        { name: "different user", userId: "user-2", sessionId: "sid-c2a-succ-u2", refreshToken: "rt-c2a-succ-u2" },
        { name: "same user new session_id", userId: "user-1", sessionId: "sid-c2a-succ-u1", refreshToken: "rt-c2a-succ-u1" },
      ]) {
        const login1Jwt = makeSignedJwt({ sub: "user-1", sessionId: "sid-c2a-orig-1", sig: "sig-c2a-orig-1" });
        const login1Stored = makeStoredSession({ accessToken: login1Jwt, refreshToken: "rt-c2a-orig-1", expired: false, userId: "user-1" });
        const login2Jwt = makeSignedJwt({ sub: successorCase.userId, sessionId: successorCase.sessionId, sig: "sig-c2a-succ" });
        const login2Stored = makeStoredSession({
          accessToken: login2Jwt,
          refreshToken: successorCase.refreshToken,
          expired: false,
          userId: successorCase.userId,
        });
        for (const callMode of [
          { label: "expected", opts: { expected: { userId: "user-1", sessionId: "sid-c2a-orig-1" } } },
          { label: "default", opts: undefined },
        ]) {
          const storage = memoryStorage({ [TEST_STORAGE_KEY]: login1Stored });
          const locks = createFifoLocks();
          const events = [];
          let logoutCalls = 0;

          const fetchImpl = async (input) => {
            const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
            if (url.includes("/auth/v1/logout")) {
              logoutCalls += 1;
              return new Response(null, { status: 204 });
            }
            if (url.includes("/auth/v1/user")) {
              return new Response(JSON.stringify({ id: successorCase.userId, aud: "authenticated" }), {
                status: 200,
                headers: { "content-type": "application/json" },
              });
            }
            throw new Error(`Unexpected URL: ${url}`);
          };

          await withBrowserEnv({ storage, locks, fetchImpl }, async () => {
            const session = makeRealSession();
            session.client.auth.onAuthStateChange((event, sess) => events.push({ event, sess }));
            try {
              await session.client.auth.initialize();
              await settleLockIdle(locks);
              // Perform an earlier removal so `removedStorageKeys` holds TEST_STORAGE_KEY
              // and `readAuthItem(TEST_STORAGE_KEY)` returns null while ignoring disk.
              const firstSignOut = await session.signOut({ expected: { userId: "user-1", sessionId: "sid-c2a-orig-1" } });
              assert.equal(firstSignOut.signedOutLocally, true);
              assert.equal(storage.entries.get(TEST_STORAGE_KEY) ?? null, null);

              // Peer writes durable successor directly to persistent storage without a storage event.
              storage.entries.set(TEST_STORAGE_KEY, login2Stored);
              storage.ops.length = 0;
              events.length = 0;
              logoutCalls = 0;

              const outcome = await session.signOut(callMode.opts);
              assert.deepEqual(
                outcome,
                { signedOutLocally: false, serverRevoked: false, replaced: true, retry: false },
                `${successorCase.name} (${callMode.label}): reported replaced`,
              );
              assert.equal(storage.entries.get(TEST_STORAGE_KEY), login2Stored, `${successorCase.name}: durable successor survived`);
              assert.equal(
                storage.ops.filter((op) => op === `remove:${TEST_STORAGE_KEY}`).length,
                0,
                `${successorCase.name}: zero removeItem calls reached persistent storage`,
              );
              assert.deepEqual(events, [], `${successorCase.name}: zero SIGNED_OUT announced`);
              assert.equal(logoutCalls, 0, `${successorCase.name}: zero server logout calls`);

              // Healed local view now verifies the durable successor cleanly.
              const verified = await session.verifiedSession();
              assert.equal(verified?.access_token, login2Jwt, `${successorCase.name}: durable successor remains verifiable`);
            } finally {
              await session.quiesce();
            }
          });
        }
      }
    });

    await st.test("stale local view via pendingStorageWrites (unknown pre-write snapshot) hides durable successor: successor survives, zero removeItem, zero SIGNED_OUT", async () => {
      const b64 = (obj) => Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
      const futureExp = Math.floor(Date.now() / 1000) + 3600;
      const login1Jwt = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: "user-1", session_id: "sid-c2a-pend-1", exp: futureExp })}.sig-c2a-pend-1`;
      const login2Jwt = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: "user-1", session_id: "sid-c2a-pend-2", exp: futureExp })}.sig-c2a-pend-2`;
      const login2Stored = makeStoredSession({ accessToken: login2Jwt, refreshToken: "rt-c2a-pend-2", expired: false, userId: "user-1" });

      const base = memoryStorage({ [TEST_STORAGE_KEY]: login2Stored });
      let denyReads = true;
      let denyWrites = true;
      const flakyStorage = {
        ...base,
        get length() { return base.length; },
        key(i) { return base.key(i); },
        getItem(k) {
          if (denyReads && k === TEST_STORAGE_KEY) throw new DOMException("SecurityError", "SecurityError");
          return base.getItem(k);
        },
        setItem(k, v) {
          if (denyWrites) throw new DOMException("QuotaExceededError", "QuotaExceededError");
          base.setItem(k, v);
        },
        removeItem(k) { base.removeItem(k); },
      };
      const locks = createFifoLocks();
      const events = [];
      let logoutCalls = 0;

      const fetchImpl = async (input) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("/auth/v1/user")) {
          return new Response(JSON.stringify({ id: "user-1", aud: "authenticated" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.includes("/auth/v1/logout")) {
          logoutCalls += 1;
          return new Response(null, { status: 204 });
        }
        throw new Error(`Unexpected URL: ${url}`);
      };

      await withBrowserEnv({ storage: flakyStorage, locks, fetchImpl }, async () => {
        const session = makeRealSession();
        session.client.auth.onAuthStateChange((event, sess) => events.push({ event, sess }));
        try {
          await session.client.auth.initialize();
          await settleLockIdle(locks);
          // Populate authMemory + pendingStorageWrites with expected===undefined for login1 while disk holds login2.
          const setRes = await session.client.auth.setSession({
            access_token: login1Jwt,
            refresh_token: "rt-c2a-pend-1",
          });
          assert.equal(setRes.error, null);

          // Disk is now readable and holds login2, yet the module's reconciled local view still returns login1!
          denyReads = false;
          const staleLocalView = await session.client.auth.getSession();
          assert.equal(staleLocalView.data.session?.refresh_token, "rt-c2a-pend-1", "fixture precondition: local view is stale login1");

          base.ops.length = 0;
          events.length = 0;
          logoutCalls = 0;

          const outcome = await session.signOut({ expected: { userId: "user-1", sessionId: "sid-c2a-pend-1" } });
          assert.deepEqual(outcome, { signedOutLocally: false, serverRevoked: false, replaced: true, retry: false });
          assert.equal(base.entries.get(TEST_STORAGE_KEY), login2Stored, "durable successor survived stale local view");
          assert.equal(
            base.ops.filter((op) => op === `remove:${TEST_STORAGE_KEY}`).length,
            0,
            "zero removeItem calls reached persistent storage",
          );
          assert.deepEqual(events, [], "zero SIGNED_OUT announced");
          assert.equal(logoutCalls, 0, "zero server logout calls");
        } finally {
          await session.quiesce();
        }
      });
    });

    await st.test("unavailable local view (disk read fails when module view is consulted, then readable with durable successor): successor survives, zero removeItem, zero SIGNED_OUT", async () => {
      for (const successorCase of [
        { name: "same user new session_id", userId: "user-1", sessionId: "sid-c2a-unavail-2", refreshToken: "rt-c2a-unavail-2" },
        { name: "different user", userId: "user-2", sessionId: "sid-c2a-unavail-u2", refreshToken: "rt-c2a-unavail-u2" },
      ]) {
        const login1Jwt = makeSignedJwt({ sub: "user-1", sessionId: "sid-c2a-unavail-1", sig: "sig-c2a-unavail-1" });
        const login1Stored = makeStoredSession({ accessToken: login1Jwt, refreshToken: "rt-c2a-unavail-1", expired: false, userId: "user-1" });
        const login2Jwt = makeSignedJwt({ sub: successorCase.userId, sessionId: successorCase.sessionId, sig: "sig-c2a-unavail-2" });
        const login2Stored = makeStoredSession({
          accessToken: login2Jwt,
          refreshToken: successorCase.refreshToken,
          expired: false,
          userId: successorCase.userId,
        });

        const base = memoryStorage({ [TEST_STORAGE_KEY]: login1Stored });
        let failNextSessionReads = 0;
        const transientUnreadableStorage = {
          ...base,
          get length() { return base.length; },
          key(i) { return base.key(i); },
          getItem(k) {
            if (k === TEST_STORAGE_KEY && failNextSessionReads > 0) {
              failNextSessionReads -= 1;
              throw new DOMException("SecurityError", "SecurityError");
            }
            return base.getItem(k);
          },
          setItem(k, v) { base.setItem(k, v); },
          removeItem(k) { base.removeItem(k); },
        };
        const locks = createFifoLocks();
        const events = [];
        let logoutCalls = 0;

        const fetchImpl = async (input) => {
          const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          if (url.includes("/auth/v1/logout")) {
            logoutCalls += 1;
            return new Response(null, { status: 204 });
          }
          throw new Error(`Unexpected URL: ${url}`);
        };

        await withBrowserEnv({ storage: transientUnreadableStorage, locks, fetchImpl }, async () => {
          const session = makeRealSession();
          session.client.auth.onAuthStateChange((event, sess) => events.push({ event, sess }));
          try {
            await session.client.auth.initialize();
            await settleLockIdle(locks);
            // Confirm authMemory holds login1.
            assert.equal((await session.client.auth.getSession()).data.session?.refresh_token, "rt-c2a-unavail-1");

            // Peer writes durable successor to persistent storage without firing a storage event.
            base.entries.set(TEST_STORAGE_KEY, login2Stored);
            base.ops.length = 0;
            events.length = 0;
            logoutCalls = 0;

            // Fail a getItem read when the module's own view is consulted via getSession(),
            // confirming the module falls back to stale authMemory (login1) while disk holds login2,
            // then disk is readable (login2) for the locked durable ownership check inside signOut().
            failNextSessionReads = 1;
            assert.equal(
              (await session.client.auth.getSession()).data.session?.refresh_token,
              "rt-c2a-unavail-1",
              `${successorCase.name}: unavailable disk read left module local view on stale login1`,
            );
            base.ops.length = 0;
            events.length = 0;
            logoutCalls = 0;
            const outcome = await session.signOut({ expected: { userId: "user-1", sessionId: "sid-c2a-unavail-1" } });
            assert.deepEqual(
              outcome,
              { signedOutLocally: false, serverRevoked: false, replaced: true, retry: false },
              `${successorCase.name}: detected durable successor after transient local read failure`,
            );
            assert.equal(base.entries.get(TEST_STORAGE_KEY), login2Stored, `${successorCase.name}: durable successor survived`);
            assert.equal(
              base.ops.filter((op) => op === `remove:${TEST_STORAGE_KEY}`).length,
              0,
              `${successorCase.name}: zero removeItem calls reached persistent storage`,
            );
            assert.deepEqual(events, [], `${successorCase.name}: zero SIGNED_OUT announced`);
            assert.equal(logoutCalls, 0, `${successorCase.name}: zero server logout calls`);
          } finally {
            await session.quiesce();
          }
        });
      }
    });

    await st.test("durable slot unreadable under lock (throws OR storage unavailable) returns retryable failure with zero removeItem and zero SIGNED_OUT; readable empty slot returns local success with zero removeItem and zero duplicate SIGNED_OUT", async () => {
      const login1Jwt = makeSignedJwt({ sub: "user-1", sessionId: "sid-c2a-unr-1", sig: "sig-c2a-unr-1" });
      const login1Stored = makeStoredSession({ accessToken: login1Jwt, refreshToken: "rt-c2a-unr-1", expired: false, userId: "user-1" });
      const base = memoryStorage({ [TEST_STORAGE_KEY]: login1Stored });
      let denyReads = false;
      const flakyStorage = {
        ...base,
        get length() { return base.length; },
        key(i) { return base.key(i); },
        getItem(k) {
          if (denyReads && k === TEST_STORAGE_KEY) throw new DOMException("SecurityError", "SecurityError");
          return base.getItem(k);
        },
        setItem(k, v) { base.setItem(k, v); },
        removeItem(k) { base.removeItem(k); },
      };
      const locks = createFifoLocks();
      const events = [];
      let logoutCalls = 0;

      const fetchImpl = async (input) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("/auth/v1/logout")) {
          logoutCalls += 1;
          return new Response(null, { status: 204 });
        }
        throw new Error(`Unexpected URL: ${url}`);
      };

      await withBrowserEnv({ storage: flakyStorage, locks, fetchImpl }, async () => {
        const session = makeRealSession();
        session.client.auth.onAuthStateChange((event, sess) => events.push({ event, sess }));
        try {
          await session.client.auth.initialize();
          await settleLockIdle(locks);
          assert.equal((await session.client.auth.getSession()).data.session?.refresh_token, "rt-c2a-unr-1");

          // 1) Unreadable durable slot under lock -> retryable failure, zero removeItem, zero SIGNED_OUT.
          denyReads = true;
          base.ops.length = 0;
          events.length = 0;
          logoutCalls = 0;
          const unreadableRes = await session.signOut({ expected: { userId: "user-1", sessionId: "sid-c2a-unr-1" } });
          assert.deepEqual(unreadableRes, { signedOutLocally: false, serverRevoked: false, replaced: false, retry: true });
          assert.equal(base.entries.get(TEST_STORAGE_KEY), login1Stored, "slot untouched when unreadable");
          assert.equal(base.ops.filter((op) => op === `remove:${TEST_STORAGE_KEY}`).length, 0, "zero removeItem calls");
          assert.deepEqual(events, [], "zero SIGNED_OUT announced");
          assert.equal(logoutCalls, 0, "zero server logout calls while durable slot unreadable");

          // 2) Storage unavailable (localStorage set to null) -> retryable failure, zero removeItem, zero SIGNED_OUT.
          denyReads = false;
          Object.defineProperty(globalThis, "localStorage", { configurable: true, value: null });
          const unavailableRes = await session.signOut({ expected: { userId: "user-1", sessionId: "sid-c2a-unr-1" } });
          Object.defineProperty(globalThis, "localStorage", { configurable: true, value: flakyStorage });
          assert.deepEqual(unavailableRes, { signedOutLocally: false, serverRevoked: false, replaced: false, retry: true });
          assert.equal(base.entries.get(TEST_STORAGE_KEY), login1Stored, "slot untouched when storage unavailable");
          assert.equal(base.ops.filter((op) => op === `remove:${TEST_STORAGE_KEY}`).length, 0, "zero removeItem calls");
          assert.deepEqual(events, [], "zero SIGNED_OUT announced");

          // 3) Durable slot readable and EMPTY -> truthful local success with zero removeItem and zero duplicate SIGNED_OUT.
          base.entries.delete(TEST_STORAGE_KEY);
          base.ops.length = 0;
          events.length = 0;
          logoutCalls = 0;
          const emptyRes = await session.signOut({ expected: { userId: "user-1", sessionId: "sid-c2a-unr-1" } });
          assert.deepEqual(emptyRes, { signedOutLocally: true, serverRevoked: false, replaced: false, retry: false });
          assert.equal(base.ops.filter((op) => op === `remove:${TEST_STORAGE_KEY}`).length, 0, "zero removeItem calls on already-empty slot");
          assert.deepEqual(events, [], "zero duplicate SIGNED_OUT on already-empty slot");
          assert.equal(logoutCalls, 0, "zero server logout calls on already-empty slot");
          assert.equal(await session.verifiedSession(), null, "verifiedSession sees empty slot");
        } finally {
          await session.quiesce();
        }
      });
    });

    await st.test("sign-out removal guard inside authStorage.removeItem re-checks durable storage directly against this sign-out's locked read before calling removeItem", async () => {
      const login1Jwt = makeSignedJwt({ sub: "user-1", sessionId: "sid-c2a-guard-1", sig: "sig-c2a-guard-1" });
      const login1Stored = makeStoredSession({ accessToken: login1Jwt, refreshToken: "rt-c2a-guard-1", expired: true, userId: "user-1" });
      const login2Jwt = makeSignedJwt({ sub: "user-1", sessionId: "sid-c2a-guard-2", sig: "sig-c2a-guard-2" });
      const login2Stored = makeStoredSession({ accessToken: login2Jwt, refreshToken: "rt-c2a-guard-2", expired: false, userId: "user-1" });

      const base = memoryStorage({ [TEST_STORAGE_KEY]: login1Stored });
      let swapOnReadNumber = 0;
      let sessionReads = 0;
      const raceStorage = {
        ...base,
        get length() { return base.length; },
        key(i) { return base.key(i); },
        getItem(k) {
          if (k === TEST_STORAGE_KEY && swapOnReadNumber > 0) {
            sessionReads += 1;
            // Read 1: durableBeforeLogout; Read 2: durableBeforeRemove;
            // Read 3: signOutRemovalGuard inside authStorage.removeItem!
            // (An explicit pin never reads initialLocalCred from the current slot.)
            if (sessionReads === swapOnReadNumber) {
              base.entries.set(TEST_STORAGE_KEY, login2Stored);
            }
          }
          return base.getItem(k);
        },
        setItem(k, v) { base.setItem(k, v); },
        removeItem(k) { base.removeItem(k); },
      };
      const locks = createFifoLocks();
      const events = [];

      const fetchImpl = async () => new Response(JSON.stringify({ code: "over_request_rate_limit" }), {
        status: 429,
        headers: { "content-type": "application/json", "x-supabase-api-version": "2024-01-01" },
      });

      await withBrowserEnv({ storage: raceStorage, locks, fetchImpl }, async () => {
        const session = makeRealSession();
        session.client.auth.onAuthStateChange((event, sess) => events.push({ event, sess }));
        try {
          await session.client.auth.initialize();
          await settleLockIdle(locks);
          base.ops.length = 0;
          events.length = 0;

          // Inject a durable successor right at the removal guard read inside authStorage.removeItem.
          sessionReads = 0;
          swapOnReadNumber = 3;
          const outcome = await session.signOut({ expected: { userId: "user-1", sessionId: "sid-c2a-guard-1" } });
          assert.deepEqual(outcome, { signedOutLocally: false, serverRevoked: false, replaced: true, retry: false });
          assert.equal(base.entries.get(TEST_STORAGE_KEY), login2Stored, "removal guard preserved durable successor");
          assert.equal(
            base.ops.filter((op) => op === `remove:${TEST_STORAGE_KEY}`).length,
            0,
            "removal guard aborted before any removeItem reached persistent storage",
          );
          assert.deepEqual(events, [], "removal guard aborted before SIGNED_OUT could be announced");
        } finally {
          await session.quiesce();
        }
      });
    });
  });

  await t.test("(g) LiveDashboard single-account sign-out paths both pass local scope, carry initiating login identity including fallback refreshToken, guard late settlement, render retryable error on local failure, and keep pendingSignOut until verified loading", async () => {
    const dashboardPath = fileURLToPath(new URL("../components/app/LiveDashboard.astro", import.meta.url));
    const dashboardSrc = await readFile(dashboardPath, "utf8");
    assert.match(
      dashboardSrc,
      /const attemptReauthSignOut = async[\s\S]*?pendingSignOut = pendingState;[\s\S]*?refreshToken:\s*ownerExpectedRefreshToken \|\| null,[\s\S]*?scope:\s*"local"[\s\S]*?if \(pendingSignOut !== pendingState\) \{\s*return;\s*\}[\s\S]*?if \(signOutRes && !signOutRes\.signedOutLocally\) \{\s*renderSignOutError\(pendingState\);[\s\S]*?pendingSignOutNotice =[\s\S]*?!signOutRes\.serverRevoked/,
      "re-authentication sign-out path passes local scope + fallback refreshToken, guards late settlement, surfaces retryable error on local failure, and preserves unconfirmed server revocation notice",
    );
    assert.match(
      dashboardSrc,
      /const attemptSingleSignOut = async[\s\S]*?pendingSignOut = pendingState;[\s\S]*?refreshToken:\s*signingOutRefreshToken \|\| null,[\s\S]*?scope:\s*"local"[\s\S]*?if \(pendingSignOut !== pendingState\) \{\s*return;\s*\}[\s\S]*?if \(signOutRes && !signOutRes\.signedOutLocally\) \{\s*renderSignOutError\(pendingState\);[\s\S]*?pendingSignOutNotice =[\s\S]*?!signOutRes\.serverRevoked/,
      "ordinary Sign out click passes local scope + fallback refreshToken, guards late settlement, surfaces retryable error on local failure, and preserves unconfirmed server revocation notice",
    );
  });

  await t.test("(h) C2a fallback pin (pinned client): explicit pin without session_id uses fixed initiating refreshToken, incomplete explicit pin is refused without touching storage, and Retry after refused removal leaves same-person successor untouched", async (st) => {
    const makeNoSidJwt = ({ sub, sig }) => {
      const b64 = (obj) => Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
      const futureExp = Math.floor(Date.now() / 1000) + 3600;
      return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub, aud: "authenticated", exp: futureExp })}.${sig}`;
    };

    await st.test("explicit pin with missing sessionId + fallback refreshToken against same-person replacement in storage returns replaced with zero logout, zero deletion, zero SIGNED_OUT", async () => {
      for (const successorCase of [
        {
          label: "same user successor WITH session_id",
          accessToken: makeSignedJwt({ sub: "user-1", sessionId: "sid-c2a-fb-succ-1", sig: "sig-fb-succ-1" }),
          refreshToken: "rt-c2a-fb-succ-1",
        },
        {
          label: "same user successor WITHOUT session_id",
          accessToken: makeNoSidJwt({ sub: "user-1", sig: "sig-fb-succ-2" }),
          refreshToken: "rt-c2a-fb-succ-2",
        },
      ]) {
        const successorStored = makeStoredSession({
          accessToken: successorCase.accessToken,
          refreshToken: successorCase.refreshToken,
          expired: false,
          userId: "user-1",
        });
        const storage = memoryStorage({ [TEST_STORAGE_KEY]: successorStored });
        const locks = createFifoLocks();
        const events = [];
        let logoutCalls = 0;

        const fetchImpl = async (input) => {
          const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          if (url.includes("/auth/v1/logout")) {
            logoutCalls += 1;
            return new Response(null, { status: 204 });
          }
          if (url.includes("/auth/v1/user")) {
            return new Response(JSON.stringify({ id: "user-1", aud: "authenticated" }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          throw new Error(`Unexpected URL: ${url}`);
        };

        await withBrowserEnv({ storage, locks, fetchImpl }, async () => {
          const session = makeRealSession();
          session.client.auth.onAuthStateChange((event, sess) => events.push({ event, sess }));
          try {
            await session.client.auth.initialize();
            await settleLockIdle(locks);
            storage.ops.length = 0;
            events.length = 0;
            logoutCalls = 0;

            const outcome = await session.signOut({
              expected: { userId: "user-1", sessionId: null, refreshToken: "rt-c2a-fb-orig-1" },
            });
            assert.deepEqual(
              outcome,
              { signedOutLocally: false, serverRevoked: false, replaced: true, retry: false },
              `${successorCase.label}: fallback refreshToken mismatch reports replaced`,
            );
            assert.equal(logoutCalls, 0, `${successorCase.label}: zero server logout calls`);
            assert.equal(
              storage.ops.filter((op) => op === `remove:${TEST_STORAGE_KEY}`).length,
              0,
              `${successorCase.label}: zero removeItem calls`,
            );
            assert.equal(storage.entries.get(TEST_STORAGE_KEY), successorStored, `${successorCase.label}: successor intact in storage`);
            assert.deepEqual(events, [], `${successorCase.label}: zero SIGNED_OUT announced`);

            const verified = await session.verifiedSession();
            assert.equal(verified?.refresh_token, successorCase.refreshToken, `${successorCase.label}: successor remains verifiable`);
          } finally {
            await session.quiesce();
          }
        });
      }
    });

    await st.test("explicit pin with missing sessionId and NO fallback refreshToken (or missing userId, or explicit null) is refused as incomplete without completing from current slot", async () => {
      const successorJwt = makeSignedJwt({ sub: "user-1", sessionId: "sid-c2a-inc-succ", sig: "sig-inc-succ" });
      const successorStored = makeStoredSession({
        accessToken: successorJwt,
        refreshToken: "rt-c2a-inc-succ",
        expired: false,
        userId: "user-1",
      });

      const incompletePins = [
        { label: "userId only, sessionId null, no refreshToken", expected: { userId: "user-1", sessionId: null } },
        { label: "userId only, empty sessionId and blank refreshToken", expected: { userId: "user-1", sessionId: "", refreshToken: "   " } },
        { label: "missing userId despite sessionId", expected: { userId: "", sessionId: "sid-c2a-inc-succ", refreshToken: "rt-c2a-inc-succ" } },
        { label: "explicit expected: null", expected: null },
      ];

      for (const pinCase of incompletePins) {
        const storage = memoryStorage({ [TEST_STORAGE_KEY]: successorStored });
        const locks = createFifoLocks();
        const events = [];
        let logoutCalls = 0;

        const fetchImpl = async (input) => {
          const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          if (url.includes("/auth/v1/logout")) {
            logoutCalls += 1;
            return new Response(null, { status: 204 });
          }
          throw new Error(`Unexpected URL: ${url}`);
        };

        await withBrowserEnv({ storage, locks, fetchImpl }, async () => {
          const session = makeRealSession();
          session.client.auth.onAuthStateChange((event, sess) => events.push({ event, sess }));
          try {
            await session.client.auth.initialize();
            await settleLockIdle(locks);
            storage.ops.length = 0;
            events.length = 0;
            logoutCalls = 0;

            const outcome = await session.signOut({ expected: pinCase.expected });
            assert.deepEqual(
              outcome,
              { signedOutLocally: false, serverRevoked: false, replaced: false, retry: true },
              `${pinCase.label}: refused with retryable local failure`,
            );
            assert.equal(logoutCalls, 0, `${pinCase.label}: zero server logout calls`);
            assert.equal(
              storage.ops.filter((op) => op === `remove:${TEST_STORAGE_KEY}`).length,
              0,
              `${pinCase.label}: zero removeItem calls`,
            );
            assert.equal(storage.entries.get(TEST_STORAGE_KEY), successorStored, `${pinCase.label}: slot untouched`);
            assert.deepEqual(events, [], `${pinCase.label}: zero SIGNED_OUT announced`);
          } finally {
            await session.quiesce();
          }
        });
      }
    });

    await st.test("Retry after refused removal when initiating login has NO session_id and a same-person successor arrives meanwhile leaves successor untouched; unchanged login control signs out cleanly", async () => {
      const origJwt = makeNoSidJwt({ sub: "user-1", sig: "sig-retry-orig" });
      const origStored = makeStoredSession({
        accessToken: origJwt,
        refreshToken: "rt-c2a-retry-orig",
        expired: false,
        userId: "user-1",
      });
      const succJwt = makeSignedJwt({ sub: "user-1", sessionId: "sid-c2a-retry-succ", sig: "sig-retry-succ" });
      const succStored = makeStoredSession({
        accessToken: succJwt,
        refreshToken: "rt-c2a-retry-succ",
        expired: false,
        userId: "user-1",
      });

      const base = memoryStorage({ [TEST_STORAGE_KEY]: origStored });
      let refuseRemove = true;
      const flakyStorage = {
        ...base,
        get length() { return base.length; },
        key(i) { return base.key(i); },
        getItem(k) { return base.getItem(k); },
        setItem(k, v) { base.setItem(k, v); },
        removeItem(k) {
          if (refuseRemove && k === TEST_STORAGE_KEY) {
            throw new DOMException("SecurityError", "SecurityError");
          }
          base.removeItem(k);
        },
      };
      const locks = createFifoLocks();
      const events = [];
      const logoutAuthHeaders = [];

      const fetchImpl = async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("/auth/v1/logout")) {
          logoutAuthHeaders.push(new Headers(init?.headers).get("authorization"));
          return new Response(JSON.stringify({ msg: "server unavailable" }), {
            status: 500,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.includes("/auth/v1/user")) {
          return new Response(JSON.stringify({ id: "user-1", aud: "authenticated" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error(`Unexpected URL: ${url}`);
      };

      await withBrowserEnv({ storage: flakyStorage, locks, fetchImpl }, async () => {
        const session = makeRealSession();
        session.client.auth.onAuthStateChange((event, sess) => events.push({ event, sess }));
        try {
          await session.client.auth.initialize();
          await settleLockIdle(locks);
          events.length = 0;

          // Captured once at click time (no session_id in initiating JWT, fallback refreshToken captured).
          const fixedPin = { userId: "user-1", sessionId: null, refreshToken: "rt-c2a-retry-orig" };

          // 1) First attempt while removal is refused -> retryable failure, zero SIGNED_OUT.
          const firstOutcome = await session.signOut({ expected: fixedPin, scope: "local" });
          assert.deepEqual(firstOutcome, { signedOutLocally: false, serverRevoked: false, replaced: false, retry: true });
          assert.deepEqual(logoutAuthHeaders, [`Bearer ${origJwt}`]);
          assert.deepEqual(events, []);
          assert.equal(base.entries.get(TEST_STORAGE_KEY), origStored);

          // 2) Same-person successor arrives in storage before Retry, and removal becomes allowed.
          base.entries.set(TEST_STORAGE_KEY, succStored);
          refuseRemove = false;
          base.ops.length = 0;
          logoutAuthHeaders.length = 0;
          events.length = 0;

          // 3) Retry with the SAME fixed pin must NOT complete from the current slot and must NOT touch the successor.
          const retryOutcome = await session.signOut({ expected: fixedPin, scope: "local" });
          assert.deepEqual(retryOutcome, { signedOutLocally: false, serverRevoked: false, replaced: true, retry: false });
          assert.deepEqual(logoutAuthHeaders, [], "Retry sent zero logout calls for successor");
          assert.equal(
            base.ops.filter((op) => op === `remove:${TEST_STORAGE_KEY}`).length,
            0,
            "Retry sent zero removeItem calls for successor",
          );
          assert.equal(base.entries.get(TEST_STORAGE_KEY), succStored, "successor remains intact in storage");
          assert.deepEqual(events, [], "zero SIGNED_OUT announced over successor");

          const verified = await session.verifiedSession();
          assert.equal(verified?.access_token, succJwt, "successor remains verifiable after Retry");
        } finally {
          await session.quiesce();
        }
      });

      // Control: when the slot still holds the initiating no-sid login, the fallback refreshToken signs it out cleanly.
      const controlStorage = memoryStorage({ [TEST_STORAGE_KEY]: origStored });
      const controlLocks = createFifoLocks();
      const controlEvents = [];
      let controlLogouts = 0;
      const controlFetch = async (input) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("/auth/v1/logout")) {
          controlLogouts += 1;
          return new Response(null, { status: 204 });
        }
        throw new Error(`Unexpected URL: ${url}`);
      };
      await withBrowserEnv({ storage: controlStorage, locks: controlLocks, fetchImpl: controlFetch }, async () => {
        const session = makeRealSession();
        session.client.auth.onAuthStateChange((event, sess) => controlEvents.push({ event, sess }));
        try {
          await session.client.auth.initialize();
          await settleLockIdle(controlLocks);
          controlEvents.length = 0;

          const outcome = await session.signOut({
            expected: { userId: "user-1", sessionId: null, refreshToken: "rt-c2a-retry-orig" },
            scope: "local",
          });
          assert.deepEqual(outcome, { signedOutLocally: true, serverRevoked: true, replaced: false, retry: false });
          assert.equal(controlLogouts, 1);
          assert.equal(controlStorage.entries.get(TEST_STORAGE_KEY) ?? null, null);
          assert.deepEqual(controlEvents, [{ event: "SIGNED_OUT", sess: null }]);
        } finally {
          await session.quiesce();
        }
      });
    });
  });
});

test("Condition 3 (pinned client): untracked refresh sends zero wire requests/writes/events; missing or mismatched storageKey fails closed; processLock fallback refreshes normally", async (t) => {
  await t.test("untracked _callRefreshToken, direct _refreshAccessToken, and unlocked _recoverAndRefresh send zero wire calls, zero writes, zero events", async () => {
    const expiredStored = makeStoredSession({ accessToken: "at-c3-1", refreshToken: "rt-c3-1", expired: true });
    const storage = memoryStorage({ [TEST_STORAGE_KEY]: expiredStored });
    const locks = createFifoLocks();
    const events = [];
    let wireCalls = 0;

    const fetchImpl = async () => {
      wireCalls += 1;
      return new Response(
        JSON.stringify({
          access_token: "at-c3-2",
          refresh_token: "rt-c3-2",
          expires_in: 3600,
          token_type: "bearer",
          user: { id: "user-1", aud: "authenticated" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    await withBrowserEnv({ storage, locks, fetchImpl }, async () => {
      const session = makeRealSession();
      session.client.auth.onAuthStateChange((e, sess) => events.push({ e, sess }));
      try {
        // Stop auto-init refresh from running concurrently; reset storage to expiredStored.
        await session.client.auth.initialize();
        await settleLockIdle(locks);
        await session.client.auth.stopAutoRefresh();
        await settleLockIdle(locks);

        storage.entries.set(TEST_STORAGE_KEY, expiredStored);
        storage.ops.length = 0;
        events.length = 0;
        wireCalls = 0;

        // 1) Call wrapped _callRefreshToken outside any lock.
        const untrackedCallRes = await session.client.auth._callRefreshToken("rt-c3-1");
        assert.equal(untrackedCallRes.data, null);
        assert.equal(isAuthRefreshDiscardedError(untrackedCallRes.error), true, "exited via AuthRefreshDiscardedError");

        // 2) Call _refreshAccessToken directly outside any lock (hits authFetch wire boundary).
        const directRefreshRes = await session.client.auth._refreshAccessToken("rt-c3-1");
        assert.equal(wireCalls, 0, "authFetch wire boundary sent zero wire requests");
        assert.equal(directRefreshRes.data?.session?.access_token?.startsWith("__cs_discard_v1_"), true, "authFetch returned discard sentinel");

        // 3) Trigger library path _recoverAndRefresh directly outside any lock.
        await session.client.auth._recoverAndRefresh();

        assert.equal(wireCalls, 0, "zero wire refresh requests across all untracked paths");
        assert.equal(storage.entries.get(TEST_STORAGE_KEY), expiredStored, "stored session untouched");
        assert.equal(
          storage.ops.some((op) => op === `set:${TEST_STORAGE_KEY}` || op === `remove:${TEST_STORAGE_KEY}`),
          false,
          "zero storage mutations",
        );
        assert.deepEqual(events, [], "zero auth events emitted");
      } finally {
        await session.quiesce();
      }
    });
  });

  await t.test("missing or unexpected client storageKey fails closed as unsupported_sdk with zero wire calls", async () => {
    for (const badKey of [undefined, "", "sb-other-auth-token"]) {
      const expiredStored = makeStoredSession({ accessToken: "at-key-1", refreshToken: "rt-key-1", expired: true });
      const storage = memoryStorage({ [TEST_STORAGE_KEY]: expiredStored });
      const locks = createFifoLocks();
      let wireCalls = 0;

      const fetchImpl = async () => {
        wireCalls += 1;
        return new Response(JSON.stringify({}), { status: 429 });
      };

      await withBrowserEnv({ storage, locks, fetchImpl }, async () => {
        const result = createBrowserSession({
          url: TEST_API_URL,
          anonKey: "anon-key",
          detectSessionInUrl: false,
          allowProcessLockFallback: false,
          sdk: {
            createClient(url, key, opts) {
              const client = createClient(url, key, opts);
              Object.defineProperty(client.auth, "storageKey", { value: badKey, configurable: true });
              return client;
            },
            navigatorLock,
            processLock,
            isAuthSessionMissingError,
            AuthRetryableFetchError,
          },
        });
        assert.deepEqual(result, { ok: false, reason: "unsupported_sdk" }, `bad storageKey=${String(badKey)} must fail closed`);
        await new Promise((r) => setTimeout(r, 30));
        assert.equal(wireCalls, 0, "zero wire requests");
        assert.equal(storage.entries.get(TEST_STORAGE_KEY), expiredStored, "storage untouched");
      });
    }
  });

  await t.test("allowProcessLockFallback: true with navigator.locks absent still refreshes normally through trackedLock -> processLock", async () => {
    const expiredStored = makeStoredSession({
      accessToken: makeSignedJwt({ sub: "user-1", sessionId: "sid-proc-1", sig: "sig-proc-old" }),
      refreshToken: "rt-proc-1",
      expired: true,
    });
    const freshJwt = makeSignedJwt({ sub: "user-1", sessionId: "sid-proc-1", sig: "sig-proc-new" });
    const storage = memoryStorage({ [TEST_STORAGE_KEY]: expiredStored });
    let processLockCalls = 0;
    let refreshCalls = 0;
    let userCalls = 0;

    const fetchImpl = async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/auth/v1/token")) {
        refreshCalls += 1;
        return new Response(
          JSON.stringify({
            access_token: freshJwt,
            refresh_token: "rt-proc-2",
            expires_in: 3600,
            token_type: "bearer",
            user: { id: "user-1", aud: "authenticated" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/auth/v1/user")) {
        userCalls += 1;
        return new Response(JSON.stringify({ id: "user-1", aud: "authenticated" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    await withBrowserEnv({ storage, locks: undefined, fetchImpl }, async () => {
      const created = createBrowserSession({
        url: TEST_API_URL,
        anonKey: "anon-key",
        detectSessionInUrl: false,
        allowProcessLockFallback: true,
        sdk: {
          createClient,
          navigatorLock,
          processLock: (...args) => {
            processLockCalls += 1;
            return processLock(...args);
          },
          isAuthSessionMissingError,
          AuthRetryableFetchError,
        },
      });
      assert.equal(created.ok, true);
      if (!created.ok) return;
      try {
        const verified = await created.verifiedSession();
        assert.equal(verified?.access_token, freshJwt, "processLock fallback refreshed and verified normally");
        assert.equal(verified?.refresh_token, "rt-proc-2");
        assert.ok(processLockCalls > 0, "processLock was invoked under trackedLock");
        assert.equal(refreshCalls, 1, "exactly 1 wire refresh succeeded");
        assert.equal(userCalls, 1, "verified with getUser");
      } finally {
        await created.quiesce();
      }
    });
  });
});

test("Condition 4 (pinned client): verifiedSession binds success to the exact verified access credential and re-verifies a same-user successor", async (t) => {
  await t.test("held settlement: swapping storage to a different session_id for the same user during getUser requires the successor's own getUser before returning", async () => {
    const jwt1 = makeSignedJwt({ sub: "user-1", sessionId: "sid-v4-1", sig: "sig-v4-1" });
    const jwt2 = makeSignedJwt({ sub: "user-1", sessionId: "sid-v4-2", sig: "sig-v4-2" });
    const stored1 = makeStoredSession({ accessToken: jwt1, refreshToken: "rt-v4-1", expired: false, userId: "user-1" });
    const stored2 = makeStoredSession({ accessToken: jwt2, refreshToken: "rt-v4-2", expired: false, userId: "user-1" });
    const storage = memoryStorage({ [TEST_STORAGE_KEY]: stored1 });
    const locks = createFifoLocks();

    const userChecks = [];
    let hit1Resolve;
    const hit1 = new Promise((r) => { hit1Resolve = r; });
    let release1;
    const hold1 = new Promise((r) => { release1 = r; });
    let hit2Resolve;
    const hit2 = new Promise((r) => { hit2Resolve = r; });
    let release2;
    const hold2 = new Promise((r) => { release2 = r; });

    const fetchImpl = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/auth/v1/user")) {
        const auth = new Headers(init?.headers).get("authorization");
        userChecks.push(auth);
        if (auth === `Bearer ${jwt1}`) {
          hit1Resolve();
          await hold1;
        } else if (auth === `Bearer ${jwt2}`) {
          hit2Resolve();
          await hold2;
        }
        return new Response(JSON.stringify({ id: "user-1", aud: "authenticated" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    await withBrowserEnv({ storage, locks, fetchImpl }, async () => {
      const session = makeRealSession();
      try {
        await session.client.auth.initialize();
        await settleLockIdle(locks);

        let settled = false;
        const pendingVerified = session.verifiedSession().then((res) => {
          settled = true;
          return res;
        });

        // 1) Hold GET /auth/v1/user for sid-v4-1, swap storage to same user with sid-v4-2, release sid-v4-1.
        await hit1;
        storage.entries.set(TEST_STORAGE_KEY, stored2);
        release1();

        // 2) Must NOT settle on sid-v4-1's verification; must start sid-v4-2's own GET /auth/v1/user.
        await hit2;
        await new Promise((r) => setImmediate(r));
        assert.equal(settled, false, "successor sid-v4-2 was NOT released before its own getUser settled");
        assert.deepEqual(userChecks, [`Bearer ${jwt1}`, `Bearer ${jwt2}`], "successor triggered its own getUser");

        // 3) Release sid-v4-2's own user check -> now returns sid-v4-2.
        release2();
        const result = await pendingVerified;
        assert.equal(result?.access_token, jwt2, "returned successor only after its own verification");
        assert.equal(result?.refresh_token, "rt-v4-2");
      } finally {
        release1?.();
        release2?.();
        await session.quiesce();
      }
    });
  });

  await t.test("bounded re-verification: repeated credential swaps stop after 3 user checks and reject with AuthRecoveryRequired", async () => {
    const jwt = (n) => makeSignedJwt({ sub: "user-1", sessionId: `sid-flap-${n}`, sig: `sig-flap-${n}` });
    const stored = (n) => makeStoredSession({ accessToken: jwt(n), refreshToken: `rt-flap-${n}`, expired: false, userId: "user-1" });
    const storage = memoryStorage({ [TEST_STORAGE_KEY]: stored(1) });
    const locks = createFifoLocks();
    let userCheckCount = 0;

    const fetchImpl = async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/auth/v1/user")) {
        userCheckCount += 1;
        // Swap to a fresh same-user session_id during every user check so latest always differs.
        storage.entries.set(TEST_STORAGE_KEY, stored(userCheckCount + 1));
        return new Response(JSON.stringify({ id: "user-1", aud: "authenticated" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    await withBrowserEnv({ storage, locks, fetchImpl }, async () => {
      const session = makeRealSession();
      try {
        await session.client.auth.initialize();
        await settleLockIdle(locks);
        await assert.rejects(() => session.verifiedSession(), AuthRecoveryRequired);
        assert.equal(userCheckCount, 3, "bounded at 3 user verification attempts before returning AuthRecoveryRequired");
      } finally {
        await session.quiesce();
      }
    });
  });
});
