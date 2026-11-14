# CommonSwarm mobile source inventory

Baseline: `b86e0d76395c9a0ae04b8548fd39585e9ee093b1`. Source inspection only, 2026-11-03. No rendered coverage, visual failures, authenticated access, tests, builds, API calls or production activity are asserted.

Owners: Product Lead sets priorities; Engineer owns the simulated seed and CI harness; Designer owns this inventory, screenshot review, visual fixes and the ranked `FIX-LIST.md` after the first artifact run.

**Status vocabulary:** SC = source-confirmed implementation; HR = harness reachability/fixture still required; F = future, not implemented. All SC entries remain HR until an actual CI capture demonstrates the surface. Do not count DOM existence or a test filename as rendered coverage.

Baseline source-confirmed coverage totals: R01–R17 (17 routes), V01–V26 (26 app/state families), D01–D14 (14 dialog definition families: 11 static + 3 dynamic), M01–M15 (15 menu/overlay presentations; some deliberately overlap V/D at different anchors). IDs count inventory units, not unique DOM nodes. D15 records the restored outer People & agents modal added on 2026-11-11.

## Required capture matrix and seed

For each reachable screen/state use 360×740, 390×844, 430×932, 844×390, 768×1024, 1024×1366. Capture both light and dark for every item (record unsupported mode explicitly rather than silently skipping); capture keyboard focus, open/closed overlays, keyboard-visible viewport and long scroll. CI checks horizontal overflow, 44px controls, clipping, internal modal scroll, safe area, focus entry/return and keyboard obscuring inputs. Native inputs/selects need platform witness where emulation differs.

Seed one dense workspace (12 long-named agents, 5 people, mixed providers/avatars/status), a second workspace with different permissions and an empty workspace. Hundreds of messages across public channels, DM and group channels; threads/attachments; every to-do state; >50 list objects and file/topic versions; pending invites and confirmations; read-only/owner/member accounts; long unbroken strings and Unicode. Force read pending/failure/refusal and uncertain write outcomes independently. All identities, messages, filenames, credentials and invite tokens must be disposable simulation data. Never invoke real providers or contact invitees.

## Routes (all source files under pages)

17 Astro routes, zero API endpoint modules under `site/src/pages`: 14 ordinary screens (including /app), one browser compatibility handoff, two static diagnostic callback documents. Static public files and hosted OAuth are separate coverage, below.

| ID | Route | Kind | Source | Rendered composition | States/data |
| --- | --- | --- | --- | --- | --- |
| R01 | /acceptable-use | SC screen | `site/src/pages/acceptable-use.astro:182` | Base, LegalDoc | Default; long scroll; header mobile menu; footer; keyboard links; code/table overflow where present |
| R02 | /alternatives/crewai | SC screen | `site/src/pages/alternatives/crewai.astro:58` | SeoPage | Default; long scroll; header mobile menu; footer; keyboard links; code/table overflow where present |
| R03 | /alternatives/langgraph | SC screen | `site/src/pages/alternatives/langgraph.astro:58` | SeoPage | Default; long scroll; header mobile menu; footer; keyboard links; code/table overflow where present |
| R04 | /app | SC screen | `site/src/pages/app.astro:18` | HumanInvitationInbox, Base, LiveDashboard, AdminDelegations, Toast | All V/D/M entries below; session, permissions and network scenarios |
| R05 | /download | SC screen | `site/src/pages/download.astro:66` | Base, InstallPanel, WhatHappens, OtherWays, AfterInstall | Platform-specific install choice, command copy success/failure, manual alternatives, detailed instructions; no actual installation |
| R06 | /guides/claude-code-subagents | SC screen | `site/src/pages/guides/claude-code-subagents.astro:32` | SeoPage | Default; long scroll; header mobile menu; footer; keyboard links; code/table overflow where present |
| R07 | /guides/claude-connector | SC screen | `site/src/pages/guides/claude-connector.astro:30` | SeoPage | Default; long scroll; header mobile menu; footer; keyboard links; code/table overflow where present |
| R08 | /guides/grok-bot | SC screen | `site/src/pages/guides/grok-bot.astro:29` | SeoPage | Default; long scroll; header mobile menu; footer; keyboard links; code/table overflow where present |
| R09 | / | SC screen | `site/src/pages/index.astro:11` | Base, ConsumerHero, ConsumerStory | Hero, preview tabs/checkboxes, workflow examples, connection choices, footer; all CTA links; initial fonts; long labels |
| R10 | /invite | SC screen | `site/src/pages/invite.astro:9` | Base, InviteOnramp | Loading, unusable, auth, sender, review, joining, join-error, connect, complete; long inviter/workspace names; editor/viewer choice; consent; expiry/revocation |
| R11 | /oauth/c1-controls/callback | SC static diagnostic document (not API) | `site/src/pages/oauth/c1-controls/callback.astro:10` | bare HTML | Bare copy; noindex/no-referrer; no real code/token/query values; do not run OAuth |
| R12 | /oauth/c1-smoke/callback | SC static diagnostic document (not API) | `site/src/pages/oauth/c1-smoke/callback.astro:10` | bare HTML | Bare copy; noindex/no-referrer; no real code/token/query values; do not run OAuth |
| R13 | /orchestration | SC screen | `site/src/pages/orchestration.astro:30` | SeoPage | Default; long scroll; header mobile menu; footer; keyboard links; code/table overflow where present |
| R14 | /privacy | SC screen | `site/src/pages/privacy.astro:307` | Base, LegalDoc | Default; long scroll; header mobile menu; footer; keyboard links; code/table overflow where present |
| R15 | /start | SC compatibility handoff | `site/src/pages/start.astro:18` | Base | Automatic /app redirect preserving query/hash; JS-disabled manual link; fake parameters only |
| R16 | /support | SC screen | `site/src/pages/support.astro:6` | Base | Default; long scroll; header mobile menu; footer; keyboard links; code/table overflow where present |
| R17 | /terms | SC screen | `site/src/pages/terms.astro:300` | Base, LegalDoc | Default; long scroll; header mobile menu; footer; keyboard links; code/table overflow where present |


