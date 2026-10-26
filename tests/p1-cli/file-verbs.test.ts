import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  absoluteStorageUrl,
  allowedExtensionList,
  contentTypeForName,
  FILE_CONTENT_WARNING,
  FileTransportError,
  listFilesAsAgent,
  LocalFileExists,
  writeDestination,
} from "../../src/cloud/files.js";
import { cloudTarget } from "../../src/cloud/config.js";
import { AGENT_CREDENTIAL_MESSAGE_D088 } from "../../src/cloud/agent-credential-input.js";

const TARGET = cloudTarget("https://example.supabase.co", "anon-key");

function fakeFetcher(
  handler: (input: string | URL | Request, init?: RequestInit) => Response,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) =>
    handler(input, init)) as typeof fetch;
}

/* ------------------------------------------------------------------ pure -- */

test("content types map the §5 allowlist and refuse everything else", () => {
  assert.equal(contentTypeForName("plan.md"), "text/markdown");
  assert.equal(contentTypeForName("Plan.MD"), "text/markdown");
  // Longest suffix wins: .tar.gz is gzip, never a bare ".gz" guess.
  assert.equal(contentTypeForName("bundle.tar.gz"), "application/gzip");
  assert.equal(
    contentTypeForName("report.docx"),
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  // .html/.htm are allowed (Fastio feedback): served as attachment, never inline.
  assert.equal(contentTypeForName("index.html"), "text/html");
  assert.equal(contentTypeForName("page.HTM"), "text/html");
  // Closed default: an unknown extension returns null rather than a guess.
  // A control that .exe stays refused proves the map did not go permissive.
  assert.equal(contentTypeForName("tool.exe"), null);
  assert.equal(contentTypeForName("no-extension"), null);
  assert.equal(contentTypeForName(""), null);
  assert.match(allowedExtensionList(), /\.md/);
});

test("writeDestination is atomic: wx without --force, EEXIST becomes the refusal", () => {
  const calls: Array<{ path: string; flag: string }> = [];
  const writer = (path: string, _bytes: Uint8Array, options: { flag: string }) => {
    calls.push({ path, flag: options.flag });
    if (options.flag === "wx" && path === "taken.md") {
      const error = new Error("EEXIST") as NodeJS.ErrnoException;
      error.code = "EEXIST";
      throw error;
    }
  };
  // The flag IS the guard: pin it so a check-then-write regression cannot pass.
  writeDestination("fresh.md", new Uint8Array(), false, writer);
  assert.equal(calls.at(-1)?.flag, "wx");
  writeDestination("taken.md", new Uint8Array(), true, writer);
  assert.equal(calls.at(-1)?.flag, "w");
  assert.throws(
    () => writeDestination("taken.md", new Uint8Array(), false, writer),
    (error: unknown) =>
      error instanceof LocalFileExists && /--force/.test(error.message),
  );
  // A non-EEXIST writer failure surfaces as itself, not as the refusal.
  const broken = () => {
    const error = new Error("EACCES") as NodeJS.ErrnoException;
    error.code = "EACCES";
    throw error;
  };
  assert.throws(
    () => writeDestination("x.md", new Uint8Array(), false, broken),
    /EACCES/,
  );
});

test("absoluteStorageUrl composes only server-relative paths", () => {
  assert.equal(
    absoluteStorageUrl(TARGET, "/storage/v1/object/x"),
    "https://example.supabase.co/storage/v1/object/x",
  );
  assert.throws(
    () => absoluteStorageUrl(TARGET, "https://attacker.example/steal"),
    FileTransportError,
  );
});

test("the agent list posts the exact read shape and rejects malformed bodies", async () => {
  let captured: Record<string, unknown> | null = null;
  const good = fakeFetcher((_input, init) => {
    captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        files: [],
        sha256_note: "unverified client attestation",
        content_warning: FILE_CONTENT_WARNING,
      }),
      { status: 200 },
    );
  });
  const rows = await listFilesAsAgent(
    TARGET,
    "swm_agt_x",
    "3ab184b3-fbb4-5ee9-afad-3842a604439a",
    good,
  );
  assert.deepEqual(rows, []);
  assert.deepEqual(captured, {
    resource: "files",
    workspace_id: "3ab184b3-fbb4-5ee9-afad-3842a604439a",
  });
  const malformed = fakeFetcher(() =>
    new Response(JSON.stringify({ nonsense: true }), { status: 200 })
  );
  await assert.rejects(
    listFilesAsAgent(
      TARGET,
      "swm_agt_x",
      "3ab184b3-fbb4-5ee9-afad-3842a604439a",
      malformed,
    ),
    FileTransportError,
  );
});

