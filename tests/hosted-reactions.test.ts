/**
 * The hosted react tool and the hosted check's seen marks, without a database: argument
 * validation, the one command the tool sends, its outcome and refusal copy, and which returned
 * check rows a seat marks with 👀, and the seen command the hosted MCP sends after a channel_read page.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error TS5097: exercise the Deno source through tsx.
import { HOSTED_TOOL_TABLE, HostedToolInputError, validateHostedToolArguments } from "../supabase/functions/mcp/tools.ts";
// @ts-expect-error TS5097: exercise the Deno source through tsx.
import { reactionCommand, reactionOutput } from "../supabase/functions/mcp/reaction-tools.ts";
// @ts-expect-error TS5097: exercise the Deno source through tsx.
import { hostedToolError, HostedToolFailure } from "../supabase/functions/mcp/tool-errors.ts";
// @ts-expect-error TS5097: exercise the Deno source through tsx.
import { HOSTED_SEEN_MARK_MAX, hostedSeenAckTargets } from "../supabase/functions/command/signal-reactions.ts";
// @ts-expect-error TS5097: exercise the Deno source through tsx.
import { channelReadSeenCommand, HOSTED_CHANNEL_READ_SEEN_KIND, HOSTED_CHANNEL_READ_SEEN_MAX, markChannelReadSeen } from "../supabase/functions/mcp/channel-seen.ts";
import { readFile } from "node:fs/promises";

const seat = "seat_ABCDEFGHIJKLMNOPQRSTUV";
const MESSAGE = "55555555-5555-4555-8555-555555555555";
const AGENT = "22222222-2222-4222-8222-222222222222";
const OTHER_AGENT = "44444444-4444-4444-8444-444444444444";
const USER = "33333333-3333-4333-8333-333333333333";
const base = { seat, signal_id: MESSAGE, emoji: "👍", request_id: "react_0001" };

test("the hosted react tool is listed after reraise and takes one emoji, an optional boolean remove and a request id", () => {
  const names = HOSTED_TOOL_TABLE.map((tool: { name: string }) => tool.name);
  assert.equal(names.indexOf("react"), names.indexOf("reraise") + 1);
  const tool = HOSTED_TOOL_TABLE.find((row: { name: string }) => row.name === "react") as unknown as {
    inputSchema: { required: string[]; properties: Record<string, unknown> }; annotations: { readOnlyHint: boolean };
  };
  assert.deepEqual(tool.inputSchema.required, ["seat", "signal_id", "emoji", "request_id"]);
  assert.deepEqual(Object.keys(tool.inputSchema.properties), ["seat", "signal_id", "emoji", "remove", "request_id"]);
  assert.equal(tool.annotations.readOnlyHint, false);

  assert.deepEqual(validateHostedToolArguments("react", base), base);
  assert.deepEqual(validateHostedToolArguments("react", { ...base, remove: true }), { ...base, remove: true });
  assert.deepEqual(validateHostedToolArguments("react", { ...base, emoji: ":+1:" }), { ...base, emoji: ":+1:" });
  const refused: Array<[Record<string, unknown>, RegExp]> = [
    [{ ...base, emoji: "ok" }, /^Invalid emoji: provide one emoji/u],
    [{ ...base, emoji: "👍👍" }, /^Invalid emoji/u],
    [{ ...base, emoji: "" }, /^Invalid emoji/u],
    [{ ...base, remove: "true" }, /^Invalid remove/u],
    [{ ...base, signal_id: "nope" }, /^Invalid signal_id: provide the signal UUID from check or channel_read that you want to react to\.$/u],
    [{ ...base, request_id: "!" }, /^Invalid request_id/u],
    [{ ...base, source: "ack" }, /^Unknown tool argument\. Use only: seat, signal_id, emoji, remove, request_id\.$/u],
    [{ seat, emoji: "👍", request_id: "react_0001" }, /^Missing signal_id: provide the signal UUID from check or channel_read/u],
    [{ seat, signal_id: MESSAGE, request_id: "react_0001" }, /^Missing emoji/u],
  ];
  for (const [args, message] of refused) {
    assert.throws(() => validateHostedToolArguments("react", args),
      (error: unknown) => error instanceof HostedToolInputError && message.test(error.message), JSON.stringify(args));
  }
});

test("the hosted react tool sends exactly add_reaction or remove_reaction, never a source", () => {
  assert.deepEqual(reactionCommand({ ...base, signal_id: MESSAGE.toUpperCase(), emoji: ":eyes:" }),
    { kind: "add_reaction", signal_id: MESSAGE, emoji: "\u{1F440}" });
  assert.deepEqual(reactionCommand({ ...base, remove: true }), { kind: "remove_reaction", signal_id: MESSAGE, emoji: "👍" });
  assert.deepEqual(reactionCommand({ ...base, remove: false }), { kind: "add_reaction", signal_id: MESSAGE, emoji: "👍" });
});

test("the hosted react tool reports the same outcomes as the local tool, and its refusals have their own copy", () => {
  const add = { kind: "add_reaction", signal_id: MESSAGE, emoji: "👍" } as const;
  const remove = { ...add, kind: "remove_reaction" } as const;
  const ok = (body: Record<string, unknown>, sent: typeof add | typeof remove = add) =>
    reactionOutput({ status: 200, body: { status: "accepted", ok: true, event_ids: [], ...body } }, sent);
  assert.deepEqual(ok({ signal_id: MESSAGE, emoji: "👍", added: true }), { signal_id: MESSAGE, emoji: "👍", outcome: "added" });
  assert.deepEqual(ok({ added: false }), { signal_id: MESSAGE, emoji: "👍", outcome: "already_there" },
    "an answer without signal_id or emoji (a replay) still reports what was sent");
  assert.deepEqual(ok({ removed: true }, remove), { signal_id: MESSAGE, emoji: "👍", outcome: "removed" });
  assert.deepEqual(ok({ removed: false }, remove), { signal_id: MESSAGE, emoji: "👍", outcome: "not_there" });
  for (const [body, sent] of [[{}, add], [{ removed: true }, add], [{ added: true }, remove]] as const) {
    assert.throws(() => ok(body, sent), (error: unknown) => error instanceof HostedToolFailure && error.code === "tool_failed",
      JSON.stringify([body, sent.kind]));
  }
  for (const [status, code, copy] of [
    [404, "signal_not_found", /^No message this seat can read in this workspace has that signal_id\./u],
    [409, "reaction_limit_reached", /64 emojis on that message\. Remove one first\.$/u],
  ] as const) {
    let thrown: unknown;
    try { reactionOutput({ status, body: { error: code, message: "backend prose" } }, add); } catch (error) { thrown = error; }
    assert.ok(thrown instanceof HostedToolFailure);
    const failure = hostedToolError(thrown, "react");
    assert.equal(failure.error, code);
    assert.match(failure.message, copy);
    assert.doesNotMatch(failure.message, /backend prose/u);
  }
});

test("a hosted check marks the asks and notes it returns that its agent did not write, once each, at most twenty", () => {
  const row = (overrides: Record<string, unknown> = {}) =>
    ({ id: MESSAGE, kind: "ask", from: USER, from_kind: "user", to_agent: AGENT, ...overrides });
  const ids = (rows: Record<string, unknown>[]) => hostedSeenAckTargets(rows, AGENT);
  assert.deepEqual(ids([row()]), [MESSAGE], "an addressed ask");
  assert.deepEqual(ids([row({ id: MESSAGE.toUpperCase(), kind: "note" })]), [MESSAGE], "a note, id lowercased");
  assert.deepEqual(ids([row({ from: OTHER_AGENT, from_kind: "agent" })]), [MESSAGE], "another agent's message");
  assert.deepEqual(ids([row({ from: AGENT, from_kind: "agent" })]), [], "its own message");
  assert.deepEqual(ids([row({ from: AGENT.toUpperCase(), from_kind: "agent" })]), [], "its own message, any case");
  assert.deepEqual(ids([row({ from: AGENT, from_kind: "user" })]), [MESSAGE], "a person who shares the id space");
  assert.deepEqual(ids([row({ kind: "working-on" })]), [], "a working-on update");
  assert.deepEqual(ids([row({ id: "not-a-uuid" })]), [], "a malformed id");
  assert.deepEqual(ids([row(), row()]), [MESSAGE], "each message once");
  const many = Array.from({ length: HOSTED_SEEN_MARK_MAX + 5 }, (_, index) =>
    row({ id: `77777777-7777-4777-8777-${String(index).padStart(12, "0")}` }));
  assert.equal(HOSTED_SEEN_MARK_MAX, 20);
  assert.deepEqual(ids(many), many.slice(0, 20).map((value) => value.id), "the first twenty, in order");
  // Seen (the delivery observed) is not a courtesy mark: every row a turn returns, not twenty.
  assert.deepEqual(hostedSeenAckTargets(many, AGENT, many.length), many.map((value) => value.id));
});

test("after a channel_read page the hosted MCP sends one seen command with that page's ids, under a check capability", async () => {
  const id = (n: number) => `77777777-7777-4777-8777-${String(n).padStart(12, "0")}`;
  const page = [{ signal_id: id(1).toUpperCase() }, { signal_id: id(2) }, { signal_id: id(1) }, { signal_id: "nope" }, {}];
  const input = channelReadSeenCommand(page, USER, seat);
  assert.ok(input);
  assert.match(String(input.command_id), /^mcpseen_[0-9a-f-]{36}$/u);
  assert.deepEqual({ ...input, command_id: null }, {
    command_id: null, client_version: "0.1.80", workspace_id: USER, stream: { kind: "workspace" },
    command: { kind: HOSTED_CHANNEL_READ_SEEN_KIND, seat, signal_ids: [id(1), id(2)] },
  }, "each returned id once, lowercased, in page order");
  assert.equal(channelReadSeenCommand([], USER, seat), null, "an empty page sends nothing");
  const many = Array.from({ length: HOSTED_CHANNEL_READ_SEEN_MAX + 3 }, (_, n) => ({ signal_id: id(n) }));
  assert.equal((channelReadSeenCommand(many, USER, seat)!.command as { signal_ids: string[] }).signal_ids.length, 50);

  const calls: string[] = [];
  const cap = { kind: "hosted_seat" };
  const send = (status: number) => async (sent: Record<string, unknown>, granted: unknown) => {
    calls.push(`send:${(sent.command as { kind: string }).kind}:${granted === cap}`);
    return { status, body: {} };
  };
  const capability = async () => { calls.push("capability"); return cap; };
  assert.equal(await markChannelReadSeen([], USER, seat, capability, send(200)), false);
  assert.deepEqual(calls, [], "an empty page asks for no capability");
  assert.equal(await markChannelReadSeen(page, USER, seat, capability, send(200)), true);
  assert.deepEqual(calls.splice(0), ["capability", `send:${HOSTED_CHANNEL_READ_SEEN_KIND}:true`]);
  assert.equal(await markChannelReadSeen(page, USER, seat, async () => null, send(200)), false, "no capability, nothing sent");
  assert.deepEqual(calls, []);
  // A refusal or a failure leaves the page as it is: never a throw.
  assert.equal(await markChannelReadSeen(page, USER, seat, capability, send(403)), false);
  assert.equal(await markChannelReadSeen(page, USER, seat, capability, async () => { throw new Error("down"); }), false);
  assert.equal(await markChannelReadSeen(page, USER, seat, async () => { throw new Error("down"); }, send(200)), false);
});

test("the command edge takes the hosted MCP's channel_read seen kind, and the MCP sends it after the page it returns", async () => {
  const command = await readFile(new URL("../supabase/functions/command/index.ts", import.meta.url), "utf8");
  assert.ok(command.includes(`const HOSTED_CHANNEL_READ_SEEN_KIND = "${HOSTED_CHANNEL_READ_SEEN_KIND}";`));
  const mcp = await readFile(new URL("../supabase/functions/mcp/index.ts", import.meta.url), "utf8");
  assert.match(mcp, /markChannelReadSeen\(messages, binding\.workspaceId, handle,\s*\(\) => seatCapability\(call\.token, binding, "check"\)/u);
});
