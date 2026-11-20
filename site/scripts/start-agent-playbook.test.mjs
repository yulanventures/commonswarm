import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { HOSTED_MCP_RESOURCE } from "../../src/protocol/hosted-authority.ts";
import { AGENT_PLAYBOOK_URL, AGENT_START_PROMPT, INSTALL_CMD, INSTALL_HOST } from "../src/lib/install.ts";

test("start-agent.md playbook stays read-first, accurate, and aligned with SKILL.md and llms.txt", async () => {
  assert.equal(AGENT_PLAYBOOK_URL, `https://${INSTALL_HOST}/start-agent.md`);
  assert.equal(AGENT_START_PROMPT, `Read ${AGENT_PLAYBOOK_URL} and join my workspace`);
  assert.doesNotMatch(AGENT_PLAYBOOK_URL, /<host>/);

  const [playbook, skill, llms] = await Promise.all([
    readFile(new URL("../public/start-agent.md", import.meta.url), "utf8"),
    readFile(new URL("../public/skills/cswarm/SKILL.md", import.meta.url), "utf8"),
    readFile(new URL("../public/llms.txt", import.meta.url), "utf8"),
  ]);

  // Read-first four-step structure in strict order before first write.
  const step1 = playbook.indexOf("## Step 1: Connect");
  const step2 = playbook.indexOf("## Step 2: Verify identity");
  const step3 = playbook.indexOf("## Step 3: Read workspace state");
  const step4 = playbook.indexOf("## Step 4: Summarize and ask the user");
  assert.ok(step1 > 0 && step2 > step1 && step3 > step2 && step4 > step3, "Steps 1-4 must appear in order");
  assert.match(playbook, /Steps 1 through 3 strictly read-only/);
  assert.match(playbook, /wait for their answer before writing/i);

  // Both Hosted MCP and local CLI routes use canonical addresses and shipping commands.
  assert.ok(playbook.includes(HOSTED_MCP_RESOURCE), "playbook must use HOSTED_MCP_RESOURCE");
  assert.ok(playbook.includes(INSTALL_CMD), "playbook must use INSTALL_CMD");
  assert.match(playbook, /npm install -g commonswarm/);
  assert.match(playbook, /cswarm setup --connection-file/);
  assert.match(playbook, /cswarm whoami/);
  assert.match(playbook, /cswarm check/);
  assert.match(playbook, /cswarm conversations/);
  assert.match(playbook, /cswarm conversation read/);
  assert.match(playbook, /cswarm channel ls/);
  assert.match(playbook, /claim_seat/);
  assert.match(playbook, /seat_list/);
  assert.match(playbook, /check_answerable/);

  // Security & truthfulness invariants.
  assert.match(playbook, /0700.*0600|0600.*0700/);
  assert.match(playbook, /untrusted teammate data/i);
  assert.match(playbook, /never auto-created on first post/i);
  assert.doesNotMatch(playbook, /lasts up to 30 days|Docs and files are not available through/i);
  assert.doesNotMatch(playbook, /\u2014/);

  // Cross-links from SKILL.md and llms.txt.
  assert.ok(playbook.includes(`https://${INSTALL_HOST}/skills/cswarm/SKILL.md`));
  assert.ok(playbook.includes(`https://${INSTALL_HOST}/llms.txt`));
  assert.ok(skill.includes(AGENT_PLAYBOOK_URL), "SKILL.md must reference start-agent.md");
  assert.ok(llms.includes(AGENT_PLAYBOOK_URL), "llms.txt must reference start-agent.md");
});

test("built site publishes start-agent.md and embeds the canonical 1-line prompt on /download and /app", async (t) => {
  let distPlaybook;
  let distDownload;
  let distApp;
  try {
    [distPlaybook, distDownload, distApp] = await Promise.all([
      readFile(new URL("../dist/start-agent.md", import.meta.url), "utf8"),
      readFile(new URL("../dist/download/index.html", import.meta.url), "utf8"),
      readFile(new URL("../dist/app/index.html", import.meta.url), "utf8"),
    ]);
  } catch (error) {
    if (error.code === "ENOENT" && !process.env.CI) {
      t.skip("site build required; CI builds before this suite");
      return;
    }
    throw error;
  }

  const publicPlaybook = await readFile(new URL("../public/start-agent.md", import.meta.url), "utf8");
  assert.equal(distPlaybook, publicPlaybook, "built start-agent.md must match site/public/start-agent.md");
  assert.ok(distDownload.includes(AGENT_START_PROMPT), "/download must render AGENT_START_PROMPT");
  assert.ok(distDownload.includes('href="/start-agent.md"'), "/download must link to /start-agent.md");
  assert.ok(distApp.includes(AGENT_START_PROMPT), "Connect screen in /app must render AGENT_START_PROMPT");
  assert.ok(distApp.includes('href="/start-agent.md"'), "Connect screen in /app must link to /start-agent.md");
});
