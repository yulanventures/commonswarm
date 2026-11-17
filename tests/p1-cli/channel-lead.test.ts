/** cswarm channel lead: a person's command. Its help line, and the refusals it makes before it sends anything
 * (an agent credential, a profile, a missing or doubled choice). Parsing and the wire body are in
 * tests/channel-leads.test.ts. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const WORKSPACE = "3ab184b3-fbb4-5ee9-afad-3842a604439a";
const TOKEN = `swm_agt_${"c".repeat(43)}`;

const scratch = mkdtempSync(join(tmpdir(), "cswarm-channel-lead-"));
chmodSync(scratch, 0o700);
const tokenPath = join(scratch, "agent.json");
writeFileSync(tokenPath, TOKEN, { mode: 0o600 });
after(() => rmSync(scratch, { recursive: true, force: true }));

async function cloud() {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "invalid_request" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { url: `http://127.0.0.1:${address.port}`, requests: () => requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

async function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
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

test("channel lead documents one choice of agent, --workspace or --none, and no agent flags", async () => {
  const help = await cli(["channel", "lead", "--help"]);
  assert.match(help.stdout + help.stderr,
    /cswarm channel lead <name\|channel-id> \(<agent> \| --workspace \| --none\) \[--url <url> --anon-key <key>\] \[--workspace-id <uuid>\] \[--json\]/);
  assert.doesNotMatch(help.stdout + help.stderr, /channel lead[^\n]*--agent-token-file/);
});

test("channel lead refuses an agent credential, a profile, and a missing or doubled choice before it sends anything", async () => {
  const fake = await cloud();
  try {
    const target = ["--url", fake.url, "--anon-key", "test-anon", "--workspace-id", WORKSPACE];
    for (const [args, sentence] of [
      [["channel", "lead", "design", "--workspace", "--agent-token-file", tokenPath], /--agent-token-file/],
      [["channel", "lead", "design", "--none", "--profile", join(scratch, "profile.json")], /--profile is supported by/],
      [["channel", "lead", "design"], /needs the channel and one of an agent, --workspace or --none/],
      [["channel", "lead", "design", "--workspace", "--none"], /needs the channel and one of an agent, --workspace or --none/],
      [["channel", "lead", "design", "DesignLead", "--none"], /needs the channel and one of an agent, --workspace or --none/],
      [["channel", "lead", "design", "DesignLead", "extra"], /too many positional arguments/],
    ] as const) {
      const result = await cli([...args, ...target]);
      assert.notEqual(result.code, 0, args.join(" "));
      assert.match(result.stderr, sentence, `${args.join(" ")}: ${result.stderr}`);
    }
    assert.equal(fake.requests(), 0, "nothing reached the server");
  } finally { await fake.close(); }
});
