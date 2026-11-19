#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
scratch=$(mktemp -d)
trap 'rm -f "$scratch/verify-waiting"; rmdir "$scratch"' EXIT
xcrun swiftc -swift-version 6 -parse-as-library \
  ios/CommonSwarm/{PKCE,Conversations,ConversationState,FileUpload}.swift \
  ios/CommonSwarm/WorkspaceTools/{WaitingOnYou,WaitingOnYouAPI}.swift \
  ios/Development/WorkspaceTools/VerifyWaitingOnYou.swift \
  -o "$scratch/verify-waiting" \
  -module-cache-path "${TMPDIR:-/tmp}/commonswarm-ios-module-cache"
node ios/Development/WorkspaceTools/waiting-mock.mjs --verify "$scratch/verify-waiting"
