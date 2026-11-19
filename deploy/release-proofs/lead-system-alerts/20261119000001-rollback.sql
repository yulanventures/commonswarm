-- Rollback for 20261119000001_lead_system_alerts.sql.
-- Drops all lead system alert views, triggers, functions and table cleanly.
SET search_path = swarm, pg_catalog, public;

DROP FUNCTION IF EXISTS swarm_read.owner_alert_inbox(uuid);
DROP VIEW IF EXISTS swarm_read.system_alerts;

DROP TRIGGER IF EXISTS system_alerts_notify_reroute ON swarm.system_alerts;
DROP TRIGGER IF EXISTS system_alerts_notify_escalate ON swarm.system_alerts;
DROP TRIGGER IF EXISTS system_alerts_notify_insert ON swarm.system_alerts;
DROP FUNCTION IF EXISTS swarm.notify_system_alert_reroute();
DROP FUNCTION IF EXISTS swarm.notify_system_alert_escalate();
DROP FUNCTION IF EXISTS swarm.notify_system_alert_insert();

DROP FUNCTION IF EXISTS swarm.system_alert_audit_channel_id(uuid, uuid);
DROP FUNCTION IF EXISTS swarm.resolve_system_alert(uuid, uuid, text, uuid, uuid, text);
DROP FUNCTION IF EXISTS swarm.sync_quiet_agent_alerts(interval);
DROP FUNCTION IF EXISTS swarm.escalate_due_system_alerts();
DROP FUNCTION IF EXISTS swarm.record_hosted_seat_refused_alerts(text, uuid);
DROP FUNCTION IF EXISTS swarm.record_system_alert(uuid, text, uuid, uuid, integer, timestamptz, interval);
DROP FUNCTION IF EXISTS swarm.system_alert_claims_can_read(uuid, uuid, uuid);
DROP FUNCTION IF EXISTS swarm.system_alert_agent_is_current_lead(uuid, uuid, uuid, uuid);
DROP FUNCTION IF EXISTS swarm.system_alert_pick_lead(uuid, uuid, uuid);
DROP FUNCTION IF EXISTS swarm.system_alert_candidate_is_eligible(uuid, uuid, uuid, uuid, boolean);
DROP FUNCTION IF EXISTS swarm.system_alert_fix_hint(text);

DROP TABLE IF EXISTS swarm.system_alerts;

RESET search_path;
