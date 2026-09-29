# CommonSwarm site release — HM lane 8

**Release input:** `8b8989f2b29e440a317a2cdedf11195901c8342c`
**Intended evidence path:** `docs/evidence/2026-09-28-site-hm8/SITE-RELEASE.md`
**Status:** Plan only. Deployment, live browser controls, approval and closure are **not established**.

Anvil executes the release under HezLead’s direction. This review read repository files and Git history only; it ran no build, test, browser control or production command.

This lane is the next operation in the same approved window: start `site-01` immediately after lanes 3+7 record successful controls and cleanup. A lanes-3+7 `CONTROLS=failed` disposition still stops the combined window as its plan requires. On success, do not insert another release, stop for a fresh plan review, or reuse stale HM37 evidence between the lanes; all site holds must be closed before the combined window opens.

The governing procedures are [`deploy/RELEASE-TO-BOX.md`](../../../deploy/RELEASE-TO-BOX.md), [`deploy/site/RUNBOOK.md`](../../../deploy/site/RUNBOOK.md), and the workspace `hetzner-handoff/HETZNER-OPERATIONS.md`.

Cloudflare Browser Integrity Check returns 403 `error code: 1010` to Python urllib's default User-Agent on `https://commonswarm.com/`, `/api.md`, and `/install.sh`. Every public request in the runnable blocks below therefore sends and records `User-Agent: commonswarm-release-probe/1.0`. The release helper itself makes no public request. The separately named parity procedure is not safe to invoke unchanged against the public hostname: `deploy/site/parity-check.mjs:69` supplies only an optional Host override and no explicit User-Agent, and `deploy/site/RUNBOOK.md:71-72` calls it against `commonswarm.com`. This assignment does not permit editing that release code; the parity invocation remains a hold until its own reviewed fix. The curl examples at `deploy/site/RUNBOOK.md:48-55` also do not record their User-Agent or failure headers and are not accepted as this lane's evidence.

## 1. Release identity and baseline

Measured in this checkout:

| Fact | Result |
|---|---|
| `HEAD` | `8b8989f2b29e440a317a2cdedf11195901c8342c` |
| Local `origin/main` | Same SHA; fresh remote confirmation is not established |
| Working tree | Clean |
| HM8 merge | `d5e9403d16e64d727fd2a98787e35111f4f1992e`, ancestor of the release |
| HM8 implementation | `92e7c1c6` |
| Root package version | `0.1.80` |
| Site difference from OAuth retry SHA `ad964ed1` | None |
| Current live site release | **Not established by a current box measurement** |

The newest committed site deployment receipt found is [`2026-09-25-v0.1.77-release/RELEASE.md`](../2026-09-25-v0.1.77-release/RELEASE.md). It records:

- Source: `218cf921d07d56f2b937822bcf18feb9d3be0f53`.
- Release directory: `20260925T003349Z-218cf921d07d-3a154c81c821946d`.
- Build setting: `PUBLIC_H0_LINK_JOIN=1`.

The September 27 `0.1.78`, `0.1.79` and `0.1.80` release notes do not establish a later site deployment. A box-window plan containing a future site step is not deployment evidence.

**The first operational step is therefore a read-only measurement of the live symlink.** Its resolved full source SHA is the release baseline; the measured inventory in site-02 governs approval. The precomputed inventory below is only an expectation if that baseline is `218cf921d07d56f2b937822bcf18feb9d3be0f53`.

```sh
# step: site-01 — Mac mini /bin/bash 3.2; Anvil; read-only commands on the box
# readonly: yes
(
  set -euo pipefail
  ssh -o BatchMode=yes commonswarm@yulan-vps-1 /bin/bash -s <<'BOX'
set -euo pipefail
root=/srv/commonswarm/site
test -L "$root/current"
previous=$(readlink -f "$root/current")
case "$previous" in
  "$root"/releases/*) ;;
  *) printf '%s\n' 'STOP: current resolves outside site/releases' >&2; exit 1 ;;
esac
test -d "$previous"
test -f "$previous/app/index.html"
test -f "$previous/download/index.html"
date -u '+measured_at=%Y-%m-%dT%H:%M:%SZ'
printf 'previous_release=%s\n' "$previous"
sha256sum "$previous/app/index.html" "$previous/download/index.html"
BOX
)
```

**Evidence:** UTC time, resolved previous release path, `/app` and `/download` hashes, and the historical receipt or operator record mapping that directory to a full source SHA. A directory’s abbreviated SHA is a lead to resolve, not independent proof of provenance.

For subsequent blocks, Anvil supplies these non-secret inputs:

- `SITE_RELEASE_REPO`: absolute path to the checkout whose `HEAD` is the exact release SHA.
- `SITE_BASE_SHA`: full SHA resolved from the measured current site release.
- `SITE_EVIDENCE`: absolute, protected evidence directory for this execution, outside the release checkout.

Do not change a shared checkout to satisfy these inputs. Prepare a separate checkout if necessary.

