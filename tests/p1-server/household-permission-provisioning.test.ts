/** CI-only PostgreSQL proof: real ACLs, provenance, independent confirmation,
 * append-only audit and the exact reserve rollback. No live-service targets. */
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { runSql, repoSql, dbAssert, refuses } from '../support/admin-schema-db.js';

test('household permission writes require authenticated provenance and cannot confirm another member; rollback removes only new grants', () => {
  const owner = randomUUID(), other = randomUUID(), workspace = randomUUID(), principal = randomUUID();
  const consent = randomUUID();
  const catalog = repoSql('deploy/release-proofs/household-storage/20261004000005-catalog.sql');
  const inverse = repoSql('supabase/household-storage-reserve/20261004000005-rollback.sql');
  const rollbackCatalog = repoSql('deploy/release-proofs/household-storage/20261004000005-rollback-catalog.sql');
  runSql(`
    INSERT INTO auth.users(id,aud,role,email) VALUES ('${owner}','authenticated','authenticated','hh-owner-${owner}@example.test'),
      ('${other}','authenticated','authenticated','hh-other-${other}@example.test');
    INSERT INTO swarm.users(user_id,display_name) VALUES ('${owner}','Synthetic owner'),('${other}','Synthetic other');
    INSERT INTO swarm.workspaces(workspace_id,name,created_by) VALUES ('${workspace}','Synthetic household','${owner}');
    INSERT INTO swarm.memberships(workspace_id,user_id,role) VALUES ('${workspace}','${owner}','owner'),('${workspace}','${other}','member');
    INSERT INTO swarm.agent_principals(principal_id,workspace_id,owner_user_id,name) VALUES ('${principal}','${workspace}','${owner}','Synthetic agent');
    ${catalog}
    SELECT :'catalog_ok'::boolean AS proof_pass \\gset
    \\if :proof_pass
    \\else
      DO $$ BEGIN RAISE EXCEPTION 'forward proof failed'; END $$;
    \\endif
    SET LOCAL ROLE swarm_command;
    ${refuses(`INSERT INTO swarm.household_workspace_boundaries(workspace_id,purpose) VALUES ('${workspace}','shared')`, '42501')}
    SELECT set_config('cswarm.household_actor','${owner}',true),set_config('cswarm.household_request','confirmation_01',true),
      set_config('cswarm.household_digest',repeat('a',64),true);
    INSERT INTO swarm.household_workspace_boundaries(workspace_id,purpose) VALUES ('${workspace}','shared');
    INSERT INTO swarm.household_member_content_roles(workspace_id,user_id,content_role,content_consent_id,confirmed_at)
      VALUES ('${workspace}','${owner}','editor','${consent}',clock_timestamp());
    ${refuses(`INSERT INTO swarm.household_member_content_roles(workspace_id,user_id,content_role,content_consent_id,confirmed_at)
      VALUES ('${workspace}','${other}','editor','${randomUUID()}',clock_timestamp())`, '42501')}
    INSERT INTO swarm.household_content_connections(connection_id,grant_id,workspace_id,principal_id,owner_user_id,purpose,operations,consent_receipt_id,expires_at)
      VALUES ('${randomUUID()}','${randomUUID()}','${workspace}','${principal}','${owner}','shared',ARRAY['read','update'],'${consent}',clock_timestamp()+interval '1 hour');
    ${refuses(`UPDATE swarm.household_workspace_boundaries SET purpose='personal',owner_user_id='${owner}' WHERE workspace_id='${workspace}'`, '42501')}
    RESET ROLE;
    ${dbAssert(`SELECT count(*)=3 AND bool_and(actor_user='${owner}' AND actor_principal IS NULL AND command_id='confirmation_01')
      FROM swarm.household_object_audit WHERE workspace_id='${workspace}'`, 'exactly three confirmed permission rows were audited')}
    ${inverse}
    ${rollbackCatalog}
    SELECT :'rollback_ok'::boolean AS inverse_pass \\gset
    \\if :inverse_pass
    \\else
      DO $$ BEGIN RAISE EXCEPTION 'rollback proof failed'; END $$;
    \\endif
    ${dbAssert(`SELECT count(*)=3 FROM swarm.household_object_audit WHERE workspace_id='${workspace}'`, 'rollback preserves audit')}
    ${dbAssert(`SELECT content_role='editor' FROM swarm.household_member_content_roles WHERE workspace_id='${workspace}' AND user_id='${owner}'`, 'rollback preserves explicit consent')}
  `);
});
