Completed OAUTH-RELEASE-C in `/private/tmp/cs-oauth-release`, branch
`lane/oauth-release-plan`. All incoming uncommitted changes remain. No commit
was made. This report supersedes Round B's plan hash, line references and test
results. HezLead arranges the independent cross-family check.

Plan SHA-256:
`b9a75e13c98aadeb587a96050ee824a4ad7db0a62db0bed0d299dcd0141cb567`

| Change | File:line | Result |
| --- | --- | --- |
| OPEN refuses an existing candidate before file changes | deploy/mcp-auth/OAUTH-RELEASE.md:177 | Check both `-e` and `-L` before creating proof or scratch paths. Existing directories, files and symlinks, including dangling symlinks, print FAIL and STOP. |
| Preflight records tree creation | deploy/mcp-auth/OAUTH-RELEASE.md:400 | Exclusively write `oauth-tree-created.txt` with the exact candidate path immediately before mkdir. The receipt belongs to this window's proof directory. |
| Aside moves only a recorded candidate | deploy/mcp-auth/OAUTH-RELEASE.md:622 | Validate a regular, nonsymlink receipt and its path. Only that receipt permits moving a directory; unrecorded paths stay untouched, including on repeated aside calls. Absence is required only for a receipt-backed candidate. |
| Recovered close uses the same scope | deploy/mcp-auth/OAUTH-RELEASE.md:678 | Both aborted and rolled-back close validate a present receipt and require its tree to be gone. Without a receipt, close leaves unrecorded paths alone. |
| Run-order copy matches the guards | deploy/mcp-auth/OAUTH-RELEASE.md:71 | R2 and R4 name this window's receipt-backed tree. The earlier-successful-tree promise at :85 remains true. |
| Probe before secret copies | deploy/mcp-auth/OAUTH-RELEASE.md:311 | Baseline CA/route/gate probes now precede both env snapshots at :313 and :314. A probe failure leaves neither env copy in the stage. |
| Independent Docker-stub checks | tests/oauth-release-plan.test.ts:577 | Each unset assertion is a separate statement. The control at :584 reintroduces each interpolation key after the actual unset loop; both must fail, including MCP_OAUTH_IMAGE. |

Regression coverage:

- `tests/oauth-release-plan.test.ts:373`: execute OPEN from validated inputs
  through its first file writes. Four existing path types refuse before any
  write; the absent-path control reaches the real proof/inputs writes.
- `tests/oauth-release-plan.test.ts:399`: execute actual preflight archive
  admission, exclusive receipt writing and mkdir. Observe the mkdir boundary
  at :421 to prove the receipt already exists before tree creation.
- `tests/oauth-release-plan.test.ts:442`: rolled-back close refuses a recorded
  directory or dangling symlink, passes when that tree is absent, and permits
  an unrecorded path to remain.
- `tests/oauth-release-plan.test.ts:461`: open with an absent candidate, then
  optionally prepare the candidate through preflight. Abort, repeated aside
  and aborted close pass without recreation or rollback. The recorded tree
  moves; a window that never created a tree closes honestly.
- `tests/oauth-release-plan.test.ts:493`: unrecorded directories and symlinks
  survive repeated aside and aborted close. Wrong-path, symlink and directory
  receipts refuse before a move.
- `tests/oauth-release-plan.test.ts:515`: every baseline probe failure leaves
  no env snapshot. The positive control creates both exact snapshots and still
  exercises baseline, forward and recovery probes.
- `tests/oauth-release-plan.test.ts:562`: the real Compose helper preserves
  the fixture Docker client setting and clears interpolation overrides. Both
  deliberate reset controls fail under the strengthened stub.

Ran `node --import tsx --test tests/oauth-release-plan.test.ts`: exit 0.
`git diff --check` passed. Final test tail:

```text
✔ open refuses every existing release path before any file change, with absent-path control (233.218917ms)
✔ rolled-back close requires absence only for a receipt-backed tree, with absent-tree controls (162.62575ms)
✔ abort-before-attempt closes as aborted without recreate or rollback (729.187125ms)
✔ aside and recovered close leave unrecorded trees untouched, and reject unsafe receipts (479.520417ms)
✔ baseline probe failures refuse open and apply before the attempt; forward and recovery reuse the probes (1125.7705ms)
✔ ERR inside a helper function prints FAIL and STOP in every trapped block (21.204458ms)
✔ Compose helper preserves Docker client settings and clears file-derived interpolation overrides (76.665375ms)
ℹ tests 13
ℹ suites 0
ℹ pass 13
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 5429.6315
```

Regression run against the exact saved Round B plan (reconstructed from
`/Users/yulanbot/work/c1-next/OAUTH-RELEASE-B.diff`, verified SHA-256
`bf8fea30b4a2e50df06912a3b784b1076c02800dda996936c09bc7c5a9702555`)
exited 1:

```text
ℹ tests 13
ℹ pass 8
ℹ fail 5
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

Those five failures were: OPEN admitted an existing tree; close demanded
absence of an unrecorded tree; preflight reached mkdir without a receipt;
aside moved an unrecorded tree; failed probes left env snapshots.

Restoring the former `test -z … && test -z …` Docker stub as a deliberate
mutation exited 1 at the MCP_OAUTH_IMAGE reset control:

```text
✖ Compose helper preserves Docker client settings and clears file-derived interpolation overrides
ℹ tests 13
ℹ pass 12
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

Final plan and tests were restored byte for byte before the final passing run.
Saved nonsecret runs and snapshots are in `scratchpad/oauth-release-c/`.

The initial expanded fixture failed on macOS Python 3.9's missing
`tarfile.extractall(filter=...)` API. Its boundary now stops after receipt and
mkdir. Extraction, root ownership, Docker identity, live TLS and root-only
scratch deletion are not proven by this service-free gate; the production
extraction code was unchanged. Transport responses are public fixtures.

Against Round B: plan +21/-14 lines; test/support +131/-25 lines. No application
code changed. Existing reports and test-list entry remain unchanged. No full
suite, Docker, browser, box, Actions, Alloy or independent review was run.
No task step is blocked. Ready for HezLead's cross-family check.
