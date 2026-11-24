// Copied from src/protocol/seat-status.ts at commit 1cbfcccfde5e68a6db19272ee504d66a25a66fc9 (relative imports updated to ./agent-presence.js).

import {
  classifyAgentPresence,
  type AgentPresenceRow,
  type AgentPresenceWakeKind,
} from "./agent-presence.js";
import { WAKE_STALE_MS } from "./agent-presence.js";
import { WAKE_LEASE_STALE_MS } from "./agent-presence.js";

/** Latest server-recorded activity must be within this window for a work claim or Doing to-do to read as active work. */
export const SEAT_WORK_RECENT_MS = 30 * 60_000;
/** Unobserved directed mail older than this threshold counts as stale waiting. */
export const SEAT_WAITING_STALE_MS = WAKE_STALE_MS;
/** Push-listener heartbeat older than this threshold reads as stale (not listening). */
export const SEAT_WAKE_LEASE_STALE_MS = WAKE_LEASE_STALE_MS;

export type SeatConnectionKind =
  | "live"
  | "removed"
  | "connection_off"
  | "key_off"
  | "key_ended"
  | "paused";

export type SeatStatusKind =
  | "removed"
  | "connection_off"
  | "key_off"
  | "key_ended"
  | "paused"
  | "waiting"
  | "working"
  | "turn_only"
  | "listening"
  | "not_listening"
  | "unknown";

/** Visual indicator shape — never fake a live dot.
 *  - "dot" ONLY when a live push listener lease is verified (<= WAKE_LEASE_STALE_MS).
 *  - "diamond" for disconnected/attention faults or known unseen waiting messages.
 *  - "ring" for turn-only, unverified working, not listening, unknown-count brief waiting, or unavailable status. */
export type SeatIndicator = "dot" | "ring" | "diamond";

export type SeatWorkScope =
  | "workspace"
  | "public_channel"
  | "private_channel"
  | "direct"
  | "unknown";

export interface SeatWakeInput {
  watcher_at?: string | null;
  channel_at?: string | null;
  listener_at?: string | null;
  turn_at?: string | null;
}

export interface SeatWorkInput {
  since?: string | null;
  at?: string | null;
  createdAt?: string | null;
  until?: string | null;
  text?: string | null;
  scope?: SeatWorkScope;
}

export interface SeatDoingInput {
  title?: string | null;
  since?: string | null;
  startedAt?: string | null;
}

export interface SeatClockOptions {
  locale?: string;
  timeZone?: string;
  /** Set true when rendering on a server/edge without a viewer timezone so clock times include "UTC". */
  utcClock?: boolean;
}

export interface SeatStatusInput extends SeatClockOptions {
  transport?: "local" | "hosted_mcp" | string;
  turnOnly?: boolean;
  connection?: SeatConnectionKind | string;
  revoked?: boolean;
  suspended?: boolean;
  /** Full presence row when available (browser/CLI). Undefined means presence was not loaded. */
  presence?: AgentPresenceRow | null;
  /** Lightweight wake timestamps from workspace_roster / home_overview when full presence row is absent. */
  wake?: SeatWakeInput | null;
  /** Latest server-recorded activity timestamp across commands, signals, checks, todos, objects. */
  lastActivityAt?: string | null;
  /** Active working-on signal (if any). */
  workingOn?: SeatWorkInput | null;
  /** Active Doing to-do (if any). */
  doingTodo?: SeatDoingInput | null;
  /** Server-derived work class when provided (e.g., home_overview). */
  serverWork?: "working" | "idle" | "disconnected";
  /** Oldest unacked visible directed message waiting for this seat. */
  waitingSince?: string | null;
  /** Count of unacked visible directed messages waiting for this seat. */
  unseenCount?: number | null;
  /** True when the status read failed and live seat status is unavailable. */
  statusUnavailable?: boolean;
  /** Only set true when rendering inside the exact private audience authorized to see private work titles. */
  viewerInPrivateAudience?: boolean;
}