## Native dialog inventory

The November 3 baseline comprises 11 static declarations and 3 dynamic families; D15 adds the restored outer People & agents modal. Counts are definitions, not instances: role-change confirmations can repeat per member.

| ID | Surface | Source | Selector | Opening trigger (SC; HR for end-to-end) | Required states |
| --- | --- | --- | --- | --- | --- |
| D01 | Public menu | `site/src/components/SiteHeader.astro:130` | [data-menu] / #site-menu | [data-menu-open] → [data-menu]; close [data-menu-close] | All links; long viewport scroll; close/backdrop/Escape/focus return |
| D02 | Workspace settings | `site/src/components/app/LiveDashboard.astro:897` | [data-workspace-details-popover] | [data-workspace-settings-item] | owner/member; access list; long name/ID; destructive close confirmation text; pending/error |
| D03 | Channels | `site/src/components/app/LiveDashboard.astro:925` | [data-channel-dialog] | channel toolbar/menu; inspect data-channel-* hooks | many channels; create/rename/archive; validation/refusal; archived selected channel |
| D04 | Connected apps | `site/src/components/app/LiveDashboard.astro:997` | [data-connected-apps-dialog] | [data-connected-apps-open] | loading/empty/failure/retry; many connections/seats; revoke pending/refusal |
| D05 | Sign out other devices | `site/src/components/app/LiveDashboard.astro:1017` | [data-signout-others-dialog] | [data-signout-others-open] (conditional hidden) | cancel, confirm pending/error/success; simulation only; auth-sensitive |
| D06 | Your agents | `site/src/components/app/LiveDashboard.astro:1035` | [data-account-agents-dialog] | [data-account-agents-open] | empty/dense/failure/retry; reconnect one-time-code display; no live tokens |
| D07 | Cmd+K | `site/src/components/app/LiveDashboard.astro:1046` | [data-command-palette] | [data-command-palette-open], Cmd/Ctrl+K | empty query, grouped dense results, no result, long query/names; arrows/Enter/Escape; IME keyboard |
| D08 | Workspace skills | `site/src/components/app/LiveDashboard.astro:1077` | [data-workspace-skills-dialog] | Cmd+K action type=open-skills (`LiveDashboard.astro:10613`); agent profile routines onOpenSkills (`:3075`) | empty/dense/loading/error; Read/Refresh, Add skill, Delete, Keep/Dismiss; viewer vs editor; max body; no edit control confirmed. `workspace-skills-view.ts:18–78`. Native sample mode deliberately empty/read-only (`LiveDashboard.astro:10531–10551`); Engineer fixture required for dense/editor states |
| D09 | People destructive confirmation | `site/src/components/app/LiveDashboard.astro:1109` | [data-people-confirm] | people actions via people-dialog-view.ts | remove/revoke confirmation; long name; busy/refused; return to originating row |
| D10 | Admin access/history | `site/src/components/app/AdminDelegations.astro:11` | admin-delegations dialog | [data-admin-indicator] / [data-admin-access-open] conditional | closed/open issuance notice; account/workspace tab; dense grants/clients/actions; revoke/approval error; paginate; mock only |
| D11 | Invitation review | `site/src/components/invite/HumanInvitationInbox.astro:64` | human-invitation-inbox [data-review-dialog] | Review invitation card | long audience/disclosure; viewer/editor choices; join-as-self; pending/expired/refused; focus return |
| D12 | Navigation drawer | `site/src/lib/kylon-shell/shell.js:88` | .cs-org-drawer | button[aria-label="Open navigation"] | mobile only; account/org/workspace switch; dense agents; close/resize/focus/inert; same nodes move |
| D13 | Details sheet | `site/src/lib/kylon-shell/channel-details.ts:9` | .cs-details-sheet | [data-channel-details-toggle] | phone sheet vs desktop side pane; person/agent/entity selection; long details; close/back/Escape |
| D14 | Own-role lowering confirmation | `site/src/lib/people-dialog-view.ts:362` | .hm-role-confirm / [data-role-confirm] | own role select + Save | cancel/confirm, refusal/busy, focus restoration; disposable owner only |
| D15 | People & agents outer modal | `site/src/components/app/LiveDashboard.astro` | dialog[data-roster-dialog] | existing roster/person doors; cold ?v=people | dense roster; desktop columns/phone sheet; selected detail; accepted receipt; native nested confirmation; Esc/opener return; workspace/route/sign-out retirement |


## App screens and state families

