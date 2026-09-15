### Design Claim Evaluation
**The structural isolation claim holds.**
In [`supabase/functions/h0/index.ts:10-17`](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/supabase/functions/h0/index.ts#L10-L17), `buildH0AgentDocument` is invoked once at module top-level with only `(H0_VERBS, h0AgentDocumentDescription())`; it accepts no request or locator parameter ([`core.ts:92-95`](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/supabase/functions/h0/core.ts#L92-L95)). In [`supabase/functions/h0/core.ts:148-162`](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/supabase/functions/h0/core.ts#L148-L162), `handleH0Request` tests `AGENT_DOCUMENT_PATH.test(...)` purely as a boolean predicate on `request.url.pathname`. The locator is never captured, extracted, or passed downstream. On success, the static pre-built document is returned directly.

---

### Answers to Required Questions

#### 1. Request values reaching response, per-locator divergence, leaks, or mutations
* **No request values reach the response body:** In [`supabase/functions/h0/core.ts:126-131`](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/supabase/functions/h0/core.ts#L126-L131), `json()` only serializes the static `agentDocument` or hardcoded literal error records (`{ error: "not_found" }` at line 156, `{ error: "method_not_allowed" }` at line 159, `{ error: "internal_error" }` at line 165).
* **No per-locator divergence:** Every single-segment locator (`[^/]+`) follows the exact same control path and returns the identical 200 body.
* **No query, header, or body leaks:** `request.headers`, `request.body`, and `url.search` are never inspected or referenced.
* **No mutation:** The handler is side-effect-free and touches no storage or state.

#### 2. Path regex correctness and rejections
* **Dual shape support:** In [`supabase/functions/h0/core.ts:146`](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/supabase/functions/h0/core.ts#L146), `const AGENT_DOCUMENT_PATH = /^(?:\/functions\/v1)?\/h0\/agent-doc\/[^/]+$/;` correctly matches both the public path (`/functions/v1/h0/agent-doc/<locator>`) and the gateway-stripped path (`/h0/agent-doc/<locator>`).
* **Traversal rejection:** `new URL(request.url).pathname` ([`core.ts:153`](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/supabase/functions/h0/core.ts#L153)) resolves unencoded dot-segments (`..` and `.`) before matching, collapsing `/h0/agent-doc/..` to `/h0/` (404). Percent-encoded dots (e.g. `%2e%2e`) match `[^/]+$`, but since the locator is never resolved against a filesystem or database, this is benign.
* **Nested paths & empty locators:** Nested paths (`/h0/agent-doc/loc/sub`) contain `/` and are rejected (404). Empty locators (`/h0/agent-doc/`) fail `[^/]+` and are rejected (404).
* **Trailing slash:** A trailing slash (`/h0/agent-doc/<locator>/`) fails `[^/]+$` and returns 404. It strictly enforces the canonical link format, though any client or bot that normalizes URLs by adding a trailing slash will 404.

#### 3. Headers on EVERY response
* **Yes:** In [`supabase/functions/h0/core.ts:118-131`](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/supabase/functions/h0/core.ts#L118-L131), `responseHeaders()` unconditionally attaches `cache-control: no-store` and `x-robots-tag: noindex, nofollow, noarchive`.
* Every response in `handleH0Request` (200 at line 161, 404 at line 156, 405 at line 159) and unhandled worker exceptions via `internalErrorResponse` (500 at line 165, called in `index.ts:19`) routes through `json()`.

#### 4. Test analysis: Controls vs. Restatements vs. Cannot Fail
* **Test 1 ("agent document paths are generated from the H0 verb table", lines 23–56):** **Control.** Dynamically introduces `addedVerb` into `mutatedTable` and asserts the document path list grows; would fail if paths were hardcoded. (Blind spot: checks only path keys, not verb bodies, HTTP methods, or schemas).
* **Test 2 ("agent document response never reflects a locator or credential value", lines 58–81):** **Control.** Would fail if any tested spelling leaked into the response body. (Blind spot: checks only the response body; a leak into a response header would pass).
* **Test 3 ("every H0 response disables caching and indexing", lines 83–100):** **Control.** Would fail if cache/robots headers were altered or missing on the 3 requests tested. (Blind spot: does not assert status codes; a 200 on POST would pass).
* **Test 4 ("unknown paths and unsupported methods return clean JSON errors", lines 102–120):** **Control.** Checks exact status codes and strict error JSON objects for 404 and 405.
* **Test 5 ("the document is served on BOTH the public path and the gateway-stripped path", lines 122–151):** **Control.** Verifies status 200 and identical bodies for both shapes; would fail if either path shape regressed.
* **Test 6 ("every JSON type the document declares is keyed to a field the table has", lines 153–162):** **CANNOT FAIL for its claimed purpose.** It iterates over `fieldJsonTypeNames()` asserting `tableFields.has(name)`. It asserts only `declaredKeys ⊆ tableKeys`. If a new field is added to `H0_VERBS` and omitted from `FIELD_JSON_TYPES`, **this test cannot fail**, and the field will silently default to `"string"` via `core.ts:41-43`.
* **Test 7 ("error responses carry the no-store and robots headers too", lines 164–179):** **Control.** Exercises 404, 405, and 500 (`internalErrorResponse()`), verifying header presence on all error paths.

#### 5. Other defects
* **Comment & commit message claiming more than the code does:** [`core.ts:27-28`](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/supabase/functions/h0/core.ts#L27-L28) and the commit message state that the catalog is "made total" and "a test asserts it covers every field the table declares, so a new field cannot silently default to 'string'". As shown in Question 4, Test 6 checks the inverse subset; the catalog is not total and new fields *will* silently default to `"string"`.
* **Deployment boundary violation:** [`supabase/functions/h0/index.ts:6-9`](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/supabase/functions/h0/index.ts#L6-L9) imports directly across the deployment boundary (`from "../../../src/h0/verbs.ts"`).
* **Missing HTTP `Allow` header on 405:** [`core.ts:158-160`](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/supabase/functions/h0/core.ts#L158-L160) emits 405 without the `Allow: GET` header required by RFC 9110 §15.5.6.
* **No CORS support:** [`core.ts:118-124`](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/supabase/functions/h0/core.ts#L118-L124) lacks `Access-Control-Allow-Origin: *`.

---

### Ranked Findings

#### [PRODUCTION]
1. **Unfurler/crawler failure on `HEAD` requests:**
   * **Location:** [`supabase/functions/h0/core.ts:158-160`](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/supabase/functions/h0/core.ts#L158-L160)
   * **Issue:** `if (request.method !== "GET")` returns 405 `method_not_allowed`. Link unfurlers and social preview bots (Slack, Discord, Twitter/X, etc.) often issue `HEAD` requests before `GET` to inspect headers (`content-type`, `cache-control`). Returning 405 breaks unfurling for those bots, contradicting the core requirement that the link be safe to unfurl.
2. **Missing CORS headers blocks browser agents & OpenAPI viewers:**
   * **Location:** [`supabase/functions/h0/core.ts:118-124, 158`](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/supabase/functions/h0/core.ts#L118-L124#L158)
   * **Issue:** No `Access-Control-Allow-Origin: *` header is emitted, and preflight `OPTIONS` requests receive 405. Any browser-based agent, web client, or browser OpenAPI viewer (Swagger/Scalar/Redoc) will be blocked by browser CORS policy.
3. **Cross-boundary import breaks standalone Supabase Edge Function bundling:**
   * **Location:** [`supabase/functions/h0/index.ts:6-9`](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/supabase/functions/h0/index.ts#L6-L9)
   * **Issue:** `index.ts` imports from `../../../src/h0/verbs.ts`. In edge function deployments (`supabase functions deploy h0`), the build context is scoped to `supabase/functions/`. Unlike `command` which uses an esbuild step to output to `supabase/functions/_shared/protocol.js` ([`package.json:19`](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/package.json#L19)), `h0` relies on an unbundled traverse outside the edge function tree.

#### [RIGOUR]
1. **Inverted assertion in Test 6 permits silent `"string"` defaults:**
   * **Location:** [`tests/p1-cli/h0-agent-document.test.ts:153-162`](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/tests/p1-cli/h0-agent-document.test.ts#L153-L162), [`supabase/functions/h0/core.ts:26-28`](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/supabase/functions/h0/core.ts#L26-L28)
   * **Issue:** The test asserts `fieldJsonTypeNames() ⊆ tableFields` instead of `tableFields ⊆ fieldJsonTypeNames()`. The comment claims it prevents fields from silently defaulting to `"string"`, but new non-string fields added to `H0_VERBS` will silently default to `"string"` without failing the test.
2. **RFC 9110 violation on 405 responses:**
   * **Location:** [`supabase/functions/h0/core.ts:158-160`](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/supabase/functions/h0/core.ts#L158-L160)
   * **Issue:** HTTP specification mandates that a 405 response must include an `Allow` header indicating valid methods (e.g. `Allow: GET`).
3. **New test file excluded from standard `npm test` script:**
   * **Location:** [`package.json:23`](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/package.json#L23)
   * **Issue:** `npm test` specifies an explicit list of test files and omits `tests/p1-cli/h0-agent-document.test.ts`. The new tests only run when `npm run test:p1-cli` is explicitly invoked.

---

VERDICT: FAIL
`HEAD` requests return 405 (breaking link unfurlers), browser CORS is absent, edge deployment imports outside `supabase/functions`, and Test 6 fails to enforce the totality claim made in comments and commit history.
