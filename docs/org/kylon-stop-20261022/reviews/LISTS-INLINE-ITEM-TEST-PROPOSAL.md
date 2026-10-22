# Inline item test adaptation proposal

Source-only maker work for HezLead. Branch: `design/kylon-lists-inline-items-20261022`.
Exact worktree baseline: `6dc1575d7606384c93f1184b782ff08eb34329ce`.
The lead had already copied the two-file inline-control proposal into this worktree.
That proposal's original baseline was `bb7dd84aa699602ff1380fcedea0b60932815f13`.

## Test-authoring answers, recorded before editing source or tests

1. The observable contract is emitted selected-list HTML through the actual compiled Astro wrapper and real controller: one native checkbox-role button per ordered editable item, correct checked state, nonempty accessible label, matching delegated item ID, one visible label, and no standalone duplicate toggles. Reader, restricted-editor, historical, saving, pending, unknown and unrecovered-conflict lists stay readable without write controls. Separate expected records supply label/order/checked facts; they are not produced by the renderer or patch helper.
2. Credible regressions include keeping the old standalone buttons, losing controls or item IDs, associating checked values with backing-array positions instead of display order, duplicating labels, exposing hostile markup, producing blank accessible names, or enabling writes in a noneditable state. The pre-inline markup should fail because its ordered items contain no inline checkbox buttons. Removing the fallback from the copied proposal should fail the blank-name row.
3. The existing primary SSR owner renders a document in conflict, not a selected list. Existing permission/lifecycle tests protect controller and document behavior; the core list-patch case cannot observe markup placement or names. The redesign test protects committed reload and selection, while shell observers protect navigation/access. Adapt this one existing SSR owner; retain its three component cases and existing safety assertions. No duplicate test in another file is needed.
4. No production seam is needed. Reuse the existing controller, action interface, fixtures, actual renderer and Astro compilation. Local HTML-tree traversal is test support, not a mirrored renderer. No production export, flag, helper, wrapper or injection hook is added.

## Production and test delta

The worker's only production edit changes the new checkbox's `aria-label` expression to `esc(item.text.trim() ? item.text : 'List item')`. Empty and whitespace-only labels receive a truthful nonempty name. Nonblank names retain their original text, including surrounding whitespace. Visible item text still uses the unchanged `esc(item.text)` expression. Schema inspection found `validContent` checks that item text is a string, without requiring nonempty or trimmed text.

The inherited proposal renders one native checkbox-role button inside each ordered editable list item, removes the former standalone toggles, and supplies the existing 44px CSS treatment. The stylesheet was compared with the candidate file using `cmp` before and after editing and is byte-identical. Relative to that copied proposal, the renderer differs in exactly the one allowed attribute expression. Controller, mount, gates, save/conflict/history behavior and public APIs were not edited.

The existing SSR test keeps all three original cases: `HouseholdObjects`, `HouseholdObjectHistory`, and `HouseholdConflict`, their compiler-diagnostic assertion, actual component evaluation, expected markup checks, and script/onclick safety assertion. Each component is compiled once. The already compiled `HouseholdObjects` component renders a single additional table of nine independent selected-list scenarios:

| Scenario | Setup and observable contract |
| --- | --- |
| Editable current list | Reversed backing order, unchecked hostile text and checked long label; ordered items each contain one enabled native checkbox-role button with the expected name, checked value and delegated item ID. Visible label bytes occur once; all toggle actions are inside those item controls. |
| Blank names | Separate empty and whitespace-only items, both checked values and reversed backing order; both names are `List item`, while visible text remains empty or the original whitespace. |
| Reader | Real reader controller selects the populated list; text remains readable without write controls. |
| Restricted editor | Editor workspace has read-only operations, then is loaded through `switchWorkspace` and selected; text remains readable without write controls. |
| Historical | `openRevision` selects a distinct retained list whose label differs from current content; retained text remains readable without write controls. |
| Saving | `stage` and `save` enter the real in-flight state against a deferred action; current text stays readable without write controls. The deferred action is settled and awaited in `finally`. |
| Pending | Actual save outcome moves the controller into pending; current text stays readable without write controls. |
| Unknown | A rejected save action moves the controller into unknown; current text stays readable without write controls. |
| Conflict | A valid newer-revision conflict receipt moves the controller into unrecovered conflict; current text stays readable without write controls. Recovery remains with existing tests. |

The table parses actual emitted HTML with `parseFragment`. Local tree/attribute/text functions only inspect that HTML; they produce no markup or expected results. Assertions use semantic article/list/item/control structure and ARIA, without CSS-class or private-helper names. Action/value attributes are checked only for the delegated toggle integration and absence of writes. A document-wide containment comparison detects extra standalone toggles. Hostile text must survive as text and as the decoded accessible label, with no injected script, image, form or event-handler attribute. Expected order, labels, IDs and checked values are supplied independently of input sorting and rendering.

