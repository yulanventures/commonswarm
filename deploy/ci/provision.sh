#!/bin/bash
# REVIEW ONLY until Root approves this exact SHA and reserves pe-ci-1 capacity.
# No host package upgrades, host PostgreSQL cluster, broad sudo, or PE credentials.
set -euo pipefail
[[ $# = 2 && $1 = --sha && $2 =~ ^[0-9a-f]{40}$ ]] || { echo 'use --sha <reviewed-controller-40hex>' >&2; exit 2; }
reviewed_sha=$2
test "$(uname -s)" = Linux
test "$(uname -m)" = x86_64
test "$(hostname -s)" = pe-ci-1
test "$(id -u)" = 0
test "$(git rev-parse HEAD)" = "$reviewed_sha"
test -z "$(git status --porcelain)"
for tool in docker git python3 curl systemctl pgrep; do command -v "$tool" >/dev/null; done
if pgrep -x Runner.Worker >/dev/null; then echo 'REFUSE: PromptEden job active' >&2; exit 75; fi
id -u gha >/dev/null
test ! -e /opt/commonswarm-ci
test ! -L /opt/commonswarm-ci
test ! -e /var/lib/commonswarm-ci
test ! -L /var/lib/commonswarm-ci
test ! -e /etc/systemd/system/commonswarm-nightly.service
test ! -e /etc/systemd/system/commonswarm-nightly.timer
stage=$(mktemp -d /var/tmp/commonswarm-provision.XXXXXX)
chmod 0700 "$stage"
cleanup() {
  python3 - "$stage" <<'PY'
import pathlib, shutil, sys
p=pathlib.Path(sys.argv[1])
assert p.parent == pathlib.Path('/var/tmp') and p.name.startswith('commonswarm-provision.')
assert not p.is_symlink() and p.resolve() == p and p != pathlib.Path.home()
shutil.rmtree(p)
PY
}
trap cleanup EXIT
cat >"$stage/Dockerfile" <<'DOCKERFILE'
FROM docker:28.0.4-cli AS dockercli
FROM node:22.14.0-bookworm
ARG CI_UID
ARG CI_GID
SHELL ["/bin/bash", "-euo", "pipefail", "-c"]
RUN apt-get update -q && apt-get install -y --no-install-recommends ca-certificates curl git python3 unzip gnupg sudo util-linux procps iproute2 lsb-release && \
    install -d /etc/postgresql-common && echo 'create_main_cluster = false' >/etc/postgresql-common/createcluster.conf && \
    curl --proto '=https' --fail --silent --show-error https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /usr/share/keyrings/pgdg.gpg && \
    echo 'deb [signed-by=/usr/share/keyrings/pgdg.gpg] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main' >/etc/apt/sources.list.d/pgdg.list && \
    apt-get update -q && apt-get install -y --no-install-recommends postgresql-17 postgresql-client-17 && \
    test -z "$(pg_lsclusters --no-header)" && install -d -m 1777 /private/tmp
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=dockercli /usr/local/libexec/docker/cli-plugins /usr/local/libexec/docker/cli-plugins
RUN stage=$(mktemp -d /tmp/ci-tools.XXXXXX) && cd "$stage" && \
    curl --proto '=https' --proto-redir '=https' -fsSL https://github.com/denoland/deno/releases/download/v2.2.3/deno-x86_64-unknown-linux-gnu.zip -o deno.zip && \
    curl --proto '=https' --proto-redir '=https' -fsSL https://github.com/denoland/deno/releases/download/v2.2.3/deno-x86_64-unknown-linux-gnu.zip.sha256sum -o deno.sha256 && \
    digest=$(awk 'NR == 1 {print $1}' deno.sha256) && [[ "$digest" =~ ^[0-9a-f]{64}$ ]] && \
    printf '%s  deno.zip\n' "$digest" | sha256sum --check --status && unzip -q deno.zip && install -m 0755 deno /usr/local/bin/deno && \
    base=https://github.com/supabase/cli/releases/download/v2.118.0 && \
    curl --proto '=https' --proto-redir '=https' -fsSL "$base/supabase_linux_amd64.tar.gz" -o supabase.tar.gz && \
    curl --proto '=https' --proto-redir '=https' -fsSL "$base/supabase_2.118.0_checksums.txt" -o supabase.sha256 && \
    digest=$(awk '$2 == "supabase_linux_amd64.tar.gz" {print $1; count++} END {if(count != 1) exit 1}' supabase.sha256) && \
    [[ "$digest" =~ ^[0-9a-f]{64}$ ]] && printf '%s  supabase.tar.gz\n' "$digest" | sha256sum --check --status && \
    tar -xzf supabase.tar.gz supabase && install -m 0755 supabase /usr/local/bin/supabase && \
    base=https://github.com/caddyserver/caddy/releases/download/v2.11.4 && \
    curl --proto '=https' --proto-redir '=https' -fsSL "$base/caddy_2.11.4_linux_amd64.tar.gz" -o caddy.tar.gz && \
    curl --proto '=https' --proto-redir '=https' -fsSL "$base/caddy_2.11.4_checksums.txt" -o caddy.sha512 && \
    digest=$(awk '$2 == "caddy_2.11.4_linux_amd64.tar.gz" {print $1; count++} END {if(count != 1) exit 1}' caddy.sha512) && \
    test "$digest" = 8220d1f013b6f27510247b2360c9e0ca9f018feebd82515f07635318b34ff9777ccc8fd0b6e6f2486ce3a33fe389fbb7db12d05baa474f4587509fb4f5ebf1c9 && \
    printf '%s  caddy.tar.gz\n' "$digest" | sha512sum --check --status && \
    tar -xzf caddy.tar.gz caddy && test "$(./caddy version)" = 'v2.11.4 h1:XKxkMTgNSizEvKG6QHue6cAsFOteU2qA61w2tKkCWi0=' && install -m 0755 caddy /usr/local/bin/caddy
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npm install --prefix /opt/playwright --ignore-scripts --no-audit --no-fund playwright@1.63.0 && \
    /opt/playwright/node_modules/.bin/playwright install --with-deps chromium-headless-shell && chmod -R a+rX /ms-playwright
# Match the host gha UID for private bind mounts, without granting host sudo.
RUN userdel node && (getent group "$CI_GID" >/dev/null || groupadd -g "$CI_GID" ciworker) && \
    useradd -m -u "$CI_UID" -g "$CI_GID" -s /bin/bash ciworker
DOCKERFILE
docker build --build-arg "CI_UID=$(id -u gha)" --build-arg "CI_GID=$(id -g gha)" --tag commonswarm-ci-tools:"$reviewed_sha" "$stage"
docker pull docker:28.0.4-dind
worker_image=$(docker image inspect --format '{{.Id}}' commonswarm-ci-tools:"$reviewed_sha")
dind_image=$(docker image inspect --format '{{index .RepoDigests 0}}' docker:28.0.4-dind)
install -d -m 0755 /opt/commonswarm-ci /opt/commonswarm-ci/scripts
install -m 0755 scripts/standalone-ci/run.sh scripts/standalone-ci/suite.sh scripts/standalone-ci/retain.py /opt/commonswarm-ci/scripts/
install -d -m 0700 -o gha -g "$(id -gn gha)" /var/lib/commonswarm-ci
python3 - "$reviewed_sha" "$worker_image" "$dind_image" <<'PY'
import json, sys
cfg=dict(controller_sha=sys.argv[1],worker_image=sys.argv[2],dind_image=sys.argv[3],
         state='/var/lib/commonswarm-ci',controller='/opt/commonswarm-ci/scripts',
         source_url='git@github.com:yulanventures/commonswarm.git',
         ssh_config='/opt/commonswarm-ci/ssh_config',allowed_hostname='pe-ci-1',timeout_seconds=1800)
open('/opt/commonswarm-ci/config.json','w').write(json.dumps(cfg,indent=2)+'\n')
PY
chmod 0644 /opt/commonswarm-ci/config.json
install -m 0644 deploy/ci/commonswarm-nightly.service deploy/ci/commonswarm-nightly.timer /etc/systemd/system/
systemctl daemon-reload
# Installation deliberately does not enable/start a job. Root first installs
# the new read-only deploy key and pinned SSH host key, then verifies controls.
echo 'Installed disabled timer and immutable tools. Root must provision repository-only SSH access and verify before enabling.'
