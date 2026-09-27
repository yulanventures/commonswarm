import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readFunctionUrl = new URL(
  "../supabase/functions/read/index.ts",
  import.meta.url,
);

test("read exports its handler and serves only when run as main", async () => {
  const source = await readFile(readFunctionUrl, "utf8");

  assert.match(
    source,
    /export async function handleRequest\(request: Request\): Promise<Response> \{/,
  );

  const serveCalls = source.match(/Deno\.serve\s*\(/g) ?? [];
  assert.equal(serveCalls.length, 1, "read must contain exactly one Deno.serve call");
  assert.match(
    source,
    /^if \(import\.meta\.main\) Deno\.serve\(handleRequest\);$/m,
  );
});
