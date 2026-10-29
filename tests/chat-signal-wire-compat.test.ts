import assert from "node:assert/strict";
import test from "node:test";
import {
  chatSignalShapeProblem,
  SCALAR_RECIPIENT_FIELDS,
  SIGNAL_RECIPIENT_MAX,
} from "../supabase/functions/_shared/channels.js";

/**
 * The wire gate for the chat migration, the twin of receipt-wire-compat.
 *
 * There is no version negotiation on this wire and the server migrates
 * independently of the installed base, so a request shape that every shipped
 * client sends must keep validating after the edge deploys. The measured trap
 * is NOT the schema: it is `exactKeys`. `modernKeys` is an all-or-nothing pair
 * (`to_agent_principal_id` + `in_reply_to`) that every installed writer always
 * sends, and agent READ bodies always send `in_reply_to`. Folding a new
 * optional key into that group makes `exactKeys` demand the new key from every
 * body, returning 400 on every post and every agent read after a perfectly
 * ordered migration, with the schema healthy.
 *
 * Gate: `npm test` (a literal file list — this path is named in package.json).
 */

/** exactKeys, as both edges define it. Copied so the assertions are about the
 * key SETS this lane changes, not about importing a Deno module. */

/** The body every installed client posts: the modern pair, always both. */

/** The base allow-list the post_signal validator builds, before optionals. */

/* ------------------------------------------------------------------------- *
 * The rules the chat fields add. These are the validator's, extracted into a
 * pure function so they can be exercised without a Deno runtime.
 * ------------------------------------------------------------------------- */

const undirected = {
  signal_kind: "note",
  to_user_id: null,
  to_agent_principal_id: null,
  in_reply_to: null,
};

test("the chat fields add no rule to a body that carries none of them", () => {
  assert.equal(chatSignalShapeProblem(undirected), null);
  assert.equal(
    chatSignalShapeProblem({ ...undirected, signal_kind: "working-on" }),
    null,
    "working-on is still legal when it is not a thread reply",
  );
  assert.equal(
    chatSignalShapeProblem({
      ...undirected,
      to_user_id: "11111111-1111-4111-8111-111111111111",
    }),
    null,
    "a directed note is still legal",
  );
});

test("a thread reply is open, so it is never working-on and never addressed", () => {
  const root = "22222222-2222-4222-8222-222222222222";
  assert.equal(
    chatSignalShapeProblem({ ...undirected, thread_root_id: root }),
    null,
  );
  assert.equal(
    chatSignalShapeProblem({
      ...undirected,
      signal_kind: "ask",
      thread_root_id: root,
    }),
    null,
    "R11: an ask may be a thread reply",
  );
  assert.notEqual(
    chatSignalShapeProblem({
      ...undirected,
      signal_kind: "working-on",
      thread_root_id: root,
    }),
    null,
  );
  assert.notEqual(
    chatSignalShapeProblem({
      ...undirected,
      to_user_id: "33333333-3333-4333-8333-333333333333",
      thread_root_id: root,
    }),
    null,
  );
  assert.notEqual(
    chatSignalShapeProblem({
      ...undirected,
      to_agent_principal_id: "44444444-4444-4444-8444-444444444444",
      thread_root_id: root,
    }),
    null,
  );
});

test("thread_root_id and in_reply_to are different mechanisms and cannot both be set", () => {
  const root = "22222222-2222-4222-8222-222222222222";
  /* in_reply_to alone keeps its exact meaning: this lane does not touch it. */
  assert.equal(
    chatSignalShapeProblem({
      ...undirected,
      in_reply_to: "55555555-5555-4555-8555-555555555555",
    }),
    null,
  );
  assert.notEqual(
    chatSignalShapeProblem({
      ...undirected,
      in_reply_to: "55555555-5555-4555-8555-555555555555",
      thread_root_id: root,
    }),
    null,
    "both set is ambiguous exactly where addressing is decided",
  );
});

test("a thread reply inherits its channel rather than taking one, and broadcast needs a thread", () => {
  const root = "22222222-2222-4222-8222-222222222222";
  assert.notEqual(
    chatSignalShapeProblem({
      ...undirected,
      thread_root_id: root,
      channel: "mobile",
    }),
    null,
    "refused, not silently ignored",
  );
  assert.equal(
    chatSignalShapeProblem({
      ...undirected,
      thread_root_id: root,
      broadcast_to_channel: true,
    }),
    null,
  );
  assert.notEqual(
    chatSignalShapeProblem({ ...undirected, broadcast_to_channel: true }),
    null,
    "broadcast_to_channel without a thread has nothing to broadcast",
  );
  assert.equal(
    chatSignalShapeProblem({ ...undirected, broadcast_to_channel: false }),
    null,
    "false is the default an older client would have written, so it must pass",
  );
  assert.notEqual(
    chatSignalShapeProblem({ ...undirected, broadcast_to_channel: "yes" }),
    null,
  );
});

