# CommonSwarm post-release smoke task

You are a Codex worker for HezLead and the CSwarm Strategist.
Run this task only for the exact release and workflow run HezLead assigns.
Read `/Users/yulanbot/work/process/WORKER-RULES.md` first.
Read `/Users/yulanbot/Developer/Ridge.io/AGENTS.md` and its full
`workspace-guides/BROWSER-SAFEGUARDS.md`. Read `AGENTS.md` and `SECURITY.md`
at the repository root. Do not run Alloy.
HezLead arranges the independent check. Do not deploy or restart a service.

## 1. Trigger, inputs, and clock

Run A, B, C, D1, D2, E0, E1, and F after EVERY CommonSwarm site, OAuth
(`services/mcp-auth`), or edge release. Also run them after a rollback.
For a combined release, run after each live surface switch.
HezLead supplies these non-secret inputs:

- `RELEASE_KIND`: `site`, `oauth`, or `edge`. Dispatch once per surface switch.
  The probe parser also accepts a combination, but this workflow selects one surface.
- `RELEASE_SHA`: the full 40-character released SHA for this surface switch.
- `RELEASE_UTC`: release completion time, in UTC ISO format
  `2026-10-08T20:00:00Z`.
- `SITE_SHA`: the full SHA of the live site, even for an OAuth or edge release.
- `WORKFLOW_REF`: `main` for dispatch, not a commit SHA. The `smoke` environment
  permits only this branch.
- `WORKFLOW_SHA`: full reviewed SHA on `origin/main` to which that workflow ref
  must resolve.
- `PROBE_SHA`: full immutable reviewed SHA for checkout of this task and its scripts.
  It must be reachable from `origin/main` and can differ from `WORKFLOW_SHA`.
  Record and verify both revisions. The workflow fetches complete main history
  into an empty temporary repository without checking out code, then checks both
  with `git merge-base --is-ancestor` before checking out or
  running any probe code. Rejection uses fixed codes
  `CS_SMOKE_WORKFLOW_NOT_ON_MAIN` or `CS_SMOKE_PROBE_NOT_ON_MAIN` (exit 1).
- For combined releases, include the full SHA and completion UTC of every
  changed surface in the assignment and evidence handoff.

These are supplied release receipts. The probes do not measure the live SHA.
Validate inputs before any product request. Resolve the UI hooks and
`WEB_CLIENT_VERSION` against the assigned `SITE_SHA` before the run. Record that
review in the fixture's `fixture_site_sha`. Do not change selectors during a run.
A selector mismatch is FAIL. Review a script update as a separate change.

The entry command starts a builtin Bash clock before credential access.
Its whole-second start makes deadlines conservative by less than one second.
The target is five minutes. Fixture provisioning happens once; each job installs
tools in its disposable container outside that clock.
A workflow's queue, checkout, dependency install, and artifact transfer can take
longer. Do not report those as measured five-minute probe time.
The scripts use absolute deadlines from entry, not a new five-minute budget
for each check. Setup ends by 20 s. E0 ends by 55 s, E1 by 65 s, A by 90 s,
B by 150 s, C by 210 s, D1 by 260 s, D2 by 270 s, and F by 280 s.
Reserve 280 to 300 s for wrapper shutdown, recovery encryption, and file cleanup. HTTP requests have at most 15 s.
UI operations have at most 20 s, shortened to the current deadline.
Each check has one immutable cancellation object. HTTP, OP, IMAP, browser, and
request/response guard work retain that object. Join owned work before the next
check. A timeout aborts it and stops the probe process; unrun checks stay FAIL.
Do not retry a consumed refresh token or a message. Complete independent checks
only after a failed assertion has been joined safely. E runs before the browser.
OP uses TERM, KILL after 500 ms, and a close-event join. The entry watchdog starts
before setup and sends TERM at 280 s and KILL at 300 s. Setup/probe children share
an owned Linux process group. Cleanup also enumerates descendants before killing
the owner, including detached Chromium groups. It checks PID plus kernel start
time before signaling each child. KILL and join are bounded. On timeout, the Node
owner waits for wrapper termination so its detached children can still be found.
Encryption is limited to 5 s plus 500 ms to kill; ciphertext transfer, deletion,
refusal redaction, and finalization are also bounded. See `scripts/smoke/run.sh`.
No Promise.race timeout permits a next check while the old task remains alive.
Any overall run over 300 s fails the time requirement.

## 2. Named runner and one-time provisioning

**Browser runner:** job `smoke` in `yulanventures/commonswarm` runs on a
GitHub-hosted `ubuntu-latest` Linux runner:

```yaml
runs-on: ${{ vars.CS_SMOKE_RUNS_ON || 'ubuntu-latest' }}
environment: smoke
```

Keep **`CS_SMOKE_RUNS_ON` unset**. HezLead approved GitHub-hosted runners for this
public repository; their use is free here. Each runner is ephemeral per run.
Chromium's `--no-sandbox` and the temporary browser profile assume that disposable
runner. Do not point this workflow at a self-hosted runner or a Mac.
Do not change fleet labels or set repository variables as part of preparation.

The workflow uses a disposable `node:22.12.0-bookworm` job container.
Tool and Chromium system-library installs run inside that container, not on the
runner host. It is removed at job end; raw credentials and the browser profile
stay in its private `/tmp`. Shared workspace and runner-temp mounts contain
only source, installed tools, bundled Chromium, and the allowlisted evidence.
The runner is separate from the production box.

**One-time environment setup (HezLead or Tom, in repository settings):**

1. Create the GitHub Environment **`smoke`**.
2. Set Deployment branches to **Selected branches: main** only. Do not allow
   other branches or tags. Optionally add required reviewers.
3. Add environment secret **`CS_SMOKE_OP_SERVICE_ACCOUNT_TOKEN`**, using the
   dedicated smoke service account described below.
4. Add environment variable **`CS_SMOKE_RECOVERY_AGE_RECIPIENT`**, using HezLead's
   age public recipient. Keep its private identity outside Actions.

Keep these values at environment level, without repository-level copies.
Fork and PR runs can never read the smoke secret: the trigger is
`workflow_dispatch` only, and the environment allows only `main` in this
repository. Dispatch `main`; the existing workflow and probe ancestry guards
still require both reviewed SHAs to be on `origin/main` before probe checkout.

