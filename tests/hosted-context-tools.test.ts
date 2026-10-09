import assert from "node:assert/strict";
import { test } from "node:test";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
// @ts-expect-error TS5097: exercise the production Deno catalog through tsx.
import { HOSTED_TOOL_TABLE, HostedToolInputError, validateHostedToolArguments } from "../supabase/functions/mcp/tools.ts";
// @ts-expect-error TS5097: exercise Deno result translation through tsx.
import { commandOutput, readOutput, HostedToolFailure, hostedToolError } from "../supabase/functions/mcp/tool-errors.ts";
// @ts-expect-error TS5097: exercise the real transport boundary through tsx.
import { createMcpProtocolHandler } from "../supabase/functions/mcp/protocol.ts";
// @ts-expect-error TS5097: exercise shared public instructions through tsx.
import { CLAIM_SEAT_DESCRIPTION, WHOAMI_DESCRIPTION } from "../supabase/functions/mcp/session-instructions.ts";

const seat = "seat_ABCDEFGHIJKLMNOPQRSTUV";
const uuid = "11111111-1111-4111-8111-111111111111";
const request_id = "request_123";
const validator = new AjvJsonSchemaValidator();
function schema(name: string) {
  return validator.getValidator(HOSTED_TOOL_TABLE.find(tool => tool.name === name)!.inputSchema);
}
function executable(name: "claim_seat" | "whoami" | "close_session", args: unknown) {
  try { validateHostedToolArguments(name, args); return true; }
  catch (error) { assert.ok(error instanceof HostedToolInputError); return false; }
}

const nameCases: Array<[string, boolean]> = [
  ["Agent", true], [" bad", false], ["bad ", false], ["bad\u0080", false],
  ["\u00a0Agent\u00a0", true],
  ["Agent\u2028 ", false], ["Agent\u2029 ", false],
  ["Agent\u2028X", true], ["Agent\u2029X", true],
];

// DESIGN 4.2 has three valid routes: new (no seat; durable needs name),
// name continuation (no lifetime), handle continuation (no lifetime/kind/parent).
// Enumerate the entire presence/value matrix, independently of schema compilation.
test("advertised claim schema and executable validation agree on all 360 contract combinations", () => {
  const validate = schema("claim_seat");
  let count = 0;
  let accepted = 0;
  for (const intent of [undefined, "new", "continue"])
  for (const name of [undefined, "MrMarketing"])
  for (const handle of [undefined, seat])
  for (const kind of [undefined, "chat", "task", "scheduled", "subagent"])
  for (const lifetime of [undefined, "ephemeral", "durable"])
  for (const parent_context of [undefined, uuid]) {
    const args = Object.fromEntries(Object.entries({ request_id, intent, name, seat: handle, kind, lifetime, parent_context })
      .filter(([, value]) => value !== undefined));
    const expected = intent !== "continue"
      ? handle === undefined && (lifetime !== "durable" || name !== undefined)
      : lifetime === undefined && (handle !== undefined
        ? kind === undefined && parent_context === undefined
        : name !== undefined);
    const label = JSON.stringify(args);
    assert.equal(validate(args).valid, expected, `advertised schema: ${label}`);
    assert.equal(executable("claim_seat", args), expected, `executable: ${label}`);
    count++;
    if (expected) accepted++;
  }
  assert.equal(count, 360);
  assert.equal(accepted, 112);
});

