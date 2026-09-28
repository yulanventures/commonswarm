#!/bin/sh
set -eu

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
  protected_target=${3:-}
  delete_description=${4:-release directory}

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
    printf 'Refusing delete of %s: releases root is empty, /, or a symlink: %s\n' "$delete_description" "$delete_root" >&2
    return 64
  }

  resolved_target=$(resolve_delete_path "$delete_target") || {
    printf 'Refusing delete of %s: could not resolve target: %s\n' "$delete_description" "$delete_target" >&2
    return 64
  }
  resolved_root=$(resolve_delete_path "$delete_root") || {
    printf 'Refusing delete of %s: could not resolve releases root: %s\n' "$delete_description" "$delete_root" >&2
    return 64
  }
  [ "$resolved_target" != "/" ] || {
    printf 'Refusing delete of %s: resolved target is /.\n' "$delete_description" >&2
    return 64
  }
  [ "$resolved_root" != "/" ] || {
    printf 'Refusing delete of %s: resolved releases root is /.\n' "$delete_description" >&2
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
    *)
      printf 'Refusing delete of %s outside releases root %s: %s\n' "$delete_description" "$resolved_root" "$resolved_target" >&2
      return 64
      ;;
  esac

  if [ -n "$protected_target" ] && { [ -e "$protected_target" ] || [ -L "$protected_target" ]; }; then
    resolved_protected=$(resolve_delete_path "$protected_target") || {
      printf 'Refusing delete of %s: could not resolve current release.\n' "$delete_description" >&2
      return 64
    }
    [ "$resolved_target" != "$resolved_protected" ] || {
      printf 'Refusing delete of %s: target is the current release: %s\n' "$delete_description" "$resolved_target" >&2
      return 64
    }
  fi

  rm -rf -- "$resolved_target"
}

# END DELETE SAFETY HELPERS

[ "$#" -eq 3 ] || {
  printf 'Usage: finalize-release.sh <temporary-release> <final-release> <site-root>\n' >&2
  exit 2
}

temporary_release=$1
final_release=$2
site_root=$3
releases=$site_root/releases

[ -d "$temporary_release" ] || {
  printf 'Refusing deploy: temporary release is missing.\n' >&2
  exit 1
}
[ ! -e "$final_release" ] || {
  printf 'Refusing deploy: release directory already exists.\n' >&2
  exit 1
}

# Keep assets requested by pages that loaded before the symlink swap. New files
# win when a content-hashed name is already present.
if [ -L "$site_root/current" ]; then
  current_target=$(readlink "$site_root/current")
  case "$current_target" in
    /*) previous_release=$current_target ;;
    *) previous_release=$site_root/$current_target ;;
  esac
  if [ -d "$previous_release/_astro" ]; then
    mkdir -p "$temporary_release/_astro"
    rsync -a --ignore-existing "$previous_release/_astro/" "$temporary_release/_astro/" </dev/null
  fi
fi

# The upload user can have a strict umask. Caddy still needs directory traversal
# and file reads, so normalize the completed release before it becomes current.
find "$temporary_release" -type d -exec chmod 755 {} +
find "$temporary_release" -type f -exec chmod 644 {} +

mv "$temporary_release" "$final_release"
ln -sfn "releases/$(basename "$final_release")" "$site_root/current.next"
if mv --help >/dev/null 2>&1; then
  # GNU mv on the Linux box: rename the symlink itself, never its target.
  mv -Tf "$site_root/current.next" "$site_root/current"
else
  # Test/development fallback for BSD mv, which has no --no-target-directory.
  rm -f -- "$site_root/current"
  mv -f "$site_root/current.next" "$site_root/current"
fi

# Interrupted uploads never become current. Remove their temporary directories
# after one hour. The active temporary release has already moved above, but keep
# the explicit exclusion so a future reorder cannot delete it.
for stale_temp in "$releases"/*.tmp; do
  [ -d "$stale_temp" ] || [ -L "$stale_temp" ] || continue
  if [ -L "$stale_temp" ]; then
    guarded_delete "$stale_temp" "$releases" "$site_root/current" 'stale temporary release' || {
      prune_status=$?
      [ "$prune_status" -ne 64 ] || exit "$prune_status"
      printf 'Warning: could not prune stale temporary release: %s\n' "$stale_temp" >&2
    }
    continue
  fi
  [ "$stale_temp" = "$temporary_release" ] && continue
  stale_marker=$(find "$stale_temp" -prune -type d -mmin +60 -print 2>/dev/null || true)
  [ -n "$stale_marker" ] || continue
  guarded_delete "$stale_temp" "$releases" "$site_root/current" 'stale temporary release' || {
    prune_status=$?
    [ "$prune_status" -ne 64 ] || exit "$prune_status"
    printf 'Warning: could not prune stale temporary release: %s\n' "$stale_temp" >&2
  }
done

# The timestamp at the start of each release name sorts oldest first. Shell glob
# expansion cannot contain colour codes, unlike ls output. Only the releases
# older than the newest five are candidates. Ordinary rm failures are best-effort
# because the live symlink has already changed; a safety refusal still fails.
LC_ALL=C
export LC_ALL
release_count=0
for old_release in "$releases"/20??????T??????Z-????????????-????????????????; do
  [ -d "$old_release" ] || continue
  [ -L "$old_release" ] && continue
  release_count=$((release_count + 1))
done
prune_count=$((release_count - 5))
[ "$prune_count" -gt 0 ] || prune_count=0
for old_release in "$releases"/20??????T??????Z-????????????-????????????????; do
  [ "$prune_count" -gt 0 ] || break
  [ -d "$old_release" ] || [ -L "$old_release" ] || continue
  if [ -L "$old_release" ]; then
    guarded_delete "$old_release" "$releases" "$site_root/current" 'old release' || {
      prune_status=$?
      [ "$prune_status" -ne 64 ] || exit "$prune_status"
      printf 'Warning: could not prune old release: %s\n' "$old_release" >&2
    }
    continue
  fi
  prune_count=$((prune_count - 1))
  [ "$old_release" = "$final_release" ] && continue
  guarded_delete "$old_release" "$releases" "$site_root/current" 'old release' || {
    prune_status=$?
    [ "$prune_status" -ne 64 ] || exit "$prune_status"
    printf 'Warning: could not prune old release: %s\n' "$old_release" >&2
  }
done
