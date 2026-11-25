-- Read-only functional invariant proof for 20261125000004 (todo_approvals).
DO $proof$
DECLARE
  v_todos_src text;
  v_archived_src text;
  v_overview_src text;
  v_kind_default text;
BEGIN
  SELECT column_default INTO v_kind_default
  FROM information_schema.columns
  WHERE table_schema = 'swarm'
    AND table_name = 'household_todos'
    AND column_name = 'kind';
  IF position('task' IN coalesce(v_kind_default, '')) = 0 THEN
    RAISE EXCEPTION 'household_todos.kind missing task default' USING ERRCODE = '55000';
  END IF;

  IF swarm_read.waiting_todos_page(NULL, 50, NULL, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'waiting_todos_page failed null fail-closed check' USING ERRCODE = '55000';
  END IF;
  IF swarm_read.waiting_archived_page(NULL, 30, NULL, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'waiting_archived_page failed null fail-closed check' USING ERRCODE = '55000';
  END IF;
  IF swarm_read.home_overview() IS NOT NULL THEN
    RAISE EXCEPTION 'home_overview failed unauthenticated fail-closed check' USING ERRCODE = '55000';
  END IF;

  SELECT prosrc INTO v_todos_src
  FROM pg_proc
  WHERE oid = 'swarm_read.waiting_todos_page(uuid,integer,timestamp with time zone,uuid)'::regprocedure;
  IF position('offer_gate' IN coalesce(v_todos_src, '')) = 0
     OR position('notes_preview' IN coalesce(v_todos_src, '')) = 0
     OR position('requested_by' IN coalesce(v_todos_src, '')) = 0 THEN
    RAISE EXCEPTION 'waiting_todos_page missing additive approval/offer fields' USING ERRCODE = '55000';
  END IF;

  SELECT prosrc INTO v_archived_src
  FROM pg_proc
  WHERE oid = 'swarm_read.waiting_archived_page(uuid,integer,timestamp with time zone,text)'::regprocedure;
  IF position('decision_status' IN coalesce(v_archived_src, '')) = 0
     OR position('decision_note' IN coalesce(v_archived_src, '')) = 0 THEN
    RAISE EXCEPTION 'waiting_archived_page missing approval decision projection' USING ERRCODE = '55000';
  END IF;

  SELECT prosrc INTO v_overview_src
  FROM pg_proc
  WHERE oid = 'swarm_read.home_overview()'::regprocedure;
  IF position('decision_status' IN coalesce(v_overview_src, '')) = 0 THEN
    RAISE EXCEPTION 'home_overview missing approval gate_clear rule' USING ERRCODE = '55000';
  END IF;
END $proof$;
