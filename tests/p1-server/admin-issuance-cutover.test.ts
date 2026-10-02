/** Ledger admission at the real database boundary; Docker/CI only. */
import { test } from 'node:test';
import { dbAssert, fixture, issuance, openIssuanceForTest, refuses, runSql } from '../support/admin-schema-db.js';

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
