#!/bin/sh
set -eu

usage() {
  printf '%s\n' \
    'Usage: deploy/site/deploy.sh <ssh-host>' \
    '       deploy/site/deploy.sh --dry-run --dist <dist-directory>' \
    '       deploy/site/deploy.sh --dry-run --npm-ci <site-directory>' \
    '       deploy/site/deploy.sh --dry-run --release-name' >&2
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

run_site_npm() {
  site_dir=$1
  shift
  (cd "$site_dir" && npm "$@" </dev/null)
}

release_name() {
  release_random=$(LC_ALL=C od -An -N8 -tx1 /dev/urandom | tr -d ' \n')
  [ "${#release_random}" -eq 16 ] || {
    printf 'Refusing deploy: could not create a unique release suffix.\n' >&2
    return 1
  }
  printf '%s-%s-%s\n' \
    "$(date -u +%Y%m%dT%H%M%SZ)" \
    "$(git -C "$repo_root" rev-parse --short=12 HEAD)" \
    "$release_random"
}

if [ "${1:-}" = "--dry-run" ]; then
  case "${2:-}" in
    --dist)
      [ "$#" -eq 3 ] || usage
      validate_dist "$3"
      printf 'Dry run passed: the built /start backend URL is present.\n'
      exit 0
      ;;
    --npm-ci)
      [ "$#" -eq 3 ] || usage
      run_site_npm "$3" ci
      exit 0
      ;;
    --release-name)
      [ "$#" -eq 2 ] || usage
      release_name
      exit 0
      ;;
    *) usage ;;
  esac
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
node "$script_dir/validate-site-env.mjs" "$env_file" </dev/null

temp_root=$(mktemp -d "${TMPDIR:-/tmp}/commonswarm-site-deploy.XXXXXX")
cleanup() {
  rm -rf -- "$temp_root"
}
trap cleanup EXIT HUP INT TERM

checkout=$temp_root/checkout
mkdir -p "$checkout"
git -C "$repo_root" archive --format=tar HEAD | tar -xf - -C "$checkout"
# Let Astro read the operator's existing 0600 file. Do not make another secret-bearing file.
ln -s "$env_file" "$checkout/site/.env"

# Astro does not remove stale output. Keep this even though the archive starts clean.
rm -rf -- "$checkout/site/dist"
run_site_npm "$checkout/site" ci
run_site_npm "$checkout/site" run build
validate_dist "$checkout/site/dist"

release=$(release_name)
remote_root=/srv/commonswarm/site
remote_temp=$remote_root/releases/$release.tmp
remote_release=$remote_root/releases/$release

ssh "$box" "set -eu; mkdir -p '$remote_root/releases'; test ! -e '$remote_temp'; test ! -e '$remote_release'; mkdir '$remote_temp'" </dev/null
rsync -a --delete --chmod=D755,F644 "$checkout/site/dist/" "$box:$remote_temp/" </dev/null
ssh "$box" sh -s -- "$remote_temp" "$remote_release" "$remote_root" < "$script_dir/finalize-release.sh"

printf 'Deployed release %s to %s. The five newest releases were kept for rollback.\n' "$release" "$box"
