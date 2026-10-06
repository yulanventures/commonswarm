# Household integration worker report — 2026-10-04

**Security fold update:** [FOLD-REPORT.md](FOLD-REPORT.md) records the fixes
against `92a21537` and supersedes this original report's reachability and gate
results. The two legacy entry paths now have separate default-OFF server gates.
The three unfinished hosted file tools are excluded from admission by their own
default-OFF server gate. None may be activated before the checklist prerequisites.
The remaining integration limitations below still apply.

**Result: reviewable draft implementation, incomplete end-to-end integration.**
The branch remains uncommitted and unpushed. Do not activate this packet: the
legacy adoption/result bridge and protected file delivery are incomplete.

Starting SHA: `38986a9aa6c2fd8d92ee138efc87f6fe48921a69`.
Branch/worktree: `lane/hh-int-packet`, `lanes/hh-int-packet`.
Read the worker rules, workspace/repository/site instructions, household plan
and spec, simplification state and C1 admin issuance direction. Used the
test-audit authoring gate. No Alloy or additional agents; HezLead owns review.

## Changes prepared

The shared protocol exports the household core and registry. Command dispatch
reuses verified human/local/hosted identity and the existing transaction, and
routes structured object operations through the household reducer/store.
Content reads verify stored size/digest and current rights, project safe
metadata, and decode bounded doc/list content. Structured conflicts expose the
requester's retained draft, base and current revision. Upload preparation
accepts separately bounded multipart bytes and does not fabricate a committed
revision from a reservation. Host identities, storage keys and transfer secrets
are absent from model schemas/results.

Hosted admission is generated from the eight-operation registry; writes are
never read-only. Capabilities stay bound to their actual tool while using the
existing database identity resolver and live provider/parent checks. The store
separately enforces content consent and operation ceilings. No OAuth scopes or
provider consent/binding implementation changed.

Local MCP and `cswarm object <registry-tool> --input-file <path>` use the 6A
client and authenticated HTTP transport. Authentication refreshes per attempt;
retry IDs, workspace/revision bindings and closed outcomes are preserved.
The dashboard imports 6B, loads all object pages within the shared quota,
offers explicit purpose/reader/editor/connection confirmation, and clears
content on workspace/session changes. Its consent copy names the 24-hour
hosted and credential-bound local expiry.

Migration 05 adds three INSERT and eight column UPDATE ACL entries, each with a
reason in the issuer allowlist. Provisioning is human-only and confirms only
the caller's role and owned live connection. The digest includes workspace ID.
An invoker trigger requires authenticated transaction provenance and appends
immutable audit rows. No rights are backfilled, and existing purpose/bindings
stay immutable through this route. Reserve/release copies match; the commented
inverse is verbatim. Catalog 01 must run before overlay 05; reverse drills undo
05 first. The touched storage test now accounts for that order.

The [complete path inventory](FILES.md) describes each changed/new file.
The [Lead checklist](LEAD-CHECKLIST.md) identifies C1 conflict functions and release order.

## New tests and registrations

| New file | Distinct contract | Registration |
| --- | --- | --- |
| `tests/household-integration.test.ts` | Actual hosted table validation/annotations; positive protected multipart bytes and negative foreign/extra parts. | Added only this new path to `tests/lists/test.txt`. |
| `tests/p1-cli/household-integration.test.ts` | Actual loopback HTTP dispatch, profile/workspace/request IDs, per-attempt authentication, no duplicate known commit, shipped CLI help. | Existing `test:p1-cli` glob. |
| `site/src/lib/household-dashboard.test.mjs` | Late authenticated loads cannot repopulate another workspace; refusal stops before object reads. | Existing site `src/lib/*.test.mjs` glob. |
| `tests/p1-server/household-permission-provisioning.test.ts` | Real PostgreSQL grant/provenance/self-confirmation/audit/rollback proof in isolated schemas. | Added only this new path to `tests/lists/test:p1-server.txt`; expansion deduplicates its existing glob. Not run locally. |

Touched test files: `tests/hosted-mcp-protocol.test.ts` preserves the original
eight coordination-tool assertions while admitting sixteen total tools;
`tests/p1-server/household-storage.test.ts` removes migration 05's overlay
inside the rolled-back catalog drill. No existing test path was added to a list.

## Measured local gates

Every gate ran directly under `env HOME="$T"`, after
`T=$(mktemp -d /private/tmp/lane-home.XXXXXX) || exit 1`.
Dependencies were initially absent; root/site dependencies were installed with
`npm ci --ignore-scripts --no-audit --no-fund` under temporary homes.

