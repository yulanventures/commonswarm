import assert from "node:assert/strict";
import test from "node:test";
import {
  compareHostedCheckCursor,
  decideHostedCheck,
  HOSTED_CHECK_BATCH_LIMIT,
  hostedCheckMillisecondTimestamp,
  type HostedCheckBatch,
  type HostedCheckFacts,
} from "../src/protocol/hosted-check.js";

const seat = "10000000-0000-4000-8000-000000000001";
const grant = "20000000-0000-4000-8000-000000000001";
const workspace = "30000000-0000-4000-8000-000000000001";
const batchId = "40000000-0000-4000-8000-000000000001";
const signalA = "50000000-0000-4000-8000-000000000001";
const signalB = "50000000-0000-4000-8000-000000000002";

const active: HostedCheckBatch = {
  batch_id: batchId, seat_id: seat, context_id: "60000000-0000-4000-8000-000000000001", grant_id: grant, workspace_id: workspace,
  signal_ids: [signalA, signalB],
  terminal_cursor: { created_at: "2026-09-27T12:00:00.123Z", signal_id: signalB },
  acknowledged: false,
};

function facts(overrides: Partial<HostedCheckFacts> = {}): HostedCheckFacts {
  return {
    credential_kind: "hosted_seat", seat_id: seat, context_id: "60000000-0000-4000-8000-000000000001", grant_id: grant, workspace_id: workspace,
    committed_cursor: null, active_batch: null, requested_batch: null, candidates: [],
    next_batch_id: batchId, ...overrides,
  };
}

test("hosted check orders and stores the exact millisecond cursor", () => {
  assert.equal(hostedCheckMillisecondTimestamp("2026-09-27T12:00:00.123999Z"), "2026-09-27T12:00:00.123Z");
  assert.ok(compareHostedCheckCursor(
    { created_at: "2026-09-27T12:00:00.123999Z", signal_id: signalB },
    { created_at: "2026-09-27T12:00:00.123001Z", signal_id: signalA },
  ) > 0, "positive control: UUID breaks a same-millisecond tie");
  const opened = decideHostedCheck({
    kind: "open_hosted_mcp_check_batch", seat_id: seat, context_id: "60000000-0000-4000-8000-000000000001", grant_id: grant, workspace_id: workspace,
  }, facts({ candidates: [
    { created_at: "2026-09-27T12:00:00.123999Z", signal_id: signalB },
    { created_at: "2026-09-27T12:00:00.123001Z", signal_id: signalA },
  ] }));
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  assert.deepEqual(opened.create_batch?.signal_ids, [signalA, signalB]);
  assert.deepEqual(opened.create_batch?.terminal_cursor, {
    created_at: "2026-09-27T12:00:00.123Z", signal_id: signalB,
  });
});

test("open replays one active batch and never persists an empty batch", () => {
  const replay = decideHostedCheck({
    kind: "open_hosted_mcp_check_batch", seat_id: seat, context_id: "60000000-0000-4000-8000-000000000001", grant_id: grant, workspace_id: workspace,
  }, facts({ active_batch: active }));
  assert.equal(replay.ok, true);
  if (replay.ok) {
    assert.equal(replay.create_batch, null);
    assert.equal(replay.return_batch, active);
  }
  const empty = decideHostedCheck({
    kind: "open_hosted_mcp_check_batch", seat_id: seat, context_id: "60000000-0000-4000-8000-000000000001", grant_id: grant, workspace_id: workspace,
  }, facts());
  assert.equal(empty.ok, true);
  if (empty.ok) assert.equal(empty.create_batch, null);
});

test("matching ACK advances exactly to the returned terminal and can open next", () => {
  const next = "50000000-0000-4000-8000-000000000003";
  const acked = decideHostedCheck({
    kind: "ack_hosted_mcp_check_batch", seat_id: seat, context_id: "60000000-0000-4000-8000-000000000001", grant_id: grant,
    workspace_id: workspace, batch_id: batchId,
  }, facts({ active_batch: active, requested_batch: active, candidates: [
    { created_at: active.terminal_cursor.created_at, signal_id: signalA },
    { created_at: "2026-09-27T12:00:00.124999Z", signal_id: next },
  ], next_batch_id: "40000000-0000-4000-8000-000000000002" }));
  assert.equal(acked.ok, true);
  if (!acked.ok) return;
  assert.equal(acked.acknowledge_batch_id, batchId);
  assert.deepEqual(acked.advance_cursor, active.terminal_cursor);
  assert.deepEqual(acked.create_batch?.signal_ids, [next]);
});

