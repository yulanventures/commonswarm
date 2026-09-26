import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const helper = fileURLToPath(new URL(
  "../../deploy/release-proofs/item-g2b/g2b-renew-gate.mjs",
  import.meta.url,
));
const wrapper = fileURLToPath(new URL(
  "../../deploy/release-proofs/item-g2b/g2b-renew-gate.sh",
  import.meta.url,
));

test("G2b renew gate statistics keep the first and every call", () => {
  const output = execFileSync(process.execPath, [helper, "--self-test"], { encoding: "utf8" });
  assert.equal(output, "SELF TEST PASS\n");
});

test("G2b renew gate refuses bad inputs before transport", () => {
  const seed = mkdtempSync(join(tmpdir(), "cswarm-g2b-invalid-"));
  try {
    chmodSync(seed, 0o700);
    writeFileSync(join(seed, "credential.json"), "{}", { mode: 0o600 });
    writeFileSync(join(seed, "principal.json"), JSON.stringify({
      principal_id: "11111111-1111-4111-8111-111111111111",
    }), { mode: 0o600 });
    writeFileSync(join(seed, "anon-key.txt"), "not-a-secret-test-key\n", { mode: 0o600 });
    const run = spawnSync("bash", [
      wrapper, process.cwd(), seed, "http://127.0.0.1:1", "22222222-2222-4222-8222-222222222222",
    ], { encoding: "utf8", timeout: 2_000 });
    assert.equal(run.status, 2);
    assert.match(run.stdout, /^input: credential\.json/);
    assert.doesNotMatch(`${run.stdout}${run.stderr}`, /ECONNREFUSED|fetch failed/);
  } finally {
    rmSync(seed, { recursive: true, force: true });
  }
});
