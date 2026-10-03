-- Forward catalog (review input) for 20261003000001. Safe OID lookups fail closed.
-- Stable labels only: no row values or credential data in diagnostics.
WITH checks(label,ok) AS (VALUES
  ('20261003000001-001-commonswarm_oauth-provider_grant_resources', COALESCE((
    EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=to_regclass('commonswarm_oauth.provider_grant_resources')
  AND c.relkind='r' AND pg_get_userbyid(c.relowner)='swarm_admin' AND c.relrowsecurity AND NOT c.relforcerowsecurity
  AND (SELECT array_agg(a.attname::text ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped)=ARRAY['provider_grant_id','resource','grant_class','owner_user_id','client_id','connection_id','hosted_grant_id','admin_grant_id','created_at']::text[]
  AND (SELECT count(*) FROM pg_constraint WHERE conrelid=c.oid AND contype='p' AND convalidated)=1
  AND NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=c.oid AND NOT convalidated)
  AND NOT EXISTS(SELECT 1 FROM pg_index WHERE indrelid=c.oid AND (NOT indisvalid OR NOT indisready))
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    WHERE a.grantee<>c.relowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY['commonswarm_oauth_runtime']::text[]))))
  ),false)),
  ('20261003000001-002-commonswarm_oauth-provider_grant_resources-SELECT', COALESCE((
    COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.provider_grant_resources'),'SELECT'),false)=true
  ),false)),
  ('20261003000001-003-commonswarm_oauth-provider_grant_resources-INSERT', COALESCE((
    COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.provider_grant_resources'),'INSERT'),false)=true
  ),false)),
  ('20261003000001-004-commonswarm_oauth-provider_grant_resources-UPDATE', COALESCE((
    COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.provider_grant_resources'),'UPDATE'),false)=false
  ),false)),
  ('20261003000001-005-commonswarm_oauth-provider_grant_resources-DELETE', COALESCE((
    COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.provider_grant_resources'),'DELETE'),false)=false
  ),false)),
  ('20261003000001-006-commonswarm_oauth-provider_grant_resources-TRUNCATE', COALESCE((
    COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.provider_grant_resources'),'TRUNCATE'),false)=false
  ),false)),
  ('20261003000001-007-commonswarm_oauth-provider_grant_resources-REFERENCES', COALESCE((
    COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.provider_grant_resources'),'REFERENCES'),false)=false
  ),false)),
  ('20261003000001-008-commonswarm_oauth-provider_grant_resources-TRIGGER', COALESCE((
    COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.provider_grant_resources'),'TRIGGER'),false)=false
  ),false)),
  ('20261003000001-009-commonswarm_oauth-provider_grant_resources', COALESCE((
    (SELECT count(*) FROM pg_constraint WHERE conrelid=to_regclass('commonswarm_oauth.provider_grant_resources') AND contype='c')=4
  ),false)),
  ('20261003000001-010-commonswarm_oauth-admin_grant_bindings', COALESCE((
    EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=to_regclass('commonswarm_oauth.admin_grant_bindings')
  AND c.relkind='r' AND pg_get_userbyid(c.relowner)='swarm_admin' AND c.relrowsecurity AND NOT c.relforcerowsecurity
  AND (SELECT array_agg(a.attname::text ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped)=ARRAY['provider_grant_id','admin_grant_id','owner_user_id','admin_identity_id','connection_id','client_id','resource','grant_class','registry_version','capabilities','scope_names','availability_digest','manifest_digest','verification_version','jkt','consented_at','expires_at','refresh_deadline','initial_issued_at','generation','state','terminal_at']::text[]
  AND (SELECT count(*) FROM pg_constraint WHERE conrelid=c.oid AND contype='p' AND convalidated)=1
  AND NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=c.oid AND NOT convalidated)
  AND NOT EXISTS(SELECT 1 FROM pg_index WHERE indrelid=c.oid AND (NOT indisvalid OR NOT indisready))
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    WHERE a.grantee<>c.relowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY['commonswarm_oauth_runtime']::text[]))))
  ),false)),
  ('20261003000001-011-commonswarm_oauth-admin_grant_bindings-SELECT', COALESCE((
    COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_grant_bindings'),'SELECT'),false)=true
  ),false)),
  ('20261003000001-012-commonswarm_oauth-admin_grant_bindings-INSERT', COALESCE((
    COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_grant_bindings'),'INSERT'),false)=true
  ),false)),
  ('20261003000001-013-commonswarm_oauth-admin_grant_bindings-UPDATE', COALESCE((
    COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_grant_bindings'),'UPDATE'),false)=true
  ),false)),
  ('20261003000001-014-commonswarm_oauth-admin_grant_bindings-DELETE', COALESCE((
    COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_grant_bindings'),'DELETE'),false)=false
  ),false)),
  ('20261003000001-015-commonswarm_oauth-admin_grant_bindings-TRUNCATE', COALESCE((
    COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_grant_bindings'),'TRUNCATE'),false)=false
  ),false)),
  ('20261003000001-016-commonswarm_oauth-admin_grant_bindings-REFERENCES', COALESCE((
    COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_grant_bindings'),'REFERENCES'),false)=false
  ),false)),
  ('20261003000001-017-commonswarm_oauth-admin_grant_bindings-TRIGGER', COALESCE((
    COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_grant_bindings'),'TRIGGER'),false)=false
  ),false)),
  ('20261003000001-018-commonswarm_oauth-admin_grant_bindings', COALESCE((
    (SELECT count(*) FROM pg_constraint WHERE conrelid=to_regclass('commonswarm_oauth.admin_grant_bindings') AND contype='c')=14
  ),false)),
  ('20261003000001-019-commonswarm_oauth-admin_interactions', COALESCE((
    EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=to_regclass('commonswarm_oauth.admin_interactions')
  AND c.relkind='r' AND pg_get_userbyid(c.relowner)='swarm_admin' AND c.relrowsecurity AND NOT c.relforcerowsecurity
  AND (SELECT array_agg(a.attname::text ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped)=ARRAY['interaction_uid','owner_user_id','client_id','resource','redirect_uri','registry_version','verification_version','manifest','manifest_digest','availability_digest','requested_scopes','session_binding','csrf_binding','second_confirmation_binding','full_account','second_confirmed_at','pkce_challenge','pkce_method','jkt','replacement_grant_id','created_at','expires_at','consumed_at']::text[]
  AND (SELECT count(*) FROM pg_constraint WHERE conrelid=c.oid AND contype='p' AND convalidated)=1
  AND NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=c.oid AND NOT convalidated)
  AND NOT EXISTS(SELECT 1 FROM pg_index WHERE indrelid=c.oid AND (NOT indisvalid OR NOT indisready))
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    WHERE a.grantee<>c.relowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY['commonswarm_oauth_runtime']::text[]))))
  ),false)),
  ('20261003000001-020-commonswarm_oauth-admin_interactions-SELECT', COALESCE((
    COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_interactions'),'SELECT'),false)=true
  ),false)),
  ('20261003000001-021-commonswarm_oauth-admin_interactions-INSERT', COALESCE((
    COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_interactions'),'INSERT'),false)=true
  ),false)),
  ('20261003000001-022-commonswarm_oauth-admin_interactions-UPDATE', COALESCE((
    COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_interactions'),'UPDATE'),false)=true
  ),false)),
  ('20261003000001-023-commonswarm_oauth-admin_interactions-DELETE', COALESCE((
    COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_interactions'),'DELETE'),false)=false
  ),false)),
  ('20261003000001-024-commonswarm_oauth-admin_interactions-TRUNCATE', COALESCE((
    COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_interactions'),'TRUNCATE'),false)=false
  ),false)),
  ('20261003000001-025-commonswarm_oauth-admin_interactions-REFERENCES', COALESCE((
    COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_interactions'),'REFERENCES'),false)=false
  ),false)),
  ('20261003000001-026-commonswarm_oauth-admin_interactions-TRIGGER', COALESCE((
    COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_interactions'),'TRIGGER'),false)=false
  ),false)),
  ('20261003000001-027-commonswarm_oauth-admin_interactions', COALESCE((
    (SELECT count(*) FROM pg_constraint WHERE conrelid=to_regclass('commonswarm_oauth.admin_interactions') AND contype='c')=19
  ),false)),
  ('20261003000001-028-commonswarm_oauth-admin_consent_orchestration', COALESCE((
    EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=to_regclass('commonswarm_oauth.admin_consent_orchestration')
  AND c.relkind='r' AND pg_get_userbyid(c.relowner)='swarm_admin' AND c.relrowsecurity AND NOT c.relforcerowsecurity
  AND (SELECT array_agg(a.attname::text ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped)=ARRAY['interaction_uid','owner_user_id','step_kind','command_id','receipt_id','completed_at']::text[]
  AND (SELECT count(*) FROM pg_constraint WHERE conrelid=c.oid AND contype='p' AND convalidated)=1
  AND NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=c.oid AND NOT convalidated)
  AND NOT EXISTS(SELECT 1 FROM pg_index WHERE indrelid=c.oid AND (NOT indisvalid OR NOT indisready))
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    WHERE a.grantee<>c.relowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY['commonswarm_oauth_runtime']::text[]))))
  ),false)),
  ('20261003000001-029-commonswarm_oauth-admin_consent_orchestration-SELECT', COALESCE((
    COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_consent_orchestration'),'SELECT'),false)=true
  ),false)),
  ('20261003000001-030-commonswarm_oauth-admin_consent_orchestration-INSERT', COALESCE((
    COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_consent_orchestration'),'INSERT'),false)=true
  ),false)),
  ('20261003000001-031-commonswarm_oauth-admin_consent_orchestration-UPDATE', COALESCE((
    COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_consent_orchestration'),'UPDATE'),false)=true
  ),false)),
  ('20261003000001-032-commonswarm_oauth-admin_consent_orchestration-DELETE', COALESCE((
    COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_consent_orchestration'),'DELETE'),false)=false
  ),false)),
  ('20261003000001-033-commonswarm_oauth-admin_consent_orchestration-TRUNCATE', COALESCE((
    COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_consent_orchestration'),'TRUNCATE'),false)=false
  ),false)),
  ('20261003000001-034-commonswarm_oauth-admin_consent_orchestration-REFERENCES', COALESCE((
    COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_consent_orchestration'),'REFERENCES'),false)=false
  ),false)),
  ('20261003000001-035-commonswarm_oauth-admin_consent_orchestration-TRIGGER', COALESCE((
    COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_consent_orchestration'),'TRIGGER'),false)=false
  ),false)),
  ('20261003000001-036-commonswarm_oauth-admin_consent_orchestration', COALESCE((
    (SELECT count(*) FROM pg_constraint WHERE conrelid=to_regclass('commonswarm_oauth.admin_consent_orchestration') AND contype='c')=2
  ),false)),
  ('20261003000001-037-commonswarm_oauth-guard_provider_resource', COALESCE((
    EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('commonswarm_oauth.guard_provider_resource()')
  AND pg_get_userbyid(p.proowner)='swarm_admin' AND p.prosecdef=true
  AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND md5(p.prosrc)='fa863db5101597bedb94164efe118308'
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.grantee<>p.proowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY[]::text[])))
  AND (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)=0)
  ),false)),
  ('20261003000001-038-commonswarm_oauth-guard_admin_binding', COALESCE((
    EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('commonswarm_oauth.guard_admin_binding()')
  AND pg_get_userbyid(p.proowner)='swarm_admin' AND p.prosecdef=true
  AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND md5(p.prosrc)='e082590a4d73eb455f4ff361c7870a36'
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.grantee<>p.proowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY[]::text[])))
  AND (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)=0)
  ),false)),
  ('20261003000001-039-commonswarm_oauth-guard_admin_interaction', COALESCE((
    EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('commonswarm_oauth.guard_admin_interaction()')
  AND pg_get_userbyid(p.proowner)='swarm_admin' AND p.prosecdef=true
  AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND md5(p.prosrc)='cb7eaed43f2bf223847f63b64f374db0'
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.grantee<>p.proowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY[]::text[])))
  AND (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)=0)
  ),false)),
  ('20261003000001-040-commonswarm_oauth-guard_hosted_resource', COALESCE((
    EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('commonswarm_oauth.guard_hosted_resource()')
  AND pg_get_userbyid(p.proowner)='swarm_admin' AND p.prosecdef=true
  AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND md5(p.prosrc)='d593553ca8269529888f3666b3058d07'
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.grantee<>p.proowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY[]::text[])))
  AND (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)=0)
  ),false)),
  ('20261003000001-041-commonswarm_oauth-provider_grant_resources', COALESCE((
    EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.provider_grant_resources') AND tgname='provider_resource_match' AND tgenabled='O' AND NOT tgisinternal AND tgtype=7 AND tgfoid=to_regprocedure('commonswarm_oauth.guard_provider_resource()'))
  ),false)),
  ('20261003000001-042-commonswarm_oauth-provider_grant_resources', COALESCE((
    EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.provider_grant_resources') AND tgname='provider_resource_immutable' AND tgenabled='O' AND NOT tgisinternal AND tgtype=27 AND tgfoid=to_regprocedure('swarm.prevent_append_only_mutation()'))
  ),false)),
  ('20261003000001-043-commonswarm_oauth-admin_grant_bindings', COALESCE((
    EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.admin_grant_bindings') AND tgname='admin_binding_guard' AND tgenabled='O' AND NOT tgisinternal AND tgtype=31 AND tgfoid=to_regprocedure('commonswarm_oauth.guard_admin_binding()'))
  ),false)),
  ('20261003000001-044-commonswarm_oauth-admin_interactions', COALESCE((
    EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.admin_interactions') AND tgname='admin_interaction_guard' AND tgenabled='O' AND NOT tgisinternal AND tgtype=31 AND tgfoid=to_regprocedure('commonswarm_oauth.guard_admin_interaction()'))
  ),false)),
  ('20261003000001-045-swarm-hosted_mcp_grants', COALESCE((
    EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('swarm.hosted_mcp_grants') AND tgname='hosted_resource_guard' AND tgenabled='O' AND NOT tgisinternal AND tgtype=23 AND tgfoid=to_regprocedure('commonswarm_oauth.guard_hosted_resource()'))
  ),false)),
  ('20261003000001-046-commonswarm_oauth-guard_provider_artifact_resource', COALESCE((
    EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('commonswarm_oauth.guard_provider_artifact_resource()') AND p.prosecdef AND pg_get_userbyid(p.proowner)='swarm_admin' AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND md5(p.prosrc)='a934026e3ee9d68b7067f80e32552b0e' AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner))
  ),false)),
  ('20261003000001-047-commonswarm_oauth-provider_artifacts', COALESCE((
    EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.provider_artifacts') AND tgname='provider_artifact_resource_guard' AND tgenabled='O' AND NOT tgisinternal AND tgtype=23 AND tgfoid=to_regprocedure('commonswarm_oauth.guard_provider_artifact_resource()'))
  ),false)),
  ('20261003000001-048-commonswarm_oauth-provider_grant_resources-provider_grant_id', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.provider_grant_resources') AND attname='provider_grant_id' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000001-049-commonswarm_oauth-provider_grant_resources-resource', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.provider_grant_resources') AND attname='resource' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000001-050-commonswarm_oauth-provider_grant_resources-grant_class', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.provider_grant_resources') AND attname='grant_class' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000001-051-commonswarm_oauth-provider_grant_resources-owner_user_id', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.provider_grant_resources') AND attname='owner_user_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000001-052-commonswarm_oauth-provider_grant_resources-client_id', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.provider_grant_resources') AND attname='client_id' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000001-053-commonswarm_oauth-provider_grant_resources-connection_id', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.provider_grant_resources') AND attname='connection_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000001-054-commonswarm_oauth-provider_grant_resources-hosted_grant_id', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.provider_grant_resources') AND attname='hosted_grant_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=false)
  ),false)),
  ('20261003000001-055-commonswarm_oauth-provider_grant_resources-admin_grant_id', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.provider_grant_resources') AND attname='admin_grant_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=false)
  ),false)),
  ('20261003000001-056-commonswarm_oauth-provider_grant_resources-created_at', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.provider_grant_resources') AND attname='created_at' AND NOT attisdropped AND atttypid='timestamptz'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000001-057-commonswarm_oauth-provider_grant_resources', COALESCE((
    NOT EXISTS(SELECT 1 FROM pg_policy p WHERE polrelid=to_regclass('commonswarm_oauth.provider_grant_resources') AND (0=ANY(polroles) OR NOT polpermissive OR (polqual IS NOT NULL AND pg_get_expr(polqual,polrelid)<>'true') OR (polwithcheck IS NOT NULL AND pg_get_expr(polwithcheck,polrelid)<>'true')))
  ),false)),
  ('20261003000001-058-commonswarm_oauth-admin_grant_bindings-provider_grant_id', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_grant_bindings') AND attname='provider_grant_id' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000001-059-commonswarm_oauth-admin_grant_bindings-admin_grant_id', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_grant_bindings') AND attname='admin_grant_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000001-060-commonswarm_oauth-admin_grant_bindings-owner_user_id', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_grant_bindings') AND attname='owner_user_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000001-061-commonswarm_oauth-admin_grant_bindings-admin_identity_id', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_grant_bindings') AND attname='admin_identity_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000001-062-commonswarm_oauth-admin_grant_bindings-connection_id', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_grant_bindings') AND attname='connection_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000001-063-commonswarm_oauth-admin_grant_bindings-client_id', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_grant_bindings') AND attname='client_id' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000001-064-commonswarm_oauth-admin_grant_bindings-resource', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_grant_bindings') AND attname='resource' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000001-065-commonswarm_oauth-admin_grant_bindings-grant_class', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_grant_bindings') AND attname='grant_class' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000001-066-commonswarm_oauth-admin_grant_bindings-registry_version', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_grant_bindings') AND attname='registry_version' AND NOT attisdropped AND atttypid='integer'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000001-067-commonswarm_oauth-admin_grant_bindings-capabilities', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_grant_bindings') AND attname='capabilities' AND NOT attisdropped AND atttypid='text[]'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000001-068-commonswarm_oauth-admin_grant_bindings-scope_names', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_grant_bindings') AND attname='scope_names' AND NOT attisdropped AND atttypid='text[]'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000001-069-commonswarm_oauth-admin_grant_bindings-availability_digest', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_grant_bindings') AND attname='availability_digest' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000001-070-commonswarm_oauth-admin_grant_bindings-manifest_digest', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_grant_bindings') AND attname='manifest_digest' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000001-071-commonswarm_oauth-admin_grant_bindings-verification_version', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_grant_bindings') AND attname='verification_version' AND NOT attisdropped AND atttypid='integer'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000001-072-commonswarm_oauth-admin_grant_bindings-jkt', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_grant_bindings') AND attname='jkt' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000001-073-commonswarm_oauth-admin_grant_bindings-consented_at', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_grant_bindings') AND attname='consented_at' AND NOT attisdropped AND atttypid='timestamptz'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000001-074-commonswarm_oauth-admin_grant_bindings-expires_at', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_grant_bindings') AND attname='expires_at' AND NOT attisdropped AND atttypid='timestamptz'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000001-075-commonswarm_oauth-admin_grant_bindings-refresh_deadline', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_grant_bindings') AND attname='refresh_deadline' AND NOT attisdropped AND atttypid='timestamptz'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000001-076-commonswarm_oauth-admin_grant_bindings-generation', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_grant_bindings') AND attname='generation' AND NOT attisdropped AND atttypid='integer'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000001-077-commonswarm_oauth-admin_grant_bindings-state', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_grant_bindings') AND attname='state' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000001-078-commonswarm_oauth-admin_grant_bindings', COALESCE((
    NOT EXISTS(SELECT 1 FROM pg_policy p WHERE polrelid=to_regclass('commonswarm_oauth.admin_grant_bindings') AND (0=ANY(polroles) OR NOT polpermissive OR (polqual IS NOT NULL AND pg_get_expr(polqual,polrelid)<>'true') OR (polwithcheck IS NOT NULL AND pg_get_expr(polwithcheck,polrelid)<>'true')))
  ),false)),
  ('20261003000001-079-commonswarm_oauth-admin_interactions-interaction_uid', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_interactions') AND attname='interaction_uid' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000001-080-commonswarm_oauth-admin_interactions-owner_user_id', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_interactions') AND attname='owner_user_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000001-081-commonswarm_oauth-admin_interactions-client_id', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_interactions') AND attname='client_id' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000001-082-commonswarm_oauth-admin_interactions-resource', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_interactions') AND attname='resource' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000001-083-commonswarm_oauth-admin_interactions-redirect_uri', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_interactions') AND attname='redirect_uri' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000001-084-commonswarm_oauth-admin_interactions-registry_version', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_interactions') AND attname='registry_version' AND NOT attisdropped AND atttypid='integer'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000001-085-commonswarm_oauth-admin_interactions-verification_version', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_interactions') AND attname='verification_version' AND NOT attisdropped AND atttypid='integer'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000001-086-commonswarm_oauth-admin_interactions-manifest', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_interactions') AND attname='manifest' AND NOT attisdropped AND atttypid='jsonb'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000001-087-commonswarm_oauth-admin_interactions-manifest_digest', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_interactions') AND attname='manifest_digest' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000001-088-commonswarm_oauth-admin_interactions-availability_digest', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_interactions') AND attname='availability_digest' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000001-089-commonswarm_oauth-admin_interactions-requested_scopes', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_interactions') AND attname='requested_scopes' AND NOT attisdropped AND atttypid='text[]'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000001-090-commonswarm_oauth-admin_interactions-session_binding', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_interactions') AND attname='session_binding' AND NOT attisdropped AND atttypid='bytea'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000001-091-commonswarm_oauth-admin_interactions-csrf_binding', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_interactions') AND attname='csrf_binding' AND NOT attisdropped AND atttypid='bytea'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000001-092-commonswarm_oauth-admin_interactions-second_confirmation_binding', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_interactions') AND attname='second_confirmation_binding' AND NOT attisdropped AND atttypid='bytea'::regtype AND attnotnull=false)
  ),false)),
  ('20261003000001-093-commonswarm_oauth-admin_interactions-full_account', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_interactions') AND attname='full_account' AND NOT attisdropped AND atttypid='boolean'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000001-094-commonswarm_oauth-admin_interactions-pkce_challenge', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_interactions') AND attname='pkce_challenge' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000001-095-commonswarm_oauth-admin_interactions-pkce_method', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_interactions') AND attname='pkce_method' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000001-096-commonswarm_oauth-admin_interactions-jkt', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_interactions') AND attname='jkt' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000001-097-commonswarm_oauth-admin_interactions-created_at', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_interactions') AND attname='created_at' AND NOT attisdropped AND atttypid='timestamptz'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000001-098-commonswarm_oauth-admin_interactions-expires_at', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_interactions') AND attname='expires_at' AND NOT attisdropped AND atttypid='timestamptz'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000001-099-commonswarm_oauth-admin_interactions', COALESCE((
    NOT EXISTS(SELECT 1 FROM pg_policy p WHERE polrelid=to_regclass('commonswarm_oauth.admin_interactions') AND (0=ANY(polroles) OR NOT polpermissive OR (polqual IS NOT NULL AND pg_get_expr(polqual,polrelid)<>'true') OR (polwithcheck IS NOT NULL AND pg_get_expr(polwithcheck,polrelid)<>'true')))
  ),false)),
  ('20261003000001-100-commonswarm_oauth-admin_consent_orchestration-interaction_uid', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_consent_orchestration') AND attname='interaction_uid' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000001-101-commonswarm_oauth-admin_consent_orchestration-owner_user_id', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_consent_orchestration') AND attname='owner_user_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000001-102-commonswarm_oauth-admin_consent_orchestration-step_kind', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_consent_orchestration') AND attname='step_kind' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000001-103-commonswarm_oauth-admin_consent_orchestration-command_id', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_consent_orchestration') AND attname='command_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000001-104-commonswarm_oauth-admin_consent_orchestration-receipt_id', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_consent_orchestration') AND attname='receipt_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=false)
  ),false)),
  ('20261003000001-105-commonswarm_oauth-admin_consent_orchestration', COALESCE((
    NOT EXISTS(SELECT 1 FROM pg_policy p WHERE polrelid=to_regclass('commonswarm_oauth.admin_consent_orchestration') AND (0=ANY(polroles) OR NOT polpermissive OR (polqual IS NOT NULL AND pg_get_expr(polqual,polrelid)<>'true') OR (polwithcheck IS NOT NULL AND pg_get_expr(polwithcheck,polrelid)<>'true')))
  ),false)),
  ('20261003000001-106-commonswarm_oauth-provider_grant_resources', COALESCE((
    NOT EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) acl WHERE a.attrelid=to_regclass('commonswarm_oauth.provider_grant_resources') AND NOT a.attisdropped AND acl.grantee<>(SELECT relowner FROM pg_class WHERE oid=a.attrelid))
  ),false)),
  ('20261003000001-107-commonswarm_oauth-admin_grant_bindings', COALESCE((
    NOT EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) acl WHERE a.attrelid=to_regclass('commonswarm_oauth.admin_grant_bindings') AND NOT a.attisdropped AND acl.grantee<>(SELECT relowner FROM pg_class WHERE oid=a.attrelid) AND NOT (acl.grantee=(SELECT oid FROM pg_roles WHERE rolname='swarm_command') AND acl.privilege_type='SELECT' AND a.attname=ANY(ARRAY['provider_grant_id','admin_grant_id','owner_user_id','client_id','verification_version'])))
  ),false)),
  ('20261003000001-108-commonswarm_oauth-admin_interactions', COALESCE((
    NOT EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) acl WHERE a.attrelid=to_regclass('commonswarm_oauth.admin_interactions') AND NOT a.attisdropped AND acl.grantee<>(SELECT relowner FROM pg_class WHERE oid=a.attrelid))
  ),false)),
  ('20261003000001-109-commonswarm_oauth-admin_consent_orchestration', COALESCE((
    NOT EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) acl WHERE a.attrelid=to_regclass('commonswarm_oauth.admin_consent_orchestration') AND NOT a.attisdropped AND acl.grantee<>(SELECT relowner FROM pg_class WHERE oid=a.attrelid))
  ),false)),
  ('20261003000001-110-commonswarm_oauth-guard_admin_parent_interaction', COALESCE((
    EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('commonswarm_oauth.guard_admin_parent_interaction()') AND p.prosecdef AND pg_get_userbyid(p.proowner)='swarm_admin' AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND md5(p.prosrc)='6dea50330937663d2cc33750d35c516b' AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner))
  ),false)),
  ('20261003000001-111-commonswarm_oauth-guard_admin_consent_orchestration', COALESCE((
    EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('commonswarm_oauth.guard_admin_consent_orchestration()') AND p.prosecdef AND pg_get_userbyid(p.proowner)='swarm_admin' AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND md5(p.prosrc)='492abd8128d14b59d5046874ff12642e' AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner))
  ),false)),
  ('20261003000001-112-commonswarm_oauth-interactions', COALESCE((
    EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.interactions') AND tgname='admin_parent_interaction_guard' AND tgenabled='O' AND NOT tgisinternal AND tgtype=19 AND tgfoid=to_regprocedure('commonswarm_oauth.guard_admin_parent_interaction()'))
  ),false)),
  ('20261003000001-113-commonswarm_oauth-admin_consent_orchestration', COALESCE((
    EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.admin_consent_orchestration') AND tgname='admin_consent_orchestration_guard' AND tgenabled='O' AND NOT tgisinternal AND tgtype=31 AND tgfoid=to_regprocedure('commonswarm_oauth.guard_admin_consent_orchestration()'))
  ),false)),
  ('20261003000001-114-commonswarm_oauth-admin_grant_bindings-initial_issued_at', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_grant_bindings') AND attname='initial_issued_at' AND NOT attisdropped AND atttypid='timestamptz'::regtype AND attnotnull=false)
  ),false)),
  ('20261003000001-115-commonswarm_oauth-admin_grant_bindings-terminal_at', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_grant_bindings') AND attname='terminal_at' AND NOT attisdropped AND atttypid='timestamptz'::regtype AND attnotnull=false)
  ),false)),
  ('20261003000001-116-commonswarm_oauth-admin_interactions-second_confirmed_at', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_interactions') AND attname='second_confirmed_at' AND NOT attisdropped AND atttypid='timestamptz'::regtype AND attnotnull=false)
  ),false)),
  ('20261003000001-117-commonswarm_oauth-admin_interactions-replacement_grant_id', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_interactions') AND attname='replacement_grant_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=false)
  ),false)),
  ('20261003000001-118-commonswarm_oauth-admin_interactions-consumed_at', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_interactions') AND attname='consumed_at' AND NOT attisdropped AND atttypid='timestamptz'::regtype AND attnotnull=false)
  ),false)),
  ('20261003000001-119-commonswarm_oauth-admin_consent_orchestration-completed_at', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_consent_orchestration') AND attname='completed_at' AND NOT attisdropped AND atttypid='timestamptz'::regtype AND attnotnull=false)
  ),false))
)
SELECT COALESCE(string_agg(label,',' ORDER BY label) FILTER (WHERE NOT ok),'') AS catalog_ok_failed_checks,
  COALESCE(bool_and(ok),false) AS catalog_ok_checks_ok FROM checks
\gset
\if :catalog_ok_checks_ok
\else
\warn 20261003000001 failed checks: :catalog_ok_failed_checks
\endif
SELECT :'catalog_ok_checks_ok'::boolean AS catalog_ok
\gset