| ID | Screen/state family | Source | Route / hook | Required seed/state |
| --- | --- | --- | --- | --- |
| V01 | Gateway | `site/src/components/app/LiveDashboard.astro:70` | /app; [data-panel=loading\|signed-out\|create\|workspace-error] | load; provider availability; email invalid/sending/sent/error; dead session; workspace read retry; no memberships |
| V02 | Catch up | `site/src/lib/home-route.ts:1` | /app?v=catchup | empty, dense cross-workspace unread/mentions, pending/error; latest-work link and narrow cards |
| V03 | New workspace | `site/src/components/app/LiveDashboard.astro:163` | /app?v=new; new-workspace button | purpose options shared/personal, long name, invalid/duplicate, creating/refused/unknown outcome; first-run vs existing workspace |
| V04 | Chat/channel | `site/src/components/app/LiveDashboard.astro:539` | /app?w=W&c=C; [data-channel-view=feed] | no agents; feed-pending/empty/error; hundreds of rows; grouped author; receipts all outcomes; pagination; unread marker; selected message |
| V05 | DM/group chat | `site/src/lib/home-route.ts:4` | chat route and participant actions | self/other DM, group roster, no access/archived, long titles; composer and history |
| V06 | Thread | `site/src/components/app/LiveDashboard.astro:6942` | Reply/thread toggle in feed | empty/dense replies; composing/failed/unknown send; pending; long Markdown, attachment; parent context |
| V07 | Composer | `site/src/components/app/LiveDashboard.astro:731` | [data-composer] | recipient chips; @ mention picker; keyboard; attachments pending/failed; paste/images; long input; sending/retry/draft preserved on view switch |
| V08 | People & agents native modal | `site/src/lib/people-dialog-view.ts:259` | /app?w=W&v=people opens `dialog[data-roster-dialog]` over the workspace; [data-people-detail] | 12 agents/5 people; owner grouping; names/email wrap; invite actions; role controls; removed/offline/working states; detail selection |
| V09 | Agent detail/work | `site/src/lib/home-route.ts:6` | /app?w=W&agent=A | assigned work/dense queue; unavailable/refused/removed; edit model/name, reconnect/revoke via supported controls |
| V10 | To-dos list | `site/src/lib/home-todo-list.ts:11` | /app?w=W&v=todos | pending/empty/dense; all state filters; adding; long title/assignees; refused access; retry |
| V11 | To-do detail | `site/src/lib/home-route.ts:5` | /app?w=W&todo=T | state transitions, dependencies/queue, comments/@picker, assignee picker; draft edits; not found; permissions; unknown write |
| V12 | Lists & docs | `site/src/lib/household-objects-view.ts:182` | /app?w=W&v=lists; [data-household-objects] | access consent pending/refused; list/doc index empty/dense; editable/view-only; long items/markdown; add/remove/toggle/save; revisions |
| V13 | Retained draft/conflict comparison | `site/src/lib/household-objects-view.ts:163` | conflicting save / [data-hh-action] | base/current/proposed long comparison; review checkbox; recovered/refused/unknown draft; narrow stacked columns; history pagination |
| V14 | Files | `site/src/lib/file-list.ts:82` | /app?w=W&v=files; [data-file-list] | pending/empty/error/retry/stale; long filename/MIME/size/uploader; many versions; download failure; no access |
| V15 | Wiki/topic reader | `site/src/lib/brain-view.ts:79` | /app?w=W&v=wiki; [data-brain-detail] | index empty/dense; selected long Markdown/table/code; raw toggle; version history; pending/timeout/retry; missing topic |
| V16 | Wiki editor | `site/src/lib/brain-view.ts:207` | [data-brain-edit], [data-brain-form] | long editable text with keyboard; unsaved draft; save busy/error/unknown; permission loss; switched topic/workspace |
| V17 | Agent connection chooser | `site/src/components/connect/AgentHostPicker.astro:52` | /app?w=W&v=add-agent; [data-channel-view=agent-choice] | provider choice; self vs teammate; supported/preview labels; existing/new agent |
| V18 | Agent connect procedure | `site/src/components/connect/AgentConnect.astro:69` | [data-channel-view=connect] / agent-connect | loading/blocked/form/working/result; name validation; prompt copy; waiting/joined; error/reset; one-time secret fake only |
| V19 | Invite person/link | `site/src/components/app/LiveDashboard.astro:422` | [data-channel-view=invite] | email/name inputs; invalid/pending/success/expired link; viewer/editor; fake invitees only |
| V20 | Workspace/entity side detail | `site/src/components/app/LiveDashboard.astro:869` | [data-entity-panel], [data-home-side-slot] | member/agent/message entity; dense activity/access; mobile sheet; empty/refusal; close and retained main selection |
| V21 | Invitation inbox overlay | `site/src/components/invite/HumanInvitationInbox.astro:41` | [data-invitations], [data-failure], [data-joined] | 0 hidden; many cards; checking failed/retry/dismiss; joined CTA; create-screen flow vs composer clearance |
| V22 | Update and toast | `site/src/components/app/LiveDashboard.astro:1113` | [data-update-notice], Toast component | new build notice, dismiss/reload with draft; success/error toast and keyboard; safe area/composer overlap |


## Menus, popovers and inline disclosures (not new route/dialog counts)

| ID | Surface | Source | Trigger/hook | Required states |
| --- | --- | --- | --- | --- |
| M01 | Account/org menu | `site/src/components/app/LiveDashboard.astro:258` | [data-user-menu-trigger] → [data-user-menu]; [data-org-menu] | many orgs; theme submenu/actions; mobile drawer anchor; long account name; missing controls by permissions |
| M02 | Workspace action menu | `site/src/lib/home-shell.ts:261` |  .hm-menu__trigger → .hm-menu__list | settings/invite/skills/admin actions; dense links; keyboard arrows/Escape and focus return |
| M03 | Channel menu | `site/src/lib/home-shell.ts:462` | .hm-channel-menu__panel / [data-channel-list] | many channels, unread badges, long slugs, create/manage actions; HR exact trigger |
| M04 | Assignee picker | `site/src/lib/home-pickers.ts:195` | [data-assign-picker] → [data-picker-pop] | 12 agents grouped by owner; unavailable/removed; search/no matches; selection chips; keyboard |
| M05 | Mention/tag picker | `site/src/lib/home-pickers.ts:338` | @ in to-do comment; composer own mention listbox | many matches, long labels, active descendant, empty result, input near bottom/keyboard; no forced full-screen menu |
| M06 | Receipt disclosure | `site/src/components/app/LiveDashboard.astro:6133` | .dashboard__message-receipt > summary | closed/open; seen/delivered/no-recipient/failed/unavailable; long recipient names; >50 recipient truncation; Reply same row |
| M07 | Wiki version disclosure | `site/src/components/app/LiveDashboard.astro:684` | .dashboard__brain-history > summary | many versions, long updater names, selected older revision, keyboard/open edge |
| M08 | Member row actions | `site/src/lib/people-dialog-view.ts:259` | .pd-* action controls; exact generated selector HR | owner/member variants; remove/revoke/role/model actions; dense row overflow |
| M09 | Provider picker and result disclosure | `site/src/components/connect/AgentHostPicker.astro:52` | agent-host-picker; buttons generated per host | long host names; device method choice; instructions, copy failure/result; preview distinction |
| M10 | Landing interactive preview | `site/src/components/landing/WorkspacePreview.astro:7` | [data-preview-tab], [data-open-preview], [data-example-item] | all tabs, synchronized checkboxes, narrow scrolling, long text; not real backend data |
| M11 | Download install disclosures | `site/src/components/download/InstallPanel.astro:6` | platform controls and details/summary within InstallPanel | all OS instructions, copied/error commands, long command line; HR selector mapping |
| M12 | Workspace resize separators | `site/src/lib/kylon-shell/resizers.ts:208` | .cs-resizer | five separators; small viewport clamps, keyboard/reset, orientation; not tooltips or dialogs |



