import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const EXECUTED = new Set([
  "2026-09-25-item-g-lane2b",
  "2026-09-27-box-g3c-g3d-t3a",
  "2026-09-28-box-hm2",
  "2026-09-28-box-hm4",
  "2026-09-28-box-hm6",
]);
const PLAN_NAMES = ["BOX-WINDOW.md", "SITE-RELEASE.md"];
const FIXED_FILES = [
  "deploy/RELEASE-TO-BOX.md",
  "docs/design/BOX-PLAN-TEMPLATE.md",
];
const SHELL_BLOCK = /^```sh[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm;
const VALID_MARKERS = new Set(["yes", "probe", "no"]);
const WRITE_METHOD = "POST|PUT|PATCH|DELETE";

type Marker = "yes" | "probe" | "no";

interface ShellBlock {
  file: string;
  source: string;
  startLine: number;
  step: string;
  marker: Marker;
}

function scopedFiles(): string[] {
  const evidenceRoot = "docs/evidence";
  for (const directory of EXECUTED) {
    assert.ok(
      existsSync(join(evidenceRoot, directory)),
      `executed-plan exclusion does not exist: ${directory}`,
    );
  }

  const plans = readdirSync(evidenceRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !EXECUTED.has(entry.name))
    .flatMap((entry) => PLAN_NAMES.map((name) => join(evidenceRoot, entry.name, name)))
    .filter(existsSync);
  return [...plans, ...FIXED_FILES].sort();
}

function extractBlocks(file: string, markdown: string): ShellBlock[] {
  const blocks = [...markdown.matchAll(SHELL_BLOCK)].map((match) => {
    const source = match[1] ?? "";
    const startLine = markdown.slice(0, match.index).split("\n").length + 1;
    const lines = source.split(/\r?\n/);
    const stepMatch = /^# step:\s*(.+)$/.exec(lines[0] ?? "");
    assert.ok(stepMatch, `${file}:${startLine}: runnable block does not begin with # step:`);
    const markerMatch = /^# readonly: (yes|probe|no)$/.exec(lines[1] ?? "");
    assert.ok(markerMatch, `${file}:${startLine + 1}: runnable block does not declare # readonly:`);
    return {
      file,
      source,
      startLine,
      step: stepMatch[1],
      marker: markerMatch[1] as Marker,
    };
  });
  const seen = new Set<string>();
  for (const block of blocks) {
    assert.ok(!seen.has(block.step), `${file}:${block.startLine}: duplicate step id ${block.step}`);
    seen.add(block.step);
  }
  return blocks;
}

function blockLabel(block: ShellBlock): string {
  return `${block.file}:${block.startLine} [${block.step}]`;
}

function shellCode(source: string): string {
  return source
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

function writeRequestProblems(block: ShellBlock): string[] {
  if (block.marker !== "yes") return [];
  const source = shellCode(block.source);
  const problems: string[] = [];
  const curlWrite = new RegExp(
    `\\bcurl\\b[\\s\\S]*?(?:-X\\s*(?:${WRITE_METHOD})\\b|--request(?:=|\\s+)(?:${WRITE_METHOD})\\b|(?:^|\\s)(?:-d|--data(?:-[A-Za-z0-9_-]+)?|-F|--form|-T|--upload-file)(?:=|\\s))`,
    "im",
  );
  const methodAssignment = new RegExp(`\\bmethod\\s*=\\s*["'](?:${WRITE_METHOD})["']`, "i");
  const writeCall = new RegExp(
    `\\b(?:probe|request)\\s*\\([\\s\\S]{0,500}?["'](?:${WRITE_METHOD})["']`,
    "i",
  );
  const httpRequest = new RegExp(
    `\\b(?:http\\.)?request\\s*\\(\\s*["'](?:${WRITE_METHOD})["']`,
    "i",
  );
  const dataBody = /\b(?:Request|request)\s*\([\s\S]{0,300}?\bdata\s*=\s*(?!None\b|null\b|undefined\b)[^\s,)]/i;
  if (curlWrite.test(source)) problems.push("curl sends a write-method request or body");
  if (methodAssignment.test(source)) problems.push("HTTP request sets a write method");
  if (writeCall.test(source) || httpRequest.test(source)) problems.push("probe/request call uses a write method");
  if (dataBody.test(source)) problems.push("HTTP request supplies a non-None data body");
  return problems.map((problem) => `${blockLabel(block)}: readonly yes ${problem}`);
}

function allowedVariables(source: string): Set<string> {
  const allowed = new Set<string>();
  for (const match of source.matchAll(/\b[A-Z][A-Z0-9_]*\b/g)) {
    if (match[0].includes("EVIDENCE") || match[0].includes("PROOF")) allowed.add(match[0]);
  }
  for (const match of source.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)=.*\bmktemp\b.*$/gm)) {
    allowed.add(match[1]);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const match of source.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/gm)) {
      const [, name, value] = match;
      if (allowed.has(name)) continue;
      if ([...allowed].some((candidate) => new RegExp(`\\$(?:\\{)?${candidate}(?:\\})?`).test(value))) {
        allowed.add(name);
        changed = true;
      }
    }
  }
  return allowed;
}

