/**
 * Adversarial controls for provider version floors.
 *
 * ★ THIS FILE IS NAMED IN `npm test`; it uses fake executables and no network,
 * provider session, or billable model prompt.
 */
import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AcpPermissionCanaryError,
  AcpVersionError,
  CODEX_ACP_LAST_MEASURED_VERSION,
  CODEX_ACP_MIN_VERSION,
  assertGrokVersionFloor,
  assertCodexVersionFloor,
  type GrokAcpHandle,
} from "../src/host/index.js";
import { GrokListenerModel } from "../src/listener/grok-model.js";

test("Codex CLI banner fails with executable_not_bridge while codex-acp parses", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-codex-cli-shape-"));
  const codexCli = join(root, "codex");
  const codexAcp = join(root, "codex-acp");
  try {
    await writeFile(
      codexCli,
      `#!${process.execPath}\nprocess.stdout.write("codex-cli 0.147.0\\n");\n`,
      { mode: 0o700 },
    );
    await writeFile(
      codexAcp,
      `#!${process.execPath}\nprocess.stdout.write("@agentclientprotocol/codex-acp 1.8.0\\n");\n`,
      { mode: 0o700 },
    );
    await Promise.all([chmod(codexCli, 0o700), chmod(codexAcp, 0o700)]);
    await assert.rejects(
      () => assertCodexVersionFloor(codexCli),
      (error: unknown) => {
        assert.ok(error instanceof AcpVersionError);
        assert.equal(error.code, "executable_not_bridge");
        assert.match(error.message, /this is the Codex CLI/);
        assert.match(error.message, /--codex-executable takes the codex-acp bridge/);
        assert.match(error.message, /npm i -g @agentclientprotocol\/codex-acp/);
        return true;
      },
    );
    assert.equal(await assertCodexVersionFloor(codexAcp), "1.8.0");
    assert.equal(CODEX_ACP_MIN_VERSION, "1.1.9");
    assert.equal(CODEX_ACP_LAST_MEASURED_VERSION, "1.8.0");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a comfortably newer version cannot bypass a failing permission canary", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-version-canary-"));
  const executable = join(root, "grok");
  let canaryCalls = 0;
  let closeCalls = 0;
  try {
    await writeFile(
      executable,
      `#!${process.execPath}\nprocess.stdout.write("grok 9.0.0\\n");\n`,
      { mode: 0o700 },
    );
    await chmod(executable, 0o700);
    const model = new GrokListenerModel({
      cwd: root,
      executable,
      open: async (options): Promise<GrokAcpHandle> => {
        await assertGrokVersionFloor(options.executable!);
        return {
          session: {
            async enablePromptsAfterCanary() {
              canaryCalls += 1;
              throw new AcpPermissionCanaryError("adversarial canary refusal");
            },
          },
          child: {},
          executable,
          args: [],
          env: {},
          async close() {
            closeCalls += 1;
          },
        } as unknown as GrokAcpHandle;
      },
    });
    await assert.rejects(
      () => model.start(),
      (error: unknown) =>
        error instanceof AcpPermissionCanaryError &&
        error.code === "permission_canary_failed",
    );
    assert.equal(canaryCalls, 1, "the high version must reach the canary");
    assert.equal(closeCalls, 1, "a canary failure must close the worker");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
