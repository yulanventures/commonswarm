-- Forward catalog (review input) for 20261003000001. Safe OID lookups fail closed.
SELECT COALESCE((
  EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=to_regclass('commonswarm_oauth.provider_grant_resources')
  AND c.relkind='r' AND pg_get_userbyid(c.relowner)='swarm_admin' AND c.relrowsecurity AND NOT c.relforcerowsecurity
  AND (SELECT array_agg(a.attname::text ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped)=ARRAY['provider_grant_id','resource','grant_class','owner_user_id','client_id','connection_id','hosted_grant_id','admin_grant_id','created_at']::text[]
  AND (SELECT count(*) FROM pg_constraint WHERE conrelid=c.oid AND contype='p' AND convalidated)=1
  AND NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=c.oid AND NOT convalidated)
  AND NOT EXISTS(SELECT 1 FROM pg_index WHERE indrelid=c.oid AND (NOT indisvalid OR NOT indisready))
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    WHERE a.grantee<>c.relowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY['commonswarm_oauth_runtime']::text[]))))
  AND COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.provider_grant_resources'),'SELECT'),false)=true
  AND COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.provider_grant_resources'),'INSERT'),false)=true
  AND COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.provider_grant_resources'),'UPDATE'),false)=false
  AND COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.provider_grant_resources'),'DELETE'),false)=false
  AND COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.provider_grant_resources'),'TRUNCATE'),false)=false
  AND COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.provider_grant_resources'),'REFERENCES'),false)=false
  AND COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.provider_grant_resources'),'TRIGGER'),false)=false
  AND (SELECT count(*) FROM pg_constraint WHERE conrelid=to_regclass('commonswarm_oauth.provider_grant_resources') AND contype='c')=4
  AND EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=to_regclass('commonswarm_oauth.admin_grant_bindings')
  AND c.relkind='r' AND pg_get_userbyid(c.relowner)='swarm_admin' AND c.relrowsecurity AND NOT c.relforcerowsecurity
  AND (SELECT array_agg(a.attname::text ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped)=ARRAY['provider_grant_id','admin_grant_id','owner_user_id','admin_identity_id','connection_id','client_id','resource','grant_class','registry_version','capabilities','scope_names','availability_digest','manifest_digest','verification_version','jkt','consented_at','expires_at','refresh_deadline','initial_issued_at','generation','state','terminal_at']::text[]
  AND (SELECT count(*) FROM pg_constraint WHERE conrelid=c.oid AND contype='p' AND convalidated)=1
  AND NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=c.oid AND NOT convalidated)
  AND NOT EXISTS(SELECT 1 FROM pg_index WHERE indrelid=c.oid AND (NOT indisvalid OR NOT indisready))
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    WHERE a.grantee<>c.relowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY['commonswarm_oauth_runtime']::text[]))))
  AND COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_grant_bindings'),'SELECT'),false)=true
  AND COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_grant_bindings'),'INSERT'),false)=true
  AND COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_grant_bindings'),'UPDATE'),false)=true
  AND COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_grant_bindings'),'DELETE'),false)=false
  AND COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_grant_bindings'),'TRUNCATE'),false)=false
  AND COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_grant_bindings'),'REFERENCES'),false)=false
  AND COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_grant_bindings'),'TRIGGER'),false)=false
  AND (SELECT count(*) FROM pg_constraint WHERE conrelid=to_regclass('commonswarm_oauth.admin_grant_bindings') AND contype='c')=14
  AND EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=to_regclass('commonswarm_oauth.admin_interactions')
  AND c.relkind='r' AND pg_get_userbyid(c.relowner)='swarm_admin' AND c.relrowsecurity AND NOT c.relforcerowsecurity
  AND (SELECT array_agg(a.attname::text ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped)=ARRAY['interaction_uid','owner_user_id','client_id','resource','redirect_uri','registry_version','verification_version','manifest','manifest_digest','availability_digest','requested_scopes','session_binding','csrf_binding','second_confirmation_binding','full_account','second_confirmed_at','pkce_challenge','pkce_method','jkt','replacement_grant_id','created_at','expires_at','consumed_at']::text[]
  AND (SELECT count(*) FROM pg_constraint WHERE conrelid=c.oid AND contype='p' AND convalidated)=1
  AND NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=c.oid AND NOT convalidated)
  AND NOT EXISTS(SELECT 1 FROM pg_index WHERE indrelid=c.oid AND (NOT indisvalid OR NOT indisready))
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    WHERE a.grantee<>c.relowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY['commonswarm_oauth_runtime']::text[]))))
  AND COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_interactions'),'SELECT'),false)=true
  AND COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_interactions'),'INSERT'),false)=true
  AND COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_interactions'),'UPDATE'),false)=true
  AND COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_interactions'),'DELETE'),false)=false
  AND COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_interactions'),'TRUNCATE'),false)=false
  AND COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_interactions'),'REFERENCES'),false)=false
  AND COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_interactions'),'TRIGGER'),false)=false
  AND (SELECT count(*) FROM pg_constraint WHERE conrelid=to_regclass('commonswarm_oauth.admin_interactions') AND contype='c')=19
  AND EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=to_regclass('commonswarm_oauth.admin_consent_orchestration')
  AND c.relkind='r' AND pg_get_userbyid(c.relowner)='swarm_admin' AND c.relrowsecurity AND NOT c.relforcerowsecurity
  AND (SELECT array_agg(a.attname::text ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped)=ARRAY['interaction_uid','owner_user_id','step_kind','command_id','receipt_id','completed_at']::text[]
  AND (SELECT count(*) FROM pg_constraint WHERE conrelid=c.oid AND contype='p' AND convalidated)=1
  AND NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=c.oid AND NOT convalidated)
  AND NOT EXISTS(SELECT 1 FROM pg_index WHERE indrelid=c.oid AND (NOT indisvalid OR NOT indisready))
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    WHERE a.grantee<>c.relowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY['commonswarm_oauth_runtime']::text[]))))
  AND COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_consent_orchestration'),'SELECT'),false)=true
  AND COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_consent_orchestration'),'INSERT'),false)=true
  AND COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_consent_orchestration'),'UPDATE'),false)=true
  AND COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_consent_orchestration'),'DELETE'),false)=false
  AND COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_consent_orchestration'),'TRUNCATE'),false)=false
  AND COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_consent_orchestration'),'REFERENCES'),false)=false
  AND COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_consent_orchestration'),'TRIGGER'),false)=false
  AND (SELECT count(*) FROM pg_constraint WHERE conrelid=to_regclass('commonswarm_oauth.admin_consent_orchestration') AND contype='c')=2
  AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('commonswarm_oauth.guard_provider_resource()')
  AND pg_get_userbyid(p.proowner)='swarm_admin' AND p.prosecdef=true
  AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND md5(p.prosrc)='fa863db5101597bedb94164efe118308'
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.grantee<>p.proowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY[]::text[])))
  AND (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)=0)
  AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('commonswarm_oauth.guard_admin_binding()')
  AND pg_get_userbyid(p.proowner)='swarm_admin' AND p.prosecdef=true
  AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND md5(p.prosrc)='e082590a4d73eb455f4ff361c7870a36'
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.grantee<>p.proowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY[]::text[])))
  AND (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)=0)
  AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('commonswarm_oauth.guard_admin_interaction()')
  AND pg_get_userbyid(p.proowner)='swarm_admin' AND p.prosecdef=true
  AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND md5(p.prosrc)='cb7eaed43f2bf223847f63b64f374db0'
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.grantee<>p.proowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY[]::text[])))
  AND (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)=0)
  AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('commonswarm_oauth.guard_hosted_resource()')
  AND pg_get_userbyid(p.proowner)='swarm_admin' AND p.prosecdef=true
  AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND md5(p.prosrc)='d593553ca8269529888f3666b3058d07'
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.grantee<>p.proowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY[]::text[])))
  AND (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)=0)
  AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.provider_grant_resources') AND tgname='provider_resource_match' AND tgenabled='O' AND NOT tgisinternal AND tgtype=7 AND tgfoid=to_regprocedure('commonswarm_oauth.guard_provider_resource()'))
  AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.provider_grant_resources') AND tgname='provider_resource_immutable' AND tgenabled='O' AND NOT tgisinternal AND tgtype=27 AND tgfoid=to_regprocedure('swarm.prevent_append_only_mutation()'))
  AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.admin_grant_bindings') AND tgname='admin_binding_guard' AND tgenabled='O' AND NOT tgisinternal AND tgtype=31 AND tgfoid=to_regprocedure('commonswarm_oauth.guard_admin_binding()'))
  AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.admin_interactions') AND tgname='admin_interaction_guard' AND tgenabled='O' AND NOT tgisinternal AND tgtype=31 AND tgfoid=to_regprocedure('commonswarm_oauth.guard_admin_interaction()'))
  AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('swarm.hosted_mcp_grants') AND tgname='hosted_resource_guard' AND tgenabled='O' AND NOT tgisinternal AND tgtype=23 AND tgfoid=to_regprocedure('commonswarm_oauth.guard_hosted_resource()'))
  AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('commonswarm_oauth.guard_provider_artifact_resource()') AND p.prosecdef AND pg_get_userbyid(p.proowner)='swarm_admin' AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND md5(p.prosrc)='c44ae30627307a51fde20b6038698b6f' AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner))
  AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.provider_artifacts') AND tgname='provider_artifact_resource_guard' AND tgenabled='O' AND NOT tgisinternal AND tgtype=23 AND tgfoid=to_regprocedure('commonswarm_oauth.guard_provider_artifact_resource()'))
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.provider_grant_resources') AND attname='provider_grant_id' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.provider_grant_resources') AND attname='resource' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.provider_grant_resources') AND attname='grant_class' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.provider_grant_resources') AND attname='owner_user_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.provider_grant_resources') AND attname='client_id' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.provider_grant_resources') AND attname='connection_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.provider_grant_resources') AND attname='hosted_grant_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=false)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.provider_grant_resources') AND attname='admin_grant_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=false)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.provider_grant_resources') AND attname='created_at' AND NOT attisdropped AND atttypid='timestamptz'::regtype AND attnotnull=true)
  AND NOT EXISTS(SELECT 1 FROM pg_policy p WHERE polrelid=to_regclass('commonswarm_oauth.provider_grant_resources') AND (0=ANY(polroles) OR NOT polpermissive OR (polqual IS NOT NULL AND pg_get_expr(polqual,polrelid)<>'true') OR (polwithcheck IS NOT NULL AND pg_get_expr(polwithcheck,polrelid)<>'true')))
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_grant_bindings') AND attname='provider_grant_id' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_grant_bindings') AND attname='admin_grant_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_grant_bindings') AND attname='owner_user_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_grant_bindings') AND attname='admin_identity_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_grant_bindings') AND attname='connection_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_grant_bindings') AND attname='client_id' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_grant_bindings') AND attname='resource' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_grant_bindings') AND attname='grant_class' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_grant_bindings') AND attname='registry_version' AND NOT attisdropped AND atttypid='integer'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_grant_bindings') AND attname='capabilities' AND NOT attisdropped AND atttypid='text[]'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_grant_bindings') AND attname='scope_names' AND NOT attisdropped AND atttypid='text[]'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_grant_bindings') AND attname='availability_digest' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_grant_bindings') AND attname='manifest_digest' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_grant_bindings') AND attname='verification_version' AND NOT attisdropped AND atttypid='integer'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_grant_bindings') AND attname='jkt' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_grant_bindings') AND attname='consented_at' AND NOT attisdropped AND atttypid='timestamptz'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_grant_bindings') AND attname='expires_at' AND NOT attisdropped AND atttypid='timestamptz'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_grant_bindings') AND attname='refresh_deadline' AND NOT attisdropped AND atttypid='timestamptz'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_grant_bindings') AND attname='generation' AND NOT attisdropped AND atttypid='integer'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_grant_bindings') AND attname='state' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  AND NOT EXISTS(SELECT 1 FROM pg_policy p WHERE polrelid=to_regclass('commonswarm_oauth.admin_grant_bindings') AND (0=ANY(polroles) OR NOT polpermissive OR (polqual IS NOT NULL AND pg_get_expr(polqual,polrelid)<>'true') OR (polwithcheck IS NOT NULL AND pg_get_expr(polwithcheck,polrelid)<>'true')))
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_interactions') AND attname='interaction_uid' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_interactions') AND attname='owner_user_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_interactions') AND attname='client_id' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_interactions') AND attname='resource' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_interactions') AND attname='redirect_uri' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_interactions') AND attname='registry_version' AND NOT attisdropped AND atttypid='integer'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_interactions') AND attname='verification_version' AND NOT attisdropped AND atttypid='integer'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_interactions') AND attname='manifest' AND NOT attisdropped AND atttypid='jsonb'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_interactions') AND attname='manifest_digest' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_interactions') AND attname='availability_digest' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_interactions') AND attname='requested_scopes' AND NOT attisdropped AND atttypid='text[]'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_interactions') AND attname='session_binding' AND NOT attisdropped AND atttypid='bytea'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_interactions') AND attname='csrf_binding' AND NOT attisdropped AND atttypid='bytea'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_interactions') AND attname='second_confirmation_binding' AND NOT attisdropped AND atttypid='bytea'::regtype AND attnotnull=false)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_interactions') AND attname='full_account' AND NOT attisdropped AND atttypid='boolean'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_interactions') AND attname='pkce_challenge' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_interactions') AND attname='pkce_method' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_interactions') AND attname='jkt' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_interactions') AND attname='created_at' AND NOT attisdropped AND atttypid='timestamptz'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_interactions') AND attname='expires_at' AND NOT attisdropped AND atttypid='timestamptz'::regtype AND attnotnull=true)
  AND NOT EXISTS(SELECT 1 FROM pg_policy p WHERE polrelid=to_regclass('commonswarm_oauth.admin_interactions') AND (0=ANY(polroles) OR NOT polpermissive OR (polqual IS NOT NULL AND pg_get_expr(polqual,polrelid)<>'true') OR (polwithcheck IS NOT NULL AND pg_get_expr(polwithcheck,polrelid)<>'true')))
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_consent_orchestration') AND attname='interaction_uid' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_consent_orchestration') AND attname='owner_user_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_consent_orchestration') AND attname='step_kind' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_consent_orchestration') AND attname='command_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_consent_orchestration') AND attname='receipt_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=false)
  AND NOT EXISTS(SELECT 1 FROM pg_policy p WHERE polrelid=to_regclass('commonswarm_oauth.admin_consent_orchestration') AND (0=ANY(polroles) OR NOT polpermissive OR (polqual IS NOT NULL AND pg_get_expr(polqual,polrelid)<>'true') OR (polwithcheck IS NOT NULL AND pg_get_expr(polwithcheck,polrelid)<>'true')))
  AND NOT EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) acl WHERE a.attrelid=to_regclass('commonswarm_oauth.provider_grant_resources') AND NOT a.attisdropped AND acl.grantee<>(SELECT relowner FROM pg_class WHERE oid=a.attrelid))
  AND NOT EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) acl WHERE a.attrelid=to_regclass('commonswarm_oauth.admin_grant_bindings') AND NOT a.attisdropped AND acl.grantee<>(SELECT relowner FROM pg_class WHERE oid=a.attrelid) AND NOT (acl.grantee=(SELECT oid FROM pg_roles WHERE rolname='swarm_command') AND acl.privilege_type='SELECT' AND a.attname=ANY(ARRAY['provider_grant_id','admin_grant_id','owner_user_id','client_id','verification_version'])))
  AND NOT EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) acl WHERE a.attrelid=to_regclass('commonswarm_oauth.admin_interactions') AND NOT a.attisdropped AND acl.grantee<>(SELECT relowner FROM pg_class WHERE oid=a.attrelid))
  AND NOT EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) acl WHERE a.attrelid=to_regclass('commonswarm_oauth.admin_consent_orchestration') AND NOT a.attisdropped AND acl.grantee<>(SELECT relowner FROM pg_class WHERE oid=a.attrelid))
  AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('commonswarm_oauth.guard_admin_parent_interaction()') AND p.prosecdef AND pg_get_userbyid(p.proowner)='swarm_admin' AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND md5(p.prosrc)='6dea50330937663d2cc33750d35c516b' AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner))
  AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('commonswarm_oauth.guard_admin_consent_orchestration()') AND p.prosecdef AND pg_get_userbyid(p.proowner)='swarm_admin' AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND md5(p.prosrc)='492abd8128d14b59d5046874ff12642e' AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner))
  AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.interactions') AND tgname='admin_parent_interaction_guard' AND tgenabled='O' AND NOT tgisinternal AND tgtype=19 AND tgfoid=to_regprocedure('commonswarm_oauth.guard_admin_parent_interaction()'))
  AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.admin_consent_orchestration') AND tgname='admin_consent_orchestration_guard' AND tgenabled='O' AND NOT tgisinternal AND tgtype=31 AND tgfoid=to_regprocedure('commonswarm_oauth.guard_admin_consent_orchestration()'))
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_grant_bindings') AND attname='initial_issued_at' AND NOT attisdropped AND atttypid='timestamptz'::regtype AND attnotnull=false)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_grant_bindings') AND attname='terminal_at' AND NOT attisdropped AND atttypid='timestamptz'::regtype AND attnotnull=false)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_interactions') AND attname='second_confirmed_at' AND NOT attisdropped AND atttypid='timestamptz'::regtype AND attnotnull=false)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_interactions') AND attname='replacement_grant_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=false)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_interactions') AND attname='consumed_at' AND NOT attisdropped AND atttypid='timestamptz'::regtype AND attnotnull=false)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_consent_orchestration') AND attname='completed_at' AND NOT attisdropped AND atttypid='timestamptz'::regtype AND attnotnull=false)
),false) AS catalog_ok
\gset
