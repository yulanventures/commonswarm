import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { H0_VERBS } from "../../src/h0/verbs.js";
import { parseH0ForwardBody } from "../../supabase/functions/h0/parse.js";

const UUID = "12345678-1234-4123-8123-123456789abc";
const examples = {
  register: { joinCredential: "opaque", attemptId: UUID, name: "Seat" },
  ask: { body: "Question" },
  note: { body: "Intent" },
  reply: { signal_id: UUID, body: "Answer" },
  "working-on": { body: "Work" },
} as const;

test("forward parsers accept exactly the table fields, presence and nullability", { timeout: 5_000 }, () => {
  const source = readFileSync(fileURLToPath(new URL("../../supabase/functions/h0/parse.ts", import.meta.url)), "utf8");
  const ast = ts.createSourceFile("parse.ts", source, ts.ScriptTarget.Latest, true);
  const literals = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node)) literals.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  for (const [verb, base] of Object.entries(examples)) {
    const row = H0_VERBS.find((item) => item.name === verb);
    assert.ok(row);
    assert.equal(parseH0ForwardBody(verb as keyof typeof examples, base).ok, true);
    const samples: Record<string, unknown> = {
      joinCredential: "opaque", attemptId: UUID, name: "Seat", icon: "star",
      signal_id: UUID, body: "Text", requestId: UUID,
      to: [{ kind: "agent", id: UUID }],
    };
    const accepted = [...new Set([...literals, ...row.fields.map((field) => field.name), "unknown_field"])]
      .filter((key) => key in samples || key === "unknown_field")
      .filter((key) => parseH0ForwardBody(verb as keyof typeof examples, {
        ...base, [key]: key === "unknown_field" ? "x" : samples[key],
      }).ok);
    assert.deepEqual(accepted.sort(), row.fields.map((field) => field.name).sort(), verb);
    for (const field of row.fields) {
      const without = { ...base } as Record<string, unknown>;
      delete without[field.name];
      assert.equal(
        parseH0ForwardBody(verb as keyof typeof examples, without).ok,
        field.presence === "omittable",
        `${verb}.${field.name} presence`,
      );
      assert.equal(
        parseH0ForwardBody(verb as keyof typeof examples, { ...base, [field.name]: null }).ok,
        field.nullable,
        `${verb}.${field.name} nullability`,
      );
    }
  }
});
