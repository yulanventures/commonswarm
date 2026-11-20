/**
 * C7: Hosted & stdio MCP conversation parity (`conversations`, `conversation_read`,
 * `dm`, `thread`, `mark_read`) — schema validation, lossless response-size fitting,
 * deterministic dm command_id derivation, error catalog mapping, and stdio parity.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  HOSTED_TOOL_TABLE,
  HostedToolInputError,
  validateHostedToolArguments,
} from "../supabase/functions/mcp/tools.ts";
import {
  buildDmPostCommand,
  buildThreadPostCommand,
  CONVERSATION_READ_MARGIN_BYTES,
  dmOpenCommandId,
  fitHostedConversationHistoryPage,
  fitHostedConversationsList,
} from "../supabase/functions/mcp/conversation-tools.ts";
import { channelPageWireBytes } from "../supabase/functions/mcp/channel-page.ts";
import { HostedToolFailure, hostedToolError } from "../supabase/functions/mcp/tool-errors.ts";
import {
  HOSTED_SEAT_COMMAND_TOOLS,
  HOSTED_SEAT_READ_TOOLS,
} from "../supabase/functions/_shared/hosted-seat-auth.ts";
import {
  dmOpenStdioCommandId,
  fitStdioConversationHistory,
  fitStdioConversationsList,
  MCP_RESULT_MAX_BYTES,
  STDIO_MCP_TOOLS,
} from "../src/mcp/tools.js";

const SEAT = "seat_ABCDEFGHIJKLMNOPQRSTUV";
const WS = "11111111-1111-4111-8111-111111111111";
const CONV = "22222222-2222-4222-8222-222222222222";
const ROOT = "33333333-3333-4333-8333-333333333333";
const USER_A = "44444444-4444-4444-8444-444444444444";
const AGENT_B = "55555555-5555-4555-8555-555555555555";
const REQ = "c7_request_123456";

test("C7 exposes conversations, conversation_read, dm, thread, and mark_read on both hosted and stdio MCP", () => {
  const c7Names = ["conversations", "conversation_read", "dm", "thread", "mark_read"] as const;
  for (const name of c7Names) {
    const hosted = HOSTED_TOOL_TABLE.find((t) => t.name === name);
    assert.ok(hosted, `HOSTED_TOOL_TABLE must include ${name}`);
    assert.equal(hosted.inputSchema.additionalProperties, false);
    const stdio = STDIO_MCP_TOOLS.find((t) => t.name === name);
    assert.ok(stdio, `STDIO_MCP_TOOLS must include ${name}`);
    assert.equal(stdio.inputSchema.additionalProperties, false);
  }
  assert.ok((HOSTED_SEAT_READ_TOOLS as readonly string[]).includes("conversations"));
  assert.ok((HOSTED_SEAT_READ_TOOLS as readonly string[]).includes("conversation_read"));
  assert.ok((HOSTED_SEAT_COMMAND_TOOLS as readonly string[]).includes("dm"));
  assert.ok((HOSTED_SEAT_COMMAND_TOOLS as readonly string[]).includes("thread"));
  assert.ok((HOSTED_SEAT_COMMAND_TOOLS as readonly string[]).includes("mark_read"));
});

test("validateHostedToolArguments enforces strict schemas and cursor/member invariants for all 5 C7 tools", () => {
  // conversations
  assert.deepEqual(validateHostedToolArguments("conversations", { seat: SEAT, include_archived: true, limit: 20 }), {
    seat: SEAT, include_archived: true, limit: 20,
  });
  assert.throws(() => validateHostedToolArguments("conversations", { seat: SEAT, limit: 101 }), HostedToolInputError);

  // conversation_read: accepts paired before_* or paired after_*, rejects half pairs or both
  assert.ok(validateHostedToolArguments("conversation_read", {
    seat: SEAT, conversation_id: CONV,
    before_created_at: "2026-11-20T12:00:00.000Z", before_id: ROOT, limit: 25,
  }));
  assert.ok(validateHostedToolArguments("conversation_read", {
    seat: SEAT, conversation_id: CONV,
    after_created_at: "2026-11-20T12:00:00.000Z", after_id: ROOT, include_mentions: true, include_reactions: true,
  }));
  assert.throws(
    () => validateHostedToolArguments("conversation_read", { seat: SEAT, conversation_id: CONV, before_created_at: "2026-11-20T12:00:00.000Z" }),
    HostedToolInputError,
  );
  assert.throws(
    () => validateHostedToolArguments("conversation_read", {
      seat: SEAT, conversation_id: CONV,
      before_created_at: "2026-11-20T12:00:00.000Z", before_id: ROOT,
      after_created_at: "2026-11-20T12:01:00.000Z", after_id: ROOT,
    }),
    HostedToolInputError,
  );

  // dm: 1..8 unique members, optional body, kind only with body
  assert.ok(validateHostedToolArguments("dm", {
    seat: SEAT, members: [{ kind: "user", id: USER_A }, { kind: "agent", id: AGENT_B }], request_id: REQ,
  }));
  assert.ok(validateHostedToolArguments("dm", {
    seat: SEAT, members: [{ kind: "user", id: USER_A }], body: "Quick check-in", kind: "ask", request_id: REQ,
  }));
  assert.throws(
    () => validateHostedToolArguments("dm", {
      seat: SEAT, members: [{ kind: "user", id: USER_A }, { kind: "user", id: USER_A.toUpperCase() }], request_id: REQ,
    }),
    HostedToolInputError,
  );
  assert.throws(
    () => validateHostedToolArguments("dm", { seat: SEAT, members: [{ kind: "user", id: USER_A }], kind: "ask", request_id: REQ }),
    HostedToolInputError,
  );
  assert.throws(
    () => validateHostedToolArguments("dm", {
      seat: SEAT,
      members: Array.from({ length: 9 }, (_, i) => ({ kind: "user", id: `44444444-4444-4444-8444-44444444440${i}` })),
      request_id: REQ,
    }),
    HostedToolInputError,
  );

  // thread
  assert.ok(validateHostedToolArguments("thread", {
    seat: SEAT, conversation_id: CONV, thread_root_id: ROOT, body: "Thread reply", mentions: ["Alex"], request_id: REQ,
  }));
  assert.throws(
    () => validateHostedToolArguments("thread", { seat: SEAT, conversation_id: CONV, thread_root_id: "not-a-uuid", body: "x", request_id: REQ }),
    HostedToolInputError,
  );

  // mark_read
  assert.ok(validateHostedToolArguments("mark_read", {
    seat: SEAT, conversation_id: CONV, through_signal_id: ROOT, request_id: REQ,
  }));
  assert.ok(validateHostedToolArguments("mark_read", {
    seat: SEAT, conversation_id: CONV, request_id: REQ,
  }));
});

test("fitHostedConversationsList and fitHostedConversationHistoryPage respect wire byte budgets losslessly", () => {
  const maxResponseBytes = 4096;
  const budget = maxResponseBytes - CONVERSATION_READ_MARGIN_BYTES;

  // Conversations list trims tail summaries and sets truncated: true.
  const summaries = Array.from({ length: 12 }, (_, i) => ({
    conversation_id: `22222222-2222-4222-8222-${String(i).padStart(12, "0")}`,
    kind: "public_channel",
    slug: `channel-${i}`,
    description: "x".repeat(350),
  }));
  const fittedList = fitHostedConversationsList({ context: { workspace_id: WS }, workspace_id: WS, conversations: summaries }, maxResponseBytes);
  assert.equal(fittedList.truncated, true);
  assert.ok(fittedList.conversations.length > 0 && fittedList.conversations.length < summaries.length);
  assert.ok(channelPageWireBytes(fittedList) <= budget);

  // History backward/latest fit trims oldest messages and recalculates next_before to the oldest kept row.
  const messages = Array.from({ length: 6 }, (_, i) => ({
    id: `66666666-6666-4666-8666-${String(i + 1).padStart(12, "0")}`,
    created_at: `2026-11-20T12:00:0${i}.000Z`,
    body: "m".repeat(550),
  }));
  const backFitted = fitHostedConversationHistoryPage({
    context: { workspace_id: WS },
    workspace_id: WS,
    conversation: { conversation_id: CONV, kind: "dm" },
    messages,
    has_more: false,
    next_before: { created_at: messages[0]!.created_at, id: messages[0]!.id },
    next_after: { created_at: messages[5]!.created_at, id: messages[5]!.id },
  }, "backward", maxResponseBytes);
  assert.equal(backFitted.has_more, true);
  assert.ok(backFitted.messages.length >= 1 && backFitted.messages.length < messages.length);
  assert.equal(backFitted.messages[backFitted.messages.length - 1]!.id, messages[5]!.id, "backward fit keeps newest messages");
  assert.deepEqual(backFitted.next_before, {
    created_at: backFitted.messages[0]!.created_at,
    id: backFitted.messages[0]!.id,
  });
  assert.ok(channelPageWireBytes(backFitted) <= budget);

  // History forward fit trims newest messages and recalculates next_after to the last kept row.
  const fwdFitted = fitHostedConversationHistoryPage({
    context: { workspace_id: WS },
    workspace_id: WS,
    conversation: { conversation_id: CONV, kind: "dm" },
    messages,
    has_more: false,
    next_before: { created_at: messages[0]!.created_at, id: messages[0]!.id },
    next_after: { created_at: messages[5]!.created_at, id: messages[5]!.id },
  }, "forward", maxResponseBytes);
  assert.equal(fwdFitted.has_more, true);
  assert.ok(fwdFitted.messages.length >= 1 && fwdFitted.messages.length < messages.length);
  assert.equal(fwdFitted.messages[0]!.id, messages[0]!.id, "forward fit keeps earliest messages");
  assert.deepEqual(fwdFitted.next_after, {
    created_at: fwdFitted.messages[fwdFitted.messages.length - 1]!.created_at,
    id: fwdFitted.messages[fwdFitted.messages.length - 1]!.id,
  });
  assert.ok(channelPageWireBytes(fwdFitted) <= budget);
});

test("stdio conversation fitters respect MCP_RESULT_MAX_BYTES and dmOpenCommandId stays within COMMAND_ID_RE", () => {
  const bigSummaries = Array.from({ length: 80 }, (_, i) => ({
    conversation_id: `22222222-2222-4222-8222-${String(i).padStart(12, "0")}`,
    kind: "public_channel",
    description: "d".repeat(600),
  }));
  const stdioList = fitStdioConversationsList(WS, bigSummaries) as { conversations: unknown[]; truncated: boolean };
  assert.equal(stdioList.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(stdioList)) <= MCP_RESULT_MAX_BYTES);

  const bigMsgs = Array.from({ length: 40 }, (_, i) => ({
    id: `77777777-7777-4777-8777-${String(i + 1).padStart(12, "0")}`,
    created_at: `2026-11-20T12:01:${String(i).padStart(2, "0")}.000Z`,
    body: "b".repeat(1200),
  }));
  const stdioHist = fitStdioConversationHistory({
    conversation: { conversation_id: CONV, kind: "group_dm" },
    messages: bigMsgs,
    has_more: false,
    next_before: { created_at: bigMsgs[0]!.created_at, id: bigMsgs[0]!.id },
    next_after: { created_at: bigMsgs[39]!.created_at, id: bigMsgs[39]!.id },
  }, "backward") as { messages: Array<{ id: string; created_at: string }>; has_more: boolean; next_before: { id: string } };
  assert.equal(stdioHist.has_more, true);
  assert.ok(Buffer.byteLength(JSON.stringify(stdioHist)) <= MCP_RESULT_MAX_BYTES);
  assert.equal(stdioHist.next_before.id, stdioHist.messages[0]!.id);

  // Deterministic dm open command id fits COMMAND_ID_RE even for 72-char request_ids.
  const longReq = "r".repeat(72);
  for (const id of [dmOpenCommandId(REQ), dmOpenCommandId(longReq), dmOpenStdioCommandId(longReq)]) {
    assert.match(id, /^[A-Za-z0-9_-]{8,72}$/);
    assert.notEqual(id, REQ);
    assert.notEqual(id, longReq);
  }
  assert.equal(dmOpenCommandId(longReq), dmOpenStdioCommandId(longReq));

  // Command builders + stable error copy.
  const dmCmd = buildDmPostCommand(CONV, { body: "Hi", kind: "ask" });
  assert.equal(dmCmd.conversation_id, CONV);
  assert.equal(dmCmd.signal_kind, "ask");
  const threadCmd = buildThreadPostCommand({ conversation_id: CONV, thread_root_id: ROOT, body: "Done" });
  assert.equal(threadCmd.conversation_id, CONV);
  assert.equal(threadCmd.thread_root_id, ROOT);

  const err404 = hostedToolError(new HostedToolFailure("conversation_not_found"), "conversation_read");
  assert.equal(err404.error, "conversation_not_found");
  assert.match(err404.message, /conversations/);
  const errMentions = hostedToolError(new HostedToolFailure("conversation_mentions"), "thread");
  assert.equal(errMentions.error, "conversation_mentions");
  const errNested = hostedToolError(new HostedToolFailure("thread_root_is_a_reply"), "thread");
  assert.equal(errNested.error, "thread_root_is_a_reply");
});

test("HezSec C1: hosted seatCapability uses shared HOSTED_SEAT_READ_TOOLS including conversations and conversation_read", () => {
  assert.ok((HOSTED_SEAT_READ_TOOLS as readonly string[]).includes("conversations"));
  assert.ok((HOSTED_SEAT_READ_TOOLS as readonly string[]).includes("conversation_read"));
  assert.ok((HOSTED_SEAT_COMMAND_TOOLS as readonly string[]).includes("dm"));
  assert.ok((HOSTED_SEAT_COMMAND_TOOLS as readonly string[]).includes("thread"));
  assert.ok((HOSTED_SEAT_COMMAND_TOOLS as readonly string[]).includes("mark_read"));

  const mcpIndexSource = readFileSync(new URL("../supabase/functions/mcp/index.ts", import.meta.url), "utf8");
  assert.match(mcpIndexSource, /\(HOSTED_SEAT_READ_TOOLS as readonly string\[\]\)\.includes\(tool\)/);
});

test("HezSec C2: both hosted and stdio history fitters strictly bound single rows with huge reaction metadata and keep cursors navigable", () => {
  const hugeReactions = Array.from({ length: 40 }, (_, i) => ({
    emoji: `emoji_${i}`,
    count: 100,
    actors: Array.from({ length: 60 }, (_, j) => ({
      kind: "agent",
      id: `88888888-8888-4888-8888-${String(i * 100 + j).padStart(12, "0")}`,
    })),
  }));
  const giantRow = {
    id: "99999999-9999-4999-8999-000000000001",
    created_at: "2026-11-20T12:10:00.000Z",
    kind: "note",
    from: USER_A,
    from_kind: "user",
    body: "Normal body with oversized reactions",
    reactions: hugeReactions,
  };

  // Hosted single oversized row: fits strictly within wire budget and preserves cursor + row identity.
  const hostedMax = 8192;
  const hostedBudget = hostedMax - CONVERSATION_READ_MARGIN_BYTES;
  const hostedFitted = fitHostedConversationHistoryPage({
    context: { workspace_id: WS },
    workspace_id: WS,
    conversation: { conversation_id: CONV, kind: "dm" },
    messages: [giantRow],
    has_more: false,
    next_before: { created_at: giantRow.created_at, id: giantRow.id },
    next_after: { created_at: giantRow.created_at, id: giantRow.id },
  }, "backward", hostedMax);
  assert.ok(channelPageWireBytes(hostedFitted) <= hostedBudget, "hosted fitted single row must fit wire budget");
  assert.equal(hostedFitted.messages.length, 1);
  assert.equal(hostedFitted.messages[0]!.id, giantRow.id);
  assert.equal(hostedFitted.messages[0]!.reactions_actors_omitted, true);
  assert.deepEqual(hostedFitted.next_before, { created_at: giantRow.created_at, id: giantRow.id });

  // Hosted tight budget where even the compacted row does not fit -> navigable empty page with cursor.
  // Note: channelPageWireBytes reserves 1,536 bytes for the worst-case JSON-RPC request id alone.
  const tinyMax = 3200;
  const tinyBudget = tinyMax - CONVERSATION_READ_MARGIN_BYTES;
  const tinyFitted = fitHostedConversationHistoryPage({
    context: { workspace_id: WS },
    workspace_id: WS,
    conversation: { conversation_id: CONV, kind: "dm", members: Array.from({ length: 20 }, (_, i) => ({ id: i, name: "m".repeat(80) })) },
    messages: [{ ...giantRow, body: "x".repeat(5000) }],
    has_more: false,
    next_before: null,
    next_after: null,
  }, "forward", tinyMax);
  assert.ok(channelPageWireBytes(tinyFitted) <= tinyBudget, "hosted tight budget must still fit wire budget");
  assert.equal(tinyFitted.has_more, true);
  assert.equal(tinyFitted.oversized_omitted, true);
  assert.deepEqual(tinyFitted.next_after, { created_at: giantRow.created_at, id: giantRow.id });

  // Stdio single oversized row: fits strictly within MCP_RESULT_MAX_BYTES even with >100 KiB reaction metadata.
  const stdioFitted = fitStdioConversationHistory({
    conversation: { conversation_id: CONV, kind: "dm" },
    messages: [giantRow],
    has_more: false,
    next_before: { created_at: giantRow.created_at, id: giantRow.id },
    next_after: { created_at: giantRow.created_at, id: giantRow.id },
  }, "backward") as {
    messages: Array<Record<string, unknown>>;
    next_before: { created_at: string; id: string } | null;
  };
  assert.ok(
    Buffer.byteLength(JSON.stringify(stdioFitted)) <= MCP_RESULT_MAX_BYTES,
    "stdio fitted single row must stay <= MCP_RESULT_MAX_BYTES",
  );
  assert.equal(stdioFitted.messages.length, 1);
  assert.equal(stdioFitted.messages[0]!.id, giantRow.id);
  assert.equal(stdioFitted.messages[0]!.reactions_actors_omitted, true);
  assert.deepEqual(stdioFitted.next_before, { created_at: giantRow.created_at, id: giantRow.id });

  // Stdio tight cap -> first compacts body & expansions, then falls back to a navigable bounded empty page.
  const stdioCompacted = fitStdioConversationHistory({
    conversation: { conversation_id: CONV, kind: "dm", members: Array.from({ length: 30 }, (_, i) => ({ id: i, name: "n".repeat(120) })) },
    messages: [{ ...giantRow, body: "y".repeat(6000) }],
    has_more: false,
    next_before: null,
    next_after: null,
  }, "backward", 600) as { messages: Array<Record<string, unknown>> };
  assert.ok(Buffer.byteLength(JSON.stringify(stdioCompacted)) <= 600);
  assert.equal(stdioCompacted.messages.length, 1);
  assert.equal(stdioCompacted.messages[0]!.body_truncated, true);

  const stdioTight = fitStdioConversationHistory({
    conversation: { conversation_id: CONV, kind: "dm", members: Array.from({ length: 30 }, (_, i) => ({ id: i, name: "n".repeat(120) })) },
    messages: [{ ...giantRow, body: "y".repeat(6000) }],
    has_more: false,
    next_before: null,
    next_after: null,
  }, "backward", 380) as { messages: unknown[]; has_more: boolean; oversized_omitted?: boolean; next_before: { id: string } | null };
  assert.ok(Buffer.byteLength(JSON.stringify(stdioTight)) <= 380);
  assert.equal(stdioTight.has_more, true);
  assert.equal(stdioTight.oversized_omitted, true);
  assert.equal(stdioTight.next_before?.id, giantRow.id);
});
