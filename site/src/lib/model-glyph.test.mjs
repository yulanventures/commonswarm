import assert from "node:assert/strict";
import { test } from "node:test";
import { modelFamily, modelGlyphSvg } from "./model-glyph.ts";

test("modelFamily: claude and anthropic map to claude", () => {
  assert.equal(modelFamily("claude"), "claude");
  assert.equal(modelFamily("anthropic"), "claude");
});

test("modelFamily: openai, gpt, and codex map to openai", () => {
  assert.equal(modelFamily("openai"), "openai");
  assert.equal(modelFamily("gpt"), "openai");
  assert.equal(modelFamily("codex"), "openai");
});

test("modelFamily: gemini and google map to gemini", () => {
  assert.equal(modelFamily("gemini"), "gemini");
  assert.equal(modelFamily("google"), "gemini");
});

test("modelFamily: grok and grok-bot map to grok", () => {
  assert.equal(modelFamily("grok"), "grok");
  assert.equal(modelFamily("grok-bot"), "grok");
});

test("modelFamily: matching is case-insensitive and substring", () => {
  assert.equal(modelFamily("CLAUDE-OPUS-4"), "claude");
  assert.equal(modelFamily("Anthropic"), "claude");
  assert.equal(modelFamily("GPT-4o"), "openai");
  assert.equal(modelFamily("OpenAI"), "openai");
  assert.equal(modelFamily("Gemini-Pro"), "gemini");
  assert.equal(modelFamily("GOOGLE"), "gemini");
  assert.equal(modelFamily("GROK-BOT"), "grok");
});

test("modelFamily: closed-default is null", () => {
  assert.equal(modelFamily("mystery-model-9000"), null);
  assert.equal(modelFamily(null), null);
  assert.equal(modelFamily(undefined), null);
  assert.equal(modelFamily(""), null);
});

test("modelGlyphSvg: each family has its distinguishing attribute", () => {
  const claude = modelGlyphSvg("claude");
  const openai = modelGlyphSvg("openai");
  const gemini = modelGlyphSvg("gemini");
  const grok = modelGlyphSvg("grok");
  const unknown = modelGlyphSvg(null);

  assert.match(claude, /aria-hidden/);
  assert.match(openai, /aria-hidden/);
  assert.match(gemini, /aria-hidden/);
  assert.match(grok, /aria-hidden/);
  assert.match(unknown, /aria-hidden/);

  assert.match(claude, /#D97757/);
  assert.match(openai, /evenodd/);
  assert.match(gemini, /#3186FF/);
  assert.match(grok, /M4 5h16v3H8v8h8v-3h-5v-3h9v9H4V5Z/);

  assert.doesNotMatch(unknown, /#D97757/);
  assert.doesNotMatch(unknown, /evenodd/);
  assert.doesNotMatch(unknown, /#3186FF/);
  assert.doesNotMatch(unknown, /M4 5h16v3H8v8h8v-3h-5v-3h9v9H4V5Z/);
});

test("modelGlyphSvg: class names cannot break out of the class attribute", () => {
  const glyph = modelGlyphSvg(null, 'glyph" onload="alert(1)');

  assert.match(glyph, /class="glyph&quot; onload=&quot;alert\(1\)"/);
  assert.doesNotMatch(glyph, /class="glyph" onload=/);
});
