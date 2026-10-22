# CommonSwarm design system

Design lead: Codex Sol. Current app contract updated 2026-10-22 UTC. The v0.3 specimen notes below retain their historical review state; production slices have their own source, design and CI receipts.

**Current app state (2026-10-22 ~20:39Z):** Lists PR183 is LIVE on `81b5fb71f20030cf71b7927964a2c08c425a1ab3`, baseline273/assets200, rollbackPR182. Its whole tree exactly matches canonical-tested84fad586 (1163pass/0fail/2existing skips, all4gates0). Same-cycle Claude Opus review accepted all four controlled normal light views at8/10 with zero blockers after N1/E5 repairs. Those are sample-source compositions, not fresh signed-in live scores. PR182 invitation focus and all earlier releases remain included. No full-app9+ claim.

**Current shipping rule from Tom:** one cross-family review, changed-area CI green, rollback ready. Whole-screen redesigns ship at 8+; small fixes ship when they improve live and pass the tests. Unrelated failures get a named follow-up. Dark polish and extra release checks are follow-ups, with no extra repeat/export/staging proof layer. CommonSwarm owns main integration/configured builds; HezLead releases. Secrets, exact ownership, runner queue and release-lock rules remain in force. These rules supersede the historical rollout gates below.

**Current typography:** production ships the unmodified, self-hosted Inter 4.001 asset at `site/public/fonts/inter-latin.woff2`, licensed by `site/public/fonts/OFL-Inter.txt`. `kylon-font.css` defines `CommonSwarm Inter` and the opted-in app font token. The historical statement below that live PRs only declare a fallback stack is superseded. A computed family name still does not prove a successful font load; visual evidence records the actual font response. Account PR160 extends this same opt-in to its separate Admin root and is live.

**Current executable sources:** read the exact source revision's `site/src/styles/kylon-tokens.css`, `kylon-font.css`, `kylon-layout/`, `kylon-people*.css`, `kylon-todos*.css`, `kylon-account-dialogs.css`, `kylon-new-workspace.css`, `kylon-workspace-settings*.css`, `kylon-wiki*.css`, `kylon-files.css`, `kylon-catchup.css`, `kylon-onboarding.css`, `kylon-entity-profile.css`, `kylon-channel-dialog.css`, `kylon-agent-page.css`, `kylon-chat-empty.css`, `kylon-invitation-inbox.css`, `kylon-invite-onramp.css`, `kylon-lists.css` and conversation/composer modules. The specimen `--cs-*` tokens are a design contract, not automatically available to live components. Use the actual scoped `--k-shell-*` tokens or a local mapping. The current font, focus and theme preference owners remain authoritative; never copy a stale specimen selector over the working app.

Current Lists release evidence is indexed in `reviews/PR183-LIVE-RECEIPT.json` and the frozen `reviews/PR183-RELEASE-READY-PACKET.json`. Actual four desktop/phone list/document images were captured onbb7; critic explicitly accepted their applicability to the final reviewed6dc UI, whose13product/copy blobs are unchanged in tested84 and merged81. CS confirmed existing live routes and qualified hosted-only inheritance; no D1 qualification or new agent tools are claimed. Existing E1draft recovery/E2consent controls/E3refusal remedies/E4legacy connector-reference gaps are explicitly grandfathered for this UI-only slice and stay on CS's separate parity/D1 backlog. Required release note: Lists UI/copy refresh only; no new agent tools; existing MCP/CLI gaps unchanged; no parity claim. This supersedes historical blanket parity-blocker wording for that exact unchanged scope.

**Current Lists component contract:** keep one native pane H1; move its original description and Refresh nodes into the compact heading without cloning, preserve consent before content, and place complete selected content/history before routine agent-approval furniture. Keep every native action and disclosure. The selected title is18px/600; document sections use16/15/14px hierarchy,20px/8px section spacing and12px paragraph spacing; attribution/revision are12px secondary inline metadata only. Selected object navigation derives `aria-current` from the existing selected ID, independent from keyboard focus. Native controls use6px radii and44px targets. Allow follows the existing access/content completion and confirmation with a scoped presentation intent; the People and Add-agent entries forward that same intent without new routes, permissions, auto-approval or reads. Hosted owner-connected agent inheritance remains distinct from explicitly connected local credentials.

