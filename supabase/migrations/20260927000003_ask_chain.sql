-- T3 ask-chain limits. The edge computes these immutable values in the same
-- INSERT ... SELECT that validates a declared parent. Existing asks remain
-- NULL and are treated by the edge as legacy roots when named as a parent.

ALTER TABLE swarm.signals
  ADD COLUMN parent_signal_id uuid,
  ADD COLUMN chain_root_id uuid,
  ADD COLUMN chain_hop smallint,
  ADD COLUMN chain_participants uuid[],
  ADD CONSTRAINT signals_chain_parent_ask CHECK (
    parent_signal_id IS NULL OR kind = 'ask'
  ),
  ADD CONSTRAINT signals_chain_columns_together CHECK (
    (chain_root_id IS NULL AND chain_hop IS NULL AND chain_participants IS NULL)
    OR
    (kind = 'ask' AND chain_root_id IS NOT NULL
      AND chain_hop IS NOT NULL AND chain_hop >= 0
      AND chain_participants IS NOT NULL)
  ),
  ADD CONSTRAINT signals_chain_parent_workspace
    FOREIGN KEY (parent_signal_id, workspace_id)
    REFERENCES swarm.signals (id, workspace_id);

CREATE INDEX signals_chain_parent_children
  ON swarm.signals (workspace_id, parent_signal_id, id)
  WHERE parent_signal_id IS NOT NULL;

COMMENT ON COLUMN swarm.signals.parent_signal_id IS
  'Declared ask being handled. Same-workspace, immutable, and never exposed by a read surface.';
COMMENT ON COLUMN swarm.signals.chain_root_id IS
  'Internal root ask id computed at insert. Never exposed by a read surface.';
COMMENT ON COLUMN swarm.signals.chain_hop IS
  'Number of declared ask-to-ask edges from the chain root. The only chain field exposed to readers.';
COMMENT ON COLUMN swarm.signals.chain_participants IS
  'Deduplicated agent principals already in the declared ask chain. Internal and never exposed.';

-- Preserve the CURRENT explicit projection and every authorization clause.
-- Only chain_hop crosses the read boundary; parent, root and participants do
-- not appear in the recreated view.
SELECT set_config(
  'swarm.signals_view_before',
  pg_get_viewdef('swarm_read.signals'::regclass, true),
  false
);

DO $$
DECLARE
  live_def text := current_setting('swarm.signals_view_before');
  body text;
BEGIN
  IF live_def !~ '\sFROM\s+(swarm\.)?signals\s' THEN
    RAISE EXCEPTION 'could not locate the swarm_read.signals select-list boundary';
  END IF;
  IF position('chain_hop' IN live_def) > 0 THEN
    RAISE EXCEPTION 'swarm_read.signals already carries chain_hop';
  END IF;
  body := regexp_replace(
    live_def,
    '(\s)(FROM\s+(?:swarm\.)?signals\s)',
    E',\n    s.chain_hop\\1\\2'
  );
  body := rtrim(body, E' ;\n\t');
  EXECUTE 'CREATE OR REPLACE VIEW swarm_read.signals WITH (security_barrier = true) AS ' || body;
END;
$$;

ALTER VIEW swarm_read.signals OWNER TO swarm_admin;
GRANT SELECT ON swarm_read.signals TO authenticated, swarm_read;
REVOKE ALL ON swarm_read.signals FROM anon;
SELECT swarm.assert_view_clauses_preserved(
  'swarm_read.signals', current_setting('swarm.signals_view_before')
);
SELECT set_config('swarm.signals_view_before', '', false);

DO $$
DECLARE
  after_def text := pg_get_viewdef('swarm_read.signals'::regclass, true);
BEGIN
  IF position('chain_hop' IN after_def) = 0 THEN
    RAISE EXCEPTION 'swarm_read.signals recreation did not add chain_hop';
  END IF;
  IF position('parent_signal_id' IN after_def) > 0
     OR position('chain_root_id' IN after_def) > 0
     OR position('chain_participants' IN after_def) > 0 THEN
    RAISE EXCEPTION 'swarm_read.signals exposed internal ask-chain columns';
  END IF;
END;
$$;
