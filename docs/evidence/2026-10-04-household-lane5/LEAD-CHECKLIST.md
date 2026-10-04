# Lane 5 — second-human invitation draft

**DRAFT; not release-ready.** Worktree `lane/hh-lane5-invite`, base
`92a215374fa0b742c96218514e48d105534cae5f`. No commit, push, Actions dispatch,
production contact, deployment, service restart, browser launch, or secret retrieval.
HezLead owns the cross-family check. Do not integrate before C1 closes.

## Prepared behavior

The existing `admin_invite_member` records are delivered through the intended
recipient's authenticated `/app` inbox. The existing grant's recipient allowlist,
current capabilities, workspace selection, expiry, withdrawal and inviter's current
Owner/Admin membership still bound the invitation. No bearer invitation token is
created for this path. The recipient independently signs in, reads the current
members and shared-history disclosure, selects reader/editor access and confirms.
The inviter's agents can send the invitation; they cannot accept it, choose the
recipient's content role, create her personal space, or authorize her agents.

Ordinary privately copied `/app` links use the same review/join transaction.
They retain fragment scrubbing, deployment pinning and browser resume cleanup.
This new path binds the link to the recipient's verified email. Household links
cannot bypass consent through the old `accept_invitation` API. The new join path
requires the owner to have explicitly confirmed a shared workspace in content
settings; personal and unconfirmed boundaries refuse. Sender copy names this step.

Acceptance locks and consumes one invite, adds a Member (never an Owner), appends
workspace events and delegated account acceptance when applicable, stores the
recipient's content consent and one digest-bound receipt in one transaction.
A changed disclosure requires re-review. Lost responses retain the same request.
A repeated consumed invitation cannot restore a removed membership or change its
content role. Completed human membership is independent of the inviter's grant;
revoking that grant cancels pending invitations, not the person's accepted access.

Joining creates no agent or credential. The recipient uses the existing `/app`
workspace creation and personal-purpose confirmation herself, then the existing
OAuth flow through her own account and grant for each approved workspace.
Hosted content permission remains a separate human confirmation from the packet.
Instructions warn that connector chats share seats and that private/shared grants
and runtime context must stay separate. No connected or wake proof is claimed.

## Files and why

The exact file enumeration is [FILES.md](FILES.md).

| Files | Reason |
| --- | --- |
| `src/protocol/household-invitations.ts` | Strict human invitation parser, consent/version/rate constants, disclosure and deterministic authorization/replay decisions. Role choices use the existing content-role registry. |
| `src/protocol/admin-authority.ts`, `admin-routine.ts`, `admin-routine-events.ts` | Recipient-attributed acceptance event, replay projection, preserved issuance spend, and truthful pending/delivery instructions. |
| `src/protocol/index.ts`, `scripts/build-admin-types.mjs`, `supabase/functions/_shared/protocol.js`, `admin-routine-events.d.ts`, `household-invitations.d.ts` | Core export and regenerated edge artifacts; no bundle was hand-edited. |
| `supabase/functions/command/household-invitations.ts`, `command/index.ts` | Verified-human dispatch before membership routing, version/rate admission, locked recipient/parent/current-rights checks, event/consent/receipt persistence, and old household capability-route consent fence. |
| `supabase/functions/read/index.ts` | Human-only inbox resource with server-derived account claims; worker/admin/hosted credentials cannot select a recipient. |
| `src/cloud/human-invitations.ts` | Authenticated read/preview/join transport, bounded timeout, exact uncertain retry, secret-free bodies for delegated delivery and refusal of pending success responses. |
| `site/src/lib/human-invitations.ts`, `human-invite-controller.ts` | Browser auth adapter and account/generation-owned inbox, preview and join lifecycle. |
| `site/src/components/invite/HumanInvitationInbox.astro`, `InviteOnramp.astro`, `site/src/pages/app.astro`, `site/src/components/app/LiveDashboard.astro` | Inbox mounted before first-workspace state, explicit consent on both paths, inert rendering, expiry/audience/history, account-change clearing, role lock during uncertain retry, independent agent/personal-space guidance and sender prerequisite copy. |
| `supabase/migrations/20261004000006_household_human_invitations.sql` | Bounded recipient-only SECURITY DEFINER read function and accurate address-binding column comment. Only 06 is used; reserved 07–09 are unused. |
| `supabase/household-invite-reserve/20261004000006-{catalog,rollback,rollback-catalog}.sql`; `deploy/release-proofs/household-invites/20261004000006-{catalog,rollback,rollback-catalog}.sql`, `README.md` | Verbatim reserve/release inverse, pinned function-body/owner/search-path/ACL catalog, inverse catalog and release ordering. Inverse preserves all authority rows. |
| `tests/support/admin-issuer-privileges.json` | One reasoned new allowlist entry: swarm_read EXECUTE on `swarm_read.human_invitations()`. No direct read-table, write, DELETE, grant-option or OAuth scope privilege added. |
| `tests/household-human-invitations.test.ts`; `tests/p1-cli/human-invitations.test.ts`; `site/src/lib/human-invitations.test.mjs` | New decision/event/inverse, transport/uncertain-result and recipient-view lifecycle cases. |
| `tests/p1-server/household-human-invitations.test.ts`; `tests/support/household-human-invites-server.mjs` | New actual-schema ACL/inverse proof and real transaction adapter cases, including core/routine-issued records, recipient-only inbox, concurrency, rollback, consent, removal, parent revoke, legacy links and credential-free receipts. |
| `site/src/components/invite/member-invite.observer.test.ts`, `tests/p1-server/household-storage.test.ts` | Update the existing link contract for explicit review; remove dependent overlay 06 before the older storage inverse drill. |
| `tests/lists/test.txt`, `tests/lists/test:p1-server.txt` | Add only the two newly created test files belonging to these literal gates. New CLI/site files are covered by existing globs. |
| This directory: `LEAD-CHECKLIST.md`, `FILES.md`, `gate-exits.txt`, `focused-tests.txt`, `check-tests.txt` | Review handoff, exact inventory and measured gate evidence. |

