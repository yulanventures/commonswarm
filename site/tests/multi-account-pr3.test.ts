import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import {
  MULTI_ACCOUNT_ENABLED,
  MultiAccountAuthRecoveryRequired,
  postPinnedCommand,
  setMultiAccountEnabledForTesting,
  type AccountSessionRuntime,
  type MultiAccountDeployment,
  type PinnedAccountContext,
} from "../src/lib/multi-account.ts";
import {
  AuthRecoveryRequired,
  addChannelMembers,
  answerChoice,
  configureMultiAccountForTesting,
  directMessages,
  isPromotedPrivateChannelManager,
  listConversations,
  listOversightConversations,
  openConversation,
  postCommand,
  readConversationHistory,
  readOversightConversationHistory,
  resetAccountManagerForTesting,
} from "../src/lib/commonswarm.ts";
import { createOperationLifetime } from "../src/lib/conversation-dialogs.ts";
import { createHomeServer, HomeCommandRefused } from "../src/lib/home/client.ts";

const DEPLOYMENT: MultiAccountDeployment = {
  url: "https://api.pr3-witness.test",
  anonKey: "anon-pr3-key",
};

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const AGENT_A = "33333333-3333-4333-8333-333333333333";
const WS_1 = "44444444-4444-4444-8444-444444444444";
const CONV_1 = "55555555-5555-4555-8555-555555555555";
const CH_1 = "66666666-6666-4666-8666-666666666666";

function makeSession(userId: string, accessToken: string, refreshToken = `rt_${accessToken}`): Session {
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: {
      id: userId,
      aud: "authenticated",
      role: "authenticated",
      email: `${userId.slice(0, 8)}@example.test`,
      app_metadata: {},
      user_metadata: {},
      created_at: "2026-10-01T00:00:00.000Z",
    },
  } as Session;
}

function makeFakePinned(args: {
  userId: string;
  loginId?: string;
  workspaceId: string | null;
  verifySession: () => Promise<Session | null>;
  getSession?: () => Promise<{ data: { session: Session | null }; error: unknown }>;
  refreshSession?: () => Promise<{ data: { session: Session | null }; error: unknown }>;
  client?: SupabaseClient;
  isCurrent: (ws?: string | null) => boolean;
}): PinnedAccountContext {
  const runtime = {
    userId: args.userId,
    loginId: args.loginId ?? `login_${args.userId.slice(0, 8)}`,
    deployment: DEPLOYMENT,
    verifySession: args.verifySession,
    isLiveOwned: () => true,
    isDisposed: () => false,
    client: (args.client ?? {
      auth: {
        getSession: args.getSession ?? (async () => ({ data: { session: null }, error: null })),
        refreshSession: args.refreshSession ?? (async () => ({ data: { session: null }, error: null })),
      },
    }) as unknown as SupabaseClient,
  } as unknown as AccountSessionRuntime;

  return {
    runtime,
    userId: args.userId,
    loginId: runtime.loginId,
    workspaceId: args.workspaceId,
    viewGeneration: 1,
    isCurrent: args.isCurrent,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("PR3 1a: postPinnedCommand returns operation_retired before verifySession when cancelled via isAlive or AbortSignal", async () => {
  let verifyCalls = 0;
  let fetchCalls = 0;
  const sessionA = makeSession(USER_A, "tok_a1");
  const ctx = makeFakePinned({
    userId: USER_A,
    workspaceId: WS_1,
    verifySession: async () => {
      verifyCalls += 1;
      return sessionA;
    },
    isCurrent: (ws) => ws === undefined || ws === WS_1,
  });

  const resByAlive = await postPinnedCommand(ctx, "cmd-pre-1", { kind: "conversation_open", members: [] }, {
    scope: { workspaceId: WS_1 },
    expectedDeployment: DEPLOYMENT,
    isAlive: () => false,
    fetcher: async () => {
      fetchCalls += 1;
      return Response.json({ status: "accepted" });
    },
  });
  assert.equal(resByAlive.status, 0);
  assert.equal(resByAlive.body.error, "operation_retired");
  assert.equal(verifyCalls, 0);
  assert.equal(fetchCalls, 0);

  const ac = new AbortController();
  ac.abort();
  const resBySignal = await postPinnedCommand(ctx, "cmd-pre-2", { kind: "conversation_open", members: [] }, {
    scope: { workspaceId: WS_1 },
    expectedDeployment: DEPLOYMENT,
    signal: ac.signal,
    fetcher: async () => {
      fetchCalls += 1;
      return Response.json({ status: "accepted" });
    },
  });
  assert.equal(resBySignal.status, 0);
  assert.equal(resBySignal.body.error, "operation_retired");
  assert.equal(verifyCalls, 0);
  assert.equal(fetchCalls, 0);
});

test("PR3 1b: postPinnedCommand resolves operation_retired immediately when aborted while verifySession is held", async () => {
  const heldVerify = deferred<Session | null>();
  let fetchCalls = 0;
  const ac = new AbortController();
  const ctx = makeFakePinned({
    userId: USER_A,
    workspaceId: WS_1,
    verifySession: () => heldVerify.promise,
    isCurrent: (ws) => ws === undefined || ws === WS_1,
  });

  const pending = postPinnedCommand(ctx, "cmd-verify-abort", { kind: "conversation_open", members: [] }, {
    scope: { workspaceId: WS_1 },
    expectedDeployment: DEPLOYMENT,
    signal: ac.signal,
    fetcher: async () => {
      fetchCalls += 1;
      return Response.json({ status: "accepted" });
    },
  });

  ac.abort();
  const result = await pending;
  assert.equal(result.status, 0);
  assert.equal(result.body.error, "operation_retired");
  assert.equal(fetchCalls, 0);

  // Late rejection of verifySession after abort must not trigger unhandledRejection.
  heldVerify.reject(new Error("late auth failure"));
  await new Promise((r) => setTimeout(r, 10));
});

test("PR3 1c: postPinnedCommand aborts in-flight fetch immediately on dialog cancel with 0 retries", async () => {
  const sessionA = makeSession(USER_A, "tok_a_live");
  const ac = new AbortController();
  let fetchCalls = 0;
  let capturedSignal: AbortSignal | undefined;

  const ctx = makeFakePinned({
    userId: USER_A,
    workspaceId: WS_1,
    verifySession: async () => sessionA,
    isCurrent: (ws) => ws === undefined || ws === WS_1,
  });

  const fetchStarted = deferred<void>();
  const pending = postPinnedCommand(ctx, "cmd-inflight-abort", { kind: "channel_member_add", channel_id: CH_1, members: [] }, {
    scope: { workspaceId: WS_1 },
    expectedDeployment: DEPLOYMENT,
    signal: ac.signal,
    fetcher: async (_input, init) => {
      fetchCalls += 1;
      capturedSignal = init?.signal ?? undefined;
      fetchStarted.resolve();
      return await new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener("abort", () => {
          rej(new DOMException("The operation was aborted.", "AbortError"));
        }, { once: true });
      });
    },
  });

  await fetchStarted.promise;
  assert.ok(capturedSignal, "postPinnedCommand must forward caller AbortSignal to fetch");
  assert.equal(capturedSignal!.aborted, false);

  ac.abort();
  const result = await pending;
  assert.equal(capturedSignal!.aborted, true);
  assert.equal(result.status, 0);
  assert.equal(result.body.error, "operation_retired");
  assert.equal(fetchCalls, 1);
});