### Additional source-confirmed views and menus from Track 1A

| ID | Surface | Source / trigger | Required states and data |
| --- | --- | --- | --- |
| V23 | Definitions index/create/read | `site/src/lib/workspace-definitions-view.ts:124`; `.household-definitions`, `[data-def-action=select]`, `[data-def-action=new]`; mounted by `household-dashboard.ts:110` in Lists | loading/empty/error/dense; Proposed, Certified, Proposal pending; search no match; 80-character terms; 2,000-character meaning/source; editor vs reader; create pending/refusal |
| V24 | Definitions proposal diff/certify | `site/src/lib/workspace-definitions-view.ts:176`; `[data-def-diff]`, `[data-def-certify-bar]` | certified/current comparison; long unbroken source; stale revision; human certification; permission refusal; keyboard-visible review; `[data-def-action=certify]` at :200, update form Save changes at :218; create/cancel/select at :127–155 |
| V25 | Inline to-do offer | `site/src/lib/home-stream-approvals.ts:34`; `[data-offer-card]`, `[data-offer-answer]` in Chat | pending offer, accept/refuse, busy, already answered, wrong decider; long todo/agent name; no actual production mutation |
| V26 | Lists agent approval prompt | `site/src/components/app/LiveDashboard.astro:615`; `[data-household-agents]`, `[data-household-agent-list]` | no agents, 12 agents, approval absent/present/revoked; consent prerequisites; owner vs viewer; request pending/refused |
| M13 | Context menu | `site/src/lib/context-menu.ts:23`; `.cs-context-menu`; `contextmenu` bound only on Direct messages rail rows (`site/src/lib/home-rail.ts:198`, `:215`); message rows have none | mouse right-click, Shift+F10/Menu key; touch long-press requires harness/platform witness; viewport edge, many long entries; Escape/Tab/arrow focus return |
| M14 | Workspace header menu dock | `site/src/lib/kylon-shell/host.ts:123`; `.cs-kylon-workspace-menu .hm-menu__trigger` | same semantic menu as M02, distinct relocated mobile anchor; open above keyboard and near screen edge; no duplicate focusable menu |
| M15 | Profile inspector | `site/src/components/app/LiveDashboard.astro:868`; `.hm-frame__profile[data-entity-panel]` | same entity detail as V20, separately capture phone/landscape open inspector and close; 12-agent dense metadata; retained selection |

No `/connect` page exists under `site/src/pages` at this baseline: connection is V17/V18 inside `/app` and part of `/invite`. Do not manufacture a route from the order's example list.

State codes for manifest joins: `L` loading; `E` empty; `X` read/network error; `D` dense success; `P` permission/refusal; `B` busy write; `U` uncertain write; `C` conflict/retained draft; `K` keyboard/input viewport; `O` open overlay; `R` recovery/retry. Apply L/E/X/D to each surface where meaningful; otherwise record N/A with source reason (e.g. static legal page). Auth and destructive controls remain simulation-only.

## Inventory gaps and exclusions requiring explicit harness disposition

- **F01 CS-E17 Account dialog:** future scope. Current source has account menu, Connected apps, Your agents and sign-out-other-devices confirmation, not a unified Account/password-management dialog. PR #271 CS-E17 A is separate pending work; Account PR B is future. Password sign-in is not in this baseline. Do not fabricate a reachable screen or capture the menu as completion of CS-E17.
- **HR01** generated selectors, gate-hidden admin surfaces, invitation state machine, owner-only controls and provider settings require Engineer’s seed/harness mapping; entries marked HR are not evidence of functioning routes.
- **HR02** account/device/auth actions use disposable simulated sessions only; no production auth, real provider OAuth or actual recipient delivery. Sign-in or access changes require HezSec under the plan.
- **HR03** hosted OAuth pages live in `services/mcp-auth/src/{interaction-page,admin-interaction-page,finish-page}.js`, outside pages. If “every sign-in screen” includes these, use pure render fixtures for provider choice/consent/locked/error/finish/admin; list them as a separate service family, not Astro routes.
- **HR04** static public endpoints (`llms.txt`, `api.md`, installers, manifests, brand/fonts) are not screen routes. Confirm their HTTP/download integrity separately; no visual screenshots required for binary/JSON payloads.
- **HR05** native select menus, browser-native titles, permission dialogs, real on-screen keyboard and safe-area behavior require platform checks beyond desktop emulation.

## Existing fixture sources (availability, not executed coverage)


- `site/scripts/provider-fixtures.ts`

- `site/src/components/app/admin-delegations.fixture.ts`

- `site/src/components/app/brain-view.fixture.ts`

- `site/src/components/app/file-list.fixture.ts`

- `site/src/components/app/home-fixture.ts`

- `site/src/components/app/workspace-file-reads.fixture.ts`

- `site/src/lib/home/fixtures.ts`

- `site/src/lib/message-markdown-fixtures.ts`


## Source evidence appendix: declared panels/views and dialogs

