# Lane 5 Fold 2 CI repairs

DRAFT; not release-ready. Base `09dc6c1c`, branch `lane/hh-lane5-invite`.
No commit, push, Actions dispatch, production contact, deployment, service restart,
browser launch, secret retrieval or Alloy run. HezLead owns cross-family review.

| Test | Cause with file:line | Fix and result |
| --- | --- | --- |
| `every file:line this lane cites still points at what it claims` (unit and p1-cli) | `tests/p1-cli/citation-drift.test.ts:112`: lane-5 imports/admission moved the cited command handler lines by 2 or 21. The actual scope-check comment also retained an older pointer. | Re-measured each moved target; updated the table and citing comments in `agent-connect.ts`, the mint observer and command resume comment. Citation file 5/5 pass; all assertions retained. |
| `acceptable-use comment cites active lines for file caps and index.ts limits` | `site/src/pages/acceptable-use.astro:5`: stale command-handler enforcement pointers, including workspace, signal, TTL, about and until bounds. | Update the pointers only. The complete file-create-rate-limit file passes 41/41. |
| `the client build helper owns the source and every command envelope uses it` | Original envelope at `src/cloud/human-invitations.ts:17` lacked `withClientBuild` and duplicated the protocol version. | CLI wrapper now uses `withClientBuild` and `CLIENT_PROTOCOL_VERSION` at `src/cloud/human-invitations.ts:9`. Shared transport is extracted; browser supplies its existing `WEB_CLIENT_VERSION`. Add the constructor to the exact expected set; never remove the unwrapped-envelope guard. Presence file 6/6 pass. |
| `timeout inventory and mapping are exact in both directions`; `main alias validates the post-merge HEAD inventory`; `runTable does not write to the origin and will not PASS` | New 30-second timers, now at `src/cloud/human-invitation-transport.ts:13` and `:37`, were absent from the HEAD mapping. | Add both exact IDs at `scripts/timeout-table/mapping.json:3461`, with distinct command/read endpoints and truthful `not-run` classifications: this agent-profile runner cannot authenticate as the recipient. No operation or write probe added. The shipped v0.1.71 section is byte-identical. Timeout file 29/29 pass. |
| `human invite delivery grants only recipient function execution` | Original `auth.uid()` call in migration 06 ran as SECURITY DEFINER owner `swarm_admin`; repository grants give it no USAGE on `auth`. Caller already has USAGE on `swarm_read` and function EXECUTE. See `supabase/migrations/20261004000006_household_human_invitations.sql:16`. | Remove the unnecessary auth-schema dependency: read verified JWT `sub` directly, matching the existing human recovery reader. No grant widened. Update function-body hash in both catalog copies; additionally pin caller schema USAGE, absence of CREATE, and exactly owner/read-role EXECUTE ACLs. Keep both verbatim rollback copies unchanged. SQL proof unexecuted locally. |
| `real human join adapter serializes consumption, preserves ...` | `tests/p1-server/household-human-invitations.test.ts:48` compares the Deno **process exit status**, not a consumption count. `tests/support/household-human-invites-server.mjs:58` calls the same broken inbox function before transaction/concurrency assertions. Its old catch discarded the underlying failure. | Migration repair removes that shared blocker. Add fixed phase/SQLSTATE/numeric-only failure diagnostics; keep every concurrency, rollback, receipt and consent assertion and all adapter locks. The supplied CI log cannot prove or exclude a second defect. Final real-database run is still required. |

The SQL repair deliberately adds no auth-schema grant. The existing reasoned
allowlist entry still names only `swarm_read` EXECUTE on this function. Its reason
now names verified JWT-sub delivery and the lack of a new auth-schema grant.
Migration IDs 07–09 remain unused. Reserve/release rollback and rollback-catalog
copies are unchanged and match; the service-free inverse/copy test passes.
No migration was applied locally or to production.

| Gate | Exit | Measured result |
| --- | ---: | --- |
| `npm run build:command-core` | 0 | Generated core/types; no tracked generated-artifact difference. |
| `npm run build` | 0 | Root build. |
| `npm run check:edge` | 0 | All configured entry points. |
| `npm run check:tests` | 2 | Eight diagnostics byte-identical to the previous fold's recorded output, outside this delta. This gate remains failing. |
| Direct focused root/CLI/site files | 0 | 71/71 pass, no skips. |
| Direct timeout-table file, final | 0 | 29/29 pass, no skips. Initial exit 1: isolated checkout lacked main/origin/main. Fetched origin/main at `61f187c5`; no branch checkout or test change. |
| Direct human-invite and issuer-privilege server files | 1 | Docker guard/local Supabase prerequisite blocks all three cases before SQL. No ACL/catalog/inverse/concurrency PASS claimed. |
| Deno check of real database harness | 0 | Harness imports/types; not database execution. |
| `bash scripts/build-release.sh` | 0 | Executable single-file CLI bundle/checksum. |
| CLI regression on original HEAD client | 1, expected | New assertion fails because preview/retry bodies lack canonical client_build. |
| Browser mutation importing CLI wrapper | 1, expected | Browser build refuses node:fs/node:crypto. Restored both mutated files byte-for-byte. |
| Direct client/browser tests after restoration | 0 | 7/7 pass. |
| `git diff --check` | 0 | Final whitespace check, including report. |

