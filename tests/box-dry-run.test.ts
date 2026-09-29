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
const PREP = "docs/evidence/2026-09-29-hm37-prep/BOX-WINDOW.md";
const HM37 = "docs/evidence/2026-09-28-box-hm37/BOX-WINDOW.md";
const HM37B = "docs/evidence/2026-09-29-box-hm37b/BOX-WINDOW.md";
const SITE = "docs/evidence/2026-09-28-site-hm8/SITE-RELEASE.md";
const TEMPLATE = "docs/design/BOX-PLAN-TEMPLATE.md";
const SCOPED = [PREP, HM37, HM37B, RUNBOOK, SITE, TEMPLATE];
const GUARD = "tests/box-dry-run/guard.sh";
const STUB = "tests/box-dry-run/stubs/dispatch.sh";
const PRELUDE = resolve("tests/box-dry-run/prelude.sh");
const PYTHON_FIXTURE = resolve("tests/box-dry-run/python");
const PRESEED_ALLOWLIST_FILE = "tests/box-dry-run/fixtures/preseed-allowlist.json";
const COMMAND_OUTPUTS_FILE = "tests/box-dry-run/fixtures/command-outputs.json";
const MEASURED_FACTS_FILE = "docs/evidence/2026-09-29-box-facts/box-facts-measured.json";
const OAUTH_IMAGE_FILE = "docs/evidence/2026-09-28-release-826db6a34f23-v5/oauth-image.json";
const OAUTH_RUNTIME_FILE = "docs/evidence/2026-09-28-release-826db6a34f23-v5/oauth-runtime.json";
const SITE_SHA = "8b8989f2b29e440a317a2cdedf11195901c8342c";
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

type PreseedKind = "path" | "env" | "command-output" | "prompt";

interface PreseedAllowlistItem {
  kind: PreseedKind;
  name: string;
  source: string;
  evidence?: string;
  value?: string;
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
].sort();

function explicitEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    LANG: "C.UTF-8",
    TZ: "UTC",
    ...extra,
  };
}

function assertChildEnvironmentAllowed(environment: NodeJS.ProcessEnv): void {
  const allowed = new Set(PRESEED_ALLOWLIST.filter((item) => item.kind === "env" || item.kind === "prompt").map((item) => item.name));
  for (const name of Object.keys(environment)) assert.ok(allowed.has(name), `block shell received non-allowlisted env ${name}`);
}

function syntheticPromptEnvironment(temporary: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const item of PRESEED_ALLOWLIST.filter((candidate) => candidate.kind === "prompt")) {
    assert.ok(item.value);
    environment[item.name] = item.value.startsWith("/synthetic/")
      ? join(temporary, "prompt-inputs", item.value.slice("/synthetic/".length))
      : item.value;
  }
  return environment;
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
const SITE_BASE_PREFIX = SITE_BASE_RELEASE.split("-")[1]!;
const baseResult = spawnSync("git", ["rev-parse", `${SITE_BASE_PREFIX}^{commit}`], { encoding: "utf8" });
assert.equal(baseResult.status, 0, baseResult.stderr);
const BASE_SHA = baseResult.stdout.trim();
const OAUTH_RELEASE = measuredProductionMatch(/oauth_current=([^\n]+)/);
const EDGE_MEMORY = Number(measuredMatch("M11", /memory=(\d+)/));
const EDGE_NETWORK = measuredMatch("M11", /network=([^ ]+)/);
const TARGET_ENV_NAME = measuredMatch("M8", /^(TARGET_DATABASE_URL)$/m);
const ACCOUNT_NAMES = measuredFact("M3").output.split("\n")
  .filter((line) => line.split(":").length >= 7)
  .map((line) => line.split(":", 1)[0]!)
  .filter(Boolean);
