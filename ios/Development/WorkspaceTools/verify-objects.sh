#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
scratch=$(mktemp -d)
trap 'rm -f "$scratch/verify-objects"; rmdir "$scratch"' EXIT
xcrun swiftc -swift-version 6 -parse-as-library \
  ios/CommonSwarm/{PKCE,Conversations,ConversationRead,ConversationState,FileUpload}.swift \
  ios/CommonSwarm/WorkspaceTools/{SharedObjects,SharedObjectsAPI}.swift \
  ios/Development/WorkspaceTools/VerifySharedObjects.swift \
  -o "$scratch/verify-objects" \
  -module-cache-path "${TMPDIR:-/tmp}/commonswarm-ios-module-cache"
node ios/Development/WorkspaceTools/objects-mock.mjs --verify "$scratch/verify-objects"
