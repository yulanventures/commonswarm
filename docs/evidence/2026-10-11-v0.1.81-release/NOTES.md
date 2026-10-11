# v0.1.81 release build notes (2026-10-11)

- Source: release/cli-0.1.81 (origin/main bc85a343 plus the version bump and the household-tools header, the D9 fix that sends household calls to /functions/v1/command with a named server error, and one test-comment cleanup).
- `bash scripts/build-release.sh`: exit 0; dist-release/cswarm 3.1M; version 0.1.81 verified by running the artifact; sha256 3d18f44f6af36b30a51699e4e35827c28bb90c8b0ca5245eca94aa1a859372a2.
- `bash scripts/build-npm.sh`: exit 0; dist-npm/cswarm.cjs sha256 3d18f44f6af36b30a51699e4e35827c28bb90c8b0ca5245eca94aa1a859372a2 (identical bundle); version 0.1.81 verified by running the staged artifact.
- Local MCP: MCP_TOOLS has 27 tools (dist/mcp/tools.js; served by dist/mcp/server.js ListTools). `cswarm object --help` lists the object_*, file_* and todo_* tools.
- Not published. npm publish and the /download site release wait for Tom's go through HezLead.
