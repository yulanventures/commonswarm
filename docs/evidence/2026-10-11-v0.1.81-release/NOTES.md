# v0.1.81 release build notes (2026-10-11)

- Source: release/cli-0.1.81 (origin/main bc85a343 plus the version bump and the household-tools header).
- `bash scripts/build-release.sh`: exit 0; dist-release/cswarm 3.1M; version 0.1.81 verified by running the artifact; sha256 d361119a36e4c3945da764db2fcf4d8bd085223df8348bebe0377d7afdba2f35.
- `bash scripts/build-npm.sh`: exit 0; dist-npm/cswarm.cjs sha256 d361119a36e4c3945da764db2fcf4d8bd085223df8348bebe0377d7afdba2f35 (identical bundle); version 0.1.81 verified by running the staged artifact.
- Local MCP: MCP_TOOLS has 27 tools (dist/mcp/tools.js; served by dist/mcp/server.js ListTools). `cswarm object --help` lists the object_*, file_* and todo_* tools.
- Not published. npm publish and the /download site release wait for Tom's go through HezLead.
