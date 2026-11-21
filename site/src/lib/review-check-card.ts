// Revision-bound review check thread card (C3): one calm card attached to a thread root.
// Pure DOM. Repo, ref, head SHA, seat names, and notes are untrusted and enter only via textContent.
// Interactive Pass / Hold controls appear strictly when the signed-in person is a required seat.
import {
  REVIEW_CHECK_NOTE_MAX,
  reviewCheckStatusSummary,
  shortReviewSha,
  viewerRequiredStamp,
  type ReviewCheckRecord,
  type ReviewCheckStamp,
  type ReviewCheckVerdict,
} from "./review-checks";

export interface ReviewCheckCardVM {
  check: ReviewCheckRecord;
  viewerUserId: string | null;
  pending?: boolean;
  error?: string | null;
  draftNote?: string;
  formatTime?: (iso: string) => { text: string; iso: string } | null;
}

export interface ReviewCheckCardHandlers {
  onStamp: (check: ReviewCheckRecord, verdict: ReviewCheckVerdict, note: string) => void;
  onDraftChange?: (checkId: string, note: string) => void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function seatVerdictDescriptor(stamp: ReviewCheckStamp): {
  kind: "pass" | "hold" | "stale" | "pending";
  symbol: string;
  label: string;
} {
  if (stamp.effectiveVerdict === "pass") {
    return { kind: "pass", symbol: "✓", label: "Pass" };
  }
  if (stamp.effectiveVerdict === "hold") {
    return { kind: "hold", symbol: "✕", label: "Hold" };
  }
  if (stamp.stale && stamp.verdict && stamp.headSha) {
    return {
      kind: "stale",
      symbol: "○",
      label: `Pending · old ${stamp.verdict} @ ${shortReviewSha(stamp.headSha)}`,
    };
  }
  return { kind: "pending", symbol: "○", label: "Pending" };
}

function buildSeatRow(
  doc: Document,
  stamp: ReviewCheckStamp,
  isViewer: boolean,
  formatTime?: ReviewCheckCardVM["formatTime"],
): HTMLLIElement {
  const item = el(doc, "li", "hm-review-check__seat");
  item.dataset.reviewSeat = `${stamp.seatKind}:${stamp.seatId}`;
  const verdict = seatVerdictDescriptor(stamp);
  item.dataset.seatVerdict = verdict.kind;

  const line = el(doc, "div", "hm-review-check__seat-line");

  const who = el(doc, "span", "hm-review-check__seat-who");
  const displayName = stamp.name ?? stamp.seatId.slice(0, 8);
  who.append(el(doc, "span", "hm-review-check__seat-name", displayName));
  if (isViewer) {
    who.append(el(doc, "span", "hm-review-check__self", "You"));
  }

  const badge = el(doc, "span", `hm-review-check__verdict hm-review-check__verdict--${verdict.kind}`);
  const icon = el(doc, "span", "hm-review-check__verdict-mark", verdict.symbol);
  icon.setAttribute("aria-hidden", "true");
  badge.append(icon, el(doc, "span", "hm-review-check__verdict-text", verdict.label));

  line.append(who, badge);
  item.append(line);

  // Only show a stamp's note and timestamp while it applies to the current head (never stale notes).
  const hasCurrentNote = !stamp.stale && stamp.note !== null && stamp.note.length > 0;
  const formattedAt = !stamp.stale && stamp.stampedAt && formatTime ? formatTime(stamp.stampedAt) : null;
  if (hasCurrentNote || formattedAt) {
    const detail = el(doc, "div", "hm-review-check__seat-detail");
    if (hasCurrentNote) {
      detail.append(el(doc, "span", "hm-review-check__seat-note", stamp.note!));
    }
    if (formattedAt && formattedAt.text) {
      const time = doc.createElement("time");
      time.className = "hm-review-check__seat-time";
      time.textContent = formattedAt.text;
      if (Number.isFinite(Date.parse(formattedAt.iso))) time.dateTime = formattedAt.iso;
      detail.append(time);
    }
    item.append(detail);
  }

  return item;
}

/** Build one inline revision-bound review check card for a thread root message. */
export function buildReviewCheckCard(
  doc: Document,
  vm: ReviewCheckCardVM,
  handlers: ReviewCheckCardHandlers,
): HTMLElement {
  const { check } = vm;
  const summary = reviewCheckStatusSummary(check);
  const subjectText = `${check.subject.repo}#${check.subject.ref}`;
  const shortSha = shortReviewSha(check.headSha);
  const viewerStamp = viewerRequiredStamp(check, vm.viewerUserId);
  const pending = vm.pending === true;

  const root = el(doc, "section", "hm-review-check");
  root.tabIndex = -1;
  root.dataset.reviewCheck = check.checkId;
  root.dataset.reviewStatus = check.status;
  root.dataset.reviewHead = check.headSha;
  root.setAttribute("aria-label", `Review check ${subjectText}`);
  if (pending) root.setAttribute("aria-busy", "true");

  // Header: subject + short SHA on the left, overall status pill + pass fraction on the right.
  const head = el(doc, "header", "hm-review-check__head");

  const identity = el(doc, "div", "hm-review-check__identity");
  identity.append(el(doc, "span", "hm-review-check__subject", subjectText));
  const sha = el(doc, "code", "hm-review-check__sha", `@ ${shortSha}`);
  sha.title = check.headSha;
  identity.append(sha);

  const statusPill = el(doc, "span", `hm-review-check__status hm-review-check__status--${summary.tone}`);
  statusPill.dataset.reviewStatusPill = summary.tone;
  const statusMark = summary.tone === "ready" ? "✓" : summary.tone === "hold" ? "✕" : "○";
  const statusIcon = el(doc, "span", "hm-review-check__status-mark", statusMark);
  statusIcon.setAttribute("aria-hidden", "true");
  statusPill.append(
    statusIcon,
    el(doc, "span", "hm-review-check__status-label", summary.label),
    el(doc, "span", "hm-review-check__status-count", summary.countLabel),
  );

  head.append(identity, statusPill);
  root.append(head);

  // Per-seat verdict rows.
  const list = el(doc, "ul", "hm-review-check__seats");
  const viewerIdLower = vm.viewerUserId?.toLowerCase() ?? "";
  for (const stamp of check.stamps) {
    const isViewer = Boolean(viewerIdLower) && stamp.seatKind === "user" && stamp.seatId === viewerIdLower;
    list.append(buildSeatRow(doc, stamp, isViewer, vm.formatTime));
  }
  root.append(list);

  // Inline viewer stamp controls ONLY when the signed-in person is one of the required user seats.
  if (viewerStamp) {
    const actions = el(doc, "div", "hm-review-check__actions");
    const noteInput = el(doc, "input", "hm-review-check__note-input");
    noteInput.type = "text";
    noteInput.maxLength = REVIEW_CHECK_NOTE_MAX;
    noteInput.placeholder = "Note (optional)";
    noteInput.autocomplete = "off";
    noteInput.setAttribute("aria-label", "Review note");
    noteInput.dataset.reviewCheckNote = check.checkId;
    noteInput.value = vm.draftNote ?? "";
    noteInput.disabled = pending;
    noteInput.addEventListener("input", () => {
      handlers.onDraftChange?.(check.checkId, noteInput.value);
    });

    const buttons = el(doc, "div", "hm-review-check__buttons");

    const passBtn = el(doc, "button", "hm-review-check__btn hm-review-check__btn--pass");
    passBtn.type = "button";
    passBtn.dataset.reviewStamp = "pass";
    passBtn.disabled = pending;
    passBtn.setAttribute("aria-pressed", String(viewerStamp.effectiveVerdict === "pass"));
    const passMark = el(doc, "span", "hm-review-check__btn-mark", "✓");
    passMark.setAttribute("aria-hidden", "true");
    passBtn.append(passMark, el(doc, "span", "hm-review-check__btn-label", "Pass"));
    passBtn.addEventListener("click", () => {
      if (pending) return;
      handlers.onStamp(check, "pass", noteInput.value);
    });

    const holdBtn = el(doc, "button", "hm-review-check__btn hm-review-check__btn--hold");
    holdBtn.type = "button";
    holdBtn.dataset.reviewStamp = "hold";
    holdBtn.disabled = pending;
    holdBtn.setAttribute("aria-pressed", String(viewerStamp.effectiveVerdict === "hold"));
    const holdMark = el(doc, "span", "hm-review-check__btn-mark", "✕");
    holdMark.setAttribute("aria-hidden", "true");
    holdBtn.append(holdMark, el(doc, "span", "hm-review-check__btn-label", "Hold"));
    holdBtn.addEventListener("click", () => {
      if (pending) return;
      handlers.onStamp(check, "hold", noteInput.value);
    });

    buttons.append(passBtn, holdBtn);
    actions.append(noteInput, buttons);
    root.append(actions);
  }

  if (vm.error) {
    const alert = el(doc, "p", "hm-review-check__error", vm.error);
    alert.setAttribute("role", "alert");
    root.append(alert);
  }

  return root;
}
