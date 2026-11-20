#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
scratch=$(mktemp -d)
trap 'rm -f "$scratch/verify-wiki"; rmdir "$scratch"' EXIT
xcrun swiftc -swift-version 6 -parse-as-library \
  ios/CommonSwarm/{PKCE,Conversations,ConversationRead,ConversationState,FileUpload}.swift \
  ios/CommonSwarm/WorkspaceTools/{WorkspaceFiles,WorkspaceFilesAPI,Wiki,WikiAPI}.swift \
  ios/Development/WorkspaceTools/VerifyWiki.swift \
  -o "$scratch/verify-wiki" \
  -module-cache-path "${TMPDIR:-/tmp}/commonswarm-ios-module-cache"
node ios/Development/WorkspaceTools/wiki-mock.mjs --verify "$scratch/verify-wiki"
