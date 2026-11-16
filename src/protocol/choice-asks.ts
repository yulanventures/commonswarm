/**
 * Choice asks: an ask with 2 to 6 fixed options that a person answers with a click, and
 * optionally with "Other" text. The CLI, the local and hosted MCP and the command edge read the
 * same rules here, so what one accepts the others accept.
 *
 * Ids are derived from labels when a caller doesn't give one, so an agent can match the reply it
 * reads back. The server stores the options with the ask and checks every answer against that
 * stored copy, never against what a browser sends.
 */
export const CHOICE_MIN = 2;
export const CHOICE_MAX = 6;
export const CHOICE_LABEL_MAX = 80;
export const CHOICE_DESCRIPTION_MAX = 200;
export const CHOICE_OTHER_TEXT_MAX = 500;
export const CHOICE_ID_MAX = 32;
export const CHOICE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
/** ui_actions.option_id for an answer that is only "Other" text; option_ids is then empty. */
export const CHOICE_OTHER_OPTION_ID = "other";
/**
 * UTF-8 bytes of the options' JSON text. swarm.ask_choices holds the stored jsonb to 4096 bytes;
 * jsonb runs a little larger than the text, so the edge refuses past this with a 400 rather than
 * letting the CHECK answer 500.
 */
export const CHOICE_OPTIONS_MAX_BYTES = 3840;

/** One stored option. description and recommended appear only when set. */
export interface ChoiceOption {
  id: string;
  label: string;
  description?: string;
  recommended?: true;
}

/** What a caller may give for an option: a bare label, or the object form. */
export type ChoiceOptionInput = string | {
  id?: string;
  label: string;
  description?: string;
  recommended?: boolean;
};

/**
 * Characters a choice's text never carries: controls, line separators and bidi controls, which
 * could reorder or break the reply an agent reads. Joiners stay, so emoji sequences survive.
 */
const CHOICE_UNSAFE_RE =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u;

/** True when text carries a character CHOICE_UNSAFE_RE refuses. */
export function choiceTextUnsafe(text: string): boolean {
  return CHOICE_UNSAFE_RE.test(text);
}

/**
 * A zero-width joiner that joins two emoji (an Extended_Pictographic character, optionally with
 * VS16 or a skin tone, then another): the one invisible character a choice's text keeps, so a joined
 * emoji such as woman-technologist stays one emoji. Any other joiner is stripped, as the signal sanitizer strips it.
 */
const EMOJI_JOINER_RE = /(?<=\p{Extended_Pictographic}[\u{fe0f}\u{1f3fb}-\u{1f3ff}]?)\u{200d}(?=\p{Extended_Pictographic})/u;
/** Invisible format characters stripped from choice text (the signal sanitizer strips them too). */
const CHOICE_INVISIBLE_RE = /[\u{200b}-\u{200d}\u{2060}\u{feff}\u{e0000}-\u{e007f}]/gu;

/**
 * Applies strip to the text between emoji joiners and joins the parts back with the joiners, so a
 * sanitizer that removes every U+200D keeps the ones inside emoji sequences. The command edge
 * passes the signal sanitizer; clients pass stripChoiceInvisible.
 */
export function keepEmojiJoiners(value: string, strip: (part: string) => string): string {
  return value.split(EMOJI_JOINER_RE).map(strip).join("\u{200d}");
}

/** Removes the invisible format characters a choice's text drops. */
export function stripChoiceInvisible(part: string): string {
  return part.replace(CHOICE_INVISIBLE_RE, "");
}

/** A label or description as stored: emoji joiners kept, other invisible characters gone, one line. */
export function choiceOneLine(value: string, strip: (part: string) => string = stripChoiceInvisible): string {
  return keepEmojiJoiners(value, strip).replace(/\s+/gu, " ").trim();
}

function oneLine(value: string): string {
  return choiceOneLine(value);
}

function derivedId(label: string, index: number, taken: ReadonlySet<string>): string {
  const slug = label.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+/u, "")
    .slice(0, CHOICE_ID_MAX).replace(/-+$/u, "");
  const base = slug || `option-${index + 1}`;
  let id = base;
  for (let n = 2; taken.has(id); n += 1) {
    id = `${base.slice(0, CHOICE_ID_MAX - String(n).length - 1).replace(/-+$/u, "")}-${n}`;
  }
  return id;
}

/**
 * Inputs in order to stored options, or an Error naming the rule broken. Ids are derived before
 * the recommended option moves to the front, so a reorder never changes an id.
 */
