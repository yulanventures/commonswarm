/**
 * Reached by `npm --prefix site test` through the `src/lib/*.test.mjs` glob.
 *
 * These are the pure claims of the To: field: what the set holds, who the service wakes, and
 * what the reader is told about both. The rendered surface is measured in real Chrome by
 * `src/components/app/composer-to-field.observer.test.ts`; nothing here asserts pixels.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  composerAddressIsChosen,
  deriveComposerAddress,
  recipientKey,
  composerMentionNotice,
  composerAudience,
  draftAddressToStore,
  privateDraftActionLabel,
  privateDraftNotice,
  privateDraft,
  privateDraftPublicLabel,
  composerPlace,
  composerReach,
  composerSendPlan,
  SEND_HELD_LOADING,
  SEND_HELD_PRIVATE_DRAFT,
  SEND_HELD_THREAD_IN_DM,
} from "./composer-address.ts";
import { resolveStoredIdentityRefs } from "./identity-label.ts";

const wren = { kind: "agent", id: "agent-wren" };
const orbit = { kind: "agent", id: "agent-orbit" };
/* A THIRD AGENT, added 2026-09-05: the wake sentence counts agents above two, and two
   fixtures could not tell "the count is the set's" from "the count is 2". */
const dana = { kind: "person", id: "person-dana" };
const ada = { kind: "person", id: "person-ada" };

/* ────────────────────────────────────────────────────────────────────────────────────────
 * THE DERIVED PASS, DRIVEN THROUGH THE TRANSITIONS THAT USED TO BREAK IT.
 *
 * These reach the same function the dashboard calls. A browser cannot drive some of them:
 * sample mode has no send that stays in flight long enough to change a roster underneath,
 * and a real roster is never unknown there. What a browser CAN reach is measured in
 * `src/components/app/composer-to-field.observer.test.ts`, which switches workspace mid-draft
 * and edits a chip before switching.
 *
 * BOUND: these drive the pass. That the dashboard calls it at every one of its handlers is a
 * separate claim, counted out of the source in that observer file.
 * ──────────────────────────────────────────────────────────────────────────────────────── */

/** Everyone the tests below can address. Anybody not here has left the workspace. */
const roster = [wren, orbit, dana, ada];
const inRoster = (entity) =>
  roster.some((candidate) => recipientKey(candidate) === recipientKey(entity));

const derive = (overrides) =>
  deriveComposerAddress({
    rosterKnown: true,
    sending: false,
    known: inRoster,
    live: null,
    draft: null,
    remembered: [],
    tagged: [],
    ...overrides,
  });

test("a pass against an unknown roster commits nothing and keeps what is on screen", () => {
  /* THE WORKSPACE SWITCH. The screen paints once before the roster request settles. A pass
   * that committed there pruned the draft's set to empty against a roster that only looked
   * empty, marked the restore done, and let the next paint write the last-sent set over a
   * draft the reader had already addressed. */
  const held = derive({
    rosterKnown: false,
    draft: { to: [wren, orbit], applied: [recipientKey(wren)] },
    remembered: [dana],
    tagged: [wren],
  });
  assert.equal(held.committed, false, "a pass committed against a roster it does not know");
  assert.deepEqual(held.recipients, [], "an unknown roster produced a set anyway");
  /* And the same inputs one paint later, with the roster known, restore the draft's own set
   * rather than the last-sent one. */
  const settled = derive({
    draft: { to: [wren, orbit], applied: [recipientKey(wren)] },
    remembered: [dana],
    tagged: [wren],
  });
  assert.equal(settled.committed, true);
  assert.equal(settled.source, "draft");
  assert.deepEqual(settled.recipients, [wren, orbit], "the draft's address did not survive");
});

test("a draft that recorded an empty set is a broadcast, not a set nobody wrote down", () => {
  const chosen = derive({ draft: { to: [], applied: [] }, remembered: [wren] });
  assert.deepEqual(chosen.recipients, [], "an emptied To: came back addressed to last-sent");
  assert.equal(chosen.source, "draft");
  const nothingRecorded = derive({ draft: { to: null, applied: [] }, remembered: [wren] });
  assert.deepEqual(nothingRecorded.recipients, [wren]);
  assert.equal(nothingRecorded.source, "remembered");
});

test("a live set beats both stores, because it is what the reader is looking at", () => {
  const state = derive({
    live: { to: [ada], applied: [] },
    draft: { to: [wren], applied: [] },
    remembered: [orbit],
  });
  assert.deepEqual(state.recipients, [ada]);
  assert.equal(state.source, "live");
});

