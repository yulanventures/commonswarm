import assert from "node:assert/strict";
import test from "node:test";
import {
  H0_VERBS,
  h0AgentDocumentDescription,
  type H0Verb,
} from "../../src/h0/verbs.js";
import {
  buildH0AgentDocument,
  handleH0Request,
  internalErrorResponse,
  fieldJsonTypeNames,
  stringFieldNames,
} from "../../supabase/functions/h0/core.js";

function agentDocument(): Record<string, unknown> {
  return buildH0AgentDocument(H0_VERBS, h0AgentDocumentDescription());
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
    h0AgentDocumentDescription(),
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
      buildH0AgentDocument(mutatedTable, h0AgentDocumentDescription()),
    ),
    mutatedTable.map((verb) => `/${verb.name}`).sort(),
  );
  assert.ok(
    documentPaths(
      buildH0AgentDocument(mutatedTable, h0AgentDocumentDescription()),
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
  const document = buildH0AgentDocument(H0_VERBS, h0AgentDocumentDescription());
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
  const document = buildH0AgentDocument(H0_VERBS, h0AgentDocumentDescription());
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
  const document = buildH0AgentDocument(H0_VERBS, h0AgentDocumentDescription());
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

test("the public document is readable cross-origin, and nothing else borrows that", () => {
  /* A wildcard origin is safe ONLY because this document authorises nothing, carries no secret,
   * and reads no cookie or Authorization header. Without it a browser agent or OpenAPI viewer is
   * blocked from a document that is already public. Pinned here so that if a future lane adds an
   * endpoint that DOES carry a credential, copying this header is a visible, deliberate act. */
  const document = buildH0AgentDocument(H0_VERBS, h0AgentDocumentDescription());
  const response = handleH0Request(
    new Request("https://api.commonswarm.com/h0/agent-doc/abc"),
    document,
  );
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
});
