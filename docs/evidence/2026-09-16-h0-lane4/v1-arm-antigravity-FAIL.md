# D-036 Review: H0 Lane 4a (`src/h0/paste.ts`) — Commit `815c422a`

---

## Analysis of Specific Attack Vectors

### 1. Leakage of Credential / Entropy into the URL or Fetch Targets
The check in [`src/h0/paste.ts`](file:///src/h0/paste.ts):
```typescript
const secretBody = input.joinCredential.slice("swm_join_".length);
const carriesSecret = (value: string) =>
  value.includes(input.joinCredential) || value.includes(secretBody);
```
performs a strict, contiguous 43-character exact substring match against `input.documentUrl`, `document.href`, and `decodedDocumentUrl`. This leaves critical leakage channels open:

* **Partial Substrings / High-Entropy Leaks:** Base64url encoding carries 6 bits per character. 43 characters provide ~258 bits of entropy. If a URL contains 42 characters of `secretBody`, 252 bits of entropy leak directly into scanner/previewer logs while only 64 possibilities remain to brute force. `carriesSecret` returns `false` and accepts the URL.
* **Path Normalisation & Split Secrets:** An attacker or buggy caller splitting the secret across path segments (e.g. `/agent-doc/${secretBody.slice(0, 21)}/${secretBody.slice(21)}`) leaks 100% of the credential entropy to every scanner, reverse proxy, and CDN access log. Neither segment matches `secretBody` contiguously, so `carriesSecret` never triggers.
* **Percent-Encoding Error Handling Blindspot:**
  ```typescript
  try {
    decodedDocumentUrl = decodeURIComponent(input.documentUrl);
  } catch {
    decodedDocumentUrl = input.documentUrl;
  }
  ```
  If `input.documentUrl` contains any malformed percent-escape sequence anywhere in the path (e.g. `%FF`, `%80`, or an unescaped `%`), `decodeURIComponent` throws a `URIError`. The `catch` block catches this and sets `decodedDocumentUrl = input.documentUrl`. If `secretBody` is percent-encoded (e.g. `%41` for `A`), `input.documentUrl`, `document.href` (WHATWG URL does not decode percent-encoded unreserved characters in paths), and `decodedDocumentUrl` all retain the percent-encoded form. None match `secretBody`, and the URL is accepted. Furthermore, double percent-encoding (`%2541...`) bypasses `decodeURIComponent` unconditionally.
* **Case Normalisation in Hostnames:** WHATWG URL canonicalization normalizes hostnames to lowercase. Base64url is case-sensitive and contains uppercase letters (`[A-Z]`). If `secretBody` is embedded in a subdomain (e.g. `https://${secretBody}.commonswarm.com/doc`), `document.href` lowercases it. Neither `input.documentUrl` (if passed lowercase) nor `document.href` matches the case-sensitive `secretBody`. The secret is broadcast via plaintext DNS queries and SNI to nameservers and link scanners.
* **Userinfo:** Userinfo is not rejected (`document.username` / `document.password`). If a URL contains `https://swm_join_...@commonswarm.com/agent-doc`, scanners and link unfurlers (e.g., Slack, Discord, crawlers) or HTTP client libraries frequently extract userinfo into HTTP `Authorization: Basic` headers or log it in proxy access logs.

---

### 2. URL Validation Bypasses Leading to Plaintext or Unintended Hosts
* **Arbitrary Host Acceptance & Phishing Userinfo:** [`h0AgentPaste`](file:///src/h0/paste.ts) does not restrict `document.hostname` to Commonswarm origins. A document URL pointing to an attacker host (e.g. `https://evil.com/doc` or `https://commonswarm.com@attacker.com/doc`) passes validation. When fetched, the attacker-controlled document instructs the agent to POST the join credential to the attacker's server.
* **Protocol Downgrade via HTTP Redirects:** [`h0AgentPaste`](file:///src/h0/paste.ts) validates that the initial document URL uses `https:`. However, it does not (and cannot in a pure string generator) prevent the remote HTTPS server from issuing an HTTP 301/302/307 redirect to an unencrypted `http://` endpoint. Standard HTTP clients and AI agent tools follow redirects across protocols by default, exposing the document payload to MITM tampering.
* **Plaintext Loopback Pitfalls:** Allowing `http://127.0.0.1` and `http://localhost` assumes the agent runs in the same environment as the local database. If a human pastes this prompt into a cloud-hosted agent session (Claude Code on remote containers, Codex, Grok), the agent either fails to reach the user's localhost or attempts an SSRF against services running inside the agent provider's own container environment.

---

### 3. Prose Risks to Agent Execution
* **Trailing Semicolon Syntax Trap:**
  ```typescript
  `The single-purpose join credential is ${input.joinCredential}; use it only to ${verb}.`
  ```
  The join credential immediately abuts a semicolon (`;`). LLMs frequently extract unquoted or unbracketed tokens together with adjoining punctuation when parsing natural language. If the agent copies `swm_join_<43_chars>;`, the join request will be rejected by the backend regex `/^swm_join_[A-Za-z0-9_-]{43}$/` due to the trailing `;`.
* **Credential Premature Transmission:** Sentence 1 commands: *"Fetch the agent document at the URL below."* Sentence 2 introduces: *"The single-purpose join credential is ...; use it only to register."* Without an explicit warning stating *"Do not send this credential when fetching the document"*, LLMs frequently attempt to authenticate the document retrieval step itself (e.g., sending `Authorization: Bearer swm_join_...` to the document server), leaking the credential to the document hosting infrastructure.

---

### 4. Audit of Test Suite Fail-States
* **Test 1 (`the whole H0 agent paste matches the reviewed golden text`):**
  Can fail if broken. However, it hardcodes the word `"register"`, which violates the design goal that verbs are never typed literals (if `H0_PREAUTH_VERBS` changes, this test fails on the golden text rather than adapting to the verb table).
* **Test 2 (`a document URL with a query string is refused`):**
  Can fail if query string validation is removed.
* **Test 3 (`a document URL with a fragment is refused`):**
  Can fail if fragment validation is removed.
* **Test 4 (`a document URL containing the join credential is refused`):**
  **Cannot fail independently of Test 8.** Because `input.joinCredential` contains `secretBody`, any URL containing the full credential automatically contains `secretBody`. If the code removes `value.includes(input.joinCredential)` entirely, Test 4 still passes because `value.includes(secretBody)` catches it.
* **Test 5 (`a malformed join credential is refused`):**
  Can fail if regex validation is broken or weakened.
* **Test 6 (`the pre-auth verb is not a string literal in the paste source`):**
  **Cannot fail if string literal rules are evaded.** The AST visitor inspects string and template literal AST nodes against `new RegExp(`\\b${verb}\\b`)`. It will pass if the verb is concatenated (e.g. `"reg" + "ister"`), constructed via character codes, or differs in case (`"Register"`).
* **Test 7 (`a plaintext document URL is refused unless the host is loopback`):**
  **Cannot fail if IPv6 loopback is broken.** The test checks `127.0.0.1` and `localhost`, but never tests `[::1]`. If IPv6 loopback handling in [`src/h0/paste.ts`](file:///src/h0/paste.ts) were deleted, Test 7 would still pass.
* **Test 8 (`a document URL carrying only the secret BODY of the credential is refused`):**
  Can fail if the `secretBody` check is removed. However, it does not test split secrets, partial entropy, or percent-encoding edge cases.

---

### 5. Overclaims in Comments and Commit Message
* **"NEVER in the URL":** The commit message claims *"the credential appears once, in the prose, and NEVER in the URL"*. As demonstrated, URLs carrying 42 characters of entropy (~252 bits), split secrets (`/part1/part2`), or percent-encoded variants bypass validation completely.
* **"HTTPS is now required":** The commit claims this prevents cleartext transmission of the credential. This overclaims: HTTPS document URLs can redirect to HTTP endpoints, and the document itself can specify an HTTP registration URL.
* **"The SECRET BODY as well as the whole credential":** Comment lines 55–58 and the code treat checking both `input.joinCredential` and `secretBody` as two distinct layers of protection. In reality, `input.joinCredential` is `"swm_join_" + secretBody`. Checking `input.joinCredential` is a no-op redundancy when `secretBody` is checked.

---

## Ranked Findings

### [PRODUCTION] P1. Trailing Semicolon Causes Credential Parsing Corruption
* **Location:** [`src/h0/paste.ts:74`](file:///src/h0/paste.ts#L74)
* **Impact:** In the prose template `` `The single-purpose join credential is ${input.joinCredential}; use it only to ${verb}.` ``, the secret credential directly touches a semicolon. LLMs frequently tokenize and copy `swm_join_<token>;`. When submitted to a registration endpoint enforcing `/^swm_join_[A-Za-z0-9_-]{43}$/`, registration fails. The credential should be isolated (e.g., delimited by whitespace, backticks, or on its own line).

### [PRODUCTION] P2. Credential Invariant Bypass via Partial Substrings and Path Segments
* **Location:** [`src/h0/paste.ts:60-67`](file:///src/h0/paste.ts#L60-L67)
* **Impact:** The code checks only `value.includes(secretBody)`. A URL containing a 42-character prefix of the secret leaks ~252 bits of entropy to prefetchers and access logs without detection. Similarly, splitting the secret across path segments (e.g. `/doc/${partA}/${partB}`) leaks 100% of the secret into public server logs while bypassing `carriesSecret`.

### [PRODUCTION] P3. Percent-Encoding Catch-and-Bypass Leaks Secret
* **Location:** [`src/h0/paste.ts:48-54`](file:///src/h0/paste.ts#L48-L54)
* **Impact:** If `documentUrl` contains a malformed percent sequence (e.g. `https://example.com/bad%FF/${encodedSecret}`), `decodeURIComponent` throws and falls back to the raw string. `carriesSecret` is never run against the decoded characters, allowing percent-encoded credentials to pass validation and be fetched by web scanners.

### [PRODUCTION] P4. Host Spoofing and Userinfo Deception
* **Location:** [`src/h0/paste.ts:23-40`](file:///src/h0/paste.ts#L23-L40)
* **Impact:** [`h0AgentPaste`](file:///src/h0/paste.ts) does not reject userinfo or validate the target origin. A document URL such as `https://commonswarm.com@attacker.com/agent-doc` passes validation. The human sees `commonswarm.com` in the paste, but the agent fetches `attacker.com` and registers the join credential with the attacker.

### [RIGOUR] R1. Prompt Ambiguity Regarding Pre-Auth Retrieval
* **Location:** [`src/h0/paste.ts:72-76`](file:///src/h0/paste.ts#L72-L76)
* **Impact:** Presenting the document URL and the join credential in adjacent sentences without explicitly instructing the agent *not* to send authentication headers when fetching the document risks the agent transmitting the credential to the document hosting server/CDN.

### [RIGOUR] R2. Returning Raw Unsanitized URL Instead of Canonicalized `href`
* **Location:** [`src/h0/paste.ts:75`](file:///src/h0/paste.ts#L75)
* **Impact:** The function parses `input.documentUrl` into `document: URL` for validation, but returns `input.documentUrl` verbatim. Any formatting oddities, non-standard path characters, or backslashes normalized by `new URL()` are passed through uncanonicalized.

### [RIGOUR] R3. Test Redundancy and Missing IPv6 Assertions
* **Location:** [`tests/p1-cli/h0-paste.test.ts:37-45, 90-111`](file:///tests/p1-cli/h0-paste.test.ts#L37-L45)
* **Impact:** Test 4 is mathematically redundant with Test 8. Test 7 claims to verify loopback handling but omits `[::1]`. Test 1 hardcodes `"register"`, weakening the decoupled verb abstraction claimed in the commit message.

---

VERDICT: FAIL
The prose appends a trailing semicolon directly to the join credential, causing AI agents to copy a corrupted token that fails backend validation; additionally, the URL secret-leak guard is easily bypassed by partial substrings, split paths, and percent-encoding catch-blocks.
