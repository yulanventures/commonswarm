import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

/**
 * One gate for the per-file size limit (25 MiB at the time of writing; this test pins agreement,
 * never the number). The limit is typed separately in the CLI, the web app, the edge function,
 * the storage bucket, the storage service's own environment, and the user-facing copy. Nothing
 * else checks that they agree, so a change to one silently leaves the others enforcing or
 * promising a different size.
 *
 * Numbers are read from their source: TypeScript constants through the compiler API (AST, then a
 * small evaluator that throws on any node it does not understand, so a refactor to an imported
 * constant fails loudly instead of reading NaN), the SQL and env files through anchored patterns.
 * Copy is read from string-literal nodes, so a comment that mentions the old size cannot satisfy
 * or break it.
 *
 * Relations checked:
 *   - every byte source states the same value, and it is a whole number of MiB;
 *   - every "<n> MiB" or "<n> MB" in user-facing copy has n equal to that MiB value (the site and
 *     the CLI print binary units under the label "MB", so the number is what is compared);
 *   - supabase/config.toml's [storage] file_size_limit is a CEILING, not a copy. It is the local
 *     CLI stack's service-wide cap (the `supabase init` default), it defines no bucket, and Storage
 *     applies the smaller of it and the bucket's own limit. It only has to be at least the limit.
 *
 * Computed messages (`${FILE_MAX_VERSION_BYTES / 1024 / 1024} MB` in the edge and the web app,
 * `formatFileSize(FILE_MAX_VERSION_BYTES)` in the CLI) carry no second number, so they agree by
 * construction and are not read here.
 *
 * Each set is enumerated and reconciled (see the inventory tests): a new file that states the
 * limit fails the gate until it is added below. Mutation controls run on copies of the real text
 * in memory; no real file is written.
 *
 * Gate: `npm test` (a literal file list — this path is named in package.json).
 */

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const MIB = 1024 * 1024;

/** Every file that states the limit, keyed by the label used in problem messages. */
const PATHS = {
  cli: "src/cloud/files.ts",
  web: "site/src/lib/commonswarm.ts",
  server: "supabase/functions/command/file-artifacts.ts",
  bucket: "supabase/migrations/20260913000001_file_bucket_size_limit.sql",
  storageEnv: "deploy/supabase-stack/env.example",
  restoreDrill: "deploy/supabase-stack/backup/restore-drill.py",
  localConfig: "supabase/config.toml",
  mcpErrors: "src/mcp/errors.ts",
  mcpServer: "src/mcp/server.ts",
  acceptableUse: "site/src/pages/acceptable-use.astro",
} as const;
type Label = keyof typeof PATHS;
type Texts = Record<Label, string>;

/** The three Storage API variables that carry the service-wide upload cap. */
const STORAGE_ENV_KEYS = ["FILE_SIZE_LIMIT", "UPLOAD_FILE_SIZE_LIMIT", "UPLOAD_FILE_SIZE_LIMIT_STANDARD"] as const;

const SIZE_SOURCE = String.raw`(\d+(?:\.\d+)?)\s?(MiB|MB)\b`;
const PER_VERSION_RE = new RegExp(`${SIZE_SOURCE} per version`);
const ASTRO_FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

class ExtractionError extends Error {
  override name = "ExtractionError";
}

interface ByteValue {
  label: Label;
  what: string;
  bytes: number;
}
interface CopyValue {
  label: Label;
  what: string;
  mib: number;
}
interface Report {
  problems: string[];
  bytes: ByteValue[];
  ceilings: ByteValue[];
  copy: CopyValue[];
  limitBytes: number | undefined;
  limitMib: number | undefined;
}

type StringNode = ts.StringLiteral | ts.NoSubstitutionTemplateLiteral;

