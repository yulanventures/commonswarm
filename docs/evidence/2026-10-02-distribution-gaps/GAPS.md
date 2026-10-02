# Distribution gaps — 2026-10-02

Claude custom connection has passed according to HezLead's current task. Directory
submission is still blocked by missing tool metadata, inaccurate draft policy text,
and an incomplete publisher/reviewer packet. This lane documents gaps; it changes
no implementation and submits nothing.

## Basis and status meanings

- Audited `lane/distribution-build`, initially clean, at
  `037beb84af141f3dfc025762b0cd7b57b98a3eaf` (`origin/main`). All source references
  below name that revision, not an independently measured production revision.
- Assignment: parent `TASK-dist.md`. Its live OAuth/discovery/CIMD/DCR/consent
  and Claude custom-connector PASS supersede the older plan's pending retest.
  This worker did not repeat a consumer test or infer directory acceptance from it.
- Scope: channels in `docs/design/2026-10-02-DISTRIBUTION-PLAN.md`, ordered Claude
  connector, companion plugin, ChatGPT/Codex, Cursor, Gemini, Grok, Registry, Meta.
- **MET** means the precisely stated item has source evidence or explicit task
  evidence. **GAP** means a required artifact or behavior is missing or mismatched.
  **NOT VERIFIED** means the vendor rule, live value, account eligibility, or
  acceptance result is unknown. A source-only MET does not prove deployed behavior.
- Owners are **code**, **docs**, **publisher action**, or **Tom decision**. Owners
  in a MET row identify who maintains the evidence; they are not new work orders.

## Measurement limits and shared source evidence

The four authorized public HTTPS GETs used explicit GET, HTTPS-only protocol,
5-second connection and 20-second overall timeouts, with no credentials:

```sh
curl --request GET --proto '=https' --connect-timeout 5 --max-time 20 \
  --silent --show-error --write-out '\nHTTP %{http_code}\n' <URL>
```

| URL | Worker result | Interpretation |
|---|---|---|
| `https://mcp.commonswarm.com/.well-known/oauth-protected-resource/mcp` | curl exit 6; HTTP 000; could not resolve host | Sandbox DNS/network unavailable; no live response measured |
| `https://mcp.commonswarm.com/.well-known/oauth-authorization-server` | Same | No live discovery fields measured |
| `https://mcp.commonswarm.com/.well-known/openid-configuration` | Same | No live OIDC fields measured |
| `https://mcp.commonswarm.com/jwks` | Same | No live key IDs, algorithms, or rotation measured |

Vendor public documentation was reachable through the read-only web fetch tool
on 2026-10-02. Links beside requirements identify the fetched official source.
Authenticated portals were not opened. Exact account-specific fields and outcomes
remain NOT VERIFIED. No alternative live service probes were made.

