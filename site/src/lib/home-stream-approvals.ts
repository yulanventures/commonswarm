// Inline approvals in Chat (Grokbot parity Pillar 4): to-do offers waiting on the viewer, answered in place.
// Pure derivation first, then a thin DOM builder. User text goes in through textContent only.
import type { Party, TodoGate, TodoStart, TodoSummary } from "./home/contract";
import { evaluateInlineOfferTerms } from "./todo-offer-terms";

export interface OfferCardVM {
  todoId: string;
  offerId: string;
  version: number;
  title: string;
  who: string;
  toViewer: boolean;
  dueOn: string | null;
  requesterName: string | null;
  start: TodoStart;
  offerGate: TodoGate | null;
  hasNotes: boolean;
  detailHref?: string;
}

/** Offers the viewer decides on, for to-dos still open or in Doing, in the order given. */
export function pendingOfferCards(
  rows: readonly TodoSummary[],
  viewerId: string,
  nameOf: (party: Party) => string,
  hrefOf?: (todoId: string) => string,
): OfferCardVM[] {
  if (!viewerId) return [];
  return rows.flatMap(row => {
    const offer = row.offer;
    if (!offer || offer.decider_user_id !== viewerId || (row.state !== "open" && row.state !== "doing")) return [];
    const toViewer = offer.to.kind === "user" && offer.to.id === viewerId;
    const requesterName = offer.by
      ? nameOf(offer.by.principal_id ? { kind: "agent", id: offer.by.principal_id } : { kind: "user", id: offer.by.user_id })
      : null;
    const start: TodoStart = offer.start === "now" ? "now" : "queue";
    return [{
      todoId: row.todo_id,
      offerId: offer.offer_id,
      version: row.version,
      title: row.title,
      who: toViewer ? "" : nameOf(offer.to),
      toViewer,
      dueOn: row.due_on ?? null,
      requesterName: requesterName?.trim() ? requesterName : null,
      start,
      offerGate: offer.gate ?? null,
      hasNotes: row.has_notes === true,
      ...(hrefOf ? { detailHref: hrefOf(row.todo_id) } : {}),
    }];
  });
}

/** The card's sentence: who wants the to-do, or that it is offered to you. */
export function offerCardText(card: OfferCardVM): string {
  return card.toViewer ? `“${card.title}” is offered to you` : `${card.who} wants to take “${card.title}”`;
}

function formatOfferDue(dueOn: string | null): string | null {
  if (!dueOn) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(dueOn);
  if (!match) return `Due ${dueOn}`;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const month = months[Number(match[2]) - 1];
  const day = Number(match[3]);
  return month && day ? `Due ${month} ${day}` : `Due ${dueOn}`;
}

export type OfferAnswer = "accept" | "decline";
export interface OfferCardCallbacks {
  answer: (card: OfferCardVM, answer: OfferAnswer, controls: { buttons: HTMLButtonElement[]; status: HTMLElement }) => void;
  openDetail?: (card: OfferCardVM) => void;
  timeZone?: string;
}

export function buildOfferCard(doc: Document, card: OfferCardVM, callbacks: OfferCardCallbacks): HTMLElement {
  const root = doc.createElement("section");
  root.className = "hm-approval-card";
  root.dataset.offerCard = card.todoId;
  root.dataset.offerVersion = String(card.version);
  const text = doc.createElement("p");
  text.className = "hm-approval-card__text";
  text.textContent = offerCardText(card);

  const termsResult = evaluateInlineOfferTerms({
    hasUnshownNotes: card.hasNotes,
    offerGate: card.offerGate,
    timeZone: callbacks.timeZone,
  });
  const hasValidVersion = typeof card.version === "number" && Number.isInteger(card.version) && card.version >= 1;
  const canInline = termsResult.eligible && hasValidVersion;

  const termPieces: Array<{ text: string; gateKind?: "at" | "hold" }> = [];
  if (card.requesterName) termPieces.push({ text: `From ${card.requesterName}` });
  const due = formatOfferDue(card.dueOn);
  if (due) termPieces.push({ text: due });
  if (card.start === "now") termPieces.push({ text: "Start now" });
  else termPieces.push({ text: "Queue" });
  if (termsResult.eligible && termsResult.gateKind === "at" && termsResult.gateText) {
    termPieces.push({ text: `Scheduled ${termsResult.gateText}`, gateKind: "at" });
  } else if (termsResult.eligible && termsResult.gateKind === "hold" && termsResult.gateText) {
    termPieces.push({ text: `Hold: ${termsResult.gateText}`, gateKind: "hold" });
  }

  let termsEl: HTMLElement | null = null;
  if (termPieces.length > 0) {
    termsEl = doc.createElement("div");
    termsEl.className = "hm-approval-card__terms";
    for (const piece of termPieces) {
      const span = doc.createElement("span");
      span.className = "hm-approval-card__term";
      if (piece.gateKind) span.dataset.offerGateTerm = piece.gateKind;
      span.textContent = piece.text;
      termsEl.append(span);
    }
  }

  const actions = doc.createElement("div");
  actions.className = "hm-approval-card__actions";
  const status = doc.createElement("p");
  status.className = "hm-approval-card__status";
  status.setAttribute("role", "status");

  if (canInline) {
    const buttons: HTMLButtonElement[] = [];
    for (const [answer, label] of [["accept", "Accept"], ["decline", "Decline"]] as const) {
      const button = doc.createElement("button");
      button.type = "button";
      button.className = `hm-approval-card__button hm-approval-card__button--${answer}`;
      button.dataset.offerAnswer = answer;
      button.textContent = label;
      button.addEventListener("click", () => callbacks.answer(card, answer, { buttons, status }));
      buttons.push(button);
      actions.append(button);
    }
  } else {
    const review = doc.createElement("a");
    review.className = "hm-approval-card__button hm-approval-card__button--review";
    review.href = card.detailHref ?? "#";
    review.dataset.offerReview = card.todoId;
    review.textContent = "Review & decide";
    review.addEventListener("click", (event) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (!callbacks.openDetail) return;
      event.preventDefault();
      callbacks.openDetail(card);
    });
    actions.append(review);
  }

  root.setAttribute("aria-label", text.textContent);
  if (termsEl) root.append(text, termsEl, actions, status);
  else root.append(text, actions, status);
  return root;
}
