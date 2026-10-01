# HM37 split and lane 8: read-only audit

I reviewed the repository at `beb93996166af94b60d08b5cb2433956cba28f28`. No release step, production probe, edit, or test was run. This is a source audit, not a cross-model Alloy panel: dispatching that panel would create files and spend provider tokens, contrary to the requested read-only boundary.

**Release ordering:** Window A ends with edge `eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922` live and public MCP dark. Window B owns Deno, the human session, the hosted harness, and hosted S2/S4/S5 controls. Lane 8 starts only after a recorded successful HM37 live close. The current plans still describe one combined HM37 window and immediate lane chaining ([BOX-WINDOW.md:686](docs/evidence/2026-09-28-box-hm37/BOX-WINDOW.md:686), [SITE-RELEASE.md:11](docs/evidence/2026-09-28-site-hm8/SITE-RELEASE.md:11)); both need revision.

In the inventory below, **BW**, **RB**, **SR**, **W**, and **P** mean `BOX-WINDOW.md`, `deploy/RELEASE-TO-BOX.md`, `SITE-RELEASE.md`, `.walk.md`, and `.preseed.md`. Proposed block names are new `# step:` markers, each with an explicit host and `# readonly: yes|no`. “Assert” means an assertion in a marked predecessor or consumer block. The 75 K IDs are all accounted for. The purported “16 P items” are **17 table rows**, `.preseed.md:42–58`; I account for all 17.

## 1. Deduplicated gap inventory