## Expected C1 conflicts

- `command/index.ts`: imports, `handleTransaction`, authenticated pre-route
  admission and the legacy invitation routing fence. Reconcile with C1's common
  OAuth/DPoP verifier and admission classifier; do not enable ordinary worker/admin
  credentials at this human endpoint.
- `read/index.ts`: `parseBody` and `handle` resource/authentication dispatch.
  Keep recipient claims server-derived and preserve C1's admin credential denial.
- `admin-authority.ts`: `reduceAdminAuthority` acceptance actor validation;
  `admin-routine.ts`: `decideAdminRoutine` pending next-action and
  `reduceAdminRoutine` acceptance projection. Reconcile with C1's exact consented
  capability snapshot, durable grant reconciliation, revocation and event vocabulary.
- `src/protocol/index.ts`, type-generation script, generated bundle/declarations:
  regenerate from reconciled source. C1 must regenerate the ignored OAuth management
  artifact from that same core; do not merge generated bundle hunks independently.
- `LiveDashboard.astro`, `InviteOnramp.astro`, `app.astro`: account lifecycle,
  connected-app consent, invitation state and sender copy. Preserve account-switch
  clearing and the first-workspace inbox.
- `tests/support/admin-issuer-privileges.json`, test lists and storage inverse
  drill: merge additions and retain newest-overlay-first ordering. Migration 06
  expects the packet's household permission overlay 05 and C1 prerequisite schemas.
- `services/mcp-auth/src/`: unchanged here. Lead must check recipient-owned OAuth
  workspace/owner binding and claimed-seat/content-consent integration after C1.
  **OAuth changes: none; no new scope, resource, issuance route or provider policy.**

## Security review points

- **Delivery:** inbox-only, authenticated recipient; IDs confer no authority.
  Delegated recipients must already own an account and be explicitly allowlisted.
  This draft does not send email or a third-party notification. The recipient checks
  `/app`; no pending receipt is called an accepted membership or connected agent.
- **Link secrets:** raw capability remains in fragment/private browser resume only,
  then is posted over HTTPS. Hash lookup; raw token absent from events, receipts,
  account projection and idempotency digest material. Review browser resume storage
  under XSS and shared-device assumptions. No new secret delivery callback.
- **Recipient:** verified human session; email match for link review, user-ID match
  for delegated review. No grantor/agent impersonation, agent invitation redemption,
  Owner promotion, implicit connector adoption or automatic personal-space creation.
- **Fresh rights:** parent state/deadline/capability/recipient/workspace/current role
  are checked under locks. Review lock ordering against C1 withdrawal/revoke and
  ordinary membership changes. Expiry is checked at use, without a lazy-event wait.
