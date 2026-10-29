import assert from "node:assert/strict";
import { test } from "node:test";
import {
  brainLinkClickOutcome,
  createBrainTopicReader,
} from "./brain-links.ts";

/* Reached by site/package.json's 'src/lib/*.test.mjs' glob. */

/** The names the real workspace brain holds today, plus one that is an ordinary English word. */
const TOPICS = [
  "brain-how-to",
  "false-success-signals",
  "shared-host",
  "commonswarm-roadmap",
  "agent_restart",
  "v0.1.50",
  "releases",
  "roadmap",
];

/** Only the topics a text actually offers to open, in order. */

/** What the reader would see, with every control's own words in brackets. */

/** A read whose settling this test controls. */
const deferred = () => {
  let settle;
  const promise = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });
  return { promise, ...settle };
};

test("a list that could NOT be refreshed authorizes NOTHING, even for a topic it holds", () => {
  /* DEFENCE IN DEPTH. The serialization in createBrainTopicReader is meant to guarantee the list
     is fresh at click time, and it has already been wrong once. This is the second lock: a read
     that failed did not establish "this topic exists", so it may not authorize an open even
     though the stale list still contains the name. */
  const stale = brainLinkClickOutcome("shared-host", TOPICS, false, true);
  assert.equal(stale.kind, "missing", "present in a STALE list is still not an open");
  assert.doesNotMatch(stale.message, /list here is current/u);
  assert.match(stale.message, /could not be refreshed just now/u);
  assert.match(stale.message, /cannot tell whether it is still here/u);
  assert.match(stale.message, /open it again/u, "it says what to do next");
  /* Absent from a stale list gets the same answer and the same words: the list is what is
     untrustworthy, not the name. */
  assert.deepEqual(brainLinkClickOutcome("shared-host", [], false, true), stale);
});

test("a click issued while a refresh is in flight resolves against the FRESH list", async () => {
  /* End to end over the two pieces: the reader waits out the running read and takes its own, and
     the outcome is computed from what that read produced. The topic is deleted while the cadence
     read is in flight, so a click that decided against the snapshot would answer "open". */
  let topics = ["shared-host", "releases"];
  const gate = deferred();
  let reads = 0;
  const reader = createBrainTopicReader({
    read: async () => {
      reads += 1;
      if (reads === 1) await gate.promise;
      /* Whatever the second read sees is the truth at that moment. */
      return true;
    },
    staleAfterMs: 30_000,
    now: () => 1_000_000,
  });

  const tick = reader.refresh(false);
  assert.equal(reads, 1, "the cadence read is in flight");

  const click = reader.refresh(true).then((fresh) =>
    brainLinkClickOutcome("shared-host", topics, fresh, true)
  );

  /* The delete lands while the cadence read is still open. */
  topics = ["releases"];
  gate.resolve();
  await tick;

  const outcome = await click;
  assert.equal(reads, 2, "the click took its own read after the running one finished");
  assert.equal(
    outcome.kind,
    "missing",
    "the click must answer from the list as of the click, not the snapshot behind it",
  );
});

/* ---- createBrainTopicReader: the race a review arm found ------------------------------- */

test("A FORCED refresh waits out a read already running, then takes its own", () => {
  /* THE DEFECT THIS PINS. The first version guarded with a plain in-flight boolean and returned
     early when it was set, so a click landing while the cadence tick was in flight returned
     without awaiting anything and decided against the OLD snapshot. Here the cadence read is
     deliberately left in flight when the click arrives. */
  const started = [];
  const gates = [deferred(), deferred()];
  const reader = createBrainTopicReader({
    read: async () => {
      const gate = gates[started.length];
      started.push(gate);
      await gate.promise;
      return true;
    },
    staleAfterMs: 30_000,
    now: () => 1_000_000,
  });

  const tick = reader.refresh(false);
  assert.equal(started.length, 1, "the cadence tick started a read");

  let clickSettled = false;
  const click = reader.refresh(true).then(() => {
    clickSettled = true;
  });

  return Promise.resolve()
    .then(() => {
      assert.equal(clickSettled, false, "the click must not resolve while a read is running");
      assert.equal(started.length, 1, "and must not start a second read on top of the first");
      gates[0].resolve();
      return tick;
    })
    .then(() => new Promise((resolve) => setTimeout(resolve, 0)))
    .then(() => {
      assert.equal(
        started.length,
        2,
        "after the running read finishes the click takes a FRESH one -- joining is not enough, " +
          "because a read that started before the click can predate what was clicked",
      );
      assert.equal(clickSettled, false, "and still has not resolved");
      gates[1].resolve();
      return click;
    })
    .then(() => assert.equal(clickSettled, true));
});

