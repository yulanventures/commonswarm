/** CI only: the real Grok Bot card, picker, dashboard Generate binding and connect
 * form, with synthetic HTTP responses. SPEC S4 / F-GROK-FLOW-PROOF: the regex at
 * agent-hosts.test.mjs could not detect an inert card or Generate click, so this
 * case clicks the real card, then the real Generate button (bound by the actual
 * LiveDashboard `openConnect` loop, extracted verbatim like home-integration's
 * dashboardFunctions), submits the real name form against the normal mint mock,
 * and requires Copy to put the actual generated prompt on the clipboard. The
 * guide URL is asserted on the real panel anchor. No production seam is needed. */
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
import ts from "typescript";
import { browserTest as test } from "../../../tests/chrome.js";
import { findChrome, launchChrome } from "../../../tests/chrome.js";

const env = {
  PUBLIC_SUPABASE_URL: "https://api.test.invalid",
  PUBLIC_SUPABASE_ANON_KEY: "synthetic-public-key",
};

/** Render one real .astro component exactly as h0-link-join-browser does. */
async function renderReal(component: string, props: Record<string, unknown>, scriptPath: string) {
  const source = await readFile(component, "utf8");
  const compiled = transform(source, {
    filename: component, internalURL: "astro/compiler-runtime",
    resultScopedSlot: true, resolvePath: specifier => specifier,
  });
  assert.deepEqual(compiled.diagnostics.filter(d => d.severity === "error"), []);
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
  const container = await AstroContainer.create({ resolve: () => scriptPath });
  const markup = await container.renderToString(renderedComponent.default, { props });
  assert.equal(compiled.scripts.length, 1);
  const script = compiled.scripts[0]!.code;
  assert.ok(script);
  const browserBundle = (await build({
    stdin: { contents: script, loader: "ts", resolveDir: dirname(component) },
    bundle: true, write: false, format: "iife", platform: "browser",
    define: { "import.meta.env": JSON.stringify(env) },
  })).outputFiles[0]!.text;
  return { markup, css: compiled.css.join("\n"), browserBundle };
}

/** The dashboard's own Generate wiring, verbatim. Extraction fails if the
 * production binding or `openConnect` is removed, which is the point. */
