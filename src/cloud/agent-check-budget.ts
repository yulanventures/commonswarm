/** Claude Code host-hook timeout, in the seconds written to host settings. */
export const HOST_HOOK_TIMEOUT_SECONDS = 5;

/**
 * Built 0.1.71 CLI, 20 fresh processes, instant fake fetch, 2026-09-16:
 * process spawn to the check deadline starting was p95 90 ms. Rounded up.
 */
export const AGENT_CHECK_STARTUP_ALLOWANCE_MS = 100;

/**
 * The same local measurement: check deadline ending to process exit was p95 3 ms.
 * Rounded up so host-side collection of the command result stays inside the ceiling.
 */
export const AGENT_CHECK_OUTPUT_ALLOWANCE_MS = 10;

/** 5,000 ms host ceiling - 100 ms start-up - 10 ms output = 4,890 ms. */
export const AGENT_CHECK_TIMEOUT_MS =
  HOST_HOOK_TIMEOUT_SECONDS * 1_000 -
  AGENT_CHECK_STARTUP_ALLOWANCE_MS -
  AGENT_CHECK_OUTPUT_ALLOWANCE_MS;
