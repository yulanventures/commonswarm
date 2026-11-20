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
const wsOther = "00000000-0000-4000-8000-000000000099";
const orgMain = "00000000-0000-4000-8000-000000000010";
const orgOther = "00000000-0000-4000-8000-000000000020";
const goneAgent = "00000000-0000-4000-8000-000000000088";

let workspaceOrg = orgMain;

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
let failMyAdminGrants = false;
let refuseAdminGrants = false;
let nonOwnerGrants = false;
let ownAdminGrants = false;
let duplicateRows = false;
let omitMaya = false;
let viewerRole = "owner";
let holdGrantsResponseOnce = false;
let grantsResponseHeld = false;
let releaseGrantsResponse = null;
let holdMembersRequestOnce = false;
let membersRequestHeld = false;
let releaseMembersRequest = null;
let holdMyGrantsOnce = false;
let myGrantsHeld = false;
let releaseMyGrants = null;
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
    if (req.method === "POST" && url.pathname === "/fixture/fail-my-admin-grants") {
      failMyAdminGrants = url.searchParams.get("on") !== "0";
      return reply(200, { ok: true, failMyAdminGrants });
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
    if (req.method === "POST" && url.pathname === "/fixture/own-admin-grants") {
      ownAdminGrants = url.searchParams.get("on") !== "0";
      return reply(200, { ok: true, ownAdminGrants });
    }
    if (req.method === "POST" && url.pathname === "/fixture/workspace-org") {
      const target = url.searchParams.get("org");
      if (target === "other") workspaceOrg = orgOther;
      else if (target === "none") workspaceOrg = null;
      else workspaceOrg = orgMain;
      return reply(200, { ok: true, workspaceOrg });
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
    if (req.method === "POST" && url.pathname === "/fixture/hold-my-admin-grants") {
      holdMyGrantsOnce = true;
      myGrantsHeld = false;
      releaseMyGrants = null;
      return reply(200, { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/fixture/my-admin-grants-held") {
      return reply(200, { held: myGrantsHeld });
    }
    if (req.method === "POST" && url.pathname === "/fixture/release-my-admin-grants") {
      const release = releaseMyGrants;
      releaseMyGrants = null;
      myGrantsHeld = false;
      if (release) release();
      return reply(200, { ok: true });
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

    // Production RPC: POST /rest/v1/rpc/my_seat_admin_grants (viewer's own grants across workspaces)
    if (req.method === "POST" && url.pathname === "/rest/v1/rpc/my_seat_admin_grants") {
      readRequestCount += 1;
      if (req.headers["accept-profile"] !== "swarm_read" || req.headers["content-profile"] !== "swarm_read") {
        return reply(400, { error: "missing_profile" });
      }
      if (edge401) return reply(401, {});
      if (accessRefused || refuseAdminGrants) return reply(403, { error: "forbidden" });
      if (failAdminGrants || failMyAdminGrants) return reply(503, { error: "unavailable" });
      if (holdMyGrantsOnce) {
        holdMyGrantsOnce = false;
        myGrantsHeld = true;
        await new Promise((resolve) => {
          releaseMyGrants = resolve;
        });
      }
      if (!ownAdminGrants) return reply(200, { grants: [] });
      return reply(200, {
        grants: [
          {
            grant_id: "my_grant_atlas_active",
            principal_id: atlas,
            level: "scoped",
            organization_id: null,
            scope_names: ["members.invite"],
            workspace_ids: [wsMain],
            expires_at: new Date(Date.now() + 7 * 86400 * 1000).toISOString(),
            state: "active",
            created_at: new Date(Date.now() - 3600 * 1000).toISOString(),
          },
          {
            grant_id: "my_grant_atlas_org_here",
            principal_id: atlas,
            level: "organization",
            organization_id: orgMain,
            scope_names: ["role:organization_admin"],
            workspace_ids: [],
            expires_at: new Date(Date.now() + 7 * 86400 * 1000).toISOString(),
            state: "active",
            created_at: new Date(Date.now() - 3600 * 1000).toISOString(),
          },
          {
            grant_id: "my_grant_atlas_org_other",
            principal_id: atlas,
            level: "organization",
            organization_id: orgOther,
            scope_names: ["role:organization_admin"],
            workspace_ids: [],
            expires_at: new Date(Date.now() + 7 * 86400 * 1000).toISOString(),
            state: "active",
            created_at: new Date(Date.now() - 3600 * 1000).toISOString(),
          },
          {
            grant_id: "my_grant_atlas_org_unknown",
            principal_id: atlas,
            level: "organization",
            organization_id: null,
            scope_names: ["role:organization_admin"],
            workspace_ids: [],
            expires_at: new Date(Date.now() + 7 * 86400 * 1000).toISOString(),
            state: "active",
            created_at: new Date(Date.now() - 3600 * 1000).toISOString(),
          },
          {
            grant_id: "my_grant_gone_org_here",
            principal_id: goneAgent,
            level: "organization",
            organization_id: orgMain,
            scope_names: ["role:organization_admin"],
            workspace_ids: [],
            expires_at: new Date(Date.now() + 7 * 86400 * 1000).toISOString(),
            state: "active",
            created_at: new Date(Date.now() - 3600 * 1000).toISOString(),
          },
          {
            grant_id: "my_grant_other_ws",
            principal_id: beacon,
            level: "workspace",
            organization_id: null,
            scope_names: [],
            workspace_ids: [wsOther],
            expires_at: new Date(Date.now() + 7 * 86400 * 1000).toISOString(),
            state: "active",
            created_at: new Date(Date.now() - 3600 * 1000).toISOString(),
          },
          {
            grant_id: "my_grant_ended",
            principal_id: atlas,
            level: "scoped",
            organization_id: null,
            scope_names: ["members.invite"],
            workspace_ids: [wsMain],
            expires_at: new Date(Date.now() + 7 * 86400 * 1000).toISOString(),
            state: "ended",
            created_at: new Date(Date.now() - 7200 * 1000).toISOString(),
          },
          {
            grant_id: "my_grant_expired",
            principal_id: atlas,
            level: "scoped",
            organization_id: null,
            scope_names: ["members.invite"],
            workspace_ids: [wsMain],
            expires_at: new Date(Date.now() - 60 * 1000).toISOString(),
            state: "active",
            created_at: new Date(Date.now() - 7200 * 1000).toISOString(),
          },
        ],
      });
    }

    if (req.method !== "GET" || req.headers["accept-profile"] !== "swarm_read") return reply(400, {});
    if (url.pathname === "/rest/v1/workspaces") {
      const wsFilter = url.searchParams.get("workspace_id")?.toLowerCase();
      if (wsFilter) {
        readRequestCount += 1;
        if (edge401) return reply(401, {});
        if (edge404) return reply(404, { error: "workspace_not_found" });
        if (accessRefused) return reply(403, { message: "workspace_access_refused" });
        if (wsFilter !== `eq.${wsMain}`) return reply(200, []);
      }
      return reply(200, [{ workspace_id: wsMain, org_id: workspaceOrg, name: "Simulator workspace" }]);
    }

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
        const rows = [
          {
            principal_id: atlas,
            last_command_at: new Date(Date.now() - 3 * 60 * 1000).toISOString(),
            client_build: "cswarm 0.14.2",
            last_ack_via: "listener",
          },
          {
            principal_id: beacon,
            last_command_at: new Date(Date.now() - 3 * 3600 * 1000).toISOString(),
            client_build: "mcp-hosted 1.2",
            last_ack_via: "turn",
          },
        ];
        if (duplicateRows) rows.push({ ...rows[0] });
        return reply(200, rows);
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
