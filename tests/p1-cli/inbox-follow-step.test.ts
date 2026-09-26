import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  Arguments, inboxMoreNotice, INBOX_FOLLOW_REFUSED_FLAGS,
  SIGNAL_READ_INBOX_ACCEPTED_FLAGS,
} from "../../src/cli.js";
import { AGENT_CREDENTIAL_MESSAGE_D088 } from "../../src/cloud/agent-credential-input.js";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const PRINCIPAL = "22222222-2222-4222-8222-222222222222";
const TOKEN = `swm_agt_${"A".repeat(43)}`;
const SINCE = "2026-09-24T00:00:00.000Z";
const CURSOR = { created_at: SINCE, id: "33333333-3333-4333-8333-333333333333" };
const credential = { message: AGENT_CREDENTIAL_MESSAGE_D088, status: "accepted", principal_id: PRINCIPAL,
  token_id: "44444444-4444-4444-8444-444444444444", run_id: "55555555-5555-4555-8555-555555555555",
  agent_token: TOKEN, expires_at: "2099-01-01T00:00:00.000Z" };

function wordsFromNotice(notice: string): string[] {
  const printed = notice.match(/run (cswarm inbox .+)\.$/)?.[1];
  assert.ok(printed, notice);
  const words = printed.match(/'[^']*'|\S+/g)?.map(word => word.startsWith("'") ? word.slice(1, -1) : word);
  assert.ok(words);
  assert.equal(words.shift(), "cswarm");
  return words;
}

// Each fetch either answers from local data or exits the child after recording
// the first follow request. It refuses every non-loopback URL before doing I/O.
const preload = `import { appendFileSync } from 'node:fs';
const ws = ${JSON.stringify(WORKSPACE)};
const principal = ${JSON.stringify(PRINCIPAL)};
globalThis.fetch = async (url, init) => {
  if (!String(url).startsWith(process.env.ITEM_K_URL+'/')) throw new Error('non-loopback request');
  const body = JSON.parse(String(init.body));
  if (body.resource === 'members') return Response.json({members:[], agents:[], identity:{credential_valid:true, owner_user_id:'66666666-6666-4666-8666-666666666666', principal_id:principal, workspace_id:ws}});
  if (body.resource !== 'signals') throw new Error('unexpected resource');
  appendFileSync(process.env.ITEM_K_CAPTURE, JSON.stringify({body, authorization:init.headers.authorization})+'\\n');
  if (process.env.ITEM_K_MODE === 'follow') process.exit(0);
  const start = body.after_id ? Number(String(body.after_id).slice(0, 8)) : 0;
  const signals = Array.from({length:100}, (_, n) => {
    const i = start + n + 1;
    return {id:String(i).padStart(8,'0')+'-1111-4111-8111-111111111111', workspace_id:ws,
      from:'77777777-7777-4777-8777-777777777777', from_kind:'user', to:null, to_agent:principal,
      in_reply_to:null, about:null, kind:'ask', body:'fixture', until:'2099-01-01T00:00:00.000Z',
      created_at:new Date(Date.UTC(2026,8,24,0,0,i)).toISOString(), sender_owner_relation:'same_owner'};
  });
  return Response.json({signals, capabilities:{sender_owner_relation:1,cursor_after:1}});
};
`;

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "item-k-follow-step-"));
  const followRequests: Array<{ body: Record<string, unknown>; authorization: string }> = [];
  let resolveRequest: (() => void) | undefined;
  const firstRequest = new Promise<void>(resolve => { resolveRequest = resolve; });
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", chunk => { raw += chunk; });
    req.on("end", () => {
      followRequests.push({ body: JSON.parse(raw), authorization: String(req.headers.authorization) });
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ signals: [], capabilities: { cursor_after: 1 } }));
      resolveRequest?.();
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const profile = join(dir, "profile.json");
  const credentialFile = join(dir, "credential.json");
  const capture = join(dir, "capture.jsonl");
  const preloader = join(dir, "preload.mjs");
  await writeFile(credentialFile, JSON.stringify(credential), { mode: 0o600 });
  await writeFile(profile, JSON.stringify({ version: 1, url, anon_key: "public-test-key",
    workspace_id: WORKSPACE, principal_id: PRINCIPAL, credential_file: credentialFile,
    host_session_id: "session-A" }), { mode: 0o600 });
  await writeFile(preloader, preload, { mode: 0o600 });
  return { dir, url, profile, credentialFile, capture, preloader, followRequests, firstRequest,
    cleanup: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); } };
}

function cli(f: Awaited<ReturnType<typeof fixture>>, mode: "read" | "follow", args: string[], input?: string) {
  const result = spawnSync(process.execPath, ["--import", f.preloader, resolve("dist/cli.js"), ...args], {
    encoding: "utf8", timeout: 10_000, maxBuffer: 8 * 1024 * 1024, input,
    env: { ...process.env, HOME: f.dir, XDG_CONFIG_HOME: join(f.dir, "config"), SWARM_AGENT_STATE_DIR: join(f.dir, "state"),
      ITEM_K_CAPTURE: f.capture, ITEM_K_MODE: mode, ITEM_K_URL: f.url },
  });
  assert.equal(result.error, undefined, `CLI timed out: ${args.join(" ")}`);
  return result;
}

async function followCli(f: Awaited<ReturnType<typeof fixture>>, args: string[], input?: string) {
  const child = spawn(process.execPath, ["--import", f.preloader, resolve("dist/cli.js"), ...args], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, HOME: f.dir, XDG_CONFIG_HOME: join(f.dir, "config"), SWARM_AGENT_STATE_DIR: join(f.dir, "state"),
      ITEM_K_CAPTURE: f.capture, ITEM_K_MODE: "follow", ITEM_K_URL: f.url },
  });
  child.stdin.end(input);
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    await Promise.race([f.firstRequest, closed]);
    assert.ok(f.followRequests.length > 0, stderr);
  } finally {
    child.kill("SIGTERM");
    await closed;
    clearTimeout(timeout);
  }
}

