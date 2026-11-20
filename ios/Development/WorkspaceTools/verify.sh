#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
scratch=$(mktemp -d)
trap 'rm -f "$scratch/verify-todos"; rmdir "$scratch"' EXIT
xcrun swiftc -swift-version 6 -parse-as-library \
  ios/CommonSwarm/{PKCE,Conversations,ConversationState,FileUpload}.swift \
  ios/CommonSwarm/WorkspaceTools/{Todo,TodoAPI}.swift \
  ios/Development/WorkspaceTools/VerifyTodos.swift \
  -o "$scratch/verify-todos" \
  -module-cache-path "${TMPDIR:-/tmp}/commonswarm-ios-module-cache"
node ios/Development/WorkspaceTools/mock.mjs --verify "$scratch/verify-todos"
