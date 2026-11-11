/** Synthetic HTTP for real mounted workspace observers; no production hooks. */
function installWorkspaceFixture() {
  const w = window as any;
  const workspace = "11111111-1111-4111-8111-111111111111", other = "22222222-2222-4222-8222-222222222222";
  const owner = "33333333-3333-4333-8333-333333333333", agent = "44444444-4444-4444-8444-444444444444";
  const org = "55555555-5555-4555-8555-555555555555", recent = new Date().toISOString();
  const scenario = new URL(location.href).searchParams.get("case") ?? "success";
  document.documentElement.dataset.theme = new URL(location.href).searchParams.get("theme") ?? "dark";
  const user = { id: owner, aud: "authenticated", role: "authenticated", email: "synthetic@example.test",
    app_metadata: {}, user_metadata: {}, created_at: recent };
  const f = w.existingFixture = { workspace, other, owner, agent, scenario, commands: [] as any[], accountReads: 0,
    added: scenario.startsWith("people"), model: "Claude", failRoster: false, held: false, release: null as null | (() => void), unexpected: [] as string[],
    requests: [] as string[], errors: [] as string[] };
  window.addEventListener("error", event => { f.errors.push(event.message); });
  const network = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    if (url.origin === location.origin) return network(input, init);
    f.requests.push(request.method + " " + url.pathname);
    const body = request.method === "POST" ? await request.json().catch(() => null) : null;
    if (url.origin !== "https://api.test.invalid") { f.unexpected.push(url.origin + url.pathname); return Response.json({}, { status: 404 }); }
    if (url.pathname === "/auth/v1/user") return Response.json(user);
    if (url.pathname === "/auth/v1/logout") return Response.json({});
    if (url.pathname === "/rest/v1/workspaces") return Response.json([
      { workspace_id: workspace, org_id: org, name: "Home", archived_at: null },
      { workspace_id: other, org_id: org, name: "Studio", archived_at: null },
    ]);
    if (url.pathname === "/rest/v1/member_profiles") return Response.json([{ user_id: owner, display_name: "Synthetic owner", role: "owner" }]);
    if (url.pathname === "/rest/v1/account_agents") {
      f.accountReads++;
      if (scenario === "read-error" && f.accountReads === 1) return Response.json({ message: "synthetic read failure" }, { status: 503 });
      if (scenario === "stale-read" || scenario === "stale-account") { f.held = true; await new Promise<void>(resolve => { f.release = resolve; }); }
      if (scenario === "empty") return Response.json([]);
      return Response.json([{ principal_id: agent, name: "Atlas Research & Long-Running Investigations", model: "Claude", transport: "hosted_mcp", revoked_at: null,
        workspaces: [{ workspace_id: other, workspace_name: "Studio", org_id: org, org_name: "Household", revoked_at: null, archived_at: null }] }]);
    }
    if (url.pathname === "/rest/v1/agent_principals") {
      if (url.searchParams.get("revoked_at") !== "is.null") return Response.json([]);
      if (f.failRoster) return Response.json({ message: "synthetic roster failure" }, { status: 503 });
      const target = url.searchParams.get("workspace_id");
      return Response.json(f.added && target === "eq." + workspace ? [{ principal_id: agent, name: "Atlas Research & Long-Running Investigations", model: f.model,
        transport: "hosted_mcp", turn_only: true, owner_user_id: owner, revoked_at: null, workspace_id: workspace, created_at: recent }] : []);
    }
    if (url.pathname === "/functions/v1/command") {
      if (body?.command?.kind === "set_agent_model") { f.model = body.command.model; return Response.json({ status: "accepted" }); }
      if (body?.command?.kind !== "add_agent_to_workspace") {
        // The mounted Lists & docs pane reads through the command endpoint too.
        if (!["household_access", "household_tool", "household_connections"].includes(body?.command?.kind))
          f.unexpected.push("command:" + body?.command?.kind);
        return Response.json({ error: "synthetic_access_unavailable" }, { status: 403 });
      }
      f.commands.push(body);
      if (scenario === "refused") return Response.json({ error: "forbidden" }, { status: 403 });
      if (scenario === "stale-write") { f.held = true; await new Promise<void>(resolve => { f.release = resolve; }); }
      f.added = true;
      if (scenario === "refresh-error") f.failRoster = true;
      return Response.json({ status: "accepted", ok: true, principal_id: agent, workspace_id: workspace, event_ids: [] });
    }
    if (url.pathname === "/rest/v1/rpc/home_overview") return Response.json({ viewer_user_id: owner, generated_at: recent,
      workspaces: [workspace, other].map(id => ({ workspace_id: id, name: id === workspace ? "Home" : "Studio", role: "owner", last_seen_at: recent,
        new_messages: 0, content: null, people: [{ user_id: owner, display_name: "Synthetic owner", role: "owner", is_viewer: true, agents: [] }],
        needs_you: { asks: [], assigned: [], waiting: [] } })) });
    if (url.pathname === "/rest/v1/rpc/channel_unread") return Response.json({ workspace_id: workspace, generated_at: recent, channels: [] });
    if (url.pathname === "/rest/v1/rpc/decision_queue") return Response.json({ workspace_id: workspace, generated_at: recent, total: 0, truncated: false, asks: [] });
    if (url.pathname.startsWith("/rest/v1/")) return Response.json([]);
    if (url.pathname === "/functions/v1/read") return Response.json(body?.resource === "seat_admin_status" ? { enabled: false }
      : body?.resource === "pending_access" ? { pending: [], agents: [] } : { grants: [] });
    f.unexpected.push(request.method + " " + url.pathname);
    return Response.json({ error: "unexpected_fixture_request" }, { status: 404 });
  };
  localStorage.setItem("sb-api-auth-token", JSON.stringify({ access_token: "synthetic-human", refresh_token: "synthetic-refresh", token_type: "bearer",
    expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user }));
}

