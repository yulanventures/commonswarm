/** D2 independently recorded release hashes and the live ledger, CI/Docker only. */
import { test } from 'node:test';
import { catalog, checksumVersions, dbAssert, expectedMigrationHashes, recordChecksumEvidenceForTest, refuses, repoSql, runSql } from '../support/admin-schema-db.js';

const version = '29991003000004';
const call = `commonswarm_ops.migration_checksum_failures()`;
const checksum = `INSERT INTO commonswarm_ops.migration_checksums(version,sha256,source,released_sha)
VALUES('${version}',repeat('a',64),'release',repeat('b',40))`;

test('migration-checksums: only release INSERT, runtime/command reads, append-only even after accidental mutation grant', () => {
  runSql(`${catalog('20261003000004')}
SET LOCAL ROLE commonswarm_admin_release;
${checksum};
${refuses(checksum,'23505')}
${refuses(`UPDATE commonswarm_ops.migration_checksums SET sha256=repeat('c',64)`,'42501')}
${refuses('DELETE FROM commonswarm_ops.migration_checksums','42501')}
${refuses('TRUNCATE commonswarm_ops.migration_checksums','42501')}
RESET ROLE;
${['commonswarm_oauth_runtime','swarm_command'].map(role => `SET LOCAL ROLE ${role};
${dbAssert(`SELECT count(*)=1 FROM commonswarm_ops.migration_checksums WHERE version='${version}'`,`${role} read control`)}
${refuses(checksum,'42501')}
${refuses('UPDATE commonswarm_ops.migration_checksums SET source=source','42501')}
${refuses('DELETE FROM commonswarm_ops.migration_checksums','42501')}
RESET ROLE;`).join('\n')}
${['anon','authenticated','swarm_read','commonswarm_dpop_verifier','commonswarm_oauth_maintenance','commonswarm_admin_issuer'].map(role => `SET LOCAL ROLE ${role};
${refuses('SELECT * FROM commonswarm_ops.migration_checksums','42501')}
${refuses(checksum,'42501')}
${refuses(`SELECT * FROM ${call}`,'42501')}
RESET ROLE;`).join('\n')}
-- Reach the trigger, independent of the normal absence of mutation ACLs.
GRANT SELECT,UPDATE,DELETE ON commonswarm_ops.migration_checksums TO commonswarm_admin_release;
CREATE POLICY checksum_test_mutation ON commonswarm_ops.migration_checksums FOR ALL TO commonswarm_admin_release USING(true) WITH CHECK(true);
SET LOCAL ROLE commonswarm_admin_release;
${dbAssert(`SELECT count(*)=1 FROM commonswarm_ops.migration_checksums WHERE version='${version}'`, 'trigger probe reaches the inserted row')}
${refuses(`UPDATE commonswarm_ops.migration_checksums SET sha256=repeat('c',64) WHERE version='${version}'`,'55000')}
${refuses(`DELETE FROM commonswarm_ops.migration_checksums WHERE version='${version}'`,'55000')}
RESET ROLE;
REVOKE SELECT,UPDATE,DELETE ON commonswarm_ops.migration_checksums FROM commonswarm_admin_release;
DROP POLICY checksum_test_mutation ON commonswarm_ops.migration_checksums;
${catalog('20261003000004')}
${refuses(repoSql('supabase/admin-delegation-reserve/20261003000004-rollback.sql'),'55000')}
-- The documented owner exception is separate from every application role.
SET LOCAL ROLE swarm_admin;
UPDATE commonswarm_ops.migration_checksums SET source='backfill' WHERE version='${version}';
RESET ROLE;
${dbAssert(`SELECT source='backfill' FROM commonswarm_ops.migration_checksums WHERE version='${version}'`, 'owner exception control')}
`);
});

