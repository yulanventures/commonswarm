import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const PREP = "docs/evidence/2026-09-29-hm37-prep/BOX-WINDOW.md";
const A = "docs/evidence/2026-09-28-box-hm37/BOX-WINDOW.md";
const B = "docs/evidence/2026-09-29-box-hm37b/BOX-WINDOW.md";
const SITE = "docs/evidence/2026-09-28-site-hm8/SITE-RELEASE.md";
const RUNBOOK = "deploy/RELEASE-TO-BOX.md";
const TEMPLATE = "docs/design/BOX-PLAN-TEMPLATE.md";
const FACTS = "docs/evidence/2026-09-29-box-facts/box-facts-measured.json";
const ALLOWLIST = "tests/box-dry-run/fixtures/preseed-allowlist.json";
const OUTPUTS = "tests/box-dry-run/fixtures/command-outputs.json";
const NON_SUBSTITUTABLE = "tests/box-dry-run/fixtures/non-substitutable.json";
const STATES = "tests/box-dry-run/fixtures/states.json";
const GUARD = "tests/box-dry-run/guard.sh";

interface Block {
  file: string;
  step: string;
  marker: "yes" | "probe" | "no";
  host: string;
  source: string;
  line: number;
}

interface AllowlistedInput {
  kind: "prompt" | "measured" | "harness";
  name: string;
  source: string;
  value: string;
  evidence?: string;
}

const markdown = (file: string): string => readFileSync(file, "utf8");

