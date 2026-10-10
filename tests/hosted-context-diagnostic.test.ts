import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import postgres from 'postgres';
import ts from 'typescript';
// @ts-expect-error TS5097: exercise the production Deno class through tsx.
import { HostedToolFailure } from '../supabase/functions/mcp/tool-errors.ts';
import {
  HOSTED_CONTEXT_FAILURE_PREFIX, HOSTED_TOOL_FAILURE_CODES,
  classifyHostedContextFailure, parseHostedContextDiagnostic, rebuildHostedContextDiagnostic,
} from './support/hosted-context-diagnostic.js';

const classes = { HostedToolFailure, PostgresError: postgres.PostgresError };
const valid = { step: 'command-import', error_code: 'Error', sqlstate: null, http_status: null };
const line = (value: unknown) => HOSTED_CONTEXT_FAILURE_PREFIX + JSON.stringify(value);
const fallback = 'SID_MCP_CLAIM_FAILED {"step":"child-startup","error_code":"InvalidDiagnostic","sqlstate":null,"http_status":null}';

test('diagnostic hosted failure inventory equals the production normalized code set', () => {
  const source = ts.createSourceFile('tool-errors.ts', readFileSync(new URL('../supabase/functions/mcp/tool-errors.ts', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest, true);
  const declaration = source.statements.filter(ts.isVariableStatement)
    .flatMap(statement => [...statement.declarationList.declarations])
    .find(node => ts.isIdentifier(node.name) && node.name.text === 'MESSAGES');
  assert.ok(declaration?.initializer && ts.isAsExpression(declaration.initializer));
  const catalog = declaration.initializer.expression;
  assert.ok(ts.isObjectLiteralExpression(catalog));
  const production = catalog.properties.map(property => {
    assert.ok(ts.isPropertyAssignment(property) && ts.isIdentifier(property.name));
    const normalized = new HostedToolFailure(property.name.text).code;
    assert.equal(normalized, property.name.text);
    return normalized;
  });
  production.push(new HostedToolFailure(null).code);
  assert.deepEqual([...HOSTED_TOOL_FAILURE_CODES].sort(), production.sort());
});

test('parent rebuilds valid diagnostics, including database and hosted positive controls', () => {
  for (const fields of [valid,
    { ...valid, error_code: 'hosted_grant_forbidden', http_status: 403 },
    { ...valid, error_code: 'ERR_ASSERTION', http_status: 100 },
    { ...valid, sqlstate: '23505', http_status: 599 },
    { ...valid, sqlstate: 'P0001' },
    { ...valid, sqlstate: 'XX000' },
    { ...valid, error_code: 'ETIMEDOUT' },
    { ...valid, error_code: 'ChildProcessFailure' },
  ]) {
    // Whitespace and reversed field order must be canonicalized, never echoed.
    const child = HOSTED_CONTEXT_FAILURE_PREFIX + ' ' + JSON.stringify({ http_status: fields.http_status,
      sqlstate: fields.sqlstate, error_code: fields.error_code, step: fields.step }) + ' ';
    assert.equal(parseHostedContextDiagnostic(child), line(fields));
    assert.notEqual(parseHostedContextDiagnostic(child), child);
  }
});

test('invalid child fields become a fixed fallback without injected text', () => {
  const generic = Object.assign(new Error('fakecanarycredential'), { code: 'SECRT' });
  // Reproduce the old child's generic-code classification at the parent input.
  const rows = [
    { ...valid, step: 'fakecanarycredential' },
    { ...valid, error_code: 'fakecanarycredential' },
    { ...valid, error_code: generic.code, sqlstate: generic.code },
    { ...valid, sqlstate: generic.code },
    { ...valid, http_status: 600 },
    { ...valid, http_status: 99 },
    { ...valid, http_status: 200.5 },
    { ...valid, http_status: '200' },
    { ...valid, sqlstate: 'ZZ123' },
    { ...valid, sqlstate: '2350x' },
    { ...valid, sqlstate: '23505fakecanarycredential' },
    { ...valid, extra: 'fakecanarycredential' },
    { step: valid.step, error_code: valid.error_code, sqlstate: null },
    null, [],
  ];
  for (const row of rows) {
    const rebuilt = parseHostedContextDiagnostic(line(row));
    assert.equal(rebuilt, fallback);
    for (const injected of ['fakecanarycredential', generic.code, 'ZZ123', '2350x']) {
      assert.equal(rebuilt.includes(injected), false);
    }
  }
  for (const child of ['fakecanarycredential', line(valid) + 'fakecanarycredential',
    HOSTED_CONTEXT_FAILURE_PREFIX + '{', HOSTED_CONTEXT_FAILURE_PREFIX + 'x'.repeat(513)]) {
    assert.equal(parseHostedContextDiagnostic(child), fallback);
  }
  assert.equal(parseHostedContextDiagnostic(line(valid)), line(valid), 'positive control in the same invocation');
});

test('child accepts SQLSTATE only on the real database client error class', () => {
  // postgres.js accepts a field object at runtime; its declarations omit that constructor.
  const pg = (code: string) => Reflect.construct(postgres.PostgresError,
    [{ code, message: 'fakecanarycredential' }]) as postgres.PostgresError;
  for (const code of ['23505', '42P01', 'P0001', 'XX000']) {
    assert.deepEqual(classifyHostedContextFailure(pg(code), classes), { error_code: 'Error', sqlstate: code });
    assert.deepEqual(classifyHostedContextFailure(Object.assign(new Error('fakecanarycredential'), { code }), classes),
      { error_code: 'Error', sqlstate: null });
  }
  for (const code of ['SECRT', 'ZZ123', '2350x', '23505fakecanarycredential']) {
    assert.deepEqual(classifyHostedContextFailure(pg(code), classes), { error_code: 'Error', sqlstate: null });
  }
  assert.deepEqual(classifyHostedContextFailure(Object.assign(new Error('fakecanarycredential'),
    { name: 'PostgresError', code: '23505' }), classes), { error_code: 'Error', sqlstate: null });
  assert.deepEqual(classifyHostedContextFailure(Object.assign(new Error('fakecanarycredential'), { code: 'SECRT' }), classes),
    { error_code: 'Error', sqlstate: null });
});

test('child classifies owned built-ins and normalized hosted failures without exception prose', () => {
  for (const [error, code] of [
    [new TypeError('fakecanarycredential'), 'TypeError'],
    [new SyntaxError('fakecanarycredential'), 'SyntaxError'],
    [new RangeError('fakecanarycredential'), 'RangeError'],
    [new Error('fakecanarycredential'), 'Error'],
    [new assert.AssertionError({ message: 'fakecanarycredential' }), 'ERR_ASSERTION'],
    [new HostedToolFailure('hosted_grant_forbidden'), 'hosted_grant_forbidden'],
    [new HostedToolFailure('fakecanarycredential'), 'tool_failed'],
    ['fakecanarycredential', 'UnknownError'],
  ] as const) {
    const fields = classifyHostedContextFailure(error, classes);
    assert.deepEqual(fields, { error_code: code, sqlstate: null });
    assert.equal(rebuildHostedContextDiagnostic({ ...valid, ...fields }).includes('fakecanarycredential'), false);
  }
});
