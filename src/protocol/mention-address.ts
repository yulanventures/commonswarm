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
  | "mention_ask_chain"
  | "mention_choice";

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
  mention_choice: "An ask with options or choices mentions nobody. Leave out mentions.",
};

/* ────────────────────────────────────────────────────────────────────────────────────────
 * A THREAD REPLY TELLS THE AUTHOR IT ANSWERS. A private reply always reached the author; the
 * thread reply that replaced it for public messages does so by mentioning them. The author goes
 * first, takes one of the eight places, and is never added twice. If the edge then refuses the
 * post because of that implicit mention (the author left, or agents hit the thread's hop limit),
 * the reply is sent once more without it: the reply matters more than the notification. An
 * explicit @Name or --mention is never dropped this way.
 * ──────────────────────────────────────────────────────────────────────────────────────── */

/** The mention list for a thread reply: the author first, then the explicit mentions. */
export function addReplyAuthorMention(
  mentions: readonly WireMention[],
  author: WireMention | null,
): { mentions: WireMention[]; authorAdded: boolean } {
  const list = mentions.map((row) => ({ kind: row.kind, id: row.id.toLowerCase() }));
  if (author === null) return { mentions: list, authorAdded: false };
  const id = author.id.toLowerCase();
  if (list.some((row) => row.kind === author.kind && row.id === id)) return { mentions: list, authorAdded: false };
  if (list.length >= MENTION_MAX_RECIPIENTS) {
    throw new MentionResolutionError(
      "mention_overflow",
      `A message mentions at most ${MENTION_MAX_RECIPIENTS}, and a thread reply also mentions the author it answers. Mention fewer people or agents and send again.`,
    );
  }
  return { mentions: [{ kind: author.kind, id }, ...list], authorAdded: true };
}

/** The list without the implicit author, for the second send. */
export function withoutReplyAuthor(mentions: readonly WireMention[], author: WireMention): WireMention[] {
  const id = author.id.toLowerCase();
  return mentions.filter((row) => !(row.kind === author.kind && row.id === id));
}

/**
 * True for the edge's refusals an implicit author mention can cause: the bare 403 a mention of
 * someone no longer live gets, and the agent hop limit in a thread (409 mention_hop_limit).
 */
export function replyAuthorMentionRefused(status: number, code: string | null | undefined): boolean {
  return code === "mention_hop_limit" || (status === 403 && (code === undefined || code === null || code === "forbidden"));
}

/** Why the author was not told, for the reply's output. */
export function replyAuthorNotNotified(code: string | null | undefined): string {
  return code === "mention_hop_limit"
    ? "Agents have exchanged too many messages in a row in this thread, so the reply was sent without notifying its author."
    : "The author could not be mentioned, so the reply was sent without notifying them.";
}

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/** UTF-8 bytes of a string, without TextEncoder, so the module stays import- and global-free. */
function utf8Bytes(value: string): number[] {
  const bytes: number[] = [];
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
  }
  return bytes;
}

/**
 * SHA-256 of a string's UTF-8 bytes, as 64 lowercase hex digits (FIPS 180-4). Small, pure and
 * synchronous, so the CLI, both MCP servers and the edge derive the same value with no crypto API.
 */
export function sha256Hex(value: string): string {
  const bytes = utf8Bytes(value);
  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const high = Math.floor(bitLength / 0x100000000);
  for (const word of [high, bitLength >>> 0]) bytes.push((word >>> 24) & 0xff, (word >>> 16) & 0xff, (word >>> 8) & 0xff, word & 0xff);
  const hash = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Array<number>(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      const at = offset + i * 4;
      w[i] = ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0;
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash as [number, number, number, number, number, number, number, number];
    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + s1 + ch + SHA256_K[i]! + w[i]!) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    hash[0] = (hash[0]! + a) >>> 0; hash[1] = (hash[1]! + b) >>> 0; hash[2] = (hash[2]! + c) >>> 0; hash[3] = (hash[3]! + d) >>> 0;
    hash[4] = (hash[4]! + e) >>> 0; hash[5] = (hash[5]! + f) >>> 0; hash[6] = (hash[6]! + g) >>> 0; hash[7] = (hash[7]! + h) >>> 0;
  }
  return hash.map((word) => word.toString(16).padStart(8, "0")).join("");
}

/**
 * The command id of the second send. The first was refused and may be recorded under its own id,
 * so the second needs another; derived, so a retried request takes the same two ids. Up to 65
 * characters the id gains "_noauth" (72 at most). A longer one keeps 32 characters and 128 bits of
 * the SHA-256 of the whole id ("<32>_<32 hex>_na", 68), so distinct ids get distinct retry ids.
 */
export function replyRetryCommandId(commandId: string): string {
  return commandId.length <= 65 ? `${commandId}_noauth` : `${commandId.slice(0, 32)}_${sha256Hex(commandId).slice(0, 32)}_na`;
}

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
