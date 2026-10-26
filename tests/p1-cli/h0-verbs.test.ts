/*
 * Controls on the H0 verb table.
 *
 * THE FIRST VERSION OF THIS FILE HAD EIGHT GREEN TESTS AND THREE OF THEM WERE NOT CONTROLS.
 * A review arm proved it by mutation: it gutted `ack` to `required: ["signal_id"]` plus
 * `optional: ["made_up_field"]`, and all eight still passed. The author reproduced it.
 *
 * The reason is worth more than the fix. The document is GENERATED from the table, so its parser
 * controls rendering fidelity, not enforcement. The non-circular controls below use the
 * TypeScript AST to read the command interfaces at the enforcement boundary. Comments,
 * whitespace, spreads elsewhere in the source, and line breaks cannot change that structure.
 *
 * Gate: tests/p1-cli/**\/*.test.ts is globbed by `npm run test:p1-cli`, so this file runs there.
 * It is NOT in the literal list `npm test` names -- verified by running both.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repoFile = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");

function sourceFile(rel: string): ts.SourceFile {
  return ts.createSourceFile(
    rel,
    repoFile(rel),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

/**
 * H0 may be STRICTER than the wire, never LOOSER — and that asymmetry is the rule, not equality.
 *
 * Writing this as strict equality immediately failed on `reply.signal_id`, which is REQUIRED here
 * while `in_reply_to` is optional on the wire. That is correct and deliberate: one `post_signal`
 * command serves ask, note, reply and working-on, so `in_reply_to` must be optional THERE, while
 * a reply that replies to nothing is meaningless HERE. The verb narrows the command.
 *
 * WIDENING is the lie this check exists to catch: telling an agent a field may be omitted when
 * the server demands it, or that a value may be null when it may not, produces a document that
 * invites a 400. That direction fails here.
 *
 * NARROWING IS NOT CHECKED, AND IT IS NOT UNCONDITIONALLY SAFE — an arm corrected an earlier
 * version of this comment that said it was. Narrowing breaks an agent wherever the server
 * CONDITIONALLY requires null or absence: `ack` must send `lease_id: null` when the outcome is
 * `observed`, so declaring it non-nullable here would forbid a valid body. That is why ack keeps
 * those fields nullable, and it is pinned by the ack interface comparison, not by this function.
 * Where the wire field is OPTIONAL, this function places NO constraint on H0's presence at all.
 */

test("h0AgentDocumentDescription accepts exactly one number and no secret-shaped input", () => {
  /* One required number is the whole runtime input surface. A credential or other string cannot
   * type-check as document input, while the non-leaf caller can still supply the shared TTL. */
  const file = sourceFile("src/h0/verbs.ts");
  const declarations: ts.FunctionDeclaration[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name?.text === "h0AgentDocumentDescription"
    ) {
      declarations.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  assert.equal(declarations.length, 1, "expected one function declaration named h0AgentDocumentDescription");
  const parameters = declarations[0]!.parameters;
  assert.equal(parameters.length, 1, "the document function must accept only the seat lifetime");
  assert.equal(parameters[0]!.type?.kind, ts.SyntaxKind.NumberKeyword, "the only input must be typed number");
  assert.equal(parameters[0]!.questionToken, undefined, "the lifetime must be required");
  assert.equal(parameters[0]!.initializer, undefined, "the lifetime must not have a copied default");
  assert.equal(parameters[0]!.dotDotDotToken, undefined, "the function must not accept extra runtime values");
});
