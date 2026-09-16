export const H0_CACHE_CONTROL = "no-store";
export const H0_ROBOTS_TAG = "noindex, nofollow, noarchive";

type JsonSchema = Record<string, unknown>;

/*
 * THIS MODULE MUST STAY A LEAF — no relative imports — because it is imported by the Deno edge
 * (index.ts) AND by Node tests through tsc. Deno needs `./x.ts`; tsc rejects it (TS5097). Importing
 * the recipient constants here broke `npm run check:tests` for exactly that reason, so the
 * enforcement's constants are passed IN by the caller instead. The argument is REQUIRED: a default
 * would be a typed copy of the rule, which is the defect this whole item exists to prevent.
 * index.ts passes the constants below from the server modules, and a test pins that by AST.
 */
export interface WireRule {
  /** SIGNAL_RECIPIENT_KINDS, supabase/functions/_shared/channels.ts */
  readonly recipientKinds: readonly string[];
  /** SIGNAL_RECIPIENT_MAX, supabase/functions/_shared/channels.ts */
  readonly recipientMax: number;
  /** DELIVERY_ACK_OUTCOMES, supabase/functions/command/durable-delivery.ts */
  readonly ackOutcomes: readonly string[];
  /** DELIVERY_CLIENT_ERROR_CODES, supabase/functions/command/durable-delivery.ts */
  readonly ackErrorCodes: Iterable<string>;
}

interface DocumentField {
  readonly name: string;
  readonly presence: "required" | "omittable";
  readonly nullable: boolean;
  readonly note?: string;
}

interface DocumentVerb {
  readonly name: string;
  readonly auth: "join-credential" | "seat-token";
  readonly summary: string;
  readonly fields: readonly DocumentField[];
}

/*
 * A SECOND CATALOG, declared as one and made total, rather than an inline chain of name tests.
 *
 * A review arm caught the first version typing `wait` and `surfaced` by field NAME inside this
 * function -- knowledge about the table's fields living somewhere other than the table. That is
 * the exact defect this whole item exists to prevent, reproduced inside the code meant to prevent
 * it. The real fix is a JSON type ON the H0 field, but H0Field belongs to the sibling lane; until
 * this branch rebases onto it, the mapping is at least EXPLICIT and a test asserts it covers every
 * field the table declares, so a new field cannot silently default to "string".
 */
function fieldJsonTypes(wire: WireRule): Record<string, JsonSchema> {
  return {
    wait: { type: "integer", minimum: 0, maximum: 50 },
    surfaced: { type: "boolean" },
    /*
     * CLOSED SETS, and they were typed as open strings. `outcome` is DeliveryAckOutcome — the server
     * refuses anything outside DELIVERY_ACK_OUTCOMES (command/index.ts:1583-1584). `last_error_code`
     * must be null unless the outcome is failed_terminal, and then one of DELIVERY_CLIENT_ERROR_CODES
     * (:1586-1589). An earlier commit left `outcome` open and wrote that the constants could not be
     * loaded under Node because durable-delivery.ts imports postgres. That was never run. Its only
     * import is `import type`, erased at runtime; tsx, tsc and deno check all load it (measured, exit
     * 0 each). An unmeasured negative, corrected. The conditional between the two fields is beyond a
     * per-field schema, so each field's note states it.
     */
    outcome: { type: "string", enum: [...wire.ackOutcomes] },
    last_error_code: { type: "string", enum: [...wire.ackErrorCodes, null] },
    /*
     * `to` IS AN ARRAY OF RECIPIENT OBJECTS, and every earlier version of this document said it was a
     * string. Both review arms passed that. The wire is `to?: SignalRecipient[]`
     * (supabase/functions/command/index.ts:236), each entry exactly `{ kind, id }`, and
     * `parseSignalRecipients` (supabase/functions/_shared/channels.ts:359) returns null for anything
     * that is not that array — so an agent following the document would send a value the server
     * refuses. The field had been put in STRING_FIELDS, and the partition test was green, because
     * the partition proves every field is CLASSIFIED, not that the classification is RIGHT.
     * I found it by reading the golden before pinning it: a snapshot pins whatever the document says
     * now, errors included. The kind enum is imported from the enforcement, never typed here.
     */
    to: {
      type: "array",
      /* Each bound read from the parser, never typed: an empty list is refused
       * (signalRecipientListProblem), so is more than SIGNAL_RECIPIENT_MAX, and so is the same
       * recipient twice. The server also folds `id` case before that duplicate check, which
       * `uniqueItems` cannot express — the schema is a guide to a valid body, the parser the law. */
      minItems: 1,
      maxItems: wire.recipientMax,
      uniqueItems: true,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "id"],
        properties: {
          kind: { type: "string", enum: [...wire.recipientKinds] },
          id: { type: "string", format: "uuid" },
        },
      },
    },
  };
}

