#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { setTimeout as pause } from "node:timers/promises";
import { enumerateRepository } from "./enumerate.mjs";
import { validateMapping } from "./mapping.mjs";
import {
  clientInvocation, makePrivateProfileCopy, percentile, readJsonLines, runChild, summarize,
} from "./core.mjs";

const here = dirname(fileURLToPath(import.meta.url));

function argsOf(argv) {
  const out = { client: null, runs: 20, pauseMs: 500, ref: null, sourceTimeoutMs: 120_000,
    mapping: join(here, "mapping.json"), output: null };
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
    else throw new Error(`unknown argument: ${arg}`);
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

async function sourceRootForRef(repo, ref, tempRoot) {
  if (ref === null) return { root: repo, remove: async () => {} };
  git(repo, ["rev-parse", "--verify", `${ref}^{commit}`]);
  const root = join(tempRoot, "source-ref");
  execFileSync("git", ["-C", repo, "worktree", "add", "--detach", root, ref], { stdio: ["ignore", "ignore", "ignore"] });
  try { await symlink(join(repo, "node_modules"), join(root, "node_modules"), "dir"); }
  catch (error) {
    execFileSync("git", ["-C", repo, "worktree", "remove", "--force", root], { stdio: ["ignore", "ignore", "ignore"] });
    throw error;
  }
  return { root, remove: async () => {
    execFileSync("git", ["-C", repo, "worktree", "remove", "--force", root], { stdio: ["ignore", "ignore", "ignore"] });
  } };
}

function cliArgs(operation, copy) {
  const credential = copy.profile.credential_file;
  const common = ["--workspace-id", copy.profile.workspace_id, "--agent-token-file", credential, "--json"];
  if (operation === "check") return ["check", "--profile", copy.profilePath, "--json"];
  if (operation === "members") return ["members", ...common];
  if (operation === "feed") return ["feed", "--limit", "1", ...common];
  if (operation === "inbox") return ["inbox", "--limit", "1", ...common];
  if (operation === "file-ls") return ["file", "ls", ...common];
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
    return await runChild(process.execPath, [join(here, "probe.mjs"), name, copy.profilePath], { env });
  }
  if (name === "check-uncapped") {
    return await runChild(process.execPath,
      ["--import", "tsx", join(here, "source-check.ts"), sourceRoot, copy.profilePath, String(options.sourceTimeoutMs)],
      { env, cwd: sourceRoot, capture: true });
  }
  if (!options.client) throw new Error(`--client is required for ${name}`);
  const invocation = clientInvocation(options.client, cliArgs(name, copy));
  return await runChild(invocation.command, invocation.args, { env, capture: options.capture });
}

function operationEndpointRows(rows, endpoints) {
  const allowed = new Set(endpoints);
  return rows.filter(row => allowed.has(row.path));
}

function formatMs(value) { return value === null ? "—" : value.toFixed(1); }
function escapeCell(value) { return String(value).replaceAll("|", "\\|").replaceAll("\n", " "); }

export function markdownReport({ baseUrl, inventory, mapping, measurements, startup }) {
  const lines = [
    `# Client timeout table — ${new URL(baseUrl).origin}`,
    "",
    `Client start-up (\`--version\`): ${startup ? `p50 ${formatMs(startup.p50)} ms; p95 ${formatMs(startup.p95)} ms; max ${formatMs(startup.max)} ms` : "not run"}.`,
    "",
    "| Constant id | Budget | Scope | Endpoint(s) | Operation | Class | Runs | p50 | p95 | Max | Headroom | Gate | Real-client exits / timeouts |",
    "|---|---:|---|---|---|---|---:|---:|---:|---:|---:|---|---:|",
  ];
  for (const row of inventory) {
    const map = mapping.rows[row.id];
    const measured = measurements.get(map.operation.name) ?? measurements.get(map.operation.proxy_operation);
    const stats = summarize(measured?.durations ?? [], row.value_ms);
    const nonNetwork = map.class === "network-api" ? null : "not network";
    const budget = row.unit_note.startsWith("non-time") ? `${row.value_ms} raw` : `${row.value_ms} ms`;
    const exits = measured?.realExitCodes
      ? `${JSON.stringify(measured.realExitCodes)} / ${measured.realTimeouts}`
      : "—";
    const operation = map.operation.proxy_operation
      ? `${map.operation.name} (proxy: ${map.operation.proxy_operation})`
      : map.operation.name;
    lines.push(`| ${escapeCell(row.id)} | ${budget} | ${map.scope} | ${escapeCell(map.endpoints.join(", ") || "—")} | ${escapeCell(operation)} | ${nonNetwork ?? map.operation.class} | ${stats.runs} | ${formatMs(stats.p50)} | ${formatMs(stats.p95)} | ${formatMs(stats.max)} | ${stats.headroom === null ? "—" : stats.headroom.toFixed(2)} | ${nonNetwork ? "NOT NETWORK" : stats.gate} | ${escapeCell(exits)} |`);
  }
  return `${lines.join("\n")}\n`;
}

