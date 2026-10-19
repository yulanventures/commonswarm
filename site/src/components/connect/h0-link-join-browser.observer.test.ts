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
import { browserTest as test, findChrome, launchChrome } from "../../../tests/chrome.js";

// Authoring gate: helper/server cases cannot detect inert real click bindings or
// a rendered result retaining the secret after revoke. No production seam is needed.
test("AgentConnect invite clicks mint then revoke the returned invite and clear its credential", {
  skip: process.platform === "darwin", timeout: 90000,
}, async () => {
  const component = fileURLToPath(new URL("./AgentConnect.astro", import.meta.url));
  const source = await readFile(component, "utf8");
  const env = {
    PUBLIC_H0_LINK_JOIN: "1", PUBLIC_SUPABASE_URL: "https://api.test.invalid",
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
  const secret = `swm_join_${"A".repeat(43)}`, locator = "B".repeat(22);
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
  const mintResponse = {
    status: "accepted", join_credential_id: inviteId, join_credential: secret,
    locator, seat_cap: 10, expires_at: new Date(Date.now() + 86400000).toISOString(),
  };
  // Only the network is mocked. These responses neither click nor render anything.
  const setup = `<script>
    const user = ${JSON.stringify(user)}, mintResponse = ${JSON.stringify(mintResponse)};
    const requests = [], unexpected = [], fixtureFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const request = new Request(input, init), url = new URL(request.url);
      const body = request.method === "POST" ? await request.json() : null;
      requests.push({ method: request.method, url: request.url, body });
      if (url.origin === "https://api.test.invalid") {
        if (request.method === "GET" && url.pathname === "/auth/v1/user" && !url.search) return Response.json(user);
        if (request.method === "GET" && url.pathname === "/rest/v1/agent_principals") return Response.json([]);
        if (request.method === "POST" && url.pathname === "/functions/v1/command" && !url.search) {
          if (body.command?.kind === "mint_agent_join_credential") return Response.json(mintResponse);
          if (body.command?.kind === "revoke_agent_join_credential") return Response.json({ status: "accepted" });
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
      const create = one('[data-action="mint-join"]');
      if (!visible(create) || create.disabled) throw new Error("Create invite is not available");
      const automaticCommands = commandRequests().length, createLabel = create.textContent.trim();
      create.click();
      await waitFor("minted result", () => host.dataset.state === "done" && !host.hasAttribute("data-mint-busy"));
      const revoke = one('[data-action="revoke-join"]'), copy = one('[data-action="copy"]');
      const shown = { title: one(".ac__result-title").textContent,
        prompt: one('[data-slot="prompt"]').textContent,
        copyEnabled: visible(copy) && !copy.disabled, revokeLabel: revoke.textContent.trim() };
      if (!visible(revoke) || revoke.disabled) throw new Error("Revoke invite is not available");
      revoke.click();
      await waitFor("revoke completion", () => commandRequests().length === 2 && !host.hasAttribute("data-mint-busy"));
      report({ requests, unexpected, automaticCommands, createLabel, shown,
        revoked: { title: one(".ac__result-title").textContent, lead: one(".ac__result-lead").textContent,
          prompt: one('[data-slot="prompt"]').textContent, copyDisabled: copy.disabled, revokeDisabled: revoke.disabled,
          secretPresent: host.textContent.includes(mintResponse.join_credential), resultVisible: visible(one('[data-panel="result"]')) } });
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
    assert.equal(result.createLabel, "Create an invite");
    assert.equal(result.shown.title, "Your invite is ready.");
    assert.equal(result.shown.copyEnabled, true);
    assert.equal(result.shown.revokeLabel, "Revoke this invite");
    assert.ok(result.shown.prompt.includes(secret));
    assert.ok(result.shown.prompt.includes(`https://api.test.invalid/functions/v1/h0/agent-doc/${locator}`));
    const commands = result.requests.filter((request: { url: string }) => new URL(request.url).pathname === "/functions/v1/command");
    assert.deepEqual(commands.map((request: { body: { command: { kind: string } } }) => request.body.command.kind),
      ["mint_agent_join_credential", "revoke_agent_join_credential"]);
    for (const request of commands) {
      assert.equal(request.method, "POST"); assert.equal(request.url, "https://api.test.invalid/functions/v1/command");
      assert.equal(request.body.workspace_id, workspaceId); assert.deepEqual(request.body.stream, { kind: "workspace" });
    }
    assert.equal(commands[1].body.command.join_credential_id, inviteId);
    const reads = result.requests.filter((request: { url: string }) => new URL(request.url).pathname === "/rest/v1/agent_principals");
    assert.equal(reads.length, 1);
    assert.equal(new URL(reads[0].url).searchParams.get("workspace_id"), `eq.${workspaceId}`);
    assert.ok(result.requests.indexOf(reads[0]) < result.requests.indexOf(commands[0]));
    assert.equal(result.revoked.title, "This invite is revoked.");
    assert.equal(result.revoked.lead, "This invite is revoked. It can no longer be used to join.");
    assert.equal(result.revoked.prompt, ""); assert.equal(result.revoked.secretPresent, false);
    assert.equal(result.revoked.copyDisabled, true); assert.equal(result.revoked.revokeDisabled, true);
    assert.equal(result.revoked.resultVisible, true);
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
