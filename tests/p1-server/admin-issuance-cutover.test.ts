/** Ledger admission at the real database boundary; Docker/CI only. */
import { test } from 'node:test';
import { catalog, checksumVersions, dbAssert, enableIssuanceForTest, expectedMigrationHashes, fixture, issuance, measureIssuanceForTest, openIssuanceForTest, prepareIssuanceForTest, refuses, repoSql, runSql } from '../support/admin-schema-db.js';

test('admin-issuance-closed-before-cutover: runtime audit/access inserts and admission require both flags', () => {
  const f = fixture(), token = issuance(f), rotated = issuance(f, 1);
  // Only the rolled-back fixture may represent this otherwise impossible state.
  const enableWithoutClosure = `
ALTER TABLE commonswarm_oauth.admin_cutover_state DISABLE TRIGGER admin_cutover_guard;
DO $test$ DECLARE c record; BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='commonswarm_oauth.admin_cutover_state'::regclass AND contype='c' LOOP
    EXECUTE format('ALTER TABLE commonswarm_oauth.admin_cutover_state DROP CONSTRAINT %I',c.conname);
  END LOOP;
END $test$;
UPDATE commonswarm_oauth.admin_cutover_state SET admin_issuance_enabled=true,legacy_closed=false,legacy_closed_at=NULL;
`;
  runSql(`${f.sql}
${dbAssert('SELECT NOT admin_issuance_enabled AND NOT legacy_closed FROM commonswarm_oauth.admin_cutover_state', 'initial gate closed')}
SET LOCAL ROLE swarm_command;
${token.eventInsert}
RESET ROLE;
SET LOCAL ROLE commonswarm_oauth_runtime;
${dbAssert(`SELECT active FROM commonswarm_oauth.resolve_admin_grant_status('${f.provider}','${f.owner}','test-kid')`, 'family otherwise eligible')}
${refuses(token.auditInsert, '23514')}
${refuses(token.accessInsert, '23514')}
${refuses(rotated.auditInsert, '23514')}
RESET ROLE;
${openIssuanceForTest}
SET LOCAL ROLE commonswarm_oauth_runtime;
${token.auditInsert}
SAVEPOINT empty_access_ledger;
${token.accessInsert}
${dbAssert(token.active(), 'both flags true admits committed issuance')}
RESET ROLE;
SET LOCAL ROLE commonswarm_admin_release;
UPDATE commonswarm_oauth.admin_cutover_state SET admin_issuance_enabled=false;
RESET ROLE;
SET LOCAL ROLE commonswarm_oauth_runtime;
${dbAssert(`NOT (${token.active()})`, 'closing flag refuses previously recorded access')}
${refuses(rotated.auditInsert, '23514')}
-- An existing valid audit/event cannot bypass the access insert guard while closed.
ROLLBACK TO SAVEPOINT empty_access_ledger;
RESET ROLE;
SET LOCAL ROLE commonswarm_admin_release;
UPDATE commonswarm_oauth.admin_cutover_state SET admin_issuance_enabled=false;
RESET ROLE;
SET LOCAL ROLE commonswarm_oauth_runtime;
${refuses(token.accessInsert, '23514')}
ROLLBACK TO SAVEPOINT empty_access_ledger;
${token.accessInsert}
RESET ROLE;
-- Prove legacy_closed independently: mutate only the flags/closure fields in this
-- rollback-only fixture, bypassing the cutover CHECK, never the admission guards.
${enableWithoutClosure}
SET LOCAL ROLE commonswarm_oauth_runtime;
${dbAssert(`NOT (${token.active()})`, 'enabled flag alone cannot admit recorded access')}
${refuses(rotated.auditInsert, '23514')}
RESET ROLE;
ROLLBACK TO SAVEPOINT empty_access_ledger;
RESET ROLE;
${enableWithoutClosure}
SET LOCAL ROLE commonswarm_oauth_runtime;
${refuses(token.accessInsert, '23514')}
RESET ROLE;
`);
});

