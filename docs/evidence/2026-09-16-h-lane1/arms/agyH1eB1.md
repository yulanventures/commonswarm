### Review of Part B1 of 6 (Lane 1: Command Table Dispatcher)

#### Scope of Part B1
- Spec: Lane 1 section
- `src/cloud/agent-onboarding-contract.ts`
- `src/dispatch-trace.ts`
- `src/onboarding-cli.ts`
- `tests/fixtures/dispatch-trace-preload.mjs`
- `tests/p1-cli/citation-drift.test.ts`

---

### Findings

#### PRODUCTION
*None identified in Part B1.*

The handler bodies in `src/onboarding-cli.ts` are preserved verbatim from the branches of the former `runOnboardingCommand`, with no handler logic rewritten. The diagnostic channel trace in `src/dispatch-trace.ts` is a no-op when unsubscribed and does not mutate arguments or dispatch flow. Deletion of `runOnboardingCommand` and `AGENT_PROFILE_COMMANDS` from their previous locations complies directly with the spec requirements. The update to `AGENT_QUICK_GUIDE` in `src/cloud/agent-onboarding-contract.ts` conforms to the Strategist's ruling pinning explicit `cswarm` prefixes.

---

#### RIGOUR

##### 1. Dependency on Flag Precedence in `AGENT_COMMANDS["check"].select` (`src/cli.ts`)
- **Diff Hunk**: `src/onboarding-cli.ts:133-146` (`runCheckHook` and `runCheckMessage`)
- **Analysis**: In the original `runOnboardingCommand`:
  ```ts
  if (args.has("hook")) {
    if (args.has("full") || args.has("message-id") || args.has("json"))
      throw new AgentSetupError("hook_options_invalid", ...);
    await runTurnHook(args);
  } else if (args.has("message-id")) {
    if (args.has("full")) throw new AgentSetupError("check_options_invalid", ...);
    ...
  }
  ```
  `runCheckHook` enforces that `--message-id` cannot be combined with `--hook` (throwing `hook_options_invalid`). However, `runCheckMessage` only checks `args.has("full")` and does not check `args.has("hook")`. 
  Therefore, behavior preservation for conflicting input:
  ```sh
  cswarm check --profile <path> --hook --message-id <uuid>
  ```
  strictly depends on `select(args)` in `src/cli.ts` evaluating `args.has("hook")` prior to `args.has("message-id")`. If `select(args)` checks `--message-id` first, `runCheckMessage` would execute rather than throwing `hook_options_invalid`.
- **Status**: Must be verified in Part B2 (`src/cli.ts`).

##### 2. Dependencies Outside Part B1 Not Yet Inlined
Per the instructions, the following files are not inlined in Part B1 and cannot be evaluated in this call:
- `src/cli.ts`: Dispatch loop, `AGENT_COMMANDS` table, own-property lookup protection, `applyProfilePolicy`, and derivation of `AGENT_PROFILE_COMMANDS`.
- Gate implementations and test suites (Parts B3–B6): The variant-level help gate, baseline test runner, and diff-check gate.

---

VERDICT: PASS Part B1 handler extraction, tracing instrument, and contract updates preserve behavior; verified dependencies must be checked in subsequent parts.
