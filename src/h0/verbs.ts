/*
 * The H0 verb table. ONE source for the seven verbs a link-joined agent can call.
 *
 * The agent document's prose is RENDERED from this table. A strict parser test rejects extra,
 * omitted, or malformed document field lines. AGENTS.md records why that control exists and the
 * four times an unbound list shipped (v0.1.48-v0.1.50), each time AFTER two review arms passed:
 * the arms catch wrong logic and miss a wrong LIST inside a correct-looking sentence.
 *
 * READ THIS BEFORE TRUSTING THE GENERATOR. Rendering normally keeps the document and table in
 * step, while the strict parser controls the renderer. Neither can make the table match the code
 * the verbs reach. That circularity is not hypothetical:
 * the first version of this lane shipped eight green tests, and a review arm gutted the `ack`
 * contract to `required: ["signal_id"], optional: ["made_up_field"]` with all eight still passing.
 * The non-circular controls compare this table to the command types at the enforcement boundary.
 * `ack` is checked field-for-field against `AckAgentDeliveryCommand`. The field vocabulary on
 * ask, note, reply, and working-on is checked against `SignalCommand`; this does not prove that
 * those adapter surfaces expose every input they need. Fields supplied by the command envelope
 * declare that separate target. Register and poll still have no independent contract comparison
 * in this lane.
 *
 * This is a SECOND catalog, deliberately. The CLI's 37 verbs keep their own dispatcher; item H
 * lane 1 folds this table into it. The fork is stated here rather than left for a reader to find,
 * so a URL-join does not wait on a 37-verb refactor.
 */

/** Whether a verb may be called before the caller holds a seat token. */
export type H0Auth =
  /** No seat yet. Authorised by the join credential in the request body. */
  | "join-credential"
  /** Seat token in `Authorization: Bearer`. Never a query string. */
  | "seat-token";

/*
 * PRESENCE AND NULLABILITY ARE SEPARATE AXES, and collapsing them is how the first version of
 * this table got `ack` wrong. It said `last_error_code` was "optional", which reads as "may be
 * omitted" -- but the command edge validates that wire with `exactKeys`
 * (supabase/functions/command/index.ts:1474-1482), which compares SORTED KEY LISTS FOR EQUALITY.
 * The key must be PRESENT; its VALUE may be null. A vocabulary that cannot state that contract
 * will state a wrong one.
 */
export interface H0Field {
  readonly name: string;
  /** May the KEY be absent from the request body? */
  readonly presence: "required" | "omittable";
  /** May the VALUE be null when the key IS present? */
  readonly nullable: boolean;
  /** A declared rename, including whether it targets the signal or its command envelope. */
  readonly wire?:
    | { readonly target: "signal"; readonly name: "in_reply_to" }
    | {
      readonly target: "command-envelope";
      readonly name: "command_id";
      readonly purpose: "idempotency-key";
    };
  /** Stated only where the contract is not obvious from the two flags. */
  readonly note?: string;
}

export interface H0Verb {
  /** Wire name: the path segment POSTed to, and the key in the generated document. */
  readonly name: string;
  readonly auth: H0Auth;
  /** One line, written for a model reading the document cold. */
  readonly summary: string;
  readonly fields: readonly H0Field[];
}

const req = (name: string, nullable = false, note?: string): H0Field =>
  note === undefined
    ? { name, presence: "required", nullable }
    : { name, presence: "required", nullable, note };

const opt = (name: string, nullable = false, note?: string): H0Field =>
  note === undefined
    ? { name, presence: "omittable", nullable }
    : { name, presence: "omittable", nullable, note };

const signalRename = (name: "in_reply_to"): H0Field["wire"] => ({
  target: "signal",
  name,
});

const idempotencyKey: H0Field["wire"] = {
  target: "command-envelope",
  name: "command_id",
  purpose: "idempotency-key",
};