function mentionsAllowedPath(text: string, allowed: Set<string>): boolean {
  if (/\/dev\/null\b|\/release-proofs\//.test(text)) return true;
  return [...allowed].some((name) => new RegExp(`\\$\\{?${name}\\}?`).test(text));
}

function shellCommands(source: string): string {
  const lines = source.split(/\r?\n/);
  const kept: string[] = [];
  let delimiter = "";
  for (const line of lines) {
    if (delimiter) {
      if (line === delimiter) delimiter = "";
      continue;
    }
    kept.push(line);
    const heredoc = /<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/.exec(line);
    if (heredoc) delimiter = heredoc[1];
  }
  return kept.join("\n");
}

function mutationProblems(block: ShellBlock): string[] {
  if (block.marker === "no") return [];
  const source = shellCode(block.source);
  const logicalSource = source.replace(/\\\r?\n\s*/g, " ");
  const problems: string[] = [];
  const fixed: Array<[RegExp, string]> = [
    [/\bdocker\s+(?:run|rm|stop|start|restart|kill|create|cp)\b/i, "mutating docker command"],
    [/\bdocker\s+compose\b[^\n]*\b(?:up|down|rm|restart|create)\b/i, "mutating docker compose command"],
    [/\bdocker\s+(?:network\s+(?:connect|disconnect|rm)|volume\s+rm)\b/i, "mutating docker resource command"],
    [/\bsystemctl\s+(?:start|stop|restart|reload|enable|disable|daemon-reload|mask)\b/i, "mutating systemctl command"],
    [/\b(?:[A-Za-z_][A-Za-z0-9_]*_)?psql(?:_[A-Za-z0-9_]+)?\b/i, "psql command"],
    [/\b(?:INSERT\s+INTO|UPDATE\s+[A-Za-z_]|DELETE\s+FROM|MERGE\s+INTO|CREATE\s+(?:TABLE|FUNCTION|TRIGGER|INDEX|SCHEMA|ROLE|VIEW)|ALTER\s+(?:TABLE|FUNCTION|ROLE|SYSTEM)|DROP\s+(?:TABLE|FUNCTION|TRIGGER|INDEX|SCHEMA|ROLE|VIEW)|GRANT\s+|REVOKE\s+|TRUNCATE\s+|COPY\s+[\s\S]{0,160}?\s+FROM\b|SELECT[\s\S]{0,160}?pg_terminate_backend)\b/i, "mutating SQL text"],
    [/\bcaddy\s+(?:reload|stop|start)\b/i, "mutating caddy command"],
    [/\bgit\s+(?:commit|push|checkout|reset|merge(?!-)|tag|clean)\b/i, "mutating git command"],
  ];
  for (const [pattern, description] of fixed) {
    if (pattern.test(logicalSource)) problems.push(description);
  }

  const shell = shellCommands(source).replace(/\\\r?\n\s*/g, " ");
  const allowed = allowedVariables(source);
  const fileCommand = /(?:^\s*|[;|&]\s*)(?:sudo\s+[^\n;|&]+\s+)?(mv|cp|rm|tee|install|ln|chmod|chown|mkdir|touch|truncate)\b([^\n]*)/gm;
  for (const match of shell.matchAll(fileCommand)) {
    const command = `${match[1]}${match[2]}`;
    if (!mentionsAllowedPath(command, allowed)) {
      problems.push(`file command has no evidence/proof or mktemp target: ${match[1]}`);
    }
  }

  for (const line of shell.split(/\r?\n/)) {
    const redirect = /(?:^|\s)(?:\d*)?(?:>>|>)(?!&|=)\s*("[^"]*"|'[^']*'|[^\s;&|]+)/g;
    for (const match of line.matchAll(redirect)) {
      const target = (match[1] ?? "").trim();
      if (target && !mentionsAllowedPath(target, allowed)) {
        problems.push(`redirect has no evidence/proof, mktemp, or /dev/null target: ${target}`);
      }
    }
  }
  return [...new Set(problems)].map((problem) => `${blockLabel(block)}: readonly ${block.marker} contains ${problem}`);
}

function callText(source: string, start: number): string {
  const open = source.indexOf("(", start);
  if (open < 0) return source.slice(start, start + 500);
  let depth = 0;
  let quote = "";
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote && source[index - 1] !== "\\") quote = "";
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === "(") depth += 1;
    else if (character === ")" && --depth === 0) return source.slice(start, index + 1);
  }
  return source.slice(start, start + 500);
}

