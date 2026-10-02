# Distribution plan

Date: 2026-10-02. Lane P6. Documentation only.

## Basis and release posture

This plan uses local `origin/main` at
`cda775f405e4072a21a80daa846df29aba555d9c` in
`yulanventures/commonswarm`. Repository file:line references refer to that
revision. The required fetch failed on Git metadata permissions, then DNS on a
`--no-write-fetch-head` retry. The remote ref was not refreshed.

It folds in C3PO's
`/Users/yulanbot/work/cswarm-vision/c3po-plans/cswarm-distribution-plan.md`
and onboarding draft, with
`/Users/yulanbot/work/cswarm-vision/lanes/verdict-p6-refute.txt`.
Vendor facts below are retained from those sourced drafts. P6b compared the
corrected v2 drafts and fetched Google's custom-app help page on 2026-10-02 to
verify its non-DCR credential-entry route. Other linked pages were not fetched
again. Current submission rules must be checked by the authorized publisher
before submission. Anything without that source basis is marked not verified.
This lane ran no tests or service probes and submitted nothing.

`git log origin/main` confirms C/D merged at `cda775f4`. Routine admin and
human grant list/history/revoke are built on main. B is also on main. B/C/D
are undeployed and wait for HM37 hosted acceptance, per the P6 assignment.
See `docs/evidence/2026-10-01-lane-c/RESULT.md:10`,
`docs/evidence/2026-10-01-lane-d/RESULT.md:10`, and
`docs/evidence/2026-10-01-lane-cd/FOLD8.md:123` for implementation and proof limits.
Do not repeat the refuting review's superseded claim that C/D are unimplemented.

Human self-service workspace creation is live at `/app`, as recorded in
`AGENTS.md:18`. It is separate from undeployed delegated administration.
Hosted admin runtime delivery and routine invitation delivery/redemption remain
unfinished at `docs/evidence/2026-10-01-lane-c/RESULT.md:114`.
Reviewers can use the human self-service route. Do not claim an agent can deliver
or redeem those routine invitations today.

The hosted service has exactly eight tools: `claim_seat`, `whoami`, `check`,
`ask`, `note`, `reply`, `working_on`, and `members`.
Source: `supabase/functions/mcp/tools.ts:28`. Generate listing catalogs from
that table. Hosted file/wiki/admin/task CRUD is absent. Local stdio's file and
brain tools are a different surface at `src/mcp/tools.ts:38`. Version `0.1.80`
is current main at `package.json:3`, not an older CLI version.

Hosted MCP is live and on since about 2026-10-02 02:05Z, per HezLead's Fold 2
correction and CSwarmStrategist's 2026-10-02 measurement: POST
`https://mcp.commonswarm.com/mcp` returns 401 with an OAuth challenge; GET
returns 405; discovery, JWKS, and protected-resource metadata return 200.
OAuth has been re-released twice from an ON baseline. Four Claude.ai retests
found integration bugs that were fixed; retest 5 runs after the latest release.
HM37 hosted done-test section 10 (Claude.ai consumer acceptance) has not passed.
Lane 8's "Connected apps" site release in `/app` is queued, not released.
Hold public submissions and announcements until the relevant gates pass;
the consumer done-test remains a gate before any announcement.

## Channels and their acceptance gates

A custom connection, reviewed listing, CLI extension, MCP Registry record, and
event subscription are separate routes. Each has a separate install and done-test.
None proves another route works. Vendor approval, featured placement, fees,
review duration, and CommonSwarm listing availability are not verified unless
the specific evidence says otherwise.

### Claude connector directory and companion plugin

