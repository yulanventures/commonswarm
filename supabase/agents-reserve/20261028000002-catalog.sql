-- Read-only catalog and body verification; safe before apply.
SELECT (SELECT count(*)=21 AND bool_and(p.proowner='swarm_admin'::regrole AND md5(p.prosrc)=e.digest)
 FROM (VALUES ('swarm.local_parent_connection_live(uuid)','001b5872dffbdc0ae3209582f8f90208'),
('swarm.local_agent_workspace_live(uuid,uuid)','aa2f04d729ee3cfbc29ee35c151324cf'),
('swarm.discover_local_credential_ids(bytea)','a1566c410480efcfe6ac7ecfccdd5a84'),
('swarm.discover_local_target_ids(uuid,uuid,uuid[],uuid[],boolean,uuid,boolean)','5e778d72876636ed12344036d59c277d'),
('swarm.agent_delivery_read_context(bytea,uuid)','d08e49c1b853cce45e4efc9e1e922d3f'),
('swarm.prepare_renewal_grant(uuid,uuid)','12e6f2d3fd4e0b8bae0afab13874eee9'),
('swarm.agent_tokens_successor_fence()','e95916678bfb89d5aeb40afec572d08e'),
('swarm.record_renewal_grant_use(uuid,uuid,text)','06c328ff9e4aabc071787c0ae6b16029'),
('swarm.household_local_family_binding_guard()','c31c06d3adde87fe02c662c0d9f43050'),
('swarm.local_agent_membership_allowed(uuid,uuid,uuid,boolean)','7afec249f924a82cc5363a996e4e00e8'),
('swarm.change_local_agent_membership(uuid,uuid,uuid,boolean)','47398b96660e4c3f86fefa8ac3d97e61'),
('swarm.set_local_workspace_approval(uuid,uuid,uuid)','af41e2bf8cd56a99f15f64263757558a'),
('swarm.remove_local_agents_for_member(uuid,uuid,uuid)','874729afc568f926904d6c5f36cd58db'),
('swarm.agent_reachable_workspaces(bytea)','dbf7c40d277129904d3c2677a53ce477'),
('swarm.sync_agent_connection_session()','15e1133395d0f165f3c6a289f8732554'),
('swarm_read.local_connection_selection(uuid,uuid,uuid)','d6a17b96d5ccd1e4fa0bd1caae5cbaef'),
('swarm_read.renewal_grant_roster(uuid)','ae61b1b77e2b5655f0288216aa39a746'),
('swarm_read.renewal_grant_for_token(uuid,uuid)','ef4684b890d60f599ce56a92b157ce7f'),
('swarm.activate_local_workspace_session(uuid,uuid,uuid,bigint,bytea)','fadb7dcf9b9e078c811b9625432164c7'),
('swarm.admin_token_ancestry()','483bd68f6b948442b3c98df12194d926'),
('swarm.revoke_local_residual_tokens(uuid,uuid,text,uuid)','60c2e3aa9aa3590d700bbf0f5b788bbc')) e(signature,digest) JOIN pg_proc p ON p.oid=to_regprocedure(e.signature))
 AND to_regclass('swarm.local_content_approval_workspaces') IS NOT NULL AND to_regclass('swarm.agent_connection_sessions') IS NOT NULL
 AND (SELECT bool_and(c.relowner='swarm_admin'::regrole AND c.relrowsecurity)
 FROM pg_class c WHERE c.oid IN(to_regclass('swarm.local_content_approval_workspaces'),to_regclass('swarm.agent_connection_sessions'))
 AND NOT has_table_privilege('authenticated',c.oid,'SELECT') AND NOT has_table_privilege('anon',c.oid,'SELECT'))
 AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('swarm.agent_execution_sessions') AND contype='p' AND pg_get_constraintdef(oid)='PRIMARY KEY (principal_id, workspace_id)')
 AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('swarm.agent_connection_sessions') AND contype='p' AND pg_get_constraintdef(oid)='PRIMARY KEY (principal_id, session_id)')
 AND has_function_privilege('swarm_command','swarm.change_local_agent_membership(uuid,uuid,uuid,boolean)','EXECUTE')
 AND NOT has_function_privilege('authenticated','swarm.change_local_agent_membership(uuid,uuid,uuid,boolean)','EXECUTE')
 AND NOT has_function_privilege('swarm_read','swarm.change_local_agent_membership(uuid,uuid,uuid,boolean)','EXECUTE')
 AS catalog_ok
\gset