const RECIPIENT_A = "44444444-4444-4444-8444-444444444444";
const RECIPIENT_B = "55555555-5555-4555-8555-555555555555";

test("`to` beside a scalar recipient is refused, and the sentence names the scalar it found", () => {
  /* Never silently reconciled: two answers to one question is a refusal. The
   * field name comes from SCALAR_RECIPIENT_FIELDS, so a third scalar field
   * could not be added without appearing here. */
  const problem = chatSignalShapeProblem({
    signal_kind: "note",
    to_user_id: RECIPIENT_B,
    to_agent_principal_id: null,
    in_reply_to: null,
    to: [{ kind: "user", id: RECIPIENT_A }],
  });
  assert.ok(problem !== null);
  assert.match(problem, /^to_user_id names a recipient and so does to\./);
  assert.match(problem, /leave it null/);

  const bothScalars = chatSignalShapeProblem({
    signal_kind: "note",
    to_user_id: RECIPIENT_B,
    to_agent_principal_id: RECIPIENT_A,
    in_reply_to: null,
    to: [{ kind: "user", id: RECIPIENT_A }],
  });
  assert.ok(bothScalars !== null);
  for (const field of SCALAR_RECIPIENT_FIELDS) {
    assert.ok(bothScalars.includes(field), `must name ${field}`);
  }
  assert.match(bothScalars, /leave them null/, "the plural is generated too");

  /* Control: `to` with BOTH scalars null is the shape a new client sends, and
   * it is accepted. Without this the refusal above could be "`to` is refused". */
  assert.equal(
    chatSignalShapeProblem({
      signal_kind: "note",
      to_user_id: null,
      to_agent_principal_id: null,
      in_reply_to: null,
      to: [{ kind: "user", id: RECIPIENT_A }, { kind: "agent", id: RECIPIENT_B }],
    }),
    null,
  );
});

test("a thread reply cannot be addressed through `to` either", () => {
  /* `to` is a third way to address a signal. The one rule that stops a thread
   * reply carrying a private half has to read all three, or the new field walks
   * straight through the check that exists to stop it. */
  const problem = chatSignalShapeProblem({
    signal_kind: "note",
    to_user_id: null,
    to_agent_principal_id: null,
    in_reply_to: null,
    thread_root_id: "22222222-2222-4222-8222-222222222222",
    to: [{ kind: "user", id: RECIPIENT_A }],
  });
  assert.ok(problem !== null);
  assert.match(problem, /cannot also be addressed to a recipient/);

  /* Control 1: the same thread reply with NO recipients is accepted. */
  assert.equal(
    chatSignalShapeProblem({
      signal_kind: "note",
      to_user_id: null,
      to_agent_principal_id: null,
      in_reply_to: null,
      thread_root_id: "22222222-2222-4222-8222-222222222222",
    }),
    null,
  );
  /* Control 2: the scalar spelling gets the SAME sentence, so the two ways of
   * addressing are not told two different rules. */
  const scalarSpelling = chatSignalShapeProblem({
    signal_kind: "note",
    to_user_id: RECIPIENT_A,
    to_agent_principal_id: null,
    in_reply_to: null,
    thread_root_id: "22222222-2222-4222-8222-222222222222",
  });
  assert.equal(scalarSpelling, problem);
});

test("a malformed `to` is answered before the rules that read the list", () => {
  /* Shape before meaning, the doctrine the thread_root_id case already
   * follows. A `to` that is not a list of recipients is not yet an address, so
   * "a thread reply takes no recipient" is a rule about an address it does not
   * have. */
  const problem = chatSignalShapeProblem({
    signal_kind: "note",
    to_user_id: null,
    to_agent_principal_id: null,
    in_reply_to: null,
    thread_root_id: "22222222-2222-4222-8222-222222222222",
    to: "everyone",
  });
  assert.ok(problem !== null);
  assert.match(problem, /to is a list of recipients/);
  assert.doesNotMatch(problem, /thread/);

  /* And the cap is a rule about the list, so it also outranks the thread rule. */
  const overCap = Array.from(
    { length: SIGNAL_RECIPIENT_MAX + 1 },
    (_unused, index) => ({
      kind: "user" as const,
      id: `4444444${index}-4444-4444-8444-444444444444`,
    }),
  );
  const capped = chatSignalShapeProblem({
    signal_kind: "note",
    to_user_id: null,
    to_agent_principal_id: null,
    in_reply_to: null,
    thread_root_id: "22222222-2222-4222-8222-222222222222",
    to: overCap,
  });
  assert.ok(capped !== null);
  assert.match(capped, new RegExp(`at most ${SIGNAL_RECIPIENT_MAX} recipients`));
});
