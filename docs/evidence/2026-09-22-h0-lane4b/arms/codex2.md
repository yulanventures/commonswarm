- **PRODUCTION — Wrong limit message:** [site/src/lib/h0-link-join.ts:185](/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/arms-4b-codex/site/src/lib/h0-link-join.ts:185) says the *workspace* allows no more invites for every limit error. The server also has a per-person limit of 5 and returns `scope: "identity"` when that limit is hit ([command/index.ts:6528](/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/arms-4b-codex/supabase/functions/command/index.ts:6528)). A person can see this message while the workspace is below its limit of 20.

- **PRODUCTION — Command can wait without end:** [site/src/lib/h0-link-join.ts:164](/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/arms-4b-codex/site/src/lib/h0-link-join.ts:164) clears the 30-second timer before `response.text()` at line 168. If the server sends headers but the body stalls, mint or revoke stays busy with no result.

The round-one fixes, command shapes, server limits, flag gate, and test-script reachability check out. The focused tests passed (15/15). The full site suite failed because this worktree has no `site/dist`; I did not build it.

VERDICT: FAIL
