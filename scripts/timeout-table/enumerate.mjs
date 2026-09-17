#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { posix, resolve } from "node:path";
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

function numericValue(node, constants, importedValues = new Map(), seen = new Set()) {
  if (ts.isNumericLiteral(node)) return Number(node.text.replaceAll("_", ""));
  if (ts.isParenthesizedExpression(node)) {
    return numericValue(node.expression, constants, importedValues, seen);
  }
  if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node)) {
    return numericValue(node.expression, constants, importedValues, seen);
  }
  if (ts.isPrefixUnaryExpression(node)) {
    const value = numericValue(node.operand, constants, importedValues, seen);
    if (value === null) return null;
    if (node.operator === ts.SyntaxKind.MinusToken) return -value;
    if (node.operator === ts.SyntaxKind.PlusToken) return value;
    return null;
  }
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
    const key = `${node.expression.text}.${node.name.text}`;
    if (importedValues.has(key) && !seen.has(key)) return importedValues.get(key);
  }
  if (ts.isIdentifier(node) && !seen.has(node.text)) {
    if (importedValues.has(node.text)) return importedValues.get(node.text);
    if (constants.has(node.text)) {
      const next = new Set(seen).add(node.text);
      return numericValue(constants.get(node.text), constants, importedValues, next);
    }
  }
  if (ts.isBinaryExpression(node)) {
    if (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
      const left = numericValue(node.left, constants, importedValues, seen);
      if (left !== null) return left;
      return numericValue(node.right, constants, importedValues, seen);
    }
    const left = numericValue(node.left, constants, importedValues, seen);
    const right = numericValue(node.right, constants, importedValues, seen);
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

function timeoutBindingName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text;
  return null;
}

function isTimeoutBindingName(name) {
  return name === "timeoutMs" || name === "timeout" || name === "connect_timeout" ||
    (name !== null && NAME_PATTERN.test(name));
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
  if (/(_BYTES|_CHARS)$/i.test(name) || /BODY_BUDGET/i.test(name) || /bytes$/i.test(name)) {
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

function parseSource(file, text) {
  // Astro frontmatter is TypeScript. Replacing the template body with whitespace preserves
  // source line numbers and prevents markup from confusing the TypeScript parser.
  let parseText = text;
  if (file.endsWith(".astro")) {
    const close = text.indexOf("---", text.startsWith("---") ? 3 : 0);
    if (text.startsWith("---") && close >= 0) {
      parseText = `${text.slice(3, close)}${text.slice(close).replace(/[^\n]/g, " ")}`;
    }
  }
  return ts.createSourceFile(file, parseText, ts.ScriptTarget.Latest, true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

function addVariableDeclarations(statement, constants) {
  if (!ts.isVariableStatement(statement)) return;
  for (const node of statement.declarationList.declarations) {
    if (ts.isIdentifier(node.name) && node.initializer && !constants.has(node.name.text)) {
      constants.set(node.name.text, node.initializer);
    }
  }
}

function localConstantInitializers(sourceFile) {
  const constants = new Map();
  // Module-level bindings first so a later function-local of the same name
  // cannot overwrite a timeout constant used at the top level.
  for (const stmt of sourceFile.statements) {
    addVariableDeclarations(stmt, constants);
    if (ts.isModuleDeclaration(stmt) && stmt.body && ts.isModuleBlock(stmt.body)) {
      for (const inner of stmt.body.statements) addVariableDeclarations(inner, constants);
    }
  }
  const visitNested = node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer &&
        !constants.has(node.name.text)) {
      constants.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visitNested);
  };
  visitNested(sourceFile);
  return constants;
}

function localNumericConsts(sourceFile, importedValues) {
  const constants = localConstantInitializers(sourceFile);
  const values = new Map();
  for (const [name, initializer] of constants) {
    const value = numericValue(initializer, constants, importedValues);
    if (value !== null) values.set(name, value);
  }
  return values;
}

function resolveImportedFile(fromFile, specifier, fileSet) {
  if (typeof specifier !== "string" || !specifier.startsWith(".")) return null;
  const joined = posix.normalize(posix.join(posix.dirname(fromFile), specifier));
  const withoutExt = joined.replace(/\.(?:js|mjs|cjs|ts|tsx|astro)$/, "");
  const candidates = [joined, `${withoutExt}.ts`, `${withoutExt}.tsx`, `${withoutExt}.astro`];
  for (const candidate of candidates) {
    if (fileSet.has(candidate)) return candidate;
  }
  return null;
}

function importedValuesForFile(sourceFile, fromFile, exportValues, fileSet) {
  const out = new Map();
  const takeExport = (target, exportedName, localName) => {
    const value = exportValues.get(`${target}:${exportedName}`);
    if (typeof value === "number") out.set(localName, value);
  };
  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt) || !stmt.importClause || stmt.importClause.isTypeOnly) continue;
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const target = resolveImportedFile(fromFile, stmt.moduleSpecifier.text, fileSet);
    if (!target) continue;
    if (stmt.importClause.name) takeExport(target, "default", stmt.importClause.name.text);
    const named = stmt.importClause.namedBindings;
    if (!named) continue;
    if (ts.isNamespaceImport(named)) {
      const ns = named.name.text;
      const prefix = `${target}:`;
      for (const [key, value] of exportValues) {
        if (typeof value === "number" && key.startsWith(prefix)) {
          out.set(`${ns}.${key.slice(prefix.length)}`, value);
        }
      }
      continue;
    }
    if (!ts.isNamedImports(named)) continue;
    for (const element of named.elements) {
      if (element.isTypeOnly) continue;
      takeExport(target, (element.propertyName ?? element.name).text, element.name.text);
    }
  }
  return out;
}

