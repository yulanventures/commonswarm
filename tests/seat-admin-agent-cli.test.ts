import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseAgentConnection } from "../src/cloud/agent-profile.js";
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
  assert.deepEqual(seatAdminStatusLines({ enabled: true, registry_version: 3, grants: [], ended: [] }), ["No admin access."]);
  const grant = { grant_id: "g", scope_names: [], capability_names: ["rename_workspace"] };
  assert.deepEqual(seatAdminStatusLines({ enabled: true, registry_version: 3, grants: [
    { ...grant, level: "workspace", workspace_ids: [workspace], organization_id: null, expires_at: null },
    { ...grant, level: "organization", workspace_ids: [], organization_id: agent, expires_at: "2026-12-01T00:00:00Z" },
  ], ended: [] }), [`workspace · workspaces ${workspace} · no end date`, `organization · organization ${agent} · ends 2026-12-01T00:00:00Z`]);
});

test("status lines: each ended grant says when, by whom and why, after the active grants", () => {
  const ended = { level: "workspace" as const, workspace_ids: [workspace], organization_id: null };
  assert.deepEqual(seatAdminStatusLines({ enabled: true, registry_version: 3, grants: [], ended: [
    { ...ended, grant_id: "6a615ba4-0000-4000-8000-000000000001", state: "downgraded", end_reason: "owner_downgrade",
      ended_at: "2026-11-17T21:04:09.123456+00:00", ended_by: "owner" },
    { ...ended, grant_id: "7b726cb5-0000-4000-8000-000000000002", state: "downgraded", end_reason: "owner_downgrade",
      ended_at: "2026-11-16T08:00:00Z", ended_by: "another_owner" },
    { ...ended, level: "organization", workspace_ids: [], organization_id: agent, grant_id: "8c837dc6-0000-4000-8000-000000000003",
      state: "expired", end_reason: "expired", ended_at: "2026-11-15T23:59:59.999Z", ended_by: null },
  ] }), [
    "No admin access.",
    "Ended 2026-11-17 21:04Z by the owner (owner_downgrade): workspace grant 6a615ba4",
    "Ended 2026-11-16 08:00Z by another owner (owner_downgrade): workspace grant 7b726cb5",
    "Ended 2026-11-15 23:59Z (expired): organization grant 8c837dc6",
  ]);
});

