/** Reached by `npm --prefix site test` through the src/lib/*.test.mjs glob. */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CommandAttempts, UNNAMED_LEAD_LABEL, WORKSPACE_LEAD_UNCONFIRMED_LABEL, channelLead, channelLeadFromValue, channelLeadOptions, channelLeadValue,
  namedChannelLead, parseChannelLeadColumns, privateChannelNonMemberLeadAgents, setChannelLeadCommand,
} from "./channel-lead.ts";
import { CommandOutcomeUnknown, setChannelLead, workspaceChannels } from "./commonswarm.ts";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const H = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const T = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const W = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const agents = [
  { principalId: B, name: "Builder", transport: "local", turnOnly: false },
  { principalId: A, name: "Atlas", transport: "local", turnOnly: false },
  { principalId: H, name: "Hosted helper", transport: "hosted_mcp", turnOnly: true },
  { principalId: T, name: "Turn taker", transport: "local", turnOnly: true },
  { principalId: W, name: "Wren", transport: "local", turnOnly: false },
];
const lead = agents.find((agent) => agent.principalId === W);

test("a channel row's lead reads as the server's three settings, and an older server's row as the workspace lead", () => {
  assert.deepEqual(parseChannelLeadColumns({}), {}, "an older server sends neither column: they stay absent");
  assert.deepEqual(channelLead(parseChannelLeadColumns({})), { mode: "workspace" });
  assert.deepEqual(parseChannelLeadColumns({ lead_mode: "agent", lead_agent_principal_id: A }), { leadMode: "agent", leadAgentPrincipalId: A });
  assert.deepEqual(parseChannelLeadColumns({ lead_mode: "none", lead_agent_principal_id: null }), { leadMode: "none", leadAgentPrincipalId: null });
  assert.deepEqual(parseChannelLeadColumns({ lead_mode: "workspace", lead_agent_principal_id: null }), { leadMode: "workspace", leadAgentPrincipalId: null });
  for (const odd of [
    { lead_mode: "agent", lead_agent_principal_id: null }, { lead_mode: "agent", lead_agent_principal_id: "" },
    { lead_mode: "agent" }, { lead_mode: "AGENT", lead_agent_principal_id: A }, { lead_mode: 1 }, { lead_mode: null },
    { lead_agent_principal_id: A },
  ]) assert.deepEqual(parseChannelLeadColumns(odd), { leadMode: "workspace", leadAgentPrincipalId: null }, JSON.stringify(odd));
  assert.deepEqual(channelLead({ leadMode: "none", leadAgentPrincipalId: A }), { mode: "none" });
});

/** The deployment from the page's meta tags; `rest` answers reads, `command` answers the command edge. */
function edge(t, { rest = () => [200, []], command = () => [200, {}] } = {}) {
  const sent = [];
  const originalFetch = globalThis.fetch, originalDocument = globalThis.document;
  globalThis.document = { querySelector: (selector) => ({
    'meta[name="commonswarm:url"]': { content: "https://api.example.test" },
    'meta[name="commonswarm:anon-key"]': { content: "anon" },
  })[selector] ?? null };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.pathname === "/functions/v1/command") {
      const body = JSON.parse(init.body);
      sent.push(body);
      const [status, answer] = command(body);
      return { status, text: async () => JSON.stringify(answer) };
    }
    sent.push(url);
    const [status, answer] = rest(url);
    return new Response(JSON.stringify(answer), { status, headers: { "content-type": "application/json" } });
  };
  t.after(() => { globalThis.fetch = originalFetch; globalThis.document = originalDocument; });
  return sent;
}
const SESSION = { access_token: "token", user: { id: "viewer" } };
const row = (extra) => ({ channel_id: "c1", workspace_id: "w1", slug: "design", purpose: null, created_by_principal: "viewer",
  created_by_kind: "user", created_at: "2026-11-01T00:00:00Z", archived_at: null, sort_rank: 0, visibility: "open", ...extra });

