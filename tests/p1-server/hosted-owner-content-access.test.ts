/** Linux only. Real edge session -> command role, PostgreSQL ACL/audit boundary.
 * Handler/capability lifecycle coverage lives in household-todo-mcp.test.ts. */
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { runSql, repoSql, dbAssert, refuses, recordChecksumEvidenceForTest } from '../support/admin-schema-db.js';
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
  const deadControls = ['revoked','expired'].map(kind => ({ kind, principal: randomUUID(), seat: randomUUID() }));
  const deadSetup = deadControls.map(c => `
    INSERT INTO swarm.agent_principals(principal_id,workspace_id,owner_user_id,name,transport,turn_only)
      VALUES('${c.principal}','${workspace}','${owner}','${c.kind} legacy target','hosted_mcp',true);
    INSERT INTO swarm.hosted_mcp_seats(seat_id,grant_id,workspace_id,owner_user_id,principal_id,name,created_at,revoked_at)
      VALUES('${c.seat}','${grant}','${workspace}','${owner}','${c.principal}','${c.kind} legacy target',clock_timestamp(),${c.kind==='revoked'?'clock_timestamp()':'NULL'});
    INSERT INTO swarm.household_content_connections(connection_id,grant_id,workspace_id,principal_id,owner_user_id,purpose,operations,consent_receipt_id,expires_at,revoked_at,hosted_grant_id)
      SELECT '${c.seat}','${grant}','${workspace}','${c.principal}','${owner}','shared',ARRAY['read','create','update'],content_consent_id,
        ${c.kind==='expired'?"clock_timestamp()-interval '1 hour'":'NULL'},${c.kind==='revoked'?'clock_timestamp()':'NULL'},'${grant}'
      FROM swarm.household_member_content_roles WHERE workspace_id='${workspace}' AND user_id='${owner}';
  `).join('\n');
  const deadVisible = deadControls.map(c => dbAssert(`SELECT count(*)=1 FROM swarm.household_content_connections
    WHERE connection_id='${c.seat}' AND (revoked_at IS NOT NULL OR expires_at<=clock_timestamp())`,
    `${c.kind} legacy denial stays visible during new-source roll-forward window`)).join('\n');
  const scope=`grant_id='${grant}' AND workspace_id='${workspace}'`;
  const context=(kind: string)=>`SELECT set_config('cswarm.household_actor','${owner}',true),
    set_config('cswarm.household_command','${kind}',true),set_config('cswarm.household_request','restriction-proof',true),
    set_config('cswarm.household_digest',repeat('a',64),true);`;
  const insert=(id=principal,origin='human_withdraw',ops="ARRAY[]::text[]")=>`INSERT INTO swarm.household_hosted_content_restrictions
    (grant_id,workspace_id,owner_user_id,principal_id,operations,origin)
    VALUES('${grant}','${workspace}','${owner}','${id}',${ops},'${origin}')`;
  const closed = deadControls.find(c => c.kind === 'revoked')!;
  // This is the exact valid CLOSED legacy row, not a malformed marker. Each
  // negative below changes one independent authorization/closure condition.
  const exactMarkers = `(SELECT jsonb_build_array(jsonb_build_object('kind','legacy','row',to_jsonb(c)))
    FROM swarm.household_content_connections c WHERE c.connection_id='${closed.seat}')`;
  const markerWrite = (markers=exactMarkers, origin='human_allow', ops="ARRAY['read','create','update']") =>
    `UPDATE swarm.household_hosted_content_restrictions SET closed_target_replacements=${markers},
      origin='${origin}',operations=${ops} WHERE ${scope} AND principal_id='${sibling}'`;
  runSql(`
    ${recordChecksumEvidenceForTest}
    ${dbAssert(`SELECT count(*)>0 FROM commonswarm_ops.migration_checksums`,'ledger preservation uses nonempty canonical release evidence')}
    CREATE TEMP TABLE migrations_before AS SELECT to_jsonb(m) AS row FROM supabase_migrations.schema_migrations m;
    CREATE TEMP TABLE checksums_before AS SELECT to_jsonb(m) AS row FROM commonswarm_ops.migration_checksums m;
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
    ${deadSetup}
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
    ${refuses(insert(principal,'human_allow',"ARRAY['read']::text[]"),'42501')}
    ${context('household_withdraw_connection')}
    ${refuses(insert(decoy),'42501')}
    ${insert()};
    ${dbAssert(`SELECT origin='human_withdraw' AND changed_by='${owner}' AND cardinality(operations)=0 FROM swarm.household_hosted_content_restrictions WHERE ${scope}`,'missing approval withdrawal persists with truthful human provenance')}
    ${dbAssert(`SELECT NOT EXISTS(SELECT 1 FROM swarm.household_content_connections WHERE workspace_id='${workspace}' AND connection_id='${seat}')`,'restriction never invents approval')}
    ${dbAssert(`SELECT count(*)=1 FROM swarm.household_object_audit WHERE workspace_id='${workspace}' AND reason_code='human_withdraw'`,'exactly one restriction audit')}
    ${refuses(`DELETE FROM swarm.household_hosted_content_restrictions WHERE ${scope}`,'42501')}
    ${refuses(`UPDATE swarm.household_hosted_content_restrictions SET changed_by='${decoy}' WHERE ${scope}`,'42501')}
    ${refuses(`UPDATE swarm.household_hosted_content_restrictions SET principal_id='${sibling}' WHERE ${scope}`,'42501')}
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
    ${dbAssert(`SELECT NOT EXISTS(SELECT 1 FROM swarm.household_content_connections WHERE connection_id='${siblingSeat}')`,'rollback gate prevents live sibling approval bypass of grant withdrawal')}
    ${deadVisible}
    ${dbAssert(`SELECT NOT EXISTS(SELECT 1 FROM swarm.household_content_connections WHERE workspace_id='${workspace}'
      AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>clock_timestamp()))`,'old-source live-approval filter still denies every gated connection')}
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
    -- Operator roll-forward fixture: source activation is an external packet
    -- precondition; only this explicit step removes the compatibility policy.
    DROP POLICY hosted_owner_content_rollback_gate ON swarm.household_content_connections;
    ${catalog('catalog')}
    SET LOCAL SESSION AUTHORIZATION commonswarm_edge;
    SET LOCAL ROLE swarm_command;
    ${dbAssert(`SELECT count(*)=1 FROM swarm.household_content_connections WHERE connection_id='${siblingSeat}'`,'forward source can again address the exact legacy approval')}
    ${deadVisible}
    ${dbAssert(`SELECT origin='human_withdraw' AND cardinality(operations)=0 FROM swarm.household_hosted_content_restrictions WHERE ${scope}`,'forward gate drop retains the denial consumed by the new source')}
    RESET ROLE;
    RESET SESSION AUTHORIZATION;
    ${dbAssert(`SELECT NOT EXISTS((SELECT row FROM audit_before EXCEPT SELECT to_jsonb(a) FROM swarm.household_object_audit a)
      UNION ALL(SELECT to_jsonb(a) FROM swarm.household_object_audit a EXCEPT SELECT row FROM audit_before))`,'forward gate drop preserves audit bytes')}

    ${dbAssert(`SELECT NOT EXISTS((SELECT row FROM migrations_before EXCEPT SELECT to_jsonb(m) FROM supabase_migrations.schema_migrations m)
      UNION ALL(SELECT to_jsonb(m) FROM supabase_migrations.schema_migrations m EXCEPT SELECT row FROM migrations_before))`,'rollback and forward keep the migration ledger unchanged')}
    ${dbAssert(`SELECT NOT EXISTS((SELECT row FROM checksums_before EXCEPT SELECT to_jsonb(m) FROM commonswarm_ops.migration_checksums m)
      UNION ALL(SELECT to_jsonb(m) FROM commonswarm_ops.migration_checksums m EXCEPT SELECT row FROM checksums_before))`,'rollback and forward keep the checksum ledger unchanged')}

    SET LOCAL SESSION AUTHORIZATION commonswarm_edge;
    SET LOCAL ROLE swarm_command;
    ${context('household_approve_connection')}
    -- Real authenticated-human SQL writes work again after gate removal.
    INSERT INTO swarm.household_content_connections(connection_id,grant_id,workspace_id,principal_id,owner_user_id,purpose,operations,consent_receipt_id,expires_at,hosted_grant_id)
      SELECT '${seat}','${grant}','${workspace}','${principal}','${owner}','shared',ARRAY['read'],content_consent_id,NULL,'${grant}'
      FROM swarm.household_member_content_roles WHERE workspace_id='${workspace}' AND user_id='${owner}';
    UPDATE swarm.household_hosted_content_restrictions SET operations=ARRAY['read'],origin='human_allow' WHERE ${scope};
    ${dbAssert(`SELECT origin='human_allow' AND operations=ARRAY['read'] AND changed_by='${owner}' FROM swarm.household_hosted_content_restrictions WHERE ${scope}`,'post-gate targeted human reallow has live approval and truthful provenance')}
    RESET ROLE;
    RESET SESSION AUTHORIZATION;

    SET LOCAL SESSION AUTHORIZATION commonswarm_edge;
    SET LOCAL ROLE swarm_command;
    ${context('household_withdraw_connection')}
    ${insert(sibling)};
    ${dbAssert(`SELECT count(*)=2 FROM swarm.household_hosted_content_restrictions WHERE ${scope}`,'two canonical withdrawal/reallow targets coexist without overwriting provenance')}
    ${context('household_approve_connection')}
    UPDATE swarm.household_content_connections SET operations=ARRAY['read','create','update'] WHERE connection_id='${siblingSeat}';
    UPDATE swarm.household_hosted_content_restrictions SET operations=ARRAY['read','create','update'],origin='human_allow'
      WHERE ${scope} AND principal_id='${sibling}';
    ${refuses(`UPDATE swarm.household_hosted_content_restrictions SET closed_target_replacements='[{}]'::jsonb WHERE ${scope} AND principal_id='${sibling}'`,'42501')}
    ${dbAssert(`SELECT operations=ARRAY['read'] AND principal_id='${principal}' FROM swarm.household_hosted_content_restrictions WHERE ${scope} AND principal_id='${principal}'`,'Allow B leaves explicit read-only A unchanged')}
    ${markerWrite()};
    ${dbAssert(`SELECT jsonb_array_length(closed_target_replacements)=1 FROM swarm.household_hosted_content_restrictions WHERE ${scope} AND principal_id='${sibling}'`,'exact closed legacy snapshot positive control reaches trigger validation')}
    UPDATE swarm.household_hosted_content_restrictions SET closed_target_replacements='[]'::jsonb WHERE ${scope} AND principal_id='${sibling}';
    RESET ROLE;
    RESET SESSION AUTHORIZATION;
    UPDATE swarm.memberships SET role='admin' WHERE workspace_id='${workspace}' AND user_id='${owner}';
    SET LOCAL SESSION AUTHORIZATION commonswarm_edge;
    SET LOCAL ROLE swarm_command;
    ${refuses(markerWrite(),'42501')}
    RESET ROLE;
    RESET SESSION AUTHORIZATION;
    UPDATE swarm.memberships SET role='member' WHERE workspace_id='${workspace}' AND user_id='${owner}';
    SET LOCAL SESSION AUTHORIZATION commonswarm_edge;
    SET LOCAL ROLE swarm_command;
    ${refuses(markerWrite(),'42501')}
    RESET ROLE;
    RESET SESSION AUTHORIZATION;
    UPDATE swarm.memberships SET role='owner' WHERE workspace_id='${workspace}' AND user_id='${owner}';
    -- Only the target's liveness changes; its exact legacy snapshot is unchanged.
    UPDATE swarm.hosted_mcp_seats SET revoked_at=NULL WHERE seat_id='${closed.seat}';
    SET LOCAL SESSION AUTHORIZATION commonswarm_edge;
    SET LOCAL ROLE swarm_command;
    ${refuses(markerWrite(),'42501')}
    RESET ROLE;
    RESET SESSION AUTHORIZATION;
    UPDATE swarm.hosted_mcp_seats SET revoked_at=clock_timestamp() WHERE seat_id='${closed.seat}';
    SET LOCAL SESSION AUTHORIZATION commonswarm_edge;
    SET LOCAL ROLE swarm_command;
    ${context('household_withdraw_connection')}
    ${refuses(markerWrite(exactMarkers,'human_withdraw','ARRAY[]::text[]'),'42501')}
    ${context('household_connection_invalidation')}
    ${refuses(markerWrite(exactMarkers,'system_invalidation','ARRAY[]::text[]'),'42501')}
    ${context('household_approve_connection')}
    ${markerWrite()};
    ${dbAssert(`SELECT jsonb_array_length(closed_target_replacements)=1 FROM swarm.household_hosted_content_restrictions WHERE ${scope} AND principal_id='${sibling}'`,'restored owner and closed target admit the same exact snapshot after all negatives')}
    RESET ROLE;
    RESET SESSION AUTHORIZATION;
    -- 256 additional distinct CLOSED canonical legacy targets plus the existing
    -- closed target produce 257 otherwise-valid snapshots; no duplicate padding.
    CREATE TEMP TABLE overflow_targets AS SELECT gen_random_uuid() AS principal_id,gen_random_uuid() AS seat_id FROM generate_series(1,256);
    INSERT INTO swarm.agent_principals(principal_id,workspace_id,owner_user_id,name,transport,turn_only)
      SELECT principal_id,'${workspace}','${owner}','Closed overflow '||principal_id,'hosted_mcp',true FROM overflow_targets;
    INSERT INTO swarm.hosted_mcp_seats(seat_id,grant_id,workspace_id,owner_user_id,principal_id,name,created_at,revoked_at)
      SELECT seat_id,'${grant}','${workspace}','${owner}',principal_id,'Closed overflow '||principal_id,clock_timestamp(),clock_timestamp() FROM overflow_targets;
    INSERT INTO swarm.household_content_connections(connection_id,grant_id,workspace_id,principal_id,owner_user_id,purpose,operations,consent_receipt_id,expires_at,hosted_grant_id)
      SELECT t.seat_id,'${grant}','${workspace}',t.principal_id,'${owner}','shared',ARRAY['read'],r.content_consent_id,NULL,'${grant}'
      FROM overflow_targets t CROSS JOIN swarm.household_member_content_roles r WHERE r.workspace_id='${workspace}' AND r.user_id='${owner}';
    SET LOCAL SESSION AUTHORIZATION commonswarm_edge;
    SET LOCAL ROLE swarm_command;
    ${dbAssert(`SELECT count(*)=257 FROM swarm.household_content_connections WHERE hosted_grant_id='${grant}' AND workspace_id='${workspace}' AND principal_id NOT IN ('${principal}','${sibling}','${deadControls.find(c => c.kind === 'expired')!.principal}')`,'overflow control contains 257 distinct exact closed legacy targets')}
    ${refuses(markerWrite(`(SELECT jsonb_agg(jsonb_build_object('kind','legacy','row',to_jsonb(c)) ORDER BY jsonb_build_object('kind','legacy','row',to_jsonb(c))::text)
      FROM swarm.household_content_connections c WHERE c.hosted_grant_id='${grant}' AND c.workspace_id='${workspace}'
        AND c.principal_id NOT IN ('${principal}','${sibling}','${deadControls.find(c => c.kind === 'expired')!.principal}'))`),'42501')}
    RESET ROLE;
    RESET SESSION AUTHORIZATION;

  `);
});