export function choiceOptions(inputs: readonly ChoiceOptionInput[]): ChoiceOption[] {
  if (inputs.length < CHOICE_MIN || inputs.length > CHOICE_MAX) {
    throw new Error(`An ask takes ${CHOICE_MIN} to ${CHOICE_MAX} choices; got ${inputs.length}.`);
  }
  const rows = inputs.map((input) => typeof input === "string" ? { label: input } : input);
  const explicit = new Set<string>();
  for (const row of rows) {
    if (row.id === undefined) continue;
    if (typeof row.id !== "string" || !CHOICE_ID_RE.test(row.id)) {
      throw new Error(`Each choice id must be 1 to ${CHOICE_ID_MAX} of a-z, 0-9, _ or -, starting with a letter or digit.`);
    }
    if (explicit.has(row.id)) throw new Error(`Each choice id must be different; "${row.id}" repeats.`);
    explicit.add(row.id);
  }
  const options: ChoiceOption[] = [];
  const seenLabels = new Set<string>();
  const taken = new Set(explicit);
  let recommended = 0;
  for (const [index, row] of rows.entries()) {
    const label = typeof row.label === "string" ? oneLine(row.label) : "";
    if (label.length < 1 || label.length > CHOICE_LABEL_MAX || CHOICE_UNSAFE_RE.test(label)) {
      throw new Error(`Each choice must be 1 to ${CHOICE_LABEL_MAX} characters of plain text.`);
    }
    const folded = label.toLocaleLowerCase();
    if (seenLabels.has(folded)) throw new Error(`Each choice must be different; "${label}" repeats.`);
    seenLabels.add(folded);
    let description: string | undefined;
    if (row.description !== undefined) {
      description = typeof row.description === "string" ? oneLine(row.description) : "";
      if (description.length < 1 || description.length > CHOICE_DESCRIPTION_MAX || CHOICE_UNSAFE_RE.test(description)) {
        throw new Error(`A choice's description must be 1 to ${CHOICE_DESCRIPTION_MAX} characters of plain text.`);
      }
    }
    if (row.recommended !== undefined && typeof row.recommended !== "boolean") {
      throw new Error("A choice's recommended is true or false.");
    }
    if (row.recommended === true) recommended += 1;
    const id = row.id ?? derivedId(label, index, taken);
    taken.add(id);
    options.push({ id, label, ...(description === undefined ? {} : { description }),
      ...(row.recommended === true ? { recommended: true as const } : {}) });
  }
  if (recommended > 1) throw new Error("At most one choice can be recommended.");
  const ordered = recommendedFirst(options);
  if (new TextEncoder().encode(JSON.stringify(ordered)).length > CHOICE_OPTIONS_MAX_BYTES) {
    throw new Error("These choices are too long together; shorten the labels or descriptions.");
  }
  return ordered;
}

/** The recommended option first, the rest in the order given. */
export function recommendedFirst<T extends { recommended?: boolean }>(options: readonly T[]): T[] {
  return [...options.filter((option) => option.recommended === true),
    ...options.filter((option) => option.recommended !== true)];
}

/**
 * The CLI's --option "<label>[::description]". The first "::" splits; a label with no
 * description is the same as --choice.
 */
export function parseChoiceOptionFlag(raw: string): Exclude<ChoiceOptionInput, string> {
  const split = raw.indexOf("::");
  if (split < 0) return { label: raw };
  return { label: raw.slice(0, split), description: raw.slice(split + 2) };
}

/**
 * Mark one option recommended by its 1-based position or its id, before ordering. Returns the
 * inputs with that one option marked; an Error when it names none.
 */
export function markRecommended(
  inputs: readonly ChoiceOptionInput[],
  selector: string,
): Exclude<ChoiceOptionInput, string>[] {
  const rows = inputs.map((input) => typeof input === "string" ? { label: input } : { ...input });
  let index = -1;
  if (/^[1-9][0-9]*$/u.test(selector)) {
    index = Number(selector) - 1;
  } else {
    // Without a recommended option nothing reorders, so ids line up with the inputs.
    index = choiceOptions(rows.map(({ recommended: _recommended, ...row }) => row)).map((option) => option.id)
      .indexOf(selector);
  }
  if (index < 0 || index >= rows.length) {
    throw new Error(`--recommended names a choice by its number (1 to ${rows.length}) or its id.`);
  }
  return rows.map((row, position) => position === index ? { ...row, recommended: true } : row);
}

/** Trimmed "Other" text, or an Error naming the rule broken. */
export function choiceOtherText(value: string): string {
  const text = value.trim();
  if (Array.from(text).length < 1 || Array.from(text).length > CHOICE_OTHER_TEXT_MAX || CHOICE_UNSAFE_RE.test(text)) {
    throw new Error(`Other text must be 1 to ${CHOICE_OTHER_TEXT_MAX} characters on one line, with no control characters.`);
  }
  return text;
}

/**
 * The reply an answer posts, so every agent client reads single, multi and "Other" answers the
 * same way: "Selected: <labels>" and/or "Other: <text>", one per line.
 */
export function choiceAnswerBody(labels: readonly string[], otherText: string | null): string {
  const lines: string[] = [];
  if (labels.length > 0) lines.push(`Selected: ${labels.join(", ")}`);
  if (otherText !== null) lines.push(`Other: ${otherText}`);
  return lines.join("\n");
}