**Provisioning status: not verified.** The workflow and probes are checked in at
`.github/workflows/cs-smoke.yml`, `scripts/smoke/run.sh`, and
`scripts/smoke/smoke.mjs`. Runner access, variables, secrets, and fixtures still
need the section 7 rehearsal. Missing provisioning is setup FAIL, not PASS.

The workflow has these settings:

- `workflow_dispatch` only. Required inputs: `release_kind` (choice of `site`,
  `oauth`, or `edge`), `release_sha`, `release_utc`, `site_sha`, `workflow_ref`,
  `workflow_sha`, and `probe_sha`. Enable it on the default branch before use.
  Dispatch `main` as `WORKFLOW_REF`; checkout `probe_sha`, an immutable commit SHA.
  Before checkout, validate the release receipts, require the dispatch ref name
  to equal `workflow_ref`, and compare `github.workflow_sha` to `workflow_sha`.
  After checkout, require `git rev-parse HEAD` to equal `probe_sha`, before OP
  ingress. Set `WORKFLOW_REF`, `WORKFLOW_SHA`, and `PROBE_SHA` from those inputs.
  Set `CS_ACTUAL_WORKFLOW_SHA` from `github.workflow_sha`, and
  `CS_ACTUAL_PROBE_SHA` from the measured checkout SHA. Init validates and returns
  both expected and actual revisions. Never infer checkout SHA from run headSha.
- Job `smoke`, GitHub-hosted `ubuntu-latest`, `environment: smoke`,
  `timeout-minutes: 15`.
  This leaves time for provisioning, the five-minute entry clock, and upload.
  `permissions: contents: read`. Never deploy from this job.
- Fixed concurrency group `commonswarm-smoke-test-account`, with
  `cancel-in-progress: false`. All users of the fixture must use this same lock.
  HezLead must keep manual refreshes out of the smoke window.
- Pin all actions to immutable SHAs (listed below). Use Linux Bash 4.4 or newer,
  Node 22.12.0, 1Password CLI 2.32.0, GNU `timeout`, util-linux `setsid`, and `age`.
  The container provisions the system tools. The pinned CLI installer runs without
  OP credentials. The run step is the only step that receives the OP secret.
  Copy `scripts/smoke/package.json` and `scripts/smoke/package-lock.json` to
  `$GITHUB_WORKSPACE/.cs-smoke-tools` and run `npm ci --ignore-scripts` there.
  Locked direct dependencies are `playwright@1.63.0`, `imapflow@2.3.0`, and
  `mailparser@3.9.37`. The lockfile also fixes transitive versions and integrity.
  Package root is `$GITHUB_WORKSPACE/.cs-smoke-tools/package.json`.
  Module path is `$GITHUB_WORKSPACE/.cs-smoke-tools/node_modules/playwright`.
  Install only Playwright's bundled Chromium and its Linux system libraries.
  Set the same job-local `PLAYWRIGHT_BROWSERS_PATH` during install and run:
  `$RUNNER_TEMP/cs-smoke-chromium-<run ID>-<run attempt>`.
  Never select the Chrome channel or an installed Chrome executable.
- Set `CS_TOOL_ROOT=$GITHUB_WORKSPACE/.cs-smoke-tools` and
  `CS_EVIDENCE_DIR=$GITHUB_WORKSPACE/cs-smoke-evidence` for the entry step.
  `/tmp` must be writable. Each run uses `mktemp -d /tmp/anvil-secret.XXXXXX`,
  mode 0700. Raw credentials, browser profiles, mail links, and stderr stay there.
- Environment `smoke` secret **`CS_SMOKE_OP_SERVICE_ACCOUNT_TOKEN`**: a dedicated 1Password
  service account created by Tom, scoped read-only to a NEW vault named
  **`CommonSwarm Smoke`** that holds only the smoke test items. Never use the main
  service account or grant access to any other vault. Map it to
  `OP_SERVICE_ACCOUNT_TOKEN` only in the entry
  step. This OP token is the worker-rule exception for secret environment ingress.
  The wrapper stages it in a 0600 file, unsets it, and supplies it only to each
  `op` process. Do not expose it to unrelated actions or Node browser children.
  No secret for Tom, a service-role key, or production env is needed.
  A builtin-only Linux guard reads `/proc/sys/kernel/ostype` before touching the
  credential. Shell builtins then copy the ingress to an unexported variable and
  unset the original before the first child, including init and encryption. Stage to a 0600
  file and unset that variable before the worker group starts. Only OP processes
  receive the token. Their timeout launchers and Node browser children do not.
- Environment `smoke` variable **`CS_SMOKE_RECOVERY_AGE_RECIPIENT`**: HezLead's age public
  recipient. Set `CS_RECOVERY_RECIPIENT` to that public value. Keep its private
  identity outside Actions. Verify local decryption with HezLead before first run.
- Always upload only `cs-smoke-evidence/report.md`, `result.json`, and, if present,
  `refresh-recovery.age`, as artifact **`cs-smoke-result`**, even on failure.
  Retain for seven days. Bound artifact upload to one minute and require its
  success plus the returned artifact ID. After download, HezLead must verify age
  decryption in an assigned recovery task before accepting a successor as saved.
  A failed or missing artifact blocks fixture reuse and requires a fresh baseline
  grant if the successor cannot be recovered. The job cannot retain its container.
  Never upload the secret directory, cookie JSON, profile,
  mail, raw responses, stdout/stderr, or an unencrypted recovery token.
  Fail the job if `result.json.finalized` is not true, evidence is absent, or the
  report's `overall` is FAIL, even if Node exited zero.
  Do not let upload success replace the probe result.

Action pins in `.github/workflows/cs-smoke.yml`:

| Action | Version | Full commit SHA |
|---|---|---|
| `actions/checkout` | v4.2.2 | `11bd71901bbe5b1630ceea73d27597364c9af683` |
| `actions/setup-node` | v4.4.0 | `49933ea5288caeca8642d1e84afbd3f7d6820020` |
| `1Password/install-cli-action` | v1 | `143a85f84a90555d121cde2ff5872e393a47ab9f` |
| `actions/upload-artifact` | v4.6.2 | `ea165f8d65b6e75b540449e92b4886f43607fa02` |

The final workflow step requires the probe step and artifact upload to succeed,
a numeric artifact ID, finalized PASS evidence, matching revision and release
receipts, allowed fixture reuse, and no recovery ciphertext. Setup or upload
failure cannot become a smoke PASS. Provisioning time is outside the entry clock.

Exact entry command on that Linux job, after the steps above:

```sh
bash scripts/smoke/run.sh
```

Pass workflow inputs to matching uppercase non-secret variables from section 1.
Supply all required path variables above. The wrapper refuses to run on macOS.
No browser, Docker, credential read, or product request runs on the Mac mini.
All product URLs are `https://commonswarm.com`, `https://api.commonswarm.com`,
and `https://mcp.commonswarm.com`. The exclusive test mailbox and configured
IdP origins are the only external auth dependencies. The exact client callback is validated and aborted locally before forwarding.
It is never contacted. No product response is fulfilled by the harness.

## 3. Test identity and credential fixture

Use only a dedicated TEST identity. Never use Tom's account, a real person's
account, or HM37's historical fixtures.
HezLead/Tom must create these once, outside this smoke:

- Account display name `CommonSwarm Smoke Test`, with an exclusive TLS IMAP mailbox.
  The account must already exist. B uses the real email magic-link form.
  The request guard sets `create_user=false` to prevent accidental sign-up.
- One workspace named `CommonSwarm Smoke Test`. This is the account's only active
  workspace. Its only human member is this TEST user. Seats belong only to the
  test. Do not give any real person or active agent a notification destination.
- A baseline hosted grant and seat named `cs-smoke`. Record the actual
  `seat_...` handle, workspace UUID, and grant UUID. The seat name is not its handle.
- A separate public HTTPS consent client named `CommonSwarm Smoke Consent Test`.
  Provide its accepted HTTPS client metadata document, redirect URI, and client
  return URL. Use auth method `none`, code flow, S256 PKCE, and the MCP resource.
  Keep it separate from the baseline client so consent does not replace that grant.
  Its callback must not log query strings or authorization codes.
- Link the TEST user's dedicated Google or GitHub provider identity to this same
  CommonSwarm user. Select exactly one enabled provider in `oauth_provider`.
  Renew its dedicated IdP cookie fixture when expired. Use a separate assigned
  headless bundled-Chromium login task. Never export cookies from Tom's Chrome.

The proposed 1Password item is exactly **`CommonSwarm smoke test account`**, in
vault **`CommonSwarm Smoke`**. Existence and permissions are **not verified**.
Use these unique field labels:

| Label | Required value |
|---|---|
| `smoke_config` | JSON object with the complete schema below. Treat it as secret. |
| `hosted_refresh_token` | Current refresh token for the baseline TEST grant only. |
| `fixture_state` | `ready` after provisioning/recovery; smoke saves `in_use` before refresh. |
| `oauth_provider_cookies` | Playwright cookie-array JSON for that TEST IdP session only. |

`smoke_config` requires every field below. Use actual values, not placeholders:

```text
test_user_id                 UUID of the dedicated TEST user
test_email                   exclusive TEST email address
test_display_name            CommonSwarm Smoke Test
workspace_id                 UUID of the dedicated TEST workspace
workspace_name               CommonSwarm Smoke Test
baseline_grant_id            UUID of the baseline hosted grant
baseline_client_id           actual client ID used to mint its refresh token
seat_handle                  actual seat_[A-Za-z0-9_-]{22,64} handle
seat_name                    cs-smoke
oauth_client_id              accepted HTTPS client metadata URL, without query/fragment
oauth_redirect_uri           exact accepted HTTPS callback, without query/fragment
oauth_return_url             client_uri from metadata, same origin as callback
oauth_provider               google OR github, matching enabled deployment provider
oauth_provider_cookie_domains exact cookie domains, including leading dots when present
oauth_network_origins        exact HTTPS origins needed by that provider's redirect flow
app_anon_key                 public anon key from the assigned site build
web_client_version           WEB_CLIENT_VERSION from the assigned SITE_SHA
fixture_site_sha             SITE_SHA whose UI hooks and config HezLead reviewed
mailbox                      {host, port:993, username, password}, exclusive TLS IMAP
```

No `localhost` model or runtime fallback is allowed. Do not use protected browser
stores or a service-role credential. The IdP domain list must exclude CommonSwarm
cookies. The script checks it before adding cookies to the fresh context.
Google may require 2FA, an interactive TEST login, or reject headless login.
The app fallback is email magic link, not email/password. It is B's selected
method. This fallback does not sign in to the OAuth service. An expired IdP
fixture makes D1/D2 FAIL, not verified. Renew the TEST fixture in a separate task.

The wrapper reads the item with `op item get --format=json`, through the OP
service account, directly into a 0600 file. It installs EXIT/INT/TERM traps
before staging the ingress credential or reading the fixture. It does not print the item
or raw `op` errors. Unique-label validation produces only fixed failure codes.
The current refresh token, config, cookies, and any successor stay in 0600 files
or memory. Credentials are never command-line arguments.

**Provisioning blocker:** the existing probe saves fixture state and rotated
refresh tokens with `op item edit`. The required read-only service account cannot
make those writes; arming fails with `E0_rotation_save_failed` before refresh.
HezLead must assign a separate change to the persistence path before a successful
smoke rehearsal. Do not broaden the account's permissions to make this probe pass.

Refresh rotates. First require `fixture_state=ready`. Before sending refresh,
save `fixture_state=in_use` to the 1Password item with a bounded OP edit. Record
`fixture.armed` before that edit. This durable guard makes later runners refuse
an unrecovered fixture before any product request. If arming fails, do not refresh.
Record `rotation.inflight` before refresh because a lost response may consume it.

After receiving a successor, stage the complete item template by atomic rename,
then `rotation.pending`. Set its successor field and `fixture_state=ready` in the
same template. Save through `op item edit <item UUID> --template <0600 path>`.
Only after OP exits successfully and the check is still alive may the script
rename pending to saved. This happens BEFORE initialized/tool calls and UI probes.
A save failure blocks MCP and keeps the successor file for the EXIT handler.
Do not reuse the predecessor. The ready state and successor are saved together;
if OP completed but its receipt was lost, operator reconciliation may prove both.

The EXIT handler encrypts a staged successor with `age`, inside the private temp
directory, then moves only successful ciphertext to `refresh-recovery.age`.
An offline encryption control must pass before fixture access. Any uncertain
arming or rotation means FAIL. Returned safe rotation states are `arm_unknown`,
`successor_unknown`, `recovery_encrypted`, or `recovery_lost`; `saved` and `none`
mean no unresolved rotation. `fixture_use=blocked_until_recovery_or_fresh_grant`
makes operator recovery mandatory. Preserve the original per-check failure code.
Report the rotation outcome separately. Never return raw token or OP diagnostics.

