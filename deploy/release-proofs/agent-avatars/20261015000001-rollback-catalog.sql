SELECT to_regclass('swarm_read.agent_identity_marks') IS NULL
 AND to_regclass('swarm.agent_avatar_jobs') IS NULL
 AND to_regclass('swarm.agent_avatars') IS NULL
 AND to_regclass('swarm.agent_model_provenance') IS NULL AS rollback_ok
\gset
