import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, rmSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { once } from "node:events";
import { enumerateRepository, enumerateText } from "../../scripts/timeout-table/enumerate.mjs";
import { mappingForRef, validateMapping } from "../../scripts/timeout-table/mapping.mjs";
import { createRequire } from "node:module";
import {
  argsOf, assertNoOriginWrites, environment, finalizeRunResources, ISOLATED_STATE_ENV,
  isolatedStateEnv, markdownReport, rowSummary, runStatus, runTable, sourceRefForRun,
} from "../../scripts/timeout-table/run.mjs";
import { AGENT_CREDENTIAL_MESSAGE_D088 } from "../../src/cloud/agent-credential-input.js";
import { readJsonLines, runChild, summarize, withPrivateProfile } from "../../scripts/timeout-table/core.mjs";

const { originWriteKind, describeOriginWriteRules } = createRequire(import.meta.url)(
  "../../scripts/timeout-table/writes.cjs",
) as { originWriteKind: (method: string, path: string) => string | null; describeOriginWriteRules: () => string };
import {
  AGENT_CHECK_TIMEOUT_MS,
  HOST_HOOK_PROCESS_DEADLINE_MS,
  HOST_HOOK_TIMEOUT_SECONDS,
} from "../../src/cloud/agent-check-budget.js";
import { LISTENER_PROMPT_TIMEOUT_MS } from "../../src/listener/types.js";

const repo = resolve(import.meta.dirname, "../..");

async function listen(delayMs: () => number) {
  let requests = 0;
  let receivedSecret = false;
  const server = createServer(async (request, response) => {
    requests += 1;
    receivedSecret ||= request.headers.authorization === "Bearer secret-shaped-value";
    await new Promise(resolvePromise => setTimeout(resolvePromise, delayMs()));
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"external":{}}');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    get requests() { return requests; },
    get receivedSecret() { return receivedSecret; },
  };
}

test("timeout inventory and mapping are exact in both directions for each measured ref", { timeout: 30000 }, async () => {
  const mapping = JSON.parse(await readFile(join(repo, "scripts/timeout-table/mapping.json"), "utf8"));
  const measured: { ref: string; enumerateRef: string | null }[] = [
    { ref: "v0.1.71", enumerateRef: "v0.1.71" },
    { ref: "HEAD", enumerateRef: null },
  ];
  for (const { ref, enumerateRef } of measured) {
    const inventory = enumerateRepository({ repo, ref: enumerateRef });
    assert.equal(validateMapping(inventory, mapping, ref), true);
    if (ref === "HEAD") assert.equal(validateMapping(inventory, mapping, null), true);

    const missing = structuredClone(mapping);
    const id = inventory[0]!.id;
    delete mappingForRef(missing, ref).rows[id];
    assert.throws(() => validateMapping(inventory, missing, ref), /missing=/);

    const stale = structuredClone(mapping);
    mappingForRef(stale, ref).rows["src/not-present.ts:TIMEOUT_MS"] =
      structuredClone(mappingForRef(mapping, ref).rows[id]);
    assert.throws(() => validateMapping(inventory, stale, ref), /stale=/);
  }

  assert.throws(
    () => validateMapping(enumerateRepository({ repo }), mapping, "not-a-measured-ref"),
    /no section for ref not-a-measured-ref/,
  );
  assert.equal(
    mappingForRef(mapping, "HEAD").rows["src/cloud/agent-check-budget.ts:AGENT_CHECK_TIMEOUT_MS"] != null,
    true,
  );
  assert.equal(
    mappingForRef(mapping, "v0.1.71").rows["src/cloud/agent-check-budget.ts:AGENT_CHECK_TIMEOUT_MS"] == null,
    true,
  );
  const headRows = new Map(enumerateRepository({ repo }).map(row => [row.id, row]));
  assert.equal(
    headRows.get("src/cloud/agent-check-budget.ts:AGENT_CHECK_TIMEOUT_MS")?.value_ms,
    AGENT_CHECK_TIMEOUT_MS,
  );
  assert.equal(
    headRows.get("src/cloud/agent-check-budget.ts:HOST_HOOK_PROCESS_DEADLINE_MS")?.value_ms,
    HOST_HOOK_PROCESS_DEADLINE_MS,
  );
  const hostHook = headRows.get("src/cloud/agent-check-budget.ts:HOST_HOOK_TIMEOUT_SECONDS");
  assert.equal(hostHook && hostHook.value_ms / 1_000, HOST_HOOK_TIMEOUT_SECONDS);
  assert.equal(
    headRows.get("src/listener/hook.ts:HOOK_CHECK_TIMEOUT_MS")?.value_ms,
    AGENT_CHECK_TIMEOUT_MS,
  );
  assert.equal(headRows.get("src/cloud/channels.ts:timeoutMs")?.value_ms, 30_000);
  assert.equal(
    mappingForRef(mapping, "HEAD").rows["src/cloud/signals.ts:SIGNAL_READ_TIMEOUT_MS"]?.operation.name,
    "signal-read",
  );
  assert.equal(
    mappingForRef(mapping, "HEAD").rows["src/cloud/signals.ts:SIGNAL_READ_TIMEOUT_MS"]
      ?.operation.measures_guarded_path,
    false,
  );
  assert.equal(
    mappingForRef(mapping, "HEAD").rows["src/cloud/agent-check-budget.ts:AGENT_CHECK_TIMEOUT_MS"]
      ?.operation.measures_guarded_path,
    false,
  );
  assert.equal(
    mappingForRef(mapping, "HEAD").rows["site/src/lib/auth-providers.ts:AbortSignal.timeout"]
      ?.operation.class,
    "not-run",
  );
  assert.equal(headRows.get("src/host/claude.ts:requestTimeoutMs")?.value_ms, 120_000);
  assert.equal(headRows.get("src/cli.ts:turnBudgetMs")?.value_ms, LISTENER_PROMPT_TIMEOUT_MS);
  assert.equal(headRows.get("src/cli.ts:deliveryHoldBudgetMs")?.value_ms, LISTENER_PROMPT_TIMEOUT_MS);
});

test("main alias validates the post-merge HEAD inventory including MCP rows", { timeout: 10000 }, async () => {
  const mapping = JSON.parse(await readFile(join(repo, "scripts/timeout-table/mapping.json"), "utf8"));
  const mergedMainInventory = enumerateRepository({ repo });
  assert.equal(mapping.aliases.main, "HEAD");
  for (const id of ["MCP_REGISTER_TIMEOUT_MS", "setTimeout", "timeout"].map(name => `src/cloud/mcp-connect.ts:${name}`)) {
    assert.ok(mergedMainInventory.some(row => row.id === id));
    assert.ok(mappingForRef(mapping, "main").rows[id]);
  }
  assert.equal(validateMapping(mergedMainInventory, mapping, "main"), true);
});

