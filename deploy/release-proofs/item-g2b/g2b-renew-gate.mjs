#!/usr/bin/env node
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

export const RENEW_TIMEOUT_MS = 15_000;
export const CHECK_BUDGET_MS = 3_900;
export const RENEW_TIMEOUT_SOURCE = "src/cloud/wake-lease.ts:64";
export const CHECK_BUDGET_SOURCE = "src/cloud/agent-check-budget.ts:22";
export const RELEASE_GATE_ROUNDS = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^swm_agt_[A-Za-z0-9_-]{43}$/;
const STABLE_CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;
const MIN_REMAINING_MS = 90 * 60 * 1_000;

export function percentile(values, fraction) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = values.map(Number).sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];
}

export function summarizeTimings(calls) {
  const values = calls.map((call) => call.elapsed_ms);
  return {
    n: calls.length,
    p50_ms: percentile(values, 0.50),
    p95_ms: percentile(values, 0.95),
    max_ms: values.length === 0 ? null : Math.max(...values),
    first_call_ms: values[0] ?? null,
    succeeded: calls.filter((call) => call.ok).length,
    calls,
  };
}

async function exactMode(path, expected) {
  return ((await stat(path)).mode & 0o777) === expected;
}

function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must contain a JSON object`);
  }
  return value;
}

async function jsonFile(path, name) {
  let parsed;
  try { parsed = JSON.parse(await readFile(path, "utf8")); }
  catch { throw new Error(`${name} must contain valid JSON`); }
  return object(parsed, name);
}

export async function validateSeedInputs({ releaseCheckout, seedDir, url, workspaceId, release = false, now = Date.now() }) {
  const releaseRoot = resolve(releaseCheckout);
  const seedRoot = resolve(seedDir);
  if (!await exactMode(seedRoot, 0o700).catch(() => false)) {
    throw new Error("seed directory must exist with mode 0700");
  }
  const paths = {
    credential: join(seedRoot, "credential.json"),
    principal: join(seedRoot, "principal.json"),
    anon: join(seedRoot, "anon-key.txt"),
    profile: join(seedRoot, "profile.json"),
    state: join(seedRoot, "renew-gate-state.json"),
    jsonReport: join(seedRoot, "renew-gate.json"),
    markdownReport: join(seedRoot, "renew-gate.md"),
  };
  for (const [name, path] of Object.entries({
    "credential.json": paths.credential,
    "principal.json": paths.principal,
    "anon-key.txt": paths.anon,
  })) {
    if (!await exactMode(path, 0o600).catch(() => false)) {
      throw new Error(`${name} must exist with mode 0600`);
    }
  }
  for (const module of ["wake-lease.js", "agent-check.js", "agent-profile.js", "agent-credential-input.js"]) {
    await stat(join(releaseRoot, "dist", "cloud", module)).catch(() => {
      throw new Error(`release checkout is missing built dist/cloud/${module}`);
    });
  }
  let target;
  try { target = new URL(url); }
  catch { throw new Error("url must be an absolute HTTP(S) URL"); }
  if (!["http:", "https:"].includes(target.protocol) || target.username || target.password || target.search ||
      target.hash || (target.pathname !== "" && target.pathname !== "/")) {
    throw new Error("url must be an HTTP(S) service base URL without credentials, path, query, or fragment");
  }
  if (!UUID_RE.test(workspaceId)) throw new Error("workspace id must be a UUID");
  const principal = await jsonFile(paths.principal, "principal.json");
  const credential = await jsonFile(paths.credential, "credential.json");
  if (typeof principal.principal_id !== "string" || !UUID_RE.test(principal.principal_id)) {
    throw new Error("principal.json must name a principal_id UUID");
  }
  const credentialModule = pathToFileURL(join(
    releaseRoot, "dist", "cloud", "agent-credential-input.js",
  )).href;
  let parsedCredential;
  try {
    const { parseAgentCredentialInput } = await import(credentialModule);
    parsedCredential = parseAgentCredentialInput(
      JSON.stringify(credential),
      { kind: "file", path: paths.credential },
    );
  } catch {
    throw new Error("credential.json is not an unchanged minted credential artifact");
  }
  if (parsedCredential.principalId !== principal.principal_id.toLowerCase()) {
    throw new Error("credential.json and principal.json name different principals");
  }
  if (typeof credential.agent_token !== "string" || !TOKEN_RE.test(credential.agent_token)) {
    throw new Error("credential.json does not contain a minted agent credential");
  }
  const expiresAt = parsedCredential.expiresAt;
  if (!Number.isFinite(expiresAt)) throw new Error("credential.json has no valid expires_at");
  if (!release && expiresAt - now < MIN_REMAINING_MS) {
    throw new Error("credential expires in less than 90 minutes; mint again");
  }
  const anonKey = (await readFile(paths.anon, "utf8")).trim();
  if (!anonKey || /\s/.test(anonKey)) throw new Error("anon-key.txt must contain one non-empty key");
  let releaseState = null;
  if (release) {
    if (!await exactMode(paths.state, 0o600).catch(() => false)) {
      throw new Error("renew-gate-state.json must exist with mode 0600");
    }
    releaseState = await jsonFile(paths.state, "renew-gate-state.json");
    if (releaseState.principal_id !== principal.principal_id.toLowerCase() ||
        releaseState.workspace_id !== workspaceId.toLowerCase() ||
        !UUID_RE.test(releaseState.watcher_id) ||
        !Number.isSafeInteger(releaseState.generation)) {
      throw new Error("renew-gate-state.json does not match this seat and workspace");
    }
  }
  return {
    releaseRoot, seedRoot, paths, credential, principal,
    principalId: principal.principal_id.toLowerCase(),
    workspaceId: workspaceId.toLowerCase(),
    url: target.origin, anonKey, releaseState,
  };
}

async function secureWrite(path, value) {
  await writeFile(path, value, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}

async function loadClients(input) {
  const cloud = (name) => pathToFileURL(join(input.releaseRoot, "dist", "cloud", name)).href;
  const [{ sendWakeLeaseCommand }, { checkAgentMessages }, profile] = await Promise.all([
    import(cloud("wake-lease.js")),
    import(cloud("agent-check.js")),
    import(cloud("agent-profile.js")),
  ]);
  return { sendWakeLeaseCommand, checkAgentMessages, ...profile };
}

async function prepareProfile(input) {
  await mkdir(join(input.seedRoot, "agent-state"), { recursive: true, mode: 0o700 });
  await chmod(join(input.seedRoot, "agent-state"), 0o700);
  await secureWrite(input.paths.profile, JSON.stringify({
    version: 1,
    url: input.url,
    anon_key: input.anonKey,
    workspace_id: input.workspaceId,
    principal_id: input.principalId,
    credential_file: input.paths.credential,
  }));
}

function stableCode(value) {
  return typeof value === "string" && STABLE_CODE_RE.test(value)
    ? value
    : "unrecognized_error";
}

function safeCode(error, observed) {
  if (typeof observed?.error === "string") return stableCode(observed.error);
  if (observed?.status) return `http_${observed.status}`;
  if (typeof error?.code === "string") return stableCode(error.code);
  if (error?.name === "WakeLeaseTransientError") return "transport_failure";
  return "client_failure";
}

function observingFetch() {
  const observation = { last: null };
  const fetcher = async (resource, init) => {
    try {
      const response = await fetch(resource, init);
      let error = null;
      try {
        const body = await response.clone().json();
        if (body && typeof body.error === "string") error = body.error;
      } catch { /* A shipped client classifies malformed bodies. */ }
      observation.last = { status: response.status, error };
      return response;
    } catch (error) {
      observation.last = { status: null, error: "transport_failure" };
      throw error;
    }
  };
  return { observation, fetcher };
}

async function timed(round, operation) {
  const started = performance.now();
  try {
    await operation();
    return { round, elapsed_ms: Math.round((performance.now() - started) * 100) / 100, ok: true, code: "ok" };
  } catch (error) {
    return {
      round,
      elapsed_ms: Math.round((performance.now() - started) * 100) / 100,
      ok: false,
      code: safeCode(error, error.observed),
    };
  }
}

async function runtime(input) {
  await prepareProfile(input);
  const clients = await loadClients(input);
  const profile = await clients.readAgentProfile(input.paths.profile);
  const target = clients.profileTarget(profile);
  const bearer = async (fetcher = fetch) => {
    const credential = await clients.openProfileCredential(profile, fetcher);
    return await credential.bearer();
  };
  const lease = async (command) => {
    const observed = observingFetch();
    try {
      return await clients.sendWakeLeaseCommand({
        target,
        workspaceId: input.workspaceId,
        token: await bearer(observed.fetcher),
        command,
        restartCommand: null,
        fetcher: observed.fetcher,
      });
    } catch (error) {
      error.observed = observed.observation.last;
      throw error;
    }
  };
  return { clients, profile, lease };
}

async function releaseLease(input) {
  const state = input.releaseState;
  if (!state) throw new Error("validated release state is missing");
  const { lease } = await runtime(input);
  const result = await lease({
    kind: "release_wake_lease",
    watcher_id: state.watcher_id,
    generation: state.generation,
  });
  if (result.released !== true) throw new Error("the recorded lease was not held");
  await secureWrite(input.paths.state, JSON.stringify({ ...state, released_at: new Date().toISOString() }, null, 2));
  process.stdout.write(`G2B_PRINCIPAL_ID=${input.principalId}\nLEASE RELEASED\n`);
}

function markdown(report) {
  const row = (name, data, budget, source) =>
    `| ${name} | ${data.n} | ${data.first_call_ms} | ${data.p50_ms} | ${data.p95_ms} | ${data.max_ms} | ${budget} | \`${source}\` |`;
  return `# ${report.header}\n\nStatus: **${report.status}**\n\nOutcome: **${report.outcome}**\n\nPrincipal: \`${report.principal_id}\`\n\n` +
    `## Timeout table\n\n| call | n | first (ms) | p50 (ms) | p95 (ms) | max (ms) | shipped budget (ms) | source |\n` +
    `|---|---:|---:|---:|---:|---:|---:|---|\n` +
    `${row("renew_wake_lease", report.renew, report.thresholds.renew_timeout_ms, report.thresholds.renew_timeout_source)}\n` +
    `${row("check", report.check, report.thresholds.check_budget_ms, report.thresholds.check_budget_source)}\n\n` +
    `The renew timeout is the gate. The check budget is recorded for comparison and is not a gate. Every call, including the first call, is retained in \`renew-gate.json\`.\n`;
}

