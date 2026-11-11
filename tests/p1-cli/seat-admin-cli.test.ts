import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AGENT_CREDENTIAL_MESSAGE_D088 } from "../../src/cloud/agent-credential-input.js";
import { saveAgentProfile } from "../../src/cloud/agent-profile.js";
import { SEAT_ADMIN_REFUSAL_COPY } from "../../src/protocol/seat-admin.js";

const WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TOKEN = `swm_agt_${"A".repeat(43)}`;
const CLI = process.env.CSWARM_TEST_CLI ?? resolve("dist/cli.js");

test("cswarm admin and the local MCP admin tools use the agent's own profile and self read", { timeout: 60_000 }, async () => {
  let enabled = false;
  const bodies: Array<Record<string, unknown>> = [];
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", chunk => raw += chunk);
    request.on("end", () => {
      const body = JSON.parse(raw) as Record<string, unknown> & { command?: { kind?: string } };
      bodies.push(body);
      const send = (status: number, value: unknown) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
      if (body.resource === "seat_admin_self") {
        return send(200, enabled ? { enabled: true, registry_version: 3, grants: [{ grant_id: "g", level: "workspace", scope_names: [],
          workspace_ids: [WS], organization_id: null, capability_names: ["rename_workspace"], expires_at: null }] } : { enabled: false });
      }
      if (body.command?.kind === "rename_workspace") return send(200, { status: "accepted", ok: true, event_ids: ["e1"] });
      if (body.command?.kind === "add_agent_to_workspace") {
        return send(403, { error: "seat_admin_scope_missing", message: SEAT_ADMIN_REFUSAL_COPY.seat_admin_scope_missing });
      }
      return send(400, { error: "unexpected" });
    });
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const root = await mkdtemp(join(tmpdir(), "seat-admin-cli-"));
  const env = { PATH: process.env.PATH ?? "", HOME: root, XDG_CONFIG_HOME: join(root, "config"), SWARM_AGENT_STATE_DIR: join(root, "state") };
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  const profile = join(root, "profile.json");
  const cli = (args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>(done => {
    const child = spawn(process.execPath, [CLI, ...args], { env });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => stdout += chunk);
    child.stderr.on("data", chunk => stderr += chunk);
    child.on("close", code => done({ code, stdout, stderr }));
  });
  try {
    await saveAgentProfile(profile, { version: 1, url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, anon_key: "public-test",
      workspace_id: WS, principal_id: AGENT, credential: { message: AGENT_CREDENTIAL_MESSAGE_D088, status: "accepted", principal_id: AGENT,
        token_id: "11111111-1111-4111-8111-111111111111", run_id: "22222222-2222-4222-8222-222222222222", agent_token: TOKEN,
        expires_at: "2099-01-01T00:00:00.000Z" } }, undefined, "session-A");
    const own = ["--profile", profile, "--host-session-id", "session-A"];

    assert.equal((await cli(["admin", "status", ...own])).stdout, "Admin access is off.\n");
    enabled = true;
    assert.equal((await cli(["admin", "status", ...own])).stdout, `workspace · workspaces ${WS} · no end date\n`);
    assert.deepEqual(bodies.filter(body => body.resource !== undefined).at(-1), { resource: "seat_admin_self", workspace_id: WS });

    const renamed = await cli(["admin", "rename-workspace", "Ops", ...own, "--request-id", "req-00000001"]);
    assert.equal(renamed.code, 0);
    assert.equal(renamed.stdout, "Workspace renamed to Ops.\n");
    const sent = bodies.at(-1)!;
    assert.equal(sent.command_id, "req-00000001");
    assert.deepEqual(sent.command, { kind: "rename_workspace", name: "Ops" });
    assert.deepEqual(sent.stream, { kind: "workspace" });

    const refused = await cli(["admin", "add-agent", AGENT, ...own]);
    assert.equal(refused.code, 1);
    assert.equal(refused.stderr, `cswarm: ${SEAT_ADMIN_REFUSAL_COPY.seat_admin_scope_missing}\n`);
    const refusedJson = await cli(["admin", "add-agent", AGENT, ...own, "--json"]);
    assert.equal(refusedJson.code, 1);
    assert.deepEqual(JSON.parse(refusedJson.stdout), { error: "seat_admin_scope_missing", message: SEAT_ADMIN_REFUSAL_COPY.seat_admin_scope_missing });

    const before = bodies.length;
    assert.match((await cli(["admin", "remove-member", AGENT, "--confirm", "someone", ...own])).stderr, /--confirm must exactly repeat/);
    assert.match((await cli(["admin", "add-agent", "Research bot", ...own])).stderr, /Use the full agent principal ID/);
    assert.match((await cli(["admin", "status", "--profile", profile, "--host-session-id", "session-B"])).stderr, /belongs to another session/);
    assert.match((await cli(["admin", "status", "--agent-token-file", join(root, "token")])).stderr, /unknown option: --agent-token-file/);
    assert.match((await cli(["admin", "rename-workspace", "Ops"])).stderr, /--profile is required/);
    assert.equal(bodies.length, before, "refused before any request");

    for (const on of [false, true]) {
      enabled = on;
      const client = new Client({ name: "seat-admin-test", version: "1" });
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp", ...own], env, stderr: "pipe" }));
      try {
        const admin = (await client.listTools()).tools.map(tool => tool.name).filter(name => name.startsWith("admin_"));
        assert.deepEqual(admin, on ? ["admin_status", "admin_rename_workspace", "admin_set_lead", "admin_add_agent", "admin_remove_agent",
          "admin_remove_member", "admin_revoke_invitation", "admin_rename_organization"] : []);
        if (on) {
          const result = await client.callTool({ name: "admin_add_agent", arguments: { principal_id: AGENT, request_id: "req-00000002" } });
          assert.equal(result.isError, true);
          assert.deepEqual(JSON.parse((result.content as Array<{ text: string }>)[0]!.text),
            { code: "seat_admin_scope_missing", message: SEAT_ADMIN_REFUSAL_COPY.seat_admin_scope_missing, status: 403 });
        }
      } finally { await client.close(); }
    }
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});
