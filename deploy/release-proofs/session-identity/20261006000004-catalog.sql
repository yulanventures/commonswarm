-- Phase-3 migration-time proof only. Missing objects yield false.
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
 ('hosted_agent_contexts','hosted_contexts_identity','UNIQUE (context_id, seat_id)'),
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
 ('CREATE UNIQUE INDEX hosted_contexts_identity ON swarm.hosted_agent_contexts USING btree (context_id, seat_id)'),
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
 -- pg_get_expr omits the schema only when this exact extension function is
 -- visible. Preserve the exact function, arguments and PostgreSQL text casts.
 ('agent_principals','wake_id','text',true,
   CASE WHEN pg_function_is_visible(to_regprocedure('extensions.gen_random_bytes(integer)'))
   THEN $default$translate(encode(gen_random_bytes(32), 'base64'::text), '+/='::text, '-_'::text)$default$
   ELSE $default$translate(encode(extensions.gen_random_bytes(32), 'base64'::text), '+/='::text, '-_'::text)$default$ END),
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
 ('hosted_mcp_seats',$definition$UNIQUE (seat_id, workspace_id, principal_id)$definition$),
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
 ('hosted_mcp_seat_handles','FOREIGN KEY (seat_id, workspace_id, principal_id) REFERENCES swarm.hosted_mcp_seats(seat_id, workspace_id, principal_id)'),
 ('hosted_mcp_check_cursors','FOREIGN KEY (seat_id, workspace_id, principal_id) REFERENCES swarm.hosted_mcp_seats(seat_id, workspace_id, principal_id)'),
 ('hosted_mcp_check_batches','FOREIGN KEY (seat_id, workspace_id, principal_id) REFERENCES swarm.hosted_mcp_seats(seat_id, workspace_id, principal_id)'),
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
 ('hosted_agent_contexts.constraint_count', COALESCE(((SELECT count(*) FROM pg_constraint WHERE conrelid=to_regclass('swarm.hosted_agent_contexts'))=9),false)),
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
   WHERE i.indrelid=to_regclass('swarm.hosted_agent_contexts') AND c.relowner=(SELECT oid FROM pg_roles WHERE rolname='swarm_admin'))=7),false)),
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
), lifecycle_checks(name,ok) AS (VALUES
 ('swarm.hosted_mcp_check_cursors_guard()',COALESCE((EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles r ON r.oid=p.proowner JOIN pg_catalog.pg_language l ON l.oid=p.prolang
   WHERE p.oid=to_regprocedure('swarm.hosted_mcp_check_cursors_guard()') AND r.rolname='swarm_admin' AND l.lanname='plpgsql' AND p.prosecdef=false
     AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND p.provolatile='v' AND p.prokind='f'
     AND NOT p.proisstrict AND NOT p.proleakproof AND p.proparallel='u' AND p.prosupport=0 AND p.procost=100
     AND pg_get_function_result(p.oid)='trigger' AND pg_get_function_identity_arguments(p.oid)=''
     AND p.prosrc='
BEGIN
  IF TG_OP = ''DELETE'' THEN
    RAISE EXCEPTION ''SWARM_HOSTED_CHECK_CURSOR_IMMUTABLE'' USING ERRCODE = ''55000'';
  END IF;
  IF TG_OP = ''INSERT'' THEN
    IF NOT EXISTS(SELECT 1 FROM swarm.hosted_mcp_seats s WHERE s.seat_id=NEW.seat_id AND s.grant_id=NEW.grant_id AND s.workspace_id=NEW.workspace_id AND s.principal_id=NEW.principal_id) THEN RAISE EXCEPTION ''SWARM_HOSTED_CHECK_CURSOR_INVALID'' USING ERRCODE=''23514''; END IF;
    IF NEW.cursor_created_at IS NOT NULL OR NEW.cursor_signal_id IS NOT NULL THEN
      RAISE EXCEPTION ''SWARM_HOSTED_CHECK_CURSOR_INVALID'' USING ERRCODE = ''23514'';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.seat_id IS DISTINCT FROM OLD.seat_id
     OR NEW.grant_id IS DISTINCT FROM OLD.grant_id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.principal_id IS DISTINCT FROM OLD.principal_id
     OR (OLD.cursor_created_at IS NOT NULL AND NEW.cursor_created_at IS NULL)
     OR (OLD.cursor_created_at IS NOT NULL AND
       (NEW.cursor_created_at, NEW.cursor_signal_id) <=
       (OLD.cursor_created_at, OLD.cursor_signal_id))
     OR (NEW.cursor_created_at IS NOT NULL AND NOT EXISTS (
       SELECT 1
       FROM swarm.hosted_mcp_check_batches AS b
       WHERE b.seat_id = NEW.seat_id
         AND b.workspace_id = NEW.workspace_id
         AND b.principal_id = NEW.principal_id
         AND b.terminal_created_at = NEW.cursor_created_at
         AND b.terminal_signal_id = NEW.cursor_signal_id
         AND b.acknowledged_at IS NOT NULL
     ))
  THEN
    RAISE EXCEPTION ''SWARM_HOSTED_CHECK_CURSOR_IMMUTABLE'' USING ERRCODE = ''55000'';
  END IF;
  RETURN NEW;
END
'
     AND regexp_replace(upper(pg_get_functiondef(p.oid)),'[[:space:];]','','g')=regexp_replace(upper('CREATE OR REPLACE FUNCTION swarm.hosted_mcp_check_cursors_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''pg_catalog''
AS $function$
BEGIN
  IF TG_OP = ''DELETE'' THEN
    RAISE EXCEPTION ''SWARM_HOSTED_CHECK_CURSOR_IMMUTABLE'' USING ERRCODE = ''55000'';
  END IF;
  IF TG_OP = ''INSERT'' THEN
    IF NOT EXISTS(SELECT 1 FROM swarm.hosted_mcp_seats s WHERE s.seat_id=NEW.seat_id AND s.grant_id=NEW.grant_id AND s.workspace_id=NEW.workspace_id AND s.principal_id=NEW.principal_id) THEN RAISE EXCEPTION ''SWARM_HOSTED_CHECK_CURSOR_INVALID'' USING ERRCODE=''23514''; END IF;
    IF NEW.cursor_created_at IS NOT NULL OR NEW.cursor_signal_id IS NOT NULL THEN
      RAISE EXCEPTION ''SWARM_HOSTED_CHECK_CURSOR_INVALID'' USING ERRCODE = ''23514'';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.seat_id IS DISTINCT FROM OLD.seat_id
     OR NEW.grant_id IS DISTINCT FROM OLD.grant_id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.principal_id IS DISTINCT FROM OLD.principal_id
     OR (OLD.cursor_created_at IS NOT NULL AND NEW.cursor_created_at IS NULL)
     OR (OLD.cursor_created_at IS NOT NULL AND
       (NEW.cursor_created_at, NEW.cursor_signal_id) <=
       (OLD.cursor_created_at, OLD.cursor_signal_id))
     OR (NEW.cursor_created_at IS NOT NULL AND NOT EXISTS (
       SELECT 1
       FROM swarm.hosted_mcp_check_batches AS b
       WHERE b.seat_id = NEW.seat_id
         AND b.workspace_id = NEW.workspace_id
         AND b.principal_id = NEW.principal_id
         AND b.terminal_created_at = NEW.cursor_created_at
         AND b.terminal_signal_id = NEW.cursor_signal_id
         AND b.acknowledged_at IS NOT NULL
     ))
  THEN
    RAISE EXCEPTION ''SWARM_HOSTED_CHECK_CURSOR_IMMUTABLE'' USING ERRCODE = ''55000'';
  END IF;
  RETURN NEW;
END
$function$;'),'[[:space:];]','','g')
     AND (SELECT array_agg(pg_get_userbyid(a.grantee)||':'||a.privilege_type||':'||pg_get_userbyid(a.grantor)||':'||a.is_grantable::text ORDER BY pg_get_userbyid(a.grantee)||':'||a.privilege_type||':'||pg_get_userbyid(a.grantor)||':'||a.is_grantable::text)
       FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a)='{swarm_admin:EXECUTE:swarm_admin:false}'::text[])),false)),
 ('swarm.hosted_mcp_check_batches_guard()',COALESCE((EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles r ON r.oid=p.proowner JOIN pg_catalog.pg_language l ON l.oid=p.prolang
   WHERE p.oid=to_regprocedure('swarm.hosted_mcp_check_batches_guard()') AND r.rolname='swarm_admin' AND l.lanname='plpgsql' AND p.prosecdef=false
     AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND p.provolatile='v' AND p.prokind='f'
     AND NOT p.proisstrict AND NOT p.proleakproof AND p.proparallel='u' AND p.prosupport=0 AND p.procost=100
     AND pg_get_function_result(p.oid)='trigger' AND pg_get_function_identity_arguments(p.oid)=''
     AND p.prosrc='
DECLARE
  v_ordered_ids uuid[];
  v_terminal_created_at timestamptz;
BEGIN
  IF TG_OP = ''DELETE'' THEN
    RAISE EXCEPTION ''SWARM_HOSTED_CHECK_BATCH_IMMUTABLE'' USING ERRCODE = ''55000'';
  END IF;
  IF TG_OP = ''INSERT'' THEN
    IF NOT EXISTS(SELECT 1 FROM swarm.hosted_mcp_seats s WHERE s.seat_id=NEW.seat_id AND s.grant_id=NEW.grant_id AND s.workspace_id=NEW.workspace_id AND s.principal_id=NEW.principal_id) THEN RAISE EXCEPTION ''SWARM_HOSTED_CHECK_BATCH_INVALID'' USING ERRCODE=''23514''; END IF;
    IF NEW.acknowledged_at IS NOT NULL OR NEW.cancelled_at IS NOT NULL THEN
      RAISE EXCEPTION ''SWARM_HOSTED_CHECK_BATCH_INVALID'' USING ERRCODE = ''23514'';
    END IF;
    SELECT array_agg(s.id ORDER BY date_trunc(''milliseconds'', s.created_at), s.id),
           max(date_trunc(''milliseconds'', s.created_at)) FILTER (
             WHERE s.id = NEW.terminal_signal_id
           )
    INTO v_ordered_ids, v_terminal_created_at
    FROM unnest(NEW.signal_ids) AS requested(signal_id)
    JOIN swarm.signals AS s ON s.id = requested.signal_id
    WHERE s.workspace_id = NEW.workspace_id
      AND (
        s.to_agent_principal_id = NEW.principal_id
        OR EXISTS (
          SELECT 1
          FROM swarm.signal_recipients AS recipient
          WHERE recipient.workspace_id = s.workspace_id
            AND recipient.signal_id = s.id
            AND recipient.recipient_agent_principal_id = NEW.principal_id
        )
      );
    IF v_ordered_ids IS DISTINCT FROM NEW.signal_ids
       OR cardinality(v_ordered_ids) <> cardinality(NEW.signal_ids)
       OR (SELECT count(DISTINCT signal_id)
           FROM unnest(NEW.signal_ids) AS distinct_ids(signal_id)) <>
          cardinality(NEW.signal_ids)
       OR v_terminal_created_at IS DISTINCT FROM NEW.terminal_created_at
    THEN
      RAISE EXCEPTION ''SWARM_HOSTED_CHECK_BATCH_INVALID'' USING ERRCODE = ''23514'';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.context_id IS NULL AND NEW.context_id IS NOT NULL
    AND (to_jsonb(NEW)-''context_id'')=(to_jsonb(OLD)-''context_id'')
    AND EXISTS(SELECT 1 FROM swarm.hosted_agent_contexts c
      JOIN swarm.hosted_mcp_seat_handles h ON h.handle=c.handle AND h.seat_id=c.seat_id
      WHERE c.context_id=NEW.context_id AND c.origin=''legacy'' AND c.seat_id=OLD.seat_id
        AND h.grant_id=OLD.grant_id AND h.workspace_id=OLD.workspace_id AND h.principal_id=OLD.principal_id) THEN
    RETURN NEW;
  END IF;
  IF NEW.context_id IS DISTINCT FROM OLD.context_id THEN
    RAISE EXCEPTION ''SWARM_HOSTED_CHECK_BATCH_IMMUTABLE'' USING ERRCODE=''55000'';
  END IF;
  IF NEW.cancelled_at IS NOT NULL AND OLD.cancelled_at IS NULL
     AND OLD.acknowledged_at IS NULL AND NEW.acknowledged_at IS NULL
     AND EXISTS (SELECT 1 FROM swarm.hosted_agent_contexts c
       WHERE c.context_id=NEW.context_id AND c.seat_id=NEW.seat_id
         AND c.closed_at=NEW.cancelled_at AND c.close_reason=NEW.cancel_reason)
     AND (to_jsonb(NEW)-ARRAY[''cancelled_at'',''cancel_reason'']) = (to_jsonb(OLD)-ARRAY[''cancelled_at'',''cancel_reason'']) THEN
    RETURN NEW;
  END IF;
  IF OLD.cancelled_at IS NOT NULL OR NEW.cancelled_at IS NOT NULL OR NEW.cancel_reason IS NOT NULL THEN
    RAISE EXCEPTION ''SWARM_HOSTED_CHECK_BATCH_IMMUTABLE'' USING ERRCODE=''55000'';
  END IF;
  IF NEW.batch_id IS DISTINCT FROM OLD.batch_id
     OR NEW.seat_id IS DISTINCT FROM OLD.seat_id
     OR NEW.grant_id IS DISTINCT FROM OLD.grant_id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.principal_id IS DISTINCT FROM OLD.principal_id
     OR NEW.signal_ids IS DISTINCT FROM OLD.signal_ids
     OR NEW.terminal_created_at IS DISTINCT FROM OLD.terminal_created_at
     OR NEW.terminal_signal_id IS DISTINCT FROM OLD.terminal_signal_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR OLD.acknowledged_at IS NOT NULL
     OR NEW.acknowledged_at IS NULL
  THEN
    RAISE EXCEPTION ''SWARM_HOSTED_CHECK_BATCH_IMMUTABLE'' USING ERRCODE = ''55000'';
  END IF;
  RETURN NEW;
END
'
     AND regexp_replace(upper(pg_get_functiondef(p.oid)),'[[:space:];]','','g')=regexp_replace(upper('CREATE OR REPLACE FUNCTION swarm.hosted_mcp_check_batches_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''pg_catalog''
AS $function$
DECLARE
  v_ordered_ids uuid[];
  v_terminal_created_at timestamptz;
BEGIN
  IF TG_OP = ''DELETE'' THEN
    RAISE EXCEPTION ''SWARM_HOSTED_CHECK_BATCH_IMMUTABLE'' USING ERRCODE = ''55000'';
  END IF;
  IF TG_OP = ''INSERT'' THEN
    IF NOT EXISTS(SELECT 1 FROM swarm.hosted_mcp_seats s WHERE s.seat_id=NEW.seat_id AND s.grant_id=NEW.grant_id AND s.workspace_id=NEW.workspace_id AND s.principal_id=NEW.principal_id) THEN RAISE EXCEPTION ''SWARM_HOSTED_CHECK_BATCH_INVALID'' USING ERRCODE=''23514''; END IF;
    IF NEW.acknowledged_at IS NOT NULL OR NEW.cancelled_at IS NOT NULL THEN
      RAISE EXCEPTION ''SWARM_HOSTED_CHECK_BATCH_INVALID'' USING ERRCODE = ''23514'';
    END IF;
    SELECT array_agg(s.id ORDER BY date_trunc(''milliseconds'', s.created_at), s.id),
           max(date_trunc(''milliseconds'', s.created_at)) FILTER (
             WHERE s.id = NEW.terminal_signal_id
           )
    INTO v_ordered_ids, v_terminal_created_at
    FROM unnest(NEW.signal_ids) AS requested(signal_id)
    JOIN swarm.signals AS s ON s.id = requested.signal_id
    WHERE s.workspace_id = NEW.workspace_id
      AND (
        s.to_agent_principal_id = NEW.principal_id
        OR EXISTS (
          SELECT 1
          FROM swarm.signal_recipients AS recipient
          WHERE recipient.workspace_id = s.workspace_id
            AND recipient.signal_id = s.id
            AND recipient.recipient_agent_principal_id = NEW.principal_id
        )
      );
    IF v_ordered_ids IS DISTINCT FROM NEW.signal_ids
       OR cardinality(v_ordered_ids) <> cardinality(NEW.signal_ids)
       OR (SELECT count(DISTINCT signal_id)
           FROM unnest(NEW.signal_ids) AS distinct_ids(signal_id)) <>
          cardinality(NEW.signal_ids)
       OR v_terminal_created_at IS DISTINCT FROM NEW.terminal_created_at
    THEN
      RAISE EXCEPTION ''SWARM_HOSTED_CHECK_BATCH_INVALID'' USING ERRCODE = ''23514'';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.context_id IS NULL AND NEW.context_id IS NOT NULL
    AND (to_jsonb(NEW)-''context_id'')=(to_jsonb(OLD)-''context_id'')
    AND EXISTS(SELECT 1 FROM swarm.hosted_agent_contexts c
      JOIN swarm.hosted_mcp_seat_handles h ON h.handle=c.handle AND h.seat_id=c.seat_id
      WHERE c.context_id=NEW.context_id AND c.origin=''legacy'' AND c.seat_id=OLD.seat_id
        AND h.grant_id=OLD.grant_id AND h.workspace_id=OLD.workspace_id AND h.principal_id=OLD.principal_id) THEN
    RETURN NEW;
  END IF;
  IF NEW.context_id IS DISTINCT FROM OLD.context_id THEN
    RAISE EXCEPTION ''SWARM_HOSTED_CHECK_BATCH_IMMUTABLE'' USING ERRCODE=''55000'';
  END IF;
  IF NEW.cancelled_at IS NOT NULL AND OLD.cancelled_at IS NULL
     AND OLD.acknowledged_at IS NULL AND NEW.acknowledged_at IS NULL
     AND EXISTS (SELECT 1 FROM swarm.hosted_agent_contexts c
       WHERE c.context_id=NEW.context_id AND c.seat_id=NEW.seat_id
         AND c.closed_at=NEW.cancelled_at AND c.close_reason=NEW.cancel_reason)
     AND (to_jsonb(NEW)-ARRAY[''cancelled_at'',''cancel_reason'']) = (to_jsonb(OLD)-ARRAY[''cancelled_at'',''cancel_reason'']) THEN
    RETURN NEW;
  END IF;
  IF OLD.cancelled_at IS NOT NULL OR NEW.cancelled_at IS NOT NULL OR NEW.cancel_reason IS NOT NULL THEN
    RAISE EXCEPTION ''SWARM_HOSTED_CHECK_BATCH_IMMUTABLE'' USING ERRCODE=''55000'';
  END IF;
  IF NEW.batch_id IS DISTINCT FROM OLD.batch_id
     OR NEW.seat_id IS DISTINCT FROM OLD.seat_id
     OR NEW.grant_id IS DISTINCT FROM OLD.grant_id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.principal_id IS DISTINCT FROM OLD.principal_id
     OR NEW.signal_ids IS DISTINCT FROM OLD.signal_ids
     OR NEW.terminal_created_at IS DISTINCT FROM OLD.terminal_created_at
     OR NEW.terminal_signal_id IS DISTINCT FROM OLD.terminal_signal_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR OLD.acknowledged_at IS NOT NULL
     OR NEW.acknowledged_at IS NULL
  THEN
    RAISE EXCEPTION ''SWARM_HOSTED_CHECK_BATCH_IMMUTABLE'' USING ERRCODE = ''55000'';
  END IF;
  RETURN NEW;
END
$function$;'),'[[:space:];]','','g')
     AND (SELECT array_agg(pg_get_userbyid(a.grantee)||':'||a.privilege_type||':'||pg_get_userbyid(a.grantor)||':'||a.is_grantable::text ORDER BY pg_get_userbyid(a.grantee)||':'||a.privilege_type||':'||pg_get_userbyid(a.grantor)||':'||a.is_grantable::text)
       FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a)='{swarm_admin:EXECUTE:swarm_admin:false}'::text[])),false)),
 ('swarm.hosted_legacy_handle_guard()',COALESCE((EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles r ON r.oid=p.proowner JOIN pg_catalog.pg_language l ON l.oid=p.prolang
   WHERE p.oid=to_regprocedure('swarm.hosted_legacy_handle_guard()') AND r.rolname='swarm_admin' AND l.lanname='plpgsql' AND p.prosecdef=false
     AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND p.provolatile='v' AND p.prokind='f'
     AND NOT p.proisstrict AND NOT p.proleakproof AND p.proparallel='u' AND p.prosupport=0 AND p.procost=100
     AND pg_get_function_result(p.oid)='trigger' AND pg_get_function_identity_arguments(p.oid)=''
     AND p.prosrc='
BEGIN
  IF TG_OP=''INSERT'' THEN
    IF NOT EXISTS(SELECT 1 FROM swarm.hosted_mcp_seats s WHERE s.seat_id=NEW.seat_id AND s.grant_id=NEW.grant_id AND s.workspace_id=NEW.workspace_id AND s.principal_id=NEW.principal_id) THEN RAISE EXCEPTION ''SWARM_HOSTED_HANDLE_INVALID'' USING ERRCODE=''23514''; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP=''DELETE'' OR (to_jsonb(NEW)-''revoked_at'') IS DISTINCT FROM (to_jsonb(OLD)-''revoked_at'')
     OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION ''SWARM_HOSTED_HANDLE_IMMUTABLE'' USING ERRCODE=''55000'';
  END IF;
  RETURN NEW;
END
'
     AND regexp_replace(upper(pg_get_functiondef(p.oid)),'[[:space:];]','','g')=regexp_replace(upper('CREATE OR REPLACE FUNCTION swarm.hosted_legacy_handle_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''pg_catalog''
AS $function$
BEGIN
  IF TG_OP=''INSERT'' THEN
    IF NOT EXISTS(SELECT 1 FROM swarm.hosted_mcp_seats s WHERE s.seat_id=NEW.seat_id AND s.grant_id=NEW.grant_id AND s.workspace_id=NEW.workspace_id AND s.principal_id=NEW.principal_id) THEN RAISE EXCEPTION ''SWARM_HOSTED_HANDLE_INVALID'' USING ERRCODE=''23514''; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP=''DELETE'' OR (to_jsonb(NEW)-''revoked_at'') IS DISTINCT FROM (to_jsonb(OLD)-''revoked_at'')
     OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION ''SWARM_HOSTED_HANDLE_IMMUTABLE'' USING ERRCODE=''55000'';
  END IF;
  RETURN NEW;
END
$function$;'),'[[:space:];]','','g')
     AND (SELECT array_agg(pg_get_userbyid(a.grantee)||':'||a.privilege_type||':'||pg_get_userbyid(a.grantor)||':'||a.is_grantable::text ORDER BY pg_get_userbyid(a.grantee)||':'||a.privilege_type||':'||pg_get_userbyid(a.grantor)||':'||a.is_grantable::text)
       FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a)='{swarm_admin:EXECUTE:swarm_admin:false}'::text[])),false)),
 ('swarm.hosted_context_interval(text)',COALESCE((EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles r ON r.oid=p.proowner JOIN pg_catalog.pg_language l ON l.oid=p.prolang
   WHERE p.oid=to_regprocedure('swarm.hosted_context_interval(text)') AND r.rolname='swarm_admin' AND l.lanname='sql' AND p.prosecdef=true
     AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND p.provolatile='i' AND p.prokind='f'
     AND NOT p.proisstrict AND NOT p.proleakproof AND p.proparallel='u' AND p.prosupport=0 AND p.procost=100
     AND pg_get_function_result(p.oid)='interval' AND pg_get_function_identity_arguments(p.oid)='p_kind text'
     AND p.prosrc='
SELECT CASE p_kind WHEN ''chat'' THEN interval ''24 hours'' WHEN ''task'' THEN interval ''12 hours'' WHEN ''scheduled'' THEN interval ''30 minutes'' WHEN ''subagent'' THEN interval ''15 minutes'' END
'
     AND regexp_replace(upper(pg_get_functiondef(p.oid)),'[[:space:];]','','g')=regexp_replace(upper('CREATE OR REPLACE FUNCTION swarm.hosted_context_interval(p_kind text)
RETURNS interval
LANGUAGE sql IMMUTABLE SECURITY DEFINER
SET search_path TO ''pg_catalog''
AS $function$
SELECT CASE p_kind WHEN ''chat'' THEN interval ''24 hours'' WHEN ''task'' THEN interval ''12 hours'' WHEN ''scheduled'' THEN interval ''30 minutes'' WHEN ''subagent'' THEN interval ''15 minutes'' END
$function$;'),'[[:space:];]','','g')
     AND (SELECT array_agg(pg_get_userbyid(a.grantee)||':'||a.privilege_type||':'||pg_get_userbyid(a.grantor)||':'||a.is_grantable::text ORDER BY pg_get_userbyid(a.grantee)||':'||a.privilege_type||':'||pg_get_userbyid(a.grantor)||':'||a.is_grantable::text)
       FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a)='{swarm_admin:EXECUTE:swarm_admin:false}'::text[])),false)),
 ('swarm.resolve_hosted_context(uuid, text, text, text)',COALESCE((EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles r ON r.oid=p.proowner JOIN pg_catalog.pg_language l ON l.oid=p.prolang
   WHERE p.oid=to_regprocedure('swarm.resolve_hosted_context(uuid, text, text, text)') AND r.rolname='swarm_admin' AND l.lanname='plpgsql' AND p.prosecdef=true
     AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND p.provolatile='v' AND p.prokind='f'
     AND NOT p.proisstrict AND NOT p.proleakproof AND p.proparallel='u' AND p.prosupport=0 AND p.procost=100
     AND pg_get_function_result(p.oid)='jsonb' AND pg_get_function_identity_arguments(p.oid)='p_grant_id uuid, p_handle text, p_tool text, p_use text'
     AND p.prosrc='
DECLARE
  v_stream uuid;
  v_context uuid;
  v_now timestamptz;
  v_result jsonb;
BEGIN
  IF NOT ((p_use=''command'' AND p_tool IN (''ask'',''note'',''reply'',''working_on'',''check'',''close_session'')) OR
          (p_use=''read'' AND p_tool IN (''whoami'',''members'',''check''))) THEN RETURN NULL; END IF;
  PERFORM pg_advisory_xact_lock_shared(1936142700, hashtext(''hosted-context-allocation''));
  SELECT st.stream_id,c.context_id INTO v_stream,v_context
    FROM swarm.hosted_agent_contexts c JOIN swarm.hosted_mcp_seats hs USING(seat_id)
    JOIN swarm.streams st ON st.workspace_id=hs.workspace_id AND st.kind=''workspace''
    WHERE c.handle=p_handle AND hs.grant_id=p_grant_id;
  IF v_stream IS NULL THEN RETURN NULL; END IF;
  PERFORM 1 FROM swarm.streams WHERE stream_id=v_stream FOR UPDATE;
  PERFORM 1 FROM swarm.hosted_agent_contexts WHERE context_id=v_context FOR UPDATE;
  v_now := clock_timestamp();
  SELECT jsonb_build_object(''grant_id'',g.grant_id,''provider_grant_id'',g.provider_grant_id,
    ''client_id'',g.client_id,''seat_id'',hs.seat_id,''seat'',c.handle,''handle'',c.handle,
    ''workspace_id'',hs.workspace_id,''workspace'',jsonb_build_object(''id'',w.workspace_id,''name'',w.name),
    ''stream_id'',st.stream_id,''owner_user_id'',g.owner_user_id,''principal_id'',hs.principal_id,
    ''context_id'',c.context_id,''name'',hs.name,''display_name'',COALESCE(hs.display_name,hs.name),
    ''disambiguator'',hs.disambiguator,''lifetime'',p.identity_lifetime,''kind'',c.kind,''origin'',c.origin,
    ''assurance'',''portable'',''created_at'',c.created_at,''last_business_at'',c.last_business_at,
    ''idle_expires_at'',c.idle_expires_at,''absolute_expires_at'',c.absolute_expires_at,
    ''closed_at'',c.closed_at,''close_reason'',c.close_reason,''database_now'',v_now,
    ''context_error'',CASE WHEN c.close_reason=''expired'' THEN ''context_expired'' WHEN c.closed_at IS NOT NULL THEN ''context_closed''
      WHEN c.idle_expires_at<=v_now OR c.absolute_expires_at<=v_now THEN ''context_expired'' ELSE NULL END)
    INTO v_result
    FROM swarm.hosted_agent_contexts c JOIN swarm.hosted_mcp_seats hs USING(seat_id)
    JOIN swarm.hosted_mcp_grants g ON g.grant_id=hs.grant_id
    JOIN swarm.hosted_mcp_grant_workspaces cw ON cw.grant_id=g.grant_id AND cw.workspace_id=hs.workspace_id
      AND cw.owner_user_id=g.owner_user_id AND cw.manifest_digest=g.manifest_digest AND cw.revoked_at IS NULL
    JOIN swarm.agent_principals p ON p.principal_id=hs.principal_id AND p.workspace_id=hs.workspace_id
      AND p.owner_user_id=hs.owner_user_id AND p.transport=''hosted_mcp'' AND p.turn_only
    JOIN swarm.workspaces w ON w.workspace_id=hs.workspace_id AND w.archived_at IS NULL
    JOIN swarm.memberships m ON m.workspace_id=hs.workspace_id AND m.user_id=g.owner_user_id AND m.revoked_at IS NULL
    JOIN swarm.streams st ON st.stream_id=v_stream AND st.workspace_id=hs.workspace_id
    WHERE c.context_id=v_context AND c.handle=p_handle AND hs.grant_id=p_grant_id
      AND hs.owner_user_id=g.owner_user_id AND hs.workspace_id=ANY(g.selected_workspace_ids) AND g.state=''active'' AND g.revoked_at IS NULL
      AND (c.origin <> ''legacy'' OR EXISTS (SELECT 1 FROM swarm.hosted_mcp_seat_handles h
        WHERE h.handle=c.handle AND h.seat_id=hs.seat_id AND h.workspace_id=hs.workspace_id
          AND h.principal_id=hs.principal_id AND h.revoked_at IS NULL))
      AND (hs.revoked_at IS NULL AND p.revoked_at IS NULL OR
        p.identity_lifetime=''ephemeral'' AND c.closed_at IS NOT NULL
        AND hs.revoked_at=c.closed_at AND p.revoked_at=c.closed_at)
      AND NOT EXISTS (SELECT 1 FROM swarm.revocation_tombstones t WHERE
        (t.kind=''membership'' AND t.target_id=g.owner_user_id) OR (t.kind=''hosted_grant'' AND t.target_id=g.grant_id)
        OR (t.kind=''hosted_seat'' AND t.target_id=hs.seat_id) OR (t.kind=''principal'' AND t.target_id=p.principal_id));
  RETURN v_result;
END
'
     AND regexp_replace(upper(pg_get_functiondef(p.oid)),'[[:space:];]','','g')=regexp_replace(upper('CREATE OR REPLACE FUNCTION swarm.resolve_hosted_context(p_grant_id uuid, p_handle text, p_tool text, p_use text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO ''pg_catalog''
AS $function$
DECLARE
  v_stream uuid;
  v_context uuid;
  v_now timestamptz;
  v_result jsonb;
BEGIN
  IF NOT ((p_use=''command'' AND p_tool IN (''ask'',''note'',''reply'',''working_on'',''check'',''close_session'')) OR
          (p_use=''read'' AND p_tool IN (''whoami'',''members'',''check''))) THEN RETURN NULL; END IF;
  PERFORM pg_advisory_xact_lock_shared(1936142700, hashtext(''hosted-context-allocation''));
  SELECT st.stream_id,c.context_id INTO v_stream,v_context
    FROM swarm.hosted_agent_contexts c JOIN swarm.hosted_mcp_seats hs USING(seat_id)
    JOIN swarm.streams st ON st.workspace_id=hs.workspace_id AND st.kind=''workspace''
    WHERE c.handle=p_handle AND hs.grant_id=p_grant_id;
  IF v_stream IS NULL THEN RETURN NULL; END IF;
  PERFORM 1 FROM swarm.streams WHERE stream_id=v_stream FOR UPDATE;
  PERFORM 1 FROM swarm.hosted_agent_contexts WHERE context_id=v_context FOR UPDATE;
  v_now := clock_timestamp();
  SELECT jsonb_build_object(''grant_id'',g.grant_id,''provider_grant_id'',g.provider_grant_id,
    ''client_id'',g.client_id,''seat_id'',hs.seat_id,''seat'',c.handle,''handle'',c.handle,
    ''workspace_id'',hs.workspace_id,''workspace'',jsonb_build_object(''id'',w.workspace_id,''name'',w.name),
    ''stream_id'',st.stream_id,''owner_user_id'',g.owner_user_id,''principal_id'',hs.principal_id,
    ''context_id'',c.context_id,''name'',hs.name,''display_name'',COALESCE(hs.display_name,hs.name),
    ''disambiguator'',hs.disambiguator,''lifetime'',p.identity_lifetime,''kind'',c.kind,''origin'',c.origin,
    ''assurance'',''portable'',''created_at'',c.created_at,''last_business_at'',c.last_business_at,
    ''idle_expires_at'',c.idle_expires_at,''absolute_expires_at'',c.absolute_expires_at,
    ''closed_at'',c.closed_at,''close_reason'',c.close_reason,''database_now'',v_now,
    ''context_error'',CASE WHEN c.close_reason=''expired'' THEN ''context_expired'' WHEN c.closed_at IS NOT NULL THEN ''context_closed''
      WHEN c.idle_expires_at<=v_now OR c.absolute_expires_at<=v_now THEN ''context_expired'' ELSE NULL END)
    INTO v_result
    FROM swarm.hosted_agent_contexts c JOIN swarm.hosted_mcp_seats hs USING(seat_id)
    JOIN swarm.hosted_mcp_grants g ON g.grant_id=hs.grant_id
    JOIN swarm.hosted_mcp_grant_workspaces cw ON cw.grant_id=g.grant_id AND cw.workspace_id=hs.workspace_id
      AND cw.owner_user_id=g.owner_user_id AND cw.manifest_digest=g.manifest_digest AND cw.revoked_at IS NULL
    JOIN swarm.agent_principals p ON p.principal_id=hs.principal_id AND p.workspace_id=hs.workspace_id
      AND p.owner_user_id=hs.owner_user_id AND p.transport=''hosted_mcp'' AND p.turn_only
    JOIN swarm.workspaces w ON w.workspace_id=hs.workspace_id AND w.archived_at IS NULL
    JOIN swarm.memberships m ON m.workspace_id=hs.workspace_id AND m.user_id=g.owner_user_id AND m.revoked_at IS NULL
    JOIN swarm.streams st ON st.stream_id=v_stream AND st.workspace_id=hs.workspace_id
    WHERE c.context_id=v_context AND c.handle=p_handle AND hs.grant_id=p_grant_id
      AND hs.owner_user_id=g.owner_user_id AND hs.workspace_id=ANY(g.selected_workspace_ids) AND g.state=''active'' AND g.revoked_at IS NULL
      AND (c.origin <> ''legacy'' OR EXISTS (SELECT 1 FROM swarm.hosted_mcp_seat_handles h
        WHERE h.handle=c.handle AND h.seat_id=hs.seat_id AND h.workspace_id=hs.workspace_id
          AND h.principal_id=hs.principal_id AND h.revoked_at IS NULL))
      AND (hs.revoked_at IS NULL AND p.revoked_at IS NULL OR
        p.identity_lifetime=''ephemeral'' AND c.closed_at IS NOT NULL
        AND hs.revoked_at=c.closed_at AND p.revoked_at=c.closed_at)
      AND NOT EXISTS (SELECT 1 FROM swarm.revocation_tombstones t WHERE
        (t.kind=''membership'' AND t.target_id=g.owner_user_id) OR (t.kind=''hosted_grant'' AND t.target_id=g.grant_id)
        OR (t.kind=''hosted_seat'' AND t.target_id=hs.seat_id) OR (t.kind=''principal'' AND t.target_id=p.principal_id));
  RETURN v_result;
END
$function$;'),'[[:space:];]','','g')
     AND (SELECT array_agg(pg_get_userbyid(a.grantee)||':'||a.privilege_type||':'||pg_get_userbyid(a.grantor)||':'||a.is_grantable::text ORDER BY pg_get_userbyid(a.grantee)||':'||a.privilege_type||':'||pg_get_userbyid(a.grantor)||':'||a.is_grantable::text)
       FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a)='{swarm_admin:EXECUTE:swarm_admin:false,swarm_command:EXECUTE:swarm_admin:false,swarm_read:EXECUTE:swarm_admin:false}'::text[])),false)),
 ('swarm.resolve_hosted_seat_command_authorization(uuid, text, text)',COALESCE((EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles r ON r.oid=p.proowner JOIN pg_catalog.pg_language l ON l.oid=p.prolang
   WHERE p.oid=to_regprocedure('swarm.resolve_hosted_seat_command_authorization(uuid, text, text)') AND r.rolname='swarm_admin' AND l.lanname='sql' AND p.prosecdef=true
     AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND p.provolatile='v' AND p.prokind='f'
     AND NOT p.proisstrict AND NOT p.proleakproof AND p.proparallel='u' AND p.prosupport=0 AND p.procost=100
     AND pg_get_function_result(p.oid)='TABLE(grant_id uuid, provider_grant_id text, seat_id uuid, handle text, workspace_id uuid, stream_id uuid, owner_user_id uuid, principal_id uuid, name text)' AND pg_get_function_identity_arguments(p.oid)='p_grant_id uuid, p_handle text, p_tool text'
     AND p.prosrc='
SELECT (j->>''grant_id'')::uuid,j->>''provider_grant_id'',(j->>''seat_id'')::uuid,j->>''handle'',
      (j->>''workspace_id'')::uuid,(j->>''stream_id'')::uuid,(j->>''owner_user_id'')::uuid,(j->>''principal_id'')::uuid,j->>''name''
    FROM (SELECT swarm.resolve_hosted_context(p_grant_id,p_handle,p_tool,''command'') AS j) context
    WHERE j IS NOT NULL AND j->>''context_error'' IS NULL
'
     AND regexp_replace(upper(pg_get_functiondef(p.oid)),'[[:space:];]','','g')=regexp_replace(upper('CREATE OR REPLACE FUNCTION swarm.resolve_hosted_seat_command_authorization(p_grant_id uuid, p_handle text, p_tool text)
RETURNS TABLE (grant_id uuid, provider_grant_id text, seat_id uuid, handle text, workspace_id uuid, stream_id uuid, owner_user_id uuid, principal_id uuid, name text)
LANGUAGE sql SECURITY DEFINER
SET search_path TO ''pg_catalog''
AS $function$
SELECT (j->>''grant_id'')::uuid,j->>''provider_grant_id'',(j->>''seat_id'')::uuid,j->>''handle'',
      (j->>''workspace_id'')::uuid,(j->>''stream_id'')::uuid,(j->>''owner_user_id'')::uuid,(j->>''principal_id'')::uuid,j->>''name''
    FROM (SELECT swarm.resolve_hosted_context(p_grant_id,p_handle,p_tool,''command'') AS j) context
    WHERE j IS NOT NULL AND j->>''context_error'' IS NULL
$function$;'),'[[:space:];]','','g')
     AND (SELECT array_agg(pg_get_userbyid(a.grantee)||':'||a.privilege_type||':'||pg_get_userbyid(a.grantor)||':'||a.is_grantable::text ORDER BY pg_get_userbyid(a.grantee)||':'||a.privilege_type||':'||pg_get_userbyid(a.grantor)||':'||a.is_grantable::text)
       FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a)='{swarm_admin:EXECUTE:swarm_admin:false,swarm_command:EXECUTE:swarm_admin:false}'::text[])),false)),
 ('swarm.resolve_hosted_seat_read_authorization(uuid, text, text)',COALESCE((EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles r ON r.oid=p.proowner JOIN pg_catalog.pg_language l ON l.oid=p.prolang
   WHERE p.oid=to_regprocedure('swarm.resolve_hosted_seat_read_authorization(uuid, text, text)') AND r.rolname='swarm_admin' AND l.lanname='sql' AND p.prosecdef=true
     AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND p.provolatile='v' AND p.prokind='f'
     AND NOT p.proisstrict AND NOT p.proleakproof AND p.proparallel='u' AND p.prosupport=0 AND p.procost=100
     AND pg_get_function_result(p.oid)='TABLE(grant_id uuid, provider_grant_id text, seat_id uuid, handle text, workspace_id uuid, stream_id uuid, owner_user_id uuid, principal_id uuid, name text)' AND pg_get_function_identity_arguments(p.oid)='p_grant_id uuid, p_handle text, p_tool text'
     AND p.prosrc='
SELECT (j->>''grant_id'')::uuid,j->>''provider_grant_id'',(j->>''seat_id'')::uuid,j->>''handle'',
      (j->>''workspace_id'')::uuid,(j->>''stream_id'')::uuid,(j->>''owner_user_id'')::uuid,(j->>''principal_id'')::uuid,j->>''name''
    FROM (SELECT swarm.resolve_hosted_context(p_grant_id,p_handle,p_tool,''read'') AS j) context
    WHERE j IS NOT NULL AND j->>''context_error'' IS NULL
'
     AND regexp_replace(upper(pg_get_functiondef(p.oid)),'[[:space:];]','','g')=regexp_replace(upper('CREATE OR REPLACE FUNCTION swarm.resolve_hosted_seat_read_authorization(p_grant_id uuid, p_handle text, p_tool text)
RETURNS TABLE (grant_id uuid, provider_grant_id text, seat_id uuid, handle text, workspace_id uuid, stream_id uuid, owner_user_id uuid, principal_id uuid, name text)
LANGUAGE sql SECURITY DEFINER
SET search_path TO ''pg_catalog''
AS $function$
SELECT (j->>''grant_id'')::uuid,j->>''provider_grant_id'',(j->>''seat_id'')::uuid,j->>''handle'',
      (j->>''workspace_id'')::uuid,(j->>''stream_id'')::uuid,(j->>''owner_user_id'')::uuid,(j->>''principal_id'')::uuid,j->>''name''
    FROM (SELECT swarm.resolve_hosted_context(p_grant_id,p_handle,p_tool,''read'') AS j) context
    WHERE j IS NOT NULL AND j->>''context_error'' IS NULL
$function$;'),'[[:space:];]','','g')
     AND (SELECT array_agg(pg_get_userbyid(a.grantee)||':'||a.privilege_type||':'||pg_get_userbyid(a.grantor)||':'||a.is_grantable::text ORDER BY pg_get_userbyid(a.grantee)||':'||a.privilege_type||':'||pg_get_userbyid(a.grantor)||':'||a.is_grantable::text)
       FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a)='{swarm_admin:EXECUTE:swarm_admin:false,swarm_read:EXECUTE:swarm_admin:false}'::text[])),false)),
 ('swarm.resolve_hosted_mcp_check_authorization(uuid, text)',COALESCE((EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles r ON r.oid=p.proowner JOIN pg_catalog.pg_language l ON l.oid=p.prolang
   WHERE p.oid=to_regprocedure('swarm.resolve_hosted_mcp_check_authorization(uuid, text)') AND r.rolname='swarm_admin' AND l.lanname='sql' AND p.prosecdef=true
     AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND p.provolatile='v' AND p.prokind='f'
     AND NOT p.proisstrict AND NOT p.proleakproof AND p.proparallel='u' AND p.prosupport=0 AND p.procost=100
     AND pg_get_function_result(p.oid)='TABLE(grant_id uuid, provider_grant_id text, seat_id uuid, handle text, workspace_id uuid, stream_id uuid, owner_user_id uuid, principal_id uuid, name text)' AND pg_get_function_identity_arguments(p.oid)='p_grant_id uuid, p_handle text'
     AND p.prosrc='
SELECT (j->>''grant_id'')::uuid,j->>''provider_grant_id'',(j->>''seat_id'')::uuid,j->>''handle'',
      (j->>''workspace_id'')::uuid,(j->>''stream_id'')::uuid,(j->>''owner_user_id'')::uuid,(j->>''principal_id'')::uuid,j->>''name''
    FROM (SELECT swarm.resolve_hosted_context(p_grant_id,p_handle,''check'',''command'') AS j) context
    WHERE j IS NOT NULL AND j->>''context_error'' IS NULL
'
     AND regexp_replace(upper(pg_get_functiondef(p.oid)),'[[:space:];]','','g')=regexp_replace(upper('CREATE OR REPLACE FUNCTION swarm.resolve_hosted_mcp_check_authorization(p_grant_id uuid, p_handle text)
RETURNS TABLE (grant_id uuid, provider_grant_id text, seat_id uuid, handle text, workspace_id uuid, stream_id uuid, owner_user_id uuid, principal_id uuid, name text)
LANGUAGE sql SECURITY DEFINER
SET search_path TO ''pg_catalog''
AS $function$
SELECT (j->>''grant_id'')::uuid,j->>''provider_grant_id'',(j->>''seat_id'')::uuid,j->>''handle'',
      (j->>''workspace_id'')::uuid,(j->>''stream_id'')::uuid,(j->>''owner_user_id'')::uuid,(j->>''principal_id'')::uuid,j->>''name''
    FROM (SELECT swarm.resolve_hosted_context(p_grant_id,p_handle,''check'',''command'') AS j) context
    WHERE j IS NOT NULL AND j->>''context_error'' IS NULL
$function$;'),'[[:space:];]','','g')
     AND (SELECT array_agg(pg_get_userbyid(a.grantee)||':'||a.privilege_type||':'||pg_get_userbyid(a.grantor)||':'||a.is_grantable::text ORDER BY pg_get_userbyid(a.grantee)||':'||a.privilege_type||':'||pg_get_userbyid(a.grantor)||':'||a.is_grantable::text)
       FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a)='{swarm_admin:EXECUTE:swarm_admin:false,swarm_command:EXECUTE:swarm_admin:false}'::text[])),false)),
 ('swarm.record_hosted_context_activity(uuid)',COALESCE((EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles r ON r.oid=p.proowner JOIN pg_catalog.pg_language l ON l.oid=p.prolang
   WHERE p.oid=to_regprocedure('swarm.record_hosted_context_activity(uuid)') AND r.rolname='swarm_admin' AND l.lanname='plpgsql' AND p.prosecdef=true
     AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND p.provolatile='v' AND p.prokind='f'
     AND NOT p.proisstrict AND NOT p.proleakproof AND p.proparallel='u' AND p.prosupport=0 AND p.procost=100
     AND pg_get_function_result(p.oid)='jsonb' AND pg_get_function_identity_arguments(p.oid)='p_context_id uuid'
     AND p.prosrc='
DECLARE c swarm.hosted_agent_contexts; v_now timestamptz; hs swarm.hosted_mcp_seats; st swarm.streams;
BEGIN
  SELECT s.* INTO hs FROM swarm.hosted_mcp_seats s JOIN swarm.hosted_agent_contexts x USING(seat_id) WHERE x.context_id=p_context_id;
  SELECT * INTO st FROM swarm.streams WHERE workspace_id=hs.workspace_id AND kind=''workspace'' FOR UPDATE;
  SELECT * INTO c FROM swarm.hosted_agent_contexts WHERE context_id=p_context_id FOR UPDATE;
  v_now:=clock_timestamp();
  IF c.context_id IS NULL OR c.closed_at IS NOT NULL OR c.idle_expires_at<=v_now OR c.absolute_expires_at<=v_now THEN
    RAISE EXCEPTION ''SWARM_CONTEXT_EXPIRED'' USING ERRCODE=''SC001'';
  END IF;
  UPDATE swarm.hosted_agent_contexts SET last_business_at=v_now,
    idle_expires_at=CASE WHEN origin=''legacy'' THEN NULL ELSE v_now+swarm.hosted_context_interval(kind) END
    WHERE context_id=p_context_id RETURNING * INTO c;
  RETURN to_jsonb(c)-''handle'';
END
'
     AND regexp_replace(upper(pg_get_functiondef(p.oid)),'[[:space:];]','','g')=regexp_replace(upper('CREATE OR REPLACE FUNCTION swarm.record_hosted_context_activity(p_context_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO ''pg_catalog''
AS $function$
DECLARE c swarm.hosted_agent_contexts; v_now timestamptz; hs swarm.hosted_mcp_seats; st swarm.streams;
BEGIN
  SELECT s.* INTO hs FROM swarm.hosted_mcp_seats s JOIN swarm.hosted_agent_contexts x USING(seat_id) WHERE x.context_id=p_context_id;
  SELECT * INTO st FROM swarm.streams WHERE workspace_id=hs.workspace_id AND kind=''workspace'' FOR UPDATE;
  SELECT * INTO c FROM swarm.hosted_agent_contexts WHERE context_id=p_context_id FOR UPDATE;
  v_now:=clock_timestamp();
  IF c.context_id IS NULL OR c.closed_at IS NOT NULL OR c.idle_expires_at<=v_now OR c.absolute_expires_at<=v_now THEN
    RAISE EXCEPTION ''SWARM_CONTEXT_EXPIRED'' USING ERRCODE=''SC001'';
  END IF;
  UPDATE swarm.hosted_agent_contexts SET last_business_at=v_now,
    idle_expires_at=CASE WHEN origin=''legacy'' THEN NULL ELSE v_now+swarm.hosted_context_interval(kind) END
    WHERE context_id=p_context_id RETURNING * INTO c;
  RETURN to_jsonb(c)-''handle'';
END
$function$;'),'[[:space:];]','','g')
     AND (SELECT array_agg(pg_get_userbyid(a.grantee)||':'||a.privilege_type||':'||pg_get_userbyid(a.grantor)||':'||a.is_grantable::text ORDER BY pg_get_userbyid(a.grantee)||':'||a.privilege_type||':'||pg_get_userbyid(a.grantor)||':'||a.is_grantable::text)
       FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a)='{swarm_admin:EXECUTE:swarm_admin:false,swarm_command:EXECUTE:swarm_admin:false,swarm_read:EXECUTE:swarm_admin:false}'::text[])),false)),
 ('swarm.close_hosted_agent_context(uuid, text)',COALESCE((EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles r ON r.oid=p.proowner JOIN pg_catalog.pg_language l ON l.oid=p.prolang
   WHERE p.oid=to_regprocedure('swarm.close_hosted_agent_context(uuid, text)') AND r.rolname='swarm_admin' AND l.lanname='plpgsql' AND p.prosecdef=true
     AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND p.provolatile='v' AND p.prokind='f'
     AND NOT p.proisstrict AND NOT p.proleakproof AND p.proparallel='u' AND p.prosupport=0 AND p.procost=100
     AND pg_get_function_result(p.oid)='jsonb' AND pg_get_function_identity_arguments(p.oid)='p_context_id uuid, p_reason text'
     AND p.prosrc='
DECLARE c swarm.hosted_agent_contexts; hs swarm.hosted_mcp_seats; p swarm.agent_principals;
  v_now timestamptz; v_stream swarm.streams; v_event uuid; v_command text;
BEGIN
  IF p_reason NOT IN (''closed'',''expired'') THEN RAISE EXCEPTION ''invalid context close reason''; END IF;
  PERFORM pg_advisory_xact_lock_shared(1936142700, hashtext(''hosted-context-allocation''));
  SELECT s.* INTO hs FROM swarm.hosted_agent_contexts x JOIN swarm.hosted_mcp_seats s USING(seat_id) WHERE x.context_id=p_context_id;
  IF hs.seat_id IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO v_stream FROM swarm.streams WHERE workspace_id=hs.workspace_id AND kind=''workspace'' FOR UPDATE;
  SELECT * INTO c FROM swarm.hosted_agent_contexts WHERE context_id=p_context_id FOR UPDATE;
  SELECT * INTO hs FROM swarm.hosted_mcp_seats WHERE seat_id=c.seat_id FOR UPDATE;
  SELECT * INTO p FROM swarm.agent_principals WHERE principal_id=hs.principal_id FOR UPDATE;
  v_now:=date_trunc(''milliseconds'',clock_timestamp());
  IF c.closed_at IS NULL THEN
    IF p_reason=''expired'' AND (c.idle_expires_at IS NULL OR c.idle_expires_at>v_now)
      AND (c.absolute_expires_at IS NULL OR c.absolute_expires_at>v_now) THEN RETURN NULL; END IF;
    v_now:=GREATEST(v_now,c.created_at,date_trunc(''milliseconds'',v_now));
    UPDATE swarm.hosted_agent_contexts SET closed_at=v_now,close_reason=p_reason WHERE context_id=p_context_id;
    UPDATE swarm.hosted_mcp_check_batches SET cancelled_at=v_now,cancel_reason=p_reason
      WHERE context_id=p_context_id AND acknowledged_at IS NULL AND cancelled_at IS NULL;
    v_event:=gen_random_uuid(); v_command:=''context_''||replace(p_context_id::text,''-'','''');
    IF p.identity_lifetime=''ephemeral'' THEN
      INSERT INTO swarm.events(workspace_id,stream_id,seq,event_id,command_id,type,schema_version,actor_user,actor_agent_principal,actor_run,occurred_at_server,payload)
      VALUES(hs.workspace_id,v_stream.stream_id,v_stream.head_seq+1,v_event,v_command,''HostedMcpSeatRevoked'',1,hs.owner_user_id,hs.principal_id,NULL,v_now,
        jsonb_build_object(''context_id'',p_context_id,''seat_id'',hs.seat_id,''principal_id'',hs.principal_id,''grant_id'',hs.grant_id,''revoked_at'',extract(epoch FROM COALESCE(hs.revoked_at,v_now))*1000,''principal_revoked_at'',extract(epoch FROM COALESCE(p.revoked_at,v_now))*1000));
      UPDATE swarm.streams SET head_seq=head_seq+1 WHERE stream_id=v_stream.stream_id;
    END IF;
    INSERT INTO swarm.audit_log(actor_user,actor_agent_principal,credential_kind,credential_id,command_kind,workspace_id,stream_id,outcome,reason,context_id,context_details)
    SELECT hs.owner_user_id,hs.principal_id,''hosted_grant'',hs.grant_id,''close_session'',hs.workspace_id,v_stream.stream_id,''accepted'',p_reason,p_context_id,
      jsonb_build_object(''context_id'',p_context_id,''grant_id'',hs.grant_id,''client_id'',g.client_id,''assurance'',''portable'',''lifetime'',p.identity_lifetime,''kind'',c.kind,''command_id'',v_command)
      FROM swarm.hosted_mcp_grants g WHERE g.grant_id=hs.grant_id;
    c.closed_at:=v_now;
  END IF;
  RETURN jsonb_build_object(''outcome'',''closed'',''context_id'',p_context_id,''principal_state'',CASE WHEN p.identity_lifetime=''ephemeral'' THEN ''retired'' ELSE ''retained'' END,''closed_at'',c.closed_at);
END
'
     AND regexp_replace(upper(pg_get_functiondef(p.oid)),'[[:space:];]','','g')=regexp_replace(upper('CREATE OR REPLACE FUNCTION swarm.close_hosted_agent_context(p_context_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO ''pg_catalog''
AS $function$
DECLARE c swarm.hosted_agent_contexts; hs swarm.hosted_mcp_seats; p swarm.agent_principals;
  v_now timestamptz; v_stream swarm.streams; v_event uuid; v_command text;
BEGIN
  IF p_reason NOT IN (''closed'',''expired'') THEN RAISE EXCEPTION ''invalid context close reason''; END IF;
  PERFORM pg_advisory_xact_lock_shared(1936142700, hashtext(''hosted-context-allocation''));
  SELECT s.* INTO hs FROM swarm.hosted_agent_contexts x JOIN swarm.hosted_mcp_seats s USING(seat_id) WHERE x.context_id=p_context_id;
  IF hs.seat_id IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO v_stream FROM swarm.streams WHERE workspace_id=hs.workspace_id AND kind=''workspace'' FOR UPDATE;
  SELECT * INTO c FROM swarm.hosted_agent_contexts WHERE context_id=p_context_id FOR UPDATE;
  SELECT * INTO hs FROM swarm.hosted_mcp_seats WHERE seat_id=c.seat_id FOR UPDATE;
  SELECT * INTO p FROM swarm.agent_principals WHERE principal_id=hs.principal_id FOR UPDATE;
  v_now:=date_trunc(''milliseconds'',clock_timestamp());
  IF c.closed_at IS NULL THEN
    IF p_reason=''expired'' AND (c.idle_expires_at IS NULL OR c.idle_expires_at>v_now)
      AND (c.absolute_expires_at IS NULL OR c.absolute_expires_at>v_now) THEN RETURN NULL; END IF;
    v_now:=GREATEST(v_now,c.created_at,date_trunc(''milliseconds'',v_now));
    UPDATE swarm.hosted_agent_contexts SET closed_at=v_now,close_reason=p_reason WHERE context_id=p_context_id;
    UPDATE swarm.hosted_mcp_check_batches SET cancelled_at=v_now,cancel_reason=p_reason
      WHERE context_id=p_context_id AND acknowledged_at IS NULL AND cancelled_at IS NULL;
    v_event:=gen_random_uuid(); v_command:=''context_''||replace(p_context_id::text,''-'','''');
    IF p.identity_lifetime=''ephemeral'' THEN
      INSERT INTO swarm.events(workspace_id,stream_id,seq,event_id,command_id,type,schema_version,actor_user,actor_agent_principal,actor_run,occurred_at_server,payload)
      VALUES(hs.workspace_id,v_stream.stream_id,v_stream.head_seq+1,v_event,v_command,''HostedMcpSeatRevoked'',1,hs.owner_user_id,hs.principal_id,NULL,v_now,
        jsonb_build_object(''context_id'',p_context_id,''seat_id'',hs.seat_id,''principal_id'',hs.principal_id,''grant_id'',hs.grant_id,''revoked_at'',extract(epoch FROM COALESCE(hs.revoked_at,v_now))*1000,''principal_revoked_at'',extract(epoch FROM COALESCE(p.revoked_at,v_now))*1000));
      UPDATE swarm.streams SET head_seq=head_seq+1 WHERE stream_id=v_stream.stream_id;
    END IF;
    INSERT INTO swarm.audit_log(actor_user,actor_agent_principal,credential_kind,credential_id,command_kind,workspace_id,stream_id,outcome,reason,context_id,context_details)
    SELECT hs.owner_user_id,hs.principal_id,''hosted_grant'',hs.grant_id,''close_session'',hs.workspace_id,v_stream.stream_id,''accepted'',p_reason,p_context_id,
      jsonb_build_object(''context_id'',p_context_id,''grant_id'',hs.grant_id,''client_id'',g.client_id,''assurance'',''portable'',''lifetime'',p.identity_lifetime,''kind'',c.kind,''command_id'',v_command)
      FROM swarm.hosted_mcp_grants g WHERE g.grant_id=hs.grant_id;
    c.closed_at:=v_now;
  END IF;
  RETURN jsonb_build_object(''outcome'',''closed'',''context_id'',p_context_id,''principal_state'',CASE WHEN p.identity_lifetime=''ephemeral'' THEN ''retired'' ELSE ''retained'' END,''closed_at'',c.closed_at);
END
$function$;'),'[[:space:];]','','g')
     AND (SELECT array_agg(pg_get_userbyid(a.grantee)||':'||a.privilege_type||':'||pg_get_userbyid(a.grantor)||':'||a.is_grantable::text ORDER BY pg_get_userbyid(a.grantee)||':'||a.privilege_type||':'||pg_get_userbyid(a.grantor)||':'||a.is_grantable::text)
       FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a)='{swarm_admin:EXECUTE:swarm_admin:false,swarm_command:EXECUTE:swarm_admin:false}'::text[])),false)),
 ('swarm.expire_hosted_agent_contexts(integer)',COALESCE((EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles r ON r.oid=p.proowner JOIN pg_catalog.pg_language l ON l.oid=p.prolang
   WHERE p.oid=to_regprocedure('swarm.expire_hosted_agent_contexts(integer)') AND r.rolname='swarm_admin' AND l.lanname='plpgsql' AND p.prosecdef=true
     AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND p.provolatile='v' AND p.prokind='f'
     AND NOT p.proisstrict AND NOT p.proleakproof AND p.proparallel='u' AND p.prosupport=0 AND p.procost=100
     AND pg_get_function_result(p.oid)='integer' AND pg_get_function_identity_arguments(p.oid)='p_limit integer'
     AND p.prosrc='
DECLARE v_count integer:=0; r record;
BEGIN
  IF p_limit IS NULL OR p_limit<1 OR p_limit>100 THEN RAISE EXCEPTION ''expiry batch must be between 1 and 100''; END IF;
  PERFORM pg_advisory_xact_lock_shared(1936142700, hashtext(''hosted-context-allocation''));
  IF NOT pg_try_advisory_xact_lock(1936142700,hashtext(''hosted-context-expiry'')) THEN RETURN 0; END IF;
  FOR r IN SELECT context_id FROM swarm.hosted_agent_contexts
    WHERE closed_at IS NULL AND (idle_expires_at<=clock_timestamp() OR absolute_expires_at<=clock_timestamp())
    ORDER BY LEAST(idle_expires_at,absolute_expires_at),context_id LIMIT p_limit
  LOOP
    IF swarm.close_hosted_agent_context(r.context_id,''expired'') IS NOT NULL THEN v_count:=v_count+1; END IF;
  END LOOP;
  RETURN v_count;
END
'
     AND regexp_replace(upper(pg_get_functiondef(p.oid)),'[[:space:];]','','g')=regexp_replace(upper('CREATE OR REPLACE FUNCTION swarm.expire_hosted_agent_contexts(p_limit integer)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO ''pg_catalog''
AS $function$
DECLARE v_count integer:=0; r record;
BEGIN
  IF p_limit IS NULL OR p_limit<1 OR p_limit>100 THEN RAISE EXCEPTION ''expiry batch must be between 1 and 100''; END IF;
  PERFORM pg_advisory_xact_lock_shared(1936142700, hashtext(''hosted-context-allocation''));
  IF NOT pg_try_advisory_xact_lock(1936142700,hashtext(''hosted-context-expiry'')) THEN RETURN 0; END IF;
  FOR r IN SELECT context_id FROM swarm.hosted_agent_contexts
    WHERE closed_at IS NULL AND (idle_expires_at<=clock_timestamp() OR absolute_expires_at<=clock_timestamp())
    ORDER BY LEAST(idle_expires_at,absolute_expires_at),context_id LIMIT p_limit
  LOOP
    IF swarm.close_hosted_agent_context(r.context_id,''expired'') IS NOT NULL THEN v_count:=v_count+1; END IF;
  END LOOP;
  RETURN v_count;
END
$function$;'),'[[:space:];]','','g')
     AND (SELECT array_agg(pg_get_userbyid(a.grantee)||':'||a.privilege_type||':'||pg_get_userbyid(a.grantor)||':'||a.is_grantable::text ORDER BY pg_get_userbyid(a.grantee)||':'||a.privilege_type||':'||pg_get_userbyid(a.grantor)||':'||a.is_grantable::text)
       FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a)='{swarm_admin:EXECUTE:swarm_admin:false}'::text[])),false)),
 ('swarm.sweep_hosted_agent_contexts()',COALESCE((EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles r ON r.oid=p.proowner JOIN pg_catalog.pg_language l ON l.oid=p.prolang
   WHERE p.oid=to_regprocedure('swarm.sweep_hosted_agent_contexts()') AND r.rolname='swarm_admin' AND l.lanname='plpgsql' AND p.prosecdef=true
     AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND p.provolatile='v' AND p.prokind='f'
     AND NOT p.proisstrict AND NOT p.proleakproof AND p.proparallel='u' AND p.prosupport=0 AND p.procost=100
     AND pg_get_function_result(p.oid)='void' AND pg_get_function_identity_arguments(p.oid)=''
     AND p.prosrc='
DECLARE v_count integer; v_batches integer:=0;
BEGIN
  LOOP
    v_count:=swarm.expire_hosted_agent_contexts(100); v_batches:=v_batches+1;
    EXIT WHEN v_count<100 OR v_batches>=10;
  END LOOP;
END
'
     AND regexp_replace(upper(pg_get_functiondef(p.oid)),'[[:space:];]','','g')=regexp_replace(upper('CREATE OR REPLACE FUNCTION swarm.sweep_hosted_agent_contexts()
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO ''pg_catalog''
AS $function$
DECLARE v_count integer; v_batches integer:=0;
BEGIN
  LOOP
    v_count:=swarm.expire_hosted_agent_contexts(100); v_batches:=v_batches+1;
    EXIT WHEN v_count<100 OR v_batches>=10;
  END LOOP;
END
$function$;'),'[[:space:];]','','g')
     AND (SELECT array_agg(pg_get_userbyid(a.grantee)||':'||a.privilege_type||':'||pg_get_userbyid(a.grantor)||':'||a.is_grantable::text ORDER BY pg_get_userbyid(a.grantee)||':'||a.privilege_type||':'||pg_get_userbyid(a.grantor)||':'||a.is_grantable::text)
       FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a)='{swarm_admin:EXECUTE:swarm_admin:false}'::text[])),false)),
 ('swarm.resolve_hosted_discovery(uuid, uuid)',COALESCE((EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles r ON r.oid=p.proowner JOIN pg_catalog.pg_language l ON l.oid=p.prolang
   WHERE p.oid=to_regprocedure('swarm.resolve_hosted_discovery(uuid, uuid)') AND r.rolname='swarm_admin' AND l.lanname='sql' AND p.prosecdef=true
     AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND p.provolatile='s' AND p.prokind='f'
     AND NOT p.proisstrict AND NOT p.proleakproof AND p.proparallel='u' AND p.prosupport=0 AND p.procost=100
     AND pg_get_function_result(p.oid)='jsonb' AND pg_get_function_identity_arguments(p.oid)='p_grant_id uuid, p_owner_user_id uuid'
     AND p.prosrc='
SELECT jsonb_build_object(''provider_grant_id'',g.provider_grant_id,
  ''grant'',jsonb_build_object(''id'',g.grant_id,''owner_user_id'',g.owner_user_id,''client_id'',g.client_id,''home_workspace_id'',g.home_workspace_id,''active'',true),
  ''subject'',g.owner_user_id,''provider_active'',true,''owner'',jsonb_build_object(''user_id'',u.user_id,''display_name'',u.display_name),
  ''registered_app'',CASE WHEN cache.client_id IS NULL THEN NULL ELSE jsonb_build_object(''client_id'',g.client_id,''display_name'',COALESCE(cache.metadata->>''client_name'',''Agent''),''suggested_name'',NULL) END,
  ''workspaces'',COALESCE((SELECT jsonb_agg(jsonb_build_object(''id'',w.workspace_id,''name'',w.name,''consented'',true,''member'',true,''live'',true,''permitted'',true) ORDER BY w.workspace_id)
    FROM swarm.hosted_mcp_grant_workspaces c JOIN swarm.workspaces w ON w.workspace_id=c.workspace_id AND w.archived_at IS NULL
    JOIN swarm.memberships m ON m.workspace_id=w.workspace_id AND m.user_id=g.owner_user_id AND m.revoked_at IS NULL
    WHERE c.grant_id=g.grant_id AND c.owner_user_id=g.owner_user_id AND c.manifest_digest=g.manifest_digest AND c.revoked_at IS NULL AND w.workspace_id=ANY(g.selected_workspace_ids)),''[]''::jsonb))
  FROM swarm.hosted_mcp_grants g JOIN swarm.users u ON u.user_id=g.owner_user_id
  LEFT JOIN commonswarm_oauth.cimd_cache cache ON cache.client_id=g.client_id AND cache.expires_at>statement_timestamp()
  WHERE g.grant_id=p_grant_id AND g.owner_user_id=p_owner_user_id AND g.state=''active'' AND g.revoked_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM swarm.revocation_tombstones t WHERE (t.kind=''membership'' AND t.target_id=g.owner_user_id) OR (t.kind=''hosted_grant'' AND t.target_id=g.grant_id))
'
     AND regexp_replace(upper(pg_get_functiondef(p.oid)),'[[:space:];]','','g')=regexp_replace(upper('CREATE OR REPLACE FUNCTION swarm.resolve_hosted_discovery(p_grant_id uuid, p_owner_user_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO ''pg_catalog''
AS $function$
SELECT jsonb_build_object(''provider_grant_id'',g.provider_grant_id,
  ''grant'',jsonb_build_object(''id'',g.grant_id,''owner_user_id'',g.owner_user_id,''client_id'',g.client_id,''home_workspace_id'',g.home_workspace_id,''active'',true),
  ''subject'',g.owner_user_id,''provider_active'',true,''owner'',jsonb_build_object(''user_id'',u.user_id,''display_name'',u.display_name),
  ''registered_app'',CASE WHEN cache.client_id IS NULL THEN NULL ELSE jsonb_build_object(''client_id'',g.client_id,''display_name'',COALESCE(cache.metadata->>''client_name'',''Agent''),''suggested_name'',NULL) END,
  ''workspaces'',COALESCE((SELECT jsonb_agg(jsonb_build_object(''id'',w.workspace_id,''name'',w.name,''consented'',true,''member'',true,''live'',true,''permitted'',true) ORDER BY w.workspace_id)
    FROM swarm.hosted_mcp_grant_workspaces c JOIN swarm.workspaces w ON w.workspace_id=c.workspace_id AND w.archived_at IS NULL
    JOIN swarm.memberships m ON m.workspace_id=w.workspace_id AND m.user_id=g.owner_user_id AND m.revoked_at IS NULL
    WHERE c.grant_id=g.grant_id AND c.owner_user_id=g.owner_user_id AND c.manifest_digest=g.manifest_digest AND c.revoked_at IS NULL AND w.workspace_id=ANY(g.selected_workspace_ids)),''[]''::jsonb))
  FROM swarm.hosted_mcp_grants g JOIN swarm.users u ON u.user_id=g.owner_user_id
  LEFT JOIN commonswarm_oauth.cimd_cache cache ON cache.client_id=g.client_id AND cache.expires_at>statement_timestamp()
  WHERE g.grant_id=p_grant_id AND g.owner_user_id=p_owner_user_id AND g.state=''active'' AND g.revoked_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM swarm.revocation_tombstones t WHERE (t.kind=''membership'' AND t.target_id=g.owner_user_id) OR (t.kind=''hosted_grant'' AND t.target_id=g.grant_id))
$function$;'),'[[:space:];]','','g')
     AND (SELECT array_agg(pg_get_userbyid(a.grantee)||':'||a.privilege_type||':'||pg_get_userbyid(a.grantor)||':'||a.is_grantable::text ORDER BY pg_get_userbyid(a.grantee)||':'||a.privilege_type||':'||pg_get_userbyid(a.grantor)||':'||a.is_grantable::text)
       FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a)='{swarm_admin:EXECUTE:swarm_admin:false,swarm_command:EXECUTE:swarm_admin:false,swarm_read:EXECUTE:swarm_admin:false}'::text[])),false)),
 ('swarm.hosted_principal_context_summary(uuid)',COALESCE((EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles r ON r.oid=p.proowner JOIN pg_catalog.pg_language l ON l.oid=p.prolang
   WHERE p.oid=to_regprocedure('swarm.hosted_principal_context_summary(uuid)') AND r.rolname='swarm_admin' AND l.lanname='sql' AND p.prosecdef=true
     AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND p.provolatile='s' AND p.prokind='f'
     AND NOT p.proisstrict AND NOT p.proleakproof AND p.proparallel='u' AND p.prosupport=0 AND p.procost=100
     AND pg_get_function_result(p.oid)='jsonb' AND pg_get_function_identity_arguments(p.oid)='p_principal_id uuid'
     AND p.prosrc='
SELECT jsonb_build_object(''display_name'',COALESCE(hs.display_name,p.name),''disambiguator'',hs.disambiguator,
  ''app'',jsonb_build_object(''client_id'',g.client_id,''display_name'',COALESCE(cache.metadata->>''client_name'',''Agent'')),
  ''last_business_at'',(SELECT max(c.last_business_at) FROM swarm.hosted_agent_contexts c WHERE c.seat_id=hs.seat_id),
  ''active_contexts'',(SELECT count(*) FROM swarm.hosted_agent_contexts c WHERE c.seat_id=hs.seat_id AND c.closed_at IS NULL AND (c.idle_expires_at IS NULL OR c.idle_expires_at>statement_timestamp()) AND (c.absolute_expires_at IS NULL OR c.absolute_expires_at>statement_timestamp())))
  FROM swarm.agent_principals p JOIN swarm.hosted_mcp_seats hs USING(principal_id) JOIN swarm.hosted_mcp_grants g USING(grant_id)
  LEFT JOIN commonswarm_oauth.cimd_cache cache ON cache.client_id=g.client_id AND cache.expires_at>statement_timestamp()
  WHERE p.principal_id=p_principal_id AND swarm.is_member(p.workspace_id,auth.uid())
    AND NOT EXISTS(SELECT 1 FROM swarm.agent_join_credentials c WHERE c.registrar_principal_id=p.principal_id)
'
     AND regexp_replace(upper(pg_get_functiondef(p.oid)),'[[:space:];]','','g')=regexp_replace(upper('CREATE OR REPLACE FUNCTION swarm.hosted_principal_context_summary(p_principal_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO ''pg_catalog''
AS $function$
SELECT jsonb_build_object(''display_name'',COALESCE(hs.display_name,p.name),''disambiguator'',hs.disambiguator,
  ''app'',jsonb_build_object(''client_id'',g.client_id,''display_name'',COALESCE(cache.metadata->>''client_name'',''Agent'')),
  ''last_business_at'',(SELECT max(c.last_business_at) FROM swarm.hosted_agent_contexts c WHERE c.seat_id=hs.seat_id),
  ''active_contexts'',(SELECT count(*) FROM swarm.hosted_agent_contexts c WHERE c.seat_id=hs.seat_id AND c.closed_at IS NULL AND (c.idle_expires_at IS NULL OR c.idle_expires_at>statement_timestamp()) AND (c.absolute_expires_at IS NULL OR c.absolute_expires_at>statement_timestamp())))
  FROM swarm.agent_principals p JOIN swarm.hosted_mcp_seats hs USING(principal_id) JOIN swarm.hosted_mcp_grants g USING(grant_id)
  LEFT JOIN commonswarm_oauth.cimd_cache cache ON cache.client_id=g.client_id AND cache.expires_at>statement_timestamp()
  WHERE p.principal_id=p_principal_id AND swarm.is_member(p.workspace_id,auth.uid())
    AND NOT EXISTS(SELECT 1 FROM swarm.agent_join_credentials c WHERE c.registrar_principal_id=p.principal_id)
$function$;'),'[[:space:];]','','g')
     AND (SELECT array_agg(pg_get_userbyid(a.grantee)||':'||a.privilege_type||':'||pg_get_userbyid(a.grantor)||':'||a.is_grantable::text ORDER BY pg_get_userbyid(a.grantee)||':'||a.privilege_type||':'||pg_get_userbyid(a.grantor)||':'||a.is_grantable::text)
       FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a)='{authenticated:EXECUTE:swarm_admin:false,swarm_admin:EXECUTE:swarm_admin:false,swarm_read:EXECUTE:swarm_admin:false}'::text[])),false)),
 ('swarm.purge_expired_idempotency_keys(integer)',COALESCE((EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles r ON r.oid=p.proowner JOIN pg_catalog.pg_language l ON l.oid=p.prolang
   WHERE p.oid=to_regprocedure('swarm.purge_expired_idempotency_keys(integer)') AND r.rolname='swarm_admin' AND l.lanname='plpgsql' AND p.prosecdef=true
     AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND p.provolatile='v' AND p.prokind='f'
     AND NOT p.proisstrict AND NOT p.proleakproof AND p.proparallel='u' AND p.prosupport=0 AND p.procost=100
     AND pg_get_function_result(p.oid)='integer' AND pg_get_function_identity_arguments(p.oid)='batch_size integer'
     AND p.prosrc='
DECLARE
  deleted integer;
  retain_days integer;
  claim_days integer;
  claim_id_re text := ''^claim_[0-9a-f]{32}_[0-9a-z]+$'';
BEGIN
  IF batch_size IS NULL OR batch_size < 1 OR batch_size > 50000 THEN
    RAISE EXCEPTION ''purge batch_size must be between 1 and 50000'';
  END IF;
  retain_days := GREATEST(
    1,
    COALESCE(
      (
        SELECT (value #>> ''{}'')::integer
        FROM swarm.config
        WHERE key = ''idempotency_retention_days''
      ),
      1
    )
  );
  claim_days := GREATEST(
    2,
    COALESCE(
      (
        SELECT (value #>> ''{}'')::integer
        FROM swarm.config
        WHERE key = ''claim_idempotency_retention_days''
      ),
      2
    )
  );
  DELETE FROM swarm.idempotency_keys
  WHERE (principal_kind, principal_id, command_id) IN (
    SELECT principal_kind, principal_id, command_id
    FROM swarm.idempotency_keys k
    WHERE (k.context_id IS NULL AND ((
        command_id ~ claim_id_re
        AND created_at < statement_timestamp() - make_interval(days => claim_days)
      )
      OR (
        command_id !~ claim_id_re
        AND created_at < statement_timestamp() - make_interval(days => retain_days)
      )
      )) OR (k.context_id IS NOT NULL AND EXISTS (SELECT 1 FROM swarm.hosted_agent_contexts c WHERE c.context_id=k.context_id AND c.closed_at IS NOT NULL AND c.closed_at < statement_timestamp()-interval ''30 days''))
    ORDER BY created_at, principal_kind, principal_id, command_id
    LIMIT batch_size
  );
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
'
     AND regexp_replace(upper(pg_get_functiondef(p.oid)),'[[:space:];]','','g')=regexp_replace(upper('CREATE OR REPLACE FUNCTION swarm.purge_expired_idempotency_keys(batch_size integer)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO ''pg_catalog''
AS $function$
DECLARE
  deleted integer;
  retain_days integer;
  claim_days integer;
  claim_id_re text := ''^claim_[0-9a-f]{32}_[0-9a-z]+$'';
BEGIN
  IF batch_size IS NULL OR batch_size < 1 OR batch_size > 50000 THEN
    RAISE EXCEPTION ''purge batch_size must be between 1 and 50000'';
  END IF;
  retain_days := GREATEST(
    1,
    COALESCE(
      (
        SELECT (value #>> ''{}'')::integer
        FROM swarm.config
        WHERE key = ''idempotency_retention_days''
      ),
      1
    )
  );
  claim_days := GREATEST(
    2,
    COALESCE(
      (
        SELECT (value #>> ''{}'')::integer
        FROM swarm.config
        WHERE key = ''claim_idempotency_retention_days''
      ),
      2
    )
  );
  DELETE FROM swarm.idempotency_keys
  WHERE (principal_kind, principal_id, command_id) IN (
    SELECT principal_kind, principal_id, command_id
    FROM swarm.idempotency_keys k
    WHERE (k.context_id IS NULL AND ((
        command_id ~ claim_id_re
        AND created_at < statement_timestamp() - make_interval(days => claim_days)
      )
      OR (
        command_id !~ claim_id_re
        AND created_at < statement_timestamp() - make_interval(days => retain_days)
      )
      )) OR (k.context_id IS NOT NULL AND EXISTS (SELECT 1 FROM swarm.hosted_agent_contexts c WHERE c.context_id=k.context_id AND c.closed_at IS NOT NULL AND c.closed_at < statement_timestamp()-interval ''30 days''))
    ORDER BY created_at, principal_kind, principal_id, command_id
    LIMIT batch_size
  );
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$function$;'),'[[:space:];]','','g')
     AND (SELECT array_agg(pg_get_userbyid(a.grantee)||':'||a.privilege_type||':'||pg_get_userbyid(a.grantor)||':'||a.is_grantable::text ORDER BY pg_get_userbyid(a.grantee)||':'||a.privilege_type||':'||pg_get_userbyid(a.grantor)||':'||a.is_grantable::text)
       FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a)='{swarm_admin:EXECUTE:swarm_admin:false}'::text[])),false)),
 ('swarm.hosted_context_guard()',COALESCE((EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles r ON r.oid=p.proowner JOIN pg_catalog.pg_language l ON l.oid=p.prolang
   WHERE p.oid=to_regprocedure('swarm.hosted_context_guard()') AND r.rolname='swarm_admin' AND l.lanname='plpgsql' AND p.prosecdef=false
     AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND p.provolatile='v' AND p.prokind='f'
     AND NOT p.proisstrict AND NOT p.proleakproof AND p.proparallel='u' AND p.prosupport=0 AND p.procost=100
     AND pg_get_function_result(p.oid)='trigger' AND pg_get_function_identity_arguments(p.oid)=''
     AND p.prosrc='
BEGIN
  IF TG_OP=''DELETE'' OR OLD.closed_at IS NOT NULL
    OR (to_jsonb(NEW)-ARRAY[''last_business_at'',''idle_expires_at'',''closed_at'',''close_reason'']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY[''last_business_at'',''idle_expires_at'',''closed_at'',''close_reason''])
    OR NEW.last_business_at<OLD.last_business_at
    OR (OLD.idle_expires_at IS NULL) IS DISTINCT FROM (NEW.idle_expires_at IS NULL)
    OR (NEW.idle_expires_at IS NOT NULL AND NEW.idle_expires_at<>NEW.last_business_at+swarm.hosted_context_interval(NEW.kind))
    OR (NEW.closed_at IS NOT NULL AND (NEW.last_business_at<>OLD.last_business_at OR NEW.idle_expires_at IS DISTINCT FROM OLD.idle_expires_at)) THEN
    RAISE EXCEPTION ''SWARM_HOSTED_CONTEXT_IMMUTABLE'' USING ERRCODE=''55000'';
  END IF;
  RETURN NEW;
END
'
     AND regexp_replace(upper(pg_get_functiondef(p.oid)),'[[:space:];]','','g')=regexp_replace(upper('CREATE OR REPLACE FUNCTION swarm.hosted_context_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''pg_catalog''
AS $function$
BEGIN
  IF TG_OP=''DELETE'' OR OLD.closed_at IS NOT NULL
    OR (to_jsonb(NEW)-ARRAY[''last_business_at'',''idle_expires_at'',''closed_at'',''close_reason'']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY[''last_business_at'',''idle_expires_at'',''closed_at'',''close_reason''])
    OR NEW.last_business_at<OLD.last_business_at
    OR (OLD.idle_expires_at IS NULL) IS DISTINCT FROM (NEW.idle_expires_at IS NULL)
    OR (NEW.idle_expires_at IS NOT NULL AND NEW.idle_expires_at<>NEW.last_business_at+swarm.hosted_context_interval(NEW.kind))
    OR (NEW.closed_at IS NOT NULL AND (NEW.last_business_at<>OLD.last_business_at OR NEW.idle_expires_at IS DISTINCT FROM OLD.idle_expires_at)) THEN
    RAISE EXCEPTION ''SWARM_HOSTED_CONTEXT_IMMUTABLE'' USING ERRCODE=''55000'';
  END IF;
  RETURN NEW;
END
$function$;'),'[[:space:];]','','g')
     AND (SELECT array_agg(pg_get_userbyid(a.grantee)||':'||a.privilege_type||':'||pg_get_userbyid(a.grantor)||':'||a.is_grantable::text ORDER BY pg_get_userbyid(a.grantee)||':'||a.privilege_type||':'||pg_get_userbyid(a.grantor)||':'||a.is_grantable::text)
       FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a)='{swarm_admin:EXECUTE:swarm_admin:false}'::text[])),false)),
 ('swarm.audit_hosted_context(uuid, uuid, text, text, text, text)',COALESCE((EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles r ON r.oid=p.proowner JOIN pg_catalog.pg_language l ON l.oid=p.prolang
   WHERE p.oid=to_regprocedure('swarm.audit_hosted_context(uuid, uuid, text, text, text, text)') AND r.rolname='swarm_admin' AND l.lanname='plpgsql' AND p.prosecdef=true
     AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND p.provolatile='v' AND p.prokind='f'
     AND NOT p.proisstrict AND NOT p.proleakproof AND p.proparallel='u' AND p.prosupport=0 AND p.procost=100
     AND pg_get_function_result(p.oid)='void' AND pg_get_function_identity_arguments(p.oid)='p_context_id uuid, p_grant_id uuid, p_tool text, p_outcome text, p_reason text, p_request text'
     AND p.prosrc='
BEGIN
  IF p_outcome NOT IN (''accepted'',''replayed'',''authz'',''domain'',''conflict'') OR length(p_tool)>80
    OR (p_reason IS NOT NULL AND (p_reason !~ ''^[a-z][a-z0-9_]{1,79}$'' OR p_reason ~ ''^seat_[A-Za-z0-9_-]{22,64}$''))
    OR (p_request IS NOT NULL AND p_request !~ ''^[A-Za-z0-9_-]{8,72}$'') THEN RAISE EXCEPTION ''invalid hosted audit metadata''; END IF;
  INSERT INTO swarm.audit_log(actor_user,actor_agent_principal,credential_kind,credential_id,command_kind,workspace_id,stream_id,outcome,reason,context_id,context_details)
    SELECT hs.owner_user_id,hs.principal_id,''hosted_grant'',g.grant_id,p_tool,hs.workspace_id,st.stream_id,p_outcome,
      p_reason,
      c.context_id,jsonb_build_object(''context_id'',c.context_id,''grant_id'',g.grant_id,''client_id'',g.client_id,''owner_user_id'',hs.owner_user_id,''workspace_id'',hs.workspace_id,''principal_id'',hs.principal_id,''assurance'',''portable'',''lifetime'',p.identity_lifetime,''kind'',c.kind,''command_id'',p_request,''created_at'',c.created_at,''last_business_at'',c.last_business_at,''idle_expires_at'',c.idle_expires_at,''absolute_expires_at'',c.absolute_expires_at)
    FROM swarm.hosted_agent_contexts c JOIN swarm.hosted_mcp_seats hs USING(seat_id)
    JOIN swarm.hosted_mcp_grants g ON g.grant_id=p_grant_id AND g.owner_user_id=hs.owner_user_id
    JOIN swarm.agent_principals p USING(principal_id) JOIN swarm.streams st ON st.workspace_id=hs.workspace_id AND st.kind=''workspace''
    WHERE c.context_id=p_context_id;
END
'
     AND regexp_replace(upper(pg_get_functiondef(p.oid)),'[[:space:];]','','g')=regexp_replace(upper('CREATE OR REPLACE FUNCTION swarm.audit_hosted_context(p_context_id uuid, p_grant_id uuid, p_tool text, p_outcome text, p_reason text, p_request text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO ''pg_catalog''
AS $function$
BEGIN
  IF p_outcome NOT IN (''accepted'',''replayed'',''authz'',''domain'',''conflict'') OR length(p_tool)>80
    OR (p_reason IS NOT NULL AND (p_reason !~ ''^[a-z][a-z0-9_]{1,79}$'' OR p_reason ~ ''^seat_[A-Za-z0-9_-]{22,64}$''))
    OR (p_request IS NOT NULL AND p_request !~ ''^[A-Za-z0-9_-]{8,72}$'') THEN RAISE EXCEPTION ''invalid hosted audit metadata''; END IF;
  INSERT INTO swarm.audit_log(actor_user,actor_agent_principal,credential_kind,credential_id,command_kind,workspace_id,stream_id,outcome,reason,context_id,context_details)
    SELECT hs.owner_user_id,hs.principal_id,''hosted_grant'',g.grant_id,p_tool,hs.workspace_id,st.stream_id,p_outcome,
      p_reason,
      c.context_id,jsonb_build_object(''context_id'',c.context_id,''grant_id'',g.grant_id,''client_id'',g.client_id,''owner_user_id'',hs.owner_user_id,''workspace_id'',hs.workspace_id,''principal_id'',hs.principal_id,''assurance'',''portable'',''lifetime'',p.identity_lifetime,''kind'',c.kind,''command_id'',p_request,''created_at'',c.created_at,''last_business_at'',c.last_business_at,''idle_expires_at'',c.idle_expires_at,''absolute_expires_at'',c.absolute_expires_at)
    FROM swarm.hosted_agent_contexts c JOIN swarm.hosted_mcp_seats hs USING(seat_id)
    JOIN swarm.hosted_mcp_grants g ON g.grant_id=p_grant_id AND g.owner_user_id=hs.owner_user_id
    JOIN swarm.agent_principals p USING(principal_id) JOIN swarm.streams st ON st.workspace_id=hs.workspace_id AND st.kind=''workspace''
    WHERE c.context_id=p_context_id;
END
$function$;'),'[[:space:];]','','g')
     AND (SELECT array_agg(pg_get_userbyid(a.grantee)||':'||a.privilege_type||':'||pg_get_userbyid(a.grantor)||':'||a.is_grantable::text ORDER BY pg_get_userbyid(a.grantee)||':'||a.privilege_type||':'||pg_get_userbyid(a.grantor)||':'||a.is_grantable::text)
       FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a)='{swarm_admin:EXECUTE:swarm_admin:false,swarm_command:EXECUTE:swarm_admin:false,swarm_read:EXECUTE:swarm_admin:false}'::text[])),false)),
 ('swarm.hosted_outcome_context()',COALESCE((EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles r ON r.oid=p.proowner JOIN pg_catalog.pg_language l ON l.oid=p.prolang
   WHERE p.oid=to_regprocedure('swarm.hosted_outcome_context()') AND r.rolname='swarm_admin' AND l.lanname='plpgsql' AND p.prosecdef=false
     AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND p.provolatile='v' AND p.prokind='f'
     AND NOT p.proisstrict AND NOT p.proleakproof AND p.proparallel='u' AND p.prosupport=0 AND p.procost=100
     AND pg_get_function_result(p.oid)='trigger' AND pg_get_function_identity_arguments(p.oid)=''
     AND p.prosrc='
DECLARE v_context uuid;
BEGIN
  v_context:=NULLIF(current_setting(''swarm.hosted_context_id'',true),'''')::uuid;
  IF TG_OP=''UPDATE'' AND NEW.context_id IS DISTINCT FROM OLD.context_id THEN RAISE EXCEPTION ''immutable outcome context'' USING ERRCODE=''55000''; END IF;
  IF TG_OP=''INSERT'' AND v_context IS NOT NULL THEN NEW.context_id:=v_context; END IF;
  RETURN NEW;
END
'
     AND regexp_replace(upper(pg_get_functiondef(p.oid)),'[[:space:];]','','g')=regexp_replace(upper('CREATE OR REPLACE FUNCTION swarm.hosted_outcome_context()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''pg_catalog''
AS $function$
DECLARE v_context uuid;
BEGIN
  v_context:=NULLIF(current_setting(''swarm.hosted_context_id'',true),'''')::uuid;
  IF TG_OP=''UPDATE'' AND NEW.context_id IS DISTINCT FROM OLD.context_id THEN RAISE EXCEPTION ''immutable outcome context'' USING ERRCODE=''55000''; END IF;
  IF TG_OP=''INSERT'' AND v_context IS NOT NULL THEN NEW.context_id:=v_context; END IF;
  RETURN NEW;
END
$function$;'),'[[:space:];]','','g')
     AND (SELECT array_agg(pg_get_userbyid(a.grantee)||':'||a.privilege_type||':'||pg_get_userbyid(a.grantor)||':'||a.is_grantable::text ORDER BY pg_get_userbyid(a.grantee)||':'||a.privilege_type||':'||pg_get_userbyid(a.grantor)||':'||a.is_grantable::text)
       FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a)='{swarm_admin:EXECUTE:swarm_admin:false}'::text[])),false)),
 ('swarm.hosted_event_context()',COALESCE((EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles r ON r.oid=p.proowner JOIN pg_catalog.pg_language l ON l.oid=p.prolang
   WHERE p.oid=to_regprocedure('swarm.hosted_event_context()') AND r.rolname='swarm_admin' AND l.lanname='plpgsql' AND p.prosecdef=false
     AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND p.provolatile='v' AND p.prokind='f'
     AND NOT p.proisstrict AND NOT p.proleakproof AND p.proparallel='u' AND p.prosupport=0 AND p.procost=100
     AND pg_get_function_result(p.oid)='trigger' AND pg_get_function_identity_arguments(p.oid)=''
     AND p.prosrc='
DECLARE v_context uuid; v_revoked timestamptz; v_principal_revoked timestamptz; v_seat swarm.hosted_mcp_seats;
BEGIN
  v_context:=NULLIF(current_setting(''swarm.hosted_context_id'',true),'''')::uuid;
  IF v_context IS NOT NULL THEN NEW.payload:=NEW.payload||jsonb_build_object(''context_id'',v_context); END IF;
  IF NEW.type=''HostedMcpSeatRevoked'' THEN
    SELECT * INTO v_seat FROM swarm.hosted_mcp_seats
      WHERE seat_id=(NEW.payload->>''seat_id'')::uuid AND workspace_id=NEW.workspace_id FOR UPDATE;
    IF v_seat.seat_id IS NULL OR v_seat.principal_id IS DISTINCT FROM (NEW.payload->>''principal_id'')::uuid
      OR v_seat.grant_id IS DISTINCT FROM (NEW.payload->>''grant_id'')::uuid
      OR jsonb_typeof(NEW.payload->''revoked_at'') IS DISTINCT FROM ''number'' THEN
      RAISE EXCEPTION ''invalid hosted retirement event'' USING ERRCODE=''23514'';
    END IF;
    v_revoked:=to_timestamp((NEW.payload->>''revoked_at'')::numeric/1000);
    v_principal_revoked:=to_timestamp(COALESCE(NEW.payload->>''principal_revoked_at'',NEW.payload->>''revoked_at'')::numeric/1000);
    UPDATE swarm.hosted_mcp_seats SET revoked_at=COALESCE(revoked_at,v_revoked)
      WHERE seat_id=v_seat.seat_id AND revoked_at IS NULL;
    UPDATE swarm.hosted_mcp_seat_handles SET revoked_at=COALESCE(revoked_at,v_revoked)
      WHERE seat_id=v_seat.seat_id AND revoked_at IS NULL;
    UPDATE swarm.agent_principals SET revoked_at=COALESCE(revoked_at,v_principal_revoked)
      WHERE principal_id=v_seat.principal_id AND revoked_at IS NULL;
  END IF;
  RETURN NEW;
END
'
     AND regexp_replace(upper(pg_get_functiondef(p.oid)),'[[:space:];]','','g')=regexp_replace(upper('CREATE OR REPLACE FUNCTION swarm.hosted_event_context()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''pg_catalog''
AS $function$
DECLARE v_context uuid; v_revoked timestamptz; v_principal_revoked timestamptz; v_seat swarm.hosted_mcp_seats;
BEGIN
  v_context:=NULLIF(current_setting(''swarm.hosted_context_id'',true),'''')::uuid;
  IF v_context IS NOT NULL THEN NEW.payload:=NEW.payload||jsonb_build_object(''context_id'',v_context); END IF;
  IF NEW.type=''HostedMcpSeatRevoked'' THEN
    SELECT * INTO v_seat FROM swarm.hosted_mcp_seats
      WHERE seat_id=(NEW.payload->>''seat_id'')::uuid AND workspace_id=NEW.workspace_id FOR UPDATE;
    IF v_seat.seat_id IS NULL OR v_seat.principal_id IS DISTINCT FROM (NEW.payload->>''principal_id'')::uuid
      OR v_seat.grant_id IS DISTINCT FROM (NEW.payload->>''grant_id'')::uuid
      OR jsonb_typeof(NEW.payload->''revoked_at'') IS DISTINCT FROM ''number'' THEN
      RAISE EXCEPTION ''invalid hosted retirement event'' USING ERRCODE=''23514'';
    END IF;
    v_revoked:=to_timestamp((NEW.payload->>''revoked_at'')::numeric/1000);
    v_principal_revoked:=to_timestamp(COALESCE(NEW.payload->>''principal_revoked_at'',NEW.payload->>''revoked_at'')::numeric/1000);
    UPDATE swarm.hosted_mcp_seats SET revoked_at=COALESCE(revoked_at,v_revoked)
      WHERE seat_id=v_seat.seat_id AND revoked_at IS NULL;
    UPDATE swarm.hosted_mcp_seat_handles SET revoked_at=COALESCE(revoked_at,v_revoked)
      WHERE seat_id=v_seat.seat_id AND revoked_at IS NULL;
    UPDATE swarm.agent_principals SET revoked_at=COALESCE(revoked_at,v_principal_revoked)
      WHERE principal_id=v_seat.principal_id AND revoked_at IS NULL;
  END IF;
  RETURN NEW;
END
$function$;'),'[[:space:];]','','g')
     AND (SELECT array_agg(pg_get_userbyid(a.grantee)||':'||a.privilege_type||':'||pg_get_userbyid(a.grantor)||':'||a.is_grantable::text ORDER BY pg_get_userbyid(a.grantee)||':'||a.privilege_type||':'||pg_get_userbyid(a.grantor)||':'||a.is_grantable::text)
       FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a)='{swarm_admin:EXECUTE:swarm_admin:false}'::text[])),false)),
 ('swarm.audit_hosted_authorization_denial(uuid, text, text)',COALESCE((EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles r ON r.oid=p.proowner JOIN pg_catalog.pg_language l ON l.oid=p.prolang
   WHERE p.oid=to_regprocedure('swarm.audit_hosted_authorization_denial(uuid, text, text)') AND r.rolname='swarm_admin' AND l.lanname='plpgsql' AND p.prosecdef=true
     AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND p.provolatile='v' AND p.prokind='f'
     AND NOT p.proisstrict AND NOT p.proleakproof AND p.proparallel='u' AND p.prosupport=0 AND p.procost=100
     AND pg_get_function_result(p.oid)='void' AND pg_get_function_identity_arguments(p.oid)='p_grant_id uuid, p_provider_id text, p_tool text'
     AND p.prosrc='
BEGIN
  IF length(p_tool)>80 THEN RAISE EXCEPTION ''invalid hosted audit tool''; END IF;
  INSERT INTO swarm.audit_log(credential_kind,credential_id,command_kind,outcome,reason,context_details)
    SELECT ''hosted_grant'',g.grant_id,p_tool,''authz'',''identity_resume_unavailable'',
      jsonb_build_object(''grant_id'',g.grant_id,''owner_user_id'',g.owner_user_id,''client_id'',g.client_id,''tool'',p_tool,''assurance'',''portable'')
    FROM swarm.hosted_mcp_grants g WHERE g.grant_id=p_grant_id AND g.provider_grant_id=p_provider_id;
END
'
     AND regexp_replace(upper(pg_get_functiondef(p.oid)),'[[:space:];]','','g')=regexp_replace(upper('CREATE OR REPLACE FUNCTION swarm.audit_hosted_authorization_denial(p_grant_id uuid, p_provider_id text, p_tool text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO ''pg_catalog''
AS $function$
BEGIN
  IF length(p_tool)>80 THEN RAISE EXCEPTION ''invalid hosted audit tool''; END IF;
  INSERT INTO swarm.audit_log(credential_kind,credential_id,command_kind,outcome,reason,context_details)
    SELECT ''hosted_grant'',g.grant_id,p_tool,''authz'',''identity_resume_unavailable'',
      jsonb_build_object(''grant_id'',g.grant_id,''owner_user_id'',g.owner_user_id,''client_id'',g.client_id,''tool'',p_tool,''assurance'',''portable'')
    FROM swarm.hosted_mcp_grants g WHERE g.grant_id=p_grant_id AND g.provider_grant_id=p_provider_id;
END
$function$;'),'[[:space:];]','','g')
     AND (SELECT array_agg(pg_get_userbyid(a.grantee)||':'||a.privilege_type||':'||pg_get_userbyid(a.grantor)||':'||a.is_grantable::text ORDER BY pg_get_userbyid(a.grantee)||':'||a.privilege_type||':'||pg_get_userbyid(a.grantor)||':'||a.is_grantable::text)
       FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a)='{swarm_admin:EXECUTE:swarm_admin:false,swarm_command:EXECUTE:swarm_admin:false,swarm_read:EXECUTE:swarm_admin:false}'::text[])),false)),
 ('swarm.hosted_household_event_context()',COALESCE((EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles r ON r.oid=p.proowner JOIN pg_catalog.pg_language l ON l.oid=p.prolang
   WHERE p.oid=to_regprocedure('swarm.hosted_household_event_context()') AND r.rolname='swarm_admin' AND l.lanname='plpgsql' AND p.prosecdef=false
     AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND p.provolatile='v' AND p.prokind='f'
     AND NOT p.proisstrict AND NOT p.proleakproof AND p.proparallel='u' AND p.prosupport=0 AND p.procost=100
     AND pg_get_function_result(p.oid)='trigger' AND pg_get_function_identity_arguments(p.oid)=''
     AND p.prosrc='
DECLARE v_context uuid;
BEGIN
  v_context:=NULLIF(current_setting(''swarm.hosted_context_id'',true),'''')::uuid;
  IF v_context IS NOT NULL THEN NEW.event:=NEW.event||jsonb_build_object(''context_id'',v_context); END IF;
  RETURN NEW;
END
'
     AND regexp_replace(upper(pg_get_functiondef(p.oid)),'[[:space:];]','','g')=regexp_replace(upper('CREATE OR REPLACE FUNCTION swarm.hosted_household_event_context()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''pg_catalog''
AS $function$
DECLARE v_context uuid;
BEGIN
  v_context:=NULLIF(current_setting(''swarm.hosted_context_id'',true),'''')::uuid;
  IF v_context IS NOT NULL THEN NEW.event:=NEW.event||jsonb_build_object(''context_id'',v_context); END IF;
  RETURN NEW;
END
$function$;'),'[[:space:];]','','g')
     AND (SELECT array_agg(pg_get_userbyid(a.grantee)||':'||a.privilege_type||':'||pg_get_userbyid(a.grantor)||':'||a.is_grantable::text ORDER BY pg_get_userbyid(a.grantee)||':'||a.privilege_type||':'||pg_get_userbyid(a.grantor)||':'||a.is_grantable::text)
       FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a)='{swarm_admin:EXECUTE:swarm_admin:false}'::text[])),false)),
 ('hosted_mcp_seats_current_identity',COALESCE((EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conrelid=to_regclass('swarm.hosted_mcp_seats') AND c.conname='hosted_mcp_seats_current_identity' AND c.convalidated AND NOT c.condeferrable AND NOT c.condeferred AND pg_get_constraintdef(c.oid)='UNIQUE (seat_id, workspace_id, principal_id)')),false)),
 ('hosted_mcp_check_cursors_identity',COALESCE((EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conrelid=to_regclass('swarm.hosted_mcp_check_cursors') AND c.conname='hosted_mcp_check_cursors_identity' AND c.convalidated AND NOT c.condeferrable AND NOT c.condeferred AND pg_get_constraintdef(c.oid)='UNIQUE (seat_id, workspace_id, principal_id)')),false)),
 ('hosted_contexts_identity',COALESCE((EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conrelid=to_regclass('swarm.hosted_agent_contexts') AND c.conname='hosted_contexts_identity' AND c.convalidated AND NOT c.condeferrable AND NOT c.condeferred AND pg_get_constraintdef(c.oid)='UNIQUE (context_id, seat_id)')),false)),
 ('hosted_handles_identity',COALESCE((EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conrelid=to_regclass('swarm.hosted_mcp_seat_handles') AND c.conname='hosted_handles_identity' AND c.convalidated AND NOT c.condeferrable AND NOT c.condeferred AND pg_get_constraintdef(c.oid)='FOREIGN KEY (seat_id, workspace_id, principal_id) REFERENCES swarm.hosted_mcp_seats(seat_id, workspace_id, principal_id)')),false)),
 ('hosted_cursors_identity',COALESCE((EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conrelid=to_regclass('swarm.hosted_mcp_check_cursors') AND c.conname='hosted_cursors_identity' AND c.convalidated AND NOT c.condeferrable AND NOT c.condeferred AND pg_get_constraintdef(c.oid)='FOREIGN KEY (seat_id, workspace_id, principal_id) REFERENCES swarm.hosted_mcp_seats(seat_id, workspace_id, principal_id)')),false)),
 ('hosted_batches_identity',COALESCE((EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conrelid=to_regclass('swarm.hosted_mcp_check_batches') AND c.conname='hosted_batches_identity' AND c.convalidated AND NOT c.condeferrable AND NOT c.condeferred AND pg_get_constraintdef(c.oid)='FOREIGN KEY (seat_id, workspace_id, principal_id) REFERENCES swarm.hosted_mcp_seats(seat_id, workspace_id, principal_id)')),false)),
 ('hosted_batches_cursor',COALESCE((EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conrelid=to_regclass('swarm.hosted_mcp_check_batches') AND c.conname='hosted_batches_cursor' AND c.convalidated AND NOT c.condeferrable AND NOT c.condeferred AND pg_get_constraintdef(c.oid)='FOREIGN KEY (seat_id, workspace_id, principal_id) REFERENCES swarm.hosted_mcp_check_cursors(seat_id, workspace_id, principal_id)')),false)),
 ('hosted_batches_context',COALESCE((EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conrelid=to_regclass('swarm.hosted_mcp_check_batches') AND c.conname='hosted_batches_context' AND c.convalidated AND NOT c.condeferrable AND NOT c.condeferred AND pg_get_constraintdef(c.oid)='FOREIGN KEY (context_id, seat_id) REFERENCES swarm.hosted_agent_contexts(context_id, seat_id)')),false)),
 ('audit_log_context_id_fkey',COALESCE((EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conrelid=to_regclass('swarm.audit_log') AND c.conname='audit_log_context_id_fkey' AND c.convalidated AND NOT c.condeferrable AND NOT c.condeferred AND pg_get_constraintdef(c.oid)='FOREIGN KEY (context_id) REFERENCES swarm.hosted_agent_contexts(context_id)')),false)),
 ('idempotency_keys_context_id_fkey',COALESCE((EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conrelid=to_regclass('swarm.idempotency_keys') AND c.conname='idempotency_keys_context_id_fkey' AND c.convalidated AND NOT c.condeferrable AND NOT c.condeferred AND pg_get_constraintdef(c.oid)='FOREIGN KEY (context_id) REFERENCES swarm.hosted_agent_contexts(context_id)')),false)),
 ('hosted_batches_cancel',COALESCE((EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conrelid=to_regclass('swarm.hosted_mcp_check_batches') AND c.conname='hosted_batches_cancel' AND c.convalidated AND NOT c.condeferrable AND NOT c.condeferred AND pg_get_constraintdef(c.oid)='CHECK ((((cancelled_at IS NULL) AND (cancel_reason IS NULL)) OR ((cancelled_at IS NOT NULL) AND (cancel_reason = ANY (ARRAY[''closed''::text, ''expired''::text])) AND (acknowledged_at IS NULL) AND (cancelled_at >= created_at))))')),false)),
 ('hosted_handles_issued_grant',COALESCE((EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conrelid=to_regclass('swarm.hosted_mcp_seat_handles') AND c.conname='hosted_handles_issued_grant' AND c.convalidated AND NOT c.condeferrable AND NOT c.condeferred AND pg_get_constraintdef(c.oid)='FOREIGN KEY (grant_id) REFERENCES swarm.hosted_mcp_grants(grant_id)')),false)),
 ('hosted_cursors_issued_grant',COALESCE((EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conrelid=to_regclass('swarm.hosted_mcp_check_cursors') AND c.conname='hosted_cursors_issued_grant' AND c.convalidated AND NOT c.condeferrable AND NOT c.condeferred AND pg_get_constraintdef(c.oid)='FOREIGN KEY (grant_id) REFERENCES swarm.hosted_mcp_grants(grant_id)')),false)),
 ('hosted_batches_issued_grant',COALESCE((EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conrelid=to_regclass('swarm.hosted_mcp_check_batches') AND c.conname='hosted_batches_issued_grant' AND c.convalidated AND NOT c.condeferrable AND NOT c.condeferred AND pg_get_constraintdef(c.oid)='FOREIGN KEY (grant_id) REFERENCES swarm.hosted_mcp_grants(grant_id)')),false)),
 ('hosted_mcp_check_batches.context_id',COALESCE((EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('swarm.hosted_mcp_check_batches') AND a.attname='context_id' AND a.atttypid='uuid'::regtype AND NOT a.attnotnull AND NOT a.attisdropped AND a.attacl IS NULL AND NOT EXISTS(SELECT 1 FROM pg_attrdef d WHERE d.adrelid=a.attrelid AND d.adnum=a.attnum))),false)),
 ('hosted_mcp_check_batches.cancelled_at',COALESCE((EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('swarm.hosted_mcp_check_batches') AND a.attname='cancelled_at' AND a.atttypid='timestamptz'::regtype AND NOT a.attnotnull AND NOT a.attisdropped AND a.attacl IS NULL AND NOT EXISTS(SELECT 1 FROM pg_attrdef d WHERE d.adrelid=a.attrelid AND d.adnum=a.attnum))),false)),
 ('hosted_mcp_check_batches.cancel_reason',COALESCE((EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('swarm.hosted_mcp_check_batches') AND a.attname='cancel_reason' AND a.atttypid='text'::regtype AND NOT a.attnotnull AND NOT a.attisdropped AND a.attacl IS NULL AND NOT EXISTS(SELECT 1 FROM pg_attrdef d WHERE d.adrelid=a.attrelid AND d.adnum=a.attnum))),false)),
 ('audit_log.context_id',COALESCE((EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('swarm.audit_log') AND a.attname='context_id' AND a.atttypid='uuid'::regtype AND NOT a.attnotnull AND NOT a.attisdropped AND a.attacl IS NULL AND NOT EXISTS(SELECT 1 FROM pg_attrdef d WHERE d.adrelid=a.attrelid AND d.adnum=a.attnum))),false)),
 ('audit_log.context_details',COALESCE((EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('swarm.audit_log') AND a.attname='context_details' AND a.atttypid='jsonb'::regtype AND NOT a.attnotnull AND NOT a.attisdropped AND a.attacl IS NULL AND NOT EXISTS(SELECT 1 FROM pg_attrdef d WHERE d.adrelid=a.attrelid AND d.adnum=a.attnum))),false)),
 ('idempotency_keys.context_id',COALESCE((EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('swarm.idempotency_keys') AND a.attname='context_id' AND a.atttypid='uuid'::regtype AND NOT a.attnotnull AND NOT a.attisdropped AND a.attacl IS NULL AND NOT EXISTS(SELECT 1 FROM pg_attrdef d WHERE d.adrelid=a.attrelid AND d.adnum=a.attnum))),false)),
 ('hosted_mcp_check_batches_one_active',COALESCE((EXISTS(SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE i.indexrelid=to_regclass('swarm.hosted_mcp_check_batches_one_active') AND i.indisvalid AND i.indisready AND c.relowner=(SELECT oid FROM pg_roles WHERE rolname='swarm_admin') AND pg_get_indexdef(i.indexrelid)='CREATE UNIQUE INDEX hosted_mcp_check_batches_one_active ON swarm.hosted_mcp_check_batches USING btree (context_id) WHERE ((acknowledged_at IS NULL) AND (cancelled_at IS NULL) AND (context_id IS NOT NULL))')),false)),
 ('hosted_mcp_check_batches_legacy_active',COALESCE((EXISTS(SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE i.indexrelid=to_regclass('swarm.hosted_mcp_check_batches_legacy_active') AND i.indisvalid AND i.indisready AND c.relowner=(SELECT oid FROM pg_roles WHERE rolname='swarm_admin') AND pg_get_indexdef(i.indexrelid)='CREATE UNIQUE INDEX hosted_mcp_check_batches_legacy_active ON swarm.hosted_mcp_check_batches USING btree (seat_id) WHERE ((acknowledged_at IS NULL) AND (cancelled_at IS NULL) AND (context_id IS NULL))')),false)),
 ('hosted_outcomes_context',COALESCE((EXISTS(SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE i.indexrelid=to_regclass('swarm.hosted_outcomes_context') AND i.indisvalid AND i.indisready AND c.relowner=(SELECT oid FROM pg_roles WHERE rolname='swarm_admin') AND pg_get_indexdef(i.indexrelid)='CREATE INDEX hosted_outcomes_context ON swarm.idempotency_keys USING btree (context_id) WHERE (context_id IS NOT NULL)')),false)),
 ('hosted_audit_context',COALESCE((EXISTS(SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE i.indexrelid=to_regclass('swarm.hosted_audit_context') AND i.indisvalid AND i.indisready AND c.relowner=(SELECT oid FROM pg_roles WHERE rolname='swarm_admin') AND pg_get_indexdef(i.indexrelid)='CREATE INDEX hosted_audit_context ON swarm.audit_log USING btree (context_id, occurred_at) WHERE (context_id IS NOT NULL)')),false)),
 ('hosted_household_event_context.trigger',COALESCE((EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass('swarm.household_object_events') AND t.tgname='hosted_household_event_context' AND NOT t.tgisinternal AND t.tgenabled='O' AND pg_get_triggerdef(t.oid)='CREATE TRIGGER hosted_household_event_context BEFORE INSERT ON swarm.household_object_events FOR EACH ROW EXECUTE FUNCTION swarm.hosted_household_event_context()')),false)),
 ('hosted_household_event_context.trigger',COALESCE((EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass('swarm.household_todo_events') AND t.tgname='hosted_household_event_context' AND NOT t.tgisinternal AND t.tgenabled='O' AND pg_get_triggerdef(t.oid)='CREATE TRIGGER hosted_household_event_context BEFORE INSERT ON swarm.household_todo_events FOR EACH ROW EXECUTE FUNCTION swarm.hosted_household_event_context()')),false)),
 ('hosted_event_context.trigger',COALESCE((EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass('swarm.events') AND t.tgname='hosted_event_context' AND NOT t.tgisinternal AND t.tgenabled='O' AND pg_get_triggerdef(t.oid)='CREATE TRIGGER hosted_event_context BEFORE INSERT ON swarm.events FOR EACH ROW EXECUTE FUNCTION swarm.hosted_event_context()')),false)),
 ('hosted_outcome_context.trigger',COALESCE((EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass('swarm.idempotency_keys') AND t.tgname='hosted_outcome_context' AND NOT t.tgisinternal AND t.tgenabled='O' AND pg_get_triggerdef(t.oid)='CREATE TRIGGER hosted_outcome_context BEFORE INSERT OR UPDATE ON swarm.idempotency_keys FOR EACH ROW EXECUTE FUNCTION swarm.hosted_outcome_context()')),false)),
 ('hosted_legacy_handle_guard.trigger',COALESCE((EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass('swarm.hosted_mcp_seat_handles') AND t.tgname='hosted_legacy_handle_guard' AND NOT t.tgisinternal AND t.tgenabled='O' AND pg_get_triggerdef(t.oid)='CREATE TRIGGER hosted_legacy_handle_guard BEFORE INSERT OR DELETE OR UPDATE ON swarm.hosted_mcp_seat_handles FOR EACH ROW EXECUTE FUNCTION swarm.hosted_legacy_handle_guard()')),false)),
 ('hosted_context_guard.trigger',COALESCE((EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass('swarm.hosted_agent_contexts') AND t.tgname='hosted_context_guard' AND NOT t.tgisinternal AND t.tgenabled='O' AND pg_get_triggerdef(t.oid)='CREATE TRIGGER hosted_context_guard BEFORE DELETE OR UPDATE ON swarm.hosted_agent_contexts FOR EACH ROW EXECUTE FUNCTION swarm.hosted_context_guard()')),false)),
 ('hosted_mcp_check_cursors_guard.trigger',COALESCE((EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass('swarm.hosted_mcp_check_cursors') AND t.tgname='hosted_mcp_check_cursors_guard' AND NOT t.tgisinternal AND t.tgenabled='O' AND pg_get_triggerdef(t.oid)='CREATE TRIGGER hosted_mcp_check_cursors_guard BEFORE INSERT OR DELETE OR UPDATE ON swarm.hosted_mcp_check_cursors FOR EACH ROW EXECUTE FUNCTION swarm.hosted_mcp_check_cursors_guard()')),false)),
 ('hosted_mcp_check_batches_guard.trigger',COALESCE((EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass('swarm.hosted_mcp_check_batches') AND t.tgname='hosted_mcp_check_batches_guard' AND NOT t.tgisinternal AND t.tgenabled='O' AND pg_get_triggerdef(t.oid)='CREATE TRIGGER hosted_mcp_check_batches_guard BEFORE INSERT OR DELETE OR UPDATE ON swarm.hosted_mcp_check_batches FOR EACH ROW EXECUTE FUNCTION swarm.hosted_mcp_check_batches_guard()')),false)),
 ('cron.job',COALESCE((CASE WHEN to_regclass('cron.job') IS NULL THEN false ELSE (xpath('/table/row/n/text()',query_to_xml('SELECT count(*) AS n FROM cron.job WHERE jobname=''hosted-agent-context-expiry'' AND schedule=''*/5 * * * *'' AND command=''SELECT swarm.sweep_hosted_agent_contexts()'' AND active AND database=current_database() AND username=current_user',false,true,'')))[1]::text='1' END),false)),
 ('agent_principals.view',COALESCE((EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=to_regclass('swarm_read.agent_principals') AND c.relkind='v' AND c.relowner=(SELECT oid FROM pg_roles WHERE rolname='swarm_admin') AND c.reloptions=ARRAY['security_barrier=true']::text[] AND regexp_replace(pg_get_viewdef(c.oid,false),'[[:space:]]','','g')=regexp_replace('SELECT p.principal_id, p.workspace_id, p.owner_user_id, p.name, p.created_at, p.revoked_at, p.model, p.managed_at, p.transport, p.turn_only, p.identity_lifetime, COALESCE((swarm.hosted_principal_context_summary(p.principal_id) ->> ''display_name''::text), p.name) AS display_name, (swarm.hosted_principal_context_summary(p.principal_id) ->> ''disambiguator''::text) AS disambiguator, (swarm.hosted_principal_context_summary(p.principal_id) -> ''app''::text) AS app, (swarm.hosted_principal_context_summary(p.principal_id) - ARRAY[''display_name''::text, ''disambiguator''::text, ''app''::text]) AS context_activity FROM swarm.agent_principals p WHERE (swarm.is_member(p.workspace_id, auth.uid()) AND (NOT (EXISTS (SELECT 1 FROM swarm.agent_join_credentials c WHERE (c.registrar_principal_id = p.principal_id)))));','[[:space:]]','','g'))),false)),
 ('hosted_mcp_check_cursors.owner_rls_acl',COALESCE((EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=to_regclass('swarm.hosted_mcp_check_cursors') AND c.relowner=(SELECT oid FROM pg_roles WHERE rolname='swarm_admin') AND c.relrowsecurity AND NOT c.relforcerowsecurity AND (SELECT array_agg(pg_get_userbyid(a.grantee)||':'||a.privilege_type||':'||pg_get_userbyid(a.grantor)||':'||a.is_grantable::text ORDER BY pg_get_userbyid(a.grantee)||':'||a.privilege_type||':'||pg_get_userbyid(a.grantor)||':'||a.is_grantable::text) FROM aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a)=(SELECT array_agg(permission ORDER BY permission) FROM (SELECT pg_get_userbyid(a.grantee)||':'||a.privilege_type||':swarm_admin:false' AS permission FROM aclexplode(acldefault('r',(SELECT oid FROM pg_roles WHERE rolname='swarm_admin'))) a UNION ALL SELECT unnest('{swarm_command:SELECT:swarm_admin:false,swarm_command:INSERT:swarm_admin:false,swarm_command:UPDATE:swarm_admin:false}'::text[])) expected_acl))),false)),
 ('hosted_mcp_check_batches.owner_rls_acl',COALESCE((EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=to_regclass('swarm.hosted_mcp_check_batches') AND c.relowner=(SELECT oid FROM pg_roles WHERE rolname='swarm_admin') AND c.relrowsecurity AND NOT c.relforcerowsecurity AND (SELECT array_agg(pg_get_userbyid(a.grantee)||':'||a.privilege_type||':'||pg_get_userbyid(a.grantor)||':'||a.is_grantable::text ORDER BY pg_get_userbyid(a.grantee)||':'||a.privilege_type||':'||pg_get_userbyid(a.grantor)||':'||a.is_grantable::text) FROM aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a)=(SELECT array_agg(permission ORDER BY permission) FROM (SELECT pg_get_userbyid(a.grantee)||':'||a.privilege_type||':swarm_admin:false' AS permission FROM aclexplode(acldefault('r',(SELECT oid FROM pg_roles WHERE rolname='swarm_admin'))) a UNION ALL SELECT unnest('{swarm_command:SELECT:swarm_admin:false,swarm_command:INSERT:swarm_admin:false,swarm_command:UPDATE:swarm_admin:false}'::text[])) expected_acl))),false)),
 ('idempotency_keys.owner_rls_acl',COALESCE((EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=to_regclass('swarm.idempotency_keys') AND c.relowner=(SELECT oid FROM pg_roles WHERE rolname='swarm_admin') AND c.relrowsecurity AND NOT c.relforcerowsecurity AND (SELECT array_agg(pg_get_userbyid(a.grantee)||':'||a.privilege_type||':'||pg_get_userbyid(a.grantor)||':'||a.is_grantable::text ORDER BY pg_get_userbyid(a.grantee)||':'||a.privilege_type||':'||pg_get_userbyid(a.grantor)||':'||a.is_grantable::text) FROM aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a)=(SELECT array_agg(permission ORDER BY permission) FROM (SELECT pg_get_userbyid(a.grantee)||':'||a.privilege_type||':swarm_admin:false' AS permission FROM aclexplode(acldefault('r',(SELECT oid FROM pg_roles WHERE rolname='swarm_admin'))) a UNION ALL SELECT unnest('{swarm_command:SELECT:swarm_admin:false,swarm_command:INSERT:swarm_admin:false,swarm_command:UPDATE:swarm_admin:false}'::text[])) expected_acl))),false)),
 ('audit_log.owner_rls_acl',COALESCE((EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=to_regclass('swarm.audit_log') AND c.relowner=(SELECT oid FROM pg_roles WHERE rolname='swarm_admin') AND c.relrowsecurity AND NOT c.relforcerowsecurity AND (SELECT array_agg(pg_get_userbyid(a.grantee)||':'||a.privilege_type||':'||pg_get_userbyid(a.grantor)||':'||a.is_grantable::text ORDER BY pg_get_userbyid(a.grantee)||':'||a.privilege_type||':'||pg_get_userbyid(a.grantor)||':'||a.is_grantable::text) FROM aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a)=(SELECT array_agg(permission ORDER BY permission) FROM (SELECT pg_get_userbyid(a.grantee)||':'||a.privilege_type||':swarm_admin:false' AS permission FROM aclexplode(acldefault('r',(SELECT oid FROM pg_roles WHERE rolname='swarm_admin'))) a UNION ALL SELECT unnest('{swarm_command:INSERT:swarm_admin:false}'::text[])) expected_acl))),false)),
 ('agent_principals.view_acl',COALESCE((EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=to_regclass('swarm_read.agent_principals') AND NOT EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped AND a.attacl IS NOT NULL) AND (SELECT array_agg(pg_get_userbyid(a.grantee)||':'||a.privilege_type||':'||pg_get_userbyid(a.grantor)||':'||a.is_grantable::text ORDER BY pg_get_userbyid(a.grantee)||':'||a.privilege_type||':'||pg_get_userbyid(a.grantor)||':'||a.is_grantable::text) FROM aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a)=(SELECT array_agg(permission ORDER BY permission) FROM (SELECT pg_get_userbyid(a.grantee)||':'||a.privilege_type||':swarm_admin:false' AS permission FROM aclexplode(acldefault('r',(SELECT oid FROM pg_roles WHERE rolname='swarm_admin'))) a UNION ALL SELECT unnest(ARRAY['authenticated:SELECT:swarm_admin:false','swarm_read:SELECT:swarm_admin:false'])) expected_acl))),false)),
 ('hosted_mcp_check_cursors.policy',COALESCE(((SELECT count(*) FROM pg_policy WHERE polrelid=to_regclass('swarm.hosted_mcp_check_cursors'))=1 AND EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=to_regclass('swarm.hosted_mcp_check_cursors') AND p.polname='swarm_command_all' AND p.polcmd='*' AND p.polpermissive AND p.polroles=ARRAY[(SELECT oid FROM pg_roles WHERE rolname='swarm_command')] AND pg_get_expr(p.polqual,p.polrelid)='true' AND pg_get_expr(p.polwithcheck,p.polrelid)='true')),false)),
 ('hosted_mcp_check_batches.policy',COALESCE(((SELECT count(*) FROM pg_policy WHERE polrelid=to_regclass('swarm.hosted_mcp_check_batches'))=1 AND EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=to_regclass('swarm.hosted_mcp_check_batches') AND p.polname='swarm_command_all' AND p.polcmd='*' AND p.polpermissive AND p.polroles=ARRAY[(SELECT oid FROM pg_roles WHERE rolname='swarm_command')] AND pg_get_expr(p.polqual,p.polrelid)='true' AND pg_get_expr(p.polwithcheck,p.polrelid)='true')),false)),
 ('idempotency_keys.policy',COALESCE(((SELECT count(*) FROM pg_policy WHERE polrelid=to_regclass('swarm.idempotency_keys'))=1 AND EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid=to_regclass('swarm.idempotency_keys') AND p.polname='swarm_command_all' AND p.polcmd='*' AND p.polpermissive AND p.polroles=ARRAY[(SELECT oid FROM pg_roles WHERE rolname='swarm_command')] AND pg_get_expr(p.polqual,p.polrelid)='true' AND pg_get_expr(p.polwithcheck,p.polrelid)='true')),false)))
SELECT COALESCE((SELECT bool_and(ok) FROM (SELECT ok FROM checks UNION ALL SELECT ok FROM lifecycle_checks) all_checks),false) AS catalog_ok
\gset
