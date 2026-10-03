import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const OAUTH = "docs/evidence/2026-10-02-mcp-auth-release/RELEASE.md";
const EDGE = "docs/evidence/2026-10-02-edge-mcp-release/RELEASE.md";
const DCR = "docs/evidence/2026-10-02-dcr-release/RELEASE-V2.md";
const SITE = "docs/evidence/2026-10-02-site-release/SITE-RELEASE.md";
const inputs = {
  EXPECTED_EDGE_SHA: "a".repeat(40),
  EXPECTED_OAUTH_SHA: "b".repeat(40),
  EXPECTED_OAUTH_IMAGE_DIGEST: `sha256:${"c".repeat(64)}`,
  EXPECTED_SITE_SHA: "d".repeat(40),
  EXPECTED_STACK_SHA: "e".repeat(40),
};
const plans = [
  { file: OAUTH, step: "hm37-oauth-plan-inputs", helper: "oauth_expected_baselines", fields: Object.keys(inputs).slice(0, 3), checks: ["hm37-oauth-preflight", "hm37-oauth-open"] },
  { file: DCR, step: "dcr-oauth-inputs", helper: "dcr_expected_baselines", fields: Object.keys(inputs).slice(0, 3), checks: ["dcr-oauth-preflight", "dcr-oauth-open"] },
  { file: EDGE, step: "edge-mcp-plan-inputs", helper: "edge_expected_baselines", fields: Object.keys(inputs), checks: ["edge-mcp-preflight"] },
];

function block(file: string, step: string): string {
  const matches = [...readFileSync(file, "utf8").matchAll(/^```sh\n([\s\S]*?)^```$/gm)]
    .map((m) => m[1]!).filter((source) => source.split("\n")[0] === `# step: ${step}` || source.split("\n")[0]?.startsWith(`# step: ${step} —`));
  assert.equal(matches.length, 1, `${file}: ${step} must be uniquely marked`);
  return matches[0]!;
}
function bash(source: string, env: Record<string, string> = {}) {
  return spawnSync("/bin/bash", ["-euo", "pipefail"], { encoding: "utf8", input: source, env: { ...process.env, ...env } });
}
function output(result: ReturnType<typeof bash>) { return `${result.stdout}\n${result.stderr}`; }
function cleanup(root: string) {
  assert.match(root, /^\/private\/tmp\/plan-baselines-/);
  const result = spawnSync("rm", ["-rf", "--", root], { encoding: "utf8" });
  assert.equal(result.status, 0, `guarded cleanup refused ${root}: ${result.stderr}`);
}
function helper(plan: typeof plans[number]) {
  const source = block(plan.file, plan.step);
  const start = source.indexOf(`${plan.helper}() {\n`);
  const end = source.indexOf("\n}\n", start);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end + 3);
}

// Only observation adapters are mocked: real directories, symlinks and release
// markers drive Path reads; Docker supplies independent container observations.
const fixtureModule = String.raw`
import json, os, pathlib, subprocess
original_path = pathlib.PosixPath
root = original_path(os.environ['BASELINE_FIXTURE_ROOT'])
def fixture_path(*parts):
    p = original_path(*parts)
    if p.is_absolute() and str(p).startswith(('/home/commonswarm/', '/srv/commonswarm/')):
        return root / str(p).lstrip('/')
    return p
pathlib.Path = fixture_path
original_output = subprocess.check_output
def check_output(command, **kwargs):
    if command[:2] == ['docker', 'inspect']:
        return (root / (command[2] + '.json')).read_bytes()
    return original_output(command, **kwargs)
subprocess.check_output = check_output
`;
function fixture() {
  const root = mkdtempSync("/private/tmp/plan-baselines-");
  for (const [surface, sha] of [["edge", inputs.EXPECTED_EDGE_SHA], ["oauth", inputs.EXPECTED_OAUTH_SHA], ["stack", inputs.EXPECTED_STACK_SHA]]) {
    const release = join(root, "home/commonswarm", surface, "releases", sha!);
    mkdirSync(release, { recursive: true });
    writeFileSync(join(release, "RELEASE_SHA"), `${sha}\n`);
    symlinkSync(release, join(root, "home/commonswarm", surface, "current"));
  }
  const release = join(root, "srv/commonswarm/site/releases", `20261003T000000Z-${inputs.EXPECTED_SITE_SHA.slice(0, 12)}-0123456789abcdef`);
  mkdirSync(release, { recursive: true });
  symlinkSync(release, join(root, "srv/commonswarm/site/current"));
  for (const [container, surface, sha, directory] of [
    ["commonswarm-edge-edge-runtime-1", "edge", inputs.EXPECTED_EDGE_SHA, "edge-runtime"],
    ["commonswarm-oauth-oauth-1", "oauth", inputs.EXPECTED_OAUTH_SHA, "mcp-auth"],
  ]) {
    writeFileSync(join(root, `${container}.json`), JSON.stringify([{ Config: { Labels: {
      "com.docker.compose.project.working_dir": `/home/commonswarm/${surface}/releases/${sha}/deploy/${directory}`,
    } }, Image: inputs.EXPECTED_OAUTH_IMAGE_DIGEST }]));
  }
  writeFileSync(join(root, "sitecustomize.py"), fixtureModule);
  return root;
}

