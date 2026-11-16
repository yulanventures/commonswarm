/** cswarm react and cswarm unreact, against a server that answers the way the command function does:
 * one command per emoji, normalized before sending, refused before anything is sent when an emoji is
 * not one, and what each prints. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const WORKSPACE = "3ab184b3-fbb4-4ee9-afad-3842a604439a";
const MESSAGE = "11111111-1111-4111-8111-111111111111";
const MISSING = "22222222-2222-4222-8222-222222222222";
const TOKEN = `swm_agt_${"c".repeat(43)}`;

const scratch = mkdtempSync(join(tmpdir(), "cswarm-react-"));
chmodSync(scratch, 0o700);
const tokenPath = join(scratch, "agent.json");
writeFileSync(tokenPath, TOKEN, { mode: 0o600 });
after(() => rmSync(scratch, { recursive: true, force: true }));

/** One message, MESSAGE, that already holds 👀 from this agent. */
async function cloud() {
  const held = new Set(["\u{1F440}"]);
  const commands: Record<string, unknown>[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
      const reply = (status: number, value: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      };
      if (request.url !== "/functions/v1/command") return reply(400, { error: "invalid_request" });
      const command = body.command as Record<string, unknown>;
      commands.push({ ...command, command_id: body.command_id, workspace_id: body.workspace_id });
      if (command.signal_id !== MESSAGE) {
        return reply(404, { error: "signal_not_found", message: "There is no message with that id that you can read in this workspace." });
      }
      const emoji = String(command.emoji);
      if (command.kind === "add_reaction") {
        const added = !held.has(emoji);
        held.add(emoji);
        return reply(200, { status: "accepted", ok: true, event_ids: [], signal_id: MESSAGE, emoji, added });
      }
      if (command.kind === "remove_reaction") {
        const removed = held.delete(emoji);
        return reply(200, { status: "accepted", ok: true, event_ids: [], signal_id: MESSAGE, emoji, removed });
      }
      reply(400, { error: "invalid_request" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { url: `http://127.0.0.1:${address.port}`, commands,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

async function cli(url: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", ...args,
    "--url", url, "--anon-key", "test-anon", "--workspace-id", WORKSPACE, "--agent-token-file", tokenPath], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: scratch, XDG_CONFIG_HOME: join(scratch, "config"), XDG_STATE_HOME: join(scratch, "state"),
      SWARM_AGENT_STATE_DIR: join(scratch, "agent-state"), SWARM_CLOUD_URL: "", SWARM_CLOUD_ANON_KEY: "", SWARM_CLOUD_WORKSPACE_ID: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => stdout += chunk);
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => stderr += chunk);
  const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
  const code = await new Promise<number>((resolve) => child.on("close", (value) => resolve(value ?? -1)));
  clearTimeout(timer);
  return { code, stdout, stderr };
}

test("react sends one add_reaction per emoji, normalized and deduplicated, and says what changed", async () => {
  const fake = await cloud();
  try {
    const result = await cli(fake.url, ["react", MESSAGE.toUpperCase(), "👍", ":+1:", ":eyes:", "🚀"]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(fake.commands.map(({ command_id: _id, ...command }) => command), [
      { kind: "add_reaction", signal_id: MESSAGE, emoji: "👍", workspace_id: WORKSPACE },
      { kind: "add_reaction", signal_id: MESSAGE, emoji: "\u{1F440}", workspace_id: WORKSPACE },
      { kind: "add_reaction", signal_id: MESSAGE, emoji: "🚀", workspace_id: WORKSPACE },
    ], "👍 and :+1: are one reaction; a manual reaction sends no source");
    assert.equal(new Set(fake.commands.map((command) => command.command_id)).size, 3, "a fresh command id per emoji");
    assert.equal(result.stdout, "👍 added\n\u{1F440} was already there\n🚀 added\n");
  } finally { await fake.close(); }
});

test("react --remove and unreact send remove_reaction; --json carries each outcome", async () => {
  const fake = await cloud();
  try {
    const removed = await cli(fake.url, ["react", MESSAGE, ":eyes:", "--remove", "--json"]);
    assert.equal(removed.code, 0, removed.stderr);
    assert.deepEqual(JSON.parse(removed.stdout), { signal_id: MESSAGE, reactions: [{ emoji: "\u{1F440}", result: "removed" }] });
    const absent = await cli(fake.url, ["unreact", MESSAGE, "👀", "👍"]);
    assert.equal(absent.code, 0, absent.stderr);
    assert.equal(absent.stdout, "\u{1F440} was not there\n👍 was not there\n");
    assert.deepEqual(fake.commands.map((command) => command.kind), ["remove_reaction", "remove_reaction", "remove_reaction"]);
    assert.ok(fake.commands.every((command) => !Object.hasOwn(command, "source")));
    const refused = await cli(fake.url, ["unreact", MESSAGE, "👍", "--remove"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.stderr, /unknown option: --remove/);
  } finally { await fake.close(); }
});

test("react refuses a bad emoji, a missing emoji or a bad id before sending anything", async () => {
  const fake = await cloud();
  try {
    for (const args of [
      ["react", MESSAGE, "👍", "ok"],
      ["react", MESSAGE, "👍👍"],
      ["react", MESSAGE, ":nope:"],
      ["react", MESSAGE],
      ["react", "not-a-message", "👍"],
      ["unreact", MESSAGE],
    ]) {
      const result = await cli(fake.url, args);
      assert.notEqual(result.code, 0, args.join(" "));
      assert.match(result.stderr, /is not a reaction: emoji must be one emoji|requires the id of a message and at least one emoji/, args.join(" "));
    }
    assert.equal(fake.commands.length, 0);
  } finally { await fake.close(); }
});

test("a refusal for a message this agent cannot read names its reason", async () => {
  const fake = await cloud();
  try {
    const missing = await cli(fake.url, ["react", MISSING, "👍"]);
    assert.notEqual(missing.code, 0);
    assert.match(missing.stderr, /no message with that id that you can read/);
    assert.equal(missing.stdout, "");
  } finally { await fake.close(); }
});
