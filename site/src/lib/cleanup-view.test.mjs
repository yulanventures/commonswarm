import assert from "node:assert/strict";
import { test } from "node:test";

import { cleanupAgentRows, cleanupFileRows, confirmNames, summaryText } from "./cleanup-view.ts";

const now = Date.parse("2026-11-04T12:00:00Z");
const day = 86_400_000;
const iso = (daysAgo) => new Date(now - daysAgo * day).toISOString();

test("agent rows: least active first, owner and kind shown, duplicate names told apart by id", () => {
  const rows = cleanupAgentRows([
    { principalId: "aaaaaaaa-1", name: "HezLead", transport: "local", ownerUserId: "u1", lastActiveAt: iso(0) },
    { principalId: "bbbbbbbb-2", name: "hezlead", transport: "hosted_mcp", ownerUserId: "u1", lastActiveAt: iso(9) },
    { principalId: "cccccccc-3", name: "Quiet <b>", transport: "local", ownerUserId: "u2", lastActiveAt: null },
  ], (id) => (id === "u1" ? "Tom" : "Sam"), now);
  assert.deepEqual(rows.map((r) => r.id), ["cccccccc-3", "bbbbbbbb-2", "aaaaaaaa-1"]);
  assert.equal(rows[0].label, "Quiet <b>", "labels are raw text for textContent");
  assert.match(rows[0].detail, /terminal · owner Sam · no activity recorded/);
  assert.match(rows[1].detail, /connected app · owner Tom · active 9 days ago · same name as another agent · id bbbbbbbb/);
  assert.match(rows[2].detail, /active today · same name as another agent · id aaaaaaaa/);
});

test("file rows: live only, filtered by age and by uploaders no longer here, oldest first", () => {
  const files = [
    { fileId: "f1", name: "old.txt", sizeBytes: 4096, uploadedByKind: "agent", uploadedBy: "gone", committedAt: iso(200), tombstonedAt: null },
    { fileId: "f2", name: "new.txt", sizeBytes: 10, uploadedByKind: "user", uploadedBy: "u1", committedAt: iso(2), tombstonedAt: null },
    { fileId: "f3", name: "mid.txt", sizeBytes: 2048, uploadedByKind: "agent", uploadedBy: "here", committedAt: iso(100), tombstonedAt: null },
    { fileId: "f4", name: "dead.txt", sizeBytes: 1, uploadedByKind: "user", uploadedBy: "u1", committedAt: iso(300), tombstonedAt: iso(1) },
  ];
  const name = (kind, id) => (id === "gone" ? null : id === "u1" ? "Tom" : "Builder");
  assert.deepEqual(cleanupFileRows(files, { olderThanDays: 0, uploaderGone: false }, name, now).map((r) => r.id), ["f1", "f3", "f2"]);
  assert.deepEqual(cleanupFileRows(files, { olderThanDays: 90, uploaderGone: false }, name, now).map((r) => r.id), ["f1", "f3"]);
  assert.deepEqual(cleanupFileRows(files, { olderThanDays: 0, uploaderGone: true }, name, now).map((r) => r.id), ["f1"]);
  assert.match(cleanupFileRows(files, { olderThanDays: 0, uploaderGone: true }, name, now)[0].detail, /4 KB · uploaded by an agent no longer here · 200 days ago/);
});

test("confirmations name up to 20 items, and results count every outcome class", () => {
  assert.equal(confirmNames(["a", "b"]), "a, b");
  assert.match(confirmNames(Array.from({ length: 25 }, (_, i) => `n${i}`)), /n19, and 5 more$/);
  const results = new Map([["1", "accepted"], ["2", "already_done"], ["3", "unknown"], ["4", "refused"], ["5", "not_attempted"]]);
  assert.equal(summaryText(results), "1 done · 1 already done · 1 refused · 1 outcome unknown · 1 not started");
});