assert.equal(ACCOUNT_NAMES.length, 4);
assert.equal(new Set(ACCOUNT_NAMES).size, ACCOUNT_NAMES.length);
const STUB_COMMANDS = [
  "docker", "systemctl", "psql", "caddy", "ssh", "scp", "sudo", "op", "curl", "chown", "tar", "deno", "python3", "sleep", "cswarm",
];

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

function fencedLanguages(file: string): string[] {
  return [...readFileSync(file, "utf8").matchAll(/^```([^\s`]*)[^\n]*$/gm)]
    .map((match) => match[1])
    .filter(Boolean);
}

function namedPromptInputs(file: string): string[] {
  const markdown = readFileSync(file, "utf8");
  const heading = markdown.indexOf("Named prompt inputs");
  assert.ok(heading >= 0, `${file}: missing Named prompt inputs section`);
  const lines = markdown.slice(heading).split("\n");
  const firstRow = lines.findIndex((line) => line.startsWith("| Name |"));
  assert.ok(firstRow >= 0, `${file}: named-input table is missing`);
  const table = lines.slice(firstRow).findIndex((line, index) => index > 1 && !line.startsWith("|"));
  const section = lines.slice(firstRow, table < 0 ? undefined : firstRow + table).join("\n");
  return [...section.matchAll(/^\| `([A-Z][A-Z0-9_]+)` \|/gm)].map((match) => match[1]!);
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
  const oauthProofDir = `/home/commonswarm/stack/release-proofs/${basename(OAUTH_RELEASE)}`;
  files[`${PROOF_DIR}/oauth-image.id`] = { bytes: `${OAUTH_IMAGE_EVIDENCE.local_image_id}\n`, owner: "root", group: "root" };
  files[`${oauthProofDir}/oauth-image.id`] = { bytes: `${OAUTH_IMAGE_EVIDENCE.local_image_id}\n`, owner: "root", group: "root" };
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
    model.files[`/home/commonswarm/stack/release-proofs/${basename(OAUTH_RELEASE)}/oauth-image.id`]?.bytes.trim() ?? "<missing>");
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

