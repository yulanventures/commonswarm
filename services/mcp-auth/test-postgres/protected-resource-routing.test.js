import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createMcpProtocolHandler } from "../../../supabase/functions/mcp/protocol.ts";

// Real Caddy routing and the real edge protocol owner; no mocked metadata body.
// The canonical Linux test:postgres glob owns this transport regression.
test("Caddy root and path-qualified resource discovery share the protected resource contract", { timeout: 15_000 }, async t => {
  const located = spawnSync("/bin/sh", ["-c", "command -v caddy"], { encoding: "utf8" });
  const candidate = process.env.C1_CADDY_BINARY || located.stdout.trim();
  if (!candidate) {
    assert.notEqual(process.env.CI, "true", "canonical CI requires Caddy");
    t.skip("Caddy unavailable locally; canonical Linux gate required");
    return;
  }
  const binary = realpathSync(candidate);
  const paths = ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"];
  const serve = createMcpProtocolHandler({ issuer: "https://mcp.commonswarm.com",
    resource: "https://mcp.commonswarm.com/mcp", publicEnabled: true, allowedOrigins: new Set(),
    limits: { maxBodyBytes: 1024, maxResponseBytes: 4096, requestTimeoutMs: 1000, maxConcurrentRequests: 2 },
    verifyToken: async () => { throw new Error("metadata must not require credentials"); },
    executeTool: async () => { throw new Error("metadata must not execute a tool"); },
  });
  const upstream = createServer(async (req, res) => {
    const path = new URL(req.url, "http://localhost").pathname.replace(/^\/functions\/v1/u, "");
    const response = await serve(new Request(`http://localhost${path}`, { method: req.method }));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const root = realpathSync(tmpdir());
  const directory = realpathSync(mkdtempSync(join(root, "dcr-metadata-")));
  t.after(() => {
    assert.equal(dirname(directory), root);
    assert.match(directory.slice(root.length + 1), /^dcr-metadata-[A-Za-z0-9]{6}$/u);
    const cleanup = spawnSync("rm", ["-r", "--", directory], { encoding: "utf8" });
    assert.equal(cleanup.status, 0, `fixture cleanup refused ${directory}: ${cleanup.stderr}`);
  });
  const source = readFileSync(new URL("../../../deploy/supabase-stack/commonswarm-mcp.caddy", import.meta.url), "utf8");
  const snippet = source.slice(source.indexOf("(mcp_resource_active) {"), source.indexOf("\nmcp.commonswarm.com {"))
    .replaceAll("127.0.0.1:9000", `127.0.0.1:${upstream.address().port}`);
  assert.ok(snippet.startsWith("(mcp_resource_active) {"));
  const config = join(directory, "Caddyfile");
  writeFileSync(config, `{\n admin off\n auto_https off\n}\n${snippet}\nhttp://127.0.0.1:${port} {\n route {\n import mcp_resource_active\n respond 404\n }\n}\n`);
  const child = spawn(binary, ["run", "--config", config, "--adapter", "caddyfile"], { stdio: "ignore" });
  const stopped = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await stopped;
  });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    assert.equal(child.exitCode, null, "fixture Caddy must start");
    try { await fetch(`http://127.0.0.1:${port}/ready`, { signal: AbortSignal.timeout(100) }); ready = true; break; }
    catch { await delay(20); }
  }
  assert.ok(ready);
  for (const path of paths) {
    const url = `http://127.0.0.1:${port}${path}`;
    const response = await fetch(url);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get("content-type"), /^application\/json\b/u);
    const body = await response.json();
    assert.equal(body.resource, "https://mcp.commonswarm.com/mcp");
    assert.deepEqual(body.authorization_servers, ["https://mcp.commonswarm.com"]);
    assert.deepEqual(body.scopes_supported, ["mcp"]);
    const head = await fetch(url, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    const refused = await fetch(url, { method: "POST" });
    assert.equal(refused.status, 405);
    assert.match(refused.headers.get("content-type"), /^application\/json\b/u);
    assert.deepEqual(await refused.json(), { error: "method_not_allowed" });
  }
  const protectedResponse = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST" });
  assert.equal(protectedResponse.status, 401);
  assert.match(protectedResponse.headers.get("www-authenticate"), /resource_metadata=/u);
});
