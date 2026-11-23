-- Read-only functional invariant proof for 20261124000002 (waiting_autoclear).
DO $proof$
DECLARE
  v_eligible_src text;
  v_overview_src text;
  v_archived_src text;
BEGIN
  IF EXISTS (SELECT 1 FROM swarm.waiting_ask_autoclear_status(NULL, NULL, NULL)) THEN
    RAISE EXCEPTION 'waiting_ask_autoclear_status failed null fail-closed check' USING ERRCODE = '55000';
  END IF;
  IF swarm.waiting_ask_eligible(NULL, NULL, NULL, NULL) IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'waiting_ask_eligible failed null fail-closed check' USING ERRCODE = '55000';
  END IF;
  SELECT prosrc INTO v_eligible_src
  FROM pg_proc
  WHERE oid = 'swarm.waiting_ask_eligible(uuid,uuid,uuid,timestamp with time zone)'::regprocedure;
  IF position('waiting_ask_autoclear_status' IN coalesce(v_eligible_src, '')) = 0 THEN
    RAISE EXCEPTION 'waiting_ask_eligible does not call waiting_ask_autoclear_status' USING ERRCODE = '55000';
  END IF;
  SELECT prosrc INTO v_overview_src
  FROM pg_proc
  WHERE oid = 'swarm_read.home_overview()'::regprocedure;
  IF position('waiting_ask_eligible' IN coalesce(v_overview_src, '')) = 0 THEN
    RAISE EXCEPTION 'home_overview does not call waiting_ask_eligible' USING ERRCODE = '55000';
  END IF;
  SELECT prosrc INTO v_archived_src
  FROM pg_proc
  WHERE oid = 'swarm_read.waiting_archived_page(uuid,integer,timestamp with time zone,text)'::regprocedure;
  IF position('waiting_ask_autoclear_status' IN coalesce(v_archived_src, '')) = 0
     OR position('withdrawn' IN coalesce(v_archived_src, '')) = 0 THEN
    RAISE EXCEPTION 'waiting_archived_page missing autoclear or withdrawn outcomes' USING ERRCODE = '55000';
  END IF;
END $proof$;