for (const plan of plans) {
  test(`${plan.step} requires full lowercase immutable inputs and rejects each stale live field`, () => {
    const root = fixture();
    try {
      const source = helper(plan);
      const env = { ...inputs, MEASURED_SITE_SHA: inputs.EXPECTED_SITE_SHA, BASELINE_FIXTURE_ROOT: root, PYTHONPATH: root };
      const valid = bash(`${source}\n${plan.helper} validate\n${plan.helper} check\n`, env);
      assert.equal(valid.status, 0, output(valid));
      for (const field of plan.fields) {
        const original = inputs[field as keyof typeof inputs];
        for (const invalid of ["", original.slice(0, -1), original.toUpperCase()]) {
          const result = bash(`${source}\n${plan.helper} validate\n`, { ...env, [field]: invalid });
          assert.notEqual(result.status, 0, `${field} accepted ${invalid}`);
          assert.match(output(result), new RegExp(`FAIL: invalid ${field}; STOP`));
        }
        const stale = field.endsWith("DIGEST") ? `sha256:${"f".repeat(64)}` : "f".repeat(40);
        const result = bash(`${source}\n${plan.helper} check\n`, { ...env, [field]: stale });
        assert.notEqual(result.status, 0, field);
        assert.match(output(result), new RegExp(`${field} expected=${stale} observed=.+; STOP`));
      }
      // A matching source label cannot mask a moved current link or marker.
      for (const surface of ["edge", "oauth"]) {
        const marker = join(root, "home/commonswarm", surface, "releases", inputs[surface === "edge" ? "EXPECTED_EDGE_SHA" : "EXPECTED_OAUTH_SHA"], "RELEASE_SHA");
        const saved = readFileSync(marker, "utf8");
        writeFileSync(marker, `${"f".repeat(40)}\n`);
        const result = bash(`${source}\n${plan.helper} check\n`, env);
        assert.notEqual(result.status, 0);
        assert.match(output(result), new RegExp(`EXPECTED_${surface.toUpperCase()}_SHA expected=.+ observed=${"f".repeat(40)}; STOP`));
        writeFileSync(marker, saved);
        const alternateSha = "f".repeat(40);
        const alternate = join(root, "home/commonswarm", surface, "releases", alternateSha);
        mkdirSync(alternate, { recursive: true });
        const current = join(root, "home/commonswarm", surface, "current");
        assert.equal(spawnSync("ln", ["-sfn", alternate, current]).status, 0);
        const moved = bash(`${source}\n${plan.helper} check\n`, env);
        assert.notEqual(moved.status, 0);
        assert.match(output(moved), new RegExp(`EXPECTED_${surface.toUpperCase()}_SHA expected=.+ observed=${alternateSha}; STOP`));
        assert.equal(spawnSync("ln", ["-sfn", join(root, "home/commonswarm", surface, "releases", inputs[surface === "edge" ? "EXPECTED_EDGE_SHA" : "EXPECTED_OAUTH_SHA"]), current]).status, 0);
      }
      // This source check owns the independent release ordering contract:
      // execution of the validators above is insufficient if preflight omits them.
      for (const step of plan.checks) assert.match(block(plan.file, step), new RegExp(`^${plan.helper} check$`, "m"));
      for (const field of plan.fields) assert.match(block(plan.file, plan.step), new RegExp(`^export .*\\b${field}\\b`, "m"));
    } finally { cleanup(root); }
  });
}

