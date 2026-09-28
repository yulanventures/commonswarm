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

# Keep this compatible with the macOS /bin/sh used by the release operator.
# realpath is not present on every supported macOS version, and BSD readlink
# has no -f, so resolve an existing directory with cd -P as the final fallback.
resolve_delete_path() {
  path_to_resolve=${1:-}
  [ -n "$path_to_resolve" ] || return 1

  if command -v realpath >/dev/null 2>&1; then
    resolved_path=$(realpath "$path_to_resolve" 2>/dev/null) && {
      printf '%s\n' "$resolved_path"
      return 0
    }
  fi
  if command -v readlink >/dev/null 2>&1; then
    resolved_path=$(readlink -f "$path_to_resolve" 2>/dev/null) && [ -n "$resolved_path" ] && {
      printf '%s\n' "$resolved_path"
      return 0
    }
  fi
  if [ -d "$path_to_resolve" ]; then
    (CDPATH= cd -P -- "$path_to_resolve" 2>/dev/null && pwd -P)
    return
  fi

  path_parent=$(dirname -- "$path_to_resolve")
  path_name=$(basename -- "$path_to_resolve")
  [ "$path_name" != "." ] && [ "$path_name" != ".." ] || return 1
  resolved_parent=$(CDPATH= cd -P -- "$path_parent" 2>/dev/null && pwd -P) || return 1
  printf '%s/%s\n' "${resolved_parent%/}" "$path_name"
}

