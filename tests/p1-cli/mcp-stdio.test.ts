import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile, readFile, readdir, unlink, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import ts from "typescript";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AGENT_CREDENTIAL_MESSAGE_D088 } from "../../src/cloud/agent-credential-input.js";
import { parseAgentConnection, profileTarget, readAgentProfile, saveAgentProfile } from "../../src/cloud/agent-profile.js";
import { newSessionBinding, SessionContextError } from "../../src/cloud/session-context.js";
import { RenewalCredentialCheckError, RenewalOutcomeUnknown, RenewalReauthorisationRequired, RenewalRefused, RenewalRetryError, RenewalRevoked, RenewalSuperseded, RenewalSuspended, RenewalUnsupported, RenewalUpgradeRequiredError, REVOCATION_REASONS_LIST } from "../../src/cloud/renewal.js";
import { checkAgentMessages, cachedAgentMessage, AGENT_CHECK_PAGE_SIZE, AGENT_CHECK_BODY_BUDGET } from "../../src/cloud/agent-check.js";
import { AgentSetupError } from "../../src/cloud/agent-profile.js";
import { CommandHttpError } from "../../src/cloud/command-client.js";
import { AGENT_SESSION_PROOF_REFUSAL_CODES, agentSessionErrorStatus } from "../../src/cloud/session-wire.js";
import { LocalCredentialSecretAbsentError, SignalMalformedError, SignalRecipientError, SignalTransportError } from "../../src/cloud/signals.js";
import { FileLockTimeoutError, StoredRecordOversizedError } from "../../src/cloud/storage.js";
import { mapMcpError, readMcpPutFile, sendWithDeferredCommit } from "../../src/mcp/server.js";
import { FileCommandRefused, FileTransportError } from "../../src/cloud/files.js";
import { MCP_ERROR_SENTENCES } from "../../src/mcp/errors.js";
import { MCP_ARGUMENT_NAME_ECHO_MAX, MCP_RESULT_MAX_BYTES, MCP_TOOLS, capMcpResult, capFreshCheck, validateMcpArguments } from "../../src/mcp/tools.js";
import { Arguments } from "../../src/cli.js";

const WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWNER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const TOKEN = `swm_agt_${"C".repeat(43)}`;
const DENIED = ["profile", "host-session-id", "session-context", "agent-token-file", "agent-token-stdin", "url", "anon-key", "force-file-store", "workspace-id", "body-file", "body-stdin", "attach", "json", "wait", "follow", "notify", "ndjson", "hook", "force", "out"];
function assertDenySchemas(tools: Array<{ name: string; inputSchema: { properties?: Record<string, unknown> } }>) {
  for (const tool of tools) for (const bad of DENIED) for (const key of [bad, bad.replaceAll("-", "_")]) {
    assert.ok(!Object.hasOwn(tool.inputSchema.properties ?? {}, key), `${tool.name} advertised ${key}`);
  }
}

function signal(body: string, kind: string, id = ID) {
  return { id, workspace_id: WS, from: OWNER, from_kind: "user", to: null, to_agent: AGENT,
    in_reply_to: null, about: null, kind, body, created_at: "2026-09-23T00:00:00.000Z",
    until: "2099-01-01T00:00:00.000Z", sender_owner_relation: "same_owner", channel_id: null };
}

