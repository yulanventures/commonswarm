import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyRosterSeatStatus,
  classifySeatStatus,
  formatSeatAgo,
  formatSeatClock,
  formatSeatElapsed,
  sanitizeSeatWorkText,
  SEAT_WAITING_STALE_MS,
  SEAT_WAKE_LEASE_STALE_MS,
  SEAT_WORK_RECENT_MS,
} from "../src/protocol/seat-status.js";
import { mapRoster } from "../src/mcp/tools.js";
import type { AgentRoster, RosterEntry } from "../src/cloud/signals.js";

const NOW = Date.parse("2026-11-20T16:45:00Z"); // 10:45 CST / 16:45 UTC
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function presenceRow(overrides: Record<string, unknown> = {}) {
  return {
    last_command_at: null,
    client_build: null,
    watcher_at: null,
    channel_at: null,
    listener_at: null,
    turn_at: null,
    last_ack_via: null,
    last_ack_at: null,
    current_client_build: null,
    ...overrides,
  };
}

test("C2 canonical status lines match spec with age on every value and never fake a live dot", () => {
  // 1. Working · 3 min (verified live push listener lease -> dot)
  const working = classifySeatStatus({
    transport: "local",
    turnOnly: false,
    connection: "live",
    presence: presenceRow({ last_command_at: ago(60_000), watcher_at: ago(30_000) }),
    workingOn: { since: ago(3 * 60_000), until: new Date(NOW + 30 * 60_000).toISOString(), text: "shipping C2", scope: "public_channel" },
    timeZone: "UTC",
  }, NOW);
  assert.equal(working.kind, "working");
  assert.equal(working.line, "Working · 3 min");
  assert.equal(working.indicator, "dot");
  assert.equal(working.attention, false);
  assert.equal(working.work_text, "shipping C2");

  // 1b. Turn-only seat with work 3 min ago -> "Working · 3 min ago" and hollow ring (never a filled dot without a verified live listener lease)
  const turnOnlyWorking = classifySeatStatus({
    transport: "hosted_mcp",
    turnOnly: true,
    connection: "live",
    presence: presenceRow({ last_command_at: ago(3 * 60_000), turn_at: ago(3 * 60_000) }),
    workingOn: { since: ago(3 * 60_000), until: new Date(NOW + 30 * 60_000).toISOString(), text: "shipping C2", scope: "public_channel" },
    timeZone: "UTC",
  }, NOW);
  assert.equal(turnOnlyWorking.kind, "working");
  assert.equal(turnOnlyWorking.line, "Working · 3 min ago");
  assert.equal(turnOnlyWorking.indicator, "ring");
  assert.equal(turnOnlyWorking.attention, false);

  // 1c. Same turn-only working seat with 2 unseen messages from 1 min ago -> "Waiting since … · 2 unseen" with diamond immediately once count is known
  const turnOnlyWorkingWithUnseen = classifySeatStatus({
    transport: "hosted_mcp",
    turnOnly: true,
    connection: "live",
    presence: presenceRow({ last_command_at: ago(3 * 60_000), turn_at: ago(3 * 60_000) }),
    workingOn: { since: ago(3 * 60_000), until: new Date(NOW + 30 * 60_000).toISOString(), text: "shipping C2", scope: "public_channel" },
    waitingSince: ago(60_000),
    unseenCount: 2,
    timeZone: "America/Chicago",
  }, NOW);
  assert.equal(turnOnlyWorkingWithUnseen.kind, "waiting");
  assert.equal(turnOnlyWorkingWithUnseen.line, "Waiting since 10:44 · 2 unseen");
  assert.equal(turnOnlyWorkingWithUnseen.indicator, "diamond");
  assert.equal(turnOnlyWorkingWithUnseen.unseen_count, 2);

  // 2. Waiting since 10:42 · 2 unseen (stale >= 3 min -> diamond, attention on push seat)
  const waiting = classifySeatStatus({
    transport: "local",
    turnOnly: false,
    connection: "live",
    presence: presenceRow({ last_command_at: ago(5 * 60_000), watcher_at: ago(30_000) }),
    waitingSince: "2026-11-20T16:42:00Z",
    unseenCount: 2,
    timeZone: "America/Chicago",
  }, NOW);
  assert.equal(waiting.kind, "waiting");
  assert.equal(waiting.line, "Waiting since 10:42 · 2 unseen");
  assert.equal(waiting.stale_waiting, true);
  assert.equal(waiting.indicator, "diamond");
  assert.equal(waiting.attention, true);
  assert.equal(waiting.unseen_count, 2);

  // 3. Turn-only, checks when opened (hosted MCP -> NEVER a live dot, always shows age when known)
  const hostedActive = classifySeatStatus({
    transport: "hosted_mcp",
    turnOnly: true,
    connection: "live",
    presence: presenceRow({ last_command_at: ago(5 * 60_000), turn_at: ago(5 * 60_000) }),
  }, NOW);
  assert.equal(hostedActive.kind, "turn_only");
  assert.equal(hostedActive.line, "Turn-only, checks when opened · 5 min ago");
  assert.equal(hostedActive.indicator, "ring");
  assert.equal(hostedActive.attention, false);

  const hostedNever = classifySeatStatus({
    transport: "hosted_mcp",
    turnOnly: true,
    connection: "live",
    presence: null,
  }, NOW);
  assert.equal(hostedNever.kind, "turn_only");
  assert.equal(hostedNever.line, "Turn-only, checks when opened");
  assert.equal(hostedNever.indicator, "ring");

  // 4. Not listening (local push seat with stale or missing lease -> uses last-activity timestamp, NEVER a live dot)
  const notListening = classifySeatStatus({
    transport: "local",
    turnOnly: false,
    connection: "live",
    presence: presenceRow({
      last_command_at: ago(2 * 3_600_000),
      watcher_at: ago(SEAT_WAKE_LEASE_STALE_MS + 1_000),
    }),
  }, NOW);
  assert.equal(notListening.kind, "not_listening");
  assert.equal(notListening.line, "Not listening · last active 2 h ago");
  assert.equal(notListening.indicator, "ring");
  assert.equal(notListening.attention, false);

  const neverListened = classifySeatStatus({
    transport: "local",
    turnOnly: false,
    connection: "live",
    presence: null,
  }, NOW);
  assert.equal(neverListened.kind, "not_listening");
  assert.equal(neverListened.line, "Not listening");
  assert.equal(neverListened.indicator, "ring");

  // 5. Verified live push listener lease (<= WAKE_LEASE_STALE_MS -> uses lease timestamp "Listening · verified …", NOT last activity)
  const listeningVerifiedNow = classifySeatStatus({
    transport: "local",
    turnOnly: false,
    connection: "live",
    presence: presenceRow({
      last_command_at: ago(110 * 60_000),
      watcher_at: ago(0),
    }),
  }, NOW);
  assert.equal(listeningVerifiedNow.kind, "listening");
  assert.equal(listeningVerifiedNow.line, "Listening · verified just now");
  assert.equal(listeningVerifiedNow.indicator, "dot");
  assert.equal(listeningVerifiedNow.attention, false);

  const listening = classifySeatStatus({
    transport: "local",
    turnOnly: false,
    connection: "live",
    presence: presenceRow({
      last_command_at: ago(110 * 60_000),
      watcher_at: ago(2 * 60_000),
    }),
  }, NOW);
  assert.equal(listening.kind, "listening");
  assert.equal(listening.line, "Listening · verified 2 min ago");
  assert.equal(listening.indicator, "dot");
  assert.equal(listening.attention, false);

  // 6. Failed status read -> "Status unavailable" with hollow ring
  const failedReadLocal = classifySeatStatus({
    transport: "local",
    turnOnly: false,
    connection: "live",
  }, NOW);
  assert.equal(failedReadLocal.kind, "unknown");
  assert.equal(failedReadLocal.line, "Status unavailable");
  assert.equal(failedReadLocal.indicator, "ring");

  const failedReadHosted = classifySeatStatus({
    transport: "hosted_mcp",
    turnOnly: true,
    connection: "live",
    statusUnavailable: true,
  }, NOW);
  assert.equal(failedReadHosted.kind, "unknown");
  assert.equal(failedReadHosted.line, "Status unavailable");
  assert.equal(failedReadHosted.indicator, "ring");
});

