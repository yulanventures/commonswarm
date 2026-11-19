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
  buildInviteConversationCommand,
  buildJoinConversationCommand,
  buildLeaveConversationCommand,
  buildMarkConversationReadCommand,
  buildOpenConversationCommand,
  buildRemoveConversationCommand,
  buildSetConversationNotifyCommand,
  canInviteToConversation,
  canLeaveConversation,
  CONVERSATION_INVITE_MAX,
  CONVERSATION_MEMBER_MAX,
  CONVERSATION_NOTIFY_LEVELS,
  conversationTitle,
  conversationUnreadBadge,
  NOTES_TO_SELF_LABEL,
  parseConversationActionResponse,
  parseConversationOpenResponse,
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
