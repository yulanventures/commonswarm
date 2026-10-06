import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import ts from "typescript";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const functionsRoot = resolve(repoRoot, "supabase/functions");
const SKIP_FUNCTION_DIRS = new Set(["_shared"]);
const RELATIVE_EXTENSIONS = ["", ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".d.ts"];
const INDEX_FILES = ["index.ts", "index.tsx", "index.js", "index.mjs", "index.d.ts"];
const PARSEABLE = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

interface UnmappedBare {
  specifier: string;
  from: string;
}

interface FunctionGraph {
  name: string;
  unmapped: UnmappedBare[];
}

function posixRel(from: string, to: string): string {
  return relative(from, to).split(sep).join("/");
}

function isBareSpecifier(specifier: string): boolean {
  if (specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/")) {
    return false;
  }
  return !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(specifier);
}

function functionDirectories(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !SKIP_FUNCTION_DIRS.has(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function importMapFromDenoConfig(configPath: string): Record<string, string> {
  const config = readJson(configPath);
  const inline = config.imports;
  if (inline && typeof inline === "object" && !Array.isArray(inline)) {
    return Object.fromEntries(
      Object.entries(inline).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  }
  const importMap = config.importMap;
  if (typeof importMap !== "string") return {};
  const mappedPath = resolve(dirname(configPath), importMap);
  const mapped = readJson(mappedPath);
  const imports = mapped.imports;
  if (!imports || typeof imports !== "object" || Array.isArray(imports)) return {};
  return Object.fromEntries(
    Object.entries(imports).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function mapsBareSpecifier(imports: Record<string, string>, specifier: string): boolean {
  if (Object.hasOwn(imports, specifier)) return true;
  return Object.keys(imports).some((key) => key.endsWith("/") && specifier.startsWith(key));
}

function resolveRelative(fromFile: string, specifier: string): string | undefined {
  const raw = resolve(dirname(fromFile), specifier);
  for (const extension of RELATIVE_EXTENSIONS) {
    const candidate = `${raw}${extension}`;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  if (existsSync(raw) && statSync(raw).isDirectory()) {
    for (const indexFile of INDEX_FILES) {
      const candidate = join(raw, indexFile);
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
  }
  return undefined;
}

function scriptKindFor(path: string): ts.ScriptKind {
  switch (extname(path)) {
    case ".tsx":
      return ts.ScriptKind.TSX;
    case ".jsx":
      return ts.ScriptKind.JSX;
    case ".js":
    case ".mjs":
    case ".cjs":
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}

function staticSpecifiers(path: string): string[] {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(path),
  );
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier
      && ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}

function analyzeFunction(root: string, name: string): FunctionGraph {
  const functionDir = resolve(root, name);
  const entry = resolve(functionDir, "index.ts");
  const configPath = resolve(functionDir, "deno.json");
  const imports = existsSync(configPath) ? importMapFromDenoConfig(configPath) : {};
  const unmapped: UnmappedBare[] = [];
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    if (!PARSEABLE.has(extname(current)) && !current.endsWith(".d.ts")) continue;
    for (const specifier of staticSpecifiers(current)) {
      if (isBareSpecifier(specifier)) {
        if (!mapsBareSpecifier(imports, specifier)) {
          unmapped.push({ specifier, from: posixRel(root, current) });
        }
        continue;
      }
      if (!specifier.startsWith("./") && !specifier.startsWith("../")) continue;
      const next = resolveRelative(current, specifier);
      if (next !== undefined) queue.push(next);
    }
  }
  return { name, unmapped };
}

test("every edge function maps the bare specifiers its static import graph reaches", () => {
  const names = functionDirectories(functionsRoot);
  assert.ok(names.includes("admin"));
  const failures = names.flatMap((name) => {
    const graph = analyzeFunction(functionsRoot, name);
    return graph.unmapped.map(
      (item) => `${graph.name}: unmapped ${JSON.stringify(item.specifier)} from ${item.from}`,
    );
  });
  assert.deepEqual(failures, []);
});

test("a function without its own map fails when a relative import reaches a bare specifier", (t) => {
  const temporaryRoot = realpathSync(tmpdir());
  const directory = realpathSync(mkdtempSync(join(temporaryRoot, "edge-fn-import-map.")));
  t.after(() => {
    const cleanup = spawnSync("rm", ["-rf", "--", directory], { encoding: "utf8" });
    assert.equal(cleanup.status, 0, `guarded cleanup refused ${directory}: ${cleanup.stderr}`);
  });
  const root = join(directory, "functions");
  mkdirSync(join(root, "probe"), { recursive: true });
  mkdirSync(join(root, "command"), { recursive: true });
  writeFileSync(join(root, "probe", "index.ts"), 'export { sql } from "../command/index.ts";\n');
  writeFileSync(join(root, "command", "index.ts"), 'import type postgres from "postgres";\nexport const sql = null as unknown as postgres.Sql;\n');
  const graph = analyzeFunction(root, "probe");
  assert.deepEqual(graph.unmapped, [{ specifier: "postgres", from: "command/index.ts" }]);
});
