# Sonnet 5.5 Maker baseline — results (2026-09-28)

**Question:** Tom allows Claude Sonnet 5.5 at xhigh as a fallback Alloy Maker when Codex quota is low. This baseline
compares Sonnet 5.5 with the default Codex Maker on three real backlog tasks.

**Setup:** each task had the same spec file, the same base commit (`3f12f651`), the same focused gate
(`gate2.sh`, sha256 `1692785f…ef74`), the same Checker (`antigravity-large`, gemini-3.8-flash-high),
`--max-fix-rounds 2` and `--timeout 2400`. Runs were one at a time, and the 1-minute load average was recorded at each
start.

- **Maker A:** `codex-large` (gpt-5.6-sol), run by CSwarmDevLead.
- **Maker B:** `claude-large-sonnet-5-5` (claude-sonnet-5-5 at xhigh), run by Anvil. Its data file is
  `/Users/yulanbot/baseline-sonnet55/results-b.json`.

The spec hashes and the gate hash matched for all six runs.

## Results

| Task | Maker | Load at start | Maker time | Total time | Rounds | Checker per round | Findings | Gate | Diff | Blind pick |
|---|---|---|---|---|---|---|---|---|---|---|
| t1 rebrand (small) | A codex | 3.52 | 414 s | 741 s | 1 | pass | 0 | pass | 13 files, +126 −12 | |
| t1 rebrand (small) | B sonnet | 3.54 | 566 s | 862 s | 1 | pass | 0 | pass | 13 files, +278 −12 | **B** |
| t2 Linux reader (medium) | A codex | 2.55 | 784 s | 1302 s | 2 | fail, pass | 2, 0 | pass, pass | 4 files, +287 −8 | **A** (after 1 fix) |
| t2 Linux reader (medium) | B sonnet | 3.61 | 1126 s | 1361 s | 1 | pass | 0 | pass | 5 files, +374 −6 | |
| t3 size gate (test-heavy) | A codex | 3.28 | 483 s | 789 s | 1 | pass | 0 | pass | 2 files, +313 −1 | |
| t3 size gate (test-heavy) | B sonnet | 2.15 | 725 s | 966 s | 1 | pass | 0 | pass | 2 files, +582 −1 | **B** |

"Maker time" is the sum of the Maker's duration over all rounds. "Total time" is the Alloy task wall time, which
includes the gates and the Checker.

## Procedure note: both Makers ran their own checks

Anvil marked all three B runs `INVALID_PROCEDURE`, because the Sonnet Maker ran tests and checks outside `gate2.sh`.
The A (Codex) Makers did the same. Their executed-command logs show:

- **t1a:** `gate2.sh` twice, a direct `node --test` of the new test, and a site build plus the `seo-pages` and
  `source-cmd` site tests.
- **t2a:** targeted `node --test --test-name-pattern` runs, `npm run build`, `npm run check:tests`, and `gate2.sh`,
  in both rounds.
- **t3a:** `gate2.sh`, then a direct `node --test` of the new test, twice.

The Codex Maker stderr logs stop at 256 KB, so these lists are a lower bound. The procedure was the same on both
sides, so the comparison is fair. Under the strict rule, all six runs would be `INVALID_PROCEDURE`, not only B.

## Blind comparison and what landed

For each task, one antigravity panel read both diffs as "X" and "Y", with no Maker names. It compared them on
correctness to the spec, test strength, scope, risk to the shared host, and simplicity.

- **t1: B.** No blocking defect. Landed as `fix(rebrand)`.
- **t3: B.** No blocking defect. Landed as `test(files)`.
- **t2: A, with one blocking defect.** A's round 1 made the scan skip foreign `/proc/<pid>/fd` tables that it cannot
  read, so that the check can fire on multi-user Linux hosts. The spec says that permission errors count as
  "unknown", never as "reader gone". A reader owned by another user (for example `sudo tee`) must not be reported
  gone. One Codex fix round applied the spec rule. The full p1-cli suite on CI then found 8 citation and
  timeout-inventory tests that neither Maker's focused gate ran. A second small round updated those citations. The
  final p1-cli run on CI passed 1416 tests with 0 failures. The usefulness gap (the check often cannot decide on multi-user
  hosts) is a follow-up, not a landing blocker. B met the permission rule. The panel named two defects in B: an
  `O_PATH` descriptor counts as a reader, and the CLI path cannot inject a test proc root.

## Reading

- **Quality:** Sonnet 5.5 passed every Checker in one round. Codex needed one fix round on the medium task. In blind
  review, each side won where the other had a real defect. Sonnet 5.5 at xhigh is an acceptable fallback Maker.
- **Speed:** Sonnet was slower on the Maker step on every task: +37 % (t1), +44 % (t2, even with Codex's extra round),
  and +50 % (t3). Its total wall time was 5–22 % higher.
- **Size:** Sonnet wrote larger diffs, mostly in tests: 1.3 to 2.2 times the added lines.
- **Cost:** the Alloy usage meters are shared with other seats and are too noisy for a per-run cost. For example,
  codex/7d fell by 1 % during a B run that did not use Codex. Alloy's usage report has no Claude pool, so the Sonnet
  quota cost was not measured.
- **Limit:** there were three tasks and one run each, so this is a smoke test, not a benchmark. Tom asked for no further
  baseline runs.

## Landed commits

- t1: `fd9dc36c` (B). t3: `c4d32d9e` (B).
- t2: A's result, then the permission fix and the citation update, in three commits with this file.