test("the self read names the selected workspace and uses the agent bearer", async () => {
  const ended = [{ grant_id: "g", level: "workspace", workspace_ids: [workspace], organization_id: null, state: "downgraded",
    end_reason: "owner_downgrade", ended_at: "2026-11-17T21:04:00Z", ended_by: "owner" }];
  const { calls, fetcher } = recorder([reply(200, { enabled: false }), reply(200, { enabled: true, registry_version: 3, grants: [] }),
    reply(200, { enabled: true, registry_version: 3, grants: [], ended }), reply(403, { error: "forbidden" })]);
  assert.deepEqual(await readSeatAdminSelf(target, "swm_agent", workspace, fetcher), { enabled: false });
  assert.deepEqual(await readSeatAdminSelf(target, "swm_agent", workspace, fetcher), { enabled: true, registry_version: 3, grants: [], ended: [] },
    "a server without the ended list");
  assert.deepEqual(await readSeatAdminSelf(target, "swm_agent", workspace, fetcher), { enabled: true, registry_version: 3, grants: [], ended });
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
  for (const name of ["status", "rename-workspace", "set-lead", "add-agent", "remove-agent", "remove-member", "revoke-invitation", "rename-organization",
    "create-seat"]) {
    const entry = group.subcommands[name]!;
    assert.equal(entry.profile, "native", name);
    assert.equal(entry.tool, null, name);
    assert.ok(!entry.flags.some(flag => ["agent-token-file", "agent-token-stdin", "url", "anon-key"].includes(flag)), name);
  }
  assert.ok(group.subcommands["remove-member"]!.flags.includes("confirm"));
  assert.ok(["out-connection-file", "setup-profile", "seat-host-session-id", "host-session-id", "request-id"].every(flag => group.subcommands["create-seat"]!.flags.includes(flag)));
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

/* ---- create-seat ---- */
const SEAT = "33333333-3333-4333-8333-333333333333";
const SEAT_TOKEN = `swm_agt_${"S".repeat(43)}`;
const created = (patch: Record<string, unknown> = {}) => ({ status: "accepted", ok: true, event_ids: ["e1", "e2"], principal_id: SEAT,
  run_id: "44444444-4444-4444-8444-444444444444", token_id: "55555555-5555-4555-8555-555555555555", workspace_id: workspace,
  expires_at: "2099-01-01T00:00:00.000Z", agent_token: SEAT_TOKEN, ...patch });

test("create-seat: the name follows the server's rule; the destination is checked before any request", async () => {
  assert.equal(seatAdmin.seatAdminSeatName("  Research bot "), "Research bot");
  assert.throws(() => seatAdmin.seatAdminSeatName(""), /required/);
  assert.throws(() => seatAdmin.seatAdminSeatName("x".repeat(81)), /at most 80/);
  assert.throws(() => seatAdmin.seatAdminSeatName("bad‮name"), /control/);
  const root = await mkdtemp(join(tmpdir(), "seat-create-"));
  try {
    const caller = join(root, "caller", "profile.json");
    await assert.rejects(seatAdmin.prepareSeatDestination({ callerProfile: caller }), /exactly one/);
    await assert.rejects(seatAdmin.prepareSeatDestination({ callerProfile: caller, connectionFile: join(root, "a.json"),
      setupProfile: join(root, "b", "profile.json") }), /exactly one/);
    await assert.rejects(seatAdmin.prepareSeatDestination({ callerProfile: caller, connectionFile: "relative.json" }), /absolute/i);
    await writeFile(join(root, "taken.json"), "{}", { mode: 0o600 });
    await assert.rejects(seatAdmin.prepareSeatDestination({ callerProfile: caller, connectionFile: join(root, "taken.json") }), /already exists/);
    await assert.rejects(seatAdmin.prepareSeatDestination({ callerProfile: caller, setupProfile: join(root, "new", "profile.json") }),
      /--seat-host-session-id/);
    await assert.rejects(seatAdmin.prepareSeatDestination({ callerProfile: caller, setupProfile: join(root, "caller", "other.json"),
      seatHostSessionId: "manual" }), /own directory/);
    const setup = await seatAdmin.prepareSeatDestination({ callerProfile: caller, setupProfile: join(root, "new", "profile.json"), seatHostSessionId: "manual" });
    assert.equal(setup.kind, "setup");
    assert.deepEqual(await seatAdmin.prepareSeatDestination({ callerProfile: caller, connectionFile: join(root, "seat.json") }),
      { kind: "connection", path: join(root, "seat.json") });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("create-seat: the token goes only into a new 0600 file; the result, refusals and failures never carry it", async () => {
  const root = await mkdtemp(join(tmpdir(), "seat-create-"));
  try {
    const file = join(root, "seat.json");
    const destination = { kind: "connection" as const, path: file };
    const run = (fetcher: typeof fetch, extra: Record<string, unknown> = {}) => seatAdmin.createSeatAdminSeat({ target, token: "swm_agent", fetcher,
      workspaceId: workspace, name: "Research bot", commandId: "req-create-0001", destination, ...extra });

    const fresh = recorder([reply(200, created())]);
    const result = await run(fresh.fetcher);
    assert.deepEqual(result, { principal_id: SEAT, name: "Research bot", workspace_id: workspace, connection_file: file });
    assert.ok(!JSON.stringify(result).includes(SEAT_TOKEN), "the result never carries the token");
    assert.deepEqual(fresh.calls[0]!.body.command, { kind: "create_agent_seat", name: "Research bot" });
    assert.equal(fresh.calls[0]!.body.command_id, "req-create-0001");
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    const saved = parseAgentConnection(await readFile(file, "utf8"));
    assert.equal(saved.principal_id, SEAT);
    assert.equal(saved.workspace_id, workspace);
    assert.equal((saved.credential as { agent_token: string }).agent_token, SEAT_TOKEN, "the file is a connection setup accepts");

    // An existing file is never replaced: the seat exists, the credential is not saved, and the error says how to recover.
    const again = recorder([reply(200, created())]);
    await assert.rejects(run(again.fetcher), (error: unknown) => error instanceof seatAdmin.SeatAdminDeliveryFailed
      && error.commandId === "req-create-0001" && !error.message.includes(SEAT_TOKEN) && /--request-id req-create-0001/.test(error.message));
    assert.equal(parseAgentConnection(await readFile(file, "utf8")).principal_id, SEAT, "the first file is untouched");
    const failed = recorder([reply(200, created())]);
    await assert.rejects(seatAdmin.createSeatAdminSeat({ target, token: "swm_agent", fetcher: failed.fetcher, workspaceId: workspace,
      name: "Research bot", commandId: "req-create-0002", destination: { kind: "connection", path: join(root, "other.json") },
      writeFile: async () => { throw Object.assign(new Error(`disk full ${SEAT_TOKEN}`), { code: "ENOSPC" }); } }),
      (error: unknown) => error instanceof seatAdmin.SeatAdminDeliveryFailed && !error.message.includes(SEAT_TOKEN));
    const refusal = seatAdminRefusal(new seatAdmin.SeatAdminDeliveryFailed("req-create-0002", SEAT), seatAdmin)!;
    assert.equal(refusal.error, "credential_not_saved");
    assert.ok(!JSON.stringify(refusal).includes(SEAT_TOKEN));

    // A server refusal carries its code and message, nothing else.
    const refused = recorder([reply(403, { error: "seat_admin_seat_limit_reached", message: SEAT_ADMIN_REFUSAL_COPY.seat_admin_seat_limit_reached })]);
    await assert.rejects(seatAdmin.createSeatAdminSeat({ target, token: "swm_agent", fetcher: refused.fetcher, workspaceId: workspace,
      name: "Research bot", commandId: "req-create-0003", destination: { kind: "connection", path: join(root, "third.json") } }),
      (error: unknown) => error instanceof CommandHttpError && error.code === "seat_admin_seat_limit_reached");
    await assert.rejects(stat(join(root, "third.json")), /ENOENT/, "a refusal writes nothing");

    // A lost answer is sent once more with the same id; the server answers with a replacement credential.
    const lost = recorder([new TypeError("socket"), reply(200, created({ token_id: "66666666-6666-4666-8666-666666666666" }))]);
    await seatAdmin.createSeatAdminSeat({ target, token: "swm_agent", fetcher: lost.fetcher, workspaceId: workspace, name: "Research bot",
      commandId: "req-create-0004", destination: { kind: "connection", path: join(root, "fourth.json") } });
    assert.deepEqual(lost.calls[0]!.body, lost.calls[1]!.body);

    // An answer for another workspace, or without a credential, saves nothing.
    const wrong = recorder([reply(200, created({ workspace_id: agent }))]);
    await assert.rejects(seatAdmin.createSeatAdminSeat({ target, token: "swm_agent", fetcher: wrong.fetcher, workspaceId: workspace,
      name: "Research bot", commandId: "req-create-0005", destination: { kind: "connection", path: join(root, "fifth.json") } }), /did not describe/);
    const tokenless = recorder([reply(200, created({ agent_token: undefined }))]);
    await assert.rejects(seatAdmin.createSeatAdminSeat({ target, token: "swm_agent", fetcher: tokenless.fetcher, workspaceId: workspace,
      name: "Research bot", commandId: "req-create-0006", destination: { kind: "connection", path: join(root, "sixth.json") } }),
      (error: unknown) => error instanceof seatAdmin.SeatAdminDeliveryFailed);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("create-seat --setup-profile: setup runs from the saved file, which is then removed; a failed setup keeps it", async () => {
  const root = await mkdtemp(join(tmpdir(), "seat-create-"));
  try {
    const profilePath = join(root, "new", "profile.json"), connectionPath = join(root, "new", "seat-connection.json");
    const destination = { kind: "setup" as const, profilePath, connectionPath, hostSessionId: "manual" };
    const seen: Array<{ connectionFile: string; profilePath: string; hostSessionId: string }> = [];
    const ok = recorder([reply(200, created())]);
    const result = await seatAdmin.createSeatAdminSeat({ target, token: "swm_agent", fetcher: ok.fetcher, workspaceId: workspace, name: "Research bot",
      commandId: "req-setup-0001", destination, setup: async (options) => {
        seen.push(options);
        assert.equal(parseAgentConnection(await readFile(options.connectionFile, "utf8")).principal_id, SEAT);
      } });
    assert.deepEqual(result, { principal_id: SEAT, name: "Research bot", workspace_id: workspace, profile_path: profilePath });
    assert.deepEqual(seen, [{ connectionFile: connectionPath, profilePath, hostSessionId: "manual" }]);
    await assert.rejects(stat(connectionPath), /ENOENT/, "the second copy of the credential is gone");

    const bad = recorder([reply(200, created())]);
    await assert.rejects(seatAdmin.createSeatAdminSeat({ target, token: "swm_agent", fetcher: bad.fetcher, workspaceId: workspace, name: "Research bot",
      commandId: "req-setup-0002", destination, setup: async () => { throw new Error(`boom ${SEAT_TOKEN}`); } }),
      (error: unknown) => error instanceof seatAdmin.SeatAdminSetupFailed && error.message.includes(connectionPath) && !error.message.includes(SEAT_TOKEN));
    assert.equal((await stat(connectionPath)).mode & 0o777, 0o600, "kept for cswarm setup");
  } finally { await rm(root, { recursive: true, force: true }); }
});
