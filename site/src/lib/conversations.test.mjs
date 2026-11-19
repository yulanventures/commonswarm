import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONVERSATION_INVITE_MAX as SERVER_INVITE_MAX,
  CONVERSATION_MEMBER_MAX as SERVER_MEMBER_MAX,
  CONVERSATION_NOTIFY_LEVELS as SERVER_NOTIFY_LEVELS,
  parseConversationCommand,
} from "../../../supabase/functions/command/conversations.ts";
import {
  attachmentsAllowedInConversation,
  buildConversationHistoryRequest,
  buildInviteConversationCommand,
  buildJoinConversationCommand,
  buildLeaveConversationCommand,
  buildListConversationsRequest,
  buildMarkConversationReadCommand,
  buildOpenConversationCommand,
  buildOversightHistoryRequest,
  buildOversightListRequest,
  buildRemoveConversationCommand,
  buildSetConversationNotifyCommand,
  canInviteToConversation,
  canLeaveConversation,
  CONVERSATION_INVITE_MAX,
  CONVERSATION_MEMBER_MAX,
  CONVERSATION_NOTIFY_LEVELS,
  CONVERSATION_UNAVAILABLE_TEXT,
  conversationTitle,
  conversationUnreadBadge,
  disambiguateMemberLabels,
  DM_ATTACHMENTS_REFUSAL_TEXT,
  DM_READONLY_SEND_REFUSAL_TEXT,
  NOTES_TO_SELF_LABEL,
  parseConversationActionResponse,
  parseConversationHistoryResponse,
  parseConversationOpenResponse,
  parseConversationsListOutcome,
  parseConversationsListResponse,
  parseOversightHistoryResponse,
  trueDmSendRefusal,
  parseOversightListResponse,
  sortDirectConversations,
} from "./conversations.ts";

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const A1 = "33333333-3333-4333-8333-333333333333";
const C1 = "44444444-4444-4444-8444-444444444444";
const S1 = "55555555-5555-4555-8555-555555555555";

test("browser conversation constants match the Step 2a command edge exactly", () => {
  assert.equal(CONVERSATION_MEMBER_MAX, SERVER_MEMBER_MAX);
  assert.equal(CONVERSATION_INVITE_MAX, SERVER_INVITE_MAX);
  assert.deepEqual([...CONVERSATION_NOTIFY_LEVELS], [...SERVER_NOTIFY_LEVELS]);
});

test("every browser conversation command builder is accepted by the real Step 2a server parser", () => {
  const commands = [
    buildOpenConversationCommand([{ kind: "user", id: U1.toUpperCase() }, { kind: "user", id: U1 }, { kind: "agent", id: A1 }]),
    buildOpenConversationCommand([{ kind: "user", id: U2 }, { kind: "agent", id: A1 }], true),
    buildJoinConversationCommand(C1.toUpperCase()),
    buildLeaveConversationCommand(C1),
    buildInviteConversationCommand(C1, [{ kind: "user", id: U2 }, { kind: "agent", id: A1 }, { kind: "agent", id: A1 }]),
    buildRemoveConversationCommand(C1, { kind: "agent", id: A1 }),
    buildMarkConversationReadCommand(C1),
    buildMarkConversationReadCommand(C1, S1.toUpperCase()),
    buildSetConversationNotifyCommand(C1, { notifyLevel: "muted" }),
    buildSetConversationNotifyCommand(C1, { starred: true, starRank: 2 }),
    buildSetConversationNotifyCommand(C1, { notifyLevel: "mentions", starred: false, starRank: 9 }),
  ];
  for (const payload of commands) {
    const parsed = parseConversationCommand(payload);
    assert.equal(parsed.ok, true, `server parser rejected ${JSON.stringify(payload)}: ${!parsed.ok ? parsed.reason : ""}`);
  }
});

test("conversation_open decoder preserves #511 group refusal copy and offers new group only when another member left", () => {
  const opened = parseConversationOpenResponse(200, {
    status: "accepted",
    created: true,
    conversation: {
      conversation_id: C1.toUpperCase(),
      kind: "group_dm",
      generation: 2,
      members: [{ kind: "user", id: U1 }, { kind: "user", id: U2 }, { kind: "agent", id: A1 }],
    },
  });
  assert.equal(opened.ok, true);
  if (opened.ok) {
    assert.equal(opened.created, true);
    assert.equal(opened.conversation.conversationId, C1);
    assert.equal(opened.conversation.kind, "group_dm");
    assert.equal(opened.conversation.generation, 2);
    assert.equal(opened.conversation.members.length, 3);
  }

  const callerLeft = parseConversationOpenResponse(409, {
    error: "conversation_left",
    message: "You left this group. Ask a current member to start a new group with you.",
  });
  assert.deepEqual(callerLeft, {
    ok: false,
    code: "conversation_left",
    message: "You left this group. Ask a current member to start a new group with you.",
    canStartNewGroup: false,
  });

  const otherLeft = parseConversationOpenResponse(409, {
    error: "conversation_member_left",
    message: "Sam left this group. To include everyone again, start a new group.",
  });
  assert.deepEqual(otherLeft, {
    ok: false,
    code: "conversation_member_left",
    message: "Sam left this group. To include everyone again, start a new group.",
    canStartNewGroup: true,
  });
});