export const H0_VERBS = [
  {
    name: "register",
    auth: "join-credential",
    summary:
      "Exchange the join credential from the paste for a seat token. Returned once, in this response body only.",
    fields: [
      req("joinCredential"),
      req("attemptId", false, "client-generated; the discriminator that makes a retry the same attempt"),
      req("name", false, "a display label, not an identity -- duplicates are allowed here"),
      opt("icon"),
    ],
  },
  {
    name: "poll",
    auth: "seat-token",
    summary:
      "Long-poll for messages. Returns your own unacknowledged leases first, then newly claimed rows.",
    fields: [
      opt("wait", false, "seconds, at most 50"),
      opt("ackBatch", false, "the previous batchId; a TRANSPORT ack that advances no delivery state"),
    ],
  },
  {
    name: "ack",
    auth: "seat-token",
    /*
     * The field set below is measured against the command edge's
     * `AckAgentDeliveryCommand` interface. The AST control checks name, presence, and
     * nullability for every member except `kind`, which the H0 verb name supplies.
     */
    summary:
      "Acknowledge ONE message after its local effect is persisted. Unacknowledged messages replay.",
    fields: [
      req("signal_id"),
      req("lease_id", true, "null only when outcome is `observed`"),
      req("listener_instance_id", true, "null only when outcome is `observed`; a UUID otherwise"),
      req("outcome"),
      req("last_error_code", true, "PRESENT ALWAYS, null unless outcome is `failed_terminal`"),
      opt("surfaced", false, "required for MANAGED principals; ignored for unmanaged"),
    ],
  },
  {
    name: "ask",
    auth: "seat-token",
    summary: "Post a question to a person or agent. An ask wakes its recipient; a note does not.",
    fields: [
      req("body"),
      opt("to"),
      { ...opt("requestId"), wire: idempotencyKey },
    ],
  },
  {
    name: "note",
    auth: "seat-token",
    summary: "Post a short signal of intent. Does not wake anyone.",
    fields: [
      req("body"),
      opt("to"),
      { ...opt("requestId"), wire: idempotencyKey },
    ],
  },
  {
    name: "reply",
    auth: "seat-token",
    summary: "Reply to a message you received. Immutable, and addressed to the original author.",
    fields: [
      { ...req("signal_id"), wire: signalRename("in_reply_to") },
      req("body"),
      { ...opt("requestId"), wire: idempotencyKey },
    ],
  },
  {
    name: "working-on",
    auth: "seat-token",
    summary:
      "Say what you are working on so collaborators do not step on it. Claims nothing and blocks nobody.",
    fields: [
      req("body"),
      { ...opt("requestId"), wire: idempotencyKey },
    ],
  },
] as const satisfies readonly H0Verb[];

export type H0VerbName = (typeof H0_VERBS)[number]["name"];

export const H0_VERB_NAMES: readonly H0VerbName[] = H0_VERBS.map((v) => v.name);

/** Derived, so it cannot drift from the table. */
export const H0_PREAUTH_VERBS: readonly H0VerbName[] = H0_VERBS
  .filter((v) => v.auth === "join-credential")
  .map((v) => v.name);

export function h0Verb(name: string): H0Verb | null {
  return H0_VERBS.find((v) => v.name === name) ?? null;
}

/* ---------------------------------------------------------------------------------------------
 * The agent document, GENERATED from H0_VERBS.
 *
 * THIS LIVES IN THE SAME FILE AS THE TABLE ON PURPOSE, and it is a constraint of this repo, not
 * a style choice. The H0 edge function will import this module, and an edge function is Deno: it
 * resolves `./verbs.ts`, while `tsc` emitting dist/ requires `./verbs.js`. No specifier satisfies
 * both, so every src module an edge function imports is a LEAF with zero relative imports --
 * which is what src/host/credential-redaction.ts and src/cloud/session-wire.ts already are.
 * Measured: splitting these two made `deno check` fail TS2307 and exit 1 while tsc stayed green.
 * ------------------------------------------------------------------------------------------- */

/*
 * ONE FIELD PER LINE, and that is a correctness choice rather than a layout one. The first
 * rendering joined fields with "; " and a field NOTE containing a semicolon split into two
 * phantom fields -- caught immediately by the document -> table control, which is the control
 * v1 of this lane did not have. A separator that can appear inside the values it separates is
 * not a separator. A line start cannot collide this way.
 */
function fieldLine(field: H0Field): string {
  const presence = field.presence === "required" ? "required" : "may be omitted";
  const nullable = field.nullable ? ", may be null" : "";
  const note = field.note ? ` — ${field.note}` : "";
  return `    ${field.name} (${presence}${nullable})${note}`;
}

function verbLines(verb: H0Verb): string[] {
  const auth = verb.auth === "join-credential"
    ? "join credential in the body"
    : "seat token in Authorization: Bearer";
  const head = `POST ${verb.name} — ${verb.summary} (${auth})`;
  if (verb.fields.length === 0) return [head, "    no fields"];
  return [head, ...verb.fields.map(fieldLine)];
}

export function h0AgentDocumentDescription(): string {
  return [
    "CommonSwarm: post short signals of intent so collaborators do not step on each other.",
    "A signal never claims, blocks, or closes a task.",
    "",
    "Take the join credential from the message that gave you this URL. It is not in this document.",
    "Call register once to exchange it for a seat token; the token is returned in that response",
    "body only and is never repeated. Then poll for messages and ack each one after you have",
    "acted on it.",
    "",
    ...H0_VERBS.flatMap(verbLines),
  ].join("\n");
}
