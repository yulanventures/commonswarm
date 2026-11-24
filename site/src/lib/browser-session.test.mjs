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
  PINNED_SUPABASE_JS_VERSION,
  REFRESH_BACKOFF_BASE_MS,
  REFRESH_BACKOFF_CAP_MS,
  REFRESH_BACKOFF_FLOOR_MS,
  REFRESH_RETRY_AFTER_CEILING_MS,
  SessionExpired,
  createBrowserSession,
  credentialGenerationKey,
  deploymentOriginHash,
  isRestSessionEnded,
  multiAccountInUse,
  multiAccountStorageKeyPrefixesForDeployment,
  refreshBackoffStorageKeyForDeployment,
  resolveDeployment,
  sessionIdFromAccessToken,
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
  let navigatorLockCalls = 0;
  let processLockCalls = 0;
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
        navigatorLock: (...args) => {
          navigatorLockCalls += 1;
          return navigatorLock(...args);
        },
        processLock: (...args) => {
          processLockCalls += 1;
          return processLock(...args);
        },
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
    assert.equal(typeof capturedOptions?.auth?.lock, "function");
    assert.equal(result.client.rest?.retry, false);
    assert.equal("dispose" in result, false, "dispose is deferred until a product caller exists");
    await result.client.auth.getSession();
    assert.ok(navigatorLockCalls > 0, "delegated lock acquisitions to navigatorLock");
    assert.equal(processLockCalls, 0, "did not fall back to processLock");
    await result.client.auth.dispose();
  });
});