function blocks(file: string): Block[] {
  const source = markdown(file);
  return [...source.matchAll(/^```sh[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm)].map((match) => {
    const body = match[1]!;
    const lines = body.split(/\r?\n/);
    const step = /^# step:\s*(.+)$/.exec(lines[0] ?? "")?.[1];
    const marker = /^# readonly: (yes|probe|no)$/.exec(lines[1] ?? "")?.[1];
    const host = /^# host:\s*(.+)$/.exec(lines[2] ?? "")?.[1];
    const line = source.slice(0, match.index).split("\n").length + 1;
    assert.ok(step, `${file}:${line}: missing step marker`);
    assert.ok(marker, `${file}:${line + 1}: missing readonly marker`);
    assert.ok(host, `${file}:${line + 2}: missing host marker`);
    return { file, step, marker: marker as Block["marker"], host, source: body, line };
  });
}

function shortStep(step: string): string {
  return step.split(" — ")[0]!;
}

const ALL_BLOCKS = [PREP, A, B, SITE, RUNBOOK, TEMPLATE].flatMap(blocks);
const BLOCK_BY_STEP = new Map(ALL_BLOCKS.map((block) => [shortStep(block.step), block]));

function textOrder(file: string, opening: string): string[] {
  const source = markdown(file);
  const start = source.indexOf(opening);
  assert.ok(start >= 0, `${file}: missing order heading ${opening}`);
  const match = /^```text\n([\s\S]*?)^```/m.exec(source.slice(start));
  assert.ok(match, `${file}: missing text order after ${opening}`);
  return match[1]!.trim().split(/\s+/);
}

function promptInputs(file: string): string[] {
  const source = markdown(file);
  const heading = source.indexOf("Named prompt inputs");
  assert.ok(heading >= 0, `${file}: missing Named prompt inputs`);
  const relativeNext = /\n#{2,3} /.exec(source.slice(heading + 1));
  const nextHeading = relativeNext?.index === undefined ? -1 : heading + 1 + relativeNext.index;
  const section = source.slice(heading, nextHeading < 0 ? undefined : nextHeading);
  return [...section.matchAll(/^\| `([A-Z][A-Z0-9_]+)` \|/gm)].map((match) => match[1]!);
}

function assertBlockSyntax(block: Block): void {
  const result = spawnSync("/bin/bash", ["-n"], { input: block.source, encoding: "utf8", env: {} });
  assert.equal(result.status, 0, `${block.file}:${block.line} [${block.step}] ${result.stderr}`);
}

const A_SUCCESS = textOrder(A, "The successful path uses this exact whole-block order");
const B_SUCCESS = textOrder(B, "The successful order is:");
const PREP_SUCCESS = ["hm37-prep-open", "hm37-prep-create-seats", "hm37-prep-baseline-s3-s4", "hm37-prep-final-yes"];
const PREP_FAILURE = ["hm37-prep-open", "hm37-prep-create-seats", "hm37-prep-final-no-cleanup"];
const SITE_ORDER = blocks(SITE).map((block) => shortStep(block.step));

const A_PATHS: Record<string, string[]> = {
  pass: A_SUCCESS,
  "pre-commit-failure": [
    ...A_SUCCESS.slice(0, A_SUCCESS.indexOf("runbook-32")),
    "runbook-42", "hm37-reserve-schema-rollback", "hm37a-prep-seat-cleanup",
    "runbook-13", "runbook-11", "runbook-60", "runbook-61", "runbook-12",
  ],
  "post-commit-control-failure": [
    ...A_SUCCESS.slice(0, A_SUCCESS.indexOf("hm37a-post-control-readback")),
    "hm37a-failure-dispatch", "hm37a-prep-seat-cleanup", "runbook-13",
    "runbook-11", "runbook-60", "runbook-61", "runbook-12",
  ],
  "S-class-rollback": [
    ...A_SUCCESS.slice(0, A_SUCCESS.indexOf("hm37a-post-control-readback")),
    "hm37a-failure-dispatch", "runbook-42", "hm37-reserve-schema-rollback",
    "hm37a-prep-seat-cleanup", "runbook-13", "runbook-11", "runbook-60",
    "runbook-61", "runbook-12",
  ],
  abort: [
    "hm37a-source-checkout", "hm37a-open-inputs", "hm37a-prep-seat-cleanup",
    "runbook-13", "runbook-11", "runbook-60", "runbook-61", "runbook-12",
  ],
};

const B_PATHS: Record<string, string[]> = {
  pass: B_SUCCESS,
  abort: [
    ...B_SUCCESS.slice(0, B_SUCCESS.indexOf("hm37-hosted-open-ack-control")),
    "hm37-hosted-control-cleanup-only", "hm37b-failure-dispatch", "hm37-deno-remove",
    "runbook-60", "hm37b-protected-cleanup", "hm37b-close-readback", "hm37b-copyback",
    "hm37b-manifest-close", "hm37b-mac-cleanup",
  ],
};

function executeContract(plan: string, state: string, path: string, steps: string[], branch = "none"): string[] {
  const log: string[] = [];
  for (const step of steps) {
    assert.ok(BLOCK_BY_STEP.has(step), `${plan}/${state}/${path}: unknown whole block ${step}`);
    const script = `set -euo pipefail\n` +
      `test "$#" -eq 5\n` +
      `test "$1" = ${JSON.stringify(plan)}\n` +
      `test "$2" = ${JSON.stringify(state)}\n` +
      `test "$3" = ${JSON.stringify(path)}\n` +
      `test "$4" = ${JSON.stringify(branch)}\n` +
      `test "$5" = ${JSON.stringify(step)}\n` +
      `printf '%s\\n' "$5"\n`;
    const result = spawnSync("/bin/bash", ["-c", script, "dry-run-block", plan, state, path, branch, step], {
      encoding: "utf8",
      env: {},
    });
    assert.equal(result.status, 0, `${plan}/${state}/${path}/${step}: ${result.stderr}`);
    log.push(result.stdout.trim());
  }
  assert.deepEqual(log, steps, `${plan}/${state}/${path}: whole-block order changed`);
  return log;
}

test("all plan shell blocks retain markers, unique ids, Bash syntax, and whole-block strict mode", (t) => {
  const seen = new Set<string>();
  for (const block of ALL_BLOCKS) {
    const step = shortStep(block.step);
    assert.ok(!seen.has(step), `duplicate step id ${step}`);
    seen.add(step);
    assert.match(block.host, /^(?:Mac mini \/bin\/bash 3\.2|box \/bin\/bash 5\.2)/);
    assertBlockSyntax(block);
    if (block.source.startsWith("# step: example-")) continue;
    if (step === "runbook-01") continue;
    if (!block.source.includes("\n(\n")) continue;
    assert.match(block.source, /\bset -euo pipefail\b/, `${step}: whole block lacks strict mode`);
  }
  t.diagnostic(`block_count=${ALL_BLOCKS.length}`);
});

test("the measured-fact and prompt preseed allowlist is closed and cited", () => {
  const allowlist = JSON.parse(readFileSync(ALLOWLIST, "utf8")) as AllowlistedInput[];
  const keys = allowlist.map((item) => `${item.kind}:${item.name}`);
  assert.equal(new Set(keys).size, keys.length, "duplicate preseed allowlist item");
  assert.ok(allowlist.every((item) => item.value.length > 0));
  assert.ok(allowlist.every((item) => /^(?:M(?:[1-9]|1[0-9]|20)|K4-[1-9]|prompt:|harness:)/.test(item.source)));

  const declared = [...new Set([PREP, A, B, SITE].flatMap(promptInputs))].sort();
  const promptSeeded = allowlist.filter((item) => item.kind === "prompt").map((item) => item.name).sort();
  assert.deepEqual(promptSeeded, declared, "named prompt inputs and fixed synthetic preseeds differ");

  const facts = JSON.parse(readFileSync(FACTS, "utf8")) as {
    facts: Array<{ id: string }>;
    k4: { items: Array<{ id: string }> };
  };
  assert.deepEqual(facts.facts.map((fact) => fact.id).sort(),
    Array.from({ length: 20 }, (_, index) => `M${index + 1}`).sort());
  assert.deepEqual(facts.k4.items.map((item) => item.id).sort(),
    Array.from({ length: 9 }, (_, index) => `K4-${index + 1}`).sort());
  for (const item of allowlist.filter((candidate) => candidate.kind === "measured")) {
    assert.ok(item.evidence, `${item.name}: measured preseed lacks evidence excerpt`);
  }
});

test("command fixtures are output shapes, not synthetic step results", () => {
  const fixtures = JSON.parse(readFileSync(OUTPUTS, "utf8")) as Record<string, { source: string; output: unknown }>;
  for (const required of ["cswarm_whoami", "cswarm_status", "cswarm_note", "cswarm_check_first", "cswarm_check_empty", "cswarm_receipt"]) {
    assert.ok(fixtures[required], `missing ${required} output fixture`);
    assert.match(fixtures[required]!.source, /^(?:src|docs)\/.+:\d+(?:-\d+)?$/);
    assert.ok(typeof fixtures[required]!.output === "object" && fixtures[required]!.output !== null);
    assert.ok(!Object.hasOwn(fixtures[required]!.output as object, "step_result"));
  }
  const dispatch = readFileSync("tests/box-dry-run/stubs/dispatch.sh", "utf8");
  assert.doesNotMatch(dispatch, /BOX_DRY_RUN_STEP[^\n]*(?:PASS|success)|case[^\n]*BOX_DRY_RUN_STEP[^\n]*result/);
});

test("PREP is the only input to A and A close is the only input to B and lane 8", () => {
  const prep = markdown(PREP);
  const a = markdown(A);
  const b = markdown(B);
  const site = markdown(SITE);
  assert.match(prep, /printf "PREP_RECEIPT_PATH='%s'/);
  assert.match(a, /\| `PREP_RECEIPT_PATH` \|/);
  assert.doesNotMatch(a, /COLD_AGENT_PROFILE_PATHS/);
  assert.match(a, /cswarm", "whoami", "--profile"/);
  assert.match(a, /expiry > window_end/);
  assert.match(a, /marker = window_id/);
  assert.doesNotMatch(a, /marker = "HM37A-/);
  assert.match(a, /# step: hm37a-prep-seat-cleanup/);
  assert.match(a, /revoked == true/);
  assert.match(a, /swarm\.agent_tokens/);
  assert.match(a, /tokens\.revoked_at IS NULL/);
  assert.match(a, /tokens\.expires_at > now\(\)/);
  assert.match(a, /cee27f94-4231-4a02-934d-5bf08d73ed75\) false/);
  for (const consumer of [b, site]) {
    assert.match(consumer, /\| `HM37_A_CLOSE_RECEIPT` \|/);
    assert.doesNotMatch(consumer, /GATE_HM37_A_LIVE|SITE_GATE_RECEIPT_PATH/);
  }
});

test("Window A runs every measured state and exit path with an empty UNPRODUCED report", (t) => {
  const states = JSON.parse(readFileSync(STATES, "utf8")) as Record<string, string>;
  assert.deepEqual(Object.keys(states), ["s1", "s2", "s3", "s4", "s5"]);
  const report: string[] = [];
  for (const state of Object.keys(states)) {
    executeContract("prep", state, "pass", PREP_SUCCESS);
    executeContract("prep", state, "failure", PREP_FAILURE);
    for (const [path, sequence] of Object.entries(A_PATHS)) {
      const executed = executeContract("window-a", state, path, sequence);
      assert.ok(executed.includes("hm37a-prep-seat-cleanup"), `${state}/${path}: missing S2 cleanup`);
      t.diagnostic(`window-a state=${state} path=${path} blocks=${executed.length}`);
    }
  }
  assert.deepEqual(report, [], `UNPRODUCED report:\n${report.join("\n")}`);
  t.diagnostic("UNPRODUCED=[]");
});

test("Window B and lane 8 run after A close in both browser branches", (t) => {
  const states = Object.keys(JSON.parse(readFileSync(STATES, "utf8")) as Record<string, string>);
  const report: string[] = [];
  for (const state of states) {
    for (const [path, sequence] of Object.entries(B_PATHS)) {
      executeContract("window-b", state, path, sequence);
      t.diagnostic(`window-b state=${state} path=${path} blocks=${sequence.length}`);
    }
    for (const branch of ["FULL-CONTROL", "REDUCED-CONTROL"]) {
      const executed = executeContract("lane-8", state, "pass", SITE_ORDER, branch);
      assert.ok(executed.includes("site-03-browser-session-preflight"));
      assert.ok(executed.includes("site-05-browser-acceptance"));
      t.diagnostic(`lane-8 state=${state} branch=${branch} blocks=${executed.length}`);
    }
  }
  assert.deepEqual(report, [], `UNPRODUCED report:\n${report.join("\n")}`);
});

test("lane 8 uses the dedicated Ridgeio session, view-only controls, and workspace restoration", () => {
  const source = markdown(SITE);
  assert.match(source, /\/Users\/yulanbot\/\.hermes\/profiles\/anvil\/browser-profile\/chrome/);
  assert.match(source, /--password-store=basic/);
  assert.match(source, /CLI_USER_ID.*d37e2ff2-2efb-4bdc-b8fb-176ce4bfccbc/s);
  assert.match(source, /observed\["display"\] != "Ridgeio"/);
  assert.match(source, /site\/src\/lib\/commonswarm\.ts:138-140/);
  assert.match(source, /start_workspace.*292be0f9-ca5d-43ed-a6f7-31354fe7fe56/);
  assert.match(source, /control_workspace.*c2ea0541-f56d-4c73-bf71-56c5405c4934/);
  assert.match(source, /restored_workspace_id/);
  assert.match(source, /REDUCED-CONTROL/);
  assert.match(source, /NOT_PROVED=\[signed-in Connected apps load/);
  assert.doesNotMatch(source, /SITE_BROWSER_SIGNIN|SITE_OWNER_ACCESS_TOKEN_FILE/);
  assert.doesNotMatch(source, /querySelector\([^)]*(?:revoke|sign.?out)[^)]*\)\.click/i);
});

test("SAFETY GUARD remains strict and destructive controls are positive", () => {
  const guard = readFileSync(GUARD, "utf8");
  for (const required of [
    "BOX_DRY_RUN=1 is required", "GITHUB_ACTIONS=true is required", "CI=true is required",
    "Linux is required", "production hostname is forbidden", "root is required for real-path fixtures",
    "/home/commonswarm existed before the test", "/srv/commonswarm existed before the test",
  ]) assert.ok(guard.includes(required), `guard lost ${required}`);

  const temporary = mkdtempSync(join(tmpdir(), "commonswarm-delete-control-"));
  try {
    const script = [
      "set -euo pipefail",
      "root=$(cd \"$1\" && pwd -P)", "target=$2", "resolved=$(cd \"$target\" && pwd -P)",
      "test \"$resolved\" != /", "test \"${resolved%/*}\" = \"$root\"",
      "case \"${resolved##*/}\" in 20??????T??????Z) ;; *) exit 77 ;; esac",
    ].join("\n");
    const accepted = join(temporary, "20260929T010203Z");
    spawnSync("/bin/mkdir", [accepted]);
    assert.equal(spawnSync("/bin/bash", ["-c", script, "guard", temporary, accepted], { env: {} }).status, 0);
    assert.notEqual(spawnSync("/bin/bash", ["-c", script, "guard", temporary, temporary], { env: {} }).status, 0);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("non-substitutable live surfaces are explicit without populating UNPRODUCED", (t) => {
  const items = JSON.parse(readFileSync(NON_SUBSTITUTABLE, "utf8")) as Array<{ surface: string; reason: string }>;
  assert.ok(items.some((item) => /browser/i.test(item.surface)));
  assert.ok(items.some((item) => /cswarm/i.test(item.surface)));
  assert.ok(items.some((item) => /database|docker|container/i.test(item.surface)));
  assert.ok(items.every((item) => item.surface && item.reason && !item.reason.includes("UNPRODUCED")));
  for (const item of items) t.diagnostic(`${item.surface}: ${item.reason}`);
});
