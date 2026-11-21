/**
 * @Name mentions outside the web composer: the shared parser in src/protocol, its parity with
 * what the composer imports, and the wire list the CLI and both MCP servers build from a body,
 * explicit selectors and one roster.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as shared from "../src/protocol/mention-address.js";
import {
  MENTION_MAX_RECIPIENTS,
  MentionResolutionError,
  bodyMayMention,
  foldMentionName,
  prefilterMentionCandidateAgents,
  resolveGroupDmAgentMentions,
  resolveMentions,
  type GroupDmAgentMember,
  type MentionRosterEntry,
} from "../src/protocol/mention-address.js";
import * as composer from "../site/src/lib/mention-address.js";
import { foldIdentityName } from "../site/src/lib/identity-label.js";
import { COMPOSER_TO_MAX } from "../site/src/lib/composer-address.js";
import { SIGNAL_MENTION_MAX } from "../supabase/functions/_shared/channels.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const WREN = id(1), WRENLEY = id(2), ORBIT = id(3), DANA_RIVERA = id(4), DANA = id(5), LEAD = id(6);
const roster: MentionRosterEntry[] = [
  { kind: "agent", id: WREN, name: "Wren" },
  { kind: "agent", id: WRENLEY, name: "Wrenley" },
  { kind: "agent", id: ORBIT, name: "Orbit" },
  { kind: "agent", id: LEAD, name: "CommonSwarm Lead (Sol)" },
  { kind: "user", id: DANA_RIVERA, name: "Dana Rivera" },
  { kind: "user", id: DANA, name: "Dana" },
];
const wire = (body: string, selectors: string[] = [], rows = roster) =>
  resolveMentions({ body, selectors, roster: rows }).map((m) => `${m.kind}:${m.id}`);

test("the composer reads tags with the shared parser, and the caps and folds agree", () => {
  assert.equal(composer.addressFromBody, shared.addressFromBody);
  assert.equal(composer.mentionSpans, shared.mentionSpans);
  assert.equal(composer.isTaggable, shared.isTaggable);
  assert.equal(MENTION_MAX_RECIPIENTS, SIGNAL_MENTION_MAX);
  assert.equal(MENTION_MAX_RECIPIENTS, COMPOSER_TO_MAX);
  assert.equal(composer.MENTION_MAX_RECIPIENTS, MENTION_MAX_RECIPIENTS);
  for (const name of ["İpek", "Zoë", "ÅSA", "Dana Rivera", "naïve", "ﬁle"]) {
    assert.equal(foldMentionName(name), foldIdentityName(name), name);
  }
});

test("one table, read by the composer's targets and by the roster the CLI reads, names the same people", () => {
  const targets = composer.mentionTargets(
    roster.filter((row) => row.kind === "agent").map((row) => ({ principalId: row.id, name: row.name })),
    roster.filter((row) => row.kind === "user").map((row) => ({ userId: row.id, name: row.name })),
  );
  const fromRoster = shared.mentionTargetsFromRoster(roster);
  const table = [
    "@Wren please ship it",
    "thanks @Orbit.",
    "@Wrenley and @Wren",
    "@Dana Rivera and @Dana",
    "(@orbit) [@WREN]",
    "mail me at me@wren.dev",
    "@nobody here",
    "@CommonSwarm Lead (Sol) can you look",
    "@CommonSwarm Lead",
  ];
  for (const body of table) {
    const left = composer.addressFromBody(body, targets);
    const right = shared.addressFromBody(body, fromRoster);
    assert.deepEqual(right.recipients, left.recipients, body);
    assert.deepEqual(right.ambiguous, left.ambiguous, body);
  }
});

test("tags resolve longest name first, fold case and accents, and an unmatched @word stays text", () => {
  assert.deepEqual(wire("@Wren please"), [`agent:${WREN}`]);
  assert.deepEqual(wire("@Wrenley please"), [`agent:${WRENLEY}`]);
  assert.deepEqual(wire("@dana rivera, then @DANA"), [`user:${DANA_RIVERA}`, `user:${DANA}`]);
  assert.deepEqual(wire("@CommonSwarm Lead (Sol) review"), [`agent:${LEAD}`]);
  assert.deepEqual(wire("write to me@wren.dev or @media screens"), []);
  assert.deepEqual(wire("no tags here"), []);
  assert.deepEqual(wire("@Wren"), wire("@Wrén"));
});

test("explicit selectors take a name, an id or @Name, and the list is deduplicated in order", () => {
  assert.deepEqual(wire("@Orbit look", ["Wren", ORBIT.toUpperCase(), "@Dana"]), [`agent:${ORBIT}`, `agent:${WREN}`, `user:${DANA}`]);
  assert.deepEqual(wire("@Wren @Wren", [WREN]), [`agent:${WREN}`]);
});

test("a shared name, an unknown selector, or more than eight mentions refuse with a sentence", () => {
  const twins: MentionRosterEntry[] = [...roster, { kind: "user", id: id(7), name: "Orbit" }];
  assert.throws(() => wire("@Orbit look", [], twins), (error: unknown) =>
    error instanceof MentionResolutionError && error.code === "mention_ambiguous" &&
    error.message.includes(ORBIT) && error.message.includes(id(7)));
  assert.throws(() => wire("hi", ["Orbit"], twins), (error: unknown) =>
    error instanceof MentionResolutionError && error.code === "mention_ambiguous");
  assert.throws(() => wire("hi", ["Nobody"]), (error: unknown) =>
    error instanceof MentionResolutionError && error.code === "mention_unknown");
  assert.throws(() => wire("hi", [id(99)]), (error: unknown) =>
    error instanceof MentionResolutionError && error.code === "mention_unknown");
  const crowd: MentionRosterEntry[] = Array.from({ length: 10 }, (_, n) => ({ kind: "agent" as const, id: id(100 + n), name: `Bot${n}` }));
  const nine = crowd.slice(0, 9).map((row) => `@${row.name}`).join(" ");
  assert.throws(() => wire(nine, [], crowd), (error: unknown) =>
    error instanceof MentionResolutionError && error.code === "mention_overflow" && error.message.includes("Bot8"));
  assert.throws(() => wire("@Bot0", crowd.slice(1, 9).map((row) => row.id), crowd), (error: unknown) =>
    error instanceof MentionResolutionError && error.code === "mention_overflow");
  assert.equal(wire(crowd.slice(0, 8).map((row) => `@${row.name}`).join(" "), [], crowd).length, 8);
});

test("only an @ that can open a tag asks for the roster", () => {
  assert.equal(bodyMayMention("@Wren hi"), true);
  assert.equal(bodyMayMention("hi (@Wren)"), true);
  assert.equal(bodyMayMention("me@wren.dev"), false);
  assert.equal(bodyMayMention("no at sign"), false);
});

test("C1e group-DM body mention resolver prefilters and resolves live peer agents without duplicating explicit to", () => {
  const peerAgents: GroupDmAgentMember[] = [
    { id: WREN, name: "Wren" },
    { id: WRENLEY, name: "Wrenley" },
    { id: ORBIT, name: "Orbit" },
    { id: LEAD, name: "CommonSwarm Lead (Sol)" },
    { id: id(20), name: "İpek" },
  ];

  // Prefilter narrows to plausible hits, respects accents/case, and ignores non-mention @ signs.
  assert.deepEqual(
    prefilterMentionCandidateAgents("Hey @ipek and @CommonSwarm Lead (Sol), see foo@wren.dev", peerAgents).map((a) => a.id),
    [LEAD, id(20)],
  );
  assert.deepEqual(prefilterMentionCandidateAgents("no at sign here", peerAgents), []);
  assert.deepEqual(prefilterMentionCandidateAgents("email@Wren.dev", peerAgents), []);

  // Single & multiple @Agent mentions preserve body order, respect boundaries, and ignore unknown tags.
  assert.deepEqual(
    resolveGroupDmAgentMentions({ body: "cc @Wrenley, @Wren, @Ghost, and @ipek!", peerAgents }),
    {
      ok: true,
      agents: [
        { kind: "agent", id: WRENLEY },
        { kind: "agent", id: WREN },
        { kind: "agent", id: id(20) },
      ],
    },
  );

  // Deduplicates against explicit `to` agents while adding newly mentioned peers.
  assert.deepEqual(
    resolveGroupDmAgentMentions({
      body: "@Wren and @Orbit please check",
      peerAgents,
      explicitTo: [{ kind: "agent", id: WREN }],
    }),
    {
      ok: true,
      agents: [{ kind: "agent", id: ORBIT }],
    },
  );

  // Duplicate names inside the same group DM refuse with mention_ambiguous naming only in-group IDs,
  // unless disambiguated via explicit `to`.
  const dupA = "11111111-1111-4111-8111-111111111111";
  const dupB = "22222222-2222-4222-8222-222222222222";
  const dupPeers: GroupDmAgentMember[] = [
    { id: dupA, name: "Reviewer" },
    { id: dupB, name: "Reviewer" },
    { id: ORBIT, name: "Orbit" },
  ];
  const amb = resolveGroupDmAgentMentions({ body: "@Reviewer please review", peerAgents: dupPeers });
  assert.equal(amb.ok, false);
  if (!amb.ok) {
    assert.equal(amb.error, "mention_ambiguous");
    assert.ok(amb.message.includes(dupA) && amb.message.includes(dupB));
  }
  assert.deepEqual(
    resolveGroupDmAgentMentions({
      body: "@Reviewer and @Orbit please review",
      peerAgents: dupPeers,
      explicitTo: [{ kind: "agent", id: dupA }],
    }),
    { ok: true, agents: [{ kind: "agent", id: ORBIT }] },
  );
});
