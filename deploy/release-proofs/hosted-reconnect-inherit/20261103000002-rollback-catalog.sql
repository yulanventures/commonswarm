-- Read-only rollback catalog verification for 20261103000002.
SELECT to_regprocedure('swarm.inherit_stranded_hosted_agents(uuid)') IS NULL AS rollback_ok
\gset
