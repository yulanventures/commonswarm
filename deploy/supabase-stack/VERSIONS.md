# N-db image pins

| Service | Pin | Reason |
|---|---|---|
| PostgreSQL | `public.ecr.aws/supabase/postgres:17.6.1.147` | Production reports engine 17, channel `ga`. This is the matching 17.6.1 production image pin measured by the lead from the Supabase CLI on 2026-09-16 at 21:20Z. |
| GoTrue | `public.ecr.aws/supabase/gotrue:v2.197.0` | Production `/auth/v1/health` reported `v2.197.0` at the same measurement time. |
| PostgREST | `public.ecr.aws/supabase/postgrest:v14.5` | Production publishes no PostgREST version, so this remains the exact local Supabase CLI pin. |
| Realtime | `public.ecr.aws/supabase/realtime:v2.86.3` | Production publishes no Realtime version, so this remains the exact local Supabase CLI pin. |
| Storage API | `public.ecr.aws/supabase/storage-api:v1.77.5` | Production `/storage/v1/version` reported `v1.77.5` at the same measurement time. |

## Production pin replacement point

Before the box rehearsal, the lead repeats the available public version checks. If a published production version differs, change only that service's `image:` line in `compose.yaml`, rerun the full box rehearsal from a fresh dump, and record the pin in the rehearsal evidence. PostgreSQL stays on the ruled 17.6.1.x line unless the source server version proves a different patch requirement. Keep the recorded local CLI pins for services that publish no production version.

Tags are used instead of floating names so a restart cannot change a service without a reviewed file change.
