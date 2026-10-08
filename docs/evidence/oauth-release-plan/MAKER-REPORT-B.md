Completed Maker task OAUTH-RELEASE-B in `/private/tmp/cs-oauth-release`,
branch `lane/oauth-release-plan`. Changes are uncommitted. Existing work is
preserved. This report supersedes the original Maker report's plan hash,
line references, block count and test results.

Plan: `deploy/mcp-auth/OAUTH-RELEASE.md`
SHA-256: `bf8fea30b4a2e50df06912a3b784b1076c02800dda996936c09bc7c5a9702555`

| Check item | Final file:line | Correction |
| --- | --- | --- |
| 3a: recovered close continued with failed tree present | deploy/mcp-auth/OAUTH-RELEASE.md:662 | Explicit `|| fail` stops rolled-back close on a remaining tree or symlink; aborted close has the same guard at :671. |
| 3a: other unguarded absence lists | deploy/mcp-auth/OAUTH-RELEASE.md:178 | Proof-path refusal is explicit; secret-stage post-cleanup refusal at :688 and Mac-stage refusal at :742 are also explicit. |
| 3b: failure before attempt forced recreation | deploy/mcp-auth/OAUTH-RELEASE.md:541 | New oauth-abort proves baseline identity/env bytes and probes without any recreate or rollback. It writes aborted-before-attempt.txt. Rollback refuses an absent attempt at :572; aside accepts the abort receipt at :606; close records result aborted at :665; copy-back accepts it at :729. |
| 4: no baseline probe/CA proof before mutation | deploy/mcp-auth/OAUTH-RELEASE.md:190 | Save the CA bytes in root-only proof state. Open runs the shared route/gate probes at :312 and writes probes-baseline.txt. Preflight (:366), build (:421) and apply (:482) require that receipt. Forward/recovery use the same helper and saved CA at :534. |
| 5: ERR trap did not inherit into functions | deploy/mcp-auth/OAUTH-RELEASE.md:95 | All 12 blocks set -E before their ERR trap. The nested root-shell check also sets it and has its own FAIL…STOP trap at :109. |
| 5: root-shell check came after first root block | deploy/mcp-auth/OAUTH-RELEASE.md:61 | Root access is row 0 and the first executable block at :90. |
| 2 note: hostname was not measured before the window | deploy/mcp-auth/OAUTH-RELEASE.md:104 | Root-shell prerequisite measures and compares target hostname before open; open still independently validates hostname and marker. |
| 3b note: HTTPS remotes failed archive preparation | deploy/mcp-auth/OAUTH-RELEASE.md:330 | Accept canonical GitHub SSH and HTTPS remotes; continue refusing other repositories. |
| 1 note: new env -i Compose execution path | deploy/mcp-auth/OAUTH-RELEASE.md:211 | Preserve W3's Docker client environment. Read interpolation variable names from the exact Compose files and unset only those keys in a subshell, so compose.env supplies the values. |
| 1 note: returning to a retained successful SHA | deploy/mcp-auth/OAUTH-RELEASE.md:85 | State the restriction explicitly: retained successful trees remain ineligible, and returning to that SHA needs a separate reviewed plan. Preserve W3's absent-tree precondition and do not move/delete a successful release tree. |

Regression owners:

- `tests/oauth-release-plan.test.ts:368`: recovered close rejects both a
  directory and a dangling symlink; an absent-tree control closes honestly.
- `tests/oauth-release-plan.test.ts:384`: abort and aborted close work with no
  attempt or rollback, for both absent and prepared candidate trees. The actual
  aside Python retains the prepared tree. An existing attempt refuses abort;
  rollback refuses an absent attempt. No recreation call occurs.
- `tests/oauth-release-plan.test.ts:420`: TLS failure (curl exit 60), every route
  failure, an open gate, private JWKS and a missing MCP challenge refuse open and
  admission to apply before any attempt. The positive control admits an attempt;
  baseline, forward and recovery send the same four probe requests with the same
  CA path and local Caddy resolution.
- `tests/oauth-release-plan.test.ts:451`: a failed helper prints FAIL…STOP under
  each block's real options/trap. The persisted helper is separately parsed and
  checked for heredoc-in-substitution safety.
- `tests/oauth-release-plan.test.ts:465`: the real Compose helper preserves a
  Docker client setting and clears file-derived interpolation overrides.

Ran the requested focused gate:
`node --import tsx --test tests/oauth-release-plan.test.ts` (exit 0).
`git diff --check` passed. No full suite, Docker, browser, SSH/box operation,
Actions run, Alloy, commit or independent review was performed. HezLead owns
that review.

Final test tail:

```text
✔ every complete release block parses in Bash, and embedded Python compiles (448.89ms)
✔ shell blocks refuse heredocs inside command substitutions (1.825125ms)
✔ extracted input validator rejects missing, extra, duplicate and malformed keys (1273.058167ms)
✔ extracted target gate isolates staging markers, hostname and window IDs (376.640958ms)
✔ extracted clock gate refuses every recycle band and boundary, with positive controls (1017.470875ms)
✔ run-order table names only complete steps and covers every block (1.653125ms)
✔ rolled-back close stops while the failed tree remains, with absent-tree control (54.280125ms)
✔ abort-before-attempt closes as aborted without recreate or rollback (625.2495ms)
✔ baseline probe failures refuse open and apply before the attempt; forward and recovery reuse the probes (1119.36225ms)
✔ ERR inside a helper function prints FAIL and STOP in every trapped block (21.157625ms)
✔ Compose helper preserves Docker client settings and clears file-derived interpolation overrides (26.682042ms)
ℹ tests 11
ℹ suites 0
ℹ pass 11
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 5229.995083
```

Against the saved original plan, the first regression run exited 1: 10 tests,
5 passed and 5 failed. Failures were root-shell order, remaining failed tree,
missing abort path, baseline probe failure falsely reporting PASS open, and
missing FAIL…STOP output inside a function. The saved plan hash was
`e741b4df282af5c37e0de47d7520772e295e8b58d12c4f790e8f1c2dcebdc7f8`.
Later additions cover retained prepared trees and Compose client settings.

Tests use nonsecret filesystem fixtures and fake transport. They execute the
actual admission/record-writing and probe logic. They do not prove live TLS,
Docker identity, root ownership or box cleanup; root-only cleanup is omitted
from the close harness. No production claim is made.

Final blocks (12):

| Block | Plan line |
| --- | --- |
| oauth-root-shell | 90 |
| oauth-open | 119 |
| oauth-archive | 319 |
| oauth-preflight | 356 |
| oauth-build | 411 |
| oauth-apply | 472 |
| oauth-probes | 518 |
| oauth-abort | 541 |
| oauth-rollback | 563 |
| oauth-release-aside | 598 |
| oauth-close | 641 |
| oauth-copyback | 703 |

Plan: 757 lines (85 added over the incoming 672-line plan).
Test: 487 lines (262 added over the incoming
225-line test). No application code changed. The existing one-line test-list
entry and original Maker report are preserved. This follow-up report is new.
No step is blocked. Ready for HezLead's cross-family check.