export function enumerateText(file, text, options = {}) {
  const sourceFile = parseSource(file, text);
  const importedValues = options.importedValues instanceof Map ? options.importedValues : new Map();
  const constants = localConstantInitializers(sourceFile);
  const rows = [];
  const seen = new Map();
  const add = (node, name, raw) => {
    if (!Number.isFinite(raw) || raw < 0) return;
    const line = location(sourceFile, node);
    const key = `${file}:${name}`;
    const occurrence = (seen.get(key) ?? 0) + 1;
    seen.set(key, occurrence);
    // Line is report data only. A pure line shift must not change the id.
    const id = occurrence === 1 ? key : `${key}#${occurrence}`;
    rows.push({ id, file, name, line, ...normalizedValue(raw, name, file, node) });
  };
  const valueOf = node => numericValue(node, constants, importedValues);
  const visit = node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer &&
        NAME_PATTERN.test(node.name.text)) {
      const isConst = ts.isVariableDeclarationList(node.parent) &&
        (node.parent.flags & ts.NodeFlags.Const) !== 0;
      const value = isConst ? valueOf(node.initializer) : null;
      if (value !== null) add(node.name, node.name.text, value);
    }
    if (ts.isParameter(node) && node.initializer) {
      const name = timeoutBindingName(node.name);
      if (isTimeoutBindingName(name)) {
        const value = valueOf(node.initializer);
        if (value !== null) add(node.name, name, value);
      }
    }
    if (ts.isBindingElement(node) && node.initializer) {
      const name = timeoutBindingName(node.name);
      if (isTimeoutBindingName(name)) {
        const value = valueOf(node.initializer);
        if (value !== null) add(node.name, name, value);
      }
    }
    if (ts.isCallExpression(node)) {
      const name = callName(node.expression);
      const first = node.arguments[0] ? valueOf(node.arguments[0]) : null;
      if (name === "AbortSignal.timeout" && first !== null) add(node.expression, name, first);
      else if ((name === "setTimeout" || name === "setInterval") && first === null && node.arguments[1]) {
        const delay = valueOf(node.arguments[1]);
        if (delay !== null) add(node.expression, name, delay);
      } else if ((name === "setTimeout" || name === "setInterval") && first !== null) {
        // Promise timers from node:timers/promises take the delay as argument zero.
        add(node.expression, name, first);
      }
    }
    if (ts.isPropertyAssignment(node)) {
      const name = timeoutBindingName(node.name);
      if (isTimeoutBindingName(name)) {
        const value = valueOf(node.initializer);
        if (value !== null) add(node.name, name, value);
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
  const fileSet = new Set(paths);
  const parsed = paths.map(path => {
    const text = readSource(repo, ref, path);
    return { path, text, sourceFile: parseSource(path, text) };
  });
  let exportValues = new Map();
  let importedByFile = new Map();
  for (let round = 0; round < 5; round += 1) {
    const nextExports = new Map();
    const nextImported = new Map();
    for (const file of parsed) {
      const imported = importedValuesForFile(file.sourceFile, file.path, exportValues, fileSet);
      nextImported.set(file.path, imported);
      for (const [name, value] of localNumericConsts(file.sourceFile, imported)) {
        nextExports.set(`${file.path}:${name}`, value);
      }
      for (const stmt of file.sourceFile.statements) {
        if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
          const value = numericValue(stmt.expression, localConstantInitializers(file.sourceFile), imported);
          if (value !== null) nextExports.set(`${file.path}:default`, value);
        }
        if (!ts.isExportDeclaration(stmt) || !stmt.exportClause || !ts.isNamedExports(stmt.exportClause)) continue;
        const fromFile = stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)
          ? resolveImportedFile(file.path, stmt.moduleSpecifier.text, fileSet)
          : null;
        for (const element of stmt.exportClause.elements) {
          if (element.isTypeOnly) continue;
          const exportedName = element.name.text;
          const sourceName = (element.propertyName ?? element.name).text;
          const value = fromFile
            ? exportValues.get(`${fromFile}:${sourceName}`)
            : (imported.get(sourceName) ?? nextExports.get(`${file.path}:${sourceName}`));
          if (typeof value === "number") nextExports.set(`${file.path}:${exportedName}`, value);
        }
      }
    }
    exportValues = nextExports;
    importedByFile = nextImported;
  }
  const rows = parsed.flatMap(file =>
    enumerateText(file.path, file.text, { importedValues: importedByFile.get(file.path) }));
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
