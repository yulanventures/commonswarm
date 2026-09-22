1. **PRODUCTION** — [SWARM-CLOUD.md](/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/arms-doc3-codex/tree/docs/design/SWARM-CLOUD.md:932) and [SWARM-CLOUD-UX.md](/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/arms-doc3-codex/tree/docs/design/SWARM-CLOUD-UX.md:174) still tell users to allow `https://*.supabase.co`. For a deployment with its own service URL, this opens the wrong hosts and leaves Realtime blocked. This also makes the “research complete” claim incomplete.

2. **RIGOUR** — [supabase-stack.test.ts](/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/arms-doc3-codex/tree/tests/p1-cli/supabase-stack.test.ts:415) compares route labels and the set of ports, but not each route’s port. I swapped maintenance Auth and REST ports. All five Caddy tests still passed, including adaptation. During recovery, staging Auth would reach PostgREST and REST would reach GoTrue, while the gates stayed green. The mutation was restored byte-for-byte; the tree is clean.

No production service was contacted.

VERDICT: FAIL — the canonical recovery text still names a dead host pattern, and the Caddy tests accept wrong service routing.
