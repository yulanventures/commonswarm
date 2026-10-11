import assert from "node:assert/strict";
import { test } from "node:test";
import { modelFamily } from "./model-glyph.ts";

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