test("allowProcessLockFallback: true falls back to processLock when navigator.locks is absent", async () => {
  let capturedOptions;
  let navigatorLockCalls = 0;
  let processLockCalls = 0;
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
        navigatorLock: (...args) => {
          navigatorLockCalls += 1;
          return navigatorLock(...args);
        },
        processLock: (...args) => {
          processLockCalls += 1;
          return processLock(...args);
        },
        isAuthSessionMissingError,
        AuthRetryableFetchError,
      },
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(capturedOptions?.auth?.detectSessionInUrl, true);
    assert.equal(typeof capturedOptions?.auth?.lock, "function");
    assert.equal("dispose" in result, false);
    await result.client.auth.getSession();
    assert.ok(processLockCalls > 0, "delegated lock acquisitions to processLock");
    assert.equal(navigatorLockCalls, 0, "did not call navigatorLock when navigator.locks is absent");
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

test("Order A: rotation in storage before 400 refresh_token_already_used settles both sessions within 500 ms", async () => {
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

test("Order B: rotation in storage with storage event 200 ms after 400 refresh_token_already_used clears backoff and settles both sessions within 500 ms", async () => {
  const backoffKey = refreshBackoffStorageKeyForDeployment(TEST_API_URL);
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
      const pendingA = sessionA.currentSession().then(
        (v) => ({ ok: true, value: v }),
        (e) => ({ ok: false, error: e }),
      );
      await refreshStarted;
      assert.equal(locks.isHeld(TEST_LOCK_NAME), true, "A holds the shared lock during refresh");

      sessionB = makeBrowserSession();
      const pendingB = sessionB.currentSession().then(
        (v) => ({ ok: true, value: v }),
        (e) => ({ ok: false, error: e }),
      );

      // 400 arrives FIRST while storage still holds rt-1. Backoff is recorded OUTSIDE the lock
      // and both sessions report AuthRecoveryRequired promptly without holding the lock.
      const refusedAt = Date.now();
      releaseRefresh();

      const [initialA, initialB] = await raceDeadline(
        Promise.all([pendingA, pendingB]),
        250,
        () => `Order B initial refusal stalled: lockHeld=${locks.isHeld(TEST_LOCK_NAME)} refreshRequests=${refreshRequests}`,
      );
      assert.ok(Date.now() - refusedAt < 250, "both sessions reported promptly without waiting for 4s deadline");
      assert.equal(initialA.ok, false);
      assert.ok(initialA.error instanceof AuthRecoveryRequired);
      assert.ok(typeof initialA.error.retryAfter === "number" && initialA.error.retryAfter > refusedAt, "A carries retryAfter");
      assert.equal(initialB.ok, false);
      assert.ok(initialB.error instanceof AuthRecoveryRequired);
      assert.equal(initialB.error.retryAfter, initialA.error.retryAfter, "B shares cross-tab retryAfter");
      assert.equal(locks.isHeld(TEST_LOCK_NAME), false, "shared Web Lock is released outside backoff");
      assert.equal(refreshRequests, 1, "B sent zero extra wire refreshes during shared backoff");
      assert.ok(storage.entries.has(backoffKey), "cross-tab backoff entry recorded for rt-1");

      // Wait 200 ms inside the active backoff window before the peer rotation arrives.
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(locks.isHeld(TEST_LOCK_NAME), false, "lock stays free during backoff");
      assert.equal(refreshRequests, 1, "still zero extra refresh attempts during backoff");

      // Peer writes the rotated valid session and both sessions receive the storage event.
      storage.entries.set(TEST_STORAGE_KEY, rotatedStored);
      const sessionWritesAtRotation = storage.ops.filter(
        (op) => op === `set:${TEST_STORAGE_KEY}` || op === `remove:${TEST_STORAGE_KEY}`,
      ).length;
      const rotatedAt = Date.now();
      dispatchStorageEvent({ key: TEST_STORAGE_KEY, oldValue: initialStored, newValue: rotatedStored });

      // Condition 1: storage events run outside the cross-tab lock and must not mutate disk;
      // the mismatched backoff entry is ignored at read time until the next locked attempt cleans it up.
      assert.equal(storage.entries.has(backoffKey), true, "storage event did not mutate backoff key outside the lock");

      const [resA, resB] = await raceDeadline(
        Promise.all([sessionA.currentSession(), sessionB.currentSession()]),
        500,
        () => `Order B recovery stalled: lockHeld=${locks.isHeld(TEST_LOCK_NAME)} refreshRequests=${refreshRequests} userChecks=${userCheckTokens.length}`,
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
      const sessionWritesAfterRotation = storage.ops.filter(
        (op) => op === `set:${TEST_STORAGE_KEY}` || op === `remove:${TEST_STORAGE_KEY}`,
      ).length;
      assert.equal(sessionWritesAfterRotation, sessionWritesAtRotation, "no session wrote over the peer's rotated session");
    } finally {
      await Promise.all([sessionA.quiesce(), sessionB?.quiesce()]);
    }
  });
});

// Reviewer requirement: genuine refresh failure (429 with Retry-After and network error) with NO rotation:
// - Backoff lives outside the Web Lock; peer gets through and reports within 250 ms.
// - No further refresh is sent during the backoff window across both sessions sharing storage.
// - Total requests across tabs are bounded as designed (1 per window: Retry-After window or 2s/4s/8s/16s/32s/60s cap).
// - When the window ends, the next attempt is made and recovery works.
test("genuine refresh failure (429 with Retry-After and network error) without rotation releases lock, bounds cross-tab attempts, and recovers after backoff window", async (t) => {
  async function flushMacro() {
    for (let i = 0; i < 6; i += 1) {
      await new Promise((r) => setImmediate(r));
    }
  }

  async function runGenuineFailureCase(st, mode) {
    st.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_700_000_000_000 });
    const backoffKey = refreshBackoffStorageKeyForDeployment(TEST_API_URL);
    const initialStored = makeStoredSession({ accessToken: "at-1", refreshToken: "rt-1", expired: true });
    const storage = memoryStorage({ [TEST_STORAGE_KEY]: initialStored });
    const locks = createFifoLocks();

    let refreshRequests = 0;
    let userChecks = 0;
    let allowRecover = false;
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
        if (allowRecover) {
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
        if (mode === "429") {
          return new Response(
            JSON.stringify({ code: "over_request_rate_limit", message: "Too Many Requests" }),
            {
              status: 429,
              headers: {
                "content-type": "application/json",
                "x-supabase-api-version": "2024-01-01",
                "retry-after": "15",
              },
            },
          );
        }
        throw new TypeError("Failed to fetch");
      }
      if (url.includes("/auth/v1/user")) {
        userChecks += 1;
        return new Response(
          JSON.stringify({ id: "user-1", aud: "authenticated", email: "owner@example.test" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
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
          const failureAt = Date.now();
          assert.equal(locks.isHeld(TEST_LOCK_NAME), true, `${mode}: A holds lock during wire fetch`);

          sessionB = makeBrowserSession();
          const pendingB = sessionB.currentSession().then(
            (v) => ({ ok: true, value: v, at: Date.now() }),
            (e) => ({ ok: false, error: e, at: Date.now() }),
          );

          // Release A's first refresh failure; storage never rotates.
          const realStart = performance.now();
          releaseFirstRefresh();
          await flushMacro();

          const [outcomeA, outcomeB] = await Promise.all([pendingA, pendingB]);
          const realElapsedMs = performance.now() - realStart;

          const expectedWindowMs = mode === "429" ? 15_000 : REFRESH_BACKOFF_BASE_MS;
          assert.ok(realElapsedMs < 250, `${mode}: peer and first settled within 250 ms (actual ${realElapsedMs.toFixed(1)} ms)`);
          assert.equal(locks.isHeld(TEST_LOCK_NAME), false, `${mode}: lock is released immediately after failure`);
          assert.equal(outcomeA.ok, false);
          assert.ok(outcomeA.error instanceof AuthRecoveryRequired);
          assert.equal(outcomeA.error.retryAfter, failureAt + expectedWindowMs, `${mode}: A carries expected retryAfter`);
          assert.equal(outcomeB.ok, false);
          assert.ok(outcomeB.error instanceof AuthRecoveryRequired);
          assert.equal(outcomeB.error.retryAfter, failureAt + expectedWindowMs, `${mode}: peer B shares expected retryAfter`);
          assert.equal(outcomeB.at - failureAt, 0, `${mode}: peer B did not wait for 4s deadline`);
          assert.equal(refreshRequests, 1, `${mode}: exactly 1 wire refresh across A and B`);
          assert.equal(storage.entries.get(TEST_STORAGE_KEY), initialStored, `${mode}: stored session preserved`);

          // Repeated calls from BOTH tabs during the backoff window send ZERO additional refresh requests.
          st.mock.timers.tick(expectedWindowMs - 100);
          await flushMacro();
          for (const tab of [sessionA, sessionB, sessionA, sessionB]) {
            const t0 = performance.now();
            await assert.rejects(() => tab.currentSession(), (err) => {
              assert.ok(err instanceof AuthRecoveryRequired);
              assert.equal(err.retryAfter, failureAt + expectedWindowMs);
              return true;
            });
            assert.ok(performance.now() - t0 < 250, `${mode}: backoff rejection stayed under 250 ms`);
          }
          assert.equal(refreshRequests, 1, `${mode}: zero further wire refreshes during backoff window`);
          assert.equal(locks.isHeld(TEST_LOCK_NAME), false, `${mode}: lock remains free`);

          // For network error, also verify exponential escalation on a second consecutive failure (2s -> 4s)
          // so across two tabs total wire attempts are strictly bounded (1 per window).
          if (mode === "network") {
            st.mock.timers.tick(100); // now at +2_000 ms (window 1 ended)
            await flushMacro();
            await assert.rejects(() => sessionB.currentSession(), (err) => {
              assert.ok(err instanceof AuthRecoveryRequired);
              assert.equal(err.retryAfter, failureAt + 2_000 + 4_000, "second failure doubles backoff to 4_000 ms");
              return true;
            });
            assert.equal(refreshRequests, 2, "second wire attempt permitted when window 1 ended");
            // Tab A tries during window 2 (+3_900 ms into the 4 s window): 0 extra wire requests.
            st.mock.timers.tick(3_900);
            await flushMacro();
            await assert.rejects(() => sessionA.currentSession(), AuthRecoveryRequired);
            assert.equal(refreshRequests, 2, "tab A sent zero extra requests during window 2");
            // Advance to end of window 2 (+100 ms -> +6_000 ms total).
            st.mock.timers.tick(100);
          } else {
            // Advance past end of 15 s Retry-After window.
            st.mock.timers.tick(100);
          }
          await flushMacro();

          // Now the server recovers: next attempt succeeds and BOTH sessions verify cleanly.
          allowRecover = true;
          const recoveredA = await sessionA.currentSession();
          assert.equal(recoveredA?.refresh_token, "rt-recovered", `${mode}: A recovered after backoff window`);
          assert.equal(recoveredA?.access_token, "at-recovered");
          assert.equal(storage.entries.has(backoffKey), false, `${mode}: backoff entry cleared on recovery`);

          const verifiedB = await sessionB.currentSession();
          assert.equal(verifiedB?.refresh_token, "rt-recovered", `${mode}: peer B verified recovered session`);
          assert.equal(locks.isHeld(TEST_LOCK_NAME), false, `${mode}: lock free after recovery`);
          assert.equal(refreshRequests, mode === "network" ? 3 : 2, `${mode}: total refresh count matched strict cross-tab bound`);
          assert.equal(userChecks, 2, `${mode}: one getUser verification per tab after recovery`);
        } finally {
          await Promise.all([sessionA.quiesce(), sessionB?.quiesce()]);
        }
      });
    } finally {
      st.mock.timers.reset();
    }
  }

  await t.test("HTTP 429 with Retry-After without rotation", (st) => runGenuineFailureCase(st, "429"));
  await t.test("network error without rotation", (st) => runGenuineFailureCase(st, "network"));
});

