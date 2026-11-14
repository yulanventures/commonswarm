import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CHANNEL_CREATE_OPTIONAL_FIELDS,
  CHANNEL_CREATION_POLICIES,
  CHANNEL_CREATION_POLICY_RULE_TEXT,
  CHANNEL_INVOLVEMENT_LEVELS,
  CHANNEL_INVOLVEMENT_RULE_TEXT,
  CHANNEL_MEMBER_ENTRY_RULE_TEXT,
  CHANNEL_MEMBER_MAX,
  CHANNEL_MEMBERS_REQUIRES_PRIVATE_TEXT,
  CHANNEL_MEMBERS_RULE_TEXT,
  CHANNEL_PREFERENCE_EMPTY_TEXT,
  CHANNEL_PREFERENCE_OPTIONAL_FIELDS,
  CHANNEL_PREFERENCE_TARGET_RULE_TEXT,
  CHANNEL_PURPOSE_MAX,
  CHANNEL_PURPOSE_MAX_TEXT,
  CHANNEL_PURPOSE_TYPE_TEXT,
  CHANNEL_READ_COLUMNS,
  CHANNEL_REORDER_MAX,
  CHANNEL_REORDER_RULE_TEXT,
  CHANNEL_STAR_REORDER_RULE_TEXT,
  CHANNEL_STARRED_RULE_TEXT,
  CHANNEL_UPDATE_EMPTY_TEXT,
  CHANNEL_UPDATE_OPTIONAL_FIELDS,
  CHANNEL_VISIBILITIES,
  CHANNEL_VISIBILITY_RULE_TEXT,
  channelMemberEntryProblem,
  channelMembersListProblem,
  channelReorderListProblem,
  channelStarReorderListProblem,
  commandFieldsMessage,
  parseChannelMemberEntry,
  parseChannelMembers,
  parseSignalRecipients,
  SIGNAL_RECIPIENT_KINDS,
  SIGNAL_RECIPIENT_MAX,
  SIGNAL_RECIPIENT_RULE_TEXT,
  signalRecipientListProblem,
} from "../supabase/functions/_shared/channels.js";
import { CHANNEL_COLUMNS } from "../src/cloud/channels.js";

/**
 * Two enforcement points, two languages: the database CHECK on
 * swarm.channels.slug and the edge validator. They must move together or the
 * edge accepts a name the database refuses, which surfaces as a 500 on an
 * otherwise valid command. This gate reads BOTH artifacts.
 *
 * Gate: `npm test` (a literal file list — this path is named in package.json).
 */

/* ---------------------------------------------------------------------------
 * The recipient cap. Three artifacts hold this number, in three languages, and
 * none of them can import the others: the migration's CHECK, the edge
 * constant, and the composer's own ceiling under site/. The two below are read
 * as TEXT for exactly that reason.
 * ------------------------------------------------------------------------- */