test('admin-activation-migration-ledger: enablement requires installed gate and full independently recorded checksum evidence', () => {
  runSql(`${prepareIssuanceForTest}
${dbAssert('SELECT NOT admin_issuance_enabled AND legacy_closed FROM commonswarm_oauth.admin_cutover_state', 'otherwise eligible measured closure stays closed')}
${checksumVersions.map(v => `
SAVEPOINT activation_evidence;
SET LOCAL ROLE swarm_admin;
DELETE FROM commonswarm_ops.migration_checksums WHERE version='${v}';
RESET ROLE;
SET LOCAL ROLE commonswarm_admin_release;
${refuses('UPDATE commonswarm_oauth.admin_cutover_state SET admin_issuance_enabled=true','23514')}
RESET ROLE;
${dbAssert(`SELECT count(*)=1 FROM supabase_migrations.schema_migrations WHERE version='${v}'`, `${v} ledger-only probe retains ledger`)}
ROLLBACK TO SAVEPOINT activation_evidence;
DELETE FROM supabase_migrations.schema_migrations WHERE version='${v}';
SET LOCAL ROLE commonswarm_admin_release;
${refuses('UPDATE commonswarm_oauth.admin_cutover_state SET admin_issuance_enabled=true','23514')}
RESET ROLE;
${dbAssert(`SELECT count(*)=1 FROM commonswarm_ops.migration_checksums WHERE version='${v}'`, `${v} checksum-only probe retains checksum`)}
ROLLBACK TO SAVEPOINT activation_evidence;
SET LOCAL ROLE swarm_admin;
UPDATE commonswarm_ops.migration_checksums SET sha256=repeat('0',64) WHERE version='${v}';
RESET ROLE;
SET LOCAL ROLE commonswarm_admin_release;
${refuses('UPDATE commonswarm_oauth.admin_cutover_state SET admin_issuance_enabled=true','23514')}
RESET ROLE;
ROLLBACK TO SAVEPOINT activation_evidence;
RELEASE SAVEPOINT activation_evidence;`).join('\n')}
SAVEPOINT missing_expectations;
SET LOCAL ROLE commonswarm_admin_release;
UPDATE commonswarm_oauth.admin_cutover_state SET required_migrations='{}'::jsonb;
${refuses('UPDATE commonswarm_oauth.admin_cutover_state SET admin_issuance_enabled=true','23514')}
-- The previously accepted M1-M3-only subset cannot authorize activation.
UPDATE commonswarm_oauth.admin_cutover_state SET required_migrations=(
 SELECT jsonb_object_agg(key,value) FROM jsonb_each('${expectedMigrationHashes}'::jsonb)
 WHERE key IN ('20261003000001','20261003000002','20261003000003'));
${refuses('UPDATE commonswarm_oauth.admin_cutover_state SET admin_issuance_enabled=true','23514')}
RESET ROLE;
ROLLBACK TO SAVEPOINT missing_expectations;
SAVEPOINT missing_gate;
DROP FUNCTION commonswarm_ops.migration_checksum_failures();
SET LOCAL ROLE commonswarm_admin_release;
${refuses('UPDATE commonswarm_oauth.admin_cutover_state SET admin_issuance_enabled=true','23514')}
RESET ROLE;
ROLLBACK TO SAVEPOINT missing_gate;
${enableIssuanceForTest}
${dbAssert('SELECT admin_issuance_enabled FROM commonswarm_oauth.admin_cutover_state', 'complete ledger and reviewed digests enable only rollback fixture')}
-- Check OLD-vs-NEW visibility: expectations cannot be swapped in an enablement update.
SET LOCAL ROLE commonswarm_admin_release;
${refuses("UPDATE commonswarm_oauth.admin_cutover_state SET required_migrations=jsonb_set(required_migrations,'{20261003000001}',to_jsonb(repeat('0',64)))",'23514')}
UPDATE commonswarm_oauth.admin_cutover_state SET admin_issuance_enabled=false;
${refuses("UPDATE commonswarm_oauth.admin_cutover_state SET admin_issuance_enabled=true,required_migrations=jsonb_set(required_migrations,'{20261003000001}',to_jsonb(repeat('0',64)))",'23514')}
RESET ROLE;
${catalog('20261003000003')}
${catalog('20261003000004')}
`);
});

test('admin-activation-migration-ledger: M3 remains closed across a data-free M4 reserve and forward application', () => {
  runSql(`${repoSql('supabase/admin-delegation-reserve/20261003000004-rollback.sql')}
${catalog('20261003000004',true)}
${measureIssuanceForTest}
SET LOCAL ROLE commonswarm_admin_release;
${refuses('UPDATE commonswarm_oauth.admin_cutover_state SET admin_issuance_enabled=true','23514')}
RESET ROLE;
${repoSql('supabase/migrations/20261003000004_migration_checksums.sql')}
${catalog('20261003000004')}
SET LOCAL ROLE commonswarm_admin_release;
${refuses('UPDATE commonswarm_oauth.admin_cutover_state SET admin_issuance_enabled=true','23514')}
RESET ROLE;
${dbAssert('SELECT NOT admin_issuance_enabled FROM commonswarm_oauth.admin_cutover_state', 'installing M4 without evidence stays closed')}
`);
});
