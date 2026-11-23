import { randomUUID } from "node:crypto";
import type { IdGenerator } from "./ports.js";

export const DEFAULT_QUEUE_CAP = 200;
export const MAX_MESSAGE_TEXT_BYTES = 64 * 1024;
export const RESTART_INTERRUPTED_REPLY = "The engine restarted while working on this message.";
export const TURN_FAILED_REPLY = "The agent could not complete this message.";
export const MESSAGE_TOO_LONG_REPLY = "This message is too long for the agent.";

export type TurnOutcome = "replied" | "failed" | "interrupted";
export type ReplyStatus = "replied" | "failed";
export type OwedReplyOrigin = TurnOutcome | "refused";

export type JournalRecord =
  | { readonly type: "message_accepted"; readonly messageId: string; readonly text: string; readonly at: number }
  | { readonly type: "message_refused"; readonly messageId: string; readonly commandId: string; readonly at: number }
  | { readonly type: "turn_started"; readonly messageId: string; readonly at: number }
  | { readonly type: "turn_finished"; readonly messageId: string; readonly commandId: string; readonly outcome: TurnOutcome; readonly replyText: string; readonly at: number }
  | { readonly type: "reply_posted"; readonly messageId: string; readonly at: number }
  | { readonly type: "reply_abandoned"; readonly messageId: string; readonly commandId: string; readonly at: number }
  | { readonly type: "message_seen"; readonly messageId: string; readonly at: number }
  | { readonly type: "message_settled"; readonly messageId: string; readonly at: number };

export type Effect =
  | { readonly type: "start_turn"; readonly messageId: string; readonly text: string }
  | { readonly type: "post_reply"; readonly messageId: string; readonly commandId: string; readonly text: string; readonly status: ReplyStatus }
  | { readonly type: "mark_seen"; readonly messageId: string }
  | { readonly type: "report_unknown_outcome"; readonly messageId: string; readonly commandId: string; readonly owedAt: number; readonly at: number };

export interface QueuedMessage { readonly messageId: string; readonly text: string; readonly acceptedAt: number; }
export interface ActiveTurn { readonly messageId: string; readonly text: string; readonly startedAt: number; }
export interface OwedReply {
  readonly messageId: string;
  readonly commandId: string;
  readonly text: string;
  readonly status: ReplyStatus;
  readonly owedAt: number;
  readonly origin: OwedReplyOrigin;
}
export interface CoreLimits { readonly settledIdCap: number; readonly queueCap?: number; }
export interface RecoverOptions extends CoreLimits {
  readonly replyRetryHorizonMs: number;
  readonly generateId?: IdGenerator;
}

export interface EngineState {
  readonly queueCap: number;
  readonly settledIdCap: number;
  readonly settled: ReadonlyMap<string, number>;
  readonly seenIds: ReadonlySet<string>;
  readonly queue: readonly QueuedMessage[];
  readonly active: ActiveTurn | null;
  readonly owedReplies: readonly OwedReply[];
}

export interface Decision {
  readonly records: readonly JournalRecord[];
  readonly effects: readonly Effect[];
}

export interface RecoveryResult extends Decision {
  readonly state: EngineState;
}

const EMPTY_DECISION: Decision = { records: [], effects: [] };