function probeProblems(block: ShellBlock): string[] {
  if (block.marker !== "probe") return [];
  const source = shellCode(block.source);
  const problems: string[] = [];
  const hasWrite = new RegExp(
    `["'](?:${WRITE_METHOD})["']|(?:-X\\s*|--request(?:=|\\s+))(?:${WRITE_METHOD})\\b|(?:^|\\s)(?:-d|--data(?:-[A-Za-z0-9_-]+)?|-F|--form|-T|--upload-file)(?:=|\\s)`,
    "im",
  ).test(source);
  assert.ok(hasWrite, `${blockLabel(block)}: readonly probe block has no write-method request`);

  const credentialPatterns = [
    /["'](?:Authorization|Cookie)["']\s*:|-H\s+["'](?:Authorization|Cookie):/i,
    /\$(?:\{)?[A-Z0-9_]*(?:TOKEN|PASSWORD|SECRET|CREDENTIAL|API_KEY|ANON_KEY|SERVICE_ROLE_KEY)[A-Z0-9_]*(?:\})?/i,
    /\b[A-Z][A-Z0-9_]*(?:TOKEN|PASSWORD|SECRET|CREDENTIAL|API_KEY|ANON_KEY|SERVICE_ROLE_KEY)[A-Z0-9_]*\b/,
    /\b(?:token|password|secret|credential|api_key|anon_key|service_role_key)\s*=/i,
  ];
  if (credentialPatterns.some((pattern) => pattern.test(source))) {
    problems.push("write probe carries an Authorization/Cookie header or credential variable");
  }

  const explicitCall = new RegExp(
    `\\b(?:probe|request)\\s*\\([\\s\\S]{0,500}?["'](?:${WRITE_METHOD})["']`,
    "gi",
  );
  for (const match of source.matchAll(explicitCall)) {
    const call = callText(source, match.index ?? 0);
    if (/\b2\d\d\b/.test(call) || !/\b(?:4\d\d|503)\b/.test(call)) {
      problems.push(`write probe call lacks a refusal expectation: ${call.replace(/\s+/g, " ").slice(0, 180)}`);
    }
  }

  for (const match of source.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\(([^)]*)\)/gm)) {
    const variable = match[1];
    const methods = [...match[2].matchAll(new RegExp(`["'](${WRITE_METHOD})["']`, "gi"))]
      .map((method) => method[1].toUpperCase());
    if (methods.length === 0) continue;
    const loopVariable = new RegExp(`\\bfor\\s+([A-Za-z_][A-Za-z0-9_]*)\\s+in\\s+${variable}\\s*:`)
      .exec(source)?.[1] ?? variable;
    const dynamicCalls = [...source.matchAll(/\b(?:probe|request)\s*\(/g)]
      .map((call) => callText(source, call.index ?? 0))
      .filter((call) => new RegExp(`\\b${loopVariable}\\b`).test(call));
    if (!dynamicCalls.some((call) => /\b(?:4\d\d|503)\b/.test(call) && !/\b2\d\d\b/.test(call))) {
      for (const method of methods) problems.push(`${method} loop probe lacks a refusal expectation`);
    }
  }

  const directRequest = new RegExp(
    `\\b(?:Request|request)\\s*\\([\\s\\S]{0,300}?(?:method\\s*=\\s*["'](?:${WRITE_METHOD})["']|data\\s*=\\s*(?:b?["']|[\\[{]))`,
    "i",
  );
  if (directRequest.test(source)) {
    if (/\b(?:status|code)\s*(?:==|=)\s*2\d\d\b/.test(source) ||
        !/\b(?:status|code)\s*(?:==|=)\s*(?:4\d\d|503)\b/.test(source)) {
      problems.push("direct urllib/http write request lacks a 4xx or 503 assertion");
    }
  }

  for (const match of source.matchAll(/([A-Za-z_][A-Za-z0-9_]*)="\$\(curl\b[\s\S]*?\)"/g)) {
    const variable = match[1];
    const status = new RegExp(`(?:test|\\[)\\s+"?\\$\\{?${variable}\\}?"?\\s+(?:=|-eq)\\s+"?(?:4\\d\\d|503)"?`);
    if (!status.test(source)) problems.push(`curl write probe does not assert a 4xx or 503 status in ${variable}`);
  }
  if (/\bcurl\b/.test(source) && !/\b(?:4\d\d|503)\b/.test(source)) {
    problems.push("curl write probe has no refusal-status assertion");
  }
  return [...new Set(problems)].map((problem) => `${blockLabel(block)}: ${problem}`);
}

