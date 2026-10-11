import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const REPO = new URL("../../", import.meta.url).pathname;
const STACK_DIR = "deploy/supabase-stack";
const read = (rel: string): string => readFileSync(join(REPO, rel), "utf8");

const LIB_SH = "deploy/supabase-stack/migrate/lib.sh";
const DUMP_SH = "deploy/supabase-stack/migrate/dump-source.sh";
const PYTHON_SETS = [
  "deploy/supabase-stack/backup/restore-drill.py",
  "deploy/supabase-stack/backup/upload-snapshot.py",
];
const MANIFEST_FIXTURES = [
  "deploy/supabase-stack/backup/test_restore_drill.py",
  "deploy/supabase-stack/backup/test_upload_snapshot.py",
];
// Files that may hold a schema-list literal besides the four sources and the fixtures above.
// Each entry needs a reason; the scan fails on any other file.
const HISTORICAL_H0_REASON =
  "historical H0 upgrade path; FOLLOW-UPS-C1 #39 aligns or retires it before any reuse";
const EXCLUDED_LITERAL_HOLDERS = new Map<string, string>([
  ["deploy/supabase-stack/migrate/verify-post-upgrade-counts.sh", HISTORICAL_H0_REASON],
  ["deploy/supabase-stack/migrate/test-h0-upgrade.py", HISTORICAL_H0_REASON],
]);
const SOURCE_FILES = new Set([LIB_SH, ...PYTHON_SETS, ...MANIFEST_FIXTURES]);

function names(list: string, what: string): string[] {
  const out = list.split(/[\s,]+/).filter(Boolean);
  assert.ok(out.length > 0, `${what}: empty schema list`);
  assert.equal(new Set(out).size, out.length, `${what}: duplicate schema`);
  return out;
}

function bashArray(rel: string): string[] {
  const matches = [...read(rel).matchAll(/^SELECTED_SCHEMAS=\(([^)]*)\)$/gm)];
  assert.equal(matches.length, 1, `${rel}: exactly one SELECTED_SCHEMAS array`);
  return names(matches[0]![1]!, rel);
}

function pythonSet(rel: string): string[] {
  const matches = [...read(rel).matchAll(/^REQUIRED_DATABASE_SCHEMAS = frozenset\(\{([^}]*)\}\)$/gm)];
  assert.equal(matches.length, 1, `${rel}: exactly one REQUIRED_DATABASE_SCHEMAS frozenset`);
  const body = matches[0]![1]!;
  const items = [...body.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
  assert.equal(body.replace(/'[a-z_]+'|[\s,]/g, ""), "", `${rel}: only quoted names in the set`);
  return names(items.join(","), rel);
}

// The first schemas= fixture is the valid baseline; later ones are the deliberate refusal cases.
function baselineManifest(rel: string): string[] {
  const match = /'schemas=([^\\']+)\\n'/.exec(read(rel));
  assert.ok(match, `${rel}: holds a schemas= manifest fixture`);
  return names(match[1]!, rel);
}

const sorted = (list: string[]): string[] => [...list].sort();

test("the backup schema set is the same in every place and holds commonswarm_ops", () => {
  const canonical = sorted(bashArray(LIB_SH));
  assert.ok(canonical.includes("commonswarm_ops"), "lib.sh set lacks commonswarm_ops");
  for (const rel of PYTHON_SETS) {
    assert.deepEqual(sorted(pythonSet(rel)), canonical, `${rel} differs from lib.sh`);
  }
  for (const rel of MANIFEST_FIXTURES) {
    assert.deepEqual(sorted(baselineManifest(rel)), canonical, `${rel} baseline manifest differs from lib.sh`);
  }
});

test("dump-source.sh and verify-counts.sh take the set from lib.sh", () => {
  assert.match(read(DUMP_SH), /^schemas=\("\$\{SELECTED_SCHEMAS\[@\]\}"\)$/m);
  for (const rel of [DUMP_SH, "deploy/supabase-stack/migrate/verify-counts.sh"]) {
    assert.match(read(rel), /string_to_array\('\$\(selected_schema_csv\)', ','\)/, rel);
  }
});

// Four or more known schema names in a row, separated only by commas, whitespace (newlines
// included), quotes or brackets: a bash array, a CSV, a quoted list or a Python set.
function literalShape(): RegExp {
  const token = bashArray(LIB_SH).map((n) => `\\b${n}\\b`).join("|");
  return new RegExp(`(?:(?:${token})[,\\s'"()\\[\\]{}]*){4,}`);
}

test("the sixth-copy scan sees multi-line, CSV and quoted lists", () => {
  const shape = literalShape();
  const names = bashArray(LIB_SH);
  const forms: Record<string, string> = {
    "multi-line bash array": `schemas=(\n${names.map((n) => ` ${n}\n`).join("")})\n`,
    "multi-line python set": `S = frozenset({\n${names.map((n) => `    '${n}',\n`).join("")}})\n`,
    csv: `x="${names.join(",")}"\n`,
    "quoted list": `x=(${names.map((n) => `"${n}"`).join(" ")})\n`,
  };
  for (const [what, text] of Object.entries(forms)) assert.ok(shape.test(text), what);
  // Negative control in the same invocation: three names and prose are not a list.
  assert.ok(!shape.test(`schemas=(${names.slice(0, 3).join(" ")})\nthe auth and public schemas`));
});

// Git-tracked files only, so a build artifact such as __pycache__ never counts.
function trackedStackFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "-z", "--", STACK_DIR], { cwd: REPO, encoding: "utf8", timeout: 10_000 });
  return out.split("\0").filter(Boolean);
}

// Scan the named files (paths relative to the repository root, read from `root`).
function scanForLiterals(files: string[], root: string): { holders: string[]; excludedHit: number } {
  const shape = literalShape();
  const holders: string[] = [];
  let excludedHit = 0;
  for (const rel of files) {
    const path = join(root, rel);
    const info = statSync(path);
    if (!info.isFile() || info.size >= 2_000_000) continue;
    // Whole-file text, so a list split across lines is found.
    if (!shape.test(readFileSync(path, "utf8"))) continue;
    if (EXCLUDED_LITERAL_HOLDERS.has(rel)) excludedHit += 1;
    else if (!SOURCE_FILES.has(rel)) holders.push(rel);
  }
  return { holders, excludedHit };
}

test("no other file under deploy/supabase-stack holds a schema-list literal", () => {
  const { holders, excludedHit } = scanForLiterals(trackedStackFiles(), REPO);
  assert.deepEqual(holders, [], "unexpected schema-list literal; derive it from lib.sh SELECTED_SCHEMAS");
  // Positive control: the scan reaches the files it excludes, so an empty result is not a blind scan.
  assert.equal(excludedHit, EXCLUDED_LITERAL_HOLDERS.size, "scan did not reach every excluded holder");
});

test("the scan ignores untracked files and still catches a tracked one", () => {
  const dir = mkdtempSync(join(tmpdir(), "schema-scan-"));
  try {
    const rel = `${STACK_DIR}/backup/fake.pyc`;
    mkdirSync(join(dir, STACK_DIR, "backup"), { recursive: true });
    writeFileSync(join(dir, rel), `x="${bashArray(LIB_SH).join(",")}"\n`);
    // Tracked (named in the list): caught. Untracked (absent from `git ls-files`): never listed, so ignored.
    assert.deepEqual(scanForLiterals([rel], dir).holders, [rel]);
    assert.ok(!trackedStackFiles().includes(rel), "the synthetic file must not be tracked");
    assert.deepEqual(scanForLiterals(trackedStackFiles().filter((f) => f !== rel), REPO).holders, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
