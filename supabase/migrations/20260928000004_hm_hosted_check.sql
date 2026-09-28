-- HM lane 3: durable hosted MCP check cursors and replayable batches.
-- Depends on 20260928000002_hm_hosted_authority.sql (hosted grants/seats).
-- Intentionally no BEGIN/COMMIT: deploy/RELEASE-TO-BOX.md owns the transaction.

CREATE TABLE swarm.hosted_mcp_check_cursors (
  seat_id uuid PRIMARY KEY,
  grant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  cursor_created_at timestamptz,
  cursor_signal_id uuid,
  updated_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', statement_timestamp()),
  UNIQUE (seat_id, grant_id, workspace_id, principal_id),
  FOREIGN KEY (seat_id, grant_id, workspace_id, principal_id)
    REFERENCES swarm.hosted_mcp_seats(seat_id, grant_id, workspace_id, principal_id),
  CHECK ((cursor_created_at IS NULL) = (cursor_signal_id IS NULL)),
  CHECK (cursor_created_at IS NULL
    OR cursor_created_at = date_trunc('milliseconds', cursor_created_at)),
  CHECK (updated_at = date_trunc('milliseconds', updated_at))
);

CREATE TABLE swarm.hosted_mcp_check_batches (
  batch_id uuid PRIMARY KEY,
  seat_id uuid NOT NULL,
  grant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  signal_ids uuid[] NOT NULL CHECK (cardinality(signal_ids) BETWEEN 1 AND 50),
  terminal_created_at timestamptz NOT NULL,
  terminal_signal_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', statement_timestamp()),
  acknowledged_at timestamptz,
  UNIQUE (batch_id, seat_id, grant_id, workspace_id),
  FOREIGN KEY (seat_id, grant_id, workspace_id, principal_id)
    REFERENCES swarm.hosted_mcp_seats(seat_id, grant_id, workspace_id, principal_id),
  FOREIGN KEY (seat_id, grant_id, workspace_id, principal_id)
    REFERENCES swarm.hosted_mcp_check_cursors(seat_id, grant_id, workspace_id, principal_id),
  CHECK (terminal_signal_id = signal_ids[cardinality(signal_ids)]),
  CHECK (terminal_created_at = date_trunc('milliseconds', terminal_created_at)),
  CHECK (created_at = date_trunc('milliseconds', created_at)),
  CHECK (acknowledged_at IS NULL
    OR acknowledged_at = date_trunc('milliseconds', acknowledged_at)),
  CHECK (acknowledged_at IS NULL OR acknowledged_at >= created_at)
);

CREATE UNIQUE INDEX hosted_mcp_check_batches_one_active
  ON swarm.hosted_mcp_check_batches(seat_id)
  WHERE acknowledged_at IS NULL;

COMMENT ON TABLE swarm.hosted_mcp_check_cursors IS
  'Committed hosted check cursor. Only ACK advances (millisecond created_at, signal id).';
COMMENT ON TABLE swarm.hosted_mcp_check_batches IS
  'Replayable hosted check batch. Stores ordered immutable signal ids, never signal bodies.';
COMMENT ON INDEX swarm.hosted_mcp_check_batches_one_active IS
  'At most one unacknowledged hosted check batch per seat.';

ALTER TABLE swarm.hosted_mcp_check_cursors OWNER TO swarm_admin;
ALTER TABLE swarm.hosted_mcp_check_batches OWNER TO swarm_admin;
ALTER TABLE swarm.hosted_mcp_check_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE swarm.hosted_mcp_check_batches ENABLE ROW LEVEL SECURITY;

CREATE POLICY swarm_command_all ON swarm.hosted_mcp_check_cursors
  AS PERMISSIVE FOR ALL TO swarm_command USING (true) WITH CHECK (true);
CREATE POLICY swarm_command_all ON swarm.hosted_mcp_check_batches
  AS PERMISSIVE FOR ALL TO swarm_command USING (true) WITH CHECK (true);

REVOKE ALL ON TABLE swarm.hosted_mcp_check_cursors, swarm.hosted_mcp_check_batches
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT SELECT, INSERT, UPDATE ON TABLE
  swarm.hosted_mcp_check_cursors, swarm.hosted_mcp_check_batches
  TO swarm_command;

