/**
 * Shared inline offer gate-terms eligibility and formatting helper (#742 R4 Section 2.3).
 * Used identically by both Waiting on you (`waiting-panel.ts`) and inline Chat `OfferCard`
 * (`home-stream-approvals.ts`) so neither surface can expose inline Accept/Approve & Decline
 * unless every material term is present, valid, un-truncated, and rendered verbatim via textContent.
 */

export const TODO_GATE_NOTE_LIMIT = 200;
export const TODO_DECISION_NOTE_LIMIT = 500;
export const TODO_CONFLICT_MESSAGE = "This to-do changed. Reload to check.";

export interface InlineOfferTermsInput {
  /** Waiting: `Boolean(item.notesTruncated)`; Chat OfferCard: `Boolean(card.hasNotes)`. */
  hasUnshownNotes: boolean;
  /** Full `offer_gate` projected from the exact same read/row as `offer_id` and `base_version`. */
  offerGate: unknown;
  timeZone?: string;
}

export type InlineOfferTermsResult =
  | {
      eligible: true;
      gateKind: "none" | "at" | "hold";
      /** Null for `none`; exact formatted scheduled date & time for `at`; exact verbatim note for `hold`. */
      gateText: string | null;
    }
  | {
      eligible: false;
      reason: "notes" | "after" | "invalid_at" | "invalid_hold" | "unknown_gate";
    };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const OFFER_AT_ISO_RE = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

function formatExactParts(
  ms: number,
  timeZone: string | undefined,
  includeZoneName: boolean,
): { month: string; day: string; year: string; hour: string; minute: string; second: string; period: string; zone: string } | null {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
      ...(includeZoneName ? { timeZoneName: "shortOffset" as const } : {}),
    }).formatToParts(new Date(ms));
  } catch {
    return null;
  }
  const get = (type: string) => parts.find(part => part.type === type)?.value ?? "";
  const month = get("month");
  const day = get("day");
  const year = get("year");
  const hour = get("hour");
  const minute = get("minute");
  const second = get("second");
  const period = get("dayPeriod").toLocaleLowerCase();
  const rawZone = includeZoneName ? get("timeZoneName").trim() : "UTC";
  const zone = /^GMT[+-]0(?::00)?$/u.test(rawZone) ? "GMT" : rawZone;
  if (!month || !day || !year || !hour || !minute || !second || !period) return null;
  return { month, day, year, hour, minute, second, period, zone };
}

/** Formats an accepted ISO timestamp into an unambiguous exact instant (seconds, non-zero ms, and explicit zone/offset). */
export function formatExactOfferAt(iso: string, timeZone?: string): string | null {
  if (typeof iso !== "string") return null;
  const trimmed = iso.trim();
  if (!OFFER_AT_ISO_RE.test(trimmed)) return null;
  const ymd = trimmed.slice(0, 10);
  const ymdMs = Date.parse(`${ymd}T00:00:00.000Z`);
  if (!Number.isFinite(ymdMs) || new Date(ymdMs).toISOString().slice(0, 10) !== ymd) return null;
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) return null;
  const fracMs = ((ms % 1000) + 1000) % 1000;
  const fracText = fracMs !== 0 ? `.${String(fracMs).padStart(3, "0")}` : "";
  const formatted = formatExactParts(ms, timeZone, true);
  if (formatted && formatted.zone) {
    return `${formatted.month} ${formatted.day}, ${formatted.year}, ${formatted.hour}:${formatted.minute}:${formatted.second}${fracText} ${formatted.period} ${formatted.zone}`;
  }
  const utcFallback = formatExactParts(ms, "UTC", false);
  if (!utcFallback) return null;
  return `${utcFallback.month} ${utcFallback.day}, ${utcFallback.year}, ${utcFallback.hour}:${utcFallback.minute}:${utcFallback.second}${fracText} ${utcFallback.period} UTC`;
}

/**
 * Evaluates R4 Section 2.3 inline offer eligibility.
 * Fails closed (`eligible: false` -> route to To-do detail via "Review & decide") on:
 * - `hasUnshownNotes === true`
 * - `offerGate.kind === 'after'`
 * - `offerGate.kind === 'at'` with missing or invalid ISO timestamp
 * - `offerGate.kind === 'hold'` with missing, null, empty/whitespace, or truncated (>200 chars) note
 * - missing or unrecognized `offerGate` shape
 */
export function evaluateInlineOfferTerms(input: InlineOfferTermsInput): InlineOfferTermsResult {
  if (input.hasUnshownNotes) {
    return { eligible: false, reason: "notes" };
  }
  const gate = input.offerGate;
  if (!isPlainRecord(gate) || typeof gate.kind !== "string") {
    return { eligible: false, reason: "unknown_gate" };
  }
  if (gate.kind === "none") {
    return { eligible: true, gateKind: "none", gateText: null };
  }
  if (gate.kind === "at") {
    if (typeof gate.at !== "string") {
      return { eligible: false, reason: "invalid_at" };
    }
    const formatted = formatExactOfferAt(gate.at, input.timeZone);
    if (!formatted) {
      return { eligible: false, reason: "invalid_at" };
    }
    return { eligible: true, gateKind: "at", gateText: formatted };
  }
  if (gate.kind === "hold") {
    if (
      typeof gate.note !== "string" ||
      gate.note.trim().length === 0 ||
      Array.from(gate.note).length > TODO_GATE_NOTE_LIMIT ||
      gate.truncated === true
    ) {
      return { eligible: false, reason: "invalid_hold" };
    }
    return { eligible: true, gateKind: "hold", gateText: gate.note };
  }
  if (gate.kind === "after") {
    return { eligible: false, reason: "after" };
  }
  return { eligible: false, reason: "unknown_gate" };
}