/*
 * THE PARTITION IS THE CONTROL, and the first version did not have one.
 *
 * Listing only the non-string fields makes "is this field a string?" an answer by DEFAULT, and a
 * default is exactly what silently absorbs a new field. A review arm caught the test asserting
 * `declared is a subset of table` while the comment beside it claimed totality -- a green control
 * defending a false claim, which is the failure AGENTS.md names under "claim controls prove
 * stability, not truth". The test direction was mine and it was inverted.
 *
 * So every field in the table must appear in EXACTLY ONE of these two lists. A new field belongs
 * to neither until someone puts it in one, and the test fails until they do. Classifying a field
 * becomes a decision rather than an omission.
 */
const STRING_FIELDS: readonly string[] = [
  "joinCredential", "attemptId", "name", "icon", "ackBatch",
  "signal_id", "lease_id", "listener_instance_id",
  "body", "requestId",
];

export function fieldJsonTypeNames(): readonly string[] {
  return Object.keys(fieldJsonTypes({ recipientKinds: [], recipientMax: 0, ackOutcomes: [], ackErrorCodes: [] }));
}

export function stringFieldNames(): readonly string[] {
  return STRING_FIELDS;
}

function fieldSchema(field: DocumentField, wire: WireRule): JsonSchema {
  const declared = fieldJsonTypes(wire)[field.name];
  if (declared === undefined && !STRING_FIELDS.includes(field.name)) {
    /* NOT A DEFAULT. An arm noted that STRING_FIELDS was exported for the test and never read
     * here, so the partition was a test gate while the RUNTIME still fell through to "string" for
     * anything unclassified — the exact silent default the partition exists to remove, surviving
     * one layer down. An unclassified field is now a loud failure at build time in the only place
     * that matters: where the schema is actually produced. */
    throw new Error(
      `H0 field "${field.name}" is neither typed nor declared a string field; classify it in core.ts`,
    );
  }
  const base: JsonSchema = declared === undefined
    ? { type: "string" }
    : { ...declared };

  if (field.nullable) {
    base.type = [base.type, "null"];
  }
  if (field.note !== undefined) {
    base.description = field.note;
  }
  return base;
}

function requestSchema(verb: DocumentVerb, wire: WireRule): JsonSchema {
  const properties = Object.fromEntries(
    verb.fields.map((field) => [field.name, fieldSchema(field, wire)]),
  );
  const required = verb.fields
    .filter((field) => field.presence === "required")
    .map((field) => field.name);

  return {
    type: "object",
    additionalProperties: false,
    properties,
    ...(required.length === 0 ? {} : { required }),
  };
}

function verbPath(verb: DocumentVerb, wire: WireRule): Record<string, unknown> {
  return {
    post: {
      operationId: verb.name,
      summary: verb.summary,
      security: verb.auth === "seat-token" ? [{ seatToken: [] }] : [],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: requestSchema(verb, wire),
          },
        },
      },
      responses: {
        "200": { description: "Success" },
      },
    },
  };
}

