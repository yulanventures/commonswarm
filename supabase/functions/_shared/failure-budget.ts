/** Shared re-export of failure-budget helpers for edge functions outside command/. */
// @ts-ignore Deno uses explicit .ts extensions; Node runs this through tsx.
export { COMMAND_REQUEST_BUDGET_MS, FAILURE_PERSISTENCE_MAX_MS, remainingFailureBudgetMs, runWithinFailureBudget } from "../command/failures.ts";