CREATE FUNCTION swarm.hosted_mcp_check_cursors_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'SWARM_HOSTED_CHECK_CURSOR_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.cursor_created_at IS NOT NULL OR NEW.cursor_signal_id IS NOT NULL THEN
      RAISE EXCEPTION 'SWARM_HOSTED_CHECK_CURSOR_INVALID' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.seat_id IS DISTINCT FROM OLD.seat_id
     OR NEW.grant_id IS DISTINCT FROM OLD.grant_id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.principal_id IS DISTINCT FROM OLD.principal_id
     OR (OLD.cursor_created_at IS NOT NULL AND NEW.cursor_created_at IS NULL)
     OR (OLD.cursor_created_at IS NOT NULL AND
       (NEW.cursor_created_at, NEW.cursor_signal_id) <=
       (OLD.cursor_created_at, OLD.cursor_signal_id))
     OR (NEW.cursor_created_at IS NOT NULL AND NOT EXISTS (
       SELECT 1
       FROM swarm.hosted_mcp_check_batches AS b
       WHERE b.seat_id = NEW.seat_id
         AND b.grant_id = NEW.grant_id
         AND b.workspace_id = NEW.workspace_id
         AND b.principal_id = NEW.principal_id
         AND b.terminal_created_at = NEW.cursor_created_at
         AND b.terminal_signal_id = NEW.cursor_signal_id
         AND b.acknowledged_at IS NOT NULL
     ))
  THEN
    RAISE EXCEPTION 'SWARM_HOSTED_CHECK_CURSOR_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$fn$;

ALTER FUNCTION swarm.hosted_mcp_check_cursors_guard() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.hosted_mcp_check_cursors_guard()
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
CREATE TRIGGER hosted_mcp_check_cursors_guard
  BEFORE INSERT OR UPDATE OR DELETE ON swarm.hosted_mcp_check_cursors
  FOR EACH ROW EXECUTE FUNCTION swarm.hosted_mcp_check_cursors_guard();

CREATE FUNCTION swarm.hosted_mcp_check_batches_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $fn$
DECLARE
  v_ordered_ids uuid[];
  v_terminal_created_at timestamptz;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'SWARM_HOSTED_CHECK_BATCH_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.acknowledged_at IS NOT NULL THEN
      RAISE EXCEPTION 'SWARM_HOSTED_CHECK_BATCH_INVALID' USING ERRCODE = '23514';
    END IF;
    SELECT array_agg(s.id ORDER BY date_trunc('milliseconds', s.created_at), s.id),
           max(date_trunc('milliseconds', s.created_at)) FILTER (
             WHERE s.id = NEW.terminal_signal_id
           )
    INTO v_ordered_ids, v_terminal_created_at
    FROM unnest(NEW.signal_ids) AS requested(signal_id)
    JOIN swarm.signals AS s ON s.id = requested.signal_id
    WHERE s.workspace_id = NEW.workspace_id
      AND (
        s.to_agent_principal_id = NEW.principal_id
        OR EXISTS (
          SELECT 1
          FROM swarm.signal_recipients AS recipient
          WHERE recipient.workspace_id = s.workspace_id
            AND recipient.signal_id = s.id
            AND recipient.recipient_agent_principal_id = NEW.principal_id
        )
      );
    IF v_ordered_ids IS DISTINCT FROM NEW.signal_ids
       OR cardinality(v_ordered_ids) <> cardinality(NEW.signal_ids)
       OR (SELECT count(DISTINCT signal_id)
           FROM unnest(NEW.signal_ids) AS distinct_ids(signal_id)) <>
          cardinality(NEW.signal_ids)
       OR v_terminal_created_at IS DISTINCT FROM NEW.terminal_created_at
    THEN
      RAISE EXCEPTION 'SWARM_HOSTED_CHECK_BATCH_INVALID' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.batch_id IS DISTINCT FROM OLD.batch_id
     OR NEW.seat_id IS DISTINCT FROM OLD.seat_id
     OR NEW.grant_id IS DISTINCT FROM OLD.grant_id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.principal_id IS DISTINCT FROM OLD.principal_id
     OR NEW.signal_ids IS DISTINCT FROM OLD.signal_ids
     OR NEW.terminal_created_at IS DISTINCT FROM OLD.terminal_created_at
     OR NEW.terminal_signal_id IS DISTINCT FROM OLD.terminal_signal_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR OLD.acknowledged_at IS NOT NULL
     OR NEW.acknowledged_at IS NULL
  THEN
    RAISE EXCEPTION 'SWARM_HOSTED_CHECK_BATCH_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$fn$;

