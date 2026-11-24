/**
 * Unit tests for sender ask withdrawals, replacement (supersedes), my_open_asks,
 * local & hosted MCP tools, CLI ask subcommands, and release proof files.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  applyWithdrawAsk,
  ASK_WITHDRAWAL_NOT_FOUND_BODY,
  askWithdrawalReplayFields,
  isAskWithdrawalCommandKind,
  loadAskReplacementPlacement,
  parseAskWithdrawalCommand,
  reauthorizeAskWithdrawalRelease,
  resolveAskWithdrawalEffectiveChannelIds,
  storedAskWithdrawalReplayTarget,
} from "../supabase/functions/command/ask-withdrawals.js";
import {
  HOSTED_TOOL_TABLE,
  validateHostedToolArguments,
} from "../supabase/functions/mcp/tools.js";
import { hostedSignalCommand } from "../supabase/functions/mcp/signal-tools.js";
import {
  commandOutput,
  HostedToolFailure,
  hostedToolError,
} from "../supabase/functions/mcp/tool-errors.js";
import { mapWithdraw, MCP_TOOLS, STDIO_MCP_TOOLS, validateMcpArguments } from "../src/mcp/tools.js";
import { commandHelpLines, formatOpenAsksTable } from "../src/cli.js";
import { AGENT_CREDENTIAL_MESSAGE_D088 } from "../src/cloud/agent-credential-input.js";
import { parseAgentConnection, saveAgentProfile } from "../src/cloud/agent-profile.js";

const execFileAsync = promisify(execFile);

const WS_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const OWNER_ID = "33333333-3333-4333-8333-333333333333";
const ASK_ID = "44444444-4444-4444-8444-444444444444";
const NEW_ASK_ID = "55555555-5555-4555-8555-555555555555";
const REQ_ID = "req_withdraw_1234567890";
const SEAT = "seat_ABCDEFGHIJKLMNOPQRSTUV";
const TOKEN = `swm_agt_${"W".repeat(43)}`;

test("parseAskWithdrawalCommand validates kind, signal_id UUID, and rejects extra fields", () => {
  assert.equal(isAskWithdrawalCommandKind("withdraw_ask"), true);
  assert.equal(isAskWithdrawalCommandKind("post_signal"), false);

  const parsed = parseAskWithdrawalCommand({
    kind: "withdraw_ask",
    signal_id: ASK_ID.toUpperCase(),
  });
  assert.deepEqual(parsed, {
    ok: true,
    command: { kind: "withdraw_ask", signal_id: ASK_ID },
  });

  for (const bad of [
    { kind: "withdraw_ask" },
    { kind: "withdraw_ask", signal_id: "not-a-uuid" },
    { kind: "withdraw_ask", signal_id: ASK_ID, extra: true },
    { kind: "withdraw_ask", signal_id: null },
    { kind: "other_kind", signal_id: ASK_ID },
  ]) {
    const res = parseAskWithdrawalCommand(bad as Record<string, unknown>);
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.status, 400);
  }
});

test("askWithdrawalReplayFields preserves only documented withdraw_ask and supersedes fields and strips replaced_by_signal_id", () => {
  const replayed = askWithdrawalReplayFields({
    signal_id: ASK_ID.toUpperCase(),
    withdrawn: true,
    created: false,
    withdrawn_at: "2026-11-23T12:00:00Z",
    // Legacy receipt stored before C3 fix must have replaced_by_signal_id stripped on replay.
    replaced_by_signal_id: NEW_ASK_ID.toUpperCase(),
    channel_id: "should-not-surface",
    extra: 123,
  });
  assert.deepEqual(replayed, {
    signal_id: ASK_ID,
    withdrawn: true,
    created: false,
    withdrawn_at: "2026-11-23T12:00:00Z",
  });
  assert.equal(Object.hasOwn(replayed, "replaced_by_signal_id"), false);
  assert.deepEqual(
    askWithdrawalReplayFields({ superseded_signal_id: ASK_ID.toUpperCase(), ok: true }),
    { superseded_signal_id: ASK_ID },
  );
  assert.deepEqual(askWithdrawalReplayFields({ ok: true }), {});
  assert.deepEqual(ASK_WITHDRAWAL_NOT_FOUND_BODY, {
    error: "not_found",
    message: "No open ask of yours has that id.",
  });
});

test("applyWithdrawAsk and mapWithdraw never project replaced_by_signal_id", async () => {
  const fakeTx = ((_strings: TemplateStringsArray, ..._values: unknown[]) =>
    Promise.resolve([
      {
        result: {
          status: "ok",
          signal_id: ASK_ID,
          withdrawn: true,
          created: false,
          withdrawn_at: "2026-11-23T12:00:00Z",
          replaced_by_signal_id: NEW_ASK_ID,
          channel_id: WS_ID,
        },
      },
    ])) as unknown as Parameters<typeof applyWithdrawAsk>[0];

  const outcome = await applyWithdrawAsk(fakeTx, WS_ID, "agent", AGENT_ID, ASK_ID);
  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    assert.deepEqual(outcome.response, {
      signal_id: ASK_ID,
      withdrawn: true,
      created: false,
      withdrawn_at: "2026-11-23T12:00:00Z",
    });
    assert.equal(Object.hasOwn(outcome.response, "replaced_by_signal_id"), false);
  }

  const mapped = mapWithdraw({
    httpStatus: 200,
    response: {
      ok: true,
      signal_id: ASK_ID,
      withdrawn: true,
      created: false,
      withdrawn_at: "2026-11-23T12:00:00Z",
      replaced_by_signal_id: NEW_ASK_ID,
    },
  } as unknown as Parameters<typeof mapWithdraw>[0]);
  assert.deepEqual(mapped, {
    signal_id: ASK_ID,
    withdrawn: true,
    withdrawn_at: "2026-11-23T12:00:00Z",
  });
  assert.equal(Object.hasOwn(mapped, "replaced_by_signal_id"), false);
});

test("storedAskWithdrawalReplayTarget extracts bound old and new signal ids for replay reauthorization", () => {
  // Standalone withdraw_ask
  assert.deepEqual(
    storedAskWithdrawalReplayTarget(
      "withdraw_ask",
      { signal_id: ASK_ID.toUpperCase() },
      { signal_id: ASK_ID, withdrawn: true },
    ),
    { kind: "withdraw_ask", oldSignalId: ASK_ID, newSignalId: null },
  );
  // Mismatched command vs stored signal_id fails closed
  assert.equal(
    storedAskWithdrawalReplayTarget(
      "withdraw_ask",
      { signal_id: ASK_ID },
      { signal_id: NEW_ASK_ID, withdrawn: true },
    ),
    null,
  );
  // post_signal replacement with supersedes
  assert.deepEqual(
    storedAskWithdrawalReplayTarget(
      "post_signal",
      { supersedes: ASK_ID.toUpperCase() },
      { signal: { id: NEW_ASK_ID.toUpperCase() }, superseded_signal_id: ASK_ID },
    ),
    { kind: "replacement", oldSignalId: ASK_ID, newSignalId: NEW_ASK_ID },
  );
  // ask_choice replacement with supersedes
  assert.deepEqual(
    storedAskWithdrawalReplayTarget(
      "ask_choice",
      { supersedes: ASK_ID },
      { signal: { id: NEW_ASK_ID }, superseded_signal_id: ASK_ID, choice_options: [] },
    ),
    { kind: "replacement", oldSignalId: ASK_ID, newSignalId: NEW_ASK_ID },
  );
  // Replacement with missing/malformed stored signal.id returns newSignalId: null so caller fails closed
  assert.deepEqual(
    storedAskWithdrawalReplayTarget(
      "post_signal",
      { supersedes: ASK_ID },
      { superseded_signal_id: ASK_ID },
    ),
    { kind: "replacement", oldSignalId: ASK_ID, newSignalId: null },
  );
  // Ordinary non-superseding post_signal / ask_choice returns null
  assert.equal(
    storedAskWithdrawalReplayTarget("post_signal", {}, { signal: { id: NEW_ASK_ID } }),
    null,
  );
  assert.equal(
    storedAskWithdrawalReplayTarget("ask_choice", {}, { signal: { id: NEW_ASK_ID } }),
    null,
  );
  // Unrelated command returns null
  assert.equal(
    storedAskWithdrawalReplayTarget("reraise_ask", { signal_id: ASK_ID }, { signal: { id: NEW_ASK_ID } }),
    null,
  );
});

test("reauthorizeAskWithdrawalRelease forwards explicit fresh vs replay deadline flag and fails closed", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  let nextAllowed = true;
  const fakeTx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ sql: strings.join("?"), values });
    return Promise.resolve([{ allowed: nextAllowed }]);
  }) as unknown as Parameters<typeof reauthorizeAskWithdrawalRelease>[0];

  // Fresh release passes requireOpenDeadline = true
  const freshOk = await reauthorizeAskWithdrawalRelease(fakeTx, WS_ID, "agent", AGENT_ID, ASK_ID, NEW_ASK_ID, true);
  assert.equal(freshOk, null);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.sql, /ask_withdrawal_release_allowed/);
  assert.deepEqual(calls[0]!.values, [WS_ID, "agent", AGENT_ID, ASK_ID, NEW_ASK_ID, true]);

  // Replay release passes requireOpenDeadline = false
  const replayOk = await reauthorizeAskWithdrawalRelease(fakeTx, WS_ID, "user", OWNER_ID, ASK_ID, null, false);
  assert.equal(replayOk, null);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1]!.values, [WS_ID, "user", OWNER_ID, ASK_ID, null, false]);

  // Denied returns uniform 404 body
  nextAllowed = false;
  const denied = await reauthorizeAskWithdrawalRelease(fakeTx, WS_ID, "agent", AGENT_ID, ASK_ID, null, true);
  assert.deepEqual(denied, { status: 404, body: ASK_WITHDRAWAL_NOT_FOUND_BODY });

  // Invalid UUID fails closed without hitting SQL
  const beforeInvalid = calls.length;
  const invalid = await reauthorizeAskWithdrawalRelease(fakeTx, WS_ID, "agent", AGENT_ID, "not-a-uuid", null, true);
  assert.deepEqual(invalid, { status: 404, body: ASK_WITHDRAWAL_NOT_FOUND_BODY });
  assert.equal(calls.length, beforeInvalid);
});

const COMMAND_ROLE_RESTRICTED_TABLE_RE =
  /\b(?:FROM|JOIN|INTO|UPDATE|DELETE\s+FROM)\s+swarm\.(?:conversations|conversation_signals|conversation_members|conversation_reads|ask_withdrawals)\b/i;

test("loadAskReplacementPlacement respects swarm_command table boundary and fails closed on invalid ids", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const row = {
    channel_id: null,
    channel_slug: null,
    channel_archived_at: null,
    placement_ok: true,
  };
  const fakeTx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?");
    if (COMMAND_ROLE_RESTRICTED_TABLE_RE.test(sql)) {
      const err = new Error("permission denied for table conversation_signals") as Error & { code?: string };
      err.code = "42501";
      return Promise.reject(err);
    }
    calls.push({ sql, values });
    return Promise.resolve([row]);
  }) as unknown as Parameters<typeof loadAskReplacementPlacement>[0];

  const placed = await loadAskReplacementPlacement(fakeTx, WS_ID, "agent", AGENT_ID, NEW_ASK_ID);
  assert.deepEqual(placed, row);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.sql, /swarm\.ask_sender_can_access_placement/);
  assert.doesNotMatch(calls[0]!.sql, COMMAND_ROLE_RESTRICTED_TABLE_RE);
  assert.equal(calls[0]!.values.some((v) => v === undefined), false);
  assert.deepEqual(calls[0]!.values, ["agent", AGENT_ID, WS_ID, NEW_ASK_ID]);

  const beforeInvalid = calls.length;
  assert.equal(await loadAskReplacementPlacement(fakeTx, WS_ID, "agent", AGENT_ID, "not-a-uuid"), undefined);
  assert.equal(calls.length, beforeInvalid);
});

test("resolveAskWithdrawalEffectiveChannelIds uses the narrow resolver, respects swarm_command boundary, and fails closed", async () => {
  const CH_PRIV = "66666666-6666-4666-8666-666666666666";
  const CH_PUB = "77777777-7777-4777-8777-777777777777";
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const fakeTx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?");
    if (COMMAND_ROLE_RESTRICTED_TABLE_RE.test(sql)) {
      const err = new Error("permission denied for table conversation_signals") as Error & { code?: string };
      err.code = "42501";
      return Promise.reject(err);
    }
    calls.push({ sql, values });
    return Promise.resolve([{ channel_id: CH_PRIV.toUpperCase() }, { channel_id: CH_PUB }]);
  }) as unknown as Parameters<typeof resolveAskWithdrawalEffectiveChannelIds>[0];

  const resolved = await resolveAskWithdrawalEffectiveChannelIds(fakeTx, WS_ID, [
    ASK_ID.toUpperCase(),
    NEW_ASK_ID,
    ASK_ID,
    "not-a-uuid",
  ]);
  assert.deepEqual(resolved, [CH_PRIV, CH_PUB]);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.sql, /swarm\.ask_withdrawal_effective_channel_ids/);
  assert.doesNotMatch(calls[0]!.sql, COMMAND_ROLE_RESTRICTED_TABLE_RE);
  assert.deepEqual(calls[0]!.values, [WS_ID, [ASK_ID, NEW_ASK_ID]]);

  const beforeEmpty = calls.length;
  assert.equal(await resolveAskWithdrawalEffectiveChannelIds(fakeTx, "bad-ws", [ASK_ID]), undefined);
  assert.equal(await resolveAskWithdrawalEffectiveChannelIds(fakeTx, WS_ID, ["not-a-uuid"]), undefined);
  assert.equal(await resolveAskWithdrawalEffectiveChannelIds(fakeTx, WS_ID, []), undefined);
  assert.equal(calls.length, beforeEmpty);
});

test("command edge never directly queries swarm_command-restricted conversation or withdrawal tables", () => {
  for (const rel of [
    "../supabase/functions/command/index.ts",
    "../supabase/functions/command/ask-withdrawals.ts",
  ]) {
    const source = readFileSync(new URL(rel, import.meta.url), "utf8");
    assert.doesNotMatch(
      source,
      COMMAND_ROLE_RESTRICTED_TABLE_RE,
      `${rel} must not directly query conversation or ask_withdrawals tables under swarm_command`,
    );
  }
});

test("local and hosted MCP tool tables expose withdraw, asks_open, and ask.supersedes with strict validation", () => {
  // Local MCP
  const localNames = MCP_TOOLS.map((t) => t.name);
  assert.ok(localNames.includes("withdraw"));
  assert.ok(localNames.includes("asks_open"));
  assert.ok(STDIO_MCP_TOOLS.map((t) => t.name).includes("withdraw"));
  assert.ok(STDIO_MCP_TOOLS.map((t) => t.name).includes("asks_open"));

  assert.deepEqual(validateMcpArguments("withdraw", { signal_id: ASK_ID, request_id: REQ_ID }), {
    signal_id: ASK_ID,
    request_id: REQ_ID,
  });
  assert.throws(() => validateMcpArguments("withdraw", { signal_id: "bad", request_id: REQ_ID }));
  assert.throws(() => validateMcpArguments("withdraw", { request_id: REQ_ID }));

  assert.deepEqual(validateMcpArguments("asks_open", {}), {});
  assert.deepEqual(validateMcpArguments("asks_open", { limit: 25 }), { limit: 25 });
  assert.throws(() => validateMcpArguments("asks_open", { limit: 0 }));
  assert.throws(() => validateMcpArguments("asks_open", { limit: 101 }));
  assert.throws(() => validateMcpArguments("asks_open", { after_id: ASK_ID }));

  assert.equal(
    validateMcpArguments("ask", { to: "Alice", body: "Updated?", supersedes: ASK_ID, request_id: REQ_ID }).supersedes,
    ASK_ID,
  );
  assert.throws(() =>
    validateMcpArguments("ask", { to: "Alice", body: "Updated?", supersedes: "not-a-uuid", request_id: REQ_ID }),
  );

  // Hosted MCP
  const hostedNames = HOSTED_TOOL_TABLE.map((t) => t.name);
  assert.ok(hostedNames.includes("withdraw"));
  assert.ok(hostedNames.includes("asks_open"));
  assert.equal(hostedNames.indexOf("react"), hostedNames.indexOf("reraise") + 1);

  assert.equal(
    validateHostedToolArguments("withdraw", { seat: SEAT, signal_id: ASK_ID, request_id: REQ_ID }).signal_id,
    ASK_ID,
  );
  assert.throws(() =>
    validateHostedToolArguments("withdraw", { seat: SEAT, signal_id: "bad", request_id: REQ_ID }),
  );
  assert.equal(validateHostedToolArguments("asks_open", { seat: SEAT }).seat, SEAT);
  assert.equal(validateHostedToolArguments("asks_open", { seat: SEAT, limit: 50 }).limit, 50);
  assert.throws(() => validateHostedToolArguments("asks_open", { seat: SEAT, limit: 500 }));
  assert.equal(
    validateHostedToolArguments("ask", {
      seat: SEAT,
      recipients: [{ kind: "user", id: OWNER_ID }],
      body: "Updated?",
      supersedes: ASK_ID,
      request_id: REQ_ID,
    }).supersedes,
    ASK_ID,
  );
  assert.throws(() =>
    validateHostedToolArguments("ask", {
      seat: SEAT,
      recipients: [{ kind: "user", id: OWNER_ID }],
      body: "Updated?",
      supersedes: "not-a-uuid",
      request_id: REQ_ID,
    }),
  );

  const askSupersedesCmd = hostedSignalCommand(
    "ask",
    {
      seat: SEAT,
      recipients: [{ kind: "user", id: OWNER_ID }],
      body: "Updated?",
      supersedes: ASK_ID,
      request_id: REQ_ID,
    },
    WS_ID,
  );
  assert.equal(askSupersedesCmd.command.supersedes, ASK_ID);

  const errWithdrawn = hostedToolError(new HostedToolFailure("ask_withdrawn"), "reraise");
  assert.equal(errWithdrawn.error, "ask_withdrawn");
  assert.match(errWithdrawn.message, /withdrawn/);

  const errWithdrawNotFound = hostedToolError(new HostedToolFailure("not_found"), "withdraw");
  assert.equal(errWithdrawNotFound.error, "not_found");
  assert.match(errWithdrawNotFound.message, /asks_open/);

  const outSuperseded = commandOutput({
    status: 200,
    body: {
      ok: true,
      signal: { id: NEW_ASK_ID, kind: "ask", created_at: "2026-11-23T12:00:00Z", in_reply_to: null },
      superseded_signal_id: ASK_ID,
    },
  });
  assert.equal(outSuperseded.superseded_signal_id, ASK_ID);

  // Privacy invariant: the word "dismiss" must never occur in asks_open tool definitions/schemas.
  const localAsksOpen = MCP_TOOLS.find((t) => t.name === "asks_open");
  const stdioAsksOpen = STDIO_MCP_TOOLS.find((t) => t.name === "asks_open");
  const hostedAsksOpen = HOSTED_TOOL_TABLE.find((t) => t.name === "asks_open");
  assert.ok(localAsksOpen && stdioAsksOpen && hostedAsksOpen);
  for (const [label, def] of [
    ["local MCP asks_open", localAsksOpen],
    ["stdio MCP asks_open", stdioAsksOpen],
    ["hosted MCP asks_open", hostedAsksOpen],
  ] as const) {
    assert.doesNotMatch(
      JSON.stringify(def),
      /dismiss/i,
      `${label} must not mention or expose dismissals`,
    );
  }
});

test("formatOpenAsksTable renders empty state and compact open-asks table without dismissal info", () => {
  assert.equal(
    formatOpenAsksTable({
      workspace_id: WS_ID,
      generated_at: "2026-11-23T12:00:00Z",
      total: 0,
      truncated: false,
      asks: [],
    }),
    "No open asks.\n",
  );
  const rendered = formatOpenAsksTable(
    {
      workspace_id: WS_ID,
      generated_at: "2026-11-23T12:00:00Z",
      total: 1,
      truncated: false,
      asks: [
        {
          signal_id: ASK_ID,
          created_at: "2026-11-23T10:00:00Z",
          until: "2026-11-30T10:00:00Z",
          addressees: ["Owner"],
          where: "#general",
          body_preview: "Should we ship the release today?",
        },
      ],
    },
    Date.parse("2026-11-23T12:00:00Z"),
  );
  assert.match(rendered, /44444444-4444-4444-8444-444444444444/);
  assert.match(rendered, /2h/);
  assert.match(rendered, /to:Owner/);
  assert.match(rendered, /#general/);
  assert.match(rendered, /Should we ship the release today\?/);
  assert.doesNotMatch(rendered, /dismiss/i, "CLI open-asks row must never mention dismissals");
});

test("ask help gives accurate descriptions for withdraw and open without --attach text", () => {
  const help = commandHelpLines("ask");
  const lines = help.split("\n");
  const withdrawIdx = lines.findIndex((line) => line.includes("cswarm ask withdraw "));
  const openIdx = lines.findIndex((line) => line.includes("cswarm ask open "));
  assert.notEqual(withdrawIdx, -1, help);
  assert.notEqual(openIdx, -1, help);
  assert.equal(lines[withdrawIdx + 1]?.trim(), "Withdraw an open ask you sent.");
  assert.equal(lines[openIdx + 1]?.trim(), "List your own open asks.");
  assert.doesNotMatch(lines[withdrawIdx + 1] ?? "", /--attach/);
  assert.doesNotMatch(lines[openIdx + 1] ?? "", /--attach/);
});

test("CLI ask withdraw, ask --supersedes, and ask open work end-to-end against mocked edge", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-ask-withdraw-cli-"));
  const commands: Array<Record<string, unknown>> = [];
  const reads: Array<Record<string, unknown>> = [];

  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      const send = (status: number, data: unknown) =>
        res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(data));
      if (req.url === "/functions/v1/command") {
        commands.push(body);
        const cmd = body.command as Record<string, unknown>;
        if (cmd.kind === "withdraw_ask") {
          return send(200, {
            ok: true,
            status: "accepted",
            signal_id: cmd.signal_id,
            withdrawn: true,
            created: true,
            withdrawn_at: "2026-11-23T12:00:00Z",
            // Legacy server field must never be printed by CLI ask withdraw --json.
            replaced_by_signal_id: NEW_ASK_ID,
            event_ids: [],
          });
        }
        if (cmd.kind === "post_signal") {
          return send(200, {
            ok: true,
            status: "accepted",
            signal: {
              id: NEW_ASK_ID,
              workspace_id: WS_ID,
              from: AGENT_ID,
              from_kind: "agent",
              to: OWNER_ID,
              to_agent: null,
              in_reply_to: null,
              about: null,
              kind: "ask",
              body: cmd.body,
              created_at: "2026-11-23T12:01:00Z",
              until: "2026-11-30T12:01:00Z",
              channel_id: null,
            },
            ...(typeof cmd.supersedes === "string" ? { superseded_signal_id: cmd.supersedes } : {}),
            event_ids: [],
          });
        }
        return send(400, { error: "unexpected_command" });
      }
      if (req.url === "/functions/v1/read") {
        reads.push(body);
        if (body.resource === "members") {
          return send(200, {
            workspace_id: WS_ID,
            members: [{ user_id: OWNER_ID, display_name: "Alice" }],
            agents: [{ principal_id: AGENT_ID, name: "WithdrawBot", owner_user_id: OWNER_ID }],
          });
        }
        if (body.resource === "my_open_asks") {
          return send(200, {
            workspace_id: WS_ID,
            generated_at: "2026-11-23T12:02:00Z",
            total: 1,
            truncated: false,
            asks: [
              {
                signal_id: NEW_ASK_ID,
                created_at: "2026-11-23T12:01:00Z",
                until: "2026-11-30T12:01:00Z",
                addressees: ["Alice"],
                where: "DM",
                body_preview: "Updated question?",
              },
            ],
          });
        }
        return send(400, { error: "unexpected_read" });
      }
      return send(404, { error: "not_found" });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${port}`;
  const profilePath = join(root, "profile", "profile.json");

  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    await saveAgentProfile(
      profilePath,
      parseAgentConnection(
        JSON.stringify({
          version: 1,
          url: baseUrl,
          anon_key: "test-public-key",
          workspace_id: WS_ID,
          principal_id: AGENT_ID,
          credential: {
            message: AGENT_CREDENTIAL_MESSAGE_D088,
            status: "accepted",
            principal_id: AGENT_ID,
            token_id: "11111111-1111-4111-8111-111111111112",
            run_id: "22222222-2222-4222-8222-222222222223",
            agent_token: TOKEN,
            expires_at: "2099-01-01T00:00:00Z",
          },
        }),
      ),
    );

    const runCli = (args: string[]) =>
      execFileAsync(process.execPath, [join(process.cwd(), "dist/cli.js"), ...args], {
        env: { ...process.env, HOME: root },
      });

    // 1. cswarm ask withdraw <ask-id> (plain and --json)
    const wdOut = await runCli(["ask", "withdraw", ASK_ID, "--profile", profilePath]);
    assert.match(wdOut.stdout, /Withdrawn ask 44444444-4444-4444-8444-444444444444\./);
    assert.deepEqual(commands.at(-1)?.command, { kind: "withdraw_ask", signal_id: ASK_ID });

    const wdJson = await runCli(["ask", "withdraw", ASK_ID, "--json", "--profile", profilePath]);
    const wdParsed = JSON.parse(wdJson.stdout) as Record<string, unknown>;
    assert.deepEqual(wdParsed, {
      signal_id: ASK_ID,
      withdrawn: true,
      created: true,
      withdrawn_at: "2026-11-23T12:00:00Z",
    });
    assert.equal(Object.hasOwn(wdParsed, "replaced_by_signal_id"), false);

    // 2. cswarm ask --to Alice --supersedes <ask-id> "Updated question?"
    const supOut = await runCli([
      "ask", "--to", "Alice", "--supersedes", ASK_ID, "Updated question?",
      "--profile", profilePath,
    ]);
    assert.match(supOut.stdout, /Updated question|Sent|55555555-5555-4555-8555-555555555555/);
    assert.equal((commands.at(-1)?.command as Record<string, unknown>).supersedes, ASK_ID);

    // 3. cswarm ask open (table) and cswarm ask open --json
    const openTable = await runCli(["ask", "open", "--profile", profilePath]);
    assert.match(openTable.stdout, /55555555-5555-4555-8555-555555555555/);
    assert.match(openTable.stdout, /Updated question\?/);
    assert.doesNotMatch(openTable.stdout, /dismiss/i);

    const openJson = await runCli(["ask", "open", "--json", "--profile", profilePath]);
    assert.doesNotMatch(openJson.stdout, /dismiss/i);
    const parsed = JSON.parse(openJson.stdout) as { asks: Array<{ signal_id: string }> };
    assert.equal(parsed.asks.length, 1);
    assert.equal(parsed.asks[0]!.signal_id, NEW_ASK_ID);
    assert.ok(reads.some((r) => r.resource === "my_open_asks"));

    // 4. cswarm ask withdraw --help and cswarm ask open --help
    const wdHelp = await runCli(["ask", "withdraw", "--help"]);
    assert.match(wdHelp.stdout, /Withdraw an open ask you sent\./);
    assert.match(wdHelp.stdout, /List your own open asks\./);
    const openHelp = await runCli(["ask", "open", "--help"]);
    assert.match(openHelp.stdout, /Withdraw an open ask you sent\./);
    assert.match(openHelp.stdout, /List your own open asks\./);
  } finally {
    process.env.HOME = previousHome;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("release-proofs/ask-withdrawals contains non-empty catalog, functional, rollback, and rollback-catalog SQL", () => {
  const dir = new URL("../deploy/release-proofs/ask-withdrawals/", import.meta.url);
  for (const name of [
    "20261125000001-catalog.sql",
    "20261125000001-functional.sql",
    "20261125000001-rollback.sql",
    "20261125000001-rollback-catalog.sql",
  ]) {
    const content = readFileSync(new URL(name, dir), "utf8");
    assert.ok(content.trim().length > 0, `${name} should be non-empty`);
  }
});