**Ephemeral-container recovery policy:** this job has no plaintext hold mechanism.
Remove plaintext through the checked PATH-based guard even if encryption fails.
Do not promise a retained machine or a durable secret-directory path. On refusal,
leave it for this job's remaining lifetime, capture the redacted refusal and path,
and require HezLead to confirm container disposal. On encryption/artifact loss or missing
successor, HezLead/Tom must create a fresh baseline grant/seat and replace the
fixture, unless they can verify the successor is already saved in 1Password.
No smoke may reset an `in_use` fixture to ready or retry an old refresh token.
HezLead must reconcile any uncertain run before assigning another exact run.

For encrypted recovery, HezLead must verify download and decrypt in a 0700 secret
directory, save only the successor and `fixture_state=ready` to the original item,
and remove plaintext with the installed guard. Never overwrite unrelated fixture
fields from a stale whole-item recovery template. Upload/decryption and recovery
remain **not verified** until the provisioning rehearsal in section 7 passes.

## 4. Complete supplied probes and checks

Use the supplied files without authoring scripts during the run:
`scripts/smoke/run.sh` and `scripts/smoke/smoke.mjs` from the repository root.
They need no site build or product changes.
They use one fresh headless persistent Playwright context. Its profile stays in
the secret directory. Launch flags are `--password-store=basic`,
`--use-mock-keychain`, and `--no-sandbox`. `--no-sandbox` is permitted only
inside the ephemeral runner job container, never on a persistent host or a Mac.
An unset `PLAYWRIGHT_BROWSERS_PATH` is a prerequisite failure. The binary must
resolve under the provisioned Playwright cache. Close the context in cleanup
and `finally`.

These are external smoke probes, not additional repository unit tests.
They protect observed sign-in, byte transport, completed consent, and hosted
protocol behavior. Historical HTTP-only probes missed these regressions.
No production test seam, export, flag, or service restart is needed.

### A. Web app loads

HTTP request: **does not need a browser**. App bundle and console: **need a browser**.
Node fetch requires `/app` HTTP 200 HTML, without following a redirect.
Bundled Chromium requires the real `/app` to load, the signed-out panel to become
visible, and site script responses to be 200. No console error or page exception
is allowed across the whole UI run. Only counts go in the report.
Pass: all of these checks succeed. Failure: `A FAIL: app, bundle, or console`.

### B. TEST sign-in and workspace

App sign-in: **needs a browser**. TLS IMAP mailbox read: **does not need a browser**.
Record mailbox UID-next before clicking the real email sign-in form. Poll only
new mail in that exclusive TEST mailbox. Require the message recipient to match
`test_email`. Accept only the API `/auth/v1/verify` magic-link URL with its redirect
to `https://commonswarm.com/app`. Do not print or retain the message or link.
Consume the link in the same fresh browser context. Require the local session
and server `/auth/v1/user` to match both `test_user_id` and `test_email`.
Before forwarding any browser data read, verify server identity and read only
workspace UUIDs to confirm the account has exactly the TEST workspace.

Load `/app?w=<TEST UUID>`. Require all three current controls:

```text
[data-rail-workspace="<TEST UUID>"][aria-current="page"]
[data-home-workspace-header="<TEST UUID>"]
.hm-rail__name and the matching header h1 equal workspace_name
```

Require exactly one workspace in the rail. The test fixture must not have real
workspace membership. Wrong identity or scope stops browser requests before
content reads or writes. Pass: real sign-in and all identity checks succeed.
Failure: `B FAIL: test sign-in or workspace identity`.

### C. Composer PNG upload and byte readback

**Needs a browser.** Generate a neutral gray 2 by 2 PNG using canvas. Use fixed
body `CommonSwarm smoke test.` and filename `cs-smoke.png`.
Use `[data-composer-file-input].setInputFiles`, fill `[data-composer-input]`, and
click `[data-composer-send]`. Leave all recipients empty for a TEST workspace note.
Never replace the composer with direct upload or direct `post_signal`.

Install request guards before clicking. Product requests use only
`route.continue`. No `route.fetch`, product `route.fulfill`, or response header
repair is permitted. Playwright request interception can still synthesize browser
preflights, so the mandatory independent wire checks below are required. Never
claim that a browser OPTIONS was observed merely because interception is enabled.
Pin the Playwright version and prove these checks on the provisioned version. Require the verified TEST bearer,
workspace UUID, workspace stream, client version, and allowed command kind
BEFORE forwarding every command. Reject people, agents, replies, mentions,
channels, or other recipients on the post. Allow automatic seen reports only
within the verified TEST workspace. Product writes outside this scope are blocked.
Observe the actual responses in this order:

1. `file_version_create`: HTTP 200 and `status=accepted`. Record this run's
   intended file/version UUIDs before sending, for cleanup after a lost response.
2. Require the returned signed upload path to contain the exact TEST workspace,
   this file UUID, and accepted version number. Before forwarding the browser PUT,
   send a separate real Node OPTIONS to the
   exact signed upload path returned by create. Send Origin `https://commonswarm.com`,
   Access-Control-Request-Method `PUT`, and Access-Control-Request-Headers
   `content-type`. No bearer. Require 2xx, ACAO equal to that Origin or `*`,
   allowed method PUT, and allowed header content-type (or permitted wildcard).
   OPTIONS 404 or missing ACAO makes C FAIL and aborts the pending browser PUT.
   This mandatory request reaches Storage and cannot use Playwright's preflight.
3. Browser Storage PUT to that exact URL: 2xx and PNG hash. Observe its original
   response via CDP `Network.responseReceivedExtraInfo`, including responses hidden
   by CORS. Capture candidate PUT request IDs, URLs, and immutable check owners as
   CDP announces them, even before the probe finishes reading create. Keep this data
   private. After `waitStage('create')` and the exact URL/body guards, associate only
   the exact signed upload URL with its CDP ID and the same check owner. Buffer raw
   response information that arrives before association, then validate that receipt.
   Require this associated original receipt before forwarding commit and passing C.
   Require Access-Control-Allow-Origin for the site (or `*`). Also validate
   the unchanged normal response when Chromium exposes it. Missing PUT ACAO is
   C FAIL even if synthetic preflight succeeded. Never insert CORS headers.
