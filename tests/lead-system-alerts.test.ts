/**
 * Unit and contract checks for lead system alerts (CS fcb99658):
 * command parser, migration grants/RLS invariants, rollback coverage, and no ops email bridge.
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

const ALERT = "11111111-2222-4333-8444-555555555555";

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
});

test("migration enforces FORCE RLS, pinned producers, owner-only escalation and clean rollback", () => {
  const migration = readFileSync("supabase/migrations/20261119000001_lead_system_alerts.sql", "utf8");
  const rollback = readFileSync("deploy/release-proofs/lead-system-alerts/20261119000001-rollback.sql", "utf8");
  const commandEdge = readFileSync("supabase/functions/command/index.ts", "utf8");

  assert.equal(HUMAN_ONLY_COMMANDS.has(RESOLVE_SYSTEM_ALERT_KIND as never), false);
  assert.match(commandEdge, /RESOLVE_SYSTEM_ALERT_KIND/);

  for (const kind of SYSTEM_ALERT_KINDS) {
    assert.match(migration, new RegExp(`'${kind}'`));
  }

  assert.match(migration, /ALTER TABLE swarm\.system_alerts ENABLE ROW LEVEL SECURITY;/);
  assert.match(migration, /ALTER TABLE swarm\.system_alerts FORCE ROW LEVEL SECURITY;/);
  assert.match(
    migration,
    /REVOKE ALL ON TABLE swarm\.system_alerts\s+FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;/,
  );
  // sync_quiet_agent_alerts and escalate_due_system_alerts stay swarm_admin-only (not granted to swarm_command).
  assert.doesNotMatch(migration, /GRANT EXECUTE[\s\S]*sync_quiet_agent_alerts[\s\S]*TO swarm_command/);
  assert.doesNotMatch(migration, /GRANT EXECUTE[\s\S]*escalate_due_system_alerts[\s\S]*TO swarm_command/);
  // Owner alert inbox requires role='owner' and rejects agent claims.
  assert.match(migration, /v_claims \? 'agent_principal_id'/);
  assert.match(migration, /m\.role = 'owner'/);
  // No email bridge in the migration or edge handler.
  assert.doesNotMatch(migration, /smtp|alerts\.jsonl|quiet-agents\.sql/i);

  // Rollback drops table, view, triggers and functions.
  assert.match(rollback, /DROP FUNCTION IF EXISTS swarm_read\.owner_alert_inbox\(uuid\);/);
  assert.match(rollback, /DROP VIEW IF EXISTS swarm_read\.system_alerts;/);
  assert.match(rollback, /DROP TABLE IF EXISTS swarm\.system_alerts;/);
});