test("MCP register abort-timer citation points to the actual timer line", { timeout: 10000 }, async () => {
  const mapping = JSON.parse(await readFile(join(repo, "scripts/timeout-table/mapping.json"), "utf8"));
  const citation = mappingForRef(mapping, "HEAD").rows["src/cloud/mcp-connect.ts:setTimeout"]?.citation;
  const match = /^src\/cloud\/mcp-connect\.ts:(\d+)$/.exec(citation ?? "");
  assert.ok(match, `unexpected citation: ${citation}`);
  const source = await readFile(join(repo, "src/cloud/mcp-connect.ts"), "utf8");
  assert.match(source.split("\n")[Number(match[1]) - 1] ?? "", /const timer = setTimeout\(\(\) => controller\.abort\(\), MCP_REGISTER_TIMEOUT_MS\)/);
});

function shippedMainRef(hasRef: (ref: string) => boolean = ref => {
  try {
    execFileSync("git", ["show-ref", "--verify", "--quiet", ref], { cwd: repo, timeout: 5_000 });
    return true;
  } catch { return false; }
}): string {
  if (hasRef("refs/heads/main")) return "main";
  if (hasRef("refs/remotes/origin/main")) return "origin/main";
  throw new Error("main or origin/main is required to pin the shipped timeout mapping");
}

test("shipped timeout mapping stays byte-identical to main", { timeout: 10_000 }, async () => {
  const current = await readFile(join(repo, "scripts/timeout-table/mapping.json"), "utf8");
  const main = execFileSync("git", ["show", `${shippedMainRef()}:scripts/timeout-table/mapping.json`], { cwd: repo, encoding: "utf8", timeout: 5_000 });
  const shipped = (source: string) => source.slice(source.indexOf('"v0.1.71"'), source.indexOf('"HEAD"', source.indexOf('"v0.1.71"')));
  assert.equal(shipped(current), shipped(main));
  assert.equal(shippedMainRef(ref => ref === "refs/heads/main" || ref === "refs/remotes/origin/main"), "main");
  const fallback = shippedMainRef(ref => ref === "refs/remotes/origin/main");
  assert.equal(fallback, "origin/main");
});

