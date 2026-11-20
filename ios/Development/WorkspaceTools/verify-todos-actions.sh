#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
scratch=$(mktemp -d)
trap 'rm -f "$scratch/verify-todo-actions"; rmdir "$scratch"' EXIT
xcrun swiftc -swift-version 6 -parse-as-library \
  ios/CommonSwarm/{PKCE,Conversations,ConversationRead,ConversationState,FileUpload}.swift \
  ios/CommonSwarm/WorkspaceTools/{Todo,TodoAPI}.swift \
  ios/Development/WorkspaceTools/VerifyTodoActions.swift \
  -o "$scratch/verify-todo-actions" \
  -module-cache-path "${TMPDIR:-/tmp}/commonswarm-ios-module-cache"
node ios/Development/WorkspaceTools/todos-actions-mock.mjs --verify "$scratch/verify-todo-actions"