test("the channel list asks for every column, so a server without the lead columns still answers", async (t) => {
  const sent = edge(t, { rest: () => [200, [row({}), row({ channel_id: "c2", lead_mode: "agent", lead_agent_principal_id: A }),
    row({ channel_id: "c3", lead_mode: "agent", lead_agent_principal_id: 7 })]] });
  const [old, named, odd] = await workspaceChannels("w1");
  assert.equal(sent[0].pathname, "/rest/v1/channels");
  assert.equal(sent[0].searchParams.get("select"), "*");
  assert.equal(old.leadMode, undefined);
  assert.deepEqual(channelLead(old), { mode: "workspace" });
  assert.deepEqual([named.leadMode, named.leadAgentPrincipalId], ["agent", A]);
  assert.deepEqual([odd.leadMode, odd.leadAgentPrincipalId], ["workspace", null]);
});

test("set_channel_lead sends exactly its keys: principal_id only for an agent", async (t) => {
  const sent = edge(t, { command: (body) => [200, { status: "accepted", channel: row({ lead_mode: body.command.lead_mode,
    lead_agent_principal_id: body.command.principal_id ?? null }) }] });
  const results = [
    await setChannelLead(SESSION, "id-1", "w1", "c1", { mode: "agent", principalId: A }),
    await setChannelLead(SESSION, "id-2", "w1", "c1", { mode: "none" }),
    await setChannelLead(SESSION, "id-3", "w1", "c1", { mode: "workspace" }),
  ];
  assert.deepEqual(sent.map((body) => [body.command_id, body.workspace_id, body.stream, body.command]), [
    ["id-1", "w1", { kind: "workspace" }, { kind: "set_channel_lead", channel_id: "c1", lead_mode: "agent", principal_id: A }],
    ["id-2", "w1", { kind: "workspace" }, { kind: "set_channel_lead", channel_id: "c1", lead_mode: "none" }],
    ["id-3", "w1", { kind: "workspace" }, { kind: "set_channel_lead", channel_id: "c1", lead_mode: "workspace" }],
  ]);
  assert.deepEqual(Object.keys(setChannelLeadCommand("c1", { mode: "none" })), ["kind", "channel_id", "lead_mode"]);
  assert.deepEqual(results.map((result) => result.ok && [result.channel.leadMode, result.channel.leadAgentPrincipalId]),
    [["agent", A], ["none", null], ["workspace", null]]);
});

test("a refusal is decided and carries the server's sentence; anything else is an unknown outcome", async (t) => {
  const answers = [
    [403, { error: "channel_lead_not_eligible", message: "A channel lead must be a live local agent in this workspace that is not turn-only and can read this channel. Nothing changed." }],
    [404, { error: "channel_not_found", message: "No such channel." }],
    [403, { error: "channel_forbidden" }],
    [500, { error: "internal" }],
    [200, { status: "accepted" }],
  ];
  edge(t, { command: () => answers.shift() });
  const lead = { mode: "agent", principalId: A };
  assert.deepEqual(await setChannelLead(SESSION, "a", "w1", "c1", lead), { ok: false, status: 403,
    message: "A channel lead must be a live local agent in this workspace that is not turn-only and can read this channel. Nothing changed." });
  assert.deepEqual(await setChannelLead(SESSION, "b", "w1", "c1", lead), { ok: false, status: 404, message: "No such channel." });
  const bare = await setChannelLead(SESSION, "c", "w1", "c1", lead);
  assert.equal(bare.ok, false);
  assert.match(bare.message, /HTTP 403\)\. Nothing was changed\./);
  await assert.rejects(setChannelLead(SESSION, "d", "w1", "c1", lead), (error) => error instanceof CommandOutcomeUnknown && /HTTP 500/.test(error.message));
  await assert.rejects(setChannelLead(SESSION, "e", "w1", "c1", lead), CommandOutcomeUnknown);
});

