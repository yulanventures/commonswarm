/**
 * The app's invite limits are the ones the command edge and the migration enforce.
 * A typed copy in the page would not fail this when the edge changes.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  AGENT_JOIN_CREDENTIAL_ID_RE,
  AGENT_JOIN_LOCATOR_RE,
  AGENT_JOIN_SEAT_CAP_MAX,
  AGENT_JOIN_SEAT_CAP_MIN,
  AGENT_JOIN_TTL_MAX_HOURS,
  AGENT_JOIN_TTL_MIN_HOURS,
  MINT_AGENT_JOIN_CREDENTIAL_FIELDS,
  REVOKE_AGENT_JOIN_CREDENTIAL_FIELDS,
} from "../../src/protocol/agent-join-limits.js";
import { H0_AGENT_DOCUMENT_PATH_PREFIX } from "../../src/protocol/h0-agent-document-url.js";
import { handleH0Request } from "../../supabase/functions/h0/core.js";

const root = fileURLToPath(new URL("../..", import.meta.url));

function read(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

function numberConst(source: string, name: string): number {
  const text = initializerText(source, name);
  if (!/^\d+$/.test(text)) {
    throw new Error(`${name} is not a numeric literal: ${text}`);
  }
  return Number(text);
}

function initializerText(source: string, name: string): string {
  const file = ts.createSourceFile("source.ts", source, ts.ScriptTarget.Latest, true);
  let text: string | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.name.text === name
      && node.initializer
    ) {
      text = node.initializer.getText(file);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (text === undefined) throw new Error(`missing constant ${name}`);
  return text;
}

function exactKeyLists(source: string): string[][] {
  const file = ts.createSourceFile("source.ts", source, ts.ScriptTarget.Latest, true);
  const lists: string[][] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === "exactKeys"
      && node.arguments[1]
      && ts.isArrayLiteralExpression(node.arguments[1])
    ) {
      const values: string[] = [];
      let stringsOnly = true;
      for (const element of node.arguments[1].elements) {
        if (!ts.isStringLiteral(element)) {
          stringsOnly = false;
          break;
        }
        values.push(element.text);
      }
      if (stringsOnly) lists.push(values);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return lists;
}

function oneList(lists: string[][], field: string): string[] {
  const found = lists.filter((list) => list.includes(field));
  assert.equal(found.length, 1, `expected one exactKeys list containing ${field}`);
  return found[0]!;
}

/** Throws when the app's constants differ from the command edge, the migration, or the document route. */
export async function assertJoinLimitsMatchEnforcement(): Promise<void> {
  const command = read("supabase/functions/command/index.ts");
  const migration = read("supabase/migrations/20260916000001_agent_join_credentials.sql");

  assert.equal(numberConst(command, "AGENT_JOIN_SEAT_CAP_MIN"), AGENT_JOIN_SEAT_CAP_MIN);
  assert.equal(numberConst(command, "AGENT_JOIN_SEAT_CAP_MAX"), AGENT_JOIN_SEAT_CAP_MAX);
  assert.equal(numberConst(command, "AGENT_JOIN_TTL_MIN_HOURS"), AGENT_JOIN_TTL_MIN_HOURS);
  assert.equal(numberConst(command, "AGENT_JOIN_TTL_MAX_HOURS"), AGENT_JOIN_TTL_MAX_HOURS);
  assert.equal(initializerText(command, "AGENT_JOIN_LOCATOR_RE"), AGENT_JOIN_LOCATOR_RE.toString());
  assert.equal(initializerText(command, "UUID_RE"), AGENT_JOIN_CREDENTIAL_ID_RE.toString());

  const seat = migration.match(
    /seat_cap integer NOT NULL CHECK \(seat_cap BETWEEN (\d+) AND (\d+)\)/,
  );
  assert.ok(seat, "migration seat_cap check");
  assert.equal(Number(seat[1]), AGENT_JOIN_SEAT_CAP_MIN);
  assert.equal(Number(seat[2]), AGENT_JOIN_SEAT_CAP_MAX);
  const hours = migration.match(/expires_at <= created_at \+ interval '(\d+) hours'/);
  assert.ok(hours, "migration invite lifetime ceiling");
  assert.equal(Number(hours[1]), AGENT_JOIN_TTL_MAX_HOURS);
  const locator = migration.match(/locator ~ '(\^\[A-Za-z0-9_-\]\{22\}\$)'/);
  assert.ok(locator, "migration locator check");
  assert.equal(locator[1], AGENT_JOIN_LOCATOR_RE.source);

  const lists = exactKeyLists(command);
  assert.deepEqual(
    oneList(lists, "seat_cap").slice().sort(),
    [...MINT_AGENT_JOIN_CREDENTIAL_FIELDS].sort(),
  );
  assert.deepEqual(
    oneList(lists, "join_credential_id").slice().sort(),
    [...REVOKE_AGENT_JOIN_CREDENTIAL_FIELDS].sort(),
  );

  const locatorSample = "b".repeat(22);
  const document = { marker: "h0-agent-document" };
  const origin = "https://api.example.test";
  const accepted = handleH0Request(
    new Request(`${origin}${H0_AGENT_DOCUMENT_PATH_PREFIX}${locatorSample}`),
    document,
  );
  assert.equal(accepted.status, 200);
  assert.equal(await accepted.text(), JSON.stringify(document));
  const noLocator = handleH0Request(
    new Request(`${origin}${H0_AGENT_DOCUMENT_PATH_PREFIX}`),
    document,
  );
  assert.equal(noLocator.status, 404);
  assert.equal(await noLocator.text(), JSON.stringify({ error: "not_found" }));
}