```sh
# step: site-02 — Mac mini /bin/bash 3.2; Anvil; measured source reconciliation
# readonly: yes
(
  set -euo pipefail
  : "${SITE_RELEASE_REPO:?Set the exact-release checkout path}"
  : "${SITE_BASE_SHA:?Resolve the live site source to a full SHA}"
  : "${SITE_EVIDENCE:?Set the protected evidence directory}"
  case "$SITE_EVIDENCE" in /*) ;; *) exit 1 ;; esac
  cd "$SITE_RELEASE_REPO"
  target=8b8989f2b29e440a317a2cdedf11195901c8342c
  test "$(git rev-parse HEAD)" = "$target"
  base=$(git rev-parse --verify "${SITE_BASE_SHA}^{commit}")
  test "$base" = "$SITE_BASE_SHA"
  test "${#base}" -eq 40
  if ! git merge-base --is-ancestor "$base" "$target"; then
    printf '%s\n' 'STOP: measured live base is not an ancestor of the release SHA' >&2
    exit 1
  fi
  test ! -e "$SITE_EVIDENCE/site-02-summary.txt"
  umask 077
  git log --format=fuller "$base..$target" -- site/ \
    > "$SITE_EVIDENCE/site-02-git-log.txt"
  git log --format='%H %s' "$base..$target" -- site/ \
    > "$SITE_EVIDENCE/site-02-commits.txt"
  git diff --stat=200,200 "$base" "$target" -- site/ \
    > "$SITE_EVIDENCE/site-02-diff-stat.txt"
  git diff --name-status "$base" "$target" -- site/ \
    > "$SITE_EVIDENCE/site-02-name-status.txt"
  git diff --numstat "$base" "$target" -- site/ \
    > "$SITE_EVIDENCE/site-02-numstat.txt"
  commit_count=$(git rev-list --count "$base..$target" -- site/)
  listed_commit_count=$(wc -l < "$SITE_EVIDENCE/site-02-commits.txt" | tr -d ' ')
  changed_file_count=$(git diff --name-only "$base" "$target" -- site/ | wc -l | tr -d ' ')
  listed_file_count=$(wc -l < "$SITE_EVIDENCE/site-02-name-status.txt" | tr -d ' ')
  numstat_file_count=$(wc -l < "$SITE_EVIDENCE/site-02-numstat.txt" | tr -d ' ')
  test "$commit_count" -eq "$listed_commit_count"
  test "$changed_file_count" -eq "$listed_file_count"
  test "$changed_file_count" -eq "$numstat_file_count"
  {
    printf 'base=%s\n' "$base"
    printf 'target=%s\n' "$target"
    printf 'site_commit_count=%s\n' "$commit_count"
    printf 'site_changed_file_count=%s\n' "$changed_file_count"
    printf '%s\n' 'PASS: measured commits and file inventories reconcile'
  } > "$SITE_EVIDENCE/site-02-summary.txt"
  cat "$SITE_EVIDENCE/site-02-summary.txt"
)
```

**Evidence:** `site-02-summary.txt`, complete `git log`, complete commit list, diff stat, name/status and numerical inventory. Stop if the measured base cannot be resolved or is not an ancestor of the release SHA. The measured list governs. Before approval, classify every commit in that list absent from the expected list below as requiring a live server dependency or not; do not approve it as an unreviewed carry.

### Expected site history if the measured live base is `218cf921d07d56f2b937822bcf18feb9d3be0f53`

This precomputed expected comparison is:

`218cf921d07d56f2b937822bcf18feb9d3be0f53..8b8989f2b29e440a317a2cdedf11195901c8342c`

It has **28 entries touching `site/`**, grouped below. Merge entries are included; the expected net file inventory follows. It is not release evidence unless site-01 measures the stated base; site-02’s measured list governs.

