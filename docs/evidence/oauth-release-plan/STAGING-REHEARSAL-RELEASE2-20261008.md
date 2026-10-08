# OAuth release 2 staging rehearsal (2026-10-08)

Plan: `deploy/mcp-auth/OAUTH-RELEASE.md` at `6a72f8ea` (sha256 `51a182a82747f6a98d1e79f5034c2eec3d1b1623f3d00f0790deb6b2c41a77ca`), with the optional provider-list switch.
Release: mcp-auth image at `2ab464ae3630f89d0cf0db775ae603bd036f40e2` (main). Box: `c1-staging-20261006` (staging marker present). Runner: the staging kit's persistent Mac and box shells, which feed each block verbatim and stop at the first failure.

## Staging shape before the runs

- Staging was reset to snapshot M, then OAuth release 1 (`24b08c5a`, plan `1ed96941`) was applied forward with no provider step. Window STGBcT closed as success. So the baseline matches production after release 1: oauth at `24b08c5a`, `service.env` with the single `MCP_OAUTH_GOTRUE_PROVIDER=github` line.
- Production GoTrue reports github, google and email as enabled (HezLead measured this from public `/auth/v1/settings`). Staging GoTrue enabled only github and email.
- For runs 3 and 4, a reviewed staging reset fixup set Google values in GoTrue that are obviously fake:
  - client ID `fake-staging-google.apps.googleusercontent.invalid`;
  - a random secret that starts with `fake-staging-google-secret-`.
  - Maker: Codex. Check: Opus PASS. Fixup sha256: `e1847733908e804c2c4540eb6d5e42c5006a9d3cb643307f15f28fa03af66e67`.
  - Staging `/settings` then showed github, google and email as enabled.
- **A Google sign-in on staging cannot complete, because the client is fake. Only the provider chooser and the GoTrue settings gate were exercised.**

## Runs (provider list `google,github`, the exact production value)

| Run | Window | Path | Result |
| --- | --- | --- | --- |
| 2 | STGLCD | Negative control, before the fake Google fixup | `FAIL OAuth service.env: provider not enabled in GoTrue` in oauth-apply, before the attempt receipt. R0 abort, R2 aside and R4 aborted close passed. `service.env` sha256 unchanged (`7c19a150…`). Baseline `24b08c5a` healthy. |
| 3 | STGtR2 | Forward, then rollback (R1-R4) | Apply switched `service.env` `7c19a150…` → `4b8416c3…`. Measured: no single key, `MCP_OAUTH_GOTRUE_PROVIDERS=google,github`, root:root 0600, no "disagree" in the oauth logs. `2ab464ae` healthy, forward probes passed. The sign-in chooser was reached through local Caddy with a probe client and curl: "Sign in to CommonSwarm" with "Continue with Google" and "Continue with GitHub", in list order. Rollback restored the exact open bytes (`7c19a150…`, single key back, no list), and `24b08c5a` came back healthy. Recovery probes passed, and the rolled-back close was verified. |
| 4 | STG9Sd | Forward | Same switch (`7c19a150…` → `4b8416c3…`). `2ab464ae` healthy. Probes passed. Success close, with `service_env.ran=true` and both key names recorded. |

Run 1 means the release-1 forward runs that set the baseline: STGnru, and STGBcT after the fixup reset. A first try, STGKuc, stopped at oauth-archive because the runner started outside a git checkout (a runner launch error, not a plan issue). It closed through R0, R2 and R4 as aborted, with the baseline unchanged.

Close evidence for STGLCD, STGtR2 and STG9Sd is in the folders next to this file (`docs/evidence/oauth-release-2ab464ae…-<window>/`). It contains no secret values.

## Production notes

- Release 2 inputs: `release_sha` `2ab464ae3630f89d0cf0db775ae603bd036f40e2` and `service_env_provider_list` `google,github`. The baseline is `24b08c5a`, from release 1.
- Do not edit `service.env` by hand before open. Rollback restores the bytes saved at open, so release 1 gets its single key back.
