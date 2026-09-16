#!/bin/sh
set -eu

usage() {
  printf '%s\n' \
    'Usage: deploy/site/deploy.sh <ssh-host>' \
    '       deploy/site/deploy.sh --dry-run --dist <dist-directory>' >&2
  exit 2
}

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/../.." && pwd)

validate_dist() {
  dist_dir=$1
  start_page=$dist_dir/start/index.html
  if [ ! -f "$start_page" ]; then
    printf 'Refusing deploy: built /start page is missing.\n' >&2
    return 1
  fi
  if ! grep -Eq 'name="commonswarm:url" content="[^"[:space:]]+"' "$start_page"; then
    printf 'Refusing deploy: built /start commonswarm:url meta value is empty.\n' >&2
    return 1
  fi
}

if [ "${1:-}" = "--dry-run" ]; then
  [ "${2:-}" = "--dist" ] || usage
  [ "$#" -eq 3 ] || usage
  validate_dist "$3"
  printf 'Dry run passed: the built /start backend URL is present.\n'
  exit 0
fi

[ "$#" -eq 1 ] || usage
box=$1
case "$box" in
  *[!A-Za-z0-9._@:-]*)
    printf 'Refusing deploy: ssh host contains unsupported characters.\n' >&2
    exit 2
    ;;
esac

env_file=$repo_root/site/.env
if [ ! -f "$env_file" ]; then
  printf 'Refusing deploy: site/.env is missing.\n' >&2
  exit 1
fi
for variable in PUBLIC_SUPABASE_URL PUBLIC_SUPABASE_ANON_KEY; do
  if ! grep -Eq "^${variable}=.+$" "$env_file"; then
    printf 'Refusing deploy: site/.env lacks a non-empty %s value.\n' "$variable" >&2
    exit 1
  fi
done

temp_root=$(mktemp -d "${TMPDIR:-/tmp}/commonswarm-site-deploy.XXXXXX")
cleanup() {
  rm -rf -- "$temp_root"
}
trap cleanup EXIT HUP INT TERM

checkout=$temp_root/checkout
mkdir -p "$checkout"
git -C "$repo_root" archive --format=tar HEAD | tar -xf - -C "$checkout"
cp "$env_file" "$checkout/site/.env"

# Astro does not remove stale output. Keep this even though the archive starts clean.
rm -rf -- "$checkout/site/dist"
npm --prefix "$checkout/site" ci
npm --prefix "$checkout/site" run build
validate_dist "$checkout/site/dist"

release="$(date -u +%Y%m%dT%H%M%SZ)-$(git -C "$repo_root" rev-parse --short=12 HEAD)"
remote_root=/srv/commonswarm/site
remote_temp=$remote_root/releases/$release.tmp
remote_release=$remote_root/releases/$release

ssh "$box" "mkdir -p '$remote_temp'" </dev/null
rsync -a --delete "$checkout/site/dist/" "$box:$remote_temp/" </dev/null
ssh "$box" "set -eu; mv '$remote_temp' '$remote_release'; ln -sfn 'releases/$release' '$remote_root/current.next'; mv -Tf '$remote_root/current.next' '$remote_root/current'" </dev/null

printf 'Deployed release %s to %s. Previous releases were kept for rollback.\n' "$release" "$box"