4. `file_version_commit`: HTTP 200 and `status=accepted`, same UUIDs and SHA-256.
5. `post_signal`: HTTP 200 and `status=accepted`, exact single file ref and fixed
   text. Capture `signal.id`, not an older row with the same text.

The same scope guard allows the app's startup reads: `household_access`,
`household_activity`, and `household_tool` with only `todo_list`.
It also allows the read RPCs `home_overview` and `signal_delivery_receipts`.
These are product read paths. Other household tools and all other product writes
fail closed. No real content belongs in the dedicated fixture.

Reload `/app?w=<TEST UUID>`. Require `[data-signal-id="<new signal UUID>"]`, the
exact rendered fixed text, and exactly one file card with this run's file UUID
and filename. Message cards show a file link and icon, not an inline image.
Click its real `[data-stream-files] a[data-object-id="<file UUID>"]` link.
Observe accepted `file_download_url` for this exact file/version. Before
forwarding the resulting signed browser Storage GET unchanged, independently
fetch that same exact GET with Node, without logging its URL. Require the browser
GET to return 200 PNG as well. No response is synthesized or modified.
Require HTTP 200, PNG MIME, SHA-256 equal to the uploaded bytes, PNG signature,
and IHDR width/height 2 by 2. No inline image wait or staged preview counts.
Pass: real preflight, original PUT CORS, all four write stages, reloaded card,
and downloaded bytes succeed. Failure codes include `C_assertion_preflight_status`,
`C_assertion_preflight_acao`, `C_assertion_preflight_method`,
`C_assertion_preflight_header`, `C_assertion_put_acao`, and
`C_assertion_put_status`. Transport/timeout or absent wire headers also FAIL C.
Section 7 requires separate OPTIONS-404 and PUT-missing-ACAO controls.

### D1. Provider selection and successful consent

**Needs a browser.** Add only the dedicated IdP cookies after validating their domains.
Generate fresh state and S256 PKCE. Open MCP `/authorize` with:

```text
response_type=code
client_id=<oauth_client_id>
redirect_uri=<oauth_redirect_uri>
resource=https://mcp.commonswarm.com/mcp
scope=openid offline_access mcp
code_challenge=<SHA-256 base64url of verifier>
code_challenge_method=S256
state=<fresh random state>
prompt=consent
```

On the provider-choice page click exactly:
`a[href="/interaction/<uid>/sign-in?provider=<oauth_provider>"]`.
If there is only one provider, the service may redirect directly. The request
guard still requires the GoTrue `/auth/v1/authorize` provider to equal the fixture.
Do not assume a provider-choice page redirects itself. Do not type passwords or
2FA during the smoke. Normal IdP and GoTrue redirects use the fixture session.

Require HTTP 200 HTML on the actual interaction consent page, the TEST identity
label, and exactly the configured workspace checkbox. Uncheck, then check that
UUID and its `home_workspace_id` radio. Capture the original action and exact
URL-encoded FormData, including CSRF and selection version, before submit.
Guard this original form body before sending. Click `Allow connection` once.
Validate and abort only the exact client callback origin/path before forwarding. Require matching
state, a nonempty code, no error, and exactly one callback. Never contact or log
the client callback. This successful initial callback is D2's positive control.
Pass: correct identity and consent followed by that successful callback.
Failure: `D1 FAIL: test provider or initial consent`.

### D2. Completed-consent repeat

**Uses the same browser's authenticated request context.** Re-submit the original
body to the original action once with the same cookie jar. Send explicit
`Accept: text/html`, form content type, and MCP Origin. Do not follow redirects.
Require **HTTP 409 HTML**, heading **`Already approved`**, and exactly one safe
return link equal to `oauth_return_url` or `https://commonswarm.com/app`.
The configured client return URL is HTTPS on the callback origin and has no
credential, query, or fragment. Inspect replay HTML only in a temporary page.
There must still be exactly one successful callback.
An expired page, `Start the connection again`, a missing session, any generic
recovery page, raw JSON error, 5xx, or a second callback is **FAIL**.
Pass: completed branch confirmed with the original successful consent as control.
Failure: `D2 FAIL: completed consent replay was not acknowledged`.

### E0 and E1. Authenticated hosted MCP

**Do not need a browser.** Use Node fetch and the baseline TEST refresh token.
Require discovery issuer `https://mcp.commonswarm.com` and same-origin token
endpoint. Refresh once with baseline client ID and MCP resource. Require HTTP
200, Bearer access token, and successor. Persist successor as stated in section 3.

Initialize with protocol `2025-06-18`, empty capabilities, and client name
`cs-smoke`, version `1`. Require normal matching JSON-RPC success. Send
`notifications/initialized` and require 202. POST hosted calls to
`https://mcp.commonswarm.com/mcp` with Bearer, JSON content type,
`Accept: application/json, text/event-stream`, and `MCP-Protocol-Version: 2025-06-18`.
Use the actual fixture handle in these bodies, in memory only:

```json
{"jsonrpc":"2.0","id":"smoke-control","method":"tools/call","params":{"name":"whoami","arguments":{"seat":"<actual seat handle>"}}}
{"jsonrpc":"2.0","id":"smoke-meta","method":"tools/call","params":{"name":"whoami","arguments":{"seat":"<actual seat handle>"},"_meta":{"progressToken":"smoke"}}}
```

For both require HTTP 200, matching ID, no top-level error, no tool `isError`,
and a text result that parses as whoami. Compare workspace UUID, grant UUID,
handle, and seat name to the baseline fixture. Compare the two results.
`_meta` is beside `name` and `arguments`, not inside arguments.
E0 is the positive control. Send E1 if initialization and saved bearer exist,
even if E0's tool assertion fails. E1 cannot PASS without the positive control.
No message data is read. HTTP 200 alone is not a passing tool call.
Failure: `E0 FAIL: hosted MCP control` or `E1 FAIL: hosted MCP params._meta`.

### F. Isolation and cleanup

Remote file cleanup: **does not need a browser**. Closing the context: **does**.
Tombstone only this run's recorded file UUID, with the verified TEST user bearer,
public anon key, observed client version, and exact TEST workspace envelope.
Require HTTP 200 and `status=accepted`. Do this even if C failed after create.
On refusal retain that exact file and report FAIL. Never purge Storage or touch
another file. Tombstone allows restore for 30 days; it is not physical erasure.
Signals are immutable. Leave the fixed TEST signal in the TEST workspace and
report its UUID. Leave any consent-probe grant as a TEST fixture because its
new ID is not safely returned. Report `consent-probe-grant-retained`. Never guess
or revoke the baseline grant. This smoke does not create a hosted seat on that
new grant. HezLead can later remove retained TEST grants in a separate task.

