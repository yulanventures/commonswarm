I'll review commit `f8a1520e` as a D-036 arm: read the change, then try to break the locator claim, the four tests, the edge gate, and the path matcher.Commit is here. Next I’ll read the full diff and the files the tests and path matcher actually touch.I have the commit. Next I’ll check how existing edge functions read `request.url`, and what path the live `/functions/v1/` route actually sees.Path matching and JWT config are the likely production-breakers. I’ll check those next, plus how other functions treat extra path segments.Kong strips `/functions/v1` before the function runs. I’ll mutate the four tests next and check that `check:edge` actually typechecks `h0/core.ts`.The locator property **holds in this file**. `handleH0Request` only uses `pathname` as a boolean `.test()`, never reads headers, query, or body, and never passes a locator into `buildH0AgentDocument`. I could not get a request value into the JSON body without changing that handler.

The function still **cannot serve the public GET**. Tests pin the public URL. The live path is different.

## 1. Locator property — structural, and it holds

`core.ts:117-131` reads `new URL(request.url).pathname` and `request.method` only. `.test()` returns true/false. No capture group is used. `json()` always stringifies the caller-supplied document or a fixed `{ error: ... }` object.

Probe on the committed handler (`SECRETLOC` / `swm_join_…` in path, query, and `Authorization`): body leak = false on every 200. POST body is unread. 404/405/500 bodies are the three fixed error objects.

**It is not merely untested.** A later edit that interpolates `pathname` would break the property. Today that interpolation is absent.

## 2. The four tests — mutated

All four start green. Then I broke one property at a time and ran `env -u FORCE_COLOR node --import tsx --test tests/p1-cli/h0-agent-document.test.ts`. Tree restored after each.

| Mutation | What broke | Result |
|---|---|---|
| M1a gut `fieldSchema` / summaries / `security` | OpenAPI types, summaries, auth | **4/4 green** |
| M1b hardcode the seven path names | builder ignores the table argument | test 1 **fails** (`mutation-control-verb` missing) |
| M2a put locator in the JSON body | locator in body | test 2 **fails** |
| M2b put locator in `x-locator` header | locator in a response header | **4/4 green** |
| M2c put `pathname` only on 404 | leak on the miss path | test 2 green; test 4 **fails** |
| M2d copy `url.search` into the 200 body | query echo (tests send no query) | **4/4 green** |
| M3a `H0_CACHE_CONTROL = "max-age=60"` | cache header | test 3 **fails** |
| M3b 500 response with no cache/robots headers | `internalErrorResponse` | **4/4 green** |
| M3c treat POST like GET | POST on `agent-doc` now 200 | **4/4 green** |
| M4a extra field on 404 body | error shape | test 4 **fails** |
| M4b `method` on 405 body | error shape | test 4 **fails** |
| M-path regex `^/h0/agent-doc/[^/]+$` (the path Kong actually forwards) | matcher matches the live path | test 2 **404≠200**, test 4 **404≠405**, **test 3 still green** |

Test 1’s first asserts restate the builder vs the table it was given. The added-verb block is a real control **only** for “path keys come from `verbs[].name`”. It does not see schemas, summaries, or auth.

Test 2 is a body `includes` + “all bodies identical”. It catches a body leak. It does not see headers or query.

Test 3 checks headers on GET 200, POST, and a 404. It does not check status, so POST-as-GET stays green. It never calls `internalErrorResponse`. If every request 404s, test 3 still passes.

Test 4 is a real control for those two exact cases (`/register` 404 body, DELETE 405 body).

## 3. `check:edge` reaches `h0/core.ts`

Clean: exit **0**, and it prints `Check supabase/functions/h0/index.ts`.

Type error in `supabase/functions/h0/core.ts`:

`TS2322` at `core.ts:2`, exit **1**.

Removed: exit **0**.

The gate follows the import. It is not green next to unchecked code.

## 4. Path matcher — live path is `/h0/…`, tests use `/functions/v1/h0/…`

`AGENT_DOCUMENT_PATH` is `/^\/functions\/v1\/h0\/agent-doc\/[^/]+$/` (`core.ts:115`). Tests construct `https://api.commonswarm.com/functions/v1/h0/agent-doc/…`.

The supabase CLI on this host (`/Users/yulanbot/.local/bin/supabase`, 2.98.2) has Kong:

```
functions-v1: /functions/v1/* -> http://edge-runtime:8081/*
strip_path: true
paths: - /functions/v1/
```

Then the serve worker does `functionName = pathname.split("/")[1]` and `return await worker.fetch(req)` with that same request.

Public URL: `/functions/v1/h0/agent-doc/<locator>`
Function sees: `/h0/agent-doc/<locator>`

Direct call with that internal path: **404** `{error:"not_found"}`. Same document URL the tests use: **200**.

Supabase routing docs match this: paths are prefixed with the function name (`/hello-world`, `/restful-tasks/:id`, Hono `basePath('/${functionName}')`), not `/functions/v1/…`.

M-path above: correcting the regex to `/h0/agent-doc/…` **fails the tests**. The tests lock in the public path. Production 404s. The suite stays green.

This was not established on a live deploy. It was established from the CLI binary Kong template + the serve worker + a direct `handleH0Request` probe.

## 5. Headers on errors

`json()` is the only response builder. 404, 405, 200, and `internalErrorResponse` 500 all go through it.

Probe: 404, 405, and 500 all have `cache-control: no-store` and `x-robots-tag: noindex, nofollow, noarchive`.

Test 3 never hits 500. M3b stayed green.

HEAD and OPTIONS on a matching path are 405 with those headers. Not a leak. Unfurl that sends HEAD still gets 405.

## 6. Other

No `[functions.h0]` in `supabase/config.toml`. The other four functions set `verify_jwt = false`. Default is true. The serve worker then demands a Bearer JWT before the handler runs. An unauthenticated prefetch GET is **401 at the gateway**, even before the 404 from the path regex. I did not run a live gateway.

`fieldSchema` types `wait` / `surfaced` by field **name**, not from the table. M1a stayed green. Parallel catalog.

`npm test` is a literal list. It ran 874 tests and did **not** run the four H0 tests. `test:p1-cli` did (692/692). That is the glob, not a miss in the glob.

HEAD/OPTIONS 405 and a trailing-slash 404 are compatibility, not leaks. I did not count missing register/poll/etc.

## Gates (real exit codes, `env -u FORCE_COLOR`)

| Gate | Exit |
|---|---|
| `npm run build` | 0 |
| `env -u FORCE_COLOR npm test` | 0 (874/874; no H0 agent-document tests) |
| `env -u FORCE_COLOR npm run test:p1-cli` | 0 (692/692; all four H0 tests ran) |
| `npm run check:tests` | 0 |
| `npm run check:edge` | 0 clean; 1 with the core.ts type error |
| `git diff --check` | 0 |

Not established: no live `functions deploy` / `functions serve` HTTP call.

VERDICT: FAIL — Kong strips `/functions/v1`, so the live pathname is `/h0/agent-doc/<locator>` and this regex 404s every real GET while tests keep the public URL and stay green.
