/**
 * Unit tests for retired/disconnected seat ask clearing (Part 1, R4 design):
 * - Wire parsing & validation in supabase/functions/command/retired-seat-asks.ts
 * - HUMAN_ONLY_COMMANDS includes clear_retired_seat_asks, and SEAT_ADMIN_* excludes it
 * - Blind wire response strips internal cutoff_epoch (both fresh and replay)
 * - Replay reauthorization returns null when allowed and uniform 404 when denied
 * - Leak-free audit detail carries principal_id=<uuid> only
 * - Client home contract & WAITING_ARCHIVED_OUTCOMES accept 'seat_cleared'
 * - Release proofs under deploy/release-proofs/retired-seat-asks/ exist and are non-empty
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  HUMAN_ONLY_COMMANDS,
  SEAT_ADMIN_REDUCER_KINDS,
} from "../src/protocol/workspace-commands.js";
import {
  SEAT_ADMIN_AGENT_KINDS,
  SEAT_ADMIN_EXECUTED_KINDS,
} from "../src/protocol/seat-admin.js";
import {
  applyClearRetiredSeatAsks,
  isRetiredSeatAskCommandKind,
  parseRetiredSeatAskCommand,
  reauthorizeRetiredSeatAskClearReplay,
  RETIRED_SEAT_NOT_FOUND_BODY,
  RETIRED_SEAT_STILL_LIVE_BODY,
  retiredSeatAskAuditDetail,
  retiredSeatAskReplayFields,
} from "../supabase/functions/command/retired-seat-asks.js";
import {
  parseWaitingArchivedPage,
  WAITING_ARCHIVED_OUTCOMES,
} from "../site/src/lib/home/client.js";
import type { KnownWaitingArchivedOutcomeKind } from "../site/src/lib/home/contract.js";

const PRINCIPAL_ID = "11111111-2222-4333-8444-555555555555";
const OTHER_ID = "99999999-8888-4777-8666-555555555555";
const WS_ID = "22222222-3333-4444-8555-666666666666";
const USER_ID = "33333333-4444-4555-8666-777777777777";
const CLEARED_AT = "2026-11-25T03:00:00.000Z";

test("HUMAN_ONLY_COMMANDS includes clear_retired_seat_asks and SEAT_ADMIN_* excludes it", () => {
  assert.equal(HUMAN_ONLY_COMMANDS.has("clear_retired_seat_asks"), true);
  assert.equal(
    (SEAT_ADMIN_AGENT_KINDS as readonly string[]).includes("clear_retired_seat_asks"),
    false,
  );
  assert.equal(
    (SEAT_ADMIN_EXECUTED_KINDS as readonly string[]).includes("clear_retired_seat_asks"),
    false,
  );
  assert.equal(SEAT_ADMIN_REDUCER_KINDS.has("clear_retired_seat_asks"), false);
});

test("parseRetiredSeatAskCommand validates principal_id UUID and rejects extra or missing fields", () => {
  assert.equal(isRetiredSeatAskCommandKind("clear_retired_seat_asks"), true);
  assert.equal(isRetiredSeatAskCommandKind("withdraw_ask"), false);
  assert.equal(isRetiredSeatAskCommandKind(null), false);

  const parsed = parseRetiredSeatAskCommand({
    kind: "clear_retired_seat_asks",
    principal_id: PRINCIPAL_ID.toUpperCase(),
  });
  assert.deepEqual(parsed, {
    ok: true,
    command: {
      kind: "clear_retired_seat_asks",
      principal_id: PRINCIPAL_ID,
    },
  });

  for (const bad of [
    { kind: "clear_retired_seat_asks" },
    { kind: "clear_retired_seat_asks", principal_id: "not-a-uuid" },
    { kind: "clear_retired_seat_asks", principal_id: null },
    { kind: "clear_retired_seat_asks", principal_id: PRINCIPAL_ID, extra: true },
    { kind: "clear_retired_seat_asks", principal_id: PRINCIPAL_ID, cutoff_epoch: 1 },
    { kind: "clear_retired_seat_asks", signal_id: PRINCIPAL_ID },
    { kind: "other_kind", principal_id: PRINCIPAL_ID },
  ]) {
    const res = parseRetiredSeatAskCommand(bad as Record<string, unknown>);
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.status, 400);
  }
});

test("applyClearRetiredSeatAsks maps SQL statuses and strips cutoff_epoch from wireResponse", async () => {
  const okTx = (async () => [{
    result: {
      status: "ok",
      principal_id: PRINCIPAL_ID.toUpperCase(),
      cutoff_epoch: 3,
      cleared_at: CLEARED_AT,
    },
  }]) as unknown as Parameters<typeof applyClearRetiredSeatAsks>[0];

  const ok = await applyClearRetiredSeatAsks(okTx, WS_ID, USER_ID, PRINCIPAL_ID);
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.deepEqual(ok.storedResponse, {
      principal_id: PRINCIPAL_ID,
      cutoff_epoch: 3,
      cleared_at: CLEARED_AT,
    });
    assert.deepEqual(ok.wireResponse, {
      principal_id: PRINCIPAL_ID,
      cleared_at: CLEARED_AT,
    });
    assert.equal(Object.hasOwn(ok.wireResponse, "cutoff_epoch"), false);
  }

  const liveTx = (async () => [{ result: { status: "seat_still_live" } }]) as unknown as
    Parameters<typeof applyClearRetiredSeatAsks>[0];
  assert.deepEqual(await applyClearRetiredSeatAsks(liveTx, WS_ID, USER_ID, PRINCIPAL_ID), {
    ok: false,
    status: 409,
    error: RETIRED_SEAT_STILL_LIVE_BODY.error,
    message: RETIRED_SEAT_STILL_LIVE_BODY.message,
    reason: "seat_still_live",
  });

  const disabledTx = (async () => [{ result: { status: "clearing_not_enabled" } }]) as unknown as
    Parameters<typeof applyClearRetiredSeatAsks>[0];
  const disabled = await applyClearRetiredSeatAsks(disabledTx, WS_ID, USER_ID, PRINCIPAL_ID);
  assert.equal(disabled.ok, false);
  if (!disabled.ok) {
    assert.equal(disabled.status, 503);
    assert.equal(disabled.error, "service_unavailable");
    assert.equal(disabled.reason, "clearing_not_enabled");
  }

  const notFoundTx = (async () => [{ result: { status: "not_found" } }]) as unknown as
    Parameters<typeof applyClearRetiredSeatAsks>[0];
  assert.deepEqual(await applyClearRetiredSeatAsks(notFoundTx, WS_ID, USER_ID, PRINCIPAL_ID), {
    ok: false,
    status: 404,
    error: RETIRED_SEAT_NOT_FOUND_BODY.error,
    message: RETIRED_SEAT_NOT_FOUND_BODY.message,
    reason: "seat_not_found",
  });

  const forbiddenTx = (async () => [{ result: { status: "forbidden" } }]) as unknown as
    Parameters<typeof applyClearRetiredSeatAsks>[0];
  const forbidden = await applyClearRetiredSeatAsks(forbiddenTx, WS_ID, USER_ID, PRINCIPAL_ID);
  assert.equal(forbidden.ok, false);
  if (!forbidden.ok) {
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.error, "forbidden");
  }
});

test("retiredSeatAskReplayFields strips internal cutoff_epoch and any extra fields", () => {
  const fields = retiredSeatAskReplayFields({
    ok: true,
    event_ids: [],
    principal_id: PRINCIPAL_ID.toUpperCase(),
    cutoff_epoch: 7,
    cleared_at: CLEARED_AT,
    cleared_count: 42,
    signal_ids: [OTHER_ID],
    channel_ids: [OTHER_ID],
  });
  assert.deepEqual(fields, {
    principal_id: PRINCIPAL_ID,
    cleared_at: CLEARED_AT,
  });
  assert.equal(Object.hasOwn(fields, "cutoff_epoch"), false);
  assert.equal(Object.hasOwn(fields, "cleared_count"), false);
  assert.deepEqual(retiredSeatAskReplayFields({ ok: true, event_ids: [] }), {});
  assert.deepEqual(retiredSeatAskReplayFields({ principal_id: PRINCIPAL_ID }), {});
});

test("reauthorizeRetiredSeatAskClearReplay allows matching stored receipt and refuses denied or malformed receipts", async () => {
  const allowTx = (async () => [{ allowed: true }]) as unknown as
    Parameters<typeof reauthorizeRetiredSeatAskClearReplay>[0];
  const denyTx = (async () => [{ allowed: false }]) as unknown as
    Parameters<typeof reauthorizeRetiredSeatAskClearReplay>[0];

  const stored = {
    principal_id: PRINCIPAL_ID,
    cutoff_epoch: 2,
    cleared_at: CLEARED_AT,
  };

  assert.equal(
    await reauthorizeRetiredSeatAskClearReplay(allowTx, WS_ID, USER_ID, stored, PRINCIPAL_ID),
    null,
  );
  assert.deepEqual(
    await reauthorizeRetiredSeatAskClearReplay(denyTx, WS_ID, USER_ID, stored, PRINCIPAL_ID),
    { status: 404, body: { ...RETIRED_SEAT_NOT_FOUND_BODY } },
  );
  // Mismatched principal_id or missing cutoff_epoch must refuse without hitting DB
  assert.deepEqual(
    await reauthorizeRetiredSeatAskClearReplay(allowTx, WS_ID, USER_ID, stored, OTHER_ID),
    { status: 404, body: { ...RETIRED_SEAT_NOT_FOUND_BODY } },
  );
  assert.deepEqual(
    await reauthorizeRetiredSeatAskClearReplay(
      allowTx,
      WS_ID,
      USER_ID,
      { principal_id: PRINCIPAL_ID, cleared_at: CLEARED_AT },
      PRINCIPAL_ID,
    ),
    { status: 404, body: { ...RETIRED_SEAT_NOT_FOUND_BODY } },
  );
});

test("retiredSeatAskAuditDetail formats principal_id only", () => {
  assert.equal(
    retiredSeatAskAuditDetail(PRINCIPAL_ID.toUpperCase(), null),
    `principal_id=${PRINCIPAL_ID}`,
  );
  assert.equal(
    retiredSeatAskAuditDetail(PRINCIPAL_ID, "ignored_identity=user"),
    `ignored_identity=user; principal_id=${PRINCIPAL_ID}`,
  );
});

test("home contract and WAITING_ARCHIVED_OUTCOMES accept seat_cleared", () => {
  const outcome: KnownWaitingArchivedOutcomeKind = "seat_cleared";
  assert.equal(WAITING_ARCHIVED_OUTCOMES.has(outcome), true);

  const page = parseWaitingArchivedPage(
    {
      workspace_id: WS_ID,
      generated_at: CLEARED_AT,
      total: 1,
      truncated: false,
      items: [
        {
          item_key: `ask:${OTHER_ID}`,
          kind: "ask",
          id: OTHER_ID,
          todo_id: null,
          ask_kind: "plain",
          title: "Question from inactive agent",
          from: { kind: "agent", id: PRINCIPAL_ID, name: "RetiredBot" },
          outcome_kind: "seat_cleared",
          outcome_text: "Cleared (seat inactive)",
          archived_at: CLEARED_AT,
          answered_by: null,
          placement: "general",
          channel_id: null,
          conversation_id: null,
          conversation_kind: "general",
        },
      ],
    },
    WS_ID,
  );
  assert.ok(page !== null);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]!.outcome_kind, "seat_cleared");
  assert.equal(page.items[0]!.outcome_text, "Cleared (seat inactive)");
});

test("release-proofs/retired-seat-asks contains all six Phase 1 and Phase 2 SQL proof files", () => {
  const dir = new URL("../deploy/release-proofs/retired-seat-asks/", import.meta.url);
  for (const name of [
    "20261125000002-catalog.sql",
    "20261125000002-functional.sql",
    "20261125000002-rollback.sql",
    "20261125000002-rollback-catalog.sql",
    "20261125000003-catalog.sql",
    "20261125000003-rollback.sql",
  ]) {
    const content = readFileSync(new URL(name, dir), "utf8");
    assert.ok(content.trim().length > 0, `${name} should be non-empty`);
  }
});