test("conversation action decoder handles accepted fields and structured refusals", () => {
  const marked = parseConversationActionResponse(200, {
    status: "accepted",
    conversation_id: C1,
    kind: "dm",
    channel_id: null,
    read_through_at: "2026-11-19T12:00:00Z",
  }, "fallback");
  assert.deepEqual(marked, {
    ok: true,
    conversationId: C1,
    kind: "dm",
    channelId: null,
    readThroughAt: "2026-11-19T12:00:00Z",
  });

  const missing = parseConversationActionResponse(404, {
    error: "conversation_not_found",
    message: "There is no conversation with that id that you can open in this workspace.",
  }, "fallback");
  assert.deepEqual(missing, {
    ok: false,
    code: "conversation_not_found",
    message: "There is no conversation with that id that you can open in this workspace.",
  });
});

test("conversation titles, sorting, leave/invite rules, unread badges, and fail-closed attachments match Step 3 rules", () => {
  assert.equal(conversationTitle({ kind: "general", slug: null, members: [] }, U1), "#general");
  assert.equal(conversationTitle({ kind: "public_channel", slug: "design", members: [] }, U1), "#design");
  assert.equal(conversationTitle({ kind: "dm", slug: null, members: [{ kind: "user", id: U1, name: "Me" }] }, U1), NOTES_TO_SELF_LABEL);
  assert.equal(
    conversationTitle({
      kind: "dm",
      slug: null,
      members: [{ kind: "user", id: U1, name: "Me" }, { kind: "agent", id: A1, name: "Lead" }],
    }, U1),
    "Lead",
  );
  assert.equal(
    conversationTitle({
      kind: "group_dm",
      slug: null,
      members: [
        { kind: "user", id: U1, name: "Me" },
        { kind: "user", id: U2, name: "Alex" },
        { kind: "agent", id: A1, name: "Lead" },
        { kind: "user", id: "66666666-6666-4666-8666-666666666666", name: "Departed", leftAt: "2026-11-19T00:00:00Z" },
      ],
    }, U1),
    "Alex and Lead",
  );

  assert.equal(canLeaveConversation("general"), false);
  assert.equal(canLeaveConversation("dm"), false);
  assert.equal(canLeaveConversation("public_channel"), true);
  assert.equal(canLeaveConversation("private_channel"), true);
  assert.equal(canLeaveConversation("group_dm"), true);

  assert.equal(canInviteToConversation("public_channel", false), true);
  assert.equal(canInviteToConversation("private_channel", false), true);
  assert.equal(canInviteToConversation("public_channel", true), false);
  assert.equal(canInviteToConversation("general", false), false);
  assert.equal(canInviteToConversation("dm", false), false);
  assert.equal(canInviteToConversation("group_dm", false), false);

  // Fail-closed attachments: only #general and public channels allow workspace-readable attachments.
  assert.equal(attachmentsAllowedInConversation("general"), true);
  assert.equal(attachmentsAllowedInConversation("public_channel"), true);
  assert.equal(attachmentsAllowedInConversation("private_channel"), false);
  assert.equal(attachmentsAllowedInConversation("dm"), false);
  assert.equal(attachmentsAllowedInConversation("group_dm"), false);
  assert.equal(attachmentsAllowedInConversation(null), false);

  // Unread/mention indicators respect mute and archive.
  assert.deepEqual(conversationUnreadBadge({ archivedAt: null, notifyLevel: "everything", unreadCount: 0, mentionCount: 0 }), { kind: "none" });
  assert.deepEqual(conversationUnreadBadge({ archivedAt: null, notifyLevel: "everything", unreadCount: 4, mentionCount: 0 }), { kind: "dot", label: "4 unread" });
  assert.deepEqual(conversationUnreadBadge({ archivedAt: null, notifyLevel: "mentions", unreadCount: 4, mentionCount: 2 }), { kind: "mentions", text: "2", label: "2 mentions" });
  assert.deepEqual(conversationUnreadBadge({ archivedAt: null, notifyLevel: "everything", unreadCount: 150, mentionCount: 120 }), { kind: "mentions", text: "99+", label: "120 mentions" });
  assert.deepEqual(conversationUnreadBadge({ archivedAt: null, notifyLevel: "muted", unreadCount: 10, mentionCount: 5 }), { kind: "none" });
  assert.deepEqual(conversationUnreadBadge({ archivedAt: "2026-11-19T00:00:00Z", notifyLevel: "everything", unreadCount: 10, mentionCount: 5 }), { kind: "none" });

  // Direct conversations sort newest activity first and exclude channels.
  const sorted = sortDirectConversations([
    { conversationId: "c-chan", kind: "public_channel", lastMessageAt: "2026-11-19T15:00:00Z" },
    { conversationId: "c-old", kind: "dm", lastMessageAt: "2026-11-19T10:00:00Z" },
    { conversationId: "c-new", kind: "group_dm", lastMessageAt: "2026-11-19T14:00:00Z" },
    { conversationId: "c-empty", kind: "dm", lastMessageAt: null },
  ]);
  assert.deepEqual(sorted.map((item) => item.conversationId), ["c-new", "c-old", "c-empty"]);
});

