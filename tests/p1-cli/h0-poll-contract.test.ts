/**
 * Poll's request keys are checked against the parser, not against a document
 * rendered from the verb table. The parser's key list and H0_VERBS are separate.
 *
 * Gate: `npm run test:p1-cli` globs tests/p1-cli. `npm test` does not name this file.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import { H0_MAX_CONCURRENT_WAITS, H0_POLL_RETRY_AFTER_SECONDS, H0_VERBS } from "../../src/h0/verbs.js";
import {
  H0_POLL_CLEANUP_MS,
  H0_POLL_MAX_WAIT_SECONDS,
  H0_POLL_WAIT_REFUSED,
  h0PollLockDurationMs,
  parseH0AckBody,
  parseH0PollBody,
} from "../../supabase/functions/h0/parse.js";
import {
  H0_SEAT_CLAIM_REFUSED,
  h0SeatClaimRefusal,
} from "../../supabase/functions/command/h0-seat.js";
import {
  DELIVERY_ACK_OUTCOMES,
  DELIVERY_CLIENT_ERROR_CODES,
} from "../../supabase/functions/command/durable-delivery.js";

const UUID = "11111111-1111-4111-8111-111111111111";

function source(rel: string): string {
  return readFileSync(rel, "utf8");
}

function stringLiterals(rel: string): string[] {
  const file = ts.createSourceFile(rel, source(rel), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(node.text)) {
      found.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

test("the poll parser accepts the poll row's keys and no others", () => {
  const table = H0_VERBS.find((verb) => verb.name === "poll");
  assert.ok(table);
  const candidates = new Set<string>([
    ...table.fields.map((field) => field.name),
    ...stringLiterals("supabase/functions/h0/parse.ts"),
    "not_a_poll_field",
  ]);
  const probes = [0, 1, 50, UUID, true, false, null, ""];
  const accepted: Array<{ name: string; presence: "required" | "omittable"; nullable: boolean }> = [];
  for (const key of candidates) {
    let took = false;
    let nullable = false;
    for (const probe of probes) {
      const result = parseH0PollBody({ [key]: probe });
      if (result.ok) {
        took = true;
        if (probe === null) nullable = true;
      }
    }
    if (!took) continue;
    const empty = parseH0PollBody({});
    accepted.push({
      name: key,
      presence: empty.ok ? "omittable" : "required",
      nullable,
    });
  }
  const expected = table.fields.map(({ name, presence, nullable }) => ({
    name,
    presence,
    nullable,
  }));
  const byName = (left: { name: string }, right: { name: string }) =>
    left.name.localeCompare(right.name);
  assert.deepEqual(accepted.sort(byName), expected.sort(byName));
  assert.equal(parseH0PollBody({}).ok, true);
  assert.equal(parseH0PollBody({ wait: 50 }).ok, true);
  const tooLong = parseH0PollBody({ wait: H0_POLL_MAX_WAIT_SECONDS + 1 });
  assert.equal(tooLong.ok, false);
  if (!tooLong.ok) assert.equal(tooLong.error, H0_POLL_WAIT_REFUSED);
  assert.equal(parseH0PollBody({ wait: 50.5 }).ok, false);
  assert.equal(parseH0PollBody({ ackBatch: null }).ok, false);
  assert.equal(parseH0PollBody({ ackBatch: UUID }).ok, true);
});

test("the waiting-poll cap is one constant, and the document and README read it", () => {
  const verbs = source("src/h0/verbs.ts");
  const definitions = verbs.match(/export const H0_MAX_CONCURRENT_WAITS = \d+/g) ?? [];
  assert.deepEqual(definitions, [`export const H0_MAX_CONCURRENT_WAITS = ${H0_MAX_CONCURRENT_WAITS}`]);
  const retry = verbs.match(/export const H0_POLL_RETRY_AFTER_SECONDS = \d+/g) ?? [];
  assert.deepEqual(retry, [`export const H0_POLL_RETRY_AFTER_SECONDS = ${H0_POLL_RETRY_AFTER_SECONDS}`]);
  const poll = H0_VERBS.find((verb) => verb.name === "poll");
  const wait = poll?.fields.find((field) => field.name === "wait");
  assert.match(wait?.note ?? "", new RegExp(`At most ${H0_MAX_CONCURRENT_WAITS} poll may wait`));
  assert.match(wait?.note ?? "", /retryAfterSeconds/);
  const readme = source("deploy/edge-runtime/README.md");
  assert.match(readme, /H0_MAX_CONCURRENT_WAITS/);
  assert.match(readme, /src\/h0\/verbs\.ts/);
  const handler = source("supabase/functions/h0/poll-ack.ts");
  assert.match(handler, /H0_MAX_CONCURRENT_WAITS/);
  assert.match(handler, /H0_POLL_RETRY_AFTER_SECONDS/);
  assert.equal(handler.includes("export const H0_MAX_CONCURRENT_WAITS"), false);
});

test("the poll lock expiry is strictly longer than the maximum wait plus cleanup", () => {
  const duration = h0PollLockDurationMs(H0_POLL_MAX_WAIT_SECONDS);
  assert.ok(duration > H0_POLL_MAX_WAIT_SECONDS * 1_000 + H0_POLL_CLEANUP_MS);
});

test("ack parser accepts the ack row and rejects an extra key", () => {
  const table = H0_VERBS.find((verb) => verb.name === "ack");
  assert.ok(table);
  const wire = {
    ackOutcomes: DELIVERY_ACK_OUTCOMES,
    ackErrorCodes: DELIVERY_CLIENT_ERROR_CODES,
  };
  const samples: Record<string, unknown> = {
    signal_id: UUID,
    lease_id: UUID,
    listener_instance_id: UUID,
    outcome: "replied",
    last_error_code: null,
    surfaced: false,
  };
  const body: Record<string, unknown> = {};
  for (const field of table.fields) {
    assert.ok(Object.hasOwn(samples, field.name), `no probe value for ${field.name}`);
    if (field.presence === "required") body[field.name] = samples[field.name];
  }
  assert.equal(parseH0AckBody(body, wire).ok, true);
  assert.equal(parseH0AckBody({ ...body, made_up_field: "x" }, wire).ok, false);
  for (const field of table.fields) {
    if (field.presence !== "required") continue;
    const dropped = { ...body };
    delete dropped[field.name];
    assert.equal(parseH0AckBody(dropped, wire).ok, false, field.name);
  }
});

test("the claim fence sits before replay and the claim call", () => {
  const command = source("supabase/functions/command/index.ts");
  const fenceAt = command.indexOf("h0SeatClaimRefusal(");
  const replayAt = command.indexOf("parseClaimLedger(existing.response)");
  const callAt = command.indexOf("await claimAgentInbox(");
  assert.ok(fenceAt > 0, "fence call missing");
  assert.ok(replayAt > fenceAt, "replay can return a claim before the fence");
  assert.ok(callAt > fenceAt, "claimAgentInbox is called before the fence");
  assert.equal(command.split("h0SeatClaimRefusal(").length - 1, 1);
});

test("removing the fence makes the refusal assertion fail", () => {
  const command = source("supabase/functions/command/index.ts");
  const needle = "await principalIsH0Seat(";
  assert.equal(command.includes(needle), true, "mutation was not applied: the fence call is absent");
  const mutated = command.replace(needle, "false && await principalIsH0Seat(");
  assert.notEqual(mutated, command, "mutation did not change the claim branch");
  assert.equal(mutated.includes("h0SeatClaimRefusal(\n          false && await principalIsH0Seat("), true);
  assert.equal(h0SeatClaimRefusal(false), null);
  const bodyAfterRemoval = { error: "delivery_unavailable" };
  assert.throws(() => {
    assert.equal(bodyAfterRemoval.error, H0_SEAT_CLAIM_REFUSED);
  });
});
