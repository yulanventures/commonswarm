#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { realpathSync, rmSync } from "node:fs";
import { chmod, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { setTimeout as pause } from "node:timers/promises";
import { enumerateRepository } from "./enumerate.mjs";
import { mappingForRef, validateMapping } from "./mapping.mjs";
import {
  clientInvocation, makePrivateProfileCopy, percentile, readJsonLines, runChild, summarize,
} from "./core.mjs";

const { originWriteKind, describeOriginWriteRules } = createRequire(import.meta.url)("./writes.cjs");

const here = dirname(fileURLToPath(import.meta.url));

export function argsOf(argv) {
  const out = { client: null, runs: 20, pauseMs: 500, ref: null, sourceTimeoutMs: 120_000,
    mapping: join(here, "mapping.json"), output: null, acknowledgeNotMeasured: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--base-url") out.baseUrl = argv[++i];
    else if (arg === "--profile") out.profile = argv[++i];
    else if (arg === "--client") out.client = argv[++i];
    else if (arg === "--runs") out.runs = Number(argv[++i]);
    else if (arg === "--pause-ms") out.pauseMs = Number(argv[++i]);
    else if (arg === "--ref") out.ref = argv[++i];
    else if (arg === "--mapping") out.mapping = resolve(argv[++i]);
    else if (arg === "--output") out.output = resolve(argv[++i]);
    else if (arg === "--source-timeout-ms") out.sourceTimeoutMs = Number(argv[++i]);
    else if (arg === "--acknowledge-not-measured") {
      out.acknowledgeNotMeasured = String(argv[++i] ?? "").split(",").map(id => id.trim()).filter(Boolean);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (!out.baseUrl || !out.profile) throw new Error("--base-url and --profile are required");
  if (!Number.isSafeInteger(out.runs) || out.runs < 1) throw new Error("--runs must be a positive integer");
  if (!Number.isSafeInteger(out.pauseMs) || out.pauseMs < 0) throw new Error("--pause-ms must be a non-negative integer");
  new URL(out.baseUrl);
  return out;
}

function git(repo, values) {
  return execFileSync("git", ["-C", repo, ...values], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

// 'exit' listeners must be synchronous: async work is dropped. Default SIGTERM
// ends the process without emitting 'exit' (measured Node v26), so the signal
// handlers call process.exit and this function runs from 'exit'. Git stores the
// realpath of a worktree; after the directory is gone, remove only accepts that
// realpath, so we record it while the tree still exists.
export function cleanupRunResourcesSync(resources) {
  try {
    const repo = resources?.repo;
    const worktreePath = resources?.worktreePath;
    if (typeof repo === "string" && repo && typeof worktreePath === "string" && worktreePath) {
      try {
        execFileSync("git", ["-C", repo, "worktree", "remove", "--force", worktreePath], {
          stdio: ["ignore", "ignore", "ignore"],
          timeout: 10_000,
        });
      } catch {
        // already gone, never added, or git failed; still drop the temp root
      }
      resources.worktreePath = null;
    }
    const tempRoot = resources?.tempRoot;
    if (typeof tempRoot === "string" && tempRoot) {
      try { rmSync(tempRoot, { recursive: true, force: true }); } catch { /* never throw from 'exit' */ }
      resources.tempRoot = null;
    }
  } catch {
    // must not throw: 'exit' and signal paths have nowhere to send the error
  }
}

export function installRunResourceCleanup(resources) {
  const onExit = () => cleanupRunResourcesSync(resources);
  const onSigint = () => process.exit(130);
  const onSigterm = () => process.exit(143);
  const onSighup = () => process.exit(129);
  process.on("exit", onExit);
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  process.on("SIGHUP", onSighup);
  return () => {
    process.removeListener("exit", onExit);
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    process.removeListener("SIGHUP", onSighup);
  };
}

export async function sourceRootForRef(repo, ref, tempRoot, resources) {
  if (ref == null) return { root: repo };
  git(repo, ["rev-parse", "--verify", `${ref}^{commit}`]);
  const root = join(tempRoot, "source-ref");
  if (resources) resources.worktreePath = root;
  execFileSync("git", ["-C", repo, "worktree", "add", "--detach", root, ref], { stdio: ["ignore", "ignore", "ignore"] });
  if (resources) {
    try { resources.worktreePath = realpathSync(root); }
    catch { resources.worktreePath = root; }
  }
  await symlink(join(repo, "node_modules"), join(root, "node_modules"), "dir");
  return { root };
}

function cliArgs(operation, copy) {
  const credential = copy.profile.credential_file;
  const common = ["--workspace-id", copy.profile.workspace_id, "--agent-token-file", credential, "--json"];
  if (operation === "check") return ["check", "--profile", copy.profilePath, "--json"];
  if (operation === "file-ls") return ["file", "ls", ...common];
  if (operation === "channel-ls") return ["channel", "ls", ...common];
  throw new Error(`operation has no client arguments: ${operation}`);
}

function environment(base, copy, log) {
  const preload = join(here, "preload.cjs");
  const existing = process.env.NODE_OPTIONS ?? "";
  return {
    ...process.env,
    NODE_OPTIONS: `${existing}${existing ? " " : ""}--require=${preload}`,
    TIMEOUT_TABLE_BASE_URL: base,
    TIMEOUT_TABLE_PROFILE_ORIGIN: copy.profile.url,
    TIMEOUT_TABLE_FETCH_LOG: log,
    SWARM_CLOUD_URL: copy.profile.url,
    SWARM_CLOUD_ANON_KEY: copy.profile.anon_key,
    HOME: copy.root,
    XDG_CONFIG_HOME: join(copy.root, "xdg"),
  };
}

async function oneOperation(name, options, copy, log, sourceRoot) {
  const env = environment(options.baseUrl, copy, log);
  if (name === "auth-settings") {
    return await runChild(process.execPath, [join(here, "probe.mjs"), name, copy.profilePath], { env, capture: true });
  }
  if (name === "check-uncapped") {
    return await runChild(process.execPath,
      ["--import", "tsx", join(here, "source-check.ts"), sourceRoot, copy.profilePath, String(options.sourceTimeoutMs)],
      { env, cwd: sourceRoot, capture: true });
  }
  if (name === "signal-read") {
    return await runChild(process.execPath,
      ["--import", "tsx", join(here, "source-signal-read.ts"), sourceRoot, copy.profilePath],
      { env, cwd: sourceRoot, capture: true });
  }
  if (!options.client) throw new Error(`--client is required for ${name}`);
  const invocation = clientInvocation(options.client, cliArgs(name, copy));
  return await runChild(invocation.command, invocation.args, { env, capture: true });
}

function measurementChildError(name, result) {
  const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").slice(0, 2_000);
  return new Error(`${name} measurement child exited ${result.code}${detail ? `: ${detail}` : ""}`);
}

function operationEndpointRows(rows, endpoints) {
  const allowed = new Set(endpoints);
  return rows.filter(row => allowed.has(row.path));
}

function formatMs(value) { return value === null ? "—" : value.toFixed(1); }
function escapeCell(value) { return String(value).replaceAll("|", "\\|").replaceAll("\n", " "); }

function measurementFor(map, measurements) {
  return measurements.get(map.operation.name) ?? measurements.get(map.operation.proxy_operation);
}

export function rowSummary(row, map, measured) {
  const durations = measured?.durations ?? [];
  const attempted = measured?.attempted === true;
  const incompletePath = map.operation.measures_guarded_path === false && durations.length > 0;
  const attemptedWithoutSample = attempted && durations.length === 0;
  return summarize(durations, row.value_ms, {
    notNetwork: map.class !== "network-api",
    notRun: map.operation.class === "not-run",
    notMeasured: map.class === "network-api" && map.operation.class === "safe-read" &&
      (incompletePath || attemptedWithoutSample),
    realTimeouts: measured?.realTimeouts ?? 0,
  });
}

export function runStatus(inventory, mapping, measurements, acknowledged = []) {
  const ack = new Set(acknowledged);
  const fails = [];
  const notMeasured = [];
  for (const row of inventory) {
    const map = mapping.rows[row.id];
    const stats = rowSummary(row, map, measurementFor(map, measurements));
    if (stats.gate === "FAIL") fails.push(row.id);
    if (stats.gate === "NOT MEASURED") notMeasured.push(row.id);
  }
  const missing = notMeasured.filter(id => !ack.has(id));
  const extra = [...ack].filter(id => !notMeasured.includes(id));
  return { fails, notMeasured, missing, extra };
}

export function assertNoOriginWrites(rows, name) {
  for (const row of rows) {
    const kind = originWriteKind(row.method, row.path);
    if (kind || row.status === "BLOCKED") {
      throw new Error(
        `measured operation ${name} sent a write to the origin (${row.method} ${row.path}); blocked writes are ${describeOriginWriteRules()}`,
      );
    }
  }
}

export function markdownReport({ baseUrl, inventory, mapping, measurements, startup, ref = null, client = null }) {
  const lines = [
    `# Client timeout table — ${new URL(baseUrl).origin}`,
    "",
    `Ref \`${ref ?? "working-tree"}\`; client \`${client ?? "not given"}\`. Inventory comes from the ref; timings come from the client binary and source helpers.`,
    "",
    `Client start-up (\`--version\`): ${startup ? `p50 ${formatMs(startup.p50)} ms; p95 ${formatMs(startup.p95)} ms; max ${formatMs(startup.max)} ms` : "not run"}.`,
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
    lines.push(`| ${escapeCell(row.id)} | ${row.line ?? "—"} | ${budget} | ${map.scope} | ${escapeCell(map.endpoints.join(", ") || "—")} | ${escapeCell(operation)} | ${escapeCell(shownClass)} | ${stats.runs} | ${formatMs(stats.p50)} | ${formatMs(stats.p95)} | ${formatMs(stats.max)} | ${stats.headroom === null ? "—" : stats.headroom.toFixed(2)} | ${stats.gate} | ${escapeCell(exits)} |`);
  }
  return `${lines.join("\n")}\n`;
}

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
    cleanupRunResourcesSync(resources);
    uninstallSignals();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { await runTable(argsOf(process.argv.slice(2))); }
  catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
