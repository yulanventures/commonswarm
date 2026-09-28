/*
 * The GitHub organization is now yulanventures. The old organization name still redirects (measured 2026-09-28: the
 * old repository URL answers 301 to the new one), so a stale reference does not break today. It does mean the installer,
 * the npm package metadata and the site all point users at a name that can stop redirecting and that we no longer own.
 *
 * This test fails if an ACTIVE file names the old organization. Three kinds of place are allowed to keep the name:
 *   - historical records (docs/evidence, docs/org, CHANGELOG files): they say what was true when they were written;
 *   - comments registered in HISTORY_COMMENTS below, which record what a value WAS or what a past check measured;
 *   - files outside the scanned roots (prose docs, TODO.md, SUCCESSION-PLAN.md, AGENTS.md, uxtest/): dated records that
 *     are not shipped, installed or rendered. They are not scanned, so this test says nothing about them.
 *
 * The old name is assembled from parts so this file can scan itself without an exemption. The match is case-sensitive on
 * purpose: a lowercase "ridge-io" appears as a workspace slug in a site fixture and is not the GitHub organization.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const OLD_ORG = ["Ridge", "io"].join("-");
const NEW_ORG = "yulanventures";

/* Scanned roots. A trailing slash means a directory prefix; anything else is an exact path. */
const ACTIVE_ROOTS = [
  "install.sh",
  "package.json",
  "npm/",
  "dist-npm/",
  "scripts/",
  "site/",
  ".github/",
  "src/",
  "supabase/",
  "deploy/",
  "tests/",
];

const HISTORICAL_PREFIXES = ["docs/evidence/", "docs/org/"];
/* Document files only. A bare /^CHANGELOG/i also matched site/src/components/app/ChangeLog.astro, a rendered component. */
const HISTORICAL_BASENAME = /^CHANGELOG(\.(md|markdown|txt))?$/i;

/*
 * Comments that record the past. Each entry names a file and a distinctive substring of ONE comment-shaped line in it.
 * The line stays byte-for-byte as written. The registry is checked in both directions: every old-org line in an active
 * file must be covered here or fixed, and every entry must still resolve to exactly one comment line, so it cannot rot
 * and the same words moved into code do not pass.
 */
interface HistoryComment {
  path: string;
  substring: string;
}

const HISTORY_COMMENTS: HistoryComment[] = [
  { path: "install.sh", substring: `${OLD_ORG}/coswarm-dist — a repo that CARRIED THE RETIRED PRODUCT NAME` },
  { path: "install.sh", substring: `Repointed from ${OLD_ORG}/cloud-swarm to ${OLD_ORG}/commonswarm on 2026-08-10` },
  { path: "scripts/agent-trailers.sh", substring: `already moved once (2026-08-10, ${OLD_ORG}/commonswarm)` },
  { path: "site/src/components/SiteFooter.astro", substring: `github.com/${OLD_ORG}/commonswarm            HTTP 200   (public)` },
  { path: "site/src/components/SiteFooter.astro", substring: `github.com/${OLD_ORG}/coswarm-dist           HTTP 404` },
  { path: "site/src/components/SiteFooter.astro", substring: `github.com/${OLD_ORG}/commonswarm answers 200` },
  { path: "site/src/components/download/OtherWays.astro", substring: `curl -s https://api.github.com/repos/${OLD_ORG}/commonswarm` },
];

type Scope = "active" | "historical" | "out-of-scope";

function scopeOf(path: string): Scope {
  if (HISTORICAL_PREFIXES.some(prefix => path.startsWith(prefix)) || HISTORICAL_BASENAME.test(basename(path))) {
    return "historical";
  }
  const inRoot = ACTIVE_ROOTS.some(root => (root.endsWith("/") ? path.startsWith(root) : path === root));
  return inRoot ? "active" : "out-of-scope";
}