| Item and commits | What this site release carries | Server dependency and disposition |
|---|---|---|
| G lane 1: `96a9fe1e`, `bb229da9`, `e433f48a`, `a503577e` | Roster wake-path staleness and its controls | Requires `swarm_read.agent_wake_path` and corresponding delivery behavior. Recorded migration `20260925000001` has ledger `1`, catalog `t` in the September 26 `9627cb37e697` evidence. Fresh availability must be checked. |
| G lane 2b: `68cbd8c9`, `92107eaf` | Changes carried through the watcher/lease integration, including site fixtures | Requires the existing lease backend for affected wake behavior. September 27 `d4677b0d1c86` evidence records migration `20260926000001` and a 50-call renewal gate PASS. Do not infer current health from that receipt alone. |
| Company address: `79ade46a`, `7de16d21`, `4cb609cc` | Centralized address and corrected street number in legal pages | Static copy; no new server deployment. |
| CP0: `9cbab6e9` | Shared Chrome launcher, provider fixtures and observer updates | Test infrastructure only; no production server dependency. |
| CP1: `c0b1f004` | Google-first sign-in, primary provider button, revised sign-in text | Uses existing GoTrue settings. Build reads `/auth/v1/settings`; current enabled providers are **not established** here. Preserve the live configuration and verify rendered choices. |
| CP3: `f00a5c00`, `9b1f9959`, `99881c8b`, `2079b5aa`, `8a3cd5b4`, `05eb6ad6` | Consumer homepage, Grok Bot example/glyph, OG changes, Grok Bot guide and footer link. The guide was removed and then restored. | No HM OAuth dependency. The guide uses the CLI on the Bot’s computer, names gateway prerequisites, labels wake a preview and states idle wake has not been proved. Verify the published client still supports its instructions; do not claim a new live wake proof. |
| G3d/G3e: `e609bed3`, `4f970237` | Roster presence, wake route, last call and client-build information | Requires `swarm_read.agent_presence` and its underlying presence state. September 27 `38343e74cbd5/migration-state-after.txt` records migrations `20260927000001`–`…03`, each ledger `1`, catalog `t`. Fresh owner reads remain required. |
| T3a: `cc5e4386` | Site-side changes accompanying ask-chain limits | Server migration `20260927000003` is recorded applied in the same `38343e74cbd5` evidence. This release does not apply it again. |
| Citation/diagnostic repairs: `9b3030f8`, `d0ccf3a8`, `11660541` | Comment citations and observer diagnostic text in agent-connect and acceptable-use sources | These site changes do not activate HM2 or change authority. HM2 remains a separate server dependency of HM8. |
| HM4: `163da7d4` | Queries and displays agent `transport` and `turn_only`; labels Local/Hosted MCP | Requires migration `20260928000001`. September 27 `9b085c823523/migration-state-after.txt` records ledger `1`, catalog `t`. Unlike optional presence display, the roster explicitly selects these columns: absence blocks release. |
| HM8: `92e7c1c6` | Account-menu Connected apps dialog, owner connections/workspaces/seats, grant and seat revocation with committed-state rereads | Requires HM2 views and revoke command handlers. Historical HM2 deployment evidence exists; fresh signed-in-owner acceptance is **not established**. |
| CI-GREEN b: `a8272445`, `02c4e9a9`, `93b8d202` | One-row mobile app bar below `34rem`; real-width observer measurements; sample-notice and scroll-reset fixture corrections | CSS and test changes; no new server deployment. Real Chrome controls at 320px and 390px are mandatory. |

### Expected net file inventory if the measured live base is `218cf921d07d56f2b937822bcf18feb9d3be0f53`

The precomputed expected `git diff --stat` is **62 files changed, 1,865 insertions, 524 deletions**, including `og.png` changing from **66,152 to 65,141 bytes**. Site-02’s measured diff stat governs.

All paths below are relative to `site/`. Counts are additions/deletions from the same expected comparison. Shared files carry multiple items from the preceding table.

