/**
 * Unit tests for Waiting on you per-person dismissals (Slice 1):
 * - Wire parsing & validation in supabase/functions/command/waiting-dismissals.ts
 * - HUMAN_ONLY_COMMANDS includes dismiss_waiting_item and restore_waiting_item
 *   (local agent tokens are refused by the early human-only gate before the dismissal branch or its audit)
 * - Uniform 404 body shared by fresh refusals and replay reauthorization
 * - Replay field preservation
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { HUMAN_ONLY_COMMANDS } from "../src/protocol/workspace-commands.js";
import {
  isWaitingDismissalCommandKind,
  parseWaitingDismissalCommand,
  reauthorizeWaitingDismissalReplay,
  WAITING_ITEM_NOT_FOUND_BODY,
  waitingDismissalReplayFields,
} from "../supabase/functions/command/waiting-dismissals.js";

const VALID_ID = "11111111-2222-4333-8444-555555555555";
const WS_ID = "22222222-3333-4444-8555-666666666666";
const USER_ID = "33333333-4444-4555-8666-777777777777";

test("HUMAN_ONLY_COMMANDS blocks local agent tokens at the early human-only gate before dismissal branch/audit", () => {
  assert.equal(HUMAN_ONLY_COMMANDS.has("dismiss_waiting_item"), true);
  assert.equal(HUMAN_ONLY_COMMANDS.has("restore_waiting_item"), true);
});

test("parseWaitingDismissalCommand validates kind, item_kind, UUID, and rejects extra fields", () => {
  assert.equal(isWaitingDismissalCommandKind("dismiss_waiting_item"), true);
  assert.equal(isWaitingDismissalCommandKind("restore_waiting_item"), true);
  assert.equal(isWaitingDismissalCommandKind("other"), false);

  for (const kind of ["dismiss_waiting_item", "restore_waiting_item"] as const) {
    for (const itemKind of ["ask", "todo", "review"] as const) {
      const parsed = parseWaitingDismissalCommand({
        kind,
        item_kind: itemKind,
        item_id: VALID_ID.toUpperCase(),
      });
      assert.deepEqual(parsed, {
        ok: true,
        command: { kind, item_kind: itemKind, item_id: VALID_ID },
      });
    }
  }

  const DISMISSAL_ID = "44444444-5555-4666-8777-888888888888";
  assert.deepEqual(
    parseWaitingDismissalCommand({
      kind: "restore_waiting_item",
      item_kind: "ask",
      item_id: VALID_ID.toUpperCase(),
      dismissal: DISMISSAL_ID.toUpperCase(),
    }),
    {
      ok: true,
      command: {
        kind: "restore_waiting_item",
        item_kind: "ask",
        item_id: VALID_ID,
        dismissal: DISMISSAL_ID,
      },
    },
  );

  for (const bad of [
    { kind: "dismiss_waiting_item", item_kind: "alert", item_id: VALID_ID },
    { kind: "dismiss_waiting_item", item_kind: "ask", item_id: "not-a-uuid" },
    { kind: "dismiss_waiting_item", item_kind: "ask" },
    { kind: "dismiss_waiting_item", item_kind: "ask", item_id: VALID_ID, extra: true },
    { kind: "dismiss_waiting_item", item_kind: "ask", item_id: VALID_ID, dismissal: DISMISSAL_ID },
    { kind: "restore_waiting_item", item_kind: "review", item_id: null },
    { kind: "restore_waiting_item", item_kind: "ask", item_id: VALID_ID, dismissal: "not-a-uuid" },
    { kind: "restore_waiting_item", item_kind: "ask", item_id: VALID_ID, dismissal: null },
    { kind: "unknown_kind", item_kind: "ask", item_id: VALID_ID },
  ]) {
    const parsed = parseWaitingDismissalCommand(bad as Record<string, unknown>);
    assert.equal(parsed.ok, false);
    if (!parsed.ok) assert.equal(parsed.status, 400);
  }
});

test("reauthorizeWaitingDismissalReplay returns null when allowed and uniform 404 when denied", async () => {
  const allowTx = (async () => [{ allowed: true }]) as unknown as Parameters<typeof reauthorizeWaitingDismissalReplay>[0];
  const denyTx = (async () => [{ allowed: false }]) as unknown as Parameters<typeof reauthorizeWaitingDismissalReplay>[0];

  assert.equal(await reauthorizeWaitingDismissalReplay(allowTx, WS_ID, USER_ID, "ask", VALID_ID), null);
  assert.deepEqual(
    await reauthorizeWaitingDismissalReplay(denyTx, WS_ID, USER_ID, "ask", VALID_ID),
    { status: 404, body: { ...WAITING_ITEM_NOT_FOUND_BODY } },
  );
});

test("waitingDismissalReplayFields preserves only valid dismissal/restore fields", () => {
  const DISMISSAL_ID = "44444444-5555-4666-8777-888888888888";
  assert.deepEqual(
    waitingDismissalReplayFields({
      item_kind: "ask",
      item_id: VALID_ID,
      dismissed: true,
      created: true,
      dismissal: DISMISSAL_ID,
      dismissed_at: "2026-11-23T12:00:00Z",
      audit_channel_id: "should-never-surface",
      ignored: "nope",
    }),
    {
      item_kind: "ask",
      item_id: VALID_ID,
      dismissed: true,
      created: true,
      dismissal: DISMISSAL_ID,
      dismissed_at: "2026-11-23T12:00:00Z",
    },
  );
  assert.deepEqual(
    waitingDismissalReplayFields({
      item_kind: "review",
      item_id: VALID_ID,
      restored: true,
      restored_at: "2026-11-23T12:05:00Z",
    }),
    {
      item_kind: "review",
      item_id: VALID_ID,
      restored: true,
      restored_at: "2026-11-23T12:05:00Z",
    },
  );
  assert.deepEqual(waitingDismissalReplayFields({ ok: true, event_ids: [] }), {});
});

test("release-proofs/waiting-dismissals contains catalog, functional, rollback, and rollback-catalog SQL", () => {
  const dir = new URL("../deploy/release-proofs/waiting-dismissals/", import.meta.url);
  for (const name of [
    "20261124000001-catalog.sql",
    "20261124000001-functional.sql",
    "20261124000001-rollback.sql",
    "20261124000001-rollback-catalog.sql",
  ]) {
    const content = readFileSync(new URL(name, dir), "utf8");
    assert.ok(content.trim().length > 0, `${name} should be non-empty`);
  }
});
