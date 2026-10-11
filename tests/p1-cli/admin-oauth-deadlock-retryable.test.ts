import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import postgres from "postgres";
import { adminFailureRetryable, adminOAuthFailureResult } from "../../supabase/functions/command/failures.js";

// HezLead ruling 25 (a), FOLLOW-UPS-C1 #42: a deadlocked OAuth admin transaction reaches the
// client as a typed, retryable 503, and every other failure keeps its exact body. The thrown
// value is the driver's own error class, as postgres.js raises it for a server ErrorResponse.
const DriverError = postgres.PostgresError as unknown as new (fields: Record<string, string>) => Error;
const driverFailure = (code: string) => new DriverError({ severity: "ERROR", code, message: "deadlock detected" });
const response = (error: unknown, audit: "admin_command_failed" | "admin_failure_audit_unavailable") =>
  JSON.stringify(adminOAuthFailureResult(error, audit));

test("SQLSTATE 40P01 maps to a typed retryable 503; every other failure keeps today's bytes", () => {
  const deadlock = driverFailure("40P01");
  assert.ok(deadlock instanceof postgres.PostgresError);
  assert.equal(adminFailureRetryable(deadlock), true);
  assert.equal(response(deadlock, "admin_command_failed"),
    '{"status":503,"body":{"error":"admin_command_failed","retryable":true}}');
  assert.equal(response(deadlock, "admin_failure_audit_unavailable"),
    '{"status":503,"body":{"error":"admin_failure_audit_unavailable","retryable":true}}');
  // Other SQLSTATEs, a deadlock message without its code, and non-errors: the bytes before #42.
  const others: unknown[] = [driverFailure("40001"), driverFailure("55P03"), driverFailure("57014"), driverFailure("23505"),
    new Error("deadlock detected"), Object.assign(new Error("x"), { code: 40 }), "40P01", null, undefined];
  for (const error of others) {
    assert.equal(adminFailureRetryable(error), false);
    assert.equal(response(error, "admin_command_failed"), '{"status":503,"body":{"error":"admin_command_failed"}}');
    assert.equal(response(error, "admin_failure_audit_unavailable"), '{"status":503,"body":{"error":"admin_failure_audit_unavailable"}}');
  }
});

const parse = (path: string) => ts.createSourceFile(path, readFileSync(new URL(`../../${path}`, import.meta.url), "utf8"),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const fn = (source: ts.SourceFile, name: string) => {
  const found = source.statements.find((s) => ts.isFunctionDeclaration(s) && s.name?.text === name);
  assert.ok(found && ts.isFunctionDeclaration(found) && found.body, `${name}: missing`);
  return found;
};
const calls = (node: ts.Node, callee: string) => {
  const found: ts.CallExpression[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === callee) found.push(n);
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
};
const isCallOf = (node: ts.Node | undefined, callee: string, caught: string) => !!node && ts.isCallExpression(node) &&
  ts.isIdentifier(node.expression) && node.expression.text === callee &&
  ts.isIdentifier(node.arguments[0]!) && node.arguments[0]!.text === caught;

test("both OAuth admin handlers send their failure through the mapping; the human handler does not", () => {
  const source = parse("supabase/functions/command/index.ts");
  for (const name of ["runAdminOAuthCommand", "handleAdminWorkerCommand"]) {
    const handler = fn(source, name);
    // The transaction's failure catch is the one that writes the failure card.
    const failureCatches = handler.body!.statements.filter(ts.isTryStatement).map((t) => t.catchClause)
      .filter((c): c is ts.CatchClause => c !== undefined && calls(c.block, "recordAdminFailure").length > 0);
    assert.equal(failureCatches.length, 1, `${name}: one failure catch`);
    const clause = failureCatches[0]!;
    assert.ok(clause.variableDeclaration && ts.isIdentifier(clause.variableDeclaration.name), `${name}: the catch binds the error`);
    const caught = clause.variableDeclaration.name.text;
    const cards = calls(clause.block, "recordAdminFailure");
    assert.equal(cards.length, 1, `${name}: one failure card`);
    assert.ok(cards[0]!.arguments.length === 5 && isCallOf(cards[0]!.arguments[4], "adminFailureRetryable", caught),
      `${name}: the card is told whether the caught error is retryable`);
    const returns: ts.ReturnStatement[] = [];
    const visit = (n: ts.Node) => { if (ts.isReturnStatement(n)) returns.push(n); ts.forEachChild(n, visit); };
    visit(clause.block);
    assert.equal(returns.length, 2, `${name}: card failure and card success`);
    for (const r of returns) {
      assert.ok(isCallOf(r.expression, "adminOAuthFailureResult", caught) && ts.isStringLiteral((r.expression as ts.CallExpression).arguments[1]!),
        `${name}: mapped return`);
    }
  }
  const human = fn(source, "runAdminAccountCommand");
  assert.equal(calls(human, "adminFailureRetryable").length + calls(human, "adminOAuthFailureResult").length, 0,
    "the human admin path keeps its 500 bodies");
});

test("a retryable failure card caches no result for its command_id; every other card still does", () => {
  const card = fn(parse("supabase/functions/command/admin-delegation.ts"), "recordAdminFailure");
  const param = card.parameters[4];
  assert.ok(param && ts.isIdentifier(param.name) && param.initializer?.kind === ts.SyntaxKind.FalseKeyword, "5th parameter defaults to false");
  const flag = param.name.text;
  const inserts: ts.Node[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isTaggedTemplateExpression(n) && /INSERT INTO swarm\.admin_command_results/u.test(n.template.getText())) inserts.push(n);
    ts.forEachChild(n, visit);
  };
  visit(card.body!);
  assert.equal(inserts.length, 1, "one cached-result insert");
  let guard: ts.Node | undefined = inserts[0];
  while (guard && !ts.isIfStatement(guard)) guard = guard.parent;
  assert.ok(guard && ts.isIfStatement(guard), "the insert is conditional");
  const conjuncts: ts.Expression[] = [];
  const split = (e: ts.Expression) => {
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) { split(e.left); split(e.right); }
    else conjuncts.push(e);
  };
  split(guard.expression);
  assert.ok(conjuncts.some((c) => ts.isPrefixUnaryExpression(c) && c.operator === ts.SyntaxKind.ExclamationToken &&
    ts.isIdentifier(c.operand) && c.operand.text === flag), "the insert requires a non-retryable failure");
});

