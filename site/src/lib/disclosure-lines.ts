/**
 * The invitation disclosure, one sentence to a line.
 *
 * The words and their order are the server's: the review shows the text of the preview it was
 * sent, and nothing here holds a copy of it. This only decides where a line starts, so the four
 * things a person agrees to read as four lines instead of one block.
 */
export function disclosureSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/u).filter((sentence) => sentence.length > 0);
}

/** Write the disclosure into its paragraph as one block-level span per sentence, with the spaces between them
 * kept as text, so the paragraph's text is still the disclosure. Drawn again only when the text changes. */
export function showDisclosure(target: HTMLElement, text: string): void {
  const sentences = disclosureSentences(text);
  if (target.childElementCount === sentences.length && target.textContent === sentences.join(" ")) return;
  target.replaceChildren();
  sentences.forEach((sentence, index) => {
    if (index > 0) target.append(" ");
    const line = target.ownerDocument.createElement("span");
    line.dataset.disclosureLine = "";
    line.textContent = sentence;
    target.append(line);
  });
}