These exact declarations supplement stable IDs above; use them to match harness state selectors without assuming visibility. Line numbers bind only to baseline.


### `site/src/components/app/LiveDashboard.astro`

| Line | Declaration |
| --- | --- |
| 70 | `<section class="dashboard__loading" data-panel="loading" role="status" aria-live="polite" aria-busy="true">` |
| 80 | `data-panel="signed-out"` |
| 163 | `data-panel="create"` |
| 218 | `data-panel="workspace-error"` |
| 246 | `<section class="dashboard__product" data-panel="channel" hidden>` |
| 278 | `<div data-org-menu></div>` |
| 308 | `<div data-home-channel-menu></div>` |
| 369 | `<section class="dashboard__channel-empty dashboard__setup" data-channel-view="no-agents" data-setup-checklist>` |
| 418 | `<section class="dashboard__connect-view dashboard__choice-view dashboard__host-view" data-channel-view="agent-choice" hidden>` |
| 422 | `<section class="dashboard__connect-view dashboard__invite-view" data-channel-view="invite" hidden>` |
| 478 | `<section class="dashboard__connect-view" data-channel-view="connect" hidden>` |
| 495 | `data-channel-view="feed-pending"` |
| 511 | `<section class="dashboard__feed-state" data-channel-view="feed-empty" hidden>` |
| 525 | `data-channel-view="feed-error"` |
| 539 | `<section class="dashboard__feed-view" data-channel-view="feed" hidden>` |
| 570 | `<section class="dashboard__objects-view" data-channel-view="objects" aria-labelledby="dashboard-lists-title" hidden>` |
| 629 | `<section class="dashboard__files-view" data-channel-view="files" hidden>` |
| 640 | `<section class="dashboard__brain-view" data-channel-view="brain" aria-labelledby="dashboard-wiki-title" hidden>` |
| 897 | `<dialog` |
| 925 | `<dialog` |
| 997 | `<dialog` |
| 1017 | `<dialog` |
| 1035 | `<dialog data-account-agents-dialog aria-labelledby="dashboard-account-agents-title">` |
| 1046 | `<dialog` |
| 1077 | `<dialog` |
| 1109 | `<dialog class="pd-confirm" data-people-confirm role="alertdialog" aria-labelledby="pd-confirm-title" aria-describedby="pd-confirm-description"></dialog>` |
| 1492 | `* Top-level dashboard panels only. AgentConnect reuses data-panel=… for its own` |
| 1500 | `app.querySelector<HTMLElement>(`.dashboard__root > [data-panel="${name}"]`);` |


### `site/src/components/invite/InviteOnramp.astro`

| Line | Declaration |
| --- | --- |
| 42 | `<section class="invite-onramp__panel" data-view="loading" role="status" aria-live="polite">` |
| 47 | `<section class="invite-onramp__panel invite-onramp__card" data-view="unusable" hidden>` |
| 56 | `<section class="invite-onramp__panel invite-onramp__card" data-view="auth" hidden>` |
| 81 | `<section class="invite-onramp__panel invite-onramp__card" data-view="sender" hidden>` |
| 89 | `<section class="invite-onramp__panel invite-onramp__card" data-view="review" hidden aria-labelledby="invite-review-title">` |
| 173 | `<section class="invite-onramp__panel" data-view="joining" hidden role="status" aria-live="polite">` |
| 178 | `<section class="invite-onramp__panel invite-onramp__card" data-view="join-error" hidden>` |
| 188 | `<section class="invite-onramp__connect hm-invite-connect" data-view="connect" hidden>` |
| 220 | `<section class="invite-onramp__panel invite-onramp__card" data-view="complete" hidden>` |
| 309 | `const heading = one<HTMLElement>(`[data-view="${name}"] h1, [data-view="${name}"] h2`);` |
| 582 | `for (const node of host.querySelectorAll<HTMLElement>('[data-view="connect"] [data-workspace]')) {` |
| 822 | `one<HTMLElement>('[data-view="review"]')?.addEventListener("change", () => {` |
| 928 | `.invite-onramp:has(> [data-view="connect"]:not([hidden])) {` |
| 1264 | `.invite-onramp__panel[data-view="review"] {` |
| 1268 | `[data-view="review"] > .invite-onramp__title { margin-block-start: 18px; }` |
| 1278 | `[data-view="review"] > .invite-onramp__choices { margin-block-start: 22px; }` |
| 1279 | `[data-view="review"] > .invite-onramp__choices + .invite-onramp__choices { margin-block-start: 26px; }` |
| 1280 | `[data-view="review"] > .invite-onramp__facts { margin-block-start: 22px; }` |


### `site/src/components/connect/AgentConnect.astro`

| Line | Declaration |
| --- | --- |
| 69 | `<div class="ac__panel" data-panel="loading">` |
| 73 | `<div class="ac__panel ac__panel--state" data-panel="state">` |
| 81 | `<form class="ac__panel ac__form" data-panel="form" data-has-agents="no">` |
| 166 | `<div class="ac__panel" data-panel="working">` |
| 183 | `<div class="ac__panel ac__result" data-panel="result">` |
| 371 | `this.#q<HTMLFormElement>('[data-panel="form"]')?.addEventListener("submit", (event) => {` |
| 645 | `const form = this.#q<HTMLElement>('[data-panel="form"]');` |
| 1104 | `.ac[data-state="loading"] [data-panel="loading"],` |
| 1105 | `.ac[data-state="blocked"] [data-panel="state"],` |
| 1106 | `.ac[data-state="ready"] [data-panel="form"],` |
| 1107 | `.ac[data-state="working"] [data-panel="working"],` |
| 1108 | `.ac[data-state="done"] [data-panel="result"] {` |


### `site/src/components/invite/HumanInvitationInbox.astro`

| Line | Declaration |
| --- | --- |
| 12 | `*   the review   a centered modal <dialog> (a bottom sheet on a phone) with the same content as` |
| 64 | `<dialog class="human-invitations__dialog" data-review-dialog aria-labelledby="human-invitations-review-title">` |


