import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { PassThrough } from "node:stream";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { cloudTarget } from "../../src/cloud/config.js";
import { mcpFailureCode, mcpFailureMessage } from "../../src/cli.js";
import { writeCurrentTarget } from "../../src/cloud/current-target.js";
import { classifyAttemptMarkerReadFailure, classifyDirectoryFailure, clearMcpConnect, connectMcp, mintMcpCode, readHiddenJoinCode, renderMcpCode, renderMcpConnect, type HiddenTerminal } from "../../src/cloud/mcp-connect.js";
import { readAgentProfile, readProfileCredential, saveAgentProfile } from "../../src/cloud/agent-profile.js";
import { setupAgent } from "../../src/cloud/agent-setup.js";
import { Arguments } from "../../src/cli.js";
import { REGISTER_REFUSALS, REGISTER_NO_SEAT_THIS_ATTEMPT, REGISTER_EXISTING_SEAT_REFUSALS } from "../../src/cloud/mcp-register-refusals.js";
import { withFileLock, writeSecureJsonFile, writeSecureJsonFileExclusive } from "../../src/cloud/storage.js";
import { AGENT_CREDENTIAL_MESSAGE_D088 } from "../../src/cloud/agent-credential-input.js";
import { CONNECT_PROFILE_FILES, reservedConnectProfileNames } from "../../src/cloud/connect-profile-files.js";
import { MCP_ERROR_SENTENCES } from "../../src/mcp/errors.js";

const WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PRINCIPAL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RUN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TOKEN_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const JOIN = `swm_join_${"J".repeat(43)}`;
const TOKEN = `swm_agt_${"T".repeat(43)}`;
const TARGET = cloudTarget("http://127.0.0.1:39876", "public-test-key");

test("Fold 9 reserved profile basenames refuse before POST and name the writer set", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const names = [CONNECT_PROFILE_FILES.pending, CONNECT_PROFILE_FILES.complete, CONNECT_PROFILE_FILES.attemptMarker, CONNECT_PROFILE_FILES.credential,
      CONNECT_PROFILE_FILES.setupLock, CONNECT_PROFILE_FILES.connectLock,
      ...CONNECT_PROFILE_FILES.temporaryBases.map(base => `${base}.123.abcdefabcdef.tmp`),
      "custom.123.abcdefabcdef.tmp"];
    for (const name of names) {
      await assert.rejects(connectMcp({ target: TARGET, profilePath: join(f.root, "reserved", name), readCode: async () => JOIN,
        fetcher: f.fetcher }), error => {
        assert.equal((error as { code: string }).code, "profile_path_reserved");
        assert.ok(String(error).includes(reservedConnectProfileNames()));
        return true;
      });
    }
    assert.equal(f.calls(), 0);
  } finally { await f.close(); }
});

test("Fold 9 unsupported hard links use exclusive final creation and recover a working profile", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const path = join(f.root, "no-links", "profile.json");
    const attempts = new Set<string>();
    let posts = 0;
    const fetcher: typeof fetch = async (_input, init) => {
      posts++;
      attempts.add(JSON.parse(String(init?.body)).attemptId);
      return Response.json({ status: "accepted", workspace_id: WS, principal_id: PRINCIPAL,
        run_id: RUN, token_id: TOKEN_ID, agent_token: TOKEN, expires_at: "2099-01-01T00:00:00Z" });
    };
    await assert.rejects(connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher,
      saveProfile: async () => { throw new Error("interrupted save"); } }), { code: "register_outcome_unknown" });
    const refusedLink = async () => { throw Object.assign(new Error("hard links unavailable"), { code: "EPERM" }); };
    await connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher,
      saveProfile: (file, connection, workspace, session, exclusive, orphan, principal, _write, attemptId) =>
        saveAgentProfile(file, connection, workspace, session, exclusive, orphan, principal,
          (credential, serialized) => writeSecureJsonFileExclusive(credential, serialized, undefined, refusedLink), attemptId),
    });
    assert.equal(posts, 2);
    assert.equal(attempts.size, 1, "retry reuses one seat attempt");
    assert.equal((await readAgentProfile(path)).principal_id, PRINCIPAL);
    assert.equal((await readProfileCredential(await readAgentProfile(path))).token, TOKEN);
    assert.deepEqual((await readdir(dirname(path))).filter(name => name === CONNECT_PROFILE_FILES.credential), [CONNECT_PROFILE_FILES.credential]);
    await assert.rejects(connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher }), { code: "profile_exists" });
    assert.equal(posts, 2);
    for (const code of ["ENOTSUP", "ENOSYS", "EXDEV"] as const) {
      const file = join(dirname(path), `${code}.json`);
      await writeSecureJsonFileExclusive(file, `{ "code": "${code}" }`, undefined,
        async () => { throw Object.assign(new Error("hard links unavailable"), { code }); });
      assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { code });
    }
  } finally { await f.close(); }
});

test("Fold 10 killed wx claims and fallback temps recover the same pending connect", { timeout: 20000 }, async () => {
  const f = await fixture();
  let child: ReturnType<typeof spawn> | null = null;
  let posts = 0;
  const fetcher: typeof fetch = async () => {
    posts++;
    return Response.json({ status: "accepted", workspace_id: WS, principal_id: PRINCIPAL,
      run_id: RUN, token_id: TOKEN_ID, agent_token: TOKEN, expires_at: "2099-01-01T00:00:00Z" });
  };
  try {
    for (const killPoint of ["claim", "mid-temp"] as const) {
      const path = join(f.root, killPoint, "profile.json");
      await assert.rejects(connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN,
        fetcher, saveProfile: async () => { throw new Error("interrupted save"); } }), { code: "register_outcome_unknown" });
      const credential = join(dirname(path), "credential.json");
      const storageUrl = new URL("../../src/cloud/storage.ts", import.meta.url).href;
      const script = `import { writeSecureJsonFileExclusive } from ${JSON.stringify(storageUrl)};
        let writes = 0;
        await writeSecureJsonFileExclusive(process.argv[1], '{}', async (handle, data) => {
          writes++;
          if (writes === 2) {
            if (process.argv[2] === 'mid-temp') await handle.writeFile('{');
            process.stdout.write('ready\\n');
            await new Promise(() => {});
          }
          await handle.writeFile(data);
        }, async () => { throw Object.assign(new Error('no links'), { code: 'EPERM' }); });`;
      child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, credential, killPoint],
        { stdio: ["ignore", "pipe", "pipe"] });
      await once(child.stdout!, "data");
      assert.equal((await readFile(credential)).length, 0, "the claimed path stays empty until rename");
      child.kill("SIGKILL");
      await once(child, "exit");
      child = null;
      assert.equal((await readFile(credential)).length, 0);
      await connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher });
      assert.equal((await readAgentProfile(path)).principal_id, PRINCIPAL);
      assert.equal((await readProfileCredential(await readAgentProfile(path))).token, TOKEN);
      assert.deepEqual((await readdir(dirname(path))).filter(name => name.endsWith(".tmp")), []);
    }
    assert.equal(posts, 4);
  } finally {
    if (child) { child.kill("SIGKILL"); await once(child, "exit").catch(() => undefined); }
    await f.close();
  }
});

test("Fold 10 two wx claimants publish one complete credential", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const file = join(f.root, "claimants", "credential.json");
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const noLinks = async () => { throw Object.assign(new Error("no links"), { code: "EPERM" }); };
    const results = await Promise.allSettled([1, 2].map(writer =>
      writeSecureJsonFileExclusive(file, JSON.stringify({ writer }), undefined, noLinks)));
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(results.filter(result => result.status === "rejected" && (result.reason as { code?: string }).code === "EEXIST").length, 1);
    assert.ok([1, 2].includes(JSON.parse(await readFile(file, "utf8")).writer));
    assert.deepEqual((await readdir(dirname(file))).filter(name => name.endsWith(".tmp")), []);
  } finally { await f.close(); }
});

test("Fold 10 changed wx claim preserves an intervening credential", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const file = join(f.root, "changed-claim", "credential.json");
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    let writes = 0;
    await assert.rejects(writeSecureJsonFileExclusive(file, '{"writer":"first"}', async (handle, contents) => {
      writes++;
      await handle.writeFile(contents);
      if (writes === 2) {
        await unlink(file);
        await writeFile(file, '{"writer":"intervening"}', { mode: 0o600 });
      }
    }, async () => { throw Object.assign(new Error("no links"), { code: "EPERM" }); }), { code: "EEXIST" });
    assert.equal((await readFile(file, "utf8")), '{"writer":"intervening"}');
    assert.deepEqual((await readdir(dirname(file))).filter(name => name.endsWith(".tmp")), []);
  } finally { await f.close(); }
});

test("Fold 11 open claim rejects a replacement before rename", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const file = join(f.root, "open-claim", "credential.json");
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    let checks = 0;
    await assert.rejects(writeSecureJsonFileExclusive(file, '{"writer":"first"}', undefined,
      async () => { throw Object.assign(new Error("no links"), { code: "EPERM" }); },
      async handle => {
        const identity = await handle.stat();
        if (checks++ === 0) {
          await unlink(file);
          await writeFile(file, '{"writer":"replacement"}', { mode: 0o600 });
        }
        return identity;
      }), { code: "EEXIST" });
    assert.ok(checks >= 2, "the open descriptor also protects cleanup");
    assert.equal(await readFile(file, "utf8"), '{"writer":"replacement"}');
    assert.deepEqual((await readdir(dirname(file))).filter(name => name.endsWith(".tmp")), []);
  } finally { await f.close(); }
});

test("Fold 10 explicit profile repairs an old interrupted rebuild without POST", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const path = join(f.root, "rebuild-kill", "profile.json");
    await connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher: f.fetcher });
    for (const partial of ["{", ""]) {
      await writeFile(path, partial, { mode: 0o600 });
      await connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher: f.fetcher });
      assert.equal((await readAgentProfile(path)).principal_id, PRINCIPAL);
    }
    assert.equal(f.calls(), 1, "the completion record repairs the profile locally");
  } finally { await f.close(); }
});

test("Fold 11 setup-bound profile survives a same-code connect", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const path = join(f.root, "setup-bound", "profile.json");
    await connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher: f.fetcher });
    const original = await readAgentProfile(path);
    await saveAgentProfile(path, { version: 1, url: original.url, anon_key: original.anon_key,
      workspace_id: original.workspace_id, principal_id: original.principal_id,
      credential: JSON.parse(await readFile(original.credential_file, "utf8")) }, undefined, "setup-session");
    const boundBytes = await readFile(path);
    assert.equal((await readAgentProfile(path, "setup-session")).host_session_id, "setup-session");
    await assert.rejects(connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher: f.fetcher }), { code: "profile_exists" });
    assert.deepEqual(await readFile(path), boundBytes);
    assert.equal(f.calls(), 1);
  } finally { await f.close(); }
});

test("Fold 12 pending resume keeps a host-bound working profile from this attempt", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const path = join(f.root, "pending-bound", "profile.json");
    await connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher: f.fetcher });
    const original = await readAgentProfile(path);
    const connectRecord = JSON.parse(await readFile(join(dirname(path), CONNECT_PROFILE_FILES.complete), "utf8"));
    const markerPath = join(dirname(path), CONNECT_PROFILE_FILES.attemptMarker);
    assert.equal(JSON.parse(await readFile(markerPath, "utf8")).attemptId, connectRecord.attemptId);
    assert.equal((await stat(markerPath)).mode & 0o777, 0o600);
    await writeSecureJsonFile(path, JSON.stringify({ ...original, host_session_id: "setup-session" }));
    const boundBytes = await readFile(path);
    const complete = join(dirname(path), "connect-complete.json");
    const pending = join(dirname(path), "connect-pending.json");
    const record = JSON.parse(await readFile(complete, "utf8"));
    await writeSecureJsonFile(pending, JSON.stringify({ attemptId: record.attemptId, url: record.url,
      name: "MCP agent", codeHash: record.codeHash, createdAt: new Date().toISOString() }));
    let resumePosts = 0;
    const result = await connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN,
      fetcher: async () => { resumePosts++; throw new Error("unexpected POST"); } });
    assert.equal(result.profile, path);
    assert.equal(resumePosts, 0);
    assert.equal(existsSync(pending), false);
    assert.deepEqual(await readFile(path), boundBytes);
    assert.doesNotMatch(renderMcpConnect(result), /damaged|mv /);
    const claude = result.install.split("\n")[0]!;
    const printed = claude.match(/-- cswarm 'mcp' '--profile' '([^']+)' '--host-session-id' '([^']+)'$/);
    assert.ok(printed, "host-bound Claude install line includes the session option");
    const args = new Arguments(["mcp", "--profile", printed[1]!, "--host-session-id", printed[2]!]);
    args.assertShape(["profile", "host-session-id"], 1);
    assert.equal((await readAgentProfile(args.required("profile"), args.optional("host-session-id"))).principal_id, PRINCIPAL);
    const codexArgs = JSON.parse(result.install.match(/args = (\[[^\n]+\])/)![1]!) as string[];
    const codex = new Arguments(codexArgs);
    codex.assertShape(["profile", "host-session-id"], 1);
    assert.equal((await readAgentProfile(codex.required("profile"), codex.optional("host-session-id"))).principal_id, PRINCIPAL);
  } finally { await f.close(); }
});