async function fixture(incomingBody = "A teammate's full message", expiresAt = "2099-01-01T00:00:00.000Z") {
  const root = await mkdtemp(join(tmpdir(), "cswarm-mcp-"));
  const posts: Array<Record<string, any>> = [];
  const observations: Array<Record<string, any>> = [];
  const fileCommands: Array<Record<string, any>> = [];
  const fileCreates = new Map<string, Record<string, any>>();
  const fileCommits = new Map<string, Record<string, any>>();
  const fileObjects = new Set<string>();
  let filePrecondition: number | null = null;
  let fileCreateError: { status: number; code: string } | null = null;
  let fileCreateDrop = false;
  let putRefusal: { status: number; body: object } | null = null;
  let killPhase: "create" | "put" | "commit" | null = null;
  let killMcp: (() => void) | null = null;
  let renewals = 0;
  const committed = new Map<string, object>();
  let readRefusal = false, sendRefusal = false, readError: { status: number; code: string } | null = null;
  let sendError: { status: number; code: string } | null = null;
  let serverConflict = false, lostAttempts = 0, delayAnswer = false, malformedAnswer = false;
  let workspaceName = "Test workspace";
  let ambiguousRecipient = false, malformedRead = false, renewalReason: string | null = null;
  let incoming = [signal(incomingBody, "ask")];
  const edge = createServer((req, res) => {
    let raw = "";
    req.on("data", chunk => raw += chunk);
    req.on("end", () => {
      if (req.method === "PUT") {
        if (putRefusal) return res.writeHead(putRefusal.status, { "content-type": "application/json" }).end(JSON.stringify(putRefusal.body));
        if (fileObjects.has(req.url ?? "")) return res.writeHead(409, { "content-type": "application/json" }).end(JSON.stringify({ error: "Duplicate" }));
        fileObjects.add(req.url ?? "");
        if (killPhase === "put") { killPhase = null; setImmediate(() => killMcp?.()); }
        return res.writeHead(200, { "content-type": "application/json" }).end("{}");
      }
      assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
      const body = JSON.parse(raw);
      const send = (status: number, value: object) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
      if (body.command?.kind === "file_version_create") {
        fileCommands.push(body);
        if (fileCreateDrop) { req.socket.destroy(); return; }
        if (fileCreateError) return send(fileCreateError.status, { error: fileCreateError.code });
        if (filePrecondition !== null && body.command.if_version !== filePrecondition) {
          return send(409, { error: "file_version_precondition_failed", message: "newer live version" });
        }
        let created = fileCreates.get(body.command_id);
        if (!created) {
          const version = fileCreates.size + 1;
          created = { file_id: body.command.file_id, version_id: body.command.version_id, version_n: version,
            name: body.command.name, upload_path: `/storage/v1/object/upload/sign/swarm-files/${WS}/${body.command.file_id}/${version}?token=fake`,
            upload_token: "SECRET-UPLOAD-TOKEN", upload_expires_in_seconds: 7200 };
          fileCreates.set(body.command_id, created);
        }
        if (killPhase === "create") { killPhase = null; setImmediate(() => killMcp?.()); }
        return send(200, created);
      }
      if (body.command?.kind === "file_version_commit") {
        fileCommands.push(body);
        let committed = fileCommits.get(body.command_id);
        if (!committed) {
          const created = [...fileCreates.values()].find(row => row.version_id === body.command.version_id)!;
          if (!fileObjects.has(created.upload_path as string)) return send(409, { error: "file_bytes_missing", message: "no object was uploaded for this version" });
          committed = { file_id: created.file_id, version_id: created.version_id, version_n: created.version_n,
            name: created.name, size_bytes: 7, sha256: body.command.sha256, sha256_note: "unverified client attestation",
            reference: `file:${created.file_id}@v${created.version_n}` };
          fileCommits.set(body.command_id, committed);
        }
        if (killPhase === "commit") { killPhase = null; setImmediate(() => killMcp?.()); }
        return send(200, committed);
      }
      if (body.resource === "members") {
        if (readError) return send(readError.status, { error: readError.code });
        if (readRefusal) return send(403, { error: "forbidden", message: "Read refused." });
        if (malformedRead) return send(200, { members: "malformed" });
        return send(200, { members: [{ user_id: OWNER, display_name: "Owner" }, ...(ambiguousRecipient ? [{ user_id: ID, display_name: "Owner" }] : [])],
          agents: [{ principal_id: AGENT, name: "Test agent", owner_user_id: OWNER }],
          identity: { credential_valid: true, principal_id: AGENT, workspace_id: WS,
            workspace_name: workspaceName, owner_user_id: OWNER, token_id: "SECRET-TOKEN-ID", grant_id: "SECRET-GRANT-ID" } });
      }
      if (body.resource === "signals") {
        if (readError) return send(readError.status, { error: readError.code });
        if (readRefusal) return send(403, { error: "forbidden", message: "Read refused." });
        return send(200, { signals: body.after_id ? incoming.filter(row => row.id > body.after_id) : incoming, capabilities: { cursor_after: 1, sender_owner_relation: 1 } });
      }
      if (body.command?.kind === "ack_agent_delivery" && body.command?.unclaimed === true) {
        observations.push(body);
        return send(200, { ok: true, status: "accepted", event_ids: [],
          signal_id: body.command.signal_id, outcome: "observed" });
      }
      if (body.command?.kind === "renew_agent_token") {
        renewals++;
        if (renewalReason) return send(200, { status: "rejected", reason: renewalReason });
        return send(426, { error: "upgrade_required", min_client_version: "0.1.99" });
      }
      if (body.command?.kind === "post_signal") {
        posts.push(body);
        if (sendError) return send(sendError.status, { error: sendError.code });
        if (serverConflict) { serverConflict = false; return send(409, { error: "command_id_conflict", message: "Request ID conflicts with another command." }); }
        if (sendRefusal) return send(403, { error: "signal_refused", message: "Signal refused." });
        const previous = committed.get(body.command_id);
        const response = { status: "accepted", ok: true, event_ids: [], events: [], signal: {
          ...signal(body.command.body, body.command.signal_kind), from: AGENT, from_kind: "agent",
          in_reply_to: body.command.in_reply_to, channel_id: "SECRET-CHANNEL-ID" } };
        if (lostAttempts > 0) {
          // The write commits once, but every internal attempt loses its answer.
          if (!previous) committed.set(body.command_id, response);
          lostAttempts--;
          return send(503, { error: "temporary" });
        }
        if (previous) return send(200, previous);
        committed.set(body.command_id, response);
        if (malformedAnswer) { malformedAnswer = false; return send(200, { status: "accepted", ok: true, signal: null }); }
        if (delayAnswer) { delayAnswer = false; setTimeout(() => send(200, response), 250); return; }
        return send(200, response);
      }
      return send(400, { error: "unexpected" });
    });
  });
  await new Promise<void>(done => edge.listen(0, "127.0.0.1", done));
  const profile = join(root, "profile", "profile.json");
  await saveAgentProfile(profile, parseAgentConnection(JSON.stringify({ version: 1,
    url: `http://127.0.0.1:${(edge.address() as { port: number }).port}`, anon_key: "test-public-key",
    workspace_id: WS, principal_id: AGENT, credential: { message: AGENT_CREDENTIAL_MESSAGE_D088,
      status: "accepted", principal_id: AGENT, token_id: "11111111-1111-4111-8111-111111111111",
      run_id: "22222222-2222-4222-8222-222222222222", agent_token: TOKEN,
      expires_at: expiresAt } })));
  let client: Client;
  let transport: StdioClientTransport;
  let stderr = "";
  let stdout = "";
  const startMcp = async () => {
    client = new Client({ name: "mcp-test-host", version: "1" });
    transport = new StdioClientTransport({ command: process.execPath,
      args: [resolve("dist/cli.js"), "mcp", "--profile", profile],
      env: { PATH: process.env.PATH ?? "", HOME: root, SWARM_AGENT_STATE_DIR: join(root, "renewal"),
        XDG_CONFIG_HOME: join(root, "config") }, stderr: "pipe" });
    transport.stderr?.on("data", chunk => stderr += chunk);
    const start = transport.start.bind(transport);
    transport.start = async () => { await start(); (transport as any)._process.stdout.on("data", (chunk: Buffer) => stdout += chunk.toString()); };
    await client.connect(transport);
    killMcp = () => (transport as any)._process.kill("SIGKILL");
  };
  await startMcp();
  const restart = async () => {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    await startMcp();
  };
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await client.close().catch(() => undefined); await transport.close().catch(() => undefined);
    await new Promise<void>(done => edge.close(() => done()));
    await rm(root, { recursive: true, force: true });
  };
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ type: string; text: string }>).find(item => item.type === "text")!;
    assert.ok(Buffer.byteLength(text.text) <= MCP_RESULT_MAX_BYTES + 128);
    assert.ok(!text.text.includes(TOKEN));
    assert.ok(!text.text.includes(profile));
    assert.ok(!text.text.includes("SECRET-GRANT-ID"));
    assert.ok(!text.text.includes("SECRET-TOKEN-ID"));
    assert.ok(!text.text.includes("cswarm check --"));
    return { result, value: JSON.parse(text.text) as Record<string, any> };
  };
  return { root, profile, posts, observations, fileCommands, fileCreates, fileCommits, fileObjects, created: () => committed.size, renewals: () => renewals, get client() { return client; }, get transport() { return transport; }, call, close, restart, killAfter: (phase: "create" | "put" | "commit") => { killPhase = phase; }, stderr: () => stderr, stdout: () => stdout,
    refuseReads: (value: boolean) => { readRefusal = value; }, refuseSends: (value: boolean) => { sendRefusal = value; },
    setReadError: (value: typeof readError) => { readError = value; }, setSendError: (value: typeof sendError) => { sendError = value; },
    loseNextAnswer: () => { lostAttempts = 3; }, delayNextAnswer: () => { delayAnswer = true; }, malformedNextAnswer: () => { malformedAnswer = true; },
    setIncoming: (rows: ReturnType<typeof signal>[]) => { incoming = rows; },
    setWorkspaceName: (name: string) => { workspaceName = name; },
    setAmbiguousRecipient: (value: boolean) => { ambiguousRecipient = value; },
    setMalformedRead: (value: boolean) => { malformedRead = value; },
    setRenewalReason: (value: string) => { renewalReason = value; },
    setFilePrecondition: (value: number | null) => { filePrecondition = value; },
    setFileCreateError: (value: typeof fileCreateError) => { fileCreateError = value; },
    setFileCreateDrop: (value: boolean) => { fileCreateDrop = value; },
    setPutRefusal: (value: typeof putRefusal) => { putRefusal = value; },
    seedCreatedObject: () => { const created = [...fileCreates.values()][0]; assert.ok(created); fileObjects.add(created.upload_path as string); },
    conflictNext: () => { serverConflict = true; } };
}

test("profile errors never tell the model to fix a tool argument", { timeout: 10000 }, () => {
  // The profile is a process flag, not a tool argument: no profile_* code may carry the "fix the named argument" step.
  const profileCodes = Object.keys(MCP_ERROR_SENTENCES).filter(code => code.startsWith("profile_"));
  assert.ok(profileCodes.length >= 8);
  for (const code of profileCodes) assert.notEqual(MCP_ERROR_SENTENCES[code]!.next_step, "fix the named argument", code);
  assert.equal(MCP_ERROR_SENTENCES.profile_other_session!.next_step, "stop and tell the operator");
  assert.equal(MCP_ERROR_SENTENCES.host_session_required!.next_step, "restart this MCP server with the current host session");
});

test("an unknown argument name is echoed quoted and bounded", () => {
  const long = "k".repeat(MCP_ARGUMENT_NAME_ECHO_MAX * 4);
  assert.throws(() => validateMcpArguments("whoami", { [long]: "x" }), (error: Error) =>
    error.message === `Unknown argument: "${"k".repeat(MCP_ARGUMENT_NAME_ECHO_MAX)}".`);
  assert.throws(() => validateMcpArguments("whoami", { "a\nb": "x" }), (error: Error) =>
    error.message === "Unknown argument: \"a\\nb\"." && !error.message.includes("\n"));
});

test("expanded CLI profile keeps its state location for request-id uploads", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const args = new Arguments(["file", "put", join(f.root, "plan.md"), "--profile", f.profile]);
    await args.expandAgentProfile("expand", "drop");
    assert.equal(args.expandedProfilePath, f.profile);
    assert.equal(args.optional("profile"), undefined);
  } finally { await f.close(); }
});