test("Step 2b read request builders and decoders match the wire spec and keep oversight read-only", () => {
  const WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  assert.deepEqual(buildListConversationsRequest(WS.toUpperCase()), {
    resource: "conversations",
    workspace_id: WS,
    include_archived: false,
  });
  assert.deepEqual(
    buildConversationHistoryRequest(WS, C1.toUpperCase(), {
      before: { createdAt: "2026-11-19T10:00:00Z", id: S1.toUpperCase() },
      limit: 50,
      includeMentions: true,
      includeReactions: true,
    }),
    {
      resource: "conversation_history",
      workspace_id: WS,
      conversation_id: C1,
      before_created_at: "2026-11-19T10:00:00Z",
      before_id: S1,
      limit: 50,
      include_mentions: true,
      include_reactions: true,
    },
  );
  assert.deepEqual(buildOversightListRequest(WS, A1.toUpperCase()), {
    resource: "conversation_oversight",
    workspace_id: WS,
    agent_principal_id: A1,
  });
  assert.deepEqual(
    buildOversightHistoryRequest(WS, C1, A1, {
      after: { createdAt: "2026-11-19T10:00:00Z", id: S1 },
    }),
    {
      resource: "conversation_oversight_history",
      workspace_id: WS,
      conversation_id: C1,
      agent_principal_id: A1,
      after_created_at: "2026-11-19T10:00:00Z",
      after_id: S1,
    },
  );

  const wireConv = {
    conversation_id: C1.toUpperCase(),
    kind: "public_channel",
    channel_id: C1.toUpperCase(),
    slug: "design",
    description: "UI work",
    archived_at: null,
    joined: false,
    generation: 0,
    lead_mode: "agent",
    lead_agent_principal_id: A1.toUpperCase(),
    members: [{ kind: "user", id: U1.toUpperCase(), name: "Me", left_at: null }],
    notify_level: "mentions",
    starred: true,
    star_rank: 1,
    read_through_at: "2026-11-19T09:00:00Z",
    read_through_id: S1.toUpperCase(),
    unread_count: 3,
    mention_count: 1,
    last_message_at: "2026-11-19T10:00:00Z",
    last_message_id: S1.toUpperCase(),
  };

  const list = parseConversationsListResponse({ conversations: [wireConv] });
  assert.equal(list.length, 1);
  assert.equal(list[0].conversationId, C1);
  assert.equal(list[0].joined, false);
  assert.equal(list[0].leadMode, "agent");
  assert.equal(list[0].leadAgentPrincipalId, A1);
  assert.equal(list[0].unreadCount, 3);
  assert.equal(list[0].mentionCount, 1);
  assert.equal(list[0].readThroughId, S1);

  const page = parseConversationHistoryResponse(
    200,
    {
      conversation: wireConv,
      messages: [{ id: S1, body: "hi" }],
      has_more: true,
      next_before: { created_at: "2026-11-19T09:00:00Z", id: S1.toUpperCase() },
      next_after: null,
    },
    (row) => String(row.id),
  );
  assert.equal(page.ok, true);
  if (page.ok) {
    assert.deepEqual(page.messages, [S1]);
    assert.equal(page.hasMore, true);
    assert.deepEqual(page.nextBefore, { createdAt: "2026-11-19T09:00:00Z", id: S1 });
    assert.equal(page.nextAfter, null);
  }

  const missing = parseConversationHistoryResponse(
    404,
    { error: "conversation_not_found", message: "This conversation isn't available in this workspace." },
    (row) => row,
  );
  assert.deepEqual(missing, {
    ok: false,
    code: "conversation_not_found",
    message: "This conversation isn't available in this workspace.",
  });

  // Oversight rows carry readOnly: true and omit personal sidebar/unread fields.
  const oversightList = parseOversightListResponse({
    conversations: [{ ...wireConv, kind: "dm", channel_id: null, slug: null, read_only: true }],
  });
  assert.equal(oversightList.length, 1);
  assert.equal(oversightList[0].readOnly, true);
  assert.equal("unreadCount" in oversightList[0], false);
  assert.equal("notifyLevel" in oversightList[0], false);

  const oversightPage = parseOversightHistoryResponse(
    200,
    {
      conversation: { ...wireConv, kind: "dm", channel_id: null, slug: null, read_only: true },
      messages: [{ id: S1 }],
      has_more: false,
      next_before: null,
      next_after: null,
    },
    (row) => String(row.id),
  );
  assert.equal(oversightPage.ok, true);
  if (oversightPage.ok) {
    assert.equal(oversightPage.conversation.readOnly, true);
    assert.deepEqual(oversightPage.messages, [S1]);
  }
});