test("HEAD timeout mapping citations point to their measured source lines", { timeout: 10_000 }, async () => {
  const mapping = JSON.parse(await readFile(join(repo, "scripts/timeout-table/mapping.json"), "utf8"));
  const sources: Record<string, string[]> = {
    "src/cli.ts": (await readFile(join(repo, "src/cli.ts"), "utf8")).split("\n"),
    "src/onboarding-cli.ts": (await readFile(join(repo, "src/onboarding-cli.ts"), "utf8")).split("\n"),
  };
  const patterns: Record<string, RegExp> = {
    "src/cli.ts:setTimeout": /const timer = setTimeout\(done, 250\)/,
    "src/cli.ts:setTimeout#2": /const hardExit = setTimeout\(/,
    "src/cli.ts:TURN_BUDGET_CREDENTIAL_MARGIN_MS": /export const TURN_BUDGET_CREDENTIAL_MARGIN_MS/,
    "src/cli.ts:turnBudgetMs": /const turnBudgetMs = options\.turnBudgetMs/,
    "src/cli.ts:deliveryHoldBudgetMs": /deliveryHoldBudgetMs: turnBudgetMs/,
    "src/cloud/agent-check-budget.ts:HOST_HOOK_PROCESS_DEADLINE_MS": /const hardExit = setTimeout\(/,
  };
  let cliCount = 0;
  let onboardingCount = 0;
  const rows = mapping.refs.HEAD.rows as Record<string, { citation: string }>;
  for (const [id, row] of Object.entries(rows)) {
    for (const match of row.citation.matchAll(/(src\/(?:cli|onboarding-cli)\.ts):(\d+)(?:-(\d+))?/g)) {
      const [, file, first, last] = match;
      const lines = sources[file!]!;
      const from = Number(first);
      const to = Number(last ?? first);
      assert.ok(from > 0 && to >= from && to <= lines.length, `HEAD ${id}: ${row.citation}`);
      const pattern = file === "src/onboarding-cli.ts"
        ? id === "src/onboarding-cli.ts:setTimeout" ? /const timer = setTimeout\(/ : /const hardExit = setTimeout\(/
        : patterns[id];
      assert.ok(pattern, `HEAD ${id} has no citation assertion`);
      assert.match(lines.slice(from - 1, to).join("\n"), pattern, `HEAD ${id}: ${row.citation}`);
      if (file === "src/cli.ts") cliCount++; else onboardingCount++;
    }
  }
  assert.equal(cliCount, 5, "reconcile HEAD CLI citations");
  assert.equal(onboardingCount, 2, "reconcile HEAD onboarding citations");
});

test("HEAD signal read citations resolve for each mapped row", { timeout: 10_000 }, async () => {
  const mapping = JSON.parse(await readFile(join(repo, "scripts/timeout-table/mapping.json"), "utf8"));
  const lines = (await readFile(join(repo, "src/cloud/signals.ts"), "utf8")).split("\n");
  const expected: Record<string, { citation: string; sites: Array<[number, RegExp]> }> = {
    "src/cloud/signals.ts:SIGNAL_READ_TIMEOUT_MS": { citation: "src/cloud/signals.ts:38,881-929",
      sites: [[38, /export const SIGNAL_READ_TIMEOUT_MS/], [929, /timeoutMs: number = SIGNAL_READ_TIMEOUT_MS/]] },
    "src/cloud/signals.ts:timeoutMs": { citation: "src/cloud/signals.ts:929",
      sites: [[929, /timeoutMs: number = SIGNAL_READ_TIMEOUT_MS/]] },
    "src/cloud/signals.ts:timeoutMs#2": { citation: "src/cloud/signals.ts:1042",
      sites: [[1042, /timeoutMs: number = SIGNAL_READ_TIMEOUT_MS/]] },
  };
  const rows = mapping.refs.HEAD.rows as Record<string, { citation: string }>;
  for (const [id, target] of Object.entries(expected)) {
    const row = rows[id];
    assert.ok(row, id);
    assert.equal(row.citation, target.citation, id);
    for (const [line, pattern] of target.sites) assert.match(lines[line - 1] ?? "", pattern, `${id}: ${line}`);
  }
  assert.equal(Object.keys(expected).length, 3);
});

test("HEAD onboarding stdin timer is labeled for hook input", { timeout: 10_000 }, async () => {
  const mapping = JSON.parse(await readFile(join(repo, "scripts/timeout-table/mapping.json"), "utf8"));
  const row = mapping.refs.HEAD.rows["src/onboarding-cli.ts:setTimeout"];
  assert.equal(row.operation.name, "hook-stdin");
  assert.match(row.detail, /hook-stdin/);
});

test("Fold 3 records the removed real-main timeout assertion and its pre-merge reason", { timeout: 10000 }, async () => {
  const lane = await readFile(join(repo, "docs/evidence/2026-09-24-mcp-release2/LANE.md"), "utf8");
  assert.match(lane, /Fold 3[\s\S]*removed the pre-existing real `main` enumeration/);
  assert.match(lane, /Fold 3[\s\S]*before merge, real `main` lacks the MCP rows/);
});

test("a pure line shift does not change inventory ids", () => {
  const original = [
    "const TIMEOUT_MS = 1_000;",
    "setTimeout(() => {}, 250);",
    "setTimeout(() => {}, 500);",
  ].join("\n");
  const shifted = `${"const pad = 1;\n".repeat(7)}${original}`;
  const before = enumerateText("fixture.ts", original);
  const after = enumerateText("fixture.ts", shifted);
  assert.deepEqual(before.map(row => row.id), [
    "fixture.ts:TIMEOUT_MS",
    "fixture.ts:setTimeout",
    "fixture.ts:setTimeout#2",
  ]);
  assert.deepEqual(after.map(row => row.id), before.map(row => row.id));
  assert.ok(before.every((row, index) => row.line < after[index]!.line));
});

test("enumerator records timeoutMs defaults, ?? literals, as const, identifier AbortSignal, and import aliases", async () => {
  const defaults = enumerateText("fixture.ts", "function f(timeoutMs = 30_000) { return timeoutMs; }");
  assert.equal(defaults.some(row => row.name === "timeoutMs" && row.value_ms === 30_000), true);

  const coalescing = enumerateText("fixture.ts", "setTimeout(() => {}, options.timeoutMs ?? 15_000);");
  assert.equal(coalescing.some(row => row.name === "setTimeout" && row.value_ms === 15_000), true);

  const asConst = enumerateText("fixture.ts", "const TIMEOUT_MS = 5_000 as const;");
  assert.deepEqual(asConst.map(row => ({ id: row.id, value_ms: row.value_ms })), [
    { id: "fixture.ts:TIMEOUT_MS", value_ms: 5_000 },
  ]);

  const ident = enumerateText(
    "fixture.ts",
    "const DEFAULT_TIMEOUT_MS = 4_000;\nAbortSignal.timeout(DEFAULT_TIMEOUT_MS);",
  );
  assert.equal(ident.some(row => row.name === "AbortSignal.timeout" && row.value_ms === 4_000), true);

  const alias = enumerateText(
    "hook.ts",
    'import { AGENT_CHECK_TIMEOUT_MS } from "./budget.js";\nexport const HOOK_CHECK_TIMEOUT_MS = AGENT_CHECK_TIMEOUT_MS;',
    { importedValues: new Map([["AGENT_CHECK_TIMEOUT_MS", 3_900]]) },
  );
  assert.equal(alias.some(row => row.name === "HOOK_CHECK_TIMEOUT_MS" && row.value_ms === 3_900), true);

  const namespace = enumerateText(
    "ns.ts",
    "AbortSignal.timeout(T.AGENT_CHECK);",
    { importedValues: new Map([["T.AGENT_CHECK", 3_900]]) },
  );
  assert.equal(namespace.some(row => row.name === "AbortSignal.timeout" && row.value_ms === 3_900), true);

  const requestProperty = enumerateText("req.ts", "const x = { requestTimeoutMs: 12_000 };");
  assert.equal(requestProperty.some(row => row.name === "requestTimeoutMs" && row.value_ms === 12_000), true);

  const shadow = enumerateText(
    "shadow.ts",
    "const TIMEOUT_MS = 5_000;\nfunction f() { const TIMEOUT_MS = 100; return TIMEOUT_MS; }\nAbortSignal.timeout(TIMEOUT_MS);",
  );
  assert.equal(shadow.find(row => row.name === "AbortSignal.timeout")?.value_ms, 5_000);

  const exportDir = await mkdtemp(join(tmpdir(), "timeout-table-reexport-"));
  try {
    await mkdir(join(exportDir, "src"), { recursive: true });
    await writeFile(join(exportDir, "src/a.ts"), "export const TIMEOUT_MS = 9_000;\nexport default 4_000;\n");
    await writeFile(join(exportDir, "src/b.ts"), 'export { TIMEOUT_MS } from "./a.ts";\n');
    await writeFile(
      join(exportDir, "src/c.ts"),
      'import { TIMEOUT_MS } from "./b.ts";\nimport * as T from "./a.ts";\nimport fallback from "./a.ts";\nAbortSignal.timeout(TIMEOUT_MS);\nAbortSignal.timeout(T.TIMEOUT_MS);\nAbortSignal.timeout(fallback);\n',
    );
    execFileSync("git", ["init"], { cwd: exportDir, stdio: "ignore" });
    execFileSync("git", ["add", "src"], { cwd: exportDir, stdio: "ignore" });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--no-gpg-sign", "-m", "t"], {
      cwd: exportDir, stdio: "ignore",
    });
    const exported = enumerateRepository({ repo: exportDir, inputs: ["src"] });
    const cRows = exported.filter(row => row.file === "src/c.ts" && row.name === "AbortSignal.timeout");
    assert.deepEqual(cRows.map(row => row.value_ms).sort((a, b) => a - b), [4_000, 9_000, 9_000]);
  } finally {
    await rm(exportDir, { recursive: true, force: true });
  }

  const nested = enumerateText(
    "two.ts",
    "function a() { const TIMEOUT_MS = 1000; AbortSignal.timeout(TIMEOUT_MS); }\nfunction b() { const TIMEOUT_MS = 2000; AbortSignal.timeout(TIMEOUT_MS); }\n",
  );
  assert.deepEqual(
    nested.filter(row => row.name === "AbortSignal.timeout").map(row => row.value_ms),
    [1_000, 2_000],
  );

  const indexDir = await mkdtemp(join(tmpdir(), "timeout-table-index-"));
  try {
    await mkdir(join(indexDir, "src/config"), { recursive: true });
    await writeFile(join(indexDir, "src/config/index.ts"), "export const DEFAULT_TIMEOUT_MS = 7_000;\nexport const OTHER_TIMEOUT_MS = 8_000;\n");
    await writeFile(join(indexDir, "src/barrel.ts"), 'export * from "./config";\n');
    await writeFile(
      join(indexDir, "src/use.ts"),
      'import { DEFAULT_TIMEOUT_MS } from "./config";\nimport { OTHER_TIMEOUT_MS } from "./barrel";\nAbortSignal.timeout(DEFAULT_TIMEOUT_MS);\nAbortSignal.timeout(OTHER_TIMEOUT_MS);\n',
    );
    execFileSync("git", ["init"], { cwd: indexDir, stdio: "ignore" });
    execFileSync("git", ["add", "src"], { cwd: indexDir, stdio: "ignore" });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--no-gpg-sign", "-m", "t"], {
      cwd: indexDir, stdio: "ignore",
    });
    const indexed = enumerateRepository({ repo: indexDir, inputs: ["src"] });
    const useRows = indexed.filter(row => row.file === "src/use.ts" && row.name === "AbortSignal.timeout");
    assert.deepEqual(useRows.map(row => row.value_ms).sort((a, b) => a - b), [7_000, 8_000]);
  } finally {
    await rm(indexDir, { recursive: true, force: true });
  }

  const starDefaultDir = await mkdtemp(join(tmpdir(), "timeout-table-star-default-"));
  try {
    await mkdir(join(starDefaultDir, "src"), { recursive: true });
    await writeFile(join(starDefaultDir, "src/mod.ts"), "export const TIMEOUT_MS = 9_000;\nexport default 4_000;\n");
    await writeFile(join(starDefaultDir, "src/barrel.ts"), 'export * from "./mod.ts";\n');
    await writeFile(
      join(starDefaultDir, "src/use.ts"),
      'import fallback from "./barrel.ts";\nimport { TIMEOUT_MS } from "./barrel.ts";\nAbortSignal.timeout(fallback);\nAbortSignal.timeout(TIMEOUT_MS);\n',
    );
    execFileSync("git", ["init"], { cwd: starDefaultDir, stdio: "ignore" });
    execFileSync("git", ["add", "src"], { cwd: starDefaultDir, stdio: "ignore" });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--no-gpg-sign", "-m", "t"], {
      cwd: starDefaultDir, stdio: "ignore",
    });
    const starred = enumerateRepository({ repo: starDefaultDir, inputs: ["src"] });
    const useStar = starred.filter(row => row.file === "src/use.ts" && row.name === "AbortSignal.timeout");
    assert.deepEqual(useStar.map(row => row.value_ms), [9_000]);
  } finally {
    await rm(starDefaultDir, { recursive: true, force: true });
  }

  const timeoutProperty = enumerateText("fixture.ts", "const x = { timeout: 1500 };");
  assert.equal(timeoutProperty.length, 1);
  assert.equal(timeoutProperty[0]!.value_ms, 1_500);
  assert.equal(
    timeoutProperty[0]!.unit_note,
    "numeric timeout property; milliseconds unless the cited API defines another unit",
  );
});

