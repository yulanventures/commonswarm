export const DEFAULT_QUEUE_CAP = 200;

export const RESTART_INTERRUPTED_REPLY =
  "The engine restarted while working on this message.";

export type TurnOutcome = "replied" | "failed" | "interrupted";
export type ReplyStatus = "replied" | "failed";

export type JournalRecord =
  | { readonly type: "message_accepted"; readonly messageId: string; readonly text: string; readonly at: number }
  | { readonly type: "turn_started"; readonly messageId: string; readonly at: number }
  | { readonly type: "turn_finished"; readonly messageId: string; readonly outcome: "replied"; readonly replyText: string; readonly at: number }
  | { readonly type: "turn_finished"; readonly messageId: string; readonly outcome: "failed" | "interrupted"; readonly error: string; readonly at: number }
  | { readonly type: "reply_posted"; readonly messageId: string; readonly at: number }
  | { readonly type: "message_seen"; readonly messageId: string; readonly at: number };

export type Effect =
  | { readonly type: "start_turn"; readonly messageId: string; readonly text: string }
  | { readonly type: "post_reply"; readonly messageId: string; readonly text: string; readonly status: ReplyStatus }
  | { readonly type: "mark_seen"; readonly messageId: string };

export interface QueuedMessage {
  readonly messageId: string;
  readonly text: string;
}

export interface ActiveTurn {
  readonly messageId: string;
  readonly text: string;
  readonly startedAt: number;
}

export interface OwedReply {
  readonly messageId: string;
  readonly text: string;
  readonly status: ReplyStatus;
}

export interface EngineState {
  readonly queueCap: number;
  readonly acceptedIds: ReadonlySet<string>;
  readonly seenIds: ReadonlySet<string>;
  readonly queue: readonly QueuedMessage[];
  readonly active: ActiveTurn | null;
  readonly owedReplies: readonly OwedReply[];
}

export interface Decision {
  readonly records: readonly JournalRecord[];
  readonly effects: readonly Effect[];
}

export interface RecoveryResult {
  readonly state: EngineState;
  readonly records: readonly JournalRecord[];
  readonly effects: readonly Effect[];
}

const EMPTY_DECISION: Decision = { records: [], effects: [] };

export function initialState(queueCap = DEFAULT_QUEUE_CAP): EngineState {
  if (!Number.isInteger(queueCap) || queueCap < 1) {
    throw new RangeError("Queue cap must be a positive integer");
  }
  return {
    queueCap,
    acceptedIds: new Set<string>(),
    seenIds: new Set<string>(),
    queue: [],
    active: null,
    owedReplies: [],
  };
}

export function inFlightCount(state: EngineState): number {
  return state.queue.length + (state.active === null ? 0 : 1);
}

export function availableCapacity(state: EngineState): number {
  return Math.max(0, state.queueCap - inFlightCount(state));
}

export function canAccept(state: EngineState): boolean {
  return inFlightCount(state) < state.queueCap;
}

export function reduce(state: EngineState, record: JournalRecord): EngineState {
  switch (record.type) {
    case "message_accepted": {
      if (state.acceptedIds.has(record.messageId)) return state;
      const acceptedIds = new Set(state.acceptedIds);
      acceptedIds.add(record.messageId);
      return {
        ...state,
        acceptedIds,
        queue: [...state.queue, { messageId: record.messageId, text: record.text }],
      };
    }
    case "turn_started": {
      const queued = state.queue.find((item) => item.messageId === record.messageId);
      return {
        ...state,
        queue: state.queue.filter((item) => item.messageId !== record.messageId),
        active: {
          messageId: record.messageId,
          text: queued ? queued.text : "",
          startedAt: record.at,
        },
      };
    }
    case "turn_finished": {
      const status: ReplyStatus = record.outcome === "replied" ? "replied" : "failed";
      const text = record.outcome === "replied" ? record.replyText : record.error;
      const alreadyOwed = state.owedReplies.some((r) => r.messageId === record.messageId);
      return {
        ...state,
        active: state.active?.messageId === record.messageId ? null : state.active,
        owedReplies: alreadyOwed
          ? state.owedReplies
          : [...state.owedReplies, { messageId: record.messageId, text, status }],
      };
    }
    case "reply_posted": {
      if (!state.owedReplies.some((r) => r.messageId === record.messageId)) return state;
      return {
        ...state,
        owedReplies: state.owedReplies.filter((r) => r.messageId !== record.messageId),
      };
    }
    case "message_seen": {
      if (state.seenIds.has(record.messageId)) return state;
      const seenIds = new Set(state.seenIds);
      seenIds.add(record.messageId);
      return { ...state, seenIds };
    }
  }
}

