import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { NavigatorLockAcquireTimeoutError } from "@supabase/supabase-js";
import {
  AccountManager,
  InactiveAccountBadgePoller,
  MULTI_ACCOUNT_ENABLED,
  MultiAccountAuthRecoveryRequired,
  MultiAccountWorkspaceMismatch,
  accountsStorageKey,
  attemptStorageKey,
  deploymentOriginHash,
  isMultiAccountEnabled,
  legacyStorageKey,
  postPinnedCommand,
  scrubCallbackUrlImmediate,
  setMultiAccountEnabledForTesting,
  slotStorageKey,
  type BroadcastChannelLike,
  type HistoryLike,
  type LocationLike,
  type LockLike,
} from "../src/lib/multi-account.ts";
import { completePasswordChange } from "../src/lib/password-change-completion.ts";
import {
  AuthRecoveryRequired,
  accountManager,
  configureMultiAccountForTesting,
  onAuthChange,
  pinAccountContext,
  postBrowserSignal,
  prepareBrowserAttachments,
  resetAccountManagerForTesting,
  signInWithProvider,
  signOutActiveAccount,
  uploadBrowserAttachment,
} from "../src/lib/commonswarm.ts";
import { createHomeServer, HomeCommandRefused } from "../src/lib/home/client.ts";
import { overviewNeedsYouTotal } from "../src/lib/home-map.ts";

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number { return this.map.size; }
  clear(): void { this.map.clear(); }
  key(index: number): string | null { return [...this.map.keys()][index] ?? null; }
  getItem(key: string): string | null { return this.map.get(key) ?? null; }
  setItem(key: string, value: string): void { this.map.set(key, String(value)); }
  removeItem(key: string): void { this.map.delete(key); }
}

