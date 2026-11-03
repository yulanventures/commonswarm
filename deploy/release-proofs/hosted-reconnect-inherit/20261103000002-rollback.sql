-- Guarded rollback for 20261103000002: drop the inheritance function. Rows it inserted stay as ordinary bindings.
-- Deploy the previous edge build first, since the activation path calls this function.
DROP FUNCTION IF EXISTS swarm.inherit_stranded_hosted_agents(uuid);
