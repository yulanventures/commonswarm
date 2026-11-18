#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
scratch=$(mktemp -d)
trap 'rm -f "$scratch/verify" "$scratch/post-agent.json"; rmdir "$scratch"' EXIT
xcrun swiftc -swift-version 6 -parse-as-library ios/CommonSwarm/{PKCE,Conversations,ConversationState}.swift \
  ios/Development/Verify.swift -o "$scratch/verify" -module-cache-path "${TMPDIR:-/tmp}/commonswarm-ios-module-cache"
node ios/Development/mock.mjs --verify "$scratch/verify" "$scratch/post-agent.json"
diff -u ios/Development/post-agent.json "$scratch/post-agent.json"