test("no fabricated session can be stored: sentinel discard guard, independent setItem write fence, and terminal refusal contract", async (t) => {
  await t.test("quiesced refresh response carries a per-attempt sentinel and is discarded by SDK commit guard with zero storage writes", async () => {
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
        const initial = await session.client.auth.getSession();
        assert.equal(initial.data.session?.refresh_token, "rt-1");

        const pendingRefresh = session.client.auth.refreshSession();
        await refreshStarted;

        const quiesceDone = session.quiesce();
        releaseRefresh();
        const [refreshResult] = await Promise.all([pendingRefresh, quiesceDone]);

        assert.equal(observedAuthFetchResponses.length, 1, "authFetch returned the synthetic discard response");
        assert.equal(observedAuthFetchResponses[0].status, 200);
        assert.match(
          observedAuthFetchResponses[0].body?.access_token ?? "",
          /^__cs_discard_v1_[0-9a-f]{32}_[0-9a-f]{32}$/,
          "quiesced discard uses per-attempt unguessable sentinel",
        );
        assert.equal(
          observedAuthFetchResponses[0].body?.refresh_token,
          observedAuthFetchResponses[0].body?.access_token,
        );

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

  await t.test("independent write fence: direct authStorage.setItem with any sentinel payload is refused before touching memory or localStorage", async () => {
    const initialStored = makeStoredSession({ accessToken: "at-1", refreshToken: "rt-1", expired: false });
    const storage = memoryStorage({ [TEST_STORAGE_KEY]: initialStored });
    const locks = createFifoLocks();
    let capturedAuthFetch;
    let capturedStorage;

    const fetchImpl = async () => alreadyUsedResponse();

    await withSharedBrowserEnv({ storage, locks, fetchImpl }, async () => {
      const session = makeBrowserSession({
        createClient(url, key, opts) {
          capturedAuthFetch = opts.global.fetch;
          capturedStorage = opts.auth.storage;
          return createClient(url, key, opts);
        },
      });

      try {
        await session.client.auth.getSession();

        // Trigger two discard responses directly via authFetch (outside a locked _callRefreshToken
        // attempt) and verify each gets a distinct unguessable sentinel while authStorage.getItem
        // NEVER reports false absence outside an armed locked commit-guard read.
        const r1 = await capturedAuthFetch(`${TEST_API_URL}/auth/v1/token?grant_type=refresh_token`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ refresh_token: "rt-1" }),
        });
        const body1 = await r1.json();
        assert.equal(capturedStorage.getItem(TEST_STORAGE_KEY), initialStored, "out-of-attempt authFetch must not arm commit-guard read");

        const r2 = await capturedAuthFetch(`${TEST_API_URL}/auth/v1/token?grant_type=refresh_token`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ refresh_token: "rt-1" }),
        });
        const body2 = await r2.json();
        assert.equal(capturedStorage.getItem(TEST_STORAGE_KEY), initialStored, "storage adapter still returns real slot");

        assert.match(body1.access_token, /^__cs_discard_v1_[0-9a-f]{32}_[0-9a-f]{32}$/);
        assert.match(body2.access_token, /^__cs_discard_v1_[0-9a-f]{32}_[0-9a-f]{32}$/);
        assert.notEqual(body1.access_token, body2.access_token, "sentinels are unique per attempt");

        const sessionWritesBefore = storage.ops.filter((op) => op === `set:${TEST_STORAGE_KEY}`).length;

        // Direct setItem with raw sentinel JSON must throw before touching memory or localStorage.
        assert.throws(
          () => capturedStorage.setItem(TEST_STORAGE_KEY, JSON.stringify(body1)),
          AuthRetryableFetchError,
        );
        // Unicode-escaped sentinel JSON must ALSO be caught by the fence.
        const unicodeEscaped = JSON.stringify(body2).replace("__cs_", "\\u005f\\u005fcs_");
        assert.throws(
          () => capturedStorage.setItem(TEST_STORAGE_KEY, unicodeEscaped),
          AuthRetryableFetchError,
        );

        const sessionWritesAfter = storage.ops.filter((op) => op === `set:${TEST_STORAGE_KEY}`).length;
        assert.equal(sessionWritesAfter, sessionWritesBefore, "zero session writes reached localStorage");
        assert.equal(storage.entries.get(TEST_STORAGE_KEY), initialStored, "localStorage still holds the original session");
        assert.equal(capturedStorage.getItem(TEST_STORAGE_KEY), initialStored, "in-memory adapter cache was not poisoned");
      } finally {
        await session.quiesce();
      }
    });
  });

  await t.test("refused/failed refreshes never store fabricated data; matching terminal refusal returns the real error response", async () => {
    const scenarios = [
      {
        name: "unchanged rt-1 + 400 refresh_token_already_used",
        initialStorage: { [TEST_STORAGE_KEY]: makeStoredSession({ accessToken: "at-1", refreshToken: "rt-1", expired: false }) },
        refreshArg: undefined,
        expectTerminalPassThrough: false,
        response: () => alreadyUsedResponse(),
      },
      {
        name: "unchanged rt-1 + terminal 400 refresh_token_not_found",
        initialStorage: { [TEST_STORAGE_KEY]: makeStoredSession({ accessToken: "at-1", refreshToken: "rt-1", expired: false }) },
        refreshArg: undefined,
        expectTerminalPassThrough: true,
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
        expectTerminalPassThrough: false,
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
        expectTerminalPassThrough: false,
        response: () => alreadyUsedResponse(),
      },
    ];

    for (const scenario of scenarios) {
      const storage = memoryStorage(scenario.initialStorage);
      const locks = createFifoLocks();
      const observedEvents = [];

      const fetchImpl = async (input) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("/auth/v1/token")) {
          return scenario.response();
        }
        throw new Error(`Unexpected fetch URL: ${url}`);
      };

      await withSharedBrowserEnv({ storage, locks, fetchImpl }, async () => {
        const session = makeBrowserSession();
        session.client.auth.onAuthStateChange((event, sess) => observedEvents.push({ event, sess }));
        try {
          await session.client.auth.getSession();
          observedEvents.length = 0;

          const res = await session.client.auth.refreshSession(scenario.refreshArg);
          assert.equal(res.data.session, null, `${scenario.name}: must not return a fabricated session`);
          if (scenario.expectTerminalPassThrough) {
            assert.equal(res.error?.code, "refresh_token_not_found", `${scenario.name}: terminal error preserved`);
          } else if (Object.keys(scenario.initialStorage).length === 0) {
            assert.equal(res.error?.name, "AuthRetryableFetchError", `${scenario.name}: empty slot blocked by write fence`);
          } else {
            assert.equal(res.error?.name, "AuthRefreshDiscardedError", `${scenario.name}: non-terminal failure exited via discard`);
          }

          const storedNow = storage.entries.get(TEST_STORAGE_KEY) ?? null;
          assert.equal(
            storedNow,
            scenario.initialStorage[TEST_STORAGE_KEY] ?? null,
            `${scenario.name}: localStorage was not overwritten with any fabricated payload`,
          );
          if (storedNow) {
            assert.equal(storedNow.includes("__cs_discard_"), false, `${scenario.name}: storage contains no sentinel`);
          }
          assert.deepEqual(observedEvents, [], `${scenario.name}: zero false auth events emitted`);
        } finally {
          await session.quiesce();
        }
      });
    }
  });
});