test("MCP stdio tool table, allow-lists, every happy path and refusal", { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const listed = (await f.client.listTools()).tools;
    assert.deepEqual(listed.map(tool => tool.name), MCP_TOOLS.map(tool => tool.name));
    assertDenySchemas(listed);
    // Mutation control: adding one credential flag to an advertised schema trips the gate.
    const mutated = [{ name: listed[0].name, inputSchema: { properties: { ...listed[0].inputSchema.properties, profile: { type: "string" } } } }];
    assert.throws(() => assertDenySchemas(mutated), /advertised profile/);
    for (const tool of listed) {
      assert.equal(tool.inputSchema.additionalProperties, false);
      for (const bad of DENIED) {
        for (const key of [bad, bad.replaceAll("-", "_")]) {
          const base = tool.name === "reply" ? { signal_id: ID, body: "answer", request_id: "request01" }
            : ["ask", "note", "working_on"].includes(tool.name) ? { body: "hello", request_id: "request01" } : {};
          await assert.rejects(f.client.callTool({ name: tool.name, arguments: { ...base, [key]: "forbidden" } }), (error: any) => error.code === -32602);
        }
      }
    }
    assert.deepEqual((await f.call("whoami")).value, { principal_id: AGENT, name: "Test agent", workspace_id: WS, workspace_name: "Test workspace" });
    const members = (await f.call("members")).value;
    assert.deepEqual(members.agents, [{ principal_id: AGENT, name: "Test agent" }]);
    assert.equal(members.members[0].name, "Owner");
    const check = (await f.call("check")).value;
    assert.equal(check.messages[0].body, "A teammate's full message");
    assert.equal(check.next_action, null);
    assert.equal((await f.call("check", { message_id: ID })).value.messages[0].body, "A teammate's full message");
    assert.equal((await f.call("check", { message_id: ID })).value.messages[0].sender_owner_relation, "same_owner");
    assert.equal((await f.call("check", { message_id: ID.toUpperCase() })).value.messages[0].body, "A teammate's full message");
    for (const [name, args] of Object.entries({ ask: { body: "question", to: "Owner", request_id: "request02" },
      note: { body: "note", request_id: "request03" }, reply: { signal_id: ID, body: "answer", request_id: "request04" },
      working_on: { body: "work", request_id: "request05" } })) {
      const result = (await f.call(name, args)).value;
      assert.deepEqual(Object.keys(result), ["signal_id", "kind", "created_at", "in_reply_to", "channel_id"]);
    }
    assert.equal(f.posts.length, 4);
    assert.equal(f.posts[0].command.to_user_id, OWNER);
    assert.equal(f.posts[2].command.in_reply_to, ID);
    f.refuseReads(true);
    for (const name of ["whoami", "members", "check"]) assert.equal((await f.call(name)).result.isError, true);
    f.refuseReads(false); f.refuseSends(true);
    for (const name of ["ask", "note", "reply", "working_on"]) {
      const args = name === "reply" ? { signal_id: ID, body: "answer", request_id: `deny_${name}` }
        : { body: "hello", request_id: `deny_${name}` };
      const { result, value } = await f.call(name, args);
      assert.equal(result.isError, true); assert.equal(value.code, "signal_refused");
      assert.equal(value.status, 403); assert.equal(value.message, MCP_ERROR_SENTENCES.signal_refused!.message);
    }
    assert.equal(f.stderr(), "");
    await f.close();
    const rawLines = f.stdout().trim().split("\n");
    assert.ok(rawLines.length > 7);
    for (const line of rawLines) {
      const message = JSON.parse(line);
      assert.equal(message.jsonrpc, "2.0");
      assert.ok(Object.hasOwn(message, "result") || Object.hasOwn(message, "error"));
    }
    // Mutation control: one printable table-handler line must break stdout purity.
    assert.throws(() => [...rawLines, "Signal shared."].forEach(line => JSON.parse(line)), SyntaxError);
  } finally { await f.close(); }
});

test("MCP stdio file_put and brain_put replay, conflict, and preflight", { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const listed = (await f.client.listTools()).tools.map(tool => tool.name);
    assert.ok(listed.includes("file_put"));
    assert.ok(listed.includes("brain_put"));
    assert.throws(() => validateMcpArguments("file_put", { request_id: "relative01", path: "relative.md" }), /Invalid argument: path/);
    await assert.rejects(f.client.callTool({ name: "file_put", arguments: { request_id: "relative01", path: "relative.md" } }), (error: any) => error.code === -32602);
    assert.equal(f.fileCommands.length, 0);
    const path = join(f.root, "plan.md");
    await writeFile(path, "# plan\n");
    const first = (await f.call("file_put", { request_id: "fileput01", path })).value;
    assert.equal(first.outcome, "committed");
    assert.ok(first.reference.startsWith("file:"));
    assert.equal((await f.call("file_put", { request_id: "fileput01", path })).value.outcome, "replayed");
    assert.equal(f.fileCommits.size, 1);
    assert.equal(f.fileCreates.size, 1);
    const resumeDir = join(f.root, "profile", "file-put-resume");
    const records = await readdir(resumeDir);
    assert.equal(records.length, 1);
    await unlink(join(resumeDir, records[0]!));
    f.setPutRefusal({ status: 400, body: { statusCode: "409", error: "Duplicate", message: "The resource already exists" } });
    const withoutRecord = (await f.call("file_put", { request_id: "fileput01", path })).value;
    f.setPutRefusal(null);
    assert.equal(withoutRecord.outcome, "committed");
    assert.equal(withoutRecord.conflict_check, "unavailable");
    assert.equal(f.fileCommits.size, 1);
    await writeFile(path, "# changed\n");
    const createCount = f.fileCommands.length;
    const conflict = await f.call("file_put", { request_id: "fileput01", path });
    assert.equal(conflict.result.isError, true);
    assert.equal(conflict.value.code, "request_id_conflict");
    assert.equal(f.fileCommands.length, createCount);
    const unsupported = join(f.root, "script.sh");
    await writeFile(unsupported, "code");
    const type = await f.call("file_put", { request_id: "badtype01", path: unsupported });
    assert.equal(type.value.code, "file_type_refused");
    assert.equal(f.fileCommands.length, createCount);
    const oversized = join(f.root, "large.md");
    await writeFile(oversized, Buffer.alloc(25 * 1024 * 1024 + 1));
    const cap = await f.call("file_put", { request_id: "largefile01", path: oversized });
    assert.equal(cap.value.code, "file_too_large");
    assert.equal(f.fileCommands.length, createCount);
    const brain = join(f.root, "brain.md");
    await writeFile(brain, "# topic\n");
    const saved = (await f.call("brain_put", { request_id: "brainput01", topic: "topic", path: brain, if_version: 0 })).value;
    assert.equal(saved.topic, "topic");
    assert.equal(saved.outcome, "committed");
    assert.equal((await f.call("brain_put", { request_id: "brainput01", topic: "topic", path: brain, if_version: 0 })).value.outcome, "replayed");
    assert.equal(f.fileCommits.size, 2);
    f.setFilePrecondition(2);
    const precondition = await f.call("brain_put", { request_id: "brain-old-02", topic: "topic", path: brain, if_version: 1 });
    assert.equal(precondition.result.isError, true);
    assert.equal(precondition.value.code, "file_version_precondition_failed");
    assert.equal(f.fileCommits.size, 2);
    assert.doesNotMatch(JSON.stringify({ first, saved }), /SECRET-UPLOAD-TOKEN|token=fake/);
  } finally { await f.close(); }
});