### `site/src/components/SiteHeader.astro`

| Line | Declaration |
| --- | --- |
| 17 | `* panel is a real <dialog> opened with showModal(), which buys the focus trap, the Escape` |
| 130 | `<dialog class="mnav" id="site-menu" aria-label="Menu" data-menu>` |
| 562 | `/* <dialog> ships with width/height: fit-content and margin: auto. All four are reset` |

## Manifest crosswalk and current capture limits

`screens.json` is a bare-array coverage map for the Engineer runner. A runnable entry identifies a capture candidate; the CI evidence union below records which candidates were captured. `pending` entries are skipped and reported with their reasons. State labels are runner context labels and do not create seed data. For populated views, readiness must establish visible content; the generic dense label on sign-in, dialogs and static captures does not claim dense simulated content. Other empty, error and loading captures need per-surface fixture support; the generic `state.empty`, `state.error` and `state.loading` placeholders were retired (see Manifest closure below). The single listed entry for a family does not cover every state, interaction or permission in the inventory above.

The starter IDs are preserved. Channel paths use confirmed IDs, not slugs; DM is pending until the phone drawer and rail identity are confirmed. Definitions index is separate from proposed, certified, proposal-pending and diff captures; Wiki index is separate from topic and editor captures. Definitions detail captures use bound seed identities and selected-state readiness; Wiki detail and editor remain pending. Public and diagnostic route candidates have source-backed readiness; the tokenless invitation candidate uses a signed-out context. The /start handoff redirects immediately with JavaScript on, so `route.start` captures it with JavaScript off (its `<noscript>` note and manual link). Invitation variants and native-platform behavior need their own support. The runner checks readiness after setup. The CI evidence union below records capture success and its limits.

