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
