/**
 * DRAW THE MENTIONS A MESSAGE IS KNOWN TO CARRY.
 *
 * Who a message mentions is stored with it, by id (`swarm_read.signal_mentions`). This turns the
 * words that name those people and agents into pills, after the body has been rendered and
 * sanitised. It works on text nodes and builds elements; it never writes HTML.
 *
 * It does not decide who is mentioned. A name in the body that the message does not mention
 * stays plain text, and so does a mention whose name the body no longer spells (a rename).
 * Code, links and controls are left alone, as `linkifyBrainTopics` leaves them.
 */
import { mentionSpans, type MentionEntity, type MentionTarget } from "./mention-address.js";

const OPAQUE = new Set(["PRE", "CODE", "A", "BUTTON"]);
export const MENTION_PILL_CLASS = "dashboard__mention";

/** Returns how many pills were drawn. `isViewer` marks a mention of the reader or one of their agents. */
export function markMentions(
  root: HTMLElement,
  targets: readonly MentionTarget[],
  isViewer: (entity: MentionEntity) => boolean,
): number {
  if (targets.length === 0) return 0;
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (!(node.nodeValue ?? "").includes("@")) continue;
    let opaque = false;
    for (let parent = node.parentElement; parent !== null && parent !== root; parent = parent.parentElement) {
      if (OPAQUE.has(parent.tagName) || parent.classList.contains(MENTION_PILL_CLASS)) { opaque = true; break; }
    }
    if (!opaque) nodes.push(node as Text);
  }
  let drawn = 0;
  for (const node of nodes) {
    const text = node.nodeValue ?? "";
    const spans = mentionSpans(text, targets);
    if (spans.length === 0) continue;
    const pieces = doc.createDocumentFragment();
    let at = 0;
    for (const span of spans) {
      if (span.start > at) pieces.append(text.slice(at, span.start));
      const pill = doc.createElement("span");
      pill.className = MENTION_PILL_CLASS;
      pill.dataset.mentionKind = span.entity.kind;
      if (isViewer(span.entity)) pill.dataset.mentionViewer = "";
      pill.textContent = text.slice(span.start, span.end);
      pieces.append(pill);
      at = span.end;
      drawn += 1;
    }
    if (at < text.length) pieces.append(text.slice(at));
    node.replaceWith(pieces);
  }
  return drawn;
}
