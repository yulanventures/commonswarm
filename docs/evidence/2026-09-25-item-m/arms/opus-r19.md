# Item M, exact-review arm (Anthropic family), round 19 (intended landing SHA 49c6eefd)

Reviewed: `git diff 6cac3114..49c6eefd` closely (Fold 18: `ec7a8dac`, `49c6eefd`) and the whole lane
`git diff 5d603b8e..49c6eefd` (docs/design skipped), in the detached worktree `scratchpad/arms2-m` at
`49c6eefd834c447c59b28744d20b18dfd33af4a3`.

Host rules after the 2026-09-25 incident apply. I ran no node, npm, npx, tsx or shell script. I only read files and
ran read-only git (`rev-parse`, `log`, `diff`, `diff --check`, `show`, `status`), grep and sed. I contacted no host, ran
no cswarm command, ran no SQL, assigned HOME nowhere, deleted nothing, and did not read `~/.cswarm` or
`~/.config/cswarm`. This file is the one file I wrote. I read `codex-r18.md` (named in the brief) but not
`codex-r19.md`.

Housekeeping: `git status --short` is empty. `git diff --check 5d603b8e..49c6eefd` exits 0. Both Fold 18 commits have
author and committer `yulanbot@gmail.com` and carry five `Agent-*` trailers. Fold 18 touches no `supabase/` file and
no server test. `mcp-connect.test.ts` has 101 `test(` entries (97 + 4 new), and the new control file is inside the
`test:p1-cli` glob (`package.json:25`); the spy is `.cjs` and is not collected as a test. The timeout citations
`mapping.json:3167` (`mcp-connect.ts:787`, the register abort timer), `:3183` (`mcp-connect.ts:317`, the `stty`
deadline) and `:3149` (`mcp-connect.ts:23`, `MCP_REGISTER_TIMEOUT_MS`) resolve at this SHA. No gate log for 49c6eefd
exists in `scratchpad/itemM/`; I saw only the Fold 18 focused result recorded in LANE.

## 1. Can any lane test read or write under the real home? (checked first)

Lane test files: `tests/p1-cli/mcp-connect.test.ts`, `mcp-connect-home-control.test.ts`, `mcp-connect-home-spy.cjs`,
`timeout-table.test.ts` (lane adds four citation tests that read repo files only), `workspace-name-agreement.test.ts`
(lane test uses `mkdtemp(join(tmpdir(), "cswarm-profile-shapes-"))`), `tests/p1-server/agent-join-credential.test.ts`
(database only), and the data fixture `command-dispatch-baseline.json`. None contains `userInfo`, `/Users/`, or a
hard-coded home path. Every `homedir`, `process.env.HOME` and `HOME:` site in the lane tests:

| Site | How it runs | Real home reachable? |
|---|---|---|
| `mcp-connect.test.ts:130` `join(homedir(), ".cswarm", "agents")` (the one remaining `homedir()` in the file) | `:128-129` save HOME and set `process.env.HOME = f.root` first; `f.root` is `mkdtemp(join(tmpdir(), "cswarm-mcp-connect-"))` (`:1103`). Restored in `finally` (`:199-200`). | No. `os.homedir()` reads `HOME` on each call; no module computes a home path at import time (no top-level `homedir()` in `src/`). |
| In-process default-route `connectMcp` without `profilePath`: `:177`, `:733/735`, `:1428-1476`, `:1683-1707`, `:2100-2113`, `:2142-2160`, `:2181-2192`, `:2211/2219`, `:2247`, `:2277-2291`, `:2315-2333` | Each enclosing test sets `process.env.HOME = f.root` before its `try` (`:129`, `:731`, `:1197`, `:1378`, `:1426`, `:1451`, `:1608`, `:1680`, `:2086`, `:2129`, `:2175`, `:2205`, `:2237`, `:2265`, `:2307`) and restores it in `finally`. | No. The only home-path sites reached in process are `mcp-connect.ts:471` and `:638`. |
| `:1056`, `:1063` default route with no HOME injection | Refused at `mcp-connect.ts:625-628` (URL) and `:630-633` (name) before the code prompt and before `:471`/`:638`. | No. See finding 6. |
| `cli()` children (`:2629-2630`, env is `{ PATH, ...env }`, not the parent env) | Every call passes `HOME: f.root` or `HOME: root` (`:750`, `:776`, `:989`, `:1000`, `:1005`, `:1007`, `:1665`, `:1670`, `:1939`, `:1959`, `:1974`, `:1987`, `:2647`, `:2652`, `:2657`, `:2670`, `:2856-2860`); every `root` is a `mkdtemp(join(tmpdir(), "cswarm-mcp-…"))`. | No. Without HOME the child would fall back to the passwd home, so this matters; every call sets it. The `~/empty-claim-and-profile/agent.json` at `:776` expands under `f.root`. |
| `tsx -e` children `:2489-2490`, `:2540-2548` | `env: { PATH, HOME: root }`, temp roots (`:2467`, `:2516`). | No. |
| `tsx -e` children `:317`, `:1729`, `:1761` (inherit the parent env) | Scripts import `storage.ts` and call `writeSecureJsonFile*` on `process.argv[1]`, a credential path under `f.root`. No home-path helper is called. | No. |
| `:962` `spawnSync` of `scripts/generate-mcp-register-refusals.mjs --check` | Not lane-changed; reads repo files. | No. |
| Recursive `rm` sites (`:191`, `:198`, `:994`, `:1010`, `:1122`, `:2158`, `:2257`, `:2299`, `:2463`, `:2511`, `:2576`, `:2662`, `:2675`, `:2716`, `:2753`, `:2862`) | Every target derives from `f.root` or a temp `root`; `:191/:198` delete `ownedDefault`, built from `:130` after the HOME injection. | No. |
| Control `mcp-connect-home-control.test.ts:9-10,28` | `mkdtemp("/tmp/lane-home.")`, `mkdtemp("/tmp/lane-home-spy.")`, then `rm` of exactly those two results. The child gets `HOME: home` (`:15`). | No. Nothing in the control derives from `homedir()`. |

Result: by reading, no lane test can read or write under the real home, with or without an outer temporary HOME.

**Would the AH1 control fail against 6cac3114?** Yes. At 6cac3114 the table built `defaultBase` from `homedir()` with no
HOME injection (`git show 6cac3114:tests/p1-cli/mcp-connect.test.ts`, old `:36`). In the control child that returns the
empty lane HOME. Two assertions then fail independently: the table's `mkdir(defaultBase, …)` leaves
`<lane HOME>/.cswarm/agents` (cleanup removes only the `mcp-*` children), so `readdir(home)` is `[".cswarm"]`
(control `:20-21`); and the spy records that `homedir()` call from a frame in `mcp-connect.test.ts`, so
`builtHomes.every(path => path !== home)` fails (`:25`). The positive control `builtHomes.length > 0` (`:24`) makes sure
the spy saw the default-path calls at all. The spy's filter `stack.includes("mcp-connect")` is sound here because the
only `homedir()` callers reached (test `:130`, `mcp-connect.ts:471`, `:638`) are the immediate caller frame, so the
default 10-frame stack limit cannot drop them. LANE AH1 records the same revert result (exit 1, `[".cswarm"]`).

Limits of the control (not defects): it guards the child run only; the parent's own run of the MCP file under the
real HOME relies on the same code, which is deterministic. Grandchildren are not spied; they either get an explicit
HOME or compute no home path (table above).

## 2. Is clear's classifier use complete? (AH2)

`clearMcpConnect` (`mcp-connect.ts:396-462`):
- `:398` `privateConnectLocation`, `:400` `pathExists(dir)`, `:401` `ensureSecureStateDirectory` — directory only.
- `:409` `preflightConnectReservedPaths(path)` before the lock: every fixed name, the profile basename, and every
  reserved temp present in the directory.
- `:410` connect lock; `:411` the same preflight again under the lock.
- `:412-414` `pathExists` and `emptyClaimAt` (lstat only).
- `:415` `cleanConnectTemps` (setup lock; unlinks dead-PID temps, which were just classified).
- `:418-440` profile scan: reads `candidate` files that are **not** reserved names (`:419`) plus the profile path,
  which `:411` already classified; `readProfileCredential` reads `credential.json`, also classified at `:411`.
- `:446-457` immediately before each `removeFile`, `classifyConnectReservedPath(file, { profileName })`; an error is
  thrown, `absent` is skipped. The `ENOENT` catch at `:455` does not swallow the classifier's errors (their `code` is the
  typed code).

