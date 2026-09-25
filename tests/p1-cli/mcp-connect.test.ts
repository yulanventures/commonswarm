import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { PassThrough } from "node:stream";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { cloudTarget } from "../../src/cloud/config.js";
import { mcpFailureCode } from "../../src/cli.js";
import { writeCurrentTarget } from "../../src/cloud/current-target.js";
import { connectMcp, mintMcpCode, readHiddenJoinCode, renderMcpCode, renderMcpConnect, type HiddenTerminal } from "../../src/cloud/mcp-connect.js";
import { readAgentProfile } from "../../src/cloud/agent-profile.js";
import { REGISTER_REFUSALS, REGISTER_NO_SEAT_THIS_ATTEMPT, REGISTER_EXISTING_SEAT_REFUSALS } from "../../src/cloud/mcp-register-refusals.js";

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
  assert.match(renderMcpCode({ code: JOIN, expires_at: "2099-01-01T00:00:00Z" }, TARGET), new RegExp(`Expires: 2099-01-01T00:00:00Z\\nOn the agent host run: cswarm mcp connect --url ${TARGET.url} --anon-key ${TARGET.anonKey}`));
  assert.equal(calls, 1);
});

test("register refusal table and seat-state sets are generated from the server handlers", { timeout: 10000 }, async () => {
  const result = spawnSync(process.execPath, ["scripts/generate-mcp-register-refusals.mjs", "--check"], { timeout: 5000, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(REGISTER_REFUSALS.join_credential_not_found, undefined);
  assert.equal(REGISTER_REFUSALS.join_credential_expired, undefined);
  assert.equal(REGISTER_REFUSALS.join_credential_revoked, undefined);
  const command = await readFile("supabase/functions/command/index.ts", "utf8");
  const register = command.slice(command.indexOf("async function registerAgentSeat("), command.indexOf("async function ", command.indexOf("async function registerAgentSeat(") + 1));
  const beforeAttempt = register.slice(0, register.indexOf("const attemptRows"));
  for (const code of ["forbidden", "invalid_request", "upgrade_required"]) assert.match(beforeAttempt, new RegExp(`error: "${code}"`));
  assert.match(register, /if \(live >= FREE_TIER_PRINCIPAL_LIMIT\)[\s\S]*?"principal_limit_reached"/);
  assert.match(register, /if \(credential\.seats_used >= credential\.seat_cap\)[\s\S]*?"join_credential_seat_cap_reached"/);
  const conflicts = await readFile("supabase/functions/command/registration-conflicts.ts", "utf8");
  for (const code of ["registration_token_already_used", "registration_seat_revoked"]) assert.match(conflicts, new RegExp(`code: "${code}"`));
  const forward = await readFile("supabase/functions/h0/forward.ts", "utf8");
  const core = await readFile("supabase/functions/h0/core.ts", "utf8");
  for (const code of ["method_not_allowed", "payload_too_large"]) assert.match(forward, new RegExp(`error: "${code}"`));
  assert.match(core, /error: "not_found"/);
  assert.deepEqual(Object.keys(REGISTER_NO_SEAT_THIS_ATTEMPT).sort(), ["upgrade_required", "principal_limit_reached", "forbidden", "invalid_request", "payload_too_large", "not_found", "method_not_allowed"].sort());
  assert.deepEqual(Object.keys(REGISTER_EXISTING_SEAT_REFUSALS).sort(), ["join_credential_seat_cap_reached", "registration_token_already_used", "registration_seat_revoked"].sort());
  assert.equal(REGISTER_NO_SEAT_THIS_ATTEMPT.command_id_conflict, undefined);
  assert.equal(REGISTER_EXISTING_SEAT_REFUSALS.command_id_conflict, undefined);
});

test("equals-style option errors never echo an option value on three commands", { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-mcp-equals-"));
  try {
    for (const argv of [["mcp", "connect", "--url", TARGET.url, "--anon-key", TARGET.anonKey], ["mcp", "code"], ["check"]]) {
      const result = await cli([...argv, `--code=${JOIN}`], { HOME: root, CSWARM_SITE: "http://127.0.0.1:9" });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /invalid option: --code/);
      assert.doesNotMatch(result.stdout + result.stderr, /swm_join_|swm_agt_/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("fresh connect without an anon key names only the accepted flag", { timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-mcp-fresh-"));
  try {
    const result = await cli(["mcp", "connect", "--url", TARGET.url], { HOME: root, SWARM_CLOUD_ANON_KEY: "ignored-public-key" });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /--anon-key/);
    assert.doesNotMatch(result.stderr, /SWARM_CLOUD_ANON_KEY|target set/);
    await writeCurrentTarget(TARGET, { stateDirectory: join(root, ".cswarm", "credentials.d") });
    const matched = await cli(["mcp", "connect", "--url", `${TARGET.url}/`], { HOME: root });
    assert.match(matched.stderr, /terminal_required/, "a saved target for the same URL supplies the public key");
    const mismatched = await cli(["mcp", "connect", "--url", "http://127.0.0.1:9"], { HOME: root });
    assert.match(mismatched.stderr, /--anon-key/);
    assert.doesNotMatch(mismatched.stderr, /SWARM_CLOUD_ANON_KEY/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("preprompt directory and credential path checks refuse before consuming the code", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const dir = join(f.root, "public");
    await mkdir(dir, { mode: 0o755 });
    const readonly = join(f.root, "readonly");
    await mkdir(readonly, { mode: 0o500 });
    const linked = join(f.root, "linked");
    await symlink(dir, linked);
    for (const path of [join(dir, "profile.json"), join(readonly, "profile.json"), join(linked, "profile.json"), join(f.root, "credential.json"), join(f.root, "Credential.JSON")]) {
      let prompts = 0;
      await assert.rejects(connectMcp({ target: TARGET, profilePath: path, readCode: async () => { prompts++; return JOIN; }, fetcher: f.fetcher }));
      assert.equal(prompts, 0);
    }
    assert.equal(f.calls(), 0);
  } finally { await f.close(); }
});

test("invalid input and malformed seat tokens never appear in errors", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    await assert.rejects(connectMcp({ target: TARGET, profilePath: join(f.root, "invalid", "profile.json"),
      readCode: async () => `${JOIN}wrong`, fetcher: f.fetcher }), error => {
      assert.equal((error as {code:string}).code, "join_credential_invalid");
      assert.doesNotMatch(String(error), /swm_join_|swm_agt_/);
      return true;
    });
    assert.equal(f.calls(), 0);
    const fetcher: typeof fetch = async () => Response.json({ status: "accepted", workspace_id: WS, principal_id: PRINCIPAL,
      run_id: RUN, token_id: TOKEN_ID, agent_token: `${TOKEN}bad`, expires_at: "2099-01-01T00:00:00Z" });
    await assert.rejects(connectMcp({ target: TARGET, profilePath: join(f.root, "bad-seat", "profile.json"),
      readCode: async () => JOIN, fetcher }), error => {
      assert.equal((error as {code:string}).code, "register_outcome_unknown");
      assert.match(String(error), /cswarm principal revoke/);
      assert.doesNotMatch(String(error), /swm_join_|swm_agt_/);
      return true;
    });
  } finally { await f.close(); }
});

test("connect rejects cleartext non-loopback targets before prompting", { timeout: 10000 }, async () => {
  let prompts = 0;
  await assert.rejects(connectMcp({ target: cloudTarget("http://example.test", TARGET.anonKey),
    readCode: async () => { prompts++; return JOIN; } }), { code: "connect_url_invalid" });
  assert.equal(prompts, 0);
});

test("hidden prompt rejects EOF and empty input, trims input, and restores echo and signal handlers", { timeout: 10000 }, async () => {
  for (const kind of ["eof", "empty", "padded", "write-error", "sigint", "sigterm", "stty-error"] as const) {
    const input = new PassThrough();
    const signals = new EventEmitter();
    const echoes: boolean[] = [];
    const writes: string[] = [];
    const exits: number[] = [];
    const terminal: HiddenTerminal = {
      isTTY: true, input, signals,
      echo: on => { if (kind === "stty-error" && !on) throw new Error("stty unavailable"); echoes.push(on); },
      write: value => { writes.push(value); if (kind === "write-error") throw new Error("prompt write failed"); },
      exit: code => { exits.push(code); },
    };
    const pending = readHiddenJoinCode(terminal);
    if (kind === "eof") input.end();
    if (kind === "empty") input.end("\n");
    if (kind === "padded") input.end(`  ${JOIN}  \n`);
    if (kind === "sigint" || kind === "sigterm") {
      signals.emit(kind === "sigint" ? "SIGINT" : "SIGTERM");
      assert.equal(signals.listenerCount("SIGINT") + signals.listenerCount("SIGTERM"), 0, "signal handlers leave before exit");
      assert.deepEqual(echoes, [false, true], "signal handler restores echo before process.exit");
      assert.deepEqual(exits, [kind === "sigint" ? 130 : 143]);
      input.end();
    }
    if (kind === "padded") assert.equal((await pending).trim(), JOIN);
    else if (kind === "eof" || kind === "empty" || kind === "sigint" || kind === "sigterm") await assert.rejects(pending, { code: "code_missing" });
    else await assert.rejects(pending);
    if (kind === "sigint" || kind === "sigterm") assert.deepEqual(exits, [kind === "sigint" ? 130 : 143]);
    if (kind !== "stty-error") assert.deepEqual(echoes, [false, true]);
    if (kind === "stty-error") assert.deepEqual(writes, [], "no prompt if stty fails");
    assert.equal(signals.listenerCount("SIGINT"), 0);
    assert.equal(signals.listenerCount("SIGTERM"), 0);
  }
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
    if (refusal || consumed) { const error = refusal ?? "join_credential_seat_cap_reached"; return Response.json({ error }, { status: REGISTER_REFUSALS[error] ?? 409 }); }
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
    const result = await connectMcp({ target: TARGET, profilePath: path, readCode: async () => `  ${JOIN}  `, fetcher: f.fetcher });
    assert.equal(f.calls(), 1);
    assert.equal(result.profile, path);
    assert.equal(result.principal_id, PRINCIPAL);
    assert.doesNotMatch(JSON.stringify(result), /swm_join_|swm_agt_/);
    assert.doesNotMatch(renderMcpConnect(result), /swm_join_|swm_agt_/);
    assert.match(renderMcpConnect(result), new RegExp(`Profile: ${path}`));
    // The printed lines name the profile path only: no principal, workspace, token or run id.
    const printed = renderMcpConnect(result);
    for (const id of [PRINCIPAL, WS]) assert.ok(!printed.includes(id), `printed output names ${id}`);
    assert.deepEqual(printed.trimEnd().split("\n").filter(line => !line.includes(path)).filter(line => !/^\[mcp_servers\.cswarm\]$|^command = "cswarm"$/.test(line)), []);
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
    await assert.rejects(connectMcp({ target: TARGET, profilePath: second, readCode: async () => JOIN, fetcher: f.fetcher }), { code: "join_credential_seat_cap_reached", message: "This code was already used. If you did not use it, someone else may have: tell the operator to revoke that agent and issue a new code." });
    assert.equal(f.calls(), 2, "register must not retry");
    await assert.rejects(stat(second), { code: "ENOENT" });
  } finally { await f.close(); }
});

test("mcp connect succeeds after registration when the optional inventory is unavailable", { timeout: 10_000 }, async () => {
  const oldHome = process.env.HOME;
  try {
    for (const cause of ["mode", "damaged"] as const) {
      const f = await fixture();
      try {
        process.env.HOME = f.root;
        const inventoryRoot = join(f.root, ".cswarm");
        await mkdir(inventoryRoot, { mode: 0o700 });
        if (cause === "mode") await chmod(inventoryRoot, 0o755);
        else await writeFile(join(inventoryRoot, "profile-paths.json"), "{", { mode: 0o600 });
        const warnings: string[] = [];
        const write = process.stderr.write;
        process.stderr.write = ((chunk: string) => { warnings.push(String(chunk)); return true; }) as typeof write;
        const path = join(inventoryRoot, "connect-test", "profile.json");
        let result;
        try { result = await connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher: f.fetcher }); }
        finally { process.stderr.write = write; }
        assert.equal(result.profile, path);
        assert.equal((await stat(path)).mode & 0o777, 0o600);
        assert.equal(warnings.length, 1);
        assert.match(warnings[0]!, cause === "mode" ? /chmod 700 ~\/\.cswarm/ : /inventory unavailable/);
      } finally { await f.close(); }
    }
  } finally { if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome; }
});

test("generated register refusal inventory and typed remedies", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const noSeatRemedies: Record<string, string> = {
      forbidden: "This code is unknown, expired or revoked; this attempt created no seat. Ask the operator for a new code.",
      upgrade_required: "Update cswarm and run mcp connect again; this attempt created no seat.",
      principal_limit_reached: "The workspace has no free agent seat; this attempt created no seat. Ask the operator.",
      invalid_request: "The request was refused; this attempt created no seat. Ask the operator for a new code.",
      payload_too_large: "The request was refused; this attempt created no seat. Ask the operator for a new code.",
      not_found: "Check --url; this attempt created no seat.",
      method_not_allowed: "Check --url; this attempt created no seat.",
    };
    assert.deepEqual(Object.keys(noSeatRemedies).sort(), Object.keys(REGISTER_NO_SEAT_THIS_ATTEMPT).sort());
    const messages: string[] = [];
    for (const code of [...Object.keys(REGISTER_NO_SEAT_THIS_ATTEMPT), ...Object.keys(REGISTER_EXISTING_SEAT_REFUSALS)]) {
      f.refuse(code);
      const path = join(f.root, code, "profile.json");
      await assert.rejects(connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher: f.fetcher }), error => {
        assert.equal((error as {code:string}).code, code);
        const message = (error as Error).message;
        messages.push(message);
        assert.equal(message, noSeatRemedies[code] ?? "This code was already used. If you did not use it, someone else may have: tell the operator to revoke that agent and issue a new code.");
        assert.doesNotMatch(message, /was not used/i);
        assert.doesNotMatch(message, /swm_join_|swm_agt_/);
        return true;
      });
      await assert.rejects(stat(path), { code: "ENOENT" });
    }
    assert.equal(f.calls(), 10);
    assert.equal(messages.length, 10);
    f.refuse(JOIN);
    const path = join(f.root, "hostile-error", "profile.json");
    await assert.rejects(connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher: f.fetcher }),
      { code: "register_outcome_unknown", message: "The seat may have been created. Ask the operator to revoke it with cswarm principal revoke and issue a new code." });
    assert.equal(f.calls(), 11);
  } finally { await f.close(); }
});

