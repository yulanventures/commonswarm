import assert from "node:assert/strict";
import { test } from "node:test";
import { hostedContextLabel, hostedContextPeopleLabel, hostedContextChatAuthor } from "./hosted-context-label.ts";
import { rosterAgentsFromRows } from "./participant-rail.ts";
import { peopleDialogGroups } from "./people-dialog-view.ts";
import { identityDisplayLabel, resolveStoredIdentityRefs } from "./identity-label.ts";
import { browserSignalCommand } from "./commonswarm.ts";
import { mapHomePeople, homeParty } from "./home-map.ts";
import { authorLabel } from "./home-stream.ts";

const first = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";
const rows = [
  { principal_id: first, name: "Claude-7K2P", display_name: "Claude", disambiguator: "7K2P",
    identity_lifetime: "ephemeral", transport: "hosted_mcp", owner_user_id: "owner",
    app: { client_id: "registered-app", display_name: "Claude" }, context_activity: { last_business_at: "2026-10-10T12:00:00Z", active_contexts: 1 } },
  { principal_id: second, name: "Claude-8N3Q", display_name: "Claude", disambiguator: "8N3Q",
    identity_lifetime: "ephemeral", transport: "hosted_mcp", owner_user_id: "owner",
    app: { client_id: "registered-app", display_name: "Claude" } },
];

const homePeople = agents => mapHomePeople({ viewerId: "owner", members: [{ userId: "owner", name: "Synthetic owner", role: "owner" }],
  agents, access: [], signals: [], now: Date.parse("2026-10-10T12:00:00Z"), sample: false });
const exactRoster = agents => agents.map(agent => ({ id: agent.principalId, name: agent.name }));

test("roster metadata separates ordinary labels from exact addresses without parsing suffixes", () => {
  const agents = rosterAgentsFromRows(rows);
  assert.equal(agents[0].app.client_id, "registered-app");
  assert.equal(agents[0].lastBusinessAt, "2026-10-10T12:00:00Z");
  assert.deepEqual(agents.map(agent => hostedContextLabel(agent)), [
    { label: "Claude", exactName: "Claude-7K2P", badge: "7K2P", distinction: "Separate chat", assurance: "App connection identity; chat not verified" },
    { label: "Claude", exactName: "Claude-8N3Q", badge: "8N3Q", distinction: "Separate chat", assurance: "App connection identity; chat not verified" },
  ]);
  const local = rosterAgentsFromRows([{ ...rows[0], transport: "local" }])[0];
  assert.deepEqual(hostedContextLabel(local), { label: "Claude-7K2P", exactName: "Claude-7K2P", badge: null, distinction: null, assurance: null });
  const legacy = rosterAgentsFromRows([{ principal_id: first, name: "Claude-7K2P", transport: "hosted_mcp" }])[0];
  assert.equal(hostedContextLabel(legacy).label, "Claude-7K2P");
  assert.equal(hostedContextLabel(legacy).badge, null);
  assert.equal(hostedContextLabel({ ...agents[0], identityLifetime: "durable" }).distinction, "Separate agent · Shared across chats");
  assert.equal(hostedContextLabel({ ...agents[0], identityLifetime: "durable", disambiguator: null }).distinction, "Shared across chats");
});

test("exact recipient search and restored addressing preserve each principal UUID", () => {
  const agents = rosterAgentsFromRows(rows);
  const model = { people: [{ id: "owner", name: "Synthetic owner" }], invites: [], agents: agents.map(agent => ({
    id: agent.principalId, name: agent.displayName, exactName: agent.name, disambiguator: agent.disambiguator,
    hosted: true, identityLifetime: agent.identityLifetime, app: agent.app.display_name, appClientId: agent.app.client_id,
    ownerId: agent.ownerUserId, status: { attention: false },
  })) };
  assert.deepEqual(peopleDialogGroups(model, "Claude-8N3Q").groups[0].agents.map(agent => agent.id), [second]);
  assert.deepEqual(peopleDialogGroups(model, "7K2P").groups[0].agents.map(agent => agent.id), [first]);
  const roster = { agents: agents.map(agent => ({ id: agent.principalId, name: agent.name })), members: [] };
  const selected = resolveStoredIdentityRefs([{ kind: "agent", name: "Claude-8N3Q" }], roster);
  assert.deepEqual(browserSignalCommand("Synthetic question", selected.recipients, "ask").to, [{ kind: "agent", id: second }]);
  assert.deepEqual(resolveStoredIdentityRefs([{ kind: "agent", name: "Claude" }], roster).recipients, []);
});

test("local and metadata-free hosted People labels retain UUID distinction for titles and accessible names", () => {
  const agents = rosterAgentsFromRows([
    { principal_id: first, name: "Claude", transport: "local", owner_user_id: "owner" },
    { principal_id: second, name: "Claude", transport: "local", owner_user_id: "owner" },
    { principal_id: "33333333-3333-4333-8333-333333333333", name: "Claude", transport: "hosted_mcp", owner_user_id: "owner" },
  ]);
  const labels = agents.map(agent => hostedContextPeopleLabel(agent, exactRoster(agents)));
  assert.deepEqual(labels.map(label => label.name), ["Claude · 11111111", "Claude · 22222222", "Claude · 33333333"]);
  assert.deepEqual(labels.map(label => [label.exactName, label.disambiguator]), [[undefined, null], [undefined, null], [undefined, null]]);
});

test("the production chat-author mapping uses hosted display metadata while recipient addressing keeps the exact name", () => {
  const agents = rosterAgentsFromRows([rows[0]]);
  const mapped = homePeople(agents);
  const original = homeParty({ kind: "agent", id: first }, mapped);
  const author = hostedContextChatAuthor(original, agents[0]);
  assert.equal(authorLabel(author), "Claude");
  assert.equal(author.name, "Claude-7K2P");
  assert.equal(identityDisplayLabel({ id: author.id, name: author.name }, exactRoster(agents)), "Claude-7K2P");
  assert.equal(original.label, "Your Claude-7K2P", "chat mapping leaves the Home model available for exact addressing");
  assert.equal(hostedContextChatAuthor(original, { ...agents[0], displayName: null }), original);
  assert.equal(hostedContextChatAuthor(original, { ...agents[0], transport: "local" }), original);
});

test("a durable agent deliberately named Marketing-7K2P keeps its whole label without a badge", () => {
  for (const display_name of ["Marketing-7K2P", undefined]) {
    const [agent] = rosterAgentsFromRows([{ principal_id: first, name: "Marketing-7K2P", display_name,
      identity_lifetime: "durable", transport: "hosted_mcp", owner_user_id: "owner" }]);
    const roster = exactRoster([agent]);
    assert.equal(hostedContextLabel(agent).label, "Marketing-7K2P");
    assert.equal(hostedContextLabel(agent).badge, null);
    assert.equal(hostedContextPeopleLabel(agent, roster).name, "Marketing-7K2P");
    const original = homeParty({ kind: "agent", id: first }, homePeople([agent]));
    assert.equal(authorLabel(hostedContextChatAuthor(original, agent)), display_name ? "Marketing-7K2P" : "Your Marketing-7K2P");
    assert.equal(identityDisplayLabel({ id: agent.principalId, name: agent.name }, roster), "Marketing-7K2P");
    assert.deepEqual(resolveStoredIdentityRefs([{ kind: "agent", name: "Marketing-7K2P" }], { agents: roster, members: [] }).recipients,
      [{ kind: "agent", id: first }]);
  }
});