test("PR3 1d & 1e: postPinnedCommand NEVER retries 401 unauthenticated after dialog cancel (before or during refreshSession)", async () => {
  const sessionOld = makeSession(USER_A, "tok_old");
  const sessionFresh = makeSession(USER_A, "tok_fresh");

  // Case 1d: dialog cancelled while attempt 0 returns 401 unauthenticated.
  {
    let alive = true;
    let fetchCalls = 0;
    let getSessionCalls = 0;
    let refreshCalls = 0;
    const held401 = deferred<Response>();

    const ctx = makeFakePinned({
      userId: USER_A,
      workspaceId: WS_1,
      verifySession: async () => sessionOld,
      getSession: async () => {
        getSessionCalls += 1;
        return { data: { session: sessionOld }, error: null };
      },
      refreshSession: async () => {
        refreshCalls += 1;
        return { data: { session: sessionFresh }, error: null };
      },
      isCurrent: (ws) => ws === undefined || ws === WS_1,
    });

    const pending = postPinnedCommand(ctx, "cmd-401-cancel-1", { kind: "conversation_invite", conversation_id: CONV_1, members: [] }, {
      scope: { workspaceId: WS_1 },
      expectedDeployment: DEPLOYMENT,
      isAlive: () => alive,
      fetcher: async () => {
        fetchCalls += 1;
        return await held401.promise;
      },
    });

    await new Promise((r) => setTimeout(r, 10));
    alive = false;
    held401.resolve(Response.json({ error: "unauthenticated" }, { status: 401 }));
    const res = await pending;
    assert.equal(res.status, 0);
    assert.equal(res.body.error, "operation_retired");
    assert.equal(fetchCalls, 1, "cancelled dialog must not retry after 401");
    assert.equal(getSessionCalls, 0, "cancelled dialog must not call getSession on 401");
    assert.equal(refreshCalls, 0, "cancelled dialog must not call refreshSession on 401");
  }

  // Case 1e: dialog cancelled while 401 refreshSession() is in flight -> resolves immediately, 0 retries.
  {
    let fetchCalls = 0;
    const ac = new AbortController();
    const refreshStarted = deferred<void>();
    const heldRefresh = deferred<{ data: { session: Session | null }; error: unknown }>();

    const ctx = makeFakePinned({
      userId: USER_A,
      workspaceId: WS_1,
      verifySession: async () => sessionOld,
      getSession: async () => ({ data: { session: sessionOld }, error: null }),
      refreshSession: () => {
        refreshStarted.resolve();
        return heldRefresh.promise;
      },
      isCurrent: (ws) => ws === undefined || ws === WS_1,
    });

    const pending = postPinnedCommand(ctx, "cmd-401-cancel-2", { kind: "conversation_remove", conversation_id: CONV_1, member: { kind: "user", id: USER_B } }, {
      scope: { workspaceId: WS_1 },
      expectedDeployment: DEPLOYMENT,
      signal: ac.signal,
      fetcher: async () => {
        fetchCalls += 1;
        return Response.json({ error: "unauthenticated" }, { status: 401 });
      },
    });

    await refreshStarted.promise;
    ac.abort();
    const res = await pending;
    assert.equal(res.status, 0);
    assert.equal(res.body.error, "operation_retired");
    assert.equal(fetchCalls, 1, "aborted refresh must never dispatch retry fetch");
    heldRefresh.resolve({ data: { session: sessionFresh }, error: null });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(fetchCalls, 1, "late refresh settlement must still dispatch 0 retries");
  }

  // Case 1f (Live control): uncancelled dialog hitting 401 refreshes on ctx.runtime and retries ONCE with same command_id.
  {
    const seenAuthHeaders: string[] = [];
    const seenCommandIds: string[] = [];
    const ctx = makeFakePinned({
      userId: USER_A,
      workspaceId: WS_1,
      verifySession: async () => sessionOld,
      getSession: async () => ({ data: { session: sessionOld }, error: null }),
      refreshSession: async () => ({ data: { session: sessionFresh }, error: null }),
      isCurrent: (ws) => ws === undefined || ws === WS_1,
    });

    const res = await postPinnedCommand(ctx, "cmd-401-live-ctrl", { kind: "channel_member_add", channel_id: CH_1, members: [] }, {
      scope: { workspaceId: WS_1 },
      expectedDeployment: DEPLOYMENT,
      isAlive: () => true,
      fetcher: async (_input, init) => {
        const headers = new Headers(init?.headers);
        seenAuthHeaders.push(headers.get("authorization") ?? "");
        const parsed = JSON.parse(String(init?.body ?? "{}")) as { command_id?: string };
        seenCommandIds.push(parsed.command_id ?? "");
        if (seenAuthHeaders.length === 1) {
          return Response.json({ error: "unauthenticated" }, { status: 401 });
        }
        return Response.json({ status: "accepted" }, { status: 200 });
      },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "accepted");
    assert.deepEqual(seenAuthHeaders, ["Bearer tok_old", "Bearer tok_fresh"]);
    assert.deepEqual(seenCommandIds, ["cmd-401-live-ctrl", "cmd-401-live-ctrl"]);
  }
});

test("PR3 2: createOperationLifetime + postCommand/openConversation/addChannelMembers carry dialog cancellation through multi-account pinned transport", async () => {
  const originalFetch = globalThis.fetch;
  const sessionOld = makeSession(USER_A, "tok_dialog_old");
  const sessionFresh = makeSession(USER_A, "tok_dialog_fresh");

  try {
    setMultiAccountEnabledForTesting(true);
    let current = true;
    let fetchCalls = 0;
    let refreshCalls = 0;
    let capturedSignal: AbortSignal | undefined;
    const held401 = deferred<Response>();

    const pinned = makeFakePinned({
      userId: USER_A,
      workspaceId: WS_1,
      verifySession: async () => sessionOld,
      getSession: async () => ({ data: { session: sessionOld }, error: null }),
      refreshSession: async () => {
        refreshCalls += 1;
        return { data: { session: sessionFresh }, error: null };
      },
      isCurrent: (ws) => current && (ws === undefined || ws === WS_1),
    });

    configureMultiAccountForTesting({ deployment: DEPLOYMENT });

    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls += 1;
      capturedSignal = init?.signal ?? undefined;
      if (fetchCalls === 1) {
        return await held401.promise;
      }
      return Response.json({
        status: "accepted",
        conversation: {
          conversation_id: CONV_1,
          kind: "dm",
          generation: 1,
          members: [{ kind: "user", id: USER_A }, { kind: "user", id: USER_B }],
        },
      });
    }) as typeof fetch;

    // Retiring OperationLifetime while attempt 0 is held aborts the signal and stops 401 retry.
    const lifetime = createOperationLifetime(() => true);
    const pendingOpen = openConversation(
      sessionOld,
      "cmd-open-cancelled",
      WS_1,
      [{ kind: "user", id: USER_B }],
      false,
      { isAlive: lifetime.isAlive, signal: lifetime.signal, pinned },
    );
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(fetchCalls, 1);
    assert.ok(capturedSignal && !capturedSignal.aborted);

    lifetime.retire();
    assert.equal(lifetime.isAlive(), false);
    assert.equal(lifetime.signal.aborted, true);
    assert.equal(capturedSignal!.aborted, true);

    held401.resolve(Response.json({ error: "unauthenticated" }, { status: 401 }));
    const cancelledRes = await pendingOpen;
    assert.equal(cancelledRes.ok, false);
    assert.equal(cancelledRes.message, "Action cancelled.");
    assert.equal(fetchCalls, 1, "retired dialog must never retry 401 through postCommand -> postPinnedCommand");
    assert.equal(refreshCalls, 0);

    // Live control: uncancelled addChannelMembers through postCommand succeeds on pinned runtime.
    const liveLifetime = createOperationLifetime(() => true);
    const addRes = await addChannelMembers(
      sessionOld,
      "cmd-add-live",
      WS_1,
      CH_1,
      [{ kind: "user", id: USER_B }],
      { isAlive: liveLifetime.isAlive, signal: liveLifetime.signal, pinned },
    );
    assert.equal(addRes.ok, true);
    assert.equal(fetchCalls, 2);

    // Non-cancelled postCommand still enforces viewGeneration/account-switch fence.
    current = false;
    await assert.rejects(
      () => postCommand(sessionOld, "cmd-switched", { kind: "channel_member_add", channel_id: CH_1, members: [] }, {
        workspace_id: WS_1,
        stream: { kind: "workspace" },
      }, undefined, { pinned }),
      (err: unknown) => err instanceof AuthRecoveryRequired || err instanceof MultiAccountAuthRecoveryRequired,
    );
  } finally {
    globalThis.fetch = originalFetch;
    setMultiAccountEnabledForTesting(false);
    resetAccountManagerForTesting();
  }
});