test("the recipient rules refuse each shape they name, and the sentences are generated", () => {
  const uuid = "22222222-2222-4222-8222-222222222222";
  const other = "33333333-3333-4333-8333-333333333333";
  assert.equal(signalRecipientListProblem(undefined), null, "absent is fine");
  assert.equal(signalRecipientListProblem(null), null, "null means absent");
  assert.equal(
    signalRecipientListProblem([{ kind: "user", id: uuid }]),
    null,
    "one well-formed recipient is fine",
  );

  /* Every kind in the constant is accepted, so the list and the check cannot
   * drift: adding a kind to SIGNAL_RECIPIENT_KINDS makes this loop cover it. */
  for (const kind of SIGNAL_RECIPIENT_KINDS) {
    assert.equal(signalRecipientListProblem([{ kind, id: uuid }]), null, kind);
  }
  /* And the sentence names all of them. */
  for (const kind of SIGNAL_RECIPIENT_KINDS) {
    assert.ok(
      SIGNAL_RECIPIENT_RULE_TEXT.includes(kind),
      `the rule text must name ${kind}`,
    );
  }
  /* The NUMBER, not a substring of one. A review arm pointed out that
   * includes("8") is satisfied by "18", so the bound could be raised and the
   * sentence could still claim the old one. Digit boundaries on both sides. */
  assert.ok(
    new RegExp(`(?<!\\d)${SIGNAL_RECIPIENT_MAX}(?!\\d)`)
      .test(SIGNAL_RECIPIENT_RULE_TEXT),
    "the rule text carries the cap it enforces, as that number and not inside a longer one",
  );
  /* Control on the matcher: it really does reject a longer number that ends in
   * the same digits, so the assertion above is about the value. */
  assert.equal(
    new RegExp(`(?<!\\d)${SIGNAL_RECIPIENT_MAX}(?!\\d)`)
      .test(`at most 1${SIGNAL_RECIPIENT_MAX} recipients`),
    false,
  );

  assert.match(
    String(signalRecipientListProblem([])),
    /at least one recipient/,
    "an empty list is refused as an empty list, not as a bad shape",
  );
  /* GENERATED, not typed. This asserted /kind is user or agent/, which is
   * today's classList output written out by hand in a test -- the same drift
   * one level down that the rule text exists to prevent. */
  assert.ok(
    String(signalRecipientListProblem([{ kind: "nobody", id: uuid }]))
      .includes(
        `kind is ${SIGNAL_RECIPIENT_KINDS.slice(0, -1).join(", ")} or ${
          SIGNAL_RECIPIENT_KINDS[SIGNAL_RECIPIENT_KINDS.length - 1]
        }`,
      ),
    "the kind list in the refusal is the constant's own list",
  );
  assert.match(
    String(signalRecipientListProblem([{ kind: "user", id: "nope" }])),
    /id is a UUID/,
  );
  assert.match(
    String(signalRecipientListProblem([{ kind: "user", id: uuid, extra: 1 }])),
    /Each one is \{kind, id\}/,
    "an extra key on an entry is refused",
  );
  assert.match(
    String(signalRecipientListProblem("everyone")),
    /to is a list of recipients/,
  );
  assert.match(
    String(
      signalRecipientListProblem([
        { kind: "user", id: uuid },
        { kind: "user", id: uuid.toUpperCase() },
      ]),
    ),
    /same recipient twice/,
    "the duplicate check folds case, because the database compares uuids",
  );
  /* Control on the duplicate rule: the SAME id under a different kind is two
   * different recipients, so the check is about the pair and not about the id. */
  assert.equal(
    signalRecipientListProblem([
      { kind: "user", id: uuid },
      { kind: "agent", id: uuid },
    ]),
    null,
  );

  /* The cap, at its boundary. The generated sentence carries the number. */
  const atCap = Array.from({ length: SIGNAL_RECIPIENT_MAX }, (_unused, i) => ({
    kind: "user" as const,
    id: `${String(i).repeat(8)}-2222-4222-8222-222222222222`.slice(-36),
  }));
  assert.equal(
    signalRecipientListProblem(atCap),
    null,
    "exactly the cap is accepted",
  );
  const overCap = [...atCap, { kind: "agent" as const, id: other }];
  assert.match(
    String(signalRecipientListProblem(overCap)),
    new RegExp(`at most ${SIGNAL_RECIPIENT_MAX} recipients`),
  );
});

test("parseSignalRecipients lower-cases ids and refuses what the rules refuse", () => {
  const upper = "22222222-2222-4222-8222-22222222222A";
  assert.deepEqual(
    parseSignalRecipients([{ kind: "agent", id: upper }]),
    [{ kind: "agent", id: upper.toLowerCase() }],
    "ids reach the database in the form Postgres stores",
  );
  assert.equal(parseSignalRecipients(undefined), null);
  assert.equal(parseSignalRecipients(null), null);
  assert.equal(parseSignalRecipients("nope"), null);
  assert.equal(parseSignalRecipients([{ kind: "user", id: "nope" }]), null);
  assert.deepEqual(parseSignalRecipients([]), []);
});

