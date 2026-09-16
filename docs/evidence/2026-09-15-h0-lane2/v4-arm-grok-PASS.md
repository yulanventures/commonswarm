I'll review this lane as a D-036 arm: read the commit, attack the locator claim, mutate the four tests, and prove each gate. Starting with the resume file, the SHA, and the H0 function.HEAD is `104f48a7`. Next I’ll dump both SHAs and read the H0 function, tests, and the path/config surfaces.Current SHA is `104f48a7`. Next I’ll read the function, tests, config, and prior arm notes, then start mutation probes.I’ll verify Kong’s real path and the serve worker next, then mutate tests and gates instead of trusting the prior arms.I’ll probe the live gateway path, then mutation-test the handler and the four original tests.Production extra-path requests do reach the function. Next I’ll probe the locator property and mutation-test the suite.Locator property holds on the committed handler. Next I’ll mutate each test’s claimed property and see which stay green.Bound to `104f48a7`. The locator claim holds. I could not get a request value into the response without editing the handler.

No PRODUCTION finding. RIGOUR only, below. This does not buy another round.

## 1. Locator — structural, and it holds

`handleH0Request` (`core.ts:189-225`) reads two things: `new URL(request.url).pathname` as a boolean `.test()`, and `request.method`. No capture group. No `.exec()`. `buildH0AgentDocument` (`core.ts:125-148`) takes `(verbs, description)` only.

`json()` serialises the static document or `{ error: "not_found" | "method_not_allowed" | "internal_error" }`. Headers come from literals in `responseHeaders()` (`core.ts:151-165`). Origin is not copied. Search, body, and request headers are never read.

Probe on the committed handler: secret in path, query, `Authorization`, `Cookie`, and POST body. Leak in body or headers = false on GET, HEAD, OPTIONS, 404, 405. Five locators, one 200 body (6689 bytes). `..` and `.` 404 because the URL parser collapses them first.

A later edit that interpolates `pathname` would break this. Today that interpolation is absent.

## 2. The four tests — mutated

Baseline 9/9 green, then one break at a time, restore after each.

| Mutation | Original 4 | What actually failed |
|---|---|---|
| M1a hardcode the seven path names | test 1 **red** | `mutation-control-verb` missing |
| M1b `wait` type `integer` → `string` | **4/4 green** | **9/9 green** |
| M1c ignore `description` | test 1 **red** | description assert |
| M1d `required` always `[]` | **4/4 green** | **9/9 green** |
| M1e `security` always `[]` | **4/4 green** | **9/9 green** |
| M1f summaries hardcoded | **4/4 green** | **9/9 green** |
| M2a pathname in 200 JSON | test 2 **red** | plus test 5 (bodies differ) |
| M2b pathname in `x-locator` | test 2 **red** | `header reflects …` — this gap is closed |
| M2c echo `url.search` (tests send none) | **4/4 green** | **9/9 green** |
| M2d echo `Authorization` (tests send none) | **4/4 green** | **9/9 green** |
| M2e vary body by pathname **length** | test 2 **green** | test 5 red (public vs stripped length). Test 2’s four spellings are the same length. |
| M3a `H0_CACHE_CONTROL = "max-age=60"` | test 3 **red** | plus tests 7 and 8 |
| M3b POST treated as GET | test 3 **green** (no status check) | test 8 red |
| M3c 500 with no cache/robots | test 3 **green** | test 7 red |
| **M3d OPTIONS 204 with no cache, robots, or ACAO** | **4/4 green** | **9/9 green** |
| M4a extra field on 404 | test 4 **red** | |
| M4b `method` on 405 body | test 4 **red** | |
| M4c 405 without `Allow` | test 4 **green** | test 8 red |

Test 1’s first asserts restate the builder vs the table it was given. The added-verb block is a real control **only** for path keys. Description passthrough is a real control. Types, `required`, summaries, and auth are not.

Test 2 is a real control for a locator substring in the 200 body **and** headers. It does not see query, `Authorization`, or a non-substring divergence.

Test 3 is a real control for those header **values** on GET/POST/404. It does not check status, 500, or OPTIONS.

Test 4 is a real control for those two JSON bodies.

## 3. `check:edge` reaches `core.ts`

Clean: exit **0**, prints `Check supabase/functions/h0/index.ts`.

Type error on line 1 of `supabase/functions/h0/core.ts`: `TS2322`, exit **1**.

Removed: exit **0**.

## 4. Path matcher

Regex (`core.ts:187`): `/^(?:\/functions\/v1)?\/h0\/agent-doc\/[^/]+$/`

Public-only (the v1 bug): tests 5 and 8 red. Stripped-only: tests 2, 4, 5 red. Suffix-only `/agent-doc/[^/]+$`: **9/9 green**.

Live GET on this project (`ukezjcnxjvkpkeezxaew`): `/functions/v1/command/agent-doc/abc` reached the **command** function (405 from the function, `x-deno-execution-id` present), not gateway `NOT_FOUND`. Extra segments are forwarded. No `apikey` did not 401. `h0` itself is not deployed (`{"code":"NOT_FOUND","message":"Requested function was not found"}`).

Not established: the exact pathname **string** a hosted `h0` worker would see. Both shapes the regex matches are the two the docs and the local Kong template describe.

## 5. Headers on errors

`json()` is the only body builder. Probe: 404, 405, 500 all have `cache-control: no-store` and `x-robots-tag: noindex, nofollow, noarchive`. Test 7 pins 404, 405, and `internalErrorResponse()`. OPTIONS uses `responseHeaders()` in code; **no test pins that** (M3d stayed green).

## RIGOUR (not PRODUCTION)

1. **OpenAPI body besides path keys and description is untested.** `wait` as string, empty `required`, empty `security`, fake summaries: 9/9 green. Same class of hole as the sibling’s “agrees by construction”, one layer down in the generator.
2. **OPTIONS preflight headers are untested.** Strip cache/robots/ACAO from OPTIONS only: 9/9 green. A browser preflight would fail; unfurlers do not use CORS.
3. **The runtime throw in `fieldSchema` (`core.ts:64-73`) has no isolated control.** Delete it: 9/9 green, because every current field is already classified. Add an unclassified table field: throw **and** the partition test both fire.
4. Test 9’s name says “nothing else borrows that”. It only checks this GET has `*`.
5. The commit text says the word “locator” appears in one comment. It appears in three (`core.ts:124, 177, 179`). The structural claim is still true.
6. `npm test` does not run these nine tests (literal list). `test:p1-cli` does (glob). That is the AGENTS.md rule, not a miss in the glob.

## Gates (`env -u FORCE_COLOR`)

| Gate | Exit |
|---|---|
| `npm run build` | 0 |
| `npm test` | 0, 874/874 (no H0 agent-document tests) |
| `npm run test:p1-cli` | 0, 697/697 (all nine H0 tests ran) |
| `npm run check:tests` | 0 |
| `npm run check:edge` | 0 clean; 1 with the `core.ts` type error |
| `git diff --check` | 0 |

Not established: no `functions deploy` of `h0`. No live GET that returned this document.

What you do now: land it. RIGOUR can be fixed in place. It does not need another arm round.

VERDICT: PASS — locator isolation is structural; both path shapes are pinned; no production defect on this SHA.