test("empty or malformed 200 conversations read fails closed (Retry); only explicit not-supported selects legacy fallback", () => {
  // Empty 200 (e.g. truncated proxy response or empty JSON object) must fail, never select unsupported.
  assert.equal(parseConversationsListOutcome(200, {}).status, "failed");
  assert.equal(parseConversationsListOutcome(200, { grants: [] }).status, "failed");
  assert.equal(parseConversationsListOutcome(200, { conversations: null }).status, "failed");
  assert.equal(parseConversationsListOutcome(200, { conversations: "bad" }).status, "failed");

  // Any malformed row in an otherwise valid 200 list fails the entire read closed (Retry, composer hidden).
  const validGeneral = {
    conversation_id: C1,
    kind: "general",
    channel_id: null,
    slug: "general",
    description: null,
    archived_at: null,
    joined: true,
    members: [],
    notify_level: "everything",
    starred: false,
    star_rank: null,
    unread_count: 0,
    mention_count: 0,
    last_message_at: null,
    last_message_id: null,
  };
  assert.equal(
    parseConversationsListOutcome(200, {
      conversations: [validGeneral, { channel_id: "88888888-8888-4888-8888-888888888888", slug: "preview-only", joined: false }],
    }).status,
    "failed",
  );
  assert.equal(
    parseConversationsListOutcome(200, { conversations: [validGeneral, null] }).status,
    "failed",
  );
  assert.equal(
    parseConversationsListOutcome(200, {
      conversations: [{ ...validGeneral, kind: "public_channel", channel_id: null }],
    }).status,
    "failed",
  );
  assert.equal(
    parseConversationsListOutcome(200, {
      conversations: [{ ...validGeneral, joined: "yes" }],
    }).status,
    "failed",
  );

  // Transient and unlabelled errors also fail (Retry).
  assert.equal(parseConversationsListOutcome(503, { error: "service_unavailable" }).status, "failed");
  assert.equal(parseConversationsListOutcome(500, {}).status, "failed");
  assert.equal(parseConversationsListOutcome(400, {}).status, "failed");
  assert.equal(parseConversationsListOutcome(403, { error: "forbidden" }).status, "failed");

  // Only explicit pre-Step-2b not-supported signals select unsupported.
  assert.equal(parseConversationsListOutcome(400, { error: "invalid_request" }).status, "unsupported");
  assert.equal(parseConversationsListOutcome(400, { error: "invalid_resource" }).status, "unsupported");
  assert.equal(parseConversationsListOutcome(400, { error: "unsupported_resource" }).status, "unsupported");
  assert.equal(parseConversationsListOutcome(404, {}).status, "unsupported");

  // Valid 200 array selects ready.
  const ready = parseConversationsListOutcome(200, { conversations: [] });
  assert.deepEqual(ready, { status: "ready", conversations: [] });
});

