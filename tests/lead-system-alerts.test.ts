/**
 * Unit and contract checks for lead system alerts (CS fcb99658):
 * command parser, cloud client/CLI wire builders, migration grants/RLS/lock-order/pg_cron
 * invariants, rollback coverage, and no ops email bridge.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  parseResolveSystemAlertCommand,
  RESOLVE_SYSTEM_ALERT_FIELDS_TEXT,
  RESOLVE_SYSTEM_ALERT_ID_RULE_TEXT,
  RESOLVE_SYSTEM_ALERT_KIND,
  RESOLVE_SYSTEM_ALERT_NOTE_RULE_TEXT,
  SYSTEM_ALERT_KINDS,
} from "../supabase/functions/command/system-alerts.js";
import { HUMAN_ONLY_COMMANDS } from "../src/protocol/workspace-commands.js";
import { resolveSystemAlertCommand, systemAlertToSignalRecord } from "../src/cloud/system-alerts.js";
import { deliveryAckIds } from "../src/cloud/agent-check.js";
import { seenAckTargets } from "../src/cloud/agent-signal-receipts.js";
import { surfacedDeliveryIds } from "../src/cloud/delivery-observation.js";
import { arrivalNotification, runArrivalWatch } from "../src/cloud/arrival-watch.js";
import { STDIO_MCP_TOOLS } from "../src/mcp/tools.js";
import type { SignalRecord } from "../src/cloud/command-client.js";

const ALERT = "11111111-2222-4333-8444-555555555555";
const WS = "22222222-3333-4444-8555-666666666666";
const LEAD = "33333333-4444-4555-8666-777777777777";
const AFFECTED = "44444444-5555-4666-8777-888888888888";
const NORMAL_SIG = "55555555-6666-4777-8888-999999999999";

test("resolve_system_alert parses valid UUID and trimmed non-control note", () => {
  assert.deepEqual(
    parseResolveSystemAlertCommand({
      kind: RESOLVE_SYSTEM_ALERT_KIND,
      alert_id: ALERT.toUpperCase(),
      note: "  Restarted listener on workstation.  ",
    }),
    {
      ok: true,
      command: {
        kind: "resolve_system_alert",
        alert_id: ALERT,
        note: "Restarted listener on workstation.",
      },
    },
  );
  assert.deepEqual(resolveSystemAlertCommand(ALERT.toUpperCase(), "  Fixed listener  "), {
    kind: "resolve_system_alert",
    alert_id: ALERT,
    note: "Fixed listener",
  });
});

test("resolve_system_alert refuses wrong fields, bad UUID, empty/overlong/control notes", () => {
  assert.deepEqual(
    parseResolveSystemAlertCommand({ kind: RESOLVE_SYSTEM_ALERT_KIND, alert_id: ALERT }),
    { ok: false, status: 400, reason: RESOLVE_SYSTEM_ALERT_FIELDS_TEXT },
  );
  assert.deepEqual(
    parseResolveSystemAlertCommand({ kind: RESOLVE_SYSTEM_ALERT_KIND, alert_id: ALERT, note: "ok", extra: 1 }),
    { ok: false, status: 400, reason: RESOLVE_SYSTEM_ALERT_FIELDS_TEXT },
  );
  for (const badId of ["", "not-a-uuid", null, 123]) {
    assert.deepEqual(
      parseResolveSystemAlertCommand({ kind: RESOLVE_SYSTEM_ALERT_KIND, alert_id: badId, note: "ok" }),
      { ok: false, status: 400, reason: RESOLVE_SYSTEM_ALERT_ID_RULE_TEXT },
    );
  }
  for (const badNote of ["", "   ", "a".repeat(501), "line1\nline2", "tab\there", "nul\u0000", null, 42]) {
    assert.deepEqual(
      parseResolveSystemAlertCommand({ kind: RESOLVE_SYSTEM_ALERT_KIND, alert_id: ALERT, note: badNote }),
      { ok: false, status: 400, reason: RESOLVE_SYSTEM_ALERT_NOTE_RULE_TEXT },
    );
  }
  assert.throws(() => resolveSystemAlertCommand("bad-id", "ok"), /UUID/);
  assert.throws(() => resolveSystemAlertCommand(ALERT, "bad\nnote"), /non-control/);
});

test("migration enforces FORCE RLS, narrow reader grant, scope locks, pg_cron schedule, owner-only escalation and clean rollback", () => {
  const migration = readFileSync("supabase/migrations/20261119000001_lead_system_alerts.sql", "utf8");
  const rollback = readFileSync("deploy/release-proofs/lead-system-alerts/20261119000001-rollback.sql", "utf8");
  const commandEdge = readFileSync("supabase/functions/command/index.ts", "utf8");

  assert.equal(HUMAN_ONLY_COMMANDS.has(RESOLVE_SYSTEM_ALERT_KIND as never), false);
  assert.match(commandEdge, /"resolve_system_alert"/);

  for (const kind of SYSTEM_ALERT_KINDS) {
    assert.match(migration, new RegExp(`'${kind}'`));
  }

  assert.match(migration, /ALTER TABLE swarm\.system_alerts ENABLE ROW LEVEL SECURITY;/);
  assert.match(migration, /ALTER TABLE swarm\.system_alerts FORCE ROW LEVEL SECURITY;/);
  assert.match(
    migration,
    /REVOKE ALL ON TABLE swarm\.system_alerts\s+FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;/,
  );
  // Narrow reader grant for view predicate ONLY.
  assert.match(
    migration,
    /GRANT EXECUTE ON FUNCTION\s+swarm\.system_alert_claims_can_read\(uuid, uuid, uuid\)\s+TO authenticated, swarm_read;/,
  );
  // Producers and scope lock helpers remain private/pinned (scoped per SQL statement).
  assert.doesNotMatch(migration, /GRANT EXECUTE[^;]*sync_quiet_agent_alerts[^;]*TO\s+(authenticated|swarm_read|swarm_command)/);
  assert.doesNotMatch(migration, /GRANT EXECUTE[^;]*escalate_due_system_alerts[^;]*TO\s+(authenticated|swarm_read|swarm_command)/);
  assert.doesNotMatch(migration, /GRANT EXECUTE[^;]*system_alert_lock_scope[^;]*TO\s+(authenticated|swarm_read|swarm_command)/);
  // Canonical scope lock order (NO channel-access inversion, NO parent-locking FKs), multi-scope
  // (workspace_id, conversation_id) pre-lock, read-only resolve precheck & bare {"v": 1} wake frames.
  assert.doesNotMatch(migration, /'channel-access:'/);
  assert.doesNotMatch(migration, /CREATE TABLE swarm\.system_alerts[\s\S]*?REFERENCES\s+swarm\./);
  assert.match(migration, /CREATE TRIGGER system_alerts_validate_refs/);
  assert.match(migration, /ORDER BY c\.workspace_id ASC, c\.conversation_id ASC\s+FOR SHARE/);
  assert.match(migration, /'conversation-frames:'/);
  assert.match(migration, /CREATE FUNCTION swarm\.system_alert_lock_scopes\(/);
  assert.match(migration, /CREATE FUNCTION swarm\.system_alert_actor_can_resolve\(/);
  assert.match(migration, /CREATE TRIGGER channels_sync_conversation_frames/);
  assert.match(migration, /CREATE TRIGGER channel_members_lock_agent_frames/);
  assert.doesNotMatch(migration, /'alert_id', NEW\.alert_id/);
  // Owner alert inbox requires role='owner' and rejects agent claims.
  assert.match(migration, /v_claims \? 'agent_principal_id'/);
  assert.match(migration, /m\.role = 'owner'/);
  // pg_cron timer scheduled & unscheduled on rollback.
  assert.match(migration, /'swarm-sync-system-alerts'/);
  assert.match(rollback, /cron\.unschedule\('swarm-sync-system-alerts'\)/);
  // No email bridge in the migration.
  assert.doesNotMatch(migration, /smtp|alerts\.jsonl|quiet-agents\.sql/i);

  // Rollback drops table, view, triggers and functions.
  assert.match(rollback, /DROP FUNCTION IF EXISTS swarm_read\.owner_alert_inbox\(uuid\);/);
  assert.match(rollback, /DROP VIEW IF EXISTS swarm_read\.system_alerts;/);
  assert.match(rollback, /DROP TABLE IF EXISTS swarm\.system_alerts;/);
});

test("system_alert inbox marker skips delivery ack, observation, auto-eyes reaction and points arrival notification to cswarm alert resolve", () => {
  const alertRow: SignalRecord = {
    id: ALERT,
    workspace_id: WS,
    from: AFFECTED,
    from_kind: "agent",
    to: null,
    to_agent: LEAD,
    in_reply_to: null,
    about: "system_alert:agent_quiet",
    kind: "note",
    body: `System alert (agent_quiet, id ${ALERT}): seat stopped listening.`,
    until: "2026-12-01T00:00:00Z",
    created_at: "2026-11-19T15:00:00Z",
    recipients: [{ kind: "agent", id: LEAD, position: 0 }],
    audience: "private",
    system_alert: { alert_id: ALERT, kind: "agent_quiet", affected_principal_id: AFFECTED },
  };
  const normalRow: SignalRecord = {
    id: NORMAL_SIG,
    workspace_id: WS,
    from: AFFECTED,
    from_kind: "agent",
    to: null,
    to_agent: LEAD,
    in_reply_to: null,
    about: null,
    kind: "note",
    body: "Normal note to lead.",
    until: "2026-12-01T00:00:00Z",
    created_at: "2026-11-19T15:01:00Z",
    recipients: [{ kind: "agent", id: LEAD, position: 0 }],
    audience: "private",
  };
  const rows = [alertRow, normalRow];

  assert.deepEqual(deliveryAckIds(rows), [NORMAL_SIG], "deliveryAckIds must skip system_alert rows");
  assert.deepEqual(seenAckTargets(rows, LEAD), [NORMAL_SIG], "seenAckTargets must skip system_alert rows");
  assert.deepEqual(surfacedDeliveryIds(rows, LEAD), [NORMAL_SIG], "surfacedDeliveryIds must skip system_alert rows");

  const notif = arrivalNotification(alertRow, WS, { url: "https://api.commonswarm.com", anonKey: "anon" });
  assert.equal(notif.reply_command, `cswarm alert resolve ${ALERT} "<note>" --workspace-id ${WS}`);

  const toolNames = STDIO_MCP_TOOLS.map((t) => t.name);
  assert.ok(toolNames.includes("alerts"), "STDIO_MCP_TOOLS includes alerts");
  assert.ok(toolNames.includes("alert_resolve"), "STDIO_MCP_TOOLS includes alert_resolve");
});

test("runArrivalWatch reconciles multi-page openSystemAlerts independently of signal cursor without duplicates", async () => {
  const controller = new AbortController();
  const emitted: SignalRecord[] = [];
  const OLDER_1 = "55555555-5555-4555-8555-555555555501";
  const OLDER_2 = "55555555-5555-4555-8555-555555555502";
  const LATE_BEHIND = "55555555-5555-4555-8555-555555555503";
  const NEWER_AHEAD = "55555555-5555-4555-8555-555555555504";
  let savedCursor: { created_at: string; id: string } | null = {
    created_at: "2026-11-19T16:10:00.000Z",
    id: NORMAL_SIG,
  };
  let idleCycles = 0;
  const makeAlert = (id: string, routedAt: string) =>
    systemAlertToSignalRecord(
      {
        alert_id: id,
        workspace_id: WS,
        channel_id: null,
        kind: "agent_quiet",
        affected_principal_id: AFFECTED,
        affected_seat_name: "quiet-seat",
        fix_hint: "Restart its listener.",
        waiting_count: 2,
        oldest_waiting_at: "2026-11-19T15:30:00.000Z",
        routed_lead_principal_id: LEAD,
        routed_at: routedAt,
        opened_at: "2026-11-19T15:45:00.000Z",
        escalated_at: null,
      },
      LEAD,
    );
  const older1 = makeAlert(OLDER_1, "2026-11-19T16:01:00.000Z");
  const older2 = makeAlert(OLDER_2, "2026-11-19T16:02:00.000Z");
  const lateBehind = makeAlert(LATE_BEHIND, "2026-11-19T16:05:00.000Z"); // behind cursor AND on page 2
  const newerAhead = makeAlert(NEWER_AHEAD, "2026-11-19T16:15:00.000Z"); // ahead of cursor
  const allOpen = [older1, older2, lateBehind, newerAhead];
  const seenAlertAfters: Array<string | null> = [];

  await runArrivalWatch({
    workspaceId: WS,
    principalId: LEAD,
    signal: controller.signal,
    pollMs: 1,
    pageLimit: 2,
    sleep: async (ms) => {
      if (ms > 0) {
        idleCycles += 1;
        if (idleCycles >= 3) controller.abort();
      }
    },
    store: {
      location: "memory://lead-system-alerts-test",
      read: async () => savedCursor,
      write: async (next) => { savedCursor = next; },
    },
    readPage: async ({ after, alertAfter, limit }) => {
      seenAlertAfters.push(alertAfter?.id ?? null);
      const afterMs = after ? Date.parse(after.created_at) : -Infinity;
      const signals = allOpen
        .filter((r) => Date.parse(r.created_at) > afterMs || (Date.parse(r.created_at) === afterMs && r.id > (after?.id ?? "")))
        .slice(0, limit);
      const alertAfterMs = alertAfter ? Date.parse(alertAfter.created_at) : -Infinity;
      const openSlice = allOpen.filter(
        (r) => Date.parse(r.created_at) > alertAfterMs || (Date.parse(r.created_at) === alertAfterMs && r.id > (alertAfter?.id ?? "")),
      );
      return {
        signals,
        openSystemAlerts: openSlice.slice(0, limit),
        ...(openSlice.length > limit ? { openSystemAlertsHasMore: true } : {}),
        rawCount: signals.length,
        malformedRows: 0,
        pendingDeliveryCount: 0,
        nextCursor: signals.length > 0 ? { created_at: signals[signals.length - 1]!.created_at, id: signals[signals.length - 1]!.id } : null,
        capabilities: { cursorAfter: true, senderOwnerRelation: false, deliveryClaim: false, deliveryAck: false },
        legacyCursorFallback: false,
      };
    },
    emit: async (row) => { emitted.push(row); },
  });
  assert.ok(seenAlertAfters.includes(OLDER_2), "reconciliation must advance alertAfter past the full page of older routes");
  assert.deepEqual(
    emitted.map((r) => r.id).sort(),
    [OLDER_1, OLDER_2, LATE_BEHIND, NEWER_AHEAD].sort(),
    "each open route (older page 1, newer ordinary cursor, behind-cursor page 2) must emit exactly once across 3 cycles",
  );
  assert.equal(savedCursor?.id, NEWER_AHEAD, "signal cursor advances on ordinary path and never rewinds on reconciliation");
});

test("runArrivalWatch does not re-emit an alert on the ordinary path after reconciliation already emitted it, while still persisting the signal cursor", async () => {
  const controller = new AbortController();
  const emitted: SignalRecord[] = [];
  const EARLIER_MSG = "66666666-6666-4666-8666-666666666601";
  const AHEAD_ALERT = "66666666-6666-4666-8666-666666666602";
  const earlierMessage: SignalRecord = {
    id: EARLIER_MSG,
    workspace_id: WS,
    from: AFFECTED,
    from_kind: "agent",
    to: null,
    to_agent: LEAD,
    in_reply_to: null,
    about: null,
    kind: "note",
    body: "Earlier normal message filling page 1.",
    until: "2030-01-01T00:00:00.000Z",
    created_at: "2026-11-19T16:01:00.000Z",
    sender_owner_relation: "same_owner",
  };
  const aheadAlert = systemAlertToSignalRecord(
    {
      alert_id: AHEAD_ALERT,
      workspace_id: WS,
      channel_id: null,
      kind: "agent_quiet",
      affected_principal_id: AFFECTED,
      affected_seat_name: "quiet-seat",
      fix_hint: "Restart its listener.",
      waiting_count: 1,
      oldest_waiting_at: "2026-11-19T15:30:00.000Z",
      routed_lead_principal_id: LEAD,
      routed_at: "2026-11-19T16:02:00.000Z",
      opened_at: "2026-11-19T16:02:00.000Z",
      escalated_at: null,
    },
    LEAD,
  );
  const stream = [earlierMessage, aheadAlert];
  const state: { cursor: { created_at: string; id: string } | null } = { cursor: null };
  let idleCycles = 0;

  await runArrivalWatch({
    workspaceId: WS,
    principalId: LEAD,
    signal: controller.signal,
    pollMs: 1,
    pageLimit: 1,
    sleep: async (ms) => {
      if (ms > 0) {
        idleCycles += 1;
        if (idleCycles >= 2) controller.abort();
      }
    },
    store: {
      location: "memory://reconcile-then-ordinary-test",
      read: async () => state.cursor,
      write: async (next) => { state.cursor = next; },
    },
    readPage: async ({ after, limit }) => {
      const afterMs = after ? Date.parse(after.created_at) : -Infinity;
      const signals = stream
        .filter((r) => Date.parse(r.created_at) > afterMs || (Date.parse(r.created_at) === afterMs && r.id > (after?.id ?? "")))
        .slice(0, limit);
      return {
        signals,
        openSystemAlerts: [aheadAlert],
        rawCount: signals.length,
        malformedRows: 0,
        pendingDeliveryCount: 0,
        nextCursor: signals.length > 0 ? { created_at: signals[signals.length - 1]!.created_at, id: signals[signals.length - 1]!.id } : null,
        capabilities: { cursorAfter: true, senderOwnerRelation: false, deliveryClaim: false, deliveryAck: false },
        legacyCursorFallback: false,
      };
    },
    emit: async (row) => { emitted.push(row); },
  });

  assert.deepEqual(
    emitted.map((r) => r.id),
    [EARLIER_MSG, AHEAD_ALERT],
    "ahead alert printed by reconciliation on page 1 must not print a second time when ordinary cursor catches up",
  );
  assert.equal(state.cursor?.id, AHEAD_ALERT, "ordinary cursor must still persist past the already-emitted alert");
});

test("runArrivalWatch retains reconciliation cursor across the 50-page per-cycle budget to reach page 51 and prunes only at end of feed", async () => {
  const controller = new AbortController();
  const emitted: SignalRecord[] = [];
  const totalRoutes = 51;
  const routes: SignalRecord[] = Array.from({ length: totalRoutes }, (_, index) => {
    const n = String(index + 1).padStart(12, "0");
    const ts = new Date(Date.parse("2026-11-19T16:00:00.000Z") + (index + 1) * 1_000).toISOString();
    return systemAlertToSignalRecord(
      {
        alert_id: `77777777-7777-4777-8777-${n}`,
        workspace_id: WS,
        channel_id: null,
        kind: "agent_quiet",
        affected_principal_id: AFFECTED,
        affected_seat_name: `quiet-seat-${index + 1}`,
        fix_hint: "Restart its listener.",
        waiting_count: 1,
        oldest_waiting_at: "2026-11-19T15:30:00.000Z",
        routed_lead_principal_id: LEAD,
        routed_at: ts,
        opened_at: ts,
        escalated_at: null,
      },
      LEAD,
    );
  });
  // Cursor is already past all 51 routes, so all 51 are behind-cursor reconciliation routes.
  let savedCursor: { created_at: string; id: string } | null = {
    created_at: "2026-11-19T16:59:00.000Z",
    id: NORMAL_SIG,
  };
  let idleCycles = 0;

  await runArrivalWatch({
    workspaceId: WS,
    principalId: LEAD,
    signal: controller.signal,
    pollMs: 1,
    pageLimit: 1,
    sleep: async (ms) => {
      if (ms > 0) {
        idleCycles += 1;
        if (idleCycles >= 3) controller.abort();
      }
    },
    store: {
      location: "memory://budget-resume-51-test",
      read: async () => savedCursor,
      write: async (next) => { savedCursor = next; },
    },
    readPage: async ({ alertAfter, limit }) => {
      const afterMs = alertAfter ? Date.parse(alertAfter.created_at) : -Infinity;
      const remaining = routes.filter(
        (r) => Date.parse(r.created_at) > afterMs || (Date.parse(r.created_at) === afterMs && r.id > (alertAfter?.id ?? "")),
      );
      return {
        signals: [],
        openSystemAlerts: remaining.slice(0, limit),
        ...(remaining.length > limit ? { openSystemAlertsHasMore: true } : {}),
        rawCount: 0,
        malformedRows: 0,
        pendingDeliveryCount: 0,
        nextCursor: null,
        capabilities: { cursorAfter: true, senderOwnerRelation: false, deliveryClaim: false, deliveryAck: false },
        legacyCursorFallback: false,
      };
    },
    emit: async (row) => { emitted.push(row); },
  });

  assert.equal(emitted.length, totalRoutes, "all 51 behind-cursor routes must emit exactly once across 3 cycles without repeating");
  assert.equal(new Set(emitted.map((r) => r.id)).size, totalRoutes, "all 51 unique route IDs including page 51 must be reached");
  assert.equal(emitted[totalRoutes - 1]!.id, routes[totalRoutes - 1]!.id, "route 51 must be delivered after resuming across the 50-page budget");
});

test("best-effort access_lost alert writes run post-tx with 250ms lock_timeout and deterministic workspace order", () => {
  const agentAuth = readFileSync(new URL("../supabase/functions/_shared/agent-auth.ts", import.meta.url), "utf8");
  const commandEdge = readFileSync(new URL("../supabase/functions/command/index.ts", import.meta.url), "utf8");
  const activityEdge = readFileSync(new URL("../supabase/functions/activity/index.ts", import.meta.url), "utf8");
  const mcpEdge = readFileSync(new URL("../supabase/functions/mcp/index.ts", import.meta.url), "utf8");

  assert.match(agentAuth, /BEST_EFFORT_ALERT_LOCK_TIMEOUT\s*=\s*"250ms"/);
  assert.match(agentAuth, /export async function recordBestEffortSystemAlert\(/);
  assert.match(agentAuth, /ORDER BY am\.workspace_id ASC/);

  // insertAudit must NOT call swarm.record_system_alert inline while holding outer command/users locks.
  const insertAuditStart = commandEdge.indexOf("async function insertAudit(");
  const insertAuditBody = commandEdge.slice(insertAuditStart, insertAuditStart + 2000);
  assert.doesNotMatch(insertAuditBody, /swarm\.record_system_alert/, "insertAudit must defer renewal-superseded alert post-transaction");
  assert.match(insertAuditBody, /pendingRenewalSupersededHooks\.get\(tx\)/);
  assert.match(commandEdge, /withBestEffortAlertTransaction/);
  assert.match(commandEdge, /recordBestEffortSystemAlert\(/);

  // activity/index.ts and mcp/index.ts must bound best-effort alert lock wait to 250ms.
  assert.match(activityEdge, /set_config\('lock_timeout',\s*'250ms',\s*true\)/);
  assert.match(mcpEdge, /set_config\('lock_timeout',\s*'250ms',\s*true\)/);
});