test("C2 waiting threshold: known unseen count wins immediately with diamond; legacy unknown count waits for WAKE_STALE_MS on live seats", () => {
  const briefWaiting = ago(SEAT_WAITING_STALE_MS - 60_000); // 2 min ago
  // Legacy wake_path without unseen_count: live listener tolerates brief <3m delivery
  const liveSeatLegacy = classifySeatStatus({
    transport: "local",
    turnOnly: false,
    connection: "live",
    presence: presenceRow({ last_command_at: ago(60_000), listener_at: ago(10_000) }),
    waitingSince: briefWaiting,
    timeZone: "UTC",
  }, NOW);
  assert.equal(liveSeatLegacy.kind, "listening", "live listener without known unseenCount does not jitter before WAKE_STALE_MS");
  assert.equal(liveSeatLegacy.indicator, "dot");

  // Once unseenCount is known (> 0), Waiting with diamond surfaces immediately even at 1 min
  const liveSeatKnownCount = classifySeatStatus({
    transport: "local",
    turnOnly: false,
    connection: "live",
    presence: presenceRow({ last_command_at: ago(60_000), listener_at: ago(10_000) }),
    waitingSince: ago(60_000),
    unseenCount: 2,
    timeZone: "UTC",
  }, NOW);
  assert.equal(liveSeatKnownCount.kind, "waiting");
  assert.equal(liveSeatKnownCount.line, "Waiting since 16:44 · 2 unseen");
  assert.equal(liveSeatKnownCount.indicator, "diamond");

  const deadSeat = classifySeatStatus({
    transport: "local",
    turnOnly: false,
    connection: "live",
    presence: presenceRow({ last_command_at: ago(10 * 60_000) }),
    waitingSince: briefWaiting,
    unseenCount: 1,
    timeZone: "UTC",
  }, NOW);
  assert.equal(deadSeat.kind, "waiting");
  assert.equal(deadSeat.line, "Waiting since 16:43 · 1 unseen");
  assert.equal(deadSeat.stale_waiting, false);
  assert.equal(deadSeat.indicator, "diamond");
  assert.equal(deadSeat.attention, false);

  const hostedWaiting = classifySeatStatus({
    transport: "hosted_mcp",
    turnOnly: true,
    connection: "live",
    presence: presenceRow({ last_command_at: ago(10 * 60_000), turn_at: ago(10 * 60_000) }),
    waitingSince: ago(5 * 60_000),
    unseenCount: 3,
    utcClock: true,
  }, NOW);
  assert.equal(hostedWaiting.kind, "waiting");
  assert.equal(hostedWaiting.line, "Waiting since 16:40 UTC · 3 unseen");
  assert.equal(hostedWaiting.stale_waiting, true);
  assert.equal(hostedWaiting.indicator, "diamond");
  assert.equal(hostedWaiting.attention, false, "turn-only seats wait until opened rather than flagging broken push");
});