test("nothing moves the address while the message it addresses is on the wire", () => {
  /* THE SEND CAPTURED ITS RECIPIENTS ALREADY. A prune that moved the chips mid-post would
   * leave the row showing one set and the post naming another, which is the hidden recipient
   * this row exists to rule out. The set is frozen for the whole post and settles after it. */
  const gone = { kind: "agent", id: "agent-departed" };
  const during = derive({ sending: true, live: { to: [wren, gone], applied: [] } });
  assert.equal(during.committed, false, "the address was rewritten mid-send");
  assert.deepEqual(during.recipients, [wren, gone], "the row stopped showing what was sent");
  const after = derive({ live: { to: [wren, gone], applied: [] } });
  assert.equal(after.committed, true);
  assert.deepEqual(after.recipients, [wren], "the prune never landed once the send was over");
  assert.equal(after.announcedPrune, 1);
});

test("a tag whose chip was removed stays removed, and the record travels with the pair", () => {
  const removed = derive({
    live: { to: [orbit], applied: [recipientKey(wren)] },
    tagged: [wren],
  });
  assert.deepEqual(removed.recipients, [orbit], "a removed chip came back on the next pass");
  assert.deepEqual(removed.applied, [recipientKey(wren)]);
  /* The same pair read back out of a draft behaves the same way, which is what a reload and a
   * workspace switch both depend on. */
  const reloaded = derive({
    draft: { to: [orbit], applied: [recipientKey(wren)] },
    tagged: [wren],
  });
  assert.deepEqual(reloaded.recipients, [orbit]);
});

test("a set arrival pruned is not a set the reader chose", () => {
  /* ONLY A CHOICE IS WORTH STORING. Comparing the set on screen with the LAST-SENT set said
   * yes to a set nobody had touched: arrival prunes that set, so a workspace that lost a
   * member produced a difference on its own. Writing that down made the prune permanent —
   * the stored draft answered on the next arrival, before the remembered set could, so a
   * member who left and came back stayed out of To: for good. That is the invariant this lane
   * exists to hold, in its other direction: a set on screen must be a choice, never residue.
   */
  const gone = { kind: "agent", id: "agent-departed" };
  const known = (entity) => entity.id !== gone.id;
  assert.equal(
    composerAddressIsChosen([wren], [wren, gone], known),
    false,
    "a set that is only the remembered one, pruned, was stored as a choice the reader made",
  );
  /* What the reader actually did still counts, in each of its shapes. */
  assert.equal(composerAddressIsChosen([], [wren, gone], known), true, "emptied to a broadcast");
  assert.equal(
    composerAddressIsChosen([wren, orbit], [wren, gone], known),
    true,
    "a name added",
  );
  assert.equal(
    composerAddressIsChosen([orbit, wren], [wren, orbit], () => true),
    true,
    /* ~~"which changes who is woken and so changes the set"~~ Retired 2026-09-05: promoting
       changes which recipient the message shows as addressed to, and no longer changes the
       wake. The boolean this pins was always about the SET's order, so it is unmoved. */
    "a name promoted, which changes the order the set was chosen in",
  );
  /* And an unpruned set that matches is still not a choice. */
  assert.equal(composerAddressIsChosen([wren, orbit], [wren, orbit], () => true), false);
});

test("two same-name UUID drafts restore separately and a revoke does not retarget", () => {
  const wrenA = { kind: "agent", id: "11111111-1111-4111-8111-111111111111" };
  const wrenB = { kind: "agent", id: "22222222-2222-4222-8222-222222222222" };
  const roster = {
    agents: [
      { id: wrenA.id, name: "Wren" },
      { id: wrenB.id, name: "Wren" },
    ],
    members: [],
  };
  const restored = resolveStoredIdentityRefs(
    [{ kind: "agent", id: wrenA.id }, { kind: "agent", id: wrenB.id }],
    roster,
  );
  assert.deepEqual(restored.recipients, [wrenA, wrenB]);

  const known = (entity) => entity.id === wrenA.id;
  const state = derive({
    live: { to: [wrenA, wrenB], applied: [] },
    remembered: [wrenB],
    known,
  });
  assert.deepEqual(state.recipients, [wrenA]);
  assert.equal(
    state.recipients.some((entity) => entity.id === wrenB.id),
    false,
    "revoking one Wren must not retarget the chip to the other Wren",
  );

  const renamed = resolveStoredIdentityRefs(
    [{ kind: "agent", id: wrenA.id }],
    {
      agents: [
        { id: wrenA.id, name: "Orbit" },
        { id: wrenB.id, name: "Wren" },
      ],
      members: [],
    },
  );
  assert.deepEqual(renamed.recipients, [wrenA]);
});

