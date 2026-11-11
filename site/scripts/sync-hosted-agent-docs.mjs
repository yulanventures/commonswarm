import { readFile, writeFile } from "node:fs/promises";
import { hostedAgentReference } from "../src/lib/hosted-mcp-reference.ts";

const start = "<!-- BEGIN HOSTED AGENT REFERENCE -->";
const end = "<!-- END HOSTED AGENT REFERENCE -->";
for (const path of ["../public/llms.txt", "../public/skills/cswarm/SKILL.md"]) {
  const url = new URL(path, import.meta.url);
  const text = await readFile(url, "utf8");
  const from = text.indexOf(start), to = text.indexOf(end);
  if (from < 0 || to < from || text.indexOf(start, from + start.length) >= 0) throw new Error(`Missing or duplicate reference markers: ${path}`);
  await writeFile(url, text.slice(0, from) + start + "\n" + hostedAgentReference() + "\n" + text.slice(to));
}