test("identity tools preserve closed records and Unicode, UUID, handle and request boundaries", () => {
  const rows: Array<["claim_seat" | "whoami" | "close_session", unknown, boolean]> = [
    ["whoami", {}, true], ["whoami", { seat }, true],
    ["close_session", { seat, request_id }, true],
    ["close_session", { seat }, false], ["close_session", { request_id }, false],
    ["claim_seat", { request_id }, true],
    ["claim_seat", { request_id, name: "😀".repeat(80), workspace_id: uuid, parent_context: uuid }, true],
    ["claim_seat", { request_id, name: "😀".repeat(81) }, false],
    ...nameCases.map(([name, expected]): ["claim_seat", unknown, boolean] => ["claim_seat", { request_id, name }, expected]),
    ["claim_seat", { request_id, workspace_id: "00000000-0000-4000-8000-000000000000" }, false],
    ["claim_seat", { request_id, parent_context: "bad" }, false],
    ["claim_seat", { request_id, intent: "CONTINUE" }, false],
    ["claim_seat", { request_id, lifetime: "forever" }, false],
    ["claim_seat", { request_id, kind: "fork" }, false],
  ];
  for (const key of ["name", "seat", "intent", "lifetime", "kind", "parent_context", "workspace_id"]) {
    rows.push(["claim_seat", { request_id, [key]: null }, false]);
  }
  for (const [name, control] of [["claim_seat", { request_id }], ["whoami", {}], ["close_session", { request_id, seat }]] as const) {
    for (const key of ["assurance", "created_at", "owner", "app", "clientInfo", "extra"]) {
      rows.push([name, { ...control, [key]: "private-value" }, false]);
    }
    for (const value of [null, []]) rows.push([name, value, false]);
  }
  for (const badHandle of ["seat_" + "A".repeat(21), "seat_" + "A".repeat(65), "seat_" + "!".repeat(22), null]) {
    rows.push(["whoami", { seat: badHandle }, false]);
    rows.push(["close_session", { seat: badHandle, request_id }, false]);
  }
  for (const length of [22, 64]) rows.push(["whoami", { seat: "seat_" + "A".repeat(length) }, true]);
  for (const id of ["a".repeat(7), "a".repeat(73), "bad!request", null]) {
    rows.push(["claim_seat", { request_id: id }, false]);
    rows.push(["close_session", { seat, request_id: id }, false]);
  }
  for (const length of [8, 72]) rows.push(["claim_seat", { request_id: "a".repeat(length) }, true]);
  for (const [name, args, expected] of rows) {
    assert.equal(schema(name)(args).valid, expected, `${name} advertised ${JSON.stringify(args)}`);
    assert.equal(executable(name, args), expected, `${name} executable ${JSON.stringify(args)}`);
  }
});

test("each advertised pattern agrees with executable validation on shared field cases", (t) => {
  // Serialize as tools/list does, then derive patterns rather than copying them.
  const tools = JSON.parse(JSON.stringify(HOSTED_TOOL_TABLE));
  const uuidCases: Array<[string, boolean]> = [[uuid, true], ["not-a-uuid", false]];
  const cases: Record<string, Array<[string, boolean]>> = {
    name: nameCases,
    seat: [[seat, true], ["seat_" + "!".repeat(22), false]],
    request_id: [[request_id, true], ["request!123", false]],
    workspace_id: uuidCases, parent_context: uuidCases, ack: uuidCases,
    signal_id: uuidCases, id: uuidCases,
  };
  const controls: Record<string, Record<string, unknown>> = {
    claim_seat: { request_id }, whoami: { seat }, close_session: { seat, request_id },
    check: { seat }, members: { seat },
    ask: { seat, request_id, body: "Hello", recipients: [{ kind: "user", id: uuid }] },
    note: { seat, request_id, body: "Hello", recipients: [{ kind: "user", id: uuid }] },
    reply: { seat, request_id, body: "Hello", signal_id: uuid },
    working_on: { seat, request_id, body: "Hello" },
  };
  let patterns = 0;
  let checks = 0;
  for (const tool of tools) {
    const control = controls[tool.name];
    assert.ok(control, `missing valid control for ${tool.name}`);
    const visit = (node: Record<string, any>, path: Array<string | number>) => {
      if (typeof node.pattern === "string") {
        patterns++;
        const pattern = new RegExp(node.pattern, "u");
        const fieldCases = cases[String(path.at(-1))];
        assert.ok(fieldCases, `missing cases for ${tool.name}.${path.join(".")}`);
        for (const [value, expected] of fieldCases) {
          checks++;
          const args = structuredClone(control) as Record<string, any>;
          if (tool.name === "claim_seat" && path[0] === "seat") args.intent = "continue";
          let target = args;
          for (const key of path.slice(0, -1)) target = target[key];
          target[path.at(-1)!] = value;
          const label = `${tool.name}.${path.join(".")}: ${JSON.stringify(value)}`;
          assert.equal(pattern.test(value), expected, `pattern: ${label}`);
          assert.equal(schema(tool.name)(args).valid, expected, `schema: ${label}`);
          if (expected) assert.deepEqual(validateHostedToolArguments(tool.name, args), args, `executable: ${label}`);
          else assert.throws(() => validateHostedToolArguments(tool.name, args), HostedToolInputError, `executable: ${label}`);
        }
      }
      for (const [key, child] of Object.entries(node.properties ?? {})) visit(child as Record<string, any>, [...path, key]);
      if (node.items) visit(node.items, [...path, 0]);
    };
    visit(tool.inputSchema, []);
  }
  assert.ok(patterns > 0, "the advertised catalog must exercise patterns");
  t.diagnostic(`${patterns} advertised pattern fields; ${checks} shared schema/runtime cases`);
});