/* ------------------------------------------------- fake cloud + real CLI -- */

const WORKSPACE = "3ab184b3-fbb4-5ee9-afad-3842a604439a";
const KNOWN_FILE_ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const AGENT_TOKEN = `swm_agt_${"a".repeat(43)}`;
const DOWNLOAD_BYTES = "downloaded-bytes-from-the-fake-cloud";
const RESTORABLE_UNTIL = "2026-09-17 12:00:00+00";

interface RecordedCommand {
  command_id: string;
  command: Record<string, unknown>;
}

interface FakeCloud {
  url: string;
  commands: RecordedCommand[];
  storagePuts: Array<{ path: string; bytes: Buffer }>;
  reads: number;
  failFirstCreate: boolean;
  createRefusal?: { status: number; body: Record<string, unknown> };
  server: Server;
  close(): Promise<void>;
}

async function startFakeCloud(): Promise<FakeCloud> {
  const state: FakeCloud = {
    url: "",
    commands: [],
    storagePuts: [],
    reads: 0,
    failFirstCreate: false,
    server: undefined as unknown as Server,
    close: async () => {},
  };
  /* Mimics the S1+S2 command-id replay: the same id returns the stored
   * response, which is exactly what makes the CLI's same-id retry safe. */
  const stored = new Map<string, { status: number; body: unknown }>();
  let createAttempts = 0;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks);
      const url = request.url ?? "";
      if (request.method === "PUT" && url.startsWith("/storage/")) {
        if (state.storagePuts.some(put => put.path === url)) {
          response.writeHead(409, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "Duplicate" }));
          return;
        }
        state.storagePuts.push({ path: url, bytes: raw });
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
        return;
      }
      if (request.method === "GET" && url.startsWith("/storage/")) {
        response.writeHead(200, { "content-type": "text/markdown" });
        response.end(DOWNLOAD_BYTES);
        return;
      }
      if (request.method === "POST" && url === "/functions/v1/read") {
        state.reads += 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          files: [{
            file_id: KNOWN_FILE_ID,
            name: "plan.md",
            current_version: 1,
            size_bytes: "18",
            content_type: "text/markdown",
            sha256: null,
            created_by_kind: "agent",
            created_by: randomUUID(),
            uploaded_by_kind: "agent",
            uploaded_by: randomUUID(),
            created_at: "2026-08-18T00:00:00Z",
            committed_at: "2026-08-18T00:00:00Z",
            tombstoned_at: null,
          }],
          sha256_note: "unverified client attestation",
          content_warning: FILE_CONTENT_WARNING,
        }));
        return;
      }
      if (request.method === "POST" && url === "/functions/v1/command") {
        const body = JSON.parse(raw.toString()) as {
          command_id: string;
          command: Record<string, unknown>;
        };
        state.commands.push({ command_id: body.command_id, command: body.command });
        const kind = String(body.command.kind);
        if (kind === "file_version_create") {
          createAttempts += 1;
          if (state.failFirstCreate && createAttempts === 1) {
            // The unknown-outcome class: the socket dies before any response.
            request.socket.destroy();
            return;
          }
          if (state.createRefusal) {
            response.writeHead(state.createRefusal.status, { "content-type": "application/json" });
            response.end(JSON.stringify(state.createRefusal.body));
            return;
          }
        }
        const replay = stored.get(body.command_id);
        if (replay !== undefined) {
          response.writeHead(replay.status, { "content-type": "application/json" });
          response.end(JSON.stringify(replay.body));
          return;
        }
        const fileId = String(body.command.file_id ?? KNOWN_FILE_ID);
        let out: Record<string, unknown>;
        if (kind === "file_version_create") {
          out = {
            ok: true,
            status: "accepted",
            file_id: fileId,
            version_id: body.command.version_id,
            version_n: 1,
            name: body.command.name,
            upload_path:
              `/storage/v1/object/upload/sign/swarm-files/${WORKSPACE}/${fileId}/1?token=fake`,
            upload_token: null,
            upload_expires_in_seconds: 7200,
          };
        } else if (kind === "file_version_commit") {
          out = {
            ok: true,
            status: "accepted",
            file_id: fileId,
            version_id: body.command.version_id,
            version_n: 1,
            name: "plan.md",
            size_bytes: state.storagePuts.at(-1)?.bytes.byteLength ?? 0,
            sha256: body.command.sha256,
            sha256_note: "unverified client attestation",
            reference: `file:${fileId}@v1`,
          };
        } else if (kind === "file_download_url") {
          out = {
            ok: true,
            status: "accepted",
            file_id: fileId,
            version_n: body.command.version_n ?? 1,
            name: "plan.md",
            size_bytes: DOWNLOAD_BYTES.length,
            content_type: "text/markdown",
            download_path: "/storage/v1/object/sign/swarm-files/dl?token=fake",
            download_url_expires_in_seconds: 300,
            content_warning: FILE_CONTENT_WARNING,
          };
        } else if (kind === "file_tombstone") {
          out = {
            ok: true,
            status: "accepted",
            file_id: fileId,
            name: "plan.md",
            restorable_until: RESTORABLE_UNTIL,
            note:
              "Restorable with file_restore until the date above; existing download URLs expire on their own 5-minute clock.",
          };
        } else if (kind === "file_restore") {
          out = {
            ok: true,
            status: "accepted",
            file_id: fileId,
            name: "plan.md",
            restored: true,
          };
        } else {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "invalid_request" }));
          return;
        }
        stored.set(body.command_id, { status: 200, body: out });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(out));
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not_found" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fake cloud failed to bind");
  }
  state.url = `http://127.0.0.1:${address.port}`;
  state.server = server;
  state.close = () =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())
    );
  return state;
}