test("args default to 20 runs and runStatus fails FAIL or unacknowledged NOT MEASURED", async () => {
  assert.throws(
    () => argsOf(["--base-url", "http://127.0.0.1:1", "--profile", "/tmp/x"]),
    /--ref is required/,
  );
  assert.throws(
    () => argsOf(["--base-url", "http://127.0.0.1:1", "--profile", "/tmp/x", "--ref", ""]),
    /--ref is required/,
  );
  const parsed = argsOf(["--base-url", "http://127.0.0.1:1", "--profile", "/tmp/x", "--ref", "HEAD"]);
  assert.equal(parsed.runs, 20);
  assert.equal(parsed.ref, "HEAD");
  assert.equal(sourceRefForRun("HEAD"), null);
  assert.equal(sourceRefForRun("main"), null);
  assert.equal(sourceRefForRun("v0.1.71"), "v0.1.71");
  const id = "fixture.ts:TIMEOUT_MS";
  const inventory = [{ id, file: "fixture.ts", name: "TIMEOUT_MS", line: 1, value_ms: 100, unit_note: "milliseconds" }];
  const mapping = { rows: { [id]: { class: "network-api", scope: "per-request", endpoints: ["/functions/v1/read"], operation: { name: "fixture", class: "safe-read" } } } };
  const fail = runStatus(inventory, mapping, new Map([["fixture", { durations: [70], realTimeouts: 0 }]]));
  assert.deepEqual(fail.fails, [id]);
  const incomplete = {
    rows: { [id]: { class: "network-api", scope: "per-request", endpoints: ["/functions/v1/read"], operation: { name: "fixture", class: "safe-read", measures_guarded_path: false } } },
  };
  const notMeasured = runStatus(inventory, incomplete, new Map([["fixture", { durations: [10], realTimeouts: 0 }]]));
  assert.deepEqual(notMeasured.notMeasured, [id]);
  assert.deepEqual(notMeasured.missing, [id]);
  const acked = runStatus(inventory, incomplete, new Map([["fixture", { durations: [10], realTimeouts: 0 }]]), [id]);
  assert.deepEqual(acked.missing, []);
  const tooSlowIncomplete = runStatus(
    inventory,
    incomplete,
    new Map([["fixture", { durations: [70], realTimeouts: 0 }]]),
    [id],
  );
  assert.deepEqual(tooSlowIncomplete.fails, [id]);
  assert.deepEqual(tooSlowIncomplete.notMeasured, []);
  assert.deepEqual(tooSlowIncomplete.extra, []);
  assert.equal(rowSummary(inventory[0]!, incomplete.rows[id], { durations: [70], realTimeouts: 0 }).gate, "FAIL");
  const zero = summarize([0, 0, 0, 0, 0], 100);
  assert.equal(zero.gate, "PASS");
  assert.equal(zero.headroom, Infinity);
  const captured = await runChild(process.execPath, ["-e", "process.stdout.write('hello-stdout'); process.stderr.write('hello-stderr');"]);
  assert.equal(captured.stdout, "hello-stdout");
  assert.equal(captured.stderr, "hello-stderr");
  assert.throws(
    () => validateMapping(inventory, {
      version: 2, refs: { HEAD: { rows: {
        [id]: { class: "network-api", scope: "per-request", endpoints: ["/a"], citation: "f:1",
          operation: { class: "safe-read" } },
      } } },
    }, "HEAD"),
    /incomplete operation metadata/,
  );
  const extra = runStatus(inventory, mapping, new Map([["fixture", { durations: [10], realTimeouts: 0 }]]), [id]);
  assert.deepEqual(extra.extra, [id]);
  assert.equal(rowSummary(inventory[0]!, mapping.rows[id], { durations: [10], realTimeouts: 1 }).gate, "FAIL");
  assert.equal(
    rowSummary(inventory[0]!, incomplete.rows[id], { durations: [10], realTimeouts: 1 }).gate,
    "FAIL",
  );
  const proxyNotRun = {
    class: "network-api", scope: "whole-operation", endpoints: ["/functions/v1/read"],
    operation: { name: "hook-check", class: "not-run", proxy_operation: "fixture" },
  };
  assert.equal(
    rowSummary(inventory[0]!, proxyNotRun, { durations: [10], realTimeouts: 1 }).gate,
    "NOT RUN",
  );
  assert.equal(
    rowSummary(inventory[0]!, mapping.rows[id], { durations: [], realTimeouts: 0, attempted: true }).gate,
    "NOT MEASURED",
  );
  const mixedInventory = [
    inventory[0]!,
    { id: "fixture.ts:OTHER_MS", file: "fixture.ts", name: "OTHER_MS", line: 2, value_ms: 100, unit_note: "milliseconds" },
  ];
  assert.throws(
    () => validateMapping(mixedInventory, {
      version: 2, refs: { HEAD: { rows: {
        [id]: { class: "network-api", scope: "per-request", endpoints: ["/a"], citation: "f:1",
          operation: { name: "same", class: "safe-read" } },
        "fixture.ts:OTHER_MS": { class: "network-api", scope: "whole-operation", endpoints: ["/a"], citation: "f:2",
          operation: { name: "same", class: "safe-read" } },
      } } },
    }, "HEAD"),
    /mixed scopes/,
  );
  assert.match(describeOriginWriteRules(), /POST \/functions\/v1\/command/);
  assert.equal(originWriteKind("POST", "/functions/v1/command"), "command");
  assert.equal(originWriteKind("POST", "/functions/v1/read"), null);
  assert.throws(
    () => assertNoOriginWrites([{ method: "POST", path: "/functions/v1/command", status: 200, duration_ms: 1 }], "inbox"),
    /sent a write to the origin/,
  );
});

