/** Message status from the agent's own host: closed labels, nothing from tool input or titles
 *  reaches a frame or the state file, the throttle, idle, and the one-second budget. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { ACTIVITY_STATUS_LABELS } from "../supabase/functions/activity/core.js";
import { cloudTarget } from "../src/cloud/config.js";
import { messageStatusHookInput } from "../src/listener/hook.js";
import {
  MESSAGE_STATUS_FILE,
  MESSAGE_STATUS_LABELS,
  MESSAGE_STATUS_THROTTLE_MS,
  acpToolKindLabel,
  applyMessageStatusEvent,
  claudeToolLabel,
  messageStatusOptedIn,
  setMessageStatusOptIn,
} from "../src/listener/message-status.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const SIGNAL_ID = "22222222-2222-4222-8222-222222222222";
const TARGET = cloudTarget("https://api.example.test", "anon-key");
const SECRETS = [
  "cat ~/.ssh/id_rsa",
  "https://internal.example.test/secret?token=abc",
  `swm_agt_${"c".repeat(43)}`,
  "/Users/someone/private/notes.md",
];
let root: string;

before(async () => { root = await mkdtemp(join(tmpdir(), "cswarm-message-status-")); });
after(async () => { await rm(root, { recursive: true, force: true }); });

function recorder() {
  const bodies: Array<Record<string, unknown>> = [];
  const fetcher = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ status: "accepted" }), { status: 202 });
  }) as typeof fetch;
  return { bodies, fetcher };
}

async function directory(): Promise<string> {
  return await mkdtemp(join(root, "agent-"));
}

test("the CLI labels are the edge's closed set, and tool names map to them", () => {
  assert.deepEqual([...MESSAGE_STATUS_LABELS], [...ACTIVITY_STATUS_LABELS]);
  assert.equal(claudeToolLabel("Read"), "reading");
  assert.equal(claudeToolLabel("Grep"), "searching");
  assert.equal(claudeToolLabel("Edit"), "editing");
  assert.equal(claudeToolLabel("Bash"), "running_command");
  assert.equal(claudeToolLabel("WebFetch"), "searching_web");
  for (const other of ["mcp__cswarm__ask", "Task", "toString", "__proto__", "", null, 7, { name: "Read" }]) {
    assert.equal(claudeToolLabel(other), "using_tool", `tool ${String(other)}`);
  }
  assert.equal(acpToolKindLabel("execute"), "running_command");
  assert.equal(acpToolKindLabel("think"), "thinking");
  assert.equal(acpToolKindLabel("constructor"), "using_tool");
  assert.equal(acpToolKindLabel(undefined), "using_tool");
});

test("a PreToolUse payload full of secrets reaches neither the frame nor the state file", async () => {
  const input = messageStatusHookInput({
    hook_event_name: "PreToolUse",
    session_id: "host-session",
    tool_name: "Bash",
    tool_input: { command: SECRETS[0], url: SECRETS[1], token: SECRETS[2], file_path: SECRETS[3] },
    cwd: SECRETS[3],
    transcript_path: SECRETS[3],
  });
  assert.deepEqual(input, { hookEventName: "PreToolUse", toolName: "Bash", hostSessionId: "host-session" });

  const dir = await directory();
  const { bodies, fetcher } = recorder();
  let now = 10_000;
  const apply = (event: Parameters<typeof applyMessageStatusEvent>[0]["event"]) => applyMessageStatusEvent({
    directory: dir, target: TARGET, credential: SECRETS[2]!, workspaceId: WORKSPACE_ID, event, fetcher, now: () => now,
  });
  assert.equal(await apply({ kind: "working", signalId: SIGNAL_ID }), "sent");
  now += MESSAGE_STATUS_THROTTLE_MS;
  assert.equal(await apply({ kind: "tool", label: claudeToolLabel(input.toolName) }), "sent");
  assert.deepEqual(bodies.map((body) => Object.keys(body).sort()), Array(2).fill(
    ["kind", "label", "sequence", "signal_id", "state", "stream_id", "version", "workspace_id"]));
  assert.deepEqual(bodies.map((body) => body.label), ["thinking", "running_command"]);
  const state = await readFile(join(dir, MESSAGE_STATUS_FILE), "utf8");
  for (const text of [JSON.stringify(bodies), state]) {
    for (const secret of SECRETS) assert.ok(!text.includes(secret), `leaked ${secret}`);
    assert.ok(!text.includes("Bash"), "the tool name itself never leaves the mapper");
  }
  assert.ok(!state.includes("running_command") && !state.includes("thinking"), "no label in the state file");
  assert.deepEqual(Object.keys(JSON.parse(state)).sort(), ["last_sent_at", "sequence", "signal_id", "stream_id", "version"]);
});

test("tool updates are throttled, stop goes idle once, and nothing is sent without a message", async () => {
  const dir = await directory();
  const { bodies, fetcher } = recorder();
  let now = 50_000;
  const apply = (event: Parameters<typeof applyMessageStatusEvent>[0]["event"]) => applyMessageStatusEvent({
    directory: dir, target: TARGET, credential: "token", workspaceId: WORKSPACE_ID, event, fetcher, now: () => now,
  });
  assert.equal(await apply({ kind: "tool", label: "editing" }), "skipped", "no message, no status");
  assert.equal(await apply({ kind: "stop" }), "skipped");
  assert.equal(await apply({ kind: "working", signalId: SIGNAL_ID }), "sent");
  now += MESSAGE_STATUS_THROTTLE_MS - 1;
  assert.equal(await apply({ kind: "tool", label: "editing" }), "skipped", "inside the throttle");
  now += 1;
  assert.equal(await apply({ kind: "tool", label: "editing" }), "sent");
  assert.equal(await apply({ kind: "stop" }), "sent");
  assert.equal(await apply({ kind: "stop" }), "skipped", "idle once");
  assert.equal(await apply({ kind: "tool", label: "reading" }), "skipped", "no message after idle");
  assert.deepEqual(bodies.map((body) => [body.state, body.signal_id, body.label, body.sequence]), [
    ["working", SIGNAL_ID, "thinking", 1],
    ["working", SIGNAL_ID, "editing", 2],
    ["idle", null, null, 3],
  ]);
  assert.equal(new Set(bodies.map((body) => body.stream_id)).size, 1, "one stream per agent state");
});

test("a server that never answers costs at most the budget, and the update reports failed", async () => {
  const dir = await directory();
  const hanging = ((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
  })) as typeof fetch;
  const started = Date.now();
  const result = await applyMessageStatusEvent({
    directory: dir, target: TARGET, credential: "token", workspaceId: WORKSPACE_ID,
    event: { kind: "working", signalId: SIGNAL_ID }, fetcher: hanging, budgetMs: 150,
  });
  assert.equal(result, "failed");
  assert.ok(Date.now() - started < 1_000, "bounded by the budget");
  const rejected = (async () => new Response("{}", { status: 403 })) as typeof fetch;
  assert.equal(await applyMessageStatusEvent({
    directory: dir, target: TARGET, credential: "token", workspaceId: WORKSPACE_ID,
    event: { kind: "working", signalId: SIGNAL_ID }, fetcher: rejected,
  }), "failed", "a refused update is not an error to the caller");
});

test("the listener opt-in marker turns on and off", async () => {
  const dir = await directory();
  assert.equal(await messageStatusOptedIn(dir), false);
  await setMessageStatusOptIn(dir, true);
  assert.equal(await messageStatusOptedIn(dir), true);
  await setMessageStatusOptIn(dir, false);
  assert.equal(await messageStatusOptedIn(dir), false);
  await setMessageStatusOptIn(dir, false);
});
