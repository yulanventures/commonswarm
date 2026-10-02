/** D2 independently recorded release hashes and the live ledger, CI/Docker only. */
import { test } from 'node:test';
import { catalog, dbAssert, refuses, repoSql, runSql } from '../support/admin-schema-db.js';

const version = '29991003000004';
const req = `'[{"version":"${version}","sha256":"${'a'.repeat(64)}"}]'::jsonb`;
const call = `commonswarm_ops.migration_checksum_failures(${req})`;
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

test('migration-checksums: predicate positive, missing ledger/checksum and mismatch negatives; malformed requirements refuse', () => {
  runSql(`SET LOCAL ROLE commonswarm_admin_release;
${checksum};
RESET ROLE;
SET LOCAL ROLE commonswarm_oauth_runtime;
${dbAssert(`SELECT reason='missing_ledger' AND version='${version}' AND recorded_sha256=repeat('a',64) FROM ${call}`, 'checksum alone cannot establish application')}
RESET ROLE;
INSERT INTO supabase_migrations.schema_migrations(version) VALUES('${version}');
${['commonswarm_oauth_runtime','swarm_command'].map(role => `SET LOCAL ROLE ${role};
${dbAssert(`SELECT count(*)=0 FROM ${call}`,`${role} complete ledger positive`)}
${dbAssert(`SELECT reason='checksum_mismatch' FROM commonswarm_ops.migration_checksum_failures(
 '[{"version":"${version}","sha256":"${'c'.repeat(64)}"}]')`,`${role} wrong expected digest`)}
${refuses('SELECT * FROM supabase_migrations.schema_migrations','42501')}
${['NULL',"'[]'::jsonb","'{}'::jsonb","'[{}]'::jsonb",`(${req}||${req})`,"'[{\"version\":\"bad\",\"sha256\":\"bad\"}]'::jsonb"].map(invalid => refuses(`SELECT * FROM commonswarm_ops.migration_checksum_failures(${invalid})`,'22023')).join('\n')}
RESET ROLE;`).join('\n')}
-- In this rollback-only fixture, the owner exception removes independently
-- recorded evidence without removing the applied migration ledger row.
SET LOCAL ROLE swarm_admin;
DELETE FROM commonswarm_ops.migration_checksums WHERE version='${version}';
RESET ROLE;
SET LOCAL ROLE commonswarm_oauth_runtime;
${dbAssert(`SELECT reason='missing_checksum' AND recorded_sha256 IS NULL FROM ${call}`, 'ledger alone cannot establish digest')}
RESET ROLE;
SET LOCAL ROLE commonswarm_admin_release;
INSERT INTO commonswarm_ops.migration_checksums(version,sha256,source,released_sha)
VALUES('${version}',repeat('a',64),'backfill',repeat('b',40));
${refuses(`INSERT INTO commonswarm_ops.migration_checksums(version,sha256,source,released_sha) VALUES('bad-hash','BAD','release',repeat('b',40))`,'23514')}
${refuses(`INSERT INTO commonswarm_ops.migration_checksums(version,sha256,source,released_sha) VALUES('bad-source',repeat('a',64),'expected',repeat('b',40))`,'23514')}
${refuses(`INSERT INTO commonswarm_ops.migration_checksums(version,sha256,source,released_sha) VALUES('bad-sha',repeat('a',64),'release','BAD')`,'23514')}
RESET ROLE;
SET LOCAL ROLE commonswarm_oauth_runtime;
${dbAssert(`SELECT count(*)=0 FROM ${call}`, 'verified backfill is accepted evidence')}
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
