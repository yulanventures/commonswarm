Prepared the reusable OAuth image release plan on `lane/oauth-release-plan` in
`/private/tmp/cs-oauth-release`, from assigned base `855b3a23`. Changes are
uncommitted. No production operation, Docker command, browser, Actions run,
Alloy command or cross-family review was run. HezLead arranges that review.

File: `deploy/mcp-auth/OAUTH-RELEASE.md`

SHA-256: `e741b4df282af5c37e0de47d7520772e295e8b58d12c4f790e8f1c2dcebdc7f8`

Added `tests/oauth-release-plan.test.ts` and named it once in
`tests/lists/test.txt`. The plan has 11 complete shell blocks. It takes
all release and baseline identities from runtime inputs. The only fixed dated
hostname is the staging hostname explicitly required by the task. The existing
Caddy certificate's public CA path is measured on the chosen box at open, not
assumed or downloaded. Probes resolve the TLS hostname to local Caddy, including
on staging.

Block list:

| Block | Plan line |
| --- | --- |
| oauth-open | 82 |
| oauth-archive | 239 |
| oauth-root-shell | 272 |
| oauth-preflight | 290 |
| oauth-build | 341 |
| oauth-apply | 399 |
| oauth-probes | 442 |
| oauth-rollback | 497 |
| oauth-release-aside | 530 |
| oauth-close | 568 |
| oauth-copyback | 620 |

Run order (copied from the final plan):

| Row | Step | Host | Condition | Decision |
| --- | --- | --- | --- | --- |
| 1 | oauth-open | box | Approved window and staged inputs | Validate target, timing and measured baseline; save recovery state |
| 2 | oauth-archive | Mac | Open succeeded | Prove ancestry, make and verify exact archive; upload archive and receipt |
| 3 | oauth-root-shell | Mac | Upload succeeded | Verify root Bash access to the chosen host |
| 4 | oauth-preflight | box | Archive and ancestry receipt present | Verify archive, exact Compose bytes; prepare absent release tree |
| 5 | oauth-build | box | Preflight succeeded | Reuse revision-labelled image or build once under caps |
| 6 | oauth-apply | box | Image verified and window still valid | Recreate only oauth, atomically switch current, prove health |
| 7 | oauth-probes | box | Apply succeeded; PROBE_PHASE=forward | Probe local Caddy metadata/JWKS and MCP 401; require closed gate |
| 8 | oauth-close | box | All forward checks pass; CLOSE_RESULT=success | Recheck identity/env/proofs, clean secrets, record success |
| R1 | oauth-rollback | box | Any stop after open; HezLead directs recovery | Restore baseline Compose bytes/image/current; prove health (no deadline) |
| R2 | oauth-release-aside | box | Baseline recovery proven | Retain failed tree under failed-attempts; never delete old releases |
| R3 | oauth-probes | box | Aside complete; PROBE_PHASE=recovery | Probe restored baseline through local Caddy (no deadline) |
| R4 | oauth-close | box | Recovery checks pass; CLOSE_RESULT=rolled-back | Require baseline and absent failed tree; record rolled-back |
| 9 | oauth-copyback | Mac | Verified success or rolled-back close | Copy only nonsecret proof files; guarded Mac scratch cleanup |

Source mapping:

