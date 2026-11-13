/** cswarm channel update and cswarm channel unarchive, against a server that answers the way the read and command
 * functions do: what each command sends (the body the edge validates), that an archived channel is found by name,
 * what it prints, and what it refuses before sending anything. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const WORKSPACE = "3ab184b3-fbb4-5ee9-afad-3842a604439a";
const LIVE = "11111111-1111-4111-8111-111111111111";
const ARCHIVED = "22222222-2222-4222-8222-222222222222";
const AGENT = "33333333-3333-4333-8333-333333333333";
const TOKEN = `swm_agt_${"c".repeat(43)}`;

const scratch = mkdtempSync(join(tmpdir(), "cswarm-channel-update-"));
chmodSync(scratch, 0o700);
const tokenPath = join(scratch, "agent.json");
writeFileSync(tokenPath, TOKEN, { mode: 0o600 });
after(() => rmSync(scratch, { recursive: true, force: true }));

const row = (id: string, slug: string, purpose: string | null, archived: boolean) => ({
  channel_id: id, workspace_id: WORKSPACE, slug, purpose, created_by_principal: AGENT, created_by_kind: "agent",
  created_at: "2026-11-01T00:00:00.000Z", archived_at: archived ? "2026-11-02T00:00:00.000Z" : null });

/** A workspace with one live channel (design) and one archived channel (old-plans). Commands are applied to the rows. */
async function cloud() {
  const rows = new Map([[LIVE, row(LIVE, "design", "Design work", false)], [ARCHIVED, row(ARCHIVED, "old-plans", null, true)]]);
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
      if (request.url === "/functions/v1/read" && body.resource === "channels") {
        return reply(200, { channels: [...rows.values()].map(channel => ({ ...channel, unread: false })), general_unread: false });
      }
      if (request.url === "/functions/v1/command") {
        const command = body.command as Record<string, unknown>;
        commands.push(command);
        const current = rows.get(String(command.channel_id));
        if (!current) return reply(404, { error: "channel_not_found", message: "There is no channel with that id in this workspace." });
        const next = { ...current };
        if (command.kind === "channel_update") {
          if (typeof command.slug === "string") next.slug = command.slug;
          if (Object.hasOwn(command, "purpose")) next.purpose = command.purpose as string | null;
        } else if (command.kind === "channel_unarchive") next.archived_at = null;
        else return reply(400, { error: "invalid_request" });
        rows.set(next.channel_id, next);
        return reply(200, { ok: true, status: "accepted", event_ids: [], channel: next });
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

test("channel update sends only what was asked for: a new name, a new purpose, both, or a cleared purpose", async () => {
  const fake = await cloud();
  try {
    const both = await cli(fake.url, ["channel", "update", "design", "--name", "Studio", "--purpose", "  Studio work  "]);
    assert.equal(both.code, 0, both.stderr);
    assert.deepEqual(fake.commands.at(-1), { kind: "channel_update", channel_id: LIVE, slug: "studio", purpose: "Studio work" });
    assert.match(both.stdout, /Channel studio is now named studio and with its new purpose\./);
    assert.match(both.stdout, /Purpose: Studio work/);

    const purposeOnly = await cli(fake.url, ["channel", "update", LIVE, "--purpose", "Only this", "--json"]);
    assert.equal(purposeOnly.code, 0, purposeOnly.stderr);
    assert.deepEqual(fake.commands.at(-1), { kind: "channel_update", channel_id: LIVE, purpose: "Only this" });
    assert.equal((JSON.parse(purposeOnly.stdout) as { channel: { slug: string; purpose: string } }).channel.purpose, "Only this");

    const cleared = await cli(fake.url, ["channel", "update", "studio", "--clear-purpose"]);
    assert.equal(cleared.code, 0, cleared.stderr);
    assert.deepEqual(fake.commands.at(-1), { kind: "channel_update", channel_id: LIVE, purpose: null });
    assert.match(cleared.stdout, /is now without a purpose\./);
    assert.doesNotMatch(cleared.stdout, /Purpose:/);

    // An archived channel is found by its name and can be renamed, which is how its name is freed.
    const archived = await cli(fake.url, ["channel", "update", "old-plans", "--name", "plans-2025"]);
    assert.equal(archived.code, 0, archived.stderr);
    assert.deepEqual(fake.commands.at(-1), { kind: "channel_update", channel_id: ARCHIVED, slug: "plans-2025" });
    assert.match(archived.stdout, /It is still archived\. Bring it back with cswarm channel unarchive plans-2025/);
  } finally { await fake.close(); }
});

test("channel update refuses an empty or contradictory request before it sends anything", async () => {
  const fake = await cloud();
  try {
    for (const [args, sentence] of [
      [["channel", "update", "design"], /needs --name, --purpose or --clear-purpose/],
      [["channel", "update", "design", "--purpose", "x", "--clear-purpose"], /--purpose or --clear-purpose, not both/],
      [["channel", "update", "design", "--purpose", "   "], /To remove the purpose, use --clear-purpose/],
      [["channel", "update", "design", "--name", "Not A Name"], /lowercase|letters|hyphen/i],
      [["channel", "update", "design", "--purpose", "x".repeat(501)], /at most 500 characters/],
      [["channel", "update"], /needs the channel/],
    ] as const) {
      const refused = await cli(fake.url, [...args]);
      assert.equal(refused.code, 1, `${args.join(" ")}: ${refused.stdout}`);
      assert.match(refused.stderr, sentence, args.join(" "));
    }
    assert.deepEqual(fake.commands, [], "nothing reached the command function");
    const unknown = await cli(fake.url, ["channel", "update", "nowhere", "--purpose", "x"]);
    assert.equal(unknown.code, 1);
    assert.match(unknown.stderr, /design/, "the refusal names the channels that exist");
    assert.deepEqual(fake.commands, []);
  } finally { await fake.close(); }
});

test("channel unarchive finds an archived channel by name and brings it back", async () => {
  const fake = await cloud();
  try {
    const back = await cli(fake.url, ["channel", "unarchive", "old-plans"]);
    assert.equal(back.code, 0, back.stderr);
    assert.deepEqual(fake.commands, [{ kind: "channel_unarchive", channel_id: ARCHIVED }]);
    assert.match(back.stdout, /Channel old-plans is live again\./);
    const json = await cli(fake.url, ["channel", "unarchive", ARCHIVED, "--json"]);
    assert.equal(json.code, 0, json.stderr);
    assert.equal((JSON.parse(json.stdout) as { channel: { archived_at: string | null } }).channel.archived_at, null);
    const missing = await cli(fake.url, ["channel", "unarchive"]);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /needs the channel/);
  } finally { await fake.close(); }
});