export function reduceAll(
  records: readonly JournalRecord[],
  queueCap = DEFAULT_QUEUE_CAP,
): EngineState {
  let state = initialState(queueCap);
  for (const record of records) {
    state = reduce(state, record);
  }
  return state;
}

export function acceptMessage(
  state: EngineState,
  message: { readonly id: string; readonly text: string },
  at: number,
): Decision {
  if (state.acceptedIds.has(message.id) || !canAccept(state)) return EMPTY_DECISION;
  return {
    records: [{ type: "message_accepted", messageId: message.id, text: message.text, at }],
    effects: [],
  };
}

export function decideNext(state: EngineState, at: number): Decision {
  if (state.active !== null || state.queue.length === 0) return EMPTY_DECISION;
  const next = state.queue[0];
  return {
    records: [{ type: "turn_started", messageId: next.messageId, at }],
    effects: [
      { type: "mark_seen", messageId: next.messageId },
      { type: "start_turn", messageId: next.messageId, text: next.text },
    ],
  };
}

export function finishTurnWithReply(
  state: EngineState,
  messageId: string,
  replyText: string,
  at: number,
): Decision {
  if (state.active?.messageId !== messageId) return EMPTY_DECISION;
  return {
    records: [{ type: "turn_finished", messageId, outcome: "replied", replyText, at }],
    effects: [{ type: "post_reply", messageId, text: replyText, status: "replied" }],
  };
}

export function finishTurnWithFailure(
  state: EngineState,
  messageId: string,
  error: string,
  at: number,
): Decision {
  if (state.active?.messageId !== messageId) return EMPTY_DECISION;
  const text = error.trim().length > 0 ? error : "Turn failed.";
  return {
    records: [{ type: "turn_finished", messageId, outcome: "failed", error: text, at }],
    effects: [{ type: "post_reply", messageId, text, status: "failed" }],
  };
}

export function confirmReplyPosted(
  state: EngineState,
  messageId: string,
  at: number,
): Decision {
  if (!state.owedReplies.some((r) => r.messageId === messageId)) return EMPTY_DECISION;
  return {
    records: [{ type: "reply_posted", messageId, at }],
    effects: [],
  };
}

export function confirmMessageSeen(
  state: EngineState,
  messageId: string,
  at: number,
): Decision {
  if (state.seenIds.has(messageId)) return EMPTY_DECISION;
  return {
    records: [{ type: "message_seen", messageId, at }],
    effects: [],
  };
}

export function recover(
  records: readonly JournalRecord[],
  at: number,
  queueCap = DEFAULT_QUEUE_CAP,
): RecoveryResult {
  let state = reduceAll(records, queueCap);
  const appended: JournalRecord[] = [];
  if (state.active !== null) {
    const interrupted: JournalRecord = {
      type: "turn_finished",
      messageId: state.active.messageId,
      outcome: "interrupted",
      error: RESTART_INTERRUPTED_REPLY,
      at,
    };
    appended.push(interrupted);
    state = reduce(state, interrupted);
  }
  const effects: Effect[] = state.owedReplies.map((owed) => ({
    type: "post_reply",
    messageId: owed.messageId,
    text: owed.text,
    status: owed.status,
  }));
  return { state, records: appended, effects };
}

export function isJournalRecord(value: unknown): value is JournalRecord {
  if (typeof value !== "object" || value === null) return false;
  const rec = value as Record<string, unknown>;
  if (typeof rec.type !== "string") return false;
  if (typeof rec.messageId !== "string" || rec.messageId.length === 0) return false;
  if (typeof rec.at !== "number" || !Number.isFinite(rec.at)) return false;
  switch (rec.type) {
    case "message_accepted":
      return typeof rec.text === "string";
    case "turn_started":
    case "reply_posted":
    case "message_seen":
      return true;
    case "turn_finished":
      if (rec.outcome === "replied") return typeof rec.replyText === "string";
      if (rec.outcome === "failed" || rec.outcome === "interrupted") {
        return typeof rec.error === "string";
      }
      return false;
    default:
      return false;
  }
}