test("delayed local endpoint makes the rendered row pass below half-budget and fail above it", async (t) => {
  let delay = 15;
  const target = await listen(() => delay);
  t.after(() => target.server.close());
  const durations: number[] = [];
  for (let index = 0; index < 5; index += 1) {
    const started = performance.now();
    const response = await fetch(`${target.url}/functions/v1/read`);
    await response.arrayBuffer();
    durations.push(performance.now() - started);
  }
  assert.equal(summarize(durations, 100).gate, "PASS");

  delay = 70;
  const slow: number[] = [];
  for (let index = 0; index < 5; index += 1) {
    const started = performance.now();
    const response = await fetch(`${target.url}/functions/v1/read`);
    await response.arrayBuffer();
    slow.push(performance.now() - started);
  }
  assert.equal(summarize(slow, 100).gate, "FAIL");
  const nonUniform = [...Array(18).fill(10), 80, 80];
  assert.equal(summarize(nonUniform, 100).gate, "FAIL");
  assert.equal(summarize(nonUniform, 100).p95, 80);

  const id = "fixture.ts:TIMEOUT_MS";
  const mapping = { rows: { [id]: { class: "network-api", scope: "per-request", endpoints: ["/functions/v1/read"], operation: { name: "fixture", class: "safe-read" } } } };
  const inventory = [{ id, file: "fixture.ts", name: "TIMEOUT_MS", line: 1, value_ms: 100, unit_note: "milliseconds" }];
  const failReport = markdownReport({
    baseUrl: target.url, inventory, mapping,
    measurements: new Map([["fixture", { durations: slow, realTimeouts: 0 }]]), startup: null,
  });
  assert.match(failReport, /\| FAIL \|/);
  const passReport = markdownReport({
    baseUrl: target.url, inventory, mapping,
    measurements: new Map([["fixture", { durations, realTimeouts: 0 }]]), startup: null,
  });
  assert.match(passReport, /\| PASS \|/);
});

