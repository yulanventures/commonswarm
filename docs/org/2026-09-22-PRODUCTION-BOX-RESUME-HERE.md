# Resume here: the box is the only production (2026-09-22)

Written by CSwarmDevLead (seat 4989ea3b) when N-db landed on main. Newest resume file; it replaces
`2026-09-16-N-EDGE-RESUME-HERE.md` (kept as history).

## What is LIVE

- Production is ONE Hetzner server, `yulan-vps-1` (Falkenstein): api.commonswarm.com (Caddy to PostgreSQL 17, GoTrue,
  PostgREST, Realtime, Storage API with files in Cloudflare R2, and the edge runtime) and the static site
  commonswarm.com. The box runs stack 90e84f0e and edge 94353b42; main has that code since the N-db merge (dcb56b80).
  Landing record: `docs/evidence/2026-09-22-n-db/LANDING.md`.
- DELETED: the hosted Supabase project `cloud-swarm-dev` (`ukezjcnxjvkpkeezxaew`, 2026-09-20 16:37Z) and the Vercel project
  `coswarm-site`. Do NOT run `supabase db push`, `supabase functions deploy`, `supabase link`, anything with `--linked`,
  `supabase projects api-keys`, or `vercel deploy` for CommonSwarm. Several documents still say otherwise (AGENTS.md
  "cloud-swarm-dev IS PRODUCTION", the Vercel site ritual, the `releases` brain topic): the doc lane below fixes them;
  until then, this file wins.
- Still true: the local Supabase CLI stack (`npm run db:start`, 127.0.0.1:54321) runs the server test suites.
- RELEASED 2026-09-22: cswarm 0.1.72 (check budget, H lane 1, read projections, the live-host strings); npm latest,
  GitHub release Latest, /download shows it. Record: docs/evidence/2026-09-22-v0.1.72-release/RELEASE.md.

## Open, in the Strategist's order (CommonSwarm ask 584d0a89)

1. N-db landing: DONE at this commit. OWED: the rehearsal steps 5-13 and recovery drill, the cutover window, and the
   2026-09-20 drill transcripts (Astra2 d2f3417d and HezLead c82b3741; asked 2026-09-22). They land under
   `docs/evidence/2026-09-22-n-db/`. Also owed: how a schema migration and a new stack or edge version reach the box.
2. Doc lane: LANDED (docs/evidence/2026-09-22-doc-lane/LANDING.md; 105 rows, all fixed except the privacy page). Its
   site files (llms.txt, api.md) go live with the next site deploy; its CORS defaults with the next edge release; its CLI
   strings with the next npm release. STILL NEEDS A DECISION: `site/src/pages/privacy.astro` still names Supabase (US East) and Vercel as processors and says
   data is processed in the US; the data is now in Germany on the box, files in R2, mail via Resend. The facts can be
   corrected; the data-transfer wording needs the owner.
3. Cleanup of merged branches and worktrees, and PR #8: BLOCKED. The operator rejected the lead's cleanup on 2026-09-17
   and has not answered since.
4. CLI release: DONE (0.1.72, see above). It must also fix a live bug found by the doc pass: the capability-link default host
   is `coswarm-site.vercel.app` (deleted), in `src/cloud/capability-link.ts:8` and `src/cli.ts:995-998`. The `/see` page
   itself was never built (404 on commonswarm.com on 2026-09-22; design `CAPABILITY-URL-ONRAMP.md` §7 "No page"), so the
   host change alone does not make the link work; building the page is a backlog item.
5. H0 (later on 2026-09-22). Lane 4b (the app's "Add an agent" on the link-join) LANDED behind the build flag
   `PUBLIC_H0_LINK_JOIN`, which is OFF: record `docs/evidence/2026-09-22-h0-lane4b/LANDING.md`. Lane 5a (poll, ack, the
   listener fence, three migrations 20260922000001-3, release proofs) LANDED, not deployed: record
   `docs/evidence/2026-09-22-h0-lane5a/LANDING.md`. Lane 5b (the h0
   function forwards register, ask, note, reply, working-on) has not started. The box release procedure
   `deploy/RELEASE-TO-BOX.md` is on main (PR #24, merged 844d0de2); H0 is released with it, run by Anvil under HezLead.
6. Ahead of H0, by the Strategist's ruling: `lane/listener-outage` (a listener no longer stops for good on one
   transient 403/500; found when no listener on the mini was running), to ship as 0.1.73 with a live control, then
   restart the stopped listeners one seat at a time. Then the edge memory item below.

## Box facts recorded 2026-09-22 (from HezLead)

- The edge container has a box-only `compose.override.yaml` with `mem_limit: 2g`, and
  `commonswarm-edge-recycle.timer` restarts it at 03:30, 09:30, 15:30 and 21:30 UTC. Under 512 MiB it was OOM-killed
  177 times in 24 hours (exit 137) while `docker inspect` looked healthy. Growth measured about 2.3-3.5 MiB per minute
  and follows wall-clock early terminations of isolates. Queue item: find the cause and remove the timer and the cap.
  A one-minute series across the 21:30Z-03:30Z window is being recorded on the box (HezLead).
- The stack release switched to `e38b499f` (the N-db hygiene lane) at about 19:46Z, host units in the order its
  landing record gives. Backups run nightly at about 03:45 UTC with offsite copies verified; the Sunday restore drill
  passed (80 tables).
- The two 2026-09-16 H0 migrations are applied on the box but have no rows in `supabase_migrations.schema_migrations`;
  the release procedure's "Ledger backfill" step records them.

## Window hazard kept for later migrations (measured 2026-09-17)

Resetting the project database password broke the hosted edge functions for a few minutes (about 14:45-14:50Z) because
their secrets carried that login. Rotate or reset any credential before a window, never during it, and first list every
secret that embeds the login.

## Not established

- The lead did not see the window; everything after the 2026-09-17 15:00Z handoff comes from HezLead's notes and a
  read-only look at the box on 2026-09-22.