test("a previously redeemed code can later receive forbidden without claiming the code was unused", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    await connectMcp({ target: TARGET, profilePath: join(f.root, "first", "profile.json"), readCode: async () => JOIN, fetcher: f.fetcher });
    f.refuse("forbidden");
    await assert.rejects(connectMcp({ target: TARGET, profilePath: join(f.root, "later", "profile.json"), readCode: async () => JOIN, fetcher: f.fetcher }),
      { code: "forbidden", message: "This code is unknown, expired or revoked; this attempt created no seat. Ask the operator for a new code." });
    assert.equal(f.calls(), 2);
  } finally { await f.close(); }
});

async function cli(argv: string[], env: Record<string, string>, input?: string) {
  const child = spawn(process.execPath, [resolve("dist/cli.js"), ...argv], { env: { PATH: process.env.PATH ?? "", ...env }, stdio: ["pipe", "pipe", "pipe"] });
  if (input !== undefined) child.stdin.end(input);
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
    // A plain pipe or redirect is refused; a same-user pseudo-terminal wrapper is not detected.
    const piped = await cli(base, { HOME: root }, `${JOIN}\n`);
    assert.equal(piped.code, 1);
    assert.match(piped.stderr, /terminal_required/);
    assert.doesNotMatch(piped.stdout + piped.stderr, /swm_join_|swm_agt_/);
    assert.deepEqual((await readdir(root)).filter(name => name !== "code.txt"), []);
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

test("every uncertain committed register and save failure instructs revocation without leaking secrets", { timeout: 15000 }, async () => {
  let mode = "";
  let commits = 0;
  const accepted = { status: "accepted", workspace_id: WS, principal_id: PRINCIPAL, run_id: RUN,
    token_id: TOKEN_ID, agent_token: TOKEN, expires_at: "2099-01-01T00:00:00Z" };
  const server = createServer(async (request, response) => {
    let input = "";
    for await (const chunk of request) input += chunk;
    assert.equal(JSON.parse(input).joinCredential, JOIN);
    commits++;
    if (mode === "cut") { response.writeHead(200, { "content-type": "application/json" }); response.write('{"status":"accepted","agent_token":"swm_agt_'); response.destroy(); return; }
    if (mode === "garbage") { response.writeHead(200, { "content-type": "application/json" }); response.end(`garbage ${TOKEN}`); return; }
    if (mode === "502") { response.writeHead(502, { "content-type": "application/json" }); response.end('{"error":"upstream_failure"}'); return; }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(mode === "invalid" ? { ...accepted, agent_token: "swm_agt_short" } : accepted));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const target = cloudTarget(`http://127.0.0.1:${address.port}`, TARGET.anonKey);
  const root = await mkdtemp(join(tmpdir(), "cswarm-mcp-committed-"));
  try {
    for (mode of ["save", "garbage", "cut", "502", "invalid"]) {
      const before = commits;
      const path = join(root, mode, "profile.json");
      await assert.rejects(connectMcp({ target, profilePath: path, readCode: async () => JOIN,
        ...(mode === "save" ? { saveProfile: async () => { throw new Error(`EIO ${TOKEN}`); } } : {}) }), error => {
        assert.equal((error as { code: string }).code, "register_outcome_unknown");
        assert.equal((error as Error).message, "The seat may have been created. Ask the operator to revoke it with cswarm principal revoke and issue a new code.");
        assert.doesNotMatch(String(error), /swm_join_|swm_agt_/);
        return true;
      });
      assert.equal(commits, before + 1);
      await assert.rejects(stat(path), { code: "ENOENT" });
    }
  } finally {
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("two committed connects racing for one profile give the loser revoke advice", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const path = join(f.root, "race", "profile.json");
    const fetcher: typeof fetch = async () => Response.json({ status: "accepted", workspace_id: WS, principal_id: PRINCIPAL,
      run_id: RUN, token_id: TOKEN_ID, agent_token: TOKEN, expires_at: "2099-01-01T00:00:00Z" });
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const readCode = async () => { if (++arrivals === 2) release(); await barrier; return JOIN; };
    const results = await Promise.allSettled([connectMcp({ target: TARGET, profilePath: path, readCode, fetcher }), connectMcp({ target: TARGET, profilePath: path, readCode, fetcher })]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    const loser = results.find(result => result.status === "rejected") as PromiseRejectedResult;
    assert.equal(loser.reason.code, "register_outcome_unknown");
    assert.match(loser.reason.message, /cswarm principal revoke/);
  } finally { await f.close(); }
});

test("register redirects do not forward a join code to another origin", { timeout: 10000 }, async () => {
  let received = 0;
  const destination = createServer((_request, response) => { received++; response.end("unexpected"); });
  destination.listen(0, "127.0.0.1");
  await once(destination, "listening");
  const destinationAddress = destination.address();
  assert.ok(destinationAddress && typeof destinationAddress === "object");
  const source = createServer((_request, response) => { response.writeHead(308, { location: `http://127.0.0.1:${destinationAddress.port}/stolen` }); response.end(); });
  source.listen(0, "127.0.0.1");
  await once(source, "listening");
  const sourceAddress = source.address();
  assert.ok(sourceAddress && typeof sourceAddress === "object");
  const root = await mkdtemp(join(tmpdir(), "cswarm-mcp-redirect-"));
  try {
    await assert.rejects(connectMcp({ target: cloudTarget(`http://127.0.0.1:${sourceAddress.port}`, TARGET.anonKey), profilePath: join(root, "profile.json"), readCode: async () => JOIN }), { code: "register_redirected" });
    assert.equal(received, 0);
  } finally { source.close(); destination.close(); await rm(root, { recursive: true, force: true }); }
});

test("Fold 1 evidence states the measured TTY limit and output without gating a historical bundle SHA", { timeout: 10000 }, async () => {
  const lane = await readFile("docs/evidence/2026-09-24-mcp-release2/LANE.md", "utf8");
  assert.match(lane, /A plain pipe or redirect is refused; a same-user pseudo-terminal wrapper is not detected/);
  assert.match(lane, /Connect prints only the profile path and the Claude Code and Codex install lines/);
  assert.doesNotMatch(lane, /Connect prints only profile path, principal ID/);
  assert.match(lane, /npm fallback sentence/);
  assert.match(lane, /SHA-256 of the build in .* at commit/);
  const testSource = await readFile(new URL(import.meta.url), "utf8");
  assert.equal(testSource.includes(["dist-release", "cswarm.sha256"].join("/")), false, "no location-dependent bundle SHA gate");
  for (const phrase of ["The five retained fallback-prompt shortenings", "Connect to CommonSwarm. Keep the file private", "Confirm cswarm setup --check-version", "Run setup --json. Reuse its --profile", "Wake works with Claude Code preview channels or the local Grok Bot gateway", "Read brain topics; post intent and reply"]) assert.ok(lane.includes(phrase), `Fold 3 must disclose: ${phrase}`);
});


test("typed register refusals require their server status", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    for (const [code, status] of [["forbidden", 500], ["join_credential_seat_cap_reached", 500], ["forbidden", 200], ["command_id_conflict", 409]] as const) {
      await assert.rejects(connectMcp({ target: TARGET, profilePath: join(f.root, `${code}-${status}`, "profile.json"),
        readCode: async () => JOIN, fetcher: async () => Response.json({ error: code }, { status }) }),
      { code: "register_outcome_unknown", message: "The seat may have been created. Ask the operator to revoke it with cswarm principal revoke and issue a new code." });
    }
  } finally { await f.close(); }
});

test("cancelled and refused connect removes only a newly created empty profile directory", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const fresh = join(f.root, "fresh");
    await assert.rejects(connectMcp({ target: TARGET, profilePath: join(fresh, "profile.json"),
      readCode: async () => { throw new Error("cancelled"); }, fetcher: f.fetcher }), /cancelled/);
    await assert.rejects(stat(fresh), { code: "ENOENT" });
    const refused = join(f.root, "refused");
    f.refuse("forbidden");
    await assert.rejects(connectMcp({ target: TARGET, profilePath: join(refused, "profile.json"),
      readCode: async () => JOIN, fetcher: f.fetcher }), { code: "forbidden" });
    await assert.rejects(stat(refused), { code: "ENOENT" });
    const existing = join(f.root, "existing");
    await mkdir(existing, { mode: 0o700 });
    await assert.rejects(connectMcp({ target: TARGET, profilePath: join(existing, "profile.json"),
      readCode: async () => { throw new Error("cancelled"); }, fetcher: f.fetcher }), /cancelled/);
    assert.equal((await stat(existing)).isDirectory(), true);
    assert.equal(f.calls(), 1);
  } finally { await f.close(); }
});

