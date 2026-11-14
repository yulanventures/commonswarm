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

/* The two paths the security review found. Both are about what the browser does before the server can refuse. */

test("a channel that is open on screen but gone from the list is not an unfiled place", async () => {
  const { sendDestination, placementVisibility: visibilityOf, attachmentsAllowed: allowed } = await import("./private-channels.ts");
  const place = (activeChannelId, reply) => sendDestination({ activeChannelId, generalId: "general", ...(reply === undefined ? {} : { replyRootChannelId: reply }) });
  // Genuinely unfiled: All messages, #general, a direct message (no channel is open there).
  assert.deepEqual(place(null), { channelId: null, mustResolve: false });
  assert.deepEqual(place("general"), { channelId: null, mustResolve: false });
  // A concrete channel keeps its own id whether or not the list still has it.
  assert.deepEqual(place("lock-1"), { channelId: "lock-1", mustResolve: true });
  assert.deepEqual(place("gone-1"), { channelId: "gone-1", mustResolve: true });
  assert.equal(allowed(visibilityOf(channels, place("gone-1").channelId)), false,
    "removed from a private channel: its row is gone, and files are refused, not sent as unfiled");
  assert.equal(allowed(visibilityOf(channels, place("open-1").channelId)), true, "an open channel still takes files");
  assert.equal(allowed(visibilityOf(channels, place(null).channelId)), true, "and so does #general");
  // A reply is filed where its root is, whatever is open on screen.
  assert.deepEqual(place("open-1", "lock-1"), { channelId: "lock-1", mustResolve: false });
  assert.deepEqual(place("lock-1", null), { channelId: null, mustResolve: false });
});

test("nothing is uploaded until a fresh read says the destination is open", async () => {
  const { uploadAttachmentsFor, AttachmentsRefused, PRIVATE_CHANNEL_ATTACHMENTS_TEXT: privateText } = await import("./private-channels.ts");
  const attempt = async (channelId, fresh) => {
    const calls = { reads: [], uploads: [] };
    let outcome;
    try {
      outcome = await uploadAttachmentsFor({
        channelId, files: ["a.pdf", "b.png"],
        readVisibility: async (id) => { calls.reads.push(id); if (fresh instanceof Error) throw fresh; return fresh; },
        upload: async (file, index) => { calls.uploads.push(file); return `ref-${index}`; },
      });
    } catch (error) { outcome = error; }
    return { calls, outcome };
  };
  // The page's list said open; the channel was made private from another client a moment ago.
  const stale = await attempt("open-1", "private");
  assert.deepEqual(stale.calls.uploads, [], "no file leaves the browser");
  assert.deepEqual(stale.calls.reads, ["open-1"]);
  assert.equal(stale.outcome instanceof AttachmentsRefused, true);
  assert.equal(stale.outcome.message, privateText);
  // The read failed, was refused, found no row, or returned a value this build does not know.
  for (const fresh of [new Error("network"), null, undefined, "secret"]) {
    const closed = await attempt("open-1", fresh);
    assert.deepEqual(closed.calls.uploads, [], `fresh read ${String(fresh)}: nothing is uploaded`);
    assert.equal(closed.outcome instanceof AttachmentsRefused, true);
    assert.equal(closed.outcome.message.includes("private"), false, "it does not claim the channel is private when it does not know");
  }
  // Positive controls: a channel the fresh read confirms open, and an unfiled message.
  const open = await attempt("open-1", "open");
  assert.deepEqual([open.calls.reads, open.calls.uploads, open.outcome], [["open-1"], ["a.pdf", "b.png"], ["ref-0", "ref-1"]]);
  const unfiled = await attempt(null, "private");
  assert.deepEqual([unfiled.calls.reads, unfiled.calls.uploads, unfiled.outcome], [[], ["a.pdf", "b.png"], ["ref-0", "ref-1"]],
    "unfiled is not a channel: there is nothing to read");
  // No files: no read either.
  const none = { reads: 0 };
  assert.deepEqual(await uploadAttachmentsFor({ channelId: "open-1", files: [], readVisibility: async () => { none.reads += 1; return "open"; }, upload: async () => "x" }), []);
  assert.equal(none.reads, 0);
});
