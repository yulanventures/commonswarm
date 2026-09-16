# N-db image pins

| Service | Pin | Reason |
|---|---|---|
| PostgreSQL | `public.ecr.aws/supabase/postgres:17.6.1.106` | The source is PostgreSQL 17.6. This exact 17.6.1 image is the local Supabase CLI image, so the rehearsal and target use the same Supabase roles, extensions, and base auth/storage schemas. |
| GoTrue | `public.ecr.aws/supabase/gotrue:v2.193.1` | Exact local CLI baseline. |
| PostgREST | `public.ecr.aws/supabase/postgrest:v14.5` | Exact local CLI baseline. |
| Realtime | `public.ecr.aws/supabase/realtime:v2.86.3` | Exact local CLI baseline. |
| Storage API | `public.ecr.aws/supabase/storage-api:v1.67.15` | Exact local CLI baseline. |

## Production pin replacement point

Before the box rehearsal, the lead reads each public production health endpoint and records its version. If a service differs from the local baseline, change only that service's `image:` line in `compose.yaml`, rerun the full box rehearsal from a fresh dump, and record the pin in the rehearsal evidence. PostgreSQL stays on the ruled 17.6.1.x line unless the source server version proves a different patch requirement.

Tags are used instead of floating names so a restart cannot change a service without a reviewed file change.