function makeJwt({ sub = "user-1", sessionId = "sid-login-1", sig = "sig-secret-token-part" } = {}) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
  const payload = sessionId !== null ? { sub, session_id: sessionId } : { sub };
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}.${sig}`;
}

test("cross-tab backoff generation key (Item 15): uses non-secret session_id + user.id + expires_at (fallback without session_id), never stores token material, and invalidates on rotation or new login", async (t) => {
  await t.test("credentialGenerationKey distinguishes rotation (new expires_at) and new login (new session_id) and falls back when session_id is absent", () => {
    const jwtLogin1A = makeJwt({ sub: "user-1", sessionId: "sid-1", sig: "sig-secret-aaa" });
    const jwtLogin1B = makeJwt({ sub: "user-1", sessionId: "sid-1", sig: "sig-secret-bbb" });
    const jwtLogin2 = makeJwt({ sub: "user-1", sessionId: "sid-2", sig: "sig-secret-ccc" });

    assert.equal(sessionIdFromAccessToken(jwtLogin1A), "sid-1");
    assert.equal(sessionIdFromAccessToken("opaque-non-jwt"), null);

    const k1 = credentialGenerationKey({ access_token: jwtLogin1A, expires_at: 1_700_000_100, user: { id: "user-1" } });
    const k1Rotated = credentialGenerationKey({ access_token: jwtLogin1B, expires_at: 1_700_003_700, user: { id: "user-1" } });
    const k2NewLogin = credentialGenerationKey({ access_token: jwtLogin2, expires_at: 1_700_000_100, user: { id: "user-1" } });
    const kFallbackA = credentialGenerationKey({ access_token: "opaque-token-secret-1", expires_at: 1_700_000_100, user: { id: "user-1" } });
    const kFallbackB = credentialGenerationKey({ access_token: "opaque-token-secret-2", expires_at: 1_700_000_200, user: { id: "user-1" } });

    assert.ok(k1 && k1Rotated && k2NewLogin && kFallbackA && kFallbackB);
    assert.notEqual(k1, k1Rotated, "token rotation (same login, new expires_at) produces a different generation key");
    assert.notEqual(k1, k2NewLogin, "new login (new session_id, even same expires_at) produces a different generation key");
    assert.notEqual(kFallbackA, kFallbackB, "fallback without session_id still separates distinct expires_at");
    for (const key of [k1, k1Rotated, k2NewLogin, kFallbackA, kFallbackB]) {
      assert.equal(key.includes("sig-secret"), false, "generation key never contains JWT signature");
      assert.equal(key.includes("opaque-token-secret"), false, "generation key never contains raw access token");
    }
  });

  await t.test("rotation (same login, new expiry) and new login (new session_id) each ignore and clear prior backoff immediately", async () => {
    const backoffKey = refreshBackoffStorageKeyForDeployment(TEST_API_URL);
    const nowSec = Math.floor(Date.now() / 1000);
    const rt1 = "rt-secret-token-alpha-987654321";
    const at1 = makeJwt({ sub: "user-1", sessionId: "sid-login-A", sig: "sig-alpha-987654321" });
    const rtRot = "rt-secret-token-rot-123456789";
    const atRot = makeJwt({ sub: "user-1", sessionId: "sid-login-A", sig: "sig-rot-123456789" });
    const rtNewLogin = "rt-secret-token-loginB-555555";
    const atNewLogin = makeJwt({ sub: "user-1", sessionId: "sid-login-B", sig: "sig-loginB-555555" });

    const makeSessionJson = (accessToken, refreshToken, expiresAtSec) => JSON.stringify({
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: 3600,
      expires_at: expiresAtSec,
      token_type: "bearer",
      user: { id: "user-1", aud: "authenticated", email: "owner@example.test" },
    });

    const stored1 = makeSessionJson(at1, rt1, nowSec - 120);
    // Rotation: same login (sid-login-A), new expiry (nowSec - 30, still expired so refresh runs).
    const storedRotatedExpired = makeSessionJson(atRot, rtRot, nowSec - 30);
    // New login: new session_id (sid-login-B), even with identical expiry (nowSec - 120)!
    const storedNewLoginExpired = makeSessionJson(atNewLogin, rtNewLogin, nowSec - 120);

    const storage = memoryStorage({ [TEST_STORAGE_KEY]: stored1 });
    const locks = createFifoLocks();
    const seenRefreshTokens = [];

    const fetchImpl = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/auth/v1/token")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        seenRefreshTokens.push(body.refresh_token);
        if (body.refresh_token === rt1) {
          return new Response(JSON.stringify({ code: "over_request_rate_limit" }), {
            status: 429,
            headers: {
              "content-type": "application/json",
              "x-supabase-api-version": "2024-01-01",
              "retry-after": "86400",
            },
          });
        }
        return new Response(
          JSON.stringify({
            access_token: makeJwt({ sub: "user-1", sessionId: body.refresh_token === rtNewLogin ? "sid-login-B" : "sid-login-A", sig: `sig-ok-${seenRefreshTokens.length}` }),
            refresh_token: `rt-ok-${seenRefreshTokens.length}`,
            expires_in: 3600,
            token_type: "bearer",
            user: { id: "user-1", aud: "authenticated", email: "owner@example.test" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/auth/v1/user")) {
        return new Response(
          JSON.stringify({ id: "user-1", aud: "authenticated", email: "owner@example.test" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    await withSharedBrowserEnv({ storage, locks, fetchImpl }, async () => {
      const session = makeBrowserSession();
      try {
        const beforeFailure = Date.now();
        await assert.rejects(() => session.currentSession(), (err) => {
          assert.ok(err instanceof AuthRecoveryRequired);
          assert.ok(typeof err.retryAfter === "number");
          assert.ok(err.retryAfter <= beforeFailure + REFRESH_RETRY_AFTER_CEILING_MS + 1_000);
          assert.ok(err.retryAfter >= beforeFailure + REFRESH_RETRY_AFTER_CEILING_MS - 1_000);
          return true;
        });

        const rawBackoff = storage.entries.get(backoffKey);
        assert.ok(typeof rawBackoff === "string" && rawBackoff.length > 0);
        assert.equal(rawBackoff.includes(rt1), false, "backoff entry never contains refresh token");
        assert.equal(rawBackoff.includes(at1), false, "backoff entry never contains access token");
        assert.equal(rawBackoff.includes("sig-alpha"), false, "backoff entry never contains JWT signature");
        const parsedBackoff = JSON.parse(rawBackoff);
        assert.deepEqual(Object.keys(parsedBackoff).sort(), ["attempts", "gen", "nextAttemptAt"]);
        assert.equal(parsedBackoff.gen, credentialGenerationKey(JSON.parse(stored1)));
        assert.equal(parsedBackoff.attempts, 1);

        // 1) Rotation (same login, new expires_at) replaces storage without a storage event:
        //    old backoff is ignored and cleared, refreshing rtRot immediately.
        storage.entries.set(TEST_STORAGE_KEY, storedRotatedExpired);
        const verifiedRot = await session.currentSession();
        assert.equal(verifiedRot?.refresh_token, "rt-ok-2");
        assert.equal(storage.entries.has(backoffKey), false, "old backoff cleared after rotation");

        // Re-seed backoff for stored1, then replace with new login (new session_id, SAME expires_at):
        storage.entries.set(TEST_STORAGE_KEY, stored1);
        await assert.rejects(() => session.currentSession(), AuthRecoveryRequired);
        assert.ok(storage.entries.has(backoffKey));

        // 2) New login (new session_id, identical expires_at) ignores and clears prior backoff immediately.
        storage.entries.set(TEST_STORAGE_KEY, storedNewLoginExpired);
        const verifiedNewLogin = await session.currentSession();
        assert.equal(verifiedNewLogin?.refresh_token, "rt-ok-4");
        assert.equal(storage.entries.has(backoffKey), false, "old backoff cleared after new login");
        assert.deepEqual(seenRefreshTokens, [rt1, rtRot, rt1, rtNewLogin]);
      } finally {
        await session.quiesce();
      }
    });
  });
});

test("cross-tab backoff across two independent module instances (Items 12 & 13): shares ONLY storage and fake lock; no retry during backoff, storage event triggers fresh verified read, and new credential/login proceeds immediately while predecessor stays fenced", async () => {
  const modA = await import("../../../shared/browser-session/index.ts?tab=backoff-a");
  const modB = await import("../../../shared/browser-session/index.ts?tab=backoff-b");
  assert.notEqual(modA, modB, "Tab A and Tab B loaded as separate ES module instances");
  assert.notEqual(modA.createBrowserSession, modB.createBrowserSession, "no shared JS module closure");

  const backoffKey = modA.refreshBackoffStorageKeyForDeployment(TEST_API_URL);
  const nowSec = Math.floor(Date.now() / 1000);
  const makeSessionJson = (accessToken, refreshToken, expiresAtSec, userId = "user-1") => JSON.stringify({
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: 3600,
    expires_at: expiresAtSec,
    token_type: "bearer",
    user: { id: userId, aud: "authenticated", email: "owner@example.test" },
  });

  const s1Expired = makeSessionJson(makeJwt({ sub: "user-1", sessionId: "sid-1", sig: "sig-s1" }), "rt-s1", nowSec - 120);
  const s1RotatedValid = makeSessionJson(makeJwt({ sub: "user-1", sessionId: "sid-1", sig: "sig-s1-rot" }), "rt-s1-rot", nowSec + 3600);
  const s2NewLoginExpired = makeSessionJson(makeJwt({ sub: "user-2", sessionId: "sid-2", sig: "sig-s2" }), "rt-s2", nowSec - 120, "user-2");

  const storage = memoryStorage({ [TEST_STORAGE_KEY]: s1Expired });
  const locks = createFifoLocks();
  const refreshTokensSent = [];
  const userAuthHeaders = [];
  let holdPredecessor = false;
  let predecessorStartedResolve;
  const predecessorStarted = new Promise((r) => { predecessorStartedResolve = r; });
  let releasePredecessor;
  const predecessorHeld = new Promise((r) => { releasePredecessor = r; });

  const fetchImpl = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/auth/v1/token")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      refreshTokensSent.push(body.refresh_token);
      if (body.refresh_token === "rt-s1") {
        if (holdPredecessor) {
          predecessorStartedResolve();
          await predecessorHeld;
        }
        return new Response(JSON.stringify({ code: "over_request_rate_limit" }), {
          status: 429,
          headers: {
            "content-type": "application/json",
            "x-supabase-api-version": "2024-01-01",
            "retry-after": "20",
          },
        });
      }
      if (body.refresh_token === "rt-s2") {
        return new Response(
          JSON.stringify({
            access_token: makeJwt({ sub: "user-2", sessionId: "sid-2", sig: "sig-s2-fresh" }),
            refresh_token: "rt-s2-fresh",
            expires_in: 3600,
            token_type: "bearer",
            user: { id: "user-2", aud: "authenticated", email: "two@example.test" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected refresh token: ${body.refresh_token}`);
    }
    if (url.includes("/auth/v1/user")) {
      const auth = new Headers(init?.headers).get("authorization");
      userAuthHeaders.push(auth);
      const isUser2 = auth?.includes("sig-s2-fresh");
      return new Response(
        JSON.stringify({ id: isUser2 ? "user-2" : "user-1", aud: "authenticated" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  await withSharedBrowserEnv({ storage, locks, fetchImpl }, async ({ dispatchStorageEvent }) => {
    const sdk = { createClient, navigatorLock, processLock, isAuthSessionMissingError, AuthRetryableFetchError };
    const tabA = modA.createBrowserSession({ url: TEST_API_URL, anonKey: "anon-key", detectSessionInUrl: false, allowProcessLockFallback: false, sdk });
    const tabB = modB.createBrowserSession({ url: TEST_API_URL, anonKey: "anon-key", detectSessionInUrl: false, allowProcessLockFallback: false, sdk });
    assert.equal(tabA.ok, true);
    assert.equal(tabB.ok, true);
    if (!tabA.ok || !tabB.ok) return;

    try {
      // 1) Tab A fails with 429; backoff is written ONLY to storage.
      let errA;
      try { await tabA.currentSession(); } catch (e) { errA = e; }
      assert.equal(errA?.name, "AuthRecoveryRequired");
      assert.ok(typeof errA?.retryAfter === "number");
      assert.equal(refreshTokensSent.length, 1);
      assert.ok(storage.entries.has(backoffKey), "backoff persisted in shared storage");

      // Tab B (distinct module instance) observes the storage backoff entry and sends ZERO wire retries.
      let errB;
      try { await tabB.currentSession(); } catch (e) { errB = e; }
      assert.equal(errB?.name, "AuthRecoveryRequired");
      assert.equal(errB?.retryAfter, errA.retryAfter, "Tab B read exact retryAfter from storage");
      // Repeated call on Tab A also sends zero retries.
      await assert.rejects(() => tabA.currentSession(), (e) => e?.name === "AuthRecoveryRequired");
      assert.deepEqual(refreshTokensSent, ["rt-s1"], "zero network retries by either instance during genuine backoff");

      // 2) Storage change prompts a fresh verified read on both instances with zero extra refreshes.
      storage.entries.set(TEST_STORAGE_KEY, s1RotatedValid);
      dispatchStorageEvent({ key: TEST_STORAGE_KEY, oldValue: s1Expired, newValue: s1RotatedValid });
      // Condition 1: storage event is a read-only hint outside the lock; mismatched backoff is ignored
      // at read time and cleaned up by the next locked operation (verified in step 3 below).
      assert.equal(storage.entries.has(backoffKey), true, "storage event did not mutate backoff key outside the lock");

      const [verA, verB] = await Promise.all([tabA.verifiedSession(), tabB.verifiedSession()]);
      assert.equal(verA?.refresh_token, "rt-s1-rot");
      assert.equal(verB?.refresh_token, "rt-s1-rot");
      assert.deepEqual(refreshTokensSent, ["rt-s1"], "still zero extra refreshes after rotation");
      assert.equal(userAuthHeaders.length, 2, "fresh verified getUser() ran on both instances");

      // 3) New login proceeds immediately while an in-flight predecessor refresh stays fenced.
      // Clear Step 1's active backoff for s1Expired before re-seeding the same credential
      // (Condition 1 keeps Step 2's unlocked storage event from deleting backoffKey on disk).
      storage.entries.delete(backoffKey);
      storage.entries.set(TEST_STORAGE_KEY, s1Expired);
      dispatchStorageEvent({ key: TEST_STORAGE_KEY, oldValue: s1RotatedValid, newValue: s1Expired });
      holdPredecessor = true;
      const pendingPredecessor = tabA.verifiedSession();
      await predecessorStarted;

      // Replacement new login lands in storage while Tab A's predecessor rt-s1 is in flight.
      storage.entries.set(TEST_STORAGE_KEY, s2NewLoginExpired);
      dispatchStorageEvent({ key: TEST_STORAGE_KEY, oldValue: s1Expired, newValue: s2NewLoginExpired });
      const pendingNewLoginB = tabB.verifiedSession();
      releasePredecessor();

      const [resA, resB] = await Promise.all([pendingPredecessor, pendingNewLoginB]);
      assert.equal(resB?.refresh_token, "rt-s2-fresh", "Tab B refreshed & verified new login immediately");
      assert.equal(resB?.user.id, "user-2");
      assert.equal(resA?.user.id, "user-2", "Tab A fenced predecessor and adopted verified new login");
      assert.equal(storage.entries.has(backoffKey), false, "predecessor left no backoff over new login");
      assert.equal(JSON.parse(storage.entries.get(TEST_STORAGE_KEY)).refresh_token, "rt-s2-fresh");
    } finally {
      await Promise.all([tabA.quiesce(), tabB.quiesce()]);
    }
  });
});

test("Item 14: no raw refresh token, access token, or session payload appears in backoff entry, thrown errors, or console logs", async () => {
  const backoffKey = refreshBackoffStorageKeyForDeployment(TEST_API_URL);
  const secretRt = "rt_SUPER_SECRET_REFRESH_CREDENTIAL_XYZ987";
  const secretSig = "SIG_SUPER_SECRET_ACCESS_PART_ABC123";
  const secretAt = makeJwt({ sub: "user-1", sessionId: "sid-scan-1", sig: secretSig });
  const nowSec = Math.floor(Date.now() / 1000);
  const storedJson = JSON.stringify({
    access_token: secretAt,
    refresh_token: secretRt,
    expires_in: 3600,
    expires_at: nowSec - 120,
    token_type: "bearer",
    user: { id: "user-1", aud: "authenticated", email: "owner@example.test" },
  });

  const secrets = [secretRt, secretAt, secretSig, storedJson];
  const assertNoSecretLeak = (label, text) => {
    for (const secret of secrets) {
      assert.equal(text.includes(secret), false, `secret leaked in ${label}`);
    }
  };

  const consoleMessages = [];
  const origConsole = { log: console.log, warn: console.warn, error: console.error, debug: console.debug };
  for (const level of Object.keys(origConsole)) {
    console[level] = (...args) => {
      consoleMessages.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    };
  }

  const collectedErrors = [];
  let mode = "429";
  const storage = memoryStorage({ [TEST_STORAGE_KEY]: storedJson });
  const locks = createFifoLocks();
  let capturedStorage;

  const fetchImpl = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/auth/v1/token")) {
      if (mode === "429") {
        return new Response(JSON.stringify({ code: "over_request_rate_limit" }), {
          status: 429,
          headers: { "content-type": "application/json", "x-supabase-api-version": "2024-01-01", "retry-after": "10" },
        });
      }
      if (mode === "terminal") {
        return new Response(JSON.stringify({ code: "refresh_token_not_found", error_code: "refresh_token_not_found" }), {
          status: 400,
          headers: { "content-type": "application/json", "x-supabase-api-version": "2024-01-01" },
        });
      }
      throw new TypeError("Failed to fetch");
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    await withSharedBrowserEnv({ storage, locks, fetchImpl }, async ({ dispatchStorageEvent }) => {
      const session = makeBrowserSession({
        createClient(url, key, opts) {
          capturedStorage = opts.auth.storage;
          return createClient(url, key, opts);
        },
      });

      try {
        // 1) Genuine 429 -> AuthRecoveryRequired + backoff entry
        try { await session.currentSession(); } catch (err) { collectedErrors.push({ path: "429-backoff", err }); }
        const rawBackoff = storage.entries.get(backoffKey);
        assert.ok(typeof rawBackoff === "string" && rawBackoff.length > 0);
        assertNoSecretLeak("backoff storage entry", rawBackoff);

        // 2) Active backoff hit -> AuthRecoveryRequired
        try { await session.verifiedSession(); } catch (err) { collectedErrors.push({ path: "active-backoff", err }); }

        // 3) Terminal refusal -> SessionExpired
        storage.entries.delete(backoffKey);
        mode = "terminal";
        try { await session.verifiedSession(); } catch (err) { collectedErrors.push({ path: "terminal-refusal", err }); }

        // 4) Empty-slot orphan fence -> AuthRetryableFetchError
        mode = "network";
        const orphanRes = await session.client.auth.refreshSession({ refresh_token: secretRt });
        if (orphanRes.error) collectedErrors.push({ path: "orphan-fence", err: orphanRes.error });

        // 5) Quiesced storage write/remove -> AuthRetryableFetchError
        await session.quiesce();
        try { capturedStorage.setItem(TEST_STORAGE_KEY, storedJson); } catch (err) { collectedErrors.push({ path: "quiesced-setItem", err }); }
        try { capturedStorage.removeItem(TEST_STORAGE_KEY); } catch (err) { collectedErrors.push({ path: "quiesced-removeItem", err }); }

        assert.ok(collectedErrors.length >= 6, "collected errors from all paths");
        for (const { path: label, err } of collectedErrors) {
          const serialized = [
            String(err),
            err?.name ?? "",
            err?.message ?? "",
            err?.stack ?? "",
            JSON.stringify(err, Object.getOwnPropertyNames(err ?? {})),
          ].join("\n");
          assertNoSecretLeak(`error(${label})`, serialized);
        }
        for (const line of consoleMessages) {
          assertNoSecretLeak("console output", line);
        }
        void dispatchStorageEvent;
      } finally {
        await session.quiesce();
      }
    });
  } finally {
    Object.assign(console, origConsole);
  }
});

test("Condition 1 (two independent module instances): delayed TOKEN_REFRESHED/SIGNED_IN preserves active peer backoff; readable-but-write-refused storage preserves in-process backoff; Retry-After: 300 gates wire for 300s; 15-minute ceiling clamps extreme headers", async (t) => {
  await t.test("delayed TOKEN_REFRESHED and SIGNED_IN for current session arriving after peer 429 backoff do not clear backoff or allow wire refresh before retry time", async () => {
    const modA = await import("../../../shared/browser-session/index.ts?tab=c1-delayed-a");
    const modB = await import("../../../shared/browser-session/index.ts?tab=c1-delayed-b");
    assert.notEqual(modA, modB, "two distinct ES module instances");

    const backoffKey = modA.refreshBackoffStorageKeyForDeployment(TEST_API_URL);
    const nowSec = Math.floor(Date.now() / 1000);
    const currentAt = makeJwt({ sub: "user-1", sessionId: "sid-c1-1", sig: "sig-c1-1" });
    const currentSessionObj = {
      access_token: currentAt,
      refresh_token: "rt-c1-1",
      expires_in: 3600,
      expires_at: nowSec - 120,
      token_type: "bearer",
      user: { id: "user-1", aud: "authenticated", email: "owner@example.test" },
    };
    const storedJson = JSON.stringify(currentSessionObj);
    const storage = memoryStorage({ [TEST_STORAGE_KEY]: storedJson });
    const locks = createFifoLocks();
    let refreshWireCalls = 0;

    const fetchImpl = async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/auth/v1/token")) {
        refreshWireCalls += 1;
        return new Response(JSON.stringify({ code: "over_request_rate_limit" }), {
          status: 429,
          headers: {
            "content-type": "application/json",
            "x-supabase-api-version": "2024-01-01",
            "retry-after": "30",
          },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    await withSharedBrowserEnv({ storage, locks, fetchImpl }, async ({ dispatchStorageEvent }) => {
      const sdk = { createClient, navigatorLock, processLock, isAuthSessionMissingError, AuthRetryableFetchError };
      const tabA = modA.createBrowserSession({ url: TEST_API_URL, anonKey: "anon-key", detectSessionInUrl: false, allowProcessLockFallback: false, sdk });
      const tabB = modB.createBrowserSession({ url: TEST_API_URL, anonKey: "anon-key", detectSessionInUrl: false, allowProcessLockFallback: false, sdk });
      assert.equal(tabA.ok, true);
      assert.equal(tabB.ok, true);
      if (!tabA.ok || !tabB.ok) return;

      const observedA = [];
      tabA.client.auth.onAuthStateChange((event) => observedA.push(event));

      try {
        // Peer Tab B hits 429 and writes shared durable backoff for the current session generation.
        let errB;
        try { await tabB.verifiedSession(); } catch (e) { errB = e; }
        assert.equal(errB?.name, "AuthRecoveryRequired");
        assert.equal(refreshWireCalls, 1);
        const backoffRawAfter429 = storage.entries.get(backoffKey);
        assert.ok(typeof backoffRawAfter429 === "string" && backoffRawAfter429.length > 0, "peer wrote durable backoff");

        // Simulate delayed peer BroadcastChannel TOKEN_REFRESHED and SIGNED_IN events for the
        // CURRENT session arriving outside the refresh lock on Tab A.
        await tabA.client.auth._notifyAllSubscribers("TOKEN_REFRESHED", currentSessionObj, false);
        await tabA.client.auth._notifyAllSubscribers("SIGNED_IN", currentSessionObj, false);
        dispatchStorageEvent({ key: TEST_STORAGE_KEY, oldValue: storedJson, newValue: storedJson });

        assert.deepEqual(observedA, ["TOKEN_REFRESHED", "SIGNED_IN"], "subscribers still received delayed events");
        assert.equal(
          storage.entries.get(backoffKey),
          backoffRawAfter429,
          "delayed TOKEN_REFRESHED/SIGNED_IN and storage event preserved matching durable backoff",
        );

        // Neither Tab A nor Tab B may send another wire refresh before the retry deadline.
        let errA;
        try { await tabA.verifiedSession(); } catch (e) { errA = e; }
        assert.equal(errA?.name, "AuthRecoveryRequired");
        assert.equal(errA?.retryAfter, errB.retryAfter, "Tab A honoured Tab B's exact retryAfter");
        await assert.rejects(() => tabB.verifiedSession(), (e) => e?.name === "AuthRecoveryRequired");
        assert.equal(refreshWireCalls, 1, "zero wire refreshes sent before retry deadline despite delayed events");
      } finally {
        await Promise.all([tabA.quiesce(), tabB.quiesce()]);
      }
    });
  });

  await t.test("readable storage with refused writes (QuotaExceededError) still bounds this tab via in-process fallback", async () => {
    const backoffKey = refreshBackoffStorageKeyForDeployment(TEST_API_URL);
    const nowSec = Math.floor(Date.now() / 1000);
    const stored1 = JSON.stringify({
      access_token: makeJwt({ sub: "user-1", sessionId: "sid-ro-1", sig: "sig-ro-1" }),
      refresh_token: "rt-ro-1",
      expires_in: 3600,
      expires_at: nowSec - 120,
      token_type: "bearer",
      user: { id: "user-1", aud: "authenticated", email: "owner@example.test" },
    });
    const base = memoryStorage({ [TEST_STORAGE_KEY]: stored1 });
    const writeRefusingStorage = {
      ...base,
      get length() { return base.length; },
      key(i) { return base.key(i); },
      getItem(k) { return base.getItem(k); },
      setItem() { throw new DOMException("QuotaExceededError", "QuotaExceededError"); },
      removeItem(k) { base.removeItem(k); },
    };
    const locks = createFifoLocks();
    let refreshWireCalls = 0;

    const fetchImpl = async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/auth/v1/token")) {
        refreshWireCalls += 1;
        return new Response(JSON.stringify({ code: "over_request_rate_limit" }), {
          status: 429,
          headers: { "content-type": "application/json", "x-supabase-api-version": "2024-01-01", "retry-after": "25" },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    await withSharedBrowserEnv({ storage: writeRefusingStorage, locks, fetchImpl }, async ({ dispatchStorageEvent }) => {
      const session = makeBrowserSession();
      try {
        let firstErr;
        try { await session.verifiedSession(); } catch (e) { firstErr = e; }
        assert.equal(firstErr?.name, "AuthRecoveryRequired");
        assert.ok(typeof firstErr?.retryAfter === "number" && firstErr.retryAfter > Date.now() + 20_000);
        assert.equal(base.entries.has(backoffKey), false, "disk backoff key is absent because setItem threw");
        assert.equal(refreshWireCalls, 1);

        // Even after a storage event or repeated verifiedSession()/getSession() calls while disk
        // remains readable and returns null for backoffKey, this tab keeps its same-generation
        // in-memory backoff and sends ZERO extra wire refreshes.
        dispatchStorageEvent({ key: backoffKey, oldValue: null, newValue: null });
        let secondErr;
        try { await session.verifiedSession(); } catch (e) { secondErr = e; }
        assert.equal(secondErr?.name, "AuthRecoveryRequired");
        assert.equal(secondErr?.retryAfter, firstErr.retryAfter, "in-process fallback preserved exact retryAfter");
        await session.client.auth.getSession();
        assert.equal(refreshWireCalls, 1, "zero extra wire refreshes when storage is readable but writes are refused");
      } finally {
        await session.quiesce();
      }
    });
  });

  await t.test("Retry-After: 300 gates the wire for full 300s even on earlier screen-level retries, and 15-minute ceiling clamps extreme headers", async () => {
    const backoffKey = refreshBackoffStorageKeyForDeployment(TEST_API_URL);
    let fakeNow = Date.now();
    const realDateNow = Date.now;
    Date.now = () => fakeNow;

    try {
      const nowSec = Math.floor(fakeNow / 1000);
      const makeExpired = (sid, rt) => JSON.stringify({
        access_token: makeJwt({ sub: "user-1", sessionId: sid, sig: `sig-${sid}` }),
        refresh_token: rt,
        expires_in: 3600,
        expires_at: nowSec - 120,
        token_type: "bearer",
        user: { id: "user-1", aud: "authenticated", email: "owner@example.test" },
      });

      const storage = memoryStorage({ [TEST_STORAGE_KEY]: makeExpired("sid-ra300", "rt-ra300") });
      const locks = createFifoLocks();
      let retryAfterHeader = "300";
      let refreshWireCalls = 0;

      const fetchImpl = async (input) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("/auth/v1/token")) {
          refreshWireCalls += 1;
          return new Response(JSON.stringify({ code: "over_request_rate_limit" }), {
            status: 429,
            headers: {
              "content-type": "application/json",
              "x-supabase-api-version": "2024-01-01",
              "retry-after": retryAfterHeader,
            },
          });
        }
        throw new Error(`Unexpected URL: ${url}`);
      };

      await withSharedBrowserEnv({ storage, locks, fetchImpl }, async () => {
        const modA = await import("../../../shared/browser-session/index.ts?tab=c1-ra-a");
        const modB = await import("../../../shared/browser-session/index.ts?tab=c1-ra-b");
        const sdk = { createClient, navigatorLock, processLock, isAuthSessionMissingError, AuthRetryableFetchError };
        const tabA = modA.createBrowserSession({ url: TEST_API_URL, anonKey: "anon-key", detectSessionInUrl: false, allowProcessLockFallback: false, sdk });
        const tabB = modB.createBrowserSession({ url: TEST_API_URL, anonKey: "anon-key", detectSessionInUrl: false, allowProcessLockFallback: false, sdk });
        assert.equal(tabA.ok && tabB.ok, true);
        if (!tabA.ok || !tabB.ok) return;

        try {
          const t0 = fakeNow;
          let err1;
          try { await tabA.verifiedSession(); } catch (e) { err1 = e; }
          assert.equal(err1?.name, "AuthRecoveryRequired");
          assert.equal(err1?.retryAfter, t0 + 300_000, "Retry-After: 300 is NOT clipped to 60s exponential cap");
          assert.equal(refreshWireCalls, 1);

          // Screen-level retry at +65s (past old 60s cap) and +299s must STILL send zero wire calls.
          fakeNow = t0 + 65_000;
          let err65;
          try { await tabB.verifiedSession(); } catch (e) { err65 = e; }
          assert.equal(err65?.name, "AuthRecoveryRequired");
          assert.equal(err65?.retryAfter, t0 + 300_000);
          assert.equal(refreshWireCalls, 1, "wire still gated at +65s");

          fakeNow = t0 + 299_000;
          await assert.rejects(() => tabA.verifiedSession(), (e) => e?.name === "AuthRecoveryRequired");
          assert.equal(refreshWireCalls, 1, "wire still gated at +299s");

          // At +300s, the wire gate opens; test extreme Retry-After: 7200 against the 15-minute ceiling.
          retryAfterHeader = "7200";
          fakeNow = t0 + 300_000;
          let errCeiling;
          try { await tabA.verifiedSession(); } catch (e) { errCeiling = e; }
          assert.equal(errCeiling?.name, "AuthRecoveryRequired");
          assert.equal(REFRESH_RETRY_AFTER_CEILING_MS, 15 * 60 * 1_000, "sanity ceiling is 15 minutes");
          assert.equal(errCeiling?.retryAfter, fakeNow + REFRESH_RETRY_AFTER_CEILING_MS, "extreme Retry-After clamped to 15-minute ceiling");
          assert.equal(refreshWireCalls, 2);

          // Still gated at +899s from second failure, then allowed at +900s.
          const t1 = fakeNow;
          fakeNow = t1 + REFRESH_RETRY_AFTER_CEILING_MS - 1_000;
          await assert.rejects(() => tabB.verifiedSession(), (e) => e?.name === "AuthRecoveryRequired");
          assert.equal(refreshWireCalls, 2, "wire gated up to 15-minute ceiling");
          fakeNow = t1 + REFRESH_RETRY_AFTER_CEILING_MS;
          await assert.rejects(() => tabB.verifiedSession(), (e) => e?.name === "AuthRecoveryRequired");
          assert.equal(refreshWireCalls, 3, "wire opens once 15-minute ceiling elapses");
          assert.ok(storage.entries.has(backoffKey));
        } finally {
          await Promise.all([tabA.quiesce(), tabB.quiesce()]);
        }
      });
    } finally {
      Date.now = realDateNow;
    }
  });
});