No real briefs, emails, chats, or signals may be read. No message goes to a real
person. Account/workspace creation, deploy, restart, database changes, flags,
service-role keys, real browser profiles, keychain reads, and HOME assignments
are forbidden. No screenshots, HAR, tracing, or raw response logs are returned.
Close this run's pages/context in cleanup and `finally`. A timeout may skip
remote tombstone because the whole probe stops. Return recorded file/signal UUIDs
as leftovers and assign cleanup separately. Never allow a timeout continuation to
send a later command under another check's deadline.

EXIT cleanup removes the fresh secret directory only after checking the exact
`/tmp/anvil-secret.*` prefix, nonempty value, non-root/non-HOME identity, no symlink,
and physical-path equality. Use `rm` through PATH, including any installed guard.
Never use `/bin/rm`, `command rm`, or a deletion API to bypass a refusal.
On a guard refusal capture stderr privately, redact unknown/secret text, and
return `BLOCKED by rm guard: "<redacted refusal>". To resolve: <specific step>`.
Include the ephemeral path, with no promise of retention after runner disposal.
Recovery encryption is attempted before deletion, within the cleanup reserve.
Do not bypass deletion guards if encryption fails; apply the ephemeral-container fresh
grant policy in section 3. Refusal redaction and finalization are bounded too.
Pass: TEST-only scope, supported file cleanup, browser close, and secret cleanup.
Immutable TEST signals and the identified consent-fixture limitation can remain.
Failure: `F FAIL: isolation or supported cleanup`.

## 5. Dispatch, evidence, and failure handoff

Only after HezLead assigns the exact run, dispatch this one named workflow.
Use `GH_CONFIG_DIR=/Users/yulanbot/.config/gh-headless` on EVERY Mac `gh` call.
The Mac runs only GitHub control-plane commands and reads status evidence.
For safe run identification, serialize fixture jobs and record the exact new run ID
from the list. Before dispatch, resolve `WORKFLOW_REF` through GitHub's commits
API and require `WORKFLOW_SHA`. Dispatch only `main`, as required by the `smoke`
environment; both workflow and probe SHAs must be reachable
from `origin/main`. The job checks their ancestry before probe checkout or
credentials. After dispatch,
require the new run's `headBranch=WORKFLOW_REF` and `headSha=WORKFLOW_SHA`. Then
require the artifact's actual workflow SHA and actual checkout SHA separately.
A ref move, wrong workflow revision, or wrong checkout fails before any product
request. If run identity is ambiguous, stop and
have HezLead identify the run ID. Never watch or rerun an unrelated workflow.

```sh
[ "$WORKFLOW_REF" = main ] || exit 1
CS_RESOLVED_WORKFLOW_SHA=$(GH_CONFIG_DIR=/Users/yulanbot/.config/gh-headless gh api \
  "repos/yulanventures/commonswarm/commits/$WORKFLOW_REF" --jq .sha)
[ "$CS_RESOLVED_WORKFLOW_SHA" = "$WORKFLOW_SHA" ] || exit 1
GH_CONFIG_DIR=/Users/yulanbot/.config/gh-headless gh workflow run \
  cs-smoke.yml --repo yulanventures/commonswarm \
  --ref "$WORKFLOW_REF" -f release_kind="$RELEASE_KIND" \
  -f release_sha="$RELEASE_SHA" -f release_utc="$RELEASE_UTC" \
  -f site_sha="$SITE_SHA" -f workflow_ref="$WORKFLOW_REF" \
  -f workflow_sha="$WORKFLOW_SHA" -f probe_sha="$PROBE_SHA"
GH_CONFIG_DIR=/Users/yulanbot/.config/gh-headless gh run list \
  --repo yulanventures/commonswarm --workflow cs-smoke.yml \
  --limit 5 --json databaseId,headBranch,headSha,createdAt,status,conclusion,url
```

Poll `gh run view "$CS_RUN_ID" --repo yulanventures/commonswarm
--json status,conclusion,headBranch,headSha,url` at intervals of at most 30 s.
Send HezLead a brief progress update at least every 60 s while waiting.
Use no raw workflow log dump. A blocked job, absent report, failed setup, or
unfinished check is FAIL, not verified. Read the result artifact even for a failed job.

Create the local evidence path only during an assigned smoke:
`docs/evidence/cs-smoke/<UTC-start>-<kind>-<full-SHA>/` under the repository root.
Use a colon-free UTC start, such as `20261008T200000Z`.
Validate kind and SHA before using them in the path. Set `CS_LOCAL_EVIDENCE`
to that exact absolute directory. Download with:

```sh
mkdir -p "$CS_LOCAL_EVIDENCE"
GH_CONFIG_DIR=/Users/yulanbot/.config/gh-headless gh run download "$CS_RUN_ID" \
  --repo yulanventures/commonswarm --name cs-smoke-result --dir "$CS_LOCAL_EVIDENCE"
```

The returned `report.md` contains this status-only shape. `result.json` has the
same safe fields. Times are measured from entry, not estimates:

```text
RESULT
release_kind=<assigned kind>
release_sha=<assigned full SHA>
release_utc=<assigned UTC>
site_sha=<assigned live site SHA>
workflow_ref=main
workflow_sha=<reviewed workflow SHA>
probe_sha=<reviewed probe SHA>
actual_workflow_sha=<workflow receipt SHA>
actual_probe_sha=<measured checkout SHA>
finalized=true|false
rotation=none|saved|arm_unknown|successor_unknown|recovery_encrypted|recovery_lost
fixture_use=allowed|blocked_until_recovery_or_fresh_grant
run_utc=<entry UTC>
A=PASS|FAIL elapsed_ms=<n> reason=<fixed code>
B=PASS|FAIL elapsed_ms=<n> reason=<fixed code>
C=PASS|FAIL elapsed_ms=<n> reason=<fixed code>
D1=PASS|FAIL elapsed_ms=<n> reason=<fixed code>
D2=PASS|FAIL elapsed_ms=<n> reason=<fixed code>
E0=PASS|FAIL elapsed_ms=<n> reason=<fixed code>
E1=PASS|FAIL elapsed_ms=<n> reason=<fixed code>
F=PASS|FAIL elapsed_ms=<n> reason=<fixed code>
console_error_count=<n>
pageerror_count=<n>
total_elapsed_ms=<n>
cleanup=<status>
leftovers=<this run's safe TEST object UUIDs or fixed retention notices>
overall=PASS|FAIL
not_verified=<failed/unrun check IDs or none>
```