test("every typed file refusal has an owned next step", { timeout: 10000 }, () => {
  const retry = "retry this call with the same request_id";
  for (const code of ["file_bytes_missing", "file_transport"]) {
    const error = code === "file_transport" ? new FileTransportError("offline") : new FileCommandRefused(409, code, "hidden");
    assert.equal(mapMcpError(error).next_step, retry, code);
  }
  for (const status of [429, 500, 503]) assert.equal(mapMcpError(new FileCommandRefused(status, "temporary", "hidden")).next_step, retry);
  for (const code of ["file_too_large", "file_type_refused", "if_version_invalid", "file_path_invalid", "file_path_protected",
    "file_size_exceeds_declaration", "file_id_unavailable", "version_id_unavailable", "file_tombstoned", "file_version_cap",
    "brain_version_in_flight_cap", "workspace_file_count", "workspace_quota_exceeded", "file_not_found"]) {
    assert.equal(mapMcpError(new FileCommandRefused(409, code, "hidden")).next_step, "fix the named argument", code);
  }
  for (const status of [401, 403]) assert.equal(mapMcpError(new FileCommandRefused(status, "forbidden", "hidden")).next_step,
    "a person must restore this agent's access outside this session");
  assert.equal(mapMcpError(new FileCommandRefused(409, "file_commit_conflict", "hidden")).next_step, "use a new request_id for new content");
  assert.equal(mapMcpError(new FileCommandRefused(409, "command_id_conflict", "hidden")).next_step, "use a new request_id for new content");
  assert.match(mapMcpError(new FileCommandRefused(409, "file_version_precondition_failed", "hidden")).next_step, /read the topic again and use a NEW request_id/);
  assert.match(MCP_ERROR_SENTENCES.request_id_conflict!.next_step, /new request_id/);
});

test("MCP 5xx file create reports unknown with the same request id", { timeout: 15000 }, async () => {
  const f = await fixture();
  try {
    const path = join(f.root, "outage.md");
    await writeFile(path, "# outage\n");
    f.setFileCreateError({ status: 503, code: "temporary" });
    const response = await f.call("file_put", { request_id: "outage-create-01", path });
    assert.equal(response.result.isError, undefined);
    assert.equal(response.value.outcome, "unknown");
    assert.equal(response.value.retry_with_same_request_id, true);
    assert.equal(response.value.next_step, "retry this call with the same request_id");
    f.setFileCreateError(null);
    assert.equal((await f.call("file_put", { request_id: "outage-create-01", path })).value.outcome, "committed");
  } finally { await f.close(); }
});

test("MCP no-response file create gives the generated retry step", { timeout: 15000 }, async () => {
  const f = await fixture();
  try {
    const path = join(f.root, "dropped.md");
    await writeFile(path, "# dropped\n");
    f.setFileCreateDrop(true);
    const response = await f.call("file_put", { request_id: "dropped-create-01", path });
    assert.equal(response.result.isError, undefined);
    assert.equal(response.value.outcome, "unknown");
    assert.equal(response.value.next_step, "retry this call with the same request_id");
    f.setFileCreateDrop(false);
    assert.equal((await f.call("file_put", { request_id: "dropped-create-01", path })).value.outcome, "committed");
  } finally { await f.close(); }
});

test("MCP path preflight refuses nonfiles and private state before network", { timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    const regular = join(f.root, "regular.md");
    await writeFile(regular, "# safe\n");
    const fifo = join(f.root, "fifo.md");
    execFileSync("mkfifo", [fifo], { timeout: 2000 });
    const dangling = join(f.root, "fifo-link.md");
    await symlink(fifo, dangling);
    const privateFile = join(f.root, "profile", "private.md");
    await writeFile(privateFile, "private");
    await mkdir(join(f.root, ".cswarm"));
    const stateFile = join(f.root, ".cswarm", "state.md");
    await writeFile(stateFile, "private");
    await mkdir(join(f.root, ".config", "cswarm"), { recursive: true });
    const configFile = join(f.root, ".config", "cswarm", "config.md");
    await writeFile(configFile, "private");
    const alias = join(f.root, "alias.md");
    await symlink(privateFile, alias);
    const externalCredential = join(f.root, "outside-credential.md");
    await writeFile(externalCredential, "private");
    await assert.rejects(readMcpPutFile(externalCredential, f.profile, externalCredential), (error: any) => error.code === "file_path_protected");
    const cases: Array<[string, string]> = [
      [join(f.root, "missing.md"), "file_path_invalid"], [f.root, "file_path_invalid"],
      [fifo, "file_path_invalid"], [dangling, "file_path_invalid"],
      [privateFile, "file_path_protected"], [stateFile, "file_path_protected"],
      [configFile, "file_path_protected"], [alias, "file_path_protected"],
      [f.profile, "file_path_protected"],
    ];
    for (const [index, [path, code]] of cases.entries()) {
      const answer = await f.call("file_put", { request_id: `path-case-${index}x`, path, name: "safe.md" });
      assert.equal(answer.result.isError, true, path);
      assert.equal(answer.value.code, code, path);
      assert.equal(answer.value.next_step, "fix the named argument", path);
    }
    assert.equal(f.fileCommands.length, 0);
    assert.equal((await f.call("file_put", { request_id: "path-positive-01", path: regular })).value.outcome, "committed");
  } finally { await f.close(); }
});

for (const phase of ["create", "put", "commit"] as const) {
  test(`MCP process killed after ${phase} resumes the same file version`, { timeout: 20_000 }, async () => {
    const f = await fixture();
    try {
      const path = join(f.root, "restart.md");
      await writeFile(path, "# restart\n");
      f.killAfter(phase);
      await assert.rejects(f.client.callTool({ name: "file_put", arguments: { request_id: `restart_${phase}`, path } }));
      await f.restart();
      const retried = (await f.call("file_put", { request_id: `restart_${phase}`, path })).value;
      assert.equal(retried.outcome, "committed");
      assert.equal(f.fileCreates.size, 1);
      assert.equal(f.fileCommits.size, 1);
    } finally { await f.close(); }
  });
}

for (const [shape, refusal] of [
  ["local 400 duplicate", { status: 400, body: { statusCode: "409", error: "Duplicate", message: "The resource already exists" } }],
  ["409 duplicate", { status: 409, body: { error: "Duplicate", message: "The resource already exists" } }],
  ["expired 403", { status: 403, body: { error: "ExpiredToken" } }],
] as const) {
  test(`MCP replayed PUT refused with ${shape} follows the commit result`, { timeout: 30_000 }, async () => {
    const f = await fixture();
    try {
      const path = join(f.root, "refused.md");
      await writeFile(path, "# plan\n");
      for (const present of [true, false]) {
        const request_id = `refused_${shape.replaceAll(/[^a-z0-9]/gi, "_")}_${present}`;
        // A first PUT refusal has no earlier PUT evidence and must stop here.
        f.setPutRefusal({ status: 403, body: { error: "ExpiredToken" } });
        const first = await f.call("file_put", { request_id, path });
        assert.equal(first.value.outcome, "unknown");
        assert.equal(first.value.retry_with_same_request_id, true);
        assert.equal(f.fileCommits.size, present ? 0 : 1);
        if (present) f.seedCreatedObject();
        f.setPutRefusal(refusal);
        const resumed = await f.call("file_put", { request_id, path });
        if (present) {
          assert.equal(resumed.result.isError, undefined);
          assert.equal(resumed.value.outcome, "committed");
          assert.equal(f.fileCommits.size, 1);
        } else {
          assert.equal(resumed.result.isError, true);
          assert.equal(resumed.value.code, "file_bytes_missing");
          assert.notEqual(resumed.value.outcome, "replayed");
          assert.equal(f.fileCommits.size, 1);
        }
      }
    } finally { await f.close(); }
  });
}