test("preload rewrites only the origin and logs no header, body, query, or secret", async (t) => {
  const original = await listen(() => 0);
  const target = await listen(() => 5);
  t.after(() => original.server.close());
  t.after(() => target.server.close());
  const directory = await mkdtemp(join(tmpdir(), "timeout-preload-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const log = join(directory, "fetch.jsonl");
  await writeFile(log, "", { mode: 0o600 });
  const code = `fetch(${JSON.stringify(`${original.url}/functions/v1/read?token=query-secret`)},{method:'POST',headers:{authorization:'Bearer secret-shaped-value'},body:'body-secret'}).then(r=>r.arrayBuffer()).then(()=>process.exit(0),()=>process.exit(1))`;
  const result = await runChild(process.execPath, ["-e", code], { env: {
    ...process.env,
    NODE_OPTIONS: `--require=${join(repo, "scripts/timeout-table/preload.cjs")}`,
    TIMEOUT_TABLE_BASE_URL: target.url,
    TIMEOUT_TABLE_PROFILE_ORIGIN: original.url,
    TIMEOUT_TABLE_FETCH_LOG: log,
  } });
  assert.equal(result.code, 0);
  assert.equal(original.requests, 0);
  assert.equal(target.requests, 1);
  assert.equal(target.receivedSecret, true);
  const raw = await readFile(log, "utf8");
  assert.doesNotMatch(raw, /secret|token|authorization|header|body|query/i);
  assert.deepEqual((await readJsonLines(log)).map(row => ({ method: row.method, path: row.path, status: row.status })),
    [{ method: "POST", path: "/functions/v1/read", status: 200 }]);
});

test("preload duration includes the response body and does not forward writes or other origins", async (t) => {
  const original = await listen(() => 0);
  let commandHits = 0;
  let otherHits = 0;
  const bodyTarget = createServer((request, response) => {
    if ((request.url ?? "").startsWith("/functions/v1/command")) {
      commandHits += 1;
      response.writeHead(200); response.end("{}");
      return;
    }
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.write("head");
    setTimeout(() => { response.end("x".repeat(32)); }, 120);
  });
  bodyTarget.listen(0, "127.0.0.1");
  await once(bodyTarget, "listening");
  const other = createServer((_request, response) => {
    otherHits += 1;
    response.writeHead(200); response.end("{}");
  });
  other.listen(0, "127.0.0.1");
  await once(other, "listening");
  t.after(() => original.server.close());
  t.after(() => bodyTarget.close());
  t.after(() => other.close());
  const bodyAddress = bodyTarget.address();
  const otherAddress = other.address();
  assert.ok(bodyAddress && typeof bodyAddress === "object");
  assert.ok(otherAddress && typeof otherAddress === "object");
  const bodyUrl = `http://127.0.0.1:${bodyAddress.port}`;
  const otherUrl = `http://127.0.0.1:${otherAddress.port}`;
  const directory = await mkdtemp(join(tmpdir(), "timeout-preload-body-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const log = join(directory, "fetch.jsonl");
  await writeFile(log, "", { mode: 0o600 });
  const env = {
    ...process.env,
    NODE_OPTIONS: `--require=${join(repo, "scripts/timeout-table/preload.cjs")}`,
    TIMEOUT_TABLE_BASE_URL: bodyUrl,
    TIMEOUT_TABLE_PROFILE_ORIGIN: original.url,
    TIMEOUT_TABLE_FETCH_LOG: log,
  };
  const body = await runChild(process.execPath, ["-e",
    `fetch(${JSON.stringify(`${original.url}/functions/v1/read`)}).then(r=>r.arrayBuffer()).then(()=>process.exit(0),()=>process.exit(1))`], { env });
  assert.equal(body.code, 0);
  const bodyRow = (await readJsonLines(log)).at(-1);
  assert.ok((bodyRow?.duration_ms ?? 0) >= 100, `body duration ${bodyRow?.duration_ms}`);

  const write = await runChild(process.execPath, ["-e",
    `fetch(${JSON.stringify(`${original.url}/functions/v1/command`)},{method:'POST',body:'{}'}).then(()=>process.exit(0),()=>process.exit(1))`], { env });
  assert.notEqual(write.code, 0);
  assert.equal(commandHits, 0);
  assert.equal(originWriteKind("POST", "/functions/v1/command"), "command");

  const leaked = await runChild(process.execPath, ["-e",
    `fetch(${JSON.stringify(`${otherUrl}/storage/v1/object`)}).then(()=>process.exit(0),()=>process.exit(1))`], { env });
  assert.notEqual(leaked.code, 0);
  assert.equal(otherHits, 0);

  const relative = await runChild(process.execPath, ["-e",
    "fetch('/functions/v1/read').then(()=>process.exit(0),()=>process.exit(1))"], { env });
  assert.notEqual(relative.code, 0);
  const relativeRows = await readJsonLines(log);
  assert.equal(relativeRows.some(row => row.path === "/functions/v1/read" && row.status === "BLOCKED"), true);

  const relativeQuery = await runChild(process.execPath, ["-e",
    "fetch('/api/query?token=secret123').then(()=>process.exit(0),()=>process.exit(1))"], { env });
  assert.notEqual(relativeQuery.code, 0);
  const queryLog = await readFile(log, "utf8");
  assert.doesNotMatch(queryLog, /secret123|token=/);
  const queryRows = await readJsonLines(log);
  assert.equal(queryRows.some(row => row.path === "/api/query" && row.status === "BLOCKED"), true);

  const relativeWs = await runChild(process.execPath, ["-e", `
    try { new WebSocket("/realtime/v1/websocket?token=ws-secret"); process.exit(0); }
    catch { process.exit(2); }
  `], { env });
  assert.equal(relativeWs.code, 2);
  const wsLog = await readFile(log, "utf8");
  assert.doesNotMatch(wsLog, /ws-secret|token=/);
  const wsRows = await readJsonLines(log);
  assert.equal(wsRows.some(row => row.method === "CONNECT" && row.path === "/realtime/v1/websocket" && row.status === "BLOCKED"), true);
});

test("private profile copy is removed after success and injected failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "timeout-profile-test-"));
  await chmod(directory, 0o700);
  const credential = join(directory, "credential.json");
  const profile = join(directory, "profile.json");
  await writeFile(credential, '{"token":"secret-shaped-value","expires_at":"2099-01-01T00:00:00Z"}', { mode: 0o600 });
  await writeFile(join(directory, "sibling-secret.txt"), "other-secret", { mode: 0o600 });
  await writeFile(profile, JSON.stringify({ version: 1, url: "http://127.0.0.1:1", anon_key: "public", workspace_id: "00000000-0000-4000-8000-000000000001", principal_id: "00000000-0000-4000-8000-000000000002", credential_file: credential }), { mode: 0o600 });
  try {
    let successRoot = "";
    await withPrivateProfile(profile, async copy => {
      successRoot = copy.root;
      assert.equal((await stat(copy.root)).mode & 0o777, 0o700);
      assert.equal((await stat(copy.profilePath)).mode & 0o777, 0o600);
      assert.notEqual(copy.profile.credential_file, credential);
      assert.doesNotMatch(await readFile(copy.profile.credential_file, "utf8"), /expires_at/);
      await assert.rejects(stat(join(copy.root, "profile", "sibling-secret.txt")), { code: "ENOENT" });
    });
    await assert.rejects(stat(successRoot), { code: "ENOENT" });

    let failureRoot = "";
    await assert.rejects(withPrivateProfile(profile, async copy => {
      failureRoot = copy.root;
      throw new Error("injected failure");
    }), /injected failure/);
    await assert.rejects(stat(failureRoot), { code: "ENOENT" });
    assert.equal(await readFile(credential, "utf8"), '{"token":"secret-shaped-value","expires_at":"2099-01-01T00:00:00Z"}');

    const namedCredential = join(directory, "named-credential.json");
    const profileNamedCredential = join(directory, "credential.json");
    await writeFile(namedCredential, '{"token":"secret-shaped-value"}', { mode: 0o600 });
    await writeFile(profileNamedCredential, JSON.stringify({
      version: 1, url: "http://127.0.0.1:1", anon_key: "public",
      workspace_id: "00000000-0000-4000-8000-000000000001",
      principal_id: "00000000-0000-4000-8000-000000000002",
      credential_file: namedCredential,
    }), { mode: 0o600 });
    await withPrivateProfile(profileNamedCredential, async copy => {
      assert.notEqual(copy.profilePath, copy.profile.credential_file);
      assert.equal((await stat(copy.profilePath)).isFile(), true);
      assert.equal((await stat(copy.profile.credential_file)).isFile(), true);
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function porcelainWorktrees(gitRepo: string): string[] {
  const listed = execFileSync("git", ["-C", gitRepo, "worktree", "list", "--porcelain"], { encoding: "utf8" });
  return listed.split("\n").filter(line => line.startsWith("worktree ")).map(line => line.slice("worktree ".length));
}

async function waitForFile(path: string, timeoutMs = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      await stat(path);
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 15));
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}

type ExitPaths = {
  tempRoot: string;
  worktreePath: string;
  copyRoot: string;
  profilePath: string;
  credentialFile: string;
};

async function spawnExitFixture(t: { after: (fn: () => void) => void }, mode: "exit13" | "sigterm" | "sighup" | "sigint") {
  const home = await mkdtemp(join(tmpdir(), "timeout-table-home-"));
  t.after(() => { rmSync(home, { recursive: true, force: true }); });
  const profileDir = join(home, "profile-src");
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  await chmod(profileDir, 0o700);
  const credential = join(profileDir, "credential.json");
  const profile = join(profileDir, "profile.json");
  const credentialBody = '{"token":"secret-shaped-value","expires_at":"2099-01-01T00:00:00Z"}';
  await writeFile(credential, credentialBody, { mode: 0o600 });
  await writeFile(profile, JSON.stringify({
    version: 1,
    url: "http://127.0.0.1:1",
    anon_key: "public",
    workspace_id: "00000000-0000-4000-8000-000000000001",
    principal_id: "00000000-0000-4000-8000-000000000002",
    credential_file: credential,
  }), { mode: 0o600 });
  const marker = join(home, "marker.json");
  const fixture = join(repo, "tests/p1-cli/timeout-table-exit-fixture.mjs");
  const child = spawn(process.execPath, [fixture, mode, marker, profile, repo], {
    cwd: home,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/local/bin", HOME: home },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", chunk => { stderr += chunk; });
  const killTimer = setTimeout(() => child.kill("SIGKILL"), 20_000);
  const closed = once(child, "close") as Promise<[number | null, NodeJS.Signals | null]>;
  closed.then(() => clearTimeout(killTimer), () => clearTimeout(killTimer));
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  let paths: ExitPaths | null = null;
  t.after(() => {
    if (!paths) return;
    try {
      execFileSync("git", ["-C", repo, "worktree", "remove", "--force", paths.worktreePath], {
        stdio: ["ignore", "ignore", "ignore"],
        timeout: 10_000,
      });
    } catch { /* leftover only if the test failed */ }
    try { rmSync(paths.tempRoot, { recursive: true, force: true }); } catch { /* already gone */ }
  });
  return {
    child, closed, marker, credential, credentialBody,
    get stderr() { return stderr; },
    get paths() { return paths; },
    set paths(value: ExitPaths | null) { paths = value; },
  };
}

async function assertArtifactsPresent(paths: ExitPaths) {
  assert.equal((await stat(paths.tempRoot)).isDirectory(), true);
  assert.equal((await stat(paths.copyRoot)).isDirectory(), true);
  assert.equal((await stat(paths.profilePath)).isFile(), true);
  assert.equal((await stat(paths.credentialFile)).isFile(), true);
  assert.ok(
    porcelainWorktrees(repo).includes(paths.worktreePath),
    `worktree not registered: ${paths.worktreePath}`,
  );
}

async function assertArtifactsGone(paths: ExitPaths) {
  await assert.rejects(stat(paths.tempRoot), { code: "ENOENT" });
  await assert.rejects(stat(paths.copyRoot), { code: "ENOENT" });
  await assert.rejects(stat(paths.profilePath), { code: "ENOENT" });
  await assert.rejects(stat(paths.credentialFile), { code: "ENOENT" });
  assert.ok(
    !porcelainWorktrees(repo).includes(paths.worktreePath),
    `worktree still registered: ${paths.worktreePath}`,
  );
}

test("unexpected exit 13 removes the profile copy and the git worktree", async t => {
  const session = await spawnExitFixture(t, "exit13");
  await waitForFile(session.marker);
  session.paths = JSON.parse(await readFile(session.marker, "utf8")) as ExitPaths;
  await assertArtifactsPresent(session.paths);
  await writeFile(`${session.marker}.go`, "go", { mode: 0o600 });
  const [code, signal] = await session.closed;
  assert.equal(signal, null, session.stderr);
  assert.equal(code, 13, session.stderr);
  await assertArtifactsGone(session.paths);
  assert.equal(await readFile(session.credential, "utf8"), session.credentialBody);
});

test("SIGTERM removes the profile copy and the git worktree", async t => {
  const session = await spawnExitFixture(t, "sigterm");
  await waitForFile(session.marker);
  session.paths = JSON.parse(await readFile(session.marker, "utf8")) as ExitPaths;
  await assertArtifactsPresent(session.paths);
  session.child.kill("SIGTERM");
  const [code, signal] = await session.closed;
  assert.equal(signal, null, session.stderr);
  assert.equal(code, 143, session.stderr);
  await assertArtifactsGone(session.paths);
  assert.equal(await readFile(session.credential, "utf8"), session.credentialBody);
});

test("SIGHUP removes the profile copy and the git worktree", async t => {
  const session = await spawnExitFixture(t, "sighup");
  await waitForFile(session.marker);
  session.paths = JSON.parse(await readFile(session.marker, "utf8")) as ExitPaths;
  await assertArtifactsPresent(session.paths);
  session.child.kill("SIGHUP");
  const [code, signal] = await session.closed;
  assert.equal(signal, null, session.stderr);
  assert.equal(code, 129, session.stderr);
  await assertArtifactsGone(session.paths);
  assert.equal(await readFile(session.credential, "utf8"), session.credentialBody);
});

test("finalizeRunResources deletes the temp root before uninstalling signals", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "timeout-table-finalize-"));
  const resources = { repo, tempRoot, worktreePath: null };
  let uninstalled = false;
  finalizeRunResources(resources, () => {
    assert.equal(existsSync(tempRoot), false, "temp root still present at uninstall");
    uninstalled = true;
  });
  assert.equal(uninstalled, true);
  await assert.rejects(stat(tempRoot), { code: "ENOENT" });
});

test("SIGINT removes the profile copy and the git worktree", async t => {
  const session = await spawnExitFixture(t, "sigint");
  await waitForFile(session.marker);
  session.paths = JSON.parse(await readFile(session.marker, "utf8")) as ExitPaths;
  await assertArtifactsPresent(session.paths);
  session.child.kill("SIGINT");
  const [code, signal] = await session.closed;
  assert.equal(signal, null, session.stderr);
  assert.equal(code, 130, session.stderr);
  await assertArtifactsGone(session.paths);
  assert.equal(await readFile(session.credential, "utf8"), session.credentialBody);
});

test("measurement children do not create or change parent state directories", async t => {
  const sentinel = await mkdtemp(join(tmpdir(), "timeout-table-sentinel-"));
  t.after(() => rm(sentinel, { recursive: true, force: true }));
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(ISOLATED_STATE_ENV)) {
    previous[key] = process.env[key];
    process.env[key] = join(sentinel, key);
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  await writeFile(join(sentinel, "MARKER"), "keep", { mode: 0o600 });
  const copyRoot = await mkdtemp(join(tmpdir(), "timeout-table-isolated-"));
  t.after(() => rm(copyRoot, { recursive: true, force: true }));
  const log = join(copyRoot, "fetch.jsonl");
  await writeFile(log, "", { mode: 0o600 });
  const env = environment("http://127.0.0.1:1", {
    root: copyRoot,
    profile: { url: "http://127.0.0.1:9", anon_key: "public" },
  }, log);
  assert.deepEqual(Object.keys(ISOLATED_STATE_ENV).sort(), [
    "CLAUDE_CONFIG_DIR", "GROK_HOME", "HOME", "SWARM_AGENT_STATE_DIR",
    "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR", "XDG_STATE_HOME",
  ].sort());
  const isolated = isolatedStateEnv(copyRoot);
  for (const key of Object.keys(ISOLATED_STATE_ENV)) {
    assert.equal(env[key], isolated[key], key);
    assert.equal(env[key]!.startsWith(copyRoot), true, key);
    assert.notEqual(env[key], process.env[key], key);
  }
  const script = `
    import { cloudTarget } from ${JSON.stringify(join(repo, "src/cloud/config.ts"))};
    import { agentCredentialStore, defaultAgentCredentialDirectory } from ${JSON.stringify(join(repo, "src/cloud/agent-credential.ts"))};
    import { defaultListenerStateDirectory } from ${JSON.stringify(join(repo, "src/listener/file-store.ts"))};
    import { ensureSecureStateDirectory } from ${JSON.stringify(join(repo, "src/cloud/storage.ts"))};
    const cred = defaultAgentCredentialDirectory();
    const listener = defaultListenerStateDirectory();
    await ensureSecureStateDirectory(listener);
    const store = await agentCredentialStore({
      target: cloudTarget("http://127.0.0.1:1", "public"),
      lineageKey: ${JSON.stringify("a".repeat(32))},
    });
    await store.withLock(async () => {});
    process.stdout.write(JSON.stringify({
      cred, listener,
      swarm: process.env.SWARM_AGENT_STATE_DIR,
      xdg: process.env.XDG_STATE_HOME,
      home: process.env.HOME,
    }));
  `;
  const result = await runChild(process.execPath, ["--import", "tsx", "-e", script], { env });
  assert.equal(result.code, 0, result.stderr);
  const reported = JSON.parse(result.stdout) as { cred: string; listener: string; swarm: string; xdg: string; home: string };
  assert.equal(reported.home, copyRoot);
  assert.equal(reported.swarm.startsWith(copyRoot), true);
  assert.equal(reported.xdg.startsWith(copyRoot), true);
  assert.equal(reported.cred.startsWith(copyRoot), true);
  assert.equal(reported.listener.startsWith(copyRoot), true);
  const listed = execFileSync("find", [sentinel, "-print"], { encoding: "utf8" }).trim().split("\n").sort();
  assert.deepEqual(listed, [sentinel, join(sentinel, "MARKER")].sort());
});

test("runTable does not write to the origin and will not PASS unacknowledged NOT MEASURED rows", async t => {
  const workspace = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const principal = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const writes: string[] = [];
  const server = createServer((request, response) => {
    const url = request.url ?? "";
    if (request.method === "POST" && (url === "/functions/v1/command" || url === "/functions/v1/activity")) {
      writes.push(`${request.method} ${url}`);
    }
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", chunk => { raw += chunk; });
    request.on("end", () => {
      let body: Record<string, unknown> = {};
      try { body = raw ? JSON.parse(raw) as Record<string, unknown> : {}; } catch { body = {}; }
      if (url.startsWith("/auth/v1/settings")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"external":{}}');
        return;
      }
      if (url === "/functions/v1/read" && body.resource === "members") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          members: [],
          agents: [{ principal_id: principal, name: "Agent", owner_user_id: principal }],
          identity: {
            credential_valid: true, principal_id: principal, workspace_id: workspace, owner_user_id: principal,
          },
        }));
        return;
      }
      if (url === "/functions/v1/read" && body.resource === "signals") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          signals: [],
          capabilities: { sender_owner_relation: 1, cursor_after: 1 },
        }));
        return;
      }
      if (url === "/functions/v1/read" && body.resource === "channels") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ channels: [] }));
        return;
      }
      if (url === "/functions/v1/read" && body.resource === "files") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ files: [] }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;
  const home = await mkdtemp(join(tmpdir(), "timeout-table-run-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const sentinel = await mkdtemp(join(tmpdir(), "timeout-table-run-sentinel-"));
  t.after(() => rm(sentinel, { recursive: true, force: true }));
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(ISOLATED_STATE_ENV)) {
    previous[key] = process.env[key];
    process.env[key] = join(sentinel, key);
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  await writeFile(join(sentinel, "MARKER"), "keep", { mode: 0o600 });
  const profileDir = join(home, "profile-src");
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  await chmod(profileDir, 0o700);
  const credential = join(profileDir, "credential.json");
  const profile = join(profileDir, "profile.json");
  await writeFile(credential, JSON.stringify({
    message: AGENT_CREDENTIAL_MESSAGE_D088,
    status: "accepted",
    principal_id: principal,
    token_id: "11111111-1111-4111-8111-111111111111",
    run_id: "22222222-2222-4222-8222-222222222222",
    agent_token: `swm_agt_${"A".repeat(43)}`,
    expires_at: "2099-01-01T00:00:00.000Z",
  }), { mode: 0o600 });
  await writeFile(profile, JSON.stringify({
    version: 1, url, anon_key: "public", workspace_id: workspace, principal_id: principal,
    credential_file: credential,
  }), { mode: 0o600 });
  const checkId = "src/cloud/agent-check-budget.ts:AGENT_CHECK_TIMEOUT_MS";
  const signalId = "src/cloud/signals.ts:SIGNAL_READ_TIMEOUT_MS";
  const channelId = "src/cloud/channels.ts:timeoutMs";
  const incomplete = [checkId, signalId];
  await assert.rejects(runTable({
    baseUrl: url, profile, client: null, runs: 1, pauseMs: 0, ref: "HEAD",
    sourceTimeoutMs: 120_000, mapping: join(repo, "scripts/timeout-table/mapping.json"),
    output: null, acknowledgeNotMeasured: [],
  }), /NOT MEASURED without --acknowledge-not-measured/);
  const result = await runTable({
    baseUrl: url, profile, client: null, runs: 2, pauseMs: 0, ref: "HEAD",
    sourceTimeoutMs: 120_000, mapping: join(repo, "scripts/timeout-table/mapping.json"),
    output: null, acknowledgeNotMeasured: incomplete,
  });
  assert.equal(writes.length, 0);
  assert.match(result.report, /\| NOT MEASURED \|/);
  assert.match(result.report, /signal-read/);
  assert.equal(result.status.fails.length, 0);
  assert.deepEqual([...result.status.notMeasured].sort(), [...incomplete].sort());
  assert.equal((result.measurements.get("auth-settings") as { durations: number[] }).durations.length, 2);

  const silentClient = join(home, "silent-client.mjs");
  await writeFile(silentClient, `process.argv.includes("--version") && process.exit(0);\nprocess.exit(0);\n`, { mode: 0o700 });
  await assert.rejects(runTable({
    baseUrl: url, profile, client: silentClient, runs: 1, pauseMs: 0, ref: "HEAD",
    sourceTimeoutMs: 120_000, mapping: join(repo, "scripts/timeout-table/mapping.json"),
    output: null, acknowledgeNotMeasured: incomplete,
  }), /NOT MEASURED without --acknowledge-not-measured/);
  const silent = await runTable({
    baseUrl: url, profile, client: silentClient, runs: 1, pauseMs: 0, ref: "HEAD",
    sourceTimeoutMs: 120_000, mapping: join(repo, "scripts/timeout-table/mapping.json"),
    output: null, acknowledgeNotMeasured: [...incomplete, channelId, "src/cloud/files.ts:REQUEST_TIMEOUT_MS"],
  });
  assert.match(silent.report, /src\/cloud\/channels.ts:timeoutMs.*NOT MEASURED/);
  assert.equal(silent.status.fails.length, 0);
  assert.ok(silent.status.notMeasured.includes(channelId));

  const timeoutClient = join(home, "timeout-client.mjs");
  await writeFile(timeoutClient, `
if (process.argv.includes("--version")) process.exit(0);
if (process.argv[2] === "check" || process.argv[1] && process.argv.includes("check")) {
  process.stdout.write(JSON.stringify({ error: { code: "check_timeout" } }) + "\\n");
  process.exit(1);
}
process.exit(0);
`, { mode: 0o700 });
  await assert.rejects(runTable({
    baseUrl: url, profile, client: timeoutClient, runs: 1, pauseMs: 0, ref: "HEAD",
    sourceTimeoutMs: 120_000, mapping: join(repo, "scripts/timeout-table/mapping.json"),
    output: null, acknowledgeNotMeasured: [...incomplete, channelId, "src/cloud/files.ts:REQUEST_TIMEOUT_MS"],
  }), (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    assert.match(message, /FAIL rows: .*AGENT_CHECK_TIMEOUT_MS/);
    assert.doesNotMatch(message, /HOOK_CHECK_TIMEOUT_MS/);
    return true;
  });

  const noisyClient = join(home, "noisy-client.mjs");
  await writeFile(noisyClient, `
if (process.argv.includes("--version")) process.exit(0);
process.stderr.write("channel boom\\n");
process.exit(7);
`, { mode: 0o700 });
  await assert.rejects(runTable({
    baseUrl: url, profile, client: noisyClient, runs: 1, pauseMs: 0, ref: "HEAD",
    sourceTimeoutMs: 120_000, mapping: join(repo, "scripts/timeout-table/mapping.json"),
    output: null, acknowledgeNotMeasured: incomplete,
  }), /channel boom/);
  const listed = execFileSync("find", [sentinel, "-print"], { encoding: "utf8" }).trim().split("\n").sort();
  assert.deepEqual(listed, [sentinel, join(sentinel, "MARKER")].sort());
});