export async function runTable(options) {
  const repo = resolve(join(here, "../.."));
  const mapping = JSON.parse(await readFile(options.mapping, "utf8"));
  const inventory = enumerateRepository({ repo, ref: options.ref });
  validateMapping(inventory, mapping);
  const tempRoot = await mkdtemp(join(tmpdir(), "cswarm-timeout-run-"));
  await chmod(tempRoot, 0o700);
  const log = join(tempRoot, "fetch.jsonl");
  await writeFile(log, "", { mode: 0o600 });
  let copy;
  let source;
  const onSignal = () => {
    void Promise.allSettled([
      source?.remove?.(), copy?.remove?.(), rm(tempRoot, { recursive: true, force: true }),
    ]).finally(() => process.exit(130));
  };
  process.once("SIGINT", onSignal);
  try {
    copy = await makePrivateProfileCopy(options.profile, { tempParent: tempRoot });
    source = await sourceRootForRef(repo, options.ref, tempRoot);
    const measurements = new Map();
    const operations = new Map();
    for (const row of inventory) {
      const map = mapping.rows[row.id];
      if (!map) throw new Error(`mapping lacks ${row.id}`);
      const name = map.operation.class === "safe-read" ? map.operation.name : map.operation.proxy_operation;
      if (name) operations.set(name, { endpoints: map.endpoints, budget: row.value_ms });
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
      if (!options.client && name !== "auth-settings" && name !== "check") {
        measurements.set(name, { durations, realTimeouts, realExitCodes: null });
        continue;
      }
      for (let index = 0; index < options.runs; index += 1) {
        const before = (await readJsonLines(log)).length;
        let result;
        if (name === "check") {
          if (options.client) {
            const real = await oneOperation("check", { ...options, capture: true }, copy, log, source.root);
            realExitCodes[real.code] = (realExitCodes[real.code] ?? 0) + 1;
            if (`${real.stdout}\n${real.stderr}`.includes("check_timeout")) realTimeouts += 1;
          }
          result = await oneOperation("check-uncapped", options, copy, log, source.root);
        } else result = await oneOperation(name, options, copy, log, source.root);
        if (result.code !== 0) throw new Error(`${name} measurement child exited ${result.code}`);
        const fresh = (await readJsonLines(log)).slice(before);
        const requests = operationEndpointRows(fresh, operation.endpoints);
        if (name === "check") {
          let uncapped;
          try { uncapped = JSON.parse(result.stdout); }
          catch { throw new Error("uncapped check did not report its wall time"); }
          if (!Number.isFinite(uncapped.duration_ms)) throw new Error("uncapped check wall time is invalid");
          durations.push(uncapped.duration_ms);
        }
        else if (requests.length > 0) durations.push(Math.max(...requests.map(row => row.duration_ms)));
        else durations.push(result.durationMs);
        if (index + 1 < options.runs && options.pauseMs) await pause(options.pauseMs);
      }
      measurements.set(name, { durations, realTimeouts, realExitCodes: name === "check" && options.client ? realExitCodes : null });
    }
    const startup = startupValues.length === 0 ? null : {
      p50: percentile(startupValues, .5), p95: percentile(startupValues, .95), max: Math.max(...startupValues),
    };
    const report = markdownReport({ baseUrl: options.baseUrl, inventory, mapping, measurements, startup });
    if (options.output) await writeFile(options.output, report, { mode: 0o600 });
    else process.stdout.write(report);
    return { report, inventory, measurements, startup };
  } finally {
    process.removeListener("SIGINT", onSignal);
    if (source) await source.remove();
    if (copy) await copy.remove();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { await runTable(argsOf(process.argv.slice(2))); }
  catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
