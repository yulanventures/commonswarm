import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  AuthRetryableFetchError,
  createClient,
  isAuthSessionMissingError,
  navigatorLock,
  processLock,
} from "@supabase/supabase-js";
import {
  AuthRecoveryRequired,
  MULTI_ACCOUNT_STORAGE_KEY_PREFIXES,
  createBrowserSession,
  deploymentOriginHash,
  isRestSessionEnded,
  multiAccountInUse,
  multiAccountStorageKeyPrefixesForDeployment,
  resolveDeployment,
  sessionStorageKeyForDeployment,
} from "../../../shared/browser-session/index.js";
import {
  accountsStorageKey,
  activeAccountStorageKey,
  attemptStorageKey,
  deploymentOriginHash as siteDeploymentOriginHash,
  slotStorageKey,
  tabAccountStorageKey,
} from "./multi-account.ts";

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

async function withNavigatorLocks(value, fn) {
  const hadNavigator = Object.prototype.hasOwnProperty.call(globalThis, "navigator");
  const prevNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: value === undefined ? {} : { locks: value },
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

test("sessionStorageKeyForDeployment matches Supabase JS v2.111.0 default key", () => {
  assert.equal(sessionStorageKeyForDeployment("https://api.commonswarm.com"), "sb-api-auth-token");
  assert.equal(sessionStorageKeyForDeployment("https://example.supabase.co"), "sb-example-auth-token");
  assert.equal(sessionStorageKeyForDeployment("http://127.0.0.1:54321"), "sb-127-auth-token");
});

test("resolveDeployment prefers build env over meta tags and returns null when incomplete", () => {
  const doc = {
    querySelector(selector) {
      if (selector === 'meta[name="commonswarm:url"]') return { content: " https://meta.example.com " };
      if (selector === 'meta[name="commonswarm:anon-key"]') return { content: " meta-anon " };
      return null;
    },
  };
  assert.deepEqual(resolveDeployment(undefined, doc), {
    url: "https://meta.example.com",
    anonKey: "meta-anon",
  });
  assert.deepEqual(
    resolveDeployment({ PUBLIC_SUPABASE_URL: "https://env.example.com", PUBLIC_SUPABASE_ANON_KEY: "env-anon" }, doc),
    { url: "https://env.example.com", anonKey: "env-anon" },
  );
  assert.equal(resolveDeployment(undefined, null), null);
  assert.equal(resolveDeployment({ PUBLIC_SUPABASE_URL: "https://env.example.com" }, null), null);
});

test("allowProcessLockFallback: false refuses when navigator.locks is absent without creating a client or touching storage", async () => {
  const storedSession = JSON.stringify({ access_token: "at-1", refresh_token: "rt-1" });
  const storage = memoryStorage({ "sb-api-auth-token": storedSession });
  const prevStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  let createCalls = 0;

  try {
    await withNavigatorLocks(undefined, () => {
      const result = createBrowserSession({
        url: "https://api.commonswarm.com",
        anonKey: "anon-key",
        detectSessionInUrl: false,
        allowProcessLockFallback: false,
        sdk: {
          createClient: (...args) => {
            createCalls += 1;
            return createClient(...args);
          },
          navigatorLock,
          processLock,
          isAuthSessionMissingError,
          AuthRetryableFetchError,
        },
      });
      assert.deepEqual(result, { ok: false, reason: "locks_unavailable" });
    });
    assert.equal(createCalls, 0, "must not create a Supabase client when Web Locks are unavailable");
    assert.deepEqual(storage.ops, [], "must not read, write, or remove localStorage");
    assert.equal(storage.entries.get("sb-api-auth-token"), storedSession, "stored session remains untouched");
  } finally {
    if (prevStorage) Object.defineProperty(globalThis, "localStorage", prevStorage);
    else delete globalThis.localStorage;
  }
});

test("allowProcessLockFallback: false creates client with navigatorLock and detectSessionInUrl: false when navigator.locks exists", async () => {
  let capturedOptions;
  const fakeLocks = { request: async (name, _opts, cb) => cb({ name }) };

  await withNavigatorLocks(fakeLocks, async () => {
    const result = createBrowserSession({
      url: "https://api.commonswarm.com",
      anonKey: "anon-key",
      detectSessionInUrl: false,
      allowProcessLockFallback: false,
      sdk: {
        createClient: (url, key, opts) => {
          capturedOptions = opts;
          return createClient(url, key, opts);
        },
        navigatorLock,
        processLock,
        isAuthSessionMissingError,
        AuthRetryableFetchError,
      },
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.storageKey, "sb-api-auth-token");
    assert.equal(capturedOptions?.auth?.persistSession, true);
    assert.equal(capturedOptions?.auth?.autoRefreshToken, true);
    assert.equal(capturedOptions?.auth?.detectSessionInUrl, false);
    assert.equal(capturedOptions?.auth?.lockAcquireTimeout, -1);
    assert.equal(capturedOptions?.auth?.lock, navigatorLock);
    assert.equal(result.client.rest?.retry, false);
    assert.equal("dispose" in result, false, "dispose is deferred until a product caller exists");
    await result.client.auth.getSession();
    await result.client.auth.dispose();
  });
});

test("allowProcessLockFallback: true falls back to processLock when navigator.locks is absent", async () => {
  let capturedOptions;
  await withNavigatorLocks(undefined, async () => {
    const result = createBrowserSession({
      url: "https://api.commonswarm.com",
      anonKey: "anon-key",
      detectSessionInUrl: true,
      allowProcessLockFallback: true,
      sdk: {
        createClient: (url, key, opts) => {
          capturedOptions = opts;
          return createClient(url, key, opts);
        },
        navigatorLock,
        processLock,
        isAuthSessionMissingError,
        AuthRetryableFetchError,
      },
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(capturedOptions?.auth?.detectSessionInUrl, true);
    assert.equal(capturedOptions?.auth?.lock, processLock);
    assert.equal("dispose" in result, false);
    await result.client.auth.getSession();
    await result.client.auth.dispose();
  });
});

test("multiAccountInUse distinguishes in_use, absent, and unknown across real key producers and failing storage", () => {
  const url = "https://api.commonswarm.com";
  const otherUrl = "https://staging.commonswarm.com";
  const hash = deploymentOriginHash(url);
  const otherHash = deploymentOriginHash(otherUrl);

  assert.equal(siteDeploymentOriginHash, deploymentOriginHash, "site re-exports the shared origin hash");
  assert.deepEqual(MULTI_ACCOUNT_STORAGE_KEY_PREFIXES, [
    "commonswarm:auth:v1:",
    "commonswarm:accounts:v1:",
    "commonswarm:active-account:v1:",
    "commonswarm:tab-account:v1:",
  ]);
  assert.deepEqual(multiAccountStorageKeyPrefixesForDeployment(url), [
    `commonswarm:auth:v1:${hash}:login:`,
    `commonswarm:auth:v1:${hash}:attempt:`,
    `commonswarm:accounts:v1:${hash}`,
    `commonswarm:active-account:v1:${hash}`,
    `commonswarm:tab-account:v1:${hash}`,
  ]);

  assert.equal(multiAccountInUse(null), "unknown");
  assert.equal(multiAccountInUse(undefined), "unknown");
  assert.equal(multiAccountInUse(null, url), "unknown");
  assert.equal(multiAccountInUse(undefined, url), "unknown");
  assert.equal(multiAccountInUse(memoryStorage({})), "absent");
  assert.equal(multiAccountInUse(memoryStorage({ "sb-api-auth-token": "{}", theme: "dark" })), "absent");
  assert.equal(multiAccountInUse(memoryStorage({ "sb-api-auth-token": "{}" }), url), "absent");

  const throwingLength = {
    get length() {
      throw new Error("SecurityError: storage denied");
    },
    key() {
      return null;
    },
  };
  assert.equal(multiAccountInUse(throwingLength), "unknown");
  assert.equal(multiAccountInUse(throwingLength, url), "unknown");

  const throwingFirstKey = {
    length: 1,
    key() {
      throw new Error("SecurityError: key denied");
    },
  };
  assert.equal(multiAccountInUse(throwingFirstKey), "unknown");
  assert.equal(multiAccountInUse(throwingFirstKey, url), "unknown");

  const throwingLaterKey = {
    length: 3,
    key(index) {
      if (index === 0) return "sb-api-auth-token";
      throw new Error("storage broke mid-enumeration");
    },
  };
  assert.equal(multiAccountInUse(throwingLaterKey), "unknown");
  assert.equal(multiAccountInUse(throwingLaterKey, url), "unknown");

  const matchingKeys = [
    accountsStorageKey(hash),
    activeAccountStorageKey(hash),
    tabAccountStorageKey(hash),
    slotStorageKey(hash, "login-1"),
    attemptStorageKey(hash, "attempt-1"),
  ];
  for (const key of matchingKeys) {
    const store = memoryStorage({ "sb-api-auth-token": "{}", [key]: "1" });
    assert.equal(multiAccountInUse(store), "in_use", `unscoped check must match ${key}`);
    assert.equal(multiAccountInUse(store, url), "in_use", `deployment-scoped check must match ${key}`);
    assert.equal(multiAccountInUse(store, otherUrl), "absent", `other deployment must not match ${key}`);
  }

  const otherStore = memoryStorage({ [accountsStorageKey(otherHash)]: "{}" });
  assert.equal(multiAccountInUse(otherStore), "in_use");
  assert.equal(multiAccountInUse(otherStore, url), "absent");
  assert.equal(multiAccountInUse(otherStore, otherUrl), "in_use");
});

test("shared browser-session PostgREST refusal schedules locked verification, never direct sign-out", async () => {
  assert.equal(await isRestSessionEnded(new Response(JSON.stringify({ code: "session_not_found" }), { status: 401 })), true);
  const source = await readFile(new URL("../../../shared/browser-session/index.ts", import.meta.url), "utf8");
  assert.match(source, /if \(url\.pathname\.includes\("\/rest\/v1\/"\) && await isRestSessionEnded\(response\)\) checkSessionAfterRestRefusal\(\);/);
  assert.match(source, /function checkSessionAfterRestRefusal\(verify: \(\) => Promise<unknown> = \(\) => verifiedSession\(\)\)/);
  const body = source.slice(source.indexOf("function checkSessionAfterRestRefusal"), source.indexOf("const authFetch"));
  assert.doesNotMatch(body, /signOut|removeItem|_removeSession/, "removal happens only inside the SDK's verified check");
});

test("quiesce stops background listeners/timers and settles a held refresh under the shared lock without modifying localStorage", async () => {
  const storedSession = JSON.stringify({
    access_token: "at-initial",
    refresh_token: "rt-initial",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) - 60,
    token_type: "bearer",
    user: { id: "user-1" },
  });
  const storage = memoryStorage({ "sb-api-auth-token": storedSession });
  const prevStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const prevFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });

  let lockHeld = false;
  let lockReleaseCount = 0;
  const fakeLocks = {
    async request(name, _opts, cb) {
      while (lockHeld) {
        await new Promise((r) => setTimeout(r, 5));
      }
      lockHeld = true;
      try {
        return await cb({ name });
      } finally {
        lockHeld = false;
        lockReleaseCount += 1;
      }
    },
  };

  let refreshStartedResolve;
  const refreshStarted = new Promise((r) => { refreshStartedResolve = r; });
  let releaseRefreshFetch;
  const refreshFetchHeld = new Promise((r) => { releaseRefreshFetch = r; });
  let abortedOnQuiesce = false;
  let signedOutBroadcast = false;

  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/auth/v1/token")) {
      refreshStartedResolve();
      init?.signal?.addEventListener("abort", () => {
        abortedOnQuiesce = true;
      });
      await refreshFetchHeld;
      return new Response(JSON.stringify({
        access_token: "at-rotated",
        refresh_token: "rt-rotated",
        expires_in: 3600,
        token_type: "bearer",
        user: { id: "user-1" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ id: "user-1" }), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    await withNavigatorLocks(fakeLocks, async () => {
      const result = createBrowserSession({
        url: "https://api.commonswarm.com",
        anonKey: "anon-key",
        detectSessionInUrl: false,
        allowProcessLockFallback: false,
        sdk: {
          createClient,
          navigatorLock,
          processLock,
          isAuthSessionMissingError,
          AuthRetryableFetchError,
        },
      });
      assert.equal(result.ok, true);
      if (!result.ok) return;
      result.client.auth.onAuthStateChange((event) => {
        if (event === "SIGNED_OUT") signedOutBroadcast = true;
      });

      // Trigger getSession() on an expired token so GoTrue enters a refresh under the Web Lock.
      const pendingGetSession = result.client.auth.getSession().catch(() => null);
      await refreshStarted;
      assert.equal(lockHeld, true, "refresh holds the shared Web Lock");

      // Quiesce while the refresh HTTP request is still held.
      const quiesceDone = result.quiesce();
      assert.equal(abortedOnQuiesce, true, "quiesce aborts the in-flight auth fetch signal");

      // Now let the mock fetch resolve with rotated tokens (simulating a transport that ignores abort).
      releaseRefreshFetch();
      await quiesceDone;
      await pendingGetSession;

      assert.equal(lockHeld, false, "shared Web Lock is released after quiesce settles");
      assert.ok(lockReleaseCount >= 1);
      assert.equal(signedOutBroadcast, false, "quiesce never emits SIGNED_OUT");
      assert.equal(
        storage.entries.get("sb-api-auth-token"),
        storedSession,
        "peer's stored login in localStorage is untouched by quiesce",
      );
      assert.equal(
        storage.ops.some((op) => op.startsWith("remove:") || op.startsWith("set:")),
        false,
        "quiesce performs zero localStorage writes or removals",
      );

      // A successor client can cleanly acquire the same lock after quiesce.
      let successorAcquired = false;
      await fakeLocks.request("lock:sb-api-auth-token", {}, async () => {
        successorAcquired = true;
      });
      assert.equal(successorAcquired, true);
    });
  } finally {
    globalThis.fetch = prevFetch;
    if (prevStorage) Object.defineProperty(globalThis, "localStorage", prevStorage);
    else delete globalThis.localStorage;
  }
});

test("quiesce cancels pending and in-flight storage retries without writing to localStorage or rescheduling", async () => {
  const initialStored = JSON.stringify({
    access_token: "at-peer",
    refresh_token: "rt-peer",
    user: { id: "user-1" },
  });
  let blockWrites = true;
  const entries = new Map([["sb-api-auth-token", initialStored]]);
  let setCallsAfterUnblock = 0;
  const flakyStorage = {
    get length() { return entries.size; },
    key(index) { return [...entries.keys()][index] ?? null; },
    getItem(key) { return entries.get(key) ?? null; },
    setItem(key, value) {
      if (blockWrites) throw new Error("QuotaExceededError");
      if (!key.startsWith("commonswarm-storage-")) setCallsAfterUnblock += 1;
      entries.set(key, value);
    },
    removeItem(key) { entries.delete(key); },
    clear() { entries.clear(); },
  };
  const prevStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: flakyStorage });

  let capturedStorage;
  const fakeLocks = { request: async (name, _opts, cb) => cb({ name }) };

  try {
    await withNavigatorLocks(fakeLocks, async () => {
      const result = createBrowserSession({
        url: "https://api.commonswarm.com",
        anonKey: "anon-key",
        detectSessionInUrl: false,
        allowProcessLockFallback: false,
        sdk: {
          createClient: (url, key, opts) => {
            capturedStorage = opts?.auth?.storage;
            return createClient(url, key, opts);
          },
          navigatorLock,
          processLock,
          isAuthSessionMissingError,
          AuthRetryableFetchError,
        },
      });
      assert.equal(result.ok, true);
      if (!result.ok) return;

      // Seed a failed write so scheduleStorageRetry() arms its retry timer.
      capturedStorage.getItem("sb-api-auth-token");
      capturedStorage.setItem("sb-api-auth-token", JSON.stringify({
        access_token: "at-delayed",
        refresh_token: "rt-delayed",
        user: { id: "user-1" },
      }));

      // Quiesce before the retry timer fires, then unblock storage writes.
      await result.quiesce();
      blockWrites = false;

      // Calling setItem/removeItem after quiesce throws AuthRetryableFetchError and does not touch storage.
      assert.throws(() => {
        capturedStorage.setItem("sb-api-auth-token", "{}");
      }, AuthRetryableFetchError);
      assert.throws(() => {
        capturedStorage.removeItem("sb-api-auth-token");
      }, AuthRetryableFetchError);

      assert.equal(setCallsAfterUnblock, 0, "quiesced retry must not write to localStorage");
      assert.equal(entries.get("sb-api-auth-token"), initialStored, "peer session remains intact");
    });
  } finally {
    if (prevStorage) Object.defineProperty(globalThis, "localStorage", prevStorage);
    else delete globalThis.localStorage;
  }
});

