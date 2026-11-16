/**
 * The hosted react tool and the hosted check's seen marks, without a database: argument
 * validation, the one command the tool sends, its outcome and refusal copy, and which returned
 * check rows a seat marks with 👀.
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
  const ok = (body: Record<string, unknown>) => reactionOutput({ status: 200, body: { status: "accepted", ok: true, event_ids: [], signal_id: MESSAGE, emoji: "👍", ...body } });
  assert.deepEqual(ok({ added: true }), { signal_id: MESSAGE, emoji: "👍", outcome: "added" });
  assert.deepEqual(ok({ added: false }), { signal_id: MESSAGE, emoji: "👍", outcome: "already_there" });
  assert.deepEqual(ok({ removed: true }), { signal_id: MESSAGE, emoji: "👍", outcome: "removed" });
  assert.deepEqual(ok({ removed: false }), { signal_id: MESSAGE, emoji: "👍", outcome: "not_there" });
  assert.throws(() => ok({}), (error: unknown) => error instanceof HostedToolFailure && error.code === "tool_failed");
  for (const [status, code, copy] of [
    [404, "signal_not_found", /^No message this seat can read in this workspace has that signal_id\./u],
    [409, "reaction_limit_reached", /64 emojis on that message\. Remove one first\.$/u],
  ] as const) {
    let thrown: unknown;
    try { reactionOutput({ status, body: { error: code, message: "backend prose" } }); } catch (error) { thrown = error; }
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
});
