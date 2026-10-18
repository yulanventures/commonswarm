#!/bin/bash
# Linux build host only. No production execution; output is a reviewable packet input.
set +x; set -euo pipefail; umask 077
[[ $# == 4 ]] || { echo 'Usage: build-artifact.sh <full-reviewed-sha> <public.json> <H0:0|1> <new-output-dir>' >&2; exit 2; }
REV=$1; CONFIG=$(realpath "$2"); H0=$3; OUT=$4
IMAGE=node:22.23.3-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c
[[ $EUID == 0 && $(uname -s) == Linux && $(hostname -s) != yulan-vps-1 && ! -d /srv/commonswarm/site && $REV =~ ^[0-9a-f]{40}$ && $H0 =~ ^[01]$ ]]
SCRIPT=$(cd "$(dirname "$0")" && pwd); REPO=$(cd "$SCRIPT/../.." && pwd)
[[ $(git -C "$REPO" rev-parse "$REV^{commit}") == "$REV" ]]
mkdir "$OUT"; OUT=$(realpath "$OUT"); JOB=$(mktemp -d /var/tmp/cswarm-site-build.XXXXXX)
printf 'Build workspace retained: %s\n' "$JOB"
mkdir "$JOB/source" "$JOB/work"
git -C "$REPO" archive --format=tar "$REV" > "$OUT/source.tar"
[[ $(git get-tar-commit-id < "$OUT/source.tar") == "$REV" ]]
tar -xf "$OUT/source.tar" -C "$JOB/source" --no-same-owner
# Use exactly the reviewed revision's scripts, not dirty caller code.
cmp "$SCRIPT/build-artifact.sh" "$JOB/source/deploy/site/build-artifact.sh"
cmp "$SCRIPT/validate-site-env.mjs" "$JOB/source/deploy/site/validate-site-env.mjs"
[[ ! -e "$JOB/source/site/.env" && ! -e "$JOB/source/site/dist" ]]
node "$SCRIPT/validate-site-env.mjs" config "$CONFIG" "$H0" "$OUT/public.json"
chmod 755 "$JOB"; chmod -R a+rX "$JOB/source"; chmod 644 "$OUT/public.json"; chown 65534:65534 "$JOB/work"
timeout --kill-after=5s 300 docker pull "$IMAGE" > "$OUT/build.log" 2>&1
NAME=cswarm-site-${JOB##*.}
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || :' EXIT
# Workspace and npm cache live on disk. Container /tmp is bounded, never HOME.
timeout --kill-after=5s 900 docker run --rm -i --name "$NAME" --user 65534:65534 --read-only --cpus 2 --memory 3g --memory-swap 3g --pids-limit 256 --cap-drop ALL --security-opt no-new-privileges --tmpfs /tmp:rw,size=268435456,mode=1777 --mount "type=bind,src=$JOB/source,dst=/src,readonly" --mount "type=bind,src=$JOB/work,dst=/work" --mount "type=bind,src=$OUT/public.json,dst=/public.json,readonly" -w /work "$IMAGE" sh -es > "$OUT/site.tar" 2>> "$OUT/build.log" <<'CONTAINER'
cp -R /src/. /work/
node --input-type=commonjs <<'NODE'
const fs=require('fs'), cp=require('child_process');
const config=JSON.parse(fs.readFileSync('/public.json','utf8'));
const env={PATH:process.env.PATH,ASTRO_TELEMETRY_DISABLED:'1',...config};
for(const args of [['ci','--cache','/work/.npm','--no-audit','--no-fund'],['run','build']]) {
 const r=cp.spawnSync('npm',args,{cwd:'/work/site',env,stdio:['ignore',2,2]}); if(r.status!==0)process.exit(1);
}
NODE
tar --format=ustar -C /work/site/dist -cf - . </dev/null
CONTAINER
cp "$JOB/source/deploy/site/finalize-release.sh" "$OUT/finalize-release.sh"
node "$SCRIPT/validate-site-env.mjs" receipt "$OUT" "$REV" "$IMAGE" "$JOB/source"
chmod 444 "$OUT"/site.tar "$OUT"/source.tar "$OUT"/public.json "$OUT"/BUILD.json "$OUT"/finalize-release.sh
printf 'PASS artifact=%s BUILD.sha256=' "$OUT"; sha256sum "$OUT/BUILD.json" | cut -d' ' -f1