| ID(s) | Plan / window | Gap and concrete fix |
|---|---|---|
| P1-K1-01/02, P1-K5-01, P:42 | RB / A and B | Window times are injected by the fixture (`RB:151–180`, `BW:707`). Add `hm37a-open-inputs` and `hm37b-open-inputs`: take the **box clock** inside each open block, derive end as start plus four hours, persist both, and reject supplied or stale values. |
| P:43 | RB, BW / A and B | The fixture supplies `BACKUP_MAX_AGE_SECONDS=86400` (`BW:801–823`, `RB:1477–1502`). Name it in each window’s prompt inputs, record HezLead’s positive integer, and assert the same recorded value at both consumers. |
| P1-K2-01/K3-01, P:50 | RB / A | `gate-evidence.txt` has no producer (`RB:129–142,194–197`). Add `hm37a-gate-ingest`: verify the exact-SHA receipt and create the protected file before `runbook-02`. |
| P1-K2-02/K3-02, P:50 | RB / A | Reviewed SQL proof files are absent before packaging (`RB:391–393,879–902`). Add `hm37a-proof-sql-stage`: copy the enumerated exact-SHA files, assert their count, names and hashes, then make `runbook-07` depend on them. |
| P1-K2-03/K3-03/K5-02, P:44 | BW / A; fresh record for B | The fixture creates `GO.txt`; the plan only consumes it (`BW:574,586–599`). Add `hm37a-go-record` and `hm37b-go-record`, generated from approver, plan commit, release SHA and prompt number. The open block must assert no other active window state **or release process**; otherwise STOP. |
| P:51 | BW, RB / A; repeat B identity check | The exact clean checkout is fixture-made (`BW:110–127`, `RB:175–178`). Add `hm37a-source-checkout` before `hm37-source-identity`; assert HEAD, remote, clean relevant paths and reviewed SHA. B rechecks rather than silently inheriting it. |
| P:52 | BW, RB / A; separate B selections | The fixture resolves switches and placeholders (`BW:664–680`, `RB:258–269,416–441,559–601`). Add `hm37a-resolved-inputs` to render and validate every selected value and derived archive digest, rejecting any remaining placeholder. B gets its own resolved input and dry run. |
| P:48–49 | BW, RB / A | The OAuth image proof and previous edge `compose.override.yaml` are fixture-only (`BW:379–402`, `RB:612–614`). Add `hm37a-baseline-inventory` to assert their exact paths, type, ownership, modes, digest and running-image match before using them. |
| P1-K2-05/K3-05/K6-04/K6-07 | BW / A | Prerequisite and stack-runtime reports have no reviewed producer; a prior ad hoc script failed on unbound `STACK_RELEASE_DIR` (`BW:1949–1952`, `W:63,66`). Add `hm37a-prerequisite-evidence`, initializing paths internally and writing both bounded 0600 artifacts; assert them before manifest creation. |
| P1-K6-01/02/03 | BW, RB / A | Prior execution needed a container bind path for the SQL helper, newline-safe OAuth image ID reading, and local `PROOF_DIR` initialization (`W:60–62`). Fix the three marked blocks themselves and whole-block dry-run both image-file endings. |
| P:53, **A** | RB / A | `runbook-14` reads historical `/home/commonswarm/migration-direct.env`, although the fixture stub prints PASS and M8 measured only current `target.env` (`RB:1083–1118`, `P:53`). Replace `runbook-14` with a static/current target-only file assertion and shape check; never fall back to the historical source. |
| P1-K1-03/04/05, P1-K2-07/K3-06/K4-03/K5-03, P:47 | BW / **A** | The old local control assumes new credentials and prose-only setup (`BW:1759–1821`). Replace it with `hm37a-existing-seat-preflight` and `hm37a-directed-check`: select two or three **existing** Cold Agent Test profiles, verify `cswarm` 0.1.80 and authenticated identity, then send one directed signal; prove one receive, empty second read, ACK cursor advance, and third-seat exclusion. Record IDs and states, never credentials. Remove the obsolete mint/validator inputs. |
| P1-K2-08/K3-07/K6-06 | BW / A and B | Post-control, functional reread, revocation, and close artifacts are output requirements without full producers (`BW:1961–1965,1985–2011`). Add `hm37a-post-control-readback` and `hm37a-close-readback`; B has corresponding hosted producers. Make every exit path create the applicable bounded artifacts before copy-back. |
| P1-K5-04, P1-K6-09 | BW / A and B | Post-commit failure routing and unknown-failure cleanup remain prose/manual (`BW:1601–1638,1823–1825`, `W:56,68`). Add `hm37a-failure-dispatch` and `hm37b-failure-dispatch` with a complete assertion-ID map. A maps public S1 and the S5 bearer refusal to edge-first rollback; B maps hosted S2/S4/S5. Unknown IDs STOP after guarded cleanup and recorded readback. |
| P1-K5-05 | BW / A and B | Reserved schema rollback is described as a separate approval, while the SQL already checks both durable history tables (`BW:1849–1884`). Add a recorded HezLead rollback input. The block must independently verify empty cursors and batches; **nonempty means STOP, no schema rollback, report**. |
| P1-K5-06 | BW / A and B | Unsafe outgoing-log disposition is unmarked (`BW:1973–1983`). Add `hm37*-outgoing-log-review`: if secret scan fails, leave that log on the box at 0600, omit it from copy-back, record the omission, and continue the window. |
| P1-K5-07, P1-K6-08/09/10 | BW, RB / A and B | Closure, supplemental manifest entries, failed-window rename and scratch cleanup required manual work (`BW:1985–2011`, `W:67–69`). Add `hm37*-manifest-close` and guarded `hm37*-closed-window-rename`; automatic closure follows successful readbacks, while failed readback is STOP. `runbook-12` consumes the close receipt. |
| P1-K2-06/K3-05/K6-04 | BW / **B only** | Worker-boundary and hosted-input review files lack Mac producers and box transfer (`BW:1286–1292,1952,1959,1967–1969`). Add `hm37b-control-review` and `hm37b-review-transfer`, with accepted checksums and no protected input values. |
| P1-K2-04/K3-04/K6-05, P:45 | BW / **B only** | Harness, import map and protected human session are not transferred into the staged box tree (`BW:1404–1444,1514–1518`). Add `hm37b-stage-transfer` after session preparation, checking exact hashes, root ownership and 0700/0600 modes. |
| P1-K4-01 | BW / **B only** | M1 measured Deno absent; stage requires it (`BW:1387–1567`, box facts M1). State and assert `hm37-deno-install → hm37-hosted-control-stage → hosted control → hm37-deno-remove`, with B-specific abort cleanup. |
| P1-K4-02, P1-K5-03, P:46 | BW / **B only** | Current Mac human login, Cold Agent Test owner access and usable session were not measured (`BW:1329–1369,1404–1411`). Add `hm37b-human-preflight` before session export: Anvil uses the 1Password service account for only `c2ea0541-f56d-4c73-bf71-56c5405c4934`; measure before opening B; keychain dialog or 2FA means STOP. |
| P1-K2-08/K3-07/K6-06/09 | BW / **B only** | Hosted open/ACK, cleanup, public no-mutation and close results are not complete marked paths (`BW:1579–1646,1960–1965`). Add `hm37b-hosted-control-results` and failure-specific readbacks for S2, hosted S4 and S5 seat handle. B’s manifest requires exactly its B artifacts. |
| P2-K1-01, P:54 | SR / lane 8 | The fixture injects the site start (`SR:55,91–97`). Add `site-00-open-inputs`: use the box-clock start, derive end plus four hours, and persist a lane-specific ID. |
| P2-K1-02/K2-01/K3-01, P:54 | SR / lane 8 | `SITE_EVIDENCE` exists only in the fixture (`SR:55–67`). The same `site-00-open-inputs` creates and asserts its absolute, private 0700 directory before `site-01`. |
| P2-K1-03/K2-02/K3-02, P:55 | SR / lane 8 | Exact release checkout and full baseline SHA are preseeded (`SR:91–123`). Add `site-00-source-checkout`: resolve the baseline from its receipt, create an isolated clean checkout of `8b8989f2b29e440a317a2cdedf11195901c8342c`, and export the checked path. |
| P2-K1-04/K2-04/K3-04, P:57 | SR / lane 8 | The dedicated owner token file has no producer (`SR:341,392–405`). Add `site-00-owner-input` from the approved signed-in owner session, protected 0600, with marked cleanup. |
| P2-K2-03/K3-03, P:56 | SR / lane 8 | `site/.env` and absence of overrides are fixture-made (`SR:329–391`). Add `site-00-build-env`: populate from the approved production secret reference without printing values; assert URL, anon-key shape, H0 setting, mode and absent overrides. |
| P2-K2-05/K3-05 | SR / lane 8 | Exact-SHA non-mini gate receipts are prose-only (`SR:454–456`). Add `site-00-gate-ingest`, validating origin, SHA, result and file modes. |
| P2-K2-06/K3-06/K5-02/K5-05/K5-06, P:58 | SR / lane 8 | `GO.txt` is fixture-made (`SR:491,511–513`). Add `site-03-go-record`: include exact release/base SHAs, HezLead’s management-surface acceptance, gate/SSH/account holds, previous-release pin and prompt number; `site-04` checks it. |
| P2-K5-01 | SR / lane 8 | The old “same combined window” prerequisite is stale (`SR:11`). Require named input `GATE_HM37_LIVE=yes` backed by a successful **B** close receipt showing edge live, controls and cleanup passed. |
| P2-K2-07/K3-07 | SR / lane 8 | Five-release retention can remove the rollback target (`SR:465,479–487,754`). Add `site-03-pin-previous`: pin the measured previous tree for the **whole** lane 8 window; prove the pin before switch and check it again after deploy and before rollback. |
| P2-K2-08 | SR / lane 8 | Retry after deploy/SSH failure has only prose reconciliation (`SR:550`). Add `site-04-reconcile-failure`: read current/target paths and status, record a 0600 retry decision, and forbid blind replay. |
| P2-K2-09/K3-08/K4-03 | SR / lane 8 | Real-Chrome account state and acceptance are not established (`SR:654–681`). Add `site-03-browser-owner-preflight` and `site-05-browser-acceptance`: verify signed-in dedicated owner and restricted workspace, then record empty state, console, asset and both mobile-width results. |
| P2-K2-10/K5-07 | SR / lane 8 | Rollback verification is prose and rollback waits for direction (`SR:693–701,752`). Make failed lane 8 controls **automatically** invoke `site-06`, then `site-06-verify` checks public bytes and signed-in Chrome against the saved baseline. |
| P2-K2-11/K3-09/K5-08 | SR / lane 8 | No marked sanitized manifest or close readback (`SR:756–770`). Add `site-07-manifest-close`; close automatically after required readbacks pass, otherwise STOP. |
| P2-K4-01/02 | SR / lane 8 | M3/M13/M15 do not prove direct Mac `commonswarm` SSH, site-root write rights or outbound HTTPS as that user (`SR:69–85,561–647`). Add `site-00-box-access-preflight` and `site-00-box-egress-preflight`; see read-only commands below. |
| P2-K5-03 | SR / lane 8 | The recorded HM2 SQL/edge evidence and current empty-view check do **not** establish owner-scoped successful revoke plus deny-state readback (`SR:308–324,683–691`). Add `site-03-revoke-evidence-ruling`: HezLead names accepted evidence for **both** grant and seat, or holds GO for a separately authorized disposable control. |
| P2-K5-04 | SR / lane 8 | The plan says the deletion guards are missing (`SR:467–469`), but both guards **are present at the pinned release SHA**; see proof below. Replace the stale hold with an exact-SHA guard-and-test assertion. |

