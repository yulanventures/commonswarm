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

import {
  H0_VERBS, H0_VERB_NAMES, H0_PREAUTH_VERBS, h0Verb, h0AgentDocumentDescription,
  type H0Verb,
} from "../../src/h0/verbs.js";
import { H0_SEAT_TOKEN_TTL_MS } from "../../src/protocol/index.js";

const repoFile = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");

interface ContractField {
  name: string;
  presence: "required" | "omittable";
  nullable: boolean;
}

function sourceFile(rel: string): ts.SourceFile {
  return ts.createSourceFile(
    rel,
    repoFile(rel),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function memberName(name: ts.PropertyName, context: string): string {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  assert.fail(`${context}: computed property names are not supported`);
}

function includesNull(type: ts.TypeNode): boolean {
  if (ts.isParenthesizedTypeNode(type)) return includesNull(type.type);
  if (ts.isUnionTypeNode(type)) return type.types.some(includesNull);
  return ts.isLiteralTypeNode(type) && type.literal.kind === ts.SyntaxKind.NullKeyword;
}

function interfaceContract(rel: string, interfaceName: string): ContractField[] {
  const file = sourceFile(rel);
  const matches: ts.InterfaceDeclaration[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === interfaceName) matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(file);
  assert.equal(matches.length, 1, `${rel}: expected one interface ${interfaceName}`);

  return matches[0]!.members.map((member, index) => {
    const context = `${rel}: ${interfaceName} member ${index + 1}`;
    assert.ok(ts.isPropertySignature(member), `${context} is not a property signature`);
    assert.ok(member.type, `${context} has no declared type`);
    return {
      name: memberName(member.name, context),
      presence: member.questionToken === undefined ? "required" : "omittable",
      nullable: includesNull(member.type),
    };
  });
}

function tableContract(verbName: string): ContractField[] {
  const verb = H0_VERBS.find((candidate) => candidate.name === verbName);
  assert.ok(verb, `missing H0 verb ${verbName}`);
  return verb.fields.map(({ name, presence, nullable }) => ({ name, presence, nullable }));
}

test("ack's table equals AckAgentDeliveryCommand on name, presence, and nullability", () => {
  const wire = interfaceContract(
    "supabase/functions/command/durable-delivery.ts",
    "AckAgentDeliveryCommand",
  ).filter(({ name }) => name !== "kind");
  assert.deepEqual(tableContract("ack"), wire);
});

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
function assertContract(
  verbName: string,
  field: { name: string; presence: string; nullable: boolean },
  member: { presence: string; nullable: boolean },
): void {
  if (member.presence === "required") {
    assert.equal(
      field.presence,
      "required",
      `${verbName}.${field.name}: the wire REQUIRES this; H0 must not call it omittable`,
    );
  }
  if (!member.nullable) {
    assert.equal(
      field.nullable,
      false,
      `${verbName}.${field.name}: the wire forbids null; H0 must not say it may be null`,
    );
  }
}

test("signal verb fields name a SignalCommand member or declare their envelope mapping", () => {
  const signalContract = interfaceContract(
    "supabase/functions/command/index.ts",
    "SignalCommand",
  );
  const signal = new Map(signalContract.map((field) => [field.name, field]));
  const adapterDiscriminators = new Set(["kind", "signal_kind"]);
  /* Required AND non-nullable wire fields only. A required-but-NULLABLE field such as `about` or
   * `to_user_id` is one the H0 adapter fills with null on the agent's behalf, so an agent is never
   * asked for it; requiring H0 to expose it would be wrong. An arm asked why they are excluded. */
  const requiredInputs = signalContract.filter((field) =>
    field.presence === "required" &&
    !field.nullable &&
    !adapterDiscriminators.has(field.name)
  );

  for (const verbName of ["ask", "note", "reply", "working-on"] as const) {
    const verb = H0_VERBS.find((candidate) => candidate.name === verbName)!;
    const mappedSignalFields = new Set<string>();
    for (const field of verb.fields) {
      if (field.wire?.target === "signal") {
        mappedSignalFields.add(field.wire.name);
        assert.ok(signal.has(field.wire.name), `${verbName}.${field.name}: unknown signal wire field ${field.wire.name}`);
        /* A RENAMED FIELD IS STILL A FIELD, so it goes through the same contract check. But be
         * exact about what that buys: `in_reply_to` is OPTIONAL on the wire, so assertContract
         * constrains its NULLABILITY and places no constraint on presence. reply.signal_id being
         * REQUIRED is H0 semantics, pinned by its own test below and by the golden — an arm caught
         * an earlier comment here claiming the contract check covered it. */
        assertContract(verbName, field, signal.get(field.wire.name)!);
        assert.deepEqual(
          { verb: verbName, field: field.name, wire: field.wire },
          {
            verb: "reply",
            field: "signal_id",
            wire: { target: "signal", name: "in_reply_to" },
          },
          "only reply.signal_id has a declared SignalCommand rename",
        );
      } else if (field.wire?.target === "command-envelope") {
        assert.equal(field.name, "requestId", `${verbName}: only requestId is the idempotency key`);
        assert.deepEqual(field.wire, {
          target: "command-envelope",
          name: "command_id",
          purpose: "idempotency-key",
        });
      } else {
        mappedSignalFields.add(field.name);
        assert.ok(signal.has(field.name), `${verbName}.${field.name}: no SignalCommand member or declared wire mapping`);
        /* PRESENCE AND NULLABILITY against the interface, in the unsafe direction only. This is what
         * catches `opt("body")` on `ask`: the wire requires `body`. It does NOT catch `opt("to")` on
         * `working-on` — `to` is optional on the wire, so no contract check can see that one verb
         * must refuse it. That per-verb rule has its own test below, and an arm caught an earlier
         * comment here claiming this line covered it. */
        assertContract(verbName, field, signal.get(field.name)!);
      }
    }
    /* `kind` and `signal_kind` come from the adapter route and verb. Every other required,
     * non-null SignalCommand member must have an H0 input. Required nullable members may use
     * the adapter's null default. A future fixed non-null default needs an explicit shape before
     * it can be excluded here. */
    for (const required of requiredInputs) {
      assert.ok(mappedSignalFields.has(required.name), `${verbName}: required SignalCommand input ${required.name} is missing`);
    }
  }
});

function parseDocumentFields(): Map<string, ContractField[]> {
  const doc = h0AgentDocumentDescription(H0_SEAT_TOKEN_TTL_MS);
  const parsed = new Map<string, ContractField[]>();
  let currentVerb: string | null = null;

  for (const [index, line] of doc.split("\n").entries()) {
    const head = /^POST ([a-z][a-z-]*) — /.exec(line);
    if (head) {
      currentVerb = head[1]!;
      assert.equal(parsed.has(currentVerb), false, `line ${index + 1}: duplicate verb ${currentVerb}`);
      parsed.set(currentVerb, []);
      continue;
    }
    if (currentVerb === null) continue;

    const field = /^    ([A-Za-z_][A-Za-z0-9_]*) \((required|may be omitted)(, may be null)?\)(?: — .+)?$/.exec(line);
    assert.ok(field, `line ${index + 1} in ${currentVerb}'s field region does not match the field grammar: ${JSON.stringify(line)}`);
    parsed.get(currentVerb)!.push({
      name: field[1]!,
      presence: field[2] === "required" ? "required" : "omittable",
      nullable: field[3] !== undefined,
    });
  }
  return parsed;
}

test("the document's strictly parsed field contracts equal the table", () => {
  const parsed = parseDocumentFields();
  assert.deepEqual([...parsed.keys()], [...H0_VERB_NAMES]);
  for (const verb of H0_VERBS) {
    assert.deepEqual(parsed.get(verb.name), tableContract(verb.name), verb.name);
  }
});

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

test("the document derives its whole-day seat lifetime from H0_SEAT_TOKEN_TTL_MS", () => {
  const dayMs = 24 * 60 * 60 * 1_000;
  assert.equal(H0_SEAT_TOKEN_TTL_MS % dayMs, 0, "the ruled seat lifetime must be whole days");
  const days = H0_SEAT_TOKEN_TTL_MS / dayMs;
  const sentence = `A seat lasts ${days} days; after it ends, ask the human who invited you for a new invite.`;
  assert.match(h0AgentDocumentDescription(H0_SEAT_TOKEN_TTL_MS), new RegExp(`^${sentence.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  assert.match(
    h0AgentDocumentDescription(H0_SEAT_TOKEN_TTL_MS - dayMs),
    new RegExp(`^A seat lasts ${days - 1} days;`, "m"),
    "the sentence must compute the number from its parameter",
  );
  assert.throws(
    () => h0AgentDocumentDescription(H0_SEAT_TOKEN_TTL_MS - 1),
    /positive whole number of days/,
  );
});

test("the H0 edge passes the imported H0 seat lifetime without a literal or shadow", () => {
  const file = sourceFile("supabase/functions/h0/index.ts");
  const imports = new Map<string, string>();
  const localDeclarations: string[] = [];
  let passedLifetime: ts.Expression | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node)
      && ts.isStringLiteral(node.moduleSpecifier)
      && node.importClause?.namedBindings
      && ts.isNamedImports(node.importClause.namedBindings)
    ) {
      for (const element of node.importClause.namedBindings.elements) {
        imports.set(element.name.text, node.moduleSpecifier.text);
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      localDeclarations.push(node.name.text);
    }
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === "h0AgentDocumentDescription"
    ) {
      assert.equal(passedLifetime, undefined, "expected one description call");
      assert.equal(node.arguments.length, 1, "the description call must pass one value");
      passedLifetime = node.arguments[0];
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  assert.ok(passedLifetime && ts.isIdentifier(passedLifetime), "the lifetime argument must be an identifier");
  assert.equal(passedLifetime.text, "H0_SEAT_TOKEN_TTL_MS");
  assert.equal(imports.get("H0_SEAT_TOKEN_TTL_MS"), "../_shared/protocol.js");
  assert.ok(
    !localDeclarations.includes("H0_SEAT_TOKEN_TTL_MS"),
    "a local lifetime would shadow the protocol import",
  );
});

test("the SERVED DOCUMENT equals its golden, line for line", () => {
  /* THE ALLOWLIST I WROTE FIRST WAS NOT ENOUGH, and I found that by attacking it rather than by
   * being told. It allowlisted the fixed PROSE and treated everything else as "table-derived",
   * where table-derived meant "starts with POST" or "is indented four spaces". Two injections
   * walked straight through with all ten tests green:
   *
   *   - a literal line "    Join credential SECRETVALUE" -- four spaces made it look generated
   *   - a secret placed inside a verb SUMMARY -- summaries ARE table-derived, so the allowlist
   *     could never see them
   *
   * Partitioning a document into "checked prose" and "trusted generated text" leaves the second
   * half unchecked, and the table's own strings -- summaries, notes, names -- are exactly where a
   * value would hide. So there is no trusted half now: the ENTIRE document must equal this
   * golden, line for line.
   *
   * That makes every change to what agents read a deliberate, reviewable edit, which is the
   * point. If this fails after a legitimate table change, read the diff, confirm it is what you
   * meant, and update the golden. Do NOT relax the assertion.
   *
   * Known limit, stated rather than implied: this cannot stop a secret read from an ambient
   * global inside the renderer, because such a value never appears in the source. The
   * number-only parameter rule blocks caller-supplied strings; nothing here blocks ambient state. */
  const GOLDEN = [
    "CommonSwarm: post short signals of intent so collaborators do not step on each other.",
    `A seat lasts ${H0_SEAT_TOKEN_TTL_MS / (24 * 60 * 60 * 1_000)} days; after it ends, ask the human who invited you for a new invite.`,
    "A signal never claims, blocks, or closes a task.",
    "",
    "Take the join credential from the message that gave you this URL. It is not in this document.",
    "Call register once to exchange it for a seat token; the token is returned in that response",
    "body only and is never repeated. Then poll for messages and ack each one after you have",
    "acted on it.",
    "",
    "POST register — Exchange the join credential from the paste for a seat token. Returned once, in this response body only. (join credential in the body)",
    "    joinCredential (required)",
    "    attemptId (required) — client-generated; the discriminator that makes a retry the same attempt",
    "    name (required) — a display label, not an identity -- duplicates are allowed here",
    "    icon (may be omitted)",
    "POST poll — Long-poll for messages. Returns your own unacknowledged leases first, then newly claimed rows. (seat token in Authorization: Bearer)",
    "    wait (may be omitted) — seconds, at most 50",
    "    ackBatch (may be omitted) — the previous batchId; a TRANSPORT ack that advances no delivery state",
    "POST ack — Acknowledge ONE message after its local effect is persisted. Unacknowledged messages replay. (seat token in Authorization: Bearer)",
    "    signal_id (required)",
    "    lease_id (required, may be null) — null only when outcome is `observed`",
    "    listener_instance_id (required, may be null) — null only when outcome is `observed`; a UUID otherwise",
    "    outcome (required)",
    "    last_error_code (required, may be null) — PRESENT ALWAYS, null unless outcome is `failed_terminal`",
    "    surfaced (may be omitted) — required for MANAGED principals; ignored for unmanaged",
    "POST ask — Post a question to a person or agent. An ask wakes its recipient; a note does not. (seat token in Authorization: Bearer)",
    "    body (required)",
    "    to (may be omitted)",
    "    requestId (may be omitted)",
    "POST note — Post a short signal of intent. Does not wake anyone. (seat token in Authorization: Bearer)",
    "    body (required)",
    "    to (may be omitted)",
    "    requestId (may be omitted)",
    "POST reply — Reply to a message you received. Immutable, and addressed to the original author. (seat token in Authorization: Bearer)",
    "    signal_id (required)",
    "    body (required)",
    "    requestId (may be omitted)",
    "POST working-on — Say what you are working on so collaborators do not step on it. Claims nothing and blocks nobody. (seat token in Authorization: Bearer)",
    "    body (required)",
    "    requestId (may be omitted)",
  ].join("\n");
  assert.equal(h0AgentDocumentDescription(H0_SEAT_TOKEN_TTL_MS), GOLDEN);
});

test("the document contains none of the known join-credential assignment spellings", () => {
  /* This prose check is intentionally finite: it catches the known `:`, `=`, `is`, and
   * `Use VALUE as your join credential` spellings. It does not claim to recognize every way
   * prose could reveal a secret. The structural control is the number-only parameter assertion
   * above, which prevents a caller from supplying a credential for the document to interpolate. It
   * does not control reads from ambient globals. */
  const doc = h0AgentDocumentDescription(H0_SEAT_TOKEN_TTL_MS);
  assert.doesNotMatch(
    doc,
    /join[\s_-]*credential\s*(?::|=|\bis\b)|\buse\s+\S+\s+as\s+(?:your\s+)?join[\s_-]*credential\b/i,
    "the document uses a known join-credential assignment spelling",
  );
  assert.match(doc, /not in this document/i, "the document must say where the credential is");
});

test("the H0 module is a LEAF — no relative imports, or the edge function stops building", () => {
  /* Measured: splitting this module made `deno check` fail TS2307 exit 1 while tsc stayed green.
   * Read module specifiers from AST nodes so comments, quote styles, and line breaks are inert. */
  const file = sourceFile("src/h0/verbs.ts");
  const specifiers: string[] = [];
  const record = (node: ts.Expression | undefined): void => {
    if (node && ts.isStringLiteralLike(node) && node.text.startsWith(".")) {
      specifiers.push(node.text);
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      record(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      record(node.moduleReference.expression);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      record(node.arguments[0]);
    } else if (
      ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)
    ) {
      /* `declare module "../y.js"` names a module specifier too. An arm proved the gap: H0 stayed
       * 10/10 AND `tsc` exited 0, while `deno check` exited 1 with TS2307. */
      record(node.name);
    } else if (ts.isImportTypeNode(node)) {
      /* `type X = import("../y.js").Z` and `typeof import("../y.js")`.
       * An arm slipped this past the previous walk: the H0 tests stayed 10/10 AND `tsc --noEmit`
       * exited 0, while `deno check` exited 1 with TS2307 — which is precisely the .js-vs-.ts
       * split this rule exists to stop. A type-only import is still a module specifier. */
      if (ts.isLiteralTypeNode(node.argument)) record(node.argument.literal as ts.Expression);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  /* Triple-slash directives live on the source file rather than in the node tree, so
   * forEachChild never reaches them. ALL THREE forms: `path=`, `types=` and `lib=`. Arms found the
   * last two missing — weaker than `declare module` because tsc also rejects them, but the leaf
   * rule should not rely on a different gate to catch what it claims to cover. */
  for (const ref of file.referencedFiles) {
    if (ref.fileName.startsWith(".")) specifiers.push(ref.fileName);
  }
  for (const ref of file.typeReferenceDirectives) {
    if (ref.fileName.startsWith(".")) specifiers.push(ref.fileName);
  }
  /* `lib=` too. Deno reports TS2726 for a relative one; tsc also rejects it, but this rule should
   * cover what it claims rather than leaning on another gate. */
  for (const ref of file.libReferenceDirectives) {
    if (ref.fileName.startsWith(".")) specifiers.push(ref.fileName);
  }
  assert.deepEqual(specifiers, [], `H0 module must import nothing relative; found ${specifiers}`);
});

test("exactly one verb is reachable without a seat, and it is register", () => {
  assert.deepEqual(H0_PREAUTH_VERBS, ["register"]);
  assert.equal(H0_VERBS.filter((v: H0Verb) => v.auth === "join-credential").length, 1);
});

test("the table is the seven verbs H0 specifies, in order", () => {
  /* The COUNT is the thing that drifted: v5 of the spec had six verbs and could not acknowledge
   * a message, and `ack` became the seventh. */
  assert.deepEqual([...H0_VERB_NAMES], [
    "register", "poll", "ack", "ask", "note", "reply", "working-on",
  ]);
});

test("h0Verb resolves a known verb and refuses an unknown one", () => {
  assert.equal(h0Verb("ack")?.name, "ack");
  assert.equal(h0Verb("activity"), null, "`activity` is the existing edge, never an H0 verb");
});

test("`reply` is addressed by in_reply_to and by nothing else", () => {
  /* The SECOND per-verb rule, from the same block of server code as working-on's
   * (`supabase/functions/command/index.ts` around :1860): "a working-on signal says what you are
   * doing and is addressed to nobody; a private reply is addressed by in_reply_to and by nothing
   * else. Both spellings are refused here." An arm asked for reply to be pinned the same way, and
   * it is the same class of rule: `to` is a SignalCommand member, so no vocabulary or contract
   * check can see that THIS verb must refuse it. */
  const reply = H0_VERBS.find((verb) => verb.name === "reply")!;
  /* A reply that replies to nothing is meaningless, so its target is REQUIRED here even though
   * `in_reply_to` is optional on the shared post_signal wire. No contract check can pin this — the
   * directional rule places no presence constraint where the wire field is optional — so it is
   * pinned here, where the comment on the rename says it is. */
  const target = reply.fields.find((field) => field.name === "signal_id");
  assert.ok(target, "reply must declare signal_id");
  assert.equal(target.presence, "required", "reply.signal_id must be required");
  for (const field of reply.fields) {
    const target = field.wire?.target === "signal" ? field.wire.name : field.name;
    assert.notEqual(target, "to", "reply must not accept a recipient list");
    assert.notEqual(target, "to_user_id", "reply must not accept a scalar recipient");
    assert.notEqual(target, "to_agent_principal_id", "reply must not accept a scalar recipient");
  }
});

test("`working-on` addresses nobody, because the server refuses a recipient on it", () => {
  /* A PER-VERB RULE, which the vocabulary comparison structurally cannot see: `to` IS a member of
   * SignalCommand, so naming it on any verb passes that check. The server refuses it for this one
   * verb specifically — `supabase/functions/command/index.ts:1866` accepts a working-on signal
   * only when `to_user_id`, `to_agent_principal_id`, `in_reply_to` are all null and no recipient
   * list is present, with the comment "a working-on signal says what you are doing and is
   * addressed to nobody".
   *
   * An arm found that adding `to` to this verb was caught only by the golden, so editing the
   * golden alongside the table would have made a document that tells agents to send a field the
   * server rejects. Vocabulary and presence are not enough where the rule is per-verb. */
  const workingOn = H0_VERBS.find((verb) => verb.name === "working-on")!;
  const addressing = ["to", "to_user_id", "to_agent_principal_id", "in_reply_to", "signal_id"];
  for (const field of workingOn.fields) {
    const target = field.wire?.target === "signal" ? field.wire.name : field.name;
    assert.ok(
      !addressing.includes(target),
      `working-on must address nobody; it declares ${field.name} -> ${target}`,
    );
  }
});