function staticProblems(blocks: ShellBlock[]): string[] {
  return blocks.flatMap((block) => [
    ...writeRequestProblems(block),
    ...mutationProblems(block),
    ...probeProblems(block),
  ]);
}

function synthetic(source: string): ShellBlock[] {
  return extractBlocks("synthetic.md", `\`\`\`sh\n${source}\n\`\`\``);
}

test("runnable plan blocks declare and honor readonly markers", (t) => {
  const files = scopedFiles();
  const blocks = files.flatMap((file) => extractBlocks(file, readFileSync(file, "utf8")));
  assert.ok(blocks.length > 0, "no runnable shell blocks found");
  assert.deepEqual(staticProblems(blocks), []);
  const counts = Object.fromEntries(
    [...VALID_MARKERS].map((marker) => [marker, blocks.filter((block) => block.marker === marker).length]),
  );
  t.diagnostic(`${files.length} files, ${blocks.length} blocks: yes=${counts.yes}, probe=${counts.probe}, no=${counts.no}`);
});

test("marker controls reject unsafe declarations and accept all values", (t) => {
  const failures = [
    ["yes curl POST", `# step: bad-curl\n# readonly: yes\ncurl -X POST https://example.invalid`],
    ["yes docker restart", `# step: bad-docker\n# readonly: yes\ndocker restart example`],
    ["probe expects 200", `# step: bad-status\n# readonly: probe\nrequest("/refuse", "POST", {}, 200)`],
    ["probe has Authorization", `# step: bad-auth\n# readonly: probe\nrequest("/refuse", "POST", {}, 403, headers={"Authorization": "Bearer fake"})`],
  ] as const;
  for (const [name, source] of failures) {
    assert.notDeepEqual(staticProblems(synthetic(source)), [], `${name} unexpectedly passed`);
  }
  assert.throws(
    () => synthetic("# step: no-marker\ntrue"),
    /does not declare # readonly:/,
    "missing marker unexpectedly passed",
  );

  const passes = [
    `# step: good-read\n# readonly: yes\nPROOF_DIR=/tmp/example-proof\nprintf '%s\\n' ok >"$PROOF_DIR/result.txt"`,
    `# step: good-probe\n# readonly: probe\nrequest("/refuse", "POST", {"id": "00000000-0000-4000-8000-000000000000"}, 403)`,
    `# step: good-mutation\n# readonly: no\nsystemctl restart example.service`,
  ];
  for (const source of passes) assert.deepEqual(staticProblems(synthetic(source)), []);
  t.diagnostic("8 controls: 5 expected failures and one passing block for each marker value");
});

// These patterns are a deliberately conservative floor, not proof that a block
// is read-only. Human review of every command and endpoint remains the final check.
