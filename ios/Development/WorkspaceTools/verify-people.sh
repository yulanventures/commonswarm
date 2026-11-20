#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
scratch=$(mktemp -d)
trap 'rm -f "$scratch/verify-people"; rmdir "$scratch"' EXIT
xcrun swiftc -swift-version 6 -parse-as-library \
  ios/CommonSwarm/{PKCE,Conversations,ConversationRead,ConversationState,FileUpload}.swift \
  ios/CommonSwarm/WorkspaceTools/{PeopleDirectory,PeopleDirectoryAPI}.swift \
  ios/Development/WorkspaceTools/VerifyPeopleDirectory.swift \
  -o "$scratch/verify-people" \
  -module-cache-path "${TMPDIR:-/tmp}/commonswarm-ios-module-cache"
node ios/Development/WorkspaceTools/people-mock.mjs --verify "$scratch/verify-people"
