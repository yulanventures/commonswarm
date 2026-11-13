-- Mentions: who a public message asks for, kept apart from who may read it.
--
-- Until now the only way to get an agent's attention was to address the message to it, and an
-- addressed message is readable only by its recipients. A mention is attention without audience:
-- the message stays readable by the whole workspace, and each mentioned agent gets its own
-- swarm.signal_deliveries row through the same predicate the recipient triggers use.
--
-- A mention never sits on a private message. The insert trigger below refuses a row whose signal has
-- a recipient or is a private reply, so every reader that admits a mentioned agent
-- (hydrateDeliveryRefs, the delivery acks, the hosted check) admits it to a message the whole
-- workspace can already read.
--
-- No existing table, view or trigger changes. Three functions are replaced in place: the hosted
-- check's visibility function and its batch guard each gain the mention arm, and the shared wake
-- predicate now follows workspace membership (see below). swarm_read.signals is not recreated.

CREATE TABLE swarm.signal_mentions (
  signal_id    uuid NOT NULL,
  workspace_id uuid NOT NULL,
  mentioned_user_id uuid,
  mentioned_agent_principal_id uuid,
  -- The same bound as swarm.signal_recipients, and the same way of enforcing it: position is half
  -- the primary key, so a signal holds at most 8 mention rows and wakes at most 8 agents.
  -- SIGNAL_MENTION_MAX in supabase/functions/_shared/channels.ts is the edge's copy.
  position     smallint NOT NULL CHECK (position BETWEEN 0 AND 7),
  -- 'author': the sender named them. 'lead': the workspace lead, added to an untagged post from a
  -- person. 'thread': an agent already in the thread, added to a person's reply there.
  source       text NOT NULL DEFAULT 'author' CHECK (source IN ('author', 'lead', 'thread')),
  created_at   timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (signal_id, position),
  CHECK (num_nonnulls(mentioned_user_id, mentioned_agent_principal_id) = 1),
  UNIQUE (signal_id, mentioned_user_id),
  UNIQUE (signal_id, mentioned_agent_principal_id),
  FOREIGN KEY (signal_id, workspace_id)
    REFERENCES swarm.signals (id, workspace_id),
  FOREIGN KEY (workspace_id, mentioned_user_id)
    REFERENCES swarm.memberships (workspace_id, user_id),
  -- The agent's membership of THIS workspace, as on swarm.signal_recipients since 20261028000002:
  -- swarm.agent_principals.workspace_id is only the workspace an agent started in.
  FOREIGN KEY (mentioned_agent_principal_id, workspace_id)
    REFERENCES swarm.agent_workspace_memberships (principal_id, workspace_id)
);

CREATE INDEX signal_mentions_agent
  ON swarm.signal_mentions (workspace_id, mentioned_agent_principal_id, signal_id)
  WHERE mentioned_agent_principal_id IS NOT NULL;

ALTER TABLE swarm.signal_mentions OWNER TO swarm_admin;
ALTER TABLE swarm.signal_mentions ENABLE ROW LEVEL SECURITY;

CREATE POLICY swarm_command_all ON swarm.signal_mentions
  AS PERMISSIVE FOR ALL TO swarm_command
  USING (true) WITH CHECK (true);

REVOKE ALL ON TABLE swarm.signal_mentions FROM PUBLIC, anon, authenticated, swarm_read;
GRANT SELECT, INSERT ON TABLE swarm.signal_mentions TO swarm_command;

COMMENT ON TABLE swarm.signal_mentions IS
  'Who a public signal mentions, in order. A mention wakes a mentioned agent and never changes who '
  'can read the signal. Only a signal with no recipient and no in_reply_to can carry one.';

-- Written with its signal, and only on a signal the whole workspace can read.
CREATE FUNCTION swarm.require_public_new_signal_for_mention()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = swarm, pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM swarm.signals AS signal
    WHERE signal.id = NEW.signal_id
      AND signal.workspace_id = NEW.workspace_id
      AND signal.xmin::text::bigint =
        (pg_current_xact_id()::text::bigint & 4294967295)
  ) THEN
    RAISE EXCEPTION 'signal mentions can be inserted only with a new signal'
      USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM swarm.signals AS signal
    WHERE signal.id = NEW.signal_id
      AND signal.workspace_id = NEW.workspace_id
      AND signal.kind IN ('ask', 'note')
      AND signal.to_user_id IS NULL
      AND signal.to_agent_principal_id IS NULL
      AND signal.in_reply_to IS NULL
      AND signal.parent_signal_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM swarm.signal_recipients AS recipient
        WHERE recipient.signal_id = signal.id
          AND recipient.workspace_id = signal.workspace_id
      )
  ) THEN
    RAISE EXCEPTION 'only a public note or ask can carry a mention'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION swarm.require_public_new_signal_for_mention() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.require_public_new_signal_for_mention() FROM PUBLIC;

CREATE TRIGGER signal_mentions_public_new_signal
  BEFORE INSERT ON swarm.signal_mentions
  FOR EACH ROW EXECUTE FUNCTION swarm.require_public_new_signal_for_mention();

CREATE TRIGGER signal_mentions_append_only
  BEFORE UPDATE OR DELETE ON swarm.signal_mentions
  FOR EACH ROW EXECUTE FUNCTION swarm.prevent_append_only_mutation();

