/**
 * Where a reply goes (src/protocol/reply-placement.ts), and how the local and hosted MCP reply,
 * note and ask tools map their arguments: mentions, private, and the post_signal they send.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decideReplyPlacement,
  REPLY_BROADCAST_ADDRESSED,
  REPLY_BROADCAST_NEEDS_THREAD,
  REPLY_PRIVATE_CONFLICT,
  REPLY_THREAD_ADVISORY,
  ReplyPlacementError,
  replyTargetIsPublic,
  type ReplyTarget,
} from "../src/protocol/reply-placement.js";
import {
  addReplyAuthorMention, MENTION_REFUSAL_SENTENCES, MentionResolutionError, replyAuthorMentionRefused, replyRetryCommandId,
  withoutReplyAuthor, type MentionRosterEntry,
} from "../src/protocol/mention-address.js";
import { MCP_TOOLS, validateMcpArguments } from "../src/mcp/tools.js";
import { mapMcpError } from "../src/mcp/errors.js";
import { readReplyTarget } from "../src/cloud/signals.js";
import { cloudTarget } from "../src/cloud/config.js";
// @ts-expect-error TS5097: exercise the Deno source through tsx.
import { HOSTED_TOOL_TABLE, HostedToolInputError, validateHostedToolArguments } from "../supabase/functions/mcp/tools.ts";
import {
  hostedImplicitAuthor, hostedMentions, hostedNeedsReplyTarget, hostedNeedsRoster, hostedReplyPlacement, hostedRoster, hostedSignalCommand,
// @ts-expect-error TS5097: exercise the Deno source through tsx.
} from "../supabase/functions/mcp/signal-tools.ts";

const ROOT = "11111111-1111-4111-8111-111111111111";
const CHILD = "22222222-2222-4222-8222-222222222222";
const DM = "33333333-3333-4333-8333-333333333333";
const USER = "44444444-4444-4444-8444-444444444444";
const AGENT = "55555555-5555-4555-8555-555555555555";
const WORKSPACE = "66666666-6666-4666-8666-666666666666";
const seat = "seat_ABCDEFGHIJKLMNOPQRSTUV";

const channelPost: ReplyTarget = { id: ROOT, to: null, to_agent: null, in_reply_to: null, thread_root_id: null, recipients: [] };
const threadChild: ReplyTarget = { ...channelPost, id: CHILD, thread_root_id: ROOT };
const direct: ReplyTarget = { id: DM, to: USER, to_agent: null, in_reply_to: null, thread_root_id: null, recipients: [{ kind: "user", id: USER }] };
const privateReply: ReplyTarget = { id: DM, to: USER, to_agent: null, in_reply_to: ROOT };
const flags = { private: false, status: false, thread: false, broadcastToChannel: false };

test("a channel post gets a thread reply; a message inside a thread replies on its root", () => {
  assert.deepEqual(decideReplyPlacement({ ...flags, target: channelPost, signalId: ROOT }), { placement: "thread", threadRootId: ROOT, author: null });
  assert.deepEqual(decideReplyPlacement({ ...flags, target: threadChild, signalId: CHILD }), { placement: "thread", threadRootId: ROOT, author: null });
  // --thread on a channel message is a no-op confirmation; --broadcast-to-channel is allowed there.
  assert.deepEqual(decideReplyPlacement({ ...flags, thread: true, broadcastToChannel: true, target: channelPost, signalId: ROOT }),
    { placement: "thread", threadRootId: ROOT, author: null });
  // The read edge's audience field wins over the columns.
  assert.equal(replyTargetIsPublic({ id: ROOT, audience: "private" }), false);
  assert.equal(replyTargetIsPublic({ id: ROOT, audience: "workspace", to: USER }), true);
});

test("an addressed message or a private reply is answered privately; --thread on one says so", () => {
  assert.deepEqual(decideReplyPlacement({ ...flags, target: direct, signalId: DM.toUpperCase() }),
    { placement: "private", inReplyTo: DM, advisory: null });
  assert.deepEqual(decideReplyPlacement({ ...flags, target: privateReply, signalId: DM }),
    { placement: "private", inReplyTo: DM, advisory: null });
  assert.deepEqual(decideReplyPlacement({ ...flags, thread: true, target: direct, signalId: DM }),
    { placement: "private", inReplyTo: DM, advisory: REPLY_THREAD_ADVISORY });
  assert.throws(() => decideReplyPlacement({ ...flags, broadcastToChannel: true, target: direct, signalId: DM }),
    (error: unknown) => error instanceof ReplyPlacementError && error.message === REPLY_BROADCAST_ADDRESSED);
});

test("--private or a status answers privately without reading, and --private refuses thread flags", () => {
  assert.deepEqual(decideReplyPlacement({ ...flags, private: true, target: channelPost, signalId: ROOT }),
    { placement: "private", inReplyTo: ROOT, advisory: null });
  assert.deepEqual(decideReplyPlacement({ ...flags, status: true, target: channelPost, signalId: ROOT }),
    { placement: "private", inReplyTo: ROOT, advisory: null });
  for (const extra of [{ thread: true }, { broadcastToChannel: true }]) {
    assert.throws(() => decideReplyPlacement({ ...flags, ...extra, private: true, target: null, signalId: ROOT }),
      (error: unknown) => error instanceof ReplyPlacementError && error.message === REPLY_PRIVATE_CONFLICT);
  }
});

test("a message the caller can't read leaves the flags in charge, as before", () => {
  assert.deepEqual(decideReplyPlacement({ ...flags, target: null, signalId: ROOT }), { placement: "private", inReplyTo: ROOT, advisory: null });
  assert.deepEqual(decideReplyPlacement({ ...flags, thread: true, target: null, signalId: ROOT }), { placement: "thread", threadRootId: ROOT, author: null });
  assert.throws(() => decideReplyPlacement({ ...flags, broadcastToChannel: true, target: null, signalId: ROOT }),
    (error: unknown) => error instanceof ReplyPlacementError && error.message === REPLY_BROADCAST_NEEDS_THREAD);
});

test("local MCP note, ask and reply take mentions; reply takes private; mention refusals have fixed sentences", () => {
  const tool = (name: string) => MCP_TOOLS.find((row) => row.name === name) as unknown as { inputSchema: { properties: Record<string, unknown> } };
  for (const name of ["note", "ask", "reply"]) assert.ok(tool(name).inputSchema.properties.mentions, name);
  assert.ok(tool("reply").inputSchema.properties.private);
  assert.equal(tool("working_on").inputSchema.properties.mentions, undefined);
  const reply = { signal_id: ROOT, body: "on it @Wren", mentions: ["Wren", AGENT], private: false, request_id: "request01" };
  assert.deepEqual(validateMcpArguments("reply", reply), reply);
  assert.throws(() => validateMcpArguments("reply", { ...reply, private: "yes" }), /Invalid argument: private/);
  assert.throws(() => validateMcpArguments("note", { body: "x", request_id: "request01", mentions: Array(9).fill("Wren") }), /Invalid argument: mentions/);
  for (const code of Object.keys(MENTION_REFUSAL_SENTENCES) as Array<keyof typeof MENTION_REFUSAL_SENTENCES>) {
    const mapped = mapMcpError(new MentionResolutionError(code, `roster prose ${USER}`));
    assert.equal(mapped.code, code);
    assert.equal(mapped.message, MENTION_REFUSAL_SENTENCES[code]);
    assert.equal(mapped.next_step, "fix the named argument");
  }
});

test("hosted note, ask and reply take mentions; ask needs recipients or mentions; reply takes private", () => {
  const schema = (name: string) => (HOSTED_TOOL_TABLE.find((row: { name: string }) => row.name === name) as { inputSchema: Record<string, any> }).inputSchema;
  assert.deepEqual(schema("ask").required, ["seat", "body", "request_id"]);
  assert.deepEqual(schema("ask").anyOf, [{ required: ["recipients"] }, { required: ["mentions"] }, { required: ["options"] }, { required: ["choices"] }]);
  assert.ok(schema("note").properties.mentions);
  assert.ok(schema("reply").properties.private);
  const base = { seat, body: "hello @Wren", request_id: "request_0001" };
  assert.deepEqual(validateHostedToolArguments("ask", { ...base, mentions: ["Wren"] }), { ...base, mentions: ["Wren"] });
  assert.deepEqual(validateHostedToolArguments("reply", { ...base, signal_id: ROOT, private: true }), { ...base, signal_id: ROOT, private: true });
  const refused: Array<[string, Record<string, unknown>, RegExp]> = [
    ["ask", base, /^Invalid ask_audience: provide recipients for a private ask, mentions for an ask in a channel/u],
    ["note", { ...base, mentions: ["Wren"], recipients: [{ kind: "user", id: USER }] }, /^Invalid mentions/u],
    ["note", { ...base, mentions: ["Wren", "wren"] }, /^Invalid mentions/u],
    ["note", { ...base, mentions: [] }, /^Invalid mentions/u],
    ["reply", { ...base, signal_id: ROOT, private: "yes" }, /^Invalid private/u],
    ["reply", { ...base, signal_id: ROOT, private: true, mentions: ["Wren"] }, /^Invalid mentions/u],
    ["working_on", { ...base, mentions: ["Wren"] }, /^Unknown tool argument/u],
  ];
  for (const [name, args, message] of refused) {
    assert.throws(() => validateHostedToolArguments(name as never, args),
      (error: unknown) => error instanceof HostedToolInputError && message.test(error.message), `${name} ${JSON.stringify(args)}`);
  }
});

test("hosted tools send the placed reply and the resolved mentions", () => {
  const roster: MentionRosterEntry[] = hostedRoster({
    members: [{ user_id: USER, display_name: "Dana" }],
    agents: [{ principal_id: AGENT, name: "Wren" }],
  });
  const note = { seat, body: "@Wren look", request_id: "request_0001" };
  assert.equal(hostedNeedsRoster("note", note), true);
  assert.equal(hostedNeedsRoster("note", { ...note, recipients: [{ kind: "user", id: USER }] }), false);
  assert.equal(hostedNeedsRoster("working_on", note), false);
  const mentions = hostedMentions("note", { ...note, mentions: ["Dana"] }, roster, null);
  assert.deepEqual(mentions, [{ kind: "agent", id: AGENT }, { kind: "user", id: USER }]);
  assert.deepEqual(hostedSignalCommand("note", note, WORKSPACE, { mentions }).command, {
    kind: "post_signal", signal_kind: "note", body: "@Wren look", to_user_id: null, to_agent_principal_id: null,
    in_reply_to: null, about: null, mentions,
  });
  // No mention: no key, so a deployment with mentions off still takes the post.
  assert.equal(Object.hasOwn(hostedSignalCommand("note", { ...note, body: "plain" }, WORKSPACE).command, "mentions"), false);

  const reply = { seat, signal_id: CHILD, body: "@Wren done", request_id: "request_0002" };
  assert.equal(hostedNeedsReplyTarget("reply", reply), true);
  assert.equal(hostedNeedsReplyTarget("reply", { ...reply, private: true }), false);
  const thread = hostedReplyPlacement(reply, ROOT);
  assert.deepEqual(thread, { placement: "thread", threadRootId: ROOT, author: null });
  const threadMentions = hostedMentions("reply", reply, roster, thread);
  assert.deepEqual(hostedSignalCommand("reply", reply, WORKSPACE, { mentions: threadMentions, placement: thread }).command, {
    kind: "post_signal", signal_kind: "note", body: "@Wren done", to_user_id: null, to_agent_principal_id: null,
    in_reply_to: null, about: null, thread_root_id: ROOT, mentions: [{ kind: "agent", id: AGENT }],
  });
  // Unreadable or addressed: private, exactly the old command, and no mention from the body.
  const privately = hostedReplyPlacement(reply, null);
  assert.deepEqual(privately, { placement: "private", inReplyTo: CHILD, advisory: null });
  assert.deepEqual(hostedMentions("reply", reply, null, privately), []);
  assert.throws(() => hostedMentions("reply", { ...reply, mentions: ["Wren"] }, roster, privately),
    (error: unknown) => error instanceof MentionResolutionError && error.code === "mention_private_reply");
  assert.deepEqual(hostedSignalCommand("reply", reply, WORKSPACE, { placement: privately }).command, {
    kind: "post_signal", signal_kind: "note", body: "@Wren done", to_user_id: null, to_agent_principal_id: null,
    in_reply_to: CHILD, about: null,
  });
  assert.deepEqual(hostedReplyPlacement({ ...reply, private: true }, ROOT), { placement: "private", inReplyTo: CHILD, advisory: null });
});

test("the reply target read: one row by id for an agent and for a person, and which answers leave the flags in charge", async () => {
  const target = cloudTarget("http://127.0.0.1:1", "anon-key");
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const answer = (status: number, body: unknown): typeof fetch => (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const agent = { kind: "agent" as const, token: "agent-token" };
  const person = { kind: "human" as const, accessToken: "person-jwt", userId: USER };

  const row = { id: CHILD, to: null, to_agent: null, in_reply_to: null, thread_root_id: ROOT, recipients: [], audience: "workspace" };
  assert.deepEqual(await readReplyTarget(target, agent, WORKSPACE, CHILD.toUpperCase(), answer(200, { signals: [row] })),
    { id: CHILD, to: null, to_agent: null, in_reply_to: null, thread_root_id: ROOT, recipients: [], audience: "workspace", from: null, from_kind: null });
  assert.deepEqual(JSON.parse(String(seen.at(-1)!.init.body)), { resource: "signals", workspace_id: WORKSPACE, inbox: false,
    about: null, kind: null, in_reply_to: null, since: null, limit: 1, include_stale: true, signal_id: CHILD });
  assert.equal(await readReplyTarget(target, agent, WORKSPACE, CHILD, answer(200, { signals: [] })), null);
  assert.equal(await readReplyTarget(target, agent, WORKSPACE, CHILD, answer(200, { signals: [{ ...row, id: ROOT }] })), null,
    "a row that is not the one asked for is never taken for it");

  const placed = await readReplyTarget(target, person, WORKSPACE, DM, answer(200, [{ id: DM, to: USER, to_agent: null, in_reply_to: null, thread_root_id: null }]));
  assert.equal(placed?.to, USER);
  const url = new URL(seen.at(-1)!.url);
  assert.equal(url.pathname, "/rest/v1/signals");
  assert.equal(url.searchParams.get("id"), `eq.${DM}`);
  assert.equal(url.searchParams.get("workspace_id"), `eq.${WORKSPACE}`);
  assert.equal(url.searchParams.get("select"), "id,from,from_kind,to,to_agent,in_reply_to,thread_root_id");
  assert.equal((seen.at(-1)!.init.headers as Record<string, string>)["accept-profile"], "swarm_read");

  for (const status of [400, 401, 403, 404]) {
    assert.equal(await readReplyTarget(target, agent, WORKSPACE, ROOT, answer(status, { error: "x" })), null, String(status));
  }
  await assert.rejects(readReplyTarget(target, agent, WORKSPACE, ROOT, answer(429, { error: "rate_limited" })), /HTTP 429/);
});

test("a thread reply notifies the author it answers: not the replier, never twice, first, and within the cap", () => {
  const byAgent = { ...threadChild, from: AGENT.toUpperCase(), from_kind: "agent" };
  const byPerson = { ...channelPost, from: USER, from_kind: "user" };
  assert.deepEqual(decideReplyPlacement({ ...flags, target: byAgent, signalId: CHILD }),
    { placement: "thread", threadRootId: ROOT, author: { kind: "agent", id: AGENT } });
  assert.deepEqual(decideReplyPlacement({ ...flags, target: byPerson, signalId: ROOT, self: { kind: "agent", id: AGENT } }),
    { placement: "thread", threadRootId: ROOT, author: { kind: "user", id: USER } }, "a person author is notified too");
  assert.equal((decideReplyPlacement({ ...flags, target: byAgent, signalId: CHILD, self: { kind: "agent", id: AGENT } }) as { author: unknown }).author,
    null, "an agent replying to itself mentions nobody");
  assert.equal((decideReplyPlacement({ ...flags, target: byPerson, signalId: ROOT, self: { kind: "user", id: USER } }) as { author: unknown }).author, null);
  // Addressed or --private: still the private reply to the author, nothing added.
  assert.deepEqual(decideReplyPlacement({ ...flags, target: { ...direct, from: AGENT, from_kind: "agent" }, signalId: DM }),
    { placement: "private", inReplyTo: DM, advisory: null });
  assert.deepEqual(decideReplyPlacement({ ...flags, private: true, target: byAgent, signalId: CHILD }),
    { placement: "private", inReplyTo: CHILD, advisory: null });

  const author = { kind: "agent" as const, id: AGENT };
  const wren = { kind: "agent" as const, id: DM };
  assert.deepEqual(addReplyAuthorMention([wren], author), { mentions: [author, wren], authorAdded: true });
  assert.deepEqual(addReplyAuthorMention([wren, { kind: "agent", id: AGENT.toUpperCase() }], author),
    { mentions: [wren, author], authorAdded: false }, "named explicitly: kept where it was, and not implicit");
  assert.deepEqual(addReplyAuthorMention([], null), { mentions: [], authorAdded: false });
  const seven = Array.from({ length: 7 }, (_, n) => ({ kind: "user" as const, id: `0000000${n}-0000-4000-8000-000000000000` }));
  assert.equal(addReplyAuthorMention(seven, author).mentions.length, 8);
  assert.throws(() => addReplyAuthorMention([...seven, wren], author),
    (error: unknown) => error instanceof MentionResolutionError && error.code === "mention_overflow");
  assert.deepEqual(withoutReplyAuthor([author, wren], author), [wren]);

  // The refusals the implicit mention can cause, and the derived id of the second send.
  assert.equal(replyAuthorMentionRefused(403, "forbidden"), true);
  assert.equal(replyAuthorMentionRefused(409, "mention_hop_limit"), true);
  assert.equal(replyAuthorMentionRefused(404, "thread_root_not_found"), false);
  assert.equal(replyAuthorMentionRefused(429, "rate_limited"), false);
  assert.equal(replyRetryCommandId("request_0001"), "request_0001_noauth");
  assert.match(replyRetryCommandId("x".repeat(72)), /^[A-Za-z0-9_-]{8,72}$/);
});

test("the hosted reply adds the author the reply_target read names, and knows when it was implicit", () => {
  const reply = { seat, signal_id: CHILD, body: "done", request_id: "request_0003" };
  const thread = hostedReplyPlacement(reply, ROOT, { kind: "agent", id: AGENT });
  assert.deepEqual(thread, { placement: "thread", threadRootId: ROOT, author: { kind: "agent", id: AGENT } });
  assert.deepEqual(hostedMentions("reply", reply, null, thread), [{ kind: "agent", id: AGENT }]);
  assert.deepEqual(hostedImplicitAuthor(reply, null, thread), { kind: "agent", id: AGENT });
  const roster: MentionRosterEntry[] = [{ kind: "agent", id: AGENT, name: "Wren" }];
  assert.equal(hostedImplicitAuthor({ ...reply, body: "done @Wren" }, roster, thread), null, "named explicitly: no second send without it");
  assert.deepEqual(hostedSignalCommand("reply", reply, WORKSPACE, { mentions: hostedMentions("reply", reply, null, thread), placement: thread }).command.mentions,
    [{ kind: "agent", id: AGENT }]);
  assert.deepEqual(hostedMentions("reply", { ...reply, private: true }, null, hostedReplyPlacement({ ...reply, private: true }, ROOT, { kind: "agent", id: AGENT })), []);
});

