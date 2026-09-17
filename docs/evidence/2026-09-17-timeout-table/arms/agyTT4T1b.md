Client start-up (\`--version\`): ${startup ? `p50 ${formatMs(startup.p50)} ms; p95 ${formatMs(startup.p95)} ms; max ${formatMs(startup.max)} ms` : "not run"}.`,
    "",
    "| Constant id | Line | Budget | Scope | Endpoint(s) | Operation | Class | Runs | p50 | p95 | Max | Headroom | Gate | Real-client exits / timeouts |",
    "|---|---|---:|---|---|---|---|---:|---:|---:|---:|---:|---|---:|",
  ];
  for (const row of inventory) {
    const map = mapping.rows[row.id];
    const measured = measurementFor(map, measurements);
    const stats = rowSummary(row, map, measured);
    const budget = row.unit_note.startsWith("non-time") ? `${row.value_ms} raw` : `${row.value_ms} ms`;
    const exits = measured?.realExitCodes
      ? `${JSON.stringify(measured.realExitCodes)} / ${measured.realTimeouts}`
      : "—";
    const operation = map.operation.proxy_operation
      ? `${map.operation.name} (proxy: ${map.operation.proxy_operation})`
      : map.operation.name;
    const shownClass = map.class === "network-api" ? map.operation.class : map.class;
    lines.push(`| ${escapeCell(row.id)} | ${row.line ?? "—"} | ${budget} | ${map.scope} | ${escapeCell(map.endpoints.join(", ") || "—")} | ${escapeCell(operation)} | ${escapeCell(shownClass)} | ${stats.runs} | ${formatMs(stats.p50)} | ${formatMs(stats.p95)} | ${formatMs(stats.max)} | ${formatHeadroom(stats.headroom)} | ${stats.gate} | ${escapeCell(exits)} |`);
  }
  return `${lines.join("\n")}\n`;
}
```

Now look at `runTable`:
```javascript
export async function runTable(options) {
  const repo = resolve(join(here, "../.."));
  const mappingFile = JSON.parse(await readFile(options.mapping, "utf8"));
  const inventory = enumerateRepository({ repo, ref: options.ref });
  validateMapping(inventory, mappingFile, options.ref);
  const mapping = mappingForRef(mappingFile, options.ref);
  const resources = { repo, tempRoot: null, worktreePath: null };
  const uninstallSignals = installRunResourceCleanup(resources);
  try {
    const tempRoot = await mkdtemp(join(tmpdir(), "cswarm-timeout-run-"));
    resources.tempRoot = tempRoot;
    await chmod(tempRoot, 0o700);
    const log = join(tempRoot, "fetch.jsonl");
    await writeFile(log, "", { mode: 0o600 });
    const copy = await makePrivateProfileCopy(options.profile, { tempParent: tempRoot });
    const source = await sourceRootForRef(repo, options.ref, tempRoot, resources);
    const measurements = new Map();
    const operations = new Map();
    for (const row of inventory) {
      const map = mapping.rows[row.id];
      if (!map) throw new Error(`mapping lacks ${row.id}`);
      if (map.operation.class === "safe-read") {
        const previous = operations.get(map.operation.name);
        if (previous && previous.scope !== map.scope) {
          throw new Error(
            `operation ${map.operation.name} has mixed scopes ${previous.scope} and ${map.scope}`,
          );
        }
        operations.set(map.operation.name, {
          endpoints: [...new Set([...(previous?.endpoints ?? []), ...map.endpoints])],
          scope: map.scope,
        });
      }
    }
    const startupValues = [];
    if (options.client) {
      for (let index = 0; index < options.runs; index += 1) {
        const invocation = clientInvocation(options.client, ["--version"]);
        const result = await runChild(invocation.command, invocation.args, { env: process.env });
        if (result.code === 0) startupValues.push(result.durationMs);
        if (index + 1 < options.runs && options.pauseMs) await pause(options.pauseMs);
      }
    }
    for (const [name, operation] of operations) {
      const durations = [];
      let realTimeouts = 0;
      const realExitCodes = {};
      if (!options.client && name !== "auth-settings" && name !== "check" && name !== "signal-read") {
        measurements.set(name, { durations, realTimeouts, realExitCodes: null, attempted: false });
        continue;
      }
      for (let index = 0; index < options.runs; index += 1) {
        const before = (await readJsonLines(log)).length;
        let result;
        if (name === "check") {
          // Uncapped source check first so the p95 sample is not the request
          // that the real client just warmed on this iteration.
          result = await oneOperation("check-uncapped", options, copy, log, source.root);
          if (result.code !== 0) throw measurementChildError(name, result);
          if (options.client) {
            const real = await oneOperation("check", { ...options, capture: true }, copy, log, source.root);
            realExitCodes[real.code] = (realExitCodes[real.code] ?? 0) + 1;
            if (`${real.stdout}\n${real.stderr}`.includes("check_timeout")) realTimeouts += 1;
          }
        } else {
          result = await oneOperation(name, options, copy, log, source.root);
          if (result.code !== 0) throw measurementChildError(name, result);
        }
        const fresh = (await readJsonLines(log)).slice(before);
        assertNoOriginWrites(fresh, name);
        const requests = operationEndpointRows(fresh, operation.endpoints);
        if (name === "check" || name === "signal-read") {
          let reported;
          try { reported = JSON.parse(result.stdout); }
          catch { throw new Error(`${name} did not report its wall time`); }
          if (!Number.isFinite(reported.duration_ms)) throw new Error(`${name} wall time is invalid`);
          durations.push(reported.duration_ms);
        } else if (operation.scope === "whole-operation") {
          durations.push(result.durationMs);
        } else if (requests.length > 0) {
          durations.push(Math.max(...requests.map(row => row.duration_ms)));
        }
        if (index + 1 < options.runs && options.pauseMs) await pause(options.pauseMs);
      }
      measurements.set(name, {
        durations, realTimeouts,
        realExitCodes: name === "check" && options.client ? realExitCodes : null,
        attempted: true,
      });
    }
    const startup = startupValues.length === 0 ? null : {
      p50: percentile(startupValues, .5), p95: percentile(startupValues, .95), max: Math.max(...startupValues),
    };
    const report = markdownReport({
      baseUrl: options.baseUrl, inventory, mapping, measurements, startup,
      ref: options.ref, client: options.client,
    });
    if (options.output) await writeFile(options.output, report, { mode: 0o600 });
    else process.stdout.write(report);
    const status = runStatus(inventory, mapping, measurements, options.acknowledgeNotMeasured ?? []);
    if (status.fails.length || status.missing.length || status.extra.length) {
      const parts = [];
      if (status.fails.length) parts.push(`FAIL rows: ${status.fails.join(", ")}`);
      if (status.missing.length) {
        parts.push(`NOT MEASURED without --acknowledge-not-measured: ${status.missing.join(", ")}`);
      }
      if (status.extra.length) {
        parts.push(`acknowledgement is not a NOT MEASURED row: ${status.extra.join(", ")}`);
      }
      throw new Error(parts.join("; "));
    }
    return { report, inventory, measurements, startup, status };
  } finally {
    finalizeRunResources(resources, uninstallSignals);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { await runTable(argsOf(process.argv.slice(2))); }
  catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
```

Now look at `source-check.ts`:
```typescript
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const [sourceRoot, profilePath, timeoutText] = process.argv.slice(2);
if (!sourceRoot || !profilePath || !timeoutText) throw new Error("source-check needs source root, profile, and timeout");
const moduleUrl = pathToFileURL(resolve(sourceRoot, "src/cloud/agent-check.ts")).href;
const { checkAgentMessages } = await import(moduleUrl) as typeof import("../../src/cloud/agent-check.js");
const started = performance.now();
await checkAgentMessages({
  profilePath,
  timeoutMs: Number(timeoutText),
  present: async () => {},
});
process.stdout.write(`${JSON.stringify({ duration_ms: performance.now() - started })}\n`);
```

Wait! Let's carefully analyze the 4 review points from the prompt:
"REVIEW, PRODUCTION first:
 1. Can the table say PASS while a real client would time out: a timeout site not found or not mapped, a budget value read wrong (units, a derived constant, an import alias), an operation that does not exercise the path the timeout guards, the wrong percentile or sample, warm-cache or connection-reuse bias, a ref measured with the other ref's mapping?
 2. Credentials: can the copied profile or credential leak (file modes, a directory left behind on any exit path, logs, argv visible in ps, the rendered table), and can a measured operation WRITE to a real workspace?
 3. Can each test fail for the reason it claims (the exit-path cleanup, the line-shift ids, the per-ref mapping)?
 4. Anything else wrong with commits vs tree, docs vs code.
For each finding give file:line, the concrete sequence, and what an operator or production sees. Label PRODUCTION or RIGOUR. End with exactly one line "VERDICT: PASS"
### Dependencies Outside Part T1b
The following dependencies are implemented in other parts and cannot be directly inspected here:
- `scripts/timeout-table/core.mjs` (`summarize`, `makePrivateProfileCopy`, `readJsonLines`, `runChild`, `percentile`, `clientInvocation`)
- `scripts/timeout-table/enumerate.mjs` (`enumerateRepository`)
- `scripts/timeout-table/mapping.mjs` (`mappingForRef`, `validateMapping`)
- `scripts/timeout-table/writes.cjs` (`originWriteKind`, `describeOriginWriteRules`)

---

### Analysis

#### 1. Production / Measurement Integrity
- **Check Budget & Uncapped Measurement**: In `run.mjs:316-324`, `name === "check"` runs `check-uncapped` (invoking `source-check.ts` on `source.root` with `options.sourceTimeoutMs`, default 120 s) prior to testing the real client invocation. This measures the unconstrained latency of `checkAgentMessages` while still tracking real client timeout exits via `realExitCodes` and `realTimeouts`.
- **Cache Bias Prevention**: Executing `check-uncapped` before the real client ensures the uncapped sample is not artificially warmed by the real client invocation within that iteration. Pauses (`pauseMs`) occur between successive iterations.
- **Per-Ref Isolation**: In `run.mjs:269-278`, `options.ref` is explicitly propagated to `enumerateRepository`, `validateMapping`, `mappingForRef`, and `sourceRootForRef`. Source-level checks and worktrees are isolated to the exact ref requested.
- **Fail Gate on Incomplete Paths**: In `runStatus` (`run.mjs:211-224`), a row with `stats.gate === "FAIL"` is strictly added to `fails`. An acknowledgment in `acknowledgeNotMeasured` does not suppress the failure because `status.fails.length` throws unconditionally in `run.mjs:355`.

#### 2. Credentials and Workspace Isolation
- **File Modes & Temp Root**: `tempRoot` is created via `mkdtemp` and secured with `chmod 0o700` (`run.mjs:273`). The log file `fetch.jsonl` and output report file are written with mode `0o600` (`run.mjs:275, 350`).
- **Resource Cleanup on Exit**: `installRunResourceCleanup` (`run.mjs:89-104`) registers synchronous handlers on `exit`, `SIGINT` (130), `SIGTERM` (143), and `SIGHUP` (129). In `finalizeRunResources` (`run.mjs:82-87`), `cleanupRunResourcesSync` executes *before* `uninstall()` removes signal handlers. Canonical `realpathSync` of the worktree path is recorded to allow clean `git worktree remove --force` even if underlying symlinks are traversed.
- **Process Credential & Workspace Isolation**: Subprocesses run with `HOME: copy.root` and `XDG_CONFIG_HOME: join(copy.root, "xdg")` (`run.mjs:139-140`). Client invocations pass file paths (`--agent-token-file`, `--profile`) rather than raw secret tokens in `argv` (`run.mjs:123-125`). `assertNoOriginWrites` (`run.mjs:226-234`) verifies that no write methods or `BLOCKED` status requests reached the origin.

#### 3. Test Invariants & Failure Mechanics
- **Exit Path Guarantees**: `cleanupRunResourcesSync` removes both the Git worktree registration and `tempRoot` recursively (`run.mjs:56-78`).
- **Validation**: `runTable` validates mapping completeness against the inventory before executing operations (`run.mjs:270`). Discrepancies between mapping and enumerated inventory throw before any network operations or worktrees are created.

#### 4. Tree and Commits
- Commit `5758a351` (exit path cleanup with `realpath` tracking), `a2c60c62` (pause timer via `node:timers/promises`), and `9860904b` (cleanup deletes copy before handler removal, captured stderr/stdout, uncapped check capture in `source-check.ts`) are accurately integrated in `run.mjs` and `source-check.ts`.

---

VERDICT: PASS
