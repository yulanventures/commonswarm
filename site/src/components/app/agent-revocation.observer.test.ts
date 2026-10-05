import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("agent roster Remove is role-aware and confirms identity end", async () => {
  const source = await readFile(
    new URL("./LiveDashboard.astro", import.meta.url),
    "utf8",
  );
  assert.match(source, /owner_user_id/);
  const view = await readFile(new URL("../../lib/people-dialog-view.ts", import.meta.url), "utf8");
  const connect = await readFile(new URL("../connect/AgentConnect.astro", import.meta.url), "utf8");
  assert.match(source, /me\?\.role === "owner"/);
  assert.match(source, /me\?\.role === "admin"/);
  assert.match(source, /agent\.ownerUserId === me\.userId/);
  assert.match(view, /actionButton\("remove-agent", agent,[^\n]*"data-remove-agent"\)/);
  assert.match(source, /revokeAgentPrincipal\(/);
  assert.match(view, /Its identity and every connection will end/);
  assert.match(connect, /clearPrompt\(notify = true\)\s*\{\s*this\.finishPrompt\("done", notify\)/);
  assert.doesNotMatch(connect, /revokeAgentPrincipal|revoke_agent_principal|revokeAgentToken|revoke_agent_token/);
  assert.match(source, /data-agent-error/);
  assert.match(source, /livePromptPrincipalId/);
});

test("browser helpers keep identity removal distinct from pending-token cancellation", async () => {
  const source = await readFile(
    new URL("../../lib/commonswarm.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /\{ kind: "revoke_agent_principal", principal_id: principalId \}/,
  );
  assert.match(source, /stream: \{ kind: "workspace" \}/);
  assert.match(source, /\{ kind: "revoke_agent_token", token_id: tokenId \}/);
  assert.match(source, /resource: "renewal_grants"/);
  assert.doesNotMatch(source, /\.from\("agent_access_status"\)/);
});

test("Done on connect panel forgets the visible secret without revoking", async () => {
  const source = await readFile(
    new URL("../connect/AgentConnect.astro", import.meta.url),
    "utf8",
  );
  assert.match(source, /data-action="done"/);
  assert.match(source, />\s*Done\s*</);
  assert.match(source, /finishPrompt\("done"\)/);
  assert.doesNotMatch(source, /Clear this prompt/);
  assert.doesNotMatch(source, /revoke_agent_principal/);
  assert.doesNotMatch(source, /revokeAgentPrincipal/);
  assert.doesNotMatch(source, /revoke_agent_token/);
});
