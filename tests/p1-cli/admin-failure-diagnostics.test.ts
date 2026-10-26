import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { safeAdminError } from "../../supabase/functions/command/failures.js";

// The formatter tests cannot catch a handler reverting to safeError or logging
// the exception directly. OAuth failure handlers emit only fixed codes. Inspect
// the remaining exception-bearing human boundary; this test never calls the formatter to produce its expectation.
test("human admin transaction failure handler route diagnostics through the imported safeAdminError", () => {
  const source = ts.createSourceFile("command/index.ts", readFileSync(
    new URL("../../supabase/functions/command/index.ts", import.meta.url), "utf8"),
    ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const imports = source.statements.filter(ts.isImportDeclaration);
  const bindings = imports.filter(declaration => ts.isStringLiteral(declaration.moduleSpecifier) &&
    /^\.\/failures\.[jt]s$/u.test(declaration.moduleSpecifier.text))
    .flatMap(declaration => {
      const named = declaration.importClause?.namedBindings;
      return named && ts.isNamedImports(named) ? named.elements : [];
    });
  const formatter = bindings.find(binding => (binding.propertyName ?? binding.name).text === "safeAdminError");
  assert.ok(formatter, "admin formatter must come from the failure boundary module");
  for (const name of ["runAdminAccountCommand"]) {
    const handler = source.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
    assert.ok(handler && ts.isFunctionDeclaration(handler) && handler.body, `${name}: handler missing`);
    const transactionCatch = handler.body.statements.filter(ts.isTryStatement)[0]?.catchClause;
    assert.ok(transactionCatch?.variableDeclaration && ts.isIdentifier(transactionCatch.variableDeclaration.name),
      `${name}: transaction failure catch missing`);
    const exception = transactionCatch.variableDeclaration.name.text;
    const logs: ts.CallExpression[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "console" &&
        node.expression.name.text === "error") logs.push(node);
      ts.forEachChild(node, visit);
    };
    visit(transactionCatch.block);
    assert.equal(logs.length, 1, `${name}: expected one sanitized failure diagnostic`);
    const log = logs[0]!;
    assert.equal(log.arguments.length, 2, `${name}: extra log arguments can leak request or database data`);
    const [label, diagnostic] = log.arguments;
    assert.ok(label && ts.isStringLiteral(label) && label.text === "admin_command_failed", `${name}: diagnostic label`);
    assert.ok(diagnostic && ts.isCallExpression(diagnostic) && ts.isIdentifier(diagnostic.expression) &&
      diagnostic.expression.text === formatter.name.text && diagnostic.arguments.length === 1 &&
      ts.isIdentifier(diagnostic.arguments[0]!) && diagnostic.arguments[0]!.text === exception,
      `${name}: caught error must be logged only through safeAdminError`);
  }
});

test("admin failure diagnostics retain the internal error class and safe message", () => {
  const error = new Error("permission denied for table events");
  error.name = "PostgresError";
  assert.equal(safeAdminError(error), "PostgresError: permission denied for table events");
  assert.equal(safeAdminError(new TypeError("routine workspace stream missing")),
    "TypeError: routine workspace stream missing");
  assert.equal(safeAdminError({ message: "must not serialize arbitrary objects" }), "unknown error");
});

test("admin failure diagnostics remove credential material, SQL values and log controls before bounding", () => {
  const secrets = ["swm_adm_" + "a".repeat(43), "swm_adr_" + "b".repeat(43),
    "swm_agt_" + "c".repeat(43), "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJhIn0.signature",
    "quoted-private-value", "https://user:password@example.test/path", "opaque-unquoted-secret"];
  const error = Object.assign(new Error(`invalid input ${secrets.slice(0, 4).join(" ")} "${secrets[4]}" ${secrets[5]} secret=${secrets[6]}\n\u001b\u202e`),
    { detail: "private database detail", query: "private SQL", parameters: ["private parameter"] });
  const diagnostic = safeAdminError(error);
  for (const secret of [...secrets, error.detail, error.query, ...error.parameters]) {
    assert.ok(!diagnostic.includes(secret));
  }
  assert.ok(!/[\n\u001b\u202e]/u.test(diagnostic));
  assert.match(diagnostic, /^Error: invalid input/u);
  assert.ok(safeAdminError(new Error("x".repeat(1000))).length <= 512);
});

test("OAuth admin failure boundaries emit only fixed diagnostic codes", () => {
  const source = ts.createSourceFile("command/index.ts", readFileSync(new URL("../../supabase/functions/command/index.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  for (const name of ["runAdminOAuthCommand", "handleAdminWorkerCommand"]) {
    const handler = source.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === name);
    assert.ok(handler && ts.isFunctionDeclaration(handler) && handler.body);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.expression.getText(source) === "console") {
        assert.ok(node.arguments.every(ts.isStringLiteral), `${name}: dynamic diagnostic can disclose credential or SQL values`);
      }
      ts.forEachChild(node, visit);
    };
    visit(handler.body);
  }
});