export interface SeatStatus {
  kind: SeatStatusKind;
  /** Single concise status line ("Working · 3 min", "Working · 3 min ago", "Waiting since 10:42 · 2 unseen", "Turn-only, checks when opened · 5 min ago", "Listening · verified just now", "Not listening · last active 2 h ago", "Status unavailable"). */
  line: string;
  /** Visual shape: "dot" ONLY when a live push listener lease is verified, "diamond" for faults/waiting, "ring" otherwise. */
  indicator: SeatIndicator;
  /** True when the seat needs owner/manager attention (broken connection or stale unpicked-up mail on a push seat). */
  attention: boolean;
  /** True when waiting messages have crossed the stale threshold (WAKE_STALE_MS). */
  stale_waiting: boolean;
  /** Verified wake route classification ("live watcher" | "stale listener" | "turn" | "none", etc.). */
  wake_kind: AgentPresenceWakeKind;
  /** Primary reference timestamp for this status (work start, waiting since, or last activity). */
  since: string | null;
  /** Elapsed ms since `since` (or `last_activity_at`), clamped >= 0, null when unknown. */
  age_ms: number | null;
  /** Latest known activity timestamp across all server facts. */
  last_activity_at: string | null;
  /** Elapsed ms since `last_activity_at`, null when never active. */
  last_activity_age_ms: number | null;
  /** Unseen waiting message count (0 when none or unknown). */
  unseen_count: number;
  /** Audience-safe work summary text (ALWAYS null for private_channel/direct/unknown unless viewerInPrivateAudience). */
  work_text: string | null;
}

export interface RosterSeatInput {
  transport: string;
  turn_only: boolean;
  connection: string;
  last_activity_at: string | null;
  open_work: { since: string; text: string | null } | null;
  messages_waiting?: { count: number; since: string | null } | null;
  wake?: SeatWakeInput | null;
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Elapsed age without "ago", used for active duration ("Working · 3 min"). */
export function formatSeatElapsed(ageMs: number): string {
  const clamped = Math.max(0, ageMs);
  const minutes = Math.floor(clamped / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}

/** Relative age with "ago", used for last-seen/last-active timestamps ("5 min ago", "2 h ago"). */
export function formatSeatAgo(ageMs: number): string {
  const clamped = Math.max(0, ageMs);
  const minutes = Math.floor(clamped / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

function calendarDayKey(date: Date, timeZone: string | undefined): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    ...(timeZone ? { timeZone } : {}),
  }).formatToParts(date);
  let year = date.getFullYear();
  let month = date.getMonth() + 1;
  let day = date.getDate();
  for (const part of parts) {
    if (part.type === "year") year = Number(part.value);
    else if (part.type === "month") month = Number(part.value);
    else if (part.type === "day") day = Number(part.value);
  }
  return { year, month, day };
}

/** Short 24-hour clock for "Waiting since 10:42" (with day prefix when not today, and "UTC" when utcClock is set). */
export function formatSeatClock(iso: string, now: number, options: SeatClockOptions = {}): string {
  const ms = parseTimestamp(iso);
  if (ms === null || !Number.isFinite(now)) return "recently";
  const date = new Date(ms);
  const clock = new Date(now);
  const locale = options.locale ?? "en-US";
  const timeZone = options.utcClock ? "UTC" : options.timeZone;
  const suffix = options.utcClock ? " UTC" : "";
  const timeParts = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    ...(timeZone ? { timeZone } : {}),
  }).formatToParts(date);
  const hour = timeParts.find((p) => p.type === "hour")?.value ?? "00";
  const minute = timeParts.find((p) => p.type === "minute")?.value ?? "00";
  const hhmm = `${hour === "24" ? "00" : hour}:${minute}`;

  const dDay = calendarDayKey(date, timeZone);
  const cDay = calendarDayKey(clock, timeZone);
  const dayDiff = Math.round(
    (Date.UTC(cDay.year, cDay.month - 1, cDay.day) - Date.UTC(dDay.year, dDay.month - 1, dDay.day)) / 86_400_000,
  );
  if (dayDiff === 0) return `${hhmm}${suffix}`;
  if (dayDiff === 1) return `Yesterday ${hhmm}${suffix}`;
  const datePrefix = new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    ...(dDay.year !== cDay.year ? { year: "numeric" } : {}),
    ...(timeZone ? { timeZone } : {}),
  }).format(date);
  return `${datePrefix}, ${hhmm}${suffix}`;
}