test("trueDmSendRefusal blocks group DMs, Notes to self, stale DMs, and DM attachments (C1)", () => {
  const alex = { kind: "user", id: "22222222-2222-4222-8222-222222222222", name: "Alex", leftAt: null };
  const owner = { kind: "user", id: "11111111-1111-4111-8111-111111111111", name: "Owner", leftAt: null };
  const dmConv = {
    conversationId: "aaaa0000-0000-4000-8000-000000000001", kind: "dm", channelId: null, slug: null,
    description: null, archivedAt: null, joined: true, members: [owner, alex],
    notifyLevel: "everything", starred: false, starRank: null, unreadCount: 0, mentionCount: 0,
    lastMessageAt: null, lastMessageId: null,
  };
  const groupConv = { ...dmConv, conversationId: "aaaa0000-0000-4000-8000-000000000002", kind: "group_dm" };
  const notesConv = { ...dmConv, conversationId: "aaaa0000-0000-4000-8000-000000000003", members: [owner] };
  const list = [dmConv, groupConv, notesConv];

  // Group DM and Notes to self refuse submission and never fall back to public broadcast.
  assert.equal(
    trueDmSendRefusal({ activeDmConversationId: groupConv.conversationId, activeDm: null, workspaceConversations: list, hasAttachments: false }),
    DM_READONLY_SEND_REFUSAL_TEXT,
  );
  assert.equal(
    trueDmSendRefusal({ activeDmConversationId: notesConv.conversationId, activeDm: null, workspaceConversations: list, hasAttachments: false }),
    DM_READONLY_SEND_REFUSAL_TEXT,
  );
  // Missing / stale / unjoined conversation refuses submission.
  assert.equal(
    trueDmSendRefusal({ activeDmConversationId: "missing-id", activeDm: { kind: "person", id: alex.id }, workspaceConversations: list, hasAttachments: false }),
    CONVERSATION_UNAVAILABLE_TEXT,
  );
  assert.equal(
    trueDmSendRefusal({ activeDmConversationId: dmConv.conversationId, activeDm: { kind: "person", id: "99999999-9999-4999-8999-999999999999" }, workspaceConversations: list, hasAttachments: false }),
    CONVERSATION_UNAVAILABLE_TEXT,
  );
  // Attachments are refused on every true DM (both Step 2b 1:1 and legacy 1:1).
  assert.equal(
    trueDmSendRefusal({ activeDmConversationId: dmConv.conversationId, activeDm: { kind: "person", id: alex.id }, workspaceConversations: list, hasAttachments: true }),
    DM_ATTACHMENTS_REFUSAL_TEXT,
  );
  assert.equal(
    trueDmSendRefusal({ activeDmConversationId: null, activeDm: { kind: "person", id: alex.id }, workspaceConversations: list, hasAttachments: true }),
    DM_ATTACHMENTS_REFUSAL_TEXT,
  );
  // Live 1:1 DM without attachments and public channels are allowed.
  assert.equal(
    trueDmSendRefusal({ activeDmConversationId: dmConv.conversationId, activeDm: { kind: "person", id: alex.id }, workspaceConversations: list, hasAttachments: false }),
    null,
  );
  assert.equal(
    trueDmSendRefusal({ activeDmConversationId: null, activeDm: null, workspaceConversations: list, hasAttachments: true }),
    null,
  );
});

test("disambiguateMemberLabels distinguishes same-kind duplicate names with stable short IDs", () => {
  const labels = disambiguateMemberLabels([
    { kind: "user", id: "aaaa1111-1111-4111-8111-111111111111", name: "Alex" },
    { kind: "user", id: "bbbb2222-2222-4222-8222-222222222222", name: "alex" },
    { kind: "agent", id: "cccc3333-3333-4333-8333-333333333333", name: "Alex" },
    { kind: "user", id: "dddd4444-4444-4444-8444-444444444444", name: "Sam" },
  ]);
  assert.equal(labels.get("user:aaaa1111-1111-4111-8111-111111111111"), "Alex · aaaa11");
  assert.equal(labels.get("user:bbbb2222-2222-4222-8222-222222222222"), "alex · bbbb22");
  // Different kind ("agent") does not collide with "user".
  assert.equal(labels.get("agent:cccc3333-3333-4333-8333-333333333333"), "Alex");
  assert.equal(labels.get("user:dddd4444-4444-4444-8444-444444444444"), "Sam");

  // Colliding 6-char prefixes extend until every same-name entry is distinct.
  const deep = disambiguateMemberLabels([
    { kind: "user", id: "aaaaaa11-1111-4111-8111-111111111111", name: "Jordan Lee" },
    { kind: "user", id: "aaaaaa22-2222-4222-8222-222222222222", name: "Jordan Lee" },
  ]);
  assert.equal(deep.get("user:aaaaaa11-1111-4111-8111-111111111111"), "Jordan Lee · aaaaaa11");
  assert.equal(deep.get("user:aaaaaa22-2222-4222-8222-222222222222"), "Jordan Lee · aaaaaa22");
});
