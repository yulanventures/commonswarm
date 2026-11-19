/**
 * Splitting the full mobile-audit matrix across parallel CI jobs.
 *
 * The full matrix (every manifest screen, six viewports, both themes) grew past the job's test budget. The workflow
 * now runs it as several jobs; each gets MOBILE_AUDIT_SHARD="k/n" and captures every n-th screen of the manifest,
 * starting at the k-th, at every size and theme. Round-robin by manifest order keeps neighbouring screens (which are
 * often the same surface in several states, and so cost about the same) spread across jobs.
 *
 * Each job seeds its own local stack, so a shard's screens never share state with another shard's.
 * The once-per-run checks (the chat picture and command palette checks) run in shard 1 only.
 */
export interface Shard { index: number; count: number }

/** "k/n" with 1 <= k <= n and n >= 2, or nothing. Anything else stops the run before it seeds. */
export function parseShard(raw: string | undefined): Shard | null {
  const value = (raw ?? "").trim();
  if (value === "") return null;
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(value);
  if (!match) throw new Error(`MOBILE_AUDIT_SHARD must be k/n, for example 2/6; got "${value}"`);
  const index = Number(match[1]) - 1, count = Number(match[2]);
  if (count < 2) throw new Error(`MOBILE_AUDIT_SHARD needs at least two shards; got "${value}"`);
  if (index >= count) throw new Error(`MOBILE_AUDIT_SHARD names shard ${index + 1} of ${count}`);
  return { index, count };
}

/** Whether this shard captures the screen. Every id is in exactly one shard; an id not in the manifest is in none. */
export function inShard(manifestIds: readonly string[], id: string, shard: Shard | null): boolean {
  if (!shard) return true;
  const position = manifestIds.indexOf(id);
  return position >= 0 && position % shard.count === shard.index;
}

/** The once-per-run checks belong to one shard, so a full run does each exactly once. */
export const ownsRunChecks = (shard: Shard | null): boolean => !shard || shard.index === 0;