ALTER FUNCTION swarm.hosted_mcp_check_batches_guard() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.hosted_mcp_check_batches_guard()
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
CREATE TRIGGER hosted_mcp_check_batches_guard
  BEFORE INSERT OR UPDATE OR DELETE ON swarm.hosted_mcp_check_batches
  FOR EACH ROW EXECUTE FUNCTION swarm.hosted_mcp_check_batches_guard();

-- Lane 2's command/read resolvers remain unchanged. This command-only wrapper
-- reuses the complete lane-2 read fence for the check tool.
CREATE FUNCTION swarm.resolve_hosted_mcp_check_authorization(
  p_grant_id uuid,
  p_handle text
)
RETURNS TABLE (
  grant_id uuid,
  provider_grant_id text,
  seat_id uuid,
  handle text,
  workspace_id uuid,
  stream_id uuid,
  owner_user_id uuid,
  principal_id uuid,
  name text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = swarm, pg_catalog
AS $fn$
  SELECT *
  FROM swarm.resolve_hosted_seat_read_authorization(p_grant_id, p_handle, 'check')
$fn$;

ALTER FUNCTION swarm.resolve_hosted_mcp_check_authorization(uuid, text) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.resolve_hosted_mcp_check_authorization(uuid, text)
  FROM PUBLIC, anon, authenticated, swarm_read;
GRANT EXECUTE ON FUNCTION swarm.resolve_hosted_mcp_check_authorization(uuid, text)
  TO swarm_command;

-- Both new selection and stored-id replay call this function. The underlying
-- security-barrier view remains the single visibility surface. Expiry is not
-- applied here: callers apply it only while selecting new ids, so an active
-- batch still resolves after a signal expires.
CREATE FUNCTION swarm.hosted_mcp_check_visible_signals(
  p_workspace_id uuid,
  p_principal_id uuid,
  p_signal_ids uuid[] DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  workspace_id uuid,
  "from" uuid,
  from_kind text,
  "to" uuid,
  about text,
  kind text,
  body text,
  until timestamptz,
  created_at timestamptz,
  to_agent uuid,
  in_reply_to uuid,
  attachments jsonb,
  channel_id uuid,
  thread_root_id uuid,
  broadcast_to_channel boolean,
  recipients jsonb,
  reply_status text,
  chain_hop smallint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = swarm_read, swarm, auth, pg_catalog
AS $fn$
  SELECT
    s.id,
    s.workspace_id,
    s."from",
    s.from_kind,
    s."to",
    s.about,
    s.kind,
    s.body,
    s.until,
    s.created_at,
    s.to_agent,
    s.in_reply_to,
    s.attachments,
    s.channel_id,
    s.thread_root_id,
    s.broadcast_to_channel,
    s.recipients,
    s.reply_status,
    s.chain_hop
  FROM swarm_read.signals AS s
  WHERE p_principal_id::text = COALESCE(
      NULLIF(current_setting('request.jwt.claims', true), '')::jsonb
        ->> 'agent_principal_id',
      ''
    )
    AND s.workspace_id = p_workspace_id
    AND (
      s.to_agent = p_principal_id
      OR s.recipients @> jsonb_build_array(
        jsonb_build_object('kind', 'agent', 'id', p_principal_id)
      )
    )
    AND (p_signal_ids IS NULL OR s.id = ANY(p_signal_ids))
$fn$;

ALTER FUNCTION swarm.hosted_mcp_check_visible_signals(uuid, uuid, uuid[]) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.hosted_mcp_check_visible_signals(uuid, uuid, uuid[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION swarm.hosted_mcp_check_visible_signals(uuid, uuid, uuid[])
  TO swarm_command, swarm_read;