// HezLead ruling 26 A: on the admin MCP surface a retry with the same command_id runs after a 40P01. It reaches the
// same transaction runner as the command surface, so the card above caches nothing for that command_id; the response
// bytes are unchanged (HTTP 503, JSON-RPC -32000 admin_command_failed).
const adminSurfaces = (indexText: string, httpText: string) => {
  const index = ts.createSourceFile("index.ts", indexText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declarations = index.statements.flatMap((s) => ts.isVariableStatement(s) ? [...s.declarationList.declarations] : []);
  const deps = declarations.find((d) => ts.isIdentifier(d.name) && d.name.text === "adminHttpDependencies");
  assert.ok(deps?.initializer && ts.isObjectLiteralExpression(deps.initializer), "adminHttpDependencies: object literal");
  const transact = deps.initializer.properties.find((p) => p.name && ts.isIdentifier(p.name) && p.name.text === "transact");
  assert.ok(transact && ts.isPropertyAssignment(transact) && ts.isIdentifier(transact.initializer) &&
    transact.initializer.text === "runAdminOAuthCommand", "transact is runAdminOAuthCommand");
  const surfaces = new Map<string, string>();
  for (const d of declarations) {
    const init = d.initializer;
    if (init && ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === "createAdminHttpHandler" &&
      ts.isIdentifier(d.name) && init.arguments.length === 2 && ts.isIdentifier(init.arguments[0]!) &&
      init.arguments[0]!.text === "adminHttpDependencies" && ts.isStringLiteral(init.arguments[1]!)) surfaces.set(init.arguments[1]!.text, d.name.text);
  }
  assert.deepEqual([...surfaces.keys()].sort(), ["admin_command", "admin_mcp"], "both surfaces use adminHttpDependencies");
  assert.equal(calls(fn(index, "handleAdminMcpRequest"), surfaces.get("admin_mcp")!).length, 1, "handleAdminMcpRequest runs the admin_mcp handler");
  const http = ts.createSourceFile("admin-http.ts", httpText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const ids: ts.PropertyAssignment[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && n.name.text === "command_id") ids.push(n);
    ts.forEachChild(n, visit);
  };
  visit(http);
  assert.equal(ids.filter((p) => p.initializer.getText() === "args?.command_id").length, 1, "tools/call keeps the caller's command_id");
};

test("ruling 26 A: the admin MCP surface runs the OAuth runner with the caller's command_id", () => {
  const indexText = readFileSync(new URL("../../supabase/functions/command/index.ts", import.meta.url), "utf8");
  const httpText = readFileSync(new URL("../../supabase/functions/_shared/admin-http.ts", import.meta.url), "utf8");
  adminSurfaces(indexText, httpText);
  // Controls in the same run: each mutation must fail the check.
  const otherRunner = indexText.replace("transact: runAdminOAuthCommand,", "transact: runAdminAccountCommand,");
  assert.notEqual(otherRunner, indexText);
  assert.throws(() => adminSurfaces(otherRunner, httpText), /runAdminOAuthCommand/u);
  const freshId = httpText.replace("command_id: args?.command_id", "command_id: `adminmcp_${crypto.randomUUID()}`");
  assert.notEqual(freshId, httpText);
  assert.throws(() => adminSurfaces(indexText, freshId), /command_id/u);
});
