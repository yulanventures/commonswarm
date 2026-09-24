You are the Maker for item H release 2, option A, in the CommonSwarm repo. Work ONLY in your current directory, the git
worktree of branch lane/mcp-connect (from main 86a938f3). THE SPECIFICATION is
docs/design/2026-09-24-MCP-RELEASE-2-BRIEF.md: implement decisions 1-6 of option A and the "Done for release 1"
tests (the section is titled "Done for release 2"). Read AGENTS.md first (D-053: never branch on error.message;
generated enumerations; claim controls; onboarding rules), then docs/design/2026-09-23-MCP-LANE-2-BRIEF.md and
docs/design/2026-09-24-ITEM-I-PROFILE-SESSION-BINDING-BRIEF.md, src/h0/ (verbs, paste), supabase/functions/h0/ and the
mint/register handlers in supabase/functions/command/index.ts (read only: NO server or migration change),
src/cloud/agent-profile.ts (saveAgentProfile), src/cloud/agent-credential-input.ts, src/cloud/current-target.ts,
site/src/components/connect/agent-prompt.ts, src/cloud/agent-onboarding-contract.ts, and the AGENT_COMMANDS table in
src/cli.ts (the `mcp` row; add `mcp code` and `mcp connect` as table rows with the right profile and credential modes;
`mcp code` takes the HUMAN credential and refuses agent credentials and --profile, like `invite`).

HARD RULES: contact no production host (api.commonswarm.com, commonswarm.com, edge-staging.commonswarm.com,
178.105.29.28, 100.115.66.74); a cswarm command run without a loopback --url contacts commonswarm.com, so in tests
always use a loopback fake; no supabase, vercel, ssh; no swarm/cswarm against a real workspace; do not read or touch
~/.cswarm or ~/.config/cswarm (tests use a temporary HOME); start no other model; use no skill; no auto-approve flags;
print no secret. No server, edge or migration change. Every test has a timeout; no process of yours survives.
The hidden prompt must be testable: read the code from the controlling TTY with echo off when stdin is a TTY, and in
tests drive it through a pseudo-terminal or an injectable reader; NEVER accept the code from argv, an environment
variable or a file, and add a test for each refusal.
SANDBOX: network access and the repository .git are writable: commit yourself, subject "feat(mcp): ..." /
"test(mcp): ...", trailers exactly (one per line):
Agent-Name: Yulan Bot
Agent-Model: <your model id>
Agent-Family: openai
Agent-Tool: codex <version>
Agent-Model-Source: runtime-ambiguous
Write docs/evidence/2026-09-24-mcp-release2/LANE.md: what was built per decision, tests, mutation results (at least:
printing the seat token fails a test; accepting the code from argv fails a test; retrying register fails a test;
writing over an existing profile fails a test), how decision 3 (target) was settled, and what was not established.

GATES (exit code and count each): npm run build ; env -u FORCE_COLOR npm test ; env -u FORCE_COLOR npm run test:p1-cli ;
npm run check:tests ; bash scripts/build-release.sh (then run dist-release/cswarm mcp connect --help from a temporary
directory outside the repo) ; git diff --check origin/main...HEAD. Tests that call ps may fail with EPERM in the
sandbox; name them. If the dispatch baseline changes, regenerate it with UPDATE_DISPATCH_BASELINE=1 twice (the two runs
byte-identical) and list every changed row and why in LANE.md.

REPORT: commit SHAs; each decision -> implementation -> test; mutation results; gate exit codes with counts; what you
did not establish.