test("channel_update and channel_unarchive generated field and purpose sentences stay pinned to their constants", () => {
  assert.equal(
    commandFieldsMessage("channel_create", ["slug"], CHANNEL_CREATE_OPTIONAL_FIELDS),
    "channel_create takes slug, and optionally purpose, visibility and members, and nothing else.",
  );
  assert.equal(
    commandFieldsMessage("channel_update", ["channel_id"], CHANNEL_UPDATE_OPTIONAL_FIELDS),
    "channel_update takes channel_id, and optionally slug, purpose, visibility and members, and nothing else.",
  );
  assert.equal(
    commandFieldsMessage("channel_unarchive", ["channel_id"]),
    "channel_unarchive takes channel_id, and nothing else.",
  );
  assert.equal(
    CHANNEL_UPDATE_EMPTY_TEXT,
    "channel_update needs at least one of slug, purpose or visibility.",
  );
  assert.equal(CHANNEL_PURPOSE_TYPE_TEXT, "A channel purpose is text.");
  assert.ok(
    new RegExp(`(?<!\\d)${CHANNEL_PURPOSE_MAX}(?!\\d)`).test(CHANNEL_PURPOSE_MAX_TEXT),
    "the purpose bound sentence carries CHANNEL_PURPOSE_MAX",
  );
  assert.deepEqual(
    CHANNEL_READ_COLUMNS,
    CHANNEL_COLUMNS,
    "human REST select columns and agent read edge columns stay identical",
  );
});

test("CM-3a private channel visibility and member constants match SQL CHECKs and generate their sentences", () => {
  const migration = readFileSync(
    new URL(
      "../supabase/migrations/20261113000003_private_channels.sql",
      import.meta.url,
    ),
    "utf8",
  );
  for (const visibility of CHANNEL_VISIBILITIES) {
    assert.ok(
      CHANNEL_VISIBILITY_RULE_TEXT.includes(visibility),
      `visibility rule text names ${visibility}`,
    );
    assert.ok(
      migration.includes(`'${visibility}'`),
      `migration CHECK names visibility '${visibility}'`,
    );
  }
  assert.ok(
    new RegExp(`(?<!\\d)${CHANNEL_MEMBER_MAX}(?!\\d)`).test(
      CHANNEL_MEMBERS_RULE_TEXT,
    ),
    "member list rule text carries CHANNEL_MEMBER_MAX",
  );
  assert.equal(
    CHANNEL_MEMBERS_REQUIRES_PRIVATE_TEXT,
    'members is only accepted when visibility is "private".',
  );
  const u1 = "22222222-2222-4222-8222-222222222222";
  const u2 = "33333333-3333-4333-8333-333333333333";
  assert.equal(channelMemberEntryProblem({ kind: "user", id: u1 }), null);
  assert.equal(channelMemberEntryProblem({ kind: "agent", id: u2 }), null);
  assert.equal(
    channelMemberEntryProblem({ kind: "team", id: u1 }),
    CHANNEL_MEMBER_ENTRY_RULE_TEXT,
  );
  assert.deepEqual(
    parseChannelMemberEntry({ kind: "agent", id: u1.toUpperCase() }),
    { kind: "agent", id: u1 },
  );
  assert.equal(channelMembersListProblem([{ kind: "user", id: u1 }]), null);
  assert.equal(channelMembersListProblem([]), CHANNEL_MEMBERS_RULE_TEXT);
  assert.match(
    String(
      channelMembersListProblem([
        { kind: "user", id: u1 },
        { kind: "user", id: u1.toUpperCase() },
      ]),
    ),
    /same person or agent twice/,
  );
  assert.equal(
    channelMembersListProblem([
      { kind: "user", id: u1 },
      { kind: "agent", id: u1 },
    ]),
    null,
    "same UUID with different kind is distinct",
  );
  assert.deepEqual(
    parseChannelMembers([{ kind: "user", id: u1.toUpperCase() }]),
    [{ kind: "user", id: u1 }],
  );
});

