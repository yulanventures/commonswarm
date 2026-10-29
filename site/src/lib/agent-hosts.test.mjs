import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { HOSTED_MCP_RESOURCE } from "../../../src/protocol/hosted-authority.ts";
import {
  AGENT_HOSTS,
  INVITE_CONNECT_FOOTNOTE,
  claudeInstallLink,
  cursorInstallLink,
  inviteConnectFootnote,
} from "./agent-hosts.ts";
import { setupSteps } from "./setup-checklist.ts";

test("the Claude setup step prefills only the public connector name and address", () => {
  const claude = AGENT_HOSTS.find((host) => host.id === "claude");
  const links = claude.steps.filter((step) => step.link).map((step) => step.link);
  assert.equal(links.length, 1);
  assert.equal(links[0].label, "Add to Claude");
  const link = new URL(links[0].href);
  assert.equal(link.origin + link.pathname, "https://claude.ai/customize/connectors");
  assert.deepEqual([...link.searchParams], [
    ["modal", "add-custom-connector"],
    ["connectorName", "CommonSwarm"],
    ["connectorUrl", HOSTED_MCP_RESOURCE],
  ]);
  assert.equal(link.username, "");
  assert.equal(link.password, "");
  assert.equal(link.hash, "");
  // Query delimiters in an address must remain inside the prefilled value.
  const address = "https://example.com/mcp?region=us&name=Home #1";
  const encoded = new URL(claudeInstallLink(address));
  assert.equal(encoded.searchParams.get("connectorUrl"), address);
  assert.equal(encoded.searchParams.size, 3);
  assert.equal(encoded.hash, "");
});

test("the Cursor link decodes to exactly the public address and nothing else", () => {
  const cursor = AGENT_HOSTS.find((host) => host.id === "cursor");
  const links = cursor.steps.filter((step) => step.link).map((step) => step.link);
  assert.equal(links.length, 1);
  assert.equal(links[0].href, cursorInstallLink());
  const link = new URL(links[0].href);
  assert.equal(link.protocol, "cursor:");
  assert.equal(link.searchParams.get("name"), "commonswarm");
  const decoded = JSON.parse(Buffer.from(link.searchParams.get("config") ?? "", "base64").toString("utf8"));
  assert.deepEqual(decoded, { url: HOSTED_MCP_RESOURCE });
});

test("invite footnote, setup checklist, and agent docs reflect verified hosts, dynamic workspace names, and standing permanence", async () => {
  assert.equal(
    INVITE_CONNECT_FOOTNOTE,
    "What it posts to the shared channel is visible to everyone in this workspace. Owners and admins can remove any agent from this workspace.",
  );
  assert.equal(
    inviteConnectFootnote("Road Trip"),
    "What it posts to the shared channel is visible to everyone in Road Trip. Owners and admins can remove any agent from Road Trip.",
  );

  const steps = setupSteps({
    isOwner: true,
    canInvite: true,
    accessConfirmed: true,
    myAgentCount: 0,
    otherMemberCount: 0,
    pendingInviteCount: 0,
  });
  const agentStep = steps.find((step) => step.id === "agent");
  assert.equal(agentStep?.detail, "Connect Claude or a terminal agent in a few steps.");
  assert.doesNotMatch(agentStep?.detail ?? "", /\bMuse\b/);

  const [llms, apiDoc, inviteOnramp, agentConnect, brainView] = await Promise.all([
    readFile(new URL("../../public/llms.txt", import.meta.url), "utf8"),
    readFile(new URL("../../public/api.md", import.meta.url), "utf8"),
    readFile(new URL("../components/invite/InviteOnramp.astro", import.meta.url), "utf8"),
    readFile(new URL("../components/connect/AgentConnect.astro", import.meta.url), "utf8"),
    readFile(new URL("./brain-view.ts", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(llms, /lasts up to 30 days|Permanent CLI\/API connections are not deployed|24 hours, 7 days, or 30 days/);
  assert.match(llms, /Hosted connections stay active until the owner removes them or sets an end date\./);
  assert.doesNotMatch(apiDoc, /non-refreshing\. Default TTL\s+one hour/);
  assert.match(apiDoc, /Standing connections minted in\s+the web app stay active until the owner removes them or sets an end date/);
  assert.match(inviteOnramp, />Step 3 of 3</);
  assert.doesNotMatch(inviteOnramp, />Step 2 of 2</);
  assert.doesNotMatch(agentConnect, /\bseat token\b/i);
  assert.doesNotMatch(brainView, /\bcswarm brain put\b|A brain topic cannot be empty/);
});
