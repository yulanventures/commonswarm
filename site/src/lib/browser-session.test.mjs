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
    await result.client.auth.getSession();
    result.dispose();
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
    await result.client.auth.getSession();
    result.dispose();
    await result.client.auth.dispose();
  });
});

test("multiAccountInUse detects all multi-account key shapes and ignores single-account or other deployments", () => {
  const url = "https://api.commonswarm.com";
  const otherUrl = "https://staging.commonswarm.com";
  const hash = deploymentOriginHash(url);
  const otherHash = deploymentOriginHash(otherUrl);

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

  assert.equal(multiAccountInUse(null), false);
  assert.equal(multiAccountInUse(undefined), false);
  assert.equal(multiAccountInUse(memoryStorage({})), false);
  assert.equal(multiAccountInUse(memoryStorage({ "sb-api-auth-token": "{}", theme: "dark" })), false);
  assert.equal(multiAccountInUse(memoryStorage({ "sb-api-auth-token": "{}" }), url), false);

  const matchingKeys = [
    `commonswarm:accounts:v1:${hash}`,
    `commonswarm:active-account:v1:${hash}`,
    `commonswarm:tab-account:v1:${hash}`,
    `commonswarm:auth:v1:${hash}:login:login-1`,
    `commonswarm:auth:v1:${hash}:attempt:attempt-1`,
  ];
  for (const key of matchingKeys) {
    const store = memoryStorage({ "sb-api-auth-token": "{}", [key]: "1" });
    assert.equal(multiAccountInUse(store), true, `unscoped check must match ${key}`);
    assert.equal(multiAccountInUse(store, url), true, `deployment-scoped check must match ${key}`);
    assert.equal(multiAccountInUse(store, otherUrl), false, `other deployment must not match ${key}`);
  }

  const otherStore = memoryStorage({ [`commonswarm:accounts:v1:${otherHash}`]: "{}" });
  assert.equal(multiAccountInUse(otherStore), true);
  assert.equal(multiAccountInUse(otherStore, url), false);
  assert.equal(multiAccountInUse(otherStore, otherUrl), true);
});

test("shared browser-session PostgREST refusal schedules locked verification, never direct sign-out", async () => {
  assert.equal(await isRestSessionEnded(new Response(JSON.stringify({ code: "session_not_found" }), { status: 401 })), true);
  const source = await readFile(new URL("../../../shared/browser-session/index.ts", import.meta.url), "utf8");
  assert.match(source, /if \(url\.pathname\.includes\("\/rest\/v1\/"\) && await isRestSessionEnded\(response\)\) checkSessionAfterRestRefusal\(\);/);
  assert.match(source, /function checkSessionAfterRestRefusal\(verify: \(\) => Promise<unknown> = \(\) => verifiedSession\(\)\)/);
  const body = source.slice(source.indexOf("function checkSessionAfterRestRefusal"), source.indexOf("const authFetch"));
  assert.doesNotMatch(body, /signOut|removeItem|_removeSession/, "removal happens only inside the SDK's verified check");
});
