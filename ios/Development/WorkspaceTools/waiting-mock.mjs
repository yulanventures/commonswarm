// Loopback simulator fixture for iPhone Waiting on you (PR 1: questions with in-card answers).
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
let failNextOnce = false;

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

    if (verify && req.method === "POST" && url.pathname === "/fixture/fail-next") {
      failNextOnce = true;
      return reply(200, { ok: true });
    }
    if (verify && req.method === "GET" && url.pathname === "/fixture/commands") {
      return reply(200, receivedCommands);
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
      return reply(400, { error: "invalid_request" });
    }

    if (req.method === "POST" && url.pathname === "/rest/v1/rpc/decision_queue") {
      const wsId = String(body.p_workspace_id ?? "").toLowerCase();
      const all = (asksByWorkspace.get(wsId) ?? []).filter((a) => !answered.has(a.signal_id));
      return reply(200, {
        workspace_id: wsId,
        generated_at: new Date().toISOString(),
        total: all.length,
        truncated: false,
        asks: all.map(({ placement, multi, options, ...ask }) => ask),
      });
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
            .filter((a) => wanted.has(a.signal_id))
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
      case "/functions/v1/read": {
        if (req.method !== "POST") return reply(405, {});
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const body = raw ? JSON.parse(raw) : {};
        const reqWs = workspaces.find((w) => w.workspace_id === body.workspace_id) ?? ws;
        const convGeneral = {
          conversation_id: "40000000-0000-4000-8000-000000000001",
          kind: "general",
          channel_id: null,
          slug: null,
          description: null,
          archived_at: null,
          joined: true,
          members: [
            { kind: "user", id: me, name: "You", left_at: null },
            { kind: "user", id: maya, name: "Maya Chen", left_at: null },
            { kind: "agent", id: atlas, name: "Atlas", left_at: null },
          ],
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
          members: convGeneral.members,
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
        const allConvs = reqWs.workspace_id === wsMain ? [convGeneral, convMobile, convDmAtlas] : [convGeneral];
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
