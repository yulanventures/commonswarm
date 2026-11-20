import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCheckNext,
  buildCliErrorEnvelope,
  buildConversationReadNext,
  buildOnboardingErrorEnvelope,
  classifyCliError,
  ConversationReadRefusedError,
  decodeOpaqueCursor,
  encodeOpaqueCursor,
  InvalidCursorError,
  latestMessageCursor,
  scrubCliSecrets,
  summarizeWhoamiChannelsFallback,
  summarizeWhoamiConversations,
  unavailableWhoamiConversations,
} from "../src/cli/ax.js";
import { AgentSetupError } from "../src/cloud/agent-profile.js";
import type { ConversationSummaryWire } from "../src/cloud/conversations.js";

const WS = "11111111-1111-4111-8111-111111111111";
const CONV = "22222222-2222-4222-8222-222222222222";
const SIG_1 = "33333333-3333-4333-8333-333333333333";
const SIG_2 = "44444444-4444-4444-8444-444444444444";
const USER_1 = "55555555-5555-4555-8555-555555555555";
const AGENT_1 = "66666666-6666-4666-8666-666666666666";

test("opaque cursor codec round-trips exact V1/V3 base64url JSON contract", () => {
  const created_at = "2026-11-20T12:34:56.789Z";
  const encoded = encodeOpaqueCursor({ created_at, id: SIG_1.toUpperCase() });

  const rawJson = Buffer.from(encoded, "base64url").toString("utf8");
  assert.deepEqual(JSON.parse(rawJson), { v: 1, created_at, id: SIG_1 });
  assert.equal(encoded.includes("="), false);
  assert.equal(encoded.includes("+"), false);
  assert.equal(encoded.includes("/"), false);

  const decoded = decodeOpaqueCursor(encoded);
  assert.deepEqual(decoded, { v: 1, created_at, id: SIG_1 });
});

test("decodeOpaqueCursor strictly rejects malformed, padded, extra-key, or wrong-version cursors", () => {
  const valid = encodeOpaqueCursor({ created_at: "2026-11-20T12:00:00.000Z", id: SIG_1 });
  const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");

  const invalidCases = [
    "",
    "not-base64!!!",
    `${valid}=`,
    Buffer.from(JSON.stringify({ v: 1, created_at: "2026-11-20T12:00:00.000Z", id: SIG_1 }), "utf8").toString("base64"),
    b64({ v: 2, created_at: "2026-11-20T12:00:00.000Z", id: SIG_1 }),
    b64({ v: 1, created_at: "2026-11-20T12:00:00.000Z", id: SIG_1, extra: true }),
    b64({ v: 1, created_at: "not-a-date", id: SIG_1 }),
    b64({ v: 1, created_at: "2026-11-20", id: SIG_1 }),
    b64({ v: 1, created_at: "2026-11-20T12:00:00.000Z", id: "not-a-uuid" }),
    b64([1, "2026-11-20T12:00:00.000Z", SIG_1]),
    b64("hello"),
  ];

  for (const candidate of invalidCases) {
    assert.throws(
      () => decodeOpaqueCursor(candidate),
      (err: unknown) => err instanceof InvalidCursorError && err.code === "invalid_cursor" && err.reason === "invalid_cursor",
      `expected InvalidCursorError for ${candidate}`,
    );
  }
});

test("latestMessageCursor selects newest (created_at, id) regardless of page ordering", () => {
  const picked = latestMessageCursor([
    { created_at: "2026-11-20T10:00:02.000Z", id: SIG_1 },
    { created_at: "2026-11-20T10:00:02.000Z", id: SIG_2 },
    { created_at: "2026-11-20T10:00:01.000Z", id: "ffffffff-ffff-4fff-8fff-ffffffffffff" },
    { created_at: "bad", id: "bad" },
  ]);
  assert.deepEqual(picked, { created_at: "2026-11-20T10:00:02.000Z", id: SIG_2 });
  assert.equal(latestMessageCursor([]), null);
});

