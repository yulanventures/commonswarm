/**
 * Mounted Dashboard C3 witnesses for Waiting on you Dismiss / Undo / Archived Restore
 * dispatch fencing and active Waiting queue read retirement across same-account access loss.
 *
 * Mounts the real compiled LiveDashboard.astro with synthetic HTTP (modeled on
 * waiting-count.observer.test.ts) and proves:
 *  1. Dismiss held during token acquisition -> same account loses conversation -> release:
 *     zero dismiss_waiting_item commands dispatched, nothing repaints.
 *  2. Dismiss 401 on first dispatch -> refresh held -> same account loses conversation -> release:
 *     retry is not sent (total attempts === 1), nothing repaints.
 *  3. Undo held during token acquisition and under 401 recovery across same-account conversation loss:
 *     zero restore_waiting_item dispatches on token hold, zero retries on 401 hold, nothing repaints.
 *  4. Archived Restore held during token acquisition and under 401 recovery across same-account
 *     conversation loss: zero dispatches on token hold, zero retries on 401 hold, nothing repaints.
 *  5. Active Waiting queue read held across same account's loss of a private channel, then of a DM:
 *     when each old read completes, zero private rows paint and a fresh authorized read is issued.
 *  6. Unchanged-access controls for Dismiss, Undo, Archived Restore (both token acquisition hold
 *     and 401 recovery) and active Waiting queue read: action sent once (or retried once on 401
 *     with the same command_id and refreshed same-login bearer) and list repaints from the fresh read.
 *  7. Same-person different-login replacement (`session_id` change with same `user.id`, no
 *     `SIGNED_OUT` event) during held acquisition and during held 401 recovery, plus empty-session
 *     during held acquisition, for Dismiss, Undo, and Archived Restore: zero commands / zero retries
 *     and nothing repaints.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { renderAstroFixture, compileFixtureFunction } from "../../../tests/astro-fixture";
import { browserTest as test } from "../../../tests/chrome.js";
import { findChrome, launchChrome } from "../../../tests/chrome.js";

function installWaitingDismissalFenceFixture() {
  const w = window as any;
  const owner = "33333333-3333-4333-8333-333333333333";
  const maya = "44444444-4444-4444-8444-444444444444";
  const agent = "22222222-2222-4222-8222-222222222222";
  const org = "55555555-5555-4555-8555-555555555555";
  const wsId = "aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const chSecret = "cccccccc-cccc-4ccc-8ccc-000000000010";
  const convGeneral = "eeeeeeee-eeee-4eee-8eee-000000000001";
  const convSecret = "eeeeeeee-eeee-4eee-8eee-000000000010";
  const convGroupSM = "eeeeeeee-eeee-4eee-8eee-000000000004";
  const dmAskId = "99999999-9999-4999-8999-000000000101";
  const privAskId = "99999999-9999-4999-8999-000000000102";
  const genAskId = "99999999-9999-4999-8999-000000000103";
  const genAsk2Id = "99999999-9999-4999-8999-000000000104";
  const triggerAsk1Id = "99999999-9999-4999-8999-000000000105";
  const triggerAsk2Id = "99999999-9999-4999-8999-000000000106";
  const batchAskIds = [
    "99999999-9999-4999-8999-000000000201",
    "99999999-9999-4999-8999-000000000202",
    "99999999-9999-4999-8999-000000000203",
    "99999999-9999-4999-8999-000000000204",
    "99999999-9999-4999-8999-000000000205",
  ];

  const scenario = new URL(location.href).searchParams.get("case") || "dismiss-token-hold-retire";
  const recent = new Date(Date.now() - 60_000).toISOString();
  const before = new Date(Date.now() - 86_400_000).toISOString();
  const until = new Date(Date.now() + 86_400_000).toISOString();
  const user = {
    id: owner,
    aud: "authenticated",
    role: "authenticated",
    email: "synthetic@example.test",
    app_metadata: {},
    user_metadata: {},
    created_at: before,
  };

  let releaseTokenHold: (() => void) | null = null;
  let releaseQueueHold: (() => void) | null = null;
  let releaseHistory404Hold: (() => void) | null = null;

  const login1SessionId = "sess-owner-login-1";
  const login2SessionId = "sess-owner-login-2";
  const makeJwt = (sub: string, sessionId: string, rev: string) =>
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
    btoa(JSON.stringify({ sub, session_id: sessionId, rev }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "") +
    ".sig";

  const isQueueReadCase = scenario.startsWith("queue-read-");
  const isArchivedCase = scenario.startsWith("archived-restore-") || scenario === "control-archived-restore";
  const isBatchCase = scenario.startsWith("batch-dismiss-");
  type HeldResponse = { status: number; body: Record<string, unknown> } | undefined;
  const heldDismisses: Array<{ itemId: string; resolve: (outcome?: HeldResponse) => void }> = [];
  const heldRestores: Array<{ itemId: string; resolve: (outcome?: HeldResponse) => void }> = [];
  const heldChoices: Array<{ signalId: string; resolve: (outcome?: HeldResponse) => void }> = [];

  const f = w.fenceFixture = {
    scenario,
    owner,
    maya,
    wsId,
    chSecret,
    convGeneral,
    convSecret,
    convGroupSM,
    dmAskId,
    privAskId,
    genAskId,
    genAsk2Id,
    triggerAsk1Id,
    triggerAsk2Id,
    batchAskIds,
    login1SessionId,
    login2SessionId,
    dmQuestion: "Private DM secret question?",
    privQuestion: "Private channel secret question?",
    genQuestion: "General authorized question?",
    genQuestion2: "Second general authorized question?",
    dismissedIds: isArchivedCase ? [dmAskId, genAskId, genAsk2Id] : [] as string[],
    answeredChoiceIds: [] as string[],
    dropGroupSM: false,
    dropSecretChannel: false,
    history404GroupSM: false,
    holdNextHistory404: false,
    history404Held: false,
    history404Reads: 0,
    conversationsRefreshes: 0,
    channelsRefreshes: 0,
    holdNextToken: false,
    tokenHeld: false,
    tokenRefreshCount: 0,
    nextRefreshSessionId: login1SessionId,
    logoutCalls: 0,
    failDismiss401Once: false,
    failRestore401Once: false,
    holdNextDismissCommand: false,
    holdDismissAtIndex: 0,
    holdNextRestoreCommand: false,
    holdNextChoiceCommand: false,
    heldDismisses,
    heldRestores,
    heldChoices,
    dismissCommands: [] as Array<{ command_id: string; item_id: string; bearer: string }>,
    restoreCommands: [] as Array<{ command_id: string; item_id: string; bearer: string }>,
    choiceCommands: [] as Array<{ command_id: string; signal_id: string; bearer: string }>,
    holdNextQueue: false,
    queueHeld: false,
    queueReads: 0,
    queueReadsAfterPrivLoss: 0,
    queueReadsAfterDmLoss: 0,
    refreshedBearer: (n: number, sessionId = login1SessionId) => `Bearer ${makeJwt(owner, sessionId, `refreshed-${n}`)}`,
    bearerHasSession: (bearer: string, sessionId: string) => {
      const token = bearer.replace(/^Bearer\s+/i, "");
      const payload = token.split(".")[1] ?? "";
      try {
        const parsed = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as { session_id?: unknown };
        return parsed.session_id === sessionId;
      } catch {
        return false;
      }
    },
    releaseTokenHold: () => { releaseTokenHold?.(); releaseTokenHold = null; },
    releaseQueueHold: () => { releaseQueueHold?.(); releaseQueueHold = null; },
    releaseHistory404Hold: () => { releaseHistory404Hold?.(); releaseHistory404Hold = null; },
    releaseHeldDismiss: (index: number, outcome?: HeldResponse) => {
      const entry = heldDismisses[index];
      if (entry) entry.resolve(outcome);
    },
    releaseHeldRestore: (index: number, outcome?: HeldResponse) => {
      const entry = heldRestores[index];
      if (entry) entry.resolve(outcome);
    },
    releaseHeldChoice: (index: number, outcome?: HeldResponse) => {
      const entry = heldChoices[index];
      if (entry) entry.resolve(outcome);
    },
    expireStoredToken: (sessionId = login1SessionId) => {
      localStorage.setItem("sb-api-auth-token", JSON.stringify({
        access_token: makeJwt(owner, sessionId, "expired"),
        refresh_token: "synthetic-refresh-1",
        token_type: "bearer",
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) - 60,
        user,
      }));
    },
    restoreFreshStoredToken: (sessionId = login1SessionId) => {
      localStorage.setItem("sb-api-auth-token", JSON.stringify({
        access_token: makeJwt(owner, sessionId, "fresh"),
        refresh_token: "synthetic-refresh-1",
        token_type: "bearer",
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        user,
      }));
    },
    clearStoredSession: () => {
      localStorage.removeItem("sb-api-auth-token");
      window.dispatchEvent(new StorageEvent("storage", {
        key: "sb-api-auth-token",
        newValue: null,
        storageArea: localStorage,
      }));
    },
    log: [] as string[],
    unexpected: [] as string[],
  };

  const activeAsks = () => {
    const baseMs = Date.now() - 600_000;
    const all = isBatchCase
      ? batchAskIds.map((signal_id, idx) => ({
          signal_id,
          from: { kind: "agent" as const, id: agent, name: "Scout" },
          body: `Batch question ${idx + 1}?`,
          offset: idx,
          conversation_id: convGeneral,
          conversation_kind: "general" as const,
        }))
      : [
      ...(!f.dropGroupSM && !f.history404GroupSM
        ? [{
            signal_id: dmAskId,
            from: { kind: "agent" as const, id: agent, name: "Scout" },
            body: f.dmQuestion,
            offset: 0,
            conversation_id: convGroupSM,
            conversation_kind: "group_dm" as const,
          }]
        : []),
      ...(isQueueReadCase && !f.dropSecretChannel
        ? [{
            signal_id: privAskId,
            from: { kind: "agent" as const, id: agent, name: "Scout" },
            body: f.privQuestion,
            offset: 1,
            conversation_id: convSecret,
            conversation_kind: "private_channel" as const,
          }]
        : []),
      {
        signal_id: genAskId,
        from: { kind: "agent" as const, id: agent, name: "Scout" },
        body: f.genQuestion,
        offset: 2,
        conversation_id: convGeneral,
        conversation_kind: "general" as const,
      },
      ...(scenario.startsWith("control-")
        ? [{
            signal_id: genAsk2Id,
            from: { kind: "agent" as const, id: agent, name: "Scout" },
            body: f.genQuestion2,
            offset: 3,
            conversation_id: convGeneral,
            conversation_kind: "general" as const,
          }]
        : []),
      ...(isQueueReadCase
        ? [
            {
              signal_id: triggerAsk1Id,
              from: { kind: "agent" as const, id: agent, name: "Scout" },
              body: "Queue trigger question one?",
              offset: 4,
              conversation_id: convGeneral,
              conversation_kind: "general" as const,
            },
            {
              signal_id: triggerAsk2Id,
              from: { kind: "agent" as const, id: agent, name: "Scout" },
              body: "Queue trigger question two?",
              offset: 5,
              conversation_id: convGeneral,
              conversation_kind: "general" as const,
            },
          ]
        : []),
    ];
    return all
      .filter((row) => !f.dismissedIds.includes(row.signal_id) && !f.answeredChoiceIds.includes(row.signal_id))
      .map((row) => ({
        signal_id: row.signal_id,
        from: row.from,
        body: row.body,
        created_at: new Date(baseMs + row.offset * 1000).toISOString(),
        until,
        conversation_id: row.conversation_id,
        conversation_kind: row.conversation_kind,
        reraised: null,
      }));
  };

  const archivedItems = () => {
    const baseMs = Date.now() - 300_000;
    const out: Array<Record<string, unknown>> = [];
    if (f.dismissedIds.includes(dmAskId) && !f.dropGroupSM && !f.history404GroupSM) {
      out.push({
        item_key: `ask:${dmAskId}`,
        kind: "ask",
        id: dmAskId,
        todo_id: null,
        ask_kind: "choice",
        title: f.dmQuestion,
        from: { kind: "agent", id: agent, name: "Scout" },
        outcome_kind: "dismissed",
        outcome_text: "Dismissed",
        archived_at: new Date(baseMs + 30_000).toISOString(),
        answered_by: { kind: "user", id: owner, name: "Synthetic owner", by_viewer: true },
        placement: "group_dm",
        channel_id: null,
        conversation_id: convGroupSM,
        conversation_kind: "group_dm",
      });
    }
    if (f.dismissedIds.includes(genAskId)) {
      out.push({
        item_key: `ask:${genAskId}`,
        kind: "ask",
        id: genAskId,
        todo_id: null,
        ask_kind: "choice",
        title: f.genQuestion,
        from: { kind: "agent", id: agent, name: "Scout" },
        outcome_kind: "dismissed",
        outcome_text: "Dismissed",
        archived_at: new Date(baseMs + 20_000).toISOString(),
        answered_by: { kind: "user", id: owner, name: "Synthetic owner", by_viewer: true },
        placement: "general",
        channel_id: null,
        conversation_id: convGeneral,
        conversation_kind: "general",
      });
    }
    if (f.dismissedIds.includes(genAsk2Id)) {
      out.push({
        item_key: `ask:${genAsk2Id}`,
        kind: "ask",
        id: genAsk2Id,
        todo_id: null,
        ask_kind: "choice",
        title: f.genQuestion2,
        from: { kind: "agent", id: agent, name: "Scout" },
        outcome_kind: "dismissed",
        outcome_text: "Dismissed",
        archived_at: new Date(baseMs + 10_000).toISOString(),
        answered_by: { kind: "user", id: owner, name: "Synthetic owner", by_viewer: true },
        placement: "general",
        channel_id: null,
        conversation_id: convGeneral,
        conversation_kind: "general",
      });
    }
    return out;
  };

  const network = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === location.origin) return network(input, init);
    const body = request.method === "POST" ? await request.json().catch(() => null) : null;
    if (url.origin !== "https://api.test.invalid") {
      f.unexpected.push(url.href);
      return Response.json({}, { status: 404 });
    }
    if (url.pathname === "/auth/v1/user") {
      return Response.json(user);
    }
    if (url.pathname === "/auth/v1/logout") {
      f.logoutCalls += 1;
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "refresh_token") {
      f.tokenRefreshCount += 1;
      const n = f.tokenRefreshCount;
      f.log.push(`auth-refresh-${n}`);
      if (f.holdNextToken) {
        f.holdNextToken = false;
        f.tokenHeld = true;
        f.log.push(`auth-refresh-held-${n}`);
        await new Promise<void>((resolve) => { releaseTokenHold = resolve; });
        f.tokenHeld = false;
        f.log.push(`auth-refresh-released-${n}`);
      }
      const refreshSessionId = f.nextRefreshSessionId;
      return Response.json({
        access_token: makeJwt(owner, refreshSessionId, `refreshed-${n}`),
        refresh_token: `synthetic-refresh-${n + 1}`,
        token_type: "bearer",
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        user,
      });
    }
    if (url.pathname === "/rest/v1/rpc/home_overview") {
      f.log.push("overview");
      const asks = activeAsks();
      return Response.json({
        viewer_user_id: owner,
        generated_at: new Date().toISOString(),
        workspaces: [{
          workspace_id: wsId,
          name: "Workspace 1",
          role: "owner",
          last_seen_at: recent,
          new_messages: 0,
          content: null,
          people: [
            { user_id: owner, display_name: "Synthetic owner", role: "owner", is_viewer: true, agents: [] },
            { user_id: maya, display_name: "Maya", role: "member", is_viewer: false, agents: [] },
          ],
          needs_you: {
            asks: asks.map((a) => ({
              signal_id: a.signal_id,
              from: { kind: a.from.kind, id: a.from.id },
              created_at: a.created_at,
              until,
            })),
            assigned: [],
            waiting: [],
          },
        }],
      });
    }
    if (url.pathname === "/rest/v1/rpc/decision_queue") {
      f.queueReads += 1;
      const snapshot = activeAsks();
      if (f.holdNextQueue) {
        f.holdNextQueue = false;
        f.queueHeld = true;
        f.log.push("queue-held");
        await new Promise<void>((resolve) => { releaseQueueHold = resolve; });
        f.queueHeld = false;
        f.log.push("queue-released");
        return Response.json({
          workspace_id: wsId,
          generated_at: new Date().toISOString(),
          total: snapshot.length,
          truncated: false,
          asks: snapshot,
        });
      }
      if (f.dropSecretChannel) f.queueReadsAfterPrivLoss += 1;
      if (f.dropGroupSM) f.queueReadsAfterDmLoss += 1;
      f.log.push("queue");
      return Response.json({
        workspace_id: wsId,
        generated_at: new Date().toISOString(),
        total: snapshot.length,
        truncated: false,
        asks: snapshot,
      });
    }
    if (url.pathname === "/rest/v1/rpc/decision_queue_page") {
      return Response.json({ code: "PGRST202", message: "function not found" }, { status: 404 });
    }
    if (url.pathname === "/rest/v1/rpc/waiting_todos_page") {
      return Response.json({ workspace_id: wsId, generated_at: new Date().toISOString(), total: 0, truncated: false, todos: [] });
    }
    if (url.pathname === "/rest/v1/rpc/waiting_archived_page") {
      f.log.push("archived");
      const items = archivedItems();
      return Response.json({
        workspace_id: wsId,
        generated_at: new Date().toISOString(),
        untrusted_content: true,
        total: items.length,
        truncated: false,
        items,
      });
    }
    if (url.pathname === "/rest/v1/rpc/ask_choices") {
      const reqIds: string[] = Array.isArray(body?.p_signal_ids) ? body.p_signal_ids : [];
      return Response.json({
        asks: reqIds.map((sigId) => ({
          signal_id: sigId,
          multi: false,
          options: [
            { id: "yes", label: "Approve", recommended: true },
            { id: "no", label: "Hold" },
          ],
          answer: null,
        })),
      });
    }
    if (url.pathname === "/rest/v1/channels" && url.searchParams.get("workspace_id") === "eq." + wsId) {
      f.channelsRefreshes += 1;
      return Response.json(
        isQueueReadCase && !f.dropSecretChannel
          ? [{ channel_id: chSecret, slug: "secret-room", title: "Secret room", kind: "private", archived_at: null }]
          : [],
      );
    }
    if (url.pathname === "/rest/v1/rpc/channel_unread") {
      return Response.json({
        workspace_id: wsId,
        generated_at: new Date().toISOString(),
        channels: [
          { channel_id: null, slug: "general", unread: null },
          ...(isQueueReadCase && !f.dropSecretChannel ? [{ channel_id: chSecret, slug: "secret-room", unread: null }] : []),
        ],
      });
    }
    if (url.pathname === "/rest/v1/workspaces") {
      return Response.json([{ workspace_id: wsId, org_id: org, name: "Workspace 1", archived_at: null }]);
    }
    if (url.pathname === "/rest/v1/member_profiles") {
      return Response.json([
        { user_id: owner, display_name: "Synthetic owner", role: "owner" },
        { user_id: maya, display_name: "Maya", role: "member" },
      ]);
    }
    if (url.pathname.startsWith("/rest/v1/")) return Response.json([]);
    if (url.pathname === "/functions/v1/read") {
      if (body?.resource === "conversations" && body?.workspace_id === wsId) {
        f.conversationsRefreshes += 1;
        f.log.push("conversations");
        const convList: Array<Record<string, unknown>> = [
          {
            conversation_id: convGeneral, kind: "general", channel_id: null, slug: "general", description: null,
            archived_at: null, joined: true, generation: 1, members: [], notify_level: "everything",
            starred: false, star_rank: null, unread_count: 0, mention_count: 0, last_message_at: recent, last_message_id: null,
          },
          ...(isQueueReadCase && !f.dropSecretChannel
            ? [{
                conversation_id: convSecret, kind: "private_channel", channel_id: chSecret, slug: "secret-room", description: null,
                archived_at: null, joined: true, generation: 1,
                members: [
                  { kind: "user", id: owner, name: "Synthetic owner", left_at: null },
                  { kind: "user", id: maya, name: "Maya", left_at: null },
                ],
                notify_level: "everything", starred: false, star_rank: null, unread_count: 0, mention_count: 0,
                last_message_at: recent, last_message_id: null,
              }]
            : []),
          ...(!f.dropGroupSM
            ? [{
                conversation_id: convGroupSM, kind: "group_dm", channel_id: null, slug: null, description: null,
                archived_at: null, joined: true, generation: 1,
                members: [
                  { kind: "user", id: owner, name: "Synthetic owner", left_at: null },
                  { kind: "agent", id: agent, name: "Scout", left_at: null },
                  { kind: "user", id: maya, name: "Maya", left_at: null },
                ],
                notify_level: "everything", starred: false, star_rank: null, unread_count: 0, mention_count: 0,
                last_message_at: recent, last_message_id: null,
              }]
            : []),
        ];
        return Response.json({ conversations: convList });
      }
      if (body?.resource === "conversation_history" && body?.workspace_id === wsId && body?.conversation_id === convGroupSM) {
        if (f.holdNextHistory404 && Boolean(body?.before_id)) {
          f.holdNextHistory404 = false;
          f.history404Held = true;
          f.log.push("conv-history-404-held");
          await new Promise<void>((resolve) => { releaseHistory404Hold = resolve; });
          f.history404Held = false;
          f.history404Reads += 1;
          f.log.push("conv-history-404-released");
          return Response.json({ error: "conversation_not_found", message: "This conversation isn't available in this workspace." }, { status: 404 });
        }
        if (f.history404GroupSM) {
          f.history404Reads += 1;
          f.log.push("conv-history-404");
          return Response.json({ error: "conversation_not_found", message: "This conversation isn't available in this workspace." }, { status: 404 });
        }
        const msgId = "99999999-9999-4999-8999-000000000088";
        return Response.json({
          conversation: {
            conversation_id: convGroupSM, kind: "group_dm", channel_id: null, slug: null, description: null,
            archived_at: null, joined: true, generation: 1,
            members: [
              { kind: "user", id: owner, name: "Synthetic owner", left_at: null },
              { kind: "agent", id: agent, name: "Scout", left_at: null },
              { kind: "user", id: maya, name: "Maya", left_at: null },
            ],
            notify_level: "everything", starred: false, star_rank: null, unread_count: 0, mention_count: 0,
            last_message_at: recent, last_message_id: msgId,
          },
          messages: [{
            id: msgId, from: agent, from_kind: "agent", to: null, to_agent: null,
            kind: "note", body: "Private group update", attachments: [], about: null, until: null,
            created_at: recent, channel_id: null, thread_root_id: null, in_reply_to: null,
            broadcast_to_channel: false, conversation_id: convGroupSM,
          }],
          has_more: true,
          next_before: { created_at: before, id: msgId },
          next_after: { created_at: recent, id: msgId },
        });
      }
      return Response.json(body?.resource === "pending_access" ? { pending: [], agents: [] } : { grants: [] });
    }
    if (url.pathname === "/functions/v1/command" && body?.command?.kind === "dismiss_waiting_item") {
      const itemId = String(body.command.item_id ?? "");
      const entry = {
        command_id: String(body.command_id ?? ""),
        item_id: itemId,
        bearer: request.headers.get("authorization") ?? "",
      };
      f.dismissCommands.push(entry);
      if (f.failDismiss401Once) {
        f.failDismiss401Once = false;
        f.log.push("dismiss-401");
        return Response.json({ error: "unauthenticated", message: "expired" }, { status: 401 });
      }
      if (f.holdNextDismissCommand || (f.holdDismissAtIndex > 0 && f.dismissCommands.length === f.holdDismissAtIndex)) {
        f.holdNextDismissCommand = false;
        if (f.dismissCommands.length === f.holdDismissAtIndex) f.holdDismissAtIndex = 0;
        f.log.push("dismiss-held:" + itemId);
        const outcome = await new Promise<HeldResponse>((resolve) => {
          heldDismisses.push({ itemId, resolve });
        });
        f.log.push("dismiss-released:" + itemId);
        if (outcome) return Response.json(outcome.body, { status: outcome.status });
      }
      if (!f.dismissedIds.includes(itemId)) f.dismissedIds.push(itemId);
      f.log.push("dismiss-ok:" + itemId);
      return Response.json({
        status: "accepted",
        ok: true,
        event_ids: [],
        item_kind: body.command.item_kind,
        item_id: itemId,
        dismissed: true,
        dismissed_at: new Date().toISOString(),
      });
    }
    if (url.pathname === "/functions/v1/command" && body?.command?.kind === "restore_waiting_item") {
      const itemId = String(body.command.item_id ?? "");
      const entry = {
        command_id: String(body.command_id ?? ""),
        item_id: itemId,
        bearer: request.headers.get("authorization") ?? "",
      };
      f.restoreCommands.push(entry);
      if (f.failRestore401Once) {
        f.failRestore401Once = false;
        f.log.push("restore-401");
        return Response.json({ error: "unauthenticated", message: "expired" }, { status: 401 });
      }
      if (f.holdNextRestoreCommand) {
        f.holdNextRestoreCommand = false;
        f.log.push("restore-held:" + itemId);
        const outcome = await new Promise<HeldResponse>((resolve) => {
          heldRestores.push({ itemId, resolve });
        });
        f.log.push("restore-released:" + itemId);
        if (outcome) return Response.json(outcome.body, { status: outcome.status });
      }
      f.dismissedIds = f.dismissedIds.filter((id: string) => id !== itemId);
      f.log.push("restore-ok:" + itemId);
      return Response.json({
        status: "accepted",
        ok: true,
        event_ids: [],
        item_kind: body.command.item_kind,
        item_id: itemId,
        restored: true,
        restored_at: new Date().toISOString(),
      });
    }
    if (url.pathname === "/functions/v1/command" && body?.command?.kind === "answer_choice") {
      const signalId = String(body.command.signal_id ?? "");
      const entry = {
        command_id: String(body.command_id ?? ""),
        signal_id: signalId,
        bearer: request.headers.get("authorization") ?? "",
      };
      f.choiceCommands.push(entry);
      if (f.holdNextChoiceCommand) {
        f.holdNextChoiceCommand = false;
        f.log.push("choice-held:" + signalId);
        const outcome = await new Promise<HeldResponse>((resolve) => {
          heldChoices.push({ signalId, resolve });
        });
        f.log.push("choice-released:" + signalId);
        if (outcome) return Response.json(outcome.body, { status: outcome.status });
      }
      if (!f.answeredChoiceIds.includes(signalId)) f.answeredChoiceIds.push(signalId);
      f.log.push("choice-ok:" + signalId);
      const optIds = Array.isArray(body.command.option_ids)
        ? body.command.option_ids
        : typeof body.command.option_id === "string"
          ? [body.command.option_id]
          : ["yes"];
      return Response.json({
        status: "accepted",
        ok: true,
        choice_answer: {
          option_id: optIds[0] ?? "yes",
          option_ids: optIds,
          other_text: typeof body.command.other_text === "string" ? body.command.other_text : null,
        },
      });
    }
    if (url.pathname === "/functions/v1/command" && body?.command?.kind === "channel_preference_set") {
      return Response.json({ status: "accepted", ok: true });
    }
    if (url.pathname === "/functions/v1/command") {
      return Response.json({ status: "refused", reason: "content_consent_required" });
    }
    f.unexpected.push(request.method + " " + url.pathname);
    return Response.json({ error: "unexpected_fixture_request" }, { status: 404 });
  };

  f.restoreFreshStoredToken();
}

async function observeWaitingDismissalFence() {
  const w = window as any;
  const f = w.fenceFixture;
  const tick = async () => { const r = fetch("/__observer-tick"); await r; };
  const steps: string[] = [];
  const shown = (node: Element | null | undefined): boolean => {
    if (!node) return false;
    const box = node.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && getComputedStyle(node).display !== "none";
  };
  const control = () => document.querySelector<HTMLAnchorElement>("[data-home-workspace-shell] .hm-ws-header__actions > a.cs-waiting");
  const panel = () => document.querySelector<HTMLElement>("#cs-waiting-panel");
  const scope = () => panel()?.querySelector<HTMLSelectElement>("[data-waiting-scope]") ?? null;
  const card = (id: string) => panel()?.querySelector<HTMLElement>(`[data-waiting-card="${id}"]`) ?? null;
  const dismissedRow = (id: string) => panel()?.querySelector<HTMLElement>(`[data-waiting-dismissed="ask:${id}"]`) ?? null;
  const archivedCard = (id: string) => panel()?.querySelector<HTMLElement>(`[data-waiting-archived-item="ask:${id}"]`) ?? null;
  const groupSMLink = () => document.querySelector<HTMLElement>(`[data-rail-conversation="${f.convGroupSM}"]`);
  const loadOlderFeed = () => document.querySelector<HTMLButtonElement>("[data-load-older]");
  const starBtn = () => document.querySelector<HTMLButtonElement>("[data-home-workspace-header] [data-channel-star]");
  let pendingWaitLabel: string | null = null;
  const state = () => "scenario=" + f.scenario +
    ", pendingWait=" + String(pendingWaitLabel) +
    ", holds=" + JSON.stringify({
      tokenHeld: f.tokenHeld,
      holdNextToken: f.holdNextToken,
      history404Held: f.history404Held,
      holdNextHistory404: f.holdNextHistory404,
      queueHeld: f.queueHeld,
      holdNextQueue: f.holdNextQueue,
      heldDismisses: f.heldDismisses.length,
      heldRestores: f.heldRestores.length,
      heldChoices: f.heldChoices.length,
    }) +
    ", counters=" + JSON.stringify({
      tokenRefreshCount: f.tokenRefreshCount,
      history404Reads: f.history404Reads,
      conversationsRefreshes: f.conversationsRefreshes,
      queueReads: f.queueReads,
      logoutCalls: f.logoutCalls,
    }) +
    ", dom=" + JSON.stringify({
      panelOpen: shown(panel()),
      railHasGroupDm: Boolean(groupSMLink()),
      loadOlderShown: shown(loadOlderFeed()),
      loadOlderDisabled: loadOlderFeed()?.disabled ?? null,
      surveySendText: panel()?.querySelector("[data-waiting-survey-send]")?.textContent ?? null,
      surveySendDisabled: panel()?.querySelector("[data-waiting-survey-send]")?.getAttribute("aria-disabled") ?? null,
    }) +
    ", dismissCmds=" + JSON.stringify(f.dismissCommands) +
    ", restoreCmds=" + JSON.stringify(f.restoreCommands) +
    ", choiceCmds=" + JSON.stringify(f.choiceCommands) +
    ", log=" + f.log.join(" ") +
    ", steps=" + steps.join(" | ");
  const wait = async (predicate: () => unknown, label: string) => {
    pendingWaitLabel = label;
    for (let i = 0; i < 600; i++) {
      if (predicate()) {
        pendingWaitLabel = null;
        steps.push(label);
        return;
      }
      await tick();
    }
    throw new Error("timed out at " + label + "; " + state());
  };
  const check = (value: unknown, message: string) => {
    if (!value) throw new Error(message + "; " + state());
  };
  const openPanelWorkspaceScope = async (archived = false) => {
    await wait(() => shown(control()), "Waiting control mounted");
    control()!.click();
    await wait(() => shown(panel()) && scope() !== null, "Waiting panel opened");
    if (archived) {
      panel()!.querySelector<HTMLButtonElement>('[data-waiting-tab="archived"]')!.click();
      await wait(() => panel()?.querySelector('[data-waiting-tab="archived"][aria-selected="true"]') !== null, "Archived tab selected");
    }
    scope()!.value = "workspace";
    scope()!.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const openGroupDmFeed = async () => {
    await wait(() => shown(groupSMLink()), "group DM link rendered in rail");
    groupSMLink()!.click();
    await wait(() => groupSMLink()?.getAttribute("aria-current") === "page" && shown(loadOlderFeed()) && !loadOlderFeed()!.disabled,
      "opened group DM with Load older ready");
  };
  // Pre-authorize the conversation_history read BEFORE the action's token refresh holds
  // Supabase's navigatorLock, so the authoritative 404 arrives cleanly while the token hold is active.
  const armGroupDmHistory404 = async () => {
    f.holdNextHistory404 = true;
    loadOlderFeed()!.click();
    await wait(() => f.history404Held, "pre-authorized conversation_history 404 held in flight");
  };
  const deliverGroupDmLossViaHeldHistory404 = async () => {
    f.history404GroupSM = true;
    f.dropGroupSM = true;
    f.releaseHistory404Hold();
    await wait(() => f.history404Reads >= 1 && !document.querySelector(`[data-rail-conversation="${f.convGroupSM}"]`),
      "same account lost group DM via authoritative 404 eviction");
  };
  const settleTicks = async () => {
    for (let i = 0; i < 25; i++) await tick();
  };
  // Triggers a same-person replacement login (login1 -> login2, NO SIGNED_OUT) while an HTTP command
  // response is held. Because the held command already completed getSession(), the auth lock is free
  // and starBtn() triggers an immediate refresh -> TOKEN_REFRESHED(login2) -> synchronous Waiting retirement + reboot.
  const swapToLogin2 = async () => {
    const refreshesBefore = f.tokenRefreshCount;
    f.nextRefreshSessionId = f.login2SessionId;
    f.expireStoredToken(f.login1SessionId);
    check(Boolean(starBtn()), "header star button missing for same-person login swap");
    starBtn()!.click();
    await wait(() => f.tokenRefreshCount > refreshesBefore && !shown(panel()),
      "same-person replacement login retired Waiting panel synchronously");
    await wait(() => shown(control()), "replacement login 2 booted with Waiting control");
  };

  try {
    // 1. Dismiss held during token acquisition -> same account loses conversation -> release -> 0 dispatches, nothing repaints.
    if (f.scenario === "dismiss-token-hold-retire") {
      await openGroupDmFeed();
      await openPanelWorkspaceScope(false);
      await wait(() => shown(card(f.dmAskId)) && shown(card(f.genAskId)), "DM and #general asks rendered");
      await armGroupDmHistory404();
      f.holdNextToken = true;
      f.expireStoredToken();
      card(f.dmAskId)!.querySelector<HTMLButtonElement>(`[data-waiting-dismiss="ask"][data-waiting-dismiss-id="${f.dmAskId}"]`)!.click();
      await wait(() => f.tokenHeld && shown(dismissedRow(f.dmAskId)), "Dismiss entered held token acquisition with in-place Dismissed row");
      check(f.dismissCommands.length === 0, "no dismiss command dispatched while token acquisition is held");
      await deliverGroupDmLossViaHeldHistory404();
      await wait(() => !dismissedRow(f.dmAskId) && !card(f.dmAskId), "Dismissed row retired synchronously on DM loss");
      check(f.tokenHeld, "token acquisition must still be held when DM loss retires Dismiss");
      f.releaseTokenHold();
      await settleTicks();
      check(f.dismissCommands.length === 0, "retired Dismiss must dispatch ZERO commands after token acquisition releases");
      check(!card(f.dmAskId) && !dismissedRow(f.dmAskId), "DM card or Dismissed row must not repaint");
      check(!(panel()!.textContent ?? "").includes(f.dmQuestion), "DM question text must stay absent from panel");
      check(shown(card(f.genAskId)), "unchanged #general ask stays painted");
      document.documentElement.dataset.fenceObservation = JSON.stringify({ ok: true, scenario: f.scenario, steps, unexpected: f.unexpected });
      return;
    }

    // 2. Dismiss 401 on first dispatch -> recovery held -> same account loses conversation -> release -> no retry, nothing repaints.
    if (f.scenario === "dismiss-401-hold-retire") {
      await openGroupDmFeed();
      await openPanelWorkspaceScope(false);
      await wait(() => shown(card(f.dmAskId)) && shown(card(f.genAskId)), "DM and #general asks rendered");
      await armGroupDmHistory404();
      f.failDismiss401Once = true;
      f.holdNextToken = true;
      card(f.dmAskId)!.querySelector<HTMLButtonElement>(`[data-waiting-dismiss="ask"][data-waiting-dismiss-id="${f.dmAskId}"]`)!.click();
      await wait(() => f.tokenHeld && f.dismissCommands.length === 1, "Dismiss hit 401 and entered held recovery refresh");
      await deliverGroupDmLossViaHeldHistory404();
      await wait(() => !dismissedRow(f.dmAskId) && !card(f.dmAskId), "Dismissed row retired synchronously on DM loss");
      check(f.tokenHeld, "401 recovery refresh must still be held when DM loss retires Dismiss");
      f.releaseTokenHold();
      await settleTicks();
      check(f.dismissCommands.length === 1, "retired Dismiss must NOT send a 401 retry after DM loss");
      check(!card(f.dmAskId) && !dismissedRow(f.dmAskId), "DM card or Dismissed row must not repaint");
      check(!(panel()!.textContent ?? "").includes(f.dmQuestion), "DM question text must stay absent from panel");
      check(shown(card(f.genAskId)), "unchanged #general ask stays painted");
      document.documentElement.dataset.fenceObservation = JSON.stringify({ ok: true, scenario: f.scenario, steps, unexpected: f.unexpected });
      return;
    }

    // 3a. Undo held during token acquisition -> same account loses conversation -> release -> 0 restore dispatches, nothing repaints.
    if (f.scenario === "undo-token-hold-retire") {
      await openGroupDmFeed();
      await openPanelWorkspaceScope(false);
      await wait(() => shown(card(f.dmAskId)) && shown(card(f.genAskId)), "DM and #general asks rendered");
      const readsBeforeDismiss = f.queueReads;
      card(f.dmAskId)!.querySelector<HTMLButtonElement>(`[data-waiting-dismiss="ask"][data-waiting-dismiss-id="${f.dmAskId}"]`)!.click();
      await wait(() => f.dismissCommands.length === 1 && f.queueReads > readsBeforeDismiss && shown(dismissedRow(f.dmAskId)), "DM ask dismissed and Undo visible");
      await armGroupDmHistory404();
      f.holdNextToken = true;
      f.expireStoredToken();
      dismissedRow(f.dmAskId)!.querySelector<HTMLButtonElement>(`[data-waiting-undo="ask:${f.dmAskId}"]`)!.click();
      await wait(() => f.tokenHeld, "Undo entered held token acquisition");
      check(f.restoreCommands.length === 0, "no restore command dispatched while token acquisition is held");
      await deliverGroupDmLossViaHeldHistory404();
      await wait(() => !dismissedRow(f.dmAskId) && !card(f.dmAskId), "Undo row retired synchronously on DM loss");
      check(f.tokenHeld, "token acquisition must still be held when DM loss retires Undo");
      f.releaseTokenHold();
      await settleTicks();
      check(f.restoreCommands.length === 0, "retired Undo must dispatch ZERO restore commands after token acquisition releases");
      check(!card(f.dmAskId) && !dismissedRow(f.dmAskId), "DM card or Undo row must not repaint");
      check(!(panel()!.textContent ?? "").includes(f.dmQuestion), "DM question text must stay absent from panel");
      check(shown(card(f.genAskId)), "unchanged #general ask stays painted");
      document.documentElement.dataset.fenceObservation = JSON.stringify({ ok: true, scenario: f.scenario, steps, unexpected: f.unexpected });
      return;
    }

    // 3b. Undo 401 on first dispatch -> recovery held -> same account loses conversation -> release -> no retry, nothing repaints.
    if (f.scenario === "undo-401-hold-retire") {
      await openGroupDmFeed();
      await openPanelWorkspaceScope(false);
      await wait(() => shown(card(f.dmAskId)) && shown(card(f.genAskId)), "DM and #general asks rendered");
      const readsBeforeDismiss = f.queueReads;
      card(f.dmAskId)!.querySelector<HTMLButtonElement>(`[data-waiting-dismiss="ask"][data-waiting-dismiss-id="${f.dmAskId}"]`)!.click();
      await wait(() => f.dismissCommands.length === 1 && f.queueReads > readsBeforeDismiss && shown(dismissedRow(f.dmAskId)), "DM ask dismissed and Undo visible");
      await armGroupDmHistory404();
      f.failRestore401Once = true;
      f.holdNextToken = true;
      dismissedRow(f.dmAskId)!.querySelector<HTMLButtonElement>(`[data-waiting-undo="ask:${f.dmAskId}"]`)!.click();
      await wait(() => f.tokenHeld && f.restoreCommands.length === 1, "Undo hit 401 and entered held recovery refresh");
      await deliverGroupDmLossViaHeldHistory404();
      await wait(() => !dismissedRow(f.dmAskId) && !card(f.dmAskId), "Undo row retired synchronously on DM loss");
      check(f.tokenHeld, "401 recovery refresh must still be held when DM loss retires Undo");
      f.releaseTokenHold();
      await settleTicks();
      check(f.restoreCommands.length === 1, "retired Undo must NOT send a 401 retry after DM loss");
      check(!card(f.dmAskId) && !dismissedRow(f.dmAskId), "DM card or Undo row must not repaint");
      check(!(panel()!.textContent ?? "").includes(f.dmQuestion), "DM question text must stay absent from panel");
      check(shown(card(f.genAskId)), "unchanged #general ask stays painted");
      document.documentElement.dataset.fenceObservation = JSON.stringify({ ok: true, scenario: f.scenario, steps, unexpected: f.unexpected });
      return;
    }

    // 4a. Archived Restore held during token acquisition -> same account loses conversation -> release -> 0 dispatches, nothing repaints.
    if (f.scenario === "archived-restore-token-hold-retire") {
      await openGroupDmFeed();
      await openPanelWorkspaceScope(true);
      await wait(() => shown(archivedCard(f.dmAskId)) && shown(archivedCard(f.genAskId)), "dismissed DM and #general items rendered in Archived");
      await armGroupDmHistory404();
      f.holdNextToken = true;
      f.expireStoredToken();
      archivedCard(f.dmAskId)!.querySelector<HTMLButtonElement>(`[data-waiting-archived-restore="ask:${f.dmAskId}"]`)!.click();
      await wait(() => f.tokenHeld, "Archived Restore entered held token acquisition");
      check(f.restoreCommands.length === 0, "no restore command dispatched while token acquisition is held");
      await deliverGroupDmLossViaHeldHistory404();
      // Cache invalidation clears the DM item synchronously; revalidation of #general completes once the auth lock releases.
      await wait(() => !archivedCard(f.dmAskId), "DM item cleared synchronously from Archived on DM loss");
      check(f.tokenHeld, "token acquisition must still be held when DM loss retires Archived Restore");
      f.releaseTokenHold();
      await wait(() => shown(archivedCard(f.genAskId)), "unchanged #general archived item repainted after revalidation");
      await settleTicks();
      check(f.restoreCommands.length === 0, "retired Archived Restore must dispatch ZERO commands after token acquisition releases");
      check(!archivedCard(f.dmAskId), "lost DM item must not repaint in Archived");
      check(!(panel()!.textContent ?? "").includes(f.dmQuestion), "DM question text must stay absent from Archived");
      check(shown(archivedCard(f.genAskId)), "unchanged #general archived item remains painted");
      document.documentElement.dataset.fenceObservation = JSON.stringify({ ok: true, scenario: f.scenario, steps, unexpected: f.unexpected });
      return;
    }

    // 4b. Archived Restore 401 on first dispatch -> recovery held -> same account loses conversation -> release -> no retry, nothing repaints.
    if (f.scenario === "archived-restore-401-hold-retire") {
      await openGroupDmFeed();
      await openPanelWorkspaceScope(true);
      await wait(() => shown(archivedCard(f.dmAskId)) && shown(archivedCard(f.genAskId)), "dismissed DM and #general items rendered in Archived");
      await armGroupDmHistory404();
      f.failRestore401Once = true;
      f.holdNextToken = true;
      archivedCard(f.dmAskId)!.querySelector<HTMLButtonElement>(`[data-waiting-archived-restore="ask:${f.dmAskId}"]`)!.click();
      await wait(() => f.tokenHeld && f.restoreCommands.length === 1, "Archived Restore hit 401 and entered held recovery refresh");
      await deliverGroupDmLossViaHeldHistory404();
      // Cache invalidation clears the DM item synchronously; revalidation of #general completes once the auth lock releases.
      await wait(() => !archivedCard(f.dmAskId), "DM item cleared synchronously from Archived on DM loss");
      check(f.tokenHeld, "401 recovery refresh must still be held when DM loss retires Archived Restore");
      f.releaseTokenHold();
      await wait(() => shown(archivedCard(f.genAskId)), "unchanged #general archived item repainted after revalidation");
      await settleTicks();
      check(f.restoreCommands.length === 1, "retired Archived Restore must NOT send a 401 retry after DM loss");
      check(!archivedCard(f.dmAskId), "lost DM item must not repaint in Archived");
      check(!(panel()!.textContent ?? "").includes(f.dmQuestion), "DM question text must stay absent from Archived");
      check(shown(archivedCard(f.genAskId)), "unchanged #general archived item remains painted");
      document.documentElement.dataset.fenceObservation = JSON.stringify({ ok: true, scenario: f.scenario, steps, unexpected: f.unexpected });
      return;
    }

    // 5. Active Waiting queue read held across private-channel loss, then across DM loss:
    //    when each old read completes, zero private rows paint and a fresh authorized read is issued.
    if (f.scenario === "queue-read-held-private-channel-then-dm-loss") {
      await openPanelWorkspaceScope(false);
      await wait(() => shown(card(f.privAskId)) && shown(card(f.dmAskId)) && shown(card(f.genAskId)) && shown(card(f.triggerAsk1Id)),
        "private-channel, DM, and #general active Waiting rows loaded");
      // Phase A: hold an active Waiting queue read carrying privAskId, then lose #secret-room.
      f.holdNextQueue = true;
      card(f.triggerAsk1Id)!.querySelector<HTMLButtonElement>(`[data-waiting-dismiss="ask"][data-waiting-dismiss-id="${f.triggerAsk1Id}"]`)!.click();
      await wait(() => f.queueHeld, "pre-loss active Waiting queue read held before private-channel loss");
      const convBeforePriv = f.conversationsRefreshes;
      f.dropSecretChannel = true;
      check(Boolean(starBtn()), "#general header star button missing");
      starBtn()!.click();
      await wait(() => f.conversationsRefreshes > convBeforePriv && f.queueReadsAfterPrivLoss >= 1 && !card(f.privAskId) && shown(card(f.dmAskId)) && shown(card(f.genAskId)),
        "private-channel loss retired held read, pruned private row, and issued fresh authorized read");
      f.releaseQueueHold();
      await settleTicks();
      check(!card(f.privAskId), "late pre-loss queue read must NOT repaint lost private-channel row");
      check(!(panel()!.textContent ?? "").includes(f.privQuestion), "lost private-channel question text leaked into panel");
      check(shown(card(f.dmAskId)) && shown(card(f.genAskId)), "still-authorized DM and #general rows remain painted");

      // Phase B: hold a second active Waiting queue read carrying dmAskId, then lose convGroupSM.
      f.holdNextQueue = true;
      card(f.triggerAsk2Id)!.querySelector<HTMLButtonElement>(`[data-waiting-dismiss="ask"][data-waiting-dismiss-id="${f.triggerAsk2Id}"]`)!.click();
      await wait(() => f.queueHeld, "pre-loss active Waiting queue read held before DM loss");
      const convBeforeDm = f.conversationsRefreshes;
      f.dropGroupSM = true;
      starBtn()!.click();
      await wait(() => f.conversationsRefreshes > convBeforeDm && f.queueReadsAfterDmLoss >= 1 && !card(f.dmAskId) && shown(card(f.genAskId)),
        "DM loss retired held read, pruned DM row, and issued fresh authorized read");
      f.releaseQueueHold();
      await settleTicks();
      check(!card(f.privAskId) && !card(f.dmAskId), "late pre-loss queue read must NOT repaint lost private-channel or DM rows");
      const panelText = panel()!.textContent ?? "";
      check(!panelText.includes(f.privQuestion) && !panelText.includes(f.dmQuestion),
        "private text leaked into Waiting panel: " + panelText);
      check(shown(card(f.genAskId)), "unchanged #general ask remains cleanly painted");
      document.documentElement.dataset.fenceObservation = JSON.stringify({ ok: true, scenario: f.scenario, steps, unexpected: f.unexpected });
      return;
    }

    // 6a. Unchanged-access controls for Dismiss (token acquisition hold AND 401 recovery).
    if (f.scenario === "control-dismiss") {
      await openPanelWorkspaceScope(false);
      await wait(() => shown(card(f.genAskId)) && shown(card(f.genAsk2Id)), "both #general asks rendered for Dismiss controls");
      const readsBefore1 = f.queueReads;
      f.holdNextToken = true;
      f.expireStoredToken();
      card(f.genAskId)!.querySelector<HTMLButtonElement>(`[data-waiting-dismiss="ask"][data-waiting-dismiss-id="${f.genAskId}"]`)!.click();
      await wait(() => f.tokenHeld, "control Dismiss 1 entered held token acquisition");
      f.releaseTokenHold();
      await wait(() => f.dismissCommands.length === 1 && f.queueReads > readsBefore1 && !card(f.genAskId),
        "unchanged-access Dismiss sent once after token acquisition and repainted from fresh read");
      check(f.dismissCommands[0]!.bearer === f.refreshedBearer(1),
        "expected refreshed same-login bearer after token acquisition: " + JSON.stringify(f.dismissCommands));

      const readsBefore2 = f.queueReads;
      f.failDismiss401Once = true;
      f.holdNextToken = true;
      card(f.genAsk2Id)!.querySelector<HTMLButtonElement>(`[data-waiting-dismiss="ask"][data-waiting-dismiss-id="${f.genAsk2Id}"]`)!.click();
      await wait(() => f.tokenHeld && f.dismissCommands.length === 2, "control Dismiss 2 hit 401 and entered held recovery");
      f.releaseTokenHold();
      await wait(() => f.dismissCommands.length === 3 && f.queueReads > readsBefore2 && !card(f.genAsk2Id),
        "unchanged-access Dismiss retried once after 401 recovery and repainted from fresh read");
      check(f.dismissCommands[1]!.command_id === f.dismissCommands[2]!.command_id &&
        f.dismissCommands[2]!.bearer === f.refreshedBearer(2),
        "401 retry must reuse command_id with refreshed same-login bearer: " + JSON.stringify(f.dismissCommands));
      document.documentElement.dataset.fenceObservation = JSON.stringify({ ok: true, scenario: f.scenario, steps, unexpected: f.unexpected });
      return;
    }

    // 6b. Unchanged-access controls for Undo (token acquisition hold AND 401 recovery).
    if (f.scenario === "control-undo") {
      await openPanelWorkspaceScope(false);
      await wait(() => shown(card(f.genAskId)) && shown(card(f.genAsk2Id)), "both #general asks rendered for Undo controls");
      const readsBeforeD1 = f.queueReads;
      card(f.genAskId)!.querySelector<HTMLButtonElement>(`[data-waiting-dismiss="ask"][data-waiting-dismiss-id="${f.genAskId}"]`)!.click();
      await wait(() => f.dismissCommands.length === 1 && f.queueReads > readsBeforeD1 && shown(dismissedRow(f.genAskId)), "ask 1 dismissed");
      const readsBefore1 = f.queueReads;
      f.holdNextToken = true;
      f.expireStoredToken();
      dismissedRow(f.genAskId)!.querySelector<HTMLButtonElement>(`[data-waiting-undo="ask:${f.genAskId}"]`)!.click();
      await wait(() => f.tokenHeld, "control Undo 1 entered held token acquisition");
      f.releaseTokenHold();
      await wait(() => f.restoreCommands.length === 1 && f.queueReads > readsBefore1 && shown(card(f.genAskId)) && !dismissedRow(f.genAskId),
        "unchanged-access Undo sent once after token acquisition and repainted restored card from fresh read");
      check(f.restoreCommands[0]!.bearer === f.refreshedBearer(1),
        "expected refreshed same-login bearer after Undo token acquisition: " + JSON.stringify(f.restoreCommands));

      const readsBeforeD2 = f.queueReads;
      card(f.genAsk2Id)!.querySelector<HTMLButtonElement>(`[data-waiting-dismiss="ask"][data-waiting-dismiss-id="${f.genAsk2Id}"]`)!.click();
      await wait(() => f.dismissCommands.length === 2 && f.queueReads > readsBeforeD2 && shown(dismissedRow(f.genAsk2Id)), "ask 2 dismissed");
      const readsBefore2 = f.queueReads;
      f.failRestore401Once = true;
      f.holdNextToken = true;
      dismissedRow(f.genAsk2Id)!.querySelector<HTMLButtonElement>(`[data-waiting-undo="ask:${f.genAsk2Id}"]`)!.click();
      await wait(() => f.tokenHeld && f.restoreCommands.length === 2, "control Undo 2 hit 401 and entered held recovery");
      f.releaseTokenHold();
      await wait(() => f.restoreCommands.length === 3 && f.queueReads > readsBefore2 && shown(card(f.genAsk2Id)) && !dismissedRow(f.genAsk2Id),
        "unchanged-access Undo retried once after 401 recovery and repainted restored card from fresh read");
      check(f.restoreCommands[1]!.command_id === f.restoreCommands[2]!.command_id &&
        f.restoreCommands[2]!.bearer === f.refreshedBearer(2),
        "Undo 401 retry must reuse command_id with refreshed same-login bearer: " + JSON.stringify(f.restoreCommands));
      document.documentElement.dataset.fenceObservation = JSON.stringify({ ok: true, scenario: f.scenario, steps, unexpected: f.unexpected });
      return;
    }

    // 6c. Unchanged-access controls for Archived Restore (token acquisition hold AND 401 recovery).
    if (f.scenario === "control-archived-restore") {
      await openPanelWorkspaceScope(true);
      await wait(() => shown(archivedCard(f.genAskId)) && shown(archivedCard(f.genAsk2Id)), "both dismissed #general items rendered in Archived");
      const readsBefore1 = f.queueReads;
      f.holdNextToken = true;
      f.expireStoredToken();
      archivedCard(f.genAskId)!.querySelector<HTMLButtonElement>(`[data-waiting-archived-restore="ask:${f.genAskId}"]`)!.click();
      await wait(() => f.tokenHeld, "control Archived Restore 1 entered held token acquisition");
      f.releaseTokenHold();
      await wait(() => f.restoreCommands.length === 1 && f.queueReads > readsBefore1 && !archivedCard(f.genAskId),
        "unchanged-access Archived Restore sent once after token acquisition and repainted from fresh read");
      check(f.restoreCommands[0]!.bearer === f.refreshedBearer(1),
        "expected refreshed same-login bearer after Archived Restore token acquisition: " + JSON.stringify(f.restoreCommands));

      const readsBefore2 = f.queueReads;
      f.failRestore401Once = true;
      f.holdNextToken = true;
      archivedCard(f.genAsk2Id)!.querySelector<HTMLButtonElement>(`[data-waiting-archived-restore="ask:${f.genAsk2Id}"]`)!.click();
      await wait(() => f.tokenHeld && f.restoreCommands.length === 2, "control Archived Restore 2 hit 401 and entered held recovery");
      f.releaseTokenHold();
      await wait(() => f.restoreCommands.length === 3 && f.queueReads > readsBefore2 && !archivedCard(f.genAsk2Id),
        "unchanged-access Archived Restore retried once after 401 recovery and repainted from fresh read");
      check(f.restoreCommands[1]!.command_id === f.restoreCommands[2]!.command_id &&
        f.restoreCommands[2]!.bearer === f.refreshedBearer(2),
        "Archived Restore 401 retry must reuse command_id with refreshed same-login bearer: " + JSON.stringify(f.restoreCommands));
      document.documentElement.dataset.fenceObservation = JSON.stringify({ ok: true, scenario: f.scenario, steps, unexpected: f.unexpected });
      return;
    }

    // 6d. Unchanged-access control for active Waiting queue read.
    if (f.scenario === "queue-read-control") {
      await openPanelWorkspaceScope(false);
      await wait(() => shown(card(f.privAskId)) && shown(card(f.dmAskId)) && shown(card(f.genAskId)) && shown(card(f.triggerAsk1Id)),
        "initial active Waiting rows loaded");
      f.holdNextQueue = true;
      card(f.triggerAsk1Id)!.querySelector<HTMLButtonElement>(`[data-waiting-dismiss="ask"][data-waiting-dismiss-id="${f.triggerAsk1Id}"]`)!.click();
      await wait(() => f.queueHeld, "unchanged-access Waiting queue read held");
      f.releaseQueueHold();
      await wait(() => !f.queueHeld && shown(card(f.privAskId)) && shown(card(f.dmAskId)) && shown(card(f.genAskId)) && !card(f.triggerAsk1Id),
        "unchanged-access Waiting queue read completed and repainted authorized rows cleanly");
      document.documentElement.dataset.fenceObservation = JSON.stringify({ ok: true, scenario: f.scenario, steps, unexpected: f.unexpected });
      return;
    }

    // 7a. Same-person replacement login (different session_id, NO SIGNED_OUT) during held acquisition:
    //     Dismiss sends 0 commands and repaints nothing for the retired action.
    if (f.scenario === "dismiss-login-swap-token-hold") {
      await openPanelWorkspaceScope(false);
      await wait(() => shown(card(f.dmAskId)) && shown(card(f.genAskId)), "asks rendered under login 1");
      f.holdNextToken = true;
      f.nextRefreshSessionId = f.login2SessionId;
      f.expireStoredToken();
      card(f.genAskId)!.querySelector<HTMLButtonElement>(`[data-waiting-dismiss="ask"][data-waiting-dismiss-id="${f.genAskId}"]`)!.click();
      await wait(() => f.tokenHeld && shown(dismissedRow(f.genAskId)), "Dismiss entered held acquisition");
      check(f.dismissCommands.length === 0, "no dismiss command dispatched while held");
      f.releaseTokenHold();
      await settleTicks();
      check(f.dismissCommands.length === 0, "same-person replacement login must dispatch ZERO dismiss commands");
      check(f.logoutCalls === 0, "must not rely on a prior SIGNED_OUT / logout");
      check(!dismissedRow(f.genAskId) && !panel()?.querySelector('[role="alert"]'), "retired Dismiss must not repaint row or error");
      document.documentElement.dataset.fenceObservation = JSON.stringify({ ok: true, scenario: f.scenario, steps, unexpected: f.unexpected });
      return;
    }

    // 7b. Same-person replacement login during held 401 recovery (NO SIGNED_OUT): Dismiss sends NO retry.
    if (f.scenario === "dismiss-login-swap-401-hold") {
      await openPanelWorkspaceScope(false);
      await wait(() => shown(card(f.dmAskId)) && shown(card(f.genAskId)), "asks rendered under login 1");
      f.failDismiss401Once = true;
      f.holdNextToken = true;
      f.nextRefreshSessionId = f.login2SessionId;
      card(f.genAskId)!.querySelector<HTMLButtonElement>(`[data-waiting-dismiss="ask"][data-waiting-dismiss-id="${f.genAskId}"]`)!.click();
      await wait(() => f.tokenHeld && f.dismissCommands.length === 1, "Dismiss hit 401 and entered held recovery");
      f.releaseTokenHold();
      await settleTicks();
      check(f.dismissCommands.length === 1, "same-person replacement login must NOT send a 401 retry for Dismiss");
      check(f.logoutCalls === 0, "must not rely on a prior SIGNED_OUT / logout");
      check(!dismissedRow(f.genAskId) && !panel()?.querySelector('[role="alert"]'), "retired Dismiss 401 must not repaint row or error");
      document.documentElement.dataset.fenceObservation = JSON.stringify({ ok: true, scenario: f.scenario, steps, unexpected: f.unexpected });
      return;
    }

    // 7c. Empty session during held acquisition (NO SIGNED_OUT): Dismiss sends 0 commands (never falls back).
    if (f.scenario === "dismiss-empty-session-token-hold") {
      await openPanelWorkspaceScope(false);
      await wait(() => shown(card(f.dmAskId)) && shown(card(f.genAskId)), "asks rendered under login 1");
      f.holdNextToken = true;
      f.expireStoredToken();
      card(f.genAskId)!.querySelector<HTMLButtonElement>(`[data-waiting-dismiss="ask"][data-waiting-dismiss-id="${f.genAskId}"]`)!.click();
      await wait(() => f.tokenHeld && shown(dismissedRow(f.genAskId)), "Dismiss entered held acquisition");
      f.clearStoredSession();
      f.releaseTokenHold();
      await settleTicks();
      check(f.dismissCommands.length === 0, "empty session during held acquisition must dispatch ZERO dismiss commands");
      check(!panel()?.querySelector('[role="alert"]'), "retired Dismiss must settle silently without error alert");
      document.documentElement.dataset.fenceObservation = JSON.stringify({ ok: true, scenario: f.scenario, steps, unexpected: f.unexpected });
      return;
    }

    // 7d. Same-person replacement login during held acquisition (NO SIGNED_OUT): Undo sends 0 commands.
    if (f.scenario === "undo-login-swap-token-hold") {
      await openPanelWorkspaceScope(false);
      await wait(() => shown(card(f.genAskId)), "ask rendered under login 1");
      const readsBeforeDismiss = f.queueReads;
      card(f.genAskId)!.querySelector<HTMLButtonElement>(`[data-waiting-dismiss="ask"][data-waiting-dismiss-id="${f.genAskId}"]`)!.click();
      await wait(() => f.dismissCommands.length === 1 && f.queueReads > readsBeforeDismiss && shown(dismissedRow(f.genAskId)), "ask dismissed and Undo visible");
      f.holdNextToken = true;
      f.nextRefreshSessionId = f.login2SessionId;
      f.expireStoredToken();
      dismissedRow(f.genAskId)!.querySelector<HTMLButtonElement>(`[data-waiting-undo="ask:${f.genAskId}"]`)!.click();
      await wait(() => f.tokenHeld, "Undo entered held acquisition");
      check(f.restoreCommands.length === 0, "no restore command dispatched while held");
      f.releaseTokenHold();
      await settleTicks();
      check(f.restoreCommands.length === 0, "same-person replacement login must dispatch ZERO Undo restore commands");
      check(f.logoutCalls === 0, "must not rely on a prior SIGNED_OUT / logout");
      check(!dismissedRow(f.genAskId) && !panel()?.querySelector('[role="alert"]'), "retired Undo must not repaint row or error");
      document.documentElement.dataset.fenceObservation = JSON.stringify({ ok: true, scenario: f.scenario, steps, unexpected: f.unexpected });
      return;
    }

    // 7e. Same-person replacement login during held 401 recovery (NO SIGNED_OUT): Undo sends NO retry.
    if (f.scenario === "undo-login-swap-401-hold") {
      await openPanelWorkspaceScope(false);
      await wait(() => shown(card(f.genAskId)), "ask rendered under login 1");
      const readsBeforeDismiss = f.queueReads;
      card(f.genAskId)!.querySelector<HTMLButtonElement>(`[data-waiting-dismiss="ask"][data-waiting-dismiss-id="${f.genAskId}"]`)!.click();
      await wait(() => f.dismissCommands.length === 1 && f.queueReads > readsBeforeDismiss && shown(dismissedRow(f.genAskId)), "ask dismissed and Undo visible");
      f.failRestore401Once = true;
      f.holdNextToken = true;
      f.nextRefreshSessionId = f.login2SessionId;
      dismissedRow(f.genAskId)!.querySelector<HTMLButtonElement>(`[data-waiting-undo="ask:${f.genAskId}"]`)!.click();
      await wait(() => f.tokenHeld && f.restoreCommands.length === 1, "Undo hit 401 and entered held recovery");
      f.releaseTokenHold();
      await settleTicks();
      check(f.restoreCommands.length === 1, "same-person replacement login must NOT send a 401 retry for Undo");
      check(f.logoutCalls === 0, "must not rely on a prior SIGNED_OUT / logout");
      check(!dismissedRow(f.genAskId) && !panel()?.querySelector('[role="alert"]'), "retired Undo 401 must not repaint row or error");
      document.documentElement.dataset.fenceObservation = JSON.stringify({ ok: true, scenario: f.scenario, steps, unexpected: f.unexpected });
      return;
    }

    // 7f. Empty session during held acquisition (NO SIGNED_OUT): Undo sends 0 commands.
    if (f.scenario === "undo-empty-session-token-hold") {
      await openPanelWorkspaceScope(false);
      await wait(() => shown(card(f.genAskId)), "ask rendered under login 1");
      const readsBeforeDismiss = f.queueReads;
      card(f.genAskId)!.querySelector<HTMLButtonElement>(`[data-waiting-dismiss="ask"][data-waiting-dismiss-id="${f.genAskId}"]`)!.click();
      await wait(() => f.dismissCommands.length === 1 && f.queueReads > readsBeforeDismiss && shown(dismissedRow(f.genAskId)), "ask dismissed and Undo visible");
      f.holdNextToken = true;
      f.expireStoredToken();
      dismissedRow(f.genAskId)!.querySelector<HTMLButtonElement>(`[data-waiting-undo="ask:${f.genAskId}"]`)!.click();
      await wait(() => f.tokenHeld, "Undo entered held acquisition");
      f.clearStoredSession();
      f.releaseTokenHold();
      await settleTicks();
      check(f.restoreCommands.length === 0, "empty session during held acquisition must dispatch ZERO Undo restore commands");
      check(!panel()?.querySelector('[role="alert"]'), "retired Undo must settle silently without error alert");
      document.documentElement.dataset.fenceObservation = JSON.stringify({ ok: true, scenario: f.scenario, steps, unexpected: f.unexpected });
      return;
    }

    // 7g. Same-person replacement login during held acquisition (NO SIGNED_OUT): Archived Restore sends 0 commands.
    if (f.scenario === "archived-restore-login-swap-token-hold") {
      await openPanelWorkspaceScope(true);
      await wait(() => shown(archivedCard(f.genAskId)), "archived item rendered under login 1");
      f.holdNextToken = true;
      f.nextRefreshSessionId = f.login2SessionId;
      f.expireStoredToken();
      archivedCard(f.genAskId)!.querySelector<HTMLButtonElement>(`[data-waiting-archived-restore="ask:${f.genAskId}"]`)!.click();
      await wait(() => f.tokenHeld, "Archived Restore entered held acquisition");
      check(f.restoreCommands.length === 0, "no restore command dispatched while held");
      f.releaseTokenHold();
      await settleTicks();
      check(f.restoreCommands.length === 0, "same-person replacement login must dispatch ZERO Archived Restore commands");
      check(f.logoutCalls === 0, "must not rely on a prior SIGNED_OUT / logout");
      check(!panel()?.querySelector('[role="alert"]'), "retired Archived Restore must not repaint error");
      document.documentElement.dataset.fenceObservation = JSON.stringify({ ok: true, scenario: f.scenario, steps, unexpected: f.unexpected });
      return;
    }

    // 7h. Same-person replacement login during held 401 recovery (NO SIGNED_OUT): Archived Restore sends NO retry.
    if (f.scenario === "archived-restore-login-swap-401-hold") {
      await openPanelWorkspaceScope(true);
      await wait(() => shown(archivedCard(f.genAskId)), "archived item rendered under login 1");
      f.failRestore401Once = true;
      f.holdNextToken = true;
      f.nextRefreshSessionId = f.login2SessionId;
      archivedCard(f.genAskId)!.querySelector<HTMLButtonElement>(`[data-waiting-archived-restore="ask:${f.genAskId}"]`)!.click();
      await wait(() => f.tokenHeld && f.restoreCommands.length === 1, "Archived Restore hit 401 and entered held recovery");
      f.releaseTokenHold();
      await settleTicks();
      check(f.restoreCommands.length === 1, "same-person replacement login must NOT send a 401 retry for Archived Restore");
      check(f.logoutCalls === 0, "must not rely on a prior SIGNED_OUT / logout");
      check(!panel()?.querySelector('[role="alert"]'), "retired Archived Restore 401 must not repaint error");
      document.documentElement.dataset.fenceObservation = JSON.stringify({ ok: true, scenario: f.scenario, steps, unexpected: f.unexpected });
      return;
    }

    // 7i. Empty session during held acquisition (NO SIGNED_OUT): Archived Restore sends 0 commands.
    if (f.scenario === "archived-restore-empty-session-token-hold") {
      await openPanelWorkspaceScope(true);
      await wait(() => shown(archivedCard(f.genAskId)), "archived item rendered under login 1");
      f.holdNextToken = true;
      f.expireStoredToken();
      archivedCard(f.genAskId)!.querySelector<HTMLButtonElement>(`[data-waiting-archived-restore="ask:${f.genAskId}"]`)!.click();
      await wait(() => f.tokenHeld, "Archived Restore entered held acquisition");
      f.clearStoredSession();
      f.releaseTokenHold();
      await settleTicks();
      check(f.restoreCommands.length === 0, "empty session during held acquisition must dispatch ZERO Archived Restore commands");
      check(!panel()?.querySelector('[role="alert"]'), "retired Archived Restore must settle silently without error alert");
      document.documentElement.dataset.fenceObservation = JSON.stringify({ ok: true, scenario: f.scenario, steps, unexpected: f.unexpected });
      return;
    }

    // 8a. Overlap after same-person login swap: Dismiss A held -> swap to login 2 -> fresh Dismiss B on SAME item ->
    //     release A -> B's pending Dismissed row remains untouched and login 2 dispatched exactly 1 dismiss command.
    if (f.scenario === "dismiss-overlap-after-login-swap") {
      await openPanelWorkspaceScope(false);
      await wait(() => shown(card(f.genAskId)), "ask rendered under login 1");
      f.holdNextDismissCommand = true;
      card(f.genAskId)!.querySelector<HTMLButtonElement>(`[data-waiting-dismiss="ask"][data-waiting-dismiss-id="${f.genAskId}"]`)!.click();
      await wait(() => f.heldDismisses.length === 1 && f.dismissCommands.length === 1 && shown(dismissedRow(f.genAskId)),
        "Dismiss A held in flight under login 1");
      check(f.bearerHasSession(f.dismissCommands[0]!.bearer, f.login1SessionId), "Dismiss A used login 1");

      await swapToLogin2();
      await openPanelWorkspaceScope(false);
      await wait(() => shown(card(f.genAskId)), "same ask rendered under login 2");
      f.holdNextDismissCommand = true;
      card(f.genAskId)!.querySelector<HTMLButtonElement>(`[data-waiting-dismiss="ask"][data-waiting-dismiss-id="${f.genAskId}"]`)!.click();
      await wait(() => f.heldDismisses.length === 2 && f.dismissCommands.length === 2 && shown(dismissedRow(f.genAskId)),
        "Dismiss B held in flight under login 2");
      check(f.bearerHasSession(f.dismissCommands[1]!.bearer, f.login2SessionId), "Dismiss B used login 2");

      // Release held Dismiss A (error settlement) -> must NOT delete B's pending row, paint error, or reload.
      f.releaseHeldDismiss(0, { status: 500, body: { error: "server_error", message: "Stale dismiss error" } });
      await settleTicks();
      const login2Dismisses = f.dismissCommands.filter((c: { bearer: string }) => f.bearerHasSession(c.bearer, f.login2SessionId));
      check(shown(dismissedRow(f.genAskId)), "Dismiss B's pending Dismissed row must remain after A settles");
      check(!card(f.genAskId), "Dismiss A must not repaint the card");
      check(!panel()?.querySelector('[role="alert"]'), "Dismiss A must not paint a stale error");
      check(login2Dismisses.length === 1, "exactly one dismiss command dispatched for login 2: " + JSON.stringify(f.dismissCommands));

      f.releaseHeldDismiss(1);
      await wait(() => shown(dismissedRow(f.genAskId)) && !card(f.genAskId), "Dismiss B settled cleanly");
      document.documentElement.dataset.fenceObservation = JSON.stringify({ ok: true, scenario: f.scenario, steps, unexpected: f.unexpected });
      return;
    }

    // 8b. Overlap after same-person login swap: Undo A held -> swap to login 2 -> fresh Dismiss + Undo B on SAME item ->
    //     release A -> B's "Undoing…" row remains pending and login 2 dispatched exactly 1 restore command.
    if (f.scenario === "undo-overlap-after-login-swap") {
      await openPanelWorkspaceScope(false);
      await wait(() => shown(card(f.genAskId)), "ask rendered under login 1");
      const readsBeforeD1 = f.queueReads;
      card(f.genAskId)!.querySelector<HTMLButtonElement>(`[data-waiting-dismiss="ask"][data-waiting-dismiss-id="${f.genAskId}"]`)!.click();
      await wait(() => f.dismissCommands.length === 1 && f.queueReads > readsBeforeD1 && shown(dismissedRow(f.genAskId)), "ask dismissed under login 1");
      f.holdNextRestoreCommand = true;
      dismissedRow(f.genAskId)!.querySelector<HTMLButtonElement>(`[data-waiting-undo="ask:${f.genAskId}"]`)!.click();
      await wait(() => f.heldRestores.length === 1 && f.restoreCommands.length === 1 &&
        dismissedRow(f.genAskId)?.querySelector(`[data-waiting-undo="ask:${f.genAskId}"]`)?.textContent === "Undoing…",
        "Undo A held in flight under login 1");
      check(f.bearerHasSession(f.restoreCommands[0]!.bearer, f.login1SessionId), "Undo A used login 1");

      // Make genAskId open again on the synthetic server for login 2 so login 2 can start a fresh Dismiss + Undo B on the exact same key.
      f.dismissedIds = f.dismissedIds.filter((id: string) => id !== f.genAskId);
      await swapToLogin2();
      await openPanelWorkspaceScope(false);
      await wait(() => shown(card(f.genAskId)), "same ask rendered under login 2");
      const readsBeforeD2 = f.queueReads;
      card(f.genAskId)!.querySelector<HTMLButtonElement>(`[data-waiting-dismiss="ask"][data-waiting-dismiss-id="${f.genAskId}"]`)!.click();
      await wait(() => f.dismissCommands.length === 2 && f.queueReads > readsBeforeD2 && shown(dismissedRow(f.genAskId)), "ask dismissed under login 2");
      f.holdNextRestoreCommand = true;
      dismissedRow(f.genAskId)!.querySelector<HTMLButtonElement>(`[data-waiting-undo="ask:${f.genAskId}"]`)!.click();
      await wait(() => f.heldRestores.length === 2 && f.restoreCommands.length === 2 &&
        dismissedRow(f.genAskId)?.querySelector(`[data-waiting-undo="ask:${f.genAskId}"]`)?.textContent === "Undoing…",
        "Undo B held in flight under login 2");
      check(f.bearerHasSession(f.restoreCommands[1]!.bearer, f.login2SessionId), "Undo B used login 2");

      f.releaseHeldRestore(0, { status: 500, body: { error: "server_error", message: "Stale undo error" } });
      await settleTicks();
      const undoBtnNow = dismissedRow(f.genAskId)?.querySelector<HTMLButtonElement>(`[data-waiting-undo="ask:${f.genAskId}"]`);
      const login2Restores = f.restoreCommands.filter((c: { bearer: string }) => f.bearerHasSession(c.bearer, f.login2SessionId));
      check(shown(dismissedRow(f.genAskId)) && undoBtnNow?.textContent === "Undoing…" && undoBtnNow?.getAttribute("aria-disabled") === "true",
        "Undo B's pending Undoing… row must remain after A settles");
      check(!panel()?.querySelector('[role="alert"]'), "Undo A must not paint a stale error");
      check(login2Restores.length === 1, "exactly one restore command dispatched for login 2: " + JSON.stringify(f.restoreCommands));

      f.releaseHeldRestore(1);
      await wait(() => shown(card(f.genAskId)) && !dismissedRow(f.genAskId), "Undo B settled cleanly and reloaded card");
      document.documentElement.dataset.fenceObservation = JSON.stringify({ ok: true, scenario: f.scenario, steps, unexpected: f.unexpected });
      return;
    }

    // 8c. Overlap after same-person login swap: Archived Restore A held -> swap to login 2 -> fresh Archived Restore B on SAME item ->
    //     release A -> B's "Restoring…" button stays pending and login 2 dispatched exactly 1 restore command.
    if (f.scenario === "archived-restore-overlap-after-login-swap") {
      await openPanelWorkspaceScope(true);
      await wait(() => shown(archivedCard(f.genAskId)), "archived item rendered under login 1");
      f.holdNextRestoreCommand = true;
      archivedCard(f.genAskId)!.querySelector<HTMLButtonElement>(`[data-waiting-archived-restore="ask:${f.genAskId}"]`)!.click();
      await wait(() => f.heldRestores.length === 1 && f.restoreCommands.length === 1 &&
        archivedCard(f.genAskId)?.querySelector(`[data-waiting-archived-restore="ask:${f.genAskId}"]`)?.textContent === "Restoring…",
        "Archived Restore A held in flight under login 1");
      check(f.bearerHasSession(f.restoreCommands[0]!.bearer, f.login1SessionId), "Archived Restore A used login 1");

      await swapToLogin2();
      await openPanelWorkspaceScope(true);
      await wait(() => shown(archivedCard(f.genAskId)), "same archived item rendered under login 2");
      f.holdNextRestoreCommand = true;
      archivedCard(f.genAskId)!.querySelector<HTMLButtonElement>(`[data-waiting-archived-restore="ask:${f.genAskId}"]`)!.click();
      await wait(() => f.heldRestores.length === 2 && f.restoreCommands.length === 2 &&
        archivedCard(f.genAskId)?.querySelector(`[data-waiting-archived-restore="ask:${f.genAskId}"]`)?.textContent === "Restoring…",
        "Archived Restore B held in flight under login 2");
      check(f.bearerHasSession(f.restoreCommands[1]!.bearer, f.login2SessionId), "Archived Restore B used login 2");

      f.releaseHeldRestore(0, { status: 500, body: { error: "server_error", message: "Stale archived restore error" } });
      await settleTicks();
      const restoreBtnNow = archivedCard(f.genAskId)?.querySelector<HTMLButtonElement>(`[data-waiting-archived-restore="ask:${f.genAskId}"]`);
      const login2Restores = f.restoreCommands.filter((c: { bearer: string }) => f.bearerHasSession(c.bearer, f.login2SessionId));
      check(shown(archivedCard(f.genAskId)) && restoreBtnNow?.textContent === "Restoring…" && restoreBtnNow?.getAttribute("aria-disabled") === "true",
        "Archived Restore B's Restoring… state must remain after A settles");
      check(!panel()?.querySelector('[role="alert"]'), "Archived Restore A must not paint a stale error");
      check(login2Restores.length === 1, "exactly one restore command dispatched for login 2: " + JSON.stringify(f.restoreCommands));

      f.releaseHeldRestore(1);
      await wait(() => !archivedCard(f.genAskId), "Archived Restore B settled cleanly");
      document.documentElement.dataset.fenceObservation = JSON.stringify({ ok: true, scenario: f.scenario, steps, unexpected: f.unexpected });
      return;
    }

    // 8d. Overlap after same-person login swap: Survey batch A held -> swap to login 2 -> fresh Survey batch B started ->
    //     release A -> B's "Sending…" state and disabled controls stay intact and login 2 dispatched exactly 1 command so far.
    if (f.scenario === "survey-overlap-after-login-swap") {
      const stageTwoAnswerSurvey = async (label: string) => {
        await openPanelWorkspaceScope(false);
        await wait(() => shown(card(f.dmAskId)) && shown(card(f.genAskId)) && shown(panel()?.querySelector("[data-waiting-review-start]")),
          `${label}: 2 asks and Review questions button ready`);
        panel()!.querySelector<HTMLButtonElement>("[data-waiting-review-start]")!.click();
        await wait(() => shown(panel()?.querySelector('[data-waiting-survey="step"]')) && shown(panel()?.querySelector('[data-survey-option="yes"]')),
          `${label}: survey step 1 open`);
        panel()!.querySelector<HTMLButtonElement>('[data-survey-option="yes"]')!.click();
        panel()!.querySelector<HTMLButtonElement>("[data-waiting-survey-next]")!.click();
        await wait(() => (panel()?.querySelector("[data-waiting-survey-progress]")?.textContent ?? "").includes("Question 2 of 2") &&
          shown(panel()?.querySelector('[data-survey-option="yes"]')), `${label}: survey step 2 open`);
        panel()!.querySelector<HTMLButtonElement>('[data-survey-option="yes"]')!.click();
        panel()!.querySelector<HTMLButtonElement>("[data-waiting-survey-next]")!.click();
        await wait(() => shown(panel()?.querySelector('[data-waiting-survey="review"]')) && shown(panel()?.querySelector("[data-waiting-survey-send]")),
          `${label}: survey review ready`);
      };

      await stageTwoAnswerSurvey("login 1");
      f.holdNextChoiceCommand = true;
      panel()!.querySelector<HTMLButtonElement>("[data-waiting-survey-send]")!.click();
      await wait(() => f.heldChoices.length === 1 && f.choiceCommands.length === 1 &&
        panel()?.querySelector("[data-waiting-survey-send]")?.textContent === "Sending…",
        "Survey batch A held in flight under login 1");
      check(f.bearerHasSession(f.choiceCommands[0]!.bearer, f.login1SessionId), "Survey A used login 1");

      await swapToLogin2();
      await stageTwoAnswerSurvey("login 2");
      f.holdNextChoiceCommand = true;
      panel()!.querySelector<HTMLButtonElement>("[data-waiting-survey-send]")!.click();
      await wait(() => f.heldChoices.length === 2 && f.choiceCommands.length === 2 &&
        panel()?.querySelector("[data-waiting-survey-send]")?.textContent === "Sending…",
        "Survey batch B held in flight under login 2");
      check(f.bearerHasSession(f.choiceCommands[1]!.bearer, f.login2SessionId), "Survey B used login 2");

      // Release held Survey A (error settlement) -> must NOT clear B's sending flag, unlock B's controls, or send A's item 2.
      f.releaseHeldChoice(0, { status: 500, body: { error: "server_error", message: "Stale survey error" } });
      await settleTicks();
      const sendBtn = panel()?.querySelector<HTMLButtonElement>("[data-waiting-survey-send]");
      const backBtn = panel()?.querySelector<HTMLButtonElement>("[data-waiting-survey-back]");
      const login2Choices = f.choiceCommands.filter((c: { bearer: string }) => f.bearerHasSession(c.bearer, f.login2SessionId));
      check(sendBtn?.textContent === "Sending…" && sendBtn?.getAttribute("aria-disabled") === "true",
        "Survey B's Sending… button must remain locked after Survey A settles");
      check(backBtn?.getAttribute("aria-disabled") === "true",
        "Survey B's Back control must remain disabled after Survey A settles");
      check(!panel()?.querySelector('[role="alert"]'), "Survey A must not paint a stale error on Survey B");
      check(f.choiceCommands.length === 2 && login2Choices.length === 1,
        "Survey A must not advance and login 2 must have dispatched exactly 1 command while held: " + JSON.stringify(f.choiceCommands));

      f.releaseHeldChoice(1);
      await wait(() => !panel()?.querySelector("[data-waiting-survey]") && f.choiceCommands.length === 3,
        "Survey B finished both answers cleanly");
      document.documentElement.dataset.fenceObservation = JSON.stringify({ ok: true, scenario: f.scenario, steps, unexpected: f.unexpected });
      return;
    }

    // 9a. Batch "Dismiss all" of 5 items with the 3rd held -> same-person replacement login (NO SIGNED_OUT):
    //     zero further dismisses dispatched (4 and 5 never sent) and nothing repaints.
    if (f.scenario === "batch-dismiss-login-swap") {
      await openPanelWorkspaceScope(false);
      await wait(() => f.batchAskIds.every((id: string) => shown(card(id))) && shown(panel()?.querySelector("[data-waiting-dismiss-all]")),
        "5 asks and Dismiss all control rendered under login 1");
      panel()!.querySelector<HTMLButtonElement>("[data-waiting-dismiss-all]")!.click();
      await wait(() =>
        panel()?.querySelector("[data-waiting-batch-prompt]")?.textContent === "Dismiss all 5?" &&
        panel()?.querySelector("[data-waiting-batch-note]")?.textContent === "You can restore items one by one from Archived." &&
        panel()?.querySelector("[data-waiting-dismiss-all-confirm]")?.textContent === "Dismiss 5",
        "in-place Dismiss all 5? confirm opened");
      f.holdDismissAtIndex = 3;
      panel()!.querySelector<HTMLButtonElement>("[data-waiting-dismiss-all-confirm]")!.click();
      await wait(() =>
        f.heldDismisses.length === 1 &&
        f.dismissCommands.length === 3 &&
        (panel()?.querySelector("[data-waiting-batch-progress]")?.textContent ?? "").includes("of 5"),
        "batch dispatched first 3 with 3rd held in flight");
      check(f.bearerHasSession(f.dismissCommands[2]!.bearer, f.login1SessionId), "held 3rd dismiss used login 1");

      await swapToLogin2();
      f.releaseHeldDismiss(0, { status: 500, body: { error: "server_error", message: "Stale batch error" } });
      await settleTicks();

      const login2Dismisses = f.dismissCommands.filter((c: { bearer: string }) => f.bearerHasSession(c.bearer, f.login2SessionId));
      check(f.dismissCommands.length === 3, "retired batch must dispatch ZERO further dismisses after login swap: " + JSON.stringify(f.dismissCommands));
      check(login2Dismisses.length === 0, "no batch dismiss may dispatch under replacement login 2");
      check(f.logoutCalls === 0, "must not rely on SIGNED_OUT / logout");
      check(!shown(panel()), "Waiting panel stays retired/closed after login swap");
      check(!panel()?.querySelector("[data-waiting-batch-result]"), "retired batch must not paint a result row");
      check(!panel()?.querySelector("[data-waiting-batch-progress]"), "retired batch must not paint progress");
      check(!panel()?.querySelector('[role="alert"]'), "retired batch must not paint an error alert");
      document.documentElement.dataset.fenceObservation = JSON.stringify({ ok: true, scenario: f.scenario, steps, unexpected: f.unexpected });
      return;
    }

    // 9b. Clean control for Batch "Dismiss all": 5 dismissed -> "Dismissed 5", no Undo anywhere in panel, list empty.
    if (f.scenario === "batch-dismiss-control") {
      await openPanelWorkspaceScope(false);
      await wait(() => f.batchAskIds.every((id: string) => shown(card(id))) && shown(panel()?.querySelector("[data-waiting-dismiss-all]")),
        "5 asks and Dismiss all control rendered");
      panel()!.querySelector<HTMLButtonElement>("[data-waiting-dismiss-all]")!.click();
      await wait(() =>
        panel()?.querySelector("[data-waiting-batch-prompt]")?.textContent === "Dismiss all 5?" &&
        panel()?.querySelector("[data-waiting-batch-note]")?.textContent === "You can restore items one by one from Archived." &&
        panel()?.querySelector("[data-waiting-dismiss-all-confirm]")?.textContent === "Dismiss 5" &&
        panel()?.querySelector("[data-waiting-dismiss-all-cancel]")?.textContent === "Cancel",
        "in-place Dismiss all 5? confirm opened");
      panel()!.querySelector<HTMLButtonElement>("[data-waiting-dismiss-all-confirm]")!.click();
      await wait(() =>
        f.dismissCommands.length === 5 &&
        shown(panel()?.querySelector("[data-waiting-batch-result]")),
        "all 5 dismissed and batch result row shown");
      const resultRow = panel()!.querySelector("[data-waiting-batch-result]")!;
      check(resultRow.querySelector("[data-waiting-batch-result-label]")?.textContent === "Dismissed 5",
        "expected Dismissed 5 result row");
      check(resultRow.querySelectorAll("button").length === 0,
        "batch result row must have no button");
      check(!panel()?.querySelector("[data-waiting-batch-undo]") && !panel()?.querySelector("[data-waiting-undo]"),
        "no Undo control may exist anywhere in the panel");
      check(Array.from(panel()!.querySelectorAll("button")).every((btn) => !/undo/i.test(btn.textContent ?? "")),
        "no button in the panel may read Undo");
      check(f.batchAskIds.every((id: string) => !card(id)), "all 5 cards removed from list");
      check(panel()!.querySelectorAll("[data-waiting-card], [data-waiting-plain-ask], [data-waiting-todo]").length === 0,
        "list must be empty");
      check(panel()!.querySelectorAll("[data-waiting-dismissed]").length === 0, "no per-item Dismissed rows for batch");
      check(f.restoreCommands.length === 0, "batch dismiss must never call restore_waiting_item");
      document.documentElement.dataset.fenceObservation = JSON.stringify({ ok: true, scenario: f.scenario, steps, unexpected: f.unexpected });
      return;
    }

    throw new Error("unknown scenario: " + f.scenario);
  } catch (error) {
    document.documentElement.dataset.fenceObservation = JSON.stringify({
      ok: false,
      scenario: f.scenario,
      error: error instanceof Error ? error.message : String(error),
      steps,
      unexpected: f.unexpected,
    });
  }
}

let cachedBundle: { app: string; js: string } | null = null;
async function loadBundle() {
  if (cachedBundle) return cachedBundle;
  const { markup, styles, bundled } = await renderAstroFixture(new URL("./LiveDashboard.astro", import.meta.url));
  const fixture = await compileFixtureFunction(new URL(import.meta.url), "installWaitingDismissalFenceFixture");
  const observer = await compileFixtureFunction(new URL(import.meta.url), "observeWaitingDismissalFence");
  const app = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="commonswarm:url" content="https://api.test.invalid"><meta name="commonswarm:anon-key" content="synthetic-anon">` +
    `<style>${styles.join("\n")}</style><script>${fixture}</script></head><body>${markup}<script type="module" src="/app.js"></script>` +
    `<script type="module">${observer}</script></body></html>`;
  cachedBundle = { app, js: bundled.join("\n") };
  return cachedBundle;
}

async function runFenceScenarios(scenarios: readonly string[]) {
  const { app, js } = await loadBundle();
  const server = createServer((request, response) => {
    if (request.url === "/__observer-tick") {
      setTimeout(() => { response.writeHead(204); response.end(); }, 2);
      return;
    }
    if (request.url?.startsWith("/fonts/")) {
      response.writeHead(204);
      response.end();
      return;
    }
    response.writeHead(200, { "Content-Type": request.url === "/app.js" ? "text/javascript" : "text/html" });
    response.end(request.url === "/app.js" ? js : app);
  });
  const outcomes: Record<string, any> = {};
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const chrome = await findChrome();
    for (const scenario of scenarios) {
      const { stdout } = await launchChrome(chrome, [
        "--window-size=1280,800",
        "--virtual-time-budget=120000",
        "--dump-dom",
        `http://127.0.0.1:${address.port}/app?w=aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaaa&c=general&case=${scenario}`,
      ], { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 });
      const raw = stdout.match(/data-fence-observation="([^"]*)"/)?.[1];
      outcomes[scenario] = raw
        ? JSON.parse(raw.replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&"))
        : { error: "the rendered app did not finish the observation: " + stdout.slice(0, 400) };
    }
  } finally {
    if (server.listening) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  }
  return outcomes;
}

const failures = (outcomes: Record<string, any>) =>
  Object.entries(outcomes).filter(([, result]) => result.error !== undefined || result.ok !== true);

test("Waiting dismissal C3 (mounted Dashboard): Dismiss, Undo, and Archived Restore carry the access fence through token acquisition and 401 recovery", { timeout: 180_000 }, async () => {
  const outcomes = await runFenceScenarios([
    "dismiss-token-hold-retire",
    "dismiss-401-hold-retire",
    "undo-token-hold-retire",
    "undo-401-hold-retire",
    "archived-restore-token-hold-retire",
    "archived-restore-401-hold-retire",
  ]);
  assert.deepEqual(failures(outcomes), [], JSON.stringify(outcomes));
});

test("Waiting dismissal C3 (mounted Dashboard): held active Waiting queue read never repaints after private-channel then DM loss, and unchanged-access controls succeed", { timeout: 180_000 }, async () => {
  const outcomes = await runFenceScenarios([
    "queue-read-held-private-channel-then-dm-loss",
    "control-dismiss",
    "control-undo",
    "control-archived-restore",
    "queue-read-control",
  ]);
  assert.deepEqual(failures(outcomes), [], JSON.stringify(outcomes));
});

test("Waiting dismissal C3 (mounted Dashboard): same-person replacement login (without SIGNED_OUT) and empty session retire Dismiss, Undo, and Archived Restore across held acquisition and 401 recovery", { timeout: 180_000 }, async () => {
  const outcomes = await runFenceScenarios([
    "dismiss-login-swap-token-hold",
    "dismiss-login-swap-401-hold",
    "dismiss-empty-session-token-hold",
    "undo-login-swap-token-hold",
    "undo-login-swap-401-hold",
    "undo-empty-session-token-hold",
    "archived-restore-login-swap-token-hold",
    "archived-restore-login-swap-401-hold",
    "archived-restore-empty-session-token-hold",
  ]);
  assert.deepEqual(failures(outcomes), [], JSON.stringify(outcomes));
});

test("Waiting dismissal C3 (mounted Dashboard): retired Dismiss, Undo, Archived Restore, and Survey settlements never touch overlapping fresh attempts under a replacement login", { timeout: 180_000 }, async () => {
  const outcomes = await runFenceScenarios([
    "dismiss-overlap-after-login-swap",
    "undo-overlap-after-login-swap",
    "archived-restore-overlap-after-login-swap",
    "survey-overlap-after-login-swap",
  ]);
  assert.deepEqual(failures(outcomes), [], JSON.stringify(outcomes));
});

test("Waiting dismissal batch (mounted Dashboard): Dismiss all stops with zero further dispatches on same-person replacement login, and clean control dismisses five with no batch Undo", { timeout: 180_000 }, async () => {
  const outcomes = await runFenceScenarios([
    "batch-dismiss-login-swap",
    "batch-dismiss-control",
  ]);
  assert.deepEqual(failures(outcomes), [], JSON.stringify(outcomes));
});
