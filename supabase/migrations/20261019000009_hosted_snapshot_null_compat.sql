-- Preserve pre-M00002 closed snapshots without rewriting markers or audits.
-- CREATE OR REPLACE retains the existing owner, invoker mode, signature and ACL.
CREATE OR REPLACE FUNCTION swarm.audit_household_hosted_restriction() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE actor uuid; command_kind text; request_id text; digest text; expected jsonb; prior_markers jsonb;
BEGIN
 actor := nullif(current_setting('cswarm.household_actor',true),'')::uuid;
 command_kind := current_setting('cswarm.household_command',true);
 request_id := nullif(current_setting('cswarm.household_request',true),'');
 digest := nullif(current_setting('cswarm.household_digest',true),'');
 IF current_user<>'swarm_command' OR actor IS NULL OR request_id IS NULL OR digest IS NULL
   OR digest !~ '^[0-9a-f]{64}$' OR command_kind IS NULL OR command_kind='' OR actor<>NEW.owner_user_id
   OR NOT EXISTS(SELECT 1 FROM swarm.memberships m JOIN swarm.workspaces w USING(workspace_id)
     WHERE m.workspace_id=NEW.workspace_id AND m.user_id=actor AND m.revoked_at IS NULL AND w.archived_at IS NULL)
   OR NOT EXISTS(SELECT 1 FROM swarm.hosted_mcp_seats s WHERE s.workspace_id=NEW.workspace_id
     AND s.grant_id=NEW.grant_id AND s.principal_id=NEW.principal_id AND s.owner_user_id=actor) THEN
  RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='owned hosted restriction context required';
 END IF;
 IF TG_OP='UPDATE' AND (NEW.grant_id,NEW.workspace_id,NEW.owner_user_id,NEW.principal_id)
   IS DISTINCT FROM (OLD.grant_id,OLD.workspace_id,OLD.owner_user_id,OLD.principal_id) THEN
  RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='hosted restriction scope is immutable';
 END IF;
 -- New grant-wide restrictions originate only while this human is a current
 -- workspace owner. An existing owner-origin target can still be changed after
 -- downgrade; ordinary never-owner admin/member per-seat approvals are unchanged.
 IF TG_OP='INSERT' AND NOT EXISTS(SELECT 1 FROM swarm.memberships m
   WHERE m.workspace_id=NEW.workspace_id AND m.user_id=actor AND m.role='owner' AND m.revoked_at IS NULL) THEN
  RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='current owner required for new hosted restriction';
 END IF;
 IF NEW.origin='human_allow' THEN
  IF command_kind NOT IN ('household_permissions','household_approve_connection') OR NOT EXISTS(
    SELECT 1 FROM swarm.household_content_connections c
    JOIN swarm.household_member_content_roles r ON r.workspace_id=c.workspace_id AND r.user_id=c.owner_user_id
    JOIN swarm.household_workspace_boundaries b ON b.workspace_id=c.workspace_id
    JOIN swarm.hosted_mcp_grants g ON g.grant_id=c.hosted_grant_id
    JOIN swarm.hosted_mcp_grant_workspaces gw ON gw.grant_id=g.grant_id AND gw.workspace_id=c.workspace_id
    JOIN swarm.hosted_mcp_seats s ON s.seat_id=c.connection_id AND s.grant_id=g.grant_id AND s.principal_id=c.principal_id
    WHERE c.workspace_id=NEW.workspace_id AND c.hosted_grant_id=NEW.grant_id AND c.principal_id=NEW.principal_id
      AND c.owner_user_id=actor AND c.revoked_at IS NULL AND (c.expires_at IS NULL OR c.expires_at>clock_timestamp())
      AND c.operations=NEW.operations AND c.consent_receipt_id=r.content_consent_id AND r.revoked_at IS NULL
      AND (r.content_role='editor' OR NEW.operations=ARRAY['read']::text[])
      AND c.purpose=b.purpose AND (b.purpose='shared' OR b.owner_user_id=actor)
      AND g.state='active' AND g.revoked_at IS NULL AND gw.revoked_at IS NULL AND s.revoked_at IS NULL) THEN
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='live human connection approval required';
  END IF;
 ELSIF NEW.origin='human_withdraw' THEN
  IF command_kind IS DISTINCT FROM 'household_withdraw_connection' THEN
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='human withdrawal context required';
  END IF;
 ELSE
  IF command_kind IS DISTINCT FROM 'household_connection_invalidation' THEN
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='connection invalidation context required';
  END IF;
 END IF;
 -- Replacement authorization is separate from ordinary per-seat Allow.
 -- Exact JSON equality includes every relevant legacy field and restriction
 -- version; containment would wrongly accept subsets of operation arrays.
 IF jsonb_typeof(NEW.closed_target_replacements) IS DISTINCT FROM 'array' THEN
  RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='closed target snapshots must be an array';
 END IF;
 IF jsonb_array_length(NEW.closed_target_replacements)>256 THEN
  RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='closed target snapshot bound exceeded';
 END IF;
 IF NEW.closed_target_replacements<>'[]'::jsonb THEN
  IF NEW.origin<>'human_allow' OR command_kind NOT IN ('household_permissions','household_approve_connection')
    OR NOT EXISTS(SELECT 1 FROM swarm.memberships m WHERE m.workspace_id=NEW.workspace_id
      AND m.user_id=actor AND m.role='owner' AND m.revoked_at IS NULL) THEN
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='current owner human Allow required for closed target replacement';
  END IF;
  SELECT coalesce(jsonb_agg(snapshot ORDER BY snapshot::text),'[]'::jsonb) INTO expected FROM (
      SELECT jsonb_build_object('kind','restriction','principal_id',r.principal_id,'operations',r.operations,'origin',r.origin,'changed_at',r.changed_at,'changed_by',r.changed_by) AS snapshot FROM swarm.household_hosted_content_restrictions r
        WHERE r.grant_id=NEW.grant_id AND r.workspace_id=NEW.workspace_id AND EXISTS(SELECT 1 FROM swarm.hosted_mcp_seats cs WHERE cs.grant_id=r.grant_id
          AND cs.workspace_id=r.workspace_id AND cs.principal_id=r.principal_id AND cs.owner_user_id=r.owner_user_id)
        AND NOT EXISTS(SELECT 1 FROM swarm.hosted_mcp_seats ls JOIN swarm.agent_principals lp USING(principal_id)
          WHERE ls.grant_id=r.grant_id AND ls.workspace_id=r.workspace_id
            AND ls.principal_id=r.principal_id AND ls.owner_user_id=r.owner_user_id
            AND ls.revoked_at IS NULL AND lp.revoked_at IS NULL)
      UNION ALL
      SELECT jsonb_build_object('kind','legacy','row',to_jsonb(c)) AS snapshot FROM swarm.household_content_connections c
        WHERE c.hosted_grant_id=NEW.grant_id AND c.workspace_id=NEW.workspace_id AND EXISTS(SELECT 1 FROM swarm.hosted_mcp_seats cs WHERE cs.grant_id=c.grant_id
          AND cs.workspace_id=c.workspace_id AND cs.principal_id=c.principal_id AND cs.owner_user_id=c.owner_user_id)
        AND NOT EXISTS(SELECT 1 FROM swarm.hosted_mcp_seats ls JOIN swarm.agent_principals lp USING(principal_id)
          WHERE ls.grant_id=c.grant_id AND ls.workspace_id=c.workspace_id
            AND ls.principal_id=c.principal_id AND ls.owner_user_id=c.owner_user_id
            AND ls.revoked_at IS NULL AND lp.revoked_at IS NULL)
      LIMIT 257
  ) targets;
  -- Retain exact wrapper/row fields, array length and ordinal. Only a
  -- legacy inner-row key absent in the saved marker may match a new JSON null.
  -- IS DISTINCT FROM keeps SQL NULL and malformed values fail closed.
  IF jsonb_array_length(NEW.closed_target_replacements) IS DISTINCT FROM jsonb_array_length(expected)
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(NEW.closed_target_replacements) WITH ORDINALITY AS saved(value,ordinal)
      FULL JOIN jsonb_array_elements(expected) WITH ORDINALITY AS live(value,ordinal) USING(ordinal)
      WHERE saved.value IS DISTINCT FROM live.value AND (
        jsonb_typeof(saved.value->'row')='object'
        AND live.value->>'kind'='legacy'
        AND NOT (saved.value->'row' ? 'renewal_grant_id')
        AND live.value->'row'->'renewal_grant_id'='null'::jsonb
        AND saved.value=jsonb_set(live.value,'{row}',(live.value->'row')-'renewal_grant_id')
      ) IS DISTINCT FROM true
    ) THEN
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='exact closed target snapshots required';
  END IF;
 END IF;
 prior_markers := CASE WHEN TG_OP='UPDATE' THEN OLD.closed_target_replacements ELSE '[]'::jsonb END;
 IF prior_markers IS DISTINCT FROM NEW.closed_target_replacements THEN
  -- Keep both marker versions in the existing append-only audit. No approval,
  -- restriction, consent or historical audit row is deleted or rewritten.
  INSERT INTO swarm.household_object_audit(audit_id,workspace_id,command_id,actor_user,actor_principal,occurred_at,command_kind,request_digest,outcome,reason_code)
  VALUES(gen_random_uuid(),NEW.workspace_id,request_id,actor,NULL,clock_timestamp(),command_kind,digest,'committed',
    'closed_target_replacements:' || jsonb_build_object('principal_id',NEW.principal_id,'old',prior_markers,'new',NEW.closed_target_replacements)::text);
 END IF;
 NEW.changed_by := actor;
 NEW.changed_at := clock_timestamp();
 INSERT INTO swarm.household_object_audit(audit_id,workspace_id,command_id,actor_user,actor_principal,occurred_at,command_kind,request_digest,outcome,reason_code)
 VALUES(gen_random_uuid(),NEW.workspace_id,request_id,actor,NULL,NEW.changed_at,command_kind,digest,'committed',NEW.origin);
 RETURN NEW;
END $$;
