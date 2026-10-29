import assert from "node:assert/strict";
import { test } from "node:test";
import { dashboardAgentFilePrompt, dashboardMcpPrompt} from "./agent-prompt";

const TOKEN = `swm_agt_${"A_".repeat(21) + "A"}`;
const INPUT = {
  credential: {
    principalId: "11111111-1111-4111-8111-111111111111", principalName: "Observer",
    tokenId: "22222222-2222-4222-8222-222222222222", runId: "33333333-3333-4333-8333-333333333333",
    token: TOKEN, expiresAt: Date.parse("2099-07-29T23:00:00Z"), renews: true,
    horizonExpiresAt: null, grantKind: "standing" as const,
  },
  workspaceId: "44444444-4444-4444-8444-444444444444", workspaceName: "Observer room",
  deploymentUrl: "https://example.supabase.co", anonKey: "TEST_ONLY_PUBLIC_KEY",
};

test("MCP handoff contains only operator terminal steps; legacy prompt discloses its secret path", { timeout: 10000 }, () => {
  const mcp = dashboardMcpPrompt();
  assert.match(mcp, /cswarm mcp code/);
  assert.match(mcp, /cswarm mcp connect --url/);
  assert.doesNotMatch(mcp, /swm_join_|swm_agt_|CSWARMA\./);
});

test("file handoff stays short without hiding a manual fetch", () => {
  const prompt = dashboardAgentFilePrompt(INPUT);
  assert.equal(prompt.includes(TOKEN), false);
  assert.equal(prompt.includes(INPUT.anonKey), false);
  assert.match(prompt, /attached connection JSON/);
});
