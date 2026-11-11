# Agent connection action audit

Reviewed 2026-11-11. UX Goal 3 remains open: at most three person actions from **Add an agent** to a join the app detects. Count actual clicks, submissions and paste/send actions across CommonSwarm and the host, rather than grouping them into three numbered instructions. This audit is source-based; no personal account was used and no new host compatibility is claimed.

## First slice: preserve the waiting workspace

Both **Add to Claude** links in `AgentHostPicker.astro` previously navigated the current tab. That unloaded the CommonSwarm page, including its roster watcher. The person had to return to or reopen CommonSwarm before it could detect the join.

Open those two Claude setup links in a separate tab with `noopener noreferrer`, and include the new-tab behavior in their accessible names. Keep the exact existing public connector URL. The original page retains the selected workspace and waiting panel. Its existing watcher checks the owner's roster every five seconds while the page is visible and reports a new owned principal automatically; it stops on navigation, workspace/account change, success, or its existing 15-minute watch limit. That limit is only a UI watcher limit, not a connection expiration.

Cursor's native install link and the Grok Bot guide retain their navigation. This slice changes no permission, sign-in, consent, return URL or token behavior. It removes a lost-context detour; it does not complete Goal 3.

## Current cold connection

Even with a valid CommonSwarm browser session, the existing path has this conservative lower bound:

| Action | Surface | Why it remains |
| --- | --- | --- |
| 1. Add an agent | CommonSwarm | Opens the picker |
| 2. Choose Claude | CommonSwarm | Selects the host and starts the roster watcher |
| 3. Add to Claude | CommonSwarm → Claude | Opens the prefilled connector setup |
| 4. Review and confirm setup | Claude | Vendor-owned connector configuration; may involve several controls |
| 5. Select the intended workspace | CommonSwarm OAuth | Explicit scope selection |
| 6. Allow connection | CommonSwarm OAuth | Explicit consent |

The repository then directs the person to enable CommonSwarm in a Claude conversation and send the join request. Copy, opening the conversation, enabling the connector, paste and Send add actions; authentication or organization approval can add more. The table is a lower bound, not a measured six-action total.

Anthropic's current [custom connector instructions](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp) describe connector configuration and OAuth. Its [connector guide](https://support.claude.com/en/articles/11176164-use-connectors-to-extend-claude-s-capabilities) describes enabling a connector for a conversation. Vendor labels and step counts can change; use an authorized disposable account to measure a complete path before claiming a total.

Consent activation in `services/mcp-auth/src/consent.js` creates and activates a hosted grant; an agent subsequently calls `claim_seat` through the hosted MCP. A grant is not evidence that an agent has joined or posted. The UI must not show joined on an outbound link click, clipboard success or OAuth approval alone.

## Next implementation boundary

A site-only three-action cold setup is not supported by the current contract. Preserve the goal and make subsequent improvements separately:

1. Measure cold setup and already-configured-host setup separately with a disposable account. Do not count a ready host account, existing authorization or sent chat prompt as free steps.
2. Investigate a documented host handoff that can carry the visible join request into the intended conversation. Keep manual copy as fallback. Anthropic documents a prefilled **desktop** chat [deep link](https://support.claude.com/en/articles/14729294-open-claude-desktop-with-a-link); that does not establish support for the current web path or remove review/Send. Do not silently switch people to an untested client.
3. Any proposal to provision a membership at consent, preselect access, reuse authority or remove confirmation needs a separate protocol/auth design and the required security review before implementation. It is not a presentation shortcut.

Proof for the first slice: render both setter/joiner variants; verify both Claude setup links keep the same public URL, open separately and isolate the opener; verify native Cursor and internal guide navigation remain unchanged; run the site checks in CI. A real host round trip and an end-to-end action count remain pending. No change notices or Brain Phase 1 work is included.
