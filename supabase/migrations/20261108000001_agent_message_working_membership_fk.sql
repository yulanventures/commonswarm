-- swarm.agent_message_working (20261107000001) was created after 20261028000002 repointed every
-- tenant-pinned agent reference from the home-workspace row in swarm.agent_principals to
-- swarm.agent_workspace_memberships, and it still referenced agent_principals. A local agent that
-- works in a workspace other than its home one therefore failed every Working/idle status frame
-- with a foreign-key violation, so people there never saw "Working". Point it at memberships like
-- every other agent table. Existing rows are home-workspace rows, which always have a membership.
ALTER TABLE swarm.agent_message_working
  DROP CONSTRAINT agent_message_working_principal_id_workspace_id_fkey;
ALTER TABLE swarm.agent_message_working
  ADD CONSTRAINT agent_message_working_principal_id_workspace_id_fkey
  FOREIGN KEY (principal_id, workspace_id)
  REFERENCES swarm.agent_workspace_memberships (principal_id, workspace_id);
