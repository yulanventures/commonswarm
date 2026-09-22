/** ATTENDING: hook follows a settings file, not a leftover hook surface. Reached by `npm run test:p1-cli`. */
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cloudTarget } from "../../src/cloud/config.js";
import { writeSecureJsonFile } from "../../src/cloud/storage.js";
import {
  claudeUserPromptHookSnippet,
  collectListenerAttendanceEvidence,
  renderListenerStatus,
} from "../../src/cli.js";
import {
  FileHookSurfaceStore,
  type ListenerStatus,
} from "../../src/listener/index.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const PRINCIPAL_ID = "22222222-2222-4222-8222-222222222222";

function statusFor(logPath: string): ListenerStatus {
  return {
    version: 1,
    instanceId: "44444444-4444-4444-8444-444444444444",
    provider: "claude",
    profileId: "profile-attendance",
    workspaceId: WORKSPACE_ID,
    principalId: PRINCIPAL_ID,
    pid: 1234,
    state: "ready",
    startedAt: "2026-09-22T00:00:00.000Z",
    readyAt: "2026-09-22T00:00:01.000Z",
    updatedAt: "2026-09-22T00:00:02.000Z",
    stoppedAt: null,
    lastSignalId: null,
    lastErrorCode: null,
    lastErrorDetail: null,
    lastWorkerStderrTail: null,
    deliveryMode: "durable_claim",
    pendingDeliveryCount: 0,
    lastTerminalDeliveryFailureCount: null,
    lastTerminalDeliveryFailureAt: null,
    lastClaimAt: null,
    lastAckAt: null,
    lastAckOutcome: null,
    consecutiveAckFailureCount: null,
    routeMode: "main",
    deferOverChars: null,
    pendingForMainCount: 0,
    droppedForMainCount: 0,
    logPath,
  };
}

test("ATTENDING: hook is false when no hook is installed", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-attending-hook-"));
  const cwd = join(root, "work");
  const instanceDirectory = join(root, "listener");
  const claudeConfig = join(root, "claude-config");
  const stateHome = join(root, "state");
  const previousClaude = process.env.CLAUDE_CONFIG_DIR;
  const previousState = process.env.XDG_STATE_HOME;
  process.env.CLAUDE_CONFIG_DIR = claudeConfig;
  process.env.XDG_STATE_HOME = stateHome;
  try {
    await mkdir(cwd, { recursive: true });
    await mkdir(instanceDirectory, { recursive: true, mode: 0o700 });
    await chmod(instanceDirectory, 0o700);
    await mkdir(claudeConfig, { recursive: true });
    await writeSecureJsonFile(
      join(instanceDirectory, "hook-surface.json"),
      JSON.stringify({
        version: 1,
        surfacedSignalIds: [],
        reportedDroppedCount: 0,
        credentialFailureReported: false,
      }),
    );
    const surface = await new FileHookSurfaceStore(instanceDirectory).evidence();
    assert.equal(surface.exists, true);
    const cloud = cloudTarget("https://cloud.example.test", "anon");
    const stale = await collectListenerAttendanceEvidence({
      instanceDirectory,
      cwd,
      principalId: PRINCIPAL_ID,
      cloud,
      workspaceId: WORKSPACE_ID,
      pendingForMainOldestAt: null,
      hookSurfaceExists: surface.exists,
      hookSurfaceAdvanced: surface.surfacedSignalIds.length > 0,
    });
    assert.deepEqual(stale.attendingSurfaces, []);
    const staleText = renderListenerStatus(statusFor(join(instanceDirectory, "events.ndjson")), stale);
    assert.match(staleText, /ATTENDING: none/);
    assert.doesNotMatch(staleText, /ATTENDING: hook/);

    await mkdir(join(cwd, ".claude"), { recursive: true });
    await writeFile(
      join(cwd, ".claude", "settings.local.json"),
      JSON.stringify(claudeUserPromptHookSnippet(PRINCIPAL_ID)),
    );
    const installed = await collectListenerAttendanceEvidence({
      instanceDirectory,
      cwd,
      principalId: PRINCIPAL_ID,
      cloud,
      workspaceId: WORKSPACE_ID,
      pendingForMainOldestAt: null,
      hookSurfaceExists: false,
      hookSurfaceAdvanced: false,
    });
    assert.deepEqual(installed.attendingSurfaces, ["hook"]);
    const installedText = renderListenerStatus(
      statusFor(join(instanceDirectory, "events.ndjson")),
      installed,
    );
    assert.match(installedText, /ATTENDING: hook\./);
  } finally {
    if (previousClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousClaude;
    if (previousState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousState;
    await rm(root, { recursive: true, force: true });
  }
});
