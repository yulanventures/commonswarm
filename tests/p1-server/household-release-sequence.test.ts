/** CI only: execute the exact eleven section-5 boundaries. All schema/data
 * changes occur in runSql's isolated application schemas and outer rollback.
 * No HTTP, production connections, or customer records are used.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { dbAssert, refuses, runSql } from '../support/admin-schema-db.js';
import { migrationSql, proofSql, releaseProofs } from '../support/household-release-proofs.js';

function catalog(proof: (typeof releaseProofs)[number], expected: boolean): string {
  // Keep the release file's own gset: missing/multiple rows are psql errors.
  return `SAVEPOINT catalog_boundary;
SET LOCAL transaction_read_only=on;
${proofSql(`${proof.release}-catalog.sql`)}
SELECT :'catalog_ok' = '${expected ? 't' : 'f'}' AS boundary_ok
\\gset
\\if :boundary_ok
\\else
DO $$ BEGIN RAISE EXCEPTION 'catalog boundary ${proof.version} mismatch'; END $$;
\\endif
ROLLBACK TO SAVEPOINT catalog_boundary;
RELEASE SAVEPOINT catalog_boundary;
`;
}
function functional(proof: (typeof releaseProofs)[number]): string {
  return `SAVEPOINT functional_boundary;
SET LOCAL transaction_read_only=on;
${dbAssert("SELECT current_setting('transaction_read_only')='on'", 'functional read-only control')}
${proofSql(`${proof.release}-functional.sql`)}
ROLLBACK TO SAVEPOINT functional_boundary;
RELEASE SAVEPOINT functional_boundary;
`;
}
const mutations: Record<string, { sql: string; state: string }> = {
  '20261004000001': { sql: 'REVOKE SELECT ON swarm.household_workspace_boundaries FROM swarm_command;', state: 'P0001' },
  '20261004000002': { sql: 'GRANT SELECT ON swarm.household_object_events TO swarm_read;', state: 'P0001' },
  '20261004000006': { sql: 'REVOKE EXECUTE ON FUNCTION swarm_read.human_invitations() FROM swarm_read;', state: '42501' },
};
function negative(proof: (typeof releaseProofs)[number], mutation = mutations[proof.version]): string {
  if (!mutation) return '';
  // The exception rolls back both the mutation and role/configuration changes.
  // ZX001 is deliberately distinct from the expected failure SQLSTATE.
  return `DO $negative$
BEGIN
 BEGIN
  ${mutation.sql}
  PERFORM set_config('transaction_read_only','on',true);
  EXECUTE $functional_source$${proofSql(`${proof.release}-functional.sql`)}$functional_source$;
  RAISE EXCEPTION 'broken functional behavior admitted' USING ERRCODE='ZX001';
 EXCEPTION WHEN SQLSTATE '${mutation.state}' THEN NULL;
 END;
END
$negative$;
${functional(proof)}`;
}

function fixtures() {
  const owner = randomUUID(), other = randomUUID(), workspace = randomUUID(), masked = randomUUID();
  const open = randomUUID(), doing = randomUUID(), done = randomUUID(), dropped = randomUUID();
  const accounts = `
INSERT INTO auth.users(id,aud,role,email) VALUES
 ('${owner}','authenticated','authenticated','${owner}@example.test'),
 ('${other}','authenticated','authenticated','${other}@example.test');
INSERT INTO swarm.users(user_id,display_name) VALUES ('${owner}','Synthetic owner'),('${other}','Synthetic member');
INSERT INTO swarm.workspaces(workspace_id,name,created_by) VALUES
 ('${workspace}','Synthetic shared home','${owner}'),('${masked}','Synthetic unapproved home','${owner}');
INSERT INTO swarm.memberships(workspace_id,user_id,role) VALUES
 ('${workspace}','${owner}','owner'),('${workspace}','${other}','member'),('${masked}','${owner}','owner');
`;
  const household = `
INSERT INTO swarm.household_workspace_boundaries(workspace_id,purpose) VALUES ('${workspace}','shared'),('${masked}','shared');
INSERT INTO swarm.household_member_content_roles(workspace_id,user_id,content_role,content_consent_id,confirmed_at)
 VALUES ('${workspace}','${owner}','editor','${randomUUID()}',statement_timestamp());
`;
  const grant = randomUUID(), pending = randomUUID();
  const invitations = `
INSERT INTO swarm.admin_accounts(owner_user_id,stream_id) VALUES ('${owner}','${randomUUID()}');
INSERT INTO swarm.admin_grants(grant_id,owner_user_id,admin_identity_id,connection_id,client_id,resource,registry_version,
 scope_names,workspace_ids,created_workspace_policy,target_rules,worker_scope_ceiling,role_ceiling,renewal_limits,issuance_limits,
 expires_at,refresh_deadline,state,consent_receipt_id,manifest_digest,created_at)
 VALUES ('${grant}','${owner}','${randomUUID()}','${randomUUID()}','https://client.example/${grant}',
 'https://api.commonswarm.com/admin',2,ARRAY['invites:create'],ARRAY['${workspace}']::uuid[],
 '{"scope_names":[]}','{"recipient_user_ids":["${other}","${owner}"]}','{}','member','{}','{}',
 statement_timestamp()+interval '1 day',statement_timestamp()+interval '1 day','active','${randomUUID()}',repeat('a',64),statement_timestamp());
INSERT INTO swarm.admin_routine_invitations(invitation_id,workspace_id,parent_admin_grant_id,owner_user_id,
 recipient_user_id,invitation_kind,expires_at,created_at,accepted_at,revoked_at,projection) VALUES
 ('${pending}','${workspace}','${grant}','${owner}','${other}','member',
 statement_timestamp()+interval '1 day',statement_timestamp(),NULL,NULL,'{"role":"member"}'),
 ('${randomUUID()}','${workspace}','${grant}','${owner}','${owner}','member',
 statement_timestamp()+interval '1 day',statement_timestamp(),NULL,NULL,'{"role":"member"}'),
 ('${randomUUID()}','${workspace}','${grant}','${owner}','${other}','member',
 statement_timestamp()+interval '1 day',statement_timestamp(),statement_timestamp(),NULL,'{"role":"member"}'),
 ('${randomUUID()}','${workspace}','${grant}','${owner}','${other}','member',
 statement_timestamp()+interval '1 day',statement_timestamp(),NULL,statement_timestamp(),'{"role":"member"}'),
 ('${randomUUID()}','${workspace}','${grant}','${owner}','${other}','member',
 statement_timestamp()-interval '1 hour',statement_timestamp()-interval '1 day',NULL,NULL,'{"role":"member"}');
`;
  const assertInvitations = `
SELECT set_config('request.jwt.claims','{"sub":"${other}","role":"authenticated"}',true);
SET LOCAL ROLE swarm_read;
${refuses('SELECT * FROM swarm.admin_routine_invitations', '42501')}
${dbAssert(`SELECT array_agg(invitation_id)=ARRAY['${pending}']::uuid[] FROM swarm_read.human_invitations()`, 'recipient gets exactly the pending invitation')}
RESET ROLE;
`;
  const todos = `
INSERT INTO swarm.household_todos(workspace_id,todo_id,version,title,state,created_by_user,created_at,
 assignee_user,state_by_user,state_at,last_seq) VALUES
 ('${workspace}','${open}',1,'Synthetic open item','open','${owner}',statement_timestamp(),'${owner}','${owner}',statement_timestamp(),0),
 ('${workspace}','${doing}',1,'Synthetic doing item','doing','${owner}',statement_timestamp(),'${owner}','${owner}',statement_timestamp(),1),
 ('${workspace}','${done}',1,'Synthetic done item','done','${owner}',statement_timestamp(),'${owner}','${owner}',statement_timestamp(),2),
 ('${workspace}','${dropped}',1,'Synthetic dropped item','dropped','${owner}',statement_timestamp(),'${owner}','${owner}',statement_timestamp(),3),
 ('${masked}','${randomUUID()}',1,'Synthetic hidden item','open','${owner}',statement_timestamp(),'${owner}','${owner}',statement_timestamp(),0);
${dbAssert(`SELECT count(*)=5 FROM swarm.household_todos`, 'nonempty to-do functional control')}
`;
  const assertOverview = `
SELECT set_config('request.jwt.claims','{"sub":"${owner}","role":"authenticated"}',true);
SET LOCAL ROLE authenticated;
${dbAssert(`SELECT (w->'content'->>'open_todos')::int=2 AND jsonb_array_length(w->'needs_you'->'assigned')=2
 FROM jsonb_array_elements(swarm_read.home_overview()->'workspaces') w WHERE w->>'workspace_id'='${workspace}'`, 'seeded overview independent expected counts')}
${dbAssert(`SELECT w->'content'='null'::jsonb AND w->'needs_you'->'assigned'='[]'::jsonb
 FROM jsonb_array_elements(swarm_read.home_overview()->'workspaces') w WHERE w->>'workspace_id'='${masked}'`, 'seeded unapproved content is masked')}
RESET ROLE;
`;
  return { accounts, household, invitations, assertInvitations, todos, assertOverview };
}

for (const seeded of [false, true]) {
  test(`section-5 release order: ${seeded ? 'minimal household data' : 'no household data'}`, { timeout: 120_000 }, () => {
    assert.equal(releaseProofs.length, 11);
    let sequence = [...releaseProofs].reverse().map(proof => proofSql(`${proof.reserve}-rollback.sql`)).join('\n');
    sequence += dbAssert("SELECT to_regclass('swarm.household_workspace_boundaries') IS NULL AND to_regprocedure('swarm_read.home_overview()') IS NULL", 'pre-household state');
    const fixture = fixtures();
    // Production has people and workspaces even when household tables are empty.
    sequence += fixture.accounts;
    for (const proof of releaseProofs) {
      sequence += `\n\\warn household-release-boundary: ${proof.version}\n`;
      sequence += catalog(proof, false);
      sequence += migrationSql(proof.version);
      sequence += catalog(proof, true);
      if (seeded && proof.version === '20261004000001') sequence += fixture.household;
      if (seeded && proof.version === '20261004000006') sequence += fixture.invitations;
      if (seeded && proof.version === '20261006000001') sequence += fixture.todos;
      if (!seeded && proof.version === '20261006000001') {
        sequence += dbAssert('SELECT count(*)=0 FROM swarm.household_todos', 'empty household production control');
      }
      sequence += functional(proof);
      // Run positive controls at the same boundary before and after mutation.
      if (!seeded) sequence += negative(proof);
      if (seeded && proof.version === '20261004000006') {
        sequence += `SAVEPOINT invitation_control; SET LOCAL transaction_read_only=on;
${fixture.assertInvitations}
ROLLBACK TO SAVEPOINT invitation_control; RELEASE SAVEPOINT invitation_control;`;
        // An empty inbox was admitted by the old subset-only proof. The real
        // pending fixture and fixed expected ID above make this a delivery
        // regression, distinct from the existing execution-denial control.
        sequence += negative(proof, {
          sql: `CREATE OR REPLACE FUNCTION swarm_read.human_invitations() RETURNS TABLE(
 invitation_id uuid,workspace_id uuid,workspace_name text,inviter_display_name text,expires_at timestamptz)
 LANGUAGE sql SECURITY DEFINER STABLE SET search_path=pg_catalog AS $empty$
 SELECT NULL::uuid,NULL::uuid,NULL::text,NULL::text,NULL::timestamptz WHERE false
 $empty$;`,
          state: 'ZP006',
        });
      }
      if (seeded && proof.version === '20261006000002') {
        sequence += `SAVEPOINT overview_control; SET LOCAL transaction_read_only=on;
${fixture.assertOverview}
ROLLBACK TO SAVEPOINT overview_control; RELEASE SAVEPOINT overview_control;`;
      }
    }
    runSql(sequence);
  });
}
