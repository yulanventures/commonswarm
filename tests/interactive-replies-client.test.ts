import assert from "node:assert/strict";
import { test } from "node:test";
import { Arguments, askChoiceFlags } from "../src/cli.js";
import { choiceAnswerBody, choiceOptions } from "../src/cloud/choices.js";
import { CommandHttpError, ThinCommandClient } from "../src/cloud/command-client.js";
import { askChoiceArguments, validateMcpArguments } from "../src/mcp/tools.js";
// @ts-expect-error TS5097: this service-free test imports the Deno source directly.
import { hostedChoiceOptions, validateHostedToolArguments } from "../supabase/functions/mcp/tools.ts";
// @ts-expect-error TS5097: this service-free test imports the Deno source directly.
import { choiceOptionText } from "../supabase/functions/command/choice-text.ts";
import { choiceOneLine } from "../src/protocol/choice-asks.js";

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

test("v2 options: descriptions, one recommended moved first with its id kept, and the reply text", () => {
  const options = choiceOptions([{ label: "Ship it", description: "  Tonight,\tafter CI " }, "Wait", { label: "Cancel", recommended: true }]);
  assert.deepEqual(options, [
    { id: "cancel", label: "Cancel", recommended: true },
    { id: "ship-it", label: "Ship it", description: "Tonight, after CI" },
    { id: "wait", label: "Wait" }]);
  assert.deepEqual(choiceOptions([{ id: "a", label: "Yes" }, { label: "a" }]).map(option => option.id), ["a", "a-2"],
    "a derived id never takes an explicit one");
  assert.throws(() => choiceOptions([{ label: "A", recommended: true }, { label: "B", recommended: true }]), /At most one/);
  assert.throws(() => choiceOptions([{ label: "A", description: "x".repeat(201) }, "B"]), /description must be 1 to 200/);
  assert.throws(() => choiceOptions([{ label: "A", id: "Bad Id" }, "B"]), /choice id/);
  assert.throws(() => choiceOptions(["A", `B${String.fromCodePoint(0x202e)}`]), /plain text/, "a bidi override");
  assert.equal(choiceOptions([`${String.fromCodePoint(0x1f937, 0x200d, 0x2640, 0xfe0f)} Unsure`, "B"])[0]!.id, "unsure",
    "an emoji joined with a zero-width joiner is plain text");
  assert.throws(() => choiceOptions(Array.from({ length: 6 }, (_, i) => ({ label: `${"€".repeat(79)}${i}`,
    description: "€".repeat(200) }))), /too long together/, "multibyte text past the stored bound");

  assert.equal(choiceAnswerBody(["Ship it"], null), "Selected: Ship it");
  assert.equal(choiceAnswerBody(["Ship it", "Wait"], "Ping me first"), ["Selected: Ship it, Wait", "Other: Ping me first"].join("\n"));
  assert.equal(choiceAnswerBody([], "Neither"), "Other: Neither");
});

