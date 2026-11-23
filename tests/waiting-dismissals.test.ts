/**
 * Unit tests for Waiting on you per-person dismissals (Slice 1):
 * - Wire parsing & validation in supabase/functions/command/waiting-dismissals.ts
 * - HUMAN_ONLY_COMMANDS includes dismiss_waiting_item and restore_waiting_item (agents get 403)
 * - Replay field preservation
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { HUMAN_ONLY_COMMANDS } from "../src/protocol/workspace-commands.js";
import {
  isWaitingDismissalCommandKind,
  parseWaitingDismissalCommand,
  waitingDismissalReplayFields,
} from "../supabase/functions/command/waiting-dismissals.js";

const VALID_ID = "11111111-2222-4333-8444-555555555555";

test("HUMAN_ONLY_COMMANDS blocks agent credentials from dismiss_waiting_item and restore_waiting_item", () => {
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

  for (const bad of [
    { kind: "dismiss_waiting_item", item_kind: "alert", item_id: VALID_ID },
    { kind: "dismiss_waiting_item", item_kind: "ask", item_id: "not-a-uuid" },
    { kind: "dismiss_waiting_item", item_kind: "ask" },
    { kind: "dismiss_waiting_item", item_kind: "ask", item_id: VALID_ID, extra: true },
    { kind: "restore_waiting_item", item_kind: "review", item_id: null },
    { kind: "unknown_kind", item_kind: "ask", item_id: VALID_ID },
  ]) {
    const parsed = parseWaitingDismissalCommand(bad as Record<string, unknown>);
    assert.equal(parsed.ok, false);
    if (!parsed.ok) assert.equal(parsed.status, 400);
  }
});

test("waitingDismissalReplayFields preserves only valid dismissal/restore fields", () => {
  assert.deepEqual(
    waitingDismissalReplayFields({
      item_kind: "ask",
      item_id: VALID_ID,
      dismissed: true,
      dismissed_at: "2026-11-23T12:00:00Z",
      ignored: "nope",
    }),
    {
      item_kind: "ask",
      item_id: VALID_ID,
      dismissed: true,
      dismissed_at: "2026-11-23T12:00:00Z",
    },
  );
  assert.deepEqual(
    waitingDismissalReplayFields({
      item_kind: "review",
      item_id: VALID_ID,
      restored: false,
      restored_at: "2026-11-23T12:05:00Z",
    }),
    {
      item_kind: "review",
      item_id: VALID_ID,
      restored: false,
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
