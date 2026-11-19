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
  assert.ok(inviteOnramp.includes("data-invite-otp-row") && inviteOnramp.includes("data-invite-otp-verify") && inviteOnramp.includes("verifyEmailOtpSignIn("));
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