test("the select offers the workspace lead, No lead, then the agents that may lead, by name", () => {
  const options = channelLeadOptions({ agents, workspaceLead: lead, stored: { mode: "workspace" }, visibility: "open" });
  assert.deepEqual(options, [
    { value: "workspace", label: "Workspace lead (Wren)" },
    { value: "none", label: "No lead" },
    { value: `agent:${A}`, label: "Atlas" },
    { value: `agent:${B}`, label: "Builder" },
    { value: `agent:${W}`, label: "Wren" },
  ], "hosted and turn-only agents are never offered");
  assert.equal(channelLeadOptions({ agents, workspaceLead: null, stored: { mode: "none" } })[0].label, "Workspace lead (none)");
});

test("a private channel offers only its member agents, and names no workspace lead until they are known", () => {
  const members = new Set([B, H]);
  const base = { agents, workspaceLead: lead, visibility: "private" };
  assert.deepEqual(channelLeadOptions({ ...base, stored: { mode: "workspace" }, memberAgentIds: members }).map((o) => o.label),
    ["Workspace lead (none)", "No lead", "Builder"], "the workspace lead is not a member, so here it leads nobody");
  assert.deepEqual(channelLeadOptions({ ...base, stored: { mode: "workspace" }, memberAgentIds: new Set([W]) }).map((o) => o.label),
    ["Workspace lead (Wren)", "No lead", "Wren"]);
  assert.deepEqual(channelLeadOptions({ ...base, stored: { mode: "agent", principalId: B }, memberAgentIds: null }),
    [{ value: "workspace", label: WORKSPACE_LEAD_UNCONFIRMED_LABEL }, { value: "none", label: "No lead" }, { value: `agent:${B}`, label: "Builder" }],
    "while members load: the workspace lead is not named, and the stored lead stays a choice so the selection never jumps");
  assert.deepEqual(channelLeadOptions({ ...base, stored: { mode: "none" }, memberAgentIds: null }).map((o) => o.value), ["workspace", "none"]);
  assert.deepEqual(channelLeadOptions({ ...base, stored: { mode: "agent", principalId: A }, memberAgentIds: members }).slice(2),
    [{ value: `agent:${A}`, label: "Atlas", disabled: true }, { value: `agent:${B}`, label: "Builder" }],
    "a stored lead known not to be a member is kept, disabled");
});

test("the stored lead and the shown value always stay options, disabled when they may not lead", () => {
  const gone = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const options = channelLeadOptions({ agents, workspaceLead: null, stored: { mode: "agent", principalId: gone }, selected: `agent:${T}` });
  assert.deepEqual(options.slice(2), [
    { value: `agent:${gone}`, label: UNNAMED_LEAD_LABEL, disabled: true },
    { value: `agent:${A}`, label: "Atlas" }, { value: `agent:${B}`, label: "Builder" },
    { value: `agent:${T}`, label: "Turn taker", disabled: true }, { value: `agent:${W}`, label: "Wren" },
  ]);
});

test("values round-trip", () => {
  for (const value of [{ mode: "workspace" }, { mode: "none" }, { mode: "agent", principalId: A }]) {
    assert.deepEqual(channelLeadFromValue(channelLeadValue(value)), value);
  }
  for (const odd of ["", "agent:", "lead", "AGENT:x"]) assert.equal(channelLeadFromValue(odd), null, odd);
});

