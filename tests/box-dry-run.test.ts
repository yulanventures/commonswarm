import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  chownSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";

const RUNBOOK = "deploy/RELEASE-TO-BOX.md";
const HM37 = "docs/evidence/2026-09-28-box-hm37/BOX-WINDOW.md";
const SITE = "docs/evidence/2026-09-28-site-hm8/SITE-RELEASE.md";
const TEMPLATE = "docs/design/BOX-PLAN-TEMPLATE.md";
const SCOPED = [HM37, RUNBOOK, SITE, TEMPLATE];
const GUARD = "tests/box-dry-run/guard.sh";
const STUB = "tests/box-dry-run/stubs/dispatch.sh";
const PRELUDE = resolve("tests/box-dry-run/prelude.sh");
const PYTHON_FIXTURE = resolve("tests/box-dry-run/python");
const BOX_FACTS_FILE = "tests/box-dry-run/fixtures/box-facts.json";
const RELEASE_SHA = "eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922";
const SITE_SHA = "8b8989f2b29e440a317a2cdedf11195901c8342c";
const BASE_SHA = "218cf921d07d56f2b937822bcf18feb9d3be0f53";
const WINDOW_START = "2026-09-28T01:02:03Z";
const WINDOW_ID = "20260928T010203Z";

interface Block {
  file: string;
  step: string;
  marker: "yes" | "probe" | "no";
  host: string;
  source: string;
  line: number;
}

interface BoxFact {
  id: string;
  fact: string;
  assumed_by: string[];
  evidence: string;
  measure: string;
  fixture: Record<string, unknown>;
}

interface BoxFactInventory {
  schema: number;
  scope: string;
  facts: BoxFact[];
}

const BOX_FACTS = JSON.parse(readFileSync(BOX_FACTS_FILE, "utf8")) as BoxFactInventory;