test("CM-2a channel preferences, ordering and creation-policy constants match SQL CHECKs and generate their sentences", () => {
  const migration = readFileSync(
    new URL(
      "../supabase/migrations/20261113000002_channel_preferences_and_order.sql",
      import.meta.url,
    ),
    "utf8",
  );
  for (const level of CHANNEL_INVOLVEMENT_LEVELS) {
    assert.ok(
      CHANNEL_INVOLVEMENT_RULE_TEXT.includes(level),
      `involvement rule text names ${level}`,
    );
    assert.ok(
      migration.includes(`'${level}'`),
      `migration CHECK names involvement '${level}'`,
    );
  }
  for (const policy of CHANNEL_CREATION_POLICIES) {
    assert.ok(
      CHANNEL_CREATION_POLICY_RULE_TEXT.includes(policy),
      `creation policy rule text names ${policy}`,
    );
    assert.ok(
      migration.includes(`'${policy}'`),
      `migration CHECK names policy '${policy}'`,
    );
  }
  assert.equal(
    commandFieldsMessage(
      "channel_preference_set",
      ["channel_id"],
      CHANNEL_PREFERENCE_OPTIONAL_FIELDS,
    ),
    "channel_preference_set takes channel_id, and optionally starred and involvement, and nothing else.",
  );
  assert.equal(
    CHANNEL_PREFERENCE_EMPTY_TEXT,
    "channel_preference_set needs starred or involvement, or both.",
  );
  assert.equal(
    CHANNEL_PREFERENCE_TARGET_RULE_TEXT,
    "channel_id must be a UUID, or null for general.",
  );
  assert.equal(CHANNEL_STARRED_RULE_TEXT, "starred is true or false.");
  assert.ok(
    new RegExp(`(?<!\\d)${CHANNEL_REORDER_MAX}(?!\\d)`).test(
      CHANNEL_REORDER_RULE_TEXT,
    ),
  );
  assert.ok(
    new RegExp(`(?<!\\d)${CHANNEL_REORDER_MAX}(?!\\d)`).test(
      CHANNEL_STAR_REORDER_RULE_TEXT,
    ),
  );

  const u1 = "22222222-2222-4222-8222-222222222222";
  const u2 = "33333333-3333-4333-8333-333333333333";
  assert.equal(channelReorderListProblem([u1, u2]), null);
  assert.equal(channelReorderListProblem([]), CHANNEL_REORDER_RULE_TEXT);
  assert.equal(channelReorderListProblem([null]), CHANNEL_REORDER_RULE_TEXT);
  assert.match(
    String(channelReorderListProblem([u1, u1.toUpperCase()])),
    /same channel twice/,
  );

  assert.equal(channelStarReorderListProblem([null, u1, u2]), null);
  assert.equal(
    channelStarReorderListProblem([]),
    CHANNEL_STAR_REORDER_RULE_TEXT,
  );
  assert.match(
    String(channelStarReorderListProblem([null, null])),
    /same channel twice/,
  );
  assert.match(
    String(channelStarReorderListProblem([u1, u1.toUpperCase()])),
    /same channel twice/,
  );
});

/* ---------------------------------------------------------------------------
 * THE WAKE CLAIM, as a family rather than as three separate sentences.
 *
 * Five successive summaries of one rule were written on 2026-09-05 and every
 * one of them was wrong, each caught by a review arm after the previous one was
 * "fixed": a fan-out that wakes every agent recipient; "no agent would ever be
 * woken" called false; "notifies its first agent recipient"; "wakes ONE of
 * them"; "right about every agent except one". They failed the same way -- each
 * shortening assumed position 0 is an agent, and a set whose position 0 is a
 * PERSON wakes nobody at all.
 *
 * So the rule is one string, repeated verbatim, and this gate holds the family
 * together. BOUND, stated: it checks the three surfaces listed below for one
 * clause and for the retired wordings it knows about. It cannot tell you a
 * sixth wrong summary has been written in different words, and it does not read
 * the trigger -- tests/p1-local/chat-recipients-postgres.test.ts measures the
 * behaviour, including the [person, agent] case that reads zero.
 * ------------------------------------------------------------------------- */

/** Wordings retired on 2026-09-05. Each was false whenever position 0 is a person. */

/** Every file that summarises the wake. Adding one means adding it here. */

/**
 * Prose wraps, and it wraps differently in Markdown, in a blockquote and in a
 * SQL comment. Flatten line breaks and their leading `--`, `>` or `*` markers
 * to single spaces so one clause can be pinned across all three, instead of
 * three near-copies that are free to drift.
 */

/**
 * A retired wording may still be QUOTED -- a reader who met one has to be told
 * it is retired -- but only where a retirement marker says so. Each occurrence
 * must have one of these within the preceding window.
 */
