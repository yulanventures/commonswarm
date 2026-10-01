import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const flagFile = "site/src/lib/h0-link-join-flag.ts";
const flagName = "PUBLIC_H0_LINK_JOIN";

// Every mention counts, including comments and indirect reads; only one source file owns the flag.
function flagReaders(root: string): string[] {
  const readers: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!["node_modules", "dist", ".git", "tests", "__tests__", "docs"].includes(entry.name)) walk(path);
      } else if (!entry.name.endsWith(".md") && !/\.test\./.test(entry.name)) {
        if (readFileSync(path, "utf8").includes(flagName)) readers.push(relative(root, path));
      }
    }
  };
  for (const directory of ["site/src", "src", "supabase/functions", "deploy"]) walk(join(root, directory));
  return readers.sort();
}

function assertSingleFlagReader(root: string): void {
  assert.deepEqual(flagReaders(root), [flagFile]);
}

test("PUBLIC_H0_LINK_JOIN occurs in exactly one source file", () => {
  assertSingleFlagReader(repoRoot);
});

test("the flag guard ignores env-list fixtures and rejects a second source reader", () => {
  const root = mkdtempSync("/private/tmp/commonswarm-flag-guard-");
  try {
    for (const directory of ["site/src/lib", "src/tests", "supabase/functions", "deploy/docs", "tests"]) mkdirSync(join(root, directory), { recursive: true });
    writeFileSync(join(root, flagFile), readFileSync(join(repoRoot, flagFile), "utf8"));
    writeFileSync(join(root, "tests/box-dry-run.test.ts"), 'const environment = ["PUBLIC_H0_LINK_JOIN=1"];\n');
    writeFileSync(join(root, "site/src/lib/fixture.test.ts"), 'const fixture = import.meta.env.PUBLIC_H0_LINK_JOIN;\n');
    writeFileSync(join(root, "src/tests/env-list.ts"), 'const environment = ["PUBLIC_H0_LINK_JOIN=1"];\n');
    writeFileSync(join(root, "deploy/README.md"), 'PUBLIC_H0_LINK_JOIN\n');
    writeFileSync(join(root, "deploy/docs/env-list.ts"), 'const environment = ["PUBLIC_H0_LINK_JOIN=1"];\n');
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
    ]) {
      const path = join(root, file!);
      writeFileSync(path, code!);
      assert.throws(() => assertSingleFlagReader(root), { code: "ERR_ASSERTION" }, `${file}: ${code}`);
      assert.deepEqual(flagReaders(root), [flagFile, file!].sort(), file);
      rmSync(path);
    }
    writeFileSync(join(root, flagFile), readFileSync(join(repoRoot, flagFile), "utf8") + '\nconst duplicate = import.meta.env.PUBLIC_H0_LINK_JOIN;\n');
    assertSingleFlagReader(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
