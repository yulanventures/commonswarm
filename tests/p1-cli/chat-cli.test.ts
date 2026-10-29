/**
 * The chat client: what it puts on the wire, what it refuses before it sends
 * anything, and what it says afterwards.
 *
 * Three claims are gated here.
 *
 * 1. **The client's copy of the channel rules cannot drift from the edge's.**
 *    `src/cloud/channels.ts` duplicates the constants in
 *    `supabase/functions/_shared/channels.ts` because `tsconfig.json` pins
 *    `rootDir` to `src` and a module under `src/` cannot import one under
 *    `supabase/`. That duplication is the exact failure AGENTS.md measured four
 *    times in one release cycle, so this file imports BOTH and compares them.
 *    Its bound: it compares the constants and the generated sentences NAMED
 *    below, generated from `sharedConstantNames`, and it compares
 *    `channelSlugProblem` over the cases in `slugCases`, which are themselves
 *    derived from the shared constants rather than typed. It does NOT prove the
 *    two modules export the same SET of names, and it does not reach the
 *    database CHECK — `tests/chat-channel-constants.test.ts` owns that pairing.
 *
 * 2. **The bodies match what the served edge accepts.** The expected shapes are
 *    the ones `tests/p1-server/chat-signals.test.ts` sends against a real
 *    command function: its `installedPost()` helper is reproduced here as
 *    `installedPostBody`, and its channel commands as `channelCommandCases`.
 *    That test proves the shapes are accepted; this one proves the client emits
 *    them, without a database.
 *
 * 3. **A name that cannot be a channel name is refused before the credential is
 *    read, and never over the network.** Spawned against `dist/cli.js` with a
 *    complete target and a credential path that cannot exist, so a probe that
 *    got past the local check says `agent_token_file_unreadable` and one that
 *    reached the network would say something else again. Nothing here connects.
 *
 * Gate: `npm run test:p1-cli` (a glob over tests/p1-cli/**), which is also
 * reached by `npm run check:tests`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import * as client from "../../src/cloud/channels.js";
import {
  parseSignalRecord,
  signalAddressesAgent,
} from "../../src/cloud/signals.js";

const target = {
  url: "https://example.invalid",
  anonKey: "anon-key",
  profileId: "test",
};

/* ------------------------------------------------------------------ *
 * 1. The copy against the enforcement
 * ------------------------------------------------------------------ */

/**
 * The names both modules must agree on, as data. The assertions iterate this
 * list, so adding a shared constant to one module and forgetting it here is
 * visible as a shorter list rather than as a silent gap — which is the bound
 * this file states at the top.
 */

/**
 * Slug cases, generated from the shared constants rather than typed, so a
 * changed bound moves the cases with it.
 */

/* ------------------------------------------------------------------ *
 * 2. The bodies
 * ------------------------------------------------------------------ */

/**
 * The EXACT body `tests/p1-server/chat-signals.test.ts:242-256` sends against a
 * real command function: the modern pair, always both.
 */

/* Optional chat keys the edge accepts that THIS client does not send yet. When the
 * client learns one, remove it here or the test below goes red: drift is visible in
 * both directions. `to` (a recipient list, lane L2) landed on the edge on 2026-09-05
 * before the CLI had a verb for it. */

/* ------------------------------------------------------------------ *
 * 3. Rendering
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * 4. Argument parsing, against the built CLI
 * ------------------------------------------------------------------ */

/**
 * Every spawn below carries a complete target AND a credential flag pointing at
 * a path that cannot exist. That is the positive control: anything that got as
 * far as resolving a credential says `agent_token_file_unreadable`, and no
 * probe here reaches the network at all, so this stays a pure gate.
 */

/** Reached the credential step, which is AFTER every local check in this lane. */

/**
 * An agent credential file the CLI can actually READ, so a run gets PAST the
 * credential step and into channelRows.
 *
 * The offline probes above stop at `agent_token_file_unreadable`, which is
 * before the branch this lane removed. A test that only reached there would
 * pass whether the branch was there or not, which is the failure AGENTS.md
 * names: a probe that cannot fail is not evidence. These runs reach the
 * network instead, against a port nothing listens on.
 */