test("scrubCliSecrets redacts agent tokens, capability tokens, bearer headers, JWTs, and JSON secrets", () => {
  const agentToken = `swm_agt_${"A".repeat(43)}`;
  const capToken = `swm_cap_${"B".repeat(43)}`;
  const jwt = `eyJhbGciOiJIUzI1NiJ9.${"c".repeat(20)}.${"d".repeat(20)}`;
  const raw = `\u001b[31mDenied\u001b[0m ${agentToken} ${capToken} Bearer secret_value_123456 ${jwt} {"access_token":"topsecret","refresh_token":"alsosecret"}`;
  const scrubbed = scrubCliSecrets(raw);

  assert.doesNotMatch(scrubbed, /swm_agt_/);
  assert.doesNotMatch(scrubbed, /swm_cap_/);
  assert.doesNotMatch(scrubbed, /secret_value_123456/);
  assert.doesNotMatch(scrubbed, /eyJhbGciOi/);
  assert.doesNotMatch(scrubbed, /topsecret/);
  assert.doesNotMatch(scrubbed, /alsosecret/);
  assert.doesNotMatch(scrubbed, /\u001b/);
  assert.match(scrubbed, /\[redacted\]/);
});

test("classifyCliError maps every V1 failure class to a stable reason and safe runnable next hints", () => {
  const ctx = {
    verb: "conversation",
    subcommand: "read",
    profilePath: "/tmp/agent/profile.json",
    hostSessionId: "sess-1",
    workspaceId: WS,
    conversationId: CONV,
    channelSelector: "ops",
  };

  const sessionMismatch = buildCliErrorEnvelope(
    new AgentSetupError("profile_other_session", "This profile belongs to another session."),
    ctx,
  );
  assert.equal(sessionMismatch.ok, false);
  assert.equal(sessionMismatch.reason, "profile_session_mismatch");
  assert.equal(sessionMismatch.error, "profile_other_session");
  assert.match(sessionMismatch.next[0]!, /^cswarm setup --connection-file/);

  const invalidCursor = buildCliErrorEnvelope(new InvalidCursorError(), ctx);
  assert.equal(invalidCursor.reason, "invalid_cursor");
  assert.equal(invalidCursor.error, "invalid_cursor");
  assert.match(invalidCursor.next[0]!, new RegExp(`^cswarm conversation read ${CONV}`));

  const channelMissing = buildCliErrorEnvelope(
    new Error("There is no channel named ops in this workspace. Run cswarm channel ls to see them."),
    { ...ctx, verb: "channel", subcommand: "join" },
  );
  assert.equal(channelMissing.reason, "channel_not_found");
  assert.match(channelMissing.next[0]!, /^cswarm channel ls/);

  const convMissing = buildCliErrorEnvelope(
    new ConversationReadRefusedError(404, "conversation_not_found", "This conversation isn't available."),
    ctx,
  );
  assert.equal(convMissing.reason, "conversation_not_found");
  assert.match(convMissing.next[0]!, /^cswarm conversations/);

  const notMember = buildCliErrorEnvelope(
    new ConversationReadRefusedError(403, "conversation_not_member", "Join the channel before reading it."),
    ctx,
  );
  assert.equal(notMember.reason, "not_a_member");
  assert.match(notMember.next[0]!, /^cswarm channel join 'ops'/);

  const authExpired = buildCliErrorEnvelope(
    new ConversationReadRefusedError(401, "unauthenticated", "Unauthenticated"),
    ctx,
  );
  assert.equal(authExpired.reason, "auth_expired");
  assert.match(authExpired.next[0]!, /^cswarm whoami/);

  const accessLost = buildCliErrorEnvelope(
    new ConversationReadRefusedError(403, "hosted_seat_revoked", "Seat revoked"),
    ctx,
  );
  assert.equal(accessLost.reason, "access_lost");
  assert.match(accessLost.next[0]!, /^cswarm resume/);

  const notConfigured = buildCliErrorEnvelope(
    new AgentSetupError("profile_missing", "Profile missing"),
    ctx,
  );
  assert.equal(notConfigured.reason, "not_configured");
  assert.match(notConfigured.next[0]!, /^cswarm setup --connection-file/);

  const rateLimited = buildCliErrorEnvelope(
    new ConversationReadRefusedError(429, "rate_limited", "Too many requests"),
    ctx,
  );
  assert.equal(rateLimited.reason, "rate_limited");
  assert.ok(rateLimited.next.length > 0);

  const timeout = buildCliErrorEnvelope(
    new AgentSetupError("check_timeout", "The message check timed out."),
    { verb: "check", profilePath: "/tmp/agent/profile.json", hostSessionId: "sess-1", workspaceId: WS },
  );
  assert.equal(timeout.reason, "timeout");
  assert.match(timeout.next[0]!, /^cswarm check /);

  const invalidArgs = buildCliErrorEnvelope(new Error("unknown option: --wat"), { verb: "whoami", isUsageError: true });
  assert.equal(invalidArgs.reason, "invalid_arguments");
  assert.equal(invalidArgs.next[0], "cswarm whoami --help");

  const onboarding = buildOnboardingErrorEnvelope(
    new InvalidCursorError(),
    "invalid_cursor",
    "Invalid --after cursor.",
    { verb: "check", profilePath: "/tmp/agent/profile.json", hostSessionId: "sess-1" },
  );
  assert.equal(onboarding.ok, false);
  assert.deepEqual(onboarding.error, { code: "invalid_cursor", message: "Invalid --after cursor." });
  assert.equal(onboarding.reason, "invalid_cursor");
  assert.match(onboarding.next[0]!, /^cswarm check /);
});

