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
  // Read the parser's own allowlist. A new name must fail this comparison even
  // when the hand-picked valid-value samples below do not know its type.
  const parserFields = new Map<string, { required: string[]; omittable: string[] }>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
        node.name.text === "FORWARD_FIELDS" && node.initializer &&
        ts.isObjectLiteralExpression(node.initializer)) {
      for (const row of node.initializer.properties) {
        assert.ok(ts.isPropertyAssignment(row) && ts.isObjectLiteralExpression(row.initializer));
        const verb = ts.isIdentifier(row.name) || ts.isStringLiteral(row.name) ? row.name.text : "";
        const fields = { required: [] as string[], omittable: [] as string[] };
        for (const group of row.initializer.properties) {
          assert.ok(ts.isPropertyAssignment(group) && ts.isIdentifier(group.name) &&
            ts.isArrayLiteralExpression(group.initializer));
          const name = group.name.text;
          assert.ok(name === "required" || name === "omittable");
          fields[name] = group.initializer.elements.map((item) => {
            assert.ok(ts.isStringLiteral(item));
            return item.text;
          });
        }
        parserFields.set(verb, fields);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.deepEqual([...parserFields.keys()].sort(), Object.keys(examples).sort());
  for (const [verb, base] of Object.entries(examples)) {
    const row = H0_VERBS.find((item) => item.name === verb);
    assert.ok(row);
    assert.equal(parseH0ForwardBody(verb as keyof typeof examples, base).ok, true);
    const samples: Record<string, unknown> = {
      joinCredential: "opaque", attemptId: UUID, name: "Seat", icon: "star",
      signal_id: UUID, body: "Text", requestId: UUID,
      to: [{ kind: "agent", id: UUID }],
    };
    const declared = parserFields.get(verb)!;
    assert.deepEqual(declared.required.slice().sort(), row.fields.filter((f) => f.presence === "required").map((f) => f.name).sort(), `${verb} required`);
    assert.deepEqual(declared.omittable.slice().sort(), row.fields.filter((f) => f.presence === "omittable").map((f) => f.name).sort(), `${verb} omittable`);
    const accepted = [...new Set([...declared.required, ...declared.omittable, "unknown_field"])]
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

test("missing command configuration has its own fixed code and safe log", { timeout: 5_000 }, async () => {
  // Keep the edge module outside the Node test typecheck; Deno checks it separately.
  const { handleH0ForwardRequest } = await import(["../../supabase/functions/h0", "forward.js"].join("/"));
  const prior = Object.getOwnPropertyDescriptor(globalThis, "Deno");
  const priorLog = console.error;
  const lines: unknown[][] = [];
  Object.defineProperty(globalThis, "Deno", {
    configurable: true, value: { env: { get: () => undefined } },
  });
  console.error = (...args: unknown[]) => { lines.push(args); };
  try {
    const response = await handleH0ForwardRequest(new Request("https://example.test/h0/register", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ joinCredential: "private-control-credential", attemptId: UUID, name: "Seat" }),
    }), "register");
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "h0_command_not_configured" });
    assert.deepEqual(lines, [["h0 command configuration missing"]]);
  } finally {
    console.error = priorLog;
    if (prior) Object.defineProperty(globalThis, "Deno", prior);
    else Reflect.deleteProperty(globalThis, "Deno");
  }
});
