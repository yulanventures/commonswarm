# OAuth release staging rehearsal at 24b08c5a49362ac089a679a4be79cfff6876befb (2026-10-08)

Plan: deploy/mcp-auth/OAUTH-RELEASE.md (this commit). Box: c1-staging-20261006, from snapshot M (OAuth baseline 1388b0ee73b76de111f9fabf196ed916566c37fd, image sha256:be75e0b3…).

- Run 1 (STGsbX): stopped at oauth-root-shell before any box change: Mac `ssh "$BOX_HOST" hostname` without -n swallowed the pipe-fed shell's stdin. Fixed in this commit (`ssh -n` at the two Mac call sites, new test); Opus delta check PASS.
- Run 1b (STG1Lg): root-shell, open (baseline probes PASS), archive, preflight, build, apply, then the rollback path: oauth-rollback, oauth-release-aside, oauth-probes PROBE_PHASE=recovery, oauth-close CLOSE_RESULT=rolled-back, copyback: all exit 0. Baseline restored exactly (current 1388b0ee…, image be75e0b3…, compose.env sha unchanged).
- Staging reset to snapshot M.
- Run 2 (STG2zo): root-shell, open, archive, preflight, build (reuse of the label-verified image), apply, oauth-probes PROBE_PHASE=forward, oauth-close CLOSE_RESULT=success, copyback: all exit 0. Live after: oauth/current = releases/24b08c5a…, image revision label 24b08c5a…, healthy.
- Staging reset to snapshot M afterwards (record ~/work/c1-verify/runs/STAGING-STATE-M-20261008b.json).

`git diff --stat 24b08c5a49362ac089a679a4be79cfff6876befb 26eb7e9f -- services/mcp-auth` is empty: main 26eb7e9f carries the identical OAuth image tree.

Follow-up (not a defect of the close): the uploaded /tmp/oauth-<sha>-<window>.tar and .ancestry.json stay on the box after close (~100 MB per release); the plan does not say whether to keep or remove them.