async function runGate(input, rounds) {
  const startedAt = new Date().toISOString();
  const { clients, profile, lease } = await runtime(input);
  const watcherId = randomUUID();
  let claimed;
  try {
    claimed = await lease({
      kind: "claim_wake_lease",
      watcher_id: watcherId,
      host_label: "g2b-renew-gate",
      host_id: randomUUID(),
      take_over: false,
    });
  } catch (error) {
    process.stdout.write(`G2B_PRINCIPAL_ID=${input.principalId}\nGATE CANNOT RUN ${safeCode(error, error.observed)}\n`);
    process.exitCode = 8;
    return;
  }
  const generation = Number(claimed.generation);
  if (!Number.isSafeInteger(generation) || generation < 1) {
    process.stdout.write(`G2B_PRINCIPAL_ID=${input.principalId}\nGATE CANNOT RUN malformed_claim\n`);
    process.exitCode = 8;
    return;
  }
  await secureWrite(input.paths.state, JSON.stringify({
    version: 1,
    principal_id: input.principalId,
    workspace_id: input.workspaceId,
    watcher_id: watcherId,
    generation,
    host_label: "g2b-renew-gate",
    claimed_at: new Date().toISOString(),
  }, null, 2));
  process.stdout.write(`G2B_PRINCIPAL_ID=${input.principalId}\nLEASE HELD generation=${generation}\n`);

  const renewCalls = [];
  const checkCalls = [];
  for (let round = 1; round <= rounds; round += 1) {
    const renew = await timed(round, async () => {
      await lease({ kind: "renew_wake_lease", watcher_id: watcherId, generation });
    });
    renewCalls.push(renew);
    process.stdout.write(`RENEW ${round}/${rounds} ${renew.code} ${renew.elapsed_ms}ms\n`);

    const observed = observingFetch();
    const check = await timed(round, async () => {
      try {
        await clients.checkAgentMessages({
          profilePath: input.paths.profile,
          fetcher: observed.fetcher,
          present: async () => {},
        });
      } catch (error) {
        error.observed = observed.observation.last;
        throw error;
      }
    });
    checkCalls.push(check);
    process.stdout.write(`CHECK ${round}/${rounds} ${check.code} ${check.elapsed_ms}ms\n`);
  }
  const renew = summarizeTimings(renewCalls);
  const check = summarizeTimings(checkCalls);
  const passed = renew.succeeded === rounds && renew.p95_ms < RENEW_TIMEOUT_MS;
  const reason = renew.succeeded !== rounds
    ? `${rounds - renew.succeeded}_renew_failed`
    : renew.p95_ms >= RENEW_TIMEOUT_MS ? "renew_p95_not_below_15000ms" : null;
  const releaseGate = rounds === RELEASE_GATE_ROUNDS;
  const outcome = passed ? "PASS" : `FAIL-${reason}`;
  const header = releaseGate
    ? passed ? "GATE PASS" : `GATE FAIL ${reason}`
    : `GATE NOT A RELEASE GATE n=${rounds} ${outcome}`;
  const report = {
    version: 1,
    header,
    status: releaseGate ? passed ? "PASS" : "FAIL" : "NOT_A_RELEASE_GATE",
    outcome,
    release_gate: releaseGate,
    rounds,
    reason,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    principal_id: input.principalId,
    workspace_id: input.workspaceId,
    watcher_id: watcherId,
    generation,
    host_label: "g2b-renew-gate",
    thresholds: {
      renew_timeout_ms: RENEW_TIMEOUT_MS,
      renew_timeout_source: RENEW_TIMEOUT_SOURCE,
      check_budget_ms: CHECK_BUDGET_MS,
      check_budget_source: CHECK_BUDGET_SOURCE,
      check_budget_is_gate: false,
    },
    renew,
    check,
  };
  await secureWrite(input.paths.jsonReport, `${JSON.stringify(report, null, 2)}\n`);
  await secureWrite(input.paths.markdownReport, markdown(report));
  process.stdout.write(`RENEW p50=${renew.p50_ms}ms p95=${renew.p95_ms}ms max=${renew.max_ms}ms n=${renew.n}\n`);
  process.stdout.write(`CHECK p50=${check.p50_ms}ms p95=${check.p95_ms}ms max=${check.max_ms}ms n=${check.n}\n`);
  process.stdout.write(`${header}\n`);
  if (!releaseGate) process.exitCode = 10;
  else if (!passed) process.exitCode = 7;
}

