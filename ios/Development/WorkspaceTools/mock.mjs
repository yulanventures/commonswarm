// Lane 2 simulator fixture for Workspace Tools (To-dos). Synthetic loopback state only.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const verify = process.argv[2] === "--verify";
const requestedPort = verify ? 0 : Number(process.env.WORKSPACE_TOOLS_FIXTURE_PORT || 8765);
const localSeat = "seat_0000000000000000000000";
let origin;

const me = "00000000-0000-4000-8000-000000000001";
const maya = "00000000-0000-4000-8000-000000000011";
const alex = "00000000-0000-4000-8000-000000000012";
const atlas = "00000000-0000-4000-8000-000000000002";
const workspace = "00000000-0000-4000-8000-000000000003";
const channel = "00000000-0000-4000-8000-000000000004";

const todos = [
  {
    workspace_id: workspace,
    todo_id: "10000000-0000-4000-8000-000000000001",
    version: 3,
    title: "Finalize Q4 mobile release checklist and confirm production sign-in flow with security and design",
    notes: "Verify email code sign-in, silent session restore after upgrade, and light/dark contrast on both iPhone SE and large iPhone screens before shipping.",
    state: "doing",
    due_on: "2026-11-24",
    created_by: { user_id: me, principal_id: null },
    created_at: "2026-11-18T16:20:00.000Z",
    assignee: { kind: "user", id: maya },
    assigned_by: { user_id: me, principal_id: null },
    assigned_at: "2026-11-18T16:25:00.000Z",
    offer: null,
    gate: { kind: "none" },
    gate_clear: true,
    queue_position: null,
    state_by: { user_id: maya, principal_id: null },
    state_at: "2026-11-19T14:10:00.000Z",
    comment_count: 2,
    comments: [
      {
        comment_id: "20000000-0000-4000-8000-000000000001",
        target: { kind: "todo", id: "10000000-0000-4000-8000-000000000001" },
        author: { user_id: maya, principal_id: null },
        body: "Started walking through the release checklist on the test phone.",
        mentions: [],
        created_at: "2026-11-19T14:15:00.000Z",
      },
      {
        comment_id: "20000000-0000-4000-8000-000000000002",
        target: { kind: "todo", id: "10000000-0000-4000-8000-000000000001" },
        author: { user_id: me, principal_id: atlas },
        body: "Automated contract checks are green against the workspace service.",
        mentions: [],
        created_at: "2026-11-19T15:00:00.000Z",
      },
    ],
  },
  {
    workspace_id: workspace,
    todo_id: "10000000-0000-4000-8000-000000000002",
    version: 2,
    title: "Verify attachment download links expire cleanly",
    notes: "Confirm fresh download URLs are requested on open and expired links prompt a retry.",
    state: "open",
    due_on: "2026-11-26",
    created_by: { user_id: maya, principal_id: null },
    created_at: "2026-11-18T18:00:00.000Z",
    assignee: { kind: "agent", id: atlas },
    assigned_by: { user_id: me, principal_id: null },
    assigned_at: "2026-11-18T18:05:00.000Z",
    offer: null,
    gate: { kind: "none" },
    gate_clear: true,
    queue_position: 1,
    state_by: { user_id: maya, principal_id: null },
    state_at: "2026-11-18T18:00:00.000Z",
    comment_count: 0,
    comments: [],
  },
  {
    workspace_id: workspace,
    todo_id: "10000000-0000-4000-8000-000000000003",
    version: 1,
    title: "Draft onboarding copy for new workspace members",
    notes: "",
    state: "open",
    due_on: null,
    created_by: { user_id: alex, principal_id: null },
    created_at: "2026-11-18T12:00:00.000Z",
    assignee: null,
    assigned_by: null,
    assigned_at: null,
    offer: null,
    gate: { kind: "none" },
    gate_clear: true,
    queue_position: null,
    state_by: { user_id: alex, principal_id: null },
    state_at: "2026-11-18T12:00:00.000Z",
    comment_count: 0,
    comments: [],
  },
  {
    workspace_id: workspace,
    todo_id: "10000000-0000-4000-8000-000000000004",
    version: 4,
    title: "Audit dark mode contrast across workspace list",
    notes: "Checked against WCAG 2.2 AA targets.",
    state: "done",
    due_on: "2026-11-18",
    created_by: { user_id: me, principal_id: null },
    created_at: "2026-11-17T09:00:00.000Z",
    assignee: { kind: "user", id: me },
    assigned_by: { user_id: me, principal_id: null },
    assigned_at: "2026-11-17T09:00:00.000Z",
    offer: null,
    gate: { kind: "none" },
    gate_clear: true,
    queue_position: null,
    state_by: { user_id: me, principal_id: null },
    state_at: "2026-11-18T17:30:00.000Z",
    comment_count: 0,
    comments: [],
  },
  {
    workspace_id: workspace,
    todo_id: "10000000-0000-4000-8000-000000000005",
    version: 2,
    title: "Archive legacy preview route after migration",
    notes: "Superseded by the unified workspace navigation.",
    state: "dropped",
    due_on: null,
    created_by: { user_id: alex, principal_id: null },
    created_at: "2026-11-16T11:00:00.000Z",
    assignee: { kind: "user", id: alex },
    assigned_by: { user_id: alex, principal_id: null },
    assigned_at: "2026-11-16T11:00:00.000Z",
    offer: null,
    gate: { kind: "none" },
    gate_clear: true,
    queue_position: null,
    state_by: { user_id: alex, principal_id: null },
    state_at: "2026-11-17T15:00:00.000Z",
    comment_count: 0,
    comments: [],
  },
];

