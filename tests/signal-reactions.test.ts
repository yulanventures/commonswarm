import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeReactionEmoji, SIGNAL_REACTION_SHORTCODES } from "../src/protocol/signal-reactions.js";

test("a reaction is exactly one emoji, or a shortcode for one", () => {
  for (const [input, stored] of [
    ["\u{1F440}", "\u{1F440}"], [":eyes:", "\u{1F440}"], [":ROCKET:", "\u{1F680}"],
    ["\u{1F6E0}️", "\u{1F6E0}️"], ["\u{1F44D}\u{1F3FD}", "\u{1F44D}\u{1F3FD}"],
    ["\u{1F468}‍\u{1F469}‍\u{1F467}", "\u{1F468}‍\u{1F469}‍\u{1F467}"],
    ["\u{1F1FA}\u{1F1F8}", "\u{1F1FA}\u{1F1F8}"], ["1️⃣", "1️⃣"],
  ] as const) assert.equal(normalizeReactionEmoji(input), stored, JSON.stringify(input));
  for (const input of ["a", "1", "\u{1F440}\u{1F440}", " \u{1F440}", "\u{1F440} ", "", ":nope:", "ok\u{1F44D}", "‍", 42, null]) {
    assert.equal(normalizeReactionEmoji(input), null, JSON.stringify(input));
  }
  for (const [code, emoji] of Object.entries(SIGNAL_REACTION_SHORTCODES)) {
    assert.equal(normalizeReactionEmoji(emoji), emoji, `${code} maps to an emoji the rule itself accepts`);
  }
});
