-- C6 ("Nothing lapses") + Waiting on you Archived view (3c459c72):
--
-- Part 1 (C6 — Permanence for asks and notes):
--   Notes and asks are permanent by default (sentinel '9999-12-31T23:59:59Z'::timestamptz) so
--   older threads never lock and unanswered asks never silently lapse out of Waiting on you.
--   Only working-on signals keep an expiry ceiling (<= 30 days from created_at). Explicit
--   short horizons (<= 30 days) on asks and notes remain allowed.
--   Current active ask and note rows are backfilled so nothing in flight lapses.
--
-- Part 2 (3c459c72 — Waiting on you Archived view):
--   Read-only, keyset-paginated RPC returning the signed-in person's resolved Waiting on you items
--   in one workspace (newest first):
--     1. Answered asks (choice asks with resolved option labels / Other text, survey answers, and
--        plain-text asks answered inline or cleared as stale), gated whole-row by swarm_read.signals
--        and canonical live conversation membership/audience matching swarm_read.decision_queue_page.
--     2. Completed or dropped to-dos (state IN ('done', 'dropped')) assigned to the viewer or
--        resolved by the viewer for their own seated agent, gated by swarm.household_human_can_read
--        with private-channel and direct-conversation origin redaction matching waiting_todos_page.
--     3. Answered work-request reviews (TodoOfferAnswered accept/decline where the viewer was the
--        offer decider), gated by swarm.household_human_can_read with identical origin redaction.
--
-- People only: EXECUTE granted exclusively to authenticated; agent claims and non-members return NULL.

-- ---------------------------------------------------------------------------
-- Part 1: C6 signal permanence (notes & asks permanent by default; working-on keeps expiry)
-- ---------------------------------------------------------------------------

ALTER TABLE swarm.signals DROP CONSTRAINT IF EXISTS signals_check1;

ALTER TABLE swarm.signals ADD CONSTRAINT signals_until_bound CHECK (
  (kind = 'working-on' AND until <= created_at + interval '30 days')
  OR (
    kind IN ('ask', 'note')
    AND (
      until <= created_at + interval '30 days'
      OR until = '9999-12-31T23:59:59Z'::timestamptz
    )
  )
);

-- Backfill currently active ask and note rows so nothing in flight lapses.
-- Historical already-expired signals stay expired; working-on signals keep their expiry;
-- thread replies whose root is a working-on signal keep their root-clamped expiry.
ALTER TABLE swarm.signals DISABLE TRIGGER signals_append_only;

UPDATE swarm.signals AS s
SET until = '9999-12-31T23:59:59Z'::timestamptz
WHERE s.kind IN ('ask', 'note')
  AND s.until > statement_timestamp()
  AND s.until < '9999-12-31T23:59:59Z'::timestamptz
  AND (
    s.thread_root_id IS NULL
    OR EXISTS (
      SELECT 1
      FROM swarm.signals AS root
      WHERE root.id = s.thread_root_id
        AND root.workspace_id = s.workspace_id
        AND root.kind IN ('ask', 'note')
        AND root.until > statement_timestamp()
    )
  );

ALTER TABLE swarm.signals ENABLE TRIGGER signals_append_only;

-- ---------------------------------------------------------------------------
-- Part 2: Waiting on you Archived read model
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS household_todos_archived_person
 ON swarm.household_todos (workspace_id, state_at DESC, todo_id ASC)
 WHERE state IN ('done', 'dropped');

CREATE INDEX IF NOT EXISTS household_todo_events_offer_answered
 ON swarm.household_todo_events (workspace_id, occurred_at DESC, event_id ASC)
 WHERE event->>'type' = 'TodoOfferAnswered';