So every reserved-name read and every unlink in clear is preceded by the classifier, twice for removals. No refusal in
connect sends the user to `--clear-pending` in a state the clear classifier would refuse: each clear advice
(`:557`, `:572`, `:574`, `:697`, `:705`, `:825`) is issued only after the same classifier passed for that
directory on that route, and clear's `connect_directory_mode` names the chmod step then the clear command (`:405`).
No loop.

Test `mcp-connect.test.ts:54-90` reaches: 0644 pending (preflight), oversize completion (preflight, `>16 KiB`), symlink
completion (preflight), a clean pending clear, and the race where completion becomes 0644 during the pending unlink
(caught only by the per-file classifier at `:449`). A revert of `:449` to raw `lstat` fails the race step. A revert of
the preflights alone is caught by steps 1-3 (at 6cac3114 clear removed the 0644 pending). See finding 3 for the partial
state after the race.

## 3. Other Fold 18 rulings, checked by reading

- **AH3** (`:222-230`): a `null` read or an `ENOENT` read error triggers one more `lstat`; only `ENOENT` gives `absent`,
  anything else gives `unreadable`. `readSecureJsonFileIfPresent` returns `null` on `ENOENT` or a missing secure parent
  (`storage.ts:562-578`); in the second case the file still exists, so the re-`lstat` correctly gives `unreadable`.
  Test `:34-52` covers vanished (null), present (null) and thrown `ENOENT`; each direction of revert fails one case.
- **AH4** (`storage.ts:472-473`, `:496-497`, `:513-514`): `chmod(0600)` now precedes the body callback in the replace
  writer, the exclusive writer and the fallback temp. Test `:92-107` sets umask 0277 and stats the handle inside the
  callback for all four writes; each writer has its own entry, so a revert at any one site fails. The Fold 12 test
  (`:873-890`) was honestly renamed "prepublish failure": the post-write chmod it used to break no longer exists, and a
  pre-write chmod failure uses the same `catch` (close, unlink temp). See finding 2 for the claim file.
- **AH5**: the `connect_complete_unsafe` branch and `inspectCompletion` are gone (`readComplete` `:43-58`; options
  `:383-394`). The strict path still refuses a completion swapped to a symlink after the preflight:
  `secureCredentialFile` throws, the non-mode branch reaches `:52` `connect_complete_unreadable`. `profileName` flows
  from `preflightConnectReservedPaths` (`:242`) and clear (`:449`), so a custom basename gets `connect_profile_*` and the
  label "profile". Test `:109-124` checks 0644 and symlink `agent.json` with zero POSTs.
- **LANE** (round-18 finding 4): line 3 now names Fold 18; HH6 (`:280`) and KK3 (`:307`) are marked superseded, and the
  deferral of the generic-lock window to lane 2b, with the landing order, is recorded at `:3` and in "Fold 18".

## 4. Kill points on this SHA

Fold 18 adds no POST and no new persistent write in connect. It adds classifier calls to clear and moves one `chmod`
earlier in each temp writer. For each single-process kill point the state left behind passes the classifier as `ok`
under a normal umask, and a same-command rerun ends with one seat, one live token and one working profile, or with a
typed refusal and no POST:
- pending only; pending plus a server commit (retry with the same `attemptId`, `:782`);
- a credential temp, an empty `wx` claim (`""` is not `null`) or a fallback temp; now 0600 from the first byte;
- credential, marker or profile written, no completion (marker check `:758-766`);
- completion written, pending not yet deleted (adoption `:754-775`, no POST);
- a stale `mcp-connect.lock` or `setup.lock` with its owner record.

Exceptions, all converging and all before any POST: an empty lock (pre-existing, deferred; finding 7); under a
restrictive umask, a temp killed between `open` and `chmod` (now a one-syscall window) or a fallback claim (finding 2),
each refused with the exact `chmod 600` step.

Clear kill points: clear unlinks at most pending then completion. A kill between them leaves completion only, which
the next clear removes (`hadPending` false, `:459`), and which connect handles as before.

## 5. Must-not-fire cases on this SHA

- A foreign damaged pending with a readable 0600 body passes the classifier (it does not parse) and is excluded by URL
  (`:561`). Test `:2126-2160` still expects zero notices and a fresh connect.
