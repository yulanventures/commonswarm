# Edge release 3 staging rehearsal (2026-10-09)

Release `d518d4c9489131e8e121e0c99fcbd2a03e156eab` (main). The hosted MCP endpoint lists and admits only the 8 core tools (Tom's option B). The household tools stay hidden behind the source switch HOSTED_HOUSEHOLD_TOOLS_ENABLED = false.

- Plan deploy/edge-runtime/EDGE-RELEASE.md, sha256 `5af284f33d217b784f9a0a014c3bdecd79fb64564441c9578a55a8d44a0bb5fb`, unchanged.
- Archive sha256 `854b22770318d10ad8a9cd9be6f2032cbfabb2d56fb2fd5e2a110755567fcd2f`.
- CI 5/5 at d518d4c9.
- Codex review rounds A and B FAIL, round C PASS; Claude delta PASS.
- Box: c1-staging-20261006. Baseline edge 510943ef (edge release 2).

| Window | Steps | Result |
| --- | --- | --- |
| STGV3B | open, archive, preflight, ready, apply, probes forward, then the authenticated probe, then rollback, release-aside, probes recovery, close rolled-back, copyback | All PASS. Verified close rolled-back; timer active; gate CLOSED. |
| STG2EJ | open, archive, preflight, ready, apply, probes forward, close success, copyback | All PASS. Verified close success; timer active; gate CLOSED. Staging edge = d518d4c9. |

The authenticated hosted MCP probe ran through local Caddy, with a DCR + PKCE token from the kit consent browser. The result files hold statuses, booleans and hashes only.

| Check | Edge release 2 (510943ef, baseline, --expect-catalog 23) | Edge release 3 (d518d4c9, STGV3B and final after STG2EJ, --expect-catalog 8) |
| --- | --- | --- |
| tools/list | 23 tools; 14/14 writes destructive | exactly the 8 core tools in order; 2 reads read-only, 6 writes destructive |
| a hidden household tool (object_list) vs an unknown name (no_such_tool_r3) | n/a | both 400 / -32602 with an identical message |
| whoami with and without _meta; malformed _meta | 200 / 200 / 400 -32602 | 200 / 200 / 400 -32602 |
| normal refresh, then whoami | 200 | 200 |
| narrowed refresh, then initialize | 403 insufficient_scope | 403 insufficient_scope |
| malformed bearer | 401 | 401 |

- A manual commonswarm-edge-recycle.service run at 15:39:39Z on the binding rebound to d518d4c9 gave Result=success, and the edge was healthy on d518d4c9.
- recycle.json is bound to /tmp/admin-issuance-d518d4c9…-STG2EJ.tar.
- Post-rehearsal staging record: ~/work/c1-verify/runs/STAGING-STATE-POSTEDGE3-20261009T153955Z.json (sha256 7860e3e9…).
