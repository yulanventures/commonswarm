import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { CORE_TOOL_TABLE, MEMORY_TOOL_TABLE, FILE_GET_IMAGE_MAX_BYTES, FILE_PUT_MAX_BYTES } from "../../supabase/functions/mcp/tools.ts";
import { HOSTED_TODO_LIST_TOOLS } from "../../supabase/functions/_shared/protocol.js";
import { HOSTED_LISTS_NOTE } from "../src/lib/hosted-lists-note.ts";

// The independent contract is the server catalog, checked at the published-file boundary.
// Do not use the documentation formatter to produce the expected inventory or descriptions.
const groups = { core: CORE_TOOL_TABLE, memory: MEMORY_TOOL_TABLE, lists: HOSTED_TODO_LIST_TOOLS };
const decode = text => text.replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&apos;", "'")
  .replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
const visibleText = html => decode(html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const normalize = text => text.replace(/\s+/g, " ").trim();
const noStaleClaims = text => {
  assert.doesNotMatch(text, /Docs and files are not available through (?:the )?(?:hosted )?connector yet/i);
  assert.doesNotMatch(text, /lasts up to 30 days|after a long idle period, setup may need a new credential/i);
};

test("published agent references match the hosted catalog and distinguish workspace Files from Lists & docs", async () => {
  for (const path of ["../public/llms.txt", "../public/skills/cswarm/SKILL.md"]) {
    const text = await readFile(new URL(path, import.meta.url), "utf8");
    for (const [id, tools] of Object.entries(groups)) {
      const block = text.match(new RegExp(`<!-- hosted-tools:${id} -->([\\s\\S]*?)<!-- /hosted-tools:${id} -->`))?.[1];
      assert.ok(block, `${path}: missing ${id} catalog; run node --import tsx site/scripts/sync-hosted-agent-docs.mjs from the repository root`);
      assert.deepEqual(Array.from(block.matchAll(/`([a-z_]+)`/g), ([, name]) => name), tools.map(tool => tool.name), `${path}: stale ${id} catalog`);
    }
    assert.ok(text.includes(HOSTED_LISTS_NOTE), `${path}: scope note drifted from the app`);
    assert.match(text, /both SWARM_BRAIN_MEMORY and SWARM_BRAIN_MEMORY_HOSTED/);
    assert.match(text, /SWARM_MCP_TODOS_LISTS_ENABLED/);
    assert.match(text, /Lists approval and current access/);
    assert.ok(text.includes(`${FILE_GET_IMAGE_MAX_BYTES / (1024 * 1024)} MiB`));
    assert.ok(text.includes(`${FILE_PUT_MAX_BYTES / 1024} KiB`));
    assert.match(text, /local-stdio tools[\s\S]*not hosted connector tools/);
    noStaleClaims(text);
  }
  const skill = await readFile(new URL("../public/skills/cswarm/SKILL.md", import.meta.url), "utf8");
  assert.match(skill, /cswarm channel ls/);
  assert.match(skill, /cswarm channel read/);
  assert.match(skill, /general_unread/);
  assert.match(skill, /including after idle periods/);
});

test("the built guide publishes the server's tool descriptions, effects and arguments, and app copy agrees", async t => {
  let guide;
  try { guide = await readFile(new URL("../dist/guides/claude-connector/index.html", import.meta.url), "utf8"); }
  catch (error) {
    if (error.code === "ENOENT" && !process.env.CI) { t.skip("site build required; CI builds before this suite"); return; }
    throw error;
  }
  const rows = Array.from(guide.matchAll(/<tr\b[^>]*data-hosted-tool="([^"]+)"[^>]*>([\s\S]*?)<\/tr>/g), ([, name, html]) => ({
    name, cells: Array.from(html.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g), ([, cell]) => visibleText(cell)),
  }));
  const tools = Object.values(groups).flat();
  assert.deepEqual(rows.map(row => row.name), tools.map(tool => tool.name));
  for (let i = 0; i < tools.length; i++) {
    const tool = tools[i], { cells } = rows[i];
    assert.equal(cells[1], normalize(tool.description), `${tool.name}: stale description`);
    assert.equal(cells[2], tool.annotations.readOnlyHint ? "Reads" : "Writes", `${tool.name}: wrong effect`);
    const argumentsInGuide = [...new Set(cells[3].match(/[A-Za-z][A-Za-z0-9_]*/g))].filter(word => !["optional", "or", "None"].includes(word));
    assert.deepEqual(argumentsInGuide.sort(), Object.keys(tool.inputSchema.properties ?? {}).sort(), `${tool.name}: argument drift`);
    for (const required of tool.inputSchema.required ?? []) {
      assert.ok(cells[3].split("; optional:")[0].includes(required), `${tool.name}: required ${required} described as optional`);
    }
  }
  assert.match(rows.find(row => row.name === "claim_seat").cells[3], /name or agent_id \+ workspace_id/);
  for (const path of ["../dist/app/index.html", "../dist/guides/claude-connector/index.html", "../dist/guides/claude-code-subagents/index.html"]) {
    const text = visibleText(await readFile(new URL(path, import.meta.url), "utf8"));
    assert.ok(text.includes(HOSTED_LISTS_NOTE), `${path}: shared Lists & docs note is missing`);
    noStaleClaims(text);
  }
});
