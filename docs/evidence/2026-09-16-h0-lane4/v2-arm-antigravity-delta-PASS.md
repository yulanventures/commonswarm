### Threat Model Assessment
The adopted threat model is **sound for this product**. Because `documentUrl` is constructed internally by the application from a random locator independent of the credential, an external attacker choosing the URL would already have full control over the paste contents. Treating the URL guard as defense-in-depth against developer coding mistakes rather than hostile external input is appropriate.

---

### Questions

1. **Within the stated threat model, can secret material still reach the returned URL?**
   **Yes**, under specific coding mistakes:
   - *Sub-12-character slices:* `SECRET_WINDOW = 12` (`src/h0/paste.ts:26`). A coding mistake taking an 8–11 character slice of the secret body (carrying up to 66 bits of entropy) passes completely undetected (`tests/p1-cli/h0-paste.test.ts:89`).
   - *Chunked/segmented splits:* If a mistake splits the secret across directory segments or hyphenated chunks under 12 characters (e.g. `/doc/${chunk1}/${chunk2}/...` with 8–10 character chunks), the `/` breaks continuity. Because `secretBody` contains no `/`, no 12-character window will match, allowing the entire secret to appear in the URL.
   - *Prefix + body slice:* A coding mistake inserting `swm_join_` plus up to 11 characters of the body (20 characters total) passes because `JOIN_CREDENTIAL_PREFIX` is stripped before window matching (`src/h0/paste.ts:92`).

2. **Is the 12-character window sound — any realistic false positive on an ordinary URL, or a realistic miss?**
   - *False Positives:* **Sound.** Case-folded base64url characters have ~5.17 bits of entropy each (~62 bits for 12 chars). With 32 secret windows checked against ~90 URL positions, the collision probability against a random locator is astronomical (~$6 \times 10^{-16}$), and dictionary collisions with 12-letter English words in static paths are negligible.
   - *Realistic Misses:* Any coding mistake using short identifier slugs (8–11 characters) or standard chunked path structures ($< 12$ chars per segment) will be missed.

3. **Is the new prose safe for an AI agent: could it misread which value is the credential, send the credential when fetching the document, or send it anywhere other than the one verb named?**
   **Yes, it is safe:**
   - *Credential misreading:* The credential sits isolated on its own line without punctuation (`src/h0/paste.ts:114`), prefixed with `swm_join_`, fixing the semicolon-capture bug from the previous review.
   - *Fetching document:* Prevented by explicit negative instruction: `"; fetching it needs no credential."` (`src/h0/paste.ts:112`).
   - *Verb restriction:* Explicitly constrained: `"Then call ${verb} once, sending only this single-purpose join credential:"` (`src/h0/paste.ts:113`).

4. **Could any test pass while the property it names is broken?**
   **Yes.** `test("secret material in the URL is refused in every shape a coding mistake could produce")` (`tests/p1-cli/h0-paste.test.ts:74`) passes while its named property is broken. It only tests splits and slices where every piece is $\ge 12$ characters (`SECRET_BODY.slice(0, 21)` and `SECRET_BODY.slice(21)`). A split into segments under 12 characters or a slice under 12 characters is not refused.

5. **Does the commit message claim anything the diff does not do?**
   **Yes:**
   - The commit message claims the 12-character window *"covers a partial secret and one split across segments"* (`git show 08fd67f6`). The diff only covers partial secrets and segments that contain at least 12 contiguous characters of the body.
   - The source comment claims the guard covers *"a partial prefix"* (`src/h0/paste.ts:20`), but `JOIN_CREDENTIAL_PREFIX` is stripped immediately (`src/h0/paste.ts:92`), so prefix fragments are never checked.

---

### Findings

#### PRODUCTION
*(None. In deployed execution, the app generates canonical HTTPS URLs with independent random locators, isolates the token from prose punctuation, forbids credentials on document fetch, and rejects userinfo, query strings, fragments, and plaintext HTTP).*

#### RIGOUR
1. **RIGOUR: Overclaimed test coverage.** `tests/p1-cli/h0-paste.test.ts:74` claims to verify secret refusal *"in every shape a coding mistake could produce"*, but its split-segment test only exercises slices $\ge 12$ characters, masking that sub-12 character chunks pass.
2. **RIGOUR: Commit message and code comment overclaims.** The commit message and `src/h0/paste.ts:20` claim the guard covers *"a secret split across path segments"* and *"a partial prefix"*. The diff only matches contiguous 12-character windows of the body and strips the prefix entirely.
3. **RIGOUR: Prose ordering under colon.** In `src/h0/paste.ts:111-116`, the URL is placed at line 4 beneath line 2's introductory colon (`"...sending only this single-purpose join credential:\n<credential>\n<url>"`), rather than grouping the URL directly with the fetch instruction on line 1.

VERDICT: PASS
Reason: The production blocker from the previous review (token extraction failure due to trailing semicolon and credential leakage risk on fetch) is fully resolved, and all new findings are rigour and documentation issues within a sound threat model.
