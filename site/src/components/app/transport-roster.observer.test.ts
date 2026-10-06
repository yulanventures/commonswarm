import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { agentEntityView } from "../../lib/entity-panel";
import { rosterAgentsFromRows } from "../../lib/participant-rail";

const peopleView = readFileSync(new URL("../../lib/people-dialog-view.ts", import.meta.url), "utf8");
const dashboard = readFileSync(new URL("./LiveDashboard.astro", import.meta.url), "utf8");

test("agent roster normalizes and labels local and hosted MCP transports", () => {
  const agents = rosterAgentsFromRows([
    { principal_id: "local", name: "Local seat", transport: "local", turn_only: false },
    { principal_id: "hosted", name: "Hosted seat", transport: "hosted_mcp", turn_only: true },
  ]);
  assert.deepEqual(agents.map(agent => [agent.transport, agent.turnOnly]), [
    ["local", false],
    ["hosted_mcp", true],
  ]);
  assert.match(dashboard, /Connection: \$\{agent\.transport === "hosted_mcp" \? "Hosted MCP · OAuth connector" : agent\.transport === "local" \? "Local" : "Not reported"/);
  assert.match(peopleView, /"Technical details"[\s\S]*for \(const value of agent\.technical\)/);
  assert.match(dashboard, /"Model", details\.model[\s\S]*"Transport", details\.transport/);
  assert.match(dashboard, /\.select\("principal_id,name,model,transport,turn_only,/);
});

test("agent entity copy reports the transport without guessing from model", () => {
  const hosted = agentEntityView(
    {
      principalId: "hosted",
      name: "Hosted seat",
      model: null,
      transport: "hosted_mcp",
      ownerUserId: "owner",
    },
    undefined,
    "Owner",
    value => value,
  );
  assert.equal(hosted.transport, "Hosted MCP");
  assert.equal(hosted.model, "Model not specified");
});
