import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMarkChannelReadCommand } from "../supabase/functions/command/channel-reads.js";
import { HUMAN_ONLY_COMMANDS } from "../src/protocol/workspace-commands.js";

const CHANNEL = "3F2B8A9C-1D4E-4F6A-9B7C-0E1D2C3B4A59";
const SIGNAL = "7A6B5C4D-3E2F-4A1B-8C9D-0E1F2A3B4C5D";

test("mark_channel_read takes one channel, optionally through a message, or all: true", () => {
  assert.deepEqual(parseMarkChannelReadCommand({ kind: "mark_channel_read", channel_id: CHANNEL }), {
    ok: true,
    command: { kind: "mark_channel_read", channel_id: CHANNEL.toLowerCase(), through_signal_id: null },
  });
  assert.deepEqual(
    parseMarkChannelReadCommand({ kind: "mark_channel_read", channel_id: null, through_signal_id: SIGNAL }),
    { ok: true, command: { kind: "mark_channel_read", channel_id: null, through_signal_id: SIGNAL.toLowerCase() } },
  );
  assert.deepEqual(
    parseMarkChannelReadCommand({ kind: "mark_channel_read", channel_id: CHANNEL, through_signal_id: null }),
    parseMarkChannelReadCommand({ kind: "mark_channel_read", channel_id: CHANNEL }),
    "an explicit null through_signal_id is the same command as none",
  );
  assert.deepEqual(parseMarkChannelReadCommand({ kind: "mark_channel_read", all: true }), {
    ok: true,
    command: { kind: "mark_channel_read", all: true },
  });
});

test("mark_channel_read refuses anything else", () => {
  for (const cmd of [
    { kind: "mark_channel_read" },
    { kind: "mark_channel_read", through_signal_id: SIGNAL },
    { kind: "mark_channel_read", channel_id: "general" },
    { kind: "mark_channel_read", channel_id: CHANNEL, through_signal_id: "nope" },
    { kind: "mark_channel_read", channel_id: CHANNEL, extra: 1 },
    { kind: "mark_channel_read", all: false },
    { kind: "mark_channel_read", all: "true" },
    { kind: "mark_channel_read", all: true, channel_id: null },
  ]) {
    const parsed = parseMarkChannelReadCommand(cmd);
    assert.equal(parsed.ok, false, JSON.stringify(cmd));
  }
});

test("mark_channel_read is a person's command", () => {
  assert.ok(HUMAN_ONLY_COMMANDS.has("mark_channel_read"));
});