| Plan behavior | Source file:line | Taken or adapted |
| --- | --- | --- |
| Baseline labels, exact base/management Compose bytes, unset admin flags, other-release inventory, absent candidate tree | docs/evidence/2026-10-03-admin-issuance-release/RELEASE.md:3439 (`ai-w3-preflight`) | Kept the W3 layout and single admissible precondition; removed C1 receipt and SQL checks |
| Local immutable image, revision check, CPU-capped build, package/generated-artifact control | docs/evidence/2026-10-03-admin-issuance-release/RELEASE.md:3500 (`ai-w3-build`) | Kept build mechanics; revision-label lookup prevents rebuilding after a lost tag; package digest is derived from the supplied SHA instead of pinning an old dependency version |
| Snapshot comparison, image-only Compose env replacement, attempted receipt, oauth-only recreation, atomic symlink, 90-second health and running image check | docs/evidence/2026-10-03-admin-issuance-release/RELEASE.md:3527 (`ai-w3-apply`) | Kept; added `--no-deps` and a clean Compose interpolation environment; preserved baseline service.env bytes |
| Closed admin gate check | docs/evidence/2026-10-03-admin-issuance-release/RELEASE.md:3561 (`ai-w3-probes`) and :3585 (`ai-w3-local-gate`) | Retained local closed-gate proof; replaced the C1 conditional public gate check with the task's required Caddy route probes |
| Restore baseline Compose bytes, image, exact baseline tree, health; recover without deadline | docs/evidence/2026-10-03-admin-issuance-release/RELEASE.md:3668 (`ai-w3-rollback`) | Kept; verifies snapshot hashes before restoring; service.env drift stops recovery rather than overwriting another change |
| Same-filesystem retained failed-attempt tree and consistent repeat handling | docs/evidence/2026-10-03-admin-issuance-release/RELEASE.md:3620 (`ai-release-aside`) | Kept OAuth branch only; separate run-order row after confirmed recovery |
| Require completed probes for success | docs/evidence/2026-10-03-admin-issuance-release/RELEASE.md:7054 (`ai-close`, W3 success) | Kept and also rechecks running identity and env bytes before close |
| Require baseline current/image and failed tree absent for recovered close | docs/evidence/2026-10-03-admin-issuance-release/RELEASE.md:7154 (`ai-close`, recovered W3) | Kept; new record result is `rolled-back` as specified by the task |
| Validate exact stage, negative deletion controls, guarded rm, root-only close JSON and close time | docs/evidence/2026-10-03-admin-issuance-release/RELEASE.md:7192 (`ai-close` cleanup and record) | Kept; record adds baseline SHA/image and both open/close times |
| Root-only snapshot storage | docs/evidence/2026-10-03-admin-issuance-release/RELEASE.md:1468 (`ai-open` snapshot capture) | Kept in per-window secret scratch; inputs and nonsecret evidence remain separate |
| Executor ownership, exact-SHA server gate, caps, persisted state, stop behavior, retained old image/tree | deploy/RELEASE-TO-BOX.md:1 (preamble) and :85 (window rules) | Kept applicable OAuth-only rules; no database, Caddy or timer changes |
| Exact archive upload and fresh noninteractive root shell | deploy/RELEASE-TO-BOX.md:679 (`1-upload-release-archive`) and :703 (`1-open-root-shell`) | Adapted to per-window OAuth archive/ancestry paths and measured destination |
| Pinned base references, legacy builder, immutable local ID and `--pull never` | deploy/mcp-auth/RUNBOOK.md:233; referenced docs/evidence/2026-10-02-mcp-auth-release/RELEASE.md:902 (`hm37-oauth-build`) | Derives the pinned base from the exact archive Dockerfile; pulls only that digest; keeps nice 15 and three-CPU cap |
| Metadata issuer/JWKS content checks and ordinary POST /mcp without bearer expecting 401 | docs/evidence/2026-10-02-mcp-auth-release/RELEASE.md:303 (`mcp_route_probes` helper) | Reduced to the task's three routes; uses local Caddy, measured CA and TLS hostname; retains the authentication challenge check |

Dropped:

- The C1 INPUTS schema and `ai-inputs`: the first block owns exactly the task's
  nine-key JSON and staging/timing gates.
- `ai-gates`, gate receipts, consent and live-controls receipts: these belong to
  the larger C1 sequence. The shared exact-SHA server-suite prerequisite remains
  an operator gate, without a C1 receipt format.
- `admin_cutover_state`, migration ledger, authority/role catalog, edge
  measurement and activation checks: they do not release the OAuth image.
  Runtime env flags stay unset and the local admin gate must return closed.
- W4–W7, admin overlays, edge/site releases, recycle hooks and timer changes:
  these would expand this OAuth-only assignment. Timing refuses overlap with
  the next recycle instead of pausing it.
- The old conditional public `/admin/gate` route prerequisite: the plan probes
  the local gate and the task's Caddy metadata/JWKS/MCP routes. No Caddy change
  is part of this release.
- C1's W3 namespace in failed-attempt names and proof state: new windows use
  exact runtime SHA/window ID and an OAuth-only namespace.
- Fixed release/baseline values and dependency-version pins: all identities and
  the image package-content digest come from measured inputs or the archive.

Verification:

Only the named gate was run:
`node --import tsx --test tests/oauth-release-plan.test.ts`.
Its first attempt could not resolve `tsx`; `npm ci --ignore-scripts --no-audit
--no-fund` installed the locked dependencies without build/prepare scripts.
The final named gate passed. `git diff --check` passed. No full suite was run.

The test extracts every fenced shell block and embedded Python, checks Bash
syntax and heredoc safety, and executes the first Python validator with valid
and invalid fixtures. Clock tests cover all four recycle bands, exact
35-minute boundaries, after-recycle positive controls, window length and
midnight. Staging marker content/mode/type are real file checks; fixture owner
metadata is supplied in-process because this worker cannot create root-owned
files. Root/non-root ownership refusal is covered; this is not a live staging
proof. The table test reconciles its step set with the complete block set and
checks the literal test-list entry.

Final test tail:

```text
✔ every complete release block parses in Bash, and embedded Python compiles
✔ shell blocks refuse heredocs inside command substitutions
✔ extracted input validator rejects missing, extra, duplicate and malformed keys
✔ extracted target gate isolates staging markers, hostname and window IDs
✔ extracted clock gate refuses every recycle band and boundary, with positive controls
✔ run-order table names only complete steps and covers every block
ℹ tests 6
ℹ suites 0
ℹ pass 6
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2996.770584
```

Plan: 672 lines. Test: 225 lines. Test-list change: one added line. No application
code changed. The report itself is separate evidence. No step is blocked.
HezLead's independent check and any release execution remain outside this Maker
assignment.
