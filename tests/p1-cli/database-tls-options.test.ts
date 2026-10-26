import assert from "node:assert/strict";
import test from "node:test";
import { withDatabaseTls } from "../../supabase/functions/_shared/database-options.js";

test("database options decode and verify a configured private CA", () => {
  const pem = "-----BEGIN CERTIFICATE-----\ntest-only\n-----END CERTIFICATE-----\n";
  assert.deepEqual(withDatabaseTls({ max: 1 }, btoa(pem)), {
    max: 1,
    ssl: { ca: pem, rejectUnauthorized: true },
  });
  assert.throws(() => withDatabaseTls({}, "%%%"), /valid base64/);
  assert.throws(() => withDatabaseTls({}, btoa("not a certificate")), /PEM certificate/);
});
