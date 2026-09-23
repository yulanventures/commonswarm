# H0 box release, 2026-09-23

First real use of `deploy/RELEASE-TO-BOX.md`. Release SHA `30ba33f9202138b3ec59b968b6282cf76d3dc7f3`,
`KIND_LIST='edge stack'`. Anvil ran every box step; HezLead directed and checked each phase. No rollback.

| Phase | UTC | What ran | Result |
|---|---|---|---|
| A | 04:02-04:07 | Section 1 prep (edge and stack release directories), section 2 `target.env`, section 3 session, backup freshness, section 4 Ledger backfill | Runtime-file comparison empty, so no stack switch. Backup `verified_at` 03:54:49Z (set `20260923T034927Z`). Ledger rows `20260916000001` and `20260916000002` added. |
| B | 04:14-04:20 | Section 5, one migration at a time: `20260922000001`, `20260922000002`, `20260922000003` | Each: ledger 0 and catalog f before; apply exit 0; ledger 1 and catalog t after; functional query ran. Ledger 51 rows. pg_cron: the previous five jobs plus exactly `swarm-purge-h0-poll-batches`. |
| C | 04:24 | Section 6 edge release (`command`, `h0`, router) | `edge/current` = `releases/30ba33f9…` (was `94353b42…`). Healthy, 2 GiB limit, network `commonswarm-net`. Probes a-h pass on loopback, edge-staging and api.commonswarm.com; probe f (`h0/note`) 401, not 500. No `CONNECT_TIMEOUT` and no `h0 command configuration missing` in the logs. |

`stack/current` stays `releases/e38b499fc29a01935333e38f66c4e68ac7e1f81e`. A `releases/30ba33f9…`
stack directory exists and supplied the migration files and helpers; it was not switched.

## Files

- `copy-back/`: the approved copy-back from the box and the Mac evidence directory (checksums,
  window-independent state files, ledger and cron before/after, migration state, probe results in
  `section6-probes.json`, `run.log`). Names of environment variables only; no values, logs or
  `window.env`.
- `phase-A-procedure-notes.txt`, `phase-B-procedure-notes.txt`, `phase-C-procedure-notes.txt`:
  where the procedure was unclear or wrong during this first run. They are folded into
  `deploy/RELEASE-TO-BOX.md` in a separate change.

Not in this release: the web app's link-join (`PUBLIC_H0_LINK_JOIN`) stays off, and the live
join/poll/ack check and the three-host done-test wait for a signed-in human.
