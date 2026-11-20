// Loopback verification fixture for iPhone To-dos actions (Rank 6 PR 2).
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";

const verify = process.argv[2] === "--verify";
const requestedPort = verify ? 0 : Number(process.env.TODO_ACTIONS_PORT || 8765);
let origin;

const me = "00000000-0000-4000-8000-000000000001";
const atlas = "00000000-0000-4000-8000-000000000002";
const maya = "00000000-0000-4000-8000-000000000011";
const otherUser = "00000000-0000-4000-8000-000000000012";
const wsMain = "00000000-0000-4000-8000-000000000003";
const seat = "seat_0000000000000000000000";

const workspaces = [{ workspace_id: wsMain, name: "Simulator workspace" }];

const todo1ID = "10000000-0000-4000-8000-000000000001";
const offer1ID = "20000000-0000-4000-8000-000000000001";

const todos = new Map();
const commentsByTodo = new Map();
const receipts = new Map();
const recordedCommands = [];
const mutationsByKind = {};
let totalMutations = 0;

const recordMutation = (kind) => {
  totalMutations += 1;
  mutationsByKind[kind] = (mutationsByKind[kind] ?? 0) + 1;
};

const deepClone = (v) => JSON.parse(JSON.stringify(v));

// Real production stored write shape (src/protocol/household-todos.ts):
// gate_clear and queue_position are derived on reads ONLY and MUST NOT appear in write receipts.
const toStoredTodo = (t) => ({
  workspace_id: t.workspace_id,
  todo_id: t.todo_id,
  version: t.version,
  title: t.title,
  notes: t.notes,
  state: t.state,
  due_on: t.due_on,
  created_by: deepClone(t.created_by),
  created_at: t.created_at,
  assignee: deepClone(t.assignee),
  assigned_by: deepClone(t.assigned_by),
  assigned_at: t.assigned_at,
  offer: deepClone(t.offer),
  gate: deepClone(t.gate),
  state_by: deepClone(t.state_by),
  state_at: t.state_at,
  comment_count: (commentsByTodo.get(t.todo_id) ?? []).length,
});

const toReadTodo = (t) => ({
  ...toStoredTodo(t),
  gate_clear: t.gate_clear ?? true,
  queue_position: t.queue_position ?? null,
});

const toSummary = (t) => ({
  todo_id: t.todo_id,
  version: t.version,
  title: t.title,
  state: t.state,
  due_on: t.due_on,
  assignee: deepClone(t.assignee),
  offer: deepClone(t.offer),
  gate: t.gate ? { kind: t.gate.kind, clear: t.gate_clear, todo_id: t.gate.todo_id ?? null, at: t.gate.at ?? null } : null,
  queue_position: t.queue_position,
  comment_count: (commentsByTodo.get(t.todo_id) ?? []).length,
  state_at: t.state_at,
});

const seed = () => {
  todos.clear();
  commentsByTodo.clear();
  todos.set(todo1ID, {
    workspace_id: wsMain,
    todo_id: todo1ID,
    version: 1,
    title: "Confirm kitchen tile order",
    notes: "Verify matte finish before Friday.",
    state: "open",
    due_on: "2026-11-24",
    created_by: { user_id: maya, principal_id: null },
    created_at: "2026-11-19T10:00:00.000Z",
    assignee: { kind: "user", id: me },
    assigned_by: { user_id: maya, principal_id: null },
    assigned_at: "2026-11-19T10:05:00.000Z",
    offer: {
      offer_id: offer1ID,
      to: { kind: "agent", id: atlas },
      decider_user_id: me,
      by: { user_id: maya, principal_id: null },
      at: "2026-11-19T10:10:00.000Z",
      start: "now",
    },
    gate: null,
    gate_clear: true,
    queue_position: 1,
    state_by: { user_id: maya, principal_id: null },
    state_at: "2026-11-19T10:00:00.000Z",
    comment_count: 2,
  });
  // Mix real server comment author shapes ({ kind, id } and { user_id, principal_id })
  commentsByTodo.set(todo1ID, [
    {
      comment_id: "30000000-0000-4000-8000-000000000001",
      author: { kind: "user", id: maya },
      body: "Sample box arrived yesterday.",
      created_at: "2026-11-19T11:00:00.000Z",
    },
    {
      comment_id: "30000000-0000-4000-8000-000000000002",
      author: { kind: "agent", id: atlas },
      body: "Checked vendor stock; 12 boxes in warehouse.",
      created_at: "2026-11-19T11:15:00.000Z",
    },
  ]);
};
seed();

