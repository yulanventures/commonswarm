/**
 * Reactions: one emoji from a person or an agent on a message. The edge, the CLI and the web app
 * read the same rule here, so what one accepts the others accept.
 */

/** Distinct emojis one reactor may add to one message. swarm.signal_reactions_bound enforces it too. */
export const SIGNAL_REACTION_MAX_PER_ACTOR = 64;
/** UTF-8 bytes in one stored emoji; the table's CHECK is the same bound. */
export const SIGNAL_REACTION_MAX_BYTES = 32;
export const SIGNAL_REACTION_SOURCES = ['manual', 'ack'] as const;
export type SignalReactionSource = (typeof SIGNAL_REACTION_SOURCES)[number];
/** The emoji an agent's client adds to a message it surfaced. */
export const SIGNAL_REACTION_SEEN = '\u{1F440}';

/** Shortcodes people already type. Each maps to the one emoji stored. */
export const SIGNAL_REACTION_SHORTCODES: Readonly<Record<string, string>> = Object.freeze({
  ':eyes:': '\u{1F440}',
  ':+1:': '\u{1F44D}',
  ':thumbsup:': '\u{1F44D}',
  ':-1:': '\u{1F44E}',
  ':thumbsdown:': '\u{1F44E}',
  ':white_check_mark:': '✅',
  ':check:': '✅',
  ':hammer_and_wrench:': '\u{1F6E0}️',
  ':wrench:': '\u{1F6E0}️',
  ':on_it:': '\u{1F6E0}️',
  ':rocket:': '\u{1F680}',
  ':heart:': '❤️',
  ':tada:': '\u{1F389}',
  ':thinking:': '\u{1F914}',
  ':fire:': '\u{1F525}',
  ':question:': '❓',
  ':100:': '\u{1F4AF}',
});

// One emoji: a flag (two regional indicators), a keycap, or a pictograph with optional variation
// selector or skin tone, joined by ZWJ to more of the same, with optional tag sequence (subdivision
// flags). Letters, digits and punctuation on their own never match.
const PICTOGRAPH = String.raw`\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})?`;
const ONE_EMOJI = new RegExp(
  String.raw`^(?:\p{Regional_Indicator}{2}|[#*0-9]️?⃣|${PICTOGRAPH}(?:‍${PICTOGRAPH})*(?:[\u{E0020}-\u{E007E}]+\u{E007F})?)$`,
  'u',
);
const encoder = new TextEncoder();

/**
 * The emoji to store for what a caller sent, or null when it is not exactly one emoji (or a known
 * shortcode). Unicode is NFC-normalized first.
 */
export function normalizeReactionEmoji(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const shortcode = Object.hasOwn(SIGNAL_REACTION_SHORTCODES, input.toLowerCase())
    ? SIGNAL_REACTION_SHORTCODES[input.toLowerCase()]!
    : null;
  const emoji = (shortcode ?? input).normalize('NFC');
  const bytes = encoder.encode(emoji).length;
  if (bytes < 1 || bytes > SIGNAL_REACTION_MAX_BYTES || !ONE_EMOJI.test(emoji)) return null;
  return emoji;
}

/** The sentence a refusal gives for an emoji this rule does not take. */
export const SIGNAL_REACTION_EMOJI_RULE =
  `emoji must be one emoji (at most ${SIGNAL_REACTION_MAX_BYTES} bytes) or one of ${Object.keys(SIGNAL_REACTION_SHORTCODES).join(' ')}`;