/** Fail-closed work title sanitizer: private-channel, direct, and unscoped titles stay null unless viewerInPrivateAudience is true. */
export function sanitizeSeatWorkText(
  work: SeatWorkInput | null | undefined,
  viewerInPrivateAudience = false,
): string | null {
  if (!work || typeof work.text !== "string") return null;
  const scope = work.scope ?? "unknown";
  const allowed =
    scope === "workspace"
    || scope === "public_channel"
    || (scope === "private_channel" && viewerInPrivateAudience === true);
  if (!allowed) return null;
  const cleaned = work.text
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  return cleaned.length > 0 ? cleaned : null;
}

function presenceRowFromWake(wake: SeatWakeInput | null | undefined): AgentPresenceRow | null {
  if (!wake) return null;
  return {
    last_command_at: null,
    client_build: null,
    watcher_at: wake.watcher_at ?? null,
    channel_at: wake.channel_at ?? null,
    listener_at: wake.listener_at ?? null,
    turn_at: wake.turn_at ?? null,
    last_ack_via: null,
    last_ack_at: null,
    current_client_build: null,
  };
}

function pushLeaseTimestamp(
  presence: AgentPresenceRow | null | undefined,
  wake: SeatWakeInput | null | undefined,
  now: number,
): string | null {
  const source = presence ?? wake;
  if (!source) return null;
  const candidates = [source.watcher_at, source.channel_at, source.listener_at]
    .map((value) => ({ iso: value ?? null, ms: parseTimestamp(value) }))
    .filter((entry): entry is { iso: string; ms: number } => entry.iso !== null && entry.ms !== null && entry.ms <= now)
    .sort((left, right) => right.ms - left.ms);
  return candidates[0]?.iso ?? null;
}

/**
 * Single shared seat-status classifier for web (People & agents, DM header), CLI (`cswarm roster`),
 * stdio MCP (`roster`), and hosted MCP (`roster`).
 *
 * Truth rules:
 * - Always show the age (or clock time) of every status value when a timestamp exists.
 * - Never fake a live dot: `indicator === "dot"` ONLY when a live push listener lease is verified.
 * - Private titles stay out of other audiences: `work_text` is fail-closed unless workspace/public-channel scoped.
 */