The fixture also spreads `...process.env` into block shells (`tests/box-dry-run.test.ts:800–815,1101–1129`) and stubs successful PostgreSQL and hosted-control answers (`.preseed.md:60–73`). **B** therefore needs a sanitized environment allowlist and live positive-control results; a fixture PASS is not a production measurement.

## 2. Named prompt inputs

Inputs below are public identifiers or paths. Credential **values** stay in protected files and must not be supplied in prompts.

| Window | Name | Meaning, supplier, format |
|---|---|---|
| A and B, separately | `APPROVER` | HezLead; exact string `HezLead`. |
| A and B, separately | `PLAN_COMMIT` | HezLead/Anvil; full 40-hex reviewed plan commit for that window. |
| A and B, separately | `RELEASE_SHA` | HezLead/Anvil; full 40-hex `eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922`, subject to exact reviewed input. |
| A and B, separately | `PROMPT_NUMBER` | HezLead; positive decimal approved prompt number. These four fields generate that window’s `GO.txt`; times are measured from the box clock in its open block. |
| A and B | `BACKUP_MAX_AGE_SECONDS` | HezLead; positive decimal seconds, recorded once per window and used consistently. |
| A | `GATE_RECEIPT_PATH`, `PROOF_SQL_ROOT`, `RELEASE_REPO` | Anvil from reviewed exact-SHA artifacts; absolute paths. |
| A | `COLD_AGENT_PROFILE_PATHS` | Anvil; two or three absolute paths to **existing** agent profiles for workspace `c2ea0541-f56d-4c73-bf71-56c5405c4934`, each measured by `whoami`. |
| A | `KIND_LIST`, `H0_LEDGER_BACKFILL`, `GUARDED_STACK_SWITCH`, `BACKUP_STATUS_PROOF`, `API_CADDY_PAIR`, `MCP_CADDY_RELEASE`, `CHANGED_FUNCTIONS`, `ROUTER_CHANGED` | HezLead’s reviewed selection; exact values in `.walk.md:6–14`: `edge stack`, `no`, `no`, `no`, `no`, `no`, `command mcp`, `yes`. Record as a resolved input receipt. |
| B | `HUMAN_SESSION_SOURCE`, `HARNESS_SOURCE`, `IMPORT_MAP_SOURCE` | Anvil; protected local session path and exact reviewed harness paths. Only B stages these on the box. |
| B | `HUMAN_LOGIN_PREFLIGHT` | Anvil; `PASS`/`STOP` with timestamp and workspace ID, measured before B opens using the 1Password service account. Any keychain dialog or 2FA yields `STOP`. |
| A or B rollback | `SCHEMA_ROLLBACK_APPROVAL` | HezLead; explicit `yes` tied to window ID and prior-edge readback. The SQL’s own empty-history guard remains mandatory (`BW:1871–1884`). |
| Lane 8 | `GATE_HM37_LIVE` | HezLead from successful B close receipt; exactly `yes`. |
| Lane 8 | `SITE_RELEASE_SHA`, `SITE_BASE_SHA`, `SITE_RELEASE_REPO` | Anvil from reviewed release and baseline receipts; full 40-hex SHAs `8b8989f2b29e440a317a2cdedf11195901c8342c` and `9b085c82352390cf8f0fe515c02b3ccff423476a`, plus absolute isolated checkout path (`SR:23,30–31,91–100`). |
| Lane 8 | `SITE_EVIDENCE`, `SITE_OWNER_ACCESS_TOKEN_FILE` | Anvil; absolute protected directory and regular non-symlink 0600 file path. The site open block creates/validates the directory; no token value appears in the prompt. |
| Lane 8 | `SITE_GATE_RECEIPT_PATH`, `SITE_PREVIOUS_PIN` | Anvil; absolute exact-SHA receipt path and measured previous-release path/pin receipt. |
| Lane 8 | `SITE_APPROVER`, `SITE_PLAN_COMMIT`, `SITE_PROMPT_NUMBER` | HezLead; exact name, full 40-hex plan commit and positive decimal prompt number for lane 8 GO. Its start/end come from the box-clock open block. |

