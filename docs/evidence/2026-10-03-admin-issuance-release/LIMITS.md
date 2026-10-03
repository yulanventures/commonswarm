# Execution limits and remaining inputs

Prepared and locally tested; no production window has run. HezLead owns the
independent cross-family refute and all live operations. The worker has not
contacted production, dispatched Actions, started Docker, used a browser/GUI,
read a keychain, or fetched credentials. Test secrets stayed in fresh 0700
/private/tmp/anvil-secret.XXXXXX directories and were removed with guarded rm.
HOME was not changed. Reserve SQL remains verbatim.

W1 verifies a fresh database/object backup and completed isolated restore
receipt. W2 now implements HezLead's split ruling: M1–M3 ledger-only
transactions, M4 table + ledger/own checksum + complete historical/M1–M3
backfill, M5 ledger/checksum transaction. Executable live row/total-size
measurements refuse every stated bound before M1, and repeat under locks.
Interactions refuse above 100000 rows OR 256 MiB. Other bounds and expected
holds (M1 30s; M2/M3 15s; M4/M5 10s) are in RELEASE.md. Measurement-sized
statement and total PG17 transaction timeouts cap at 60s; lock timeout is 3s.
M1 ACCESS EXCLUSIVE blocks reads and writes. After each commit the plan probes
ordinary discovery, authenticated MCP token health and human pending_access.
Failure stops; committed prefixes stay; a durable marker refuses rerun;
reconciliation handles absent M4 and uncertain commits using the ledger.
Reserves remain verbatim and require separate data-free authorization.
No live row/size/hold measurement was made; estimates require the box preflight
and actual apply timing. HezLead supplies staged ordinary probe credentials.
W2 provisions the issuer credential on the box. The credential is 0440 root:986, readable by the AS group;
it is never printed or copied off the box. Initial provisioning refuses an
existing credential. Rotation needs a separately reviewed window.

W3 releases OAuth with the admin env unset and issuer overlay absent. W4
releases edge /admin, Caddy GET/HEAD /admin/gate, terminal legacy closure, and
the measured recycle drop-in. W5 releases the site with the CIMD document and
callback and records GET/HEAD gate CLOSED after the site and browser ownership
close. W1–W5 do not depend on BROWSER-READY or consent. Additive schema, audit,
tombstones and historical evidence survive rollback.

Integration inputs: this lane base does not include the companion site's
strengthened ownership helper and EXPECTED_SITE_SHA input, or the lane-11
published smoke client/callback. The plan references their combined release,
not this preparation tip as an executable release SHA. The site uses the
existing site2-07-manifest-close; its actual CLOSE.txt and manifest are checked
by ai-w5-closed. No separate ownership-close step or invented receipt is needed.
HezLead integrates the companion lanes and refutes the combined landed SHA.

W6 contains activation and C1. The Mac checks the canonical BROWSER-READY file
is newer than the bound W5 close; the box repeats the check on the nonsecret
transport copy before opening or activating. Activation still requires every
same-build gate, exact measured release and migration checksums. No static
receipt substitutes for the live prerequisites or production C1.

D8 resolves the handoff path conflict: the runner reads and writes only its
fresh secret directory; the release exports redacted receipts. The fixed 0600
~/work/dcr-rt/c1-smoke.pointer contains only absolute authorize/callback file
paths, exact existing workspace name, canonical request scopes checked against
the spec, home=false, required full-account choice and UTC expiry. The browser
worker follows only those choices and refuses expiry. The pointer and secret
directory are removed at W6 close. There is no path_revision_approval input.

D9 resolves approval scope honestly: approve_admin_client is account-wide for
owner/client/version, immediately before consent. In the same W6, withdraw
approval, revoke the smoke grant/family and measure a refused still-live access
call plus the refresh-family tombstone. The receipt includes approval_at,
withdrawn_at, revoked_at and the refused follow-up call. It does not claim a
post-revoke refresh request. There is no account_approval_revision input.

W6 defaults to removing the env/overlay, closing SQL cutover and proving public
GET/HEAD CLOSED after smoke. Keeping OPEN requires keep_open=true and a separate
exact release/window/plan-bound keep-admin-issuance-open approval. W7's
retirement proof stays separate and preserves W6's measured gate state.
The runner-created c1-smoke-<runid> (test, archive me) workspace is accepted
residue: Tom archives it in /app. W7/W5b is a later reviewed site release that
removes the test client document and measures public 404.

HezLead must supply exact landed archives, baseline measurements, historical
migration archives/backfill evidence, backup/restore status and independent
same-build/live ordinary-control receipts. RESULT-3.md lists every W1–W5 input.
No live-run PASS or deployment claim is made by these local tests.

Every timer-stopping block (W4 apply/rollback and W6 activation) now runs in a
subshell with an EXIT/INT/TERM guard installed before stop. The EXIT handler
runs ai-w4-timer-recovery once and verifies active on success or failure;
recovery failure keeps an incident open. The recycle rollback helper requires
its guarded caller to own the stopped timer. ai-close independently checks
active for every outcome. A shell trap cannot handle SIGKILL/host loss; after
reconnect HezLead runs the complete timer recovery block before closure.