function parse(name: string, text: string): ts.SourceFile {
  return ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

function only<T>(items: readonly T[], what: string): T {
  if (items.length !== 1) throw new ExtractionError(`expected exactly one ${what}, found ${items.length}`);
  return items[0]!;
}

function isPlainString(node: ts.Node): node is StringNode {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

/** Evaluates a numeric constant expression; anything it does not recognise is an error, never NaN. */
function evaluate(node: ts.Expression): number {
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (ts.isParenthesizedExpression(node)) return evaluate(node.expression);
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken) return -evaluate(node.operand);
  if (ts.isBinaryExpression(node)) {
    const left = evaluate(node.left);
    const right = evaluate(node.right);
    switch (node.operatorToken.kind) {
      case ts.SyntaxKind.AsteriskToken: return left * right;
      case ts.SyntaxKind.SlashToken: return left / right;
      case ts.SyntaxKind.PlusToken: return left + right;
      case ts.SyntaxKind.MinusToken: return left - right;
      case ts.SyntaxKind.AsteriskAsteriskToken: return left ** right;
      case ts.SyntaxKind.LessThanLessThanToken: return left << right;
    }
  }
  throw new ExtractionError(`cannot evaluate ${ts.SyntaxKind[node.kind]} \`${node.getText()}\` as a number`);
}

function constDeclaration(source: ts.SourceFile, name: string): ts.VariableDeclaration {
  const found: ts.VariableDeclaration[] = [];
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) found.push(declaration);
    }
  }
  return only(found, `top-level const ${name}`);
}

function constInitializer(source: ts.SourceFile, name: string): ts.Expression {
  const initializer = constDeclaration(source, name).initializer;
  if (!initializer) throw new ExtractionError(`const ${name} has no initializer`);
  return initializer;
}

function splice(text: string, start: number, end: number, replacement: string): string {
  return text.slice(0, start) + replacement + text.slice(end);
}

/**
 * Text patterns with three groups (before, value, after) shared by the readers and the mutators,
 * so a mutation edits exactly the span the reader reads. Each must match exactly once.
 */
function bucketPattern(): RegExp {
  return /(UPDATE\s+storage\.buckets\s+SET\s+file_size_limit\s*=\s*)(\d+)(\s+WHERE\s+id\s*=\s*'swarm-files')/g;
}
function envPattern(key: string): RegExp {
  return new RegExp(`(^${key}=)(\\d+)([ \\t]*$)`, "gm");
}
function drillPattern(key: string): RegExp {
  return new RegExp(`('${key}':\\s*')(\\d+)(')`, "g");
}
function onlyMatch(text: string, pattern: RegExp, what: string): RegExpExecArray {
  return only([...text.matchAll(pattern)], what);
}
function replaceValue(text: string, pattern: RegExp, what: string, value: string): string {
  const match = onlyMatch(text, pattern, what);
  return splice(text, match.index, match.index + match[0].length, `${match[1]}${value}${match[3]}`);
}

function readConst(label: Label, text: string, name: string): ByteValue {
  const bytes = evaluate(constInitializer(parse(PATHS[label], text), name));
  return { label, what: name, bytes };
}

function readBucket(text: string): ByteValue {
  const match = onlyMatch(text, bucketPattern(), "`UPDATE storage.buckets SET file_size_limit = <n> WHERE id = 'swarm-files'`");
  return { label: "bucket", what: "swarm-files file_size_limit", bytes: Number(match[2]) };
}

function readKeys(label: Label, text: string, pattern: (key: string) => RegExp): ByteValue[] {
  return STORAGE_ENV_KEYS.map((key) => {
    const match = onlyMatch(text, pattern(key), `${key} assignment`);
    return { label, what: key, bytes: Number(match[2]) };
  });
}

