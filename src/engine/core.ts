import { randomUUID } from "node:crypto";
import type { IdGenerator, IncomingMessage, ReplyCommand, ReplyStatus, ReplyTarget } from "./ports.js";

export type { IncomingMessage, ReplyCommand, ReplyStatus, ReplyTarget };

export const MAX_MESSAGE_TEXT_BYTES = 64 * 1024;
export const RESTART_INTERRUPTED_REPLY = "The engine restarted while working on this message.";
export const TURN_FAILED_REPLY = "The agent could not complete this message.";
export const MESSAGE_TOO_LONG_REPLY = "This message is too long for the agent.";

export type TurnOutcome = "replied" | "failed" | "interrupted";
export type OwedReplyOrigin = TurnOutcome | "refused";

export type JournalRecord =
  | { readonly type: "message_accepted"; readonly messageId: string; readonly text: string; readonly leaseId: string; readonly replyTarget: ReplyTarget; readonly at: number }
  | { readonly type: "message_released"; readonly messageId: string; readonly at: number }
  | { readonly type: "message_refused"; readonly messageId: string; readonly command: ReplyCommand; readonly at: number }
  | { readonly type: "turn_started"; readonly messageId: string; readonly replyTarget: ReplyTarget; readonly at: number }
  | { readonly type: "turn_finished"; readonly messageId: string; readonly outcome: TurnOutcome; readonly command: ReplyCommand; readonly at: number }
  | { readonly type: "reply_posted"; readonly messageId: string; readonly at: number }
  | { readonly type: "reply_abandoned"; readonly messageId: string; readonly commandId: string; readonly at: number }
  | { readonly type: "message_seen"; readonly messageId: string; readonly leaseId: string; readonly at: number }
  | { readonly type: "message_settled"; readonly messageId: string; readonly at: number };

export type Effect =
  | { readonly type: "start_turn"; readonly messageId: string; readonly text: string; readonly leaseId: string }
  | { readonly type: "post_reply"; readonly messageId: string; readonly command: ReplyCommand }
  | { readonly type: "mark_seen"; readonly messageId: string; readonly leaseId: string }
  | { readonly type: "report_unknown_outcome"; readonly messageId: string; readonly commandId: string; readonly owedAt: number; readonly at: number };

export interface AcceptedMessage {
  readonly messageId: string;
  readonly text: string;
  readonly leaseId: string;
  readonly replyTarget: ReplyTarget;
  readonly acceptedAt: number;
}
export interface ActiveTurn {
  readonly messageId: string;
  readonly text: string;
  readonly leaseId: string;
  readonly replyTarget: ReplyTarget;
  readonly startedAt: number;
}
export interface OwedReply {
  readonly messageId: string;
  readonly command: ReplyCommand;
  readonly owedAt: number;
  readonly origin: OwedReplyOrigin;
}
export interface CoreLimits { readonly settledIdCap: number; }
export interface RecoverOptions extends CoreLimits {
  readonly replyRetryHorizonMs: number;
  readonly generateId?: IdGenerator;
}
export interface EngineState {
  readonly settledIdCap: number;
  readonly settled: ReadonlyMap<string, number>;
  readonly seenIds: ReadonlySet<string>;
  readonly pending: AcceptedMessage | null;
  readonly active: ActiveTurn | null;
  readonly owedReplies: readonly OwedReply[];
}
export interface Decision {
  readonly records: readonly JournalRecord[];
  readonly effects: readonly Effect[];
}
export interface RecoveryResult extends Decision { readonly state: EngineState; }

const EMPTY_DECISION: Decision = { records: [], effects: [] };

export function buildReplyCommand(
  commandId: string,
  replyTarget: ReplyTarget,
  status: ReplyStatus,
  body: string,
): ReplyCommand {
  return replyTarget.kind === "private"
    ? { commandId, replyTarget, status, body }
    : { commandId, replyTarget, body };
}

export function initialState(limits: CoreLimits): EngineState {
  if (!Number.isInteger(limits.settledIdCap) || limits.settledIdCap < 1) {
    throw new RangeError("Settled id cap must be a positive integer");
  }
  return {
    settledIdCap: limits.settledIdCap,
    settled: new Map<string, number>(),
    seenIds: new Set<string>(),
    pending: null,
    active: null,
    owedReplies: [],
  };
}

export function canClaim(state: EngineState): boolean {
  return state.active === null && state.pending === null;
}

