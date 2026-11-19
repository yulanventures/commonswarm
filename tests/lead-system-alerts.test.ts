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

test("runArrivalWatch open-route reconciliation delivers an open routed alert even when cursor is past routed_at, without duplicates", async () => {
  const controller = new AbortController();
  const emitted: SignalRecord[] = [];
  let savedCursor: { created_at: string; id: string } | null = {
    created_at: "2026-11-19T16:10:00.000Z",
    id: NORMAL_SIG,
  };
  let cycles = 0;
  const skewedAlert = systemAlertToSignalRecord(
    {
      alert_id: ALERT,
      workspace_id: WS,
      channel_id: null,
      kind: "agent_quiet",
      affected_principal_id: AFFECTED,
      affected_seat_name: "quiet-seat",
      fix_hint: "Restart its listener.",
      waiting_count: 2,
      oldest_waiting_at: "2026-11-19T15:30:00.000Z",
      routed_lead_principal_id: LEAD,
      routed_at: "2026-11-19T16:05:00.000Z", // BEFORE savedCursor (16:10:00Z)!
      opened_at: "2026-11-19T15:45:00.000Z",
      escalated_at: null,
    },
    LEAD,
  );
  await runArrivalWatch({
    workspaceId: WS,
    principalId: LEAD,
    signal: controller.signal,
    pollMs: 1,
    sleep: async () => {
      cycles += 1;
      if (cycles >= 2) controller.abort();
    },
    store: {
      location: "memory://lead-system-alerts-test",
      read: async () => savedCursor,
      write: async (next) => { savedCursor = next; },
    },
    readPage: async () => ({
      signals: [],
      openSystemAlerts: [skewedAlert],
      rawCount: 0,
      malformedRows: 0,
      pendingDeliveryCount: 0,
      nextCursor: null,
      capabilities: { cursorAfter: true, senderOwnerRelation: false, deliveryClaim: false, deliveryAck: false },
      legacyCursorFallback: false,
    }),
    emit: async (row) => { emitted.push(row); },
  });
  assert.equal(emitted.length, 1, "open routed alert behind signal cursor must emit once and not duplicate on next cycle");
  assert.equal(emitted[0]!.id, ALERT);
  assert.deepEqual(emitted[0]!.system_alert, {
    alert_id: ALERT,
    kind: "agent_quiet",
    affected_principal_id: AFFECTED,
  });
});
