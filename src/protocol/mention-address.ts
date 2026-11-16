/**
 * @TAGS IN A MESSAGE, read the same way everywhere: the web composer (through
 * site/src/lib/mention-address.ts, which re-exports this), the CLI, the local MCP server
 * and the hosted MCP tools. Pure and import-free, so the Deno edge can import it directly.
 *
 * Every rule was written against a defect found in the web composer's first version, and each
 * has a test: longest name first, boundary characters, case folding that changes a string's
 * length, two roster entries sharing a name, and more tags than one message may carry.
 */

export interface MentionEntity {
  id: string;
  kind: "agent" | "person";
}

export interface MentionTarget {
  entity: MentionEntity;
  /** Raw display name. A name-only tag uses this, and refuses when it is shared. */
  name: string;
  /** Picker and tag label. Duplicate names include a short UUID suffix. */
  label?: string;
}

export interface MentionAddress {
  /** Names shared by two roster entries. A tag on one of these cannot be resolved. */
  ambiguous: string[];
  /** Tags past the cap. They are named rather than dropped in silence. */
  overflow: string[];
  recipients: MentionEntity[];
}

/**
 * The most people and agents one message mentions: the position CHECK on swarm.signal_mentions
 * and SIGNAL_MENTION_MAX on the command edge. tests/mention-address.test.ts pins the three.
 */
export const MENTION_MAX_RECIPIENTS = 8;

/** What may sit in front of an @ for it to start a tag. */
const OPENS_TAG = /\s|[([]/u;

/** What may sit after a name for the tag to end there. */
const CLOSES_TAG = /[\s.,;:!?)\]]/u;

/* Decompose, drop the combining marks, then lower-case. Plain `toLowerCase` is not enough:
 * "İ" folds to TWO code units, so "@ipek" never matched a roster name of "İpek". The same fold
 * decides ambiguity, so two names that differ only by an accent are the same name. It is the
 * fold of site/src/lib/identity-label.ts (foldIdentityName); the parity test pins the two. */
