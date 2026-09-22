### D-036 Review: Part F1b of 5 (`lane/doc-box-production` at `aaa8a914ffb24fe364a88b46094d9da3014bad5d`)

#### Scope of Part F1b
- `AGENTS.md`
- `SUCCESSION-PLAN.md`
- `TODO.md`
- `deploy/edge-runtime/commonswarm.caddy` (deleted)
- `deploy/supabase-stack/commonswarm-api-fallback.caddy` (deleted)
- `deploy/supabase-stack/LOCAL-REHEARSAL.md`
- `deploy/supabase-stack/MUTATION-EVIDENCE.md`
- `deploy/supabase-stack/RUNBOOK.md`
- `deploy/supabase-stack/VERSIONS.md`
- `docs/design/2026-08-18-FILE-ARTIFACTS.md`

---

### Detailed Analysis by File

1. **`AGENTS.md`**
   - **Production Architecture**: Updated from hosted Supabase (`cloud-swarm-dev`) and Vercel to one Hetzner server (`yulan-vps-1` in Falkenstein) hosting both `api.commonswarm.com` and `https://commonswarm.com`.
   - **Operational Guards**: Explicitly forbids running `supabase db push`, `supabase functions deploy`, `supabase link`, `--linked`, `supabase projects api-keys`, and `vercel deploy`.
   - **Unestablished Procedures**: Clearly states that schema migrations and stack/edge updates have no established deployment procedure yet, pointing to `docs/org/2026-09-22-PRODUCTION-BOX-RESUME-HERE.md`.
   - **Site Deployment**: Replaced Vercel deployment instructions with `deploy/site/deploy.sh yulan-vps-1`, detailing environment validation (`validate-site-env.mjs`), rsync release staging, `finalize-release.sh` symlink flipping (`ln -sfn` + `mv -Tf`), dry-run flags, rollback instructions, and verification `curl` commands.
   - **Assessment**: Accurate, complete, and prevents agent misuse of deleted third-party platforms.

2. **`SUCCESSION-PLAN.md` (Round 2 Finding Fix)**
   - **Resolution**: Opens with an unambiguous historical disclaimer:
     > *"This file is a historical log. Production is the box. See the newest `docs/org/*-RESUME-HERE.md`. Never run the Supabase or Vercel steps in this file.*
     > 
     > ***Do not follow this file.** It is a record of an earlier lead handoff. A new lead does not adopt the protocol below."*
   - **Assessment**: Neutralizes the hazard identified in Round 2 where a new lead following the document would execute destructive or invalid Supabase/Vercel operations on deleted projects.

3. **`TODO.md`**
   - **Item 1 & Superseded Canonical Host**: Removes assertions that `coswarm-site.vercel.app` returns 200 or that renaming the Vercel project is pending; confirms `coswarm-site` is deleted and Caddy on `yulan-vps-1` serves static files.
   - **Item 5 (Region)**: Confirms the production database is in Falkenstein, Germany; instructs not to inspect Supabase dashboards; defers privacy page text to the owner.
   - **Item 11 (SMTP)**: Updates status to Resend SMTP on the server, noting server send rate is not established while retaining unverified inbox return-leg status.
   - **Assessment**: Accurately synchronizes tracking items with single-box reality.

4. **`deploy/edge-runtime/commonswarm.caddy` & `deploy/supabase-stack/commonswarm-api-fallback.caddy`**
   - Both files proxying upstream traffic to `ukezjcnxjvkpkeezxaew.supabase.co` are deleted.
   - **Assessment**: Completely eliminates dead upstream fallback configurations from the tree.

5. **`deploy/supabase-stack/LOCAL-REHEARSAL.md`**
   - Item 14 updated to record the 2026-09-22 deletion of both the fallback file and the pre-cutover edge file, stating that no fallback to another host exists and that pauses/recovery use `commonswarm-api-maintenance.caddy` (returning 503 with no upstream).
   - **Assessment**: Accurate historical documentation.

6. **`deploy/supabase-stack/MUTATION-EVIDENCE.md`**
   - Documents test mutants for:
     - Catching `supabase.co` host references anywhere in `deploy/**/*.caddy`.
     - Verifying public maintenance site has no `reverse_proxy` upstream.
     - Verifying staging maintenance site retains `import box_routes`.
     - Verifying presence of `Retry-After: 300` in public maintenance responses.
   - **Assessment**: Correctly records the gate coverage introduced in fold `aaa8a914`.

7. **`deploy/supabase-stack/RUNBOOK.md` (Round 2 Finding Fix)**
   - **Status Header**: Marked as completed cutover; notes commands are historical records of the window; notes schema migration procedure is not established.
   - **Storage URL Cleanup**: Removes dead `SOURCE_STORAGE_URL` pointing to `ukezjcnxjvkpkeezxaew.supabase.co`.
   - **ABORT Procedures**: Steps ABORT-A, ABORT-B, and ABORT-C updated to state that there is no other host to restore, pointing DNS to a `supabase.co` host is prohibited, and any issues must fix forward on the box.
   - **Recovery Drill**: Directly addresses Codex's Round 2 finding. The drill now explicitly installs `commonswarm-api-maintenance.caddy` (which returns 503 with zero upstream for the public site, while `edge-staging.commonswarm.com` keeps box routes) before performing the PostgreSQL restore. Once proved, `commonswarm-api.caddy` is reinstalled and reloaded.
   - **Assessment**: Flawlessly closes the loop on recovery drill leak risks.

8. **`deploy/supabase-stack/VERSIONS.md`**
   - States cutover is done, production is `yulan-vps-1`, and no written procedure exists yet for checking image pins.
   - **Assessment**: Accurate status.

9. **`docs/design/2026-08-18-FILE-ARTIFACTS.md`**
   - Row S6 updated to reflect static site deploy via `deploy/site/deploy.sh yulan-vps-1` and notes unestablished schema/edge deployment procedures.
   - **Assessment**: Accurate.

---

### Dependencies Outside Part F1b

The following references within Part F1b depend on verification in other review parts:
1. **Caddy Maintenance Configuration**: `deploy/supabase-stack/commonswarm-api-maintenance.caddy` configuration matching the 503 response semantics, headers (`Retry-After: 300`), and zero upstream proxying described in `RUNBOOK.md` (reviewed in Part F1a).
2. **Site Deployment Scripts**: `deploy/site/deploy.sh`, `deploy/site/validate-site-env.mjs`, and `deploy/site/finalize-release.sh` behavior documented in `AGENTS.md` (reviewed in site deployment part).
3. **Caddy Host Checker Tests**: Test implementations enforcing mutation rules (`deploy/**/*.caddy` containing no `supabase.co` hosts, public maintenance having no upstream, etc.) (reviewed in test suite part).
4. **Resume Documentation**: `docs/org/2026-09-22-PRODUCTION-BOX-RESUME-HERE.md` cited across multiple files as the canonical next-step document (reviewed in docs part).

---

### Findings

No `PRODUCTION` or `RIGOUR` findings identified in this part. Both Round 2 defects (recovery drill upstream leak during maintenance and `SUCCESSION-PLAN.md` instructions) have been completely and cleanly resolved in fold `aaa8a914`.

VERDICT: PASS
