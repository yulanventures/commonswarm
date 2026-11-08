/** CLI 0.1.93 ships commands whose server switches stay off: cswarm memory (SWARM_BRAIN_MEMORY)
 * and cswarm ask --choice (SWARM_INTERACTIVE_REPLIES). Against a server answering the way the
 * command and read functions do with those switches off, each command ends with the server's
 * sentence and exit code 1: no stack trace, no retry, and --json prints the refusal. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const WORKSPACE = "3ab184b3-fbb4-5ee9-afad-3842a604439a";
const MEMBER = "22222222-2222-4222-8222-222222222222";
const MEMORY = "44444444-4444-4444-8444-444444444444";
const TOKEN = `swm_agt_${"b".repeat(43)}`;
const MEMORY_OFF = { error: "memory_unavailable", message: "Workspace memory isn't turned on here." };
const CHOICES_OFF = { error: "interactive_replies_unavailable", message: "Choice asks aren't turned on here." };

const scratch = mkdtempSync(join(tmpdir(), "cswarm-dark-"));
chmodSync(scratch, 0o700);
const tokenPath = join(scratch, "agent.json");
writeFileSync(tokenPath, TOKEN, { mode: 0o600 });
after(() => rmSync(scratch, { recursive: true, force: true }));

/** The production answers with both switches off (command/index.ts and read/index.ts). */
async function switchOffCloud() {
  const seen: string[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
      const reply = (status: number, value: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      };
      if (request.url === "/functions/v1/read") {
        seen.push(`read:${String(body.resource)}`);
        if (body.resource === "members") {
          return reply(200, { members: [{ user_id: MEMBER, display_name: "Zoe" }], agents: [] });
        }
        if (body.resource === "memory_search" || body.resource === "memory_get") return reply(404, MEMORY_OFF);
        return reply(400, { error: "invalid_request" });
      }
      if (request.url === "/functions/v1/command") {
        const kind = String((body.command as Record<string, unknown> | undefined)?.kind);
        seen.push(`command:${kind}`);
        if (kind === "memory_save" || kind === "memory_forget") return reply(404, MEMORY_OFF);
        if (kind === "ask_choice") return reply(404, CHOICES_OFF);
        return reply(400, { error: "invalid_request" });
      }
      reply(404, { error: "not_found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { url: `http://127.0.0.1:${address.port}`, seen,
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

const CASES: { name: string; args: string[]; sentence: string; error: string; calls: string[] }[] = [
  { name: "memory save", args: ["memory", "save", "release day", "Fridays.", "--kind", "convention"],
    sentence: MEMORY_OFF.message, error: MEMORY_OFF.error, calls: ["command:memory_save"] },
  { name: "memory search", args: ["memory", "search", "release"],
    sentence: MEMORY_OFF.message, error: MEMORY_OFF.error, calls: ["read:memory_search"] },
  { name: "memory get", args: ["memory", "get", MEMORY],
    sentence: MEMORY_OFF.message, error: MEMORY_OFF.error, calls: ["read:memory_get"] },
  { name: "memory forget", args: ["memory", "forget", MEMORY],
    sentence: MEMORY_OFF.message, error: MEMORY_OFF.error, calls: ["command:memory_forget"] },
  { name: "ask --choice", args: ["ask", "Ship tonight?", "--to", MEMBER, "--choice", "Ship it", "--choice", "Wait"],
    sentence: CHOICES_OFF.message, error: CHOICES_OFF.error, calls: ["read:members", "command:ask_choice"] },
];

for (const item of CASES) {
  test(`${item.name} refuses cleanly while its server switch is off`, { timeout: 90_000 }, async () => {
    const cloud = await switchOffCloud();
    try {
      const plain = await cli(cloud.url, item.args);
      assert.equal(plain.code, 1, `${item.name}: exit code\n${plain.stderr}`);
      assert.ok(plain.stderr.includes(item.sentence), `${item.name}: the server's sentence\n${plain.stderr}`);
      assert.doesNotMatch(plain.stderr, /\n\s+at |TypeError|ReferenceError/, `${item.name}: no stack trace`);
      assert.deepEqual(cloud.seen, item.calls, `${item.name}: one request each, no retry`);
      if (item.name.startsWith("memory")) {
        const json = await cli(cloud.url, [...item.args, "--json"]);
        assert.equal(json.code, 1);
        assert.deepEqual(JSON.parse(json.stdout), { error: item.error, message: item.sentence });
      }
    } finally {
      await cloud.close();
    }
  });
}