test("a public composer says, in mention words, which tags it could not honour", () => {
  assert.equal(composerMentionNotice({ overflow: [], ambiguous: [] }), "");
  assert.equal(composerMentionNotice({ overflow: [], ambiguous: ["Sam"] }),
    '"Sam" names more than one person or agent here, so it mentions nobody. Choose the name from the mention list.');
  const both = composerMentionNotice({ overflow: ["Wren", "Orbit"], ambiguous: ["Sam", "Lee"] });
  assert.match(both, /^A message mentions at most 8, so Wren and Orbit are not mentioned\. /);
  assert.match(both, /"Sam" and "Lee" name more than one person or agent here, so they mention nobody\./);
  assert.doesNotMatch(both, /To:/, "a public place has no To: set to talk about");
});

/* A draft written to particular people must never be sent to everyone without the author being told first. */
const DANA = { kind: "person", id: "p-dana" };
const WREN = { kind: "agent", id: "a-wren" };
const everyoneKnown = () => true;

test("a draft with a stored To: set was written privately, whoever is still here", () => {
  assert.deepEqual(privateDraft("the offer is 240", 2, [DANA, WREN], everyoneKnown), { written: true, reachable: [DANA, WREN] });
  // One recipient has left: still written privately, and only the other can be reached.
  assert.deepEqual(privateDraft("the offer is 240", 2, [DANA, WREN], (entity) => entity.id !== "a-wren"),
    { written: true, reachable: [DANA] });
  // EVERY recipient has left, or none of the stored names resolves to one person any more. It was still written
  // privately; there is just nobody a Direct Message could reach.
  assert.deepEqual(privateDraft("the offer is 240", 1, [DANA], () => false), { written: true, reachable: [] });
  assert.deepEqual(privateDraft("the offer is 240", 2, [], everyoneKnown), { written: true, reachable: [] });
  // Not private: no stored set, an empty one (a broadcast the author chose), or nothing typed.
  assert.deepEqual(privateDraft("hello", 0, [], everyoneKnown), { written: false, reachable: [] });
  assert.deepEqual(privateDraft("   ", 1, [DANA], everyoneKnown), { written: false, reachable: [] });
  assert.equal(privateDraftNotice(["Dana Rivera", "Wren"], "#design"),
    "This was written to Dana Rivera and Wren. Sent here, everyone in #design can read it.");
  assert.equal(privateDraftNotice([], "#design"),
    "This was written as a private message, to someone who is no longer here. Sent here, everyone in #design can read it.");
  assert.equal(privateDraftActionLabel(["Dana Rivera"]), "Send to Dana Rivera instead");
  assert.equal(privateDraftPublicLabel("#design"), "Post in #design for everyone");
});

test("a public composer never overwrites the address a draft was saved with", () => {
  const stored = { to: [DANA], applied: ["person:p-dana"] };
  const publicLive = { to: [], applied: [] };
  // In a public place the set on screen is always empty. Storing it would erase who the draft was written to.
  assert.deepEqual(draftAddressToStore(true, stored, publicLive), { to: [DANA], applied: ["person:p-dana"] });
  assert.deepEqual(draftAddressToStore(true, null, publicLive), { to: undefined, applied: [] },
    "a draft first written in a channel has no address to keep");
  // An addressed composer stores what is on screen, and falls back to the stored pair before a pass commits.
  assert.deepEqual(draftAddressToStore(false, stored, { to: [WREN], applied: [] }), { to: [WREN], applied: [] });
  assert.deepEqual(draftAddressToStore(false, stored, null), { to: [DANA], applied: ["person:p-dana"] });
  assert.deepEqual(draftAddressToStore(false, null, { to: [], applied: [] }), { to: [], applied: [] },
    "an emptied To: is still written down in a Direct Message");
});

const label = (slug) => `#${slug}`;
const DESIGN = composerPlace(null, "design", "general", label);

test("the marker beside Send is private to named people or public in a place, never neither", () => {
  assert.deepEqual(composerAudience(["Dana Rivera"], DESIGN),
    { kind: "private", name: "Dana Rivera", sentence: "Private. Only Dana Rivera can read this." });
  assert.deepEqual(composerAudience(["Dana Rivera", "Wren", "Orbit"], DESIGN),
    { kind: "private", name: "Dana Rivera +2", sentence: "Private. Only Dana Rivera, Wren and Orbit can read this." });
  assert.deepEqual(composerAudience([], DESIGN),
    { kind: "public", name: "design", sentence: "Public. Everyone in #design can read this." });
});

