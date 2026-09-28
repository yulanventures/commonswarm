# Operations Review: CommonSwarm Site Release Plan (HM Lane 8)

**Target Release SHA:** `8b8989f2b29e440a317a2cdedf11195901c8342c`
**Plan Document Reviewed:** `docs/evidence/2026-09-28-site-hm8/SITE-RELEASE.md` (attached in prompt)
**Governing Procedures:** [`deploy/site/deploy.sh`](local path), [`deploy/site/finalize-release.sh`](local path), [`deploy/site/RUNBOOK.md`](local path), [`deploy/site/validate-site-env.mjs`](local path)

---

## Criterion Analysis

### 1. Live Site Base Measurement before Delta Calculation
- **Requirement:** The plan must measure the live site's source SHA before computing the release delta, and not rely on an assumed base.
- **Verification:**
  - `step: site-01` (lines 55–76) reads `/srv/commonswarm/site/current` via `readlink -f` to record `previous_release` and asset hashes.
  - `step: site-02` (lines 88–135) explicitly uses `SITE_BASE_SHA` measured from `site-01` as `$base` to compute commit logs, commit counts, diff stats, name-status, and numstat diffs against `$target` (`8b8989f2b29e440a317a2cdedf11195901c8342c`).
  - Lines 139–145 clarify that the precomputed inventory table is only an expectation if the measured base is `218cf921d07d56f2b937822bcf18feb9d3be0f53`, and `site-02`'s measured base governs.
- **Status:** PASS (No KEEP).

---

### 2. Reconciliation of Site Changes & Commit Enumeration
- **Requirement:** The commit inventory must enumerate all commits touching `site/` between the measured live SHA and release SHA, and reconcile counts.
- **Verification:**
  - `step: site-02` (lines 108–125) writes `site-02-commits.txt`, `site-02-name-status.txt`, and `site-02-numstat.txt`.
  - It explicitly asserts matching counts using shell tests:
    - `test "$commit_count" -eq "$listed_commit_count"`
    - `test "$changed_file_count" -eq "$listed_file_count"`
    - `test "$changed_file_count" -eq "$numstat_file_count"`
- **Status:** PASS (No KEEP).

---

### 3. Step Script Verification & Argument Usage
- **Requirement:** Every named script must exist in the repository at the target SHA and be invoked with correct arguments.
- **Verification:**
  - `deploy/site/deploy.sh` exists ([deploy.sh](local path)). Called in `site-04` (line 409) as `/bin/sh deploy/site/deploy.sh commonswarm@yulan-vps-1`, matching line 6 (`Usage: deploy/site/deploy.sh <ssh-host>`).
  - `deploy/site/validate-site-env.mjs` exists ([validate-site-env.mjs](local path)). Called in `site-03` (line 335) as `node deploy/site/validate-site-env.mjs site/.env`, matching line 7 (`Usage: validate-site-env.mjs <site-env-file>`).
  - `deploy/site/finalize-release.sh` exists ([finalize-release.sh](local path)). Invoked inside `deploy.sh` (line 280) with 3 positional parameters (`$remote_temp`, `$remote_release`, `$remote_root`), matching line 112 (`Usage: finalize-release.sh <temporary-release> <final-release> <site-root>`).
- **Status:** PASS (No KEEP).

---

### 4. Symlink Handling, Release Naming, Atomic Switch & Rollback
- **Requirement:** Atomic switch and rollback mechanisms must correctly manage symlinks and release directory paths without standard race conditions or improper directory naming.
- **Verification:**
  - Directory Naming: Timestamped release names follow `20??????T??????Z-????????????-????????????????` (e.g. `YYYYMMDDTHHMMSSZ-gitsha-randomhex`), checked via regex in `site-05` (lines 451–453).
  - Atomic Switch: `finalize-release.sh` creates symlink `current.next` pointing to relative `releases/<release>` and performs atomic swap using `mv -Tf "$site_root/current.next" "$site_root/current"` on Linux (lines 154–158).
  - Rollback: `step: site-06` (lines 542–581) creates `current.next` pointing to `$previous` and atomically replaces `current` with `mv -Tf`, validating that `readlink -f "$root/current"` equals `$previous` post-switch (line 575).
- **Status:** PASS (No KEEP).

---

### 5. Robustness of Controls & Verification Assertions
- **Requirement:** Controls must not pass on failure (version markers, `/app` load, empty state, console errors, responsive layout).
- **Verification:**
  - `step: site-05` (lines 438–489) asserts:
    - Target marker `data-connected-apps-open` is present in `/app/index.html` (verified present in [LiveDashboard.astro#L446](local path)).
    - Exact byte match between local release files and public HTTP responses for `/app`, `/download`, and all referenced `/_astro/*.js` and `/_astro/*.css` assets.
  - Section 5 (lines 507–523) explicitly mandates real-Chrome checks:
    - Connected apps empty state: Must render exact string `No apps are connected to this account.` (loading/error state cannot pass).
    - Console errors: Explicitly zero application console errors or unhandled rejections permitted.
    - 320px & 390px Mobile view: Measures exact `.dashboard__rail` controls and layout bounds to ensure single-row layout without clipping or overflow.
- **Status:** PASS (No KEEP).

---

### 6. Runnable Step Formatting
- **Requirement:** Every executable step block must be formatted as its own ````sh ```` code block starting with `# step: <id>`.
- **Verification:**
  - Block 1 (line 55): ```sh `# step: site-01 — ...`
  - Block 2 (line 88): ```sh `# step: site-02 — ...`
  - Block 3 (line 281): ```sh `# step: site-03 — ...`
  - Block 4 (line 381): ```sh `# step: site-04 — ...`
  - Block 5 (line 438): ```sh `# step: site-05 — ...`
  - Block 6 (line 542): ```sh `# step: site-06 — ...`
  - All runnable blocks strictly match the required pattern.
- **Status:** PASS (No KEEP).

---

### 7. macOS `/bin/bash 3.2` Compatibility
- **Requirement:** Mac mini execution blocks must avoid bash 4+ syntax constructs (`$()` wrapping heredocs, associative arrays, `${var,,}`, `mapfile`, `|&`, `&>>`, `wait -n`).
- **Verification:**
  - Executable Mac mini blocks (`site-01`, `site-02`, `site-03`, `site-04`, `site-06`) were checked for bash 4+ features.
  - Heredocs are passed directly to processes (`ssh` or `node`) outside `$()`.
  - `${PIPESTATUS[@]}` used in `site-04` (line 411) is supported in Bash 2.0+ and fully compatible with macOS `/bin/bash 3.2`.
- **Status:** PASS (No KEEP).

---

## NITS (Non-blocking Suggestions)

1. **`site-03` Script Execution Order:** In `step: site-03`, `node deploy/site/validate-site-env.mjs site/.env` is executed immediately after an inline Node module script that repeats most of the JWT checks. While non-blocking and harmless, combining or ordering them sequentially is slightly redundant.
2. **POSIX shell distinction in `site-04`:** `site-04` invokes `deploy/site/deploy.sh` via `/bin/sh`. The top of `deploy.sh` contains a comment indicating compatibility with macOS `/bin/sh`. Using `PIPESTATUS` in `site-04` is valid because `site-04` itself runs under `/bin/bash 3.2`.

---

VERDICT: PASS