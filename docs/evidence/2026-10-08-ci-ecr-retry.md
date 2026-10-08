CI-ECR-RETRY maker report, 2026-10-08. Changes are uncommitted in
`/private/tmp/cs-ci-ecr`, branch `lane/ci-ecr-pull-retry`, based on `e6610a4c`.
No push, workflow dispatch, Docker, browser, or production operation was run.
HezLead owns the independent cross-family check and runner verification.

The boot helper previously pulled the pinned edge-runtime image once on every
boot. A public ECR limit therefore failed the boot tests even when a local image
could have been used. The patch shares the existing pg_cron test classifier and
retry policy with the boot helper and CI preparation script.

There are **3 pull attempts**, with **1,000 ms and 2,000 ms waits**, for a maximum
of **3,000 ms of backoff**. Each pull has a 180,000 ms process timeout; inspection
has a 10,000 ms timeout. The conservative combined process-timeout and backoff
budget is 553,000 ms, excluding process/scheduler overhead. Only stderr consisting
entirely of the existing ECR diagnostics is retried: `toomanyrequests: Rate exceeded`
or `toomanyrequests: Data limit exceeded`, with the existing optional Docker/daemon
prefixes and case-insensitive matching. Mixed errors, spawn errors, and signals
fail immediately. Exhaustion fails boot/CI preparation with the final diagnostic;
the pg_cron integration retains its explicit skip on persistent ECR limits.
Command execution and sleep are injectable in the shared helper.

Both `server` and `server-repeat` receive preparation before their local-stack
start steps. The script reads the image through the existing Compose parser;
the workflow does not repeat the tag. It checks `docker image inspect` against
that exact reference before pulling. The boot tests retain their container
`Config.Image` check against the Compose pin.

The cache key is
`${runner.os}-${runner.arch}-edge-runtime-v1-${sha256(imageReference)}`.
The current reference is `public.ecr.aws/supabase/edge-runtime:v1.73.13`, whose
SHA-256 is `a0890fb287e138d2b72403c847dc62639390a4f07dd93d9388ae0b4af2c1f91c`.
`actions/cache@v4` restores `${runner.temp}/edge-runtime-image.tar`; a cache hit
is loaded with `docker load`. A miss is inspected/pulled with the shared policy,
then archived with `docker save`; the cache action saves it after a successful
job. No restore-prefix key is used, so a changed image reference gets a new cache.

Changed files and entry points:

| File:line | Change |
| --- | --- |
| `tests/support/docker-image-pull.ts:4` | Shared attempt budget, original classifier, injected execution/sleep, final diagnostics, exact-reference inspection. |
| `tests/support/edge-runtime-function-boot.ts:155` | Async startup uses the shared image preparation at line 173. |
| `tests/p1-server/edge-runtime-function-boot.test.ts:132` | Both boot tests await async startup; second call is at line 164. |
| `tests/p1-cli/n-db-cron-jobs.test.ts:25` | Uses the shared pull at line 41; moves its five retry tests to the shared owner. |
| `scripts/ci-edge-runtime-image.mjs:6` | Compose-derived image metadata/hash and shared image preparation. |
| `.github/workflows/server-suite.yml:118` | Three new read/cache/prepare steps for both server modes. |
| `tests/support/docker-image-pull.test.ts:13` | Fifteen service-free cases covering recovery, errors, exhaustion, local presence, and a changed pin. |
| `tests/lists/test.txt:40` | Adds the shared tests to the explicit `npm test` gate. |
| `docs/evidence/2026-10-08-ci-ecr-retry.md:1` | This report. |

Tooling/workflow code: 43 lines added, none removed. Tests, support, and gate list:
199 lines added, 77 removed. These counts include the three new code files and
exclude this report. The original pg_cron retry cases now have one shared owner;
its database integration test is retained.

Verification performed:

- `npm ci --ignore-scripts --no-audit --no-fund`: exit 0, 111 packages installed
  in this worktree; no build or full suite run.
- `node --import tsx --test tests/support/docker-image-pull.test.ts tests/p1-cli/test-gate-coverage.test.ts`:
  exit 0. This confirms new tests are reached by the gate and type-check config.
  Final test tail:

  ```text
  tests 18
  pass 18
  fail 0
  cancelled 0
  skipped 0
  todo 0
  duration_ms 409.479208
  ```

- `node --import tsx --test --test-name-pattern='runtime 5xx|dummy edge env|compose.yaml is' tests/p1-server/edge-runtime-function-boot.test.ts`:
  exit 0; selects only the three service-free checks. Tail:

  ```text
  tests 3
  pass 3
  fail 0
  skipped 0
  duration_ms 833.249125
  ```

- Removing retries by temporarily changing the shared attempt budget to one
  causes 8 of 15 helper cases to fail, including recovery and exhaustion. The
  helper was restored byte for byte before the final passing run.