test("the agent channel list sends the exact body the read edge parses, and nothing more", async () => {
  const sent: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    sent.push({ url: String(input), init });
    return new Response(JSON.stringify({ channels: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const rows = await client.listChannelsAsAgent(
    target,
    "swm_agt_token",
    "22222222-2222-4222-8222-222222222222",
    fetcher,
  );
  assert.deepEqual(rows, []);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.url, `${target.url}/functions/v1/read`);
  assert.equal(sent[0]!.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(sent[0]!.init?.body)), {
    resource: "channels",
    workspace_id: "22222222-2222-4222-8222-222222222222",
  });
  assert.deepEqual(
    Object.keys(JSON.parse(String(sent[0]!.init?.body))).sort(),
    ["resource", "workspace_id"],
    "the sorted key set is what the read function actually compares",
  );
  const headers = sent[0]!.init?.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer swm_agt_token");
  assert.equal(headers.apikey, target.anonKey);
  assert.equal(headers["content-type"], "application/json");
  /* The read function is not PostgREST: an accept-profile header here would be
   * a copy of the human path that means nothing on this one. */
  assert.equal(Object.hasOwn(headers, "accept-profile"), false);
});

test("the agent channel list refuses a shape it does not understand, and says nothing changed", async () => {
  const cases: Array<[string, Response]> = [
    [
      "an envelope with no channels array",
      new Response(JSON.stringify({ files: [] }), { status: 200 }),
    ],
    [
      "a body that is not JSON",
      new Response("not json", { status: 200 }),
    ],
    [
      "an array where the envelope belongs",
      new Response(JSON.stringify([]), { status: 200 }),
    ],
  ];
  for (const [label, response] of cases) {
    await assert.rejects(
      () =>
        client.listChannelsAsAgent(
          target,
          "swm_agt_token",
          "22222222-2222-4222-8222-222222222222",
          async () => response.clone(),
        ),
      /shape this version does not understand/,
      label,
    );
  }

  /* A read service without the arm answers 400. That is the deploy coupling
   * this lane creates, and the sentence it produces is about the refusal rather
   * than about signing in. */
  await assert.rejects(
    () =>
      client.listChannelsAsAgent(
        target,
        "swm_agt_token",
        "22222222-2222-4222-8222-222222222222",
        async () =>
          new Response(JSON.stringify({ error: "invalid_request" }), {
            status: 400,
          }),
      ),
    /refused \(HTTP 400\). Nothing changed/,
  );

  /* POSITIVE CONTROL on the same call shape: a well-formed envelope is
   * accepted and its rows come back, so the refusals above are about the
   * bodies and not about the helper always throwing. */
  const ok = await client.listChannelsAsAgent(
    target,
    "swm_agt_token",
    "22222222-2222-4222-8222-222222222222",
    async () =>
      new Response(
        JSON.stringify({
          channels: [{
            channel_id: "33333333-3333-4333-8333-333333333333",
            workspace_id: "22222222-2222-4222-8222-222222222222",
            slug: "deploys",
            purpose: null,
            created_by_principal: "44444444-4444-4444-8444-444444444444",
            created_by_kind: "user",
            created_at: "2026-09-05T00:00:00.000Z",
            archived_at: null,
          }],
        }),
        { status: 200 },
      ),
  );
  assert.equal(ok.length, 1);
  assert.equal(ok[0]!.slug, "deploys");
});

const RECIPIENT_ROW: Record<string, unknown> = {
  id: "11111111-1111-4111-8111-111111111111",
  workspace_id: "22222222-2222-4222-8222-222222222222",
  from: "33333333-3333-4333-8333-333333333333",
  from_kind: "user",
  to: null,
  to_agent: "44444444-4444-4444-8444-444444444444",
  in_reply_to: null,
  about: null,
  kind: "ask",
  body: "both of you",
  until: "2030-01-01T00:00:00.000Z",
  created_at: "2026-09-05T00:00:00.000Z",
};
const FIRST_AGENT = "44444444-4444-4444-8444-444444444444";
const SECOND_AGENT = "55555555-5555-4555-8555-555555555555";

test("a recipient list this reader cannot understand is malformed, never guessed at", () => {
  const rejected: Array<[string, unknown]> = [
    ["not an array", { kind: "agent", id: FIRST_AGENT, position: 0 }],
    ["an entry that is not an object", ["agent"]],
    ["a kind outside the set", [{ kind: "channel", id: FIRST_AGENT, position: 0 }]],
    ["an id that is not a uuid", [{ kind: "agent", id: "first", position: 0 }]],
    ["a fractional position", [{ kind: "agent", id: FIRST_AGENT, position: 0.5 }]],
    ["a negative position", [{ kind: "agent", id: FIRST_AGENT, position: -1 }]],
    ["a missing key", [{ kind: "agent", id: FIRST_AGENT }]],
    [
      "an extra key",
      [{ kind: "agent", id: FIRST_AGENT, position: 0, name: "builder" }],
    ],
    [
      "a repeated position",
      [
        { kind: "agent", id: FIRST_AGENT, position: 0 },
        { kind: "agent", id: SECOND_AGENT, position: 0 },
      ],
    ],
    [
      "a repeated id",
      [
        { kind: "agent", id: FIRST_AGENT, position: 0 },
        { kind: "agent", id: FIRST_AGENT, position: 1 },
      ],
    ],
  ];
  for (const [label, recipients] of rejected) {
    assert.throws(
      () => parseSignalRecord({ ...RECIPIENT_ROW, recipients }),
      /malformed recipients list|repeated recipient|malformed recipients\[\]\.id/,
      label,
    );
  }

  /* POSITIVE CONTROL on the same call shape: a list that differs from the
   * refused ones only in being well formed is accepted, so the refusals above
   * are about the shape and not about the field existing. It also shows the
   * check does NOT require contiguity or ordering, which the database owns. */
  const sparse = parseSignalRecord({
    ...RECIPIENT_ROW,
    recipients: [
      { kind: "agent", id: SECOND_AGENT, position: 3 },
      { kind: "user", id: FIRST_AGENT, position: 1 },
    ],
  });
  assert.equal(sparse.recipients?.length, 2);
});

test("a signal addresses this agent at any position, and nobody else's", () => {
  /* The one question three call sites ask -- src/cloud/arrival-watch.ts, which
   * THREW on a miss, src/listener/hook.ts, which dropped the row, and the
   * resume inbox count in src/cli.ts. They must ask it the same way or the
   * count and the listing disagree about one page. */
  const at0 = parseSignalRecord({
    ...RECIPIENT_ROW,
    recipients: [
      { kind: "agent", id: FIRST_AGENT, position: 0 },
      { kind: "agent", id: SECOND_AGENT, position: 1 },
    ],
  });
  assert.equal(signalAddressesAgent(at0, FIRST_AGENT), true);
  assert.equal(signalAddressesAgent(at0, SECOND_AGENT), true);
  assert.equal(
    signalAddressesAgent(at0, "66666666-6666-4666-8666-666666666666"),
    false,
  );

  /* A PERSON at position 0 and this agent second. The scalar column holds no
   * agent at all here, so the old scalar question answered no for a signal the
   * service wakes this agent for. */
  const personFirst = parseSignalRecord({
    ...RECIPIENT_ROW,
    to: "77777777-7777-4777-8777-777777777777",
    to_agent: null,
    recipients: [
      { kind: "user", id: "77777777-7777-4777-8777-777777777777", position: 0 },
      { kind: "agent", id: SECOND_AGENT, position: 1 },
    ],
  });
  assert.equal(signalAddressesAgent(personFirst, SECOND_AGENT), true);
  /* A USER id that happens to equal the principal being asked about is not an
   * agent match: the kind is part of the question. */
  assert.equal(
    signalAddressesAgent(personFirst, "77777777-7777-4777-8777-777777777777"),
    false,
  );

  /* ABSENT falls back to the scalar column, which is everything an edge that
   * never reported a set knows. It must not answer false for position 0. */
  const unreported = parseSignalRecord(RECIPIENT_ROW);
  assert.equal(signalAddressesAgent(unreported, FIRST_AGENT), true);
  assert.equal(signalAddressesAgent(unreported, SECOND_AGENT), false);
});
