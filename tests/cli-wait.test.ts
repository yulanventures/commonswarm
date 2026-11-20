import assert from "node:assert/strict";
import test from "node:test";
import {
  WAIT_DEFAULT_TIMEOUT_MS,
  WAIT_MAX_TIMEOUT_MS,
  WAIT_SIGINT_EXIT_CODE,
  WAIT_SIGTERM_EXIT_CODE,
  WaitCommandError,
  classifySetupError,
  compareCursor,
  decodeConversationCursor,
  encodeConversationCursor,
  executeWait,
  messageMatchesMentions,
  messageMatchesWaitFilter,
  parseWaitOptions,
  parseWaitTimeoutMs,
} from "../src/cli/wait.js";
import { cloudTarget } from "../src/cloud/config.js";
import type { ConversationSummaryWire } from "../src/cloud/conversations.js";

const WS = "11111111-1111-4111-8111-111111111111";
const USER_A = "22222222-2222-4222-8222-222222222222";
const AGENT_A = "44444444-4444-4444-8444-444444444444";
const AGENT_B = "55555555-5555-4555-8555-555555555555";
const GEN_CONV = "66666666-6666-4666-8666-666666666666";
const DESIGN_CONV = "77777777-7777-4777-8777-777777777777";
const ROOT_1 = "88888888-8888-4888-8888-888888888888";
const ROOT_2 = "99999999-9999-4999-8999-999999999999";
const SIG_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const SIG_2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const SIG_3 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
const SIG_4 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4";
const SECRET_BEARER = `swm_agt_${"S".repeat(43)}`;

const TARGET = cloudTarget("http://127.0.0.1:9", "anon-secret-never-echo");

function summary(
  overrides: Partial<ConversationSummaryWire> & Pick<ConversationSummaryWire, "conversation_id" | "kind">,
): ConversationSummaryWire {
  return {
    channel_id: null,
    slug: null,
    description: null,
    archived_at: null,
    joined: true,
    generation: 1,
    lead_mode: "workspace",
    lead_agent_principal_id: null,
    members: [],
    notify_level: "everything",
    starred: false,
    star_rank: null,
    read_through_at: null,
    read_through_id: null,
    unread_count: 0,
    mention_count: 0,
    last_message_at: null,
    last_message_id: null,
    ...overrides,
  };
}

