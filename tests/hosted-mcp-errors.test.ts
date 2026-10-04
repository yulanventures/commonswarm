import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error TS5097: exercise the Deno source through tsx.
import { createMcpProtocolHandler } from "../supabase/functions/mcp/protocol.ts";

// @ts-expect-error TS5097: exercise the production adapter through tsx.
import { commandOutput, readOutput, HostedToolFailure } from "../supabase/functions/mcp/tool-errors.ts";
import type { HostedToolExecutor } from "../supabase/functions/mcp/tools.ts";

const seat = "seat_ABCDEFGHIJKLMNOPQRSTUV";
const uuid = "11111111-1111-4111-8111-111111111111";
const base = { seat, body: "Hello", request_id: "request_123" };
function handler(executeTool: HostedToolExecutor = async () => ({ ok: true })) {
  return createMcpProtocolHandler({
    issuer: "https://auth.commonswarm.com", resource: "https://mcp.commonswarm.com/mcp",
    publicEnabled: true, allowedOrigins: new Set(),
    limits: { maxBodyBytes: 4096, maxResponseBytes: 4096, requestTimeoutMs: 2000, maxConcurrentRequests: 2 },
    verifyToken: async () => ({ providerGrantId: "fixture", subject: uuid, expiresAt: 1900000000 }),
    executeTool,
  });
}
function request(name: string, args: unknown) {
  return new Request("https://mcp.commonswarm.com/mcp", {
    method: "POST", headers: { authorization: "Bearer fixture.jwt", "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
}

test("hosted input errors name the field and expected form without echoing supplied values", async (t) => {
  t.mock.method(console, "error", () => undefined);
  let executed = 0;
  const serve = handler(async () => { executed++; return { ok: true }; });
  const rows: Array<[string, unknown, string]> = [
    ["whoami", null, "Expected an object of tool arguments. Send arguments as a JSON object."],
    ["whoami", [], "Expected an object of tool arguments. Send arguments as a JSON object."],
    ["whoami", { seat, secret_token: "private-secret" }, "Unknown tool argument. Use only: seat."],
    ["whoami", {}, "Missing seat: provide the seat_ handle returned by claim_seat (22 to 64 letters, digits, underscores or hyphens after seat_)."],
    ["whoami", { seat: "private-secret" }, "Invalid seat: provide the seat_ handle returned by claim_seat (22 to 64 letters, digits, underscores or hyphens after seat_)."],
    ["claim_seat", { name: " bad", request_id: base.request_id }, "Invalid name: provide 1 to 80 characters with no surrounding spaces or control characters."],
    ["claim_seat", { name: "Seat", request_id: "!" }, "Invalid request_id: provide 8 to 72 letters, digits, underscores or hyphens; reuse it only for the same request."],
    ["claim_seat", { name: "Seat", request_id: base.request_id, workspace_id: "bad" }, "Invalid workspace_id: provide a real workspace UUID or omit it to use the grant's home workspace."],
    ["check", { seat, ack: "bad" }, "Invalid ack: provide the batch UUID returned by check, or omit ack to open the inbox."],
    ["note", { ...base, body: " " }, "Invalid body: provide 1 to 8000 characters with non-whitespace text; only tab, newline and carriage return are allowed control characters."],
    ["note", { ...base, body: "private-secret\u0000" }, "Invalid body: provide 1 to 8000 characters with non-whitespace text; only tab, newline and carriage return are allowed control characters."],
    ["ask", { ...base, recipients: [{ kind: "user", id: "bad" }] }, "Invalid recipients: provide 1 to 20 objects with only kind (user or agent) and id (UUID); use members to find recipients."],
    ["reply", { ...base, signal_id: "bad" }, "Invalid signal_id: provide the signal UUID from check that you want to reply to."],
    ["note", { seat, body: "Hello" }, "Missing request_id: provide 8 to 72 letters, digits, underscores or hyphens; reuse it only for the same request."],
  ];
  for (const [name, args, message] of rows) {
    const response = await serve(request(name, args));
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { jsonrpc: "2.0", id: 1, error: { code: -32602, message } });
  }
  assert.equal(executed, 0, "invalid input never reaches authorization or execution");
  assert.equal((await serve(request("note", base))).status, 200);
  assert.equal(executed, 1, "valid input reaches the executor");
});

const accessMessage = "Workspace access is missing or no longer authorized. Ask a workspace admin to restore your membership, then reconnect and approve this workspace.";
const genericMessage = "Something failed on our side; retry with the same request_id; if it repeats, contact support@commonswarm.com";

test("hosted command and read failures return exact stable codes and safe recovery messages", async (t) => {
  const logging = t.mock.method(console, "error", () => undefined);
  const rows: Array<[string, string]> = [
    ["hosted_grant_forbidden", accessMessage],
    ["hosted_grant_unavailable", accessMessage],
    ["hosted_grant_binding_mismatch", accessMessage],
    ["forbidden", accessMessage],
    ["credential_kind_forbidden", "This connection cannot perform this operation. Reconnect your CommonSwarm account and approve workspace access."],
    ["unauthenticated", "Your connection is no longer authenticated. Reconnect your CommonSwarm account and retry."],
    ["hosted_seat_forbidden", "This seat is unavailable to your connection. Call claim_seat and use its returned handle; if access is still denied, ask a workspace admin to restore your membership and reconnect."],
    ["hosted_seat_revoked", "This seat was removed and cannot be restored. Call claim_seat with a new request_id to get a new seat; its owner may reuse the same name."],
    ["hosted_seat_name_invalid", "The seat name is invalid. Use 1 to 80 characters with no surrounding spaces or control characters."],
    ["hosted_seat_name_taken", "That seat name is taken in this workspace. Call claim_seat with another name and a new request_id."],
    ["hosted_seat_limit_reached", "This connection has reached its seat limit. Reuse a seat returned by claim_seat, or ask a workspace admin to revoke an unused seat."],
    ["principal_limit_reached", "This workspace has reached its agent limit. Reuse an existing seat, or ask a workspace admin to revoke an unused agent."],
    ["hosted_check_batch_forbidden", "This inbox batch is unavailable to this seat. Call check without ack, then acknowledge only the batch_id returned for the same seat."],
    ["command_id_conflict", "This request_id was already used for different arguments. Retry the original request unchanged, or use a new request_id for a different request."],
    ["invalid_request", "The request arguments were rejected. Check the tool's input schema and correct the arguments before retrying."],
    ["payload_too_large", "The request is too large. Shorten body to at most 8000 characters and retry with a new request_id."],
    ["upgrade_required", "This hosted connection needs a service update. Contact support@commonswarm.com, then retry with the same request_id."],
    ["rate_limited", "Too many requests. Retry at 2026-10-03T12:01:00.000Z; reuse the same request_id."],
  ];
  for (const [code, message] of rows) {
    const serve = handler(async () => commandOutput({ status: 403, body: {
      error: code, resets_at: "2026-10-03T12:01:00Z",
      message: "SELECT private_sql; token=private-token", stack: "private-stack",
      user_id: "another-user-id", workspace_id: "inaccessible-workspace-id",
    } }));
    const response = await serve(request("whoami", { seat }));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.jsonrpc, "2.0");
    assert.equal(body.id, 1);
    assert.equal(body.result.isError, true);
    assert.deepEqual(body.result.content, [{ type: "text", text: JSON.stringify({ error: code, message }) }]);
  }
  assert.equal(logging.mock.callCount(), rows.length);
  assert.ok(logging.mock.calls.every(({ arguments: args }) => args[0] === JSON.stringify({ event: "request_failed", error_code: "tool_failed", method: "tools/call" })), "logging remains code-only");
  const read = handler(async () => readOutput({ status: 403, body: { error: "forbidden", message: "private-token" } }));
  const response = await read(request("members", { seat }));
  assert.deepEqual(JSON.parse((await response.json()).result.content[0].text), { error: "forbidden", message: accessMessage });
});

test("reply and recipient denials do not distinguish missing resources from inaccessible ones", async (t) => {
  t.mock.method(console, "error", () => undefined);
  const serve = handler(async () => commandOutput({ status: 403, body: { error: "forbidden" } }));
  for (const signal_id of [uuid, "22222222-2222-4222-8222-222222222222"]) {
    const response = await serve(request("reply", { ...base, signal_id }));
    assert.deepEqual(JSON.parse((await response.json()).result.content[0].text), {
      error: "forbidden", message: "The signal is unavailable for this seat, or reply access is missing. Check signal_id in check output and reply from the addressed seat; ask a workspace admin if access is missing.",
    });
  }
  for (const name of ["ask", "note"]) {
    const response = await serve(request(name, { ...base, recipients: [{ kind: "user", id: uuid }] }));
    assert.deepEqual(JSON.parse((await response.json()).result.content[0].text), {
      error: "forbidden", message: "Workspace access or recipient access is missing. Ask a workspace admin to restore access, reconnect, and use members to select current recipients.",
    });
  }
});

test("unknown exceptions and untrusted backend fields cannot leak or select a known error", async (t) => {
  t.mock.method(console, "error", () => undefined);
  const failures = [
    new Error("hosted_seat_forbidden"), // Message text must never classify a failure.
    new Error("SELECT secret_sql; private-token; another-user-id; private-stack"),
    { code: "forbidden", message: "private-token", stack: "private-stack" },
    new HostedToolFailure("hosted_private_token_another_user_id"),
    new HostedToolFailure("__proto__"),
  ];
  for (const failure of failures) {
    const serve = handler(async () => { throw failure; });
    const response = await serve(request("whoami", { seat }));
    assert.deepEqual((await response.json()).result, {
      isError: true, content: [{ type: "text", text: JSON.stringify({ error: "tool_failed", message: genericMessage }) }],
    });
  }
  for (const output of [commandOutput, readOutput]) {
    const serve = handler(async () => output({ status: 500, body: {
      error: "hosted_private_code", message: "SELECT secret_sql", user_id: "another-user-id",
    } }));
    const response = await serve(request("whoami", { seat }));
    assert.deepEqual(JSON.parse((await response.json()).result.content[0].text), { error: "tool_failed", message: genericMessage });
  }
  for (const resets_at of [undefined, "private-token", "2026-10-03T12:01:00Z private-token"]) {
    const serve = handler(async () => commandOutput({ status: 429, body: { error: "rate_limited", resets_at } }));
    const response = await serve(request("note", base));
    assert.deepEqual(JSON.parse((await response.json()).result.content[0].text), {
      error: "rate_limited", message: "Too many requests. Retry after the current rate-limit window resets; reuse the same request_id.",
    });
  }
});

test("successful signal, claim and read result shapes stay unchanged", async () => {
  const rows: Array<[unknown, unknown]> = [
    [{ signal: { id: uuid, kind: "note", created_at: "fixture", body: "not-in-projection" } }, { signal_id: uuid, kind: "note", created_at: "fixture", in_reply_to: null }],
    [{ grant_id: "g", workspace_id: "w", seat_id: "s", principal_id: "p", handle: seat, name: "Seat", status: "accepted" }, { grant_id: "g", workspace_id: "w", seat_id: "s", principal_id: "p", handle: seat, name: "Seat" }],
    [{ batch_id: uuid, signals: [], cursor: null }, { batch_id: uuid, signals: [], cursor: null }],
  ];
  for (const [body, expected] of rows) {
    const serve = handler(async () => commandOutput({ status: 200, body: body as Record<string, unknown> }));
    const response = await serve(request("whoami", { seat }));
    assert.deepEqual((await response.json()).result, { content: [{ type: "text", text: JSON.stringify(expected) }] });
  }
  const serve = handler(async () => readOutput({ status: 200, body: { members: [], agents: [] } }));
  const response = await serve(request("members", { seat }));
  assert.deepEqual((await response.json()).result, { content: [{ type: "text", text: '{"members":[],"agents":[]}' }] });
});

test("unknown tool names receive a safe tools/call correction with the existing JSON-RPC code", async (t) => {
  t.mock.method(console, "error", () => undefined);
  let executed = 0;
  const serve = handler(async () => { executed++; return { ok: true }; });
  const response = await serve(request("private-token", { seat }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { jsonrpc: "2.0", id: 1, error: {
    code: -32602,
    message: "Invalid tools/call params. Send name (claim_seat, whoami, check, ask, note, reply, working_on, members, object_list, object_read, object_history, object_create, object_update) and arguments as a JSON object.",
  } });
  assert.equal(executed, 0);
  assert.equal((await serve(request("whoami", { seat }))).status, 200);
  assert.equal(executed, 1);
});
