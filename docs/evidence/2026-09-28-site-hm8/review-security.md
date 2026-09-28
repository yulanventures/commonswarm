# Security Review: CommonSwarm Static Site Release Plan (HM Lane 8)

**Target Release SHA:** `8b8989f2b29e440a317a2cdedf11195901c8342c`
**Plan Document:** [`prompt.md`](local path) (`SITE-RELEASE.md`)
**Scope:** Read-only security audit of production site release plan and release SHA code artifacts.

---

## Security Audit Evaluation

### 1. Secret Handling & Credentials Logging
* **Criteria:** No step prints, echoes, logs, or places in `argv` the anon key, service-role key, tokens, or passwords.
* **Finding: PASS.**
  * Step `site-01` ([prompt.md#L58-L78](local path)) executes SSH read-only path/hash inspection without exposing credentials.
  * Step `site-03` ([prompt.md#L283-L339](local path)) validates `site/.env` and outputs only boolean/PASS indicators (`PASS: runtime, environment permissions, URL, anon role and H0 setting`).
  * Step `site-04` ([prompt.md#L382-L426](local path)) unsets inherited env overrides (`env -u PUBLIC_SUPABASE_URL ...`) before invoking `deploy.sh`.
  * Step `site-05` ([prompt.md#L441-L491](local path)) explicitly avoids printing HTML containing anon keys and logs only SHA256 hashes and path names ([prompt.md#L493](local path)).

---

### 2. Environment Verification & ANON JWT Proof
* **Criteria:** Plan proves `site/.env` contains a valid `anon` role JWT (never `service_role`) without printing the secret.
* **Finding: PASS.**
  * Step `site-03` ([prompt.md#L318-L326](local path)) parses `PUBLIC_SUPABASE_ANON_KEY`, decodes the 3-part base64url payload, and asserts `payload?.role === "anon"`.
  * `deploy/site/validate-site-env.mjs` ([validate-site-env.mjs#L31-L48](local path)) explicitly checks for 3 JWT segments and rejects `payload?.role === "service_role"`.

---

### 3 & 4. Account Safety & Browser Control Restrictions
* **Criteria:** Controls must not sign in as Tom or press global Sign out; controls must restrict workspace strictly to `Cold Agent Test` (`c2ea0541-f56d-4c73-bf71-56c5405c4934`).
* **Finding: PASS.**
  * Section 5 ([prompt.md#L497-L506](local path)) explicitly mandates using a task-owned tab in a dedicated test account context, stating: *"Never navigate an existing Tom tab, use Tom’s account, or press the web Sign out control; it is global."*
  * Workspace selection is explicitly restricted to `Cold Agent Test — c2ea0541-f56d-4c73-bf71-56c5405c4934` ([prompt.md#L501-L506](local path)).

---

### 5. Server-Side Dependency & Public Feature Exposure
* **Criteria:** Features exposed without flags must explain why exposure is safe or hold deployment until server-side capabilities are verified live.
* **Finding: PASS.**
  * Section 2 ([prompt.md#L239-L248](local path)) documents that the Connected Apps dialog is a management-only view (listing and revoking existing connections/seats without creation or OAuth flows).
  * Section 3 ([prompt.md#L257-L275](local path)) defines mandatory pre-deployment holds requiring verification of server-side HM2 migrations (`20260928000002_hm_hosted_authority.sql`), database views, and edge command handlers before GO.

---

### 6. Connected Apps View Authorization & Revocation Security
* **Criteria:** Verify `site/src/lib/connected-apps.ts` ensures user isolation (no cross-tenant data leak or unauthorized revocation).
* **Finding: PASS.**
  * Data Loading: `loadConnectedApps` ([connected-apps.ts#L88-L105](local path)) selects from `swarm_read.hosted_mcp_connections` and `swarm_read.hosted_mcp_seats`. These views filter by `owner_user_id = auth.uid()` via PostgreSQL RLS ([prompt.md#L264-L265](local path)).
  * Revocation Execution: `revokeConnectedAppGrant` and `revokeConnectedAppSeat` ([connected-apps.ts#L113-L145](local path)) require an active `session: Session` and issue `postCommand` ([commonswarm.ts#L516-L542](local path)), passing `session.access_token` for server-side JWT authentication.

---

### 7. Rollback Safety
* **Criteria:** Rollback must cleanly restore the previous release without side effects.
* **Finding: PASS.**
  * Step `site-06` ([prompt.md#L544-L581](local path)) performs an atomic symlink swap (`ln -s "$previous" "$root/current.next"` & `mv -Tf "$root/current.next" "$root/current"`) targeting the verified `previous.release` path.

---

### 8. Deletion Safety & Execution Guards (Round-2 Verification)
* **Criteria:** Verify deletion guards (`guarded_delete`, `resolve_delete_path`) in deployment scripts at release SHA `8b8989f2` and confirm test suite coverage.
* **Finding: PASS.**
  * **Code Verification:**
    * [`deploy/site/deploy.sh`](local path) contains `resolve_delete_path` and `guarded_delete`. All deletions ([deploy.sh#L248](local path), [deploy.sh#L266](local path)) route through `guarded_delete`.
    * [`deploy/site/finalize-release.sh`](local path) routes all release prunes through `guarded_delete` ([finalize-release.sh#L166](local path), [finalize-release.sh#L176](local path), [finalize-release.sh#L201](local path), [finalize-release.sh#L211](local path)).
  * **Test Coverage:** [`tests/p1-cli/site-deletion-safety.test.ts`](local path) asserts that all `rm -rf` calls in both scripts match `rm -rf -- "$resolved_target"` inside `guarded_delete`.
  * **Plan Deletion Hold:** The release plan ([prompt.md#L356-L358](local path)) explicitly specifies that the execution hold lifts upon verifying that both deletion safety guards and their test suite exist at target release SHA `8b8989f2`.

---

## Nits

1. **Regex Short SHA in Python Check:** In step `site-05` ([prompt.md#L453-L455](local path)), the sample Python script asserts release folder regex containing static sample SHA `79f70b7d77b2`. When executing against target release SHA `8b8989f2b29e440a317a2cdedf11195901c8342c`, Anvil must ensure the assertion string uses short SHA `8b8989f2b29e`.

---

VERDICT: PASS (no KEEP)