`, `channel.archive`, `channel.refusal`
- `file.put`, `file.ls`, `file.get`, `file.rm`, `file.restore`, `file.refusal`
- `brain.ls`, `brain.get`, `brain.put`, `brain.refusal`
- `members`
- `working-on`
- `note`
- `ask`
- `reply`
- `receipt`
- `feed`
- `inbox.default`

Wait! For all of these commands:
They accept `--profile`!
And `hostSessionFixtures` tests whether `--host-session-id fixture-host` is kept or dropped!
And `policy.host-session.${entry.key}.${entry.hostSessionId}` has 84 rows!

WAIT!
Let's check:
How does the baseline test verify whether `--host-session-id` was kept or dropped?
Wait! In `policy.host-session.${entry.key}.${entry.hostSessionId}`:
Does `policy.host-session...` verify the exitCode, stdout, and stderr?
Wait! When `session.start` or `working-on` or `whoami` runs:
Does `--host-session-id` appear in stdout or stderr or in the dispatched handler call?
Wait! Look at `dispatch-trace-preload.mjs`:
In `runFixture`:
```ts
    child.on("message", message => {
      if (message && typeof message === "object" &&
          (message as { type?: unknown }).type === "commonswarm-dispatch" &&
          typeof (message as { handler?: unknown }).handler === "string") {
        handlers.push((message as { handler: string }).handler);
      }
    });
```
And `BaselineRow` records:
`handlers`: string[]
`exitCode`: number
`stdout`: string
`stderr`: string
If `--host-session-id` is kept or dropped:
For `session.start` or `listen.start`, `--host-session-id` is used to configure the session/listener state or name!
If it is dropped, it uses default host session id or omits it.
For `whoami` or `working-on`, if dropped, it's not in the request!

WAIT!
Let's check:
What if someone changes `hostSessionId: "keep"` to `"drop"` on `listen.start`?
`listen.start` would drop `--host-session-id fixture-host`!
Then stdout / stderr / handlers in `policy.host-session.listen.start.keep` would change from the recorded baseline!
So `assert.deepEqual(rows, expected)` would fail!

WAIT!
Look at CONTROLS.md (described in prompt):
"- commit 4: the allowlist pins the own-property line; CONTROLS.md records the mutation (restoring the inherited lookup fails the allowlist and 360 baseline rows; token, invite, member, grant and workspace map unknown actions to a real sub-action, so their 180 rows do not fail)."

WAIT!
Let's check if there are any dependencies that we cannot check:
"PART B2 OF 6: the baseline test. The other parts of this lane are separate calls; do not fail this part for their absence, but name any dependency you cannot check."
Dependencies in this part:
1. `tests/p1-cli/fixtures/command-dispatch-baseline.json` (the 1248-row baseline fixture file itself, not inlined, though summary is provided).
2. `tests/p1-cli/fixtures/command-dispatch-baseline-counts.json` (baseline counts file, not inlined).
3. `tests/fixtures/dispatch-trace-preload.mjs` (the preload script that posts `commonswarm-dispatch` IPC messages).
4. `src/cli.ts` (the implementation of the dispatcher, reviewed in other parts).
5. `DECLARED-CHANGES.md` and `CONTROLS.md` (documentation files in other parts).

Wait! Let's check:
Is there ANY bug or flaw in `command-dispatch-baseline.test.ts`?
Let's look at lines 500-515 in `runFixture`:
```ts
    child.stderr!.on("data", chunk => {
      stderr += String(chunk);
      if (!(fixture.id === "login" || fixture.id.startsWith("accept.link-")) || loginCallbackSent) return;
      for (const line of stderr.split("\n")) {
        try {
          const authorization = new URL(line.trim());
          const redirectValue = authorization.searchParams.get("redirect_to");
          if (redirectValue === null) continue;
          const callback = new URL(redirectValue);
          callback.searchParams.set("code", "fixture-code");
          loginCallbackSent = true;
          void fetch(callback).catch(rejectRun);
          break;
        } catch {
          // The surrounding stderr lines are narration, not URLs.
        }
      }
    });
```
Wait! Look at `line.trim()`:
If a line in stderr is `http://127.0.0.1:.../authorize?redirect_to=http%3A%2F%2F127.0.0.1%3A...`:
`const authorization = new URL(line.trim());`
`authorization.searchParams.get("redirect_to")` returns the redirect URL string!
`const callback = new URL(redirectValue);`
`callback.searchParams.set("code", "fixture-code");`
`loginCallbackSent = true;`
`void fetch(callback).catch(rejectRun);`
This works cleanly to complete the OAuth loopback flow!

