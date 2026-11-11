import assert from "node:assert/strict";
import { test } from "node:test";
import {
  readSeatAdminSelf, SeatAdminOutcomeUnknown, SeatAdminRejected, seatAdminCommand, seatAdminConfirmation,
  seatAdminRequestId, seatAdminStatusLines, sendSeatAdminCommand,
} from "../src/cloud/seat-admin.js";
import * as seatAdmin from "../src/cloud/seat-admin.js";
import { CommandHttpError } from "../src/cloud/command-client.js";
import { SEAT_ADMIN_REFUSAL_COPY } from "../src/protocol/seat-admin.js";
import { SEAT_ADMIN_MCP_TOOLS, seatAdminMcpCommand } from "../src/mcp/seat-admin-tools.js";
import { MCP_TOOLS, STDIO_MCP_TOOLS } from "../src/mcp/tools.js";
import { AGENT_COMMANDS, agentToolsForTransport, seatAdminRefusal, type AgentCommandGroup } from "../src/cli.js";

const target = { url: "https://api.example.test", anonKey: "anon", profileId: "p" };
const workspace = "11111111-1111-4111-8111-111111111111";
const agent = "22222222-2222-4222-8222-222222222222";

function recorder(replies: Array<Response | Error>) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    const next = replies.shift();
    if (next === undefined) throw new Error("no more replies");
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

test("each verb sends exactly one command kind, with ids only", () => {
  assert.deepEqual(seatAdminCommand("rename-workspace", "  Ops  "), { kind: "rename_workspace", name: "Ops" });
  assert.deepEqual(seatAdminCommand("rename-organization", "Acme"), { kind: "rename_organization", display_name: "Acme" });
  assert.deepEqual(seatAdminCommand("set-lead", "none"), { kind: "set_workspace_lead", principal_id: null });
  assert.deepEqual(seatAdminCommand("set-lead", agent.toUpperCase()), { kind: "set_workspace_lead", principal_id: agent });
  assert.deepEqual(seatAdminCommand("add-agent", agent), { kind: "add_agent_to_workspace", principal_id: agent });
  assert.deepEqual(seatAdminCommand("remove-agent", agent), { kind: "remove_agent_from_workspace", principal_id: agent });
  assert.deepEqual(seatAdminCommand("remove-member", agent), { kind: "remove_member", user_id: agent });
  assert.deepEqual(seatAdminCommand("revoke-invitation", agent), { kind: "revoke_invitation", invitation_id: agent });
  for (const verb of ["add-agent", "remove-agent", "remove-member", "revoke-invitation", "set-lead"] as const) {
    assert.throws(() => seatAdminCommand(verb, "Research bot"), /Use the full/, verb);
  }
  assert.throws(() => seatAdminCommand("rename-workspace", ""), /required/);
  assert.throws(() => seatAdminCommand("rename-organization", "x".repeat(81)), /at most 80/);
  assert.equal(seatAdminConfirmation({ kind: "set_workspace_lead", principal_id: null }), "Workspace lead cleared.");
  assert.equal(seatAdminConfirmation({ kind: "rename_workspace", name: "Ops" }), "Workspace renamed to Ops.");
  assert.match(seatAdminRequestId(undefined), /^cmd_/);
  assert.equal(seatAdminRequestId("retry-0001"), "retry-0001");
  assert.throws(() => seatAdminRequestId("bad id"), /--request-id/);
});

test("status lines: off, no grants, one line per grant", () => {
  assert.deepEqual(seatAdminStatusLines({ enabled: false }), ["Admin access is off."]);
  assert.deepEqual(seatAdminStatusLines({ enabled: true, registry_version: 3, grants: [] }), ["No admin access."]);
  const grant = { grant_id: "g", scope_names: [], capability_names: ["rename_workspace"] };
  assert.deepEqual(seatAdminStatusLines({ enabled: true, registry_version: 3, grants: [
    { ...grant, level: "workspace", workspace_ids: [workspace], organization_id: null, expires_at: null },
    { ...grant, level: "organization", workspace_ids: [], organization_id: agent, expires_at: "2026-12-01T00:00:00Z" },
  ] }), [`workspace · workspaces ${workspace} · no end date`, `organization · organization ${agent} · ends 2026-12-01T00:00:00Z`]);
});

test("the self read names the selected workspace and uses the agent bearer", async () => {
  const { calls, fetcher } = recorder([reply(200, { enabled: false }), reply(200, { enabled: true, registry_version: 3, grants: [] }), reply(403, { error: "forbidden" })]);
  assert.deepEqual(await readSeatAdminSelf(target, "swm_agent", workspace, fetcher), { enabled: false });
  assert.deepEqual(await readSeatAdminSelf(target, "swm_agent", workspace, fetcher), { enabled: true, registry_version: 3, grants: [] });
  await assert.rejects(readSeatAdminSelf(target, "swm_agent", workspace, fetcher), /HTTP 403/);
  assert.equal(calls[0]!.url, "https://api.example.test/functions/v1/read");
  assert.equal(calls[0]!.headers.authorization, "Bearer swm_agent");
  assert.deepEqual(calls[0]!.body, { resource: "seat_admin_self", workspace_id: workspace });
});