test("cswarm ask: --option with descriptions, --choice in typed order, --recommended by number or id, --multi", () => {
  const flags = (...argv: string[]) => askChoiceFlags(new Arguments(["ask", "Ship?", ...argv]));
  assert.equal(flags("--to", "zoe"), null, "no choices: a plain ask");
  assert.deepEqual(flags("--option", "Ship it::Tonight after CI", "--choice", "Wait", "--option", "Cancel", "--recommended", "2"), {
    options: [{ id: "wait", label: "Wait", recommended: true }, { id: "ship-it", label: "Ship it", description: "Tonight after CI" },
      { id: "cancel", label: "Cancel" }], multi: false });
  assert.deepEqual(flags("--option", "A", "--option", "B", "--recommended", "b", "--multi", "--channel", "ops")?.options[0],
    { id: "b", label: "B", recommended: true });
  assert.equal(flags("--option", "A", "--option", "B", "--multi")?.multi, true);
  assert.throws(() => flags("--option", "A", "--option", "B", "--recommended", "3"), /--recommended names a choice/);
  assert.throws(() => flags("--option", "A", "--option", "B", "--recommended", "1", "--recommended", "2"), /only be provided once/);
  assert.throws(() => flags("--multi"), /--multi needs choices/);
  assert.throws(() => flags("--recommended", "1"), /--recommended needs choices/);
  assert.throws(() => flags("--option", "A", "--option", "B", "--parent", "x"), /can't be combined with --parent/);
  assert.throws(() => flags("--option", "Only"), /2 to 6 choices; got 1/);
});

test("the local MCP ask tool takes options or choices, and multi", () => {
  const base = { body: "Ship tonight?", request_id: "choice-req-01" };
  const options = [{ label: "Ship it", description: "Tonight" }, { label: "Wait", recommended: true }];
  const args = validateMcpArguments("ask", { ...base, options, multi: true, channel: "ops" }) as Record<string, unknown>;
  assert.deepEqual(askChoiceArguments(args), { multi: true,
    options: [{ id: "wait", label: "Wait", recommended: true }, { id: "ship-it", label: "Ship it", description: "Tonight" }] });
  assert.deepEqual(askChoiceArguments({ ...base, choices: ["A", "B"] }), { multi: false,
    options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] });
  assert.equal(askChoiceArguments(base), null);
  for (const bad of [[{ label: "A" }], [{ label: "A", url: "x" }, { label: "B" }],
    [{ label: "A", recommended: true }, { label: "B", recommended: true }], ["A", "B"]]) {
    assert.throws(() => validateMcpArguments("ask", { ...base, options: bad }), /Invalid argument: options/, JSON.stringify(bad));
  }
  assert.throws(() => validateMcpArguments("ask", { ...base, multi: "yes" }), /Invalid argument: multi/);
  assert.throws(() => askChoiceArguments({ ...base, multi: true }), /multi needs options or choices/);
  assert.throws(() => askChoiceArguments({ ...base, choices: ["A", "B"], options: [{ label: "A" }, { label: "B" }] }), /not both/);
  assert.throws(() => askChoiceArguments({ ...base, choices: ["A", "B"], until: "1h" }), /can't be combined with until/);
});

test("the hosted ask tool takes options or choices, to one person or to nobody", () => {
  const base = { seat: `seat_${"a".repeat(22)}`, body: "Ship tonight?", request_id: "choice-req-01" };
  const person = [{ kind: "user", id: "22222222-2222-4222-8222-222222222222" }];
  const options = [{ label: "Ship it" }, { label: "Wait", description: "Until Monday", recommended: true }];
  assert.deepEqual(validateHostedToolArguments("ask", { ...base, options, multi: true, channel: "ops" }).options, options,
    "no recipients: anyone who reads it may answer");
  assert.ok(validateHostedToolArguments("ask", { ...base, choices: ["A", "B"], recipients: person }));
  assert.deepEqual(hostedChoiceOptions({ ...base, options }), [
    { id: "wait", label: "Wait", description: "Until Monday", recommended: true }, { id: "ship-it", label: "Ship it" }]);
  const refusals: Array<[Record<string, unknown>, RegExp]> = [
    [{ ...base }, /Invalid ask_audience: provide recipients for a private ask/],
    [{ ...base, options, mentions: ["Wren"] }, /Invalid mentions: an ask with options or choices mentions nobody/],
    [{ ...base, options, recipients: [{ kind: "agent", id: person[0]!.id }] }, /Invalid recipients: provide one object with kind user/],
    [{ ...base, options, recipients: [...person, { kind: "user", id: "33333333-3333-4333-8333-333333333333" }] }, /Invalid recipients/],
    [{ ...base, options, attachments: [{ file_id: person[0]!.id, version_n: 1 }] }, /Invalid attachments/],
    [{ ...base, options, choices: ["A", "B"] }, /not both/],
    [{ ...base, options: [{ label: "A" }] }, /Invalid options/],
    [{ ...base, choices: ["A", 7] }, /Invalid choices/],
    [{ ...base, multi: true }, /Invalid multi/],
    [{ ...base, options, multi: "yes" }, /Invalid multi/],
  ];
  for (const [args, pattern] of refusals) {
    assert.throws(() => validateHostedToolArguments("ask", args), pattern, JSON.stringify(args).slice(0, 120));
  }
});

test("sendSignal sends a v2 ask_choice with only the keys used", async () => {
  const sent: unknown[] = [];
  const fetcher = (async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ error: "interactive_replies_unavailable", message: "Off." }), { status: 404 });
  }) as typeof fetch;
  const client = new ThinCommandClient({ url: "http://127.0.0.1:9", anonKey: "anon", profileId: "p" }, fetcher);
  const options = choiceOptions([{ label: "Ship it", description: "Tonight" }, { label: "Wait", recommended: true }]);
  await assert.rejects(client.sendSignal({ workspaceId: "11111111-1111-4111-8111-111111111111", credential: "token",
    command: { kind: "ask_choice", body: "Ship tonight?", to_user_id: null, about: null, options, multi: true, channel: "ops" } }),
  CommandHttpError);
  assert.deepEqual((sent[0] as { command: Record<string, unknown> }).command, { kind: "ask_choice", body: "Ship tonight?",
    to_user_id: null, about: null, options, multi: true, channel: "ops" });
});

test("a zero-width joiner survives only inside an emoji sequence, the same at the client and the edge", () => {
  const zwj = String.fromCodePoint(0x200d);
  const technologist = String.fromCodePoint(0x1f469, 0x200d, 0x1f4bb);
  const family = String.fromCodePoint(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);
  const toned = String.fromCodePoint(0x1f469, 0x1f3fd, 0x200d, 0x1f4bb);
  const heart = String.fromCodePoint(0x2764, 0xfe0f, 0x200d, 0x1f525);
  const cases: Array<[string, string, string]> = [
    ["a joined emoji", `${technologist} Pair on it`, `${technologist} Pair on it`],
    ["a family of three", `Ask ${family}`, `Ask ${family}`],
    ["a skin tone before the joiner", toned, toned],
    ["VS16 before the joiner", heart, heart],
    ["a lone joiner", `Ship ${zwj} it`, "Ship it"],
    ["a leading and a trailing joiner", `${zwj}Ship${zwj}`, "Ship"],
    ["a joiner between letters", `Sh${zwj}ip`, "Ship"],
    ["a joiner after an emoji, before a letter", `${String.fromCodePoint(0x1f469)}${zwj}a`, `${String.fromCodePoint(0x1f469)}a`],
    ["other invisible characters", `Sh${String.fromCodePoint(0x200b)}ip${String.fromCodePoint(0xfeff)}`, "Ship"],
  ];
  for (const [name, input, stored] of cases) {
    assert.equal(choiceOneLine(input), stored, `client: ${name}`);
    assert.equal(choiceOptionText(input), stored, `edge: ${name}`);
  }
  const options = choiceOptions([{ label: `${technologist} Pair`, description: `With ${family}` }, "Solo"]);
  assert.deepEqual(options[0], { id: "pair", label: `${technologist} Pair`, description: `With ${family}` });
  assert.equal(choiceAnswerBody([options[0]!.label], null), `Selected: ${technologist} Pair`);
});