test("continuation builders quote flags safely and include --after and --json", () => {
  const cursor = encodeOpaqueCursor({ created_at: "2026-11-20T12:00:00.000Z", id: SIG_1 });
  const convNext = buildConversationReadNext({
    conversationId: CONV.toUpperCase(),
    afterCursor: cursor,
    profilePath: "/tmp/my profile/profile.json",
    hostSessionId: "sess A",
    workspaceId: WS,
    limit: 25,
  });
  assert.match(convNext, new RegExp(`^cswarm conversation read ${CONV} --after ${cursor} --limit 25`));
  assert.match(convNext, /--profile '\/tmp\/my profile\/profile\.json'/);
  assert.match(convNext, /--host-session-id 'sess A'/);
  assert.match(convNext, /--json$/);

  const checkNext = buildCheckNext({
    profilePath: "/tmp/my profile/profile.json",
    workspaceId: WS,
    hostSessionId: "sess-1",
    afterCursor: cursor,
  });
  assert.match(checkNext, new RegExp(`--after ${cursor} --json$`));
});

test("whoami conversation summarizers cover Step 2b, pre-2b channels fallback, and unavailable", () => {
  const wires: ConversationSummaryWire[] = [
    {
      conversation_id: CONV,
      kind: "general",
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
      unread_count: 2,
      mention_count: 1,
      last_message_at: null,
      last_message_id: null,
    },
    {
      conversation_id: SIG_1,
      kind: "public_channel",
      channel_id: SIG_1,
      slug: "design",
      description: null,
      archived_at: null,
      joined: false,
      generation: 1,
      lead_mode: "workspace",
      lead_agent_principal_id: null,
      members: [],
      notify_level: "everything",
      starred: false,
      star_rank: null,
      read_through_at: null,
      read_through_id: null,
      unread_count: 9,
      mention_count: 3,
      last_message_at: null,
      last_message_id: null,
    },
    {
      conversation_id: SIG_2,
      kind: "dm",
      channel_id: null,
      slug: null,
      description: null,
      archived_at: null,
      joined: true,
      generation: 1,
      lead_mode: "none",
      lead_agent_principal_id: null,
      members: [
        { kind: "user", id: USER_1, name: "Owner", left_at: null },
        { kind: "agent", id: AGENT_1, name: "Old", left_at: "2026-11-19T00:00:00.000Z" },
      ],
      notify_level: "everything",
      starred: false,
      star_rank: null,
      read_through_at: null,
      read_through_id: null,
      unread_count: 1,
      mention_count: 0,
      last_message_at: null,
      last_message_id: null,
    },
  ];

  const step2b = summarizeWhoamiConversations(wires);
  assert.equal(step2b.source, "conversations");
  assert.equal(step2b.channels.length, 2);
  assert.equal(step2b.direct_messages.length, 1);
  assert.deepEqual(step2b.direct_messages[0]!.members, [{ kind: "user", id: USER_1, name: "Owner" }]);
  // Only joined channels + DMs count toward unread totals
  assert.equal(step2b.total_unread, 3);
  assert.equal(step2b.total_mentions, 1);

  const fallback = summarizeWhoamiChannelsFallback({
    general_unread: true,
    channels: [
      {
        channel_id: SIG_1,
        slug: "ops",
        purpose: null,
        visibility: "open",
        archived_at: null,
        created_at: "2026-11-20T00:00:00.000Z",
        lead_mode: "workspace",
        lead_agent_principal_id: null,
        unread: false,
      },
    ],
  });
  assert.equal(fallback.source, "channels_fallback");
  assert.equal(fallback.channels.length, 2);
  assert.equal(fallback.channels[0]!.slug, "general");
  assert.equal(fallback.channels[0]!.unread, true);
  assert.equal(fallback.channels[1]!.slug, "ops");
  assert.equal(fallback.direct_messages.length, 0);

  const unavailable = unavailableWhoamiConversations();
  assert.equal(unavailable.source, "unavailable");
  assert.deepEqual(unavailable.channels, []);
  assert.deepEqual(unavailable.direct_messages, []);
});
