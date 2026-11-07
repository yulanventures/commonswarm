import assert from "node:assert/strict";
import { test } from "node:test";
import { choiceOptions } from "../src/cloud/choices.js";
import { CommandHttpError, ThinCommandClient } from "../src/cloud/command-client.js";
import { validateMcpArguments } from "../src/mcp/tools.js";

test("choice labels become options with ids derived from the labels", () => {
  assert.deepEqual(choiceOptions(["Ship it", "  Wait   for\ttomorrow "]), [
    { id: "ship-it", label: "Ship it" }, { id: "wait-for-tomorrow", label: "Wait for tomorrow" }]);
  assert.deepEqual(choiceOptions(["✅", "Yes!", "yes?"]).map(option => option.id), ["option-1", "yes", "yes-2"],
    "no letters falls back to option-N; a repeated slug gets a suffix");
  assert.ok(choiceOptions(["a".repeat(80), "b"]).every(option => /^[a-z0-9][a-z0-9_-]{0,31}$/.test(option.id)));
  assert.equal(choiceOptions(["Café", "No"])[0].id, "cafe");
});

test("choice labels are refused outside the server's limits", () => {
  assert.throws(() => choiceOptions(["Only"]), /2 to 6 choices; got 1/);
  assert.throws(() => choiceOptions(["a", "b", "c", "d", "e", "f", "g"]), /2 to 6 choices; got 7/);
  assert.throws(() => choiceOptions(["Ship", "x".repeat(81)]), /1 to 80 characters/);
  assert.throws(() => choiceOptions(["Ship", "   "]), /1 to 80 characters/);
  assert.throws(() => choiceOptions(["Ship", "ship"]), /must be different/);
});

test("the MCP ask tool takes 2 to 6 choice labels", () => {
  const base = { body: "Ship tonight?", request_id: "choice-req-01", to: "zoe" };
  assert.deepEqual(validateMcpArguments("ask", { ...base, choices: ["Ship it", "Wait"] }).choices, ["Ship it", "Wait"]);
  for (const choices of [["One"], "Ship it", ["a", "b", "c", "d", "e", "f", "g"], ["Ship", 7], ["Ship", " "], ["Ship", "x".repeat(81)]]) {
    assert.throws(() => validateMcpArguments("ask", { ...base, choices }), /Invalid argument: choices/, JSON.stringify(choices));
  }
});

test("sendSignal sends ask_choice with exactly the edge's fields", async () => {
  const sent: unknown[] = [];
  const fetcher = (async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ error: "interactive_replies_unavailable", message: "Interactive replies are off." }), { status: 404 });
  }) as typeof fetch;
  const client = new ThinCommandClient({ url: "http://127.0.0.1:9", anonKey: "anon", profileId: "p" }, fetcher);
  const options = choiceOptions(["Ship it", "Wait"]);
  await assert.rejects(client.sendSignal({ workspaceId: "11111111-1111-4111-8111-111111111111", credential: "token",
    command: { kind: "ask_choice", body: "Ship tonight?", to_user_id: "22222222-2222-4222-8222-222222222222", about: null,
      options: options.map(option => ({ ...option, extra: true }) as typeof option) } }), CommandHttpError);
  const command = (sent[0] as { command: Record<string, unknown> }).command;
  assert.deepEqual(command, { kind: "ask_choice", body: "Ship tonight?", to_user_id: "22222222-2222-4222-8222-222222222222",
    about: null, options });
});
