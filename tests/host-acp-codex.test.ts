/**
 * Pure process-boundary coverage for codex-acp 1.1.9.
 *
 * ★ THIS FILE IS NAMED IN `npm test`; it uses fake bridge executables and no
 * network, Codex session, or billable model prompt.
 */
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registerStderrExitParityTests } from "./support/host-stderr-exit-parity.js";
import {
  CODEX_ACP_MIN_VERSION,
  assertCodexVersionFloor,
  buildCodexChildEnv,
  buildCodexLaunch,
  openCodexAcpSession,
  resolveCodexExecutable,
} from "../src/host/index.js";

registerStderrExitParityTests({
  provider: "Codex",
  executableName: "codex-acp.cjs",
  open: ({ cwd, executable, onStderrTail }) =>
    openCodexAcpSession({
      cwd,
      executable,
      env: { PATH: "/usr/bin", HOME: join(cwd, "operator-home") },
      requestTimeoutMs: 2_000,
      skipVersionCheck: true,
      onStderrTail,
    }),
});

async function writeFakeCodexBridge(
  root: string,
  protocolVersion = 1,
): Promise<{ target: string; shim: string; log: string }> {
  const target = join(root, `fake-codex-acp-${protocolVersion}.cjs`);
  const shim = join(root, "codex-acp");
  const log = join(root, `bridge-${protocolVersion}.ndjson`);
  await writeFile(
    target,
    `#!${process.execPath}\n` +
      `const fs = require("node:fs");\n` +
      `const log = ${JSON.stringify(log)};\n` +
      `fs.appendFileSync(log, JSON.stringify({ args: process.argv.slice(2), home: process.env.HOME ?? null, swarm: process.env.SWARM_AGENT_TOKEN ?? null, pid: process.pid }) + "\\n");\n` +
      `if (process.argv[2] === "--version") { process.stdout.write("@agentclientprotocol/codex-acp 1.1.9\\n"); process.exit(0); }\n` +
      `let buffer = "";\n` +
      `process.stdin.setEncoding("utf8");\n` +
      `process.stdin.on("data", (chunk) => {\n` +
      `  buffer += chunk;\n` +
      `  let newline;\n` +
      `  while ((newline = buffer.indexOf("\\n")) !== -1) {\n` +
      `    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);\n` +
      `    if (!line.trim()) continue;\n` +
      `    const message = JSON.parse(line);\n` +
      `    fs.appendFileSync(log, JSON.stringify({ method: message.method, params: message.params }) + "\\n");\n` +
      `    let result;\n` +
      `    if (message.method === "initialize") result = { protocolVersion: ${protocolVersion}, agentCapabilities: {}, authMethods: [], _meta: { agentVersion: "1.1.9" } };\n` +
      `    else if (message.method === "session/new") result = { sessionId: "codex-test-session", modes: { currentModeId: "agent", availableModes: [{ id: "agent" }, { id: "read-only" }] } };\n` +
      `    else if (message.method === "session/load") result = { sessionId: message.params.sessionId };\n` +
      `    else if (message.method === "session/set_mode") result = {};\n` +
      `    else if (message.method === "session/prompt") result = { stopReason: "end_turn" };\n` +
      `    else continue;\n` +
      `    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");\n` +
      `  }\n` +
      `});\n` +
      `process.on("SIGTERM", () => process.exit(0));\n`,
    { mode: 0o700 },
  );
  await chmod(target, 0o700);
  await symlink(target, shim);
  return { target, shim, log };
}

test("Codex child env preserves HOME but strips inherited Codex and credential state", () => {
  const env = buildCodexChildEnv({
    PATH: "/usr/bin",
    HOME: process.env.HOME,
    USER: "test",
    LANG: "en_US.UTF-8",
    CODEX_THREAD_ID: "codex",
    CODEX_MANAGED_BY_NPM: "session",
    OPENAI_API_KEY: "secret",
    SWARM_AGENT_TOKEN: "secret",
    NODE_OPTIONS: "--require /tmp/hook.js",
  });
  assert.deepEqual(env, {
    PATH: "/usr/bin",
    HOME: process.env.HOME,
    USER: "test",
    LANG: "en_US.UTF-8",
  });
  assert.equal(JSON.stringify(env).includes("secret"), false);
});

