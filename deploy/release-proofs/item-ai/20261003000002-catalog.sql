-- Forward catalog (review input) for 20261003000002. Safe OID lookups fail closed.
SELECT COALESCE((
  EXISTS(SELECT 1 FROM pg_type t WHERE t.oid=to_regtype('commonswarm_oauth.dpop_admission_status')
    AND t.typtype='e' AND pg_get_userbyid(t.typowner)='swarm_admin'
    AND (SELECT array_agg(e.enumlabel::text ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid=t.oid)
      =ARRAY['accepted','nonce_required','stale_proof','replay']::text[]
    AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(t.typacl,acldefault('T',t.typowner))) a
      WHERE a.privilege_type<>'USAGE' OR a.is_grantable OR (a.grantee<>t.typowner AND NOT EXISTS(
        SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname IN ('commonswarm_oauth_runtime','commonswarm_dpop_verifier'))))
    AND (SELECT count(*) FROM aclexplode(coalesce(t.typacl,acldefault('T',t.typowner))) a WHERE a.grantee<>t.typowner)=2)
  AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('commonswarm_oauth.lock_admin_consent_policy(text,integer,uuid)')
    AND pg_get_userbyid(p.proowner)='swarm_admin' AND p.prosecdef AND p.provolatile='v'
    AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND md5(p.prosrc)='a1d8795b8f4e8d9842bbcd4685aa4ef2'
    AND p.prorettype='record'::regtype AND p.proretset
    AND p.proallargtypes=ARRAY['text'::regtype,'integer'::regtype,'uuid'::regtype,'text'::regtype,'integer'::regtype,
      'text'::regtype,'text[]'::regtype,'text[]'::regtype,'boolean'::regtype,'boolean'::regtype,'boolean'::regtype]::oid[]
    AND p.proargmodes=ARRAY['i','i','i','t','t','t','t','t','t','t','t']::"char"[]
    AND p.proargnames=ARRAY['p_client_id','p_verification_version','p_owner_user_id','client_id','verification_version',
      'metadata_digest','redirect_uris','scope_ceiling','full_account_eligible','active','owner_approved']::text[]
    AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      WHERE a.privilege_type<>'EXECUTE' OR a.is_grantable OR (a.grantee<>p.proowner AND NOT EXISTS(
        SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname='commonswarm_oauth_runtime')))
    AND (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)=1)
  AND EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=to_regclass('commonswarm_oauth.admin_verified_clients')
  AND c.relkind='r' AND pg_get_userbyid(c.relowner)='swarm_admin' AND c.relrowsecurity AND NOT c.relforcerowsecurity
  AND (SELECT array_agg(a.attname::text ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped)=ARRAY['client_id','verification_version','application_type','registration_source','publisher_identity','publisher_contact','metadata_digest','redirect_uris','scope_ceiling','full_account_eligible','delegation_eligible','native_loopback_eligible','pkce_s256_tested','dpop_tested','redirect_tested','origin_control_verified','review_evidence_ref','reviewed_by','reviewed_at','active','withdrawn_at','withdrawal_reason']::text[]
  AND (SELECT count(*) FROM pg_constraint WHERE conrelid=c.oid AND contype='p' AND convalidated)=1
  AND NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=c.oid AND NOT convalidated)
  AND NOT EXISTS(SELECT 1 FROM pg_index WHERE indrelid=c.oid AND (NOT indisvalid OR NOT indisready))
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    WHERE a.grantee<>c.relowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY['commonswarm_oauth_runtime','swarm_command','commonswarm_admin_release']::text[]))))
  AND COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_verified_clients'),'SELECT'),false)=true
  AND COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_verified_clients'),'INSERT'),false)=false
  AND COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_verified_clients'),'UPDATE'),false)=false
  AND COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_verified_clients'),'DELETE'),false)=false
  AND COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_verified_clients'),'TRUNCATE'),false)=false
  AND COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_verified_clients'),'REFERENCES'),false)=false
  AND COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_verified_clients'),'TRIGGER'),false)=false
  AND COALESCE(has_table_privilege('swarm_command',to_regclass('commonswarm_oauth.admin_verified_clients'),'SELECT'),false)=true
  AND COALESCE(has_table_privilege('swarm_command',to_regclass('commonswarm_oauth.admin_verified_clients'),'INSERT'),false)=false
  AND COALESCE(has_table_privilege('swarm_command',to_regclass('commonswarm_oauth.admin_verified_clients'),'UPDATE'),false)=false
  AND COALESCE(has_table_privilege('swarm_command',to_regclass('commonswarm_oauth.admin_verified_clients'),'DELETE'),false)=false
  AND COALESCE(has_table_privilege('swarm_command',to_regclass('commonswarm_oauth.admin_verified_clients'),'TRUNCATE'),false)=false
  AND COALESCE(has_table_privilege('swarm_command',to_regclass('commonswarm_oauth.admin_verified_clients'),'REFERENCES'),false)=false
  AND COALESCE(has_table_privilege('swarm_command',to_regclass('commonswarm_oauth.admin_verified_clients'),'TRIGGER'),false)=false
  AND COALESCE(has_table_privilege('commonswarm_admin_release',to_regclass('commonswarm_oauth.admin_verified_clients'),'SELECT'),false)=true
  AND COALESCE(has_table_privilege('commonswarm_admin_release',to_regclass('commonswarm_oauth.admin_verified_clients'),'INSERT'),false)=true
  AND COALESCE(has_table_privilege('commonswarm_admin_release',to_regclass('commonswarm_oauth.admin_verified_clients'),'UPDATE'),false)=true
  AND COALESCE(has_table_privilege('commonswarm_admin_release',to_regclass('commonswarm_oauth.admin_verified_clients'),'DELETE'),false)=false
  AND COALESCE(has_table_privilege('commonswarm_admin_release',to_regclass('commonswarm_oauth.admin_verified_clients'),'TRUNCATE'),false)=false
  AND COALESCE(has_table_privilege('commonswarm_admin_release',to_regclass('commonswarm_oauth.admin_verified_clients'),'REFERENCES'),false)=false
  AND COALESCE(has_table_privilege('commonswarm_admin_release',to_regclass('commonswarm_oauth.admin_verified_clients'),'TRIGGER'),false)=false
  AND (SELECT count(*) FROM pg_constraint WHERE conrelid=to_regclass('commonswarm_oauth.admin_verified_clients') AND contype='c')=19
  AND EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=to_regclass('commonswarm_oauth.admin_client_owner_approvals')
  AND c.relkind='r' AND pg_get_userbyid(c.relowner)='swarm_admin' AND c.relrowsecurity AND NOT c.relforcerowsecurity
  AND (SELECT array_agg(a.attname::text ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped)=ARRAY['owner_user_id','client_id','verification_version','approved_at','approval_event_id','approval_command_id','withdrawn_at','withdrawal_event_id','withdrawal_reason']::text[]
  AND (SELECT count(*) FROM pg_constraint WHERE conrelid=c.oid AND contype='p' AND convalidated)=1
  AND NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=c.oid AND NOT convalidated)
  AND NOT EXISTS(SELECT 1 FROM pg_index WHERE indrelid=c.oid AND (NOT indisvalid OR NOT indisready))
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    WHERE a.grantee<>c.relowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY['commonswarm_oauth_runtime','swarm_command']::text[]))))
  AND COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_client_owner_approvals'),'SELECT'),false)=true
  AND COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_client_owner_approvals'),'INSERT'),false)=false
  AND COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_client_owner_approvals'),'UPDATE'),false)=false
  AND COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_client_owner_approvals'),'DELETE'),false)=false
  AND COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_client_owner_approvals'),'TRUNCATE'),false)=false
  AND COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_client_owner_approvals'),'REFERENCES'),false)=false
  AND COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_client_owner_approvals'),'TRIGGER'),false)=false
  AND COALESCE(has_table_privilege('swarm_command',to_regclass('commonswarm_oauth.admin_client_owner_approvals'),'SELECT'),false)=true
  AND COALESCE(has_table_privilege('swarm_command',to_regclass('commonswarm_oauth.admin_client_owner_approvals'),'INSERT'),false)=true
  AND COALESCE(has_table_privilege('swarm_command',to_regclass('commonswarm_oauth.admin_client_owner_approvals'),'UPDATE'),false)=true
  AND COALESCE(has_table_privilege('swarm_command',to_regclass('commonswarm_oauth.admin_client_owner_approvals'),'DELETE'),false)=false
  AND COALESCE(has_table_privilege('swarm_command',to_regclass('commonswarm_oauth.admin_client_owner_approvals'),'TRUNCATE'),false)=false
  AND COALESCE(has_table_privilege('swarm_command',to_regclass('commonswarm_oauth.admin_client_owner_approvals'),'REFERENCES'),false)=false
  AND COALESCE(has_table_privilege('swarm_command',to_regclass('commonswarm_oauth.admin_client_owner_approvals'),'TRIGGER'),false)=false
  AND (SELECT count(*) FROM pg_constraint WHERE conrelid=to_regclass('commonswarm_oauth.admin_client_owner_approvals') AND contype='c')=3
  AND EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=to_regclass('commonswarm_oauth.dpop_proof_replays')
  AND c.relkind='r' AND pg_get_userbyid(c.relowner)='swarm_admin' AND c.relrowsecurity AND NOT c.relforcerowsecurity
  AND (SELECT array_agg(a.attname::text ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped)=ARRAY['jti','jkt','verifier_domain','accepted_at','expires_at']::text[]
  AND (SELECT count(*) FROM pg_constraint WHERE conrelid=c.oid AND contype='p' AND convalidated)=1
  AND NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=c.oid AND NOT convalidated)
  AND NOT EXISTS(SELECT 1 FROM pg_index WHERE indrelid=c.oid AND (NOT indisvalid OR NOT indisready))
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    WHERE a.grantee<>c.relowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY[]::text[]))))
  AND (SELECT count(*) FROM pg_constraint WHERE conrelid=to_regclass('commonswarm_oauth.dpop_proof_replays') AND contype='c')=4
  AND EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=to_regclass('commonswarm_oauth.dpop_nonces')
  AND c.relkind='r' AND pg_get_userbyid(c.relowner)='swarm_admin' AND c.relrowsecurity AND NOT c.relforcerowsecurity
  AND (SELECT array_agg(a.attname::text ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped)=ARRAY['nonce_digest','jkt','verifier_domain','issued_at','expires_at']::text[]
  AND (SELECT count(*) FROM pg_constraint WHERE conrelid=c.oid AND contype='p' AND convalidated)=1
  AND NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=c.oid AND NOT convalidated)
  AND NOT EXISTS(SELECT 1 FROM pg_index WHERE indrelid=c.oid AND (NOT indisvalid OR NOT indisready))
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    WHERE a.grantee<>c.relowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY[]::text[]))))
  AND (SELECT count(*) FROM pg_constraint WHERE conrelid=to_regclass('commonswarm_oauth.dpop_nonces') AND contype='c')=4
  AND EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=to_regclass('commonswarm_oauth.issuer_key_denials')
  AND c.relkind='r' AND pg_get_userbyid(c.relowner)='swarm_admin' AND c.relrowsecurity AND NOT c.relforcerowsecurity
  AND (SELECT array_agg(a.attname::text ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped)=ARRAY['issuer','kid','denied_at','reason','evidence_ref']::text[]
  AND (SELECT count(*) FROM pg_constraint WHERE conrelid=c.oid AND contype='p' AND convalidated)=1
  AND NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=c.oid AND NOT convalidated)
  AND NOT EXISTS(SELECT 1 FROM pg_index WHERE indrelid=c.oid AND (NOT indisvalid OR NOT indisready))
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    WHERE a.grantee<>c.relowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY['commonswarm_admin_release']::text[]))))
  AND COALESCE(has_table_privilege('commonswarm_admin_release',to_regclass('commonswarm_oauth.issuer_key_denials'),'SELECT'),false)=true
  AND COALESCE(has_table_privilege('commonswarm_admin_release',to_regclass('commonswarm_oauth.issuer_key_denials'),'INSERT'),false)=true
  AND COALESCE(has_table_privilege('commonswarm_admin_release',to_regclass('commonswarm_oauth.issuer_key_denials'),'UPDATE'),false)=false
  AND COALESCE(has_table_privilege('commonswarm_admin_release',to_regclass('commonswarm_oauth.issuer_key_denials'),'DELETE'),false)=false
  AND COALESCE(has_table_privilege('commonswarm_admin_release',to_regclass('commonswarm_oauth.issuer_key_denials'),'TRUNCATE'),false)=false
  AND COALESCE(has_table_privilege('commonswarm_admin_release',to_regclass('commonswarm_oauth.issuer_key_denials'),'REFERENCES'),false)=false
  AND COALESCE(has_table_privilege('commonswarm_admin_release',to_regclass('commonswarm_oauth.issuer_key_denials'),'TRIGGER'),false)=false
  AND (SELECT count(*) FROM pg_constraint WHERE conrelid=to_regclass('commonswarm_oauth.issuer_key_denials') AND contype='c')=4
  AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('commonswarm_oauth.register_dpop_nonce(bytea,text,text)')
  AND pg_get_userbyid(p.proowner)='swarm_admin' AND p.prosecdef=true
  AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND md5(p.prosrc)='8013904dedef9ef3bd16e7ea4a5e9596'
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.grantee<>p.proowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY['commonswarm_oauth_runtime','commonswarm_dpop_verifier']::text[])))
  AND (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)=2)
  AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('commonswarm_oauth.resolve_provider_grant_status(text,uuid,text)')
  AND pg_get_userbyid(p.proowner)='swarm_admin' AND p.prosecdef=true
  AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND md5(p.prosrc)='7b2e34c7cff917342aa43e489c62c0eb'
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.grantee<>p.proowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY['commonswarm_oauth_runtime','swarm_command','swarm_read']::text[])))
  AND (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)=3)
  AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('commonswarm_oauth.admit_dpop_proof(text,text,text,bigint,bytea)')
  AND pg_get_userbyid(p.proowner)='swarm_admin' AND p.prosecdef=true AND p.provolatile='v'
  AND p.prorettype=to_regtype('commonswarm_oauth.dpop_admission_status') AND NOT p.proretset
  AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND md5(p.prosrc)='5e0bdaa4e2ec856e7dea70b14bfc9f19'
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.grantee<>p.proowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY['commonswarm_oauth_runtime','commonswarm_dpop_verifier']::text[])))
  AND (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)=2)
  AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('commonswarm_oauth.purge_expired_dpop(integer)')
  AND pg_get_userbyid(p.proowner)='swarm_admin' AND p.prosecdef=true
  AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND md5(p.prosrc)='f2c213c8075f4647ea541e6719d863cc'
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.grantee<>p.proowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY['commonswarm_oauth_maintenance']::text[])))
  AND (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)=1)
  AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('commonswarm_oauth.issuer_key_allowed(text,text)')
  AND pg_get_userbyid(p.proowner)='swarm_admin' AND p.prosecdef=true
  AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND md5(p.prosrc)='3f306202624ff44bbbab889b36cb7e96'
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.grantee<>p.proowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY['commonswarm_oauth_runtime','swarm_command','swarm_read']::text[])))
  AND (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)=3)
  AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('commonswarm_oauth.lock_issuer_key_denial()')
  AND pg_get_userbyid(p.proowner)='swarm_admin' AND p.prosecdef=false
  AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND md5(p.prosrc)='9b7e8dc63ed3321b8e3a87b5c23542d9'
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.grantee<>p.proowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY[]::text[])))
  AND (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)=0)
  AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('commonswarm_oauth.lock_admin_client_verification(text,integer)')
  AND pg_get_userbyid(p.proowner)='swarm_admin' AND p.prosecdef=true AND p.provolatile='v'
  AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND md5(p.prosrc)='56a5ba61e547917cb5d35eea06b975b4'
  AND p.prorettype='record'::regtype AND p.proretset
  AND p.proallargtypes=ARRAY['text'::regtype,'integer'::regtype,'text'::regtype,'integer'::regtype,
    'boolean'::regtype,'timestamptz'::regtype,'text'::regtype,'text'::regtype,'text[]'::regtype,'text'::regtype]::oid[]
  AND p.proargmodes=ARRAY['i','i','t','t','t','t','t','t','t','t']::"char"[]
  AND p.proargnames=ARRAY['p_client_id','p_verification_version','client_id','verification_version','active',
    'withdrawn_at','metadata_digest','application_type','redirect_uris','redirect_class']::text[]
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.privilege_type<>'EXECUTE' OR a.is_grantable OR (a.grantee<>p.proowner
      AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname='swarm_command')))
  AND (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)=1)
  AND COALESCE(has_function_privilege('swarm_command',to_regprocedure('commonswarm_oauth.lock_admin_client_verification(text,integer)'),'EXECUTE'),false)
  AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname IN
    ('anon','authenticated','swarm_read','commonswarm_oauth_runtime','commonswarm_admin_release',
     'commonswarm_dpop_verifier','commonswarm_oauth_maintenance')
    AND has_function_privilege(r.oid,to_regprocedure('commonswarm_oauth.lock_admin_client_verification(text,integer)'),'EXECUTE'))
  AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('commonswarm_oauth.resolve_admin_grant_status(text,uuid,text)')
  AND pg_get_userbyid(p.proowner)='swarm_admin' AND p.prosecdef=true
  AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND md5(p.prosrc)='49ad465b7b00403f87c711a609a04f67'
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.grantee<>p.proowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY['commonswarm_oauth_runtime','swarm_command','swarm_read']::text[])))
  AND (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)=3)
  AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('commonswarm_oauth.fence_admin_family(text,uuid,text,text)')
  AND pg_get_userbyid(p.proowner)='swarm_admin' AND p.prosecdef=true
  AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND md5(p.prosrc)='1f88dbd9772c8594ecf20607d1e45672'
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.grantee<>p.proowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY['commonswarm_oauth_runtime','swarm_command','commonswarm_admin_release']::text[])))
  AND (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)=3)
  AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('commonswarm_oauth.guard_verified_client()')
  AND pg_get_userbyid(p.proowner)='swarm_admin' AND p.prosecdef=true
  AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND md5(p.prosrc)='b87b8a3ec1db67d2934996e6ef56efc8'
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.grantee<>p.proowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY[]::text[])))
  AND (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)=0)
  AND EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('commonswarm_oauth.guard_owner_approval()')
  AND pg_get_userbyid(p.proowner)='swarm_admin' AND p.prosecdef=false
  AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND md5(p.prosrc)='3ff791ed368a25aac2b5b9911717fd98'
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.grantee<>p.proowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY[]::text[])))
  AND (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)=0)
  AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.issuer_key_denials') AND tgname='issuer_key_denials_append_only' AND tgenabled='O' AND NOT tgisinternal AND tgtype=27 AND tgfoid=to_regprocedure('swarm.prevent_append_only_mutation()'))
  AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.issuer_key_denials') AND tgname='issuer_key_denial_lock' AND tgenabled='O' AND NOT tgisinternal AND tgtype=7 AND tgfoid=to_regprocedure('commonswarm_oauth.lock_issuer_key_denial()'))
  AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.admin_verified_clients') AND tgname='admin_verification_guard' AND tgenabled='O' AND NOT tgisinternal AND tgtype=31 AND tgfoid=to_regprocedure('commonswarm_oauth.guard_verified_client()'))
  AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.admin_client_owner_approvals') AND tgname='admin_owner_approval_guard' AND tgenabled='O' AND NOT tgisinternal AND tgtype=31 AND tgfoid=to_regprocedure('commonswarm_oauth.guard_owner_approval()'))
  AND NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN ('commonswarm_admin_release','commonswarm_dpop_verifier','commonswarm_oauth_maintenance') AND (rolsuper OR rolcanlogin OR rolinherit OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls))
  AND (SELECT count(*) FROM pg_roles WHERE rolname IN ('commonswarm_admin_release','commonswarm_dpop_verifier','commonswarm_oauth_maintenance'))=3
  AND NOT EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles parent ON parent.oid=m.roleid
    WHERE parent.rolname IN ('commonswarm_admin_release','commonswarm_dpop_verifier','commonswarm_oauth_maintenance')
      AND (NOT m.admin_option OR m.inherit_option OR m.set_option))
  AND NOT EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles member ON member.oid=m.member
    WHERE member.rolname IN ('commonswarm_admin_release','commonswarm_dpop_verifier','commonswarm_oauth_maintenance'))
  AND EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conrelid=to_regclass('commonswarm_oauth.dpop_proof_replays') AND c.contype='p' AND (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(num,ord) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.num)=ARRAY['jti','jkt']::text[])
  AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid IN (to_regclass('commonswarm_oauth.dpop_proof_replays'),to_regclass('commonswarm_oauth.dpop_nonces')))
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_verified_clients') AND attname='client_id' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_verified_clients') AND attname='verification_version' AND NOT attisdropped AND atttypid='integer'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_verified_clients') AND attname='application_type' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_verified_clients') AND attname='registration_source' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_verified_clients') AND attname='publisher_identity' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_verified_clients') AND attname='publisher_contact' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_verified_clients') AND attname='metadata_digest' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_verified_clients') AND attname='redirect_uris' AND NOT attisdropped AND atttypid='text[]'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_verified_clients') AND attname='scope_ceiling' AND NOT attisdropped AND atttypid='text[]'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_verified_clients') AND attname='full_account_eligible' AND NOT attisdropped AND atttypid='boolean'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_verified_clients') AND attname='delegation_eligible' AND NOT attisdropped AND atttypid='boolean'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_verified_clients') AND attname='native_loopback_eligible' AND NOT attisdropped AND atttypid='boolean'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_verified_clients') AND attname='pkce_s256_tested' AND NOT attisdropped AND atttypid='boolean'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_verified_clients') AND attname='dpop_tested' AND NOT attisdropped AND atttypid='boolean'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_verified_clients') AND attname='redirect_tested' AND NOT attisdropped AND atttypid='boolean'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_verified_clients') AND attname='origin_control_verified' AND NOT attisdropped AND atttypid='boolean'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_verified_clients') AND attname='review_evidence_ref' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_verified_clients') AND attname='reviewed_by' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_verified_clients') AND attname='reviewed_at' AND NOT attisdropped AND atttypid='timestamptz'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_verified_clients') AND attname='active' AND NOT attisdropped AND atttypid='boolean'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_verified_clients') AND attname='withdrawal_reason' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=false)
  AND NOT EXISTS(SELECT 1 FROM pg_policy p WHERE polrelid=to_regclass('commonswarm_oauth.admin_verified_clients') AND (0=ANY(polroles) OR NOT polpermissive OR (polqual IS NOT NULL AND pg_get_expr(polqual,polrelid)<>'true') OR (polwithcheck IS NOT NULL AND pg_get_expr(polwithcheck,polrelid)<>'true')))
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_client_owner_approvals') AND attname='owner_user_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_client_owner_approvals') AND attname='client_id' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_client_owner_approvals') AND attname='verification_version' AND NOT attisdropped AND atttypid='integer'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_client_owner_approvals') AND attname='approved_at' AND NOT attisdropped AND atttypid='timestamptz'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_client_owner_approvals') AND attname='approval_event_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_client_owner_approvals') AND attname='approval_command_id' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_client_owner_approvals') AND attname='withdrawal_event_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=false)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_client_owner_approvals') AND attname='withdrawal_reason' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=false)
  AND NOT EXISTS(SELECT 1 FROM pg_policy p WHERE polrelid=to_regclass('commonswarm_oauth.admin_client_owner_approvals') AND (0=ANY(polroles) OR NOT polpermissive OR (polqual IS NOT NULL AND pg_get_expr(polqual,polrelid)<>'true') OR (polwithcheck IS NOT NULL AND pg_get_expr(polwithcheck,polrelid)<>'true')))
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.dpop_proof_replays') AND attname='jti' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.dpop_proof_replays') AND attname='jkt' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.dpop_proof_replays') AND attname='verifier_domain' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.dpop_proof_replays') AND attname='accepted_at' AND NOT attisdropped AND atttypid='timestamptz'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.dpop_proof_replays') AND attname='expires_at' AND NOT attisdropped AND atttypid='timestamptz'::regtype AND attnotnull=true)
  AND NOT EXISTS(SELECT 1 FROM pg_policy p WHERE polrelid=to_regclass('commonswarm_oauth.dpop_proof_replays') AND (0=ANY(polroles) OR NOT polpermissive OR (polqual IS NOT NULL AND pg_get_expr(polqual,polrelid)<>'true') OR (polwithcheck IS NOT NULL AND pg_get_expr(polwithcheck,polrelid)<>'true')))
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.dpop_nonces') AND attname='nonce_digest' AND NOT attisdropped AND atttypid='bytea'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.dpop_nonces') AND attname='jkt' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.dpop_nonces') AND attname='verifier_domain' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.dpop_nonces') AND attname='issued_at' AND NOT attisdropped AND atttypid='timestamptz'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.dpop_nonces') AND attname='expires_at' AND NOT attisdropped AND atttypid='timestamptz'::regtype AND attnotnull=true)
  AND NOT EXISTS(SELECT 1 FROM pg_policy p WHERE polrelid=to_regclass('commonswarm_oauth.dpop_nonces') AND (0=ANY(polroles) OR NOT polpermissive OR (polqual IS NOT NULL AND pg_get_expr(polqual,polrelid)<>'true') OR (polwithcheck IS NOT NULL AND pg_get_expr(polwithcheck,polrelid)<>'true')))
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.issuer_key_denials') AND attname='issuer' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.issuer_key_denials') AND attname='kid' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.issuer_key_denials') AND attname='denied_at' AND NOT attisdropped AND atttypid='timestamptz'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.issuer_key_denials') AND attname='reason' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.issuer_key_denials') AND attname='evidence_ref' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  AND NOT EXISTS(SELECT 1 FROM pg_policy p WHERE polrelid=to_regclass('commonswarm_oauth.issuer_key_denials') AND (0=ANY(polroles) OR NOT polpermissive OR (polqual IS NOT NULL AND pg_get_expr(polqual,polrelid)<>'true') OR (polwithcheck IS NOT NULL AND pg_get_expr(polwithcheck,polrelid)<>'true')))
  AND NOT EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) acl WHERE a.attrelid=to_regclass('commonswarm_oauth.admin_verified_clients') AND NOT a.attisdropped AND acl.grantee<>(SELECT relowner FROM pg_class WHERE oid=a.attrelid))
  AND NOT EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) acl WHERE a.attrelid=to_regclass('commonswarm_oauth.admin_client_owner_approvals') AND NOT a.attisdropped AND acl.grantee<>(SELECT relowner FROM pg_class WHERE oid=a.attrelid))
  AND NOT EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) acl WHERE a.attrelid=to_regclass('commonswarm_oauth.dpop_proof_replays') AND NOT a.attisdropped AND acl.grantee<>(SELECT relowner FROM pg_class WHERE oid=a.attrelid))
  AND NOT EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) acl WHERE a.attrelid=to_regclass('commonswarm_oauth.dpop_nonces') AND NOT a.attisdropped AND acl.grantee<>(SELECT relowner FROM pg_class WHERE oid=a.attrelid))
  AND NOT EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) acl WHERE a.attrelid=to_regclass('commonswarm_oauth.issuer_key_denials') AND NOT a.attisdropped AND acl.grantee<>(SELECT relowner FROM pg_class WHERE oid=a.attrelid))
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_verified_clients') AND attname='withdrawn_at' AND NOT attisdropped AND atttypid='timestamptz'::regtype AND attnotnull=false)
  AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_client_owner_approvals') AND attname='withdrawn_at' AND NOT attisdropped AND atttypid='timestamptz'::regtype AND attnotnull=false)
),false) AS catalog_ok
\gset
