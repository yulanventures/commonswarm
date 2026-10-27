-- Focused psql fixture for the tiny, isolated source-extracted schema.
-- Synthetic prerequisites: workspace 1/member 11, workspace 2/member 22,
-- file 31 version 1 in workspace 1; legacy signal 100 committed before migration.
-- Original guards, FKs, policies and roles are extracted unchanged from source.
-- Run after 20261022000992; no pg_cron, full stack or migrations replay needed.
-- Primary owner-boundary regression: addressed signal + attachment after SAVEPOINT.
-- Pre-fix failure: require_new_signal_for_recipient(), SQLSTATE 55000.
\set ON_ERROR_STOP on
CREATE FUNCTION pg_temp.assert_denied(label text, statement text, expected text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE actual text;
BEGIN
  BEGIN
    EXECUTE statement;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS actual = RETURNED_SQLSTATE;
  END;
  IF actual IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'case % expected % got %', label, expected, actual;
  END IF;
  RAISE NOTICE 'PASS % (%)', label, actual;
END;
$$;
CREATE FUNCTION pg_temp.make_signal(n integer)
RETURNS void LANGUAGE sql AS $$
 INSERT INTO swarm.signals(id,workspace_id,from_principal,from_kind,to_user_id,kind,body,until)
 VALUES (('00000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,
 '00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000011',
 'agent','00000000-0000-0000-0000-000000000011','note','synthetic',now()+interval '1 hour');
$$;
CREATE FUNCTION pg_temp.add_children(n integer)
RETURNS void LANGUAGE sql AS $$
 INSERT INTO swarm.signal_recipients(signal_id,workspace_id,recipient_user_id,position)
 VALUES (('00000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,
 '00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000011',0);
 INSERT INTO swarm.signal_attachments(signal_id,workspace_id,file_id,version_n,position)
 VALUES (('00000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,
 '00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000031',1,0);
$$;
BEGIN;
SET LOCAL ROLE swarm_command;
SELECT pg_temp.make_signal(101);
SELECT pg_temp.add_children(101);
COMMIT;
SELECT 'PASS new outside savepoint';
BEGIN;
SET LOCAL ROLE swarm_command;
SELECT pg_current_xact_id();
SAVEPOINT business;
SELECT pg_temp.make_signal(102);
SELECT pg_temp.add_children(102);
RELEASE SAVEPOINT business;
COMMIT;
SELECT 'PASS new inside savepoint';
BEGIN;
SET LOCAL ROLE swarm_command;
SELECT pg_current_xact_id();
SAVEPOINT business;
SAVEPOINT nested_business;
SELECT pg_temp.make_signal(103);
RELEASE SAVEPOINT nested_business;
RELEASE SAVEPOINT business;
SELECT pg_temp.add_children(103);
COMMIT;
SELECT 'PASS released nested savepoint';
BEGIN;
SET LOCAL ROLE swarm_command;
SAVEPOINT business;
SELECT pg_temp.make_signal(104);
SELECT pg_temp.add_children(104);
ROLLBACK TO SAVEPOINT business;
DO $$ BEGIN
 IF EXISTS(SELECT FROM swarm.signals WHERE id='00000000-0000-0000-0000-000000000104')
 OR EXISTS(SELECT FROM swarm.signal_recipients WHERE signal_id='00000000-0000-0000-0000-000000000104')
 OR EXISTS(SELECT FROM swarm.signal_attachments WHERE signal_id='00000000-0000-0000-0000-000000000104')
 THEN RAISE EXCEPTION 'rollback left signal or children'; END IF;
END $$;
SELECT pg_temp.make_signal(104);
SELECT pg_temp.add_children(104);
COMMIT;
SELECT 'PASS rollback removes signal, stamp and children';
-- The parent is fresh in this transaction: the workspace predicate, rather
-- than a committed-parent rejection, must refuse each foreign child.
BEGIN;
SET LOCAL ROLE swarm_command;
SELECT pg_temp.make_signal(108);
SELECT pg_temp.assert_denied('foreign workspace recipient', $q$INSERT INTO swarm.signal_recipients VALUES ('00000000-0000-0000-0000-000000000108','00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000022',NULL,0,DEFAULT)$q$, '55000');
SELECT pg_temp.assert_denied('foreign workspace attachment', $q$INSERT INTO swarm.signal_attachments VALUES ('00000000-0000-0000-0000-000000000108','00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000031',1,0,DEFAULT)$q$, '55000');
SELECT pg_temp.add_children(108);
ROLLBACK;
SELECT 'PASS fresh parent accepts own workspace children';
SET ROLE swarm_command;
SELECT pg_temp.assert_denied('committed recipients', $q$INSERT INTO swarm.signal_recipients VALUES ('00000000-0000-0000-0000-000000000101','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000011',NULL,1,DEFAULT)$q$, '55000');
SELECT pg_temp.assert_denied('committed attachments', $q$INSERT INTO swarm.signal_attachments VALUES ('00000000-0000-0000-0000-000000000101','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000031',1,1,DEFAULT)$q$, '55000');
SELECT pg_temp.assert_denied('command cannot update stamp', $q$UPDATE swarm.signals SET creation_xact_id=pg_current_xact_id() WHERE id='00000000-0000-0000-0000-000000000101'$q$, '42501');
SELECT pg_temp.assert_denied('legacy recipients remain closed',
$q$INSERT INTO swarm.signal_recipients VALUES ('00000000-0000-0000-0000-000000000100','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000011',NULL,0,DEFAULT)$q$,'55000');
SELECT pg_temp.assert_denied('legacy attachments remain closed',
$q$INSERT INTO swarm.signal_attachments VALUES ('00000000-0000-0000-0000-000000000100','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000031',1,0,DEFAULT)$q$,'55000');
RESET ROLE;
BEGIN;
SET LOCAL ROLE swarm_command;
SELECT pg_temp.make_signal(105);
SELECT pg_temp.assert_denied('foreign destination',
 $q$INSERT INTO swarm.signal_recipients VALUES ('00000000-0000-0000-0000-000000000105','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000022',NULL,0,DEFAULT)$q$,'23503');
SELECT pg_temp.add_children(105);
COMMIT;
BEGIN;
SET LOCAL ROLE swarm_command;
INSERT INTO swarm.signals(id,workspace_id,from_principal,from_kind,kind,body,until,creation_xact_id,creation_system_identifier)
VALUES ('00000000-0000-0000-0000-000000000106','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000011','agent','note','synthetic',now()+interval '1 hour','1'::xid8,1);
DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM swarm.signals WHERE id='00000000-0000-0000-0000-000000000106' AND creation_xact_id=pg_current_xact_id()
 AND creation_system_identifier=(SELECT system_identifier FROM pg_catalog.pg_control_system()))
 THEN RAISE EXCEPTION 'caller forged creation stamp'; END IF;
END $$;
COMMIT;
SELECT 'PASS caller-chosen stamp overwritten';
SET ROLE swarm_admin;
SELECT pg_temp.assert_denied('owner cannot restamp',
 $q$UPDATE swarm.signals SET creation_xact_id=pg_current_xact_id() WHERE id='00000000-0000-0000-0000-000000000101'$q$,'55000');
RESET ROLE;
SET ROLE swarm_command;
INSERT INTO swarm.signal_human_receipts(workspace_id,signal_id,user_id) VALUES
('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000101','00000000-0000-0000-0000-000000000011');
SELECT pg_temp.assert_denied('receipt foreign member',
 $q$INSERT INTO swarm.signal_human_receipts(workspace_id,signal_id,user_id) VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000102','00000000-0000-0000-0000-000000000022')$q$,'42501');
RESET ROLE;
UPDATE swarm.memberships SET revoked_at=now() WHERE user_id='00000000-0000-0000-0000-000000000011';
SET ROLE swarm_command;
SELECT pg_temp.assert_denied('receipt revoked member',
 $q$INSERT INTO swarm.signal_human_receipts(workspace_id,signal_id,user_id) VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000102','00000000-0000-0000-0000-000000000011')$q$,'42501');
RESET ROLE;
SET ROLE anon;
SELECT pg_temp.assert_denied('anon cannot insert', 'SELECT pg_temp.make_signal(107)', '42501');
RESET ROLE;
SET ROLE authenticated;
SELECT pg_temp.assert_denied('authenticated cannot insert', 'SELECT pg_temp.make_signal(107)', '42501');
RESET ROLE;
SET ROLE swarm_read;
SELECT pg_temp.assert_denied('swarm_read cannot insert', 'SELECT pg_temp.make_signal(107)', '42501');
RESET ROLE;
-- Trusted synthetic replica/restore only: copy a committed origin pair while
-- the target cluster's next transaction counter deliberately matches the stamp.
-- restore_system_identifier is supplied by the isolated driver's separate initdb.
BEGIN;
SET LOCAL session_replication_role = replica;
INSERT INTO swarm.signals(id,workspace_id,from_principal,from_kind,to_user_id,kind,body,until,creation_xact_id,creation_system_identifier)
VALUES ('00000000-0000-0000-0000-000000000190','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000011','agent','00000000-0000-0000-0000-000000000011','note','synthetic import',now()+interval '1 hour',((pg_current_xact_id()::text::bigint+1)::text)::xid8, :restore_system_identifier);
COMMIT;
BEGIN;
SET LOCAL ROLE swarm_command;
DO $$ BEGIN
 IF NOT EXISTS(SELECT FROM swarm.signals
  WHERE id='00000000-0000-0000-0000-000000000190'
  AND creation_xact_id=pg_current_xact_id()
  AND creation_system_identifier<>(SELECT system_identifier FROM pg_catalog.pg_control_system()))
 THEN RAISE EXCEPTION 'restore counter/lineage precondition not reached'; END IF;
END $$;
SELECT pg_temp.assert_denied('imported matching stamp recipients', $q$INSERT INTO swarm.signal_recipients VALUES ('00000000-0000-0000-0000-000000000190','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000011',NULL,0,DEFAULT)$q$, '55000');
SELECT pg_temp.assert_denied('imported matching stamp attachments', $q$INSERT INTO swarm.signal_attachments VALUES ('00000000-0000-0000-0000-000000000190','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000031',1,0,DEFAULT)$q$, '55000');
SELECT pg_temp.make_signal(191);
SELECT pg_temp.add_children(191);
SELECT json_build_object('current_xid',pg_current_xact_id(),'copied_stamp',creation_xact_id,'tuple_xmin',xmin,'origin_system_identifier',creation_system_identifier,'current_system_identifier',(SELECT system_identifier FROM pg_catalog.pg_control_system())) FROM swarm.signals WHERE id='00000000-0000-0000-0000-000000000190';
ROLLBACK;
SELECT 'PASS imported counter collision denied alongside fresh parent control';