test("Fold 15 wrong-mode attempt marker gives an exact repair and same-command resume", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const path = join(f.root, "marker-mode", "profile.json");
    await connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher: f.fetcher });
    const dir = dirname(path);
    const marker = join(dir, CONNECT_PROFILE_FILES.attemptMarker);
    const complete = JSON.parse(await readFile(join(dir, CONNECT_PROFILE_FILES.complete), "utf8"));
    const pending = join(dir, CONNECT_PROFILE_FILES.pending);
    await writeSecureJsonFile(pending, JSON.stringify({ attemptId: complete.attemptId, url: complete.url,
      name: "MCP agent", codeHash: complete.codeHash, createdAt: new Date().toISOString() }));
    const profileBytes = await readFile(path);
    let posts = 0;
    const noPost: typeof fetch = async () => { posts++; throw new Error("unexpected POST"); };
    await chmod(marker, 0o644);
    await assert.rejects(connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher: noPost }), error => {
      assert.equal((error as { code: string }).code, "connect_marker_mode");
      assert.ok(String(error).includes(`chmod 600 '${marker}'`));
      assert.match(String(error), /rerun the same command/);
      assert.doesNotMatch(String(error), /not written by the pending connect|new --profile/);
      return true;
    });
    assert.equal(posts, 0);
    assert.deepEqual(await readFile(path), profileBytes);
    assert.equal(existsSync(pending), true);
    await chmod(marker, 0o600);
    const result = await connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher: noPost });
    assert.equal(result.profile, path);
    assert.equal(posts, 0);
    assert.equal(existsSync(pending), false);
  } finally { await f.close(); }
});

test("Fold 16 pending without profile classifies marker mode before register", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const path = join(f.root, "pending-marker-mode", "profile.json");
    await assert.rejects(connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN,
      fetcher: async () => { throw new Error("lost response"); } }), { code: "register_outcome_unknown" });
    const marker = join(dirname(path), CONNECT_PROFILE_FILES.attemptMarker);
    const pending = join(dirname(path), CONNECT_PROFILE_FILES.pending);
    const pendingBytes = await readFile(pending);
    await writeFile(marker, JSON.stringify({ attemptId: JSON.parse(pendingBytes.toString()).attemptId }), { mode: 0o644 });
    let posts = 0;
    const noPost: typeof fetch = async () => { posts++; throw new Error("unexpected POST"); };
    await assert.rejects(connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher: noPost }), error => {
      assert.equal((error as { code: string }).code, "connect_marker_mode");
      assert.ok(String(error).includes(`chmod 600 '${marker}'`));
      assert.match(String(error), /rerun the same command/);
      assert.doesNotMatch(String(error), /register outcome is unknown|credential file must be mode/);
      return true;
    });
    assert.equal(posts, 0);
    assert.equal(existsSync(path), false);
    assert.deepEqual(await readFile(pending), pendingBytes);
    await chmod(marker, 0o600);
    await connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher: f.fetcher });
    assert.equal((await readAgentProfile(path)).principal_id, PRINCIPAL);
  } finally { await f.close(); }
});

test("Fold 16 completion rebuild classifies marker mode before rewriting it", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const path = join(f.root, "rebuild-marker-mode", "profile.json");
    await connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher: f.fetcher });
    const marker = join(dirname(path), CONNECT_PROFILE_FILES.attemptMarker);
    await unlink(path);
    await chmod(marker, 0o644);
    const markerBytes = await readFile(marker);
    let posts = 0;
    const noPost: typeof fetch = async () => { posts++; throw new Error("unexpected POST"); };
    await assert.rejects(connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher: noPost }), error => {
      assert.equal((error as { code: string }).code, "connect_marker_mode");
      assert.ok(String(error).includes(`chmod 600 '${marker}'`));
      assert.match(String(error), /rerun the same command/);
      assert.doesNotMatch(String(error), /credential file must be mode/);
      return true;
    });
    assert.equal(posts, 0);
    assert.equal(existsSync(path), false);
    assert.deepEqual(await readFile(marker), markerBytes);
    await chmod(marker, 0o600);
    await connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher: noPost });
    assert.equal(posts, 0);
    assert.equal((await readAgentProfile(path)).principal_id, PRINCIPAL);
  } finally { await f.close(); }
});

test("Fold 16 marker read failure names a wrong-mode directory before an unsafe marker", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const dir = join(f.root, "marker-directory-mode");
    const marker = join(dir, CONNECT_PROFILE_FILES.attemptMarker);
    await mkdir(dir, { mode: 0o700 });
    await symlink(join(f.root, "elsewhere"), marker);
    await chmod(dir, 0o755);
    await assert.rejects(classifyAttemptMarkerReadFailure(marker), error => {
      assert.equal((error as { code: string }).code, "connect_directory_mode");
      assert.ok(String(error).includes(`chmod 700 '${dir}'`));
      assert.match(String(error), /rerun the same command/);
      return true;
    });
    await chmod(dir, 0o700);
    await assert.rejects(classifyAttemptMarkerReadFailure(marker), { code: "connect_marker_unreadable" });
  } finally { await f.close(); }
});

test("Fold 15 unsafe attempt marker gets a typed file-specific refusal before POST", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const path = join(f.root, "marker-unsafe", "profile.json");
    await connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher: f.fetcher });
    const dir = dirname(path);
    const marker = join(dir, CONNECT_PROFILE_FILES.attemptMarker);
    const complete = JSON.parse(await readFile(join(dir, CONNECT_PROFILE_FILES.complete), "utf8"));
    const pending = join(dir, CONNECT_PROFILE_FILES.pending);
    await writeSecureJsonFile(pending, JSON.stringify({ attemptId: complete.attemptId, url: complete.url,
      name: "MCP agent", codeHash: complete.codeHash, createdAt: new Date().toISOString() }));
    await unlink(marker);
    await symlink(join(f.root, "elsewhere"), marker);
    let posts = 0;
    await assert.rejects(connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN,
      fetcher: async () => { posts++; throw new Error("unexpected POST"); } }), error => {
      assert.equal((error as { code: string }).code, "connect_marker_unreadable");
      assert.ok(String(error).includes(marker));
      assert.doesNotMatch(String(error), /not written by the pending connect|new --profile/);
      return true;
    });
    assert.equal(posts, 0);
    assert.equal(existsSync(pending), true);
  } finally { await f.close(); }
});

test("Fold 13 pending profile must belong to this connect attempt", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    for (const kind of ["another-agent", "another-attempt"] as const) {
      const path = join(f.root, kind, "profile.json");
      await assert.rejects(connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN,
        fetcher: async () => { throw new Error("lost response"); } }), { code: "register_outcome_unknown" });
      const pending = join(dirname(path), CONNECT_PROFILE_FILES.pending);
      const pendingBytes = await readFile(pending);
      const attemptId = JSON.parse(pendingBytes.toString()).attemptId;
      const principal = kind === "another-agent" ? "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" : PRINCIPAL;
      const credential = join(dirname(path), CONNECT_PROFILE_FILES.credential);
      await writeSecureJsonFile(credential, JSON.stringify({ message: AGENT_CREDENTIAL_MESSAGE_D088, status: "accepted",
        principal_id: principal, run_id: RUN, token_id: TOKEN_ID, agent_token: TOKEN, expires_at: "2099-01-01T00:00:00Z" }));
      await writeSecureJsonFile(path, JSON.stringify({ version: 1, url: TARGET.url, anon_key: TARGET.anonKey,
        workspace_id: WS, principal_id: principal, credential_file: credential }));
      const marker = join(dirname(path), CONNECT_PROFILE_FILES.attemptMarker);
      if (kind === "another-attempt") await writeSecureJsonFile(marker, JSON.stringify({ attemptId: "11111111-1111-4111-8111-111111111111" }));
      assert.notEqual(existsSync(marker) ? JSON.parse(await readFile(marker, "utf8")).attemptId : undefined, attemptId);
      const profileBytes = await readFile(path);
      const credentialBytes = await readFile(credential);
      let posts = 0;
      await assert.rejects(connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN,
        fetcher: async () => { posts++; throw new Error("unexpected POST"); } }), error => {
        assert.equal((error as { code: string }).code, "connect_profile_other_attempt");
        assert.ok(String(error).includes(path));
        assert.ok(String(error).includes(pending));
        assert.match(String(error), /new --profile path/);
        return true;
      });
      assert.equal(posts, 0);
      assert.deepEqual(await readFile(path), profileBytes);
      assert.deepEqual(await readFile(credential), credentialBytes);
      assert.deepEqual(await readFile(pending), pendingBytes);
      if (kind === "another-attempt") assert.deepEqual(JSON.parse(await readFile(marker, "utf8")), { attemptId: "11111111-1111-4111-8111-111111111111" });
      assert.equal(existsSync(join(dirname(path), CONNECT_PROFILE_FILES.complete)), false);
    }
  } finally { await f.close(); }
});

test("Fold 13 setup refuses a directory with a connect pending record before network", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const path = join(f.root, "setup-pending", "profile.json");
    await assert.rejects(connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN,
      fetcher: async () => { throw new Error("lost response"); } }), { code: "register_outcome_unknown" });
    const pending = join(dirname(path), CONNECT_PROFILE_FILES.pending);
    const connectionFile = join(f.root, "connection.json");
    await writeFile(connectionFile, JSON.stringify({ version: 1, url: TARGET.url, anon_key: TARGET.anonKey,
      workspace_id: WS, principal_id: PRINCIPAL, credential: { message: AGENT_CREDENTIAL_MESSAGE_D088,
        status: "accepted", principal_id: PRINCIPAL, run_id: RUN, token_id: TOKEN_ID,
        agent_token: TOKEN, expires_at: "2099-01-01T00:00:00Z" } }), { mode: 0o600 });
    const pendingBytes = await readFile(pending);
    let requests = 0;
    await assert.rejects(setupAgent({ connectionFile, profilePath: path, hostSessionId: "setup-session",
      fetcher: async () => { requests++; throw new Error("unexpected request"); } }), error => {
      assert.equal((error as { code: string }).code, "setup_connect_pending");
      assert.ok(String(error).includes(pending));
      return true;
    });
    assert.equal(requests, 0);
    assert.deepEqual(await readFile(pending), pendingBytes);
    assert.equal(existsSync(path), false);
  } finally { await f.close(); }
});

test("Fold 14 setup and connect serialize the pending check with the profile write", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const path = join(f.root, "interleaved", "profile.json");
    const pending = join(dirname(path), CONNECT_PROFILE_FILES.pending);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const connection = { version: 1 as const, url: TARGET.url, anon_key: TARGET.anonKey,
      workspace_id: WS, principal_id: PRINCIPAL, credential: { message: AGENT_CREDENTIAL_MESSAGE_D088,
        status: "accepted", principal_id: PRINCIPAL, run_id: RUN, token_id: TOKEN_ID,
        agent_token: TOKEN, expires_at: "2099-01-01T00:00:00Z" } };
    let connectWrite: Promise<void> | undefined;
    let pendingDuringWrite = false;
    await saveAgentProfile(path, connection, undefined, "setup-session", false, false, undefined,
      undefined, undefined, async (credential, serialized) => {
        connectWrite = withFileLock(dirname(path), CONNECT_PROFILE_FILES.connectLock.slice(0, -5), async () => {
          await writeSecureJsonFile(pending, JSON.stringify({ attemptId: "11111111-1111-4111-8111-111111111111",
            url: TARGET.url, name: "MCP agent", codeHash: "a".repeat(64), createdAt: new Date().toISOString() }));
        });
        await new Promise(resolve => setTimeout(resolve, 100));
        pendingDuringWrite = existsSync(pending);
        await writeSecureJsonFile(credential, serialized);
      });
    await connectWrite;
    assert.equal(pendingDuringWrite, false, "connect cannot write pending during setup's locked write");
    assert.equal(existsSync(pending), true);
    assert.equal((await readAgentProfile(path, "setup-session")).principal_id, PRINCIPAL);
  } finally { await f.close(); }
});

test("Fold 14 connect writes a v0.1.77-shaped profile and keeps its attempt marker private", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const path = join(f.root, "old-reader", "profile.json");
    await connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher: f.fetcher });
    const profile = JSON.parse(await readFile(path, "utf8"));
    const required = ["version", "url", "anon_key", "workspace_id", "principal_id", "credential_file"];
    const keys = Object.keys(profile).sort().join();
    assert.ok(keys === [...required].sort().join() || keys === [...required, "workspace_name"].sort().join(),
      "released v0.1.77 key-set reader must accept the connect profile");
    const marker = join(dirname(path), CONNECT_PROFILE_FILES.attemptMarker);
    assert.equal((await stat(marker)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await readFile(marker, "utf8")).attemptId,
      JSON.parse(await readFile(join(dirname(path), CONNECT_PROFILE_FILES.complete), "utf8")).attemptId);
  } finally { await f.close(); }
});

test("Fold 14 pending setup refusal has owned MCP advice", { timeout: 10000 }, () => {
  assert.equal(MCP_ERROR_SENTENCES.setup_connect_pending?.next_step,
    "a person must restore this agent's access outside this session");
  assert.match(MCP_ERROR_SENTENCES.setup_connect_pending?.message ?? "", /connect in progress/);
});

test("Fold 11 default path repairs an empty profile claim without a move", { timeout: 10000 }, async () => {
  const f = await fixture();
  const previousHome = process.env.HOME;
  process.env.HOME = f.root;
  try {
    const connected = await connectMcp({ target: TARGET, readCode: async () => JOIN, fetcher: f.fetcher });
    await writeFile(connected.profile, "", { mode: 0o600 });
    const restored = await connectMcp({ target: TARGET, readCode: async () => JOIN, fetcher: f.fetcher });
    assert.equal(restored.profile, connected.profile);
    assert.equal((await readAgentProfile(restored.profile)).principal_id, PRINCIPAL);
    assert.equal(f.calls(), 1, "an empty rebuild claim needs no POST");
  } finally { if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome; await f.close(); }
});

test("Fold 11 clear and later refusal name an empty credential claim", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const path = join(f.root, "empty-credential-claim", "profile.json");
    await assert.rejects(connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN,
      fetcher: async () => { throw new Error("lost response"); } }), { code: "register_outcome_unknown" });
    const credential = join(dirname(path), "credential.json");
    await writeFile(credential, "", { mode: 0o600 });
    const cleared = await cli(["mcp", "connect", "--clear-pending", "--profile", path, "--url", TARGET.url], { HOME: f.root });
    assert.equal(cleared.code, 0, cleared.stderr);
    assert.match(cleared.stdout, /holds an empty claim file at credential\.json; the file was kept/);
    assert.doesNotMatch(cleared.stdout, /holds a credential/);
    await assert.rejects(connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN,
      fetcher: f.fetcher }), error => {
      assert.equal((error as { code: string }).code, "profile_exists");
      assert.match(String(error), /holds an empty claim file without a profile/);
      assert.doesNotMatch(String(error), /holds a credential/);
      return true;
    });
    assert.equal((await readFile(credential)).length, 0);
    assert.equal(f.calls(), 0);
  } finally { await f.close(); }
});

