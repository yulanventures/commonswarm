# CommonSwarm box-facts measurement

Read-only measurement from yulan-vps-1 for source commit `dc407f4ec96ad248ee138389d7144f18466016ff`.
No box state was changed, no write-method request was sent, no Docker run/exec was used, and no secret or environment value was printed.

The brief says 14 facts, but the exact fixture contains 15, including `site-release`; this evidence preserves all 15 as M1-M15.

| ID | Source fact | Result | Note |
|---|---|---|---|
| M1 | `deno-runtime` | DIFFERS | /usr/local/bin/deno does not exist, so the required regular root-owned 0755 Deno 2 executable is absent. |
| M2 | `deno-window-cache` | NOT MEASURED | The controls directory is absent, so no per-window cache exists to copy into the guarded /tmp scratch directory; the required offline cached-only check was therefore impossible and no scratch directory was created. |
| M3 | `host-accounts` | AGREES | All four users and same-named groups exist, and non-interactive sudo to commonswarm succeeded. |
| M4 | `command-runtimes` | AGREES | Bash 5.2, Python 3.12, Docker 29.8.1, Compose 5.5.1, curl, GNU coreutils/findutils/grep/sed/awk/tar are installed. |
| M5 | `release-layout` | DIFFERS | Current edge and stack point to 72c57e0d and ad964ed1 and both candidate release trees exist, but the active eb2a87ac proof directory and window.env are absent; two closed-window proof directories exist. |
| M6 | `edge-environment` | DIFFERS | All exact-SHA required-name/nonempty checks, forbidden-hook checks, SWARM_SELF_SERVE=1 check, regular-file check and 0600 check passed internally. Exit 61 is the command's explicit code for owner uid not root; output contains names only. |
| M7 | `oauth-protected-inputs` | DIFFERS | Protected files exist with metadata only reported, but service.env does not contain MCP_OAUTH_DATABASE_HOST, which the plan indexes directly. Credential-file content was not opened, per the measurement rule. |
| M8 | `migration-target` | DIFFERS | target.env and the helper exist and TARGET_DATABASE_URL is named, but postgres:17.6-bookworm is not present. Database reachability was not attempted because no docker run/exec was permitted. |
| M9 | `backup-state` | DIFFERS | The service is loaded/inactive with Result=success and the destination prefix matches, but status.json lacks the assumed state key. |
| M10 | `maintenance-timers` | AGREES | The edge recycle, PostgreSQL backup and PostgreSQL restore timers are loaded, enabled and active. |
| M11 | `edge-container` | AGREES | The edge container is healthy with 2 GiB memory, commonswarm-net, loopback 127.0.0.1:9000, and all workdir/mount paths under edge 72c57e0d. |
| M12 | `edge-loopback` | NOT MEASURED | Loopback listen, health GET, H0 GET status and DARK MCP GET status were measured, but the source command's POST was refused because it uses a write method; the required POST refusal/body shape was not measured. |
| M13 | `public-routing` | AGREES | Header-only GETs returned 200 with the expected JSON/HTML media types; API, edge-staging and site used commonswarm-release-probe/1.0, while MCP used Python urllib's default User-Agent. |
| M14 | `proof-copyback` | DIFFERS | The active proof path is closed into two exact-name window directories. The first manifest includes edge-probe-start.txt at mode 0644, contradicting the assumed root:root:0600 policy for every required output. |
| M15 | `site-release` | DIFFERS | The live site release is 20260927T173937Z-9b085c823523-7b9cc15f8a9b7f1e, not the expected HM8 8b8989f2b29e identity; the connected-apps marker is absent. App/download and five referenced assets are readable and the 0.1.80 marker is present. |

Full exact commands, UTC timestamps, exit statuses, sanitized raw output, and every before/after command review are in `box-facts-measured.json`.

Production recheck: edge `72c57e0d` healthy; stack `ad964ed1`; OAuth `826db6a3` healthy; edge-recycle, backup and restore timers active.

BOX_FACTS=13/15
