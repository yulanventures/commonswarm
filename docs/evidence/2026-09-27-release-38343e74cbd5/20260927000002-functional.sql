-- Read-only section-6 proof. It runs only after the new command edge has
-- recorded a route for the dedicated seat. It NEVER runs in section 5's
-- automatic functional-proof step.
\if :{?item_g3d_principal_id}
\else
DO $$ BEGIN RAISE EXCEPTION 'item_g3d_principal_id is required'; END $$;
\endif
\if :{?item_g3d_workspace_id}
\else
DO $$ BEGIN RAISE EXCEPTION 'item_g3d_workspace_id is required'; END $$;
\endif
SELECT set_config('item_g3d.principal_id', :'item_g3d_principal_id', false) AS principal_setting
\gset
SELECT set_config('item_g3d.workspace_id', :'item_g3d_workspace_id', false) AS workspace_setting
\gset
SELECT EXISTS (
  SELECT 1
  FROM swarm.agent_presence
  WHERE workspace_id = current_setting('item_g3d.workspace_id')::uuid
    AND principal_id = current_setting('item_g3d.principal_id')::uuid
    AND (
      watcher_at BETWEEN clock_timestamp() - interval '3 minutes' AND clock_timestamp()
      OR channel_at BETWEEN clock_timestamp() - interval '3 minutes' AND clock_timestamp()
      OR listener_at BETWEEN clock_timestamp() - interval '3 minutes' AND clock_timestamp()
      OR turn_at BETWEEN clock_timestamp() - interval '3 minutes' AND clock_timestamp()
    )
) AS functional_ok
\gset
\if :functional_ok
  \echo t
\else
DO $$ BEGIN RAISE EXCEPTION 'dedicated seat has no presence route within three minutes'; END $$;
\endif
