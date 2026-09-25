# Item K lane evidence — 2026-09-25

Base: `origin/main` at `d437c29158d97c85f463ec6209160f5293e8944b`. This lane did not contact a production host or workspace. All direct CLI invocations in this lane used a loopback `--url`. The local server test was written for the lead; it was not run here and no migration was applied.

| Ruling | Change and test | Measured mutation | Not established |
|---|---|---|---|
| Help comes from the command table | `usage()` and scoped `--help` render each visible table entry, variant synopsis, description, and table flags. Onboarding guidance remains prose. `command-table-gates.test.ts` compares the generated output to the table and launches every visible verb/action with loopback `--url --help`; the focused run passed 19/19 including related controls. | Replaced rendered `--since` with `--missing`: command-table gate exit 1, 11/12 passed, 1 failed. | No check against a released binary or production CLI. Existing historical usage lines remain in the table as synopsis data; some CLI-only flags are separate from MCP tool flags. |
| Profile inventory is local and credential-free | `profile ls` scans the shared `agentProfileRoot()` used by automatic setup and MCP connect, reports path, principal ID, cached workspace name/ID, host, and parse error, with JSON output. `profile-ls.test.ts` uses temporary HOME and two layouts plus a malformed profile; it succeeds without any credential file. | Disabled the directory walk: profile test exit 1, 0/1 passed. | Explicit `--profile` paths outside the shared root cannot be discovered retroactively. No current principal name is stored in `profile.json`, so the inventory prints its ID. |
| Invalid path gives a usable remedy | `privatePath()` names the real automatic layout and directs the user to `cswarm profile ls`; the profile test checks a bare UUID refusal. | Removed the `profile ls` remedy: profile test exit 1, 0/1 passed. | No production profile was read. |
| `inbox --since` drains matching agent pages | When no explicit `--limit` is set, the agent read uses the same ascending cursor capability that `check` requires, drains full pages, then restores newest-first output. An explicit `--limit` keeps its bound and reports a shared notice in help and output. The pure `inbox-since.test.ts` proves 101 directed rows cross the 100-row page boundary. `inbox-since-check.test.ts` exercises exact millisecond/microsecond and offset timestamps, stale filtering, about/kind defaults, and 50 newer asks against the local edge. | Changed the page-end condition to stop at 100: pure test exit 1, 0/1 passed. | The server test was not run; the local-edge result and the original field report's exact cause remain unmeasured. Source shows both `check` and `inbox` apply the same stale filter and neither has implicit about/channel filters. The prior inbox default was newest 50 while `check` pages oldest first, so a directed ask with 50 newer matches is a concrete client-side disagreement to verify on the stack. |

## Verification

| Gate | Exit | Count / observation |
|---|---:|---|
| `npm run build` | 0 | TypeScript build completed. |
| `env -u FORCE_COLOR npm test` | pending |  |
| `env -u FORCE_COLOR npm run test:p1-cli` | pending |  |
| `npm run check:tests` | 0 | Test TypeScript check completed. |
| `npm run check:edge` | 0 | Six Deno entry points checked. |
| `npm run build:command-core` then generated bundle diff | 0 / 0 | Generated bundle unchanged. |
| `bash scripts/build-release.sh` | 0 | 0.1.77 artifact execute-check completed with loopback URL. |
| `npm --prefix site run build` | 0 | 12 pages built. |
| `git diff --check origin/main...HEAD` | pending |  |

The original worktree Git metadata path disappeared during verification, along with the parent checkout. To retain this lane's files and commits, I cloned `yulanventures/commonswarm` at the same `d437c291` base into `/tmp/item-k-recovery`, then used that Git directory with this worktree as its work tree. A task-local `git` wrapper points Git calls from this lane at the recovered repository; other directories still use system Git. This is a local recovery, not a push or merge. The original brief commit was re-created in the recovered history.
