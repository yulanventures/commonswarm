import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const REDACTION_MARKERS = ["[REDACTED]", "<redacted>", "REDACTED]", "***"];
const SHELL_BLOCK = /^```sh[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm;
const PYTHON_C = /\bpython3\s+-c(?:\s*\\\r?\n)?\s*'([^']*)'/g;
const PYTHON_HEREDOC =
  /^[^\n]*\bpython3\s+(?!-c(?:\s|\\|$))[^\n]*<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\r?\n([\s\S]*?)^\2[ \t]*\r?$/gm;

interface ShellBlock {
  file: string;
  index: number;
  source: string;
}

function planFiles(): string[] {
  const evidence = readdirSync("docs/evidence", { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join("docs/evidence", entry.name, "BOX-WINDOW.md"))
    .filter(existsSync);
  const design = readdirSync("docs/design", { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => join("docs/design", entry.name));
  return [...evidence, ...design].sort();
}

function extractShellBlocks(file: string, markdown: string): ShellBlock[] {
  return [...markdown.matchAll(SHELL_BLOCK)].map((match, index) => ({
    file,
    index: index + 1,
    source: match[1] ?? "",
  }));
}

function shellBlocks(file: string): ShellBlock[] {
  return extractShellBlocks(file, readFileSync(file, "utf8"));
}

function pythonPrograms(source: string): string[] {
  const commandPrograms = [...source.matchAll(PYTHON_C)]
    .map((match) => match[1] ?? "");
  const heredocPrograms = [...source.matchAll(PYTHON_HEREDOC)]
    .map((match) => match[3] ?? "");
  return [...commandPrograms, ...heredocPrograms];
}

function syntaxSource(source: string): string {
  // Documentation metavariables such as <uuid> are operands, not shell
  // redirections. Quote only those tokens before asking bash to parse the
  // complete block; executable text and redirections remain unchanged.
  return source.replace(/<[A-Za-z][^>\n]*>/g, "'documentation-placeholder'");
}

function checkBlock(block: ShellBlock): string[] {
  const label = `${block.file} sh block ${block.index}`;
  const problems: string[] = [];
  for (const marker of REDACTION_MARKERS) {
    if (block.source.includes(marker)) {
      problems.push(`${label}: contains forbidden marker ${JSON.stringify(marker)}`);
    }
  }

  const rawShell = spawnSync("/bin/bash", ["-n"], {
    encoding: "utf8",
    input: block.source,
  });
  const normalized = syntaxSource(block.source);
  const shell = rawShell.status !== 0 && normalized !== block.source
    ? spawnSync("/bin/bash", ["-n"], { encoding: "utf8", input: normalized })
    : rawShell;
  if (shell.status !== 0) {
    problems.push(`${label}: /bin/bash -n failed: ${shell.stderr.trim()}`);
  }

  for (const [index, program] of pythonPrograms(block.source).entries()) {
    const python = spawnSync(
      "python3",
      ["-c", "import sys; compile(sys.stdin.read(), '<plan-python>', 'exec')"],
      { encoding: "utf8", input: program },
    );
    if (python.status !== 0) {
      problems.push(
        `${label} Python program ${index + 1}: compile failed: ${python.stderr.trim()}`,
      );
    }
  }
  return problems;
}

test("every box-window and design shell block is unredacted and syntax-valid", () => {
  const files = planFiles();
  const blocks = files.flatMap(shellBlocks);
  assert.ok(files.length > 0, "no plan files found");
  assert.ok(blocks.length > 0, "no ```sh plan blocks found");
  assert.deepEqual(blocks.flatMap(checkBlock), []);
});

test("controls reject a redacted block and accept an unredacted compile-only block", () => {
  const [redacted] = extractShellBlocks(
    "positive-control.md",
    "```sh\nvalue=[REDACTED]\n```\n",
  );
  assert.ok(redacted);
  assert.match(checkBlock(redacted).join("\n"), /forbidden marker "\[REDACTED\]"/);

  const [safe] = extractShellBlocks("negative-control.md", `\`\`\`sh
python3 -c 'raise RuntimeError("compile only")'
python3 - <<'PY'
raise RuntimeError("compile only")
PY
\`\`\`
`);
  assert.ok(safe);
  assert.deepEqual(checkBlock(safe), []);
  assert.equal(pythonPrograms(safe.source).length, 2);
});

test("control rejects invalid embedded Python", () => {
  const invalid: ShellBlock = {
    file: "invalid-python-control.md",
    index: 1,
    source: `python3 - <<'PY'
if True print("invalid")
PY
`,
  };
  assert.match(checkBlock(invalid).join("\n"), /Python program 1: compile failed/);
});