test("C2 private titles are redacted fail-closed across cross-audience surfaces", () => {
  assert.equal(sanitizeSeatWorkText({ text: "SECRET-PRIVATE-CHANNEL", scope: "private_channel" }), null);
  assert.equal(sanitizeSeatWorkText({ text: "SECRET-PRIVATE-CHANNEL", scope: "private_channel" }, true), "SECRET-PRIVATE-CHANNEL");
  assert.equal(sanitizeSeatWorkText({ text: "SECRET-DM", scope: "direct" }, true), null);
  assert.equal(sanitizeSeatWorkText({ text: "UNSCOPED-WORK" }), null);
  assert.equal(sanitizeSeatWorkText({ text: "\u001b[31mPublic\twork\nitem\u001b[0m", scope: "public_channel" }), "Public work item");
  assert.equal(sanitizeSeatWorkText({ text: "Workspace broadcast", scope: "workspace" }), "Workspace broadcast");

  const privateWorking = classifySeatStatus({
    transport: "local",
    connection: "live",
    lastActivityAt: ago(2 * 60_000),
    workingOn: { since: ago(3 * 60_000), text: "SECRET-LOCK-WORK", scope: "private_channel" },
  }, NOW);
  assert.equal(privateWorking.kind, "working");
  assert.equal(privateWorking.line, "Working · 3 min ago");
  assert.equal(privateWorking.indicator, "ring");
  assert.equal(privateWorking.work_text, null);
  assert.equal(privateWorking.line.includes("SECRET-LOCK-WORK"), false);

  // Stale work (> 30 min) never stays "Working".
  const staleWork = classifySeatStatus({
    transport: "local",
    connection: "live",
    presence: presenceRow({ last_command_at: ago(SEAT_WORK_RECENT_MS + 60_000) }),
    workingOn: { since: ago(SEAT_WORK_RECENT_MS + 60_000), text: "old work", scope: "workspace" },
  }, NOW);
  assert.equal(staleWork.kind, "not_listening");
  assert.equal(staleWork.work_text, null);
  assert.equal(staleWork.indicator, "ring");
});

