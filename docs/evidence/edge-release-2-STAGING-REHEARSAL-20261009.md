# Edge release 2 staging rehearsal (2026-10-09)

Release `510943ef25c47cafb4a3baecb863895e7bd03ddd` (main). It changes two things:
- every write tool advertises destructiveHint true;
- the edge refuses bearer tokens without the `mcp` scope (HTTP 403, `insufficient_scope`).
Plan deploy/edge-runtime/EDGE-RELEASE.md, sha256 `5af284f33d217b784f9a0a014c3bdecd79fb64564441c9578a55a8d44a0bb5fb` (unchanged since edge release 1). Archive sha256 `206c17d4be3b0ef18de6f5a182090a392c434f40a2ad4e69bd3070061b6dcd1d`. CI 5/5 at 510943ef. Codex review rounds A-B PASS, C FAIL, D PASS; Claude delta PASS.
Box: c1-staging-20261006. Baseline edge 44bedcae.

| Window | Steps | Result |
| --- | --- | --- |
| STGHZq | open, archive, preflight, ready, apply, probes forward, then the authenticated probe, then rollback, release-aside, probes recovery, close rolled-back, copyback | All PASS. Verified close rolled-back; timer active; gate CLOSED. |
| STG7I7 | open, archive, preflight, ready, apply, probes forward, close success, copyback | All PASS. Verified close success; timer active; gate CLOSED. Staging edge = 510943ef. |

Authenticated hosted MCP probe through local Caddy. The token comes from DCR + PKCE via the kit consent browser. The result files hold statuses, booleans and hashes only.

| Check | Old edge 44bedcae (baseline) | New edge 510943ef (STGHZq, and final after STG7I7) |
| --- | --- | --- |
| tools/list: 23 tools (9 reads, 14 writes) | 9/9 reads read-only; 1/14 writes destructive | 9/9 reads read-only; 14/14 writes destructive |
| whoami with and without _meta; malformed _meta | 200 / 200 / 400 -32602 | 200 / 200 / 400 -32602 |
| refresh without a scope parameter, then whoami | scope has mcp; 200 | scope has mcp; 200 |
| refresh with scope=openid offline_access (the response scope is empty) | token accepted: initialize 200 (the E4 gap) | initialize 403, WWW-Authenticate error="insufficient_scope", scope="mcp", resource_metadata |
| malformed bearer | 401, original challenge | 401, original challenge, no insufficient_scope |

The refusal log on the new edge was `{"event":"insufficient_scope","client_kind":"opaque","client_host":null,"client_id_sha256_12":"…"}`, with no token, id or scope.
A manual commonswarm-edge-recycle.service run at 11:25:06Z, on the binding rebound to 510943ef, gave Result=success. The edge restarted healthy on 510943ef, and recycle.json release_sha is 510943ef.
Post-rehearsal staging record: ~/work/c1-verify/runs/STAGING-STATE-POSTEDGE2-20261009T112522Z.json (sha256 f3ec5efa…).