**Prepared next Lists slices, not live:** draft184 places the existing check/uncheck action beside each editable current item, with a44px native checkbox-role button, escaped content and nonempty accessible fallback. Its existing compiled SSR owner passed actual old-markup/blank-name negative controls and repaired positive control; images/review/CI remain pending. Separate draft185 groups current workspace identity and audience/role facts into naturally wrapping rows, retaining every sentence/value and heading. It changes only two noninteractive wrappers and scoped layout rules, with no runtime/score claim. Do not import either draft into another feature until its exact source is reviewed and qualified. References remain private study material, never product assets.

**Current production focus and selection:** read the exact revision’s `kylon-tokens.css`; light focus is `#176548`, dark focus is `#9bc6ab`, independent from the selected-edge token (`#697344`light, `#b2bb85`dark). The normal app ring uses2px surface separation plus2px focus; small controls use the corresponding2px outline/2px offset. Historical specimen focus values below are not the current live cascade. Separate custom-element roots must explicitly opt into the shared tokens, both theme mappings and `CommonSwarm Inter`; being a sibling of the dashboard does not provide inheritance. Existing theme-preference/bootstrap owners remain unchanged.

**Live audit status:** HezLead confirms Tom quit Chrome to free mini memory. Never start or launch it; live captures wait until Tom reopens Chrome himself, then require browser-harness doctor and the applicable resource window. The earlier one-window attempt ended15:48Z with zero task tabs/captures and own lock released. Controlled evidence remains separate from live scores; this adds no release gate to reviewed8+ slices.

**Inline actions:** discrete phone controls keep 44px targets. Actions embedded inside prose must retain the surrounding line rhythm. Do not apply a blanket 44px minimum and vertical padding to an inline sentence button: PR166’s first review found that this doubled the callout/footer line spacing. Preserve the native prerequisite inline dimensions and the agent-footer negative-margin target treatment. Expanded disclosures and IDs remain reachable; reducing clutter never means hiding an action or fact.

**Reference limits:** `AUDIT-KYLON-REFERENCE-MAP.md` identifies valid comparable frames. Capture43 is the settled phone reference. Captures06,31 and39 contain offscreen/duplicated transitional layouts and are not responsive targets. A reviewer must open a reference before claiming side-by-side comparison; a path in a brief is not evidence of an image read. CommonSwarm-specific capabilities retain their own contracts when Kylon has no equivalent screen.

---

Historical v0.3 specimen contract and review notes follow. Argon rounds 1 and 2 were FAIL; the pending round 3 note is not a current production approval or a blocker on separately reviewed slices.

CommonSwarm should feel like a quiet, familiar place where people and agents work together. Kylon is the primary visual and interaction reference. Tom's organization, permissions, multi-organization identity, and MCP/CLI requirements govern the product model.

## Reference and provenance