test("context result translation retains identity, outcome and expiry fields and legacy claim fields", () => {
  const identity = {
    grant_id: uuid, workspace_id: uuid, workspace: { id: uuid, name: "Home" },
    seat_id: uuid, principal_id: uuid, context_id: uuid, seat, handle: seat,
    name: "Claude-7K2P", display_name: "Claude", disambiguator: "7K2P", assurance: "portable",
    lifetime: "ephemeral", kind: "chat", created_at: "2026-10-09T00:00:00Z", last_business_at: "2026-10-09T00:00:00Z",
    idle_expires_at: "2026-10-10T00:00:00Z", absolute_expires_at: "2026-11-08T00:00:00Z",
  };
  for (const outcome of ["created", "continued", "replayed"]) {
    const claim = { ...identity, outcome, original_outcome: "created", name_adjusted: true, adjustment_reason: "ephemeral_address" };
    assert.deepEqual(commandOutput({ status: 200, body: { ...claim, ok: true, event_ids: [uuid] } }), claim);
  }
  const legacy = { grant_id: uuid, workspace_id: uuid, seat_id: uuid, principal_id: uuid, handle: seat, name: "Old" };
  assert.deepEqual(commandOutput({ status: 200, body: legacy }), legacy, "never fabricate context fields on legacy output");
  const selected = { ...identity, idle_expires_at: null, absolute_expires_at: null, context_status: "active", transport: "hosted", turn_only: true };
  assert.deepEqual(readOutput({ status: 200, body: selected }), selected);
  const close = { outcome: "closed", context_id: uuid, principal_state: "retained", closed_at: "2026-10-09T01:00:00Z" };
  assert.deepEqual(commandOutput({ status: 200, body: close }), close);
});

