/**
 * Interactive replies: an ask's fixed choices. The CLI's repeated --choice and the MCP ask tool's
 * choices both become these {id, label} options. The ids are derived from the labels so that an
 * agent can match the reply it reads back; the server stores the options with the ask and checks
 * a person's answer against that stored copy.
 */
export const CHOICE_MIN = 2;
export const CHOICE_MAX = 6;
export const CHOICE_LABEL_MAX = 80;
const CHOICE_ID_MAX = 32;

export interface ChoiceOption {
  id: string;
  label: string;
}

/** Labels in order to options, or an Error naming the rule broken. */
export function choiceOptions(labels: readonly string[]): ChoiceOption[] {
  if (labels.length < CHOICE_MIN || labels.length > CHOICE_MAX) {
    throw new Error(`An ask takes ${CHOICE_MIN} to ${CHOICE_MAX} choices; got ${labels.length}.`);
  }
  const options: ChoiceOption[] = [];
  const seenLabels = new Set<string>();
  for (const [index, raw] of labels.entries()) {
    const label = raw.replace(/\s+/gu, " ").trim();
    if (label.length < 1 || label.length > CHOICE_LABEL_MAX) {
      throw new Error(`Each choice must be 1 to ${CHOICE_LABEL_MAX} characters of plain text.`);
    }
    const folded = label.toLocaleLowerCase();
    if (seenLabels.has(folded)) throw new Error(`Each choice must be different; "${label}" repeats.`);
    seenLabels.add(folded);
    const slug = label.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+/u, "")
      .slice(0, CHOICE_ID_MAX).replace(/-+$/u, "");
    const base = slug || `option-${index + 1}`;
    let id = base;
    for (let n = 2; options.some((option) => option.id === id); n += 1) {
      id = `${base.slice(0, CHOICE_ID_MAX - String(n).length - 1).replace(/-+$/u, "")}-${n}`;
    }
    options.push({ id, label });
  }
  return options;
}
