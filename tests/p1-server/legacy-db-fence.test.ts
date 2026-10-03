/** legacy-db-fence: mechanism exercised only in a rollback transaction, never live. */
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { dbAssert, fixture, refuses, repoSql, runSql, versions } from '../support/admin-schema-db.js';

test('legacy-db-fence: migration leaves legacy usable and issuance closed; release-only fence defeats old roles/definers and preserves human recovery', () => {
  const f = fixture(1), credential = randomUUID(), lineage = randomUUID();
  runSql(`${f.sql}
${dbAssert('SELECT NOT admin_issuance_enabled AND NOT legacy_closed FROM commonswarm_oauth.admin_cutover_state', 'dormant migration state')}
SET LOCAL ROLE swarm_command;
INSERT INTO swarm.admin_credentials(credential_id,grant_id,credential_lineage_id,generation,access_hash,refresh_hash,
  access_expires_at,refresh_deadline,scope_names)
VALUES('${credential}','${f.grant}','${lineage}',0,decode(repeat('11',32),'hex'),decode(repeat('22',32),'hex'),
  statement_timestamp()+interval '5 minutes',statement_timestamp()+interval '1 day',ARRAY['admin:read']);
${dbAssert(`SELECT count(*)=1 FROM swarm.admin_credentials WHERE credential_id='${credential}'`, 'old runtime positive before fence')}
${refuses(`SELECT commonswarm_oauth.apply_legacy_admin_fence('unauthorized')`, '42501')}
RESET ROLE;
-- Model an old imported wrapper running as the table-owner definer. FORCE RLS
-- must fence this path too, not merely revoke swarm_command direct access.
CREATE FUNCTION swarm.schema_test_old_opaque_count() RETURNS bigint LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog
  AS $old$ SELECT count(*) FROM swarm.admin_credentials WHERE credential_id='${credential}' $old$;
ALTER FUNCTION swarm.schema_test_old_opaque_count() OWNER TO swarm_admin;
${dbAssert('SELECT swarm.schema_test_old_opaque_count()=1', 'old definer positive before closure')}
CREATE FUNCTION swarm.schema_test_old_opaque_insert() RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $old$
  INSERT INTO swarm.admin_credentials(credential_id,grant_id,credential_lineage_id,generation,access_hash,refresh_hash,
    access_expires_at,refresh_deadline,scope_names)
  VALUES(gen_random_uuid(),'${f.grant}','${lineage}',1,decode(repeat('33',32),'hex'),decode(repeat('44',32),'hex'),
    statement_timestamp()+interval '5 minutes',statement_timestamp()+interval '1 day',ARRAY['admin:read']) $old$;
ALTER FUNCTION swarm.schema_test_old_opaque_insert() OWNER TO swarm_admin;
-- Pair the post-cutover imported-mint refusal with this same wrapper's success.
SAVEPOINT old_insert_control;
SELECT swarm.schema_test_old_opaque_insert();
ROLLBACK TO SAVEPOINT old_insert_control;
SET LOCAL ROLE commonswarm_admin_release;
${refuses(`UPDATE commonswarm_oauth.admin_cutover_state SET admin_issuance_enabled=true`, '23514')}
${refuses(`UPDATE commonswarm_oauth.admin_cutover_state SET legacy_closed=true,legacy_closed_at=statement_timestamp()`, '23514')}
SELECT commonswarm_oauth.apply_legacy_admin_fence('reviewed-test-inventory');
RESET ROLE;
${dbAssert('SELECT legacy_closed AND NOT admin_issuance_enabled AND measured_at IS NULL FROM commonswarm_oauth.admin_cutover_state', 'fence cannot attest or enable issuance')}
${dbAssert('SELECT swarm.schema_test_old_opaque_count()=0', 'old table-owner definer fenced')}
${refuses('SELECT swarm.schema_test_old_opaque_insert()', '42501')}
SET LOCAL ROLE swarm_command;
${refuses(`SELECT * FROM swarm.admin_credentials WHERE credential_id='${credential}'`, '42501')}
${refuses(`UPDATE swarm.admin_credentials SET generation=1 WHERE credential_id='${credential}'`, '42501')}
${refuses(`INSERT INTO swarm.admin_credentials SELECT * FROM swarm.admin_credentials WHERE credential_id='${credential}'`, '42501')}
${refuses(`UPDATE swarm.admin_grants SET state='active',revoked_at=NULL WHERE grant_id='${f.grant}'`, '42501')}
${dbAssert(`SELECT count(*)=1 FROM swarm.admin_grants WHERE grant_id='${f.grant}' AND state='revoked'`, 'human grant history retained')}
UPDATE swarm.admin_grants SET reason_code='human_recovery_revoke' WHERE grant_id='${f.grant}';
RESET ROLE;
${dbAssert(`SELECT count(*)=1 FROM swarm.admin_credentials WHERE credential_id='${credential}' AND revoked_at IS NOT NULL`, 'historical opaque row retained for privileged audit')}
SET LOCAL ROLE swarm_read;
SELECT set_config('request.jwt.claims','{"sub":"${f.owner}"}',true);
${dbAssert(`SELECT jsonb_array_length(swarm_read.admin_recovery_page('admin_grants',NULL,50,NULL)->'grants')=1`, 'human recovery survives closure')}
SELECT set_config('request.jwt.claims','{"sub":"${f.foreign}"}',true);
${dbAssert(`SELECT jsonb_array_length(swarm_read.admin_recovery_page('admin_grants',NULL,50,NULL)->'grants')=0`, 'foreign human recovery denied')}
RESET ROLE;
SET LOCAL ROLE commonswarm_admin_release;
${refuses(`UPDATE commonswarm_oauth.admin_cutover_state SET legacy_closed=false,legacy_closed_at=NULL`, '55000')}
RESET ROLE;
${versions.map(v => refuses(repoSql(`supabase/admin-delegation-reserve/${v}-rollback.sql`), '55000')).join('\n')}
DROP FUNCTION swarm.schema_test_old_opaque_count();
DROP FUNCTION swarm.schema_test_old_opaque_insert();
`);
});