test("a read that did NOT apply leaves the list stale, however cleanly it resolved", async () => {
  /* THE DEFECT THIS PINS. readBrainTopics returns early -- resolving, not throwing -- when the
     workspace changed under it or when there is nothing to read. The first reader marked the list
     fresh on ANY resolution, so a click after a workspace switch was authorized against the
     previous workspace's names. Resolving false is how "I did not read" is told apart from
     "the list is current". */
  let applied = false;
  const reader = createBrainTopicReader({
    read: async () => applied,
    staleAfterMs: 30_000,
    now: () => 1_000_000,
  });
  assert.equal(await reader.refresh(true), false, "a read that bailed is not a fresh list");
  applied = true;
  assert.equal(await reader.refresh(true), true, "one that applied is");
});

test("a click abandoned by a workspace switch opens nothing and says nothing", async () => {
  /* THE DEFECT THIS PINS, in the exact sequence a review arm walked. The PREVIOUS version of this
     test held its read in the "bailing" state for EVERY read, so the forced read never applied and
     the path below was never reached -- removing the guard could not turn it red. Here read 1 (the
     cadence read, workspace A) bails, the reader switches to B, and read 2 (the click's own,
     against B) APPLIES. So the list IS fresh and the names ARE real -- they are just the wrong
     workspace's. Only contextIsCurrent can catch it. */
  let onWorkspaceA = true;
  const namesOfB = ["shared-host", "changelog"];
  const reader = createBrainTopicReader({
    read: async () => !onWorkspaceA,
    staleAfterMs: 30_000,
    now: () => 1_000_000,
  });
  const cadence = await reader.refresh(false);
  assert.equal(cadence, false, "the cadence read bailed, as it does mid-switch");

  onWorkspaceA = false;
  const listIsFresh = await reader.refresh(true);
  assert.equal(listIsFresh, true, "the click's own read APPLIED -- against B");

  /* "shared-host" exists in B too, so every other gate says open. */
  assert.ok(namesOfB.includes("shared-host"));
  const outcome = brainLinkClickOutcome("shared-host", namesOfB, listIsFresh, false);
  assert.equal(
    outcome.kind,
    "abandoned",
    "a click made in A must not open B's copy of the slug; the reader clicked nothing in B",
  );
  assert.equal(outcome.topic, "shared-host");
  assert.ok(!("message" in outcome), "and it must carry no notice to show in B");
});

test("a name missing from the NEW workspace is still abandoned, not reported", () => {
  /* The other half: without the context check this yanks the reader to Brain and shows a notice
     naming a slug from a workspace they have left. */
  const outcome = brainLinkClickOutcome("shared-host", ["changelog"], true, false);
  assert.equal(outcome.kind, "abandoned");
  assert.ok(!("message" in outcome));
});

test("context still current leaves every other gate deciding as before", () => {
  /* The guard must not swallow the ordinary answers. */
  assert.equal(brainLinkClickOutcome("shared-host", TOPICS, true, true).kind, "open");
  assert.equal(brainLinkClickOutcome("shared-host", [], true, true).kind, "missing");
  assert.equal(brainLinkClickOutcome("shared-host", TOPICS, false, true).kind, "missing");
});