- A profile from another attempt beside pending still reaches `connect_profile_other_attempt` (`:765`).
- A different code, target or name still refuses before POST (`:697`, `:705`).
- A completed profile is adopted without POST (`:754-775`).
- A vanished reserved file no longer produces a false "cannot be read safely" (AH3).
- Clear no longer refuses a readable pending or completion record; it refuses only an unsafe one, with the same
  typed sentence connect gives.

## 6. Invariants on every path

- **I1:** holds. Fold 18 adds no credential write, move or delete. Clear never touches `credential.json`
  (only pending and completion at `:447`). The replacement rule in `agent-profile.ts:231-242` is unchanged.
- **I2:** holds. The new clear refusals are classifier sentences with no revoke advice.
- **I3:** holds. Every wrong-mode result, in connect and now in clear, gives the exact `chmod 600` or `chmod 700` step and
  "rerun the same command"; a mode problem is never called damaged. Finding 2 is I3-correct.
- **I4:** holds on the explicit route and on the default route for 0700 directories. For a wrong-mode `mcp-*` directory
  the default scan uses its older fallback (finding 1); it still blocks a same-URL pending and excludes only a pending
  for another URL, which cannot be this attempt, so no second seat is minted for one attempt.

## Findings

### 1. RIGOUR (low): the default scan reads a reserved file without the classifier when the directory is not secure

`mcp-connect.ts:494` `await ensureSecureStateDirectory(dirname(path));` runs before `checkingReserved = true` (`:495`),
so a 0755 or otherwise non-secure `mcp-*` directory skips the preflight at `:496` and takes the fallback:
```ts
const fileInfo = await lstat(pendingPath(path));          // :536
...
raw = await readFile(pendingPath(path), "utf8");          // :540
...
if (typeof loose?.url === "string" && loose.url !== target.url) continue;   // :561
```
This is the second half of Codex round-18 finding 2. Fold 18's AH2 addresses clear only, and LANE records no ruling on
this half. Effects: a read by `lstat` then `readFile` (follows a symlink swapped in between); and an inconsistency
with AE1: a 0644 foreign-URL pending in a 0700 directory refuses every default connect, while a 0600 foreign-URL
pending in a 0755 directory is skipped. It is fail-safe for I4 (this does not affect a same-URL pending, which gets
`connect_pending_mode` at `:562-565`). Fix or record: either a ruling in LANE that the wrong-mode-directory fallback is
kept on purpose, or run the classifier for the pending file in the fallback.

### 2. RIGOUR (low): the exclusive fallback's claim file is not set to 0600 before a possible kill

`storage.ts:506` `const final = await open(path, "wx", 0o600);` has no `chmod`. Under umask 0277 on a filesystem without
hard links, a kill between `:506` and the rename at `:522` (a window that includes a full body write and `fsync`) leaves
a 0400 empty `credential.json`. The next connect refuses at `:675` with `connect_credential_mode` and
`chmod 600 '<credential>'`; after the chmod the empty claim is handled as before. This is the same tool-written-state
class that AH4 fixed for temps; LANE's AH4 text says "temp writers", which is accurate, so this is not a false claim.
Fix: `await final.chmod(0o600)` right after `:506`.

### 3. RIGOUR (nit): a clear that fails after removing pending does not say that pending was removed

`mcp-connect.ts:447-457`: when the pending unlink succeeds and the completion classifier then refuses (test `:81-85`),
the thrown `connect_complete_mode` says only to chmod the completion record and rerun. The earlier removal is not
reported. The state is only reachable if the mode changes while this process holds the connect lock, and the rerun
works, so the effect is small; AGENTS.md asks output to say what happened.

### 4. RIGOUR (nit): the table test sets HOME before its `try`

`mcp-connect.test.ts:128-135`: HOME is assigned at `:129`, and `connectProfileReservedPaths` plus the
`assert.equal(names.length, 12, …)` at `:134-135` run before `try` (`:136`). If that assertion fails, HOME is not
restored and `f.root` is not removed. This is fail-safe (HOME then points at a temp directory), but moving `:131-135`
inside the `try` matches the other tests.

### 5. RIGOUR (nit): the new control needs `--test-isolation=none`