test("PR3 3a: conversation & oversight reads pin to AccountRuntime and drop held responses across A->B and A->B->A", async () => {
  const originalFetch = globalThis.fetch;
  const sessionA = makeSession(USER_A, "tok_conv_A");

  try {
    setMultiAccountEnabledForTesting(true);
    let viewGen = 1;
    let activeUser = USER_A;
    let activeWs: string | null = WS_1;
    const seenAuth: string[] = [];

    const pinForA = (): PinnedAccountContext => {
      const capturedGen = viewGen;
      return makeFakePinned({
        userId: USER_A,
        workspaceId: WS_1,
        verifySession: async () => sessionA,
        isCurrent: (ws) =>
          viewGen === capturedGen &&
          activeUser === USER_A &&
          activeWs === WS_1 &&
          (ws === undefined || ws === WS_1),
      });
    };

    configureMultiAccountForTesting({ deployment: DEPLOYMENT });

    // 1) Held listConversations across A -> B -> A MUST reject with AuthRecoveryRequired.
    const heldConv = deferred<Response>();
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seenAuth.push(new Headers(init?.headers).get("authorization") ?? "");
      return await heldConv.promise;
    }) as typeof fetch;

    const pList = listConversations(WS_1, true, { pinned: pinForA() });
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(seenAuth, ["Bearer tok_conv_A"]);
    // Simulate A -> B -> A (same userId returns, but viewGeneration advanced!).
    activeUser = USER_B;
    viewGen += 1;
    activeUser = USER_A;
    viewGen += 1;
    heldConv.resolve(Response.json({
      conversations: [{
        conversation_id: CONV_1,
        kind: "dm",
        channel_id: null,
        slug: null,
        description: null,
        archived_at: null,
        joined: true,
        generation: 1,
        members: [],
        notify_level: "everything",
        starred: false,
        star_rank: null,
        unread_count: 0,
        mention_count: 0,
        last_message_at: null,
        last_message_id: null,
      }],
    }));
    await assert.rejects(() => pList, (err: unknown) => err instanceof AuthRecoveryRequired);

    // 2) Held listOversightConversations & readOversightConversationHistory & readConversationHistory across A -> B MUST reject.
    for (const runHeld of [
      () => listOversightConversations(WS_1, AGENT_A, { pinned: pinForA() }),
      () => readOversightConversationHistory(WS_1, CONV_1, AGENT_A, { pinned: pinForA() }),
      () => readConversationHistory(WS_1, CONV_1, { pinned: pinForA() }),
    ]) {
      const gate = deferred<Response>();
      globalThis.fetch = (async () => await gate.promise) as typeof fetch;
      const p = runHeld();
      await new Promise((r) => setTimeout(r, 10));
      activeUser = USER_B;
      viewGen += 1;
      gate.resolve(Response.json({ conversations: [], messages: [], has_more: false, next_cursor: null }));
      await assert.rejects(() => p, (err: unknown) => err instanceof AuthRecoveryRequired);
      activeUser = USER_A;
      viewGen += 1;
    }

    // 3) Aborted listConversations does NOT trigger TypeError retry.
    let abortFetchCount = 0;
    const ac = new AbortController();
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      abortFetchCount += 1;
      return await new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener("abort", () => rej(new TypeError("aborted")), { once: true });
      });
    }) as typeof fetch;
    const pAbort = listConversations(WS_1, true, { pinned: pinForA(), signal: ac.signal });
    await new Promise((r) => setTimeout(r, 10));
    ac.abort();
    await assert.rejects(() => pAbort);
    assert.equal(abortFetchCount, 1, "aborted listConversations must never retry");

    // 4) Live control on Account A succeeds cleanly.
    globalThis.fetch = (async () => Response.json({
      conversations: [{
        conversation_id: CONV_1,
        kind: "dm",
        channel_id: null,
        slug: null,
        description: null,
        archived_at: null,
        joined: true,
        generation: 1,
        members: [],
        notify_level: "everything",
        starred: false,
        star_rank: null,
        unread_count: 1,
        mention_count: 0,
        last_message_at: null,
        last_message_id: null,
      }],
    })) as typeof fetch;
    const rows = await listConversations(WS_1, true, { pinned: pinForA() });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.conversationId, CONV_1);
  } finally {
    globalThis.fetch = originalFetch;
    setMultiAccountEnabledForTesting(false);
    resetAccountManagerForTesting();
  }
});