test("Fold 12 clear names a kept unvalidated profile beside an empty credential claim", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const path = join(f.root, "empty-claim-and-profile", "agent.json");
    await assert.rejects(connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN,
      fetcher: async () => { throw new Error("lost response"); } }), { code: "register_outcome_unknown" });
    const credential = join(dirname(path), "credential.json");
    await writeFile(credential, "", { mode: 0o600 });
    await writeFile(path, "{", { mode: 0o600 });
    const profileBytes = await readFile(path);
    const cleared = await cli(["mcp", "connect", "--clear-pending", "--profile", "~/empty-claim-and-profile/agent.json", "--url", TARGET.url], { HOME: f.root });
    assert.equal(cleared.code, 0, cleared.stderr);
    assert.match(cleared.stdout, /empty claim file at credential\.json/);
    assert.match(cleared.stdout, /profile at .*agent\.json that could not be validated/);
    assert.ok(cleared.stdout.includes(`profile at ${path} that could not be validated`));
    assert.doesNotMatch(cleared.stdout, /profile at ~\//);
    assert.match(cleared.stdout, /both files were kept/);
    assert.equal((await readFile(credential)).length, 0);
    assert.deepEqual(await readFile(path), profileBytes);
    assert.equal(f.calls(), 0);
  } finally { await f.close(); }
});

test("Fold 9 permission diagnosis covers outside-home ancestors and unclassified denial", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const outside = join(f.root, "outside-home", "child");
    await mkdir(outside, { recursive: true, mode: 0o700 });
    const ownerUid = process.getuid?.() ?? 501;
    const denied = Object.assign(new Error("denied"), { code: "EACCES" });
    const inspect = async (file: string) => Object.assign(await stat(file), { uid: file === dirname(outside) ? ownerUid + 1 : ownerUid });
    const wrongMode = async (file: string) => {
      const info = await stat(file);
      return Object.assign(info, { uid: ownerUid,
        mode: (info.mode & ~0o777) | (file === dirname(outside) ? 0o400 : 0o700) });
    };
    await assert.rejects(classifyDirectoryFailure(outside, denied, wrongMode, ownerUid), error => {
      assert.equal((error as { code: string }).code, "connect_directory_mode");
      assert.ok(String(error).includes(dirname(outside)));
      return true;
    });
    await assert.rejects(classifyDirectoryFailure(outside, denied, inspect, ownerUid,
      async file => { if (file === dirname(outside)) throw denied; }), error => {
      assert.equal((error as { code: string }).code, "connect_directory_unowned");
      assert.ok(String(error).includes(dirname(outside)));
      return true;
    });
    await assert.rejects(classifyDirectoryFailure(outside, denied,
      async file => Object.assign(await stat(file), { uid: file === outside ? ownerUid : 0 }), ownerUid), error => {
      assert.equal((error as { code: string }).code, "connect_state_unavailable");
      assert.match(String(error), /Inspect its access/);
      return true;
    });
    for (const systemBase of ["/Users", "/home"]) {
      const fakePath = join(systemBase, "test-user", "project");
      await assert.rejects(classifyDirectoryFailure(fakePath, denied, async file => {
        const info = await stat(outside);
        const systemDirectory = file === "/" || file === systemBase;
        return Object.assign(info, { uid: systemDirectory ? 0 : ownerUid,
          mode: (info.mode & ~0o777) | (systemDirectory ? 0o755 : 0o700) });
      }, ownerUid, async () => undefined), { code: "connect_state_unavailable" });
    }
    for (const code of ["EACCES", "EPERM"]) {
      const raw = Object.assign(new Error("raw permission denied"), { code });
      assert.equal(mcpFailureCode(raw, "connect"), "connect_state_unavailable");
      assert.match(mcpFailureMessage(raw, "connect"), /Inspect its access and rerun the same command/);
      assert.doesNotMatch(mcpFailureMessage(raw, "connect"), /raw permission denied/);
    }
  } finally { await f.close(); }
});

test("Fold 10 profile access probe classifies both permission codes before POST", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const path = join(f.root, "access-probe", "profile.json");
    for (const code of ["EACCES", "EPERM"]) {
      await assert.rejects(connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN,
        fetcher: f.fetcher, checkProfileAccess: async () => { throw Object.assign(new Error("raw probe failure"), { code }); } }), error => {
        assert.equal((error as { code: string }).code, "connect_state_unavailable");
        assert.match(String(error), /Inspect its access and rerun the same command/);
        assert.doesNotMatch(String(error), /raw probe failure/);
        return true;
      });
    }
    assert.equal(f.calls(), 0);
  } finally { await f.close(); }
});

test("Fold 9 completion write failure reports a saved usable profile and resumes without POST", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const path = join(f.root, "completion-write", "profile.json");
    await assert.rejects(connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher: f.fetcher,
      writeCompletion: async () => { throw Object.assign(new Error("write failed"), { code: "EIO" }); } }), error => {
      assert.equal((error as { code: string }).code, "connect_complete_write_failed");
      assert.match(String(error), /profile .*saved and usable/);
      assert.match(String(error), /completion record .*was not written/);
      assert.match(String(error), /run the same command again/);
      assert.doesNotMatch(String(error), /outcome is unknown/);
      return true;
    });
    assert.equal((await readAgentProfile(path)).principal_id, PRINCIPAL);
    await connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher: f.fetcher });
    assert.equal(f.calls(), 1);
  } finally { await f.close(); }
});

test("Fold 12 completion chmod failure leaves no record before reporting it unwritten", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const path = join(f.root, "completion-chmod", "profile.json");
    const complete = join(dirname(path), "connect-complete.json");
    await assert.rejects(connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher: f.fetcher,
      writeCompletion: (file, serialized) => writeSecureJsonFile(file, serialized, async (handle, contents) => {
        await handle.writeFile(contents, "utf8");
        Object.defineProperty(handle, "chmod", { value: async () => { throw Object.assign(new Error("chmod failed"), { code: "EACCES" }); } });
      }) }), error => {
      assert.equal((error as { code: string }).code, "connect_complete_write_failed");
      assert.match(String(error), /completion record .*was not written/);
      return true;
    });
    assert.equal(existsSync(complete), false);
    assert.equal((await readAgentProfile(path)).principal_id, PRINCIPAL);
    const source = await readFile(resolve("src/cloud/storage.ts"), "utf8");
    const writer = source.slice(source.indexOf("export async function writeSecureJsonFile("), source.indexOf("/** Publish a new private file"));
    const renameAt = writer.indexOf("await rename(temporary, path);");
    assert.ok(renameAt > 0);
    const chmodAt = writer.indexOf("await handle.chmod(0o600);");
    const secureTempAt = writer.indexOf("await secureCredentialFile(temporary);");
    assert.ok(chmodAt > 0 && chmodAt < renameAt);
    assert.ok(secureTempAt > 0 && secureTempAt < renameAt);
    assert.doesNotMatch(writer.slice(renameAt), /await (?:chmod\(path|secureCredentialFile\(path)/);
  } finally { await f.close(); }
});

test("Fold 12 rebuild refusal names the explicit profile basename", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const path = join(f.root, "custom-rebuild", "agent.json");
    await connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher: f.fetcher });
    const complete = join(dirname(path), "connect-complete.json");
    const record = JSON.parse(await readFile(complete, "utf8"));
    delete record.workspace_id;
    await writeSecureJsonFile(complete, JSON.stringify(record));
    for (const [contents, state] of [[null, "no agent.json"], ["", "an empty agent.json claim file"], ["{", "damaged agent.json"]] as const) {
      if (contents === null) await unlink(path).catch(() => undefined);
      else await writeFile(path, contents, { mode: 0o600 });
      await assert.rejects(connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher: f.fetcher }), error => {
        assert.equal((error as { code: string }).code, "connect_completion_incomplete");
        assert.ok(String(error).includes(state));
        assert.doesNotMatch(String(error), /profile\.json/);
        return true;
      });
    }
    assert.equal(f.calls(), 1);
  } finally { await f.close(); }
});

test("Fold 9 stale-temp cleanup waits for the setup writer lock", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const path = join(f.root, "cleanup-lock", "profile.json");
    await assert.rejects(connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN,
      fetcher: async () => { throw new Error("lost reply"); } }), { code: "register_outcome_unknown" });
    const temp = join(dirname(path), "credential.json.99999999.abcdefabcdef.tmp");
    await writeFile(temp, "{}", { mode: 0o600 });
    let started = false;
    let pending!: Promise<unknown>;
    await withFileLock(dirname(path), "setup", async () => {
      pending = connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN,
        fetcher: async () => { started = true; throw new Error("lost reply"); } });
      await new Promise(resolve => setTimeout(resolve, 250));
      assert.equal((await stat(temp)).isFile(), true, "cleanup must wait while setup holds the lock");
      assert.equal(started, false);
    });
    await assert.rejects(pending, { code: "register_outcome_unknown" });
    await assert.rejects(stat(temp), { code: "ENOENT" });
  } finally { await f.close(); }
});

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
      assert.doesNotMatch(String(error), /cswarm principal revoke/);
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

test("default connect rejects an invalid name before consuming the code", { timeout: 10000 }, async () => {
  let prompts = 0;
  await assert.rejects(connectMcp({ target: TARGET, name: " ", readCode: async () => { prompts++; return JOIN; } }), { code: "connect_name_invalid" });
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
    await assert.rejects(connectMcp({ target: TARGET, profilePath: second, readCode: async () => JOIN, fetcher: f.fetcher }), { code: "join_credential_seat_cap_reached", message: "The server reports that this code was already used. Ask the operator to inspect its seats before requesting a new code." });
    assert.equal(f.calls(), 2, "register must not retry");
    await assert.rejects(stat(second), { code: "ENOENT" });
  } finally { await f.close(); }
});

test("a committed save failure resumes one seat with the same attempt and a private pending record", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const path = join(f.root, "recover-save", "profile.json");
    const attempts: string[] = [];
    let seats = 0;
    const fetcher: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      const pendingAtRequest = JSON.parse(await readFile(join(dirname(path), "connect-pending.json"), "utf8"));
      assert.equal(pendingAtRequest.attemptId, body.attemptId, "pending attempt is durable before POST");
      attempts.push(body.attemptId);
      if (new Set(attempts).size > seats) seats++;
      return Response.json({ status: "accepted", workspace_id: WS, principal_id: PRINCIPAL, run_id: RUN,
        token_id: TOKEN_ID, agent_token: TOKEN, expires_at: "2099-01-01T00:00:00Z" });
    };
    await assert.rejects(connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher,
      saveProfile: async () => { throw new Error("simulated save failure"); } }), { code: "register_outcome_unknown" });
    const pending = join(dirname(path), "connect-pending.json");
    const raw = await readFile(pending, "utf8");
    assert.doesNotMatch(raw, /swm_join_|swm_agt_/);
    assert.equal((await stat(pending)).mode & 0o777, 0o600);
    assert.equal((await stat(dirname(path))).mode & 0o777, 0o700);
    await connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher });
    assert.equal(seats, 1);
    assert.deepEqual(attempts.length, 2);
    assert.equal(attempts[0], attempts[1]);
    assert.equal((await readAgentProfile(path)).principal_id, PRINCIPAL);
    await assert.rejects(stat(pending), { code: "ENOENT" });
  } finally { await f.close(); }
});

test("rotating retry repairs a credential-only crash on explicit and default paths", { timeout: 15000 }, async () => {
  const f = await fixture();
  const previousHome = process.env.HOME;
  process.env.HOME = f.root;
  try {
    for (const mode of ["explicit", "default"] as const) {
      let calls = 0;
      let attempt = "";
      const seats = new Set<string>();
      const liveTokens = new Set<string>();
      let path = join(f.root, mode, "profile.json");
      const fetcher: typeof fetch = async (_input, init) => {
        calls++;
        const body = JSON.parse(String(init?.body));
        if (attempt) assert.equal(body.attemptId, attempt);
        else attempt = body.attemptId;
        seats.add(body.attemptId);
        if (calls > 1) liveTokens.delete(`swm_agt_${"T".repeat(43)}`);
        const minted = `swm_agt_${(calls === 1 ? "T" : "U").repeat(43)}`;
        liveTokens.add(minted);
        return Response.json({ status: "accepted", workspace_id: WS, principal_id: PRINCIPAL, run_id: RUN,
          token_id: calls === 1 ? TOKEN_ID : "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
          agent_token: minted, expires_at: "2099-01-01T00:00:00Z" });
      };
      const options = { target: TARGET, readCode: async () => JOIN, fetcher };
      await assert.rejects(connectMcp({ ...options, ...(mode === "explicit" ? { profilePath: path } : {}),
        saveProfile: async (actualPath, connection) => {
          path = actualPath;
          await writeFile(join(dirname(path), "credential.json"), JSON.stringify(connection.credential), { mode: 0o600 });
          throw new Error("crash after credential");
        } }), { code: "register_outcome_unknown" });
      await assert.rejects(stat(path), { code: "ENOENT" });
      const recovered = await connectMcp({ ...options, ...(mode === "explicit" ? { profilePath: path } : {}) });
      assert.equal(recovered.profile, path);
      assert.equal(calls, 2);
      assert.equal(seats.size, 1);
      assert.equal(liveTokens.has(`swm_agt_${"T".repeat(43)}`), false, "retry revoked the saved token");
      assert.equal(liveTokens.has(`swm_agt_${"U".repeat(43)}`), true, "retry minted a working token");
      assert.equal((await readAgentProfile(path)).principal_id, PRINCIPAL);
      assert.equal(JSON.parse(await readFile(join(dirname(path), "credential.json"), "utf8")).agent_token, `swm_agt_${"U".repeat(43)}`);
      assert.equal((await readProfileCredential(await readAgentProfile(path))).token, `swm_agt_${"U".repeat(43)}`);
      await assert.rejects(stat(join(dirname(path), "connect-pending.json")), { code: "ENOENT" });
      await assert.rejects(connectMcp({ ...options, ...(mode === "explicit" ? { profilePath: path } : {}) }), { code: "profile_exists" });
      assert.equal(calls, 2, "a completed retry never registers again");
    }
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls++;
      return Response.json({ status: "accepted", workspace_id: WS, principal_id: PRINCIPAL, run_id: RUN,
        token_id: TOKEN_ID, agent_token: TOKEN, expires_at: "2099-01-01T00:00:00Z" });
    };
    const completed = join(f.root, "completed-recovery", "profile.json");
    await assert.rejects(connectMcp({ target: TARGET, profilePath: completed, readCode: async () => JOIN, fetcher,
      saveProfile: async (...args) => { await saveAgentProfile(...args); throw new Error("crash after profile"); } }),
    { code: "register_outcome_unknown" });
    assert.equal(calls, 1);
    await connectMcp({ target: TARGET, profilePath: completed, readCode: async () => JOIN, fetcher });
    assert.equal(calls, 1, "completed profile must not trigger a retry that could revoke a used token");
    await assert.rejects(stat(join(dirname(completed), "connect-pending.json")), { code: "ENOENT" });
  } finally { if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome; await f.close(); }
});