| Evidence ID | CommonSwarm value / file:line | Limit |
|---|---|---|
| E1 — hosted inventory | `supabase/functions/mcp/tools.ts:28`; catalog generated below from the table. `supabase/functions/mcp/protocol.ts:299` returns that table unchanged. | No titles, annotations, or per-tool security schemes in the table; live listing not fetched |
| E2 — discovery and transport | `supabase/functions/mcp/protocol.ts:182`: resource `https://mcp.commonswarm.com/mcp`, authorization server `https://mcp.commonswarm.com`, bearer method `header`, scope `mcp`, resource name `CommonSwarm hosted MCP`. `:229` allows MCP POST only; `:240` returns 401 with metadata challenge. Auth discovery/JWKS paths: `services/mcp-auth/src/server.js:18`. | Source contract; actual discovery JSON unavailable |
| E3 — OAuth | `services/mcp-auth/src/provider.js:13`: exact issuer/resource; resource scope `mcp` at `:20`; public-client method `none` at `:64`; CIMD at `:77`; exact audience at `:100`; code/refresh grants at `:128`; required PKCE at `:131`; refresh rotation at `:137`; provider scopes `openid`, `offline_access`, `mcp` at `:138`; default access 300s, code 60s, refresh 30 days at `:15`. | Live DCR is task-reported. This provider file does not explicitly enable a registration feature or prove a live `registration_endpoint`; capture it before promising DCR to another host |
| E4 — authorization and lifecycle | `supabase/functions/mcp/auth.ts:263` validates issuer, audience, subject, grant and time claims; it contains no scope-claim validation. `supabase/functions/_shared/hosted-seat-auth.ts:5` separates grant commands, seat writes and reads. `services/mcp-auth/src/connections.js:21` and `:30` implement grant/seat revoke; provider grant-active check at `services/mcp-auth/src/provider.js:150`. | Granular authority checks exist; OAuth scope enforcement and actual revoke/refresh results require separate evidence |
| E5 — limits | `supabase/functions/mcp/index.ts:81`: defaults 128 KiB request, 64 KiB response, 25s timeout, four concurrent requests, all bounded environment overrides. `supabase/functions/mcp/protocol.ts:236`: concurrency refusal 429 with Retry-After 1. `services/mcp-auth/src/config.js:212`: OAuth body default 64 KiB, timeout 10s. `src/protocol/hosted-authority.ts:8`: ten live seats per grant. Signal quotas are 120/credential/hour and 1,000/workspace/hour at `supabase/functions/command/index.ts:699`, enforced at `:11372` (clock-hour windows documented in `site/public/api.md:313`). | Defaults are not measured live settings or requests-per-second quotas; per-process concurrency is not a global/IP rate limiter |
| E6 — legal | `https://commonswarm.com/privacy`, `https://commonswarm.com/terms`, `https://commonswarm.com/acceptable-use` are repository routes. Draft flags: `site/src/pages/privacy.astro:362`, `site/src/pages/terms.astro:379`. Privacy `:253` describes Supabase/North Virginia and `:254` Vercel, contrary to `AGENTS.md:192` and `:214` (Hetzner/Cloudflare, retired hosted Supabase/Vercel). | Concrete source mismatch; live page bodies and final legal approval not measured. Review OAuth client sharing, grant/token retention, consent and revocation disclosures too |
| E7 — support | `SECURITY.md:9`: security@commonswarm.com; `site/src/pages/privacy.astro:344`: legal@commonswarm.com; `site/src/pages/terms.astro:192`: no promised support/SLA. | Contacts exist in source; working support URL/inbox routing and response owner not proved |
| E8 — brand and license | `site/public/brand/app-icon.svg:1`: square 96×96 SVG. `site/public/site.webmanifest:18`: 512×512 PNG; maskable variant at `:24`. `LICENSE:1`: MIT; copyright Yulan Ventures, LLC at `:3`. | Reusable assets exist; no marketplace package references or proof of vendor upload validation |
| E9 — package inventory | At the audit base, `git ls-files '*plugin.json' '*mcp.json' '*server.json' '*gemini-extension.json'` returned zero files across 3,554 tracked files. `package.json:3` is 0.1.80 and `:4` is private; MCP `serverInfo` is `commonswarm`/1.0.0 at `supabase/functions/mcp/protocol.ts:295`. | Missing tracked submission manifests; repository version, protocol server version and published package version are distinct |
| E10 — current acceptance | `TASK-dist.md` reports live hosted OAuth and Claude custom-connector end-to-end PASS. Historical local Codex run: `docs/evidence/2026-09-23-mcp-lane2/production-control/codex-host-run.txt:2`. | No current directory install, other remote host, populated reviewer account, or all-tool review packet was measured in this lane |

### Hosted tool catalog

| Tool | Current description | Side effect classification | Title / hints |
|---|---|---|---|
| `claim_seat` | Create or reuse a named hosted seat in a consented workspace. Retry with the same request_id. | State-changing | Absent |
| `whoami` | Show the selected hosted seat identity. | Read | Absent |
| `check` | Read a durable batch of directed messages, optionally acknowledging the prior batch. | State-changing | Absent |
| `ask` | Ask one or more workspace participants. Retry with the same request_id. | State-changing | Absent |
| `note` | Share a note, optionally with recipients. Retry with the same request_id. | State-changing | Absent |
| `reply` | Reply privately to a signal. Retry with the same request_id. | State-changing | Absent |
| `working_on` | Share current work. Retry with the same request_id. | State-changing | Absent |
| `members` | List members and agents in the selected seat's workspace. | Read | Absent |