test("PR3 3b & 3c: isPromotedPrivateChannelManager, directMessages, and waitingTodos drop stale results across switch", async () => {
  const sessionA = makeSession(USER_A, "tok_reads_A");
  try {
    setMultiAccountEnabledForTesting(true);
    let current = true;

    // 3b: isPromotedPrivateChannelManager fails closed when switched while held; returns true when current.
    const heldMgrQuery = deferred<{ data: Array<{ is_manager: boolean }>; error: null }>();
    const fakeClient = {
      schema: () => ({
        from: () => ({
          select: () => ({
            eq: function () { return this; },
            or: function () { return this; },
            order: function () { return this; },
            limit: function () { return this; },
            abortSignal: () => heldMgrQuery.promise,
          }),
        }),
        rpc: () => Promise.resolve({ data: null, error: null }),
      }),
    } as unknown as SupabaseClient;

    const pinned = makeFakePinned({
      userId: USER_A,
      workspaceId: WS_1,
      verifySession: async () => sessionA,
      client: fakeClient,
      isCurrent: (ws) => current && (ws === undefined || ws === WS_1),
    });

    const mgrPending = isPromotedPrivateChannelManager(WS_1, CH_1, USER_A, { pinned });
    await new Promise((r) => setTimeout(r, 10));
    current = false;
    heldMgrQuery.resolve({ data: [{ is_manager: true }], error: null });
    assert.equal(await mgrPending, false, "switched-away promoted-manager read must fail closed to false");

    // Live control for isPromotedPrivateChannelManager
    current = true;
    const liveMgrClient = {
      schema: () => ({
        from: () => ({
          select: () => ({
            eq: function () { return this; },
            limit: function () { return this; },
            abortSignal: async () => ({ data: [{ is_manager: true }], error: null }),
          }),
        }),
      }),
    } as unknown as SupabaseClient;
    const livePinned = makeFakePinned({
      userId: USER_A,
      workspaceId: WS_1,
      verifySession: async () => sessionA,
      client: liveMgrClient,
      isCurrent: (ws) => current && (ws === undefined || ws === WS_1),
    });
    assert.equal(await isPromotedPrivateChannelManager(WS_1, CH_1, USER_A, { pinned: livePinned }), true);

    // directMessages rejects across switch while held.
    const heldDm = deferred<{ data: unknown[]; error: null }>();
    const dmClient = {
      schema: () => ({
        from: () => ({
          select: () => ({
            eq: function () { return this; },
            or: function () { return this; },
            order: function () { return this; },
            limit: function () { return this; },
            abortSignal: () => heldDm.promise,
          }),
        }),
      }),
    } as unknown as SupabaseClient;
    const dmPinned = makeFakePinned({
      userId: USER_A,
      workspaceId: WS_1,
      verifySession: async () => sessionA,
      client: dmClient,
      isCurrent: (ws) => current && (ws === undefined || ws === WS_1),
    });
    const dmPending = directMessages(WS_1, USER_A, { kind: "person", id: USER_B }, 50, dmPinned);
    await new Promise((r) => setTimeout(r, 10));
    current = false;
    heldDm.resolve({ data: [], error: null });
    await assert.rejects(() => dmPending, (err: unknown) => err instanceof AuthRecoveryRequired);

    // 3c: createHomeServer.waitingTodos enforces pinned.isCurrent() across multi-page pagination.
    current = true;
    let pageCalls = 0;
    const page2Gate = deferred<{ data: unknown; error: null }>();
    const todosClient = {
      schema: () => ({
        rpc: async (_fn: string, params: Record<string, unknown>) => {
          pageCalls += 1;
          if (!params.p_after_todo_id) {
            return {
              data: {
                workspace_id: WS_1,
                generated_at: "2026-11-19T20:00:00.000Z",
                total: 2,
                truncated: true,
                todos: [{
                  todo_id: "77777777-7777-4777-8777-777777777771",
                  title: "Page 1 task",
                  state: "open",
                  due_on: null,
                  reason: "assigned",
                  agent_id: null,
                  state_at: "2026-11-19T19:00:00.000Z",
                  placement: "general",
                  channel_id: null,
                }],
              },
              error: null,
            };
          }
          return await page2Gate.promise;
        },
      }),
    } as unknown as SupabaseClient;
    const todosPinned = makeFakePinned({
      userId: USER_A,
      workspaceId: WS_1,
      verifySession: async () => sessionA,
      client: todosClient,
      isCurrent: () => current,
    });
    const server = createHomeServer(sessionA, {}, todosPinned);
    const waitingPromise = server.waitingTodos(WS_1);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(pageCalls, 2, "waitingTodos should have requested page 2");
    current = false;
    page2Gate.resolve({
      data: {
        workspace_id: WS_1,
        generated_at: "2026-11-19T20:00:00.000Z",
        total: 2,
        truncated: false,
        todos: [{
          todo_id: "77777777-7777-4777-8777-777777777772",
          title: "Page 2 task",
          state: "open",
          due_on: null,
          reason: "assigned",
          agent_id: null,
          state_at: "2026-11-19T18:00:00.000Z",
          placement: "general",
          channel_id: null,
        }],
      },
      error: null,
    });
    await assert.rejects(
      () => waitingPromise,
      (err: unknown) => err instanceof HomeCommandRefused && err.reason === "workspace_access_refused",
    );
  } finally {
    setMultiAccountEnabledForTesting(false);
    resetAccountManagerForTesting();
  }
});