| Gate | Final exit | Evidence |
| --- | --- | --- |
| `npm run build:command-core` | 0 | Regenerated protocol JS and eleven declaration outputs. |
| `npm run build` | 0 | CLI/source TypeScript build. |
| `npm run check:edge` | 0 | All eight configured activated entry points. |
| `npm run check:tests` | 2 | Eight pre-existing diagnostics; [current output](check-tests-current.txt), [starting-SHA output](check-tests-baseline.txt). |
| Focused `node --import tsx --test` invocation below | 0 | [148 passed, zero failures/skips](focused-tests.txt). |
| `node services/mcp-auth/build-management.mjs` | 0 | Regenerated ignored management artifact from current command source. |
| Direct Astro compiler transform of `LiveDashboard.astro` | 0 | Component compiled; this is not a site build/browser test. |
| `bash scripts/build-release.sh` | 0 | Executed standalone bundle reports 0.1.80; checksum `57d29d4856dadfbb42b4ab807ae01d72118320b112fa5033b89ffc0c932b52c2`. |

Focused invocation (all ten paths exist):

```sh
env HOME="$T" node --import tsx --test \
  tests/household-integration.test.ts tests/hosted-mcp-protocol.test.ts \
  tests/household-objects.test.ts tests/household-tool-registry.test.ts \
  tests/household-legacy-adapter.test.ts tests/p1-cli/household-client.test.ts \
  tests/p1-cli/household-integration.test.ts tests/p1-cli/mcp-stdio.test.ts \
  site/tests/household-objects-view.test.ts site/src/lib/household-dashboard.test.mjs
```

The baseline type check used a clean archive of the exact starting SHA with the
same installed dependencies. Both fail at `site/tests/chrome.ts` (one execFile
overload, three implicit-any parameters), the two existing `npm:postgres` type
imports, `tests/admin-release-plan.test.ts` (tuple cast), and
`tests/p1-cli/h0-link-join-limits.ts` (import/local name collision).
These unrelated errors were left intact.

## Open risks and work not completed

1. **Protected file transport remains incomplete.** The server can stage a
   protected multipart attachment, but local/hosted MCP and the new CLI JSON
   route do not supply a host attachment. Upload-begin refuses without bytes.
   `file_read` verifies bytes but returns metadata only; no protected download
   channel or file-draft recovery is exposed. Do not describe files as usable
   end to end from these tools.
2. **Legacy parity remains incomplete.** The adapter is wired for managed
   objects, including brain names, exact versions and a transactional receipt
   bridge. Opted-in old file commands cannot use their prior scope exemption.
   Existing unmanaged files/brain history are not adopted into private reducer
   history, and existing CLI/file/brain request and result decoders have not
   been converted to the adapter's closed outcomes/attachment protocol. The
   separate `household_legacy` route is preparation, not compatibility proof.
   Existing workspaces must not opt in before adoption/parity is settled.
3. **No served HTTP/PostgreSQL permission parity run.** Focused tests prove
   client dispatch, registry admission and existing pure policy/adapter
   behavior. The new server test proves database grants/audit when CI runs; it
   does not yet exercise all hosted/local/human content routes together.
   Reserved SQL catalogs and inverses have not executed on PostgreSQL locally.
4. **Browser/site suites remain CI work.** The dashboard is compiler-checked
   and its lifecycle tests pass; live navigation, consent, reader/editor,
   historical saves, conflicts and file interactions need browser coverage.
   Loading each object's current content/history is sequential and can be slow
   near the 500-object quota.
5. **Activation requires C1 reconciliation and review.** Reconcile the shared
   authentication/dispatch/type-generation/issuer surfaces, verify early
   refusals and abnormal failures against the durable metering/audit contract,
   and regenerate bundles afterward. Existing admin B/C/D code and OAuth
   scopes were not rewritten. Hosted content approval expiry is a draft
   24-hour choice for Lead review; local credential rotation requires fresh
   content confirmation.

No full local suites, Docker services, production operations, credential-store
reads, browser launches, GitHub calls, commits, pushes or CI dispatch occurred.
No release or activation is claimed. HezLead arranges the cross-family check,
CI and any later authorized release through Anvil.

Automatic approval review rejected cleanup of the worker-created baseline
archive `/private/tmp/household-baseline.KJZavk`: “rm -f style commands are not
permitted. Use a safer approach”. The archive remains in place; the refusal
was not bypassed. It contains the starting-SHA source archive and dependency
symlinks, not production credentials.

## Fold 2 — CI repair

[FOLD2-REPORT.md](FOLD2-REPORT.md) records the incremental file inventory, causes,
fixes and gate exits. Fold 1 remains in place. Dispatcher shards and focused
service-free checks pass. `check:tests` retains the same eight diagnostics; real
server proofs and the host-blocked `ps` test remain CI work. No commit or push.