- `npm run check:tests`: exit 2, **53 existing diagnostics**. A TypeScript
  compiler-host comparison substituted the original HEAD contents for every
  changed TypeScript file and excluded new TypeScript files from the baseline
  roots. Baseline and current diagnostic lists are identical; no new errors.
  Representative final diagnostics remain TS5097 imports in the existing
  household server tests. Full current/baseline diagnostic logs are in the
  ignored `scratchpad/ci-ecr-retry/` directory.
- PyYAML parses the workflow. Removing exactly the three new steps from its
  parsed structure produces the baseline structure unchanged, including
  runner selection and every original step/setting.
- `node --import tsx scripts/ci-edge-runtime-image.mjs metadata`: exit 0;
  prints the Compose-derived reference and cache hash listed above.
- `node --check scripts/ci-edge-runtime-image.mjs`, `bash -n` on the new runner
  shell block, and `git diff --check`: exit 0.
- `actionlint` is not installed; that check was not run. No `src/` files changed,
  so the task's conditional root-source type-check was not required.

Real-runner verification remains: cold cache pull, Docker save/load, a warm cache
run with no network pull, the two complete boot tests, and `server-repeat`.
This patch does not change Supabase CLI's own image-pull logic or pins; any ECR
limit on a different image during `supabase start` remains outside this change.
Cache persistence depends on a successful job and the Actions cache service.
HezLead must arrange the independent review and an authorized runner run; CI
has not yet decided this patch.

## Retry B: corrupt-cache recovery (2026-10-08)

Reviewer defect repaired. Round-A changes remain uncommitted. No commit, push,
workflow dispatch, Docker execution, browser, or production operation was performed.

| File:line | Round-B diff |
|---|---|
| `.github/workflows/server-suite.yml:137` | Tracks whether the archive needs saving. Load failure or a successful load missing the exact Compose-derived reference emits one warning and continues to bounded preparation. A successful recovery rewrites only the owned archive with `docker save`; a valid warm archive avoids pulling and saving. No deletion is introduced. |
| `tests/support/docker-image-pull.test.ts:133` | Five table-driven cases execute the actual workflow shell and real `ensure` entry point with stubbed Docker: cold, warm, load failure, successful load with another image, and corrupt cache plus exhausted ECR pulls. They verify exact-image presence, refreshed archive bytes, one recovery warning, preservation of an unrelated file, and clear failure after three pulls with no save. |
| `docs/evidence/2026-10-08-ci-ecr-retry.md:113` | This round-B report. |

Round-B code delta: workflow +7/-2; test file +111/-4 (including imports).
No production helper or test gate changes were needed in this round.

The requested focused command ran with a PATH-first Docker-unavailable stub,
so the pg_cron integration preflight skipped without executing Docker:

```sh
env PATH="/private/tmp/cs-ci-ecr/scratchpad/ci-ecr-retry-b/no-docker:$PATH" node --import tsx --test tests/support/docker-image-pull.test.ts tests/p1-cli/n-db-cron-jobs.test.ts
```

Final exit 0; tail:

```text
workflow image preparation handles cold: pass
workflow image preparation handles warm: pass
workflow image preparation handles corrupt archive: pass
workflow image preparation handles archive without the exact pin: pass
workflow image preparation handles corrupt archive and exhausted pull: pass
tests 21
pass 20
fail 0
cancelled 0
skipped 1
todo 0
duration_ms 4876.520042
```

Mutation proof: replacing only the repaired shell with the original unguarded
load and cache-hit-based save condition caused the requested focused command
to exit 1. Cold and warm remained positive controls; all three recovery cases
failed (the load-error cases never reached pull). Tail:

```text
tests 21
pass 17
fail 3
cancelled 0
skipped 1
todo 0
duration_ms 1477.440458
```

The workflow was restored byte for byte, checked by SHA-256, before the final
passing command. PyYAML parsing, `bash -n` on the parsed prepare script, and
`git diff --check` passed. Logs are retained in the ignored
`scratchpad/ci-ecr-retry-b/` directory (`pre-fix-tests.log`,
`focused-tests.log`, `mutation-tests.log`, and `final-tests.log`).

These tests prove the workflow shell and bounded preparation under the Docker
stub. Actual Docker archive handling and Actions cache upload remain runner
checks. The local archive is rebuilt after recovery; the existing
`actions/cache@v4` exact-key hit is immutable and is not overwritten remotely
by this step. A corrupt remote hit can recur, but now falls back safely.
HezLead owns the independent review and any authorized runner run.

BLOCKED by filesystem sandbox: “sandbox-exec: sandbox_apply: Operation not permitted”. To resolve: avoid a nested sandbox and use the worker's existing environment; completed. The unused profile remains at `scratchpad/ci-ecr-retry-b/checks.sb`.
