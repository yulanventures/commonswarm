# Lane 5 security fold

DRAFT; not release-ready. Base HEAD `fdcd62bf4567e60af22a8a297a1490a40efd56ee`.
No commit, push, workflow dispatch, deployment, production contact, browser,
Alloy run, or secret retrieval. HezLead owns independent cross-family review.

| Finding | Verification and fix | Test / result |
| --- | --- | --- |
| MUSTFIX: server ACL/inverse/serialization proof unexecuted | Confirmed verification gap. Retried the two focused server files. The installed Docker guard explicitly disables containers on this Mac mini; local Supabase is unavailable. Left migrations, guard and server proofs intact. Cannot clear this finding here. | Server gate exit 1: all 13 cases fail during infrastructure setup; no SQL scenario executed. See `fold/server.txt`. HezLead must arrange the authorized CI database gate. |
| MUSTFIX: invitation inbox accepts unverified humans | Confirmed in `read/index.ts` before its read transaction. Require a non-null, defined `email_confirmed_at`, matching command identity verification; refuse with `human_sign_in_required` before metadata queries. | Real bundled HTTP handler refuses missing/null confirmation before any database call; confirmed recipient reads the inbox in the same invocation. Failed on actual HEAD (200 metadata disclosure), passes after fix. |
| MUSTFIX: legacy acceptance bypasses review without a household row | Confirmed conditional fence. Require `recipient_consent_required` for every legacy `accept_invitation`, with audit and `/invite` guidance, regardless of boundary presence. Updated review continues to require verified recipient consent and explicit Shared settings. | Real bundled command HTTP handler tests boundary present/absent and refusal audit with no join writes. Same invocation first reaches the actual consent-review preview. Actual HEAD passes configured fence but fails absent-boundary refusal; fixed code passes both. |
| NOTE: unused reserved migration IDs | Only 06 is needed for the recipient inbox function. 07–09 remain unused and reserved; no extra schema/rollback is warranted. Existing checklist already says this. | Existing migration inverse/release-copy test passes; no SQL catalog proof claimed. |
| NOTE: test type-check fails | Eight diagnostic lines still exactly match the previously recorded baseline. None refer to this fold's files. Left unrelated code intact. | `check:tests` exit 2; see `fold/check-tests.txt`. This remains a failing gate. |
| NOTE: Shared prerequisite appears only after failure | Added owner-confirmed Shared settings guidance in the invitation's sign-in view, before review/join. | Existing invite site tests and touched Astro compiler transform pass. No actual browser/sign-in proof. |
| NOTE: localStorage capability resume exposure | Retained existing resume behavior and its documented XSS/shared-device risk. Changing credential storage/lifecycle is outside this small security repair. | Existing fragment/resume-cleanup tests pass; no new storage claim. |
| NOTE: end-to-end release evidence incomplete | Retained DRAFT status and C1/release gates. | Actual JWT verification, recipient OAuth, personal-space negative reads and agent-host connection evidence remain unmeasured. |

Changed files and purpose:

- `supabase/functions/read/index.ts`: verified identity admission for inbox metadata.
- `supabase/functions/command/index.ts`: unconditional legacy acceptance consent fence.
- `tests/household-human-invitations.test.ts`: two HTTP admission regression tests,
  using the real entry points and inert external auth/database transports. No
  production test seam or new test file; test lists unchanged.
- `site/src/components/invite/InviteOnramp.astro`: proactive Shared prerequisite copy.
- `LEAD-CHECKLIST.md`, this report and `fold/*.txt`: current limits, regression
  baseline and gate evidence. Core regeneration produced no tracked artifact diff.

Regression evidence: `fold/regressions-before.txt` ran both tests against the actual
HEAD handlers, restored the repair byte for byte afterward, and exited 1 (both
failed for the intended admission reasons). `fold/focused.txt` ran the repaired
handlers with the other lane tests and read-handler regressions: **44/44 passed**,
no skips. These tests prove dispatch/admission with supplied transport facts,
not real GoTrue or PostgreSQL behavior. The SQL/transaction test remains the owner
of least-privilege, catalog/inverse and concurrent consumption proof.

Each gate ran directly through `env HOME="$T"` after
`T=$(mktemp -d /private/tmp/lane-home.XXXXXX)` (a local variable, never a shell HOME
assignment). Deno reused the existing explicit cache. No full suite ran.
All 13 disposable homes created in this pass were enumerated and removed through
the PATH `rm` guard after validating their resolved parent and ownership. Six
unsafe/unowned path controls failed validation. Existing scratchpad and dependency
copies from the draft were left in place.

| Gate | Exit |
| --- | ---: |
| `npm run build:command-core` | 0 |
| `npm run build` | 0 |
| `npm run check:edge` | 0 |
| `npm run check:tests` | 2 |
| Direct Node focused root/CLI/site/read tests | 0 |
| Direct Node human-invitation/storage server tests | 1 |
| Touched Astro compiler transform | 0 |
| Deno server-harness check | 0 |
| `git diff --check` | 0 |

Exact focused invocation:

```sh
env HOME="$T" node --import tsx --test tests/household-human-invitations.test.ts tests/p1-cli/human-invitations.test.ts tests/p1-cli/admin-routine.test.ts tests/p1-cli/admin-protocol-bundle.test.ts site/src/lib/human-invitations.test.mjs site/src/components/invite/member-invite.observer.test.ts tests/read-handler-main-only.test.ts tests/read-edge-diagnostics.test.ts
env HOME="$T" node --import tsx --test tests/p1-server/household-human-invitations.test.ts tests/p1-server/household-storage.test.ts
```

C1 conflicts remain at `command/index.ts` authentication/routing and
`read/index.ts` admission. Preserve both new fences when reconciling. OAuth
changes: none. Schema/privilege changes in this fold: none.

Compatibility risk: all old CLI/API acceptance now requires `/invite`, including
generic workspaces with no household row. Their owners must confirm Shared
settings before new recipient review can succeed. Site/edge must be released
together after the original release order and all outstanding proof gates.
The server MUSTFIX is still open; no security PASS or release approval is claimed.
