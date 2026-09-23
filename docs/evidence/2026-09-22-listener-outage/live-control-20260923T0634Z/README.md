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