function boxFactFixture<T extends Record<string, unknown>>(id: string): T {
  const fact = BOX_FACTS.facts.find((candidate) => candidate.id === id);
  assert.ok(fact, `box fact inventory is missing ${id}`);
  return fact.fixture as T;
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function blocks(file: string): Block[] {
  const markdown = readFileSync(file, "utf8");
  const result: Block[] = [];
  for (const match of markdown.matchAll(/^```sh[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm)) {
    const source = match[1] ?? "";
    const lines = source.split(/\r?\n/);
    const step = /^# step:\s*(.+)$/.exec(lines[0] ?? "")?.[1];
    const marker = /^# readonly: (yes|probe|no)$/.exec(lines[1] ?? "")?.[1];
    const host = /^# host:\s*(.+)$/.exec(lines[2] ?? "")?.[1];
    const line = markdown.slice(0, match.index).split("\n").length + 1;
    assert.ok(step, `${file}:${line}: missing step marker`);
    assert.ok(marker, `${file}:${line + 1}: missing readonly marker`);
    assert.ok(host, `${file}:${line + 2}: missing host marker`);
    result.push({ file, step, marker: marker as Block["marker"], host, source, line });
  }
  return result;
}

function fencedLanguages(file: string): string[] {
  return [...readFileSync(file, "utf8").matchAll(/^```([^\s`]*)[^\n]*$/gm)]
    .map((match) => match[1])
    .filter(Boolean);
}

function gitShow(revision: string, file: string): string {
  const result = spawnSync("git", ["show", `${revision}:${file}`], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function stepSource(markdown: string, step: string): string {
  const escaped = step.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^# step: ${escaped}\\n[\\s\\S]*?(?=^\\x60\\x60\\x60$)`, "m").exec(markdown);
  assert.ok(match, `missing step ${step}`);
  return match[0];
}

function removeOwnedTemporary(path: string, prefix: string): void {
  const resolved = resolve(path);
  assert.equal(dirname(resolved), resolve(tmpdir()));
  assert.ok(basename(resolved).startsWith(prefix));
  rmSync(resolved, { recursive: true, force: true });
}

function shortStep(block: Block): string {
  return block.step.split(" — ")[0] ?? block.step;
}

function planStepOrder(): string[] {
  const markdown = readFileSync(HM37, "utf8");
  const match = /The successful path uses this exact whole-block order[\s\S]*?^```text\n([\s\S]*?)^```$/m.exec(markdown);
  assert.ok(match, "HM37 plan is missing the successful-path step order");
  return match[1]!.trim().split(/\s+/);
}

function planTail(kind: "rollback" | "cleanup"): string[] {
  const markdown = readFileSync(HM37, "utf8");
  const expression = kind === "rollback"
    ? /The pre-COMMIT-POINT and S1–S5 rollback tail is\n([\s\S]*?), in that order\./
    : /A post-COMMIT-POINT\n`control` failure instead uses ([\s\S]*?), in that order\./;
  const match = expression.exec(markdown);
  assert.ok(match, `HM37 plan is missing the ${kind} tail`);
  return [...match[1]!.matchAll(/`([^`]+)`/g)].map((item) => item[1]!);
}

function planInput(name: string): string {
  const markdown = readFileSync(HM37, "utf8");
  const row = markdown.split("\n").find((line) => line.startsWith(`| \`${name}\` |`));
  const match = /\| `[^`]+` \| `([^`]+)`/.exec(row ?? "");
  assert.ok(match, `HM37 plan is missing input ${name}`);
  return match[1]!;
}

function switchStepGroups(): Map<string, string[]> {
  const markdown = readFileSync(RUNBOOK, "utf8");
  const start = markdown.indexOf("| Switch | Whole-block step group |");
  const end = markdown.indexOf("\n\nAdd exact relative paths", start);
  assert.ok(start >= 0 && end > start, "runbook is missing the switch-to-step mapping");
  const groups = new Map<string, string[]>();
  for (const line of markdown.slice(start, end).split("\n").slice(2)) {
    const cells = line.split("|").map((cell) => cell.trim()).filter(Boolean);
    if (cells.length !== 2) continue;
    const input = /`([^`]+)`/.exec(cells[0]!)?.[1];
    const steps = [...cells[1]!.matchAll(/`([^`]+)`/g)].map((item) => item[1]!);
    if (input) groups.set(input, steps);
  }
  assert.equal(groups.size, 5);
  return groups;
}

function selectedHmSequence(): string[] {
  let selected = planStepOrder();
  for (const [input, steps] of switchStepGroups()) {
    const value = planInput(input);
    assert.match(value, /^(?:yes|no)$/);
    if (value === "no") selected = selected.filter((step) => !steps.includes(step));
    else for (const step of steps) assert.ok(selected.includes(step), `${input}=yes omits ${step}`);
  }
  return selected;
}

function materialize(block: Block): string {
  let source = block.source;
  if (shortStep(block) === "runbook-04") {
    source = source.replace("ROUTER_CHANGED='<yes-or-no>'", "ROUTER_CHANGED='yes'");
  }
  source = source
    .replaceAll("<sha256-from-Mac-evidence>", "5219c371b281b6f7e0b90adb090f2fb3dff388ec5d95c163ba9c1daaa0bac7b3")
    .replaceAll("<approved-YYYY-MM-DDTHH:MM:SSZ>", "2026-09-28T05:02:03Z")
    .replaceAll("<next-approved-version-from-pending-versions.txt>", "20260928000004")
    .replaceAll("<agreed-seconds>", "86400")
    .replaceAll("<space-separated changed function names>", "command read capability activity h0 mcp")
    .replaceAll("<edge|stack|edge stack>", "edge stack")
    .replaceAll("<yes-or-no>", "no")
    .replaceAll("<newline-separated new job names, C-sorted, or empty>", "")
    .replaceAll("<newline-separated removed job names, C-sorted, or empty>", "")
    .replaceAll("<approved-14-digit-version-with-functional-txt-output>", "20260928000004")
    .replaceAll("<approved-14-digit-version>", "20260928000004")
    .replaceAll("<sha>", RELEASE_SHA);
  if (shortStep(block) === "runbook-03") {
    source = source
      .replace("MIGRATION_VERSIONS=(\n    # 20260928000004\n  )", "MIGRATION_VERSIONS=(\n    20260928000004\n  )")
      .replace("FUNCTIONAL_VERSIONS=(\n    # 20260928000004\n  )", "FUNCTIONAL_VERSIONS=(\n    20260928000004\n  )");
  }
  return source;
}

interface Fixture {
  temporary?: string;
  cwd: string;
  home: string;
  bin: string;
  log: string;
  env: NodeJS.ProcessEnv;
  prelude: string;
  pythonFixture: string;
  sourceRoot: string;
  supportRoot?: string;
  rootDirectories?: RootDirectoryFixture[];
  replacedRuntime?: { path: string; backup?: string };
}

interface RootDirectoryFixture {
  path: string;
  mode: number;
  created: boolean;
}

function makeStubBin(bin: string, rootOwned = false): void {
  mkdirSync(bin, { recursive: true, mode: rootOwned ? 0o755 : 0o700 });
  chmodSync(bin, rootOwned ? 0o755 : 0o700);
  if (rootOwned) chownSync(bin, 0, 0);
  const commands = boxFactFixture<{ stub_commands: string[] }>("command-runtimes").stub_commands;
  for (const command of commands) {
    const target = join(bin, command);
    if (!existsSync(target)) {
      copyFileSync(STUB, target);
      if (rootOwned) chownSync(target, 0, 0);
      chmodSync(target, 0o755);
    }
  }
}

function writeMode(filename: string, body: string, mode = 0o600): void {
  mkdirSync(dirname(filename), { recursive: true });
  writeFileSync(filename, body, { mode });
  chmodSync(filename, mode);
}

function writeRootMode(filename: string, body: string, mode = 0o600): void {
  writeMode(filename, body, mode);
  chownSync(filename, 0, 0);
}

function copyRootFixture(source: string, target: string, mode: number): void {
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  chownSync(target, 0, 0);
  chmodSync(target, mode);
}

function makeRootDirectory(path: string, mode: number): void {
  mkdirSync(path, { recursive: true, mode });
  chownSync(path, 0, 0);
  chmodSync(path, mode);
}

function prepareRootDirectory(path: string, mode: number): RootDirectoryFixture {
  const created = !pathExists(path);
  if (created) {
    mkdirSync(path, { mode });
    chownSync(path, 0, 0);
    chmodSync(path, mode);
  } else {
    assert.equal(lstatSync(path).isDirectory(), true, `fixture root is not a directory: ${path}`);
  }
  return { path, mode, created };
}

function chownTree(owner: string, ...paths: string[]): void {
  const result = spawnSync("/usr/bin/chown", ["-R", owner, ...paths], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function chownPaths(owner: string, ...paths: string[]): void {
  const result = spawnSync("/usr/bin/chown", [owner, ...paths], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function checksumManifest(root: string, excluded: string[] = []): string {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) {
        const file = relative(root, path);
        if (!excluded.includes(file)) files.push(file);
      }
    }
  };
  visit(root);
  return files.sort().map((file) => {
    const digest = createHash("sha256").update(readFileSync(join(root, file))).digest("hex");
    return `${digest}  ./${file}`;
  }).join("\n") + "\n";
}

function checkoutFixture(parent: string, name: string, sha: string): string {
  const checkout = join(parent, name);
  const cloned = spawnSync("git", ["clone", "--no-hardlinks", "--no-checkout", ".", checkout], {
    encoding: "utf8",
  });
  assert.equal(cloned.status, 0, cloned.stderr);
  const checked = spawnSync("git", ["checkout", "--detach", sha], { cwd: checkout, encoding: "utf8" });
  assert.equal(checked.status, 0, checked.stderr);
  return checkout;
}

function prepareMacFixture(): Fixture {
  const temporary = mkdtempSync(join(tmpdir(), "commonswarm-box-dry-run-mac-"));
  const home = join(temporary, "child-home");
  const bin = join(temporary, "bin");
  const log = join(temporary, "stub.log");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(join(home, ".config/cswarm"), { recursive: true, mode: 0o700 });
  makeStubBin(bin);
  const cwd = checkoutFixture(temporary, "hm37", RELEASE_SHA);
  const day = new Date().toISOString().slice(0, 10);
  const evidence = join(cwd, "docs/evidence", `${day}-release-eb2a87ac4b5a-${WINDOW_ID}`);
  mkdirSync(evidence, { recursive: true, mode: 0o700 });
  writeMode(join(evidence, "gate-evidence.txt"), [
    `SHA=${RELEASE_SHA}`,
    "npm run build:command-core && git diff --exit-code supabase/functions/_shared/protocol.js: PASS",
    "npm run check:edge: PASS",
    "",
  ].join("\n"));
  for (const file of ["20260928000003-catalog.sql", "20260928000003-functional.sql", "20260928000004-catalog.sql", "20260928000004-functional.sql"]) {
    writeMode(join(evidence, file), "SELECT true AS catalog_ok\\gset\n");
  }
  writeMode(join(home, ".commonswarm-release-window.env"), [
    `SHA='${RELEASE_SHA}'`, `WINDOW_START_UTC='${WINDOW_START}'`, `WINDOW_ID='${WINDOW_ID}'`,
    "SHORT_SHA='eb2a87ac4b5a'", `EVIDENCE_DIR='${evidence}'`, `RUN_LOG='${join(evidence, "run.log")}'`,
    `ARCHIVE='/tmp/commonswarm-${RELEASE_SHA}-${WINDOW_ID}.tar'`,
    `BOX_WINDOW_INPUT='/tmp/commonswarm-${RELEASE_SHA}-${WINDOW_ID}.window.env'`, "",
  ].join("\n"));
  writeMode(`/tmp/commonswarm-${RELEASE_SHA}-${WINDOW_ID}.tar`, "dry-run archive fixture\n");
  const credentials = join(home, "credential.json");
  writeMode(credentials, JSON.stringify({
    agent_token: "dry-run-placeholder",
    principal_id: "00000000-0000-4000-8000-000000000001",
    token_id: "00000000-0000-4000-8000-000000000002",
    run_id: "00000000-0000-4000-8000-000000000003",
  }) + "\n");
  return {
    temporary, cwd, home, bin, log,
    prelude: PRELUDE,
    pythonFixture: PYTHON_FIXTURE,
    sourceRoot: process.cwd(),
    env: {
      ...process.env,
      HOME: home,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      PYTHONPATH: PYTHON_FIXTURE,
      BOX_DRY_RUN_STUB_LOG: log,
      WINDOW_START_UTC: WINDOW_START,
      BACKUP_MAX_AGE_SECONDS: "86400",
      CREDENTIAL_FILE: credentials,
      EXPECTED_PRINCIPAL_ID: "00000000-0000-4000-8000-000000000001",
      EXPECTED_RUN_ID: "00000000-0000-4000-8000-000000000003",
    },
  };
}

function prepareSiteFixture(fixture: Fixture): string {
  const cwd = checkoutFixture(fixture.temporary!, "site-release", SITE_SHA);
  const evidence = join(fixture.temporary!, `site-evidence-${WINDOW_ID}`);
  mkdirSync(evidence, { mode: 0o700 });
  writeMode(join(evidence, "GO.txt"), `SHA=${SITE_SHA}\nAll release holds resolved\n`);
  const ownerToken = join(fixture.home, "site-owner-token");
  writeMode(ownerToken, "dry-run-owner-token\n");
  writeMode(join(cwd, "site/.env"), [
    "PUBLIC_SUPABASE_URL=https://api.commonswarm.com",
    "PUBLIC_SUPABASE_ANON_KEY=e30.eyJyb2xlIjoiYW5vbiJ9.signature",
    "PUBLIC_H0_LINK_JOIN=1",
    "",
  ].join("\n"));
  writeMode(join(cwd, "deploy/site/deploy.sh"), "#!/bin/sh\nexit 0\n", 0o755);
  writeMode(join(fixture.home, ".commonswarm-site-window.env"), [
    `SITE_WINDOW_START_UTC='${WINDOW_START}'`, `SITE_WINDOW_ID='${WINDOW_ID}'`,
    `SITE_EVIDENCE='${evidence}'`, `SITE_WINDOW_FILE='${join(fixture.home, ".commonswarm-site-window.env")}'`, "",
  ].join("\n"));
  Object.assign(fixture.env, {
    SITE_WINDOW_START_UTC: WINDOW_START,
    SITE_EVIDENCE: evidence,
    SITE_RELEASE_REPO: cwd,
    SITE_BASE_SHA: BASE_SHA,
    SITE_OWNER_ACCESS_TOKEN_FILE: ownerToken,
    BOX_DRY_RUN_SSH_COUNTER_FILE: join(fixture.temporary!, "ssh-counter"),
  });
  return cwd;
}

function cleanupMacFixture(fixture: Fixture): void {
  for (const path of [
    `/tmp/commonswarm-${RELEASE_SHA}-${WINDOW_ID}.tar`,
    `/tmp/commonswarm-${RELEASE_SHA}-${WINDOW_ID}.window.env`,
    `/tmp/commonswarm-release-proofs-${RELEASE_SHA}-${WINDOW_ID}.tar`,
  ]) rmSync(path, { force: true });
  removeOwnedTemporary(fixture.temporary!, "commonswarm-box-dry-run-mac-");
}

function windowEnvBody(state: string): string {
  const edgeState = state === "s1" ? "created" : "reused";
  const stackState = state === "s1" ? "created" : "reused";
  return [
    `SHA='${RELEASE_SHA}'`, "KIND_LIST='edge stack'", `WINDOW_START_UTC='${WINDOW_START}'`,
    "WINDOW_END_UTC='2026-09-28T05:02:03Z'", `WINDOW_ID='${WINDOW_ID}'`,
    "WINDOW_PRINCIPAL_SUFFIX='010203'",
    `NEW_EDGE='/home/commonswarm/edge/releases/${RELEASE_SHA}'`,
    `NEW_STACK='/home/commonswarm/stack/releases/${RELEASE_SHA}'`,
    "PREVIOUS_EDGE='/home/commonswarm/edge/releases/72c57e0d76d0aa86fe4f811a2cf51499919fed20'",
    "PREVIOUS_STACK='/home/commonswarm/stack/releases/ad964ed158181ba1692dd05895f36fa7a1f87d3f'",
    "RECYCLE_TIMER_STOPPED='0'", "BACKUP_TIMERS_STOPPED='0'",
    "MCP_CADDY_SITE='/etc/caddy/sites/12-commonswarm-mcp.caddy'",
    `RELEASE_DIR_STATE='${edgeState === stackState ? edgeState : "mixed"}'`,
    `EDGE_RELEASE_DIR_STATE='${edgeState}'`, `STACK_RELEASE_DIR_STATE='${stackState}'`, "",
  ].join("\n");
}

function prepareBoxFixture(state: string): Fixture {
  assert.equal(process.env.BOX_DRY_RUN_PART, "box");
  const temporary = mkdtempSync(join(tmpdir(), `commonswarm-box-dry-run-${state}-`));
  chownSync(temporary, 0, 0);
  chmodSync(temporary, 0o700);
  const bin = join(temporary, "bin");
  const log = join(temporary, "stub.log");
  const supportRoot = join(temporary, "support");
  const prelude = join(supportRoot, "prelude.sh");
  const pythonFixture = join(supportRoot, "python");
  const sourceRoot = join(supportRoot, "source");
  makeRootDirectory(supportRoot, 0o755);
  copyRootFixture(PRELUDE, prelude, 0o644);
  makeRootDirectory(pythonFixture, 0o755);
  copyRootFixture(join(PYTHON_FIXTURE, "sitecustomize.py"), join(pythonFixture, "sitecustomize.py"), 0o644);
  makeRootDirectory(sourceRoot, 0o755);
  makeRootDirectory(join(sourceRoot, "supabase"), 0o755);
  makeRootDirectory(join(sourceRoot, "supabase/migrations"), 0o755);
  copyRootFixture(
    "supabase/migrations/20260928000003_hm_oauth_store.sql",
    join(sourceRoot, "supabase/migrations/20260928000003_hm_oauth_store.sql"),
    0o644,
  );
  makeStubBin(bin, true);
  writeRootMode(log, "", 0o600);
  const denoFact = boxFactFixture<{
    path: string; owner: string; group: string; mode: string; version_output: string;
  }>("deno-runtime");
  const releaseFact = boxFactFixture<{
    previous_edge: string; previous_stack: string; candidate_edge: string;
    candidate_stack: string; proof_dir: string;
  }>("release-layout");
  const originalDeno = pathExists(denoFact.path)
    ? join(temporary, "original-runtimes", "deno")
    : undefined;
  for (const path of ["/home/commonswarm", "/srv/commonswarm"]) assert.equal(existsSync(path), false, `guarded path unexpectedly exists: ${path}`);
  for (const path of [
    "/etc/commonswarm-release/target.env", "/etc/ssl/yulan-internal-ca.pem",
    "/etc/commonswarm-oauth/database-credentials", "/etc/commonswarm-oauth/service.env",
    "/etc/caddy/sites/10-commonswarm-api.caddy", "/etc/caddy/sites/11-commonswarm-edge-staging.caddy",
    "/etc/caddy/sites/12-commonswarm-mcp.caddy", "/var/backups/commonswarm-postgres/status.json",
  ]) assert.equal(existsSync(path), false, `fixture refuses to replace pre-existing path: ${path}`);
  const rootDirectories = [
    prepareRootDirectory("/etc/commonswarm-release", 0o700),
    prepareRootDirectory("/etc/commonswarm-oauth", 0o700),
    prepareRootDirectory("/etc/caddy", 0o755),
    prepareRootDirectory("/etc/caddy/sites", 0o755),
    prepareRootDirectory("/var/backups", 0o755),
    prepareRootDirectory("/var/backups/commonswarm-postgres", 0o755),
  ];
  if (originalDeno) {
    mkdirSync(dirname(originalDeno), { recursive: true, mode: 0o700 });
    renameSync(denoFact.path, originalDeno);
  }
  copyFileSync(STUB, denoFact.path);
  chownSync(denoFact.path, 0, 0);
  chmodSync(denoFact.path, Number.parseInt(denoFact.mode, 8));
  const denoStat = lstatSync(denoFact.path);
  assert.equal(denoStat.isFile(), true);
  assert.equal(denoStat.isSymbolicLink(), false);
  assert.equal(denoStat.mode & 0o777, 0o755);
  assert.equal(denoStat.uid, 0);
  assert.equal(denoStat.gid, 0);
  for (const path of ["/home/commonswarm", "/srv/commonswarm"]) makeRootDirectory(path, 0o750);
  const previousEdge = releaseFact.previous_edge;
  const previousStack = releaseFact.previous_stack;
  const oauth = "/home/commonswarm/oauth/releases/826db6a34f235064a3a03c57377d8e32a35d2f05";
  for (const release of [previousEdge, previousStack, oauth]) {
    mkdirSync(join(release, "deploy/edge-runtime/main"), { recursive: true });
    mkdirSync(join(release, "deploy/supabase-stack/backup"), { recursive: true });
    mkdirSync(join(release, "supabase/migrations"), { recursive: true });
    writeMode(join(release, "RELEASE_SHA"), `${basename(release)}\n`, 0o644);
    chmodSync(release, 0o755);
  }
  mkdirSync(join(previousStack, "deploy/supabase-stack/postgres"), { recursive: true });
  writeMode(join(previousStack, "deploy/supabase-stack/compose.yaml"), "services: {}\n", 0o644);
  writeMode(join(previousEdge, "deploy/edge-runtime/compose.override.yaml"), "services: {}\n", 0o644);
  writeMode(join(previousEdge, "deploy/edge-runtime/compose.yaml"), "services: {}\n", 0o644);
  mkdirSync("/home/commonswarm/edge", { recursive: true });
  mkdirSync("/home/commonswarm/stack", { recursive: true });
  mkdirSync("/home/commonswarm/oauth", { recursive: true });
  for (const path of ["/home/commonswarm/edge", "/home/commonswarm/stack", "/home/commonswarm/oauth"]) chmodSync(path, 0o755);
  symlinkSync(previousEdge, "/home/commonswarm/edge/current");
  symlinkSync(previousStack, "/home/commonswarm/stack/current");
  symlinkSync(oauth, "/home/commonswarm/oauth/current");

  const proof = releaseFact.proof_dir;
  mkdirSync(proof, { recursive: true, mode: 0o700 });
  chmodSync(proof, 0o700);
  writeMode(join(proof, "window.env"), windowEnvBody(state));
  writeMode(join(proof, "GO.txt"), "CONCURRENT_OPERATOR_ACTIVITY=accepted by HezLead\n");
  writeMode(join(proof, "oauth-image.id"), `sha256:${"0".repeat(64)}`);
  for (const file of ["20260928000003-catalog.sql", "20260928000003-functional.sql", "20260928000004-catalog.sql", "20260928000004-functional.sql"]) writeMode(join(proof, file), "SELECT true AS catalog_ok\\gset\n");
  writeMode(join(proof, "copy-back.list"), "copy-back.list\n");
  for (const file of [
    "caddy-after-10-commonswarm-api.caddy",
    "caddy-after-11-commonswarm-edge-staging.caddy", "caddy-log-files.txt",
    "mcp-caddy-after.caddy", "mcp-caddy-log-files.txt",
  ]) writeMode(join(proof, file), file.endsWith(".txt") ? "fixture\n" : "");
  writeMode(join(proof, "gate-evidence.txt"), `SHA=${RELEASE_SHA}\nfixture gate evidence\n`);
  writeMode(join(proof, "required-edge-env.json"), JSON.stringify({
    required: [
      "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_URL",
      "SWARM_DATABASE_URL|SUPABASE_DB_URL", "SWARM_SELF_SERVE",
    ], optional: [],
  }) + "\n");
  writeMode(join(proof, "edge-env-source-check.txt"), "fixture exact-SHA router inventory\n");
  const oauthProof = "/home/commonswarm/stack/release-proofs/826db6a34f235064a3a03c57377d8e32a35d2f05";
  mkdirSync(oauthProof, { recursive: true, mode: 0o700 });
  chmodSync(oauthProof, 0o700);
  writeMode(join(oauthProof, "oauth-image.id"), `sha256:${"0".repeat(64)}`);
  writeMode("/tmp/commonswarm-release-window.env", `SHA='${RELEASE_SHA}'\nWINDOW_START_UTC='${WINDOW_START}'\nWINDOW_ID='${WINDOW_ID}'\n`);
  writeMode("/tmp/commonswarm-release.tar", "dry-run archive\n");
  writeMode("/tmp/commonswarm-site-window.env", `SITE_WINDOW_START_UTC='${WINDOW_START}'\nSITE_WINDOW_ID='${WINDOW_ID}'\n`);
  writeMode(`/run/commonswarm-release-${RELEASE_SHA}-session.sh`, [
    `STACK_RELEASE='/home/commonswarm/stack/releases/${RELEASE_SHA}'`,
    `MIGRATE='/home/commonswarm/stack/releases/${RELEASE_SHA}/deploy/supabase-stack/migrate'`,
    `PROOF_DIR='${proof}'`, `APPLY_SQL='/run/commonswarm-release-${RELEASE_SHA}-apply.sql'`,
    "release_psql() { printf '%s\\n' \"${BOX_DRY_RUN_PSQL_RESULT:-t}\"; }",
    "release_psql_ro() { case \"${BOX_DRY_RUN_STEP:-} $*\" in *20260916000001*20260916000002*) :;; runbook-26*20260928000004*count*) printf '%s\\n' 0;; runbook-26*20260928000004-catalog.sql*) printf '%s\\n' f;; runbook-28*20260928000004*count*) printf '%s\\n' 1;; runbook-28*20260928000004-catalog.sql*) printf '%s\\n' t;; *'ORDER BY version'*) printf '%s\\n' 20260916000001 20260916000002 20260925000001 20260926000001 20260927000001 20260927000002 20260927000003 20260928000001 20260928000002 20260928000003;; *) printf '%s\\n' \"${BOX_DRY_RUN_PSQL_RESULT:-t}\";; esac; }",
    "",
  ].join("\n"));
  writeMode("/home/commonswarm/.env", [
    "SWARM_ENV=production",
    "SWARM_DATABASE_URL=postgres://placeholder",
    "SWARM_SELF_SERVE=1",
    "SUPABASE_URL=http://kong:8000",
    "SUPABASE_ANON_KEY=fixture-anon-key",
    "SUPABASE_SERVICE_ROLE_KEY=fixture-service-role-key",
    "",
  ].join("\n"), 0o600);
  writeMode("/etc/commonswarm-release/target.env", "TARGET_DATABASE_URL=postgres://placeholder\n", 0o600);
  writeMode("/etc/ssl/yulan-internal-ca.pem", "dry-run-ca\n", 0o600);
  writeMode("/etc/commonswarm-oauth/database-credentials", '{"user":"commonswarm_oauth_runtime","password":"placeholder"}\n', 0o600);
  writeMode("/etc/commonswarm-oauth/service.env", "MCP_OAUTH_DATABASE_HOST=db.commonswarm.internal\nMCP_OAUTH_DATABASE_NAME=commonswarm\n", 0o600);
  writeMode("/etc/caddy/sites/10-commonswarm-api.caddy", "api.commonswarm.com {\n}\n", 0o644);
  writeMode("/etc/caddy/sites/11-commonswarm-edge-staging.caddy", "edge-staging.commonswarm.com {\n}\n", 0o644);
  writeMode("/etc/caddy/sites/12-commonswarm-mcp.caddy", "mcp.commonswarm.com {\n}\n", 0o644);
  writeMode(join(previousStack, "deploy/supabase-stack/commonswarm-api.caddy"), "api.commonswarm.com, edge-staging.commonswarm.com {\n}\n", 0o644);
  writeMode("/var/backups/commonswarm-postgres/status.json", JSON.stringify({
    state: "complete", ok: true, database_bytes_verified: true, object_bytes_verified: true,
    verified_at: new Date().toISOString(), destination: "r2:yulan-vps-1-backups/000-commonswarm-postgres/dry-run",
  }) + "\n");
  const targetEdge = releaseFact.candidate_edge;
  const targetStack = releaseFact.candidate_stack;
  if (state !== "s1") {
    for (const release of [targetEdge, targetStack]) {
      mkdirSync(join(release, "deploy/edge-runtime/main"), { recursive: true });
      mkdirSync(join(release, "deploy/supabase-stack/migrate"), { recursive: true });
      mkdirSync(join(release, "deploy/supabase-stack/postgres"), { recursive: true });
      mkdirSync(join(release, "deploy/supabase-stack/backup"), { recursive: true });
      mkdirSync(join(release, "supabase/migrations"), { recursive: true });
      writeMode(join(release, "RELEASE_SHA"), `${RELEASE_SHA}\n`, 0o644);
      writeMode(join(release, "deploy/edge-runtime/compose.yaml"), "services: {}\n", 0o644);
      writeMode(join(release, "deploy/edge-runtime/main/router.ts"), "// dry-run router fixture\n", 0o644);
      writeMode(join(release, "deploy/supabase-stack/compose.yaml"), "services: {}\n", 0o644);
      copyFileSync("supabase/migrations/20260928000003_hm_oauth_store.sql", join(release, "supabase/migrations/20260928000003_hm_oauth_store.sql"));
      writeMode(join(release, "supabase/migrations/20260928000004_hm_hosted_check.sql"), "-- fixture\n", 0o644);
      writeMode(join(release, "deploy/supabase-stack/migrate/run-db-tool.sh"), "#!/bin/sh\nexit 0\n", 0o755);
    }
    if (state === "s3") writeMode(join(targetEdge, "deploy/edge-runtime/compose.override.yaml"), "services: {}\n", 0o644);
    chownTree("commonswarm:commonswarm", targetEdge, targetStack);
    chmodSync(targetEdge, 0o750);
    chmodSync(targetStack, 0o755);
    writeMode(join(proof, "edge.SHA256SUMS"), checksumManifest(targetEdge, ["deploy/edge-runtime/compose.override.yaml"]));
    writeMode(join(proof, "stack.SHA256SUMS"), checksumManifest(targetStack));
  }
  if (state === "s2" || state === "s5") {
    for (const suffix of ["001030", "021020"]) mkdirSync(`${proof}.closed-window-${suffix}`, { recursive: true });
  }
  if (state === "s4") writeMode(join(proof, "rollback-left.txt"), "edge moved then restored\n");

  const staging = `/run/commonswarm-hm37-${WINDOW_ID}`;
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  chmodSync(staging, 0o700);
  copyRootFixture("deploy/release-proofs/item-hm/hm37-open-ack-control.ts", join(staging, "hm37-open-ack-control.ts"), 0o644);
  copyRootFixture("deploy/release-proofs/item-hm/hm37-open-ack-deno.json", join(staging, "hm37-open-ack-deno.json"), 0o644);
  writeRootMode(join(staging, "human-session.json"), '{"access_token":"placeholder"}\n');

  const siteRelease = "/srv/commonswarm/site/releases/20260928T010203Z-8b8989f2b29e-deadbeefdeadbeef";
  mkdirSync(join(siteRelease, "app"), { recursive: true });
  mkdirSync(join(siteRelease, "download"), { recursive: true });
  mkdirSync(join(siteRelease, "_astro"), { recursive: true });
  chmodSync(siteRelease, 0o755);
  writeMode(join(siteRelease, "app/index.html"), '<button data-connected-apps-open></button><link href="/_astro/app.css">\n', 0o644);
  writeMode(join(siteRelease, "download/index.html"), "0.1.80\n", 0o644);
  writeMode(join(siteRelease, "_astro/app.css"), "body{}\n", 0o644);
  mkdirSync("/srv/commonswarm/site", { recursive: true });
  chmodSync("/srv/commonswarm/site", 0o755);
  chmodSync("/srv/commonswarm/site/releases", 0o755);
  symlinkSync(siteRelease, "/srv/commonswarm/site/current");

  chownTree("root:root", supportRoot, proof, oauthProof, staging);
  for (const path of [
    log,
    denoFact.path,
    "/home/commonswarm/.env",
    "/etc/commonswarm-release/target.env",
    "/etc/ssl/yulan-internal-ca.pem",
    "/etc/commonswarm-oauth/database-credentials",
    "/etc/commonswarm-oauth/service.env",
    "/etc/caddy/sites/10-commonswarm-api.caddy",
    "/etc/caddy/sites/11-commonswarm-edge-staging.caddy",
    "/etc/caddy/sites/12-commonswarm-mcp.caddy",
    "/var/backups/commonswarm-postgres/status.json",
    "/tmp/commonswarm-release-window.env",
    "/tmp/commonswarm-release.tar",
    "/tmp/commonswarm-site-window.env",
    `/run/commonswarm-release-${RELEASE_SHA}-session.sh`,
  ]) chownSync(path, 0, 0);
  chownTree("commonswarm:commonswarm", previousEdge, previousStack, oauth, siteRelease);
  if (state !== "s1") chownTree("commonswarm:commonswarm", targetEdge, targetStack);
  chownPaths(
    "commonswarm:commonswarm",
    "/home/commonswarm", "/home/commonswarm/edge", "/home/commonswarm/stack", "/home/commonswarm/oauth",
    "/srv/commonswarm", "/srv/commonswarm/site", "/srv/commonswarm/site/releases",
  );

  return {
    temporary, cwd: process.cwd(), home: "/root", bin, log,
    prelude, pythonFixture, sourceRoot, supportRoot, rootDirectories,
    replacedRuntime: { path: denoFact.path, ...(originalDeno ? { backup: originalDeno } : {}) },
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      PYTHONPATH: pythonFixture,
      BOX_DRY_RUN_STUB_LOG: log,
      BOX_DRY_RUN_EXPECTED_EDGE: previousEdge,
      BOX_DRY_RUN_SOURCE_ROOT: sourceRoot,
      BOX_DRY_RUN_DENO_VERSION: denoFact.version_output,
      BACKUP_MAX_AGE_SECONDS: "86400",
    },
  };
}

function cleanupBoxFixture(fixture: Fixture): void {
  for (const path of ["/srv/commonswarm", "/home/commonswarm"]) rmSync(path, { recursive: true, force: true });
  for (const path of [
    "/tmp/commonswarm-release-window.env", "/tmp/commonswarm-release.tar", "/tmp/commonswarm-release-proofs.tar",
    "/tmp/commonswarm-site-window.env", `/run/commonswarm-release-${RELEASE_SHA}-session.sh`,
    `/run/commonswarm-release-${RELEASE_SHA}-apply.sql`,
  ]) rmSync(path, { force: true });
  rmSync(`/run/commonswarm-hm37-${WINDOW_ID}`, { recursive: true, force: true });
  rmSync("/var/backups/commonswarm-postgres/status.json", { force: true });
  for (const path of [
    "/etc/commonswarm-release/target.env", "/etc/ssl/yulan-internal-ca.pem",
    "/etc/commonswarm-oauth/database-credentials", "/etc/commonswarm-oauth/service.env",
    "/etc/caddy/sites/10-commonswarm-api.caddy", "/etc/caddy/sites/11-commonswarm-edge-staging.caddy",
    "/etc/caddy/sites/12-commonswarm-mcp.caddy",
  ]) rmSync(path, { force: true });
  if (fixture.replacedRuntime) {
    if (pathExists(fixture.replacedRuntime.path)) rmSync(fixture.replacedRuntime.path, { force: true });
    if (fixture.replacedRuntime.backup && pathExists(fixture.replacedRuntime.backup)) {
      renameSync(fixture.replacedRuntime.backup, fixture.replacedRuntime.path);
    }
  }
  for (const directory of [...(fixture.rootDirectories ?? [])].reverse()) {
    if (directory.created && pathExists(directory.path)) rmdirSync(directory.path);
  }
  removeOwnedTemporary(fixture.temporary!, `commonswarm-box-dry-run-`);
}

type FixturePart = "mac" | "box";

function persistedFixturePaths(fixture: Fixture, part: FixturePart): string[] {
  if (part === "mac") {
    return [
      fixture.temporary!,
      `/tmp/commonswarm-${RELEASE_SHA}-${WINDOW_ID}.tar`,
      `/tmp/commonswarm-${RELEASE_SHA}-${WINDOW_ID}.window.env`,
      `/tmp/commonswarm-release-proofs-${RELEASE_SHA}-${WINDOW_ID}.tar`,
    ].filter(existsSync);
  }
  const paths = [
    fixture.temporary!,
    "/home/commonswarm",
    "/srv/commonswarm",
    "/etc/commonswarm-release/target.env",
    "/etc/ssl/yulan-internal-ca.pem",
    "/etc/commonswarm-oauth/database-credentials",
    "/etc/commonswarm-oauth/service.env",
    "/etc/caddy/sites/10-commonswarm-api.caddy",
    "/etc/caddy/sites/11-commonswarm-edge-staging.caddy",
    "/etc/caddy/sites/12-commonswarm-mcp.caddy",
    "/var/backups/commonswarm-postgres/status.json",
    "/tmp/commonswarm-release-window.env",
    "/tmp/commonswarm-release.tar",
    "/tmp/commonswarm-release-proofs.tar",
    "/tmp/commonswarm-site-window.env",
    `/run/commonswarm-release-${RELEASE_SHA}-session.sh`,
    `/run/commonswarm-release-${RELEASE_SHA}-apply.sql`,
    `/run/commonswarm-hm37-${WINDOW_ID}`,
  ];
  if (fixture.replacedRuntime) paths.push(fixture.replacedRuntime.path);
  return paths.filter(existsSync);
}

function snapshotFixture(fixture: Fixture, part: FixturePart, archive: string): void {
  const paths = persistedFixturePaths(fixture, part)
    .map((path) => (part === "mac" ? realpathSync(path) : resolve(path)).slice(1));
  assert.ok(paths.length > 0);
  const result = spawnSync("/usr/bin/tar", ["-cpf", archive, "-C", "/", ...paths], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function restoreFixture(fixture: Fixture, part: FixturePart, archive: string): void {
  if (part === "box") cleanupBoxFixture(fixture);
  else cleanupMacFixture(fixture);
  const result = spawnSync("/usr/bin/tar", ["-xpf", archive, "-C", "/"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  if (part === "box") {
    for (const directory of fixture.rootDirectories ?? []) {
      if (!directory.created) continue;
      assert.equal(lstatSync(directory.path).isDirectory(), true, `restored fixture root is not a directory: ${directory.path}`);
      chownSync(directory.path, 0, 0);
      chmodSync(directory.path, directory.mode);
    }
  }
}

interface Execution {
  step: string;
  result: "passed" | "failed";
  firstFailingCommand?: string;
  stderr: string;
}

function executeWholeBlock(block: Block, fixture: Fixture, options: { fail?: boolean; control?: string } = {}): Execution {
  const step = shortStep(block);
  const body = materialize(block);
  const script = [
    "set -E", `source ${JSON.stringify(fixture.prelude)}`,
    "trap 'block_status=$?; printf \"__FIRST_FAIL__:%s\\n\" \"$BASH_COMMAND\" >&2; exit \"$block_status\"' ERR",
    body,
  ].join("\n");
  const result = spawnSync("/bin/bash", [], {
    cwd: fixture.cwd,
    input: script,
    encoding: "utf8",
    env: {
      ...fixture.env,
      BOX_DRY_RUN_STEP: step,
      BOX_DRY_RUN_FAIL_STEP: options.fail ? step : "",
      BOX_DRY_RUN_CONTROL: options.control ?? "",
    },
    timeout: 120_000,
  });
  const stderr = result.stderr ?? "";
  const failure = result.status === 0 ? undefined : /__FIRST_FAIL__:(.*)/.exec(stderr)?.[1];
  return {
    step,
    result: result.status === 0 ? "passed" : "failed",
    firstFailingCommand: failure,
    stderr,
  };
}

test("all scoped fences and host declarations are executable or explicitly text", (t) => {
  const parsed = SCOPED.flatMap(blocks);
  assert.equal(blocks(HM37).length, 16);
  assert.equal(blocks(RUNBOOK).length, 67);
  assert.equal(blocks(SITE).length, 6);
  assert.equal(blocks(TEMPLATE).length, 3);
  assert.deepEqual(
    SCOPED.flatMap((file) => fencedLanguages(file).filter((language) => language !== "sh" && language !== "text")),
    [],
  );
  for (const block of parsed) {
    assert.match(block.host, /^(?:Mac mini \/bin\/bash 3\.2|box \/bin\/bash 5\.2)/);
    const syntax = spawnSync("/bin/bash", ["-n"], { input: block.source, encoding: "utf8" });
    assert.equal(syntax.status, 0, `${block.file}:${block.line} [${block.step}] ${syntax.stderr}`);
  }
  t.diagnostic(`blocks=${parsed.length}; hm37=16 runbook=67 site=6 template=3`);
});

test("operator requirements name an executing step or an explicit HezLead decision", () => {
  const hm37 = readFileSync(HM37, "utf8");
  const site = readFileSync(SITE, "utf8");
  const runbook = readFileSync(RUNBOOK, "utf8");
  const hm37Requirements = hm37.slice(
    hm37.indexOf("After both parts pass"),
    hm37.indexOf("Historical HM2 run 4"),
  );
  for (let item = 1; item <= 7; item += 1) {
    const line = hm37Requirements.split("\n").find((candidate) => candidate.startsWith(`${item}. `));
    assert.ok(line, `missing HM37 requirement ${item}`);
    assert.match(line, /`(?:hm37-[^`]+|runbook-[^`]+)`|HezLead decision/);
  }
  const siteRequirements = site.slice(
    site.indexOf("Before GO, each read-only requirement"),
    site.indexOf("The signed-in checks"),
  );
  for (let item = 1; item <= 5; item += 1) {
    const line = siteRequirements.split("\n").find((candidate) => candidate.startsWith(`${item}. `));
    assert.ok(line, `missing site requirement ${item}`);
    assert.match(line, /`(?:hm37-[^`]+|site-[^`]+)`|HezLead GO decision/);
  }
  assert.doesNotMatch(runbook, /Anvil records the changed-function list/);
  assert.match(runbook, /Runbook step `runbook-04` records the changed-function list/);
  for (const [file, markdown] of [[HM37, hm37], [SITE, site], [RUNBOOK, runbook]] as const) {
    const lines = markdown.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (line.startsWith("|")) continue;
      if (!/Anvil\s+(?:must\s+)?(?:establish(?:es)?|verif(?:y|ies)|prove(?:s)?|record(?:s)?|run(?:s)?|execute(?:s)?)/i.test(line)) continue;
      const context = lines.slice(index, index + 3).join(" ");
      assert.match(
        context,
        /`(?:hm37-[^`]+|runbook-[^`]+|site-[^`]+)`|HezLead decision/,
        `${file}:${index + 1}: Anvil requirement has no executable owner`,
      );
    }
  }
});

test("window IDs are derived once and later read from persisted files", () => {
  const runbook = readFileSync(RUNBOOK, "utf8");
  const site = readFileSync(SITE, "utf8");
  assert.doesNotMatch(runbook, /WINDOW_ID='<approved|EXPECTED_WINDOW_ID/);
  assert.doesNotMatch(site, /SITE_WINDOW_ID:\?Set the approved|approved `YYYYMMDDTHHMMSSZ` identifier/);
  const open = stepSource(runbook, "runbook-02");
  assert.match(open, /WINDOW_ID="\$\(printf '%s' "\$WINDOW_START_UTC" \| tr -d ':-'\)"/);
  assert.match(open, /\.commonswarm-release-window\.env/);
  assert.match(open, /BOX_WINDOW_INPUT/);
  assert.match(stepSource(runbook, "1-apply-release-directories"), /\. \/tmp\/commonswarm-release-window\.env/);
  assert.match(stepSource(runbook, "runbook-03"), /\. \/home\/commonswarm\/stack\/release-proofs\/<sha>\/window\.env/);
  const siteOpen = stepSource(site, "site-01 — Mac mini /bin/bash 3.2; Anvil; open the site window, then read the box");
  assert.match(siteOpen, /SITE_WINDOW_ID="\$\(printf '%s' "\$SITE_WINDOW_START_UTC" \| tr -d ':-'\)"/);
  assert.match(siteOpen, /\.commonswarm-site-window\.env/);
  for (const block of blocks(SITE).filter((candidate) => candidate.step !== blocks(SITE)[0]?.step)) {
    if (block.host.startsWith("Mac mini")) assert.match(block.source, /\. "\$HOME\/\.commonswarm-site-window\.env"/);
    else assert.match(block.source, /\. \/tmp\/commonswarm-site-window\.env/);
  }
});

test("the box safety guard refuses this Mac and validates every blocking condition", {
  skip: process.env.BOX_DRY_RUN_PART === "box",
}, () => {
  const guard = readFileSync(GUARD, "utf8");
  for (const required of [
    "BOX_DRY_RUN", "GITHUB_ACTIONS", "CI", "uname -s", "hostname -s",
    "id -u", "/home/commonswarm", "/srv/commonswarm",
  ]) assert.ok(guard.includes(required), `guard omits ${required}`);
  const result = spawnSync("/bin/bash", [GUARD], {
    encoding: "utf8",
    env: { ...process.env, BOX_DRY_RUN: "1", GITHUB_ACTIONS: "true", CI: "true" },
  });
  assert.equal(result.status, 77);
  assert.match(result.stderr, /REFUSE: Linux is required/);
});

test("box preflight reports every shared fixture precondition in one pass", {
  skip: process.env.BOX_DRY_RUN_PART !== "box",
}, (t) => {
  const guard = spawnSync("/bin/bash", [GUARD], { encoding: "utf8", env: process.env });
  assert.equal(guard.status, 0, guard.stderr);
  const checkoutStubBefore = lstatSync(STUB);
  const denoPath = boxFactFixture<{ path: string }>("deno-runtime").path;
  const denoBefore = pathExists(denoPath)
    ? {
        stat: lstatSync(denoPath),
        digest: createHash("sha256").update(readFileSync(denoPath)).digest("hex"),
      }
    : undefined;
  const fixture = prepareBoxFixture("s2");
  const failures: string[] = [];
  const check = (label: string, expected: string, read: () => string, accepts: (actual: string) => boolean): void => {
    try {
      const actual = read();
      if (!accepts(actual)) failures.push(`${label}: expected ${expected}; actual=${JSON.stringify(actual)}`);
    } catch (error) {
      failures.push(`${label}: expected ${expected}; actual=ERROR ${(error as Error).message}`);
    }
  };
  const checkStat = (path: string, owner: number, group: number, mode: number, kind: "file" | "directory"): void => {
    check(path, `${kind} uid=${owner} gid=${group} mode=${mode.toString(8)}`, () => {
      const stat = lstatSync(path);
      const actualKind = stat.isFile() ? "file" : stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "symlink" : "other";
      return `${actualKind} uid=${stat.uid} gid=${stat.gid} mode=${(stat.mode & 0o777).toString(8)}`;
    }, (actual) => actual === `${kind} uid=${owner} gid=${group} mode=${mode.toString(8)}`);
  };
  try {
    check("effective uid", "0", () => String(process.getuid?.()), (actual) => actual === "0");
    check("hostname", "anything except yulan-vps-1", () => {
      const result = spawnSync("/bin/hostname", ["-s"], { encoding: "utf8" });
      return `status=${result.status} name=${result.stdout.trim()}`;
    }, (actual) => actual.startsWith("status=0 name=") && actual !== "status=0 name=yulan-vps-1");
    for (const name of boxFactFixture<{ users: string[] }>("host-accounts").users) {
      check(`user ${name}`, "present", () => {
        const result = spawnSync("/usr/bin/id", ["-u", name], { encoding: "utf8" });
        return `status=${result.status} uid=${result.stdout.trim()}`;
      }, (actual) => /^status=0 uid=\d+$/.test(actual));
      check(`primary group ${name}`, name, () => {
        const result = spawnSync("/usr/bin/id", ["-gn", name], { encoding: "utf8" });
        return `status=${result.status} group=${result.stdout.trim()}`;
      }, (actual) => actual === `status=0 group=${name}`);
    }
    for (const name of boxFactFixture<{ groups: string[] }>("host-accounts").groups) {
      check(`group ${name}`, "present", () => {
        const result = spawnSync("/usr/bin/getent", ["group", name], { encoding: "utf8" });
        return `status=${result.status} value=${result.stdout.trim()}`;
      }, (actual) => actual.startsWith("status=0 value="));
    }
    check("root can run as commonswarm", "status=0", () => {
      const result = spawnSync("/usr/bin/sudo", ["-n", "-u", "commonswarm", "/usr/bin/true"], { encoding: "utf8" });
      return `status=${result.status} stderr=${result.stderr.trim()}`;
    }, (actual) => actual === "status=0 stderr=");
    let sudoUmask = "";
    check("sudo umask", "a valid octal umask; fixture modes are then set explicitly", () => {
      const result = spawnSync("/usr/bin/sudo", ["-n", "/bin/bash", "-c", "umask"], { encoding: "utf8" });
      sudoUmask = result.stdout.trim();
      return `status=${result.status} umask=${sudoUmask} stderr=${result.stderr.trim()}`;
    }, (actual) => /^status=0 umask=0?[0-7]{3} stderr=$/.test(actual));
    check("sudo secure_path", "status=0 with /usr/local/bin, /usr/bin and /bin", () => {
      const result = spawnSync("/usr/bin/sudo", ["-n", "/bin/bash", "-c", "printf '%s' \"$PATH\""], { encoding: "utf8" });
      return `status=${result.status} path=${result.stdout.trim()} stderr=${result.stderr.trim()}`;
    }, (actual) => {
      const match = /^status=0 path=(.*) stderr=$/.exec(actual);
      if (!match) return false;
      const entries = match[1]!.split(":");
      return ["/usr/local/bin", "/usr/bin", "/bin"].every((path) => entries.includes(path));
    });

    check("PATH first entry", fixture.bin, () => fixture.env.PATH?.split(":")[0] ?? "", (actual) => actual === fixture.bin);
    const runtimeFact = boxFactFixture<{ stub_commands: string[]; mode: string }>("command-runtimes");
    for (const command of runtimeFact.stub_commands) {
      const path = join(fixture.bin, command);
      checkStat(path, 0, 0, Number.parseInt(runtimeFact.mode, 8), "file");
      check(`PATH command ${command}`, path, () => {
        const result = spawnSync("/bin/bash", ["-c", 'command -v -- "$1"', "box-preflight", command], {
          encoding: "utf8", env: fixture.env,
        });
        return `status=${result.status} path=${result.stdout.trim()}`;
      }, (actual) => actual === `status=0 path=${path}`);
      check(`stub location ${command}`, "outside the checkout", () => realpathSync(path),
        (actual) => !actual.startsWith(`${process.cwd()}/`));
    }
    check("stubbed sudo PATH", join(fixture.bin, "docker"), () => {
      const result = spawnSync("sudo", ["-n", "-u", "commonswarm", "/bin/bash", "-c", 'command -v -- "$1"', "box-preflight", "docker"], {
        encoding: "utf8", env: fixture.env,
      });
      return `status=${result.status} path=${result.stdout.trim()}`;
    }, (actual) => actual === `status=0 path=${join(fixture.bin, "docker")}`);
    checkStat(denoPath, 0, 0, 0o755, "file");
    checkStat(fixture.temporary!, 0, 0, 0o700, "directory");
    checkStat(fixture.bin, 0, 0, 0o755, "directory");
    checkStat(fixture.supportRoot!, 0, 0, 0o755, "directory");
    checkStat(fixture.prelude, 0, 0, 0o644, "file");
    checkStat(fixture.pythonFixture, 0, 0, 0o755, "directory");
    checkStat(join(fixture.pythonFixture, "sitecustomize.py"), 0, 0, 0o644, "file");
    checkStat(fixture.sourceRoot, 0, 0, 0o755, "directory");
    checkStat(join(fixture.sourceRoot, "supabase/migrations"), 0, 0, 0o755, "directory");
    checkStat(join(fixture.sourceRoot, "supabase/migrations/20260928000003_hm_oauth_store.sql"), 0, 0, 0o644, "file");
    check("box prelude location", "outside checkout", () => fixture.prelude, (actual) => !actual.startsWith(`${process.cwd()}/`));
    check("box Python fixture location", "outside checkout", () => fixture.pythonFixture, (actual) => !actual.startsWith(`${process.cwd()}/`));
    check("box source fixture location", "outside checkout", () => fixture.sourceRoot, (actual) => !actual.startsWith(`${process.cwd()}/`));
    for (const directory of fixture.rootDirectories ?? []) checkStat(directory.path, 0, 0, directory.mode, "directory");
    checkStat("/usr/local/bin", 0, 0, 0o755, "directory");
    checkStat("/run", 0, 0, 0o755, "directory");

    for (const [path, mode] of [
      [fixture.log, 0o600],
      ["/home/commonswarm/.env", 0o600],
      ["/etc/commonswarm-release/target.env", 0o600],
      ["/etc/ssl/yulan-internal-ca.pem", 0o600],
      ["/etc/commonswarm-oauth/database-credentials", 0o600],
      ["/etc/commonswarm-oauth/service.env", 0o600],
      ["/etc/caddy/sites/10-commonswarm-api.caddy", 0o644],
      ["/etc/caddy/sites/11-commonswarm-edge-staging.caddy", 0o644],
      ["/etc/caddy/sites/12-commonswarm-mcp.caddy", 0o644],
      ["/var/backups/commonswarm-postgres/status.json", 0o600],
      ["/tmp/commonswarm-release-window.env", 0o600],
      ["/tmp/commonswarm-release.tar", 0o600],
      ["/tmp/commonswarm-site-window.env", 0o600],
      [`/run/commonswarm-release-${RELEASE_SHA}-session.sh`, 0o600],
    ] as const) checkStat(path, 0, 0, mode, "file");
    checkStat(`/run/commonswarm-hm37-${WINDOW_ID}`, 0, 0, 0o700, "directory");
    checkStat(`/run/commonswarm-hm37-${WINDOW_ID}/hm37-open-ack-control.ts`, 0, 0, 0o644, "file");
    checkStat(`/run/commonswarm-hm37-${WINDOW_ID}/hm37-open-ack-deno.json`, 0, 0, 0o644, "file");
    checkStat(`/run/commonswarm-hm37-${WINDOW_ID}/human-session.json`, 0, 0, 0o600, "file");
    const proof = boxFactFixture<{ proof_dir: string }>("release-layout").proof_dir;
    checkStat(proof, 0, 0, 0o700, "directory");
    for (const name of readdirSync(proof)) {
      if (!lstatSync(join(proof, name)).isFile()) continue;
      checkStat(join(proof, name), 0, 0, 0o600, "file");
    }
    const commonswarmUidResult = spawnSync("/usr/bin/id", ["-u", "commonswarm"], { encoding: "utf8" });
    const commonswarmGidResult = spawnSync("/usr/bin/id", ["-g", "commonswarm"], { encoding: "utf8" });
    if (commonswarmUidResult.status === 0 && commonswarmGidResult.status === 0) {
      const commonswarmUid = Number.parseInt(commonswarmUidResult.stdout, 10);
      const commonswarmGid = Number.parseInt(commonswarmGidResult.stdout, 10);
      const releaseFact = boxFactFixture<{
        previous_edge: string; previous_stack: string; candidate_edge: string; candidate_stack: string;
      }>("release-layout");
      checkStat("/home/commonswarm", commonswarmUid, commonswarmGid, 0o750, "directory");
      checkStat("/srv/commonswarm", commonswarmUid, commonswarmGid, 0o750, "directory");
      checkStat(releaseFact.previous_edge, commonswarmUid, commonswarmGid, 0o755, "directory");
      checkStat(releaseFact.previous_stack, commonswarmUid, commonswarmGid, 0o755, "directory");
      checkStat(releaseFact.candidate_edge, commonswarmUid, commonswarmGid, 0o750, "directory");
      checkStat(releaseFact.candidate_stack, commonswarmUid, commonswarmGid, 0o755, "directory");
    } else {
      failures.push(`commonswarm ownership ids: expected numeric uid/gid; actual uid_status=${commonswarmUidResult.status} gid_status=${commonswarmGidResult.status}`);
    }
    check("commonswarm fixture access", "status=0", () => {
      const result = spawnSync("/usr/bin/sudo", [
        "-n", "-u", "commonswarm", "/usr/bin/test", "-r",
        "/srv/commonswarm/site/current/app/index.html",
      ], { encoding: "utf8" });
      return `status=${result.status} stderr=${result.stderr.trim()}`;
    }, (actual) => actual === "status=0 stderr=");
    check("/run fixture filesystem", "tmpfs", () => {
      const result = spawnSync("/usr/bin/stat", ["-f", "-c", "%T", "/run"], { encoding: "utf8" });
      return `status=${result.status} type=${result.stdout.trim()}`;
    }, (actual) => actual === "status=0 type=tmpfs");
    assert.equal(failures.length, 0, `box preflight unmet preconditions (${failures.length}):\n${failures.join("\n")}`);
    t.diagnostic(`box fixture neutralized sudo umask ${sudoUmask || "unknown"} with explicit owner/mode construction`);
  } finally {
    cleanupBoxFixture(fixture);
  }
  const checkoutStubAfter = lstatSync(STUB);
  assert.equal(checkoutStubAfter.uid, checkoutStubBefore.uid, "checkout stub owner changed");
  assert.equal(checkoutStubAfter.gid, checkoutStubBefore.gid, "checkout stub group changed");
  assert.equal(checkoutStubAfter.mode & 0o777, checkoutStubBefore.mode & 0o777, "checkout stub mode changed");
  if (denoBefore) {
    const denoAfter = lstatSync(denoPath);
    assert.equal(denoAfter.uid, denoBefore.stat.uid, "runner Deno owner was not restored");
    assert.equal(denoAfter.gid, denoBefore.stat.gid, "runner Deno group was not restored");
    assert.equal(denoAfter.mode & 0o777, denoBefore.stat.mode & 0o777, "runner Deno mode was not restored");
    assert.equal(createHash("sha256").update(readFileSync(denoPath)).digest("hex"), denoBefore.digest, "runner Deno content was not restored");
  } else {
    assert.equal(pathExists(denoPath), false, "fixture Deno was not removed");
  }
});

test("Mac harness uses a temporary local clone and recorded command stubs only", () => {
  const temporary = mkdtempSync(join(tmpdir(), "commonswarm-box-dry-run-mac-"));
  try {
    const clone = join(temporary, "checkout");
    const home = join(temporary, "child-home");
    const bin = join(temporary, "bin");
    const log = join(temporary, "stub.log");
    mkdirSync(home, { mode: 0o700 });
    mkdirSync(bin, { mode: 0o700 });
    const cloned = spawnSync("git", ["clone", "--no-hardlinks", "--no-checkout", ".", clone], {
      encoding: "utf8",
      env: { ...process.env, HOME: home },
    });
    assert.equal(cloned.status, 0, cloned.stderr);
    for (const command of ["docker", "systemctl", "psql", "caddy", "ssh", "scp", "sudo", "op", "curl", "chown"]) {
      const target = join(bin, command);
      symlinkSync(resolve(STUB), target);
    }
    const baseEnv = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH ?? ""}`, BOX_DRY_RUN_STUB_LOG: log };
    assert.equal(spawnSync("ssh", ["ops@box", "true"], { env: baseEnv }).status, 0);
    assert.equal(spawnSync("scp", ["fixture", "ops@box:/tmp/fixture"], { env: baseEnv }).status, 0);
    assert.equal(spawnSync("op", ["read", "op://placeholder"], { env: baseEnv }).status, 0);
    assert.notEqual(spawnSync("curl", ["https://api.commonswarm.com"], { env: baseEnv }).status, 0);
    assert.equal(spawnSync("curl", ["-H", "User-Agent: commonswarm-release-probe/1.0", "https://api.commonswarm.com"], { env: baseEnv }).status, 0);
    assert.notEqual(spawnSync("psql", ["--file", "/host/proof.sql"], { env: baseEnv }).status, 0);
    assert.equal(spawnSync("psql", ["--file", "/proof/proof.sql"], { env: baseEnv }).status, 0);
    const calls = readFileSync(log, "utf8").trim().split("\n");
    assert.equal(calls.length, 7);
    assert.ok(calls.every(Boolean));
    assert.equal(existsSync(join(clone, ".git")), true);
  } finally {
    removeOwnedTemporary(temporary, "commonswarm-box-dry-run-mac-");
  }
});

test("HM37 switch inputs select the plan's exact successful-path steps", () => {
  const selected = selectedHmSequence();
  assert.ok(selected.length > 0);
  assert.equal(new Set(selected).size, selected.length, "successful-path order contains a duplicate step");
  for (const [input, steps] of switchStepGroups()) {
    const present = steps.filter((step) => selected.includes(step));
    assert.deepEqual(present, planInput(input) === "yes" ? steps : [], `${input} selected the wrong steps`);
  }
  assert.deepEqual(selected.slice(-6), [
    "hm37-validate-local-credential", "runbook-13", "runbook-11",
    "runbook-60", "runbook-61", "runbook-12",
  ]);
  assert.deepEqual(planTail("rollback").slice(0, 2), [
    "runbook-42", "hm37-reserve-schema-rollback",
  ], "the previous edge must be restored before the schema inverse checks it");
});

test("box fact inventory is complete, measurable, and is the fixture value source", (t) => {
  assert.equal(BOX_FACTS.schema, 1);
  assert.match(BOX_FACTS.scope, /hm37-hosted-control-stage/i);
  assert.ok(BOX_FACTS.facts.length >= 14);
  assert.equal(new Set(BOX_FACTS.facts.map((fact) => fact.id)).size, BOX_FACTS.facts.length);
  for (const fact of BOX_FACTS.facts) {
    assert.match(fact.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.ok(fact.fact.length > 20, `${fact.id}: missing fact`);
    assert.ok(fact.assumed_by.length > 0, `${fact.id}: missing block/line`);
    assert.ok(fact.assumed_by.every((source) => /\.md:\d+/.test(source)), `${fact.id}: imprecise block/line`);
    assert.match(fact.evidence, /^(?:NOT RECORDED|docs\/evidence\/)/, `${fact.id}: invalid evidence status`);
    assert.ok(fact.measure.length > 10, `${fact.id}: missing read-only measurement`);
    assert.doesNotMatch(fact.measure, /\brm\b|\bmv\b|\binstall\b|\bchmod\b|\bchown\b|systemctl\s+(?:start|stop|restart|reload)|docker\s+(?:run|pull|compose\s+up)/,
      `${fact.id}: measurement is not read-only`);
    assert.ok(Object.keys(fact.fixture).length > 0, `${fact.id}: missing fixture value`);
    assert.doesNotThrow(() => JSON.stringify(boxFactFixture(fact.id)), `${fact.id}: fixture value unreadable`);
    t.diagnostic(`${fact.id}: ${fact.evidence}; measure=${fact.measure}`);
  }
});

test("box runtime stubs are regular root-owned executables and emit accepted Deno shapes", {
  skip: process.env.BOX_DRY_RUN_PART !== "box",
}, () => {
  const guard = spawnSync("/bin/bash", [GUARD], { encoding: "utf8", env: process.env });
  assert.equal(guard.status, 0, guard.stderr);
  const fixture = prepareBoxFixture("s2");
  try {
    const runtimeFact = boxFactFixture<{ stub_commands: string[]; mode: string }>("command-runtimes");
    for (const command of runtimeFact.stub_commands) {
      const stat = lstatSync(join(fixture.bin, command));
      assert.equal(stat.isFile(), true, `${command} is not a regular file`);
      assert.equal(stat.isSymbolicLink(), false, `${command} is a symlink`);
      assert.equal(stat.mode & 0o777, Number.parseInt(runtimeFact.mode, 8), `${command} mode`);
      assert.equal(stat.uid, 0, `${command} owner`);
      assert.equal(stat.gid, 0, `${command} group`);
    }
    const denoFact = boxFactFixture<{ path: string; version_output: string }>("deno-runtime");
    const denoStat = lstatSync(denoFact.path);
    assert.equal(denoStat.isFile(), true);
    assert.equal(denoStat.isSymbolicLink(), false);
    assert.equal(denoStat.mode & 0o777, 0o755);
    assert.equal(denoStat.uid, 0);
    assert.equal(denoStat.gid, 0);
    const version = spawnSync(denoFact.path, ["--version"], { encoding: "utf8", env: fixture.env });
    assert.equal(version.status, 0, version.stderr);
    assert.equal(version.stdout.trim(), denoFact.version_output);
    const cache = spawnSync(denoFact.path, ["cache", "--no-lock", "fixture.ts"], { encoding: "utf8", env: fixture.env });
    assert.equal(cache.status, 0, cache.stderr);
    const run = spawnSync(denoFact.path, ["run", "hm37-open-ack-control.ts"], { encoding: "utf8", env: fixture.env });
    assert.equal(run.status, 0, run.stderr);
    const output = JSON.parse(run.stdout) as { ok: boolean; mode: string; assertions: Record<string, boolean> };
    assert.equal(output.ok, true);
    assert.equal(output.mode, "control");
    assert.equal(output.assertions["hosted.cleanup-complete"], true);
    const calls = readFileSync(fixture.log, "utf8");
    assert.match(calls, /^deno --version$/m);
    assert.match(calls, /^deno cache --no-lock fixture\.ts$/m);
    assert.match(calls, /^deno run hm37-open-ack-control\.ts$/m);
  } finally {
    cleanupBoxFixture(fixture);
  }
});

test("five box states cover pass, pre-commit rollback, post-commit cleanup, and S-class rollback", (t) => {
  const hmSequence = selectedHmSequence();
  const rollback = planTail("rollback");
  const cleanupOnly = planTail("cleanup");
  const states = JSON.parse(readFileSync("tests/box-dry-run/fixtures/states.json", "utf8")) as Record<string, string>;
  assert.deepEqual(Object.keys(states), ["s1", "s2", "s3", "s4", "s5"]);
  const scenarios = [
    { path: "all-pass", failure: "", tail: [] as string[] },
    { path: "before-commit", failure: "hm37-backup-gate", tail: rollback },
    { path: "after-control", failure: "hm37-hosted-open-ack-control", tail: cleanupOnly },
    { path: "after-safety-S3", failure: "hm37-hosted-open-ack-control", tail: rollback },
  ];
  const allBlocks = [...blocks(HM37), ...blocks(RUNBOOK)];
  const byStep = new Map(allBlocks.map((block) => [shortStep(block), block]));
  const known = new Set(byStep.keys());
  for (const step of new Set([...hmSequence, ...rollback, ...cleanupOnly])) assert.ok(known.has(step), `unknown sequence step ${step}`);
  const part = process.env.BOX_DRY_RUN_PART === "box" ? "box" : "mac";
  for (const [state, description] of Object.entries(states)) {
    for (const scenario of scenarios) {
      const stop = scenario.failure ? hmSequence.indexOf(scenario.failure) : hmSequence.length - 1;
      assert.ok(stop >= 0);
      const ordered = scenario.failure
        ? [...hmSequence.slice(0, stop + 1), ...scenario.tail]
        : hmSequence;
      let fixture: Fixture;
      if (part === "box") {
        const guard = spawnSync("/bin/bash", [GUARD], { encoding: "utf8", env: process.env });
        assert.equal(guard.status, 0, guard.stderr);
        fixture = prepareBoxFixture(state);
      } else {
        fixture = prepareMacFixture();
      }
      try {
        const records: Execution[] = [];
        for (const step of ordered) {
          const block = byStep.get(step)!;
          const isBox = block.host.startsWith("box ");
          if ((part === "box") !== isBox) continue;
          const failure = scenario.failure === step;
          const record = executeWholeBlock(block, fixture, { fail: failure });
          records.push(record);
          if (failure) {
            assert.equal(record.result, "failed", `${state}/${scenario.path}/${step} did not exercise its injected failure`);
            assert.ok(record.firstFailingCommand, `${state}/${scenario.path}/${step} did not report the first failing command`);
          } else {
            assert.equal(record.result, "passed", `${state}/${scenario.path}/${step}: ${record.stderr}`);
          }
        }
        const expectedFailures = part === "box" && scenario.failure ? 1 : 0;
        assert.equal(records.filter((record) => record.result === "failed").length, expectedFailures);
        t.diagnostic(`${part}:${state}/${scenario.path} (${description}): ${records.map((record) => `${record.step}=${record.result}${record.firstFailingCommand ? `[${record.firstFailingCommand}]` : ""}`).join(",")}`);
      } finally {
        if (part === "box") cleanupBoxFixture(fixture);
        else cleanupMacFixture(fixture);
      }
    }
  }
});

test("selected readonly blocks run alone from their ordered pre-step snapshots", (t) => {
  const sequence = selectedHmSequence();
  const allBlocks = [...blocks(HM37), ...blocks(RUNBOOK)];
  const byStep = new Map(allBlocks.map((block) => [shortStep(block), block]));
  const part: FixturePart = process.env.BOX_DRY_RUN_PART === "box" ? "box" : "mac";
  const snapshotRoot = mkdtempSync(join(tmpdir(), "commonswarm-box-dry-run-snapshots-"));
  const snapshots: Array<{ block: Block; archive: string }> = [];
  let fixture: Fixture;
  if (part === "box") {
    const guard = spawnSync("/bin/bash", [GUARD], { encoding: "utf8", env: process.env });
    assert.equal(guard.status, 0, guard.stderr);
    fixture = prepareBoxFixture("s2");
  } else {
    fixture = prepareMacFixture();
  }
  try {
    for (const step of sequence) {
      const block = byStep.get(step)!;
      if (block.host.startsWith("box ") !== (part === "box")) continue;
      if (block.marker === "yes") {
        const archive = join(snapshotRoot, `${String(snapshots.length).padStart(2, "0")}-${step}.tar`);
        snapshotFixture(fixture, part, archive);
        snapshots.push({ block, archive });
      }
      const record = executeWholeBlock(block, fixture);
      assert.equal(record.result, "passed", `ordered ${step}: ${record.stderr}`);
    }
    if (part === "box") cleanupBoxFixture(fixture);
    else cleanupMacFixture(fixture);

    for (const { block, archive } of snapshots) {
      restoreFixture(fixture, part, archive);
      const record = executeWholeBlock(block, fixture);
      assert.equal(record.result, "passed", `${block.step}: ${record.stderr}`);
      t.diagnostic(`${part}:${shortStep(block)}=snapshot/reran/passed`);
    }
    t.diagnostic(`alone_records=${snapshots.length}; each fresh shell used its ordered pre-step snapshot`);
  } finally {
    if (part === "box") cleanupBoxFixture(fixture);
    else cleanupMacFixture(fixture);
    removeOwnedTemporary(snapshotRoot, "commonswarm-box-dry-run-snapshots-");
  }
});

test("runbook-18 accepts the selected H0 backfill's empty-ledger evidence state", {
  skip: process.env.BOX_DRY_RUN_PART !== "box",
}, () => {
  const guard = spawnSync("/bin/bash", [GUARD], { encoding: "utf8", env: process.env });
  assert.equal(guard.status, 0, guard.stderr);
  const fixture = prepareBoxFixture("s2");
  try {
    const block = blocks(RUNBOOK).find((candidate) => shortStep(candidate) === "runbook-18");
    assert.ok(block);
    const record = executeWholeBlock(block, fixture);
    assert.equal(record.result, "passed", record.stderr);
    const ledger = `/home/commonswarm/stack/release-proofs/${RELEASE_SHA}/h0-ledger-before.txt`;
    assert.equal(readFileSync(ledger, "utf8"), "");
  } finally {
    cleanupBoxFixture(fixture);
  }
});

test("historical controls execute and reproduce the named failures while current text fixes them", () => {
  const old = gitShow("1b1a5549", HM37);
  const oldOauth = stepSource(old, "hm37-hm6-oauth-precondition");
  assert.match(oldOauth, /IFS= read -r MCP_OAUTH_IMAGE <[^\n]+oauth-image\.id"\n/);
  const currentOauth = stepSource(readFileSync(HM37, "utf8"), "hm37-hm6-oauth-precondition");
  assert.match(currentOauth, /oauth-image\.id" \|\| \[ -n "\$MCP_OAUTH_IMAGE" \]/);

  const oldBackup = stepSource(old, "hm37-backup-gate");
  assert.ok(oldBackup.indexOf("$PROOF_DIR") >= 0 && !/PROOF_DIR=/.test(oldBackup));
  assert.match(stepSource(readFileSync(HM37, "utf8"), "hm37-backup-gate"), /PROOF_DIR=/);

  const oldPublic = stepSource(old, "hm37-public-boundaries");
  assert.doesNotMatch(oldPublic, /commonswarm-release-probe\/1\.0/);
  assert.match(stepSource(readFileSync(HM37, "utf8"), "hm37-public-boundaries"), /commonswarm-release-probe\/1\.0/);

  const oldMedia = gitShow("7e87bceb", HM37);
  assert.match(oldMedia, /assert "application\/json" in content_type/);
  assert.match(readFileSync(HM37, "utf8"), /expected_media = "application\/jwk-set\+json"/);

  const runbook = readFileSync(RUNBOOK, "utf8");
  assert.match(runbook, /release_psql_ro: --file must name APPLY_SQL or a PROOF_DIR file/);
  assert.match(runbook, /RELEASE_DIR_RESULT=reused/);
  assert.doesNotMatch(runbook, /STACK_RELEASE_DIR=/);

  const fixture = prepareMacFixture();
  try {
    const controlRoot = join(fixture.temporary!, "historical-root");
    const oldProof = join(controlRoot, "stack/release-proofs", RELEASE_SHA);
    mkdirSync(oldProof, { recursive: true });
    writeMode(join(oldProof, "window.env"), `SHA='${RELEASE_SHA}'\nWINDOW_ID='${WINDOW_ID}'\n`);
    const oldOauthSha = "826db6a34f235064a3a03c57377d8e32a35d2f05";
    const oldOauthRelease = join(controlRoot, "oauth/releases", oldOauthSha);
    const oldOauthProof = join(controlRoot, "stack/release-proofs", oldOauthSha);
    mkdirSync(oldOauthRelease, { recursive: true });
    mkdirSync(oldOauthProof, { recursive: true });
    writeMode(join(oldOauthRelease, "RELEASE_SHA"), `${oldOauthSha}\n`, 0o644);
    mkdirSync(join(controlRoot, "oauth"), { recursive: true });
    symlinkSync(oldOauthRelease, join(controlRoot, "oauth/current"));
    writeMode(join(oldOauthProof, "oauth-image.id"), `sha256:${"0".repeat(64)}`); // deliberately no newline
    const historicalOauth: Block = {
      file: HM37, step: "historical-oauth-read", marker: "yes", host: "Mac mini /bin/bash 3.2",
      line: 1, source: oldOauth.replaceAll("/home/commonswarm", controlRoot),
    };
    const historicalFixture: Fixture = {
      ...fixture,
      env: { ...fixture.env },
    };
    const readFailure = executeWholeBlock(historicalOauth, historicalFixture, { control: "historical-oauth-read" });
    assert.equal(readFailure.result, "failed");
    assert.match(readFailure.firstFailingCommand ?? readFailure.stderr, /read -r MCP_OAUTH_IMAGE/);

    const historicalBackup: Block = {
      file: HM37, step: "historical-backup-unbound", marker: "yes", host: "Mac mini /bin/bash 3.2",
      line: 1, source: oldBackup.replaceAll("/home/commonswarm", controlRoot),
    };
    const backupFailure = executeWholeBlock(historicalBackup, historicalFixture, { control: "historical-backup-unbound" });
    assert.equal(backupFailure.result, "failed");
    assert.match(backupFailure.stderr, /PROOF_DIR: unbound variable/);

    const psql = spawnSync("psql", ["--file", "/host/proof.sql"], { encoding: "utf8", env: fixture.env });
    assert.notEqual(psql.status, 0);
    assert.match(psql.stderr, /bind-mounted container path/);

    const historicalPublic: Block = {
      file: HM37, step: "hm37-public-boundaries", marker: "probe", host: "Mac mini /bin/bash 3.2",
      line: 1, source: oldPublic,
    };
    const noUa = executeWholeBlock(historicalPublic, historicalFixture, { control: "historical-default-ua" });
    assert.equal(noUa.result, "failed");
    assert.match(noUa.stderr, /HTTP Error 403|python3 .*gateway/);

    writeMode(join(oldOauthProof, "oauth-image.id"), `sha256:${"0".repeat(64)}\n`);
    const historicalMediaSource = stepSource(oldMedia, "hm37-hm6-oauth-precondition");
    const historicalMedia: Block = {
      file: HM37, step: "hm37-hm6-oauth-precondition", marker: "yes", host: "Mac mini /bin/bash 3.2",
      line: 1, source: historicalMediaSource.replaceAll("/home/commonswarm", controlRoot),
    };
    const wrongMedia = executeWholeBlock(historicalMedia, historicalFixture, { control: "historical-media" });
    assert.equal(wrongMedia.result, "failed");
    assert.match(wrongMedia.stderr, /AssertionError|python3 - https:\/\/mcp\.commonswarm\.com/);

    const oldRunbook = gitShow("b912b349", RUNBOOK);
    const oldOpen = stepSource(oldRunbook, "1-apply-release-directories");
    assert.match(oldOpen, /prepare_release_directory/);
    const b912Root = join(fixture.temporary!, "b912-root");
    const previousEdge = join(b912Root, "edge/releases/72c57e0d76d0aa86fe4f811a2cf51499919fed20");
    const previousStack = join(b912Root, "stack/releases/ad964ed158181ba1692dd05895f36fa7a1f87d3f");
    const newEdge = join(b912Root, `edge/releases/${RELEASE_SHA}`);
    const newStack = join(b912Root, `stack/releases/${RELEASE_SHA}`);
    for (const release of [previousEdge, previousStack, newEdge, newStack]) mkdirSync(release, { recursive: true });
    mkdirSync(join(b912Root, "edge"), { recursive: true });
    mkdirSync(join(b912Root, "stack"), { recursive: true });
    symlinkSync(previousEdge, join(b912Root, "edge/current"));
    symlinkSync(previousStack, join(b912Root, "stack/current"));
    const b912Window = join(fixture.temporary!, "b912-window.env");
    const b912Archive = join(fixture.temporary!, "b912-release.tar");
    writeMode(b912Window, `SHA='${RELEASE_SHA}'\nWINDOW_START_UTC='${WINDOW_START}'\nWINDOW_ID='${WINDOW_ID}'\n`);
    writeMode(b912Archive, "rollback-left archive fixture\n");
    const secondOpenBlock: Block = {
      file: RUNBOOK, step: "1-apply-release-directories", marker: "no", host: "Mac mini /bin/bash 3.2",
      line: 1,
      source: oldOpen
        .replaceAll("/tmp/commonswarm-release-window.env", b912Window)
        .replaceAll("/tmp/commonswarm-release.tar", b912Archive)
        .replaceAll("/home/commonswarm", b912Root),
    };
    const secondOpen = executeWholeBlock(secondOpenBlock, historicalFixture, { control: "b912-second-open" });
    assert.equal(secondOpen.result, "failed");
    assert.match(secondOpen.stderr, /cannot be reopened after rollback/);
  } finally {
    cleanupMacFixture(fixture);
  }
});

test("lane 8 runs its six whole blocks in plan order", (t) => {
  const site = blocks(SITE);
  assert.equal(site.length, 6);
  assert.deepEqual(site.map((block) => block.step.split(" — ")[0]), ["site-01", "site-02", "site-03", "site-04", "site-05", "site-06"]);
  const part = process.env.BOX_DRY_RUN_PART === "box" ? "box" : "mac";
  let fixture: Fixture;
  if (part === "box") {
    const guard = spawnSync("/bin/bash", [GUARD], { encoding: "utf8", env: process.env });
    assert.equal(guard.status, 0, guard.stderr);
    fixture = prepareBoxFixture("s2");
  } else {
    fixture = prepareMacFixture();
    fixture.cwd = prepareSiteFixture(fixture);
  }
  try {
    const records: Execution[] = [];
    for (const block of site) {
      if (block.host.startsWith("box ") !== (part === "box")) continue;
      const record = executeWholeBlock(block, fixture);
      assert.equal(record.result, "passed", `${record.step}: ${record.stderr}`);
      records.push(record);
    }
    t.diagnostic(`${part}:` + records.map((record) => `${record.step}=ran/${record.result}`).join(","));
  } finally {
    if (part === "box") cleanupBoxFixture(fixture);
    else cleanupMacFixture(fixture);
  }
});

test("non-substitutable surfaces are explicit", (t) => {
  const items = JSON.parse(readFileSync("tests/box-dry-run/fixtures/non-substitutable.json", "utf8")) as Array<{ surface: string; reason: string }>;
  assert.ok(items.length >= 6);
  assert.ok(items.every((item) => item.surface && item.reason));
  for (const item of items) t.diagnostic(`${item.surface}: ${item.reason}`);
});

test("CI box mode is guarded before real-path whole-block fixtures", { skip: process.env.BOX_DRY_RUN_PART !== "box" }, () => {
  const guard = spawnSync("/bin/bash", [GUARD], { encoding: "utf8", env: process.env });
  assert.equal(guard.status, 0, guard.stderr);
  assert.match(guard.stdout, /BOX_DRY_RUN_GUARD=PASS/);
  for (const path of ["/home/commonswarm", "/srv/commonswarm"]) assert.equal(existsSync(path), false);
  assert.equal(existsSync("/home/commonswarm"), false);
  assert.equal(existsSync("/srv/commonswarm"), false);
});