const scratch = mkdtempSync(join(tmpdir(), "cswarm-file-verbs-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

async function cliAgainst(
  cloud: FakeCloud,
  args: string[],
  bareRequestId = false,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [
    "--import",
    "tsx",
    "src/cli.ts",
    ...args,
    "--url",
    cloud.url,
    "--anon-key",
    "test-anon",
    "--workspace-id",
    WORKSPACE,
    "--agent-token-stdin",
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: scratch,
      XDG_CONFIG_HOME: join(scratch, "config"),
      SWARM_AGENT_STATE_DIR: join(scratch, "agent-state"),
      SWARM_CLOUD_URL: "",
      SWARM_CLOUD_ANON_KEY: "",
      SWARM_CLOUD_WORKSPACE_ID: "",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(args.includes("--request-id") && !bareRequestId ? JSON.stringify({
    message: AGENT_CREDENTIAL_MESSAGE_D088, status: "accepted",
    principal_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    token_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    run_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    agent_token: AGENT_TOKEN, expires_at: "2099-01-01T00:00:00.000Z",
  }) : AGENT_TOKEN);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => stdout += chunk);
  child.stderr.on("data", (chunk: string) => stderr += chunk);
  const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status) => resolve(status ?? 1));
  }).finally(() => clearTimeout(timer));
  return { code, stdout, stderr };
}

