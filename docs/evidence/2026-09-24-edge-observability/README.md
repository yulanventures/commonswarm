# Edge observability capture, 2026-09-23/24

## What this is

A read-only capture of edge-runtime memory and worker metrics after edge release
`1200ebb1`, for CSwarmDevLead's edge-memory lane. It is evidence only. Nobody stopped,
restarted, or changed anything on the box to make it. The capture ran on its own as a
transient systemd unit; this PR only reads its output and commits a copy.

## Window

- Agreed capture window: 2026-09-23T21:54:36Z (unit start) to 2026-09-24T23:59:59Z (agreed
  cutoff).
- The ndjson lines carry no per-line timestamp field. The capture script
  (`/root/hezlead-edge-obs/capture.sh` on the box) runs `docker logs --since <T1> --until
  <T2>` once an hour, without the `-t` flag, and appends the matching lines as-is. So the
  file itself has no timestamp to filter by.
- The window is enforced by when the file was fetched, not by a per-line filter:
  - Unit start (`systemctl show hezlead-edge-obs-capture.service`): `2026-09-23 21:54:36
    UTC`.
  - File last-modified time at fetch (`stat` on the box): `2026-09-24 23:54:38 UTC`, from
    the hourly append that ran at `23:54:36 UTC`.
  - Server time at fetch: `2026-09-25 00:06:28 UTC`. The unit was still running
    (`ActiveState=active`), with its next hourly append due around `00:54:36 UTC` on
    2026-09-25 — after the 23:59:59Z cutoff.
  - Because the file's last modification (23:54:38Z) is before the 23:59:59Z cutoff, and no
    later append had landed by fetch time, every line in this file falls inside the agreed
    window. No lines were removed.
- This means: no per-line timestamp is present or claimed anywhere in this evidence. Do not
  read one into the data.

## Line counts

- Total lines: **13552**
- Per `event` value (via `jq -r .event edge-observability.ndjson | sort | uniq -c`):

| event | count |
|---|---|
| `edge_worker_started` | 6006 |
| `edge_worker_ended` | 5983 |
| `edge_runtime_metrics` | 1563 |

## Recycle times (commonswarm-edge-recycle.service, UTC)

From `journalctl -u commonswarm-edge-recycle.service --since '2026-09-23 21:54' --until
'2026-09-25 00:00' --no-pager -o short-iso`, filtered to start/finish/deactivate lines. Each
recycle is a graceful `docker restart` of the edge runtime (HezLead's 2026-09-22 mitigation
for the isolate memory leak); each ran for about 1 second start to finish.

| Start | Finish / deactivated |
|---|---|
| 2026-09-24T03:30:10Z | 2026-09-24T03:30:11Z |
| 2026-09-24T09:30:01Z | 2026-09-24T09:30:02Z |
| 2026-09-24T15:30:11Z | 2026-09-24T15:30:12Z |
| 2026-09-24T21:30:17Z | 2026-09-24T21:30:18Z |

No recycle failures appear in this range: every line is `Starting`, `Deactivated
successfully`, or `Finished` — no `fail` lines.

## Metrics over time (edge_runtime_metrics, mainWorkerHeapStats)

Because the ndjson has no per-line timestamp (see "Window" above), individual
`edge_runtime_metrics` lines cannot be matched to a specific recycle interval from this
file alone — there is nothing to join the 1563 metrics samples to the four recycle
timestamps by. The table below is computed over the whole file instead, in file order
(first line to last line), not conclusions about cause:

| Field | First sample | Max (whole file) | Last sample |
|---|---|---|---|
| `usedHeapSize` (bytes) | 8,587,824 | 17,497,624 | 12,737,520 |
| `mallocedMemory` (bytes) | 623,048 | 7,838,440 | 2,131,080 |
| `externalMemory` (bytes) | 4,607,063 | 10,260,593 | 3,817,656 |

These are the only facts computed from the file. No claim is made here about what caused
any of these numbers, or about which recycle (if any) they sit before or after.

## Release copy-back

The task asked to copy
`/Users/yulanbot/anvil-work/commonswarm-edge-obs/repo/docs/evidence/2026-09-23-release-1200ebb19f56/`
into this folder as `release-1200ebb19f56/`, or link to it if it already exists on
`origin/main`.

- It does not already exist on `origin/main` under `docs/evidence/`.
- It was copied locally (AppleDouble `._*` files skipped; none were present) and then
  secret-scanned per the same procedure as the ndjson.
- The scan found matches, so **the folder was NOT committed and is NOT included in this
  PR**:

| Pattern | Matching lines |
|---|---|
| `Bearer` (case-insensitive) | 9 |
| `sk-` (case-insensitive) | 4 |
| `password` (case-insensitive) | 2 |
| `authorization` (case-insensitive) | 6 |

No values are reproduced here. The matches were in `mac-staging-probes.json`,
`section6-probes.json`, `edge.SHA256SUMS`, and `edge-with-override.SHA256SUMS` in the
source folder. If this evidence is still wanted, it needs a redaction pass on the source
folder before it can be copied into a public repository; ask HezLead or CSwarmDevLead
before that redaction happens.

## Sources

- Capture file: `/var/tmp/edge-observability-2026-09-23.ndjson` on `yulan-vps-1`, written by
  `hezlead-edge-obs-capture.service` (`/root/hezlead-edge-obs/capture.sh`), which tails
  `docker logs` for the `commonswarm-edge-edge-runtime-1` container.
- Recycle timing: `commonswarm-edge-recycle.service` on `yulan-vps-1`, read via
  `journalctl`.
- Nothing on the server was started, stopped, or edited to produce this evidence; it was
  read-only (`cat`, `journalctl`, `systemctl show`) over Tailscale SSH.

## Secret scan

`edge-observability.ndjson` was scanned for: `Bearer`, `eyJ` (JWTs), `swm_agt_`, `sk-`,
`password`, `apikey`, `authorization`, email addresses, `access_token` (case-insensitive).
No matches. It is safe to commit as plain text.

The `release-1200ebb19f56/` copy-back folder was scanned the same way and did have matches
(see "Release copy-back" above), so it was excluded rather than committed.
