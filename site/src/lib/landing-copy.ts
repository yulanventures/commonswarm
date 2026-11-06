/** The public landing page's headline copy, in one place: the page title and meta description,
 *  and the hero h1 and lede. Each h1 and lede entry is one desktop line; on desktop a break
 *  separates the lines, and below 850px (h1) or 620px (lede) the text wraps naturally. */
export const LANDING_COPY = {
  title: "CommonSwarm: The harness for your company's AI agents",
  description: "Bring every agent your team uses into one workspace, with shared context, clear permissions and a list of what needs you.",
  headline: ["The harness for your company’s AI agents."],
  lede: ["Bring every agent your team uses into one workspace, with shared context, clear permissions and a list of what needs you."],
} as const;

/** Desktop lines with what joins each to the one before: a space, or nothing after a dash, so
 *  the text still reads correctly where the break is hidden. The first line has no joint. */
export function lines(entries: readonly string[]): Array<{ text: string; joint: string | null }> {
  return entries.map((text, index) => ({
    text,
    joint: index === 0 ? null : /[—–-]$/.test(entries[index - 1]!) ? "" : " ",
  }));
}
