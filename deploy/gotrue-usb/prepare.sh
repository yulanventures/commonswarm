#!/usr/bin/env bash
set -euo pipefail
# Create a fresh build context with the same Dockerfile and migrations as the pinned release.
dest=${1:?supply a new output directory}
here=$(cd "$(dirname "$0")" && pwd)
upstream=4eee58f296d9698a1c2c0ae14d7a0b379c7622d3
mkdir "$dest"
git -C "$dest" init --quiet
git -C "$dest" fetch --quiet --depth=1 https://github.com/supabase/auth.git "$upstream"
git -C "$dest" checkout --quiet --detach "$upstream"
git -C "$dest" apply "$here/integration.patch"
cp "$here"/ios_usb{,_test}.go "$dest/internal/api/"
cp "$here"/ios_google_usb{,_test}.go "$dest/internal/api/"
cp "$here/ios_google_usb_attempts.sql" "$dest/migrations/20261119040000_ios_google_usb_attempts.up.sql"
