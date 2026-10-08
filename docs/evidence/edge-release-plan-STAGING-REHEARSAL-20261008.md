# Edge release staging rehearsal (2026-10-08)

Plan: deploy/edge-runtime/EDGE-RELEASE.md, sha256 `5af284f33d217b784f9a0a014c3bdecd79fb64564441c9578a55a8d44a0bb5fb` (PINNED after this clean rehearsal).
Release input: `44bedcaec8302f297da55325d11b65815d725feb`. It is an ancestor of main through merge e571b704 (main had moved by a site-only change). It carries:
- FIX-META (df5bcb7d): the hosted MCP accepts params._meta;
- the claim_seat wording (9645545f);
- plan rounds A-I.
CI at 44bedcae: 5/5 green. Archive sha256 `323b7af9919c62f47147c32f8e84ee2ffdb990d45a980f887d8153e6fdd43234`.
Box: c1-staging-20261006 (staging marker). Staging layout: snapshot M, post-C1-W4. That means edge 1388b0ee with the recycle drop-in, recycle.json and the retained archive in /tmp; oauth f17449e4. The owner/mode layout matches production (measured by HezLead).

## Rehearsal-found plan defects (all fixed, each with a Codex maker, Codex review and Claude delta check)
1. STGAqX (0268f6fe): the route probe asked for /.well-known/oauth-protected-resource, which Caddy does not route (404). Fixed to the /mcp path, with a Caddy-parse test. The abort path ran the same probe, so a partial open had no recovery; an in-plan partial-open recovery was added.
2. STG4Nz (02e25e19): the plan forbade compose.override.yaml in the archive, but the repo carries it (c645f382). Fixed: the baseline is copied in and verified, and a test builds the archive from HEAD. This window proved the pre-attempt abort path: R0 → R2 → R4, verified close aborted.
3. STGtSt (88eca743): the plan required root-owned release parents, but edge/releases is commonswarm:commonswarm 0750 on staging and production. Fixed using measured owner tables. This window proved abort with a receipt-backed helper tree set aside.
In round D, review also found a probe Origin defect (the edge refuses an unlisted Origin before auth). The remaining CI failures were test-harness portability only (Linux argv limit; a Python 3.12 namespace collision).

## Final rehearsal at 44bedcae (plan 5af284f3)
| Window | Path | Result |
| --- | --- | --- |
| STG6FG | forward (open, archive, preflight, ready, apply, forward probes), then R1 rollback, R2 aside, R3 recovery probes, R4 | All PASS. Verified close rolled-back. Edge back to 1388b0ee and healthy; recycle.json exact baseline bytes (7526214a…); timer active; gate CLOSED. |
| STGWdT | forward then close success | All PASS. Verified close success. Edge 44bedcae healthy; recycle.json rebound to 44bedcae and its new archive; timer active; gate CLOSED. |

## Proof of the fix (authenticated hosted MCP through local Caddy; DCR + PKCE token via the kit consent browser)
| State | whoami without _meta | whoami WITH _meta | malformed _meta |
| --- | --- | --- | --- |
| Old edge 1388b0ee (baseline) | 200 | 400 / -32602 (Tom's bug) | 400 / -32602 |
| Edge 44bedcae (STG6FG forward, and final STGWdT) | 200 | 200, same result shape | 400 / -32602 |

## Recycle hook after the rebind
A manual run of commonswarm-edge-recycle.service at 22:19:20Z, on the new binding, gave Result=success: the C1 hook's before and after steps passed. The edge restarted healthy, still on 44bedcae. The next scheduled staging recycle (03:30Z) also runs on the new binding.

Evidence: the close folders next to this file (edge-release-*-STG4Nz, -STGtSt, -STG6FG, -STGWdT); the probe results under ~/work/c1-verify/runs/mcp-meta-probe-baseline.5YXvdy, -fixed.1f0R2E and mcp-meta-probe-final.YwX95I (statuses, error codes and body hashes only; no tokens).
