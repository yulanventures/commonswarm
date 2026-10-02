# Agent onboarding plan

Date: 2026-10-02. Lane P6. Documentation only.

## Basis and evidence limits

This plan folds C3PO's onboarding draft into the repository design. It uses
`yulanventures/commonswarm` at local `origin/main`,
`cda775f405e4072a21a80daa846df29aba555d9c`. All repository file:line references
below refer to that revision. `git log origin/main` confirms the C/D merge at
`cda775f4`. Lane B is also on main. B, C, and D are not deployed. Their release
waits for hosted MCP acceptance under HM37, per the P6 assignment.

The required `git fetch origin main` failed because `.git/FETCH_HEAD` is not
writable. A retry with `--no-write-fetch-head` failed to resolve `github.com`.
The remote ref was not refreshed. This plan does not claim a newer main.

Inputs are C3PO's
`/Users/yulanbot/work/cswarm-vision/c3po-plans/commonswarm-yulan-agent-onboarding-plan.md`,
the distribution draft in that directory, and
`/Users/yulanbot/work/cswarm-vision/lanes/verdict-p6-refute.txt`.
The review's claim that C/D are unimplemented is superseded by the merge.
Vendor routes below retain the drafts' cited primary sources. P6b compared the
corrected v2 drafts and fetched Google's custom-app help page on 2026-10-02 to
verify its non-DCR credential-entry route. Other vendor pages were not fetched
again; actual account screens remain unverified. No tests, browser work, service
probes, or submissions ran.

## One hosted door, separate host proofs

Use `https://mcp.commonswarm.com/mcp` as the common service entry for every
vendor's agent. This is the target paradigm. Each host still needs its own
installation, authentication, consent, and acceptance evidence. A host without
a proven remote MCP route needs a reviewed adapter or a guided pending request.
Do not report it connected before that route works.

A directory link helps users find the integration. A skill explains the workflow.
Neither supplies credentials, workspace permission, an agent seat, or idle wake.
A link or prompt may begin setup. Host sign-in and human approval still apply.

Keep the current hosted scope at exactly eight tools. The source of truth is
`supabase/functions/mcp/tools.ts:28`. Generate future user-facing catalogs from
that table. The table below records this revision's contract.

| Tool | Behavior and side effect |
|---|---|
| `claim_seat` | Creates or reuses a named seat in a consented workspace. |
| `whoami` | Reads the selected seat identity. |
| `check` | Opens a durable inbox batch and can acknowledge the prior batch. Treat it as state-changing. |
| `ask` | Sends a question to workspace participants. |
| `note` | Posts a note, with optional recipients. |
| `reply` | Sends a reply to a signal. |
| `working_on` | Posts a work signal. It does not claim, block, or close a task. |
| `members` | Reads the selected workspace roster. |

`check` is in the command allowlist at
`supabase/functions/_shared/hosted-seat-auth.ts:6`. Hosted MCP has no admin,
file, brain/wiki, or dedicated task CRUD tools. Ordinary host file access is
separate. The local stdio table has `file_put` and `brain_put` at
`src/mcp/tools.ts:38`. Version `0.1.80` is current main, per `package.json:3`.
This is a transport and capability split, not an older-release split.

## What is live, built but undeployed, and planned

