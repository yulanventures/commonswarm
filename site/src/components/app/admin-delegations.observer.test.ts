/** CI only: shared headless launcher, fresh profile, no installed Chrome app. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, mkdtemp, realpath } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { build } from "esbuild";
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
  const signOut = await bundleScript('import { client } from "../../lib/commonswarm"; void client()!.auth.signOut({ scope: "local" });');
  const id = "11111111-1111-4111-8111-111111111111", time = new Date(Date.now() + 86400000).toISOString();
  const user = { id, aud: "authenticated", role: "authenticated", email: "synthetic@example.test", app_metadata: {}, user_metadata: {}, created_at: time };
  const grant = { grant_id: id, admin_identity_id: id, connection_id: id, client_id: '<img src=x onerror="window.injected=true">',
    mode: "full_account", scope_names: ["admin:read", "workspaces:create"], workspace_selector: "owned_and_selected", workspace_ids: [], withdrawn_workspace_ids: [],
    created_at: "2026-10-01T00:00:00.000Z", expires_at: time, reason_code: null };
  const action = { seq: "1", event_id: id, occurred_at_server: "2026-10-01T00:00:00.000Z", grant_id: id, admin_identity_id: id, actor_user: null,
    action: "admin_prepare_connection", target_kind: "connection", target_id: id, workspace_id: null, outcome: "refused", reason_code: "human_confirmation_required",
    next_action: "Ask the granting person to review this connection.", recovery_kind: "human", related_event_ids: [] };
  // Mock only the HTTP boundary. The component, auth client and revoke helper are real.
  const setup = `<script>
    const user = ${JSON.stringify(user)}, grant = ${JSON.stringify(grant)}, action = ${JSON.stringify(action)};
    let revoked = false;
    const requests = [];
    window.fetch = async (input, init) => {
      const request = new Request(input, init);
      if (request.url.endsWith("/auth/v1/user")) return Response.json(user);
      if (request.url.includes("/auth/v1/logout")) return new Response(null, { status: 204 });
      if (!request.url.startsWith("https://api.test.invalid/functions/v1/")) throw new Error("Unexpected fixture request");
      const body = await request.json();
      if (request.url.endsWith("/command")) {
        requests.push(body);
        if (requests.length === 1) return Response.json({ error: "internal_error" }, { status: 502 });
        revoked = true; return Response.json({ status: "accepted", events: [] });
      }
      return Response.json({ grants: body.resource === "admin_grants" ? [{ ...grant, state: revoked ? "revoked" : "active" }] : [],
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
      await waitFor(() => !one("[data-admin-indicator]").hidden);
      const fullAccount = one("[data-admin-indicator]").dataset.fullAccount;
      one("[data-admin-indicator]").click();
      await waitFor(() => revokeButton() && !revokeButton().disabled);
      const inert = {
        images: one("[data-admin-grants]").querySelectorAll("img").length,
        labels: one("[data-admin-grants]").textContent,
        history: one("[data-admin-actions]").textContent,
        injected: typeof window.injected,
      };
      revokeButton().click();
      await waitFor(() => one("[data-admin-status]").textContent.includes("result is unavailable"));
      revokeButton().click();
      await waitFor(() => one("[data-admin-status]").textContent.includes("grant is revoked"));
      await waitFor(() => one("[data-admin-indicator]").hidden);
      const revokeButtons = revokeButton() ? 1 : 0;
      // A second document signs out through the real auth client and broadcasts to this view.
      const other = document.createElement("iframe"); other.src = "/signout"; document.body.append(other);
      await waitFor(() => one("admin-delegations").hidden);
      report({ fullAccount, inert, requests, revokeButtons, indicatorHidden: one("[data-admin-indicator]").hidden,
        privateRows: one("[data-admin-grants]").textContent });
    })().catch(error => report({ error: String(error) }));
  </script>`;
  const html = `<!doctype html><html><body>${source.split("<script>")[0]}${setup}${seed}<script>${bundle}</script>${observe}</body></html>`;
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
    const requests = result.requests;
    assert.equal(requests.length, 2); assert.equal(requests[0].command_id, requests[1].command_id);
    assert.deepEqual(requests[1].stream, { kind: "account" }); assert.equal(requests[1].resource, "https://api.commonswarm.com/admin");
    assert.equal(requests[1].command.kind, "revoke_admin_delegation"); assert.equal(Object.hasOwn(requests[1], "workspace_id"), false);
    assert.equal(result.revokeButtons, 0); assert.equal(result.indicatorHidden, true);
    assert.equal(result.privateRows, "");
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    const resolved = await realpath(profile);
    assert.ok(dirname(resolved) === root && basename(resolved).startsWith("cswarm-admin-browser.") && resolved !== process.env.HOME);
    execFileSync("rm", ["-r", resolved], { stdio: "pipe" });
  }
});