test("a named channel's header names the agent a post wakes, stays quiet for No lead, and says when the lead is missing", () => {
  const named = (input) => namedChannelLead({ agents, workspaceLead: lead, ...input });
  assert.deepEqual(named({ lead: { mode: "none" } }), { state: "quiet" }, "No lead is a choice");
  assert.deepEqual(named({ lead: { mode: "none" }, visibility: "private", memberAgentIds: null }), { state: "quiet" });
  assert.equal(named({ lead: { mode: "agent", principalId: A } }).agent?.name, "Atlas");
  assert.equal(named({ lead: { mode: "workspace" } }).agent?.name, "Wren", "the workspace lead");
  assert.deepEqual(named({ lead: { mode: "agent", principalId: H } }), { state: "missing" }, "a hosted agent never leads");
  assert.deepEqual(named({ lead: { mode: "agent", principalId: "gone" } }), { state: "missing" }, "no longer on the roster");
  assert.deepEqual(named({ lead: { mode: "workspace" }, workspaceLead: null }), { state: "missing" }, "no workspace lead");
  // Private: only a member leads, and nothing is said before the members are known.
  assert.deepEqual(named({ lead: { mode: "workspace" }, visibility: "private", memberAgentIds: null }), { state: "unknown" });
  assert.deepEqual(named({ lead: { mode: "agent", principalId: A }, visibility: "private", memberAgentIds: null }), { state: "unknown" });
  assert.deepEqual(named({ lead: { mode: "workspace" }, visibility: "private", memberAgentIds: new Set([A]) }), { state: "missing" },
    "the workspace lead is not a member");
  assert.equal(named({ lead: { mode: "workspace" }, visibility: "private", memberAgentIds: new Set([W]) }).agent?.name, "Wren");
  assert.equal(named({ lead: { mode: "agent", principalId: A }, visibility: "private", memberAgentIds: new Set([A]) }).agent?.name, "Atlas");
  assert.deepEqual(named({ lead: { mode: "agent", principalId: A }, visibility: "private", memberAgentIds: new Set([B]) }), { state: "missing" });
  assert.equal(named({ lead: { mode: "workspace" }, visibility: "open", memberAgentIds: new Set() }).agent?.name, "Wren", "members matter only when private");
});

test("one command id per selection: kept while unanswered, fresh after an answer or for another selection", () => {
  let n = 0;
  const fresh = () => `id-${++n}`;
  const attempts = new CommandAttempts();
  assert.equal(attempts.commandId("u:w:c", "none", fresh), "id-1");
  assert.equal(attempts.commandId("u:w:c", "none", fresh), "id-1", "a lost answer retries with the same id");
  assert.equal(attempts.commandId("u:w:other", "none", fresh), "id-2", "another channel is its own attempt");
  assert.equal(attempts.commandId("u:w:c", `agent:${A}`, fresh), "id-3", "another selection is a new attempt");
  attempts.settle("u:w:c");
  assert.equal(attempts.commandId("u:w:c", `agent:${A}`, fresh), "id-4", "an answered attempt is over");
});

test("privateChannelNonMemberLeadAgents lists eligible non-member workspace agents for private channels, sorted and excluding duplicates", () => {
  assert.deepEqual(
    privateChannelNonMemberLeadAgents({ agents, memberAgentIds: new Set([B]), visibility: "open" }),
    [],
    "open channels have no non-member group",
  );
  assert.deepEqual(
    privateChannelNonMemberLeadAgents({ agents, memberAgentIds: null, visibility: "private" }),
    [],
    "returns empty while private channel members are not yet known",
  );
  assert.deepEqual(
    privateChannelNonMemberLeadAgents({ agents, memberAgentIds: new Set([B]), visibility: "private" }).map((a) => a.principalId),
    [A, W],
    "returns eligible local non-turn-only non-members sorted by name (omitting hosted and turn-only agents)",
  );
  assert.deepEqual(
    privateChannelNonMemberLeadAgents({
      agents,
      memberAgentIds: new Set([B]),
      visibility: "private",
      excludeIds: new Set([A]),
    }).map((a) => a.principalId),
    [W],
    "excludes agent IDs already emitted in the select options",
  );
  const sameName = [
    { principalId: "22222222-2222-4222-8222-222222222222", name: "Scout", transport: "local", turnOnly: false },
    { principalId: "11111111-1111-4111-8111-111111111111", name: "Scout", transport: "local", turnOnly: false },
  ];
  assert.deepEqual(
    privateChannelNonMemberLeadAgents({ agents: sameName, memberAgentIds: new Set(), visibility: "private" }).map((a) => a.principalId),
    ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"],
    "breaks name ties by principalId",
  );
});
