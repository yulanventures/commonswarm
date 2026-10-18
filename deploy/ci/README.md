# CommonSwarm standalone CI on pe-ci-1

This is a reviewed installation input, **not a completed migration**. Root owns
contention coordination, provisioning, timer activation and cutover.
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
never mounts the host Docker socket, home, PE directories or host
root. Only box fixtures run as root, inside the worker. DinD's privileged mode is
required for nested Linux containers; this is appropriate only on the separate
CI host. Root must review that tradeoff. Each daemon has a 2 GiB memory limit;
each worker has 4 GiB. No host ports are published. Fixed Supabase ports are
checked before use inside the new namespace. Before every command and while
waiting for its active process (at most 250 ms between probes, plus probe latency),
the controller checks `Runner.Worker`. New PE activity withdraws CommonSwarm:
it terminates its own process and removes only exact-name, matching-label owned
containers/network. The attempt receipt says `state=deferred`, `pending=true`,
exit 75; this is unfinished work. After PE becomes quiet the same resolved SHA
retries from a fresh checkout, under the same queue lock and suite deadline.
Cleanup failures stop retrying. Persistent contention fails with timeout 124;
no PE job is cancelled. Polling is reactive, so Root must still measure withdrawal
latency and memory headroom during a controlled PE overlap before activation.

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
2. Source is the public repository at exactly
   `https://github.com/yulanventures/commonswarm.git`. No deploy key or SSH policy
   is required. The controller rejects other URLs, clears inherited Git/provider
   environment, ignores global/system Git configuration, disables credential
   helpers and extra HTTP headers for fetch, and disables interactive prompts.
   No host Git configuration changes are needed; PE credentials are not reused.
3. Run `node --test tests/standalone-ci-guard.test.mjs` on the Linux CI host in a
   quiet window. Then, as gha, run the exact-SHA `--suite all` command above.
   Inspect all five receipts and actual gate counts; do not call a zero-test or
   skipped suite passing. The new controls also run in the standalone unit gate.
4. Enable the installed timer with `systemctl enable --now commonswarm-nightly.timer`.
   Verify `systemctl list-timers commonswarm-nightly.timer` and one completed
   timer-initiated service run: same resolved SHA in five successful receipts,
   expected queue/start/end times, deferred-attempt/retry chain where applicable,
   image IDs, tool versions, artifact hashes and no cleanup errors. `Persistent=true` can run an overdue job immediately.
5. **Only after that evidence**, Root removes the CommonSwarm dispatch block
   from `~/bin/nightly-ci-dispatch.sh` while preserving every other repo, and
   removes only the `schedule` block in server-suite.yml in the cutover change.
   This implementation keeps both old triggers until verification. Release-PR
   and manual GHA interfaces, runners and fleet labels remain as before.

Suite time is capped at 1800 seconds across all attempts, including checkout,
startup, installation, PE quiet waiting and elapsed cleanup. Deadline expiry
fails with 124; bounded teardown can extend wall time beyond that budget.
On PE deferral the active process gets one second to terminate before SIGKILL;
other termination gets up to 60 seconds. The controller removes only exact-name,
matching-label containers, their anonymous volumes and the matching network.
It reclaims scratch ownership with the pinned tools image; a cleanup error
fails the receipt and retains scratch for Root. No global Docker prune is used.
Queue wait is outside the suite bound. A fetch has its own 120-second bound.
`COMMONSWARM_CI_CONFIG` selects an operator-owned config (also used by disposable
fixture tests); `timeout_seconds` may reduce the suite limit but cannot exceed it.

Receipts and logs are private under `/var/lib/commonswarm-ci/runs/csci-<uuid>/`.
`receipt.json` contains requested/resolved SHA, controller SHA/checksums, queued,
started and ended times, tool versions, per-gate statuses, exit/timeout, cleanup
errors, attempt number/prior run IDs, shared suite start/elapsed budget,
pending flag, deferred/completed/failed state, image identities and SHA-256
artifact hashes. Deferred attempts retain exit 75 as history; the final attempt
determines the suite result and links its prior attempts. The queue holder invokes
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