function jsonResponse(
  status: number,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

test("encodeConversationCursor and decodeConversationCursor enforce V1/V3 byte-for-byte contract", () => {
  const input = { created_at: "2026-11-20T15:00:00.123Z", id: SIG_1.toUpperCase() };
  const encoded = encodeConversationCursor(input);
  const expected = Buffer.from(
    JSON.stringify({ v: 1, created_at: "2026-11-20T15:00:00.123Z", id: SIG_1 }),
    "utf8",
  ).toString("base64url");
  assert.equal(encoded, expected);
  assert.deepEqual(decodeConversationCursor(encoded), {
    created_at: "2026-11-20T15:00:00.123Z",
    id: SIG_1,
  });

  const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
  const badCursors = [
    "",
    "not+valid/base64=",
    "!!!",
    Buffer.from("not-json", "utf8").toString("base64url"),
    b64(null),
    b64([]),
    b64("hello"),
    b64({ v: 2, created_at: "2026-11-20T15:00:00Z", id: SIG_1 }),
    b64({ v: "1", created_at: "2026-11-20T15:00:00Z", id: SIG_1 }),
    b64({ v: 1, created_at: "2026-11-20T15:00:00Z", id: SIG_1, extra: true }),
    b64({ v: 1, created_at: "2026-02-30T15:00:00Z", id: SIG_1 }),
    b64({ v: 1, created_at: "2026-11-20", id: SIG_1 }),
    b64({ v: 1, created_at: "2026-11-20T15:00:00Z", id: "not-a-uuid" }),
  ];

  for (const raw of badCursors) {
    assert.throws(
      () => decodeConversationCursor(raw),
      (err: unknown) => {
        assert.ok(err instanceof WaitCommandError, `expected WaitCommandError for ${raw}`);
        assert.equal(err.payload.ok, false);
        assert.equal(err.payload.reason, "invalid_cursor");
        assert.equal(err.payload.error, "invalid_cursor");
        assert.ok(err.payload.next.length > 0);
        return true;
      },
    );
  }
});

test("parseWaitTimeoutMs and parseWaitOptions validate bounds and mutually exclusive flags", () => {
  assert.equal(parseWaitTimeoutMs(undefined), WAIT_DEFAULT_TIMEOUT_MS);
  assert.equal(parseWaitTimeoutMs("500ms"), 500);
  assert.equal(parseWaitTimeoutMs("10s"), 10_000);
  assert.equal(parseWaitTimeoutMs("5m"), 300_000);
  assert.equal(parseWaitTimeoutMs("30m"), WAIT_MAX_TIMEOUT_MS);

  for (const bad of ["0s", "-5s", "31m", "1801s", "1h", "5", "abc"]) {
    assert.throws(
      () => parseWaitTimeoutMs(bad),
      (err: unknown) => err instanceof WaitCommandError && err.payload.reason === "invalid_arguments",
    );
  }

  // Omitting both --conversation and --channel fails closed.
  assert.throws(
    () => parseWaitOptions({ mentions: false, json: true }),
    (err: unknown) => err instanceof WaitCommandError && err.payload.reason === "invalid_arguments",
  );
  // Combining --conversation and --channel fails closed.
  assert.throws(
    () => parseWaitOptions({ conversation: GEN_CONV, channel: "general", mentions: false, json: true }),
    (err: unknown) => err instanceof WaitCommandError && err.payload.reason === "invalid_arguments",
  );
  // Invalid channel slug fails locally.
  assert.throws(
    () => parseWaitOptions({ channel: "Not A Valid Slug!", mentions: false, json: true }),
    (err: unknown) => err instanceof WaitCommandError && err.payload.reason === "invalid_arguments",
  );
  // Combining --after and --after-created-at fails closed.
  const validCursor = encodeConversationCursor({ created_at: "2026-11-20T15:00:00Z", id: SIG_1 });
  assert.throws(
    () =>
      parseWaitOptions({
        conversation: GEN_CONV,
        mentions: false,
        after: validCursor,
        afterCreatedAt: "2026-11-20T15:00:00Z",
        afterId: SIG_1,
        json: true,
      }),
    (err: unknown) => err instanceof WaitCommandError && err.payload.reason === "invalid_arguments",
  );
  // Half cursor pair fails closed.
  assert.throws(
    () =>
      parseWaitOptions({
        conversation: GEN_CONV,
        mentions: false,
        afterCreatedAt: "2026-11-20T15:00:00Z",
        json: true,
      }),
    (err: unknown) => err instanceof WaitCommandError && err.payload.reason === "invalid_arguments",
  );
  // Valid --channel general and --channel <uuid> are accepted.
  const generalParsed = parseWaitOptions({ channel: "general", json: true });
  assert.equal(generalParsed.channel, "general");
  const generalUpperParsed = parseWaitOptions({ channel: "GENERAL", json: true });
  assert.equal(generalUpperParsed.channel, "GENERAL");
  const uuidChanParsed = parseWaitOptions({ channel: DESIGN_CONV, json: true });
  assert.equal(uuidChanParsed.channel, DESIGN_CONV);
  // Valid legacy pair works.
  const parsed = parseWaitOptions({
    conversation: GEN_CONV.toUpperCase(),
    thread: ROOT_1.toUpperCase(),
    mentions: true,
    afterCreatedAt: "2026-11-20T15:00:00Z",
    afterId: SIG_1.toUpperCase(),
    timeout: "10s",
    json: true,
  });
  assert.equal(parsed.conversationId, GEN_CONV);
  assert.equal(parsed.threadRootId, ROOT_1);
  assert.deepEqual(parsed.after, { created_at: "2026-11-20T15:00:00Z", id: SIG_1 });
  assert.equal(parsed.timeoutMs, 10_000);
});

test("messageMatchesMentions and messageMatchesWaitFilter match mentions, recipients, direct fields, and threads", () => {
  const actor = { kind: "agent" as const, id: AGENT_A };
  assert.equal(
    messageMatchesMentions({ mentions: [{ kind: "agent", id: AGENT_A.toUpperCase(), position: 0 }] }, actor),
    true,
  );
  assert.equal(
    messageMatchesMentions({ recipients: [{ kind: "agent", id: AGENT_A, position: 0 }] }, actor),
    true,
  );
  assert.equal(messageMatchesMentions({ to_agent: AGENT_A }, actor), true);
  assert.equal(messageMatchesMentions({ to: USER_A }, { kind: "user", id: USER_A }), true);
  assert.equal(messageMatchesMentions({ to_agent: AGENT_B, mentions: [{ kind: "user", id: USER_A }] }, actor), false);

  const threadReplyWithMention = {
    id: SIG_2,
    thread_root_id: ROOT_1,
    mentions: [{ kind: "agent", id: AGENT_A }],
  };
  assert.equal(
    messageMatchesWaitFilter(threadReplyWithMention, { threadRootId: ROOT_1, mentions: true, actor }),
    true,
  );
  assert.equal(
    messageMatchesWaitFilter(threadReplyWithMention, { threadRootId: ROOT_2, mentions: true, actor }),
    false,
  );
  assert.equal(
    messageMatchesWaitFilter({ id: SIG_2, thread_root_id: ROOT_1, mentions: [] }, { threadRootId: ROOT_1, mentions: true, actor }),
    false,
  );
});

test("executeWait resolves --channel fail-closed (never auto-creates) and anchors on current tip before matching new events", async () => {
  let clock = 1_000_000;
  const sleeps: number[] = [];
  const calls: Record<string, unknown>[] = [];
  let historyCalls = 0;

  const fetcher: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push(body);
    if (body.resource === "conversations") {
      return jsonResponse(200, {
        conversations: [
          summary({ conversation_id: GEN_CONV, kind: "general" }),
          summary({ conversation_id: DESIGN_CONV, kind: "public_channel", channel_id: DESIGN_CONV, slug: "design" }),
        ],
      });
    }
    if (body.resource === "conversation_history") {
      historyCalls += 1;
      if (historyCalls === 1) {
        // Initial tip anchor: existing message SIG_1 must NOT be replayed.
        return jsonResponse(200, {
          conversation: summary({ conversation_id: DESIGN_CONV, kind: "public_channel", slug: "design" }),
          messages: [{ id: SIG_1, created_at: "2026-11-20T15:00:00.000Z", body: "old history" }],
          has_more: false,
          next_before: { created_at: "2026-11-20T15:00:00.000Z", id: SIG_1 },
          next_after: { created_at: "2026-11-20T15:00:00.000Z", id: SIG_1 },
        });
      }
      if (historyCalls === 2) {
        // First after-poll: empty -> backs off.
        return jsonResponse(200, {
          conversation: summary({ conversation_id: DESIGN_CONV, kind: "public_channel", slug: "design" }),
          messages: [],
          has_more: false,
          next_before: null,
          next_after: null,
        });
      }
      // Second after-poll: two new messages arrive; return earliest matching with its own cursor!
      return jsonResponse(200, {
        conversation: summary({ conversation_id: DESIGN_CONV, kind: "public_channel", slug: "design" }),
        messages: [
          { id: SIG_2, created_at: "2026-11-20T15:00:05.000Z", body: "first new" },
          { id: SIG_3, created_at: "2026-11-20T15:00:06.000Z", body: "second new" },
        ],
        has_more: false,
        next_before: { created_at: "2026-11-20T15:00:05.000Z", id: SIG_2 },
        next_after: { created_at: "2026-11-20T15:00:06.000Z", id: SIG_3 },
      });
    }
    throw new Error(`unexpected resource ${String(body.resource)}`);
  };

  const result = await executeWait({
    target: TARGET,
    workspaceId: WS,
    credentialKind: "agent",
    getBearer: async () => SECRET_BEARER,
    actor: { kind: "agent", id: AGENT_A },
    options: parseWaitOptions({ channel: "design", timeout: "1m", json: true }),
    fetcher,
    now: () => clock,
    random: () => 0.5,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.matched, true);
    assert.equal(result.conversation_id, DESIGN_CONV);
    assert.equal(result.event.id, SIG_2);
    assert.equal(
      result.cursor,
      encodeConversationCursor({ created_at: "2026-11-20T15:00:05.000Z", id: SIG_2 }),
    );
    assert.equal(
      result.next[0],
      `cswarm wait --conversation ${DESIGN_CONV} --after ${result.cursor} --json`,
    );
  }
  // Poll 2 sent after_created_at / after_id from tip SIG_1
  assert.equal(calls[2]?.after_id, SIG_1);
  assert.deepEqual(sleeps, [1000, 1000]);

  // Unknown channel fails closed with channel_not_found and never calls command endpoint.
  await assert.rejects(
    () =>
      executeWait({
        target: TARGET,
        workspaceId: WS,
        credentialKind: "agent",
        getBearer: async () => SECRET_BEARER,
        options: parseWaitOptions({ channel: "nonexistent", timeout: "10s", json: true }),
        fetcher,
        now: () => clock,
        sleep: async () => {},
      }),
    (err: unknown) => {
      assert.ok(err instanceof WaitCommandError);
      assert.equal(err.payload.reason, "channel_not_found");
      assert.equal(err.payload.error, "channel_not_found");
      assert.ok(err.payload.next.some((hint) => hint.includes("cswarm channel ls")));
      return true;
    },
  );
});

