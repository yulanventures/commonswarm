#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import ts from "typescript";

const DEFAULT_INPUTS = ["src", "site/src"];
const NAME_PATTERN = /(TIMEOUT|DEADLINE|BUDGET)/i;

function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function parseArgs(argv) {
  const result = { repo: process.cwd(), ref: null, inputs: [...DEFAULT_INPUTS] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--ref") result.ref = argv[++index];
    else if (arg === "--repo") result.repo = resolve(argv[++index]);
    else if (arg === "--input") result.inputs = argv[++index].split(",").filter(Boolean);
    else if (arg === "--help") {
      process.stdout.write("Usage: node scripts/timeout-table/enumerate.mjs [--repo PATH] [--ref REF] [--input src,site/src]\n");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (result.ref !== null && (!result.ref || result.ref.startsWith("-"))) {
    throw new Error("--ref must name a git revision");
  }
  return result;
}

function sourceFilesFromWorkingTree(repo, inputs) {
  // Use git for the list so generated and dependency trees cannot enter the inventory.
  const output = git(repo, ["ls-files", "--", ...inputs]);
  return output.split("\n").filter(isClientSource);
}

function sourceFilesFromRef(repo, ref, inputs) {
  git(repo, ["rev-parse", "--verify", `${ref}^{commit}`]);
  const output = git(repo, ["ls-tree", "-r", "--name-only", ref, "--", ...inputs]);
  return output.split("\n").filter(isClientSource);
}

function isClientSource(path) {
  return /\.(?:ts|tsx|astro)$/.test(path) &&
    !/(?:^|\/)(?:__tests__|fixtures?)(?:\/|$)/.test(path) &&
    !/\.(?:test|spec|fixture)\.(?:ts|tsx)$/.test(path) &&
    !/\.observer\.test\.(?:ts|tsx)$/.test(path);
}

function readSource(repo, ref, path) {
  return ref === null
    ? readFileSync(resolve(repo, path), "utf8")
    : git(repo, ["show", `${ref}:${path}`]);
}

function numericValue(node, constants, seen = new Set()) {
  if (ts.isNumericLiteral(node)) return Number(node.text.replaceAll("_", ""));
  if (ts.isParenthesizedExpression(node)) return numericValue(node.expression, constants, seen);
  if (ts.isPrefixUnaryExpression(node)) {
    const value = numericValue(node.operand, constants, seen);
    if (value === null) return null;
    if (node.operator === ts.SyntaxKind.MinusToken) return -value;
    if (node.operator === ts.SyntaxKind.PlusToken) return value;
    return null;
  }
  if (ts.isIdentifier(node) && constants.has(node.text) && !seen.has(node.text)) {
    const next = new Set(seen).add(node.text);
    return numericValue(constants.get(node.text), constants, next);
  }
  if (ts.isBinaryExpression(node)) {
    const left = numericValue(node.left, constants, seen);
    const right = numericValue(node.right, constants, seen);
    if (left === null || right === null) return null;
    switch (node.operatorToken.kind) {
      case ts.SyntaxKind.PlusToken: return left + right;
      case ts.SyntaxKind.MinusToken: return left - right;
      case ts.SyntaxKind.AsteriskToken: return left * right;
      case ts.SyntaxKind.SlashToken: return left / right;
      default: return null;
    }
  }
  return null;
}

function directNumericValue(node) {
  return numericValue(node, new Map());
}

function propertyName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text;
  return null;
}

function callName(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return `${callName(expression.expression)}.${expression.name.text}`;
  return "call";
}

function location(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function normalizedValue(raw, name, file, node) {
  if (/(_SECONDS|_SECS|_SEC|_S)$/i.test(name) || name === "connect_timeout") {
    return { value_ms: raw * 1_000, unit_note: "seconds in source; converted to milliseconds" };
  }
  if (name === "timeout" && file.endsWith("src/cloud/agent-receive.ts")) {
    return { value_ms: raw * 1_000, unit_note: "Claude hook timeout is seconds; converted to milliseconds" };
  }
  if (name === "timeout" && file.endsWith("src/cloud/seed.ts")) {
    return { value_ms: raw * 1_000, unit_note: "postgres close timeout is seconds; converted to milliseconds" };
  }
  if (/(_BYTES|_CHARS)$/i.test(name) || /BODY_BUDGET/i.test(name)) {
    return { value_ms: raw, unit_note: "non-time size budget; raw source value retained" };
  }
  if (/(_PER_MINUTE_BUDGET|_CACHE_LIMIT|_PAGE_SIZE)$/i.test(name)) {
    return { value_ms: raw, unit_note: "non-time count budget; raw source value retained" };
  }
  if (name === "timeout" && ts.isPropertyAssignment(node)) {
    return { value_ms: raw, unit_note: "numeric timeout property; milliseconds unless the cited API defines another unit" };
  }
  return { value_ms: raw, unit_note: "milliseconds" };
}

export function enumerateText(file, text) {
  // Astro frontmatter is TypeScript. Replacing the template body with whitespace preserves
  // source line numbers and prevents markup from confusing the TypeScript parser.
  let parseText = text;
  if (file.endsWith(".astro")) {
    const close = text.indexOf("---", text.startsWith("---") ? 3 : 0);
    if (text.startsWith("---") && close >= 0) {
      parseText = `${text.slice(3, close)}${text.slice(close).replace(/[^\n]/g, " ")}`;
    }
  }
  const sourceFile = ts.createSourceFile(file, parseText, ts.ScriptTarget.Latest, true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const constants = new Map();
  const visitConstants = node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      constants.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visitConstants);
  };
  visitConstants(sourceFile);

  const rows = [];
  const add = (node, name, raw, detector) => {
    if (!Number.isFinite(raw) || raw < 0) return;
    const line = location(sourceFile, node);
    rows.push({ id: `${file}:${line}:${name}`, ...normalizedValue(raw, name, file, node), detector });
  };
  const visit = node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer &&
        NAME_PATTERN.test(node.name.text)) {
      const isConst = ts.isVariableDeclarationList(node.parent) &&
        (node.parent.flags & ts.NodeFlags.Const) !== 0;
      const value = isConst ? numericValue(node.initializer, constants) : null;
      if (value !== null) add(node.name, node.name.text, value, "named-constant");
    }
    if (ts.isCallExpression(node)) {
      const name = callName(node.expression);
      const value = node.arguments[0] ? directNumericValue(node.arguments[0]) : null;
      if (name === "AbortSignal.timeout" && value !== null) add(node.expression, name, value, "abort-signal");
      else if ((name === "setTimeout" || name === "setInterval") && value === null && node.arguments[1]) {
        const delay = directNumericValue(node.arguments[1]);
        if (delay !== null) add(node.expression, name, delay, "timer-call");
      } else if ((name === "setTimeout" || name === "setInterval") && value !== null) {
        // Promise timers from node:timers/promises take the delay as argument zero.
        add(node.expression, name, value, "timer-call");
      }
    }
    if (ts.isPropertyAssignment(node)) {
      const name = propertyName(node.name);
      if (name && ["timeoutMs", "timeout", "connect_timeout"].includes(name)) {
        const value = directNumericValue(node.initializer);
        if (value !== null) add(node.name, name, value, "timeout-property");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return rows;
}

export function enumerateRepository({ repo, ref = null, inputs = DEFAULT_INPUTS }) {
  const paths = ref === null
    ? sourceFilesFromWorkingTree(repo, inputs)
    : sourceFilesFromRef(repo, ref, inputs);
  const rows = paths.flatMap(path => enumerateText(path, readSource(repo, ref, path)));
  rows.sort((a, b) => a.id.localeCompare(b.id));
  const ids = new Set();
  for (const row of rows) {
    if (ids.has(row.id)) throw new Error(`Duplicate timeout id: ${row.id}`);
    ids.add(row.id);
  }
  return rows;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const options = parseArgs(process.argv.slice(2));
    // Resolve once to reject a typo before invoking git.
    statSync(options.repo);
    process.stdout.write(`${JSON.stringify(enumerateRepository(options), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
