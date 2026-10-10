-- Source-built prerequisite/reserve proof, at 539b5e83 schema.
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
), lifecycle_checks(name,ok) AS (VALUES
 ('resolve_hosted_seat_command_authorization.preimage',COALESCE((EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles r ON r.oid=p.proowner JOIN pg_catalog.pg_language l ON l.oid=p.prolang
   WHERE p.oid=to_regprocedure('swarm.resolve_hosted_seat_command_authorization(uuid, text, text)') AND r.rolname='swarm_admin' AND l.lanname='sql' AND p.prosecdef=true
     AND p.proconfig=ARRAY['search_path=swarm, pg_catalog']::text[] AND p.provolatile='s' AND p.prokind='f'
     AND NOT p.proisstrict AND NOT p.proleakproof AND p.proparallel='u' AND p.prosupport=0 AND p.procost=100
     AND regexp_replace(pg_get_function_result(p.oid),'[[:space:]]','','g')=regexp_replace('TABLE( grant_id uuid, provider_grant_id text, seat_id uuid, handle text, workspace_id uuid, stream_id uuid, owner_user_id uuid, principal_id uuid, name text )','[[:space:]]','','g') AND pg_get_function_identity_arguments(p.oid)='p_grant_id uuid, p_handle text, p_tool text'
     AND p.prosrc='
  SELECT g.grant_id, g.provider_grant_id, hs.seat_id, h.handle,
         hs.workspace_id, st.stream_id, hs.owner_user_id,
         hs.principal_id, hs.name
  FROM swarm.hosted_mcp_grants AS g
  JOIN swarm.hosted_mcp_grant_workspaces AS c
    ON c.grant_id = g.grant_id AND c.revoked_at IS NULL
  JOIN swarm.hosted_mcp_seats AS hs
    ON hs.grant_id = c.grant_id AND hs.workspace_id = c.workspace_id
   AND hs.owner_user_id = g.owner_user_id AND hs.revoked_at IS NULL
  JOIN swarm.hosted_mcp_seat_handles AS h
    ON h.seat_id = hs.seat_id AND h.grant_id = hs.grant_id
   AND h.workspace_id = hs.workspace_id AND h.principal_id = hs.principal_id
   AND h.revoked_at IS NULL
  JOIN swarm.agent_principals AS p
    ON p.principal_id = hs.principal_id AND p.workspace_id = hs.workspace_id
   AND p.owner_user_id = hs.owner_user_id AND p.revoked_at IS NULL
   AND p.transport = ''hosted_mcp'' AND p.turn_only = true
  JOIN swarm.workspaces AS w
    ON w.workspace_id = hs.workspace_id AND w.archived_at IS NULL
  JOIN swarm.memberships AS m
    ON m.workspace_id = hs.workspace_id AND m.user_id = hs.owner_user_id
   AND m.revoked_at IS NULL
  JOIN swarm.streams AS st
    ON st.workspace_id = hs.workspace_id AND st.kind = ''workspace''
  WHERE p_tool IN (''ask'', ''note'', ''reply'', ''working_on'')
    AND g.grant_id = p_grant_id AND h.handle = p_handle
    AND g.state = ''active'' AND g.revoked_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM swarm.revocation_tombstones AS t
      WHERE (t.kind = ''membership'' AND t.target_id = hs.owner_user_id)
         OR (t.kind = ''principal'' AND t.target_id = hs.principal_id)
         OR (t.kind = ''hosted_grant'' AND t.target_id = hs.grant_id)
         OR (t.kind = ''hosted_seat'' AND t.target_id = hs.seat_id)
    )
'
     AND regexp_replace(upper(pg_get_functiondef(p.oid)),'[[:space:];]','','g')=regexp_replace(upper('CREATE OR REPLACE FUNCTION swarm.resolve_hosted_seat_command_authorization(
  p_grant_id uuid,
  p_handle text,
  p_tool text
)
RETURNS TABLE (
  grant_id uuid,
  provider_grant_id text,
  seat_id uuid,
  handle text,
  workspace_id uuid,
  stream_id uuid,
  owner_user_id uuid,
  principal_id uuid,
  name text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''swarm'', ''pg_catalog''
AS $function$
  SELECT g.grant_id, g.provider_grant_id, hs.seat_id, h.handle,
         hs.workspace_id, st.stream_id, hs.owner_user_id,
         hs.principal_id, hs.name
  FROM swarm.hosted_mcp_grants AS g
  JOIN swarm.hosted_mcp_grant_workspaces AS c
    ON c.grant_id = g.grant_id AND c.revoked_at IS NULL
  JOIN swarm.hosted_mcp_seats AS hs
    ON hs.grant_id = c.grant_id AND hs.workspace_id = c.workspace_id
   AND hs.owner_user_id = g.owner_user_id AND hs.revoked_at IS NULL
  JOIN swarm.hosted_mcp_seat_handles AS h
    ON h.seat_id = hs.seat_id AND h.grant_id = hs.grant_id
   AND h.workspace_id = hs.workspace_id AND h.principal_id = hs.principal_id
   AND h.revoked_at IS NULL
  JOIN swarm.agent_principals AS p
    ON p.principal_id = hs.principal_id AND p.workspace_id = hs.workspace_id
   AND p.owner_user_id = hs.owner_user_id AND p.revoked_at IS NULL
   AND p.transport = ''hosted_mcp'' AND p.turn_only = true
  JOIN swarm.workspaces AS w
    ON w.workspace_id = hs.workspace_id AND w.archived_at IS NULL
  JOIN swarm.memberships AS m
    ON m.workspace_id = hs.workspace_id AND m.user_id = hs.owner_user_id
   AND m.revoked_at IS NULL
  JOIN swarm.streams AS st
    ON st.workspace_id = hs.workspace_id AND st.kind = ''workspace''
  WHERE p_tool IN (''ask'', ''note'', ''reply'', ''working_on'')
    AND g.grant_id = p_grant_id AND h.handle = p_handle
    AND g.state = ''active'' AND g.revoked_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM swarm.revocation_tombstones AS t
      WHERE (t.kind = ''membership'' AND t.target_id = hs.owner_user_id)
         OR (t.kind = ''principal'' AND t.target_id = hs.principal_id)
         OR (t.kind = ''hosted_grant'' AND t.target_id = hs.grant_id)
         OR (t.kind = ''hosted_seat'' AND t.target_id = hs.seat_id)
    )
$function$;'),'[[:space:];]','','g')
     AND (SELECT array_agg(pg_get_userbyid(a.grantee)||':'||a.privilege_type||':'||pg_get_userbyid(a.grantor)||':'||a.is_grantable::text ORDER BY pg_get_userbyid(a.grantee)||':'||a.privilege_type||':'||pg_get_userbyid(a.grantor)||':'||a.is_grantable::text)
       FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a)='{swarm_admin:EXECUTE:swarm_admin:false,swarm_command:EXECUTE:swarm_admin:false}'::text[])),false)),
 ('resolve_hosted_seat_read_authorization.preimage',COALESCE((EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles r ON r.oid=p.proowner JOIN pg_catalog.pg_language l ON l.oid=p.prolang
   WHERE p.oid=to_regprocedure('swarm.resolve_hosted_seat_read_authorization(uuid, text, text)') AND r.rolname='swarm_admin' AND l.lanname='sql' AND p.prosecdef=true
     AND p.proconfig=ARRAY['search_path=swarm, pg_catalog']::text[] AND p.provolatile='s' AND p.prokind='f'
     AND NOT p.proisstrict AND NOT p.proleakproof AND p.proparallel='u' AND p.prosupport=0 AND p.procost=100
     AND regexp_replace(pg_get_function_result(p.oid),'[[:space:]]','','g')=regexp_replace('TABLE( grant_id uuid, provider_grant_id text, seat_id uuid, handle text, workspace_id uuid, stream_id uuid, owner_user_id uuid, principal_id uuid, name text )','[[:space:]]','','g') AND pg_get_function_identity_arguments(p.oid)='p_grant_id uuid, p_handle text, p_tool text'
     AND p.prosrc='
  SELECT g.grant_id, g.provider_grant_id, hs.seat_id, h.handle,
         hs.workspace_id, st.stream_id, hs.owner_user_id,
         hs.principal_id, hs.name
  FROM swarm.hosted_mcp_grants AS g
  JOIN swarm.hosted_mcp_grant_workspaces AS c
    ON c.grant_id = g.grant_id AND c.revoked_at IS NULL
  JOIN swarm.hosted_mcp_seats AS hs
    ON hs.grant_id = c.grant_id AND hs.workspace_id = c.workspace_id
   AND hs.owner_user_id = g.owner_user_id AND hs.revoked_at IS NULL
  JOIN swarm.hosted_mcp_seat_handles AS h
    ON h.seat_id = hs.seat_id AND h.grant_id = hs.grant_id
   AND h.workspace_id = hs.workspace_id AND h.principal_id = hs.principal_id
   AND h.revoked_at IS NULL
  JOIN swarm.agent_principals AS p
    ON p.principal_id = hs.principal_id AND p.workspace_id = hs.workspace_id
   AND p.owner_user_id = hs.owner_user_id AND p.revoked_at IS NULL
   AND p.transport = ''hosted_mcp'' AND p.turn_only = true
  JOIN swarm.workspaces AS w
    ON w.workspace_id = hs.workspace_id AND w.archived_at IS NULL
  JOIN swarm.memberships AS m
    ON m.workspace_id = hs.workspace_id AND m.user_id = hs.owner_user_id
   AND m.revoked_at IS NULL
  JOIN swarm.streams AS st
    ON st.workspace_id = hs.workspace_id AND st.kind = ''workspace''
  WHERE p_tool IN (''whoami'', ''members'', ''check'')
    AND g.grant_id = p_grant_id AND h.handle = p_handle
    AND g.state = ''active'' AND g.revoked_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM swarm.revocation_tombstones AS t
      WHERE (t.kind = ''membership'' AND t.target_id = hs.owner_user_id)
         OR (t.kind = ''principal'' AND t.target_id = hs.principal_id)
         OR (t.kind = ''hosted_grant'' AND t.target_id = hs.grant_id)
         OR (t.kind = ''hosted_seat'' AND t.target_id = hs.seat_id)
    )
'
     AND regexp_replace(upper(pg_get_functiondef(p.oid)),'[[:space:];]','','g')=regexp_replace(upper('CREATE OR REPLACE FUNCTION swarm.resolve_hosted_seat_read_authorization(
  p_grant_id uuid,
  p_handle text,
  p_tool text
)
RETURNS TABLE (
  grant_id uuid,
  provider_grant_id text,
  seat_id uuid,
  handle text,
  workspace_id uuid,
  stream_id uuid,
  owner_user_id uuid,
  principal_id uuid,
  name text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''swarm'', ''pg_catalog''
AS $function$
  SELECT g.grant_id, g.provider_grant_id, hs.seat_id, h.handle,
         hs.workspace_id, st.stream_id, hs.owner_user_id,
         hs.principal_id, hs.name
  FROM swarm.hosted_mcp_grants AS g
  JOIN swarm.hosted_mcp_grant_workspaces AS c
    ON c.grant_id = g.grant_id AND c.revoked_at IS NULL
  JOIN swarm.hosted_mcp_seats AS hs
    ON hs.grant_id = c.grant_id AND hs.workspace_id = c.workspace_id
   AND hs.owner_user_id = g.owner_user_id AND hs.revoked_at IS NULL
  JOIN swarm.hosted_mcp_seat_handles AS h
    ON h.seat_id = hs.seat_id AND h.grant_id = hs.grant_id
   AND h.workspace_id = hs.workspace_id AND h.principal_id = hs.principal_id
   AND h.revoked_at IS NULL
  JOIN swarm.agent_principals AS p
    ON p.principal_id = hs.principal_id AND p.workspace_id = hs.workspace_id
   AND p.owner_user_id = hs.owner_user_id AND p.revoked_at IS NULL
   AND p.transport = ''hosted_mcp'' AND p.turn_only = true
  JOIN swarm.workspaces AS w
    ON w.workspace_id = hs.workspace_id AND w.archived_at IS NULL
  JOIN swarm.memberships AS m
    ON m.workspace_id = hs.workspace_id AND m.user_id = hs.owner_user_id
   AND m.revoked_at IS NULL
  JOIN swarm.streams AS st
    ON st.workspace_id = hs.workspace_id AND st.kind = ''workspace''
  WHERE p_tool IN (''whoami'', ''members'', ''check'')
    AND g.grant_id = p_grant_id AND h.handle = p_handle
    AND g.state = ''active'' AND g.revoked_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM swarm.revocation_tombstones AS t
      WHERE (t.kind = ''membership'' AND t.target_id = hs.owner_user_id)
         OR (t.kind = ''principal'' AND t.target_id = hs.principal_id)
         OR (t.kind = ''hosted_grant'' AND t.target_id = hs.grant_id)
         OR (t.kind = ''hosted_seat'' AND t.target_id = hs.seat_id)
    )
$function$;'),'[[:space:];]','','g')
     AND (SELECT array_agg(pg_get_userbyid(a.grantee)||':'||a.privilege_type||':'||pg_get_userbyid(a.grantor)||':'||a.is_grantable::text ORDER BY pg_get_userbyid(a.grantee)||':'||a.privilege_type||':'||pg_get_userbyid(a.grantor)||':'||a.is_grantable::text)
       FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a)='{swarm_admin:EXECUTE:swarm_admin:false,swarm_read:EXECUTE:swarm_admin:false}'::text[])),false)),
 ('resolve_hosted_mcp_check_authorization.preimage',COALESCE((EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles r ON r.oid=p.proowner JOIN pg_catalog.pg_language l ON l.oid=p.prolang
   WHERE p.oid=to_regprocedure('swarm.resolve_hosted_mcp_check_authorization(uuid, text)') AND r.rolname='swarm_admin' AND l.lanname='sql' AND p.prosecdef=true
     AND p.proconfig=ARRAY['search_path=swarm, pg_catalog']::text[] AND p.provolatile='s' AND p.prokind='f'
     AND NOT p.proisstrict AND NOT p.proleakproof AND p.proparallel='u' AND p.prosupport=0 AND p.procost=100
     AND regexp_replace(pg_get_function_result(p.oid),'[[:space:]]','','g')=regexp_replace('TABLE( grant_id uuid, provider_grant_id text, seat_id uuid, handle text, workspace_id uuid, stream_id uuid, owner_user_id uuid, principal_id uuid, name text )','[[:space:]]','','g') AND pg_get_function_identity_arguments(p.oid)='p_grant_id uuid, p_handle text'
     AND p.prosrc='
  SELECT *
  FROM swarm.resolve_hosted_seat_read_authorization(p_grant_id, p_handle, ''check'')
'
     AND regexp_replace(upper(pg_get_functiondef(p.oid)),'[[:space:];]','','g')=regexp_replace(upper('CREATE OR REPLACE FUNCTION swarm.resolve_hosted_mcp_check_authorization(
  p_grant_id uuid,
  p_handle text
)
RETURNS TABLE (
  grant_id uuid,
  provider_grant_id text,
  seat_id uuid,
  handle text,
  workspace_id uuid,
  stream_id uuid,
  owner_user_id uuid,
  principal_id uuid,
  name text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''swarm'', ''pg_catalog''
AS $function$
  SELECT *
  FROM swarm.resolve_hosted_seat_read_authorization(p_grant_id, p_handle, ''check'')
$function$;'),'[[:space:];]','','g')
     AND (SELECT array_agg(pg_get_userbyid(a.grantee)||':'||a.privilege_type||':'||pg_get_userbyid(a.grantor)||':'||a.is_grantable::text ORDER BY pg_get_userbyid(a.grantee)||':'||a.privilege_type||':'||pg_get_userbyid(a.grantor)||':'||a.is_grantable::text)
       FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a)='{swarm_admin:EXECUTE:swarm_admin:false,swarm_command:EXECUTE:swarm_admin:false}'::text[])),false)),
 ('hosted_mcp_check_cursors_guard.preimage',COALESCE((EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles r ON r.oid=p.proowner JOIN pg_catalog.pg_language l ON l.oid=p.prolang
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
         AND b.grant_id = NEW.grant_id
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
         AND b.grant_id = NEW.grant_id
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
 ('hosted_mcp_check_batches_guard.preimage',COALESCE((EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles r ON r.oid=p.proowner JOIN pg_catalog.pg_language l ON l.oid=p.prolang
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
    IF NEW.acknowledged_at IS NOT NULL THEN
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
    IF NEW.acknowledged_at IS NOT NULL THEN
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
 ('purge_expired_idempotency_keys.preimage',COALESCE((EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles r ON r.oid=p.proowner JOIN pg_catalog.pg_language l ON l.oid=p.prolang
   WHERE p.oid=to_regprocedure('swarm.purge_expired_idempotency_keys(integer)') AND r.rolname='swarm_admin' AND l.lanname='plpgsql' AND p.prosecdef=true
     AND p.proconfig=ARRAY['search_path=swarm, pg_catalog']::text[] AND p.provolatile='v' AND p.prokind='f'
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
    FROM swarm.idempotency_keys
    WHERE (
        command_id ~ claim_id_re
        AND created_at < statement_timestamp() - make_interval(days => claim_days)
      )
      OR (
        command_id !~ claim_id_re
        AND created_at < statement_timestamp() - make_interval(days => retain_days)
      )
    ORDER BY created_at, principal_kind, principal_id, command_id
    LIMIT batch_size
  );
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
'
     AND regexp_replace(upper(pg_get_functiondef(p.oid)),'[[:space:];]','','g')=regexp_replace(upper('CREATE OR REPLACE FUNCTION swarm.purge_expired_idempotency_keys(
  batch_size integer
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''swarm'', ''pg_catalog''
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
    FROM swarm.idempotency_keys
    WHERE (
        command_id ~ claim_id_re
        AND created_at < statement_timestamp() - make_interval(days => claim_days)
      )
      OR (
        command_id !~ claim_id_re
        AND created_at < statement_timestamp() - make_interval(days => retain_days)
      )
    ORDER BY created_at, principal_kind, principal_id, command_id
    LIMIT batch_size
  );
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$function$;'),'[[:space:];]','','g')
     AND (SELECT array_agg(pg_get_userbyid(a.grantee)||':'||a.privilege_type||':'||pg_get_userbyid(a.grantor)||':'||a.is_grantable::text ORDER BY pg_get_userbyid(a.grantee)||':'||a.privilege_type||':'||pg_get_userbyid(a.grantor)||':'||a.is_grantable::text)
       FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a)='{swarm_admin:EXECUTE:swarm_admin:false}'::text[])),false)),
 ('swarm.hosted_legacy_handle_guard().absent',COALESCE((to_regprocedure('swarm.hosted_legacy_handle_guard()') IS NULL),false)),
 ('swarm.hosted_context_interval(text).absent',COALESCE((to_regprocedure('swarm.hosted_context_interval(text)') IS NULL),false)),
 ('swarm.resolve_hosted_context(uuid, text, text, text).absent',COALESCE((to_regprocedure('swarm.resolve_hosted_context(uuid, text, text, text)') IS NULL),false)),
 ('swarm.record_hosted_context_activity(uuid).absent',COALESCE((to_regprocedure('swarm.record_hosted_context_activity(uuid)') IS NULL),false)),
 ('swarm.close_hosted_agent_context(uuid, text).absent',COALESCE((to_regprocedure('swarm.close_hosted_agent_context(uuid, text)') IS NULL),false)),
 ('swarm.expire_hosted_agent_contexts(integer).absent',COALESCE((to_regprocedure('swarm.expire_hosted_agent_contexts(integer)') IS NULL),false)),
 ('swarm.sweep_hosted_agent_contexts().absent',COALESCE((to_regprocedure('swarm.sweep_hosted_agent_contexts()') IS NULL),false)),
 ('swarm.resolve_hosted_discovery(uuid, uuid).absent',COALESCE((to_regprocedure('swarm.resolve_hosted_discovery(uuid, uuid)') IS NULL),false)),
 ('swarm.hosted_principal_context_summary(uuid).absent',COALESCE((to_regprocedure('swarm.hosted_principal_context_summary(uuid)') IS NULL),false)),
 ('swarm.hosted_context_guard().absent',COALESCE((to_regprocedure('swarm.hosted_context_guard()') IS NULL),false)),
 ('swarm.audit_hosted_context(uuid, uuid, text, text, text, text).absent',COALESCE((to_regprocedure('swarm.audit_hosted_context(uuid, uuid, text, text, text, text)') IS NULL),false)),
 ('swarm.hosted_outcome_context().absent',COALESCE((to_regprocedure('swarm.hosted_outcome_context()') IS NULL),false)),
 ('swarm.hosted_event_context().absent',COALESCE((to_regprocedure('swarm.hosted_event_context()') IS NULL),false)),
 ('swarm.audit_hosted_authorization_denial(uuid, text, text).absent',COALESCE((to_regprocedure('swarm.audit_hosted_authorization_denial(uuid, text, text)') IS NULL),false)),
 ('swarm.hosted_household_event_context().absent',COALESCE((to_regprocedure('swarm.hosted_household_event_context()') IS NULL),false)),
 ('hosted_mcp_check_batches.context_id.absent',COALESCE((NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.hosted_mcp_check_batches') AND attname='context_id' AND NOT attisdropped)),false)),
 ('hosted_mcp_check_batches.cancelled_at.absent',COALESCE((NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.hosted_mcp_check_batches') AND attname='cancelled_at' AND NOT attisdropped)),false)),
 ('hosted_mcp_check_batches.cancel_reason.absent',COALESCE((NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.hosted_mcp_check_batches') AND attname='cancel_reason' AND NOT attisdropped)),false)),
 ('audit_log.context_id.absent',COALESCE((NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.audit_log') AND attname='context_id' AND NOT attisdropped)),false)),
 ('audit_log.context_details.absent',COALESCE((NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.audit_log') AND attname='context_details' AND NOT attisdropped)),false)),
 ('idempotency_keys.context_id.absent',COALESCE((NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('swarm.idempotency_keys') AND attname='context_id' AND NOT attisdropped)),false)),
 ('hosted_mcp_check_batches_legacy_active.absent',COALESCE((to_regclass('swarm.hosted_mcp_check_batches_legacy_active') IS NULL),false)),
 ('hosted_outcomes_context.absent',COALESCE((to_regclass('swarm.hosted_outcomes_context') IS NULL),false)),
 ('hosted_audit_context.absent',COALESCE((to_regclass('swarm.hosted_audit_context') IS NULL),false)),
 ('hosted_contexts_identity.absent',COALESCE((to_regclass('swarm.hosted_contexts_identity') IS NULL),false)),
 ('hosted_mcp_seats_current_identity.absent',COALESCE((to_regclass('swarm.hosted_mcp_seats_current_identity') IS NULL),false)),
 ('hosted_mcp_check_cursors_identity.absent',COALESCE((to_regclass('swarm.hosted_mcp_check_cursors_identity') IS NULL),false)),
 ('hosted_household_event_context.absent',COALESCE((NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('swarm.household_object_events') AND tgname='hosted_household_event_context')),false)),
 ('hosted_household_event_context.absent',COALESCE((NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('swarm.household_todo_events') AND tgname='hosted_household_event_context')),false)),
 ('hosted_event_context.absent',COALESCE((NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('swarm.events') AND tgname='hosted_event_context')),false)),
 ('hosted_outcome_context.absent',COALESCE((NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('swarm.idempotency_keys') AND tgname='hosted_outcome_context')),false)),
 ('hosted_legacy_handle_guard.absent',COALESCE((NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('swarm.hosted_mcp_seat_handles') AND tgname='hosted_legacy_handle_guard')),false)),
 ('hosted_context_guard.absent',COALESCE((NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('swarm.hosted_agent_contexts') AND tgname='hosted_context_guard')),false)),
 -- PostgreSQL 17 omits outer Var prefixes for this single-RTE view. The
 -- correlated p.principal_id inside the subquery stays qualified (ruleutils.c).
 ('agent_principals.preimage',COALESCE((EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=to_regclass('swarm_read.agent_principals') AND c.relkind='v' AND c.relowner=(SELECT oid FROM pg_roles WHERE rolname='swarm_admin') AND c.reloptions=ARRAY['security_barrier=true']::text[] AND regexp_replace(pg_get_viewdef(c.oid,false),'[[:space:]]','','g')=regexp_replace('SELECT principal_id, workspace_id, owner_user_id, name, created_at, revoked_at, model, managed_at, transport, turn_only FROM swarm.agent_principals p WHERE (swarm.is_member(workspace_id, auth.uid()) AND (NOT (EXISTS (SELECT 1 FROM swarm.agent_join_credentials c WHERE (c.registrar_principal_id = p.principal_id)))));','[[:space:]]','','g'))),false)),
 ('legacy_cursor_fk',COALESCE((EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conrelid=to_regclass('swarm.hosted_mcp_check_batches') AND c.confrelid=to_regclass('swarm.hosted_mcp_check_cursors') AND c.contype='f' AND pg_get_constraintdef(c.oid)='FOREIGN KEY (seat_id, grant_id, workspace_id, principal_id) REFERENCES swarm.hosted_mcp_check_cursors(seat_id, grant_id, workspace_id, principal_id)')),false)),
 ('legacy_batch_index',COALESCE((EXISTS(SELECT 1 FROM pg_index i WHERE i.indexrelid=to_regclass('swarm.hosted_mcp_check_batches_one_active') AND pg_get_indexdef(i.indexrelid)='CREATE UNIQUE INDEX hosted_mcp_check_batches_one_active ON swarm.hosted_mcp_check_batches USING btree (seat_id) WHERE (acknowledged_at IS NULL)')),false)),
 -- tableforest=true emits a row root, without a table wrapper.
 ('cron.absent',COALESCE((CASE WHEN to_regclass('cron.job') IS NULL THEN true ELSE (xpath('/row/n/text()',query_to_xml('SELECT count(*) AS n FROM cron.job WHERE jobname=''hosted-agent-context-expiry'' AND database=current_database()',false,true,'')))[1]::text='0' END),false)))
SELECT COALESCE((SELECT bool_and(ok) FROM (SELECT ok FROM checks UNION ALL SELECT ok FROM lifecycle_checks) all_checks),false) AS rollback_ok
\gset