test("a successful retry for another principal keeps the orphan bytes and pending record", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const path = join(f.root, "mismatch", "profile.json");
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls++;
      return Response.json({ status: "accepted", workspace_id: WS,
        principal_id: calls === 1 ? PRINCIPAL : "ffffffff-ffff-4fff-8fff-ffffffffffff", run_id: RUN,
        token_id: calls === 1 ? TOKEN_ID : "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        agent_token: `swm_agt_${(calls === 1 ? "T" : "U").repeat(43)}`, expires_at: "2099-01-01T00:00:00Z" });
    };
    await assert.rejects(connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher,
      saveProfile: async (_path, connection) => {
        await writeFile(join(dirname(path), "credential.json"), JSON.stringify(connection.credential), { mode: 0o600 });
        throw new Error("crash after credential");
      } }), { code: "register_outcome_unknown" });
    const credential = join(dirname(path), "credential.json");
    const original = await readFile(credential);
    await assert.rejects(connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher }), { code: "profile_conflict" });
    assert.deepEqual(await readFile(credential), original);
    assert.equal((await stat(join(dirname(path), "connect-pending.json"))).isFile(), true);
    await assert.rejects(stat(path), { code: "ENOENT" });
    assert.equal(calls, 2);
  } finally { await f.close(); }
});

test("a damaged profile beside this code gives a profile-only move step", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const path = join(f.root, "damaged", "profile.json");
    let calls = 0;
    const fetcher: typeof fetch = async () => { calls++; throw new Error("lost response"); };
    await assert.rejects(connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher }), { code: "register_outcome_unknown" });
    const pending = join(dirname(path), "connect-pending.json");
    const pendingBytes = await readFile(pending);
    await writeFile(path, "{", { mode: 0o600 });
    await assert.rejects(connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher }), error => {
      assert.equal((error as { code: string }).code, "connect_profile_damaged");
      assert.match(String(error), /profile file.*is damaged/);
      assert.match(String(error), new RegExp(`mv '${path}' '${path}\\.damaged-\\d{4}-`));
      assert.match(String(error), /then run the same command again/);
      assert.doesNotMatch(String(error), /new profile path|credential.json|clear-pending/);
      return true;
    });
    assert.deepEqual(await readFile(pending), pendingBytes);
    assert.equal((await readFile(path, "utf8")), "{");
    assert.equal(calls, 1);
  } finally { await f.close(); }
});

test("umask 0277 still creates mode 0600 pending, credential, profile and completion files", { timeout: 10000 }, async () => {
  const f = await fixture();
  const path = join(f.root, "umask", "profile.json");
  await mkdir(dirname(path), { mode: 0o700 });
  const old = process.umask(0o277);
  try {
    await connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN,
      fetcher: async () => {
        assert.equal((await stat(join(dirname(path), "connect-pending.json"))).mode & 0o777, 0o600);
        return Response.json({ status: "accepted", workspace_id: WS, principal_id: PRINCIPAL, run_id: RUN,
          token_id: TOKEN_ID, agent_token: TOKEN, expires_at: "2099-01-01T00:00:00Z" });
      } });
    for (const name of ["credential.json", "profile.json", "connect-complete.json"]) {
      assert.equal((await stat(join(dirname(path), name))).mode & 0o777, 0o600, name);
    }
  } finally { process.umask(old); await f.close(); }
});

test("Fold 7 first credential write leaves no partial final file on EIO and one retry recovers", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const path = join(f.root, "first-atomic", "profile.json");
    const credential = join(dirname(path), "credential.json");
    let posts = 0;
    const attempts: string[] = [];
    const fetcher: typeof fetch = async (_input, init) => {
      posts++;
      attempts.push(JSON.parse(String(init?.body)).attemptId);
      return Response.json({ status: "accepted", workspace_id: WS, principal_id: PRINCIPAL, run_id: RUN,
        token_id: posts === 1 ? TOKEN_ID : "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        agent_token: `swm_agt_${(posts === 1 ? "T" : "U").repeat(43)}`, expires_at: "2099-01-01T00:00:00Z" });
    };
    await assert.rejects(connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher,
      saveProfile: async (_path, connection) => {
        await writeSecureJsonFileExclusive(credential, JSON.stringify(connection.credential), async handle => {
          await handle.writeFile("partial");
          throw Object.assign(new Error("disk write failed"), { code: "EIO" });
        });
        throw new Error("write should fail");
      } }), { code: "register_outcome_unknown" });
    await assert.rejects(stat(credential), { code: "ENOENT" });
    assert.deepEqual((await readdir(dirname(path))).filter(name => name.startsWith("credential.json.")), []);
    await connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher });
    assert.equal(posts, 2, "the rerun makes one request");
    assert.equal(new Set(attempts).size, 1);
    assert.equal((await readProfileCredential(await readAgentProfile(path))).token, `swm_agt_${"U".repeat(43)}`);
  } finally { await f.close(); }
});

test("Fold 7 damaged partial credential gives its exact move step before POST", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const path = join(f.root, "partial-old", "profile.json");
    let posts = 0;
    const fetcher: typeof fetch = async () => { posts++; throw new Error("response lost"); };
    await assert.rejects(connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher }), { code: "register_outcome_unknown" });
    const credential = join(dirname(path), "credential.json");
    await writeFile(credential, "{", { mode: 0o600 });
    await assert.rejects(connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher }), error => {
      assert.equal((error as { code: string }).code, "connect_credential_damaged");
      assert.match(String(error), new RegExp(`mv '${credential}' '${credential}\\.damaged-\\d{4}-`));
      assert.match(String(error), /then run the same command again/);
      return true;
    });
    assert.equal(posts, 1, "a partial orphan must not revoke another token");
  } finally { await f.close(); }
});

test("Fold 7 typed repository and symlink refusals do not advise chmod", { timeout: 10000 }, async () => {
  const f = await fixture();
  const previousHome = process.env.HOME;
  process.env.HOME = f.root;
  try {
    const parent = join(f.root, "ordinary");
    const repo = join(parent, "repo");
    await mkdir(join(repo, ".git"), { recursive: true, mode: 0o755 });
    await chmod(parent, 0o755);
    await chmod(repo, 0o755);
    const linked = join(parent, "linked");
    await symlink(repo, linked);
    for (const [path, code] of [[join(repo, "seat", "profile.json"), "profile_inside_repository"],
      [join(linked, "seat", "profile.json"), "profile_symlink"]] as const) {
      await assert.rejects(connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher: f.fetcher }), error => {
        assert.equal((error as { code: string }).code, code);
        assert.doesNotMatch(String(error), /chmod/);
        return true;
      });
    }
    assert.equal(f.calls(), 0);
  } finally { if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome; await f.close(); }
});

test("Fold 7 retry checks every orphan form before register", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const path = join(f.root, "orphan-check", "profile.json");
    let posts = 0;
    const fetcher: typeof fetch = async () => { posts++; throw new Error("response lost"); };
    await assert.rejects(connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher }), { code: "register_outcome_unknown" });
    const credential = join(dirname(path), "credential.json");
    const other = join(dirname(path), "other.json");
    const valid = { message: AGENT_CREDENTIAL_MESSAGE_D088, status: "accepted",
      principal_id: "ffffffff-ffff-4fff-8fff-ffffffffffff", run_id: RUN, token_id: TOKEN_ID,
      agent_token: TOKEN, expires_at: "2099-01-01T00:00:00Z" };
    for (const kind of ["symlink", "oversized", "no-principal"] as const) {
      await rm(credential, { force: true });
      if (kind === "symlink") { await writeFile(other, JSON.stringify(valid), { mode: 0o600 }); await symlink(other, credential); }
      else if (kind === "oversized") await writeFile(credential, "x".repeat(16 * 1024 + 1), { mode: 0o600 });
      else if (kind === "no-principal") await writeFile(credential, "{}", { mode: 0o600 });
      await assert.rejects(connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher }), { code: "profile_conflict" }, kind);
      assert.equal(posts, 1, `${kind} must not make another POST`);
    }
  } finally { await f.close(); }
});

test("Fold 7 default scan reports credential and directory modes before another register", { timeout: 10000 }, async () => {
  const f = await fixture();
  const previousHome = process.env.HOME;
  process.env.HOME = f.root;
  try {
    const connected = await connectMcp({ target: TARGET, readCode: async () => JOIN, fetcher: f.fetcher });
    const credential = join(dirname(connected.profile), "credential.json");
    await chmod(credential, 0o644);
    await assert.rejects(connectMcp({ target: TARGET, readCode: async () => JOIN, fetcher: f.fetcher }), error => {
      assert.equal((error as { code: string }).code, "connect_credential_mode");
      assert.match(String(error), new RegExp(`chmod 600 '${credential}'`));
      return true;
    });
    assert.equal(f.calls(), 1);
    await chmod(credential, 0o600);
    await chmod(dirname(connected.profile), 0o755);
    await assert.rejects(connectMcp({ target: TARGET, readCode: async () => JOIN, fetcher: f.fetcher }), error => {
      assert.equal((error as { code: string }).code, "connect_directory_mode");
      assert.match(String(error), /chmod 700/);
      return true;
    });
    assert.equal(f.calls(), 1);
  } finally { if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome; await f.close(); }
});

test("Fold 7 completion rebuilds a missing profile locally or gives a new path for incomplete state", { timeout: 10000 }, async () => {
  const f = await fixture();
  const previousHome = process.env.HOME;
  process.env.HOME = f.root;
  try {
    const connected = await connectMcp({ target: TARGET, readCode: async () => JOIN, fetcher: f.fetcher });
    const profile = connected.profile;
    const credential = join(dirname(profile), "credential.json");
    const before = await readFile(credential);
    await unlink(profile);
    const rebuilt = await connectMcp({ target: TARGET, readCode: async () => JOIN, fetcher: f.fetcher });
    assert.equal(rebuilt.profile, profile);
    assert.equal(f.calls(), 1, "rebuild uses no network");
    assert.deepEqual(await readFile(credential), before);
    assert.equal((await readAgentProfile(profile)).principal_id, PRINCIPAL);
    await unlink(profile);
    const completePath = join(dirname(profile), "connect-complete.json");
    const incomplete = JSON.parse(await readFile(completePath, "utf8"));
    delete incomplete.workspace_id;
    await writeSecureJsonFile(completePath, JSON.stringify(incomplete));
    await assert.rejects(connectMcp({ target: TARGET, readCode: async () => JOIN, fetcher: f.fetcher }), error => {
      assert.equal((error as { code: string }).code, "connect_completion_incomplete");
      assert.match(String(error), /credential\.json.*no profile\.json.*connect-complete\.json/);
      assert.match(String(error), /--profile <new path>/);
      return true;
    });
    await writeSecureJsonFile(completePath, JSON.stringify({ ...incomplete, workspace_id: WS }));
    await unlink(credential);
    await assert.rejects(connectMcp({ target: TARGET, readCode: async () => JOIN, fetcher: f.fetcher }), error => {
      assert.equal((error as { code: string }).code, "connect_completion_incomplete");
      assert.match(String(error), /no credential\.json, no profile\.json/);
      assert.match(String(error), /--profile <new path>/);
      return true;
    });
    assert.equal(f.calls(), 1);
  } finally { if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome; await f.close(); }
});

test("Fold 8 completion binds a rebuild to its recorded principal", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const path = join(f.root, "bound", "profile.json");
    await connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher: f.fetcher });
    const record = join(dirname(path), "connect-complete.json");
    const credential = join(dirname(path), "credential.json");
    const original = JSON.parse(await readFile(credential, "utf8"));
    const completed = JSON.parse(await readFile(record, "utf8"));
    assert.equal(completed.principal_id, PRINCIPAL);
    assert.equal(completed.run_id, RUN);
    await unlink(path);
    await connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher: f.fetcher });
    assert.equal((await readAgentProfile(path)).principal_id, PRINCIPAL);
    await unlink(path);
    const otherPrincipal = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    await writeSecureJsonFile(credential, JSON.stringify({ ...original, principal_id: otherPrincipal }));
    await assert.rejects(connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher: f.fetcher }), error => {
      assert.equal((error as { code: string }).code, "connect_completion_principal_mismatch");
      assert.match(String(error), /credential\.json.*connect-complete\.json.*--profile <new path>/);
      return true;
    });
    await assert.rejects(stat(path), { code: "ENOENT" });
    await writeSecureJsonFile(credential, JSON.stringify(original));
    delete completed.principal_id;
    await writeSecureJsonFile(record, JSON.stringify(completed));
    await assert.rejects(connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher: f.fetcher }), error => {
      assert.equal((error as { code: string }).code, "connect_completion_incomplete");
      assert.match(String(error), /--profile <new path>/);
      return true;
    });
    assert.equal(f.calls(), 1);
    await assert.rejects(stat(path), { code: "ENOENT" });
  } finally { await f.close(); }
});