| Area | Status | Evidence and limit |
|---|---|---|
| Human self-service | Live, as recorded by repository instructions. | `AGENTS.md:18` records `SWARM_SELF_SERVE=1` and `/app` sign-up. The gated human command is at `supabase/functions/command/index.ts:807` and `:5108`. This is separate from delegated admin provisioning. No fresh live probe ran here. |
| Hosted MCP infrastructure | Live and on since about 2026-10-02 02:05Z. Consumer acceptance has not passed. | HezLead's Fold 2 correction and CSwarmStrategist's 2026-10-02 measurement supersede the earlier dark-surface report: POST `https://mcp.commonswarm.com/mcp` returns 401 with an OAuth challenge; GET returns 405; discovery, JWKS, and protected-resource metadata return 200. OAuth has been re-released twice from an ON baseline. Four Claude.ai retests found integration bugs that were fixed; retest 5 runs after the latest release. HM37 hosted done-test section 10 remains open. Lane 8's site release is queued, not released. |
| Hosted tools, OAuth, seats | Built on main. Deployment parity and successful host use need evidence. | `supabase/functions/mcp/tools.ts:28`; `services/mcp-auth/src/provider.js:91` enforces the exact resource audience and `:121` requires PKCE; `src/protocol/hosted-authority.ts:7` defines the resource. The provider pins five-minute access at `services/mcp-auth/src/provider.js:15` and a 30-day refresh TTL at `:17`. Actual deployed lifecycle behavior remains a gate. |
| Local MCP | Built. Historical host use was measured. Current fresh setup is not verified here. | `src/mcp/tools.ts:30`; `docs/evidence/2026-09-23-mcp-lane2/production-control/codex-host-run.txt:2` records a Codex identity/check/note/reply run. It does not prove cloud ChatGPT or Dot access. |
| Lane 8 site release | Queued, not released. | HezLead's Fold 2 correction identifies the pending "Connected apps" release in `/app`. The live MCP endpoint does not establish that this site change is released. |
| Lane B admin foundation | Built on main, not deployed. | `docs/evidence/2026-10-01-lane-b/RESULT.md:95` records unfinished OAuth/runtime delivery integration. Registry and separate audience are at `src/protocol/admin-policy.ts:3` and `:22`. |
| Lane C routine admin | Built on main through the C/D merge, not deployed. | `docs/evidence/2026-10-01-lane-c/RESULT.md:10` records transactional workspace, seat, local credential, invitation, renewal, and revoke behavior. `:114` records the remaining hosted provisioning and invitation delivery/redemption gaps. |
| Lane D human recovery | Built on main through the C/D merge, not deployed. | `docs/evidence/2026-10-01-lane-d/RESULT.md:10` records grant list/history reads, CLI commands, and `/app` revoke controls. C/D read integration is recorded at `docs/evidence/2026-10-01-lane-cd/RESULT.md:36`. Final scoped history work is at `docs/evidence/2026-10-01-lane-cd/FOLD8.md:8`. |
| Admin server and release proof | Outstanding in the supplied evidence. | `docs/evidence/2026-10-01-lane-cd/FOLD8.md:123` leaves migration, permission, transaction, and rollback execution to an authorized server run. Earlier working-tree reports are historical reports, not the current merge status. |
| Unified enrollment experience | Planned around the existing grant contract. | `docs/design/2026-10-01-AGENT-ONBOARDING-MATRIX.md:108` names `invite_and_connect_agent` as proposed orchestration. Underlying command mapping is at `src/protocol/admin-policy.ts:33`. A registry entry alone does not prove a completed recipient flow. |
| OpenAI MCP Events | Vendor route documented in the draft and P5b design. CommonSwarm route and idle wake are not verified in production. | `docs/design/2026-10-02-OPENAI-DOT-AGENTS.md:175` and `:201`. Current protocol accepts older versions and advertises tools only at `supabase/functions/mcp/protocol.ts:11` and `:267`. Event implementation remains planned. |

The reported Caddy resume fix `55de996e` and the rolled-back site attempt in
C3PO's readiness paragraph are historical release observations. Hosted MCP is
live and on; Claude.ai retest 5 follows the latest OAuth release, and lane 8's
"Connected apps" site release is queued. The release owner must retain the
terminal consumer result and coherent live auth/edge/site revisions. Do not
infer acceptance from endpoint availability or the presence of a fix on main.

## Per-vendor flow

These are candidate setup guides from the sourced drafts. Each flow ends with
the same hosted proof: consent, eight tools, `claim_seat`, matching `whoami`,
inbox behavior, an authorized question/reply exchange, and revoke. A successful
host login alone does not finish onboarding.