test("Codex executable PATH walk resolves an npm-style shim to one real path", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-codex-resolve-"));
  const target = join(root, "bridge-target");
  const shim = join(root, "codex-acp");
  try {
    await writeFile(target, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await chmod(target, 0o700);
    await symlink(target, shim);
    assert.equal(
      resolveCodexExecutable("codex-acp", root),
      realpathSync(target),
    );
    assert.equal(resolveCodexExecutable(shim, "/unused"), realpathSync(target));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows npm shim resolves to one Node-launched package entrypoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-codex-win-shim-"));
  const targetDir = join(
    root,
    "node_modules",
    "@agentclientprotocol",
    "codex-acp",
    "dist",
  );
  const target = join(targetDir, "index.js");
  const shim = join(root, "codex-acp.cmd");
  try {
    await mkdir(targetDir, { recursive: true });
    await writeFile(
      target,
      `if (process.argv[2] === "--version") process.stdout.write("@agentclientprotocol/codex-acp 1.1.9\\n");\n`,
    );
    await writeFile(
      shim,
      `@ECHO off\r\n"%dp0%\\node_modules\\@agentclientprotocol\\codex-acp\\dist\\index.js" %*\r\n`,
      { mode: 0o700 },
    );
    await chmod(shim, 0o700);
    const resolved = resolveCodexExecutable(shim, "/unused", "win32");
    assert.equal(resolved, realpathSync(target));
    assert.deepEqual(buildCodexLaunch(resolved, [], "win32"), {
      command: process.execPath,
      args: [resolved],
    });
    assert.equal(
      await assertCodexVersionFloor(resolved, { platform: "win32" }),
      CODEX_ACP_MIN_VERSION,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("openCodexAcpSession probes and spawns one realpath with one sanitized env", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-codex-open-"));
  const cwd = await mkdtemp(join(tmpdir(), "cswarm-codex-cwd-"));
  try {
    const fake = await writeFakeCodexBridge(root);
    const handle = await openCodexAcpSession({
      cwd,
      executable: fake.shim,
      env: {
        PATH: root,
        HOME: join(root, "operator-home"),
        SWARM_AGENT_TOKEN: "must-not-reach-child",
      },
      requestTimeoutMs: 2_000,
    });
    assert.equal(handle.executable, realpathSync(fake.target));
    assert.deepEqual(handle.args, []);
    assert.equal(handle.env.HOME, join(root, "operator-home"));
    assert.equal(handle.env.SWARM_AGENT_TOKEN, undefined);
    assert.deepEqual(await handle.session.load("codex-restored-session"), {
      sessionId: "codex-restored-session",
      loaded: true,
    });
    const rows = (await readFile(fake.log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as {
        args?: string[];
        home: string | null;
        swarm: string | null;
        method?: string;
        params?: unknown;
      });
    const processRows = rows.filter((row) => Array.isArray(row.args));
    assert.deepEqual(processRows.map((row) => row.args), [["--version"], []]);
    assert.deepEqual(processRows.map((row) => row.home), [
      join(root, "operator-home"),
      join(root, "operator-home"),
    ]);
    assert.deepEqual(processRows.map((row) => row.swarm), [null, null]);
    const modeFrames = rows.filter((row) => row.method === "session/set_mode");
    assert.deepEqual(modeFrames.map((row) => row.params), [
      { sessionId: "codex-test-session", modeId: "read-only" },
      { sessionId: "codex-restored-session", modeId: "read-only" },
    ]);
    await handle.close();
    assert.ok(handle.child.exitCode !== null || handle.child.signalCode !== null);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});