WAIT!
Look at line 740:
```ts
test("the command dispatcher matches the recorded behavior baseline", { timeout: 600_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-dispatch-baseline-"));
```
Wait! Is `root` cleaned up after the test?
Notice: `root` is created with `mkdtemp(join(tmpdir(), ...))` in the test.
There is a `try ... finally { server.close(...) }`.
`root` is in `tmpdir()`, so OS cleans it up eventually, but `rm(root, { recursive: true, force: true })` is not in finally.
That is a standard minor cleanliness detail in tests, not a failure.

WAIT!
Let's check line 465:
```ts
function normalize(value: string, root: string, origin: string): string {
  return value
    .replaceAll(root, "<ROOT>")
    .replaceAll(origin, "<ORIGIN>")
    .replaceAll(repoRoot, "<REPO>")
    .replace(/credentials\.d\/[a-f0-9]{24}/g, "credentials.d/<PROFILE_ID>")
    .replace(/<ORIGIN>\/auth\/v1\/authorize\?[^\n]+/g, "<AUTHORIZATION_URL>")
    .replace("If the browser cannot reach the loopback callback, paste the complete callback URL here:\n", "")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<TIMESTAMP>")
    .replace(/coverage-[0-9-]+\.json/g, "coverage-<ID>.json");
}
```
Wait! Look at line 464:
`.replace(/<ORIGIN>\/auth\/v1\/authorize\?[^\n]+/g, "<AUTHORIZATION_URL>")`
Notice: line 461 replaced `origin` with `<ORIGIN>`.
Then line 464 replaces `<ORIGIN>/auth/v1/authorize?...` with `<AUTHORIZATION_URL>`!
That's why `<ORIGIN>` was used in the regex in line 464!
And line 465:
`.replace("If the browser cannot reach the loopback callback, paste the complete callback URL here:\n", "")`
removes the prompt text that accompanied the authorization URL.
And line 466:
`.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<TIMESTAMP>")`
replaces timestamps.

WAIT!
Look at line 466:
What about timestamps with different formats?
ISO 8601 in Node is `2026-09-16T21:53:40.000Z` (4 digits - 2 digits - 2 digits T 2 digits : 2 digits : 2 digits . 3 digits Z).
That regex matches `\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z`. Exactly standard ISO string format.

WAIT!
What about line 467:
`.replace(/coverage-[0-9-]+\.json/g, "coverage-<ID>.json")`
For coverage files.

