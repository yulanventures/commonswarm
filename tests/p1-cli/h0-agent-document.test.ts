import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  H0_VERBS,
  h0AgentDocumentDescription,
  type H0Verb,
} from "../../src/h0/verbs.js";
import {
  buildH0AgentDocument,
  handleH0Request,
  internalErrorResponse,
  h0RetryableDatabaseFailure,
  fieldJsonTypeNames,
  stringFieldNames,
} from "../../supabase/functions/h0/core.js";

import {
  SIGNAL_RECIPIENT_KINDS,
  SIGNAL_RECIPIENT_MAX,
} from "../../supabase/functions/_shared/channels.js";
import {
  DELIVERY_ACK_OUTCOMES,
  DELIVERY_CLIENT_ERROR_CODES,
} from "../../supabase/functions/command/durable-delivery.js";
import { H0_SEAT_TOKEN_TTL_MS } from "../../src/protocol/index.js";

test("H0 transient database SQLSTATEs return the shared retryable response", { timeout: 5_000 }, async () => {
  for (const code of ["40001", "40P01"]) {
    const response = h0RetryableDatabaseFailure({ code });
    assert.ok(response);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "h0_transaction_retryable" });
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow, noarchive");
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  }
  assert.equal(h0RetryableDatabaseFailure({ code: "42501" }), null);
  assert.equal(h0RetryableDatabaseFailure(new Error("database unavailable")), null);
});

/* The enforcement's own constants — the same four index.ts passes. */
const WIRE = {
  recipientKinds: SIGNAL_RECIPIENT_KINDS,
  recipientMax: SIGNAL_RECIPIENT_MAX,
  ackOutcomes: DELIVERY_ACK_OUTCOMES,
  ackErrorCodes: DELIVERY_CLIENT_ERROR_CODES,
};

function agentDescription(): string {
  return h0AgentDocumentDescription(H0_SEAT_TOKEN_TTL_MS);
}

function agentDocument(): Record<string, unknown> {
  return buildH0AgentDocument(H0_VERBS, agentDescription(), WIRE);
}

function documentPaths(document: Record<string, unknown>): string[] {
  return Object.keys(document.paths as Record<string, unknown>).sort();
}

test("agent document paths are generated from the H0 verb table", () => {
  const document = agentDocument();
  assert.deepEqual(
    documentPaths(document),
    H0_VERBS.map((verb) => `/${verb.name}`).sort(),
  );
  assert.equal(
    (document.info as Record<string, unknown>).description,
    agentDescription(),
  );

  // This mutation control proves a new table entry reaches the document without
  // adding its name to the expected list or changing the generator.
  const addedVerb: H0Verb = {
    name: "mutation-control-verb",
    auth: "seat-token",
    summary: "Only used to prove that path generation follows the table.",
    fields: [],
  };
  const mutatedTable = [...H0_VERBS, addedVerb];
  assert.deepEqual(
    documentPaths(
      buildH0AgentDocument(mutatedTable, agentDescription(), WIRE),
    ),
    mutatedTable.map((verb) => `/${verb.name}`).sort(),
  );
  assert.ok(
    documentPaths(
      buildH0AgentDocument(mutatedTable, agentDescription(), WIRE),
    ).includes(
      `/${addedVerb.name}`,
    ),
  );
});

test("agent document response never reflects a locator or credential value", async () => {
  const credential = "swm_join_AbCdEf0123456789_SECRET";
  const spellings = [
    credential,
    credential.toLowerCase(),
    credential.toUpperCase(),
    encodeURIComponent(credential),
  ];
  const bodies: string[] = [];

  for (const spelling of spellings) {
    const response = handleH0Request(
      new Request(`https://api.commonswarm.com/functions/v1/h0/agent-doc/${spelling}`),
      agentDocument(),
    );
    assert.equal(response.status, 200);
    const body = await response.text();
    bodies.push(body);
    for (const forbidden of spellings) {
      assert.equal(body.includes(forbidden), false);
      /* HEADERS TOO. An arm noted this checked only the body, so a value echoed into a header
       * would have passed a test whose name says the response never reflects a locator. */
      for (const [, value] of response.headers) {
        assert.equal(value.includes(forbidden), false, `header reflects ${forbidden}`);
      }
    }
  }
  assert.equal(new Set(bodies).size, 1, "every locator names the same document");
});

