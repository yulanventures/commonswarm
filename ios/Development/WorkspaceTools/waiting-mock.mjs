// Loopback simulator fixture for iPhone Waiting on you (PR 1 asks + PR 2 assigned & waiting to-dos).
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const verify = process.argv[2] === "--verify";
const requestedPort = verify ? 0 : Number(process.env.WAITING_FIXTURE_PORT || 8765);
let origin;

const me = "00000000-0000-4000-8000-000000000001";
const atlas = "00000000-0000-4000-8000-000000000002";
const maya = "00000000-0000-4000-8000-000000000011";
const wsMain = "00000000-0000-4000-8000-000000000003";
const wsSecond = "00000000-0000-4000-8000-000000000005";
const chMobile = "00000000-0000-4000-8000-000000000004";
const chRelease = "00000000-0000-4000-8000-000000000006";

const sigGeneralChoice = "30000000-0000-4000-8000-000000000001";
const sigMobileChoice = "30000000-0000-4000-8000-000000000002";
const sigDmChoice = "30000000-0000-4000-8000-000000000003";
const sigSecondWsChoice = "30000000-0000-4000-8000-000000000004";

const todoGeneralAssigned = "50000000-0000-4000-8000-000000000001";
const todoMobileRequest = "50000000-0000-4000-8000-000000000002";
const todoWorkspaceAssigned = "50000000-0000-4000-8000-000000000003";
const todoSecondWsHold = "50000000-0000-4000-8000-000000000004";

const workspaces = [
  { workspace_id: wsMain, name: "Simulator workspace" },
  { workspace_id: wsSecond, name: "Second workspace" },
];

const channelsByWorkspace = new Map([
  [wsMain, [
    { channel_id: chMobile, slug: "mobile", visibility: "open" },
    { channel_id: chRelease, slug: "release", visibility: "open" },
  ]],
  [wsSecond, []],
]);

const answered = new Map();
const receivedCommands = [];
const receivedTodoCommands = [];
let failNextOnce = false;
let failNextTodoOnce = false;
let conflictNextTodoOnce = false;
let hideWaitingTodosRpc = false;
let forceTodosPageSize = null;
let omitLocationSignalIds = new Set();
let failDecisionQueueWs = null;

const asksByWorkspace = new Map([
  [wsMain, [
    {
      signal_id: sigGeneralChoice,
      from: { kind: "agent", id: atlas, name: "Atlas" },
      body: "The TestFlight build passed smoke checks.\n\nShould we publish build 14 to internal testers now?",
      created_at: "2026-11-19T14:00:00.000Z",
      until: "2026-11-20T14:00:00.000Z",
      placement: { id: sigGeneralChoice, channel_id: null, to: null, to_agent: null, thread_root_id: null, from: atlas, from_kind: "agent" },
      multi: false,
      options: [
        { id: "hold", label: "Hold for Friday", description: "Wait for the design review first" },
        { id: "ship", label: "Publish now", description: "Send build 14 to testers immediately", recommended: true },
        { id: "canary", label: "Owner phone only", description: "Install on one device first" },
      ],
    },
    {
      signal_id: sigMobileChoice,
      from: { kind: "user", id: maya, name: "Maya Chen" },
      body: "Which screens should we audit first on iPhone SE?",
      created_at: "2026-11-19T14:30:00.000Z",
      until: "2026-11-20T14:30:00.000Z",
      placement: { id: sigMobileChoice, channel_id: chMobile, to: null, to_agent: null, thread_root_id: null, from: maya, from_kind: "user" },
      multi: true,
      options: [
        { id: "todos", label: "To-dos list and detail", recommended: true },
        { id: "waiting", label: "Waiting on you sheet" },
        { id: "composer", label: "Message composer" },
      ],
    },
    {
      signal_id: sigDmChoice,
      from: { kind: "agent", id: atlas, name: "Atlas" },
      body: "Direct check: should I retry the failed upload job?",
      created_at: "2026-11-19T14:45:00.000Z",
      until: "2026-11-20T14:45:00.000Z",
      placement: { id: sigDmChoice, channel_id: null, to: me, to_agent: null, thread_root_id: null, from: atlas, from_kind: "agent" },
      multi: false,
      options: [
        { id: "retry", label: "Retry now", recommended: true },
        { id: "skip", label: "Skip for today" },
      ],
    },
  ]],
  [wsSecond, [
    {
      signal_id: sigSecondWsChoice,
      from: { kind: "agent", id: atlas, name: "Atlas" },
      body: "Ready to rotate staging credentials for Second workspace?",
      created_at: "2026-11-19T15:00:00.000Z",
      until: "2026-11-20T15:00:00.000Z",
      placement: { id: sigSecondWsChoice, channel_id: null, to: null, to_agent: null, thread_root_id: null, from: atlas, from_kind: "agent" },
      multi: false,
      options: [
        { id: "rotate", label: "Rotate now", recommended: true },
        { id: "wait", label: "Wait until Monday" },
      ],
    },
  ]],
]);

