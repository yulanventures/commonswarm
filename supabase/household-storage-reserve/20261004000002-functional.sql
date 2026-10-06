-- Section 5: read-only execution, including the empty-household production case.
-- Role and claims changes are transaction-local; output contains no user data.
DO $proof$
DECLARE
 original_role text := current_user;
 t record;
 r text;
 baseline bigint;
 observed bigint;
BEGIN
 FOR t IN SELECT * FROM (VALUES
   ('household_object_streams',true),
   ('household_object_events',false),
   ('household_object_audit',false)) AS expected(name, command_read) LOOP
  IF to_regclass('swarm.' || t.name) IS NULL THEN
   RAISE EXCEPTION 'required household relation missing';
  END IF;
  EXECUTE format('SELECT count(*) FROM swarm.%I', t.name) INTO baseline;
  FOREACH r IN ARRAY ARRAY['swarm_command','swarm_read','anon','authenticated'] LOOP
   -- Check effective table access too: schema denial alone is not evidence
   -- of the private-table contract.
   IF coalesce(has_table_privilege(r,to_regclass('swarm.' || t.name),'SELECT'),false)
      IS DISTINCT FROM (r='swarm_command' AND t.command_read) THEN
    RAISE EXCEPTION 'household read access mismatch';
   END IF;
   EXECUTE format('SET LOCAL ROLE %I',r);
   IF r='swarm_command' AND t.command_read THEN
    EXECUTE format('SELECT count(*) FROM swarm.%I',t.name) INTO observed;
    IF observed IS DISTINCT FROM baseline THEN
     RAISE EXCEPTION 'household command read filtered rows';
    END IF;
   ELSE
    BEGIN
     EXECUTE format('SELECT count(*) FROM swarm.%I',t.name) INTO observed;
     RAISE EXCEPTION 'private household read admitted';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
   END IF;
   EXECUTE format('SET LOCAL ROLE %I',original_role);
  END LOOP;
 END LOOP;
END
$proof$;
SELECT '20261004000002 functional proof passed' AS result;
