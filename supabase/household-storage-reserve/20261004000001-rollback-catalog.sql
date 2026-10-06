SELECT coalesce((
SELECT to_regclass('swarm.household_workspace_boundaries') IS NULL AND to_regclass('swarm.household_member_content_roles') IS NULL AND to_regclass('swarm.household_content_connections') IS NULL
),false) AS rollback_ok
\gset
