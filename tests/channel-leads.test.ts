/** Channel leads without a server: the edge's command shape, the protocol's human-only rule, the read
 * columns, and what `cswarm channel lead` parses and puts on the wire. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  CHANNEL_LEAD_MODES,
  parseSetChannelLeadCommand,
  SET_CHANNEL_LEAD_FIELDS_TEXT,
  SET_CHANNEL_LEAD_ID_RULE_TEXT,
} from "../supabase/functions/command/channel-lead.js";
import { CHANNEL_ID_RULE_TEXT, CHANNEL_READ_COLUMNS, commandFieldsMessage } from "../supabase/functions/_shared/channels.js";
import { HUMAN_ONLY_COMMANDS } from "../src/protocol/workspace-commands.js";
import { channelLeadCommand, CHANNEL_COLUMNS, resolveChannelLeadAgent } from "../src/cloud/channels.js";
import { ThinCommandClient } from "../src/cloud/command-client.js";
import { Arguments, channelLeadChoice } from "../src/cli.js";

const CHANNEL = "3F2B8A9C-1D4E-4F6A-9B7C-0E1D2C3B4A59";
const AGENT = "7A6B5C4D-3E2F-4A1B-8C9D-0E1F2A3B4C5D";
const OTHER = "11111111-2222-4333-8444-555555555555";

test("set_channel_lead takes channel_id and lead_mode, and principal_id only for an agent", () => {
  assert.deepEqual(parseSetChannelLeadCommand({ kind: "set_channel_lead", channel_id: CHANNEL, lead_mode: "agent", principal_id: AGENT }), {
    ok: true,
    command: { kind: "set_channel_lead", channel_id: CHANNEL.toLowerCase(), lead_mode: "agent", principal_id: AGENT.toLowerCase() },
  });
  for (const mode of ["workspace", "none"]) {
    const absent = parseSetChannelLeadCommand({ kind: "set_channel_lead", channel_id: CHANNEL, lead_mode: mode });
    assert.deepEqual(absent, {
      ok: true,
      command: { kind: "set_channel_lead", channel_id: CHANNEL.toLowerCase(), lead_mode: mode, principal_id: null },
    });
    assert.deepEqual(parseSetChannelLeadCommand({ kind: "set_channel_lead", channel_id: CHANNEL, lead_mode: mode, principal_id: null }),
      absent, "an explicit null is the same command as none, so it has the same request hash");
  }
});

test("its refusals are the shared channel sentences", () => {
  assert.equal(SET_CHANNEL_LEAD_FIELDS_TEXT, commandFieldsMessage("set_channel_lead", ["channel_id", "lead_mode"], ["principal_id"]));
  assert.equal(SET_CHANNEL_LEAD_ID_RULE_TEXT, CHANNEL_ID_RULE_TEXT);
  assert.deepEqual(parseSetChannelLeadCommand({ kind: "set_channel_lead", channel_id: CHANNEL, lead_mode: "none", x: 1 }),
    { ok: false, status: 400, reason: SET_CHANNEL_LEAD_FIELDS_TEXT });
});

test("set_channel_lead refuses anything else", () => {
  for (const cmd of [
    { kind: "set_channel_lead" },
    { kind: "set_channel_lead", channel_id: CHANNEL },
    { kind: "set_channel_lead", lead_mode: "none" },
    { kind: "set_channel_lead", channel_id: "design", lead_mode: "none" },
    { kind: "set_channel_lead", channel_id: null, lead_mode: "none" },
    { kind: "set_channel_lead", channel_id: CHANNEL, lead_mode: "lead" },
    { kind: "set_channel_lead", channel_id: CHANNEL, lead_mode: null },
    { kind: "set_channel_lead", channel_id: CHANNEL, lead_mode: "agent" },
    { kind: "set_channel_lead", channel_id: CHANNEL, lead_mode: "agent", principal_id: null },
    { kind: "set_channel_lead", channel_id: CHANNEL, lead_mode: "agent", principal_id: "DesignLead" },
    { kind: "set_channel_lead", channel_id: CHANNEL, lead_mode: "workspace", principal_id: AGENT },
    { kind: "set_channel_lead", channel_id: CHANNEL, lead_mode: "none", principal_id: AGENT },
    { kind: "set_channel_lead", channel_id: CHANNEL, lead_mode: "none", extra: true },
    { kind: "set_channel_lead", channel_id: CHANNEL, lead_mode: "agent", principal_id: AGENT, lead_agent_principal_id: AGENT },
  ]) {
    const parsed = parseSetChannelLeadCommand(cmd);
    assert.equal(parsed.ok, false, JSON.stringify(cmd));
    if (!parsed.ok) assert.equal(parsed.status, 400);
  }
});

test("the modes match the migration's CHECK, and set_channel_lead is a person's command", () => {
  const migration = readFileSync(new URL("../supabase/migrations/20261117000002_channel_leads.sql", import.meta.url), "utf8");
  assert.ok(migration.includes(`CHECK (lead_mode IN (${CHANNEL_LEAD_MODES.map((mode) => `'${mode}'`).join(", ")}))`));
  assert.ok(HUMAN_ONLY_COMMANDS.has("set_channel_lead"));
  const bundle = readFileSync(new URL("../supabase/functions/_shared/protocol.js", import.meta.url), "utf8");
  assert.match(bundle, /HUMAN_ONLY_COMMANDS = \/\* @__PURE__ \*\/ new Set\(\[[^\]]*"set_channel_lead"/,
    "the edge bundle is regenerated from the protocol");
  const edge = readFileSync(new URL("../supabase/functions/command/index.ts", import.meta.url), "utf8");
  assert.match(edge, /const CHANNEL_COMMAND_KINDS = \[[^\]]*"set_channel_lead",\n\] as const;/,
    "it travels the channel-command path: its lock, uniform 404, manager rule and ledger");
});

test("both channel reads end with the lead setting", () => {
  assert.deepEqual(CHANNEL_READ_COLUMNS.slice(-3), ["visibility", "lead_mode", "lead_agent_principal_id"]);
  assert.deepEqual([...CHANNEL_COLUMNS], [...CHANNEL_READ_COLUMNS]);
});

test("cswarm channel lead takes the channel and exactly one of an agent, --workspace or --none", () => {
  assert.deepEqual(channelLeadChoice(new Arguments(["channel", "lead", "design", "DesignLead"])), { mode: "agent", agent: "DesignLead" });
  assert.deepEqual(channelLeadChoice(new Arguments(["channel", "lead", "design", "--workspace"])), { mode: "workspace" });
  assert.deepEqual(channelLeadChoice(new Arguments(["channel", "lead", "design", "--none", "--json"])), { mode: "none" });
  for (const argv of [
    ["channel", "lead"],
    ["channel", "lead", "design"],
    ["channel", "lead", "design", "DesignLead", "--none"],
    ["channel", "lead", "design", "--workspace", "--none"],
  ]) {
    assert.throws(() => channelLeadChoice(new Arguments(argv)), /needs the channel and one of an agent, --workspace or --none/,
      argv.join(" "));
  }
});

test("the agent is named by id or exact name among live agents", () => {
  const agents = [
    { principal_id: AGENT.toLowerCase(), name: "DesignLead" },
    { principal_id: OTHER, name: "Twin" },
    { principal_id: "22222222-3333-4444-8555-666666666666", name: "Twin" },
  ];
  assert.equal(resolveChannelLeadAgent("DesignLead", agents), AGENT.toLowerCase());
  assert.equal(resolveChannelLeadAgent(AGENT, agents), AGENT.toLowerCase(), "an id in any case");
  assert.throws(() => resolveChannelLeadAgent("hezlead", agents), /not a live agent in this workspace/, "names match exactly");
  assert.throws(() => resolveChannelLeadAgent("Twin", agents), new RegExp(`More than one agent is named Twin; use one of these ids: ${OTHER}`));
  assert.throws(() => resolveChannelLeadAgent("33333333-4444-4555-8666-777777777777", agents), /not a live agent/);
});

test("the wire body names principal_id only for an agent lead", async () => {
  assert.deepEqual(channelLeadCommand(CHANNEL, "workspace"), { kind: "set_channel_lead", channel_id: CHANNEL, lead_mode: "workspace" });
  assert.deepEqual(channelLeadCommand(CHANNEL, "none"), { kind: "set_channel_lead", channel_id: CHANNEL, lead_mode: "none" });
  assert.deepEqual(channelLeadCommand(CHANNEL, "agent", AGENT),
    { kind: "set_channel_lead", channel_id: CHANNEL, lead_mode: "agent", principal_id: AGENT });
  assert.throws(() => channelLeadCommand(CHANNEL, "agent"));

  const sent: Record<string, unknown>[] = [];
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({
      status: "accepted", ok: true, event_ids: [],
      channel: { channel_id: CHANNEL.toLowerCase(), slug: "design", lead_mode: "agent", lead_agent_principal_id: AGENT.toLowerCase() },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const client = new ThinCommandClient({ url: "https://api.example.test", anonKey: "anon", profileId: "p" } as never, fetcher);
  const result = await client.sendChannel({
    workspaceId: OTHER, credential: "jwt", commandId: "cmd-1",
    command: channelLeadCommand(CHANNEL.toLowerCase(), "agent", AGENT.toLowerCase()),
  });
  assert.equal(result.channel.lead_mode, "agent");
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0]!.command, {
    kind: "set_channel_lead", channel_id: CHANNEL.toLowerCase(), lead_mode: "agent", principal_id: AGENT.toLowerCase(),
  });
  assert.deepEqual(Object.keys(sent[0]!).sort(), ["client_build", "client_version", "command", "command_id", "stream", "workspace_id"]);
  assert.deepEqual(sent[0]!.stream, { kind: "workspace" });
});