test("MCP managed principal requires the current host session and renewal errors stay typed", { timeout: 15_000 }, async () => {
  const f = await fixture();
  try {
    const profile = await readAgentProfile(f.profile);
    const context = newSessionBinding({ target: profileTarget(profile), workspaceId: WS,
      principalId: AGENT, provider: "codex", mode: "interactive", hostSessionId: "current-host",
      tokenFile: profile.credential_file });
    const path = join(f.root, "config", "cswarm", "sessions", WS, AGENT, `${context.session_id}.json`);
    await mkdir(join(f.root, "config", "cswarm", "sessions", WS, AGENT), { recursive: true, mode: 0o700 });
    await writeFile(path, JSON.stringify({ ...context, generation: 1 }), { mode: 0o600 });
    const child = spawn(process.execPath, [resolve("dist/cli.js"), "mcp", "--profile", f.profile], {
      env: { PATH: process.env.PATH ?? "", HOME: f.root, XDG_CONFIG_HOME: join(f.root, "config") }, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "", stdout = "";
    child.stderr.on("data", chunk => stderr += chunk);
    child.stdout.on("data", chunk => stdout += chunk);
    const exit = await new Promise<number>((done, fail) => { child.once("error", fail); child.once("close", code => done(code ?? 1)); });
    assert.equal(exit, 1);
    assert.equal(stdout, "");
    assert.match(stderr, /host_session_required/);
    for (const [error, code] of [
      [new RenewalReauthorisationRequired("horizon_reached", AGENT, "Ask the owner to authorise again."), "horizon_reached"],
      [new RenewalRevoked("renewal_revoked", "Credential revoked."), "renewal_revoked"],
      [new RenewalSuspended("renewal_suspended", "Renewal suspended."), "renewal_suspended"],
      [new RenewalUpgradeRequiredError("0.1.99"), "upgrade_required"],
    ] as const) {
      const mapped = mapMcpError(error);
      assert.equal(mapped.code, code);
      assert.equal(mapped.message, MCP_ERROR_SENTENCES[code]!.message);
      assert.doesNotMatch(mapped.message, /cswarm|--[a-z]|\/|\\/i);
      assert.ok(mapped.next_step);
      if (error instanceof RenewalUpgradeRequiredError) assert.equal(mapped.status, 426);
    }
  } finally { await f.close(); }
});

test("MCP one-shot renewal refusal maps 426 and leaves the process serving", { timeout: 15_000 }, async () => {
  const f = await fixture(undefined, "2020-01-01T00:00:00.000Z");
  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const { result, value } = await f.call("whoami");
      assert.equal(result.isError, true);
      assert.equal(value.code, "upgrade_required");
      assert.equal(value.status, 426);
      assert.equal(value.message, MCP_ERROR_SENTENCES.upgrade_required!.message);
      assert.equal(f.renewals(), attempt, "one exchange per tool call");
    }
  } finally { await f.close(); }
});

test("MCP request IDs replay and an ambiguous send reports unknown", { timeout: 15_000 }, async () => {
  const f = await fixture();
  try {
    const args = { body: "one intent", request_id: "sameid01" };
    assert.equal((await f.call("note", args)).value.signal_id, ID);
    assert.equal((await f.call("note", args)).value.signal_id, ID);
    assert.equal(new Set(f.posts.map(row => row.command_id)).size, 1);
    f.loseNextAnswer();
    const unknown = (await f.call("note", { body: "second intent", request_id: "sameid02" })).value;
    assert.deepEqual(unknown, { outcome: "unknown", retry_with_same_request_id: true });
    assert.equal(f.created(), 2, "the lost answer followed one committed signal");
    assert.equal((await f.call("note", { body: "second intent", request_id: "sameid02" })).value.signal_id, ID);
    assert.equal(f.created(), 2, "the retry replays the committed signal");
    const beforeLocalConflict = f.posts.length;
    await f.call("note", { body: "changed", request_id: "sameid01" });
    assert.equal(f.posts.length, beforeLocalConflict + 1, "the command edge decides same-id conflicts");
    f.conflictNext();
    const before = f.posts.length;
    const serverConflict = await f.call("note", { body: "server conflict", request_id: "sameid03" });
    assert.equal(serverConflict.result.isError, true);
    assert.equal(serverConflict.value.status, 409);
    assert.equal(serverConflict.value.code, "command_id_conflict");
    assert.equal(f.posts.length, before + 1, "a 409 must not mint another command ID");
  } finally { await f.close(); }
});

test("MCP check preview has a cached full-text tool and advances after the response", { timeout: 15_000 }, async () => {
  const fullBody = "Message " + "x".repeat(1_200);
  const f = await fixture(fullBody);
  try {
    const first = (await f.call("check")).value;
    assert.equal(first.messages[0].truncated, true);
    assert.deepEqual(first.messages[0].full_text_tool, { name: "check", arguments: { message_id: ID } });
    assert.equal(first.messages[0].body.length, 1_000);
    assert.equal((await f.call("check", { message_id: ID })).value.messages[0].body, fullBody);
    assert.deepEqual((await f.call("check")).value.messages, []);
    assert.deepEqual(capMcpResult({ body: "x".repeat(MCP_RESULT_MAX_BYTES) }), {
      truncated: true, message: "Result exceeds the MCP byte cap. Narrow the request." });
  } finally { await f.close(); }
});

test("MCP cancellation sends no result and same-id retry reaches the edge", { timeout: 15_000 }, async () => {
  const f = await fixture();
  try {
    const send = f.transport.send.bind(f.transport);
    let cancelledId: string | number | undefined;
    f.transport.send = async message => {
      if ("method" in message && message.method === "tools/call" &&
          (message.params as { name?: string } | undefined)?.name === "note" && "id" in message) {
        cancelledId = message.id;
      }
      await send(message);
    };
    f.delayNextAnswer();
    const abort = new AbortController();
    const call = f.client.callTool({ name: "note", arguments: { body: "cancelled intent", request_id: "cancel01" } }, undefined, { signal: abort.signal });
    const until = Date.now() + 5_000;
    while (f.posts.length === 0 && Date.now() < until) await new Promise(done => setTimeout(done, 5));
    assert.equal(f.posts.length, 1);
    abort.abort();
    await assert.rejects(call);
    await new Promise(done => setTimeout(done, 300));
    const messages = f.stdout().trim().split("\n").map(line => JSON.parse(line));
    assert.notEqual(cancelledId, undefined);
    assert.ok(!messages.some(row => row.id === cancelledId && (Object.hasOwn(row, "result") || Object.hasOwn(row, "error"))),
      "the server sent no response for the cancelled JSON-RPC ID");
    await f.call("note", { body: "cancelled intent", request_id: "cancel01" });
    assert.equal(f.posts.filter(row => row.command_id === "cancel01").length, 2);
    assert.equal(new Set(f.posts.map(row => row.command_id)).size, 1);
  } finally { await f.close(); }
});