| Group | Path | + / − |
|---|---|---:|
| Test infrastructure | `package.json` | 1 / 1 |
| CP3 | `public/og.png` | binary |
| CP3 | `scripts/metadata.test.mjs` | 12 / 2 |
| CP3 | `scripts/og-card.mjs` | 6 / 6 |
| CP0 | `scripts/provider-fixtures.ts` | 63 / 19 |
| CP3 | `scripts/seo-pages.test.mjs` | 51 / 2 |
| CP3 | `src/components/SiteFooter.astro` | 1 / 0 |
| Shared application changes | `src/components/app/LiveDashboard.astro` | 433 / 42 |
| Observer | `src/components/app/agent-model-editor.observer.test.ts` | 2 / 8 |
| Presence | `src/components/app/agent-presence.observer.test.ts` | 82 / 0 |
| Observer | `src/components/app/agent-row-geometry.observer.test.ts` | 5 / 31 |
| Sign-in/observer | `src/components/app/app-signed-out.observer.test.ts` | 71 / 18 |
| Observer | `src/components/app/brain-links-blocks.observer.test.ts` | 2 / 8 |
| Observer | `src/components/app/brain-links.observer.test.ts` | 2 / 8 |
| Fixture | `src/components/app/brain-view.fixture.ts` | 5 / 8 |
| Observer | `src/components/app/chat-threads.observer.test.ts` | 8 / 29 |
| Observer | `src/components/app/composer-addressing.observer.test.ts` | 2 / 8 |
| Observer | `src/components/app/composer-polish.observer.test.ts` | 2 / 9 |
| Observer | `src/components/app/composer-sprint-browser.observer.test.ts` | 2 / 8 |
| Observer | `src/components/app/composer-to-field.observer.test.ts` | 12 / 35 |
| HM4 | `src/components/app/entity-panel.observer.test.ts` | 3 / 0 |
| Observer | `src/components/app/feed-composer-clearance.observer.test.ts` | 2 / 8 |
| Fixture | `src/components/app/file-list.fixture.ts` | 2 / 8 |
| Observer/mobile | `src/components/app/markdown-wordwrap-qa.observer.test.ts` | 32 / 16 |
| Observer/mobile | `src/components/app/message-blocks-layout.observer.test.ts` | 25 / 10 |
| CI-GREEN/mobile | `src/components/app/mobile-feed-layout.observer.test.ts` | 16 / 8 |
| Fixture | `src/components/app/participant-rail.fixture.ts` | 4 / 50 |
| Observer/HM4 | `src/components/app/slack-shape.observer.test.ts` | 6 / 10 |
| HM4 | `src/components/app/transport-roster.observer.test.ts` | 39 / 0 |
| Observer | `src/components/app/update-notice.observer.test.ts` | 2 / 8 |
| G lane 1 | `src/components/app/wake-path.observer.test.ts` | 29 / 0 |
| Observer | `src/components/app/workspace-entry.observer.test.ts` | 7 / 6 |
| Observer | `src/components/app/workspace-settings.observer.test.ts` | 2 / 8 |
| CP1 | `src/components/auth/ProviderButtons.astro` | 18 / 5 |
| CP0/CP1 | `src/components/auth/provider-buttons.observer.test.ts` | 111 / 28 |
| Observer/citations | `src/components/connect/agent-connect-mint.observer.test.ts` | 5 / 5 |
| CP3 | `src/components/landing/ConsumerHero.astro` | 29 / 33 |
| CP3 | `src/components/landing/ConsumerStory.astro` | 14 / 16 |
| CP3 | `src/components/landing/consumer-copy.observer.mjs` | 46 / 15 |
| Observer | `src/components/landing/heading-lines.observer.test.ts` | 2 / 8 |
| CP3 | `src/components/seo/AboutCommonSwarm.astro` | 22 / 6 |
| CP3 | `src/layouts/Base.astro` | 3 / 3 |
| CP3 | `src/layouts/SeoPage.astro` | 7 / 2 |
| Citations | `src/lib/agent-connect.ts` | 6 / 6 |
| Presence | `src/lib/agent-presence.ts` | 89 / 0 |
| CP1 | `src/lib/auth-providers.ts` | 7 / 7 |
| Company address | `src/lib/company.test.mjs` | 30 / 0 |
| Company address | `src/lib/company.ts` | 10 / 0 |
| HM8 | `src/lib/connected-apps.test.mjs` | 43 / 0 |
| HM8 | `src/lib/connected-apps.ts` | 145 / 0 |
| HM4 | `src/lib/entity-panel.ts` | 3 / 0 |
| CP3 | `src/lib/model-glyph.test.mjs` | 10 / 0 |
| CP3 | `src/lib/model-glyph.ts` | 6 / 1 |
| HM4 | `src/lib/participant-rail.ts` | 12 / 0 |
| G lane 1 | `src/lib/wake-path.ts` | 12 / 0 |
| Citations | `src/pages/acceptable-use.astro` | 8 / 8 |
| CP3 | `src/pages/guides/grok-bot.astro` | 124 / 0 |
| CP3 | `src/pages/index.astro` | 2 / 2 |
| Company address | `src/pages/privacy.astro` | 4 / 2 |
| Company address | `src/pages/terms.astro` | 5 / 3 |
| CP0 | `tests/chrome-launch-sweep.test.ts` | 35 / 0 |
| CP0 | `tests/chrome.ts` | 126 / 0 |

Observer and fixture changes do not require an additional production server release. Application dependencies are identified above.

## 2. Public feature exposure

Connected apps is **not hidden behind a feature flag**. `LiveDashboard.astro` renders its account-menu button unconditionally; opening it requires a session and refuses sample mode.

This plan treats the dialog as available account management:

- It lists and revokes existing connections.
- It offers no connection-creation or OAuth authorization action.
- Its empty state is `No apps are connected to this account.`
- Its introduction describes hosted seats. That text will be visible to signed-in users and must not be represented as hidden.

This is safe before public hosted MCP availability **only if HM2 owner reads and revocation are available**, and HezLead accepts exposing this management-only surface. If the requirement is to hide every mention of hosted connections until public launch, **this SHA cannot meet it**; a separately reviewed code change and new release SHA are required.

The Grok Bot guide is a separate CLI setup path. It does not advertise a hosted MCP connector.

The OAuth consent page belongs to `services/mcp-auth/`, not this static site deployment. [`2026-09-28-box-hm6/BOX-WINDOW.md`](../2026-09-28-box-hm6/BOX-WINDOW.md) specifies retry image input `ad964ed158181ba1692dd05895f36fa7a1f87d3f`, which includes HM8, with `MCP_OAUTH_PUBLIC_AUTHORIZATION_ENABLED=0`. That document establishes a plan, not successful retry execution. This site window changes no OAuth flag, `/mcp` route, metadata route, DNS, GoTrue configuration or service.

## 3. Preconditions and release holds

### HM2 and existing server dependencies

Recorded HM2 evidence:

- [`close-readback.txt`](../2026-09-28-release-72c57e0d76d0-rerun-4/close-readback.txt): edge at `72c57e0d76d0aa86fe4f811a2cf51499919fed20`, healthy, on `commonswarm-net`.
- [`20260928000002-functional.txt`](../2026-09-28-release-72c57e0d76d0-rerun-4/20260928000002-functional.txt): `t`.
- Migration source: `supabase/migrations/20260928000002_hm_hosted_authority.sql`.
- Command handlers: `supabase/functions/command/index.ts`.