function summarize(todo) {
  return {
    todo_id: todo.todo_id,
    version: todo.version,
    title: todo.title,
    state: todo.state,
    due_on: todo.due_on,
    assignee: todo.assignee,
    offer: todo.offer,
    gate: {
      kind: todo.gate.kind,
      clear: todo.gate_clear,
      todo_id: todo.gate.todo_id ?? null,
      at: todo.gate.at ?? null,
    },
    queue_position: todo.queue_position,
    comment_count: todo.comment_count,
    state_at: todo.state_at,
  };
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
    if (req.headers.apikey !== "local-fixture") return reply(401, {});

    let body;
    if (req.method === "POST") {
      let data = "";
      for await (const chunk of req) {
        data += chunk;
        if (data.length > 65_536) return reply(413, {});
      }
      body = JSON.parse(data);
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

    if (req.method === "POST" && url.pathname === "/functions/v1/command") {
      if (body.workspace_id?.toLowerCase() !== workspace) {
        return reply(200, { status: "refused", reason: "workspace_access_refused" });
      }
      const cmd = body.command;
      if (cmd?.kind === "household_tool") {
        if (cmd.arguments?.seat !== localSeat) {
          return reply(200, { status: "refused", reason: "seat_binding_mismatch" });
        }
        if (cmd.tool === "todo_list") {
          const scope = cmd.arguments?.scope === "all" ? "all" : "open";
          const offset = Math.max(0, Number(cmd.arguments?.offset ?? 0));
          const limit = Math.min(50, Math.max(1, Number(cmd.arguments?.limit ?? 50)));
          const filtered = todos
            .filter((t) => scope === "all" || t.state === "open" || t.state === "doing")
            .map(summarize);
          const slice = filtered.slice(offset, offset + limit);
          const nextOffset = offset + slice.length < filtered.length ? offset + slice.length : null;
          return reply(200, { status: "ok", todos: slice, next_offset: nextOffset });
        }
        if (cmd.tool === "todo_read") {
          const todoID = String(cmd.arguments?.todo_id ?? "").toLowerCase();
          const match = todos.find((t) => t.todo_id === todoID);
          if (!match) return reply(200, { status: "refused", reason: "todo_not_found" });
          const { comments, ...detail } = match;
          const offset = Math.max(0, Number(cmd.arguments?.comment_offset ?? 0));
          const slice = comments.slice(offset, offset + 20);
          const next = offset + slice.length < comments.length ? offset + slice.length : null;
          return reply(200, { status: "ok", todo: detail, comments: slice, next_comment_offset: next });
        }
      }
      return reply(400, { status: "refused", reason: "invalid_request" });
    }

    if (req.method !== "GET" || req.headers["accept-profile"] !== "swarm_read") return reply(400, {});
    if (url.pathname === "/rest/v1/workspaces") {
      return reply(200, [{ workspace_id: workspace, name: "Simulator workspace" }]);
    }
    if (url.searchParams.get("workspace_id")?.toLowerCase() !== `eq.${workspace}`) {
      return reply(403, {});
    }
    switch (url.pathname) {
      case "/rest/v1/channels":
        return reply(200, [{ channel_id: channel, slug: "mobile", visibility: "open" }]);
      case "/rest/v1/member_profiles":
        return reply(200, [
          { user_id: me, display_name: "You" },
          { user_id: maya, display_name: "Maya Chen" },
          { user_id: alex, display_name: "Alex Rivera" },
        ]);
      case "/rest/v1/agent_principals":
        return reply(200, [{ principal_id: atlas, name: "Atlas" }]);
      case "/rest/v1/signals":
        return reply(200, []);
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
    console.log(`WorkspaceTools fixture listening on loopback port ${actualPort}`);
    return;
  }
  const child = spawn(process.argv[3], [String(actualPort), ...process.argv.slice(4)], { stdio: "inherit" });
  child.once("error", () => { process.exitCode = 1; server.close(); });
  child.once("exit", (status) => {
    process.exitCode = status ?? 1;
    server.close();
  });
});