test("every H0 response disables caching and indexing", () => {
  const requests = [
    new Request("https://api.commonswarm.com/functions/v1/h0/agent-doc/public-locator"),
    new Request("https://api.commonswarm.com/functions/v1/h0/agent-doc/public-locator", {
      method: "POST",
    }),
    new Request("https://api.commonswarm.com/functions/v1/h0/not-a-route"),
  ];

  for (const request of requests) {
    const response = handleH0Request(request, agentDocument());
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(
      response.headers.get("x-robots-tag"),
      "noindex, nofollow, noarchive",
    );
  }
});

test("unknown paths and unsupported methods return clean JSON errors", async () => {
  const notFound = handleH0Request(
    new Request("https://api.commonswarm.com/functions/v1/h0/register"),
    agentDocument(),
  );
  assert.equal(notFound.status, 404);
  assert.deepEqual(await notFound.json(), { error: "not_found" });

  const notAllowed = handleH0Request(
    new Request("https://api.commonswarm.com/functions/v1/h0/agent-doc/public-locator", {
      method: "DELETE",
    }),
    agentDocument(),
  );
  assert.equal(notAllowed.status, 405);
  assert.deepEqual(await notAllowed.json(), { error: "method_not_allowed" });
});

test("the document is served on BOTH the public path and the gateway-stripped path", async () => {
  /* THE CONTROL THAT WAS MISSING, and its absence would have shipped a function that 404s on
   * every real request while this suite stayed green.
   *
   * The public URL is /functions/v1/h0/agent-doc/<locator>. Kong strips that prefix
   * (`strip_path: true` in the supabase CLI's own gateway template) and the serve worker routes
   * on pathname.split("/")[1], so the DEPLOYED function receives /h0/agent-doc/<locator>.
   * The first version matched only the public shape.
   *
   * The lesson is bigger than the regex: these tests BUILD the Request, so they hand the matcher
   * exactly the shape its author imagined. A suite that supplies the input the code expects
   * cannot discover that production supplies a different one. Asserting BOTH shapes is what makes
   * this a control instead of a restatement of the author's assumption. A review arm found the
   * original by reading the gateway template; no test run could have.
   *
   * NOT ESTABLISHED: no live `functions deploy` or `functions serve` request was made. This is
   * established from the CLI's Kong template and the serve worker, not from production. */
  const document = buildH0AgentDocument(H0_VERBS, agentDescription(), WIRE);
  const paths = [
    "https://api.commonswarm.com/functions/v1/h0/agent-doc/abc123",
    "https://api.commonswarm.com/h0/agent-doc/abc123",
  ];
  const bodies: string[] = [];
  for (const url of paths) {
    const response = handleH0Request(new Request(url), document);
    assert.equal(response.status, 200, `${url} must serve the document, not 404`);
    bodies.push(await response.text());
  }
  assert.equal(new Set(bodies).size, 1, "both paths must serve the identical document");
});

test("every table field is EITHER typed OR declared string — an exact partition", () => {
  /* A second catalog is allowed only while it is TOTAL and declared. An arm found the first
   * version typing `wait` and `surfaced` by name inside the schema builder -- knowledge about the
   * table living outside the table, which is the defect this item exists to prevent. */
  /* THE DIRECTION WAS INVERTED AND AN ARM CAUGHT IT. This asserted only that every DECLARED type
   * names a real field -- so a new field added to the table matched nothing, fell through to the
   * "string" default, and this test stayed green while the comment beside it claimed the catalog
   * was total. A green control defending a false claim.
   *
   * Both directions now, as an exact partition: every table field is typed or explicitly string,
   * never neither and never both. */
  const tableFields = [...new Set(H0_VERBS.flatMap((v) => v.fields.map((f) => f.name)))].sort();
  const typed = fieldJsonTypeNames();
  const strings = stringFieldNames();
  /* Deduplicate ONLY after checking for duplicates. An arm noted that `new Set` would silently
   * collapse a name repeated inside STRING_FIELDS, so the partition would pass while the list
   * quietly disagreed with itself. */
  assert.equal(new Set(strings).size, strings.length, "STRING_FIELDS contains a duplicate");
  assert.equal(new Set(typed).size, typed.length, "FIELD_JSON_TYPES contains a duplicate");
  const classified = [...new Set([...typed, ...strings])].sort();
  assert.deepEqual(classified, tableFields, "every table field must be typed or declared string");
  for (const name of typed) {
    assert.ok(!strings.includes(name), `${name} is both typed and declared string`);
  }
});