async function dashboardGenerateWiring(): Promise<string> {
  const raw = await readFile(new URL("../app/LiveDashboard.astro", import.meta.url), "utf8");
  const script = raw.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, "LiveDashboard script");
  const names = ["one", "all", "showChannelView", "syncConnectWorkspace", "openConnect"];
  const ast = ts.createSourceFile("dashboard.ts", script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found = new Map<string, string>();
  let binding = "";
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && names.includes(node.name.text)) {
      found.set(node.name.text, `const ${node.getText(ast)};`);
    }
    if (ts.isForOfStatement(node)) {
      const text = node.getText(ast);
      if (text.includes("[data-agent-owner-self]") && text.includes("openConnect")) binding = text;
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  for (const name of names) assert.ok(found.has(name), `production declaration ${name}`);
  assert.ok(binding, "production [data-agent-owner-self] click binding");
  return ts.transpileModule(
    [...names.map(name => found.get(name)!), binding].join("\n"),
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
}

test("Grok Bot card activation generates, submits, mints and copies the actual prompt", {
  skip: process.platform === "darwin", timeout: 90000,
}, async () => {
  const pickerFile = fileURLToPath(new URL("./AgentHostPicker.astro", import.meta.url));
  const connectFile = fileURLToPath(new URL("./AgentConnect.astro", import.meta.url));
  const workspaceId = "11111111-1111-4111-8111-111111111111";
  const workspaceName = "Synthetic household";
  const userId = "33333333-3333-4333-8333-333333333333";
  const principalId = "44444444-4444-4444-8444-444444444444";
  const deviceId = "55555555-5555-4555-8555-555555555555";
  const tokenId = "66666666-6666-4666-8666-666666666666";
  const agentToken = `swm_agt_${"C".repeat(32)}`;
  const agentName = "grok-bot-test";
  const picker = await renderReal(pickerFile, { audience: "setter" }, "/picker.js");
  const connect = await renderReal(connectFile, { workspaceId, workspaceName }, "/connect.js");
  const wiring = await dashboardGenerateWiring();
  const user = {
    id: userId, aud: "authenticated", role: "authenticated", email: "synthetic@example.test",
    app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString(),
  };
  // Only the network and clipboard are mocked. These neither click nor render anything.
  const setup = `<script>
    const user = ${JSON.stringify(user)};
    const requests = [], unexpected = [], fixtureFetch = window.fetch.bind(window);
    let clipboardText = null;
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async text => { clipboardText = text; } } });
    window.fetch = async (input, init) => {
      const request = new Request(input, init), url = new URL(request.url);
      const body = request.method === "POST" ? await request.clone().json().catch(() => null) : null;
      requests.push({ method: request.method, url: request.url, body });
      if (url.origin === "https://api.test.invalid") {
        if (request.method === "GET" && url.pathname === "/auth/v1/user" && !url.search) return Response.json(user);
        if (request.method === "GET" && url.pathname === "/rest/v1/agent_principals") return Response.json([]);
        if (request.method === "GET" && url.pathname === "/rest/v1/my_devices")
          return Response.json([{ device_id: ${JSON.stringify(deviceId)}, label: "web", revoked_at: null }]);
        if (request.method === "POST" && url.pathname === "/functions/v1/read") return Response.json({ grants: [] });
        if (request.method === "POST" && url.pathname === "/functions/v1/command" && !url.search) {
          const kind = body.command?.kind, now = Date.now();
          if (kind === "register_device") return Response.json({ status: "accepted", device_id: body.command.device_id });
          if (kind === "create_agent_principal") return Response.json({ status: "accepted", principal_id: ${JSON.stringify(principalId)} });
          if (kind === "mint_agent_token") return Response.json({
            status: "accepted", token_id: ${JSON.stringify(tokenId)}, principal_id: body.command.principal_id,
            run_id: body.command.run_id, grant_kind: "standing", horizon_expires_at: null, successors_remaining: null,
            events: [{ type: "AgentTokenMinted", payload: { issued_at: now, expires_at: now + 86400000 } }],
            agent_token: ${JSON.stringify(agentToken)},
          });
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
  // Dashboard scope for the verbatim wiring: values only, no view logic of our own.
  const dashboardScope = `<script>
    const app = document.querySelector("[data-fixture-app]");
    let sampleMode = false, signalExpiryTimer = undefined, connectFocusObserver = null;
    const unknownChannelId = null;
    const workspaces = [{ id: ${JSON.stringify(workspaceId)}, name: ${JSON.stringify(workspaceName)} }];
    const activeWorkspaceId = ${JSON.stringify(workspaceId)};
    const disarmLiveFeed = () => {}, syncComposerPlacement = () => {}, closeMentionPicker = () => {};
    const syncStandalonePage = () => {}, syncFeedChrome = () => {}, armLiveFeed = () => {};
  </script><script>${wiring}</script>`;
  const observe = `<script>
    let stage = "initializing";
    const pickerEl = document.querySelector("agent-host-picker");
    const connectEl = document.querySelector("agent-connect");
    const visible = node => !!node && !node.hidden && node.getClientRects().length > 0;
    const report = result => { document.documentElement.dataset.grokObservation = btoa(unescape(encodeURIComponent(JSON.stringify(result)))); };
    const waitFor = async (name, predicate) => {
      stage = name;
      for (let tries = 0; tries < 200; ++tries) {
        if (unexpected.length) throw new Error("Unexpected fixture HTTP request");
        if (predicate()) return;
        await fixtureFetch("/__observer-tick");
      }
      throw new Error("Timed out waiting for " + stage);
    };
    (async () => {
      await waitFor("picker upgrade", () => pickerEl.dataset.wired === "true");
      // Positive control: an existing card activates its own panel first.
      const claudeChip = pickerEl.querySelector('[data-ahp-host="claude"]');
      claudeChip.click();
      await waitFor("claude panel", () => visible(pickerEl.querySelector('[data-ahp-detail="claude"]')));
      const terminalHook = !!pickerEl.querySelector('[data-ahp-host="terminal"][data-agent-owner-self]');
      const chip = pickerEl.querySelector('[data-ahp-host="grok-bot"]');
      if (!visible(chip)) throw new Error("Grok Bot card is not available");
      chip.click();
      const panel = pickerEl.querySelector('[data-ahp-detail="grok-bot"]');
      await waitFor("grok panel", () => visible(panel) && chip.getAttribute("aria-pressed") === "true");
      const guide = panel.querySelector('a[href="/guides/grok-bot"]');
      const generate = panel.querySelector("[data-agent-owner-self]");
      if (!visible(generate)) throw new Error("Generate the setup prompt is not available");
      const generateLabel = generate.textContent.trim();
      generate.click();
      const connectView = document.querySelector('[data-channel-view="connect"]');
      await waitFor("connect form", () => visible(connectView) && connectEl.dataset.state === "ready");
      const choiceHidden = document.querySelector('[data-channel-view="agent-choice"]').hidden;
      const name = connectEl.querySelector('[data-field="name"]');
      name.value = ${JSON.stringify(agentName)};
      name.dispatchEvent(new Event("input", { bubbles: true }));
      connectEl.querySelector('[data-action="mint"]').click();
      await waitFor("minted prompt", () => connectEl.dataset.state === "done" && !connectEl.hasAttribute("data-mint-busy"));
      const prompt = connectEl.querySelector('[data-slot="prompt"]').textContent;
      const copy = connectEl.querySelector('[data-action="copy"]');
      copy.click();
      await waitFor("copy", () => clipboardText !== null);
      report({ requests, unexpected, terminalHook, generateLabel, choiceHidden, prompt,
        clipboard: clipboardText, guideHref: guide ? new URL(guide.getAttribute("href"), location.href).pathname : null,
        copyStatus: connectEl.querySelector('[data-slot="copy-status"]').textContent });
    })().catch(error => report({ error: String(error), stage, requests, unexpected,
      connectState: connectEl?.dataset.state,
      formError: connectEl?.querySelector('[data-slot="form-error"]')?.textContent }));
  </script>`;
  const html = `<!doctype html><html><head><style>${picker.css}\n${connect.css}</style>${setup}</head><body>`
    + `<main data-fixture-app>`
    + `<section data-channel-view="agent-choice">${picker.markup}</section>`
    + `<section data-channel-view="connect" hidden><p data-connect-exit-status hidden></p>${connect.markup}</section>`
    + `</main>${dashboardScope}${observe}</body></html>`;
  const bundles: Record<string, string> = { "/picker.js": picker.browserBundle, "/connect.js": connect.browserBundle };
  const unexpectedServerRequests: string[] = [];
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/__observer-tick") {
      setTimeout(() => { response.writeHead(204); response.end(); }, 20);
    } else if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html" }); response.end(html);
    } else if (request.method === "GET" && request.url && bundles[request.url]) {
      response.writeHead(200, { "Content-Type": "text/javascript" }); response.end(bundles[request.url]);
    } else {
      unexpectedServerRequests.push(`${request.method} ${(request.url ?? "").split("?")[0]}`);
      response.writeHead(404); response.end();
    }
  });
  const root = await realpath(tmpdir()), profile = await mkdtemp(join(root, "cswarm-grok-browser."));
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address(); assert.ok(address && typeof address === "object");
    const { stdout } = await launchChrome(await findChrome(), [
      `--user-data-dir=${profile}`, "--virtual-time-budget=15000", "--dump-dom", `http://127.0.0.1:${address.port}/`,
    ], { maxBuffer: 10 * 1024 * 1024, timeout: 30000, killSignal: "SIGKILL" });
    const encoded = stdout.match(/^\s*(?:<!doctype html>\s*)?<html\b[^>]*\bdata-grok-observation="([A-Za-z0-9+/]+={0,2})"/iu)?.[1];
    assert.ok(encoded, "the real picker and connect elements must report browser observations");
    const result = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.deepEqual(result.unexpected, []); assert.deepEqual(unexpectedServerRequests, []);
    assert.equal(result.terminalHook, true, "positive control: Terminal chip keeps the same hook");
    assert.equal(result.generateLabel, "Generate the setup prompt");
    assert.equal(result.choiceHidden, true, "Generate must leave the card view for the connect form");
    assert.equal(result.guideHref, "/guides/grok-bot");
    assert.ok(result.prompt.includes("Connect to CommonSwarm"), "the shown prompt is the generated setup prompt");
    assert.ok(result.prompt.includes(principalId), "the prompt is generated for the minted principal");
    assert.equal(result.clipboard, result.prompt, "Copy must put the actual generated prompt on the clipboard");
    const commands = result.requests.filter((r: { url: string }) => new URL(r.url).pathname === "/functions/v1/command");
    assert.deepEqual(commands.map((r: { body: { command: { kind: string } } }) => r.body.command.kind),
      ["create_agent_principal", "mint_agent_token"]);
    assert.equal(commands[0].body.command.name, agentName);
    assert.equal(commands[0].body.workspace_id, workspaceId);
    assert.equal(commands[1].body.command.principal_id, principalId);
    assert.equal(commands[1].body.command.device_id, deviceId);
    assert.equal(commands[1].body.command.renewal_kind, "standing");
  } finally {
    try {
      if (server.listening) {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }
    } finally {
      const resolved = await realpath(profile);
      assert.ok(dirname(resolved) === root && basename(resolved).startsWith("cswarm-grok-browser.") && resolved !== process.env.HOME);
      execFileSync("rm", ["-r", resolved], { stdio: "pipe" });
    }
  }
});