test("PR3 4: LiveDashboard teardown isolation contract & MULTI_ACCOUNT_ENABLED remains false", () => {
  assert.equal(MULTI_ACCOUNT_ENABLED, false, "MULTI_ACCOUNT_ENABLED must remain false until GoTrue + HezOps + owner approval");
  const liveDashboard = readFileSync(new URL("../src/components/app/LiveDashboard.astro", import.meta.url), "utf8");

  // teardownActiveAccountView invokes resetWaitingPanelState + resetWorkspaceSessionState.
  const teardownMatch = liveDashboard.match(/const teardownActiveAccountView = \(\): void => \{[\s\S]*?\n    \};/);
  assert.ok(teardownMatch, "teardownActiveAccountView block must exist");
  assert.match(teardownMatch[0], /resetWaitingPanelState\(\)/, "teardownActiveAccountView must reset waiting panel state");
  assert.match(teardownMatch[0], /resetWorkspaceSessionState\(\)/, "teardownActiveAccountView must reset workspace session state");

  // resetWaitingPanelState clears DOM, surface, timer, caches, and generations.
  const waitingResetMatch = liveDashboard.match(/const resetWaitingPanelState = \(\): void => \{[\s\S]*?\n    \};/);
  assert.ok(waitingResetMatch, "resetWaitingPanelState block must exist");
  for (const snippet of [
    "waitingGeneration += 1",
    "waitingOpenEpoch += 1",
    "waitingPanelViewer = \"\"",
    "waitingPanelAsks.clear()",
    "waitingPanelTodos.clear()",
    "waitingWorkspaceChannels.clear()",
    "waitingSurface?.close(false)",
    "waitingSurface?.setEnabled(false)",
    "[data-waiting-panel]",
  ]) {
    assert.ok(waitingResetMatch[0].includes(snippet), `resetWaitingPanelState must include ${snippet}`);
  }

  // resetConversationsState aborts controllers, clears DM/directHistory/directory/dialogs/preview.
  const convResetMatch = liveDashboard.match(/const resetConversationsState = \(\): void => \{[\s\S]*?\n    \};/);
  assert.ok(convResetMatch, "resetConversationsState block must exist");
  for (const snippet of [
    "conversationsAbortController?.abort()",
    "groupLeaveAbortController?.abort()",
    "activeDm = null",
    "directHistory = null",
    "directHistoryTicket += 1",
    "channelDirectoryErrors.clear()",
    "channelUnarchivePending.clear()",
    "[data-group-leave-dialog]",
    "[data-channel-directory]",
    "[data-channel-dialog]",
    "conversationDialogsBridge?.closeAll()",
    "[data-channel-preview]",
  ]) {
    assert.ok(convResetMatch[0].includes(snippet), `resetConversationsState must include ${snippet}`);
  }

  // clearPerUserPrivateConvenienceKeys clears create-intent and add-agent keys.
  const clearKeysMatch = liveDashboard.match(/const clearPerUserPrivateConvenienceKeys = \(userId: string\): void => \{[\s\S]*?\n    \};/);
  assert.ok(clearKeysMatch, "clearPerUserPrivateConvenienceKeys block must exist");
  assert.ok(clearKeysMatch[0].includes("commonswarm:app-create-intent:v1:${userId}"));
  assert.ok(clearKeysMatch[0].includes("forgetAddAgent(addAgentStore(), userId)"));

  // Cross-workspace Waiting on you & Catch up answers route through account-routed scope pinned to owning account.
  const waitingChoiceMatch = liveDashboard.match(/const sendWaitingPanelChoice = async [\s\S]*?\n    \};/);
  assert.ok(waitingChoiceMatch, "sendWaitingPanelChoice must exist");
  assert.ok(waitingChoiceMatch[0].includes("accountWideWorkspace: true"), "sendWaitingPanelChoice must use accountWideWorkspace: true");
  assert.ok(waitingChoiceMatch[0].includes("workspaces.some(ws => ws.id === item.workspaceId)"), "sendWaitingPanelChoice must verify workspace belongs to account");

  const catchUpChoiceMatch = liveDashboard.match(/const sendCatchUpChoice = async [\s\S]*?\n    \};/);
  assert.ok(catchUpChoiceMatch, "sendCatchUpChoice must exist");
  assert.ok(catchUpChoiceMatch[0].includes("accountWideWorkspace: true"), "sendCatchUpChoice must use accountWideWorkspace: true");
  assert.ok(catchUpChoiceMatch[0].includes("workspaces.some(ws => ws.id === item.workspace.id)"), "sendCatchUpChoice must verify workspace belongs to account");

  const waitingTodoMatch = liveDashboard.match(/const markWaitingTodoDone = async [\s\S]*?\n    \};/);
  assert.ok(waitingTodoMatch, "markWaitingTodoDone must exist");
  assert.ok(waitingTodoMatch[0].includes("homeServer(pinned, { accountRouted: true })"), "markWaitingTodoDone must use accountRouted HomeServer");
  assert.ok(waitingTodoMatch[0].includes("workspaces.some(ws => ws.id === item.workspaceId)"), "markWaitingTodoDone must verify workspace belongs to account");
});

