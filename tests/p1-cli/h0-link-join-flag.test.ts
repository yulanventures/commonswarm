import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import ts from "typescript";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const flagFile = "site/src/lib/h0-link-join-flag.ts";
const flagName = "PUBLIC_H0_LINK_JOIN";

// Parse code rather than mentions: env lists, comments, and documentation do not read a flag.
function flagReads(path: string, source: string): number {
  const code = path.endsWith(".astro")
    ? [source.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "",
      ...Array.from(source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g), (match) => match[1]!)].join("\n")
    : source;
  const file = ts.createSourceFile(path, code, ts.ScriptTarget.Latest, true);
  let reads = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const name = ts.isPropertyAccessExpression(node) ? node.name.text
        : ts.isStringLiteral(node.argumentExpression) ? node.argumentExpression.text : undefined;
      if (name === flagName && /^(?:import\.meta|process)\.env$/.test(node.expression.getText(file))) reads += 1;
    }
    if (ts.isCallExpression(node) && node.expression.getText(file) === "Deno.env.get" &&
        node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === flagName) reads += 1;
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer &&
        /^(?:import\.meta|process)\.env$/.test(node.initializer.getText(file))) {
      for (const binding of node.name.elements) {
        const name = binding.propertyName ?? binding.name;
        if ((ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === flagName) reads += 1;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return reads;
}

function flagReaders(root: string): Array<{ file: string; reads: number }> {
  const readers: Array<{ file: string; reads: number }> = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!["node_modules", "dist", ".git", "tests", "__tests__"].includes(entry.name)) walk(path);
      } else if (/\.(?:[cm]?[jt]sx?|astro)$/.test(entry.name) && !/\.(?:test|spec|observer)\./.test(entry.name)) {
        const reads = flagReads(path, readFileSync(path, "utf8"));
        if (reads > 0) readers.push({ file: relative(root, path), reads });
      }
    }
  };
  for (const directory of ["site/src", "src", "supabase/functions"]) walk(join(root, directory));
  return readers.sort((a, b) => a.file.localeCompare(b.file));
}

function assertSingleFlagReader(root: string): void {
  assert.deepEqual(flagReaders(root), [{ file: flagFile, reads: 1 }]);
}

test("PUBLIC_H0_LINK_JOIN is read in one source file", () => {
  assertSingleFlagReader(repoRoot);
});

test("the flag guard ignores env-list fixtures and rejects a second source reader", () => {
  const root = mkdtempSync("/private/tmp/commonswarm-flag-guard-");
  try {
    for (const directory of ["site/src/lib", "src", "supabase/functions", "tests"]) mkdirSync(join(root, directory), { recursive: true });
    writeFileSync(join(root, flagFile), readFileSync(join(repoRoot, flagFile), "utf8"));
    writeFileSync(join(root, "tests/box-dry-run.test.ts"), 'const environment = ["PUBLIC_H0_LINK_JOIN=1"];\n');
    writeFileSync(join(root, "site/src/lib/fixture.test.ts"), 'const fixture = import.meta.env.PUBLIC_H0_LINK_JOIN;\n');
    writeFileSync(join(root, "src/env-list.ts"), '// PUBLIC_H0_LINK_JOIN\nconst environment = ["PUBLIC_H0_LINK_JOIN=1"];\n');
    assertSingleFlagReader(root);

    for (const [file, code] of [
      ["src/second.ts", 'export const enabled = process.env.PUBLIC_H0_LINK_JOIN === "1";'],
      ["site/src/second.astro", '---\nconst enabled = import.meta.env["PUBLIC_H0_LINK_JOIN"];\n---\n'],
      ["site/src/second.astro", '<script>const { PUBLIC_H0_LINK_JOIN: enabled } = import.meta.env;</script>'],
      ["supabase/functions/second.ts", 'const enabled = Deno.env.get("PUBLIC_H0_LINK_JOIN");'],
    ]) {
      const path = join(root, file!);
      writeFileSync(path, code!);
      assert.throws(() => assertSingleFlagReader(root), { code: "ERR_ASSERTION" }, file);
      assert.ok(flagReaders(root).some((reader) => reader.file === file && reader.reads === 1), file);
      rmSync(path);
    }
    writeFileSync(join(root, flagFile), readFileSync(join(repoRoot, flagFile), "utf8") + '\nconst duplicate = import.meta.env.PUBLIC_H0_LINK_JOIN;\n');
    assert.throws(() => assertSingleFlagReader(root), { code: "ERR_ASSERTION" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