export function foldMentionName(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

const fold = foldMentionName;

/* A name has to survive folding as something a reader could type after an "@". Only combining
 * marks fold to "", and only whitespace folds to whitespace; both used to bind. */
export function isTaggable(name: string): boolean {
  return fold(name).trim() !== "";
}

/** True when the text has an "@" that could open a tag. Callers skip the roster read otherwise. */
export function bodyMayMention(body: string): boolean {
  for (let at = body.indexOf("@"); at !== -1; at = body.indexOf("@", at + 1)) {
    const before = at === 0 ? "" : body[at - 1]!;
    if (before === "" || OPENS_TAG.test(before)) return true;
  }
  return false;
}

/** Names two or more roster entries share, folded. */
function ambiguousNames(targets: readonly MentionTarget[]): Set<string> {
  const counts = new Map<string, number>();
  for (const target of targets) {
    const folded = fold(target.name);
    counts.set(folded, (counts.get(folded) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([name]) => name));
}

function targetLabel(target: MentionTarget): string {
  return target.label ?? target.name;
}

function entityKey(target: MentionTarget): string {
  return `${target.entity.kind}:${target.entity.id}`;
}

function tagMatch(body: string, at: number, token: string): number | null {
  if (!isTaggable(token)) return null;
  const span = body.slice(at + 1, at + 1 + token.length);
  if (span.length !== token.length) return null;
  if (fold(span) !== fold(token)) return null;
  const after = body[at + 1 + token.length];
  if (after !== undefined && !CLOSES_TAG.test(after)) return null;
  return token.length;
}

type MentionHit = {
  target: MentionTarget;
  consumed: number;
  via: "label" | "name";
};

function mentionHitsAt(body: string, at: number, targets: readonly MentionTarget[]): MentionHit[] {
  const hits: MentionHit[] = [];
  for (const target of targets) {
    const labelLength = tagMatch(body, at, targetLabel(target));
    if (labelLength !== null) hits.push({ target, consumed: labelLength, via: "label" });
    const nameLength = tagMatch(body, at, target.name);
    if (nameLength !== null) hits.push({ target, consumed: nameLength, via: "name" });
  }
  return hits;
}

function orderedTargets(targets: readonly MentionTarget[]): MentionTarget[] {
  return [...targets]
    .filter((target) => isTaggable(target.name) || isTaggable(targetLabel(target)))
    .sort((left, right) =>
      targetLabel(right).length - targetLabel(left).length ||
      right.name.length - left.name.length
    );
}

/**
 * Who a body names. An @word that matches nobody stays plain text; a name two entries share
 * names neither and is returned in `ambiguous`; tags past MENTION_MAX_RECIPIENTS are returned
 * in `overflow`.
 */
export function addressFromBody(body: string, targets: readonly MentionTarget[]): MentionAddress {
  const ordered = orderedTargets(targets);
  const ambiguousSet = ambiguousNames(ordered);
  const recipients: MentionEntity[] = [];
  const ambiguous: string[] = [];
  const overflow: string[] = [];
  const seen = new Set<string>();
  for (let at = body.indexOf("@"); at !== -1; at = body.indexOf("@", at + 1)) {
    const before = at === 0 ? "" : body[at - 1]!;
    if (before !== "" && !OPENS_TAG.test(before)) continue;
    const hits = mentionHitsAt(body, at, ordered);
    if (hits.length === 0) continue;
    const consumed = Math.max(...hits.map((hit) => hit.consumed));
    const top = hits.filter((hit) => hit.consumed === consumed);
    const matchedIds = new Set(top.map((hit) => entityKey(hit.target)));
    const sharedNameHit = top.find(
      (hit) => hit.via === "name" && ambiguousSet.has(fold(hit.target.name)),
    );
    const labelHit = top.some((hit) => hit.via === "label");
    if (matchedIds.size > 1 || (sharedNameHit !== undefined && !labelHit)) {
      const token = sharedNameHit !== undefined && !labelHit
        ? sharedNameHit.target.name
        : body.slice(at + 1, at + 1 + consumed);
      if (!ambiguous.includes(token)) ambiguous.push(token);
      at += consumed;
      continue;
    }
    const matched = top[0]?.target;
    if (matched === undefined) continue;
    const key = entityKey(matched);
    if (!seen.has(key)) {
      seen.add(key);
      if (recipients.length < MENTION_MAX_RECIPIENTS) recipients.push({ ...matched.entity });
      else overflow.push(targetLabel(matched));
    }
    at += consumed;
  }
  return { ambiguous, overflow, recipients };
}

/** One tag in a text and who it names. `end` is exclusive and includes the "@". */
export interface MentionSpan {
  start: number;
  end: number;
  entity: MentionEntity;
}

/**
 * Where the tags are, for drawing them, by the same reading as addressFromBody. The caller
 * passes only the people and agents the message is known to mention.
 */
export function mentionSpans(text: string, targets: readonly MentionTarget[]): MentionSpan[] {
  const ordered = orderedTargets(targets);
  if (ordered.length === 0) return [];
  const ambiguousSet = ambiguousNames(ordered);
  const spans: MentionSpan[] = [];
  for (let at = text.indexOf("@"); at !== -1; at = text.indexOf("@", at + 1)) {
    const before = at === 0 ? "" : text[at - 1]!;
    if (before !== "" && !OPENS_TAG.test(before)) continue;
    const hits = mentionHitsAt(text, at, ordered);
    if (hits.length === 0) continue;
    const consumed = Math.max(...hits.map((hit) => hit.consumed));
    const top = hits.filter((hit) => hit.consumed === consumed);
    const matchedIds = new Set(top.map((hit) => entityKey(hit.target)));
    const sharedNameOnly = top.some((hit) => hit.via === "name" && ambiguousSet.has(fold(hit.target.name))) &&
      !top.some((hit) => hit.via === "label");
    if (matchedIds.size === 1 && !sharedNameOnly) {
      spans.push({ start: at, end: at + 1 + consumed, entity: { ...top[0]!.target.entity } });
    }
    at += consumed;
  }
  return spans;
}

/* ────────────────────────────────────────────────────────────────────────────────────────
 * THE WIRE'S MENTION LIST, for clients without a mention picker: the CLI and both MCP servers.
 * Tags in the body plus explicit selectors (a name or an id), read against one roster, in
 * order, without duplicates. Anything it cannot honour refuses the send with a sentence; it
 * never drops a name in silence.
 * ──────────────────────────────────────────────────────────────────────────────────────── */

/** One roster row, as the members read returns it. People are `user` on the wire. */
export interface MentionRosterEntry {
  kind: "user" | "agent";
  id: string;
  name: string | null;
}

/** One entry of post_signal's `mentions`. */
export interface WireMention {
  kind: "user" | "agent";
  id: string;
}

export type MentionRefusal =
  | "mention_ambiguous"
  | "mention_unknown"
  | "mention_overflow"
  | "mention_addressed"
  | "mention_private_reply"
  | "mention_ask_chain";

/**
 * Fixed sentences for the MCP surfaces, which show a model no producer prose. The CLI prints the
 * error's own message, which names the ids to use.
 */
export const MENTION_REFUSAL_SENTENCES: Readonly<Record<MentionRefusal, string>> = {
  mention_ambiguous: "A mention names more than one person or agent here, so it mentions nobody. Call members and mention them by id.",
  mention_unknown: "A mention names nobody in this workspace. Call members for names and ids.",
  mention_overflow: `A message mentions at most ${MENTION_MAX_RECIPIENTS} people or agents.`,
  mention_addressed: "Mentions go on a message everyone in the channel can read, so they can't be combined with recipients.",
  mention_private_reply: "That message was addressed, so the reply goes privately to its author and can't mention anyone. Leave out mentions.",
  mention_ask_chain: "An ask with a parent continues a private ask chain, so it can't mention anyone. Leave out the parent or the mentions.",
};

export class MentionResolutionError extends Error {
  readonly code: MentionRefusal;
  constructor(code: MentionRefusal, message: string = MENTION_REFUSAL_SENTENCES[code]) {
    super(message);
    this.name = "MentionResolutionError";
    this.code = code;
  }
}

const MENTION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function shownName(row: MentionRosterEntry): string {
  const name = (row.name ?? "").trim();
  return name === "" ? row.id : name;
}

/** Roster rows as tag targets. No labels: a shared name is mentioned by id instead. */
export function mentionTargetsFromRoster(roster: readonly MentionRosterEntry[]): MentionTarget[] {
  return roster
    .filter((row) => isTaggable(row.name ?? ""))
    .map((row) => ({
      entity: { kind: row.kind === "agent" ? "agent" as const : "person" as const, id: row.id },
      name: row.name ?? "",
    }));
}

function choicesFor(rows: readonly MentionRosterEntry[]): string {
  return rows.map((row) => `${row.kind} ${row.id}`).join(", ");
}

function resolveSelector(selector: string, roster: readonly MentionRosterEntry[]): MentionRosterEntry {
  const raw = selector.trim().replace(/^@/u, "").trim();
  if (MENTION_UUID_RE.test(raw)) {
    const id = raw.toLowerCase();
    const rows = roster.filter((row) => row.id.toLowerCase() === id);
    if (rows.length === 1) return rows[0]!;
    if (rows.length > 1) {
      throw new MentionResolutionError("mention_ambiguous", `${raw} is both a member and an agent here, so it can't be mentioned.`);
    }
    throw new MentionResolutionError("mention_unknown", `${raw} is not a member or agent of this workspace, so it can't be mentioned.`);
  }
  const folded = foldMentionName(raw);
  const rows = raw === "" ? [] : roster.filter((row) => foldMentionName(row.name ?? "") === folded);
  if (rows.length === 1) return rows[0]!;
  if (rows.length > 1) {
    throw new MentionResolutionError(
      "mention_ambiguous",
      `"${raw}" names more than one person or agent here. Mention one of them by id: ${choicesFor(rows)}.`,
    );
  }
  throw new MentionResolutionError(
    "mention_unknown",
    `"${raw}" is not the name of a member or agent of this workspace, so it can't be mentioned.`,
  );
}

/**
 * The `mentions` list for a public message: the body's tags first, then each explicit selector,
 * deduplicated in that order. Throws MentionResolutionError when a tag names two entries, a
 * selector matches nobody or several, or the list would pass MENTION_MAX_RECIPIENTS.
 */
export function resolveMentions(input: {
  body: string;
  selectors?: readonly string[];
  roster: readonly MentionRosterEntry[];
}): WireMention[] {
  const parsed = addressFromBody(input.body, mentionTargetsFromRoster(input.roster));
  if (parsed.ambiguous.length > 0) {
    const sentences = parsed.ambiguous.map((name) => {
      const rows = input.roster.filter((row) => foldMentionName(row.name ?? "") === foldMentionName(name));
      return `"@${name}" names more than one person or agent here, so it mentions nobody. Mention one of them by id: ${
        choicesFor(rows)
      }.`;
    });
    throw new MentionResolutionError("mention_ambiguous", sentences.join(" "));
  }
  const ordered: MentionRosterEntry[] = [];
  const seen = new Set<string>();
  const add = (row: MentionRosterEntry) => {
    const key = `${row.kind}:${row.id.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    ordered.push(row);
  };
  for (const entity of parsed.recipients) {
    const kind = entity.kind === "agent" ? "agent" : "user";
    const row = input.roster.find((candidate) => candidate.kind === kind && candidate.id === entity.id);
    if (row !== undefined) add(row);
  }
  const overflowNames = [...parsed.overflow];
  for (const selector of input.selectors ?? []) add(resolveSelector(selector, input.roster));
  if (overflowNames.length > 0 || ordered.length > MENTION_MAX_RECIPIENTS) {
    const extra = [...ordered.slice(MENTION_MAX_RECIPIENTS).map(shownName), ...overflowNames];
    const unique = [...new Set(extra)];
    throw new MentionResolutionError(
      "mention_overflow",
      `A message mentions at most ${MENTION_MAX_RECIPIENTS}, so ${joinNames(unique)} would not be mentioned. Mention fewer people or agents and send again.`,
    );
  }
  return ordered.map((row) => ({ kind: row.kind, id: row.id.toLowerCase() }));
}