test("file put --request-id replays across CLI processes and conflicts before create", { timeout: 20_000 }, async () => {
  const cloud = await startFakeCloud();
  try {
    const localPath = join(scratch, "exact-cli.md");
    writeFileSync(localPath, "# first\n");
    const args = ["file", "put", localPath, "--request-id", "cli-exact-01", "--json"];
    const first = await cliAgainst(cloud, args);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(JSON.parse(first.stdout).outcome, "committed");
    assert.equal(JSON.parse(first.stdout).conflict_check, "unavailable");
    const second = await cliAgainst(cloud, args);
    assert.equal(second.code, 0, second.stderr);
    assert.equal(JSON.parse(second.stdout).outcome, "replayed");
    assert.equal(JSON.parse(second.stdout).conflict_check, "available");
    assert.equal(cloud.storagePuts.length, 1);
    const commands = cloud.commands.length;
    writeFileSync(localPath, "# changed\n");
    const conflict = await cliAgainst(cloud, args);
    assert.notEqual(conflict.code, 0);
    assert.equal(JSON.parse(conflict.stdout).code, "request_id_conflict");
    assert.equal(conflict.stderr, "");
    assert.equal(cloud.commands.length, commands);
  } finally { await cloud.close(); }
});

test("request-id refuses a legacy bare agent token without a stable principal", { timeout: 10000 }, async () => {
  const cloud = await startFakeCloud();
  try {
    const path = join(scratch, "bare-refusal.md");
    writeFileSync(path, "# bare\n");
    const result = await cliAgainst(cloud, ["file", "put", path, "--request-id", "bare-token-01"], true);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /minted agent credential with a principal id/);
    assert.equal(cloud.commands.length, 0);
  } finally { await cloud.close(); }
});

test("an unknown-outcome create is retried with the SAME ids and replays safely", async () => {
  const cloud = await startFakeCloud();
  cloud.failFirstCreate = true;
  try {
    const localPath = join(scratch, "retry.md");
    writeFileSync(localPath, "retry me");
    const result = await cliAgainst(cloud, ["file", "put", localPath]);
    assert.equal(result.code, 0, result.stderr);
    const creates = cloud.commands.filter(
      (entry) => entry.command.kind === "file_version_create",
    );
    assert.equal(creates.length, 2, "the no-response attempt was retried once");
    // Finding 2a: the retry reuses every id, so the server replay — not a
    // second version — resolves the unknown outcome.
    assert.equal(creates[0]!.command_id, creates[1]!.command_id);
    assert.equal(creates[0]!.command.file_id, creates[1]!.command.file_id);
    assert.equal(creates[0]!.command.version_id, creates[1]!.command.version_id);
    const commits = cloud.commands.filter(
      (entry) => entry.command.kind === "file_version_commit",
    );
    assert.equal(commits.length, 1);
  } finally {
    await cloud.close();
  }
});

test("file get resolves a name, downloads, and refuses to overwrite atomically", async () => {
  const cloud = await startFakeCloud();
  try {
    const out = join(scratch, "kept.md");
    writeFileSync(out, "KEEP");
    const refused = await cliAgainst(
      cloud,
      ["file", "get", "plan.md", "--out", out],
    );
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /--force/);
    // Finding 1: the original bytes survive the refusal — nothing truncated.
    assert.equal(readFileSync(out, "utf8"), "KEEP");
    // The name selector resolved through the read to the known file id.
    const download = cloud.commands.find(
      (entry) => entry.command.kind === "file_download_url",
    );
    assert.ok(download, "download url was requested");
    assert.equal(download!.command.file_id, KNOWN_FILE_ID);
    assert.ok(cloud.reads >= 1, "the name resolved through the files read");

    const forced = await cliAgainst(
      cloud,
      ["file", "get", "plan.md", "--out", out, "--force"],
    );
    assert.equal(forced.code, 0, forced.stderr);
    assert.equal(readFileSync(out, "utf8"), DOWNLOAD_BYTES);
    assert.match(forced.stdout, /Downloaded plan\.md version 1/);
    assert.match(forced.stdout, new RegExp(FILE_CONTENT_WARNING.slice(0, 30)));
  } finally {
    await cloud.close();
  }
});

/* -------------------------------------------------------- spawned usage -- */