test("Fold 8 pending resume classifies completion and keeps a working profile on write failure", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const path = join(f.root, "resume", "profile.json");
    await connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher: f.fetcher });
    const complete = join(dirname(path), "connect-complete.json");
    const pending = join(dirname(path), "connect-pending.json");
    const record = JSON.parse(await readFile(complete, "utf8"));
    await writeSecureJsonFile(pending, JSON.stringify({ attemptId: record.attemptId, url: record.url, name: "MCP agent",
      codeHash: record.codeHash, createdAt: new Date().toISOString() }));
    await chmod(complete, 0o644);
    await assert.rejects(connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher: f.fetcher }), error => {
      assert.equal((error as { code: string }).code, "connect_complete_mode");
      assert.ok(String(error).includes(`chmod 600 '${complete}'`));
      return true;
    });
    await chmod(complete, 0o600);
    await unlink(complete);
    await symlink(pending, complete);
    await assert.rejects(connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher: f.fetcher }), error => {
      assert.equal((error as { code: string }).code, "connect_complete_unsafe");
      assert.match(String(error), /connect-complete\.json/);
      assert.doesNotMatch(String(error), /mv .*profile\.json/);
      return true;
    });
    await unlink(complete);
    await writeSecureJsonFile(complete, JSON.stringify(record));
    await assert.rejects(connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher: f.fetcher,
      inspectCompletion: async file => Object.assign(await stat(file), { uid: 0 }) }), error => {
      assert.equal((error as { code: string }).code, "connect_complete_unsafe");
      assert.match(String(error), /connect-complete\.json/);
      assert.doesNotMatch(String(error), /mv .*profile\.json/);
      return true;
    });
    await assert.rejects(connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher: f.fetcher,
      writeCompletion: async () => { throw Object.assign(new Error("write refused"), { code: "EIO" }); } }), error => {
      assert.equal((error as { code: string }).code, "connect_complete_write_failed");
      assert.doesNotMatch(String(error), /damaged|mv /);
      return true;
    });
    assert.equal((await readAgentProfile(path)).principal_id, PRINCIPAL);
    assert.equal(f.calls(), 1);
  } finally { await f.close(); }
});

test("Fold 8 cleanup keeps live temps and removes dead credential and profile temps", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const path = join(f.root, "temps", "profile.json");
    await assert.rejects(connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN,
      fetcher: async () => { throw new Error("lost response"); } }), { code: "register_outcome_unknown" });
    const live = join(dirname(path), `credential.json.${process.pid}.abcdefabcdef.tmp`);
    const deadCredential = join(dirname(path), "credential.json.99999999.abcdefabcdef.tmp");
    const deadProfile = join(dirname(path), "profile.json.99999999.abcdefabcdef.tmp");
    const deadPending = join(dirname(path), "connect-pending.json.99999999.abcdefabcdef.tmp");
    const deadComplete = join(dirname(path), "connect-complete.json.99999999.abcdefabcdef.tmp");
    for (const file of [live, deadCredential, deadProfile, deadPending, deadComplete]) await writeFile(file, "{}", { mode: 0o600 });
    await assert.rejects(connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN,
      fetcher: async () => { throw new Error("lost response"); } }), { code: "register_outcome_unknown" });
    assert.equal((await stat(live)).isFile(), true);
    await assert.rejects(stat(deadCredential), { code: "ENOENT" });
    await assert.rejects(stat(deadProfile), { code: "ENOENT" });
    await assert.rejects(stat(deadPending), { code: "ENOENT" });
    await assert.rejects(stat(deadComplete), { code: "ENOENT" });
  } finally { await f.close(); }
});

test("Fold 8 exclusive first writes publish exactly one credential", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const dir = join(f.root, "exclusive");
    await mkdir(dir, { mode: 0o700 });
    const file = join(dir, "credential.json");
    let waiting = 0;
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const write = async (handle: import("node:fs/promises").FileHandle, contents: string) => {
      await handle.writeFile(contents);
      if (++waiting === 2) release();
      await barrier;
    };
    const results = await Promise.allSettled([writeSecureJsonFileExclusive(file, '{"writer":1}', write),
      writeSecureJsonFileExclusive(file, '{"writer":2}', write)]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(results.filter(result => result.status === "rejected" && (result.reason as { code?: string }).code === "EEXIST").length, 1);
    assert.deepEqual((await readdir(dir)).filter(name => name === "credential.json"), ["credential.json"]);
    assert.ok([1, 2].includes(JSON.parse(await readFile(file, "utf8")).writer));
  } finally { await f.close(); }
});

test("Fold 8 ancestor diagnosis skips owned 0755 and names an unowned directory on EACCES", { timeout: 10000 }, async () => {
  const f = await fixture();
  const oldHome = process.env.HOME;
  process.env.HOME = f.root;
  try {
    const owned = join(f.root, "owned");
    const foreign = join(owned, "foreign");
    await mkdir(foreign, { recursive: true, mode: 0o755 });
    await chmod(owned, 0o755);
    const inspect = async (file: string) => {
      const info = await stat(file);
      return file === foreign ? Object.assign(info, { uid: 0 }) : info;
    };
    const ownerUid = process.getuid?.() ?? 501;
    assert.notEqual(ownerUid, 0);
    const denied = Object.assign(new Error("access denied"), { code: "EACCES" });
    const probe = async (file: string) => { if (file === foreign) throw denied; };
    await assert.rejects(classifyDirectoryFailure(foreign, denied, inspect, ownerUid, probe), error => {
      assert.equal((error as { code: string }).code, "connect_directory_unowned");
      assert.match(String(error), new RegExp(foreign));
      assert.match(String(error), /not owned by the current user/);
      assert.doesNotMatch(String(error), /chmod 700/);
      return true;
    });
    await chmod(foreign, 0o000);
    await assert.rejects(classifyDirectoryFailure(foreign, denied, inspect, ownerUid, probe), { code: "connect_directory_unowned" });
  } finally { if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome; await f.close(); }
});

test("Fold 8 clear reports exactly the removed records and never selects a profile temp", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const path = join(f.root, "clear-count", "profile.json");
    await connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher: f.fetcher });
    const dir = dirname(path);
    const complete = join(dir, "connect-complete.json");
    const pending = join(dir, "connect-pending.json");
    const sample = await readFile(path, "utf8");
    await unlink(path);
    const temp = join(dir, `profile.json.${process.pid}.abcdefabcdef.tmp`);
    await writeFile(temp, sample, { mode: 0o600 });
    let result = await clearMcpConnect(path);
    assert.equal(result.removed, "completion record");
    assert.equal(result.completedProfile, null);
    assert.equal((await stat(temp)).isFile(), true);
    result = await clearMcpConnect(path);
    assert.equal(result.removed, "nothing");
    await writeFile(pending, "{}", { mode: 0o600 });
    result = await clearMcpConnect(path);
    assert.equal(result.removed, "pending record");
    await writeFile(pending, "{}", { mode: 0o600 });
    await writeFile(complete, "{}", { mode: 0o600 });
    result = await clearMcpConnect(path);
    assert.equal(result.removed, "pending record and completion record");
    for (const [label, files] of [
      ["pending record", [pending]],
      ["completion record", [complete]],
      ["pending record and completion record", [pending, complete]],
    ] as const) {
      for (const file of files) await writeFile(file, "{}", { mode: 0o600 });
      const cleared = await cli(["mcp", "connect", "--clear-pending", "--profile", path, "--url", TARGET.url], { HOME: f.root });
      assert.equal(cleared.code, 0, cleared.stderr);
      assert.ok(cleared.stdout.startsWith(`Removed ${label}.`));
      assert.doesNotMatch(cleared.stdout, /working profile|cleared/);
    }
    const nothing = await cli(["mcp", "connect", "--clear-pending", "--profile", path, "--url", TARGET.url], { HOME: f.root });
    assert.equal(nothing.code, 0);
    assert.match(nothing.stdout, /^Nothing was removed\./);
    assert.doesNotMatch(nothing.stdout, /cleared|working profile/);
  } finally { await f.close(); }
});

test("Fold 7 damaged and unreadable completion records warn once and clear removes them", { timeout: 10000 }, async () => {
  const f = await fixture();
  const previousHome = process.env.HOME;
  process.env.HOME = f.root;
  const originalWrite = process.stderr.write;
  try {
    const connected = await connectMcp({ target: TARGET, readCode: async () => JOIN, fetcher: f.fetcher });
    const complete = join(dirname(connected.profile), "connect-complete.json");
    const captured: string[] = [];
    process.stderr.write = ((chunk: string | Uint8Array) => { captured.push(String(chunk)); return true; }) as typeof process.stderr.write;
    for (const kind of ["damaged", "unreadable"] as const) {
      await rm(complete, { force: true });
      if (kind === "damaged") await writeFile(complete, "{", { mode: 0o600 });
      else await symlink(join(dirname(complete), "missing-record"), complete);
      captured.length = 0;
      await connectMcp({ target: TARGET, readCode: async () => `swm_join_${(kind === "damaged" ? "K" : "L").repeat(43)}`, fetcher: async () => {
        return Response.json({ status: "accepted", workspace_id: WS, principal_id: PRINCIPAL, run_id: RUN,
          token_id: TOKEN_ID, agent_token: TOKEN, expires_at: "2099-01-01T00:00:00Z" });
      } });
      assert.equal(captured.filter(line => line.includes(complete)).length, 1);
      assert.match(captured[0] ?? "", /Warning:/);
      await clearMcpConnect(connected.profile);
      await assert.rejects(stat(complete), { code: "ENOENT" });
    }
  } finally { process.stderr.write = originalWrite; if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome; await f.close(); }
});

test("Fold 7 kill before first credential write leaves no final file and one-request recovery", { timeout: 15000 }, async () => {
  const f = await fixture();
  let child: ReturnType<typeof spawn> | null = null;
  try {
    const path = join(f.root, "first-kill", "profile.json");
    let posts = 0;
    const fetcher: typeof fetch = async () => {
      posts++;
      if (posts === 1) throw new Error("response lost");
      return Response.json({ status: "accepted", workspace_id: WS, principal_id: PRINCIPAL, run_id: RUN,
        token_id: TOKEN_ID, agent_token: TOKEN, expires_at: "2099-01-01T00:00:00Z" });
    };
    await assert.rejects(connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher }), { code: "register_outcome_unknown" });
    const credential = join(dirname(path), "credential.json");
    const storageUrl = new URL("../../src/cloud/storage.ts", import.meta.url).href;
    const script = `import { writeSecureJsonFileExclusive } from ${JSON.stringify(storageUrl)}; await writeSecureJsonFileExclusive(process.argv[1], '{}', async () => { process.stdout.write('ready\\n'); await new Promise(() => {}); });`;
    child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, credential], { stdio: ["ignore", "pipe", "pipe"] });
    await once(child.stdout!, "data");
    child.kill("SIGKILL");
    await once(child, "exit");
    child = null;
    await assert.rejects(stat(credential), { code: "ENOENT" });
    assert.equal((await readdir(dirname(path))).filter(name => /^credential\.json\.\d+\.[0-9a-f]{12}\.tmp$/.test(name)).length, 1);
    await connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher });
    assert.equal(posts, 2);
    assert.deepEqual((await readdir(dirname(path))).filter(name => name.startsWith("credential.json.")), []);
  } finally {
    if (child) { child.kill("SIGKILL"); await once(child, "exit").catch(() => undefined); }
    await f.close();
  }
});

test("Fold 7 replace failure unlinks its temp and a killed replacement temp is removed next run", { timeout: 15000 }, async () => {
  const f = await fixture();
  let child: ReturnType<typeof spawn> | null = null;
  try {
    const path = join(f.root, "replace-kill", "profile.json");
    await connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher: f.fetcher });
    const credential = join(dirname(path), "credential.json");
    const before = await readFile(credential);
    await assert.rejects(writeSecureJsonFile(credential, "{}", async handle => {
      await handle.writeFile("partial");
      throw Object.assign(new Error("disk write failed"), { code: "EIO" });
    }), { code: "EIO" });
    assert.deepEqual(await readFile(credential), before);
    assert.deepEqual((await readdir(dirname(path))).filter(name => name.startsWith("credential.json.")), []);
    const storageUrl = new URL("../../src/cloud/storage.ts", import.meta.url).href;
    const script = `import { writeSecureJsonFile } from ${JSON.stringify(storageUrl)}; await writeSecureJsonFile(process.argv[1], '{}', async handle => { await handle.writeFile('{}'); process.stdout.write('ready\\n'); await new Promise(() => {}); });`;
    child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, credential], { stdio: ["ignore", "pipe", "pipe"] });
    await once(child.stdout!, "data");
    child.kill("SIGKILL");
    await once(child, "exit");
    child = null;
    assert.equal((await readdir(dirname(path))).filter(name => /^credential\.json\.\d+\.[0-9a-f]{12}\.tmp$/.test(name)).length, 1);
    await assert.rejects(connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher: f.fetcher }), { code: "profile_exists" });
    assert.deepEqual((await readdir(dirname(path))).filter(name => name.startsWith("credential.json.")), []);
    assert.deepEqual(await readFile(credential), before);
    assert.equal(f.calls(), 1);
  } finally {
    if (child) { child.kill("SIGKILL"); await once(child, "exit").catch(() => undefined); }
    await f.close();
  }
});