test("executeWait filters by --thread and --mentions, drains has_more pages, and looks up bare-token identity", async () => {
  let clock = 2_000_000;
  const sleeps: number[] = [];
  let page = 0;

  const fetcher: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    if (body.resource === "members") {
      return jsonResponse(200, {
        members: [],
        agents: [{ principal_id: AGENT_A, name: "Worker" }],
        identity: { principal_id: AGENT_A, owner_user_id: USER_A },
      });
    }
    if (body.resource === "conversation_history") {
      page += 1;
      if (page === 1) {
        return jsonResponse(200, {
          conversation: summary({ conversation_id: GEN_CONV, kind: "general" }),
          messages: [
            { id: SIG_2, created_at: "2026-11-20T15:01:00.000Z", thread_root_id: null, mentions: [{ kind: "agent", id: AGENT_A }] },
            { id: SIG_3, created_at: "2026-11-20T15:01:01.000Z", thread_root_id: ROOT_1, mentions: [] },
          ],
          has_more: true,
          next_after: { created_at: "2026-11-20T15:01:01.000Z", id: SIG_3 },
        });
      }
      return jsonResponse(200, {
        conversation: summary({ conversation_id: GEN_CONV, kind: "general" }),
        messages: [
          {
            id: SIG_4,
            created_at: "2026-11-20T15:01:02.000Z",
            thread_root_id: ROOT_1,
            mentions: [{ kind: "agent", id: AGENT_A }],
            body: "@Worker please review",
          },
        ],
        has_more: false,
        next_after: { created_at: "2026-11-20T15:01:02.000Z", id: SIG_4 },
      });
    }
    throw new Error(`unexpected resource ${String(body.resource)}`);
  };

  const after = encodeConversationCursor({ created_at: "2026-11-20T15:00:00.000Z", id: SIG_1 });
  const result = await executeWait({
    target: TARGET,
    workspaceId: WS,
    credentialKind: "agent",
    getBearer: async () => SECRET_BEARER,
    actor: null, // Bare token: resolves via resource: "members"
    options: parseWaitOptions({
      conversation: GEN_CONV,
      thread: ROOT_1,
      mentions: true,
      after,
      timeout: "1m",
      json: true,
    }),
    fetcher,
    now: () => clock,
    random: () => 0.5,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.event.id, SIG_4);
    assert.equal(
      result.cursor,
      encodeConversationCursor({ created_at: "2026-11-20T15:01:02.000Z", id: SIG_4 }),
    );
  }
  // Drained has_more page immediately with zero sleeps.
  assert.deepEqual(sleeps, []);
});