test("the place a public message goes is named only when this page can name it", () => {
  assert.deepEqual(DESIGN, { label: "#design", marker: "design", named: true });
  assert.deepEqual(composerPlace(null, null, "general", label), { label: "#general", marker: "general", named: true });
  // A thread reply goes where the thread is, not where the reader is looking.
  assert.deepEqual(composerPlace({ kind: "channel", slug: "mobile" }, "design", "general", label),
    { label: "#mobile", marker: "mobile", named: true });
  assert.deepEqual(composerPlace({ kind: "unfiled" }, "design", "general", label).label, "#general");
  // The channel list did not load: the reply is still filed in the thread's channel. It is not called #general.
  const unknown = composerPlace({ kind: "unknown" }, "design", "general", label);
  assert.deepEqual(unknown, { label: "this thread's channel", marker: "this thread", named: false });
  assert.equal(composerAudience([], unknown).sentence, "Public. Everyone in this thread's channel can read this.");
  assert.doesNotMatch(JSON.stringify([unknown, composerAudience([], unknown)]), /general|design/);
});

/* What pressing Send does. The marker and the wire both come from here. */
const plan = (over = {}) => composerSendPlan({
  addressCommitted: true, directPartner: null, replying: false, privateDraftWritten: false, to: [], tagged: [], ...over,
});

test("in a public place Send posts to everyone with the tags as mentions, and never a recipient", () => {
  assert.deepEqual(plan({ tagged: [WREN] }), { send: true, audience: "public", recipients: [], mentions: [WREN] });
  assert.deepEqual(plan(), { send: true, audience: "public", recipients: [], mentions: [] }, "untagged: the key still goes, empty");
  // A To: set left over from a Direct Message is never sent from a public place.
  assert.deepEqual(plan({ to: [DANA], tagged: [] }), { send: true, audience: "public", recipients: [], mentions: [] });
  // A thread reply is public and can mention.
  assert.deepEqual(plan({ replying: true, tagged: [WREN] }), { send: true, audience: "public", recipients: [], mentions: [WREN] });
  assert.equal(composerReach(null, false), "public");
  assert.equal(composerReach(null, true), "public");
});

test("in a Direct Message Send is addressed to the partner first, with no mentions key", () => {
  const sent = plan({ directPartner: DANA, to: [DANA, WREN], tagged: [WREN] });
  assert.deepEqual(sent, { send: true, audience: "private", recipients: [DANA, WREN] });
  assert.equal(Object.hasOwn(sent, "mentions"), false);
  // Emptying To: does not turn a Direct Message into a broadcast.
  assert.deepEqual(plan({ directPartner: DANA, to: [] }), { send: true, audience: "private", recipients: [DANA] });
  assert.equal(composerReach(DANA, false), "private");
});

test("when the composer cannot be sure what it would send, it sends nothing and says why", () => {
  // The roster has not loaded, or a restored draft has not been checked yet.
  assert.deepEqual(plan({ addressCommitted: false }), { send: false, reason: SEND_HELD_LOADING });
  assert.deepEqual(plan({ addressCommitted: false, directPartner: DANA }), { send: false, reason: SEND_HELD_LOADING });
  // A draft written privately, sitting in a public composer, with no choice made.
  assert.deepEqual(plan({ privateDraftWritten: true, tagged: [WREN] }), { send: false, reason: SEND_HELD_PRIVATE_DRAFT });
  assert.deepEqual(plan({ privateDraftWritten: true, replying: true }), { send: false, reason: SEND_HELD_PRIVATE_DRAFT });
  // In its own Direct Message the same draft is simply sent, addressed.
  assert.equal(plan({ privateDraftWritten: true, directPartner: DANA }).send, true);
  // A thread reply left open under a Direct Message would post into the thread.
  assert.deepEqual(plan({ directPartner: DANA, replying: true, tagged: [WREN] }), { send: false, reason: SEND_HELD_THREAD_IN_DM });
});

test("the wire body for each plan is what the plan says", async () => {
  const { browserSignalCommand } = await import("./commonswarm.ts");
  const body = (sent, placement = {}) => browserSignalCommand("hello", sent.recipients, "note", [],
    sent.audience === "public" ? { ...placement, mentions: sent.mentions } : placement);
  const open = body(plan({ tagged: [WREN] }), { channel: "design" });
  assert.deepEqual(open.mentions, [{ kind: "agent", id: "a-wren" }]);
  assert.equal(Object.hasOwn(open, "to"), false);
  const untagged = body(plan(), { channel: "design" });
  assert.deepEqual(untagged.mentions, [], "the key is the public intent; a deployment with mentions off refuses it");
  const direct = body(plan({ directPartner: DANA, to: [WREN] }));
  assert.deepEqual(direct.to, [{ kind: "user", id: "p-dana" }, { kind: "agent", id: "a-wren" }]);
  assert.equal(Object.hasOwn(direct, "mentions"), false);
});
