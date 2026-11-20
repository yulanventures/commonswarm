// Loopback simulator fixture for iPhone People & agents directory PR 1 (Rank 10).
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const verify = process.argv[2] === "--verify";
const requestedPort = verify ? 0 : Number(process.env.PEOPLE_FIXTURE_PORT || 8765);
let origin;

const me = "00000000-0000-4000-8000-000000000001";
const atlas = "00000000-0000-4000-8000-000000000002";
const beacon = "00000000-0000-4000-8000-000000000004";
const maya = "00000000-0000-4000-8000-000000000011";
const devon = "00000000-0000-4000-8000-000000000012";
const wsMain = "00000000-0000-4000-8000-000000000003";

const workspaces = [{ workspace_id: wsMain, name: "Simulator workspace" }];

let accessRefused = false;
let edge401 = false;
let edge404 = false;
let failMembers = false;
let emptyMembers = false;
let failAgents = false;
let failInvites = false;
let emptyInvites = false;
let refuseInvites = false;
let failAdminGrants = false;
let refuseAdminGrants = false;
let nonOwnerGrants = false;
let duplicateRows = false;
let omitMaya = false;
let viewerRole = "owner";
let holdGrantsResponseOnce = false;
let grantsResponseHeld = false;
let releaseGrantsResponse = null;
let holdMembersRequestOnce = false;
let membersRequestHeld = false;
let releaseMembersRequest = null;
let legacyWakePathMode = false;
let omitHomeOverview = false;
let refuseWakePath = false;
let refuseHomeOverview = false;
let seatStatusScenario = "default"; // default | waiting_stale | not_listening | fault
let readRequestCount = 0;

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

    if (req.method === "POST" && url.pathname === "/fixture/access-refused") {
      accessRefused = url.searchParams.get("on") !== "0";
      return reply(200, { ok: true, accessRefused });
    }
    if (req.method === "POST" && url.pathname === "/fixture/edge-401") {
      edge401 = url.searchParams.get("on") !== "0";
      return reply(200, { ok: true, edge401 });
    }
    if (req.method === "POST" && url.pathname === "/fixture/edge-404") {
      edge404 = url.searchParams.get("on") !== "0";
      return reply(200, { ok: true, edge404 });
    }
    if (req.method === "POST" && url.pathname === "/fixture/fail-members") {
      failMembers = url.searchParams.get("on") !== "0";
      return reply(200, { ok: true, failMembers });
    }
    if (req.method === "POST" && url.pathname === "/fixture/empty-members") {
      emptyMembers = url.searchParams.get("on") !== "0";
      return reply(200, { ok: true, emptyMembers });
    }
    if (req.method === "POST" && url.pathname === "/fixture/fail-agents") {
      failAgents = url.searchParams.get("on") !== "0";
      return reply(200, { ok: true, failAgents });
    }
    if (req.method === "POST" && url.pathname === "/fixture/fail-invites") {
      failInvites = url.searchParams.get("on") !== "0";
      return reply(200, { ok: true, failInvites });
    }
    if (req.method === "POST" && url.pathname === "/fixture/empty-invites") {
      emptyInvites = url.searchParams.get("on") !== "0";
      return reply(200, { ok: true, emptyInvites });
    }
    if (req.method === "POST" && url.pathname === "/fixture/refuse-invites") {
      refuseInvites = url.searchParams.get("on") !== "0";
      return reply(200, { ok: true, refuseInvites });
    }
    if (req.method === "POST" && url.pathname === "/fixture/fail-admin-grants") {
      failAdminGrants = url.searchParams.get("on") !== "0";
      return reply(200, { ok: true, failAdminGrants });
    }
    if (req.method === "POST" && url.pathname === "/fixture/refuse-admin-grants") {
      refuseAdminGrants = url.searchParams.get("on") !== "0";
      return reply(200, { ok: true, refuseAdminGrants });
    }
    if (req.method === "POST" && url.pathname === "/fixture/omit-maya") {
      omitMaya = url.searchParams.get("on") !== "0";
      return reply(200, { ok: true, omitMaya });
    }
    if (req.method === "POST" && url.pathname === "/fixture/non-owner-grants") {
      nonOwnerGrants = url.searchParams.get("on") !== "0";
      return reply(200, { ok: true, nonOwnerGrants });
    }
    if (req.method === "POST" && url.pathname === "/fixture/duplicate-rows") {
      duplicateRows = url.searchParams.get("on") !== "0";
      return reply(200, { ok: true, duplicateRows });
    }
    if (req.method === "POST" && url.pathname === "/fixture/viewer-role") {
      const role = url.searchParams.get("role");
      if (role === "owner" || role === "admin" || role === "member") {
        viewerRole = role;
      }
      return reply(200, { ok: true, viewerRole });
    }
    if (req.method === "POST" && url.pathname === "/fixture/hold-parallel-demotion") {
      holdGrantsResponseOnce = true;
      grantsResponseHeld = false;
      releaseGrantsResponse = null;
      holdMembersRequestOnce = true;
      membersRequestHeld = false;
      releaseMembersRequest = null;
      return reply(200, { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/fixture/parallel-demotion-held") {
      return reply(200, { held: grantsResponseHeld && membersRequestHeld });
    }
    if (req.method === "POST" && url.pathname === "/fixture/release-parallel-demotion") {
      const releaseGrants = releaseGrantsResponse;
      const releaseMembers = releaseMembersRequest;
      releaseGrantsResponse = null;
      releaseMembersRequest = null;
      grantsResponseHeld = false;
      membersRequestHeld = false;
      if (releaseMembers) releaseMembers();
      if (releaseGrants) releaseGrants();
      return reply(200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/fixture/legacy-wake-path") {
      legacyWakePathMode = url.searchParams.get("on") !== "0";
      return reply(200, { ok: true, legacyWakePathMode });
    }
    if (req.method === "POST" && url.pathname === "/fixture/omit-home-overview") {
      omitHomeOverview = url.searchParams.get("on") !== "0";
      return reply(200, { ok: true, omitHomeOverview });
    }
    if (req.method === "POST" && url.pathname === "/fixture/refuse-wake-path") {
      refuseWakePath = url.searchParams.get("on") !== "0";
      return reply(200, { ok: true, refuseWakePath });
    }
    if (req.method === "POST" && url.pathname === "/fixture/refuse-home-overview") {
      refuseHomeOverview = url.searchParams.get("on") !== "0";
      return reply(200, { ok: true, refuseHomeOverview });
    }
    if (req.method === "POST" && url.pathname === "/fixture/seat-scenario") {
      seatStatusScenario = url.searchParams.get("mode") || "default";
      return reply(200, { ok: true, seatStatusScenario });
    }
    if (req.method === "GET" && url.pathname === "/fixture/requests") {
      return reply(200, { reads: readRequestCount });
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
      const convGeneral = {
        conversation_id: "40000000-0000-4000-8000-000000000001",
        kind: "general",
        channel_id: null,
        slug: null,
        description: null,
        archived_at: null,
        joined: true,
        members: [
          { kind: "user", id: me, name: "Alex Rivera", left_at: null },
          { kind: "user", id: maya, name: "Maya Chen", left_at: null },
          { kind: "agent", id: atlas, name: "Atlas", left_at: null },
        ],
        last_message_at: "2026-11-19T14:00:00.000Z",
        notify_level: "all",
        mention_count: 0,
        unread_count: 0,
      };
      if (body.resource === "conversations") return reply(200, { conversations: [convGeneral] });
      if (body.resource === "conversation_history") return reply(200, { conversation: convGeneral, messages: [] });
      return reply(400, { error: "invalid_request" });
    }

    // Production RPC: POST /rest/v1/rpc/home_overview (C2 live seat status facts)
    if (req.method === "POST" && url.pathname === "/rest/v1/rpc/home_overview") {
      readRequestCount += 1;
      if (req.headers["accept-profile"] !== "swarm_read" || req.headers["content-profile"] !== "swarm_read") {
        return reply(400, { error: "missing_profile" });
      }
      if (edge401) return reply(401, {});
      if (accessRefused || refuseHomeOverview) return reply(403, { error: "forbidden" });
      if (omitHomeOverview) return reply(404, { code: "PGRST202", message: "not deployed" });

      const now = Date.now();
      const atlasWorkingSince = new Date(now - 3 * 60 * 1000).toISOString();
      const atlasUntil = new Date(now + 30 * 60 * 1000).toISOString();
      const beaconLastAct = new Date(now - 5 * 60 * 1000).toISOString();
      const staleWaitSince = new Date(now - 10 * 60 * 1000).toISOString();

      let atlasStatus = {
        work: "working",
        facts: {
          transport: "local",
          turn_only: false,
          connection: "live",
          last_activity_at: new Date(now - 60 * 1000).toISOString(),
          messages_waiting_since: null,
          messages_waiting_count: 0,
          wake: {
            watcher_at: new Date(now - 30 * 1000).toISOString(),
            channel_at: null,
            listener_at: null,
            turn_at: null,
          },
          doing: { todo_id: "50000000-0000-4000-8000-000000000099", title: "SECRET PRIVATE TITLE", since: atlasWorkingSince },
          working_on: { signal_id: "50000000-0000-4000-8000-000000000098", at: atlasWorkingSince, until: atlasUntil },
        },
      };
      if (seatStatusScenario === "waiting_stale") {
        atlasStatus = {
          work: "idle",
          facts: {
            transport: "local",
            turn_only: false,
            connection: "live",
            last_activity_at: new Date(now - 15 * 60 * 1000).toISOString(),
            messages_waiting_since: staleWaitSince,
            messages_waiting_count: 2,
            wake: { watcher_at: new Date(now - 20 * 60 * 1000).toISOString(), channel_at: null, listener_at: null, turn_at: null },
            doing: null,
            working_on: null,
          },
        };
      } else if (seatStatusScenario === "not_listening") {
        atlasStatus = {
          work: "idle",
          facts: {
            transport: "local",
            turn_only: false,
            connection: "live",
            last_activity_at: new Date(now - 2 * 3600 * 1000).toISOString(),
            messages_waiting_since: null,
            messages_waiting_count: 0,
            wake: { watcher_at: new Date(now - 2 * 3600 * 1000).toISOString(), channel_at: null, listener_at: null, turn_at: null },
            doing: null,
            working_on: null,
          },
        };
      } else if (seatStatusScenario === "fault") {
        atlasStatus = {
          work: "disconnected",
          facts: {
            transport: "local",
            turn_only: false,
            connection: "key_off",
            last_activity_at: new Date(now - 60 * 1000).toISOString(),
            messages_waiting_since: null,
            messages_waiting_count: 0,
            wake: { watcher_at: new Date(now - 30 * 1000).toISOString(), channel_at: null, listener_at: null, turn_at: null },
            doing: null,
            working_on: null,
          },
        };
      }

      const beaconStatus = {
        work: "idle",
        facts: {
          transport: "hosted_mcp",
          turn_only: true,
          connection: "live",
          last_activity_at: beaconLastAct,
          messages_waiting_since: null,
          messages_waiting_count: 0,
          wake: { watcher_at: null, channel_at: null, listener_at: null, turn_at: beaconLastAct },
          doing: null,
          working_on: null,
        },
      };

      return reply(200, {
        viewer_user_id: me,
        generated_at: new Date(now).toISOString(),
        workspaces: [
          {
            workspace_id: wsMain,
            name: "Simulator workspace",
            role: viewerRole,
            people: [
              {
                user_id: me,
                display_name: "Alex Rivera",
                role: viewerRole,
                is_viewer: true,
                agents: [{ principal_id: atlas, name: "Atlas", status: atlasStatus }],
              },
              ...(omitMaya
                ? []
                : [
                    {
                      user_id: maya,
                      display_name: "Maya Chen",
                      role: "admin",
                      is_viewer: false,
                      agents: [{ principal_id: beacon, name: "Beacon", status: beaconStatus }],
                    },
                  ]),
            ],
          },
        ],
      });
    }

    // Production RPC: POST /rest/v1/rpc/workspace_seat_admin_grants
    if (req.method === "POST" && url.pathname === "/rest/v1/rpc/workspace_seat_admin_grants") {
      readRequestCount += 1;
      if (req.headers["accept-profile"] !== "swarm_read" || req.headers["content-profile"] !== "swarm_read") {
        return reply(400, { error: "missing_profile" });
      }
      if (edge401) return reply(401, {});
      if (accessRefused || refuseAdminGrants) return reply(403, { error: "forbidden" });
      if (failAdminGrants) return reply(503, { error: "unavailable" });
      if ((body?.p_workspace_id ?? "").toLowerCase() !== wsMain) return reply(200, null);
      if (nonOwnerGrants) return reply(200, null);
      const ownerPayload = {
        grants: [
          {
            grant_id: "grant_atlas_1",
            principal_id: atlas,
            agent_name: "Atlas",
            owner_user_id: me,
            owner_display: "Alex Rivera",
            level: "scoped",
            expires_at: new Date(Date.now() + 7 * 86400 * 1000).toISOString(),
            created_at: new Date(Date.now() - 86400 * 1000).toISOString(),
            may_end: true,
          },
        ],
      };
      if (holdGrantsResponseOnce) {
        holdGrantsResponseOnce = false;
        grantsResponseHeld = true;
        await new Promise((resolve) => {
          releaseGrantsResponse = resolve;
        });
      }
      return reply(200, ownerPayload);
    }

    if (req.method !== "GET" || req.headers["accept-profile"] !== "swarm_read") return reply(400, {});
    if (url.pathname === "/rest/v1/workspaces") return reply(200, workspaces);

    readRequestCount += 1;
    if (edge401) return reply(401, {});
    if (edge404) return reply(404, { error: "workspace_not_found" });

    const wsParam = url.searchParams.get("workspace_id")?.toLowerCase();
    if (wsParam !== `eq.${wsMain}`) return reply(403, {});

    if (accessRefused) return reply(403, { message: "workspace_access_refused" });

    switch (url.pathname) {
      case "/rest/v1/member_profiles": {
        if (holdMembersRequestOnce) {
          holdMembersRequestOnce = false;
          membersRequestHeld = true;
          await new Promise((resolve) => {
            releaseMembersRequest = resolve;
          });
        }
        if (failMembers) return reply(503, { error: "unavailable" });
        if (emptyMembers) return reply(200, []);
        const rows = [
          { user_id: me, display_name: "Alex Rivera", role: viewerRole },
          ...(omitMaya ? [] : [{ user_id: maya, display_name: "Maya Chen", role: "admin" }]),
          { user_id: devon, display_name: "Devon Park", role: "member" },
        ];
        if (duplicateRows) rows.push({ user_id: maya, display_name: "Maya Chen", role: "admin" });
        return reply(200, rows);
      }
      case "/rest/v1/agent_principals": {
        if (failAgents) return reply(503, { error: "unavailable" });
        const rows = [
          {
            principal_id: atlas,
            name: "Atlas",
            model: "Claude Sonnet",
            transport: "local",
            turn_only: false,
            owner_user_id: me,
            revoked_at: null,
            workspace_id: wsMain,
          },
          ...(omitMaya
            ? []
            : [
                {
                  principal_id: beacon,
                  name: "Beacon",
                  model: "Gemini Pro",
                  transport: "hosted_mcp",
                  turn_only: false,
                  owner_user_id: maya,
                  revoked_at: null,
                  workspace_id: wsMain,
                },
              ]),
        ];
        if (duplicateRows) rows.push({ ...rows[0] });
        return reply(200, rows);
      }
      case "/rest/v1/agent_presence": {
        const now = Date.now();
        const watcherIso =
          seatStatusScenario === "not_listening"
            ? new Date(now - 2 * 3600 * 1000).toISOString()
            : seatStatusScenario === "waiting_stale"
              ? new Date(now - 20 * 60 * 1000).toISOString()
              : new Date(now - 30 * 1000).toISOString();
        const rows = [
          {
            principal_id: atlas,
            last_command_at:
              seatStatusScenario === "not_listening"
                ? new Date(now - 2 * 3600 * 1000).toISOString()
                : new Date(now - 3 * 60 * 1000).toISOString(),
            client_build: "cswarm 0.1.107",
            watcher_at: watcherIso,
            channel_at: null,
            listener_at: null,
            turn_at: null,
            last_ack_via: "leased",
            last_ack_at: watcherIso,
            current_client_build: "cswarm 0.1.107",
          },
          {
            principal_id: beacon,
            last_command_at: new Date(now - 5 * 60 * 1000).toISOString(),
            client_build: "mcp-hosted 1.2",
            watcher_at: null,
            channel_at: null,
            listener_at: null,
            turn_at: new Date(now - 5 * 60 * 1000).toISOString(),
            last_ack_via: "unclaimed",
            last_ack_at: new Date(now - 5 * 60 * 1000).toISOString(),
            current_client_build: null,
          },
        ];
        if (duplicateRows) rows.push({ ...rows[0] });
        return reply(200, rows);
      }
      case "/rest/v1/agent_wake_path": {
        if (refuseWakePath) return reply(403, { error: "forbidden" });
        const select = url.searchParams.get("select") || "";
        if (legacyWakePathMode && select.includes("unseen_count")) {
          return reply(400, { code: "42703", message: "column unseen_count does not exist" });
        }
        if (seatStatusScenario === "waiting_stale") {
          const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
          return reply(200, [
            legacyWakePathMode
              ? { principal_id: atlas, oldest_unobserved_at: since }
              : { principal_id: atlas, oldest_unobserved_at: since, unseen_count: 2 },
          ]);
        }
        return reply(200, []);
      }
      case "/rest/v1/pending_invitations":
        if (refuseInvites) return reply(403, { error: "forbidden" });
        if (failInvites) return reply(503, { error: "unavailable" });
        if (emptyInvites) return reply(200, []);
        return reply(200, [
          {
            workspace_id: wsMain,
            invitation_id: "inv_sam_1",
            email: "sam@example.test",
            created_by: maya,
            created_at: new Date(Date.now() - 3600 * 1000).toISOString(),
            expires_at: new Date(Date.now() + 5 * 86400 * 1000).toISOString(),
          },
        ]);
      default:
        // Note: GET /rest/v1/workspace_seat_admin_grants intentionally returns 404 (it is a POST RPC in production).
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
    console.log(`PeopleDirectory fixture listening on loopback port ${actualPort}`);
    return;
  }
  const child = spawn(process.argv[3], [String(actualPort), ...process.argv.slice(4)], { stdio: "inherit" });
  child.once("error", () => { process.exitCode = 1; server.close(); });
  child.once("exit", (status) => {
    process.exitCode = status ?? 1;
    server.close();
  });
});