1. [Kylon workspace](https://kylon.io/product/workspace): persistent navigation, conversations, shared context.
2. [Kylon permissions walkthrough](https://kylon.io/blog/how-permissions-work-in-kylon): unified people/agents, joined-room boundaries, contextual resources, connection access, inline approvals. Public app-build video frames at 1s and 5s and permissions video at 52s are in `evidence/reference/`; these are study material only.
3. [Kylon public agent flow](https://kylon.io/mocks/byoa-steps/invite-menu.html), [agent selection](https://kylon.io/mocks/byoa-steps/pick-codex.html), [room conversation](https://kylon.io/mocks/byo-hub-room.html), [phone reference](https://kylon.io/mocks/byo-hub-room-mobile.html): flow references. No code or assets imported.
4. Shared public study: `/Users/yulanbot/work/argon-lane/KYLON-STUDY.md`. Reuse its behavioral research; its visual measurements mix Kylon with the earlier RidgeHQ northstar. Do not treat those as authenticated Kylon measurements.
5. Tom authorized signed-in browser study after the original public-only brief. Internal captures and an indexed account of observed states live in `kylon-captures/`. These never go in a public repository. The empty workspace was explicitly authorized by HezLead as a study sandbox. Onboarding is complete, workspace name is CS design study. Captures cover chat, membership, agent profile and setup dialogs, connections, workspace settings, and versioned knowledge. See the capture index for coverage and safe-action omissions.

All values below are CommonSwarm implementation choices, estimated from observed reference proportions. They are not claims of access to Kylon source or computed CSS. We write our own components, line icons, copy, and initials avatars. The standalone specimen self-hosts Inter under the SIL Open Font License (`assets/INTER-LICENSE.txt`); it is not taken from Kylon. The current app PRs only declare an Inter-first system fallback stack: they do not yet bundle or load Inter. Their computed font-family strings do not prove actual Inter rendering. Shipping the specimen font in the app needs a separate source change and fresh visual proof; see `reviews/FONT-PROVENANCE-CORRECTION.md`. Kylon imagery, marks, artwork, and text remain reference-only.

## Tokens

The executable contract is `design-system.css`. Production tokens will be scoped to the app; existing site-wide token names remain compatible and marketing is outside this slice.

| Token | Value | Use |
|---|---|---|
| `--cs-canvas` | `#f5f5f2` | Quiet fills and composer; shell itself is white |
| `--cs-surface` | `#ffffff` | Main working panel, dialogs, menus |
| `--cs-subtle` | `#f5f5f2` | Artifact heading, quiet message background |
| `--cs-selected` | `#eeefea` | Quiet warm-gray selection |
| `--cs-ink` | `#282720` | Names, body, headings |
| `--cs-secondary` | `#655e53` | Supporting copy and navigation |
| `--cs-muted` | `#716b60` | Timestamps and metadata; never lower opacity |
| `--cs-line` | `#e9e7e2` | Decorative panel boundaries and row dividers |
| `--cs-control` | `#7e887c` | Identifiable input/button boundary |
| `--cs-accent` | `#697344` | Primary actions; own messages remain quiet warm gray |
| `--cs-accent-hover` | `#535d33` | Primary hover |
| `--cs-accent-soft` | `#eef1e6` | Quiet affirmative badge background |
| `--cs-danger` / soft | `#a32f3c` / `#fff0f1` | Destructive action/error |
| `--cs-warning` / soft | `#805313` / `#fff6e6` | Required attention |
| `--cs-focus` | `#586339` | 2px focus ring, 3px offset |

- Type: licensed Inter, 400 body / 500 controls / 600 names and headings. Interface body 13–14px, 1.55–1.7 leading; navigation 13px; metadata 11–12px. Page headings 20px/1.35, tracking −0.5px; document heading 26px. No serif editorial layer in the app. Never use uppercase letter-spaced headings as the primary navigation system.
- Spacing: 4, 8, 12, 16, 20, 24, 32, 48px. Rows 36px desktop, 44px phone navigation. Messages have 12px avatar gap, 25px between distinct authors; consecutive messages group tightly without repeating identity.
- Radius: 6px controls; 8–10px selections, messages and artifacts; 16px dialogs; flat, square main working area. Avatars 32px; people round, agent identifiers softly squared. No Kylon mascots or portraits.
- Elevation: no main-panel shadow; composer `0 2px 10px #29271c0c`; popover/dialog `0 12px 40px #1d2b1f24, 0 2px 6px #1d2b1f0d`. No shadow on every list row.
- Motion: 140ms ease-out for state changes. No indefinite presence animation; no entrance animation on message history; no motion under reduced-motion preference.

Contrast is checked against actual adjacent token colors in the evidence script. Text must meet WCAG AA (4.5:1 normal; 3:1 large); meaningful control boundaries and focus indicators meet 3:1. Decorative hairlines are not used as the only way to recognize a control. Presence always has a text equivalent in member details; color alone carries no permission or delivery meaning.

## App shell and hierarchy contract

Authenticated Kylon shows a 52px product rail, an approximately 390px list pane at a 1471px viewport, and a flexible white working area with thin vertical dividers. The specimen follows that flat geometry: 390px list at ≥1400px, 340px normally, 280px at ≤1100px. Conversation content and composer cap at 800px; main canvas is white, with no floating rounded shell. A contextual panel appears only on request. Header 64px; contextual file actions replace channel chrome on knowledge views. Keep headers small and useful. These measured proportions supersede the public demo/earlier RidgeHQ rounded shell.

Organization name and logo/explicit upload placeholder stay at top left. Clicking the identity opens the organization switcher; workspaces switch *inside* the selected organization. Channel list belongs to that workspace. Persist organization + workspace + channel route together. One agent identity can have multiple organizations and different roles in each; never hard-code a single org on a profile.

At ≤760px show one active panel. Product navigation is duplicated only inside the phone drawer; desktop product choices appear exclusively in the icon rail. Navigation opens as a modal drawer with focus containment, Escape dismissal, scrim, and focus return. Header retains channel identity and organization access. Composer stays inside the active conversation; message history scrolls above it. No horizontal document scrolling at 320/390px; tables adapt or scroll within an explicitly labeled region. Required actions remain reachable in a labeled menu when space is scarce. A small display does not reduce agent/API capability.

**Before production integration:** replace specimen-only navigation and illustrative context with authoritative data. Do not render online status without connected-session evidence. Do not add future organization menus until the hierarchy feature is functional. The shell PR preserves all live actions and data selectors.

## Core components

| Component | Layout and behavior contract |
|---|---|
| Organization identity | Logo 32px, name 13px/600, workspace context. No logo: named upload placeholder with accessible action. Switcher shows reachable orgs, current check, search when needed. Ambiguous agent target returns choices rather than silently switching. |
| Product rail/sidebar | Original 20px line icons; readable labels on sidebar. `aria-current` identifies current route. Sections for workspace resources, channels and direct messages. Private channel uses lock + accessible label. Preserve existing catch-up/tasks/brain/access actions until a reviewed migration replaces them. |
| Top bar | Channel name, short topic, members, search and contextual actions. Org is always reachable. Truncated topics have accessible full text. No duplicate toolbars. |
| Lists/members | One combined people-and-agents roster. Avatar/name + explicit type, org role, accessible workspaces, contextual row actions. Roles: Owner, Admin, Member, Guest. Workspace grants are separate from org role. Do not hide revocation scope behind a generic Remove label. |
| Message | Identity, agent indicator, timestamp, readable content. Group consecutive author messages; show editing/correction truth from append-only signals. Thread count is a button with accessible target. Copy, citation, delivery and refusal details remain reachable without hover. |
| Composer | Labeled textarea, attachment/mention affordances, one primary send. Enter sends; Shift+Enter adds newline; IME composition never submits. Show channel/recipient scope. Pending send, failure + retry, and confirmed delivery are distinct. Keep text on failure. |
| Artifact/card | Bounded preview, type, title, provenance/version, one contextual primary action. No fabricated image, completion status or evidence. Approval cards name action, subject, target scope, approver and expiry, with approve/reject; the same approval is available in chat/MCP/CLI. |
| Dialog | Native dialog or equivalent semantics; named heading, initial focus, contained keyboard focus, Escape/cancel, focus return, scoped submit. Max 440px ordinary form; larger only for real complexity. Destructive confirmation names what stops and what is retained; server safeguards still required. |
| Menu | Anchored near trigger; current item clear; keyboard reach, Escape, outside click and focus return. If using `role=menu`, implement the complete arrow-key pattern; otherwise native buttons/links in a labeled popover are acceptable. |
| Form | Visible label, concise help, inline error, preserve inputs, disable only the pending submit. Control boundary uses `--cs-control`, not the decorative divider. Server refusal appears beside action with exact remedy. |
| Empty state | One reason to act, one plain sentence, one relevant action. Differentiate no content, loading, no matches, no permission, and connection failure. No fake examples on a live empty workspace. |
| Toast | Announce confirmed result via status; keep persistent failures next to the action. Toasts don't steal focus. Destructive Undo only when implemented. No success for preview/pending operations. |
| Agent status | Server-backed connected, working, idle, needs authorization, unavailable. Distinguish provider/model from identity. Owner-connected agents inherit owner access subject to explicit restrictions; UI does not create an extra manual transfer step. |

## Page templates and flows

1. Conversation: channel + thread + contextual document, stable composer, thread opens without losing channel position.
2. Organization members: unified roster, role control, workspace membership management. Removal confirms scope (workspace seats closed immediately; org removal removes access throughout that org). Inherit access through owner where specified.
3. Workspace/channel settings: same compact title and form grid; public/private, topic, notifications, membership, archive. Guest visibility follows explicit grants.
4. Wiki: authenticated Kylon shows a file index in the list pane, a white document preview with size/version/search/download/actions in its header, and agent-assisted creation beside the document. Adopt that context-first pattern. CommonSwarm also shows author/type, review state, last change, permissions. Editing uses version checks and handles conflicts without erasing text. History restore creates a new version. Original viewer/editor owned by hierarchy team.
5. Connections: agent selection, setup instructions, live connection proof, recovery. Permanent by default. Preserve current consent and capability semantics; no redesign code changes authorization.
6. Onboarding: authenticated Kylon uses full-canvas conversational prompts, quick answer cards, optional custom input, and explicit skips. Observed sequence: welcome → agent name → optional bring-your-agent → optional phone call → workspace name → optional teammates → workspace chat. CommonSwarm adapts the conversational clarity, keeps agent-first entry and requires neither phone nor invitations/billing to work. Do not copy Kylon question text or its skip-confirmation upsell.
7. Search, catch-up, tasks/intent, brain, access, account settings: reuse the same shell and row/form contracts. Inventory and migrate existing routes explicitly; these cannot disappear under the new navigation.

The specimen demonstrates conversation, thread replies, member filters and profiles, scope-specific removal confirmation, indexed/versioned knowledge, settings, connected/available agent directory, files, anchored menus, forms/dialogs, approval decisions, conversational onboarding, and toast. It is explicitly sample content. It makes **no** network mutations and does not establish backend readiness.

## Agent parity and refusal contract

Every released action maps to a registered MCP tool and a working CLI command with organization/workspace selectors, including membership, role, approval and wiki operations. Generate command examples from the implemented catalog; do not invent tool names in product copy. A refused action returns `{code, missing, scope, remedy_url, mcp_tool, cli_command}` and lists reachable choices for ambiguity. The UI renders that remedy in place and chat confirms owner actions.

Missing backend/tool parity is a release blocker for the affected action. The static component gallery labels its unavailable hierarchy command honestly; this placeholder must never ship as a live refusal. Presentation-only shell changes preserve current tool behavior and add no new privileged action.

## File ownership and rollout

Ownership follows the Argon lane's published `FILE-OWNERSHIP-KYLON-ORG-WIKI.md`; agreement sent back by cmux. CommonSwarm lead has been notified before app edits:

- Designer: this design system/specimen, new app-scoped theme/component stylesheet, shared visual primitives, shell integration and screenshot review.
- Argon hierarchy lead: schema/API/tool catalog and `live-dashboard/org-shell/*` (including org logo/name and switchers), `live-dashboard/wiki/*`. Consume this contract, provide snapshots for design review, request shared shell changes through the agreed integrator.
- CommonSwarm lead: permanent-connections implementation. No concurrent changes to its auth/session/connect logic.
- `LiveDashboard.astro` requires **one integrator per slice**. Feature lanes provide isolated modules/patches. Keep a file-ownership ledger and coordinate before edits. No blanket rewriting of the 14k-line component to obtain a visual change.

Rollout: (1) app-scoped shell/navigation styling preserving live routes/actions; (2) conversation, composer and threads; (3) roster/entity panels and agent setup; (4) brain/files/wiki; (5) settings/dialogs/empty/error states; hierarchy features join as independently functional slices. Each slice includes desktop/phone before/after, accessibility and behavior proof, Argon design + code `VERDICT: PASS`, relevant CI via pe-ci-1 and isolated staging proof. Exact SHA goes immediately to HezLead, who merges/releases. We never merge to main or deploy production.

Record uncertain observations and failures; no “pixel perfect” claim without matching screenshot comparison. A design PASS is not a production PASS.


## v0.3 executable repair contract

The canonical stylesheet has one token block and one set of layout/media rules. The flat specimen uses a 52px product rail, 390px contextual pane at >=1400px, 340px normally, 280px at <=1100px, and one flexible white working area. Main panel radius is zero. No static organization/workspace duplication appears in the desktop context pane. Organization plus current workspace stay together at top left and each opens an anchored popover. Phone drawer includes direct Settings and Components access, an internal close control, current route, focus containment and inert background.

Context changes with product mode: Chat lists channels/DMs; Members lists people/agents with real All/People/Agents filters; Knowledge lists versioned Markdown files; Connections provides directory guidance; Settings and Components show their own section links. A single main h1 and contextual actions replace the previous channel header on non-chat screens. The selected member profile demonstrates distinct provider/model, connection state, owner inheritance, multiple workspace grants and a separate role in another organization. Removal previews choose workspace or organization scope before an exact-name confirmation. They do not change live permissions.

Knowledge puts the index in the contextual pane, file size/version/search/download/actions in the working header, author/type/review/access metadata below it, and document content on white. Agent-assisted drafting opens beside the file content in a local contextual section. Versions and search honestly label their sample-only behavior. An actual product editor still needs version-conflict handling and tool parity.

Thread replies have a real local textarea. Desktop reserves a side column rather than covering the conversation; phone presents one full-screen dialog with inert background, Escape and focus return. Channel details use the same reachable contextual-panel pattern. Own messages use the warm gray surface; the olive primary is an independent CommonSwarm color choice informed by captures 33 and38, not extracted source CSS. Control boundary #7e887c replaces the earlier #879285 so it also clears3:1 on selected gray.

Additional authenticated reference captures32–44 cover room creation, membership/privacy/settings, role menu, empty files, stable phone conversation (43) and sandbox deletion confirmation. Captures are private study evidence, not exported assets. The specimen intentionally adapts Tom's Organizations > Workspaces > Channels hierarchy and explicit organization-vs-workspace removal wording; these are CommonSwarm requirements. It does not copy Kylon's account artwork, custom marks, exact questions, phone-call/billing flow, or transient phone double-render glitch. See DESIGN-REPAIR-01.md for evidence and material adaptations.


### Specimen-to-live shell token mapping

`design-system.css` uses `--cs-*` for the complete specimen contract. The first source slice uses `site/src/styles/kylon-tokens.css` and `kylon-shell.css` (local review checkout `app/site/src/styles/`), scoped exclusively to `live-dashboard.dashboard[data-kylon-shell]`. It preserves existing inner controls/statuses and grid topology. It does not import the specimen stylesheet into production.

| Component contract | First-slice shell token | Shared value / boundary |
|---|---|---|
| `--cs-surface` | `--k-shell-surface` | `#ffffff` in light |
| `--cs-subtle` | `--k-shell-subtle`, `--k-shell-hover` | `#f5f5f2` |
| `--cs-selected` | `--k-shell-selected` | `#eeefea` |
| `--cs-ink` | `--k-shell-ink` | `#282720` |
| `--cs-secondary` | `--k-shell-secondary` | `#655e53` |
| `--cs-muted` | `--k-shell-muted` | `#716b60` |
| `--cs-line` | `--k-shell-line` | `#e9e7e2` decorative edge |
| `--cs-control` | `--k-shell-control` | `#7e887c` identifying edge |
| `--cs-font` | `--k-shell-font` | Inter-first system fallback stack; specimen Inter is not bundled by current app PRs |
| `--cs-radius-sm` | `--k-shell-radius` | `6px` controls |
| row radius | `--k-shell-row-radius` | `8px` |
| `--cs-motion` | `--k-shell-motion` | `140ms`, disabled by reduced-motion preference |
| `--cs-space-*` | explicit first-slice shell padding/gaps | 4/8/12/16/20/24/32px; no global spacing override |
| Primary `--cs-accent` olive | preserved inner button/status tokens | Olive belongs to subsequent control migration; first shell slice does not recolor them |
| Specimen main title20px / toolbar15px | first-slice workspace/phone16px | Material adaptation to the current real app header; phone ellipsis prevents baseline four-line titles |
| Specimen52px + contextual pane | existing live Home grid | Functional hierarchy/topology migration remains with org-shell team |

The live source's focus token is kept explicit in its own reviewed shell module; v0.3 specimen focus olive is not silently propagated into first-slice production controls. The org lane should consume the final approved color/type/spacing mapping above for new components and request specific shared-file changes through the integrator. It must not create a divergent palette by copying obsolete v0.1 values or by copying specimen-only layout into the working app.

The current integration candidate uses one `kylon-shell.css` mount, importing `kylon-tokens.css` and the unchanged mechanically extracted `dashboard-frame.css`. Runtime modules stay <=4500tokens each. `specimen.html`, `specimen.js` and consolidated `design-system.css` demonstrate the broader static contract and must never be copied wholesale into the application repository. Subsequent production components remain independently scoped modules under the agreed ownership boundaries.


### Round2 state consistency and destructive controls

Destructive primary actions are an explicit component variant: `--cs-danger` background/border with white text, and `--cs-danger-hover` (`#842331`) on hover. A button carrying both `.primary` and `.danger` must not combine crimson text with an olive fill. The exact-name remove-confirm and archive dialogs are required accessibility capture states, including computed normal/hover text contrast.

Organization switching synchronizes identity name/initial, active workspace, roster roles, selected profile or phone landing list, and workspace settings input in one local render pass. Separate organization roles/grants are preserved; no stale role from the prior organization remains visible. Sample switching changes no account.

Toasts sit at the top of the specimen; phone toasts start below the64px header so neither the close control nor the bottom reply action is covered. Anchor-style `.button` links explicitly use the same ink as native buttons. See round2 regression evidence in `evidence/repair-02/` and its saved rerun script.
