import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { cloudTarget } from "../../src/cloud/config.js";
import { connectMcp, mintMcpCode, renderMcpConnect } from "../../src/cloud/mcp-connect.js";
import { readAgentProfile } from "../../src/cloud/agent-profile.js";

const WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PRINCIPAL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RUN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TOKEN_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const JOIN = `swm_join_${"J".repeat(43)}`;
const TOKEN = `swm_agt_${"T".repeat(43)}`;
const TARGET = cloudTarget("http://127.0.0.1:39876", "public-test-key");

test("mcp code uses the human bearer and one-seat, one-hour mint", { timeout: 10000 }, async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (input, init) => {
    calls++;
    assert.equal(String(input), `${TARGET.url}/functions/v1/command`);
    assert.equal((init?.headers as Record<string, string>).authorization, "Bearer human-test-access");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.workspace_id, WS);
    assert.deepEqual(body.command, { kind: "mint_agent_join_credential", seat_cap: 1, ttl_hours: 1 });
    return Response.json({ status: "accepted", ok: true, event_ids: [], join_credential: JOIN, expires_at: "2099-01-01T00:00:00Z" });
  };
  assert.deepEqual(await mintMcpCode(TARGET, "human-test-access", WS, fetcher), { code: JOIN, expires_at: "2099-01-01T00:00:00Z" });
  assert.equal(calls, 1);
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cswarm-mcp-connect-"));
  let calls = 0;
  let consumed = false;
  let refusal: string | null = null;
  const fetcher: typeof fetch = async (input, init) => {
    calls++;
    assert.equal(String(input), `${TARGET.url}/functions/v1/h0/register`);
    assert.equal(init?.method, "POST");
    assert.equal((init?.headers as Record<string, string>).apikey, TARGET.anonKey);
    const body = JSON.parse(String(init?.body));
    assert.equal(body.joinCredential, JOIN);
    assert.equal(body.name, "MCP agent");
    assert.match(body.attemptId, /^[0-9a-f-]{36}$/);
    if (refusal || consumed) return Response.json({ error: refusal ?? "join_credential_seat_cap_reached" }, { status: refusal === "forbidden" ? 403 : 409 });
    consumed = true;
    return Response.json({ status: "accepted", workspace_id: WS, principal_id: PRINCIPAL,
      run_id: RUN, token_id: TOKEN_ID, agent_token: TOKEN, expires_at: "2099-01-01T00:00:00Z" });
  };
  return { root, fetcher, calls: () => calls, refuse: (value: string) => { refusal = value; },
    reset: () => { consumed = false; }, close: () => rm(root, { recursive: true, force: true }) };
}

test("connect saves an unbound private profile and never returns either secret", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const path = join(f.root, "seat", "profile.json");
    const result = await connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher: f.fetcher });
    assert.equal(f.calls(), 1);
    assert.equal(result.profile, path);
    assert.equal(result.principal_id, PRINCIPAL);
    assert.doesNotMatch(JSON.stringify(result), /swm_join_|swm_agt_/);
    assert.doesNotMatch(renderMcpConnect(result), /swm_join_|swm_agt_/);
    assert.match(renderMcpConnect(result), new RegExp(`Profile: ${path}`));
    assert.match(result.install, /claude mcp add --scope user --transport stdio cswarm/);
    assert.match(result.install, /\[mcp_servers\.cswarm\]/);
    assert.equal((await stat(dirname(path))).mode & 0o777, 0o700);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(dirname(path), "credential.json"))).mode & 0o777, 0o600);
    const saved = await readAgentProfile(path);
    assert.equal(saved.host_session_id, undefined);
    assert.equal(saved.workspace_id, WS);
    assert.equal(JSON.parse(await readFile(saved.credential_file, "utf8")).agent_token, TOKEN);
    await assert.rejects(connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher: f.fetcher }), { code: "profile_exists" });
    assert.equal(f.calls(), 1, "occupied profile must be refused before register");
    const orphan = join(f.root, "orphan", "profile.json");
    await mkdir(dirname(orphan), { mode: 0o700 });
    await writeFile(join(dirname(orphan), "credential.json"), "{}", { mode: 0o600 });
    await assert.rejects(connectMcp({ target: TARGET, profilePath: orphan, readCode: async () => JOIN, fetcher: f.fetcher }), { code: "profile_exists" });
    assert.equal(f.calls(), 1, "orphan credential must be refused before register");
    const second = join(f.root, "second", "profile.json");
    await assert.rejects(connectMcp({ target: TARGET, profilePath: second, readCode: async () => JOIN, fetcher: f.fetcher }), { code: "join_credential_seat_cap_reached", message: "Ask the operator for a new code." });
    assert.equal(f.calls(), 2, "register must not retry");
    await assert.rejects(stat(second), { code: "ENOENT" });
  } finally { await f.close(); }
});

test("expired, unknown and revoked codes use typed refusals and write nothing", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    for (const code of ["join_credential_expired", "join_credential_not_found", "join_credential_revoked", "forbidden"]) {
      f.refuse(code);
      const path = join(f.root, code, "profile.json");
      await assert.rejects(connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher: f.fetcher }),
        { code, message: "Ask the operator for a new code." });
      await assert.rejects(stat(path), { code: "ENOENT" });
    }
    assert.equal(f.calls(), 4);
    f.refuse(JOIN);
    const path = join(f.root, "hostile-error", "profile.json");
    await assert.rejects(connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher: f.fetcher }),
      { code: "register_refused", message: "Registration failed. Ask the operator for a new code." });
    assert.equal(f.calls(), 5);
  } finally { await f.close(); }
});

async function cli(argv: string[], env: Record<string, string>) {
  const child = spawn(process.execPath, [resolve("dist/cli.js"), ...argv], { env: { PATH: process.env.PATH ?? "", ...env }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => stdout += chunk);
  child.stderr.on("data", chunk => stderr += chunk);
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try { const code = await new Promise<number | null>(done => child.on("close", done)); return { code, stdout, stderr }; }
  finally { clearTimeout(timer); }
}

test("CLI refuses argv, file and environment code inputs", { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-mcp-argv-"));
  const base = ["mcp", "connect", "--url", TARGET.url, "--anon-key", TARGET.anonKey];
  try {
    const file = join(root, "code.txt");
    await writeFile(file, JOIN);
    for (const suffix of [["--code", JOIN], ["--code-file", file]]) {
      const result = await cli([...base, ...suffix], { HOME: root });
      assert.equal(result.code, 1);
      assert.match(result.stderr, new RegExp(`unknown option: ${suffix[0]}`));
      assert.doesNotMatch(result.stdout + result.stderr, /swm_join_|swm_agt_/);
    }
    const result = await cli(base, { HOME: root, CSWARM_MCP_CODE: JOIN });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /terminal_required/);
    assert.doesNotMatch(result.stdout + result.stderr, /swm_join_|swm_agt_/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("mcp code refuses agent credentials and profiles before a request", { timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-mcp-code-"));
  try {
    const base = ["mcp", "code", "--url", TARGET.url, "--anon-key", TARGET.anonKey];
    for (const suffix of [["--agent-token-file", join(root, "agent.json")], ["--profile", join(root, "profile.json")]]) {
      const result = await cli([...base, ...suffix], { HOME: root });
      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      assert.doesNotMatch(result.stderr, /swm_join_|swm_agt_/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
