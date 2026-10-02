-- Forward catalog (review input) for 20261003000003. Safe OID lookups fail closed.
SELECT COALESCE((
  EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=to_regclass('commonswarm_oauth.admin_oauth_audit')
  AND c.relkind='r' AND pg_get_userbyid(c.relowner)='swarm_admin' AND c.relrowsecurity AND NOT c.relforcerowsecurity
  AND (SELECT array_agg(a.attname::text ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped)=ARRAY['audit_id','occurred_at','owner_user_id','admin_identity_id','admin_grant_id','connection_id','provider_grant_id','manifest_digest','event_kind','request_id','target_id','workspace_id','outcome','reason_code','related_event_ids']::text[]
  AND (SELECT count(*) FROM pg_constraint WHERE conrelid=c.oid AND contype='p' AND convalidated)=1
  AND NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=c.oid AND NOT convalidated)
  AND NOT EXISTS(SELECT 1 FROM pg_index WHERE indrelid=c.oid AND (NOT indisvalid OR NOT indisready))
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    WHERE a.grantee<>c.relowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY['commonswarm_oauth_runtime']::text[]))))
  AND COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_oauth_audit'),'SELECT'),false)=true
  AND COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_oauth_audit'),'INSERT'),false)=true
  AND COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_oauth_audit'),'UPDATE'),false)=false
  AND COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_oauth_audit'),'DELETE'),false)=false
  AND COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_oauth_audit'),'TRUNCATE'),false)=false
  AND COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_oauth_audit'),'REFERENCES'),false)=false
  AND COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_oauth_audit'),'TRIGGER'),false)=false
  AND (SELECT count(*) FROM pg_constraint WHERE conrelid=to_regclass('commonswarm_oauth.admin_oauth_audit') AND contype='c')=7
  AND EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=to_regclass('commonswarm_oauth.admin_access_issuances')
  AND c.relkind='r' AND pg_get_userbyid(c.relowner)='swarm_admin' AND c.relrowsecurity AND NOT c.relforcerowsecurity
  AND (SELECT array_agg(a.attname::text ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped)=ARRAY['access_jti','access_token_digest','provider_grant_id','admin_grant_id','generation','client_id','resource','jkt','manifest_digest','scope_names','issuer','kid','issued_at','expires_at','event_id','audit_id']::text[]
  AND (SELECT count(*) FROM pg_constraint WHERE conrelid=c.oid AND contype='p' AND convalidated)=1
  AND NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=c.oid AND NOT convalidated)
  AND NOT EXISTS(SELECT 1 FROM pg_index WHERE indrelid=c.oid AND (NOT indisvalid OR NOT indisready))
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    WHERE a.grantee<>c.relowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY['commonswarm_oauth_runtime']::text[]))))
  AND COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_access_issuances'),'SELECT'),false)=true
  AND COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_access_issuances'),'INSERT'),false)=true
  AND COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_access_issuances'),'UPDATE'),false)=false
  AND COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_access_issuances'),'DELETE'),false)=false
  AND COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_access_issuances'),'TRUNCATE'),false)=false
  AND COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_access_issuances'),'REFERENCES'),false)=false
  AND COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_access_issuances'),'TRIGGER'),false)=false
  AND (SELECT count(*) FROM pg_constraint WHERE conrelid=to_regclass('commonswarm_oauth.admin_access_issuances') AND contype='c')=11
  AND EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=to_regclass('commonswarm_oauth.admin_cutover_state')
  AND c.relkind='r' AND pg_get_userbyid(c.relowner)='swarm_admin' AND c.relrowsecurity AND NOT c.relforcerowsecurity
  AND (SELECT array_agg(a.attname::text ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped)=ARRAY['singleton','admin_issuance_enabled','legacy_closed','legacy_closed_at','legacy_fence_evidence_ref','approved_edge_release_sha','auth_contract_version','required_migrations','lane8_evidence_digest','measured_edge_release_sha','measured_edge_target','measured_artifact_digest','measured_image_digest','measured_mount','release_generation','measured_generation','measured_at','measurement_evidence_ref','invalidated_at']::text[]
  AND (SELECT count(*) FROM pg_constraint WHERE conrelid=c.oid AND contype='p' AND convalidated)=1
  AND NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=c.oid AND NOT convalidated)
  AND NOT EXISTS(SELECT 1 FROM pg_index WHERE indrelid=c.oid AND (NOT indisvalid OR NOT indisready))
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    WHERE a.grantee<>c.relowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY['commonswarm_oauth_runtime','commonswarm_admin_release']::text[]))))
  AND COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_cutover_state'),'SELECT'),false)=true
  AND COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_cutover_state'),'INSERT'),false)=false
  AND COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_cutover_state'),'UPDATE'),false)=false
  AND COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_cutover_state'),'DELETE'),false)=false
  AND COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_cutover_state'),'TRUNCATE'),false)=false
  AND COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_cutover_state'),'REFERENCES'),false)=false
  AND COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_cutover_state'),'TRIGGER'),false)=false
  AND COALESCE(has_table_privilege('commonswarm_admin_release',to_regclass('commonswarm_oauth.admin_cutover_state'),'SELECT'),false)=true
  AND COALESCE(has_table_privilege('commonswarm_admin_release',to_regclass('commonswarm_oauth.admin_cutover_state'),'INSERT'),false)=false
  AND COALESCE(has_table_privilege('commonswarm_admin_release',to_regclass('commonswarm_oauth.admin_cutover_state'),'UPDATE'),false)=true
  AND COALESCE(has_table_privilege('commonswarm_admin_release',to_regclass('commonswarm_oauth.admin_cutover_state'),'DELETE'),false)=false
  AND COALESCE(has_table_privilege('commonswarm_admin_release',to_regclass('commonswarm_oauth.admin_cutover_state'),'TRUNCATE'),false)=false
  AND COALESCE(has_table_privilege('commonswarm_admin_release',to_regclass('commonswarm_oauth.admin_cutover_state'),'REFERENCES'),false)=false
  AND COALESCE(has_table_privilege('commonswarm_admin_release',to_regclass('commonswarm_oauth.admin_cutover_state'),'TRIGGER'),false)=false
  AND (SELECT count(*) FROM pg_constraint WHERE conrelid=to_regclass('commonswarm_oauth.admin_cutover_state') AND contype='c')=14
  AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('commonswarm_oauth.guard_cutover_state()')
  AND pg_get_userbyid(p.proowner)='swarm_admin' AND p.prosecdef=true
  AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND md5(p.prosrc)='01d4fec1172784e8adb94f106aabbef6'
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.grantee<>p.proowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY[]::text[])))
  AND (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)=0)
  AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('commonswarm_oauth.guard_oauth_audit()')
  AND pg_get_userbyid(p.proowner)='swarm_admin' AND p.prosecdef=true
  AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND md5(p.prosrc)='cf9ad1db05bd2a76fe6db07c200443d3'
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.grantee<>p.proowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY[]::text[])))
  AND (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)=0)
  AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('commonswarm_oauth.guard_access_issuance()')
  AND pg_get_userbyid(p.proowner)='swarm_admin' AND p.prosecdef=true
  AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND md5(p.prosrc)='65e605a56064b680e33e79993fc02c00'
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.grantee<>p.proowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY[]::text[])))
  AND (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)=0)
  AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('commonswarm_oauth.admin_access_is_active(text,bytea,text,uuid,uuid,integer,text,text,text,text,timestamptz,timestamptz,text)')
  AND pg_get_userbyid(p.proowner)='swarm_admin' AND p.prosecdef=true
  AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND md5(p.prosrc)='ce9856166b92f801dd5e2a90112a1d5f'
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.grantee<>p.proowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY['commonswarm_oauth_runtime','swarm_command','swarm_read']::text[])))
  AND (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)=3)
  AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('commonswarm_oauth.admin_grant_family_fence()')
  AND pg_get_userbyid(p.proowner)='swarm_admin' AND p.prosecdef=true
  AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND md5(p.prosrc)='3b38e3605ac4a994a2892fb92677d7e1'
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.grantee<>p.proowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY[]::text[])))
  AND (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)=0)
  AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('commonswarm_oauth.tombstone_admin_family()')
  AND pg_get_userbyid(p.proowner)='swarm_admin' AND p.prosecdef=true
  AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND md5(p.prosrc)='420bf5228314975fe31665f3efc90ef8'
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.grantee<>p.proowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY[]::text[])))
  AND (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)=0)
  AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('commonswarm_oauth.deny_issuer_admin_families()')
  AND pg_get_userbyid(p.proowner)='swarm_admin' AND p.prosecdef=true
  AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND md5(p.prosrc)='a4f898efa91c38cb256db00228b17fea'
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.grantee<>p.proowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY[]::text[])))
  AND (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)=0)
  AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('commonswarm_oauth.guard_legacy_admin_write()')
  AND pg_get_userbyid(p.proowner)='swarm_admin' AND p.prosecdef=true
  AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND md5(p.prosrc)='3584f74082816075c37c524ea4aef424'
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.grantee<>p.proowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY[]::text[])))
  AND (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)=0)
  AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('commonswarm_oauth.apply_legacy_admin_fence(text)')
  AND pg_get_userbyid(p.proowner)='swarm_admin' AND p.prosecdef=true
  AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND md5(p.prosrc)='6bd22688b08e7feda1317e7659e92179'
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.grantee<>p.proowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY['commonswarm_admin_release']::text[])))
  AND (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)=1)
  AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('swarm_read.admin_oauth_recovery_page(integer)')
  AND pg_get_userbyid(p.proowner)='swarm_admin' AND p.prosecdef=true
  AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND md5(p.prosrc)='23dcb9cfa5a61f4c97f2af5d0fe20465'
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.grantee<>p.proowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY['swarm_read']::text[])))
  AND (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)=1)
  AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.admin_oauth_audit') AND tgname='admin_oauth_audit_append_only' AND tgenabled='O' AND NOT tgisinternal AND tgtype=27 AND tgfoid=to_regprocedure('swarm.prevent_append_only_mutation()'))
  AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.admin_access_issuances') AND tgname='admin_issuances_append_only' AND tgenabled='O' AND NOT tgisinternal AND tgtype=27 AND tgfoid=to_regprocedure('swarm.prevent_append_only_mutation()'))
  AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.admin_cutover_state') AND tgname='admin_cutover_guard' AND tgenabled='O' AND NOT tgisinternal AND tgtype=27 AND tgfoid=to_regprocedure('commonswarm_oauth.guard_cutover_state()'))
  AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.admin_oauth_audit') AND tgname='admin_oauth_audit_binding' AND tgenabled='O' AND NOT tgisinternal AND tgtype=7 AND tgfoid=to_regprocedure('commonswarm_oauth.guard_oauth_audit()'))
  AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.admin_access_issuances') AND tgname='admin_access_issuance_binding' AND tgenabled='O' AND NOT tgisinternal AND tgtype=7 AND tgfoid=to_regprocedure('commonswarm_oauth.guard_access_issuance()'))
  AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('swarm.admin_grants') AND tgname='admin_grant_oauth_fence' AND tgenabled='O' AND NOT tgisinternal AND tgtype=17 AND tgfoid=to_regprocedure('commonswarm_oauth.admin_grant_family_fence()'))
  AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.refresh_family_tombstones') AND tgname='oauth_tombstone_admin_fence' AND tgenabled='O' AND NOT tgisinternal AND tgtype=5 AND tgfoid=to_regprocedure('commonswarm_oauth.tombstone_admin_family()'))
  AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.issuer_key_denials') AND tgname='issuer_denial_admin_fence' AND tgenabled='O' AND NOT tgisinternal AND tgtype=5 AND tgfoid=to_regprocedure('commonswarm_oauth.deny_issuer_admin_families()'))
  AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('swarm.admin_credentials') AND tgname='admin_credentials_legacy_guard' AND tgenabled='O' AND NOT tgisinternal AND tgtype=31 AND tgfoid=to_regprocedure('commonswarm_oauth.guard_legacy_admin_write()'))
  AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('swarm.admin_grants') AND tgname='admin_grants_legacy_guard' AND tgenabled='O' AND NOT tgisinternal AND tgtype=23 AND tgfoid=to_regprocedure('commonswarm_oauth.guard_legacy_admin_write()'))
  AND (SELECT count(*)=1 FROM commonswarm_oauth.admin_cutover_state)
  AND NOT has_table_privilege('commonswarm_oauth_runtime','swarm.admin_events','INSERT') AND NOT has_table_privilege('commonswarm_oauth_runtime','swarm.admin_grants','UPDATE')
  AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.refresh_family_tombstones') AND tgname='oauth_tombstones_append_only' AND tgenabled='O' AND NOT tgisinternal AND tgtype=27 AND tgfoid=to_regprocedure('swarm.prevent_append_only_mutation()'))
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_oauth_audit') AND attname='audit_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_oauth_audit') AND attname='occurred_at' AND NOT attisdropped AND atttypid='timestamptz'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_oauth_audit') AND attname='owner_user_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_oauth_audit') AND attname='admin_identity_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_oauth_audit') AND attname='admin_grant_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_oauth_audit') AND attname='connection_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_oauth_audit') AND attname='provider_grant_id' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_oauth_audit') AND attname='manifest_digest' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_oauth_audit') AND attname='event_kind' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_oauth_audit') AND attname='request_id' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=false)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_oauth_audit') AND attname='target_id' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=false)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_oauth_audit') AND attname='outcome' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_oauth_audit') AND attname='reason_code' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=false)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_oauth_audit') AND attname='related_event_ids' AND NOT attisdropped AND atttypid='uuid[]'::regtype AND attnotnull=true)
  AND NOT EXISTS(SELECT 1 FROM pg_policy p WHERE polrelid=to_regclass('commonswarm_oauth.admin_oauth_audit') AND (0=ANY(polroles) OR NOT polpermissive OR (polqual IS NOT NULL AND pg_get_expr(polqual,polrelid)<>'true') OR (polwithcheck IS NOT NULL AND pg_get_expr(polwithcheck,polrelid)<>'true')))
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_access_issuances') AND attname='access_jti' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_access_issuances') AND attname='access_token_digest' AND NOT attisdropped AND atttypid='bytea'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_access_issuances') AND attname='provider_grant_id' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_access_issuances') AND attname='admin_grant_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_access_issuances') AND attname='generation' AND NOT attisdropped AND atttypid='integer'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_access_issuances') AND attname='client_id' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_access_issuances') AND attname='resource' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_access_issuances') AND attname='jkt' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_access_issuances') AND attname='manifest_digest' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_access_issuances') AND attname='scope_names' AND NOT attisdropped AND atttypid='text[]'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_access_issuances') AND attname='issuer' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_access_issuances') AND attname='kid' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_access_issuances') AND attname='issued_at' AND NOT attisdropped AND atttypid='timestamptz'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_access_issuances') AND attname='expires_at' AND NOT attisdropped AND atttypid='timestamptz'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_access_issuances') AND attname='event_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_access_issuances') AND attname='audit_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=true)
  AND NOT EXISTS(SELECT 1 FROM pg_policy p WHERE polrelid=to_regclass('commonswarm_oauth.admin_access_issuances') AND (0=ANY(polroles) OR NOT polpermissive OR (polqual IS NOT NULL AND pg_get_expr(polqual,polrelid)<>'true') OR (polwithcheck IS NOT NULL AND pg_get_expr(polwithcheck,polrelid)<>'true')))
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_cutover_state') AND attname='singleton' AND NOT attisdropped AND atttypid='boolean'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_cutover_state') AND attname='admin_issuance_enabled' AND NOT attisdropped AND atttypid='boolean'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_cutover_state') AND attname='legacy_closed' AND NOT attisdropped AND atttypid='boolean'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_cutover_state') AND attname='approved_edge_release_sha' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=false)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_cutover_state') AND attname='auth_contract_version' AND NOT attisdropped AND atttypid='integer'::regtype AND attnotnull=false)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_cutover_state') AND attname='required_migrations' AND NOT attisdropped AND atttypid='jsonb'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_cutover_state') AND attname='lane8_evidence_digest' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=false)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_cutover_state') AND attname='measured_edge_release_sha' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=false)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_cutover_state') AND attname='measured_artifact_digest' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=false)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_cutover_state') AND attname='measured_image_digest' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=false)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_cutover_state') AND attname='release_generation' AND NOT attisdropped AND atttypid='bigint'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_cutover_state') AND attname='measured_generation' AND NOT attisdropped AND atttypid='bigint'::regtype AND attnotnull=false)
  AND NOT EXISTS(SELECT 1 FROM pg_policy p WHERE polrelid=to_regclass('commonswarm_oauth.admin_cutover_state') AND (0=ANY(polroles) OR NOT polpermissive OR (polqual IS NOT NULL AND pg_get_expr(polqual,polrelid)<>'true') OR (polwithcheck IS NOT NULL AND pg_get_expr(polwithcheck,polrelid)<>'true')))
  AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('commonswarm_oauth.valid_admin_migration_requirements(jsonb)') AND p.prosecdef=false AND pg_get_userbyid(p.proowner)='swarm_admin' AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND md5(p.prosrc)='434be8a3e61f3046947752ee964e4102' AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner AND NOT EXISTS(SELECT 1 FROM pg_roles WHERE oid=a.grantee AND rolname=ANY(ARRAY['commonswarm_admin_release']::text[]))) AND (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)=1)
  AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('commonswarm_oauth.binding_terminal_fence()') AND p.prosecdef=true AND pg_get_userbyid(p.proowner)='swarm_admin' AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND md5(p.prosrc)='20d546bfe056bc1a1fea2467c112cad1' AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner AND NOT EXISTS(SELECT 1 FROM pg_roles WHERE oid=a.grantee AND rolname=ANY(ARRAY[]::text[]))) AND (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)=0)
  AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.admin_grant_bindings') AND tgname='admin_binding_terminal_fence' AND tgenabled='O' AND NOT tgisinternal AND tgtype=17 AND tgfoid=to_regprocedure('commonswarm_oauth.binding_terminal_fence()'))
  AND NOT EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) acl WHERE a.attrelid=to_regclass('commonswarm_oauth.admin_oauth_audit') AND NOT a.attisdropped AND acl.grantee<>(SELECT relowner FROM pg_class WHERE oid=a.attrelid))
  AND NOT EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) acl WHERE a.attrelid=to_regclass('commonswarm_oauth.admin_access_issuances') AND NOT a.attisdropped AND acl.grantee<>(SELECT relowner FROM pg_class WHERE oid=a.attrelid))
  AND NOT EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) acl WHERE a.attrelid=to_regclass('commonswarm_oauth.admin_cutover_state') AND NOT a.attisdropped AND acl.grantee<>(SELECT relowner FROM pg_class WHERE oid=a.attrelid))
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_oauth_audit') AND attname='workspace_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=false)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_cutover_state') AND attname='legacy_closed_at' AND NOT attisdropped AND atttypid='timestamptz'::regtype AND attnotnull=false)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_cutover_state') AND attname='legacy_fence_evidence_ref' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=false)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_cutover_state') AND attname='measured_edge_target' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=false)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_cutover_state') AND attname='measured_mount' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=false)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_cutover_state') AND attname='measured_at' AND NOT attisdropped AND atttypid='timestamptz'::regtype AND attnotnull=false)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_cutover_state') AND attname='measurement_evidence_ref' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=false)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_cutover_state') AND attname='invalidated_at' AND NOT attisdropped AND atttypid='timestamptz'::regtype AND attnotnull=false)
),false) AS catalog_ok
\gset
