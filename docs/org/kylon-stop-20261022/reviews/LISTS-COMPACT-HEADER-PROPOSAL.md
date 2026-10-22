# Lists compact header: source-only proposal

Separate later slice; do not bundle into frozen PR184. Base: exact `3a45f7f67ff8fb50a17de4a2ce2d7cafd20e20fb`. [Unified patch](LISTS-COMPACT-HEADER-PROPOSAL.patch) is text only and has not been applied to the app.

The proposal groups existing header content into two naturally wrapping rows. It addresses the prior Claude source/image report's non-blocking follow-up #2: the stacked household header above both readers. The earlier saved v4 images support that finding; this proposal has no new images or score.

## Exact before/after

- `site/src/lib/household-objects-view.ts:179–182`: four existing source lines replaced by four lines, adding only two noninteractive `div` wrappers: `hh-workspace-identity` around the existing eyebrow and workspace h2, and `hh-workspace-meta` around the existing audience and role/capability paragraphs. Every original expression, escape, sentence, paragraph, h2 and their reading order is retained. The disclosure paragraph remains immediately after those rows. Nothing outside these four lines changes, including PR184's inline item markup.
- `site/src/styles/kylon-lists.css`: seven lines inserted after existing line69. Two rules make those wrappers wrapping baseline flex rows with `4px 12px` gaps and `4px` bottom spacing; their p/h2 children get zero margins, `min-inline-size:0`, `max-inline-size:100%` and `overflow-wrap:anywhere`. No font, color, height, visibility, order, interaction or status rule changes. Existing metadata remains 12px and the workspace h2 remains 16px.

## Native defaults and cascade

Read exact-base `HouseholdObjects.astro` in full. Its global defaults give h2 a 12px bottom margin and the eyebrow a 6px bottom margin (`:15–17`). Current Kylon rules already replace these with an 8px heading margin and 4px paragraph margin (`kylon-lists.css:21–22,69`). The proposal resets only the row children's margins, using the explicit flex gaps for separation.

`LiveDashboard.astro:11263` declares global styles; its native descendant h2/p/eyebrow rules at `:16129–16143` still match through the wrappers. No direct-child header text selector was found in the scoped source search. The new child selector has specificity `(0,4,3)`, above the current header paragraph rule `(0,4,2)`, heading rule `(0,3,2)` and native h2/p rules. It changes no inherited typography. All new styling requires `live-dashboard[data-kylon-shell] .dashboard__objects-view .household-objects > header`; outside that host the new divs retain normal block layout and existing descendant styles.

## Risks and later verification

Long workspace names/audience values and Reader/Not confirmed copy must wrap at natural height. Metadata may still need separate rows on narrow screens; no fold gain is promised. The shared renderer gains two block wrappers, so standalone margin behavior also merits later inspection. A later implementation should capture desktop and phone, inspect those long/role variants, and confirm the unchanged status, consent/Allow focus targets and 44px controls. No hidden content, ellipsis, clipping, collapse, smaller type, extra action or CSS reordering is proposed.

Source files read at the exact base: `household-objects-view.ts` (full text plus focused numbered region), `kylon-lists.css` (full), `HouseholdObjects.astro` (full), `LiveDashboard.astro` (native style region/style declaration/import location), and `site/AGENTS.md`. Also reread the workspace AGENTS, worker rules and app AGENTS. A read-only exact-base grep checked related header selectors.

Only the requested patch and note were written in this turn. No app edits, worktrees, commits, tests, application imports, compiler, build, install, browser, network, SSH, secrets or additional agents. Source inspection only; no runtime, accessibility, capability, parity or numeric-score claim.
