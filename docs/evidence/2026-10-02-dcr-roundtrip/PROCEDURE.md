# Fresh-client DCR OAuth round trip

This procedure is ready to run; this lane did not contact production. A passing
receipt proves a newly registered public client can consent, exchange an S256
PKCE authorization code for a resource-bound token, and initialize/list tools at
`https://mcp.commonswarm.com/mcp`. It does not prove a ChatGPT directory install,
refresh/revocation behavior, or execution of every tool. HezLead retains the
receipt as evidence for the first publisher action in
[GAPS.md](../2026-10-02-distribution-gaps/GAPS.md).

## Lead: prepare on the Mac mini

Use Node 22+ in the reviewed checkout, without changing HOME. No dependencies,
1Password access, pre-registered client ID, client secret, or credential files
are needed. No production configuration change is required.

```sh
node scripts/dcr-roundtrip.mjs --dry-run
node scripts/dcr-roundtrip.mjs
```

Dry run prints planned requests without network or credential generation. The
live invocation prints exactly one authorization URL to stdout for the human
step and waits for a hidden stdin paste. Keep it running in a private terminal;
do not redirect or tee the entire session to a file. All script HTTP requests
use `User-Agent: curl/8.7.1`, refuse redirects, and time out after 10 seconds,
including response-body reads. Consent input times out after 10 minutes.

Loopback is disabled by default: `services/mcp-auth/src/config.js:203` enables
it only with `MCP_OAUTH_NATIVE_LOOPBACK_ENABLED=1`, and
`deploy/mcp-auth/env.example:10` leaves that setting empty. The script therefore
uses the HTTPS alternative `https://dcr-release-probe.invalid/callback` already
accepted by the release's anonymous DCR probe
(`docs/evidence/2026-10-02-dcr-release/RELEASE-V2.md:1380`). The reserved `.invalid`
host deliberately has no receiving server. Do not enable native loopback for
this test, reuse the GoTrue login callback, or send the code to a public echo
service. There is no local listener.

## Anvil: attended consent only

HezLead assigns Anvil the specific computer-use step. Anvil uses browser-harness
in Tom's real Chrome, creates a task-owned tab, retains its target ID, and opens
only the printed authorization URL. The script itself never launches a browser.
Use the CommonSwarm test account, choose the designated test workspace, and
approve the connection. If the current session is a different account, stop and
report to HezLead; do not switch accounts by signing out. Credentials, if needed,
come only from 1Password through the service-account token file, under the Anvil
secret-staging rules. Complete 2FA only while Tom is watching.

**Do not click Sign out: it is global. Do not visit other sites, use other
workspaces, or navigate/close any pre-existing tab.** Follow only the consent
flow's CommonSwarm authentication redirects. No directory submissions or app
settings edits are part of this step.

After approval the tab reaches the `.invalid` callback and displays a navigation
error. That error is expected. The full callback URL remains in the address bar,
including `code` and `state`. Paste that URL directly into the waiting script's
hidden terminal input and press Enter; coordinate the direct paste with the lead.
Never put the callback URL/code in chat, a shell command or argument, an
environment variable, a screenshot, clipboard-history archive, log, or file.
Do not paste only the code: the script must verify the returned state. The
authorization code expires in 60 seconds, so paste immediately after approval.
Close only the task-owned tab after the lead confirms completion; clear the
clipboard if it was used. No code, token, or verifier is persisted by the script.

## Expected evidence

| Step | Required result |
| --- | --- |
| Authorization-server discovery | 200 JSON, expected issuer, advertised registration/authorization/token endpoints on the same issuer, S256 and `mcp` scope, no PAR |
| Protected-resource discovery | 200 JSON at `/.well-known/oauth-protected-resource/mcp`, exact `/mcp` resource, expected authorization server and `mcp` scope |
| Advertised registration endpoint | 201 JSON, fresh generated client ID, auth method `none`, exact HTTPS redirect, no client secret or registration access token |
| Browser consent | Test account and chosen workspace; approval redirects to the reserved callback |
| Hidden callback input | Matching state and destination; matching issuer if returned; nonempty code and no OAuth error |
| Advertised token endpoint | 200 JSON, Bearer access token, positive lifetime and `mcp` scope; code/verifier/resource included in exchange |
| MCP initialize | 200 JSON-RPC, negotiated supported protocol, server name `commonswarm` |
| MCP initialized notification | 202 |
| MCP tools/list | 200 JSON-RPC with nonempty tool list (current catalog: eight) |

The final stdout JSON is an allowlisted receipt with `ok`, per-request status and
normalized content type, eight-character client ID prefix, token type, lifetime,
scope, tool count, and server name. It omits tokens, code, verifier, arbitrary
server text, and full client ID. Copy only that final JSON into the lead's safe
evidence report. Exit 0 with `ok: true` is PASS. On failure the script exits 1,
emits partial redacted evidence and a fixed stage/reason on stderr; stop and give
HezLead that evidence. It does not retry registration or token exchange. A rerun
creates another client; avoid repeated attempts (registration is rate-limited).

The source Caddy file still has an OAuth-only activation template. The supplied
DCR V2 release report records the live MCP routes enabled separately. Discovery
or MCP 503 means this live run cannot pass; report it without changing routes.

## Cleanup and connection revocation

The process exits with all credentials held only in memory. Registration metadata
expires after 30 days without authorization/token use; hourly cleanup removes
expired registrations. Expiry is not immediate consent revocation.

The lead or a separately assigned cleanup operator opens `https://commonswarm.com/app`
as the same consenting account, opens the user menu → **Connected apps**, and
locates this test's connection by client prefix and approved workspace. The
default web client has no declared brand/logo; match the recorded prefix rather
than a guessed display name. Click **Revoke connection**, confirm only that
connection, and check its revoked status. This stops all its hosted seats;
**Revoke seat** affects only an individual seat. This test lists tools without
creating a seat. UI grant revocation does not delete the DCR registration row;
that unused metadata can expire normally. Anvil's consent-only assignment does
not authorize navigating elsewhere for cleanup: HezLead assigns this separately.
Never click Sign out as cleanup.
