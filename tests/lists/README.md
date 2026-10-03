Each file here lists the test files one npm script runs: one path per line, `#` comment lines allowed.
`scripts/run-test-list.mjs` refuses missing files and duplicates; the owner of these lists is the CSwarm Lead.
Lanes name new tests in their RESULT and the lead appends them, so parallel lanes never edit the same lines.