test("MCP errors come from the owned table and producer codes stay covered", { timeout: 20_000 }, async () => {
  const config = ts.readConfigFile("tsconfig.tests.json", ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ".");
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const server = program.getSourceFile(resolve("src/mcp/server.ts"))!;
  const paths = new Set([server.fileName]);
  for (const statement of server.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const resolved = ts.resolveModuleName(statement.moduleSpecifier.text, server.fileName, parsed.options, ts.sys).resolvedModule;
    if (resolved?.resolvedFileName) paths.add(resolved.resolvedFileName);
  }
  const codes = new Set<string>();
  for (const path of paths) {
    const source = program.getSourceFile(path);
    if (!source) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isNewExpression(node) && node.expression.getText(source) === "AgentSetupError" &&
          node.arguments?.[0] && ts.isStringLiteral(node.arguments[0])) codes.add(node.arguments[0].text);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  assert.ok(codes.size >= 15);
  for (const code of codes) assert.ok(MCP_ERROR_SENTENCES[code], `missing MCP sentence for ${code}`);
  // These exported unions and the revocation set are consumed by renewal
  // enforcement. Derive coverage from their declarations, not copied filenames.
  const unionCodes = (name: string): string[] => {
    for (const source of program.getSourceFiles()) {
      for (const statement of source.statements) {
        if (!ts.isTypeAliasDeclaration(statement) || statement.name.text !== name || !ts.isUnionTypeNode(statement.type)) continue;
        return statement.type.types.filter(ts.isLiteralTypeNode)
          .map(node => node.literal).filter(ts.isStringLiteral).map(node => node.text);
      }
    }
    throw new Error(`Missing exported code union ${name}`);
  };
  const renewalCodes = unionCodes("RenewalRejectionReason");
  assert.ok(renewalCodes.length >= 20);
  for (const code of [...renewalCodes, ...REVOCATION_REASONS_LIST]) {
    assert.ok(MCP_ERROR_SENTENCES[code], `missing renewal sentence for ${code}`);
  }
  const renewalSource = program.getSourceFiles().find(source => source.statements.some(statement =>
    ts.isClassDeclaration(statement) && statement.name?.text === "RenewalRevoked"));
  assert.ok(renewalSource);
  const localRenewalCodes = new Set<string>();
  const visitRenewal = (node: ts.Node): void => {
    if (ts.isNewExpression(node)) {
      const name = node.expression.getText(renewalSource);
      const codeArg = name === "RenewalRefused" ? node.arguments?.[1] : name === "RenewalRevoked" ? node.arguments?.[0] : undefined;
      if (codeArg && ts.isStringLiteral(codeArg)) localRenewalCodes.add(codeArg.text);
    }
    ts.forEachChild(node, visitRenewal);
  };
  visitRenewal(renewalSource);
  assert.ok(localRenewalCodes.size >= 8);
  for (const code of localRenewalCodes) assert.ok(MCP_ERROR_SENTENCES[code], `missing local renewal sentence for ${code}`);
  for (const code of unionCodes("SessionContextErrorCode")) {
    assert.equal(mapMcpError(new SessionContextError(code as ConstructorParameters<typeof SessionContextError>[0], "hidden" )).code, "session_context_invalid");
  }
  assert.equal(AGENT_SESSION_PROOF_REFUSAL_CODES.length, 4);
  for (const code of AGENT_SESSION_PROOF_REFUSAL_CODES) {
    assert.ok(MCP_ERROR_SENTENCES[code], `missing session sentence for ${code}`);
    assert.equal(MCP_ERROR_SENTENCES[code]!.next_step, "restart this MCP server with the current host session");
  }
  for (const [code, sentence] of Object.entries(MCP_ERROR_SENTENCES)) {
    assert.doesNotMatch(sentence.message, /cswarm|--[a-z]|\/|\\/i, code);
    assert.doesNotMatch(sentence.next_step, /cswarm|--[a-z]|\/|\\/i, code);
  }
  const f = await fixture();
  try {
    const assertOwned = (value: Record<string, any>) => {
      assert.equal(value.message, MCP_ERROR_SENTENCES[value.code]?.message);
      assert.equal(value.next_step, MCP_ERROR_SENTENCES[value.code]?.next_step);
      assert.doesNotMatch(value.message, /cswarm|--[a-z]|\/|\\/i);
    };
    f.refuseReads(true);
    for (const name of ["whoami", "members", "check"]) assertOwned((await f.call(name)).value);
    f.refuseReads(false);
    assertOwned((await f.call("ask", { body: "hello", to: "Nobody", request_id: "unknown01" })).value);
    f.setAmbiguousRecipient(true);
    const ambiguous = (await f.call("ask", { body: "hello", to: "Owner", request_id: "unknown02" })).value;
    assert.equal(ambiguous.code, "recipient_ambiguous"); assertOwned(ambiguous);
    f.setAmbiguousRecipient(false);
    f.refuseSends(true);
    assertOwned((await f.call("note", { body: "hello", request_id: "unknown03" })).value);
    const unknownCode = mapMcpError(new CommandHttpError(418, "producer shell command", "new_code"));
    assert.equal(unknownCode.message, "The service returned new_code with status 418.");
    assert.equal(unknownCode.status, 418);
    assert.equal(unknownCode.next_step, "check the arguments; if the problem stays, ask a person");
    assert.equal(mapMcpError(new CommandHttpError(418, "producer shell command", "new-code")).message,
      "The service returned new-code with status 418.");
    assert.equal(mapMcpError(new CommandHttpError(418, "producer shell command", "constructor")).message,
      "The service returned constructor with status 418.");
    assert.equal(mapMcpError(new AgentSetupError("profile_missing", "cswarm setup --profile /private")).message, MCP_ERROR_SENTENCES.profile_missing!.message);
  } finally { await f.close(); }
});

test("MCP stdio edge refusal codes give exact post and read next steps", { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    const writeCases = [
      [403, "forbidden", "The service refused this post. Possible causes: a reply to your own ask; a reply to a signal that has expired or is not addressed to this agent; a recipient that is no longer active; a change to this agent's access.", "check the named arguments; if they are right, a person may need to restore this agent's access"],
      [404, "channel_not_found", "The channel argument names no channel in this workspace.", "fix the named argument"],
      [409, "channel_archived", "The channel argument names an archived channel.", "fix the named argument"],
      [400, "invalid_request", "The service did not accept the named arguments.", "fix the named argument"],
      [413, "payload_too_large", "The body or about argument is too large.", "fix the named argument"],
      [429, "rate_limited", "The signal rate limit for this agent or its workspace was reached; it resets within an hour.", "wait, then retry the same call with the same request_id"],
      [418, "new_code", "The service returned new_code with status 418.", "check the arguments; if the problem stays, ask a person"],
    ] as const;
    let index = 0;
    for (const [status, code, message, next_step] of writeCases) {
      f.setSendError({ status, code });
      const name = status === 403 ? ["ask", "note", "reply", "working_on"] : ["note"];
      for (const tool of name) {
        const request_id = `edge${String(++index).padStart(4, "0")}`;
        const args = tool === "reply" ? { signal_id: ID, body: "reply", request_id }
          : tool === "ask" ? { to: "Owner", body: "ask", request_id }
          : { body: "note", request_id, ...(code.startsWith("channel_") ? { channel: "team-updates" } : {}) };
        const { result, value } = await f.call(tool, args);
        assert.equal(result.isError, true);
        assert.deepEqual(value, { code, message, next_step, status });
      }
    }
    for (const code of AGENT_SESSION_PROOF_REFUSAL_CODES) {
      const status = agentSessionErrorStatus(code);
      f.setSendError({ status, code });
      const { result, value } = await f.call("note", { body: "note", request_id: `session${++index}` });
      assert.equal(result.isError, true);
      assert.deepEqual(value, { code, message: "The current host session was refused by the service.",
        next_step: "restart this MCP server with the current host session", status });
    }
    f.setSendError(null);
    for (const [status, code] of [[401, "unauthenticated"], [403, "forbidden"], [426, "upgrade_required"]] as const) {
      f.setReadError({ status, code });
      const { result, value } = await f.call("members");
      assert.equal(result.isError, true);
      assert.deepEqual(value, { code: "read_refused", message: "The service refused this read.",
        next_step: "a person must restore this agent's access outside this session", status });
    }
    for (const code of AGENT_SESSION_PROOF_REFUSAL_CODES) {
      const status = agentSessionErrorStatus(code);
      f.setReadError({ status, code });
      const { result, value } = await f.call("members");
      assert.equal(result.isError, true);
      assert.deepEqual(value, { code, message: "The current host session was refused by the service.",
        next_step: "restart this MCP server with the current host session", status });
    }
  } finally { await f.close(); }
});