test("error responses carry the no-store and robots headers too", () => {
  /* Test 3 only ever checked a 200. An arm noted the 500 path was never exercised. */
  const document = buildH0AgentDocument(H0_VERBS, agentDescription(), WIRE);
  const cases = [
    handleH0Request(new Request("https://api.commonswarm.com/h0/nope"), document),
    handleH0Request(
      new Request("https://api.commonswarm.com/h0/agent-doc/x", { method: "DELETE" }),
      document,
    ),
    internalErrorResponse(),
  ];
  for (const response of cases) {
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(
      response.headers.get("x-robots-tag"),
      "noindex, nofollow, noarchive",
    );
  }
});

test("HEAD and OPTIONS work, because the link must be safe to UNFURL", () => {
  /* An arm found the first version answering 405 to HEAD. Slack, Discord and X issue HEAD before
   * GET to read content-type and cache-control, so 405 breaks the unfurl the design explicitly
   * wants — the spec's words are "safe to prefetch, unfurl or scan". This is the control for that
   * requirement, which nothing previously tested.
   *
   * HEAD returns the GET's status and headers with a NULL body, per the HTTP spec. */
  const document = buildH0AgentDocument(H0_VERBS, agentDescription(), WIRE);
  const url = "https://api.commonswarm.com/h0/agent-doc/abc";

  const head = handleH0Request(new Request(url, { method: "HEAD" }), document);
  assert.equal(head.status, 200, "an unfurler's HEAD must not be refused");
  assert.equal(head.body, null, "HEAD carries no body");
  assert.equal(head.headers.get("cache-control"), "no-store");

  const options = handleH0Request(new Request(url, { method: "OPTIONS" }), document);
  assert.equal(options.status, 204, "preflight must not 405");
  assert.equal(options.headers.get("access-control-allow-methods"), "GET, HEAD, OPTIONS");

  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
    const refused = handleH0Request(new Request(url, { method }), document);
    assert.equal(refused.status, 405, `${method} must be refused`);
    /* RFC 9110 15.5.6: a 405 MUST say which methods are allowed. */
    assert.equal(refused.headers.get("allow"), "GET, HEAD, OPTIONS");
  }
});

test("the agent document GET is readable cross-origin", () => {
  /* A wildcard origin is safe ONLY because this document authorises nothing, carries no secret,
   * and reads no cookie or Authorization header. Without it a browser agent or OpenAPI viewer is
   * blocked from a document that is already public. Pinned here so that if a future lane adds an
   * endpoint that DOES carry a credential, copying this header is a visible, deliberate act. */
  const document = buildH0AgentDocument(H0_VERBS, agentDescription(), WIRE);
  const response = handleH0Request(
    new Request("https://api.commonswarm.com/h0/agent-doc/abc"),
    document,
  );
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
});

/* ---------------------------------------------------------------------------------------------
 * Wire type extraction, by AST. Comments and formatting are inert.
 * ------------------------------------------------------------------------------------------- */
type WireKind = "string" | "number" | "boolean" | "array";
interface WireMember { optional: boolean; nullable: boolean; kind: WireKind }

function wireMembers(rel: string, interfaceName: string, expectedMembers: number): Map<string, WireMember> {
  const path = fileURLToPath(new URL(`../../${rel}`, import.meta.url));
  const file = ts.createSourceFile(rel, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  let found: ts.InterfaceDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === interfaceName) found = node;
    ts.forEachChild(node, visit);
  };
  visit(file);
  assert.ok(found, `interface ${interfaceName} not found in ${rel} — the enforcement moved`);
  const members = new Map<string, WireMember>();
  for (const member of found.members) {
    if (!ts.isPropertySignature(member) || !member.type || !ts.isIdentifier(member.name)) continue;
    let node = member.type;
    let nullable = false;
    if (ts.isUnionTypeNode(node)) {
      const rest = node.types.filter((part) =>
        !(ts.isLiteralTypeNode(part) && part.literal.kind === ts.SyntaxKind.NullKeyword)
      );
      nullable = rest.length !== node.types.length;
      if (rest.length === 1) node = rest[0]!;
    }
    const kind: WireKind = ts.isArrayTypeNode(node)
      ? "array"
      : node.kind === ts.SyntaxKind.BooleanKeyword
      ? "boolean"
      : node.kind === ts.SyntaxKind.NumberKeyword
      ? "number"
      : "string";
    members.set(member.name.text, { optional: member.questionToken !== undefined, nullable, kind });
  }
  /* An EXACT count, not a floor: a floor detects an empty extraction but not a partial one. */
  assert.equal(members.size, expectedMembers, `extracted ${members.size} members of ${interfaceName}`);
  return members;
}

