import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { withDatabaseTls } from "../../supabase/functions/_shared/database-options.js";

test("database options are the same object when no private CA is configured", () => {
  const options = { max: 2, prepare: false, idle_timeout: 3, connect_timeout: 10 };
  assert.equal(withDatabaseTls(options, undefined), options);
  assert.equal(withDatabaseTls(options, ""), options);
});

test("database options decode and verify a configured private CA", () => {
  const pem = "-----BEGIN CERTIFICATE-----\ntest-only\n-----END CERTIFICATE-----\n";
  assert.deepEqual(withDatabaseTls({ max: 1 }, btoa(pem)), {
    max: 1,
    ssl: { ca: pem, rejectUnauthorized: true },
  });
  assert.throws(() => withDatabaseTls({}, "%%%"), /valid base64/);
  assert.throws(() => withDatabaseTls({}, btoa("not a certificate")), /PEM certificate/);
});

test("all four database functions use the shared TLS helper", async () => {
  for (const name of ["command", "read", "capability", "activity"]) {
    const source = await readFile(
      join(process.cwd(), "supabase", "functions", name, "index.ts"),
      "utf8",
    );
    assert.match(source, /import \{ withDatabaseTls \} from "\.\.\/_shared\/database-options\.ts"/);
    assert.match(
      source,
      /postgres\(databaseUrl, withDatabaseTls\(\{[\s\S]*?\}, Deno\.env\.get\("SWARM_DATABASE_TLS_CA_B64"\)\)\)/,
    );
  }
});
