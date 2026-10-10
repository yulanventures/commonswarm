/** CI only: shared headless launcher, fresh profile, no installed Chrome app. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, mkdtemp, realpath } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { browserTest as test } from "../../../tests/chrome.js";
import { build } from "esbuild";
import { fixture, policy } from "./admin-delegations.fixture.js";
import { findChrome, launchChrome } from "../../../tests/chrome.js";

test("admin account view keeps hostile labels inert and reuses an uncertain revoke request", { skip: process.platform === "darwin", timeout: 90000 }, async () => {
  const component = fileURLToPath(new URL("./AdminDelegations.astro", import.meta.url));
  const source = await readFile(component, "utf8");
  const script = source.split("<script>")[1]?.split("</script>")[0]; assert.ok(script);
  const bundleScript = async (contents: string) => (await build({
    stdin: { contents, loader: "ts", resolveDir: dirname(component) }, bundle: true, write: false,
    format: "iife", platform: "browser", define: { "import.meta.env": JSON.stringify({ PUBLIC_SUPABASE_URL: "https://api.test.invalid", PUBLIC_SUPABASE_ANON_KEY: "synthetic-public-key" }) },
  })).outputFiles[0]!.text;
  const bundle = await bundleScript(script);
  const menu = await bundleScript(`import { buildWorkspaceMenu } from "../../lib/home-shell";
    document.body.append(buildWorkspaceMenu(document, {
      sample: false, workspaceId: "W", name: "Home", people: [], pane: "chat",
      hrefs: { chat: "/app", todos: "/app", lists: "/app", files: "/app", wiki: "/app", workspaces: "/app" },
      menu: { settings: true, adminAccess: true },
    }, { openPeople() {}, menu() {} }, "hm-ws"));`);
  const signOut = await bundleScript('import { client } from "../../lib/commonswarm"; void client()!.auth.signOut({ scope: "local" });');
  const id = "11111111-1111-4111-8111-111111111111", time = new Date(Date.now() + 86400000).toISOString();
  const user = { id, aud: "authenticated", role: "authenticated", email: "synthetic@example.test", app_metadata: {}, user_metadata: {}, created_at: time };
  const grant = fixture.grants[0]!, action = fixture.actions[0]!;
  // Mock only the HTTP boundary. The component, auth client and revoke helper are real.
  const setup = `<script>
    const user = ${JSON.stringify(user)}, grant = ${JSON.stringify(grant)}, action = ${JSON.stringify(action)}, fixture = ${JSON.stringify(fixture)};
    let revoked = false, approvalWithdrawn = false, metadataChanged = false, reapproved = false, foreignProjection = false;
    window.adminFixtureChangeMetadata = () => { metadataChanged = true; };
    window.adminFixtureForeignProjection = () => { foreignProjection = true; };
    const requests = [];
    window.fetch = async (input, init) => {
      const request = new Request(input, init);
      if (request.url.endsWith("/auth/v1/user")) return Response.json(user);
      if (request.url.includes("/auth/v1/logout")) return new Response(null, { status: 204 });
      if (request.url === "https://mcp.commonswarm.com/admin/gate") return Response.json({ state: "closed" });
      if (!request.url.startsWith("https://api.test.invalid/functions/v1/")) throw new Error("Unexpected fixture request");
      const body = await request.json();
      if (request.url.endsWith("/command")) {
        requests.push(body);
        if (body.command.kind === "revoke_admin_delegation") {
          if (requests.length === 1) return Response.json({ error: "internal_error" }, { status: 502 });
          revoked = true;
        } else if (body.command.kind === "withdraw_admin_client_approval") { approvalWithdrawn = true; revoked = true; }
        else if (body.command.kind === "approve_admin_client") { reapproved = true; }
        else throw new Error("Unexpected command kind");
        return Response.json({ status: "accepted", events: [] });
      }
      const visibleClient = metadataChanged ? { ...fixture.clients[0], verification_version: 3, reapproval_required: !reapproved,
        approval: reapproved ? { ...fixture.clients[0].approval, verification_version: 3 } : null } :
        { ...fixture.clients[0], approval: { ...fixture.clients[0].approval, withdrawn_at: approvalWithdrawn ? fixture.grants[0].created_at : null } };
      return Response.json({ grants: body.resource === "admin_grants" ? [{ ...grant, client: visibleClient, owner_user_id: foreignProjection ? "22222222-2222-4222-8222-222222222222" : grant.owner_user_id, state: revoked ? "revoked" : "active", refresh_token: "PRIVATE_OBSERVER_SENTINEL" }] : [],
        clients: body.resource === "admin_clients" ? [visibleClient] : [],
        workers: body.resource === "admin_workers" ? fixture.workers : [],
        coverage: body.resource === "admin_coverage" ? fixture.coverage : [],
        actions: body.resource === "admin_history" ? [action] : [], next_before: null,
        active: { grant_count: revoked ? 0 : 1, full_account_count: revoked ? 0 : 1, expires_at: revoked ? null : grant.expires_at, full_account_expires_at: revoked ? null : grant.expires_at } });
    };
  </script>`;
  const seed = `<script>localStorage.setItem("sb-api-auth-token", JSON.stringify({ access_token: "synthetic-human", refresh_token: "synthetic-refresh", token_type: "bearer", expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user }));</script>`;
  const observe = `<script>
    const waitFor = async (predicate) => {
      for (let tries = 0; tries < 150; ++tries) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error("Timed out waiting for the admin view");
    };
    const one = selector => document.querySelector(selector);
    const revokeButton = () => [...document.querySelectorAll("[data-admin-grants] button")].find(button => button.textContent === "Revoke grant");
    const report = result => { document.documentElement.dataset.adminObservation = btoa(unescape(encodeURIComponent(JSON.stringify(result)))); };
    (async () => {
      await waitFor(() => one("[data-admin-indicator]").hidden && one("[data-admin-indicator]").dataset.fullAccount === "true");
      const fullAccount = one("[data-admin-indicator]").dataset.fullAccount;
      one("#hm-ws-menu-trigger").click();
      await waitFor(() => one("#hm-ws-menu") && !one("#hm-ws-menu").hidden);
      one("[data-admin-access-open]").click();
      await waitFor(() => revokeButton() && !revokeButton().disabled);
      const automaticCommands = requests.length;
      const inert = {
        images: one("[data-admin-grants]").querySelectorAll("img").length,
        labels: one("[data-admin-grants]").textContent,
        history: one("[data-admin-actions]").textContent,
        clients: one("[data-admin-clients]").textContent,
        dependencies: one("[data-admin-dependencies]").textContent,
        gate: one("[data-admin-gate]").textContent,
        renewalButtons: [...one("[data-admin-grants]").querySelectorAll("button")].filter(b => /renew|consent/i.test(b.textContent)).length,
        injected: typeof window.injected,
      };
      const revokeTone = revokeButton().dataset.tone;
      revokeButton().click();
      await waitFor(() => one("[data-admin-status]").textContent.includes("result is unavailable"));
      const unknown = one("[data-admin-status]").textContent;
      revokeButton().click();
      await waitFor(() => one("[data-admin-status]").textContent.includes("grant is revoked"));
      await waitFor(() => one("[data-admin-indicator-title]").textContent === "Admin clients and history");
      const revokeButtons = revokeButton() ? 1 : 0;
      const approvalButton = label => [...one("[data-admin-clients]").querySelectorAll("button")].find(b => b.textContent === label);
      const withdrawTone = approvalButton("Withdraw client approval").dataset.tone;
      approvalButton("Withdraw client approval").click();
      await waitFor(() => one("[data-admin-status]").textContent.includes("Your client approval was withdrawn"));
      window.adminFixtureChangeMetadata(); one("[data-admin-refresh]").click();
      await waitFor(() => approvalButton("Approve client version 3") && !approvalButton("Approve client version 3").disabled);
      const approveTone = approvalButton("Approve client version 3").dataset.tone;
      const commandsBeforeReapproval = requests.length;
      approvalButton("Approve client version 3").click();
      await waitFor(() => one("[data-admin-status]").textContent.includes("Your client approval was recorded"));
      const noSecrets = !one("admin-delegations").textContent.includes("PRIVATE_OBSERVER_SENTINEL");
      window.adminFixtureForeignProjection(); one("[data-admin-refresh]").click();
      await waitFor(() => one("[data-admin-status]").textContent.includes("could not be verified"));
      const foreignRowsRemoved = !one("[data-admin-grants]").textContent.includes(grant.client_id) && !one("[data-admin-clients]").textContent.includes(grant.client_id);
      one("#hm-ws-menu-trigger").click();
      const door = one("[data-admin-access-open]");
      const historyEntryVisible = !!one("#hm-ws-menu-trigger") && !one("#hm-ws-menu-trigger").hidden
        && !!one("#hm-ws-menu") && !one("#hm-ws-menu").hidden
        && !!door && !door.hidden && door.dataset.adminAccessScope === "workspace"
        && door.textContent === "Admin access and history"
        && one("[data-admin-indicator]").hidden;
      // A second document signs out through the real auth client and broadcasts to this view.
      const other = document.createElement("iframe"); other.src = "/signout"; document.body.append(other);
      await waitFor(() => one("admin-delegations").hidden);
      report({ revokeTone, withdrawTone, approveTone, fullAccount, inert, requests, unknown, revokeButtons, automaticCommands, commandsBeforeReapproval, noSecrets, foreignRowsRemoved, historyEntryVisible, indicatorHidden: one("[data-admin-indicator]").hidden,
        privateRows: one("[data-admin-grants]").textContent });
    })().catch(error => report({ error: String(error) }));
  </script>`;
  const markup = source.replace(/^---[\s\S]*?---\n/u, "").split("<script>")[0]!
    .replace("data-admin-policy={JSON.stringify(policy)}", `data-admin-policy='${JSON.stringify(policy).replaceAll("&", "&amp;").replaceAll("'", "&#39;")}'`);
  const html = `<!doctype html><html><body>${markup}<script>${menu}</script>${setup}${seed}<script>${bundle}</script>${observe}</body></html>`;
  const server = createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(request.url === "/signout" ? `<!doctype html><html><body>${setup}<script>${signOut}</script></body></html>` : html);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const root = await realpath(tmpdir()), profile = await mkdtemp(join(root, "cswarm-admin-browser."));
  try {
    const chrome = await findChrome();
    const address = server.address(); assert.ok(address && typeof address === "object");
    const { stdout } = await launchChrome(chrome, [
      "--password-store=basic", `--user-data-dir=${profile}`, "--virtual-time-budget=10000", "--dump-dom", `http://127.0.0.1:${address.port}`,
    ], { maxBuffer: 10 * 1024 * 1024, timeout: 30000, killSignal: "SIGKILL" });
    const encoded = stdout.match(/^\s*(?:<!doctype html>\s*)?<html\b[^>]*\bdata-admin-observation="([A-Za-z0-9+/]+={0,2})"/iu)?.[1];
    assert.ok(encoded, "the rendered admin view must report its observations");
    const result = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    assert.equal(result.error, undefined);
    assert.equal(result.fullAccount, "true");
    assert.equal(result.inert.images, 0);
    assert.ok(result.inert.labels.includes(grant.client_id));
    assert.ok(result.inert.history.includes("refused"));
    assert.equal(result.inert.injected, "undefined");
    assert.ok(result.inert.clients.includes("Account-owner approval"));
    assert.ok(result.inert.dependencies.includes("Worker"));
    assert.ok(result.inert.gate.includes("No admin client can connect yet"));
    assert.ok(result.inert.labels.includes("Registry version 1"));
    assert.ok(result.inert.labels.includes("Registry version 2"));
    assert.ok(result.inert.labels.includes("To renew, reconnect from your assistant; you will be asked to approve again."));
    assert.equal(result.inert.renewalButtons, 0);
    assert.equal(result.revokeTone, "danger"); assert.equal(result.withdrawTone, "danger"); assert.equal(result.approveTone, undefined);
    const requests = result.requests;
    assert.ok(result.unknown.includes(requests[0].command_id));
    assert.equal(result.automaticCommands, 0); assert.equal(result.commandsBeforeReapproval, 3);
    assert.equal(result.noSecrets, true); assert.equal(result.foreignRowsRemoved, true);
    assert.equal(requests.length, 4);
    assert.equal(requests[2].command.kind, "withdraw_admin_client_approval");
    assert.equal(requests[3].command.kind, "approve_admin_client");
    assert.equal(requests[3].command.verification_version, 3); assert.equal(requests[0].command_id, requests[1].command_id);
    assert.deepEqual(requests[1].stream, { kind: "account" }); assert.equal(requests[1].resource, "https://api.commonswarm.com/admin");
    assert.equal(requests[1].command.kind, "revoke_admin_delegation"); assert.equal(Object.hasOwn(requests[1], "workspace_id"), false);
    assert.equal(result.revokeButtons, 0); assert.equal(result.indicatorHidden, true); assert.equal(result.historyEntryVisible, true);
    assert.equal(result.privateRows, "");
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    const resolved = await realpath(profile);
    assert.ok(dirname(resolved) === root && basename(resolved).startsWith("cswarm-admin-browser.") && resolved !== process.env.HOME);
    execFileSync("rm", ["-r", resolved], { stdio: "pipe" });
  }
});
