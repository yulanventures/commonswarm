-- Read-only proof. The release operator supplies one seeded human-authored
-- signal and one private reply to it after exercising the command edge.
\if :{?item_g3c_workspace_id}
\else
DO $$ BEGIN RAISE EXCEPTION 'item_g3c_workspace_id is required'; END $$;
\endif
\if :{?item_g3c_signal_id}
\else
DO $$ BEGIN RAISE EXCEPTION 'item_g3c_signal_id is required'; END $$;
\endif
\if :{?item_g3c_reply_id}
\else
DO $$ BEGIN RAISE EXCEPTION 'item_g3c_reply_id is required'; END $$;
\endif
\if :{?item_g3c_author_user_id}
\else
DO $$ BEGIN RAISE EXCEPTION 'item_g3c_author_user_id is required'; END $$;
\endif

SELECT set_config(
  'request.jwt.claims',
  jsonb_build_object('sub', :'item_g3c_author_user_id')::text,
  true
);

SELECT EXISTS (
  SELECT 1
  FROM jsonb_array_elements(
    swarm_read.signal_delivery_receipts(
      :'item_g3c_workspace_id'::uuid,
      :'item_g3c_signal_id'::uuid,
      NULL
    ) -> 'replies'
  ) AS reply(value)
  WHERE reply.value ->> 'reply_signal_id' = :'item_g3c_reply_id'
    AND reply.value ->> 'reply_status' IS NOT NULL
) AS functional_ok
\gset
\if :functional_ok
\else
DO $$ BEGIN RAISE EXCEPTION 'reply-status functional proof FAILED'; END $$;
\endif