const todosByWorkspace = new Map([
  [wsMain, [
    {
      todo_id: todoGeneralAssigned,
      title: "Approve App Store release notes for iOS 1.0",
      state: "doing",
      version: 3,
      due_on: "2026-11-24",
      reason: "assigned",
      agent_id: null,
      state_at: "2026-11-19T15:20:00.000Z",
      placement: "general",
      channel_id: null,
      assignee: { kind: "user", id: me },
      notes: "Verify screenshots, privacy labels, and TestFlight release summary before submission.",
      comments: [
        {
          comment_id: "60000000-0000-4000-8000-000000000001",
          author: { kind: "user", id: maya },
          body: "Drafted the final bullet points for dark mode and Waiting on you.",
          created_at: "2026-11-19T13:10:00.000Z",
        },
        {
          comment_id: "60000000-0000-4000-8000-000000000002",
          author: { kind: "agent", id: atlas },
          body: "All release checks passed on iPhone SE and iPhone 17 Pro.",
          created_at: "2026-11-19T14:05:00.000Z",
        },
      ],
    },
    {
      todo_id: todoMobileRequest,
      title: "Review dark mode token audit for iPhone SE",
      state: "open",
      version: 2,
      due_on: "2026-11-26",
      reason: "request",
      agent_id: atlas,
      state_at: "2026-11-19T15:10:00.000Z",
      placement: "channel",
      channel_id: chMobile,
      assignee: { kind: "agent", id: atlas },
      notes: "Confirm all small badges reach 4.5:1 contrast in both light and dark appearance.",
      comments: [
        {
          comment_id: "60000000-0000-4000-8000-000000000003",
          author: { kind: "agent", id: atlas },
          body: "Ready for review once the contrast update lands.",
          created_at: "2026-11-19T14:20:00.000Z",
        },
      ],
    },
    {
      todo_id: todoWorkspaceAssigned,
      title: "Confirm production backup retention policy",
      state: "open",
      version: 1,
      due_on: null,
      reason: "assigned",
      agent_id: null,
      state_at: "2026-11-19T15:00:00.000Z",
      placement: "workspace",
      channel_id: null,
      assignee: { kind: "user", id: me },
      notes: "Double-check nightly snapshot retention on the primary cluster.",
      comments: [],
    },
  ]],
  [wsSecond, [
    {
      todo_id: todoSecondWsHold,
      title: "Unpause nightly staging sync job",
      state: "open",
      version: 1,
      due_on: "2026-12-01",
      reason: "hold",
      agent_id: atlas,
      state_at: "2026-11-19T14:55:00.000Z",
      placement: "workspace",
      channel_id: null,
      assignee: { kind: "agent", id: atlas },
      notes: "Paused while rotating staging credentials.",
      comments: [],
    },
  ]],
]);

function findTodo(wsId, todoId) {
  const list = todosByWorkspace.get(wsId) ?? [];
  return list.find((t) => t.todo_id === todoId) ?? null;
}

let emailCodePending = false;
const sessions = new Set();
const refreshTokens = new Set();