const COMMENT_SHAPED = /^\s*(#|\/\/|\*|\/\*|<!--)/;

interface SourceFile {
  path: string;
  text: string;
}

interface Problem {
  path: string;
  line: number;
  reason: string;
  text: string;
}

function isRegisteredHistory(path: string, line: string): boolean {
  return (
    COMMENT_SHAPED.test(line) &&
    HISTORY_COMMENTS.some(entry => entry.path === path && line.includes(entry.substring))
  );
}

/* Pure: the verdict for one file depends only on its path and text. */
function oldOrgProblems(path: string, text: string): Problem[] {
  if (scopeOf(path) !== "active") return [];
  const problems: Problem[] = [];
  text.split("\n").forEach((line, index) => {
    if (!line.includes(OLD_ORG) || isRegisteredHistory(path, line)) return;
    const reason = COMMENT_SHAPED.test(line)
      ? "a comment that is not registered in HISTORY_COMMENTS (fix it, or register it if it records the past)"
      : "code, data or copy that still names the old organization";
    problems.push({ path, line: index + 1, reason, text: line.trim().slice(0, 160) });
  });
  return problems;
}

/* Pure: each registry entry must resolve to exactly one comment-shaped line in its file. */
function historyRegistryProblems(files: SourceFile[]): string[] {
  const byPath = new Map(files.map(file => [file.path, file.text]));
  return HISTORY_COMMENTS.flatMap(entry => {
    const text = byPath.get(entry.path);
    if (text === undefined) return [`${entry.path}: registered file was not scanned`];
    const matches = text.split("\n").filter(line => COMMENT_SHAPED.test(line) && line.includes(entry.substring));
    return matches.length === 1
      ? []
      : [`${entry.path}: "${entry.substring}" matches ${matches.length} comment lines, expected exactly 1`];
  });
}

function repositoryFiles(): SourceFile[] {
  const listed = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(listed.status, 0, `git ls-files failed: ${listed.stderr}`);
  const paths = [...new Set(listed.stdout.split("\0").filter(path => path !== ""))].sort();
  const files: SourceFile[] = [];
  for (const path of paths) {
    let regular: boolean;
    try {
      // lstat, not stat: the gate links node_modules into the worktree, and a link is not a file to read.
      regular = lstatSync(join(ROOT, path)).isFile();
    } catch {
      continue; // tracked but deleted in this worktree
    }
    if (!regular) continue;
    const text = readFileSync(join(ROOT, path), "utf8");
    if (text.includes("\0")) continue; // binary
    files.push({ path, text });
  }
  return files;
}

function describe(problems: Problem[]): string {
  return problems.map(problem => `  ${problem.path}:${problem.line}  ${problem.reason}\n    ${problem.text}`).join("\n");
}

test("no active file names the old GitHub organization", () => {
  const files = repositoryFiles();
  const scopes = files.map(file => scopeOf(file.path));
  const active = files.filter((_, index) => scopes[index] === "active");
  const historical = files.filter((_, index) => scopes[index] === "historical");

  // The scan must have reached the surfaces this test exists to protect, or an empty result proves nothing.
  const activePaths = new Set(active.map(file => file.path));
  for (const required of [
    "install.sh",
    "npm/package.template.json",
    "dist-npm/package.json",
    "site/astro.config.mjs",
    "site/src/components/SiteFooter.astro",
    "site/src/components/app/ChangeLog.astro",
    "site/src/components/download/OtherWays.astro",
    "site/src/components/seo/AboutCommonSwarm.astro",
    "tests/rebrand-active-refs.test.ts",
  ]) {
    assert.ok(activePaths.has(required), `${required} was not scanned as an active file`);
  }
  assert.ok(active.length > 100, `only ${active.length} active files were scanned`);

  // Positive control in the same run: the historical exclusion is exercised by real files that DO name the old org.
  const historicalWithOldOrg = historical.filter(file => file.text.includes(OLD_ORG));
  assert.ok(
    historicalWithOldOrg.length > 0,
    "no historical file names the old organization, so the historical exclusion was never exercised",
  );

  // Positive control on the real files: injecting the old org into a real installer and a real component is caught.
  for (const path of ["install.sh", "site/src/components/SiteFooter.astro"]) {
    const real = files.find(file => file.path === path);
    assert.ok(real, `${path} not found`);
    const injected = oldOrgProblems(path, `${real.text}\nREPO="https://github.com/${OLD_ORG}/commonswarm"\n`);
    assert.equal(injected.length, oldOrgProblems(path, real.text).length + 1, `${path}: an injected reference was not caught`);
  }

  const problems = active.flatMap(file => oldOrgProblems(file.path, file.text));
  assert.deepEqual(problems, [], `active files still name the old organization; use ${NEW_ORG}:\n${describe(problems)}`);
});

test("every registered history comment still exists exactly once as a comment line", () => {
  assert.deepEqual(historyRegistryProblems(repositoryFiles()), []);
});

test("CONTROL: an old-org reference in an active file fails", () => {
  const installerDefault = `REPO="\${CSWARM_REPO:-${OLD_ORG}/commonswarm}"`;
  const shapes: Array<[string, string]> = [
    ["install.sh", installerDefault],
    ["npm/package.template.json", `    "url": "git+https://github.com/${OLD_ORG}/commonswarm.git"`],
    ["dist-npm/README.md", `- Source: https://github.com/${OLD_ORG}/commonswarm`],
    ["site/src/components/Fake.astro", `const REPO = "https://github.com/${OLD_ORG}/commonswarm";`],
    ["site/scripts/fake.test.mjs", `assert.match(html, /github\\.com\\/${OLD_ORG}\\/commonswarm/);`],
    [".github/workflows/fake.yml", `        run: gh repo clone ${OLD_ORG}/commonswarm`],
  ];
  for (const [path, text] of shapes) {
    const problems = oldOrgProblems(path, `first line\n${text}\nlast line`);
    assert.equal(problems.length, 1, `${path}: expected one problem for ${text}`);
    assert.equal(problems[0]?.line, 2);
  }
});

test("CONTROL: a comment passes only when it is a registered history comment", () => {
  const registered = HISTORY_COMMENTS[0];
  assert.ok(registered);
  const historyLine = `# ${registered.substring}, so`;

  // Negative: the registered comment, in its own file, passes.
  assert.deepEqual(oldOrgProblems(registered.path, historyLine), []);

  // Positive: an ordinary comment is not exempt just because it is a comment.
  assert.equal(oldOrgProblems("scripts/fake.sh", `# see ${OLD_ORG}/foo`).length, 1);
  // Positive: the registered text in another file is not exempt.
  assert.equal(oldOrgProblems("scripts/fake.sh", historyLine).length, 1);
  // Positive: the registered text moved into code is not exempt.
  assert.equal(oldOrgProblems(registered.path, `echo "${registered.substring}"`).length, 1);
  // Positive: a registered comment does not cover a second, different reference on another line.
  assert.equal(oldOrgProblems(registered.path, `${historyLine}\n# also ${OLD_ORG}/other`).length, 1);
});

test("CONTROL: historical, out-of-scope and new-org text passes", () => {
  const text = `see https://github.com/${OLD_ORG}/commonswarm`;
  assert.equal(scopeOf("docs/evidence/2026-09-06-x/REVIEW.md"), "historical");
  assert.equal(scopeOf("docs/org/2026-08-10-COMMONSWARM-MIGRATION.md"), "historical");
  assert.equal(scopeOf("site/CHANGELOG.md"), "historical");
  assert.equal(scopeOf("CHANGELOG"), "historical");
  // A component named like a changelog is code, not a record.
  assert.equal(scopeOf("site/src/components/app/ChangeLog.astro"), "active");
  assert.equal(scopeOf("docs/design/WEB-ONBOARDING.md"), "out-of-scope");
  assert.equal(scopeOf("TODO.md"), "out-of-scope");
  assert.equal(scopeOf("site/src/components/SiteFooter.astro"), "active");

  for (const path of [
    "docs/evidence/2026-09-06-x/REVIEW.md",
    "docs/org/2026-08-10-COMMONSWARM-MIGRATION.md",
    "site/CHANGELOG.md",
    "docs/design/WEB-ONBOARDING.md",
    "TODO.md",
  ]) {
    assert.deepEqual(oldOrgProblems(path, text), [], `${path} should not be flagged`);
  }

  // The same shape in an active path is flagged, so the passes above come from the path and not from a blind check.
  assert.equal(oldOrgProblems("site/src/components/Fake.astro", text).length, 1);

  assert.deepEqual(oldOrgProblems("install.sh", `REPO="\${CSWARM_REPO:-${NEW_ORG}/commonswarm}"`), []);
  // Case-sensitive on purpose: a lowercase workspace slug is not the GitHub organization.
  assert.deepEqual(oldOrgProblems("site/src/components/Fake.astro", "/app/workspaces/ridge-io/channels/general"), []);
});
