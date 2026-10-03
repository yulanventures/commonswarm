import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { planShellWords } from "./support/plan-shell-words.js";

const REDACTION_MARKERS = ["[REDACTED]", "<redacted>", "REDACTED]", "***"];
const SHELL_BLOCK = /^```sh[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm;
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
  const reusable = [
    "docs/evidence/2026-10-02-mcp-auth-release/RELEASE.md",
    "docs/evidence/2026-10-02-edge-mcp-release/RELEASE.md",
    "docs/evidence/2026-10-02-site-release/SITE-RELEASE.md",
    "docs/evidence/2026-10-02-dcr-release/RELEASE-V2.md",
  ];
  return [...evidence, ...design, ...reusable].sort();
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
  const heredocPrograms = [...source.matchAll(PYTHON_HEREDOC)]
    .map((match) => match[3] ?? "");
  // Heredoc bodies are stdin, not shell words. Decode each SSH command argv
  // before inspecting its next quoting layer; raw regexes see escaped quotes
  // or stop at the first segment of a concatenated single-quoted word.
  const outer = source.replace(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n[\s\S]*?^\2[ \t]*$/gm, "");
  const commandPrograms: string[] = [];
  const inspect = (text: string, depth = 0): void => {
    assert.ok(depth < 8, "too many nested shell quoting layers");
    const words = planShellWords(text);
    for (let index = 0; index < words.length; index++) {
      if (words[index] === "python3" && words[index + 1] === "-c") {
        assert.ok(words[index + 2], "python3 -c has no program");
        commandPrograms.push(words[index + 2]!);
        index += 2;
      } else if (/\bpython3\s+-c\b/.test(words[index]!)) inspect(words[index]!, depth + 1);
    }
  };
  inspect(outer);
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
  for (const command of [
    String.raw`ssh ops@example.invalid "python3 -c 'raise RuntimeError(\"compile only\")'"`,
    String.raw`ssh ops@example.invalid 'python3 -c '\''raise RuntimeError("compile only")'\'''`,
  ]) {
    const safe = { ...invalid, source: command };
    assert.equal(pythonPrograms(command).length, 1, "nested SSH program must be inspected");
    assert.deepEqual(checkBlock(safe), [], "inspection must compile without executing Python or SSH");
    const broken = { ...invalid, source: command.replace("raise RuntimeError", "if True print") };
    assert.match(checkBlock(broken).join("\n"), /Python program 1: compile failed/);
  }
});
