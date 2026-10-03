# Execution limits and remaining gaps

Prepared and locally syntax/contract-tested; no production window has run.
Every baseline, timer/service unit and unit digest remains a validated input
measured from the box. No operational SHA literal or assumed live identity is
embedded in the plan. HezLead supplies exact landed release archives, historical
migration archives/backfill evidence, backup/restore status, complete independent
same-build gate receipts and live ordinary-controls receipts before opening.
These are live-run inputs; static tests cannot supply or replace them.

The old implementation gaps are closed in the merged tree: activation uses the
issuer coordinator plus MCP_OAUTH_ADMIN_ISSUANCE_ENABLED=1, the activation-only
issuer overlay, SQL cutover and measured release. W2 omits the overlay and leaves
the env unset; W5 installs it and proves GET/HEAD open; rollback closes SQL,
removes env/overlay and proves closed. Gate cancellation and the registry decision
remain required same-build controls, not obsolete hard-false STOPs.

HezLead's W1 credential block generates the password on the box, uses file/stdin
SQL, writes the AS JSON credential at 0440 root:986 and verifies a TLS role login.
Rollback disables login/clears the new password/removes the new file. No password
leaves the box or enters 1Password this window. Existing credentials cause this
initial provisioning block to refuse; rotation needs its own reviewed window.

HezLead's W3 recycle drop-in binds exact measured units and installs pre-restart
invalidation plus post-restart remeasurement of health, target, image, mounts and
archive bytes. Generation changes prevent stale post-hooks from reopening after
rollback. Drop-in rollback closes issuance before guarded removal/daemon reload.
Generic later edge releases must use these hooks and update their release inputs
in their own reviewed plan; this preparation does not authorize an unrelated edge
release or modify another plan.

W6 has two newly observed task-versus-code conflicts. They cannot honestly be
reported as “only needs live run” without a HezLead ruling:

1. TASK-2 requires /Users/yulanbot/work/dcr-rt/authorize.url and
   /private/tmp/dcr-rt-callback.url. scripts/admin-smoke.mjs privatePath requires
   their parent to be a fresh /private/tmp/anvil-secret.XXXXXX directory and
   rejects symlink parents. The setup rule likewise requires secret staging there.
   Proposed complete blocks use private authorize/callback/fence files and a
   nonsecret dcr-rt pointer. W6 requires path_revision_approval before opening.
2. TASK-2 asks for workspace-scoped approve_admin_client. The production command
   accepts client_id and verification_version only; its owner approval is account
   scoped. The account envelope rejects workspace_id. The runner creates a new
   workspace through full-account consent, which can cover future owned spaces.
   The plan describes this accurately, limits the client ceiling to smoke scopes,
   withdraws approval afterward and requires account_approval_revision first.
   No source implementation was changed or scope control invented in this lane.

All other W6 pieces are prepared: canonical fetched-CIMD digest/version validation,
owner file-store approval, BROWSER-READY consent handoff, runner --verify-fenced,
read-only SQL D3 counts for the exact smoke grant/family, human revoke verb,
family-tombstone readback, client approval withdrawal, guarded cleanup and redacted
C1-SMOKE-REPORT.md. The runner demonstrates a refused still-live access call after
human revoke; SQL proves the refresh family tombstone. It does not perform a
post-revoke refresh request, and the receipt never claims one. Workspace
“c1-smoke-<runid> (test, archive me)” is accepted residue (D4), with Tom's /app
archive follow-up. W7 is retained and requires real C1 evidence and separate
retirement approval. W7/W4b schedules a later reviewed site commit/release removing
site/public/oauth/c1-smoke/client.json and measuring public 404.

No live C1, schema/role/credential change, SSH, Docker, deployment, restart,
browser/GUI, keychain, 1Password or GitHub Actions operation was performed by this
worker. HezLead owns independent cross-family review and every live operation.
The distinct tests/admin-release-plan.test.ts filename avoids collision with
main's unrelated tests/plan-baseline-inputs.test.ts; both test sets must survive
when integration later merges main. Reserve SQL siblings remain verbatim and
additive schema, tombstones, audit and history are retained on rollback.