test("MCP typed producer classes have owned sentences and truthful status", { timeout: 5_000 }, () => {
  const producers: Array<[Error, string]> = [
    [new RenewalUnsupported("cswarm --bad /path"), "renewal_unsupported"],
    [new RenewalSuperseded("cswarm --bad /path"), "renewal_superseded"],
    [new RenewalOutcomeUnknown("cswarm --bad /path"), "renewal_outcome_unknown"],
    [new RenewalCredentialCheckError(401, "unauthenticated"), "renewal_credential_check"],
    [new RenewalRetryError(null), "renewal_retry"],
    [new RenewalRefused(200, "renewal_device_mismatch", "cswarm --bad /path"), "renewal_device_mismatch"],
    [new RenewalRevoked("predecessor_superseded", "cswarm --bad /path"), "predecessor_superseded"],
    [new RenewalRevoked("forbidden", "cswarm --bad /path"), "renewal_forbidden"],
    [new RenewalRevoked("successor_not_recoverable", "cswarm --bad /path"), "successor_not_recoverable"],
    [new RenewalRefused(200, "malformed_successor", "cswarm --bad /path"), "malformed_successor"],
    [new SignalRecipientError("recipient_unknown", "cswarm --bad /path"), "recipient_unknown"],
    [new SignalMalformedError("cswarm --bad /path"), "read_malformed"],
    [new SignalTransportError("cswarm --bad /path"), "read_transport"],
    [new LocalCredentialSecretAbsentError("cswarm --bad /path"), "local_credential_absent"],
    [new FileLockTimeoutError("credential"), "file_lock_timeout"],
    [new StoredRecordOversizedError(), "stored_record_oversized"],
    [new SessionContextError("session_context_corrupt", "cswarm --bad /path"), "session_context_invalid"],
  ];
  for (const [error, code] of producers) {
    const mapped = mapMcpError(error);
    assert.equal(mapped.code, code);
    assert.equal(mapped.message, MCP_ERROR_SENTENCES[code]!.message);
    assert.equal(mapped.next_step, MCP_ERROR_SENTENCES[code]!.next_step);
    assert.doesNotMatch(mapped.message, /cswarm|--[a-z]|\/|\\/i);
  }
  assert.equal(mapMcpError(new RenewalCredentialCheckError(401, "unauthenticated")).status, 401);
  assert.equal(mapMcpError(new RenewalRefused(200, "renewal_device_mismatch", "bad")).status, undefined);
  assert.equal(mapMcpError(new RenewalRevoked("predecessor_superseded", "bad")).next_step, "retry the same call");
  assert.equal(mapMcpError(new RenewalRevoked("forbidden", "bad")).next_step, "a person must restore this agent's access outside this session");
  assert.equal(mapMcpError(new RenewalRefused(200, "malformed_successor", "bad")).next_step, "retry the same call");
});

test("MCP malformed accepted response is unknown after the signal was created", { timeout: 15_000 }, async () => {
  const f = await fixture();
  try {
    f.malformedNextAnswer();
    const args = { body: "one intent", request_id: "malformed01" };
    assert.deepEqual((await f.call("note", args)).value, { outcome: "unknown", retry_with_same_request_id: true });
    assert.equal(f.created(), 1);
    assert.equal((await f.call("note", args)).value.signal_id, ID);
    assert.equal(f.created(), 1);
  } finally { await f.close(); }
});

test("MCP stdio renewal classes use owned sentences without successful HTTP status", { timeout: 15_000 }, async () => {
  const f = await fixture(undefined, "2020-01-01T00:00:00.000Z");
  try {
    for (const [reason, code] of [
      ["renewal_grant_suspended", "renewal_grant_suspended"],
      ["renewal_horizon_reached", "horizon_reached"],
      ["renewal_lineage_revoked", "renewal_lineage_revoked"],
      ["renewal_device_unavailable", "renewal_device_unavailable"],
    ]) {
      f.setRenewalReason(reason!);
      const { result, value } = await f.call("whoami");
      assert.equal(result.isError, true);
      assert.equal(value.code, code);
      assert.equal(value.message, MCP_ERROR_SENTENCES[code!]!.message);
      assert.equal(value.next_step, "a person must restore this agent's access outside this session");
      assert.ok(!Object.hasOwn(value, "status"), "domain refusal with HTTP 200 has no error status");
    }
  } finally { await f.close(); }
});

test("MCP stdio local profile, credential and malformed read errors use owned sentences", { timeout: 15_000 }, async () => {
  const profile = await fixture();
  try {
    await unlink(profile.profile);
    const value = (await profile.call("check")).value;
    assert.equal(value.code, "profile_missing");
    assert.equal(value.message, MCP_ERROR_SENTENCES.profile_missing!.message);
  } finally { await profile.close(); }
  const credential = await fixture();
  try {
    await writeFile(join(credential.root, "profile", "credential.json"), "{}", { mode: 0o600 });
    const value = (await credential.call("whoami")).value;
    assert.equal(value.code, "agent_credential_missing_agent_token");
    assert.equal(value.message, MCP_ERROR_SENTENCES.agent_credential_missing_agent_token!.message);
  } finally { await credential.close(); }
  const read = await fixture();
  try {
    read.setMalformedRead(true);
    const value = (await read.call("members")).value;
    assert.equal(value.code, "read_malformed");
    assert.equal(value.message, MCP_ERROR_SENTENCES.read_malformed!.message);
  } finally { await read.close(); }
});

test("MCP fresh check cap leaves unseen messages eligible for the next check", { timeout: 15_000 }, async () => {
  const f = await fixture();
  try {
    f.setWorkspaceName("w".repeat(MCP_RESULT_MAX_BYTES));
    const capped = (await f.call("check")).value;
    assert.equal(capped.truncated, true);
    f.setWorkspaceName("Test workspace");
    assert.equal((await f.call("check")).value.messages[0].id, ID);
    const largest = capFreshCheck({ checked: true, cached: false, workspace_id: WS, workspace_name: "w".repeat(80),
      messages: Array.from({ length: AGENT_CHECK_PAGE_SIZE }, (_, index) => ({ id: `dddddddd-dddd-4ddd-8ddd-${String(index + 1).padStart(12, "0")}`, from: OWNER, from_kind: "user" as const,
        sender_owner_relation: "same_owner", kind: "ask" as const, body: "界".repeat(AGENT_CHECK_BODY_BUDGET / AGENT_CHECK_PAGE_SIZE),
        truncated: false, attachment_count: 0, created_at: `2026-09-23T00:00:${String(index).padStart(2, "0")}.000Z` })),
      has_more: true, next_action: null });
    assert.ok(Buffer.byteLength(JSON.stringify(largest.output)) <= MCP_RESULT_MAX_BYTES);
    assert.equal(largest.lastVisibleId, `dddddddd-dddd-4ddd-8ddd-${String(AGENT_CHECK_PAGE_SIZE).padStart(12, "0")}`,
      "the largest supported page must fit without dropping a message");
  } finally { await f.close(); }
});

