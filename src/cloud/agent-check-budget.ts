/** Claude Code host-hook timeout, in the seconds written to host settings. */
export const HOST_HOOK_TIMEOUT_SECONDS = 5;

/**
 * Process spawn to the check deadline starting. Measured 2026-09-16 on the built 0.1.71 CLI, 20 fresh
 * processes, instant fake fetch, idle host: p95 90 ms. The allowance is sized for a LOADED host instead,
 * because a host kill is silent while our own check_timeout is reported: the same day, on the operator's
 * mini under agent load, the hook hard-deadline test ran 1.15-1.4 s longer than it did alone.
 */
export const AGENT_CHECK_STARTUP_ALLOWANCE_MS = 1_000;

/**
 * Check deadline ending to process exit. Measured p95 3 ms on the idle host; sized with the same load
 * margin so host-side collection of the command result stays inside the ceiling.
 */
export const AGENT_CHECK_OUTPUT_ALLOWANCE_MS = 100;

/**
 * 5,000 ms host ceiling - 1,000 ms start-up - 100 ms output = 3,900 ms. Against the Supabase path on
 * 2026-09-16 (whole check p95 1.03 s, network span p95 1.10 s) that is about 3.5x headroom.
 */
export const AGENT_CHECK_TIMEOUT_MS =
  HOST_HOOK_TIMEOUT_SECONDS * 1_000 -
  AGENT_CHECK_STARTUP_ALLOWANCE_MS -
  AGENT_CHECK_OUTPUT_ALLOWANCE_MS;

/** Absolute process-age deadline for a host hook, leaving time to collect stdout. */
export const HOST_HOOK_PROCESS_DEADLINE_MS =
  HOST_HOOK_TIMEOUT_SECONDS * 1_000 - AGENT_CHECK_OUTPUT_ALLOWANCE_MS;

/** Delay until an absolute deadline measured from process start, never handler start. */
export function processDeadlineDelayMs(
  deadlineMs: number,
  processAgeMs = process.uptime() * 1_000,
): number {
  return Math.max(0, Math.ceil(deadlineMs - processAgeMs));
}
