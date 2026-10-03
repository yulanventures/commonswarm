# Claude connector portal fields

Prepared from the [public submission guide](https://claude.com/docs/connectors/building/submission), fetched 3 October 2026. This maps every documented portal stage and known field; authenticated field labels, extra required fields and current account state are **worker reads from portal**. No portal was accessed. Use [LISTING](LISTING.md), [REVIEWER-ACCESS](../../2026-10-03-reviewer-packet/REVIEWER-ACCESS.md) and [worker rules](../SUBMISSION-WORKER-RULES.md). C6 GO once C3 is met; legal C4 waived/live; no admin issuance prerequisite.

Entry: existing paid-plan SSO account → developer portal at `claude.ai/directory/manage` → Submit new → MCP connector. Existing organization/role and plan are **worker reads from portal**; stop on password, new account, purchase or identity/organization verification.

| Stage / field | Prepared value / exact handling |
| --- | --- |
| Connection / connector type | Remote MCP connector, tools only. |
| Connection / server URL | `https://mcp.commonswarm.com/mcp`; a single shared endpoint. |
| Connection / existing custom connector | Select CommonSwarm only if its actual stored URL matches; otherwise use the exact URL. Existing connector IDs are **worker reads from portal**. |
| Connection / users connect to different URLs | No. Multiple URLs / URL pattern not used. |
| Connection / OAuth connection | Use existing SSO and OAuth discovery; DCR/CIMD, token auth `none`. No client secret/password. See Authentication below. |
| Tools, prompts, resources / synced inventory | Exactly eight hosted tools from LISTING. No prompts/resources advertised. Compare synced names/titles/hints to source table; scan statuses and warnings are **worker reads from portal**. |
| Tools / missing titles or safety hints | Supplied live; do not mark an absent hint resolved if the portal disagrees. Stop dependent submission and report exact tool/finding. |
| Listing / server name | CommonSwarm (11; ≤100). |
| Listing / one-liner | Copy LISTING's 113-character one-liner (≤200). |
| Listing / description | Copy LISTING's 598-character long description (≤2,000). |
| Listing / categories | Productivity candidate; choose the actual equivalent from portal taxonomy, 1–5 categories. Taxonomy/accepted values are **worker reads from portal**. |
| Listing / documentation URL | `https://github.com/yulanventures/commonswarm/blob/b8a97e10eee5c322b7d57d70280ba4ad51527338/README.md`; public documentation candidate, worker confirms access/portal acceptance. |
| Listing / privacy URL | `https://commonswarm.com/privacy` (final/live). |
| Listing / support contact | `support@commonswarm.com` (HezLead ruling 3); no SLA. |
| Listing / icon | Existing `site/public/brand/app-icon-512.png` (512×512 PNG, 12,131 bytes); check actual upload constraints. SVG alternative in LISTING. |
| Listing / slug | `commonswarm` candidate; actual availability **worker reads from portal**. Permanent once published, so confirm exact spelling before submit. |
| Listing / MCP App carousel and paired prompts | Not applicable: tools only, no MCP App UI. If portal requires an image anyway, report the actual requirement. |
| Listing / allowed link URIs (optional) | Omit for tools-only submission. If the worker supplies an allowlist later, only owned HTTPS origins/schemes may be listed; no third-party domains. |
| Use cases / primary uses | P1 identify seat/roster; P2/P3 ask and check a synthetic message; P4 reply/read; P5 share note/current work. Copy exact prompts/tools/results from REVIEWER-ACCESS; working evidence pending CC-13. |
| Use cases / prerequisites | Reviewer's own enabled GitHub/Google identity, verified CommonSwarm account and explicitly created Directory Review workspace; Claude account/plan with connector access. Hosted OAuth has one configured provider whose live value is unmeasured; no blanket both-provider claim. |
| Use cases / read/write behavior | Reads identity/roster and directed messages; appends asks/notes/replies/current work. `check` opens batches and optionally permanently advances delivery via ACK. No task closing or agent launch. |
| Company / name | Yulan Ventures, LLC. |
| Company / website | `https://yulanventures.com`. |
| Company / postal address if requested | Yulan Ventures, LLC, 1211 W 6th St, Ste #600-188, Austin, TX 78703. |
| Company / primary review contact | `support@commonswarm.com` (HezLead ruling 3). Named person, phone or other private contact fields are **worker reads from portal** and require approved values. |
| Authentication / mode | OAuth with dynamic client registration / client ID metadata documents. DCR+CIMD live; choose the mode(s) offered by portal. No Anthropic-held client secret or per-user URL credential. |
| Authentication / resource / scope if requested | Exact resource `https://mcp.commonswarm.com/mcp`; `mcp` permission, discovery also supports `openid offline_access`. Follow discovered endpoints and host-required identity/refresh scopes. |
| Authentication / starts unauthenticated with tools prompting later | No: current hosted endpoint requires bearer authorization. |
| Authentication / authorization/token/registration URLs if requested | Read exact values from approved discovery evidence/host flow; endpoint field set and DCR/CIMD choice are **worker reads from portal**. Do not guess a registration path. |
| Data handling / API provenance | First-party CommonSwarm API, owned by submitting company; no partner proxy API in the eight-tool flow. |
| Data handling / personal health information | No intended health-data workflow; only synthetic review content. Do not assert users cannot submit arbitrary text. |
| Data handling / sponsored content | None in this connector. |
| Data handling / privacy and collection detail | Copy packet data map: identity/memberships/signals/coordination/audit/logs, recipient restrictions, policy retention and AI-client data handling. No full conversation transcript ingestion. |
| Test & launch / reviewer instructions | Paste complete REVIEWER-ACCESS path and all eight argument/result examples; attach/link durable instructions as accepted by portal. Never paste a filesystem-only path as the reviewer's public URL. |
| Test & launch / reviewer login URL | `https://commonswarm.com/app`; CC-12 uses ruling B; Tom's morning credential entry is pending and nonblocking. |
| Test & launch / populated test-account credentials | HezLead ruling B: submit with self-serve access and reviewer notes below; Tom morning step pending, nonblocking. Tom alone types the later dedicated credential here. No agent-created account/password entry; no credential in Git/chat. |
| Test & launch / reviewer notes | A dedicated reviewer account with sample data can be provided within 24 hours on request; reply to support@commonswarm.com. Retrieval happens during a chat turn; inbox checks return durable batches and acknowledging a batch advances delivery; messages cannot be edited or recalled; seat names do not isolate chats; the connector does not claim or close tasks. |
| Test & launch / workspace or tenant | Directory Review, created by the reviewer for self-serve cases; actual Tom-approved fixture ID/name if dedicated credentials required. Never invent an existing workspace ID. |
| Test & launch / every tool exercised confirmation | Pending actual CC-13 execution receipts. Do not check until independently supplied receipts cover all eight tools. |
| Test & launch / launch details, dates or rollout choices | **worker reads from portal**; use HezLead's C6 GO after C3, not an invented launch date. |
| Compliance / directory guidelines acknowledgment | Read exact policy wording; acknowledge only substantiated compliance. |
| Compliance / first-party API acknowledgment | First-party tools as above; read and affirm exact requirement only if satisfied. |
| Compliance / financial transactions acknowledgment | No transaction/commerce tools; read exact statement. |
| Compliance / AI media generation acknowledgment | No media-generation tools; read exact statement. |
| Compliance / prompt injection acknowledgment | Do not claim an unperformed security scan; assess exact requirement using tool/content boundary and review evidence. Unsupported statement goes to HezLead. |
| Compliance / conversation data collection acknowledgment | Signal content is deliberately submitted; connector has no transcript-ingestion tool. Read exact policy and disclose accurately. |
| Compliance / public documentation acknowledgment | Public repository README candidate above; confirm accessible and adequate. |
| Compliance / all seven checkboxes | Required by public guide; exact text **worker reads from portal**, no blanket prechecked authorization. C4 waiver is not a waiver of vendor attestations. |
| Review and submit / final draft | Compare all entered values, synced tools, warnings and HezLead ruling B reviewer notes. Draft ID/status and unexpected fields are **worker reads from portal**. Submit only when C3 is met. |
| After submit / status, scan result, review feedback | **worker reads from portal**; retain actual reference/time/status. Community/Verified labels are outcomes, not claimed in this packet. |

Terms `https://commonswarm.com/terms`, AUP `https://commonswarm.com/acceptable-use`, security contact `security@commonswarm.com` and support-page limitations are supplied in LISTING even where the public guide does not establish a distinct required portal field. No screenshot, allowlist or Verified-label absence is promoted to a tools-only pre-submit blocker.
