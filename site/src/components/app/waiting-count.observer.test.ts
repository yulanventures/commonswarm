/** Real site DOM/transport proof with synthetic HTTP: the Waiting on you count across every workspace. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { renderAstroFixture, compileFixtureFunction } from "../../../tests/astro-fixture";
import { browserTest as test } from "../../../tests/chrome.js";
import { findChrome, launchChrome } from "../../../tests/chrome.js";

// Authoring gate: Waiting on you is the one place a person sees, from any channel, that something waits for them in a
// workspace they are not looking at. The credible regressions are (1) a question in a workspace past the first few
// never reaching the count, or the control being drawn only inside the phone's navigation drawer; (2) the count keeping
// an answered question; (3) a workspace the overview left out being counted as zero, so the control says "0" while a
// question may be waiting there. Only HTTP is synthetic: the real app boots signed in on workspace one's chat, reads
// the overview, the decision queue and the choices through its own clients, draws the control, opens Catch up from it
// and sends the answer through its own command path. Backend admission and the overview's SQL are owned by server suites.
function installWaitingFixture() {
  const w = window as any;
  const owner = "33333333-3333-4333-8333-333333333333";
  const agent = "22222222-2222-4222-8222-222222222222";
  const org = "55555555-5555-4555-8555-555555555555";
  const ask = "99999999-9999-4999-8999-999999999999";
  const otherChannel = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const askIdAt = (n: number) => "99999999-9999-4999-8999-" + String(n).padStart(12, "0");
  // Nine workspaces in one organization. The app opens on the first; the question is in the ninth.
  const ids = Array.from({ length: 9 }, (_, i) => `aaaaaaa${i + 1}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`);
  const scenario = new URL(location.href).searchParams.get("case") || "answer-desktop";
  const recent = new Date(Date.now() - 60000).toISOString();
  const before = new Date(Date.now() - 86400000).toISOString();
  const until = new Date(Date.now() + 86400000).toISOString();
  const question = "Ship the newsletter today?";
  const user = { id: owner, aud: "authenticated", role: "authenticated",
    email: "synthetic@example.test", app_metadata: {}, user_metadata: {}, created_at: before };
  // answer-*: every workspace is in the overview and the ninth has one question, which the observer answers.
  // uncounted-one-*: the overview leaves the fifth workspace out; the ninth has its question.
  // uncounted-none-*: the overview leaves the fifth workspace out; nothing waits anywhere it did count.
  // batch-51-*: workspace 1 has 51 choice questions; 1..50 are in #other and #51 is alone in #general.
  // batch-101-*: workspace 1 has 101 choice questions; 1..100 are in #other and #101 is alone in #general (paged via decision_queue_page).
  // truncated-queue-*: workspace 1 has 105 questions (truncated at 100), server lacks decision_queue_page, all 100 returned in #other.
  const batch51 = scenario.startsWith("batch-51");
  const batch101 = scenario.startsWith("batch-101");
  const truncatedQueue = scenario.startsWith("truncated-queue");
  const multiBatch = batch51 || batch101 || truncatedQueue;
  const ask51 = askIdAt(51);
  const ask101 = askIdAt(101);
  const todoId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const todoIdAt = (n: number) => "dddddddd-dddd-4ddd-8ddd-" + String(n).padStart(12, "0");
  const chBoiler = "cccccccc-cccc-4ccc-8ccc-000000000001";
  const chReno = "cccccccc-cccc-4ccc-8ccc-000000000002";
  const todoCase = scenario.startsWith("todos-");
  const todo21Case = scenario.startsWith("todos-21-");
  const todoTruncatedCase = scenario.startsWith("todos-truncated-");
  const surveyCase = scenario.startsWith("survey-");
  const surveyAuthRetireCase = scenario.startsWith("survey-auth-retire-");
  const readRetireCase = scenario.startsWith("waiting-read-retire-");
  const askPeerB = askIdAt(99);
  const askWs2A = askIdAt(98);
  const surveyAsks = [askIdAt(1), askIdAt(2), askIdAt(3)];
  const plainCleanupCase = scenario.startsWith("historical-cleanup-") || scenario.startsWith("plain-401-");
  const plain401RetireCase = scenario.startsWith("plain-401-retire-");
  const plain401ControlCase = scenario.startsWith("plain-401-refresh-control-");
  const plainAsks = [askIdAt(11), askIdAt(12)];
  const peerUserB = {
    id: "77777777-7777-4777-8777-777777777777",
    aud: "authenticated",
    role: "authenticated",
    email: "peer-b@example.test",
    app_metadata: {},
    user_metadata: {},
    created_at: before,
  };
  let releaseFirstAnswer: (() => void) | null = null;
  let releaseIdentityCheck: (() => void) | null = null;
  let releaseRefresh: (() => void) | null = null;
  let releaseWs9ChannelsA: (() => void) | null = null;
  let releaseWs2QueueA: (() => void) | null = null;
  const f = w.waitingFixture = { scenario, phone: scenario.endsWith("-phone"), owner, peerUserB, ids, ask, askPeerB, askWs2A, ask51, ask101,
    todoId, todo1: todoIdAt(1), todo21: todoIdAt(21), chBoiler, chReno, surveyAsks, plainAsks, question,
    asked: !scenario.startsWith("uncounted-none") && !multiBatch && !todoCase && !surveyCase && !plainCleanupCase,
    uncounted: scenario.startsWith("uncounted-"), answered: false, answeredIds: [] as string[],
    todoDone: false, todoFailOnce: todoCase && !todo21Case && !todoTruncatedCase, todoWrites: [] as any[],
    todoPages: 0,
    surveyFailOnceId: surveyCase && !surveyAuthRetireCase ? surveyAsks[2]! : "",
    plainFailOnceId: scenario.startsWith("historical-cleanup-") ? plainAsks[1]! : "",
    plainFailedCommandId: "",
    plain401Once: plain401RetireCase || plain401ControlCase,
    plainAttempts: 0,
    plainBearers: [] as string[],
    plainCommandIds: [] as string[],
    plainReplies: [] as any[],
    firstAnswerHeld: false,
    identityCheckHeld: false,
    refreshHeld: false,
    ws9ChannelsAHeld: false,
    ws2QueueAHeld: false,
    releaseFirstAnswer: () => { releaseFirstAnswer?.(); releaseFirstAnswer = null; },
    releaseIdentityCheck: () => { releaseIdentityCheck?.(); releaseIdentityCheck = null; },
    releaseRefresh: () => { releaseRefresh?.(); releaseRefresh = null; },
    releaseWs9ChannelsA: () => { releaseWs9ChannelsA?.(); releaseWs9ChannelsA = null; },
    releaseWs2QueueA: () => { releaseWs2QueueA?.(); releaseWs2QueueA = null; },
    choiceBatchSizes: [] as number[],
    overviewReads: 0, answers: [] as any[], log: [] as string[], unexpected: [] as string[] };
  const ws1Todos21 = () => {
    const baseMs = Date.now() - 3600_000;
    return Array.from({ length: 21 }, (_, i) => i + 1).map(n => ({
      todo_id: todoIdAt(n),
      title: n === 1 ? "Boiler channel task #1" : n === 21 ? "Renovation channel task #21" : "Workspace task #" + n,
      state: "open" as const,
      due_on: n === 1 ? "2026-11-22" : null,
      reason: "assigned" as const,
      agent_id: null,
      state_at: new Date(baseMs + (22 - n) * 1000).toISOString(),
      placement: n === 1 || n === 21 ? "channel" as const : "workspace" as const,
      channel_id: n === 1 ? chBoiler : n === 21 ? chReno : null,
    }));
  };
  const open = (id: unknown) => id === ids[8] && f.asked && !f.answered;
  const ws1Asks = () => {
    if (plainCleanupCase) {
      const baseMs = Date.now() - 600_000;
      const titles = ["Legacy open question without options?", "Stale historical question to clear?"];
      return plainAsks
        .map((id, i) => ({ id, title: titles[i]!, i }))
        .filter(entry => !f.answeredIds.includes(entry.id))
        .map(entry => ({
          signal_id: entry.id,
          from: { kind: "agent" as const, id: agent, name: "Scout" },
          body: entry.title,
          created_at: new Date(baseMs + entry.i * 1000).toISOString(), until, reraised: null,
        }));
    }
    if (surveyCase) {
      const baseMs = Date.now() - 600_000;
      const titles = ["Which boiler quote?", "Which paint finish?", "Which arrival window?"];
      return surveyAsks
        .map((id, i) => ({ id, title: titles[i]!, i }))
        .filter(entry => !f.answeredIds.includes(entry.id))
        .map(entry => ({
          signal_id: entry.id,
          from: { kind: "agent" as const, id: agent, name: "Scout" },
          body: entry.title,
          created_at: new Date(baseMs + entry.i * 1000).toISOString(), until, reraised: null,
        }));
    }
    const count = batch51 ? 51 : batch101 ? 101 : truncatedQueue ? 100 : 0;
    if (!count) return [];
    const baseMs = Date.now() - 3600_000;
    return Array.from({ length: count }, (_, i) => i + 1)
      .filter(n => !f.answeredIds.includes(askIdAt(n)))
      .map(n => ({
        signal_id: askIdAt(n),
        from: { kind: "agent" as const, id: agent, name: "Scout" },
        body: (batch51 && n === 51) ? "Approve question fifty-one in general?"
          : (batch101 && n === 101) ? "Approve question one-hundred-and-one in general?"
          : "Other channel question " + n + "?",
        created_at: new Date(baseMs + n * 1000).toISOString(), until, reraised: null,
      }));
  };
  const number = (id: unknown) => ids.indexOf(String(id)) + 1;
  const network = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    if (url.origin === location.origin) return network(input, init);
    const body = request.method === "POST" ? await request.json().catch(() => null) : null;
    if (url.origin !== "https://api.test.invalid") { f.unexpected.push(url.href); return Response.json({}, { status: 404 }); }
    if (url.pathname === "/auth/v1/user") {
      const authHeader = request.headers.get("authorization") ?? "";
      if ((surveyAuthRetireCase || readRetireCase) && authHeader && authHeader !== "Bearer synthetic-human") {
        if (surveyAuthRetireCase) {
          f.identityCheckHeld = true;
          f.log.push("auth-user-peer-b-held");
          await new Promise<void>(resolve => { releaseIdentityCheck = resolve; });
          f.log.push("auth-user-peer-b-released");
        }
        return Response.json(peerUserB);
      }
      return Response.json(user);
    }
    if (url.pathname === "/auth/v1/logout") {
      f.log.push("auth-logout");
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "refresh_token") {
      f.log.push("auth-refresh");
      if (plain401RetireCase) {
        f.refreshHeld = true;
        await new Promise<void>(resolve => { releaseRefresh = resolve; });
        f.log.push("auth-refresh-released");
      }
      return Response.json({
        access_token: "synthetic-human-refreshed",
        refresh_token: "synthetic-refresh-2",
        token_type: "bearer",
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        user,
      });
    }
    if (url.pathname === "/rest/v1/rpc/home_overview") {
      const authHeader = request.headers.get("authorization") ?? "";
      if (surveyAuthRetireCase && authHeader && authHeader !== "Bearer synthetic-human") {
        return Response.json({ viewer_user_id: peerUserB.id, generated_at: new Date().toISOString(), workspaces: [] });
      }
      if (readRetireCase && authHeader && authHeader !== "Bearer synthetic-human") {
        f.overviewReads++; f.log.push("overview-b");
        return Response.json({
          viewer_user_id: peerUserB.id,
          generated_at: new Date().toISOString(),
          workspaces: ids.map(id => ({
            workspace_id: id, name: "Workspace " + number(id), role: "member", last_seen_at: recent, new_messages: 0, content: null,
            people: [{ user_id: peerUserB.id, display_name: "Peer B", role: "member", is_viewer: true, agents: [] }],
            needs_you: {
              asks: id === ids[8] ? [{ signal_id: askPeerB, from: { kind: "agent", id: agent }, created_at: recent, until }] : [],
              assigned: [],
              waiting: [],
            },
          })),
        });
      }
      f.overviewReads++; f.log.push("overview");
      return Response.json({ viewer_user_id: owner, generated_at: new Date().toISOString(),
        workspaces: ids.filter(id => !(f.uncounted && id === ids[4])).map(id => {
          const asks = id === ids[0] && (multiBatch || surveyCase || plainCleanupCase)
            ? ws1Asks().slice(0, 10).map(a => ({ signal_id: a.signal_id, from: { kind: a.from.kind, id: a.from.id }, created_at: a.created_at, until }))
            : readRetireCase && id === ids[1]
              ? [{ signal_id: askWs2A, from: { kind: "agent", id: agent }, created_at: recent, until }]
              : open(id) ? [{ signal_id: ask, from: { kind: "agent", id: agent }, created_at: recent, until }] : [];
          const assigned = id === ids[0] && (todo21Case || todoTruncatedCase)
            ? ws1Todos21().slice(0, 20).map(t => ({ todo_id: t.todo_id, title: t.title, state: t.state, due_on: t.due_on }))
            : id === ids[0] && todoCase && !f.todoDone
              ? [{ todo_id: todoId, title: "Confirm boiler visit time", state: "open", due_on: "2026-11-22" }]
              : [];
          return {
            workspace_id: id, name: "Workspace " + number(id), role: "owner", last_seen_at: recent, new_messages: 0, content: null,
            // No agents on the roster: an agent of the viewer's that needs fixing would be counted too.
            people: [{ user_id: owner, display_name: "Synthetic owner", role: "owner", is_viewer: true, agents: [] }],
            needs_you: { asks, assigned, waiting: [] },
          };
        }) });
    }
    if (url.pathname === "/rest/v1/rpc/decision_queue") {
      const id = body?.p_workspace_id; f.log.push("queue:" + number(id));
      const authHeader = request.headers.get("authorization") ?? "";
      if (readRetireCase && id === ids[1] && authHeader === "Bearer synthetic-human") {
        f.ws2QueueAHeld = true;
        f.log.push("queue-2-a-held");
        await new Promise<void>(resolve => { releaseWs2QueueA = resolve; });
        f.log.push("queue-2-a-failed");
        return Response.json({ message: "simulated retired failure" }, { status: 500 });
      }
      if (readRetireCase && id === ids[8] && authHeader && authHeader !== "Bearer synthetic-human") {
        return Response.json({
          workspace_id: id, generated_at: new Date().toISOString(), total: 1, truncated: false,
          asks: [{ signal_id: askPeerB, from: { kind: "agent", id: agent, name: "Scout" }, body: "Peer B question in shared workspace?",
            created_at: recent, until, reraised: null }],
        });
      }
      if (id === ids[0] && (multiBatch || surveyCase || plainCleanupCase)) {
        const asks = ws1Asks();
        const total = truncatedQueue ? 105 : asks.length;
        const page = asks.slice(0, 100);
        return Response.json({ workspace_id: id, generated_at: new Date().toISOString(),
          total, truncated: truncatedQueue || asks.length > 100, asks: page });
      }
      return Response.json({ workspace_id: id, generated_at: new Date().toISOString(), total: open(id) ? 1 : 0, truncated: false,
        asks: open(id) ? [{ signal_id: ask, from: { kind: "agent", id: agent, name: "Scout" }, body: question,
          created_at: recent, until, reraised: null }] : [] });
    }
    if (url.pathname === "/rest/v1/rpc/decision_queue_page") {
      const id = body?.p_workspace_id; f.log.push("queue_page:" + number(id));
      if (id === ids[0] && batch101) {
        const asks = ws1Asks();
        const afterAt = body?.p_after_created_at;
        const afterId = body?.p_after_id;
        const rest = asks.filter(a => a.created_at > afterAt || (a.created_at === afterAt && a.signal_id > afterId));
        return Response.json({ workspace_id: id, generated_at: new Date().toISOString(),
          total: asks.length, truncated: rest.length > 100, asks: rest.slice(0, 100) });
      }
      return Response.json({ code: "PGRST202", message: "function not found" }, { status: 404 });
    }
    if (url.pathname === "/rest/v1/rpc/waiting_todos_page") {
      const id = body?.p_workspace_id; f.log.push("waiting_todos_page:" + number(id));
      if (todoTruncatedCase) {
        return Response.json({ code: "PGRST202", message: "function not found" }, { status: 404 });
      }
      if (id === ids[0] && todo21Case) {
        f.todoPages += 1;
        const all = ws1Todos21();
        const afterAt = body?.p_after_state_at;
        const afterId = body?.p_after_todo_id;
        const rest = afterAt && afterId
          ? all.filter(t => t.state_at < afterAt || (t.state_at === afterAt && t.todo_id > afterId))
          : all;
        const page = rest.slice(0, 20);
        return Response.json({
          workspace_id: id,
          generated_at: new Date().toISOString(),
          total: all.length,
          truncated: rest.length > 20,
          todos: page,
        });
      }
      if (id === ids[0] && todoCase) {
        const list = f.todoDone ? [] : [{
          todo_id: todoId, title: "Confirm boiler visit time", state: "open", due_on: "2026-11-22",
          reason: "assigned", agent_id: null, state_at: recent, placement: "workspace", channel_id: null,
        }];
        return Response.json({ workspace_id: id, generated_at: new Date().toISOString(), total: list.length, truncated: false, todos: list });
      }
      return Response.json({ workspace_id: id, generated_at: new Date().toISOString(), total: 0, truncated: false, todos: [] });
    }
    if (url.pathname === "/rest/v1/rpc/ask_choices") {
      f.log.push("choices:" + number(body?.p_workspace_id));
      const reqIds: string[] = Array.isArray(body?.p_signal_ids) ? body.p_signal_ids : [];
      if (body?.p_workspace_id === ids[0] && plainCleanupCase) {
        return Response.json({ asks: [] });
      }
      if (body?.p_workspace_id === ids[0] && (multiBatch || surveyCase)) {
        f.choiceBatchSizes.push(reqIds.length);
        return Response.json({ asks: reqIds.map(sigId => ({ signal_id: sigId, multi: false,
          options: [{ id: "yes", label: "Approve", recommended: true }, { id: "no", label: "Hold" }],
          answer: f.answeredIds.includes(sigId) ? { option_id: "yes", by_viewer: true } : null })) });
      }
      if (f.scenario.startsWith("failed-choices")) return Response.json({ message: "choices unavailable" }, { status: 500 });
      if (readRetireCase && body?.p_workspace_id === ids[8] && reqIds.includes(askPeerB)) {
        return Response.json({ asks: [{ signal_id: askPeerB, multi: false,
          options: [{ id: "yes", label: "Approve B" }, { id: "no", label: "Skip B" }], answer: null }] });
      }
      return Response.json({ asks: body?.p_workspace_id === ids[8] && reqIds.includes(ask) ? [{ signal_id: ask, multi: false,
        options: [{ id: "yes", label: "Yes, ship it" }, { id: "no", label: "Not yet" }],
        answer: f.answered ? { option_id: "yes", by_viewer: true } : null }] : [] });
    }
    if (url.pathname === "/rest/v1/signals" && url.searchParams.get("workspace_id") === "eq." + ids[0] && (multiBatch || surveyCase || plainCleanupCase)) {
      const idFilter = url.searchParams.get("id") ?? "";
      const match = idFilter.match(/^in\.\(([^)]+)\)$/);
      if (match) {
        const reqIds = match[1]!.split(",").map(s => s.trim()).filter(Boolean);
        return Response.json(reqIds.map(sigId => ({
          id: sigId,
          channel_id: surveyCase || plainCleanupCase || (batch51 && sigId === ask51) || (batch101 && sigId === ask101) ? null : otherChannel,
          to: null, to_agent: null, thread_root_id: null, from: agent, from_kind: "agent",
        })));
      }
    }
    if (url.pathname === "/rest/v1/signals" && url.searchParams.get("workspace_id") === "eq." + ids[8] && (url.searchParams.get("id")?.includes(ask) || url.searchParams.get("id")?.includes(askPeerB))) {
      if (readRetireCase) {
        const idFilter = url.searchParams.get("id") ?? "";
        const targetId = idFilter.includes(askPeerB) ? askPeerB : ask;
        return Response.json([{ id: targetId, channel_id: otherChannel, to: null, to_agent: null, thread_root_id: null, from: agent, from_kind: "agent" }]);
      }
      return Response.json([{ id: ask, channel_id: null, to: owner, to_agent: null, thread_root_id: null, from: agent, from_kind: "agent" }]);
    }
    if (url.pathname === "/functions/v1/command" && body?.command?.kind === "household_tool" && body?.command?.tool === "todo_read") {
      f.log.push("todo_read");
      return Response.json({
        status: "ok",
        todo: {
          workspace_id: ids[0], todo_id: todoId, version: 3, title: "Confirm boiler visit time", notes: "",
          state: f.todoDone ? "done" : "open", due_on: "2026-11-22",
          created_by: { user_id: owner, principal_id: null }, created_at: recent,
          assignee: { kind: "user", id: owner }, assigned_by: null, assigned_at: recent,
          offer: null, gate: { kind: "none" }, gate_clear: true, queue_position: null,
          state_by: { user_id: owner, principal_id: null }, state_at: recent, comment_count: 0,
        },
        comments: [],
        next_comment_offset: null,
      });
    }
    if (url.pathname === "/functions/v1/command" && body?.command?.kind === "household_tool" && body?.command?.tool === "todo_set_state") {
      f.todoWrites.push(body.command.arguments);
      f.log.push("todo_set_state");
      if (f.todoFailOnce) {
        f.todoFailOnce = false;
        return Response.json({ status: "refused", reason: "not_permitted" });
      }
      f.todoDone = true;
      return Response.json({
        status: "committed",
        value: {
          workspace_id: ids[0], todo_id: todoId, version: 4, title: "Confirm boiler visit time", notes: "",
          state: "done", due_on: "2026-11-22",
          created_by: { user_id: owner, principal_id: null }, created_at: recent,
          assignee: { kind: "user", id: owner }, assigned_by: null, assigned_at: recent,
          offer: null, gate: { kind: "none" }, gate_clear: true, queue_position: null,
          state_by: { user_id: owner, principal_id: null }, state_at: recent, comment_count: 0,
        },
        notices: [],
        replayed: false,
      });
    }
    if (url.pathname === "/functions/v1/command" && body?.command?.kind === "post_signal" && typeof body?.command?.in_reply_to === "string") {
      const replyTarget = body.command.in_reply_to;
      f.plainAttempts += 1;
      f.plainBearers.push(request.headers.get("authorization") ?? "");
      f.plainCommandIds.push(String(body.command_id ?? ""));
      if (f.plain401Once) {
        f.plain401Once = false;
        f.log.push("plain-401");
        return Response.json({ error: "unauthenticated", message: "expired" }, { status: 401 });
      }
      if (f.plainFailOnceId && replyTarget === f.plainFailOnceId) {
        f.plainFailOnceId = "";
        f.plainFailedCommandId = String(body.command_id ?? "");
        f.log.push("plain-failed");
        return Response.json({ status: "refused", error: "temporary_error", message: "Could not deliver reply." }, { status: 500 });
      }
      f.plainReplies.push(body);
      f.answeredIds.push(replyTarget);
      f.log.push("plain-reply");
      return Response.json({
        status: "accepted",
        ok: true,
        event_ids: [],
        signal: { id: "88888888-8888-4888-8888-00000000000" + f.plainReplies.length, body: body.command.body, in_reply_to: replyTarget },
      });
    }
    if (url.pathname === "/functions/v1/command" && body?.command?.kind === "answer_choice") {
      if (surveyAuthRetireCase && body.command.signal_id === surveyAsks[0] && !f.firstAnswerHeld) {
        f.firstAnswerHeld = true;
        f.log.push("answer-1-held");
        await new Promise<void>(resolve => { releaseFirstAnswer = resolve; });
        f.log.push("answer-1-released");
      }
      if (f.surveyFailOnceId && body.command.signal_id === f.surveyFailOnceId) {
        f.surveyFailOnceId = "";
        f.log.push("answer-failed");
        return Response.json({ status: "refused", error: "temporary_error", message: "Could not deliver answer." }, { status: 500 });
      }
      // From here on the answered ask is no longer waiting.
      f.answers.push(body); f.answered = true;
      if (typeof body.command.signal_id === "string") f.answeredIds.push(body.command.signal_id);
      f.log.push("answer");
      return Response.json({ status: "accepted", choice_answer: { option_id: body.command.option_id, other_text: body.command.other_text ?? null } });
    }
    if (url.pathname === "/rest/v1/channels" && url.searchParams.get("workspace_id") === "eq." + ids[8] && readRetireCase) {
      const authHeader = request.headers.get("authorization") ?? "";
      if (authHeader === "Bearer synthetic-human") {
        f.ws9ChannelsAHeld = true;
        f.log.push("channels-9-a-held");
        await new Promise<void>(resolve => { releaseWs9ChannelsA = resolve; });
        f.log.push("channels-9-a-released");
        return Response.json([{ channel_id: otherChannel, slug: "leaked-a-secret", title: "Secret A", kind: "private", archived_at: null }]);
      }
      return Response.json([{ channel_id: otherChannel, slug: "shared-b-channel", title: "Shared B", kind: "public", archived_at: null }]);
    }
    if (url.pathname === "/rest/v1/channels" && url.searchParams.get("workspace_id") === "eq." + ids[0] && (multiBatch || todo21Case)) {
      if (todo21Case) {
        return Response.json([
          { channel_id: chBoiler, slug: "boiler-quotes", title: "Boiler quotes", kind: "public", archived_at: null },
          { channel_id: chReno, slug: "renovation", title: "Renovation", kind: "public", archived_at: null },
        ]);
      }
      return Response.json([{ channel_id: otherChannel, slug: "other", title: "Other", kind: "public", archived_at: null }]);
    }
    if (url.pathname === "/rest/v1/rpc/channel_unread") return Response.json({ workspace_id: body?.p_workspace_id ?? ids[0],
      generated_at: new Date().toISOString(), channels: todo21Case && body?.p_workspace_id === ids[0]
        ? [
            { channel_id: null, slug: "general", unread: null },
            { channel_id: chBoiler, slug: "boiler-quotes", unread: null },
            { channel_id: chReno, slug: "renovation", unread: null },
          ]
        : [{ channel_id: null, slug: "general", unread: null }] });
    if (url.pathname === "/rest/v1/workspaces") return Response.json(ids.map(id => (
      { workspace_id: id, org_id: org, name: "Workspace " + number(id), archived_at: null })));
    if (url.pathname === "/rest/v1/member_profiles") return Response.json([{ user_id: owner, display_name: "Synthetic owner", role: "owner" }]);
    // Signals, channels, rosters, files and the rest: every workspace is quiet.
    if (url.pathname.startsWith("/rest/v1/")) return Response.json([]);
    if (url.pathname === "/functions/v1/read") {
      if (body?.resource === "conversations") return Response.json({ error: "unsupported_resource" }, { status: 400 });
      return Response.json(body?.resource === "pending_access" ? { pending: [], agents: [] } : { grants: [] });
    }
    if (url.pathname === "/functions/v1/command") return Response.json({ status: "refused", reason: "content_consent_required" });
    f.unexpected.push(request.method + " " + url.pathname);
    return Response.json({ error: "unexpected_fixture_request" }, { status: 404 });
  };
  localStorage.setItem("sb-api-auth-token", JSON.stringify({ access_token: "synthetic-human",
    refresh_token: "synthetic-refresh", token_type: "bearer", expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600, user }));
}

async function observeWaitingCount() {
  const w = window as any, f = w.waitingFixture;
  const tick = async () => { const r = fetch("/__observer-tick"); await r; };
  const steps: string[] = [];
  // Every count and name drawn on either copy of the control, from before the app boots: "never zero" covers the whole run.
  const texts = new Set<string>(), names = new Set<string>();
  const sample = () => {
    for (const link of Array.from(document.querySelectorAll<HTMLElement>("a.cs-waiting"))) {
      texts.add(link.querySelector("[data-waiting-count]")?.textContent ?? ""); names.add(link.getAttribute("aria-label") ?? "");
    }
  };
  new MutationObserver(sample).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["aria-label"] });
  const shown = (node: Element | null | undefined): boolean => {
    if (!node) return false;
    const box = node.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && getComputedStyle(node).display !== "none";
  };
  // The header and the phone bar are rebuilt on navigation, so the control is looked up live at each step.
  const phoneCopy = () => document.querySelector<HTMLAnchorElement>(".cs-org-phone-bar a.cs-waiting--phone");
  const deskCopy = () => document.querySelector<HTMLAnchorElement>("[data-home-workspace-shell] .hm-ws-header__actions > a.cs-waiting");
  // Catch up has no workspace header; on a desktop its own copy sits at the same far-right spot.
  const pageCopy = () => document.querySelector<HTMLAnchorElement>("[data-home-catchup] > a.cs-waiting--page");
  const read = (link: Element | null) => [link?.querySelector("[data-waiting-count]")?.textContent ?? null, link?.getAttribute("aria-label") ?? null].join("|");
  const control = () => f.phone ? phoneCopy() : deskCopy();
  const count = () => control()?.querySelector<HTMLElement>("[data-waiting-count]")?.textContent ?? null;
  const name = () => control()?.getAttribute("aria-label") ?? null;
  const route = (key: string) => new URLSearchParams(location.search).get(key);
  const state = () => "count " + JSON.stringify(count()) + ", name " + JSON.stringify(name()) + ", displayed " + shown(control()) + ", at " + location.search +
    ", requests " + f.log.join(" ") + ", steps " + steps.join(" | ");
  const wait = async (predicate: () => unknown, label: string) => {
    for (let i = 0; i < 600; i++) { if (predicate()) { steps.push(label); return; } await tick(); }
    throw new Error("timed out at " + label + "; " + state());
  };
  const check = (value: unknown, message: string) => { if (!value) throw new Error(message + "; " + state()); };
  try {
    check(f.phone ? innerWidth <= 832 : innerWidth > 1024, "the viewport is " + innerWidth + " px wide, not a " + (f.phone ? "phone" : "desktop"));
    if (f.scenario.startsWith("uncounted-")) {
      const one = f.scenario.startsWith("uncounted-one");
      await wait(() => shown(control()) && f.overviewReads > 0 && (!one || count() === "1+"), one ? "the minimum is drawn" : "the control is drawn and the overview answered");
      // With nothing waiting, the expected reading is also what is drawn before any read. So let the reads finish: no
      // further overview read and no change on the control for thirty ticks.
      let stable = 0, last = "";
      for (let i = 0; stable < 30; i++) {
        if (i > 900) throw new Error("the count never settled; " + state());
        await tick();
        const now = f.overviewReads + "|" + count() + "|" + name();
        stable = now === last ? stable + 1 : 0; last = now;
      }
      sample();
      check(shown(control()), "the control is not displayed");
      if (one) check(count() === "1+" && name() === "Waiting on you 1+, still counting", "one known question with a workspace uncounted must read 1+");
      else check(count() === "" && name() === "Waiting on you, still counting", "nothing known with a workspace uncounted must draw no number");
      check(!texts.has("0") && !names.has("Waiting on you 0"), "an uncounted workspace was drawn as zero: counts " +
        JSON.stringify(Array.from(texts)) + ", names " + JSON.stringify(Array.from(names)));
      document.documentElement.dataset.waitingObservation = JSON.stringify({ ok: true, scenario: f.scenario, steps, unexpected: f.unexpected });
      return;
    }
    if (f.scenario.startsWith("failed-choices")) {
      await wait(() => shown(control()) && f.overviewReads > 0 && f.log.includes("choices:9"), "failed choices read attempted");
      control()!.click();
      const panel = () => document.querySelector<HTMLElement>("#cs-waiting-panel");
      await wait(() => shown(panel()) && shown(panel()?.querySelector("[data-waiting-scope]")), "panel opened during failed choices");
      const scope = panel()!.querySelector<HTMLSelectElement>("[data-waiting-scope]")!;
      scope.value = "all";
      scope.dispatchEvent(new Event("change", { bubbles: true }));
      await wait(() => shown(panel()?.querySelector('[data-waiting-state="failed"] [data-waiting-retry]')), "failed choices shows Retry instead of empty");
      check(!texts.has("0") && !names.has("Waiting on you 0"), "failed choices must never render zero on badge");
      document.documentElement.dataset.waitingObservation = JSON.stringify({ ok: true, scenario: f.scenario, steps, unexpected: f.unexpected });
      return;
    }
    if (f.scenario.startsWith("batch-51")) {
      await wait(() => shown(control()) && count() === "51", "top bar counts all 51 open questions");
      check(f.choiceBatchSizes.length >= 2 && f.choiceBatchSizes[0] === 50 && f.choiceBatchSizes[1] === 1,
        "ask_choices must page past 50: " + JSON.stringify(f.choiceBatchSizes));
      control()!.click();
      const panel = () => document.querySelector<HTMLElement>("#cs-waiting-panel");
      const card51 = () => panel()?.querySelector<HTMLElement>(`[data-waiting-card="${f.ask51}"]`) ?? null;
      await wait(() => shown(card51()), "question 51 appears in This channel (#general) on open");
      const scope = panel()!.querySelector<HTMLSelectElement>("[data-waiting-scope]")!;
      check(scope.value === "channel" && scope.options[0]!.textContent === "This channel (1)" && scope.options[1]!.textContent === "All channels (51)",
        "unexpected scope labels for 51-question queue: " + Array.from(scope.options).map(o => o.textContent).join(" | "));
      card51()!.querySelector<HTMLButtonElement>('button[data-decision-option="yes"]')!.click();
      await wait(() => f.answers.length === 1 && !card51() && shown(panel()?.querySelector("[data-waiting-status]")) &&
        panel()?.querySelector("[data-waiting-status]")?.textContent === "Sent", "answering question 51 removes card and shows Sent");
      await wait(() => count() === "50", "top bar updates from 51 to 50 after answering question 51");
      document.documentElement.dataset.waitingObservation = JSON.stringify({ ok: true, scenario: f.scenario, steps, unexpected: f.unexpected });
      return;
    }
    if (f.scenario.startsWith("batch-101")) {
      await wait(() => shown(control()) && count() === "99+" && f.log.includes("queue_page:1"), "top bar counts 99+ and decision_queue_page ran for page 2");
      check(f.choiceBatchSizes.length >= 3 && f.choiceBatchSizes[0] === 50 && f.choiceBatchSizes[1] === 50 && f.choiceBatchSizes[2] === 1,
        "ask_choices must batch all 101 asks in 50+50+1: " + JSON.stringify(f.choiceBatchSizes));
      control()!.click();
      const panel = () => document.querySelector<HTMLElement>("#cs-waiting-panel");
      const card101 = () => panel()?.querySelector<HTMLElement>(`[data-waiting-card="${f.ask101}"]`) ?? null;
      await wait(() => shown(card101()), "question 101 appears in This channel (#general) while 1..100 stay unanswered");
      const scope = panel()!.querySelector<HTMLSelectElement>("[data-waiting-scope]")!;
      check(scope.value === "channel" && scope.options[0]!.textContent === "This channel (1)" && scope.options[1]!.textContent === "All channels (99+)",
        "unexpected scope labels for 101-question queue: " + Array.from(scope.options).map(o => o.textContent).join(" | "));
      card101()!.querySelector<HTMLButtonElement>('button[data-decision-option="yes"]')!.click();
      await wait(() => f.answers.length === 1 && f.answers[0].command.signal_id === f.ask101 && !card101() &&
        shown(panel()?.querySelector("[data-waiting-status]")) && panel()?.querySelector("[data-waiting-status]")?.textContent === "Sent",
        "answering question 101 from its channel sends answer_choice, removes card, and shows Sent");
      await wait(() => scope.options[0]!.textContent === "This channel (0)" && panel()?.querySelector('[data-waiting-state="empty"]'),
        "after answering question 101, This channel cleanly reads 0 while 1..100 stay open in All channels");
      document.documentElement.dataset.waitingObservation = JSON.stringify({ ok: true, scenario: f.scenario, steps, unexpected: f.unexpected });
      return;
    }
    if (f.scenario.startsWith("truncated-queue")) {
      await wait(() => shown(control()) && count() === "99+", "top bar counts 99+ for 105 open questions");
      control()!.click();
      const panel = () => document.querySelector<HTMLElement>("#cs-waiting-panel");
      await wait(() => shown(panel()?.querySelector('[data-waiting-state="truncated"]')), "truncated queue shows truncated notice instead of false empty");
      const scope = panel()!.querySelector<HTMLSelectElement>("[data-waiting-scope]")!;
      check(scope.options[0]!.textContent === "This channel", "truncated channel must not claim (0): " + scope.options[0]!.textContent);
      check(scope.options[1]!.textContent === "All channels (99+)", "truncated workspace count must read 99+: " + scope.options[1]!.textContent);
      check(!panel()!.querySelector('[data-waiting-state="empty"]'), "truncated channel rendered false empty state");
      const catchUp = panel()!.querySelector<HTMLElement>("[data-waiting-open-catchup]")!;
      check(shown(catchUp) && catchUp.getBoundingClientRect().height >= 44, "Open Catch up link missing or under 44px");
      panel()!.querySelector<HTMLButtonElement>('[data-waiting-switch-scope="workspace"]')!.click();
      await wait(() => panel()!.querySelectorAll("[data-waiting-card]").length === 100 && shown(panel()?.querySelector("[data-waiting-truncated] [data-waiting-open-catchup]")),
        "All channels shows 100 loaded cards and inline truncation notice with Open Catch up");
      document.documentElement.dataset.waitingObservation = JSON.stringify({ ok: true, scenario: f.scenario, steps, unexpected: f.unexpected });
      return;
    }
    if (f.scenario.startsWith("todos-21-")) {
      await wait(() => shown(control()) && count() === "21" && f.todoPages >= 2,
        "top bar counts all 21 to-dos after waiting_todos_page paginates past 20");
      control()!.click();
      const panel = () => document.querySelector<HTMLElement>("#cs-waiting-panel");
      const todo1Card = () => panel()?.querySelector<HTMLElement>(`[data-waiting-todo="${f.todo1}"]`) ?? null;
      const todo21Card = () => panel()?.querySelector<HTMLElement>(`[data-waiting-todo="${f.todo21}"]`) ?? null;
      await wait(() => shown(todo1Card()), "#boiler-quotes This channel shows only its channel-origin to-do #1");
      const scope = panel()!.querySelector<HTMLSelectElement>("[data-waiting-scope]")!;
      check(scope.value === "channel" && scope.options[0]!.textContent === "This channel (1)" && scope.options[1]!.textContent === "All channels (21)",
        "unexpected scope labels for 21-todo two-channel workspace: " + Array.from(scope.options).map(o => o.textContent).join(" | "));
      check(!todo21Card() && panel()!.querySelectorAll("[data-waiting-todo]").length === 1,
        "#boiler-quotes must not show #renovation or workspace-only to-dos");
      // Switch to #renovation in the channel rail: desktop column stays open and shows item #21 (past overview's 20-item cap)!
      const renoLink = document.querySelector<HTMLElement>(`a[href*="c=${f.chReno}"]`);
      check(Boolean(renoLink), "expected #renovation channel link in sidebar");
      renoLink!.click();
      await wait(() => shown(todo21Card()) && !todo1Card(),
        "switching to #renovation updates This channel to show channel-origin to-do #21");
      check(scope.options[0]!.textContent === "This channel (1)" && panel()!.querySelectorAll("[data-waiting-todo]").length === 1,
        "#renovation must show only its own to-do #21");
      // Switching to All channels shows all 21 to-dos (channel-origin + workspace-only).
      scope.value = "workspace";
      scope.dispatchEvent(new Event("change", { bubbles: true }));
      await wait(() => panel()!.querySelectorAll("[data-waiting-todo]").length === 21 && shown(todo1Card()) && shown(todo21Card()),
        "All channels lists all 21 to-dos including items 1 and 21");
      document.documentElement.dataset.waitingObservation = JSON.stringify({ ok: true, scenario: f.scenario, steps, unexpected: f.unexpected });
      return;
    }
    if (f.scenario.startsWith("todos-truncated-")) {
      await wait(() => shown(control()) && f.log.includes("waiting_todos_page:1"), "waiting_todos_page fallback triggered");
      control()!.click();
      const panel = () => document.querySelector<HTMLElement>("#cs-waiting-panel");
      await wait(() => shown(panel()?.querySelector('[data-waiting-state="truncated"]')),
        "unpaged 20-cap fallback shows truncated notice instead of false exact 20");
      const scope = panel()!.querySelector<HTMLSelectElement>("[data-waiting-scope]")!;
      check(scope.options[0]!.textContent === "This channel" && scope.options[1]!.textContent === "All channels (20+)",
        "20-capped overview must show 20+ minimum, never exact 20: " + Array.from(scope.options).map(o => o.textContent).join(" | "));
      check(count() !== "20", "top bar must not claim exact 20 when overview is at its 20-item cap: " + count());
      document.documentElement.dataset.waitingObservation = JSON.stringify({ ok: true, scenario: f.scenario, steps, unexpected: f.unexpected });
      return;
    }
    if (f.scenario.startsWith("todos-")) {
      await wait(() => shown(control()) && count() === "1", "assigned to-do is counted in the top bar");
      control()!.click();
      const panel = () => document.querySelector<HTMLElement>("#cs-waiting-panel");
      const showWs = () => panel()?.querySelector<HTMLButtonElement>('[data-waiting-switch-scope="workspace"]') ?? null;
      await wait(() => shown(showWs()) && showWs()!.textContent === "Show all channels (1)",
        "This channel stays channel-specific and offers Show all channels (1) for the workspace to-do");
      showWs()!.click();
      const todoCard = () => panel()?.querySelector<HTMLElement>(`[data-waiting-todo="${f.todoId}"]`) ?? null;
      const doneBtn = () => todoCard()?.querySelector<HTMLButtonElement>(`[data-waiting-todo-done="${f.todoId}"]`) ?? null;
      const openLink = () => todoCard()?.querySelector<HTMLAnchorElement>(`[data-waiting-todo-open="${f.todoId}"]`) ?? null;
      await wait(() => shown(todoCard()) && shown(doneBtn()) && shown(openLink()), "assigned to-do renders with Mark done and Open");
      check(doneBtn()!.getBoundingClientRect().height >= 44 && openLink()!.getBoundingClientRect().height >= 44, "to-do action targets under 44px");
      // First attempt fails (refused) while focused: card stays visible with role="alert" and focus lands on Retry (never document.body).
      doneBtn()!.focus();
      doneBtn()!.click();
      const retryBtn = () => todoCard()?.querySelector<HTMLButtonElement>(`[data-waiting-todo-retry="${f.todoId}"]`) ?? null;
      await wait(() => shown(retryBtn()) && shown(todoCard()?.querySelector('[role="alert"]')), "failed Mark done keeps to-do card visible with Retry");
      check(document.activeElement === retryBtn(), "failed Mark done must focus Retry on the same card, got " + (document.activeElement?.tagName ?? "null"));
      // Retry commits state=done, removes card, shows visible Done banner, updates count to 0, and keeps focus inside panel.
      retryBtn()!.click();
      await wait(() => !todoCard() && shown(panel()?.querySelector("[data-waiting-status]")) &&
        panel()?.querySelector("[data-waiting-status]")?.textContent === "Done" && count() === "0",
        "Retry completes to-do, displays Done banner, and updates count to 0");
      check(document.activeElement !== document.body && Boolean(panel()?.contains(document.activeElement)),
        "after completion, focus must remain inside panel rather than document.body, got " + (document.activeElement?.tagName ?? "null"));
      if (!f.phone) {
        document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
        await wait(() => Boolean(panel()?.hidden) && document.activeElement === control(),
          "Escape closes desktop column after to-do completion and returns focus to opener");
      }
      check(f.todoWrites.length === 2 && f.todoWrites[1].state === "done" && f.todoWrites[1].base_version === 3,
        "unexpected todo_set_state calls: " + JSON.stringify(f.todoWrites));
      document.documentElement.dataset.waitingObservation = JSON.stringify({ ok: true, scenario: f.scenario, steps, unexpected: f.unexpected });
      return;
    }
    if (f.scenario.startsWith("waiting-read-retire-")) {
      await wait(() => f.ws9ChannelsAHeld && f.ws2QueueAHeld, "Account A background workspaceChannels and ws2 decision_queue held in flight");
      // Switch to Account B in a peer document while Account A's background reads are still held in flight.
      const peer = document.createElement("iframe");
      peer.src = "/peer-switch";
      document.body.append(peer);
      await wait(() => f.log.includes("overview-b") && shown(control()) && count() === "1",
        "Account B booted and counted its own shared-workspace ask");
      control()!.click();
      const panel = () => document.querySelector<HTMLElement>("#cs-waiting-panel");
      const scope = () => panel()?.querySelector<HTMLSelectElement>("[data-waiting-scope]") ?? null;
      await wait(() => shown(panel()) && shown(scope()), "Account B opened Waiting on you panel");
      scope()!.value = "all";
      scope()!.dispatchEvent(new Event("change", { bubbles: true }));
      const cardB = () => panel()?.querySelector<HTMLElement>(`[data-waiting-card="${f.askPeerB}"]`) ?? null;
      await wait(() => shown(cardB()) && cardB()!.querySelector(".cs-waiting-card__place")?.textContent === "Workspace 9 · #shared-b-channel",
        "Account B sees Workspace 9 #shared-b-channel card cleanly");
      // Now release Account A's retired workspaceChannels (#leaked-a-secret) and failed ws2 decision_queue (500).
      f.releaseWs9ChannelsA();
      f.releaseWs2QueueA();
      for (let i = 0; i < 25; i++) await tick();
      // Force a panel re-render via scope toggle to prove waitingWorkspaceChannels was NOT overwritten by Account A.
      scope()!.value = "channel";
      scope()!.dispatchEvent(new Event("change", { bubbles: true }));
      await tick();
      scope()!.value = "all";
      scope()!.dispatchEvent(new Event("change", { bubbles: true }));
      await wait(() => shown(cardB()), "Account B card still visible after retired Account A reads settled");
      const placeBadge = cardB()!.querySelector(".cs-waiting-card__place")?.textContent ?? "";
      check(placeBadge === "Workspace 9 · #shared-b-channel" && !panel()!.textContent!.includes("leaked-a-secret"),
        "retired Account A workspaceChannels poisoned Account B channel label: " + placeBadge);
      check(!panel()!.querySelector("[data-waiting-incomplete]"),
        "retired Account A failed queue altered Account B load state");
      check(!panel()!.querySelector(`[data-waiting-card="${f.ask}"]`),
        "retired Account A card appeared in Account B panel");
      peer.remove();
      document.documentElement.dataset.waitingObservation = JSON.stringify({ ok: true, scenario: f.scenario, steps, unexpected: f.unexpected });
      return;
    }
    if (f.scenario.startsWith("survey-auth-retire-")) {
      await wait(() => shown(control()) && count() === "3", "3 survey questions counted in top bar");
      control()!.click();
      const panel = () => document.querySelector<HTMLElement>("#cs-waiting-panel");
      const reviewBtn = () => panel()?.querySelector<HTMLButtonElement>("[data-waiting-review-start]") ?? null;
      await wait(() => shown(reviewBtn()), "Review questions button rendered");
      reviewBtn()!.click();
      const optYes = () => panel()?.querySelector<HTMLButtonElement>('[data-survey-option="yes"]') ?? null;
      const nextBtn = () => panel()?.querySelector<HTMLButtonElement>("[data-waiting-survey-next]") ?? null;
      const skipBtn = () => panel()?.querySelector<HTMLButtonElement>("[data-waiting-survey-skip]") ?? null;
      const sendAllBtn = () => panel()?.querySelector<HTMLButtonElement>("[data-waiting-survey-send]") ?? null;
      await wait(() => shown(optYes()), "Survey step 1 rendered");
      optYes()!.click();
      nextBtn()!.click();
      await wait(() => panel()?.querySelector("[data-waiting-survey-progress]")?.textContent === "Question 2 of 3", "Survey step 2 rendered");
      optYes()!.click();
      nextBtn()!.click();
      await wait(() => panel()?.querySelector("[data-waiting-survey-progress]")?.textContent === "Question 3 of 3", "Survey step 3 rendered");
      skipBtn()!.click();
      await wait(() => shown(sendAllBtn()), "Survey review rendered");
      // Click Send all: Q1 answer_choice is held in flight.
      sendAllBtn()!.click();
      await wait(() => f.firstAnswerHeld, "Q1 answer_choice held in flight");
      // Trigger a real peer account switch in another document while Q1 is in flight and hold /auth/v1/user for User B.
      const peer = document.createElement("iframe");
      peer.src = "/peer-switch";
      document.body.append(peer);
      await wait(() => f.identityCheckHeld, "peer account switch triggered new /auth/v1/user check (held pending)");
      // Panel must already be retired synchronously before Q1 or /auth/v1/user settles.
      check(!shown(panel()) && panel()!.textContent!.trim() === "",
        "Waiting panel was not retired immediately at peer account switch: " + panel()!.textContent);
      // Release Q1 while User B's /auth/v1/user is STILL pending (dashboard session still holds User A's old session!).
      f.releaseFirstAnswer();
      for (let i = 0; i < 25; i++) await tick();
      check(f.answers.length === 1 && f.answers[0].command.signal_id === f.surveyAsks[0],
        "held survey batch sent an extra answer after peer account switch: " + JSON.stringify(f.answers));
      check(!shown(panel()) && panel()!.textContent!.trim() === "",
        "Waiting panel re-rendered old viewer cards after retired Q1 settled: " + panel()!.textContent);
      f.releaseIdentityCheck();
      for (let i = 0; i < 15; i++) await tick();
      check(f.answers.length === 1, "extra answer sent after User B identity check settled: " + JSON.stringify(f.answers));
      peer.remove();
      document.documentElement.dataset.waitingObservation = JSON.stringify({ ok: true, scenario: f.scenario, steps, unexpected: f.unexpected });
      return;
    }
    if (f.scenario.startsWith("survey-")) {
      await wait(() => shown(control()) && count() === "3", "3 choice questions counted in #general");
      control()!.click();
      const panel = () => document.querySelector<HTMLElement>("#cs-waiting-panel");
      const reviewStart = () => panel()?.querySelector<HTMLButtonElement>("[data-waiting-review-start]") ?? null;
      await wait(() => shown(reviewStart()) && reviewStart()!.textContent === "Review questions", "Review questions button visible");
      check(reviewStart()!.getBoundingClientRect().height >= 44, "Review questions button under 44px");
      reviewStart()!.focus();
      reviewStart()!.click();
      // Q1: pick Approve, click Next.
      await wait(() => shown(panel()?.querySelector('[data-survey-option="yes"]')), "Q1 shown in survey");
      check(Boolean(panel()?.contains(document.activeElement)), "entering survey must keep focus inside panel");
      panel()!.querySelector<HTMLButtonElement>('[data-survey-option="yes"]')!.click();
      await wait(() => panel()?.querySelector('[data-survey-option="yes"]')?.getAttribute("aria-pressed") === "true", "Q1 choice staged");
      panel()!.querySelector<HTMLButtonElement>("[data-waiting-survey-next]")!.click();
      // Q2: type "Keep this for later" under Something else, Skip, then Back -> draft is restored;
      // Skip again -> stays skipped and omitted from final Send 2 answers.
      await wait(() => panel()?.querySelector("[data-waiting-survey-progress]")?.textContent === "Question 2 of 3", "stepped to Q2");
      check(Boolean(panel()?.contains(document.activeElement)), "Next must keep focus inside panel");
      panel()!.querySelector<HTMLButtonElement>("[data-survey-other-toggle]")!.click();
      await wait(() => shown(panel()?.querySelector("[data-survey-other-input]")), "Other input opened on Q2");
      const q2Other = panel()!.querySelector<HTMLInputElement>("[data-survey-other-input]")!;
      q2Other.value = "Keep this for later";
      q2Other.dispatchEvent(new Event("input", { bubbles: true }));
      panel()!.querySelector<HTMLButtonElement>("[data-waiting-survey-skip]")!.click();
      await wait(() => panel()?.querySelector("[data-waiting-survey-progress]")?.textContent === "Question 3 of 3", "stepped to Q3 after skipping Q2");
      panel()!.querySelector<HTMLButtonElement>("[data-waiting-survey-back]")!.click();
      await wait(() => panel()?.querySelector("[data-waiting-survey-progress]")?.textContent === "Question 2 of 3" &&
        shown(panel()?.querySelector("[data-survey-other-input]")) &&
        panel()!.querySelector<HTMLInputElement>("[data-survey-other-input]")!.value === "Keep this for later",
        "Back after Skip restored Q2 Other draft");
      panel()!.querySelector<HTMLButtonElement>("[data-waiting-survey-skip]")!.click();
      // Q3: Something else + custom text, then close and reopen panel to prove session drafts persist.
      await wait(() => panel()?.querySelector("[data-waiting-survey-progress]")?.textContent === "Question 3 of 3", "stepped to Q3");
      panel()!.querySelector<HTMLButtonElement>("[data-survey-other-toggle]")!.click();
      await wait(() => shown(panel()?.querySelector("[data-survey-other-input]")), "Other input opened on Q3");
      const otherInput = panel()!.querySelector<HTMLInputElement>("[data-survey-other-input]")!;
      check(document.activeElement === otherInput, "toggling Something else open focuses its input");
      otherInput.value = "After 2pm";
      otherInput.dispatchEvent(new Event("input", { bubbles: true }));
      // Close and reopen panel: survey drafts persist in this session.
      panel()!.querySelector<HTMLButtonElement>("[data-waiting-close]")!.click();
      await wait(() => !shown(panel()), "panel closed mid-survey");
      control()!.click();
      await wait(() => shown(panel()?.querySelector("[data-survey-other-input]")) &&
        panel()!.querySelector<HTMLInputElement>("[data-survey-other-input]")!.value === "After 2pm",
        "reopening panel preserved Q3 Other draft");
      // Advance to Review answers: 2 ready, 1 skipped.
      panel()!.querySelector<HTMLButtonElement>("[data-waiting-survey-next]")!.click();
      await wait(() => shown(panel()?.querySelector("[data-waiting-survey-send]")) &&
        panel()?.querySelector("[data-waiting-survey-send]")?.textContent === "Send 2 answers",
        "Review answers shows Send 2 answers");
      // First Send: Q1 succeeds, Q3 fails once -> stays on review with Q3 editable, error alert, and focus inside panel.
      const sendBtn = panel()!.querySelector<HTMLButtonElement>("[data-waiting-survey-send]")!;
      sendBtn.focus();
      sendBtn.click();
      await wait(() => f.answers.length === 1 && f.answers[0].command.signal_id === f.surveyAsks[0] &&
        shown(panel()?.querySelector(`[data-waiting-survey-item="${f.surveyAsks[2]}"] [role="alert"]`)) &&
        panel()?.querySelector("[data-waiting-survey-send]")?.textContent === "Send 1 answer",
        "partial send kept failed Q3 editable on review while Q1 left");
      check(document.activeElement !== document.body && Boolean(panel()?.contains(document.activeElement)),
        "partial survey failure must keep focus inside panel, got " + (document.activeElement?.tagName ?? "null"));
      // Retry Q3: succeeds, exits survey, shows visible Sent banner, leaves skipped Q2 open (count 1), keeps focus inside panel.
      const retrySend = panel()!.querySelector<HTMLButtonElement>("[data-waiting-survey-send]")!;
      retrySend.focus();
      retrySend.click();
      await wait(() => f.answers.length === 2 && f.answers[1].command.signal_id === f.surveyAsks[2] &&
        f.answers[1].command.other_text === "After 2pm" &&
        shown(panel()?.querySelector("[data-waiting-status]")) &&
        shown(panel()?.querySelector(`[data-waiting-card="${f.surveyAsks[1]}"]`)) &&
        count() === "1",
        "retry sent Q3, showed Sent banner, and left skipped Q2 open");
      check(document.activeElement !== document.body && Boolean(panel()?.contains(document.activeElement)),
        "survey completion must keep focus inside panel, got " + (document.activeElement?.tagName ?? "null"));
      if (!f.phone) {
        document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
        await wait(() => Boolean(panel()?.hidden) && document.activeElement === control(),
          "Escape closes desktop column after survey completion and returns focus to opener");
      }
      document.documentElement.dataset.waitingObservation = JSON.stringify({ ok: true, scenario: f.scenario, steps, unexpected: f.unexpected });
      return;
    }
    if (f.scenario.startsWith("plain-401-retire-")) {
      await wait(() => shown(control()) && count() === "2", "two historical plain-text asks counted");
      control()!.click();
      const panel = () => document.querySelector<HTMLElement>("#cs-waiting-panel");
      const card1 = () => panel()?.querySelector<HTMLElement>(`[data-waiting-plain-ask="${f.plainAsks[0]}"]`) ?? null;
      await wait(() => shown(panel()) && shown(card1()), "plain-text ask card 1 rendered");
      const input1 = card1()!.querySelector<HTMLInputElement>("[data-waiting-plain-input]")!;
      const send1 = card1()!.querySelector<HTMLButtonElement>("[data-waiting-plain-send]")!;
      input1.focus();
      input1.value = "Owner A private draft";
      input1.dispatchEvent(new Event("input", { bubbles: true }));
      // Click Send: initial post_signal returns 401 and postCommand enters /auth/v1/token refresh (held open).
      send1.click();
      await wait(() => f.refreshHeld && f.plainAttempts === 1, "historical plain-ask 401 entered held refresh");
      // Explicit sign-out synchronously calls resetWorkspaceSessionState() -> retireWaitingState() while refresh is held.
      const signOutBtn = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-signout]")).find(el => !el.hidden) ??
        document.querySelector<HTMLButtonElement>("[data-signout]");
      check(Boolean(signOutBtn), "sign-out button missing");
      signOutBtn!.click();
      // Panel and previous viewer's cards/draft must be cleared immediately.
      await wait(() => !shown(panel()) && panel()!.textContent!.trim() === "", "Waiting panel retired immediately on sign-out");
      // Release refresh with a refreshed session for Owner A: postCommand's isAlive fence must block the 401 retry.
      f.releaseRefresh();
      for (let i = 0; i < 25; i++) await tick();
      check(f.plainAttempts === 1 && f.plainReplies.length === 0,
        "401 retry was NOT fenced after login retired: attempts=" + f.plainAttempts + ", replies=" + JSON.stringify(f.plainReplies));
      check(!panel()!.textContent!.includes("Owner A private draft") && !panel()!.querySelector("[data-waiting-plain-ask]"),
        "previous viewer's plain-ask card or draft reappeared after retired 401 settled");
      document.documentElement.dataset.waitingObservation = JSON.stringify({ ok: true, scenario: f.scenario, steps, unexpected: f.unexpected });
      return;
    }
    if (f.scenario.startsWith("plain-401-refresh-control-")) {
      await wait(() => shown(control()) && count() === "2", "two historical plain-text asks counted for unchanged-login control");
      control()!.click();
      const panel = () => document.querySelector<HTMLElement>("#cs-waiting-panel");
      const card1 = () => panel()?.querySelector<HTMLElement>(`[data-waiting-plain-ask="${f.plainAsks[0]}"]`) ?? null;
      await wait(() => shown(panel()) && shown(card1()), "plain-text ask card 1 rendered");
      const input1 = card1()!.querySelector<HTMLInputElement>("[data-waiting-plain-input]")!;
      const send1 = card1()!.querySelector<HTMLButtonElement>("[data-waiting-plain-send]")!;
      input1.focus();
      input1.value = "Refreshed login control answer";
      input1.dispatchEvent(new Event("input", { bubbles: true }));
      send1.click();
      await wait(() => f.plainReplies.length === 1 && !card1() && panel()?.querySelector("[data-waiting-status]")?.textContent === "Sent" && count() === "1",
        "unchanged-login 401 token refresh retried and delivered reply");
      check(f.plainAttempts === 2 && f.plainBearers[1] === "Bearer synthetic-human-refreshed" &&
        f.plainCommandIds[0] === f.plainCommandIds[1],
        "expected refreshed bearer retry with same command_id: " + JSON.stringify({ attempts: f.plainAttempts, bearers: f.plainBearers, ids: f.plainCommandIds }));
      document.documentElement.dataset.waitingObservation = JSON.stringify({ ok: true, scenario: f.scenario, steps, unexpected: f.unexpected });
      return;
    }
    if (f.scenario.startsWith("historical-cleanup-")) {
      await wait(() => shown(control()) && count() === "2", "two historical plain-text asks counted");
      // Mount a synthetic corner invitation card to verify desktop clearance next to the open Waiting on you column.
      const inviteCard = document.createElement("human-invitation-inbox");
      inviteCard.setAttribute("data-kylon-invite", "");
      inviteCard.setAttribute("data-placement", "corner");
      inviteCard.style.position = "fixed";
      inviteCard.style.insetBlockEnd = "144px";
      inviteCard.style.inlineSize = "320px";
      inviteCard.style.blockSize = "140px";
      inviteCard.style.display = "block";
      document.body.append(inviteCard);
      control()!.click();
      const panel = () => document.querySelector<HTMLElement>("#cs-waiting-panel");
      const card1 = () => panel()?.querySelector<HTMLElement>(`[data-waiting-plain-ask="${f.plainAsks[0]}"]`) ?? null;
      const card2 = () => panel()?.querySelector<HTMLElement>(`[data-waiting-plain-ask="${f.plainAsks[1]}"]`) ?? null;
      await wait(() => shown(panel()) && shown(card1()) && shown(card2()), "Waiting on you rendered both historical plain-text ask cards");
      const panelBox = panel()!.getBoundingClientRect();
      const inviteBox = inviteCard.getBoundingClientRect();
      check(inviteBox.right <= panelBox.left + 1 && inviteBox.left >= 0,
        `corner invitation overlapped Waiting on you column or left edge: invite=${JSON.stringify(inviteBox)}, panel=${JSON.stringify(panelBox)}`);
      const input1 = card1()!.querySelector<HTMLInputElement>("[data-waiting-plain-input]")!;
      const send1 = card1()!.querySelector<HTMLButtonElement>("[data-waiting-plain-send]")!;
      const stale1 = card1()!.querySelector<HTMLButtonElement>("[data-waiting-plain-stale]")!;
      check(send1.disabled === true, "Send button should start disabled before typing");
      check(send1.getBoundingClientRect().height >= 44 && stale1.getBoundingClientRect().height >= 44 && input1.getBoundingClientRect().height >= 44,
        "plain-ask controls under 44px hit target");
      input1.focus();
      input1.value = "Go with Option B next Tuesday.";
      input1.dispatchEvent(new Event("input", { bubbles: true }));
      check(send1.disabled === false, "Send button should enable after typing");
      send1.click();
      await wait(() => f.plainReplies.length === 1 && !card1() && panel()?.querySelector("[data-waiting-status]")?.textContent === "Sent",
        "plain-ask inline answer sent post_signal reply and removed card");
      check(f.plainReplies[0].command.in_reply_to === f.plainAsks[0] && f.plainReplies[0].command.body === "Go with Option B next Tuesday.",
        "unexpected plain-ask reply payload: " + JSON.stringify(f.plainReplies[0]));
      check(panel()!.contains(document.activeElement), "focus fell outside panel after answering plain-text ask");
      // Second card: Clear as stale hits simulated failure -> Retry button receives focus -> Retry clears it cleanly.
      const stale2 = card2()!.querySelector<HTMLButtonElement>("[data-waiting-plain-stale]")!;
      stale2.focus();
      stale2.click();
      await wait(() => shown(card2()?.querySelector('[role="alert"]')) && shown(card2()?.querySelector("[data-waiting-plain-retry]")),
        "failed Clear as stale kept card with role=alert and Retry button");
      check(document.activeElement === card2()!.querySelector("[data-waiting-plain-retry]"),
        "focus did not move to Retry button after failed Clear as stale");
      card2()!.querySelector<HTMLButtonElement>("[data-waiting-plain-retry]")!.click();
      await wait(() => f.plainReplies.length === 2 && !card2() && panel()?.querySelector("[data-waiting-status]")?.textContent === "Cleared" && count() === "0",
        "Retry cleared stale historical ask and updated count to 0");
      check(f.plainReplies[1].command.in_reply_to === f.plainAsks[1] &&
        f.plainReplies[1].command.body === "Closed as stale. Re-ask with choices if still needed." &&
        f.plainFailedCommandId !== "" &&
        f.plainReplies[1].command_id === f.plainFailedCommandId,
        "unexpected stale close payload or command_id reuse mismatch: " + JSON.stringify({ failed: f.plainFailedCommandId, retry: f.plainReplies[1] }));
      check(panel()!.contains(document.activeElement), "focus fell outside panel after clearing last plain-text ask");
      inviteCard.remove();
      document.documentElement.dataset.waitingObservation = JSON.stringify({ ok: true, scenario: f.scenario, steps, unexpected: f.unexpected });
      return;
    }
    // 1. Workspace one's chat has no question; the ninth workspace's question is counted from here.
    await wait(() => shown(control()) && count() === "1", "the ninth workspace's question is counted");
    check(route("w") === f.ids[0] && route("v") === null, "the app is not on workspace one's chat");
    check(name() === "Waiting on you 1", "the control's name is not its words and its number");
    if (f.phone) check(!control()!.closest("dialog.cs-org-drawer"), "the phone control is inside the navigation drawer");
    else {
      check(!shown(phoneCopy()), "the phone copy is displayed on a desktop");
      check(deskCopy()!.parentElement!.lastElementChild === deskCopy(), "the header control is not the last thing in the header's actions");
    }
    // 2. In a channel view, the control opens the Waiting on you right column (desktop) or modal sheet (phone)
    //    starting in This channel without leaving Workspace 1's chat.
    control()!.click();
    const panel = () => document.querySelector<HTMLElement>("#cs-waiting-panel");
    const sheet = () => document.querySelector<HTMLDialogElement>("dialog#cs-waiting-sheet");
    const switchAll = () => panel()?.querySelector<HTMLButtonElement>('[data-waiting-switch-scope="all"]') ?? null;
    await wait(
      () => route("w") === f.ids[0] && route("v") === null && (f.phone ? !!sheet()?.open : shown(panel())) && shown(switchAll()),
      "Waiting on you opens in This channel and offers Show all workspaces",
    );
    check(control()!.getAttribute("aria-expanded") === "true", "control aria-expanded is not true when open");
    const closeBox = panel()!.querySelector<HTMLElement>("[data-waiting-close]")!.getBoundingClientRect();
    const scopeBox = panel()!.querySelector<HTMLElement>("[data-waiting-scope]")!.getBoundingClientRect();
    check(closeBox.width >= 44 && closeBox.height >= 44, "close target under 44px: " + JSON.stringify(closeBox));
    check(scopeBox.height >= 44, "scope selector under 44px: " + JSON.stringify(scopeBox));
    if (f.phone) {
      check(panel()!.parentElement === sheet(), "phone panel is not inside the modal dialog sheet");
    } else {
      check(!sheet()?.open, "desktop opened the phone modal sheet instead of the right column");
    }
    // Switching to All workspaces lists the ninth workspace's question with its choices right in the card.
    switchAll()!.click();
    const card = () => panel()?.querySelector<HTMLElement>(`[data-waiting-card="${f.ask}"]`) ?? null;
    const options = () => Array.from(card()?.querySelectorAll<HTMLButtonElement>("button[data-decision-option]") ?? []);
    await wait(() => shown(card()) && options().length === 2, "Waiting on you lists the ninth workspace's question with its choices");
    check(card()!.dataset.waitingWorkspace === f.ids[8] && card()!.textContent!.includes(f.question), "the card is not the ninth workspace's question: " + card()!.textContent);
    check(options().map(option => option.dataset.decisionOption).join() === "yes,no", "the card's choices are not the stored ones");
    check(options()[0]!.getBoundingClientRect().height >= 44, "choice option target under 44px");
    check(f.answers.length === 0, "an answer was sent before a choice was clicked");
    // 3. One choice sends one answer_choice for that ask, in the ninth workspace.
    options()[0]!.click();
    await wait(() => f.answers.length > 0, "the answer reached the command endpoint");
    const sent = f.answers[0];
    check(f.answers.length === 1 && sent.workspace_id === f.ids[8] && sent.command.kind === "answer_choice" && sent.command.signal_id === f.ask &&
      sent.command.option_id === "yes", "the answer names the wrong workspace, ask or option: " + JSON.stringify(f.answers));
    // 4. The card leaves immediately, Sent is visibly shown and announced even after the last answer, and the empty state appears.
    await wait(() => !panel()?.querySelector(`[data-waiting-card="${f.ask}"]`) &&
      shown(panel()?.querySelector("[data-waiting-status]")) &&
      panel()?.querySelector("[data-waiting-status]")?.textContent === "Sent" &&
      panel()?.querySelector(".cs-waiting-panel__state-text")?.textContent === "Nothing waiting on you.", "the answered question left the panel and showed visible Sent");
    // 5. Closing on phone returns focus to the channel header Waiting on you control.
    if (f.phone) {
      panel()!.querySelector<HTMLButtonElement>("[data-waiting-close]")!.click();
      await wait(() => !sheet()?.open && document.activeElement === control(), "closing phone sheet returned focus to header control");
    }
    // 6. The top-bar count updates to zero.
    await wait(() => shown(control()) && count() === "0", "the count reads zero after the answer");
    check(name() === "Waiting on you 0", "the control's name did not follow the count");
    check(f.answers.length === 1 && !document.querySelector(`[data-waiting-card="${f.ask}"]`), "the question came back or was answered twice");
    document.documentElement.dataset.waitingObservation = JSON.stringify({ ok: true, scenario: f.scenario, steps, unexpected: f.unexpected });
  } catch (error) {
    document.documentElement.dataset.waitingObservation = JSON.stringify({ error: String(error), scenario: f.scenario, steps, unexpected: f.unexpected });
  }
}

/** Boots the real app once per scenario at its viewport and returns each scenario's observation. */
async function runWaitingScenarios(scenarios: readonly string[]): Promise<Record<string, any>> {
  const { markup, styles, bundled } = await renderAstroFixture(new URL("./LiveDashboard.astro", import.meta.url));
  const compileFixture = (name: string) => compileFixtureFunction(new URL(import.meta.url), name);
  const peerJwt = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${Buffer.from(JSON.stringify({
    sub: "77777777-7777-4777-8777-777777777777",
    exp: Math.floor(Date.now() / 1000) + 3600,
    role: "authenticated",
  })).toString("base64url")}.${Buffer.from("synthetic-sig").toString("base64url")}`;
  const peerSwitchBundle = (await build({
    stdin: {
      contents: `import { client } from "../../lib/commonswarm";
        void client()!.auth.setSession({ access_token: ${JSON.stringify(peerJwt)}, refresh_token: "synthetic-refresh-b" });`,
      loader: "ts",
      resolveDir: dirname(fileURLToPath(new URL("./LiveDashboard.astro", import.meta.url))),
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    define: { "import.meta.env": JSON.stringify({ PUBLIC_SUPABASE_URL: "https://api.test.invalid", PUBLIC_SUPABASE_ANON_KEY: "synthetic-public" }) },
  })).outputFiles[0]!.text;
  const peerSwitchPage = `<!doctype html><html><head><meta name='commonswarm:url' content='https://api.test.invalid'><meta name='commonswarm:anon-key' content='synthetic-public'><script>
    const peerUserB = { id: "77777777-7777-4777-8777-777777777777", aud: "authenticated", role: "authenticated", email: "peer-b@example.test", app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() };
    const net = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const req = new Request(input, init), url = new URL(req.url);
      if (url.origin === location.origin) return net(input, init);
      if (url.pathname === "/auth/v1/user") return Response.json(peerUserB);
      if (url.pathname === "/auth/v1/token") return Response.json({ access_token: ${JSON.stringify(peerJwt)}, refresh_token: "synthetic-refresh-b", token_type: "bearer", expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: peerUserB });
      return Response.json({});
    };
  </script></head><body><script>${peerSwitchBundle}</script></body></html>`;
  const app = "<!doctype html><html><head><meta name='commonswarm:url' content='https://api.test.invalid'><meta name='commonswarm:anon-key' content='synthetic-public'><style>" +
    styles.join("\n") + "</style><script>" + await compileFixture("installWaitingFixture") + "</script></head><body>" + markup +
    "<script>" + await compileFixture("observeWaitingCount") + "</script></body></html>";
  const server = createServer((request, response) => {
    if (request.url === "/__observer-tick") { setTimeout(() => { response.writeHead(204); response.end(); }, 2); return; }
    if (request.url?.startsWith("/fonts/")) { response.writeHead(204); response.end(); return; }
    if (request.url === "/peer-switch") { response.writeHead(200, { "Content-Type": "text/html" }); response.end(peerSwitchPage); return; }
    response.writeHead(200, { "Content-Type": request.url === "/app.js" ? "text/javascript" : "text/html" });
    response.end(request.url === "/app.js" ? bundled.join("\n") : app);
  });
  const outcomes: Record<string, any> = {};
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address(); assert.ok(address && typeof address === "object");
    const chrome = await findChrome();
    for (const scenario of scenarios) {
      // A phone (390 x 844) draws the control in the shell's top bar; a desktop (1280 x 800) in the workspace header.
      const size = scenario.endsWith("-phone") ? "390,844" : "1280,800";
      const channelParam = scenario.startsWith("todos-21-")
        ? "&c=cccccccc-cccc-4ccc-8ccc-000000000001"
        : (scenario.startsWith("batch-51") || scenario.startsWith("batch-101") || scenario.startsWith("truncated-queue") || scenario.startsWith("todos-") || scenario.startsWith("survey-") || scenario.startsWith("historical-cleanup-") || scenario.startsWith("plain-401-") || scenario.startsWith("waiting-read-retire-"))
          ? "&c=general"
          : "";
      const { stdout } = await launchChrome(chrome, [`--window-size=${size}`, "--virtual-time-budget=120000", "--dump-dom",
        "http://127.0.0.1:" + address.port + "/app?w=aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaaa" + channelParam + "&case=" + scenario], { timeout: 60000, maxBuffer: 10 * 1024 * 1024 });
      const raw = stdout.match(/data-waiting-observation="([^"]*)"/)?.[1];
      outcomes[scenario] = raw ? JSON.parse(raw.replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&"))
        : { error: "the rendered app did not finish the observation: " + stdout.slice(0, 400) };
    }
  } finally {
    if (server.listening) { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  }
  return outcomes;
}

// Every scenario runs and is reported, so one failure never hides another's outcome.
const failures = (outcomes: Record<string, any>) => Object.entries(outcomes).filter(([, result]) => result.error !== undefined || result.ok !== true);

test("Waiting on you: a question in the ninth workspace shows in the count from a quiet channel, and the count updates after it is answered", { timeout: 180_000 }, async () => {
  const outcomes = await runWaitingScenarios(["answer-phone", "answer-desktop"]);
  assert.deepEqual(failures(outcomes), [], JSON.stringify(outcomes));
});

test("Waiting on you: an uncounted workspace makes the count a minimum, never zero", { timeout: 180_000 }, async () => {
  const outcomes = await runWaitingScenarios(["uncounted-one-phone", "uncounted-one-desktop", "uncounted-none-phone", "uncounted-none-desktop", "failed-choices-desktop"]);
  assert.deepEqual(failures(outcomes), [], JSON.stringify(outcomes));
});

test("Waiting on you: pages past 50 and 100 choice asks and keeps unpaged truncated queues incomplete", { timeout: 180_000 }, async () => {
  const outcomes = await runWaitingScenarios(["batch-51-desktop", "batch-101-desktop", "truncated-queue-desktop"]);
  assert.deepEqual(failures(outcomes), [], JSON.stringify(outcomes));
});

test("Waiting on you: assigned to-dos paginate past 20, scope to channel-origin vs workspace-only, and keep keyboard focus on failure and completion", { timeout: 180_000 }, async () => {
  const outcomes = await runWaitingScenarios(["todos-desktop", "todos-phone", "todos-21-channels-desktop", "todos-truncated-desktop"]);
  assert.deepEqual(failures(outcomes), [], JSON.stringify(outcomes));
});

test("Waiting on you: multi-question survey keeps drafts across Back/Skip/close, sends only filled-in answers, keeps failed answers editable and skipped open", { timeout: 180_000 }, async () => {
  const outcomes = await runWaitingScenarios(["survey-desktop", "survey-phone"]);
  assert.deepEqual(failures(outcomes), [], JSON.stringify(outcomes));
});
test("Waiting on you: Check F historical plain-text asks answer inline or clear as stale with Retry focus and desktop corner invite clearance", { timeout: 180_000 }, async () => {
  const outcomes = await runWaitingScenarios(["historical-cleanup-desktop"]);
  assert.deepEqual(failures(outcomes), [], JSON.stringify(outcomes));
});

test("Waiting on you: retires survey batch, background reads, and historical 401 retry immediately when login changes, while preserving unchanged-login token refresh", { timeout: 180_000 }, async () => {
  const outcomes = await runWaitingScenarios(["survey-auth-retire-desktop", "waiting-read-retire-desktop", "plain-401-retire-desktop", "plain-401-refresh-control-desktop"]);
  assert.deepEqual(failures(outcomes), [], JSON.stringify(outcomes));
});