| Tracked path | HEAD lines → final lines | Added | Removed |
| --- | ---: | ---: | ---: |
| `site/src/lib/household-objects-view.ts` | 455 → 457 | 4 | 2 |
| `site/src/styles/kylon-lists.css` | 130 → 138 | 12 | 4 |
| `site/tests/household-objects-view.test.ts` | 295 → 419 | 124 | 0 |
| Production total, including lead's copied proposal | 585 → 595 | 16 | 6 |
| Test and local test support total | 295 → 419 | 124 | 0 |

Relative to the task's starting dirty worktree, this worker changed one renderer line (one addition/one removal), added 124 test lines, and added this report. No existing test or safety contract was removed. No helper, package, lockfile, backend, navigation, authority or other test file was edited. No production export or test seam was added.

## Source and dependency evidence read

- Worker rules; company, repository and site instructions; `CLAUDE.md`; the task; the complete prior proposal report; candidate `PROPOSAL.md`, `BASELINE.json`, patch and both copied source files; simplification-state guidance.
- Complete `site/src/lib/household-objects-view.ts`: renderer, shared read-only renderer, patch builder, permission filtering, controller, mount/delegation/focus code, fixtures and conflict renderer.
- Complete existing primary owner `site/tests/household-objects-view.test.ts`, sibling `site/tests/household-objects-redesign.test.ts`, and dashboard loader/action owner `site/src/lib/household-dashboard.ts` with its complete `household-dashboard.test.mjs`.
- All three actual Astro wrappers and `lists-chrome.ts`; relevant `LiveDashboard.astro` imports, Lists markup and authenticated open lifecycle. Related shell-observer test names were enumerated; the complete Lists Refresh/navigation/focus case and household access/source-guard sections were inspected. These observers own shell/access behavior, not the selected-list markup contract added here.
- The protocol list-item type and `validContent` string/checked/order checks; `escapeMessageHtml` and related Markdown source; the full copied Lists stylesheet.
- Site package scripts and dependency lock entries: both `test` and `test:ci` include `tests/*.test.ts`, so the existing owner remains routed without script changes. Existing test imports establish named ESM imports and the current compiler/container harness; no local parse5 test import convention was found.
- `parse5` is already lock-pinned at 7.3.0. This worktree has no installed `site/node_modules/parse5`; the existing sibling checkout `/Users/yulanbot/work/kylon-redesign/app/site/node_modules/parse5` was read only. Its package is also 7.3.0 and exposes ESM `dist/index.js` and `dist/index.d.ts`. Read its `parseFragment` implementation/overloads and default-tree adapter/interface types, which supply the named `DefaultTreeAdapterMap` export and `node`/`element`, `childNodes`, `attrs`, `tagName` and text `value` shapes used by this test. No dependency was installed or changed.
- Read-only history inspection identifies the owner file's registration commit `2911bc238` (`test: register the household sub-lane tests (D-030)`). The original primary test and sibling comments establish the boundary being extended.

## Actual static checks and remaining proof

Read-only Git inspection confirms the exact branch and HEAD above. Initial comparisons showed both source files matched the lead's copied candidate. Final `cmp` confirms the stylesheet remains byte-identical; a candidate-to-worktree renderer diff contains only the allowed name fallback. `git diff --check` exited 0 without diagnostics. Diff/stat inspection enumerated the three tracked changed paths above plus this new report. No TypeScript parser, compiler or application module was executed, so no syntax/typecheck result is claimed.

No tests, browser, application, compiler, installation, build, SSH, secrets access, HOME changes, Git mutation, commit, push, workflow or write outside this assigned worktree occurred. No Alloy tool or skill and no sub-agent was invoked. No runtime, visual, CI, shipping or live result is claimed.

Future focused command for the lead, from this worktree's `site/` directory with its normal dependencies available; **not run by this worker**:

```sh
node --import tsx --test --test-name-pattern='all three Astro components compile and server-render' tests/household-objects-view.test.ts
```

Predicted intended red on the pre-inline/old183 markup: the first editable-list table row finds zero checkbox-role controls inside the selected ordered list, where two are required. This reaches real selected content through the controller and compiled actual wrapper, rather than failing because of missing selection or denied permission. Predicted secondary red on the copied proposal without this worker's fallback: the blank-name row gets an empty or whitespace-only `aria-label` instead of `List item`. These predictions and the expected post-fix behavior remain unexecuted; the lead demonstrates red/green.

SSR inspection cannot establish computed 44px geometry, wrapping at a viewport, browser accessibility-tree calculation, native keyboard activation or focus after saves. This table covers unrecovered list conflict, while the existing recovery/review tests remain unchanged. The reversed backing arrays deliberately exercise presentation ordering; they do not claim those arrays satisfy the backend's canonical storage-order validator. No backend/save-protocol proof is duplicated here.

Handoff state: source edits and report are ready for the lead's adoption/validation. PR183 remains outside this worktree and was not written. There is no new commit or PR. Only one cross-family changed-slice review and changed-area CI remain with the lead; no additional gate or broad cleanup is proposed.
