-- Run in the same outer transaction as the rollback. To-do/object history remains.
WITH retained(name, command_privileges) AS (VALUES
 ('household_todo_streams', ARRAY['SELECT','INSERT','UPDATE']::text[]),
 ('household_todo_events', ARRAY['SELECT','INSERT']::text[]),
 ('household_todos', ARRAY['SELECT','INSERT','UPDATE']::text[]),
 ('household_comments', ARRAY['SELECT','INSERT']::text[]),
 ('household_agent_work_policies', ARRAY['SELECT','INSERT','UPDATE']::text[]),
 ('household_todo_receipts', ARRAY['SELECT','INSERT']::text[]),
 ('household_object_streams', ARRAY['SELECT','INSERT','UPDATE']::text[]),
 ('household_object_events', ARRAY['INSERT']::text[]),
 ('household_object_audit', ARRAY['INSERT']::text[])
)
SELECT
 to_regprocedure('swarm_read.home_overview()') IS NULL
 AND to_regprocedure('swarm.household_human_can_read(uuid,uuid)') IS NULL
 AND (SELECT count(*) = 9 AND bool_and(c.relrowsecurity AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = 'swarm_admin'))
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'swarm' AND c.relname IN (
   'household_todo_streams','household_todo_events','household_todos','household_comments',
   'household_agent_work_policies','household_todo_receipts',
   'household_object_streams','household_object_events','household_object_audit'))
 AND (SELECT count(*) = 5 AND bool_and(t.tgenabled = 'O' AND t.tgfoid = 'swarm.prevent_append_only_mutation()'::regprocedure)
  FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgtype = 27
   AND t.tgrelid IN ('swarm.household_todo_events'::regclass,'swarm.household_comments'::regclass,
    'swarm.household_todo_receipts'::regclass,'swarm.household_object_events'::regclass,'swarm.household_object_audit'::regclass))
 AND (SELECT bool_and(has_table_privilege('swarm_command',c.oid,privileges.privilege) = (privileges.privilege = ANY(r.command_privileges)))
  FROM retained r JOIN pg_class c ON c.relname = r.name JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']::text[]) AS privileges(privilege)
  WHERE n.nspname = 'swarm')
 AND NOT EXISTS (
  SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(c.relacl) a
  WHERE n.nspname = 'swarm' AND c.relname IN (
   'household_todo_streams','household_todo_events','household_todos','household_comments',
   'household_agent_work_policies','household_todo_receipts',
   'household_object_streams','household_object_events','household_object_audit')
   AND (a.grantee NOT IN (c.relowner,(SELECT oid FROM pg_roles WHERE rolname = 'swarm_command'))
    OR (a.grantee <> c.relowner AND (a.is_grantable OR a.privilege_type NOT IN ('SELECT','INSERT','UPDATE')))))
 AS rollback_ok
\gset