test("a different code is refused before POST with original-code advice", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const path = join(f.root, "wrong-code", "profile.json");
    await assert.rejects(connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN,
      fetcher: f.fetcher, saveProfile: async () => { throw new Error("save failed"); } }), { code: "register_outcome_unknown" });
    await assert.rejects(connectMcp({ target: TARGET, profilePath: path, readCode: async () => `swm_join_${"K".repeat(43)}`,
      fetcher: f.fetcher }), error => {
      assert.equal((error as { code: string }).code, "connect_code_mismatch");
      assert.doesNotMatch(String(error), /cswarm principal revoke/);
    assert.match(String(error), /cswarm mcp connect --clear-pending --profile /);
      assert.doesNotMatch(String(error), /swm_join_|swm_agt_/);
      return true;
    });
    assert.equal(f.calls(), 1);
    await assert.rejects(stat(path), { code: "ENOENT" });
  } finally { await f.close(); }
});

test("used and server-expired retries keep the attempt and identify the clear step", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    for (const kind of ["used", "expired"] as const) {
      const path = join(f.root, kind, "profile.json");
      let calls = 0;
      const fetcher: typeof fetch = async () => {
        calls++;
        if (calls === 1) throw new Error("lost response");
        return Response.json({ error: kind === "used" ? "registration_token_already_used" : "forbidden" }, { status: kind === "used" ? 409 : 403 });
      };
      await assert.rejects(connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher }), { code: "register_outcome_unknown" });
      const pending = join(dirname(path), "connect-pending.json");
      await assert.rejects(connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher }), error => {
        assert.equal((error as { code: string }).code, kind === "used" ? "registration_token_already_used" : "forbidden");
        assert.match((error as Error).message, kind === "used" ? /seat's token was used/ : /code is unknown, expired or no longer valid/);
        assert.match(String(error), /earlier attempt's outcome is unknown|seat's token was used/);
        assert.doesNotMatch(String(error), /cswarm principal revoke/);
        assert.doesNotMatch(String(error), /revoke/);
        assert.doesNotMatch(String(error), /this attempt created no seat/);
        return true;
      });
      assert.equal(calls, 2);
      assert.equal((await stat(pending)).isFile(), true);
      await assert.rejects(stat(path), { code: "ENOENT" });
    }
  } finally { await f.close(); }
});

test("fresh no-seat refusals clear pending; resumed refusals retain it", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    for (const code of [...Object.keys(REGISTER_NO_SEAT_THIS_ATTEMPT), "join_credential_seat_cap_reached"]) {
      const path = join(f.root, `fresh-${code}`, "profile.json");
      f.refuse(code);
      await assert.rejects(connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher: f.fetcher }), { code });
      await assert.rejects(stat(join(dirname(path), "connect-pending.json")), { code: "ENOENT" });
    }
    for (const code of Object.keys(REGISTER_NO_SEAT_THIS_ATTEMPT)) {
      const path = join(f.root, `resume-${code}`, "profile.json");
      let firstAttempt = "";
      await assert.rejects(connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN,
        fetcher: async (_input, init) => { firstAttempt = JSON.parse(String(init?.body)).attemptId; throw new Error("lost response"); } }), { code: "register_outcome_unknown" });
      f.refuse(code);
      await assert.rejects(connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher: f.fetcher }), error => {
        assert.equal((error as { code: string }).code, code);
        if (code === "principal_limit_reached") {
          assert.match(String(error), /workspace is at its agent limit, and no seat exists for this attempt/);
          assert.match(String(error), /Free a seat and run the same mcp connect command again with the same code/);
          assert.doesNotMatch(String(error), /revoke|clear-pending|stranded/);
        } else {
          assert.match(String(error), /earlier attempt's outcome is unknown/);
          assert.doesNotMatch(String(error), /revoke/);
        }
        assert.doesNotMatch(String(error), /this attempt created no seat/);
        if (code === "upgrade_required") {
          assert.match(String(error), /Update cswarm and run the same mcp connect command again/);
          assert.match(String(error), /ask the operator to inspect it if recovery fails/);
          assert.doesNotMatch(String(error), /If recovery fails, Ask/);
        }
        return true;
      });
      const pending = join(dirname(path), "connect-pending.json");
      assert.equal(JSON.parse(await readFile(pending, "utf8")).attemptId, firstAttempt);
      if (code === "upgrade_required" || code === "principal_limit_reached") {
        let resumedAttempt = "";
        await connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher: async (_input, init) => {
          resumedAttempt = JSON.parse(String(init?.body)).attemptId;
          return Response.json({ status: "accepted", workspace_id: WS, principal_id: PRINCIPAL, run_id: RUN,
            token_id: TOKEN_ID, agent_token: TOKEN, expires_at: "2099-01-01T00:00:00Z" });
        } });
        assert.equal(resumedAttempt, firstAttempt);
      }
    }
  } finally { await f.close(); }
});

test("completed profile clears old pending without POST", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const completed = join(f.root, "completed-old", "profile.json");
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls++;
      return Response.json({ status: "accepted", workspace_id: WS, principal_id: PRINCIPAL, run_id: RUN,
        token_id: TOKEN_ID, agent_token: TOKEN, expires_at: "2099-01-01T00:00:00Z" });
    };
    await assert.rejects(connectMcp({ target: TARGET, profilePath: completed, readCode: async () => JOIN, fetcher,
      saveProfile: async (...args) => { await saveAgentProfile(...args); throw new Error("after profile"); } }), { code: "register_outcome_unknown" });
    const pending = join(dirname(completed), "connect-pending.json");
    const old = JSON.parse(await readFile(pending, "utf8"));
    old.createdAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    await writeFile(pending, JSON.stringify(old), { mode: 0o600 });
    assert.equal((await connectMcp({ target: TARGET, profilePath: completed, readCode: async () => JOIN, fetcher })).profile, completed);
    assert.equal(calls, 1);
    await assert.rejects(stat(pending), { code: "ENOENT" });

  } finally { await f.close(); }
});

test("a long-lived code reaches the server on retry", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const path = join(f.root, "long-lived", "profile.json");
    await assert.rejects(connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN,
      fetcher: async () => { throw new Error("lost response"); } }), { code: "register_outcome_unknown" });
    const pending = join(dirname(path), "connect-pending.json");
    const old = JSON.parse(await readFile(pending, "utf8"));
    old.createdAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    await writeFile(pending, JSON.stringify(old), { mode: 0o600 });
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls++;
      return Response.json({ status: "accepted", workspace_id: WS, principal_id: PRINCIPAL, run_id: RUN,
        token_id: TOKEN_ID, agent_token: TOKEN, expires_at: "2099-01-01T00:00:00Z" });
    };
    await connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher });
    assert.equal(calls, 1);
  } finally { await f.close(); }
});

test("server revoked retry and clear preserve an orphan credential", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const path = join(f.root, "revoked", "profile.json");
    await assert.rejects(connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN,
      fetcher: async () => { throw new Error("lost response"); } }), { code: "register_outcome_unknown" });
    const credential = join(dirname(path), "credential.json");
    await writeFile(credential, JSON.stringify({ message: AGENT_CREDENTIAL_MESSAGE_D088, status: "accepted",
      principal_id: PRINCIPAL, run_id: RUN, token_id: TOKEN_ID, agent_token: TOKEN,
      expires_at: "2099-01-01T00:00:00Z" }), { mode: 0o600 });
    f.refuse("registration_seat_revoked");
    await assert.rejects(connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher: f.fetcher }), error => {
      assert.equal((error as { code: string }).code, "registration_seat_revoked");
      assert.match(String(error), /seat is no longer active/);
      assert.match(String(error), /cswarm mcp connect --clear-pending --profile /);
      return true;
    });
    await clearMcpConnect(path);
    assert.equal((await stat(credential)).isFile(), true);
    await assert.rejects(stat(join(dirname(path), "connect-pending.json")), { code: "ENOENT" });
    await writeFile(credential, "orphan", { mode: 0o600 });
    await writeFile(join(dirname(path), "connect-pending.json"), "{", { mode: 0o600 });
    const cleared = await cli(["mcp", "connect", "--clear-pending", "--profile", path, "--url", TARGET.url], { HOME: f.root });
    assert.equal(cleared.code, 0, cleared.stderr);
    assert.match(cleared.stdout, /credential without a profile; the credential was kept/);
    assert.doesNotMatch(cleared.stdout, /completed profile/);
    assert.equal((await stat(credential)).isFile(), true);
    await assert.rejects(stat(join(dirname(path), "connect-pending.json")), { code: "ENOENT" });
    const fetcher: typeof fetch = async () => Response.json({ status: "accepted", workspace_id: WS, principal_id: PRINCIPAL,
      run_id: RUN, token_id: TOKEN_ID, agent_token: TOKEN, expires_at: "2099-01-01T00:00:00Z" });
    await assert.rejects(connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher }), { code: "profile_exists" });
    assert.equal((await readFile(credential, "utf8")), "orphan");
  } finally { await f.close(); }
});

test("clear requires pending and preserves every completed profile's credential", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const dir = join(f.root, "shared");
    const requested = join(dir, "profile.json");
    const sibling = join(dir, "codex-agent");
    const credential = join(dir, "credential.json");
    const missing = await cli(["mcp", "connect", "--clear-pending", "--profile", requested, "--url", TARGET.url], { HOME: f.root });
    assert.equal(missing.code, 0);
    assert.match(missing.stdout, /Nothing was removed/);
    assert.doesNotMatch(missing.stdout + missing.stderr, /files cleared/);
    await connectMcp({ target: TARGET, profilePath: sibling, readCode: async () => JOIN, fetcher: f.fetcher });
    const bound = JSON.parse(await readFile(sibling, "utf8"));
    bound.host_session_id = "this-host-session";
    await writeFile(sibling, JSON.stringify(bound), { mode: 0o600 });
    assert.equal((await readAgentProfile(sibling, "this-host-session")).credential_file, credential);
    await writeFile(join(dir, "connect-pending.json"), "{", { mode: 0o600 });
    await clearMcpConnect(requested);
    assert.equal((await stat(credential)).isFile(), true);
    await assert.rejects(stat(join(dir, "connect-pending.json")), { code: "ENOENT" });
    assert.equal((await readAgentProfile(sibling, "this-host-session")).credential_file, credential);
    await writeFile(join(dir, "connect-pending.json"), "{", { mode: 0o600 });
    const blocked = await cli(["mcp", "connect", "--clear-pending", "--profile", requested, "--url", TARGET.url], { HOME: f.root });
    assert.equal(blocked.code, 0, blocked.stderr);
    assert.match(blocked.stdout, new RegExp(`working profile at ${sibling}`));
    assert.doesNotMatch(blocked.stdout, /revoke/);
    assert.doesNotMatch(blocked.stdout, /revoke it before starting/);
    assert.equal((await readAgentProfile(sibling, "this-host-session")).credential_file, credential);
    assert.equal((await clearMcpConnect(requested)).removed, "nothing");
    assert.equal((await stat(credential)).isFile(), true);
    f.reset();
    const invalidProfile = join(f.root, "invalid-credential", "profile.json");
    await connectMcp({ target: TARGET, profilePath: invalidProfile, readCode: async () => JOIN, fetcher: f.fetcher });
    await writeFile(join(dirname(invalidProfile), "credential.json"), "{", { mode: 0o600 });
    await writeFile(join(dirname(invalidProfile), "connect-pending.json"), "{", { mode: 0o600 });
    const invalidClear = await cli(["mcp", "connect", "--clear-pending", "--profile", invalidProfile, "--url", TARGET.url], { HOME: f.root });
    assert.equal(invalidClear.code, 0, invalidClear.stderr);
    assert.match(invalidClear.stdout, /credential and a profile that could not be validated; both were kept/);
    assert.doesNotMatch(invalidClear.stdout, /nothing needs revoking/);
    assert.equal((await stat(join(dirname(invalidProfile), "credential.json"))).isFile(), true);
  } finally { await f.close(); }
});

test("clear keeps a live credential with a wrong mode and repairs the same command", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const path = join(f.root, "live-mode", "profile.json");
    await connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher: f.fetcher });
    const credential = join(dirname(path), "credential.json");
    const original = await readFile(credential, "utf8");
    const originalInode = (await stat(credential)).ino;
    const pending = join(dirname(path), "connect-pending.json");
    await writeFile(pending, "{", { mode: 0o600 });
    await chmod(credential, 0o644);
    await assert.rejects(clearMcpConnect(path), error => {
      assert.equal((error as { code: string }).code, "connect_credential_mode");
      assert.match(String(error), /chmod 600/);
      assert.doesNotMatch(String(error), /damaged|revoke/);
      return true;
    });
    assert.equal((await stat(pending)).isFile(), true);
    await chmod(credential, 0o600);
    await clearMcpConnect(path);
    assert.equal(await readFile(credential, "utf8"), original);
    assert.equal((await stat(credential)).ino, originalInode);
    await assert.rejects(stat(pending), { code: "ENOENT" });
  } finally { await f.close(); }
});

test("explicit record and profile modes get exact repair without a register POST", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const path = join(f.root, "explicit-mode", "profile.json");
    await assert.rejects(connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN,
      fetcher: async () => { throw new Error("lost response"); } }), { code: "register_outcome_unknown" });
    const pending = join(dirname(path), "connect-pending.json");
    const originalPending = await readFile(pending, "utf8");
    let posts = 0;
    const noPost: typeof fetch = async () => { posts++; throw new Error("unexpected POST"); };
    await chmod(pending, 0o644);
    await assert.rejects(connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher: noPost }), error => {
      assert.equal((error as { code: string }).code, "connect_pending_mode");
      assert.match(String(error), /chmod 600/);
      assert.doesNotMatch(String(error), /damaged|revoke/);
      return true;
    });
    await chmod(pending, 0o600);
    await chmod(dirname(path), 0o755);
    await assert.rejects(connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher: noPost }), error => {
      assert.equal((error as { code: string }).code, "connect_directory_mode");
      assert.match(String(error), /chmod 700/);
      return true;
    });
    await chmod(dirname(path), 0o700);
    await connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher: f.fetcher });
    await writeFile(pending, originalPending, { mode: 0o600 });
    await chmod(path, 0o644);
    await assert.rejects(connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher: noPost }), error => {
      assert.equal((error as { code: string }).code, "connect_profile_mode");
      assert.match(String(error), /chmod 600/);
      return true;
    });
    assert.equal(posts, 0);
  } finally { await f.close(); }
});

