#!/usr/bin/env python3
"""Isolated catalog/migration gate. Synthetic dependencies only; no production data.
Runs the actual helper and fixed migration files in the pinned PostgreSQL image.
Not callable through run-db-tool.sh. Docker is required (absence is a failure).
"""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[3]
IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.147'
BASELINE = '''
CREATE SCHEMA swarm;
CREATE SCHEMA swarm_read;
CREATE SCHEMA auth;
CREATE SCHEMA cron;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid';
CREATE FUNCTION swarm.is_member(uuid,uuid) RETURNS boolean LANGUAGE sql AS 'SELECT false';
CREATE TABLE swarm.workspaces(workspace_id uuid PRIMARY KEY);
CREATE TABLE swarm.users(user_id uuid PRIMARY KEY);
CREATE TABLE swarm.devices(device_id uuid PRIMARY KEY,user_id uuid,label text,created_at timestamptz,revoked_at timestamptz,last_seen_at timestamptz);
CREATE TABLE swarm.agent_principals(principal_id uuid PRIMARY KEY,workspace_id uuid,owner_user_id uuid,name text,created_at timestamptz,revoked_at timestamptz,model text,managed_at timestamptz);
CREATE TABLE swarm.agent_runs(run_id uuid PRIMARY KEY,principal_id uuid,device_id uuid,started_at timestamptz,ended_at timestamptz,UNIQUE(run_id,principal_id));
CREATE TABLE swarm.agent_tokens(token_id uuid PRIMARY KEY,principal_id uuid,run_id uuid,first_used_at timestamptz,revoked_at timestamptz);
CREATE TABLE swarm.idempotency_keys(principal_kind text CONSTRAINT idempotency_keys_principal_kind_check CHECK(principal_kind IN ('user','agent')));
CREATE TABLE swarm.config(key text PRIMARY KEY,value jsonb NOT NULL);
ALTER TABLE swarm.config OWNER TO swarm_admin;
CREATE TABLE cron.job(jobid bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,jobname text UNIQUE,schedule text,command text,database text,username text,active boolean);
CREATE FUNCTION cron.schedule(text,text,text) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE result bigint;
BEGIN
  INSERT INTO cron.job(jobname,schedule,command,database,username,active)
  VALUES($1,$2,$3,current_database(),current_user,true)
  ON CONFLICT(jobname) DO UPDATE SET schedule=EXCLUDED.schedule,command=EXCLUDED.command,
    database=EXCLUDED.database,username=EXCLUDED.username,active=EXCLUDED.active
  RETURNING jobid INTO result;
  RETURN result;
END $$;
CREATE VIEW swarm_read.agent_principals WITH(security_barrier=true) AS SELECT * FROM swarm.agent_principals;
CREATE VIEW swarm_read.agent_runs WITH(security_barrier=true) AS SELECT * FROM swarm.agent_runs;
CREATE VIEW swarm_read.my_devices WITH(security_barrier=true) AS SELECT * FROM swarm.devices;
ALTER VIEW swarm_read.agent_principals OWNER TO swarm_admin;
ALTER VIEW swarm_read.agent_runs OWNER TO swarm_admin;
ALTER VIEW swarm_read.my_devices OWNER TO swarm_admin;
GRANT SELECT ON ALL TABLES IN SCHEMA swarm_read TO authenticated;
GRANT SELECT ON ALL TABLES IN SCHEMA swarm_read TO swarm_read;
'''

