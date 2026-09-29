import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const PLAN = "docs/evidence/2026-09-28-box-hm37/BOX-WINDOW.md";
const SITE = "docs/evidence/2026-09-28-site-hm8/SITE-RELEASE.md";
const RUNBOOK = "deploy/RELEASE-TO-BOX.md";
const SHELL_BLOCK = /^```sh[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm;

function blocks(markdown: string): string[] {
  return [...markdown.matchAll(SHELL_BLOCK)].map((match) => match[1] ?? "");
}

function publicUaProblems(source: string): string[] {
  return blocks(source)
    .filter((block) => /urllib\.request|urlopen\(|fetch\(/u.test(block))
    .filter((block) => /(?:api|edge-staging)\.commonswarm\.com|https:\/\/commonswarm\.com/u.test(block))
    .filter((block) => !block.includes("commonswarm-release-probe/1.0"))
    .map(() => "public request block lacks the release-probe User-Agent");
}

function psqlFileProblems(source: string): string[] {
  const helperBody = source.match(/release_psql\(\) \{[\s\S]*?\n\}/u)?.[0] ?? "";
  const helperRoBody = source.match(/release_psql_ro\(\) \{[\s\S]*?\n\}/u)?.[0] ?? "";
  const withoutHelpers = source.replace(helperBody, "").replace(helperRoBody, "");
  return [...withoutHelpers.matchAll(/\brelease_psql(?:_ro)?\b[^\n]*--file\s+(\S+)/gu)]
    .filter((match) => /(?:^|["'])(?:\/run\/|\/proof\/)/u.test(match[1] ?? ""))
    .map((match) => `caller supplies container path ${match[1]}`);
}

function directoryProblems(source: string): string[] {
  const problems: string[] = [];
  for (const block of blocks(source)) {
    for (const name of ["PROOF_DIR", "EVIDENCE_DIR"]) {
      if (!new RegExp(`\\$\\{?${name}\\}?`).test(block)) continue;
      const assigns = new RegExp(`^\\s*${name}=`, "m").test(block);
      const sources = /^\s*(?:\.|source)\s+[^\n]+(?:window\.env|session\.sh)/mu.test(block);
      if (!assigns && !sources) problems.push(`${name} is read without assignment or a window/session source`);
    }
  }
  return problems;
}

function ripgrepProblems(source: string): string[] {
  return blocks(source)
    .filter((block) => /(?:^|[|;&]\s*)rg(?:[ \t]|$)/mu.test(block))
    .map(() => "runnable block calls rg");
}

test("box plans encode public UA, psql path, and standalone-variable reality", () => {
  const plan = readFileSync(PLAN, "utf8");
  const site = readFileSync(SITE, "utf8");
  const runbook = readFileSync(RUNBOOK, "utf8");
  assert.deepEqual(publicUaProblems(plan), []);
  assert.deepEqual(publicUaProblems(site), []);
  assert.deepEqual(publicUaProblems(runbook), []);
  assert.deepEqual(psqlFileProblems(plan), []);
  assert.deepEqual(psqlFileProblems(runbook), []);
  assert.deepEqual(directoryProblems(plan), []);
  assert.deepEqual(directoryProblems(runbook), []);
  assert.deepEqual(ripgrepProblems(plan), []);
  assert.deepEqual(ripgrepProblems(site), []);
  assert.deepEqual(ripgrepProblems(runbook), []);
  assert.deepEqual(ripgrepProblems(readFileSync("docs/design/BOX-PLAN-TEMPLATE.md", "utf8")), []);
  assert.match(runbook, /CONTAINER_FILE=\/run\/commonswarm-release-apply\.sql/u);
  assert.match(runbook, /CONTAINER_FILE="\/proof\/\$PROOF_RELATIVE"/u);
  assert.match(runbook, /--file must name APPLY_SQL or a PROOF_DIR file/u);
  assert.match(plan, /cloudflare_challenge/u);
  assert.match(plan, /"server".*"cf-ray"/u);
});

test("reality checks have failing controls", () => {
  const noUa = "```sh\n# step: bad\n# readonly: yes\npython3 - <<'PY'\nimport urllib.request\nurllib.request.urlopen('https://api.commonswarm.com/x')\nPY\n```";
  assert.notDeepEqual(publicUaProblems(noUa), []);
  assert.notDeepEqual(psqlFileProblems("release_psql --file /run/host.sql"), []);
  assert.deepEqual(psqlFileProblems('release_psql --file "$APPLY_SQL"'), []);
  const unset = "```sh\n# step: bad-dir\n# readonly: yes\nprintf x >\"$PROOF_DIR/x\"\n```";
  assert.notDeepEqual(directoryProblems(unset), []);
  const ripgrep = "```sh\n# step: bad-rg\n# readonly: yes\nprintf x | rg -n x\n```";
  assert.notDeepEqual(ripgrepProblems(ripgrep), []);
});
