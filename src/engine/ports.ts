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
  claim(limit: number, signal?: AbortSignal): Promise<readonly IncomingMessage[]>;
  markSeen(messageId: string): Promise<void>;
  postReply(messageId: string, text: string, status: ReplyStatus): Promise<void>;
}

export interface Clock {
  now(): number;
}
