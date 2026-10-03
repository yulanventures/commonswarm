-- Forward catalog (review input) for 20261003000002. Safe OID lookups fail closed.
-- Stable labels only: no row values or credential data in diagnostics.
WITH checks(label,ok) AS (VALUES
  ('20261003000002-001-commonswarm_admin_issuer', COALESCE((
    EXISTS(SELECT 1 FROM pg_roles WHERE rolname='commonswarm_admin_issuer' AND rolcanlogin AND NOT rolinherit
    AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls)
  ),false)),
  ('20261003000002-002-issuer-memberships', COALESCE((
    (SELECT array_agg(parent.rolname::text ORDER BY parent.rolname) FROM pg_auth_members m JOIN pg_roles parent ON parent.oid=m.roleid
    WHERE m.member='commonswarm_admin_issuer'::regrole AND NOT m.admin_option AND NOT m.inherit_option AND m.set_option)
    =ARRAY['commonswarm_oauth_runtime','swarm_command']::text[]
  ),false)),
  ('20261003000002-003-issuer-memberships', COALESCE((
    (SELECT count(*) FROM pg_auth_members WHERE member='commonswarm_admin_issuer'::regrole)=2
  ),false)),
  ('20261003000002-004-issuer-direct-privileges-and-ownership', COALESCE((
    NOT EXISTS(SELECT 1 FROM pg_shdepend WHERE refclassid='pg_authid'::regclass
    AND refobjid='commonswarm_admin_issuer'::regrole AND deptype IN ('a','o'))
  ),false)),
  ('20261003000002-005-issuer-memberships', COALESCE((
    NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE roleid='commonswarm_admin_issuer'::regrole
    AND (NOT admin_option OR inherit_option OR set_option))
  ),false)),
  ('20261003000002-006-commonswarm_oauth-dpop_admission_status', COALESCE((
    EXISTS(SELECT 1 FROM pg_type t WHERE t.oid=to_regtype('commonswarm_oauth.dpop_admission_status')
    AND t.typtype='e' AND pg_get_userbyid(t.typowner)='swarm_admin'
    AND (SELECT array_agg(e.enumlabel::text ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid=t.oid)
      =ARRAY['accepted','nonce_required','stale_proof','replay']::text[]
    AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(t.typacl,acldefault('T',t.typowner))) a
      WHERE a.privilege_type<>'USAGE' OR a.is_grantable OR (a.grantee<>t.typowner AND NOT EXISTS(
        SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname IN ('commonswarm_oauth_runtime','commonswarm_dpop_verifier'))))
    AND (SELECT count(*) FROM aclexplode(coalesce(t.typacl,acldefault('T',t.typowner))) a WHERE a.grantee<>t.typowner)=2)
  ),false)),
  ('20261003000002-007-commonswarm_oauth-lock_admin_consent_policy-text-integer-uuid', COALESCE((
    EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('commonswarm_oauth.lock_admin_consent_policy(text,integer,uuid)')
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
  ),false)),
  ('20261003000002-008-commonswarm_oauth-admin_verified_clients', COALESCE((
    EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=to_regclass('commonswarm_oauth.admin_verified_clients')
  AND c.relkind='r' AND pg_get_userbyid(c.relowner)='swarm_admin' AND c.relrowsecurity AND NOT c.relforcerowsecurity
  AND (SELECT array_agg(a.attname::text ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped)=ARRAY['client_id','verification_version','application_type','registration_source','publisher_identity','publisher_contact','metadata_digest','redirect_uris','scope_ceiling','full_account_eligible','delegation_eligible','native_loopback_eligible','pkce_s256_tested','dpop_tested','redirect_tested','origin_control_verified','review_evidence_ref','reviewed_by','reviewed_at','active','withdrawn_at','withdrawal_reason']::text[]
  AND (SELECT count(*) FROM pg_constraint WHERE conrelid=c.oid AND contype='p' AND convalidated)=1
  AND NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=c.oid AND NOT convalidated)
  AND NOT EXISTS(SELECT 1 FROM pg_index WHERE indrelid=c.oid AND (NOT indisvalid OR NOT indisready))
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    WHERE a.grantee<>c.relowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY['commonswarm_oauth_runtime','swarm_command','commonswarm_admin_release']::text[]))))
  ),false)),
  ('20261003000002-009-commonswarm_oauth-admin_verified_clients-SELECT', COALESCE((
    COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_verified_clients'),'SELECT'),false)=true
  ),false)),
  ('20261003000002-010-commonswarm_oauth-admin_verified_clients-INSERT', COALESCE((
    COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_verified_clients'),'INSERT'),false)=false
  ),false)),
  ('20261003000002-011-commonswarm_oauth-admin_verified_clients-UPDATE', COALESCE((
    COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_verified_clients'),'UPDATE'),false)=false
  ),false)),
  ('20261003000002-012-commonswarm_oauth-admin_verified_clients-DELETE', COALESCE((
    COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_verified_clients'),'DELETE'),false)=false
  ),false)),
  ('20261003000002-013-commonswarm_oauth-admin_verified_clients-TRUNCATE', COALESCE((
    COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_verified_clients'),'TRUNCATE'),false)=false
  ),false)),
  ('20261003000002-014-commonswarm_oauth-admin_verified_clients-REFERENCES', COALESCE((
    COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_verified_clients'),'REFERENCES'),false)=false
  ),false)),
  ('20261003000002-015-commonswarm_oauth-admin_verified_clients-TRIGGER', COALESCE((
    COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_verified_clients'),'TRIGGER'),false)=false
  ),false)),
  ('20261003000002-016-commonswarm_oauth-admin_verified_clients-SELECT', COALESCE((
    COALESCE(has_table_privilege('swarm_command',to_regclass('commonswarm_oauth.admin_verified_clients'),'SELECT'),false)=true
  ),false)),
  ('20261003000002-017-commonswarm_oauth-admin_verified_clients-INSERT', COALESCE((
    COALESCE(has_table_privilege('swarm_command',to_regclass('commonswarm_oauth.admin_verified_clients'),'INSERT'),false)=false
  ),false)),
  ('20261003000002-018-commonswarm_oauth-admin_verified_clients-UPDATE', COALESCE((
    COALESCE(has_table_privilege('swarm_command',to_regclass('commonswarm_oauth.admin_verified_clients'),'UPDATE'),false)=false
  ),false)),
  ('20261003000002-019-commonswarm_oauth-admin_verified_clients-DELETE', COALESCE((
    COALESCE(has_table_privilege('swarm_command',to_regclass('commonswarm_oauth.admin_verified_clients'),'DELETE'),false)=false
  ),false)),
  ('20261003000002-020-commonswarm_oauth-admin_verified_clients-TRUNCATE', COALESCE((
    COALESCE(has_table_privilege('swarm_command',to_regclass('commonswarm_oauth.admin_verified_clients'),'TRUNCATE'),false)=false
  ),false)),
  ('20261003000002-021-commonswarm_oauth-admin_verified_clients-REFERENCES', COALESCE((
    COALESCE(has_table_privilege('swarm_command',to_regclass('commonswarm_oauth.admin_verified_clients'),'REFERENCES'),false)=false
  ),false)),
  ('20261003000002-022-commonswarm_oauth-admin_verified_clients-TRIGGER', COALESCE((
    COALESCE(has_table_privilege('swarm_command',to_regclass('commonswarm_oauth.admin_verified_clients'),'TRIGGER'),false)=false
  ),false)),
  ('20261003000002-023-commonswarm_oauth-admin_verified_clients-SELECT', COALESCE((
    COALESCE(has_table_privilege('commonswarm_admin_release',to_regclass('commonswarm_oauth.admin_verified_clients'),'SELECT'),false)=true
  ),false)),
  ('20261003000002-024-commonswarm_oauth-admin_verified_clients-INSERT', COALESCE((
    COALESCE(has_table_privilege('commonswarm_admin_release',to_regclass('commonswarm_oauth.admin_verified_clients'),'INSERT'),false)=true
  ),false)),
  ('20261003000002-025-commonswarm_oauth-admin_verified_clients-UPDATE', COALESCE((
    COALESCE(has_table_privilege('commonswarm_admin_release',to_regclass('commonswarm_oauth.admin_verified_clients'),'UPDATE'),false)=true
  ),false)),
  ('20261003000002-026-commonswarm_oauth-admin_verified_clients-DELETE', COALESCE((
    COALESCE(has_table_privilege('commonswarm_admin_release',to_regclass('commonswarm_oauth.admin_verified_clients'),'DELETE'),false)=false
  ),false)),
  ('20261003000002-027-commonswarm_oauth-admin_verified_clients-TRUNCATE', COALESCE((
    COALESCE(has_table_privilege('commonswarm_admin_release',to_regclass('commonswarm_oauth.admin_verified_clients'),'TRUNCATE'),false)=false
  ),false)),
  ('20261003000002-028-commonswarm_oauth-admin_verified_clients-REFERENCES', COALESCE((
    COALESCE(has_table_privilege('commonswarm_admin_release',to_regclass('commonswarm_oauth.admin_verified_clients'),'REFERENCES'),false)=false
  ),false)),
  ('20261003000002-029-commonswarm_oauth-admin_verified_clients-TRIGGER', COALESCE((
    COALESCE(has_table_privilege('commonswarm_admin_release',to_regclass('commonswarm_oauth.admin_verified_clients'),'TRIGGER'),false)=false
  ),false)),
  ('20261003000002-030-commonswarm_oauth-admin_verified_clients', COALESCE((
    (SELECT count(*) FROM pg_constraint WHERE conrelid=to_regclass('commonswarm_oauth.admin_verified_clients') AND contype='c')=19
  ),false)),
  ('20261003000002-031-commonswarm_oauth-admin_client_owner_approvals', COALESCE((
    EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=to_regclass('commonswarm_oauth.admin_client_owner_approvals')
  AND c.relkind='r' AND pg_get_userbyid(c.relowner)='swarm_admin' AND c.relrowsecurity AND NOT c.relforcerowsecurity
  AND (SELECT array_agg(a.attname::text ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped)=ARRAY['owner_user_id','client_id','verification_version','approved_at','approval_event_id','approval_command_id','withdrawn_at','withdrawal_event_id','withdrawal_reason']::text[]
  AND (SELECT count(*) FROM pg_constraint WHERE conrelid=c.oid AND contype='p' AND convalidated)=1
  AND NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=c.oid AND NOT convalidated)
  AND NOT EXISTS(SELECT 1 FROM pg_index WHERE indrelid=c.oid AND (NOT indisvalid OR NOT indisready))
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    WHERE a.grantee<>c.relowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY['commonswarm_oauth_runtime','swarm_command']::text[]))))
  ),false)),
  ('20261003000002-032-commonswarm_oauth-admin_client_owner_approvals-SELECT', COALESCE((
    COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_client_owner_approvals'),'SELECT'),false)=true
  ),false)),
  ('20261003000002-033-commonswarm_oauth-admin_client_owner_approvals-INSERT', COALESCE((
    COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_client_owner_approvals'),'INSERT'),false)=false
  ),false)),
  ('20261003000002-034-commonswarm_oauth-admin_client_owner_approvals-UPDATE', COALESCE((
    COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_client_owner_approvals'),'UPDATE'),false)=false
  ),false)),
  ('20261003000002-035-commonswarm_oauth-admin_client_owner_approvals-DELETE', COALESCE((
    COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_client_owner_approvals'),'DELETE'),false)=false
  ),false)),
  ('20261003000002-036-commonswarm_oauth-admin_client_owner_approvals-TRUNCATE', COALESCE((
    COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_client_owner_approvals'),'TRUNCATE'),false)=false
  ),false)),
  ('20261003000002-037-commonswarm_oauth-admin_client_owner_approvals-REFERENCES', COALESCE((
    COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_client_owner_approvals'),'REFERENCES'),false)=false
  ),false)),
  ('20261003000002-038-commonswarm_oauth-admin_client_owner_approvals-TRIGGER', COALESCE((
    COALESCE(has_table_privilege('commonswarm_oauth_runtime',to_regclass('commonswarm_oauth.admin_client_owner_approvals'),'TRIGGER'),false)=false
  ),false)),
  ('20261003000002-039-commonswarm_oauth-admin_client_owner_approvals-SELECT', COALESCE((
    COALESCE(has_table_privilege('swarm_command',to_regclass('commonswarm_oauth.admin_client_owner_approvals'),'SELECT'),false)=true
  ),false)),
  ('20261003000002-040-commonswarm_oauth-admin_client_owner_approvals-INSERT', COALESCE((
    COALESCE(has_table_privilege('swarm_command',to_regclass('commonswarm_oauth.admin_client_owner_approvals'),'INSERT'),false)=true
  ),false)),
  ('20261003000002-041-commonswarm_oauth-admin_client_owner_approvals-UPDATE', COALESCE((
    COALESCE(has_table_privilege('swarm_command',to_regclass('commonswarm_oauth.admin_client_owner_approvals'),'UPDATE'),false)=true
  ),false)),
  ('20261003000002-042-commonswarm_oauth-admin_client_owner_approvals-DELETE', COALESCE((
    COALESCE(has_table_privilege('swarm_command',to_regclass('commonswarm_oauth.admin_client_owner_approvals'),'DELETE'),false)=false
  ),false)),
  ('20261003000002-043-commonswarm_oauth-admin_client_owner_approvals-TRUNCATE', COALESCE((
    COALESCE(has_table_privilege('swarm_command',to_regclass('commonswarm_oauth.admin_client_owner_approvals'),'TRUNCATE'),false)=false
  ),false)),
  ('20261003000002-044-commonswarm_oauth-admin_client_owner_approvals-REFERENCES', COALESCE((
    COALESCE(has_table_privilege('swarm_command',to_regclass('commonswarm_oauth.admin_client_owner_approvals'),'REFERENCES'),false)=false
  ),false)),
  ('20261003000002-045-commonswarm_oauth-admin_client_owner_approvals-TRIGGER', COALESCE((
    COALESCE(has_table_privilege('swarm_command',to_regclass('commonswarm_oauth.admin_client_owner_approvals'),'TRIGGER'),false)=false
  ),false)),
  ('20261003000002-046-commonswarm_oauth-admin_client_owner_approvals', COALESCE((
    (SELECT count(*) FROM pg_constraint WHERE conrelid=to_regclass('commonswarm_oauth.admin_client_owner_approvals') AND contype='c')=3
  ),false)),
  ('20261003000002-047-commonswarm_oauth-dpop_proof_replays', COALESCE((
    EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=to_regclass('commonswarm_oauth.dpop_proof_replays')
  AND c.relkind='r' AND pg_get_userbyid(c.relowner)='swarm_admin' AND c.relrowsecurity AND NOT c.relforcerowsecurity
  AND (SELECT array_agg(a.attname::text ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped)=ARRAY['jti','jkt','verifier_domain','accepted_at','expires_at']::text[]
  AND (SELECT count(*) FROM pg_constraint WHERE conrelid=c.oid AND contype='p' AND convalidated)=1
  AND NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=c.oid AND NOT convalidated)
  AND NOT EXISTS(SELECT 1 FROM pg_index WHERE indrelid=c.oid AND (NOT indisvalid OR NOT indisready))
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    WHERE a.grantee<>c.relowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY[]::text[]))))
  ),false)),
  ('20261003000002-048-commonswarm_oauth-dpop_proof_replays', COALESCE((
    (SELECT count(*) FROM pg_constraint WHERE conrelid=to_regclass('commonswarm_oauth.dpop_proof_replays') AND contype='c')=4
  ),false)),
  ('20261003000002-049-commonswarm_oauth-dpop_nonces', COALESCE((
    EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=to_regclass('commonswarm_oauth.dpop_nonces')
  AND c.relkind='r' AND pg_get_userbyid(c.relowner)='swarm_admin' AND c.relrowsecurity AND NOT c.relforcerowsecurity
  AND (SELECT array_agg(a.attname::text ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped)=ARRAY['nonce_digest','jkt','verifier_domain','issued_at','expires_at']::text[]
  AND (SELECT count(*) FROM pg_constraint WHERE conrelid=c.oid AND contype='p' AND convalidated)=1
  AND NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=c.oid AND NOT convalidated)
  AND NOT EXISTS(SELECT 1 FROM pg_index WHERE indrelid=c.oid AND (NOT indisvalid OR NOT indisready))
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    WHERE a.grantee<>c.relowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY[]::text[]))))
  ),false)),
  ('20261003000002-050-commonswarm_oauth-dpop_nonces', COALESCE((
    (SELECT count(*) FROM pg_constraint WHERE conrelid=to_regclass('commonswarm_oauth.dpop_nonces') AND contype='c')=4
  ),false)),
  ('20261003000002-051-commonswarm_oauth-issuer_key_denials', COALESCE((
    EXISTS(SELECT 1 FROM pg_class c WHERE c.oid=to_regclass('commonswarm_oauth.issuer_key_denials')
  AND c.relkind='r' AND pg_get_userbyid(c.relowner)='swarm_admin' AND c.relrowsecurity AND NOT c.relforcerowsecurity
  AND (SELECT array_agg(a.attname::text ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped)=ARRAY['issuer','kid','denied_at','reason','evidence_ref']::text[]
  AND (SELECT count(*) FROM pg_constraint WHERE conrelid=c.oid AND contype='p' AND convalidated)=1
  AND NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=c.oid AND NOT convalidated)
  AND NOT EXISTS(SELECT 1 FROM pg_index WHERE indrelid=c.oid AND (NOT indisvalid OR NOT indisready))
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    WHERE a.grantee<>c.relowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY['commonswarm_admin_release']::text[]))))
  ),false)),
  ('20261003000002-052-commonswarm_oauth-issuer_key_denials-SELECT', COALESCE((
    COALESCE(has_table_privilege('commonswarm_admin_release',to_regclass('commonswarm_oauth.issuer_key_denials'),'SELECT'),false)=true
  ),false)),
  ('20261003000002-053-commonswarm_oauth-issuer_key_denials-INSERT', COALESCE((
    COALESCE(has_table_privilege('commonswarm_admin_release',to_regclass('commonswarm_oauth.issuer_key_denials'),'INSERT'),false)=true
  ),false)),
  ('20261003000002-054-commonswarm_oauth-issuer_key_denials-UPDATE', COALESCE((
    COALESCE(has_table_privilege('commonswarm_admin_release',to_regclass('commonswarm_oauth.issuer_key_denials'),'UPDATE'),false)=false
  ),false)),
  ('20261003000002-055-commonswarm_oauth-issuer_key_denials-DELETE', COALESCE((
    COALESCE(has_table_privilege('commonswarm_admin_release',to_regclass('commonswarm_oauth.issuer_key_denials'),'DELETE'),false)=false
  ),false)),
  ('20261003000002-056-commonswarm_oauth-issuer_key_denials-TRUNCATE', COALESCE((
    COALESCE(has_table_privilege('commonswarm_admin_release',to_regclass('commonswarm_oauth.issuer_key_denials'),'TRUNCATE'),false)=false
  ),false)),
  ('20261003000002-057-commonswarm_oauth-issuer_key_denials-REFERENCES', COALESCE((
    COALESCE(has_table_privilege('commonswarm_admin_release',to_regclass('commonswarm_oauth.issuer_key_denials'),'REFERENCES'),false)=false
  ),false)),
  ('20261003000002-058-commonswarm_oauth-issuer_key_denials-TRIGGER', COALESCE((
    COALESCE(has_table_privilege('commonswarm_admin_release',to_regclass('commonswarm_oauth.issuer_key_denials'),'TRIGGER'),false)=false
  ),false)),
  ('20261003000002-059-commonswarm_oauth-issuer_key_denials', COALESCE((
    (SELECT count(*) FROM pg_constraint WHERE conrelid=to_regclass('commonswarm_oauth.issuer_key_denials') AND contype='c')=4
  ),false)),
  ('20261003000002-060-commonswarm_oauth-register_dpop_nonce-bytea-text-text', COALESCE((
    EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('commonswarm_oauth.register_dpop_nonce(bytea,text,text)')
  AND pg_get_userbyid(p.proowner)='swarm_admin' AND p.prosecdef=true
  AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND md5(p.prosrc)='8013904dedef9ef3bd16e7ea4a5e9596'
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.grantee<>p.proowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY['commonswarm_oauth_runtime','commonswarm_dpop_verifier']::text[])))
  AND (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)=2)
  ),false)),
  ('20261003000002-061-commonswarm_oauth-resolve_provider_grant_status-text-uuid-text', COALESCE((
    EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('commonswarm_oauth.resolve_provider_grant_status(text,uuid,text)')
  AND pg_get_userbyid(p.proowner)='swarm_admin' AND p.prosecdef=true
  AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND md5(p.prosrc)='7b2e34c7cff917342aa43e489c62c0eb'
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.grantee<>p.proowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY['commonswarm_oauth_runtime','swarm_command','swarm_read']::text[])))
  AND (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)=3)
  ),false)),
  ('20261003000002-062-commonswarm_oauth-admit_dpop_proof-text-text-text-bigint-bytea', COALESCE((
    EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('commonswarm_oauth.admit_dpop_proof(text,text,text,bigint,bytea)')
  AND pg_get_userbyid(p.proowner)='swarm_admin' AND p.prosecdef=true AND p.provolatile='v'
  AND p.prorettype=to_regtype('commonswarm_oauth.dpop_admission_status') AND NOT p.proretset
  AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND md5(p.prosrc)='5e0bdaa4e2ec856e7dea70b14bfc9f19'
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.grantee<>p.proowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY['commonswarm_oauth_runtime','commonswarm_dpop_verifier']::text[])))
  AND (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)=2)
  ),false)),
  ('20261003000002-063-commonswarm_oauth-purge_expired_dpop-integer', COALESCE((
    EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('commonswarm_oauth.purge_expired_dpop(integer)')
  AND pg_get_userbyid(p.proowner)='swarm_admin' AND p.prosecdef=true
  AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND md5(p.prosrc)='f2c213c8075f4647ea541e6719d863cc'
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.grantee<>p.proowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY['commonswarm_oauth_maintenance']::text[])))
  AND (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)=1)
  ),false)),
  ('20261003000002-064-commonswarm_oauth-issuer_key_allowed-text-text', COALESCE((
    EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('commonswarm_oauth.issuer_key_allowed(text,text)')
  AND pg_get_userbyid(p.proowner)='swarm_admin' AND p.prosecdef=true
  AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND md5(p.prosrc)='3f306202624ff44bbbab889b36cb7e96'
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.grantee<>p.proowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY['commonswarm_oauth_runtime','swarm_command','swarm_read']::text[])))
  AND (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)=3)
  ),false)),
  ('20261003000002-065-commonswarm_oauth-lock_issuer_key_denial', COALESCE((
    EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('commonswarm_oauth.lock_issuer_key_denial()')
  AND pg_get_userbyid(p.proowner)='swarm_admin' AND p.prosecdef=false
  AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND md5(p.prosrc)='9b7e8dc63ed3321b8e3a87b5c23542d9'
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.grantee<>p.proowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY[]::text[])))
  AND (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)=0)
  ),false)),
  ('20261003000002-066-commonswarm_oauth-lock_admin_client_verification-text-integer', COALESCE((
    EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('commonswarm_oauth.lock_admin_client_verification(text,integer)')
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
  ),false)),
  ('20261003000002-067-commonswarm_oauth-lock_admin_client_verification-text-integer', COALESCE((
    COALESCE(has_function_privilege('swarm_command',to_regprocedure('commonswarm_oauth.lock_admin_client_verification(text,integer)'),'EXECUTE'),false)
  ),false)),
  ('20261003000002-068-commonswarm_oauth-lock_admin_client_verification-text-integer', COALESCE((
    NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname IN
    ('anon','authenticated','swarm_read','commonswarm_oauth_runtime','commonswarm_admin_release',
     'commonswarm_dpop_verifier','commonswarm_oauth_maintenance')
    AND has_function_privilege(r.oid,to_regprocedure('commonswarm_oauth.lock_admin_client_verification(text,integer)'),'EXECUTE'))
  ),false)),
  ('20261003000002-069-commonswarm_oauth-resolve_admin_grant_status-text-uuid-text', COALESCE((
    EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('commonswarm_oauth.resolve_admin_grant_status(text,uuid,text)')
  AND pg_get_userbyid(p.proowner)='swarm_admin' AND p.prosecdef=true
  AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND md5(p.prosrc)='49ad465b7b00403f87c711a609a04f67'
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.grantee<>p.proowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY['commonswarm_oauth_runtime','swarm_command','swarm_read']::text[])))
  AND (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)=3)
  ),false)),
  ('20261003000002-070-commonswarm_oauth-fence_admin_family-text-uuid-text-text', COALESCE((
    EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('commonswarm_oauth.fence_admin_family(text,uuid,text,text)')
  AND pg_get_userbyid(p.proowner)='swarm_admin' AND p.prosecdef=true
  AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND md5(p.prosrc)='1f88dbd9772c8594ecf20607d1e45672'
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.grantee<>p.proowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY['commonswarm_oauth_runtime','swarm_command','commonswarm_admin_release']::text[])))
  AND (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)=3)
  ),false)),
  ('20261003000002-071-commonswarm_oauth-guard_verified_client', COALESCE((
    EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('commonswarm_oauth.guard_verified_client()')
  AND pg_get_userbyid(p.proowner)='swarm_admin' AND p.prosecdef=true
  AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND md5(p.prosrc)='b87b8a3ec1db67d2934996e6ef56efc8'
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.grantee<>p.proowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY[]::text[])))
  AND (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)=0)
  ),false)),
  ('20261003000002-072-commonswarm_oauth-guard_owner_approval', COALESCE((
    EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('commonswarm_oauth.guard_owner_approval()')
  AND pg_get_userbyid(p.proowner)='swarm_admin' AND p.prosecdef=false
  AND p.proconfig=ARRAY['search_path=pg_catalog']::text[] AND md5(p.prosrc)='3ff791ed368a25aac2b5b9911717fd98'
  AND NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.grantee<>p.proowner AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.oid=a.grantee AND r.rolname=ANY(ARRAY[]::text[])))
  AND (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)=0)
  ),false)),
  ('20261003000002-073-commonswarm_oauth-issuer_key_denials', COALESCE((
    EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.issuer_key_denials') AND tgname='issuer_key_denials_append_only' AND tgenabled='O' AND NOT tgisinternal AND tgtype=27 AND tgfoid=to_regprocedure('swarm.prevent_append_only_mutation()'))
  ),false)),
  ('20261003000002-074-commonswarm_oauth-issuer_key_denials', COALESCE((
    EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.issuer_key_denials') AND tgname='issuer_key_denial_lock' AND tgenabled='O' AND NOT tgisinternal AND tgtype=7 AND tgfoid=to_regprocedure('commonswarm_oauth.lock_issuer_key_denial()'))
  ),false)),
  ('20261003000002-075-commonswarm_oauth-admin_verified_clients', COALESCE((
    EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.admin_verified_clients') AND tgname='admin_verification_guard' AND tgenabled='O' AND NOT tgisinternal AND tgtype=31 AND tgfoid=to_regprocedure('commonswarm_oauth.guard_verified_client()'))
  ),false)),
  ('20261003000002-076-commonswarm_oauth-admin_client_owner_approvals', COALESCE((
    EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('commonswarm_oauth.admin_client_owner_approvals') AND tgname='admin_owner_approval_guard' AND tgenabled='O' AND NOT tgisinternal AND tgtype=31 AND tgfoid=to_regprocedure('commonswarm_oauth.guard_owner_approval()'))
  ),false)),
  ('20261003000002-077-catalog', COALESCE((
    NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN ('commonswarm_admin_release','commonswarm_dpop_verifier','commonswarm_oauth_maintenance') AND (rolsuper OR rolcanlogin OR rolinherit OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls))
  ),false)),
  ('20261003000002-078-catalog', COALESCE((
    (SELECT count(*) FROM pg_roles WHERE rolname IN ('commonswarm_admin_release','commonswarm_dpop_verifier','commonswarm_oauth_maintenance'))=3
  ),false)),
  ('20261003000002-079-policy-role-memberships', COALESCE((
    NOT EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles parent ON parent.oid=m.roleid
    WHERE parent.rolname IN ('commonswarm_admin_release','commonswarm_dpop_verifier','commonswarm_oauth_maintenance')
      AND (NOT m.admin_option OR m.inherit_option OR m.set_option))
  ),false)),
  ('20261003000002-080-policy-role-memberships', COALESCE((
    NOT EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles member ON member.oid=m.member
    WHERE member.rolname IN ('commonswarm_admin_release','commonswarm_dpop_verifier','commonswarm_oauth_maintenance'))
  ),false)),
  ('20261003000002-081-commonswarm_oauth-dpop_proof_replays', COALESCE((
    EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conrelid=to_regclass('commonswarm_oauth.dpop_proof_replays') AND c.contype='p' AND (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(num,ord) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.num)=ARRAY['jti','jkt']::text[])
  ),false)),
  ('20261003000002-082-commonswarm_oauth-dpop_proof_replays', COALESCE((
    NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid IN (to_regclass('commonswarm_oauth.dpop_proof_replays'),to_regclass('commonswarm_oauth.dpop_nonces')))
  ),false)),
  ('20261003000002-083-commonswarm_oauth-admin_verified_clients-client_id', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_verified_clients') AND attname='client_id' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000002-084-commonswarm_oauth-admin_verified_clients-verification_version', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_verified_clients') AND attname='verification_version' AND NOT attisdropped AND atttypid='integer'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000002-085-commonswarm_oauth-admin_verified_clients-application_type', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_verified_clients') AND attname='application_type' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000002-086-commonswarm_oauth-admin_verified_clients-registration_source', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_verified_clients') AND attname='registration_source' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000002-087-commonswarm_oauth-admin_verified_clients-publisher_identity', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_verified_clients') AND attname='publisher_identity' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000002-088-commonswarm_oauth-admin_verified_clients-publisher_contact', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_verified_clients') AND attname='publisher_contact' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000002-089-commonswarm_oauth-admin_verified_clients-metadata_digest', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_verified_clients') AND attname='metadata_digest' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000002-090-commonswarm_oauth-admin_verified_clients-redirect_uris', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_verified_clients') AND attname='redirect_uris' AND NOT attisdropped AND atttypid='text[]'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000002-091-commonswarm_oauth-admin_verified_clients-scope_ceiling', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_verified_clients') AND attname='scope_ceiling' AND NOT attisdropped AND atttypid='text[]'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000002-092-commonswarm_oauth-admin_verified_clients-full_account_eligible', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_verified_clients') AND attname='full_account_eligible' AND NOT attisdropped AND atttypid='boolean'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000002-093-commonswarm_oauth-admin_verified_clients-delegation_eligible', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_verified_clients') AND attname='delegation_eligible' AND NOT attisdropped AND atttypid='boolean'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000002-094-commonswarm_oauth-admin_verified_clients-native_loopback_eligible', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_verified_clients') AND attname='native_loopback_eligible' AND NOT attisdropped AND atttypid='boolean'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000002-095-commonswarm_oauth-admin_verified_clients-pkce_s256_tested', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_verified_clients') AND attname='pkce_s256_tested' AND NOT attisdropped AND atttypid='boolean'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000002-096-commonswarm_oauth-admin_verified_clients-dpop_tested', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_verified_clients') AND attname='dpop_tested' AND NOT attisdropped AND atttypid='boolean'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000002-097-commonswarm_oauth-admin_verified_clients-redirect_tested', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_verified_clients') AND attname='redirect_tested' AND NOT attisdropped AND atttypid='boolean'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000002-098-commonswarm_oauth-admin_verified_clients-origin_control_verified', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_verified_clients') AND attname='origin_control_verified' AND NOT attisdropped AND atttypid='boolean'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000002-099-commonswarm_oauth-admin_verified_clients-review_evidence_ref', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_verified_clients') AND attname='review_evidence_ref' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000002-100-commonswarm_oauth-admin_verified_clients-reviewed_by', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_verified_clients') AND attname='reviewed_by' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000002-101-commonswarm_oauth-admin_verified_clients-reviewed_at', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_verified_clients') AND attname='reviewed_at' AND NOT attisdropped AND atttypid='timestamptz'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000002-102-commonswarm_oauth-admin_verified_clients-active', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_verified_clients') AND attname='active' AND NOT attisdropped AND atttypid='boolean'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000002-103-commonswarm_oauth-admin_verified_clients-withdrawal_reason', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_verified_clients') AND attname='withdrawal_reason' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=false)
  ),false)),
  ('20261003000002-104-commonswarm_oauth-admin_verified_clients', COALESCE((
    NOT EXISTS(SELECT 1 FROM pg_policy p WHERE polrelid=to_regclass('commonswarm_oauth.admin_verified_clients') AND (0=ANY(polroles) OR NOT polpermissive OR (polqual IS NOT NULL AND pg_get_expr(polqual,polrelid)<>'true') OR (polwithcheck IS NOT NULL AND pg_get_expr(polwithcheck,polrelid)<>'true')))
  ),false)),
  ('20261003000002-105-commonswarm_oauth-admin_client_owner_approvals-owner_user_id', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_client_owner_approvals') AND attname='owner_user_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000002-106-commonswarm_oauth-admin_client_owner_approvals-client_id', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_client_owner_approvals') AND attname='client_id' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000002-107-commonswarm_oauth-admin_client_owner_approvals-verification_version', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_client_owner_approvals') AND attname='verification_version' AND NOT attisdropped AND atttypid='integer'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000002-108-commonswarm_oauth-admin_client_owner_approvals-approved_at', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_client_owner_approvals') AND attname='approved_at' AND NOT attisdropped AND atttypid='timestamptz'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000002-109-commonswarm_oauth-admin_client_owner_approvals-approval_event_id', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_client_owner_approvals') AND attname='approval_event_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000002-110-commonswarm_oauth-admin_client_owner_approvals-approval_command_id', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_client_owner_approvals') AND attname='approval_command_id' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000002-111-commonswarm_oauth-admin_client_owner_approvals-withdrawal_event_id', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_client_owner_approvals') AND attname='withdrawal_event_id' AND NOT attisdropped AND atttypid='uuid'::regtype AND attnotnull=false)
  ),false)),
  ('20261003000002-112-commonswarm_oauth-admin_client_owner_approvals-withdrawal_reason', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_client_owner_approvals') AND attname='withdrawal_reason' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=false)
  ),false)),
  ('20261003000002-113-commonswarm_oauth-admin_client_owner_approvals', COALESCE((
    NOT EXISTS(SELECT 1 FROM pg_policy p WHERE polrelid=to_regclass('commonswarm_oauth.admin_client_owner_approvals') AND (0=ANY(polroles) OR NOT polpermissive OR (polqual IS NOT NULL AND pg_get_expr(polqual,polrelid)<>'true') OR (polwithcheck IS NOT NULL AND pg_get_expr(polwithcheck,polrelid)<>'true')))
  ),false)),
  ('20261003000002-114-commonswarm_oauth-dpop_proof_replays-jti', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.dpop_proof_replays') AND attname='jti' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000002-115-commonswarm_oauth-dpop_proof_replays-jkt', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.dpop_proof_replays') AND attname='jkt' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000002-116-commonswarm_oauth-dpop_proof_replays-verifier_domain', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.dpop_proof_replays') AND attname='verifier_domain' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000002-117-commonswarm_oauth-dpop_proof_replays-accepted_at', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.dpop_proof_replays') AND attname='accepted_at' AND NOT attisdropped AND atttypid='timestamptz'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000002-118-commonswarm_oauth-dpop_proof_replays-expires_at', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.dpop_proof_replays') AND attname='expires_at' AND NOT attisdropped AND atttypid='timestamptz'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000002-119-commonswarm_oauth-dpop_proof_replays', COALESCE((
    NOT EXISTS(SELECT 1 FROM pg_policy p WHERE polrelid=to_regclass('commonswarm_oauth.dpop_proof_replays') AND (0=ANY(polroles) OR NOT polpermissive OR (polqual IS NOT NULL AND pg_get_expr(polqual,polrelid)<>'true') OR (polwithcheck IS NOT NULL AND pg_get_expr(polwithcheck,polrelid)<>'true')))
  ),false)),
  ('20261003000002-120-commonswarm_oauth-dpop_nonces-nonce_digest', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.dpop_nonces') AND attname='nonce_digest' AND NOT attisdropped AND atttypid='bytea'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000002-121-commonswarm_oauth-dpop_nonces-jkt', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.dpop_nonces') AND attname='jkt' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000002-122-commonswarm_oauth-dpop_nonces-verifier_domain', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.dpop_nonces') AND attname='verifier_domain' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000002-123-commonswarm_oauth-dpop_nonces-issued_at', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.dpop_nonces') AND attname='issued_at' AND NOT attisdropped AND atttypid='timestamptz'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000002-124-commonswarm_oauth-dpop_nonces-expires_at', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.dpop_nonces') AND attname='expires_at' AND NOT attisdropped AND atttypid='timestamptz'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000002-125-commonswarm_oauth-dpop_nonces', COALESCE((
    NOT EXISTS(SELECT 1 FROM pg_policy p WHERE polrelid=to_regclass('commonswarm_oauth.dpop_nonces') AND (0=ANY(polroles) OR NOT polpermissive OR (polqual IS NOT NULL AND pg_get_expr(polqual,polrelid)<>'true') OR (polwithcheck IS NOT NULL AND pg_get_expr(polwithcheck,polrelid)<>'true')))
  ),false)),
  ('20261003000002-126-commonswarm_oauth-issuer_key_denials-issuer', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.issuer_key_denials') AND attname='issuer' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000002-127-commonswarm_oauth-issuer_key_denials-kid', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.issuer_key_denials') AND attname='kid' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000002-128-commonswarm_oauth-issuer_key_denials-denied_at', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.issuer_key_denials') AND attname='denied_at' AND NOT attisdropped AND atttypid='timestamptz'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000002-129-commonswarm_oauth-issuer_key_denials-reason', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.issuer_key_denials') AND attname='reason' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000002-130-commonswarm_oauth-issuer_key_denials-evidence_ref', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.issuer_key_denials') AND attname='evidence_ref' AND NOT attisdropped AND atttypid='text'::regtype AND attnotnull=true)
  ),false)),
  ('20261003000002-131-commonswarm_oauth-issuer_key_denials', COALESCE((
    NOT EXISTS(SELECT 1 FROM pg_policy p WHERE polrelid=to_regclass('commonswarm_oauth.issuer_key_denials') AND (0=ANY(polroles) OR NOT polpermissive OR (polqual IS NOT NULL AND pg_get_expr(polqual,polrelid)<>'true') OR (polwithcheck IS NOT NULL AND pg_get_expr(polwithcheck,polrelid)<>'true')))
  ),false)),
  ('20261003000002-132-commonswarm_oauth-admin_verified_clients', COALESCE((
    NOT EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) acl WHERE a.attrelid=to_regclass('commonswarm_oauth.admin_verified_clients') AND NOT a.attisdropped AND acl.grantee<>(SELECT relowner FROM pg_class WHERE oid=a.attrelid))
  ),false)),
  ('20261003000002-133-commonswarm_oauth-admin_client_owner_approvals', COALESCE((
    NOT EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) acl WHERE a.attrelid=to_regclass('commonswarm_oauth.admin_client_owner_approvals') AND NOT a.attisdropped AND acl.grantee<>(SELECT relowner FROM pg_class WHERE oid=a.attrelid))
  ),false)),
  ('20261003000002-134-commonswarm_oauth-dpop_proof_replays', COALESCE((
    NOT EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) acl WHERE a.attrelid=to_regclass('commonswarm_oauth.dpop_proof_replays') AND NOT a.attisdropped AND acl.grantee<>(SELECT relowner FROM pg_class WHERE oid=a.attrelid))
  ),false)),
  ('20261003000002-135-commonswarm_oauth-dpop_nonces', COALESCE((
    NOT EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) acl WHERE a.attrelid=to_regclass('commonswarm_oauth.dpop_nonces') AND NOT a.attisdropped AND acl.grantee<>(SELECT relowner FROM pg_class WHERE oid=a.attrelid))
  ),false)),
  ('20261003000002-136-commonswarm_oauth-issuer_key_denials', COALESCE((
    NOT EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) acl WHERE a.attrelid=to_regclass('commonswarm_oauth.issuer_key_denials') AND NOT a.attisdropped AND acl.grantee<>(SELECT relowner FROM pg_class WHERE oid=a.attrelid))
  ),false)),
  ('20261003000002-137-commonswarm_oauth-admin_verified_clients-withdrawn_at', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_verified_clients') AND attname='withdrawn_at' AND NOT attisdropped AND atttypid='timestamptz'::regtype AND attnotnull=false)
  ),false)),
  ('20261003000002-138-commonswarm_oauth-admin_client_owner_approvals-withdrawn_at', COALESCE((
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('commonswarm_oauth.admin_client_owner_approvals') AND attname='withdrawn_at' AND NOT attisdropped AND atttypid='timestamptz'::regtype AND attnotnull=false)
  ),false))
)
SELECT COALESCE(string_agg(label,',' ORDER BY label) FILTER (WHERE NOT ok),'') AS catalog_ok_failed_checks,
  COALESCE(bool_and(ok),false) AS catalog_ok_checks_ok FROM checks
\gset
\if :catalog_ok_checks_ok
\else
\warn 20261003000002 failed checks: :catalog_ok_failed_checks
\endif
SELECT :'catalog_ok_checks_ok'::boolean AS catalog_ok
\gset
