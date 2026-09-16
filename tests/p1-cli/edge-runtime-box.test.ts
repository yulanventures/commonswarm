import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  FUNCTION_NAMES,
  resolveFunctionRoute,
} from "../../deploy/edge-runtime/main/router.js";

const repoRoot = process.cwd();

async function filesBelow(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  }));
  return nested.flat();
}

test("edge runtime env example lists every function environment name", async () => {
  const sourceFiles = (await filesBelow(resolve(repoRoot, "supabase/functions")))
    .filter((path) => path.endsWith(".ts"));
  const used = new Set<string>();
  const envPattern = /Deno\.env\.get\(\s*["']([A-Z0-9_]+)["']\s*\)/g;
  for (const file of sourceFiles) {
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(envPattern)) used.add(match[1]!);
  }

  const example = await readFile(
    resolve(repoRoot, "deploy/edge-runtime/env.example"),
    "utf8",
  );
  const listed = new Set(
    [...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]!),
  );
  assert.deepEqual([...listed].sort(), [...used].sort());
});

test("edge runtime router strips only /functions/v1 and maps all five functions", () => {
  assert.deepEqual(FUNCTION_NAMES, [
    "command",
    "read",
    "capability",
    "activity",
    "h0",
  ]);
  for (const functionName of FUNCTION_NAMES) {
    assert.deepEqual(resolveFunctionRoute(`/functions/v1/${functionName}`), {
      functionName,
      pathname: `/${functionName}`,
    });
    assert.deepEqual(resolveFunctionRoute(`/functions/v1/${functionName}/deep/path`), {
      functionName,
      pathname: `/${functionName}/deep/path`,
    });
  }
  assert.equal(resolveFunctionRoute("/functions/v1/unknown"), null);
  assert.equal(resolveFunctionRoute("/functions/v1/command-extra"), null);
  assert.equal(resolveFunctionRoute("/command"), null);
  assert.equal(resolveFunctionRoute("/functions/v1"), null);
});

test("edge runtime Compose binds only loopback and contains no secret value", async () => {
  const compose = await readFile(
    resolve(repoRoot, "deploy/edge-runtime/compose.yaml"),
    "utf8",
  );
  const published = [...compose.matchAll(/^\s*-\s*["']([^"']*:\d+)["']\s*$/gm)]
    .map((match) => match[1]!)
    .filter((value) => /:\d+:\d+$/.test(value));
  assert.deepEqual(published, ["127.0.0.1:9000:9000"]);
  assert.doesNotMatch(compose, /(?:0\.0\.0\.0|\[::\]):9000:9000/);
  assert.match(
    compose,
    /env_file:[\s\S]*?path: \/home\/commonswarm\/\.env/,
  );

  const secretShapes = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/,
    /\b(?:sbp_|sb_secret_|swm_agt_)[A-Za-z0-9_-]{12,}/,
    /postgres(?:ql)?:\/\/[^\s:@]+:[^\s@]+@/,
    /^\s*(?:password|secret|token|api[_-]?key)\s*:\s*\S+/im,
  ];
  for (const shape of secretShapes) assert.doesNotMatch(compose, shape);
});