- **Replay:** command/digest mismatch refuses; one transactional receipt; consumed
  invite does not spend again, refund issuance, change consent or revive removal.
  Concurrent consumption/revoke and audit/consent-insert failure still need real CI.
- **Disclosure:** preview uses server workspace/audience/history facts and expiry;
  stream-head-bound digest detects changes. Current audience is bounded by the
  workspace's 25-human policy. Text renders inertly. Sign-out/account change clears
  pending state; changed disclosure never triggers an automatic accept.
- **Existing links:** new household review binds verified email whereas the old
  unconfigured capability path historically did not. Configured household links
  are fenced off that old path. This is a compatibility change to review explicitly.
  Existing unconfirmed generic links now need the owner to confirm Shared before
  the updated `/invite` path can finish. Do not activate site/edge separately.
- **Separate grants:** accepted membership is the recipient's own. Household
  membership grants no access to either person's private workspace. Recipient
  personal-space creation and own OAuth/agent consent reuse existing flows; no
  vendor/session-level isolation, enrollment progress or successful connection is
  established by this lane's local checks.

## Tests and measured gates

Every required invocation used `env HOME=<fresh absolute mktemp directory>`;
no shell HOME assignment. Offline root/site dependencies were copied from the
starting integration worktree, with no manifest or lockfile change. Deno used the
existing local cache. No full suite ran. All 20 created disposable homes were removed through the
PATH rm guard after controls admitted exact owned paths and refused six unsafe
or unowned paths. Ignored dependency copies and scratchpad logs remain in this lane.

| Gate | Final exit | Result |
| --- | ---: | --- |
| `npm run build:command-core` | 0 | Generated core/declarations. Initial attempt 127 because dependencies were absent. |
| `npm run build` | 0 | Root TypeScript build. |
| `npm run check:edge` | 0 | All configured edge entries. One intermediate failure was fixed (scope constant/type narrowing). |
| `npm run check:tests` | 2 | Eight diagnostic lines exactly match the integration packet's recorded baseline; see `check-tests.txt`. This is still a failing gate, not a waiver or new baseline execution. |
| Direct `node --import tsx --test` on new service-free/site/CLI files, touched invite test and routine/bundle regressions | 0 | **27/27 passed**, no skips. Exact invocation and outcomes in `focused-tests.txt`. |
| Direct Node invocation on new human-invite and touched household-storage server files | 1 | Docker is disabled on this Mac mini; Supabase unavailable. No SQL/ACL/inverse/transaction scenario executed. |
| Touched-file Astro compiler transform | 0 | Four touched Astro files parse; no full site build or browser/visual proof. |
| Deno check of new server harness | 0 | Harness/import check; not database execution. |
| `git diff --check` | 0 | Whitespace check. |

New tests: `tests/household-human-invitations.test.ts`,
`tests/p1-cli/human-invitations.test.ts`,
`tests/p1-server/household-human-invitations.test.ts`,
`site/src/lib/human-invitations.test.mjs`. The existing invite source-contract
observer is a static test, not an actual browser interaction.

## Incomplete and release order

C1 reconciliation and independent review, real schema/ACL/inverse and HTTP/auth
server checks, actual browser sign-in/consent, recipient-owned OAuth/hosted-seat
round trip, personal-space negative reads (metadata/history/bytes), and exact-host
agent connection/refresh/revoke evidence remain required. The new server harness
exercises the real join transaction with supplied verified-human facts; it does
not prove the public JWT verifier or an actual OAuth consent round trip. No
runtime key/challenge/progress implementation for delegated **agent** invitations
was added: `admin_issue_agent_invitation` remains its existing pending path.

Release: close C1 → reconcile this draft with the reviewed integration packet →
HezLead's cross-family check → authorized server/p1-cli/site CI → reviewed exact
SHA on main → release worker applies household 01–04 with catalogs, 05 with its
catalog, then 06 with its catalog → matching edge/auth management artifact and
site/CLI inputs → recipient's explicit human choices → lane-7 both-path and
actual-host evidence. C1 activation/legacy-fence requirements remain binding.
Undo 06 before 05 and earlier overlays; the inverse never revives consumed invites
or removes accepted memberships/consent/history. No deployment is authorized here.
