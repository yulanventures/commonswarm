import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const flagFile = "site/src/lib/h0-link-join-flag.ts";
const flagName = "PUBLIC_H0_LINK_JOIN";

// Every tracked mention counts, except top-level tests/docs, Markdown and test basenames.
function flagReaders(root: string): string[] {
  const readers: string[] = [];
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  for (const file of files) {
    const name = basename(file);
    if (file.startsWith("tests/") || file.startsWith("docs/") || name.endsWith(".md") || /\.test\./.test(name)) continue;
    if (readFileSync(join(root, file), "utf8").includes(flagName)) readers.push(file);
  }
  return readers.sort();
}

function assertSingleFlagReader(root: string): void {
  assert.deepEqual(flagReaders(root), [flagFile]);
}

test("PUBLIC_H0_LINK_JOIN occurs in exactly one non-exempt tracked file", () => {
  assertSingleFlagReader(repoRoot);
});

test("the flag guard applies only the allowed exemptions across the entire tracked tree", () => {
  const root = mkdtempSync("/private/tmp/commonswarm-flag-guard-");
  try {
    execFileSync("git", ["init", "--quiet", root]);
    for (const directory of ["site/src", "src", "supabase/functions", "deploy"]) mkdirSync(join(root, directory), { recursive: true });
    const track = (file: string, code: string): void => {
      const path = join(root, file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, code);
      execFileSync("git", ["add", "--", file], { cwd: root });
    };
    track(flagFile, readFileSync(join(repoRoot, flagFile), "utf8"));
    for (const file of [
      "tests/env-list.ts",
      "docs/env-list.ts",
      "deploy/README.md",
      "site/src/lib/fixture.test.ts",
      "site/src/lib/fixture.observer.test.ts",
    ]) track(file, 'const environment = ["PUBLIC_H0_LINK_JOIN=1"];\n');
    assertSingleFlagReader(root);

    for (const [file, code] of [
      ["src/second.ts", 'export const enabled = process.env.PUBLIC_H0_LINK_JOIN === "1";'],
      ["src/second.ts", 'const k = "PUBLIC_H0_LINK_JOIN"; export const enabled = import.meta.env[k] === "1";'],
      ["src/second.ts", 'const env = import.meta.env; export const enabled = env.PUBLIC_H0_LINK_JOIN === "1";'],
      ["site/src/second.astro", '---\nconst enabled = import.meta.env["PUBLIC_H0_LINK_JOIN"];\n---\n'],
      ["site/src/second.astro", '<script>const { PUBLIC_H0_LINK_JOIN: enabled } = import.meta.env;</script>'],
      ["supabase/functions/second.ts", 'const enabled = Deno.env.get("PUBLIC_H0_LINK_JOIN");'],
      ["src/env-list.ts", 'const environment = ["PUBLIC_H0_LINK_JOIN=1"];'],
      ["src/comment.ts", '// PUBLIC_H0_LINK_JOIN'],
      ["deploy/build.sh", 'export PUBLIC_H0_LINK_JOIN=1'],
      ["deploy/compose.yaml", 'environment:\n  - PUBLIC_H0_LINK_JOIN=1\n'],
      ["scripts/x.sh", 'export PUBLIC_H0_LINK_JOIN=1'],
      ["site/scripts/x.ts", 'const enabled = import.meta.env.PUBLIC_H0_LINK_JOIN;'],
      ["services/x/src/y.js", 'const enabled = process.env.PUBLIC_H0_LINK_JOIN;'],
      ["site/src/a/tests/z.ts", 'const enabled = import.meta.env.PUBLIC_H0_LINK_JOIN;'],
      ["site/src/a/__tests__/z.ts", '// PUBLIC_H0_LINK_JOIN'],
      ["site/src/a/docs/z.ts", '// PUBLIC_H0_LINK_JOIN'],
      ["site/src/a.test.directory/z.ts", '// PUBLIC_H0_LINK_JOIN'],
      ["src/tests/env-list.ts", 'const environment = ["PUBLIC_H0_LINK_JOIN=1"];'],
      ["deploy/docs/env-list.ts", 'const environment = ["PUBLIC_H0_LINK_JOIN=1"];'],
      ["site/astro.config.mjs", '// PUBLIC_H0_LINK_JOIN'],
    ]) {
      track(file!, code!);
      assert.throws(() => assertSingleFlagReader(root), { code: "ERR_ASSERTION" }, `${file}: ${code}`);
      assert.deepEqual(flagReaders(root), [flagFile, file!].sort(), file);
      writeFileSync(join(root, file!), "");
    }
    writeFileSync(join(root, flagFile), readFileSync(join(repoRoot, flagFile), "utf8") + '\nconst duplicate = import.meta.env.PUBLIC_H0_LINK_JOIN;\n');
    assertSingleFlagReader(root);
  } finally {
    execFileSync("rm", ["-rf", "--", root]);
  }
});
