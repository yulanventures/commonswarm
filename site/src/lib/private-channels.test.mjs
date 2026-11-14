/** Reached by `npm --prefix site test` through the src/lib/*.test.mjs glob. */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PRIVATE_CHANNEL_ATTACHMENTS_TEXT, attachmentsAllowed, attachmentsRefusal, parseChannelVisibility, placementVisibility,
} from "./private-channels.ts";

const channels = [
  { channelId: "open-1", visibility: "open" },
  { channelId: "lock-1", visibility: "private" },
  { channelId: "odd-1", visibility: null },
  { channelId: "old-1" },
];

test("a channel row's visibility is one of the server's two, or unknown", () => {
  assert.equal(parseChannelVisibility("open"), "open");
  assert.equal(parseChannelVisibility("private"), "private");
  for (const value of [undefined, null, "", "PRIVATE", "secret", 1]) assert.equal(parseChannelVisibility(value), null);
});

test("files may be attached only where the message's place is known to be open", () => {
  const allowed = (channelId) => attachmentsAllowed(placementVisibility(channels, channelId));
  assert.equal(allowed(null), true, "unfiled: #general, All messages, a direct message");
  assert.equal(allowed("open-1"), true);
  assert.equal(allowed("lock-1"), false, "a private channel, and a thread reply whose root is in one");
  assert.equal(allowed("odd-1"), false, "a visibility this build does not know");
  assert.equal(allowed("old-1"), false, "a row with no visibility at all");
  assert.equal(allowed("gone-1"), false, "a channel that is not in the list, or a list that has not loaded");
  assert.equal(attachmentsAllowed(placementVisibility([], "open-1")), false);
});

test("the refusal says private only where the channel is known to be private", () => {
  assert.equal(attachmentsRefusal("open"), "");
  assert.equal(attachmentsRefusal("private"), PRIVATE_CHANNEL_ATTACHMENTS_TEXT);
  assert.notEqual(attachmentsRefusal(null), "");
  assert.equal(attachmentsRefusal(null).includes("private"), false);
});
