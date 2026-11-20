import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  CONVERSATION_COMMAND_KINDS,
  parseConversationCommand,
} from "../supabase/functions/command/conversations.js";

const ID = "3F2B8A9C-1D4E-4F6A-9B7C-0E1D2C3B4A59";
const OTHER = "7A6B5C4D-3E2F-4A1B-8C9D-0E1F2A3B4C5D";
const person = (id: string = OTHER) => ({ kind: "user", id });

test("each conversation command takes exactly its fields, ids lower-cased", () => {
  assert.deepEqual(parseConversationCommand({ kind: "conversation_open", members: [person()] }), {
    ok: true, command: { kind: "conversation_open", members: [{ kind: "user", id: OTHER.toLowerCase() }], new_group: false },
  });
  assert.equal((parseConversationCommand({ kind: "conversation_open", members: [person()], new_group: true }) as
    { command: { new_group: boolean } }).command.new_group, true);
  for (const kind of ["conversation_join", "conversation_leave"]) {
    assert.deepEqual(parseConversationCommand({ kind, conversation_id: ID }),
      { ok: true, command: { kind, conversation_id: ID.toLowerCase() } });
  }
  assert.deepEqual(parseConversationCommand({ kind: "conversation_mark_read", conversation_id: ID }), {
    ok: true, command: { kind: "conversation_mark_read", conversation_id: ID.toLowerCase(), through_signal_id: null },
  });
  assert.deepEqual(parseConversationCommand({ kind: "conversation_set_notify", conversation_id: ID, starred: true, star_rank: 2 }), {
    ok: true, command: { kind: "conversation_set_notify", conversation_id: ID.toLowerCase(), starred: true, star_rank: 2 },
  });
  assert.equal(CONVERSATION_COMMAND_KINDS.length, 7);
});

test("malformed conversation commands are refused at the wire", () => {
  const nine = Array.from({ length: 9 }, (_, i) => person(`00000000-0000-4000-8000-00000000000${i}`));
  for (const bad of [
    { kind: "conversation_open" },
    { kind: "conversation_open", members: [] },
    { kind: "conversation_open", members: [...nine, person()] },
    { kind: "conversation_open", members: [person(), person()] },
    { kind: "conversation_open", members: [{ kind: "robot", id: OTHER }] },
    { kind: "conversation_open", members: [person()], new_group: 1 },
    { kind: "conversation_join", conversation_id: "general" },
    { kind: "conversation_leave", conversation_id: ID, extra: true },
    { kind: "conversation_invite", conversation_id: ID },
    { kind: "conversation_remove", conversation_id: ID, member: { kind: "user" } },
    { kind: "conversation_mark_read", conversation_id: ID, through_signal_id: "x" },
    { kind: "conversation_set_notify", conversation_id: ID },
    { kind: "conversation_set_notify", conversation_id: ID, notify_level: "loud" },
    { kind: "conversation_set_notify", conversation_id: ID, star_rank: 1 },
    { kind: "conversation_set_notify", conversation_id: ID, starred: true, star_rank: -1 },
  ]) {
    const parsed = parseConversationCommand(bad);
    assert.equal(parsed.ok, false, JSON.stringify(bad));
  }
  assert.equal(parseConversationCommand({ kind: "conversation_open", members: nine }).ok, true, "nine members parse");
});

test("the iPhone conversation requests are accepted by the command parser", () => {
  const commands = JSON.parse(readFileSync("ios/Development/conversation-commands.json", "utf8")) as Record<string, unknown>[];
  assert.deepEqual(commands.map(cmd => cmd.kind).sort(),
    ["conversation_invite", "conversation_join", "conversation_leave", "conversation_mark_read", "conversation_open", "conversation_remove", "conversation_set_notify"]);
  for (const cmd of commands) assert.equal(parseConversationCommand(cmd).ok, true, String(cmd.kind));
});