| Inventory unit | Manifest disposition |
| --- | --- |
| R01 | `route.acceptable-use` — candidate; other states pending |
| R02 | `route.alternatives.crewai` — candidate; other states pending |
| R03 | `route.alternatives.langgraph` — candidate; other states pending |
| R04 | `app.signin` — app families below; candidate sign-in |
| R05 | `route.download` — candidate; other states pending |
| R06 | `route.guides.claude-code-subagents` — candidate; other states pending |
| R07 | `route.guides.claude-connector` — candidate; other states pending |
| R08 | `route.guides.grok-bot` — candidate; other states pending |
| R09 | `route.home` — candidate; `route.home.footer`, `route.home.footer.guides-end` and `route.home.footer.legal-end` provide separate scrolled footer candidates |
| R10 | `route.invite` — candidate; other states pending |
| R11 | `route.oauth.c1-controls.callback` — candidate; other states pending |
| R12 | `route.oauth.c1-smoke.callback` — candidate; other states pending |
| R13 | `route.orchestration` — candidate; other states pending |
| R14 | `route.privacy` — candidate; other states pending |
| R15 | `route.start` — JavaScript-off candidate: `/start?next=audit` in a signed-out context with scripts disabled, ready on the manual link and its `<noscript>` note; the automatic redirect with JavaScript on is not captured |
| R16 | `route.support` — candidate; other states pending |
| R17 | `route.terms` — candidate; other states pending |
| V01 | `app.signin` — candidate; other states pending |
| V02 | `app.catchup` — pending |
| V03 | `app.workspace-new` — pending |
| V04 | `app.chat.general` — candidate; other states pending |
| V05 | `app.chat.group` — candidate; other states pending |
| V06 | `app.thread` — pending |
| V07 | `app.composer` — pending |
| V08 | `app.people` — candidate; other states pending |
| V09 | `app.agent` — candidate; `app.agent.queue` and `app.agent.queue.not-yet` candidates (Up next and Not yet each scrolled into frame): seeded `{agent}` with four Up next and two Not yet to-dos (`seed_agent_queue`: a hold with a note and one after another to-do); other states pending |
| V10 | `app.todos` — dense candidate; `app.todos.empty` candidate with required seed grant |
| V11 | `app.todo-detail` — candidate; `todo_create 0` required |
| V12 | `app.lists` — dense candidate; `app.lists.empty` candidate with required seed grant |
| V13 | `app.list-conflict` — candidate: the owner edits the seeded `{conflictDoc}` doc in `{workspace}` (never `house-notes`), the runner saves one more revision from outside the page, and the page's save meets it; Recover my draft opens the three-way comparison, scrolled into frame. Save reviewed changes is never clicked. Before each capture opens it the doc is reset to a fixed base text, and the outside save writes a fixed current text, so the comparison is the same at every size and theme; each capture leaves one retained draft |
| V14 | `app.files` — populated pending; `app.files.empty` candidate |
| V15 | `app.wiki` — populated pending; `app.wiki.empty` candidate |
| V16 | `app.wiki.editor` — candidate (`app.wiki-editor` superseded duplicate removed) |
| V17 | `app.agent-chooser` — candidate; `app.add-agent.existing` existing-agent picker candidate on `{emptyWorkspace}` |
| V18 | `app.agent-connect` — pending |
| V19 | `app.invite-person` — pending |
| V20 | `app.entity-detail` — pending |
| V21 | `app.invitation-inbox` — candidate, as a second viewer: a member of `{workspace}` who holds one delegated invitation to `{inviteWorkspace}` (issued by the admin person through the real admin routine), so the inbox is the corner card above the composer (`data-placement="corner"`), not the create-screen placement. Many cards, failure/retry and joined states stay pending |
| V22 | `app.update-toast` — candidate; `[data-update-notice]` over `#general`, raised by the app's own boot poll answered with the served page plus one extra `/_astro/` asset (`newBuild`); Update and Not now never pressed; Toast pending |
| V23 | `app.definitions` — scrolled index candidate; proposed, certified and proposal-pending candidates have separate guarded captures |
| V24 | `app.definitions.diff` — guarded scrolled proposal comparison candidate (`app.definitions-diff` superseded duplicate removed) |
| V25 | `app.todo-offer` — candidate; `{offerWorkspace}` (its own workspace, so the card floats over no other capture) with one owner agent, a member's pending offer to the owner, both with Lists consent, and two notes so the feed shows; `[data-offer-card="{todo.offer}"]` with its answer buttons; Accept and Decline never pressed |
| V26 | `app.lists-approval` — candidate: in `{approvalWorkspace}` (its own workspace), the owner's local agent `{approvalAgent}` has a live connection and no Lists approval; the People dialog's Allow lands on Lists; after its reads settle the approval card is scrolled into view and must be wholly in the viewport at capture (`frame`). The approval is never submitted |
| D01 | `dialog.public-menu` — pending |
| D02 | `dialog.workspace-settings` — pending; the seed sets who can create channels to the policy that is not the default (`channel_policy`), and the capture requires that group, with "Owners & admins" checked, to be on screen (the last choice is listed first: the runner scrolls the first part that is out of view to the nearest edge, and on a short screen that must be the bottom one) |
| D03 | `dialog.channels` — pending |
| D04 | `dialog.connected-apps` — candidate with responsive drawer setup |
| D05 | `dialog.signout-others` — candidate with responsive drawer setup |
| D06 | `dialog.account-agents` — candidate with responsive drawer setup |
| D07 | `dialog.command-palette` — candidate; other states pending |
| D08 | `dialog.workspace-skills` — candidate; other states pending |
| D09 | `dialog.people-confirm` — pending |
| D10 | `dialog.admin-access` — candidate; native `dialog.sa-confirm[data-seat-admin-confirm="workspace"]` opened from seeded Atlas `[data-seat-admin-toggle="workspace"]` (confirm phase only, grant never submitted); `AdminDelegations` history/recovery states pending |
| D11 | `dialog.invitation-review` — candidate: the same second viewer opens Review; the preview loads and Join is never clicked, so the invitation stays unconsumed. Keyboard witness: Tab reaches the first role and then the join-as-self checkbox, which must be shown above the Join bar; Escape closes the dialog and returns focus to Review |
| D12 | `dialog.navigation-drawer` — pending |
| D13 | `dialog.details-sheet` — candidate: phone sheet and desktop details pane |
| D14 | `dialog.role-confirm` — candidate; seeded owner's own row `#pd-person-{owner}` in the People & agents modal, role select set to Member, Save opens `dialog[data-role-confirm]` (confirm phase only, never submitted) |
| D15 | `dialog.password` — candidate with responsive drawer setup |
| M01 | `menu.account` — candidate with responsive drawer setup |
| M02 | `menu.workspace` — candidate with responsive drawer setup |
| M03 | `menu.channels` — pending |
| M04 | `menu.assignee` — pending |
| M05 | `menu.mention` — pending |
| M06 | `menu.receipt` — candidate; seeded `{message.addressedOwn}` with its `<details class="dashboard__message-receipt">` opened in `#general`: a card over the message, from the row's floating tool bar when the receipt is settled and from its avatar badge when it is a problem |
| M07 | `menu.wiki-version` — pending |
| M08 | `menu.member-actions` — candidate; seeded Atlas agent row disclosure only, no action |
| M09 | `menu.provider` — pending |
| M10 | `menu.landing-preview` — candidate; other states pending |
| M11 | `menu.download-disclosures` — pending |
| M12 | `menu.resizers` — retired as a standalone entry; see Manifest closure below |
| M13 | `menu.context` — candidate; right-click on the `{agent}` Direct messages row (`[data-rail-agent]`, inside the navigation drawer at <=52rem) opens `.cs-context-menu`; nothing is run; passes at all six sizes since #413 (the menu no longer closes on a late scroll event after the row is brought into view at 844x390); Shift+F10 and touch long-press pending |
| M14 | `menu.workspace` — covers mobile drawer and desktop header anchors (`menu.workspace-dock` superseded duplicate removed) |
| M15 | `app.entity-detail`, `dialog.details-sheet` — cover entity panel, phone details sheet and desktop details pane (`menu.profile-inspector` superseded duplicate removed) |

The four empty candidates use `{emptyWorkspace}` and wait for their actual empty text or marker. To-dos and Lists additionally require the positive `household_permissions empty` seed step; the runner must reject a missing or failed step before navigation. Lists and Definitions candidates depend on the editor grant and seed steps succeeding; inspect seed notes and treat missing content as a failed capture. `app.agent` selects a profile with name and model; `app.agent.queue` waits for at least three Up next rows and two Not yet rows on the same agent, then scrolls Up next into view; `app.agent.queue.not-yet` is the same page scrolled to Not yet, so both groups are in frame.