test("DCR checks the exact box migration set, permitting order changes only", () => {
  const root = mkdtempSync("/private/tmp/plan-baselines-");
  try {
    const source = block(DCR, "dcr-preflight");
    const start = source.indexOf("release_psql_ro -Atq --command 'SELECT version FROM supabase_migrations.schema_migrations ORDER BY version;'");
    const end = source.indexOf("\nPYSCHEMA\n", start);
    assert.ok(start >= 0 && end > start);
    const queryAndCheck = source.slice(start, end + "\nPYSCHEMA\n".length);
    const run = (expected: string, observed: string) => {
      writeFileSync(join(root, "catalog.txt"), observed);
      return bash(`release_psql_ro() { cat "$PROOF_DIR/catalog.txt"; }\n${queryAndCheck}`, { PROOF_DIR: root, EXPECTED_SCHEMA_MIGRATIONS: expected });
    };
    assert.equal(run("20261002000001,20260916000001", "20260916000001\n20261002000001\n").status, 0);
    for (const observed of ["20261002000001\n", "20260916000001\n20261002000001\n20261003000001\n", ""]) {
      const result = run("20261002000001,20260916000001", observed);
      assert.notEqual(result.status, 0);
      assert.match(output(result), /EXPECTED_SCHEMA_MIGRATIONS expected=.+ observed=.*; STOP/);
    }
    for (const invalid of ["", "20261002", "20261002000001,", "20261002000001,20261002000001"]) {
      const result = run(invalid, "20261002000001\n");
      assert.notEqual(result.status, 0);
      assert.match(output(result), /invalid EXPECTED_SCHEMA_MIGRATIONS; STOP/);
    }
    const validInputs = { DCR_REVIEWED_CODE_SHA: "a".repeat(40), EXPECTED_SCHEMA_MIGRATIONS: "20261002000001" };
    assert.equal(bash(block(DCR, "dcr-plan-inputs"), validInputs).status, 0);
    for (const field of Object.keys(validInputs)) {
      const result = bash(block(DCR, "dcr-plan-inputs"), { ...validInputs, [field]: "" });
      assert.notEqual(result.status, 0);
      assert.match(output(result), new RegExp(`invalid ${field}; STOP`));
    }
  } finally { cleanup(root); }
});

test("site input and measured-source comparison require the full resolved SHA", () => {
  const env = { EXPECTED_SITE_SHA: inputs.EXPECTED_SITE_SHA };
  assert.equal(bash(block(SITE, "site2-plan-inputs"), env).status, 0);
  for (const invalid of ["", "d".repeat(12), "D".repeat(40)]) {
    const result = bash(block(SITE, "site2-plan-inputs"), { EXPECTED_SITE_SHA: invalid });
    assert.notEqual(result.status, 0);
    assert.match(output(result), /invalid EXPECTED_SITE_SHA; STOP/);
  }
  // Execute the real Git prefix resolution plus the marked comparison for both
  // site and edge, so matching twelve characters alone cannot satisfy the input.
  const observed = spawnSync("git", ["rev-parse", "origin/main"], { encoding: "utf8" }).stdout.trim();
  for (const [file, step, prefixVar, shaVar, expectedVar, repoVar] of [
    [SITE, "site2-01", "source_prefix", "measured_source", "EXPECTED_SITE_SHA", "SITE_RELEASE_REPO"],
    [EDGE, "edge-mcp-transport", "MEASURED_SITE_PREFIX", "MEASURED_SITE_SHA", "EXPECTED_SITE_SHA", ""],
  ]) {
    const source = block(file!, step!);
    const start = source.indexOf(`  ${shaVar}=$(git `);
    const end = source.indexOf("\n  fi", start);
    assert.ok(start >= 0 && end > start);
    const measuredCheck = source.slice(start, end + "\n  fi".length);
    const context = { [prefixVar!]: observed.slice(0, 12), [repoVar || "UNUSED_REPO"]: process.cwd() };
    const valid = bash(measuredCheck, { ...context, [expectedVar!]: observed });
    assert.equal(valid.status, 0, output(valid));
    const mismatch = observed.slice(0, 12) + "0".repeat(28);
    const bad = bash(measuredCheck, { ...context, [expectedVar!]: mismatch });
    assert.notEqual(bad.status, 0);
    assert.match(output(bad), new RegExp(`EXPECTED_SITE_SHA expected=${mismatch} observed=${observed}; STOP`));
  }
});

