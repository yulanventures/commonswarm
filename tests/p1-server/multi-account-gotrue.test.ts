/**
 * Real pinned GoTrue + SDK integration test for Multi-Account Sign-In core (PR 1, Rev 4).
 *
 * Exercises AccountManager against the local Supabase GoTrue container:
 *  - Two distinct real accounts signed in simultaneously with isolated per-login storage & locks
 *  - Real pinned-email OTP verification via GoTrue /auth/v1/verify
 *  - Real GoTrue token refresh on Account A leaving Account B untouched (and zero BroadcastChannel creds)
 *  - Real ordinary sign-out (scope=local) ending ONLY Account A on this device while keeping
 *    Account A's other device session AND Account B's session live on GoTrue
 *  - Real Sign out all (scope=local) revoking ONLY browser-registered sessions while preserving
 *    other devices
 *  - Real GoTrue /auth/v1/token?grant_type=pkce refusal on retired/invalid code & clean staging storage
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { createClient } from "@supabase/supabase-js";
import {
  AccountManager,
  attemptStorageKey,
  deploymentOriginHash,
  slotStorageKey,
  type BroadcastChannelLike,
  type HistoryLike,
  type LocationLike,
  type LockLike,
} from "../../site/src/lib/multi-account.js";

interface LocalEnvironment {
  API_URL: string;
  ANON_KEY: string;
  SERVICE_ROLE_KEY: string;
}

function localEnvironment(): LocalEnvironment {
  const output = execFileSync("supabase", ["status", "-o", "json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const parsed = JSON.parse(output) as Partial<LocalEnvironment>;
  assert.ok(parsed.API_URL && parsed.ANON_KEY && parsed.SERVICE_ROLE_KEY);
  return parsed as LocalEnvironment;
}

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number { return this.map.size; }
  clear(): void { this.map.clear(); }
  key(index: number): string | null { return [...this.map.keys()][index] ?? null; }
  getItem(key: string): string | null { return this.map.get(key) ?? null; }
  setItem(key: string, value: string): void { this.map.set(key, String(value)); }
  removeItem(key: string): void { this.map.delete(key); }
}

function createMemoryLocks(): LockLike {
  const chains = new Map<string, Promise<void>>();
  return async <R>(name: string, acquireTimeout: number, fn: () => Promise<R>): Promise<R> => {
    if (acquireTimeout === 0 && chains.has(name)) throw new Error(`Lock busy: ${name}`);
    const prev = chains.get(name) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => { release = resolve; });
    const tail = prev.then(() => mine);
    chains.set(name, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (chains.get(name) === tail) chains.delete(name);
    }
  };
}

let env: LocalEnvironment;
const createdUserIds: string[] = [];

before(() => {
  env = localEnvironment();
});

after(async () => {
  if (!env || createdUserIds.length === 0) return;
  const admin = createClient(env.API_URL, env.SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  for (const id of createdUserIds) {
    await admin.auth.admin.deleteUser(id).catch(() => undefined);
  }
});

test("multi-account core against real pinned GoTrue: 2 accounts, pinned OTP, refresh isolation, scope=local preserves other devices, PKCE invalid code cleans staging", async () => {
  const admin = createClient(env.API_URL, env.SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const suffix = randomUUID().slice(0, 8);
  const emailA = `multi-acct-a-${suffix}@example.test`;
  const emailB = `multi-acct-b-${suffix}@example.test`;
  const password = `Correct-Horse-${suffix}-99!`;

  const userARes = await admin.auth.admin.createUser({ email: emailA, password, email_confirm: true, user_metadata: { full_name: "Account A" } });
  const userBRes = await admin.auth.admin.createUser({ email: emailB, password, email_confirm: true, user_metadata: { full_name: "Account B" } });
  assert.equal(userARes.error, null);
  assert.equal(userBRes.error, null);
  const userAId = userARes.data.user.id;
  const userBId = userBRes.data.user.id;
  createdUserIds.push(userAId, userBId);

  // Create a separate "other device" session for Account A and Account B directly with GoTrue.
  const otherDeviceSignIn = async (email: string): Promise<string> => {
    const resp = await fetch(`${env.API_URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: env.ANON_KEY, "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    assert.equal(resp.status, 200);
    const data = await resp.json() as { access_token: string };
    return data.access_token;
  };
  const isAccessTokenLive = async (token: string): Promise<boolean> => {
    const resp = await fetch(`${env.API_URL}/auth/v1/user`, {
      method: "GET",
      headers: { apikey: env.ANON_KEY, authorization: `Bearer ${token}` },
    });
    return resp.status === 200;
  };
  const otherDeviceTokenA = await otherDeviceSignIn(emailA);
  const otherDeviceTokenB = await otherDeviceSignIn(emailB);
  assert.equal(await isAccessTokenLive(otherDeviceTokenA), true);
  assert.equal(await isAccessTokenLive(otherDeviceTokenB), true);

  // Set up AccountManager against real GoTrue with BroadcastChannel spy.
  const ls = new MemoryStorage();
  const ss = new MemoryStorage();
  const originHash = deploymentOriginHash(env.API_URL);
  const broadcasts: unknown[] = [];
  const createChannel = (_name: string): BroadcastChannelLike => ({
    postMessage(msg) { broadcasts.push(msg); },
    addEventListener() {},
    removeEventListener() {},
    close() {},
  });

  const mgr = new AccountManager(
    { url: env.API_URL, anonKey: env.ANON_KEY },
    {
      localStorage: ls,
      sessionStorage: ss,
      fetcher: fetch,
      webLocks: createMemoryLocks(),
      createBroadcastChannel: createChannel,
    },
  );
  await mgr.initialize();

  // 1. Sign in Account A via password staging against real GoTrue.
  const promotedA = await mgr.signInWithPasswordStaging({ email: emailA, password });
  assert.equal(promotedA.kind, "promoted");
  assert.equal(promotedA.account.userId, userAId);
  const browserTokenA = mgr.runtimeFor(userAId)!.peekAccessToken()!;
  assert.equal(await isAccessTokenLive(browserTokenA), true);

  // 2. Add Account B via real pinned-email OTP flow (using admin.generateLink email_otp against real GoTrue /verify).
  const otpStart = await mgr.startEmailOtpAttempt({ email: emailB, purpose: "add-account", returnRoute: "/app" });
  const linkRes = await admin.auth.admin.generateLink({ type: "magiclink", email: emailB });
  assert.equal(linkRes.error, null);
  const otpCode = linkRes.data.properties.email_otp;
  assert.ok(otpCode);
  const promotedB = await mgr.verifyEmailOtpAttempt({ attemptId: otpStart.attemptId, token: otpCode });
  assert.equal(promotedB.kind, "promoted");
  assert.equal(promotedB.account.userId, userBId);
  assert.equal(ss.getItem(attemptStorageKey(originHash, otpStart.attemptId)), null, "OTP staging attempt cleared");
  assert.equal(mgr.listAccounts().length, 2);

  // 3. Real SDK refresh on Account A leaves Account B intact and posts 0 credentials on BroadcastChannel.
  const rtA = mgr.runtimeFor(userAId)!;
  const rtB = mgr.runtimeFor(userBId)!;
  await Promise.all([rtA.ready(), rtB.ready()]);
  const tokenBBefore = rtB.peekAccessToken();
  const refreshA = await rtA.client.auth.refreshSession();
  assert.equal(refreshA.error, null);
  assert.ok(refreshA.data.session?.access_token);
  assert.equal(rtB.peekAccessToken(), tokenBBefore, "refreshing Account A leaves Account B untouched");
  for (const msg of broadcasts) {
    const serialized = JSON.stringify(msg);
    assert.equal(serialized.includes("access_token"), false);
    assert.equal(serialized.includes("refresh_token"), false);
  }

  // 4. Real GoTrue PKCE redirect attempt + invalid code refusal cleans staging storage and preserves both accounts.
  const oauth = await mgr.startOAuthAttempt({
    provider: "google",
    purpose: "add-account",
    returnRoute: "/app",
    origin: "https://commonswarm.com",
  });
  assert.ok(ss.getItem(attemptStorageKey(originHash, oauth.attemptId)));
  const u = new URL(`https://commonswarm.com/app?code=bogus-pkce-code&cs_attempt=${oauth.attemptId}`);
  const location: LocationLike = {
    get origin() { return u.origin; },
    get pathname() { return u.pathname; },
    get search() { return u.search; },
    get hash() { return u.hash; },
    get href() { return u.href; },
  };
  const history: HistoryLike = {
    replaceState(_d, _u, next) {
      if (typeof next === "string") {
        const parsed = new URL(next, u.origin);
        u.pathname = parsed.pathname; u.search = parsed.search; u.hash = parsed.hash;
      }
    },
  };
  const pkceFail = await mgr.consumeAuthCallbackBootstrap(location, history);
  assert.equal(pkceFail.kind, "refused");
  assert.equal(pkceFail.reason, "exchange_failed");
  assert.equal(location.search, "", "callback URL scrubbed on failure");
  assert.equal(ss.getItem(attemptStorageKey(originHash, oauth.attemptId)), null, "PKCE attempt cleared on failure");
  assert.equal(mgr.listAccounts().length, 2, "failed Add account preserves both signed-in accounts");

  // 5. Ordinary sign-out of Account A (scope=local) ends ONLY Account A on this device:
  //    Account A's other device stays live on GoTrue, AND Account B stays live here!
  const refreshedTokenA = rtA.peekAccessToken()!;
  const signOutA = await mgr.signOutAccount(userAId, promotedA.account.loginId);
  assert.equal(signOutA.browserSignedOut, true);
  assert.equal(signOutA.remoteRevocation.status, "confirmed");
  assert.equal(signOutA.nextActive?.userId, userBId);
  assert.equal(ls.getItem(slotStorageKey(originHash, promotedA.account.loginId)), null);
  assert.equal(await isAccessTokenLive(refreshedTokenA), false, "this device's Account A session revoked on GoTrue");
  assert.equal(await isAccessTokenLive(otherDeviceTokenA), true, "Account A's other device stays signed in (scope=local)");
  assert.equal(await isAccessTokenLive(rtB.peekAccessToken()!), true, "Account B stays signed in");

  // 6. Sign out all revokes remaining browser session (Account B) with scope=local, preserving Account B's other device!
  const browserTokenB = rtB.peekAccessToken()!;
  const signOutAll = await mgr.signOutAllAccounts();
  assert.equal(signOutAll.browserSignedOut, true);
  assert.equal(signOutAll.remoteRevocations.length, 1);
  assert.equal(signOutAll.remoteRevocations[0]!.result.status, "confirmed");
  assert.equal(await isAccessTokenLive(browserTokenB), false, "this device's Account B session revoked on GoTrue");
  assert.equal(await isAccessTokenLive(otherDeviceTokenB), true, "Account B's other device stays signed in");
  assert.equal(mgr.listAccounts().length, 0);

  mgr.destroy();
});