test("MCP partial check commits only the last visible message", { timeout: 15_000 }, async () => {
  const f = await fixture();
  try {
    const ids = Array.from({ length: 6 }, (_, index) => `dddddddd-dddd-4ddd-8ddd-${String(index + 1).padStart(12, "0")}`);
    f.setIncoming(ids.map((id, index) => signal(`message ${index} ${"x".repeat(100)}`, "ask", id)));
    const priorState = process.env.SWARM_AGENT_STATE_DIR;
    const priorConfig = process.env.XDG_CONFIG_HOME;
    process.env.SWARM_AGENT_STATE_DIR = join(f.root, "renewal");
    process.env.XDG_CONFIG_HOME = join(f.root, "config");
    try {
      const libraryPage = await checkAgentMessages({ profilePath: f.profile,
        present: async () => undefined, deferCursorCommit: () => undefined });
      assert.deepEqual(libraryPage.messages.map(row => row.id), ids,
        "the check library must return all six rows before the MCP byte cap");
    } finally {
      if (priorState === undefined) delete process.env.SWARM_AGENT_STATE_DIR;
      else process.env.SWARM_AGENT_STATE_DIR = priorState;
      if (priorConfig === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = priorConfig;
    }
    f.setWorkspaceName("w".repeat(31_000));
    const first = (await f.call("check")).value;
    assert.ok(first.messages.length > 0 && first.messages.length < ids.length, "the cap must show a strict prefix");
    assert.equal(first.has_more, true);
    for (let turn = 0; turn < 100 && f.observations.length < first.messages.length; turn++) {
      await f.call("whoami");
      await new Promise(done => setTimeout(done, 10));
    }
    assert.deepEqual(f.observations.map(row => row.command.signal_id),
      first.messages.map((row: { id: string }) => row.id),
      "only the response's visible prefix may be observed");
    f.setWorkspaceName("Test workspace");
    const seen = [...first.messages];
    for (let page = 0; page < ids.length && seen.length < ids.length; page++) {
      const next = (await f.call("check")).value;
      assert.ok(next.messages.length > 0, "each next page must make progress");
      seen.push(...next.messages);
    }
    assert.deepEqual(seen.map((row: { id: string }) => row.id), ids);
    assert.deepEqual((await f.call("check")).value.messages, []);
  } finally { await f.close(); }
});

test("MCP deferred cursor merge preserves a later check and cache rows", { timeout: 15_000 }, async () => {
  const f = await fixture();
  const priorState = process.env.SWARM_AGENT_STATE_DIR;
  const priorConfig = process.env.XDG_CONFIG_HOME;
  process.env.SWARM_AGENT_STATE_DIR = join(f.root, "renewal");
  process.env.XDG_CONFIG_HOME = join(f.root, "config");
  try {
    let lateCommit: ((lastVisibleId?: string) => Promise<void>) | undefined;
    await checkAgentMessages({ profilePath: f.profile, present: async () => undefined,
      deferCursorCommit: commit => { lateCommit = commit; } });
    assert.ok(lateCommit);
    const secondId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    f.setIncoming([signal("first", "ask"), signal("second", "ask", secondId)]);
    await checkAgentMessages({ profilePath: f.profile, present: async () => undefined });
    const path = join(f.root, "profile", "check.json");
    const before = JSON.parse(await readFile(path, "utf8"));
    assert.equal(before.cursor.id, secondId);
    await lateCommit!(ID);
    const after = JSON.parse(await readFile(path, "utf8"));
    assert.equal(after.cursor.id, secondId);
    assert.deepEqual(after.messages.map((row: { id: string }) => row.id), before.messages.map((row: { id: string }) => row.id));
    assert.equal((await cachedAgentMessage(f.profile, secondId)).body, "second");
  } finally {
    if (priorState === undefined) delete process.env.SWARM_AGENT_STATE_DIR;
    else process.env.SWARM_AGENT_STATE_DIR = priorState;
    if (priorConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = priorConfig;
    await f.close();
  }
});

test("MCP deferred commit occurs only after a successful write", { timeout: 5_000 }, async () => {
  const events: string[] = [];
  const commits = new Map<string | number, () => Promise<void>>([[1, async () => { events.push("commit"); }]]);
  let release!: () => void;
  const pending = new Promise<void>(done => { release = done; });
  const write = sendWithDeferredCommit({ id: 1, result: {} }, async () => { events.push("write-start"); await pending; events.push("write-end"); }, commits);
  assert.deepEqual(events, ["write-start"]);
  release(); await write;
  assert.deepEqual(events, ["write-start", "write-end", "commit"]);
  assert.equal(commits.size, 0);
  commits.set(2, async () => { events.push("wrong-commit"); });
  await assert.rejects(sendWithDeferredCommit({ id: 2, result: {} }, async () => { throw new Error("write failed"); }, commits));
  assert.equal(commits.size, 0);
  assert.ok(!events.includes("wrong-commit"));
});

test("MCP check observes directed mail only after its response write", { timeout: 15_000 }, async () => {
  const f = await fixture();
  try {
    assert.equal((await f.call("check")).value.messages[0].id, ID);
    for (let turn = 0; turn < 10 && f.observations.length === 0; turn++) {
      await f.call("whoami");
    }
    assert.equal(f.observations.length, 1);
    assert.equal(f.observations[0]!.command.unclaimed, true);
    assert.ok(f.stdout().includes(ID), "the response was written before the observation request");
    const failedWrite: string[] = [];
    const commits = new Map<string | number, () => Promise<void>>([[1, async () => { failedWrite.push("observed"); }]]);
    await assert.rejects(sendWithDeferredCommit({ id: 1, result: {} }, async () => {
      throw new Error("closed stdout");
    }, commits));
    assert.deepEqual(failedWrite, [], "mutation control: failed output cannot observe");
  } finally { await f.close(); }
});

test("MCP schemas reject invalid durations and use shared request and channel rules", { timeout: 15_000 }, async () => {
  const f = await fixture();
  try {
    const listed = (await f.client.listTools()).tools;
    const note = listed.find(row => row.name === "note")!;
    for (const [args, bad] of [
      [{ body: "hello", request_id: "valid001", until: "31d" }, "until"],
      [{ body: "hello", request_id: "valid002", until: "tomorrow" }, "until"],
      [{ body: "hello", request_id: "tiny", channel: "ok" }, "request_id"],
      [{ body: "hello", request_id: "valid003", channel: "bad space" }, "channel"],
      [{ body: "hello", request_id: "valid004", to: "x".repeat(81) }, "to"],
    ] as const) await assert.rejects(f.client.callTool({ name: "note", arguments: args }), (error: any) => error.code === -32602 && error.message.includes(bad));
    const channelRule = note.inputSchema.properties!.channel as { pattern: string; maxLength: number; not: { enum: string[] } };
    assert.deepEqual(channelRule.not.enum, ["all-signals"]);
    assert.match("all-signals", new RegExp(channelRule.pattern));
    for (const channel of ["TEAM-UPDATES", " team-updates", "team-updates ", "all-signals"]) {
      await assert.rejects(f.client.callTool({ name: "note", arguments: { body: "hello", request_id: "valid005", channel } }),
        (error: any) => error.code === -32602 && error.message.includes("channel"));
    }
    const posted = await f.call("note", { body: "hello", request_id: "valid006", channel: "team-updates" });
    assert.equal(posted.result.isError, undefined);
    assert.equal(f.posts.at(-1)!.command.channel, "team-updates");
    assert.equal((note.inputSchema.properties!.channel as { maxLength: number }).maxLength, 32);
    assert.match(note.description!, /slugs are lowercase/);
  } finally { await f.close(); }
});

test("CLI MCP import is dynamic in the handler", { timeout: 5_000 }, async () => {
  const path = "src/cli.ts";
  const source = ts.createSourceFile(path, await readFile(path, "utf8"), ts.ScriptTarget.Latest, true);
  const staticMcp = source.statements.filter(ts.isImportDeclaration).some(node =>
    ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text.startsWith("./mcp/"));
  assert.equal(staticMcp, false);
  let dynamicMcp = false;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === "./mcp/server.js") dynamicMcp = true;
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.equal(dynamicMcp, true);
});

test("MCP dispatch policy and fold corrections are recorded", { timeout: 5_000 }, async () => {
  const rows = JSON.parse(await readFile("tests/p1-cli/fixtures/command-dispatch-baseline.json", "utf8")) as
    Array<{ id: string; exitCode: number; stderr: string }>;
  for (const [id, code] of [
    // The policy.host-session.mcp.keep and selected-error.mcp.* fixtures stop at positional-argument parsing.
    // mcp.missing-profile, mcp.unreadable-profile, and mcp.manual-host-session reach MCP start-up checks.
    ["mcp.missing-profile", "mcp_start_failed"],
    ["mcp.unreadable-profile", "profile_missing"],
    ["mcp.manual-host-session", "host_session_invalid"],
  ]) {
    const row = rows.find(item => item.id === id);
    assert.ok(row, id);
    assert.equal(row.exitCode, 1);
    assert.ok(row.stderr.includes(code));
  }
  const brief = await readFile("docs/design/2026-09-23-MCP-LANE-2-BRIEF.md", "utf8");
  assert.equal(brief.split("Correction (fold 1, 2026-09-23)").length - 1, 2);
  assert.match(brief, /`replayed` is removed/);
  assert.match(brief, /a cancelled call gets no/);
  const lane = await readFile("docs/evidence/2026-09-23-mcp-lane2/LANE.md", "utf8");
  assert.match(lane, /"cancellation after send start puts unknown on the stdio wire" \(superseded by Fold 1:/);
  assert.match(lane, /R9 \|[^\n]*without normalization; the 80-character recipient selector bound is MCP-schema only/);
});
