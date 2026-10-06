# Lane 5 Fold 3 CI repairs

DRAFT; not release-ready. Base HEAD `d048338f`, branch `lane/hh-lane5-invite`.
No commit, push, Actions dispatch, Alloy, production contact, deployment,
service restart, browser launch or secret retrieval. HezLead owns independent review.

| Test | Cause with file:line | Fix |
| --- | --- | --- |
| Server #185 `connect loop invites, accepts, creates a principal, and mints a narrow token`; #187 `forwarded invitation has exactly one atomic accept winner` | Base `supabase/functions/command/index.ts:10595`: unconditional legacy consent refusal prevented every `accept_invitation` from reaching its existing route/reducer/atomic consumption. These fixtures have no household boundary. | At `command/index.ts:10633`, require review only when the resolved workspace has a household boundary. Shared, personal and unconfirmed boundary rows remain fenced. Generic connect-loop acceptance resumes its original route. Agent credential admission, consumption, reducer, receipts and principal/token creation are unchanged. Both existing server tests are byte-unchanged; local execution is infrastructure-blocked, not PASS. |
| Server #181 `pre-route capability mint and invitation acceptance refuse archived workspaces` | Base `supabase/functions/command/index.ts:10595`: consent refusal preceded `resolveInvitationRoute`, which already excludes archived workspaces at `command/index.ts:3229`. | Move the conditional fence after live routing and revocation. Archived/unknown routes return exactly `{error:"forbidden"}` without a consent query or join write. The unchanged server test also retains its live acceptance positive. Bundled HTTP admission regression passes; real DB execution is blocked. |
| Site #523 `browser recipient invitation entry bundles without Node-only CLI build dependencies` | Base `site/src/lib/human-invitations.test.mjs:31`: `site/src/...` entry point was relative to cwd; the site runner already runs inside `site/`. | At `human-invitations.test.mjs:32`, resolve the existing entry file from `import.meta.url`. Keep the same esbuild browser platform, bundle settings and nonempty-output assertion. Passes from repository root and `site/`. The Node URL import is only in the test runner; browser production imports are unchanged. |
| Citation regression from this edit | `tests/p1-cli/citation-drift.test.ts:112`, `:133`: moving the fence adds three handler lines, moving the mint horizon and agent scope targets. | Re-measure both targets and update the three citing comments in `site/src/lib/agent-connect.ts`. Preserve all citation assertions; final file passes. |

The household HTTP test retains its exact consent response, audit and no-membership/
consumption-write assertions, and expands the required cases to shared, personal
and unconfirmed boundaries. It also retains a no-overlay enrollment refusal on
the explicit household review path. The previous expectation that every generic
legacy invitation needs household consent was the regression identified by this
brief; the generic path now has a distinct normal-validation control. No assertion
in `tests/p1-server/command.test.ts` changed. No test file or test-list entry was
created. One routing regression case was added to the existing unit file.

Both reported failure modes were reproduced against original HEAD: `routing-before`
exits 1 on archived refusal (consent instead of forbidden); `browser-before` exits 1
from `site/` on the unresolved entry path. Restored files byte-for-byte afterward.
The new cases use the actual bundled HTTP handler with inert GoTrue/database
transports. They prove admission with supplied route facts, not SQL execution or
actual GoTrue verification. Existing server tests own real acceptance/concurrency.

| Gate / probe | Exit | Result |
| --- | ---: | --- |
| `npm run build:command-core` | 0 | Core/declarations generated; no tracked generated diff. |
| `npm run build` | 0 | Root TypeScript build. |
| `npm run check:edge`, final | 0 | All configured entry points. |
| `npm run check:tests`, final | 2 | Eight diagnostic lines byte-identical to Fold 2; gate still fails. |
| Direct focused root/CLI/site/citation files, final | 0 | 66/66 pass, no skips. |
| Direct site invitation file from `site/`, final | 0 | 4/4 pass, including the browser bundle. |
| Direct three named server regressions, unchanged file | 1 | Three setup failures: `supabase status -o json` fails; no database scenario executed. |
| Direct household human-invitation server file | 1 | Docker guard and unavailable local Supabase block both cases before SQL. |
| Initial citation check | 1 | Two moved references; fixed, included in final focused PASS. |
| Original-handler routing regression | 1, expected | Reproduces consent-before-archive defect. |
| Original browser bundle case from `site/` | 1, expected | Reproduces unresolved entry point. |
| `git diff --check` | 0 | Final whitespace check. |

Every gate ran directly through `env HOME="$T"`, where `T` was a fresh absolute
`mktemp -d /private/tmp/lane-home.XXXXXX` directory; shell HOME was never assigned.
Deno used the existing explicit cache. No full suite ran. All 16 owned disposable
homes were enumerated, resolved and removed through the PATH rm guard after six
unsafe/unowned path controls refused. Existing ignored dependencies, build outputs
and scratchpad logs remain. Evidence is in `fold3/`; `fold3-files.txt` is the exact
incremental file inventory.

Final focused invocation:

```sh
env HOME="$T" node --import tsx --test --test-concurrency=1 tests/household-human-invitations.test.ts tests/p1-cli/human-invitations.test.ts tests/p1-cli/citation-drift.test.ts tests/p1-cli/file-create-rate-limit.test.ts site/src/lib/human-invitations.test.mjs site/src/components/connect/agent-connect-mint.observer.test.ts
(cd site && env HOME="$T" node --import tsx --test src/lib/human-invitations.test.mjs)
env HOME="$T" node --import tsx --test --test-concurrency=1 --test-name-pattern='pre-route capability mint and invitation acceptance refuse archived workspaces|connect loop invites, accepts, creates a principal, and mints a narrow token|forwarded invitation has exactly one atomic accept winner' tests/p1-server/command.test.ts
env HOME="$T" node --import tsx --test tests/p1-server/household-human-invitations.test.ts
```

Files changed and why:

- `supabase/functions/command/index.ts`: scope and reorder legacy consent fence.
- `site/src/lib/human-invitations.test.mjs`: cwd-independent browser entry resolution.
- `tests/household-human-invitations.test.ts`: retain household consent protections,
  add archived/unknown/generic admission controls; no production test seam.
- `site/src/lib/agent-connect.ts`, `tests/p1-cli/citation-drift.test.ts`: measured
  pointer updates only; no behavior or assertion relaxation.
- `docs/evidence/2026-10-04-household-lane5/LEAD-CHECKLIST.md`, this report,
  `fold3-files.txt`, `fold3/*.txt`: current compatibility, limits and measured evidence.

Incomplete: unchanged real server tests, SQL/ACL/inverse/concurrency proof,
HezLead's cross-family review and the existing C1/JWT/sign-in/OAuth/private-space/
actual-host evidence gates. No migration, privilege, OAuth scope, provider or
recipient consent implementation changed. Generic capability acceptance retains
its historical forwarded-link behavior only outside household boundaries. Review
boundary provisioning and content-consent checks during C1 reconciliation. Existing
release order stays in force; this draft is neither landed nor released.
