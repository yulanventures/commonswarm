# ChatGPT apps submission fields

Prepared from the [current OpenAI submission guide](https://developers.openai.com/plugins/deploy/submission), fetched 3 October 2026 (the older Apps SDK submission URL redirects here). The current flow is a Plugins dashboard ZIP submission with a connected MCP server. This maps all publicly documented fields/stages; authenticated extra fields, IDs, exact attestation text, entitlement and challenge values are **worker reads from portal**. No portal access or package creation occurred.

Use [LISTING](LISTING.md), [REVIEWER-ACCESS](../../2026-10-03-reviewer-packet/REVIEWER-ACCESS.md), [C3-ACTIONS](../../2026-10-03-reviewer-packet/C3-ACTIONS.md) and [worker rules](../SUBMISSION-WORKER-RULES.md). C6 GO once C3 is met; C4 waived/live. Metadata instructions are for the future package maker and publisher, not claims that a ZIP exists.

## Dashboard and private review fields

| Portal stage / field | Prepared value / exact handling |
| --- | --- |
| Account login | Existing Tom SSO in already signed-in Chrome under the assigned task. No password/new account. |
| Owning organization / project | Existing approved Yulan Ventures owner/project; exact IDs, names and Apps Management Write/owner role are **worker reads from portal**. Never create an organization/project to bypass a missing role. |
| Developer identity / individual or business verification | Existing status **worker reads from portal**. Directory developer name derives from verified identity. If OpenAI requires identity/organization verification and it is incomplete, park ChatGPT for Tom; proceed with Claude alone once its C3 items are met. |
| New plugin / package upload | Upload the reviewed OA-01 portable ZIP with exactly one hosted MCP server. Actual archive path, package version, draft ID and upload result are **worker reads from portal** / supplied by package maker; none exists here. |
| Metadata & Skills / package metadata | Use the tables below; required findings must be resolved in source and corrected ZIP. No bundled skills proposed, so no invented skill-scan PASS. |
| MCPs / endpoint | `https://mcp.commonswarm.com/mcp`. |
| MCPs / authentication | OAuth authorization code + PKCE/S256, public client `none`, DCR/CIMD; resource exact endpoint, permission scope `mcp`; identity/refresh scopes from discovery as host requires. No API key, password or manual secret entry. |
| MCPs / domain verification | For `commonswarm.com`, read the organization-generated DNS TXT record name and value under existing SSO and copy exactly into [DNS-TXT](../DNS-TXT.md) in its stated format. HezLead adds it via Cloudflare API; confirm with `dig TXT` as documented there. Worker may read/copy the challenge and status, but never changes DNS. No invented record or token. |
| MCPs / tools and scans | Exactly eight source tools/titles/hints from LISTING. Per-tool auth metadata/scope changes require OA-07 implementation and separate release. Read actual connection/scan findings; do not infer success from DCR alone. |
| Review information → Review details / login URL | `https://commonswarm.com/app`. |
| Review details / dedicated reviewer credentials | HezLead ruling B: submit with self-serve access and reviewer notes below; Tom morning step pending, nonblocking. Tom alone types the later dedicated credential here and checks immediate access without MFA approval/codes/magic links/private network. No vendor exemption or acceptance claimed; no credentials in package, Git/chat/screenshots. |
| Review details / reviewer notes | A dedicated reviewer account with sample data can be provided within 24 hours on request; reply to support@commonswarm.com. Retrieval happens during a chat turn; inbox checks return durable batches and acknowledging a batch advances delivery; messages cannot be edited or recalled; seat names do not isolate chats; the connector does not claim or close tasks. |
| Review details / tenant/workspace | Directory Review for own-account instructions; actual Tom-approved populated fixture name/ID if vendor requires dedicated credentials. Unknown actual fixture ID is **worker reads from portal** / approved private handoff; never fabricate. |
| Review details / sign-in instructions | Paste complete REVIEWER-ACCESS, including account prerequisites, one form submit for workspace creation, the single configured OAuth provider, consented Home workspace, both seats and all examples. Enter here, not in ZIP metadata. |
| Review details / positive and negative cases | Exactly P1–P5/N1–N3 below, with actual execution evidence. Cases imported from ZIP are read-only; changes require corrected package upload. |
| Review details / video URL | `review.demo_recording_url`: **BLOCKED, no recording available**. Worker must receive an actual reviewer-accessible walkthrough URL and confirm access; never enter an example or localhost URL. |
| Review details / release notes | Use LISTING's supplied revisions/limited DCR result; add exact new package version/changes when maker provides them. |
| Review details / commerce | false; no purchase/payment tool or paid plan is offered by this connector. |
| Review details / editable/saved fields | Save details where offered. Exact editable vs ZIP-managed fields are **worker reads from portal**. Never invent test success to clear a validation finding. |
| Submit for review / policy attestations | Exact required statements **worker reads from portal**; read and affirm only supported facts. Unverifiable statement goes to HezLead. No ID/organization verification, payment or password entry. |
| Submit for review / selected draft and validations | Confirm exact package/server scans and all C3 required items; only one active review per plugin. Existing review/draft status **worker reads from portal**; no cancellation/replacement outside task authorization. |
| After submit / review status / feedback | **worker reads from portal**; retain timestamp/reference/outcome. Approval and subsequent Publish choice are separate from submission; no automatic claim of publication. |
| Any unlisted authenticated field | **worker reads from portal**; use a documented source value or report the missing value rather than guessing. |

## Portable package and listing field mapping

The public guide describes these package fields as importing into the dashboard. Portable root `plugin.json` and root `mcp.json` are OA-01 code work. No JSON, ZIP, assets or secrets are created by this documentation commit.

| Field | Prepared value / applicability |
| --- | --- |
| `$schema` | `https://agent-plugins.org/schemas/1.0.0/plugin.schema.json` (portable format). |
| `name` | `commonswarm` (stable lowercase identifier, ≤64). |
| `version` | Package maker sets actual release semantic version; **worker reads from portal** and maker receipt. Do not use backend version as package version. |
| `description` | LISTING long description (598; ≤4,000). |
| `author.name` | Yulan Ventures, LLC (≤120). |
| `author.email` | `support@commonswarm.com` (HezLead ruling 3; ≤320). |
| `author.url` | `https://yulanventures.com` (HTTPS; ≤2,048). |
| `homepage` | `https://commonswarm.com` (≤2,048); separately set websiteURL. |
| `repository` | `https://github.com/yulanventures/commonswarm/tree/b8a97e10eee5c322b7d57d70280ba4ad51527338`. |
| `license` | Omit optional declaration until package maker checks applicable LICENSE; do not invent a license. |
| `keywords` | Optional; coordination, workspace, agents. |
| `extensions` | `com.openai` namespace for interface/review/publication below. |
| Root `mcp.json` | One remote MCP server `commonswarm` at `https://mcp.commonswarm.com/mcp`; exact valid configuration syntax is package-maker work against current package guide. No secrets. |
| `skills` | Omit; no bundled skill planned. Portable `skills/` auto-discovery is separate. |
| `mcpServers` | Codex compatibility-only root declaration; omit in chosen portable format (discovers root mcp.json). |
| `extensions.com.openai.id` | Omit unless an assigned ID exists; assigned value is **worker reads from portal**, preserve it. |
| `extensions.com.openai.interface.displayName` | CommonSwarm (11; ≤30). |
| `.interface.shortDescription` | Coordinate people and agents (28; ≤30). |
| `.interface.longDescription` | LISTING long description (598; ≤4,000). |
| `.interface.developerName` | Yulan Ventures, LLC (19; ≤80); actual directory identity derives from verified account. |
| `.interface.category` | Productivity; exact current allowed title **worker reads from portal** (guide gives this example). |
| `.interface.capabilities` | Omit optional portable field; if maker chooses Codex format, required array, maximum 20 items of ≤120 each. No unsupported capabilities. |
| `.interface.websiteURL` | `https://commonswarm.com` (required for MCP review; ≤1,024). |
| `.interface.supportURL` | **BLOCKED OA-03:** proposed `https://commonswarm.com/support` only after a real support page is released. A published courtesy email alone does not prove this customer-support URL. |
| `.interface.privacyPolicyURL` | `https://commonswarm.com/privacy` (required; ≤1,024). |
| `.interface.termsOfServiceURL` | `https://commonswarm.com/terms` (required; ≤1,024). |
| `.interface.defaultPrompt` | Optional; use up to three unique ≤128-character prompts below, without app @mentions. |
| `.interface.brandColor` / `brandColorDark` | Omit optional colors until contrast verified; no invented visual values. |
| `.interface.logo` | Future package path `./assets/app-icon-512.png`, included by maker from existing site brand file. Primary icon required; verify scan. |
| `.interface.composerIcon` | Optional portable / required Codex; if supplied reuse the included `./assets/app-icon-512.png`. |
| `.interface.logoDark` / `composerIconDark` | Omit optional dark variants; none supplied. |
| `.interface.screenshots` | Omit optional screenshots for this tools-only listing. |
| `extensions.com.openai.onboardingSkill` | Omit optional onboarding skill; reviewer instructions are not a bundled skill. |
| `extensions.com.openai.review.test_cases.positive` | Exactly five cases below, description/prompt/tools_triggered/expected_behavior; execute before submit. |
| `.review.test_cases.negative` | Exactly three cases below; include expected behavior even where schema makes it optional. |
| `.review.demo_recording_url` | Required for MCP review; actual accessible video URL missing. |
| `.review.commerce` | false. |
| `.review.commerce_description` | No commerce operations; tools exchange coordination messages. |
| `extensions.com.openai.publication.release_notes` | Supplied live revisions/DCR result in LISTING plus actual new package changes/version. |
| `.publication.countries` | Omit optional override, preserve existing portal targeting. If no existing setting, default is **worker reads from portal**. Do not claim an unmeasured country entitlement. `[]` would remove restrictions, so do not add it silently. |
| `.publication.translations` | Omit optional translations; English base fields provided. No en-US object needed. |
| `.publication.translations.<locale>.subtitle` / `.description` | If later supplied: nonempty supported locale, subtitle ≤30 / description ≤4,000; not prepared here. |
| `test_credentials` / `reviewer_instructions` in ZIP | **Never include.** Public guide rejects these review-access metadata fields; use secure Review details. |
| AUP / security / company address if requested | `https://commonswarm.com/acceptable-use`; `security@commonswarm.com`; Yulan Ventures, LLC, 1211 W 6th St, Ste #600-188, Austin, TX 78703. Distinct required portal fields are **worker reads from portal**. |

Optional starter prompts: “Claim a seat named Reviewer A, show its identity, and list workspace participants.”; “Share a note saying the synthetic review fixture is ready.”; “Check my seat's inbox and keep the returned batch before acknowledging it.”

## Review case values

These are prepared cases, **not executed results**. The full argument sequence, placeholders and account/workspace setup are in REVIEWER-ACCESS. Each case object maps `description` to Scenario, `prompt` to Prompt, `tools_triggered` to Tools and `expected_behavior` to Expected result. Positive descriptions remain well below 4,000 characters. Optional `file_attachment_urls` and `expected_output_url` are omitted; no fabricated output or attachment links. Use prior-case values only from the reviewer's own execution.

| Case | Scenario | Prompt | Tools | Expected result |
| --- | --- | --- | --- | --- |
| P1 | Connect and identify two seats in your workspace | Claim Reviewer A and Review Partner B, show both identities, list participants, and repeat A's identical claim request. | claim_seat, whoami, members | Two seats in consented Directory Review; same claim retry reuses A, identities/roster principal IDs match. |
| P2 | Ask the second synthetic seat | As Reviewer A, ask Review Partner B whether the sample review checklist is ready; repeat identical arguments/request ID. | ask | One ask signal with ID/timestamp; no duplicate write. |
| P3 | Receive and acknowledge the synthetic ask | Check B's inbox twice without ACK, then acknowledge exactly the retained batch. | check | Same pending batch containing ask replays; ACK permanently advances delivery; no business-completion claim. |
| P4 | Complete the reply loop | As B, reply to that ask that the sample checklist is ready, then check A's inbox. | reply, check | Reply points to ask's UUID and is observed by A, within the reviewer's own two-seat fixture. |
| P5 | Share approved progress | As A, post the synthetic fixture-ready note and share current work checking the sample checklist. | note, working_on | Two immutable signals with IDs/kinds/timestamps, in own workspace; no task closing. |
| N1 | Reject malformed input with positive control | After successful whoami for A, call whoami with an extra field. | whoami | Invalid-parameter refusal; valid same-seat call still succeeds. |
| N2 | Enforce workspace consent with own fixtures | Create a second workspace you own without consenting it to this connection; try claiming there, then claim in Directory Review. | claim_seat | Unconsented-workspace claim refused; control claim allowed. Never probe another person's workspace. |
| N3 | Refuse a revoked connection | After valid identity/check and refresh, revoke this exact connection in Connected apps; retry old-token identity/check and refresh once. | whoami, check; OAuth refresh / browser revoke outside tool catalog | Prior grant/seat and refresh refused; no silent reconsent or successful access. |

Current C3 prerequisites remain package/support/auth code, actual connection/scans/test execution/video, and existing OpenAI organization/project eligibility plus required verification. Dedicated credentials are a nonblocking Tom morning step under ruling B; see C3-ACTIONS for the exact remaining rows. Legal waiver and live DCR/CIMD/annotations remove those old gates; they do not fabricate a completed submission.
