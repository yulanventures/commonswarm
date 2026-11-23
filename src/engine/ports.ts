import type { ReplyStatus } from "./core.js";

export interface IncomingMessage {
  readonly id: string;
  readonly text: string;
}

export interface HarnessPort {
  runTurn(text: string): Promise<string>;
  interrupt(): Promise<void> | void;
}

export interface CloudPort {
  // Long-polls until work arrives and resolves empty only on abort;
  // the runner loops immediately without waiting between claims.
  claim(limit: number, signal?: AbortSignal): Promise<readonly IncomingMessage[]>;
  markSeen(messageId: string): Promise<void>;
  postReply(
    messageId: string,
    commandId: string,
    text: string,
    status: ReplyStatus,
  ): Promise<void>;
}

export interface Clock {
  now(): number;
}

export type IdGenerator = () => string;

export type OperatorReportKind =
  | "unknown_reply_outcome"
  | "turn_failed"
  | "runner_stopped";

export interface OperatorPort {
  report(
    kind: OperatorReportKind,
    detail: Readonly<Record<string, unknown>>,
  ): void | Promise<void>;
}
