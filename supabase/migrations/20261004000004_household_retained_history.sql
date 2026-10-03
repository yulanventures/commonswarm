-- Household reservations never expire out of quota until explicitly released.
-- Retired revisions and conflict drafts survive the legacy purge cron.
CREATE OR REPLACE FUNCTION swarm.purge_file_artifacts()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  -- Lock order: FILE rows first, the same rows file_restore locks FOR UPDATE,
  -- so a concurrent restore either commits before this claim sees the file or
  -- blocks until the claim commits — never interleaves. (Review finding: the
  -- claim used to lock only version rows while restore locked the file row.)
  WITH expired_files AS (
    SELECT f.file_id, f.workspace_id
    FROM swarm.files AS f
    WHERE NOT f.household_managed AND f.tombstoned_at IS NOT NULL
      AND f.tombstoned_at < statement_timestamp() - interval '30 days'
    FOR UPDATE
  ),
  tombstone_claim AS (
    UPDATE swarm.file_versions AS v
    SET state = 'purged'
    FROM expired_files AS f
    WHERE f.file_id = v.file_id
      AND f.workspace_id = v.workspace_id
      AND v.state != 'purged'
    RETURNING v.storage_path
  ),
  -- ★R15 with the signing-delay margin: the row's clock starts before the
  -- upload URL is signed, so a 2h claim could kill a row whose 2h URL still
  -- works. Claim only after 3h: URL validity plus an hour of margin.
  pending_claim AS (
    UPDATE swarm.file_versions AS v
    SET state = 'purged'
    WHERE v.state = 'pending'
      AND NOT EXISTS (SELECT 1 FROM swarm.files f WHERE f.file_id = v.file_id AND f.workspace_id = v.workspace_id AND f.household_managed)
      AND v.created_at < statement_timestamp() - interval '3 hours'
    RETURNING v.storage_path
  ),
  -- Orphan objects: paths in the bucket with no version row at all (a PUT that
  -- outlived a lost create response, or debris). Queued on the same schedule.
  orphans AS (
    SELECT o.name AS storage_path
    FROM storage.objects AS o
    WHERE o.bucket_id = 'swarm-files'
      AND o.created_at < statement_timestamp() - interval '3 hours'
      AND NOT EXISTS (
        SELECT 1 FROM swarm.file_versions AS v WHERE v.storage_path = o.name
      )
  )
  INSERT INTO swarm.file_purge_queue (storage_path)
  SELECT storage_path FROM tombstone_claim
  UNION
  SELECT storage_path FROM pending_claim
  UNION
  SELECT storage_path FROM orphans
  ON CONFLICT (storage_path) DO NOTHING;

  -- Item 6 (S2 verify round): once the window ended and every version is
  -- purged, the FILE releases its name — purged_at flips under the same
  -- file-row locks the claim above took, and the partial unique index stops
  -- counting it. The row itself is never deleted: name, sizes, and audit
  -- attribution outlive the bytes (spec §6).
  UPDATE swarm.files AS f
  SET purged_at = statement_timestamp()
  WHERE NOT f.household_managed AND f.tombstoned_at IS NOT NULL
    AND f.tombstoned_at < statement_timestamp() - interval '30 days'
    AND f.purged_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM swarm.file_versions AS v
      WHERE v.file_id = f.file_id
        AND v.workspace_id = f.workspace_id
        AND v.state != 'purged'
    );
END;
$$;

ALTER FUNCTION swarm.purge_file_artifacts() OWNER TO swarm_admin;
-- The definer runs as swarm_admin, which enumerates (never deletes) objects
-- for the orphan sweep.
GRANT USAGE ON SCHEMA storage TO swarm_admin;
GRANT SELECT ON TABLE storage.objects TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.purge_file_artifacts() FROM PUBLIC;

-- Suppress new managed metadata on the legacy member-only view. Lane 4 owns
-- legacy HTTP byte/command fences before any household route is enabled.
CREATE OR REPLACE VIEW swarm_read.files
WITH (security_barrier = true)
AS
  SELECT
    f.file_id,
    f.workspace_id,
    f.name,
    f.current_version,
    f.created_by_kind,
    f.created_by,
    f.created_at,
    f.tombstoned_at,
    v.size_bytes,
    v.content_type,
    v.sha256,
    v.uploaded_by_kind,
    v.uploaded_by,
    v.committed_at,
    counts.live_version_count,
    counts.retired_version_count
  FROM swarm.files AS f
  LEFT JOIN swarm.file_versions AS v
    ON v.file_id = f.file_id
   AND v.workspace_id = f.workspace_id
   AND v.version_n = f.current_version
   AND v.state = 'live'
  LEFT JOIN LATERAL (
    SELECT
      count(*) FILTER (WHERE counted.state = 'live')::integer
        AS live_version_count,
      count(*) FILTER (WHERE counted.state = 'retired')::integer
        AS retired_version_count
    FROM swarm.file_versions AS counted
    WHERE counted.file_id = f.file_id
      AND counted.workspace_id = f.workspace_id
  ) AS counts ON true
  WHERE swarm.is_member(f.workspace_id, auth.uid())
    AND f.purged_at IS NULL
    AND NOT f.household_managed;