## 3. Read-only measurements for Anvil to review

These are **proposed commands, not executed measurements**. They print identities, paths, modes or HTTP status lines; they do not print tokens, headers containing credentials, or environment values. `cswarm whoami` and `status` are registered as non-mutating commands in `src/cli.ts:10316–10318`; profile inventory is local and reads no credential (`src/cli.ts:10161–10195`).

**P1-K4-02 (B), P1-K4-03 (A), and existing A seats — Mac:**

```sh
command -v cswarm
cswarm --version
cswarm profile ls --json |
  jq -r '.profiles[] |
    [.path, (.workspace_id // ""), (.principal_id // ""),
     (.principal_name // ""), (.url_host // ""), (.error // "")] | @tsv'

# Repeat for each of two or three EXISTING profile paths selected above.
cswarm whoami --profile "$PROFILE_PATH" --json |
  jq '{credential_valid, credential_metadata_match,
       principal_id, display_name, workspace_id, workspace_name,
       owner_user_id}'
```

Require version `0.1.80`, production host, three distinct principal IDs if using the third-seat exclusion, valid credentials, and workspace `c2ea0541-f56d-4c73-bf71-56c5405c4934`. `whoami` is the server-proven identity read (`src/cli.ts:4555–4640`). The A signal/receive/ACK control is **not** part of this read-only preflight.

