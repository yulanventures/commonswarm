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
  readlinkSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";

const RUNBOOK = "deploy/RELEASE-TO-BOX.md";
const PREP = "docs/evidence/2026-09-29-hm37-prep/BOX-WINDOW.md";
const HM37 = "docs/evidence/2026-09-28-box-hm37/BOX-WINDOW.md";
const HM37B = "docs/evidence/2026-09-29-box-hm37b/BOX-WINDOW.md";
const SITE = "docs/evidence/2026-09-28-site-hm8/SITE-RELEASE.md";
const TEMPLATE = "docs/design/BOX-PLAN-TEMPLATE.md";
const SCOPED = [PREP, HM37, HM37B, RUNBOOK, SITE, TEMPLATE];
const GUARD = "tests/box-dry-run/guard.sh";
const STUB = "tests/box-dry-run/stubs/dispatch.sh";
const USERLAND = resolve("tests/box-dry-run/stubs/box-userland.py");
const NON_SUBSTITUTABLE_FILE = "tests/box-dry-run/fixtures/non-substitutable.json";
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const MAC_ONLY = process.env.BOX_DRY_RUN_PART === "box"
  ? "Mac-only fixture/control; exercised by the Mac lane with its mandatory sandbox-exec jail"
  : false;
const PRELUDE = resolve("tests/box-dry-run/prelude.sh");
const PYTHON_FIXTURE = resolve("tests/box-dry-run/python");
const PRESEED_ALLOWLIST_FILE = "tests/box-dry-run/fixtures/preseed-allowlist.json";
const PROMPT_FILE_SCHEMAS = "tests/box-dry-run/fixtures/prompt-file-schemas";
const COMMAND_OUTPUTS_FILE = "tests/box-dry-run/fixtures/command-outputs.json";
const MEASURED_FACTS_FILE = "docs/evidence/2026-09-29-box-facts/box-facts-measured.json";
const OAUTH_IMAGE_FILE = "docs/evidence/2026-09-28-release-826db6a34f23-v5/oauth-image.json";
const OAUTH_RUNTIME_FILE = "docs/evidence/2026-09-28-release-826db6a34f23-v5/oauth-runtime.json";
const REAL_CHECKOUT = process.cwd();
const SITE_SHA = "8b8989f2b29e440a317a2cdedf11195901c8342c";
const WINDOW_START = "2026-09-28T01:02:03Z";
const WINDOW_ID = "20260928T010203Z";
const EDGE_PUBLIC_ENABLED_EVIDENCE = "docs/evidence/2026-09-29-release-eb2a87ac4b5a/hm37-closure.txt";
// Committed readback at hm37-closure.txt:12; A's final check preserves this dark state
// (docs/evidence/2026-09-28-box-hm37/BOX-WINDOW.md:2227-2228).
const EDGE_PUBLIC_ENABLED = /^mcp_public_enabled=(.+)$/m.exec(readFileSync(EDGE_PUBLIC_ENABLED_EVIDENCE, "utf8"))?.[1];
assert.ok(EDGE_PUBLIC_ENABLED, "committed closure has no public-enabled observation");

interface Block {
  file: string;
  step: string;
  marker: "yes" | "probe" | "no";
  host: string;
  source: string;
  line: number;
}

interface MeasuredFact {
  id: string;
  source_id: string;
  command: string;
  output: string;
  exit: number;
  note: string;
  result?: unknown;
  checks?: Array<Record<string, unknown>>;
}

interface MeasuredFactInventory {
  schema: number;
  facts: MeasuredFact[];
  fact_count: number;
  k4?: { items: MeasuredFact[] };
  production_recheck: { output: string };
}

type PreseedKind = "path" | "env" | "command-output";

interface PreseedAllowlistItem {
  kind: PreseedKind;
  name: string;
  source: string;
  evidence?: string;
  evidence_file?: string;
}

interface PromptInput {
  name: string;
  format: string;
  supplier: string;
  meaning: string;
  plan: string;
}

const PRESEED_ALLOWLIST = JSON.parse(readFileSync(PRESEED_ALLOWLIST_FILE, "utf8")) as PreseedAllowlistItem[];
const PLAN_VISIBLE_PATH_PRESEEDS = [
  "/home/commonswarm/edge/current",
  "/home/commonswarm/stack/current",
  "/home/commonswarm/edge/releases/<previous>",
  "/home/commonswarm/edge/releases/<previous>/RELEASE_SHA",
  "/home/commonswarm/stack/releases/<previous>",
  "/home/commonswarm/stack/releases/<previous>/RELEASE_SHA",
  "/home/commonswarm/edge/releases/<candidate>",
  "/home/commonswarm/edge/releases/<candidate>/RELEASE_SHA",
  "/home/commonswarm/stack/releases/<candidate>",
  "/home/commonswarm/stack/releases/<candidate>/RELEASE_SHA",
  "/home/commonswarm/stack/release-proofs/<closed>",
  "/etc/commonswarm-oauth/database-credentials",
  "/etc/commonswarm-oauth/service.env",
  "/etc/ssl/yulan-internal-ca.pem",
  "/etc/commonswarm-release/target.env",
  "/home/commonswarm/stack/current/deploy/supabase-stack/migrate/run-db-tool.sh",
  "/var/backups/commonswarm-postgres/status.json",
  "/home/commonswarm/.env",
  "/usr/local/bin",
  "/srv/commonswarm/site/current",
  "/srv/commonswarm/site/releases/<previous>",
  "/srv/commonswarm/site/releases/<previous>/app/index.html",
  "/srv/commonswarm/site/releases/<previous>/download/index.html",
  "/home/commonswarm/edge/releases/72c57e0d76d0aa86fe4f811a2cf51499919fed20/deploy/edge-runtime/compose.override.yaml",
  "/home/commonswarm/stack/release-proofs/826db6a34f235064a3a03c57377d8e32a35d2f05/oauth-image.id",
  "/home/commonswarm/stack/release-proofs",
].sort();

function explicitEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    LANG: "C.UTF-8",
    TZ: "UTC",
    ...extra,
  };
}

function assertChildEnvironmentAllowed(environment: NodeJS.ProcessEnv, promptInputs: PromptInput[] = []): void {
  const allowed = new Set([
    ...PRESEED_ALLOWLIST.filter((item) => item.kind === "env").map((item) => item.name),
    ...promptInputs.map((item) => item.name),
  ]);
  for (const name of Object.keys(environment)) assert.ok(allowed.has(name), `block shell received non-allowlisted env ${name}`);
}

function assertPromptFormat(format: string, context: string, nested = false): void {
  assert.ok(format && !format.includes("\n"), `${context}: invalid prompt format ${JSON.stringify(format)}`);
  if (format.startsWith("literal:")) {
    assert.ok(format.length > "literal:".length, `${context}: literal format requires text`);
    return;
  }
  if (["sha40", "uuid", "decimal-positive", "iso-utc", "abs-dir"].includes(format)) return;
  if (format.startsWith("enum:")) {
    const values = format.slice("enum:".length).split("|");
    assert.ok(values.length >= 2 && values.every(Boolean), `${context}: enum format requires at least two nonempty values`);
    assert.equal(new Set(values).size, values.length, `${context}: enum format repeats a value`);
    return;
  }
  if (format.startsWith("abs-file:")) {
    assert.match(format.slice("abs-file:".length), /^[a-z0-9][a-z0-9-]*$/, `${context}: invalid prompt file schema id`);
    return;
  }
  if (format.startsWith("list:") && !nested) {
    assertPromptFormat(format.slice("list:".length), context, true);
    return;
  }
  assert.fail(`${context}: unsupported prompt format ${format}`);
}

function promptInputsFromMarkdown(file: string, markdown: string): PromptInput[] {
  const fences = [...markdown.matchAll(/^```prompt-inputs[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm)];
  assert.ok(fences.length <= 1, `${file}: expected at most one prompt-inputs block, found ${fences.length}`);
  if (fences.length === 0) return [];
  const fence = fences[0]!;
  const fenceLine = markdown.slice(0, fence.index).split(/\r?\n/).length;
  const inputs: PromptInput[] = [];
  for (const [offset, line] of (fence[1] ?? "").split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const context = `${file}:${fenceLine + offset + 1}`;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      assert.fail(`${context}: malformed prompt-inputs JSON: ${(error as Error).message}`);
    }
    assert.ok(parsed && typeof parsed === "object" && !Array.isArray(parsed), `${context}: prompt input must be an object`);
    const record = parsed as Record<string, unknown>;
    assert.deepEqual(Object.keys(record).sort(), ["format", "meaning", "name", "supplier"],
      `${context}: prompt input must contain exactly name, format, supplier, and meaning`);
    for (const key of ["name", "format", "supplier", "meaning"] as const) {
      assert.ok(typeof record[key] === "string" && record[key].trim().length > 0 && !record[key].includes("\n"),
        `${context}: ${key} must be a nonempty one-line string`);
    }
    assert.match(record.name as string, /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/, `${context}: name is not UPPER_SNAKE`);
    assert.doesNotMatch(record.name as string, /^BOX_DRY_RUN_/, `${context}: plan cannot declare a harness adapter variable`);
    assertPromptFormat(record.format as string, context);
    inputs.push({
      name: record.name as string,
      format: record.format as string,
      supplier: record.supplier as string,
      meaning: record.meaning as string,
      plan: file,
    });
  }
  const names = inputs.map((input) => input.name);
  assert.equal(new Set(names).size, names.length, `${file}: duplicate prompt input name`);
  return inputs;
}

function promptInputs(file: string): PromptInput[] {
  return promptInputsFromMarkdown(file, readFileSync(file, "utf8"));
}

function promptInputsForBlocks(planBlocks: Block[]): PromptInput[] {
  const files = [...new Set(planBlocks.map((block) => block.file))];
  const inputs = files.flatMap(promptInputs);
  const names = inputs.map((input) => input.name);
  assert.equal(new Set(names).size, names.length,
    `planned run declares a prompt input more than once: ${names.filter((name, index) => names.indexOf(name) !== index).join(", ")}`);
  return inputs;
}

function pinnedPromptValue(input: PromptInput): string | undefined {
  const markdown = readFileSync(input.plan, "utf8");
  const escaped = input.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [...markdown.matchAll(new RegExp(`test\\s+"\\$\\{?${escaped}\\}?"\\s+=\\s+(?:'([^'\\n]+)'|"([^"\\n]+)"|([^\\s;]+))`, "g"))]
    .map((match) => match[1] ?? match[2] ?? match[3]!);
  if (matches.length === 0) return undefined;
  assert.equal(new Set(matches).size, 1, `${input.plan}: ${input.name} is pinned to conflicting literals`);
  const value = matches[0]!;
  if (input.format === "sha40") assert.match(value, /^[0-9a-f]{40}$/, `${input.plan}: ${input.name} pinned value is not sha40`);
  if (input.format.startsWith("literal:")) {
    assert.equal(value, input.format.slice("literal:".length), `${input.plan}: ${input.name} literal format disagrees with plan check`);
  }
  return value;
}

function promptSchemaContent(schemaId: string): string {
  const path = join(PROMPT_FILE_SCHEMAS, `${schemaId}.json`);
  assert.equal(existsSync(path), true, `missing prompt file schema ${schemaId}`);
  const schema = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(schema).sort(), ["content", "encoding", "schema"],
    `${path}: expected only schema, encoding, and content`);
  assert.equal(schema.schema, 1, `${path}: unsupported schema version`);
  assert.equal(typeof schema.content, "string", `${path}: content must be a string`);
  assert.match(schema.encoding as string, /^(?:utf8|gzip-base64)$/, `${path}: unsupported content encoding`);
  return schema.encoding === "utf8"
    ? schema.content as string
    : gunzipSync(Buffer.from(schema.content as string, "base64")).toString("utf8");
}

function syntheticPromptValue(input: PromptInput, temporary: string, item = 0): string {
  const pinned = pinnedPromptValue(input);
  if (pinned !== undefined && input.format === "sha40") return pinned;
  const format = input.format;
  if (format.startsWith("literal:")) return format.slice("literal:".length);
  if (format === "sha40") return String(item + 1).repeat(40);
  if (format === "uuid") return `${item + 1}1111111-1111-4111-8111-111111111111`;
  if (format === "decimal-positive") return String(item + 1);
  if (format.startsWith("enum:")) return format.slice("enum:".length).split("|")[0]!;
  if (format === "iso-utc") return `2000-01-0${item + 1}T00:00:00Z`;
  if (format.startsWith("list:")) {
    const nested = { ...input, format: format.slice("list:".length) };
    return [syntheticPromptValue(nested, temporary, 0), syntheticPromptValue(nested, temporary, 1)].join("\n");
  }
  const root = join(temporary, "prompt-inputs");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const suffix = item === 0 ? "" : `-${item + 1}`;
  const path = join(root, `${input.name.toLowerCase()}${suffix}`);
  if (format === "abs-dir") {
    mkdirSync(path, { mode: 0o700 });
    chmodSync(path, 0o700);
    return path;
  }
  if (format.startsWith("abs-file:")) {
    writeFileSync(path, promptSchemaContent(format.slice("abs-file:".length)), { mode: 0o600 });
    chmodSync(path, 0o600);
    return path;
  }
  assert.fail(`unmaterialized prompt format ${format}`);
}

function syntheticPromptEnvironment(temporary: string, inputs: PromptInput[]): NodeJS.ProcessEnv {
  const env = Object.fromEntries(inputs.map((input) => [input.name, syntheticPromptValue(input, temporary)]));
  // Receipt shape: docs/evidence/2026-09-29-release-eb2a87ac4b5a/gate-evidence.txt:1,3-4.
  // Keep those gate lines, but bind the receipt to this run's named release SHA.
  for (const input of inputs.filter((item) => item.format === "abs-file:gate-receipt")) {
    const path = env[input.name]!;
    writeFileSync(path, readFileSync(path, "utf8").replace(/^SHA=[0-9a-f]{40}$/m, `SHA=${env.RELEASE_SHA ?? RELEASE_SHA}`));
  }
  return env;
}

const MEASURED_FACTS = JSON.parse(readFileSync(MEASURED_FACTS_FILE, "utf8")) as MeasuredFactInventory;

function measuredFact(id: string): MeasuredFact {
  const fact = MEASURED_FACTS.facts.find((candidate) => candidate.id === id);
  assert.ok(fact, `measured box facts are missing ${id}`);
  return fact;
}

function citedFact(id: string): MeasuredFact {
  if (/^M/.test(id)) return measuredFact(id);
  const fact = MEASURED_FACTS.k4?.items.find((candidate) => candidate.id === id);
  assert.ok(fact, `measured box facts are missing ${id}`);
  return fact;
}

const K4_10_COMPOSE_OVERRIDE_EVIDENCE = "docs/evidence/2026-09-29-box-facts/k4-10-compose.override.yaml";
const K4_10_COMPOSE_OVERRIDE_PATH = "/home/commonswarm/edge/releases/72c57e0d76d0aa86fe4f811a2cf51499919fed20/deploy/edge-runtime/compose.override.yaml";
const K4_10_COMPOSE_OVERRIDE_SHA256 = "492676590faf4a269fc7b72331b31e0ab70a4fd92f96fbdd5ef1480de931df0c";
const K4_11_OAUTH_IMAGE_PATH = "/home/commonswarm/stack/release-proofs/826db6a34f235064a3a03c57377d8e32a35d2f05/oauth-image.id";
const K4_11_OAUTH_IMAGE_BYTES = "sha256:5511a358e0a7d7d52749d2b7b562d8343cf0daf79e2d389041cb9ca359a6dd5a";
const K4_11_OAUTH_IMAGE_SHA256 = "4d506fe4168980c14704b9f5b6e123663dbd1a32de1197da8084b1850c5e0383";
const K4_12_STACK_PROOF_PARENT = "/home/commonswarm/stack/release-proofs";
const K4_12_EDGE_PROOF_PARENT = "/home/commonswarm/edge/release-proofs";
const K4_12_DIRECTORY_NAMES = [
  "1200ebb19f56b3e154499ebb09963788d10e69ad",
  "30ba33f9202138b3ec59b968b6282cf76d3dc7f3",
  "38343e74cbd51ec1375317fb4770d2522ca09d0b",
  "4ef0f3005a3981941512698a3e1e3e7641773f5b",
  "72c57e0d76d0aa86fe4f811a2cf51499919fed20",
  "72c57e0d76d0aa86fe4f811a2cf51499919fed20-attempt1-abort-20260928T035302Z",
  "72c57e0d76d0aa86fe4f811a2cf51499919fed20-attempt2-abort-20260928T041514Z",
  "72c57e0d76d0aa86fe4f811a2cf51499919fed20-diagnostic-108d6b89",
  "72c57e0d76d0aa86fe4f811a2cf51499919fed20-diagnostic-rerun3-20260928T062737Z",
  "72c57e0d76d0aa86fe4f811a2cf51499919fed20-diagnostic-rerun3-20260928T062815Z",
  "826db6a34f235064a3a03c57377d8e32a35d2f05",
  "9627cb37e697046d22ab02dd2b57bc56937afc14",
  "9b085c82352390cf8f0fe515c02b3ccff423476a",
  "9fa4217da9f6447e55fb8c6d577b8fd3997f926b",
  "a54afaf696ff16b594fd91ae9a9c93c68398475a",
  "ad964ed158181ba1692dd05895f36fa7a1f87d3f",
  "d4677b0d1c86a6c7247d030a54a1122d6bfd5777",
  "e7bb7a46b24e7bc794234416d43605bca52b55d4",
  "eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922.closed-window-001030",
  "eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922.closed-window-021020",
].sort();

function measuredMatch(id: string, pattern: RegExp, field: "command" | "output" | "note" = "output"): string {
  const match = pattern.exec(measuredFact(id)[field]);
  assert.ok(match?.[1], `${id}.${field} does not match ${pattern}`);
  return match[1];
}

const RELEASE_SHA = measuredMatch("M5", /release-proofs\/([0-9a-f]{40}) MISSING/);
const DENO_PATH = measuredMatch("M1", /stat[^\n]* (\/usr\/local\/bin\/deno)/, "command");
const DENO_ZIP_SHA256 = measuredMatch("M19", /stated_sha256=([0-9a-f]{64})/);
const PREVIOUS_EDGE = measuredMatch("M5", /'\/home\/commonswarm\/edge\/current' -> '([^']+)'/);
const PREVIOUS_STACK = measuredMatch("M5", /'\/home\/commonswarm\/stack\/current' -> '([^']+)'/);
const CANDIDATE_EDGE = measuredMatch("M5", new RegExp(`'(/home/commonswarm/edge/releases/${RELEASE_SHA})' type=`));
const CANDIDATE_STACK = measuredMatch("M5", new RegExp(`'(/home/commonswarm/stack/releases/${RELEASE_SHA})' type=`));
const PROOF_DIR = measuredMatch("M5", new RegExp(`(/home/commonswarm/stack/release-proofs/${RELEASE_SHA}) MISSING`));
const CLOSED_PROOF_PATHS = [...measuredFact("M5").output.matchAll(/^closed_proof=(.+)$/gm)].map((match) => match[1]!);
assert.equal(CLOSED_PROOF_PATHS.length, 2);
const PSQL_IMAGE = measuredMatch("M17", /(public\.ecr\.aws\/supabase\/postgres:[0-9.]+)/, "command");
const POSTGRES_IMAGE_ID = measuredMatch("M17", /image_id=(sha256:[0-9a-f]{64})/);
const SITE_BASE_RELEASE = measuredMatch("M15", /release=([^\n]+)/);
// The version the measured live site release carries in its /download page (M15's marker). A fixture page that
// carries a typed number would be a second copy of it; the release SHA's own package.json is checked against it.
const SITE_VERSION = measuredMatch("M15", /version_([0-9][0-9.]*)_marker=true/);
const SITE_BASE_PREFIX = SITE_BASE_RELEASE.split("-")[1]!;
const baseResult = spawnSync("git", ["rev-parse", `${SITE_BASE_PREFIX}^{commit}`], { encoding: "utf8" });
assert.equal(baseResult.status, 0, baseResult.stderr);
const BASE_SHA = baseResult.stdout.trim();
const OAUTH_RELEASE = measuredProductionMatch(/oauth_current=([^\n]+)/);
const EDGE_MEMORY = Number(measuredMatch("M11", /memory=(\d+)/));
const EDGE_NETWORK = measuredMatch("M11", /network=([^ ]+)/);
const TARGET_ENV_NAME = measuredMatch("M8", /^(TARGET_DATABASE_URL)$/m);
// M8 measures the file's metadata and variable name only, not a URL or PostgreSQL identity.
// These synthetic credentials exercise make-pg-service.mjs's permitted-host formatting contract
// (deploy/supabase-stack/migrate/make-pg-service.mjs:35-46). They are never database observations:
// runbook-16 remains NOT EXECUTED and every database fixture call refuses with exit 69.
const SYNTHETIC_TARGET_ENV_BODY = `${TARGET_ENV_NAME}=postgresql://fixture:fixture@db.commonswarm.internal/postgres\n`;
const ACCOUNT_NAMES = measuredFact("M3").output.split("\n")
  .filter((line) => line.split(":").length >= 7)
  .map((line) => line.split(":", 1)[0]!)
  .filter(Boolean);
assert.equal(ACCOUNT_NAMES.length, 4);
assert.equal(new Set(ACCOUNT_NAMES).size, ACCOUNT_NAMES.length);
const STUB_COMMANDS = [
  "docker", "systemctl", "psql", "caddy", "ssh", "scp", "sudo", "op", "curl", "chown", "tar", "deno", "python3", "sleep", "cswarm",
  "browser-harness", "cp", "readlink", "rsync", "npm", "node",
  // Commands that leave the process tree or reach the operator: they start an application or read the keychain.
  "open", "osascript", "launchctl", "security",
];
// GNU behavior the box has and the Mac lacks. These names exist only on a box script's PATH, never on a Mac block's.
const BOX_USERLAND_COMMANDS = ["date", "stat", "sha256sum", "id", "install", "chown", "mv", "cp", "ps", "pgrep", "diff"];
// The Linux runner uses real GNU userland and real ownership; all box stub consumers share this inventory.
const BOX_STUB_COMMANDS = STUB_COMMANDS.filter((command) => !BOX_USERLAND_COMMANDS.includes(command));
// Host state a Mac block would otherwise read from the real Mac: its process table. These stub the Mac lane only;
// on the box lane the runner's own ps and pgrep are the box's.
const MAC_HOST_STATE_STUBS = ["pgrep", "ps"];