function removeOwnedTemporary(path: string, prefix: string): void {
  const resolved = resolve(path);
  assert.equal(dirname(resolved), resolve(tmpdir()));
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
  assert.deepEqual(named.slice(0, 2), ["hm37-hosted-control-cleanup-only", "hm37b-failure-dispatch"]);
  const close = success.slice(success.indexOf("hm37-deno-remove"));
  assert.ok(close.length > 0, "window-b close tail is absent from the successful order");
  return new Map([
    ["pass", success],
    ["abort", [
      ...beforeStep("window-b abort", success, "hm37-hosted-open-ack-control"),
      ...named.slice(0, 2),
      ...close,
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
const NAMED_PROMPT_INPUTS = new Set(PRESEED_ALLOWLIST.filter((item) => item.kind === "prompt").map((item) => item.name));

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

function discoverUnproducedReads(planBlocks: Block[]): UnproducedRead[] {
  const reads: UnproducedRead[] = [];
  const seen = new Set<string>();
  const add = (block: Block, what: string, offset: number, earlier: Block[]): void => {
    const sameBlockPrefix: Block = { ...block, source: block.source.slice(0, offset) };
    if (matchingProducer(what, [...earlier, sameBlockPrefix])) return;
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
      if (!PLAN_ENV_ALLOWLIST.has(name) && !NAMED_PROMPT_INPUTS.has(name) && !name.startsWith("BOX_DRY_RUN_")) {
        add(block, name, match.index!, earlier);
      }
    }
    for (const match of block.source.matchAll(UNRESOLVED_INPUT)) add(block, match[0], match.index!, earlier);
    for (const match of block.source.matchAll(PLAN_FILE_INPUT)) {
      if (shortStep(block) === "hm37-source-identity") continue;
      if (/^\$(?:CONTROL_ROOT|INPUT_ROOT)\//.test(match[0])) continue;
      const before = block.source.slice(0, match.index);
      const currentLine = block.source.slice(block.source.lastIndexOf("\n", match.index) + 1, block.source.indexOf("\n", match.index));
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
}

function currentPlannedRuns(): PlannedRun[] {
  const runs: PlannedRun[] = [{ label: "prep/pass", blocks: resolveSteps("prep/pass", prepSuccessOrder()) }];
  for (const state of ["s1", "s2", "s3", "s4", "s5"]) {
    for (const [path, steps] of windowAPaths()) {
      runs.push({ label: `window-a/${state}/${path}`, blocks: resolveSteps(`window-a/${state}/${path}`, steps) });
    }
  }
  for (const [path, steps] of windowBPaths()) {
    runs.push({ label: `window-b/${path}`, blocks: resolveSteps(`window-b/${path}`, steps) });
  }
  for (const branch of ["FULL-CONTROL", "REDUCED-CONTROL"]) {
    runs.push({ label: `lane-8/${branch}`, blocks: resolveSteps(`lane-8/${branch}`, siteOrder()) });
  }
  return runs;
}

function unproducedReport(runs: PlannedRun[] = currentPlannedRuns()): string[] {
  return runs.flatMap((run) => discoverUnproducedReads(run.blocks).map((read) =>
    `UNPRODUCED ${read.what} read by ${shortStep(read.block)} at ${read.block.file}:${sourceLineAt(read.block, read.offset)} [run=${run.label} plan=${read.plan}]`,
  ));
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
  replacedDirectory?: { path: string; mode: number; uid: number; gid: number };
  model?: BoxFixtureModel;
  denoZip?: string;
  denoZipDigest?: string;
  seededPaths?: string[];
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
  for (const command of STUB_COMMANDS) {
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
  makeStubBin(bin);
  return {
    temporary, cwd: process.cwd(), home, bin, log,
    prelude: PRELUDE,
    pythonFixture: PYTHON_FIXTURE,
    sourceRoot: process.cwd(),
    env: explicitEnvironment({
      ...syntheticPromptEnvironment(temporary),
      HOME: home,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      BOX_DRY_RUN_STUB_LOG: log,
      BOX_DRY_RUN_PYTHON_FIXTURE: PYTHON_FIXTURE,
      BOX_DRY_RUN_EXPECTED_EDGE: PREVIOUS_EDGE,
      BOX_DRY_RUN_EDGE_MEMORY: String(EDGE_MEMORY),
      BOX_DRY_RUN_EDGE_NETWORK: EDGE_NETWORK,
    }),
  };
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
    `PREVIOUS_EDGE='${PREVIOUS_EDGE}'`,
    `PREVIOUS_STACK='${PREVIOUS_STACK}'`,
    "RECYCLE_TIMER_STOPPED='0'", "BACKUP_TIMERS_STOPPED='0'",
    "MCP_CADDY_SITE='/etc/caddy/sites/12-commonswarm-mcp.caddy'",
    `RELEASE_DIR_STATE='${edgeState === stackState ? edgeState : "mixed"}'`,
    `EDGE_RELEASE_DIR_STATE='${edgeState}'`, `STACK_RELEASE_DIR_STATE='${stackState}'`, "",
  ].join("\n");
}

function prepareBoxFixture(state: string): Fixture {
  assert.equal(process.env.BOX_DRY_RUN_PART, "box");
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
  writeMode(measuredDbHelper, "#!/bin/sh\nexit 69\n", 0o775);
  mkdirSync("/home/commonswarm/edge", { recursive: true });
  mkdirSync("/home/commonswarm/stack", { recursive: true });
  for (const path of ["/home/commonswarm/edge", "/home/commonswarm/stack"]) chmodSync(path, 0o755);
  symlinkSync(previousEdge, "/home/commonswarm/edge/current");
  symlinkSync(previousStack, "/home/commonswarm/stack/current");

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
  writeMode("/etc/commonswarm-release/target.env", `${TARGET_ENV_NAME}=postgres://placeholder\n`, 0o600);
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
  writeMode(join(measuredSiteRelease, "download/index.html"), "0.1.80\n", 0o644);
  mkdirSync("/srv/commonswarm/site", { recursive: true });
  symlinkSync(measuredSiteRelease, "/srv/commonswarm/site/current");
  const targetEdge = CANDIDATE_EDGE;
  const targetStack = CANDIDATE_STACK;
  if (state !== "s1") {
    for (const release of [targetEdge, targetStack]) {
      mkdirSync(release, { recursive: true });
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

  const normalizeSeededPath = (path: string): string => path
    .replace(PREVIOUS_EDGE, "/home/commonswarm/edge/releases/<previous>")
    .replace(PREVIOUS_STACK, "/home/commonswarm/stack/releases/<previous>")
    .replace(CANDIDATE_EDGE, "/home/commonswarm/edge/releases/<candidate>")
    .replace(CANDIDATE_STACK, "/home/commonswarm/stack/releases/<candidate>")
    .replace(new RegExp(`${PROOF_DIR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.closed-window-[^/]+`),
      "/home/commonswarm/stack/release-proofs/<closed>")
    .replace(measuredSiteRelease, "/srv/commonswarm/site/releases/<previous>");
  const seededPaths = [
    "/home/commonswarm/edge/current", "/home/commonswarm/stack/current",
    previousEdge, join(previousEdge, "RELEASE_SHA"), previousStack, join(previousStack, "RELEASE_SHA"),
    targetEdge, join(targetEdge, "RELEASE_SHA"), targetStack, join(targetStack, "RELEASE_SHA"),
    ...CLOSED_PROOF_PATHS,
    "/etc/commonswarm-oauth/database-credentials", "/etc/commonswarm-oauth/service.env",
    "/etc/ssl/yulan-internal-ca.pem", "/etc/commonswarm-release/target.env", measuredDbHelper,
    "/var/backups/commonswarm-postgres/status.json", "/home/commonswarm/.env", "/usr/local/bin",
    "/srv/commonswarm/site/current", measuredSiteRelease,
    join(measuredSiteRelease, "app/index.html"), join(measuredSiteRelease, "download/index.html"),
  ].filter(pathExists).map(normalizeSeededPath).filter((path, index, paths) => paths.indexOf(path) === index).sort();

  return {
    temporary, cwd: process.cwd(), home: "/root", bin, log, model,
    prelude, pythonFixture, sourceRoot, supportRoot, rootDirectories,
    denoZip, denoZipDigest, seededPaths,
    replacedRuntime: { path: DENO_PATH, ...(originalDeno ? { backup: originalDeno } : {}) },
    replacedDirectory: {
      path: "/usr/local/bin", mode: originalUsrLocalBin.mode & 0o777,
      uid: originalUsrLocalBin.uid, gid: originalUsrLocalBin.gid,
    },
    env: explicitEnvironment({
      ...syntheticPromptEnvironment(temporary),
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      BOX_DRY_RUN_STUB_LOG: log,
      BOX_DRY_RUN_PYTHON_FIXTURE: pythonFixture,
      BOX_DRY_RUN_EXPECTED_EDGE: previousEdge,
      BOX_DRY_RUN_PSQL_IMAGE: PSQL_IMAGE,
      BOX_DRY_RUN_POSTGRES_IMAGE_ID: model.containers.postgres.image,
      BOX_DRY_RUN_SITE_BASE_RELEASE: SITE_BASE_RELEASE,
      BOX_DRY_RUN_EDGE_HEALTH: model.containers.edge.health,
      BOX_DRY_RUN_EDGE_WORKDIR: model.containers.edge.labels["com.docker.compose.project.working_dir"],
      BOX_DRY_RUN_EDGE_MOUNTS: model.containers.edge.mounts.map((mount) => `${mount.source} ${mount.destination}`).join("\n"),
      BOX_DRY_RUN_EDGE_MEMORY: model.containers.candidateEdge.memory,
      BOX_DRY_RUN_EDGE_NETWORK: model.containers.candidateEdge.network,
      BOX_DRY_RUN_CANDIDATE_EDGE: CANDIDATE_EDGE,
      BOX_DRY_RUN_RELEASE_SHA: RELEASE_SHA,
    }),
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
  writeRootMode(`/run/commonswarm-release-${RELEASE_SHA}-apply.sql`, "-- unit control\n");
  writeRootMode(`/run/commonswarm-release-${RELEASE_SHA}-session.sh`, [
    `STACK_RELEASE='${CANDIDATE_STACK}'`,
    `MIGRATE='${CANDIDATE_STACK}/deploy/supabase-stack/migrate'`,
    `PROOF_DIR='${PROOF_DIR}'`,
    `APPLY_SQL='/run/commonswarm-release-${RELEASE_SHA}-apply.sql'`,
    "release_psql() { printf '%s\\n' t; }",
    "release_psql_ro() { :; }",
    "",
  ].join("\n"));
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

function executePlanUntilFailure(planBlocks: Block[], fixture: Fixture, part: FixturePart): Array<{ block: Block; execution: Execution }> {
  const records: Array<{ block: Block; execution: Execution }> = [];
  for (const block of planBlocks) {
    if (block.host.startsWith("box ") !== (part === "box")) continue;
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

function executeWholeBlock(
  block: Block,
  fixture: Fixture,
  options: {
    fail?: boolean;
    control?: string;
    env?: NodeJS.ProcessEnv;
    unsetEnv?: string[];
    trapErrors?: boolean;
  } = {},
): Execution {
  const step = shortStep(block);
  let body = materialize(block);
  if (fixture.temporary) body = body.replaceAll("/Users/yulanbot/anvil-work/hm37-prep", join(fixture.temporary, "hm37-prep"));
  const script = [
    "set -E", `source ${JSON.stringify(fixture.prelude)}`,
    options.trapErrors === false
      ? "trap - ERR"
      : "trap 'block_status=$?; printf \"__FIRST_FAIL__:%s\\n\" \"$BASH_COMMAND\" >&2; exit \"$block_status\"' ERR",
    body,
  ].join("\n");
  const childEnv: NodeJS.ProcessEnv = {
    ...fixture.env,
    ...options.env,
    BOX_DRY_RUN_STEP: step,
    BOX_DRY_RUN_FAIL_STEP: options.fail ? step : "",
    BOX_DRY_RUN_CONTROL: options.control ?? "",
  };
  for (const name of options.unsetEnv ?? []) delete childEnv[name];
  assertChildEnvironmentAllowed(childEnv);
  const result = spawnSync("/bin/bash", [], {
    cwd: fixture.cwd,
    input: script,
    encoding: "utf8",
    env: childEnv,
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
  assert.equal(blocks(PREP).length, 5);
  assert.equal(blocks(HM37).length, 29);
  assert.equal(blocks(HM37B).length, 21);
  assert.equal(blocks(RUNBOOK).length, 67);
  assert.equal(blocks(SITE).length, 15);
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
  assert.match(stepSource(runbook, "runbook-03"), /\. \/home\/commonswarm\/stack\/release-proofs\/<sha>\/window\.env/);
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

test("runbook-01 fails clearly unless WINDOW_START_UTC is a valid approved UTC input", () => {
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
  skip: process.env.BOX_DRY_RUN_PART === "box",
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
    for (const command of STUB_COMMANDS) {
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

test("pre-seed allowlist is measured or a fixed named prompt input", (t) => {
  assert.ok(PRESEED_ALLOWLIST.length > 0);
  const identities = PRESEED_ALLOWLIST.map((item) => `${item.kind}:${item.name}`);
  assert.equal(new Set(identities).size, identities.length, "duplicate pre-seed allowlist entry");
  assert.deepEqual(
    PRESEED_ALLOWLIST.filter((item) => item.kind === "path").map((item) => item.name).sort(),
    PLAN_VISIBLE_PATH_PRESEEDS,
    "fixture path seeds and pre-seed allowlist differ",
  );
  const declaredPrompts = [...new Set([PREP, HM37, HM37B, SITE].flatMap(namedPromptInputs))].sort();
  assert.deepEqual(
    PRESEED_ALLOWLIST.filter((item) => item.kind === "prompt").map((item) => item.name).sort(),
    declaredPrompts,
    "synthetic prompt seeds differ from the names declared by the four plans",
  );
  const bySource = new Map<string, number>();
  for (const item of PRESEED_ALLOWLIST) {
    assert.match(item.kind, /^(?:path|env|command-output|prompt)$/);
    assert.ok(item.name);
    bySource.set(item.source, (bySource.get(item.source) ?? 0) + 1);
    if (item.source.startsWith("prompt:")) {
      assert.match(item.source, /^prompt:[A-Z][A-Z0-9_]+$/);
      assert.ok(item.value && !item.value.includes("\n"), `${item.source} must have one fixed synthetic value`);
      continue;
    }
    assert.match(item.source, /^(?:M(?:[1-9]|1[0-9]|20)|K4-[1-9])$/);
    assert.ok(item.evidence, `${item.source}/${item.name} has no evidence needle`);
    const fact = citedFact(item.source);
    const measuredText = JSON.stringify(fact);
    assert.ok(measuredText.includes(item.evidence),
      `${item.source} does not measure allowlisted ${item.kind} ${item.name}: missing ${item.evidence}`);
  }
  for (const [source, count] of [...bySource].sort()) t.diagnostic(`preseed_source=${source} count=${count}`);
});

test("block shells use an explicit empty-base environment and plan code cannot read adapter variables", () => {
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

test("stubs do not return synthetic whole-step success", () => {
  const prelude = readFileSync("tests/box-dry-run/prelude.sh", "utf8");
  const dispatch = readFileSync("tests/box-dry-run/stubs/dispatch.sh", "utf8");
  assert.doesNotMatch(prelude, /dry-run (?:python|node) PASS/);
  assert.match(prelude, /python3\(\)[\s\S]*?command python3 "\$@"/);
  assert.match(prelude, /node\(\)[\s\S]*?command node "\$@"/);
  assert.doesNotMatch(dispatch, /dry-run [A-Za-z0-9_-]+ PASS/);
  assert.doesNotMatch(prelude, /case "\$\{BOX_DRY_RUN_STEP/);
  assert.doesNotMatch(dispatch, /case "\$\{BOX_DRY_RUN_STEP/);
  assert.doesNotMatch(dispatch, /if \[ "\$\{BOX_DRY_RUN_STEP/);
  assert.doesNotMatch(dispatch, /BOX_DRY_RUN_CANDIDATE_EDGE_WORKDIR/);
});

test("current plans derive every audited operator input as UNPRODUCED", (t) => {
  const report = unproducedReport();
  assert.ok(report.length > 0);
  assert.equal(new Set(report).size, report.length);
  const allowlistedPlanInputs = PRESEED_ALLOWLIST.filter((item) =>
    item.kind === "prompt",
  );
  for (const item of allowlistedPlanInputs) {
    assert.ok(!report.some((line) => line.includes(`UNPRODUCED ${item.name} read by `)),
      `legitimate ${item.source} pre-seed was reported as unproduced: ${item.name}`);
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
    { label: "pre-revision/window-a", blocks: oldWindow },
    { label: "pre-revision/lane-8", blocks: blocksFromMarkdown(SITE, oldSiteMarkdown) },
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

test("controls: a block that exits non-zero is reported as failed, never as passed", () => {
  const fixture = prepareMacFixture();
  try {
    const block: Block = {
      file: "tests/box-dry-run/synthetic-nonzero.md", step: "synthetic-nonzero",
      marker: "no", host: "Mac mini /bin/bash 3.2", line: 1,
      source: "# step: synthetic-nonzero\n# readonly: no\n# host: Mac mini /bin/bash 3.2\n( set -euo pipefail; exit 23 )\n",
    };
    const execution = executeWholeBlock(block, fixture);
    assert.equal(execution.result, "failed");
    assert.notEqual(execution.result, "passed");
  } finally {
    cleanupMacFixture(fixture);
  }
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
    for (const command of STUB_COMMANDS) {
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
      fixture = prepareBoxFixture(state);
    } else {
      fixture = prepareMacFixture();
    }
    try {
      const records = executePlanUntilFailure(planBlocks, fixture, part);
      assert.ok(records.length > 0, `${part}/${state} selected no blocks`);
      const failures = records.filter(({ execution }) => execution.result === "failed");
      const expected = unproducedReport().some((line) => line.includes(`[run=window-a/${state}/pass `));
      assert.equal(failures.length, expected ? 1 : 0,
        `${part}/${state} whole-plan result disagrees with the derived dependency report`);
      if (failures[0]) t.diagnostic(`${description}: ${executionUnproducedLine(failures[0].block, failures[0].execution, state)}`);
      t.diagnostic(`${part}:${state}: ${records.map(({ execution }) => `${execution.step}=${execution.result}`).join(",")}`);
    } finally {
      if (part === "box") cleanupBoxFixture(fixture);
      else cleanupMacFixture(fixture);
    }
    const lines = unproducedReport().filter((line) => line.includes(`[run=window-a/${state}/pass `));
    assert.ok(lines.length > 0, `${state} derived report is incomplete`);
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
  const fixture = prepareBoxFixture("s2");
  produceRunbook18UnitPrerequisites(fixture);
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

test("lane 8 executes its declared plan and reports current unproduced inputs", (t) => {
  const site = blocks(SITE);
  assert.equal(site.length, 15);
  assert.deepEqual(site.map(shortStep), [
    "site-00-source-checkout", "site-01", "site-00-a-close-ingest", "site-00-build-env", "site-02",
    "site-03-browser-session-preflight", "site-03", "site-03-pin-previous", "site-03-go-record", "site-04",
    "site-04-reconcile-failure", "site-05", "site-05-browser-acceptance", "site-06", "site-07-manifest-close",
  ]);
  const report = unproducedReport().filter((line) => line.includes("[run=lane-8/FULL-CONTROL "));
  const fixture = prepareMacFixture();
  try {
    const records = executePlanUntilFailure(resolveSteps("lane-8", siteOrder()), fixture, "mac");
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

test("HM37 plans are UNPRODUCED-free and every block passes", () => {
  const unproducedByConsumer = new Map<string, string>();
  for (const line of unproducedReport()) {
    const key = line.replace(/ \[run=.*$/, "");
    if (!unproducedByConsumer.has(key)) unproducedByConsumer.set(key, line);
  }
  const failed: string[] = [];
  const part: FixturePart = process.env.BOX_DRY_RUN_PART === "box" ? "box" : "mac";
  for (const run of currentPlannedRuns()) {
    let fixture: Fixture;
    if (part === "box") {
      const guard = spawnSync("/bin/bash", [GUARD], { encoding: "utf8", env: process.env });
      assert.equal(guard.status, 0, guard.stderr);
      const state = /^window-a\/(s[1-5])\//.exec(run.label)?.[1] ?? "s2";
      fixture = prepareBoxFixture(state);
    } else {
      fixture = prepareMacFixture();
    }
    try {
      const records = executePlanUntilFailure(run.blocks, fixture, part);
      for (const { block, execution } of records) {
        if (execution.result === "failed") {
          const detail = execution.firstFailingCommand ?? execution.stderr.trim().split("\n")[0] ?? "unknown";
          const line = `failed block ${block.file}:${block.line} [run=${run.label} step=${shortStep(block)}] ${detail}`;
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
  assert.equal(issues.length, 0, `HM37 dry-run failures (${issues.length}):\n${issues.join("\n")}`);
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