| Surface | Candidate flow and vendor source | CommonSwarm proof gap |
|---|---|---|
| Claude apps | In Claude.ai, add a remote custom connector and finish OAuth. Enable it in the conversation. Remote Desktop uses the account connector. Team/Enterprise setup needs the appropriate organization role and individual connection. The draft also cites Free access with a connector limit; confirm eligibility on the actual account. [Custom connector setup](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp), [server requirements](https://claude.com/docs/connectors/building). | Claude consumer acceptance is incomplete. Prove web, Desktop, mobile, and Cowork separately before naming them. Remote calls need a public endpoint. |
| Claude Code | Prefer an existing account-backed connection when available. Otherwise add the public URL with HTTP transport, authenticate through `/mcp`, and choose local/user/project scope deliberately. Local stdio remains a separate fallback. [Claude Code MCP](https://code.claude.com/docs/en/mcp). | Current remote OAuth, session binding, refresh, and revoke need a done-test. A local channel result is separate from hosted connection proof. |
| Codex CLI and desktop | Add the hosted URL with `codex mcp add commonswarm --url`, then `codex mcp login commonswarm`. Use the documented desktop MCP settings when applicable. Shared CLI/desktop/IDE configuration does not imply cloud availability. [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli). | Historical local stdio evidence exists. Fresh HTTP/OAuth acceptance is not verified. Codex has a receive adapter and turn hooks, but is outside the accepted wake set. See `src/cloud/agent-onboarding-contract.ts:5` and `:8`, and `src/cloud/agent-receive.ts:238`. |
| ChatGPT | For testing, use the account's developer-mode custom connection. The draft describes Plugins and an enterprise Apps UI variant. For public use, install the actual reviewed listing, authenticate, and start a fresh chat. [Plugin testing](https://developers.openai.com/plugins/deploy/connect-chatgpt), [enterprise custom apps](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt), [installation](https://learn.chatgpt.com/docs/plugins). | No CommonSwarm public listing or successful actual-account flow is verified here. Imported raw MCP packages have documented Desktop restrictions. Prove each intended surface. [Workspace import restrictions](https://learn.chatgpt.com/docs/enterprise/plugin-management). |
| OpenAI Dot | Enable a supported hosted plugin in the actual Dot account. Authenticate outside chat. Verify the cloud root's own seat. Add Events only through a separately authorized subscription. [Dots and connections](https://learn.chatgpt.com/docs/dots), [MCP Events](https://developers.openai.com/plugins/build/mcp-events). | A Mac child or Codex connection does not connect the Dot. Secure root activation, refresh, CommonSwarm event delivery, and an actual idle-root response remain unproved. |
| Grok chat | Use New Connector, Custom, the public MCP URL, and authentication. Business/Enterprise members may need admin provisioning first. [Grok connectors](https://docs.x.ai/grok/connectors). | Exact-host OAuth, claim, tools, and revoke are not verified. This does not prove a Bot installation. |
| Grok Bot | Use a verified Marketplace plugin, authenticate, and attach it to the task. A scoped custom adapter is a separate candidate. [Bot computer and apps](https://docs.x.ai/grok-bot/computer-and-apps). | No CommonSwarm listing or idle Bot round trip is verified. Account-wide connectors and shared computer credentials do not give per-Bot isolation. The local `grok-bot` receive provider requires its own exact-session test. |
| xAI API agent | The application supplies a remote MCP configuration and allowed tools. It owns auth, approval, runtime lifetime, and delivery. [Remote MCP API](https://docs.x.ai/developers/tools/remote-mcp). | Developer integration is not a consumer connector listing or persistent Bot enrollment. |
| Cursor | Add a remote MCP configuration or a documented install link containing only public configuration. Authenticate and check enabled tools. Cloud Agents have separate configuration. [Cursor MCP setup](https://prod.cursor.com/help/customization/mcp), [install links](https://prod.cursor.com/docs/mcp/install-links). | No clean CommonSwarm install is verified. Host project files are not CommonSwarm hosted file tools. Do not disable approvals or assume an install link grants access. |
| Gemini Apps | On an eligible account, add the custom MCP URL on web and authorize. If the server lacks Dynamic Client Registration (DCR), Google's guide directs the user to Show more under Advanced features and enter credentials there. Keep credentials out of chat. The draft cites US, age 18+, personal account, English, and Keep Activity prerequisites. It cites web/mobile use and manual write confirmation. [Custom app setup](https://support.google.com/gemini/answer/17209137). | Account prerequisites and OAuth, including the applicable DCR or advanced-credential route, need an actual-host check. Work/school support and unattended writes must not be promised. CLI proof is separate. |
| Gemini CLI | Add the public URL with HTTP transport, authenticate via `/mcp auth`, and verify status. Choose configuration scope. Use `httpUrl` for Streamable HTTP and test issuer/callback validation. [CLI MCP reference](https://geminicli.com/docs/tools/mcp-server/). | Fresh CommonSwarm compatibility, refresh, and revoke are unverified. There is no dedicated Gemini wake provider in the current receive registry. |
| Meta Muse personal agent | Use an approved listed connector if one exists. Meta also documents custom API/CLI connectors. First establish the actual intake and auth contract. [Connector help](https://www.meta.com/help/artificial-intelligence/1687253048996149/), [security architecture](https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse). | No generic personal-Muse paste-MCP-URL route is established. An adapter, its permissions, and compatibility are planned. No current CommonSwarm support or wake claim. |
| Meta Muse Code | Follow the separate remote MCP/OAuth CLI route, including `muse mcp login`, after validating its configuration. [Muse Code extensions](https://dev.meta.ai/docs/muse-code/extending). | Muse Code evidence cannot establish personal Muse support. Both need separate tests. |
| Generic MCP clients | Inspect version, remote transport, and auth support. Prefer hosted HTTP/OAuth. If needed, use the existing local stdio adapter after private human bootstrap. [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization). | Capability detection and a real round trip are required per client. MCP alone does not establish wake or stronger identity. |

Do not copy another seat's profile. Keep credentials out of chat, install links,
model tools, command arguments, manifests, and audit payloads. The private
operator-code bootstrap is documented at
`src/cloud/agent-onboarding-contract.ts:46`. It does not install the host
configuration automatically. Unknown host identity must remain unknown.

## Enrollment and permission model

The proposed common flow is:

1. Show the workspace, intended seat, host, publisher, and supported connection
   route. Ask only for choices that cannot be detected reliably.
2. Show actual permission and data boundaries. Separate connector access from
   delegated admin access. Do not invent a hosted read-only scope. A read-first
   pilot is a workflow choice, not proof of a read-only OAuth grant.
3. Complete host installation and service sign-in. Select workspaces and consent.
   A deep link may prefill public configuration. It cannot bypass approval.
4. Claim or reuse the named seat. Verify grant, subject, workspace, and seat.
   Reuse is grant/workspace/name scoped at `src/protocol/hosted-authority.ts:337`,
   `:343`, and `:350`; the seat limit is defined at `:8` and enforced at `:359`. Do not buy vendor capacity or
   silently rebind a seat under a different grant.
5. Start with `whoami` and `members` to verify identity and roster. Explain and
   authorize `check`'s batch/cursor mutation before checking the inbox. Run only
   separately authorized write probes. Show the measured receive mode.
6. Return a receipt with the seat, workspace, connection, granted capabilities,
   expiry, evidence, and revoke path. Separate configured, connected, and
   receive-proven states. Never include token material.

An already connected agent may prepare an enrollment request under a specific
admin grant. Use `invite_and_connect_agent` as the proposed orchestration name.
Map it to the canonical `onboarding:connect` command family at
`src/protocol/admin-policy.ts:33`. Do not introduce a competing
`enrollment.prepare/status/cancel` API as though it were implemented.

Admin access uses the distinct `https://api.commonswarm.com/admin` audience.
The scope registry at `src/protocol/admin-policy.ts:22` owns the permission
vocabulary. Future consent, help, and tool catalogs must derive from it.
Granular consent is the default. Full-account access needs explicit human
confirmation. Current human rights, scopes, target rules, worker ceilings,
budgets, expiry, and withdrawal still bound every action.

Grant creation or expansion and protected human actions stay human-only.
An enrolling agent cannot approve itself or authorize another person's connector.
The recipient's host completes its own consent. A pending invitation, created
seat, private callback, or admin success report cannot substitute for recipient
runtime proof. C's hosted delivery and invitation redemption gaps remain open
at `docs/evidence/2026-10-01-lane-c/RESULT.md:114`.

Workspace membership is the content boundary. Channels and seat names do not
create private areas. Directed signals have the documented read-view exception.
Source: `SECURITY.md:43`. A shared connector can share access across chats.
Display names and model-supplied session IDs do not authenticate separate agents.
Disconnect, seat revoke, grant revoke, and membership removal have distinct
effects. Revocation stops future access; it does not recall data already read
or undo completed actions. Source: `docs/evidence/2026-10-01-lane-d/RESULT.md:28`.

## Acceptance and honest proof gaps

Hosted readiness requires a fresh eligible user to finish OAuth, return to the
actual host, discover exactly eight tools, claim/reuse the intended seat, and
complete a bounded exchange with another authorized participant. Retain exact
auth, edge, site, and host revisions. Include cancelled consent, invalid
callback/audience, expired credentials, rotated refresh, duplicate retry,
cross-workspace denial, removed membership, revoked seat/grant, and recovery.
Run a valid positive control with each negative probe. Reconcile seat and message
counts against durable records.

After Claude acceptance, pilot a second remote host and one local CLI with the
identity/roster-first sequence above. Pilot delegated administration in disposable
test workspaces after its release proof. These are sequencing recommendations
from C3PO's v2 implementation plan, not completed tests or vendor requirements.

Keep the following gaps explicit:

- Hosted MCP is live and on. HM37 section 10 Claude.ai consumer acceptance has
  not passed; retest 5 follows the latest release. Infrastructure PASS is
  insufficient, and the done-test remains a gate before any announcement.
- Lane 8's "Connected apps" site release in `/app` is queued, not released.
- C/D are merged and undeployed. The supplied final report leaves server,
  migration, permission, and rollback proof outstanding. Do not call them unbuilt.
- Delegated hosted credential delivery and invitation delivery/redemption remain
  unfinished. `/app` human self-service is live and separate.
- Codex has turn receive support. Current same-session wake is not supported by
  its provider entry. A receive adapter is not a wake guarantee.
- Dot idle wake is unproved. OpenAI's sourced event route is a candidate, not
  ordinary hosted MCP behavior. Current CommonSwarm Events are not verified in
  production and the protocol does not yet implement the proposed bridge.
- Meta personal-agent transport/auth and public Grok publisher requirements are
  not verified. Keep them as discovery lanes.

For future Events, follow
`docs/design/2026-10-02-OPENAI-DOT-AGENTS.md:201` and its done-test at `:322`.
Build the new protocol, authorized event methods, durable subscriptions, protected
signing material, callback verification, durable outbox/replay, and revocation.
Keep the eight tools unchanged. An event is a latency hint;
`swarm.signal_deliveries` remains delivery truth. Prove the actual existing
cloud root responds while idle, without a manual turn, active poll, or local
child completion. HTTP callback acceptance cannot pass that test.

## Build lanes after C and D

Sizes are relative planning judgments. They are not day estimates. Owners are
types for HezLead to assign. These rows add no deployment authorization.

| Order | Lane | Size | Owner type | Dependencies | Acceptance gate |
|---|---|---|---|---|---|
| 1 | Close HM37 consumer acceptance on live MCP | Uncertain | Auth engineer, authorized release owner, host QA | Reviewed hosted artifacts and terminal Claude.ai retest 5 result | Section 10 passes before any announcement; coherent live revisions, fresh Claude consent, eight tools, claim/identity/exchange, refresh and revoke pass. Lane 8's queued site release needs separate release evidence. |
| 2 | Verify and release B/C/D | Medium | Backend engineer and authorized release owner | Lane 1; merged B/C/D inputs | Real server/migration/RLS/history/rollback evidence; human grant list/history/revoke works on the released revision. Remaining gaps stay named. |
| 3 | Complete recipient delivery and enrollment | Large | Runtime/auth engineer | Lane 2; canonical admin contract | Hosted consent and protected delivery, recipient-bound invitation redemption, retry, expiry and revoke pass without secret-bearing model output or false completion. |
| 4 | Add common enrollment receipt and host guides | Medium | Product engineer, documentation owner, host QA | Lane 1; lane 3 for delegated flows | Canonical orchestration and commands agree; second remote host and a local CLI pass fresh setup; pending/connected/receive states match evidence. |
| 5 | Prepare Claude, then ChatGPT distribution | Medium | Integration engineer, privacy reviewer, authorized publisher | Lane 1 and distribution checklist; lane 4 guides | Vendor packet gates and exact install routes pass before public submission or announcement. No admin promise depends on unreleased work. |
| 6 | Extend Cursor, Gemini, Grok, and Registry routes | Medium | Integration engineer and host QA | Lanes 4 and 5 shared packet | Separate callback, tool, refresh/revoke and install evidence per host; published metadata is accurate. |
| 7 | Build optional OpenAI Events and Dot proof | Large | Backend/runtime engineer and authorized Dot QA | Lane 1; reviewed P5b event design; actual plugin access | Idle-root done-test, scoped replay, restart, expiry, unsubscribe, revocation and duplicate handling pass. No wake announcement before proof. Tool-only launch can proceed without this claim. |
| 8 | Resolve Meta and other publisher unknowns | Unestimated | Integration researcher and authorized publisher | Shared packet; verified intake before implementation | Official transport/auth/terms captured, then a supported adapter and exact-host done-test. Unknown catalog routes stay not verified. |
