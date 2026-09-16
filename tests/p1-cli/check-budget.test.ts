import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, test } from "node:test";
import {
  AGENT_CHECK_OUTPUT_ALLOWANCE_MS,
  AGENT_CHECK_STARTUP_ALLOWANCE_MS,
  AGENT_CHECK_TIMEOUT_MS,
  HOST_HOOK_TIMEOUT_SECONDS,
} from "../../src/cloud/agent-check-budget.js";
import { AGENT_CREDENTIAL_MESSAGE_D088 } from "../../src/cloud/agent-credential-input.js";
import { checkAgentMessages } from "../../src/cloud/agent-check.js";
import { mergeReceiveHooks } from "../../src/cloud/agent-receive.js";
import type { SignalRecord } from "../../src/cloud/command-client.js";

const WORKSPACE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PRINCIPAL_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWNER_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TOKEN = `swm_agt_${"A".repeat(43)}`;
let root: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "cswarm-check-budget-test-"));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

function signal(index: number): SignalRecord {
  return {
    id: `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`,
    workspace_id: WORKSPACE_ID,
    from: OWNER_ID,
    from_kind: "user",
    to: null,
    to_agent: PRINCIPAL_ID,
    in_reply_to: null,
    about: null,
    kind: "ask",
    body: `message ${index}`,
    until: "2099-01-01T00:00:00.000Z",
    created_at: `2026-09-16T00:00:0${index}.000Z`,
    sender_owner_relation: "same_owner",
  };
}

async function profile(): Promise<string> {
  const directory = await mkdtemp(join(root, "profile-"));
  const credentialFile = join(directory, "credential.json");
  const profilePath = join(directory, "profile.json");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(credentialFile, JSON.stringify({
    message: AGENT_CREDENTIAL_MESSAGE_D088,
    status: "accepted",
    principal_id: PRINCIPAL_ID,
    token_id: "11111111-1111-4111-8111-111111111111",
    run_id: "22222222-2222-4222-8222-222222222222",
    agent_token: TOKEN,
    expires_at: "2099-01-01T00:00:00.000Z",
  }), { mode: 0o600 });
  await writeFile(profilePath, JSON.stringify({
    version: 1,
    url: "http://127.0.0.1:9",
    anon_key: "public-test",
    workspace_id: WORKSPACE_ID,
    principal_id: PRINCIPAL_ID,
    credential_file: credentialFile,
  }), { mode: 0o600 });
  return profilePath;
}

function fetcher(rows: SignalRecord[], waitMs: number): typeof fetch {
  return (async (_input: unknown, init?: RequestInit) => {
    await delay(waitMs, undefined, { signal: init?.signal ?? undefined });
    const body = JSON.parse(String(init?.body));
    if (body.resource === "members") return new Response(JSON.stringify({
      members: [{ user_id: OWNER_ID, display_name: "Owner" }],
      agents: [{ principal_id: PRINCIPAL_ID, name: "Agent", owner_user_id: OWNER_ID }],
      identity: {
        credential_valid: true,
        principal_id: PRINCIPAL_ID,
        workspace_id: WORKSPACE_ID,
        owner_user_id: OWNER_ID,
      },
    }), { status: 200 });
    if (body.resource === "signals") return new Response(JSON.stringify({
      signals: rows.filter(row => !body.after_id || row.id > body.after_id),
      capabilities: { sender_owner_relation: 1, cursor_after: 1 },
    }), { status: 200 });
    throw new Error(`unexpected resource: ${body.resource}`);
  }) as typeof fetch;
}

test("check budget plus measured allowances equals the host-hook ceiling", () => {
  assert.equal(
    AGENT_CHECK_TIMEOUT_MS + AGENT_CHECK_STARTUP_ALLOWANCE_MS + AGENT_CHECK_OUTPUT_ALLOWANCE_MS,
    HOST_HOOK_TIMEOUT_SECONDS * 1_000,
  );
});

test("receive hook settings use the exported host-hook ceiling", () => {
  const settings = mergeReceiveHooks({}, "cswarm check", null, false);
  const hooks = settings.hooks as Record<string, unknown>;
  const groups = hooks.UserPromptSubmit as Array<{ hooks: Array<{ timeout: number }> }>;
  assert.equal(groups[0]?.hooks[0]?.timeout, HOST_HOOK_TIMEOUT_SECONDS);
});

test("check succeeds below its budget and times out without moving the cursor above it", { timeout: 20_000 }, async () => {
  const profilePath = await profile();
  const first = signal(1);
  const below = await checkAgentMessages({
    profilePath,
    fetcher: fetcher([first], AGENT_CHECK_TIMEOUT_MS - 100),
    present: async () => {},
  });
  assert.deepEqual(below.messages.map(row => row.id), [first.id]);

  const second = signal(2);
  await assert.rejects(checkAgentMessages({
    profilePath,
    fetcher: fetcher([first, second], AGENT_CHECK_TIMEOUT_MS + 100),
    present: async () => {},
  }), { code: "check_timeout" });
  const timedOutState = JSON.parse(await readFile(join(dirname(profilePath), "check.json"), "utf8"));
  assert.equal(timedOutState.cursor.id, first.id);

  const after = await checkAgentMessages({
    profilePath,
    fetcher: fetcher([first, second], 0),
    present: async () => {},
  });
  assert.deepEqual(after.messages.map(row => row.id), [second.id]);
});