The two views filter by `owner_user_id = auth.uid()` and grant SELECT to `authenticated`. The site does not supply an owner ID.

**Do not overstate the functional receipt:** its SQL reconciles existing authority state and can pass with no hosted grants. `hm2-local-control.json` exercises local seats. Neither establishes a live signed-in owner’s successful hosted-grant and hosted-seat revocation.

Before GO, Anvil must attach read-only verification of:

1. The active edge and its mounted source identity, including both revoke handlers.
2. Migration `20260928000002` and both owner views, using the governing runbook’s read-only database procedure. Do not reapply migrations or rerun seed/mutation controls.
3. Successful authenticated reads of both views for the dedicated test owner, through the public API. Use the same selected columns and ordering as `site/src/lib/connected-apps.ts`.
4. Existing owner-scoped evidence that both revoke commands answer correctly, including committed deny-state readback. If no such evidence exists, record **not established** and hold that precondition for a separately authorized control. An empty view, OPTIONS response or unauthenticated refusal is not a positive revoke control.
5. Current availability of roster transport columns, `agent_presence` and `agent_wake_path`.

The signed-in checks use Anvil’s real Chrome and the dedicated test account below. Keep tokens in the browser; do not export HAR files, storage contents or authorization headers.

### Build environment

`deploy/site/validate-site-env.mjs` checks non-empty values, a three-part JWT and rejection of `service_role`. It does **not** require the expected URL or require `role === "anon"`. The following supplements it without printing either configured value.

```sh
# step: site-03 — Mac mini /bin/bash 3.2; Anvil; read-only environment validation
# readonly: yes
(
  set -euo pipefail
  : "${SITE_RELEASE_REPO:?Set the exact-release checkout path}"
  cd "$SITE_RELEASE_REPO"
  test "$(git rev-parse HEAD)" = 8b8989f2b29e440a317a2cdedf11195901c8342c
  node --input-type=module <<'NODE'
import fs from "node:fs";

function requireCheck(ok, label) {
  if (!ok) {
    console.error(`FAIL: ${label}`);
    process.exit(1);
  }
}
const version = process.versions.node.split(".").map(Number);
requireCheck(version[0] > 22 || (version[0] === 22 && version[1] >= 12),
             "Node >=22.12");
const filename = "site/.env";
requireCheck((fs.statSync(filename).mode & 0o777) === 0o600,
             "site environment permissions");
const values = new Map();
for (const line of fs.readFileSync(filename, "utf8").split(/\r?\n/)) {
  const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (!match) continue;
  requireCheck(!values.has(match[1]), "no duplicate environment names");
  let value = match[2].trim();
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
  values.set(match[1], value);
}
requireCheck(values.get("PUBLIC_SUPABASE_URL") === "https://api.commonswarm.com",
             "production backend URL");
const parts = (values.get("PUBLIC_SUPABASE_ANON_KEY") || "").split(".");
requireCheck(parts.length === 3 && parts.every(Boolean), "three-part JWT");
let payload;
try {
  payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
} catch {
  requireCheck(false, "JWT payload");
}
requireCheck(payload?.role === "anon", "JWT role is anon");
requireCheck(values.get("PUBLIC_H0_LINK_JOIN") === "1", "H0 link join preserved");
for (const name of ["PUBLIC_SUPABASE_URL", "PUBLIC_SUPABASE_ANON_KEY",
                    "PUBLIC_H0_LINK_JOIN"]) {
  requireCheck(process.env[name] === undefined, "no inherited build override");
}
for (const file of ["site/.env.local", "site/.env.production",
                    "site/.env.production.local"]) {
  requireCheck(!fs.existsSync(file), "no unreviewed environment override file");
}
console.log("PASS: runtime, environment permissions, URL, anon role and H0 setting");
NODE
  node deploy/site/validate-site-env.mjs site/.env </dev/null
)
```

**Evidence:** exit statuses and PASS/FAIL labels only. JWT payload inspection does not validate its signature; successful API access supplies the separate operational check.

### Exact-SHA gates and operational holds

Before execution, attach reviewed exact-SHA gate results from an allowed non-mini runner. Source tests are not test results. A passing run for another SHA is not an exact-SHA pass. No site suite, headless browser suite or parity test runs on the Mac mini. The deployment build and Anvil’s real-Chrome controls are the permitted work here.

Also establish:

- HezLead’s exact-SHA approval and accepted complete site scope.
- The authenticated test owner and workspace restriction.
- SSH host identity and `commonswarm` write access. Use `commonswarm@yulan-vps-1`; `ops` cannot write the site root.
- Previous build settings and rollback directory.
- No concurrent site deployment.
- Preservation of the previous release despite the helper’s five-release retention. An older rollback target is not automatically protected from pruning.

