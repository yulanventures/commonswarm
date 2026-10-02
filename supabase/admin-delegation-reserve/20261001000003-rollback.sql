-- Complete inverse for 20261001000003_admin_recovery_read.sql.
-- Reserve only; run under an approved procedure or rollback transaction.
DROP FUNCTION IF EXISTS swarm_read.admin_recovery_page(text, uuid, integer, text);