function createLocks(): LockLike {
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

function makeJwt(url: string, userId: string, email: string, sid: string): string {
  const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return [
    b64({ alg: "ES256", typ: "JWT" }),
    b64({
      aud: "authenticated",
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
      iss: `${url}/auth/v1`,
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
    app_metadata: { provider: "google", providers: ["google", "email"] },
    user_metadata: { full_name: name },
    identities: [],
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
    is_anonymous: false,
  };
}

function makeLocation(href: string): { location: LocationLike; history: HistoryLike } {
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
      replaceState(_d, _u, nextUrl) {
        if (typeof nextUrl === "string") {
          const updated = new URL(nextUrl, u.origin);
          u.pathname = updated.pathname;
          u.search = updated.search;
          u.hash = updated.hash;
        }
      },
    },
  };
}

const noopChannel = (_name: string): BroadcastChannelLike => ({
  postMessage() {},
  addEventListener() {},
  removeEventListener() {},
  close() {},
});

test("PR 2 keeps MULTI_ACCOUNT_ENABLED = false until HezSec, Designer, and Lead pass; verifies ingress & route bootstrap wiring", () => {
  assert.equal(MULTI_ACCOUNT_ENABLED, false);
  assert.equal(isMultiAccountEnabled(), false);

  // Ingress query-log hygiene: static site Caddyfile serves /app and /invite with zero HTTP access log directives.
  const caddy = readFileSync(new URL("../../deploy/site/commonswarm-site.caddy", import.meta.url), "utf8");
  assert.doesNotMatch(caddy, /^\s*log\b/m, "Caddyfile must not log raw callback query strings");

  // All account-sensitive routes wire the shared multi-account bootstrap/auth/teardown primitives.
  const liveDash = readFileSync(new URL("../src/components/app/LiveDashboard.astro", import.meta.url), "utf8");
  const inviteOnramp = readFileSync(new URL("../src/components/invite/InviteOnramp.astro", import.meta.url), "utf8");
  const adminDel = readFileSync(new URL("../src/components/app/AdminDelegations.astro", import.meta.url), "utf8");
  const humanInbox = readFileSync(new URL("../src/components/invite/HumanInvitationInbox.astro", import.meta.url), "utf8");
  const agentConnect = readFileSync(new URL("../src/components/connect/AgentConnect.astro", import.meta.url), "utf8");

  assert.match(liveDash, /bootstrapMultiAccountAuth\(window\.location, window\.history\)/);
  assert.match(liveDash, /onAccountForcedTeardown\(/);
  assert.match(liveDash, /Sign out on this device/);
  assert.match(liveDash, /Sign out all accounts on this device/);
  assert.match(inviteOnramp, /bootstrapMultiAccountAuth\(window\.location, window\.history\)/);
  assert.match(inviteOnramp, /onAccountForcedTeardown\(/);
  assert.match(adminDel, /bootstrapMultiAccountAuth\(/);
  assert.match(adminDel, /onAccountForcedTeardown\(/);
  assert.match(humanInbox, /onAuthChange\(/);
  assert.match(humanInbox, /onAccountForcedTeardown\(/);
  assert.match(agentConnect, /onAccountForcedTeardown\(/);
  assert.match(agentConnect, /pinAccountContext\(/);
});

test("PR 2 C2 create_workspace envelope: sends payload workspace_id with NO top-level workspace_id/stream and refuses mismatches", async () => {
  const url = "https://example.supabase.co";
  const deployment = { url, anonKey: "public-anon-key" };
  const userA = makeUser("11111111-1111-4111-8111-111111111111", "owner@example.test", "Owner");
  const tokenA = makeJwt(url, userA.id, userA.email, "sid-create");
  const sentBodies: Record<string, unknown>[] = [];

  const fetcher: typeof fetch = async (input, init) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (u.pathname.endsWith("/auth/v1/token") && u.searchParams.get("grant_type") === "password") {
      return Response.json({
        access_token: tokenA,
        refresh_token: "rt-create-1",
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        token_type: "bearer",
        user: userA,
      });
    }
    if (u.pathname.endsWith("/auth/v1/user")) {
      return Response.json(userA);
    }
    if (u.pathname.endsWith("/functions/v1/command")) {
      sentBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return Response.json({ status: "accepted", workspace_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    }
    throw new Error(`unexpected fetch: ${u.href}`);
  };

  const mgr = new AccountManager(deployment, {
    localStorage: new MemoryStorage(),
    sessionStorage: new MemoryStorage(),
    fetcher,
    webLocks: createLocks(),
    createBroadcastChannel: noopChannel,
  });
  await mgr.initialize();
  const signedIn = await mgr.signInWithPasswordStaging({ email: userA.email, password: "pw" });
  assert.equal(signedIn.kind, "promoted");
  const pinned = mgr.pinContext();
  assert.ok(pinned);

  const newWsId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const otherWsId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  // Valid create_workspace envelope matches supabase/functions/command/index.ts:6560 verbatim!
  const ok = await postPinnedCommand(
    pinned,
    "cmd-create-1",
    { kind: "create_workspace", workspace_id: newWsId, name: "Home" },
    { scope: { kind: "create-workspace", newWorkspaceId: newWsId }, fetcher },
  );
  assert.equal(ok.status, 200);
  assert.equal(sentBodies.length, 1);
  assert.equal(sentBodies[0]!.workspace_id, undefined, "create_workspace must have NO top-level workspace_id");
  assert.equal(sentBodies[0]!.stream, undefined, "create_workspace must have NO top-level stream");
  assert.equal((sentBodies[0]!.command as Record<string, unknown>).kind, "create_workspace");
  assert.equal((sentBodies[0]!.command as Record<string, unknown>).workspace_id, newWsId);

  // Refuses mismatched command.workspace_id, extra top-level workspace_id, extra stream, or wrong command.kind (0 fetches)!
  for (const [cmd, extra] of [
    [{ kind: "create_workspace", workspace_id: otherWsId, name: "Wrong" }, {}],
    [{ kind: "create_workspace", workspace_id: newWsId, name: "Sneak" }, { workspace_id: newWsId }],
    [{ kind: "create_workspace", workspace_id: newWsId, name: "Stream" }, { stream: { kind: "workspace" } }],
    [{ kind: "household_tool", workspace_id: newWsId }, {}],
  ] as const) {
    await assert.rejects(
      postPinnedCommand(pinned, "cmd-bad", { ...cmd }, {
        scope: { kind: "create-workspace", newWorkspaceId: newWsId },
        extra: { ...extra },
        fetcher,
      }),
      { name: "WorkspaceMismatch" },
    );
  }
  assert.equal(sentBodies.length, 1, "all invalid create_workspace envelopes sent 0 requests");
  mgr.destroy();
});

test("PR 2 C1 real HTTP mock-provider OAuth redirect round-trip: authorize -> mock IdP -> callback reload -> S256 PKCE exchange -> promotion", async () => {
  const userA = makeUser("11111111-1111-4111-8111-111111111111", "first@example.test", "First Owner");
  const userB = makeUser("22222222-2222-4222-8222-222222222222", "second@example.test", "Second Owner");
  const pendingAuth = new Map<string, { redirectTo: string; challenge: string }>();
  const pendingPkce = new Map<string, { challenge: string; user: typeof userB }>();
  const liveSessions = new Map<string, typeof userA>();

  let baseUrl = "";
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const u = new URL(req.url ?? "/", baseUrl);
    if (req.method === "GET" && u.pathname === "/auth/v1/authorize") {
      assert.equal(u.searchParams.get("provider"), "google");
      assert.equal(u.searchParams.get("code_challenge_method"), "s256");
      assert.equal(u.searchParams.get("prompt"), "select_account");
      const challenge = u.searchParams.get("code_challenge")!;
      const redirectTo = u.searchParams.get("redirect_to")!;
      const state = "oauth-state-1";
      pendingAuth.set(state, { redirectTo, challenge });
      res.writeHead(302, { location: `${baseUrl}/mock-idp/authorize?state=${state}` });
      res.end();
      return;
    }
    if (req.method === "GET" && u.pathname === "/mock-idp/authorize") {
      const state = u.searchParams.get("state")!;
      res.writeHead(302, { location: `${baseUrl}/auth/v1/callback?idp_code=idp-ok&state=${state}` });
      res.end();
      return;
    }
    if (req.method === "GET" && u.pathname === "/auth/v1/callback") {
      const state = u.searchParams.get("state")!;
      const entry = pendingAuth.get(state);
      assert.ok(entry);
      pendingAuth.delete(state);
      const authCode = "real-pkce-code-789";
      pendingPkce.set(authCode, { challenge: entry.challenge, user: userB });
      const back = new URL(entry.redirectTo);
      back.searchParams.set("code", authCode);
      res.writeHead(302, { location: back.href });
      res.end();
      return;
    }
    if (req.method === "POST" && u.pathname === "/auth/v1/token") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, string>;
      if (u.searchParams.get("grant_type") === "password") {
        const at = makeJwt(baseUrl, userA.id, userA.email, "sid-a");
        liveSessions.set(at, userA);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          access_token: at, refresh_token: "rt-a-1", expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: "bearer", user: userA,
        }));
        return;
      }
      if (u.searchParams.get("grant_type") === "pkce") {
        const pending = pendingPkce.get(body.auth_code ?? "");
        if (!pending) { res.writeHead(400); res.end("{}"); return; }
        const computed = createHash("sha256").update(body.code_verifier ?? "").digest("base64url");
        if (computed !== pending.challenge) { res.writeHead(400); res.end("{}"); return; }
        pendingPkce.delete(body.auth_code!);
        const at = makeJwt(baseUrl, pending.user.id, pending.user.email, "sid-b");
        liveSessions.set(at, pending.user);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          access_token: at, refresh_token: "rt-b-1", expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: "bearer", user: pending.user,
          provider_token: "google-secret-must-strip",
        }));
        return;
      }
    }
    if (req.method === "GET" && u.pathname === "/auth/v1/user") {
      const bearer = (req.headers.authorization ?? "").replace(/^Bearer /i, "");
      const user = liveSessions.get(bearer);
      if (!user) { res.writeHead(403); res.end("{}"); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(user));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;

  try {
    const deployment = { url: baseUrl, anonKey: "public-anon-key" };
    const ls = new MemoryStorage();
    const ss = new MemoryStorage();
    const locks = createLocks();

    const tabBefore = new AccountManager(deployment, {
      localStorage: ls, sessionStorage: ss, fetcher: fetch, webLocks: locks, createBroadcastChannel: noopChannel,
    });
    await tabBefore.initialize();
    const first = await tabBefore.signInWithPasswordStaging({ email: userA.email, password: "pw" });
    assert.equal(first.kind, "promoted");

    // Start OAuth Add account -> follow REAL HTTP redirect chain: authorize -> mock IdP -> GoTrue callback -> /app!
    const { attemptId, authorizeUrl } = await tabBefore.startOAuthAttempt({
      provider: "google", purpose: "add-account", returnRoute: "/app", origin: baseUrl,
    });
    const hop1 = await fetch(authorizeUrl, { redirect: "manual" });
    assert.equal(hop1.status, 302);
    const hop2 = await fetch(hop1.headers.get("location")!, { redirect: "manual" });
    assert.equal(hop2.status, 302);
    const hop3 = await fetch(hop2.headers.get("location")!, { redirect: "manual" });
    assert.equal(hop3.status, 302);
    const finalAppUrl = hop3.headers.get("location")!;
    assert.ok(finalAppUrl.includes(`cs_attempt=${attemptId}`) && finalAppUrl.includes("code=real-pkce-code-789"));

    // Simulate full-page reload on /app after redirect!
    tabBefore.destroy();
    const tabAfter = new AccountManager(deployment, {
      localStorage: ls, sessionStorage: ss, fetcher: fetch, webLocks: locks, createBroadcastChannel: noopChannel,
    });
    await tabAfter.initialize();
    const nav = makeLocation(finalAppUrl);
    const result = await tabAfter.consumeAuthCallbackBootstrap(nav.location, nav.history);

    assert.equal(result.kind, "promoted");
    assert.equal(result.account.userId, userB.id);
    assert.equal(result.purpose, "add-account");
    assert.equal(nav.location.search, "", "callback query scrubbed immediately");
    assert.equal(tabAfter.listAccounts().length, 2, "both accounts signed in simultaneously");
    const slotB = ls.getItem(slotStorageKey(deploymentOriginHash(baseUrl), result.account.loginId)) ?? "";
    assert.equal(slotB.includes("google-secret-must-strip"), false, "provider_token stripped before write");
    tabAfter.destroy();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("PR 2 active-only Realtime companion: InactiveAccountBadgePoller polls only inactive verified accounts, pauses while hidden, and clears on sign-out/expiry", async () => {
  const url = "https://example.supabase.co";
  const deployment = { url, anonKey: "public-anon-key" };
  const userA = makeUser("11111111-1111-4111-8111-111111111111", "first@example.test", "First");
  const userB = makeUser("22222222-2222-4222-8222-222222222222", "second@example.test", "Second");
  const live = new Map<string, typeof userA>();

  const fetcher: typeof fetch = async (input, init) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (u.pathname.endsWith("/auth/v1/token") && u.searchParams.get("grant_type") === "password") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { email?: string };
      const who = body.email === userB.email ? userB : userA;
      const at = makeJwt(url, who.id, who.email, `sid-${who.id.slice(0, 4)}-${live.size}`);
      live.set(at, who);
      return Response.json({
        access_token: at, refresh_token: `rt-${live.size}`, expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: "bearer", user: who,
      });
    }
    if (u.pathname.endsWith("/auth/v1/user")) {
      const bearer = (new Headers(init?.headers).get("authorization") ?? "").replace(/^Bearer /i, "");
      const who = live.get(bearer);
      if (!who) return Response.json({ code: "session_not_found" }, { status: 403 });
      return Response.json(who);
    }
    if (u.pathname.endsWith("/auth/v1/logout")) {
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected fetch: ${u.href}`);
  };

  const mgr = new AccountManager(deployment, {
    localStorage: new MemoryStorage(),
    sessionStorage: new MemoryStorage(),
    fetcher,
    webLocks: createLocks(),
    createBroadcastChannel: noopChannel,
  });
  await mgr.initialize();
  const a = await mgr.signInWithPasswordStaging({ email: userA.email, password: "pw" });
  const b = await mgr.signInWithPasswordStaging({ email: userB.email, password: "pw" });
  assert.equal(a.kind, "promoted");
  assert.equal(b.kind, "promoted");
  // Make A active, B inactive!
  mgr.switchActiveAccount(a.account.userId);

  let hidden = false;
  const polledUserIds: string[] = [];
  const poller = new InactiveAccountBadgePoller(
    mgr,
    async (rt) => {
      polledUserIds.push(rt.userId);
      return rt.userId === userB.id ? 4 : 99;
    },
    { isHidden: () => hidden },
  );

  await poller.pollOnce();
  assert.deepEqual(polledUserIds, [userB.id], "must poll ONLY inactive account B (never active account A)");
  assert.equal(poller.waitingCount(userB.id, b.account.loginId), 4);
  assert.equal(poller.waitingCount(userA.id, a.account.loginId), null);

  // Pauses completely while hidden.
  hidden = true;
  await poller.pollOnce();
  assert.equal(polledUserIds.length, 1, "0 polls while tab is hidden");

  // Sign out B -> badge cleared immediately!
  hidden = false;
  await mgr.signOutAccount(userB.id, b.account.loginId);
  poller.prune();
  assert.equal(poller.waitingCount(userB.id, b.account.loginId), null, "signed-out account badge cleared immediately");

  poller.stop();
  mgr.destroy();
});

test("PR 2 password-change-completion removes ONLY the changed account's local login while keeping other accounts signed in", async () => {
  const removed: Array<{ userId: string; loginId: string }> = [];
  const outcome = await completePasswordChange(
    { userId: "user-a", loginId: "login-a-1", accessToken: "tok-a" },
    {
      signOutEverywhere: async () => undefined,
      verifyCurrent: async () => ({ kind: "expired" }),
      live: () => true,
      removeLocalLogin: async (userId, loginId) => { removed.push({ userId, loginId }); },
    },
  );
  assert.equal(outcome.kind, "signed-out");
  assert.deepEqual(removed, [{ userId: "user-a", loginId: "login-a-1" }]);
  setMultiAccountEnabledForTesting(null);
});

test("PR 2 Lead fix (1): /invite OAuth preserves allowlisted ?resume= across authorize & callback scrub, refuses invalid resume, and strips on /app", async () => {
  const url = "https://example.supabase.co";
  const deployment = { url, anonKey: "public-anon-key" };
  const userA = makeUser("11111111-1111-4111-8111-111111111111", "invitee@example.test", "Invitee");
  const live = new Map<string, typeof userA>();

  const fetcher: typeof fetch = async (input, init) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (u.pathname.endsWith("/auth/v1/token") && u.searchParams.get("grant_type") === "pkce") {
      const at = makeJwt(url, userA.id, userA.email, "sid-inv-1");
      live.set(at, userA);
      return Response.json({
        access_token: at, refresh_token: "rt-inv-1", expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: "bearer", user: userA,
      });
    }
    if (u.pathname.endsWith("/auth/v1/user")) {
      const bearer = (new Headers(init?.headers).get("authorization") ?? "").replace(/^Bearer /i, "");
      const who = live.get(bearer);
      if (!who) return Response.json({ code: "session_not_found" }, { status: 403 });
      return Response.json(who);
    }
    throw new Error(`unexpected fetch: ${u.href}`);
  };

  const ls = new MemoryStorage();
  const ss = new MemoryStorage();
  const mgr = new AccountManager(deployment, {
    localStorage: ls, sessionStorage: ss, fetcher, webLocks: createLocks(), createBroadcastChannel: noopChannel,
  });
  await mgr.initialize();

  const { attemptId, authorizeUrl } = await mgr.startOAuthAttempt({
    provider: "google",
    purpose: "signed-out",
    returnRoute: "/invite",
    origin: "https://commonswarm.com",
    resume: "resume_abc-123",
  });
  const redirectTo = new URL(new URL(authorizeUrl).searchParams.get("redirect_to")!);
  assert.equal(redirectTo.pathname, "/invite");
  assert.equal(redirectTo.searchParams.get("resume"), "resume_abc-123");
  assert.equal(redirectTo.searchParams.get("cs_attempt"), attemptId);

  // Callback scrub preserves ?resume= while stripping code & cs_attempt!
  redirectTo.searchParams.set("code", "pkce-code-ok");
  const nav = makeLocation(redirectTo.href);
  const res = await mgr.consumeAuthCallbackBootstrap(nav.location, nav.history);
  assert.equal(res.kind, "promoted");
  assert.equal(nav.location.search, "?resume=resume_abc-123", "resume preserved while auth params scrubbed");

  // Non-/invite routes never carry ?resume=; invalid characters refused on /invite.
  const appStart = await mgr.startOAuthAttempt({
    provider: "google",
    purpose: "add-account",
    returnRoute: "/app",
    origin: "https://commonswarm.com",
    resume: "ignored_on_app",
  });
  const appRedirect = new URL(new URL(appStart.authorizeUrl).searchParams.get("redirect_to")!);
  assert.equal(appRedirect.searchParams.get("resume"), null);
  await assert.rejects(
    () => mgr.startOAuthAttempt({
      provider: "google",
      purpose: "signed-out",
      returnRoute: "/invite",
      origin: "https://commonswarm.com",
      resume: "bad value/../../x",
    }),
    /Invalid invitation resume token/,
  );

  mgr.destroy();
});

test("PR 2 Lead fix (3): account-routed-workspace allows Connected Apps / Your Agents targeting non-active workspace W2 while failing closed on account switch & workspace mismatch", async () => {
  const url = "https://example.supabase.co";
  const deployment = { url, anonKey: "public-anon-key" };
  const userA = makeUser("11111111-1111-4111-8111-111111111111", "owner@example.test", "Owner");
  const userB = makeUser("22222222-2222-4222-8222-222222222222", "other@example.test", "Other");
  const live = new Map<string, typeof userA>();
  const sentBodies: Record<string, unknown>[] = [];

  const fetcher: typeof fetch = async (input, init) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (u.pathname.endsWith("/auth/v1/token") && u.searchParams.get("grant_type") === "password") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { email?: string };
      const who = body.email === userB.email ? userB : userA;
      const at = makeJwt(url, who.id, who.email, `sid-${who.id.slice(0, 4)}-${live.size}`);
      live.set(at, who);
      return Response.json({
        access_token: at, refresh_token: `rt-${live.size}`, expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: "bearer", user: who,
      });
    }
    if (u.pathname.endsWith("/auth/v1/user")) {
      const bearer = (new Headers(init?.headers).get("authorization") ?? "").replace(/^Bearer /i, "");
      const who = live.get(bearer);
      if (!who) return Response.json({ code: "session_not_found" }, { status: 403 });
      return Response.json(who);
    }
    if (u.pathname.endsWith("/functions/v1/command")) {
      sentBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return Response.json({ status: "accepted", ok: true });
    }
    throw new Error(`unexpected fetch: ${u.href}`);
  };

  const mgr = new AccountManager(deployment, {
    localStorage: new MemoryStorage(),
    sessionStorage: new MemoryStorage(),
    fetcher,
    webLocks: createLocks(),
    createBroadcastChannel: noopChannel,
  });
  await mgr.initialize();
  await mgr.signInWithPasswordStaging({ email: userA.email, password: "pw" });
  await mgr.signInWithPasswordStaging({ email: userB.email, password: "pw" });
  mgr.switchActiveAccount(userA.id);
  // Active rail workspace is W1, while account-wide Connected Apps targets W2!
  mgr.setActiveWorkspace("ws-active-1");
  const pinnedA = mgr.pinContext({ userId: userA.id });
  assert.ok(pinnedA);

  const res = await postPinnedCommand(
    pinnedA,
    "cmd-revoke-seat-1",
    { kind: "revoke_hosted_mcp_seat", grant_id: "g-1", seat_id: "s-1" },
    {
      scope: { kind: "account-routed-workspace", workspaceId: "ws-other-2" },
      extra: { workspace_id: "ws-other-2", stream: { kind: "workspace" } },
      fetcher,
    },
  );
  assert.equal(res.status, 200);
  assert.equal(sentBodies.length, 1);
  assert.equal(sentBodies[0]!.workspace_id, "ws-other-2");

  // Mismatched embedded workspace_id is STILL refused before network!
  await assert.rejects(
    () => postPinnedCommand(
      pinnedA,
      "cmd-mismatch",
      { kind: "revoke_hosted_mcp_seat", workspace_id: "ws-wrong-3" },
      { scope: { kind: "account-routed-workspace", workspaceId: "ws-other-2" }, fetcher },
    ),
    MultiAccountWorkspaceMismatch,
  );
  assert.equal(sentBodies.length, 1);

  // Switching accounts A -> B -> A STILL invalidates pinnedA!
  mgr.switchActiveAccount(userB.id);
  mgr.switchActiveAccount(userA.id);
  await assert.rejects(
    () => postPinnedCommand(
      pinnedA,
      "cmd-stale-after-aba",
      { kind: "revoke_hosted_mcp_seat", grant_id: "g-1", seat_id: "s-1" },
      { scope: { kind: "account-routed-workspace", workspaceId: "ws-other-2" }, fetcher },
    ),
    /could not check your sign-in/i,
  );
  assert.equal(sentBodies.length, 1);

  mgr.destroy();
});

test("PR 2 Lead fixes (2), (4), (5), (6): source wiring assertions for signed-out OTP, seat-admin signOutActiveAccount, teardown + notice preservation, householdSurface/loadAdminRecovery pinning, and inbox bootstrap", async () => {
  const [liveDash, inviteOnramp, inbox, homeClient, adminDeleg, commonswarmSrc, connectedApps] = await Promise.all([
    readFile(new URL("../src/components/app/LiveDashboard.astro", import.meta.url), "utf8"),
    readFile(new URL("../src/components/invite/InviteOnramp.astro", import.meta.url), "utf8"),
    readFile(new URL("../src/components/invite/HumanInvitationInbox.astro", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/home/client.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/admin-delegations.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/commonswarm.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/connected-apps.ts", import.meta.url), "utf8"),
  ]);

  // (2) Signed-out /app and /invite OTP inputs wired to verifyEmailOtpSignIn, plus Add-account OTP reset on refusal
  assert.ok(liveDash.includes("data-signed-out-otp-row") && liveDash.includes("data-signed-out-otp-verify"));
  assert.ok(inviteOnramp.includes("data-invite-otp-form") && inviteOnramp.includes("data-invite-otp-verify") && inviteOnramp.includes("verifyEmailOtpSignIn("));
  assert.ok(liveDash.includes("resetAddAccountOtp();"));

  // (3) Account-wide Connected Apps & Your Agents pass accountWideWorkspace: true
  assert.ok(connectedApps.includes("accountWideWorkspace: true"));
  assert.ok(commonswarmSrc.includes("accountWideWorkspace: true"));

  // (4) Seat-admin re-auth routes through signOutActiveAccount with exact displayed login when multi-account enabled
  assert.ok(liveDash.includes("const signOutRes = await signOutActiveAccount("));

  // (5) Account A teardown before boot, notice preservation across forced teardown + onAuthChange, InviteOnramp never overwrites unusable()
  assert.ok(liveDash.includes("teardownActiveAccountView()"));
  assert.ok(liveDash.includes("pendingForcedNotice"));
  assert.ok(inviteOnramp.includes('if (host.dataset.state !== "unusable")'));

  // (6) householdSurface + loadAdminRecovery pinned, inbox awaits bootstrapMultiAccountAuth, signed-in refused OAuth surfaced, multiAccountBootPromise cleared on rejection
  assert.ok(homeClient.slice(homeClient.indexOf("async function householdSurface")).includes("pinAccountContext("));
  assert.ok(adminDeleg.slice(adminDeleg.indexOf("export async function loadAdminRecovery")).includes("pinAccountContext("));
  assert.ok(inbox.includes("bootstrapMultiAccountAuth(window.location, window.history)"));
  assert.ok(liveDash.includes("refusedAddAccountMessage"));
  assert.ok(commonswarmSrc.includes("if (multiAccountBootPromise === pending) {\n        multiAccountBootPromise = null;"));
});

test("PR 2 HezSec C1 witness: held visibility and file_version_create across same-workspace A->B and A->B->A block stale PUT, commit, and post; unchanged control succeeds", async () => {
  const url = "https://example.supabase.co";
  const deployment = { url, anonKey: "public-anon-key" };
  const sharedWs = "ws-shared-1";
  const userA = makeUser("11111111-1111-4111-8111-111111111111", "a@example.test", "A");
  const userB = makeUser("22222222-2222-4222-8222-222222222222", "b@example.test", "B");
  const live = new Map<string, typeof userA>();

  let createGate: (() => void) | null = null;
  const commandsSent: Array<{ kind: string; actor: string }> = [];
  let putCount = 0;

  const fetcher: typeof fetch = async (input, init) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (u.pathname.endsWith("/auth/v1/token") && u.searchParams.get("grant_type") === "password") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { email?: string };
      const who = body.email === userB.email ? userB : userA;
      const at = makeJwt(url, who.id, who.email, `sid-${who.id.slice(0, 4)}-${live.size}`);
      live.set(at, who);
      return Response.json({
        access_token: at, refresh_token: `rt-${live.size}`, expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: "bearer", user: who,
      });
    }
    if (u.pathname.endsWith("/auth/v1/user")) {
      const bearer = (new Headers(init?.headers).get("authorization") ?? "").replace(/^Bearer /i, "");
      const who = live.get(bearer);
      if (!who) return Response.json({ code: "session_not_found" }, { status: 403 });
      return Response.json(who);
    }
    if (u.pathname.endsWith("/functions/v1/command")) {
      const bearer = (new Headers(init?.headers).get("authorization") ?? "").replace(/^Bearer /i, "");
      const who = live.get(bearer)!;
      const env = JSON.parse(String(init?.body ?? "{}")) as { command: { kind: string } };
      commandsSent.push({ kind: env.command.kind, actor: who.id });
      if (env.command.kind === "file_version_create" && createGate) {
        await new Promise<void>((resolve) => { createGate = resolve; });
      }
      if (env.command.kind === "file_version_create") {
        return Response.json({ status: "accepted", file_id: "f-1", version_id: "v-1", version_n: 1, upload_path: "/storage/v1/object/upload/f-1" });
      }
      if (env.command.kind === "file_version_commit") {
        return Response.json({ status: "accepted", file_id: "f-1", version_n: 1 });
      }
      return Response.json({ status: "accepted", signal: { id: "sig-1" } });
    }
    if (init?.method === "PUT") {
      putCount += 1;
      return new Response(null, { status: 200 });
    }
    throw new Error(`unexpected fetch: ${u.href}`);
  };

  const mgr = new AccountManager(deployment, {
    localStorage: new MemoryStorage(),
    sessionStorage: new MemoryStorage(),
    fetcher,
    webLocks: createLocks(),
    createBroadcastChannel: noopChannel,
  });
  await mgr.initialize();
  await mgr.signInWithPasswordStaging({ email: userA.email, password: "pw" });
  await mgr.signInWithPasswordStaging({ email: userB.email, password: "pw" });

  // Run the exact composer sequence: pin -> visibility -> create -> PUT -> commit -> post.
  const runComposerSequence = async (
    holdVisibility: Promise<void>,
    holdCreate: boolean,
  ): Promise<void> => {
    const pinned = mgr.pinContext({ userId: userA.id, workspaceId: sharedWs });
    assert.ok(pinned);
    await holdVisibility;
    if (!pinned.isCurrent(sharedWs)) throw new MultiAccountAuthRecoveryRequired();
    if (holdCreate) createGate = () => undefined;
    const created = await postPinnedCommand(pinned, "c-create", { kind: "file_version_create" }, {
      scope: { workspaceId: sharedWs }, fetcher,
    });
    if (!pinned.isCurrent(sharedWs)) throw new MultiAccountAuthRecoveryRequired();
    await fetcher(new URL(String(created.body.upload_path), `${url}/`).href, { method: "PUT", body: "bytes" });
    if (!pinned.isCurrent(sharedWs)) throw new MultiAccountAuthRecoveryRequired();
    await postPinnedCommand(pinned, "c-commit", { kind: "file_version_commit" }, {
      scope: { workspaceId: sharedWs }, fetcher,
    });
    if (!pinned.isCurrent(sharedWs)) throw new MultiAccountAuthRecoveryRequired();
    await postPinnedCommand(pinned, "c-post", { kind: "post_signal" }, {
      scope: { workspaceId: sharedWs }, fetcher,
    });
  };

  // Case 1: Same-workspace A -> B during held visibility check -> 0 create, 0 PUT, 0 commit, 0 post!
  mgr.switchActiveAccount(userA.id);
  mgr.setActiveWorkspace(sharedWs);
  let releaseVis!: () => void;
  const visPromise = new Promise<void>((r) => { releaseVis = r; });
  const run1 = runComposerSequence(visPromise, false);
  mgr.switchActiveAccount(userB.id);
  mgr.setActiveWorkspace(sharedWs);
  releaseVis();
  await assert.rejects(() => run1, MultiAccountAuthRecoveryRequired);
  assert.equal(commandsSent.length, 0);
  assert.equal(putCount, 0);

  // Case 2: Same-workspace A -> B -> A during held file_version_create -> postPinnedCommand rejects on return; 0 PUT, 0 commit, 0 post!
  mgr.switchActiveAccount(userA.id);
  mgr.setActiveWorkspace(sharedWs);
  const run2 = runComposerSequence(Promise.resolve(), true);
  await new Promise((r) => setTimeout(r, 15));
  mgr.switchActiveAccount(userB.id);
  mgr.setActiveWorkspace(sharedWs);
  mgr.switchActiveAccount(userA.id);
  mgr.setActiveWorkspace(sharedWs);
  const releaseCreate = createGate as (() => void) | null;
  createGate = null;
  releaseCreate?.();
  await assert.rejects(() => run2, MultiAccountAuthRecoveryRequired);
  assert.deepEqual(commandsSent.map((c) => c.kind), ["file_version_create"]);
  assert.equal(putCount, 0, "no stale PUT after A->B->A");

  // Case 3: Unchanged-account control succeeds end-to-end under A!
  commandsSent.length = 0;
  await runComposerSequence(Promise.resolve(), false);
  assert.deepEqual(commandsSent, [
    { kind: "file_version_create", actor: userA.id },
    { kind: "file_version_commit", actor: userA.id },
    { kind: "post_signal", actor: userA.id },
  ]);
  assert.equal(putCount, 1);

  mgr.destroy();
});

test("PR 2 HezSec C2 witness: held signed-download HTTP 200 rejected after switch/sign-out, image viewer clears src & filename on close, and pending W2 expiry fails closed on switch", async () => {
  const url = "https://example.supabase.co";
  const deployment = { url, anonKey: "public-anon-key" };
  const userA = makeUser("11111111-1111-4111-8111-111111111111", "a@example.test", "A");
  const userB = makeUser("22222222-2222-4222-8222-222222222222", "b@example.test", "B");
  const live = new Map<string, typeof userA>();

  let releaseDownload: (() => void) | null = null;
  let releaseExpiry: (() => void) | null = null;

  const fetcher: typeof fetch = async (input, init) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (u.pathname.endsWith("/auth/v1/token") && u.searchParams.get("grant_type") === "password") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { email?: string };
      const who = body.email === userB.email ? userB : userA;
      const at = makeJwt(url, who.id, who.email, `sid-${who.id.slice(0, 4)}-${live.size}`);
      live.set(at, who);
      return Response.json({
        access_token: at, refresh_token: `rt-${live.size}`, expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: "bearer", user: who,
      });
    }
    if (u.pathname.endsWith("/auth/v1/user")) {
      const bearer = (new Headers(init?.headers).get("authorization") ?? "").replace(/^Bearer /i, "");
      const who = live.get(bearer);
      if (!who) return Response.json({ code: "session_not_found" }, { status: 403 });
      return Response.json(who);
    }
    if (u.pathname.endsWith("/functions/v1/command")) {
      const env = JSON.parse(String(init?.body ?? "{}")) as { command: { kind: string } };
      if (env.command.kind === "file_download_url") {
        await new Promise<void>((r) => { releaseDownload = r; });
        return Response.json({ status: "accepted", download_path: "/storage/v1/object/sign/secret.png?token=signed-a" });
      }
      if (env.command.kind === "set_connection_expiry" && releaseExpiry) {
        await new Promise<void>((r) => { releaseExpiry = r; });
        return Response.json({ status: "accepted", ok: true });
      }
      return Response.json({ status: "accepted", ok: true });
    }
    throw new Error(`unexpected fetch: ${u.href}`);
  };

  const mgr = new AccountManager(deployment, {
    localStorage: new MemoryStorage(),
    sessionStorage: new MemoryStorage(),
    fetcher,
    webLocks: createLocks(),
    createBroadcastChannel: noopChannel,
  });
  await mgr.initialize();
  await mgr.signInWithPasswordStaging({ email: userA.email, password: "pw" });
  await mgr.signInWithPasswordStaging({ email: userB.email, password: "pw" });
  mgr.switchActiveAccount(userA.id);
  mgr.setActiveWorkspace("ws-1");

  // Held HTTP 200 signed-download URL across account switch -> postPinnedCommand rejects BEFORE returning URL!
  const dlPin = mgr.pinContext({ userId: userA.id, workspaceId: "ws-1" })!;
  let navigated = false;
  const dlTask = postPinnedCommand(dlPin, "cmd-dl", { kind: "file_download_url", file_id: "f-1" }, {
    scope: { workspaceId: "ws-1" }, fetcher,
  }).then(() => { navigated = true; });
  await new Promise((r) => setTimeout(r, 15));
  mgr.switchActiveAccount(userB.id);
  const relDl = releaseDownload as (() => void) | null;
  relDl?.();
  await assert.rejects(() => dlTask, MultiAccountAuthRecoveryRequired);
  assert.equal(navigated, false, "held signed download URL must never navigate after switch");

  // W2 expiry save from W1 view: succeeds under A, fails closed when held across A -> B switch!
  mgr.switchActiveAccount(userA.id);
  mgr.setActiveWorkspace("ws-1");
  const pinCtrl = mgr.pinContext({ userId: userA.id })!;
  const ok = await postPinnedCommand(pinCtrl, "cmd-exp-ok", { kind: "set_connection_expiry", grant_id: "g-w2" }, {
    scope: { kind: "account-routed-workspace", workspaceId: "ws-2" }, fetcher,
  });
  assert.equal(ok.status, 200);

  releaseExpiry = () => undefined;
  const pinHeld = mgr.pinContext({ userId: userA.id })!;
  const heldExp = postPinnedCommand(pinHeld, "cmd-exp-held", { kind: "set_connection_expiry", grant_id: "g-w2" }, {
    scope: { kind: "account-routed-workspace", workspaceId: "ws-2" }, fetcher,
  });
  await new Promise((r) => setTimeout(r, 15));
  mgr.switchActiveAccount(userB.id);
  const rel = releaseExpiry as (() => void) | null;
  releaseExpiry = null;
  rel?.();
  await assert.rejects(() => heldExp, MultiAccountAuthRecoveryRequired);

  // Verify image-viewer close clears src, title, and disposes in-flight link assignment + LiveDashboard teardown closes all dialogs & clears cache!
  const [imageViewerSrc, liveDashSrc, commonswarmSrc, adminDelegSrc] = await Promise.all([
    readFile(new URL("../src/lib/image-viewer.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/components/app/LiveDashboard.astro", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/commonswarm.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/components/app/AdminDelegations.astro", import.meta.url), "utf8"),
  ]);
  assert.ok(imageViewerSrc.includes("disposed = true;") && imageViewerSrc.includes('image.removeAttribute("src");') && imageViewerSrc.includes('title.textContent = "";'));
  assert.ok(liveDashSrc.includes("activeImageViewerDialog.close()") && liveDashSrc.includes("attachmentPreviewUrls.clear()") && liveDashSrc.includes("closeWorkspaceSkillsDialog()"));
  assert.ok(commonswarmSrc.includes("if (hadPrevious) {\n      listener(\"SIGNED_OUT\", null);"), "onAuthChange invalidates synchronously before B verifies");
  assert.equal(commonswarmSrc.includes("mgr.setActiveWorkspace(workspaceId);"), false, "Realtime helpers must not mutate activeWorkspace themselves");
  assert.ok(adminDelegSrc.includes("if (isMultiAccountEnabled() && (!activePin || !activePin.isCurrent()))"));

  mgr.destroy();
});

test("PR 2 HezSec C3 witness: closing Add account or switching during S256 generation stores nothing and blocks redirect; in-memory retirement holds when removeItem throws", async () => {
  const url = "https://example.supabase.co";
  const deployment = { url, anonKey: "public-anon-key" };
  const userA = makeUser("11111111-1111-4111-8111-111111111111", "a@example.test", "A");
  const userB = makeUser("22222222-2222-4222-8222-222222222222", "b@example.test", "B");
  const live = new Map<string, typeof userA>();

  const fetcher: typeof fetch = async (input, init) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (u.pathname.endsWith("/auth/v1/token") && u.searchParams.get("grant_type") === "password") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { email?: string };
      const who = body.email === userB.email ? userB : userA;
      const at = makeJwt(url, who.id, who.email, `sid-${who.id.slice(0, 4)}-${live.size}`);
      live.set(at, who);
      return Response.json({
        access_token: at, refresh_token: `rt-${live.size}`, expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: "bearer", user: who,
      });
    }
    if (u.pathname.endsWith("/auth/v1/user")) {
      const bearer = (new Headers(init?.headers).get("authorization") ?? "").replace(/^Bearer /i, "");
      const who = live.get(bearer);
      if (!who) return Response.json({ code: "session_not_found" }, { status: 403 });
      return Response.json(who);
    }
    throw new Error(`unexpected fetch: ${u.href}`);
  };

  let holdDigest: (() => void) | null = null;
  let throwOnRemove = false;
  const ss = new MemoryStorage();
  const flakySs: Storage = {
    get length() { return ss.length; },
    clear: () => ss.clear(),
    key: (i) => ss.key(i),
    getItem: (k) => ss.getItem(k),
    setItem: (k, v) => ss.setItem(k, v),
    removeItem: (k) => {
      if (throwOnRemove) throw new Error("sessionStorage removeItem blocked");
      ss.removeItem(k);
    },
  };
  const gatedSubtle = {
    digest: async (alg: AlgorithmIdentifier, data: BufferSource) => {
      if (holdDigest) {
        await new Promise<void>((r) => { holdDigest = r; });
      }
      return globalThis.crypto.subtle.digest(alg, data);
    },
  } as unknown as SubtleCrypto;

  const mgr = new AccountManager(deployment, {
    localStorage: new MemoryStorage(),
    sessionStorage: flakySs,
    fetcher,
    subtle: gatedSubtle,
    webLocks: createLocks(),
    createBroadcastChannel: noopChannel,
  });
  await mgr.initialize();
  await mgr.signInWithPasswordStaging({ email: userA.email, password: "pw" });
  await mgr.signInWithPasswordStaging({ email: userB.email, password: "pw" });
  mgr.switchActiveAccount(userA.id);

  // Case 1: Close Add account (cancelAttempt) while S256 digest is in flight -> rejects & stores 0 attempt!
  holdDigest = () => undefined;
  const start1 = mgr.startOAuthAttempt({ provider: "google", purpose: "add-account", returnRoute: "/app", origin: "https://commonswarm.com" });
  await new Promise((r) => setTimeout(r, 10));
  mgr.cancelAttempt();
  const rel1 = holdDigest as (() => void) | null;
  holdDigest = null;
  rel1?.();
  await assert.rejects(() => start1, /cancelled/i);
  assert.equal(ss.length, 1, "only tab-account key in sessionStorage; 0 OAuth attempt stored");

  // Case 2: Switch account while S256 digest is in flight -> rejects & stores 0 attempt!
  holdDigest = () => undefined;
  const start2 = mgr.startOAuthAttempt({ provider: "google", purpose: "add-account", returnRoute: "/app", origin: "https://commonswarm.com" });
  await new Promise((r) => setTimeout(r, 10));
  mgr.switchActiveAccount(userB.id);
  const rel2 = holdDigest as (() => void) | null;
  holdDigest = null;
  rel2?.();
  await assert.rejects(() => start2, /cancelled/i);

  // Case 3: sessionStorage.removeItem throws on cancelAttempt -> in-memory retirement STILL blocks isAttemptActive & callback promotion!
  const started3 = await mgr.startOAuthAttempt({ provider: "google", purpose: "add-account", returnRoute: "/app", origin: "https://commonswarm.com" });
  assert.equal(mgr.isAttemptActive(started3.attemptId), true);
  throwOnRemove = true;
  mgr.cancelAttempt(started3.attemptId);
  assert.equal(mgr.isAttemptActive(started3.attemptId), false, "retired in memory even though removeItem threw");
  assert.ok(ss.getItem(attemptStorageKey(deploymentOriginHash(url), started3.attemptId)) !== null, "backing key remained because removeItem threw");
  const nav = makeLocation(`https://commonswarm.com/app?code=abc&cs_attempt=${started3.attemptId}`);
  const cb = await mgr.consumeAuthCallbackBootstrap(nav.location, nav.history);
  assert.equal(cb.kind, "refused");
  assert.equal(cb.reason, "separate_context_email");

  mgr.destroy();
});

test("PR 2 HezSec C4 witness: cutover fails closed on legacy read or remove failure, retries cleanly after restart, and bulk logout surfaces legacy cleanup failure", async () => {
  const url = "https://example.supabase.co";
  const deployment = { url, anonKey: "public-anon-key" };
  const originHash = deploymentOriginHash(url);
  const legacyKey = legacyStorageKey(url);
  const regKey = accountsStorageKey(originHash);

  const backing = new MemoryStorage();
  backing.setItem(legacyKey, JSON.stringify({ access_token: "old-legacy-tok", refresh_token: "old-rt" }));
  let failLegacyRead = true;
  let failLegacyRemove = false;

  const faultyLs: Storage = {
    get length() { return backing.length; },
    clear: () => backing.clear(),
    key: (i) => backing.key(i),
    getItem: (k) => {
      if (k === legacyKey && failLegacyRead) throw new Error("read I/O error");
      return backing.getItem(k);
    },
    setItem: (k, v) => backing.setItem(k, v),
    removeItem: (k) => {
      if (k === legacyKey && failLegacyRemove) throw new Error("remove I/O error");
      backing.removeItem(k);
    },
  };

  // 1. Legacy read failure -> cutover MUST fail closed and NOT write registry!
  const mgr1 = new AccountManager(deployment, {
    localStorage: faultyLs, sessionStorage: new MemoryStorage(), webLocks: createLocks(), createBroadcastChannel: noopChannel,
  });
  const init1 = await mgr1.initialize();
  assert.equal(init1.cutoverClearedLegacy, false);
  assert.equal(backing.getItem(regKey), null, "registry must NOT be committed when legacy read failed");
  mgr1.destroy();

  // 2. Legacy remove-only failure -> cutover MUST fail closed and NOT write registry!
  failLegacyRead = false;
  failLegacyRemove = true;
  const mgr2 = new AccountManager(deployment, {
    localStorage: faultyLs, sessionStorage: new MemoryStorage(), webLocks: createLocks(), createBroadcastChannel: noopChannel,
  });
  const init2 = await mgr2.initialize();
  assert.equal(init2.cutoverClearedLegacy, false);
  assert.equal(backing.getItem(regKey), null, "registry must NOT be committed when legacy removal threw");
  assert.ok(backing.getItem(legacyKey) !== null, "legacy token still present");
  mgr2.destroy();

  // 3. Restart once storage recovers -> cutover succeeds and verifies legacy deletion!
  failLegacyRemove = false;
  const mgr3 = new AccountManager(deployment, {
    localStorage: faultyLs, sessionStorage: new MemoryStorage(), webLocks: createLocks(), createBroadcastChannel: noopChannel,
  });
  const init3 = await mgr3.initialize();
  assert.equal(init3.cutoverClearedLegacy, true);
  assert.equal(backing.getItem(legacyKey), null, "legacy token verified absent");
  assert.ok(backing.getItem(regKey) !== null, "cutover committed only after verified deletion");

  // 4. Bulk logout surfaces failure to clear a stray legacy token!
  backing.setItem(legacyKey, JSON.stringify({ access_token: "stray-legacy" }));
  failLegacyRemove = true;
  const bulk = await mgr3.signOutAllAccounts();
  assert.equal(bulk.browserSignedOut, false, "bulk logout must surface legacy cleanup failure");
  assert.ok(bulk.notice && /older saved sign-in entry/i.test(bulk.notice));
  mgr3.destroy();
});

test("PR 2 HezSec C5 witness: peer removes A with storage event held -> clicking A sign-out leaves B untouched and triggers forced teardown for A before B activates", async () => {
  const url = "https://example.supabase.co";
  const deployment = { url, anonKey: "public-anon-key" };
  const userA = makeUser("11111111-1111-4111-8111-111111111111", "a@example.test", "A");
  const userB = makeUser("22222222-2222-4222-8222-222222222222", "b@example.test", "B");
  const live = new Map<string, typeof userA>();
  const loggedOutTokens: string[] = [];

  const fetcher: typeof fetch = async (input, init) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (u.pathname.endsWith("/auth/v1/token") && u.searchParams.get("grant_type") === "password") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { email?: string };
      const who = body.email === userB.email ? userB : userA;
      const at = makeJwt(url, who.id, who.email, `sid-${who.id.slice(0, 4)}-${live.size}`);
      live.set(at, who);
      return Response.json({
        access_token: at, refresh_token: `rt-${live.size}`, expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: "bearer", user: who,
      });
    }
    if (u.pathname.endsWith("/auth/v1/user")) {
      const bearer = (new Headers(init?.headers).get("authorization") ?? "").replace(/^Bearer /i, "");
      const who = live.get(bearer);
      if (!who) return Response.json({ code: "session_not_found" }, { status: 403 });
      return Response.json(who);
    }
    if (u.pathname.endsWith("/auth/v1/logout")) {
      const bearer = (new Headers(init?.headers).get("authorization") ?? "").replace(/^Bearer /i, "");
      loggedOutTokens.push(bearer);
      live.delete(bearer);
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected fetch: ${u.href}`);
  };

  const sharedLs = new MemoryStorage();
  const locks = createLocks();
  const forcedTeardowns: Array<{ reason: string; userId?: string; loginId?: string }> = [];

  // Tab 1 shows A; peer Tab 2 shares localStorage with NO storage event delivered yet!
  const tab1 = new AccountManager(deployment, {
    localStorage: sharedLs, sessionStorage: new MemoryStorage(), fetcher, webLocks: locks, createBroadcastChannel: noopChannel,
    onForcedTeardown: (d) => forcedTeardowns.push(d),
  });
  await tab1.initialize();
  const resA = await tab1.signInWithPasswordStaging({ email: userA.email, password: "pw" });
  const resB = await tab1.signInWithPasswordStaging({ email: userB.email, password: "pw" });
  assert.equal(resA.kind, "promoted");
  assert.equal(resB.kind, "promoted");
  tab1.switchActiveAccount(userA.id);
  const displayedLoginA = { userId: resA.account.userId, loginId: resA.account.loginId };
  const tokenB = tab1.runtimeFor(userB.id)!.peekAccessToken()!;

  // Peer Tab 2 removes A from durable ownership (storage event NOT yet fired in Tab 1!).
  const tab2 = new AccountManager(deployment, {
    localStorage: sharedLs, sessionStorage: new MemoryStorage(), fetcher, webLocks: locks, createBroadcastChannel: noopChannel,
  });
  await tab2.initialize();
  await tab2.signOutAccount(resA.account.userId, resA.account.loginId);
  loggedOutTokens.length = 0;

  // User clicks Sign out on A in Tab 1, passing exact displayedLoginA: B MUST remain completely untouched!
  await tab1.signOutAccount(displayedLoginA.userId, displayedLoginA.loginId);
  assert.equal(loggedOutTokens.includes(tokenB), false, "B must NEVER be revoked when signing out departed A");
  assert.equal(tab1.listAccounts().some((a) => a.userId === userB.id && a.loginId === resB.account.loginId), true, "B stays owned");

  // Also test activeAccount() before storage event fires: triggers forced teardown for A BEFORE returning fallback B!
  const tab3 = new AccountManager(deployment, {
    localStorage: sharedLs, sessionStorage: new MemoryStorage(), fetcher, webLocks: locks, createBroadcastChannel: noopChannel,
    onForcedTeardown: (d) => forcedTeardowns.push(d),
  });
  await tab3.initialize();
  const resA2 = await tab3.signInWithPasswordStaging({ email: userA.email, password: "pw" });
  assert.equal(resA2.kind, "promoted");
  tab3.switchActiveAccount(userA.id);
  forcedTeardowns.length = 0;
  await tab2.signOutAccount(resA2.account.userId, resA2.account.loginId);
  // Call activeAccount() BEFORE storage event -> MUST fire onForcedTeardown for A before selecting B!
  const fallback = tab3.activeAccount();
  assert.equal(forcedTeardowns.length, 1);
  assert.equal(forcedTeardowns[0]!.userId, userA.id);
  assert.equal(forcedTeardowns[0]!.loginId, resA2.account.loginId);
  assert.equal(fallback?.userId, userB.id);

  tab1.destroy();
  tab2.destroy();
  tab3.destroy();
});

test("PR 2 HezSec C6 witness: callback URL credentials are scrubbed SYNCHRONOUSLY BEFORE awaiting initialize() locks", async () => {
  const nav = makeLocation("https://commonswarm.com/invite?resume=res-1&code=pkce-secret&cs_attempt=att-1#access_token=bad-tok");
  const snap = scrubCallbackUrlImmediate(nav.location, nav.history);
  assert.equal(snap.hasAnyAuthParam, true);
  assert.equal(snap.scrubbed, true);
  assert.equal(nav.location.search, "?resume=res-1", "query auth params scrubbed synchronously while resume kept");
  assert.equal(nav.location.hash, "", "bearer fragment scrubbed synchronously before any await");
  const commonswarmSrc = await readFile(new URL("../src/lib/commonswarm.ts", import.meta.url), "utf8");
  const bootFn = commonswarmSrc.slice(commonswarmSrc.indexOf("export async function bootstrapMultiAccountAuth"));
  assert.ok(
    bootFn.indexOf("scrubCallbackUrlImmediate(") > 0 &&
    bootFn.indexOf("scrubCallbackUrlImmediate(") < bootFn.indexOf("await mgr.initialize()"),
    "bootstrapMultiAccountAuth must scrub callback URL BEFORE awaiting mgr.initialize()",
  );
});

test("PR 2 Designer CHANGES (1)-(4) + HezSec C3 signed-out copy: distinct code step, centered dialogs & focus return, identifiable accounts + expired badge poller, and /invite identity change notice", async () => {
  // 1. Runtime test: InactiveAccountBadgePoller tracks expired inactive logins cleanly!
  const url = "https://example.supabase.co";
  const deployment = { url, anonKey: "public-anon-key" };
  const userA = makeUser("11111111-1111-4111-8111-111111111111", "a@example.test", "Alex");
  const userB = makeUser("22222222-2222-4222-8222-222222222222", "b@example.test", "Alex");
  const expiredTokens = new Set<string>();
  const live = new Map<string, typeof userA>();

  const fetcher: typeof fetch = async (input, init) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (u.pathname.endsWith("/auth/v1/token") && u.searchParams.get("grant_type") === "password") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { email?: string };
      const who = body.email === userB.email ? userB : userA;
      const at = makeJwt(url, who.id, who.email, `sid-${who.id.slice(0, 4)}-${live.size}`);
      live.set(at, who);
      return Response.json({
        access_token: at, refresh_token: `rt-${live.size}`, expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: "bearer", user: who,
      });
    }
    if (u.pathname.endsWith("/auth/v1/user")) {
      const bearer = (new Headers(init?.headers).get("authorization") ?? "").replace(/^Bearer /i, "");
      if (expiredTokens.has(bearer)) {
        return Response.json({ error_code: "session_not_found", msg: "Session from session_id claim in JWT does not exist" }, { status: 403 });
      }
      const who = live.get(bearer);
      if (!who) return Response.json({ error_code: "session_not_found", msg: "Session not found" }, { status: 403 });
      return Response.json(who);
    }
    if (u.pathname.endsWith("/auth/v1/token") && u.searchParams.get("grant_type") === "refresh_token") {
      return Response.json({ error: "invalid_grant", error_description: "Refresh Token Not Found" }, { status: 400 });
    }
    throw new Error(`unexpected fetch: ${u.href}`);
  };

  const mgr = new AccountManager(deployment, {
    localStorage: new MemoryStorage(),
    sessionStorage: new MemoryStorage(),
    fetcher,
    webLocks: createLocks(),
    createBroadcastChannel: noopChannel,
  });
  await mgr.initialize();
  const aProm = await mgr.signInWithPasswordStaging({ email: userA.email, password: "pw" });
  const bProm = await mgr.signInWithPasswordStaging({ email: userB.email, password: "pw" });
  assert.equal(aProm.kind, "promoted");
  assert.equal(bProm.kind, "promoted");
  mgr.switchActiveAccount(userA.id);

  // Expire B's token so inactive badge poller detects expired session!
  const bToken = mgr.runtimeFor(userB.id)!.peekAccessToken()!;
  expiredTokens.add(bToken);
  const poller = new InactiveAccountBadgePoller(mgr, async () => 2, { intervalMs: 0 });
  assert.equal(poller.isExpired(userB.id, bProm.account.loginId), false);
  await poller.pollOnce();
  assert.equal(poller.isExpired(userB.id, bProm.account.loginId), true, "proven expired inactive account must surface Sign in again");
  assert.equal(poller.waitingCount(userB.id, bProm.account.loginId), null, "expired inactive account must not show stale waiting count");
  assert.deepEqual(
    poller.expiredAccounts().map((a) => ({ userId: a.userId, secondary: a.secondary })),
    [{ userId: userB.id, secondary: userB.email }],
    "expired inactive account remains surfaced for Sign in again until re-signed in or cleared",
  );
  poller.clear();
  assert.equal(poller.expiredAccounts().length, 0, "clear wipes expired cues on sign-out-all");
  mgr.destroy();

  // 2. Source & CSS contract assertions for all 4 Designer CHANGES + HezSec C3 signed-out copy!
  const [liveDash, inviteOnramp, dialogCss, shellCss, homeShell] = await Promise.all([
    readFile(new URL("../src/components/app/LiveDashboard.astro", import.meta.url), "utf8"),
    readFile(new URL("../src/components/invite/InviteOnramp.astro", import.meta.url), "utf8"),
    readFile(new URL("../src/styles/kylon-account-dialogs.css", import.meta.url), "utf8"),
    readFile(new URL("../src/styles/home/shell.css", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/home-shell.ts", import.meta.url), "utf8"),
  ]);

  // Designer #1: Distinct emailed-code step with pinned address captured before await, separate <form>, Enter = Verify code, Send new code + Change email, matching signed-out copy!
  assert.ok(liveDash.includes("data-add-account-code-step") && liveDash.includes("data-add-account-code-email") && liveDash.includes("data-add-account-otp-change") && liveDash.includes("data-add-account-otp-resend"));
  assert.ok(liveDash.includes('if (titleEl) titleEl.textContent = "Enter your sign-in code.";'));
  assert.ok(liveDash.includes('We sent a sign-in code to ') && liveDash.includes('data-signed-out-otp-resend'));
  assert.ok(inviteOnramp.includes("data-invite-otp-form") && inviteOnramp.includes("data-invite-otp-email") && inviteOnramp.includes("data-invite-otp-resend") && inviteOnramp.includes("data-invite-otp-change"));

  // Designer #2: Dialog centering, field insets, focus rings, and focus return on Escape/Cancel
  assert.ok(dialogCss.includes("[data-add-account-dialog]") && dialogCss.includes("[data-signout-all-dialog]"));
  assert.ok(liveDash.includes("focusVisibleAccountTrigger("));

  // Designer #3: Visible "Current", "N waiting", "Sign in again", wrapping full email, active identifier on trigger & single-account sign-out actions, 5-account cap guidance, switch live announcement
  assert.equal(liveDash.includes("viewerInitials("), false, "account switcher must call the existing initials() helper, not undefined viewerInitials()");
  assert.ok(liveDash.includes('currentEl.textContent = "Current"') && liveDash.includes('badge.textContent = `${waiting} waiting`') && liveDash.includes('expiredEl.textContent = "Sign in again"'));
  assert.ok(liveDash.includes("data-signout-sub") && liveDash.includes("data-signout-others-sub") && liveDash.includes("data-rail-account-email") && liveDash.includes("data-account-live"));
  assert.ok(liveDash.includes("Sign out of an account to add another."));
  assert.ok(homeShell.includes('"hm-account-row__current", "Current"') && homeShell.includes('`${acct.waitingCount} waiting`') && homeShell.includes('"Sign in again"') && homeShell.includes("activeAccountIdentifier"));
  assert.ok(shellCss.includes("overflow-wrap: anywhere") && shellCss.includes(".hm-account-row__expired") && shellCss.includes("[data-user-menu]"));

  // Designer #4: Name new identity on invitation review after identity change
  assert.ok(inviteOnramp.includes("data-review-identity-notice") && inviteOnramp.includes("You’re now joining as ${authEmail || \"this account\"}. Review this invitation again."));
});

test("PR 2 HezSec C1 real-caller witness: production uploadBrowserAttachment + postBrowserSignal drop stale PUT/commit/post across same-workspace A->B and A->B->A; unchanged control succeeds", async () => {
  const url = "https://example.supabase.co";
  const deployment = { url, anonKey: "public-anon-key" };
  const sharedWs = "ws-shared-real-1";
  const userA = makeUser("11111111-1111-4111-8111-111111111111", "a@example.test", "A");
  const userB = makeUser("22222222-2222-4222-8222-222222222222", "b@example.test", "B");
  const live = new Map<string, typeof userA>();

  let holdCreate = false;
  let releaseCreate: (() => void) | null = null;
  const commandsSent: Array<{ kind: string; actor: string }> = [];
  let putCount = 0;

  const mockFetch: typeof fetch = async (input, init) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (u.pathname.endsWith("/auth/v1/token") && u.searchParams.get("grant_type") === "password") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { email?: string };
      const who = body.email === userB.email ? userB : userA;
      const at = makeJwt(url, who.id, who.email, `sid-${who.id.slice(0, 4)}-${live.size}`);
      live.set(at, who);
      return Response.json({
        access_token: at, refresh_token: `rt-${live.size}`, expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: "bearer", user: who,
      });
    }
    if (u.pathname.endsWith("/auth/v1/user")) {
      const bearer = (new Headers(init?.headers).get("authorization") ?? "").replace(/^Bearer /i, "");
      const who = live.get(bearer);
      if (!who) return Response.json({ error_code: "session_not_found" }, { status: 403 });
      return Response.json(who);
    }
    if (u.pathname.endsWith("/functions/v1/command")) {
      const bearer = (new Headers(init?.headers).get("authorization") ?? "").replace(/^Bearer /i, "");
      const who = live.get(bearer)!;
      const env = JSON.parse(String(init?.body ?? "{}")) as { command: { kind: string; file_id?: string; version_id?: string } };
      commandsSent.push({ kind: env.command.kind, actor: who.id });
      if (env.command.kind === "file_version_create" && holdCreate) {
        await new Promise<void>((resolve) => { releaseCreate = resolve; });
      }
      if (env.command.kind === "file_version_create") {
        return Response.json({
          status: "accepted",
          file_id: env.command.file_id ?? "f-real-1",
          version_id: env.command.version_id ?? "v-real-1",
          version_n: 1,
          upload_path: "/storage/v1/object/upload/sign/attachments/f-real-1?token=up-1",
        });
      }
      if (env.command.kind === "file_version_commit") {
        return Response.json({
          status: "accepted",
          file_id: env.command.file_id ?? "f-real-1",
          version_id: env.command.version_id ?? "v-real-1",
          version_n: 1,
        });
      }
      return Response.json({
        status: "accepted",
        signal: {
          id: "sig-real-1",
          workspace_id: sharedWs,
          kind: "message",
          from_kind: "user",
          from_id: who.id,
          body: "hello control",
          created_at: "2026-11-19T00:00:00Z",
        },
      });
    }
    if (init?.method === "PUT" && u.pathname.startsWith("/storage/v1/")) {
      putCount += 1;
      return new Response(null, { status: 200 });
    }
    throw new Error(`unexpected fetch: ${init?.method ?? "GET"} ${u.href}`);
  };

  const origFetch = globalThis.fetch;
  globalThis.fetch = mockFetch;
  setMultiAccountEnabledForTesting(true);
  configureMultiAccountForTesting({
    deployment,
    env: {
      localStorage: new MemoryStorage(),
      sessionStorage: new MemoryStorage(),
      fetcher: mockFetch,
      webLocks: createLocks(),
      createBroadcastChannel: noopChannel,
    },
  });
  try {
    const mgr = accountManager()!;
    await mgr.initialize();
    await mgr.signInWithPasswordStaging({ email: userA.email, password: "pw" });
    await mgr.signInWithPasswordStaging({ email: userB.email, password: "pw" });
    mgr.switchActiveAccount(userA.id);
    mgr.setActiveWorkspace(sharedWs);
    const sessionA = (await mgr.runtimeFor(userA.id)!.verifySession())!;

    // Case 1: Held file_version_create across same-workspace A -> B -> 0 PUT, 0 commit, 0 post!
    const [intent1] = prepareBrowserAttachments([new File(["hello A1"], "note.txt", { type: "text/plain" })]);
    const pin1 = pinAccountContext({ userId: userA.id, workspaceId: sharedWs })!;
    holdCreate = true;
    const task1 = uploadBrowserAttachment(sessionA, sharedWs, intent1!, pin1);
    await new Promise((r) => setTimeout(r, 15));
    mgr.switchActiveAccount(userB.id);
    mgr.setActiveWorkspace(sharedWs);
    holdCreate = false;
    (releaseCreate as (() => void) | null)?.();
    releaseCreate = null;
    await assert.rejects(() => task1, (err: unknown) => err instanceof AuthRecoveryRequired || err instanceof MultiAccountAuthRecoveryRequired);
    assert.deepEqual(commandsSent.map((c) => c.kind), ["file_version_create"]);
    assert.equal(putCount, 0, "production uploadBrowserAttachment must NOT PUT after same-workspace A->B");

    // Case 2: Held file_version_create across same-workspace A -> B -> A -> 0 PUT, 0 commit, 0 post!
    commandsSent.length = 0;
    mgr.switchActiveAccount(userA.id);
    mgr.setActiveWorkspace(sharedWs);
    const [intent2] = prepareBrowserAttachments([new File(["hello A2"], "note2.txt", { type: "text/plain" })]);
    const pin2 = pinAccountContext({ userId: userA.id, workspaceId: sharedWs })!;
    holdCreate = true;
    const task2 = uploadBrowserAttachment(sessionA, sharedWs, intent2!, pin2);
    await new Promise((r) => setTimeout(r, 15));
    mgr.switchActiveAccount(userB.id);
    mgr.setActiveWorkspace(sharedWs);
    mgr.switchActiveAccount(userA.id);
    mgr.setActiveWorkspace(sharedWs);
    holdCreate = false;
    (releaseCreate as (() => void) | null)?.();
    releaseCreate = null;
    await assert.rejects(() => task2, (err: unknown) => err instanceof AuthRecoveryRequired || err instanceof MultiAccountAuthRecoveryRequired);
    assert.deepEqual(commandsSent.map((c) => c.kind), ["file_version_create"]);
    assert.equal(putCount, 0, "production uploadBrowserAttachment must NOT PUT after same-workspace A->B->A");

    // Case 3: Unchanged-account control succeeds end-to-end through uploadBrowserAttachment + postBrowserSignal!
    commandsSent.length = 0;
    const [intent3] = prepareBrowserAttachments([new File(["hello ok"], "ok.txt", { type: "text/plain" })]);
    const pin3 = pinAccountContext({ userId: userA.id, workspaceId: sharedWs })!;
    const ref3 = await uploadBrowserAttachment(sessionA, sharedWs, intent3!, pin3);
    await postBrowserSignal(sessionA, "cmd-post-ok", sharedWs, "hello control", [], undefined, [ref3], {}, pin3);
    assert.deepEqual(commandsSent, [
      { kind: "file_version_create", actor: userA.id },
      { kind: "file_version_commit", actor: userA.id },
      { kind: "post_signal", actor: userA.id },
    ]);
    assert.equal(putCount, 1);
  } finally {
    resetAccountManagerForTesting();
    setMultiAccountEnabledForTesting(null);
    globalThis.fetch = origFetch;
  }
});

test("PR 2 HezSec C2 real-caller witness: onAuthChange suppresses stale success/failure across A->B->A and after unsubscribe; decisionQueue pagination drops stale pages across switch", async () => {
  const url = "https://example.supabase.co";
  const deployment = { url, anonKey: "public-anon-key" };
  const sharedWs = "ws-c2-paged-1";
  const userA = makeUser("11111111-1111-4111-8111-111111111111", "a@example.test", "A");
  const userB = makeUser("22222222-2222-4222-8222-222222222222", "b@example.test", "B");
  const live = new Map<string, typeof userA>();

  let holdUserToken: string | null = null;
  let holdUserFail = false;
  let releaseHeldUser: (() => void) | null = null;
  let holdPage2 = false;
  let page2ReturnError = false;
  let releasePage2: (() => void) | null = null;
  let pageRpcCalls = 0;

  const makeAskRow = (idx: number, actor: string) => ({
    signal_id: `sig-${actor}-${idx}`,
    from: { kind: "user", id: actor, name: actor },
    body: `Ask ${idx} for ${actor}`,
    created_at: `2026-11-19T00:${String(idx).padStart(2, "0")}:00Z`,
    until: "2026-11-20T00:00:00Z",
    reraised: null,
  });

  const mockFetch: typeof fetch = async (input, init) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (u.pathname.endsWith("/auth/v1/token") && u.searchParams.get("grant_type") === "password") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { email?: string };
      const who = body.email === userB.email ? userB : userA;
      const at = makeJwt(url, who.id, who.email, `sid-${who.id.slice(0, 4)}-${live.size}`);
      live.set(at, who);
      return Response.json({
        access_token: at, refresh_token: `rt-${live.size}`, expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: "bearer", user: who,
      });
    }
    if (u.pathname.endsWith("/auth/v1/user")) {
      const bearer = (new Headers(init?.headers).get("authorization") ?? "").replace(/^Bearer /i, "");
      if (holdUserToken && bearer === holdUserToken) {
        holdUserToken = null;
        const shouldFail = holdUserFail;
        await new Promise<void>((resolve) => { releaseHeldUser = resolve; });
        if (shouldFail) return Response.json({ message: "transient error" }, { status: 500 });
      }
      const who = live.get(bearer);
      if (!who) return Response.json({ error_code: "session_not_found" }, { status: 403 });
      return Response.json(who);
    }
    if (u.pathname.endsWith("/rest/v1/rpc/decision_queue")) {
      const bearer = (new Headers(init?.headers).get("authorization") ?? "").replace(/^Bearer /i, "");
      const who = live.get(bearer)!;
      return Response.json({
        workspace_id: sharedWs,
        generated_at: "2026-11-19T01:00:00Z",
        total: 3,
        truncated: true,
        asks: [makeAskRow(1, who.id)],
      });
    }
    if (u.pathname.endsWith("/rest/v1/rpc/decision_queue_page")) {
      pageRpcCalls += 1;
      const bearer = (new Headers(init?.headers).get("authorization") ?? "").replace(/^Bearer /i, "");
      const who = live.get(bearer)!;
      if (holdPage2) {
        holdPage2 = false;
        await new Promise<void>((resolve) => { releasePage2 = resolve; });
      }
      if (page2ReturnError) {
        return Response.json({ code: "50000", message: "boom" }, { status: 500 });
      }
      return Response.json({
        workspace_id: sharedWs,
        generated_at: "2026-11-19T01:01:00Z",
        total: 2,
        truncated: false,
        asks: [makeAskRow(2, who.id)],
      });
    }
    throw new Error(`unexpected fetch: ${init?.method ?? "GET"} ${u.href}`);
  };

  setMultiAccountEnabledForTesting(true);
  configureMultiAccountForTesting({
    deployment,
    env: {
      localStorage: new MemoryStorage(),
      sessionStorage: new MemoryStorage(),
      fetcher: mockFetch,
      webLocks: createLocks(),
      createBroadcastChannel: noopChannel,
    },
  });
  try {
    const mgr = accountManager()!;
    await mgr.initialize();
    await mgr.signInWithPasswordStaging({ email: userA.email, password: "pw" });
    await mgr.signInWithPasswordStaging({ email: userB.email, password: "pw" });
    mgr.switchActiveAccount(userA.id);
    const tokenA = mgr.runtimeFor(userA.id)!.peekAccessToken()!;

    // Boundary 1a: onAuthChange held failure on A across A -> B -> A MUST NOT emit stale SIGNED_OUT after B->A!
    const events: Array<{ event: string; userId: string | null }> = [];
    const unsub = onAuthChange((event, s) => events.push({ event, userId: s?.user.id ?? null }));
    holdUserToken = tokenA;
    holdUserFail = true;
    mgr.switchActiveAccount(userB.id);
    mgr.switchActiveAccount(userA.id); // Triggers held verification #1 (gen N)
    await new Promise((r) => setTimeout(r, 15));
    const relGen1Fail = releaseHeldUser as (() => void) | null;
    releaseHeldUser = null;
    // Switch A -> B -> A again (gen N+2) while gen N verification is still held!
    mgr.switchActiveAccount(userB.id);
    mgr.switchActiveAccount(userA.id);
    const eventsAfterSwitch2 = events.length;
    // Now release the older held failure from gen N -> MUST be 100% suppressed, while gen N+2 resolves SIGNED_IN!
    relGen1Fail?.();
    await new Promise((r) => setTimeout(r, 30));
    const emittedAfterRelease = events.slice(eventsAfterSwitch2);
    assert.deepEqual(
      emittedAfterRelease,
      [{ event: "SIGNED_IN", userId: userA.id }],
      "stale onAuthChange failure from earlier A->B->A gen must be suppressed; only current gen N+2 publishes",
    );

    // Boundary 1b: Held SUCCESS on A released AFTER A->B switch -> MUST NOT publish stale SIGNED_IN for A!
    holdUserToken = tokenA;
    holdUserFail = false;
    mgr.switchActiveAccount(userB.id);
    mgr.switchActiveAccount(userA.id);
    await new Promise((r) => setTimeout(r, 15));
    const relStaleSuccess = releaseHeldUser as (() => void) | null;
    releaseHeldUser = null;
    mgr.switchActiveAccount(userB.id);
    const eventsAfterSwitchToB = events.length;
    relStaleSuccess?.();
    await new Promise((r) => setTimeout(r, 30));
    const afterStaleSuccess = events.slice(eventsAfterSwitchToB);
    assert.equal(
      afterStaleSuccess.some((e) => e.userId === userA.id),
      false,
      "stale onAuthChange success for A after switching to B must never publish",
    );

    // Boundary 1c: Held verification released AFTER unsubscribe() -> 0 events published!
    holdUserToken = tokenA;
    holdUserFail = false;
    mgr.switchActiveAccount(userA.id);
    await new Promise((r) => setTimeout(r, 15));
    const relAfterUnsub = releaseHeldUser as (() => void) | null;
    releaseHeldUser = null;
    unsub();
    const countAtUnsub = events.length;
    relAfterUnsub?.();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(events.length, countAtUnsub, "held onAuthChange verification released after unsubscribe must not publish");

    // Boundary 2a: decisionQueue page 2 held across A -> B (success response) -> throws HomeCommandRefused, drops A rows!
    mgr.switchActiveAccount(userA.id);
    const sessionA = (await mgr.runtimeFor(userA.id)!.verifySession())!;
    const home = createHomeServer(sessionA, {
      client: () => mgr.runtimeFor(userA.id)!.client,
    });
    pageRpcCalls = 0;
    holdPage2 = true;
    page2ReturnError = false;
    const dq1 = home.decisionQueue(sharedWs);
    await new Promise((r) => setTimeout(r, 20));
    mgr.switchActiveAccount(userB.id);
    (releasePage2 as (() => void) | null)?.();
    releasePage2 = null;
    await assert.rejects(() => dq1, HomeCommandRefused);
    assert.equal(pageRpcCalls, 1, "must not issue any page 3 after switch");

    // Boundary 2b: decisionQueue page 2 held across A -> B -> A with page-2 RPC error -> STILL throws (never returns partial A page-1 rows)!
    mgr.switchActiveAccount(userA.id);
    const home2 = createHomeServer(sessionA, {
      client: () => mgr.runtimeFor(userA.id)!.client,
    });
    holdPage2 = true;
    page2ReturnError = true;
    const dq2 = home2.decisionQueue(sharedWs);
    await new Promise((r) => setTimeout(r, 20));
    mgr.switchActiveAccount(userB.id);
    mgr.switchActiveAccount(userA.id);
    (releasePage2 as (() => void) | null)?.();
    releasePage2 = null;
    await assert.rejects(() => dq2, HomeCommandRefused);

    // Boundary 2c: Unchanged-account control returns both pages cleanly!
    mgr.switchActiveAccount(userA.id);
    const home3 = createHomeServer(sessionA, {
      client: () => mgr.runtimeFor(userA.id)!.client,
    });
    holdPage2 = false;
    page2ReturnError = false;
    const fullQueue = await home3.decisionQueue(sharedWs);
    assert.ok(fullQueue);
    assert.equal(fullQueue.asks.length, 2);
    assert.equal(fullQueue.truncated, false);
  } finally {
    resetAccountManagerForTesting();
    setMultiAccountEnabledForTesting(null);
  }
});

test("PR 2 HezSec C3 & C5 real-caller witness: signInWithProvider aborts before navigation when dialog closes synchronously, and signOutActiveAccount refuses missing/stale pins with 0 revoke for B", async () => {
  const url = "https://example.supabase.co";
  const deployment = { url, anonKey: "public-anon-key" };
  const userA = makeUser("11111111-1111-4111-8111-111111111111", "a@example.test", "A");
  const userB = makeUser("22222222-2222-4222-8222-222222222222", "b@example.test", "B");
  const live = new Map<string, typeof userA>();
  const loggedOutTokens: string[] = [];

  const mockFetch: typeof fetch = async (input, init) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (u.pathname.endsWith("/auth/v1/token") && u.searchParams.get("grant_type") === "password") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { email?: string };
      const who = body.email === userB.email ? userB : userA;
      const at = makeJwt(url, who.id, who.email, `sid-${who.id.slice(0, 4)}-${live.size}`);
      live.set(at, who);
      return Response.json({
        access_token: at, refresh_token: `rt-${live.size}`, expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: "bearer", user: who,
      });
    }
    if (u.pathname.endsWith("/auth/v1/user")) {
      const bearer = (new Headers(init?.headers).get("authorization") ?? "").replace(/^Bearer /i, "");
      const who = live.get(bearer);
      if (!who) return Response.json({ error_code: "session_not_found" }, { status: 403 });
      return Response.json(who);
    }
    if (u.pathname.endsWith("/auth/v1/logout")) {
      const bearer = (new Headers(init?.headers).get("authorization") ?? "").replace(/^Bearer /i, "");
      loggedOutTokens.push(bearer);
      live.delete(bearer);
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected fetch: ${u.href}`);
  };

  let holdDigest: (() => void) | null = null;
  const gatedSubtle = {
    digest: async (alg: AlgorithmIdentifier, data: BufferSource) => {
      if (holdDigest) {
        await new Promise<void>((r) => { holdDigest = r; });
      }
      return globalThis.crypto.subtle.digest(alg, data);
    },
  } as unknown as SubtleCrypto;

  const sharedLs = new MemoryStorage();
  const tabSs = new MemoryStorage();
  const locks = createLocks();
  let navigatedUrl: string | null = null;
  const origWindow = (globalThis as Record<string, unknown>).window;
  (globalThis as Record<string, unknown>).window = {
    location: {
      origin: "https://commonswarm.com",
      assign: (href: string) => { navigatedUrl = href; },
    },
  };

  setMultiAccountEnabledForTesting(true);
  configureMultiAccountForTesting({
    deployment,
    env: {
      localStorage: sharedLs,
      sessionStorage: tabSs,
      fetcher: mockFetch,
      subtle: gatedSubtle,
      webLocks: locks,
      createBroadcastChannel: noopChannel,
    },
  });
  try {
    const mgr = accountManager()!;
    await mgr.initialize();
    const resA = await mgr.signInWithPasswordStaging({ email: userA.email, password: "pw" });
    const resB = await mgr.signInWithPasswordStaging({ email: userB.email, password: "pw" });
    assert.equal(resA.kind, "promoted");
    assert.equal(resB.kind, "promoted");
    mgr.switchActiveAccount(userA.id);

    // C3: Dialog closes synchronously (shouldNavigate flips false) BEFORE queued close event fires -> 0 navigation & 0 staging!
    let dialogOpen = true;
    holdDigest = () => undefined;
    const navTask = signInWithProvider("google", "https://commonswarm.com/app", "add-account", {
      shouldNavigate: () => dialogOpen,
    });
    await new Promise((r) => setTimeout(r, 10));
    // Simulate Escape / close button flipping dialogOpen=false BEFORE dialog close event runs cancelAttempt!
    dialogOpen = false;
    const rel = holdDigest as (() => void) | null;
    holdDigest = null;
    rel?.();
    await assert.rejects(() => navTask, /cancelled/i);
    assert.equal(navigatedUrl, null, "must NEVER call window.location.assign after dialog closes");

    // C5: Peer removes A without firing storage event; calling signOutActiveAccount with absent pair (null)
    // OR departed A's exact pair MUST send 0 revokes for Account B and keep B signed in!
    const peer = new AccountManager(deployment, {
      localStorage: sharedLs, sessionStorage: new MemoryStorage(), fetcher: mockFetch, webLocks: locks, createBroadcastChannel: noopChannel,
    });
    await peer.initialize();
    await peer.signOutAccount(userA.id, resA.account.loginId);
    peer.destroy();
    loggedOutTokens.length = 0;

    // 1. Absent displayed pair (null) -> MUST refuse without falling back to ambient B!
    const refusedNull = await signOutActiveAccount(null);
    assert.equal(refusedNull?.browserSignedOut, false);
    assert.equal(refusedNull?.remoteRevocation.status, "skipped");
    assert.equal(loggedOutTokens.length, 0, "absent displayed pair must send ZERO revokes");
    assert.equal(mgr.listAccounts().some((a) => a.userId === userB.id), true, "B stays signed in");

    // 2. Empty loginId pair -> MUST refuse without falling back to ambient B!
    const refusedPartial = await signOutActiveAccount({ userId: userA.id, loginId: "" });
    assert.equal(refusedPartial?.browserSignedOut, false);
    assert.equal(refusedPartial?.remoteRevocation.status, "skipped");
    assert.equal(loggedOutTokens.length, 0, "partial displayed pair must send ZERO revokes");

    // 3. Exact departed A pair -> B stays untouched with 0 revokes!
    await signOutActiveAccount({ userId: userA.id, loginId: resA.account.loginId });
    assert.equal(loggedOutTokens.length, 0, "departed A exact pair must send ZERO revokes for B");
    assert.equal(mgr.listAccounts().some((a) => a.userId === userB.id), true, "B stays signed in");
  } finally {
    resetAccountManagerForTesting();
    setMultiAccountEnabledForTesting(null);
    if (origWindow === undefined) delete (globalThis as Record<string, unknown>).window;
    else (globalThis as Record<string, unknown>).window = origWindow;
  }
});

test("PR 2 HezSec C7 held-poll witnesses: peer sign-out and sign-out-all during held badge verification NEVER restore expired labels; trigger title clears without active email", async () => {
  const url = "https://example.supabase.co";
  const deployment = { url, anonKey: "public-anon-key" };
  const userA = makeUser("11111111-1111-4111-8111-111111111111", "a@example.test", "A");
  const userB = makeUser("22222222-2222-4222-8222-222222222222", "b@example.test", "B");
  const userC = makeUser("33333333-3333-4333-8333-333333333333", "c@example.test", "C");
  const live = new Map<string, typeof userA>();

  let holdBearer: string | null = null;
  let releaseHold: (() => void) | null = null;
  let holdReachedResolve: (() => void) | null = null;
  let holdReached = new Promise<void>((r) => { holdReachedResolve = r; });

  const fetcher: typeof fetch = async (input, init) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (u.pathname.endsWith("/auth/v1/token") && u.searchParams.get("grant_type") === "password") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { email?: string };
      const who = body.email === userB.email ? userB : body.email === userC.email ? userC : userA;
      const at = makeJwt(url, who.id, who.email, `sid-${who.id.slice(0, 4)}-${live.size}`);
      live.set(at, who);
      return Response.json({
        access_token: at, refresh_token: `rt-${live.size}`, expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: "bearer", user: who,
      });
    }
    if (u.pathname.endsWith("/auth/v1/user")) {
      const bearer = (new Headers(init?.headers).get("authorization") ?? "").replace(/^Bearer /i, "");
      if (holdBearer && bearer === holdBearer) {
        holdBearer = null;
        holdReachedResolve?.();
        await new Promise<void>((resolve) => { releaseHold = resolve; });
      }
      const who = live.get(bearer);
      if (!who) return Response.json({ error_code: "session_not_found", msg: "Session not found" }, { status: 403 });
      return Response.json(who);
    }
    if (u.pathname.endsWith("/auth/v1/logout")) {
      const bearer = (new Headers(init?.headers).get("authorization") ?? "").replace(/^Bearer /i, "");
      live.delete(bearer);
      return new Response(null, { status: 204 });
    }
    if (u.pathname.endsWith("/auth/v1/token") && u.searchParams.get("grant_type") === "refresh_token") {
      return Response.json({ error: "invalid_grant", error_description: "Refresh Token Not Found" }, { status: 400 });
    }
    throw new Error(`unexpected fetch: ${u.href}`);
  };

  const sharedLs = new MemoryStorage();
  const locks = createLocks();
  const mgr = new AccountManager(deployment, {
    localStorage: sharedLs, sessionStorage: new MemoryStorage(), fetcher, webLocks: locks, createBroadcastChannel: noopChannel,
  });
  await mgr.initialize();
  await mgr.signInWithPasswordStaging({ email: userA.email, password: "pw" });
  const promB1 = await mgr.signInWithPasswordStaging({ email: userB.email, password: "pw" });
  assert.equal(promB1.kind, "promoted");
  mgr.switchActiveAccount(userA.id);

  // Case 1: Peer tab signs out Account B WHILE poller's verifySession() is held -> ownership loss MUST NOT restore B as "Sign in again"!
  const poller = new InactiveAccountBadgePoller(mgr, async () => 1, { intervalMs: 0 });
  holdBearer = mgr.runtimeFor(userB.id)!.peekAccessToken()!;
  holdReached = new Promise<void>((r) => { holdReachedResolve = r; });
  const poll1 = poller.pollOnce();
  await holdReached;
  const peer = new AccountManager(deployment, {
    localStorage: sharedLs, sessionStorage: new MemoryStorage(), fetcher, webLocks: locks, createBroadcastChannel: noopChannel,
  });
  await peer.initialize();
  await peer.signOutAccount(userB.id, promB1.account.loginId);
  peer.destroy();
  (releaseHold as (() => void) | null)?.();
  releaseHold = null;
  await poll1;
  assert.equal(poller.isExpired(userB.id, promB1.account.loginId), false, "peer sign-out must NOT be recorded as expired");
  assert.equal(poller.expiredAccounts().length, 0, "peer sign-out must leave 0 expired cues");

  // Case 2: Sign out all + poller.clear() WHILE poller's verifySession() is held for genuinely expired B -> B's label MUST NOT return even after C signs in!
  const promB2 = await mgr.signInWithPasswordStaging({ email: userB.email, password: "pw" });
  assert.equal(promB2.kind, "promoted");
  mgr.switchActiveAccount(userA.id);
  const bToken2 = mgr.runtimeFor(userB.id)!.peekAccessToken()!;
  holdBearer = bToken2;
  holdReached = new Promise<void>((r) => { holdReachedResolve = r; });
  const poll2 = poller.pollOnce();
  await holdReached;
  // Simulate Sign out all clearing the poller & sessions while poll2 is in flight (and server returns 403 for bToken2).
  live.delete(bToken2);
  poller.clear();
  await mgr.signOutAllAccounts();
  (releaseHold as (() => void) | null)?.();
  releaseHold = null;
  await poll2;
  await mgr.signInWithPasswordStaging({ email: userC.email, password: "pw" });
  assert.equal(poller.isExpired(userB.id, promB2.account.loginId), false, "held poll after sign-out-all must NOT restore B");
  assert.equal(poller.expiredAccounts().length, 0, "B's expired label must never reappear after sign-out-all + C sign-in");
  poller.stop();
  mgr.destroy();

  // Verify trigger title is explicitly cleared when active email is absent AND C3 intent-gen guards exist in all 3 OTP surfaces.
  const [liveDash, inviteOnramp] = await Promise.all([
    readFile(new URL("../src/components/app/LiveDashboard.astro", import.meta.url), "utf8"),
    readFile(new URL("../src/components/invite/InviteOnramp.astro", import.meta.url), "utf8"),
  ]);
  assert.ok(liveDash.includes('triggerEl.removeAttribute("title")') && liveDash.includes('triggerEl?.removeAttribute("title")'));
  assert.ok(liveDash.includes("signedOutOtpIntentGen") && liveDash.includes("addAccountOtpIntentGen"));
  assert.ok(inviteOnramp.includes("inviteOtpIntentGen"));

  // Designer cf04d684/68160bac fixes: overviewNeedsYouTotal counts raw HomeOverview asks/assigned/waiting
  // (e.g., 3 open questions -> 3 waiting) and focusVisibleAccountTrigger prefers visible phone More trigger & post-switch focus return.
  assert.equal(
    overviewNeedsYouTotal({
      viewer_user_id: "u-office",
      generated_at: "2026-11-19T00:00:00Z",
      workspaces: [
        {
          workspace_id: "ws-office",
          name: "Office",
          role: "member",
          last_seen_at: "2026-11-19T00:00:00Z",
          new_messages: 0,
          content: null,
          people: [],
          needs_you: {
            asks: [
              { signal_id: "a1", from: { kind: "agent", id: "ag1", name: "Bot" }, created_at: "2026-11-19T00:00:00Z", until: "2026-11-20T00:00:00Z" },
              { signal_id: "a2", from: { kind: "agent", id: "ag1", name: "Bot" }, created_at: "2026-11-19T00:00:00Z", until: "2026-11-20T00:00:00Z" },
              { signal_id: "a3", from: { kind: "agent", id: "ag1", name: "Bot" }, created_at: "2026-11-19T00:00:00Z", until: "2026-11-20T00:00:00Z" },
            ],
            assigned: [],
            waiting: [],
          },
        },
      ],
    }),
    3,
    "overviewNeedsYouTotal must count 3 open questions from raw HomeOverview payload",
  );
  assert.equal(overviewNeedsYouTotal(null), null);
  assert.ok(liveDash.includes("return overviewNeedsYouTotal(overview);") && liveDash.includes("pendingSwitchFocusReturn"));
  assert.ok(liveDash.includes("openSignOutAllDialog(\"phone\")") && liveDash.includes("focusVisibleAccountTrigger(opener)"));
});

test("PR 2 HezSec C7 held-refresh witness: expired access token refresh interrupted by peer sign-out of inactive B is treated as signed out (0 expired labels), while genuine terminal refresh expiry control surfaces Sign in again", async () => {
  const url = "https://example.supabase.co";
  const deployment = { url, anonKey: "public-anon-key" };
  const originHash = deploymentOriginHash(url);
  const userA = makeUser("11111111-1111-4111-8111-111111111111", "a@example.test", "A");
  const userB = makeUser("22222222-2222-4222-8222-222222222222", "b@example.test", "B");
  const userC = makeUser("33333333-3333-4333-8333-333333333333", "c@example.test", "C");
  const live = new Map<string, typeof userA>();

  let holdRefresh = false;
  let releaseRefresh: (() => void) | null = null;
  let refreshHeldResolve: (() => void) | null = null;
  let refreshHeld = new Promise<void>((r) => { refreshHeldResolve = r; });

  const fetcher: typeof fetch = async (input, init) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (u.pathname.endsWith("/auth/v1/token") && u.searchParams.get("grant_type") === "password") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { email?: string };
      const who = body.email === userB.email ? userB : body.email === userC.email ? userC : userA;
      const at = makeJwt(url, who.id, who.email, `sid-${who.id.slice(0, 4)}-${live.size}`);
      live.set(at, who);
      return Response.json({
        access_token: at, refresh_token: `rt-${who.id.slice(0, 4)}-${live.size}`, expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: "bearer", user: who,
      });
    }
    if (u.pathname.endsWith("/auth/v1/token") && u.searchParams.get("grant_type") === "refresh_token") {
      if (holdRefresh) {
        holdRefresh = false;
        refreshHeldResolve?.();
        await new Promise<void>((resolve) => { releaseRefresh = resolve; });
      }
      return Response.json(
        { error: "invalid_grant", error_code: "refresh_token_not_found", msg: "Invalid Refresh Token: Refresh Token Not Found" },
        { status: 400 },
      );
    }
    if (u.pathname.endsWith("/auth/v1/user")) {
      const bearer = (new Headers(init?.headers).get("authorization") ?? "").replace(/^Bearer /i, "");
      const who = live.get(bearer);
      if (!who) return Response.json({ error_code: "session_not_found", msg: "Session not found" }, { status: 403 });
      return Response.json(who);
    }
    if (u.pathname.endsWith("/auth/v1/logout")) {
      const bearer = (new Headers(init?.headers).get("authorization") ?? "").replace(/^Bearer /i, "");
      live.delete(bearer);
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected fetch: ${u.href}`);
  };

  const sharedLs = new MemoryStorage();
  const locks = createLocks();
  const mgr = new AccountManager(deployment, {
    localStorage: sharedLs, sessionStorage: new MemoryStorage(), fetcher, webLocks: locks, createBroadcastChannel: noopChannel,
  });
  await mgr.initialize();
  await mgr.signInWithPasswordStaging({ email: userA.email, password: "pw" });
  const promB = await mgr.signInWithPasswordStaging({ email: userB.email, password: "pw" });
  const promC = await mgr.signInWithPasswordStaging({ email: userC.email, password: "pw" });
  assert.equal(promB.kind, "promoted");
  assert.equal(promC.kind, "promoted");
  mgr.switchActiveAccount(userA.id);

  // Backdate B's and C's stored expires_at and initialize a fresh tab manager so getSession()
  // inside poller.pollOnce() executes the real token refresh for BOTH B (interrupted by peer) and C (genuine expiry)!
  const expireSlot = (loginId: string): void => {
    const key = slotStorageKey(originHash, loginId);
    const saved = JSON.parse(sharedLs.getItem(key)!) as Record<string, unknown>;
    saved.expires_at = Math.floor(Date.now() / 1000) - 120;
    sharedLs.setItem(key, JSON.stringify(saved));
  };
  expireSlot(promB.account.loginId);
  expireSlot(promC.account.loginId);
  mgr.destroy();

  const tabMgr = new AccountManager(deployment, {
    localStorage: sharedLs, sessionStorage: new MemoryStorage(), fetcher, webLocks: locks, createBroadcastChannel: noopChannel,
  });
  await tabMgr.initialize();
  tabMgr.switchActiveAccount(userA.id);

  // Hold inactive B's refresh -> peer signs out inactive B (active A stays signed in so no active teardown fires!)
  // -> release refresh -> B MUST be classified as signed out (0 expired label), while owned C's genuine terminal expiry surfaces "Sign in again"!
  const poller = new InactiveAccountBadgePoller(tabMgr, async () => 1, { intervalMs: 0 });
  holdRefresh = true;
  refreshHeld = new Promise<void>((r) => { refreshHeldResolve = r; });
  const pollTask = poller.pollOnce();
  await refreshHeld;

  const peer = new AccountManager(deployment, {
    localStorage: sharedLs, sessionStorage: new MemoryStorage(), fetcher, webLocks: locks, createBroadcastChannel: noopChannel,
  });
  await peer.initialize();
  await peer.signOutAccount(userB.id, promB.account.loginId);
  peer.destroy();

  (releaseRefresh as (() => void) | null)?.();
  releaseRefresh = null;
  await pollTask;

  assert.equal(poller.isExpired(userB.id, promB.account.loginId), false, "peer sign-out during held refresh must NEVER classify B as expired");
  assert.equal(
    poller.expiredAccounts().some((a) => a.userId === userB.id),
    false,
    "peer-signed-out B must NOT appear in expiredAccounts()",
  );
  assert.equal(poller.isExpired(userC.id, promC.account.loginId), true, "genuine terminal refresh expiry control C MUST surface Sign in again");
  assert.equal(
    tabMgr.listAccounts().some((a) => a.userId === userC.id) ||
      poller.expiredAccounts().some((a) => a.userId === userC.id && a.secondary === userC.email),
    true,
    "genuine terminal expiry control C remains visible in switcher with Sign in again",
  );

  poller.stop();
  tabMgr.destroy();
});