WAIT!
Let's check:
Is there ANY case where `normalize` hides a real behavioral difference?
Could `normalize` hide something that would differ between main and the lane?
- `<ROOT>`: replaces temp root path.
- `<ORIGIN>`: replaces mock server origin (http://127.0.0.1:port).
- `<REPO>`: replaces repo root path.
- `credentials.d/<PROFILE_ID>`: replaces randomized profile ID.
- `<AUTHORIZATION_URL>`: replaces loopback callback port / state in auth URL.
- browser instruction string removal.
- `<TIMESTAMP>`: replaces ISO timestamp.
- coverage ID.
None of these hide dispatch behavior! They only normalize non-deterministic runtime values (ephemeral ports, timestamps, temp paths, UUIDs).

WAIT!
Let's check `commandEntryCoverage()`:
```ts
function canonicalFixtureId(key: string): string {
  if (key.endsWith(".refusal")) {
    const groupName = key.slice(0, -".refusal".length);
    assert.ok(GROUP_NAMES.has(groupName), `no refusal fixture group for ${key}`);
    return `refusal.group.${groupName}.missing.plain`;
  }
  const overrides: Record<string, string> = {
    setup: "setup.import",
    check: "check.default",
    "__listen-supervisor": "internal.listen-supervisor",
    logout: "logout.local",
    resume: "resume.profile",
    inbox: "inbox.default",
    new: "new.positional",
    accept: "accept.link-positional",
    "token.revoke": "token.revoke-human",
    command: "command.create",
  };
  return overrides[key] ?? key;
}
```
Wait! Look at `overrides`:
`"token.revoke": "token.revoke-human"`
Wait! Where does `"token.revoke"` come from?
In `LEGACY_COMMAND_ENTRY_COVERAGE`:
`...["mint", "revoke", "refusal"].map(key => ({ key: `token.${key}`, ... }))`
The key is `token.revoke`!
And in `coreFixtures`:
`{ id
### Independent INVERSION Review — Lane 1 (Round 6)
**Scope:** PART B2 OF 6: The baseline test (`tests/p1-cli/command-dispatch-baseline.test.ts`)

---

### External Dependencies Not Inlined
The following files are referenced by the baseline test harness but not inlined in this call:
1. `tests/p1-cli/fixtures/command-dispatch-baseline.json` (1248 recorded baseline rows).
2. `tests/p1-cli/fixtures/command-dispatch-baseline-counts.json` (total / exit 0 / non-zero count verification).
3. `tests/fixtures/dispatch-trace-preload.mjs` (IPC handler instrumentation).
4. `src/cli.ts` and `src/onboarding-cli.ts` (command table and check-budget hard exit / deadline implementations, reviewed in companion parts).

---

### Findings

#### [RIGOUR] 1. Permissive Table Export Fallback Bypasses Table Drift Assertion
- **Diff Hunk:** `tests/p1-cli/command-dispatch-baseline.test.ts:107-108`
  ```ts
  if (cli.AGENT_COMMANDS === undefined) return ordered(LEGACY_COMMAND_ENTRY_COVERAGE);
  ```
- **Analysis:** This guard was added so commit 1 could run against `main` before `AGENT_COMMANDS` was introduced. However, retaining this unconditional fallback across commits 2–5 means that if a future edit fails to export `AGENT_COMMANDS`, typos the export name, or breaks module-level evaluation of `AGENT_COMMANDS`, `commandEntryCoverage()` silently falls back to returning the hardcoded `LEGACY_COMMAND_ENTRY_COVERAGE`. The drift assertion (`assert.deepEqual(actual, ordered(LEGACY_COMMAND_ENTRY_COVERAGE))`) is skipped completely instead of failing. Once commit 2 lands, the gate should assert `assert.ok(cli.AGENT_COMMANDS, "AGENT_COMMANDS must be exported")`.

#### [RIGOUR] 2. Host-Session Policy Ineffective for `profile: "refuse"` Entries
- **Diff Hunk:** `tests/p1-cli/command-dispatch-baseline.test.ts:346-350`
  ```ts
  return {
    id: `policy.host-session.${entry.key}.${entry.hostSessionId}`,
    argv: [...argv, "--profile", "<PROFILE>", "--host-session-id", "fixture-host"],
  ```
- **Analysis:** `hostSessionFixtures()` generates test fixtures for all 84 command entries by appending both `--profile <PROFILE>` and `--host-session-id fixture-host`. For all 48 entries whose profile policy is `"refuse"`, execution aborts immediately at profile rejection before the CLI ever examines or dispatches `--host-session-id`. While this faithfully mirrors the legacy dispatcher (where profile expansion was the only site stripping `--host-session-id`), it means `policy.host-session.*.drop` rows for `profile: "refuse"` commands only test profile refusal, not `--host-session-id` handling.

#### [RIGOUR] 3. Duplicate Fixture IDs for Identical Hook Invocations
- **Diff Hunk:** `tests/p1-cli/command-dispatch-baseline.test.ts:234, 264`
  ```ts
  234: { id: "refusal.hook-check-extra", argv: ["hook", "check", "extra"], input: "{}" },
  ...
  264: { id: "hook.check-extra-positional", argv: ["hook", "check", "extra"], input: "{}" },
  ```
- **Analysis:** Two fixtures with distinct IDs (`refusal.hook-check-extra` and `hook.check-extra-positional`) execute identical commands (`hook check extra` with input `{}`). While harmless to test execution, this introduces unnecessary redundancy in the baseline fixture count.

---

### Verification Summary
- **Prototype Sub-Action Coverage:** All 15 closed groups (`GROUP_REFUSAL_SITES`) are systematically tested across all `Object.prototype` properties over 3 axes (plain, json, valid-profile) totaling 540 rows.
- **Declared Diffs:** The 36 `channel <prototype>` rows (reconciled to standard channel refusal) and the 3 file terminator rows (`file {get,rm,restore} -- --json`) are accounted for in the baseline structure and match commit 2/3 declarations.
- **Check-Budget Alignment:** Rebase differences from the main check-budget lane ("3.9s ceiling" usage string across 301 rows) are properly accommodated without altering dispatch semantics.

VERDICT: PASS
The baseline harness comprehensively captures the legacy dispatcher matrix, accounts for prototype isolation across all closed groups, and verifies behaviour preservation with no production dispatch divergence.
