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
    -- This historical 005 inverse drill owns the 005 body inside its rollback transaction.
    ${repoSql('supabase/household-approval-reserve/20261004000015-rollback.sql')}
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

test('991 applies with unchanged audit ownership/search path/ACL and edge command receipts stay append-only with attributed and human audits', () => {
 const owner=randomUUID(),workspace=randomUUID(),principal=randomUUID();
 runSql(`
  ${repoSql('supabase/migrations/20261004000015_household_approval_until_withdrawn.sql')}
  CREATE TEMP TABLE audit_function_before AS SELECT proowner,proacl,proconfig FROM pg_proc WHERE oid='swarm.audit_household_permission()'::regprocedure;
  DROP TABLE swarm.household_owner_permission_receipts;
  ${repoSql('supabase/migrations/20261021000991_household_owner_chat_permissions.sql')}
  ${dbAssert(`SELECT (p.proowner,p.proacl,p.proconfig) IS NOT DISTINCT FROM (b.proowner,b.proacl,b.proconfig) FROM pg_proc p CROSS JOIN audit_function_before b WHERE p.oid='swarm.audit_household_permission()'::regprocedure`,'991 preserves audit function owner ACL and search path')}
  ${dbAssert(`SELECT has_table_privilege('swarm_command','swarm.household_owner_permission_receipts','SELECT') AND has_table_privilege('swarm_command','swarm.household_owner_permission_receipts','INSERT') AND NOT has_table_privilege('swarm_command','swarm.household_owner_permission_receipts','UPDATE') AND NOT has_table_privilege('swarm_command','swarm.household_owner_permission_receipts','DELETE')`,'receipt privileges are exactly read append')}
  INSERT INTO auth.users(id,aud,role,email) VALUES('${owner}','authenticated','authenticated','${owner}@example.test');
  INSERT INTO swarm.users(user_id,display_name) VALUES('${owner}','Synthetic D1 owner');
  INSERT INTO swarm.workspaces(workspace_id,name,created_by) VALUES('${workspace}','Synthetic D1 workspace','${owner}');
  INSERT INTO swarm.memberships(workspace_id,user_id,role) VALUES('${workspace}','${owner}','owner');
  INSERT INTO swarm.agent_principals(principal_id,workspace_id,owner_user_id,name) VALUES('${principal}','${workspace}','${owner}','Synthetic D1 principal');
  DO $edge$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='commonswarm_edge') THEN CREATE ROLE commonswarm_edge LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS; END IF; END $edge$;
  GRANT swarm_command,swarm_read,swarm_capability TO commonswarm_edge;
  SET LOCAL SESSION AUTHORIZATION commonswarm_edge;
  SET LOCAL ROLE swarm_command;
  ${dbAssert(`SELECT session_user='commonswarm_edge' AND current_user='swarm_command'`,'production login role boundary')}
  ${dbAssert(`SELECT NOT pg_has_role(session_user,'commonswarm_oauth_runtime','MEMBER')`,'edge cannot assume OAuth runtime')}
  ${refuses('SELECT * FROM swarm.household_owner_permission_receipts FOR UPDATE','42501')}
  SELECT * FROM swarm.household_owner_permission_receipts;
  SELECT set_config('cswarm.household_actor','${owner}',true),set_config('cswarm.household_principal','${principal}',true),set_config('cswarm.household_request','d1_owner_991',true),set_config('cswarm.household_digest',repeat('a',64),true),set_config('cswarm.household_command','household_owner_permissions',true);
  INSERT INTO swarm.household_workspace_boundaries(workspace_id,purpose) VALUES('${workspace}','shared');
  INSERT INTO swarm.household_member_content_roles(workspace_id,user_id,content_role,content_consent_id,confirmed_at) VALUES('${workspace}','${owner}','editor','${randomUUID()}',clock_timestamp());
  SELECT set_config('cswarm.household_command','household_permissions',true),set_config('cswarm.household_request','d1_human_991',true);
  UPDATE swarm.household_member_content_roles SET content_role='reader' WHERE workspace_id='${workspace}' AND user_id='${owner}';
  RESET ROLE;RESET SESSION AUTHORIZATION;
  ${dbAssert(`SELECT count(*)=2 AND bool_and(actor_user='${owner}' AND actor_principal='${principal}') FROM swarm.household_object_audit WHERE workspace_id='${workspace}' AND command_id='d1_owner_991'`,'owner writes retain principal attribution')}
  ${dbAssert(`SELECT count(*)=1 AND bool_and(actor_user='${owner}' AND actor_principal IS NULL AND command_kind='household_permissions') FROM swarm.household_object_audit WHERE workspace_id='${workspace}' AND command_id='d1_human_991'`,'human branch ignores stale agent context and keeps human attribution')}
 `);
});
