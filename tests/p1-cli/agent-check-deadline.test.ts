import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { test } from "node:test";
import { AGENT_CREDENTIAL_MESSAGE_D088 } from "../../src/cloud/agent-credential-input.js";
import { checkAgentMessages, renderAgentCheck } from "../../src/cloud/agent-check.js";
import type { AgentProfile } from "../../src/cloud/agent-profile.js";
import type { SignalRecord } from "../../src/cloud/command-client.js";
import { createLaneTempHome, removeLaneTempHome } from "../support/lane-temp-home.js";

const WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWNER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TOKEN = `swm_agt_${"A".repeat(43)}`;

function row(i: number): SignalRecord {
  return { id: `${String(i).padStart(8, "0")}-1111-4111-8111-111111111111`, workspace_id: WS,
    from: OWNER, from_kind: "user", to: null, to_agent: AGENT, in_reply_to: null, about: null,
    kind: i % 2 ? "ask" : "note", body: `message ${i}`, until: "2099-01-01T00:00:00.000Z",
    created_at: "2026-09-08T00:00:00.000Z", sender_owner_relation: "same_owner" };
}

function requestStarted() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("in-flight observation ends within the remaining check deadline", { timeout: 5_000 }, async (t) => {
  const root = createLaneTempHome("agent-check-deadline-");
  const previousState = process.env.SWARM_AGENT_STATE_DIR;
  process.env.SWARM_AGENT_STATE_DIR = join(root, "renewal");
  t.after(() => {
    if (previousState === undefined) delete process.env.SWARM_AGENT_STATE_DIR;
    else process.env.SWARM_AGENT_STATE_DIR = previousState;
    removeLaneTempHome(root);
  });
  // Write only fixture input. Avoid setup's unrelated host detection and home inventory.
  const profilePath = join(root, "profile.json");
  const profile: AgentProfile = { version: 1, url: "https://fixture.example", anon_key: "public-fixture",
    workspace_id: WS, principal_id: AGENT, credential_file: join(root, "credential.json") };
  await writeFile(profilePath, JSON.stringify(profile), { mode: 0o600 });
  await writeFile(profile.credential_file, JSON.stringify({
    message: AGENT_CREDENTIAL_MESSAGE_D088, status: "accepted", principal_id: AGENT,
    token_id: "11111111-1111-4111-8111-111111111111", run_id: "22222222-2222-4222-8222-222222222222",
    agent_token: TOKEN, expires_at: "2099-01-01T00:00:00.000Z",
  }), { mode: 0o600 });

  // Disk and runner scheduling consume no simulated time. Advance only after each
  // real ACK call site is reached: 160 ms for the first, then its 190 ms remainder.
  const startedAt = Date.now();
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: startedAt });
  const deadline = startedAt + 350;
  const firstStarted = requestStarted();
  const secondStarted = requestStarted();
  const ackSignals: AbortSignal[] = [];
  const fetcher = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${TOKEN}`);
    assert.equal(init?.redirect, "error");
    if (body.command?.kind === "ack_agent_delivery") {
      assert.equal(body.command.unclaimed, true);
      assert.equal(body.command.lease_id, null);
      assert.equal(body.command.outcome, "observed");
      assert.equal(body.command.signal_id, row(ackSignals.length + 1).id);
      assert.ok(init?.signal instanceof AbortSignal);
      ackSignals.push(init.signal);
      if (ackSignals.length === 1) {
        firstStarted.resolve();
        await new Promise(resolve => setTimeout(resolve, 160));
        return new Response(JSON.stringify({ error: "temporarily_unavailable" }), { status: 503 });
      }
      secondStarted.resolve();
      return await new Promise<Response>(() => {}); // transport ignores abort
    }
    if (body.command?.kind === "touch_agent_presence") return Response.json({ ok: true });
    if (body.resource === "members") return Response.json({
      members: [{ user_id: OWNER, display_name: "Owner" }],
      agents: [{ principal_id: AGENT, name: "Test agent", owner_user_id: OWNER }],
      identity: { credential_valid: true, principal_id: AGENT, workspace_id: WS, owner_user_id: OWNER },
    });
    assert.equal(body.resource, "signals");
    return Response.json({ signals: [row(1), row(2)], capabilities: { sender_owner_relation: 1, cursor_after: 1 } });
  }) as typeof fetch;
  const output: string[] = [];
  let forcedExitText = "";
  const hardExit = setTimeout(() => { forcedExitText = "check_timeout"; }, deadline - Date.now() + 150);
  let settled = false;
  const checking = checkAgentMessages({ profilePath, fetcher, deadlineAtMs: deadline,
    present: async value => { output.push(renderAgentCheck(value)); } });
  const completed = checking.then(result => { settled = true; return result; });
  try {
    for (const started of [firstStarted, secondStarted]) {
      await Promise.race([started.promise, completed.then(() => assert.fail("check ended before both ACKs started"))]);
      if (started === firstStarted) t.mock.timers.tick(160);
    }
    assert.equal(ackSignals.length, 2, "a second ACK must start when 190 ms remains");
    assert.equal(Date.now(), startedAt + 160);
    t.mock.timers.tick(189);
    await nextTurn();
    assert.equal(settled, false, "the in-flight ACK cannot finish before its remaining deadline");
    assert.equal(ackSignals[1]!.aborted, false);
    t.mock.timers.tick(1);
    await nextTurn();
    assert.equal(ackSignals[1]!.aborted, true, "the second ACK must abort at the original check deadline");
    assert.equal(settled, true, "even a transport ignoring abort must settle at the check deadline");
    const result = await completed;
    assert.equal(result.messages.length, 2);
    assert.equal(ackSignals.length, 2);
    assert.ok(output[0]?.includes(row(1).id));
    assert.ok(Date.now() < deadline + 100, "an ack in flight must finish before hook forced-exit grace");
    assert.equal(forcedExitText, "", "the forced-exit failure text cannot fire after an ACK deadline");
    assert.doesNotMatch(output.join(""), /check_timeout/);
  } finally { clearTimeout(hardExit); }
  t.mock.timers.tick(150);
  assert.equal(forcedExitText, "", "the cleared forced-exit timer cannot emit a later failure");
});