test('migration-checksums: full fixed set positive; every required ledger/checksum/digest negative; missing/subset expectations refuse; unrelated rows ignored', () => {
  const expected = `'${expectedMigrationHashes}'::jsonb`;
  runSql(`${recordChecksumEvidenceForTest}
SET LOCAL ROLE commonswarm_admin_release;
UPDATE commonswarm_oauth.admin_cutover_state SET required_migrations=${expected};
RESET ROLE;
${['commonswarm_oauth_runtime','swarm_command'].map(role => `SET LOCAL ROLE ${role};
${dbAssert(`SELECT count(*)=0 FROM ${call}`,`${role} full required set positive`)}
${refuses('SELECT * FROM supabase_migrations.schema_migrations','42501')}
${refuses(`UPDATE commonswarm_oauth.admin_cutover_state SET required_migrations='{}'`,'42501')}
-- No caller-selected version subset or expected digest API remains.
${refuses(`SELECT * FROM commonswarm_ops.migration_checksum_failures('[{"version":"${version}","sha256":"${'a'.repeat(64)}"}]'::jsonb)`,'42883')}
RESET ROLE;`).join('\n')}
-- Extra unrelated evidence cannot change completeness of the required set.
INSERT INTO supabase_migrations.schema_migrations(version) VALUES('${version}');
SET LOCAL ROLE commonswarm_admin_release;
${checksum};
RESET ROLE;
${dbAssert(`SELECT count(*)=0 FROM ${call}`, 'unrelated rows ignored')}
${checksumVersions.map(v => `
SAVEPOINT required_version;
DELETE FROM supabase_migrations.schema_migrations WHERE version='${v}';
${dbAssert(`SELECT count(*)=1 AND bool_and(reason='missing_ledger' AND version='${v}') FROM ${call}`, `${v} missing ledger`)}
ROLLBACK TO SAVEPOINT required_version;
SET LOCAL ROLE swarm_admin;
DELETE FROM commonswarm_ops.migration_checksums WHERE version='${v}';
RESET ROLE;
${dbAssert(`SELECT count(*)=1 AND bool_and(reason='missing_checksum' AND version='${v}' AND recorded_sha256 IS NULL) FROM ${call}`, `${v} missing checksum`)}
ROLLBACK TO SAVEPOINT required_version;
SET LOCAL ROLE swarm_admin;
UPDATE commonswarm_ops.migration_checksums SET sha256=repeat('0',64) WHERE version='${v}';
RESET ROLE;
${dbAssert(`SELECT count(*)=1 AND bool_and(reason='checksum_mismatch' AND version='${v}' AND required_sha256<>recorded_sha256) FROM ${call}`, `${v} wrong recorded digest`)}
ROLLBACK TO SAVEPOINT required_version;
RELEASE SAVEPOINT required_version;`).join('\n')}
SAVEPOINT expected_measurement;
SET LOCAL ROLE commonswarm_admin_release;
UPDATE commonswarm_oauth.admin_cutover_state SET required_migrations='{}'::jsonb;
RESET ROLE;
${dbAssert(`SELECT count(*)=${checksumVersions.length} AND bool_and(reason='missing_expected') FROM ${call}`, 'all fixed identities require reviewed expectations')}
SET LOCAL ROLE commonswarm_admin_release;
UPDATE commonswarm_oauth.admin_cutover_state SET required_migrations=(
 SELECT jsonb_object_agg(key,value) FROM jsonb_each(${expected})
 WHERE key IN ('20261003000001','20261003000002','20261003000003'));
RESET ROLE;
${dbAssert(`SELECT count(*)=${checksumVersions.length - 3} AND bool_and(reason='missing_expected') FROM ${call}`, 'M1-M3 caller-style subset cannot establish completeness')}
ROLLBACK TO SAVEPOINT expected_measurement;
SET LOCAL ROLE commonswarm_admin_release;
${refuses(`INSERT INTO commonswarm_ops.migration_checksums(version,sha256,source,released_sha) VALUES('29991003000005','BAD','release',repeat('b',40))`,'23514')}
${refuses(`INSERT INTO commonswarm_ops.migration_checksums(version,sha256,source,released_sha) VALUES('29991003000005',repeat('a',64),'expected',repeat('b',40))`,'23514')}
${refuses(`INSERT INTO commonswarm_ops.migration_checksums(version,sha256,source,released_sha) VALUES('29991003000005',repeat('a',64),'release','BAD')`,'23514')}
RESET ROLE;
${catalog('20261003000004')}
GRANT UPDATE ON commonswarm_ops.migration_checksums TO commonswarm_oauth_runtime;
${catalog('20261003000004',false,false)}
REVOKE UPDATE ON commonswarm_ops.migration_checksums FROM commonswarm_oauth_runtime;
${catalog('20261003000004')}
`);
});

test('migration-checksums: data-free reserve, preserved pre-existing schema and forward reapply', () => {
  runSql(`CREATE TABLE commonswarm_ops.checksum_unrelated(id integer);
${repoSql('supabase/admin-delegation-reserve/20261003000004-rollback.sql')}
${catalog('20261003000004',true)}
${dbAssert("SELECT to_regclass('commonswarm_ops.checksum_unrelated') IS NOT NULL", 'reserve keeps unrelated ops objects')}
${repoSql('supabase/migrations/20261003000004_migration_checksums.sql')}
${catalog('20261003000004')}
${dbAssert('SELECT count(*)=0 FROM commonswarm_ops.migration_checksums', 'migration seeds no release evidence')}
${dbAssert('SELECT NOT admin_issuance_enabled FROM commonswarm_oauth.admin_cutover_state', 'checksum schema cannot enable issuance')}
`);
});
