### Part F1c Review: Scope & Dependencies

**Files Reviewed in Part F1c (10 files):**
1. [deploy/edge-runtime/README.md](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/deploy/edge-runtime/README.md)
2. [deploy/edge-runtime/RUNBOOK.md](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/deploy/edge-runtime/RUNBOOK.md)
3. [deploy/edge-runtime/VERIFICATION.md](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/deploy/edge-runtime/VERIFICATION.md)
4. [deploy/site/RUNBOOK.md](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/deploy/site/RUNBOOK.md)
5. [deploy/supabase-stack/commonswarm-api-maintenance.caddy](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/deploy/supabase-stack/commonswarm-api-maintenance.caddy)
6. [deploy/supabase-stack/migration.env.example](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/deploy/supabase-stack/migration.env.example)
7. [docs/design/2026-08-02-V015-MASTER-PLAN.md](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/docs/design/2026-08-02-V015-MASTER-PLAN.md)
8. [docs/design/2026-09-04-GOOGLE-SIGNIN.md](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/docs/design/2026-09-04-GOOGLE-SIGNIN.md)
9. [docs/design/SWARM-CLOUD.md](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/docs/design/SWARM-CLOUD.md)
10. [docs/design/WEB-ONBOARDING.md](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/docs/design/WEB-ONBOARDING.md)

**External Dependencies (covered in other parts):**
- [deploy/supabase-stack/commonswarm-api.caddy](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/deploy/supabase-stack/commonswarm-api.caddy) (Live API Caddyfile)
- [deploy/site/deploy.sh](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/deploy/site/deploy.sh) (Site deployment script)
- [docs/org/2026-09-22-PRODUCTION-BOX-RESUME-HERE.md](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/docs/org/2026-09-22-PRODUCTION-BOX-RESUME-HERE.md) (Box resume / not established documentation)
- [tests/p1-cli/fixtures/command-dispatch-baseline.json](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/tests/p1-cli/fixtures/command-dispatch-baseline.json) and Caddy test suites

---

### Detailed Findings by File

#### 1. [deploy/supabase-stack/commonswarm-api-maintenance.caddy](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/deploy/supabase-stack/commonswarm-api-maintenance.caddy)
- **Round 2 Codex finding check:** In Round 2, the maintenance file proxied public reads and Realtime to the deleted Supabase project origin `ukezjcnxjvkpkeezxaew.supabase.co`.
- **Round 3 fold verification:**
  - The snippets `(supabase_origin)` and `(supabase_realtime_origin)` pointing to `ukezjcnxjvkpkeezxaew.supabase.co` are completely removed.
  - `api.commonswarm.com` retains the 204 handler for CORS OPTIONS preflight and routes all other HTTP methods directly into a static 503 JSON maintenance response (`{"error":"maintenance","message":"writes are paused for database migration"}`). There is **no upstream proxy** configured for `api.commonswarm.com`.
  - `edge-staging.commonswarm.com` imports `(box_routes)`, correctly routing staging controls to local container ports on `127.0.0.1` (`:18000`–`:18004`).
  - No references to `supabase.co` exist in the file.
- **Status:** PASS. Clean and correctly addresses the maintenance pause requirement without dead upstreams.

#### 2. [deploy/edge-runtime/README.md](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/deploy/edge-runtime/README.md)
- Routing table accurately directs `/auth/v1/*`, `/rest/v1/*`, `/storage/v1/*`, and `/realtime/v1/*` to local container loopbacks (`127.0.0.1:18001` through `:18004`), with edge functions on loopback edge runtime and fallback to 404 JSON.
- Replaced pre-cutover references to `commonswarm.caddy` with `deploy/supabase-stack/commonswarm-api.caddy`.
- Updated Caddy validation documentation to specify mode arguments (`live` vs `maintenance`) and explicitly warns against installing any file naming a `supabase.co` host.
- Explicitly states the server is production, N-db has landed, and warns never to roll DNS back to `supabase.co`.
- **Status:** PASS.

#### 3. [deploy/edge-runtime/RUNBOOK.md](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/deploy/edge-runtime/RUNBOOK.md)
- Replaces former cutover and rollback sections that directed operators to fall back to `ukezjcnxjvkpkeezxaew.supabase.co` or measure Supabase Edge Functions dashboards.
- Explicitly warns: "Do not rewrite Host to the deleted supabase.co name", "Do not deactivate a Supabase custom domain", and "Do not roll DNS back to a supabase.co name".
- Accurately states what is **NOT ESTABLISHED**: no written procedure yet for how a new edge-function version reaches the box, pointing directly to [docs/org/2026-09-22-PRODUCTION-BOX-RESUME-HERE.md](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/docs/org/2026-09-22-PRODUCTION-BOX-RESUME-HERE.md).
- **Status:** PASS.