// This owns the release safety contract: one controller process launches,
// probes and closes the task browser; no block reads a process table, calls a
// setuid tool, or signals a PID it cannot prove it owns.
function siteSources() {
  return [...readFileSync(SITE, "utf8").matchAll(/^```sh\n([\s\S]*?)^```$/gm)].map((m) => m[1]!);
}
const permissionCheck = String.raw`
import os, pathlib, re, shutil, stat, sys
text = sys.stdin.read()
# Shell command positions (including substitutions), plus literal argv lists
# used by embedded Python/JS; an identifier like const at = is not a tool.
name = r"((?:/[\w.+-]+)+|[A-Za-z_][\w.+-]*)"
shell = r"(?:^|[;|&\x60]|(?<![\w.])\(|\b(?:if|then|elif|do|exec|env|command)\s+|!\s+)\s*(?:[A-Za-z_]\w*=\S+\s+)*[\"']?" + name + r"(?=[\s\"'();|&]|$)"
argv = r"(?<![\w])\[\s*[\"']" + name + r"[\"']"
for token in set(re.findall(shell, text, re.M) + re.findall(argv, text)):
    executable = token if token.startswith("/") else shutil.which(token)
    if executable and pathlib.Path(executable).is_file():
        assert not os.stat(executable).st_mode & stat.S_ISUID, "setuid tool forbidden: " + token
`;
const BROWSER_STEPS = ["site2-03-browser-session-preflight", "site2-05-browser-acceptance", "site2-06",
  "site2-browser-close", "site2-07-pre-pin-manifest-close", "site2-07-manifest-close"];

test("site browser lifecycle goes only through the task-browser controller, without ps/pgrep/setuid tools", () => {
  const sources = siteSources();
  for (const source of sources) {
    assert.doesNotMatch(source, /\b(?:ps|pgrep|pkill|killall)\b|\/bin\/ps\b/);
    // No PID-based ownership survives: no kill, libproc, setsid launch or PID window field.
    assert.doesNotMatch(source, /\bkill\s+-|os\.kill|proc_pid|setsid|browser-process\.py|SITE_CHROME_PID/);
  }
  const permissions = spawnSync("python3", ["-c", permissionCheck], { encoding: "utf8", input: sources.join("\n") });
  assert.equal(permissions.status, 0, `${permissions.stdout}\n${permissions.stderr}`);
  // Controls only: use a host setuid executable without ever executing it.
  const forbiddenTool = ["/usr/bin/top", "/usr/bin/su", "/usr/bin/passwd", "/bin/su"]
    .find((path) => existsSync(path) && (statSync(path).mode & 0o4000) !== 0);
  assert.ok(forbiddenTool, "host must supply a setuid file for the refusal control");
  for (const invocation of [forbiddenTool, `FLAG=1 ${forbiddenTool}`, `subprocess.run(["${forbiddenTool}"])`]) {
    const refused = spawnSync("python3", ["-c", permissionCheck], { encoding: "utf8", input: invocation });
    assert.notEqual(refused.status, 0, invocation);
    assert.match(refused.stderr, /setuid tool forbidden/);
  }
  // lsof remains only for site2-01's release-process query.
  assert.deepEqual(sources.filter((text) => /\blsof\b/.test(text)).map((text) => text.split("\n")[0]?.split(" —")[0]),
    ["# step: site2-01"]);
  const preflight = block(SITE, "site2-03-browser-session-preflight");
  assert.match(preflight, /git -C "\$SITE_RELEASE_REPO" cat-file -e HEAD:scripts\/site-task-browser\.mjs/);
  assert.match(preflight, /git -C "\$SITE_RELEASE_REPO" diff --exit-code HEAD -- scripts\/site-task-browser\.mjs/);
  assert.match(preflight, /install -m 0600 "\$SITE_RELEASE_REPO\/scripts\/site-task-browser\.mjs" "\$task_browser"/);
  assert.match(preflight, /case "\$chrome" in "\$HOME\/Library\/Caches\/ms-playwright\/"\*\) ;; \*\) exit 1 ;; esac/);
  // The block never launches Chromium itself: only the controller start does.
  assert.doesNotMatch(preflight, /--headless|"\$chrome" --/);
  assert.equal((preflight.match(/node "\$task_browser" start --state-dir "\$browser_root" --executable "\$chrome"/g) ?? []).length, 1);
  assert.ok(preflight.indexOf('node "$task_browser" close --state-dir "$browser_root"') <
    preflight.indexOf('rm -r -- "$browser_root"'), "failed preflight closes its own browser before removal");
  for (const step of ["site2-05-browser-acceptance", "site2-06"]) {
    assert.match(block(SITE, step), /node "\$SITE_TASK_BROWSER" probe --state-dir "\$SITE_BROWSER_ROOT" https:\/\/commonswarm\.com\/app/);
    assert.doesNotMatch(block(SITE, step), /node "\$SITE_TASK_BROWSER" (?:start|close)/);
  }
  for (const step of ["site2-browser-close", "site2-07-pre-pin-manifest-close", "site2-07-manifest-close"]) {
    const close = block(SITE, step);
    const at = close.indexOf('node "$SITE_TASK_BROWSER" close --state-dir "$SITE_BROWSER_ROOT"');
    assert.ok(at >= 0, `${step} closes through the controller`);
    if (close.includes('rm -r -- "$SITE_BROWSER_ROOT"')) assert.ok(at < close.indexOf('rm -r -- "$SITE_BROWSER_ROOT"'));
    // A browser STOP happens before any box change, so the close stays resumable.
    if (close.includes("ssh -o")) assert.ok(at < close.indexOf("ssh -o"), `${step} closes the browser before the box`);
  }
  for (const step of BROWSER_STEPS) {
    for (const line of block(SITE, step).split("\n").filter((text) => /node "\$(?:SITE_TASK_BROWSER|task_browser)"/.test(text))) {
      assert.match(line, /--state-dir "\$(?:SITE_BROWSER_ROOT|browser_root)"/, `${step}: ${line}`);
    }
  }
});

