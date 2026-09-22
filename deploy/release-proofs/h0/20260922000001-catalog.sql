-- Section 5 catalog_ok contract. This proof has no dependency on 000002/000003.
SELECT (
  EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='swarm' AND c.relname='h0_poll_locks' AND c.relkind='r'
      AND c.relrowsecurity AND NOT c.relforcerowsecurity AND pg_get_userbyid(c.relowner)='swarm_admin')
  AND EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='swarm' AND c.relname='h0_poll_batches' AND c.relkind='r'
      AND c.relrowsecurity AND NOT c.relforcerowsecurity AND pg_get_userbyid(c.relowner)='swarm_admin')
  AND EXISTS (SELECT 1 FROM pg_class c WHERE c.oid=to_regclass('swarm.h0_poll_locks')
    AND c.relacl::text='{swarm_admin=arwdDxtm/swarm_admin,swarm_command=arw/swarm_admin}')
  AND EXISTS (SELECT 1 FROM pg_class c WHERE c.oid=to_regclass('swarm.h0_poll_batches')
    AND c.relacl::text='{swarm_admin=arwdDxtm/swarm_admin,swarm_command=arw/swarm_admin}')
  AND (SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),
    a.attnotnull,pg_get_expr(d.adbin,d.adrelid,true)) ORDER BY a.attnum)
    FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid=to_regclass('swarm.h0_poll_locks') AND a.attnum>0 AND NOT a.attisdropped)
    IN (
      '[["workspace_id","uuid",true,null],["principal_id","uuid",true,null],["holder","uuid",true,null],["listener_instance_id","uuid",true,null],["acquired_at","timestamp with time zone",true,"statement_timestamp()"],["expires_at","timestamp with time zone",true,null]]'::jsonb,
      '[["workspace_id","uuid",true,null],["principal_id","uuid",true,null],["holder","uuid",true,null],["listener_instance_id","uuid",true,null],["acquired_at","timestamp with time zone",true,"statement_timestamp()"],["expires_at","timestamp with time zone",true,null],["waiting","boolean",true,"false"]]'::jsonb)
  AND (SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),
    a.attnotnull,pg_get_expr(d.adbin,d.adrelid,true)) ORDER BY a.attnum)
    FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid=to_regclass('swarm.h0_poll_batches') AND a.attnum>0 AND NOT a.attisdropped)
    = '[["workspace_id","uuid",true,null],["principal_id","uuid",true,null],["batch_id","uuid",true,null],["lease_ids","uuid[]",true,null],["status","text",true,null],["expires_at","timestamp with time zone",true,null],["closed_at","timestamp with time zone",false,null],["created_at","timestamp with time zone",true,"statement_timestamp()"]]'::jsonb
  AND (SELECT count(*) FROM pg_attribute WHERE attrelid=to_regclass('swarm.h0_poll_locks')
    AND attnum>0 AND NOT attisdropped AND attnotnull) >= 6
  AND (SELECT count(*) FROM pg_attribute WHERE attrelid=to_regclass('swarm.h0_poll_batches')
    AND attnum>0 AND NOT attisdropped) = 8
  AND (SELECT count(*) FROM pg_constraint WHERE conrelid=to_regclass('swarm.h0_poll_locks')
    AND contype IN ('p','f','c') AND convalidated) = 3
  AND EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid=to_regclass('swarm.h0_poll_locks')
    AND c.contype='p' AND pg_get_constraintdef(c.oid,true)='PRIMARY KEY (workspace_id, principal_id)')
  AND EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid=to_regclass('swarm.h0_poll_locks')
    AND c.contype='f' AND pg_get_constraintdef(c.oid,true)=
      'FOREIGN KEY (principal_id, workspace_id) REFERENCES swarm.agent_principals(principal_id, workspace_id)')
  AND EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid=to_regclass('swarm.h0_poll_locks')
    AND c.contype='c' AND pg_get_constraintdef(c.oid,true)='CHECK (expires_at >= acquired_at)')
  AND (SELECT count(*) FROM pg_constraint WHERE conrelid=to_regclass('swarm.h0_poll_batches')
    AND contype IN ('p','f','c') AND convalidated) = 5
  AND EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid=to_regclass('swarm.h0_poll_batches')
    AND c.contype='p' AND pg_get_constraintdef(c.oid,true)='PRIMARY KEY (workspace_id, principal_id, batch_id)')
  AND EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid=to_regclass('swarm.h0_poll_batches')
    AND c.contype='f' AND pg_get_constraintdef(c.oid,true)=
      'FOREIGN KEY (principal_id, workspace_id) REFERENCES swarm.agent_principals(principal_id, workspace_id)')
  AND EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid=to_regclass('swarm.h0_poll_batches')
    AND c.contype='c' AND pg_get_constraintdef(c.oid,true)=
      'CHECK (status = ANY (ARRAY[''active''::text, ''closed''::text]))')
  AND EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid=to_regclass('swarm.h0_poll_batches')
    AND c.contype='c' AND pg_get_constraintdef(c.oid,true)=
      'CHECK (cardinality(lease_ids) >= 1 AND cardinality(lease_ids) <= 10)')
  AND EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid=to_regclass('swarm.h0_poll_batches')
    AND c.contype='c' AND pg_get_constraintdef(c.oid,true)=
      'CHECK (status = ''active''::text AND closed_at IS NULL OR status = ''closed''::text AND closed_at IS NOT NULL)')
  AND EXISTS (SELECT 1 FROM pg_index i WHERE i.indexrelid=to_regclass('swarm.h0_poll_batches_one_active')
    AND i.indrelid=to_regclass('swarm.h0_poll_batches') AND i.indisunique AND i.indisvalid
    AND pg_get_indexdef(i.indexrelid)=
      'CREATE UNIQUE INDEX h0_poll_batches_one_active ON swarm.h0_poll_batches USING btree (workspace_id, principal_id) WHERE (status = ''active''::text)')
  AND EXISTS (SELECT 1 FROM pg_index i WHERE i.indexrelid=to_regclass('swarm.h0_poll_locks_pkey')
    AND i.indrelid=to_regclass('swarm.h0_poll_locks') AND i.indisunique AND i.indisvalid AND i.indisready
    AND pg_get_indexdef(i.indexrelid)=
      'CREATE UNIQUE INDEX h0_poll_locks_pkey ON swarm.h0_poll_locks USING btree (workspace_id, principal_id)')
  AND EXISTS (SELECT 1 FROM pg_index i WHERE i.indexrelid=to_regclass('swarm.h0_poll_batches_pkey')
    AND i.indrelid=to_regclass('swarm.h0_poll_batches') AND i.indisunique AND i.indisvalid AND i.indisready
    AND pg_get_indexdef(i.indexrelid)=
      'CREATE UNIQUE INDEX h0_poll_batches_pkey ON swarm.h0_poll_batches USING btree (workspace_id, principal_id, batch_id)')
  AND EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass('swarm.h0_poll_locks')
    AND t.tgname='h0_poll_locks_guard' AND t.tgenabled='O' AND t.tgtype=27
    AND t.tgfoid=to_regprocedure('swarm.h0_poll_locks_guard()'))
  AND EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass('swarm.h0_poll_batches')
    AND t.tgname='h0_poll_batches_guard' AND t.tgenabled='O' AND t.tgtype=27
    AND t.tgfoid=to_regprocedure('swarm.h0_poll_batches_guard()'))
  AND EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('swarm.h0_poll_locks_guard()')
    AND pg_get_userbyid(p.proowner)='swarm_admin' AND p.proconfig=ARRAY['search_path=pg_catalog']
    AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=
      'b7bf808fa8566359f0e531264e23a3d40678f9afcad13ac7d3e9e71d855c8fa1')
  AND EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('swarm.h0_poll_batches_guard()')
    AND pg_get_userbyid(p.proowner)='swarm_admin' AND p.proconfig=ARRAY['search_path=pg_catalog']
    AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') IN (
      'dbfaed0dfbf4fd40f1adb034f1de6f09e4a2acefee05196f2371d938f694a8e2',
      '1130f232a81557fdc12b8a78f12246ef0b26be7894d6d8bb02f21b53dc556a67'))
  AND (SELECT count(*) FROM pg_policy WHERE polrelid=to_regclass('swarm.h0_poll_locks'))=1
  AND (SELECT count(*) FROM pg_policy WHERE polrelid=to_regclass('swarm.h0_poll_batches'))=1
  AND EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid=to_regclass('swarm.h0_poll_locks')
    AND p.polname='swarm_command_all' AND p.polpermissive AND p.polcmd='*'
    AND p.polroles=ARRAY[(SELECT oid FROM pg_roles WHERE rolname='swarm_command')]
    AND pg_get_expr(p.polqual,p.polrelid,true)='true'
    AND pg_get_expr(p.polwithcheck,p.polrelid,true)='true')
  AND EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid=to_regclass('swarm.h0_poll_batches')
    AND p.polname='swarm_command_all' AND p.polpermissive AND p.polcmd='*'
    AND p.polroles=ARRAY[(SELECT oid FROM pg_roles WHERE rolname='swarm_command')]
    AND pg_get_expr(p.polqual,p.polrelid,true)='true'
    AND pg_get_expr(p.polwithcheck,p.polrelid,true)='true')
) AS catalog_ok
\gset