-- The same check again at commit. A recipient row written after the mention, in the same
-- transaction, would make the message private with the mention still on it. The edge writes
-- recipients first and never both; this makes the rule the database's own without touching
-- swarm.signal_recipients.
CREATE CONSTRAINT TRIGGER signal_mentions_public_at_commit
  AFTER INSERT ON swarm.signal_mentions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION swarm.require_public_new_signal_for_mention();

-- The shared wake predicate asked whether the agent's ORIGIN workspace is the signal's, so an agent
-- added to a second workspace (20261028000002) was never woken there, whether addressed or
-- mentioned. It now asks for a live principal with a live membership of the signal's workspace.
-- Same signature, owner and grants; both recipient triggers and the mention trigger read it.
CREATE OR REPLACE FUNCTION swarm.agent_delivery_is_wakeable(
  p_signal_id uuid,
  p_workspace_id uuid,
  p_agent_principal_id uuid
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM swarm.signals AS s
    JOIN swarm.agent_principals AS recipient
      ON recipient.principal_id = p_agent_principal_id
    JOIN swarm.agent_workspace_memberships AS seat
      ON seat.principal_id = recipient.principal_id
     AND seat.workspace_id = s.workspace_id
    WHERE s.id = p_signal_id
      AND s.workspace_id = p_workspace_id
      AND s.kind IN ('ask', 'note')
      AND s.until > statement_timestamp()
      AND recipient.revoked_at IS NULL
      AND seat.revoked_at IS NULL
  );
$$;

-- The wake. The same shared predicate as the two recipient triggers (20260905000020), so a dead
-- signal, a working-on signal and a revoked agent write no row here either. One difference: an
-- agent that mentions itself is not woken, so a mention cannot loop an agent on its own post. The
-- self-addressed wake test (a scalar self-note) goes through the recipient triggers and is
-- unchanged.
CREATE FUNCTION swarm.enqueue_mention_delivery()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.mentioned_agent_principal_id IS NOT NULL
     AND swarm.agent_delivery_is_wakeable(
       NEW.signal_id, NEW.workspace_id, NEW.mentioned_agent_principal_id
     )
     AND NOT EXISTS (
       SELECT 1 FROM swarm.signals AS s
       WHERE s.id = NEW.signal_id
         AND s.workspace_id = NEW.workspace_id
         AND s.from_kind = 'agent'
         AND s.from_principal = NEW.mentioned_agent_principal_id
     )
  THEN
    INSERT INTO swarm.signal_deliveries (
      signal_id,
      workspace_id,
      recipient_agent_principal_id
    ) VALUES (
      NEW.signal_id,
      NEW.workspace_id,
      NEW.mentioned_agent_principal_id
    )
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END;
$$;

ALTER FUNCTION swarm.enqueue_mention_delivery() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.enqueue_mention_delivery() FROM PUBLIC;

CREATE TRIGGER signal_mentions_enqueue_delivery
  AFTER INSERT ON swarm.signal_mentions
  FOR EACH ROW
  EXECUTE FUNCTION swarm.enqueue_mention_delivery();

-- Readback for members: typed ids, never re-parsed names. A mention sits only on a signal the whole
-- workspace reads, so membership is the whole predicate, as on swarm_read.channels.
CREATE VIEW swarm_read.signal_mentions
WITH (security_barrier = true)
AS
  SELECT
    m.signal_id,
    m.workspace_id,
    m.position,
    CASE WHEN m.mentioned_user_id IS NOT NULL THEN 'user' ELSE 'agent' END AS kind,
    COALESCE(m.mentioned_user_id, m.mentioned_agent_principal_id) AS id,
    m.source
  FROM swarm.signal_mentions AS m
  WHERE swarm.is_member(m.workspace_id, auth.uid());

ALTER VIEW swarm_read.signal_mentions OWNER TO swarm_admin;
GRANT SELECT ON swarm_read.signal_mentions TO authenticated, swarm_read;
REVOKE ALL ON swarm_read.signal_mentions FROM anon;

-- A hosted seat's check and its attachment list admit a message that mentions the seat's agent.
-- Same body as 20260928000004 with one more arm; the row still comes from swarm_read.signals, so
-- nothing the seat's owner cannot read is returned.
CREATE OR REPLACE FUNCTION swarm.hosted_mcp_check_visible_signals(
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
      OR EXISTS (
        SELECT 1 FROM swarm.signal_mentions AS mention
        WHERE mention.signal_id = s.id
          AND mention.workspace_id = s.workspace_id
          AND mention.mentioned_agent_principal_id = p_principal_id
      )
    )
    AND (p_signal_ids IS NULL OR s.id = ANY(p_signal_ids))
$fn$;

-- The batch a hosted check records is re-validated on insert. Same body as 20260928000004 with the
-- mention arm, so it accepts exactly what swarm.hosted_mcp_check_visible_signals selects.
CREATE OR REPLACE FUNCTION swarm.hosted_mcp_check_batches_guard()
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
        OR EXISTS (
          SELECT 1
          FROM swarm.signal_mentions AS mention
          WHERE mention.workspace_id = s.workspace_id
            AND mention.signal_id = s.id
            AND mention.mentioned_agent_principal_id = NEW.principal_id
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