/** The [storage] table's own file_size_limit. Only unambiguous units are accepted; others fail closed. */
function readLocalCeiling(text: string): ByteValue {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === "[storage]");
  if (start === -1) throw new ExtractionError("no [storage] table");
  const table: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*\[/.test(line)) break;
    table.push(line);
  }
  const assignments = table.filter((line) => /^\s*file_size_limit\s*=/.test(line));
  const raw = /^\s*file_size_limit\s*=\s*"([^"]*)"\s*(?:#.*)?$/.exec(only(assignments, "uncommented [storage] file_size_limit"))?.[1];
  const value = raw === undefined ? undefined : /^(\d+)\s*(B|KiB|MiB|GiB)?$/.exec(raw);
  if (!value) throw new ExtractionError(`[storage] file_size_limit ${JSON.stringify(raw)} is not "<n>B|KiB|MiB|GiB"; extend the reader before using another unit`);
  const unit = { B: 1, KiB: 1024, MiB: MIB, GiB: MIB * 1024 }[value[2] ?? "B"]!;
  return { label: "localConfig", what: "[storage] file_size_limit", bytes: Number(value[1]) * unit };
}

interface Located {
  source: ts.SourceFile;
  node: StringNode;
  /** Where the parsed text starts inside the file (non-zero for .astro frontmatter). */
  offset: number;
}

function locateCopy(label: "mcpErrors" | "mcpServer" | "acceptableUse", text: string): Located {
  const nodes: StringNode[] = [];
  if (label === "mcpErrors") {
    const source = parse(PATHS[label], text);
    walk(source, (node) => {
      if (
        ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
        node.name.text === "file_path_invalid" && ts.isCallExpression(node.initializer)
      ) {
        const first = node.initializer.arguments[0];
        if (first && isPlainString(first)) nodes.push(first);
      }
    });
    return { source, node: only(nodes, "file_path_invalid entry with a string message"), offset: 0 };
  }
  if (label === "mcpServer") {
    const source = parse(PATHS[label], text);
    walk(source, (node) => {
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "FilePutPreflightError") {
        const [code, message] = node.arguments ?? [];
        if (code && isPlainString(code) && code.text === "file_too_large" && message && isPlainString(message)) nodes.push(message);
      }
    });
    return { source, node: only(nodes, `FilePutPreflightError("file_too_large", <string>)`), offset: 0 };
  }
  const frontmatter = ASTRO_FRONTMATTER_RE.exec(text);
  if (!frontmatter) throw new ExtractionError("no --- frontmatter fence");
  const source = parse(`${PATHS[label]}.frontmatter.ts`, frontmatter[1]!);
  walk(source, (node) => {
    if (isPlainString(node) && PER_VERSION_RE.test(node.text)) nodes.push(node);
  });
  return { source, node: only(nodes, `string literal saying "<n> MB per version"`), offset: text.indexOf("\n") + 1 };
}

function readCopy(label: "mcpErrors" | "mcpServer" | "acceptableUse", text: string): CopyValue {
  const { node } = locateCopy(label, text);
  const mentions = [...node.text.matchAll(new RegExp(SIZE_SOURCE, "g"))];
  const mention = only(mentions, `"<n> MiB|MB" mention in ${JSON.stringify(node.text.slice(0, 60))}`);
  const excerpt = node.text.length > 48 ? `${node.text.slice(0, 48)}…` : node.text;
  return { label, what: JSON.stringify(excerpt), mib: Number(mention[1]) };
}

function mostCommon(values: readonly number[]): number | undefined {
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best: number | undefined;
  for (const [value, count] of counts) if (best === undefined || count > counts.get(best)!) best = value;
  return best;
}

