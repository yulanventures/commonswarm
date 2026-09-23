# Live control, lane/listener-outage at c88c7b3e (2026-09-23 06:34Z)

Required by the Strategist: "a listener given one transient 500 and one 403 without a revoked code keeps running".

- Artifact: `dist-release/cswarm` built by `scripts/build-release.sh` at c88c7b3e (exit 0), copied to a temporary
  directory; a temporary HOME; `listen start --provider claude --route main --allow-unattended --poll-interval 5s`
  for the lead's seat (4989ea3b) in the hub workspace. No model starts on route main.
- Target: production (`https://api.commonswarm.com`) through `fault-proxy.mjs` on 127.0.0.1, which answered the first
  signal read with HTTP 500 `{"error":"internal_error"}` and the second with HTTP 403 and an HTML body (no CommonSwarm
  code), then forwarded every request, including the Realtime websocket upgrade.
- Result (`proxy.log`, `status.json`): read #1 500 and read #2 403 injected at 06:34:46.8Z and 06:34:47.8Z; read #3
  200 at 06:34:49.3Z; Realtime upgraded at 06:34:49.6Z; reads #4-#6 200. Status after 120 s: `state: ready`,
  `lastErrorCode: null`, one read-retry episode with 2 retries lasting 2.7 s, claim cadence 5 min (push). The
  listener was stopped (`stop.json`: stopping; the process was gone seconds later) and the temporary HOME removed.
- Not established: behaviour during a real DNS switch; a renewal-path fault (the token was far from its renewal time).

Process check (lead, 2026-09-23 06:38Z, after the run): `stop.json` records `state: stopping` and `summary.txt` a
"LEFTOVER PROCESS" line because the script checked for processes while the stop was still in progress. A check a few
seconds later found the listener pid 51701 gone (`ps -p 51701` returned no process), no process whose command line
contained the temporary HOME, and the temporary HOME removed.

Deliveries (lead, 2026-09-23 ~20:10Z; question from the Grok round-10 arm): the run made 5 command calls (claims and
acks, all 200). `cswarm inbox` for the seat lists no signal created between 05:53:37Z and 09:53:26Z, so no message sent
during or shortly before the run could be lost. The newest earlier signal (`001f95ac`, 05:53:37Z) had already reached
the seat's session through its hook before the run; any delivery row of it that the test listener acked as queued into
the deleted temporary HOME did not lose the message, which stays readable in the inbox.