test("executeWait honors Retry-After on 429 and ramps empty-poll backoff up to 3s cap", async () => {
  let clock = 3_000_000;
  const sleeps: number[] = [];
  let attempt = 0;

  const fetcher: typeof fetch = async () => {
    attempt += 1;
    if (attempt === 1) {
      return jsonResponse(429, { error: "rate_limited", message: "Slow down" }, { "retry-after": "2" });
    }
    if (attempt <= 5) {
      return jsonResponse(200, {
        conversation: summary({ conversation_id: GEN_CONV, kind: "general" }),
        messages: [],
        has_more: false,
        next_after: null,
      });
    }
    return jsonResponse(200, {
      conversation: summary({ conversation_id: GEN_CONV, kind: "general" }),
      messages: [{ id: SIG_2, created_at: "2026-11-20T15:05:00.000Z", body: "arrived" }],
      has_more: false,
      next_after: { created_at: "2026-11-20T15:05:00.000Z", id: SIG_2 },
    });
  };

  const after = encodeConversationCursor({ created_at: "2026-11-20T15:00:00.000Z", id: SIG_1 });
  const result = await executeWait({
    target: TARGET,
    workspaceId: WS,
    credentialKind: "agent",
    getBearer: async () => SECRET_BEARER,
    options: parseWaitOptions({ conversation: GEN_CONV, after, timeout: "5m", json: true }),
    fetcher,
    now: () => clock,
    random: () => 0.5, // factor = 1.0 (exact ramp)
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
  });

  assert.equal(result.ok, true);
  // First sleep honors Retry-After: 2 (2000ms), then empty polls ramp 1000 -> 1500 -> 2250 -> 3000.
  assert.deepEqual(sleeps, [2000, 1000, 1500, 2250, 3000]);
});