For the human owner, use the existing login and filter `status` immediately:

```sh
cswarm status --workspace-id c2ea0541-f56d-4c73-bf71-56c5405c4934 --json |
  jq '{user_id: .identity.user_id,
       workspace_id: .selected_project.workspace_id,
       workspace_name: .selected_project.name,
       project_count, warning_codes: [.warnings[]?.code]}'
```

This establishes the CLI login, not the browser’s signed-in identity or the ability to export a protected B session (`src/cli.ts:2002–2133`). Review the browser/session state separately before B.

**P2-K4-01 — direct account and non-destructive permission preflight:**

```sh
ssh -o BatchMode=yes commonswarm@yulan-vps-1 \
  'id -un; readlink -f /srv/commonswarm/site/current;
   test -w /srv/commonswarm/site && echo site_root_writable=yes;
   test -w /srv/commonswarm/site/releases && echo releases_writable=yes;
   stat -c "%n %F %U:%G %a" /srv/commonswarm/site /srv/commonswarm/site/releases'
```

Check the SSH host identity against the pinned operator record. `test -w` is a permission indication; it does not prove a future rename will succeed (`SR:69–85,517–544`).

**P2-K4-02 — HTTPS/DNS as `commonswarm`, headers only:**

```sh
ssh -o BatchMode=yes commonswarm@yulan-vps-1 \
  'python3 --version;
   curl -sS -I --max-time 15 -o /dev/null -w "site_http=%{http_code} remote_ip=%{remote_ip}\n" https://commonswarm.com/app;
   curl -sS -I --max-time 15 -o /dev/null -w "api_http=%{http_code} remote_ip=%{remote_ip}\n" https://api.commonswarm.com/functions/v1/h0/agent-doc/smoke'
```

