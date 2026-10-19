# CommonSwarm standalone CI on pe-ci-1

This is a reviewed installation input, **not a completed migration**. Root owns
contention coordination, provisioning, timer activation and cutover.
Nothing here deploys to Yulan VPS or dispatches GitHub Actions.

The controller is installed from one reviewed commit. The service resolves `main`
once under `/var/lib/commonswarm-ci/queue.lock` using `flock(2)` (queue wait
capped at 600 seconds), then runs box-dry-run,
server, p1-cli, site and unit serially at that exact SHA. Manual invocations
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
each worker has 4 GiB. These are unmeasured limits, not a memory-fit claim: Root
must measure the full nested stack and PE overlap before timer activation.
DinD listens only on namespace loopback and defaults nested published ports to
127.0.0.1. No outer host ports are published. Root must inspect actual nested
port bindings during the real run, including fixtures with explicit bindings. Fixed Supabase ports are
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
   It builds isolated Node 22.23.3, Deno 2.2.3, Supabase 2.118.0, Caddy 2.11.4,
   Playwright 1.63.0 and PG17 tools. Debian Python 3.11.2 remains the default
   `python3`, with apt jsonschema 4.10.3. Archive tests can select the separate
   `python3.12` runtime from the digest-pinned official `3.12-slim-bookworm`
   stage; admission checks actual `tarfile.data_filter` availability. Only its
   versioned binary, shared library and standard library are copied; no default
   Python or pip aliases change. PG17 has no default cluster. Downloads use
   publisher checksums; Caddy also checks the independently pinned SHA-512 and
   exact binary version. Resulting worker ID and DinD digest are pinned in config.
   Docker build cache contains only public tools; private source stays mode 0700.
   Private permissions do not isolate state from root or Docker administrators,
   who can bind-mount host paths. PE's service user is `gha`; its group metadata
   remains pending Root verification. No PE privileges or groups are changed.
   It creates a dedicated `commonswarm-ci:commonswarm-ci` account, checks that
   primary group, and builds `ciworker` with its actual UID/GID for writable
   private mounts. It leaves PE's `gha` account, home and fleet untouched.
   State/source/run directories are mode 0700 at `/var/lib/commonswarm-ci`;
   the account home is its private `home/` child. Receipt files are mode 0600.
   Scripts/config are root-owned under `/opt`.
   Script hashes and service UID/GID are recorded in config and checked before
   source or Docker work. Root fixtures receive only the real mount owner's
   `SUDO_UID` for Git ownership checks; no host safe.directory setting changes.
   The service/timer remain **disabled**, with no host sudo grant.
   Fresh installs only: existing state/accounts/units are refused. On failure,
   rollback removes only exclusively created paths and this invocation's new
   account/group, then reloads systemd. It never removes existing receipts.
   Public Docker build cache/images can remain after installation failure.
   Images are pinned after build; floating base tags/APT inputs mean rebuilds
   are not bit reproducible. Versioned upgrades require a separate reviewed step.
2. Source is the public repository at exactly
   `https://github.com/yulanventures/commonswarm.git`. No deploy key or SSH policy
   is required. The controller rejects other URLs, clears inherited Git/provider
   environment, ignores global/system Git configuration, disables credential
   helpers and extra HTTP headers for fetch, and disables interactive prompts.
   It replaces bare-repository local config before fetching full main history,
   origin/main and tags, then any requested exact SHA. The resolved SHA remains
   fixed across all suites and deferred attempts. Outer Docker always uses the
   default context, host Unix socket and a dedicated credential-free config.
   A visible root-owned systemd process is required as the PE-probe control.
   No host Git configuration changes are needed; PE credentials are not reused.
3. Run `node --test tests/standalone-ci-guard.test.mjs` on the Linux CI host in a
   quiet window. Then run the exact-SHA `--suite all` command as the dedicated
   account, after Root verifies host `runuser` supports `-g`/`-G`:
   `runuser -u commonswarm-ci -g commonswarm-ci -G docker -- bash /opt/commonswarm-ci/scripts/run.sh
   --sha <40-lowercase-hex> --suite all` (one shell line). H0 fixture runuser
   examples must use `commonswarm-ci`, never the PE runner account.
   Root must merge #86 before current-main acceptance: the root box suite runs
   `node --import tsx --test tests/p1-cli/site-artifact.test.ts`, including
   Linux/root rendered-swap cases whenever the file exists. Older exact-SHA
   sources without it record `site-artifact-not-applicable-at-source=77`,
   separately from a test pass. Missing it on `--ref main` fails the source gate.
   This PR does not copy or edit that test.
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
Queue wait is outside the suite bound but capped at 600 seconds. Each of at
most two source fetches has a 120-second bound. Every cleanup Docker call has
a 20-second inspection or 60-second mutation bound; each retention invocation
is capped at 60 seconds. The service has a finite 14400-second startup limit
(queue, fetches, five 1800-second suites and teardown allowance); stop allows
900 seconds, exceeding the bounded cleanup path. A persistent stop latch
terminates active work and prevents new suites/attempts, including signals
during queue wait, cleanup or retention. `KillMode=mixed` sends initial SIGTERM
only to the controller, allowing owned cleanup and retention to finish before the
cgroup kill deadline. A signal-killed Docker inspect is a cleanup error and retains
scratch for Root; it cannot silently fall back to a successful Docker info probe.
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
dispatch block if already cut over. Preserve source, artifacts, receipts and
caches for review. Never delete existing receipts to reinstall; future upgrades need a
separate reviewed migration step. Do not prune host Docker objects or touch
any PE service/runner.

