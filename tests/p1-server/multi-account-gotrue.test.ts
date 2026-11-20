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
import { createClient, NavigatorLockAcquireTimeoutError } from "@supabase/supabase-js";
import {
  AccountManager,
  attemptStorageKey,
  deploymentOriginHash,
  scrubCallbackUrlImmediate,
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
  INBUCKET_URL?: string;
  MAILPIT_URL?: string;
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
    if (acquireTimeout === 0 && chains.has(name)) {
      throw new NavigatorLockAcquireTimeoutError(`Lock busy: ${name}`);
    }
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

/** Confirmation links from the local mail catcher (Mailpit, or the older Inbucket API). */
async function confirmationLinks(local: LocalEnvironment, address: string): Promise<string[]> {
  const base = local.MAILPIT_URL ?? local.INBUCKET_URL ?? "http://127.0.0.1:54324";
  const links = (html: string) =>
    [...html.matchAll(/href="([^"]*\/auth\/v1\/verify\?[^"]*)"/g)].map((m) => m[1]!.replaceAll("&amp;", "&"));
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const search = await fetch(`${base}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}`).catch(() => null);
    if (search?.ok) {
      const found = await search.json() as { messages?: Array<{ ID: string }> };
      const bodies = await Promise.all((found.messages ?? []).map(async (m) =>
        ((await (await fetch(`${base}/api/v1/message/${m.ID}`)).json()) as { HTML?: string }).HTML ?? ""));
      const all = bodies.flatMap(links);
      if (all.length > 0) return all;
    } else {
      const mailbox = address.split("@")[0]!;
      const list = await fetch(`${base}/api/v1/mailbox/${mailbox}`).catch(() => null);
      if (list?.ok) {
        const messages = await list.json() as Array<{ id: string }>;
        const bodies = await Promise.all(messages.map(async (m) =>
          ((await (await fetch(`${base}/api/v1/mailbox/${mailbox}/${m.id}`)).json()) as { body?: { html?: string } }).body?.html ?? ""));
        const all = bodies.flatMap(links);
        if (all.length > 0) return all;
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no confirmation link reached ${address}`);
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
  const emailC = `multi-acct-c-${suffix}@example.test`;
  const password = `Correct-Horse-${suffix}-99!`;

  const userARes = await admin.auth.admin.createUser({ email: emailA, password, email_confirm: true, user_metadata: { full_name: "Account A" } });
  const userBRes = await admin.auth.admin.createUser({ email: emailB, password, email_confirm: true, user_metadata: { full_name: "Account B" } });
  const userCRes = await admin.auth.admin.createUser({ email: emailC, password, email_confirm: true, user_metadata: { full_name: "Account C" } });
  assert.equal(userARes.error, null);
  assert.equal(userBRes.error, null);
  assert.equal(userCRes.error, null);
  const userAId = userARes.data.user.id;
  const userBId = userBRes.data.user.id;
  const userCId = userCRes.data.user.id;
  createdUserIds.push(userAId, userBId, userCId);

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
  const oauthInvalid = await mgr.startOAuthAttempt({
    provider: "google",
    purpose: "add-account",
    returnRoute: "/app",
    origin: "http://127.0.0.1:3000",
  });
  assert.ok(ss.getItem(attemptStorageKey(originHash, oauthInvalid.attemptId)));
  const makeNav = (href: string): { location: LocationLike; history: HistoryLike } => {
    const u = new URL(href);
    return {
      location: {
        get origin() { return u.origin; },
        get pathname() { return u.pathname; },
        get search() { return u.search; },
        get hash() { return u.hash; },
        get href() { return u.href; },
      },
      history: {
        replaceState(_d, _u, next) {
          if (typeof next === "string") {
            const parsed = new URL(next, u.origin);
            u.pathname = parsed.pathname; u.search = parsed.search; u.hash = parsed.hash;
          }
        },
      },
    };
  };
  const invalidNav = makeNav(`http://127.0.0.1:3000/app?code=bogus-pkce-code&cs_attempt=${oauthInvalid.attemptId}`);
  const pkceFail = await mgr.consumeAuthCallbackBootstrap(invalidNav.location, invalidNav.history);
  assert.equal(pkceFail.kind, "refused");
  assert.equal(pkceFail.reason, "exchange_failed");
  assert.equal(invalidNav.location.search, "", "callback URL scrubbed on failure");
  assert.equal(ss.getItem(attemptStorageKey(originHash, oauthInvalid.attemptId)), null, "PKCE attempt cleared on failure");
  assert.equal(mgr.listAccounts().length, 2, "failed Add account preserves both signed-in accounts");

  // 4b. Real pinned GoTrue SUCCESSFUL S256 PKCE round-trip:
  //     startOAuthAttempt (S256 challenge) -> GoTrue PKCE /otp + Mailpit verify redirect -> full-page reload
  //     AccountManager -> consumeAuthCallbackBootstrap -> real POST /auth/v1/token?grant_type=pkce -> promoted!
  const oauthLive = await mgr.startOAuthAttempt({
    provider: "google",
    purpose: "add-account",
    returnRoute: "/app",
    origin: "http://127.0.0.1:3000",
  });
  const oauthAuthorize = new URL(oauthLive.authorizeUrl);
  const liveChallenge = oauthAuthorize.searchParams.get("code_challenge")!;
  const liveRedirectTo = oauthAuthorize.searchParams.get("redirect_to")!;
  assert.ok(liveChallenge && liveRedirectTo.includes(`cs_attempt=${oauthLive.attemptId}`));
  const pkceOtpResp = await fetch(
    `${env.API_URL}/auth/v1/otp?redirect_to=${encodeURIComponent(liveRedirectTo)}`,
    {
      method: "POST",
      headers: { apikey: env.ANON_KEY, "content-type": "application/json" },
      body: JSON.stringify({
        email: emailC,
        data: {},
        create_user: false,
        code_challenge: liveChallenge,
        code_challenge_method: "s256",
      }),
    },
  );
  assert.equal(pkceOtpResp.status, 200, await pkceOtpResp.text());
  const verifyLinks = await confirmationLinks(env, emailC);
  const verifyResp = await fetch(verifyLinks.at(-1)!, { redirect: "manual" });
  const redirectLocation = verifyResp.headers.get("location");
  assert.ok(redirectLocation, "GoTrue verify must redirect back with real PKCE code");
  const parsedRedirect = new URL(redirectLocation);
  assert.ok(parsedRedirect.searchParams.get("code"), "GoTrue redirect must contain real PKCE auth code");
  assert.equal(parsedRedirect.searchParams.get("cs_attempt"), oauthLive.attemptId);

  // Simulate full-page reload after redirect (destroy old manager, create fresh AccountManager on same ls+ss).
  const refreshedTokenA = rtA.peekAccessToken()!;
  mgr.destroy();
  const reloaded = new AccountManager(
    { url: env.API_URL, anonKey: env.ANON_KEY },
    {
      localStorage: ls,
      sessionStorage: ss,
      fetcher: fetch,
      webLocks: createMemoryLocks(),
      createBroadcastChannel: createChannel,
    },
  );
  await reloaded.initialize();
  const liveNav = makeNav(redirectLocation);
  const pkcePromoted = await reloaded.consumeAuthCallbackBootstrap(liveNav.location, liveNav.history);
  assert.equal(pkcePromoted.kind, "promoted", "real GoTrue S256 PKCE code exchange must promote Account C");
  assert.equal(pkcePromoted.account.userId, userCId);
  assert.equal(liveNav.location.search, "", "callback URL scrubbed on real PKCE success");
  assert.equal(ss.getItem(attemptStorageKey(originHash, oauthLive.attemptId)), null, "PKCE attempt erased after promotion");
  assert.equal(reloaded.listAccounts().length, 3);
  const browserTokenC = reloaded.runtimeFor(userCId)!.peekAccessToken()!;
  assert.equal(await isAccessTokenLive(browserTokenC), true, "Account C real PKCE session is live on GoTrue");

  // 5. Ordinary sign-out of Account A (scope=local) ends ONLY Account A on this device:
  //    Account A's other device stays live on GoTrue, AND Account B + C stay live here!
  const signOutA = await reloaded.signOutAccount(userAId, promotedA.account.loginId);
  assert.equal(signOutA.browserSignedOut, true);
  assert.equal(signOutA.remoteRevocation.status, "confirmed");
  assert.equal(ls.getItem(slotStorageKey(originHash, promotedA.account.loginId)), null);
  assert.equal(await isAccessTokenLive(refreshedTokenA), false, "this device's Account A session revoked on GoTrue");
  assert.equal(await isAccessTokenLive(otherDeviceTokenA), true, "Account A's other device stays signed in (scope=local)");
  assert.equal(await isAccessTokenLive(reloaded.runtimeFor(userBId)!.peekAccessToken()!), true, "Account B stays signed in");
  assert.equal(await isAccessTokenLive(browserTokenC), true, "Account C stays signed in");

  // 6. Sign out all revokes remaining browser sessions (Account B + C) with scope=local, preserving other devices!
  const browserTokenB = reloaded.runtimeFor(userBId)!.peekAccessToken()!;
  const signOutAll = await reloaded.signOutAllAccounts();
  assert.equal(signOutAll.browserSignedOut, true);
  assert.equal(signOutAll.remoteRevocations.length, 2);
  assert.ok(signOutAll.remoteRevocations.every((r) => r.result.status === "confirmed"));
  assert.equal(await isAccessTokenLive(browserTokenB), false, "this device's Account B session revoked on GoTrue");
  assert.equal(await isAccessTokenLive(browserTokenC), false, "this device's Account C session revoked on GoTrue");
  assert.equal(await isAccessTokenLive(otherDeviceTokenB), true, "Account B's other device stays signed in");
  assert.equal(reloaded.listAccounts().length, 0);

  reloaded.destroy();
});

test("PR 2 HezSec C6 witness against real pinned GoTrue: /invite?resume= S256 PKCE redirect, pre-init scrub, provider_token stripping, and peer sign-out fallback", async () => {
  const admin = createClient(env.API_URL, env.SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const suffix = randomUUID().slice(0, 8);
  const emailA = `multi-c6-a-${suffix}@example.test`;
  const emailB = `multi-c6-b-${suffix}@example.test`;
  const password = `Correct-Horse-${suffix}-C6!`;

  const userARes = await admin.auth.admin.createUser({ email: emailA, password, email_confirm: true, user_metadata: { full_name: "C6 User A" } });
  const userBRes = await admin.auth.admin.createUser({ email: emailB, password, email_confirm: true, user_metadata: { full_name: "C6 User B" } });
  assert.equal(userARes.error, null);
  assert.equal(userBRes.error, null);
  const userAId = userARes.data.user.id;
  const userBId = userBRes.data.user.id;
  createdUserIds.push(userAId, userBId);

  const ls = new MemoryStorage();
  const ss = new MemoryStorage();
  const locks = createMemoryLocks();
  const originHash = deploymentOriginHash(env.API_URL);
  const noopCh = (): BroadcastChannelLike => ({
    postMessage() {},
    addEventListener() {},
    removeEventListener() {},
    close() {},
  });

  // Wrap real GoTrue fetch to inject a synthetic provider_token into the real GoTrue PKCE token response
  // so we verify stripping on the real pinned GoTrue exchange path!
  const providerTokenWrappedFetch: typeof fetch = async (input, init) => {
    const resp = await fetch(input, init);
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (u.pathname.endsWith("/auth/v1/token") && u.searchParams.get("grant_type") === "pkce" && resp.ok) {
      const json = await resp.json() as Record<string, unknown>;
      json.provider_token = "synthetic-provider-secret-must-strip";
      json.provider_refresh_token = "synthetic-provider-refresh-must-strip";
      return Response.json(json, { status: resp.status });
    }
    return resp;
  };

  const tabBefore = new AccountManager(
    { url: env.API_URL, anonKey: env.ANON_KEY },
    { localStorage: ls, sessionStorage: ss, fetcher: fetch, webLocks: locks, createBroadcastChannel: noopCh },
  );
  await tabBefore.initialize();
  const firstB = await tabBefore.signInWithPasswordStaging({ email: emailB, password });
  assert.equal(firstB.kind, "promoted");

  // Start /invite?resume= S256 PKCE attempt against real GoTrue!
  const inviteAttempt = await tabBefore.startOAuthAttempt({
    provider: "google",
    purpose: "add-account",
    returnRoute: "/invite",
    origin: "http://127.0.0.1:3000",
    resume: "invite_res_gotrue_1",
  });
  const authUrl = new URL(inviteAttempt.authorizeUrl);
  const redirectTo = authUrl.searchParams.get("redirect_to")!;
  const challenge = authUrl.searchParams.get("code_challenge")!;
  assert.equal(new URL(redirectTo).pathname, "/invite");
  assert.equal(new URL(redirectTo).searchParams.get("resume"), "invite_res_gotrue_1");

  // Drive real pinned GoTrue S256 PKCE code issuance via /auth/v1/otp -> Mailpit -> /auth/v1/verify 302 redirect!
  const otpResp = await fetch(
    `${env.API_URL}/auth/v1/otp?redirect_to=${encodeURIComponent(redirectTo)}`,
    {
      method: "POST",
      headers: { apikey: env.ANON_KEY, "content-type": "application/json" },
      body: JSON.stringify({
        email: emailA,
        data: {},
        create_user: false,
        code_challenge: challenge,
        code_challenge_method: "s256",
      }),
    },
  );
  assert.equal(otpResp.status, 200, await otpResp.text());
  const verifyLinks = await confirmationLinks(env, emailA);
  const verifyResp = await fetch(verifyLinks.at(-1)!, { redirect: "manual" });
  const finalLocation = verifyResp.headers.get("location");
  assert.ok(finalLocation, "real GoTrue must redirect back to /invite with ?resume=, cs_attempt, and code");
  const finalUrl = new URL(finalLocation);
  assert.equal(finalUrl.pathname, "/invite");
  assert.equal(finalUrl.searchParams.get("resume"), "invite_res_gotrue_1");
  assert.equal(finalUrl.searchParams.get("cs_attempt"), inviteAttempt.attemptId);
  assert.ok(finalUrl.searchParams.get("code"));

  // Reload tab -> scrub URL SYNCHRONOUSLY BEFORE initialize(), then exchange real GoTrue PKCE code!
  tabBefore.destroy();
  const navUrl = new URL(finalLocation);
  const navLocation: LocationLike = {
    get origin() { return navUrl.origin; },
    get pathname() { return navUrl.pathname; },
    get search() { return navUrl.search; },
    get hash() { return navUrl.hash; },
    get href() { return navUrl.href; },
  };
  const navHistory: HistoryLike = {
    replaceState(_d, _u, next) {
      if (next) {
        const parsed = new URL(String(next), navUrl.origin);
        navUrl.pathname = parsed.pathname;
        navUrl.search = parsed.search;
        navUrl.hash = parsed.hash;
      }
    },
  };
  const preScrubbed = scrubCallbackUrlImmediate(navLocation, navHistory);
  assert.equal(preScrubbed.scrubbed, true);
  assert.equal(navLocation.search, "?resume=invite_res_gotrue_1", "URL scrubbed synchronously BEFORE initialize() while keeping ?resume=");

  const teardowns: Array<{ reason: string; userId?: string; loginId?: string }> = [];
  const tabAfter = new AccountManager(
    { url: env.API_URL, anonKey: env.ANON_KEY },
    {
      localStorage: ls,
      sessionStorage: ss,
      fetcher: providerTokenWrappedFetch,
      webLocks: locks,
      createBroadcastChannel: noopCh,
      onForcedTeardown: (d) => teardowns.push(d),
    },
  );
  await tabAfter.initialize();
  const promotedA = await tabAfter.consumeAuthCallbackBootstrap(navLocation, navHistory, preScrubbed);
  assert.equal(promotedA.kind, "promoted");
  assert.equal(promotedA.account.userId, userAId);
  const slotA = ls.getItem(slotStorageKey(originHash, promotedA.account.loginId)) ?? "";
  assert.equal(slotA.includes("synthetic-provider-secret-must-strip"), false, "provider_token stripped before storage write");
  assert.equal(slotA.includes("synthetic-provider-refresh-must-strip"), false, "provider_refresh_token stripped before storage write");

  // Peer Tab 2 signs out Account A on real GoTrue -> Tab 1 triggers forced teardown for A before activating fallback B!
  const peerTab = new AccountManager(
    { url: env.API_URL, anonKey: env.ANON_KEY },
    { localStorage: ls, sessionStorage: new MemoryStorage(), fetcher: fetch, webLocks: locks, createBroadcastChannel: noopCh },
  );
  await peerTab.initialize();
  await peerTab.signOutAccount(userAId, promotedA.account.loginId);
  const fallback = tabAfter.activeAccount();
  assert.equal(teardowns.length, 1, "forced teardown fires for departed Account A before fallback activates");
  assert.equal(teardowns[0]!.userId, userAId);
  assert.equal(fallback?.userId, userBId);
  const verifiedB = await tabAfter.runtimeFor(userBId)!.verifySession();
  assert.equal(verifiedB?.user.id, userBId, "fallback Account B verifies live on real GoTrue for fresh invite confirmation");

  await peerTab.signOutAllAccounts();
  tabAfter.destroy();
  peerTab.destroy();
});