test("cleanup EACCES after a committed 502 preserves the revoke instruction", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    let commits = 0;
    let cleanups = 0;
    const path = join(f.root, "cleanup-failure", "profile.json");
    await assert.rejects(connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN,
      fetcher: async () => { commits++; return Response.json({ error: "upstream_failure" }, { status: 502 }); },
      removeEmptyDirectory: async () => { cleanups++; throw Object.assign(new Error("EACCES removing profile directory"), { code: "EACCES" }); },
    }), { code: "register_outcome_unknown", message: "The seat may have been created. Ask the operator to revoke it with cswarm principal revoke and issue a new code." });
    assert.equal(commits, 1);
    assert.equal(cleanups, 1);
    assert.equal(existsSync(dirname(path)), true, "failed cleanup leaves its own empty directory");
  } finally { await f.close(); }
});

test("signals synchronously remove only the empty profile directory this connect created", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    for (const signal of ["SIGINT", "SIGTERM"] as const) for (const existing of [false, true]) {
      const dir = join(f.root, `${signal}-${existing}`);
      if (existing) await mkdir(dir, { mode: 0o700 });
      const input = new PassThrough();
      const signals = new EventEmitter();
      const echoes: boolean[] = [];
      const exits: number[] = [];
      let prompted!: () => void;
      const promptReady = new Promise<void>(resolve => { prompted = resolve; });
      const terminal: HiddenTerminal = {
        isTTY: true, input, signals, echo: on => { echoes.push(on); },
        write: value => { if (value === "Connect code: ") prompted(); },
        exit: code => {
          assert.equal(existsSync(dir), existing, "cleanup completes before process exit");
          exits.push(code);
          input.end();
        },
      };
      const pending = connectMcp({ target: TARGET, profilePath: join(dir, "profile.json"), terminal, fetcher: f.fetcher });
      await promptReady;
      signals.emit(signal);
      await assert.rejects(pending, { code: "code_missing" });
      assert.deepEqual(exits, [signal === "SIGINT" ? 130 : 143]);
      assert.deepEqual(echoes, [false, true]);
      assert.equal(existsSync(dir), existing);
    }
    assert.equal(f.calls(), 0);
  } finally { await f.close(); }
});

test("mcp code and connect failures use their own labels; serve retains startup label", { timeout: 15000 }, async () => {
  assert.equal(mcpFailureCode(new Error("generic"), "code"), "mcp_code_failed");
  assert.equal(mcpFailureCode(new Error("generic"), "connect"), "mcp_connect_failed");
  assert.equal(mcpFailureCode(new Error("generic"), "serve"), "mcp_start_failed");
  const root = await mkdtemp(join(tmpdir(), "cswarm-mcp-labels-"));
  try {
    const code = await cli(["mcp", "code", "--url", TARGET.url, "--anon-key", TARGET.anonKey], { HOME: root, CSWARM_SITE: "http://127.0.0.1:9" });
    assert.match(code.stderr, /\[mcp_code_failed\]/);
    const connect = await cli(["mcp", "connect", "--url", TARGET.url, "--anon-key", TARGET.anonKey], { HOME: root, CSWARM_SITE: "http://127.0.0.1:9" });
    assert.match(connect.stderr, /\[terminal_required\]/);
    const serve = await cli(["mcp", "--url", TARGET.url], { HOME: root, CSWARM_SITE: "http://127.0.0.1:9" });
    assert.match(serve.stderr, /\[mcp_start_failed\]/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
