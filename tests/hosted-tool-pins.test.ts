import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
// @ts-expect-error TS5097 — Deno edge modules use explicit .ts extensions.
import { HOSTED_TOOL_TABLE } from '../supabase/functions/mcp/tools.ts';

// These plain-JS inventories cannot import the TypeScript hosted table. Read
// their literal names without executing either live-service entry point.
function pinnedNames(path: string, binding: string): string[] {
  const source = ts.createSourceFile(path, readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const declarations: ts.VariableDeclaration[] = [];
  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === binding) {
      declarations.push(node);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.equal(declarations.length, 1, `${path}: one ${binding} inventory`);
  let names = declarations[0].initializer;
  if (names && ts.isNewExpression(names) && ts.isIdentifier(names.expression) && names.expression.text === 'Set') {
    assert.equal(names.arguments?.length, 1, `${path}: Set has one inventory`);
    names = names.arguments![0];
  }
  assert.ok(names && ts.isArrayLiteralExpression(names), `${path}: inventory is a literal array`);
  return names.elements.map(element => {
    assert.ok(ts.isStringLiteral(element), `${path}: every tool name is a string literal`);
    return element.text;
  });
}

const hostedNames = HOSTED_TOOL_TABLE.map(tool => tool.name).sort();

test('OAuth MCP contract pins the sorted hosted tool inventory', () => {
  assert.deepEqual(pinnedNames('services/mcp-auth/test-postgres/oauth-mcp-contract.test.js', 'expectedTools'),
    hostedNames);
});

test('DCR round trip pins the same hosted tool inventory', () => {
  assert.deepEqual(pinnedNames('scripts/dcr-roundtrip.mjs', 'TOOL_NAMES').sort(), hostedNames);
});