async function selfTest() {
  assert.equal(percentile([40, 10, 30, 20], 0.50), 20);
  assert.equal(percentile([40, 10, 30, 20], 0.95), 40);
  assert.deepEqual(summarizeTimings([
    { elapsed_ms: 2, ok: true }, { elapsed_ms: 8, ok: false }, { elapsed_ms: 4, ok: true },
  ]), {
    n: 3, p50_ms: 4, p95_ms: 8, max_ms: 8, first_call_ms: 2, succeeded: 2,
    calls: [{ elapsed_ms: 2, ok: true }, { elapsed_ms: 8, ok: false }, { elapsed_ms: 4, ok: true }],
  });
  process.stdout.write("SELF TEST PASS\n");
}

async function main() {
  if (process.argv[2] === "--self-test") return await selfTest();
  const [releaseCheckout, seedDir, url, workspaceId, roundsRaw, mode] = process.argv.slice(2);
  if (!releaseCheckout || !seedDir || !url || !workspaceId || !roundsRaw || (mode && mode !== "--release")) {
    throw new Error("invalid arguments");
  }
  const rounds = Number(roundsRaw);
  if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 50) throw new Error("invalid round count");
  let input;
  try {
    input = await validateSeedInputs({ releaseCheckout, seedDir, url, workspaceId, release: mode === "--release" });
  } catch (error) {
    process.stdout.write(`input: ${error instanceof Error ? error.message : "invalid input"}\n`);
    process.exitCode = 2;
    return;
  }
  if (mode === "--release") await releaseLease(input);
  else await runGate(input, rounds);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stdout.write(`GATE CANNOT RUN ${safeCode(error, error?.observed)}\n`);
    process.exitCode = process.exitCode || 8;
  });
}