test("executeWait stops immediately on 401/403/404 access loss without leaking secrets", async () => {
  const after = encodeConversationCursor({ created_at: "2026-11-20T15:00:00.000Z", id: SIG_1 });
  for (const [status, expectedReason] of [
    [401, "auth_expired"],
    [403, "access_lost"],
    [404, "conversation_not_found"],
  ] as const) {
    let calls = 0;
    await assert.rejects(
      () =>
        executeWait({
          target: TARGET,
          workspaceId: WS,
          credentialKind: "agent",
          getBearer: async () => SECRET_BEARER,
          options: parseWaitOptions({ conversation: GEN_CONV, after, timeout: "5m", json: true }),
          fetcher: async () => {
            calls += 1;
            return jsonResponse(status, { error: expectedReason, message: "denied" });
          },
          sleep: async () => {
            throw new Error("should not sleep on terminal status");
          },
        }),
      (err: unknown) => {
        assert.ok(err instanceof WaitCommandError);
        assert.equal(err.payload.ok, false);
        assert.equal(err.payload.reason, expectedReason);
        assert.equal(err.exitCode, 1);
        const serialized = JSON.stringify(err.payload);
        assert.ok(!serialized.includes(SECRET_BEARER), "must never echo bearer token");
        assert.ok(!serialized.includes(TARGET.anonKey), "must never echo anon key");
        return true;
      },
    );
    assert.equal(calls, 1, `status ${status} must stop after 1 request`);
  }
});

