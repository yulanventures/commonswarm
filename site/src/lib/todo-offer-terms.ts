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

/** Formats an ISO timestamp into an unambiguous exact date and time (never a vague placeholder). */
export function formatExactOfferAt(iso: string, timeZone?: string): string | null {
  if (typeof iso !== "string") return null;
  const trimmed = iso.trim();
  if (!trimmed) return null;
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find(part => part.type === type)?.value ?? "";
  const month = get("month");
  const day = get("day");
  const year = get("year");
  const hour = get("hour");
  const minute = get("minute");
  const period = get("dayPeriod").toLocaleLowerCase();
  if (!month || !day || !year || !hour || !minute) return null;
  return `${month} ${day}, ${year}, ${hour}:${minute}${period ? ` ${period}` : ""}`;
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
