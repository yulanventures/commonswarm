-- Add configurable per-workspace unpurged file name ceiling (default 5,000; range 1..1,000,000).
ALTER TABLE swarm.workspaces
  ADD COLUMN IF NOT EXISTS file_max_names integer NOT NULL DEFAULT 5000
  CHECK (file_max_names >= 1 AND file_max_names <= 1000000);

CREATE OR REPLACE VIEW swarm_read.workspaces
WITH (security_barrier = true)
AS
  SELECT
    w.workspace_id,
    w.name,
    w.archived_at,
    w.file_max_names
  FROM swarm.workspaces AS w
  WHERE swarm.is_member(w.workspace_id, auth.uid())
    AND w.archived_at IS NULL;