function heredoc(source: string, opener: RegExp): string {
  const match = source.match(opener);
  assert.ok(match?.index !== undefined, `missing heredoc ${opener}`);
  const body = source.slice(match.index + match[0].length);
  return body.slice(0, body.indexOf("\nPY\n") + 1);
}

test("a browser NOT_PROVED never blocks, rolls back, or prevents a released close", () => {
  const acceptance = block(SITE, "site2-05-browser-acceptance");
  // No box contact at all: browser evidence can never restore the pin.
  assert.doesNotMatch(acceptance, /\bssh\b|ln -s|mv -Tf|>"\$SITE_EVIDENCE\/rollback-auto\.txt"|blocking=yes/);
  assert.doesNotMatch(block(SITE, "site2-06"), /blocking=yes/);
  const receipts = [
    ["site2-05-browser-acceptance", heredoc(acceptance, /python3 - "\$SITE_EVIDENCE" site2-05-browser-acceptance "\$branch" "\$browser_status" <<'PY'\n/)],
    ["site2-06-browser", heredoc(block(SITE, "site2-06"), /python3 - "\$SITE_EVIDENCE" site2-06-browser "\$branch" "\$status" <<'PY'\n/)],
  ] as const;
  const released = heredoc(block(SITE, "site2-07-manifest-close"), /python3 - "\$SITE_EVIDENCE" <<'PY'\n(?=import json,pathlib,re,sys\nroot=pathlib\.Path\(sys\.argv\[1\]\); label="site2-05-browser-acceptance")/);
  const root = mkdtempSync("/private/tmp/plan-baselines-");
  try {
    for (const [label, program] of receipts) {
      const step = label.slice(0, 8);
      for (const [branch, started, code, expected] of [
        ["FULL-CONTROL", true, "1", "NOT_PROVED"], ["FULL-CONTROL", false, "1", "NOT_PROVED"],
        ["REDUCED-CONTROL", true, "7", "NOT_PROVED"], ["FULL-CONTROL", true, "0", "PASS"],
      ] as const) {
        const evidence = join(root, `${label}-${branch}-${started}-${code}`);
        mkdirSync(evidence);
        writeFileSync(join(evidence, `${label}-summary.txt`),
          `${label}: STEP 0 (control setup); exit code pending\n` +
          `STOP ${step}: task-owned Chromium is not running (probe controller-gone)\n`);
        if (started) writeFileSync(join(evidence, `${label}-assertions-started.txt`), "ASSERTIONS_STARTED\n");
        const run = spawnSync("python3", ["-", evidence, label, branch, code], { encoding: "utf8", input: program });
        assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
        const rows = readFileSync(join(evidence, `${label}-receipt.txt`), "utf8").split("\n");
        assert.ok(rows.includes("blocking=no"), `${label} ${branch} ${code}: never blocking`);
        assert.ok(rows.some((row) => row.startsWith(`browser_acceptance=${expected} reason=`)));
        if (code !== "0") {
          assert.ok(rows.includes(`browser_acceptance=NOT_PROVED reason=STOP ${step}: task-owned Chromium is not running (probe controller-gone)`));
        }
        if (label !== "site2-05-browser-acceptance") continue;
        // The released close accepts this receipt in either mode and phase.
        writeFileSync(join(evidence, "site2-03-browser-preflight.json"), JSON.stringify({ branch }));
        if (code === "0") writeFileSync(join(evidence, "site2-05-browser.json"), JSON.stringify({ branch }));
        const close = spawnSync("python3", ["-", evidence], { encoding: "utf8", input: released });
        assert.equal(close.status, 0, `${branch} started=${started}: ${close.stderr}`);
        // Positive control: the same close still refuses a blocking receipt.
        const receipt = join(evidence, `${label}-receipt.txt`);
        writeFileSync(receipt, readFileSync(receipt, "utf8").replace("blocking=no", "blocking=yes"));
        assert.notEqual(spawnSync("python3", ["-", evidence], { encoding: "utf8", input: released }).status, 0);
      }
    }
  } finally { cleanup(root); }
});

