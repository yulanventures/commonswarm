# Item L brief: exactly-once `file_put` and `brain_put` over MCP (2026-09-25)

Written by CSwarmDevLead. Order (Strategist, 2026-09-24): after G lanes; "L (exactly-once file_put over MCP)". No
earlier design doc defines L; the only prior text is the command table's reason ("multi-phase upload retries need item
L's durable resume record", `src/cli.ts` `file put` and `brain put` entries) and the reviewers' "upload resume" note
(`docs/evidence/2026-09-23-mcp-v20-review/grok.md:62`). Base: origin/main 084f8a22.

## What is true today (mapped read-only)

- `cswarm file put` and `cswarm brain put` share `uploadNamedFile` (`src/cli.ts`): preflight (25 MiB cap, content type
  from the extension), then mint `fileId`, `versionId`, `createCommandId`, `commitCommandId` ONCE per invocation, then
  `file_version_create` -> storage `PUT` to the signed upload path -> `file_version_commit` (sha256 attached, an
  unverified client attestation). Each phase is retried once in-process on a no-response failure with the SAME ids. "A
  re-RUN of `file put` is a new operation on purpose": a new process mints new ids.
- Server (`supabase/functions/command/file-artifacts.ts`): create and commit are idempotent by `command_id` through the
  shared idempotency ledger (a same-id retry replays; a same-id different body is `command_id_conflict`); commit is a
  one-time `pending -> live` transition; the upload URL is upsert-off, so storage refuses a second PUT to the same
  path; a pending slot is swept after 3 hours; the URL lasts 2 hours.
- MCP (`src/mcp/tools.ts`, `src/mcp/server.ts`): a hand-written seven-tool table; mutating tools require a
  model-supplied `request_id` (`H0_REQUEST_ID_RE`) that becomes the command id; an ambiguous outcome returns
  `{outcome: "unknown", retry_with_same_request_id: true}`. `file put` and `brain put` are `tool: null`.

## Goal

Add MCP tools `file_put` and `brain_put` such that one `request_id` produces **at most one committed version**, and a
retry with the same `request_id` and the same content after ANY failure (a lost response at any phase, a killed MCP
process, a restarted host session) reaches the same result instead of a second version.

## Decisions

1. **Deterministic identity.** Derive `versionId`, `createCommandId` and `commitCommandId` deterministically (for example UUIDv5 under a fixed namespace) from the seat (workspace, principal), the
   `request_id`, the target name and the content's sha256. Keep `fileId` handling exactly as the server requires for an
   existing name versus a new name (read the create handler; do not guess). Consequences to state and test:
   - same `request_id` + same content: every phase replays (create and commit by command id; storage PUT answers
     "already exists" for the same path; the server assigns the upload path per version, and the version id is
     derived from the content hash, so the client may treat that answer as done — verify the path really is per
     version before relying on it);
   - same `request_id` + different content: the tool refuses with a typed `request_id_conflict` BEFORE any network
     call when a local record says so, and otherwise the derived ids differ, so it must not silently create a second
     version under a reused `request_id`: keep a small durable local record (next item) to detect it.
2. **Durable local resume record**, one small JSON per `request_id` beside the profile's state (0600, in the profile's
   0700 state directory), written BEFORE the first network call and updated after each phase: request_id, name,
   sha256, size, derived ids, last completed phase, result. Bounded (for example the newest 200 records, and records
   older than the 3-hour server sweep are dropped). It holds no secret. A retry reads it first. Losing it must not
   break exactly-once for the same content (the derived ids still replay); it only loses the different-content
   conflict check, and the tool then says so in its result (`conflict_check: "unavailable"`), never a false claim.
3. **Tool inputs.** `file_put {request_id, path, name?}` and `brain_put {request_id, topic, path, if_version?}`: `path`
   is an absolute path on the agent's host, read by the MCP server process (no file bytes in the model turn; the
   25 MiB cap and the content-type map apply before any network call). Outputs mirror `cswarm file put --json` and
   `cswarm brain put --json` projections, plus `outcome` (`committed`, `replayed`, `unknown`) and, on `unknown`,
   `retry_with_same_request_id: true`. No output carries an upload URL or a token.
4. **CLI parity.** `cswarm file put` and `cswarm brain put` gain an optional `--request-id` with the same semantics, so
   a person or a script can retry exactly-once too. Without it, behaviour is unchanged (a new operation per run).
5. **Command table.** The two entries get `tool: "file_put"` / `tool: "brain_put"`; the "until item L" reason marker
   and every copy of it are removed; any help or doc that lists MCP tools is generated from the table (AGENTS.md:
   an enumeration inside a message must be generated, not typed).
6. **No server change** unless measurement shows the server cannot support it (for example if storage's
   "already exists" answer cannot be told apart from another refusal, or the create handler cannot take a derived
   `versionId` on a retry). If a server change is needed, stop and report it in LANE.md with the evidence; do not
   write a migration in this lane.

## Tests (each must fail when its fix is reverted; record the measured mutation)

- CLI/MCP stdio tests with a stateful fake edge and fake storage: a lost response after create, after PUT, after
  commit; a process killed between phases and restarted with the same `request_id`: exactly one committed version,
  the second call reports `replayed`. Same `request_id` + different content: `request_id_conflict`, no second create.
  Record deleted between attempts: same content still replays; the result says `conflict_check: "unavailable"`.
- The 25 MiB cap and the content-type refusal happen before any network call (the fake edge sees nothing).
- `brain_put` with `if_version`: the precondition refusal is typed and replay-safe.
- A server test (lead runs it on the local stack): the derived-id sequence against the real command edge and local
  storage, including a same-path second PUT, gives one live version.
- The MCP tool list, the command table and any generated help agree (a test that fails when they differ).

## Gates

`npm run build`; `env -u FORCE_COLOR npm test`; `env -u FORCE_COLOR npm run test:p1-cli`; `npm run check:tests`;
`npm run check:edge`; `npm run build:command-core && git diff --exit-code supabase/functions/_shared/protocol.js`;
`bash scripts/build-release.sh` (check its exit code); `npm --prefix site run build`;
`git diff --check origin/main...HEAD`. Server tests run on the lead's local stack.

## Deferred

Remote (HTTP) MCP transport for these tools; attachments on signals; resuming an upload whose 2-hour URL expired (a
retry after 2 hours may need a new version; say what happens and test it with a fake clock).