test("compareCursor preserves sub-millisecond Postgres timestamps and classifySetupError maps profile_session_mismatch", async () => {
  const HIGH_UUID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const LOW_UUID = "00000000-0000-4000-8000-000000000001";
  const msg1 = { created_at: "2026-11-20T10:00:00.123456Z", id: HIGH_UUID };
  const msg2 = { created_at: "2026-11-20T10:00:00.123789Z", id: LOW_UUID };
  // Same millisecond with reversed UUID order: msg2 must sort strictly AFTER msg1.
  assert.equal(compareCursor(msg1, msg2), -1);
  assert.equal(compareCursor(msg2, msg1), 1);
  // Timezone offsets representing the same microsecond instant must compare equal on timestamp.
  assert.equal(
    compareCursor(
      { created_at: "2026-11-20T12:00:00.123456+02:00", id: LOW_UUID },
      { created_at: "2026-11-20T10:00:00.123456Z", id: LOW_UUID },
    ),
    0,
  );

  // Full executeWait witness: anchoring at msg1 (.123456Z, ffff...) must NOT drop msg2 (.123789Z, 0000...).
  const afterMsg1 = encodeConversationCursor(msg1);
  const res = await executeWait({
    target: TARGET,
    workspaceId: WS,
    credentialKind: "agent",
    getBearer: async () => SECRET_BEARER,
    options: parseWaitOptions({ conversation: GEN_CONV, after: afterMsg1, timeout: "30s", json: true }),
    fetcher: async () =>
      jsonResponse(200, {
        conversation: summary({ conversation_id: GEN_CONV, kind: "general" }),
        messages: [
          { id: HIGH_UUID, created_at: msg1.created_at, body: "first in ms" },
          { id: LOW_UUID, created_at: msg2.created_at, body: "second in same ms" },
        ],
        has_more: false,
        next_after: msg2,
      }),
    now: () => 6_000_000,
    sleep: async () => {},
  });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.event.id, LOW_UUID);
    assert.equal(res.cursor, encodeConversationCursor(msg2));
  }

  // classifySetupError maps profile_session_mismatch / profile_other_session / canonical message to V1 taxonomy.
  for (const input of [
    Object.assign(new Error("profile mismatch"), { code: "profile_session_mismatch" }),
    Object.assign(new Error("other session"), { code: "profile_other_session" }),
    new Error("This profile belongs to another session. Stop and tell the operator."),
  ]) {
    const mapped = classifySetupError(input, true);
    assert.equal(mapped.payload.ok, false);
    assert.equal(mapped.payload.error, "profile_session_mismatch");
    assert.equal(mapped.payload.reason, "profile_session_mismatch");
    assert.deepEqual(mapped.payload.next, ["cswarm setup guide"]);
  }
});

test("executeWait anchors on empty conversation (cursor null) and resolves --channel general", async () => {
  let clock = 5_000_000;
  let historyCalls = 0;
  const fetcher: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    if (body.resource === "conversations") {
      return jsonResponse(200, {
        conversations: [summary({ conversation_id: GEN_CONV, kind: "general" })],
      });
    }
    if (body.resource === "conversation_history") {
      historyCalls += 1;
      if (historyCalls === 1) {
        // Empty conversation on anchor
        return jsonResponse(200, {
          conversation: summary({ conversation_id: GEN_CONV, kind: "general" }),
          messages: [],
          has_more: false,
          next_before: null,
          next_after: null,
        });
      }
      return jsonResponse(200, {
        conversation: summary({ conversation_id: GEN_CONV, kind: "general" }),
        messages: [{ id: SIG_1, created_at: "2026-11-20T15:10:00.000Z", body: "first ever message" }],
        has_more: false,
        next_before: { created_at: "2026-11-20T15:10:00.000Z", id: SIG_1 },
        next_after: { created_at: "2026-11-20T15:10:00.000Z", id: SIG_1 },
      });
    }
    throw new Error(`unexpected resource ${String(body.resource)}`);
  };

  const result = await executeWait({
    target: TARGET,
    workspaceId: WS,
    credentialKind: "agent",
    getBearer: async () => SECRET_BEARER,
    options: parseWaitOptions({ channel: "general", timeout: "30s", json: true }),
    fetcher,
    now: () => clock,
    random: () => 0.5,
    sleep: async (ms) => { clock += ms; },
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.conversation_id, GEN_CONV);
    assert.equal(result.event.id, SIG_1);
    assert.equal(
      result.cursor,
      encodeConversationCursor({ created_at: "2026-11-20T15:10:00.000Z", id: SIG_1 }),
    );
  }
});

