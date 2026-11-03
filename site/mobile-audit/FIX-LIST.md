# Mobile audit fix list — Slice 3

This is a ranked review of CI screenshots and measurements, with source-backed capture additions. A proposed CSS fix or manifest candidate is not a verified rendered pass. PR B covers public CSS and capture metadata; Engineer PR A owns app CSS and runner measurements.

## Evidence and validity

- Baseline: [run41672844474](https://github.com/yulanventures/commonswarm/actions/runs/41672844474), head `36468ee2cda01d5a6d8ec2c1e7c4106d1e77d95f`.
- Slice2: [run41672858386](https://github.com/yulanventures/commonswarm/actions/runs/41672858386), head `b2c22fc92d4bedbf2cd1df39a7c3010ffa883da5`.
- Both completed with240 seeded signals,45 accepted seed steps,0 capture errors and0 page overflow. Pending entries are unexecuted coverage, not passes.
- Artifact `mobile-audit-report` contains `mobile-audit-report.json`, `seed.json`, and `shots/`. Screenshot names are `shots/<id>--<state>--<WxH>--<theme>.png`.
- Sizes:360×740,390×844,430×932,844×390,768×1024 and1024×1366; two requested themes each.
- **App light labels are invalid in these two runs.** The app defaults dark regardless of OS preference. Engineer PR#283 at `2068dfd3` stores `commonswarm:theme`, records `effectiveTheme` and counts `themeMismatches`. The corrected runner is at `2068dfd3`; site run41687062207 and mobile audit run41687066907 are the latest Engineer evidence. Their results remain outside this baseline visual review; no new-patch app-light pass is claimed here. Public light/dark frames differ correctly.
- Run41667674686 is **void**: in-page `__name` exceptions and incomplete seed made its zero findings meaningless. Cancelled intermediate runs are not evidence.

## Like-for-like comparison

| Measure | Baseline | Slice2, common captures | Slice2, added empty cases |
|---|---:|---:|---:|
| Rendered captures |312|312|24|
| Captures with small targets |244|244|16|
| Small-target occurrences |3434|2450|92|

Slice2 removes984 small-target occurrences on the same312 capture keys. Its two new empty-state entries add24 captures. The raw affected-screen totals use different denominators and do not establish a regression. Bounding-box counts also depend on how many controls are rendered or visible; they do not alone prove a new defect kind.

## Ranked findings and owners

| Rank | Finding / evidence | Owner and disposition |
|---|---|---|
|1 — high|Receipt sentences wrap one character per line in both chat views, across all six sizes. Full-resolution390×844 general-chat frames reproduce it before and after Slice2. `app.chat.general--dense--390x844--light.png` is an example; its effective app theme is dark.|Engineer A. Reported fixed in#283 `2068dfd3`: full-width toolbar, receipt column minimum and word wrapping. New collapsed-text check. Await new artifact; old zero overflow cannot close this.|
|2 — coverage|Requested app-light frames are dark; old theme matrix is mislabeled.|Engineer A `2068dfd3`; effective-theme and mismatch checks added. Await run41687066907.|
|3 — coverage|`app.definitions` screenshots show Lists above the intended Definitions surface. A visible DOM node below fold is insufficient.|PR B scrolls the intended surface into view and selects distinct seeded Definition states. CI witness pending.|
|4 — medium|App message entity/author/channel controls, workspace trigger, todo labels, form inputs and summaries have undersized hit areas.|Engineer A#283; no app files changed by PR B. Validate effective labels, actual boxes, obscured centres and overlapping controls in the new report.|
|5 — medium|Footer `.ft__link` width37–39px, height44px:288 occurrences across144 captures/12 route IDs. Preview Lists tab width28–29px, height44px:12 occurrences. Below-fold targets need scrolled screenshots.|PR B: public controls get44px minimums through64rem, including landing secondary links, invite brand, legal TOC and guide disclosures. Styles source-checked; rendered result pending.|
|6 — medium|`.cs-org-product` has43px height at844×390 and1024×1366:260 occurrences across48 app captures. Rail border-box sizing leaves43px children.|Engineer A app chrome; deliberately outside PR B.|
|7 — measurement|Home example inputs are18×18px:48 raw occurrences. Existing labels provide44–52px click height, so input geometry alone does not prove a bad touch target.|Preserve native input size. Engineer A measures checkbox/radio through actual labels and records both sizes in `effective`; no blanket exclusion.|
|8 — follow-up|Long workspace name/member metadata pushes list work down phone frames. Seed covers disconnected/key-disabled agents, without working/reconnect diversity.|Lead to prioritize app density and state coverage after core target fixes; no speculative PR B redesign.|

## Per-screen review

Counts below are the old Slice2 bounding-box measurement across12 captures per ID; app rows do not establish light-mode coverage. “Affected” means at least one small target anywhere in the document, not necessarily in the screenshot. Every row's contact sheet was inspected for composition; selected390px chat frames were inspected at full resolution.

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
|`route.home`|12|120|Public footer/preview targets. Checkbox input is18px inside44–52px clickable label.|
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

The proposed manifest has91 entries:45 source-backed executable candidates and46 pending. The human source inventory crosswalk has73 units, including the new initial Password dialog D15. Counts are source metadata, not executed coverage.

- Eleven account/app promotions: account menu; Your agents; Connected apps; initial Password form; sign-out-other-sessions confirmation; empty Skills; resolved todo; proposed/certified/proposal-pending Definitions; selected proposal diff.
- The seeded Atlas agent row actions capture opens the menu only; it never selects Remove or another action.
- Password and sign-out captures open only. They never type credentials, submit changes, resend, reauthenticate or confirm sign-out.
- Seed guards require recorded positive steps for the selected to-do and Definitions. Connected apps has no guaranteed grants; Skills is empty. They are not presented as populated states.
- Public additions scroll the footer, its Guides and Legal end links, and homepage preview into view and open a guide disclosure; distinct footer frames cover the lower columns on phones. Existing Definitions capture scrolls to its intended surface.
- Thread, viewport-dependent Details, recovery/challenge flows and nondeterministic states remain explicitly pending. No invented roster dialog or test-only production hook is introduced.

## Verification ceiling

Review used the two downloaded CI reports, all28 contact sheets (336 top-of-page frames) and selected original chat screenshots. No local browser, production seed or Tom account was used. Most old shots are viewport-sized top frames; below-fold footer, disclosure and Definitions geometry was measured but not visually verified there.

Zero page overflow does not establish readable text, absence of element clipping, usable vertical scrolling, keyboard reachability, focus order, reduced motion, native-device behavior or every dialog state. Future reports must also be checked for seed prerequisites, effective theme, capture errors, collapsed text, obscured targets and overlap findings. Real-device and interaction checks remain separate from static screenshot inspection.

PR B static build and manifest validation have passed locally. Independent source review, final-branch site CI and new mobile artifact review remain pending. Merge and deployment stay with the Lead/HezLead release process.

Run [41687242535](https://github.com/yulanventures/commonswarm/actions/runs/41687242535) recorded 60 Definitions setup timeouts across five entries; 37 other cases completed. Source shows Lists loads before mounting Definitions. The five entries now use the runner’s visible `waitFor` step before selection or scrolling; a new targeted artifact is required before claiming these frames.