test("the plan's browser check turns a missing task browser into a named NOT_PROVED reason", () => {
  const source = block(SITE, "site2-05-browser-acceptance");
  const check = source.match(/ {2}check_task_browser\(\) \{\n[\s\S]*?\n {2}\}\n/)?.[0];
  assert.ok(check, "acceptance defines check_task_browser");
  // The controller insists on its own 0700 anvil-secret root; nothing runs or launches here.
  const browserRoot = mkdtempSync("/private/tmp/anvil-secret.");
  try {
    assert.match(browserRoot, /^\/private\/tmp\/anvil-secret\.[A-Za-z0-9]{6}$/);
    writeFileSync(join(browserRoot, "site-task-browser.mjs"), readFileSync("scripts/site-task-browser.mjs"), { mode: 0o600 });
    const summary = join(browserRoot, "summary.txt");
    const run = (env: Record<string, string>) => spawnSync("/bin/bash", ["-c", `set -euo pipefail\n${check}\ncheck_task_browser`],
      { encoding: "utf8", env: { ...process.env, control_summary: summary, ...env } });
    const missing = run({ SITE_BROWSER_ROOT: browserRoot, SITE_TASK_BROWSER: join(browserRoot, "site-task-browser.mjs"),
      SITE_CHROME_ENDPOINT: "http://127.0.0.1:9" });
    assert.equal(missing.status, 1, missing.stderr);
    assert.equal(readFileSync(summary, "utf8"), "STOP site2-05: task-owned Chromium is not running (probe no-task-browser)\n");
    const unrooted = run({ SITE_BROWSER_ROOT: "/private/tmp/elsewhere", SITE_TASK_BROWSER: "/private/tmp/elsewhere/site-task-browser.mjs" });
    assert.equal(unrooted.status, 1);
    assert.match(readFileSync(summary, "utf8"), /not running \(controller missing\)\n$/);
  } finally {
    assert.match(browserRoot, /^\/private\/tmp\/anvil-secret\.[A-Za-z0-9]{6}$/);
    const removed = spawnSync("rm", ["-rf", "--", browserRoot], { encoding: "utf8" });
    assert.equal(removed.status, 0, removed.stderr);
  }
});
