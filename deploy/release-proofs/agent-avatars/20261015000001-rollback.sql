-- Reserve down migration. Explicit HezLead decision, reviewed verbatim SQL only.
-- Stop the avatar writer and export all three tables first. Never erase ledger
-- rows or immutable events. Reapplying this migration after use requires a
-- reviewed replay/restore of the exported avatar/job rows, not just a backfill.
DROP VIEW swarm_read.agent_identity_marks;
DROP TABLE swarm.agent_avatar_jobs;
DROP TABLE swarm.agent_avatars;
DROP TABLE swarm.agent_model_provenance;