let failNextWrite = false;
let commitThen503 = false;
let conflictNextWrite = false;
let readOnlyMode = false;
let accessRefused = false;
let edge403Mode = false;
let edge401Mode = false;
let preReceiptRefusalReason = null;
let contentRole = "editor"; // editor | commenter | reader
let workspaceRole = "member"; // member | admin | owner
let assignMakesOffer = false;

let holdNextCommentPage = false;
let heldCommentPageResolve = null;

const operationsForRole = (role) => {
  if (role === "editor") return ["read", "create", "update"];
  if (role === "commenter") return ["read", "create"];
  return ["read"];
};

const userIDForAlias = (alias) => {
  if (alias === "me") return me;
  if (alias === "maya") return maya;
  return otherUser;
};

let emailCodePending = false;
const sessions = new Set();

const server = createServer(async (req, res) => {
  const reply = (status, value) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(value));
  };
  try {
    const url = new URL(req.url, origin);
    if (req.headers.host !== new URL(origin).host) return reply(400, {});

    // Fixture controls
    if (req.method === "POST" && url.pathname === "/fixture/fail-next-write") {
      failNextWrite = true;
      return reply(200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/fixture/commit-then-503") {
      commitThen503 = true;
      return reply(200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/fixture/conflict-next-write") {
      conflictNextWrite = true;
      return reply(200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/fixture/read-only") {
      readOnlyMode = url.searchParams.get("on") !== "0";
      return reply(200, { ok: true, readOnlyMode });
    }
    if (req.method === "POST" && url.pathname === "/fixture/access-refused") {
      accessRefused = url.searchParams.get("on") !== "0";
      return reply(200, { ok: true, accessRefused });
    }
    if (req.method === "POST" && url.pathname === "/fixture/edge-403") {
      edge403Mode = url.searchParams.get("on") !== "0";
      return reply(200, { ok: true, edge403Mode });
    }
    if (req.method === "POST" && url.pathname === "/fixture/edge-401") {
      edge401Mode = url.searchParams.get("on") !== "0";
      return reply(200, { ok: true, edge401Mode });
    }
    if (req.method === "POST" && url.pathname === "/fixture/pre-receipt-refusal") {
      const reason = url.searchParams.get("reason");
      preReceiptRefusalReason = reason && reason.length > 0 ? reason : null;
      return reply(200, { ok: true, preReceiptRefusalReason });
    }
    if (req.method === "POST" && url.pathname === "/fixture/content-role") {
      contentRole = url.searchParams.get("role") || "editor";
      return reply(200, { ok: true, contentRole });
    }
    if (req.method === "POST" && url.pathname === "/fixture/workspace-role") {
      workspaceRole = url.searchParams.get("role") || "member";
      return reply(200, { ok: true, workspaceRole });
    }
    if (req.method === "POST" && url.pathname === "/fixture/assign-makes-offer") {
      assignMakesOffer = url.searchParams.get("on") !== "0";
      return reply(200, { ok: true, assignMakesOffer });
    }
    if (req.method === "POST" && url.pathname === "/fixture/set-offer") {
      const targetID = url.searchParams.get("todo_id") || todo1ID;
      const t = todos.get(targetID);
      if (!t) return reply(404, { ok: false });
      if (url.searchParams.get("clear") === "1") {
        t.offer = null;
      } else {
        const offerID = url.searchParams.get("offer_id") || randomUUID();
        const decider = userIDForAlias(url.searchParams.get("decider") || "me");
        const byUser = userIDForAlias(url.searchParams.get("by") || "maya");
        const toParam = url.searchParams.get("to") || "atlas";
        t.offer = {
          offer_id: offerID,
          to: toParam === "maya" ? { kind: "user", id: maya } : { kind: "agent", id: atlas },
          decider_user_id: decider,
          by: { user_id: byUser, principal_id: null },
          at: new Date().toISOString(),
          start: "queue",
        };
      }
      t.version += 1;
      return reply(200, { ok: true, version: t.version, offer_id: t.offer?.offer_id ?? null });
    }
    if (req.method === "POST" && url.pathname === "/fixture/advance-version") {
      const targetID = url.searchParams.get("todo_id") || todo1ID;
      const t = todos.get(targetID);
      if (!t) return reply(404, { ok: false });
      t.version += 2;
      const newTitle = url.searchParams.get("title");
      const newState = url.searchParams.get("state");
      if (newTitle) t.title = newTitle;
      if (newState) t.state = newState;
      return reply(200, { ok: true, version: t.version });
    }
    if (req.method === "POST" && url.pathname === "/fixture/hold-next-comment-page") {
      holdNextCommentPage = true;
      return reply(200, { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/fixture/comment-page-held") {
      return reply(200, { held: heldCommentPageResolve !== null });
    }
    if (req.method === "POST" && url.pathname === "/fixture/release-held-comment-page") {
      const status = Number(url.searchParams.get("status") || "500");
      if (heldCommentPageResolve) {
        const fn = heldCommentPageResolve;
        heldCommentPageResolve = null;
        fn(status);
      }
      return reply(200, { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/fixture/commands") {
      return reply(200, recordedCommands);
    }
    if (req.method === "GET" && url.pathname === "/fixture/mutations") {
      return reply(200, { total: totalMutations, by_kind: mutationsByKind });
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

    if (req.method === "POST" && url.pathname === "/auth/v1/otp") {
      emailCodePending = true;
      return reply(200, {});
    }
    if (req.method === "POST" && url.pathname === "/auth/v1/verify") {
      if (!emailCodePending) return reply(403, {});
      emailCodePending = false;
      const access = randomBytes(32).toString("hex");
      sessions.add(access);
      return reply(200, { access_token: access, refresh_token: randomBytes(32).toString("hex"), expires_in: 3600, user: { id: me } });
    }

    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (!sessions.has(token)) return reply(401, {});
    if (edge401Mode) return reply(401, {});

    if (req.method === "POST" && url.pathname === "/functions/v1/command") {
      const cmd = body.command;
      if (edge403Mode) return reply(403, { error: "forbidden" });
      if (accessRefused) return reply(403, { status: "refused", reason: "workspace_access_refused" });

      if (cmd?.kind === "household_access") {
        return reply(200, {
          status: "ok",
          content_role: contentRole,
          operations: operationsForRole(contentRole),
        });
      }

      if (cmd?.kind === "household_todo_answer") {
        recordedCommands.push({ command_id: body.command_id, kind: cmd.kind, answer: cmd.answer, offer_id: cmd.offer_id });
        if (preReceiptRefusalReason) {
          const r = preReceiptRefusalReason;
          preReceiptRefusalReason = null;
          return reply(403, { status: "refused", reason: r });
        }
        if (failNextWrite) { failNextWrite = false; return reply(503, { error: "unavailable" }); }
        if (readOnlyMode || contentRole !== "editor") return reply(403, { status: "refused", reason: "content_read_only" });
        if (receipts.has(body.command_id)) {
          return reply(200, { ...deepClone(receipts.get(body.command_id)), replayed: true });
        }
        const t = todos.get(cmd.todo_id);
        if (!t || !t.offer || t.offer.offer_id !== cmd.offer_id) return reply(409, { status: "refused", reason: "offer_not_pending" });
        const isAdmin = workspaceRole === "admin" || workspaceRole === "owner";
        if (cmd.answer === "withdraw") {
          if (t.offer.by?.user_id !== me && !isAdmin) return reply(403, { status: "refused", reason: "not_decider" });
        } else {
          if (t.offer.decider_user_id !== me) return reply(403, { status: "refused", reason: "not_decider" });
        }
        if (cmd.answer === "accept") {
          t.assignee = deepClone(t.offer.to);
        }
        t.offer = null;
        t.version += 1;
        recordMutation(cmd.kind);
        const stored = toStoredTodo(t);
        const committed = { status: "committed", value: stored, notices: [], replayed: false };
        receipts.set(body.command_id, deepClone(committed));
        if (commitThen503) { commitThen503 = false; return reply(503, { error: "unavailable" }); }
        return reply(200, committed);
      }

      if (cmd?.kind === "household_tool") {
        const args = cmd.arguments ?? {};
        if (args.seat !== seat) return reply(403, { status: "refused", reason: "seat_binding_mismatch" });

        if (cmd.tool === "todo_list") {
          const all = Array.from(todos.values()).map(toSummary);
          const filtered = args.scope === "open" ? all.filter((x) => x.state === "open" || x.state === "doing") : all;
          return reply(200, { status: "ok", todos: filtered, next_offset: null });
        }

        if (cmd.tool === "todo_read") {
          const offset = Number(args.comment_offset ?? 0);
          if (offset > 0 && holdNextCommentPage) {
            holdNextCommentPage = false;
            const releaseStatus = await new Promise((resolve) => {
              heldCommentPageResolve = resolve;
            });
            if (releaseStatus === 403) return reply(403, { error: "forbidden" });
            if (releaseStatus >= 500) return reply(releaseStatus, { error: "unavailable" });
          }
          const t = todos.get(args.todo_id);
          if (!t) return reply(404, { status: "refused", reason: "todo_not_found" });
          const allComments = commentsByTodo.get(t.todo_id) ?? [];
          const page = allComments.slice(offset, offset + 1);
          const next = offset + 1 < allComments.length ? offset + 1 : null;
          return reply(200, { status: "ok", todo: toReadTodo(t), comments: page, next_comment_offset: next });
        }

        // Write tools require request_id == command_id
        recordedCommands.push({
          command_id: body.command_id,
          kind: cmd.tool,
          request_id: args.request_id ?? null,
          base_version: args.base_version ?? null,
          mentions: args.mentions ?? null,
        });
        if (preReceiptRefusalReason) {
          const r = preReceiptRefusalReason;
          preReceiptRefusalReason = null;
          return reply(403, { status: "refused", reason: r });
        }
        if (failNextWrite) { failNextWrite = false; return reply(503, { error: "unavailable" }); }
        const needsUpdate = cmd.tool === "todo_set_state" || cmd.tool === "todo_assign" || cmd.tool === "todo_update";
        const needsCreate = cmd.tool === "todo_create" || cmd.tool === "todo_comment";
        const ops = operationsForRole(contentRole);
        if (readOnlyMode || (needsUpdate && !ops.includes("update")) || (needsCreate && !ops.includes("create"))) {
          return reply(403, { status: "refused", reason: "content_read_only" });
        }
        if (args.request_id !== body.command_id) return reply(400, { status: "refused", reason: "request_id_mismatch" });

        if (receipts.has(body.command_id)) {
          return reply(200, { ...deepClone(receipts.get(body.command_id)), replayed: true });
        }

        if (cmd.tool === "todo_create") {
          const id = randomUUID();
          const now = new Date().toISOString();
          const created = {
            workspace_id: wsMain,
            todo_id: id,
            version: 1,
            title: args.title,
            notes: args.notes ?? "",
            state: "open",
            due_on: args.due_on ?? null,
            created_by: { user_id: me, principal_id: null },
            created_at: now,
            assignee: args.assign?.to ?? null,
            assigned_by: args.assign?.to ? { user_id: me, principal_id: null } : null,
            assigned_at: args.assign?.to ? now : null,
            offer: null,
            gate: null,
            gate_clear: true,
            queue_position: null,
            state_by: { user_id: me, principal_id: null },
            state_at: now,
            comment_count: 0,
          };
          todos.set(id, created);
          commentsByTodo.set(id, []);
          recordMutation(cmd.tool);
          const committed = { status: "committed", value: toStoredTodo(created), notices: [], replayed: false };
          receipts.set(body.command_id, deepClone(committed));
          if (commitThen503) { commitThen503 = false; return reply(503, { error: "unavailable" }); }
          return reply(200, committed);
        }

        if (cmd.tool === "todo_set_state") {
          const t = todos.get(args.todo_id);
          if (!t) return reply(404, { status: "refused", reason: "todo_not_found" });
          if (conflictNextWrite || args.base_version !== t.version) {
            conflictNextWrite = false;
            t.version += 1;
            return reply(409, { status: "conflict", current: toStoredTodo(t) });
          }
          t.state = args.state;
          t.version += 1;
          t.state_at = new Date().toISOString();
          recordMutation(cmd.tool);
          const committed = { status: "committed", value: toStoredTodo(t), notices: [], replayed: false };
          receipts.set(body.command_id, deepClone(committed));
          if (commitThen503) { commitThen503 = false; return reply(503, { error: "unavailable" }); }
          return reply(200, committed);
        }

        if (cmd.tool === "todo_assign") {
          const t = todos.get(args.todo_id);
          if (!t) return reply(404, { status: "refused", reason: "todo_not_found" });
          if (conflictNextWrite || args.base_version !== t.version) {
            conflictNextWrite = false;
            t.version += 1;
            return reply(409, { status: "conflict", current: toStoredTodo(t) });
          }
          if (assignMakesOffer && args.to) {
            t.offer = {
              offer_id: randomUUID(),
              to: deepClone(args.to),
              decider_user_id: maya,
              by: { user_id: me, principal_id: null },
              at: new Date().toISOString(),
              start: "queue",
            };
          } else {
            t.assignee = args.to ?? null;
          }
          t.version += 1;
          recordMutation(cmd.tool);
          const committed = { status: "committed", value: toStoredTodo(t), notices: [], replayed: false };
          receipts.set(body.command_id, deepClone(committed));
          if (commitThen503) { commitThen503 = false; return reply(503, { error: "unavailable" }); }
          return reply(200, committed);
        }

        if (cmd.tool === "todo_update") {
          const t = todos.get(args.todo_id);
          if (!t) return reply(404, { status: "refused", reason: "todo_not_found" });
          if (conflictNextWrite || args.base_version !== t.version) {
            conflictNextWrite = false;
            t.version += 1;
            return reply(409, { status: "conflict", current: toStoredTodo(t) });
          }
          if (args.title !== undefined) t.title = args.title;
          if (args.notes !== undefined) t.notes = args.notes;
          if ("due_on" in args) t.due_on = args.due_on;
          t.version += 1;
          recordMutation(cmd.tool);
          const committed = { status: "committed", value: toStoredTodo(t), notices: [], replayed: false };
          receipts.set(body.command_id, deepClone(committed));
          if (commitThen503) { commitThen503 = false; return reply(503, { error: "unavailable" }); }
          return reply(200, committed);
        }

        if (cmd.tool === "todo_comment") {
          const t = todos.get(args.target?.id);
          if (!t) return reply(404, { status: "refused", reason: "target_not_found" });
          const comment = {
            comment_id: randomUUID(),
            author: { kind: "user", id: me },
            body: args.body,
            created_at: new Date().toISOString(),
          };
          const list = commentsByTodo.get(t.todo_id) ?? [];
          list.push(comment);
          commentsByTodo.set(t.todo_id, list);
          t.comment_count = list.length;
          recordMutation(cmd.tool);
          const committed = { status: "committed", value: comment, notices: [], replayed: false };
          receipts.set(body.command_id, deepClone(committed));
          if (commitThen503) { commitThen503 = false; return reply(503, { error: "unavailable" }); }
          return reply(200, committed);
        }
      }
      return reply(400, { error: "invalid_request" });
    }

    if (req.method !== "GET" || req.headers["accept-profile"] !== "swarm_read") return reply(400, {});
    if (edge403Mode) return reply(403, { error: "forbidden" });
    if (accessRefused) return reply(403, { status: "refused", reason: "workspace_access_refused" });
    if (url.pathname === "/rest/v1/workspaces") return reply(200, workspaces);
    if (url.pathname === "/rest/v1/memberships") {
      return reply(200, [{ user_id: me, role: workspaceRole }]);
    }
    if (url.pathname === "/rest/v1/member_profiles") {
      return reply(200, [
        { user_id: me, display_name: "You" },
        { user_id: maya, display_name: "Maya Chen" },
      ]);
    }
    if (url.pathname === "/rest/v1/agent_principals") {
      return reply(200, [{ principal_id: atlas, name: "Atlas" }]);
    }
    return reply(404, {});
  } catch {
    return reply(400, {});
  }
});

server.listen(requestedPort, "127.0.0.1", () => {
  const actualPort = server.address().port;
  origin = `http://127.0.0.1:${actualPort}`;
  if (!verify) {
    console.log(`TodoActions fixture listening on loopback port ${actualPort}`);
    return;
  }
  const child = spawn(process.argv[3], [String(actualPort), ...process.argv.slice(4)], { stdio: "inherit" });
  child.once("error", () => { process.exitCode = 1; server.close(); });
  child.once("exit", (status) => {
    process.exitCode = status ?? 1;
    server.close();
  });
});
