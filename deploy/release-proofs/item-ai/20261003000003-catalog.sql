-- Forward catalog (review input) for 20261003000003. Safe OID lookups fail closed.
-- Stable labels only: no row values or credential data in diagnostics.
WITH checks(label,ok) AS (VALUES
  ('20261003000003-001-commonswarm_oauth-guard_audit_daily', COALESCE((
    EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('commonswarm_oauth.guard_audit_daily()')
    AND pg_get_userbyid(p.proowner)='swarm_admin' AND p.prosecdef=false
    AND p.prorettype='trigger'::regtype AND NOT p.proretset AND p.provolatile='v'
    AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND md5(p.prosrc)='fe714b69a3744901fd01c7eea2016759'
    AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      WHERE a.grantee<>p.proowner AND (a.privilege_type<>'EXECUTE' OR a.is_grantable OR NOT EXISTS(
        SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND false)))
    AND (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)=0)
  ),false)),
  ('20261003000003-002-commonswarm_oauth-guard_admin_request_audit', COALESCE((
    EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('commonswarm_oauth.guard_admin_request_audit()')
    AND pg_get_userbyid(p.proowner)='swarm_admin' AND p.prosecdef=false
    AND p.prorettype='trigger'::regtype AND NOT p.proretset AND p.provolatile='v'
    AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND md5(p.prosrc)='67baa382dd91ae2e298535a5a34c5c79'
    AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      WHERE a.grantee<>p.proowner AND (a.privilege_type<>'EXECUTE' OR a.is_grantable OR NOT EXISTS(
        SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND false)))
    AND (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)=0)
  ),false)),
  ('20261003000003-003-commonswarm_oauth-record_admin_request_audit-text-bytea-text-text-text-commonswarm_oauth-admin_security_reason-text-uuid-uuid', COALESCE((
    EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('commonswarm_oauth.record_admin_request_audit(text,bytea,text,text,text,commonswarm_oauth.admin_security_reason,text,uuid,uuid[])')
    AND pg_get_userbyid(p.proowner)='swarm_admin' AND p.prosecdef=true
    AND p.prorettype='uuid'::regtype AND NOT p.proretset AND p.provolatile='v'
    AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND md5(p.prosrc)='3f3bdb1cffd0d5bae81ba1f08e085272'
    AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      WHERE a.grantee<>p.proowner AND (a.privilege_type<>'EXECUTE' OR a.is_grantable OR NOT EXISTS(
        SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY['commonswarm_oauth_runtime','swarm_command']::text[]))))
    AND (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)=2)
  ),false)),
  ('20261003000003-004-commonswarm_oauth-record_admin_security_failure-commonswarm_oauth-admin_security_reason', COALESCE((
    EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('commonswarm_oauth.record_admin_security_failure(commonswarm_oauth.admin_security_reason)')
    AND pg_get_userbyid(p.proowner)='swarm_admin' AND p.prosecdef=true
    AND p.prorettype='boolean'::regtype AND NOT p.proretset AND p.provolatile='v'
    AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND md5(p.prosrc)='96037cbaf70e68d96efc6469d7b08b83'
    AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      WHERE a.grantee<>p.proowner AND (a.privilege_type<>'EXECUTE' OR a.is_grantable OR NOT EXISTS(
        SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY['commonswarm_oauth_runtime','swarm_command']::text[]))))
    AND (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)=2)
  ),false)),
  ('20261003000003-005-commonswarm_oauth-admin_security_reason', COALESCE((
    EXISTS(SELECT 1 FROM pg_type t WHERE t.oid=to_regtype('commonswarm_oauth.admin_security_reason')
    AND t.typtype='e' AND t.typowner='swarm_admin'::regrole
    AND (SELECT array_agg(enumlabel::text ORDER BY enumsortorder) FROM pg_enum WHERE enumtypid=t.oid)
      =ARRAY['unknown_admin_credential','invalid_token','invalid_dpop','replay','nonce_required','invalid_request','transaction_failed','rate_limited','forbidden','inactive']::text[]
    AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(t.typacl,acldefault('T',t.typowner))) a WHERE a.grantee<>t.typowner
      AND (a.grantee NOT IN ('commonswarm_oauth_runtime'::regrole,'swarm_command'::regrole) OR a.privilege_type<>'USAGE' OR a.is_grantable))
    AND (SELECT count(*) FROM aclexplode(t.typacl) a WHERE a.grantee<>t.typowner)=2)
  ),false)),
  ('20261003000003-006-commonswarm_oauth-admin_oauth_audit_daily', COALESCE((
    EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=to_regclass('commonswarm_oauth.admin_oauth_audit_daily')
    AND c.relkind='r' AND c.relowner='swarm_admin'::regrole AND c.relrowsecurity AND NOT c.relforcerowsecurity
    AND (SELECT array_agg(a.attname::text ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped)
      =ARRAY['admin_grant_id','audit_day','read_requests','read_rows','suppressed_read_rows','action_rows']::text[]
    AND (SELECT array_agg(format_type(a.atttypid,a.atttypmod) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped)
      =ARRAY['uuid','date','bigint','bigint','bigint','bigint']::text[]
    AND NOT EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped AND NOT a.attnotnull)
    AND (SELECT count(*) FROM pg_constraint WHERE conrelid=c.oid AND contype='p' AND convalidated)=1
    AND (SELECT count(*) FROM pg_constraint WHERE conrelid=c.oid AND contype='c' AND convalidated)=5
    AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=c.oid AND contype='c'
      AND regexp_replace(pg_get_expr(conbin,conrelid),'[[:space:]()]','','g')='read_rows>=0ANDread_rows<=1000')
    AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=c.oid AND contype='c'
      AND regexp_replace(pg_get_expr(conbin,conrelid),'[[:space:]()]','','g')='read_requests=read_rows+suppressed_read_rows')
    AND (SELECT count(*) FROM pg_constraint WHERE conrelid=c.oid AND contype='f' AND confrelid=to_regclass('swarm.admin_grants') AND convalidated)=1
    AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner)
    AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=c.oid))
  ),false)),
  ('20261003000003-007-commonswarm_oauth-admin_oauth_audit_daily', COALESCE((
    EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.admin_oauth_audit_daily')
    AND tgname='admin_audit_daily_monotonic' AND tgenabled='O' AND tgtype=27 AND NOT tgisinternal
    AND tgfoid=to_regprocedure('commonswarm_oauth.guard_audit_daily()'))
  ),false)),
  ('20261003000003-008-commonswarm_oauth-admin_oauth_audit', COALESCE((
    EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.admin_oauth_audit')
    AND tgname='admin_oauth_request_audit' AND tgenabled='O' AND tgtype=7 AND NOT tgisinternal
    AND tgqual IS NOT NULL
    AND position('init' in pg_get_triggerdef(oid))>0 AND position('list' in pg_get_triggerdef(oid))>0
    AND position('read' in pg_get_triggerdef(oid))>0 AND position('action' in pg_get_triggerdef(oid))>0 AND tgfoid=to_regprocedure('commonswarm_oauth.guard_admin_request_audit()'))
  ),false)),
  ('20261003000003-009-commonswarm_oauth-admin_oauth_audit', COALESCE((
    EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('commonswarm_oauth.admin_oauth_audit')
    AND contype='c' AND position('init' in pg_get_constraintdef(oid))>0 AND position('list' in pg_get_constraintdef(oid))>0
    AND position('read' in pg_get_constraintdef(oid))>0 AND position('action' in pg_get_constraintdef(oid))>0)
  ),false)),
  ('20261003000003-010-commonswarm_oauth-admin_oauth_audit', COALESCE((
    EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=to_regclass('commonswarm_oauth.admin_oauth_audit')
  AND c.relkind='r' AND pg_get_userbyid(c.relowner)='swarm_admin' AND c.relrowsecurity AND NOT c.relforcerowsecurity
  AND (SELECT array_agg(a.attname::text ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped)=ARRAY['audit_id','occurred_at','owner_user_id','admin_identity_id','admin_grant_id','connection_id','provider_grant_id','manifest_digest','event_kind','request_id','target_id','workspace_id','outcome','reason_code','related_event_ids']::text[]
  AND (SELECT count(*) FROM pg_constraint WHERE conrelid=c.oid AND contype='p' AND convalidated)=1
  AND NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=c.oid AND NOT convalidated)
  AND NOT EXISTS(SELECT 1 FROM pg_index WHERE indrelid=c.oid AND (NOT indisvalid OR NOT indisready))
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    WHERE a.grantee<>c.relowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY['commonswarm_oauth_runtime']::text[]))))
  ),false)),
  ('20261003000003-011-commonswarm_oauth-admin_oauth_audit-SELECT', COALESCE((
    COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_oauth_audit'),'SELECT'),false)=true
  ),false)),
  ('20261003000003-012-commonswarm_oauth-admin_oauth_audit-INSERT', COALESCE((
    COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_oauth_audit'),'INSERT'),false)=true
  ),false)),
  ('20261003000003-013-commonswarm_oauth-admin_oauth_audit-UPDATE', COALESCE((
    COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_oauth_audit'),'UPDATE'),false)=false
  ),false)),
  ('20261003000003-014-commonswarm_oauth-admin_oauth_audit-DELETE', COALESCE((
    COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_oauth_audit'),'DELETE'),false)=false
  ),false)),
  ('20261003000003-015-commonswarm_oauth-admin_oauth_audit-TRUNCATE', COALESCE((
    COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_oauth_audit'),'TRUNCATE'),false)=false
  ),false)),
  ('20261003000003-016-commonswarm_oauth-admin_oauth_audit-REFERENCES', COALESCE((
    COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_oauth_audit'),'REFERENCES'),false)=false
  ),false)),
  ('20261003000003-017-commonswarm_oauth-admin_oauth_audit-TRIGGER', COALESCE((
    COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_oauth_audit'),'TRIGGER'),false)=false
  ),false)),
  ('20261003000003-018-commonswarm_oauth-admin_oauth_audit', COALESCE((
    (SELECT count(*) FROM pg_constraint WHERE conrelid=to_regclass('commonswarm_oauth.admin_oauth_audit') AND contype='c')=7
  ),false)),
  ('20261003000003-019-commonswarm_oauth-admin_access_issuances', COALESCE((
    EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=to_regclass('commonswarm_oauth.admin_access_issuances')
  AND c.relkind='r' AND pg_get_userbyid(c.relowner)='swarm_admin' AND c.relrowsecurity AND NOT c.relforcerowsecurity
  AND (SELECT array_agg(a.attname::text ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped)=ARRAY['access_jti','access_token_digest','provider_grant_id','admin_grant_id','generation','client_id','resource','jkt','manifest_digest','scope_names','issuer','kid','issued_at','expires_at','event_id','audit_id']::text[]
  AND (SELECT count(*) FROM pg_constraint WHERE conrelid=c.oid AND contype='p' AND convalidated)=1
  AND NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=c.oid AND NOT convalidated)
  AND NOT EXISTS(SELECT 1 FROM pg_index WHERE indrelid=c.oid AND (NOT indisvalid OR NOT indisready))
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    WHERE a.grantee<>c.relowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY['commonswarm_oauth_runtime']::text[]))))
  ),false)),
  ('20261003000003-020-commonswarm_oauth-admin_access_issuances-SELECT', COALESCE((
    COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_access_issuances'),'SELECT'),false)=true
  ),false)),
  ('20261003000003-021-commonswarm_oauth-admin_access_issuances-INSERT', COALESCE((
    COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_access_issuances'),'INSERT'),false)=true
  ),false)),
  ('20261003000003-022-commonswarm_oauth-admin_access_issuances-UPDATE', COALESCE((
    COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_access_issuances'),'UPDATE'),false)=false
  ),false)),
  ('20261003000003-023-commonswarm_oauth-admin_access_issuances-DELETE', COALESCE((
    COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_access_issuances'),'DELETE'),false)=false
  ),false)),
  ('20261003000003-024-commonswarm_oauth-admin_access_issuances-TRUNCATE', COALESCE((
    COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_access_issuances'),'TRUNCATE'),false)=false
  ),false)),
  ('20261003000003-025-commonswarm_oauth-admin_access_issuances-REFERENCES', COALESCE((
    COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_access_issuances'),'REFERENCES'),false)=false
  ),false)),
  ('20261003000003-026-commonswarm_oauth-admin_access_issuances-TRIGGER', COALESCE((
    COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_access_issuances'),'TRIGGER'),false)=false
  ),false)),
  ('20261003000003-027-commonswarm_oauth-admin_access_issuances', COALESCE((
    (SELECT count(*) FROM pg_constraint WHERE conrelid=to_regclass('commonswarm_oauth.admin_access_issuances') AND contype='c')=11
  ),false)),
  ('20261003000003-028-commonswarm_oauth-admin_cutover_state', COALESCE((
    EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=to_regclass('commonswarm_oauth.admin_cutover_state')
  AND c.relkind='r' AND pg_get_userbyid(c.relowner)='swarm_admin' AND c.relrowsecurity AND NOT c.relforcerowsecurity
  AND (SELECT array_agg(a.attname::text ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped)=ARRAY['singleton','admin_issuance_enabled','legacy_closed','legacy_closed_at','legacy_fence_evidence_ref','approved_edge_release_sha','auth_contract_version','required_migrations','lane8_evidence_digest','measured_edge_release_sha','measured_edge_target','measured_artifact_digest','measured_image_digest','measured_mount','release_generation','measured_generation','measured_at','measurement_evidence_ref','invalidated_at']::text[]
  AND (SELECT count(*) FROM pg_constraint WHERE conrelid=c.oid AND contype='p' AND convalidated)=1
  AND NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=c.oid AND NOT convalidated)
  AND NOT EXISTS(SELECT 1 FROM pg_index WHERE indrelid=c.oid AND (NOT indisvalid OR NOT indisready))
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    WHERE a.grantee<>c.relowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY['commonswarm_oauth_runtime','commonswarm_admin_release']::text[]))))
  ),false)),
  ('20261003000003-029-commonswarm_oauth-admin_cutover_state-SELECT', COALESCE((
    COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_cutover_state'),'SELECT'),false)=true
  ),false)),
  ('20261003000003-030-commonswarm_oauth-admin_cutover_state-INSERT', COALESCE((
    COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_cutover_state'),'INSERT'),false)=false
  ),false)),
  ('20261003000003-031-commonswarm_oauth-admin_cutover_state-UPDATE', COALESCE((
    COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_cutover_state'),'UPDATE'),false)=false
  ),false)),
  ('20261003000003-032-commonswarm_oauth-admin_cutover_state-DELETE', COALESCE((
    COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_cutover_state'),'DELETE'),false)=false
  ),false)),
  ('20261003000003-033-commonswarm_oauth-admin_cutover_state-TRUNCATE', COALESCE((
    COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_cutover_state'),'TRUNCATE'),false)=false
  ),false)),
  ('20261003000003-034-commonswarm_oauth-admin_cutover_state-REFERENCES', COALESCE((
    COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_cutover_state'),'REFERENCES'),false)=false
  ),false)),
  ('20261003000003-035-commonswarm_oauth-admin_cutover_state-TRIGGER', COALESCE((
    COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_cutover_state'),'TRIGGER'),false)=false
  ),false)),
  ('20261003000003-036-commonswarm_oauth-admin_cutover_state-SELECT', COALESCE((
    COALESCE(has_table_privilege('commonswarm_admin_release',to_regclass('commonswarm_oauth.admin_cutover_state'),'SELECT'),false)=true
  ),false)),
  ('20261003000003-037-commonswarm_oauth-admin_cutover_state-INSERT', COALESCE((
    COALESCE(has_table_privilege('commonswarm_admin_release',to_regclass('commonswarm_oauth.admin_cutover_state'),'INSERT'),false)=false
  ),false)),
  ('20261003000003-038-commonswarm_oauth-admin_cutover_state-UPDATE', COALESCE((
    COALESCE(has_table_privilege('commonswarm_admin_release',to_regclass('commonswarm_oauth.admin_cutover_state'),'UPDATE'),false)=true
  ),false)),
  ('20261003000003-039-commonswarm_oauth-admin_cutover_state-DELETE', COALESCE((
    COALESCE(has_table_privilege('commonswarm_admin_release',to_regclass('commonswarm_oauth.admin_cutover_state'),'DELETE'),false)=false
  ),false)),
  ('20261003000003-040-commonswarm_oauth-admin_cutover_state-TRUNCATE', COALESCE((
    COALESCE(has_table_privilege('commonswarm_admin_release',to_regclass('commonswarm_oauth.admin_cutover_state'),'TRUNCATE'),false)=false
  ),false)),
  ('20261003000003-041-commonswarm_oauth-admin_cutover_state-REFERENCES', COALESCE((
    COALESCE(has_table_privilege('commonswarm_admin_release',to_regclass('commonswarm_oauth.admin_cutover_state'),'REFERENCES'),false)=false
  ),false)),
  ('20261003000003-042-commonswarm_oauth-admin_cutover_state-TRIGGER', COALESCE((
    COALESCE(has_table_privilege('commonswarm_admin_release',to_regclass('commonswarm_oauth.admin_cutover_state'),'TRIGGER'),false)=false
  ),false)),
  ('20261003000003-043-commonswarm_oauth-admin_cutover_state', COALESCE((
    (SELECT count(*) FROM pg_constraint WHERE conrelid=to_regclass('commonswarm_oauth.admin_cutover_state') AND contype='c')=14
  ),false)),
  ('20261003000003-044-commonswarm_oauth-guard_cutover_state', COALESCE((
    EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('commonswarm_oauth.guard_cutover_state()')
  AND pg_get_userbyid(p.proowner)='swarm_admin' AND p.prosecdef=true
  AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND md5(p.prosrc)='edc692e62a814ac2fe4dd4962c6cd6f8'
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.grantee<>p.proowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY[]::text[])))
  AND (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)=0)
  ),false)),
  ('20261003000003-045-commonswarm_oauth-guard_oauth_audit', COALESCE((
    EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('commonswarm_oauth.guard_oauth_audit()')
  AND pg_get_userbyid(p.proowner)='swarm_admin' AND p.prosecdef=true
  AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND md5(p.prosrc)='cf9ad1db05bd2a76fe6db07c200443d3'
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.grantee<>p.proowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY[]::text[])))
  AND (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)=0)
  ),false)),
  ('20261003000003-046-commonswarm_oauth-guard_access_issuance', COALESCE((
    EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('commonswarm_oauth.guard_access_issuance()')
  AND pg_get_userbyid(p.proowner)='swarm_admin' AND p.prosecdef=true
  AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND md5(p.prosrc)='1a9b87cd1518f6d49ef478c04db02e1a'
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.grantee<>p.proowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY[]::text[])))
  AND (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)=0)
  ),false)),
  ('20261003000003-047-commonswarm_oauth-admin_access_is_active-text-bytea-text-uuid-uuid-integer-text-text-text-text-timestamptz-timestamptz-text', COALESCE((
    EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('commonswarm_oauth.admin_access_is_active(text,bytea,text,uuid,uuid,integer,text,text,text,text,timestamptz,timestamptz,text)')
  AND pg_get_userbyid(p.proowner)='swarm_admin' AND p.prosecdef=true
  AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND md5(p.prosrc)='ce9856166b92f801dd5e2a90112a1d5f'
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.grantee<>p.proowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY['commonswarm_oauth_runtime','swarm_command','swarm_read']::text[])))
  AND (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)=3)
  ),false)),
  ('20261003000003-048-commonswarm_oauth-admin_grant_family_fence', COALESCE((
    EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('commonswarm_oauth.admin_grant_family_fence()')
  AND pg_get_userbyid(p.proowner)='swarm_admin' AND p.prosecdef=true
  AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND md5(p.prosrc)='3b38e3605ac4a994a2892fb92677d7e1'
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.grantee<>p.proowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY[]::text[])))
  AND (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)=0)
  ),false)),
  ('20261003000003-049-commonswarm_oauth-tombstone_admin_family', COALESCE((
    EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('commonswarm_oauth.tombstone_admin_family()')
  AND pg_get_userbyid(p.proowner)='swarm_admin' AND p.prosecdef=true
  AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND md5(p.prosrc)='420bf5228314975fe31665f3efc90ef8'
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.grantee<>p.proowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY[]::text[])))
  AND (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)=0)
  ),false)),
  ('20261003000003-050-commonswarm_oauth-deny_issuer_admin_families', COALESCE((
    EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('commonswarm_oauth.deny_issuer_admin_families()')
  AND pg_get_userbyid(p.proowner)='swarm_admin' AND p.prosecdef=true
  AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND md5(p.prosrc)='a4f898efa91c38cb256db00228b17fea'
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.grantee<>p.proowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY[]::text[])))
  AND (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)=0)
  ),false)),
  ('20261003000003-051-commonswarm_oauth-guard_legacy_admin_write', COALESCE((
    EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('commonswarm_oauth.guard_legacy_admin_write()')
  AND pg_get_userbyid(p.proowner)='swarm_admin' AND p.prosecdef=true
  AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND md5(p.prosrc)='3584f74082816075c37c524ea4aef424'
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.grantee<>p.proowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY[]::text[])))
  AND (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)=0)
  ),false)),
  ('20261003000003-052-commonswarm_oauth-apply_legacy_admin_fence-text', COALESCE((
    EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('commonswarm_oauth.apply_legacy_admin_fence(text)')
  AND pg_get_userbyid(p.proowner)='swarm_admin' AND p.prosecdef=true
  AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND md5(p.prosrc)='6bd22688b08e7feda1317e7659e92179'
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.grantee<>p.proowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY['commonswarm_admin_release']::text[])))
  AND (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)=1)
  ),false)),
  ('20261003000003-053-swarm_read-admin_oauth_recovery_page-integer', COALESCE((
    EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('swarm_read.admin_oauth_recovery_page(integer)')
  AND pg_get_userbyid(p.proowner)='swarm_admin' AND p.prosecdef=true
  AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND md5(p.prosrc)='23dcb9cfa5a61f4c97f2af5d0fe20465'
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.grantee<>p.proowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY['swarm_read']::text[])))
  AND (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)=1)
  ),false)),
  ('20261003000003-054-commonswarm_oauth-admin_oauth_audit', COALESCE((
    EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.admin_oauth_audit') AND tgname='admin_oauth_audit_append_only' AND tgenabled='O' AND NOT tgisinternal AND tgtype=27 AND tgfoid=to_regprocedure('swarm.prevent_append_only_mutation()'))
  ),false)),
  ('20261003000003-055-commonswarm_oauth-admin_access_issuances', COALESCE((
    EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.admin_access_issuances') AND tgname='admin_issuances_append_only' AND tgenabled='O' AND NOT tgisinternal AND tgtype=27 AND tgfoid=to_regprocedure('swarm.prevent_append_only_mutation()'))
  ),false)),
  ('20261003000003-056-commonswarm_oauth-admin_cutover_state', COALESCE((
    EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.admin_cutover_state') AND tgname='admin_cutover_guard' AND tgenabled='O' AND NOT tgisinternal AND tgtype=27 AND tgfoid=to_regprocedure('commonswarm_oauth.guard_cutover_state()'))
  ),false)),
  ('20261003000003-057-commonswarm_oauth-admin_oauth_audit', COALESCE((
    EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.admin_oauth_audit') AND tgname='admin_oauth_audit_binding' AND tgenabled='O' AND NOT tgisinternal AND tgtype=7 AND tgfoid=to_regprocedure('commonswarm_oauth.guard_oauth_audit()'))
  ),false)),
  ('20261003000003-058-commonswarm_oauth-admin_access_issuances', COALESCE((
    EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.admin_access_issuances') AND tgname='admin_access_issuance_binding' AND tgenabled='O' AND NOT tgisinternal AND tgtype=7 AND tgfoid=to_regprocedure('commonswarm_oauth.guard_access_issuance()'))
  ),false)),
  ('20261003000003-059-swarm-admin_grants', COALESCE((
    EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('swarm.admin_grants') AND tgname='admin_grant_oauth_fence' AND tgenabled='O' AND NOT tgisinternal AND tgtype=17 AND tgfoid=to_regprocedure('commonswarm_oauth.admin_grant_family_fence()'))
  ),false)),
  ('20261003000003-060-commonswarm_oauth-refresh_family_tombstones', COALESCE((
    EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.refresh_family_tombstones') AND tgname='oauth_tombstone_admin_fence' AND tgenabled='O' AND NOT tgisinternal AND tgtype=5 AND tgfoid=to_regprocedure('commonswarm_oauth.tombstone_admin_family()'))
  ),false)),
  ('20261003000003-061-commonswarm_oauth-issuer_key_denials', COALESCE((
    EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.issuer_key_denials') AND tgname='issuer_denial_admin_fence' AND tgenabled='O' AND NOT tgisinternal AND tgtype=5 AND tgfoid=to_regprocedure('commonswarm_oauth.deny_issuer_admin_families()'))
  ),false)),
  ('20261003000003-062-swarm-admin_credentials', COALESCE((
    EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('swarm.admin_credentials') AND tgname='admin_credentials_legacy_guard' AND tgenabled='O' AND NOT tgisinternal AND tgtype=31 AND tgfoid=to_regprocedure('commonswarm_oauth.guard_legacy_admin_write()'))
  ),false)),
  ('20261003000003-063-swarm-admin_grants', COALESCE((
    EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('swarm.admin_grants') AND tgname='admin_grants_legacy_guard' AND tgenabled='O' AND NOT tgisinternal AND tgtype=23 AND tgfoid=to_regprocedure('commonswarm_oauth.guard_legacy_admin_write()'))
  -- Resolve the relation before parsing its row-count query. A static FROM is
  -- parsed even when another AND is false, so it aborts the post-inverse proof.
  -- Keep the exact live singleton count and one-query psql/postgres.js contract.
  ),false)),
  ('20261003000003-064-commonswarm_oauth-admin_cutover_state', COALESCE((
    CASE WHEN to_regclass('commonswarm_oauth.admin_cutover_state') IS NULL THEN false
    ELSE (xpath('/row/row_count/text()', query_to_xml(
      'SELECT count(*) AS row_count FROM commonswarm_oauth.admin_cutover_state',
      false,true,'')))[1]::text::bigint=1 END
  ),false)),
  ('20261003000003-065-catalog-INSERT', COALESCE((
    NOT has_table_privilege('commonswarm_oauth_runtime','swarm.admin_events','INSERT')
  ),false)),
  ('20261003000003-066-catalog-UPDATE', COALESCE((
    NOT has_table_privilege('commonswarm_oauth_runtime','swarm.admin_grants','UPDATE')
  ),false)),
  ('20261003000003-067-commonswarm_oauth-refresh_family_tombstones', COALESCE((
    EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.refresh_family_tombstones') AND tgname='oauth_tombstones_append_only' AND tgenabled='O' AND NOT tgisinternal AND tgtype=27 AND tgfoid=to_regprocedure('swarm.prevent_append_only_mutation()'))
  ),false)),
  ('20261003000003-068-commonswarm_oauth-admin_oauth_audit-audit_id', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_oauth_audit') AND attname='audit_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000003-069-commonswarm_oauth-admin_oauth_audit-occurred_at', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_oauth_audit') AND attname='occurred_at' AND NOT attisdropped AND atttypid='timestamptz'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000003-070-commonswarm_oauth-admin_oauth_audit-owner_user_id', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_oauth_audit') AND attname='owner_user_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000003-071-commonswarm_oauth-admin_oauth_audit-admin_identity_id', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_oauth_audit') AND attname='admin_identity_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000003-072-commonswarm_oauth-admin_oauth_audit-admin_grant_id', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_oauth_audit') AND attname='admin_grant_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000003-073-commonswarm_oauth-admin_oauth_audit-connection_id', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_oauth_audit') AND attname='connection_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000003-074-commonswarm_oauth-admin_oauth_audit-provider_grant_id', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_oauth_audit') AND attname='provider_grant_id' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000003-075-commonswarm_oauth-admin_oauth_audit-manifest_digest', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_oauth_audit') AND attname='manifest_digest' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000003-076-commonswarm_oauth-admin_oauth_audit-event_kind', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_oauth_audit') AND attname='event_kind' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000003-077-commonswarm_oauth-admin_oauth_audit-request_id', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_oauth_audit') AND attname='request_id' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=false)
  ),false)),
  ('20261003000003-078-commonswarm_oauth-admin_oauth_audit-target_id', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_oauth_audit') AND attname='target_id' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=false)
  ),false)),
  ('20261003000003-079-commonswarm_oauth-admin_oauth_audit-outcome', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_oauth_audit') AND attname='outcome' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000003-080-commonswarm_oauth-admin_oauth_audit-reason_code', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_oauth_audit') AND attname='reason_code' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=false)
  ),false)),
  ('20261003000003-081-commonswarm_oauth-admin_oauth_audit-related_event_ids', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_oauth_audit') AND attname='related_event_ids' AND NOT attisdropped AND atttypid='uuid[]'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000003-082-commonswarm_oauth-admin_oauth_audit', COALESCE((
    NOT EXISTS(SELECT 1 FROM pg_policy p WHERE polrelid=to_regclass('commonswarm_oauth.admin_oauth_audit') AND (0=ANY(polroles) OR NOT polpermissive OR (polqual IS NOT NULL AND pg_get_expr(polqual,polrelid)<>'true') OR (polwithcheck IS NOT NULL AND pg_get_expr(polwithcheck,polrelid)<>'true')))
  ),false)),
  ('20261003000003-083-commonswarm_oauth-admin_access_issuances-access_jti', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_access_issuances') AND attname='access_jti' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000003-084-commonswarm_oauth-admin_access_issuances-access_token_digest', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_access_issuances') AND attname='access_token_digest' AND NOT attisdropped AND atttypid='bytea'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000003-085-commonswarm_oauth-admin_access_issuances-provider_grant_id', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_access_issuances') AND attname='provider_grant_id' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000003-086-commonswarm_oauth-admin_access_issuances-admin_grant_id', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_access_issuances') AND attname='admin_grant_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000003-087-commonswarm_oauth-admin_access_issuances-generation', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_access_issuances') AND attname='generation' AND NOT attisdropped AND atttypid='integer'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000003-088-commonswarm_oauth-admin_access_issuances-client_id', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_access_issuances') AND attname='client_id' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000003-089-commonswarm_oauth-admin_access_issuances-resource', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_access_issuances') AND attname='resource' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000003-090-commonswarm_oauth-admin_access_issuances-jkt', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_access_issuances') AND attname='jkt' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000003-091-commonswarm_oauth-admin_access_issuances-manifest_digest', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_access_issuances') AND attname='manifest_digest' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000003-092-commonswarm_oauth-admin_access_issuances-scope_names', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_access_issuances') AND attname='scope_names' AND NOT attisdropped AND atttypid='text[]'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000003-093-commonswarm_oauth-admin_access_issuances-issuer', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_access_issuances') AND attname='issuer' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000003-094-commonswarm_oauth-admin_access_issuances-kid', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_access_issuances') AND attname='kid' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000003-095-commonswarm_oauth-admin_access_issuances-issued_at', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_access_issuances') AND attname='issued_at' AND NOT attisdropped AND atttypid='timestamptz'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000003-096-commonswarm_oauth-admin_access_issuances-expires_at', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_access_issuances') AND attname='expires_at' AND NOT attisdropped AND atttypid='timestamptz'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000003-097-commonswarm_oauth-admin_access_issuances-event_id', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_access_issuances') AND attname='event_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000003-098-commonswarm_oauth-admin_access_issuances-audit_id', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_access_issuances') AND attname='audit_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000003-099-commonswarm_oauth-admin_access_issuances', COALESCE((
    NOT EXISTS(SELECT 1 FROM pg_policy p WHERE polrelid=to_regclass('commonswarm_oauth.admin_access_issuances') AND (0=ANY(polroles) OR NOT polpermissive OR (polqual IS NOT NULL AND pg_get_expr(polqual,polrelid)<>'true') OR (polwithcheck IS NOT NULL AND pg_get_expr(polwithcheck,polrelid)<>'true')))
  ),false)),
  ('20261003000003-100-commonswarm_oauth-admin_cutover_state-singleton', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_cutover_state') AND attname='singleton' AND NOT attisdropped AND atttypid='boolean'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000003-101-commonswarm_oauth-admin_cutover_state-admin_issuance_enabled', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_cutover_state') AND attname='admin_issuance_enabled' AND NOT attisdropped AND atttypid='boolean'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000003-102-commonswarm_oauth-admin_cutover_state-legacy_closed', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_cutover_state') AND attname='legacy_closed' AND NOT attisdropped AND atttypid='boolean'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000003-103-commonswarm_oauth-admin_cutover_state-approved_edge_release_sha', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_cutover_state') AND attname='approved_edge_release_sha' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=false)
  ),false)),
  ('20261003000003-104-commonswarm_oauth-admin_cutover_state-auth_contract_version', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_cutover_state') AND attname='auth_contract_version' AND NOT attisdropped AND atttypid='integer'::regtype AND attnotnull=false)
  ),false)),
  ('20261003000003-105-commonswarm_oauth-admin_cutover_state-required_migrations', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_cutover_state') AND attname='required_migrations' AND NOT attisdropped AND atttypid='jsonb'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000003-106-commonswarm_oauth-admin_cutover_state-lane8_evidence_digest', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_cutover_state') AND attname='lane8_evidence_digest' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=false)
  ),false)),
  ('20261003000003-107-commonswarm_oauth-admin_cutover_state-measured_edge_release_sha', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_cutover_state') AND attname='measured_edge_release_sha' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=false)
  ),false)),
  ('20261003000003-108-commonswarm_oauth-admin_cutover_state-measured_artifact_digest', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_cutover_state') AND attname='measured_artifact_digest' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=false)
  ),false)),
  ('20261003000003-109-commonswarm_oauth-admin_cutover_state-measured_image_digest', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_cutover_state') AND attname='measured_image_digest' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=false)
  ),false)),
  ('20261003000003-110-commonswarm_oauth-admin_cutover_state-release_generation', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_cutover_state') AND attname='release_generation' AND NOT attisdropped AND atttypid='bigint'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000003-111-commonswarm_oauth-admin_cutover_state-measured_generation', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_cutover_state') AND attname='measured_generation' AND NOT attisdropped AND atttypid='bigint'::regtype AND attnotnull=false)
  ),false)),
  ('20261003000003-112-commonswarm_oauth-admin_cutover_state', COALESCE((
    NOT EXISTS(SELECT 1 FROM pg_policy p WHERE polrelid=to_regclass('commonswarm_oauth.admin_cutover_state') AND (0=ANY(polroles) OR NOT polpermissive OR (polqual IS NOT NULL AND pg_get_expr(polqual,polrelid)<>'true') OR (polwithcheck IS NOT NULL AND pg_get_expr(polwithcheck,polrelid)<>'true')))
  ),false)),
  ('20261003000003-113-commonswarm_oauth-valid_admin_migration_requirements-jsonb', COALESCE((
    EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('commonswarm_oauth.valid_admin_migration_requirements(jsonb)') AND p.prosecdef=false AND pg_get_userbyid(p.proowner)='swarm_admin' AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND md5(p.prosrc)='434be8a3e61f3046947752ee964e4102' AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner AND NOT EXISTS(SELECT 1 FROM pg_roles WHERE oid=a.grantee AND rolname=ANY(ARRAY['commonswarm_admin_release']::text[]))) AND (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)=1)
  ),false)),
  ('20261003000003-114-commonswarm_oauth-binding_terminal_fence', COALESCE((
    EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('commonswarm_oauth.binding_terminal_fence()') AND p.prosecdef=true AND pg_get_userbyid(p.proowner)='swarm_admin' AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND md5(p.prosrc)='20d546bfe056bc1a1fea2467c112cad1' AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner AND NOT EXISTS(SELECT 1 FROM pg_roles WHERE oid=a.grantee AND rolname=ANY(ARRAY[]::text[]))) AND (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)=0)
  ),false)),
  ('20261003000003-115-commonswarm_oauth-admin_grant_bindings', COALESCE((
    EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.admin_grant_bindings') AND tgname='admin_binding_terminal_fence' AND tgenabled='O' AND NOT tgisinternal AND tgtype=17 AND tgfoid=to_regprocedure('commonswarm_oauth.binding_terminal_fence()'))
  ),false)),
  ('20261003000003-116-commonswarm_oauth-admin_oauth_audit', COALESCE((
    NOT EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) acl WHERE a.attrelid=to_regclass('commonswarm_oauth.admin_oauth_audit') AND NOT a.attisdropped AND acl.grantee<>(SELECT relowner FROM pg_class WHERE oid=a.attrelid))
  ),false)),
  ('20261003000003-117-commonswarm_oauth-admin_access_issuances', COALESCE((
    NOT EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) acl WHERE a.attrelid=to_regclass('commonswarm_oauth.admin_access_issuances') AND NOT a.attisdropped AND acl.grantee<>(SELECT relowner FROM pg_class WHERE oid=a.attrelid))
  ),false)),
  ('20261003000003-118-commonswarm_oauth-admin_cutover_state', COALESCE((
    NOT EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) acl WHERE a.attrelid=to_regclass('commonswarm_oauth.admin_cutover_state') AND NOT a.attisdropped AND acl.grantee<>(SELECT relowner FROM pg_class WHERE oid=a.attrelid))
  ),false)),
  ('20261003000003-119-commonswarm_oauth-admin_oauth_audit-workspace_id', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_oauth_audit') AND attname='workspace_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=false)
  ),false)),
  ('20261003000003-120-commonswarm_oauth-admin_cutover_state-legacy_closed_at', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_cutover_state') AND attname='legacy_closed_at' AND NOT attisdropped AND atttypid='timestamptz'::regtype AND attnotnull=false)
  ),false)),
  ('20261003000003-121-commonswarm_oauth-admin_cutover_state-legacy_fence_evidence_ref', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_cutover_state') AND attname='legacy_fence_evidence_ref' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=false)
  ),false)),
  ('20261003000003-122-commonswarm_oauth-admin_cutover_state-measured_edge_target', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_cutover_state') AND attname='measured_edge_target' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=false)
  ),false)),
  ('20261003000003-123-commonswarm_oauth-admin_cutover_state-measured_mount', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_cutover_state') AND attname='measured_mount' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=false)
  ),false)),
  ('20261003000003-124-commonswarm_oauth-admin_cutover_state-measured_at', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_cutover_state') AND attname='measured_at' AND NOT attisdropped AND atttypid='timestamptz'::regtype AND attnotnull=false)
  ),false)),
  ('20261003000003-125-commonswarm_oauth-admin_cutover_state-measurement_evidence_ref', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_cutover_state') AND attname='measurement_evidence_ref' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=false)
  ),false)),
  ('20261003000003-126-commonswarm_oauth-admin_cutover_state-invalidated_at', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_cutover_state') AND attname='invalidated_at' AND NOT attisdropped AND atttypid='timestamptz'::regtype AND attnotnull=false)
  ),false))
)
SELECT COALESCE(string_agg(label,',' ORDER BY label) FILTER (WHERE NOT ok),'') AS catalog_ok_failed_checks,
  COALESCE(bool_and(ok),false) AS catalog_ok_checks_ok FROM checks
\gset
\if :catalog_ok_checks_ok
\else
\warn 20261003000003 failed checks: :catalog_ok_failed_checks
\endif
SELECT :'catalog_ok_checks_ok'::boolean AS catalog_ok
\gset
