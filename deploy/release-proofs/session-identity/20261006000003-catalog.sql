-- Phase-1 reserve-stage proof. Missing objects return false.
-- Exact migrated definitions plus the two equivalent left-hand BETWEEN forms
-- produced by pg_dump/restore; no general parenthesis or operator normalization.
WITH expected_columns(name,typ,required) AS (VALUES
 ('context_id','uuid',true),('handle','text',true),('seat_id','uuid',true),('kind','text',true),
 ('created_at','timestamp with time zone',true),('last_business_at','timestamp with time zone',true),
 ('idle_expires_at','timestamp with time zone',false),('absolute_expires_at','timestamp with time zone',false),
 ('closed_at','timestamp with time zone',false),('close_reason','text',false),('parent_context','uuid',false),('origin','text',true)
), actual_columns(name,typ,required) AS (
 SELECT attname::text,format_type(atttypid,atttypmod),attnotnull FROM pg_attribute
 WHERE attrelid=to_regclass('swarm.hosted_agent_contexts') AND attnum>0 AND NOT attisdropped
), column_diff AS (
 (SELECT * FROM expected_columns EXCEPT SELECT * FROM actual_columns)
 UNION ALL (SELECT * FROM actual_columns EXCEPT SELECT * FROM expected_columns)
), expected_constraints(tab,name,definition) AS (VALUES
 ('hosted_agent_contexts','hosted_agent_contexts_pkey','PRIMARY KEY (context_id)'),
 ('hosted_agent_contexts','hosted_agent_contexts_handle_key','UNIQUE (handle)'),
 ('hosted_agent_contexts','hosted_agent_contexts_seat_id_fkey','FOREIGN KEY (seat_id) REFERENCES swarm.hosted_mcp_seats(seat_id)'),
 ('hosted_agent_contexts','hosted_agent_contexts_parent_context_fkey','FOREIGN KEY (parent_context) REFERENCES swarm.hosted_agent_contexts(context_id)'),
 ('hosted_agent_contexts','hosted_agent_contexts_handle_check',$def$CHECK ((handle ~ '^seat_[A-Za-z0-9_-]{22,64}$'::text))$def$),
 ('hosted_agent_contexts','hosted_agent_contexts_kind_check',$def$CHECK ((kind = ANY (ARRAY['chat'::text, 'task'::text, 'scheduled'::text, 'subagent'::text])))$def$),
 ('hosted_agent_contexts','hosted_agent_contexts_origin_check',$def$CHECK ((origin = ANY (ARRAY['new'::text, 'continue'::text, 'legacy'::text])))$def$),
 ('agent_principals','agent_principals_identity_lifetime_check',$def$CHECK ((identity_lifetime = ANY (ARRAY['durable'::text, 'ephemeral'::text])))$def$),
 ('hosted_mcp_seats','hosted_mcp_seats_display_name_check',$def$CHECK (((display_name IS NULL) OR (((length(display_name) >= 1) AND (length(display_name) <= 80)) AND (display_name = btrim(display_name, ' '::text)) AND (display_name !~ '[[:cntrl:]]'::text))))$def$),
 ('hosted_mcp_seats','hosted_mcp_seats_disambiguator_check',$def$CHECK (((disambiguator IS NULL) OR (disambiguator ~ '^[A-Z2-7]{4}$'::text)))$def$)
), bound_forms(nested,flat) AS (VALUES
 ($bound$((length(name)>=1)AND(length(name)<=80))$bound$,$bound$(length(name)>=1)AND(length(name)<=80)$bound$),
 ($bound$((length(display_name)>=1)AND(length(display_name)<=80))$bound$,$bound$(length(display_name)>=1)AND(length(display_name)<=80)$bound$)
), constraint_diff AS (
 SELECT e.* FROM expected_constraints e LEFT JOIN pg_constraint c
 ON c.conrelid=to_regclass('swarm.'||e.tab) AND c.conname=e.name
 WHERE c.oid IS NULL OR NOT EXISTS (
   SELECT 1 WHERE regexp_replace(pg_get_constraintdef(c.oid),'[[:space:]]','','g')=regexp_replace(e.definition,'[[:space:]]','','g')
   UNION ALL SELECT 1 FROM bound_forms b WHERE
     regexp_replace(pg_get_constraintdef(c.oid),'[[:space:]]','','g')=replace(regexp_replace(e.definition,'[[:space:]]','','g'),b.nested,b.flat)
 )
   OR NOT c.convalidated OR c.condeferrable OR c.condeferred
), expected_indexes(definition) AS (VALUES
 ('CREATE UNIQUE INDEX hosted_agent_contexts_pkey ON swarm.hosted_agent_contexts USING btree (context_id)'),
 ('CREATE UNIQUE INDEX hosted_agent_contexts_handle_key ON swarm.hosted_agent_contexts USING btree (handle)'),
 ('CREATE INDEX hosted_agent_contexts_seat ON swarm.hosted_agent_contexts USING btree (seat_id, created_at DESC)'),
 ('CREATE INDEX hosted_agent_contexts_created ON swarm.hosted_agent_contexts USING btree (created_at, seat_id)'),
 ('CREATE INDEX hosted_agent_contexts_idle ON swarm.hosted_agent_contexts USING btree (idle_expires_at) WHERE (closed_at IS NULL)'),
 ('CREATE INDEX hosted_agent_contexts_absolute ON swarm.hosted_agent_contexts USING btree (absolute_expires_at) WHERE (closed_at IS NULL)')
), actual_indexes(definition) AS (
 SELECT pg_get_indexdef(indexrelid) FROM pg_index WHERE indrelid=to_regclass('swarm.hosted_agent_contexts') AND indisvalid AND indisready
), index_diff AS (
 (SELECT * FROM expected_indexes EXCEPT SELECT * FROM actual_indexes)
 UNION ALL (SELECT * FROM actual_indexes EXCEPT SELECT * FROM expected_indexes)
), proof_tables(tab) AS (VALUES ('hosted_agent_contexts'),('agent_principals'),('hosted_mcp_seats')),
 expected_table_acl(tab,grantor,grantee,privilege,is_grantable) AS (
 -- Owner privileges are PostgreSQL's full table ACL, including version-specific
 -- owner rights; command rights come only from the reviewed migration grants.
 SELECT tab,a.grantor,a.grantee,a.privilege_type,a.is_grantable FROM proof_tables
 CROSS JOIN LATERAL aclexplode(acldefault('r',(SELECT oid FROM pg_roles WHERE rolname='swarm_admin'))) a
 UNION ALL
 SELECT tab,owner.oid,command.oid,privilege,false FROM proof_tables
 CROSS JOIN (SELECT oid FROM pg_roles WHERE rolname='swarm_admin') owner
 CROSS JOIN (SELECT oid FROM pg_roles WHERE rolname='swarm_command') command
 CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE')) permissions(privilege)
), actual_table_acl(tab,grantor,grantee,privilege,is_grantable) AS (
 SELECT c.relname::text,a.grantor,a.grantee,a.privilege_type,a.is_grantable
 FROM proof_tables t JOIN pg_class c ON c.oid=to_regclass('swarm.'||t.tab)
 CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
), table_acl_diff AS (
 (SELECT * FROM expected_table_acl EXCEPT ALL SELECT * FROM actual_table_acl)
 UNION ALL (SELECT * FROM actual_table_acl EXCEPT ALL SELECT * FROM expected_table_acl)
), original_expected(tab,name,typ,required,default_expression) AS (VALUES
 ('agent_principals','principal_id','uuid',true,NULL::text),
 ('agent_principals','workspace_id','uuid',true,NULL::text),
 ('agent_principals','owner_user_id','uuid',true,NULL::text),
 ('agent_principals','name','text',true,NULL::text),
 ('agent_principals','created_at','timestamp with time zone',true,$default$statement_timestamp()$default$),
 ('agent_principals','revoked_at','timestamp with time zone',false,NULL::text),
 ('agent_principals','model','text',false,NULL::text),
 ('agent_principals','managed_at','timestamp with time zone',false,NULL::text),
 ('agent_principals','wake_id','text',true,$default$translate(encode(extensions.gen_random_bytes(32), 'base64'::text), '+/='::text, '-_'::text)$default$),
 ('agent_principals','transport','text',true,$default$'local'::text$default$),
 ('agent_principals','turn_only','boolean',true,$default$false$default$),
 ('agent_principals','parent_admin_grant_id','uuid',false,NULL::text),
 ('agent_principals','identity_lifetime','text',true,$default$'durable'::text$default$),
 ('hosted_mcp_seats','seat_id','uuid',true,NULL::text),
 ('hosted_mcp_seats','grant_id','uuid',true,NULL::text),
 ('hosted_mcp_seats','workspace_id','uuid',true,NULL::text),
 ('hosted_mcp_seats','owner_user_id','uuid',true,NULL::text),
 ('hosted_mcp_seats','principal_id','uuid',true,NULL::text),
 ('hosted_mcp_seats','name','text',true,NULL::text),
 ('hosted_mcp_seats','created_at','timestamp with time zone',true,NULL::text),
 ('hosted_mcp_seats','revoked_at','timestamp with time zone',false,NULL::text),
 ('hosted_mcp_seats','display_name','text',false,NULL::text),
 ('hosted_mcp_seats','disambiguator','text',false,NULL::text)
), original_actual(tab,name,typ,required,default_expression) AS (
 SELECT c.relname::text,a.attname::text,format_type(a.atttypid,a.atttypmod),a.attnotnull,pg_get_expr(d.adbin,d.adrelid)
 FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid
 LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
 WHERE c.oid IN (to_regclass('swarm.agent_principals'),to_regclass('swarm.hosted_mcp_seats'))
   AND a.attnum>0 AND NOT a.attisdropped
), original_shape_diff AS (
 (SELECT * FROM original_expected EXCEPT SELECT * FROM original_actual)
 UNION ALL (SELECT * FROM original_actual EXCEPT SELECT * FROM original_expected)
), original_constraints(tab,definition) AS (VALUES
 ('agent_principals',$definition$PRIMARY KEY (principal_id)$definition$),
 ('agent_principals',$definition$FOREIGN KEY (workspace_id) REFERENCES swarm.workspaces(workspace_id)$definition$),
 ('agent_principals',$definition$FOREIGN KEY (parent_admin_grant_id) REFERENCES swarm.admin_grants(grant_id)$definition$),
 ('agent_principals',$definition$FOREIGN KEY (owner_user_id) REFERENCES swarm.users(user_id)$definition$),
 ('agent_principals',$definition$CHECK (((model IS NULL) OR ((model = btrim(model)) AND ((char_length(model) >= 1) AND (char_length(model) <= 120)) AND (model !~ '[[:cntrl:]]'::text))))$definition$),
 ('agent_principals',$definition$CHECK ((transport = ANY (ARRAY['local'::text, 'hosted_mcp'::text])))$definition$),
 ('agent_principals',$definition$CHECK (((transport <> 'hosted_mcp'::text) OR (turn_only = true)))$definition$),
 ('agent_principals',$definition$CHECK ((identity_lifetime = ANY (ARRAY['durable'::text, 'ephemeral'::text])))$definition$),
 ('hosted_mcp_seats',$definition$PRIMARY KEY (seat_id)$definition$),
 ('hosted_mcp_seats',$definition$UNIQUE (principal_id)$definition$),
 ('hosted_mcp_seats',$definition$UNIQUE (seat_id, grant_id, workspace_id, principal_id)$definition$),
 ('hosted_mcp_seats',$definition$FOREIGN KEY (grant_id, workspace_id, owner_user_id) REFERENCES swarm.hosted_mcp_grant_workspaces(grant_id, workspace_id, owner_user_id)$definition$),
 ('hosted_mcp_seats',$definition$FOREIGN KEY (principal_id, workspace_id, owner_user_id) REFERENCES swarm.agent_principals(principal_id, workspace_id, owner_user_id)$definition$),
 ('hosted_mcp_seats',$definition$CHECK ((((length(name) >= 1) AND (length(name) <= 80)) AND (name = btrim(name, ' '::text)) AND (name !~ '[[:cntrl:]]'::text)))$definition$),
 ('hosted_mcp_seats',$definition$CHECK (((display_name IS NULL) OR (((length(display_name) >= 1) AND (length(display_name) <= 80)) AND (display_name = btrim(display_name, ' '::text)) AND (display_name !~ '[[:cntrl:]]'::text))))$definition$),
 ('hosted_mcp_seats',$definition$CHECK (((disambiguator IS NULL) OR (disambiguator ~ '^[A-Z2-7]{4}$'::text)))$definition$)
), original_constraints_actual(tab,definition) AS (
 SELECT c.relname::text,pg_get_constraintdef(k.oid) FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid
 WHERE k.conrelid IN (to_regclass('swarm.agent_principals'),to_regclass('swarm.hosted_mcp_seats'))
), original_constraint_forms(tab,definition) AS (
 SELECT tab,regexp_replace(definition,'[[:space:]]','','g') FROM original_constraints
 UNION
 SELECT tab,replace(regexp_replace(definition,'[[:space:]]','','g'),b.nested,b.flat)
 FROM original_constraints CROSS JOIN bound_forms b
), original_constraints_diff AS (
 SELECT e.* FROM original_constraints e WHERE NOT EXISTS (
   SELECT 1 FROM original_constraints_actual a JOIN original_constraint_forms f
     ON f.tab=a.tab AND f.definition=regexp_replace(a.definition,'[[:space:]]','','g')
   WHERE a.tab=e.tab AND (f.definition=regexp_replace(e.definition,'[[:space:]]','','g')
     OR EXISTS(SELECT 1 FROM bound_forms b WHERE f.definition=replace(regexp_replace(e.definition,'[[:space:]]','','g'),b.nested,b.flat)))
 )
 UNION ALL
 SELECT a.* FROM original_constraints_actual a WHERE NOT EXISTS (
   SELECT 1 FROM original_constraint_forms f WHERE f.tab=a.tab
     AND f.definition=regexp_replace(a.definition,'[[:space:]]','','g')
 )
), incoming_expected(tab,definition) AS (VALUES
 ('hosted_mcp_seat_handles','FOREIGN KEY (seat_id, grant_id, workspace_id, principal_id) REFERENCES swarm.hosted_mcp_seats(seat_id, grant_id, workspace_id, principal_id)'),
 ('hosted_mcp_check_cursors','FOREIGN KEY (seat_id, grant_id, workspace_id, principal_id) REFERENCES swarm.hosted_mcp_seats(seat_id, grant_id, workspace_id, principal_id)'),
 ('hosted_mcp_check_batches','FOREIGN KEY (seat_id, grant_id, workspace_id, principal_id) REFERENCES swarm.hosted_mcp_seats(seat_id, grant_id, workspace_id, principal_id)'),
 ('hosted_agent_contexts','FOREIGN KEY (seat_id) REFERENCES swarm.hosted_mcp_seats(seat_id)')
), incoming_actual(tab,definition) AS (
 SELECT r.relname::text,pg_get_constraintdef(c.oid) FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid
 WHERE c.confrelid=to_regclass('swarm.hosted_mcp_seats') AND c.contype='f'
), incoming_diff AS (
 (SELECT * FROM incoming_expected EXCEPT ALL SELECT * FROM incoming_actual)
 UNION ALL (SELECT * FROM incoming_actual EXCEPT ALL SELECT * FROM incoming_expected)
), expected_function_acl(grantor,grantee,privilege,is_grantable) AS (
 SELECT a.grantor,a.grantee,a.privilege_type,a.is_grantable
 FROM aclexplode(acldefault('f',(SELECT oid FROM pg_roles WHERE rolname='swarm_admin'))) a
 WHERE a.grantee=(SELECT oid FROM pg_roles WHERE rolname='swarm_admin')
 UNION ALL SELECT (SELECT oid FROM pg_roles WHERE rolname='swarm_admin'),
   (SELECT oid FROM pg_roles WHERE rolname='swarm_command'),'EXECUTE',false
), actual_function_acl(grantor,grantee,privilege,is_grantable) AS (
 SELECT a.grantor,a.grantee,a.privilege_type,a.is_grantable FROM pg_proc p
 CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
 WHERE p.oid=to_regprocedure('swarm.hosted_predecessor_status(uuid)')
), function_acl_diff AS (
 (SELECT * FROM expected_function_acl EXCEPT ALL SELECT * FROM actual_function_acl)
 UNION ALL (SELECT * FROM actual_function_acl EXCEPT ALL SELECT * FROM expected_function_acl)
), checks(name,ok) AS (VALUES
 ('hosted_agent_contexts.owner_rls', COALESCE((EXISTS(SELECT 1 FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE c.oid=to_regclass('swarm.hosted_agent_contexts')
   AND c.relkind='r' AND c.relrowsecurity AND NOT c.relforcerowsecurity AND r.rolname='swarm_admin')),false)),
 ('hosted_agent_contexts.columns', COALESCE((NOT EXISTS(SELECT 1 FROM column_diff)),false)),
 ('hosted_agent_contexts.defaults', COALESCE((NOT EXISTS(SELECT 1 FROM pg_attrdef WHERE adrelid=to_regclass('swarm.hosted_agent_contexts'))),false)),
 ('proof_tables.column_acl', COALESCE((NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid IN (to_regclass('swarm.hosted_agent_contexts'),to_regclass('swarm.agent_principals'),to_regclass('swarm.hosted_mcp_seats'))
   AND attnum>0 AND NOT attisdropped AND attacl IS NOT NULL)),false)),
 ('proof_tables.named_constraints', COALESCE((NOT EXISTS(SELECT 1 FROM constraint_diff)),false)),
 ('hosted_agent_contexts.constraint_count', COALESCE(((SELECT count(*) FROM pg_constraint WHERE conrelid=to_regclass('swarm.hosted_agent_contexts'))=8),false)),
 ('hosted_agent_contexts.indexes', COALESCE((NOT EXISTS(SELECT 1 FROM index_diff)),false)),
 ('proof_tables.table_acl', COALESCE((NOT EXISTS(SELECT 1 FROM table_acl_diff)),false)),
 ('hosted_agent_contexts.policy_count', COALESCE(((SELECT count(*) FROM pg_policy WHERE polrelid=to_regclass('swarm.hosted_agent_contexts'))=1),false)),
 ('hosted_agent_contexts.policy', COALESCE((EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=to_regclass('swarm.hosted_agent_contexts') AND polname='swarm_command_all'
   AND polcmd='*' AND polpermissive AND polroles=ARRAY[(SELECT oid FROM pg_roles WHERE rolname='swarm_command')]
   AND pg_get_expr(polqual,polrelid)='true' AND pg_get_expr(polwithcheck,polrelid)='true')),false)),
 ('agent_principals.identity_lifetime', COALESCE((EXISTS(SELECT 1 FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
   WHERE a.attrelid=to_regclass('swarm.agent_principals') AND a.attname='identity_lifetime' AND a.attnotnull
   AND format_type(a.atttypid,a.atttypmod)='text' AND pg_get_expr(d.adbin,d.adrelid)='''durable''::text')),false)),
 ('hosted_mcp_seats.display_columns', COALESCE(((SELECT count(*) FROM pg_attribute WHERE attrelid=to_regclass('swarm.hosted_mcp_seats') AND attname IN ('display_name','disambiguator')
   AND format_type(atttypid,atttypmod)='text' AND NOT attnotnull AND NOT attisdropped AND NOT atthasdef)=2),false)),
 ('hosted_mcp_seats_live_name', COALESCE(((SELECT pg_get_indexdef(indexrelid) FROM pg_index WHERE indexrelid=to_regclass('swarm.hosted_mcp_seats_live_name'))=
   'CREATE UNIQUE INDEX hosted_mcp_seats_live_name ON swarm.hosted_mcp_seats USING btree (workspace_id, name) WHERE (revoked_at IS NULL)'),false)),
 ('hosted_mcp_seats_workspace_name', COALESCE(((SELECT pg_get_indexdef(indexrelid) FROM pg_index WHERE indexrelid=to_regclass('swarm.hosted_mcp_seats_workspace_name'))=
   'CREATE INDEX hosted_mcp_seats_workspace_name ON swarm.hosted_mcp_seats USING btree (workspace_id, name)'
),false)),
 -- Incoming legacy/check FKs retain the original four-column grant binding.
 ('hosted_mcp_seats.incoming_fks', COALESCE((NOT EXISTS(SELECT 1 FROM incoming_diff)),false)),
 ('hosted_mcp_seats.incoming_fk_options', COALESCE((NOT EXISTS(SELECT 1 FROM pg_constraint c WHERE c.confrelid=to_regclass('swarm.hosted_mcp_seats') AND c.contype='f'
   AND (c.confupdtype<>'a' OR c.confdeltype<>'a' OR c.confmatchtype<>'s' OR c.condeferrable OR c.condeferred OR NOT c.convalidated))),false)),
 ('original_tables.columns_defaults', COALESCE((NOT EXISTS(SELECT 1 FROM original_shape_diff)),false)),
 ('original_tables.constraints', COALESCE((NOT EXISTS(SELECT 1 FROM original_constraints_diff)
   AND (SELECT count(*) FROM original_constraints_actual)=(SELECT count(*) FROM original_constraints)),false)),
 ('original_tables.constraint_options', COALESCE((NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid IN (to_regclass('swarm.agent_principals'),to_regclass('swarm.hosted_mcp_seats'))
   AND (NOT convalidated OR condeferrable OR condeferred))),false)),
 ('original_tables.owner_rls', COALESCE(((SELECT count(*) FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner
   WHERE c.oid IN (to_regclass('swarm.agent_principals'),to_regclass('swarm.hosted_mcp_seats'))
     AND c.relkind='r' AND c.relrowsecurity AND NOT c.relforcerowsecurity AND r.rolname='swarm_admin')=2),false)),
 ('original_tables.policy_count', COALESCE(((SELECT count(*) FROM pg_policy WHERE polrelid IN (to_regclass('swarm.agent_principals'),to_regclass('swarm.hosted_mcp_seats')))=2),false)),
 ('original_tables.policies', COALESCE((NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid IN (to_regclass('swarm.agent_principals'),to_regclass('swarm.hosted_mcp_seats'))
   AND (polname<>'swarm_command_all' OR polcmd<>'*' OR NOT polpermissive
     OR polroles<>ARRAY[(SELECT oid FROM pg_roles WHERE rolname='swarm_command')]
     OR pg_get_expr(polqual,polrelid)<>'true' OR pg_get_expr(polwithcheck,polrelid)<>'true'))),false)),
 ('hosted_agent_contexts.index_owners', COALESCE(((SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
   WHERE i.indrelid=to_regclass('swarm.hosted_agent_contexts') AND c.relowner=(SELECT oid FROM pg_roles WHERE rolname='swarm_admin'))=6),false)),
 ('config.hosted_context_allocation_enabled', COALESCE((EXISTS(SELECT 1 FROM swarm.config WHERE key='hosted_context_allocation_enabled' AND value='false'::jsonb)),false)),
 ('hosted_agent_contexts_clocks_check', COALESCE((EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('swarm.hosted_agent_contexts')
   AND conname='hosted_agent_contexts_clocks_check' AND convalidated AND NOT condeferrable
   AND regexp_replace(pg_get_expr(conbin,conrelid),'[[:space:]]','','g')=
       regexp_replace($clock$((last_business_at >= created_at) AND ((idle_expires_at IS NULL) OR (idle_expires_at > last_business_at)) AND ((absolute_expires_at IS NULL) OR (absolute_expires_at > created_at)) AND ((closed_at IS NULL) OR (closed_at >= created_at)) AND (((closed_at IS NULL) AND (close_reason IS NULL)) OR ((closed_at IS NOT NULL) AND (close_reason IS NOT NULL))) AND (((origin = 'legacy'::text) AND (idle_expires_at IS NULL) AND (absolute_expires_at IS NULL)) OR ((origin <> 'legacy'::text) AND (idle_expires_at IS NOT NULL) AND (absolute_expires_at IS NOT NULL))))$clock$,'[[:space:]]','','g'))),false)),
 ('hosted_predecessor_status.function_acl', COALESCE((EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner JOIN pg_language l ON l.oid=p.prolang
   WHERE p.oid=to_regprocedure('swarm.hosted_predecessor_status(uuid)') AND r.rolname='swarm_admin' AND p.prosecdef
   AND p.provolatile='s' AND l.lanname='sql' AND p.proconfig=ARRAY['search_path=pg_catalog']
   AND p.prosrc=$body$
  SELECT g.grant_id, g.owner_user_id, g.client_id,
    (g.state='revoked' OR g.revoked_at IS NOT NULL OR t.grant_id IS NOT NULL) AS revoked,
    a.expires_at AS provider_expires_at,
    (g.state='revoked' OR g.revoked_at IS NOT NULL OR t.grant_id IS NOT NULL
      OR (a.expires_at IS NOT NULL AND a.expires_at <= statement_timestamp())) AS predecessor_unavailable
  FROM swarm.hosted_mcp_grants g
  LEFT JOIN commonswarm_oauth.refresh_family_tombstones t ON t.grant_id=g.provider_grant_id
  LEFT JOIN commonswarm_oauth.provider_artifacts a
    ON a.model='Grant'
    AND a.artifact_id_hash=rtrim(translate(encode(sha256(convert_to(g.provider_grant_id, 'UTF8')), 'base64'), '+/', '-_'), '=')
    AND a.payload->>'accountId'=g.owner_user_id::text
    AND a.payload->>'clientId'=g.client_id
  WHERE g.grant_id=p_grant_id
$body$
   AND regexp_replace(pg_get_functiondef(p.oid),'[[:space:];]','','g')=regexp_replace($expected$CREATE OR REPLACE FUNCTION swarm.hosted_predecessor_status(p_grant_id uuid) RETURNS TABLE(grant_id uuid, owner_user_id uuid, client_id text, revoked boolean, provider_expires_at timestamp with time zone, predecessor_unavailable boolean) LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'pg_catalog' AS $function$
  SELECT g.grant_id, g.owner_user_id, g.client_id,
    (g.state='revoked' OR g.revoked_at IS NOT NULL OR t.grant_id IS NOT NULL) AS revoked,
    a.expires_at AS provider_expires_at,
    (g.state='revoked' OR g.revoked_at IS NOT NULL OR t.grant_id IS NOT NULL
      OR (a.expires_at IS NOT NULL AND a.expires_at <= statement_timestamp())) AS predecessor_unavailable
  FROM swarm.hosted_mcp_grants g
  LEFT JOIN commonswarm_oauth.refresh_family_tombstones t ON t.grant_id=g.provider_grant_id
  LEFT JOIN commonswarm_oauth.provider_artifacts a
    ON a.model='Grant'
    AND a.artifact_id_hash=rtrim(translate(encode(sha256(convert_to(g.provider_grant_id, 'UTF8')), 'base64'), '+/', '-_'), '=')
    AND a.payload->>'accountId'=g.owner_user_id::text
    AND a.payload->>'clientId'=g.client_id
  WHERE g.grant_id=p_grant_id
$function$$expected$,'[[:space:];]','','g')
   AND NOT EXISTS (SELECT 1 FROM function_acl_diff)
 )),false))
)
SELECT COALESCE((SELECT bool_and(ok) FROM checks),false) AS catalog_ok
\gset