ALTER VIEW swarm_read.files OWNER TO swarm_admin;
GRANT SELECT ON swarm_read.files TO authenticated, swarm_read;
REVOKE ALL ON swarm_read.files FROM anon;
-- Reserve rollback (verbatim in supabase/household-storage-reserve/ and
-- deploy/release-proofs/household-storage/; approved release procedure only):
-- CREATE OR REPLACE FUNCTION swarm.purge_file_artifacts()
-- RETURNS void
-- LANGUAGE plpgsql
-- SECURITY DEFINER
-- SET search_path = swarm, storage, pg_catalog
-- AS $$
-- BEGIN
--   -- Lock order: FILE rows first, the same rows file_restore locks FOR UPDATE,
--   -- so a concurrent restore either commits before this claim sees the file or
--   -- blocks until the claim commits — never interleaves. (Review finding: the
--   -- claim used to lock only version rows while restore locked the file row.)
--   WITH expired_files AS (
--     SELECT f.file_id, f.workspace_id
--     FROM swarm.files AS f
--     WHERE f.tombstoned_at IS NOT NULL
--       AND f.tombstoned_at < statement_timestamp() - interval '30 days'
--     FOR UPDATE
--   ),
--   tombstone_claim AS (
--     UPDATE swarm.file_versions AS v
--     SET state = 'purged'
--     FROM expired_files AS f
--     WHERE f.file_id = v.file_id
--       AND f.workspace_id = v.workspace_id
--       AND v.state != 'purged'
--     RETURNING v.storage_path
--   ),
--   -- ★R15 with the signing-delay margin: the row's clock starts before the
--   -- upload URL is signed, so a 2h claim could kill a row whose 2h URL still
--   -- works. Claim only after 3h: URL validity plus an hour of margin.
--   pending_claim AS (
--     UPDATE swarm.file_versions AS v
--     SET state = 'purged'
--     WHERE v.state = 'pending'
--       AND v.created_at < statement_timestamp() - interval '3 hours'
--     RETURNING v.storage_path
--   ),
--   -- Orphan objects: paths in the bucket with no version row at all (a PUT that
--   -- outlived a lost create response, or debris). Queued on the same schedule.
--   orphans AS (
--     SELECT o.name AS storage_path
--     FROM storage.objects AS o
--     WHERE o.bucket_id = 'swarm-files'
--       AND o.created_at < statement_timestamp() - interval '3 hours'
--       AND NOT EXISTS (
--         SELECT 1 FROM swarm.file_versions AS v WHERE v.storage_path = o.name
--       )
--   )
--   INSERT INTO swarm.file_purge_queue (storage_path)
--   SELECT storage_path FROM tombstone_claim
--   UNION
--   SELECT storage_path FROM pending_claim
--   UNION
--   SELECT storage_path FROM orphans
--   ON CONFLICT (storage_path) DO NOTHING;
--
--   -- Item 6 (S2 verify round): once the window ended and every version is
--   -- purged, the FILE releases its name — purged_at flips under the same
--   -- file-row locks the claim above took, and the partial unique index stops
--   -- counting it. The row itself is never deleted: name, sizes, and audit
--   -- attribution outlive the bytes (spec §6).
--   UPDATE swarm.files AS f
--   SET purged_at = statement_timestamp()
--   WHERE f.tombstoned_at IS NOT NULL
--     AND f.tombstoned_at < statement_timestamp() - interval '30 days'
--     AND f.purged_at IS NULL
--     AND NOT EXISTS (
--       SELECT 1 FROM swarm.file_versions AS v
--       WHERE v.file_id = f.file_id
--         AND v.workspace_id = f.workspace_id
--         AND v.state != 'purged'
--     );
-- END;
-- $$;
--
-- ALTER FUNCTION swarm.purge_file_artifacts() OWNER TO swarm_admin;
-- -- The definer runs as swarm_admin, which enumerates (never deletes) objects
-- -- for the orphan sweep.
-- GRANT USAGE ON SCHEMA storage TO swarm_admin;
-- GRANT SELECT ON TABLE storage.objects TO swarm_admin;
-- REVOKE ALL ON FUNCTION swarm.purge_file_artifacts() FROM PUBLIC;
--
-- CREATE OR REPLACE VIEW swarm_read.files
-- WITH (security_barrier = true)
-- AS
--   SELECT
--     f.file_id,
--     f.workspace_id,
--     f.name,
--     f.current_version,
--     f.created_by_kind,
--     f.created_by,
--     f.created_at,
--     f.tombstoned_at,
--     v.size_bytes,
--     v.content_type,
--     v.sha256,
--     v.uploaded_by_kind,
--     v.uploaded_by,
--     v.committed_at,
--     counts.live_version_count,
--     counts.retired_version_count
--   FROM swarm.files AS f
--   LEFT JOIN swarm.file_versions AS v
--     ON v.file_id = f.file_id
--    AND v.workspace_id = f.workspace_id
--    AND v.version_n = f.current_version
--    AND v.state = 'live'
--   LEFT JOIN LATERAL (
--     SELECT
--       count(*) FILTER (WHERE counted.state = 'live')::integer
--         AS live_version_count,
--       count(*) FILTER (WHERE counted.state = 'retired')::integer
--         AS retired_version_count
--     FROM swarm.file_versions AS counted
--     WHERE counted.file_id = f.file_id
--       AND counted.workspace_id = f.workspace_id
--   ) AS counts ON true
--   WHERE swarm.is_member(f.workspace_id, auth.uid())
--     AND f.purged_at IS NULL;
--
-- ALTER VIEW swarm_read.files OWNER TO swarm_admin;
-- GRANT SELECT ON swarm_read.files TO authenticated, swarm_read;
-- REVOKE ALL ON swarm_read.files FROM anon;