test("repeated ACK cannot acknowledge a newer active batch", () => {
  const old = { ...active, acknowledged: true };
  const newer = { ...active, batch_id: "40000000-0000-4000-8000-000000000002",
    signal_ids: ["50000000-0000-4000-8000-000000000003"] };
  const repeated = decideHostedCheck({
    kind: "ack_hosted_mcp_check_batch", seat_id: seat, context_id: "60000000-0000-4000-8000-000000000001", grant_id: grant,
    workspace_id: workspace, batch_id: batchId,
  }, facts({ active_batch: newer, requested_batch: old }));
  assert.equal(repeated.ok, true);
  if (!repeated.ok) return;
  assert.equal(repeated.acknowledge_batch_id, null);
  assert.equal(repeated.return_batch?.batch_id, newer.batch_id);
});

test("ACK batch identity uses canonical UUID text", () => {
  const upperBatchId = batchId.toUpperCase();
  const acknowledged = decideHostedCheck({
    kind: "ack_hosted_mcp_check_batch", seat_id: seat, context_id: "60000000-0000-4000-8000-000000000001", grant_id: grant,
    workspace_id: workspace, batch_id: upperBatchId,
  }, facts({ active_batch: active, requested_batch: active }));
  assert.equal(acknowledged.ok, true,
    "positive control: an upper-case spelling of the same UUID is accepted");
  if (!acknowledged.ok) return;
  assert.equal(acknowledged.acknowledge_batch_id, batchId,
    "the persistence action uses canonical lower-case UUID text");
});

test("wrong credential, seat, grant, workspace, or batch is refused", () => {
  const command = { kind: "ack_hosted_mcp_check_batch" as const, seat_id: seat, context_id: "60000000-0000-4000-8000-000000000001", grant_id: grant,
    workspace_id: workspace, batch_id: batchId };
  for (const changed of [
    facts({ credential_kind: "human", active_batch: active, requested_batch: active }),
    facts({ seat_id: "10000000-0000-4000-8000-000000000099", active_batch: active, requested_batch: active }),
    facts({ grant_id: "20000000-0000-4000-8000-000000000099", active_batch: active, requested_batch: active }),
    facts({ workspace_id: "30000000-0000-4000-8000-000000000099", active_batch: active, requested_batch: active }),
    facts({ active_batch: active, requested_batch: null }),
  ]) assert.equal(decideHostedCheck(command, changed).ok, false);
  assert.equal(decideHostedCheck(command, facts({ active_batch: active, requested_batch: active })).ok, true,
    "positive control: exact authority tuple and batch are accepted");
});

test("batch size is bounded and cursor never advances on open", () => {
  const candidates = Array.from({ length: HOSTED_CHECK_BATCH_LIMIT + 5 }, (_, index) => ({
    created_at: new Date(Date.UTC(2026, 8, 27, 12, 0, 0, index)).toISOString(),
    signal_id: `50000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  }));
  const decision = decideHostedCheck({
    kind: "open_hosted_mcp_check_batch", seat_id: seat, context_id: "60000000-0000-4000-8000-000000000001", grant_id: grant, workspace_id: workspace,
  }, facts({ candidates }));
  assert.equal(decision.ok, true);
  if (!decision.ok) return;
  assert.equal(decision.create_batch?.signal_ids.length, HOSTED_CHECK_BATCH_LIMIT);
  assert.equal(decision.advance_cursor, null);
});

test('contexts share a monotonic inbox cursor but cannot ACK each other or cancelled batches', () => {
  const context = '60000000-0000-4000-8000-000000000001';
  const command = { kind:'ack_hosted_mcp_check_batch' as const,seat_id:seat,context_id:context,grant_id:grant,workspace_id:workspace,batch_id:batchId };
  const shared = facts({active_batch:active,requested_batch:active,committed_cursor:{created_at:'2026-09-27T12:00:01.000Z',signal_id:signalB}});
  const accepted = decideHostedCheck(command,shared);
  assert.equal(accepted.ok,true);
  if(accepted.ok){assert.equal(accepted.acknowledge_batch_id,batchId);assert.equal(accepted.advance_cursor,null,'an overlapping older batch cannot move the shared cursor backwards');}
  assert.equal(decideHostedCheck(command,{...shared,context_id:'60000000-0000-4000-8000-000000000002'}).ok,false);
  assert.equal(decideHostedCheck(command,{...shared,requested_batch:{...active,cancelled:true}}).ok,false);
  const successor=decideHostedCheck({...command,grant_id:'20000000-0000-4000-8000-000000000002'},{...shared,grant_id:'20000000-0000-4000-8000-000000000002'});
  assert.equal(successor.ok,true,'historical batch grant stays immutable; the current seat binding supplies authorization');
});
