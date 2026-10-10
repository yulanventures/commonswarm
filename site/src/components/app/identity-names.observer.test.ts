import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const peopleView = readFileSync(new URL("../../lib/people-dialog-view.ts", import.meta.url), "utf8");
const dashboard = readFileSync(new URL("./LiveDashboard.astro", import.meta.url), "utf8");
const hostedLabels = readFileSync(new URL("../../lib/hosted-context-label.ts", import.meta.url), "utf8");
const connect = readFileSync(
  new URL("../connect/AgentConnect.astro", import.meta.url),
  "utf8",
);
const agentConnect = readFileSync(
  new URL("../../lib/agent-connect.ts", import.meta.url),
  "utf8",
);

test("selections, chips, drafts and roster rows keep principal UUIDs", () => {
  assert.match(dashboard, /dataset\.composerToChip = recipientKey\(entity\)/);
  assert.match(dashboard, /return \{ id: agent\.principalId, \.\.\.hostedContextPeopleLabel\(agent, rosterNames\)/);
  assert.match(hostedLabels, /name: hasDisplay \? context\.label : identityDisplayLabel\(\{ id: agent\.principalId, name: agent\.name \}, roster\)/);
  assert.match(hostedLabels, /exactName: hasDisplay \? context\.exactName : undefined/);
  assert.match(peopleView, /dataset\.agentRow = agent\.id/);
  assert.match(dashboard, /mentionOptionId\(candidate\)/);
  assert.match(dashboard, /identityDisplayLabel/);
  assert.match(dashboard, /resolveStoredIdentityRefs/);
  assert.match(dashboard, /parseStoredIdentityRef/);
  assert.match(
    dashboard,
    /const draftTo = composerToLive \? composerTo : storedPair\?\.to;[\s\S]{0,500}to: draftTo/,
    "a stored draft writes the UUID To: set, not the rendered label",
  );
});

test("the mention pick writes the disambiguated label and keeps the UUID action", () => {
  assert.match(dashboard, /const tag = `@\$\{entityName\(mention\)\} `;/);
  assert.match(dashboard, /selectMention\(candidate\)/);
  assert.match(dashboard, /mentionOptionId = \(entity: EntityRef\): string =>/);
  assert.match(
    dashboard,
    /dashboard-composer-mention-option-\$\{entity\.kind\}-\$\{entity\.id\}/,
  );
});

test("the picker option id is the UUID of the record clicked", () => {
  assert.match(
    dashboard,
    /const mentionOptionId = \(entity: EntityRef\): string =>\s*`dashboard-composer-mention-option-\$\{entity\.kind\}-\$\{entity\.id\}`/,
  );
  assert.match(dashboard, /button\.id = mentionOptionId\(candidate\);/);
  assert.match(
    dashboard,
    /button\.addEventListener\("click", \(\) => selectMention\(candidate\)\);/,
  );
  const pickStart = dashboard.indexOf("const selectMention");
  const pickEnd = dashboard.indexOf("const renderMentionPicker");
  assert.ok(pickStart >= 0 && pickEnd > pickStart);
  const pick = dashboard.slice(pickStart, pickEnd);
  assert.match(pick, /entityName\(mention\)/);
  assert.doesNotMatch(pick, /lookupByDisplayName/);
  assert.match(
    dashboard,
    /mentionCandidates[\s\S]*kind: "agent" as const, id: agent\.principalId/,
  );
});

test("create-another is an explicit action and default creates omit the flag", () => {
  assert.match(connect, /data-action="create-another"/);
  assert.match(connect, /Create another called \$\{name\}/);
  assert.match(connect, /#createAnotherChosen/);
  assert.match(
    connect,
    /allowDuplicateName = this\.#createAnotherChosen &&/,
  );
  assert.match(
    agentConnect,
    /createAgentPrincipalCommand\(name, model, allowDuplicateName\)/,
  );
});