test("every field's JSON TYPE matches the wire member it maps to", () => {
  /* THE CONTROL THAT WAS MISSING, and its absence shipped a lie past two review arms.
   *
   * Every earlier version typed `to` as a string. The wire is `to?: SignalRecipient[]`, and
   * parseSignalRecipients returns null for anything but that array, so an agent following the
   * document would send a value the server refuses. The partition test was green throughout: it
   * proves every field is CLASSIFIED, not that the classification is RIGHT. A golden would have
   * been green too — it pins whatever the document says now, errors included, and I only caught
   * this by reading the golden before pinning it.
   *
   * So the JSON type is compared to the wire member's TypeScript type, read by AST. Known limit,
   * stated: a type REFERENCE (e.g. `DeliveryAckOutcome`, `SignalKind`) is read as "string", which
   * holds for every reference these verbs reach today and would misread an object type. */
  const document = agentDocument() as { paths: Record<string, any> };
  const wires: Record<string, Map<string, WireMember>> = {
    ack: wireMembers("supabase/functions/command/durable-delivery.ts", "AckAgentDeliveryCommand", 7),
    signal: wireMembers("supabase/functions/command/index.ts", "SignalCommand", 13),
  };
  const verbWire: Record<string, "ack" | "signal"> = {
    ack: "ack", ask: "signal", note: "signal", reply: "signal", "working-on": "signal",
  };
  let compared = 0;
  for (const verb of H0_VERBS) {
    const wire = verbWire[verb.name];
    if (!wire) continue; /* register and poll have no enforcement yet */
    const properties = document.paths[`/${verb.name}`].post.requestBody
      .content["application/json"].schema.properties;
    for (const field of verb.fields) {
      if (field.wire?.target === "command-envelope") continue;
      const wireName = field.wire?.target === "signal" ? field.wire.name : field.name;
      const member = wires[wire]!.get(wireName);
      assert.ok(member, `${verb.name}.${field.name}: no wire member ${wireName}`);
      const declared = properties[field.name].type;
      const base = Array.isArray(declared) ? declared.filter((t: string) => t !== "null")[0] : declared;
      const jsonKind = base === "integer" ? "number" : base;
      assert.equal(
        jsonKind,
        member.kind,
        `${verb.name}.${field.name}: document says ${base}, wire ${wireName} is ${member.kind}`,
      );
      /* NULLABILITY, in the unsafe direction: the document may be stricter than the wire (refuse a
       * null the server would accept, on a field the agent can simply omit) but must never tell an
       * agent null is allowed where the server refuses it. An arm noted the first version of this
       * test computed nullability and never asserted it. */
      if (Array.isArray(declared) && declared.includes("null")) {
        assert.ok(member.nullable, `${verb.name}.${field.name}: document allows null, wire ${wireName} does not`);
      }
      compared++;
    }
  }
  assert.ok(compared >= 12, `compared only ${compared} fields — the mapping lost fields`);
});

test("an unclassified field THROWS where the schema is built, independent of the partition test", () => {
  /* An arm deleted the runtime throw in fieldSchema and every test stayed green, because every
   * current field is classified. The throw needs its own control: build from a table that carries
   * a field neither typed nor declared string. */
  const register = H0_VERBS.find((verb) => verb.name === "register")!;
  const mutated = [{
    ...register,
    fields: [...register.fields, { name: "unclassified_probe", presence: "omittable", nullable: false }],
  }] as unknown as typeof H0_VERBS;
  assert.throws(
    () => buildH0AgentDocument(mutated, agentDescription(), WIRE),
    /unclassified_probe.*neither typed nor declared a string field/,
  );
});

test("the OPTIONS preflight carries the no-store, robots and CORS headers", () => {
  /* An arm stripped these from OPTIONS only and every test stayed green. */
  const response = handleH0Request(
    new Request("https://api.commonswarm.com/h0/agent-doc/abc", { method: "OPTIONS" }),
    agentDocument(),
  );
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow, noarchive");
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
});

test("the whole served OpenAPI document equals its REVIEWED golden", async () => {
  /* Pins every schema, summary, security block and required list, which the path-key test does
   * not. READ THIS BEFORE UPDATING THE FIXTURE: a golden pins whatever the document says, errors
   * included. The first attempt at this fixture would have pinned `to` as a string. When it fails,
   * read the diff against the wire, not just against your intent. */
  const golden = JSON.parse(readFileSync(
    fileURLToPath(new URL("./fixtures/h0-agent-document.golden.json", import.meta.url)),
    "utf8",
  ));
  /* Through the real handler, not only the builder: an arm noted the builder-only version would
   * stay green if the handler served something else. */
  const response = handleH0Request(
    new Request("https://api.commonswarm.com/h0/agent-doc/abc"),
    agentDocument(),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), golden);
});