function checkAgreement(texts: Texts): Report {
  const problems: string[] = [];
  const bytes: ByteValue[] = [];
  const ceilings: ByteValue[] = [];
  const copy: CopyValue[] = [];
  const attempt = (label: Label, read: () => void): void => {
    try {
      read();
    } catch (error) {
      if (!(error instanceof ExtractionError)) throw error;
      problems.push(`${label} (${PATHS[label]}): ${error.message}`);
    }
  };

  attempt("cli", () => bytes.push(readConst("cli", texts.cli, "FILE_MAX_VERSION_BYTES")));
  attempt("web", () => bytes.push(readConst("web", texts.web, "BROWSER_ATTACHMENT_MAX_BYTES")));
  attempt("server", () => bytes.push(readConst("server", texts.server, "FILE_MAX_VERSION_BYTES")));
  attempt("bucket", () => bytes.push(readBucket(texts.bucket)));
  attempt("storageEnv", () => bytes.push(...readKeys("storageEnv", texts.storageEnv, envPattern)));
  attempt("restoreDrill", () => bytes.push(...readKeys("restoreDrill", texts.restoreDrill, drillPattern)));
  attempt("localConfig", () => ceilings.push(readLocalCeiling(texts.localConfig)));
  attempt("mcpErrors", () => copy.push(readCopy("mcpErrors", texts.mcpErrors)));
  attempt("mcpServer", () => copy.push(readCopy("mcpServer", texts.mcpServer)));
  attempt("acceptableUse", () => copy.push(readCopy("acceptableUse", texts.acceptableUse)));

  const limitBytes = mostCommon(bytes.map((value) => value.bytes));
  let limitMib: number | undefined;
  if (limitBytes !== undefined) {
    for (const value of bytes) {
      if (value.bytes !== limitBytes) {
        problems.push(`${value.label} (${PATHS[value.label]}): ${value.what} is ${value.bytes} bytes; the other sources say ${limitBytes}`);
      }
    }
    if (limitBytes % MIB === 0) {
      limitMib = limitBytes / MIB;
    } else {
      problems.push(`the limit ${limitBytes} bytes is not a whole number of MiB, so no "<n> MiB" copy can state it`);
    }
    for (const ceiling of ceilings) {
      if (ceiling.bytes < limitBytes) {
        problems.push(`${ceiling.label} (${PATHS[ceiling.label]}): ${ceiling.what} is ${ceiling.bytes} bytes, below the ${limitBytes}-byte per-file limit it must not cut`);
      }
    }
    for (const value of copy) {
      if (limitMib !== undefined && value.mib !== limitMib) {
        problems.push(`${value.label} (${PATHS[value.label]}): copy ${value.what} says ${value.mib}; the limit is ${limitMib} MiB`);
      }
    }
  }
  return { problems, bytes, ceilings, copy, limitBytes, limitMib };
}

const LABELS = Object.keys(PATHS) as Label[];
const REAL = Object.fromEntries(
  LABELS.map((label) => [label, readFileSync(join(ROOT, PATHS[label]), "utf8")]),
) as Texts;
const REAL_REPORT = checkAgreement(REAL);

/* ------------------------------------------------------------------------------------------- *
 * Inventories: the sets above are enumerated, and a new member fails here until it is added.
 * ------------------------------------------------------------------------------------------- */

function listFiles(dir: string, keep: (repoPath: string) => boolean): string[] {
  const found: string[] = [];
  const visit = (absolute: string): void => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const next = join(absolute, entry.name);
      if (entry.isDirectory()) visit(next);
      else if (entry.isFile()) {
        const repoPath = relative(ROOT, next).split(sep).join("/");
        if (keep(repoPath)) found.push(repoPath);
      }
    }
  };
  visit(join(ROOT, dir));
  return found.sort();
}

function readRepo(repoPath: string): string {
  return readFileSync(join(ROOT, repoPath), "utf8");
}

/** Shipped source that can carry user-facing text; tests, observers and fixtures are not copy. */
function isCopyCandidate(repoPath: string): boolean {
  return /\.(?:ts|tsx|mts|mjs|js|astro)$/.test(repoPath) && !/\.(?:test|observer|fixture)\.|\.d\.ts$/.test(repoPath);
}

