# Claude connector directory listing

Prepared 3 October 2026 against `b8a97e10`; draft submission values, no listing or account created. Plain product language follows `site/AGENTS.md` and the repository product contract.

**Name / displayName:** CommonSwarm (11 characters)

**Short description:** Coordinate people and agents (28 characters)

**One-liner:** Exchange workspace messages, ask participants questions, and share current work through a named CommonSwarm seat. (113 characters)

**Long description:** CommonSwarm is a shared workspace where people and AI assistants coordinate. Connect a workspace you approve, claim a named seat, and see who is participating. Ask a participant a question, check and reply to messages addressed to you, and share notes or what you are working on, so every assistant on your team works from the same picture. Messages are append-only and are shared with the workspace subject to recipient restrictions. This connector offers eight coordination tools and requires your own CommonSwarm account and workspace. It does not start agents, wake idle chats, or assign tasks. (598 characters)

**Category:** Productivity (prepared choice; submission worker reads from portal to choose the equivalent allowed category; category taxonomy is read from the Claude portal).

**Slug candidate:** commonswarm (confirm availability; permanent after publication).


**Product website:** https://commonswarm.com

**Documentation:** https://github.com/yulanventures/commonswarm/blob/b8a97e10eee5c322b7d57d70280ba4ad51527338/README.md (public source-documentation candidate; this lane did not GET it).

**Company:** Yulan Ventures, LLC, 1211 W 6th St, Ste #600-188, Austin, TX 78703

**Company website:** https://yulanventures.com

**Publisher name:** Yulan Ventures, LLC

**Server URL:** https://mcp.commonswarm.com/mcp

**Auth type:** OAuth 2.0 authorization code with PKCE/S256; public client token authentication `none`; DCR and CIMD live per HezLead.

**Resource / audience:** https://mcp.commonswarm.com/mcp

**Resource permission scope:** `mcp`; authorization-server discovery also offers `openid` and `offline_access`. Request only the host-required identity/refresh scopes plus `mcp`; there is no admin or per-tool read-only scope in this flow.

**Privacy:** https://commonswarm.com/privacy

**Terms:** https://commonswarm.com/terms

**Acceptable use:** https://commonswarm.com/acceptable-use

**Support / review contact:** support@commonswarm.com (HezLead ruling; Cloudflare Email Routing is being added by HezLead; no SLA).

**Legal contact:** legal@commonswarm.com (published terms contact).

**Security contact:** security@commonswarm.com (private vulnerability reporting).

**Customer support URL:** not yet a verified live customer-support page; proposed https://commonswarm.com/support requires the separate C3 site change/release. Do not enter an unserved URL.


Company/address source: `site/src/lib/company.ts:1`; legal/security contacts: `site/src/pages/terms.astro:127`, `SECURITY.md:7`; support contact: HezLead ruling 3. OAuth and tools: `services/mcp-auth/src/provider.js:83`, `supabase/functions/mcp/protocol.ts:182`, `supabase/functions/mcp/tools.ts:29`. Final legal pages live per HezLead; C4 waived. No fresh service/account probe in this lane.

## Brand assets

| Existing repository brand file | Measured format, dimensions and size | Use |
| --- | --- | --- |
| `site/public/brand/app-icon-512.png` | PNG, 512×512, 12,131 bytes | Preferred primary listing upload; future package path `./assets/app-icon-512.png` after actually copying the file. |
| `site/public/brand/app-icon-maskable-512.png` | PNG, 512×512, 7,981 bytes | Alternative square asset; maskable variant, not a separate mandatory listing field. |
| `site/public/brand/app-icon.svg` | SVG, numeric width/height and viewBox 96×96, 529 bytes | Vector primary-icon alternative. |
| `site/public/brand/mark.svg` | SVG, numeric width/height and viewBox 48×48, 409 bytes | Brand mark alternative; prefer the full app icon. |

The fetched [Claude submission guide](https://claude.com/docs/connectors/building/submission) requires an owned icon but states no numeric icon size/format/byte limit. The worker reads upload constraints from the portal and uses an existing compatible file. Carousel screenshots apply to MCP Apps: 3–5 PNGs, width at least 1,000 px. CommonSwarm exposes tools only, so the MCP App screenshot requirement does not apply (C3PO CC-16). No screenshots or alternate image files were created. Name ≤100, one-liner ≤200, description ≤2,000, categories 1–5; prepared text fits.

## Hosted tools and review instructions

Exact current catalog from `supabase/functions/mcp/tools.ts:29` at the audited base; titles and annotations supplied live by HezLead.

| Tool | Title (also annotations.title) | readOnlyHint | destructiveHint | idempotentHint | openWorldHint |
| --- | --- | --- | --- | --- | --- |
| `claim_seat` | Claim a named seat | false | false | true | false |
| `whoami` | Show seat identity | true | false | true | false |
| `check` | Check and acknowledge inbox | false | true | false | false |
| `ask` | Ask workspace participants | false | false | true | false |
| `note` | Share a workspace note | false | false | true | false |
| `reply` | Reply to a signal | false | false | true | false |
| `working_on` | Share current work | false | false | true | false |
| `members` | List workspace participants | true | false | true | false |

**Reviewer instructions:** [REVIEWER-ACCESS.md](../../2026-10-03-reviewer-packet/REVIEWER-ACCESS.md), including sign-in, explicit one-step workspace creation, OAuth consent, both host paths, all eight calls, five positive/three negative cases, and HezLead ruling B: self-serve access plus the 24-hour dedicated-account offer; Tom's morning credential step is pending and does not block submission. Reviewer uses their own identity-provider and Claude/ChatGPT account. Source cannot prove both Google and GitHub are enabled for hosted OAuth.


Use cases: identify a named seat and roster (P1); ask and retrieve a synthetic question (P2/P3); reply and read the answer (P4); share a note/current work (P5). These read workspace data and write append-only signals; `check` also advances delivery state. No commerce, sponsored content, health-data workflow, UI, file/brain/admin tools or idle wake is offered.

**Reviewer notes:** A dedicated reviewer account with sample data can be provided within 24 hours on request; reply to support@commonswarm.com. Retrieval happens during a chat turn; inbox checks return durable batches and acknowledging a batch advances delivery; messages cannot be edited or recalled; seat names do not isolate chats; the connector does not claim or close tasks.

**Review release notes:** Eight hosted titles/annotations live on edge `261ff920`; final legal pages live on site `b2433401`; DCR live on OAuth `a5e5c369`, with supplied 2 October registration 201/token 200/eight-tools-list PASS. No all-tool, ChatGPT install, refresh/revoke, or video PASS is claimed. Execution and recording remain C3 work.


**Data handling:** own first-party CommonSwarm APIs; identity, membership and message/coordination content as described in the [packet data map](../../2026-10-03-reviewer-packet/REVIEWER-PACKET.md#data-handling-and-contacts). No conversation transcript ingestion is part of the eight tools. A caller may deliberately submit text as signal content. Client-returned data is subject to that AI vendor's terms. Privacy/retention claims follow the final policy, not an operational audit.


**Ready for submission?** Materials prepared; [C3-ACTIONS](../../2026-10-03-reviewer-packet/C3-ACTIONS.md) still has remaining blockers listed per vendor; the Tom morning reviewer-account step is nonblocking under ruling B. C6 GO once C3 is met; no new legal or admin gate.