**Deletion-rule conflict — execution hold:** the supplied `deploy/site/deploy.sh` contains recursive temporary-directory cleanup without the required resolved-path guard; `finalize-release.sh` recursively prunes releases not created by `mktemp` in the invoking block. Thus invoking these helpers does not satisfy a literal application of this assignment’s recursive-deletion rule.

Do not claim that omitting `rm -rf` from the blocks below removes those effects. The hold lifts only when the separate deployment-helper fix is on `main` and the release SHA contains its resolved-path guards and their tests; check that both guards and their tests are present at the exact release SHA. This plan does not move `8b8989f2b29e440a317a2cdedf11195901c8342c`: if that fix is absent from this SHA, selecting a new reviewed release SHA that includes it is a precondition. No exception is established here. The deployment block below is the existing interface, **not authorization to bypass this hold**.

## 4. Build, validate, upload and switch

The script supports one production invocation:

`deploy/site/deploy.sh commonswarm@yulan-vps-1`

It has no build-only, upload-only or delayed-switch production mode. Its `--dry-run --npm-ci` option performs an install; it is not a harmless simulation. Do not invent staged deployment options.

One invocation performs these phases:

| Phase | Measured implementation | Required evidence |
|---|---|---|
| Build | `git archive HEAD`, link operator `site/.env`, `npm ci`, `npm run build` | Exact HEAD, build settings PASS, command log and exit status |
| Validate | Require built `/start/index.html` and a non-empty backend URL meta value | Script reaches upload only after validation; supplementary environment PASS |
| Upload | Unique timestamp/SHA/random `.tmp` directory; `rsync -a --delete` | Upload exit status and resulting release path |
| Switch | Carry previous `/_astro` assets forward, normalize permissions, rename completed release, atomically replace `current` on Linux | Resolved symlink before/after and page/asset hashes |
| Retention | Keep five newest matching release directories; cleanup failures warn after the switch | Warnings recorded; previous rollback target confirmed present |

The built `/start` check alone does not prove the backend is correct, `/app` works or HM8 is usable.

After all holds are resolved, HezLead’s execution approval must name the exact SHA and the actual baseline. Keep the approval with the evidence. Do not deploy a later `main` merely because it contains this plan.

```sh
# step: site-04 — Mac mini /bin/bash 3.2; Anvil; production deployment after all holds close
# readonly: no
(
  set -euo pipefail
  : "${SITE_RELEASE_REPO:?Set the approved exact-release checkout}"
  : "${SITE_EVIDENCE:?Set the protected evidence directory}"
  case "$SITE_EVIDENCE" in /*) ;; *) exit 1 ;; esac
  cd "$SITE_RELEASE_REPO"
  target=8b8989f2b29e440a317a2cdedf11195901c8342c
  test "$(git rev-parse HEAD)" = "$target"
  git diff --exit-code HEAD -- site deploy/site
  test -f "$SITE_EVIDENCE/GO.txt"
  grep -qFx "SHA=$target" "$SITE_EVIDENCE/GO.txt"
  grep -qFx 'All release holds resolved' "$SITE_EVIDENCE/GO.txt"

  umask 077
  test ! -e "$SITE_EVIDENCE/deploy.log"
  ssh -o BatchMode=yes commonswarm@yulan-vps-1 \
    'readlink -f /srv/commonswarm/site/current' \
    > "$SITE_EVIDENCE/previous.release"
  previous=$(cat "$SITE_EVIDENCE/previous.release")
  case "$previous" in
    /srv/commonswarm/site/releases/*) ;;
    *) printf '%s\n' 'STOP: invalid previous release' >&2; exit 1 ;;
  esac

  set +e
  env -u PUBLIC_SUPABASE_URL -u PUBLIC_SUPABASE_ANON_KEY \
    -u PUBLIC_H0_LINK_JOIN \
    /bin/sh deploy/site/deploy.sh commonswarm@yulan-vps-1 \
    2>&1 | tee "$SITE_EVIDENCE/deploy.log"
  results=("${PIPESTATUS[@]}")
  set -e

  printf 'deploy_exit=%s\nlog_exit=%s\n' "${results[0]}" "${results[1]}" \
    > "$SITE_EVIDENCE/deploy-status.txt"
  ssh -o BatchMode=yes commonswarm@yulan-vps-1 \
    'readlink -f /srv/commonswarm/site/current' \
    > "$SITE_EVIDENCE/after.release"
  cat "$SITE_EVIDENCE/deploy-status.txt"
  cat "$SITE_EVIDENCE/after.release"
  test "${results[0]}" -eq 0
  test "${results[1]}" -eq 0
)
```

**Evidence:** `GO.txt`, `previous.release`, `deploy.log`, `deploy-status.txt`, `after.release`.

If the script fails or SSH disconnects, inspect `current` before retrying. Failure does not prove the switch did not happen. Never blindly invoke deployment again.

## 5. Controls after the switch

### Build identity and public delivery

There is no embedded release-SHA marker in this site. `LiveDashboard.astro` intentionally detects updates using asset URLs and served markup. `/download` derives `0.1.80` from the root package; that version alone cannot distinguish HM8 from another `0.1.80` build.

