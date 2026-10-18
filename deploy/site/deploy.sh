#!/bin/bash
# Preparation is local; stage/deploy/rollback require Anvil's existing Mac lock.
set +x; set -euo pipefail; umask 077
SCRIPT=$(cd "$(dirname "$0")" && pwd)
if [[ ${1:-} == prepare && $# == 4 ]]; then
  exec node "$SCRIPT/validate-site-env.mjs" prepare "$2" "$3" "$4"
fi
[[ $# == 4 && $1 =~ ^(stage|deploy|rollback)$ && $2 == ops@100.115.66.74 && $4 =~ ^[0-9a-f]{64}$ ]] || {
  echo 'Usage: deploy.sh prepare <artifact-dir> <reviewed-BUILD-sha256> <new-/root/cswarm-site-ID>' >&2
  echo '       deploy.sh stage|deploy|rollback ops@100.115.66.74 <packet-dir> <reviewed-PACKET-sha256>' >&2; exit 2;
}
MODE=$1; HOST=$2; PACKET=$(cd "$3" && pwd); PIN=$4
# This lock is operator owned: never acquire, replace or remove another holder's lock.
LOCK=/Users/yulanbot/work/BOX-RELEASE.lock
[[ -n ${COMMONSWARM_RELEASE_LOCK_HOLDER:-} && -f $LOCK && ! -L $LOCK ]]
grep -Fx "holder=$COMMONSWARM_RELEASE_LOCK_HOLDER" "$LOCK" >/dev/null
[[ $(shasum -a 256 "$PACKET/PACKET.sha256" | cut -d' ' -f1) == "$PIN" ]]
(cd "$PACKET" && shasum -a 256 -c PACKET.sha256)
RESERVE=$(cat "$PACKET/RESERVE"); [[ $RESERVE =~ ^/root/cswarm-site-[A-Za-z0-9-]+$ ]]
if [[ $MODE == stage ]]; then
  # stdin is an archive of enumerated packet files, never an arbitrary caller directory.
  COPYFILE_DISABLE=1 tar -C "$PACKET" -cf - site.tar BUILD.json SITE-DIRECT.sh RESERVE PACKET.sha256 |
    ssh -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=4 "$HOST" "sudo -n bash -c 'set -eu; umask 077; mkdir $RESERVE; tar --no-same-owner -xf - -C $RESERVE; cd $RESERVE; test \"\$(sha256sum PACKET.sha256 | cut -d\" \" -f1)\" = $PIN; sha256sum -c PACKET.sha256'"
else
  ssh -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=4 "$HOST" "sudo -n bash -c 'set -eu; cd $RESERVE; test \"\$(sha256sum PACKET.sha256 | cut -d\" \" -f1)\" = $PIN; sha256sum -c PACKET.sha256; rc=0; bash SITE-DIRECT.sh $MODE || rc=\$?; tail -n 40 hostrun.log || :; exit \$rc'"
fi
printf 'PASS %s; keep the Mac lock through verification or rollback.\n' "$MODE"