const TEST_API_URL = "https://api.commonswarm.com";
const TEST_STORAGE_KEY = "sb-api-auth-token";
const TEST_LOCK_NAME = `lock:${TEST_STORAGE_KEY}`;

function makeStoredSession({
  accessToken,
  refreshToken,
  expired = false,
  userId = "user-1",
}) {
  const nowSec = Math.floor(Date.now() / 1000);
  return JSON.stringify({
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: 3600,
    expires_at: nowSec + (expired ? -60 : 3600),
    token_type: "bearer",
    user: { id: userId, aud: "authenticated", email: "owner@example.test" },
  });
}

function createFifoLocks() {
  const active = new Map();
  const queues = new Map();
  const holds = [];
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
    get releaseCount() {
      return releaseCount;
    },
    isHeld(name = TEST_LOCK_NAME) {
      return active.has(name);
    },
    pendingCount(name = TEST_LOCK_NAME) {
      return queues.get(name)?.length ?? 0;
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

async function withSharedBrowserEnv({ storage, locks, fetchImpl }, fn) {
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

function makeBrowserSession(sdkOverrides = {}) {
  const result = createBrowserSession({
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
  assert.equal(result.ok, true);
  return result;
}

function alreadyUsedResponse() {
  return new Response(
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
  );
}

function raceDeadline(promise, ms, describe) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const label = typeof describe === "function" ? describe() : describe;
        reject(new Error(`${label} (timed out after ${ms} ms)`));
      }, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

test("Order A: rotation in storage before 400 refresh_token_already_used settles both sessions within 500 ms [fails until the refresh-stall fix]", async () => {
  // Uses a bounded real wait of 500 ms after the 400 answer (and quiesce() in finally so the 30s sleep does not hang the runner).
  const initialStored = makeStoredSession({ accessToken: "at-1", refreshToken: "rt-1", expired: true });
  const rotatedStored = makeStoredSession({ accessToken: "at-2", refreshToken: "rt-2", expired: false });
  const storage = memoryStorage({ [TEST_STORAGE_KEY]: initialStored });
  const locks = createFifoLocks();

  let refreshRequests = 0;
  const userCheckTokens = [];
  let refreshStartedResolve;
  const refreshStarted = new Promise((r) => { refreshStartedResolve = r; });
  let releaseRefresh;
  const refreshHeld = new Promise((r) => { releaseRefresh = r; });

  const fetchImpl = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/auth/v1/token")) {
      refreshRequests += 1;
      if (refreshRequests === 1) {
        refreshStartedResolve();
        await refreshHeld;
      }
      return alreadyUsedResponse();
    }
    if (url.includes("/auth/v1/user")) {
      const auth = new Headers(init?.headers).get("authorization");
      userCheckTokens.push(auth);
      return new Response(
        JSON.stringify({ id: "user-1", aud: "authenticated", email: "owner@example.test" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  await withSharedBrowserEnv({ storage, locks, fetchImpl }, async () => {
    const sessionA = makeBrowserSession();
    let sessionB;
    try {
      const pendingA = sessionA.currentSession();
      await refreshStarted;
      assert.equal(locks.isHeld(TEST_LOCK_NAME), true, "A holds the shared lock during refresh");

      sessionB = makeBrowserSession();
      const pendingB = sessionB.currentSession();

      // Peer overwrites storage with the rotated valid session while A's rt-1 refresh is still held.
      storage.entries.set(TEST_STORAGE_KEY, rotatedStored);
      const writesBeforeRefusal = storage.ops.filter((op) => op.startsWith("set:") || op.startsWith("remove:")).length;

      // Now answer A's rt-1 refresh with 400 refresh_token_already_used.
      const answeredAt = Date.now();
      releaseRefresh();

      const [resA, resB] = await raceDeadline(
        Promise.all([pendingA, pendingB]),
        500,
        () => `Order A stalled: lockHeld=${locks.isHeld(TEST_LOCK_NAME)} refreshRequests=${refreshRequests} userChecks=${userCheckTokens.length}`,
      );
      const elapsedMs = Date.now() - answeredAt;

      assert.ok(elapsedMs < 500, `expected resolution within 500 ms, took ${elapsedMs} ms`);
      assert.equal(refreshRequests, 1, "exactly one refresh request was made in total");
      assert.equal(locks.isHeld(TEST_LOCK_NAME), false, "shared Web Lock is released");
      assert.equal(resA?.refresh_token, "rt-2");
      assert.equal(resA?.access_token, "at-2");
      assert.equal(resB?.refresh_token, "rt-2");
      assert.equal(resB?.access_token, "at-2");
      assert.deepEqual(userCheckTokens, ["Bearer at-2", "Bearer at-2"], "a single user check each for A and B");
      assert.equal(storage.entries.get(TEST_STORAGE_KEY), rotatedStored, "storage still holds exactly the peer's session");
      const writesAfterRefusal = storage.ops.filter((op) => op.startsWith("set:") || op.startsWith("remove:")).length;
      assert.equal(writesAfterRefusal, writesBeforeRefusal, "no session wrote over the peer's rotated session");
    } finally {
      await Promise.all([sessionA.quiesce(), sessionB?.quiesce()]);
    }
  });
});

test("Order B: rotation in storage with storage event 200 ms after 400 refresh_token_already_used wakes cooldown and settles both sessions within 500 ms [fails until the refresh-stall fix]", async () => {
  // Uses a bounded real wait: 200 ms after the 400 arrives, storage rotates with a storage event,
  // then asserts full recovery within 500 ms of the rotation.
  const initialStored = makeStoredSession({ accessToken: "at-1", refreshToken: "rt-1", expired: true });
  const rotatedStored = makeStoredSession({ accessToken: "at-2", refreshToken: "rt-2", expired: false });
  const storage = memoryStorage({ [TEST_STORAGE_KEY]: initialStored });
  const locks = createFifoLocks();

  let refreshRequests = 0;
  const userCheckTokens = [];
  let refreshStartedResolve;
  const refreshStarted = new Promise((r) => { refreshStartedResolve = r; });
  let releaseRefresh;
  const refreshHeld = new Promise((r) => { releaseRefresh = r; });

  const fetchImpl = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/auth/v1/token")) {
      refreshRequests += 1;
      if (refreshRequests === 1) {
        refreshStartedResolve();
        await refreshHeld;
      }
      return alreadyUsedResponse();
    }
    if (url.includes("/auth/v1/user")) {
      const auth = new Headers(init?.headers).get("authorization");
      userCheckTokens.push(auth);
      return new Response(
        JSON.stringify({ id: "user-1", aud: "authenticated", email: "owner@example.test" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  await withSharedBrowserEnv({ storage, locks, fetchImpl }, async ({ dispatchStorageEvent }) => {
    const sessionA = makeBrowserSession();
    let sessionB;
    try {
      const pendingA = sessionA.currentSession();
      await refreshStarted;
      assert.equal(locks.isHeld(TEST_LOCK_NAME), true, "A holds the shared lock during refresh");

      sessionB = makeBrowserSession();
      const pendingB = sessionB.currentSession();

      // 400 arrives FIRST while storage still holds rt-1, starting the 30s cooldown.
      releaseRefresh();
      // Let authFetch process the 400 and GoTrue arm its 200 ms retry timer, then wait 200 ms
      // so the rotation lands during the active cooldown.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setTimeout(r, 200));

      assert.equal(locks.isHeld(TEST_LOCK_NAME), true, "A still holds the lock in cooldown before rotation");

      // Peer writes the rotated valid session and both sessions receive the storage event.
      storage.entries.set(TEST_STORAGE_KEY, rotatedStored);
      const writesAtRotation = storage.ops.filter((op) => op.startsWith("set:") || op.startsWith("remove:")).length;
      const rotatedAt = Date.now();
      dispatchStorageEvent({ key: TEST_STORAGE_KEY, oldValue: initialStored, newValue: rotatedStored });

      const [resA, resB] = await raceDeadline(
        Promise.all([pendingA, pendingB]),
        500,
        () => `Order B stalled: lockHeld=${locks.isHeld(TEST_LOCK_NAME)} refreshRequests=${refreshRequests} userChecks=${userCheckTokens.length}`,
      );
      const elapsedMs = Date.now() - rotatedAt;

      assert.ok(elapsedMs < 500, `expected resolution within 500 ms of rotation, took ${elapsedMs} ms`);
      assert.equal(refreshRequests, 1, "exactly one refresh request was made in total");
      assert.equal(locks.isHeld(TEST_LOCK_NAME), false, "shared Web Lock is released");
      assert.equal(resA?.refresh_token, "rt-2");
      assert.equal(resA?.access_token, "at-2");
      assert.equal(resB?.refresh_token, "rt-2");
      assert.equal(resB?.access_token, "at-2");
      assert.deepEqual(userCheckTokens, ["Bearer at-2", "Bearer at-2"], "a single user check each for A and B");
      assert.equal(storage.entries.get(TEST_STORAGE_KEY), rotatedStored, "storage still holds exactly the peer's session");
      const writesAfterRotation = storage.ops.filter((op) => op.startsWith("set:") || op.startsWith("remove:")).length;
      assert.equal(writesAfterRotation, writesAtRotation, "no session wrote over the peer's rotated session");
    } finally {
      await Promise.all([sessionA.quiesce(), sessionB?.quiesce()]);
    }
  });
});

// Characterisation test: records current behaviour for genuine refresh failures (429 and network error)
// with NO rotation in storage. The security reviewer is deciding whether a genuine failure should keep
// holding the cross-tab lock for the 30-second cooldown.
test("genuine refresh failure (429 and network error) without storage rotation holds cross-tab lock for 30s and times out peer with AuthRecoveryRequired (characterisation)", async (t) => {
  async function runGenuineFailureCase(st, mode) {
    st.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const flushAsync = async () => {
      for (let i = 0; i < 60; i += 1) {
        await Promise.resolve();
      }
    };

    const initialStored = makeStoredSession({ accessToken: "at-1", refreshToken: "rt-1", expired: true });
    const storage = memoryStorage({ [TEST_STORAGE_KEY]: initialStored });
    const locks = createFifoLocks();

    let refreshRequests = 0;
    let firstRefreshStartedResolve;
    const firstRefreshStarted = new Promise((r) => { firstRefreshStartedResolve = r; });
    let releaseFirstRefresh;
    const firstRefreshHeld = new Promise((r) => { releaseFirstRefresh = r; });

    const fetchImpl = async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/auth/v1/token")) {
        refreshRequests += 1;
        if (refreshRequests === 1) {
          firstRefreshStartedResolve();
          await firstRefreshHeld;
        }
        if (mode === "429") {
          return new Response(
            JSON.stringify({ code: "over_request_rate_limit", message: "Too Many Requests" }),
            {
              status: 429,
              headers: {
                "content-type": "application/json",
                "x-supabase-api-version": "2024-01-01",
              },
            },
          );
        }
        throw new TypeError("Failed to fetch");
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    };

    try {
      await withSharedBrowserEnv({ storage, locks, fetchImpl }, async () => {
        const sessionA = makeBrowserSession();
        let sessionB;
        try {
          const pendingA = sessionA.currentSession().then(
            (v) => ({ ok: true, value: v, at: Date.now() }),
            (e) => ({ ok: false, error: e, at: Date.now() }),
          );
          await firstRefreshStarted;
          const failureStartedAt = Date.now();

          sessionB = makeBrowserSession();
          const pendingB = sessionB.currentSession().then(
            (v) => ({ ok: true, value: v, at: Date.now() }),
            (e) => ({ ok: false, error: e, at: Date.now() }),
          );
          await flushAsync();

          // Release A's first refresh with 429 or network error; storage never rotates.
          releaseFirstRefresh();
          await flushAsync();

          // At +200 ms GoTrue's attempt 1 re-enters authFetch and sleeps through the 30s cooldown while holding the lock.
          st.mock.timers.tick(200);
          await flushAsync();
          assert.equal(locks.isHeld(TEST_LOCK_NAME), true, `${mode}: lock stays held entering cooldown`);
          assert.equal(refreshRequests, 1, `${mode}: cooldown blocks second network request at +200 ms`);

          // At +4_000 ms boundedAuth rejects BOTH A and B with AuthRecoveryRequired while A still holds the lock.
          st.mock.timers.tick(3_800);
          await flushAsync();
          const outcomeA = await pendingA;
          const outcomeB = await pendingB;
          assert.equal(outcomeA.ok, false, `${mode}: A rejects at 4s deadline`);
          assert.ok(outcomeA.error instanceof AuthRecoveryRequired, `${mode}: A rejects with AuthRecoveryRequired`);
          assert.equal(outcomeB.ok, false, `${mode}: B rejects at 4s deadline`);
          assert.ok(outcomeB.error instanceof AuthRecoveryRequired, `${mode}: B rejects with AuthRecoveryRequired`);
          assert.equal(outcomeB.at - failureStartedAt, 4_000, `${mode}: B times out at exactly 4000 ms`);
          assert.equal(locks.isHeld(TEST_LOCK_NAME), true, `${mode}: lock is still held after B times out`);

          // Still held just before the 30s cooldown expires.
          st.mock.timers.tick(25_900);
          await flushAsync();
          assert.equal(locks.isHeld(TEST_LOCK_NAME), true, `${mode}: lock is still held at 29.9s`);

          // At 30_000 ms the cooldown ends, attempt 1 sends a second refresh which also fails,
          // GoTrue stops retrying (30_000 + 400 >= AUTO_REFRESH_TICK_DURATION_MS), and A releases the lock.
          // B's queued initialize() then acquires the lock and fires a third refresh request.
          st.mock.timers.tick(100);
          await flushAsync();

          const firstHold = locks.holds[0];
          assert.ok(firstHold, `${mode}: A's lock hold was recorded`);
          assert.equal(firstHold.durationMs, 30_000, `${mode}: A held the cross-tab lock for 30000 ms`);
          assert.equal(refreshRequests, 3, `${mode}: A made 2 attempts (0ms, 30000ms) and B immediately started its own refresh after A released at 30s`);
          assert.equal(locks.isHeld(TEST_LOCK_NAME), true, `${mode}: B now holds the cross-tab lock in its own refresh/cooldown`);
          assert.equal(storage.entries.get(TEST_STORAGE_KEY), initialStored, `${mode}: stored session remains intact`);
        } finally {
          const quiesceDone = Promise.all([sessionA.quiesce(), sessionB?.quiesce()]);
          // Advance mocked timers past GoTrue's 200 ms retry sleep so B's initializePromise
          // re-enters authFetch while quiesced and settles immediately.
          st.mock.timers.tick(500);
          await quiesceDone;
        }
      });
    } finally {
      st.mock.timers.reset();
    }
  }

  await t.test("HTTP 429 without rotation", (st) => runGenuineFailureCase(st, "429"));
  await t.test("network error without rotation", (st) => runGenuineFailureCase(st, "network"));
});

test("no fabricated session can be stored: quiescedRefreshResponse is discarded by SDK guard and unchanged storage never produces a synthetic response", async (t) => {
  await t.test("quiescedRefreshResponse is discarded by SDK commit guard (AuthRefreshDiscardedError) with zero storage writes", async () => {
    const initialStored = makeStoredSession({ accessToken: "at-1", refreshToken: "rt-1", expired: false });
    const storage = memoryStorage({ [TEST_STORAGE_KEY]: initialStored });
    const locks = createFifoLocks();

    const observedAuthFetchResponses = [];
    const authStorageSetCalls = [];

    let refreshStartedResolve;
    const refreshStarted = new Promise((r) => { refreshStartedResolve = r; });
    let releaseRefresh;
    const refreshHeld = new Promise((r) => { releaseRefresh = r; });

    const fetchImpl = async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/auth/v1/token")) {
        refreshStartedResolve();
        await refreshHeld;
        return new Response(
          JSON.stringify({
            access_token: "at-server",
            refresh_token: "rt-server",
            expires_in: 3600,
            token_type: "bearer",
            user: { id: "user-1" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    };

    await withSharedBrowserEnv({ storage, locks, fetchImpl }, async () => {
      const session = makeBrowserSession({
        createClient(url, key, opts) {
          const origFetch = opts.global.fetch;
          const origStorage = opts.auth.storage;
          return createClient(url, key, {
            ...opts,
            global: {
              ...opts.global,
              async fetch(input, init) {
                const res = await origFetch(input, init);
                const reqUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
                if (reqUrl.includes("/auth/v1/token")) {
                  observedAuthFetchResponses.push({
                    status: res.status,
                    body: await res.clone().json().catch(() => null),
                  });
                }
                return res;
              },
            },
            auth: {
              ...opts.auth,
              storage: {
                getItem: (k) => origStorage.getItem(k),
                removeItem: (k) => origStorage.removeItem(k),
                setItem: (k, v) => {
                  authStorageSetCalls.push({ key: k, value: v });
                  return origStorage.setItem(k, v);
                },
              },
            },
          });
        },
      });

      try {
        // Wait for initial load of the valid stored session, then trigger an explicit refresh.
        const initial = await session.client.auth.getSession();
        assert.equal(initial.data.session?.refresh_token, "rt-1");

        const pendingRefresh = session.client.auth.refreshSession();
        await refreshStarted;

        // Quiesce while refresh is in flight, then release the underlying fetch so authFetch returns quiescedRefreshResponse().
        const quiesceDone = session.quiesce();
        releaseRefresh();
        const [refreshResult] = await Promise.all([pendingRefresh, quiesceDone]);

        assert.equal(observedAuthFetchResponses.length, 1, "authFetch returned the synthetic quiesced response");
        assert.equal(observedAuthFetchResponses[0].status, 200);
        assert.equal(observedAuthFetchResponses[0].body?.access_token, "quiesced");
        assert.equal(observedAuthFetchResponses[0].body?.refresh_token, "quiesced");

        // GoTrue's own commit guard (storageChangedUnderUs) discards the synthetic payload before calling _saveSession.
        assert.equal(refreshResult.data.session, null, "SDK returned no session");
        assert.equal(refreshResult.error?.name, "AuthRefreshDiscardedError", "SDK commit guard discarded the synthetic response");
        assert.deepEqual(authStorageSetCalls, [], "SDK never attempted to write the synthetic session to authStorage");
        assert.equal(storage.entries.get(TEST_STORAGE_KEY), initialStored, "localStorage still holds the original session");
        assert.equal(
          storage.ops.some((op) => op.startsWith("set:") || op.startsWith("remove:")),
          false,
          "zero localStorage mutations occurred",
        );
      } finally {
        await session.quiesce();
      }
    });
  });

  await t.test("if storage did NOT change, authFetch never produces a synthetic 200 response across refused/failed refreshes (including empty storage)", async () => {
    const scenarios = [
      {
        name: "unchanged rt-1 + 400 refresh_token_already_used",
        initialStorage: { [TEST_STORAGE_KEY]: makeStoredSession({ accessToken: "at-1", refreshToken: "rt-1", expired: false }) },
        refreshArg: undefined,
        response: () => alreadyUsedResponse(),
      },
      {
        name: "unchanged rt-1 + terminal 400 refresh_token_not_found",
        initialStorage: { [TEST_STORAGE_KEY]: makeStoredSession({ accessToken: "at-1", refreshToken: "rt-1", expired: false }) },
        refreshArg: undefined,
        response: () =>
          new Response(
            JSON.stringify({ code: "refresh_token_not_found", error_code: "refresh_token_not_found" }),
            {
              status: 400,
              headers: { "content-type": "application/json", "x-supabase-api-version": "2024-01-01" },
            },
          ),
      },
      {
        name: "unchanged rt-1 + 429 rate limit",
        initialStorage: { [TEST_STORAGE_KEY]: makeStoredSession({ accessToken: "at-1", refreshToken: "rt-1", expired: false }) },
        refreshArg: undefined,
        response: () =>
          new Response(
            JSON.stringify({ code: "over_request_rate_limit" }),
            {
              status: 429,
              headers: { "content-type": "application/json", "x-supabase-api-version": "2024-01-01" },
            },
          ),
      },
      {
        name: "empty storage (storedAtStart === null) + explicit refreshSession 400 refresh_token_already_used",
        initialStorage: {},
        refreshArg: { refresh_token: "rt-orphan" },
        response: () => alreadyUsedResponse(),
      },
    ];

    for (const scenario of scenarios) {
      const storage = memoryStorage(scenario.initialStorage);
      const locks = createFifoLocks();
      let capturedAuthFetch;
      const authStorageWrites = [];

      const fetchImpl = async (input) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("/auth/v1/token")) {
          return scenario.response();
        }
        throw new Error(`Unexpected fetch URL: ${url}`);
      };

      await withSharedBrowserEnv({ storage, locks, fetchImpl }, async () => {
        const session = makeBrowserSession({
          createClient(url, key, opts) {
            capturedAuthFetch = opts.global.fetch;
            const origStorage = opts.auth.storage;
            return createClient(url, key, {
              ...opts,
              auth: {
                ...opts.auth,
                storage: {
                  getItem: (k) => origStorage.getItem(k),
                  removeItem: (k) => origStorage.removeItem(k),
                  setItem: (k, v) => {
                    authStorageWrites.push(v);
                    return origStorage.setItem(k, v);
                  },
                },
              },
            });
          },
        });

        try {
          // Ensure initial session key discovery has run before exercising authFetch directly.
          await session.client.auth.getSession();

          // Exercise authFetch directly for a single refresh attempt while storage is UNCHANGED.
          let outcome;
          try {
            const res = await capturedAuthFetch(`${TEST_API_URL}/auth/v1/token?grant_type=refresh_token`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ refresh_token: scenario.refreshArg?.refresh_token ?? "rt-1" }),
            });
            outcome = { returned: true, status: res.status, ok: res.ok, body: await res.clone().json().catch(() => null) };
          } catch (error) {
            outcome = { returned: false, error };
          }

          if (outcome.returned) {
            assert.equal(outcome.ok, false, `${scenario.name}: must never return a synthetic 2xx response when storage did not change`);
            assert.notEqual(outcome.body?.access_token, "quiesced", `${scenario.name}: must never return quiesced payload`);
          } else {
            assert.ok(outcome.error instanceof Error, `${scenario.name}: threw error instead of synthetic response`);
          }

          assert.deepEqual(authStorageWrites, [], `${scenario.name}: nothing fabricated written to authStorage`);
          const storedNow = storage.entries.get(TEST_STORAGE_KEY) ?? null;
          assert.equal(
            storedNow,
            scenario.initialStorage[TEST_STORAGE_KEY] ?? null,
            `${scenario.name}: localStorage was not overwritten with any fabricated payload`,
          );
          if (storedNow) {
            assert.equal(storedNow.includes("quiesced"), false, `${scenario.name}: storage contains no quiesced token`);
          }
        } finally {
          await session.quiesce();
        }
      });
    }
  });
});