export function isKnownMessage(state: EngineState, messageId: string): boolean {
  return (
    state.settled.has(messageId) ||
    state.active?.messageId === messageId ||
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
      if (isKnownMessage(state, record.messageId) || !canClaim(state)) return state;
      return {
        ...state,
        pending: {
          messageId: record.messageId,
          text: record.text,
          leaseId: record.leaseId,
          replyTarget: record.replyTarget,
          acceptedAt: record.at,
        },
      };
    }
    case "message_released":
      return state.pending?.messageId === record.messageId ? { ...state, pending: null } : state;
    case "message_refused": {
      if (isKnownMessage(state, record.messageId) || state.pending?.messageId === record.messageId) return state;
      return {
        ...state,
        owedReplies: [...state.owedReplies, { messageId: record.messageId, command: record.command, owedAt: record.at, origin: "refused" }],
      };
    }
    case "turn_started": {
      const pending = state.pending?.messageId === record.messageId ? state.pending : null;
      return {
        ...state,
        pending: pending !== null ? null : state.pending,
        active: {
          messageId: record.messageId,
          text: pending ? pending.text : "",
          leaseId: pending ? pending.leaseId : "",
          replyTarget: record.replyTarget,
          startedAt: record.at,
        },
      };
    }
    case "turn_finished": {
      const active = state.active?.messageId === record.messageId ? null : state.active;
      if (state.owedReplies.some((r) => r.messageId === record.messageId) || state.settled.has(record.messageId)) {
        return { ...state, active };
      }
      return {
        ...state,
        active,
        owedReplies: [...state.owedReplies, { messageId: record.messageId, command: record.command, owedAt: record.at, origin: record.outcome }],
      };
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
      if (state.settled.has(record.messageId) || state.seenIds.has(record.messageId)) return state;
      const seenIds = new Set(state.seenIds);
      seenIds.add(record.messageId);
      return { ...state, seenIds };
    }
    case "message_settled": {
      if (isKnownMessage(state, record.messageId) || state.pending?.messageId === record.messageId) return state;
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
        ? { type: "message_refused", messageId: owed.messageId, command: owed.command, at: owed.owedAt }
        : { type: "turn_finished", messageId: owed.messageId, outcome: owed.origin, command: owed.command, at: owed.owedAt },
    );
  }
  if (state.active !== null) {
    records.push({ type: "turn_started", messageId: state.active.messageId, replyTarget: state.active.replyTarget, at: state.active.startedAt });
  }
  if (state.pending !== null) {
    records.push({
      type: "message_accepted",
      messageId: state.pending.messageId,
      text: state.pending.text,
      leaseId: state.pending.leaseId,
      replyTarget: state.pending.replyTarget,
      at: state.pending.acceptedAt,
    });
  }
  return records;
}

export function acceptMessage(
  state: EngineState,
  message: IncomingMessage,
  at: number,
  generateId: IdGenerator = randomUUID,
): Decision {
  if (isKnownMessage(state, message.id)) {
    return { records: [], effects: [{ type: "mark_seen", messageId: message.id, leaseId: message.leaseId }] };
  }
  if (!canClaim(state)) return EMPTY_DECISION;
  if (Buffer.byteLength(message.text, "utf8") > MAX_MESSAGE_TEXT_BYTES) {
    const command = buildReplyCommand(generateId(), message.replyTarget, "failed", MESSAGE_TOO_LONG_REPLY);
    return {
      records: [{ type: "message_refused", messageId: message.id, command, at }],
      effects: [
        { type: "mark_seen", messageId: message.id, leaseId: message.leaseId },
        { type: "post_reply", messageId: message.id, command },
      ],
    };
  }
  return {
    records: [{ type: "message_accepted", messageId: message.id, text: message.text, leaseId: message.leaseId, replyTarget: message.replyTarget, at }],
    effects: [],
  };
}

