import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";

const EXECUTED = new Set([
  "2026-09-25-item-g-lane2b",
  "2026-09-27-box-g3c-g3d-t3a",
  "2026-09-28-box-hm2",
  "2026-09-28-box-hm4",
  "2026-09-28-box-hm6",
]);
const PLAN_NAMES = ["BOX-WINDOW.md", "SITE-RELEASE.md"];
const SHELL_BLOCK = /^```sh[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm;
const LOOP_READ = /^(\s*)while\s+(?:IFS=\s*)?read\s+(?:(?:-[^\s]+)\s+)*([A-Za-z_][A-Za-z0-9_]*)(.*?)\s*;\s*do\s*$/;
const SINGLE_READ = /^(\s*)(?:IFS=\s*)?read\s+(?:(?:-[^\s]+)\s+)*([A-Za-z_][A-Za-z0-9_]*)(.*)$/;

interface ShellBlock {
  file: string;
  source: string;
  startLine: number;
  step: string;
}

interface ReadStatement {
  block: ShellBlock;
  kind: "single" | "loop";
  line: number;
  text: string;
  variable: string;
  input: string;
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
  return [...plans, "deploy/RELEASE-TO-BOX.md"].sort();
}

function extractBlocks(file: string, markdown: string): ShellBlock[] {
  return [...markdown.matchAll(SHELL_BLOCK)].map((match) => {
    const source = match[1] ?? "";
    const startLine = markdown.slice(0, match.index).split("\n").length + 1;
    const firstLine = source.split(/\r?\n/, 1)[0] ?? "";
    const stepMatch = /^# step:\s*(.+)$/.exec(firstLine);
    assert.ok(stepMatch, `${file}:${startLine}: runnable block does not begin with # step:`);
    return { file, source, startLine, step: stepMatch[1] };
  });
}

function blocksFor(file: string): ShellBlock[] {
  return extractBlocks(file, readFileSync(file, "utf8"));
}

function matchingDoneInput(lines: string[], headerIndex: number, indent: string): string {
  const done = new RegExp(`^${indent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}done(.*)$`);
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const match = done.exec(lines[index] ?? "");
    if (match) return match[1] ?? "";
  }
  return "";
}

