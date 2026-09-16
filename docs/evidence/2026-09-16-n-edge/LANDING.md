# N-edge (lane/edge-runtime-box) — landing record

Reviewed SHA **70d17d08** (on main fca81374), landed as a merge that keeps that SHA in history. Made by Codex
(gpt-5.6-sol, high) in six rounds plus two lead commits (76487b81 staging host; none after). Deployed to yulan-vps-1
BEFORE landing, for the staging rehearsal (no public DNS pointed at the box).

## Pairs
| round | SHA | antigravity | grok |
|---|---|---|---|
| 1 | 76487b81 | FAIL | FAIL |
| 2 | 81159423 | PASS | FAIL |
| 3 | 70d17d08 | PASS (no PRODUCTION) | FAIL (one PRODUCTION claim, ruled RIGOUR) |

Round-3 grok claim, verified TRUE: a full pool on edge-runtime v1.73.13 raises InvalidWorkerCreation, which the main
service maps to 500 instead of 504 WORKER_LIMIT. Ruled RIGOUR because every client classifies status >= 500 the same
(command-client.ts:1450, pending-command.ts:171/282, signals.ts:819/2305, listener engine.ts:321, renewal.ts:445,
arrival-watch.ts:709) and no client parses WORKER_LIMIT; overload-incident path only. Folded with grok's other four
RIGOUR items in the follow-up series on main. Landing approved by the Strategist (signal 15b462c0, 22:06Z), which confirmed the RIGOUR ruling.

## Refuted by live measurement on the box
Crash loop on `docker restart` (came back healthy, 0 restarts); worker starvation after six sequential requests (all fast).

## Found by the lead on the box, not by the arms
- Supabase's own Cloudflare returns 403 for proxied requests carrying CF-Connecting-IP
  (docs/evidence/2026-09-16-n-edge/SUPABASE-WAF-CF-CONNECTING-IP.md); fixed by stripping Cloudflare request headers.
- A global `servers` block inside an imported site file made the box's Caddy reject its config; restored; moved to the
  operator's main Caddyfile.

## Live at 70d17d08 through Cloudflare on edge-staging.commonswarm.com
h0 200; bare /functions/v1 404; unknown function 404; OPTIONS 200 (all acao *); /auth/v1/health 200; /auth/v1/settings 200;
/storage/v1/status 200; /rest/v1/ 401; Realtime subscribe + broadcast; CLI members/feed/receipt 45/45.
Latency (docs/evidence/2026-09-16-n-edge/LATENCY-2026-09-16.md): box p95 read members 3.3 s, feed 2.4-2.9 s, receipt 2.1 s
vs production 1.2 / 1.1 / 0.9 s — ruled acceptable until N-db.

## NOT ESTABLISHED at landing
The DNS cutover itself; a GitHub sign-in through the box path; the forced 4-wide pool exhaustion on the box.

## Fix round 6 landed (RIGOUR fold, no pair), merge 774dd9ad of 80f7de9e

Codex gpt-5.6-sol high on top of 70d17d08: `InvalidWorkerCreation` maps to 504 `WORKER_LIMIT`; `WorkerAlreadyRetired`
retried around worker creation and fetch; CORS on Caddy's function-upstream error responses; `stop_grace_period: 80s` for
the 70 s drain; the local Kong versus hosted OPTIONS record corrected. Proof on the pinned image (parallelism 1, wait 1000 ms,
five simultaneous 2.5 s requests): 70d17d08 gave one 200 and four 500; 80f7de9e gives one 200 and four 504, all with
wildcard CORS; an unreachable function upstream through Caddy gives 502 with wildcard CORS. Maker gates all exit 0; four
mutations each fail a test. On main after the merge: tests/p1-cli/edge-runtime-box.test.ts 12/12, compose config exit 0.
NOT deployed to the box yet (the box runs 70d17d08, edge-staging only); it ships with the next box release.
