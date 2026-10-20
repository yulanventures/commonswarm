/** Real site DOM/transport proof with synthetic HTTP. Backend admission is owned by server suites. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { build, type Plugin } from "esbuild";
import ts from "typescript";
import { transform } from "@astrojs/compiler-rs";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { createServer } from "node:http";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { browserTest, findChrome, launchChrome } from "../../../tests/chrome.js";

// Authoring gate: these cases reach the real app's boot, roster, owner admission,
// mounts, refresh and reset through rendered DOM/events. Only HTTP responses are
// synthetic. They prove browser behavior and envelopes, never backend ownership,
// PostgreSQL persistence, audit, or role enforcement.
// Error rows protect response-specific copy and correction without a read; the
// credible regression is treating all 400s as unsupported or all refusals as
// unknown writes. This existing DOM/HTTP owner lacked those codes. No new seam.
// Rotation rows keep family editing/resume while rejecting an old token key target.
// Foreign queue rows must terminate loading; cross-family queue policy cannot replace Home.
// Home rows additionally own the real RPC -> rail -> agent-page policy summary.
// The roster-only settings rows cannot catch a successful overview dropping policy.
function installConnectionFixture() {
  const w = window as any;
  const scenario = new URL(location.href).searchParams.get("case") || "renewal";
  const hosted = scenario.startsWith("hosted");
  const home = scenario.startsWith("home-");
  const principal = "22222222-2222-4222-8222-222222222222";
  const owner = "33333333-3333-4333-8333-333333333333";
  const foreign = "44444444-4444-4444-8444-444444444444";
  const workspace = "11111111-1111-4111-8111-111111111111";
  const otherWorkspace = "55555555-5555-4555-8555-555555555555";
  const renewal = "66666666-6666-4666-8666-666666666666";
  const hostedId = "77777777-7777-4777-8777-777777777777";
  const recent = new Date(Date.now() - 60000).toISOString();
  const before = new Date(Date.now() - 86400000).toISOString();
  const user = { id: owner, aud: "authenticated", role: "authenticated",
    email: "synthetic@example.test", app_metadata: {}, user_metadata: {}, created_at: before };
  const grant: any = { renewal_grant_id: renewal, principal_id: principal,
    owner_user_id: ["foreign", "grant-foreign"].includes(scenario) ? foreign : owner, agent_name: "Synthetic assistant", model: null,
    kind: scenario === "bounded" || scenario === "legacy-permanent" ? "timeboxed" : "standing",
    horizon_expires_at: scenario === "bounded" || scenario === "legacy-permanent" ? before : null,
    bound_device_id: scenario === "unbound" ? null : "99999999-9999-4999-8999-999999999999", last_used_at: scenario === "unbound" ? null : recent,
    last_used_device_id: null, last_used_from: null, new_host_at: null,
    suspended_at: scenario === "suspended" || scenario === "ended-suspended" ? recent : null,
    revoked_at: null, token_id: "88888888-8888-4888-8888-888888888888",
    issued_at: before, token_expires_at: before, first_used_at: scenario === "unbound" ? null : recent,
    token_revoked_at: null, connection_expires_at: scenario.startsWith("ended") ? before : null, connection_expired_at: null };
  if (["unknown", "bounded"].includes(scenario)) { delete grant.connection_expires_at; delete grant.connection_expired_at; }
  if (scenario === "revoked" || scenario === "absent-home") grant.revoked_at = recent;
  if (scenario === "malformed") grant.connection_expired_at = "invalid";
  if (scenario === "dated") grant.connection_expires_at = "2034-01-01T00:00:00Z";
  if (scenario === "elapsed-fence") grant.connection_expired_at = before;
  if (scenario === "home-mismatch") { grant.renewal_grant_id = hostedId; grant.suspended_at = recent; grant.revoked_at = recent; grant.connection_expires_at = before; }
  if (scenario === "home-matched-ended" || ["renewal", "rotation"].includes(scenario)) grant.connection_expires_at = before;
  if (scenario === "rotation" || scenario === "rotation-suspended") { grant.token_revoked_at = recent; if (scenario === "rotation-suspended") grant.suspended_at = recent; }
  const connection = { grant_id: hostedId, client_id: "https://connector.example.test",
    home_workspace_id: workspace, selected_workspace_ids: [workspace],
    state: scenario === "hosted-pending" ? "pending" : "active", revoked_at: scenario === "hosted-revoked" ? recent : null,
    connection_expires_at: scenario === "hosted-ended" ? before : null, connection_expired_at: null };
  if (scenario === "hosted-unknown") { delete (connection as any).connection_expires_at; delete (connection as any).connection_expired_at; }
  if (scenario === "hosted-malformed") (connection as any).connection_expired_at = false;
  const f = w.connectionFixture = { scenario, hosted, principal, owner, foreign, workspace, otherWorkspace, renewal, hostedId,
    home, grant, connection, canonicalGrant: renewal, canonicalToken: ["rotation", "rotation-suspended"].includes(scenario) ? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" : grant.token_id, rotateFamily: false, requests: [] as any[], unexpected: [] as string[], holdRead: false,
    releaseRead: null as null | (() => void), failRead: false, mode: "accept", reads: 0, overviewReads: 0, readTargets: [] as string[] };
  const network = window.fetch.bind(window);
  const policyRead = async (target: string) => {
    f.reads++; f.readTargets.push(target);
    if (f.holdRead) await new Promise<void>(resolve => { f.releaseRead = resolve; });
    if (f.failRead) throw new Error("synthetic read loss");
  };
  window.fetch = async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    if (url.origin === location.origin) return network(input, init);
    const body = request.method === "POST" ? await request.json() : null;
    f.requests.push({ path: url.pathname, body });
    if (url.origin === "https://api.test.invalid") {
      if (url.pathname === "/auth/v1/user") return Response.json(user);
      if (url.pathname === "/auth/v1/logout") return new Response(null, { status: 204 });
      if (url.pathname === "/functions/v1/read") {
        if (body.resource === "renewal_grants") { await policyRead("renewal"); return Response.json({ grants: home && !["home-mismatch", "home-matched-ended"].includes(scenario) ? [] : [f.grant] }); }
        if (body.resource === "pending_access") return Response.json({ pending: [], agents: [] });
      }
      if (url.pathname === "/functions/v1/command") {
        const c = body.command;
        if (c.kind === "set_connection_expiry") {
          if (f.mode === "lost") throw new Error("synthetic command loss");
          if (f.mode === "invalid-date") return Response.json({ error: "invalid_connection_expiry" }, { status: 400 });
          if (f.mode === "invalid-request") return Response.json({ error: "invalid_request" }, { status: 400 });
          if (f.mode === "unavailable") return Response.json({ error: "invalid_command" }, { status: 400 });
          if (f.mode === "unknown-400") return Response.json({ error: "unrecognized" }, { status: 400 });
          if (f.mode === "empty-400") return new Response(null, { status: 400 });
          if (f.mode === "empty-200") return new Response(null, { status: 200 });
          if (f.mode === "http-unavailable") return new Response(null, { status: 501 });
          if (f.mode === "deny") return Response.json({ error: "forbidden" }, { status: 403 });
          (c.connection_kind === "hosted" ? f.connection : f.grant).connection_expires_at = c.connection_expires_at;
          if (f.rotateFamily) {
            f.rotateFamily = false;
            f.grant = { ...f.grant, renewal_grant_id: hostedId, token_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", connection_expires_at: null };
            f.canonicalGrant = hostedId; f.canonicalToken = f.grant.token_id;
          }
          return Response.json({ status: "accepted", ok: true });
        }
        if (c.kind === "revoke_agent_token") { f.grant.token_revoked_at = recent; return Response.json({ status: "accepted" }); }
        if (c.kind === "resume_renewal_grant") { f.grant.suspended_at = null; return Response.json({ status: "accepted" }); }
        if (c.kind === "household_access") return Response.json({ status: "ok", content_role: null });
        if (home && c.kind === "household_tool" && c.tool === "todo_queue") return Response.json({ status: "ok", queue: {
          workspace_id: scenario === "home-queue-workspace" ? otherWorkspace : workspace,
          principal_id: scenario === "home-queue-principal" ? foreign : principal,
          owner_user_id: scenario === "home-queue-owner" ? foreign : owner, read_at: new Date().toISOString(),
          accepts_from: "owner", content_access: "none", working: [], up_next: [], not_yet: [], requests: [],
          next_offset: { working: null, up_next: null, not_yet: null, requests: null },
          // Different queue family/policy/key state must not replace canonical Home truth.
          status: { work: scenario === "home-ended" ? "disconnected" : "idle", facts: { transport: "local", turn_only: false,
            connection: scenario === "home-queue-removed" ? "removed" : scenario === "home-queue-off" ? "connection_off" : scenario === "home-permanent" ? "key_ended" : scenario === "home-ended" ? "key_ended" : scenario === "home-paused" ? "paused" : scenario === "home-key-off" ? "key_off" : "live",
            renewal_grant_id: hostedId, token_id: foreign, connection_expires_at: before, connection_expired_at: before,
            last_activity_at: recent, messages_waiting_since: null, doing: null, working_on: null } }
        } });
        if (c.kind === "household_tool") return Response.json({ status: "refused", reason: "content_consent_required" });
        if (c.kind === "todo_list") return Response.json({ status: "ok", todos: [], next_offset: null });
        // Read-only activity/queue requests have no write effects in this UI fixture.
      }
      if (url.pathname === "/rest/v1/rpc/home_overview") {
        if (scenario === "absent-home") return Response.json({ error: "unavailable" }, { status: 503 });
        f.overviewReads++;
        const status = { work: "idle", facts: { renewal_grant_id: scenario === "home-legacy" ? null : f.canonicalGrant, token_id: f.canonicalToken, transport: hosted ? "hosted_mcp" : "local", turn_only: hosted,
          connection: scenario === "key-ended" ? "key_ended" : scenario === "connection-off" ? "connection_off" : scenario === "removed" ? "removed" : scenario === "suspended" ? "paused" : "live",
          last_activity_at: recent, messages_waiting_since: null, doing: null, working_on: null,
          ...(Object.hasOwn(f.grant, "connection_expires_at") ? { connection_expires_at: f.grant.connection_expires_at } : {}),
          ...(Object.hasOwn(f.grant, "connection_expired_at") ? { connection_expired_at: f.grant.connection_expired_at } : {}) } };
        // Existing People rows separate stale roster dates from canonical permanent Home.
        if (["renewal", "rotation"].includes(scenario) && f.grant.connection_expires_at === before) status.facts.connection_expires_at = null;
        if (home) {
          const facts = status.facts as any;
          facts.connection = scenario === "home-ended" ? "key_ended" : scenario === "home-paused" ? "paused"
            : scenario === "home-removed" ? "removed" : scenario === "home-key-off" ? "key_off" : "live";
          if (scenario === "home-unknown") { delete facts.connection_expires_at; delete facts.connection_expired_at; }
          if (scenario !== "home-unknown") {
            facts.connection_expires_at = scenario === "home-ended" ? before : scenario === "home-dated" ? "2034-01-01T00:00:00+00:00" : null;
            facts.connection_expired_at = scenario === "home-ended" ? before : ["home-malformed", "home-matched-ended"].includes(scenario) ? "invalid" : null;
          }
          status.work = facts.connection === "live" ? "idle" : "disconnected";
        }
        return Response.json({ viewer_user_id: owner, generated_at: home ? new Date().toISOString() : recent, workspaces: [{
          workspace_id: workspace, name: "Home", role: "owner", last_seen_at: recent, new_messages: 0,
          content: null, people: [{ user_id: owner, display_name: "Synthetic owner", role: "owner", is_viewer: true,
            agents: [{ principal_id: principal, name: "Synthetic assistant", status, queue: null }] }],
          needs_you: { asks: [], assigned: [], waiting: [] } }] });
      }
      if (url.pathname === "/rest/v1/workspaces") return Response.json([{ workspace_id: workspace, name: "Home", archived_at: null }, { workspace_id: otherWorkspace, name: "Trip", archived_at: null }]);
      if (url.pathname === "/rest/v1/member_profiles") return Response.json([
        { user_id: owner, display_name: "Synthetic owner", role: scenario === "foreign" ? "member" : "owner" },
        { user_id: foreign, display_name: "Other owner", role: "member" }]);
      if (url.pathname === "/rest/v1/agent_principals") return Response.json(
        url.searchParams.get("revoked_at")?.startsWith("not.") ? [] : [{ principal_id: principal, name: "Synthetic assistant",
          model: null, transport: hosted ? "hosted_mcp" : "local", turn_only: hosted, owner_user_id: ["foreign", "principal-foreign"].includes(scenario) ? foreign : owner,
          revoked_at: null, workspace_id: workspace, created_at: before }]);
      if (url.pathname === "/rest/v1/hosted_mcp_connections") { await policyRead("hosted"); return Response.json([f.connection]); }
      if (["agent_presence", "agent_wake_path", "pending_invitations", "files", "channels", "signals", "hosted_mcp_seats", "my_devices"]
        .some(table => url.pathname === "/rest/v1/" + table)) return Response.json([]);
    }
    // Ancillary Home reads may refuse; unexpected writes and settings reads may not hide here.
    if (url.pathname === "/functions/v1/command" && ["home_overview", "agent_queue", "todo_activity", "todo_list", "workspace_seen", "signals_seen"].includes(body.command?.kind))
      return Response.json({ status: "refused", reason: "content_consent_required" });
    f.unexpected.push(request.method + " " + url.pathname);
    return Response.json({ error: "unexpected_fixture_request" }, { status: 404 });
  };
  localStorage.setItem("sb-api-auth-token", JSON.stringify({ access_token: "synthetic-human",
    refresh_token: "synthetic-refresh", token_type: "bearer", expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600, user }));
}

async function observeConnectionApp() {
  const w = window as any, f = w.connectionFixture;
  const one = (selector: string): any => document.querySelector(selector);
  const assert = (value: unknown, message: string) => { if (!value) throw new Error(f.scenario + ": " + message); };
  const tick = () => fetch("/__observer-tick");
  const wait = async (predicate: () => unknown, name: string) => {
    for (let i = 0; i < 250; i++) { if (predicate()) return; await tick(); }
    throw new Error(f.scenario + ": timed out at " + name + "; " + one("live-dashboard")?.dataset.state + "; " + document.body.textContent?.slice(-500));
  };
  const commands = () => f.requests.filter((r: any) => r.path === "/functions/v1/command").map((r: any) => r.body);
  const writes = () => commands().filter((r: any) => ["set_connection_expiry", "revoke_agent_token", "resume_renewal_grant"].includes(r.command.kind));
  const visible = (node: any) => node && !node.hidden && node.getClientRects().length > 0;
  const clickText = (text: string, root: ParentNode = document) => {
    const button = Array.from(root.querySelectorAll("button")).find(node => node.textContent?.trim() === text);
    assert(button, "missing button " + text); button!.click();
  };
  try {
    if (f.home) {
      await wait(() => f.overviewReads > 0 && one("[data-home-catchup]")?.textContent.includes("Home"), "successful Home RPC");
      if (["home-queue-workspace", "home-queue-principal", "home-queue-owner"].includes(f.scenario)) {
        await wait(() => one('[data-rail-agent="' + f.principal + '"]'), "queue mismatch agent");
        one('[data-rail-agent="' + f.principal + '"]').click();
        await wait(() => one("[data-home-route-pane]")?.textContent.includes("Could not load"), "queue failure recovery");
        assert(!one("[data-home-route-pane]").textContent.includes("Checking the line"), "foreign queue stayed pending");
      } else if (f.scenario === "home-removed") {
        await wait(() => one('[data-home-catchup] [data-workspace-id="' + f.workspace + '"] .hm-catchup-card-body'), "removed overview rendered");
        assert(!one('[data-rail-agent="' + f.principal + '"]'), "removed principal stayed in Home roster");
      } else {
        await wait(() => one('[data-rail-agent="' + f.principal + '"]'), "Home overview agent row");
        assert(f.reads === 0, "successful Catch up unnecessarily fetched renewal metadata");
        one('[data-rail-agent="' + f.principal + '"]').click();
        await wait(() => one("[data-home-route-pane] [data-connection-end-date]"), "normal Home agent summary");
        const pane = one("[data-home-route-pane]"), summary = () => pane.querySelector("[data-connection-end-date]");
        const expected = ["home-permanent", "home-mismatch"].includes(f.scenario) ? "Stays connected until you remove it"
          : f.scenario === "home-dated" ? "Connection ends"
          : ["home-ended", "home-matched-ended"].includes(f.scenario) ? "Connection ended" : "Connection settings are managed by the server.";
        await wait(() => summary()?.textContent.includes(expected) && f.requests.some((r: any) => r.body?.command?.tool === "todo_queue") &&
          !pane.textContent.includes("Checking the line"), "canonical Home policy after queue read");
        assert(!visible(summary().querySelector("form")), "overview invented an editable family identity");
        if (["home-ended", "home-matched-ended"].includes(f.scenario)) {
          assert(pane.textContent.includes("This connection cannot be resumed."), "elapsed owner date lost its terminal reason");
          assert(!Array.from(pane.querySelectorAll("button")).some((b: any) => /new key|resume/i.test(b.textContent)), "ended Home offered recovery");
        }
        if (f.scenario === "home-permanent") assert(!pane.textContent.includes("Key ended") && !pane.textContent.includes("Connection ended"), "queue overrode canonical family");
        if (f.scenario === "home-queue-removed") assert(pane.textContent.includes("Removed"), "queue removal lost precedence");
        if (f.scenario === "home-queue-off") assert(pane.textContent.includes("Connection turned off"), "queue connection-off lost precedence");
        if (f.scenario === "home-paused") assert(pane.textContent.includes("Access suspended"), "suspension lost precedence");
        if (f.scenario === "home-key-off") assert(pane.textContent.includes("Key turned off"), "revocation lost precedence");
      }
      assert(writes().length === 0 && f.unexpected.length === 0, "Home mount wrote or used unexpected HTTP");
      document.documentElement.dataset.connectionObservation = JSON.stringify({ scenario: f.scenario, writes: writes(), reads: f.reads });
      return;
    }
    await wait(() => one("live-dashboard")?.dataset.state === "channel" && one("#pd-agent-" + f.principal), "real People route");
    one("#pd-agent-" + f.principal).click();
    await wait(() => one("[data-people-detail] h2"), "real agent selection");
    if (f.hosted) {
      one("[data-connected-apps-open]").click();
      await wait(() => one("[data-connected-apps-dialog]").open && one("[data-connected-apps-list] [data-connection-end-date]"), "hosted mount");
    } else await wait(() => one("[data-people-detail] [data-connection-end-date]"), "renewal mount");
    const rootSelector = f.hosted ? "[data-connected-apps-list]" : "[data-people-detail]";
    const editor = () => one(rootSelector + " [data-connection-end-date]");
    const form = () => editor().querySelector("form") as HTMLFormElement;
    const field = (selector: string): any => editor().querySelector(selector);
    const notice = () => editor().querySelector('[role="status"]').textContent;
    assert(writes().length === 0, "mount wrote a command");
    if (!form()) {
      assert(["foreign", "grant-foreign", "principal-foreign", "absent-home"].includes(f.scenario), "missing admitted editor");
      if (f.scenario === "absent-home") {
        assert(one("[data-people-detail]").textContent.includes("Key turned off"), "roster revocation vanished without Home");
        assert(!editor().textContent.includes("Stays connected until you remove it"), "absent Home invented permanence");
      }
      assert(!editor().querySelector("[data-end-date-save]"), "foreign family exposed a save control");
      assert(writes().length === 0 && f.unexpected.length === 0, "foreign family sent a write");
      document.documentElement.dataset.connectionObservation = JSON.stringify({ scenario: f.scenario, writes: writes(), reads: f.reads });
      return;
    }
    const editable = ["renewal", "hosted", "dated", "legacy-permanent", "confirmation", "session-reset", "stale-family", "rotation"].includes(f.scenario);
    await wait(() => f.overviewReads > 0 && visible(form()) === editable, "owner/live/policy mount admission");
    if (["unknown", "malformed", "hosted-unknown", "hosted-malformed", "key-ended", "connection-off", "removed", "unbound"].includes(f.scenario))
      assert(!editor().textContent.includes("Stays connected until you remove it"), "unknown or terminal promised permanence");
    if (["ended", "elapsed-fence", "hosted-ended"].includes(f.scenario))
      assert(editor().textContent.includes("Connection ended"), "terminal policy not shown");
    if (["rotation", "rotation-suspended"].includes(f.scenario)) assert(!one("[data-people-detail] [data-revoke-grant]"), "old token supplied a key mutation target");
    if (["renewal", "rotation"].includes(f.scenario)) {
      const detail = one("[data-people-detail]");
      assert(editor().textContent.includes("Stays connected until you remove it") && !field("[data-end-date-toggle]").checked, "stale roster replaced permanent Home policy");
      assert(!detail.textContent.includes("ENDED") && detail.textContent.includes("Uses a key to connect."), "stale roster ended an active connection");
      assert(detail.textContent.includes("Last used:") && !detail.textContent.includes("Last used: never"), "family Last used vanished after rotation");
      if (f.scenario === "renewal") {
        assert(one("[data-people-detail] [data-revoke-grant]"), "stale roster removed a live key action");
        assert(detail.textContent.includes("Key ID: " + f.grant.token_id), "matching key ID is not the actual token");
      } else assert(!detail.textContent.includes("Key ID:"), "rotated family mislabeled an old token as the key");
    }
    if (f.scenario === "confirmation") {
      const turnOff = one("[data-people-detail] [data-revoke-grant]");
      assert(turnOff, "live key has no turn-off action");
      turnOff.click();
      await wait(() => one("[data-people-confirm]").open, "native key confirmation");
      assert(writes().length === 0, "turn-off bypassed confirmation");
      clickText("Go back", one("[data-people-confirm]"));
      assert(writes().length === 0, "cancel revoked the key");
      turnOff.click();
      const confirm = one("[data-people-confirm]");
      const accept = Array.from(confirm.querySelectorAll("button")).find((button: any) => button.textContent.trim() !== "Go back") as HTMLButtonElement;
      assert(accept, "missing confirmation action"); accept.click();
      await wait(() => writes().length === 1, "confirmed key turn-off");
      assert(writes()[0].command.kind === "revoke_agent_token" && writes()[0].command.token_id === f.grant.token_id, "confirmation used wrong token");
    } else if (!editable) {
      // Mark a genuine draft dirty so refusal reaches owner/liveness admission,
      // rather than passing only because the no-change guard returned early.
      field("[data-end-date-toggle]").checked = true;
      field("[data-end-date-toggle]").dispatchEvent(new Event("change"));
      field("[data-end-date-value]").value = "2035-02-03T04:05";
      field("[data-end-date-value]").dispatchEvent(new Event("input"));
      form().dispatchEvent(new Event("submit", { cancelable: true }));
      assert(writes().length === 0, "hidden or terminal control sent a write");
      if (f.scenario === "suspended" || f.scenario === "rotation-suspended") {
        clickText("Resume", one("[data-people-detail]"));
        await wait(() => writes().some((r: any) => r.command.kind === "resume_renewal_grant"), "manual resume");
        assert(writes()[0].command.renewal_grant_id === f.renewal, "resume used wrong family");
      }
      if (["ended", "ended-suspended", "elapsed-fence", "revoked"].includes(f.scenario)) {
        assert(!Array.from(one("[data-people-detail]").querySelectorAll("button")).some((b: any) => b.textContent.trim() === "Resume"), "terminal could resume");
        assert(!one("[data-people-detail] [data-revoke-grant]"), "known terminal still has a live key");
      }
    } else {
      assert(field("[data-end-date-toggle]").checked === (f.scenario === "dated"), "default/chosen end date state");
      if (f.scenario === "dated") {
        assert(editor().textContent.includes("Connection ends"), "chosen date missing");
        field("[data-end-date-toggle]").click(); form().requestSubmit();
        await wait(() => notice() === "End date is off.", "initial chosen date clear");
        f.requests = [];
      }
      const edit = () => {
        field("[data-end-date-toggle]").click(); field("[data-end-date-value]").value = "2035-02-03T04:05";
        field("[data-end-date-value]").dispatchEvent(new Event("input"));
      };
      edit();
      // A real rerender (selecting the same agent again, or reopening the dialog) must retain the draft.
      if (f.hosted) { one("[data-connected-apps-close]").click(); one("[data-connected-apps-open]").click(); }
      else one("#pd-agent-" + f.principal).click();
      await wait(() => field("[data-end-date-value]")?.value === "2035-02-03T04:05", "draft across reread/rerender");
      if (f.scenario === "stale-family") {
        const oldForm = form(), oldEditor = editor();
        const original = f.grant.renewal_grant_id;
        f.rotateFamily = true;
        // Save still names the original grant. Its normal follow-up reads select another family.
        oldForm.requestSubmit();
        await wait(() => f.reads > 1 && !visible(oldForm), "canonical family changed after save");
        assert(writes().length === 1 && writes()[0].command.grant_id === original, "draft retargeted its write");
        assert(!oldEditor.textContent.includes("End date saved."), "different family confirmed original save");
        oldForm.dispatchEvent(new Event("submit", { cancelable: true }));
        one("#pd-agent-" + f.principal).click();
        assert(writes().length === 1, "stale draft saved to replacement family");
        assert(!visible(form()) || field("[data-end-date-value]").value !== "2035-02-03T04:05", "replacement inherited old draft");
        document.documentElement.dataset.connectionObservation = JSON.stringify({ scenario: f.scenario, writes: writes(), reads: f.reads });
        return;
      }
      f.holdRead = true; form().requestSubmit();
      await wait(() => f.releaseRead, "save follow-up read");
      assert(!/saved\./.test(notice()), "success preceded the follow-up HTTP response");
      f.holdRead = false; f.releaseRead(); f.releaseRead = null;
      await wait(() => notice() === "End date saved.", "save receipt");
      assert(document.activeElement === field("[data-end-date-toggle]"), "save lost focus");
      field("[data-end-date-value]").value = "2036-03-04T05:06";
      field("[data-end-date-value]").dispatchEvent(new Event("input"));
      form().requestSubmit();
      await wait(() => notice() === "End date saved.", "extend receipt");
      field("[data-end-date-toggle]").click(); form().requestSubmit();
      await wait(() => notice() === "End date is off.", "clear receipt");
      const expectedKind = f.hosted ? "hosted" : "renewal", expectedId = f.hosted ? f.hostedId : f.renewal;
      const sent = writes();
      assert(sent.length === 3 && sent.every((r: any) => r.workspace_id === f.workspace && r.command.connection_kind === expectedKind && r.command.grant_id === expectedId), "wrong workspace or family identity");
      assert(sent[2].command.connection_expires_at === null, "clear must send explicit NULL");
      assert(Date.parse(sent[0].command.connection_expires_at) === new Date("2035-02-03T04:05").getTime(), "local time conversion");
      f.mode = "deny"; edit(); form().requestSubmit();
      await wait(() => /not confirmed/.test(notice()), "refusal reread");
      assert(f.grant.connection_expires_at === null && f.connection.connection_expires_at === null, "refusal changed fixture state");
      for (const row of [
        { mode: "invalid-date", copy: "Choose a future end date after the server's current time. Nothing was changed." },
        { mode: "invalid-request", copy: "The server rejected this end date request. Nothing was changed." },
        { mode: "unavailable", copy: "End date settings are unavailable on this server. Nothing was changed." },
      ]) {
        // This date passes the actual client's clock check; the server can be ahead.
        const reads = f.reads, count = writes().length;
        f.mode = row.mode; f.failRead = true; form().requestSubmit();
        await wait(() => notice() === row.copy, row.mode + " validation refusal");
        assert(writes().length === count + 1, row.mode + " did not reach command HTTP");
        assert(f.reads === reads, row.mode + " required an unnecessary policy read");
        assert(f.grant.connection_expires_at === null && f.connection.connection_expires_at === null, row.mode + " changed saved state");
        assert(editor().textContent.includes("Stays connected until you remove it"), row.mode + " changed canonical summary");
        assert(!field("[data-end-date-save]").disabled && !field("[data-end-date-value]").disabled &&
          !visible(field("[data-end-date-check]")), row.mode + " blocked correction on a read-only Check");
        assert(field("[data-end-date-value]").value === "2035-02-03T04:05", row.mode + " discarded the draft");
      }
      f.failRead = false;
      // Empty bodies and unrecognized HTTP errors do not prove a no-write validation refusal.
      for (const mode of ["unknown-400", "empty-400", "empty-200", "http-unavailable"]) {
        const reads = f.reads, count = writes().length;
        f.mode = mode; f.failRead = true; form().requestSubmit();
        await wait(() => /result is unknown/.test(notice()), mode + " unknown outcome");
        assert(f.reads > reads && writes().length === count + 1, mode + " skipped canonical reconciliation");
        assert(field("[data-end-date-save]").disabled && field("[data-end-date-value]").disabled &&
          visible(field("[data-end-date-check]")), mode + " permits editing before a check");
        form().dispatchEvent(new Event("submit", { cancelable: true }));
        assert(writes().length === count + 1, mode + " retried an unknown write");
        f.failRead = false; field("[data-end-date-check]").click();
        await wait(() => /settings checked/.test(notice()), mode + " read-only reconciliation");
        assert(writes().length === count + 1, mode + " check wrote a command");
      }
      f.mode = "lost"; f.failRead = true; form().requestSubmit();
      await wait(() => /result is unknown/.test(notice()), "unknown outcome");
      const count = writes().length;
      assert(field("[data-end-date-save]").disabled, "unknown outcome allows resend");
      f.failRead = false; field("[data-end-date-check]").click();
      await wait(() => /settings checked/.test(notice()), "read-only reconciliation");
      assert(writes().length === count, "check duplicated a command");
      // A retained old form must obey its real session/scope guard.
      const stale = form();
      if (f.scenario === "session-reset") {
        const signout = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-signout]")).find(visible);
        assert(signout, "normal account Sign out missing"); signout!.click();
        await wait(() => one("live-dashboard").dataset.state === "signed-out", "real auth reset");
        stale.dispatchEvent(new Event("submit", { cancelable: true }));
        assert(writes().length === count, "retained form wrote after session reset");
        assert(!one("[data-home-route-pane] [data-connection-end-date]"), "reset retained owner's editor");
      } else {
      if (f.hosted) one("[data-connected-apps-close]").click();
      const next = Array.from(document.querySelectorAll<HTMLAnchorElement>("a")).find(a => new URL(a.href).searchParams.get("w") === f.otherWorkspace);
      assert(next, "normal workspace link missing"); next!.click();
      await wait(() => one("live-dashboard").dataset.adminWorkspace === f.otherWorkspace, "workspace change");
      stale.dispatchEvent(new Event("submit", { cancelable: true }));
      if (f.hosted) {
        // Hosted settings belong to the account's returned home workspace, even
        // when a different workspace is open. This is the paired identity control.
        await wait(() => writes().length === count + 1, "account-level hosted setting");
        assert(writes()[count].workspace_id === f.workspace && writes()[count].command.grant_id === f.hostedId, "hosted command followed active workspace");
      } else assert(writes().length === count, "stale renewal form wrote after workspace change");
      }
    }
    assert(f.unexpected.length === 0, "unexpected HTTP: " + f.unexpected.join(", "));
    const forbidden = commands().filter((r: any) => ["mint_agent_token", "create_agent_principal", "register_device"].includes(r.command.kind));
    assert(forbidden.length === 0, "settings reminted or registered");
    document.documentElement.dataset.connectionObservation = JSON.stringify({ scenario: f.scenario, writes: writes(), reads: f.reads });
  } catch (error) {
    document.documentElement.dataset.connectionObservation = JSON.stringify({ error: String(error), unexpected: f.unexpected });
  }
}

browserTest("real app mounts enforce end-date identity, lifecycle and owner admission through HTTP", { timeout: 180000, skip: process.platform === "darwin" }, async () => {
  const component = fileURLToPath(new URL("./LiveDashboard.astro", import.meta.url));
  const scripts = new Map<string, string[]>(), styles: string[] = [];
  const compiler: Plugin = { name: "existing-astro-container", setup(builder) {
    builder.onLoad({ filter: /\.astro$/ }, async args => {
      const compiled = transform(await readFile(args.path, "utf8"), { filename: args.path,
        internalURL: "astro/compiler-runtime", resultScopedSlot: true, resolvePath: specifier => specifier });
      assert.deepEqual(compiled.diagnostics.filter(d => d.severity === "error"), []);
      scripts.set(args.path, compiled.scripts.map(s => s.code).filter((code): code is string => typeof code === "string"));
      styles.push(...compiled.css);
      return { contents: compiled.code.replace(/import "[^"\n]+\?astro&type=style[^"\n]+";\n/gu, ""), loader: "ts", resolveDir: dirname(args.path) };
    });
    builder.onLoad({ filter: /\.css$/ }, async args => { styles.push(await readFile(args.path, "utf8")); return { contents: "", loader: "js" }; });
  } };
  const rendered = await build({ entryPoints: [component], bundle: true, write: false, format: "esm", platform: "node",
    plugins: [compiler], external: ["astro/compiler-runtime"], define: { "import.meta.env": "{}" } });
  const code = rendered.outputFiles[0]!.text.replaceAll('"astro/compiler-runtime"',
    JSON.stringify(new URL("../../../node_modules/astro/dist/runtime/compiler/index.js", import.meta.url).href));
  const module = await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
  const container = await AstroContainer.create({ resolve: async () => "/app.js" });
  const markup = await container.renderToString(module.default);
  const bundled: string[] = [];
  for (const [path, contents] of scripts) for (const content of contents) {
    bundled.push((await build({ stdin: { contents: content, loader: "ts", resolveDir: dirname(path) }, bundle: true, write: false,
      format: "iife", platform: "browser", define: { "import.meta.env": JSON.stringify({ PUBLIC_H0_LINK_JOIN: "0" }) } })).outputFiles[0]!.text);
  }
  const scenarios = ["absent-home", "rotation", "rotation-suspended", "home-queue-workspace", "home-queue-principal", "home-queue-owner", "home-queue-removed", "home-queue-off", "home-legacy", "home-mismatch", "home-matched-ended", "stale-family", "home-permanent", "home-dated", "home-ended", "home-unknown", "home-malformed", "home-paused", "home-removed", "home-key-off", "renewal", "hosted", "confirmation", "session-reset", "legacy-permanent", "foreign", "grant-foreign", "principal-foreign", "unbound", "unknown", "malformed", "dated", "elapsed-fence", "key-ended", "connection-off", "removed", "ended", "ended-suspended", "bounded", "revoked", "suspended", "hosted-pending", "hosted-ended", "hosted-revoked", "hosted-unknown", "hosted-malformed"];
  // Compile our own fixture functions from their authored source, avoiding
  // transpiler-generated closure helpers in Function.toString().
  const testSource = await readFile(new URL(import.meta.url), "utf8");
  const ast = ts.createSourceFile("fixture.ts", testSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const fixtureFunction = (name: string) => {
    const found = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.ok(found, "test fixture function " + name); return found.getText(ast);
  };
  const compileFixture = async (name: string) => (await build({ stdin: {
    contents: fixtureFunction(name) + "\nvoid " + name + "();", loader: "ts", resolveDir: dirname(component) },
    bundle: true, write: false, platform: "browser", format: "iife" })).outputFiles[0]!.text;
  const setup = "<script>" + await compileFixture("installConnectionFixture") + "</script>";
  const observationCode = await compileFixture("observeConnectionApp");
  const observation = "<script>" + observationCode + "</script>";
  const app = "<!doctype html><html><head><meta name='commonswarm:url' content='https://api.test.invalid'><meta name='commonswarm:anon-key' content='synthetic-public'><style>" +
    styles.join("\n") + "</style>" + setup + "</head><body>" + markup + observation + "</body></html>";
  const parent = "<!doctype html><html><body><script>(async()=>{ const results=[]; for(const scenario of " + JSON.stringify(scenarios) +
    "){ const frame=document.createElement('iframe'); frame.style.width=results.length%2?'390px':'1280px'; frame.style.height='900px'; frame.src='/app?v='+(scenario.startsWith('home-')?'catchup':'people&w=11111111-1111-4111-8111-111111111111')+'&case='+scenario; document.body.append(frame);" +
    "for(let i=0;i<1000;i++){const value=frame.contentDocument?.documentElement.dataset.connectionObservation;if(value){results.push(JSON.parse(value));break;}await fetch('/__observer-tick');}" +
    "frame.remove();if(results.at(-1)?.scenario!==scenario||results.at(-1)?.error)break;}document.documentElement.dataset.endDateObservation=btoa(JSON.stringify(results));})();</script></body></html>";
  const server = createServer((request, response) => {
    if (request.url === "/__observer-tick") { setTimeout(() => { response.writeHead(204); response.end(); }, 10); return; }
    response.writeHead(200, { "Content-Type": request.url === "/app.js" ? "text/javascript" : "text/html" });
    response.end(request.url === "/app.js" ? bundled.join("\n") : request.url?.startsWith("/app?") ? app : parent);
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address(); assert.ok(address && typeof address === "object");
    const { stdout } = await launchChrome(await findChrome(), ["--virtual-time-budget=120000", "--dump-dom", "http://127.0.0.1:" + address.port + "/"],
      { timeout: 150000, maxBuffer: 10 * 1024 * 1024 });
    const encoded = stdout.match(/data-end-date-observation="([A-Za-z0-9+/=]+)"/)?.[1];
    assert.ok(encoded, "normal rendered app must finish the browser observations");
    const results = JSON.parse(Buffer.from(encoded, "base64").toString());
    assert.equal(results.find((row: any) => row.error), undefined, JSON.stringify(results));
    assert.deepEqual(results.map((row: any) => row.scenario), scenarios);
  } finally {
    if (server.listening) { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  }
});