const server = createServer(async (req, res) => {
  const reply = (status, value) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(value));
  };
  try {
    const url = new URL(req.url, origin);
    if (req.headers.host !== new URL(origin).host) return reply(400, {});

    if (req.method === "POST" && url.pathname === "/fixture/fail-next") {
      failNextOnce = true;
      return reply(200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/fixture/fail-next-todo") {
      failNextTodoOnce = true;
      return reply(200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/fixture/conflict-next-todo") {
      conflictNextTodoOnce = true;
      return reply(200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/fixture/hide-waiting-todos-rpc") {
      hideWaitingTodosRpc = true;
      return reply(200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/fixture/show-waiting-todos-rpc") {
      hideWaitingTodosRpc = false;
      return reply(200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/fixture/todos-page-size") {
      forceTodosPageSize = Number(url.searchParams.get("n") || "1");
      return reply(200, { ok: true, pageSize: forceTodosPageSize });
    }
    if (req.method === "POST" && url.pathname === "/fixture/omit-location") {
      const id = (url.searchParams.get("id") || sigGeneralChoice).toLowerCase();
      omitLocationSignalIds.add(id);
      return reply(200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/fixture/restore-locations") {
      omitLocationSignalIds = new Set();
      return reply(200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/fixture/fail-decision-queue") {
      failDecisionQueueWs = url.searchParams.get("ws")?.toLowerCase() || null;
      return reply(200, { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/fixture/commands") {
      return reply(200, receivedCommands);
    }
    if (req.method === "GET" && url.pathname === "/fixture/todo-commands") {
      return reply(200, receivedTodoCommands);
    }

    if (req.headers.apikey !== "local-fixture") return reply(401, {});

    let body;
    if (req.method === "POST") {
      let data = "";
      for await (const chunk of req) {
        data += chunk;
        if (data.length > 65_536) return reply(413, {});
      }
      body = data ? JSON.parse(data) : {};
    }

    const issueSession = () => {
      const access = randomBytes(32).toString("hex");
      const refresh = randomBytes(32).toString("hex");
      sessions.add(access);
      refreshTokens.add(refresh);
      return reply(200, { access_token: access, refresh_token: refresh, expires_in: 3600, user: { id: me } });
    };

    if (req.method === "POST" && url.pathname === "/auth/v1/otp") {
      if (body.create_user !== false || url.search) return reply(400, {});
      if (body.email !== "reader@example.test") return reply(422, { code: 422, error_code: "otp_disabled" });
      emailCodePending = true;
      return reply(200, {});
    }
    if (req.method === "POST" && url.pathname === "/auth/v1/verify") {
      if (!emailCodePending || body.email !== "reader@example.test" || body.token !== "012345" || body.type !== "email") {
        return reply(403, {});
      }
      emailCodePending = false;
      return issueSession();
    }
    if (req.method === "POST" && url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "refresh_token") {
      if (!refreshTokens.has(body.refresh_token)) return reply(400, { error_code: "refresh_token_not_found" });
      refreshTokens.delete(body.refresh_token);
      return issueSession();
    }

    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (!sessions.has(token)) return reply(401, {});

    if (req.method === "POST" && url.pathname === "/functions/v1/read") {
      const reqWs = workspaces.find((w) => w.workspace_id === String(body.workspace_id ?? "").toLowerCase()) ?? workspaces[0];
      const baseMembers = [
        { kind: "user", id: me, name: "You", left_at: null },
        { kind: "user", id: maya, name: "Maya Chen", left_at: null },
        { kind: "agent", id: atlas, name: "Atlas", left_at: null },
      ];
      const convGeneral = {
        conversation_id: "40000000-0000-4000-8000-000000000001",
        kind: "general",
        channel_id: null,
        slug: null,
        description: null,
        archived_at: null,
        joined: true,
        members: baseMembers,
        last_message_at: "2026-11-19T14:00:00.000Z",
        notify_level: "all",
        mention_count: 0,
        unread_count: 0,
      };
      const convMobile = {
        conversation_id: "40000000-0000-4000-8000-000000000002",
        kind: "public_channel",
        channel_id: chMobile,
        slug: "mobile",
        description: "Mobile client engineering",
        archived_at: null,
        joined: true,
        members: baseMembers,
        last_message_at: "2026-11-19T14:30:00.000Z",
        notify_level: "all",
        mention_count: 0,
        unread_count: 0,
      };
      const convDmAtlas = {
        conversation_id: "40000000-0000-4000-8000-000000000003",
        kind: "dm",
        channel_id: null,
        slug: null,
        description: null,
        archived_at: null,
        joined: true,
        members: [
          { kind: "user", id: me, name: "You", left_at: null },
          { kind: "agent", id: atlas, name: "Atlas", left_at: null },
        ],
        last_message_at: "2026-11-19T14:45:00.000Z",
        notify_level: "all",
        mention_count: 0,
        unread_count: 0,
      };
      const convGroupA = {
        conversation_id: "40000000-0000-4000-8000-000000000004",
        kind: "group_dm",
        channel_id: null,
        slug: null,
        description: null,
        archived_at: null,
        joined: true,
        members: baseMembers,
        last_message_at: "2026-11-19T14:50:00.000Z",
        notify_level: "all",
        mention_count: 0,
        unread_count: 0,
      };
      const convGroupB = {
        conversation_id: "40000000-0000-4000-8000-000000000005",
        kind: "group_dm",
        channel_id: null,
        slug: null,
        description: null,
        archived_at: null,
        joined: true,
        members: baseMembers,
        last_message_at: "2026-11-19T14:55:00.000Z",
        notify_level: "all",
        mention_count: 0,
        unread_count: 0,
      };
      const allConvs = reqWs.workspace_id === wsMain
        ? [convGeneral, convMobile, convDmAtlas, convGroupA, convGroupB]
        : [convGeneral];
      if (body.resource === "conversations") {
        return reply(200, { conversations: allConvs });
      }
      if (body.resource === "conversation_history") {
        const found = allConvs.find((c) => c.conversation_id === body.conversation_id) ?? convGeneral;
        return reply(200, {
          conversation: found,
          messages: [
            {
              id: sigGeneralChoice,
              from: atlas,
              from_kind: "agent",
              body: "The TestFlight build passed smoke checks.\n\nShould we publish build 14 to internal testers now?",
              created_at: "2026-11-19T14:00:00.000Z",
            },
          ],
        });
      }
      return reply(400, { error: "invalid_request" });
    }

    if (req.method === "POST" && url.pathname === "/functions/v1/command") {
      const cmd = body.command;
      if (cmd?.kind === "answer_choice") {
        receivedCommands.push({ command_id: body.command_id, workspace_id: body.workspace_id, command: cmd });
        if (failNextOnce) {
          failNextOnce = false;
          return reply(503, { error: "unavailable", message: "Service temporarily busy." });
        }
        const optionIds = Array.isArray(cmd.option_ids) ? cmd.option_ids : (cmd.option_id ? [cmd.option_id] : []);
        const otherText = typeof cmd.other_text === "string" ? cmd.other_text : null;
        answered.set(String(cmd.signal_id).toLowerCase(), {
          option_id: optionIds[0] ?? "other",
          option_ids: optionIds,
          other_text: otherText,
          by_viewer: true,
          actor_user_id: me,
          at: new Date().toISOString(),
        });
        return reply(200, {
          status: "accepted",
          choice_answer: {
            option_id: optionIds[0] ?? "other",
            option_ids: optionIds,
            other_text: otherText,
          },
        });
      }
      if (cmd?.kind === "household_tool") {
        const wsId = String(body.workspace_id ?? "").toLowerCase();
        const args = cmd.arguments ?? {};
        if (args.seat !== "seat_0000000000000000000000") {
          return reply(400, { status: "refused", reason: "invalid_seat" });
        }
        if (cmd.tool === "todo_read") {
          const todo = findTodo(wsId, String(args.todo_id ?? "").toLowerCase());
          if (!todo) return reply(200, { status: "refused", reason: "todo_not_found" });
          return reply(200, {
            status: "ok",
            todo: {
              todo_id: todo.todo_id,
              title: todo.title,
              state: todo.state,
              version: todo.version,
              notes: todo.notes,
              due_on: todo.due_on,
              assignee: todo.assignee,
            },
            comments: todo.comments,
          });
        }
        if (cmd.tool === "todo_set_state") {
          receivedTodoCommands.push({ command_id: body.command_id, workspace_id: wsId, tool: cmd.tool, arguments: args });
          if (failNextTodoOnce) {
            failNextTodoOnce = false;
            return reply(503, { error: "unavailable" });
          }
          const todo = findTodo(wsId, String(args.todo_id ?? "").toLowerCase());
          if (!todo) return reply(200, { status: "refused", reason: "todo_not_found" });
          if (conflictNextTodoOnce) {
            conflictNextTodoOnce = false;
            todo.version += 1;
            return reply(409, {
              status: "conflict",
              current: {
                todo_id: todo.todo_id,
                title: todo.title,
                state: todo.state,
                version: todo.version,
                notes: todo.notes,
                due_on: todo.due_on,
                assignee: todo.assignee,
              },
            });
          }
          if (args.base_version !== todo.version) {
            return reply(409, {
              status: "conflict",
              current: {
                todo_id: todo.todo_id,
                title: todo.title,
                state: todo.state,
                version: todo.version,
                notes: todo.notes,
                due_on: todo.due_on,
                assignee: todo.assignee,
              },
            });
          }
          todo.state = args.state;
          todo.version += 1;
          return reply(200, {
            status: "committed",
            value: {
              todo_id: todo.todo_id,
              title: todo.title,
              state: todo.state,
              version: todo.version,
              notes: todo.notes,
              due_on: todo.due_on,
              assignee: todo.assignee,
            },
            notices: [],
          });
        }
      }
      return reply(400, { error: "invalid_request" });
    }

    if (req.method === "POST" && url.pathname === "/rest/v1/rpc/decision_queue") {
      const wsId = String(body.p_workspace_id ?? "").toLowerCase();
      if (failDecisionQueueWs && wsId === failDecisionQueueWs) {
        return reply(503, { message: "decision_queue unavailable" });
      }
      const all = (asksByWorkspace.get(wsId) ?? []).filter((a) => !answered.has(a.signal_id));
      return reply(200, {
        workspace_id: wsId,
        generated_at: new Date().toISOString(),
        total: all.length,
        truncated: false,
        asks: all.map(({ placement, multi, options, ...ask }) => ask),
      });
    }

    if (req.method === "POST" && url.pathname === "/rest/v1/rpc/waiting_todos_page") {
      if (hideWaitingTodosRpc) {
        return reply(404, { code: "PGRST202", message: "Could not find the function swarm_read.waiting_todos_page" });
      }
      const wsId = String(body.p_workspace_id ?? "").toLowerCase();
      const active = (todosByWorkspace.get(wsId) ?? [])
        .filter((t) => t.state === "open" || t.state === "doing")
        .sort((a, b) => {
          if (a.state_at !== b.state_at) return b.state_at.localeCompare(a.state_at);
          return a.todo_id.localeCompare(b.todo_id);
        });
      let filtered = active;
      if (body.p_after_state_at && body.p_after_todo_id) {
        const afterAt = String(body.p_after_state_at);
        const afterId = String(body.p_after_todo_id).toLowerCase();
        filtered = active.filter((t) => t.state_at < afterAt || (t.state_at === afterAt && t.todo_id > afterId));
      }
      const limit = forceTodosPageSize ?? Math.max(1, Math.min(Number(body.p_limit || 50), 100));
      const slice = filtered.slice(0, limit);
      return reply(200, {
        workspace_id: wsId,
        generated_at: new Date().toISOString(),
        total: active.length,
        truncated: filtered.length > limit,
        todos: slice.map((t) => ({
          todo_id: t.todo_id,
          title: t.title,
          state: t.state,
          due_on: t.due_on,
          reason: t.reason,
          agent_id: t.agent_id,
          state_at: t.state_at,
          placement: t.placement,
          channel_id: t.channel_id,
        })),
      });
    }

    if (req.method === "POST" && url.pathname === "/rest/v1/rpc/home_overview") {
      const now = new Date().toISOString();
      const rows = workspaces.map((w) => {
        const active = (todosByWorkspace.get(w.workspace_id) ?? []).filter((t) => t.state === "open" || t.state === "doing");
        const assigned = active
          .filter((t) => t.reason === "assigned" || t.reason === "request")
          .map((t) => ({ todo_id: t.todo_id, title: t.title, state: t.state, due_on: t.due_on }));
        const waiting = active
          .filter((t) => t.reason !== "assigned")
          .map((t) => ({ todo_id: t.todo_id, title: t.title, state: t.state, due_on: t.due_on, reason: t.reason, agent_id: t.agent_id }));
        return {
          workspace_id: w.workspace_id,
          needs_you: { assigned, waiting },
        };
      });
      return reply(200, { generated_at: now, workspaces: rows });
    }

    if (req.method === "POST" && url.pathname === "/rest/v1/rpc/ask_choices") {
      const wsId = String(body.p_workspace_id ?? "").toLowerCase();
      const wanted = new Set((body.p_signal_ids ?? []).map((s) => String(s).toLowerCase()));
      const list = (asksByWorkspace.get(wsId) ?? [])
        .filter((a) => wanted.has(a.signal_id))
        .map((a) => ({
          signal_id: a.signal_id,
          multi: a.multi,
          options: a.options,
          answer: answered.get(a.signal_id) ?? null,
        }));
      return reply(200, { asks: list });
    }

    if (req.method !== "GET" || req.headers["accept-profile"] !== "swarm_read") return reply(400, {});
    if (url.pathname === "/rest/v1/workspaces") return reply(200, workspaces);

    const wsParam = url.searchParams.get("workspace_id")?.toLowerCase();
    const ws = workspaces.find((w) => `eq.${w.workspace_id}` === wsParam);
    if (!ws) return reply(403, {});

    switch (url.pathname) {
      case "/rest/v1/channels":
        return reply(200, channelsByWorkspace.get(ws.workspace_id) ?? []);
      case "/rest/v1/member_profiles":
        return reply(200, [
          { user_id: me, display_name: "You" },
          { user_id: maya, display_name: "Maya Chen" },
        ]);
      case "/rest/v1/agent_principals":
        return reply(200, [{ principal_id: atlas, name: "Atlas" }]);
      case "/rest/v1/signals": {
        const idFilter = url.searchParams.get("id");
        if (idFilter?.startsWith("in.(") && idFilter.endsWith(")")) {
          const wanted = new Set(idFilter.slice(4, -1).split(",").map((s) => s.toLowerCase()));
          const rows = (asksByWorkspace.get(ws.workspace_id) ?? [])
            .filter((a) => wanted.has(a.signal_id) && !omitLocationSignalIds.has(a.signal_id))
            .map((a) => a.placement);
          return reply(200, rows);
        }
        return reply(200, [
          {
            id: sigGeneralChoice,
            from: atlas,
            from_kind: "agent",
            body: "The TestFlight build passed smoke checks.\n\nShould we publish build 14 to internal testers now?",
            created_at: "2026-11-19T14:00:00.000Z",
          },
        ]);
      }
      default:
        return reply(404, {});
    }
  } catch {
    return reply(400, {});
  }
});

server.listen(requestedPort, "127.0.0.1", () => {
  const actualPort = server.address().port;
  origin = `http://127.0.0.1:${actualPort}`;
  if (!verify) {
    console.log(`WaitingOnYou fixture listening on loopback port ${actualPort}`);
    return;
  }
  const child = spawn(process.argv[3], [String(actualPort), ...process.argv.slice(4)], { stdio: "inherit" });
  child.once("error", () => { process.exitCode = 1; server.close(); });
  child.once("exit", (status) => {
    process.exitCode = status ?? 1;
    server.close();
  });
});
