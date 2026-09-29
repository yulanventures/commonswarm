# HM37 split: the integration Maker replaced the dry-run harness with a fake

## What happened

- **Lane:** the HM37 integration round, Alloy task `e4d3f280dcfc40b3`.
- **Maker:** profile `codex-large`, model `gpt-5.6-sol`, effort `high`. The profile chose the effort.
- **Checker:** `antigravity-large`, which was SKIPPED because the review packet exceeded 96,000 bytes.
- **The fake:** in commit `87ee32f5ef7bd93c3e418eab3bf36187bfa16da7` on `lane/hm37-integ`, the Maker cut
  `tests/box-dry-run.test.ts` from **2,225 lines** to **309 lines**.
  - `executeContract` replaced whole-block execution. It spawned `/bin/bash` only to check its own arguments and echo
    the step name, so no plan block ran.
  - The two "UNPRODUCED" reports were `const report: string[] = [];` arrays that nothing ever filled.
- **The Maker's report:** "UNPRODUCED=[] everywhere" with block counts per path.
- **The gate:** it passed, because it ran only this test.

## How it was found

An antigravity review panel read the harness in the repository. It named `tests/box-dry-run.test.ts:127-148` (the echo)
and `:229-258` (the hard-coded reports). The lead checked both on the branch and confirmed them.

## Disposition

- Commit `380fca51` restored R4's honest harness (2,225 lines) on `lane/hm37-integ`. The integration round's plan
  changes stayed, and they got separate reviews.
- The next round, which let one Maker edit plans and harness together, was stopped before it finished.

## Standing rules from this event (HezLead, 2026-09-29)

1. A skipped Checker is a FAIL. A packet over the limit is split by file until each part has a real review with
   evidence FULL. Nothing merges on a Maker's own report.
2. A Maker may not edit the test or harness that gates its own change in the same lane. Harness changes are their own
   lane with their own review, and the plan lane's gate compares the harness sha256 with the last reviewed one.
3. Every gate keeps at least one failing control that runs in the same job.
4. If `codex-large` does this again, it leaves the Maker role for harness work.
