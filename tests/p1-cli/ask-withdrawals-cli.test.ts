/**
 * End-to-end CLI tests for `cswarm ask withdraw`, `cswarm ask --supersedes`,
 * and `cswarm ask open` against a mocked edge server.
 * Unit tests for parsing, MCP schemas, and formatting live in tests/ask-withdrawals.test.ts.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { AGENT_CREDENTIAL_MESSAGE_D088 } from "../../src/cloud/agent-credential-input.js";
import { parseAgentConnection, saveAgentProfile } from "../../src/cloud/agent-profile.js";

const WS_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const OWNER_ID = "33333333-3333-4333-8333-333333333333";
const ASK_ID = "44444444-4444-4444-8444-444444444444";
const NEW_ASK_ID = "55555555-5555-4555-8555-555555555555";
const TOKEN = `swm_agt_${"W".repeat(43)}`;
const CLI = process.env.CSWARM_TEST_CLI ?? resolve("dist/cli.js");

function runCli(root: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: root,
        XDG_CONFIG_HOME: join(root, "config"),
        XDG_STATE_HOME: join(root, "state"),
        SWARM_AGENT_STATE_DIR: join(root, "agent-state"),
        SWARM_CLOUD_URL: "",
        SWARM_CLOUD_ANON_KEY: "",
        SWARM_CLOUD_WORKSPACE_ID: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code: code ?? -1, stdout, stderr });
    });
  });
}

test("CLI ask withdraw, ask --supersedes, and ask open work end-to-end against mocked edge", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-ask-withdraw-cli-"));
  const commands: Array<Record<string, unknown>> = [];
  const reads: Array<Record<string, unknown>> = [];

  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      const send = (status: number, data: unknown) =>
        res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(data));
      if (req.url === "/functions/v1/command") {
        commands.push(body);
        const cmd = body.command as Record<string, unknown>;
        if (cmd.kind === "withdraw_ask") {
          return send(200, {
            ok: true,
            status: "accepted",
            signal_id: cmd.signal_id,
            withdrawn: true,
            created: true,
            withdrawn_at: "2026-11-23T12:00:00Z",
            // Legacy server field must never be printed by CLI ask withdraw --json.
            replaced_by_signal_id: NEW_ASK_ID,
            event_ids: [],
          });
        }
        if (cmd.kind === "post_signal") {
          return send(200, {
            ok: true,
            status: "accepted",
            signal: {
              id: NEW_ASK_ID,
              workspace_id: WS_ID,
              from: AGENT_ID,
              from_kind: "agent",
              to: OWNER_ID,
              to_agent: null,
              in_reply_to: null,
              about: null,
              kind: "ask",
              body: cmd.body,
              created_at: "2026-11-23T12:01:00Z",
              until: "2026-11-30T12:01:00Z",
              channel_id: null,
            },
            ...(typeof cmd.supersedes === "string" ? { superseded_signal_id: cmd.supersedes } : {}),
            event_ids: [],
          });
        }
        return send(400, { error: "unexpected_command" });
      }
      if (req.url === "/functions/v1/read") {
        reads.push(body);
        if (body.resource === "members") {
          return send(200, {
            workspace_id: WS_ID,
            members: [{ user_id: OWNER_ID, display_name: "Alice" }],
            agents: [{ principal_id: AGENT_ID, name: "WithdrawBot", owner_user_id: OWNER_ID }],
          });
        }
        if (body.resource === "my_open_asks") {
          const isTruncated = body.limit === 1;
          return send(200, {
            workspace_id: WS_ID,
            generated_at: "2026-11-23T12:02:00Z",
            total: isTruncated ? 3 : 1,
            truncated: isTruncated,
            asks: [
              {
                signal_id: NEW_ASK_ID,
                created_at: "2026-11-23T12:01:00Z",
                until: "2026-11-30T12:01:00Z",
                addressees: ["Alice"],
                where: "DM",
                body_preview: "Updated question?",
              },
            ],
          });
        }
        return send(400, { error: "unexpected_read" });
      }
      return send(404, { error: "not_found" });
    });
  });

  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const { port } = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${port}`;
  const profilePath = join(root, "profile", "profile.json");

  const saved = {
    HOME: process.env.HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    SWARM_AGENT_STATE_DIR: process.env.SWARM_AGENT_STATE_DIR,
  };
  process.env.HOME = root;
  process.env.XDG_CONFIG_HOME = join(root, "config");
  process.env.XDG_STATE_HOME = join(root, "state");
  process.env.SWARM_AGENT_STATE_DIR = join(root, "agent-state");
  try {
    await saveAgentProfile(
      profilePath,
      parseAgentConnection(
        JSON.stringify({
          version: 1,
          url: baseUrl,
          anon_key: "test-public-key",
          workspace_id: WS_ID,
          principal_id: AGENT_ID,
          credential: {
            message: AGENT_CREDENTIAL_MESSAGE_D088,
            status: "accepted",
            principal_id: AGENT_ID,
            token_id: "11111111-1111-4111-8111-111111111112",
            run_id: "22222222-2222-4222-8222-222222222223",
            agent_token: TOKEN,
            expires_at: "2099-01-01T00:00:00Z",
          },
        }),
      ),
    );

    // 1. cswarm ask withdraw <ask-id> (plain and --json)
    const wdOut = await runCli(root, ["ask", "withdraw", ASK_ID, "--profile", profilePath]);
    assert.equal(wdOut.code, 0, wdOut.stderr);
    assert.match(wdOut.stdout, /Withdrawn ask 44444444-4444-4444-8444-444444444444\./);
    assert.deepEqual(commands.at(-1)?.command, { kind: "withdraw_ask", signal_id: ASK_ID });

    const wdJson = await runCli(root, ["ask", "withdraw", ASK_ID, "--json", "--profile", profilePath]);
    assert.equal(wdJson.code, 0, wdJson.stderr);
    const wdParsed = JSON.parse(wdJson.stdout) as Record<string, unknown>;
    assert.deepEqual(wdParsed, {
      signal_id: ASK_ID,
      withdrawn: true,
      created: true,
      withdrawn_at: "2026-11-23T12:00:00Z",
    });
    assert.equal(Object.hasOwn(wdParsed, "replaced_by_signal_id"), false);

    // 2. cswarm ask --to Alice --supersedes <ask-id> "Updated question?"
    const supOut = await runCli(root, [
      "ask", "--to", "Alice", "--supersedes", ASK_ID, "Updated question?",
      "--profile", profilePath,
    ]);
    assert.equal(supOut.code, 0, supOut.stderr);
    assert.match(supOut.stdout, /Updated question|Sent|55555555-5555-4555-8555-555555555555/);
    assert.equal((commands.at(-1)?.command as Record<string, unknown>).supersedes, ASK_ID);

    // 3. cswarm ask open (table, truncated table, and --json)
    const openTable = await runCli(root, ["ask", "open", "--profile", profilePath]);
    assert.equal(openTable.code, 0, openTable.stderr);
    assert.match(openTable.stdout, /55555555-5555-4555-8555-555555555555/);
    assert.match(openTable.stdout, /Updated question\?/);
    assert.doesNotMatch(openTable.stdout, /Showing /);
    assert.equal(openTable.stdout.trimEnd().split("\n").length, 1);
    assert.doesNotMatch(openTable.stdout, /dismiss/i);

    const openTruncated = await runCli(root, ["ask", "open", "--limit", "1", "--profile", profilePath]);
    assert.equal(openTruncated.code, 0, openTruncated.stderr);
    const expectedSummary =
      `Showing 1 of 3 open asks. Pass --after-created-at 2026-11-23T12:01:00Z --after-id ${NEW_ASK_ID} for more.`;
    const openTruncatedLines = openTruncated.stdout.trimEnd().split("\n");
    assert.equal(openTruncatedLines.length, 3);
    assert.equal(openTruncatedLines[0], expectedSummary);
    assert.match(openTruncatedLines[1]!, /55555555-5555-4555-8555-555555555555/);
    assert.equal(openTruncatedLines[openTruncatedLines.length - 1], expectedSummary);

    const openJson = await runCli(root, ["ask", "open", "--json", "--profile", profilePath]);
    assert.equal(openJson.code, 0, openJson.stderr);
    assert.doesNotMatch(openJson.stdout, /dismiss/i);
    const parsed = JSON.parse(openJson.stdout) as { total: number; truncated: boolean; asks: Array<{ signal_id: string }> };
    assert.equal(parsed.total, 1);
    assert.equal(parsed.truncated, false);
    assert.equal(parsed.asks.length, 1);
    assert.equal(parsed.asks[0]!.signal_id, NEW_ASK_ID);
    assert.ok(reads.some((r) => r.resource === "my_open_asks"));

    const openTruncatedJson = await runCli(root, ["ask", "open", "--limit", "1", "--json", "--profile", profilePath]);
    assert.equal(openTruncatedJson.code, 0, openTruncatedJson.stderr);
    assert.doesNotMatch(openTruncatedJson.stdout, /Showing /);
    const parsedTruncated = JSON.parse(openTruncatedJson.stdout) as { total: number; truncated: boolean; asks: Array<{ signal_id: string }> };
    assert.equal(parsedTruncated.total, 3);
    assert.equal(parsedTruncated.truncated, true);
    assert.equal(parsedTruncated.asks.length, 1);
    assert.equal(parsedTruncated.asks[0]!.signal_id, NEW_ASK_ID);

    // 4. cswarm ask withdraw --help and cswarm ask open --help
    const wdHelp = await runCli(root, ["ask", "withdraw", "--help"]);
    assert.equal(wdHelp.code, 0, wdHelp.stderr);
    assert.match(wdHelp.stdout, /Withdraw an open ask you sent\./);
    assert.match(wdHelp.stdout, /List your own open asks\./);
    const openHelp = await runCli(root, ["ask", "open", "--help"]);
    assert.equal(openHelp.code, 0, openHelp.stderr);
    assert.match(openHelp.stdout, /Withdraw an open ask you sent\./);
    assert.match(openHelp.stdout, /List your own open asks\./);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await rm(root, { recursive: true, force: true });
  }
});