export function decideNext(state: EngineState, at: number): Decision {
  if (state.active !== null || state.pending === null) return EMPTY_DECISION;
  const next = state.pending;
  return {
    records: [{ type: "turn_started", messageId: next.messageId, replyTarget: next.replyTarget, at }],
    effects: [
      { type: "start_turn", messageId: next.messageId, text: next.text, leaseId: next.leaseId },
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
  const command = buildReplyCommand(generateId(), state.active.replyTarget, "answered", replyText);
  return {
    records: [{ type: "turn_finished", messageId, outcome: "replied", command, at }],
    effects: [{ type: "post_reply", messageId, command }],
  };
}

export function finishTurnWithFailure(
  state: EngineState,
  messageId: string,
  at: number,
  generateId: IdGenerator = randomUUID,
): Decision {
  if (state.active?.messageId !== messageId) return EMPTY_DECISION;
  const command = buildReplyCommand(generateId(), state.active.replyTarget, "failed", TURN_FAILED_REPLY);
  return {
    records: [{ type: "turn_finished", messageId, outcome: "failed", command, at }],
    effects: [{ type: "post_reply", messageId, command }],
  };
}

export function retryOwedReply(state: EngineState, messageId: string, at: number, replyRetryHorizonMs: number): Decision {
  const owed = state.owedReplies.find((r) => r.messageId === messageId);
  if (!owed) return EMPTY_DECISION;
  if (at - owed.owedAt > replyRetryHorizonMs) {
    return {
      records: [{ type: "reply_abandoned", messageId: owed.messageId, commandId: owed.command.commandId, at }],
      effects: [{ type: "report_unknown_outcome", messageId: owed.messageId, commandId: owed.command.commandId, owedAt: owed.owedAt, at }],
    };
  }
  return { records: [], effects: [{ type: "post_reply", messageId: owed.messageId, command: owed.command }] };
}

export function confirmReplyPosted(state: EngineState, messageId: string, at: number): Decision {
  if (!state.owedReplies.some((r) => r.messageId === messageId)) return EMPTY_DECISION;
  return { records: [{ type: "reply_posted", messageId, at }], effects: [] };
}

export function confirmMessageSeen(state: EngineState, messageId: string, leaseId: string, at: number): Decision {
  if (state.seenIds.has(messageId)) return EMPTY_DECISION;
  return { records: [{ type: "message_seen", messageId, leaseId, at }], effects: [] };
}

export function recover(records: readonly JournalRecord[], at: number, options: RecoverOptions): RecoveryResult {
  if (!Number.isFinite(options.replyRetryHorizonMs) || options.replyRetryHorizonMs < 0) {
    throw new RangeError("Reply retry horizon must be a non-negative finite number");
  }
  const generateId = options.generateId ?? randomUUID;
  let state = reduceAll(records, options);
  const appended: JournalRecord[] = [];
  if (state.pending !== null) {
    const released: JournalRecord = { type: "message_released", messageId: state.pending.messageId, at };
    appended.push(released);
    state = reduce(state, released);
  }
  if (state.active !== null) {
    const command = buildReplyCommand(generateId(), state.active.replyTarget, "failed", RESTART_INTERRUPTED_REPLY);
    const interrupted: JournalRecord = { type: "turn_finished", messageId: state.active.messageId, outcome: "interrupted", command, at };
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

function isReplyTarget(value: unknown): value is ReplyTarget {
  if (typeof value !== "object" || value === null) return false;
  const target = value as Record<string, unknown>;
  if (target.kind === "private") return isNonEmptyString(target.inReplyTo);
  if (target.kind === "thread") return isNonEmptyString(target.threadRootId);
  return false;
}

function isReplyCommand(value: unknown): value is ReplyCommand {
  if (typeof value !== "object" || value === null) return false;
  const cmd = value as Record<string, unknown>;
  if (!isNonEmptyString(cmd.commandId) || !isReplyTarget(cmd.replyTarget) || typeof cmd.body !== "string") return false;
  return cmd.replyTarget.kind === "private"
    ? cmd.status === "answered" || cmd.status === "failed"
    : cmd.status === undefined && !("status" in cmd);
}

export function isJournalRecord(value: unknown): value is JournalRecord {
  if (typeof value !== "object" || value === null) return false;
  const rec = value as Record<string, unknown>;
  if (typeof rec.type !== "string" || !isNonEmptyString(rec.messageId)) return false;
  if (typeof rec.at !== "number" || !Number.isFinite(rec.at)) return false;
  switch (rec.type) {
    case "message_accepted":
      return typeof rec.text === "string" && isNonEmptyString(rec.leaseId) && isReplyTarget(rec.replyTarget);
    case "message_released":
    case "reply_posted":
    case "message_settled":
      return true;
    case "message_refused":
      return isReplyCommand(rec.command);
    case "turn_started":
      return isReplyTarget(rec.replyTarget);
    case "turn_finished":
      return (rec.outcome === "replied" || rec.outcome === "failed" || rec.outcome === "interrupted") && isReplyCommand(rec.command);
    case "reply_abandoned":
      return isNonEmptyString(rec.commandId);
    case "message_seen":
      return isNonEmptyString(rec.leaseId);
    default:
      return false;
  }
}
