### 1. Request Values, Leaks, Per-Locator Divergence, and Mutations

* **No request values reach the response body:** In [`supabase/functions/h0/core.ts:182, 186, 201, 208, 210, 217`](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/supabase/functions/h0/core.ts#L182-L217), all response bodies are either literal static error objects (`{ error: "not_found" }`, `{ error: "method_not_allowed" }`, `{ error: "internal_error" }`), empty/null (`204` preflight, `200` HEAD), or the static `agentDocument`.
* **Structural isolation holds:** `handleH0Request` ([`core.ts:175-215`](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/supabase/functions/h0/core.ts#L175-L215)) inspects `request.url.pathname` solely as a boolean test via `AGENT_DOCUMENT_PATH.test(...)` ([`core.ts:179`](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/supabase/functions/h0/core.ts#L179)). No capture group or locator substring is extracted.
* **No per-locator divergence or leaks:** `request.headers`, `request.body`, and `url.search` are never accessed. Every single-segment locator follows the exact same control path and receives identical output.
* **No mutation:** The handler is a pure function and touches no persistence or global state.

---

### 2. Path Regex and Rejection Behavior

* **Dual shape support:** [`core.ts:173`](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/supabase/functions/h0/core.ts#L173) uses `const AGENT_DOCUMENT_PATH = /^(?:\/functions\/v1)?\/h0\/agent-doc\/[^/]+$/;`. This correctly matches both the public shape (`/functions/v1/h0/agent-doc/<locator>`) and the gateway-stripped shape forwarded by Kong (`/h0/agent-doc/<locator>`).
* **Traversal rejection:** `new URL(request.url).pathname` resolves unencoded dot segments before regex evaluation, collapsing `/h0/agent-doc/..` to `/h0/` (returns 404). Percent-encoded dots (`%2e%2e`) match `[^/]+$` (200), which is safe and benign because the locator is never resolved against a filesystem or database.
* **Trailing slash:** `/h0/agent-doc/<locator>/` ends with `/`, failing `[^/]+$` and returning 404. It strictly enforces the canonical link format without a trailing slash.
* **Nested paths & empty locators:** Nested paths (`/h0/agent-doc/a/b`) contain a `/` after the locator segment, failing `[^/]+$` (404). Empty locators (`/h0/agent-doc/` or `/h0/agent-doc`) fail `[^/]+$` (404).
* **Does it reject anything it should not:** No. All canonical locator paths match; non-canonical or malformed paths return 404.

---

### 3. Headers on Every Response

* **Yes:** [`core.ts:143-155`](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/supabase/functions/h0/core.ts#L143-L155) defines `responseHeaders()`, attaching `cache-control: no-store` and `x-robots-tag: noindex, nofollow, noarchive`.
* Every response path applies these headers:
  * `200` GET via `json()` ([`core.ts:206`](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/supabase/functions/h0/core.ts#L206))
  * `200` HEAD copies `document.headers` from `json()` ([`core.ts:208`](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/supabase/functions/h0/core.ts#L208))
  * `204` OPTIONS passes `responseHeaders()` directly ([`core.ts:186`](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/supabase/functions/h0/core.ts#L186))
  * `404` via `json()` ([`core.ts:182`](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/supabase/functions/h0/core.ts#L182))
  * `405` via `json()` ([`core.ts:201`](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/supabase/functions/h0/core.ts#L201))
  * `500` via `internalErrorResponse()` -> `json()` ([`core.ts:217`](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/supabase/functions/h0/core.ts#L217)), invoked by the catch block in [`supabase/functions/h0/index.ts:19`](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/supabase/functions/h0/index.ts#L19).

---

### 4. Test Rigour Analysis

* **Test 1 ("agent document paths are generated from the H0 verb table", lines 24–57):** Control. Mutates table with `addedVerb` and asserts path presence; fails if path generation ignores table entries.
* **Test 2 ("agent document response never reflects a locator or credential value", lines 59–82):** Control. Fails if any tested locator/credential spelling appears in the response body or if bodies vary across locators.
* **Test 3 ("every H0 response disables caching and indexing", lines 84–101):** Control. Fails if cache/robots headers are altered or missing on GET, POST (405), or 404 paths.
* **Test 4 ("unknown paths and unsupported methods return clean JSON errors", lines 103–121):** Control. Asserts exact statuses and JSON payloads for 404 and 405.
* **Test 5 ("the document is served on BOTH the public path and the gateway-stripped path", lines 123–152):** Control. Verifies both path shapes return 200 with identical bodies; fails if either shape is rejected.
* **Test 6 ("every JSON type the document declares is keyed to a field the table has", lines 154–173):** Control. Asserts `classified == tableFields` (exact partition) and `typed ∩ strings = ∅`. Fails if any field in `H0_VERBS` is unclassified, or if an unknown field is added to `FIELD_JSON_TYPES` or `STRING_FIELDS`.
* **Test 7 ("error responses carry the no-store and robots headers too", lines 175–194):** Control. Tests headers explicitly on 404, 405, and 500 (`internalErrorResponse()`).
* **Test 8 ("HEAD and OPTIONS work, because the link must be safe to UNFURL", lines 196–219):** Control. Verifies HEAD returns 200 with null body and cache headers, OPTIONS returns 204 with allow-methods, and POST/PUT/DELETE/PATCH return 405 with `Allow: GET, HEAD, OPTIONS`.
* **Test 9 ("the public document is readable cross-origin, and nothing else borrows that", lines 221–231):** Control. Asserts `access-control-allow-origin: *` on GET.
* **Name any that cannot fail:** None. All 9 tests are active controls capable of failing upon regression.

---

### 5. Ranked Findings

#### [PRODUCTION]
* *(None)*. The previous blockers (gateway JWT rejection, Kong path stripping 404s, HEAD 405s breaking unfurlers, missing CORS, and missing 405 `Allow` header) are resolved and verified.

#### [RIGOUR]
1. **Outdated test title understates assertion scope in Test 6:**
   * **Location:** [`tests/p1-cli/h0-agent-document.test.ts:154`](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/tests/p1-cli/h0-agent-document.test.ts#L154)
   * **Detail:** The test title `"every JSON type the document declares is keyed to a field the table has"` is a vestige from the earlier inverted test (`declared ⊆ table`). The test was rewritten into an exact partition check (`classified == tableFields` and `typed ∩ strings = ∅`), but the title was not updated to reflect bidirectional totality.
2. **Dead runtime catalog in `core.ts`:**
   * **Location:** [`supabase/functions/h0/core.ts:48-52, 58-60, 63-66`](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/supabase/functions/h0/core.ts#L48-L66)
   * **Detail:** `STRING_FIELDS` is exported only for Test 6 via `stringFieldNames()`. The runtime function `fieldSchema()` never inspects `STRING_FIELDS`; it still falls back to `{ type: "string" }` whenever `declared === undefined`. The partition is enforced solely as a test gate rather than at runtime.
3. **Partition test does not assert uniqueness within `STRING_FIELDS`:**
   * **Location:** [`tests/p1-cli/h0-agent-document.test.ts:167-171`](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/tests/p1-cli/h0-agent-document.test.ts#L167-L171)
   * **Detail:** `classified` wraps `[...new Set([...typed, ...strings])]`. If a field name were accidentally duplicated within `STRING_FIELDS`, `new Set()` would silently collapse it and pass the test.
4. **Header leak blind spot in Test 2:**
   * **Location:** [`tests/p1-cli/h0-agent-document.test.ts:76-78`](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/tests/p1-cli/h0-agent-document.test.ts#L76-L78)
   * **Detail:** Test 2 asserts that forbidden locator spellings do not appear in `body`, but does not inspect response headers.

---

VERDICT: PASS
The structural isolation claim holds, both public and gateway-stripped path shapes route correctly, verify_jwt is disabled, HEAD/OPTIONS/CORS behave as required for unfurls and preflights, and all response paths enforce no-store and robots headers.