`mcp-connect-home-control.test.ts:14` passes `--test-isolation=none`, while `package.json:43` declares
`"node": ">=22"`. I did not establish that every Node 22 release accepts this flag name. If a gate host's Node rejects
it, the control fails closed (status not 0), so it cannot hide a leak; it can only make the gate red. LANE records a
passing focused run on the lead's host. The control also runs the whole 101-test MCP file a second time, in parallel
with the direct run, inside `npm run test:p1-cli`; this adds load but no shared state (all fixtures are `mkdtemp`).

### 6. RIGOUR (nit): two default-route tests do not inject HOME

`mcp-connect.test.ts:1054-1059` and `:1061-1065` call `connectMcp` with no `profilePath` and no HOME injection. They
refuse at `mcp-connect.ts:625-628` and `:630-633` before any home path is built, so they touch nothing, and the AH1
control would catch a reorder (the spy would see the lane HOME). AH1's text says "every default-route test injects
HOME"; these two are the exception.

### 7. PRODUCTION (low, pre-existing on `main`, deferred with a recorded landing order): empty lock after a kill

`storage.ts:395-398` creates the lock with `open(lockPath, "wx", 0o600)` and writes the owner record afterwards. A kill
in between (for example inside the post-register save's `setup.lock`) leaves an empty lock that the classifier accepts
(`""` is not `null`) and `deadLockOwnerRecord` cannot parse; a rerun within 30 s of the kill waits and fails with
`FileLockTimeoutError` "timed out waiting for the credential refresh lock" (`storage.ts:326`), which names the wrong lock
and gives no next step. A later rerun succeeds once the lock is older than `LOCK_STALE_MS` (60 s). No seat or token is
lost; pending and credential stay. The window existed on `main` (`open` then `writeFile`); the lane adds one `chmod`
inside it. LANE (`:3` and "Fold 18") defers this to lane 2b and states that item M lands after 2b and is re-reviewed on
top of it. I do not count it against this SHA's diff on that condition. If item M were merged before lane 2b, this
finding would stand as an open PRODUCTION defect of low severity.

### Noted, not findings

- Dead weight: clear's own profile and credential mode checks (`:423-426`, `:432-436`) are now reachable only by a race
  after `:411`; the classifier's `basename(path) === "profile.json"` alternative (`:196`, `:202`) matters only for the
  marker-only call at `:246`. Both are harmless.
- Round-18 finding 1 (real-home table) is fixed; findings 2, 3, 4, 5, 6 and 7 of round 18 are fixed by AH3, AH4, the
  LANE edits, AH5, AH2 and AH5 respectively.

## Five checks (round 1)

1. **Crash recovery: holds** for every single-process kill point above, and for setup/connect and connect/connect at
   one path; the exceptions converge with a typed step (findings 2 and 7).
2. **Record safety: holds.** Pending, completion and the marker are 0600 in a 0700 directory with no code or token.
   Temps are now 0600 from creation. The new messages print paths only.
3. **Typed refusals and advice: hold.** One classifier gives a typed code, the named file and a step for every reserved
   name and state, before POST and before any write on both routes, and now before every clear removal. Finding 1 is
   the one unclassified read.
4. **Strategist conditions: hold.** The TTY gate runs first (`:624`). On the explicit route the preflight runs before
   the code prompt (`:675` before `:700`). Recovery keeps the same attempt and seat; output is path-only.
5. **Evidence and gates: hold, with limits.** Each Fold 18 control fails on its single revert by reading; the AH1
   control would fail at 6cac3114 on two independent assertions. LANE rows now match the code. I saw no full-suite
   log for 49c6eefd.

## Not established

- I executed nothing. I traced each cell, each revert and each race from the code and measured none of them.
- Full suites, edge check, release bundle and site build at 49c6eefd: no gate log for this SHA existed when I finished.
- Whether every Node 22 release accepts `--test-isolation=none` (finding 5).

Rationale for the verdict: no lane test can reach the real home, by an enumeration of every home site, child process
and recursive delete; the AH1 control would fail against 6cac3114. Clear now classifies before every reserved read and
every removal, with no refusal loop. Every kill point converges and every invariant holds on every connect path. The
open items are RIGOUR low or nit, and the one PRODUCTION item is pre-existing on `main` and deferred to lane 2b with
the landing order recorded in LANE. This PASS is for 49c6eefd under that recorded order: item M lands after lane 2b
and is re-reviewed on top of it.

VERDICT: PASS
