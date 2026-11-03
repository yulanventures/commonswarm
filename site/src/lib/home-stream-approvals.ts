// Inline approvals in Chat (Grokbot parity Pillar 4): to-do offers waiting on the viewer, answered in place.
// Pure derivation first, then a thin DOM builder. User text goes in through textContent only.
import type { Party, TodoSummary } from "./home/contract";

export interface OfferCardVM { todoId: string; offerId: string; title: string; who: string; toViewer: boolean }

/** Offers the viewer decides on, for to-dos still open or in Doing, in the order given. */
export function pendingOfferCards(
  rows: readonly TodoSummary[],
  viewerId: string,
  nameOf: (party: Party) => string,
): OfferCardVM[] {
  if (!viewerId) return [];
  return rows.flatMap(row => {
    const offer = row.offer;
    if (!offer || offer.decider_user_id !== viewerId || (row.state !== "open" && row.state !== "doing")) return [];
    const toViewer = offer.to.kind === "user" && offer.to.id === viewerId;
    return [{ todoId: row.todo_id, offerId: offer.offer_id, title: row.title, who: toViewer ? "" : nameOf(offer.to), toViewer }];
  });
}

/** The card's sentence: who wants the to-do, or that it is offered to you. */
export function offerCardText(card: OfferCardVM): string {
  return card.toViewer ? `“${card.title}” is offered to you` : `${card.who} wants to take “${card.title}”`;
}

export type OfferAnswer = "accept" | "decline";
export interface OfferCardCallbacks {
  answer: (card: OfferCardVM, answer: OfferAnswer, controls: { buttons: HTMLButtonElement[]; status: HTMLElement }) => void;
}

export function buildOfferCard(doc: Document, card: OfferCardVM, callbacks: OfferCardCallbacks): HTMLElement {
  const root = doc.createElement("section");
  root.className = "hm-approval-card";
  root.dataset.offerCard = card.todoId;
  const text = doc.createElement("p");
  text.className = "hm-approval-card__text";
  text.textContent = offerCardText(card);
  const actions = doc.createElement("div");
  actions.className = "hm-approval-card__actions";
  const status = doc.createElement("p");
  status.className = "hm-approval-card__status";
  status.setAttribute("role", "status");
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
  root.setAttribute("aria-label", text.textContent);
  root.append(text, actions, status);
  return root;
}
