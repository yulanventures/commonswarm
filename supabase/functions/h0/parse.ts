/**
 * Parsers for the H0 poll and ack bodies.
 *
 * The poll key list lives HERE, and the verb
 * table lives in src/h0/verbs.ts. A test calls this parser and compares the
 * keys it accepts to the poll row. Neither side is rendered from the other.
 *
 * The ack key list is the same shape. Outcomes and error codes are passed in
 * by the caller from the delivery constants, so this file does not retype them.
 */
// @ts-ignore TS5097: Deno executes the source extension; the Node test gate follows this source.
import { H0_REGISTRATION_NAME_MAX, H0_REQUEST_ID_RE } from "../../../src/h0/verbs.ts";

export const H0_POLL_MAX_WAIT_SECONDS = 50;
/** Time after the wait for the handler to release the lock. */
export const H0_POLL_CLEANUP_MS = 5_000;
/** Makes the stored expiry strictly longer than wait plus cleanup. */
export const H0_POLL_LOCK_SLACK_MS = 1_000;
export const H0_POLL_BATCH_LIMIT = 10;

export const H0_POLL_WAIT_REFUSED = "h0_poll_wait_refused";
export const H0_POLL_WAIT_REFUSED_MESSAGE =
  "wait is seconds and must be an integer from 0 to 50. Omit wait to return immediately.";

export const H0_BEARER_QUERY_REFUSED = "h0_bearer_query_refused";
export const H0_BEARER_QUERY_REFUSED_MESSAGE =
  "Send the seat token in the Authorization header as Bearer. A token in the query string is refused.";

export const H0_POLL_IN_PROGRESS = "h0_poll_in_progress";
export const H0_POLL_IN_PROGRESS_STATUS = 409;
export const H0_POLL_IN_PROGRESS_MESSAGE =
  "A poll for this seat is already in progress. Wait for that poll to finish, then send one poll. A second poll does not take the other half of the inbox.";

/** This poll's own lock ended. A different code from a second poll overlapping the first. */
export const H0_POLL_LOCK_ENDED = "h0_poll_lock_ended";
export const H0_POLL_LOCK_ENDED_STATUS = 409;
export const H0_POLL_LOCK_ENDED_MESSAGE =
  "This poll's lock ended. Poll again.";

export const H0_ACK_BATCH_MISMATCH = "h0_ack_batch_mismatch";
export const H0_ACK_BATCH_MISMATCH_MESSAGE =
  "ackBatch does not match the active batch. Poll again without ackBatch.";

export const H0_ACK_BATCH_UNKNOWN = "h0_ack_batch_unknown";
export const H0_ACK_BATCH_UNKNOWN_MESSAGE =
  "ackBatch does not name a batch for this seat. Omit ackBatch to poll.";

export const H0_INVALID_REQUEST = "invalid_request";

const POLL_KEYS: readonly string[] = ["wait", "ackBatch"];
const ACK_REQUIRED_KEYS: readonly string[] = [
  "signal_id",
  "lease_id",
  "listener_instance_id",
  "outcome",
  "last_error_code",
];
const ACK_OMITTABLE_KEYS: readonly string[] = ["surfaced"];

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const QUERY_CREDENTIAL_KEYS = [
  "access_token",
  "token",
  "bearer",
  "authorization",
  "seat_token",
];

export interface H0PollBody {
  readonly wait: number;
  readonly ackBatch: string | null;
}

export interface H0AckBody {
  readonly signal_id: string;
  readonly lease_id: string | null;
  readonly listener_instance_id: string | null;
  readonly outcome: string;
  readonly last_error_code: string | null;
  readonly surfaced?: boolean;
}

export interface H0ParseFailure {
  readonly ok: false;
  readonly error: string;
  readonly message: string;
}

export interface H0AckWire {
  readonly ackOutcomes: readonly string[];
  readonly ackErrorCodes: Iterable<string>;
}

