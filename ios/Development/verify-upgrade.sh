#!/usr/bin/env bash
# Run on a dedicated, already booted simulator with an empty CommonSwarm login.
set -eu
cd "$(dirname "$0")/../.."
udid=${1:?Pass the exact booted simulator UDID}
xcrun simctl list devices booted | grep -F "($udid) (Booted)" >/dev/null
scratch=$(mktemp -d)
node ios/Development/mock.mjs --upgrade >"$scratch/fixture.log" 2>&1 &
fixture=$!
trap 'kill "$fixture" 2>/dev/null || true; wait "$fixture" 2>/dev/null || true' EXIT
for _ in {1..50}; do
    kill -0 "$fixture"
    grep -q 'listening' "$scratch/fixture.log" && break
    sleep 0.1
done
grep -q 'listening' "$scratch/fixture.log"
test "$(curl -fsS http://127.0.0.1:8765/fixture/upgrade-stage)" = '"sign-in"'
for version in 2 3; do
    xcodebuild -quiet test -project ios/CommonSwarm.xcodeproj -scheme HistoryUI \
        -destination "platform=iOS Simulator,id=$udid" -parallel-testing-enabled NO \
        -only-testing:HistoryUITests/SessionUpgradeTests -resultBundlePath "$scratch/build-$version.xcresult" \
        CURRENT_PROJECT_VERSION="$version"
    app=$(xcrun simctl get_app_container "$udid" com.commonswarm.ios app)
    test "$(/usr/libexec/PlistBuddy -c 'Print CFBundleVersion' "$app/Info.plist")" = "$version"
    data=$(xcrun simctl get_app_container "$udid" com.commonswarm.ios data)
    if [[ "$version" = 2 ]]; then first_data="$data"; else test "$first_data" = "$data"; fi
done
test "$(curl -fsS http://127.0.0.1:8765/fixture/upgrade-stage)" = '"complete"'
echo "Build 2 to 3 passed in the same app container. Results: $scratch"
