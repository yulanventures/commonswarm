/** CI only: bundled Playwright Chromium, fresh profile, no installed Chrome app. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, mkdtemp, realpath } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { build } from "esbuild";

test("admin account view keeps hostile labels inert and reuses an uncertain revoke request", { skip: process.platform === "darwin", timeout: 90000 }, async () => {
  // CI installs Playwright with Chromium. The mini's site/browser tests remain deferred.
  const globalModules = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
  const { chromium } = await import(pathToFileURL(join(globalModules, "playwright", "index.mjs")).href);
  const component = fileURLToPath(new URL("./AdminDelegations.astro", import.meta.url));
  const source = await readFile(component, "utf8");
  const script = source.split("<script>")[1]?.split("</script>")[0]; assert.ok(script);
  const bundle = await build({ stdin: { contents: script, loader: "ts", resolveDir: dirname(component) }, bundle: true, write: false,
    format: "iife", platform: "browser", define: { "import.meta.env": JSON.stringify({ PUBLIC_SUPABASE_URL: "https://api.test.invalid", PUBLIC_SUPABASE_ANON_KEY: "synthetic-public-key" }) } });
  const html = `<!doctype html><html><body>${source.split("<script>")[0]}<script>${bundle.outputFiles[0]!.text}</script></body></html>`;
  const server = createServer((_request, response) => { response.writeHead(200, { "Content-Type": "text/html" }); response.end(html); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const root = await realpath(tmpdir()), profile = await mkdtemp(join(root, "cswarm-admin-browser."));
  let browser;
  try {
    browser = await chromium.launchPersistentContext(profile, { headless: true, args: ["--password-store=basic"] });
    const page = await browser.newPage();
    const id = "11111111-1111-4111-8111-111111111111", time = new Date(Date.now() + 86400000).toISOString();
    const user = { id, aud: "authenticated", role: "authenticated", email: "synthetic@example.test", app_metadata: {}, user_metadata: {}, created_at: time };
    await page.addInitScript(({ user }) => localStorage.setItem("sb-api-auth-token", JSON.stringify({ access_token: "synthetic-human", refresh_token: "synthetic-refresh", token_type: "bearer", expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user })), { user });
    let revoked = false;
    const requests: Array<Record<string, any>> = [];
    const grant = { grant_id: id, admin_identity_id: id, connection_id: id, client_id: '<img src=x onerror="window.injected=true">',
      mode: "full_account", scope_names: ["admin:read", "workspaces:create"], workspace_selector: "owned_and_selected", workspace_ids: [], withdrawn_workspace_ids: [],
      created_at: "2026-10-01T00:00:00.000Z", expires_at: time, reason_code: null };
    await browser.route("https://api.test.invalid/**", async route => {
      const request = route.request();
      if (request.url().includes("/auth/v1/user")) { await route.fulfill({ json: user }); return; }
      const body = request.postDataJSON();
      if (request.url().endsWith("/command")) {
        requests.push(body);
        if (requests.length === 1) { await route.fulfill({ status: 502, json: { error: "internal_error" } }); return; }
        revoked = true; await route.fulfill({ json: { status: "accepted", ok: true } }); return;
      }
      const action = { seq: "1", event_id: id, occurred_at_server: "2026-10-01T00:00:00.000Z", grant_id: id, admin_identity_id: id, actor_user: null,
        action: "admin_prepare_connection", target_kind: "connection", target_id: id, workspace_id: null, outcome: "refused", reason_code: "human_confirmation_required",
        next_action: "Ask the granting person to review this connection.", recovery_kind: "human", related_event_ids: [] };
      await route.fulfill({ json: { grants: body.resource === "admin_grants" ? [{ ...grant, state: revoked ? "revoked" : "active" }] : [],
        actions: body.resource === "admin_history" ? [action] : [], next_before: null,
        active: { grant_count: revoked ? 0 : 1, full_account_count: revoked ? 0 : 1, expires_at: revoked ? null : time, full_account_expires_at: revoked ? null : time } } });
    });
    const address = server.address(); assert.ok(address && typeof address === "object");
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.locator("[data-admin-indicator]").waitFor({ state: "visible" });
    assert.equal(await page.locator("[data-admin-indicator]").getAttribute("data-full-account"), "true");
    await page.locator("[data-admin-indicator]").click();
    await page.getByRole("button", { name: "Revoke grant", exact: true }).waitFor({ state: "visible" });
    assert.equal(await page.locator("[data-admin-grants] img").count(), 0);
    assert.ok((await page.locator("[data-admin-grants]").textContent())?.includes(grant.client_id));
    assert.ok((await page.locator("[data-admin-actions]").textContent())?.includes("refused"));
    assert.equal(await page.evaluate(() => (window as any).injected), undefined);
    await page.getByRole("button", { name: "Revoke grant", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("[data-admin-status]")?.textContent?.includes("result is unavailable"));
    await page.getByRole("button", { name: "Revoke grant", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("[data-admin-status]")?.textContent?.includes("grant is revoked"));
    assert.equal(requests.length, 2); assert.equal(requests[0]!.command_id, requests[1]!.command_id);
    assert.deepEqual(requests[1]!.stream, { kind: "account" }); assert.equal(requests[1]!.resource, "https://api.commonswarm.com/admin");
    assert.equal(requests[1]!.command.kind, "revoke_admin_delegation"); assert.equal(Object.hasOwn(requests[1]!, "workspace_id"), false);
    assert.equal(await page.getByRole("button", { name: "Revoke grant", exact: true }).count(), 0);
    await page.locator("[data-admin-indicator]").waitFor({ state: "hidden" });
    // A new auth identity clears private rows synchronously, before any later read.
    const other = await browser.newPage();
    await other.goto(`http://127.0.0.1:${address.port}`);
    await other.evaluate(() => localStorage.removeItem("sb-api-auth-token"));
    await page.waitForFunction(() => document.querySelector("admin-delegations")?.hasAttribute("hidden"));
    assert.equal(await page.locator("[data-admin-grants]").textContent(), "");
  } finally {
    await browser?.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    const resolved = await realpath(profile);
    assert.ok(dirname(resolved) === root && basename(resolved).startsWith("cswarm-admin-browser.") && resolved !== process.env.HOME);
    execFileSync("rm", ["-r", resolved], { stdio: "pipe" });
  }
});
