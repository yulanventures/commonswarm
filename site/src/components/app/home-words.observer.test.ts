import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";

const banned = /\b(?:online|offline|seat|grant|turn|wake|token|OAuth|principal)\b/iu;
function userStrings(source: string): string[] {
  const file = ts.createSourceFile("home.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const result: string[] = [];
  const visit = (node: ts.Node) => {
    // Types, import paths and property identifiers are not screen copy.
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isTypeNode(node) || ts.isInterfaceDeclaration(node)) return;
    if (ts.isStringLiteralLike(node)) {
      if (ts.isPropertyAssignment(node.parent) && node.parent.name === node) return;
      result.push(node.text);
    }
    if (ts.isTemplateExpression(node)) {
      result.push(node.head.text, ...node.templateSpans.map(span => span.literal.text));
    }
    ts.forEachChild(node, visit);
  };
  visit(file); return result;
}

test("home modules keep internal terms out of screen strings", async () => {
  const lib = new URL("../../lib/", import.meta.url);
  const files = (await readdir(lib)).filter(name => /^home-.*\.ts$/u.test(name)).sort();
  assert.ok(files.includes("home-primitives.ts") && files.includes("home-names.ts"));
  for (const file of files) {
    const strings = userStrings(await readFile(new URL(file, lib), "utf8"));
    assert.deepEqual(strings.filter(value => banned.test(value)), [], file);
  }
  const control = userStrings('import { token } from "./token"; type T = "seat"; const principal = 1; const title = "Turn the token offline"; const okay = `Start now ${principal}`;');
  assert.deepEqual(control.filter(value => banned.test(value)), ["Turn the token offline"]);
  assert.deepEqual(userStrings('const turn = 1; const copy = "Return to Home";').filter(value => banned.test(value)), []);
});
