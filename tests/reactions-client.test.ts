/**
 * The client side of reactions: how a read row's reactions parse and render, that an agent read
 * asks for them, which surfaced rows this agent marks seen with 👀, and the command bodies a
 * reaction sends.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { reportSeenReactions, seenAckTargets, AGENT_SEEN_REACTION_MAX } from "../src/cloud/agent-signal-receipts.js";
import { CommandHttpError, ThinCommandClient, type SignalRecord } from "../src/cloud/command-client.js";
import { cloudTarget } from "../src/cloud/config.js";
import { parseSignalRecord, readAgentSignalPage, renderSignals, SignalMalformedError } from "../src/cloud/signals.js";
import { mapReaction, validateMcpArguments, MCP_TOOLS } from "../src/mcp/tools.js";
import { arrivalNotification } from "../src/cloud/arrival-watch.js";
import { renderHookSignal } from "../src/listener/hook.js";
import { SIGNAL_REACTION_SEEN } from "../src/protocol/signal-reactions.js";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";
const OTHER_AGENT = "44444444-4444-4444-8444-444444444444";
const MESSAGE = "55555555-5555-4555-8555-555555555555";
const REACTION_ID = "66666666-6666-4666-8666-666666666666";
const TOKEN = `swm_agt_${"A".repeat(43)}`;
const target = cloudTarget("https://cloud.example.test", "anon-key");

function wire(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: MESSAGE, workspace_id: WORKSPACE, from: USER, from_kind: "user", to: null, to_agent: AGENT,
    in_reply_to: null, about: null, kind: "ask", body: "Can you look?", until: "2099-01-01T00:00:00.000Z",
    created_at: "2026-11-16T00:00:00.000Z", sender_owner_relation: "same_owner", ...overrides };
}
const row = (overrides: Record<string, unknown> = {}): SignalRecord => parseSignalRecord(wire(overrides));
const reactionNote = (overrides: Record<string, unknown> = {}) => row({
  id: REACTION_ID, kind: "note", in_reply_to: MESSAGE, body: `Reacted 👍 to your message ${MESSAGE}: hello`,
  recipients: [{ kind: "agent", id: AGENT, position: 0 }], reactions: [],
  reaction: { emoji: "👍", signal_id: MESSAGE }, ...overrides,
});

test("a row's reactions and a reaction note parse; absent stays absent and unknown keys are dropped", () => {
  const plain = row();
  assert.equal(Object.hasOwn(plain, "reactions"), false);
  assert.equal(Object.hasOwn(plain, "reaction"), false);
  const counted = row({ reactions: [
    { emoji: "👀", count: 2, actors: [{ kind: "agent", id: AGENT, extra: 1 }, { kind: "user", id: USER }], first_at: "later" },
    { emoji: "👍", count: 1, actors: [{ kind: "user", id: USER }] },
  ] });
  assert.deepEqual(counted.reactions, [
    { emoji: "👀", count: 2, actors: [{ kind: "agent", id: AGENT }, { kind: "user", id: USER }] },
    { emoji: "👍", count: 1, actors: [{ kind: "user", id: USER }] },
  ]);
  assert.deepEqual(row({ reactions: [] }).reactions, [], "an empty list is a real answer, not absence");
  const note = reactionNote({ reaction: { emoji: "👍", signal_id: MESSAGE, later: true } });
  assert.deepEqual(note.reaction, { emoji: "👍", signal_id: MESSAGE });
});

test("malformed reactions are refused", () => {
  for (const reactions of [
    {}, "👍", [null], [{ emoji: "", count: 1, actors: [] }], [{ emoji: "👍", count: 0, actors: [] }],
    [{ emoji: "👍", count: 1.5, actors: [] }], [{ emoji: "👍", count: 1, actors: "x" }],
    [{ emoji: "👍", count: 1, actors: [{ kind: "robot", id: USER }] }],
    [{ emoji: "👍", count: 1, actors: [{ kind: "user", id: "not-a-uuid" }] }],
  ]) {
    assert.throws(() => row({ reactions }), SignalMalformedError, JSON.stringify(reactions));
  }
  for (const reaction of [null, "👍", { emoji: "👍" }, { emoji: 1, signal_id: MESSAGE }, { emoji: "👍", signal_id: "x" }]) {
    assert.throws(() => row({ reaction }), SignalMalformedError, JSON.stringify(reaction));
  }
});

test("renderSignals shows a reactions summary and a reaction note without a reply hint", () => {
  const options = { inbox: true, includeStale: false, now: Date.parse("2026-11-16T00:01:00.000Z") };
  const counted = renderSignals([row({ reactions: [
    { emoji: "👀", count: 2, actors: [{ kind: "agent", id: AGENT }, { kind: "user", id: USER }] },
    { emoji: "👍", count: 1, actors: [{ kind: "user", id: USER }] },
  ] })], options);
  assert.match(counted, /"Can you look\?" \[👀 2  👍 1\] — reply with: cswarm reply/);
  assert.doesNotMatch(renderSignals([row({ reactions: [] })], options), /\[👀|\[\]/, "no reactions, no summary");
  assert.doesNotMatch(renderSignals([row()], options), / \[[^\]]*\d\]/);
  const note = renderSignals([reactionNote()], options);
  assert.match(note, /- \[reaction\] member/);
  assert.match(note, /Reacted 👍 to your message/);
  assert.doesNotMatch(note, /reply with|in reply to/, "a reaction's id is not a message");
  const ask = renderSignals([reactionNote({ kind: "ask" })], options);
  assert.doesNotMatch(ask, /reply with/);
});

test("an agent read asks for reactions, and one 400 retries once without both optional keys", async () => {
  for (const status of [200, 400]) {
    const bodies: Array<Record<string, unknown>> = [];
    const fetcher = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (status === 400 && bodies.length === 1) return new Response(JSON.stringify({ error: "invalid_request" }), { status: 400 });
      return new Response(JSON.stringify({ signals: [wire({ reactions: [] })], capabilities: { cursor_after: 1 } }),
        { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const page = await readAgentSignalPage(target, { kind: "agent", token: TOKEN },
      { workspaceId: WORKSPACE, inbox: true, limit: 10 }, { fetcher });
    assert.deepEqual(page.signals[0]!.reactions, []);
    assert.deepEqual(bodies.map((body) => [body.include_mentions, body.include_reactions]),
      status === 400 ? [[true, true], [undefined, undefined]] : [[true, true]], `HTTP ${status}`);
  }
});

test("seenAckTargets marks only asks and notes that reach this agent, from someone else, that are messages", () => {
  const ids = (rows: SignalRecord[]) => seenAckTargets(rows, AGENT);
  assert.deepEqual(ids([row()]), [MESSAGE], "an addressed ask");
  assert.deepEqual(ids([row({ to_agent: null, audience: "workspace", kind: "note",
    mentions: [{ position: 0, kind: "agent", id: AGENT, source: "author" }] })]), [MESSAGE], "a mentioned note");
  assert.deepEqual(ids([row({ to_agent: null, recipients: [{ kind: "agent", id: OTHER_AGENT, position: 0 },
    { kind: "agent", id: AGENT, position: 1 }] })]), [MESSAGE], "addressed at position 1");
  assert.deepEqual(ids([row({ from: AGENT, from_kind: "agent" })]), [], "its own message");
  assert.deepEqual(ids([row({ from: AGENT, from_kind: "user" })]), [MESSAGE], "a person who shares the id space is not this agent");
  assert.deepEqual(ids([reactionNote()]), [], "a reaction note");
  assert.deepEqual(ids([row({ to_agent: null, kind: "note" })]), [], "a broadcast that neither addresses nor mentions it");
  assert.deepEqual(ids([row({ to_agent: null, kind: "note", mentions: [{ position: 0, kind: "agent", id: OTHER_AGENT, source: "author" }] })]), [],
    "a note mentioning another agent");
  assert.deepEqual(ids([row({ kind: "working-on" })]), [], "a working-on update");
  assert.deepEqual(ids([row(), row()]), [MESSAGE], "each message once");
  const many = Array.from({ length: AGENT_SEEN_REACTION_MAX + 5 }, (_, index) =>
    row({ id: `77777777-7777-4777-8777-${String(index).padStart(12, "0")}` }));
  assert.equal(ids(many).length, AGENT_SEEN_REACTION_MAX, "bounded per batch");
});

test("reportSeenReactions sends one ack reaction per message and never throws", async () => {
  const sent: Array<Record<string, unknown>> = [];
  const replies = [
    () => new Response(JSON.stringify({ status: "accepted", ok: true, event_ids: [], signal_id: MESSAGE, emoji: SIGNAL_REACTION_SEEN, added: true }), { status: 200 }),
    () => new Response(JSON.stringify({ error: "signal_not_found" }), { status: 404 }),
    () => { throw new Error("offline"); },
  ];
  const fetcher = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    sent.push(body);
    return replies[sent.length - 1]!();
  }) as typeof fetch;
  const ids = [MESSAGE, REACTION_ID, OTHER_AGENT];
  const result = await reportSeenReactions(target, TOKEN, WORKSPACE, [...ids, MESSAGE], fetcher);
  assert.deepEqual(sent.map((body) => body.command), ids.map((id) =>
    ({ kind: "add_reaction", signal_id: id, emoji: SIGNAL_REACTION_SEEN, source: "ack" })));
  assert.equal(new Set(sent.map((body) => body.command_id)).size, 3, "a fresh command id per reaction");
  assert.ok(sent.every((body) => body.workspace_id === WORKSPACE));
  assert.deepEqual(result, { attempted: 3, reported: 1, failures: ["http", "transport"] });
  assert.deepEqual(await reportSeenReactions(target, TOKEN, WORKSPACE, [], fetcher), { attempted: 0, reported: 0, failures: [] });
});

test("sendReaction sends no source on a manual reaction and names a refusal's reason", async () => {
  const sent: Array<Record<string, unknown>> = [];
  let reply = (): Response => new Response(JSON.stringify({ status: "accepted", ok: true, event_ids: [], signal_id: MESSAGE,
    emoji: "👍", added: false }), { status: 200 });
  const fetcher = (async (_url: unknown, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return reply();
  }) as typeof fetch;
  const client = new ThinCommandClient(target, fetcher);
  const added = await client.sendReaction({ workspaceId: WORKSPACE, credential: TOKEN, commandId: "cmd_one",
    command: { kind: "add_reaction", signal_id: MESSAGE, emoji: "👍" } });
  assert.equal(added.response.added, false);
  assert.deepEqual(sent[0]!.command, { kind: "add_reaction", signal_id: MESSAGE, emoji: "👍" });
  assert.equal(sent[0]!.command_id, "cmd_one");
  reply = () => new Response(JSON.stringify({ error: "signal_not_found", message: "There is no message with that id that you can read in this workspace." }), { status: 404 });
  await assert.rejects(client.sendReaction({ workspaceId: WORKSPACE, credential: TOKEN, commandId: "cmd_two",
    command: { kind: "remove_reaction", signal_id: MESSAGE, emoji: "👍" } }),
  (error: unknown) => error instanceof CommandHttpError && error.status === 404 && error.code === "signal_not_found");
  reply = () => new Response(JSON.stringify({ status: "accepted", ok: true, event_ids: [], signal_id: MESSAGE, emoji: "👍" }), { status: 200 });
  await assert.rejects(client.sendReaction({ workspaceId: WORKSPACE, credential: TOKEN, commandId: "cmd_three",
    command: { kind: "remove_reaction", signal_id: MESSAGE, emoji: "👍" } }), /malformed reaction outcome/);
});

test("the local react tool takes one emoji, an optional boolean remove and a request id", () => {
  const tool = MCP_TOOLS.find((row) => row.name === "react")!;
  assert.deepEqual(tool.inputSchema.required, ["signal_id", "emoji", "request_id"]);
  const base = { signal_id: MESSAGE, emoji: "👍", request_id: "react0001" };
  assert.deepEqual(validateMcpArguments("react", base), base);
  assert.deepEqual(validateMcpArguments("react", { ...base, remove: true }), { ...base, remove: true });
  assert.throws(() => validateMcpArguments("react", { ...base, remove: "true" }), /Invalid argument: remove/);
  assert.throws(() => validateMcpArguments("react", { ...base, emoji: "" }), /Invalid argument: emoji/);
  assert.throws(() => validateMcpArguments("react", { ...base, emoji: "ok" }), /Invalid argument: emoji/);
  assert.deepEqual(validateMcpArguments("react", { ...base, emoji: ":+1:" }), { ...base, emoji: ":+1:" }, "a shortcode passes; the server stores its emoji");
  assert.throws(() => validateMcpArguments("react", { ...base, emoji: "x".repeat(33) }), /Invalid argument: emoji/);
  assert.throws(() => validateMcpArguments("react", { signal_id: MESSAGE, request_id: "react0001" }), /Missing argument: emoji/);
  assert.deepEqual(mapReaction({ signal_id: MESSAGE, emoji: "👍", added: true }), { signal_id: MESSAGE, emoji: "👍", outcome: "added" });
  assert.equal((mapReaction({ signal_id: MESSAGE, emoji: "👍", added: false }) as { outcome: string }).outcome, "already_there");
  assert.equal((mapReaction({ signal_id: MESSAGE, emoji: "👍", removed: true }) as { outcome: string }).outcome, "removed");
  assert.equal((mapReaction({ signal_id: MESSAGE, emoji: "👍", removed: false }) as { outcome: string }).outcome, "not_there");
});

test("a reaction note is answered in the reacted message's thread, never at the reaction's id", () => {
  const note = parseSignalRecord(reactionNote());
  const target = cloudTarget("https://cloud.example.test", "anon");
  assert.equal(arrivalNotification(note, WORKSPACE, target).reply_command,
    `cswarm reply ${MESSAGE} "<answer>" --thread --workspace-id ${WORKSPACE}`);
  const rendered = renderHookSignal({ workspaceId: WORKSPACE, signalId: REACTION_ID, fromId: USER, fromKind: "user", kind: "note",
    senderName: "Quill", body: note.body, createdAt: note.created_at, queuedAt: note.created_at, reactedTo: MESSAGE } as never);
  assert.match(rendered, /reacted to your message:/);
  assert.match(rendered, new RegExp(`cswarm reply ${MESSAGE} "<answer>" --thread`));
  assert.doesNotMatch(rendered, new RegExp(`cswarm reply ${REACTION_ID}`));
});
