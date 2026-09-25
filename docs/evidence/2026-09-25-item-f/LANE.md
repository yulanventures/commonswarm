# Item F maker lane — 2026-09-25

Base: `origin/main` `d437c291`; branch `lane/item-f`. Brief committed first as `bc945e59`.
No production host, real workspace, or database was contacted or changed by this lane. CLI artifact probes used `--url http://127.0.0.1:54321` and temporary homes. No migration was applied.

## Rulings, changes, and controls

| Brief ruling | Change | Test and measured mutation |
|---|---|---|
| Active repository references use `yulanventures/commonswarm` | Changed `install.sh`, npm source template, staged npm metadata and README. Site footer, download clone command, and SEO source link derive from `site/src/lib/repository.ts`. | `npm run test:rebrand`: 21/21 pass. Its controls revert installer default, template and staged metadata, both READMEs, shared site URL, each of the three component links, and three rendered HTML links one at a time: 12/12 detected. A new script containing the old organization is also detected (1/1). Built `/`, `/download`, and `/orchestration` contain the new URL. |
| User-facing product and command names | Corrected root and site README product name and site README command examples. | Four one-at-a-time README mutations to the former product or CLI spelling: 4/4 detected by the audit. |
| Release bundle must omit builder paths | Added esbuild `--minify --legal-comments=none`; staged `dist-npm/cswarm.cjs` from that release build. The bundle no longer has esbuild module path labels. Build scripts run artifact version checks with a temporary HOME and loopback `--url`. Kept `__COSWARM_VERSION__`. `.gitattributes` exempts only the generated CJS file from Git's whitespace check because two vendor template literals contain significant trailing spaces. | `bash scripts/build-release.sh` exit 0, runnable version `0.1.77`; `bash scripts/build-npm.sh` exit 0. Both bundles have 0 `/Users/`, `Ridge.io`, and `Ridge-io` matches. Mutating each bundle with `/Users/builder/Developer/project/node_modules/example.js` is detected (2/2); removing the minify option is detected (1/1). Focused shipped-bundle test 1/1 pass. |
| Historical record remains intact | Audit allowlists evidence, org and design history, dated drift comments, fixtures, and documented local paths. The installer keeps its dated explanation without embedding the retired org literal in the served script. | Final audit scanned 2,602 tracked files, 39 built site files, and 2 bundles: 0 issues. It rejects old organization references in newly added tracked scripts (1/1 mutation). |

Mutation counts above total 20 distinct one-at-a-time controls; the baseline audit is the 21st test. The source snippet derivation test also passed 2/2, and SEO page tests passed 5/5 in the focused rerun. The audit is a dedicated `npm run test:rebrand` script so it builds the release bundle and site before scanning either; the source and generated artifacts cannot race a concurrent bundle build.

## Required gates

Build and test commands ran under a process-group timeout with a temporary HOME. Timeouts kill the process group. Counts are test counts where applicable; build and typecheck gates report the files or outputs measured.

| Gate | Exit | Measured result |
|---|---:|---|
| `npm run build` | 0 | CLI TypeScript build completed. |
| `env -u FORCE_COLOR npm test` | 1 | 990 tests: 988 pass, 2 fail on `spawn EPERM` in process-table and resume tests. This sandbox prevents those child spawns. |
| `env -u FORCE_COLOR npm run test:p1-cli` | 1 | Longer bounded rerun completed: 999 tests, 995 pass, 4 fail. Three failures require `ps` and report `spawn EPERM`; one MCP partial-check fixture reported an unreachable local read. That one test passed 1/1 on a focused rerun. The earlier six-minute attempt timed out with 221 passing cases printed and no final count; its process group was killed. |
| `npm run check:tests` | 0 | Test TypeScript check completed. |
| `npm run check:edge` | 0 | Six edge/runtime entry points checked. |
| `npm run build:command-core && git diff --exit-code supabase/functions/_shared/protocol.js` | 0 | Generated bundle diff: 0 bytes. |
| `bash scripts/build-release.sh` | 0 | One runnable 1.2 MB CLI bundle and checksum; 0 builder paths. |
| `npm --prefix site run build` | 0 | 12 pages, 39 built files. Initial attempt exited 1: Vite could not unlink a cache file under the original `site/node_modules` symlink outside this worktree (`EPERM`). An ignored local dependency copy resolved that sandbox filesystem error; the rerun exited 0. |
| `git diff --check origin/main...HEAD` | 0 | No whitespace errors. Initial run found 2 trailing-space lines inside minified vendor template literals; the targeted `.gitattributes` rule leaves their bytes unchanged. All other changed files passed without an exemption. |

Additional checks: `npm run test:rebrand` exit 0 (21/21); focused bundle test exit 0 (1/1); focused MCP partial-check test exit 0 (1/1); `npm --prefix site test` exit 1 (597 tests: 520 pass, 76 fail, 1 skip), with headless Chrome child processes aborting with `SIGABRT` in this sandbox. The focused rebrand, SEO, and source snippet tests passed 28/28 when run without a simultaneous bundle build. `pgrep` could not enumerate processes here (`sysmond service not found`); process-group timeouts and the completed test commands provide the available cleanup evidence.

## Kept and not established

Kept historical evidence and dated comments, `coswarm.dev` hazard warnings, fixture addresses and paths, the `supabase_db_cloud-swarm` name, the local directory name, and the paired `__COSWARM_VERSION__` identifier. They record history or are deliberate compatibility names, not active GitHub destinations. No repo transfer, DNS, Vercel, billing, secret, server, or database change was made.

The hosted installer, published npm metadata, and live site are not established by this lane. Release and publish remain with the lead and operations owners. The full root, CLI, and browser site suites are not green for the environment reasons above; the item F audit, focused bundle test, build, and typechecks passed.
