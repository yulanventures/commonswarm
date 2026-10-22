# Lists: next visible gap after PR184

Source/design study only, 2026-10-22. Recommend one small follow-up: compact the existing household header without removing any of its content. This is a direction toward the requested quality target, not a predicted score or release gate.

## Evidence and scope

- Read exact source with `git -C app show` at live PR183 `81b5fb71f20030cf71b7927964a2c08c425a1ab3`, plus the renderer/CSS delta for proposed PR184 `3a45f7f67ff8fb50a17de4a2ce2d7cafd20e20fb`. The stale checkout was not used as current source. PR184 already owns the inline item controls; do not duplicate that work.
- Read both full Claude reports: [source/image follow-up](/Users/yulanbot/work/kylon-critic-replies/lists-pr183-source-image-followup-claude-opus-01.md) and [final repair](/Users/yulanbot/work/kylon-critic-replies/lists-pr183-final-repair-claude-opus-01.md), plus `VISIBLE-GAPS-CURRENT.md` and `AUDIT-KYLON-REFERENCE-MAP.md`.
- Opened all four saved v4 normal light PNGs under `candidate/lists-review-images-job-v4/generated/lists-review-images-01/retrieved/work/proofs/lists/`, and Kylon references 15, 27 and 43. These are the prior controlled synthetic editor captures, captured on bb7 and accepted by the prior critic for final PR183 source; they are not new PR184 or live captures. No new image hashes or geometry were measured.

## 1. Next patch: compact the household header

**Grounding.** Claude's non-blocking follow-up #2 explicitly identifies header furniture: the repeated “Lists & docs” eyebrow, repeated workspace identity, and roughly 165px of phone household metadata. Its reference-27 comparison notes roughly 230px of household header above the desktop reader. The saved phone list and document images both show the selected title only around y=436, below the pane title/description, identity, audience, role/capability explanation and index. Reference 27 is a reader hierarchy analogy; references 15/43 support compact shell context. None is a Kylon Lists equivalent.

**Exact current regions** (all line numbers at `81b5fb71`):

- `site/src/lib/household-objects-view.ts:171–186`: the renderer stacks eyebrow, workspace h2, audience, role/capability and the full disclosure paragraph before the status region and index. Keep every dynamic value and sentence.
- `site/src/styles/kylon-lists.css:21–25,69–73`: current heading and metadata margins/type, status spacing and layout gap. Existing 12px metadata text is already small; do not shrink it to gain space.
- `site/src/components/app/HouseholdObjects.astro:14–19`: inherited header/status defaults, including the status region's border and spacing; account for these in the cascade.
- `site/src/components/app/LiveDashboard.astro:573–626` and `site/src/lib/lists-chrome.ts:5–26`: the native H1, movable description/Refresh, consent, objects and approvals remain owned here. Preserve their order, visibility and focus targets.

**Minimal separate patch:** only `household-objects-view.ts` and `kylon-lists.css`. Add non-interactive identity/metadata wrappers or explicit classes around the existing header nodes. Put the eyebrow and workspace h2 on a wrapping baseline row; group audience and role paragraphs with wrapping flex layout so they can share available desktop space. Keep the entire disclosure paragraph below them, visible and in its current reading order. Use small explicit gaps and natural height; retain the complete index, status live region, attribution and revision labels. Scope CSS to the existing Kylon Lists host so standalone household rendering keeps its defaults. Leave PR184's item markup/selectors alone.

**Risk and later acceptance:** long workspace names, many audience names and Reader/Not confirmed copy must wrap without clipping or ellipsis. Retain h2 semantics and all capability derivation. Do not collapse metadata, use tooltips/details, move disclosures behind actions, add fixed heights, or suppress nonempty status messages. Actual improvement and fold position need fresh desktop/phone images after implementation; preserve 44px controls, consent-first order and both Allow landing targets. This study ran no verification.

## 2. Remaining owner boundary: duplicated desktop object navigation

The same Claude follow-up #2 and both saved desktop images show the main object index repeated by the right Lists card. Exact source: `household-objects-view.ts:185–186` supplies the full in-pane selector; `site/src/lib/home-side-cards.ts:218–229` supplies capped linked cards, with row construction at `114–120`. `LiveDashboard.astro:4535–4578` owns the workspace shell/title context. These are distinct owner surfaces, and the side cards retain real links, counts and attribution. Do not hide or remove them in the small header patch. A later shell-owner proposal must reconcile those functions explicitly while preserving every destination and disclosure; CSS suppression alone is not an acceptable fix.

Only this report was written. No app edits, tests, imports, builds, installs, browser, network, SSH, secret access, Git mutations or additional agents. No new capability, parity, runtime, accessibility, dark-mode or numeric-score claim. PR183's existing agent-tool gaps and CommonSwarm/Hez owner gates remain outside this study.
