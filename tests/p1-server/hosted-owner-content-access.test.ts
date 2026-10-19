/** Linux only. Real edge session -> command role, PostgreSQL ACL/audit boundary.
 * Handler/capability lifecycle coverage lives in household-todo-mcp.test.ts. */
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { runSql, repoSql, dbAssert, refuses } from '../support/admin-schema-db.js';
const proof = 'deploy/release-proofs/hosted-owner-content/20261019000006';
const version = '20261019000006_hosted_owner_content_access.sql';
const catalog = (suffix: 'catalog' | 'rollback-catalog') => {
  const alias = suffix === 'catalog' ? 'catalog_ok' : 'rollback_ok';
  return repoSql(`${proof}-${suffix}.sql`) + String.raw`
    SELECT :'${alias}'::boolean AS proof_pass \gset
    \if :proof_pass
    \else
      DO $$ BEGIN RAISE EXCEPTION 'owner restriction ${suffix} failed'; END $$;
    \endif
  `;
};
test('owner restriction has exact command authority, canonical scope and truthful audit; rollback preserves prior state', () => {
  const owner=randomUUID(), workspace=randomUUID(), grant=randomUUID(), seat=randomUUID(), principal=randomUUID(), decoy=randomUUID(), sibling=randomUUID(), siblingSeat=randomUUID();
  const scope=`grant_id='${grant}' AND workspace_id='${workspace}'`;
  const context=(kind: string)=>`SELECT set_config('cswarm.household_actor','${owner}',true),
    set_config('cswarm.household_command','${kind}',true),set_config('cswarm.household_request','restriction-proof',true),
    set_config('cswarm.household_digest',repeat('a',64),true);`;
  const insert=(id=principal,origin='human_withdraw',ops="ARRAY[]::text[]",replaces=false)=>`INSERT INTO swarm.household_hosted_content_restrictions
    (grant_id,workspace_id,owner_user_id,principal_id,operations,origin,replaces_legacy)
    VALUES('${grant}','${workspace}','${owner}','${id}',${ops},'${origin}',${replaces})`;
  runSql(`
    CREATE TEMP TABLE oauth_before AS SELECT * FROM pg_auth_members WHERE roleid='commonswarm_oauth_runtime'::regrole;
    ${repoSql(`supabase/migrations/${version}`)}
    ${catalog('catalog')}
    ${dbAssert(`SELECT NOT EXISTS((SELECT * FROM oauth_before EXCEPT SELECT * FROM pg_auth_members WHERE roleid='commonswarm_oauth_runtime'::regrole)
      UNION ALL (SELECT * FROM pg_auth_members WHERE roleid='commonswarm_oauth_runtime'::regrole EXCEPT SELECT * FROM oauth_before))`,'migration preserves every OAuth membership option')}
    INSERT INTO auth.users(id,aud,role,email) VALUES('${owner}','authenticated','authenticated','${owner}@example.test');
    INSERT INTO swarm.users(user_id,display_name) VALUES('${owner}','Synthetic owner');
    INSERT INTO swarm.workspaces(workspace_id,name,created_by) VALUES('${workspace}','Synthetic workspace','${owner}');
    INSERT INTO swarm.memberships(workspace_id,user_id,role) VALUES('${workspace}','${owner}','owner');
    INSERT INTO swarm.household_workspace_boundaries(workspace_id,purpose) VALUES('${workspace}','shared');
    INSERT INTO swarm.household_member_content_roles(workspace_id,user_id,content_role,content_consent_id,confirmed_at)
      VALUES('${workspace}','${owner}','editor','${randomUUID()}',clock_timestamp());
    INSERT INTO swarm.agent_principals(principal_id,workspace_id,owner_user_id,name,transport,turn_only)
      VALUES('${principal}','${workspace}','${owner}','Synthetic seat','hosted_mcp',true),('${decoy}','${workspace}','${owner}','No seat','hosted_mcp',true),('${sibling}','${workspace}','${owner}','Sibling seat','hosted_mcp',true);
    INSERT INTO swarm.hosted_mcp_grants(grant_id,provider_grant_id,owner_user_id,home_workspace_id,client_id,resource,selected_workspace_ids,manifest_digest,interaction_ref,state,created_at,activated_at)
      VALUES('${grant}','synthetic-${grant}','${owner}','${workspace}','synthetic-client','https://mcp.commonswarm.com/mcp',ARRAY['${workspace}']::uuid[],decode(repeat('a',64),'hex'),'synthetic-consent','active',clock_timestamp(),clock_timestamp());
    INSERT INTO swarm.hosted_mcp_grant_workspaces(grant_id,workspace_id,owner_user_id,manifest_digest,consent_receipt_id,consented_at)
      VALUES('${grant}','${workspace}','${owner}',decode(repeat('a',64),'hex'),'${randomUUID()}',clock_timestamp());
    INSERT INTO swarm.hosted_mcp_seats(seat_id,grant_id,workspace_id,owner_user_id,principal_id,name,created_at)
      VALUES('${seat}','${grant}','${workspace}','${owner}','${principal}','Synthetic seat',clock_timestamp()),('${siblingSeat}','${grant}','${workspace}','${owner}','${sibling}','Sibling seat',clock_timestamp());
    INSERT INTO swarm.household_content_connections(connection_id,grant_id,workspace_id,principal_id,owner_user_id,purpose,operations,consent_receipt_id,expires_at,hosted_grant_id)
      SELECT '${siblingSeat}','${grant}','${workspace}','${sibling}','${owner}','shared',ARRAY['read'],content_consent_id,NULL,'${grant}'
      FROM swarm.household_member_content_roles WHERE workspace_id='${workspace}' AND user_id='${owner}';
    DO $edge$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='commonswarm_edge') THEN
      CREATE ROLE commonswarm_edge LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
    END IF; END $edge$;
    GRANT swarm_command,swarm_read,swarm_capability TO commonswarm_edge;
    SET LOCAL SESSION AUTHORIZATION commonswarm_edge;
    SET LOCAL ROLE swarm_read;
    ${refuses(insert(),'42501')}
    SET LOCAL ROLE swarm_command;
    ${refuses(insert(),'42501')}
    ${context('household_approve_connection')}
    ${refuses(insert(principal,'human_allow',"ARRAY['read']::text[]",true),'42501')}
    ${context('household_withdraw_connection')}
    ${refuses(insert(decoy),'42501')}
    ${insert()};
    ${dbAssert(`SELECT origin='human_withdraw' AND changed_by='${owner}' AND cardinality(operations)=0 AND NOT replaces_legacy FROM swarm.household_hosted_content_restrictions WHERE ${scope}`,'missing approval withdrawal persists with truthful human provenance')}
    ${dbAssert(`SELECT NOT EXISTS(SELECT 1 FROM swarm.household_content_connections WHERE workspace_id='${workspace}' AND connection_id='${seat}')`,'restriction never invents approval')}
    ${dbAssert(`SELECT count(*)=1 FROM swarm.household_object_audit WHERE workspace_id='${workspace}' AND reason_code='human_withdraw'`,'exactly one restriction audit')}
    ${refuses(`DELETE FROM swarm.household_hosted_content_restrictions WHERE ${scope}`,'42501')}
    ${refuses(`UPDATE swarm.household_hosted_content_restrictions SET changed_by='${decoy}' WHERE ${scope}`,'42501')}
    RESET ROLE;
    RESET SESSION AUTHORIZATION;
    CREATE TEMP TABLE audit_before AS SELECT to_jsonb(a) AS row FROM swarm.household_object_audit a;
    CREATE TEMP TABLE consent_before AS SELECT to_jsonb(r) AS row FROM swarm.household_member_content_roles r;
    CREATE TEMP TABLE legacy_before AS SELECT to_jsonb(c) AS row FROM swarm.household_content_connections c;
    SET LOCAL SESSION AUTHORIZATION commonswarm_edge;
    SET LOCAL ROLE swarm_command;
    ${dbAssert(`SELECT count(*)=1 FROM swarm.household_content_connections WHERE connection_id='${siblingSeat}'`,'old source could see sibling approval before compatibility gate')}
    RESET ROLE;
    RESET SESSION AUTHORIZATION;
    ${repoSql(`${proof}-rollback.sql`)}
    SET LOCAL SESSION AUTHORIZATION commonswarm_edge;
    SET LOCAL ROLE swarm_command;
    ${dbAssert(`SELECT NOT EXISTS(SELECT 1 FROM swarm.household_content_connections WHERE connection_id='${siblingSeat}')`,'rollback gate prevents sibling approval bypass of grant withdrawal')}
    RESET ROLE;
    RESET SESSION AUTHORIZATION;
    ${catalog('rollback-catalog')}
    ${dbAssert(`SELECT origin='human_withdraw' AND cardinality(operations)=0 FROM swarm.household_hosted_content_restrictions WHERE ${scope}`,'rollback retains explicit restriction state')}

    ${dbAssert(`SELECT NOT EXISTS((SELECT row FROM audit_before EXCEPT SELECT to_jsonb(a) FROM swarm.household_object_audit a)
      UNION ALL(SELECT to_jsonb(a) FROM swarm.household_object_audit a EXCEPT SELECT row FROM audit_before))`,'rollback preserves nonempty audit bytes')}
    ${dbAssert(`SELECT NOT EXISTS((SELECT row FROM legacy_before EXCEPT SELECT to_jsonb(c) FROM swarm.household_content_connections c)
      UNION ALL(SELECT to_jsonb(c) FROM swarm.household_content_connections c EXCEPT SELECT row FROM legacy_before))`,'rollback preserves legacy bytes')}
    ${dbAssert(`SELECT NOT EXISTS((SELECT row FROM consent_before EXCEPT SELECT to_jsonb(r) FROM swarm.household_member_content_roles r)
      UNION ALL(SELECT to_jsonb(r) FROM swarm.household_member_content_roles r EXCEPT SELECT row FROM consent_before))`,'rollback preserves consent bytes')}
  `);
});
