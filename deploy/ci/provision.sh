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
cd "$(git rev-parse --show-toplevel)"
test "$(git rev-parse HEAD)" = "$reviewed_sha"
test -z "$(git status --porcelain)"
for tool in docker git python3 curl systemctl pgrep timeout useradd groupadd; do command -v "$tool" >/dev/null; done
if pgrep -x Runner.Worker >/dev/null; then echo 'REFUSE: PromptEden job active' >&2; exit 75; fi
# Refuse hidden cross-user processes; an idle probe alone proves nothing.
pgrep -u root -x systemd >/dev/null
if getent passwd commonswarm-ci >/dev/null || getent group commonswarm-ci >/dev/null; then
  echo 'REFUSE: dedicated service account/group already exists' >&2; exit 1
fi
export DOCKER_CONTEXT=default DOCKER_HOST=unix:///var/run/docker.sock
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
unset GIT_CONFIG_COUNT GIT_CONFIG_PARAMETERS DOCKER_AUTH_CONFIG DOCKER_TLS_VERIFY DOCKER_CERT_PATH
test ! -e /opt/commonswarm-ci
test ! -L /opt/commonswarm-ci
test ! -e /var/lib/commonswarm-ci
test ! -L /var/lib/commonswarm-ci
test ! -e /etc/systemd/system/commonswarm-nightly.service
test ! -e /etc/systemd/system/commonswarm-nightly.timer
test ! -L /etc/systemd/system/commonswarm-nightly.service
test ! -L /etc/systemd/system/commonswarm-nightly.timer
stage=$(mktemp -d /var/tmp/commonswarm-provision.XXXXXX)
chmod 0700 "$stage"
# Record only successful exclusive creations. A failed install never deletes
# pre-existing state or receipts; this installer supports fresh installs only.
created=()
created_user=0
created_group=0
cleanup() {
  result=$?
  set +e
  trap - EXIT
  if (( result != 0 )); then
    for ((i=${#created[@]}-1; i>=0; i--)); do
      python3 - "${created[i]}" <<'PYREMOVE'
from pathlib import Path
import shutil, sys
p=Path(sys.argv[1])
allowed={Path('/opt/commonswarm-ci'), Path('/var/lib/commonswarm-ci'),
         Path('/etc/systemd/system/commonswarm-nightly.service'),
         Path('/etc/systemd/system/commonswarm-nightly.timer')}
assert p in allowed and not p.is_symlink() and p.resolve() == p
if p.is_dir(): shutil.rmtree(p)
elif p.exists(): p.unlink()
PYREMOVE
      if (( $? != 0 )); then echo "cleanup failed: ${created[i]}" >&2; fi
    done
    if (( created_user != 0 )); then
      userdel commonswarm-ci || echo 'cleanup failed: userdel commonswarm-ci' >&2
    fi
    if (( created_group != 0 )) && getent group commonswarm-ci >/dev/null; then
      groupdel commonswarm-ci || echo 'cleanup failed: groupdel commonswarm-ci' >&2
    fi
    systemctl daemon-reload || echo 'cleanup failed: systemctl daemon-reload' >&2
  fi
  python3 - "$stage" <<'PYSTAGE'
import pathlib, shutil, sys
p=pathlib.Path(sys.argv[1])
assert p.parent == pathlib.Path('/var/tmp') and p.name.startswith('commonswarm-provision.')
assert not p.is_symlink() and p.resolve() == p and p != pathlib.Path.home()
shutil.rmtree(p)
PYSTAGE
  if (( $? != 0 )); then
    echo "cleanup failed: staging directory $stage" >&2
    (( result != 0 )) || result=1
  fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# Keep Docker's host context and credentials separate from every runner account.
mkdir -m 0700 "$stage/docker-config"
export DOCKER_CONFIG="$stage/docker-config"
groupadd commonswarm-ci
created_group=1
useradd --no-create-home --home-dir /var/lib/commonswarm-ci/home --gid commonswarm-ci --shell /usr/sbin/nologin commonswarm-ci
created_user=1
test "$(id -gn commonswarm-ci)" = commonswarm-ci
cat >"$stage/Dockerfile" <<'DOCKERFILE'
FROM docker:28.0.4-cli AS dockercli
FROM node:22.23.3-bookworm
ARG CI_UID
ARG CI_GID
SHELL ["/bin/bash", "-euo", "pipefail", "-c"]
RUN apt-get update -q && apt-get install -y --no-install-recommends ca-certificates curl git python3 unzip gnupg sudo util-linux procps iproute2 lsb-release lsof jq && \
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
    curl --proto '=https' --proto-redir '=https' -fsSL "$base/checksums.txt" -o supabase.sha256 && \
    digest=$(awk '$2 == "supabase_2.118.0_linux_amd64.tar.gz" {print $1; count++} END {if(count != 1) exit 1}' supabase.sha256) && \
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
# Match the dedicated host service UID for private bind mounts, without granting host sudo.
RUN userdel node && (getent group "$CI_GID" >/dev/null || groupadd -g "$CI_GID" ciworker) && \
    useradd -m -u "$CI_UID" -g "$CI_GID" -s /bin/bash ciworker
DOCKERFILE
docker build --build-arg "CI_UID=$(id -u commonswarm-ci)" --build-arg "CI_GID=$(id -g commonswarm-ci)" --tag commonswarm-ci-tools:"$reviewed_sha" "$stage"
docker pull docker:28.0.4-dind
worker_image=$(timeout 20 docker image inspect --format '{{.Id}}' commonswarm-ci-tools:"$reviewed_sha")
dind_image=$(timeout 20 docker image inspect --format '{{index .RepoDigests 0}}' docker:28.0.4-dind)
mkdir -m 0755 /opt/commonswarm-ci
created+=(/opt/commonswarm-ci)
install -d -m 0755 /opt/commonswarm-ci/scripts
install -m 0755 scripts/standalone-ci/run.sh scripts/standalone-ci/suite.sh scripts/standalone-ci/retain.py /opt/commonswarm-ci/scripts/
mkdir -m 0700 /var/lib/commonswarm-ci
created+=(/var/lib/commonswarm-ci)
chown commonswarm-ci:commonswarm-ci /var/lib/commonswarm-ci
install -d -m 0700 -o commonswarm-ci -g commonswarm-ci /var/lib/commonswarm-ci/home
python3 - "$reviewed_sha" "$worker_image" "$dind_image" <<'PY'
import hashlib, json, pwd, sys
from pathlib import Path
account=pwd.getpwnam("commonswarm-ci")
cfg=dict(controller_sha=sys.argv[1],worker_image=sys.argv[2],dind_image=sys.argv[3],
         state='/var/lib/commonswarm-ci',controller='/opt/commonswarm-ci/scripts',
         source_url='https://github.com/yulanventures/commonswarm.git',
         allowed_hostname='pe-ci-1',timeout_seconds=1800,
         service_uid=account.pw_uid,service_gid=account.pw_gid,
         controller_checksums={p.name:hashlib.sha256(p.read_bytes()).hexdigest()
                               for p in Path('/opt/commonswarm-ci/scripts').iterdir() if p.is_file()})
open('/opt/commonswarm-ci/config.json','w').write(json.dumps(cfg,indent=2)+'\n')
PY
chmod 0644 /opt/commonswarm-ci/config.json
for unit in commonswarm-nightly.service commonswarm-nightly.timer; do
  # noclobber is exclusive: a concurrently created unit is never ours to remove.
  (set -o noclobber; : >"/etc/systemd/system/$unit")
  created+=("/etc/systemd/system/$unit")
  install -m 0644 "deploy/ci/$unit" "/etc/systemd/system/$unit"
done
systemctl daemon-reload
# Installation deliberately does not enable/start a job. Public HTTPS source
# requires no key or host Git changes. Root first verifies controls.
echo 'Installed disabled timer and runtime-pinned tools. Root must verify before enabling.'
