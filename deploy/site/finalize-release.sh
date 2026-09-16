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
  stale_marker=$(find "$stale_temp" -prune -type d -mmin +60 -print 2>/dev/null || true)
  [ -n "$stale_marker" ] || continue
  case "$stale_temp" in
    "$releases"/*)
      if ! rm -rf -- "$stale_temp"; then
        printf 'Warning: could not prune stale temporary release: %s\n' "$stale_temp" >&2
      fi
      ;;
    *) printf 'Warning: refusing temporary prune outside releases directory: %s\n' "$stale_temp" >&2 ;;
  esac
done

# The timestamp at the start of each release name sorts oldest first. Shell glob
# expansion cannot contain colour codes, unlike ls output. Only the releases
# older than the newest five are candidates. Pruning is best-effort because the
# live symlink has already changed and cleanup must not turn a good deploy red.
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
  [ -d "$old_release" ] || continue
  [ -L "$old_release" ] && continue
  prune_count=$((prune_count - 1))
  [ "$old_release" = "$final_release" ] && continue
  case "$old_release" in
    "$releases"/*)
      if ! rm -rf -- "$old_release"; then
        printf 'Warning: could not prune old release: %s\n' "$old_release" >&2
      fi
      ;;
    *) printf 'Warning: refusing release prune outside releases directory: %s\n' "$old_release" >&2 ;;
  esac
done