test("executeWait returns structured timeout payload with advanced cursor and handles SIGINT/SIGTERM cleanly", async () => {
  let clock = 4_000_000;
  const after = encodeConversationCursor({ created_at: "2026-11-20T15:00:00.000Z", id: SIG_1 });

  let calls = 0;
  const timeoutResult = await executeWait({
    target: TARGET,
    workspaceId: WS,
    credentialKind: "agent",
    getBearer: async () => SECRET_BEARER,
    actor: { kind: "agent", id: AGENT_A },
    options: parseWaitOptions({
      conversation: GEN_CONV,
      mentions: true,
      after,
      timeout: "3s",
      json: true,
    }),
    fetcher: async () => {
      calls += 1;
      return jsonResponse(200, {
        conversation: summary({ conversation_id: GEN_CONV, kind: "general" }),
        messages: calls === 1
          ? [{ id: SIG_2, created_at: "2026-11-20T15:00:05.000Z", mentions: [] }]
          : [],
        has_more: false,
        next_after: calls === 1 ? { created_at: "2026-11-20T15:00:05.000Z", id: SIG_2 } : null,
      });
    },
    now: () => clock,
    random: () => 0.5,
    sleep: async (ms) => {
      clock += ms;
    },
  });

  assert.equal(timeoutResult.ok, false);
  assert.equal(timeoutResult.matched, false);
  assert.equal(timeoutResult.reason, "timeout");
  assert.equal(
    timeoutResult.cursor,
    encodeConversationCursor({ created_at: "2026-11-20T15:00:05.000Z", id: SIG_2 }),
  );
  assert.ok(timeoutResult.next[0]?.includes(`--after ${timeoutResult.cursor}`));

  // SIGINT and SIGTERM abort immediately with exit codes 130 and 143.
  for (const [sig, code] of [
    ["SIGINT", WAIT_SIGINT_EXIT_CODE],
    ["SIGTERM", WAIT_SIGTERM_EXIT_CODE],
  ] as const) {
    const controller = new AbortController();
    await assert.rejects(
      () =>
        executeWait({
          target: TARGET,
          workspaceId: WS,
          credentialKind: "agent",
          getBearer: async () => SECRET_BEARER,
          options: parseWaitOptions({ conversation: GEN_CONV, after, timeout: "5m", json: true }),
          signal: controller.signal,
          fetcher: async () =>
            jsonResponse(200, {
              conversation: summary({ conversation_id: GEN_CONV, kind: "general" }),
              messages: [],
              has_more: false,
              next_after: null,
            }),
          sleep: async (_ms, abortSig) => {
            controller.abort(sig);
            assert.equal(abortSig.aborted, true);
          },
        }),
      (err: unknown) => {
        assert.ok(err instanceof WaitCommandError);
        assert.equal(err.exitCode, code);
        assert.equal(err.payload.reason, "interrupted");
        assert.equal(err.payload.signal, sig);
        assert.equal(err.payload.cursor, after);
        return true;
      },
    );
  }
});
