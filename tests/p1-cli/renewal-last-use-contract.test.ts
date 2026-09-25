/** Source and release-proof checks for the grant-use migration. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const migration = readFileSync(new URL("../../supabase/migrations/20260925000002_renewal_last_use_monotonic.sql", import.meta.url), "utf8");
const catalog = readFileSync(new URL("../../deploy/release-proofs/renewal-last-use/catalog.sql", import.meta.url), "utf8");
const serverTest = readFileSync(new URL("../p1-server/renewal-last-use.test.ts", import.meta.url), "utf8");

function bodies(source: string): string[] {
  return [...source.matchAll(/AS \$\$(.*?)\$\$;/gs)].map((match) => match[1]!);
}

function digest(body: string): string {
  return createHash("md5").update(body).digest("hex");
}

test("both use writers skip stale rows and catalog proof pins their bodies and authority", { timeout: 5_000 }, () => {
  const [recorder, fence] = bodies(migration);
  assert.ok(recorder && fence);
  assert.equal(bodies(migration).length, 2);
  assert.match(recorder, /AND \(grant_row\.last_used_at IS NULL\s+OR grant_row\.last_used_at <= statement_timestamp\(\)\)/);
  assert.match(fence, /AND \(last_used_at IS NULL OR last_used_at <= statement_timestamp\(\)\)/);
  assert.match(fence, /SET successors_used = successors_used \+ 1\s+WHERE renewal_grant_id = grant_row\.renewal_grant_id;/);
  assert.ok(catalog.includes(`md5(p.prosrc) = '${digest(recorder)}'`));
  assert.ok(catalog.includes(`md5(p.prosrc) = '${digest(fence)}'`));
  assert.match(catalog, /AND p\.prosecdef/);
  assert.match(catalog, /AND NOT p\.prosecdef/);
  assert.match(catalog, /p\.proconfig = ARRAY\['search_path=swarm, pg_catalog'\]/);
  assert.match(catalog, /p\.proconfig = ARRAY\['search_path=pg_catalog'\]/);
  assert.equal((catalog.match(/pg_get_userbyid\(p\.proowner\) = 'swarm_admin'/g) ?? []).length, 2);
  assert.equal((catalog.match(/aclexplode\(p\.proacl\)/g) ?? []).length, 2);
  // Negative control: the preceding GREATEST-only version cannot satisfy the proof.
  const reverted = recorder.replace(
    "last_used_at = statement_timestamp()",
    "last_used_at = GREATEST(grant_row.last_used_at, statement_timestamp())",
  );
  assert.notEqual(digest(reverted), digest(recorder));
  assert.ok(!catalog.includes(`md5(p.prosrc) = '${digest(reverted)}'`));
});

test("SQL and served races are independent and served startup has the 60-second window", { timeout: 5_000 }, () => {
  assert.match(serverTest, /test\("older SQL use with another device and source leaves the newer use intact"/);
  assert.match(serverTest, /test\("served member read survives an older blocked use"/);
  assert.match(serverTest, /test\("older successor use preserves newer fields while still spending capacity"/);
  assert.match(serverTest, /const deadline = Date\.now\(\) \+ 60_000/);
  assert.match(serverTest, /l\.relation = 'swarm\.renewal_grants'::regclass/);
  assert.match(serverTest, /pg_blocking_pids\(a\.pid\)/);
});
