/** Real mounted app, buttons and browser client; only HTTP answers are synthetic. */
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderAstroFixture, compileFixtureFunction } from "../../../tests/astro-fixture";
import { browserTest as test } from "../../../tests/chrome.js";
import { findChrome, launchChrome } from "../../../tests/chrome.js";

// Owner boundary: a source/string test cannot prove the third click sends the intended human command,
// that a refused add stays actionable, or that a late response cannot repaint a different workspace.
function installExistingAgentFixture() {
  const w = window as any;
  const workspace = "11111111-1111-4111-8111-111111111111", other = "22222222-2222-4222-8222-222222222222";
  const owner = "33333333-3333-4333-8333-333333333333", agent = "44444444-4444-4444-8444-444444444444";
  const org = "55555555-5555-4555-8555-555555555555", recent = new Date().toISOString();
  const scenario = new URL(location.href).searchParams.get("case") ?? "success";
  document.documentElement.dataset.theme = new URL(location.href).searchParams.get("theme") ?? "dark";
  const user = { id: owner, aud: "authenticated", role: "authenticated", email: "synthetic@example.test",
    app_metadata: {}, user_metadata: {}, created_at: recent };
  const f = w.existingFixture = { workspace, other, owner, agent, scenario, commands: [] as any[], accountReads: 0,
    added: false, failRoster: false, held: false, release: null as null | (() => void), unexpected: [] as string[] };
  const network = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    if (url.origin === location.origin) return network(input, init);
    const body = request.method === "POST" ? await request.json().catch(() => null) : null;
    if (url.origin !== "https://api.test.invalid") { f.unexpected.push(url.origin + url.pathname); return Response.json({}, { status: 404 }); }
    if (url.pathname === "/auth/v1/user") return Response.json(user);
    if (url.pathname === "/rest/v1/workspaces") return Response.json([
      { workspace_id: workspace, org_id: org, name: "Home", archived_at: null },
      { workspace_id: other, org_id: org, name: "Studio", archived_at: null },
    ]);
    if (url.pathname === "/rest/v1/member_profiles") return Response.json([{ user_id: owner, display_name: "Synthetic owner", role: "owner" }]);
    if (url.pathname === "/rest/v1/account_agents") {
      f.accountReads++;
      if (scenario === "read-error" && f.accountReads === 1) return Response.json({ message: "synthetic read failure" }, { status: 503 });
      if (scenario === "stale-read") { f.held = true; await new Promise<void>(resolve => { f.release = resolve; }); }
      return Response.json([{ principal_id: agent, name: "Atlas Research & Long-Running Investigations", model: "Claude", transport: "hosted_mcp", revoked_at: null,
        workspaces: [{ workspace_id: other, workspace_name: "Studio", org_id: org, org_name: "Household", revoked_at: null, archived_at: null }] }]);
    }
    if (url.pathname === "/rest/v1/agent_principals") {
      if (f.failRoster) { f.failRoster = false; return Response.json({ message: "synthetic roster failure" }, { status: 503 }); }
      const target = url.searchParams.get("workspace_id");
      return Response.json(f.added && target === "eq." + workspace ? [{ principal_id: agent, name: "Atlas Research & Long-Running Investigations", model: "Claude",
        transport: "hosted_mcp", turn_only: true, owner_user_id: owner, revoked_at: null, workspace_id: workspace, created_at: recent }] : []);
    }
    if (url.pathname === "/functions/v1/command") {
      f.commands.push(body);
      if (body?.command?.kind !== "add_agent_to_workspace") return Response.json({ error: "unexpected_command" }, { status: 403 });
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

async function observeExistingAgent() {
  const f = (window as any).existingFixture;
  let stage = "boot";
  const one = <T extends Element>(selector: string) => document.querySelector<T>(selector);
  const visible = (node: Element | null) => !!node && !node.closest("[hidden]") && node.getClientRects().length > 0;
  const check = (value: unknown, message: string) => { if (!value) throw new Error(message); };
  const wait = async (name: string, predicate: () => unknown) => {
    stage = name;
    for (let i = 0; i < 250; i++) { if (predicate()) return; await fetch("/__observer-tick"); }
    throw new Error("timed out at " + name);
  };
  const notice = () => one<HTMLElement>("[data-ahp-existing-list] .workspace-agent-picker__notice")!;
  const add = () => one<HTMLButtonElement>("[data-ahp-existing-list] .pd-choice-add")!;
  const switchWorkspace = async () => {
    const menu = one<HTMLButtonElement>('button[aria-label="Open navigation"]');
    if (visible(menu)) menu!.click();
    one<HTMLElement>("[data-workspace-picker] summary")!.click();
    await wait("workspace choice", () => visible(one(`.cs-workspace-picker__item[value="${f.other}"]`)));
    one<HTMLButtonElement>(`.cs-workspace-picker__item[value="${f.other}"]`)!.click();
    await wait("new workspace", () => document.querySelector("live-dashboard")?.getAttribute("data-admin-workspace") === f.other);
  };
  try {
    await wait("Add an agent entry", () => visible(one("[data-add-agent]")));
    one<HTMLButtonElement>("[data-add-agent]")!.click(); // action 1, existing route navigation
    await wait("host picker", () => visible(one("[data-ahp-existing]")));
    one<HTMLButtonElement>("[data-ahp-existing]")!.click(); // action 2
    await wait("existing view", () => visible(one("[data-ahp-existing-view]")));
    if (f.scenario === "stale-read") {
      await wait("held directory", () => f.held);
      await switchWorkspace(); f.release(); await fetch("/__observer-tick");
      check(f.commands.length === 0 && !visible(one("[data-ahp-existing-view]")) && !add()
        && one<HTMLElement>("[data-ahp-existing-list]")?.dataset.agentPickerState === "loading", "a stale read painted the old picker");
    } else {
      if (f.scenario === "read-error") {
        await wait("directory retry", () => visible(one("[data-ahp-existing-list] .workspace-agent-picker__retry")));
        one<HTMLButtonElement>("[data-ahp-existing-list] .workspace-agent-picker__retry")!.click();
      }
      await wait("eligible identity", () => visible(add()));
      check(f.commands.length === 0, "opening the list submitted a command");
      const rect = add().getBoundingClientRect();
      check(rect.width >= 44 && rect.height >= 44, "Add target is under 44px");
      add().focus(); check(document.activeElement === add(), "Add is not keyboard focusable");
      add().click(); // action 3: the explicit human membership command
      if (f.scenario === "stale-write") {
        await wait("held add", () => f.held);
        await switchWorkspace(); f.release(); await fetch("/__observer-tick");
        check(!visible(one("[data-ahp-existing-view]")) && add().textContent !== "Added"
          && !notice().textContent?.includes("added."), "a stale accepted add painted the old picker");
      } else if (f.scenario === "refused") {
        await wait("refusal", () => notice().textContent?.includes("Couldn't add") && !add().disabled);
        check(!notice().textContent?.includes("added."), "a refusal claimed success");
      } else {
        await wait("added receipt", () => notice().textContent?.includes("added.") && add().textContent === "Added");
        if (f.scenario === "refresh-error") {
          await wait("refresh accepted add", () => notice().textContent?.includes("Couldn't refresh"));
          one<HTMLButtonElement>("[data-ahp-existing-list] .workspace-agent-picker__retry")!.click();
        }
        await wait("authoritative roster", () => !!one(`[data-kylon-agent="${f.agent}"], [data-home-agent="${f.agent}"], [data-rail-agent="${f.agent}"]`));
        check(f.commands.length === 1, "a roster retry resubmitted the add");
        check(!/reconnect|sign in again/i.test(notice().textContent ?? ""), "added copy asked for OAuth reconnection");
      }
      check(f.commands.length === 1 && f.commands[0].command.kind === "add_agent_to_workspace"
        && f.commands[0].command.principal_id === f.agent && f.commands[0].workspace_id === f.workspace,
        "wrong identity, workspace or command");
    }
    await document.fonts.ready;
    check(document.documentElement.scrollWidth <= innerWidth, "page overflow");
    check(f.unexpected.length === 0, "unexpected HTTP: " + f.unexpected.join(","));
    document.documentElement.dataset.existingObservation = JSON.stringify({ ok: true, scenario: f.scenario, commands: f.commands.length });
  } catch (error) {
    document.documentElement.dataset.existingObservation = JSON.stringify({ error: String(error), stage,
      notice: notice()?.textContent, view: document.querySelector("live-dashboard")?.getAttribute("data-channel-view"), commands: f.commands });
  }
}

test("existing agents: three real clicks add the selected identity; reads, refusals and stale results remain honest", { timeout: 180_000 }, async () => {
  const { markup, styles, bundled } = await renderAstroFixture(new URL("../app/LiveDashboard.astro", import.meta.url));
  const app = "<!doctype html><html><head><meta name='commonswarm:url' content='https://api.test.invalid'><meta name='commonswarm:anon-key' content='synthetic-public'><style>" +
    styles.join("\n") + "</style><script>" + await compileFixtureFunction(new URL(import.meta.url), "installExistingAgentFixture") + "</script></head><body>" + markup +
    "<script>" + await compileFixtureFunction(new URL(import.meta.url), "observeExistingAgent") + "</script></body></html>";
  const fonts = fileURLToPath(new URL("../../../public/fonts/", import.meta.url));
  const server = createServer((request, response) => {
    if (request.url === "/__observer-tick") { setTimeout(() => { response.writeHead(204); response.end(); }, 2); return; }
    if (request.url?.startsWith("/fonts/") && request.url.endsWith(".woff2")) {
      void readFile(join(fonts, basename(request.url))).then(data => { response.writeHead(200, { "Content-Type": "font/woff2" }); response.end(data); }, () => { response.writeHead(404); response.end(); }); return;
    }
    response.writeHead(200, { "Content-Type": request.url === "/app.js" ? "text/javascript" : "text/html" });
    response.end(request.url === "/app.js" ? bundled.join("\n") : app);
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address(); assert.ok(address && typeof address === "object");
    const evidence = join(process.cwd(), "../site-observer-evidence/existing-agent");
    await mkdir(evidence, { recursive: true });
    const outcomes: Record<string, unknown> = {}, chrome = await findChrome();
    const cases = ["success-390-light", "success-390-dark", "success-1440-light", "success-1440-dark",
      "read-error-390-dark", "refused-390-dark", "refresh-error-390-dark", "stale-read-1440-dark", "stale-write-1440-dark"];
    for (const entry of cases) {
      const [, scenario, size, theme] = entry.match(/^(.*)-(390|1440)-(light|dark)$/)!;
      const { stdout } = await launchChrome(chrome, [`--window-size=${size},${size === "390" ? 844 : 900}`, "--virtual-time-budget=60000", "--dump-dom",
        `--screenshot=${join(evidence, entry + ".png")}`,
        `http://127.0.0.1:${address.port}/app?w=11111111-1111-4111-8111-111111111111&case=${scenario}&theme=${theme}`],
        { timeout: 60000, maxBuffer: 12 * 1024 * 1024 });
      const raw = stdout.match(/data-existing-observation="([^"]*)"/)?.[1];
      outcomes[entry] = raw ? JSON.parse(raw.replaceAll("&quot;", '"').replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">")) : { error: "observer did not finish" };
    }
    assert.deepEqual(Object.entries(outcomes).filter(([, value]: [string, any]) => !value.ok), [], JSON.stringify(outcomes));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