#### 4. [deploy/edge-runtime/VERIFICATION.md](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/deploy/edge-runtime/VERIFICATION.md)
- Explicit preamble clarifies that `commonswarm.caddy` was removed because it proxied to a deleted host, links live routes to `deploy/supabase-stack/commonswarm-api.caddy`, notes maintenance configuration, and marks the proxy cutover item under "NOT ESTABLISHED" as closed.
- **Status:** PASS.

#### 5. [deploy/site/RUNBOOK.md](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/deploy/site/RUNBOOK.md)
- Updates status to confirm site cutover is complete, served by Caddy on `yulan-vps-1`, and confirms Vercel project `coswarm-site` is deleted.
- Removes instructions for rolling back DNS to Vercel and retiring `coswarm-site`. Specifies local release rollback via symlink (`ln -sfn releases/RELEASE_TO_RESTORE current.next && mv -Tf current.next current`) and explicitly warns: "Do not point DNS at Vercel."
- **Status:** PASS.

#### 6. [deploy/supabase-stack/migration.env.example](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/deploy/supabase-stack/migration.env.example)
- Removed example storage URL `https://ukezjcnxjvkpkeezxaew.supabase.co/storage/v1`.
- Replaced with comment: `# The hosted project's Storage API is gone. Do not set this to a supabase.co host.`
- **Status:** PASS.

#### 7. [docs/design/2026-08-02-V015-MASTER-PLAN.md](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/docs/design/2026-08-02-V015-MASTER-PLAN.md)
- Preamble documents that this file is the historical record of v0.1.5 rollout.
- Explicitly warns: "Do not run `vercel deploy` or `supabase db push --linked` from it."
- Directs site publishing to `deploy/site/deploy.sh yulan-vps-1` and references [docs/org/2026-09-22-PRODUCTION-BOX-RESUME-HERE.md](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/docs/org/2026-09-22-PRODUCTION-BOX-RESUME-HERE.md) for schema/edge deployment status.
- Removes Vercel-specific deployment traps (`.vercel`, `--scope ridgedotio`).
- **Status:** PASS.

#### 8. [docs/design/2026-09-04-GOOGLE-SIGNIN.md](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/docs/design/2026-09-04-GOOGLE-SIGNIN.md)
- Reflects that Google, GitHub, and email are enabled on the server GoTrue instance.
- Directs configuration to GoTrue on the server rather than Supabase dashboard.
- Explicitly warns: "Do not add `https://ukezjcnxjvkpkeezxaew.supabase.co/auth/v1/callback`. That host is retired."
- Removes dead project instructions, replaces `vercel deploy` commands with `deploy/site/deploy.sh yulan-vps-1`, and preserves the note that privacy copy updates remain with the owner.
- **Status:** PASS.

#### 9. [docs/design/SWARM-CLOUD.md](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/docs/design/SWARM-CLOUD.md)
- Accurately states that `https://commonswarm.com` is served by Caddy on the Hetzner server and that the Vercel alias is gone.
- **Status:** PASS.

#### 10. [docs/design/WEB-ONBOARDING.md](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/docs/design/WEB-ONBOARDING.md)
- Removes commands invoking `supabase functions deploy` and `supabase secrets set`.
- Notes that edge-function deployment and `SWARM_SELF_SERVE` configuration mechanics on the box are not established, pointing to [docs/org/2026-09-22-PRODUCTION-BOX-RESUME-HERE.md](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/docs/org/2026-09-22-PRODUCTION-BOX-RESUME-HERE.md).
- Replaces Supabase dashboard sign-in and redirect settings with server GoTrue configuration; removes deleted Vercel redirect alias (`https://coswarm-site.vercel.app/app`).
- Replaces Vercel deployment traps with `deploy/site/deploy.sh yulan-vps-1`.
- **Status:** PASS.

---

### Conclusion

All 10 files in Part F1c have been inspected. The previous Round 2 production defects regarding the maintenance Caddy file proxying to the deleted Supabase project origin have been completely remedied: `commonswarm-api-maintenance.caddy` has no upstream for public requests, returns 503 for all non-OPTIONS requests, and preserves box routes for edge staging. No deleted hosts, obsolete Supabase CLI commands, or dead Vercel workflows are presented as live operations.

VERDICT: PASS Part F1c diff accurately reflects the Hetzner single-box architecture, removes all upstreams and references to deleted Supabase and Vercel infrastructure, and properly documents unestablished deployment procedures.