Failure reasons use fixed check-prefixed codes: `<ID>_timeout_<cause>`,
`<ID>_prerequisite_<cause>`, `<ID>_rotation_<cause>`, or
`<ID>_assertion_<cause>`. Codes come from owned state or named safe exceptions.
Never return raw exception text, OP stderr, mail, URLs, cookies, or browser errors.
Unrun/setup checks use `<ID>_prerequisite_setup` or
`<ID>_prerequisite_fixture_or_setup`. A timeout cannot become an assertion PASS.

Require finalized=true, every check PASS, runner conclusion success, matching release inputs,
matching expected/actual workflow and checkout revisions, fixture_use allowed,
and no recovery artifact before reporting overall PASS. Absent or unfinished
finalization means FAIL and blocks fixture use until HezLead reconciles the run.
Return this failure message through the worker response, not Slack, email, or a
CommonSwarm message:
`CommonSwarm smoke FAIL after <kind> <SHA> at <UTC>. Failed: <check IDs>.
Evidence: <local report.md path and run URL>. Left in place: <TEST objects or none>.
Next: investigate before the release window closes. No deploy or restart was run.`
For any refusal add:
`BLOCKED by <layer>: "<quoted refusal>". To resolve: <specific step>`.
Redact secret parts of a refusal. HezLead decides rollback.

## 6. Source snapshot and verified code claims

The local `origin/main` SHA read for this fold on 2026-10-08 is
`9645545fda76d78eb1e16ed6c195c9f9754095d2`.
Compared all cited repository paths with the previous source snapshot. Only the
`claim_seat` description in `supabase/functions/mcp/tools.ts` changed; its cited
whoami schema and line numbers are unchanged. Read that file from `origin/main`.
The citations below apply to this local source snapshot.
No fetch or live version check was run. Paths are relative to the repository root at that snapshot. Do not use working-tree line
numbers or claim that this SHA is live. Re-resolve the assigned surface SHAs.

| Claim | Local origin/main snapshot citation |
|---|---|
| Release gate and operator ownership | `deploy/RELEASE-TO-BOX.md:24`, `deploy/RELEASE-TO-BOX.md:30` |
| `/app` shell renders dashboard | `site/src/pages/app.astro:4`, `site/src/pages/app.astro:88` |
| Email link UI, no password | `site/src/components/app/LiveDashboard.astro:89`, `site/src/components/app/LiveDashboard.astro:105` |
| Email sign-in uses OTP and app redirect | `site/src/lib/commonswarm.ts:344`, `site/src/lib/commonswarm.ts:350` |
| Browser verifies server user | `site/src/lib/commonswarm.ts:168` |
| Current workspace UUID and aria-current | `site/src/lib/home-rail.ts:278`, `site/src/lib/home-rail.ts:279` |
| Workspace header UUID and name | `site/src/lib/home-shell.ts:341`, `site/src/lib/home-shell.ts:343` |
| Current file input | `site/src/components/app/LiveDashboard.astro:725` |
| File-input change stages file | `site/src/components/app/LiveDashboard.astro:9470` |
| Composer uploads before posting | `site/src/components/app/LiveDashboard.astro:10002`, `site/src/components/app/LiveDashboard.astro:10028` |
| Command envelope and client version | `site/src/lib/commonswarm.ts:530`, `site/src/lib/commonswarm.ts:69` |
| Startup access and to-do reads use command transport | `site/src/components/app/LiveDashboard.astro:7550`, `site/src/lib/home/client.ts:139`, `site/src/lib/home/client.ts:203` |
| Startup overview and delivery receipts are read RPCs | `site/src/lib/commonswarm.ts:2772`, `site/src/lib/commonswarm.ts:2543` |
| File create, Storage PUT, commit | `site/src/lib/commonswarm.ts:1216`, `site/src/lib/commonswarm.ts:1252`, `site/src/lib/commonswarm.ts:1267` |
| Post response signal UUID | `site/src/lib/commonswarm.ts:2292` |
| Readback row UUID and message text | `site/src/components/app/LiveDashboard.astro:5793`, `site/src/components/app/LiveDashboard.astro:5986` |
| File cards and object UUID hooks | `site/src/lib/home-stream.ts:153`, `site/src/lib/home-primitives.ts:130`, `site/src/lib/home-primitives.ts:134` |
| Actual file-card download click | `site/src/components/app/LiveDashboard.astro:6011`, `site/src/components/app/LiveDashboard.astro:6014` |
| Signed download command | `site/src/lib/commonswarm.ts:1298` |
| Multiple-provider picker and selected provider | `services/mcp-auth/src/interactions.js:354`, `services/mcp-auth/src/interactions.js:363` |
| Exact provider sign-in link | `services/mcp-auth/src/interaction-page.js:268` |
| GoTrue provider and PKCE redirects | `services/mcp-auth/src/gotrue.js:43`, `services/mcp-auth/src/gotrue.js:51` |
| TEST identity label and workspace choices | `services/mcp-auth/src/interaction-page.js:91`, `services/mcp-auth/src/interaction-page.js:319` |
| Consent form and CSRF | `services/mcp-auth/src/interaction-page.js:373` |
| Completed replay checks original session/token and returns 409 | `services/mcp-auth/src/interactions.js:287`, `services/mcp-auth/src/interactions.js:298` |
| Already approved and safe return rendering | `services/mcp-auth/src/interaction-page.js:278`, `services/mcp-auth/src/interaction-page.js:287` |
| Validated client return destination | `services/mcp-auth/src/interactions.js:130` |
| MCP issuer, resource, five-minute token TTL | `services/mcp-auth/src/provider.js:21`, `services/mcp-auth/src/provider.js:23` |
| Refresh rotation | `services/mcp-auth/src/provider.js:221` |
| This source snapshot accepts object params._meta | `supabase/functions/mcp/protocol.ts:24`, `supabase/functions/mcp/protocol.ts:59` |
| Initialized notification and tool dispatch | `supabase/functions/mcp/protocol.ts:298`, `supabase/functions/mcp/protocol.ts:332` |
| whoami seat argument and handle shape | `supabase/functions/mcp/tools.ts:18`, `supabase/functions/mcp/tools.ts:50` |
| whoami returned identity | `supabase/functions/mcp/index.ts:269` |
| Tombstone shape and 30-day purge interval | `supabase/functions/command/file-artifacts.ts:40`, `supabase/functions/command/file-artifacts.ts:1227` |
| Signals cannot be deleted through app | `SECURITY.md:46` |

