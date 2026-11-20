#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
scratch=$(mktemp -d)
trap 'rm -f "$scratch/verify" "$scratch/post-agent.json" "$scratch/email-code.json" "$scratch/conversation-commands.json" "$scratch/thread-reply.json"; rmdir "$scratch"' EXIT
for google_usb in 0 1; do
  flags=()
  if [[ "$google_usb" == 1 ]]; then flags=(-D DEBUG -D COMMONSWARM_USB_TEST -D COMMONSWARM_GOOGLE_USB); fi
  xcrun swiftc -swift-version 6 -parse-as-library ${flags[@]+"${flags[@]}"} ios/CommonSwarm/{PKCE,ConversationMembers,ConversationRead,Conversations,ConversationState,FileUpload}.swift \
    ios/Development/Verify.swift -o "$scratch/verify" -module-cache-path "${TMPDIR:-/tmp}/commonswarm-ios-module-cache"
  CS_FIXTURE_GOOGLE_USB="$google_usb" node ios/Development/mock.mjs --verify "$scratch/verify" "$scratch/post-agent.json"
  diff -u ios/Development/thread-reply.json "$scratch/thread-reply.json"
  diff -u ios/Development/post-agent.json "$scratch/post-agent.json"
  diff -u ios/Development/conversation-commands.json "$scratch/conversation-commands.json"
  diff -u ios/Development/email-code.json "$scratch/email-code.json"
done