test("a refusal keeps the server's code and message; an uncertain send repeats the same id and payload", async () => {
  const command = { kind: "rename_workspace", name: "Ops" } as const;
  const send = (fetcher: typeof fetch) => sendSeatAdminCommand({ target, token: "swm_agent", fetcher, workspaceId: workspace, command, commandId: "cmd_fixed_0001" });
  const refused = recorder([reply(403, { error: "seat_admin_scope_missing", message: SEAT_ADMIN_REFUSAL_COPY.seat_admin_scope_missing })]);
  await assert.rejects(send(refused.fetcher), (error: unknown) => error instanceof CommandHttpError && error.status === 403 &&
    error.code === "seat_admin_scope_missing" && error.message === SEAT_ADMIN_REFUSAL_COPY.seat_admin_scope_missing);
  assert.deepEqual(refused.calls[0]!.body.stream, { kind: "workspace" });
  assert.equal(refused.calls[0]!.body.workspace_id, workspace);
  assert.deepEqual(refused.calls[0]!.body.command, command);

  const lost = recorder([new TypeError("socket"), new TypeError("socket")]);
  await assert.rejects(send(lost.fetcher), (error: unknown) => error instanceof SeatAdminOutcomeUnknown && error.commandId === "cmd_fixed_0001");
  assert.equal(lost.calls.length, 2);
  assert.deepEqual(lost.calls[0]!.body, lost.calls[1]!.body);
  assert.equal(lost.calls[1]!.body.command_id, "cmd_fixed_0001");

  const retried = recorder([new TypeError("socket"), reply(200, { status: "accepted", ok: true, event_ids: ["e1"] })]);
  assert.deepEqual((await send(retried.fetcher)).event_ids, ["e1"]);

  const rejected = recorder([reply(200, { status: "rejected", ok: false, reason: "invalid_name", event_ids: [] })]);
  await assert.rejects(send(rejected.fetcher), (error: unknown) => error instanceof SeatAdminRejected && error.code === "invalid_name");
});

test("CLI refusal output: server message, else code; unknown outcome names the request id", () => {
  assert.deepEqual(seatAdminRefusal(new CommandHttpError(403, SEAT_ADMIN_REFUSAL_COPY.seat_admin_inactive, "seat_admin_inactive"), seatAdmin),
    { error: "seat_admin_inactive", message: SEAT_ADMIN_REFUSAL_COPY.seat_admin_inactive });
  assert.deepEqual(seatAdminRefusal(new CommandHttpError(403, "forbidden", "forbidden"), seatAdmin), { error: "forbidden", message: "forbidden" });
  assert.deepEqual(seatAdminRefusal(new SeatAdminRejected("invalid_name"), seatAdmin), { error: "invalid_name", message: "invalid_name" });
  assert.match(seatAdminRefusal(new SeatAdminOutcomeUnknown("cmd_x_000001"), seatAdmin)!.message, /--request-id cmd_x_000001/);
  assert.equal(seatAdminRefusal(new CommandHttpError(500, "boom", "internal"), seatAdmin), null);
});

test("cswarm admin: agent subcommands open the profile natively and are never registry tools", () => {
  const group = AGENT_COMMANDS.admin as AgentCommandGroup;
  for (const name of ["status", "rename-workspace", "set-lead", "add-agent", "remove-agent", "remove-member", "revoke-invitation", "rename-organization"]) {
    const entry = group.subcommands[name]!;
    assert.equal(entry.profile, "native", name);
    assert.equal(entry.tool, null, name);
    assert.ok(!entry.flags.some(flag => ["agent-token-file", "agent-token-stdin", "url", "anon-key"].includes(flag)), name);
  }
  assert.ok(group.subcommands["remove-member"]!.flags.includes("confirm"));
  for (const name of ["grants", "history", "revoke"]) assert.equal(group.subcommands[name]!.profile, "refuse", name);
  for (const transport of ["http", "stdio"] as const) assert.ok(!agentToolsForTransport(transport).some(tool => tool.name.startsWith("admin")));
});

test("MCP admin tools: separate from the static catalog, ids only, request_id required on writes", () => {
  assert.deepEqual(SEAT_ADMIN_MCP_TOOLS.map(tool => tool.name), ["admin_status", "admin_rename_workspace", "admin_set_lead", "admin_add_agent",
    "admin_remove_agent", "admin_remove_member", "admin_revoke_invitation", "admin_rename_organization"]);
  assert.ok(!STDIO_MCP_TOOLS.some(tool => tool.name.startsWith("admin_")));
  assert.ok(!MCP_TOOLS.some(tool => tool.name.startsWith("admin_")));
  for (const tool of SEAT_ADMIN_MCP_TOOLS) {
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.ok("workspace_id" in tool.inputSchema.properties, tool.name);
  }
  assert.equal(seatAdminMcpCommand("admin_status", {}), null);
  assert.throws(() => seatAdminMcpCommand("admin_status", { profile: "/x" }), /Unknown argument/);
  assert.deepEqual(seatAdminMcpCommand("admin_set_lead", { principal_id: "none", request_id: "req-00000001" }),
    { command: { kind: "set_workspace_lead", principal_id: null }, requestId: "req-00000001" });
  assert.deepEqual(seatAdminMcpCommand("admin_remove_member", { user_id: agent, request_id: "req-00000002" }),
    { command: { kind: "remove_member", user_id: agent }, requestId: "req-00000002" });
  assert.throws(() => seatAdminMcpCommand("admin_add_agent", { principal_id: agent }), /Missing argument: request_id/);
  assert.throws(() => seatAdminMcpCommand("admin_add_agent", { principal_id: "Research bot", request_id: "req-00000003" }), /Invalid argument: principal_id/);
  assert.throws(() => seatAdminMcpCommand("admin_rename_workspace", { name: "Ops", request_id: "no" }), /Invalid argument: request_id/);
});