function readStatements(block: ShellBlock): ReadStatement[] {
  const lines = block.source.split(/\r?\n/);
  const statements: ReadStatement[] = [];
  for (const [index, text] of lines.entries()) {
    const loop = LOOP_READ.exec(text);
    if (loop) {
      statements.push({
        block,
        kind: "loop",
        line: block.startLine + index,
        text,
        variable: loop[2],
        input: matchingDoneInput(lines, index, loop[1]),
      });
      continue;
    }

    const single = SINGLE_READ.exec(text);
    if (single && /<{1,3}/.test(single[3])) {
      statements.push({
        block,
        kind: "single",
        line: block.startLine + index,
        text,
        variable: single[2],
        input: single[3],
      });
    }
  }
  return statements;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function statementProblem(statement: ReadStatement): string | undefined {
  const variable = escapeRegExp(statement.variable);
  const guard = `\\|\\|\\s*\\[\\s+-n\\s+"\\$${variable}"\\s*\\]`;
  const guarded = statement.kind === "loop"
    ? new RegExp(`^\\s*while\\s+IFS=\\s*read\\b.*\\b${variable}\\s+${guard}\\s*;\\s*do\\s*$`)
    : new RegExp(`^\\s*IFS=\\s*read\\b.*\\b${variable}\\b.*${guard}\\s*$`);
  if (guarded.test(statement.text)) return undefined;
  return `${statement.block.file}:${statement.line} [${statement.block.step}]: ${statement.kind} read for ${statement.variable} lacks || [ -n "$${statement.variable}" ]`;
}

function staticProblems(blocks: ShellBlock[]): string[] {
  return blocks.flatMap(readStatements).map(statementProblem).filter((problem): problem is string => Boolean(problem));
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function replaceSingleInput(statement: ReadStatement, inputFile: string): string {
  const guardAt = statement.text.indexOf("||");
  const command = guardAt === -1 ? statement.text : statement.text.slice(0, guardAt);
  const guard = guardAt === -1 ? "" : ` ${statement.text.slice(guardAt).trimStart()}`;
  const direct = /\s+<\s*(?!<)(?:"[^"]*"|'[^']*'|[^\s;|]+)/;
  const hereString = /\s+<<<[\s\S]*$/;
  const processSubstitution = /\s+<\s*<\([\s\S]*\)$/;
  const replacement = ` <${shellQuote(inputFile)}`;
  if (processSubstitution.test(command)) return command.replace(processSubstitution, replacement) + guard;
  if (hereString.test(command)) return command.replace(hereString, replacement) + guard;
  assert.match(command, direct, `${statement.block.file}:${statement.line}: read has no replaceable input`);
  return command.replace(direct, replacement) + guard;
}

function runSingle(statement: ReadStatement, inputFile: string) {
  const script = [
    "set -euo pipefail",
    `${statement.variable}=''`,
    replaceSingleInput(statement, inputFile),
    `printf '%s' "$${statement.variable}"`,
  ].join("\n");
  return spawnSync("/bin/bash", ["-c", script], { encoding: "utf8" });
}

function runLoop(statement: ReadStatement, inputFile: string) {
  assert.match(statement.input, /</, `${statement.block.file}:${statement.line}: read loop has no input`);
  const script = [
    "set -euo pipefail",
    statement.text,
    `  printf '%s\\n' "$${statement.variable}"`,
    `done <${shellQuote(inputFile)}`,
  ].join("\n");
  return spawnSync("/bin/bash", ["-c", script], { encoding: "utf8" });
}

function assertBehavior(statement: ReadStatement, inputFile: string): void {
  if (statement.kind === "single") {
    const value = "alpha beta\\gamma";
    for (const contents of [`${value}\n`, value]) {
      writeFileSync(inputFile, contents);
      const result = runSingle(statement, inputFile);
      assert.equal(result.status, 0, `${statement.block.file}:${statement.line}: ${result.stderr}`);
      assert.equal(result.stdout, value, `${statement.block.file}:${statement.line}: read changed input`);
    }
    writeFileSync(inputFile, "");
    assert.notEqual(runSingle(statement, inputFile).status, 0, `${statement.block.file}:${statement.line}: empty input passed`);
    return;
  }

  const expected = "alpha\nomega\n";
  for (const contents of ["alpha\nomega\n", "alpha\nomega"]) {
    writeFileSync(inputFile, contents);
    const result = runLoop(statement, inputFile);
    assert.equal(result.status, 0, `${statement.block.file}:${statement.line}: ${result.stderr}`);
    assert.equal(result.stdout, expected, `${statement.block.file}:${statement.line}: loop lost or changed a line`);
  }
}

test("scoped plan reads preserve unterminated input", (t) => {
  const files = scopedFiles();
  const blocks = files.flatMap(blocksFor);
  const statements = blocks.flatMap(readStatements);
  const loops = statements.filter((statement) => statement.kind === "loop");
  const singles = statements.filter((statement) => statement.kind === "single");
  assert.ok(blocks.length > 0, "no runnable shell blocks found");
  assert.ok(statements.length > 0, "no read statements found");
  assert.deepEqual(staticProblems(blocks), []);

  // Whole blocks need the production box, so they are syntax-checked but not
  // executed. Every read statement from every block is executed below.
  for (const block of blocks) {
    const syntax = spawnSync("/bin/bash", ["-n"], { encoding: "utf8", input: block.source });
    assert.equal(syntax.status, 0, `${block.file}:${block.startLine} [${block.step}]: ${syntax.stderr}`);
  }

  const temporary = mkdtempSync(join(tmpdir(), "commonswarm-plan-read-"));
  const inputFile = join(temporary, "input");
  try {
    for (const statement of statements) assertBehavior(statement, inputFile);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  t.diagnostic(`${files.length} files, ${blocks.length} blocks, ${singles.length} single reads, ${loops.length} read loops`);
});

test("negative controls reproduce newline failures and reject the previous plan", () => {
  const temporary = mkdtempSync(join(tmpdir(), "commonswarm-plan-read-control-"));
  const inputFile = join(temporary, "input");
  try {
    writeFileSync(inputFile, "unterminated");
    const single = spawnSync(
      "/bin/bash",
      ["-c", `set -euo pipefail\nIFS= read -r VALUE <${shellQuote(inputFile)}\nprintf '%s' "$VALUE"`],
      { encoding: "utf8" },
    );
    assert.notEqual(single.status, 0, "unguarded single read unexpectedly passed");

    writeFileSync(inputFile, "alpha\nomega");
    const loop = spawnSync(
      "/bin/bash",
      ["-c", `set -euo pipefail\nwhile IFS= read -r VALUE; do\n  printf '%s\\n' "$VALUE"\ndone <${shellQuote(inputFile)}`],
      { encoding: "utf8" },
    );
    assert.equal(loop.status, 0, loop.stderr);
    assert.equal(loop.stdout, "alpha\n", "unguarded loop did not drop the unterminated final line");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }

  const previous = spawnSync(
    "git",
    ["show", "1b1a5549:docs/evidence/2026-09-28-box-hm37/BOX-WINDOW.md"],
    { encoding: "utf8" },
  );
  assert.equal(previous.status, 0, previous.stderr);
  const oldBlock = extractBlocks("previous/BOX-WINDOW.md", previous.stdout)
    .filter((block) => block.step === "hm37-hm6-oauth-precondition");
  assert.equal(oldBlock.length, 1, "previous hm37-hm6-oauth-precondition block not found");
  assert.match(staticProblems(oldBlock).join("\n"), /previous\/BOX-WINDOW\.md:.*hm37-hm6-oauth-precondition/);
});