Use the release directory’s SHA prefix **plus the actual `/app` hash and referenced asset hashes** as the version evidence. The following runs on the box, not as a mini site test.

```sh
# step: site-05 — box /bin/bash; Anvil as commonswarm; read-only public delivery control
# readonly: yes
(
  set -euo pipefail
  python3 - <<'PY'
import hashlib
import json
import pathlib
import re
import urllib.error
import urllib.request

PROBE_USER_AGENT = "commonswarm-release-probe/1.0"

root = pathlib.Path("/srv/commonswarm/site")
release = (root / "current").resolve(strict=True)
assert release.parent == root / "releases", "unexpected release parent"
assert re.fullmatch(
    r"\d{8}T\d{6}Z-8b8989f2b29e-[0-9a-f]{16}", release.name
), "unexpected release identity"

def fetch(path):
    request = urllib.request.Request(
        "https://commonswarm.com" + path,
        headers={
            "Cache-Control": "no-cache",
            "Accept-Encoding": "identity",
            "User-Agent": PROBE_USER_AGENT,
        },
    )
    try:
        response = urllib.request.urlopen(request, timeout=30)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        status = response.status
        content_type = response.headers.get("Content-Type", "")
        raw = response.read()
        record = {
            "url": request.full_url,
            "method": "GET",
            "status": status,
            "user_agent": PROBE_USER_AGENT,
            "headers": {
                "server": response.headers.get("Server"),
                "cf-ray": response.headers.get("CF-Ray"),
                "content-type": content_type,
            },
        }
    if status == 403 and b"error code: 1010" in raw[:2048].lower():
        record["failure_kind"] = "cloudflare_challenge"
    if status != 200:
        # HTML and built assets can embed the anon JWT. Never print their body.
        record["body_prefix_omitted"] = "site response may contain configured anon credential"
        print("probe=" + json.dumps(record, separators=(",", ":")))
        raise SystemExit(1)
    record["pass"] = True
    print("probe=" + json.dumps(record, separators=(",", ":")))
    return raw

app = (release / "app/index.html").read_bytes()
assert b"data-connected-apps-open" in app, "Connected apps marker absent"
assert fetch("/app") == app, "public /app differs from current release"
download = (release / "download/index.html").read_bytes()
assert b"0.1.80" in download, "download version absent"
assert fetch("/download") == download, "public /download differs"

assets = sorted(set(re.findall(
    rb'(?:src|href)="(/_astro/[^"]+\.(?:js|css))"', app
)))
assert assets, "no app assets found"
for item in assets:
    path = item.decode("utf-8")
    local = (release / path.lstrip("/")).resolve(strict=True)
    assert release in local.parents, "asset escapes release"
    expected = local.read_bytes()
    assert fetch(path) == expected, "public asset differs"
    print("asset_sha256=" + hashlib.sha256(expected).hexdigest() + " " + path)

print("release=" + release.name)
print("app_sha256=" + hashlib.sha256(app).hexdigest())
print("download_sha256=" + hashlib.sha256(download).hexdigest())
print("PASS: public pages and referenced assets match current release")
PY
)
```

**Evidence:** release name, page hashes, enumerated asset hashes, PASS, and one sanitized probe record per request. Every public request sends and records `User-Agent: commonswarm-release-probe/1.0`; failures record status plus `Server`, `CF-Ray`, and `Content-Type`. A 403 body containing `error code: 1010` is classified as `cloudflare_challenge`. Do not print HTML or built asset bodies: they may contain the configured anon key.

A mismatch is a failed control requiring diagnosis or rollback. Do not dismiss it as caching without measuring the bytes subsequently served to Chrome.

### Anvil’s real-Chrome controls

Use a task-owned tab in a dedicated test-account browser context. Never navigate an existing Tom tab, use Tom’s account, or press the web **Sign out** control; it is global. Close only the task-owned tab/context after verification.

The only workspace permitted is:

**Cold Agent Test — `c2ea0541-f56d-4c73-bf71-56c5405c4934`.**

Connected apps is account-wide, not filtered to the currently selected workspace. Confirm the test owner has no unrelated connections or workspace access before opening it. Selecting Cold Agent Test in Tom’s account would not satisfy this restriction.

Record these controls with UTC time, sanitized screenshots and pass/fail results:

| Control | Required result |
|---|---|
| Build loaded | Fresh `/app` navigation loads the asset names established in site-05; no stale-build or failed-asset condition |
| Identity | Dedicated signed-in test owner; selected workspace is the full Cold Agent Test UUID |
| Workspace | Feed and roster load; no transport-column, presence or wake-view errors; existing local seats display Local |
| Connected apps | Open account menu → Connected apps; dialog renders and both owner-view requests succeed |
| Empty state | Owner with zero connections sees exactly `No apps are connected to this account.` Loading, retry or an error must not be mistaken for empty success |
| Console | No application console errors or unhandled rejections during load, dialog open/close and responsive controls |
| 320px | Actual CSS viewport `innerWidth` is 320; header remains one row, with no overlap, clipped controls or horizontal overflow |
| 390px | Same measurements at actual CSS viewport width 390 |
| H0 | Existing link-join entry remains available; do not mint a credential merely to inspect it |
| Carried public pages | Homepage consumer copy, Grok Bot guide/footer link and download version render as inventoried |

