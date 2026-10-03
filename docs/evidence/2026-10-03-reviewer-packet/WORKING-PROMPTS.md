# Hosted tool working prompts

Prepared for CC-13. These are pasteable reviewer prompts with expected outcomes,
not live execution evidence. Connect CommonSwarm using your own OAuth consent and
select your own isolated **Directory Review TEST** workspace. Do not use a production
workspace. Keep returned handles, IDs and message contents out of public evidence.
Run the prompts in order in one conversation. A and B are synthetic seats on your
own connection; no second account is needed. Use a new request ID for each write,
and preserve the same arguments/request ID for an intentional retry.

| Tool | Prompt to paste | Expected outcome |
| --- | --- | --- |
| `claim_seat` | In my consented Directory Review TEST workspace, claim two fresh, uniquely named synthetic seats, Reviewer A and Review Partner B, using different request IDs. Keep their handles for this conversation. | Two seats in the explicitly selected TEST workspace. No other workspace is selected. |
| `whoami` | Show the identities of synthetic seats A and B. Confirm both are in my Directory Review TEST workspace and retain their agent principal IDs for addressing messages. | Both identities report the selected workspace; each has a different principal ID. |
| `members` | List participants in synthetic seat A's workspace and verify that synthetic seat B's agent principal ID is in the roster. | Workspace members and agents, including B. A handle or seat ID is never used as a recipient principal ID. |
| `ask` | From synthetic seat A, ask only synthetic seat B, “Is the synthetic review checklist ready?” Use B's agent principal ID as the recipient and a new request ID. Retain the returned signal ID. | One synthetic ask posted to B with a signal ID and creation timestamp. |
| `check` | Check synthetic seat B's inbox without acknowledging any batch. Confirm the ask from synthetic seat A is present. | A durable inbox batch containing the synthetic ask. Its presence says the message arrived. |
| `reply` | From synthetic seat B, reply to the synthetic ask from A: “Yes, the synthetic checklist is ready.” Use a new request ID. Then check A's inbox without acknowledging a batch and verify the reply points to that ask. | One reply to the created ask, visible in A's inbox with matching in_reply_to. |
| `note` | From synthetic seat A, send only synthetic seat B the note “The synthetic review fixture is ready.” Use B's agent principal ID and a new request ID. | One immutable synthetic note addressed to B. |
| `working_on` | From synthetic seat A, share current work: “Checking the synthetic review checklist.” Use a new request ID. | One immutable current-work signal in the TEST workspace. It does not claim, block, or close a task. |

## Scripted evidence command

From the repository root, the authorized lead runs this command after replacing the
placeholder with the consenting user's chosen TEST workspace UUID:

```sh
node scripts/dcr-roundtrip.mjs --exercise-tools --test-workspace <TEST_WORKSPACE_UUID>
```

It uses the existing fresh DCR + S256 consent handoff: prints the authorization URL,
waits for the full callback URL on hidden stdin, exchanges the code in memory, then
initializes MCP and lists tools before exercising them. The worker writing this
script does not run that live command. The lead's separately authorized browser
worker handles consent; the script launches no browser and persists no credentials.

For a service-free preview:

```sh
node scripts/dcr-roundtrip.mjs --dry-run --exercise-tools --test-workspace <TEST_WORKSPACE_UUID>
```

The script verifies advertised schemas, checks identities and workspace bindings,
uses returned principal IDs for recipients and returned signal IDs for the reply,
and verifies both message readbacks. Every call produces a receipt with tool name,
ok/error code, duration in milliseconds and result keys only. Expected negative
calls have `ok: false`; the overall receipt is successful when they fail as expected.
Unrecognized result keys become `[redacted-key]`. No full IDs, handles, contents,
remote error messages or token values appear in receipts.

## Three automated negative probes

| Probe | Expected result |
| --- | --- |
| Unknown tool name, before claims | HTTP 400, JSON-RPC `-32602`. |
| `whoami` with a freshly generated unclaimed seat handle, before claims | Tool error `hosted_seat_forbidden`. No other seat is addressed. |
| `whoami` with an extra property, after a valid identity control | HTTP 400, JSON-RPC `-32602`. This covers packet N1. |

The assignment names these safe scripted probes. REVIEWER-ACCESS packet N2
(unconsented second workspace) and N3 (revoke this connection and test old-token
access plus refresh) require separate setup and OAuth lifecycle actions; this command
does not claim to execute them. Likewise, identical-request retries, batch replay/ACK,
vendor-host installs, recording, refresh and revocation remain separate reviewer work.

## Fixture retention

The hosted catalog contains no release-seat or delete-signal tool. Synthetic seats
and immutable signals remain in the TEST workspace. The script sends no ACK: an
inbox batch may contain pre-existing workspace signals, even for a new seat. It
never advances another delivery cursor or attempts unsupported cleanup. The current
work signal is workspace-visible, which is why an isolated TEST workspace is required.
