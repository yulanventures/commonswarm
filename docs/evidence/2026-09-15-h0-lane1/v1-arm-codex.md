Findings:

- [P1] (confidence 10/10) `src/h0/verbs.ts:68-69` — ACK’s table is wrong. `last_error_code` is required by `durable-delivery.ts:63-69` and unconditional in `command/index.ts:1594-1597`. The table calls it optional. The accepted optional `surfaced` field is also absent.
- [P1] (10/10) `tests/p1-cli/h0-verbs.test.ts:34-43` — The test checks table → document, opposite its name. Changing ACK to `required: ["signal_id"]` and `optional: ["made_up_field"]` still passed 8/8. Adding an unlisted `admin_token` to every generated field list also passed 8/8.
- [P1] (10/10) `tests/p1-cli/h0-verbs.test.ts:45-50` — The secret control only rejects `joincredential:`. Adding `Join credential = TEST_SECRET_VALUE.` to the document passed 8/8.
- [P1] (10/10) `tests/p1-cli/h0-verbs.test.ts:71-86` — The leaf rule is true, but its regex is not a valid control. A single-quoted relative `.js` import passed 8/8 and `tsc`, while the Deno probe failed with TS2307 and exit 1.
- [P2] (10/10) `src/h0/verbs.ts:15` — The claimed `verbs-vs-wire.check.ts` does not exist at this SHA (`git cat-file` exit 128). Its copy on the spec branch checks verb names only, not fields.
- [P2] (10/10) `src/h0/verbs.ts:4-5,37-40` — Comments claim the dispatcher and paste already read this table. They do not. I did not count the known unserved document as a defect; the current-tense claim is still false.

Control audit:

| Test | Result |
|---|---|
| 1 | Real table → document inclusion check; no independent correctness |
| 2 | Real only for lines matching `POST [a-z-]+ ` |
| 3 | Not a control for its named property; direction is reversed |
| 4 | Not a secret-leak control |
| 5 | Real pre-auth-set control |
| 6 | Real seven-name pin; its separate count check is redundant |
| 7 | Real but narrow resolver control |
| 8 | Not a leaf-module control |

The other six verb shapes agree with the H0 spec’s adapter-level shape. ACK is the only one directly comparable with existing exact enforcement, and it already disagrees.

Gates passed: build 0; `npm test` 0, 874/874; `test:p1-cli` 0, 686/686; `check:tests` 0; `check:edge` 0; `git diff --check` 0. The full P1 run printed all eight H0 test names. Root `npm test` printed none of them and did print its positive control.

The clean Deno probe importing `src/h0/verbs.ts` passed with exit 0. All temporary mutations and the probe were removed; the worktree is clean.

VERDICT: FAIL — ACK’s generated contract is already wrong, and three claimed controls stay green when their named properties are broken.
