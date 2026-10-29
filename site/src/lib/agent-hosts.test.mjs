import assert from "node:assert/strict";
import { test } from "node:test";

import { HOSTED_MCP_RESOURCE } from "../../../src/protocol/hosted-authority.ts";
import {
  AGENT_HOSTS,
  claudeInstallLink,
  cursorInstallLink,
} from "./agent-hosts.ts";

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