test("index.ts passes the ENFORCEMENT's wire constants, not a copy", () => {
  /* core.ts takes the wire rule as an argument so it can stay a leaf. That moves the risk to the
   * call site: index.ts could pass a typed copy and every other test would stay green, because the
   * tests pass the real constants themselves. So the wiring is pinned by AST: each property of the
   * third argument must be the named constant, imported from its server module, and not shadowed
   * by a local declaration of the same name. */
  const rel = "supabase/functions/h0/index.ts";
  const file = ts.createSourceFile(
    rel,
    readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const imported = new Map<string, string>();
  const declaredLocally: string[] = [];
  let passed: Record<string, string> | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) &&
      node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)
    ) {
      for (const element of node.importClause.namedBindings.elements) {
        imported.set(element.name.text, node.moduleSpecifier.text);
      }
    }
    /* A local declaration of the same name would shadow the import and pass an identifier check
     * while passing a typed copy. An arm raised exactly that. */
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) declaredLocally.push(node.name.text);
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
      declaredLocally.push(node.name.text);
    }
    if (
      ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
      node.expression.text === "buildH0AgentDocument"
    ) {
      const rule = node.arguments[2];
      assert.ok(rule && ts.isObjectLiteralExpression(rule), "third argument must be an object literal");
      passed = {};
      for (const property of rule.properties) {
        if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name)) {
          passed[property.name.text] = ts.isIdentifier(property.initializer)
            ? property.initializer.text
            : `<${ts.SyntaxKind[property.initializer.kind]}>`;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  const expected = {
    recipientKinds: ["SIGNAL_RECIPIENT_KINDS", "../_shared/channels.ts"],
    recipientMax: ["SIGNAL_RECIPIENT_MAX", "../_shared/channels.ts"],
    ackOutcomes: ["DELIVERY_ACK_OUTCOMES", "../command/durable-delivery.ts"],
    ackErrorCodes: ["DELIVERY_CLIENT_ERROR_CODES", "../command/durable-delivery.ts"],
  } as const;
  assert.deepEqual(
    passed,
    Object.fromEntries(Object.entries(expected).map(([key, [name]]) => [key, name])),
  );
  for (const [name, module] of Object.values(expected)) {
    assert.equal(imported.get(name), module, `${name} must be imported from ${module}`);
    assert.ok(!declaredLocally.includes(name), `${name} is redeclared locally and shadows the import`);
  }
});

test("closed sets are served as the SERVER's sets: outcome, last_error_code, and the recipient item", () => {
  /* The type test reads a named type reference such as DeliveryAckOutcome as "string", so it cannot
   * see a closed set typed as an open string. That is how `outcome` stayed open. The values are
   * compared here to the server's own constants, and the recipient item's properties to the
   * SignalRecipient interface read by AST — an arm noted `to` was checked only as "array", so a
   * wrong item schema would have passed. */
  const document = agentDocument() as { paths: Record<string, any> };
  const props = (verb: string) =>
    document.paths[`/${verb}`].post.requestBody.content["application/json"].schema.properties;

  assert.deepEqual(props("ack").outcome.enum, [...DELIVERY_ACK_OUTCOMES]);
  assert.deepEqual(props("ack").last_error_code.enum, [...DELIVERY_CLIENT_ERROR_CODES, null]);
  assert.deepEqual(props("ack").last_error_code.type, ["string", "null"]);

  const recipient = wireMembers("supabase/functions/_shared/channels.ts", "SignalRecipient", 2);
  for (const verb of ["ask", "note"]) {
    const item = props(verb).to.items;
    assert.deepEqual(Object.keys(item.properties).sort(), [...recipient.keys()].sort(),
      `${verb}.to item properties must be exactly SignalRecipient's members`);
    assert.deepEqual([...item.required].sort(), [...recipient.entries()]
      .filter(([, member]) => !member.optional).map(([name]) => name).sort());
    assert.equal(item.additionalProperties, false, "isRecipientEntry refuses any extra key");
    assert.deepEqual(item.properties.kind.enum, [...SIGNAL_RECIPIENT_KINDS]);
    assert.equal(props(verb).to.maxItems, SIGNAL_RECIPIENT_MAX);
  }
});
