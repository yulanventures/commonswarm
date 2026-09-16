#!/bin/sh
set -eu

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
  [ -d "$stale_temp" ] || continue
  [ -L "$stale_temp" ] && continue
  [ "$stale_temp" = "$temporary_release" ] && continue
  [ -n "$(find "$stale_temp" -prune -type d -mmin +60 -print)" ] || continue
  case "$stale_temp" in
    "$releases"/*) rm -rf -- "$stale_temp" ;;
    *) printf 'Refusing temporary prune outside releases directory: %s\n' "$stale_temp" >&2; exit 1 ;;
  esac
done

# Release names contain no whitespace. Keep the five newest successful releases.
kept=0
for old_release in $(ls -1dt "$releases"/20* 2>/dev/null); do
  case "$old_release" in
    *.tmp) continue ;;
  esac
  kept=$((kept + 1))
  if [ "$kept" -gt 5 ]; then
    case "$old_release" in
      "$releases"/*) rm -rf -- "$old_release" ;;
      *) printf 'Refusing prune outside releases directory: %s\n' "$old_release" >&2; exit 1 ;;
    esac
  fi
done
