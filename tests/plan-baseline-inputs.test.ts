import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
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

// This owns the release safety contract: executable-path ownership must work
// without setuid process tools, and a stale receipt must never authorize a kill.
test("site browser cleanup uses recorded PID/path and never signals an unverified process", () => {
  const sources = [...readFileSync(SITE, "utf8").matchAll(/^```sh\n([\s\S]*?)^```$/gm)].map((m) => m[1]!);
  for (const source of sources) assert.doesNotMatch(source, /\b(?:ps|pgrep)\b/);
  const preflight = block(SITE, "site2-03-browser-session-preflight");
  const source = preflight.match(/cat >"\$browser_root\/browser-process\.py" <<'PY'\n([\s\S]*?)\nPY\n/)?.[1];
  assert.ok(source, "preflight must stage the browser ownership helper");
  assert.match(source, /proc_pidpath/);
  assert.match(source, /ms-playwright/);
  assert.match(source, /os\.kill\([^\n]+, 0\)/);
  assert.match(preflight, /chrome_pid=\$!/);
  assert.match(preflight, /browser-process\.py" record/);
  for (const step of ["site2-05-browser-acceptance", "site2-06"]) {
    assert.match(block(SITE, step), /kill -0 "\$SITE_CHROME_PID"/);
    assert.match(block(SITE, step), /browser-process\.py" check/);
  }
  for (const step of ["site2-07-pre-pin-manifest-close", "site2-07-manifest-close"]) {
    const close = block(SITE, step);
    assert.ok(close.indexOf('browser-process.py" stop') < close.indexOf('rm -r -- "$SITE_BROWSER_ROOT"'));
    assert.match(close, /browser-process\.py" stop "\$SITE_BROWSER_ROOT" "\$SITE_CHROME_PID"/);
  }
  const root = mkdtempSync("/private/tmp/plan-baselines-");
  try {
    const script = join(root, "browser-process.py");
    writeFileSync(script, source, { mode: 0o600 });
    // Mock only OS observations. Execute the exact staged helper and persist its
    // real receipt; signal observations prove refusal, TERM and KILL ordering.
    const result = spawnSync("python3", ["-", script, root], { encoding: "utf8", input: String.raw`
import ctypes, errno, json, os, pathlib, runpy, signal, sys, time
script, root = sys.argv[1:]
root = pathlib.Path(root)
binary = str(pathlib.Path.home() / "Library/Caches/ms-playwright/control/chrome")
profile = str(root / "browser-profile")
receipt = root / "browser-process.json"
state = {}
class PathReader:
    def __call__(self, pid, buffer, size):
        state["path_reads"] += 1
        if state.get("path_unavailable"): return 0
        if state.get("reuse_before_term") and state["path_reads"] >= 2: state["path"] = "/bin/sleep"
        buffer.value = state["path"].encode()
        return len(buffer.value)
class Libproc:
    proc_pidpath = PathReader()
ctypes.CDLL = lambda *args, **kwargs: Libproc()
def kill(pid, sig):
    assert pid == 424242
    if sig == 0:
        if state.get("denied"): raise PermissionError(errno.EPERM, "denied")
        if not state["alive"]: raise ProcessLookupError(errno.ESRCH, "gone")
    else:
        state["signals"].append(sig)
        if sig == signal.SIGKILL and not state.get("ignore_kill") or sig == signal.SIGTERM and not state.get("ignore_term"):
            state["alive"] = False
        if state.get("reuse_after_term"): state["path"] = "/bin/sleep"
os.kill = kill
time.sleep = lambda seconds: None
def reset(**changes):
    state.clear()
    state.update(alive=True, path=binary, signals=[], path_reads=0)
    state.update(changes)
def run(mode, ok):
    sys.argv = [script, mode, str(root), "424242", binary, profile]
    try:
        runpy.run_path(script, run_name="__main__")
    except SystemExit as error:
        assert not ok, str(error)
        assert "STOP" in str(error) and "pid" in str(error).lower() and "executable_path" in str(error)
    else:
        assert ok, mode + " unexpectedly passed"
reset()
run("record", True)
saved = receipt.read_text()
assert receipt.stat().st_mode & 0o777 == 0o600
assert json.loads(saved)["pid"] == 424242
assert json.loads(saved)["executable_path"] == binary
run("check", True)
assert state["signals"] == []
for changes in ({"alive": False}, {"path": "/bin/sleep"}, {"path": binary + "-reused"},
                {"denied": True}, {"path_unavailable": True}, {"reuse_before_term": True}):
    reset(**changes)
    run("stop", not state["alive"])
    assert state["signals"] == []
    if not state["alive"]: assert state["path_reads"] == 0
for field, value in (("pid", 424243), ("executable_path", binary + "-reused")):
    wrong = json.loads(saved); wrong[field] = value
    receipt.write_text(json.dumps(wrong))
    reset(); run("stop", False)
    assert state["signals"] == []
receipt.write_text(saved)
for changes, expected in (({}, [signal.SIGTERM]), ({"ignore_term": True}, [signal.SIGTERM, signal.SIGKILL])):
    reset(**changes); run("stop", True)
    assert state["signals"] == expected and not state["alive"]
reset(ignore_term=True, reuse_after_term=True)
run("stop", False)
assert state["signals"] == [signal.SIGTERM], "reused PID must not receive SIGKILL"
reset(ignore_term=True, ignore_kill=True)
run("stop", False)
assert state["alive"] and state["signals"] == [signal.SIGTERM, signal.SIGKILL], "cleanup must prove the PID gone"
print("ownership lifecycle: PASS (gone, unverified, permission, PID/path reuse, TERM, KILL)")
` });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally { cleanup(root); }
});
