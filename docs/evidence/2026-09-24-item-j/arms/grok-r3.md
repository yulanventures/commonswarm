I'll review the fold-2 diff against the rulings only: read `fold2.md` and `git diff a1ef90ff..90467bbf`, then check each ruling's code and that its test or proof can fail.HEAD is `90467bbf` in a detached worktree. Next I’ll take the fold-2 diff and read the proofs, tests, and LANE.md against each ruling.Ten files changed. I'll read the diffs and the proofs, then check whether each ruling's test actually fails on revert.The catalog digest and the LANE.md mutation claims need a closer look. I'll read the function, proofs, CSS, and call sites next.I'll verify the digest, dialog markup, test gates, and a few proof-failure paths before running the allowed pure tests.The dialog comment still describes the old desktop hide. Next I’ll check whether JS still gates the section by viewport, and I’ll confirm the digest and tests.Whitespace is clean. Next I’ll build, then run the focused CLI and site tests under a temporary `HOME`.Checking one more F4 revert path and whether `check:tests` accepts the new TypeScript.Fold-2 review of `a1ef90ff..90467bbf` (`d609b9b7`, `28555194`, `90467bbf`). Read-only; `npm run build` and `check:tests` exit 0; focused CLI pending tests 7/7; access-lifecycle observer 25/25, including the F3 wiring test and the F4 source observer. Server suite not re-run (needs the lead’s `db:reset`).

Each ruling is present in the diff. F1–F3 and F5 have revert-killing tests or proofs. F2 catalog/functional proofs can fail for a changed body, a disabled member gate, and zero seeded rows, and the catalog file ends in the section 5 `\gset` form.

## Findings

### 1. RIGOUR — F4 source observer still matches the pre-fix CSS

`site/src/components/app/access-lifecycle.observer.test.ts:835` uses

```835:845:site/src/components/app/access-lifecycle.observer.test.ts
  const visibleAtEveryWidth = /\.dashboard__roster-dialog-pending\s*\{\s*display: grid;/;
  assert.match(
    dashboard,
    visibleAtEveryWidth,
    "pending rows remain available in the desktop dialog",
  );
```

That pattern matches the `@media (max-width: 52rem)` rule on `a1ef90ff`. Restoring the fold-2 CSS hunk leaves this observer green. The mutation at `:841` only rewrites the first `display: grid` it finds; it does not restore the old desktop hide.

The geometry test at `site/src/components/app/agent-row-geometry.observer.test.ts:179` is the revert check that would fail at 1200px (`display: none`). It did not finish here: Chrome printed the 600px payload and then hung until the 15s `SIGKILL`. Stdout decoded to `{width:600, display:"grid", bounds:584, hiddenDisplay:"none"}`. There is no remaining width query on `.dashboard__roster-dialog-pending`, so 1200px uses the same `display: grid`. CSS in `LiveDashboard.astro:11353-11358` only changes that pending rule (grid, gap, padding, border); other selectors in the hunk are untouched.

### 2. RIGOUR — markup comment still describes the old desktop hide

```1089:1093:site/src/components/app/LiveDashboard.astro
      {/* Pending access lives here only where the rail's own details are hidden:
          at ≤52rem this dialog is the ONLY reachable pending surface, so the
          section must exist — and at desktop the rail keeps it and the dialog
          stays quiet, so there is never a second, competing control. Both lists
          render from the same pendingAccessRows call, so they cannot disagree. */}
```

JS already unhides `[data-dialog-access-section]` with no viewport gate (`LiveDashboard.astro:2180`). The CSS comment at `:11351` is updated; this markup comment is not.

## Ruling check

| Ruling | Implementation | Revert control |
|---|---|---|
| F1 | `supabase/migrations/20260924000001_pending_access.sql:95` `AND issuer_membership.user_id IS NOT NULL`. Fixture seeds a live unexpired code whose issuer membership in A is revoked (`pending-access.test.ts:155-156`, `:223-224`). | Dropping that predicate adds `issuerLeftJoin` (6→7 rows) and breaks `issuer_display === "Pending A"`. |
| F2 | Catalog pins `md5(p.prosrc) = '03e8130f3d20e99106c3b16e58080fa5'` (`20260924000001-catalog.sql:9`), which equals the migration body digest, and ends `AS catalog_ok\n\\gset\n` (`:28-29`). Functional proof finds a live member with `v_count > 0`, then `v_count < 1` for that member and `v_count <> 0` with empty claims (`20260924000001-functional.sql:25-35`). | Changed body → `catalog_ok` is `f`. `IF false` on the early return → empty claims return rows. Always-return / no seed → `no seeded pending row visible to a live member`. |
| F3 | AST of `runMembers` (`tests/p1-cli/pending-access.test.ts:103-130`); AST of every `pendingAgentAccess` in the dashboard script (`access-lifecycle.observer.test.ts:75-110`). Four call sites, all `loadPendingAccess(() => pendingAgentAccess(...))` at script lines corresponding to `LiveDashboard.astro:5705,6212,9113,9157`. | Measured: CLI 7/7 and observer 25/25, including those in-test mutations. |
| F4 | Base `.dashboard__roster-dialog-pending` is `display: grid` at every width; the ≤52rem override is gone. | Geometry test is the width-specific revert check (see finding 1). |
| F5 | `LANE.md` has Fold 1 post-apply (`db:reset`, normal server 1/1), no “not installed” sentence, and an F1–F5 Fold 2 table. | CLI evidence test passed. |

Nothing outside those ten files moved. `git diff --check a1ef90ff..90467bbf` and `origin/main...HEAD` are clean.

VERDICT: PASS