test("context errors use stable codes, exact expiry copy, authority-aware recovery and bounded retry metadata", () => {
  assert.deepEqual(hostedToolError(new HostedToolFailure("context_expired"), "whoami"), {
    error: "context_expired", message: "This chat identity expired. Start a new identity to continue; shared work is still here.", can_start_new: true,
  });
  for (const code of ["context_closed", "workspace_mismatch", "identity_resume_unavailable", "workspace_unavailable", "session_capacity_reached", "name_allocation_busy"]) {
    const error = hostedToolError(new HostedToolFailure(code), "claim_seat");
    assert.equal(error.error, code);
    assert.equal(error.can_start_new, code === "context_closed" || code === "workspace_mismatch");
  }
  for (const canStartNew of [true, false, "true", undefined]) {
    const failure = new HostedToolFailure("identity_resume_unavailable", undefined, { canStartNew });
    assert.equal(hostedToolError(failure, "claim_seat").can_start_new, canStartNew === true);
  }
  for (const [delay, expected] of [[0.1, 1], [1.1, 2], [1e9, 86400], [0, undefined], [-1, undefined], [NaN, undefined], [Infinity, undefined], ["private", undefined]] as const) {
    for (const output of [commandOutput, readOutput]) {
      assert.throws(() => output({ status: 429, body: { error: "session_capacity_reached", retry_after_seconds: delay } }), (failure: unknown) => {
        const error = hostedToolError(failure, "claim_seat");
        assert.equal(error.retry_after_seconds, expected);
        assert.equal(Object.hasOwn(error, "retry_after_seconds"), expected !== undefined);
        return true;
      });
    }
  }
  const forbidden = hostedToolError(new HostedToolFailure("forbidden", undefined, { canStartNew: true, retryAfterSeconds: 1 }), "claim_seat");
  assert.equal(forbidden.can_start_new, false, "backend recovery metadata cannot override an authorization failure");
  assert.equal("retry_after_seconds" in forbidden, false);
});

test("seat-less whoami and close travel through MCP; object _meta stays separate and denials keep their envelope", async (t) => {
  t.mock.method(console, "error", () => undefined);
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  let deny = false;
  const serve = createMcpProtocolHandler({
    issuer: "https://auth.commonswarm.com", resource: "https://mcp.commonswarm.com/mcp",
    publicEnabled: true, allowedOrigins: new Set(),
    limits: { maxBodyBytes: 4096, maxResponseBytes: 8192, requestTimeoutMs: 2000, maxConcurrentRequests: 2 },
    verifyToken: async () => ({ providerGrantId: "fixture", subject: uuid, expiresAt: 1900000000 }),
    executeTool: async (call) => {
      calls.push({ name: call.name, arguments: call.arguments });
      if (deny) throw new HostedToolFailure("identity_resume_unavailable", undefined, { canStartNew: true });
      return { fixture: "contract executor; no lifecycle wiring" };
    },
  });
  const request = (method: string, params: unknown) => new Request("https://mcp.commonswarm.com/mcp", {
    method: "POST", headers: { authorization: "Bearer fixture.jwt", "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  for (const [name, args] of [["whoami", {}], ["claim_seat", { request_id }], ["close_session", { seat, request_id }]] as const) {
    for (const metadata of [undefined, { "test/trace": { value: "opaque", seat: "not-authority" } }]) {
      const response = await serve(request("tools/call", { name, arguments: args, ...(metadata === undefined ? {} : { _meta: metadata }) }));
      assert.equal(response.status, 200);
      assert.deepEqual((await response.json()).result, {
        isError: false, content: [{ type: "text", text: '{"fixture":"contract executor; no lifecycle wiring"}' }],
      });
      assert.deepEqual(calls.at(-1), { name, arguments: args });
    }
  }
  const invalid = await serve(request("tools/call", { name: "close_session", arguments: { seat } }));
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, -32602);
  assert.equal(calls.length, 6, "malformed input never dispatches");
  deny = true;
  const denied = await serve(request("tools/call", { name: "claim_seat", arguments: { request_id, intent: "continue", name: "MrMarketing" } }));
  assert.equal(denied.status, 200);
  assert.deepEqual((await denied.json()).result, {
    isError: true, content: [{ type: "text", text: JSON.stringify({
      error: "identity_resume_unavailable", message: "This connection cannot resume that identity. I can work as a separate chat agent.", can_start_new: true,
    }) }],
  });
  const initialized = await serve(request("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "untrusted-brand" } }));
  const instructions = (await initialized.json()).result.instructions;
  assert.ok(instructions.includes(CLAIM_SEAT_DESCRIPTION));
  assert.ok(instructions.includes(WHOAMI_DESCRIPTION));
  assert.match(instructions, /same owner and exact registered client_id/u);
  assert.match(instructions, /parentage is unverified/u);
  assert.match(instructions, /never agent-private work/u);
});
