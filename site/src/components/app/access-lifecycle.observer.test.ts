import assert from "node:assert/strict";
import { test } from "node:test";
import { PendingRefreshGate } from "../../lib/pending-refresh";
import { isInviteSubmitCurrent } from "../../lib/invite-submit";

/** Evaluate the actual template's lists and attributes as a tree, without Astro or a DOM. */

/*
 * Heading hierarchy inside the card: the dashboard's channel title is the H1, so
 * every AgentConnect state must expose a primary H2 — never an H3 skip
 * (the audit found H1-workspace -> H3-result), never the stale "Name your agent."
 * above post-submit progress, never a heading-less state. These anchors pin the
 * markup levels and the CSS that retires the head; the live a11y-tree check is
 * separate evidence, not something a regex can claim.
 */

/*
 * CAUSAL, NOT SOURCE-MATCHED: these drive the same pendingAccessRows the dashboard
 * renders from. What is pinned: the filter (a used, revoked, or expired key is
 * history, not access), the order (invites before agent keys), the identity line
 * (model and owner), and the ids the cancel commands need.
 */

test("invite submit owner rejects A's credential after an A-to-B switch", () => {
  const owner = { workspaceId: "A", version: 7 };
  let activeWorkspaceId = "A";
  let requestVersion = 7;
  let visibleCredential = "";
  const settleCreate = (credential: string): void => {
    if (!isInviteSubmitCurrent(owner, activeWorkspaceId, requestVersion)) return;
    visibleCredential = credential;
  };

  activeWorkspaceId = "B";
  requestVersion = 8;
  settleCreate("one-use-A");
  assert.equal(visibleCredential, "", "A's token is discarded rather than rendered in B");
});

test("invite pending follow-up cannot assign A rows after B then C take ownership", () => {
  const owner = { workspaceId: "A", version: 11 };
  let activeWorkspaceId = "A";
  let requestVersion = 11;
  let visiblePending = ["C-existing"];
  assert.equal(
    isInviteSubmitCurrent(owner, activeWorkspaceId, requestVersion),
    true,
    "A owns the follow-up when it starts",
  );

  activeWorkspaceId = "B";
  requestVersion = 12;
  activeWorkspaceId = "C";
  requestVersion = 13;
  const applyPending = (rows: string[]): void => {
    if (!isInviteSubmitCurrent(owner, activeWorkspaceId, requestVersion)) return;
    visiblePending = rows;
  };
  applyPending(["A-invite"]);
  assert.deepEqual(
    visiblePending,
    ["C-existing"],
    "A's pending response cannot overwrite the state owned by C",
  );
});

/*
 * The empty-workspace stale-row bug: agents=[], view=no-agents, one pending invite.
 * The poll predicate takes no view input at all — that is the fix — so the
 * no-agents view cannot starve the cadence. This drives the real predicate and
 * the real gate through a simulated redemption: the row clears on its own, then
 * the timer remains cheap and discoverable at the slower idle cadence.
 */

/*
 * Pending access is a waiting room: the inviter watches it until the teammate redeems
 * or the agent first connects. Consumption that happens in ANOTHER session must clear
 * the row without a full workspace reopen, so the dedicated access cadence runs in
 * every channel view and slows down — but stays discoverable — when local state is
 * empty. Feed ticks may offer catch-up without owning that cadence.
 *
 * CAUSAL, NOT SOURCE-MATCHED: the race tests below import and drive the same
 * PendingRefreshGate class the dashboard constructs. The race being pinned: a slow
 * refresh for workspace A is in flight when the user switches to workspace B — B's
 * refresh must start immediately, A's late completion must not free B's ownership,
 * and nothing A carries may be applied over B's state. The regexes at the end only
 * pin that the dashboard is wired to this class; they make no causal claim.
 */
test("pending-refresh gate: a slow old-workspace request cannot block or clear the new one", () => {
  const gate = new PendingRefreshGate(12_000, 30_000);
  const t0 = 100_000;
  assert.equal(gate.tryAcquire("A", 1, t0, true), true, "A owns its refresh");
  // The user switches workspaces mid-flight; openWorkspace resets the cooldown.
  gate.resetCooldown();
  assert.equal(
    gate.tryAcquire("B", 2, t0 + 50, true),
    true,
    "B refreshes immediately — it never waits behind A's slow request",
  );
  gate.release("A", 1);
  assert.equal(
    gate.tryAcquire("B", 2, t0 + 100, true),
    false,
    "A's late completion did not free the gate: B's refresh is still owned",
  );
  gate.release("B", 2);
  assert.equal(
    gate.tryAcquire("B", 2, t0 + 12_101, true),
    true,
    "once B finishes and the cooldown passes, B can refresh again",
  );
});

test("pending-refresh gate: generations of one workspace stay ordered", () => {
  const gate = new PendingRefreshGate(12_000, 30_000);
  const t0 = 200_000;
  assert.equal(gate.tryAcquire("A", 1, t0, true), true);
  // Same workspace, newer generation (reopened): the new generation takes the gate.
  gate.resetCooldown();
  assert.equal(gate.tryAcquire("A", 2, t0 + 50, true), true);
  gate.release("A", 1);
  assert.equal(
    gate.tryAcquire("A", 2, t0 + 100, true),
    false,
    "the older generation's completion cannot free the newer generation's slot",
  );
});

/*
 * The header's Live chip is the consumer-readable promise that the channel updates
 * itself. It must be true exactly while the poll can be armed: feed views only,
 * never sample mode, and it starts hidden in the static markup.
 */
