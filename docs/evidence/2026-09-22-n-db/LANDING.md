# N-db landing: the box is CommonSwarm's only production (2026-09-22)

`lane/n-db-stack` at **94353b42** merged with `git merge --no-ff` (dcb56b80), then one whitespace-only commit (6dd253bb).
The code was already live: the box `yulan-vps-1` runs stack release 90e84f0e and edge release 94353b42 (both commits of
this lane), read over SSH on 2026-09-22. This merge makes main match production. Nothing was deployed by this landing.

## What is production now

- One Hetzner server, `yulan-vps-1` (Falkenstein). `api.commonswarm.com` goes through Cloudflare to Caddy on the box, then
  to containers: PostgreSQL 17 (`commonswarm-postgres`, no published port), GoTrue, PostgREST, Realtime, Storage API
  (files in Cloudflare R2), and the edge runtime with the four edge functions. All six healthy on 2026-09-22 12:5xZ.
- The website is static files from Caddy on the same box (since 2026-09-16 23:01Z, `deploy/site/`).
- The hosted Supabase project `cloud-swarm-dev` (`ukezjcnxjvkpkeezxaew`) was DELETED on 2026-09-20 16:37Z after the 48 h
  hold (HezLead, CommonSwarm note c5938042). The Vercel project `coswarm-site` is deleted.
- Backups: nightly database and file backups and a weekly offsite restore drill (`deploy/supabase-stack/backup/`).
  Measured on the box 2026-09-22: the restore drill last ran 2026-09-20 04:47-04:48Z, exit 0, `"ok": true, "state":
  "complete"`; the backup last ran 2026-09-22 03:45-03:50Z, exit 0.

## Review

| scope | SHA | grok | antigravity |
|---|---|---|---|
| rounds 1-5, the lane to its handoff tip | 6d13314c | round 5 PASS | round 5 PASS (8 of 8) |
| the 20 commits after it (PRs #16-#22) | 94353b42 | PASS (3 RIGOUR) | PASS on Q1y, Q3, Q4a, Q4b, Q5, Q6; FAIL on Q1x and Q2, both refuted |

Rulings on the round-6 split, checked against production (Strategist ruling: one pair, RIGOUR fixed forward because the
code is live):
- Q2 PRODUCTION "the restore drill's R2 credential scheme is rejected with 403, so the drill fails": REFUTED. The drill
  ran on the box on 2026-09-20 with exit 0 and state complete, from this code. Grok read the same function and found
  Cloudflare's local-signing form scoped `object-read-only` to the snapshot prefix.
- Q1x PRODUCTION "PostgREST has no `--ready` flag, so the container is never healthy": REFUTED. `docker ps` on the box:
  `commonswarm-postgrest Up 3 days (healthy)`.
- Q1 was blocked twice by the Gemini content filter and was re-run as Q1x and Q1y; the filter notices are kept in arms/.

RIGOUR to fix forward (next N-db hygiene lane):
1. `migrate/lib.sh:93` reads the target marker with `current_setting`, which a connection option can set: a URL with
   `options=-ccommonswarm.stack_identity=n-db-target-v1` passes the marker check on an unmarked database (grok, measured
   on the pinned image). Read the database-level setting instead, and refuse `options` in `make-pg-service.mjs`.
2. `prepare-target.sh:96` logs that `commonswarm_edge` has only three roles, but the SQL grants and does not revoke
   (grok). Say what is true, or revoke.
3. `backup/test_restore_drill.py:53` mocks the temporary credentials, so a change of scope to read-write passes (grok).
4. Backup units: no `docker.service` ordering; the restore timer names its unit inconsistently; backup and restore can
   overlap after a reboot (antigravity Q1x). The drill work directory is not bounded (antigravity Q2).
5. The activity grant preflight does not assert row security on the target table (antigravity Q3).

## Gates at the merge

At 6dd253bb (merge plus the whitespace commit): `npm run build` 0; `npm test` 0 (892 pass); `npm run test:p1-cli` 0
(819 pass, including the Docker tests for the freeze and the cron jobs); `check:tests` 0; `check:edge` 0;
`scripts/build-release.sh` 0; `git diff --check` 0. The trial merge before the whitespace fix failed only diff-check,
on trailing spaces in `backup/restore-drill.py`.

## Owed (not established by this landing)

- The rehearsal transcript for steps 5-13 and the recovery drill (Astra2's worker, 2026-09-17), the cutover-window
  transcript (steps, exit codes, UTC times, controls table, GitHub and Google sign-in checks) and the Sunday 2026-09-20
  drill record. Owners: Astra2 (d2f3417d) and HezLead (c82b3741); the lead asked HezLead on 2026-09-22 12:55Z and the
  Strategist asked too. They land as a follow-up evidence commit under this directory.
- How a future schema migration reaches the production database, and how a new edge-function or stack version is
  deployed, beyond the release directories and `current` symlinks that were used. Not written down in the repo.

Delivered 2026-09-22 (HezLead):

- `rehearsal-2026-09-17.md`, `cutover-window-2026-09-18.md`, `drill-2026-09-20.md` and
  `transcript-sources.md` in this directory. The session logs hold per-step exit codes only for
  rehearsal steps 1-6. Steps 5-8 finished (their artifact directory is dated 15:15:52Z) but were not
  captured command by command. No record was found of steps 9-13 or the recovery drill being run.
  The live cutover window was not captured step by step; the cutover file quotes the written
  cutover record instead. The gaps are
  listed in `transcript-sources.md`.
- The release procedure is `deploy/RELEASE-TO-BOX.md`.