test("PR3 5: cross-workspace Waiting on you answers (answerChoice + accountRouted HomeServer) route via account-routed-workspace pinned to owning account and fail closed on switch", async () => {
  const WS_2 = "88888888-8888-4888-8888-888888888888";
  const SIG_2 = "99999999-9999-4999-8999-999999999999";
  const TODO_2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const originalFetch = globalThis.fetch;
  const sessionA = makeSession(USER_A, "tok_waiting_A");

  try {
    setMultiAccountEnabledForTesting(true);
    configureMultiAccountForTesting({ deployment: DEPLOYMENT });

    // Active workspace is WS_1, while the answered Waiting on you ask/to-do belongs to WS_2 owned by Account A.
    let activeUser = USER_A;
    let viewGen = 1;
    const makeAccountPinForA = (): PinnedAccountContext => {
      const capturedGen = viewGen;
      return makeFakePinned({
        userId: USER_A,
        workspaceId: WS_1, // User is viewing WS_1 in the rail!
        verifySession: async () => sessionA,
        isCurrent: (ws) =>
          activeUser === USER_A &&
          viewGen === capturedGen &&
          (ws === undefined || ws === WS_1),
      });
    };

    const sentEnvelopes: Array<{ auth: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      sentEnvelopes.push({ auth, body });
      const cmd = body.command as Record<string, unknown> | undefined;
      if (cmd?.kind === "household_tool" && cmd.tool === "todo_read") {
        return Response.json({
          status: "ok",
          todo: {
            todo_id: TODO_2,
            title: "Cross-workspace task",
            state: "open",
            version: 3,
          },
          comments: [],
          next_comment_offset: null,
        });
      }
      if (cmd?.kind === "household_tool" && cmd.tool === "todo_set_state") {
        return Response.json({
          status: "committed",
          value: { todo_id: TODO_2, title: "Cross-workspace task", state: "done", version: 4 },
          notices: [],
        });
      }
      return Response.json({
        status: "accepted",
        choice_answer: { option_id: "opt_yes", option_ids: ["opt_yes"], other_text: null },
      });
    }) as typeof fetch;

    // 5a: Cross-workspace answerChoice for WS_2 while viewing WS_1 succeeds via account-routed scope.
    const pinA = makeAccountPinForA();
    const ans = await answerChoice(
      sessionA,
      "cmd-waiting-ask-ws2",
      WS_2,
      SIG_2,
      false,
      { optionIds: ["opt_yes"], otherText: null },
      { pinned: pinA, accountWideWorkspace: true, isAlive: () => pinA.isCurrent() },
    );
    assert.equal(ans.ok, true);
    assert.equal(sentEnvelopes.length, 1);
    assert.equal(sentEnvelopes[0]!.auth, "Bearer tok_waiting_A");
    assert.equal(sentEnvelopes[0]!.body.workspace_id, WS_2);

    // 5a negative: Held cross-workspace answerChoice across A -> B -> A rejects with AuthRecoveryRequired (never commits).
    const heldAns = deferred<Response>();
    globalThis.fetch = (async () => await heldAns.promise) as typeof fetch;
    const pinA2 = makeAccountPinForA();
    const pendingAns = answerChoice(
      sessionA,
      "cmd-waiting-ask-switched",
      WS_2,
      SIG_2,
      false,
      { optionIds: ["opt_yes"], otherText: null },
      { pinned: pinA2, accountWideWorkspace: true },
    );
    await new Promise((r) => setTimeout(r, 10));
    activeUser = USER_B;
    viewGen += 1;
    activeUser = USER_A;
    viewGen += 1;
    heldAns.resolve(Response.json({ status: "accepted" }));
    await assert.rejects(() => pendingAns, (err: unknown) => err instanceof AuthRecoveryRequired);

    // 5b: Cross-workspace accountRouted HomeServer reads & completes WS_2 to-do while viewing WS_1.
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      sentEnvelopes.push({ auth, body });
      const cmd = body.command as Record<string, unknown> | undefined;
      if (cmd?.kind === "household_tool" && cmd.tool === "todo_read") {
        return Response.json({
          status: "ok",
          todo: { todo_id: TODO_2, title: "Cross-workspace task", state: "open", version: 3 },
          comments: [],
          next_comment_offset: null,
        });
      }
      return Response.json({
        status: "committed",
        value: { todo_id: TODO_2, title: "Cross-workspace task", state: "done", version: 4 },
        notices: [],
      });
    }) as typeof fetch;

    const pinTodoA = makeAccountPinForA();
    const routedServer = createHomeServer(sessionA, {}, pinTodoA, { accountRouted: true });
    const readRes = await routedServer.readTodo(WS_2, TODO_2);
    assert.equal(readRes.todo.version, 3);
    const doneRes = await routedServer.setTodoState(WS_2, { todo_id: TODO_2, base_version: 3, state: "done" }, "cmd-waiting-todo-ws2");
    assert.equal(doneRes.status, "committed");
    assert.equal(sentEnvelopes.at(-1)!.auth, "Bearer tok_waiting_A");
    assert.equal(sentEnvelopes.at(-1)!.body.workspace_id, WS_2);

    // 5b negative (account switch): accountRouted HomeServer fails closed once switched away from Account A.
    activeUser = USER_B;
    viewGen += 1;
    await assert.rejects(
      () => routedServer.setTodoState(WS_2, { todo_id: TODO_2, base_version: 4, state: "done" }, "cmd-waiting-todo-after-switch"),
      (err: unknown) => err instanceof HomeCommandRefused && err.reason === "workspace_access_refused",
    );

    // 5b negative (strict default): non-accountRouted HomeServer STILL refuses WS_2 when activeWorkspaceId is WS_1.
    activeUser = USER_A;
    viewGen += 1;
    const strictPin = makeAccountPinForA();
    const strictServer = createHomeServer(sessionA, {}, strictPin);
    await assert.rejects(
      () => strictServer.setTodoState(WS_2, { todo_id: TODO_2, base_version: 4, state: "done" }, "cmd-strict-ws2-refused"),
      (err: unknown) => err instanceof HomeCommandRefused && err.reason === "workspace_access_refused",
    );
  } finally {
    globalThis.fetch = originalFetch;
    setMultiAccountEnabledForTesting(false);
    resetAccountManagerForTesting();
  }
});