## Host-side GitHub commit statuses

The installed controller calls `publish-status.py` after the final attempt's
cleanup, scratch retention and any quiet-wait deadline decision. It posts only to
`POST /repos/yulanventures/commonswarm/statuses/<resolved_sha>` on api.github.com,
with context `hetzner/<suite>`. Both exact-SHA proof runs and `--ref main`
nightlies use the resolved tested snapshot, even if main advances later.
Deferred attempts publish nothing. Exit 0 publishes success; other exits publish
failure, except timeout, cancellation and cleanup errors publish error.
Descriptions contain only the run ID and exit code. No raw logs or response bodies
are published or printed. This uses the commit-status permission only; it does
not call workflow, check-run, PR or comment APIs.

Root must configure `github_status_token_file` in the root-owned
`/opt/commonswarm-ci/config.json`, pointing to the **existing** CI-host GitHub
credential. This change does not establish that credential's path or scope;
Root must verify existing access to CommonSwarm commit statuses without minting
a token or expanding its permissions. The publisher requires a canonical absolute
regular file, mode 0600, owned by root or the service account and readable by the
calling host account. Its path must be outside both configured `state` and
`controller` trees, including all checkout, receipt and scratch mounts. The token
is read only by the host publisher and never passed through argv, environment,
logs or container mounts. The HTTP host is fixed; redirects are refused.

Publication failure leaves the suite exit/result intact. The controller prints
`"github_status": "failed"` in its JSON summary and stores a sanitized outcome in both
`receipt.json` and `/var/lib/commonswarm-ci/statuses/<run_id>.json`. The latter is
outside all container mounts and is retained for operator reconciliation; the
14-day run retention does not delete it. An unset token path also produces this
explicit failure. Publication has a 30-second host process bound per final suite.

For an existing installation, Root must install the reviewed four controller
files (`run.sh`, `suite.sh`, `retain.py`, `publish-status.py`) together and update
`controller_sha` plus all four `controller_checksums` in config. Do not rerun
fresh-install-only provisioning over existing state. Verify the exact installed
hashes and token file metadata, then inspect a completed proof/nightly status and
its publication record. This Maker change has not installed or backfilled them.

An operator can backfill an audited **final** receipt with:

```sh
python3 -I /opt/commonswarm-ci/scripts/publish-status.py --config /opt/commonswarm-ci/config.json --receipt /var/lib/commonswarm-ci/runs/<run_id>/receipt.json
```

It accepts no SHA override and refuses deferred/inconsistent receipts. Capture its
sanitized JSON result and read back the GitHub status; manual invocation does not
rewrite historical receipts or controller publication records. Publish oldest
receipts before newer results for the same SHA/context. Never substitute a merge
SHA for the resolved SHA in a receipt.

Read-only metadata inventory on 2026-10-19 enumerated 37 receipts and selected the
following six for Root's backfill. The first five share resolved SHA
`e154f5143c3bf97b705ca0614e1877c19f960179`; their requested ref was `main`.

| Run ID | Suite | Exit | Status |
| --- | --- | --- | --- |
| csci-2bcf14681e054e21b6706774db5a609a | box-dry-run | 0 | success |
| csci-0973a9b8bf7f4559bcbde822aaf23f95 | server | 0 | success |
| csci-6707cacfa0064ebbae06842f6800f37b | p1-cli | 1 | failure |
| csci-163e0902286d4e40a6fff68a83d91824 | site | 0 | success |
| csci-94eed54bd36b4f6fbaf796d9c337caf2 | unit | 0 | success |
| csci-e6717ca3385d4f27a47cc52771525922 | p1-cli | 0 | success |

The final row requested and resolved
`1f5d731a986b56642fb527860af69866959d4465`, **not** the later merge SHA. All six
receipts were terminal with `pending=false`, without timeout or cleanup errors.
Gate counts in table order were 4, 12, 3, 4, 4 and 3; only the nightly
`p1-cli` gate had a nonzero exit. Their public GitHub
statuses have not been measured or changed by this Maker.