export type H0SeatVerb = "poll" | "ack";
export type H0ForwardVerb = "register" | "ask" | "note" | "reply" | "working-on";

/* Kept separate from the document table so the contract test can detect drift. */
const FORWARD_FIELDS: Record<H0ForwardVerb, {
  required: readonly string[];
  omittable: readonly string[];
}> = {
  register: { required: ["joinCredential", "attemptId", "name"], omittable: ["icon"] },
  ask: { required: ["body"], omittable: ["to", "requestId"] },
  note: { required: ["body"], omittable: ["to", "requestId"] },
  reply: { required: ["signal_id", "body"], omittable: ["requestId"] },
  "working-on": { required: ["body"], omittable: ["requestId"] },
};

export function parseH0ForwardBody(
  verb: H0ForwardVerb,
  value: unknown,
): { ok: true; body: Record<string, unknown> } | H0ParseFailure {
  const body = record(value);
  if (body === null) return fail(H0_INVALID_REQUEST, "The body must be a JSON object.");
  const fields = FORWARD_FIELDS[verb];
  const allowed = new Set([...fields.required, ...fields.omittable]);
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    return fail(H0_INVALID_REQUEST, "The body has an unknown field.");
  }
  if (fields.required.some((key) => !Object.hasOwn(body, key))) {
    return fail(H0_INVALID_REQUEST, "The body is missing a required field.");
  }
  if (Object.values(body).some((item) => item === null)) {
    return fail(H0_INVALID_REQUEST, "Null is not accepted for this verb.");
  }
  if (verb === "register") {
    if (typeof body.joinCredential !== "string" ||
      !isUuid(body.attemptId) ||
      typeof body.name !== "string" || body.name.length < 1 || body.name.length > H0_REGISTRATION_NAME_MAX ||
      (Object.hasOwn(body, "icon") && typeof body.icon !== "string")) {
      return fail(H0_INVALID_REQUEST, "Registration fields are malformed.");
    }
  } else {
    if (typeof body.body !== "string" || body.body.length < 1 ||
      (Object.hasOwn(body, "requestId") &&
        (typeof body.requestId !== "string" || !H0_REQUEST_ID_RE.test(body.requestId))) ||
      ((verb === "ask" || verb === "note") && Object.hasOwn(body, "to") &&
        (!Array.isArray(body.to) || body.to.length === 0)) ||
      (verb === "reply" && !isUuid(body.signal_id))) {
      return fail(H0_INVALID_REQUEST, "Signal fields are malformed.");
    }
  }
  return { ok: true, body };
}

export function h0PollLockDurationMs(waitSeconds: number): number {
  return waitSeconds * 1_000 + H0_POLL_CLEANUP_MS + H0_POLL_LOCK_SLACK_MS;
}

export function h0VerbPath(pathname: string): H0SeatVerb | H0ForwardVerb | null {
  const match = /^(?:\/functions\/v1)?\/h0\/(poll|ack|register|ask|note|reply|working-on)\/?$/.exec(pathname);
  if (match?.[1]) return match[1] as H0SeatVerb | H0ForwardVerb;
  return null;
}

/** True when the URL carries a bearer in the query string. The value is not used. */
export function h0BearerInQuery(url: URL): boolean {
  const names = new Set(
    [...url.searchParams.keys()].map((key) => key.toLowerCase()),
  );
  for (const key of QUERY_CREDENTIAL_KEYS) {
    if (names.has(key)) return true;
  }
  return /swm_(?:agt|join|cap|inv)_/i.test(url.search);
}

function fail(error: string, message: string): H0ParseFailure {
  return { ok: false, error, message };
}

