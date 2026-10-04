import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { HOSTED_MCP_RESOURCE } from "../../../src/protocol/hosted-authority.ts";
import {
  AGENT_CONNECTOR_ADDRESS,
  AGENT_HOSTS,
  AGENT_HOST_STATUS_LABELS,
  agentHostsFor,
  cursorInstallLink,
  joinSentence,
} from "./agent-hosts.ts";

const repoRoot = new URL("../../../", import.meta.url);

test("the connector address is the enforced resource constant, never a retyped URL", () => {
  assert.equal(AGENT_CONNECTOR_ADDRESS, HOSTED_MCP_RESOURCE);
  const source = readFileSync(new URL("./agent-hosts.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /https:\/\/mcp\.commonswarm\.com/u, "agent-hosts.ts must not type the address");
  // Positive control: the catalog does use the address in rendered steps.
  const steps = AGENT_HOSTS.flatMap((host) => [...host.steps, ...(host.testing?.steps ?? [])]);
  assert.ok(steps.some((step) => step.address === true));
  assert.ok(steps.some((step) => (step.code ?? "").includes(HOSTED_MCP_RESOURCE)));
});

test("every status is backed by an existing repository line, and Ready only by a measured pass", () => {
  for (const host of AGENT_HOSTS) {
    const [path, line] = host.evidence.split(":");
    const lines = readFileSync(new URL(path, repoRoot), "utf8").split("\n");
    const cited = lines[Number(line) - 1] ?? "";
    assert.ok(cited.trim().length > 0, `${host.id}: ${host.evidence} does not resolve to a line`);
    if (host.status === "ready") {
      assert.match(cited, /passed|PASS|Measured/u, `${host.id}: Ready needs a measured pass at ${host.evidence}`);
    }
  }
  // Discrimination: only hosts with a measured pass may say Ready today.
  assert.deepEqual(AGENT_HOSTS.filter((host) => host.status === "ready").map((host) => host.id), ["claude"]);
});

test("the waiting label names OpenAI, so only OpenAI hosts may use it", () => {
  assert.match(AGENT_HOST_STATUS_LABELS.waiting, /OpenAI/u);
  for (const host of AGENT_HOSTS.filter((candidate) => candidate.status === "waiting")) {
    assert.equal(host.maker, "OpenAI", `${host.id} cannot say Waiting for OpenAI`);
  }
});

test("people-facing step text has no protocol words or endorsement claims", () => {
  const banned = /\b(seat|grant|claim_seat|claim|ACK|listener|signal|principal|OAuth|partner|certified|endorsed|one-click|wakes up)\b/iu;
  for (const host of AGENT_HOSTS) {
    const steps = [...host.steps, ...(host.testing?.steps ?? [])];
    /* Everything a person reads or copies, including the sentences they say to the agent
       (R2 review: the sweep used to skip `say`). Commands in `code` are for terminals. */
    const visible = [
      host.name,
      host.maker,
      ...host.notes,
      ...steps.map((step) => step.text),
      ...steps.flatMap((step) => (step.say ? [step.say] : [])),
      ...(host.testing ? [host.testing.heading] : []),
    ];
    for (const text of visible) {
      assert.doesNotMatch(text, banned, `${host.id}: "${text}"`);
      /* The joiner's first screen also never names the protocol. */
      if (host.joiner === "primary") assert.doesNotMatch(text, /\bMCP\b/u, `${host.id}: "${text}"`);
    }
  }
  // Controls: the instrument does fire on a protocol word and on the retired Muse draft.
  assert.match("claim a seat", banned);
  assert.match("Create a CommonSwarm custom connector over MCP with OAuth", banned);
});

test("every connector host tells the person to sign in with the same account and say one sentence", () => {
  for (const host of AGENT_HOSTS) {
    if (host.status === null || host.status === "waiting") continue;
    const text = host.steps.map((step) => step.text).join(" ");
    assert.match(text, /same account you use here \(\{email\}\)/u, `${host.id} must name the same account`);
    assert.match(text, /\{workspace\}/u, `${host.id} must name the workspace to tick`);
    assert.ok(host.steps.some((step) => (step.say ?? "").includes("CommonSwarm")), `${host.id} needs the join sentence`);
  }
});

test("the privacy rule is said in plain words for every connector host", async () => {
  const { privacyNote } = await import("./agent-hosts.ts");
  assert.equal(
    privacyNote("Claude"),
    "Every chat in Claude that uses this connection can use it. Keep private chats on a separate account or connection.",
  );
  const picker = readFileSync(new URL("../components/connect/AgentHostPicker.astro", import.meta.url), "utf8");
  assert.match(picker, /privacyNote\(/u, "the host page must render the privacy note");
});

test("only the page that watches the roster shows a live waiting line", () => {
  /* /app polls the roster while a host page is open; /invite does not, so a pulse there would
     never resolve. The joiner gets a static sentence instead. */
  const picker = readFileSync(new URL("../components/connect/AgentHostPicker.astro", import.meta.url), "utf8");
  assert.match(picker, /audience === "setter" && \(\s*<p class="ahp__waiting" data-ahp-waiting/u);
  assert.match(picker, /audience === "joiner" && \(\s*<p class="ahp__waiting">\s*When \{host\.name\} has joined/u);
});

test("the join sentence names the agent and CommonSwarm", () => {
  assert.equal(joinSentence("Muse"), "Use CommonSwarm to join my workspace as Muse, then list who is there.");
});

test("the Cursor link decodes to exactly the public address and nothing else", () => {
  const link = new URL(cursorInstallLink());
  assert.equal(link.protocol, "cursor:");
  assert.equal(link.searchParams.get("name"), "commonswarm");
  const decoded = JSON.parse(Buffer.from(link.searchParams.get("config") ?? "", "base64").toString("utf8"));
  assert.deepEqual(decoded, { url: HOSTED_MCP_RESOURCE });
  // The documented link for today's address (docs/integrations/cursor/README.md on main).
  assert.equal(
    cursorInstallLink("https://mcp.commonswarm.com/mcp"),
    "cursor://anysphere.cursor-deeplink/mcp/install?name=commonswarm&config=eyJ1cmwiOiJodHRwczovL21jcC5jb21tb25zd2FybS5jb20vbWNwIn0%3D",
  );
});

test("the joiner never sees the key flow, and her first screen is chat apps", () => {
  const joiner = agentHostsFor("joiner");
  assert.ok(!joiner.some((host) => host.id === "terminal"));
  for (const host of joiner.filter((candidate) => candidate.joiner === "primary")) {
    assert.equal(host.group, "chat", `${host.id} is primary for the joiner but not a chat app`);
    for (const step of host.steps) {
      assert.equal(step.code, undefined, `${host.id}: the joiner's primary hosts must not ask for a command`);
    }
  }
  // Control: the setter does get the terminal flow.
  assert.ok(agentHostsFor("setter").some((host) => host.id === "terminal"));
});