def main():
    name = 'h0-catalog-test-' + uuid.uuid4().hex[:10]
    passed = 0
    with tempfile.TemporaryDirectory(prefix='commonswarm-h0-test-') as temp:
        work = Path(temp)
        (work/'artifacts').mkdir(mode=0o700)
        # Synthetic local credential, never inherited from any service environment.
        env = dict(os.environ, PGPASSWORD='isolated-test-only')
        def run(args, data=None):
            return subprocess.run(args, input=data, text=True, capture_output=True, env=env, timeout=120)
        def check(result, label):
            if result.returncode:
                # All inputs are synthetic. Preserve diagnostics locally, never print rows.
                (work/'failure.log').write_text(result.stdout + result.stderr)
                raise AssertionError(label + ' failed: ' + result.stderr[-600:])
            return result.stdout.strip()
        try:
            check(run(['docker','run','-d','--name',name,'-e','POSTGRES_PASSWORD=isolated-test-only',
                       '-e','JWT_SECRET=synthetic-test-value-not-a-real-secret-1234567890','-e','JWT_EXP=3600',
                       '-v',str(ROOT)+':/repo:ro','-v',str(ROOT/'supabase/migrations')+':/migrations:ro',
                       '-v',str(work)+':/test',IMAGE]), 'start')
            def sql(statement, database='postgres'):
                return run(['docker','exec','-i','-e','PGPASSWORD',name,'psql','-X','-h','127.0.0.1',
                            '-U','supabase_admin','-d',database,'-v','ON_ERROR_STOP=1','-Atq'], statement)
            for _ in range(120):
                if sql('SELECT 1').returncode == 0: break
                time.sleep(.5)
            else: raise AssertionError('database readiness timeout')
            check(sql("CREATE ROLE swarm_admin; CREATE ROLE swarm_command; CREATE ROLE swarm_read;"), 'roles')
            check(sql('CREATE DATABASE h0_fixture'), 'database')
            check(sql("ALTER DATABASE h0_fixture SET commonswarm.stack_identity='n-db-target-v1'"), 'marker')
            service = '[target]\nhost=127.0.0.1\nport=5432\nuser=supabase_admin\ndbname=h0_fixture\noptions=-ccommonswarm.local_rehearsal=1 -ccommonswarm.local_target_address=127.0.0.1\n'
            (work/'service').write_text(service)
            def reset():
                check(sql('DROP SCHEMA IF EXISTS swarm_read CASCADE; DROP SCHEMA IF EXISTS swarm CASCADE; DROP SCHEMA IF EXISTS auth CASCADE; DROP SCHEMA IF EXISTS cron CASCADE;', 'h0_fixture'), 'reset')
                check(sql(BASELINE,'h0_fixture'), 'synthetic baseline')
            def helper(arg='target', script='/repo/deploy/supabase-stack/migrate/apply-h0-upgrade.sh'):
                return run(['docker','exec','-e','PGPASSWORD','-e','PGSERVICEFILE=/test/service',
                            '-e','TARGET_DATABASE_URL=synthetic-target-marker','-e','MIGRATION_ARTIFACT_DIR=/test/artifacts',
                            name,'bash',script,arg])
            def count():
                return check(sql("SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='swarm' AND c.relname IN ('agent_join_credentials','agent_join_attempts')",'h0_fixture'),'table count')
            def poll_count():
                return check(sql("SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='swarm' AND c.relname IN ('h0_poll_locks','h0_poll_batches')",'h0_fixture'),'poll table count')
            def rejected(label, result):
                nonlocal passed
                assert result.returncode != 0, label+' unexpectedly accepted'
                passed += 1; print('PASS '+label)
            reset()
            rejected('source argument before database', helper('source'))
            names = check(sql("SELECT schemaname||'.'||tablename FROM pg_tables WHERE schemaname IN ('auth','public','realtime','storage','supabase_migrations','swarm','swarm_read') ORDER BY schemaname,tablename", 'h0_fixture'), 'baseline table names').splitlines()
            baseline = ''.join(table+'|'+check(sql('SELECT count(*) FROM '+table,'h0_fixture'),'baseline count')+'\n' for table in names)
            (work/'artifacts/source-counts.tsv').write_text(baseline)
            (work/'artifacts/cron-jobs.ndjson').write_text('')
            check(helper(), 'apply'); assert count() == '2'; assert poll_count() == '2'; passed += 1; print('PASS absent apply and exact catalog')
            check(helper(script='/repo/deploy/supabase-stack/migrate/verify-post-upgrade-counts.sh'), 'real post counts')
            assert (work/'artifacts/source-counts.tsv').read_text() == baseline
            passed += 1; print('PASS real post-upgrade counts and immutable source TSV')
            before = check(sql("SELECT oid::text FROM pg_class WHERE oid='swarm.agent_join_credentials'::regclass",'h0_fixture'),'oid')
            check(helper(), 'skip')
            assert before == check(sql("SELECT oid::text FROM pg_class WHERE oid='swarm.agent_join_credentials'::regclass",'h0_fixture'),'oid unchanged')
            passed += 1; print('PASS present verify skip')
            # A live box already has the join pair and takes this branch.
            reset()
            check(sql('\\i /migrations/20260916000001_agent_join_credentials.sql\n\\i /migrations/20260916000002_agent_join_attempts.sql\n', 'h0_fixture'), 'join-only setup')
            assert count() == '2' and poll_count() == '0'
            check(helper(), 'join-present poll-absent apply')
            assert count() == '2' and poll_count() == '2'
            passed += 1; print('PASS join-present poll-absent apply and catalog')
            poll_mutations = {
                'poll column': 'ALTER TABLE swarm.h0_poll_locks DROP COLUMN waiting',
                'poll unique active index': 'DROP INDEX swarm.h0_poll_batches_one_active',
                'poll wrong active predicate': "DROP INDEX swarm.h0_poll_batches_one_active; CREATE UNIQUE INDEX h0_poll_batches_one_active ON swarm.h0_poll_batches (workspace_id, principal_id) WHERE status <> 'active'",
                'poll guard': 'ALTER TABLE swarm.h0_poll_batches DISABLE TRIGGER h0_poll_batches_guard',
                'poll wrong trigger function': "CREATE FUNCTION swarm.h0_wrong_guard() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END'; DROP TRIGGER h0_poll_batches_guard ON swarm.h0_poll_batches; CREATE TRIGGER h0_poll_batches_guard BEFORE UPDATE OR DELETE ON swarm.h0_poll_batches FOR EACH ROW EXECUTE FUNCTION swarm.h0_wrong_guard()",
                'poll guard body': "CREATE OR REPLACE FUNCTION swarm.h0_poll_batches_guard() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END'",
                'poll grant': 'REVOKE UPDATE ON swarm.h0_poll_locks FROM swarm_command',
                'poll truncate grant': 'GRANT TRUNCATE ON swarm.h0_poll_locks TO swarm_command',
                'poll purge search path': 'ALTER FUNCTION swarm.purge_expired_h0_poll_batches() RESET search_path',
                'poll purge': 'DROP FUNCTION swarm.purge_expired_h0_poll_batches() CASCADE',
                'poll cron': "DELETE FROM cron.job WHERE jobname='swarm-purge-h0-poll-batches'",
            }
            for label, statement in poll_mutations.items():
                reset(); check(helper(), 'setup '+label)
                check(sql(statement, 'h0_fixture'), 'mutate '+label)
                rejected(label, helper())
            # Release procedure section 5: each standalone proof must change
            # from f to t on its own migration, without later H0 objects.
            reset()
            check(sql('\\i /migrations/20260916000001_agent_join_credentials.sql\n'
                      '\\i /migrations/20260916000002_agent_join_attempts.sql\n', 'h0_fixture'), 'proof join setup')
            proof_dir = '/repo/deploy/release-proofs/h0'
            def catalog(version):
                statement = f'\\i {proof_dir}/{version}-catalog.sql\n\\echo :catalog_ok\n'
                return check(sql(statement, 'h0_fixture'), 'catalog proof '+version).splitlines()[-1]
            for version, migration in (
                ('20260922000001', '20260922000001_h0_poll_lock_and_batch.sql'),
                ('20260922000002', '20260922000002_h0_poll_wait_admission.sql'),
                ('20260922000003', '20260922000003_h0_poll_batch_retention.sql'),
            ):
                assert catalog(version) == 'f', version+' absent proof was true'
                check(sql('\\i /migrations/'+migration+'\n', 'h0_fixture'), 'apply '+version)
                assert catalog(version) == 't', version+' applied proof was false'
                check(sql('\\i '+proof_dir+'/'+version+'-functional.sql\n', 'h0_fixture'),
                      'functional proof '+version)
                passed += 1; print('PASS release proofs '+version)
            check(sql('DROP INDEX swarm.h0_poll_batches_one_active', 'h0_fixture'), 'partial proof mutation')
            assert catalog('20260922000001') == 'f', 'partial 000001 proof was true'
            passed += 1; print('PASS partial release proof refused')
            # Both verification and apply branches must reject a wrong target marker.
            check(sql("ALTER DATABASE h0_fixture SET commonswarm.stack_identity='wrong-target'"), 'wrong identity')
            rejected('present branch target identity', helper())
            check(sql("ALTER DATABASE h0_fixture SET commonswarm.stack_identity='n-db-target-v1'"), 'restore identity')
            reset(); check(sql('CREATE TABLE swarm.agent_join_credentials(id uuid)', 'h0_fixture'),'partial')
            rejected('partial catalog', helper()); assert count() == '1'
            reset(); check(sql("CREATE FUNCTION swarm.agent_join_credentials_guard() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END'", 'h0_fixture'), 'orphan guard')
            rejected('orphan guard without tables', helper()); assert count() == '0'
            for label, statement in (
                ('orphan retention function', "CREATE FUNCTION swarm.h0_poll_batch_retention_days() RETURNS integer LANGUAGE sql AS 'SELECT 2'"),
                ('orphan purge function', "CREATE FUNCTION swarm.purge_expired_h0_poll_batches() RETURNS integer LANGUAGE sql AS 'SELECT 0'"),
                ('orphan purge cron', "INSERT INTO cron.job(jobname,schedule,command,database,username,active) VALUES ('swarm-purge-h0-poll-batches','29 4 * * *','SELECT 1',current_database(),current_user,true)"),
            ):
                reset(); check(sql(statement,'h0_fixture'),'setup '+label)
                rejected(label, helper())
            mutations = {
                'column nullability': 'ALTER TABLE swarm.agent_join_credentials ALTER COLUMN locator DROP NOT NULL',
                'constraint': 'ALTER TABLE swarm.agent_join_credentials DROP CONSTRAINT agent_join_credentials_seat_cap_check',
                'index': 'DROP INDEX swarm.agent_join_credentials_live_by_workspace',
                'trigger': 'ALTER TABLE swarm.agent_join_attempts DISABLE TRIGGER agent_join_attempts_guard',
                'RLS': 'ALTER TABLE swarm.agent_join_credentials DISABLE ROW LEVEL SECURITY',
                'ACL': 'GRANT SELECT ON swarm.agent_join_attempts TO anon',
                'guard body': "CREATE OR REPLACE FUNCTION swarm.agent_join_attempts_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS 'BEGIN RETURN NEW; END'",
                'view predicate': 'CREATE OR REPLACE VIEW swarm_read.agent_runs WITH(security_barrier=true) AS SELECT * FROM swarm.agent_runs',
                'dependency index': 'DROP INDEX swarm.agent_tokens_token_principal_run CASCADE',
                'idempotency constraint': "ALTER TABLE swarm.idempotency_keys DROP CONSTRAINT idempotency_keys_principal_kind_check",
            }
            for label, statement in mutations.items():
                reset(); check(helper(),'setup '+label); check(sql(statement,'h0_fixture'),'mutate '+label)
                rejected(label, helper())
            # Force post-apply catalog failure: both migrations must roll back.
            reset(); shutil.copytree(ROOT/'deploy/supabase-stack/migrate',work/'mutated')
            (work/'mutated/verify-h0-catalog.sql').write_text("DO $$ BEGIN RAISE EXCEPTION 'synthetic verifier failure'; END $$;\n")
            rejected('post-apply failure atomic rollback',helper(script='/test/mutated/apply-h0-upgrade.sh'))
            assert count() == '0'
            assert poll_count() == '0'
            print(f'PASSED {passed} real PostgreSQL H0 gates')
        finally:
            run(['docker','rm','-f',name])

if __name__ == '__main__': main()