A HEAD success is egress evidence, not the later GET/body acceptance (`SR:561–647`).

**P2-K4-03 — dedicated signed-in owner:** run the filtered `cswarm status` command above for CLI state, then in Anvil’s existing real Chrome session open `/app`, inspect only the displayed account, selected workspace and Connected apps empty/list state, and record those names/states. A terminal status call cannot establish the browser session (`SR:654–681`).

## 4. Customer-visible surface at the lane 8 SHA

**One line:** A signed-in customer can open **Connected apps**, see existing connections, their status, consented workspaces and hosted seats (or an empty state), retry a failed load, and revoke a seat or connection with a committed-state reread; the page has no connection-creation action while hosted MCP remains dark (`8b8989f2:site/src/components/app/LiveDashboard.astro:1019–1035,6157–6285`; `8b8989f2:site/src/lib/connected-apps.ts:88–145`).

## 5. Recursive-deletion guard at `8b8989f2`

**Present in both files.** At that SHA, `deploy/site/deploy.sh:47–116` resolves target/root, rejects empty, `/`, symlinks, HOME and out-of-root targets before `rm -rf`; its cleanup calls the guard at `:242–254`. `deploy/site/finalize-release.sh:35–106` applies the same checks and protects the current release; pruning calls it at `:160–215`. Exact-SHA tests include refusal probes and positive delete controls (`tests/p1-cli/site-deletion-safety.test.ts:65–122,183–221`). This contradicts the stale execution hold in `SITE-RELEASE.md:467–469`. The guard does **not** pin the previous release against the five-release retention policy.

## 6. Revoke evidence and code drift for P2-K5-03

The recorded production HM2 receipt is at edge SHA `72c57e0d76d0aa86fe4f811a2cf51499919fed20`: migration functional result `t` and healthy edge close (`docs/evidence/2026-09-28-release-72c57e0d76d0-rerun-4/20260928000002-functional.txt:1`, `close-readback.txt:1–9`). The repo’s server test exercises owner grant revocation and persisted `revoked_at` (`tests/p1-server/hosted-authority.test.ts:855–870`), but that is test evidence, not a recorded successful **live owner grant-and-seat revoke/readback**. The plan correctly says the HM2 functional receipt can pass with no hosted grants (`SITE-RELEASE.md:308–324,683–691`). I found no committed live owner-scoped receipt for both revoke commands.

`git diff --stat 72c57e0d..8b8989f2 --` the revoke-path files is:

```text
 site/src/components/app/LiveDashboard.astro | 276 +++++++++++++++++++++-
 site/src/lib/connected-apps.ts              | 145 ++++++++++++
 supabase/functions/command/index.ts         | 354 +++++++++++++++++++++++++++-
 tests/p1-server/hosted-authority.test.ts    |  56 +++--
 4 files changed, 807 insertions(+), 24 deletions(-)
```

The migration `supabase/migrations/20260928000002_hm_hosted_authority.sql` and reducer `src/protocol/hosted-authority.ts` are unchanged in that comparison. Thus the current live HM2 evidence predates changed command code and the new site revoke UI. HezLead can accept the **code/test and SQL evidence for those limited claims**, but cannot label both live revoke/readback controls established from it; if live behavior is a GO condition, use a separately authorized disposable Cold Agent Test grant-and-seat control as `SITE-RELEASE.md:691` specifies.