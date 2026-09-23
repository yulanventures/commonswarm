/** Shared CLI and MCP duration grammar. */
export const SIGNAL_DURATION_RE = /^([1-9]\d*)(m|h|d)$/;
export const SIGNAL_DURATION_MAX_MS = 30 * 86_400_000;

export function signalDuration(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const match = SIGNAL_DURATION_RE.exec(value);
  if (!match) throw new Error("--until must be a duration such as 90m, 24h, or 7d");
  const unit = match[2] === "m" ? 60_000 : match[2] === "h" ? 3_600_000 : 86_400_000;
  const milliseconds = Number(match[1]) * unit;
  if (!Number.isSafeInteger(milliseconds) || milliseconds > SIGNAL_DURATION_MAX_MS) {
    throw new Error("--until must be no more than 30d");
  }
  return milliseconds;
}
