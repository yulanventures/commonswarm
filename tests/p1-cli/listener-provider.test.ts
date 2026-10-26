/**
 * CLI provider selection coverage. This file is reached by both the root
 * literal test list and the test:p1-cli glob.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  clampTurnBudgetToCredential,
  resolveTurnBudgetOrDefer,
  TURN_BUDGET_CREDENTIAL_MARGIN_MS,
} from "../../src/cli.js";
import { RENEWAL_WINDOW_EXPIRY_MARGIN_MS } from "../../src/listener/runtime.js";
import {
  ListenerRenewalUnavailableError,
} from "../../src/listener/index.js";

function runCli(args: string[]) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", ...args],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_OPTIONS: "--max-old-space-size=4096",
      },
      input: "",
    },
  );
}

test("hidden supervisor rejects another provider's executable before credentials", () => {
  const result = runCli([
    "__listen-supervisor",
    "--provider",
    "claude",
    "--grok-executable",
    "/tmp/grok",
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--grok-executable requires --provider grok/);
  assert.doesNotMatch(result.stderr, /credential|workspace-id must be a UUID/i);
});

test("a worker turn budget is clamped to the live credential's remaining lifetime", () => {
  const now = 1_000_000_000_000;
  const budget = 600_000; // the 10m default
  assert.equal(TURN_BUDGET_CREDENTIAL_MARGIN_MS, RENEWAL_WINDOW_EXPIRY_MARGIN_MS);
  // A turn begun just before renewal is due cannot occupy the renewal margin.
  for (const remaining of [660_000, 500_000, 400_000, 361_000]) {
    const applied = resolveTurnBudgetOrDefer(budget, now + remaining, now, false);
    assert.ok(now + applied <= now + remaining - RENEWAL_WINDOW_EXPIRY_MARGIN_MS);
  }
  const expiry = now + 361_000;
  const renewalDue = expiry - 6 * 60_000;
  const crossingTurn = resolveTurnBudgetOrDefer(budget, expiry, now, false);
  assert.ok(now < renewalDue && now + crossingTurn > renewalDue);
  assert.equal(now + crossingTurn, expiry - RENEWAL_WINDOW_EXPIRY_MARGIN_MS);
  // Plenty of credential left: the budget is untouched.
  assert.equal(
    clampTurnBudgetToCredential(budget, now + 3_600_000, now),
    budget,
  );
  // The credential expires before the budget would end: clamp to remaining
  // life minus the margin, so the turn ends while renewal can still run.
  assert.equal(
    clampTurnBudgetToCredential(budget, now + 300_000, now),
    300_000 - TURN_BUDGET_CREDENTIAL_MARGIN_MS,
  );
  // The invariant itself: the clamped budget plus the margin never crosses expiry.
  for (const remaining of [90_000, 300_000, 599_000, 601_000, 3_600_000]) {
    const clamped = clampTurnBudgetToCredential(budget, now + remaining, now);
    assert.ok(
      clamped + TURN_BUDGET_CREDENTIAL_MARGIN_MS <= remaining || clamped === 1_000,
      `budget ${clamped} outlives a credential with ${remaining}ms left`,
    );
  }
  // Nearly-dead or dead credential: floor at 1s — the turn fails as the
  // recoverable timeout class instead of running past expiry.
  assert.equal(clampTurnBudgetToCredential(budget, now + 10_000, now), 1_000);
  assert.equal(clampTurnBudgetToCredential(budget, now - 1, now), 1_000);
  // No known expiry: nothing to clamp against (such a credential never renews either).
  assert.equal(clampTurnBudgetToCredential(budget, null, now), budget);
});

test("resolveTurnBudgetOrDefer enforces the invariant: a turn starts only with a credential proven to outlast it", () => {
  const now = 1_000_000_000_000;
  const budget = 600_000; // the 10m default

  // Happy path: plenty of credential left, renewal fine -> full clamped budget.
  assert.equal(resolveTurnBudgetOrDefer(budget, now + 3_600_000, now, false), budget);

  // Renewal FAILED at turn start -> defer, never a doomed turn on the old cred.
  assert.throws(
    () => resolveTurnBudgetOrDefer(budget, now + 3_600_000, now, true),
    (error) => error instanceof ListenerRenewalUnavailableError,
    "a failed renewal must defer even when the credential looks live",
  );

  // Credential already INSIDE the margin (<= margin remaining) -> defer.
  for (const remaining of [0, 1, 30_000, TURN_BUDGET_CREDENTIAL_MARGIN_MS]) {
    assert.throws(
      () => resolveTurnBudgetOrDefer(budget, now + remaining, now, false),
      (error) => error instanceof ListenerRenewalUnavailableError,
      `remaining ${remaining} is inside the margin and must defer`,
    );
  }
  // A dead (past-expiry) credential defers too — it never reaches the 1s floor.
  assert.throws(
    () => resolveTurnBudgetOrDefer(budget, now - 1, now, false),
    (error) => error instanceof ListenerRenewalUnavailableError,
  );

  // Just OUTSIDE the margin -> a live credential, turn allowed, clamped short.
  const justOutside = TURN_BUDGET_CREDENTIAL_MARGIN_MS + 5_000; // 65s remaining
  const applied = resolveTurnBudgetOrDefer(budget, now + justOutside, now, false);
  assert.ok(applied >= 1_000, "a live credential yields a runnable budget");
  assert.ok(
    applied + TURN_BUDGET_CREDENTIAL_MARGIN_MS <= justOutside || applied === 1_000,
    "the applied budget still cannot outlast the credential",
  );

  // The 1s floor is reachable ONLY for a live credential just over the margin
  // (rotation-due-soon), never a dead one.
  const nearFloor = TURN_BUDGET_CREDENTIAL_MARGIN_MS + 500; // 60.5s remaining
  assert.equal(resolveTurnBudgetOrDefer(budget, now + nearFloor, now, false), 1_000);

  // Unknown expiry (out of scope: such a credential never renews) -> no defer.
  assert.equal(resolveTurnBudgetOrDefer(budget, null, now, false), budget);
});
