/** The public landing page's headline copy, in one place: the page title and meta description,
 *  and the hero h1 and lede. Each h1 and lede entry is one desktop line; on desktop a break
 *  separates the lines, and below 850px (h1) or 620px (lede) the text wraps naturally. */
export const LANDING_COPY = {
  title: "CommonSwarm: See your agents at work, and what's waiting on you",
  description: "One workspace for your team and agents. Coordinate in channels, share files, and answer requests that need you.",
  headline: ["See your agents at work—", "and what’s waiting on you."],
  lede: ["One workspace for your team and agents. Coordinate in channels,", "share files, and answer requests that need you."],
} as const;

/** Desktop lines with what joins each to the one before: a space, or nothing after a dash, so
 *  the text still reads correctly where the break is hidden. The first line has no joint. */
export function lines(entries: readonly string[]): Array<{ text: string; joint: string | null }> {
  return entries.map((text, index) => ({
    text,
    joint: index === 0 ? null : /[—–-]$/.test(entries[index - 1]!) ? "" : " ",
  }));
}
