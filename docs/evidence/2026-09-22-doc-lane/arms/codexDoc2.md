1. **PRODUCTION — stale maintenance file can break recovery.**
   `deploy/supabase-stack/RUNBOOK.md:394` says to restore production “behind the maintenance Caddy file.” That file proxies reads and Realtime to the deleted Supabase host at `deploy/supabase-stack/commonswarm-api-maintenance.caddy:10-49`. The same runbook also says to install it at line 274. During recovery, users get failed reads, failed Realtime, and 503 for Auth and writes. `tests/p1-cli/supabase-stack.test.ts:448-455` actively requires this obsolete routing. This contradicts `CLAIMS.md:111`, which says the runbooks prohibit installing all old files.

2. **PRODUCTION — the active succession guide still commands deleted services.**
   `SUCCESSION-PLAN.md:3-6` tells every new lead to read and follow the file. Lines 1616-1625 and 1688-1689 then instruct them to link, push migrations, and deploy functions to deleted Supabase project `ukezjcnxjvkpkeezxaew`. A new lead following the stated entry point contacts the deleted system and sees failed deployment work instead of using the box. `CLAIMS.md:115` omitted this top-level file from its 546-file sweep, so the claimed sweep is incomplete.

The changed CLI and CORS tests passed: 36/36. I contacted no production or retired service and made no edits.

VERDICT: FAIL — an actionable recovery path and the repo’s lead handoff still direct operators to the deleted Supabase system.