test("working profile rejects another name or code without revocation advice", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const path = join(f.root, "working-mismatch", "profile.json");
    await connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher: f.fetcher });
    // Use a real pending record so both mismatch checks can inspect the working profile.
    const attemptId = "11111111-1111-4111-8111-111111111111";
    const { createHmac } = await import("node:crypto");
    await writeFile(join(dirname(path), "connect-pending.json"), JSON.stringify({ attemptId, url: TARGET.url,
      name: "MCP agent", codeHash: createHmac("sha256", attemptId).update(JOIN).digest("hex"),
      createdAt: new Date().toISOString() }), { mode: 0o600 });
    let posts = 0;
    for (const options of [{ name: "Another agent", code: JOIN }, { name: "MCP agent", code: `swm_join_${"K".repeat(43)}` }]) {
      await assert.rejects(connectMcp({ target: TARGET, profilePath: path, name: options.name, readCode: async () => options.code,
        fetcher: async () => { posts++; throw new Error("unexpected POST"); } }), error => {
        assert.match(String(error), /working profile|already holds a profile/);
        assert.match(String(error), /new --profile path/);
        assert.doesNotMatch(String(error), /revoke/);
        return true;
      });
    }
    assert.equal(posts, 0);
  } finally { await f.close(); }
});

test("default scan filters URL, refuses ambiguity, and reports damaged pending", { timeout: 15000 }, async () => {
  const f = await fixture();
  const previousHome = process.env.HOME;
  process.env.HOME = f.root;
  try {
    const base = join(f.root, ".cswarm", "agents");
    const otherTarget = cloudTarget("http://127.0.0.1:9", TARGET.anonKey);
    const pendingAt = async (id: string, target = TARGET) => {
      const path = join(base, `mcp-${id}`, "profile.json");
      await assert.rejects(connectMcp({ target, profilePath: path, readCode: async () => JOIN,
        fetcher: async () => { throw new Error("lost response"); } }), { code: "register_outcome_unknown" });
      return path;
    };
    const other = await pendingAt("11111111-1111-4111-8111-111111111111", otherTarget);
    let posts = 0;
    const accepted: typeof fetch = async () => { posts++; return Response.json({ status: "accepted", workspace_id: WS, principal_id: PRINCIPAL,
      run_id: RUN, token_id: TOKEN_ID, agent_token: TOKEN, expires_at: "2099-01-01T00:00:00Z" }); };
    const fresh = await connectMcp({ target: TARGET, readCode: async () => JOIN, fetcher: accepted });
    assert.notEqual(fresh.profile, other);
    assert.equal(posts, 1);
    assert.equal((await stat(join(dirname(other), "connect-pending.json"))).isFile(), true);
    const one = await pendingAt("22222222-2222-4222-8222-222222222222");
    const two = await pendingAt("33333333-3333-4333-8333-333333333333");
    await assert.rejects(connectMcp({ target: TARGET, readCode: async () => JOIN, fetcher: accepted }), { code: "connect_pending_ambiguous" });
    assert.equal(posts, 1);
    await clearMcpConnect(two);
    for (const kind of ["malformed"] as const) {
      const pending = join(dirname(one), "connect-pending.json");
      await chmod(pending, 0o600);
      await writeFile(pending, JSON.stringify({ url: TARGET.url, codeHash: "bad" }), { mode: 0o600 });
      await assert.rejects(connectMcp({ target: TARGET, readCode: async () => JOIN, fetcher: accepted }), error => {
        assert.equal((error as { code: string }).code, "connect_pending_invalid");
        assert.match(String(error), /cswarm mcp connect --clear-pending --profile /);
        assert.ok(String(error).includes(pending));
        return true;
      });
      assert.equal(posts, 1, "damage must not create a fresh attempt");
    }
  } finally { if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome; await f.close(); }
});

test("default scan blocks inaccessible pending and excludes foreign damaged records", { timeout: 10000 }, async () => {
  const f = await fixture();
  const previousHome = process.env.HOME;
  const originalWrite = process.stderr.write;
  const notices: string[] = [];
  process.env.HOME = f.root;
  process.stderr.write = ((chunk: string | Uint8Array) => { notices.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    const base = join(f.root, ".cswarm", "agents");
    await mkdir(base, { recursive: true, mode: 0o700 });
    const file = join(base, "mcp-11111111-1111-4111-8111-111111111111");
    const inaccessible = join(base, "mcp-22222222-2222-4222-8222-222222222222");
    const foreign = join(base, "mcp-33333333-3333-4333-8333-333333333333");
    await writeFile(file, "unrelated", { mode: 0o600 });
    await mkdir(inaccessible, { mode: 0o700 });
    await chmod(inaccessible, 0o000);
    await mkdir(foreign, { mode: 0o700 });
    await writeFile(join(foreign, "connect-pending.json"), JSON.stringify({ url: "http://127.0.0.1:9", codeHash: "bad" }), { mode: 0o600 });
    await assert.rejects(connectMcp({ target: TARGET, readCode: async () => JOIN, fetcher: f.fetcher }), error => {
      assert.equal((error as { code: string }).code, "connect_directory_mode");
      assert.doesNotMatch(String(error), /--profile <new path>|revoke/);
      assert.match(String(error), /chmod 700/);
      assert.ok(String(error).includes(inaccessible));
      return true;
    });
    assert.equal(f.calls(), 0);
    await chmod(inaccessible, 0o700);
    const result = await connectMcp({ target: TARGET, readCode: async () => JOIN, fetcher: f.fetcher });
    assert.ok(result.profile.startsWith(base));
    assert.equal(f.calls(), 1);
    assert.equal(notices.filter(value => value.includes(file)).length, 0);
    assert.equal(notices.filter(value => value.includes(inaccessible)).length, 0);
    assert.equal(notices.filter(value => value.includes(foreign)).length, 0);
    assert.doesNotMatch(notices.join(""), /ENOTDIR|EACCES/);
    await rm(base, { recursive: true });
    await writeFile(base, "not a directory", { mode: 0o600 });
    await assert.rejects(connectMcp({ target: TARGET, readCode: async () => JOIN, fetcher: f.fetcher }), {
      code: "connect_state_unavailable",
      message: `The default connect directory at ${base} cannot be read. Inspect its access and rerun the same command.`,
    });
    assert.equal(f.calls(), 1);
  } finally {
    process.stderr.write = originalWrite;
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    await f.close();
  }
});

test("unparseable pending blocks a fresh connect until cleared", { timeout: 10000 }, async () => {
  const f = await fixture();
  const previousHome = process.env.HOME;
  process.env.HOME = f.root;
  try {
    const path = join(f.root, ".cswarm", "agents", "mcp-44444444-4444-4444-8444-444444444444", "profile.json");
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const pending = join(dirname(path), "connect-pending.json");
    await writeFile(pending, "{", { mode: 0o600 });
    await assert.rejects(connectMcp({ target: TARGET, readCode: async () => JOIN, fetcher: f.fetcher }), error => {
      assert.equal((error as { code: string }).code, "connect_pending_unreadable");
      assert.ok(String(error).includes(pending));
      assert.match(String(error), /cswarm mcp connect --clear-pending --profile /);
      assert.doesNotMatch(String(error), /--profile <new path>|revoke/);
      return true;
    });
    assert.equal(f.calls(), 0, "unparseable record prevents a fresh register");
    assert.equal((await stat(pending)).isFile(), true);
    await clearMcpConnect(path);
    let recoveredPosts = 0;
    const result = await connectMcp({ target: TARGET, readCode: async () => JOIN, fetcher: async () => {
      recoveredPosts++;
      return Response.json({ status: "accepted", workspace_id: WS, principal_id: PRINCIPAL, run_id: RUN,
        token_id: TOKEN_ID, agent_token: TOKEN, expires_at: "2099-01-01T00:00:00Z" });
    } });
    assert.ok(result.profile.startsWith(join(f.root, ".cswarm", "agents")));
    assert.equal(recoveredPosts, 1);
  } finally { if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome; await f.close(); }
});

test("default scan names a mode-0000 ~/.cswarm directory", { timeout: 10000 }, async () => {
  const f = await fixture();
  const previousHome = process.env.HOME;
  process.env.HOME = f.root;
  const base = join(f.root, ".cswarm");
  try {
    await mkdir(join(base, "agents"), { recursive: true, mode: 0o700 });
    await chmod(base, 0o000);
    let posts = 0;
    await assert.rejects(connectMcp({ target: TARGET, readCode: async () => JOIN,
      fetcher: async () => { posts++; throw new Error("unexpected POST"); } }), error => {
      assert.equal((error as { code: string }).code, "connect_directory_mode");
      assert.match(String(error), new RegExp(`chmod 700 '${base}'`));
      assert.match(String(error), /rerun the same command/);
      assert.doesNotMatch(String(error), /cannot be read|damaged/);
      return true;
    });
    await assert.rejects(connectMcp({ target: TARGET,
      profilePath: join(base, "agents", "mcp-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "profile.json"),
      readCode: async () => JOIN, fetcher: async () => { posts++; throw new Error("unexpected POST"); } }), error => {
      assert.equal((error as { code: string }).code, "connect_directory_mode");
      assert.match(String(error), new RegExp(`chmod 700 '${base}'`));
      return true;
    });
    assert.equal(posts, 0);
  } finally {
    await chmod(base, 0o700);
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    await f.close();
  }
});

test("default scan repairs modes before calling same-URL malformed pending damaged", { timeout: 10000 }, async () => {
  const f = await fixture();
  const previousHome = process.env.HOME;
  process.env.HOME = f.root;
  try {
    for (const kind of ["file", "directory"] as const) {
      const path = join(f.root, ".cswarm", "agents", `mcp-${kind === "file" ? "88888888-8888-4888-8888-888888888888" : "99999999-9999-4999-8999-999999999999"}`, "profile.json");
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const pending = join(dirname(path), "connect-pending.json");
      await writeFile(pending, JSON.stringify({ url: TARGET.url, codeHash: "bad" }), { mode: 0o600 });
      const damaged = kind === "file" ? pending : dirname(path);
      await chmod(damaged, kind === "file" ? 0o644 : 0o755);
      let posts = 0;
      await assert.rejects(connectMcp({ target: TARGET, readCode: async () => JOIN,
        fetcher: async () => { posts++; throw new Error("unexpected POST"); } }), error => {
        assert.equal((error as { code: string }).code, "connect_pending_mode");
        assert.match(String(error), new RegExp(`chmod ${kind === "file" ? "600" : "700"}`));
        assert.match(String(error), /rerun the same command/);
        assert.doesNotMatch(String(error), /is damaged/);
        return true;
      });
      assert.equal(posts, 0);
      await chmod(damaged, kind === "file" ? 0o600 : 0o700);
      await rm(dirname(path), { recursive: true });
    }
  } finally { if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome; await f.close(); }
});

test("owned pending with a wrong file or directory mode matches by HMAC and resumes after chmod", { timeout: 15000 }, async () => {
  const f = await fixture();
  const previousHome = process.env.HOME;
  process.env.HOME = f.root;
  try {
    for (const kind of ["file", "directory"] as const) {
      const id = kind === "file" ? "55555555-5555-4555-8555-555555555555" : "66666666-6666-4666-8666-666666666666";
      const path = join(f.root, ".cswarm", "agents", `mcp-${id}`, "profile.json");
      await assert.rejects(connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN,
        fetcher: async () => { throw new Error("lost response"); } }), { code: "register_outcome_unknown" });
      const pending = join(dirname(path), "connect-pending.json");
      const attempt = JSON.parse(await readFile(pending, "utf8")).attemptId;
      const damaged = kind === "file" ? pending : dirname(path);
      await chmod(damaged, kind === "file" ? 0o644 : 0o755);
      let otherPosts = 0;
      await assert.rejects(connectMcp({ target: TARGET, readCode: async () => `swm_join_${(kind === "file" ? "K" : "L").repeat(43)}`,
        fetcher: async () => { otherPosts++; throw new Error("unexpected POST"); } }), { code: "connect_pending_mode" });
      assert.equal(otherPosts, 0, "the same-URL mode problem is reported before checking another code");
      let posts = 0;
      await assert.rejects(connectMcp({ target: TARGET, readCode: async () => JOIN, fetcher: async () => { posts++; throw new Error("unexpected POST"); } }), error => {
        assert.equal((error as { code: string }).code, "connect_pending_mode");
        assert.ok(String(error).includes(pending));
        assert.match(String(error), new RegExp(`chmod ${kind === "file" ? "600" : "700"}`));
        assert.match(String(error), /then rerun the same command/);
        assert.doesNotMatch(String(error), /clear|fresh/);
        return true;
      });
      assert.equal(posts, 0);
      await chmod(damaged, kind === "file" ? 0o600 : 0o700);
      const connected = await connectMcp({ target: TARGET, readCode: async () => JOIN, fetcher: async (_input, init) => {
        posts++;
        assert.equal(JSON.parse(String(init?.body)).attemptId, attempt);
        return Response.json({ status: "accepted", workspace_id: WS, principal_id: PRINCIPAL, run_id: RUN,
          token_id: TOKEN_ID, agent_token: TOKEN, expires_at: "2099-01-01T00:00:00Z" });
      } });
      assert.equal(connected.profile, path);
      assert.equal(posts, 1);
      await rm(dirname(path), { recursive: true });
    }
  } finally { if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome; await f.close(); }
});