For mobile checks, measure the workspace control, mobile view controls and account control in `.dashboard__rail`, including their rectangles and the rail’s height. At both widths they must occupy the same row and remain usable. Capture the signed-in page at rest and after returning the transcript to its initial scroll position.

The source change at `LiveDashboard.astro`’s `@media (max-width: 34rem)` uses `grid-template-columns: minmax(0, 1fr) auto auto`. The CI-GREEN follow-ups correct fixture measurement; they do not substitute for these real-Chrome results. Do not hide real production notices or inject fixture CSS to obtain a pass.

### Revocation acceptance boundary

The source requires an accepted command response and then rereads both owner views:

- A seat receipt requires the reread seat’s `revoked` state.
- A grant receipt requires the reread connection’s `status === "revoked"`.
- Missing deny state produces an error rather than a success receipt.

This window’s empty-state control does not exercise those mutations. Do not create a public OAuth connection or revoke an unrelated connection to manufacture evidence. If a separately approved disposable Cold Agent Test fixture is available, its grant must be confined entirely to that workspace, and both successful revocation/readback controls can be recorded under that separate authorization. Otherwise live revoke behavior remains **not established** and the precondition remains open.

## 6. Rollback

Rollback triggers include wrong build bytes, failed signed-in `/app`, owner-view errors, unexpected public connector activation, console failures attributable to the release, or broken mobile header geometry.

HezLead directs rollback; Anvil executes it. Restore the measured previous site release only. Do not roll back HM2 schema or edge code, restart services, change Caddy, or change DNS.

Before invoking the block, `previous.release` must identify the measured previous directory and `after.release` the failed new directory. Their existence on the box is checked again. No recursive deletion is used.

```sh
# step: site-06 — Mac mini /bin/bash 3.2; Anvil; atomic rollback on the box
# readonly: no
(
  set -euo pipefail
  : "${SITE_EVIDENCE:?Set the evidence directory for this execution}"
  previous=$(cat "$SITE_EVIDENCE/previous.release")
  failed=$(cat "$SITE_EVIDENCE/after.release")
  for candidate in "$previous" "$failed"; do
    case "$candidate" in
      /srv/commonswarm/site/releases/*) ;;
      *) printf '%s\n' 'STOP: invalid release path' >&2; exit 1 ;;
    esac
    case "$candidate" in
      *[!A-Za-z0-9/._-]*) exit 1 ;;
    esac
  done
  test "$previous" != "$failed"

  ssh -o BatchMode=yes commonswarm@yulan-vps-1 \
    /bin/bash -s -- "$previous" "$failed" <<'BOX'
set -euo pipefail
previous=$1
failed=$2
root=/srv/commonswarm/site
test "$(readlink -f "$previous")" = "$previous"
test "$(readlink -f "$failed")" = "$failed"
test -f "$previous/app/index.html"
test "$(readlink -f "$root/current")" = "$failed"
test ! -e "$root/current.next"
test ! -L "$root/current.next"
ln -s "$previous" "$root/current.next"
mv -Tf "$root/current.next" "$root/current"
test "$(readlink -f "$root/current")" = "$previous"
date -u '+rollback_at=%Y-%m-%dT%H:%M:%SZ'
printf 'restored_release=%s\n' "$previous"
sha256sum "$previous/app/index.html" "$previous/download/index.html"
BOX
)
```

**Evidence:** rollback reason and approval, restored path, timestamp and hashes matching the pre-release record. Recheck public page bytes and signed-in Cold Agent Test loading in Anvil’s Chrome. Do not reuse site-05 unchanged: its assertion deliberately requires the new release.

The previous release must still exist. The helper’s retention policy is not a guarantee that an arbitrarily old current release survives pruning.

## 7. Closure

HezLead closes the window only after reviewing:

- Exact release SHA and freshly reconciled baseline.
- Complete carried site inventory and accepted public exposure.
- Environment validation without values.
- HM2 and other server dependency evidence.
- Exact-SHA gate evidence and any explicit exceptions.
- Deployment status, before/after release paths and public build hashes.
- Signed-in empty-state, console and both mobile-width controls.
- Rollback result if invoked.
- A sanitized evidence manifest containing no credentials, raw HTML, HAR files or private account data.

Record each outcome separately: **built**, **uploaded**, **switched**, **public bytes verified**, **browser controls passed**, and **closed**.

At preparation time, execution approval, resolution of the deployment-helper deletion conflict, actual live-site baseline, fresh owner preconditions, exact-SHA gate results, deployment and closure are **not established**. This document does not claim public hosted MCP availability or successful OAuth retry deployment.