export function classifySeatStatus(input: SeatStatusInput, now = Date.now()): SeatStatus {
  const hosted = input.transport === "hosted_mcp";
  const isTurnOnly = hosted || input.turnOnly === true;

  const presenceProvided = input.presence !== undefined || input.wake !== undefined;
  const effectivePresence: AgentPresenceRow | null = input.presence !== undefined
    ? input.presence
    : presenceRowFromWake(input.wake);

  const classifiedPresence = presenceProvided ? classifyAgentPresence(effectivePresence, now) : null;
  const wakeKind: AgentPresenceWakeKind = hosted
    ? "turn"
    : classifiedPresence
      ? classifiedPresence.wake.kind
      : isTurnOnly
        ? "turn"
        : "none";
  const hasLiveListener = !hosted && wakeKind.startsWith("live ");
  const isTurnSeat = isTurnOnly || (!hasLiveListener && wakeKind === "turn");

  const workingSinceIso = input.workingOn?.since ?? input.workingOn?.at ?? input.workingOn?.createdAt ?? null;
  const workingUntilMs = parseTimestamp(input.workingOn?.until);
  const workingActive = Boolean(
    input.workingOn
    && (input.workingOn.until === undefined || input.workingOn.until === null || (workingUntilMs !== null && workingUntilMs > now)),
  );
  const doingSinceIso = input.doingTodo?.since ?? input.doingTodo?.startedAt ?? null;

  const activityCandidates = [
    input.lastActivityAt,
    input.presence?.last_command_at,
    workingActive ? workingSinceIso : null,
    doingSinceIso,
  ]
    .map((iso) => ({ iso: iso ?? null, ms: parseTimestamp(iso) }))
    .filter((entry): entry is { iso: string; ms: number } => entry.iso !== null && entry.ms !== null && entry.ms <= now)
    .sort((left, right) => right.ms - left.ms);

  const lastActivityIso = activityCandidates[0]?.iso ?? null;
  const lastActivityMs = activityCandidates[0]?.ms ?? null;
  const lastActivityAgeMs = lastActivityMs !== null ? Math.max(0, now - lastActivityMs) : null;

  const workText = workingActive ? sanitizeSeatWorkText(input.workingOn, input.viewerInPrivateAudience === true) : null;

  const waitingSinceMs = parseTimestamp(input.waitingSince);
  const effectiveUnseenCount =
    typeof input.unseenCount === "number" && Number.isSafeInteger(input.unseenCount) && input.unseenCount >= 0
      ? input.unseenCount
      : null;
  const hasKnownUnseenCount = effectiveUnseenCount !== null && effectiveUnseenCount > 0;
  const hasWaitingRow = waitingSinceMs !== null && waitingSinceMs <= now && (effectiveUnseenCount === null || effectiveUnseenCount > 0);
  const waitingAgeMs = hasWaitingRow ? Math.max(0, now - waitingSinceMs) : null;
  const staleWaiting = waitingAgeMs !== null && waitingAgeMs >= SEAT_WAITING_STALE_MS;
  const reportedUnseenCount = hasKnownUnseenCount ? effectiveUnseenCount : hasWaitingRow ? 1 : 0;

  const build = (
    kind: SeatStatusKind,
    line: string,
    indicator: SeatIndicator,
    attention: boolean,
    since: string | null,
    ageMs: number | null,
  ): SeatStatus => ({
    kind,
    line,
    indicator,
    attention,
    stale_waiting: staleWaiting,
    wake_kind: wakeKind,
    since,
    age_ms: ageMs,
    last_activity_at: lastActivityIso,
    last_activity_age_ms: lastActivityAgeMs,
    unseen_count: reportedUnseenCount,
    work_text: kind === "working" ? workText : null,
  });

  // 1. Disconnected / credential / access failure always outranks activity.
  if (input.revoked || input.connection === "removed") {
    return build("removed", "Removed", "diamond", true, lastActivityIso, lastActivityAgeMs);
  }
  if (input.connection === "connection_off") {
    return build("connection_off", "Connection turned off", "diamond", true, lastActivityIso, lastActivityAgeMs);
  }
  if (input.connection === "key_off") {
    return build("key_off", "Key turned off", "diamond", true, lastActivityIso, lastActivityAgeMs);
  }
  if (input.connection === "paused" || input.suspended) {
    return build("paused", input.suspended && input.connection !== "paused" ? "Needs reconnecting" : "Access suspended", "diamond", true, lastActivityIso, lastActivityAgeMs);
  }
  if (input.connection === "key_ended") {
    return build("key_ended", "Key ended", "diamond", true, lastActivityIso, lastActivityAgeMs);
  }
  if (input.serverWork === "disconnected") {
    return build("connection_off", "Needs reconnecting", "diamond", true, lastActivityIso, lastActivityAgeMs);
  }

  // Explicit status read failure.
  if (input.statusUnavailable === true) {
    return build("unknown", "Status unavailable", "ring", false, lastActivityIso, lastActivityAgeMs);
  }

  // Determine whether the seat is currently doing active work.
  const recentActivity = lastActivityAgeMs !== null && lastActivityAgeMs <= SEAT_WORK_RECENT_MS;
  const hasWorkClaim = Boolean(input.doingTodo || workingActive);
  const isWorking = input.serverWork === "working" || (input.serverWork !== "idle" && hasWorkClaim && recentActivity);

  // 2. Waiting messages (right after access faults):
  //    - Whenever the unseen count is known (> 0), surface "Waiting since … · N unseen" with a diamond immediately.
  //    - Otherwise (legacy timestamp without count), surface if stale (>= WAKE_STALE_MS) or if idle without a live listener.
  const showWaiting = hasKnownUnseenCount || (hasWaitingRow && (staleWaiting || (!isWorking && !hasLiveListener)));
  if (showWaiting) {
    if (hasWaitingRow && input.waitingSince && waitingAgeMs !== null) {
      const clock = formatSeatClock(input.waitingSince, now, input);
      const unseenSuffix = hasKnownUnseenCount ? ` · ${effectiveUnseenCount} unseen` : "";
      const line = `Waiting since ${clock}${unseenSuffix}`;
      return build(
        "waiting",
        line,
        staleWaiting || hasKnownUnseenCount ? "diamond" : "ring",
        staleWaiting && !isTurnSeat,
        input.waitingSince,
        waitingAgeMs,
      );
    }
    if (hasKnownUnseenCount) {
      return build(
        "waiting",
        `Waiting · ${effectiveUnseenCount} unseen`,
        "diamond",
        false,
        null,
        null,
      );
    }
  }

  // 3. Verified recent work:
  //    - Filled dot + "Working · 3 min" ONLY when a live listener lease is verified.
  //    - Hollow ring + "Working · 3 min ago" otherwise (e.g., turn-only or unverified push seat).
  if (isWorking) {
    const doingMs = parseTimestamp(doingSinceIso);
    const workMs = workingActive ? parseTimestamp(workingSinceIso) : null;
    const refIso = doingMs !== null && doingMs <= now
      ? doingSinceIso!
      : workMs !== null && workMs <= now
        ? workingSinceIso!
        : lastActivityIso;
    const refMs = parseTimestamp(refIso);
    const workAgeMs = refMs !== null && refMs <= now ? Math.max(0, now - refMs) : lastActivityAgeMs;
    const line = workAgeMs !== null
      ? hasLiveListener
        ? `Working · ${formatSeatElapsed(workAgeMs)}`
        : `Working · ${formatSeatAgo(workAgeMs)}`
      : "Working";
    return build("working", line, hasLiveListener ? "dot" : "ring", false, refIso, workAgeMs);
  }

  // 4. Failed / unloaded status read: neither presence nor wake was supplied -> "Status unavailable".
  if (!presenceProvided) {
    return build("unknown", "Status unavailable", "ring", false, lastActivityIso, lastActivityAgeMs);
  }

  // 5. Turn-only seats (hosted MCP or turn-only local seat) — never fake a live dot!
  if (isTurnSeat) {
    const line = lastActivityAgeMs !== null
      ? `Turn-only, checks when opened · ${formatSeatAgo(lastActivityAgeMs)}`
      : "Turn-only, checks when opened";
    return build("turn_only", line, "ring", false, lastActivityIso, lastActivityAgeMs);
  }

  // 6. Verified live push listener lease (<= WAKE_LEASE_STALE_MS) — uses the lease timestamp ("Listening · verified …").
  if (hasLiveListener) {
    const leaseIso = pushLeaseTimestamp(input.presence, input.wake, now);
    const leaseMs = parseTimestamp(leaseIso);
    const leaseAgeMs = leaseMs !== null && leaseMs <= now ? Math.max(0, now - leaseMs) : classifiedPresence?.wake.age_ms ?? null;
    const line = leaseAgeMs !== null ? `Listening · verified ${formatSeatAgo(leaseAgeMs)}` : "Listening";
    return build("listening", line, "dot", false, leaseIso, leaseAgeMs);
  }

  // 7. Local push-capable seat with presence/wake reported and NO live push lease -> uses last-activity timestamp.
  const line = lastActivityAgeMs !== null ? `Not listening · last active ${formatSeatAgo(lastActivityAgeMs)}` : "Not listening";
  return build("not_listening", line, "ring", false, lastActivityIso, lastActivityAgeMs);
}

/** Convenience adapter for `swarm_read.workspace_roster` entries used by CLI, stdio MCP, and hosted MCP. */
export function classifyRosterSeatStatus(
  row: RosterSeatInput,
  now = Date.now(),
  options: SeatClockOptions = {},
): SeatStatus {
  return classifySeatStatus({
    transport: row.transport,
    turnOnly: row.turn_only,
    connection: row.connection,
    wake: row.wake ?? null,
    lastActivityAt: row.last_activity_at,
    workingOn: row.open_work
      ? {
          since: row.open_work.since,
          text: row.open_work.text,
          // workspace_roster only returns open_work.text for workspace-wide or open-channel unaddressed work.
          scope: row.open_work.text !== null ? "public_channel" : "private_channel",
        }
      : null,
    waitingSince: row.messages_waiting?.since ?? null,
    unseenCount: row.messages_waiting?.count ?? null,
    ...options,
  }, now);
}