/** Build the public, prefetch-safe document. No locator or secret is accepted. */
export function buildH0AgentDocument(
  verbs: readonly DocumentVerb[],
  description: string,
  wire: WireRule,
): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "CommonSwarm agent API",
      version: "0.1.0",
      description,
    },
    servers: [{ url: "/functions/v1/h0" }],
    paths: Object.fromEntries(
      verbs.map((verb) => [`/${verb.name}`, verbPath(verb, wire)]),
    ),
    components: {
      securitySchemes: {
        seatToken: {
          type: "http",
          scheme: "bearer",
        },
      },
    },
  };
}

function responseHeaders(): Headers {
  return new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": H0_CACHE_CONTROL,
    "x-robots-tag": H0_ROBOTS_TAG,
    /*
     * A WILDCARD ORIGIN IS SAFE HERE FOR THE SAME REASON THE LINK IS PREFETCH-SAFE: this document
     * authorises nothing, carries no secret, reads no cookie or Authorization header, and mutates
     * nothing, so there is no cross-origin capability to steal. Without it a browser-based agent
     * or any OpenAPI viewer is blocked by CORS from reading a document that is already public.
     * This must NOT be copied to the register or verb endpoints, which DO carry credentials.
     */
    "access-control-allow-origin": "*",
  });
}

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: responseHeaders(),
  });
}

/*
 * BOTH PATH SHAPES, and that is a production bug fix rather than tolerance for its own sake.
 *
 * The public URL is /functions/v1/h0/agent-doc/<locator>. Kong strips that prefix
 * (`strip_path: true` in the supabase CLI's own gateway template) and the serve worker routes on
 * `pathname.split("/")[1]`, so THE DEPLOYED FUNCTION SEES /h0/agent-doc/<locator>.
 *
 * The first version matched only the public shape. It answered 200 to every test and would have
 * answered 404 to every real request, because the tests build the Request themselves and hand the
 * matcher exactly the shape its author assumed. A suite that supplies the input the code expects
 * cannot discover that production supplies a different one. A review arm found this by reading the
 * gateway template, not by running the tests.
 */
const AGENT_DOCUMENT_PATH = /^(?:\/functions\/v1)?\/h0\/agent-doc\/[^/]+$/;

export function handleH0Request(
  request: Request,
  agentDocument: Record<string, unknown>,
): Response {
  const pathIsAgentDocument = AGENT_DOCUMENT_PATH.test(
    new URL(request.url).pathname,
  );
  if (!pathIsAgentDocument) {
    return json(404, { error: "not_found" });
  }
  if (request.method === "OPTIONS") {
    /* Preflight. Same reasoning as the wildcard origin above: nothing here is authorised. */
    const preflight = new Response(null, { status: 204, headers: responseHeaders() });
    preflight.headers.set("access-control-allow-methods", "GET, HEAD, OPTIONS");
    preflight.headers.set("access-control-allow-headers", "content-type");
    return preflight;
  }
  /*
   * HEAD IS NOT A GET WITH THE BODY THROWN AWAY HERE -- it is the request an unfurler makes.
   * A review arm found the first version answering 405 to HEAD, and the spec's requirement is
   * that the pasted link be SAFE TO PREFETCH, UNFURL OR SCAN. Slack, Discord and X issue HEAD
   * before GET to read content-type and cache-control; 405 breaks the unfurl the design
   * explicitly wants to work. HEAD returns the same status and headers with a null body, which
   * is what the HTTP spec asks for.
   */
  if (request.method !== "GET" && request.method !== "HEAD") {
    /* RFC 9110 15.5.6: a 405 MUST name the methods that are allowed. */
    const response = json(405, { error: "method_not_allowed" });
    response.headers.set("allow", "GET, HEAD, OPTIONS");
    return response;
  }
  const document = json(200, agentDocument);
  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers: document.headers });
  }
  return document;
}

export function internalErrorResponse(): Response {
  return json(500, { error: "internal_error" });
}
