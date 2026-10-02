// Run in a fresh child so ESM caches cannot hide an OFF-mode import.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";

const enabled = process.env.MCP_OAUTH_PUBLIC_AUTHORIZATION_ENABLED === "1";
const userId = "20000000-0000-4000-8000-000000000001";
const grantId = "30000000-0000-4000-8000-000000000001";
const workspaceId = "40000000-0000-4000-8000-000000000001";
const serverUrl = new URL("../../src/server.js", import.meta.url).href;
const consentUrl = new URL("../../src/consent.js", import.meta.url).href;
const probe = { bundleLoads: 0, pools: 0, ends: 0, transactions: [], queries: [] };
globalThis.managementProbe = probe;
const moduleUrl = (source) => `data:text/javascript,${encodeURIComponent(source)}`;
const postgresStub = moduleUrl(`
  export default function postgres(_url, options) {
    const probe = globalThis.managementProbe;
    probe.pools += 1;
    probe.max = options.max;
    probe.ssl = options.ssl;
    async function sql(strings, ...values) {
      const text = strings.join("?").replace(/\\s+/gu, " ").trim();
      probe.queries.push({ text, values });
      if (text.includes("INSERT INTO swarm.users")) return [{ user_id: values[0], email: null }];
      // There is no grant in this database: the real handler must refuse it.
      if (text.includes("FROM swarm.hosted_mcp_grants")) return [];
      if (text.includes("set_config(")) return [];
      throw new Error("unexpected management SQL");
    }
    sql.begin = async (isolation, callback) => {
      probe.transactions.push(isolation);
      return await callback(sql);
    };
    sql.end = async () => { probe.ends += 1; };
    return sql;
  }
`);
const httpStub = moduleUrl(`
  import { EventEmitter } from "node:events";
  export function createServer(handler) {
    const server = new EventEmitter();
    server.listen = (_port, _host, callback) => { queueMicrotask(callback); return server; };
    server.close = () => server.emit("close");
    globalThis.managementProbe.httpHandler = handler;
    return server;
  }
`);
// Observe the binding where production passes it to the real orchestrator.
// The command implementation and its database calls are never mocked.
const consentObserver = moduleUrl(`
  import { createConsentOrchestrator as original } from ${JSON.stringify(consentUrl)};
  export { createPostgresConsentProgress } from ${JSON.stringify(consentUrl)};
  export function createConsentOrchestrator(options) {
    globalThis.managementProbe.command = options.command;
    return original(options);
  }
`);
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "postgres") return { url: postgresStub, shortCircuit: true };
    if (context.parentURL === serverUrl && specifier === "node:http") {
      return { url: httpStub, shortCircuit: true };
    }
    if (context.parentURL === serverUrl && specifier === "./consent.js") {
      return { url: consentObserver, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith("/management-command.generated.js")) probe.bundleLoads += 1;
    return nextLoad(url, context);
  },
});

const { startProductionServer } = await import(serverUrl);
const running = await startProductionServer();
try {
  assert.equal(probe.pools, 0, "startup must not allocate a management pool");
  if (enabled) {
    assert.equal(probe.bundleLoads, 1);
    assert.equal(typeof probe.command, "function", "entrypoint must supply the command to consent");
    const result = await probe.command({
      workspace_id: workspaceId,
      command_id: "50000000-0000-4000-8000-000000000001",
      stream: { kind: "workspace" },
      command: { kind: "revoke_hosted_mcp_grant", grant_id: grantId },
    }, { userId, displayName: "Fixture", email: null, identityVerified: true, interactiveAuthAtSeconds: null });
    assert.deepEqual(result, { status: 403, body: { error: "forbidden" } });
    assert.equal(probe.pools, 1);
    assert.equal(probe.max, 2, "management pool must cap at two connections");
    assert.deepEqual(probe.ssl, {
      ca: readFileSync(process.env.MCP_OAUTH_DATABASE_TLS_CA_FILE, "utf8").trim(),
      servername: "db.commonswarm.internal",
      rejectUnauthorized: true,
    }, "real bundled postgres client must receive the CA and verified TLS servername");
    assert.deepEqual(probe.transactions, ["isolation level read committed"]);
    assert.ok(probe.queries.some(({ text }) => text.includes("'swarm_command'")));
    assert.ok(probe.queries.some(({ text, values }) => text.includes("INSERT INTO swarm.users") && values[0] === userId));
    assert.ok(probe.queries.some(({ text, values }) => text.includes("FROM swarm.hosted_mcp_grants") && values[0] === grantId));
    console.log("enabled production entrypoint: real bundled revoke refuses missing grant; lazy max-2 pool PASS");
  } else {
    assert.equal(probe.bundleLoads, 0, "OFF must not import the management bundle");
    assert.equal(probe.command, undefined);
    assert.equal(probe.pools, 0);
    assert.deepEqual(probe.queries, []);
    console.log("disabled production entrypoint: zero management bundle imports, pools or queries PASS");
  }
} finally {
  running.server.close();
  await running.pool.end();
}
assert.equal(probe.ends, enabled ? 1 : 0, "close must release only an allocated management pool");
