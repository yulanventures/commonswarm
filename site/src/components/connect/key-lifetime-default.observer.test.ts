/** CI only: the real custom element and helpers, with synthetic HTTP responses. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, realpath } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { transform } from "@astrojs/compiler-rs";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { build } from "esbuild";
import { browserTest as test } from "../../../tests/chrome.js";
import { findChrome, launchChrome } from "../../../tests/chrome.js";

// Authoring gate: helper/server cases cannot detect inert real click bindings or
// a rendered lifetime picker or a changed bootstrap request. No production seam is needed.
test("ordinary AgentConnect has no lifetime choice and preserves its 30-day bootstrap proof without a second settings command", {
  skip: process.platform === "darwin", timeout: 90000,
}, async () => {
  const component = fileURLToPath(new URL("./AgentConnect.astro", import.meta.url));
  const source = await readFile(component, "utf8");
  const env = {
    PUBLIC_H0_LINK_JOIN: "0", PUBLIC_SUPABASE_URL: "https://api.test.invalid",
    PUBLIC_SUPABASE_ANON_KEY: "synthetic-public-key",
  };
  const compiled = transform(source, {
    filename: component, internalURL: "astro/compiler-runtime",
    resultScopedSlot: true, resolvePath: specifier => specifier,
  });
  assert.deepEqual(compiled.diagnostics.filter(diagnostic => diagnostic.severity === "error"), []);
  // As in the existing container tests, Vite's CSS imports are served separately.
  // Bundle the real frontmatter so its flag uses the same env as the browser script.
  const renderedBundle = await build({
    stdin: {
      contents: compiled.code.replace(/import "[^"\n]+\?astro&type=style[^"\n]+";\n/gu, ""),
      loader: "ts", resolveDir: dirname(component),
    },
    bundle: true, write: false, format: "esm", platform: "node",
    external: ["astro/compiler-runtime"], define: { "import.meta.env": JSON.stringify(env) },
  });
  const renderedCode = renderedBundle.outputFiles[0]!.text.replaceAll('"astro/compiler-runtime"',
    JSON.stringify(new URL("../../../node_modules/astro/dist/runtime/compiler/index.js", import.meta.url).href));
  const renderedComponent = await import(`data:text/javascript;base64,${Buffer.from(renderedCode).toString("base64")}`);
  const workspaceId = "11111111-1111-4111-8111-111111111111";
  const inviteId = "22222222-2222-4222-8222-222222222222";
  const userId = "33333333-3333-4333-8333-333333333333";
  const container = await AstroContainer.create({ resolve: () => "/agent-connect.js" });
  const markup = await container.renderToString(renderedComponent.default, {
    props: { workspaceId, workspaceName: "Synthetic household" },
  });
  assert.equal(compiled.scripts.length, 1);
  const script = compiled.scripts[0]!.code;
  assert.ok(script);
  const browserBundle = (await build({
    stdin: { contents: script, loader: "ts", resolveDir: dirname(component) },
    bundle: true, write: false, format: "iife", platform: "browser",
    define: { "import.meta.env": JSON.stringify(env) },
  })).outputFiles[0]!.text;
  const user = {
    id: userId, aud: "authenticated", role: "authenticated", email: "synthetic@example.test",
    app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString(),
  };
  // Only the network is mocked. These responses neither click nor render anything.
  const setup = `<script>
    const user = ${JSON.stringify(user)}, principalId = ${JSON.stringify(inviteId)};
    const requests = [], unexpected = [], fixtureFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const request = new Request(input, init), url = new URL(request.url);
      const body = request.method === "POST" ? await request.json() : null;
      requests.push({ method: request.method, url: request.url, body });
      if (url.origin === "https://api.test.invalid") {
        if (request.method === "GET" && url.pathname === "/auth/v1/user" && !url.search) return Response.json(user);
        if (request.method === "GET" && url.pathname === "/rest/v1/agent_principals") return Response.json([]);
        if (request.method === "GET" && url.pathname === "/rest/v1/my_devices") return Response.json([{ device_id: "device-id" }]);
        if (request.method === "POST" && url.pathname === "/functions/v1/read" && body.resource === "renewal_grants") return Response.json({ grants: [] });
        if (request.method === "POST" && url.pathname === "/functions/v1/command" && !url.search) {
          if (body.command?.kind === "create_agent_principal") return Response.json({ status: "accepted", principal_id: principalId });
          if (body.command?.kind === "mint_agent_token") return Response.json({ status: "accepted", token_id: "token-id", run_id: body.command.run_id,
            agent_token: "swm_agt_synthetic", grant_kind: "standing", horizon_expires_at: null,
            connection_expires_at: null, connection_expired_at: null,
            events: [{ type: "AgentTokenMinted", payload: { issued_at: Date.now(), expires_at: Date.now() + 2592000000 } }] });
        }
      }
      unexpected.push(request.method + " " + url.origin + url.pathname);
      throw new Error("Unexpected fixture HTTP request");
    };
    localStorage.setItem("sb-api-auth-token", JSON.stringify({
      access_token: "synthetic-human", refresh_token: "synthetic-refresh", token_type: "bearer",
      expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user,
    }));
  </script>`;
  const observe = `<script>
    let stage = "initializing";
    const host = document.querySelector("agent-connect"), one = selector => host.querySelector(selector);
    const commandRequests = () => requests.filter(request => new URL(request.url).pathname === "/functions/v1/command");
    const visible = node => !!node && !node.hidden && node.getClientRects().length > 0;
    const report = result => { document.documentElement.dataset.joinObservation = btoa(unescape(encodeURIComponent(JSON.stringify(result)))); };
    const waitFor = async (name, predicate) => {
      stage = name;
      for (let tries = 0; tries < 200; ++tries) {
        if (unexpected.length) throw new Error("Unexpected fixture HTTP request");
        if (predicate()) return;
        // Server-clock ticks let the real SDK auth lock finish under virtual time.
        await fixtureFetch("/__observer-tick");
      }
      throw new Error("Timed out waiting for " + stage);
    };
    (async () => {
      await waitFor("ready form", () => host.dataset.state === "ready");
      const automaticCommands = commandRequests().length;
      if (one('[data-field="ttl"]') || /Key lifetime/.test(host.textContent)) throw new Error("Lifetime choice returned");
      const name = one('[data-field="name"]'); name.value = "Synthetic assistant";
      name.dispatchEvent(new Event("input", { bubbles: true }));
      one('[data-action="mint"]').click();
      await waitFor("minted result", () => host.dataset.state === "done" && !host.hasAttribute("data-mint-busy"));
      report({ requests, unexpected, automaticCommands,
        policy: one('[data-slot="connection-policy"]').textContent,
        copyEnabled: visible(one('[data-action="copy"]')) && !one('[data-action="copy"]').disabled });
    })().catch(error => report({ error: String(error), stage, requests, unexpected,
      state: host.dataset.state, formError: one('[data-slot="form-error"]').textContent }));
  </script>`;
  const html = `<!doctype html><html><head><style>${compiled.css.join("\n")}</style>${setup}</head><body>${markup}${observe}</body></html>`;
  const unexpectedServerRequests: string[] = [];
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/__observer-tick") {
      setTimeout(() => { response.writeHead(204); response.end(); }, 20);
    } else if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html" }); response.end(html);
    } else if (request.method === "GET" && request.url === "/agent-connect.js") {
      response.writeHead(200, { "Content-Type": "text/javascript" }); response.end(browserBundle);
    } else {
      unexpectedServerRequests.push(`${request.method} ${(request.url ?? "").split("?")[0]}`);
      response.writeHead(404); response.end();
    }
  });
  // Compilation/rendering above is in memory: failures cannot leave a server or profile.
  const root = await realpath(tmpdir()), profile = await mkdtemp(join(root, "cswarm-join-browser."));
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address(); assert.ok(address && typeof address === "object");
    const { stdout } = await launchChrome(await findChrome(), [
      `--user-data-dir=${profile}`, "--virtual-time-budget=15000", "--dump-dom", `http://127.0.0.1:${address.port}/`,
    ], { maxBuffer: 10 * 1024 * 1024, timeout: 30000, killSignal: "SIGKILL" });
    const encoded = stdout.match(/^\s*(?:<!doctype html>\s*)?<html\b[^>]*\bdata-join-observation="([A-Za-z0-9+/]+={0,2})"/iu)?.[1];
    assert.ok(encoded, "the real AgentConnect element must report browser observations");
    const result = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.deepEqual(result.unexpected, []); assert.deepEqual(unexpectedServerRequests, []);
    assert.equal(result.automaticCommands, 0);
    assert.equal(result.policy, "Connection settings are managed by the server.");
    assert.equal(result.copyEnabled, true);
    const commands = result.requests.filter((request: { url: string }) => new URL(request.url).pathname === "/functions/v1/command");
    assert.deepEqual(commands.map((request: { body: { command: { kind: string } } }) => request.body.command.kind),
      ["create_agent_principal", "mint_agent_token"]);
    const mint = commands[1].body;
    assert.equal(mint.workspace_id, workspaceId); assert.deepEqual(mint.stream, { kind: "workspace" });
    assert.equal(mint.command.ttl_ms, 2592000000); assert.equal(mint.command.renewal_kind, "standing");
    assert.equal(Object.hasOwn(mint.command, "renewal_horizon_ms"), false);
    assert.equal(Object.hasOwn(mint.command, "connection_expires_at"), false);
  } finally {
    try {
      if (server.listening) {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }
    } finally {
      const resolved = await realpath(profile);
      assert.ok(dirname(resolved) === root && basename(resolved).startsWith("cswarm-join-browser.") && resolved !== process.env.HOME);
      execFileSync("rm", ["-r", resolved], { stdio: "pipe" });
    }
  }
});
