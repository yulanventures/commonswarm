export type ReplyTarget =
  | { readonly kind: "private"; readonly inReplyTo: string }
  | { readonly kind: "thread"; readonly threadRootId: string };

export type ReplyStatus = "answered" | "failed";

export interface ReplyCommand {
  readonly commandId: string;
  readonly replyTarget: ReplyTarget;
  readonly status?: ReplyStatus;
  readonly body: string;
}

export interface IncomingMessage {
  readonly id: string;
  readonly text: string;
  readonly leaseId: string;
  readonly replyTarget: ReplyTarget;
}

export class AuthorityLostError extends Error {
  constructor(message = "Session authority lost") {
    super(message);
    this.name = "AuthorityLostError";
  }
}

export interface HarnessPort {
  runTurn(text: string): Promise<string>;
  interrupt(): Promise<void> | void;
  close?(): Promise<void> | void;
}

export interface CloudPort {
  // Owns waiting between claims and wakes on new work; resolves with one
  // message or null when aborted.
  claim(signal?: AbortSignal): Promise<IncomingMessage | null>;
  markSeen(messageId: string, leaseId: string): Promise<void>;
  postReply(command: ReplyCommand): Promise<void>;
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