All table entries currently have only name, description and input schema.
`supabase/functions/mcp/index.ts:354` routes `check` through open/ack durable
batch commands even when no prior batch is acknowledged. It must not be labeled
read-only. Catalog safety values must follow actual side effects; messaging is
append-only and can have irreversible send effects.

## Claude connector directory — first priority

| Requirement and vendor source | CommonSwarm today | Status | Fix owner |
|---|---|---|---|
| Public HTTPS MCP endpoint — [submission](https://claude.com/docs/connectors/building/submission) | E2/E10: public endpoint and custom connection PASS, task-reported | MET | publisher action |
| Listing: name ≤100, one-liner ≤200, description ≤2,000 characters; 1–5 categories, slug, docs/privacy URLs, support, icon — [submission](https://claude.com/docs/connectors/building/submission) | E9: no dedicated listing packet; site branding is not completed portal metadata | GAP | docs |
| Company website/contact and use cases/prerequisites — [submission](https://claude.com/docs/connectors/building/submission) | E7/E8 provide contacts/company assets; no dated hosted-only packet | GAP | docs |
| OAuth for user-account access — [authentication](https://claude.com/docs/connectors/building/authentication) | E3/E10: OAuth and consent; Claude custom flow PASS | MET | code |
| Discovery challenge, S256 PKCE, refresh, callbacks — [authentication](https://claude.com/docs/connectors/building/authentication) | E2/E3 implement core contract; exact live fields, latency, rotation/revoke and advertised app-surface matrix not retained here | NOT VERIFIED | publisher action |
| CIMD selection advertises `client_id_metadata_document_supported: true` and token auth `none`; alternatively DCR endpoint — [authentication](https://claude.com/docs/connectors/building/authentication) | E3 enables CIMD/public clients; task reports CIMD+DCR. No worker discovery response proves both advertisement fields or registration endpoint | NOT VERIFIED | publisher action |
| Tool `title` and applicable read/write safety hints — [review checklist](https://claude.com/docs/connectors/building/review-criteria) | E1: all eight missing; `check` writes (E4 and supabase/functions/mcp/index.ts:354) | GAP | code |
| Narrow tools, names ≤64, useful validation/errors, first-party APIs, minimal collection — [review checklist](https://claude.com/docs/connectors/building/review-criteria) | E1: eight separate named operations, longest name 10 characters; validation at supabase/functions/mcp/tools.ts:120. Generic `tool_failed` at supabase/functions/mcp/protocol.ts:339 still needs review | NOT VERIFIED | code |
| Accurate privacy/data handling and directory acknowledgments — [submission](https://claude.com/docs/connectors/building/submission) | E6: URLs exist but draft hosting/recipient claims need correction; seven portal attestations incomplete | GAP | docs / Tom decision |
| Terms URL readiness | E6: `/terms` draft. Separate CommonSwarm terms URL requirement not established by fetched connector checklist; directory terms still apply | NOT VERIFIED | Tom decision |
| Owned icon — [submission](https://claude.com/docs/connectors/building/submission) | E8: CommonSwarm square icon exists; selection/upload still publisher work | MET | publisher action |
| Populated reviewer account and complete access instructions — [submission](https://claude.com/docs/connectors/building/submission) | E10: no dedicated account evidence. `/app` self-service does not prove reviewer readiness | GAP | publisher action |
| Exercise every tool and retain results — [review checklist](https://claude.com/docs/connectors/building/review-criteria) | E10 closes custom-flow gate, not an independently inspected eight-tool result packet | NOT VERIFIED | publisher action |
| Paid plan, organization ownership/roles; scanning; Community versus Verified — [publishing](https://claude.com/docs/directory/publish) | Eligibility/portal state unknown; no submission or listing proof. Community publication can follow automatic scanning | NOT VERIFIED | publisher action / Tom decision |
| Rate/latency readiness | E5 defaults exist; [auth](https://claude.com/docs/connectors/building/authentication) gives 10s discovery/registration/token and 30s refresh budgets. Live compliance and directory-specific numeric quota not measured | NOT VERIFIED | code / docs |
| Screenshots / external-link allowlist — [submission](https://claude.com/docs/connectors/building/submission) | supabase/functions/mcp/protocol.ts:294 advertises tools only; no MCP App UI. Conditional materials currently inapplicable; no UI should be invented | MET | docs |

## Claude companion plugin — separate package and submission

| Requirement and vendor source | CommonSwarm today | Status | Fix owner |
|---|---|---|---|
| `.claude-plugin/plugin.json`, correct component root and MCP config — [structure](https://claude.com/docs/plugins/build) | E9: neither manifest nor `.mcp.json` tracked; existing CLI installer is a different route | GAP | code |
| Name, display/publisher identity, version, description — [plugin checklist](https://claude.com/docs/plugins/pre-submission-checklist) | E8/E9 supply brand/version inputs only; no plugin metadata | GAP | docs |
| README ≥40 prose words and license — [plugin checklist](https://claude.com/docs/plugins/pre-submission-checklist) | Root README/LICENSE exist; no companion folder with its own install/surface documentation | GAP | docs |
| Self-contained regular files, portable paths, repository/file size and attribute checks — [plugin checklist](https://claude.com/docs/plugins/pre-submission-checklist) | E9: no package to validate. Whole product repo's archive size not measured; choose a small package location | NOT VERIFIED | code |
| OAuth/scopes and CIMD/DCR for referenced remote server | E2/E3 same service; no plugin installation/auth result | NOT VERIFIED | publisher action |
| Privacy/terms/support links and icon | E6–E8 assets exist, policy text wrong/draft, package references absent | GAP | docs |
| Accurate tool annotations | E1: required connector metadata missing; bundling cannot repair the server | GAP | code |
| Reviewer setup and local/portal validation — [plugin checklist](https://claude.com/docs/plugins/pre-submission-checklist) | E10: no plugin reviewer walkthrough or validation; exact additional reviewer-account fields not verified | NOT VERIFIED | publisher action |
| Paired connector and plugin submissions; app/surface limits — [publishing](https://claude.com/docs/directory/publish), [structure](https://claude.com/docs/plugins/build) | No submissions. Whether companion hooks/agents/local components are needed is undecided | NOT VERIFIED | Tom decision / publisher action |
| Security scans and human review — [publishing](https://claude.com/docs/directory/publish) | No plugin review result; validate secrets, instructions and component boundaries before intake | NOT VERIFIED | publisher action |
| Rate limits | E5 applies to hosted calls; a separate plugin marketplace quota was not established | NOT VERIFIED | docs |

## ChatGPT directory and Codex

| Requirement and vendor source | CommonSwarm today | Status | Fix owner |
|---|---|---|---|
| Portable root `plugin.json` + `mcp.json`, one MCP server in initial ZIP, OpenAI extension metadata — [package](https://developers.openai.com/plugins/build/plugins), [submission](https://developers.openai.com/plugins/deploy/submission) | E9: no package; repository CLI bundle is not a plugin | GAP | code |
| Listing `displayName` ≤30, `shortDescription` ≤30, `longDescription` ≤4,000, `developerName` ≤80 characters, category; localization/access fields — [submission](https://developers.openai.com/plugins/deploy/submission) | E8/E9 inputs available, listing absent | GAP | docs |
| HTTPS website/support/privacy/terms URLs — [submission](https://developers.openai.com/plugins/deploy/submission) | E6/E7: legal URLs in source; wrong draft policy and no verified support URL | GAP | docs / Tom decision |
| Square primary icon ≥48px; Codex `logo` and `composerIcon`, referenced assets — [submission](https://developers.openai.com/plugins/deploy/submission) | E8 SVG has 96px square dimensions; package references and upload checks absent | GAP | code / docs |
| Organization/project roles, verified identity/domain, policy attestations — [submission errors](https://developers.openai.com/plugins/deploy/submission-errors) | No account/domain challenge/portal evidence. Public DNS ownership alone is not completed vendor verification | NOT VERIFIED | publisher action / Tom decision |
| OAuth discovery, S256, resource/audience, CIMD/DCR or predefined registration — [authentication](https://developers.openai.com/plugins/build/auth) | E2/E3 source supports much of contract; no ChatGPT connection/callback/refresh/revoke proof | NOT VERIFIED | publisher action |
| Per-tool `securitySchemes`, scopes and OAuth auth-error metadata — [authentication](https://developers.openai.com/plugins/build/auth) | E1 lacks security schemes; supabase/functions/mcp/protocol.ts:339 tool errors lack `_meta["mcp/www_authenticate"]`; E4 lacks JWT scope-claim enforcement. HTTP 401 discovery is separate from tool-level linking | GAP | code |
| Explicit `readOnlyHint`, `destructiveHint`, `openWorldHint` — [guidelines](https://developers.openai.com/plugins/plugin-guidelines) | E1: all absent. Keep `check` state-changing and assess irreversible messages | GAP | code |
| Five positive/three negative cases, video, release notes — [submission errors](https://developers.openai.com/plugins/deploy/submission-errors) | No dedicated packet at E9/E10; historical Claude/Codex controls are not these materials | GAP | docs |
| Full sample-data account, immediate reviewer access without inaccessible extra login steps — [guidelines](https://developers.openai.com/plugins/plugin-guidelines) | E10 lacks credentials/access proof; OAuth source uses external GoTrue provider (services/mcp-auth/src/gotrue.js:26), which needs reviewer-route verification | GAP | publisher action |
| Security/tool scans; policy and functional review; exact install on claimed desktop/mobile surfaces — [submission errors](https://developers.openai.com/plugins/deploy/submission-errors), [guidelines](https://developers.openai.com/plugins/plugin-guidelines) | No scan/approval/current client results | NOT VERIFIED | publisher action |
| No app references/lifecycle hooks in submitted ZIP — [submission](https://developers.openai.com/plugins/deploy/submission) | E9: no ZIP to inspect; do not assume a local hook bundle is portable | NOT VERIFIED | code |
| Rate limits/reliability | E5 source defaults only; no measured ChatGPT latency/429/retry or marketplace numeric quota | NOT VERIFIED | code / docs |
| Codex direct MCP configuration and registration — [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) | Historical local stdio acceptance at E10; fresh remote CIMD/DCR/native-loopback proof absent. services/mcp-auth/src/config.js:203 defaults native loopback off | NOT VERIFIED | publisher action |
| Codex plugin installation / actual cloud agent behavior | E9 missing package. A CLI install does not establish ChatGPT directory availability or cloud wake; supabase/functions/mcp/protocol.ts:294 advertises tools only | GAP | code / docs |

Official OpenAI documentation currently disagrees about annotation justifications:
the [guidelines](https://developers.openai.com/plugins/plugin-guidelines) say they
are no longer required, while [submission errors](https://developers.openai.com/plugins/deploy/submission-errors)
still require them. Retain truthful rationale in the packet and have the publisher
check the actual validator. Both require explicit booleans. Claude's fetched
checklist also treats modifying tools as destructive for its permission behavior;
cross-client hint semantics need a deliberate review rather than assumed defaults.

## Cursor marketplace and direct install

| Requirement and vendor source | CommonSwarm today | Status | Fix owner |
|---|---|---|---|
| Portable root manifest or `.cursor-plugin/plugin.json`; root `mcp.json` — [reference](https://prod.cursor.com/docs/reference/plugins) | E9: missing both package routes | GAP | code |
| Name; optional description/version/author/homepage/repository/license/keywords/logo — [reference](https://prod.cursor.com/docs/reference/plugins) | E8/E9 provide inputs; no manifest | GAP | docs |
| Public open-source repository and manual review including updates — [plugins](https://prod.cursor.com/docs/plugins) | MIT at LICENSE:1; repository public per SECURITY.md:3. Marketplace acceptance and clean install absent | NOT VERIFIED | publisher action |
| Remote URL/OAuth/scopes — [MCP](https://prod.cursor.com/docs/mcp) | E2/E3 existing service; no Cursor host acceptance | NOT VERIFIED | publisher action |
| DCR or configured static client and surface-specific callbacks — [MCP](https://prod.cursor.com/docs/mcp) | Web `https://www.cursor.com/agents/mcp/oauth/callback`, desktop `http://localhost:8787/callback` need client proof; E3/task DCR does not prove these redirects accepted | NOT VERIFIED | code / publisher action |
| Privacy/terms links | E6 inaccurate/draft; exact marketplace requirement not established by fetched reference | NOT VERIFIED | docs / Tom decision |
| Logo reference — [reference](https://prod.cursor.com/docs/reference/plugins) | E8 asset exists, optional manifest `logo` absent | GAP | docs |
| Tool safety annotations | E1 absent; fetched Cursor pages did not establish a mandatory hint set | NOT VERIFIED | code |
| Reviewer account/security review | Review is documented; dedicated-account intake not specified in fetched pages; E10 has no Cursor proof | NOT VERIFIED | publisher action |
| Rate limits and install truth | E5 limits; no Cursor 429/refresh/revoke/direct-install or listing result; separate marketplace quota unknown | NOT VERIFIED | docs / publisher action |

## Gemini Apps and Gemini CLI gallery

| Requirement and vendor source | CommonSwarm today | Status | Fix owner |
|---|---|---|---|
| Apps custom connection: personal US adult account, Keep Activity, standard MCP URL — [Apps help](https://support.google.com/gemini/answer/17209137) | E2 endpoint exists; no eligible Gemini-host control or declared surface matrix | NOT VERIFIED | publisher action |
| Apps DCR or Advanced features credential entry — [Apps help](https://support.google.com/gemini/answer/17209137) | E3/task registration claim; no Gemini auth/consent/refresh/disconnect result | NOT VERIFIED | publisher action |
| Public consumer-directory metadata, eligibility and intake | Fetched Apps help documents custom connections, not publisher directory submission | NOT VERIFIED | publisher action / Tom decision |
| CLI root `gemini-extension.json`: name, version, MCP config — [reference](https://geminicli.com/docs/extensions/reference/) | E9: missing extension | GAP | code |
| Public GitHub repo, `gemini-cli-extension` topic, absolute-root manifest; gallery indexing — [release](https://geminicli.com/docs/extensions/releasing/) | Manifest absent; topic/gallery record not measured | GAP | code / publisher action |
| CLI `httpUrl`, discovery/registration/scopes, callback `iss` validation — [MCP](https://geminicli.com/docs/tools/mcp-server/) | E3; nativeLoopbackEnabled default false (services/mcp-auth/src/config.js:203). No actual CLI OAuth callback, expected issuer or refresh/revoke proof | NOT VERIFIED | code / publisher action |
| Privacy/terms URLs | E6 draft/mismatched; separate Apps/CLI gallery URL-field mandate not established | NOT VERIFIED | docs / Tom decision |
| Logo/icons | E8 assets available; mandatory gallery image fields not established | NOT VERIFIED | docs |
| Tool annotations | E1 metadata absent; Google-specific marketplace hint mandate not established | NOT VERIFIED | code |
| Test account/security review | No Gemini acceptance; gallery indexing is not consumer security approval; reviewer-intake requirements unknown | NOT VERIFIED | publisher action |
| Rate limits | E5 defaults only; vendor-specific quota and real retry/confirmation behavior not measured | NOT VERIFIED | code / docs |

## Grok chat, Grok Bot and xAI API

| Requirement and vendor source | CommonSwarm today | Status | Fix owner |
|---|---|---|---|
| Chat custom MCP URL and auth/tool discovery — [connectors](https://docs.x.ai/grok/connectors) | E2/E3 service exists; no actual Grok connection, identity, messaging, refresh or revoke | NOT VERIFIED | publisher action |
| Bot Marketplace plugin install and task attachment; account-wide access — [Bot apps](https://docs.x.ai/grok-bot/computer-and-apps) | E9: no Bot package or install proof; CommonSwarm named seats do not create host account isolation | NOT VERIFIED | publisher action / docs |
| Public publisher intake/metadata manifest | Official pages describe use, not a verified public-publisher intake/schema | NOT VERIFIED | publisher action |
| OAuth/scopes | E3 `mcp` resource scope; Grok's exact accepted grant/auth/error subset not established | NOT VERIFIED | code / publisher action |
| CIMD/DCR and callbacks | Task-reported server support; exact Grok client registration and redirect route unknown | NOT VERIFIED | code / publisher action |
| Privacy/terms URLs | E6 draft/mismatched; Grok publisher-required field schema unknown | NOT VERIFIED | docs / Tom decision |
| Logo/icons | E8 exists; Grok publisher specs unknown | NOT VERIFIED | docs |
| Tool annotations | E1 missing hints; exact Grok publisher mandate unknown | NOT VERIFIED | code |
| Test account and security/legal review | E10 no Grok reviewer control; public-publisher review terms unknown | NOT VERIFIED | publisher action |
| Rate limits | E5 defaults; Grok-specific quotas/compatibility unknown | NOT VERIFIED | code / docs |
| Remote MCP developer API — [API](https://docs.x.ai/developers/tools/remote-mcp) | A separate integration route; no executed API evidence. API support cannot close chat/Bot listing gates | NOT VERIFIED | publisher action |

## MCP Registry

| Requirement and vendor source | CommonSwarm today | Status | Fix owner |
|---|---|---|---|
| `server.json`: schema, owned name, description, version; Streamable HTTP remote URL — [remote servers](https://modelcontextprotocol.io/registry/remote-servers) | E9: no record; endpoint from E2 can be represented as remote-only | GAP | code / docs |
| Namespace ownership and publisher authentication — [quickstart](https://modelcontextprotocol.io/registry/quickstart) | No ownership/login/record proof; choose an owned namespace before creating metadata | NOT VERIFIED | publisher action / Tom decision |
| Public remote reachability — [remote servers](https://modelcontextprotocol.io/registry/remote-servers) | E10 task reports live public service; worker DNS blocked | MET | publisher action |
| OAuth/scopes for consumers | E2/E3; Registry metadata does not authenticate the consumer on its behalf | NOT VERIFIED | docs |
| CIMD/DCR for consumers | E3/task support, live exact metadata unmeasured; no additional Registry-specific mandate established | NOT VERIFIED | docs |
| Privacy/terms URL fields | E6 drafts; these fetched Registry pages do not establish mandatory policy URL fields | NOT VERIFIED | docs |
| Logo/icons | E8 available; applicable Registry schema icon requirements not verified | NOT VERIFIED | docs |
| Tool annotations | E1 missing; Registry publication is metadata, not a vendor tool-safety approval | NOT VERIFIED | code / docs |
| Reviewer account/security review | No vendor marketplace approval implied by a Registry record; dedicated reviewer-account requirement not established | NOT VERIFIED | publisher action |
| Rate limits | E5 source service limits; Registry-specific publication quota unknown | NOT VERIFIED | docs |
| Publish/result verification and optional package provenance — [quickstart](https://modelcontextprotocol.io/registry/quickstart), [remote servers](https://modelcontextprotocol.io/registry/remote-servers) | No publish/lookup run; remote-only route does not need npm. E9 root version is not proof of a shipped package | NOT VERIFIED | publisher action |

## Meta personal Muse directory

| Requirement and vendor source | CommonSwarm today | Status | Fix owner |
|---|---|---|---|
| Product description — [platform](https://muse.ai/platform) | E1/E9 define hosted scope, but no Muse-specific packet | GAP | docs |
| Functional, security, legal and end-to-end review; approval before availability — [platform](https://muse.ai/platform) | No submission/review/install proof; no promise of featured placement | NOT VERIFIED | publisher action |
| Exact metadata/intake fields | Public page describes process only; authenticated intake not inspected | NOT VERIFIED | publisher action |
| Accepted transport, OAuth/scopes | E2/E3 exist; personal Muse's accepted protocol/auth subset unknown | NOT VERIFIED | publisher action / code |
| CIMD/DCR/client registration | E3/task support cannot establish personal Muse support | NOT VERIFIED | publisher action / code |
| Privacy/terms URLs and platform terms — [terms](https://muse.ai/platform/terms) | E6 draft/mismatched; fetched vendor terms yielded no usable requirements text | NOT VERIFIED | Tom decision / docs |
| Logo/icon specs | E8 exists; intake specs unknown | NOT VERIFIED | docs |
| Tool annotations | E1 missing; personal Muse's exact annotation policy unknown | NOT VERIFIED | code |
| Reviewer/test-account requirements | E10 no reviewer setup; intake fields unknown | NOT VERIFIED | publisher action |
| Rate limits/fees/update/review timing | E5 defaults only; exact vendor constraints unknown | NOT VERIFIED | publisher action / Tom decision |

Muse Code and custom user connections are separate routes. None proves personal
Muse directory approval. No adapter should be promised before the intake's
transport/auth terms are verified.

## Ordered fixes for Claude submission readiness

1. **Code:** add titles and accurate hints to the canonical hosted table; keep
   `check` state-changing. Resolve hint semantics across clients and improve
   generic errors. Test only touched files, with new tests in literal package
   script lists. HezLead controls any subsequent deployment.
2. **Docs + Tom decision:** correct retired hosting/region claims, describe actual
   OAuth/workspace sharing, consent, retention and revoke behavior, and approve
   final legal text. Name a functioning support path and response owner.
3. **Publisher action:** retain the reported Claude PASS evidence and obtain
   exact discovery/registration fields, live revisions/limits and all eight
   tool results, with refresh/revoke/negative controls. Confirm each advertised
   Claude surface. The current custom-flow gate need not be treated as failed.
4. **Docs + publisher action:** assemble hosted-only listing/use cases, documentation
   and policy URLs, support, selected icon and synthetic populated reviewer
   access/reset instructions. Keep reviewer credentials exclusively in private
   vendor fields; check publisher plan, roles and company ownership.
5. **Tom decision + code/docs:** decide companion scope, then create and validate
   its small self-contained package, manifest/MCP configuration, README and
   license. Connector and plugin need separate acceptance evidence.
6. **Publisher action, separately authorized:** resolve portal checks and security
   attestations only after the packet is ready; submit connector first, plugin
   second if approved. Automatic Community listing is a public-launch action.
   Confirm actual listing and clean install before claiming directory availability.

This audit neither creates those packages nor requests publication. Remaining
vendor/account uncertainties stay visible instead of becoming invented requirements.

## Live metadata measured by the lead (2026-10-02, public GET, `User-Agent: curl/8.7.1`)

The lane worker could not resolve the host from its sandbox. These values are measured from the live service.

| Field | Live value | Status for directory submission |
|---|---|---|
| Protected-resource metadata (`/.well-known/oauth-protected-resource/mcp`) | resource `https://mcp.commonswarm.com/mcp`, authorization_servers `https://mcp.commonswarm.com`, scopes_supported `mcp`, bearer_methods_supported `header`, resource_name `CommonSwarm hosted MCP` | MET |
| Issuer / endpoints | issuer `https://mcp.commonswarm.com`; authorize `/authorize`; token `/token`; jwks `/jwks` (one EC P-256 ES256 `sig` key with kid) | MET |
| PKCE / grants / client auth | code_challenge_methods `S256`; grant_types `authorization_code,refresh_token`; token_endpoint_auth_methods `none`; response_types `code` | MET |
| Client registration | `client_id_metadata_document_supported: true`; **no `registration_endpoint` advertised**; `/reg` and `/register` return 404 | GAP for any channel that requires RFC 7591 DCR (Claude used CIMD). Fix owner: code + Caddy + release, or document CIMD-only per channel |
| Advertised but unreachable endpoints | `pushed_authorization_request_endpoint` `/request`, `userinfo_endpoint` `/me`, `end_session_endpoint` `/session/end` are advertised; all three return **404** (Caddy does not route them) | GAP: metadata advertises endpoints that do not work. A PAR-capable client could fail. Fix owner: code (disable the features or stop advertising them) or Caddy (route them) |
| Scopes | `scopes_supported` `openid,offline_access,mcp` (AS) vs `mcp` (resource) | NOT VERIFIED against each channel's scope rules |
| DPoP | `dpop_signing_alg_values_supported` `ES256,Ed25519,EdDSA` advertised | NOT VERIFIED whether DPoP-bound tokens work end to end; remove if not supported |
