/** Pure transition core for durable hosted MCP `check` batches. */

export const HOSTED_CHECK_BATCH_LIMIT = 50;

export interface HostedCheckCursor {
  created_at: string;
  signal_id: string;
}

export interface HostedCheckCandidate extends HostedCheckCursor {}

export interface HostedCheckBatch {
  batch_id: string;
  seat_id: string;
  context_id: string;
  grant_id: string;
  workspace_id: string;
  signal_ids: readonly string[];
  terminal_cursor: HostedCheckCursor;
  acknowledged: boolean;
  cancelled?: boolean;
}

export type HostedCheckCommand =
  | {
      kind: 'open_hosted_mcp_check_batch';
      seat_id: string;
      context_id: string;
      grant_id: string;
      workspace_id: string;
    }
  | {
      kind: 'ack_hosted_mcp_check_batch';
      seat_id: string;
      context_id: string;
      grant_id: string;
      workspace_id: string;
      batch_id: string;
    };

export interface HostedCheckFacts {
  context_id: string;
  credential_kind: 'human' | 'hosted_grant' | 'hosted_seat';
  seat_id: string;
  grant_id: string;
  workspace_id: string;
  committed_cursor: HostedCheckCursor | null;
  active_batch: HostedCheckBatch | null;
  requested_batch: HostedCheckBatch | null;
  candidates: readonly HostedCheckCandidate[];
  next_batch_id: string;
}

export type HostedCheckDecision =
  | {
      ok: false;
      reason: 'credential_kind_forbidden' | 'hosted_check_batch_forbidden';
    }
  | {
      ok: true;
      acknowledge_batch_id: string | null;
      advance_cursor: HostedCheckCursor | null;
      create_batch: HostedCheckBatch | null;
      return_batch: HostedCheckBatch | null;
    };

/** Canonical wire/storage timestamp: ISO-8601 after truncating, never rounding. */
export function hostedCheckMillisecondTimestamp(value: string | number | Date): string {
  const milliseconds = value instanceof Date ? value.getTime() :
    typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error('invalid hosted check timestamp');
  return new Date(Math.trunc(milliseconds)).toISOString();
}

export function compareHostedCheckCursor(
  left: HostedCheckCursor,
  right: HostedCheckCursor,
): number {
  const time = Date.parse(hostedCheckMillisecondTimestamp(left.created_at)) -
    Date.parse(hostedCheckMillisecondTimestamp(right.created_at));
  return time === 0 ? left.signal_id.localeCompare(right.signal_id) : Math.sign(time);
}

function sameAuthority(
  value: Pick<HostedCheckBatch, 'seat_id' | 'context_id' | 'workspace_id'>,
  facts: Pick<HostedCheckFacts, 'seat_id' | 'context_id' | 'workspace_id'>,
): boolean {
  return value.seat_id === facts.seat_id && value.context_id === facts.context_id &&
    value.workspace_id === facts.workspace_id;
}

function canonicalBatchId(value: string): string {
  return value.toLowerCase();
}

function normalizedCandidates(
  candidates: readonly HostedCheckCandidate[],
  cursor: HostedCheckCursor | null,
): HostedCheckCandidate[] {
  const byId = new Map<string, HostedCheckCandidate>();
  for (const candidate of candidates) {
    const normalized = {
      created_at: hostedCheckMillisecondTimestamp(candidate.created_at),
      signal_id: candidate.signal_id,
    };
    if (cursor === null || compareHostedCheckCursor(normalized, cursor) > 0) {
      byId.set(normalized.signal_id, normalized);
    }
  }
  return [...byId.values()]
    .sort(compareHostedCheckCursor)
    .slice(0, HOSTED_CHECK_BATCH_LIMIT);
}

/**
 * Decide an ACK/open transition from transaction-locked facts. The adapter is
 * deliberately mechanical: it persists only the action returned here.
 */
export function decideHostedCheck(
  command: HostedCheckCommand,
  facts: HostedCheckFacts,
): HostedCheckDecision {
  if (facts.credential_kind !== 'hosted_seat') {
    return { ok: false, reason: 'credential_kind_forbidden' };
  }
  if (command.seat_id !== facts.seat_id || command.grant_id !== facts.grant_id ||
      command.workspace_id !== facts.workspace_id || command.context_id !== facts.context_id) {
    return { ok: false, reason: 'hosted_check_batch_forbidden' };
  }
  if (facts.active_batch !== null && (!sameAuthority(facts.active_batch, facts) || facts.active_batch.cancelled)) {
    return { ok: false, reason: 'hosted_check_batch_forbidden' };
  }

  let active = facts.active_batch;
  let acknowledgeBatchId: string | null = null;
  let advanceCursor: HostedCheckCursor | null = null;

  if (command.kind === 'ack_hosted_mcp_check_batch') {
    const requested = facts.requested_batch;
    const commandBatchId = canonicalBatchId(command.batch_id);
    if (requested === null || canonicalBatchId(requested.batch_id) !== commandBatchId ||
        (!sameAuthority(requested, facts) || requested.cancelled)) {
      return { ok: false, reason: 'hosted_check_batch_forbidden' };
    }
    if (!requested.acknowledged) {
      if (active === null || canonicalBatchId(active.batch_id) !== commandBatchId) {
        return { ok: false, reason: 'hosted_check_batch_forbidden' };
      }
      acknowledgeBatchId = canonicalBatchId(requested.batch_id);
      const terminal = {
        created_at: hostedCheckMillisecondTimestamp(requested.terminal_cursor.created_at),
        signal_id: requested.terminal_cursor.signal_id,
      };
      advanceCursor = facts.committed_cursor === null || compareHostedCheckCursor(terminal, facts.committed_cursor) > 0 ? terminal : null;
      active = null;
    }
    // A repeated ACK is intentionally a no-op. If a newer active batch exists,
    // it is returned below but can never be acknowledged by the older id.
  }

  if (active !== null) {
    return {
      ok: true,
      acknowledge_batch_id: acknowledgeBatchId,
      advance_cursor: advanceCursor,
      create_batch: null,
      return_batch: active,
    };
  }

  const cursor = advanceCursor ?? facts.committed_cursor;
  const candidates = normalizedCandidates(facts.candidates, cursor);
  if (candidates.length === 0) {
    return {
      ok: true,
      acknowledge_batch_id: acknowledgeBatchId,
      advance_cursor: advanceCursor,
      create_batch: null,
      return_batch: null,
    };
  }
  const terminal = candidates[candidates.length - 1]!;
  const batch: HostedCheckBatch = {
    batch_id: facts.next_batch_id,
    seat_id: facts.seat_id,
    context_id: facts.context_id,
    grant_id: facts.grant_id,
    workspace_id: facts.workspace_id,
    signal_ids: candidates.map((candidate) => candidate.signal_id),
    terminal_cursor: terminal,
    acknowledged: false,
  };
  return {
    ok: true,
    acknowledge_batch_id: acknowledgeBatchId,
    advance_cursor: advanceCursor,
    create_batch: batch,
    return_batch: batch,
  };
}
