export const REPLY_STATUSES = ["answered", "failed", "declined"] as const;

export type ReplyStatus = typeof REPLY_STATUSES[number];

export function isReplyStatus(value: unknown): value is ReplyStatus {
  return typeof value === "string" &&
    (REPLY_STATUSES as readonly string[]).includes(value);
}