function record(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export function parseH0PollBody(
  value: unknown,
): { ok: true; body: H0PollBody } | H0ParseFailure {
  const body = record(value);
  if (body === null) {
    return fail(H0_INVALID_REQUEST, "The poll body must be a JSON object.");
  }
  for (const key of Object.keys(body)) {
    if (!POLL_KEYS.includes(key)) {
      return fail(
        H0_INVALID_REQUEST,
        "The poll body accepts wait and ackBatch only.",
      );
    }
  }

  let wait = 0;
  if (Object.hasOwn(body, "wait")) {
    const raw = body.wait;
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      return fail(H0_INVALID_REQUEST, H0_POLL_WAIT_REFUSED_MESSAGE);
    }
    if (raw > H0_POLL_MAX_WAIT_SECONDS) {
      return fail(H0_POLL_WAIT_REFUSED, H0_POLL_WAIT_REFUSED_MESSAGE);
    }
    if (!Number.isInteger(raw) || raw < 0) {
      return fail(H0_INVALID_REQUEST, H0_POLL_WAIT_REFUSED_MESSAGE);
    }
    wait = raw;
  }

  let ackBatch: string | null = null;
  if (Object.hasOwn(body, "ackBatch")) {
    if (!isUuid(body.ackBatch)) {
      return fail(
        H0_INVALID_REQUEST,
        "ackBatch must be the batchId from the previous poll.",
      );
    }
    ackBatch = body.ackBatch.toLowerCase();
  }

  return { ok: true, body: { wait, ackBatch } };
}

export function parseH0AckBody(
  value: unknown,
  wire: H0AckWire,
): { ok: true; body: H0AckBody } | H0ParseFailure {
  const body = record(value);
  if (body === null) {
    return fail(H0_INVALID_REQUEST, "The ack body must be a JSON object.");
  }
  const allowed = new Set<string>([...ACK_REQUIRED_KEYS, ...ACK_OMITTABLE_KEYS]);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) {
      return fail(H0_INVALID_REQUEST, "The ack body has an unknown field.");
    }
  }
  for (const key of ACK_REQUIRED_KEYS) {
    if (!Object.hasOwn(body, key)) {
      return fail(H0_INVALID_REQUEST, "The ack body is missing a required field.");
    }
  }

  const outcome = body.outcome;
  if (typeof outcome !== "string" || !wire.ackOutcomes.includes(outcome)) {
    return fail(H0_INVALID_REQUEST, "outcome is not an accepted delivery outcome.");
  }
  const failedTerminal = outcome === "failed_terminal";
  const lastError = body.last_error_code;
  const errorCodes = new Set(wire.ackErrorCodes);
  const validError = failedTerminal
    ? typeof lastError === "string" && errorCodes.has(lastError)
    : lastError === null;
  if (!validError) {
    return fail(
      H0_INVALID_REQUEST,
      "last_error_code must be null unless outcome is failed_terminal.",
    );
  }
  const lastErrorCode: string | null = failedTerminal && typeof lastError === "string"
    ? lastError
    : null;

  const leaseId = body.lease_id;
  const listenerId = body.listener_instance_id;
  const observedNulls = outcome === "observed" && leaseId === null &&
    listenerId === null;
  const liveIds = isUuid(leaseId) && isUuid(listenerId);
  if (!observedNulls && !liveIds) {
    return fail(
      H0_INVALID_REQUEST,
      "lease_id and listener_instance_id are UUIDs, or both null when outcome is observed.",
    );
  }
  if (!isUuid(body.signal_id)) {
    return fail(H0_INVALID_REQUEST, "signal_id must be a UUID.");
  }

  let surfaced: boolean | undefined;
  if (Object.hasOwn(body, "surfaced")) {
    if (body.surfaced !== true && body.surfaced !== false) {
      return fail(H0_INVALID_REQUEST, "surfaced must be a boolean.");
    }
    surfaced = body.surfaced;
  }

  return {
    ok: true,
    body: {
      signal_id: body.signal_id.toLowerCase(),
      lease_id: typeof leaseId === "string" ? leaseId.toLowerCase() : null,
      listener_instance_id: typeof listenerId === "string"
        ? listenerId.toLowerCase()
        : null,
      outcome,
      last_error_code: lastErrorCode,
      ...(surfaced === undefined ? {} : { surfaced }),
    },
  };
}
