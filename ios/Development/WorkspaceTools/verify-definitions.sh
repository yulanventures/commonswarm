#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
scratch=$(mktemp -d)
trap 'rm -f "$scratch/verify-definitions"; rmdir "$scratch"' EXIT
xcrun swiftc -swift-version 6 -parse-as-library \
  ios/CommonSwarm/{PKCE,Conversations,ConversationRead,ConversationState,FileUpload}.swift \
  ios/CommonSwarm/WorkspaceTools/{SharedObjects,SharedObjectsAPI,Definitions,DefinitionsAPI}.swift \
  ios/Development/WorkspaceTools/VerifyDefinitions.swift \
  -o "$scratch/verify-definitions" \
  -module-cache-path "${TMPDIR:-/tmp}/commonswarm-ios-module-cache"
node ios/Development/WorkspaceTools/definitions-mock.mjs --verify "$scratch/verify-definitions"
