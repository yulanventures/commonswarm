### Findings

#### 1. [RIGOUR] Broken test assertion in `cli-errors.test.ts` due to unsorted expected array
- **File & line:** `tests/p1-cli/cli-errors.test.ts:61-68`
- **Concrete sequence:**
  The test executes `cswarm login` without credentials or target, triggering `missingTargetError` in [src/cloud/current-target.ts](file:///src/cloud/current-target.ts). The error message outputs 4 URLs: `https://commonswarm.com`, `https://api.commonswarm.com`, `https://api.commonswarm.com`, and `https://commonswarm.com/start`.
  The test evaluates:
  ```ts
  (result.stderr.match(/https:\/\/[^\s),]+/g) ?? []).sort()
  ```
  Calling `.sort()` in JavaScript orders strings lexicographically by code point: `"https://api.commonswarm.com"` (character `'a'` at index 8) sorts strictly before `"https://commonswarm.com"` (character `'c'` at index 8). The evaluated actual array is:
  ```js
  [
    "https://api.commonswarm.com",
    "https://api.commonswarm.com",
    "https://commonswarm.com",
    "https://commonswarm.com/start"
  ]
  ```
  However, the expected array in `assert.deepEqual` was updated to:
  ```js
  [
    "https://commonswarm.com",
    "https://api.commonswarm.com",
    "https://api.commonswarm.com",
    "https://commonswarm.com/start",
  ]
  ```
- **What an agent or user sees:**
  Running `npm run test:p1-cli` (or `node --test tests/p1-cli/cli-errors.test.ts`) fails with an `AssertionError`: element 0 differs (`actual[0] === "https://api.commonswarm.com"` vs `expected[0] === "https://commonswarm.com"`). The Maker's reported gate result (`test:p1-cli 823`) could not have passed with this assertion as written.

---

#### 2. [RIGOUR] Dangling text fragment causing sentence corruption in `Base.astro`
- **File & line:** `site/src/layouts/Base.astro:90-91`
- **Concrete sequence:**
  The replacement in `Base.astro` changed:
  ```diff
  - * Vercel builds set them; that is the ordinary case and the tags are then only a record of
  - * what the bundle already contains.
  + * The site build on the operator machine sets them, then deploy/site/deploy.sh publishes
  + * the files. The tags are then only a record of what the bundle already contains.
  ```
  However, line 90 immediately preceding this replacement ended with `Our own`.
- **What an agent or user sees:**
  An operator reading the frontmatter comment in [site/src/layouts/Base.astro](file:///site/src/layouts/Base.astro#L90-L92) reads the garbled sentence:
  > *"A bundle you intend to hand someone else to point at their own project must therefore be built with both env vars UNSET. Our own The site build on the operator machine sets them, then deploy/site/deploy.sh publishes the files."*

---

#### 3. [RIGOUR] Removal of test rationale documentation regarding completable error paths
- **File & line:** `tests/p1-cli/cli-errors.test.ts:65-70` (in original)
- **Concrete sequence:**
  The lane removed the explanatory comment:
  ```ts
  /* The route must be COMPLETABLE: the hosted command names its key source (the public meta
   * tags on /start), and the discovery path is named first because reaching this message
   * usually means discovery failed. Found by the inversion arm on the api.commonswarm.com
   * change: the URL pin alone stayed green while <key> had no source. */
  ```
- **What an agent or user sees:**
  Future maintainers lose the explicit rationale explaining why the test pins both `/start` (public meta tags providing the anon key) and `discover` in the missing target error message.

---

### Production Assessment
1. **Host Decommissioning & Redirection:**
   - [src/cloud/invite-link.ts](file:///src/cloud/invite-link.ts) correctly refuses links carrying the deleted Supabase host (`https://ukezjcnxjvkpkeezxaew.supabase.co`) with an explicit instruction to request a new invite (`invite link targets retired host... Ask for a new invite.`).
   - Capability links in [src/cloud/capability-link.ts](file:///src/cloud/capability-link.ts) correctly default to `https://commonswarm.com` and explicitly refuse the deleted Vercel host `coswarm-site.vercel.app`. The CLI help and errors clearly document that `/see` returns 404 because the frontend view was never implemented.
   - [src/cloud/config.ts](file:///src/cloud/config.ts) and [src/cloud/current-target.ts](file:///src/cloud/current-target.ts) accurately name `https://api.commonswarm.com` and refer to the service base URL rather than Supabase project URLs.
2. **Citations:**
   - Line numbers in [tests/p1-cli/citation-drift.test.ts](file:///tests/p1-cli/citation-drift.test.ts) were precisely shifted to account for the imports added at line 175 (+2) and the net reduction (-1) at line 984 in [src/cli.ts](file:///src/cli.ts).

However, because `cli-errors.test.ts` contains an assertion guaranteed to fail deep equality on test execution, the test suite is broken.

VERDICT: FAIL - tests/p1-cli/cli-errors.test.ts compares a sorted actual array against an unsorted expected array, causing an AssertionError.
