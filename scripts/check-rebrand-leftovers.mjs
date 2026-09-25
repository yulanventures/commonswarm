#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OLD_ORGANIZATION = new RegExp("Ridge" + "(?:-io|\\.io)", "g");
const BUILDER_PATH = /\/Users\/|\/private\/tmp\/[^\s"']*\/node_modules\/|\/home\/[^/\s]+\/[^\s"']*\/node_modules\/|(?:\.\.\/){2,}[^\s"']*\/node_modules\//;
const REPO_URL = "https://github.com/yulanventures/commonswarm";
const REPO_GIT_URL = `${REPO_URL}.git`;

// Historical evidence and dated drift records remain readable. Every other tracked
// path is checked, including newly added scripts and workflows.
const HISTORICAL_PREFIXES = [
  "docs/evidence/", "docs/org/", "docs/design/", "uxtest/findings/",
];
const HISTORICAL_FILES = new Set([
  "AGENTS.md", "SUCCESSION-PLAN.md", "TODO.md",
  "docs/development/agent-trailers.md",
  "docs/launch/2026-07-25-launchable-audit.md",
  "docs/research/2026-09-01-streaming-into-the-web-ui.md",
  "scripts/agent-trailers.sh", "site/astro.config.mjs",
  "site/src/components/SiteFooter.astro",
  "site/src/components/download/OtherWays.astro",
  "site/src/components/app/fixtures/markdown-qa/05-long-tokens.md",
  "uxtest/HARNESS.md", "uxtest/personas/human1-inviter.md",
  "uxtest/personas/human2-invitee.md", "uxtest/scripts/_lib.sh",
]);

function isHistorical(path) {
  return HISTORICAL_FILES.has(path) || HISTORICAL_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function walk(path) {
  return readdirSync(join(ROOT, path), { withFileTypes: true }).flatMap((entry) => {
    const child = `${path}/${entry.name}`;
    return entry.isDirectory() ? walk(child) : entry.isFile() ? [child] : [];
  });
}

export function collectInputs() {
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, timeout: 20_000 })
    .toString("utf8").split("\0").filter(Boolean);
  if (!existsSync(join(ROOT, "site/dist")) || !existsSync(join(ROOT, "dist-release/cswarm"))) {
    throw new Error("build the site and release bundle before checking rebrand leftovers");
  }
  const rendered = walk("site/dist");
  const bundle = ["dist-release/cswarm", "dist-npm/cswarm.cjs"];
  const paths = [...new Set([...tracked, ...rendered, ...bundle, "site/src/lib/repository.ts"])];
  const contents = new Map(paths.map((path) => [path, readFileSync(join(ROOT, path), "utf8")]));
  return { tracked, rendered, bundle, contents };
}

export function auditRebrand({ tracked, rendered, bundle, contents }) {
  const issues = [];
  const requireText = (path, needle) => {
    if (!contents.get(path)?.includes(needle)) issues.push(`${path}: missing ${needle}`);
  };
  if (tracked.length < 1000 || rendered.length < 10 || bundle.length !== 2) {
    issues.push(`inventory incomplete: ${tracked.length} tracked, ${rendered.length} rendered, ${bundle.length} bundles`);
  }
  for (const path of tracked) {
    const content = contents.get(path);
    if (content === undefined) { issues.push(`${path}: unreadable`); continue; }
    if (!isHistorical(path) && OLD_ORGANIZATION.test(content)) issues.push(`${path}: retired organization`);
    OLD_ORGANIZATION.lastIndex = 0;
  }
  for (const path of rendered) {
    const content = contents.get(path);
    if (content === undefined) { issues.push(`${path}: unreadable`); continue; }
    if (OLD_ORGANIZATION.test(content)) issues.push(`${path}: retired organization in site build`);
    OLD_ORGANIZATION.lastIndex = 0;
  }
  for (const path of bundle) {
    const content = contents.get(path);
    if (content === undefined) { issues.push(`${path}: unreadable`); continue; }
    if (OLD_ORGANIZATION.test(content)) issues.push(`${path}: retired organization in bundle`);
    OLD_ORGANIZATION.lastIndex = 0;
    if (BUILDER_PATH.test(content)) issues.push(`${path}: builder path in bundle`);
  }

  requireText("install.sh", 'REPO="${CSWARM_REPO:-yulanventures/commonswarm}"');
  requireText("npm/package.template.json", `"url": "git+${REPO_GIT_URL}"`);
  requireText("dist-npm/package.json", `"url": "git+${REPO_GIT_URL}"`);
  for (const path of ["npm/README.md", "dist-npm/README.md"]) requireText(path, `- Source: ${REPO_URL}`);
  requireText("site/src/lib/repository.ts", `export const SOURCE_REPOSITORY_URL = "${REPO_URL}"`);
  requireText("site/src/components/SiteFooter.astro", "const REPO = SOURCE_REPOSITORY_URL;");
  requireText("site/src/components/download/OtherWays.astro", "const SOURCE_REPO = `${SOURCE_REPOSITORY_URL}.git`;");
  requireText("site/src/components/seo/AboutCommonSwarm.astro", "href={SOURCE_REPOSITORY_URL}");
  requireText("README.md", "`CommonSwarm`, or to any data held in the hosted database.");
  requireText("site/README.md", "# CommonSwarm — website");
  requireText("site/README.md", "`cswarm working-on`");
  requireText("site/README.md", "`cswarm working-on …`");
  for (const path of ["site/dist/index.html", "site/dist/download/index.html", "site/dist/orchestration/index.html"]) {
    requireText(path, REPO_URL);
  }
  requireText("site/dist/download/index.html", `git clone ${REPO_GIT_URL}`);
  requireText("scripts/build-release.sh", "--minify --legal-comments=none");
  return { issues, counts: { tracked: tracked.length, rendered: rendered.length, bundle: bundle.length } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = auditRebrand(collectInputs());
  for (const issue of result.issues) console.error(issue);
  console.log(`checked ${result.counts.tracked} tracked files, ${result.counts.rendered} built site files, ${result.counts.bundle} bundles; issues=${result.issues.length}`);
  process.exitCode = result.issues.length ? 1 : 0;
}
