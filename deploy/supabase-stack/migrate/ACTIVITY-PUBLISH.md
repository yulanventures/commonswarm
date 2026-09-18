# Activity publish grants

`commonswarm_edge` can `EXECUTE realtime.send(jsonb,text,text,boolean)` through
PUBLIC on both the hosted source and the Hetzner target, but it has no
`realtime` schema USAGE, no `realtime.messages` INSERT, and every current
policy on that table is SELECT-only. The function is SECURITY INVOKER, owned
by `supabase_realtime_admin`, inserts exactly `(id, payload, event, topic,
private, extension)`, and catches every INSERT exception as
`WarnSendingBroadcastMessage`. Schema USAGE alone would still yield a 202
with no broadcast. Direct INSERT RLS is required.

The activity handler is still the authorization boundary: it authenticates
the agent/workspace/session under `SET LOCAL ROLE swarm_command`, `RESET ROLE`
back to `commonswarm_edge`, then calls `realtime.send` with event `activity`,
`private true`, and topic `cswarm-activity:<canonical-workspace-uuid>`.
This file does not change that handler and does not change `realtime.send`.

Pre-repair catalogs on both backends showed `realtime_usage=false`,
`messages_insert=false`, `messages_select=false`, `send_execute=true`,
`bypassrls=false`. There is no existing migrate command that already applied
this repair. Those snapshots are historical. Take a fresh source catalog and
a fresh target catalog at the apply gate before any least-privilege claim;
do not reuse the pre-repair JSON.

## Least privilege

Granted to `commonswarm_edge` only:

- `USAGE` on schema `realtime`
- `INSERT (id, payload, event, topic, private, extension)` on
  `realtime.messages` (not table-level INSERT)
- INSERT policy `commonswarm_edge_activity_insert` WITH CHECK:
  `extension = 'broadcast'`, `private IS TRUE`, `event = 'activity'`,
  topic matching `^cswarm-activity:(canonical uuid)$` (same UUID regex as
  the existing member SELECT policy)

Not granted and not changed: SELECT/UPDATE/DELETE/TRUNCATE; PUBLIC, `anon`,
`authenticated`, or other client roles; `swarm_command` schema USAGE or
INSERT; role memberships; `realtime.send` body or PUBLIC EXECUTE; the
existing SELECT policies on `realtime.messages`.

`dump-source.sh` exports source `commonswarm_*` role attributes and
memberships; `restore-target.sh` restores them. `prepare-target.sh` creates
`commonswarm_edge` only if that role is absent, sets its password, and
GRANTs `swarm_command`, `swarm_read`, and `swarm_capability` additively. It
does not revoke extra memberships, inherited privileges, or table grants.
`activity-publish-grants.sql` only adds the grants listed above and replaces
policy `commonswarm_edge_activity_insert`. Restored extra privileges remain.

Least privilege is not implied by restore or by this apply. Claim it only
after a fresh source catalog and a fresh target catalog each match the
intended baseline in Production completion.

## Apply

Identity is asserted by the existing migrate guards, not by this SQL. The
SQL fail-closes with SQLSTATE `42704` if `commonswarm_edge` does not exist.
It is one transaction. Do not `\i` it from inside another open transaction.

Source, on an already-verified operator session through the existing
`run-db-tool.sh` / `PGSERVICEFILE` wrapper (`source_psql` in `lib.sh`):

1. `assert_source_identity` (`SOURCE_SYSTEM_IDENTIFIER`, not in recovery,
   `swarm` present, not marked `n-db-target-v1`)
2. `source_psql --file deploy/supabase-stack/migrate/activity-publish-grants.sql`

Target:

1. `prepare-target.sh` runs `assert_target_identity` (`supabase_admin`
   superuser, `commonswarm.stack_identity=n-db-target-v1`, server
   `172.31.0.10`). If `commonswarm_edge` is missing it creates the role; it
   then sets the password and GRANTs the three swarm memberships additively,
   without revoking restored memberships or grants, and applies this SQL
   with a separate `target_psql`.

Do not run `prepare-target.sh` against the source. Do not apply this SQL
with a client/anon role.

## Isolated proof (not source/target)

