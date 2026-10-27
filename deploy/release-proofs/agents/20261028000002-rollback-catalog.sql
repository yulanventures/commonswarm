-- Read-only catalog and body verification; safe before apply.
SELECT (SELECT count(*)=12 AND bool_and(p.proowner='swarm_admin'::regrole AND md5(p.prosrc)=e.digest)
 FROM (VALUES ('swarm.discover_local_credential_ids(bytea)','fd1e0a129f81d0e23124ec64eee5536c'),
('swarm.discover_local_target_ids(uuid,uuid,uuid[],uuid[],boolean,uuid,boolean)','fffc6b3b04db60f408b5230d24dbe847'),
('swarm.agent_delivery_read_context(bytea,uuid)','4be113796d500c513c096339a2985863'),
('swarm.prepare_renewal_grant(uuid,uuid)','ff749f55ee6f7e04e534d63bc3eb8b5b'),
('swarm.agent_tokens_successor_fence()','597b7c24135adbf5556b6ad864b43c54'),
('swarm.record_renewal_grant_use(uuid,uuid,text)','ba51115518cf2d6f07e2bf9ea7918aac'),
('swarm.household_local_family_binding_guard()','fdd490ddbc7f6263eb3b9cebe5a27e46'),
('swarm_read.local_connection_selection(uuid,uuid,uuid)','fa625471855684699e9dc4e8e2c23d68'),
('swarm_read.renewal_grant_roster(uuid)','b953c61a5e0bc3565703510fdcc93c5f'),
('swarm_read.renewal_grant_for_token(uuid,uuid)','674e0419bd0c86a723ad507f1855fd83'),
('swarm.admin_token_ancestry()','db6999b8c3ff1373bae0414c7837ae7a'),
('swarm.revoke_local_residual_tokens(uuid,uuid,text,uuid)','67c3203bcbee9568cb74ee3701ff04ac')) e(signature,digest) JOIN pg_proc p ON p.oid=to_regprocedure(e.signature))
 AND (to_regclass('swarm.agent_connection_sessions') IS NULL AND to_regclass('swarm.local_content_approval_workspaces') IS NULL AND to_regprocedure('swarm.local_agent_workspace_live(uuid,uuid)') IS NULL AND NOT has_table_privilege('swarm_command','swarm.agent_workspace_memberships','SELECT') AND NOT has_column_privilege('swarm_command','swarm.agent_workspace_memberships','principal_id','UPDATE')) AS rollback_ok
\gset