/** Paths of files whose string literals (or .astro template text) contain an "<n> MiB|MB" size, once per mention. */
function sizeCopyHits(files: ReadonlyArray<{ path: string; text: string }>): string[] {
  const hits: string[] = [];
  const count = (path: string, text: string): void => {
    hits.push(...Array.from(text.matchAll(new RegExp(SIZE_SOURCE, "g")), () => path));
  };
  for (const file of files) {
    let code = file.text;
    if (file.path.endsWith(".astro")) {
      const frontmatter = ASTRO_FRONTMATTER_RE.exec(file.text);
      code = frontmatter?.[1] ?? "";
      count(file.path, file.text.slice(frontmatter?.[0].length ?? 0).replace(/<!--[\s\S]*?-->/g, ""));
    }
    walk(parse(file.path.endsWith(".astro") ? `${file.path}.ts` : file.path, code), (node) => {
      if (
        ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node) || ts.isJsxText(node)
      ) count(file.path, node.text);
    });
  }
  return hits.sort();
}

const COPY_SITES = [PATHS.acceptableUse, PATHS.mcpErrors, PATHS.mcpServer].sort();

test("the files that state the limit are exactly the enumerated set", () => {
  assert.deepEqual(
    listFiles("supabase", (path) => !path.startsWith("supabase/functions/")).filter((path) => /file_size_limit/i.test(readRepo(path))),
    [PATHS.localConfig, PATHS.bucket].sort(),
    "a new supabase file mentions file_size_limit: add it to PATHS and checkAgreement, or explain why it is not a limit",
  );
  assert.deepEqual(
    listFiles("deploy", () => true).filter((path) => /FILE_SIZE_LIMIT['"]?\s*[=:]/.test(readRepo(path))),
    [PATHS.storageEnv, PATHS.restoreDrill].sort(),
    "a new deploy file assigns FILE_SIZE_LIMIT: add it to PATHS and checkAgreement",
  );
  const copyFiles = [
    ...listFiles("src", isCopyCandidate),
    ...listFiles("site/src", isCopyCandidate),
    ...listFiles("supabase/functions", isCopyCandidate),
  ];
  assert.ok(copyFiles.length > 100, `only ${copyFiles.length} shipped source files scanned; the walk is not reaching the tree`);
  assert.ok(copyFiles.includes(PATHS.mcpServer), "the scan does not reach src/mcp/server.ts");
  assert.ok(copyFiles.includes(PATHS.acceptableUse), "the scan does not reach the acceptable-use page");
  assert.deepEqual(
    sizeCopyHits(copyFiles.map((path) => ({ path, text: readRepo(path) }))),
    COPY_SITES,
    'a shipped file states an "<n> MiB|MB" size that this test does not know: add it to locateCopy, or, if it is another limit, name it here',
  );
});

test("the inventory scan flags a new size string and ignores comments and computed sizes", () => {
  const scan = (path: string, text: string): string[] => sizeCopyHits([{ path, text }]);
  assert.deepEqual(scan("src/new.ts", 'export const m = "Uploads are limited to 30 MB.";'), ["src/new.ts"], "positive control");
  assert.deepEqual(scan("src/new.ts", "export const m = `up to 30 MiB`;"), ["src/new.ts"], "template literal");
  assert.deepEqual(scan("src/new.ts", "// Uploads are limited to 30 MB.\n/* 30 MiB */\nexport const m = 1;"), [], "comments are not copy");
  assert.deepEqual(scan("src/new.ts", "export const m = `${n / 1024 / 1024} MB file limit`;"), [], "computed sizes carry no number");
  assert.deepEqual(scan("site/src/pages/new.astro", "---\nconst a = 1;\n---\n<p>Up to 30 MB.</p>\n"), ["site/src/pages/new.astro"], "astro template text");
  assert.deepEqual(scan("site/src/pages/new.astro", "---\n// 30 MB\nconst a = 1;\n---\n<!-- 30 MB -->\n<p>Hello</p>\n"), [], "astro comments");
});

/* ------------------------------------------------------------------------------------------- *
 * The agreement itself, on the real files.
 * ------------------------------------------------------------------------------------------- */

test("every file-size number and copy string states the same limit", (t) => {
  assert.deepEqual(REAL_REPORT.problems, []);
  assert.ok(REAL_REPORT.limitBytes !== undefined && REAL_REPORT.limitMib !== undefined);
  assert.equal(REAL_REPORT.limitBytes, REAL_REPORT.limitMib * MIB);

  // Reconcile the counts: a reader that silently returned nothing would otherwise pass an empty agreement.
  assert.deepEqual(
    REAL_REPORT.bytes.map((value) => `${value.label}:${value.what}`),
    [
      "cli:FILE_MAX_VERSION_BYTES",
      "web:BROWSER_ATTACHMENT_MAX_BYTES",
      "server:FILE_MAX_VERSION_BYTES",
      "bucket:swarm-files file_size_limit",
      ...STORAGE_ENV_KEYS.map((key) => `storageEnv:${key}`),
      ...STORAGE_ENV_KEYS.map((key) => `restoreDrill:${key}`),
    ],
  );
  assert.deepEqual(REAL_REPORT.ceilings.map((value) => value.label), ["localConfig"]);
  assert.deepEqual(REAL_REPORT.copy.map((value) => value.label), ["mcpErrors", "mcpServer", "acceptableUse"]);
  t.diagnostic(
    `${REAL_REPORT.limitBytes} bytes = ${REAL_REPORT.limitMib} MiB; ${REAL_REPORT.bytes.length} byte sources, ` +
      `${REAL_REPORT.copy.length} copy strings, ceiling ${REAL_REPORT.ceilings[0]!.bytes} bytes`,
  );
});

/* ------------------------------------------------------------------------------------------- *
 * Mutation controls: a copy of one real source with its value changed, in memory.
 * ------------------------------------------------------------------------------------------- */

const mib = (): number => REAL_REPORT.limitMib!;

function replaceConst(label: "cli" | "web" | "server", name: string, expression: (current: number) => string) {
  return (text: string): string => {
    const source = parse(PATHS[label], text);
    const initializer = constDeclaration(source, name).initializer!;
    return splice(text, initializer.getStart(source), initializer.getEnd(), expression(mib()));
  };
}

const constMutations = (label: "cli" | "web" | "server", name: string): Mutation[] => [
  {
    label, name: `${name} changed by one MiB`, expect: "fails",
    apply: replaceConst(label, name, (current) => `${current + 1} * 1024 * 1024`),
  },
  {
    label, name: `${name} changed by one byte`, expect: "fails",
    apply: replaceConst(label, name, (current) => `${current} * 1024 * 1024 + 1`),
  },
  {
    label, name: `${name} refactored to an identifier the evaluator cannot resolve`, expect: "fails",
    apply: replaceConst(label, name, () => "SOME_OTHER_LIMIT"),
  },
  {
    label, name: `${name} declaration renamed`, expect: "fails",
    apply: (text) => {
      const source = parse(PATHS[label], text);
      const identifier = constDeclaration(source, name).name;
      return splice(text, identifier.getStart(source), identifier.getEnd(), "RENAMED_LIMIT");
    },
  },
];

function mutateCopy(label: "mcpErrors" | "mcpServer" | "acceptableUse", edit: "number" | "unit") {
  return (text: string): string => {
    const located = locateCopy(label, text);
    const raw = located.node.getText(located.source);
    const match = onlyMatch(raw, new RegExp(SIZE_SOURCE, "g"), "size mention");
    const literalStart = located.offset + located.node.getStart(located.source);
    if (edit === "number") {
      const start = literalStart + match.index;
      return splice(text, start, start + match[1]!.length, String(mib() + 1));
    }
    const end = literalStart + match.index + match[0].length;
    return splice(text, end - match[2]!.length, end, "KiB");
  };
}

interface Mutation {
  label: Label;
  name: string;
  apply: (text: string) => string;
  /** "fails": the agreement must report problems, all of them naming this label. "passes": still no problems. */
  expect: "fails" | "passes";
}

const MUTATIONS: Mutation[] = [
  ...constMutations("cli", "FILE_MAX_VERSION_BYTES"),
  ...constMutations("web", "BROWSER_ATTACHMENT_MAX_BYTES"),
  ...constMutations("server", "FILE_MAX_VERSION_BYTES"),
  {
    label: "bucket", name: "bucket limit changed by one MiB", expect: "fails",
    apply: (text) => replaceValue(text, bucketPattern(), "bucket UPDATE", String((mib() + 1) * MIB)),
  },
  {
    label: "bucket", name: "UPDATE retargeted at another bucket", expect: "fails",
    apply: (text) => text.replace("id = 'swarm-files'", "id = 'other-files'"),
  },
  ...STORAGE_ENV_KEYS.flatMap((key): Mutation[] => [
    {
      label: "storageEnv", name: `${key} changed by one MiB`, expect: "fails",
      apply: (text) => replaceValue(text, envPattern(key), key, String((mib() + 1) * MIB)),
    },
    {
      label: "restoreDrill", name: `${key} changed by one MiB`, expect: "fails",
      apply: (text) => replaceValue(text, drillPattern(key), key, String((mib() + 1) * MIB)),
    },
  ]),
  {
    label: "storageEnv", name: "one variable removed", expect: "fails",
    apply: (text) => text.replace(/^UPLOAD_FILE_SIZE_LIMIT_STANDARD=.*\n/m, ""),
  },
  {
    label: "localConfig", name: "[storage] ceiling lowered below the limit", expect: "fails",
    apply: (text) => text.replace(/^(file_size_limit\s*=\s*)"[^"]*"/m, `$1"${mib() - 1}MiB"`),
  },
  {
    label: "localConfig", name: "[storage] ceiling in an unsupported unit", expect: "fails",
    apply: (text) => text.replace(/^(file_size_limit\s*=\s*)"[^"]*"/m, `$1"${mib()}MB"`),
  },
  {
    label: "localConfig", name: "[storage] ceiling equal to the limit is accepted", expect: "passes",
    apply: (text) => text.replace(/^(file_size_limit\s*=\s*)"[^"]*"/m, `$1"${mib()}MiB"`),
  },
  {
    label: "localConfig", name: "[storage] ceiling above the limit is accepted", expect: "passes",
    apply: (text) => text.replace(/^(file_size_limit\s*=\s*)"[^"]*"/m, `$1"${mib() * 4}MiB"`),
  },
  ...(["mcpErrors", "mcpServer", "acceptableUse"] as const).flatMap((label): Mutation[] => [
    { label, name: "copy number changed by one", expect: "fails", apply: mutateCopy(label, "number") },
    { label, name: "copy unit changed to KiB", expect: "fails", apply: mutateCopy(label, "unit") },
  ]),
];

test("the real texts pass, so every mutation below starts from a passing agreement", () => {
  assert.deepEqual(checkAgreement(REAL).problems, []);
  assert.deepEqual(
    [...new Set(MUTATIONS.map((mutation) => mutation.label))].sort(),
    [...LABELS].sort(),
    "every source has at least one mutation control",
  );
});

for (const mutation of MUTATIONS) {
  test(`mutation control: ${mutation.label}: ${mutation.name}`, () => {
    const mutated = mutation.apply(REAL[mutation.label]);
    assert.notEqual(mutated, REAL[mutation.label], "the mutation changed nothing, so it proves nothing");
    const { problems } = checkAgreement({ ...REAL, [mutation.label]: mutated });
    if (mutation.expect === "passes") {
      assert.deepEqual(problems, []);
      return;
    }
    assert.ok(problems.length > 0, "the agreement did not notice the change");
    assert.deepEqual(
      problems.filter((problem) => !problem.startsWith(`${mutation.label} (`)),
      [],
      "a problem blames a source that was not changed",
    );
  });
}

for (const label of LABELS) {
  test(`fail-closed control: ${label}: an unreadable source is a problem, not a skip`, () => {
    const { problems } = checkAgreement({ ...REAL, [label]: "" });
    assert.ok(problems.some((problem) => problem.startsWith(`${label} (`)), `no problem names ${label}`);
  });
}