```
unset TARGET_DATABASE_URL SOURCE_DATABASE_URL PGSERVICEFILE PGSERVICE
bash deploy/supabase-stack/migrate/activity-publish-grants.test.sh
```

The script refuses those variables and `PGHOST=172.31.0.10`, starts a local
unix-socket `initdb` cluster, and requires the real rejection SQLSTATE
(not merely a nonzero exit): `42704` when the role is missing, `42501` for
forbidden event/topic/public/non-broadcast rows, SELECT/UPDATE/DELETE/
TRUNCATE, extra-column INSERT, and every `swarm_command` publish attempt.
A valid private activity row must be visible to the cluster owner after
both a direct INSERT and `realtime.send`; a void `send()` return is not
enough. Isolated SQL refuses a cluster that has schema `swarm`, role
`supabase_realtime_admin`, or the target identity marker.

## Production completion

HTTP 202 is not proof. Isolated tests are not production completion.
Do not claim least privilege until a fresh catalog from this source and
from this target each match the intended baseline below. Do not reuse
pre-repair snapshots for that comparison.
After apply on that backend:

1. Read-only catalog as the operator:

```sql
SELECT has_schema_privilege('commonswarm_edge', 'realtime', 'USAGE');
SELECT has_table_privilege('commonswarm_edge', 'realtime.messages', priv)
FROM (VALUES ('INSERT'),('SELECT'),('UPDATE'),('DELETE'),('TRUNCATE')) AS p(priv);
SELECT a.attname
FROM pg_attribute AS a
WHERE a.attrelid = 'realtime.messages'::regclass
  AND a.attnum > 0
  AND NOT a.attisdropped
  AND has_column_privilege('commonswarm_edge', a.attrelid, a.attname, 'INSERT')
ORDER BY a.attname;
SELECT COALESCE(array_agg(a.attname ORDER BY a.attname), '{}'::name[])
         = ARRAY['event','extension','id','payload','private','topic']::name[]
       AS insert_columns_are_exactly_the_six
FROM pg_attribute AS a
WHERE a.attrelid = 'realtime.messages'::regclass
  AND a.attnum > 0
  AND NOT a.attisdropped
  AND has_column_privilege('commonswarm_edge', a.attrelid, a.attname, 'INSERT');
SELECT has_schema_privilege('swarm_command', 'realtime', 'USAGE');
SELECT rolsuper, rolbypassrls FROM pg_roles
WHERE rolname IN ('commonswarm_edge', 'swarm_command');
SELECT polname, polcmd, pg_get_expr(polqual, polrelid), pg_get_expr(polwithcheck, polrelid)
FROM pg_policy
WHERE polrelid = 'realtime.messages'::regclass
ORDER BY polname;
SELECT m.rolname AS member_of
FROM pg_auth_members am
JOIN pg_roles r ON r.oid = am.member
JOIN pg_roles m ON m.oid = am.roleid
WHERE r.rolname = 'commonswarm_edge'
ORDER BY 1;
```

   Intended baseline: USAGE true; table-level INSERT, SELECT, UPDATE, DELETE,
   and TRUNCATE all false; `insert_columns_are_exactly_the_six` true (the
   enumerated non-dropped ordinary columns with effective INSERT are exactly
   `event`, `extension`, `id`, `payload`, `private`, `topic`; six positives
   without that exact-set check are not enough, including extra
   `INSERT (inserted_at)`); `swarm_command` USAGE false; `rolsuper` false and
   `rolbypassrls` false for `commonswarm_edge` and `swarm_command`; policy
   `commonswarm_edge_activity_insert` present as INSERT; the three existing
   SELECT policies unchanged. Memberships must match the restored source role
   plus the three additive swarm GRANTs; extras versus that baseline are not
   stripped by prepare-target. Only this fresh comparison supports a
   least-privilege claim.
2. Native POST to the existing activity function with a valid agent bearer
   for workspace W (and session proof when the principal is managed).
3. A PRIVATE Realtime subscriber who is a member of W on topic
   `cswarm-activity:<W>` event `activity` must receive the payload. That
   delivery uses the existing SELECT policy
   `workspace members receive agent activity`.
4. Negative: a subscriber on W must not receive a POST authenticated for
   another workspace, and invalid credentials must not deliver a message.