Use the developer portal at [Claude directory management](https://claude.ai/directory/manage).
The draft's [publishing guide](https://claude.com/docs/directory/publish)
describes paid-plan submission, organization/role checks, separate connector
and plugin submissions under one organization, Community connector review,
and a separate Verified outcome. New plugin listings have validation/security
scans and human review. There is no sourced fixed review time.

**ACCEPTANCE GATES:**

- Verify publisher eligibility, listing ownership, and organization roles.
  Submit connector and companion plugin separately when both are offered.
  Do not claim Verified status before that outcome. A Community connector can
  become public after scanning, so submission must follow public-launch readiness.
  [Publishing requirements](https://claude.com/docs/directory/publish).
- Provide public HTTPS, working user auth, documentation, privacy policy,
  support contact, owned icon, a populated reviewer account, and proof every
  tool works. Complete connection, tools, use cases, company, auth, data,
  testing, and compliance materials. UI screenshots are conditional on MCP App
  UI; a text-only connector does not require inventing a UI.
  [Connector submission](https://claude.com/docs/connectors/building/submission).
- Prove the supported transport and OAuth subset, discovery, protected-resource
  metadata, S256 PKCE, refresh/revocation, and correct hosted versus loopback
  callbacks. Verify applicable CIMD/DCR or other supported registration mode.
  [Server implementation](https://claude.com/docs/connectors/building/index),
  [authentication](https://claude.com/docs/connectors/building/authentication).
- Give tools human titles, accurate safety annotations, useful errors, and
  capability descriptions. Keep names within the sourced 64-character limit.
  Separate read and write behavior. No hidden-instruction fetching or unrelated
  tool directions. Limit collection and use first-party or legitimately proxied
  APIs. `check` must be classified as state-changing.
  [Review criteria](https://claude.com/docs/connectors/building/review-criteria).
- For a companion bundle, supply `.claude-plugin/plugin.json`, correct root
  components, `.mcp.json`, README, license, and a public repository before
  launch. Validate paths locally and through the portal. Explain surface limits
  for hooks, agents, and local servers. [Plugin structure](https://claude.com/docs/plugins/build),
  [pre-submission checklist](https://claude.com/docs/plugins/pre-submission-checklist).
- Pass a fresh custom connection and the final directory install separately.
  Anthropic cloud must reach the endpoint even for remote Desktop use.
  [Custom connector setup](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).

### ChatGPT public app/plugin and Codex packaging

The draft reports the former Apps SDK submission route redirects to Plugins.
Use the actual current account flow after checking the cited source. Private
developer-mode testing, enterprise custom apps, imported packages, and reviewed
public remote plugins are separate paths.

**ACCEPTANCE GATES:**

- Select the owning organization/project, verify identity and domain, upload
  the ZIP, resolve checks, connect MCP, supply review materials, submit, and
  publish only after approval. One MCP server per plugin. Include MCP in the
  initial ZIP; the draft says adding it to an existing skills-only plugin is
  unsupported. Public ZIPs cannot contain `.app.json` references or lifecycle
  hooks under the cited rules. [Submission](https://developers.openai.com/plugins/deploy/submission).
- Supply the sourced five positive and three negative cases, an accessible
  walkthrough video, and release notes. Run positive cases before submission.
  Give reviewers a dedicated sample-data account with immediate access and no
  MFA, email/SMS, magic-link, or private-network dependency. Put reviewer
  credentials in the vendor's private review field, never the public ZIP or
  repository. [Review materials](https://developers.openai.com/plugins/deploy/submission).
- Use portable root `plugin.json` and `mcp.json`; put optional skills/assets
  and OpenAI metadata in their documented locations, including
  `extensions.com.openai`. Provide company/privacy links, accurate branding,
  prompts/results, localization/access information, and the public universal
  endpoint. Verify restricted template-URL eligibility before considering it.
  [Package format](https://developers.openai.com/plugins/build/plugins),
  [remote review](https://developers.openai.com/plugins/deploy/app-review).
- Prove metadata, supported client registration/identification, PKCE,
  resource/audience handling, server-side scope checks, security schemes, and
  required auth error handling. Do not design ChatGPT auth around arbitrary
  API keys or client-credentials grants. [Authentication](https://developers.openai.com/plugins/build/auth).
- Explicitly set `readOnlyHint`, `destructiveHint`, and `openWorldHint` for
  each operation. Expose distinct operations rather than a generic executor.
  Meet privacy/support and metadata rules. Avoid trial/demo-only experiences,
  unofficial pass-through connectors, and unauthorized context collection.
  CommonSwarm reviewer sample data is not a restriction of the actual product
  to a demo. [Plugin guidelines](https://developers.openai.com/plugins/plugin-guidelines).
- Prove custom-host testing and public listing installation independently.
  Imported raw MCP declarations have Desktop-only restrictions in the cited
  guide. Do not infer browser/mobile access from a local import or Codex setup.
  [ChatGPT testing](https://developers.openai.com/plugins/deploy/connect-chatgpt),
  [enterprise UI variant](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt),
  [import restrictions](https://learn.chatgpt.com/docs/enterprise/plugin-management),
  [installation](https://learn.chatgpt.com/docs/plugins).

UI is optional. If introduced, it must pass the separate
[UI security requirements](https://developers.openai.com/plugins/build/chatgpt-ui).
Codex CLI MCP uses its own [configuration route](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).
That route does not activate a cloud Dot.

### Meta Muse connector directory

The draft cites a real personal-Muse platform submission route, distinct from
Muse Code and developer APIs. It reports that intake and terms required login
and were not inspected after authentication. [Muse platform](https://muse.ai/platform),
[Meta announcement](https://developers.meta.com/blog/meta-connect-recap/).

**ACCEPTANCE GATES:**

- Describe the product and pass the platform's stated functional, security,
  legal, and end-to-end review. Verify approval before claiming directory
  availability. Featured placement is editorial. [Platform](https://muse.ai/platform).
- An authorized publisher must inspect intake and [platform terms](https://muse.ai/platform/terms).
  Accepted transport, MCP/OAuth support, manifest/schema, registration, scopes,
  reviewer access, eligibility, fees, update process, and review timing are
  **not verified**. Capture them before committing to an adapter or submission.
- Prove either the accepted native route or a reviewed API adapter. Personal
  Muse custom connectors are a separate user route and are not Meta-reviewed.
  Do not invent a personal-Muse paste-MCP-URL screen or promise proactive wake.
  [Connector help](https://www.meta.com/help/artificial-intelligence/1687253048996149/),
  [custom connector security](https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse).

Product summary, data map, tool catalog, revoke behavior, and reviewer test script
are CommonSwarm preparation recommendations. They are not verified intake fields.
Muse Code's separate [MCP/OAuth support](https://dev.meta.ai/docs/muse-code/extending)
cannot close the personal-agent gate.

### Cursor marketplace and direct install

**ACCEPTANCE GATES:**

- Supply a public Git repository, valid portable root manifest or
  `.cursor-plugin/plugin.json`, configuration docs, valid components, and
  local verification. Submit through [Cursor publishing](https://cursor.com/marketplace/publish).
  [Plugin reference](https://prod.cursor.com/docs/reference/plugins).
- Meet the sourced open-source and manual review requirements, including
  updates. Verify the actual listing and clean install. `cursor.directory`
  is a separate community site. [Marketplace guide](https://prod.cursor.com/docs/plugins).
- Prove remote transport, OAuth callback, enabled tools, refresh, and revoke
  on the advertised Cursor surface. Install links may carry only public
  configuration. They cannot skip authentication or approvals.
  [MCP](https://prod.cursor.com/docs/mcp),
  [install links](https://prod.cursor.com/docs/mcp/install-links).

No sourced rule establishes automatic Cursor-to-Grok Bot distribution. Test any
future reuse separately. Host project file access is outside the eight hosted tools.

### Gemini Apps and Gemini CLI gallery

**ACCEPTANCE GATES:**

- Gemini Apps custom connection must meet the sourced eligibility: US, age 18+,
  personal account, English, and Keep Activity. Work/school accounts are excluded
  in that source. Prove the web connection and each claimed web/mobile surface.
  Preserve manual write confirmation. Disclose prerequisites without asking users
  to weaken privacy choices. [Custom app requirements](https://support.google.com/gemini/answer/17209137).
- Verify the applicable client-registration route. When the MCP server lacks
  DCR, Google's setup guide directs users to Show more under Advanced features
  and enter credentials there. Test that host flow before advertising it; keep
  credentials out of chat. [Custom app authentication setup](https://support.google.com/gemini/answer/17209137).
- A general public Gemini consumer-directory submission route is **not verified**.
  Do not describe the CLI gallery as an Apps directory.
- For CLI, supply root `gemini-extension.json` with name, version, and MCP
  configuration. Verify Git URL/ref installation. [Extension format](https://geminicli.com/docs/extensions/reference/).
- For gallery discovery, use a public GitHub repository with the
  `gemini-cli-extension` topic and manifest at the absolute root. The cited
  gallery crawls daily and lists validated extensions without an issue/email
  submission. Prove the actual record; indexing is not curated consumer approval.
  [Release process](https://geminicli.com/docs/extensions/releasing/).
- Prove discovery/DCR, issuer callback validation, scopes, refresh, and revoke.
  Use `httpUrl` for Streamable HTTP. The cited CLI rejects absent or mismatched
  `iss` when an issuer is expected. [CLI MCP](https://geminicli.com/docs/tools/mcp-server/).

Neither extension installation nor consumer connection proves unattended execution.

### Grok chat, Grok Bot, and xAI API

**ACCEPTANCE GATES:**

- Prove the Grok chat custom connector at the public URL, including OAuth,
  seat identity, tools, and revoke. Check Business/Enterprise admin provisioning.
  [Connector guide](https://docs.x.ai/grok/connectors).
- Prove Bot plugin installation and attachment separately. Disclose account-wide
  connectors and shared computer credentials. [Bot apps](https://docs.x.ai/grok-bot/computer-and-apps).
- Public Grok publisher intake, manifest, exact auth registration, review terms,
  scopes, fees, and timing are **not verified**. Verify an official publisher
  path before preparing a submission. [xAI organization controls](https://docs.x.ai/grok-bot/teams-and-enterprises)
  do not establish Cursor Team Marketplace policy or public catalog intake.
- Treat [xAI remote MCP API](https://docs.x.ai/developers/tools/remote-mcp)
  as a developer integration. It does not prove consumer directory availability.

### MCP Registry and local packages

**ACCEPTANCE GATES:**

- Provide `server.json` with an owned name, version, description, and a
  `remotes` entry for the public Streamable HTTP endpoint. Remote-only publication
  need not invent an npm package. [Remote server format](https://modelcontextprotocol.io/registry/remote-servers).
- Verify namespace ownership, choose the applicable publisher authentication,
  publish through the official process, and check the resulting record.
  The cited Registry is preview and hosts metadata, not artifacts or vendor
  approvals. [Publishing guide](https://modelcontextprotocol.io/registry/quickstart).
- Namespace ownership and current CommonSwarm Registry publication are **not
  verified**. Advertised local install commands must resolve to real maintained
  releases with provenance. Current main version alone does not prove a published
  package or deployed endpoint version.

## GO-TO-MARKET CHECKLIST

All applicable rows must have retained evidence before an announcement. Source
checks and planned tests are not passing results. A direct-install announcement
does not need a directory listing, but must say which route was measured.

| Gate | What must be true and measured | Current evidence limit |
|---|---|---|
| Coherent hosted release | Record live auth, edge, schema, site, CLI/package where applicable, and endpoint revisions. Resolve artifacts and URLs before comparing. Approved release and rollback evidence agree. | Hosted MCP is live and on. Lane 8's "Connected apps" site release is queued, not released; coherent consumer release evidence remains outstanding. |
| Hosted done-test | Fresh eligible user completes consent and host return; exactly eight tools appear; claim/reuse and `whoami` match; authorized ask/check/reply completes. | HM37 section 10 Claude.ai consumer acceptance has not passed; retest 5 follows the latest release. The done-test remains a gate before any announcement. Infrastructure PASS cannot close it. |
| Tool contract and annotations | Names/schemas come from the hosted table. Titles, errors, retry behavior, security schemes, and all required hints match actual side effects. | Current table at `supabase/functions/mcp/tools.ts:28` has no explicit titles or safety annotations. `check` is a command at `supabase/functions/_shared/hosted-seat-auth.ts:6`, so it cannot be labeled read-only. |
| Auth and isolation | Actual deployed scopes, resource/audience, client registration, consent, seat reuse/limits, expiry, and rotating refresh are recorded. Wrong workspace/audience, shared credentials, removed membership, and expired access are tested with positive controls. | Source enforces the exact MCP resource at `services/mcp-auth/src/provider.js:91` and pins the `mcp` scope at `:100`. This is not granular read-only/admin consent. Names do not isolate shared chats. |
| Revocation and recovery | Disconnect, seat/grant revoke, membership removal, cancelled consent, uncertain retry, and reconnect have observed outcomes. New access after revoke fails. No data recall is promised. | Built C/D recovery needs deployment/server evidence. Tool-only launch must prove its own hosted revoke path. |
| Privacy and terms | Public pages match deployed content flows, recipients, logs, retention, deletion limits, subprocessors, consent, shared connector access, and event behavior if offered. Legal owner approves actual terms. | Pages are marked drafts at `site/src/pages/privacy.astro:362` and `site/src/pages/terms.astro:379`. `SECURITY.md:43` records workspace visibility and directed-read exception. A URL existing is insufficient. |
| Support and operations | Working public support/security path, named service/release owners, observed error reporting, rollback, and a response process. Verify inbox routing without exposing private content. | `SECURITY.md:9` gives `security@commonswarm.com`. `site/src/pages/terms.astro:190` makes no support commitment. Vendor-required support contact still needs a functioning path; do not invent an SLA. |
| Rate limits and failures | Pin limits from actual enforcement constants. Measure boundary refusals, safe retry, overload, timeout, and auth failure. No successful response conceals unfinished work. | Admin limits are in `src/protocol/admin-policy.ts:8`; transport body, response, timeout, and concurrency bounds are wired at `supabase/functions/mcp/index.ts:82`, `:83`, `:84`, and `:85`. Neither source presence proves live behavior. |
| Reviewer and host access | Synthetic reviewer data, private credential delivery, stable access/reset, and evidence for each advertised host/plan/region/version. Exercise all eight tools. | `/app` human workspace creation is live. Reviewer auth convenience and complete vendor-host access still need proof. |
| Listing truth | Correct legal publisher, approved/public status where required, real listing URL/version, and fresh install through the named route. | No CommonSwarm directory acceptance is established by these drafts. Submission is not approval. |
| Claim accuracy | Every announced surface and receive mode has evidence. Distinguish built, landed, applied, and live. No hosted files/admin/task CRUD, per-chat privacy, universal support, or wake claim beyond proof. | Hosted MCP is live and on; consumer acceptance has not passed. Lane 8's site release is queued, not released. B/C/D are merged, undeployed. `working_on` is a signal. Version `0.1.80` does not erase local/hosted differences. |
| Optional OpenAI Events | New protocol/event methods, durable scoped subscriptions, callback verification, signed delivery, replay, restart, expiry/refresh, unsubscribe, revoke, and duplicate handling pass. Actual subscribed cloud root responds while idle. | Vendor route is documented; CommonSwarm route is not verified in production and idle Dot wake is unproved. Current server advertises tools only at `supabase/functions/mcp/protocol.ts:267`. |

Events are a separate launch gate under the sourced
[OpenAI MCP Events guide](https://developers.openai.com/plugins/build/mcp-events)
and `docs/design/2026-10-02-OPENAI-DOT-AGENTS.md:322`.
The proposed route needs protocol `2026-07-28`, unlike current source at
`supabase/functions/mcp/protocol.ts:11`. Keep the hosted inventory at eight
tools. An accepted HTTP event is not proof of chat execution. A successful
child poll or completion callback is not an idle-root wake.

## Go-to-market sequence

1. Close Claude.ai retest 5 and HM37 done-test section 10 on the live, ON hosted
   MCP service before any announcement. Retain separate release evidence for
   lane 8's queued "Connected apps" site change. Freeze a coherent release and
   the eight-tool contract. Repair annotations and policy mismatches before
   any public submission.
2. Assemble one shared packet with exact tools, actual scopes, data flow,
   isolation/revoke results, support path, synthetic reviewer access, release
   provenance, and a dated host matrix. Complete applicable checklist rows.
   Follow C3PO's v2 pilot sequence: after Claude acceptance, test a second remote
   host and one local CLI, starting with identity/roster lookups and authorizing
   `check`'s cursor mutation before inbox use. Pilot delegated administration in
   disposable test workspaces after its release proof.
3. Prove the Claude custom connector. Then have the authorized publisher submit
   the Claude connector, followed by the companion workflow plugin if needed.
   Submit only when automatic listing would be safe to announce. Verify the
   actual listing and clean install before announcing directory availability.
4. Prove ChatGPT's actual account route. Prepare its public plugin packet, meet
   OpenAI gates, submit, resolve review findings, and publish after approval.
   Prove public installation on each claimed surface. Treat Dot connection as a
   separate host proof and Events as a later optional capability.
5. Reuse the reviewed packet for Cursor direct install/marketplace, Gemini CLI
   gallery, Gemini Apps and Grok custom guides, and MCP Registry metadata.
   Announce each route only when its exact install and revoke proofs pass.
6. Inspect Meta's authenticated intake and Grok's publisher route with separate
   authorization. This discovery can accompany packet work. Do not block a
   proven route while waiting for unrelated directories or invent intake rules.
7. Inspect activation, OAuth return, seat claim, completed exchanges, failures,
   revocations, repeat use, and support burden by host after launch. Measure time
   to first completed exchange. Set targets from observed pilots, not invented
   benchmarks. Pause promotion of a route when its onboarding fails.

Publication, outreach, vendor terms, account access, and production changes need
their assigned owner's authorization. This plan prepares work; it performs none
of those actions.

## Build lanes after C and D

Sizes are relative planning judgments, not numerical estimates. Owner types are
for HezLead to assign. The ordered lanes match the onboarding plan.

| Order | Lane | Size | Owner type | Dependencies | Acceptance gate |
|---|---|---|---|---|---|
| 1 | Close HM37 consumer acceptance on live MCP | Uncertain | Auth engineer, authorized release owner, host QA | Reviewed hosted artifacts and terminal Claude.ai retest 5 result | Section 10 passes before any announcement; coherent live revisions, fresh consent, eight tools, identity/exchange, refresh and revoke pass. Lane 8's queued site release needs separate release evidence. |
| 2 | Verify and release B/C/D | Medium | Backend engineer and authorized release owner | Lane 1; merged inputs | Server/migration/RLS/history/rollback proof and live human grant list/history/revoke. No claim that pending invitation delivery works. |
| 3 | Complete recipient delivery and enrollment | Large | Runtime/auth engineer | Lane 2; canonical grant contract | Protected hosted delivery and recipient redemption, bounded retries/expiry/revoke, and real recipient proof. Secrets stay outside model output. |
| 4 | Add common receipt and host guides | Medium | Product engineer, documentation owner, host QA | Lane 1; lane 3 for delegated flows | Second remote host and local CLI pass; advertised state, permission, receive mode, and route match evidence. |
| 5 | Prepare Claude, then ChatGPT distribution | Medium | Integration engineer, privacy reviewer, authorized publisher | Lane 1; lane 4 guides; checklist | Sourced vendor packet gates pass before submission. Actual approved/public listing and fresh install before directory announcement. |
| 6 | Extend Cursor, Gemini, Grok, and Registry routes | Medium | Integration engineer and host QA | Lanes 4 and 5 shared packet | Per-host install/auth/tools/revoke proof; required packaging and real listing/metadata verified. No cross-vendor marketplace inference. |
| 7 | Build optional OpenAI Events and Dot proof | Large | Backend/runtime engineer and authorized Dot QA | Lane 1; reviewed P5b design; plugin access | Actual idle-root response plus lifecycle, isolation, replay/restart, unsubscribe/revoke, and duplicate tests. Tool-only launch can proceed without this claim. |
| 8 | Resolve Meta and other publisher unknowns | Unestimated | Integration researcher and authorized publisher | Shared packet; intake verification before build | Official transport/auth/terms captured; then supported adapter, submission gates, and exact-host done-test. Unsourced rules remain not verified. |
