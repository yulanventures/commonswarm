# Mobile audit fix list — Slice 3

This is a ranked review of CI screenshots and measurements, with source-backed capture additions. Capture success does not by itself establish a visual pass. PR B covers public CSS and capture metadata; Engineer PR A owns app CSS and runner measurements.

## Evidence and validity

- Baseline: [run 41672844474](https://github.com/yulanventures/commonswarm/actions/runs/41672844474), head `36468ee2cda01d5a6d8ec2c1e7c4106d1e77d95f`.
- Slice 2: [run 41672858386](https://github.com/yulanventures/commonswarm/actions/runs/41672858386), head `b2c22fc92d4bedbf2cd1df39a7c3010ffa883da5`.
- Both completed with 240 seeded signals, 45 accepted seed steps, 0 capture errors and 0 page overflow. Pending entries are unexecuted coverage, not passes.
- Artifact `mobile-audit-report` contains `mobile-audit-report.json`, `seed.json`, and `shots/`. Screenshot names are `shots/<id>--<state>--<WxH>--<theme>.png`.
- Sizes: 360×740, 390×844, 430×932, 844×390, 768×1024 and 1024×1366; two requested themes each.
- **App light labels are invalid in these two runs.** The app defaults dark regardless of OS preference. Engineer PR#283 at `2068dfd3` stores `commonswarm:theme`, records `effectiveTheme` and counts `themeMismatches`. The later evidence union below uses the corrected runner and has zero effective-theme mismatches; the baseline comparison remains mislabeled. Public light/dark frames differ correctly.
- Run41667674686 is **void**: in-page `__name` exceptions and incomplete seed made its zero findings meaningless. Cancelled intermediate runs are not evidence.

## Like-for-like comparison

| Measure | Baseline | Slice 2, common captures | Slice 2, added empty cases |
|---|---:|---:|---:|
| Rendered captures |312|312|24|
| Captures with small targets |244|244|16|
| Small-target occurrences |3434|2450|92|

Slice 2 removes 984 small-target occurrences on the same 312 capture keys. Its two new empty-state entries add 24 captures. The raw affected-screen totals use different denominators and do not establish a regression. Bounding-box counts also depend on how many controls are rendered or visible; they do not alone prove a new defect kind.

## Ranked findings and owners

| Rank | Finding / evidence | Owner and disposition |
|---|---|---|
|1 — high|Receipt sentences wrap one character per line in both chat views, across all six sizes. Full-resolution 390×844 general-chat frames reproduce it before and after Slice 2. `app.chat.general--dense--390x844--light.png` is an example; its effective app theme is dark.|Engineer A. Reported fixed in #283 `2068dfd3`: full-width toolbar, receipt column minimum and word wrapping. New collapsed-text check. Await new artifact; old zero overflow cannot close this.|
|2 — coverage|The two baseline app-light labels are invalid.|The later evidence union records zero effective-theme mismatches; this does not retroactively validate the baseline labels.|
|3 — coverage|Baseline `app.definitions` screenshots show Lists above the intended surface. A visible node below fold is insufficient.|The targeted Definitions run captured all 60 requested frames. Ten still show collapsed Monthly spend text at 390 px; see the evidence below.|
|4 — medium|App message entity/author/channel controls, workspace trigger, todo labels, form inputs and summaries have undersized hit areas.|Engineer A #283; no app files changed by PR B. Validate effective labels, actual boxes, obscured centres and overlapping controls in the new report.|
|5 — medium|Footer `.ft__link` width 37–39 px, height 44 px: 288 occurrences across 144 captures / 12 route IDs. Preview Lists tab width28–29px, height 44 px:12 occurrences. Below-fold targets need scrolled screenshots.|PR B: public controls get 44 px minimums through 64rem, including landing secondary links, invite brand, legal TOC and guide disclosures. The later public report records zero small-target and overflow findings across 240 frames.|
|6 — medium|`.cs-org-product` has 43 px height at 844×390 and 1024×1366:260 occurrences across 48 app captures. Rail border-box sizing leaves 43 px children.|Engineer A app chrome; deliberately outside PR B.|
|7 — measurement|Home example inputs are18×18 px: 48 raw occurrences. Existing labels provide 44–52 px click height, so input geometry alone does not prove a bad touch target.|Preserve native input size. Engineer A measures checkbox/radio through actual labels and records both sizes in `effective`; no blanket exclusion.|
|8 — follow-up|Long workspace name/member metadata pushes list work down phone frames. Seed covers disconnected/key-disabled agents, without working/reconnect diversity.|Lead to prioritize app density and state coverage after core target fixes; no speculative PR B redesign.|

## Per-screen review

Counts below are the old Slice 2 bounding-box measurement across 12 captures per ID; app rows do not establish light-mode coverage. “Affected” means at least one small target anywhere in the document, not necessarily in the screenshot. Every row's contact sheet was inspected for composition; selected 390px chat frames were inspected at full resolution.

| Capture ID | Affected /12 | Target occurrences | Finding / coverage ceiling |
|---|---:|---:|---|
|`app.signin`|0|0|Initial sign-in frame; recovery and keyboard coverage still pending. App theme labels invalid.|
|`app.chat.general`|12|488|P1 collapsed receipt text; inline message targets. Engineer A.|
|`app.chat.group`|12|464|P1 collapsed receipt text; inline message targets. Engineer A.|
|`app.todos`|12|112|Checkbox effective-label measurement and app targets. Engineer A.|
|`app.lists`|12|76|Fields/summaries and app targets. Long workspace metadata reduces phone working area.|
|`app.definitions`|12|100|Wrong frame: Lists is above fold. PR B scrolls Definitions before capture.|
|`app.people`|4|24|App chrome targets; selected person/Details coverage pending.|
|`app.agent`|4|24|App chrome targets; seeded disconnected agents do not cover working/reconnect states.|
|`dialog.command-palette`|12|688|Inline and dialog controls. Engineer A; real hook is data-command-palette.|
|`route.acceptable-use`|12|30|Shared footer and legal summary targets. Disclosure interaction not shown by top frame.|
|`route.alternatives.crewai`|12|24|Shared public footer targets; top-frame composition reviewed.|
|`route.alternatives.langgraph`|12|24|Shared public footer targets; top-frame composition reviewed.|
|`route.download`|12|24|Shared public footer targets; installation behavior not exercised.|
|`route.guides.claude-code-subagents`|12|36|Shared footer/guide summary targets. PR B adds an expanded disclosure frame.|
|`route.guides.claude-connector`|12|24|Shared footer/guide summary targets; top-frame composition reviewed.|
|`route.guides.grok-bot`|12|24|Shared footer/guide summary targets; top-frame composition reviewed.|
|`route.home`|12|120|Public footer/preview targets. Checkbox input is 18 px inside 44–52 px clickable label.|
|`route.invite`|12|12|Public footer and brand link targets. No invite acceptance is executed.|
|`route.oauth.c1-controls.callback`|0|0|Static release-worker handoff text only; no OAuth authorization/token flow coverage.|
|`route.oauth.c1-smoke.callback`|0|0|Static release-worker handoff text only; no OAuth authorization/token flow coverage.|
|`route.orchestration`|12|24|Shared public footer targets; top-frame composition reviewed.|
|`route.privacy`|12|30|Shared footer and legal summary targets. Disclosure interaction not shown by top frame.|
|`route.support`|12|24|Shared public footer targets; top-frame composition reviewed.|
|`route.terms`|12|30|Shared footer and legal summary targets. Disclosure interaction not shown by top frame.|
|`app.files.empty`|4|24|Empty workspace fixture; file upload/populated states pending.|
|`app.wiki.empty`|4|24|Empty workspace fixture; editor/populated states pending.|
|`app.todos.empty`|4|28|Empty workspace fixture with accepted household_permissions empty prerequisite.|
|`app.lists.empty`|12|64|Empty workspace fixture; fields and label measurement. Engineer A.|

## Capture changes in PR B

The proposed manifest has 91 entries: 45 source-backed executable candidates and 46 pending. The human source inventory crosswalk has 73 units, including the new initial Password dialog D15. The evidence union below covers the 45 candidates; the 46 pending entries are not executed coverage.

- Eleven account/app promotions: account menu; Your agents; Connected apps; initial Password form; sign-out-other-sessions confirmation; empty Skills; resolved todo; proposed/certified/proposal-pending Definitions; selected proposal diff.
- The seeded Atlas agent row actions capture opens the menu only; it never selects Remove or another action.
- Password and sign-out captures open only. They never type credentials, submit changes, resend, reauthenticate or confirm sign-out.
- Seed guards require recorded positive steps for the selected to-do and Definitions. Connected apps has no guaranteed grants; Skills is empty. They are not presented as populated states.
- Public additions scroll the footer, its Guides and Legal end links, and homepage preview into view and open a guide disclosure; distinct footer frames cover the lower columns on phones. Existing Definitions capture scrolls to its intended surface.
- Thread, viewport-dependent Details, recovery/challenge flows and nondeterministic states remain explicitly pending. No invented roster dialog or test-only production hook is introduced.

## Verification ceiling

Baseline review used two downloaded CI reports, all 28 contact sheets (336 top-of-page frames) and selected original chat screenshots. Lead also reviewed all five targeted Definitions boards; a separate read-only reconciliation checked the final capture keys. No local browser, production seed or Tom account was used. Most old shots are viewport-sized top frames; below-fold footer, disclosure and Definitions geometry was measured but not visually verified there.

Zero page overflow does not establish readable text, absence of element clipping, usable vertical scrolling, keyboard reachability, focus order, reduced motion, native-device behavior or every dialog state. Future reports must also be checked for seed prerequisites, effective theme, capture errors, collapsed text, obscured targets and overlap findings. Real-device and interaction checks remain separate from static screenshot inspection.

PR B static build and manifest validation passed locally. Site CI [41686605215](https://github.com/yulanventures/commonswarm/actions/runs/41686605215) passed on `7c3a1290`; the public styles are byte-identical at `9faf26ab`. Independent Anthropic source review of `9faf26ab` was clean, conditional on merging Engineer #283 at `b08271fa` or newer first for `waitFor`. Merge and deployment remain with the Lead/HezLead release process.

Run [41687242535](https://github.com/yulanventures/commonswarm/actions/runs/41687242535) recorded 60 Definitions setup timeouts across five entries; 37 other cases completed. Source shows Lists loads before mounting Definitions. The five entries now use the runner’s visible `waitFor` step before selection or scrolling; their later targeted artifact is included below.

## Final capture evidence and open findings

The manifest at `9faf26ab` has 91 entries: 45 runnable candidates and 46 pending, with 73 human inventory units. The successful union has exactly 540 unique `(id, state, viewport, theme)` keys: no missing or duplicate successful keys and no effective-theme mismatches. Failed and pending captures are excluded.

| Evidence | Verification head | Successful cases / frames | Limitation |
| --- | --- | ---: | --- |
| [Base 41687242535](https://github.com/yulanventures/commonswarm/actions/runs/41687242535) | `9621d9c3` | 37 / 444 | Excludes 60 Definitions setup errors |
| [Footer 41690127941](https://github.com/yulanventures/commonswarm/actions/runs/41690127941) | `2c39ebf8` | 2 / 24 | Scrolled Guides and Legal end links |
| [Definitions 41693516743](https://github.com/yulanventures/commonswarm/actions/runs/41693516743) | `0e0afb1d` | 5 / 60 | Ten collapsed-text findings remain |
| [Fixed menu 41694268790](https://github.com/yulanventures/commonswarm/actions/runs/41694268790) | `ac0420a7` | 1 / 12 | Captures open Atlas agent actions only |

The 20 public cases produced 240 frames with zero reported small-target findings or overflow offenders. The original menu run [41692336621](https://github.com/yulanventures/commonswarm/actions/runs/41692336621) had its own trigger obscured; the fixed menu run on Engineer `f47971c2` has 12 successful frames, zero small-target, collapsed-text, overflow or theme-mismatch findings, and no obscured own trigger. Other overlap and obscuration heuristics are not adjudicated by this count.

Definitions capture succeeded but is **not a visual pass**: ten findings show the same collapsed Monthly spend span at 390 px across five states and both themes. Engineer fix `f2297abc957163d780a258b050511db6a7228ede` awaits a new witness. Named 24 px inline mentions remain reported by Engineer. A reconnect label splitting on a long agent name and dense to-do assignee presentation are follow-up app observations.

Capture success is not an all-app visual pass. Account writes, full authentication and recovery flows, native-device behavior and keyboard interaction were not validated by this evidence.
