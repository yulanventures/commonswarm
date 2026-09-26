-- Read-only post-edge-switch proof. The release operator creates a dedicated
-- root -> hop 1 -> hop 2 chain through the new command edge and supplies the
-- exact ids below. Session-level settings and no outer transaction match the
-- production invocation in RELEASE-TO-BOX.md.
\if :{?item_t3_workspace_id}
\else
DO $$ BEGIN RAISE EXCEPTION 'item_t3_workspace_id is required'; END $$;
\endif
\if :{?item_t3_root_signal_id}
\else
DO $$ BEGIN RAISE EXCEPTION 'item_t3_root_signal_id is required'; END $$;
\endif
\if :{?item_t3_hop1_signal_id}
\else
DO $$ BEGIN RAISE EXCEPTION 'item_t3_hop1_signal_id is required'; END $$;
\endif
\if :{?item_t3_hop2_signal_id}
\else
DO $$ BEGIN RAISE EXCEPTION 'item_t3_hop2_signal_id is required'; END $$;
\endif
\if :{?item_t3_reader_user_id}
\else
DO $$ BEGIN RAISE EXCEPTION 'item_t3_reader_user_id is required'; END $$;
\endif

SELECT set_config('item_t3.workspace_id', :'item_t3_workspace_id', false) AS workspace_setting
\gset
SELECT set_config('item_t3.root_signal_id', :'item_t3_root_signal_id', false) AS root_setting
\gset
SELECT set_config('item_t3.hop1_signal_id', :'item_t3_hop1_signal_id', false) AS hop1_setting
\gset
SELECT set_config('item_t3.hop2_signal_id', :'item_t3_hop2_signal_id', false) AS hop2_setting
\gset
SELECT set_config(
  'request.jwt.claims',
  jsonb_build_object('sub', :'item_t3_reader_user_id')::text,
  false
) AS claims_setting
\gset

SELECT
  (SELECT count(*) = 3
   FROM swarm.signals AS s
   WHERE s.workspace_id = current_setting('item_t3.workspace_id')::uuid
     AND s.id = ANY (ARRAY[
       current_setting('item_t3.root_signal_id')::uuid,
       current_setting('item_t3.hop1_signal_id')::uuid,
       current_setting('item_t3.hop2_signal_id')::uuid
     ])
     AND s.kind = 'ask')
  AND EXISTS (
    SELECT 1 FROM swarm.signals AS root
    WHERE root.id = current_setting('item_t3.root_signal_id')::uuid
      AND root.workspace_id = current_setting('item_t3.workspace_id')::uuid
      AND root.parent_signal_id IS NULL
      AND root.chain_root_id = root.id
      AND root.chain_hop = 0
      AND cardinality(root.chain_participants) >= 2
  )
  AND EXISTS (
    SELECT 1 FROM swarm.signals AS child
    WHERE child.id = current_setting('item_t3.hop1_signal_id')::uuid
      AND child.workspace_id = current_setting('item_t3.workspace_id')::uuid
      AND child.parent_signal_id = current_setting('item_t3.root_signal_id')::uuid
      AND child.chain_root_id = current_setting('item_t3.root_signal_id')::uuid
      AND child.chain_hop = 1
  )
  AND EXISTS (
    SELECT 1 FROM swarm.signals AS child
    WHERE child.id = current_setting('item_t3.hop2_signal_id')::uuid
      AND child.workspace_id = current_setting('item_t3.workspace_id')::uuid
      AND child.parent_signal_id = current_setting('item_t3.hop1_signal_id')::uuid
      AND child.chain_root_id = current_setting('item_t3.root_signal_id')::uuid
      AND child.chain_hop = 2
  )
  AND (SELECT array_agg(v.chain_hop ORDER BY v.chain_hop) = ARRAY[0, 1, 2]::smallint[]
       FROM swarm_read.signals AS v
       WHERE v.workspace_id = current_setting('item_t3.workspace_id')::uuid
         AND v.id = ANY (ARRAY[
           current_setting('item_t3.root_signal_id')::uuid,
           current_setting('item_t3.hop1_signal_id')::uuid,
           current_setting('item_t3.hop2_signal_id')::uuid
         ]))
  AS functional_ok
\gset
\if :functional_ok
\echo t
\else
DO $$ BEGIN RAISE EXCEPTION 'ask-chain functional proof FAILED'; END $$;
\endif