async function captured(f: Awaited<ReturnType<typeof fixture>>) {
  return (await readFile(f.capture, "utf8")).trim().split("\n").map(line => JSON.parse(line) as {
    body: Record<string, unknown>; authorization: string;
  });
}

test("every accepted inbox read flag is carried, replaced, dropped, or explicitly cannot follow", { timeout: 10_000 }, () => {
  const drops = new Set<string>(["limit", "json", "ndjson", "since", "follow", "notify"]);
  const refused = new Set<string>(INBOX_FOLLOW_REFUSED_FLAGS);
  const booleans = new Set(["force-file-store", "agent-token-stdin", "include-stale", "json", "ndjson", "follow", "notify"]);
  assert.equal(new Set(SIGNAL_READ_INBOX_ACCEPTED_FLAGS).size, SIGNAL_READ_INBOX_ACCEPTED_FLAGS.length);
  for (const flag of SIGNAL_READ_INBOX_ACCEPTED_FLAGS) {
    const value = booleans.has(flag) ? [] : [flag === "since" ? SINCE : "fixture"];
    const args = new Arguments(["inbox", "--since", SINCE, `--${flag}`, ...value]);
    const notice = inboxMoreNotice(CURSOR, SINCE, args);
    if (refused.has(flag) && !drops.has(flag)) {
      assert.match(notice, new RegExp(`cannot carry --${flag}`), flag);
      assert.doesNotMatch(notice, /run cswarm inbox --follow/, flag);
    } else if (drops.has(flag)) {
      const step = wordsFromNotice(notice);
      if (flag !== "since") assert.equal(step.includes(`--${flag}`), flag === "follow" || flag === "ndjson", flag);
    } else {
      assert.ok(wordsFromNotice(notice).includes(`--${flag}`), flag);
    }
  }
});

test("stdin credential and every follow filter survive a real read and follow dispatch", { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    const flags = ["--url", f.url, "--anon-key", "public-test-key", "--workspace-id", WORKSPACE,
      "--agent-token-stdin", "--kind", "ask", "--about", "fixture", "--include-stale", "--json"];
    const read = cli(f, "read", ["inbox", "--since", SINCE, ...flags], JSON.stringify(credential));
    assert.equal(read.status, 0, read.stderr);
    const notice = JSON.parse(read.stdout).notice as string;
    assert.match(notice, /pipe the same token again/);
    const step = wordsFromNotice(notice);
    assert.ok(step.includes("--agent-token-stdin"));
    assert.ok(!step.includes("--json"));
    await followCli(f, step, JSON.stringify(credential));
    const requests = await captured(f);
    assert.equal(requests.length, 10);
    assert.equal(f.followRequests[0]?.authorization, `Bearer ${TOKEN}`);
    assert.equal(f.followRequests[0]?.body.kind, "ask");
    assert.equal(f.followRequests[0]?.body.about, "fixture");
    assert.equal(f.followRequests[0]?.body.include_stale, true);
    assert.equal(f.followRequests[0]?.body.since, SINCE);
  } finally { await f.cleanup(); }
});

test("profile and host binding remain typed, and the printed follow dispatch opens that profile", { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    const read = cli(f, "read", ["inbox", "--since", SINCE, "--profile", f.profile, "--host-session-id", "session-A", "--json"]);
    assert.equal(read.status, 0, read.stderr);
    const notice = JSON.parse(read.stdout).notice as string;
    const step = wordsFromNotice(notice);
    assert.ok(step.includes("--profile"));
    assert.ok(step.includes("--host-session-id"));
    assert.ok(!step.includes("--anon-key"));
    assert.ok(!step.includes("--agent-token-file"));
    await followCli(f, step);
    assert.equal(f.followRequests[0]?.authorization, `Bearer ${TOKEN}`);
    const wrong = cli(f, "follow", step.map(word => word === "session-A" ? "session-B" : word));
    assert.notEqual(wrong.status, 0);
    assert.match(wrong.stderr, /This profile belongs to another session/);
  } finally { await f.cleanup(); }
});

test("session context is retained and a refused channel never suggests a different read", { timeout: 10_000 }, async () => {
  const f = await fixture();
  try {
    const args = new Arguments(["inbox", "--since", SINCE, "--url", f.url, "--anon-key", "public-test-key",
      "--workspace-id", WORKSPACE, "--agent-token-file", f.credentialFile, "--session-context", join(f.dir, "missing-context")]);
    const step = wordsFromNotice(inboxMoreNotice(CURSOR, SINCE, args));
    assert.ok(step.includes("--session-context"));
    const result = cli(f, "follow", step);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stderr, /unknown option|requires --follow|cannot be combined/);
    assert.match(result.stderr, /session context/i);
    const channel = new Arguments(["inbox", "--since", SINCE, "--channel", "news"]);
    assert.match(inboxMoreNotice(CURSOR, SINCE, channel), /cannot carry --channel/);
    const read = cli(f, "read", ["inbox", "--since", SINCE, "--url", f.url, "--anon-key", "public-test-key",
      "--workspace-id", WORKSPACE, "--agent-token-file", f.credentialFile, "--channel", "news", "--json"]);
    assert.equal(read.status, 0, read.stderr);
    const notice = JSON.parse(read.stdout).notice as string;
    assert.match(notice, /cannot carry --channel/);
    assert.doesNotMatch(notice, /run cswarm inbox --follow/);
  } finally { await f.cleanup(); }
});