This source snapshot accepts `_meta` and implements the completed-consent page.
Earlier source rejection and missing-friendly-page claims are historical, not
current-source facts. **Live behavior remains not verified.**
Existing parity smoke expects local stack credentials and creates an admin user
(`deploy/edge-runtime/parity-smoke.mjs:11`, `deploy/edge-runtime/parity-smoke.mjs:39`).
Do not use it on production. The older dark MCP check expects feature-disabled
responses (`deploy/edge-runtime/RUNBOOK.md:129`). It does not prove hosted tools.
HM37's historical accepted run recorded metadata validation failures and gaps
(`/Users/yulanbot/work/hm37-live-release/DONE-TEST-EVIDENCE.md:5`,
`/Users/yulanbot/work/hm37-live-release/DONE-TEST-EVIDENCE.md:49`).
That evidence does not provide reusable TEST credentials or current live proof.

## 7. Gaps before the first run

The workflow, action pins, and dependency lock are checked in.
**Not verified:** execution on the selected runner, Docker container support,
the `smoke` environment's main-only branch policy, environment variable and OP
secret, item permissions, and artifact return. GitHub-hosted runners are approved;
no fleet-label change is used.
HezLead or Tom must provision and review section 2 once. The exact-run assignment must name the provisioning rehearsal separately.
No production smoke is enabled until the rehearsal below passes.

Provisioning acceptance steps, outside the five-minute release clock:

1. On the GitHub-hosted Linux runner, pin action/dependency/Chromium versions and record
   them. Confirm default-branch dispatch eligibility and the `smoke` environment's
   main-only policy. Assign `main` as the workflow ref with its reviewed SHA and
   a separate full probe SHA on main.
   Dispatch the named rehearsal only.
   Require both revision receipts. Move the test ref in an isolated rehearsal and
   confirm mismatch fails before credentials or product requests.
2. Use an isolated Linux network with HTTPS test servers for the three fixed
   CommonSwarm origins. Deny any route to production. Fixture responses must satisfy
   sign-in, sole TEST membership, and the actual composer create path. Use the exact
   scripts, lockfile, bundled Chromium, and production UI build for the assigned
   SITE_SHA. No Playwright route.fetch/fulfill, CORS header repair, or browser flags
   that disable web security. The server records only method, status, and TEST IDs.
   Use separate fresh fixture runs for these three server configurations:

   | Server control | Required C result and evidence |
   |---|---|
   | OPTIONS 204 with allowed Origin/PUT/content-type, PUT 2xx with ACAO | C PASS through create/PUT/commit/post, reload and byte readback; include the delayed-create-processing run below |
   | Exact signed-path OPTIONS 404, no Access-Control-* | C FAIL `C_assertion_preflight_status`; independent OPTIONS reached that same path; no forwarded PUT/commit/post |
   | Same good OPTIONS, actual PUT 2xx missing ACAO | C FAIL `C_assertion_put_acao` from raw CDP headers; PUT reached the server; no commit/post |

   Require the working path as positive control in the same rehearsal. In an
   additional working-path run, use the isolated rehearsal harness to delay only
   the probe's create-response `response.json()` processing. Allow the app to consume
   create and start PUT, and keep CDP callbacks running. Release the delay only after
   CDP announces the candidate PUT while the probe's `uploadUrl` is still unset.
   Require C PASS and an original PUT-header receipt correlated with that candidate's
   request ID, the guarded exact upload URL, and its immutable C owner. Inspect the
   association in memory; record only a correlation PASS, statuses, and counts.
   Never record the signed URL, bearer, headers, or response body. Keep the delay in
   the isolated harness; do not add a production delay flag. Keep both CORS fault
   controls above. A failure
   caused by missing login, selectors, TLS, or membership is not proof of CORS
   detection. Record safe statuses/codes and request counts only. Prove the pinned
   Playwright version cannot hide either fault. If CDP raw headers are absent,
   refuse provisioning rather than dropping the PUT-header assertion.
3. Rehearse setup/OP-get stall, OP-edit stall including TERM refusal, IMAP stall,
   browser launch/close stall, and delayed response continuations. Require bounded
   KILL and join, no request or rotation-marker rename after check cancellation,
   no next check after an unjoined timeout, no surviving owned Chromium/OP group,
   and a finalized FAIL or a workflow missing-evidence FAIL by 300 s. Verify that
   init, encryption, timeout launchers, and browser children lack OP ingress.
4. Use disposable TEST rotation credentials. Prove `in_use` is saved before refresh
   and blocks a second run. Force successor-save failure and confirm only completed
   age ciphertext is returned. Download/decrypt it with HezLead, restore the
   successor plus ready state, and verify a subsequent assigned control refresh.
   Force age failure, artifact-upload failure, missing successor, and runner loss.
   Require FAIL, fixture reuse blocked, and a fresh grant unless saved successor
   can be verified. Never claim a ephemeral plaintext hold. Test deletion refusal
   with the approved guard; require its redacted quoted BLOCKED line and ephemeral
   path in evidence. Test invalid path refusal without bypassing it.

These steps are requirements, not completed proof. This fold runs none of them.

**Not verified:** the dedicated account, exclusive mailbox, magic-link delivery
format, redirect allowlist, five-minute delivery timing, UUIDs, baseline grant,
seat handle, and absence of real members. HezLead/Tom must create and validate
section 3 once. Mailbox delivery latency must fit B's absolute deadline.

**Not verified:** accepted client metadata/callback, linked TEST provider identity,
IdP cookie freshness, provider origin allowlist, and same-client return policy.
HezLead/Tom must validate the dedicated fixture and selected provider once.
The smoke must FAIL on expired fixtures or wrong identity. It has no real-browser fallback.

**Not verified:** the scripts against a provisioned runner, live sign-in,
attachment upload/download/tombstone, completed replay, or live MCP `_meta`.
Only syntax and local source review were performed during preparation.
No production request, browser, secret read, commit, deploy, restart, workflow
dispatch, Alloy run, or sub-agent was used for this documentation fold.
Do not claim measured timing or regression proof until HezLead assigns that run.