test("C2 formatting helpers handle boundary durations and multi-day clock dates", () => {
  assert.equal(formatSeatElapsed(10_000), "just now");
  assert.equal(formatSeatElapsed(3 * 60_000), "3 min");
  assert.equal(formatSeatElapsed(2 * 3_600_000), "2 h");
  assert.equal(formatSeatElapsed(3 * 86_400_000), "3 d");

  assert.equal(formatSeatAgo(10_000), "just now");
  assert.equal(formatSeatAgo(5 * 60_000), "5 min ago");
  assert.equal(formatSeatAgo(2 * 3_600_000), "2 h ago");
  assert.equal(formatSeatAgo(4 * 86_400_000), "4 d ago");

  assert.equal(formatSeatClock("2026-11-20T16:42:00Z", NOW, { utcClock: true }), "16:42 UTC");
  assert.equal(formatSeatClock("2026-11-19T16:42:00Z", NOW, { utcClock: true }), "Yesterday 16:42 UTC");
  assert.equal(formatSeatClock("2026-11-15T16:42:00Z", NOW, { utcClock: true }), "Nov 15, 16:42 UTC");
  assert.equal(formatSeatClock("not-a-date", NOW), "recently");
});

test("C2 one shared classifier serves CLI and MCP (mapRoster) with identical verdicts", () => {
  const entry: RosterEntry = {
    principal_id: "11111111-1111-4111-8111-111111111111",
    name: "Reviewer",
    transport: "local",
    turn_only: false,
    owner: { user_id: "22222222-2222-4222-8222-222222222222", display_name: "Alice" },
    status: "not_picking_up",
    connection: "live",
    last_activity_at: ago(5 * 60_000),
    open_work: null,
    messages_waiting: { count: 2, since: "2026-11-20T16:42:00Z" },
    wake: { watcher_at: ago(30_000), channel_at: null, listener_at: null, turn_at: null },
    waiting_on_people: { count: 0, since: null },
    platform: null,
    job: null,
    reports_to: null,
    parent: null,
    source: "commonswarm",
  };
  const roster: AgentRoster = {
    workspace_id: "33333333-3333-4333-8333-333333333333",
    generated_at: new Date(NOW).toISOString(),
    lead_agent_principal_id: null,
    truncated: false,
    agents: [entry],
  };

  const cliSeat = classifyRosterSeatStatus(entry, NOW, { timeZone: "America/Chicago" });
  const mcpResult = mapRoster(roster) as { agents: Array<RosterEntry & { seat_status: ReturnType<typeof classifyRosterSeatStatus> }> };
  const edgeSeat = classifyRosterSeatStatus(entry, NOW, { utcClock: true });

  assert.equal(cliSeat.kind, "waiting");
  assert.equal(cliSeat.line, "Waiting since 10:42 · 2 unseen");
  assert.equal(edgeSeat.line, "Waiting since 16:42 UTC · 2 unseen");
  assert.equal(mcpResult.agents[0]!.seat_status.kind, cliSeat.kind);
  assert.equal(mcpResult.agents[0]!.seat_status.unseen_count, 2);
  assert.equal(mcpResult.agents[0]!.seat_status.indicator, "diamond");
});
