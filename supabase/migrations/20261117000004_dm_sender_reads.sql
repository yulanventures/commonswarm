-- The author of a direct message can read it.
--
-- A direct message is an ordinary swarm.signals row with to_user_id or to_agent_principal_id set
-- (and further recipients in swarm.signal_recipients). swarm_read.signals admitted a workspace
-- member to a row only when it was a broadcast, addressed to them, or addressed to an agent they
-- own. Nothing admitted the row's own author, so:
--
--   * a person who sent a direct message to another person could not read it back. The web app
--     showed only the copy it kept in memory after posting, and lost it on reload.
--   * an agent could not read its own message to a person or to another agent, because the read
--     edge narrows the owner's view to broadcasts and rows addressed to the agent.
--
-- 20260905000002 listed the marker 'from_principal = auth.uid()' for this arm ("the DM phase adds
-- it"); the arm never shipped. It ships here as a function rather than that inline equality:
-- auth.uid() is the owner's id under an agent's claims too, so an inline arm would show an agent
-- every message its owner sent to other people.
--
-- The predicate change: one disjunct, swarm.claims_is_signal_sender(s.workspace_id, s.from_kind,
-- s.from_principal), joins the scalar-recipient test s.to_user_id = auth.uid() inside the first
-- addressed OR group. The is_member wall that group sits under, and the private-channel gate
-- (s.channel_id IS NULL OR swarm.claims_can_access_channel(...)) that ANDs over the whole
-- predicate, both still apply to it. It widens visibility to the message's own author and to
-- nobody else:
--
--   * person claims (no agent_principal_id): rows the person wrote (from_kind 'user').
--   * agent claims (sub = owner plus agent_principal_id): rows that agent wrote (from_kind
--     'agent'), while the agent is not revoked. Never the owner's own rows.
--   * an owner does not read what their agent sent to someone else. There is no owner-of-sender
--     arm; oversight stays with what is addressed to the owner's agents.
--   * an author removed from the workspace, or who left the private channel a message is filed
--     in, stops reading it, as every other reader does.
--
-- The agent's other gates are where they were: the read edge admits an agent only to a workspace
-- it has a live membership in, and narrows its reads to broadcasts, rows addressed to it and now
-- its own rows (never its inbox or check).
--
-- Rollback, in this order: recreate swarm.assert_view_clauses_preserved from
-- 20261113000003_private_channels.sql (407-437), so the new marker does not refuse the next step;
-- recreate swarm_read.signals from pg_get_viewdef with the disjunct removed (replace
-- '(<scalar test> OR swarm.claims_is_signal_sender(s.workspace_id, s.from_kind, s.from_principal))'
-- with the scalar test), keeping owner, security_barrier and grants; then
-- DROP FUNCTION swarm.claims_is_signal_sender(uuid, text, uuid). Roll the read edge back with the
-- view: its own-message arm reads nothing once the view stops admitting the row.

-- 1. The test, from the request's claims, as swarm.claims_can_access_channel reads them. A view
-- that named swarm.agent_principals here would add a third agent_principals reference that the
-- 20261116000005 invariants count, and the check needs the claims anyway.
--
-- CRITICAL: an agent's claims carry its owner's sub, so agent_principal_id is checked first and
-- never falls back to sub. Without it the owner's own person-sent messages would read as the
-- agent's.
CREATE OR REPLACE FUNCTION swarm.claims_is_signal_sender(
  p_workspace_id uuid,
  p_from_kind text,
  p_from_principal uuid
) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog AS $$
DECLARE
  claims jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  v_user uuid;
  v_agent uuid;
BEGIN
  IF p_workspace_id IS NULL OR p_from_kind IS NULL OR p_from_principal IS NULL OR claims IS NULL
    OR (claims ? 'role' AND claims->>'role' IS DISTINCT FROM 'authenticated')
    OR coalesce(claims->>'sub', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN false;
  END IF;
  v_user := (claims->>'sub')::uuid;
  -- The cheap comparisons come first: the view asks this for every row the other arms left out.
  IF claims ? 'agent_principal_id' THEN
    IF coalesce(claims->>'agent_principal_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RETURN false;
    END IF;
    v_agent := (claims->>'agent_principal_id')::uuid;
    IF p_from_kind IS DISTINCT FROM 'agent' OR p_from_principal IS DISTINCT FROM v_agent THEN
      RETURN false;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM swarm.agent_principals AS p
      WHERE p.principal_id = v_agent AND p.owner_user_id = v_user AND p.revoked_at IS NULL
    ) THEN
      RETURN false;
    END IF;
  ELSIF p_from_kind IS DISTINCT FROM 'user' OR p_from_principal IS DISTINCT FROM v_user THEN
    RETURN false;
  END IF;
  RETURN swarm.is_member(p_workspace_id, v_user);
END;
$$;

ALTER FUNCTION swarm.claims_is_signal_sender(uuid, text, uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.claims_is_signal_sender(uuid, text, uuid)
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT EXECUTE ON FUNCTION swarm.claims_is_signal_sender(uuid, text, uuid)
  TO authenticated, swarm_read;

-- 2. Register the new arm as a marker before the recreation, as 20261113000003 did for
-- claims_can_access_channel, so a later recreation that drops it fails. 'from_principal =
-- auth.uid()' stays listed but can never fire: the author arm is a function call, so no version of
-- the view carries that fragment. claims_is_signal_sender is the marker that guards it.
CREATE OR REPLACE FUNCTION swarm.assert_view_clauses_preserved(
  p_view text,
  p_before text
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  after_def text;
  marker text;
  markers text[] := ARRAY[
    'is_member',
    'to_user_id = auth.uid()',
    'to_agent_principal_id IS NULL',
    'owner_user_id = auth.uid()',
    'recipient_user_id = auth.uid()',
    'from_principal = auth.uid()',
    'claims_can_access_channel',
    'claims_is_signal_sender'
  ];
BEGIN
  after_def := pg_get_viewdef(p_view::regclass, true);
  FOREACH marker IN ARRAY markers LOOP
    IF position(marker IN p_before) > 0 AND position(marker IN after_def) = 0 THEN
      RAISE EXCEPTION
        'view % lost the authorization fragment "%" during recreation; resolve the starting body with pg_get_viewdef against this database, not from a migration file',
        p_view, marker;
    END IF;
  END LOOP;
END;
$$;
ALTER FUNCTION swarm.assert_view_clauses_preserved(text, text) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.assert_view_clauses_preserved(text, text) FROM PUBLIC;

-- 3. The view, spliced from the live definition as every recreation since 20260905000002.
SELECT set_config(
  'swarm.signals_view_before',
  pg_get_viewdef('swarm_read.signals'::regclass, true),
  false
);

DO $$
DECLARE
  live_def text := current_setting('swarm.signals_view_before');
  -- The scalar-recipient test of the first addressed group (20260724000003), as pg_get_viewdef
  -- renders it. Replacing that one comparison with (it OR the author test) puts the new disjunct
  -- beside it, under the same is_member wall and the same outer private-channel gate, whatever
  -- parentheses the rendering keeps around the group.
  scalar_arm constant text := '\m(?:s\.)?to_user_id\s*=\s*auth\.uid\(\)';
  body text;
BEGIN
  IF position('claims_is_signal_sender' IN live_def) > 0 THEN
    RAISE EXCEPTION 'swarm_read.signals already admits a message''s author';
  END IF;
  IF position('claims_can_access_channel' IN live_def) = 0 THEN
    RAISE EXCEPTION 'swarm_read.signals has no private-channel gate to put the author arm under';
  END IF;
  IF (SELECT count(*) FROM regexp_matches(live_def, scalar_arm, 'g')) <> 1 THEN
    RAISE EXCEPTION 'expected exactly one scalar-recipient test in swarm_read.signals; recreate it by hand';
  END IF;

  body := regexp_replace(live_def, '(' || scalar_arm || ')',
    '(\1 OR swarm.claims_is_signal_sender(s.workspace_id, s.from_kind, s.from_principal))');
  body := rtrim(body, E' ;\n\t');

  EXECUTE 'CREATE OR REPLACE VIEW swarm_read.signals WITH (security_barrier = true) AS ' || body;
END;
$$;

ALTER VIEW swarm_read.signals OWNER TO swarm_admin;
GRANT SELECT ON swarm_read.signals TO authenticated, swarm_read;
REVOKE ALL ON swarm_read.signals FROM PUBLIC, anon;

SELECT swarm.assert_view_clauses_preserved(
  'swarm_read.signals',
  current_setting('swarm.signals_view_before')
);
SELECT set_config('swarm.signals_view_before', '', false);

-- Positive control: the author arm is present once, beside the scalar test it was spliced to, and
-- every invariant 20261116000005 left for the next splice still holds. pg_get_viewdef(..., true)
-- prints this single-relation view's columns without the s. prefix (WHERE swarm.is_member(workspace_id,
-- auth.uid()) ...), so every pattern here takes the prefix as optional, as scalar_arm does.
DO $$
DECLARE
  after_def text := pg_get_viewdef('swarm_read.signals'::regclass, true);
BEGIN
  IF (SELECT count(*) FROM regexp_matches(after_def,
        'claims_is_signal_sender\((?:s\.)?workspace_id,\s*(?:s\.)?from_kind,\s*(?:s\.)?from_principal\)', 'g')) <> 1
     OR (SELECT count(*) FROM regexp_matches(after_def, 'claims_is_signal_sender', 'g')) <> 1 THEN
    RAISE EXCEPTION 'swarm_read.signals: expected one author arm';
  END IF;
  IF after_def !~ 'to_user_id\s*=\s*auth\.uid\(\)\s+OR\s+(swarm\.)?claims_is_signal_sender\(' THEN
    RAISE EXCEPTION 'swarm_read.signals: the author arm is not beside the scalar-recipient test';
  END IF;
  IF position('claims_can_access_channel' IN after_def) = 0 THEN
    RAISE EXCEPTION 'swarm_read.signals lost its private-channel gate';
  END IF;
  IF (SELECT count(*) FROM regexp_matches(after_def, 'agent_has_workspace_membership', 'g')) <> 2
     OR (SELECT count(*) FROM regexp_matches(after_def, '\magent_principals\M', 'g')) <> 2 THEN
    RAISE EXCEPTION 'swarm_read.signals: expected two agent arms, each with its membership';
  END IF;
  IF position('agent_workspace_memberships' IN after_def) > 0 THEN
    RAISE EXCEPTION 'swarm_read.signals names swarm.agent_workspace_memberships; the 20261028000001 rollback could not drop it';
  END IF;
  IF (SELECT count(*) FROM regexp_matches(after_def, '\sFROM\s+(swarm\.)?signals\s', 'g')) <> 1 THEN
    RAISE EXCEPTION
      'swarm_read.signals now has more than one FROM swarm.signals boundary; the next migration cannot splice it';
  END IF;
END;
$$;
