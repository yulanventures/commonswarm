# Lane 3 RESULT

RESULT: PASS — implementation and local acceptance validation; external report placement blocked.

Branch `lane/c1b-controls-seat`, unchanged HEAD `7efbb67df10abec01c624deb4e89a05a0badfc49`. No commit by dispatch instruction.

The producer now requires a strict `--controls-pass` for every window claim/replay. Its seat name and request id are constant within a pass and differ across passes at the same release. The private report records `controls_pass`; binding receipt keys stay unchanged.

Validation: 159 producer checks and 16 cross-plan checks passed. Root tsc and edge checks passed. `check:tests` remains exit 2 with the same 54 diagnostics, byte-identical to baseline. Generated protocol has no drift; src/supabase freeze and diff whitespace checks passed. No services, browser, production operation, workflow or Alloy run.

Full report: [lane-3-controls-seat-REPORT.md](lane-3-controls-seat-REPORT.md). It includes formats, a worked example, hosted bounds, validation exits, 37 direct external window caller files, four indirect staging drivers, and the complete 233-file external match inventory. These external directories were not edited.

BLOCKED by sandbox: "[Errno 1] Operation not permitted: '/Users/yulanbot/work/c1-frozen-resume/build-b/reports'". To resolve: HezLead copies the report to `/Users/yulanbot/work/c1-frozen-resume/build-b/reports/lane-3-controls-seat-REPORT.md`.

Next: HezLead updates external window invocations and P-5 selectors, arranges cross-family review and CI, and integrates the three-file patch. Two additional evidence files are written under this directory as the dispatch directs; no commit or staging was performed.
