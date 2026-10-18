# CommonSwarm standalone CI on pe-ci-1

This is a reviewed installation input, **not a completed migration**. Root owns
contention coordination, provisioning, credentials, timer activation and cutover.
Nothing here deploys to Yulan VPS or dispatches GitHub Actions.

The controller is installed from one reviewed commit. The service resolves `main`
once under `/var/lib/commonswarm-ci/queue.lock` using `flock(2)`, then runs server,
p1-cli, site, box-dry-run and unit serially at that exact SHA. Manual invocations
use the same queue:

```sh
bash /opt/commonswarm-ci/scripts/run.sh --sha <40-lowercase-hex> --suite all
bash /opt/commonswarm-ci/scripts/run.sh --sha <40-lowercase-hex> --suite p1-cli
bash /opt/commonswarm-ci/scripts/run.sh --ref main --suite all
```

`--suite` accepts only `all`, `server`, `p1-cli`, `site`, `box-dry-run`, `unit`.
`--ref` accepts only `main`; all other refs/extra arguments fail before work.

Every suite gets a fresh detached checkout, private bridge, disposable privileged
DinD daemon, worker container and shared scratch `/work` and `/tmp`. The worker
never mounts the host Docker socket, home, deploy key, PE directories or host
root. Only box fixtures run as root, inside the worker. DinD's privileged mode is
required for nested Linux containers; this is appropriate only on the separate
CI host. Root must review that tradeoff. Each daemon has a 2 GiB memory limit;
each worker has 4 GiB. No host ports are published. Fixed Supabase ports are
checked before use inside the new namespace. `Runner.Worker` activity refuses a
suite with status 75; it never cancels a PE job. This preflight is a snapshot,
not a fleet-wide reservation; Root still coordinates a quiet window.

The checkout's sole runtime patch is its unique Supabase `project_id`, retained
as `checkout.patch`. It does not change HEAD. The reviewed controller suite
adapter runs npm ci and the same workflow gates: management bundle, pinned edge
image, deferred stack migrations as supabase_admin with the workflow search_path,
four role grants, seed, ledger/connection-role assertions, server, MCP auth and
PostgreSQL tests, PG17 rehearsal and Docker stdin check. Site builds and tests
with the provisioned Playwright shell, without CHROME_BIN. Unit additionally runs
the focused standalone controls. Setup failure stops that suite; server test
failure still allows its independent MCP/rehearsal/stdin gates to run.

Root installation, after independent review and contention coordination:

1. Use a clean checkout of the reviewed controller SHA on **pe-ci-1**. As root,
   run `bash deploy/ci/provision.sh --sha <reviewed-controller-SHA>`. It refuses
   another hostname, dirty source, active runner workers or an existing install.
   It builds isolated Node 22.14.0, Deno 2.2.3, Supabase 2.118.0, Caddy 2.11.4,
   Playwright 1.63.0 and PG17 tools. PG17 has no default cluster. Downloads use
   publisher checksums; Caddy also checks the independently pinned SHA-512 and
   exact binary version. Resulting worker ID and DinD digest are pinned in config.
   Docker build cache contains only public tools; private source stays mode 0700.
   It installs the service/timer **disabled**, with no host sudo grant for gha.
2. Root creates a **new CommonSwarm repository-only read-only deploy key** and
   a verified GitHub known-hosts file. Do not reuse PE keys or SSH agent access.
   Keep key values out of commands/logs/reports. Root installs
   `/opt/commonswarm-ci/ssh_config` (readable by gha) with `Host github.com`,
   `IdentityFile` naming that new protected file, `IdentitiesOnly yes`,
   `IdentityAgent none`, `StrictHostKeyChecking yes`, `UserKnownHostsFile` naming
   the verified file, `BatchMode yes` and `ConnectTimeout 15`. The key itself is
   owned by gha, mode 0600, under a mode-0700 dedicated directory. Config, scripts
   and SSH policy remain root-owned. No secret values go in config.json.
3. Run `node --test tests/standalone-ci-guard.test.mjs` on the Linux CI host in a
   quiet window. Then, as gha, run the exact-SHA `--suite all` command above.
   Inspect all five receipts and actual gate counts; do not call a zero-test or
   skipped suite passing. The new controls also run in the standalone unit gate.
4. Enable the installed timer with `systemctl enable --now commonswarm-nightly.timer`.
   Verify `systemctl list-timers commonswarm-nightly.timer` and one completed
   timer-initiated service run: same resolved SHA in five successful receipts,
   expected queue/start/end times, image IDs, tool versions, artifact hashes and
   no cleanup errors. `Persistent=true` can run an overdue job immediately.
5. **Only after that evidence**, Root removes the CommonSwarm dispatch block
   from `~/bin/nightly-ci-dispatch.sh` while preserving every other repo, and
   removes only the `schedule` block in server-suite.yml in the cutover change.
   This implementation keeps both old triggers until verification. Release-PR
   and manual GHA interfaces, runners and fleet labels remain as before.

Suite time is capped at 1800 seconds including checkout, startup and installation,
then termination gets up to 60 seconds. The controller removes only exact-name,
matching-label containers, their anonymous volumes and the matching network.
It reclaims scratch ownership with the pinned tools image; a cleanup error
fails the receipt and retains scratch for Root. No global Docker prune is used.
Queue wait is outside the suite bound. A fetch has its own 120-second bound.
`COMMONSWARM_CI_CONFIG` selects an operator-owned config (also used by disposable
fixture tests); `timeout_seconds` may reduce the suite limit but cannot exceed it.

Receipts and logs are private under `/var/lib/commonswarm-ci/runs/csci-<uuid>/`.
`receipt.json` contains requested/resolved SHA, controller SHA/checksums, queued,
started and ended times, tool versions, per-gate statuses, exit/timeout, cleanup
errors, image identities and SHA-256 artifact hashes. The queue holder invokes
bounded retention after every invocation: only completed, clean owned runs older
than 14 days are removed. Unfinished/unclean or unknown paths require Root review.
Source and Docker tool caches are separate from run retention and contain no
production credentials. Never share raw logs; report sanitized test names/statuses.

Historical p1 diagnosis remains a Root gate: at each original exact SHA, compare
`node --import tsx --test tests/p1-cli/admin-recovery.test.ts tests/p1-cli/agent-channel.test.ts`
with `npm run test:p1-cli`, and repeat the channel file ten times under identical
limits. Use the same isolated container/queue limits as the suite. Do not run a
diagnostic directly against host services or add a new public runner argument.
The runner intentionally preserves failures; no product timeouts/allowlists changed.

Rollback: disable/stop `commonswarm-nightly.timer`, then stop its service and
verify owned cleanup/receipts. Restore the previous GHA cron and CommonSwarm Mac
dispatch block if already cut over. Preserve source, artifacts and caches for
review. Do not prune host Docker objects or touch any PE service/runner.