Additional detail captures: `app.wiki.topic`, `app.wiki.editor`, `app.add-agent.existing`, `app.chat.history` (a channel whose newest messages are past their `until`: the notes stay, the status and the agent's note to itself do not). `app.chat.starred` (a starred channel: the Starred section in the rail, the pressed star and the bell in the header, and a muted row below) and `menu.notifications` (a muted channel's three notification levels: the bell's menu on a wide screen, the ⋯ menu's group on a phone). `menu.star-order` (the ⋯ of a starred row, where Move up and Move down change the viewer's own order; the seeded Channels list is in an order its owner chose, not by name). `app.chat.dm` separately tracks V05 (the header names the other party; its rows carry no recipient and the channel lead marker is absent, which the ready condition requires); `app.definitions.diff` tracks the V24 family. Additional invite, failure, keyboard, permission and write-outcome variants remain unbound and require dedicated entries before claiming coverage.

Mentions: `app.chat.mention` (a channel message whose stored mentions are drawn as pills, with a name inside code left alone) and `app.composer.mention` (a tag typed in a channel composer adds no To: row; the box is emptied again before the capture so no draft is left for other screens).

Main-branch addendum: PR #271 added password sign-in after the stated source baseline. PR #282 subsequently added the separate Password dialog; the initial open-only candidate is D15 below, while password challenge and submission flows remain outside this audit.

## Additional capture candidates and CI witness

After the stated baseline, PR #282 adds D15, making 15 dialog families (12 static and 3 dynamic) at this newer source revision. D15 is the Password dialog: `dialog.password` opens `[data-password-open]` and captures the initial form only. It does not type, submit, resend, confirm, or perform an auth mutation; challenge and result states remain pending. Account dialogs and empty Skills use real menu or palette actions. Definitions detail and diff entries require their exact create/certify/update seed steps and scroll the selected detail into the frame. `route.home.footer`, `route.home.footer.guides-end`, `route.home.footer.legal-end`, `menu.landing-preview`, and `route.guides.claude-code-subagents.disclosure` explicitly scroll their public targets into view. The three footer frames cover distinct positions. Thread and Details remain pending.

`menu.member-actions` opens and scrolls the seeded Atlas agent row actions in People; `{agent}` is Atlas, guarded by its exact creation step. It does not activate Remove or another menu action. The fixed-menu run below captured the open menu in all twelve combinations.

Definitions candidates wait for the loaded index or exact seeded target before selection and scroll, using the Engineer runner’s visible `waitFor` step. Run 41687242535 had 60 Definitions setup timeouts (five entries across twelve combinations); its other 37 cases completed. The later Definitions run captured all sixty combinations, with the visual limitation below.

## CI capture evidence and limits

For the 91-entry manifest at `9faf26ab`, 45 candidates have 540 unique successful capture keys across six sizes and two themes; 46 entries remain pending. The union comprises 37 cases / 444 frames from [41687242535](https://github.com/yulanventures/commonswarm/actions/runs/41687242535) (excluding its 60 Definitions errors), two / 24 from [41690127941](https://github.com/yulanventures/commonswarm/actions/runs/41690127941), five / 60 from [41693516743](https://github.com/yulanventures/commonswarm/actions/runs/41693516743), and one / 12 from [41694268790](https://github.com/yulanventures/commonswarm/actions/runs/41694268790). There are no missing or duplicate successful keys and no effective-theme mismatches. The 240 public frames have zero reported small-target or overflow findings.

The earlier menu run [41692336621](https://github.com/yulanventures/commonswarm/actions/runs/41692336621) showed its trigger obscured. The fixed run on Engineer `f47971c2` has zero small-target, collapsed-text, overflow or theme-mismatch findings and no obscured own trigger across all twelve frames. Definitions capture is not a visual pass: ten findings show the same collapsed Monthly spend span at 390 px across five states and both themes; Engineer fix `f2297abc` awaits a witness. Named 24 px inline mentions remain reported.

Capture success is not an all-app visual pass. Account writes, full authentication, recovery, native-device behavior and keyboard interactions were not validated. Independent source review of `9faf26ab` was clean conditional on Engineer #283 `b08271fa` or newer merging first for `waitFor`. Public styles are unchanged from `7c3a1290`, where site CI [41686605215](https://github.com/yulanventures/commonswarm/actions/runs/41686605215) passed.

## Navigation capture update

The account trigger is inside the phone drawer and remains separate at the desktop sidebar bottom. Responsive setup opens the drawer only at phone widths before the account menu, its four dialogs, and workspace actions. The picker and workspace-switch candidates open the same drawer conditionally; the switch waits for useful focus and then confirms the selected empty workspace using `aria-current`. The phone-header candidate checks the phone header or desktop workspace header as appropriate. Details opens a focused phone sheet or the expanded desktop pane. The picker lists every readable, non-archived workspace, including siblings in one organization. `nav.scrolled` scrolls the actual participant list to its last agent or person with the account control still present; the resulting frame needs visual inspection for reachability and overlap. These are 51 candidates and 44 pending entries in the 95-entry manifest; no new capture coverage is claimed before CI. Inline 24 px mentions remain reported separately from navigation targets.

## People & agents modal restoration (2026-11-11)

V08 is now a native `dialog[data-roster-dialog]`, opened with `showModal()` through existing doors. The compact roster, filter, row menus, persistent detail column, spoken receipt, Add your agents and admin controls live inside it. Desktop uses a bounded modal; <=52rem uses a bottom sheet with a pushed detail view. The app route remains behind it. A cold `?v=people` opens over workspace chat; close clears the overlay URL and returns focus. Esc closes the outer modal, while native nested confirmation cancel closes only that confirmation.

`app.people` now waits for the native modal and seeded agent. `dialog.people-detail` selects that agent. `dialog.people-confirm` and `menu.member-actions` remain within the outer modal. `dialog.people-admin-access` opens admin confirmation above the selected agent without submitting. Native foreground detection already handles stacked dialogs; raw measurement arrays are unchanged. Keyboard and mounted browser proof cover native containment, closing, return focus, preserved detail, spoken receipt after refresh and direct links. No coverage is claimed until CI artifacts land.

## Manifest closure

With Batch 5, `screens.json` has no pending entries: every entry is a runnable capture candidate. That closes the manifest, not the inventory above. It does not claim every state, permission or interaction of a family.

- `state.empty`, `state.error` and `state.loading` were generic placeholders, not screens. Per-surface empty captures (`app.todos.empty`, `app.lists.empty`, `app.wiki.empty`, `app.definitions.empty`) are runnable; other empty, error and loading states stay unbound and still need their own per-surface fixtures before any coverage is claimed.
- `menu.resizers` (M12) was retired as a standalone six-size entry. The `.cs-resizer` separators are hidden at 52rem and below (four of the six audit sizes) and already appear in the wider workspace, Lists and Wiki captures. Dragging, keyboard resizing and reset stay in the interaction inventory, unclaimed.