guarded_delete() {
  delete_target=${1:-}
  delete_root=${2:-}
  root_mode=${3:-child}
  delete_description=${4:-directory}

  [ -n "$delete_target" ] || {
    printf 'Refusing delete of %s: target is empty.\n' "$delete_description" >&2
    return 64
  }
  [ "$delete_target" != "/" ] || {
    printf 'Refusing delete of %s: target is /.\n' "$delete_description" >&2
    return 64
  }
  [ ! -L "$delete_target" ] || {
    printf 'Refusing delete of %s: target is a symlink: %s\n' "$delete_description" "$delete_target" >&2
    return 64
  }
  [ -n "$delete_root" ] && [ "$delete_root" != "/" ] && [ ! -L "$delete_root" ] || {
    printf 'Refusing delete of %s: allowed root is empty, /, or a symlink: %s\n' "$delete_description" "$delete_root" >&2
    return 64
  }

  resolved_target=$(resolve_delete_path "$delete_target") || {
    printf 'Refusing delete of %s: could not resolve target: %s\n' "$delete_description" "$delete_target" >&2
    return 64
  }
  resolved_root=$(resolve_delete_path "$delete_root") || {
    printf 'Refusing delete of %s: could not resolve allowed root: %s\n' "$delete_description" "$delete_root" >&2
    return 64
  }
  [ "$resolved_target" != "/" ] || {
    printf 'Refusing delete of %s: resolved target is /.\n' "$delete_description" >&2
    return 64
  }
  [ "$resolved_root" != "/" ] || {
    printf 'Refusing delete of %s: resolved allowed root is /.\n' "$delete_description" >&2
    return 64
  }

  [ -n "${HOME:-}" ] || {
    printf 'Refusing delete of %s: HOME is empty.\n' "$delete_description" >&2
    return 64
  }
  resolved_home=$(resolve_delete_path "$HOME") || {
    printf 'Refusing delete of %s: could not resolve HOME.\n' "$delete_description" >&2
    return 64
  }
  case "$resolved_home" in
    "$resolved_target"|"$resolved_target"/*)
      printf 'Refusing delete of %s: target equals or contains HOME: %s\n' "$delete_description" "$resolved_target" >&2
      return 64
      ;;
  esac

  case "$resolved_target" in
    "$resolved_root"/*) ;;
    "$resolved_root")
      [ "$root_mode" = "root" ] || {
        printf 'Refusing delete of %s: target is the allowed root: %s\n' "$delete_description" "$resolved_target" >&2
        return 64
      }
      ;;
    *)
      printf 'Refusing delete of %s outside allowed root %s: %s\n' "$delete_description" "$resolved_root" "$resolved_target" >&2
      return 64
      ;;
  esac

  rm -rf -- "$resolved_target"
}

# END DELETE SAFETY HELPERS

validate_temp_root() {
  temp_candidate=${1:-}
  temp_parent=${2:-}
  [ -n "$temp_candidate" ] || {
    printf 'Refusing deploy: mktemp returned an empty path.\n' >&2
    return 1
  }
  [ ! -L "$temp_candidate" ] || {
    printf 'Refusing deploy: temporary root is a symlink: %s\n' "$temp_candidate" >&2
    return 1
  }
  [ -d "$temp_candidate" ] || {
    printf 'Refusing deploy: mktemp did not create a directory: %s\n' "$temp_candidate" >&2
    return 1
  }

  resolved_candidate=$(resolve_delete_path "$temp_candidate") || {
    printf 'Refusing deploy: could not resolve temporary root: %s\n' "$temp_candidate" >&2
    return 1
  }
  resolved_temp_parent=$(resolve_delete_path "$temp_parent") || {
    printf 'Refusing deploy: could not resolve temporary parent: %s\n' "$temp_parent" >&2
    return 1
  }
  candidate_parent=$(dirname -- "$resolved_candidate")
  candidate_name=$(basename -- "$resolved_candidate")
  [ "$candidate_parent" = "$resolved_temp_parent" ] || {
    printf 'Refusing deploy: temporary root is outside its mktemp parent: %s\n' "$resolved_candidate" >&2
    return 1
  }
  case "$candidate_name" in
    commonswarm-site-deploy.??????) ;;
    *)
      printf 'Refusing deploy: temporary root does not match the mktemp template: %s\n' "$resolved_candidate" >&2
      return 1
      ;;
  esac

  resolved_home=$(resolve_delete_path "${HOME:-}") || {
    printf 'Refusing deploy: could not resolve HOME.\n' >&2
    return 1
  }
  case "$resolved_home" in
    "$resolved_candidate"|"$resolved_candidate"/*)
      printf 'Refusing deploy: temporary root equals or contains HOME: %s\n' "$resolved_candidate" >&2
      return 1
      ;;
  esac

  printf '%s\n' "$resolved_candidate"
}

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

temp_parent=${TMPDIR:-/tmp}
created_temp_root=$(mktemp -d "$temp_parent/commonswarm-site-deploy.XXXXXX")
temp_root=$(validate_temp_root "$created_temp_root" "$temp_parent") || exit 1
cleanup() {
  deploy_status=$?
  trap - EXIT HUP INT TERM
  guarded_delete "$temp_root" "$temp_root" root 'temporary deploy root' || {
    cleanup_status=$?
    [ "$deploy_status" -ne 0 ] || deploy_status=$cleanup_status
  }
  exit "$deploy_status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

checkout=$temp_root/checkout
mkdir -p "$checkout"
git -C "$repo_root" archive --format=tar HEAD | tar -xf - -C "$checkout"
# Let Astro read the operator's existing 0600 file. Do not make another secret-bearing file.
ln -s "$env_file" "$checkout/site/.env"

# Astro does not remove stale output. Keep this even though the archive starts clean.
guarded_delete "$checkout/site/dist" "$temp_root" child 'stale site build output'
run_site_npm "$checkout/site" ci
run_site_npm "$checkout/site" run build
validate_dist "$checkout/site/dist"

release=$(release_name)
remote_root=/srv/commonswarm/site
remote_temp=$remote_root/releases/$release.tmp
remote_release=$remote_root/releases/$release

ssh "$box" "set -eu; mkdir -p '$remote_root/releases'; test ! -e '$remote_temp'; test ! -e '$remote_release'; mkdir '$remote_temp'" </dev/null
# No --chmod: macOS ships openrsync, which rejects it (measured on the operator mini, 2026-09-16).
# finalize-release.sh normalizes every directory to 755 and file to 644 on the box before the swap.
rsync -a --delete "$checkout/site/dist/" "$box:$remote_temp/" </dev/null
ssh "$box" sh -s -- "$remote_temp" "$remote_release" "$remote_root" < "$script_dir/finalize-release.sh"

printf 'Deployed release %s to %s. The five newest releases were kept for rollback.\n' "$release" "$box"
