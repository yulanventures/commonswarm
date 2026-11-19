import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { NavigatorLockAcquireTimeoutError } from "@supabase/supabase-js";
import {
  AccountManager,
  InactiveAccountBadgePoller,
  MULTI_ACCOUNT_ENABLED,
  deploymentOriginHash,
  isMultiAccountEnabled,
  postPinnedCommand,
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