CREATE OR REPLACE FUNCTION swarm_read.waiting_archived_page(
 p_workspace_id uuid,
 p_limit integer DEFAULT 30,
 p_after_archived_at timestamptz DEFAULT NULL,
 p_after_item_key text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = '' AS $$
DECLARE
 claims jsonb := nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb;
 viewer uuid;
 read_at timestamptz := pg_catalog.statement_timestamp();
 can_read_todos boolean;
 page_limit integer;
 after_key text;
 total integer;
 has_more boolean;
 rows jsonb;
BEGIN
 -- A person's own session only. Reject agent claims and invalid sub UUIDs.
 IF claims IS NULL OR claims->>'role' IS DISTINCT FROM 'authenticated' OR claims ? 'agent_principal_id'
  OR coalesce(claims->>'sub', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
  RETURN NULL;
 END IF;
 viewer := (claims->>'sub')::uuid;

 IF p_workspace_id IS NULL OR NOT swarm.is_member(p_workspace_id, viewer) THEN
  RETURN NULL;
 END IF;

 IF (p_after_archived_at IS NULL) <> (p_after_item_key IS NULL) THEN
  RAISE EXCEPTION 'waiting_archived_page cursor requires both p_after_archived_at and p_after_item_key'
   USING ERRCODE = '22023';
 END IF;
 IF p_after_item_key IS NOT NULL
  AND p_after_item_key !~* '^(ask|todo|review):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
  RAISE EXCEPTION 'waiting_archived_page cursor item_key invalid' USING ERRCODE = '22023';
 END IF;
 after_key := pg_catalog.lower(p_after_item_key);

 can_read_todos := swarm.household_human_can_read(p_workspace_id, viewer);
 page_limit := greatest(1, least(coalesce(p_limit, 30), 100));

 WITH archived_asks AS (
  SELECT
   'ask:' || s.id::text AS item_key,
   'ask'::text AS kind,
   s.id AS id,
   NULL::uuid AS todo_id,
   CASE WHEN ac.signal_id IS NOT NULL THEN 'choice' ELSE 'plain' END AS ask_kind,
   pg_catalog.left(s.body, 4000) AS title,
   s.from_kind AS from_kind,
   s."from" AS from_id,
   CASE
    WHEN act.action_id IS NOT NULL THEN 'answered'
    WHEN rep.body = 'Closed as stale. Re-ask with choices if still needed.' THEN 'cleared_stale'
    ELSE 'answered'
   END AS outcome_kind,
   CASE
    WHEN act.action_id IS NOT NULL THEN pg_catalog.left(coalesce(nullif(choice_fmt.label_text, ''), nullif(rep.body, ''), 'Answered'), 500)
    WHEN rep.body = 'Closed as stale. Re-ask with choices if still needed.' THEN 'Cleared as stale'
    ELSE pg_catalog.left(rep.body, 500)
   END AS outcome_text,
   coalesce(act.completed_at, rep.created_at) AS archived_at,
   CASE WHEN act.action_id IS NOT NULL THEN 'user' ELSE rep.from_kind END AS answered_by_kind,
   CASE WHEN act.action_id IS NOT NULL THEN act.actor_user_id ELSE rep.from_principal END AS answered_by_id,
   place.placement AS placement,
   place.channel_id AS channel_id,
   place.conversation_id AS conversation_id,
   place.conversation_kind AS conversation_kind
  FROM swarm_read.signals s
  LEFT JOIN swarm.ask_choices ac
   ON ac.workspace_id = p_workspace_id AND ac.signal_id = s.id
  LEFT JOIN swarm.conversation_signals cs
   ON cs.workspace_id = p_workspace_id AND cs.signal_id = s.id
  LEFT JOIN swarm.conversations raw_c
   ON raw_c.workspace_id = p_workspace_id AND raw_c.conversation_id = cs.conversation_id
  LEFT JOIN swarm.conversation_members viewer_cm
   ON raw_c.kind IN ('dm', 'group_dm')
   AND viewer_cm.workspace_id = raw_c.workspace_id
   AND viewer_cm.conversation_id = raw_c.conversation_id
   AND viewer_cm.member_user_id = viewer
  LEFT JOIN LATERAL (
   SELECT a.action_id, a.actor_user_id, a.option_id, a.option_ids, a.other_text, a.reply_signal_id, a.completed_at
   FROM swarm.ui_actions a
   WHERE a.workspace_id = p_workspace_id
    AND a.signal_id = s.id
    AND a.state = 'completed'
    AND (
     a.actor_user_id = viewer
     OR EXISTS (SELECT 1 FROM swarm_read.signals vr WHERE vr.workspace_id = p_workspace_id AND vr.id = a.reply_signal_id)
    )
   LIMIT 1
  ) act ON true
  LEFT JOIN LATERAL (
   SELECT reply.id, reply.from_kind, reply.from_principal, reply.body, reply.created_at
   FROM swarm.signals reply
   WHERE reply.workspace_id = s.workspace_id
    AND reply.in_reply_to = s.id
    AND NOT (reply.from_kind = s.from_kind AND reply.from_principal = s."from")
    AND (
     (reply.from_kind = 'user' AND (
      reply.from_principal = s."to"
      OR EXISTS (
       SELECT 1 FROM swarm.signal_recipients ar
       WHERE ar.workspace_id = s.workspace_id AND ar.signal_id = s.id AND ar.recipient_user_id = reply.from_principal
      )
     ))
     OR (reply.from_kind = 'agent' AND EXISTS (
      SELECT 1
      FROM swarm.agent_principals rp
      JOIN swarm.agent_workspace_memberships ram USING (principal_id, owner_user_id)
      WHERE rp.principal_id = reply.from_principal
       AND ram.workspace_id = s.workspace_id
       AND (
        rp.owner_user_id = s."to"
        OR EXISTS (
         SELECT 1 FROM swarm.signal_recipients ar
         WHERE ar.workspace_id = s.workspace_id AND ar.signal_id = s.id AND ar.recipient_user_id = rp.owner_user_id
        )
       )
     ))
    )
    AND (
     (reply.from_kind = 'user' AND reply.from_principal = viewer)
     OR EXISTS (SELECT 1 FROM swarm_read.signals vr WHERE vr.workspace_id = p_workspace_id AND vr.id = reply.id)
    )
   ORDER BY reply.created_at ASC, reply.id ASC
   LIMIT 1
  ) rep ON true
  LEFT JOIN LATERAL (
   SELECT
    CASE
     WHEN act.action_id IS NULL THEN NULL
     ELSE pg_catalog.concat_ws(
      ' · ',
      nullif((
       SELECT pg_catalog.string_agg(opt->>'label', ', ' ORDER BY sel.ord)
       FROM pg_catalog.unnest(coalesce(act.option_ids, ARRAY[act.option_id])) WITH ORDINALITY AS sel(oid, ord)
       JOIN LATERAL (
        SELECT elem
        FROM pg_catalog.jsonb_array_elements(coalesce(ac.options, '[]'::jsonb)) AS elem
        WHERE elem->>'id' = sel.oid
        LIMIT 1
       ) matched ON sel.oid <> 'other'
       CROSS JOIN LATERAL (SELECT matched.elem AS opt) o
      ), ''),
      nullif(act.other_text, '')
     )
    END AS label_text
  ) choice_fmt ON true
  CROSS JOIN LATERAL (
   SELECT
    CASE
     WHEN raw_c.conversation_id IS NOT NULL AND raw_c.kind IN ('public_channel', 'private_channel') THEN 'channel'
     WHEN raw_c.conversation_id IS NOT NULL THEN raw_c.kind
     WHEN s.channel_id IS NOT NULL AND swarm.claims_can_access_channel(p_workspace_id, s.channel_id) THEN 'channel'
     ELSE 'redacted'
    END AS placement,
    CASE
     WHEN raw_c.conversation_id IS NOT NULL AND raw_c.kind IN ('public_channel', 'private_channel') THEN raw_c.channel_id
     WHEN raw_c.conversation_id IS NULL AND s.channel_id IS NOT NULL AND swarm.claims_can_access_channel(p_workspace_id, s.channel_id) THEN s.channel_id
     ELSE NULL
    END AS channel_id,
    CASE WHEN raw_c.conversation_id IS NOT NULL THEN raw_c.conversation_id ELSE NULL END AS conversation_id,
    CASE WHEN raw_c.conversation_id IS NOT NULL THEN raw_c.kind ELSE NULL END AS conversation_kind
  ) place
  WHERE s.workspace_id = p_workspace_id
   AND s.kind = 'ask'
   AND (
    s."to" = viewer
    OR EXISTS (
     SELECT 1 FROM swarm.signal_recipients r
     WHERE r.workspace_id = s.workspace_id AND r.signal_id = s.id AND r.recipient_user_id = viewer
    )
   )
   -- Whole-row canonical membership and audience gate matching decision_queue / decision_queue_page:
   -- a departed DM/group_dm member or unauthorized private-channel reader gets nothing (zero body/count/cursor).
   AND (
    raw_c.conversation_id IS NULL
    OR raw_c.kind IN ('general', 'public_channel')
    OR (
     raw_c.kind = 'private_channel'
     AND swarm.claims_can_access_channel(p_workspace_id, raw_c.channel_id)
    )
    OR (
     raw_c.kind IN ('dm', 'group_dm')
     AND viewer_cm.member_user_id IS NOT NULL
     AND viewer_cm.left_at IS NULL
     AND swarm.conversation_signal_visible_to(
      cs.workspace_id, cs.signal_id, cs.audience,
      s.from_kind, s."from", s."to", s.to_agent,
      'user', viewer
     )
    )
   )
   AND (act.action_id IS NOT NULL OR rep.id IS NOT NULL)
 ),
 archived_todos AS (
  SELECT
   'todo:' || t.todo_id::text AS item_key,
   'todo'::text AS kind,
   t.todo_id AS id,
   t.todo_id AS todo_id,
   NULL::text AS ask_kind,
   t.title AS title,
   CASE WHEN t.created_by_principal IS NOT NULL THEN 'agent' ELSE 'user' END AS from_kind,
   coalesce(t.created_by_principal, t.created_by_user) AS from_id,
   t.state AS outcome_kind,
   CASE t.state WHEN 'done' THEN 'Done' ELSE 'Dropped' END AS outcome_text,
   t.state_at AS archived_at,
   CASE WHEN t.state_by_principal IS NOT NULL THEN 'agent' ELSE 'user' END AS answered_by_kind,
   coalesce(t.state_by_principal, t.state_by_user) AS answered_by_id,
   vis.placement AS placement,
   vis.channel_id AS channel_id,
   vis.conversation_id AS conversation_id,
   vis.conversation_kind AS conversation_kind
  FROM swarm.household_todos t
  LEFT JOIN swarm.agent_workspace_memberships seat
   ON seat.principal_id = t.assignee_principal
   AND seat.workspace_id = t.workspace_id
   AND seat.owner_user_id = viewer
  CROSS JOIN LATERAL (
   SELECT
    (t.origin_placement = 'channel'
     AND t.origin_channel_id IS NOT NULL
     AND swarm.claims_can_access_channel(p_workspace_id, t.origin_channel_id)) AS can_channel,
    (t.origin_placement IN ('dm', 'group_dm')
     AND t.origin_conversation_id IS NOT NULL
     AND swarm.actor_can_access_direct_conversation(p_workspace_id, t.origin_conversation_id, t.origin_placement, 'user', viewer)) AS can_direct
  ) access
  CROSS JOIN LATERAL (
   SELECT
    CASE
     WHEN access.can_channel THEN 'channel'
     WHEN access.can_direct THEN t.origin_placement
     WHEN t.origin_placement = 'general' THEN 'general'
     ELSE 'workspace'
    END AS placement,
    CASE WHEN access.can_channel THEN t.origin_channel_id ELSE NULL END AS channel_id,
    CASE WHEN access.can_direct THEN t.origin_conversation_id ELSE NULL END AS conversation_id,
    CASE
     WHEN access.can_direct THEN t.origin_placement
     WHEN t.origin_placement = 'general' THEN 'general'
     ELSE NULL
    END AS conversation_kind
  ) vis
  WHERE can_read_todos
   AND t.workspace_id = p_workspace_id
   AND t.state IN ('done', 'dropped')
   AND (
    t.assignee_user = viewer
    OR (seat.principal_id IS NOT NULL AND t.state_by_user = viewer)
   )
 ),
 archived_reviews AS (
  SELECT
   'review:' || (ans.event->'payload'->>'offer_id') AS item_key,
   'review'::text AS kind,
   (ans.event->'payload'->>'offer_id')::uuid AS id,
   t.todo_id AS todo_id,
   NULL::text AS ask_kind,
   coalesce(t.title, pg_catalog.left(coalesce(ans.event->'payload'->'todo'->>'title', 'To-do request'), 240)) AS title,
   CASE
    WHEN nullif(off.event->'payload'->'todo'->'offer'->'by'->>'principal_id', '') IS NOT NULL THEN 'agent'
    WHEN nullif(off.event->'payload'->'todo'->'offer'->'by'->>'user_id', '') IS NOT NULL THEN 'user'
    ELSE NULL
   END AS from_kind,
   CASE
    WHEN nullif(off.event->'payload'->'todo'->'offer'->'by'->>'principal_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     THEN (off.event->'payload'->'todo'->'offer'->'by'->>'principal_id')::uuid
    WHEN nullif(off.event->'payload'->'todo'->'offer'->'by'->>'user_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     THEN (off.event->'payload'->'todo'->'offer'->'by'->>'user_id')::uuid
    ELSE NULL
   END AS from_id,
   CASE ans.event->'payload'->>'answer' WHEN 'accept' THEN 'accepted' ELSE 'declined' END AS outcome_kind,
   CASE ans.event->'payload'->>'answer' WHEN 'accept' THEN 'Accepted' ELSE 'Declined' END AS outcome_text,
   ans.occurred_at AS archived_at,
   CASE WHEN nullif(ans.event->>'actor_agent_principal', '') IS NOT NULL THEN 'agent' ELSE 'user' END AS answered_by_kind,
   CASE
    WHEN nullif(ans.event->>'actor_agent_principal', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     THEN (ans.event->>'actor_agent_principal')::uuid
    WHEN nullif(ans.event->>'actor_user', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     THEN (ans.event->>'actor_user')::uuid
    ELSE viewer
   END AS answered_by_id,
   vis.placement AS placement,
   vis.channel_id AS channel_id,
   vis.conversation_id AS conversation_id,
   vis.conversation_kind AS conversation_kind
  FROM swarm.household_todo_events ans
  JOIN LATERAL (
   SELECT e.event
   FROM swarm.household_todo_events e
   WHERE e.workspace_id = ans.workspace_id
    AND e.event->>'type' = 'TodoOffered'
    AND e.event->'payload'->'todo'->'offer'->>'offer_id' = ans.event->'payload'->>'offer_id'
    AND e.event->'payload'->'todo'->'offer'->>'decider_user_id' = viewer::text
   ORDER BY e.seq DESC
   LIMIT 1
  ) off ON true
  LEFT JOIN swarm.household_todos t
   ON t.workspace_id = ans.workspace_id
   AND coalesce(ans.event->'payload'->'todo'->>'todo_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   AND t.todo_id = (ans.event->'payload'->'todo'->>'todo_id')::uuid
  CROSS JOIN LATERAL (
   SELECT
    (t.origin_placement = 'channel'
     AND t.origin_channel_id IS NOT NULL
     AND swarm.claims_can_access_channel(p_workspace_id, t.origin_channel_id)) AS can_channel,
    (t.origin_placement IN ('dm', 'group_dm')
     AND t.origin_conversation_id IS NOT NULL
     AND swarm.actor_can_access_direct_conversation(p_workspace_id, t.origin_conversation_id, t.origin_placement, 'user', viewer)) AS can_direct
  ) access
  CROSS JOIN LATERAL (
   SELECT
    CASE
     WHEN access.can_channel THEN 'channel'
     WHEN access.can_direct THEN t.origin_placement
     WHEN t.origin_placement = 'general' THEN 'general'
     ELSE 'workspace'
    END AS placement,
    CASE WHEN access.can_channel THEN t.origin_channel_id ELSE NULL END AS channel_id,
    CASE WHEN access.can_direct THEN t.origin_conversation_id ELSE NULL END AS conversation_id,
    CASE
     WHEN access.can_direct THEN t.origin_placement
     WHEN t.origin_placement = 'general' THEN 'general'
     ELSE NULL
    END AS conversation_kind
  ) vis
  WHERE can_read_todos
   AND ans.workspace_id = p_workspace_id
   AND ans.event->>'type' = 'TodoOfferAnswered'
   AND ans.event->'payload'->>'answer' IN ('accept', 'decline')
   AND coalesce(ans.event->'payload'->>'offer_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 ),
 candidate_items AS MATERIALIZED (
  SELECT * FROM archived_asks
  UNION ALL
  SELECT * FROM archived_todos
  UNION ALL
  SELECT * FROM archived_reviews
 ),
 anchor AS (
  SELECT coalesce(
   (SELECT c.archived_at FROM candidate_items c WHERE c.item_key = after_key),
   p_after_archived_at
  ) AS archived_at
 ),
 page_probe AS MATERIALIZED (
  SELECT c.*
  FROM candidate_items c, anchor a
  WHERE after_key IS NULL
   OR c.archived_at < a.archived_at
   OR (c.archived_at = a.archived_at AND c.item_key > after_key)
  ORDER BY c.archived_at DESC, c.item_key ASC
  LIMIT page_limit + 1
 ),
 page AS (
  SELECT * FROM page_probe
  ORDER BY archived_at DESC, item_key ASC
  LIMIT page_limit
 )
 SELECT
  (SELECT pg_catalog.count(*) FROM candidate_items)::integer,
  (SELECT pg_catalog.count(*) > page_limit FROM page_probe),
  coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
   'item_key', p.item_key,
   'kind', p.kind,
   'id', p.id,
   'todo_id', p.todo_id,
   'ask_kind', p.ask_kind,
   'title', p.title,
   'from', CASE WHEN p.from_id IS NULL THEN NULL ELSE pg_catalog.jsonb_build_object(
    'kind', p.from_kind,
    'id', p.from_id,
    'name', CASE p.from_kind
     WHEN 'agent' THEN (SELECT a.name FROM swarm.agent_principals a WHERE a.principal_id = p.from_id)
     ELSE (SELECT u.display_name FROM swarm.users u WHERE u.user_id = p.from_id)
    END
   ) END,
   'outcome_kind', p.outcome_kind,
   'outcome_text', p.outcome_text,
   'archived_at', p.archived_at,
   'answered_by', CASE WHEN p.answered_by_id IS NULL THEN NULL ELSE pg_catalog.jsonb_build_object(
    'kind', p.answered_by_kind,
    'id', p.answered_by_id,
    'name', CASE p.answered_by_kind
     WHEN 'agent' THEN (SELECT a.name FROM swarm.agent_principals a WHERE a.principal_id = p.answered_by_id)
     ELSE (SELECT u.display_name FROM swarm.users u WHERE u.user_id = p.answered_by_id)
    END,
    'by_viewer', (p.answered_by_kind = 'user' AND p.answered_by_id = viewer)
   ) END,
   'placement', p.placement,
   'channel_id', p.channel_id,
   'conversation_id', p.conversation_id,
   'conversation_kind', p.conversation_kind
  ) ORDER BY p.archived_at DESC, p.item_key ASC), '[]'::jsonb)
 INTO total, has_more, rows
 FROM page p;

 RETURN pg_catalog.jsonb_build_object(
  'workspace_id', p_workspace_id,
  'generated_at', read_at,
  'untrusted_content', true,
  'total', coalesce(total, 0),
  'truncated', coalesce(has_more, false),
  'items', coalesce(rows, '[]'::jsonb)
 );
END;
$$;

ALTER FUNCTION swarm_read.waiting_archived_page(uuid, integer, timestamptz, text) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm_read.waiting_archived_page(uuid, integer, timestamptz, text)
 FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT EXECUTE ON FUNCTION swarm_read.waiting_archived_page(uuid, integer, timestamptz, text) TO authenticated;