function measuredProductionMatch(pattern: RegExp): string {
  const match = pattern.exec(MEASURED_FACTS.production_recheck.output);
  assert.ok(match?.[1], `production_recheck.output does not match ${pattern}`);
  return match[1];
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

function blocksFromMarkdown(file: string, markdown: string): Block[] {
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

function blocks(file: string): Block[] {
  return blocksFromMarkdown(file, readFileSync(file, "utf8"));
}

interface StubInventory {
  systemctl: Set<string>;
  docker: Set<string>;
  sshOptions: Set<string>;
}

function stubInventory(dispatch = readFileSync(STUB, "utf8")): StubInventory {
  const declared = (kind: "subcommands" | "options", command: string): Set<string> => {
    const match = new RegExp(`^# plan-${kind}: ${command} (.+)$`, "m").exec(dispatch);
    assert.ok(match, `stub is missing its ${command} ${kind} declaration`);
    return new Set(match[1]!.trim().split(/\s+/));
  };
  return {
    systemctl: declared("subcommands", "systemctl"),
    docker: declared("subcommands", "docker"),
    sshOptions: declared("options", "ssh"),
  };
}

function missingStubOperations(planBlocks: Block[], inventory = stubInventory()): string[] {
  const missing = new Set<string>();
  for (const block of planBlocks) {
    for (const match of block.source.matchAll(/\bsystemctl\s+([a-z][a-z-]*)/g)) {
      if (!inventory.systemctl.has(match[1]!)) missing.add(`systemctl ${match[1]}`);
    }
    for (const match of block.source.matchAll(/\bdocker\s+([a-z][a-z-]*)(?:\s+([a-z][a-z-]*))?/g)) {
      const operation = match[1] === "image" && match[2] === "inspect" ? "image-inspect" : match[1]!;
      if (!inventory.docker.has(operation)) missing.add(`docker ${operation.replace("-", " ")}`);
    }
    for (const invocation of block.source.matchAll(/\bssh\s+((?:(?:-o\s+\S+)\s*)*)/g)) {
      for (const option of invocation[1]!.matchAll(/-o\s+(\S+)/g)) {
        if (!inventory.sshOptions.has(option[1]!)) missing.add(`ssh -o ${option[1]}`);
      }
    }
  }
  return [...missing].sort();
}

function assertStubCoverage(planBlocks: Block[], inventory = stubInventory()): void {
  const missing = missingStubOperations(planBlocks, inventory);
  assert.equal(missing.length, 0, `plan operations missing from dry-run stub list:\n${missing.join("\n")}`);
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

interface FixtureFileModel {
  bytes: string;
  owner: string;
  group: string;
}

interface FixtureContainerModel {
  image?: string;
  health?: string;
  memory?: string;
  network?: string;
  labels: Record<string, string>;
  mounts: Array<{ source: string; destination: string }>;
  envNames: string[];
}

interface BoxFixtureModel {
  state: string;
  initialState: {
    candidateReleasesPresent: boolean;
    closedProofDirs: string[];
    rollbackMarkerPresent: boolean;
  };
  sha: string;
  windowId: string;
  proofDir: string;
  closingProofDir: string;
  releases: Record<string, { path: string; sha: string; owner: string; group: string }>;
  symlinks: Record<string, string>;
  files: Record<string, FixtureFileModel>;
  checksumLists: Record<string, Record<string, string>>;
  containers: Record<string, FixtureContainerModel>;
  imageIds: Record<string, string>;
  requiredEnvNames: string[];
  presentEnvNames: string[];
  envValues: Record<string, string>;
  users: string[];
  groups: string[];
}

interface FixturePair {
  source: string;
  category: string;
  left: string;
  right: string;
  relation: "equal" | "member";
}

interface OauthImageEvidence {
  release_sha: string;
  local_image_id: string;
}

interface OauthRuntimeEvidence {
  image: string;
  health: string;
  memory: number;
  networks: Record<string, unknown>;
  mounts: Array<{ Source: string; Destination: string }>;
  extra_hosts: string[];
}

const OAUTH_IMAGE_EVIDENCE = JSON.parse(readFileSync(OAUTH_IMAGE_FILE, "utf8")) as OauthImageEvidence;
const OAUTH_RUNTIME_EVIDENCE = JSON.parse(readFileSync(OAUTH_RUNTIME_FILE, "utf8")) as OauthRuntimeEvidence;

function measuredFields(id: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of measuredFact(id).output.matchAll(/(?:^| )([a-z_]+)=([^\n ]+)/g)) result[match[1]!] = match[2]!;
  return result;
}

function composeEnvironmentNames(revision: string, path: string): string[] {
  const compose = gitShow(revision, path);
  const environment = /\n    environment:\n([\s\S]*?)(?=\n    [a-z_]+:|\nnetworks:)/.exec(compose)?.[1] ?? "";
  return [...environment.matchAll(/^      ([A-Z][A-Z0-9_]+):/gm)].map((match) => match[1]!).sort();
}

function requiredEdgeEnvNames(revision: string): string[] {
  const router = gitShow(revision, "deploy/edge-runtime/main/router.ts");
  const required = /export const REQUIRED_MAIN_ENV = \[([\s\S]*?)\] as const;/.exec(router)?.[1] ?? "";
  const names = [...required.matchAll(/"([A-Z][A-Z0-9_]+)"/g)].map((match) => match[1]!);
  assert.ok(names.length > 0, "exact-SHA router has no REQUIRED_MAIN_ENV names");
  assert.match(router, /environment\("SWARM_DATABASE_URL"\).*environment\("SUPABASE_DB_URL"\)/s);
  return [...names, "SWARM_DATABASE_URL|SUPABASE_DB_URL"].sort();
}

function planContainerLabels(project: string): { project: string; service: string } {
  const source = [...blocks(HM37), ...blocks(RUNBOOK)].map((block) => block.source).join("\n");
  const escaped = project.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`label=com\\.docker\\.compose\\.project=(${escaped})[\\s\\S]{0,160}?label=com\\.docker\\.compose\\.service=([a-z0-9-]+)`).exec(source);
  assert.ok(match, `plan has no Docker label selector for ${project}`);
  return { project: match[1]!, service: match[2]! };
}

function composeServiceName(revision: string, path: string): string {
  const service = /^services:\n  ([a-z0-9-]+):/m.exec(gitShow(revision, path))?.[1];
  assert.ok(service, `${revision}:${path} has no first Compose service`);
  return service;
}

function composeProjectName(revision: string, path: string): string {
  const project = /^name: ([a-z0-9-]+)$/m.exec(gitShow(revision, path))?.[1];
  assert.ok(project, `${revision}:${path} has no Compose project name`);
  return project;
}

function planEdgeSelection(): { project: string; service: string } {
  const source = blocks(HM37).map((block) => block.source).join("\n").replace(/\\\n\s*/g, " ");
  const match = /docker compose -p ([a-z0-9-]+) -f "\$EXPECTED_EDGE[^\n]+ ps -q ([a-z0-9-]+)/.exec(source);
  assert.ok(match, "HM37 plan has no previous-edge Compose selection");
  return { project: match[1]!, service: match[2]! };
}

function composeBindMounts(revision: string, release: string): Array<{ source: string; destination: string }> {
  const compose = gitShow(revision, "deploy/edge-runtime/compose.yaml");
  const volumes = /\n    volumes:\n([\s\S]*?)(?=\n    [a-z_]+:|\nvolumes:)/.exec(compose)?.[1] ?? "";
  return [...volumes.matchAll(/^      - ([^:\n]+):(\/[^:\n]+):ro$/gm)]
    .map((match) => ({ source: resolve(release, "deploy/edge-runtime", match[1]!), destination: match[2]! }));
}

function buildBoxFixtureModel(state: string): BoxFixtureModel {
  assert.ok(["s1", "s2", "s3", "s4", "s5"].includes(state), `unknown box fixture state ${state}`);
  assert.equal(OAUTH_IMAGE_EVIDENCE.release_sha, basename(OAUTH_RELEASE));
  assert.equal(OAUTH_RUNTIME_EVIDENCE.image, OAUTH_IMAGE_EVIDENCE.local_image_id);
  const edge = measuredFields("M11");
  const oauthWorkdir = measuredProductionMatch(/oauth_workdir=([^\n]+)/);
  const oauthHost = OAUTH_RUNTIME_EVIDENCE.extra_hosts[0]?.split(":", 1)[0];
  assert.ok(oauthHost);
  const oauthEnvNames = composeEnvironmentNames(basename(OAUTH_RELEASE), "deploy/mcp-auth/compose.yaml");
  assert.ok(oauthEnvNames.includes("MCP_OAUTH_DATABASE_HOST"));
  const requiredEnvNames = requiredEdgeEnvNames(RELEASE_SHA);
  const envValues = {
    SWARM_ENV: "production",
    SWARM_DATABASE_URL: "postgres://placeholder",
    SWARM_SELF_SERVE: "1",
    SUPABASE_URL: "http://kong:8000",
    SUPABASE_ANON_KEY: "fixture-anon-key",
    SUPABASE_SERVICE_ROLE_KEY: "fixture-service-role-key",
  };
  const presentEnvNames = Object.keys(envValues).sort();
  const oauthComposePath = "deploy/mcp-auth/compose.yaml";
  const postgresComposePath = "deploy/supabase-stack/compose.yaml";
  const oauthLabels = {
    project: composeProjectName(basename(OAUTH_RELEASE), oauthComposePath),
    service: composeServiceName(basename(OAUTH_RELEASE), oauthComposePath),
  };
  const postgresLabels = {
    project: composeProjectName(basename(PREVIOUS_STACK), postgresComposePath),
    service: composeServiceName(basename(PREVIOUS_STACK), postgresComposePath),
  };
  const edgeSelection = planEdgeSelection();
  const edgeService = composeServiceName(basename(PREVIOUS_EDGE), "deploy/edge-runtime/compose.yaml");
  const releases = {
    previousEdge: { path: PREVIOUS_EDGE, sha: basename(PREVIOUS_EDGE), owner: "commonswarm", group: "commonswarm" },
    previousStack: { path: PREVIOUS_STACK, sha: basename(PREVIOUS_STACK), owner: "commonswarm", group: "commonswarm" },
    oauth: { path: OAUTH_RELEASE, sha: OAUTH_IMAGE_EVIDENCE.release_sha, owner: "commonswarm", group: "commonswarm" },
    candidateEdge: { path: CANDIDATE_EDGE, sha: RELEASE_SHA, owner: "commonswarm", group: "commonswarm" },
    candidateStack: { path: CANDIDATE_STACK, sha: RELEASE_SHA, owner: "commonswarm", group: "commonswarm" },
  };
  const files: Record<string, FixtureFileModel> = {};
  for (const release of Object.values(releases)) {
    files[`${release.path}/RELEASE_SHA`] = { bytes: `${release.sha}\n`, owner: release.owner, group: release.group };
  }
  files[K4_11_OAUTH_IMAGE_PATH] = { bytes: K4_11_OAUTH_IMAGE_BYTES, owner: "root", group: "root" };
  files[`${PROOF_DIR}/required-edge-env.json`] = {
    bytes: JSON.stringify({ required: requiredEnvNames, optional: [] }) + "\n", owner: "root", group: "root",
  };
  const virtualReleaseFiles: Record<string, string> = {
    "RELEASE_SHA": `${RELEASE_SHA}\n`,
    "deploy/edge-runtime/compose.yaml": "services: {}\n",
    "deploy/edge-runtime/main/router.ts": "// dry-run router fixture\n",
    "deploy/supabase-stack/compose.yaml": "services: {}\n",
    "supabase/migrations/20260928000004_hm_hosted_check.sql": "-- fixture\n",
  };
  const checksumLists: Record<string, Record<string, string>> = {};
  for (const kind of ["edge", "stack"]) {
    const release = kind === "edge" ? releases.candidateEdge : releases.candidateStack;
    for (const [path, bytes] of Object.entries(virtualReleaseFiles)) {
      files[`${release.path}/${path}`] = { bytes, owner: release.owner, group: release.group };
    }
    checksumLists[kind] = Object.fromEntries(Object.entries(virtualReleaseFiles).map(([path, bytes]) => [
      path, createHash("sha256").update(bytes).digest("hex"),
    ]));
  }
  const accounts = measuredFact("M3").output.split("\n").filter(Boolean);
  const users = accounts.filter((line) => line.split(":").length >= 7).map((line) => line.split(":", 1)[0]!);
  const groups = accounts.filter((line) => line.split(":").length === 4).map((line) => line.split(":", 1)[0]!);
  const edgeMeasuredMounts = (edge.mounts ?? "").split(";").filter(Boolean).map((entry) => {
    const separator = entry.indexOf(":/");
    assert.ok(separator > 0, `invalid M11 mount ${entry}`);
    return { source: entry.slice(0, separator), destination: entry.slice(separator + 1) };
  });
  const edgeComposeMounts = composeBindMounts(basename(PREVIOUS_EDGE), PREVIOUS_EDGE);
  for (const expected of edgeComposeMounts) {
    assert.ok(edgeMeasuredMounts.some((actual) => actual.source === expected.source && actual.destination === expected.destination),
      `M11 mount inventory omits ${expected.source}:${expected.destination}`);
  }
  return {
    state,
    initialState: {
      candidateReleasesPresent: state !== "s1",
      closedProofDirs: state === "s2" || state === "s5" ? [...CLOSED_PROOF_PATHS] : [],
      rollbackMarkerPresent: state === "s4",
    },
    sha: RELEASE_SHA, windowId: WINDOW_ID, proofDir: PROOF_DIR,
    closingProofDir: `${PROOF_DIR}.closed-window-${WINDOW_ID}`,
    releases,
    symlinks: {
      "/home/commonswarm/edge/current": PREVIOUS_EDGE,
      "/home/commonswarm/stack/current": PREVIOUS_STACK,
      "/home/commonswarm/oauth/current": OAUTH_RELEASE,
    },
    files, checksumLists,
    containers: {
      oauth: {
        image: OAUTH_RUNTIME_EVIDENCE.image,
        health: OAUTH_RUNTIME_EVIDENCE.health,
        memory: String(OAUTH_RUNTIME_EVIDENCE.memory),
        network: Object.keys(OAUTH_RUNTIME_EVIDENCE.networks)[0],
        labels: {
          "com.docker.compose.project": oauthLabels.project,
          "com.docker.compose.service": oauthLabels.service,
          "com.docker.compose.project.working_dir": oauthWorkdir,
        },
        mounts: OAUTH_RUNTIME_EVIDENCE.mounts.map((mount) => ({ source: mount.Source, destination: mount.Destination })),
        envNames: oauthEnvNames,
      },
      postgres: {
        image: POSTGRES_IMAGE_ID,
        labels: { "com.docker.compose.project": postgresLabels.project, "com.docker.compose.service": postgresLabels.service },
        mounts: [], envNames: [],
      },
      edge: {
        health: edge.health,
        memory: edge.memory,
        network: edge.network,
        labels: {
          "com.docker.compose.project": edgeSelection.project,
          "com.docker.compose.service": edgeService,
          "com.docker.compose.project.working_dir": edge.workdir,
        },
        mounts: edgeMeasuredMounts,
        envNames: presentEnvNames,
      },
      candidateEdge: {
        health: edge.health,
        memory: edge.memory,
        network: edge.network,
        labels: {
          "com.docker.compose.project": edgeSelection.project,
          "com.docker.compose.service": edgeService,
          "com.docker.compose.project.working_dir": `${CANDIDATE_EDGE}/deploy/edge-runtime`,
        },
        mounts: edgeMeasuredMounts.map((mount) => ({
          source: mount.source.startsWith(PREVIOUS_EDGE) ? CANDIDATE_EDGE + mount.source.slice(PREVIOUS_EDGE.length) : mount.source,
          destination: mount.destination,
        })),
        envNames: presentEnvNames,
      },
    },
    imageIds: { [PSQL_IMAGE]: POSTGRES_IMAGE_ID },
    requiredEnvNames, presentEnvNames, envValues, users, groups,
  };
}

function fixtureComparisonSources(): Map<string, string[]> {
  const source = [...blocks(HM37), ...blocks(HM37B), ...blocks(RUNBOOK), ...blocks(SITE)]
    .filter((block) => block.host.startsWith("box "))
    .map((block) => `${block.step}\n${block.source.replace(/\\\n\s*/g, " ")}`)
    .join("\n");
  const families = new Map<string, RegExp>([
    ["release-sha", /test "\$\(cat "?\$[^\n]*RELEASE_SHA"?\)" =/g],
    ["current-symlink", /test "\$\(readlink -f \/home\/commonswarm\/(?:edge|stack|oauth)\/current\)" =/g],
    ["container-image", /test "\$\(docker inspect --format '\{\{\.Image\}\}'/g],
    ["working-dir", /test "\$\(docker inspect --format '\{\{ index \.Config\.Labels "com\.docker\.compose\.project\.working_dir" \}\}'/g],
    ["container-health", /(?:test|while \[) "\$\(docker inspect --format '[^']*Health[^']*'/g],
    ["mount-membership", /docker inspect --format '\{\{ range \.Mounts \}\}[^\n]*\| grep -qF/g],
    ["container-selection", /docker ps -q\s+--filter label=com\.docker\.compose\.project=/g],
    ["container-env-membership", /\.Config\.Env[^\n]*MCP_OAUTH_DATABASE_HOST/g],
    ["memory", /test "\$\(docker inspect --format '\{\{\.HostConfig\.Memory\}\}'/g],
    ["network", /test "\$\(docker inspect --format '\{\{\.HostConfig\.NetworkMode\}\}'/g],
    ["helper-image", /docker image inspect --format '\{\{\.Id\}\}'/g],
    ["checksum", /sha256sum --quiet --strict --check/g],
    ["environment", /required = set\(inventory\['required'\]\)[\s\S]*?missing = sorted\(name for name in required if not values\.get\(name\)\)/g],
    ["ownership", /(?:stat -c '%U:%G'|pwd\.getpwuid\(env_stat\.st_uid\)\.pw_name in)/g],
    ["proof-name", /CLOSED_PROOF_DIR="\$\{PROOF_DIR\}\.closed-window-\$\{WINDOW_ID\}"/g],
  ]);
  const discovered = new Map<string, string[]>();
  for (const [family, pattern] of families) {
    const matches = [...source.matchAll(pattern)].map((match) => match[0]);
    assert.ok(matches.length > 0, `plan comparison discovery found no ${family} source`);
    discovered.set(family, matches);
  }
  return discovered;
}

function boxFixturePairs(model: BoxFixtureModel): FixturePair[] {
  const sources = fixtureComparisonSources();
  const source = (family: string): string => `${family}:${sources.get(family)?.[0]}`;
  const pairs: FixturePair[] = [];
  const equal = (category: string, left: string, right: string): void => {
    pairs.push({ source: source(category), category, left, right, relation: "equal" });
  };
  const member = (category: string, left: string, right: string): void => {
    pairs.push({ source: source(category), category, left, right, relation: "member" });
  };
  for (const release of Object.values(model.releases)) {
    equal("release-sha", model.files[`${release.path}/RELEASE_SHA`]?.bytes.trim() ?? "<missing>", release.sha);
  }
  for (const [link, target] of Object.entries(model.symlinks)) {
    const release = Object.values(model.releases).find((candidate) => candidate.path === target);
    equal("current-symlink", target, release?.path ?? `<no release for ${link}>`);
  }
  equal("container-image", model.containers.oauth.image ?? "<missing>",
    model.files[K4_11_OAUTH_IMAGE_PATH]?.bytes ?? "<missing>");
  equal("helper-image", model.containers.postgres.image ?? "<missing>", model.imageIds[PSQL_IMAGE] ?? "<missing>");
  equal("working-dir", model.containers.oauth.labels["com.docker.compose.project.working_dir"] ?? "<missing>",
    `${model.releases.oauth.path}/deploy/mcp-auth`);
  equal("working-dir", model.containers.edge.labels["com.docker.compose.project.working_dir"] ?? "<missing>",
    `${model.releases.previousEdge.path}/deploy/edge-runtime`);
  equal("working-dir", model.containers.candidateEdge.labels["com.docker.compose.project.working_dir"] ?? "<missing>",
    `${model.releases.candidateEdge.path}/deploy/edge-runtime`);
  equal("container-health", model.containers.oauth.health ?? "<missing>", "healthy");
  equal("container-health", model.containers.edge.health ?? "<missing>", "healthy");
  equal("container-health", model.containers.candidateEdge.health ?? "<missing>", "healthy");
  const selectedLabels = {
    oauth: planContainerLabels("commonswarm-oauth"),
    postgres: planContainerLabels("commonswarm-supabase-stack"),
    edge: planEdgeSelection(),
  };
  for (const name of ["oauth", "postgres", "edge"] as const) {
    equal("container-selection", model.containers[name].labels["com.docker.compose.project"] ?? "<missing>", selectedLabels[name].project);
    equal("container-selection", model.containers[name].labels["com.docker.compose.service"] ?? "<missing>", selectedLabels[name].service);
  }
  const expectedEdgeMounts = composeBindMounts(basename(PREVIOUS_EDGE), PREVIOUS_EDGE);
  for (const expected of expectedEdgeMounts) {
    const actual = model.containers.edge.mounts.find((mount) => mount.destination === expected.destination);
    equal("mount-membership", actual ? `${actual.source}:${actual.destination}` : "<missing>",
      `${expected.source}:${expected.destination}`);
  }
  const oauthCompose = gitShow(basename(OAUTH_RELEASE), "deploy/mcp-auth/compose.yaml");
  for (const mount of model.containers.oauth.mounts) {
    const description = `${mount.source}:${mount.destination}`;
    equal("mount-membership", description,
      oauthCompose.includes(`source: ${mount.source}`) && oauthCompose.includes(`target: ${mount.destination}`) ? description : "<missing>");
  }
  const oauthComposeEnvNames = composeEnvironmentNames(basename(OAUTH_RELEASE), "deploy/mcp-auth/compose.yaml");
  for (const name of model.containers.oauth.envNames) member("container-env-membership", name, oauthComposeEnvNames.join("\n"));
  equal("memory", model.containers.candidateEdge.memory ?? "<missing>", String(EDGE_MEMORY));
  equal("network", model.containers.candidateEdge.network ?? "<missing>", EDGE_NETWORK);
  for (const [kind, manifest] of Object.entries(model.checksumLists)) {
    for (const [path, digest] of Object.entries(manifest)) {
      const release = kind === "edge" ? model.releases.candidateEdge : model.releases.candidateStack;
      equal("checksum", digest, createHash("sha256").update(model.files[`${release.path}/${path}`]?.bytes ?? "<missing>").digest("hex"));
    }
  }
  for (const required of model.requiredEnvNames) {
    const candidates = required.split("|");
    member("environment", required, candidates.some((name) => model.presentEnvNames.includes(name)) ? required : model.presentEnvNames.join(","));
  }
  for (const release of Object.values(model.releases)) {
    member("ownership", release.owner, model.users.join("\n"));
    member("ownership", release.group, model.groups.join("\n"));
  }
  equal("proof-name", basename(model.proofDir), model.sha);
  equal("proof-name", basename(model.closingProofDir), `${model.sha}.closed-window-${model.windowId}`);
  return pairs;
}

function fixturePairMismatches(model: BoxFixtureModel): string[] {
  return boxFixturePairs(model).flatMap((pair) => {
    const passes = pair.relation === "equal" ? pair.left === pair.right : pair.right.split("\n").includes(pair.left);
    return passes ? [] : [`${pair.category}: ${pair.left} ${pair.relation} ${pair.right} [${pair.source}]`];
  });
}

function assertBoxFixtureConsistency(model: BoxFixtureModel): void {
  const mismatches = fixturePairMismatches(model);
  assert.equal(mismatches.length, 0,
    `${model.state} fixture mismatches (${mismatches.length}):\n${mismatches.join("\n")}`);
}

function stepSource(markdown: string, step: string): string {
  const escaped = step.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^# step: ${escaped}\\n[\\s\\S]*?(?=^\\x60\\x60\\x60$)`, "m").exec(markdown);
  assert.ok(match, `missing step ${step}`);
  return match[0];
}

function assertRunbook03NamedShaWindowPath(markdown: string): void {
  const source = stepSource(markdown, "runbook-03");
  assert.match(source, /: "\$\{RELEASE_SHA:\?named release SHA required\}"/);
  assert.match(source, /\. "\/home\/commonswarm\/stack\/release-proofs\/\$\{RELEASE_SHA\}\/window\.env"/);
  assert.doesNotMatch(source, /\/release-proofs\/<sha>\/window\.env/);
  // Any placeholder in an executable line is an input the block cannot resolve: the window.env path, the
  // `test "$SHA" = '<sha>'` comparison (deploy/RELEASE-TO-BOX.md:283), or anything a later edit adds.
  assert.doesNotMatch(source, /<sha>/, "runbook-03 still carries a literal <sha> placeholder");
}

function removeOwnedTemporary(path: string, prefix: string): void {
  const resolved = resolve(path);
  assert.equal(realpathSync(dirname(resolved)), realpathSync(tmpdir()));
  assert.ok(basename(resolved).startsWith(prefix));
  rmSync(resolved, { recursive: true, force: true });
}

function shortStep(block: Block): string {
  return block.step.split(" — ")[0] ?? block.step;
}

function textOrder(file: string, lead: string): string[] {
  const markdown = readFileSync(file, "utf8");
  const start = markdown.indexOf(lead);
  assert.ok(start >= 0, `${file}: missing ordering text ${lead}`);
  const match = /^```text\n([\s\S]*?)^```/m.exec(markdown.slice(start));
  assert.ok(match, `${file}: missing text order after ${lead}`);
  return match[1]!.trim().split(/\s+/);
}

function planStepOrder(): string[] {
  return textOrder(HM37, "The successful path uses this exact whole-block order");
}

function blockIndex(): Map<string, Block> {
  const result = new Map<string, Block>();
  for (const block of [PREP, HM37, HM37B, RUNBOOK, SITE].flatMap(blocks)) {
    const step = shortStep(block);
    assert.equal(result.has(step), false, `duplicate whole-block step ${step}`);
    result.set(step, block);
  }
  return result;
}

function resolveSteps(label: string, steps: string[]): Block[] {
  const byStep = blockIndex();
  return steps.map((step) => {
    const block = byStep.get(step);
    assert.ok(block, `${label}: named step does not exist: ${step}`);
    return block;
  });
}

function beforeStep(label: string, sequence: string[], step: string): string[] {
  const index = sequence.indexOf(step);
  assert.ok(index >= 0, `${label}: cutoff step does not exist: ${step}`);
  return sequence.slice(0, index);
}

function prepSuccessOrder(): string[] {
  const markdown = readFileSync(PREP, "utf8");
  assert.match(markdown, /Run the blocks in order\. Run `hm37-prep-final-yes` only after the baseline\s+passes\./);
  const order = blocks(PREP).map(shortStep).filter((step) => step !== "hm37-prep-final-no-cleanup");
  assert.deepEqual(order.slice(-2), ["hm37-prep-baseline-s3-s4", "hm37-prep-final-yes"]);
  return order;
}

function windowAPaths(): Map<string, string[]> {
  const success = selectedHmSequence();
  const rollback = planTail("rollback");
  const cleanup = planTail("cleanup");
  const dispatch = "hm37a-failure-dispatch";
  resolveSteps("window-a tails", [...rollback, ...cleanup, dispatch]);
  return new Map([
    ["pass", success],
    ["pre-commit failure", [...beforeStep("window-a pre-commit", success, "runbook-32"), ...rollback]],
    ["post-commit control failure", [...beforeStep("window-a post-commit", success, "hm37a-post-control-readback"), dispatch, ...cleanup]],
    ["S-class rollback", [...beforeStep("window-a S-class", success, "hm37a-post-control-readback"), dispatch, ...rollback]],
    ["abort", [...beforeStep("window-a abort", success, "hm37a-prep-seat-control-stage"), ...cleanup]],
  ]);
}

function windowBPaths(): Map<string, string[]> {
  const success = textOrder(HM37B, "The successful order is:");
  const markdown = readFileSync(HM37B, "utf8");
  const tailText = /On interruption after a journal exists, run\n([\s\S]*?)\. No B step/.exec(markdown)?.[1] ?? "";
  const named = [...tailText.matchAll(/`([^`]+)`/g)].map((match) => match[1]!);
  assert.deepEqual(named, ["hm37-hosted-control-cleanup-only", "hm37b-failure-dispatch", "hm37-deno-remove"]);
  const control = success.indexOf("hm37-hosted-open-ack-control");
  const remove = success.indexOf("hm37-deno-remove");
  assert.ok(control >= 0 && remove > control);
  // Identify the applicable readback from the successful order. The interruption text places it
  // after runtime removal; preserve that abort order before closing and copying its products back.
  const readback = success.slice(control + 1, remove);
  const close = success.slice(remove);
  assert.ok(close.length > 0, "window-b close tail is absent from the successful order");
  return new Map([
    ["pass", success],
    ["abort", [
      ...success.slice(0, control + 1),
      ...named,
      ...readback,
      ...close.slice(1),
    ]],
  ]);
}

function siteOrder(): string[] {
  const markdown = readFileSync(SITE, "utf8");
  assert.match(markdown, /`site-04-reconcile-failure` records state and forbids replay/);
  return blocks(SITE).map(shortStep).filter((step) => step !== "site-04-reconcile-failure");
}

function planTail(kind: "rollback" | "cleanup"): string[] {
  const markdown = readFileSync(HM37, "utf8");
  const expression = kind === "rollback"
    ? /The pre-COMMIT-POINT and mapped S1\/S2\/S3\/S4\/S5 rollback tail is\n([\s\S]*?), in that order\./
    : /A post-COMMIT-POINT\s+`control` failure instead uses ([\s\S]*?)\.\n\nThe open block/;
  const match = expression.exec(markdown);
  assert.ok(match, `HM37 plan is missing the ${kind} tail`);
  return [...match[1]!.matchAll(/`([^`]+)`/g)].map((item) => item[1]!);
}

function planInput(name: string): string {
  const markdown = readFileSync(HM37, "utf8");
  const inputTable = markdown.slice(markdown.indexOf("### Runbook inputs"));
  const row = inputTable.split("\n").find((line) => line.startsWith(`| \`${name}\` |`));
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
  source = source.replaceAll("<sha>", RELEASE_SHA);
  if (shortStep(block) === "hm37-deno-install") {
    source = source.replace(
      `DENO_ZIP_SHA256=${DENO_ZIP_SHA256}`,
      `DENO_ZIP_SHA256=\${BOX_DRY_RUN_DENO_ZIP_SHA256:-${DENO_ZIP_SHA256}}`,
    );
  }
  return source;
}

interface UnproducedRead {
  plan: "prep" | "hm37" | "hm37b" | "runbook" | "site";
  what: string;
  block: Block;
  offset: number;
}

const REQUIRED_INPUT = /\$\{([A-Z][A-Z0-9_]+):\?[^}]*\}/g;
const UNRESOLVED_INPUT = /<(?:(?:approved|agreed|next-approved|sha256-from|space-separated|newline-separated|edge\|stack|yes-or-no)[^>]*|sha)>/g;
const PLAN_FILE_INPUT = /(?:\/home\/commonswarm\/migration-direct\.env|(?:\$[A-Z_]+\/)?GO\.txt|(?:\$[A-Z_]+\/)?(?:human-session\.json|hm37-open-ack-control\.ts|hm37-open-ack-deno\.json|oauth-image\.id)|(?:\$[A-Z_]+\/)?gate-evidence\.txt|(?:\$[A-Z_]+\/)?site\/\.env|(?:\$[A-Z_]+\/)?compose\.override\.yaml)/g;
const PLAN_ENV_ALLOWLIST = new Set(["HOME", "PATH", "LANG", "TZ"]);

function planName(block: Block): UnproducedRead["plan"] {
  if (block.file === PREP) return "prep";
  if (block.file === HM37) return "hm37";
  if (block.file === HM37B) return "hm37b";
  if (block.file === RUNBOOK) return "runbook";
  return "site";
}

function sourceLineAt(block: Block, offset: number): number {
  return block.line + block.source.slice(0, offset).split("\n").length;
}

function matchingProducer(resource: string, earlier: Block[]): boolean {
  if (resource === "exact-SHA clean release checkout") {
    return earlier.some((block) => /git (?:clone|worktree add)/.test(block.source));
  }
  const leaf = resource.replace(/^.*\//, "").replace(/^\$[A-Z_]+/, "");
  if (!leaf) return false;
  return earlier.some((block) => block.source.split("\n").some((line) =>
    line.includes(leaf) && /(?:>|install|mkdir|cp|scp|write|printf|touch)/.test(line),
  ));
}

function pathExpressionAt(source: string, offset: number, leaf: string): string {
  const prefix = source.slice(0, offset);
  const base = /(?:\/|\$\{?[A-Z][A-Z0-9_]*\}?\/)[A-Za-z0-9_./${}-]*$/.exec(prefix)?.[0];
  return base ? `${base}${leaf}` : leaf;
}

function resolvedPathVariables(blocks: Block[]): Map<string, string> {
  const assignments = new Map<string, string>();
  for (const block of blocks) {
    for (const match of block.source.matchAll(/^\s*([A-Z][A-Z0-9_]*)=(?:"([^"\n]*)"|'([^'\n]*)'|([^\s#]+))\s*(?:#.*)?$/gm)) {
      assignments.set(match[1]!, match[2] ?? match[3] ?? match[4]!);
    }
  }
  if (blocks.some((block) => /(?:^|\n)\s*PREVIOUS_EDGE="\$\(readlink -f \/home\/commonswarm\/edge\/current\)"/m.test(block.source))) {
    assignments.set("PREVIOUS_EDGE", PREVIOUS_EDGE);
  }

  const resolved = new Map<string, string>();
  const resolveValue = (name: string, resolving = new Set<string>()): string | undefined => {
    if (resolved.has(name)) return resolved.get(name);
    if (resolving.has(name)) return undefined;
    const value = assignments.get(name);
    if (value === undefined || /\$\(/.test(value)) return undefined;
    resolving.add(name);
    const expanded = value.replace(/\$\{([A-Z][A-Z0-9_]*)\}|\$([A-Z][A-Z0-9_]*)/g, (whole, braced, plain) => {
      const replacement = resolveValue(braced ?? plain, resolving);
      return replacement === undefined ? whole : replacement;
    });
    resolving.delete(name);
    if (/\$\{?[A-Z][A-Z0-9_]*\}?/.test(expanded)) return undefined;
    resolved.set(name, expanded);
    return expanded;
  };
  for (const name of assignments.keys()) resolveValue(name);
  return resolved;
}

function measuredPathPreseed(read: string, blocks: Block[]): boolean {
  const variables = resolvedPathVariables(blocks);
  const resolvedRead = read.replace(/\$\{([A-Z][A-Z0-9_]*)\}|\$([A-Z][A-Z0-9_]*)/g, (whole, braced, plain) =>
    variables.get(braced ?? plain) ?? whole,
  );
  if (/\$\{?[A-Z][A-Z0-9_]*\}?/.test(resolvedRead)) return false;
  return PRESEED_ALLOWLIST.some((item) => item.kind === "path" && item.name === resolvedRead);
}

function discoverUnproducedReads(planBlocks: Block[]): UnproducedRead[] {
  const reads: UnproducedRead[] = [];
  const seen = new Set<string>();
  const namedPromptInputs = new Set(promptInputsForBlocks(planBlocks).map((item) => item.name));
  const add = (block: Block, what: string, offset: number, earlier: Block[]): void => {
    const sameBlockPrefix: Block = { ...block, source: block.source.slice(0, offset) };
    if (matchingProducer(what, [...earlier, sameBlockPrefix])) return;
    if (measuredPathPreseed(pathExpressionAt(block.source, offset, what), [...earlier, sameBlockPrefix])) return;
    const key = `${block.file}:${shortStep(block)}:${what}`;
    if (seen.has(key)) return;
    seen.add(key);
    reads.push({ plan: planName(block), what, block, offset });
  };
  for (let index = 0; index < planBlocks.length; index += 1) {
    const block = planBlocks[index]!;
    const earlier = planBlocks.slice(0, index);
    for (const match of block.source.matchAll(REQUIRED_INPUT)) {
      const name = match[1]!;
      if (!PLAN_ENV_ALLOWLIST.has(name) && !namedPromptInputs.has(name) && !name.startsWith("BOX_DRY_RUN_")) {
        add(block, name, match.index!, earlier);
      }
    }
    for (const match of block.source.matchAll(UNRESOLVED_INPUT)) add(block, match[0], match.index!, earlier);
    for (const match of block.source.matchAll(PLAN_FILE_INPUT)) {
      if (shortStep(block) === "hm37-source-identity") continue;
      if (/^\$(?:CONTROL_ROOT|INPUT_ROOT)\//.test(match[0])) continue;
      const before = block.source.slice(0, match.index);
      const currentLine = block.source.slice(block.source.lastIndexOf("\n", match.index) + 1, block.source.indexOf("\n", match.index));
      if (/^\s*[a-z][a-z0-9_]*\s*=\s*['"]/.test(currentLine)) continue;
      if (/\btest\s+!\s+-[efLd]\b/.test(currentLine)) continue;
      if (/>/.test(currentLine.slice(0, currentLine.indexOf(match[0])))) continue;
      if (match[0].endsWith("human-session.json") && /open\(output, "wx"/.test(before)) continue;
      add(block, match[0], match.index!, earlier);
    }
    const sqlEvidence = block.source.indexOf("-name '*.sql'");
    if (sqlEvidence >= 0) add(block, "$EVIDENCE_DIR/*.sql", sqlEvidence, earlier);
    for (const [needle, what] of [
      ["git fetch", "exact-SHA clean release checkout"],
      ["git rev-parse HEAD", "exact-SHA clean release checkout"],
      ["readCurrentTarget", "Mac production target and human credential store"],
    ] as const) {
      const offset = block.source.indexOf(needle);
      if (offset >= 0 && what === "exact-SHA clean release checkout" && /\$\{?RELEASE_REPO\}?/.test(block.source)) continue;
      if (offset >= 0 && !matchingProducer(what, earlier)) add(block, what, offset, earlier);
    }
  }
  return reads;
}

interface PlannedRun {
  label: string;
  blocks: Block[];
  // The box state the run starts from (M5, K4-12) and, for lane 8, the browser branch it follows.
  state: string;
  branch?: "FULL-CONTROL" | "REDUCED-CONTROL";
  afterWindowA?: boolean;
}

function currentPlannedRuns(): PlannedRun[] {
  const runs: PlannedRun[] = [{ label: "prep/pass", blocks: resolveSteps("prep/pass", prepSuccessOrder()), state: "s5" }];
  for (const state of ["s1", "s2", "s3", "s4", "s5"]) {
    for (const [path, steps] of windowAPaths()) {
      runs.push({ label: `window-a/${state}/${path}`, blocks: resolveSteps(`window-a/${state}/${path}`, steps), state });
    }
  }
  for (const [path, steps] of windowBPaths()) {
    runs.push({ label: `window-b/${path}`, blocks: resolveSteps(`window-b/${path}`, steps), state: "s5", afterWindowA: true });
  }
  for (const branch of ["FULL-CONTROL", "REDUCED-CONTROL"] as const) {
    runs.push({ label: `lane-8/${branch}`, blocks: resolveSteps(`lane-8/${branch}`, siteOrder()), state: "s5", branch });
  }
  return runs;
}

function unproducedReport(runs: PlannedRun[] = currentPlannedRuns()): string[] {
  return runs.flatMap((run) => discoverUnproducedReads(run.blocks).map((read) =>
    `UNPRODUCED ${read.what} read by ${shortStep(read.block)} at ${read.block.file}:${sourceLineAt(read.block, read.offset)} [run=${run.label} plan=${read.plan}]`,
  ));
}

// ---------------------------------------------------------------------------------------------------------
// Containment (R4). Every Mac-side whole block and its fixture box scripts run under sandbox-exec. Linux box
// fixtures require disposable-runner admission from guard.sh before any block can run. A PATH
// stub cannot stop an absolute path such as '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' or
// a path a script builds at run time; the kernel can. A denied operation fails its block and is reported,
// never hidden. When the profile cannot be applied, the block does not run at all.
// ---------------------------------------------------------------------------------------------------------

function sbplPath(path: string): string {
  assert.ok(isAbsolute(path) && !/["\\\n\r]/.test(path), `unsafe path for a sandbox profile: ${JSON.stringify(path)}`);
  return `"${path}"`;
}

function operatorHomes(): string[] {
  return [...new Set([userInfo().homedir, "/Users/yulanbot"])];
}

function canonicalPath(path: string): string {
  return existsSync(path) ? realpathSync(path) : path;
}

// The PATH a Mac block and its stubs search: the stub directory first, then the host's own PATH without any
// directory under the operator's home. The containment refuses to start a program from the operator's home (a
// personal wrapper such as ~/.local/bin/rm is one), so a PATH that lists such a directory would make a plain `rm`
// in a stub or a plan block fail for a reason that has nothing to do with the code under test.
function macBlockPath(bin: string): string {
  const homes = operatorHomes().flatMap((home) => [home, canonicalPath(home)]);
  const kept = (process.env.PATH ?? "").split(":").filter((entry) => entry !== ""
    && !homes.some((home) => entry === home || entry.startsWith(`${home}/`)));
  return [bin, ...kept].join(":");
}

// The node binary's directory and the repository's node_modules: the tooling a block may still start from
// under the operator's home.
function nodeToolingRoots(): string[] {
  const roots = new Set<string>([dirname(canonicalPath(process.execPath))]);
  const modules = join(REAL_CHECKOUT, "node_modules");
  if (existsSync(modules)) roots.add(realpathSync(modules));
  return [...roots];
}

interface ContainmentScope {
  writableSubpaths: string[];
  writableLiterals: string[];
  // Under the operator's home, only these may start a process.
  executableRoots: string[];
}

// Denies: network; file writes everywhere except the named directories, /dev/null and /dev/fd; process
// execution of /Applications/** and of anything under the operator's home except the named roots and the node
// tooling; reads of the operator's private state (the agent profiles and the cswarm credentials).
function containmentProfile(scope: ContainmentScope): string {
  const homes = operatorHomes().flatMap((home) => [...new Set([home, canonicalPath(home)])]);
  const notWritable = [
    ...scope.writableSubpaths.map((path) => `(require-not (subpath ${sbplPath(canonicalPath(path))}))`),
    ...scope.writableLiterals.map((path) => `(require-not (literal ${sbplPath(path)}))`),
    '(require-not (literal "/dev/null"))',
    '(require-not (subpath "/dev/fd"))',
  ];
  const notExecutable = [...scope.executableRoots, ...nodeToolingRoots()]
    .map((path) => `(require-not (subpath ${sbplPath(canonicalPath(path))}))`);
  const applications = ["/Applications", "/System/Applications", ...homes.map((home) => join(home, "Applications"))]
    .map((path) => `(subpath ${sbplPath(path)})`).join(" ");
  // The operator's private state: Anvil's profile and the other agents' (.hermes), the cswarm credentials, the
  // Keychain, and the Chrome profile directories. A block has no reason to read any of it.
  const privateState = homes.flatMap((home) => [
    join(home, ".hermes"), join(home, ".config/cswarm"), join(home, "Library/Keychains"),
    join(home, "Library/Application Support/Google"), join(home, ".chrome-agent-profile"),
  ]).map((path) => `(subpath ${sbplPath(path)})`).join(" ");
  return [
    "(version 1)",
    "(allow default)",
    "(deny network*)",
    `(deny file-write* (require-all ${notWritable.join(" ")}))`,
    `(deny process-exec ${applications})`,
    ...homes.map((home) => `(deny process-exec (require-all (subpath ${sbplPath(home)}) ${notExecutable.join(" ")}))`),
    `(deny file-read* ${privateState})`,
    "",
  ].join("\n");
}

interface ContainmentAvailability {
  available: boolean;
  detail: string;
}

let cachedContainment: ContainmentAvailability | undefined;

// The positive control for every contained run: the smallest profile is applied to a harmless command. A
// process that is already inside another sandbox cannot apply a second one; then nothing runs uncontained.
function containmentAvailability(): ContainmentAvailability {
  if (!cachedContainment) {
    const probe = spawnSync(SANDBOX_EXEC, ["-p", "(version 1)\n(allow default)\n", "/usr/bin/true"], { encoding: "utf8" });
    const refusal = `sandbox-exec exited ${probe.status}: ${(probe.stderr ?? "").trim()}`;
    cachedContainment = probe.status === 0
      ? { available: true, detail: "" }
      : {
        available: false,
        // Exit 71 with sandbox_apply refused is what macOS answers when the process tree is already sandboxed:
        // it takes one profile per tree. The dry run does not treat an outer profile as its own containment,
        // so the run must start outside any sandbox-exec wrapper.
        detail: probe.status === 71 && /sandbox_apply/.test(probe.stderr ?? "")
          ? `${refusal} (this process tree is already inside another sandbox, and macOS applies one sandbox profile per process tree; run the dry run outside any outer sandbox-exec wrapper)`
          : refusal,
      };
  }
  return cachedContainment;
}

// sandbox-exec exits 65 when the profile does not compile and 71 when a compiled profile cannot be applied to
// this process. A profile that compiles is one whose only problem is where it runs.
function profileCompileProblem(profile: string): string | undefined {
  const result = spawnSync(SANDBOX_EXEC, ["-p", profile, "/usr/bin/true"], { encoding: "utf8" });
  if (result.status === 0 || result.status === 71) return undefined;
  return `sandbox-exec exited ${result.status}: ${(result.stderr ?? "").trim()}`;
}

// ---------------------------------------------------------------------------------------------------------
// R5: the plan's Mac /tmp is the dry run's own temporary directory. The box's /tmp is a different tree; text
// that crosses the ssh boundary is mapped back to it by the ssh stub (box-userland.py `rewrite`).
// ---------------------------------------------------------------------------------------------------------

const MAC_TMP_PATH = /(?<![\w.@~/$-])\/tmp(?=\/|[^\w.-]|$)/g;

function mapMacTmp(source: string, macTmp: string): string {
  return source.replace(MAC_TMP_PATH, () => macTmp);
}

// ---------------------------------------------------------------------------------------------------------
// The fixture box root (R1): the tree every Mac-side ssh, scp and rsync lands in.
// ---------------------------------------------------------------------------------------------------------

const boxModelCache = new Map<string, BoxFixtureModel>();

function cachedBoxModel(state: string): BoxFixtureModel {
  let model = boxModelCache.get(state);
  if (!model) {
    model = buildBoxFixtureModel(state);
    boxModelCache.set(state, model);
  }
  return model;
}

function writeBoxUserlandBin(bin: string): void {
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  for (const command of BOX_USERLAND_COMMANDS) {
    const target = join(bin, command);
    writeFileSync(target, `#!/bin/sh\nexec /usr/bin/python3 "$BOX_DRY_RUN_USERLAND" ${command} "$@"\n`, { mode: 0o755 });
    chmodSync(target, 0o755);
  }
}

function boxOwnersFile(root: string): string {
  return join(root, ".fixture", "owners.json");
}

function readBoxOwners(root: string): Record<string, string> {
  return existsSync(boxOwnersFile(root)) ? JSON.parse(readFileSync(boxOwnersFile(root), "utf8")) as Record<string, string> : {};
}

function recordBoxOwner(root: string, path: string, owner: string): void {
  const owners = readBoxOwners(root);
  owners[path.replace(/^\//, "")] = owner;
  mkdirSync(dirname(boxOwnersFile(root)), { recursive: true });
  writeFileSync(boxOwnersFile(root), JSON.stringify(owners));
}

const databaseToolArchives = new Map<string, Buffer>();

// B's runbook-17 loads make-pg-service.mjs and its database helpers from A's completed stack release.
// Populate that tool subtree from the exact release source, rather than the current checkout or a stub.
function populateExistingDatabaseTools(target: string, sha: string): void {
  assert.match(sha, /^[0-9a-f]{40}$/);
  let archive = databaseToolArchives.get(sha);
  if (!archive) {
    const result = spawnSync("git", ["archive", "--format=tar", sha, "deploy/supabase-stack/migrate"], { maxBuffer: 16 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr.toString());
    archive = result.stdout;
    databaseToolArchives.set(sha, archive);
  }
  const extracted = spawnSync("/usr/bin/tar", ["-xf", "-", "-C", target], { input: archive, encoding: "utf8" });
  assert.equal(extracted.status, 0, extracted.stderr);
}

// The measured-now state of the box, written under `root`. Every path is one the pre-seed allowlist names
// (PLAN_VISIBLE_PATH_PRESEEDS); the returned list is checked against it. The states s1..s5 differ only where
// the box measurements differ (M5, K4-12).
function windowAFinalEdge(): string {
  // A PASSED close asserts this final state before writing edge_live=true:
  // docs/evidence/2026-09-28-box-hm37/BOX-WINDOW.md:2223-2225,2246-2255.
  // B checks the same state at docs/evidence/2026-09-29-box-hm37b/BOX-WINDOW.md:180-181.
  const close = planBlock(HM37, "hm37a-close-readback");
  const sha = /^\s*SHA=([0-9a-f]{40})$/m.exec(close.source)?.[1];
  const target = /test "\$\(readlink -f \/home\/commonswarm\/edge\/current\)" =\s*\\?\s*"([^"\n]+)"/.exec(close.source)?.[1];
  assert.ok(sha && target, "window A close has no declared final edge state");
  assert.equal(sha, RELEASE_SHA, "window A final state names a different release");
  const edge = target.replaceAll("$SHA", sha);
  assert.ok(isAbsolute(edge) && !edge.includes("$"), "window A final edge is unresolved");
  assert.equal(edge, CANDIDATE_EDGE, "window A final edge is absent from the measured release inventory");
  return edge;
}

function seedMacBoxRoot(root: string, state: string, edgeTarget?: string): string[] {
  const model = cachedBoxModel(state);
  const owners: Record<string, string> = {};
  const commonswarm = "commonswarm:commonswarm";
  const rootOwned = "root:root";
  const at = (path: string): string => join(root, path);
  const note = (path: string, owner: string): void => { owners[path.replace(/^\//, "")] = owner; };
  const directory = (path: string, mode: number, owner: string): void => {
    mkdirSync(at(path), { recursive: true });
    chmodSync(at(path), mode);
    note(path, owner);
  };
  const file = (path: string, bytes: string | Buffer, mode: number, owner: string): void => {
    mkdirSync(dirname(at(path)), { recursive: true });
    writeFileSync(at(path), bytes, { mode });
    chmodSync(at(path), mode);
    note(path, owner);
  };
  for (const path of ["/tmp", "/run", "/root", "/etc", "/var", "/usr", "/home", "/srv"]) mkdirSync(at(path), { recursive: true });
  directory("/home/commonswarm", 0o750, commonswarm);
  directory("/srv/commonswarm", 0o750, commonswarm);
  directory("/home/commonswarm/edge", 0o755, commonswarm);
  directory("/home/commonswarm/stack", 0o755, commonswarm);
  const previousEdge = model.releases.previousEdge.path;
  const previousStack = model.releases.previousStack.path;
  for (const release of [previousEdge, previousStack]) {
    directory(release, release === previousEdge ? 0o750 : 0o755, commonswarm);
    file(`${release}/RELEASE_SHA`, model.files[`${release}/RELEASE_SHA`]!.bytes, 0o644, commonswarm);
  }
  const measuredDbHelper = `${previousStack}/deploy/supabase-stack/migrate/run-db-tool.sh`;
  file(measuredDbHelper, "#!/bin/sh\nprintf '%s\\n' 'UNPRODUCED database observation' >&2\nexit 69\n", 0o775, commonswarm);
  symlinkSync(at(edgeTarget ?? previousEdge), at("/home/commonswarm/edge/current"));
  symlinkSync(at(previousStack), at("/home/commonswarm/stack/current"));
  file(K4_10_COMPOSE_OVERRIDE_PATH, readFileSync(K4_10_COMPOSE_OVERRIDE_EVIDENCE), 0o644, commonswarm);

  directory(K4_12_STACK_PROOF_PARENT, 0o755, rootOwned);
  if (state === "s5") {
    for (const name of K4_12_DIRECTORY_NAMES) directory(join(K4_12_STACK_PROOF_PARENT, name), 0o700, rootOwned);
  } else {
    directory(dirname(K4_11_OAUTH_IMAGE_PATH), 0o700, rootOwned);
  }
  file(K4_11_OAUTH_IMAGE_PATH, K4_11_OAUTH_IMAGE_BYTES, 0o644, rootOwned);
  if (state === "s2" || state === "s5") {
    for (const closed of CLOSED_PROOF_PATHS) directory(closed, 0o700, rootOwned);
  }
  if (state === "s5") {
    assert.equal(pathExists(at(PROOF_DIR)), false, "M5 measured-now fixture unexpectedly has an active proof directory");
    assert.equal(CLOSED_PROOF_PATHS.filter((path) => pathExists(at(path))).length, 2);
  }
  file("/home/commonswarm/.env",
    Object.entries(model.envValues).map(([name, value]) => `${name}=${value}`).join("\n") + "\n", 0o600, commonswarm);
  file("/etc/commonswarm-release/target.env", SYNTHETIC_TARGET_ENV_BODY, 0o600, rootOwned);
  file("/etc/ssl/yulan-internal-ca.pem", "dry-run-ca\n", 0o644, rootOwned);
  file("/etc/commonswarm-oauth/database-credentials", "UNMEASURED\n", 0o640, rootOwned);
  file("/etc/commonswarm-oauth/service.env", "MCP_OAUTH_DATABASE_NAME=commonswarm\n", 0o600, rootOwned);
  file("/var/backups/commonswarm-postgres/status.json", JSON.stringify({
    ok: true, database_bytes_verified: true, object_bytes_verified: true,
    verified_at: WINDOW_START, destination: "r2:yulan-vps-1-backups/000-commonswarm-postgres/dry-run",
  }) + "\n", 0o600, rootOwned);
  directory("/usr/local/bin", 0o755, rootOwned);
  const measuredSiteRelease = join("/srv/commonswarm/site/releases", SITE_BASE_RELEASE);
  directory(measuredSiteRelease, 0o755, commonswarm);
  directory(join(measuredSiteRelease, "app"), 0o755, commonswarm);
  directory(join(measuredSiteRelease, "download"), 0o755, commonswarm);
  file(join(measuredSiteRelease, "app/index.html"), "measured baseline without connected-apps marker\n", 0o644, commonswarm);
  file(join(measuredSiteRelease, "download/index.html"), `cswarm ${SITE_VERSION}\n`, 0o644, commonswarm);
  symlinkSync(at(measuredSiteRelease), at("/srv/commonswarm/site/current"));
  if (state !== "s1") {
    for (const release of [CANDIDATE_EDGE, CANDIDATE_STACK]) {
      directory(release, release === CANDIDATE_EDGE ? 0o750 : 0o755, commonswarm);
      if (release === CANDIDATE_STACK) populateExistingDatabaseTools(at(release), RELEASE_SHA);
      file(`${release}/RELEASE_SHA`, model.files[`${release}/RELEASE_SHA`]!.bytes, 0o644, commonswarm);
    }
  }
  mkdirSync(join(root, ".fixture"), { recursive: true });
  writeFileSync(boxOwnersFile(root), JSON.stringify(owners));
  writeFileSync(join(root, ".fixture", "processes"), "");

  const normalize = (path: string): string => {
    if ([K4_10_COMPOSE_OVERRIDE_PATH, K4_11_OAUTH_IMAGE_PATH, K4_12_STACK_PROOF_PARENT].includes(path)) return path;
    if (path === measuredDbHelper) return "/home/commonswarm/stack/current/deploy/supabase-stack/migrate/run-db-tool.sh";
    return path
      .replace(PREVIOUS_EDGE, "/home/commonswarm/edge/releases/<previous>")
      .replace(PREVIOUS_STACK, "/home/commonswarm/stack/releases/<previous>")
      .replace(CANDIDATE_EDGE, "/home/commonswarm/edge/releases/<candidate>")
      .replace(CANDIDATE_STACK, "/home/commonswarm/stack/releases/<candidate>")
      .replace(new RegExp(`${PROOF_DIR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.closed-window-[^/]+`),
        "/home/commonswarm/stack/release-proofs/<closed>")
      .replace(measuredSiteRelease, "/srv/commonswarm/site/releases/<previous>");
  };
  return [
    "/home/commonswarm/edge/current", "/home/commonswarm/stack/current",
    previousEdge, join(previousEdge, "RELEASE_SHA"), previousStack, join(previousStack, "RELEASE_SHA"),
    ...(state === "s1" ? [] : [CANDIDATE_EDGE, join(CANDIDATE_EDGE, "RELEASE_SHA"), CANDIDATE_STACK, join(CANDIDATE_STACK, "RELEASE_SHA")]),
    ...((state === "s2" || state === "s5") ? CLOSED_PROOF_PATHS : []),
    K4_10_COMPOSE_OVERRIDE_PATH, K4_11_OAUTH_IMAGE_PATH, K4_12_STACK_PROOF_PARENT,
    "/etc/commonswarm-oauth/database-credentials", "/etc/commonswarm-oauth/service.env",
    "/etc/ssl/yulan-internal-ca.pem", "/etc/commonswarm-release/target.env", measuredDbHelper,
    "/var/backups/commonswarm-postgres/status.json", "/home/commonswarm/.env", "/usr/local/bin",
    "/srv/commonswarm/site/current", measuredSiteRelease,
    join(measuredSiteRelease, "app/index.html"), join(measuredSiteRelease, "download/index.html"),
  ].map(normalize).filter((path, index, paths) => paths.indexOf(path) === index).sort();
}

// ---------------------------------------------------------------------------------------------------------
// Hosted box producers run in the box lane. The Mac lane supplies their committed evidence or explicitly
// labeled contract shapes only at their place in the plan. Pure local consumers run the complete box text
// through the jailed ssh boundary; they never receive seeded result files (fixtures/box-block-products.json).
// ---------------------------------------------------------------------------------------------------------

const BOX_BLOCK_PRODUCTS_FILE = "tests/box-dry-run/fixtures/box-block-products.json";

interface BoxProduct {
  path: string;
  kind?: "directory";
  evidence?: string;
  plan_documented?: DeclaredOutput["plan_documented"];
  execute?: "local";
  owner: string;
  mode: string;
}

function boxBlockProducts(step: string): BoxProduct[] {
  const table = JSON.parse(readFileSync(BOX_BLOCK_PRODUCTS_FILE, "utf8")) as Record<string, BoxProduct[]>;
  return table[step] ?? [];
}

function seedBoxProducts(fixture: Fixture, step: string): string[] {
  assert.ok(fixture.boxRoot, "box products need a fixture box root");
  const seeded: string[] = [];
  for (const product of boxBlockProducts(step)) {
    if (product.execute === "local") continue;
    if (product.evidence) assert.equal(existsSync(product.evidence), true, `${step}: product evidence is missing: ${product.evidence}`);
    else assert.ok(product.plan_documented, `${step}: product has neither evidence nor a labeled contract shape`);
    const path = product.path.replaceAll("{sha}", RELEASE_SHA);
    const target = join(fixture.boxRoot, path);
    mkdirSync(dirname(target), { recursive: true });
    if (product.kind === "directory") mkdirSync(target, { recursive: true });
    else if (product.evidence) copyFileSync(product.evidence, target);
    else writeFileSync(target, JSON.stringify(product.plan_documented!.json, null, 2) + "\n");
    chmodSync(target, Number.parseInt(product.mode, 8));
    recordBoxOwner(fixture.boxRoot, path, product.owner);
    seeded.push(path);
  }
  return seeded;
}

// ---------------------------------------------------------------------------------------------------------
// Non-substitutable surfaces (R3). The dry run does not emulate a browser or a site build. A block whose
// result depends on one is declared in fixtures/non-substitutable.json and is NOT executed: not a part of it,
// not with a canned answer. The harness seeds only the output files the declaration lists, and only from the
// committed evidence the declaration cites, or an explicitly labeled plan-documented shape for a consumer
// contract check. The latter is not a browser result. Other outputs with no evidence are named and left absent.
// ---------------------------------------------------------------------------------------------------------

interface EvidenceRef {
  evidence: string;
  path: string;
  equals?: unknown;
}

type OutputValue =
  | { evidence: string; path: string }
  | { copy: string; note: string }
  | { derive: string; from: EvidenceRef[]; note: string }
  | { template: string; params: Record<string, EvidenceRef> };

interface DeclaredOutput {
  file: string;
  location: "site-evidence" | "site-window-env" | "box-proof";
  mode: string;
  branch: string;
  json?: Record<string, OutputValue>;
  plan_documented?: { evidence: string; source_lines: string; label: string; json: Record<string, unknown> };
  lines?: Record<string, OutputValue>;
  invariants?: Array<{ equal: [string, string]; source: string }>;
}

interface UnproducedOutput {
  output: string;
  reason: string;
}

interface NonSubstitutableEntry {
  surface: string;
  reason: string;
  step?: string;
  live_proof?: string;
  plan_items?: string[];
  outputs?: DeclaredOutput[];
  unproduced?: UnproducedOutput[];
  shape_evidence?: Array<{ file: string; shape: string }>;
  branches?: Array<{ branch: string; status: "not tested"; reason: string; evidence: string; source_lines: string }>;
}

function nonSubstitutableEntries(): NonSubstitutableEntry[] {
  return JSON.parse(readFileSync(NON_SUBSTITUTABLE_FILE, "utf8")) as NonSubstitutableEntry[];
}

function declaredNonSubstitutable(step: string): NonSubstitutableEntry | undefined {
  return nonSubstitutableEntries().find((entry) => entry.step === step);
}

// `a.b[id=K4-8].c` walks objects by key and arrays by an `[key=value]` selector.
function evidenceValue(ref: { evidence: string; path: string }): unknown {
  let value: unknown = JSON.parse(readFileSync(ref.evidence, "utf8"));
  for (const segment of ref.path.split(".")) {
    const match = /^([A-Za-z0-9_]+)(?:\[([A-Za-z0-9_]+)=([^\]]+)\])?$/.exec(segment);
    assert.ok(match, `${ref.evidence}: bad evidence path segment ${segment}`);
    assert.ok(value && typeof value === "object", `${ref.evidence}: ${ref.path} stops before ${segment}`);
    value = (value as Record<string, unknown>)[match[1]!];
    if (match[2] !== undefined) {
      assert.ok(Array.isArray(value), `${ref.evidence}: ${match[1]} is not an array`);
      value = (value as Array<Record<string, unknown>>).find((item) => item[match[2]!] === match[3]);
    }
  }
  assert.notEqual(value, undefined, `${ref.evidence} has no ${ref.path}`);
  return value;
}

function resolveOutputValue(spec: OutputValue, siblings: Record<string, unknown>): unknown {
  if ("derive" in spec) {
    for (const condition of spec.from) {
      if (evidenceValue(condition) !== condition.equals) return undefined;
    }
    return spec.derive;
  }
  if ("copy" in spec) return siblings[spec.copy];
  if ("template" in spec) {
    let text = spec.template;
    for (const [name, ref] of Object.entries(spec.params)) text = text.replaceAll(`{${name}}`, String(evidenceValue(ref)));
    return text;
  }
  return evidenceValue(spec);
}

interface SeedResult {
  seeded: string[];
  refused: string[];
}

function seedDeclaredOutputs(entry: NonSubstitutableEntry, fixture: Fixture, override: Record<string, unknown> = {}): SeedResult {
  const result: SeedResult = { seeded: [], refused: [] };
  const branch = fixture.browserBranch ?? "FULL-CONTROL";
  const outputs = (entry.outputs ?? []).filter((output) => output.branch === branch);
  if (outputs.length === 0 && (entry.outputs ?? []).length > 0) {
    result.refused.push(`UNPRODUCED ${(entry.outputs ?? []).map((output) => output.file).join(", ")} for ${branch}: no committed evidence of that branch`);
    return result;
  }
  const evidenceDir = fixture.env.SITE_EVIDENCE;
  for (const output of outputs) {
    const fields = output.json ?? output.lines ?? {};
    const values: Record<string, unknown> = output.plan_documented ? structuredClone(output.plan_documented.json) : {};
    for (const [key, spec] of Object.entries(fields)) values[key] = resolveOutputValue(spec, values);
    // An override changes a value the output declares; a key the output does not have is not added to it.
    for (const [key, value] of Object.entries(override)) if (key in values) values[key] = value;
    const missing = Object.entries(values).filter(([, value]) => value === undefined).map(([key]) => key);
    if (missing.length > 0) {
      result.refused.push(`UNPRODUCED ${output.file}: no ${output.plan_documented ? "plan-documented value" : "committed evidence"} for ${missing.join(", ")}`);
      continue;
    }
    const broken = (output.invariants ?? []).filter((rule) => values[rule.equal[0]] !== values[rule.equal[1]]);
    if (broken.length > 0) {
      // The browser program exits before it writes this file when its own comparison fails, so a file that
      // breaks the comparison is one the real block could never have produced.
      result.refused.push(`REFUSED ${output.file}: ${broken.map((rule) => `${rule.equal.join(" == ")} (${rule.source})`).join(", ")}`);
      continue;
    }
    if (output.location === "site-evidence") {
      assert.ok(evidenceDir, "seeding a browser output needs SITE_EVIDENCE");
      const target = join(evidenceDir, output.file);
      writeFileSync(target, JSON.stringify(Object.fromEntries(Object.entries(values).sort(([a], [b]) => a.localeCompare(b))), null, 2) + "\n", { mode: 0o600 });
      chmodSync(target, Number.parseInt(output.mode, 8));
      result.seeded.push(target);
    } else {
      const target = join(fixture.home, output.file);
      const lines = Object.entries(values).map(([key, value]) => `${key}=${String(value)}\n`).join("");
      writeFileSync(target, `${existsSync(target) ? readFileSync(target, "utf8") : ""}${lines}`, { mode: 0o600 });
      chmodSync(target, Number.parseInt(output.mode, 8));
      result.seeded.push(target);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------------------------------------
// The site build fixture. `npm run build` is a declared non-substitutable surface; the stub lays down this
// tree. Its file list comes from committed evidence: deploy/site/vercel-reference.json (the 25 stable
// artifacts of a real build), M15 in box-facts-measured.json (the five real _astro assets), and the live
// /guides/grok-bot 200 in docs/evidence/2026-09-27-release-9b085c823523/run.log. Page bodies are placeholders,
// so the dry run cannot prove what the real build emits; deploy/site/deploy.sh's own validation and Anvil's
// live readback prove it.
// ---------------------------------------------------------------------------------------------------------

function prepareDistFixture(directory: string): string[] {
  const reference = JSON.parse(readFileSync("deploy/site/vercel-reference.json", "utf8")) as { artifacts: string[] };
  const astro = [...measuredFact("M15").output.matchAll(/\/_astro\/(\S+\.(?:js|css)) mode=/g)].map((match) => match[1]!);
  assert.equal(astro.length, 5, "M15 records five _astro assets");
  const assets = astro.map((name) => `/_astro/${name}`);
  const links = assets.map((asset) => (asset.endsWith(".css")
    ? `<link rel="stylesheet" href="${asset}">`
    : `<script type="module" src="${asset}"></script>`)).join("\n");
  // The build inlines PUBLIC_SUPABASE_URL into the /start page's commonswarm:url meta. The plan's own build-env
  // check names the URL it requires.
  const buildUrl = /PUBLIC_SUPABASE_URL"\) !== "([^"]+)"/.exec(readFileSync(SITE, "utf8"))?.[1];
  assert.ok(buildUrl, "the lane 8 build-env check names the backend URL");
  const pages: Record<string, string> = {
    "index.html": "<!doctype html><title>CommonSwarm</title><h1>CommonSwarm</h1>\n",
    "start/index.html": `<!doctype html><meta name="commonswarm:url" content="${buildUrl}"><title>start</title>\n`,
    "app/index.html": `<!doctype html><title>app</title>\n${links}\n<button data-connected-apps-open>Connected apps</button>\n`,
    "download/index.html": `<!doctype html><title>download</title><p>cswarm ${SITE_VERSION}</p>\n`,
    "guides/grok-bot/index.html": "<!doctype html><title>guide</title><p>cswarm with Grok</p>\n",
  };
  const files = [...new Set([...reference.artifacts, "guides/grok-bot/index.html", ...astro.map((name) => `_astro/${name}`)])].sort();
  for (const path of files) {
    const target = join(directory, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, pages[path] ?? `fixture ${path}\n`);
  }
  return files;
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
  // Mac lane only: the dry run's own directories, the fixture box root, and the containment profile.
  part?: FixturePart;
  macTmp?: string;
  boxRoot?: string;
  boxBin?: string;
  distFixture?: string;
  containment?: string;
  browserBranch?: "FULL-CONTROL" | "REDUCED-CONTROL";
  supportRoot?: string;
  rootDirectories?: RootDirectoryFixture[];
  replacedRuntime?: { path: string; backup?: string };
  replacedDirectory?: { path: string; mode: number; uid: number; gid: number };
  model?: BoxFixtureModel;
  inventoryDeno?: { path: string; digest: string; version: string };
  denoZip?: string;
  denoZipDigest?: string;
  seededPaths?: string[];
  promptInputs: PromptInput[];
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
  for (const command of rootOwned ? BOX_STUB_COMMANDS : STUB_COMMANDS) {
    const target = join(bin, command);
    if (!existsSync(target)) {
      if (command === "node") {
        // Remote shells have a restricted PATH. Use this runner's real Node even when its installation
        // directory is absent there; the enclosing Mac jail or admitted box runner still contains it.
        const executable = canonicalPath(process.execPath).replaceAll("'", "'\\''");
        writeFileSync(target, `#!/bin/sh\nexec '${executable}' "$@"\n`, { mode: 0o755 });
      } else {
        copyFileSync(STUB, target);
      }
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

// Resolve once and copy the actual executable bytes into each fixture. The copy pins the runtime for
// that fixture; PATH changes cannot turn this deterministic computation into a stub or another binary.
function pinInventoryDeno(bin: string): Fixture["inventoryDeno"] {
  const located = spawnSync("/bin/bash", ["-c", "command -v deno"], {
    encoding: "utf8", env: explicitEnvironment({ PATH: macBlockPath("") }),
  });
  if (located.status !== 0 || !located.stdout.trim()) return undefined;
  const source = realpathSync(located.stdout.trim());
  const version = spawnSync(source, ["--version"], { encoding: "utf8", env: explicitEnvironment() });
  if (version.status !== 0 || !/^deno [0-9]+\.[0-9]+\.[0-9]+/m.test(version.stdout)) return undefined;
  const path = join(bin, "inventory-deno");
  copyFileSync(source, path);
  chmodSync(path, 0o555);
  const digest = createHash("sha256").update(readFileSync(source)).digest("hex");
  assert.equal(createHash("sha256").update(readFileSync(path)).digest("hex"), digest);
  return { path, digest, version: version.stdout.trim() };
}

function prepareMacFixture(
  planBlocks: Block[] = [],
  options: { state?: string; browserBranch?: Fixture["browserBranch"]; afterWindowA?: boolean } = {},
): Fixture {
  const state = options.state ?? "s5";
  const temporary = mkdtempSync(join(realpathSync(tmpdir()), "commonswarm-box-dry-run-mac-"));
  chmodSync(temporary, 0o700);
  const checkout = checkoutFixture(temporary, "checkout", "HEAD");
  const declaredPromptInputs = promptInputsForBlocks(planBlocks);
  const home = join(temporary, "child-home");
  const bin = join(temporary, "bin");
  const boxBin = join(temporary, "box-bin");
  const macTmp = join(temporary, "tmp");
  const boxRoot = join(temporary, "box");
  const distFixture = join(temporary, "dist-fixture");
  const log = join(temporary, "stub.log");
  const promptRoot = join(temporary, "prompt-inputs");
  const opServiceAccountTokenFile = join(promptRoot, "op-service-account-token");
  for (const directory of [home, promptRoot, macTmp, boxRoot, distFixture]) mkdirSync(directory, { mode: 0o700 });
  writeFileSync(opServiceAccountTokenFile, promptSchemaContent("op-service-account-token"), { mode: 0o600 });
  chmodSync(opServiceAccountTokenFile, 0o600);
  makeStubBin(bin);
  const inventoryDeno = planBlocks.some((block) => shortStep(block) === "runbook-04") ? pinInventoryDeno(bin) : undefined;
  for (const command of MAC_HOST_STATE_STUBS) {
    copyFileSync(STUB, join(bin, command));
    chmodSync(join(bin, command), 0o755);
  }
  const macProcesses = join(temporary, "mac-processes");
  writeFileSync(macProcesses, "", { mode: 0o600 });
  writeBoxUserlandBin(boxBin);
  const afterWindowA = options.afterWindowA ?? planBlocks.some((block) => block.file === HM37B);
  const finalEdge = afterWindowA ? windowAFinalEdge() : undefined;
  const seededPaths = seedMacBoxRoot(boxRoot, state, finalEdge);
  prepareDistFixture(distFixture);
  const model = cachedBoxModel(state);
  const originMain = spawnSync("git", ["rev-parse", "--verify", "-q", "refs/remotes/origin/main^{commit}"], { encoding: "utf8" });
  // The block profile covers the whole tree a block starts, remote scripts included: writes only inside the dry
  // run's own temporary directory. The remote profile is what an ssh stub applies when a caller outside a
  // contained tree starts a remote script: writes only inside the fixture box root and the stub's own state.
  const blockProfile = containmentProfile({ writableSubpaths: [temporary], writableLiterals: [], executableRoots: [temporary] });
  const remoteProfile = containmentProfile({
    writableSubpaths: [boxRoot, `${log}.stub-state`, `${log}.cswarm-state`],
    writableLiterals: [log],
    executableRoots: [temporary],
  });
  const env = explicitEnvironment({
    ...syntheticPromptEnvironment(temporary, declaredPromptInputs),
    HOME: home,
    TMPDIR: macTmp,
    PATH: macBlockPath(bin),
    BOX_DRY_RUN_PART: "mac",
    BOX_DRY_RUN_STUB_LOG: log,
    BOX_DRY_RUN_PYTHON_FIXTURE: PYTHON_FIXTURE,
    BOX_DRY_RUN_USERLAND: USERLAND,
    BOX_DRY_RUN_BOX_ROOT: boxRoot,
    BOX_DRY_RUN_BOX_BIN: boxBin,
    BOX_DRY_RUN_MAC_TMP: macTmp,
    BOX_DRY_RUN_BOX_CLOCK: WINDOW_START,
    BOX_DRY_RUN_MAC_PROCESSES: macProcesses,
    BOX_DRY_RUN_SOURCE_CLONE: checkout,
    ...(originMain.status === 0 ? { BOX_DRY_RUN_ORIGIN_MAIN: originMain.stdout.trim() } : {}),
    BOX_DRY_RUN_DIST_FIXTURE: distFixture,
    BOX_DRY_RUN_REMOTE_SANDBOX_PROFILE: remoteProfile,
    BOX_DRY_RUN_OP_SERVICE_ACCOUNT_TOKEN_FILE: opServiceAccountTokenFile,
    BOX_DRY_RUN_EXPECTED_EDGE: finalEdge ?? PREVIOUS_EDGE,
    BOX_DRY_RUN_RELEASE_SHA: RELEASE_SHA,
    BOX_DRY_RUN_SITE_BASE_RELEASE: SITE_BASE_RELEASE,
    BOX_DRY_RUN_PSQL_IMAGE: PSQL_IMAGE,
    BOX_DRY_RUN_POSTGRES_IMAGE_ID: model.containers.postgres.image!,
    BOX_DRY_RUN_EDGE_HEALTH: model.containers.edge.health!,
    BOX_DRY_RUN_EDGE_PUBLIC_ENABLED: EDGE_PUBLIC_ENABLED,
    BOX_DRY_RUN_EDGE_WORKDIR: model.containers.edge.labels["com.docker.compose.project.working_dir"]!.replace(PREVIOUS_EDGE, finalEdge ?? PREVIOUS_EDGE),
    BOX_DRY_RUN_EDGE_MOUNTS: model.containers.edge.mounts.map((mount) => `${mount.source.replace(PREVIOUS_EDGE, finalEdge ?? PREVIOUS_EDGE)} ${mount.destination}`).join("\n"),
    BOX_DRY_RUN_EDGE_MEMORY: String(EDGE_MEMORY),
    BOX_DRY_RUN_EDGE_NETWORK: EDGE_NETWORK,
    BOX_DRY_RUN_CANDIDATE_EDGE: CANDIDATE_EDGE,
    BOX_DRY_RUN_OAUTH_IMAGE: model.containers.oauth.image!,
  });
  if (env.PREP_RECEIPT_PATH) {
    const prep = JSON.parse(readFileSync(env.PREP_RECEIPT_PATH, "utf8")) as {
      workspace_id: string;
      seats: Array<{ principal_id: string }>;
    };
    const cswarmState = `${log}.cswarm-state`;
    mkdirSync(cswarmState, { mode: 0o700 });
    writeFileSync(join(cswarmState, "principals.tsv"), prep.seats.map((seat) =>
      `${prep.workspace_id}\t${seat.principal_id}\tfalse\n`).join(""), { mode: 0o600 });
  }
  return {
    temporary, cwd: checkout, home, bin, log, inventoryDeno,
    prelude: PRELUDE,
    pythonFixture: PYTHON_FIXTURE,
    sourceRoot: checkout,
    part: "mac", macTmp, boxRoot, boxBin, distFixture, containment: blockProfile,
    browserBranch: options.browserBranch ?? "FULL-CONTROL",
    seededPaths, model,
    env,
    promptInputs: declaredPromptInputs,
  };
}

// Everything a Mac fixture wrote is under its own temporary directory; removing that directory is the whole
// cleanup. Nothing lives at a fixed host path.
function cleanupMacFixture(fixture: Fixture): void {
  removeOwnedTemporary(fixture.temporary!, "commonswarm-box-dry-run-mac-");
}

function seedHm37bCopybackReceipt(fixture: Fixture): void {
  writeMode(join(fixture.macTmp!, `commonswarm-hm37b-open-${RELEASE_SHA}.env`), [
    `SHA='${RELEASE_SHA}'`, `WINDOW_START_UTC='${WINDOW_START}'`,
    "WINDOW_END_UTC='2026-09-28T05:02:03Z'", `WINDOW_ID='${WINDOW_ID}'`,
    "WINDOW_PRINCIPAL_SUFFIX='010203'", "BACKUP_MAX_AGE_SECONDS='86400'", "",
  ].join("\n"));
  fixture.env.RELEASE_SHA = RELEASE_SHA;
}

interface CheckoutSnapshot {
  status: string;
  evidenceMtimes: Array<{ path: string; mtimeMs: number }>;
}

function checkoutSnapshot(checkout: string): CheckoutSnapshot {
  const status = spawnSync("git", ["status", "--porcelain"], { cwd: checkout, encoding: "utf8" });
  assert.equal(status.status, 0, status.stderr);
  const evidenceRoot = join(checkout, "docs/evidence");
  const evidenceMtimes: CheckoutSnapshot["evidenceMtimes"] = [];
  const visit = (path: string): void => {
    const stat = lstatSync(path);
    evidenceMtimes.push({ path: relative(evidenceRoot, path) || ".", mtimeMs: stat.mtimeMs });
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(join(path, name));
    }
  };
  visit(evidenceRoot);
  return { status: status.stdout, evidenceMtimes };
}

function assertCheckoutUnchanged(checkout: string, before: CheckoutSnapshot): void {
  assert.deepEqual(checkoutSnapshot(checkout), before, "dry run changed the real checkout");
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
    `PREVIOUS_EDGE='${PREVIOUS_EDGE}'`,
    `PREVIOUS_STACK='${PREVIOUS_STACK}'`,
    "RECYCLE_TIMER_STOPPED='0'", "BACKUP_TIMERS_STOPPED='0'",
    "MCP_CADDY_SITE='/etc/caddy/sites/12-commonswarm-mcp.caddy'",
    `RELEASE_DIR_STATE='${edgeState === stackState ? edgeState : "mixed"}'`,
    `EDGE_RELEASE_DIR_STATE='${edgeState}'`, `STACK_RELEASE_DIR_STATE='${stackState}'`, "",
  ].join("\n");
}

const guardedBoxFixtures = new WeakSet<Fixture>();

function boxRunnerGuard(env: NodeJS.ProcessEnv): ContainmentAvailability {
  const result = spawnSync("/bin/bash", [GUARD], { encoding: "utf8", env });
  return result.status === 0 && result.stdout.trim() === "BOX_DRY_RUN_GUARD=PASS"
    ? { available: true, detail: "" }
    : { available: false, detail: result.stderr.trim() || `runner guard exited ${result.status}` };
}

function prepareBoxFixture(state: string, planBlocks: Block[] = []): Fixture {
  assert.equal(process.env.BOX_DRY_RUN_PART, "box");
  // Run before creating real-path fixtures: the guard requires those paths to be absent.
  const guard = boxRunnerGuard(process.env);
  assert.ok(guard.available, `CONTAINMENT UNAVAILABLE: ${guard.detail}. The fixture was not created.`);
  const finalEdge = planBlocks.some((block) => block.file === HM37B) ? windowAFinalEdge() : undefined;
  const declaredPromptInputs = promptInputsForBlocks(planBlocks);
  const model = buildBoxFixtureModel(state);
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
  const denoZip = join(supportRoot, "deno-v2.9.7.zip");
  const zipResult = spawnSync("/usr/bin/python3", ["-c", [
    "import pathlib, sys, zipfile",
    "target, source = sys.argv[1:]",
    "info = zipfile.ZipInfo('deno')",
    "info.external_attr = 0o100755 << 16",
    "with zipfile.ZipFile(target, 'w', zipfile.ZIP_STORED) as archive:",
    "    archive.writestr(info, pathlib.Path(source).read_bytes())",
  ].join("\n"), denoZip, resolve(STUB)], { encoding: "utf8" });
  assert.equal(zipResult.status, 0, zipResult.stderr);
  chownSync(denoZip, 0, 0);
  chmodSync(denoZip, 0o644);
  const denoZipDigest = createHash("sha256").update(readFileSync(denoZip)).digest("hex");
  makeStubBin(bin, true);
  writeRootMode(log, "", 0o600);
  const originalDeno = pathExists(DENO_PATH)
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
    renameSync(DENO_PATH, originalDeno);
  }
  assert.equal(pathExists(DENO_PATH), false, "M1 fixture baseline requires Deno absent");
  for (const path of ["/home/commonswarm", "/srv/commonswarm"]) makeRootDirectory(path, 0o750);
  const previousEdge = model.releases.previousEdge.path;
  const previousStack = model.releases.previousStack.path;
  for (const release of [previousEdge, previousStack]) {
    mkdirSync(release, { recursive: true });
    const releaseModel = Object.values(model.releases).find((candidate) => candidate.path === release);
    assert.ok(releaseModel);
    writeMode(join(release, "RELEASE_SHA"), model.files[`${release}/RELEASE_SHA`]!.bytes, 0o644);
    chmodSync(release, release === previousEdge ? 0o750 : 0o755);
  }
  const measuredDbHelper = join(previousStack, "deploy/supabase-stack/migrate/run-db-tool.sh");
  writeMode(measuredDbHelper, "#!/bin/sh\nprintf '%s\\n' 'UNPRODUCED database observation' >&2\nexit 69\n", 0o775);
  mkdirSync("/home/commonswarm/edge", { recursive: true });
  mkdirSync("/home/commonswarm/stack", { recursive: true });
  for (const path of ["/home/commonswarm/edge", "/home/commonswarm/stack"]) chmodSync(path, 0o755);
  symlinkSync(finalEdge ?? previousEdge, "/home/commonswarm/edge/current");
  symlinkSync(previousStack, "/home/commonswarm/stack/current");
  copyRootFixture(K4_10_COMPOSE_OVERRIDE_EVIDENCE, K4_10_COMPOSE_OVERRIDE_PATH, 0o644);

  makeRootDirectory(K4_12_STACK_PROOF_PARENT, 0o755);
  if (state === "s5") {
    for (const name of K4_12_DIRECTORY_NAMES) makeRootDirectory(join(K4_12_STACK_PROOF_PARENT, name), 0o700);
  } else {
    makeRootDirectory(dirname(K4_11_OAUTH_IMAGE_PATH), 0o700);
  }
  writeRootMode(K4_11_OAUTH_IMAGE_PATH, K4_11_OAUTH_IMAGE_BYTES, 0o644);

  const proof = PROOF_DIR;
  if (state === "s2" || state === "s5") {
    for (const closed of CLOSED_PROOF_PATHS) mkdirSync(closed, { recursive: true });
  }
  if (state === "s5") {
    assert.equal(pathExists(proof), false, "M5 measured-now fixture unexpectedly has an active proof directory");
    assert.equal(pathExists(join(proof, "window.env")), false, "M5 measured-now fixture unexpectedly has a window file");
    assert.equal(CLOSED_PROOF_PATHS.filter(pathExists).length, 2, "M5 measured-now fixture must have exactly two closed proofs");
  }
  writeMode("/home/commonswarm/.env",
    Object.entries(model.envValues).map(([name, value]) => `${name}=${value}`).join("\n") + "\n", 0o600);
  writeMode("/etc/commonswarm-release/target.env", SYNTHETIC_TARGET_ENV_BODY, 0o600);
  writeMode("/etc/ssl/yulan-internal-ca.pem", "dry-run-ca\n", 0o644);
  writeMode("/etc/commonswarm-oauth/database-credentials", "UNMEASURED\n", 0o640);
  writeMode("/etc/commonswarm-oauth/service.env", "MCP_OAUTH_DATABASE_NAME=commonswarm\n", 0o600);
  writeMode("/var/backups/commonswarm-postgres/status.json", JSON.stringify({
    ok: true, database_bytes_verified: true, object_bytes_verified: true,
    verified_at: new Date().toISOString(), destination: "r2:yulan-vps-1-backups/000-commonswarm-postgres/dry-run",
  }) + "\n");
  const measuredSiteRelease = join("/srv/commonswarm/site/releases", SITE_BASE_RELEASE);
  mkdirSync(join(measuredSiteRelease, "app"), { recursive: true });
  mkdirSync(join(measuredSiteRelease, "download"), { recursive: true });
  writeMode(join(measuredSiteRelease, "app/index.html"), "measured baseline without connected-apps marker\n", 0o644);
  writeMode(join(measuredSiteRelease, "download/index.html"), `cswarm ${SITE_VERSION}\n`, 0o644);
  mkdirSync("/srv/commonswarm/site", { recursive: true });
  symlinkSync(measuredSiteRelease, "/srv/commonswarm/site/current");
  const targetEdge = CANDIDATE_EDGE;
  const targetStack = CANDIDATE_STACK;
  if (state !== "s1") {
    for (const release of [targetEdge, targetStack]) {
      mkdirSync(release, { recursive: true });
      if (release === targetStack) populateExistingDatabaseTools(release, RELEASE_SHA);
      writeMode(join(release, "RELEASE_SHA"), model.files[`${release}/RELEASE_SHA`]!.bytes, 0o644);
    }
    chownTree("commonswarm:commonswarm", targetEdge, targetStack);
    chmodSync(targetEdge, 0o750);
    chmodSync(targetStack, 0o755);
  }
  chownTree("root:root", supportRoot);
  for (const path of [
    log,
    "/home/commonswarm/.env",
    "/etc/commonswarm-release/target.env",
    "/etc/ssl/yulan-internal-ca.pem",
    "/etc/commonswarm-oauth/database-credentials",
    "/etc/commonswarm-oauth/service.env",
    "/var/backups/commonswarm-postgres/status.json",
  ]) chownSync(path, 0, 0);
  chownTree("commonswarm:commonswarm", previousEdge, previousStack, measuredSiteRelease);
  if (state !== "s1") chownTree("commonswarm:commonswarm", targetEdge, targetStack);
  chownPaths(
    "commonswarm:commonswarm",
    "/home/commonswarm", "/home/commonswarm/edge", "/home/commonswarm/stack",
    "/home/commonswarm/.env",
    "/srv/commonswarm", "/srv/commonswarm/site", "/srv/commonswarm/site/releases",
  );

  const originalUsrLocalBin = lstatSync("/usr/local/bin");
  assert.equal(originalUsrLocalBin.isDirectory(), true, "/usr/local/bin must be a directory");
  chownSync("/usr/local/bin", 0, 0);
  chmodSync("/usr/local/bin", 0o755);

  const normalizeSeededPath = (path: string): string => {
    if ([K4_10_COMPOSE_OVERRIDE_PATH, K4_11_OAUTH_IMAGE_PATH, K4_12_STACK_PROOF_PARENT].includes(path)) return path;
    if (path === measuredDbHelper) return "/home/commonswarm/stack/current/deploy/supabase-stack/migrate/run-db-tool.sh";
    return path
      .replace(PREVIOUS_EDGE, "/home/commonswarm/edge/releases/<previous>")
      .replace(PREVIOUS_STACK, "/home/commonswarm/stack/releases/<previous>")
      .replace(CANDIDATE_EDGE, "/home/commonswarm/edge/releases/<candidate>")
      .replace(CANDIDATE_STACK, "/home/commonswarm/stack/releases/<candidate>")
      .replace(new RegExp(`${PROOF_DIR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.closed-window-[^/]+`),
        "/home/commonswarm/stack/release-proofs/<closed>")
      .replace(measuredSiteRelease, "/srv/commonswarm/site/releases/<previous>");
  };
  const seededPaths = [
    "/home/commonswarm/edge/current", "/home/commonswarm/stack/current",
    previousEdge, join(previousEdge, "RELEASE_SHA"), previousStack, join(previousStack, "RELEASE_SHA"),
    targetEdge, join(targetEdge, "RELEASE_SHA"), targetStack, join(targetStack, "RELEASE_SHA"),
    ...CLOSED_PROOF_PATHS,
    K4_10_COMPOSE_OVERRIDE_PATH, K4_11_OAUTH_IMAGE_PATH, K4_12_STACK_PROOF_PARENT,
    "/etc/commonswarm-oauth/database-credentials", "/etc/commonswarm-oauth/service.env",
    "/etc/ssl/yulan-internal-ca.pem", "/etc/commonswarm-release/target.env", measuredDbHelper,
    "/var/backups/commonswarm-postgres/status.json", "/home/commonswarm/.env", "/usr/local/bin",
    "/srv/commonswarm/site/current", measuredSiteRelease,
    join(measuredSiteRelease, "app/index.html"), join(measuredSiteRelease, "download/index.html"),
  ].filter(pathExists).map(normalizeSeededPath).filter((path, index, paths) => paths.indexOf(path) === index).sort();

  const fixture: Fixture = {
    temporary, cwd: process.cwd(), home: "/root", bin, log, model,
    prelude, pythonFixture, sourceRoot, supportRoot, rootDirectories,
    denoZip, denoZipDigest, seededPaths,
    replacedRuntime: { path: DENO_PATH, ...(originalDeno ? { backup: originalDeno } : {}) },
    replacedDirectory: {
      path: "/usr/local/bin", mode: originalUsrLocalBin.mode & 0o777,
      uid: originalUsrLocalBin.uid, gid: originalUsrLocalBin.gid,
    },
    env: explicitEnvironment({
      ...syntheticPromptEnvironment(temporary, declaredPromptInputs),
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      BOX_DRY_RUN_PART: "box",
      BOX_DRY_RUN_BOX_ROOT: "/",
      BOX_DRY_RUN_STUB_LOG: log,
      BOX_DRY_RUN_PYTHON_FIXTURE: pythonFixture,
      BOX_DRY_RUN_EXPECTED_EDGE: finalEdge ?? previousEdge,
      BOX_DRY_RUN_PSQL_IMAGE: PSQL_IMAGE,
      BOX_DRY_RUN_POSTGRES_IMAGE_ID: model.containers.postgres.image,
      BOX_DRY_RUN_SITE_BASE_RELEASE: SITE_BASE_RELEASE,
      BOX_DRY_RUN_EDGE_HEALTH: model.containers.edge.health,
      BOX_DRY_RUN_EDGE_PUBLIC_ENABLED: EDGE_PUBLIC_ENABLED,
      BOX_DRY_RUN_EDGE_WORKDIR: model.containers.edge.labels["com.docker.compose.project.working_dir"]!.replace(previousEdge, finalEdge ?? previousEdge),
      BOX_DRY_RUN_EDGE_MOUNTS: model.containers.edge.mounts.map((mount) => `${mount.source.replace(previousEdge, finalEdge ?? previousEdge)} ${mount.destination}`).join("\n"),
      BOX_DRY_RUN_EDGE_MEMORY: model.containers.candidateEdge.memory,
      BOX_DRY_RUN_EDGE_NETWORK: model.containers.candidateEdge.network,
      BOX_DRY_RUN_CANDIDATE_EDGE: CANDIDATE_EDGE,
      BOX_DRY_RUN_RELEASE_SHA: RELEASE_SHA,
    }),
    promptInputs: declaredPromptInputs,
    part: "box",
  };
  guardedBoxFixtures.add(fixture);
  return fixture;
}

function cleanupBoxFixture(fixture: Fixture): void {
  guardedBoxFixtures.delete(fixture);
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
  if (fixture.replacedDirectory) {
    chownSync(fixture.replacedDirectory.path, fixture.replacedDirectory.uid, fixture.replacedDirectory.gid);
    chmodSync(fixture.replacedDirectory.path, fixture.replacedDirectory.mode);
  }
  for (const directory of [...(fixture.rootDirectories ?? [])].reverse()) {
    if (directory.created && pathExists(directory.path)) rmdirSync(directory.path);
  }
  removeOwnedTemporary(fixture.temporary!, `commonswarm-box-dry-run-`);
}

function produceDenoUnitPrerequisites(fixture: Fixture): void {
  assert.ok(fixture.denoZip && fixture.denoZipDigest);
  mkdirSync(PROOF_DIR, { recursive: true, mode: 0o700 });
  writeRootMode(join(PROOF_DIR, "window.env"), windowEnvBody("s2"));
  fixture.env.BOX_DRY_RUN_DENO_VERSION = "deno 2.9.7\nv8 dry-run\ntypescript dry-run";
  fixture.env.BOX_DRY_RUN_DENO_ZIP_FIXTURE = fixture.denoZip;
  fixture.env.BOX_DRY_RUN_DENO_ZIP_SHA256 = fixture.denoZipDigest;
}

function produceRunbook18UnitPrerequisites(fixture: Fixture): void {
  mkdirSync(PROOF_DIR, { recursive: true, mode: 0o700 });
  writeRootMode(join(PROOF_DIR, "window.env"), windowEnvBody("s2"));
  // This unit control owns the empty-ledger shell check, not database identity or catalog verification.
  // Supply those prerequisites only here; whole-plan runs retain their real producer dependencies.
  const migrate = join(fixture.temporary!, "unit-database-tools");
  const ledgerRows = join(fixture.temporary!, "unit-ledger-rows.txt");
  writeRootMode(ledgerRows, "");
  writeRootMode(join(migrate, "run-db-tool.sh"), [
    "#!/bin/bash", "set -euo pipefail",
    'test "$#" -eq 3', 'test "$1" = assert-database-identity.sh',
    `test "$2" = '${PROOF_DIR}/database'`, 'test "$3" = target', "",
  ].join("\n"), 0o755);
  writeRootMode(`/run/commonswarm-release-${RELEASE_SHA}-apply.sql`, "-- unit control\n");
  writeRootMode(`/run/commonswarm-release-${RELEASE_SHA}-session.sh`, [
    `STACK_RELEASE='${CANDIDATE_STACK}'`,
    `MIGRATE='${migrate}'`,
    `PROOF_DIR='${PROOF_DIR}'`,
    `APPLY_SQL='/run/commonswarm-release-${RELEASE_SHA}-apply.sql'`,
    "release_psql_ro() {",
    '  if [ "$#" -eq 2 ] && [ "$1" = --file ] && [ "$2" = "$APPLY_SQL" ]; then',
    '    test -s "$APPLY_SQL"',
    '  elif [ "$#" -eq 3 ] && [ "$1" = -Atq ] && [ "$2" = --command ] &&',
    `       [ "$3" = "SELECT version FROM supabase_migrations.schema_migrations WHERE version IN ('20260916000001','20260916000002') ORDER BY version;" ]; then`,
    `    /bin/cat '${ledgerRows}'`,
    "  else return 69; fi",
    "}",
    "",
  ].join("\n"));
}

type FixturePart = "mac" | "box";

interface Execution {
  step: string;
  result: "passed" | "failed" | "not-executed";
  status: number | null;
  firstFailingCommand?: string;
  stderr: string;
  stdout: string;
  seeded?: string[];
  refused?: string[];
  declared?: NonSubstitutableEntry;
}

// B's opening window is a Mac-to-box handoff (HM37B:161-192). Box mode skips that Mac block,
// so supply its declared file shape at the producer boundary. This is synthetic window state, not proof
// that the Mac transfer ran. In particular, do not seed A's window before its real box apply producer.
function seedBoxWindowBOpen(block: Block, fixture: Fixture): Execution | undefined {
  if (block.file !== HM37B || shortStep(block) !== "hm37b-box-open") return undefined;
  assert.ok(guardedBoxFixtures.has(fixture), "B handoff requires a guarded box fixture");
  const current = "/home/commonswarm/edge/current";
  assert.equal(realpathSync(current), windowAFinalEdge(), "B handoff requires A's PASSED final edge state");
  assert.equal(readFileSync(join(current, "RELEASE_SHA"), "utf8").trim(), RELEASE_SHA);
  assert.ok(fixture.env.BOX_DRY_RUN_EDGE_PUBLIC_ENABLED, "B handoff requires the public-enabled observation");
  // Both A's close and B's open reject only "1"; the committed dark observation is "unset".
  assert.notEqual(fixture.env.BOX_DRY_RUN_EDGE_PUBLIC_ENABLED, "1", "A's PASSED final edge must remain dark");
  assert.equal(pathExists(PROOF_DIR), false, "B handoff refuses an existing active window");
  makeRootDirectory(PROOF_DIR, 0o700);
  // The clock-derived receipt fields follow the same synthetic window used by the box unit controls;
  // the release paths and timer fields are the assignments in the skipped producer.
  const window = join(PROOF_DIR, "window.env");
  writeRootMode(window, windowEnvBody(fixture.model!.state));
  return {
    step: shortStep(block), result: "not-executed", status: null, stdout: "", stderr: "",
    seeded: [window],
  };
}

function executePlanUntilFailure(planBlocks: Block[], fixture: Fixture, part: FixturePart): Array<{ block: Block; execution: Execution }> {
  const records: Array<{ block: Block; execution: Execution }> = [];
  for (const block of planBlocks) {
    const isBoxBlock = block.host.startsWith("box ");
    if (isBoxBlock !== (part === "box")) {
      // The Mac lane does not execute a box block. What the box block produced is what a later Mac block reads.
      if (part === "mac") {
        const products = boxBlockProducts(shortStep(block));
        if (products.some((product) => product.execute === "local")) {
          // This pure dispatcher reads only the preceding producer's JSON. Execute its complete text
          // through the same jailed ssh boundary as every Mac block, with the fixture box's paths.
          const execution = executeWholeBlock({ ...block,
            source: `ssh ops@100.115.66.74 "sudo -n -i /bin/bash -s" <<'LOCAL_BOX_BLOCK'\n${block.source}\nLOCAL_BOX_BLOCK`,
          }, fixture);
          records.push({ block, execution });
          if (execution.result === "failed") break;
          // Root created these files in the fixture box. Record that virtual ownership only
          // after the real producer succeeds; never seed its content or repair its mode.
          for (const product of products.filter((item) => item.execute === "local")) {
            const path = product.path.replaceAll("{sha}", RELEASE_SHA);
            const target = join(fixture.boxRoot!, path);
            assert.equal(pathExists(target), true, `${shortStep(block)} did not produce ${path}`);
            const stat = lstatSync(target);
            assert.equal(stat.isFile(), true, `${shortStep(block)} product is not a regular file: ${path}`);
            assert.equal(stat.mode & 0o777, Number.parseInt(product.mode, 8), `${shortStep(block)} product mode: ${path}`);
            recordBoxOwner(fixture.boxRoot!, path, product.owner);
          }
        } else {
          const seeded = seedBoxProducts(fixture, shortStep(block));
          const shapes = products.flatMap((product) => product.plan_documented ? [{
            file: basename(product.path), location: "box-proof" as const, mode: product.mode,
            branch: product.kind === "directory" ? "box" : "abort", plan_documented: product.plan_documented,
          }] : []);
          if (shapes.length) records.push({ block, execution: {
            step: shortStep(block), result: "not-executed", status: null, stdout: "", stderr: "", seeded,
            declared: { surface: "box producer products", reason: shapes.map((shape) => shape.plan_documented.label).join(" "),
              live_proof: `Requires the real box producer at ${block.file}:${block.line}; the Mac lane uses only its declared consumer contract.`,
              outputs: shapes },
          } });
        }
      } else {
        if (block.file === HM37 && shortStep(block) === "hm37a-resolved-input-transfer") {
          // The Mac producer is skipped in this lane. Supply synthetic prompt values by their declared
          // names at its transfer boundary (HM37:988-1001), as shell assignments, never observations.
          assert.ok(guardedBoxFixtures.has(fixture), "prompt transfer requires a guarded box fixture");
          const target = join(PROOF_DIR, "item-resolved-inputs.env");
          const body = fixture.promptInputs.map(({ name }) => {
            const value = fixture.env[name];
            assert.notEqual(value, undefined, `unresolved prompt input: ${name}`);
            return `${name}='${value!.replaceAll("'", "'\\''")}'`;
          }).join("\n") + "\n";
          writeRootMode(target, body, 0o600);
          records.push({ block, execution: {
            step: shortStep(block), result: "not-executed", status: null, stdout: "", stderr: "", seeded: [target],
            declared: { surface: "Mac prompt-input transfer", reason: "Synthetic resolved prompt inputs; the Mac transfer is not executed in the box lane.",
              live_proof: `${HM37}:988-1001 requires Anvil's real prompt-input transfer.`,
              outputs: [{ file: basename(target), location: "box-proof", mode: "0600", branch: "box",
                plan_documented: { evidence: HM37, source_lines: "624-636, 988-1001",
                  label: "synthetic resolved prompt values; not measured observations",
                  json: Object.fromEntries(fixture.promptInputs.map(({ name }) => [name, fixture.env[name]!])) },
              }] },
          } });
        }
        const handoff = seedBoxWindowBOpen(block, fixture);
        if (handoff) records.push({ block, execution: handoff });
      }
      continue;
    }
    const execution = executeWholeBlock(block, fixture);
    records.push({ block, execution });
    if (execution.result === "failed") break;
  }
  return records;
}

function executionUnproducedLine(block: Block, execution: Execution, state: string): string {
  const failure = (execution.firstFailingCommand ?? execution.stderr.trim().split("\n")[0] ?? "unknown read")
    .replace(/^.*UNPRODUCED\s+/, "")
    .replace(/^__FIRST_FAIL__:/, "");
  return `UNPRODUCED ${failure} read by ${shortStep(block)} at ${block.file}:${block.line} [plan=${planName(block)} state=${state}]`;
}

interface ContainedResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

// A Mac process tree runs under sandbox-exec, or it does not run. One profile is applied at the top of the
// tree; a second sandbox-exec inside it is refused by the kernel, so nothing below the top applies its own. The
// marker tells an ssh stub that the tree it is in was contained by this function. When the profile cannot be
// applied the result says so and the program's text never reaches a shell.
function containedCommand(
  fixture: Fixture,
  command: string,
  args: string[],
  options: { input?: string; env: NodeJS.ProcessEnv; timeout?: number },
): ContainedResult {
  if (fixture.part === "box") {
    if (process.env.BOX_DRY_RUN_PART !== "box" || !guardedBoxFixtures.has(fixture)) {
      return { status: 71, stdout: "", stderr: "CONTAINMENT UNAVAILABLE: disposable runner guard is not satisfied. The program was not run.\n" };
    }
    // Explicit Linux CI branch. Only prepareBoxFixture can admit a fixture after the existing guard passes.
    const result = spawnSync(command, args, {
      cwd: fixture.cwd, input: options.input, encoding: "utf8", env: options.env, timeout: options.timeout ?? 120_000,
    });
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }
  const env = { ...options.env, BOX_DRY_RUN_CONTAINED: "1" };
  const availability = containmentAvailability();
  if (!availability.available) {
    return { status: 71, stdout: "", stderr: `CONTAINMENT UNAVAILABLE: ${availability.detail}. The program was not run.\n` };
  }
  const result = spawnSync(SANDBOX_EXEC, ["-p", fixture.containment!, command, ...args], {
    cwd: fixture.cwd, input: options.input, encoding: "utf8", env, timeout: options.timeout ?? 120_000,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function containedSpawn(fixture: Fixture, script: string, env: NodeJS.ProcessEnv): ContainedResult {
  return containedCommand(fixture, "/bin/bash", [], { input: script, env });
}

function executeWholeBlock(
  block: Block,
  fixture: Fixture,
  options: {
    fail?: boolean;
    control?: string;
    env?: NodeJS.ProcessEnv;
    unsetEnv?: string[];
    trapErrors?: boolean;
    executeDeclared?: boolean;
    seedOverride?: Record<string, unknown>;
  } = {},
): Execution {
  const step = shortStep(block);
  const contained = fixture.part === "mac";
  const declared = !options.executeDeclared ? declaredNonSubstitutable(step) : undefined;
  if (declared) {
    // A declared surface is not executed: not a part of the block, not with a canned answer.
    const seed = seedDeclaredOutputs(declared, fixture, options.seedOverride);
    return {
      step, result: seed.refused.length > 0 ? "failed" : "not-executed", status: null,
      stderr: seed.refused.join("\n"), stdout: "", seeded: seed.seeded, refused: seed.refused, declared,
    };
  }
  let body = materialize(block);
  if (fixture.temporary) body = body.replaceAll("/Users/yulanbot/anvil-work/hm37-prep", join(fixture.temporary, "hm37-prep"));
  if (fixture.macTmp) body = mapMacTmp(body, fixture.macTmp);
  const script = [
    "set -E", `source ${JSON.stringify(fixture.prelude)}`,
    options.trapErrors === false
      ? "trap - ERR"
      // The ERR trap fires on a failing command whether or not errexit is on. The plan decides where errexit is
      // off (`set +e` around a command whose status it reads), so the trap ends the block only when errexit is on.
      : "trap 'block_status=$?; case $- in *e*) printf \"__FIRST_FAIL__:%s\\n\" \"$BASH_COMMAND\" >&2; exit \"$block_status\" ;; esac' ERR",
    body,
  ].join("\n");
  const childEnv: NodeJS.ProcessEnv = {
    ...fixture.env,
    ...options.env,
    BOX_DRY_RUN_STEP: step,
    BOX_DRY_RUN_FAIL_STEP: options.fail ? step : "",
    BOX_DRY_RUN_CONTROL: options.control ?? "",
    // Set only for a tree the harness puts under its sandbox profile (containedCommand sets it again).
    ...(contained ? { BOX_DRY_RUN_CONTAINED: "1" } : {}),
  };
  for (const name of options.unsetEnv ?? []) delete childEnv[name];
  assertChildEnvironmentAllowed(childEnv, fixture.promptInputs);
  const result = containedSpawn(fixture, script, childEnv);
  const stderr = result.stderr;
  const failure = result.status === 0 ? undefined : /__FIRST_FAIL__:(.*)/.exec(stderr)?.[1];
  return {
    step,
    result: result.status === 0 ? "passed" : "failed",
    status: result.status,
    firstFailingCommand: failure,
    stderr,
    stdout: result.stdout,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Control helpers. A control runs real plan text through executeWholeBlock, or a minimal mutation of it, next to
// a positive run of the same path, and asserts the exact exit status: 69 where a stub refuses.
// ---------------------------------------------------------------------------------------------------------

function planBlock(file: string, step: string): Block {
  const block = blocks(file).find((candidate) => shortStep(candidate) === step);
  assert.ok(block, `${file} has no step ${step}`);
  return block;
}

// A mutation that does not change the block is a control that tests nothing, so it is an error.
function mutatedBlock(block: Block, mutations: Array<[string, string]>): Block {
  let source = block.source;
  for (const [from, to] of mutations) {
    assert.ok(source.includes(from), `control mutation target is absent from ${shortStep(block)}: ${JSON.stringify(from)}`);
    source = source.replace(from, () => to);
  }
  assert.notEqual(source, block.source, `control mutation did not change ${shortStep(block)}`);
  return { ...block, source };
}

function replaceLast(text: string, from: string, to: string): string {
  const index = text.lastIndexOf(from);
  assert.ok(index >= 0, `control mutation target is absent: ${JSON.stringify(from)}`);
  return `${text.slice(0, index)}${to}${text.slice(index + from.length)}`;
}

// Lane 8 carried up to, and not including, a step. Every earlier block runs for real, in plan order, in one Mac
// fixture, so a control gets the box and the evidence directory in the state the plan leaves at that point by
// running the plan and not by writing that state itself. A block that declares a browser surface is seeded from
// its cited evidence or labeled plan-documented shape and not executed, as in every plan run.
function laneEightFixture(stopBefore: string): { fixture: Fixture; byStep: Map<string, Block> } {
  const laneBlocks = resolveSteps("lane-8/FULL-CONTROL", siteOrder());
  const stopIndex = laneBlocks.findIndex((block) => shortStep(block) === stopBefore);
  assert.ok(stopIndex >= 0, `lane 8 has no step ${stopBefore}`);
  const fixture = prepareMacFixture(laneBlocks);
  const records = executePlanUntilFailure(laneBlocks.slice(0, stopIndex), fixture, "mac");
  const failed = records.find(({ execution }) => execution.result === "failed");
  if (failed) {
    cleanupMacFixture(fixture);
    assert.fail(`lane 8 stopped at ${failed.execution.step} before ${stopBefore}:\n${failed.execution.stderr}`);
  }
  return { fixture, byStep: new Map(laneBlocks.map((block) => [shortStep(block), block])) };
}

interface SiteBoxState {
  current: string;
  releases: string[];
}

function fixtureSiteRoot(fixture: Fixture): string {
  return join(fixture.boxRoot!, "srv/commonswarm/site");
}

function siteBoxState(fixture: Fixture): SiteBoxState {
  const site = fixtureSiteRoot(fixture);
  return { current: readlinkSync(join(site, "current")), releases: readdirSync(join(site, "releases")).sort() };
}

// A failed site-04 leaves what a real failed deploy leaves: its evidence files, and possibly an upload directory
// that never became a release. Removing them lets the positive run of the same block follow the negative one in
// the same fixture. Only names the block itself wrote are removed.
function resetSiteFourAttempt(fixture: Fixture, before: SiteBoxState): void {
  const evidence = fixture.env.SITE_EVIDENCE!;
  for (const name of ["deploy.log", "deploy-status.txt", "after.release", "pin-after-deploy.txt"]) rmSync(join(evidence, name), { force: true });
  const releases = join(fixtureSiteRoot(fixture), "releases");
  for (const name of readdirSync(releases)) {
    if (before.releases.includes(name)) continue;
    assert.match(name, /^\d{8}T\d{6}Z-8b8989f2b29e-[0-9a-f]{16}\.tmp$/, `a failed deploy left something other than an upload directory: ${name}`);
    rmSync(join(releases, name), { recursive: true });
  }
  assert.deepEqual(siteBoxState(fixture), before);
}

// The real deploy.sh at the release SHA, copied beside itself with one line added, so the block still runs the
// script from its own directory. The block's own pre-checks compare tracked files only, and an untracked copy is
// not one of them.
function writeMutatedDeploy(fixture: Fixture, mutate: (source: string) => string): string {
  const repo = fixture.env.SITE_RELEASE_REPO!;
  const original = readFileSync(join(repo, "deploy/site/deploy.sh"), "utf8");
  const mutated = mutate(original);
  assert.notEqual(mutated, original, "control deploy.sh mutation did not change the script");
  writeFileSync(join(repo, "deploy/site/deploy-control.sh"), mutated, { mode: 0o644 });
  return "deploy/site/deploy-control.sh";
}

const SITE_FOUR_DEPLOY_CALL = "/bin/sh deploy/site/deploy.sh commonswarm@yulan-vps-1";

function siteFourDeployStatus(fixture: Fixture): string {
  return readFileSync(join(fixture.env.SITE_EVIDENCE!, "deploy-status.txt"), "utf8");
}

test("all scoped fences and host declarations are executable or explicitly text", (t) => {
  const parsed = SCOPED.flatMap(blocks);
  assert.equal(blocks(PREP).length, 5);
  assert.equal(blocks(HM37).length, 29);
  assert.equal(blocks(HM37B).length, 21);
  assert.equal(blocks(RUNBOOK).length, 67);
  assert.equal(blocks(SITE).length, 15);
  assert.equal(blocks(TEMPLATE).length, 3);
  assert.deepEqual(
    SCOPED.flatMap((file) => fencedLanguages(file).filter(
      (language) => language !== "sh" && language !== "text" && language !== "prompt-inputs",
    )),
    [],
  );
  for (const block of parsed) {
    assert.match(block.host, /^(?:Mac mini \/bin\/bash 3\.2|box \/bin\/bash 5\.2)/);
    const syntax = spawnSync("/bin/bash", ["-n"], { input: block.source, encoding: "utf8" });
    assert.equal(syntax.status, 0, `${block.file}:${block.line} [${block.step}] ${syntax.stderr}`);
  }
  t.diagnostic(`blocks=${parsed.length}; prep=5 hm37a=29 hm37b=21 runbook=67 site=15 template=3`);
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
  const siteRequirements = site.slice(site.indexOf("These are fixed assertions, not window decisions:"), site.indexOf("# step: site-03-go-record"));
  const siteAssertions = siteRequirements.split("\n").filter((line) => line.startsWith("- "));
  assert.equal(siteAssertions.length, 5, "site GO section must retain five fixed assertions");
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
        /`(?:hm37-[^`]+|runbook-[^`]+|site-[^`]+)`|HezLead decision|every marked block/,
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
  const suffix = stepSource(runbook, "runbook-01");
  assert.match(suffix, /WINDOW_START_UTC is required/);
  assert.match(suffix, /WINDOW_START_UTC must be an ISO-8601 UTC time in YYYY-MM-DDTHH:MM:SSZ form/);
  assert.match(suffix, /date -u -d "\$WINDOW_START_UTC" \+%s/);
  assert.match(open, /WINDOW_ID="\$\(printf '%s' "\$WINDOW_START_UTC" \| tr -d ':-'\)"/);
  assert.match(open, /\.commonswarm-release-window\.env/);
  assert.match(open, /BOX_WINDOW_INPUT/);
  assert.match(stepSource(runbook, "1-apply-release-directories"), /\. \/tmp\/commonswarm-release-window\.env/);
  assertRunbook03NamedShaWindowPath(runbook);
  const siteOpen = blocks(SITE).find((block) => shortStep(block) === "site-01")?.source;
  assert.ok(siteOpen);
  assert.match(siteOpen, /SITE_WINDOW_ID=\$\(printf '%s' "\$start" \| tr -d ':-'\)/);
  assert.match(siteOpen, /\.commonswarm-site-window\.env/);
  for (const block of blocks(SITE).filter((candidate) => !["site-00-source-checkout", "site-01"].includes(shortStep(candidate)))) {
    if (block.host.startsWith("Mac mini")) {
      if (block.source.includes(".commonswarm-site-window.env")) {
        assert.match(block.source, /\. "\$HOME\/\.commonswarm-site-window\.env"/);
      }
    } else {
      assert.match(block.source, /\. \/tmp\/commonswarm-site-window\.env/);
    }
  }
});

test("runbook-01 fails clearly unless WINDOW_START_UTC is a valid approved UTC input", { skip: MAC_ONLY }, () => {
  const block = blocks(RUNBOOK).find((candidate) => shortStep(candidate) === "runbook-01");
  assert.ok(block);
  const fixture = prepareMacFixture();
  try {
    const missing = executeWholeBlock(block, fixture, { unsetEnv: ["WINDOW_START_UTC"], trapErrors: false });
    assert.equal(missing.result, "failed");
    assert.match(missing.stderr, /WINDOW_START_UTC is required/);

    assert.match(block.source, /must be an ISO-8601 UTC time in YYYY-MM-DDTHH:MM:SSZ form/);
    assert.match(block.source, /must be a valid ISO-8601 UTC time/);
    assert.ok(!PRESEED_ALLOWLIST.some((item) => item.kind === "env" && item.name === "WINDOW_START_UTC"));
  } finally {
    cleanupMacFixture(fixture);
  }
});

test("the box safety guard refuses this Mac and validates every blocking condition", {
  skip: MAC_ONLY,
}, () => {
  const guard = readFileSync(GUARD, "utf8");
  for (const required of [
    "BOX_DRY_RUN", "GITHUB_ACTIONS", "CI", "uname -s", "hostname -s",
    "id -u", "/home/commonswarm", "/srv/commonswarm",
  ]) assert.ok(guard.includes(required), `guard omits ${required}`);
  const result = spawnSync("/bin/bash", [GUARD], {
    encoding: "utf8",
    env: explicitEnvironment({ BOX_DRY_RUN: "1", GITHUB_ACTIONS: "true", CI: "true" }),
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
  const denoPath = DENO_PATH;
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
    const allowedPathSeeds = new Set(PRESEED_ALLOWLIST.filter((item) => item.kind === "path").map((item) => item.name));
    for (const path of fixture.seededPaths ?? []) {
      if (!allowedPathSeeds.has(path)) failures.push(`fixture pre-seeded non-allowlisted path: ${path}`);
    }
    check("effective uid", "0", () => String(process.getuid?.()), (actual) => actual === "0");
    check("hostname", "anything except yulan-vps-1", () => {
      const result = spawnSync("/bin/hostname", ["-s"], { encoding: "utf8" });
      return `status=${result.status} name=${result.stdout.trim()}`;
    }, (actual) => actual.startsWith("status=0 name=") && actual !== "status=0 name=yulan-vps-1");
    for (const name of ACCOUNT_NAMES) {
      check(`user ${name}`, "present", () => {
        const result = spawnSync("/usr/bin/id", ["-u", name], { encoding: "utf8" });
        return `status=${result.status} uid=${result.stdout.trim()}`;
      }, (actual) => /^status=0 uid=\d+$/.test(actual));
      check(`primary group ${name}`, name, () => {
        const result = spawnSync("/usr/bin/id", ["-gn", name], { encoding: "utf8" });
        return `status=${result.status} group=${result.stdout.trim()}`;
      }, (actual) => actual === `status=0 group=${name}`);
    }
    for (const name of ACCOUNT_NAMES) {
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
    for (const command of BOX_STUB_COMMANDS) {
      const path = join(fixture.bin, command);
      checkStat(path, 0, 0, 0o755, "file");
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
    check(denoPath, "absent before hm37-deno-install", () => String(pathExists(denoPath)), (actual) => actual === "false");
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
      ["/etc/commonswarm-release/target.env", 0o600],
      ["/etc/ssl/yulan-internal-ca.pem", 0o644],
      ["/etc/commonswarm-oauth/database-credentials", 0o640],
      ["/etc/commonswarm-oauth/service.env", 0o600],
      ["/var/backups/commonswarm-postgres/status.json", 0o600],
    ] as const) checkStat(path, 0, 0, mode, "file");
    check(PROOF_DIR, "absent before an opening block produces it", () => String(pathExists(PROOF_DIR)),
      (actual) => actual === "false");
    const commonswarmUidResult = spawnSync("/usr/bin/id", ["-u", "commonswarm"], { encoding: "utf8" });
    const commonswarmGidResult = spawnSync("/usr/bin/id", ["-g", "commonswarm"], { encoding: "utf8" });
    if (commonswarmUidResult.status === 0 && commonswarmGidResult.status === 0) {
      const commonswarmUid = Number.parseInt(commonswarmUidResult.stdout, 10);
      const commonswarmGid = Number.parseInt(commonswarmGidResult.stdout, 10);
      checkStat("/home/commonswarm", commonswarmUid, commonswarmGid, 0o750, "directory");
      checkStat("/srv/commonswarm", commonswarmUid, commonswarmGid, 0o750, "directory");
      checkStat(PREVIOUS_EDGE, commonswarmUid, commonswarmGid, 0o750, "directory");
      checkStat(PREVIOUS_STACK, commonswarmUid, commonswarmGid, 0o755, "directory");
      checkStat(CANDIDATE_EDGE, commonswarmUid, commonswarmGid, 0o750, "directory");
      checkStat(CANDIDATE_STACK, commonswarmUid, commonswarmGid, 0o755, "directory");
      checkStat("/home/commonswarm/.env", commonswarmUid, commonswarmGid, 0o600, "file");
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

test("Mac harness uses a temporary local clone and recorded command stubs only", { skip: MAC_ONLY }, () => {
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
      env: explicitEnvironment({ HOME: home }),
    });
    assert.equal(cloned.status, 0, cloned.stderr);
    for (const command of ["docker", "systemctl", "psql", "caddy", "ssh", "scp", "sudo", "op", "curl", "chown"]) {
      const target = join(bin, command);
      symlinkSync(resolve(STUB), target);
    }
    const baseEnv = explicitEnvironment({ HOME: home, PATH: `${bin}:${process.env.PATH ?? ""}`, BOX_DRY_RUN_STUB_LOG: log });
    assert.notEqual(spawnSync("ssh", ["ops@box", "true"], { env: baseEnv }).status, 0);
    assert.notEqual(spawnSync("scp", ["fixture", "ops@box:/tmp/fixture"], { env: baseEnv }).status, 0);
    assert.notEqual(spawnSync("op", ["read", "op://placeholder"], { env: baseEnv }).status, 0);
    assert.notEqual(spawnSync("curl", ["https://api.commonswarm.com"], { env: baseEnv }).status, 0);
    assert.equal(spawnSync("curl", ["-H", "User-Agent: commonswarm-release-probe/1.0", "https://api.commonswarm.com"], { env: baseEnv }).status, 0);
    assert.notEqual(spawnSync("psql", ["--file", "/host/proof.sql"], { env: baseEnv }).status, 0);
    assert.notEqual(spawnSync("psql", ["--file", "/proof/proof.sql"], { env: baseEnv }).status, 0);
    const calls = readFileSync(log, "utf8").trim().split("\n");
    assert.equal(calls.length, 7);
    assert.ok(calls.every(Boolean));
    assert.equal(existsSync(join(clone, ".git")), true);
  } finally {
    removeOwnedTemporary(temporary, "commonswarm-box-dry-run-mac-");
  }
});

test("plan-used systemctl, docker, and ssh operations are explicitly listed by the stubs", () => {
  const planBlocks = SCOPED.flatMap(blocks);
  assertStubCoverage(planBlocks);
  assert.throws(() => assertStubCoverage([
    {
      file: "synthetic-plan.md", step: "missing-docker-operation", marker: "no",
      host: "box /bin/bash 5.2 as root", line: 1,
      source: "# step: missing-docker-operation\n# readonly: no\n# host: box /bin/bash 5.2 as root\ndocker network create dry-run-control\n",
    },
  ]), /plan operations missing from dry-run stub list:\ndocker network/);
});

// ---------------------------------------------------------------------------------------------------------
// The site deploy boundary. Lane 8 step site-04 runs the real deploy/site/deploy.sh, and through it the real
// finalize-release.sh. fixtures/site-deploy-commands.json lists every command those scripts run and how the dry
// run answers it; this reads the commands from the script text, so a command a later edit adds fails here until it
// is listed, and the stubs refuse every shape the file does not list.
// ---------------------------------------------------------------------------------------------------------

const SITE_DEPLOY_COMMANDS_FILE = "tests/box-dry-run/fixtures/site-deploy-commands.json";

interface SiteDeployInventory {
  scripts: string[];
  builtins: string[];
  stubs: Record<string, { shapes: string[]; flags: string[]; used_at: string[]; effect: string; evidence: Array<{ file: string; line?: number; shape: string }> }>;
  box_userland: Record<string, { shapes: string[]; used_at: string[]; effect: string; evidence: Array<{ file: string; line?: number; shape: string }> }>;
  local: Record<string, string[]>;
}

// The command words of a POSIX shell script, read from its text: the first word of every simple command, in the
// script and in every command substitution. Strings, variable references, arithmetic and comments are removed
// first, so text inside a message is not a command. A scan cannot replace running the script, so the stubs also
// refuse every shape the inventory does not list; this is the check that a new command is listed at all.
function scriptCommandWords(script: string): string[] {
  let text = script.replace(/\\\n\s*/g, " ").split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
  const functions = new Set([...text.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\(\)\s*\{/gm)].map((match) => match[1]!));
  const keywords = new Set(["if", "then", "else", "elif", "fi", "for", "in", "do", "done", "while", "until", "case", "esac", "function", "time"]);
  text = text.replace(/\$\(\([^)]*\)\)/g, " ARITHMETIC ");
  const bodies: string[] = [];
  for (let previous = ""; previous !== text;) {
    previous = text;
    text = text.replace(/\$\(([^()]*)\)/g, (_match, body: string) => { bodies.push(body); return " SUBSTITUTION "; });
  }
  const words = new Set<string>();
  for (const part of [text, ...bodies]) {
    const plain = part
      .replace(/'[^']*'/g, " S ")
      .replace(/"[^"]*"/g, " S ")
      .replace(/\$\{[^}]*\}/g, " V ")
      .replace(/\$[A-Za-z0-9_@*#?]+/g, " V ");
    for (const segment of plain.split(/[;&|(){}`\n]+/)) {
      const tokens = segment.trim().split(/\s+/).filter(Boolean);
      while (tokens.length && (tokens[0] === "!" || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]!) || keywords.has(tokens[0]!))) {
        if (keywords.has(tokens[0]!) && ["for", "case", "in", "function"].includes(tokens[0]!)) { tokens.length = 0; break; }
        tokens.shift();
      }
      const word = tokens[0];
      if (word && /^[a-z][a-z0-9_-]*$/.test(word) && !functions.has(word) && !keywords.has(word)) words.add(word);
    }
  }
  return [...words].sort();
}

test("deploy/site/deploy.sh and finalize-release.sh run only commands the site deploy inventory lists", () => {
  const inventory = JSON.parse(readFileSync(SITE_DEPLOY_COMMANDS_FILE, "utf8")) as SiteDeployInventory;
  const listed = new Set([
    ...inventory.builtins, "break", "continue", "true", "false",
    ...Object.keys(inventory.stubs), ...Object.keys(inventory.box_userland), ...Object.keys(inventory.local),
  ]);
  const scripts = new Map(inventory.scripts.map((file) => [file, readFileSync(file, "utf8")]));
  for (const [file, text] of scripts) {
    // Site-04 runs the scripts of the release checkout, at the release SHA. They are the scripts read here.
    assert.equal(gitShow(SITE_SHA, file), text, `${file} at the lane 8 release SHA differs from the working tree`);
    const unlisted = scriptCommandWords(text).filter((word) => !listed.has(word));
    assert.deepEqual(unlisted, [], `${file} runs a command the site deploy inventory does not list`);
  }
  // The scanner sees what it is meant to see: a command added to the script text is reported.
  assert.deepEqual(scriptCommandWords(`${scripts.get("deploy/site/deploy.sh")!}\ncurl -fsS https://example.invalid/\n`).filter((word) => !listed.has(word)), ["curl"]);
  assert.deepEqual(scriptCommandWords(`${scripts.get("deploy/site/finalize-release.sh")!}\nif true; then aws s3 sync . s3://bucket; fi\n`).filter((word) => !listed.has(word)), ["aws"]);

  // Every cited place names its command, and every cited evidence file and line exists.
  const entries: Array<[string, { used_at: string[]; evidence: Array<{ file: string; line?: number }> }]> = [
    ...Object.entries(inventory.stubs), ...Object.entries(inventory.box_userland),
  ];
  for (const [command, entry] of entries) {
    for (const place of entry.used_at) {
      const [file, line] = place.split(":") as [string, string];
      const source = (scripts.get(file) ?? readFileSync(file, "utf8")).split("\n")[Number(line) - 1] ?? "";
      const word = command === "npm" ? "npm" : command;
      assert.ok(source.includes(word), `${place} does not run ${command}: ${source.trim()}`);
    }
    assert.ok(entry.evidence.length > 0, `${command} cites no evidence`);
    for (const evidence of entry.evidence) {
      assert.equal(existsSync(evidence.file), true, `${command}: evidence file is missing: ${evidence.file}`);
      if (evidence.line) assert.ok(readFileSync(evidence.file, "utf8").split("\n").length >= evidence.line, `${command}: ${evidence.file} has no line ${evidence.line}`);
    }
  }
  // The flags and subcommands the scripts use are the ones the inventory lists for the stubbed commands.
  const deploy = scripts.get("deploy/site/deploy.sh")!;
  const finalize = scripts.get("deploy/site/finalize-release.sh")!;
  const npmSubcommands = new Set([...deploy.matchAll(/run_site_npm\s+"[^"]+"\s+([a-z]+(?: [a-z]+)?)\s*$/gm)].map((match) => match[1]!));
  assert.deepEqual([...npmSubcommands].sort(), [...inventory.stubs.npm!.shapes].sort());
  const rsyncFlags = new Set([...`${deploy}\n${finalize}`.matchAll(/^\s*rsync ((?:-\S+ )+)/gm)].flatMap((match) => match[1]!.trim().split(" ")));
  assert.deepEqual([...rsyncFlags].sort(), [...inventory.stubs.rsync!.flags].sort());
  const sshOptions = new Set([...`${deploy}\n${finalize}`.matchAll(/\bssh (-o \S+)/g)].map((match) => match[1]!));
  assert.deepEqual([...sshOptions], [], "deploy.sh passes no ssh option the stub would need to list");
});

test("the containment profiles compile and carry every denial the dry run's containment names", { skip: MAC_ONLY }, (t) => {
  const fixture = prepareMacFixture();
  try {
    const profiles = [
      ["block", fixture.containment!, fixture.temporary!],
      ["remote", fixture.env.BOX_DRY_RUN_REMOTE_SANDBOX_PROFILE!, fixture.boxRoot!],
    ] as const;
    for (const [name, profile, writable] of profiles) {
      // sandbox-exec compiles a profile before it applies it: 65 is a profile that does not compile; 71 a compiled
      // profile that cannot be applied to this process because it is already sandboxed; 0 is applied.
      assert.equal(profileCompileProblem(profile), undefined, `the ${name} profile does not compile`);
      assert.match(profile, /^\(version 1\)\n\(allow default\)\n/);
      assert.match(profile, /\(deny network\*\)/);
      // Writes: refused everywhere except the named directory, /dev/null and /dev/fd.
      const writes = /\(deny file-write\* \(require-all ([^\n]*)\)\)\n/.exec(profile)?.[1] ?? "";
      assert.ok(writes.includes(`(require-not (subpath ${JSON.stringify(canonicalPath(writable))}))`), `the ${name} profile allows writes in ${writable}`);
      assert.ok(writes.includes('(require-not (literal "/dev/null"))') && writes.includes('(require-not (subpath "/dev/fd"))'));
      // Applications are not started, and nothing under the operator's home is, except the named directories and the node tooling.
      assert.match(profile, /\(deny process-exec \(subpath "\/Applications"\) \(subpath "\/System\/Applications"\)/);
      assert.match(profile, new RegExp(`\\(deny process-exec \\(require-all \\(subpath "${userInfo().homedir}"\\) \\(require-not \\(subpath`));
      // The operator's private state is not read.
      for (const path of [".hermes", ".config/cswarm", "Library/Keychains"]) {
        assert.ok(profile.includes(`(subpath ${JSON.stringify(join(userInfo().homedir, path))})`), `the ${name} profile does not deny reads of ~/${path}`);
      }
      assert.match(profile, /\(deny file-read\* /);
    }
    t.diagnostic(`block profile:\n${fixture.containment}`);
    t.diagnostic(`remote profile:\n${fixture.env.BOX_DRY_RUN_REMOTE_SANDBOX_PROFILE}`);
    // A profile that does not compile is refused with 65, so the check above sees it.
    assert.equal(spawnSync(SANDBOX_EXEC, ["-p", "(version 1)\n(bogus-form)\n", "/usr/bin/true"], { encoding: "utf8" }).status, 65);
  } finally {
    cleanupMacFixture(fixture);
  }
});

test("controls: unknown stub operations fail closed and accepted mutations change readback", { skip: MAC_ONLY }, () => {
  const fixture = prepareMacFixture();
  const run = (command: string, args: string[]) => spawnSync(command, args, {
    encoding: "utf8", env: {
      ...fixture.env,
      BOX_DRY_RUN_EDGE_HEALTH: "healthy",
      BOX_DRY_RUN_EDGE_WORKDIR: PREVIOUS_EDGE + "/deploy/edge-runtime",
      BOX_DRY_RUN_CANDIDATE_EDGE: CANDIDATE_EDGE,
      BOX_DRY_RUN_POSTGRES_IMAGE_ID: POSTGRES_IMAGE_ID,
    },
  });
  try {
    for (const [command, args] of [
      ["systemctl", ["frobnicate", "commonswarm-edge-recycle.timer"]],
      ["docker", ["network", "create", "dry-run-control"]],
      ["ssh", ["--definitely-unknown", "ops@100.115.66.74", "readlink -f /home/commonswarm/edge/current"]],
    ] as const) {
      const rejected = run(command, [...args]);
      assert.equal(rejected.status, 69, `${command} accepted an operation absent from its plan-derived list`);
      assert.match(rejected.stderr, new RegExp(`^unhandled dry-run stub: ${command} `));
    }

    // Every stub that refuses answers an unreviewed flag with exactly 69, so a call that no stub lists cannot pass
    // for a call that one does. (curl, tar, python3 and sleep pass through to the host tool or the network fixture.)
    for (const command of [
      "systemctl", "docker", "psql", "caddy", "ssh", "scp", "sudo", "op", "chown", "deno", "cswarm",
      "browser-harness", "cp", "readlink", "rsync", "npm", "open", "osascript", "launchctl", "security", "pgrep", "ps",
    ]) {
      const rejected = run(command, ["--h10-unreviewed-flag"]);
      assert.equal(rejected.status, 69, `${command} did not refuse an unreviewed flag: ${rejected.stderr}`);
      if (command !== "op") assert.match(rejected.stderr, /unhandled dry-run stub|UNPRODUCED/); // op refuses silently by design: its output is a secret boundary
    }

    assert.equal(run("systemctl", ["stop", "commonswarm-edge-recycle.timer"]).status, 0);
    const stopped = run("systemctl", ["is-active", "commonswarm-edge-recycle.timer"]);
    assert.equal(stopped.status, 3);
    assert.equal(stopped.stdout, "inactive\n");
    assert.equal(run("systemctl", ["start", "commonswarm-edge-recycle.timer"]).status, 0);
    const started = run("systemctl", ["is-active", "commonswarm-edge-recycle.timer"]);
    assert.equal(started.status, 0, started.stderr);
    assert.equal(started.stdout, "active\n");

    const compose = run("docker", ["compose", "-p", "commonswarm-edge", "up", "-d", "edge-runtime"]);
    assert.equal(compose.status, 0, compose.stderr);
    const workdir = run("docker", ["inspect", "--format", "{{ index .Config.Labels \"com.docker.compose.project.working_dir\" }}", "dry-run-edge"]);
    assert.equal(workdir.status, 0, workdir.stderr);
    assert.equal(workdir.stdout, `${CANDIDATE_EDGE}/deploy/edge-runtime\n`);

    // The remote command runs against the fixture box root, so it reads the state the fixture seeded: the
    // measured previous edge release (M5). An ssh call is a Mac process tree and runs contained.
    const ssh = containedCommand(fixture, "ssh", ["-o", "BatchMode=yes", "ops@100.115.66.74", "readlink -f /home/commonswarm/edge/current"], {
      env: fixture.env,
    });
    assert.equal(ssh.status, 0, ssh.stderr);
    assert.equal(ssh.stdout, `${PREVIOUS_EDGE}\n`);
  } finally {
    cleanupMacFixture(fixture);
  }
});

test("cswarm stub enforces workspace and revocation while delivering each note once", { skip: MAC_ONLY }, () => {
  const fixture = prepareMacFixture();
  const workspace = "c2ea0541-f56d-4c73-bf71-56c5405c4934";
  const otherWorkspace = "292be0f9-ca5d-43ed-a6f7-31354fe7fe56";
  const run = (args: string[]) => spawnSync("cswarm", args, { encoding: "utf8", env: fixture.env });
  const create = (name: string, selectedWorkspace = workspace): string => {
    const result = run(["principal", "create", "--workspace-id", selectedWorkspace, "--name", name, "--json"]);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout).principal_id as string;
  };
  const profile = (name: string, principal: string, selectedWorkspace = workspace): string => {
    const path = join(fixture.temporary!, `${name}.json`);
    writeMode(path, JSON.stringify({
      version: 1, url: "https://api.commonswarm.com", anon_key: "dry-run-anon-key",
      workspace_id: selectedWorkspace, principal_id: principal,
      credential_file: join(fixture.temporary!, `${name}-credential.json`),
    }), 0o600);
    return path;
  };
  const identityFailure = /^cswarm: The service did not confirm this agent and workspace\. No messages were shown\. Ask for the correct connection file\.\n$/;
  try {
    const sender = create("sender");
    const receiver = create("receiver");
    const third = create("third");
    const other = create("other", otherWorkspace);
    const senderProfile = profile("sender", sender);
    const receiverProfile = profile("receiver", receiver);
    const thirdProfile = profile("third", third);
    const wrongWorkspaceProfile = profile("wrong-workspace", sender, otherWorkspace);

    const note = run(["note", "one delivery", "--to", receiver, "--profile", senderProfile, "--json"]);
    assert.equal(note.status, 0, note.stderr);
    const signal = JSON.parse(note.stdout).signal.id as string;

    const thirdCheck = run(["check", "--profile", thirdProfile, "--full", "--json"]);
    assert.equal(thirdCheck.status, 0, thirdCheck.stderr);
    assert.deepEqual(JSON.parse(thirdCheck.stdout).messages, []);
    const first = run(["check", "--profile", receiverProfile, "--full", "--json"]);
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(JSON.parse(first.stdout).messages, [{ id: signal, body: "one delivery" }]);
    const second = run(["check", "--profile", receiverProfile, "--full", "--json"]);
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(JSON.parse(second.stdout).messages, []);

    for (const command of [
      ["whoami", "--profile", wrongWorkspaceProfile, "--json"],
      ["check", "--profile", wrongWorkspaceProfile, "--full", "--json"],
      ["note", "wrong workspace", "--to", receiver, "--profile", wrongWorkspaceProfile, "--json"],
      ["note", "cross workspace", "--to", other, "--profile", senderProfile, "--json"],
    ]) {
      const refused = run(command);
      assert.equal(refused.status, 1);
      assert.equal(refused.stdout, "");
      assert.match(refused.stderr, identityFailure);
    }

    const revoke = run(["principal", "revoke", "--workspace-id", workspace, "--principal-id", receiver, "--json"]);
    assert.equal(revoke.status, 0, revoke.stderr);
    const status = run(["status", "--workspace-id", workspace, "--json"]);
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).agents.find((agent: { principal_id: string }) => agent.principal_id === receiver)?.revoked, true);
    for (const command of [
      ["whoami", "--profile", receiverProfile, "--json"],
      ["check", "--profile", receiverProfile, "--full", "--json"],
    ]) {
      const refused = run(command);
      assert.equal(refused.status, 1);
      assert.equal(refused.stdout, "");
      assert.match(refused.stderr, identityFailure);
    }
    assert.equal(run(["principal", "revoke", "--workspace-id", workspace, "--principal-id", sender, "--json"]).status, 0);
    const revokedNote = run(["note", "revoked sender", "--to", third, "--profile", senderProfile, "--json"]);
    assert.equal(revokedNote.status, 1);
    assert.equal(revokedNote.stdout, "");
    assert.match(revokedNote.stderr, identityFailure);
  } finally {
    cleanupMacFixture(fixture);
  }
});

test("scp and op stubs enforce transfer and protected-output boundaries", { skip: MAC_ONLY }, () => {
  const fixture = prepareMacFixture();
  const source = join(fixture.temporary!, "scp-source.txt");
  // The box path the transfer names, and where it lands. On the Mac lane the box's /tmp is a directory in the
  // fixture box root; nothing is written to the host's /tmp. The box lane runs on a guarded runner whose real
  // /tmp is the box's, and it names a per-process file there.
  const boxTarget = `/tmp/commonswarm-scp-control-${process.pid}`;
  const target = process.env.BOX_DRY_RUN_PART === "box" ? boxTarget : join(fixture.boxRoot!, boxTarget);
  const outputDirectory = join(fixture.temporary!, "op-output");
  const output = join(outputDirectory, "site-build.env");
  writeMode(source, "recorded transfer bytes\n", 0o600);
  mkdirSync(outputDirectory, { mode: 0o700 });
  try {
    const acceptedEnv = process.env.BOX_DRY_RUN_PART === "box"
      ? { ...fixture.env, BOX_DRY_RUN_PART: "box" }
      : fixture.env;
    const accepted = spawnSync("scp", [source, `ops@100.115.66.74:${boxTarget}`], {
      encoding: "utf8", env: acceptedEnv,
    });
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(readFileSync(target, "utf8"), "recorded transfer bytes\n");
    const targetStat = lstatSync(target);
    assert.equal(targetStat.isFile(), true);
    assert.equal(targetStat.mode & 0o777, 0o600);
    if (process.env.BOX_DRY_RUN_PART === "box") {
      assert.equal(targetStat.uid, Number.parseInt(spawnSync("/usr/bin/id", ["-u", "ops"], { encoding: "utf8" }).stdout, 10));
      assert.equal(targetStat.gid, Number.parseInt(spawnSync("/usr/bin/id", ["-g", "ops"], { encoding: "utf8" }).stdout, 10));
    }
    const digest = createHash("sha256").update(readFileSync(source)).digest("hex");
    assert.match(readFileSync(fixture.log, "utf8"), new RegExp(
      `^scp-transfer source_sha256=${digest} target_user=ops target_host=100\\.115\\.66\\.74 target_path=${boxTarget}$`, "m",
    ));

    const wrongHost = spawnSync("scp", [source, "ops@192.0.2.1:/tmp/rejected"], {
      encoding: "utf8", env: fixture.env,
    });
    assert.equal(wrongHost.status, 69);
    const missingSource = spawnSync("scp", [join(fixture.temporary!, "missing"), "ops@100.115.66.74:/tmp/rejected"], {
      encoding: "utf8", env: fixture.env,
    });
    assert.equal(missingSource.status, 69);
    const directorySource = spawnSync("scp", [outputDirectory, "ops@100.115.66.74:/tmp/rejected"], {
      encoding: "utf8", env: fixture.env,
    });
    assert.equal(directorySource.status, 69);

    const stdoutRead = spawnSync("op", ["read", "op://Vault/Item/Field"], {
      encoding: "utf8", env: fixture.env,
    });
    assert.equal(stdoutRead.status, 69);
    const otherCommand = spawnSync("op", ["item", "get", "Item"], {
      encoding: "utf8", env: fixture.env,
    });
    assert.equal(otherCommand.status, 69);
    const desktopSession = spawnSync("op", ["read", "op://Vault/Item/Field", "--out-file", output], {
      encoding: "utf8", env: { ...fixture.env, OP_SESSION_DRY_RUN: "desktop-session" },
    });
    assert.equal(desktopSession.status, 69);
    const withoutTokenFile = { ...fixture.env };
    delete withoutTokenFile.BOX_DRY_RUN_OP_SERVICE_ACCOUNT_TOKEN_FILE;
    const missingToken = spawnSync("op", ["read", "op://Vault/Item/Field", "--out-file", output], {
      encoding: "utf8", env: withoutTokenFile,
    });
    assert.equal(missingToken.status, 69);
    const inheritedToken = spawnSync("op", ["read", "op://Vault/Item/Field", "--out-file", output], {
      encoding: "utf8", env: { ...fixture.env, OP_SERVICE_ACCOUNT_TOKEN: "forbidden-direct-token" },
    });
    assert.equal(inheritedToken.status, 69);
    const tokenFile = fixture.env.BOX_DRY_RUN_OP_SERVICE_ACCOUNT_TOKEN_FILE!;
    chmodSync(tokenFile, 0o644);
    const exposedTokenFile = spawnSync("op", ["read", "op://Vault/Item/Field", "--out-file", output], {
      encoding: "utf8", env: fixture.env,
    });
    assert.equal(exposedTokenFile.status, 69);
    chmodSync(tokenFile, 0o600);

    const protectedRead = spawnSync("op", ["read", "op://Vault/Item/Field", "--out-file", output], {
      encoding: "utf8", env: fixture.env,
    });
    assert.equal(protectedRead.status, 0, protectedRead.stderr);
    assert.equal(protectedRead.stdout, "");
    assert.equal(protectedRead.stderr, "");
    const outputStat = lstatSync(output);
    assert.equal(outputStat.isFile(), true);
    assert.equal(outputStat.mode & 0o777, 0o600);
    assert.match(readFileSync(output, "utf8"), /^PUBLIC_SUPABASE_URL=https:\/\/api\.commonswarm\.com$/m);
  } finally {
    if (process.env.BOX_DRY_RUN_PART === "box") rmSync(target, { force: true });
    cleanupMacFixture(fixture);
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
  assert.deepEqual(selected.slice(-7), [
    "hm37a-close-readback", "runbook-13", "runbook-11",
    "runbook-60", "runbook-61", "runbook-12", "hm37a-mac-control-cleanup",
  ]);
  assert.deepEqual(planTail("rollback").slice(0, 2), [
    "runbook-42", "hm37-reserve-schema-rollback",
  ], "the previous edge must be restored before the schema inverse checks it");
});

test("M1 and M6-M15 decisions are encoded in the executable blocks", () => {
  const hm = readFileSync(HM37, "utf8");
  const hm37b = readFileSync(HM37B, "utf8");
  const runbook = readFileSync(RUNBOOK, "utf8");
  const site = readFileSync(SITE, "utf8");
  const install = stepSource(hm37b, "hm37-deno-install");
  const remove = stepSource(hm37b, "hm37-deno-remove");
  const stage = stepSource(hm37b, "hm37-hosted-control-stage");
  const backup = stepSource(hm, "hm37-backup-gate");
  const refusal = blocks(HM37).find((block) => shortStep(block) === "hm37-public-boundaries");
  assert.ok(refusal);
  assert.equal(refusal.marker, "probe");
  assert.match(install, new RegExp(DENO_ZIP_SHA256));
  assert.match(install, /zipfile\.ZipFile/);
  assert.ok(install.indexOf("sha256sum \"$DOWNLOAD_ROOT/deno.zip\"") < install.indexOf("zipfile.ZipFile"));
  assert.match(remove, /sha256sum "\$DENO_PATH"[\s\S]*rm -f -- "\$DENO_PATH"/);
  assert.match(remove, /find "\$DENO_DIR" -xdev -depth -delete/);
  assert.match(stage, /docker inspect --format[\s\S]*\.Config\.Env[\s\S]*MCP_OAUTH_DATABASE_HOST/);
  assert.doesNotMatch(stage, /service\["MCP_OAUTH_DATABASE_HOST"\]/);
  assert.match(stepSource(runbook, "runbook-31"), /pwd\.getpwuid\(env_stat\.st_uid\)\.pw_name in \{'root', 'commonswarm'\}/);
  const session = stepSource(runbook, "runbook-17");
  assert.match(session, new RegExp(PSQL_IMAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(session, /com\.docker\.compose\.service=postgres/);
  assert.match(session, /docker inspect --format '\{\{\.Image\}\}'/);
  assert.doesNotMatch(session, /docker pull/);
  assert.match(backup, /--property=Result --value/);
  assert.doesNotMatch(backup, /data\.get\(["']state["']\)/);
  assert.match(refusal.source, /len\(kinds\) == 6/);
  assert.match(refusal.source, /\{\}, 400, \{"error": "invalid_request"\}/);
  assert.match(refusal.source, /\},\s*403, \{"error": "forbidden"\}/);
  assert.match(refusal.source, /"mint_agent_token"\}\},\s*401, \{"error": "unauthenticated"\}/);
  assert.match(stepSource(runbook, "runbook-33"), /chmod 0600 "\$PROOF_DIR\/edge-probe-start\.txt"/);
  assert.match(site, new RegExp(SITE_BASE_RELEASE));
  assert.match(site, new RegExp(BASE_SHA));
});

test("all M1-M20 values come from the measured artifact, with no second fixture copy", (t) => {
  assert.equal(MEASURED_FACTS.schema, 1);
  assert.equal(MEASURED_FACTS.fact_count, 20);
  assert.deepEqual(MEASURED_FACTS.facts.map((fact) => fact.id),
    Array.from({ length: 20 }, (_unused, index) => `M${index + 1}`));
  assert.equal(new Set(MEASURED_FACTS.facts.map((fact) => fact.id)).size, 20);
  assert.equal(existsSync("tests/box-dry-run/fixtures/box-facts.json"), false);
  for (const fact of MEASURED_FACTS.facts) {
    assert.ok(fact.source_id);
    assert.ok(fact.command.length > 10);
    assert.equal(typeof fact.output, "string");
    assert.equal(typeof fact.exit, "number");
    assert.ok(fact.note.length > 10);
    t.diagnostic(`${fact.id}/${fact.source_id}: exit=${fact.exit}`);
  }
  assert.equal(RELEASE_SHA, basename(PROOF_DIR));
  assert.match(measuredFact("M5").output, new RegExp(`${PROOF_DIR.replaceAll("/", "\\/")} MISSING`));
  assert.match(measuredFact("M5").output, new RegExp(`${PROOF_DIR.replaceAll("/", "\\/")}\\/window\\.env MISSING`));
  assert.equal(measuredFact("M5").output.match(/closed_proof=/g)?.length, 2);
  assert.match(measuredFact("M18").output, /^[a-z_][a-z0-9_-]*:[a-z_][a-z0-9_-]* 600 regular file$/);
  assert.equal(measuredFact("M17").result, "EQUAL");
  assert.equal(measuredFact("M19").result, "MATCH");
  assert.equal(measuredFact("M20").result, "PASS");
});

test("pre-seed allowlist contains only harness variables or cited measured facts", (t) => {
  assert.ok(PRESEED_ALLOWLIST.length > 0);
  const identities = PRESEED_ALLOWLIST.map((item) => `${item.kind}:${item.name}`);
  assert.equal(new Set(identities).size, identities.length, "duplicate pre-seed allowlist entry");
  assert.deepEqual(
    PRESEED_ALLOWLIST.filter((item) => item.kind === "path").map((item) => item.name).sort(),
    PLAN_VISIBLE_PATH_PRESEEDS,
    "fixture path seeds and pre-seed allowlist differ",
  );
  const bySource = new Map<string, number>();
  for (const item of PRESEED_ALLOWLIST) {
    assert.match(item.kind, /^(?:path|env|command-output)$/);
    assert.ok(item.name);
    bySource.set(item.source, (bySource.get(item.source) ?? 0) + 1);
    if (item.source.startsWith("harness:")) {
      assert.equal(item.kind, "env", `${item.source} may allow only a harness environment variable`);
      assert.match(item.source, /^harness:[A-Z][A-Z0-9_]+$/);
      continue;
    }
    assert.match(item.source, /^(?:M(?:[1-9]|1[0-9]|20)|K4-(?:[1-9]|1[0-2]))$/);
    assert.ok(item.evidence, `${item.source}/${item.name} has no evidence needle`);
    const fact = citedFact(item.source);
    const measuredText = JSON.stringify(fact);
    assert.ok(measuredText.includes(item.evidence),
      `${item.source} does not measure allowlisted ${item.kind} ${item.name}: missing ${item.evidence}`);
    if (["K4-10", "K4-11", "K4-12"].includes(item.source)) {
      assert.ok(item.evidence_file, `${item.source}/${item.name} has no evidence file citation`);
      assert.equal(existsSync(item.evidence_file), true, `${item.source}/${item.name} evidence file is missing`);
    }
  }
  for (const [source, count] of [...bySource].sort()) t.diagnostic(`preseed_source=${source} count=${count}`);
});

test("K4 static seeds retain the measured bytes and proof-parent layout", {
  skip: process.env.BOX_DRY_RUN_PART !== "box" || process.platform !== "linux",
}, () => {
  const k4_10 = (citedFact("K4-10") as MeasuredFact & { result?: Record<string, unknown> }).result;
  assert.ok(k4_10 && typeof k4_10 === "object", "K4-10 has no structured result");
  const k4_11 = citedFact("K4-11") as MeasuredFact & { files?: Array<Record<string, unknown>> };
  const k4_12 = citedFact("K4-12") as MeasuredFact & {
    parents?: Array<{ path: string; exists: boolean; directory_count: number; directories: Array<{ name: string }> }>;
  };
  assert.deepEqual(k4_10, {
    path: K4_10_COMPOSE_OVERRIDE_PATH,
    type: "regular file",
    owner: "commonswarm:commonswarm",
    mode: "644",
    size: 648,
    sha256: K4_10_COMPOSE_OVERRIDE_SHA256,
    environment_sections: 0,
    environment_values_present: false,
    environment_key_names: [],
  });
  assert.equal(k4_11.files?.length, 1);
  assert.deepEqual(k4_11.files?.[0], {
    path: K4_11_OAUTH_IMAGE_PATH,
    type: "regular file",
    owner: "root:root",
    mode: "644",
    size: 71,
    sha256: K4_11_OAUTH_IMAGE_SHA256,
    last_byte_od: "   a",
    last_byte: "a",
    newline_terminated: false,
    image_id: K4_11_OAUTH_IMAGE_BYTES,
  });
  assert.deepEqual(k4_12.parents?.map((parent) => parent.path), [K4_12_STACK_PROOF_PARENT, K4_12_EDGE_PROOF_PARENT]);
  assert.equal(k4_12.parents?.[0]?.directory_count, 20);
  assert.deepEqual(k4_12.parents?.[0]?.directories.map((directory) => directory.name).sort(), K4_12_DIRECTORY_NAMES);
  assert.equal(k4_12.parents?.[1]?.exists, false);

  const guard = spawnSync("/bin/bash", [GUARD], { encoding: "utf8", env: process.env });
  assert.equal(guard.status, 0, guard.stderr);
  const fixture = prepareBoxFixture("s5");
  try {
    const composeBytes = readFileSync(K4_10_COMPOSE_OVERRIDE_PATH);
    const composeStat = lstatSync(K4_10_COMPOSE_OVERRIDE_PATH);
    assert.deepEqual(composeBytes, readFileSync(K4_10_COMPOSE_OVERRIDE_EVIDENCE));
    assert.equal(composeStat.isFile(), true);
    assert.equal(composeStat.mode & 0o777, 0o644);
    assert.equal(composeStat.size, 648);
    assert.equal(createHash("sha256").update(composeBytes).digest("hex"), K4_10_COMPOSE_OVERRIDE_SHA256);
    const commonswarmUid = Number.parseInt(spawnSync("/usr/bin/id", ["-u", "commonswarm"], { encoding: "utf8" }).stdout, 10);
    const commonswarmGid = Number.parseInt(spawnSync("/usr/bin/id", ["-g", "commonswarm"], { encoding: "utf8" }).stdout, 10);
    assert.equal(composeStat.uid, commonswarmUid);
    assert.equal(composeStat.gid, commonswarmGid);

    const oauthBytes = readFileSync(K4_11_OAUTH_IMAGE_PATH);
    const oauthStat = lstatSync(K4_11_OAUTH_IMAGE_PATH);
    assert.equal(oauthStat.isFile(), true);
    assert.equal(oauthStat.uid, 0);
    assert.equal(oauthStat.gid, 0);
    assert.equal(oauthStat.mode & 0o777, 0o644);
    assert.equal(oauthStat.size, 71);
    assert.equal(oauthBytes.toString("utf8"), K4_11_OAUTH_IMAGE_BYTES);
    assert.notEqual(oauthBytes.at(-1), 0x0a);
    assert.equal(createHash("sha256").update(oauthBytes).digest("hex"), K4_11_OAUTH_IMAGE_SHA256);

    assert.deepEqual(readdirSync(K4_12_STACK_PROOF_PARENT).sort(), K4_12_DIRECTORY_NAMES);
    for (const name of K4_12_DIRECTORY_NAMES) {
      const stat = lstatSync(join(K4_12_STACK_PROOF_PARENT, name));
      assert.equal(stat.isDirectory(), true, `${name} is not a directory`);
      assert.equal(stat.uid, 0, `${name} owner`);
      assert.equal(stat.gid, 0, `${name} group`);
      assert.equal(stat.mode & 0o777, 0o700, `${name} mode`);
    }
    const oauthCopies = K4_12_DIRECTORY_NAMES
      .map((name) => join(K4_12_STACK_PROOF_PARENT, name, "oauth-image.id"))
      .filter(pathExists);
    assert.deepEqual(oauthCopies, [K4_11_OAUTH_IMAGE_PATH]);
    assert.equal(pathExists(K4_12_EDGE_PROOF_PARENT), false);
  } finally {
    cleanupBoxFixture(fixture);
  }
});

test("prompt-input tables are strict and synthetic values follow their declared formats", (t) => {
  const requiredSchemas = [
    "gate-receipt", "sql-proof-root", "prep-receipt", "hm37-a-close-receipt",
    "human-login-preflight", "human-session", "harness-source", "import-map-source", "op-service-account-token",
  ];
  for (const schemaId of requiredSchemas) assert.ok(promptSchemaContent(schemaId).length > 0, `${schemaId} schema is empty`);
  assert.equal(createHash("sha256").update(promptSchemaContent("harness-source")).digest("hex"),
    "dcef7ccd8c825f4b011a8f1c36b665be7c8c3d84fc086021a862591092ab3013");
  assert.equal(createHash("sha256").update(promptSchemaContent("import-map-source")).digest("hex"),
    "f0902bd4f2fe745b853ad2c9d0b4bbce7364ae94b2f70504fe13129b7fa7411b");
  const plans = [PREP, HM37, HM37B, RUNBOOK, SITE, TEMPLATE];
  const declared = plans.flatMap(promptInputs);
  for (const input of declared) {
    if (input.format.startsWith("abs-file:")) promptSchemaContent(input.format.slice("abs-file:".length));
    const pinned = pinnedPromptValue(input);
    if (pinned !== undefined) {
      const temporary = mkdtempSync(join(tmpdir(), "commonswarm-prompt-pin-"));
      try {
        assert.equal(syntheticPromptValue(input, temporary), pinned,
          `${input.plan}: ${input.name} synthetic value does not honor its plan-pinned literal`);
      } finally {
        removeOwnedTemporary(temporary, "commonswarm-prompt-pin-");
      }
      t.diagnostic(`plan_pinned_prompt=${input.plan}:${input.name}`);
    }
  }
  t.diagnostic(`declared_prompt_inputs=${declared.length}`);

  const line = (name: string, format: string): string => JSON.stringify({
    name, format, supplier: "fixture supplier", meaning: "fixture meaning",
  });
  const valid = promptInputsFromMarkdown("synthetic.md", [
    "```prompt-inputs",
    line("LITERAL", "literal:exact"), line("SHA", "sha40"), line("ID", "uuid"),
    line("COUNT", "decimal-positive"), line("CHOICE", "enum:first|second"), line("WHEN", "iso-utc"),
    line("SHAS", "list:sha40"), line("DIRECTORY", "abs-dir"), line("RECEIPT", "abs-file:gate-receipt"),
    "```", "",
  ].join("\n"));
  assert.equal(valid.length, 9);
  const temporary = mkdtempSync(join(tmpdir(), "commonswarm-prompt-format-"));
  try {
    const fixtureInputs = valid.map((input) => ({ ...input, plan: TEMPLATE }));
    const environment = syntheticPromptEnvironment(temporary, fixtureInputs);
    assert.equal(environment.LITERAL, "exact");
    assert.match(environment.SHA!, /^[0-9a-f]{40}$/);
    assert.match(environment.ID!, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(environment.COUNT, "1");
    assert.equal(environment.CHOICE, "first");
    assert.equal(environment.WHEN, "2000-01-01T00:00:00Z");
    assert.equal(environment.SHAS!.split("\n").length, 2);
    assert.equal(lstatSync(environment.DIRECTORY!).mode & 0o777, 0o700);
    assert.equal(lstatSync(environment.RECEIPT!).mode & 0o777, 0o600);
    assert.equal(readFileSync(environment.RECEIPT!, "utf8"), promptSchemaContent("gate-receipt"));
  } finally {
    removeOwnedTemporary(temporary, "commonswarm-prompt-format-");
  }

  assert.deepEqual(promptInputsFromMarkdown("none.md", "# no table\n"), []);
  assert.throws(() => promptInputsFromMarkdown("duplicate.md", `\`\`\`prompt-inputs\n${line("DUP", "sha40")}\n${line("DUP", "uuid")}\n\`\`\`\n`),
    /duplicate prompt input name/);
  assert.throws(() => promptInputsFromMarkdown("adapter.md", `\`\`\`prompt-inputs\n${line("BOX_DRY_RUN_ESCAPE", "sha40")}\n\`\`\`\n`),
    /cannot declare a harness adapter variable/);
  assert.throws(() => promptInputsFromMarkdown("unknown.md", `\`\`\`prompt-inputs\n${line("BAD", "path")}\n\`\`\`\n`),
    /unsupported prompt format/);
  assert.throws(() => promptInputsFromMarkdown("malformed.md", "```prompt-inputs\n{not json}\n```\n"),
    /malformed prompt-inputs JSON/);
  assert.throws(() => promptInputsFromMarkdown("twice.md", "```prompt-inputs\n```\n```prompt-inputs\n```\n"),
    /expected at most one prompt-inputs block/);
});

test("block shells use an explicit empty-base environment and plan code cannot read adapter variables", { skip: MAC_ONLY }, () => {
  const source = readFileSync("tests/box-dry-run.test.ts", "utf8");
  assert.doesNotMatch(source, /\.\.\.process\.env/);
  for (const block of SCOPED.flatMap(blocks)) {
    assert.doesNotMatch(block.source, /\bBOX_DRY_RUN_[A-Z0-9_]+\b/,
      `${block.file}:${block.line} [${block.step}] reads a harness adapter variable`);
  }
  for (const fixture of [prepareMacFixture()]) {
    try {
      assertChildEnvironmentAllowed(fixture.env);
    } finally {
      cleanupMacFixture(fixture);
    }
  }
});

// The outcome lines the plans print themselves (`BOX_EGRESS=PASS`, `PIN=PASS`, `close=PASS`, and any a later edit
// adds) are read from the plan text. A stub that contains one is answering for a block, so the list is derived and
// never typed.
function planOutcomeMarkers(): string[] {
  const markers = new Set<string>();
  for (const block of SCOPED.flatMap(blocks)) {
    for (const match of block.source.matchAll(/\b([A-Za-z][A-Za-z0-9_]*=(?:PASS|FAIL))\b/g)) markers.add(match[1]!);
  }
  return [...markers].sort();
}

function outcomeMarkersIn(text: string): string[] {
  return planOutcomeMarkers().filter((marker) => text.includes(marker));
}

test("stubs do not return synthetic whole-step success", () => {
  const prelude = readFileSync("tests/box-dry-run/prelude.sh", "utf8");
  const dispatch = readFileSync("tests/box-dry-run/stubs/dispatch.sh", "utf8");
  const userland = readFileSync("tests/box-dry-run/stubs/box-userland.py", "utf8");
  const sitecustomize = readFileSync("tests/box-dry-run/python/sitecustomize.py", "utf8");
  assert.doesNotMatch(prelude, /dry-run (?:python|node) PASS/);
  assert.match(prelude, /python3\(\)[\s\S]*?command python3 "\$@"/);
  assert.match(prelude, /node\(\)[\s\S]*?command node "\$@"/);
  assert.doesNotMatch(dispatch, /dry-run [A-Za-z0-9_-]+ PASS/);
  assert.doesNotMatch(prelude, /case "\$\{BOX_DRY_RUN_STEP/);
  assert.doesNotMatch(dispatch, /case "\$\{BOX_DRY_RUN_STEP/);
  assert.doesNotMatch(dispatch, /if \[ "\$\{BOX_DRY_RUN_STEP/);
  assert.doesNotMatch(dispatch, /BOX_DRY_RUN_CANDIDATE_EDGE_WORKDIR/);

  // No stub prints a line a plan block prints. The markers are the ones the current plan text prints.
  const markers = planOutcomeMarkers();
  assert.ok(markers.length >= 5, `the plan text prints too few outcome markers to check against: ${markers.join(", ")}`);
  for (const [name, text] of [["prelude.sh", prelude], ["dispatch.sh", dispatch], ["box-userland.py", userland], ["sitecustomize.py", sitecustomize]] as const) {
    assert.deepEqual(outcomeMarkersIn(text), [], `${name} contains an outcome line a plan block prints`);
  }
  // The detector sees what it is meant to see: the same scan finds a marker in a stub that prints one.
  assert.deepEqual(outcomeMarkersIn("printf '%s\\n' 'BOX_EGRESS=PASS user_agent=x'"), ["BOX_EGRESS=PASS"]);

  // A stub that answers for a whole remote script is a stub that matches the script's text. The ssh stub runs the
  // remote command in a shell against the fixture box root; it never branches on what the script says.
  assert.doesNotMatch(dispatch, /remote_input/);
  assert.doesNotMatch(dispatch, /case "\$remote_command" in\s*\*['"]/);
  // The browser stub does not emulate a browser: no program runs, and nothing in the stubs evaluates page code.
  const browserBranch = /\n  browser-harness\)([\s\S]*?)\n    ;;/.exec(dispatch)?.[1] ?? "";
  assert.match(browserBranch, /unhandled_stub/);
  assert.doesNotMatch(browserBranch, /python|node|exec |js\(|cdp\(/);
  assert.doesNotMatch(dispatch, /def (?:js|cdp)\(/);
});

test("current plans report only undeclared operator inputs as UNPRODUCED", (t) => {
  const report = unproducedReport();
  assert.equal(new Set(report).size, report.length);
  for (const item of [PREP, HM37, HM37B, RUNBOOK, SITE].flatMap(promptInputs)) {
    assert.ok(!report.some((line) => line.includes(`UNPRODUCED ${item.name} read by `)),
      `declared prompt input was reported as unproduced: ${item.plan}:${item.name}`);
  }
  for (const line of report) {
    assert.match(line, /^UNPRODUCED .+ read by .+ at .+:\d+ \[run=.+ plan=(?:prep|hm37|hm37b|runbook|site)\]$/);
    t.diagnostic(line);
  }
});

test("controls: pre-revision plans still report their audited UNPRODUCED items", () => {
  const revision = "3d06a196";
  const oldHmMarkdown = gitShow(revision, HM37);
  const oldRunbookMarkdown = gitShow(revision, RUNBOOK);
  const oldSiteMarkdown = gitShow(revision, SITE);
  const oldHmBlocks = blocksFromMarkdown(HM37, oldHmMarkdown);
  const oldRunbookBlocks = blocksFromMarkdown(RUNBOOK, oldRunbookMarkdown);
  const orderMatch = /The successful path uses this exact whole-block order[\s\S]*?^```text\n([\s\S]*?)^```$/m.exec(oldHmMarkdown);
  assert.ok(orderMatch, "pre-revision Window A has no declared order");
  const byStep = new Map([...oldHmBlocks, ...oldRunbookBlocks].map((block) => [shortStep(block), block]));
  const oldWindow = orderMatch[1]!.trim().split(/\s+/).map((step) => {
    const block = byStep.get(step);
    assert.ok(block, `pre-revision order names missing step ${step}`);
    return block;
  });
  const report = unproducedReport([
    { label: "pre-revision/window-a", blocks: oldWindow, state: "s5" },
    { label: "pre-revision/lane-8", blocks: blocksFromMarkdown(SITE, oldSiteMarkdown), state: "s5" },
  ]);
  for (const audited of [
    "GO.txt", "hm37-open-ack-control.ts", "human-session.json", "gate-evidence.txt",
    "$EVIDENCE_DIR/*.sql", "exact-SHA clean release checkout", "site/.env",
  ]) {
    assert.ok(report.some((line) => line.includes(audited)), `audited item disappeared: ${audited}`);
  }
});

test("controls: a window A copy without its GO producer reports GO.txt as UNPRODUCED", () => {
  const withoutGo = resolveSteps("window-a/no-go", selectedHmSequence())
    .filter((block) => shortStep(block) !== "hm37a-go-record");
  const report = discoverUnproducedReads(withoutGo);
  assert.ok(report.some((read) => read.what.endsWith("GO.txt")),
    `GO.txt was not reported:\n${report.map((read) => read.what).join("\n")}`);
});

test("controls: a measured basename under a different directory remains UNPRODUCED", () => {
  const unmeasured = "/home/commonswarm/edge/releases/not-the-measured-release";
  const report = discoverUnproducedReads([{
    file: HM37, step: "synthetic-unmeasured-path",
    marker: "yes", host: "box /bin/bash 5.2 as root", line: 1,
    source: `OTHER_EDGE='${unmeasured}'\ntest -f "$OTHER_EDGE/deploy/edge-runtime/compose.override.yaml"\n`,
  }]);
  assert.ok(report.some((read) => read.what === "compose.override.yaml"),
    `unmeasured compose override was accepted:\n${report.map((read) => read.what).join("\n")}`);
});

test("controls: runbook-03 with a literal <sha> window.env path fails the runbook-03 check", () => {
  const current = readFileSync(RUNBOOK, "utf8");
  // The named form of runbook-03, whichever form the plan text is in now: the window file and the SHA comparison
  // both take the named release SHA.
  const named = current
    .replace(/^( *)\. \/home\/commonswarm\/stack\/release-proofs\/<sha>\/window\.env$/m, (_line, indent: string) => [
      `${indent}: "\${RELEASE_SHA:?named release SHA required}"`,
      `${indent}. "/home/commonswarm/stack/release-proofs/\${RELEASE_SHA}/window.env"`,
    ].join("\n"))
    .replace(/^( *)test "\$SHA" = '<sha>'$/m, (_line, indent: string) => `${indent}test "$SHA" = "$RELEASE_SHA"`);
  assert.doesNotThrow(() => assertRunbook03NamedShaWindowPath(named));

  // Three regressions, each one a literal <sha> in runbook-03's executable text. The check must reject every
  // one; it used to reject only the first.
  const windowLine = /^( *)\. "\/home\/commonswarm\/stack\/release-proofs\/\$\{RELEASE_SHA\}\/window\.env"$/m;
  const compareLine = /^( *)test "\$SHA" = "\$RELEASE_SHA"$/m;
  const strictLine = /^( *)set -euo pipefail$/m;
  const runbook03 = stepSource(named, "runbook-03");
  for (const [pattern, name] of [[windowLine, "window file"], [compareLine, "SHA comparison"], [strictLine, "options line"]] as const) {
    assert.match(runbook03, pattern, `the named runbook-03 has the ${name} line the control mutates`);
  }
  // Each mutation is applied inside runbook-03 only: the same line can appear in another block.
  const inRunbook03 = (pattern: RegExp, replacement: string): string => named.replace(runbook03, () => runbook03.replace(pattern, replacement));
  const regressions = [
    inRunbook03(windowLine, "$1. /home/commonswarm/stack/release-proofs/<sha>/window.env"),
    inRunbook03(compareLine, "$1test \"$SHA\" = '<sha>'"),
    inRunbook03(strictLine, "$1set -euo pipefail\n$1# release directory: <sha>"),
  ];
  for (const regressed of regressions) {
    assert.notEqual(regressed, named, "a regression must change the plan text");
    assert.throws(() => assertRunbook03NamedShaWindowPath(regressed), /<sha>|release-proofs/);
  }
  // The SHA comparison and the comment are caught only by the any-placeholder check.
  for (const regressed of regressions.slice(1)) {
    assert.throws(() => assertRunbook03NamedShaWindowPath(regressed), /literal <sha> placeholder/);
  }
});

// Boundary controls supply the opening receipt rather than replay an opening guard unrelated to the
// receipt/symlink under test. Full plan runs still execute that guard against all measured proof directories.
// Shapes: docs/evidence/2026-09-28-box-hm37/BOX-WINDOW.md:502-507 and
// docs/evidence/2026-09-29-box-hm37b/BOX-WINDOW.md:141-144. Values are named harness inputs.
function seedControlOpenReceipt(fixture: Fixture, window: "a" | "b", extra: Record<string, string> = {}): void {
  const windowEnd = new Date(Date.parse(WINDOW_START) + 4 * 60 * 60 * 1000).toISOString().replace(".000Z", "Z");
  const fields = {
    SHA: fixture.env.RELEASE_SHA!, WINDOW_START_UTC: WINDOW_START, WINDOW_END_UTC: windowEnd,
    WINDOW_ID, WINDOW_PRINCIPAL_SUFFIX: WINDOW_ID.slice(9, 15),
    BACKUP_MAX_AGE_SECONDS: fixture.env.BACKUP_MAX_AGE_SECONDS!, ...extra,
  };
  for (const [name, value] of Object.entries(fields)) assert.ok(value, `control opening receipt is missing ${name}`);
  const prefix = window === "a" ? "commonswarm-release-open" : "commonswarm-hm37b-open";
  const receipt = join(fixture.macTmp!, `${prefix}-${fixture.env.RELEASE_SHA}.env`);
  writeMode(receipt, Object.entries(fields).map(([name, value]) =>
    `${name}='${value.replaceAll("'", "'\\''")}'\n`).join(""));
}

test("controls: a gate receipt without its PASS lines fails runbook-02", { skip: MAC_ONLY }, () => {
  const plan = resolveSteps("window-a/pass", windowAPaths().get("pass")!);
  const index = plan.findIndex((block) => shortStep(block) === "runbook-02");
  assert.ok(index > 0, "window A has no runbook-02 preflight");
  const receiptEvidence = readFileSync("docs/evidence/2026-09-29-release-eb2a87ac4b5a/gate-evidence.txt", "utf8").split("\n");
  // Real receipt shape and gates: gate-evidence.txt:1,3-4. Strip only those gates; retain the correct SHA.
  for (const missingPassLines of [true, false]) {
    const fixture = prepareMacFixture(plan);
    try {
      const receipt = fixture.env.GATE_RECEIPT_PATH!;
      const content = readFileSync(receipt, "utf8");
      assert.ok(content.includes(`SHA=${fixture.env.RELEASE_SHA}\n`));
      for (const gate of receiptEvidence.slice(2, 4)) assert.ok(content.includes(`${gate}\n`));
      if (missingPassLines) writeFileSync(receipt, content.split("\n")
        .filter((line) => !receiptEvidence.slice(2, 4).includes(line)).join("\n"));
      seedControlOpenReceipt(fixture, "a", {
        RELEASE_REPO: fixture.env.RELEASE_REPO!,
        EVIDENCE_ROOT: join(fixture.home, ".commonswarm-release-evidence"),
      });
      // Run the actual checkout and ingest producers. The full-plan test separately owns the open guard.
      const earlier = executePlanUntilFailure([
        planBlock(HM37, "hm37a-source-checkout"), planBlock(HM37, "hm37a-gate-and-proof-ingest"),
      ], fixture, "mac");
      assert.equal(earlier.some(({ execution }) => execution.result === "failed"), false,
        `receipt control did not reach runbook-02:\n${earlier.map(({ execution }) => execution.stderr).join("\n")}`);
      const execution = executeWholeBlock(plan[index]!, fixture);
      assert.equal(execution.result, missingPassLines ? "failed" : "passed", execution.stderr);
      if (missingPassLines) {
        assert.equal(execution.status, 1, execution.stderr);
        assert.match(execution.stderr, /command-core gate: FAIL/);
        assert.match(execution.stdout, /gate evidence SHA: PASS/);
        assert.equal(pathExists(join(fixture.home, ".commonswarm-release-window.env")), false);
      } else {
        assert.match(execution.stdout, /command-core gate: PASS/);
        assert.match(execution.stdout, /edge check gate: PASS/);
      }
    } finally {
      cleanupMacFixture(fixture);
    }
  }
});

test("controls: window B fails when window A's candidate edge is not live", { skip: MAC_ONLY }, () => {
  const plan = resolveSteps("window-b/pass", windowBPaths().get("pass")!);
  const index = plan.findIndex((block) => shortStep(block) === "hm37b-box-open");
  assert.ok(index > 0, "window B has no box-open step");
  for (const state of ["previous-edge", "candidate-edge", "public-enabled"]) {
    const previousStillLive = state === "previous-edge";
    const fixture = prepareMacFixture(plan, { afterWindowA: true });
    try {
      const current = join(fixture.boxRoot!, "/home/commonswarm/edge/current");
      assert.equal(readlinkSync(current), join(fixture.boxRoot!, windowAFinalEdge()));
      const receipt = readFileSync(fixture.env.HM37_A_CLOSE_RECEIPT!, "utf8");
      assert.ok(receipt.includes(`release_sha=${basename(windowAFinalEdge())}\n`));
      assert.match(receipt, /^edge_live=true$/m);
      if (previousStillLive) {
        unlinkSync(current);
        symlinkSync(join(fixture.boxRoot!, PREVIOUS_EDGE), current);
      }
      if (state === "public-enabled") fixture.env.BOX_DRY_RUN_EDGE_PUBLIC_ENABLED = "1";
      seedControlOpenReceipt(fixture, "b");
      const execution = executeWholeBlock(plan[index]!, fixture);
      assert.equal(execution.result, state === "candidate-edge" ? "passed" : "failed", execution.stderr);
      if (previousStillLive) {
        assert.equal(execution.status, 1, execution.stderr);
        assert.match(execution.stderr, /the box script exited 1[\s\S]*readlink -f \/home\/commonswarm\/edge\/current/);
      } else if (state === "public-enabled") {
        assert.equal(execution.status, 1, execution.stderr);
        assert.match(execution.stderr, /the box script exited 1[\s\S]*Deno\.env\.get\("SWARM_MCP_PUBLIC_ENABLED"\)/);
      } else {
        assert.equal(readlinkSync(current), join(fixture.boxRoot!, windowAFinalEdge()));
      }
    } finally {
      cleanupMacFixture(fixture);
    }
  }
});

// The five files a copy-back reads from the box's proof directory. Three are products of box blocks and are seeded
// from their committed execution evidence (fixtures/box-block-products.json). The other two are staged from the Mac
// by earlier blocks; their bytes come from the same committed evidence directory.
const COPYBACK_MEMBERS = [
  "hm37-worker-boundary.txt", "hm37-hosted-control-inputs.txt", "hm37-hosted-check-control.json",
  "hm37-revocation-readback.json", "hm37-close-readback.txt",
];
const COPYBACK_EVIDENCE_DIRECTORY = "docs/evidence/2026-09-29-release-eb2a87ac4b5a";

function seedCopybackProofDirectory(fixture: Fixture): string {
  const proof = join(fixture.boxRoot!, "home/commonswarm/stack/release-proofs", RELEASE_SHA);
  mkdirSync(proof, { recursive: true, mode: 0o700 });
  for (const member of COPYBACK_MEMBERS) {
    const evidence = join(COPYBACK_EVIDENCE_DIRECTORY, member);
    assert.equal(existsSync(evidence), true, `copy-back evidence is missing: ${evidence}`);
    copyFileSync(evidence, join(proof, member));
    chmodSync(join(proof, member), 0o600);
  }
  return proof;
}

test("controls: runbook-04's inventory runs the real inventory.ts and fails on an unknown function name", { skip: MAC_ONLY }, (t) => {
  const sequence = resolveSteps("inventory control", windowAPaths().get("pass")!);
  const index = sequence.findIndex((block) => shortStep(block) === "runbook-04");
  assert.ok(index >= 0);
  const block = sequence[index]!;
  const fixture = prepareMacFixture(sequence, { state: "s1" });
  try {
    const earlier = executePlanUntilFailure(sequence.slice(0, index), fixture, "mac");
    assert.equal(earlier.find(({ execution }) => execution.result === "failed"), undefined,
      earlier.map(({ execution }) => `${execution.step}: ${execution.stderr}`).join("\n"));
    const positive = executeWholeBlock(block, fixture);
    if (!fixture.inventoryDeno) {
      assert.equal(positive.status, 69);
      assert.match(positive.stderr, /deno unavailable/);
      t.skip("deno unavailable: the real inventory control cannot run; the block failed closed");
      return;
    }
    assert.equal(positive.result, "passed", positive.stderr);
    assert.equal(createHash("sha256").update(readFileSync(fixture.inventoryDeno.path)).digest("hex"), fixture.inventoryDeno.digest);
    t.diagnostic(`inventory runtime pinned: ${fixture.inventoryDeno.version.split("\n")[0]} sha256=${fixture.inventoryDeno.digest}`);
    const negative = executeWholeBlock(mutatedBlock(block, [[
      "const selected = Deno.args[1].split(/\\s+/).filter(Boolean);",
      "const selected = [...Deno.args[1].split(/\\s+/).filter(Boolean), 'h14-unknown-function'];",
    ]]), fixture);
    assert.equal(negative.result, "failed");
    assert.match(negative.stderr, /unknown function: h14-unknown-function/);
    assert.doesNotMatch(negative.stderr, /UNPRODUCED embedded Deno|unhandled dry-run stub/);
    // A program mutation proves the stub is not supplying the inventory's JSON itself.
    const program = executeWholeBlock(mutatedBlock(block, [[
      "console.log(JSON.stringify({ required: required.sort(), optional }, null, 2));",
      "throw new Error('h14-real-inventory-executed');",
    ]]), fixture);
    assert.match(program.stderr, /h14-real-inventory-executed/);
    assert.equal(program.result, "failed");
    renameSync(fixture.inventoryDeno.path, `${fixture.inventoryDeno.path}.hidden`);
    const unavailable = executeWholeBlock(block, fixture);
    assert.equal(unavailable.status, 69);
    assert.match(unavailable.stderr, /deno unavailable/);
  } finally {
    cleanupMacFixture(fixture);
  }
});

test("controls: window B abort copy-back fails when an abort-path producer did not run", { skip: MAC_ONLY }, () => {
  const sequence = resolveSteps("abort producer control", windowBPaths().get("abort")!);
  const copyback = sequence.findIndex((block) => shortStep(block) === "hm37b-copyback");
  assert.ok(copyback >= 0);
  for (const omit of [false, true]) {
    const fixture = prepareMacFixture(sequence, { afterWindowA: true });
    try {
      const path = sequence.slice(0, copyback + 1).filter((block) =>
        !omit || shortStep(block) !== "hm37-hosted-open-ack-control");
      const records = executePlanUntilFailure(path, fixture, "mac");
      const failed = records.find(({ execution }) => execution.result === "failed");
      const recovery = records.find(({ execution }) => execution.step === "hm37-hosted-control-cleanup-only");
      assert.ok(recovery, records.map(({ execution }) => `${execution.step}: ${execution.stderr}`).join("\n"));
      const recoveryReport = notExecutedLine(recovery.block, recovery.execution);
      assert.match(recoveryReport, /Seeded from committed evidence: nothing\./);
      assert.match(recoveryReport, /Plan-documented output: hm37-hosted-cleanup-recovery\.json/);
      assert.ok(records.some(({ execution }) => execution.step === "hm37b-failure-dispatch" && execution.result === "passed"),
        records.map(({ execution }) => `${execution.step}: ${execution.stderr}`).join("\n"));
      const proof = join(fixture.boxRoot!, PROOF_DIR);
      assert.match(readFileSync(join(proof, "hm37b-failure-action.txt"), "utf8"), /^action=cleanup-only$/m);
      assert.ok(pathExists(join(proof, "hm37-hosted-cleanup-recovery.json")));
      const action = join(proof, "hm37b-failure-action.txt");
      const actionBefore = readFileSync(action, "utf8");
      const metadata = containedCommand(fixture, "/usr/bin/python3", [USERLAND, "stat", "-c", "%U:%G:%a", action], {
        env: fixture.env,
      });
      assert.equal(metadata.status, 0, metadata.stderr);
      assert.equal(metadata.stdout.trim(), "root:root:600", "the actual dispatcher product retains box ownership and mode");
      assert.equal(readFileSync(action, "utf8"), actionBefore, "metadata readback cannot replace the produced receipt");
      if (omit) {
        assert.equal(failed?.execution.step, "hm37b-copyback", failed?.execution.stderr);
        assert.match(failed!.execution.stderr, /the box script exited 1[\s\S]*test -f "\$PROOF_DIR\/\$FILE"/);
        assert.equal(pathExists(join(proof, "hm37-hosted-check-control.json")), false);
      } else {
        assert.equal(failed, undefined, failed?.execution.stderr);
        const copied = records.find(({ execution }) => execution.step === "hm37b-copyback");
        assert.equal(copied?.execution.result, "passed");
        assert.ok(pathExists(join(proof, "hm37-hosted-check-control.json")));
        // Recovery and dispatcher receipts are produced but the plan's exact copy-back list omits them.
        const dirs = readdirSync(join(fixture.cwd, "docs/evidence")).filter((name) => name.includes(`-release-${RELEASE_SHA.slice(0, 12)}-`));
        assert.equal(dirs.length, 1);
        assert.deepEqual(readdirSync(join(fixture.cwd, "docs/evidence", dirs[0]!)).sort(), [...COPYBACK_MEMBERS, "hm37b-copyback.sha256"].sort());
      }
    } finally {
      cleanupMacFixture(fixture);
    }
  }
});

test("controls: a Mac transfer fails when the box block that creates its target directory did not run", { skip: MAC_ONLY }, () => {
  const sequence = resolveSteps("window-a/transfer-control", selectedHmSequence());
  const transfer = sequence.findIndex((block) => shortStep(block) === "hm37a-resolved-input-transfer");
  assert.ok(transfer >= 0);
  const prefix = sequence.slice(0, transfer + 1);
  const producer = "1-apply-release-directories";
  assert.ok(prefix.some((block) => shortStep(block) === producer));
  for (const omit of [true, false]) {
    const fixture = prepareMacFixture(prefix, { state: "s1" });
    try {
      const target = join(fixture.boxRoot!, PROOF_DIR);
      assert.equal(pathExists(target), false, "the target directory must not be preseeded");
      const records = executePlanUntilFailure(omit ? prefix.filter((block) => shortStep(block) !== producer) : prefix, fixture, "mac");
      const failed = records.find(({ execution }) => execution.result === "failed");
      if (omit) {
        assert.equal(failed?.execution.step, "hm37a-resolved-input-transfer", failed?.execution.stderr);
        assert.ok(failed);
        assert.equal(failed.execution.status, 1, failed.execution.stderr);
        assert.match(failed.execution.stderr, /the box script exited 1[\s\S]*install -m 0600 -o root -g root/);
        assert.equal(pathExists(target), false);
      } else {
        assert.equal(failed, undefined, failed?.execution.stderr);
        assert.equal(records.at(-1)?.execution.result, "passed");
        const evidence = containedCommand(fixture, "/bin/bash", ["-c",
          'set -euo pipefail; . "$HOME/.commonswarm-release-window.env"; printf "%s" "$EVIDENCE_DIR"'], { env: fixture.env });
        assert.equal(evidence.status, 0, evidence.stderr);
        for (const name of ["item-resolved-inputs.env", "item-copy-back-files.list"]) {
          const copied = join(target, name);
          assert.equal(readFileSync(copied, "utf8"), readFileSync(join(evidence.stdout, name), "utf8"));
          assert.equal(lstatSync(copied).mode & 0o777, 0o600);
          assert.equal(readBoxOwners(fixture.boxRoot!)[relative(fixture.boxRoot!, copied)], "root:root");
        }
        assert.equal(lstatSync(target).mode & 0o777, 0o700);
        assert.equal(readBoxOwners(fixture.boxRoot!)[relative(fixture.boxRoot!, target)], "root:root");
      }
    } finally {
      cleanupMacFixture(fixture);
    }
  }
});

test("controls: fixture node runs the real database service-file generator without a host PATH", () => {
  const temporary = mkdtempSync(join(realpathSync(tmpdir()), "commonswarm-box-dry-run-command-"));
  const bin = join(temporary, "bin");
  const boxRoot = join(temporary, "box");
  const target = join(boxRoot, "etc/commonswarm-release/target.env");
  const service = join(temporary, "service.conf");
  const pass = join(temporary, "pass");
  const script = resolve("deploy/supabase-stack/migrate/make-pg-service.mjs");
  const releaseScript = join(boxRoot, CANDIDATE_STACK, "deploy/supabase-stack/migrate/make-pg-service.mjs");
  makeStubBin(bin);
  const env = explicitEnvironment({ PATH: bin, BOX_DRY_RUN_STUB_LOG: join(temporary, "stub.log"),
    PG_SERVICE_OUTPUT: service, PG_PASS_OUTPUT: pass, COMMONSWARM_MIGRATION_ENV_FILE: target });
  try {
    // Exercise the target.env that the fixture actually supplies to runbook-17. The generator only
    // formats files; no connection is made and this control cannot establish database identity.
    seedMacBoxRoot(boxRoot, "s2");
    const positive = spawnSync(process.execPath, [script], { encoding: "utf8", env });
    assert.equal(positive.status, 0, positive.stderr);
    const expectedService = readFileSync(service, "utf8");
    const expectedPass = readFileSync(pass, "utf8");
    unlinkSync(service);
    unlinkSync(pass);
    // B starts after A's immutable release exists. Exercise that fixture's actual release script,
    // not the current checkout's copy, which hid the missing script at runbook-17 in CI.
    const run = () => spawnSync("/bin/bash", ["-c", 'source "$1"; node "$2"', "node-control", PRELUDE, releaseScript],
      { encoding: "utf8", env });
    const accepted = run();
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(readFileSync(service, "utf8"), expectedService);
    assert.equal(readFileSync(pass, "utf8"), expectedPass);
    assert.equal(lstatSync(service).mode & 0o777, 0o600);
    assert.equal(lstatSync(pass).mode & 0o777, 0o600);
    // The same runtime must propagate the real generator's refusal, not substitute a passing result.
    writeMode(target, "TARGET_DATABASE_URL=postgresql://fixture:fixture@unapproved.invalid/postgres\n");
    const refused = run();
    assert.equal(refused.status, 1, refused.stderr);
    assert.match(refused.stderr, /TARGET_DATABASE_URL host is not an allowed CommonSwarm target/);
    assert.equal(readFileSync(service, "utf8"), expectedService);
    assert.equal(readFileSync(pass, "utf8"), expectedPass);
  } finally {
    removeOwnedTemporary(temporary, "commonswarm-box-dry-run-command-");
  }
});

test("controls: runbook-16 accepts the database-helper command shape without fabricating identity", (t) => {
  const temporary = mkdtempSync(join(realpathSync(tmpdir()), "commonswarm-box-dry-run-command-"));
  const bin = join(temporary, "bin");
  const log = join(temporary, "stub.log");
  makeStubBin(bin);
  try {
    const service = join(temporary, "service.env");
    const target = join(temporary, "target.env");
    writeMode(service, "# synthetic service file\n");
    writeMode(target, "TARGET_DATABASE_URL=postgresql://fixture:fixture@db.commonswarm.internal/postgres\n");
    const env = explicitEnvironment({ PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, TMPDIR: temporary,
      COMMONSWARM_ENV_FILE: service, COMMONSWARM_MIGRATION_ENV_FILE: target,
      BOX_DRY_RUN_STUB_LOG: log });
    const run = spawnSync("/bin/bash", [resolve("deploy/supabase-stack/migrate/run-db-tool.sh"),
      "assert-database-identity.sh", join(temporary, "database"), "target"], { encoding: "utf8", env });
    assert.equal(run.status, 69, run.stderr);
    assert.match(run.stderr, /^UNPRODUCED database observation$/m);
    assert.doesNotMatch(run.stderr, /unhandled dry-run stub/);
    assert.match(readFileSync(log, "utf8"), /docker run .*--env-file .*--env-file .*assert-database-identity\.sh target/m);
    for (const step of ["runbook-05", "runbook-16"]) {
      assert.match(planBlock(RUNBOOK, step).host, /^box /, `${step} already names the box host`);
    }
    t.diagnostic("runbook-16: the box host and real helper invocation are valid; the remaining refusal is an unproduced live PostgreSQL identity observation, not a missing plan host. No database identity result is fabricated.");
    const unknown = spawnSync(join(bin, "docker"), ["run", "--h14-unreviewed-flag", "fixture"], { encoding: "utf8", env });
    assert.equal(unknown.status, 69);
    assert.match(unknown.stderr, /^unhandled dry-run stub: docker run --h14-unreviewed-flag fixture$/m);
  } finally {
    removeOwnedTemporary(temporary, "commonswarm-box-dry-run-command-");
  }
});

test("controls: runbook-16 is NOT EXECUTED without measured database identity", () => {
  const block = planBlock(RUNBOOK, "runbook-16");
  const part = process.env.BOX_DRY_RUN_PART === "box" ? "box" : "mac";
  const fixture = part === "box" ? prepareBoxFixture("s2") : prepareMacFixture();
  try {
    const record = executeWholeBlock(block, fixture);
    assert.equal(record.result, "not-executed", record.stderr);
    assert.equal(record.status, null);
    assert.deepEqual(record.seeded, [], "unmeasured identity outputs were seeded");
    assert.match(notExecutedLine(block, record), /NOT EXECUTED.*needs the real PostgreSQL identity; Anvil proves it live/);
    assert.match(measuredFact("M8").note, /Database reachability was not attempted/);
    assert.deepEqual(record.declared?.outputs, []);
  } finally {
    if (part === "box") cleanupBoxFixture(fixture);
    else cleanupMacFixture(fixture);
  }
});

test("controls: the database fixture helper refuses every unmeasured call visibly", () => {
  const part = process.env.BOX_DRY_RUN_PART === "box" ? "box" : "mac";
  const fixture = part === "box" ? prepareBoxFixture("s2") : prepareMacFixture();
  const helper = join(fixture.boxRoot ?? "/", PREVIOUS_STACK, "deploy/supabase-stack/migrate/run-db-tool.sh");
  try {
    for (const args of [["assert-database-identity.sh", "/proof/database", "target"], ["unknown-tool"]]) {
      const run = containedCommand(fixture, helper, args, { env: fixture.env });
      assert.equal(run.status, 69, run.stderr);
      assert.equal(run.stderr, "UNPRODUCED database observation\n");
      assert.equal(run.stdout, "");
    }
  } finally {
    if (part === "box") cleanupBoxFixture(fixture);
    else cleanupMacFixture(fixture);
  }
});

test("controls: box userland diff compares fixture bytes and refuses host paths", { skip: MAC_ONLY }, () => {
  const fixture = prepareMacFixture();
  const left = join(fixture.boxRoot!, "tmp/diff-left");
  const right = join(fixture.boxRoot!, "tmp/diff-right");
  const run = (args: string[]) => containedCommand(fixture, join(fixture.boxBin!, "diff"), args, { env: fixture.env });
  try {
    writeMode(left, "equal\n");
    writeMode(right, "equal\n");
    assert.equal(run(["-qr", left, right]).status, 0);
    writeMode(right, "changed\n");
    assert.equal(run(["-qr", left, right]).status, 1, "different bytes compared equal");
    const missing = run(["-qr", left, `${right}-missing`]);
    assert.equal(missing.status, 2, missing.stderr);
    const outside = run(["-qr", left, "/etc/hosts"]);
    assert.equal(outside.status, 69, outside.stderr);
    assert.match(outside.stderr, /unhandled dry-run stub: diff/);
    assert.equal(run(["--unreviewed", left, right]).status, 69);
  } finally {
    cleanupMacFixture(fixture);
  }
});

test("controls: a copy-back archive with a missing or an extra member fails the copy-back block", { skip: MAC_ONLY }, () => {
  const block = planBlock(HM37B, "hm37b-copyback");
  const boxFiles = "FILES='hm37-worker-boundary.txt hm37-hosted-control-inputs.txt hm37-hosted-check-control.json hm37-revocation-readback.json hm37-close-readback.txt'";
  const fixture = prepareMacFixture([block]);
  try {
    seedHm37bCopybackReceipt(fixture);
    const proof = seedCopybackProofDirectory(fixture);
    writeFileSync(join(proof, "unexpected.txt"), "not part of the copy-back\n", { mode: 0o600 });
    const tarMember = /tar --no-xattrs -tf|printf '%s\\n' \$FILES/;

    // The Mac side compares the archive's members with its own list. The box half's list is the one mutated, so
    // the box builds an archive that differs from what the Mac expects; the plan text is otherwise the block that
    // runs. (The last FILES assignment in the block is the box half's.)
    const missing = executeWholeBlock({
      ...block,
      source: replaceLast(block.source, boxFiles, "FILES='hm37-worker-boundary.txt hm37-hosted-control-inputs.txt hm37-hosted-check-control.json hm37-revocation-readback.json'"),
    }, fixture);
    const extra = executeWholeBlock({
      ...block,
      source: replaceLast(block.source, boxFiles, `${boxFiles.slice(0, -1)} unexpected.txt'`),
    }, fixture);
    for (const [name, execution] of [["missing", missing], ["extra", extra]] as const) {
      assert.equal(execution.result, "failed", `${name} archive unexpectedly passed`);
      assert.match(execution.firstFailingCommand ?? execution.stderr, tarMember, `${name} archive failed somewhere other than the member comparison`);
    }

    const positive = executeWholeBlock(block, fixture);
    assert.equal(positive.result, "passed", positive.stderr);
    const evidenceDirectories = readdirSync(join(fixture.cwd, "docs/evidence")).filter((name) => name.includes(`-release-${RELEASE_SHA.slice(0, 12)}-`));
    assert.equal(evidenceDirectories.length, 1);
    const copied = readdirSync(join(fixture.cwd, "docs/evidence", evidenceDirectories[0]!)).sort();
    assert.deepEqual(copied, [...COPYBACK_MEMBERS, "hm37b-copyback.sha256"].sort(), "the copy-back wrote the five members and their digest list");

    // A member the box does not have: the box half's own check refuses it, and the ssh child's failure is
    // reported with the box script's own command.
    rmSync(join(proof, "hm37-close-readback.txt"));
    const absent = executeWholeBlock(block, fixture);
    assert.equal(absent.result, "failed");
    assert.match(absent.stderr, /the box script exited 1[\s\S]*test -f "\$PROOF_DIR\/\$FILE"/);
  } finally {
    cleanupMacFixture(fixture);
  }
});

test("controls: an ssh remote script that the fixture box root cannot satisfy fails", { skip: MAC_ONLY }, () => {
  const site01 = planBlock(SITE, "site-01");
  const fixture = prepareMacFixture([site01]);
  const previousRelease = join(fixtureSiteRoot(fixture), "releases", SITE_BASE_RELEASE);
  try {
    // 1. Box state the fixture cannot satisfy: current names a release other than the one the plan expects, so
    //    the plan's own check inside the box script fails.
    const current = join(fixtureSiteRoot(fixture), "current");
    const originalTarget = readlinkSync(current);
    const otherRelease = join(fixtureSiteRoot(fixture), "releases", "20260101T000000Z-000000000000-0000000000000000");
    mkdirSync(otherRelease);
    unlinkSync(current);
    symlinkSync(otherRelease, current);
    const unsatisfied = executeWholeBlock(site01, fixture);
    assert.equal(unsatisfied.result, "failed");
    assert.equal(unsatisfied.status, 1, unsatisfied.stderr);
    assert.match(unsatisfied.stderr, /the box script exited 1[\s\S]*test "\$previous" = /);
    unlinkSync(current);
    symlinkSync(originalTarget, current);

    // 2. An unreviewed command shape on a box-userland command: the stub refuses it, exactly 69 (an unknown
    //    command name would be 127, and would show only that nothing answered).
    const unreviewed = executeWholeBlock(mutatedBlock(site01, [[
      "test -w \"$root\" && test -w \"$root/releases\"", "stat -x \"$root\"; test -w \"$root\" && test -w \"$root/releases\"",
    ]]), fixture);
    assert.equal(unreviewed.result, "failed");
    assert.equal(unreviewed.status, 69, unreviewed.stderr);
    assert.match(unreviewed.stderr, /^unhandled dry-run stub: stat -x /m);

    // 3. The positive run of the same block. Its output is computed from the fixture: the digests are the
    //    digests of the bytes in the fixture box root, and the window end is the fixture clock plus four hours.
    const appPage = join(previousRelease, "app/index.html");
    const changedBytes = Buffer.concat([readFileSync(appPage), Buffer.from("changed for this control\n")]);
    writeFileSync(appPage, changedBytes);
    const positive = executeWholeBlock(site01, fixture);
    assert.equal(positive.result, "passed", positive.stderr);
    const open = readFileSync(join(fixture.env.SITE_EVIDENCE!, "site-01-open.txt"), "utf8");
    const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
    const previousPath = `/srv/commonswarm/site/releases/${SITE_BASE_RELEASE}`;
    assert.ok(open.includes(`SITE_WINDOW_START_UTC=${WINDOW_START}\n`));
    assert.ok(open.includes("SITE_WINDOW_END_UTC=2026-09-28T05:02:03Z\n"));
    assert.ok(open.includes(`PREVIOUS_RELEASE=${previousPath}\n`));
    assert.ok(open.includes(`${digest(changedBytes)}  ${previousPath}/app/index.html\n`), "the app digest is the digest of the fixture's bytes");
    assert.ok(open.includes(`${digest(readFileSync(join(previousRelease, "download/index.html")))}  ${previousPath}/download/index.html\n`));
    assert.ok(open.includes("BOX_EGRESS=PASS user_agent=commonswarm-release-probe/1.0\n"));
    assert.equal(readFileSync(join(fixture.boxRoot!, "tmp/commonswarm-site-window.env"), "utf8").includes(`SITE_WINDOW_START_UTC=${WINDOW_START}`), true,
      "the window file crossed the ssh boundary into the box's /tmp");
  } finally {
    cleanupMacFixture(fixture);
  }
});

test("controls: a remote script that writes outside the fixture box root is denied", { skip: MAC_ONLY }, () => {
  const site01 = planBlock(SITE, "site-01");
  const fixture = prepareMacFixture([site01]);
  // A path the box mapping does not touch, on the host, where the user can normally write. Nothing may appear
  // there.
  const outside = `/private/tmp/h10-outside-${process.pid}-${Date.now()}`;
  try {
    assert.equal(existsSync(outside), false);
    const escaping = executeWholeBlock(mutatedBlock(site01, [[
      "root=/srv/commonswarm/site\n", `root=/srv/commonswarm/site\n: >${outside}\n`,
    ]]), fixture);
    assert.equal(existsSync(outside), false, "a remote script wrote outside the fixture box root");
    assert.equal(escaping.result, "failed");
    assert.match(escaping.stderr, /Operation not permitted/, "the denial is reported, not hidden");
    assert.match(escaping.stderr, /the box script exited [1-9]/);

    const positive = executeWholeBlock(site01, fixture);
    assert.equal(positive.result, "passed", positive.stderr);
    assert.equal(existsSync(join(fixture.boxRoot!, "tmp/commonswarm-site-window.env")), true, "the same block writes inside the fixture box root");
  } finally {
    rmSync(outside, { force: true });
    cleanupMacFixture(fixture);
  }
});

test("controls: a Mac block that starts an absolute-path application is denied and reported", { skip: MAC_ONLY }, () => {
  const preflight = planBlock(SITE, "site-03-browser-session-preflight");
  const chromeLine = "chrome='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'";
  assert.ok(preflight.source.includes(chromeLine), "the plan names the absolute Chrome path");
  assert.equal(existsSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"), true,
    "this control starts the Chrome binary the plan names, with --version, and needs it installed");
  const fixture = prepareMacFixture([preflight]);
  try {
    writeMode(join(fixture.home, ".commonswarm-site-window.env"), `SITE_EVIDENCE=${fixture.env.SITE_EVIDENCE}\n`);
    const launch = preflight.source.indexOf("  chrome_port=9335\n");
    assert.ok(launch > 0);
    // The block up to the launch, with a scratch profile, and one foreground `--version` call in place of the
    // launch. Nothing here starts a browser or reads Anvil's profile. If containment failed, --version would print
    // and exit. The call carries no redirection: bash 3.2 reports 1, not 126, for a refused exec that has one.
    const head = preflight.source.slice(0, launch)
      .replace('profile="/Users/yulanbot/.hermes/profiles/anvil/browser-profile/chrome"', 'profile="$SITE_EVIDENCE/control-profile"; mkdir -p "$profile"');
    const versionCall = '  "$chrome" --version\n)\n';
    const executableCheck = '  test -x "$chrome"\n';
    assert.ok(head.includes(executableCheck), "the plan checks that the Chrome binary is executable");

    // Positive: the same block with an absolute-path program that is allowed (/usr/bin/true).
    const positive = executeWholeBlock({ ...preflight, source: head.replace(chromeLine, "chrome='/usr/bin/true'") + versionCall }, fixture, { executeDeclared: true });
    assert.equal(positive.result, "passed", positive.stderr);

    // Negative 1: the block with the plan's own executable check removed reaches the exec of the absolute Chrome
    // path, and the exec is refused: "Operation not permitted", reported as the failing command.
    const denied = executeWholeBlock({ ...preflight, source: head.replace(executableCheck, "") + versionCall }, fixture, { executeDeclared: true });
    assert.equal(denied.result, "failed", "a Mac block started an application under /Applications");
    // bash 3.2 reports 126 for a refused exec, and 1 when errexit ends the subshell that made it.
    assert.ok([1, 126].includes(denied.status ?? -1), `status ${denied.status}: ${denied.stderr}`);
    assert.match(denied.stderr, /Operation not permitted/);
    assert.match(denied.firstFailingCommand ?? "", /"\$chrome" --version/);
    assert.doesNotMatch(denied.stdout, /Google Chrome/, "the application ran");

    // Negative 2: the block with the plan's own check kept. Whether the kernel refuses the executable check on
    // that path or only the exec, the block fails and the application does not run.
    const checked = executeWholeBlock({ ...preflight, source: head + versionCall }, fixture, { executeDeclared: true });
    assert.equal(checked.result, "failed");
    assert.notEqual(checked.status, 0);
    assert.doesNotMatch(checked.stdout, /Google Chrome/, "the application ran");
  } finally {
    cleanupMacFixture(fixture);
  }
});

test("controls: browser-harness refuses an unreviewed call shape", { skip: MAC_ONLY }, () => {
  const { fixture, byStep } = laneEightFixture("site-05-browser-acceptance");
  try {
    const acceptance = byStep.get("site-05-browser-acceptance")!;
    const before = siteBoxState(fixture);
    const evidence = fixture.env.SITE_EVIDENCE!;

    // Positive: the block's own path when the browser program succeeds. Nothing else changes: the release stays.
    const passing = executeWholeBlock(mutatedBlock(acceptance, [[
      "BH_TAB_MARKER=0 browser-harness >/dev/null", "BH_TAB_MARKER=0 /usr/bin/true >/dev/null",
    ]]), fixture, { executeDeclared: true });
    assert.equal(passing.result, "passed", passing.stderr);
    assert.deepEqual(siteBoxState(fixture), before);
    assert.equal(existsSync(join(evidence, "rollback-auto.txt")), false);

    // Negative: the real text. The stub refuses every program, and the plan's own reaction to a failed browser
    // control runs against the fixture box: it restores the pinned release and exits with the browser's status.
    const refused = executeWholeBlock(acceptance, fixture, { executeDeclared: true });
    assert.equal(refused.result, "failed");
    assert.equal(refused.status, 69, `the real block: status ${refused.status}, stderr ${JSON.stringify(refused.stderr)}, stdout ${JSON.stringify(refused.stdout)}`);
    assert.match(readFileSync(join(evidence, "rollback-auto.txt"), "utf8"), /^rollback_reason=browser-control-failure$/m);
    const pin = readFileSync(join(evidence, "previous.release"), "utf8").trim();
    assert.equal(realpathSync(join(fixtureSiteRoot(fixture), "current")), realpathSync(join(fixture.boxRoot!, pin)),
      "the automatic rollback pointed current at the pinned release");

    // Every program is refused, whatever its text and whatever the arguments.
    for (const [args, input] of [[[], "print(1)\n"], [[], ""], [["--anything"], "js('return true')\n"]] as const) {
      const direct = containedCommand(fixture, "browser-harness", [...args], { input, env: { ...fixture.env, BU_CDP_URL: "http://127.0.0.1:9335", BH_TAB_MARKER: "0" } });
      assert.equal(direct.status, 69, `direct call: status ${direct.status}, stderr ${JSON.stringify(direct.stderr)}`);
      assert.match(direct.stderr, /^unhandled dry-run stub: browser-harness/m);
    }
  } finally {
    cleanupMacFixture(fixture);
  }
});

test("controls: a browser fixture with a different user id fails site-03", { skip: MAC_ONLY }, () => {
  const { fixture, byStep } = laneEightFixture("site-03-browser-session-preflight");
  try {
    const browser = byStep.get("site-03-browser-session-preflight")!;
    const cli = byStep.get("site-03")!;
    const output = join(fixture.env.SITE_EVIDENCE!, "site-03-browser-preflight.json");

    // Negative: an output whose web user id differs from the CLI's is one the real program could never write (it
    // exits before writing when the ids differ), so it is refused, and the next block that is executed finds no
    // browser output.
    const wrong = executeWholeBlock(browser, fixture, { seedOverride: { web_user_id: "00000000-0000-4000-8000-000000000001" } });
    assert.equal(wrong.result, "failed");
    assert.match(wrong.stderr, /^REFUSED site-03-browser-preflight\.json: web_user_id == cli_user_id/m);
    assert.equal(existsSync(output), false);
    const next = executeWholeBlock(cli, fixture);
    assert.equal(next.result, "failed");
    assert.equal(next.status, 1);
    assert.match(next.firstFailingCommand ?? "", /test -f "\$SITE_EVIDENCE\/site-03-browser-preflight\.json"/);

    // Positive: the same two blocks with the output seeded from the committed evidence.
    const seeded = executeWholeBlock(browser, fixture);
    assert.equal(seeded.result, "not-executed");
    assert.ok(seeded.seeded?.includes(output));
    const humanSession = JSON.parse(readFileSync("docs/evidence/2026-09-27-prod-controls/RUN/00-human-session.json", "utf8")) as { identity: { user_id: string } };
    const preflight = JSON.parse(readFileSync(output, "utf8")) as Record<string, string>;
    assert.equal(preflight.web_user_id, humanSession.identity.user_id);
    assert.equal(preflight.cli_user_id, humanSession.identity.user_id);
    const passing = executeWholeBlock(cli, fixture);
    assert.equal(passing.result, "passed", passing.stderr);
  } finally {
    cleanupMacFixture(fixture);
  }
});

test("controls: a site-05-browser.json missing a documented field fails site-07", { skip: MAC_ONLY }, () => {
  const { fixture, byStep } = laneEightFixture("site-05-browser-acceptance");
  try {
    const browser = byStep.get("site-05-browser-acceptance")!;
    const consumer = byStep.get("site-07-manifest-close")!;
    const output = join(fixture.env.SITE_EVIDENCE!, "site-05-browser.json");

    // As with the site-03 control, an incomplete producer shape is refused before the file is written.
    // site-07 checks that the producer wrote a file; it does not validate individual JSON fields itself.
    const incomplete = executeWholeBlock(browser, fixture, { seedOverride: { identity: undefined } });
    assert.equal(incomplete.result, "failed");
    assert.match(incomplete.stderr, /^UNPRODUCED site-05-browser\.json: no plan-documented value for identity$/m);
    assert.equal(existsSync(output), false);
    const absent = executeWholeBlock(consumer, fixture);
    assert.equal(absent.result, "failed");
    assert.equal(absent.status, 1, absent.stderr);
    assert.match(absent.firstFailingCommand ?? "", /test -f "\$SITE_EVIDENCE\/site-05-browser\.json"/);
    assert.equal(existsSync(join(fixture.env.SITE_EVIDENCE!, "CLOSE.txt")), false);

    // Positive: the same producer and whole consumer, with the complete documented FULL-CONTROL shape.
    // No browser is executed and no screenshot is manufactured.
    const seeded = executeWholeBlock(browser, fixture);
    assert.equal(seeded.result, "not-executed", seeded.stderr);
    assert.deepEqual(seeded.seeded, [output]);
    const report = notExecutedLine(browser, seeded);
    assert.match(report, /Seeded from committed evidence: nothing\./);
    assert.match(report, /site-05-browser\.json \(plan-documented shape; no live evidence yet; replace with Anvil's live output after the lane 8 window;/);
    const documented = JSON.parse(readFileSync(output, "utf8")) as { identity: string; screenshots: string[] };
    assert.equal(documented.identity, "PASS");
    for (const name of documented.screenshots) assert.equal(existsSync(join(fixture.env.SITE_EVIDENCE!, name)), false);
    const positive = executeWholeBlock(consumer, fixture);
    assert.equal(positive.result, "passed", positive.stderr);
    const manifest = JSON.parse(readFileSync(join(fixture.env.SITE_EVIDENCE!, "manifest.json"), "utf8")) as Array<{ path: string; mode: string }>;
    assert.equal(manifest.find((row) => row.path === "site-05-browser.json")?.mode, "0600");
    assert.match(readFileSync(join(fixture.env.SITE_EVIDENCE!, "CLOSE.txt"), "utf8"), /^OUTCOME=released$/m);
  } finally {
    cleanupMacFixture(fixture);
  }
});

test("controls: an undeclared reduced-branch output stays UNPRODUCED", { skip: MAC_ONLY }, () => {
  const { fixture, byStep } = laneEightFixture("site-03-browser-session-preflight");
  try {
    const browser = byStep.get("site-03-browser-session-preflight")!;
    const consumer = byStep.get("site-03")!;
    const declaration = declaredNonSubstitutable(shortStep(browser))!;
    assert.ok(declaration.branches?.some((branch) => branch.branch === "REDUCED-CONTROL" && branch.status === "not tested"));
    const output = join(fixture.env.SITE_EVIDENCE!, "site-03-browser-preflight.json");
    const windowFile = join(fixture.home, ".commonswarm-site-window.env");
    const before = readFileSync(windowFile, "utf8");
    fixture.browserBranch = "REDUCED-CONTROL";
    const refused = executeWholeBlock(browser, fixture);
    assert.equal(refused.result, "failed");
    assert.match(refused.stderr, /^UNPRODUCED .*site-03-browser-preflight\.json.*REDUCED-CONTROL/m);
    assert.deepEqual(refused.seeded, []);
    assert.equal(existsSync(output), false);
    assert.equal(readFileSync(windowFile, "utf8"), before, "undeclared window env lines were added");
    const absent = executeWholeBlock(consumer, fixture);
    assert.equal(absent.result, "failed");
    assert.equal(absent.status, 1, absent.stderr);
    assert.match(absent.firstFailingCommand ?? "", /test -f "\$SITE_EVIDENCE\/site-03-browser-preflight\.json"/);

    // The same consumer passes with the declared FULL-CONTROL output from its cited evidence.
    fixture.browserBranch = "FULL-CONTROL";
    const seeded = executeWholeBlock(browser, fixture);
    assert.equal(seeded.result, "not-executed", seeded.stderr);
    assert.ok(seeded.seeded?.includes(output));
    const positive = executeWholeBlock(consumer, fixture);
    assert.equal(positive.result, "passed", positive.stderr);
  } finally {
    cleanupMacFixture(fixture);
  }
});

test("controls: an unlisted command inside deploy/site/deploy.sh fails closed", { skip: MAC_ONLY }, () => {
  const { fixture, byStep } = laneEightFixture("site-04");
  try {
    const site04 = byStep.get("site-04")!;
    const before = siteBoxState(fixture);
    const variants: Array<{ name: string; status: number; mutate: (source: string) => string }> = [
      {
        name: "an npm subcommand no stub lists",
        status: 69,
        mutate: (source) => source.replace('run_site_npm "$checkout/site" run build\n', 'run_site_npm "$checkout/site" run build\nrun_site_npm "$checkout/site" publish\n'),
      },
      {
        name: "an rsync flag no stub lists",
        status: 69,
        mutate: (source) => source.replace('rsync -a --delete "$checkout/site/dist/"', 'rsync -a --delete --chmod=755 "$checkout/site/dist/"'),
      },
      {
        name: "a command that is not on the stub list and not a plan tool",
        status: 127,
        mutate: (source) => source.replace("release=$(release_name)\n", "commonswarm-unlisted-tool --version\nrelease=$(release_name)\n"),
      },
    ];
    for (const variant of variants) {
      const script = writeMutatedDeploy(fixture, variant.mutate);
      const execution = executeWholeBlock(mutatedBlock(site04, [[SITE_FOUR_DEPLOY_CALL, SITE_FOUR_DEPLOY_CALL.replace("deploy/site/deploy.sh", script)]]), fixture);
      assert.equal(execution.result, "failed", `${variant.name}: site-04 passed`);
      assert.equal(execution.status, 70, `${variant.name}: the block reports a failed deploy\n${execution.stderr}`);
      assert.equal(siteFourDeployStatus(fixture).split("\n")[0], `deploy_exit=${variant.status}`, `${variant.name}: deploy.sh exit status`);
      const log = readFileSync(join(fixture.env.SITE_EVIDENCE!, "deploy.log"), "utf8");
      if (variant.status === 69) assert.match(log, /^unhandled dry-run stub: (?:npm|rsync) /m, `${variant.name}: the stub names the refused call`);
      else assert.match(log, /commonswarm-unlisted-tool: (?:command )?not found/, `${variant.name}: the shell reports the missing command`);
      assert.equal(siteBoxState(fixture).current, before.current, `${variant.name}: the live release did not change`);
      resetSiteFourAttempt(fixture, before);
    }

    // The positive run of the same block: the real deploy.sh, unchanged, deploys through the same stubs.
    rmSync(join(fixture.env.SITE_RELEASE_REPO!, "deploy/site/deploy-control.sh"));
    const positive = executeWholeBlock(site04, fixture);
    assert.equal(positive.result, "passed", positive.stderr);
    assert.equal(siteFourDeployStatus(fixture), "deploy_exit=0\nafter_read_exit=0\n");
    assert.match(readFileSync(join(fixture.env.SITE_EVIDENCE!, "deploy.log"), "utf8"),
      /^Deployed release \d{8}T\d{6}Z-8b8989f2b29e-[0-9a-f]{16} to commonswarm@yulan-vps-1\. The five newest releases were kept for rollback\.$/m);
  } finally {
    cleanupMacFixture(fixture);
  }
});

test("controls: a site-04 deploy.sh call with a different target host fails", { skip: MAC_ONLY }, () => {
  const { fixture, byStep } = laneEightFixture("site-04");
  try {
    const site04 = byStep.get("site-04")!;
    const before = siteBoxState(fixture);
    const wrongHost = executeWholeBlock(mutatedBlock(site04, [[SITE_FOUR_DEPLOY_CALL, SITE_FOUR_DEPLOY_CALL.replace("commonswarm@yulan-vps-1", "commonswarm@example.invalid")]]), fixture);
    assert.equal(wrongHost.result, "failed");
    assert.equal(wrongHost.status, 70, wrongHost.stderr);
    assert.equal(siteFourDeployStatus(fixture).split("\n")[0], "deploy_exit=69", "deploy.sh exits with the ssh stub's refusal");
    assert.match(readFileSync(join(fixture.env.SITE_EVIDENCE!, "deploy.log"), "utf8"), /^UNPRODUCED ssh host$/m);
    assert.deepEqual(siteBoxState(fixture), before, "nothing reached the fixture box");
    resetSiteFourAttempt(fixture, before);

    const positive = executeWholeBlock(site04, fixture);
    assert.equal(positive.result, "passed", positive.stderr);
    assert.notDeepEqual(siteBoxState(fixture), before, "the positive run switched the fixture box's current release");
  } finally {
    cleanupMacFixture(fixture);
  }
});

test("controls: a fixture dist tree missing a file that deploy.sh validates fails site-04", { skip: MAC_ONLY }, () => {
  const { fixture, byStep } = laneEightFixture("site-04");
  try {
    const site04 = byStep.get("site-04")!;
    const before = siteBoxState(fixture);
    const startPage = join(fixture.distFixture!, "start/index.html");
    const startBytes = readFileSync(startPage);

    // The page deploy.sh validates is absent: deploy.sh's own check refuses it, exit 1.
    rmSync(startPage);
    const missing = executeWholeBlock(site04, fixture);
    assert.equal(missing.result, "failed");
    assert.equal(missing.status, 70, missing.stderr);
    assert.equal(siteFourDeployStatus(fixture).split("\n")[0], "deploy_exit=1");
    assert.match(readFileSync(join(fixture.env.SITE_EVIDENCE!, "deploy.log"), "utf8"), /^Refusing deploy: built \/start page is missing\.$/m);
    assert.deepEqual(siteBoxState(fixture), before, "nothing was uploaded");
    resetSiteFourAttempt(fixture, before);

    // The page is there but its commonswarm:url meta carries no value: the second check refuses it.
    writeFileSync(startPage, startBytes.toString("utf8").replace(/content="[^"]*"/, 'content=""'));
    const empty = executeWholeBlock(site04, fixture);
    assert.equal(empty.result, "failed");
    assert.equal(siteFourDeployStatus(fixture).split("\n")[0], "deploy_exit=1");
    assert.match(readFileSync(join(fixture.env.SITE_EVIDENCE!, "deploy.log"), "utf8"), /^Refusing deploy: built \/start commonswarm:url meta value is empty\.$/m);
    assert.deepEqual(siteBoxState(fixture), before);
    resetSiteFourAttempt(fixture, before);

    // The positive run of the same block with the tree intact: the release is uploaded, normalized, and switched in.
    writeFileSync(startPage, startBytes);
    const positive = executeWholeBlock(site04, fixture);
    assert.equal(positive.result, "passed", positive.stderr);
    const after = siteBoxState(fixture);
    assert.match(after.current, /^releases\/\d{8}T\d{6}Z-8b8989f2b29e-[0-9a-f]{16}$/, "current now names the new release, relative, as finalize-release.sh links it");
    const release = join(fixtureSiteRoot(fixture), after.current);
    assert.deepEqual(readFileSync(join(release, "start/index.html")), startBytes, "the uploaded bytes are the built bytes");
    assert.equal(statSync(join(release, "start/index.html")).mode & 0o777, 0o644);
    assert.equal(statSync(join(release, "start")).mode & 0o777, 0o755);
    assert.equal(after.releases.some((name) => name.endsWith(".tmp")), false, "the upload directory became the release");
    assert.ok(after.releases.includes(basename(before.current)), "the previous release is kept for rollback");
  } finally {
    cleanupMacFixture(fixture);
  }
});

test("controls: a block that exits non-zero is reported as failed, never as passed", { skip: MAC_ONLY }, () => {
  const fixture = prepareMacFixture();
  try {
    const block: Block = {
      file: "tests/box-dry-run/synthetic-nonzero.md", step: "synthetic-nonzero",
      marker: "no", host: "Mac mini /bin/bash 3.2", line: 1,
      source: "# step: synthetic-nonzero\n# readonly: no\n# host: Mac mini /bin/bash 3.2\n( set -euo pipefail; exit 23 )\n",
    };
    // The positive run of the same path: a block that exits zero passes. The negative run exits with the block's
    // own status, so a block that never ran (containment unavailable exits 71) cannot pass for it.
    const passing = executeWholeBlock({ ...block, source: block.source.replace("exit 23", "exit 0") }, fixture);
    assert.equal(passing.result, "passed", passing.stderr);
    assert.equal(passing.status, 0);
    const execution = executeWholeBlock(block, fixture);
    assert.equal(execution.result, "failed");
    assert.equal(execution.status, 23, execution.stderr);
    assert.notEqual(execution.result, "passed");
  } finally {
    cleanupMacFixture(fixture);
  }
});

test("controls: a dry run leaves the real checkout unchanged", { skip: MAC_ONLY }, async (t) => {
  const before = checkoutSnapshot(REAL_CHECKOUT);
  const labels = ["prep/pass", "window-a/s2/pass", "window-b/pass", "lane-8/FULL-CONTROL"];
  const fourPlanRuns = currentPlannedRuns().filter((run) => labels.includes(run.label));
  assert.deepEqual(fourPlanRuns.map((run) => run.label), labels);

  for (const run of fourPlanRuns) {
    const fixture = prepareMacFixture(run.blocks, { state: run.state, browserBranch: run.branch });
    try {
      executePlanUntilFailure(run.blocks, fixture, "mac");
    } finally {
      cleanupMacFixture(fixture);
    }
  }
  assertCheckoutUnchanged(REAL_CHECKOUT, before);

  const syntheticPath = join(REAL_CHECKOUT, "tests", `.box-dry-run-real-checkout-write-${process.pid}`);
  await t.test("failing sub-case detects a write under the real checkout", () => {
    assert.equal(existsSync(syntheticPath), false);
    try {
      // The write is made here, by the test process, so the detector has something to find.
      writeFileSync(syntheticPath, "synthetic write\n");
      assert.throws(() => assertCheckoutUnchanged(REAL_CHECKOUT, before), /dry run changed the real checkout/);
    } finally {
      rmSync(syntheticPath, { force: true });
    }
  });
  assertCheckoutUnchanged(REAL_CHECKOUT, before);

  await t.test("a contained block cannot write under the real checkout", () => {
    const fixture = prepareMacFixture();
    assert.equal(existsSync(syntheticPath), false);
    try {
      const block: Block = {
        file: "tests/box-dry-run/synthetic-real-checkout-write.md",
        step: "synthetic-real-checkout-write",
        marker: "no",
        host: "Mac mini /bin/bash 3.2",
        line: 1,
        source: `# step: synthetic-real-checkout-write\n# readonly: no\n# host: Mac mini /bin/bash 3.2\nprintf 'synthetic write\\n' >${JSON.stringify(syntheticPath)}\n`,
      };
      // The positive run of the same write, into the fixture's own directory, passes.
      const inside = executeWholeBlock({ ...block, source: block.source.replace(JSON.stringify(syntheticPath), JSON.stringify(join(fixture.temporary!, "inside-write"))) }, fixture);
      assert.equal(inside.result, "passed", inside.stderr);
      const execution = executeWholeBlock(block, fixture);
      assert.equal(execution.result, "failed", "a contained block wrote under the real checkout");
      assert.match(execution.stderr, /Operation not permitted/);
      assert.equal(existsSync(syntheticPath), false);
      assertCheckoutUnchanged(REAL_CHECKOUT, before);
    } finally {
      rmSync(syntheticPath, { force: true });
      cleanupMacFixture(fixture);
    }
  });
  assertCheckoutUnchanged(REAL_CHECKOUT, before);
});

test("fixture image, repository-path, and environment-name values agree with repository or measurement text", () => {
  const source = readFileSync("tests/box-dry-run.test.ts", "utf8");
  const fixtureSource = source.slice(source.indexOf("function prepareBoxFixture"), source.indexOf("function cleanupBoxFixture"));
  const literalFixtureSource = [
    fixtureSource,
    readFileSync("tests/box-dry-run/prelude.sh", "utf8"),
    readFileSync("tests/box-dry-run/stubs/dispatch.sh", "utf8"),
    readFileSync("tests/box-dry-run/python/sitecustomize.py", "utf8"),
  ].join("\n").replace(/\$\{[^}]+\}/g, "");
  const tracked = spawnSync("git", ["ls-files"], { encoding: "utf8" });
  const trackedMessage = tracked.stderr || tracked.error?.message || "git ls-files failed";
  assert.equal(tracked.status, 0, trackedMessage);
  const repositoryText = tracked.stdout.trim().split("\n")
    .filter((file) => file !== "tests/box-dry-run.test.ts" && !file.startsWith("tests/box-dry-run/"))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n") + readFileSync(MEASURED_FACTS_FILE, "utf8");
  const values = new Set<string>();
  for (const match of literalFixtureSource.matchAll(/public\.ecr\.aws\/[A-Za-z0-9._/-]+:[A-Za-z0-9._-]+/g)) values.add(match[0]);
  for (const match of literalFixtureSource.matchAll(/(?<!\/)(?:deploy|docs|site|src|supabase)\/[A-Za-z0-9._/-]+/g)) values.add(match[0]);
  for (const match of literalFixtureSource.matchAll(/\b(?:MCP|PUBLIC|SUPABASE|SWARM|TARGET|COMMONSWARM)_[A-Z0-9_]+\b/g)) values.add(match[0]);
  values.add(PSQL_IMAGE);
  values.add(TARGET_ENV_NAME);
  assert.ok(values.size >= 5, "fixture agreement scan found too few values");
  const accepted = (value: string): boolean => repositoryText.includes(value);
  for (const value of values) assert.equal(accepted(value), true, `fixture value has no repository/measurement source: ${value}`);
  assert.equal(accepted("public.ecr.aws/supabase/postgres:0.0.0-invented"), false,
    "invented image control unexpectedly passed");
});

test("every box fixture model is internally consistent with plan comparisons", (t) => {
  const states = Object.keys(JSON.parse(readFileSync("tests/box-dry-run/fixtures/states.json", "utf8")) as Record<string, string>);
  const sources = fixtureComparisonSources();
  assert.equal(sources.size, 15, "fixture comparison family discovery changed");
  let pairCount = 0;
  for (const state of states) {
    const model = buildBoxFixtureModel(state);
    const pairs = boxFixturePairs(model);
    if (pairCount === 0) pairCount = pairs.length;
    assert.equal(pairs.length, pairCount, `${state} produced a different comparison pair list`);
    assertBoxFixtureConsistency(model);
  }
  assert.ok(pairCount >= 40, `fixture consistency discovered only ${pairCount} pairs`);

  const control = structuredClone(buildBoxFixtureModel("s2"));
  control.containers.oauth.image = `sha256:${"f".repeat(64)}`;
  const controlMismatches = fixturePairMismatches(control);
  assert.equal(controlMismatches.length, 1,
    `one-pair failing control did not report exactly one mismatch:\n${controlMismatches.join("\n")}`);
  assert.match(controlMismatches[0]!, /^container-image:/);
  assert.throws(() => assertBoxFixtureConsistency(control), /s2 fixture mismatches \(1\):\ncontainer-image:/);
  t.diagnostic(`fixture_comparison_families=${sources.size}; pairs_per_state=${pairCount}; states=${states.length}; all_passed=true; failing_control=1_mismatch`);
});

test("box runtime stubs are regular root-owned executables and emit accepted Deno shapes", {
  skip: process.env.BOX_DRY_RUN_PART !== "box",
}, () => {
  const guard = spawnSync("/bin/bash", [GUARD], { encoding: "utf8", env: process.env });
  assert.equal(guard.status, 0, guard.stderr);
  const originalUsrLocalBin = lstatSync("/usr/local/bin");
  const fixture = prepareBoxFixture("s2");
  produceDenoUnitPrerequisites(fixture);
  try {
    const preparedUsrLocalBin = lstatSync("/usr/local/bin");
    assert.equal(preparedUsrLocalBin.mode & 0o777, 0o755);
    assert.equal(preparedUsrLocalBin.uid, 0);
    assert.equal(preparedUsrLocalBin.gid, 0);
    for (const command of BOX_STUB_COMMANDS) {
      const stat = lstatSync(join(fixture.bin, command));
      assert.equal(stat.isFile(), true, `${command} is not a regular file`);
      assert.equal(stat.isSymbolicLink(), false, `${command} is a symlink`);
      assert.equal(stat.mode & 0o777, 0o755, `${command} mode`);
      assert.equal(stat.uid, 0, `${command} owner`);
      assert.equal(stat.gid, 0, `${command} group`);
    }
    assert.equal(pathExists(DENO_PATH), false);
    const installBlock = blocks(HM37B).find((block) => shortStep(block) === "hm37-deno-install");
    assert.ok(installBlock);
    const installed = executeWholeBlock(installBlock, fixture);
    assert.equal(installed.result, "passed", installed.stderr);
    const denoStat = lstatSync(DENO_PATH);
    assert.equal(denoStat.isFile(), true);
    assert.equal(denoStat.isSymbolicLink(), false);
    assert.equal(denoStat.mode & 0o777, 0o755);
    assert.equal(denoStat.uid, 0);
    assert.equal(denoStat.gid, 0);
    const version = spawnSync(DENO_PATH, ["--version"], { encoding: "utf8", env: fixture.env });
    assert.equal(version.status, 0, version.stderr);
    assert.match(version.stdout, /^deno 2\.9\.7/m);
    const cache = spawnSync(DENO_PATH, ["cache", "--no-lock", "fixture.ts"], { encoding: "utf8", env: fixture.env });
    assert.equal(cache.status, 0, cache.stderr);
    const run = spawnSync(DENO_PATH, ["run", "hm37-open-ack-control.ts"], { encoding: "utf8", env: fixture.env });
    assert.notEqual(run.status, 0, "embedded Deno program was replaced by a synthetic success result");
    assert.match(run.stderr, /UNPRODUCED embedded Deno program result/);
    const calls = readFileSync(fixture.log, "utf8");
    assert.match(calls, /^deno --version$/m);
    assert.match(calls, /^deno cache --no-lock fixture\.ts$/m);
    assert.match(calls, /^deno run hm37-open-ack-control\.ts$/m);
    const removeBlock = blocks(HM37B).find((block) => shortStep(block) === "hm37-deno-remove");
    assert.ok(removeBlock);
    const removed = executeWholeBlock(removeBlock, fixture);
    assert.equal(removed.result, "passed", removed.stderr);
    assert.equal(pathExists(DENO_PATH), false);
  } finally {
    cleanupBoxFixture(fixture);
    const restoredUsrLocalBin = lstatSync("/usr/local/bin");
    assert.equal(restoredUsrLocalBin.mode & 0o777, originalUsrLocalBin.mode & 0o777);
    assert.equal(restoredUsrLocalBin.uid, originalUsrLocalBin.uid);
    assert.equal(restoredUsrLocalBin.gid, originalUsrLocalBin.gid);
  }
});

test("pinned Deno install and rollback removal fail closed", {
  skip: process.env.BOX_DRY_RUN_PART !== "box",
}, () => {
  const guard = spawnSync("/bin/bash", [GUARD], { encoding: "utf8", env: process.env });
  assert.equal(guard.status, 0, guard.stderr);
  const installBlock = blocks(HM37B).find((block) => shortStep(block) === "hm37-deno-install");
  const removeBlock = blocks(HM37B).find((block) => shortStep(block) === "hm37-deno-remove");
  assert.ok(installBlock);
  assert.ok(removeBlock);

  let fixture = prepareBoxFixture("s2");
  produceDenoUnitPrerequisites(fixture);
  try {
    fixture.env.BOX_DRY_RUN_DENO_ZIP_SHA256 = "0".repeat(64);
    const wrongZip = executeWholeBlock(installBlock, fixture);
    assert.equal(wrongZip.result, "failed");
    assert.equal(pathExists(DENO_PATH), false, "wrong zip installed Deno");
    assert.doesNotMatch(readFileSync(fixture.log, "utf8"), /python3 .*deno\.zip/, "wrong zip reached extraction");
  } finally {
    cleanupBoxFixture(fixture);
  }

  fixture = prepareBoxFixture("s2");
  produceDenoUnitPrerequisites(fixture);
  try {
    assert.equal(executeWholeBlock(installBlock, fixture).result, "passed");
    writeRootMode(DENO_PATH, "different binary\n", 0o755);
    const refused = executeWholeBlock(removeBlock, fixture);
    assert.equal(refused.result, "failed");
    assert.equal(readFileSync(DENO_PATH, "utf8"), "different binary\n", "unknown Deno file was changed");
  } finally {
    cleanupBoxFixture(fixture);
  }

  fixture = prepareBoxFixture("s2");
  produceDenoUnitPrerequisites(fixture);
  try {
    writeRootMode(DENO_PATH, "pre-existing unknown binary\n", 0o755);
    const refused = executeWholeBlock(installBlock, fixture);
    assert.equal(refused.result, "failed");
    assert.equal(readFileSync(DENO_PATH, "utf8"), "pre-existing unknown binary\n",
      "install overwrote an unknown Deno file");
  } finally {
    cleanupBoxFixture(fixture);
  }

  fixture = prepareBoxFixture("s2");
  produceDenoUnitPrerequisites(fixture);
  try {
    writeRootMode(DENO_PATH, "pre-existing unknown binary\n", 0o755);
    const refused = executeWholeBlock(removeBlock, fixture);
    assert.equal(refused.result, "failed");
    assert.match(refused.stderr, /refusing to remove an unknown file/);
    assert.equal(readFileSync(DENO_PATH, "utf8"), "pre-existing unknown binary\n",
      "removal without a recorded digest changed an unknown Deno file");
  } finally {
    cleanupBoxFixture(fixture);
  }

  fixture = prepareBoxFixture("s2");
  produceDenoUnitPrerequisites(fixture);
  try {
    const notInstalled = executeWholeBlock(removeBlock, fixture);
    assert.equal(notInstalled.result, "passed", notInstalled.stderr);
    assert.equal(pathExists(DENO_PATH), false);
    assert.match(readFileSync(join(PROOF_DIR, "window.env"), "utf8"), /^deno_remove=not-installed$/m);
  } finally {
    cleanupBoxFixture(fixture);
  }

  fixture = prepareBoxFixture("s2");
  produceDenoUnitPrerequisites(fixture);
  try {
    const installed = executeWholeBlock(installBlock, fixture);
    assert.equal(installed.result, "passed", installed.stderr);
    const removed = executeWholeBlock(removeBlock, fixture);
    assert.equal(removed.result, "passed", removed.stderr);
    assert.equal(pathExists(DENO_PATH), false, "rollback did not remove recorded Deno binary");
    const cache = `/home/commonswarm/edge/controls/${RELEASE_SHA}-${WINDOW_ID}/deno-cache`;
    assert.equal(pathExists(cache), false, "rollback did not remove per-window Deno cache");
  } finally {
    cleanupBoxFixture(fixture);
  }
});

test("five states execute selected whole blocks in order and fail honestly on current unproduced inputs", (t) => {
  const states = JSON.parse(readFileSync("tests/box-dry-run/fixtures/states.json", "utf8")) as Record<string, string>;
  assert.deepEqual(Object.keys(states), ["s1", "s2", "s3", "s4", "s5"]);
  const selected = selectedHmSequence();
  const allBlocks = [...blocks(HM37), ...blocks(RUNBOOK)];
  const byStep = new Map(allBlocks.map((block) => [shortStep(block), block]));
  const planBlocks = selected.map((step) => byStep.get(step)!);
  const part: FixturePart = process.env.BOX_DRY_RUN_PART === "box" ? "box" : "mac";
  for (const [state, description] of Object.entries(states)) {
    let fixture: Fixture;
    if (part === "box") {
      const guard = spawnSync("/bin/bash", [GUARD], { encoding: "utf8", env: process.env });
      assert.equal(guard.status, 0, guard.stderr);
      fixture = prepareBoxFixture(state, planBlocks);
    } else {
      fixture = prepareMacFixture(planBlocks, { state });
    }
    try {
      const records = executePlanUntilFailure(planBlocks, fixture, part);
      assert.ok(records.length > 0, `${part}/${state} selected no blocks`);
      const failures = records.filter(({ execution }) => execution.result === "failed");
      const expected = unproducedReport().some((line) => line.includes(`[run=window-a/${state}/pass `));
      // Execution stops at the first failed block, so a run fails at most once. A run the dependency report flags
      // must fail. A run it does not flag may still fail: against a fixture box that holds the state the evidence
      // measured, a block can fail on a defect no text scan sees. The plan assertion reports each with its file
      // and line.
      assert.ok(failures.length <= 1, `${part}/${state} continued past a failed block`);
      if (expected) assert.equal(failures.length, 1, `${part}/${state} passed although the derived dependency report names an unproduced input`);
      if (failures[0]) t.diagnostic(`${description}: ${executionUnproducedLine(failures[0].block, failures[0].execution, state)}`);
      t.diagnostic(`${part}:${state}: ${records.map(({ execution }) => `${execution.step}=${execution.result}`).join(",")}`);
    } finally {
      if (part === "box") cleanupBoxFixture(fixture);
      else cleanupMacFixture(fixture);
    }
    const lines = unproducedReport().filter((line) => line.includes(`[run=window-a/${state}/pass `));
    for (const line of lines) t.diagnostic(`${description}: ${line}`);
  }
});

test("selected readonly blocks remain in the executable whole-plan order", (t) => {
  const sequence = selectedHmSequence();
  const allBlocks = [...blocks(HM37), ...blocks(RUNBOOK)];
  const byStep = new Map(allBlocks.map((block) => [shortStep(block), block]));
  for (const step of sequence) {
    const block = byStep.get(step);
    assert.ok(block, `selected sequence contains unknown step ${step}`);
    if (block.marker === "yes") t.diagnostic(`${step}=readonly/order-retained`);
  }
  assert.ok(sequence.length > 0);
});

test("runbook-18 accepts the selected H0 backfill's empty-ledger evidence state", {
  skip: process.env.BOX_DRY_RUN_PART !== "box",
}, () => {
  const guard = spawnSync("/bin/bash", [GUARD], { encoding: "utf8", env: process.env });
  assert.equal(guard.status, 0, guard.stderr);
  const block = planBlock(RUNBOOK, "runbook-18");
  // The runbook inherits RELEASE_SHA from its selecting window's prompt-input table.
  const fixture = prepareBoxFixture("s2", [planBlock(HM37, "hm37a-go-record"), block]);
  try {
    produceRunbook18UnitPrerequisites(fixture);
    const record = executeWholeBlock(block, fixture);
    assert.equal(record.result, "passed", record.stderr);
    const ledger = `/home/commonswarm/stack/release-proofs/${RELEASE_SHA}/h0-ledger-before.txt`;
    assert.equal(readFileSync(ledger, "utf8"), "");
    writeRootMode(join(fixture.temporary!, "unit-ledger-rows.txt"), "20260916000001\n");
    const nonempty = executeWholeBlock(block, fixture);
    assert.equal(nonempty.result, "failed", "an existing ledger row was accepted");
    assert.equal(nonempty.firstFailingCommand, 'test ! -s "$PROOF_DIR/h0-ledger-before.txt"');
    assert.equal(readFileSync(ledger, "utf8"), "20260916000001\n");
  } finally {
    cleanupBoxFixture(fixture);
  }
});

test("historical controls execute and reproduce the named failures while current text fixes them", { skip: MAC_ONLY }, () => {
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
    const oldOauthSha = basename(OAUTH_RELEASE);
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
      cwd: checkoutFixture(fixture.temporary!, "historical-checkout", RELEASE_SHA),
      env: { ...fixture.env },
    };
    const readFailure = executeWholeBlock(historicalOauth, historicalFixture, { control: "historical-oauth-read" });
    assert.equal(readFailure.result, "failed");
    assert.match(readFailure.firstFailingCommand ?? readFailure.stderr, /read -r MCP_OAUTH_IMAGE/);

    const historicalBackup: Block = {
      file: HM37, step: "historical-backup-unbound", marker: "yes", host: "Mac mini /bin/bash 3.2",
      line: 1,
      source: oldBackup
        .replaceAll("/home/commonswarm", controlRoot)
        .replace(': "${BACKUP_MAX_AGE_SECONDS:?HezLead-approved backup age required}"', "BACKUP_MAX_AGE_SECONDS=86400"),
    };
    const backupFailure = executeWholeBlock(historicalBackup, historicalFixture, {
      control: "historical-backup-unbound",
    });
    assert.equal(backupFailure.result, "failed");
    assert.match(backupFailure.stderr, /PROOF_DIR: unbound variable/);

    const psql = spawnSync("psql", ["--file", "/host/proof.sql"], { encoding: "utf8", env: fixture.env });
    assert.notEqual(psql.status, 0);
    assert.match(psql.stderr, /bind-mounted container path/);

    const historicalPublic: Block = {
      file: HM37, step: "hm37-public-boundaries", marker: "probe", host: "Mac mini /bin/bash 3.2",
      line: 1, source: oldPublic,
    };
    writeMode(join(fixture.home, ".commonswarm-release-window.env"),
      `SHA='${RELEASE_SHA}'\nWINDOW_ID='${WINDOW_ID}'\n`);
    const noUa = executeWholeBlock(historicalPublic, historicalFixture, { control: "historical-default-ua" });
    assert.equal(noUa.result, "failed");
    assert.match(noUa.stderr, /HTTP Error 403|python3 .*gateway/);

    writeMode(join(oldOauthProof, "oauth-image.id"), `sha256:${"0".repeat(64)}\n`);
    const historicalMediaSource = stepSource(oldMedia, "hm37-hm6-oauth-precondition");
    // The old block also reads a program's result out of the OAuth container, which the dry run cannot run and
    // refuses (69). That readback is not what this control tests, so it is the one line replaced; the media
    // check after it is the old text, byte for byte.
    const containerReadback = "  docker exec \"$CID\" node -e \\\n    'process.exit(process.env.MCP_OAUTH_PUBLIC_AUTHORIZATION_ENABLED === \"1\" ? 1 : 0)'\n";
    assert.ok(historicalMediaSource.includes(containerReadback), "the old block carries the container readback");
    const historicalMedia: Block = {
      file: HM37, step: "hm37-hm6-oauth-precondition", marker: "yes", host: "Mac mini /bin/bash 3.2",
      line: 1, source: historicalMediaSource.replace(containerReadback, "  true\n").replaceAll("/home/commonswarm", controlRoot),
    };
    const wrongMedia = executeWholeBlock(historicalMedia, historicalFixture, { control: "historical-media" });
    assert.equal(wrongMedia.result, "failed");
    assert.match(wrongMedia.stderr, /AssertionError|python3 - https:\/\/mcp\.commonswarm\.com/);

    const oldRunbook = gitShow("b912b349", RUNBOOK);
    const oldOpen = stepSource(oldRunbook, "1-apply-release-directories");
    assert.match(oldOpen, /prepare_release_directory/);
    const b912Root = join(fixture.temporary!, "b912-root");
    const previousEdge = join(b912Root, "edge/releases", basename(PREVIOUS_EDGE));
    const previousStack = join(b912Root, "stack/releases", basename(PREVIOUS_STACK));
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
        .replaceAll("<sha>", RELEASE_SHA)
        .replaceAll("<edge|stack|edge stack>", "edge stack")
        .replaceAll("<approved-YYYY-MM-DDTHH:MM:SSZ>", "2026-09-28T05:02:03Z")
        .replaceAll("<sha256-from-Mac-evidence>", createHash("sha256").update(readFileSync(b912Archive)).digest("hex"))
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

test("lane 8 executes its declared plan and reports current unproduced inputs", { skip: MAC_ONLY }, (t) => {
  const site = blocks(SITE);
  assert.equal(site.length, 15);
  assert.deepEqual(site.map(shortStep), [
    "site-00-source-checkout", "site-01", "site-00-a-close-ingest", "site-00-build-env", "site-02",
    "site-03-browser-session-preflight", "site-03", "site-03-pin-previous", "site-03-go-record", "site-04",
    "site-04-reconcile-failure", "site-05", "site-05-browser-acceptance", "site-06", "site-07-manifest-close",
  ]);
  const report = unproducedReport().filter((line) => line.includes("[run=lane-8/FULL-CONTROL "));
  const laneBlocks = resolveSteps("lane-8", siteOrder());
  const fixture = prepareMacFixture(laneBlocks);
  try {
    const records = executePlanUntilFailure(laneBlocks, fixture, "mac");
    assert.ok(records.length > 0);
    assert.ok(records.filter(({ execution }) => execution.result === "failed").length <= 1);
    if (records.at(-1)?.execution.result === "failed") {
      t.diagnostic(executionUnproducedLine(records.at(-1)!.block, records.at(-1)!.execution, "site"));
    }
  } finally {
    cleanupMacFixture(fixture);
  }
  for (const line of report) t.diagnostic(line);
});

test("plan handoffs and selected orders are derived from the plan text", () => {
  const prep = readFileSync(PREP, "utf8");
  const a = readFileSync(HM37, "utf8");
  const b = readFileSync(HM37B, "utf8");
  const site = readFileSync(SITE, "utf8");
  assert.match(prep, /printf "PREP_RECEIPT_PATH='%s'/);
  assert.match(a, /\| `PREP_RECEIPT_PATH` \|/);
  assert.match(a, /hm37-close-readback\.txt/);
  for (const consumer of [b, site]) assert.match(consumer, /\| `HM37_A_CLOSE_RECEIPT` \|/);
  resolveSteps("prep", prepSuccessOrder());
  for (const [path, steps] of windowAPaths()) resolveSteps(`window-a/${path}`, steps);
  for (const [path, steps] of windowBPaths()) resolveSteps(`window-b/${path}`, steps);
  resolveSteps("lane-8/FULL-CONTROL", siteOrder());
  resolveSteps("lane-8/REDUCED-CONTROL", siteOrder());
});

test("recorded command fixtures cite builders or measured browser controls", () => {
  const fixtures = JSON.parse(readFileSync(COMMAND_OUTPUTS_FILE, "utf8")) as Record<string, { source: string; output: unknown }>;
  for (const name of [
    "cswarm_whoami", "cswarm_status", "cswarm_note", "cswarm_check_first", "cswarm_check_empty",
    "cswarm_receipt", "browser_full_control", "browser_profile",
  ]) {
    const fixture = fixtures[name];
    assert.ok(fixture, `missing command-output fixture ${name}`);
    assert.match(fixture.source, /^(?:src|docs\/evidence)\/.+:\d+(?:-\d+)?$/);
    assert.ok(typeof fixture.output === "object" && fixture.output !== null);
    assert.equal(Object.hasOwn(fixture.output as object, "step_result"), false);
  }
});

// A failing ssh child reports its own last failing command and the line of the box script it was on. The report
// names that command's place in the plan text, so a defect in a box script is cited at the plan's file and line.
function failureDetail(block: Block, execution: Execution): string {
  const detail = execution.firstFailingCommand ?? execution.stderr.trim().split("\n")[0] ?? "unknown";
  const remote = /the box script exited (\d+)\. Its last failing commands:\n(?:line \d+: .*\n?)+/.exec(execution.stderr);
  if (!remote) return detail;
  const last = [...remote[0].matchAll(/^line (\d+): (.*)$/gm)].at(-1);
  if (!last) return detail;
  const offset = block.source.indexOf(last[2]!);
  const place = offset >= 0 ? ` at ${block.file}:${sourceLineAt(block, offset)}` : "";
  return `${detail} <- the box script exited ${remote[1]} on its line ${last[1]}: ${last[2]}${place}`;
}

// A block that declares a non-substitutable surface is not executed. The report names it, what its declaration
// says proves it live, what was seeded from committed evidence or a labeled plan shape, and what is not
// produced, so a reader sees what the dry run did not run.
function notExecutedLine(block: Block, execution: Execution): string {
  const declared = execution.declared!;
  const outputs = declared.outputs ?? [];
  const seeded = (execution.seeded ?? []).map((path) => basename(path));
  const observed = seeded.filter((file) => !outputs.find((output) => output.file === file)?.plan_documented).join(", ") || "nothing";
  const planShapes = seeded.flatMap((file) => {
    const shape = outputs.find((output) => output.file === file)?.plan_documented;
    return shape ? [` Plan-documented output: ${file} (${shape.label}; source: ${shape.evidence}:${shape.source_lines}).`] : [];
  }).join("");
  const missing = (declared.unproduced ?? []).map((item) => item.output).join(", ") || "none";
  const items = (declared.plan_items ?? []).map((item) => ` Plan item: ${item}.`).join("");
  return `NOT EXECUTED ${block.file}:${block.line} [step=${shortStep(block)}] non-substitutable (${declared.surface}): ${declared.reason} Live proof: ${declared.live_proof} Seeded from committed evidence: ${observed}.${planShapes} Not produced, by name: ${missing}.${items}`;
}

test("HM37 plans are UNPRODUCED-free and every block passes", (t) => {
  const unproducedByConsumer = new Map<string, string>();
  for (const line of unproducedReport()) {
    const key = line.replace(/ \[run=.*$/, "");
    if (!unproducedByConsumer.has(key)) unproducedByConsumer.set(key, line);
  }
  const failed: string[] = [];
  const notExecuted = new Map<string, string>();
  const notTested: string[] = [];
  const part: FixturePart = process.env.BOX_DRY_RUN_PART === "box" ? "box" : "mac";
  for (const run of currentPlannedRuns()) {
    const unavailable = run.branch && nonSubstitutableEntries().flatMap((entry) => entry.branches ?? [])
      .find((branch) => branch.branch === run.branch && branch.status === "not tested");
    if (unavailable) {
      const line = `NOT TESTED [run=${run.label}] ${unavailable.reason} Evidence: ${unavailable.evidence}:${unavailable.source_lines}`;
      notTested.push(line);
      t.diagnostic(line);
      continue;
    }
    let fixture: Fixture;
    if (part === "box") {
      const guard = spawnSync("/bin/bash", [GUARD], { encoding: "utf8", env: process.env });
      assert.equal(guard.status, 0, guard.stderr);
      const state = /^window-a\/(s[1-5])\//.exec(run.label)?.[1] ?? "s2";
      fixture = prepareBoxFixture(state, run.blocks);
    } else {
      fixture = prepareMacFixture(run.blocks, { state: run.state, browserBranch: run.branch, afterWindowA: run.afterWindowA });
    }
    try {
      const records = executePlanUntilFailure(run.blocks, fixture, part);
      for (const { block, execution } of records) {
        if (execution.result === "not-executed") {
          const key = `${block.file}:${block.line}`;
          if (!notExecuted.has(key)) notExecuted.set(key, execution.declared
            ? notExecutedLine(block, execution)
            : `NOT EXECUTED ${block.file}:${block.line} [step=${shortStep(block)}] Mac-only box-opening transfer; seeded plan-documented synthetic window shape: ${execution.seeded!.join(", ")}`);
        }
        if (execution.result === "failed") {
          const line = `failed block ${block.file}:${block.line} [run=${run.label} step=${shortStep(block)}] ${failureDetail(block, execution)}`;
          if (!failed.some((existing) => existing.replace(/ \[run=.*? step=/, " [step=") === line.replace(/ \[run=.*? step=/, " [step="))) {
            failed.push(line);
          }
        }
      }
    } finally {
      if (part === "box") cleanupBoxFixture(fixture);
      else cleanupMacFixture(fixture);
    }
  }
  const issues = [...unproducedByConsumer.values(), ...failed];
  for (const line of notExecuted.values()) t.diagnostic(line);
  assert.equal(issues.length, 0,
    `HM37 dry-run failures (${issues.length}):\n${issues.join("\n")}\n\nNot executed, non-substitutable (${notExecuted.size}):\n${[...notExecuted.values()].join("\n")}\n\nNot tested (${notTested.length}):\n${notTested.join("\n")}`);
});

function citedEvidenceFiles(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) citedEvidenceFiles(item, found);
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (key === "evidence" && typeof item === "string") found.add(item);
      else citedEvidenceFiles(item, found);
    }
  }
  return found;
}

test("non-substitutable surfaces are explicit", (t) => {
  const items = nonSubstitutableEntries();
  assert.ok(items.length >= 6);
  assert.ok(items.every((item) => item.surface && item.reason));
  const browser = items.find((item) => item.surface === "browser-harness" && item.step === undefined);
  assert.ok(browser, "the browser surface is declared");
  assert.match(browser.reason, /does not emulate a browser/);

  // Every block whose text starts a browser or drives one is declared, by step. The scan reads the plan text, so
  // a browser block a later edit adds is caught here.
  const declared = items.filter((item) => item.step);
  for (const block of SCOPED.flatMap(blocks)) {
    if (!/\bbrowser-harness\b|Google Chrome/.test(block.source)) continue;
    assert.ok(declared.some((item) => item.step === shortStep(block)),
      `${shortStep(block)} runs a browser and is not declared non-substitutable`);
  }
  const known = blockIndex();
  for (const entry of declared) {
    assert.ok(known.has(entry.step!), `declared step does not exist in a plan: ${entry.step}`);
    assert.ok(entry.live_proof && entry.live_proof.length > 20, `${entry.step}: no live proof named`);
    assert.ok((entry.plan_items ?? []).every((item) => /^split block /.test(item)), `${entry.step}: plan items are block splits`);
    for (const file of citedEvidenceFiles(entry)) assert.equal(existsSync(file), true, `${entry.step}: cited evidence file is missing: ${file}`);
    for (const output of entry.outputs ?? []) {
      assert.ok(/^0[0-7]{3}$/.test(output.mode) && output.file, `${entry.step}: output ${output.file} has no file mode`);
      if (output.plan_documented) {
        assert.ok(output.plan_documented.label && output.plan_documented.source_lines, `${entry.step}: plan shape has no provenance label or writer lines`);
        t.diagnostic(`${entry.step}/${output.branch}: ${output.file}: ${output.plan_documented.label}`);
      }
    }
    for (const missing of entry.unproduced ?? []) assert.ok(missing.output && missing.reason, `${entry.step}: an unproduced output has no reason`);
    for (const branch of entry.branches ?? []) {
      assert.equal(branch.status, "not tested");
      assert.ok(branch.reason && branch.source_lines, `${entry.step}: untested branch has no explanation or evidence lines`);
      assert.equal((entry.outputs ?? []).some((output) => output.branch === branch.branch), false,
        `${entry.step}: untested branch must not seed outputs`);
      t.diagnostic(`${entry.step}/${branch.branch}: NOT TESTED; ${branch.reason}`);
    }
    t.diagnostic(`${entry.step}: ${entry.surface}; live proof: ${entry.live_proof}; outputs seeded: ${(entry.outputs ?? []).map((output) => output.file).join(", ") || "none"}; unproduced: ${(entry.unproduced ?? []).map((missing) => missing.output).join(", ") || "none"}`);
  }
  // The site build is declared too, with the evidence each fixture file's shape comes from.
  const build = items.find((item) => /site build/.test(item.surface));
  assert.ok(build && build.live_proof, "the site build is declared with its live proof");
  assert.ok((build.shape_evidence ?? []).length >= 3, "the site build cites the evidence its fixture shape comes from");
  for (const shape of build.shape_evidence ?? []) assert.equal(existsSync(shape.file), true, `site build shape evidence is missing: ${shape.file}`);
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

test("controls: box mode refuses to run a block when the runner guard is not satisfied", {
  skip: process.env.BOX_DRY_RUN_PART !== "box" ? "requires the disposable Linux root CI runner" : false,
}, () => {
  const refusedGuard = boxRunnerGuard(explicitEnvironment({ BOX_DRY_RUN: "1", GITHUB_ACTIONS: "true", CI: "false" }));
  assert.equal(refusedGuard.available, false);
  assert.match(refusedGuard.detail, /REFUSE: CI=true is required/);
  const runnerCi = process.env.CI;
  try {
    process.env.CI = "false";
    assert.throws(() => prepareBoxFixture("s2"), /CONTAINMENT UNAVAILABLE: REFUSE: CI=true is required/);
    assert.equal(pathExists("/home/commonswarm"), false, "refused guard created a fixture");
    assert.equal(pathExists("/srv/commonswarm"), false, "refused guard created a fixture");
  } finally {
    if (runnerCi === undefined) delete process.env.CI;
    else process.env.CI = runnerCi;
  }
  const fixture = prepareBoxFixture("s2");
  const block: Block = {
    file: "runner-guard-control", step: "runner-guard-control", marker: "yes", host: "box /bin/bash 5.2 as root",
    line: 1, source: "printf '%s\\n' block-ran",
  };
  try {
    const accepted = executeWholeBlock(block, fixture);
    assert.equal(accepted.result, "passed", accepted.stderr);
    assert.equal(accepted.stdout, "block-ran\n");
    // This fixture did not receive admission from a successful guard, even though its env is identical.
    const refused = executeWholeBlock(block, { ...fixture });
    assert.equal(refused.result, "failed");
    assert.equal(refused.status, 71);
    assert.match(refused.stderr, /CONTAINMENT UNAVAILABLE: disposable runner guard is not satisfied/);
    assert.equal(refused.stdout, "", "the refused block reached a shell");
  } finally {
    cleanupBoxFixture(fixture);
  }
});

test("controls: the box lane writes resolved prompt inputs by name", {
  skip: process.env.BOX_DRY_RUN_PART !== "box" ? "requires the disposable Linux root CI runner" : false,
}, () => {
  const block = planBlock(HM37, "hm37a-resolved-input-transfer");
  const fixture = prepareBoxFixture("s2", [block]);
  const target = join(PROOF_DIR, "item-resolved-inputs.env");
  try {
    assert.equal(pathExists(target), false, "prompt file was seeded before its transfer boundary");
    // Include shell-sensitive and multiline bytes: the file must restore values, not execute their text.
    fixture.env.APPROVER = "operator's $(exit 31)\nsecond line";
    const records = executePlanUntilFailure([block], fixture, "box");
    assert.equal(records.length, 1);
    assert.equal(records[0]!.execution.result, "not-executed", "skipped Mac transfer was reported as executed");
    assert.deepEqual(records[0]!.execution.seeded, [target]);
    assert.match(notExecutedLine(block, records[0]!.execution), /Seeded from committed evidence: nothing\. Plan-documented output: item-resolved-inputs\.env/);
    const bytes = readFileSync(target, "utf8");
    assert.doesNotMatch(bytes, /\[object Object\]|=undefined/);
    const names = fixture.promptInputs.map(({ name }) => name);
    assert.equal([...bytes.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].length, names.length);
    const restored = containedCommand(fixture, "/bin/bash", ["-c",
      `set -euo pipefail; . "$1"; printf '%s\\0' ${names.map((name) => `"$${name}"`).join(" ")}`,
      "prompt-readback", target], { env: fixture.env });
    assert.equal(restored.status, 0, restored.stderr);
    assert.equal(restored.stdout, names.map((name) => fixture.env[name]).join("\0") + "\0");
    const stat = lstatSync(target);
    assert.equal(stat.mode & 0o777, 0o600);
    assert.equal(stat.uid, 0);
    assert.equal(stat.gid, 0);
    // A missing resolution fails at the producer instead of serializing undefined.
    delete fixture.env[names[0]!];
    assert.throws(() => executePlanUntilFailure([block], fixture, "box"), /unresolved prompt input:/);
    assert.equal(readFileSync(target, "utf8"), bytes, "failed resolution overwrote the prior prompt file");
  } finally {
    cleanupBoxFixture(fixture);
  }
});

test("controls: box window B handoff accepts A's dark final state and refuses mismatched state", {
  skip: process.env.BOX_DRY_RUN_PART !== "box" ? "requires the disposable Linux root CI runner" : false,
}, () => {
  const block = planBlock(HM37B, "hm37b-box-open");
  const fixture = prepareBoxFixture("s2", [block]);
  const current = "/home/commonswarm/edge/current";
  try {
    assert.equal(realpathSync(current), windowAFinalEdge());
    assert.equal(pathExists(PROOF_DIR), false);
    fixture.env.BOX_DRY_RUN_EDGE_PUBLIC_ENABLED = "1";
    assert.throws(() => seedBoxWindowBOpen(block, fixture), /A's PASSED final edge must remain dark/);
    assert.equal(pathExists(PROOF_DIR), false, "public-enabled handoff opened B");
    fixture.env.BOX_DRY_RUN_EDGE_PUBLIC_ENABLED = EDGE_PUBLIC_ENABLED;
    unlinkSync(current);
    symlinkSync(PREVIOUS_EDGE, current);
    assert.throws(() => seedBoxWindowBOpen(block, fixture), /B handoff requires A's PASSED final edge state/);
    assert.equal(pathExists(PROOF_DIR), false, "previous-edge handoff opened B");
    unlinkSync(current);
    symlinkSync(windowAFinalEdge(), current);
    const record = seedBoxWindowBOpen(block, fixture);
    assert.equal(record?.result, "not-executed", "synthetic handoff was reported as an executed Mac transfer");
    assert.deepEqual(record.seeded, [join(PROOF_DIR, "window.env")]);
    // Read shell assignments through the same shell that consumes them; quoting is valid receipt syntax.
    const window = containedCommand(fixture, "/bin/bash", ["-c",
      '. "$1"; printf "%s\\n" "$SHA"', "window-readback", join(PROOF_DIR, "window.env")], { env: fixture.env });
    assert.equal(window.status, 0, window.stderr);
    assert.equal(window.stdout, `${RELEASE_SHA}\n`);
    assert.equal(pathExists(join(PROOF_DIR, "GO.txt")), false, "handoff supplied B's later GO producer");
    const go = executeWholeBlock(planBlock(HM37B, "hm37b-go-record"), fixture);
    assert.equal(go.result, "passed", go.stderr);
    assert.match(readFileSync(join(PROOF_DIR, "GO.txt"), "utf8"), /^HM37_A_CLOSE_RECEIPT=accepted$/m);
    const goStat = statSync(join(PROOF_DIR, "GO.txt"));
    assert.equal(goStat.uid, 0);
    assert.equal(goStat.gid, 0);
    assert.equal(goStat.mode & 0o777, 0o600);
    const missingChown = executeWholeBlock({ ...block, file: "ownership-control", step: "ownership-control",
      host: "box /bin/bash 5.2 as root", source: `chown root:root '${PROOF_DIR}/missing.txt'` }, fixture);
    assert.equal(missingChown.result, "failed", "chown accepted a missing fixture file");
    assert.equal(pathExists(join(PROOF_DIR, "missing.txt")), false);
  } finally {
    cleanupBoxFixture(fixture);
  }
});
