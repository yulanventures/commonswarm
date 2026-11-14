/*
 * The line under a message that has replies: who replied, how many, and when the last one came.
 * Pure, so the dashboard only draws what these return.
 */

/** How many repliers' marks the line shows. */
export const THREAD_FACES_MAX = 3;

/** The first reply of each distinct author, in the order they first replied, up to `max`. */
export const threadRepliers = <Reply extends { from: string }>(
  replies: readonly Reply[],
  max: number = THREAD_FACES_MAX,
): Reply[] => {
  const seen = new Set<string>();
  const first: Reply[] = [];
  for (const reply of replies) {
    if (seen.has(reply.from)) continue;
    seen.add(reply.from);
    first.push(reply);
    if (first.length === max) break;
  }
  return first;
};

/** When the newest reply was sent, whatever order the replies are in. `null` when no time is readable. */
export const threadLastReplyAt = (replies: readonly { createdAt: string }[]): string | null => {
  let newest: string | null = null, newestAt = Number.NEGATIVE_INFINITY;
  for (const reply of replies) {
    const at = Date.parse(reply.createdAt);
    if (Number.isFinite(at) && at > newestAt) { newest = reply.createdAt; newestAt = at; }
  }
  return newest;
};

/**
 * "6:52 AM" for today, "Nov 12" for another day this year, "Nov 12, 2025" otherwise. A fixed time,
 * not "4m ago": it never needs redrawing, so the line never changes width while it is read.
 */
export const threadLastReplyTime = (iso: string, now: Date = new Date(), locale?: string): string => {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const sameDay = at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate();
  if (sameDay) return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(at);
  return new Intl.DateTimeFormat(locale, at.getFullYear() === now.getFullYear()
    ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" }).format(at);
};

export const THREAD_LAST_REPLY_PREFIX = "Last reply";