test("completed profile in a wrong-mode directory reports chmod without inventing pending", { timeout: 10000 }, async () => {
  const f = await fixture();
  const previousHome = process.env.HOME;
  process.env.HOME = f.root;
  try {
    const path = join(f.root, ".cswarm", "agents", "mcp-77777777-7777-4777-8777-777777777777", "profile.json");
    await connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN, fetcher: f.fetcher });
    const pending = join(dirname(path), "connect-pending.json");
    await assert.rejects(stat(pending), { code: "ENOENT" });
    await chmod(dirname(path), 0o755);
    let posts = 0;
    await assert.rejects(connectMcp({ target: TARGET, readCode: async () => JOIN, fetcher: async () => { posts++; throw new Error("unexpected POST"); } }), error => {
      assert.equal((error as { code: string }).code, "connect_directory_mode");
      assert.match(String(error), /connect directory/);
      assert.match(String(error), /chmod 700/);
      assert.doesNotMatch(String(error), /clear|pending|interrupted/);
      return true;
    });
    assert.equal(posts, 0);
    await chmod(dirname(path), 0o000);
    await assert.rejects(connectMcp({ target: TARGET, readCode: async () => JOIN, fetcher: async () => { posts++; throw new Error("unexpected POST"); } }), error => {
      assert.equal((error as { code: string }).code, "connect_directory_mode");
      assert.match(String(error), /chmod 700/);
      assert.doesNotMatch(String(error), /record|pending|damaged|revoke/);
      return true;
    });
    assert.equal(posts, 0);
    await chmod(dirname(path), 0o700);
    await chmod(path, 0o644);
    await assert.rejects(connectMcp({ target: TARGET, readCode: async () => JOIN, fetcher: async () => { posts++; throw new Error("unexpected POST"); } }), error => {
      assert.equal((error as { code: string }).code, "connect_profile_mode");
      assert.match(String(error), /chmod 600/);
      assert.doesNotMatch(String(error), /damaged|revoke/);
      return true;
    });
    assert.equal(posts, 0);
    await chmod(path, 0o600);
  } finally { if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome; await f.close(); }
});

test("clear gives a typed mode repair and succeeds after chmod", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const path = join(f.root, "mode", "profile.json");
    await assert.rejects(connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN,
      fetcher: async () => { throw new Error("lost response"); } }), { code: "register_outcome_unknown" });
    await chmod(dirname(path), 0o755);
    await assert.rejects(clearMcpConnect(path), error => {
      assert.equal((error as { code: string }).code, "connect_directory_mode");
      assert.match(String(error), /chmod 700/);
      assert.match(String(error), /cswarm mcp connect --clear-pending --profile /);
      return true;
    });
    await chmod(dirname(path), 0o700);
    await clearMcpConnect(path);
    await assert.rejects(stat(join(dirname(path), "connect-pending.json")), { code: "ENOENT" });
  } finally { await f.close(); }
});

test("clear reports success only when pending was actually removed", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const path = join(f.root, "vanishing", "profile.json");
    await assert.rejects(connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN,
      fetcher: async () => { throw new Error("lost response"); } }), { code: "register_outcome_unknown" });
    const pending = join(dirname(path), "connect-pending.json");
    await assert.rejects(clearMcpConnect(path, async () => { throw Object.assign(new Error("vanished"), { code: "ENOENT" }); }), { code: "connect_pending_missing" });
    assert.equal((await stat(pending)).isFile(), true);
    const complete = join(dirname(path), "connect-complete.json");
    await writeFile(complete, "{", { mode: 0o600 });
    await assert.rejects(clearMcpConnect(path, async file => {
      if (file === pending) throw Object.assign(new Error("vanished"), { code: "ENOENT" });
      await unlink(file);
    }), { code: "connect_pending_missing" });
    await assert.rejects(stat(complete), { code: "ENOENT" });
    assert.equal((await stat(pending)).isFile(), true);
    await clearMcpConnect(path);
    await assert.rejects(stat(pending), { code: "ENOENT" });
  } finally { await f.close(); }
});

test("foreign, malformed, and wrong-mode pending records refuse before POST with a usable clear step", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    for (const kind of ["foreign-url", "foreign-name", "bad-json", "extra-key", "wrong-mode"] as const) {
      const path = join(f.root, kind, "profile.json");
      await assert.rejects(connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN,
        fetcher: async () => { throw new Error("lost response"); } }), { code: "register_outcome_unknown" });
      const pending = join(dirname(path), "connect-pending.json");
      if (kind === "wrong-mode") await chmod(pending, 0o644);
      else if (kind === "bad-json") await writeFile(pending, "{", { mode: 0o600 });
      else {
        const value = JSON.parse(await readFile(pending, "utf8"));
        if (kind === "foreign-url") value.url = "http://127.0.0.1:9";
        if (kind === "foreign-name") value.name = "Other agent";
        if (kind === "extra-key") value.extra = true;
        await writeFile(pending, JSON.stringify(value), { mode: 0o600 });
      }
      let prompts = 0;
      await assert.rejects(connectMcp({ target: TARGET, profilePath: path, readCode: async () => { prompts++; return JOIN; }, fetcher: f.fetcher }), error => {
        assert.equal((error as { code: string }).code, kind.startsWith("foreign") ? "connect_pending_mismatch" : kind === "wrong-mode" ? "connect_pending_mode" : "connect_pending_invalid");
        if (kind === "wrong-mode") assert.match(String(error), /chmod 600/);
        else assert.match(String(error), /cswarm mcp connect --clear-pending --profile /);
        if (!kind.startsWith("foreign")) assert.ok(String(error).includes(pending));
        return true;
      });
      assert.equal(prompts, 0);
      await clearMcpConnect(path);
      await assert.rejects(stat(pending), { code: "ENOENT" });
    }
    assert.equal(f.calls(), 0);
  } finally { await f.close(); }
});

test("pending change during the prompt refuses before POST", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const path = join(f.root, "changed", "profile.json");
    await assert.rejects(connectMcp({ target: TARGET, profilePath: path, readCode: async () => JOIN,
      fetcher: async () => { throw new Error("lost response"); } }), { code: "register_outcome_unknown" });
    const pending = join(dirname(path), "connect-pending.json");
    await assert.rejects(connectMcp({ target: TARGET, profilePath: path, readCode: async () => {
      await rm(pending);
      return JOIN;
    }, fetcher: f.fetcher }), { code: "connect_pending_changed" });
    assert.equal(f.calls(), 0);
  } finally { await f.close(); }
});

test("a truncated committed response recovers the same seat", { timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-mcp-truncated-"));
  const attempts: string[] = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    attempts.push(body.attemptId);
    if (attempts.length === 1) { response.writeHead(200, { "content-type": "application/json" }); response.end('{"status":'); return; }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "accepted", workspace_id: WS, principal_id: PRINCIPAL, run_id: RUN,
      token_id: TOKEN_ID, agent_token: TOKEN, expires_at: "2099-01-01T00:00:00Z" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const target = cloudTarget(`http://127.0.0.1:${address.port}`, TARGET.anonKey);
  const path = join(root, "profile.json");
  try {
    await assert.rejects(connectMcp({ target, profilePath: path, readCode: async () => JOIN }), { code: "register_outcome_unknown" });
    await connectMcp({ target, profilePath: path, readCode: async () => JOIN });
    assert.equal(new Set(attempts).size, 1);
    assert.equal(attempts.length, 2);
    assert.equal((await readAgentProfile(path)).principal_id, PRINCIPAL);
    await assert.rejects(stat(join(root, "connect-pending.json")), { code: "ENOENT" });
  } finally { server.closeAllConnections(); server.close(); await rm(root, { recursive: true, force: true }); }
});

test("a killed child after register reaches the server resumes without a second seat", { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-mcp-killed-"));
  const attempts: string[] = [];
  let firstReceived!: () => void;
  const received = new Promise<void>(resolve => { firstReceived = resolve; });
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    attempts.push(body.attemptId);
    if (attempts.length === 1) { firstReceived(); return; }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "accepted", workspace_id: WS, principal_id: PRINCIPAL, run_id: RUN,
      token_id: TOKEN_ID, agent_token: TOKEN, expires_at: "2099-01-01T00:00:00Z" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const target = cloudTarget(`http://127.0.0.1:${address.port}`, TARGET.anonKey);
  const path = join(root, "profile.json");
  const childCode = `import { connectMcp } from ${JSON.stringify(new URL("../../src/cloud/mcp-connect.ts", import.meta.url).href)};\n` +
    `await connectMcp({ target: { url: ${JSON.stringify(target.url)}, anonKey: ${JSON.stringify(target.anonKey)} }, profilePath: ${JSON.stringify(path)}, readCode: async () => 'swm_join_' + 'J'.repeat(43) });`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childCode],
    { env: { PATH: process.env.PATH ?? "", HOME: root }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => output += chunk);
  child.stderr.on("data", chunk => output += chunk);
  const childClosed = once(child, "close");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    await Promise.race([received, childClosed.then(() => { throw new Error("child exited before register request"); })]);
    child.kill("SIGKILL");
    await childClosed;
    await connectMcp({ target, profilePath: path, readCode: async () => JOIN });
    assert.equal(new Set(attempts).size, 1);
    assert.equal(attempts.length, 2);
    assert.equal((await readAgentProfile(path)).principal_id, PRINCIPAL);
    assert.doesNotMatch(output, /swm_join_|swm_agt_/);
    await assert.rejects(stat(join(root, "connect-pending.json")), { code: "ENOENT" });
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await childClosed.catch(() => undefined);
    server.closeAllConnections(); server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("the printed no-profile command recovers a killed child's one seat by code", { timeout: 20000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-mcp-default-killed-"));
  const attempts: string[] = [];
  let firstReceived!: () => void;
  const received = new Promise<void>(resolve => { firstReceived = resolve; });
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    attempts.push(body.attemptId);
    if (attempts.length === 1) { firstReceived(); return; }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "accepted", workspace_id: WS, principal_id: PRINCIPAL, run_id: RUN,
      token_id: TOKEN_ID, agent_token: TOKEN, expires_at: "2099-01-01T00:00:00Z" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const target = cloudTarget(`http://127.0.0.1:${address.port}`, TARGET.anonKey);
  const printed = renderMcpCode({ code: JOIN, expires_at: "2099-01-01T00:00:00Z" }, target);
  assert.match(printed, /cswarm mcp connect --url /);
  assert.doesNotMatch(printed, /--profile/);
  const childCode = `import { connectMcp } from ${JSON.stringify(new URL("../../src/cloud/mcp-connect.ts", import.meta.url).href)};\n` +
    `const result = await connectMcp({ target: { url: ${JSON.stringify(target.url)}, anonKey: ${JSON.stringify(target.anonKey)} }, readCode: async () => 'swm_join_' + 'J'.repeat(43) }); console.log('PROFILE=' + result.profile);`;
  const environment = { PATH: process.env.PATH ?? "", HOME: root };
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childCode], { env: environment, stdio: ["ignore", "pipe", "pipe"] });
  const childClosed = once(child, "close");
  const timer = setTimeout(() => child.kill("SIGKILL"), 6000);
  try {
    await Promise.race([received, childClosed.then(() => { throw new Error("child exited before register request"); })]);
    child.kill("SIGKILL");
    await childClosed;
    const resumed = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childCode], { env: environment, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    resumed.stdout.on("data", chunk => stdout += chunk);
    resumed.stderr.on("data", chunk => stderr += chunk);
    const resumedClosed = once(resumed, "close");
    const resumeTimer = setTimeout(() => resumed.kill("SIGKILL"), 6000);
    try {
      const [exit] = await resumedClosed;
      assert.equal(exit, 0, stderr);
      const profile = /^PROFILE=(.*)$/m.exec(stdout)?.[1];
      assert.ok(profile);
      assert.match(stderr, /Resuming interrupted connect at /);
      assert.equal((await readAgentProfile(profile)).principal_id, PRINCIPAL);
      assert.deepEqual(attempts.length, 2);
      assert.equal(new Set(attempts).size, 1);
      assert.equal((await readdir(join(root, ".cswarm", "agents"))).filter(entry => entry.startsWith("mcp-")).length, 1);
      await assert.rejects(stat(join(dirname(profile), "connect-pending.json")), { code: "ENOENT" });
      assert.doesNotMatch(stdout + stderr, /swm_join_|swm_agt_/);
    } finally {
      clearTimeout(resumeTimer);
      if (resumed.exitCode === null && resumed.signalCode === null) resumed.kill("SIGKILL");
      await resumedClosed.catch(() => undefined);
    }
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await childClosed.catch(() => undefined);
    server.closeAllConnections(); server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("generated register refusal inventory and typed remedies", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const noSeatRemedies: Record<string, string> = {
      forbidden: "This code is unknown, expired or no longer valid; this attempt created no seat. Ask the operator for a new code.",
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
        assert.equal(message, noSeatRemedies[code] ?? "The server reports that this code was already used. Ask the operator to inspect its seats before requesting a new code.");
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
      { code: "register_outcome_unknown", message: "The register outcome is unknown. Run the same cswarm mcp connect command again with the same code. If recovery fails, ask the operator to inspect this attempt before starting another connect." });
    assert.equal(f.calls(), 11);
  } finally { await f.close(); }
});

test("a previously redeemed code can later receive forbidden without claiming the code was unused", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    await connectMcp({ target: TARGET, profilePath: join(f.root, "first", "profile.json"), readCode: async () => JOIN, fetcher: f.fetcher });
    f.refuse("forbidden");
    await assert.rejects(connectMcp({ target: TARGET, profilePath: join(f.root, "later", "profile.json"), readCode: async () => JOIN, fetcher: f.fetcher }),
      { code: "forbidden", message: "This code is unknown, expired or no longer valid; this attempt created no seat. Ask the operator for a new code." });
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

test("every uncertain committed register and save failure keeps the same-attempt advice without leaking secrets", { timeout: 15000 }, async () => {
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
        assert.equal((error as Error).message, "The register outcome is unknown. Run the same cswarm mcp connect command again with the same code. If recovery fails, ask the operator to inspect this attempt before starting another connect.");
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

test("two concurrent connects for one profile serialize before a second POST", { timeout: 10000 }, async () => {
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
    assert.equal(loser.reason.code, "profile_exists");
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
      { code: "register_outcome_unknown", message: "The register outcome is unknown. Run the same cswarm mcp connect command again with the same code. If recovery fails, ask the operator to inspect this attempt before starting another connect." });
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
    }), { code: "register_outcome_unknown", message: "The register outcome is unknown. Run the same cswarm mcp connect command again with the same code. If recovery fails, ask the operator to inspect this attempt before starting another connect." });
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
