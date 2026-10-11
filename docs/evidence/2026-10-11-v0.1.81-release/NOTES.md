# v0.1.81 release build notes (2026-10-11)

- Source: release/cli-0.1.81 (origin/main bc85a343 plus the version bump and the household-tools header, the D9 fix that sends household calls to /functions/v1/command with a named server error, one test-comment cleanup, and the next step for an agent that is not yet allowed).
- `bash scripts/build-release.sh`: exit 0; dist-release/cswarm 3.1M; version 0.1.81 verified by running the artifact; sha256 3b08a18508be369deb1c4a98c8d2e4fedfbd69c4997af417862e48f0e11d21ba.
- `bash scripts/build-npm.sh`: exit 0; dist-npm/cswarm.cjs sha256 3b08a18508be369deb1c4a98c8d2e4fedfbd69c4997af417862e48f0e11d21ba (identical bundle); version 0.1.81 verified by running the staged artifact.
- Local MCP: MCP_TOOLS has 27 tools (dist/mcp/tools.js; served by dist/mcp/server.js ListTools). `cswarm object --help` lists the object_*, file_* and todo_* tools.
- Not published. npm publish and the /download site release wait for Tom's go through HezLead.