export function initialState(limits: CoreLimits): EngineState {
  const queueCap = limits.queueCap ?? DEFAULT_QUEUE_CAP;
  if (!Number.isInteger(queueCap) || queueCap < 1) {
    throw new RangeError("Queue cap must be a positive integer");
  }
  if (!Number.isInteger(limits.settledIdCap) || limits.settledIdCap < 1) {
    throw new RangeError("Settled id cap must be a positive integer");
  }
  return {
    queueCap,
    settledIdCap: limits.settledIdCap,
    settled: new Map<string, number>(),
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

function isKnownMessage(state: EngineState, messageId: string): boolean {
  return (
    state.settled.has(messageId) ||
    state.active?.messageId === messageId ||
    state.queue.some((item) => item.messageId === messageId) ||
    state.owedReplies.some((item) => item.messageId === messageId)
  );
}

function addSettled(
  settled: ReadonlyMap<string, number>,
  messageId: string,
  at: number,
  cap: number,
): ReadonlyMap<string, number> {
  if (settled.has(messageId)) return settled;
  const next = new Map(settled);
  next.set(messageId, at);
  while (next.size > cap) {
    const oldest = next.keys().next().value;
    if (oldest === undefined) break;
    next.delete(oldest);
  }
  return next;
}

export function reduce(state: EngineState, record: JournalRecord): EngineState {
  switch (record.type) {
    case "message_accepted": {
      if (isKnownMessage(state, record.messageId)) return state;
      return {
        ...state,
        queue: [...state.queue, { messageId: record.messageId, text: record.text, acceptedAt: record.at }],
      };
    }
    case "message_refused": {
      if (isKnownMessage(state, record.messageId)) return state;
      const owed: OwedReply = {
        messageId: record.messageId,
        commandId: record.commandId,
        text: MESSAGE_TOO_LONG_REPLY,
        status: "failed",
        owedAt: record.at,
        origin: "refused",
      };
      return { ...state, owedReplies: [...state.owedReplies, owed] };
    }
    case "turn_started": {
      const queued = state.queue.find((item) => item.messageId === record.messageId);
      return {
        ...state,
        queue: state.queue.filter((item) => item.messageId !== record.messageId),
        active: { messageId: record.messageId, text: queued ? queued.text : "", startedAt: record.at },
      };
    }
    case "turn_finished": {
      const active = state.active?.messageId === record.messageId ? null : state.active;
      if (state.owedReplies.some((r) => r.messageId === record.messageId) || state.settled.has(record.messageId)) {
        return { ...state, active };
      }
      const owed: OwedReply = {
        messageId: record.messageId,
        commandId: record.commandId,
        text: record.replyText,
        status: record.outcome === "replied" ? "replied" : "failed",
        owedAt: record.at,
        origin: record.outcome,
      };
      return { ...state, active, owedReplies: [...state.owedReplies, owed] };
    }
    case "reply_posted":
    case "reply_abandoned": {
      if (!state.owedReplies.some((r) => r.messageId === record.messageId)) return state;
      const seenIds = state.seenIds.has(record.messageId)
        ? new Set([...state.seenIds].filter((id) => id !== record.messageId))
        : state.seenIds;
      return {
        ...state,
        seenIds,
        owedReplies: state.owedReplies.filter((r) => r.messageId !== record.messageId),
        settled: addSettled(state.settled, record.messageId, record.at, state.settledIdCap),
      };
    }
    case "message_seen": {
      if (state.seenIds.has(record.messageId)) return state;
      const seenIds = new Set(state.seenIds);
      seenIds.add(record.messageId);
      return { ...state, seenIds };
    }
    case "message_settled": {
      if (isKnownMessage(state, record.messageId)) return state;
      return { ...state, settled: addSettled(state.settled, record.messageId, record.at, state.settledIdCap) };
    }
  }
}

export function reduceAll(records: readonly JournalRecord[], limits: CoreLimits): EngineState {
  let state = initialState(limits);
  for (const record of records) state = reduce(state, record);
  return state;
}

export function compacted(state: EngineState): readonly JournalRecord[] {
  const records: JournalRecord[] = [];
  for (const [messageId, at] of state.settled) {
    records.push({ type: "message_settled", messageId, at });
  }
  for (const owed of state.owedReplies) {
    records.push(
      owed.origin === "refused"
        ? { type: "message_refused", messageId: owed.messageId, commandId: owed.commandId, at: owed.owedAt }
        : { type: "turn_finished", messageId: owed.messageId, commandId: owed.commandId, outcome: owed.origin, replyText: owed.text, at: owed.owedAt },
    );
  }
  if (state.active !== null) {
    records.push({ type: "turn_started", messageId: state.active.messageId, at: state.active.startedAt });
    if (state.seenIds.has(state.active.messageId)) {
      records.push({ type: "message_seen", messageId: state.active.messageId, at: state.active.startedAt });
    }
  }
  for (const item of state.queue) {
    records.push({ type: "message_accepted", messageId: item.messageId, text: item.text, at: item.acceptedAt });
  }
  return records;
}

export function acceptMessage(
  state: EngineState,
  message: { readonly id: string; readonly text: string },
  at: number,
  generateId: IdGenerator = randomUUID,
): Decision {
  if (isKnownMessage(state, message.id) || !canAccept(state)) return EMPTY_DECISION;
  if (Buffer.byteLength(message.text, "utf8") > MAX_MESSAGE_TEXT_BYTES) {
    const commandId = generateId();
    return {
      records: [{ type: "message_refused", messageId: message.id, commandId, at }],
      effects: [{ type: "post_reply", messageId: message.id, commandId, text: MESSAGE_TOO_LONG_REPLY, status: "failed" }],
    };
  }
  return { records: [{ type: "message_accepted", messageId: message.id, text: message.text, at }], effects: [] };
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
  generateId: IdGenerator = randomUUID,
): Decision {
  if (state.active?.messageId !== messageId) return EMPTY_DECISION;
  const commandId = generateId();
  return {
    records: [{ type: "turn_finished", messageId, commandId, outcome: "replied", replyText, at }],
    effects: [{ type: "post_reply", messageId, commandId, text: replyText, status: "replied" }],
  };
}

export function finishTurnWithFailure(
  state: EngineState,
  messageId: string,
  at: number,
  generateId: IdGenerator = randomUUID,
): Decision {
  if (state.active?.messageId !== messageId) return EMPTY_DECISION;
  const commandId = generateId();
  return {
    records: [{ type: "turn_finished", messageId, commandId, outcome: "failed", replyText: TURN_FAILED_REPLY, at }],
    effects: [{ type: "post_reply", messageId, commandId, text: TURN_FAILED_REPLY, status: "failed" }],
  };
}

export function retryOwedReply(
  state: EngineState,
  messageId: string,
  at: number,
  replyRetryHorizonMs: number,
): Decision {
  const owed = state.owedReplies.find((r) => r.messageId === messageId);
  if (!owed) return EMPTY_DECISION;
  if (at - owed.owedAt > replyRetryHorizonMs) {
    return {
      records: [{ type: "reply_abandoned", messageId: owed.messageId, commandId: owed.commandId, at }],
      effects: [{ type: "report_unknown_outcome", messageId: owed.messageId, commandId: owed.commandId, owedAt: owed.owedAt, at }],
    };
  }
  return {
    records: [],
    effects: [{ type: "post_reply", messageId: owed.messageId, commandId: owed.commandId, text: owed.text, status: owed.status }],
  };
}

export function confirmReplyPosted(state: EngineState, messageId: string, at: number): Decision {
  if (!state.owedReplies.some((r) => r.messageId === messageId)) return EMPTY_DECISION;
  return { records: [{ type: "reply_posted", messageId, at }], effects: [] };
}

export function confirmMessageSeen(state: EngineState, messageId: string, at: number): Decision {
  if (state.seenIds.has(messageId)) return EMPTY_DECISION;
  return { records: [{ type: "message_seen", messageId, at }], effects: [] };
}

export function recover(
  records: readonly JournalRecord[],
  at: number,
  options: RecoverOptions,
): RecoveryResult {
  if (!Number.isFinite(options.replyRetryHorizonMs) || options.replyRetryHorizonMs < 0) {
    throw new RangeError("Reply retry horizon must be a non-negative finite number");
  }
  const generateId = options.generateId ?? randomUUID;
  let state = reduceAll(records, options);
  const appended: JournalRecord[] = [];
  if (state.active !== null) {
    const interrupted: JournalRecord = {
      type: "turn_finished",
      messageId: state.active.messageId,
      commandId: generateId(),
      outcome: "interrupted",
      replyText: RESTART_INTERRUPTED_REPLY,
      at,
    };
    appended.push(interrupted);
    state = reduce(state, interrupted);
  }
  const effects: Effect[] = [];
  for (const owed of [...state.owedReplies]) {
    const decision = retryOwedReply(state, owed.messageId, at, options.replyRetryHorizonMs);
    for (const record of decision.records) {
      appended.push(record);
      state = reduce(state, record);
    }
    effects.push(...decision.effects);
  }
  return { state, records: appended, effects };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function isJournalRecord(value: unknown): value is JournalRecord {
  if (typeof value !== "object" || value === null) return false;
  const rec = value as Record<string, unknown>;
  if (typeof rec.type !== "string" || !isNonEmptyString(rec.messageId)) return false;
  if (typeof rec.at !== "number" || !Number.isFinite(rec.at)) return false;
  switch (rec.type) {
    case "message_accepted":
      return typeof rec.text === "string";
    case "message_refused":
    case "reply_abandoned":
      return isNonEmptyString(rec.commandId);
    case "turn_started":
    case "reply_posted":
    case "message_seen":
    case "message_settled":
      return true;
    case "turn_finished":
      return (
        isNonEmptyString(rec.commandId) &&
        (rec.outcome === "replied" || rec.outcome === "failed" || rec.outcome === "interrupted") &&
        typeof rec.replyText === "string"
      );
    default:
      return false;
  }
}