Exact focused command:

```sh
node --import tsx --test --test-concurrency=1 tests/p1-cli/citation-drift.test.ts tests/p1-cli/presence-client.test.ts tests/p1-cli/file-create-rate-limit.test.ts tests/p1-cli/human-invitations.test.ts tests/household-human-invitations.test.ts site/src/lib/human-invitations.test.mjs site/src/components/connect/agent-connect-mint.observer.test.ts
node --import tsx --test tests/p1-cli/timeout-table.test.ts
node --import tsx --test --test-concurrency=1 tests/p1-server/household-human-invitations.test.ts tests/p1-server/admin-issuer-privileges.test.ts
```

Each gate used a fresh absolute `/private/tmp/lane-home.XXXXXX` through
`env HOME="$T"`; no shell HOME assignment. Deno used the explicit existing cache.
No full suite ran. Logs are in `fold2/`. 16 owned temporary homes were removed. Final temporary-home cleanup used the PATH
rm guard after enumerating owned paths, resolving each parent and passing positive
and negative path controls. Existing ignored dependencies, dist/dist-release and
scratchpad logs remain. The new transport has intent-to-add only so the tracked
source timeout enumerator includes it; there is no staged commit.

New tests: **no new test file and no test-list change**. Added one browser-bundle
case to the existing site file and canonical-build assertions to the existing CLI
retry case. Existing constructor/citation inventories were extended/re-measured;
no checks weakened. Browser test owns the distinct browser dependency boundary;
CLI wire assertion owns the emitted build field. No production-only testing seam
was added: CLI and browser both use the shared envelope callback.

Incomplete: HezLead's cross-family review and authorized real server run. The
second harness failure has a demonstrated shared dependency but no surviving
inner diagnostic; do not claim consumption is proved or that every possible server
failure is fixed. The existing C1, real JWT/sign-in/recipient-consent/OAuth,
private-space denial, and actual-host gates stay open. Existing release order is
unchanged: close C1, reconcile/review/CI, land exact reviewed SHA, then authorized
schema/edge/site release. OAuth changes: none.

Files changed since `09dc6c1c` follow. `fold2/` files retain the measured logs.

37 files total.

- `deploy/release-proofs/household-invites/20261004000006-catalog.sql`
- `docs/evidence/2026-10-04-household-lane5/FILES.md`
- `docs/evidence/2026-10-04-household-lane5/FOLD2-REPORT.md`
- `docs/evidence/2026-10-04-household-lane5/LEAD-CHECKLIST.md`
- `docs/evidence/2026-10-04-household-lane5/fold2/baseline.txt`
- `docs/evidence/2026-10-04-household-lane5/fold2/browser-mutation.txt`
- `docs/evidence/2026-10-04-household-lane5/fold2/build.txt`
- `docs/evidence/2026-10-04-household-lane5/fold2/check-tests.txt`
- `docs/evidence/2026-10-04-household-lane5/fold2/client-browser-after.txt`
- `docs/evidence/2026-10-04-household-lane5/fold2/client-regression-before.txt`
- `docs/evidence/2026-10-04-household-lane5/fold2/core.txt`
- `docs/evidence/2026-10-04-household-lane5/fold2/edge.txt`
- `docs/evidence/2026-10-04-household-lane5/fold2/focused.txt`
- `docs/evidence/2026-10-04-household-lane5/fold2/gate-exits.txt`
- `docs/evidence/2026-10-04-household-lane5/fold2/harness-parse.txt`
- `docs/evidence/2026-10-04-household-lane5/fold2/release-bundle.txt`
- `docs/evidence/2026-10-04-household-lane5/fold2/server.txt`
- `docs/evidence/2026-10-04-household-lane5/fold2/timeout-final.txt`
- `scripts/timeout-table/mapping.json`
- `site/src/components/connect/agent-connect-mint.observer.test.ts`
- `site/src/lib/agent-connect.ts`
- `site/src/lib/human-invitations.test.mjs`
- `site/src/lib/human-invitations.ts`
- `site/src/lib/human-invite-controller.ts`
- `site/src/pages/acceptable-use.astro`
- `src/cloud/human-invitation-transport.ts`
- `src/cloud/human-invitations.ts`
- `supabase/functions/command/index.ts`
- `supabase/household-invite-reserve/20261004000006-catalog.sql`
- `supabase/migrations/20261004000006_household_human_invitations.sql`
- `tests/p1-cli/citation-drift.test.ts`
- `tests/p1-cli/human-invitations.test.ts`
- `tests/p1-cli/presence-client.test.ts`
- `tests/p1-server/household-human-invitations.test.ts`
- `tests/support/admin-issuer-privileges.json`
- `tests/support/household-human-invites-server.mjs`
- `docs/evidence/2026-10-04-household-lane5/fold2-files.txt`
